import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_BYTES, MAX_FILES } from './public/protocol.js';

const publicDir = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/protocol.js', ['protocol.js', 'text/javascript; charset=utf-8']],
  ['/transfer.js', ['transfer.js', 'text/javascript; charset=utf-8']],
  ['/file-tasks.js', ['file-tasks.js', 'text/javascript; charset=utf-8']],
  ['/handoff.js', ['handoff.js', 'text/javascript; charset=utf-8']],
  ['/file-worker.js', ['file-worker.js', 'text/javascript; charset=utf-8']],
  ['/hashes-LICENSE.txt', ['hashes-LICENSE.txt', 'text/plain; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml; charset=utf-8']],
  ['/favicon.png', ['favicon.png', 'image/png']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
  ['/og.png', ['og.png', 'image/png']],
  ...['online', 'busy', 'offline'].map(state => [`/og-${state}.png`, [`og-${state}.png`, 'image/png']]),
  ['/receive.mjs', ['receive.mjs', 'text/javascript; charset=utf-8']],
]);
export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
// Caches keep headers with the bytes, so the headers are part of every version too.
const responseHeaders = JSON.stringify([securityHeaders, [...assets]]);

// Every reference to a local asset gets ?v=<content hash>. A file's hash covers its rewritten
// references, so changing a module also gives new URLs to everything that imports it. Content
// hashes cannot express a reference cycle, so a cycle fails when the server starts.
export function fingerprint(sources, headers = responseHeaders) {
  const built = new Map();
  const versioned = path => `${path}?v=${build(path).version}`;
  const references = {
    html: [/((?:href|src|content)=")((?:https:\/\/meatproxy\.to)?)(\/[\w.-]+)(?:\?v=\w+)?"/g, (match, attribute, host, path) => sources.has(path) ? `${attribute}${host}${versioned(path)}"` : match],
    js: [/(['"])(\.?)(\/[\w.-]+\.js)\1/g, (match, quote, dot, path) => sources.has(path) ? quote + dot + versioned(path) + quote : match],
  };
  function build(path) {
    if (!built.has(path)) {
      const rewrite = references[path.split('.').pop()];
      const body = rewrite ? Buffer.from(sources.get(path).toString().replace(...rewrite)) : sources.get(path);
      built.set(path, { body, version: createHash('sha256').update(headers).update(body).digest('hex').slice(0, 12) });
    }
    return built.get(path);
  }
  for (const path of sources.keys()) build(path);
  return built;
}
// Loaded once: each release fingerprints its own files when the service starts.
const built = fingerprint(new Map(await Promise.all([...assets, ['/index.html', ['index.html']]].map(async ([path, [file]]) => [path, await readFile(new URL(file, publicDir))]))));
const versioned = path => `${path}?v=${built.get(path).version}`;
const tokenPattern = /^[A-Za-z0-9_-]{22}$/;
const roomLifetime = 12 * 60 * 60 * 1000;
// Above either limit, the relay stops reading from a sender until its receiver catches up.
// Each queued message costs heap however small it is, so messages are counted as well as bytes.
const relayBufferBytes = 512 * 1024, relayBufferMessages = 256;
// The page enforces the handoff limits; the relay enforces them too, so a modified client cannot use
// it as an open pipe. Daily counts reset at midnight UTC and when the service restarts.
const relayLimits = {
  toReceiver: MAX_BYTES + 64 * 1024 * 1024, // Per receiver connection: one handoff plus encryption and control.
  toSender: 8 * 1024 * 1024, // Per receiver connection: acknowledgements and control messages.
  signals: 1024 * 1024, // Per socket: connection setup.
  perAddressDaily: 4 * 1024 ** 3,
  daily: 50 * 1024 ** 3,
};
// IPv6 users typically control a whole /64, so it counts as one address.
function addressKey(address = '') {
  const v4 = address.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(':')}::/64`;
}
const escapeHTML = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function previewOf(room) {
  if (!room || room.owner.readyState !== WebSocket.OPEN || Date.now() - room.created >= roomLifetime) return { state: 'offline', count: 0, totalBytes: 0, names: [] };
  return { state: room.guest?.readyState === WebSocket.OPEN ? 'busy' : 'online', ...room.preview };
}

function renderPreview(html, preview, url) {
  const { state, count, totalBytes, names } = preview;
  const quantity = count === 1 ? 'a file' : count ? `${count} files` : 'files';
  const named = names.length ? `${names[0]}${count > 1 ? ` + ${count - 1} more` : ''}` : '';
  const title = state === 'offline' ? 'This file link has expired · Meatproxy' : named ? `A file handoff for you: ${named}` : `Someone wants to send you ${quantity}`;
  const availability = state === 'online' ? 'Sender online when previewed.' : 'Sender online, sharing with someone else when previewed.';
  const amount = count ? `${count} ${count === 1 ? 'file' : 'files'} · ${Math.ceil(totalBytes / 1024 ** 2)} MB. ` : '';
  const description = state === 'offline' ? 'The sender is offline or this link has expired. Ask them for a fresh link.' : `${availability} ${amount}Open to accept a peer-to-peer transfer. Both of you must stay online.`;
  const image = new URL(versioned(`/og-${state}.png`), url).href;
  const alt = state === 'offline' ? 'Meatproxy. This file link has expired. Ask the sender for a fresh link.' : `Meatproxy. Someone has files for you. Open the link. Accept the transfer. ${availability}`;
  const values = {
    description, 'og:url': url, 'og:title': title, 'og:description': description,
    'og:image': image, 'og:image:secure_url': image, 'og:image:alt': alt,
    'twitter:title': title, 'twitter:description': description, 'twitter:image': image, 'twitter:image:alt': alt,
  };
  return html.replace(/<title>.*?<\/title>/, () => `<title>${escapeHTML(title)}</title>`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, (_, start, end) => start + escapeHTML(url) + end)
    .replace(/(<meta (?:name|property)="([^"]+)" content=")[^"]*(")/g, (tag, start, name, end) => name in values ? start + escapeHTML(values[name]) + end : tag);
}

export function createApp({ origin = process.env.PUBLIC_ORIGIN, maxClients = 200, maxClientsPerAddress = 16, limits = {} } = {}) {
  const rooms = new Map();
  const limit = { ...relayLimits, ...limits };
  const connections = new Map(), usage = { day: -1, total: 0, byAddress: new Map() };
  // Returns the close code and reason when relaying these bytes would pass a limit.
  const refuseRelay = (ws, peer, bytes) => {
    const day = Math.floor(Date.now() / 86_400_000);
    if (usage.day !== day) Object.assign(usage, { day, total: 0, byAddress: new Map() });
    const [receiver, direction] = ws.owner ? [peer, 'toReceiver'] : [ws, 'toSender'];
    const used = usage.byAddress.get(ws.address) || 0;
    if (receiver[direction] + bytes > limit[direction]) return [1008, 'Relay limit reached for this handoff'];
    if (used + bytes > limit.perAddressDaily) return [1013, 'Your network reached its daily relay limit; try again tomorrow'];
    if (usage.total + bytes > limit.daily) return [1013, 'The relay reached its daily limit; try again tomorrow'];
    receiver[direction] += bytes; usage.byAddress.set(ws.address, used + bytes); usage.total += bytes;
  };
  // Socket origins are compared to this exact string, so accept only a bare http(s) origin.
  const publicOrigin = new URL(origin || 'https://meatproxy.to');
  if (!/^https?:$/.test(publicOrigin.protocol) || (origin && publicOrigin.origin !== origin)) throw new Error(`PUBLIC_ORIGIN must be an origin such as https://meatproxy.to, not ${origin}`);
  const server = http.createServer((req, res) => {
    for (const header of Object.entries(securityHeaders)) res.setHeader(...header);
    res.setHeader('Cache-Control', 'no-store');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; } // For example, GET //[
    const path = url.pathname;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (path === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"version":"0.1.0"}'); return; }
    // Fetching a preview never joins a handoff or receives encrypted file data.
    if (path === '/robots.txt') { res.setHeader('Content-Type', 'text/plain'); res.end('User-agent: *\nAllow: /\n'); return; }
    const handoff = path.match(/^\/s\/([A-Za-z0-9_-]{22})(\/status)?$/);
    if (handoff) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (handoff?.[2]) {
      res.setHeader('Content-Type', 'application/json');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(previewOf(rooms.get(handoff[1])))); return;
    }
    const asset = assets.get(path) || (path === '/' || /^\/s\/[A-Za-z0-9_-]{22}$/.test(path) ? ['index.html', 'text/html; charset=utf-8'] : null);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    let { body, version } = built.get(assets.has(path) ? path : '/index.html');
    res.setHeader('Content-Type', asset[1]);
    // A versioned URL names this exact response, so browsers and Cloudflare may keep it.
    if (assets.has(path) && url.searchParams.get('v') === version) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (handoff) body = renderPreview(body.toString(), previewOf(rooms.get(handoff[1])), new URL(path, publicOrigin).href);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const send = (socket, value) => {
    if (socket?.readyState === WebSocket.OPEN) {
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1008, 'Connection is too slow'); return; }
      socket.send(JSON.stringify(value));
    }
  };
  server.on('upgrade', (req, socket, head) => {
    const requestOrigin = req.headers.origin;
    const allowedOrigin = origin || `http://${req.headers.host}`;
    // Browsers supply Origin; the downloadable Node client has no ambient cookies and no Origin.
    if (req.url !== '/socket' || (requestOrigin && requestOrigin !== allowedOrigin) || wss.clients.size >= maxClients) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      // Nginx sets X-Real-IP to the client's address; without it, every client shares one address.
      ws.address = addressKey(req.headers['x-real-ip'] || req.socket.remoteAddress);
      wss.emit('connection', ws);
    });
  });
  wss.on('connection', ws => {
    const held = (connections.get(ws.address) || 0) + 1;
    connections.set(ws.address, held);
    ws.once('close', () => { const left = connections.get(ws.address) - 1; if (left) connections.set(ws.address, left); else connections.delete(ws.address); });
    ws.on('error', () => {}); // Errors are followed by close; close performs room cleanup.
    if (held > maxClientsPerAddress) { ws.close(1013, 'Too many connections from your network; close other Meatproxy tabs and try again'); return; }
    ws.alive = true; ws.held = false; ws.relayQueue = 0; ws.signalBytes = 0; ws.toReceiver = 0; ws.toSender = 0;
    ws.on('pong', () => { ws.alive = true; });
    const setupTimer = setTimeout(() => { if (!ws.room) ws.close(1008, 'Join a handoff first'); }, 10_000);
    ws.on('message', (data, binary) => {
      ws.alive = true; // A slow upload can hold the pong behind megabytes of file data.
      if (binary) {
        const peer = ws.owner ? ws.room?.guest : ws.room?.owner;
        // After a receiver leaves, the sender's queued data for it can still be arriving.
        // The sender's first message for the next receiver is a signal, which follows all of it.
        if (!peer || peer.readyState !== WebSocket.OPEN || (ws.owner && ws.room.previousSession)) return;
        const refusal = refuseRelay(ws, peer, data.length);
        if (refusal) { ws.close(...refusal); return; }
        // Pausing lets TCP slow the sender's browser. Write callbacks also fire, with an
        // error, when the receiver's socket is destroyed, so a departed receiver releases it.
        const backlogged = () => peer.bufferedAmount > relayBufferBytes || peer.relayQueue > relayBufferMessages;
        peer.relayQueue++;
        peer.send(data, { binary: true }, () => { peer.relayQueue--; if (ws.isPaused && !backlogged()) ws.resume(); });
        if (backlogged()) { ws.pause(); ws.held = true; }
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!msg || typeof msg !== 'object') { ws.close(1008, 'Invalid message'); return; }
      if (msg.type === 'create' && !ws.room) {
        const id = randomBytes(16).toString('base64url');
        const room = { id, owner: ws, guest: null, created: Date.now(), preview: { count: 0, totalBytes: 0, names: [] } };
        rooms.set(id, room); ws.room = room; ws.owner = true;
        clearTimeout(setupTimer); send(ws, { type: 'created', room: id });
      } else if (msg.type === 'join' && !ws.room && tokenPattern.test(msg.room)) {
        const room = rooms.get(msg.room);
        if (previewOf(room).state === 'offline') { send(ws, { type: 'unavailable' }); ws.close(1000); return; }
        if (room.guest) { send(ws, { type: 'busy' }); ws.close(1000); return; }
        room.guest = ws; ws.room = room; ws.owner = false;
        clearTimeout(setupTimer);
        send(room.owner, { type: 'peer-joined' }); send(ws, { type: 'joined' });
      } else if (msg.type === 'preview' && ws.owner && ws.room) {
        if (!Number.isInteger(msg.count) || msg.count < 0 || msg.count > MAX_FILES || !Number.isSafeInteger(msg.totalBytes) || msg.totalBytes < 0 || msg.totalBytes > MAX_BYTES || !Array.isArray(msg.names) || msg.names.length > Math.min(3, msg.count) || msg.names.some(name => typeof name !== 'string' || !name || name.length > 512)) {
          ws.close(1008, 'Invalid preview'); return;
        }
        ws.room.preview = { count: msg.count, totalBytes: msg.totalBytes, names: msg.names.map(name => name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180)) };
      } else if (msg.type === 'signal' && ws.room && typeof msg.payload === 'string' && msg.payload.length <= 60_000) {
        ws.signalBytes += msg.payload.length;
        if (ws.signalBytes > limit.signals) { ws.close(1008, 'Signal limit reached for this connection'); return; }
        const peer = ws.owner ? ws.room.guest : ws.room.owner;
        // Relies on the sender sending no signals after its first relay data in a session (app.js setupRTC).
        if (ws.owner) ws.room.previousSession = false;
        send(peer, { type: 'signal', payload: msg.payload });
      } else if (msg.type === 'reject' && ws.owner && ws.room?.guest) {
        ws.room.guest.close(1008, 'Invalid link key');
      } else { ws.close(1008, 'Invalid message'); }
    });
    ws.on('close', () => {
      clearTimeout(setupTimer);
      const room = ws.room;
      if (!room) return;
      if (ws.owner) {
        rooms.delete(room.id);
        send(room.guest, { type: 'sender-left' });
        room.guest?.close(1000, 'Sender left');
      } else if (room.guest === ws) {
        room.guest = null; room.previousSession = true; send(room.owner, { type: 'peer-left' });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // A sender held at any time since the last check may not have read its pong yet, so its
      // receiver's liveness decides. Two sockets holding each other are both checked.
      const peer = ws.owner ? ws.room?.guest : ws.room?.owner;
      const exempt = ws.held && !peer?.isPaused;
      ws.held = ws.isPaused;
      if (!ws.alive && !exempt) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (ws.room && Date.now() - ws.room.created >= roomLifetime) ws.close(1000, 'Handoff expired after 12 hours');
    }
  }, 25_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return { server, wss, rooms, close: async () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3477);
  app.server.listen(port, '127.0.0.1', () => console.log(`Meatproxy listening on 127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
}

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
  ['/note-formatting.js', ['note-formatting.js', 'text/javascript; charset=utf-8']],
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
// Framing, TLS and TCP cost about this much per message on the wire, which dominates tiny messages,
// so relayed messages and signals are counted at their size plus this.
export const messageOverhead = 64;
// The page enforces the handoff limits; the relay enforces them too, so a modified client cannot use
// it as an open pipe. Relayed bytes are charged to the receiving side's address and network.
// Daily counts reset at midnight UTC and when the service restarts.
const relayLimits = {
  toReceiver: MAX_BYTES + 64 * 1024 * 1024, // Per receiver connection: one handoff plus encryption and control.
  toSender: 8 * 1024 * 1024, // Per receiver connection: acknowledgements and control messages.
  slice: 64 * 1024 * 1024, // Reserved from the allowances at a time as a session relays.
  signals: 32 * 1024, // Per receiver connection and direction: setup takes about 5-15 KB.
  // Sent per day. Separate from the relay allowances, so a spent relay allowance never blocks direct
  // setup. These bound what rejoining from rotating addresses can carry, and a network's allowance is
  // 16 addresses' worth, so one neighbour cannot spend it.
  addressSignals: 16 * 1024 * 1024,
  networkSignals: 256 * 1024 * 1024,
  room: 2 * 1024 ** 3, // Per link, over its 12-hour life.
  // A full 512 MiB handoff counts about 515 MiB, and its start check needs nine 64 MiB slices free,
  // so an address can receive two a day.
  addressDaily: 1152 * 1024 * 1024,
  networkDaily: 4608 * 1024 * 1024,
  daily: 10 * 1024 ** 3,
};
// A network may hold four addresses' worth, so one neighbour cannot fill it, and filling the
// 200-socket cap takes seven networks.
const connectionLimits = { address: 8, network: 32 };
// Server work each address and network may cause through its sockets, in bytes per second, so one
// client cannot take the service's CPU; each may run two seconds ahead and owe two seconds' worth.
// Measured: about 2 µs per WebSocket frame plus 0.7 ns per byte, so a message, ping or pong costs its
// size plus 4 KiB. An address's budget relays file chunks at about 12 MiB/s, above the relay speeds
// seen in production, and a network may do four addresses' worth. Refusing a request costs about as
// much as serving it, so request and connection rates are left to the proxy (see README).
const workLimits = { address: 16 * 1024 * 1024, network: 64 * 1024 * 1024 };
const frameCost = 4 * 1024;
// Pages word these close codes for their reader; the reasons are for the command-line receiver.
const refusals = {
  handoff: [4001, 'Relay limit reached for this handoff'],
  signals: [4001, 'Connection setup limit reached'],
  link: [4002, 'This link has used its relay allowance; ask the sender for a fresh link'],
  network: [4003, 'This network has used its relay allowance for now; try again later'],
  relay: [4004, "The relay has reached today's limit; try again after 00:00 UTC"],
  connections: [4005, 'Too many connections from this network; close Meatproxy tabs you no longer need, or try again later'],
  setup: [4006, "This network has used today's connection setup allowance; try again after 00:00 UTC"],
};
// One customer typically holds an IPv4 address or an IPv6 /56 (ISPs commonly delegate 256 /64s to a
// household), and one provider network an IPv4 /24 or an IPv6 /48, so limits count those as one
// address and one network.
function addressKeys(address) {
  const v4 = address.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (v4) return { address: v4.slice(1).join('.'), network: `${v4.slice(1, 4).join('.')}.0/24` };
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(group => parseInt(group, 16).toString(16));
  return { address: `${groups.slice(0, 3).join(':')}:${(parseInt(groups[3], 16) & 0xff00).toString(16)}::/56`, network: `${groups.slice(0, 3).join(':')}::/48` };
}
const peerOf = ws => ws.owner ? ws.room?.guest : ws.room?.owner;
// Above either limit, the relay holds the socket sending to this peer.
const backlogged = peer => !!peer && (peer.bufferedAmount > relayBufferBytes || peer.relayQueue > relayBufferMessages);
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

export function createApp({ origin = process.env.PUBLIC_ORIGIN, maxClients = 200, maxConnections = connectionLimits, maxRefusing = 20, maxWork = workLimits, limits = {}, log = console.log } = {}) {
  const rooms = new Map();
  let refusing = 0;
  const limit = { ...relayLimits, ...limits };
  // The day's allowances, and totals without addresses for the daily summary.
  const fresh = day => ({ day, total: 0, byKey: new Map(), signals: new Map(), signalBytes: 0, rooms: 0, peakSockets: 0, throttled: 0, refused: 0, closedByLimit: {} });
  const connections = new Map(), usage = fresh(-1);
  const count = (map, key, change) => { const next = (map.get(key) || 0) + change; if (next > 0) map.set(key, next); else map.delete(key); };
  // relayedBytes includes the per-message overhead and slices still reserved by open sessions.
  const summary = () => ({ day: new Date(usage.day * 86_400_000).toISOString().slice(0, 10), relayedBytes: usage.total, signalBytes: usage.signalBytes, rooms: usage.rooms, peakSockets: usage.peakSockets, throttled: usage.throttled, refused: usage.refused, closedByLimit: usage.closedByLimit });
  const today = () => {
    const day = Math.floor(Date.now() / 86_400_000);
    if (usage.day !== day) {
      if (usage.day >= 0) log(JSON.stringify({ event: 'daily-usage', ...summary() }));
      Object.assign(usage, fresh(day));
    }
    return day;
  };
  // Totals are counted through this, so a count made just after midnight starts the new day.
  const tally = () => { today(); return usage; };
  // Work credit per address and network, refilled continuously up to two seconds' worth (none without a proxy).
  const credit = new Map();
  const credits = keys => !keys ? [] : [[keys.address, maxWork.address], [keys.network, maxWork.network]].map(([key, rate]) => {
    const now = performance.now(), entry = credit.get(key) || { level: 2 * rate, at: now, rate };
    entry.level = Math.min(2 * rate, entry.level + (now - entry.at) / 1000 * rate); entry.at = now;
    credit.set(key, entry); return entry;
  });
  // Charges work and returns the milliseconds until the address and its network are both back in credit.
  // Debt stops at two seconds' worth, so a burst from one address cannot hold its network's sockets for longer.
  const work = (keys, cost) => Math.max(0, ...credits(keys).map(entry => { entry.level = Math.max(-2 * entry.rate, entry.level - cost); return -entry.level / entry.rate * 1000; }));
  const spendFrame = (ws, bytes) => { const wait = work(ws.keys, bytes + frameCost); if (wait) throttle(ws, wait); };
  // A socket in debt is not read until it is back in credit, so TCP slows the client instead of the
  // service doing its work. Messages already read keep adding debt after the pause, so the wait is
  // checked again when it ends. The relay may also be holding the socket; reading resumes when neither applies.
  const throttle = (ws, wait) => {
    if (ws.throttled) return;
    if (!ws.slowed) { ws.slowed = true; tally().throttled++; } // Sockets, not pauses: a fast transfer pauses often.
    ws.throttled = true; ws.held = true; ws.pause();
    const check = () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const remaining = ws.readyState === WebSocket.OPEN ? work(ws.keys, 0) : 0; // A closing socket reads the close reply at once.
      if (remaining) { setTimeout(check, Math.ceil(remaining)).unref(); return; }
      ws.throttled = false; if (!backlogged(peerOf(ws))) ws.resume();
    };
    setTimeout(check, Math.ceil(wait)).unref();
  };
  const keysOf = keys => keys ? [keys.address, keys.network] : [];
  // Why today's relay allowances for an address and its network (none without a proxy) cannot take these bytes.
  const short = (keys, bytes) => {
    today();
    const used = key => usage.byKey.get(key) || 0;
    if (keys && (used(keys.address) + bytes > limit.addressDaily || used(keys.network) + bytes > limit.networkDaily)) return refusals.network;
    if (usage.total + bytes > limit.daily) return refusals.relay;
  };
  const spend = (keys, bytes) => {
    const refusal = bytes > 0 && short(keys, bytes);
    if (refusal) return refusal;
    usage.total += bytes;
    for (const key of keysOf(keys)) count(usage.byKey, key, bytes);
  };
  // A relay session reserves its allowance a slice at a time as it relays, so an idle session holds
  // little. A handoff the remaining allowances cannot carry is refused at the start rather than partway;
  // that check reserves nothing, so a sender that understates its handoff only loosens it, and the
  // slices still stop it. The unused part of the last slice returns when the receiver leaves.
  const charge = (receiver, bytes) => {
    if (!receiver.reservation) {
      // Plus encryption and per-message overhead (97 bytes per 16 KiB chunk, and acknowledgements), and
      // each file's manifest entry and start, end and receipt messages.
      const declared = Math.ceil(receiver.room.preview.totalBytes * 1.007) + 2048 * receiver.room.preview.count;
      const need = Math.ceil(declared / limit.slice) * limit.slice; // Slices are taken whole.
      if (receiver.room.relayed + need > limit.room) return refusals.link;
      const refusal = short(receiver.keys, need);
      if (refusal) return refusal;
      receiver.reservation = { day: today(), bytes: 0 };
    }
    while (receiver.toReceiver + receiver.toSender + bytes > receiver.reservation.bytes) {
      if (receiver.room.relayed + limit.slice > limit.room) return refusals.link;
      const refusal = spend(receiver.keys, limit.slice);
      if (refusal) return refusal;
      receiver.room.relayed += limit.slice; receiver.reservation.bytes += limit.slice;
      receiver.reservation.day = usage.day; // Only the latest slice can be partly unused.
    }
  };
  const release = receiver => {
    if (!receiver.reservation) return;
    const unused = receiver.reservation.bytes - receiver.toReceiver - receiver.toSender;
    receiver.room.relayed -= unused;
    if (receiver.reservation.day === today()) spend(receiver.keys, -unused);
  };
  const spendSignals = (keys, bytes) => {
    today();
    if (!keys) return;
    const used = key => usage.signals.get(key) || 0;
    if (used(keys.address) + bytes > limit.addressSignals || used(keys.network) + bytes > limit.networkSignals) return refusals.setup;
    for (const key of keysOf(keys)) count(usage.signals, key, bytes);
  };
  // The other peer learns why from sender-left or peer-left.
  const closeWith = (ws, [code, reason]) => {
    const { closedByLimit } = tally(); closedByLimit[code] = (closedByLimit[code] || 0) + 1;
    ws.closeCode = code; ws.closeReason = reason; ws.close(code, reason);
  };
  // Socket origins are compared to this exact string, so accept only a bare http(s) origin.
  const publicOrigin = new URL(origin || 'https://meatproxy.to');
  if (!/^https?:$/.test(publicOrigin.protocol) || (origin && publicOrigin.origin !== origin)) throw new Error(`PUBLIC_ORIGIN must be an origin such as https://meatproxy.to, not ${origin}`);
  const server = http.createServer((req, res) => {
    for (const header of Object.entries(securityHeaders)) res.setHeader(...header);
    // no-transform stops Cloudflare adding its analytics script to pages, which the CSP would block.
    res.setHeader('Cache-Control', 'no-store, no-transform');
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
  // Pings and pongs are charged like messages, and pings answered only while the socket keeps up; a message
  // may have at most 16 fragments, so splitting one into thousands of empty frames cannot avoid its charge.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false, autoPong: false, maxFragments: 16 });
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
    // Sockets opened only to be refused do not take one of the service's slots.
    if (req.url !== '/socket' || (requestOrigin && requestOrigin !== allowedOrigin) || wss.clients.size - refusing >= maxClients) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    // Nginx sets X-Real-IP to the client's address. Without a proxy (local development), no per-address limits apply.
    const keys = req.headers['x-real-ip'] ? addressKeys(req.headers['x-real-ip']) : null;
    const held = key => connections.get(key) || 0;
    const refused = keys && (held(keys.address) >= maxConnections.address || held(keys.network) >= maxConnections.network);
    // A few extra sockets open only to be closed with a reason the page can show; beyond that, 429.
    if ((keys && held(keys.address) >= 2 * maxConnections.address) || (refused && refusing >= maxRefusing)) {
      tally().refused++; socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return;
    }
    // Counted from the handshake until the socket closes, so refused or lingering sockets cannot pile up.
    // Refused sockets count only toward their own address, so they cannot fill the network for its neighbours.
    const counted = !keys ? [] : refused ? [keys.address] : [keys.address, keys.network];
    for (const key of counted) count(connections, key, 1);
    socket.once('close', () => { for (const key of counted) count(connections, key, -1); });
    if (refused) { refusing++; socket.once('close', () => { refusing--; }); }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.keys = keys;
      if (!refused) { wss.emit('connection', ws); return; }
      ws.on('error', () => {}); closeWith(ws, refusals.connections); ws.pause(); // Never read; terminated below.
      setTimeout(() => ws.terminate(), 2000).unref();
    });
  });
  wss.on('connection', ws => {
    ws.alive = true; ws.held = false; ws.throttled = false; ws.relayQueue = 0;
    ws.toReceiver = 0; ws.toSender = 0; ws.signalsToReceiver = 0; ws.signalsToSender = 0;
    tally().peakSockets = Math.max(usage.peakSockets, wss.clients.size);
    ws.on('pong', data => { ws.alive = true; spendFrame(ws, data.length); });
    ws.on('ping', data => { spendFrame(ws, data.length); if (ws.bufferedAmount < 64 * 1024) ws.pong(data); });
    const setupTimer = setTimeout(() => { if (!ws.room) ws.close(1008, 'Join a handoff first'); }, 10_000);
    ws.on('error', () => {}); // Errors are followed by close; close performs room cleanup.
    ws.on('message', (data, binary) => {
      ws.alive = true; // A slow upload can hold the pong behind megabytes of file data.
      spendFrame(ws, data.length); // Messages already read when the socket pauses still arrive, and are charged too.
      if (binary) {
        const peer = peerOf(ws);
        // After a receiver leaves, the sender's queued data for it can still be arriving.
        // The sender's first message for the next receiver is a signal, which follows all of it.
        if (!peer || peer.readyState !== WebSocket.OPEN || (ws.owner && ws.room.previousSession)) return;
        const receiver = ws.owner ? peer : ws, direction = ws.owner ? 'toReceiver' : 'toSender';
        const bytes = data.length + messageOverhead;
        if (receiver[direction] + bytes > limit[direction]) { closeWith(ws, refusals.handoff); return; }
        const refusal = charge(receiver, bytes);
        if (refusal) { closeWith(receiver, refusal); return; } // The link survives for another recipient.
        receiver[direction] += bytes;
        // Pausing lets TCP slow the sender's browser. Write callbacks also fire, with an
        // error, when the receiver's socket is destroyed, so a departed receiver releases it.
        peer.relayQueue++;
        peer.send(data, { binary: true }, () => { peer.relayQueue--; if (ws.isPaused && !ws.throttled && !backlogged(peer)) ws.resume(); });
        if (backlogged(peer)) { ws.pause(); ws.held = true; }
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!msg || typeof msg !== 'object') { ws.close(1008, 'Invalid message'); return; }
      if (msg.type === 'create' && !ws.room) {
        const id = randomBytes(16).toString('base64url');
        const room = { id, owner: ws, guest: null, created: Date.now(), relayed: 0, preview: { count: 0, totalBytes: 0, names: [] } };
        rooms.set(id, room); ws.room = room; ws.owner = true; tally().rooms++;
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
        const peer = peerOf(ws);
        const receiver = ws.owner ? peer : ws, direction = ws.owner ? 'signalsToReceiver' : 'signalsToSender';
        // Frame bytes plus the per-message overhead, so escaped characters and tiny messages count at their cost on the wire.
        const bytes = data.length + messageOverhead;
        if (receiver) {
          if (receiver[direction] + bytes > limit.signals) { closeWith(ws, refusals.signals); return; }
          const refusal = spendSignals(ws.keys, bytes);
          if (refusal) { closeWith(ws, refusal); return; }
          receiver[direction] += bytes; tally().signalBytes += bytes;
        }
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
        send(room.guest, { type: 'sender-left', code: ws.closeCode, reason: ws.closeReason });
        room.guest?.close(1000, 'Sender left');
      } else if (room.guest === ws) {
        release(ws);
        room.guest = null; room.previousSession = true; send(room.owner, { type: 'peer-left', code: ws.closeCode, reason: ws.closeReason });
      }
    });
  });
  const heartbeat = setInterval(() => {
    today(); // Logs the summary soon after midnight UTC, even when nothing is relayed.
    for (const [key, entry] of credit) if (entry.level + (performance.now() - entry.at) / 1000 * entry.rate >= 2 * entry.rate) credit.delete(key); // Refilled.
    for (const ws of wss.clients) {
      // A sender held, by the relay or for its work, at any time since the last check may not have
      // read its pong yet, so its receiver's liveness decides. Two sockets holding each other are both checked.
      const peer = peerOf(ws);
      const exempt = ws.held && !peer?.isPaused;
      ws.held = ws.isPaused;
      if (!ws.alive && !exempt) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (ws.room && Date.now() - ws.room.created >= roomLifetime) ws.close(1000, 'Handoff expired after 12 hours');
    }
  }, 25_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return { server, wss, rooms, summary: () => { today(); return summary(); }, close: async () => {
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
  // A restart resets the day's counts, so it reports them first.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { console.log(JSON.stringify({ event: 'usage-at-shutdown', ...app.summary() })); await app.close(); process.exit(0); });
}

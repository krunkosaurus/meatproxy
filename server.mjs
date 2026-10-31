import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const publicDir = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/app.js', ['app.js', 'text/javascript']],
  ['/protocol.js', ['protocol.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/receive.mjs', ['receive.mjs', 'text/javascript']],
]);
const tokenPattern = /^[A-Za-z0-9_-]{22}$/;

export function createApp({ origin = process.env.PUBLIC_ORIGIN, maxClients = 200 } = {}) {
  const rooms = new Map();
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    if (path === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"version":"0.1.0"}'); return; }
    if (path === '/robots.txt') { res.setHeader('Content-Type', 'text/plain'); res.end('User-agent: *\nDisallow: /s/\n'); return; }
    const asset = assets.get(path) || (path === '/' || /^\/s\/[A-Za-z0-9_-]{22}$/.test(path) ? ['index.html', 'text/html'] : null);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(new URL(asset[0], publicDir));
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`);
      if (path.startsWith('/s/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500).end('Unable to load the application'); }
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
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const setupTimer = setTimeout(() => { if (!ws.room) ws.close(1008, 'Join a handoff first'); }, 10_000);
    ws.on('error', () => {}); // Errors are followed by close; close performs room cleanup.
    ws.on('message', (data, binary) => {
      if (binary) {
        const peer = ws.owner ? ws.room?.guest : ws.room?.owner;
        if (!peer || peer.readyState !== WebSocket.OPEN) return;
        if (peer.bufferedAmount > 1024 * 1024) { ws.close(1008, 'Receiver is too slow; reconnect'); return; }
        peer.send(data, { binary: true });
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!msg || typeof msg !== 'object') { ws.close(1008, 'Invalid message'); return; }
      if (msg.type === 'create' && !ws.room) {
        const id = randomBytes(16).toString('base64url');
        const room = { id, owner: ws, guest: null, created: Date.now() };
        rooms.set(id, room); ws.room = room; ws.owner = true;
        clearTimeout(setupTimer); send(ws, { type: 'created', room: id });
      } else if (msg.type === 'join' && !ws.room && tokenPattern.test(msg.room)) {
        const room = rooms.get(msg.room);
        if (!room) { send(ws, { type: 'unavailable' }); ws.close(1000); return; }
        if (room.guest) { send(ws, { type: 'busy' }); ws.close(1000); return; }
        room.guest = ws; ws.room = room; ws.owner = false;
        clearTimeout(setupTimer);
        send(room.owner, { type: 'peer-joined' }); send(ws, { type: 'joined' });
      } else if (msg.type === 'signal' && ws.room && typeof msg.payload === 'string' && msg.payload.length <= 60_000) {
        const peer = ws.owner ? ws.room.guest : ws.room.owner;
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
        room.guest = null; send(room.owner, { type: 'peer-left' });
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
      if (ws.room && Date.now() - ws.room.created > 12 * 60 * 60 * 1000) ws.close(1000, 'Handoff expired after 12 hours');
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

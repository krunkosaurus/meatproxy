// Local test fixture: withhold initial WebRTC signaling, then allow the real relay timeout.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
const server = http.createServer((req, res) => {
  const request = http.request({ hostname: '127.0.0.1', port: 3477, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  req.pipe(request);
});
const wss = new WebSocketServer({ server, path: '/socket' });
wss.on('connection', downstream => {
  const upstream = new WebSocket('ws://127.0.0.1:3477/socket', { origin: 'http://127.0.0.1:3477' });
  let isOwner = false, joinedAt = 0;
  const pending = [];
  upstream.on('open', () => { for (const [data, binary] of pending) upstream.send(data, { binary }); });
  downstream.on('message', (data, binary) => {
    if (!binary) {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'create') isOwner = true;
      if (isOwner && msg.type === 'signal' && Date.now() - joinedAt < 7000) return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else pending.push([data, binary]);
  });
  upstream.on('message', (data, binary) => {
    if (!binary && JSON.parse(data.toString()).type === 'peer-joined') joinedAt = Date.now();
    if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
  });
  downstream.on('close', () => upstream.close()); upstream.on('close', () => downstream.close());
  upstream.on('error', () => downstream.close()); downstream.on('error', () => upstream.close());
});
server.listen(3478, '127.0.0.1', () => console.log('Blocked-direct test fixture on http://localhost:3478'));

// Local benchmark: add 50 ms to each WebSocket hop (200 ms round trip).
// The Node receiver requests relay mode, exercising the real encrypted transfer.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const server = http.createServer((req, res) => {
  const request = http.request({ hostname: '127.0.0.1', port: 3477, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  request.on('error', () => res.writeHead(502).end('Start the local app on port 3477 first.'));
  req.pipe(request);
});
const wss = new WebSocketServer({ server, path: '/socket' });
wss.on('connection', downstream => {
  const upstream = new WebSocket('ws://127.0.0.1:3477/socket', { origin: 'http://127.0.0.1:3477' });
  const pending = [];
  const forward = (socket, data, binary) => setTimeout(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
  }, 50);
  upstream.on('open', () => { for (const [data, binary] of pending) forward(upstream, data, binary); });
  downstream.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) forward(upstream, data, binary);
    else pending.push([data, binary]);
  });
  upstream.on('message', (data, binary) => forward(downstream, data, binary));
  downstream.on('close', () => upstream.close()); upstream.on('close', () => downstream.close());
  upstream.on('error', () => downstream.close()); downstream.on('error', () => upstream.close());
});
server.listen(3479, '127.0.0.1', () => console.log('Latency benchmark on http://localhost:3479'));

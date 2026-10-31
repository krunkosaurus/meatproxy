import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect as connectTCP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp, fingerprint, securityHeaders } from '../server.mjs';
import { makeSecret, importSecret, encrypt, decrypt, validateManifest } from '../public/protocol.js';

async function setup(t, options = {}) {
  const app = createApp({ origin: 'https://meatproxy.to', ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/socket`;
  // In production, Nginx sets X-Real-IP to the client's address.
  const connect = async address => { const ws = new WebSocket(url, { origin: 'https://meatproxy.to', headers: address ? { 'X-Real-IP': address } : {} }); await once(ws, 'open'); return ws; };
  return { app, connect, url };
}
const message = async ws => JSON.parse((await once(ws, 'message'))[0].toString());
async function create(connect, address) { const owner = await connect(address); const response = message(owner); owner.send(JSON.stringify({ type: 'create' })); return { owner, room: (await response).room }; }
async function publish(owner, preview) {
  const processed = once(owner, 'pong');
  owner.send(JSON.stringify({ type: 'preview', ...preview })); owner.ping(); await processed;
}
async function until(predicate, label) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await delay(10); }
  assert.fail(`Timed out waiting for ${label}`);
}
async function relayPair(t) {
  const { app, connect } = await setup(t); const { owner, room } = await create(connect);
  const receiver = await connect(); const joined = message(receiver); const ownerJoined = message(owner);
  receiver.send(JSON.stringify({ type: 'join', room }));
  assert.equal((await joined).type, 'joined'); assert.equal((await ownerJoined).type, 'peer-joined');
  const relayed = [...app.wss.clients];
  return { connect, owner, room, receiver, relayedSender: relayed.find(ws => ws.owner), relayedReceiver: relayed.find(ws => ws.owner === false) };
}
// 30 MiB in messages under the 64 KiB limit: far more than the sockets between the peers can hold.
const flood = owner => { for (let i = 0; i < 512; i++) owner.send(Buffer.alloc(60 * 1024, i % 251)); };
const nextMessageOrClose = ws => Promise.race([message(ws), once(ws, 'close').then(([code]) => ({ type: `closed ${code}` }))]);

test('browser worker and imported handoff modules are served as JavaScript', async t => {
  const { app } = await setup(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/file-worker.js', '/file-tasks.js', '/handoff.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
    assert.ok((await response.text()).length > 100);
  }
  assert.match(await fetch(base + '/hashes-LICENSE.txt').then(response => response.text()), /MIT License/);
});

const pageReferences = html => [...html.matchAll(/(?:href|src|content)="(?:https:\/\/meatproxy\.to)?(\/[\w.-]+(?:\?[^"]*)?)"/g)].map(match => match[1]);
// The version of bytes that reference nothing, under the server's actual response headers.
const version = bytes => fingerprint(new Map([['/bytes.bin', bytes]])).get('/bytes.bin').version;

test('every asset the page references is versioned by content; only that exact version is cacheable', async t => {
  const { app, connect } = await setup(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base + '/');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = Buffer.from(await page.arrayBuffer());
  const { room } = await create(connect);
  for (const path of [`/?v=${version(html)}`, `/s/${room}?v=${version(html)}`, `/s/${room}/status`, `/s/${room}/status?v=${version(html)}`]) {
    assert.equal((await fetch(base + path)).headers.get('cache-control'), 'no-store', `${path} is never cacheable`);
  }
  const references = new Set(pageReferences(html.toString()));
  for (const path of ['/app.js', '/protocol.js', '/transfer.js', '/file-tasks.js', '/handoff.js', '/style.css', '/logo.svg', '/favicon.png', '/favicon.svg', '/og.png', '/receive.mjs']) {
    assert.ok([...references].some(reference => reference.startsWith(`${path}?v=`)), `The page references a versioned ${path}`);
  }
  for (const reference of references) {
    const { pathname, searchParams } = new URL(reference, base);
    assert.match(searchParams.get('v') ?? '', /^[0-9a-f]{12}$/, `${reference} carries a content version`);
    const response = await fetch(base + reference);
    assert.equal(response.status, 200, reference);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', reference);
    assert.equal(version(Buffer.from(await response.arrayBuffer())), searchParams.get('v'), `${reference} names its exact bytes`);
    const head = await fetch(base + reference, { method: 'HEAD' });
    assert.equal(head.headers.get('cache-control'), 'public, max-age=31536000, immutable', `HEAD ${reference}`);
    assert.equal((await fetch(base + pathname)).headers.get('cache-control'), 'no-store', `${pathname} without a version`);
    assert.equal((await fetch(`${base}${pathname}?v=000000000000`)).headers.get('cache-control'), 'no-store', `${pathname} with a stale version`);
  }
});

test('the page and every module it loads refer to each script only at its current version', async t => {
  const { app } = await setup(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // A missed or outdated reference would load a second copy of a module with separate state.
  const unversioned = /[`'"](?:\.{1,2}\/)*\/?[\w.-]+\.js(?!\?v=[0-9a-f]{12}[`'"])/;
  const versioned = /[`'"]\.{0,2}(\/[\w.-]+\.(?:js|css|png|svg|mjs)\?v=[0-9a-f]{12})[`'"]/g;
  const html = await fetch(base + '/').then(response => response.text());
  assert.doesNotMatch(html, /\b(?:src|href)=[^"]/, 'Every page reference is quoted, so it is versioned');
  const queue = ['/'], seen = new Set(queue);
  while (queue.length) {
    const url = queue.shift(), body = await fetch(base + url).then(response => response.text());
    assert.doesNotMatch(body, unversioned, `${url} refers to every script by its version`);
    for (const [, reference] of body.matchAll(versioned)) {
      if (seen.has(reference)) continue;
      seen.add(reference);
      assert.equal((await fetch(base + reference)).headers.get('cache-control'), 'public, max-age=31536000, immutable', `${url} refers to the current ${reference}`);
      if (reference.includes('.js?')) queue.push(reference);
    }
  }
  for (const path of ['/app.js', '/protocol.js', '/transfer.js', '/file-tasks.js', '/handoff.js', '/file-worker.js']) {
    assert.ok([...seen].some(reference => reference.startsWith(`${path}?v=`)), `The page loads ${path}`);
  }
});

test('a cacheable response carries exactly the headers its version covers', async t => {
  const { app } = await setup(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const references = pageReferences(await fetch(base + '/').then(response => response.text()));
  const worker = (await fetch(base + references.find(reference => reference.startsWith('/file-tasks.js?'))).then(response => response.text())).match(/'(\/file-worker\.js\?v=\w+)'/)[1];
  // The worker's own response sets the policy it runs under, so it must not drift from its version.
  for (const reference of [worker, references.find(reference => reference.startsWith('/style.css?'))]) {
    const response = await fetch(base + reference);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const sent = Object.fromEntries([...response.headers].filter(([name]) => !['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'cache-control', 'content-type'].includes(name)));
    assert.deepEqual(sent, Object.fromEntries(Object.entries(securityHeaders).map(([name, value]) => [name.toLowerCase(), value])), reference);
  }
});

test('changing a file gives it, and everything that references it, a new URL; nothing else changes', () => {
  const sources = new Map([
    ['/index.html', Buffer.from('<link rel="modulepreload" href="/protocol.js"><script type="module" src="/app.js"></script><link rel="stylesheet" href="/style.css"><meta property="og:image" content="https://meatproxy.to/og.png"><a href="/">Home</a><a href="/missing.css">Missing</a>')],
    ['/app.js', Buffer.from("import { a } from './protocol.js';\nnew Worker('/worker.js', { type: 'module' });\nfetch('/missing.js');")],
    ['/protocol.js', Buffer.from('export const a = 1;')],
    ['/worker.js', Buffer.from('self.onmessage = () => {};')],
    ['/style.css', Buffer.from('body { margin: 0; }')],
    ['/og.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ]);
  const before = fingerprint(sources);
  const after = fingerprint(new Map(sources).set('/protocol.js', Buffer.from('export const a = 2;')));
  assert.deepEqual([...before.keys()].filter(path => before.get(path).version !== after.get(path).version).sort(), ['/app.js', '/index.html', '/protocol.js']);
  const app = after.get('/app.js').body.toString(), page = after.get('/index.html').body.toString();
  assert.ok(app.includes(`from './protocol.js?v=${after.get('/protocol.js').version}'`));
  assert.ok(app.includes(`new Worker('/worker.js?v=${after.get('/worker.js').version}'`));
  assert.ok(app.includes("fetch('/missing.js')"), 'Script paths that are not assets stay unchanged');
  assert.ok(page.includes(`content="https://meatproxy.to/og.png?v=${version(sources.get('/og.png'))}"`));
  assert.ok(page.includes('<a href="/">Home</a><a href="/missing.css">Missing</a>'), 'Page paths that are not assets stay unchanged');
  assert.equal(after.get('/og.png').body, sources.get('/og.png'), 'Binary assets are served as they are');
  // Caches keep headers with the bytes, so changing response headers must change every version.
  const headersChanged = fingerprint(sources, 'other response headers');
  assert.ok([...before.keys()].every(path => before.get(path).version !== headersChanged.get(path).version));
});

test('a malformed request target gets 400 and the service keeps running', async t => {
  const { app } = await setup(t);
  const socket = connectTCP(app.server.address().port, '127.0.0.1'); await once(socket, 'connect');
  socket.end('GET //[ HTTP/1.1\r\nHost: meatproxy.to\r\nConnection: close\r\n\r\n');
  let reply = ''; for await (const chunk of socket) reply += chunk;
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`)).status, 200);
});

test('a public origin that is not exactly an http(s) origin stops the service at startup', () => {
  // A trailing slash would refuse every browser socket; other schemes would fail on the first recipient link.
  for (const origin of ['meatproxy.to', 'https://meatproxy.to/', 'javascript:alert(1)', 'https://meatproxy.to/path']) {
    assert.throws(() => createApp({ origin }), origin);
  }
  for (const origin of ['https://meatproxy.to', 'http://localhost:3477']) createApp({ origin }).server.close();
});

test('social crawlers get a valid public preview without exposing or joining a handoff', async t => {
  const { app, connect } = await setup(t);
  const { room } = await create(connect);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const secret = makeSecret();
  const home = await fetch(base).then(response => response.text());
  assert.match(home, /Meatproxy — Send files &amp; notes/);
  const response = await fetch(`${base}/s/${room}#${secret}`, { headers: { 'User-Agent': 'Twitterbot/1.0' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(html, /Someone wants to send you files/);
  assert.match(html, /Sender online when previewed/);
  assert.match(html, /Open to accept a peer-to-peer transfer/);
  assert.ok(html.includes(`property="og:url" content="https://meatproxy.to/s/${room}"`));
  assert.ok(!html.includes(secret));
  const image = html.match(/property="og:image" content="([^"]+)"/)[1];
  assert.equal(new URL(image).origin, 'https://meatproxy.to');
  assert.equal(new URL(image).pathname, '/og-online.png');
  assert.match(new URL(image).search, /^\?v=[0-9a-f]{12}$/);
  const card = await fetch(base + new URL(image).pathname + new URL(image).search);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get('content-type'), 'image/png');
  assert.equal(card.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const png = Buffer.from(await card.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const head = await fetch(base + new URL(image).pathname, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(app.rooms.size, 1);
  assert.equal(app.rooms.get(room).guest, null);
});

test('filename previews are opt-in, escaped, removable, and never join the room', async t => {
  const { app, connect } = await setup(t); const { owner, room } = await create(connect);
  const base = `http://127.0.0.1:${app.server.address().port}/s/${room}`;
  const preview = { count: 1, totalBytes: 283 * 1024 ** 2, names: [] };
  await publish(owner, preview);
  assert.deepEqual(await fetch(`${base}/status`).then(r => r.json()), { state: 'online', ...preview });
  const generic = await fetch(base).then(r => r.text());
  assert.match(generic, /Someone wants to send you a file/);
  assert.match(generic, /1 file · 283 MB/);
  const name = 'video & notes "><img src=x onerror="alert(1)">.mp4';
  await publish(owner, { ...preview, names: [name] });
  const html = await fetch(base).then(r => r.text());
  assert.ok(!html.includes(name));
  assert.match(html, /video &amp; notes &quot;&gt;&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\.mp4/);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.deepEqual((await fetch(`${base}/status`).then(r => r.json())).names, [name]);
  await publish(owner, preview);
  assert.deepEqual((await fetch(`${base}/status`).then(r => r.json())).names, []);
  assert.ok(!(await fetch(base).then(r => r.text())).includes('video &amp; notes'));
  const head = await fetch(`${base}/status`, { method: 'HEAD' });
  assert.equal(head.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await head.text(), '');
  assert.equal(app.rooms.get(room).guest, null);
});

test('preview availability follows live room occupancy and removes names after expiry', async t => {
  const { app, connect } = await setup(t); const { owner, room } = await create(connect);
  const base = `http://127.0.0.1:${app.server.address().port}/s/${room}`;
  await publish(owner, { count: 1, totalBytes: 100, names: ['example.mp4'] });
  const receiver = await connect(); const joined = message(receiver); const ownerJoined = message(owner);
  receiver.send(JSON.stringify({ type: 'join', room })); await joined; await ownerJoined;
  assert.equal((await fetch(`${base}/status`).then(r => r.json())).state, 'busy');
  assert.match(await fetch(base).then(r => r.text()), /og-busy\.png/);
  const left = message(owner); receiver.close(); assert.equal((await left).type, 'peer-left');
  assert.equal((await fetch(`${base}/status`).then(r => r.json())).state, 'online');
  const closed = once(owner, 'close'); owner.close(); await closed;
  assert.deepEqual(await fetch(`${base}/status`).then(r => r.json()), { state: 'offline', count: 0, totalBytes: 0, names: [] });
  const expired = await fetch(base).then(r => r.text());
  assert.match(expired, /This file link has expired/);
  assert.match(expired, /og-offline\.png/);
  assert.ok(!expired.includes('example.mp4'));
  const aged = await create(connect);
  app.rooms.get(aged.room).created -= 12 * 60 * 60 * 1000;
  assert.equal((await fetch(base.replace(room, aged.room) + '/status').then(r => r.json())).state, 'offline');
  const later = await connect(); const unavailable = message(later); later.send(JSON.stringify({ type: 'join', room: aged.room })); assert.equal((await unavailable).type, 'unavailable');
});

test('only owners can publish bounded preview metadata', async t => {
  const { app, connect } = await setup(t); const { owner, room } = await create(connect);
  const preview = { type: 'preview', count: 1, totalBytes: 10, names: ['example.txt'] };
  const receiver = await connect(); const joined = message(receiver); receiver.send(JSON.stringify({ type: 'join', room })); await joined;
  const closed = once(receiver, 'close'); receiver.send(JSON.stringify(preview)); assert.equal((await closed)[0], 1008);
  assert.equal(app.rooms.get(room).preview.count, 0);
  for (const invalid of [{ count: 101 }, { totalBytes: 512 * 1024 ** 2 + 1 }, { names: ['x'.repeat(513)] }, { names: [123] }, { names: ['a', 'b'] }]) {
    const sender = (await create(connect)).owner; const rejected = once(sender, 'close');
    sender.send(JSON.stringify({ ...preview, ...invalid })); assert.equal((await rejected)[0], 1008);
  }
  await publish(owner, { count: 1, totalBytes: 10, names: [] });
  assert.equal(app.rooms.get(room).preview.count, 1);
});

test('service starts when launched through the deployed release symlink', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'meatproxy-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'current.mjs');
  await symlink(fileURLToPath(new URL('../server.mjs', import.meta.url)), entry);
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  const output = await Promise.race([
    once(child.stdout, 'data').then(([data]) => data.toString()),
    once(child, 'exit').then(([code]) => { throw new Error(`Service exited early: ${code}`); }),
  ]);
  assert.match(output, /Meatproxy listening on 127\.0\.0\.1/);
});

test('two rooms stay isolated; a third receiver cannot displace the active receiver', async t => {
  const { connect } = await setup(t);
  const a = await create(connect); const b = await create(connect);
  const receiver = await connect(); const joined = message(receiver); const ownerJoined = message(a.owner);
  receiver.send(JSON.stringify({ type: 'join', room: a.room }));
  assert.equal((await joined).type, 'joined'); assert.equal((await ownerJoined).type, 'peer-joined');
  const third = await connect(); const busy = message(third); third.send(JSON.stringify({ type: 'join', room: a.room })); assert.equal((await busy).type, 'busy');
  const delivery = message(a.owner); let leaked = false; b.owner.on('message', () => { leaked = true; });
  receiver.send(JSON.stringify({ type: 'signal', payload: 'opaque-encrypted-message' }));
  assert.deepEqual(await delivery, { type: 'signal', payload: 'opaque-encrypted-message' }); assert.equal(leaked, false);
  const binary = once(receiver, 'message'); const bytes = Buffer.from(Array.from({ length: 16_384 }, (_, i) => i % 256));
  a.owner.send(bytes); assert.deepEqual((await binary)[0], bytes);
});

test('closing sender expires the room and notifies the receiver', async t => {
  const { connect, app } = await setup(t); const { owner, room } = await create(connect);
  const receiver = await connect(); const joined = message(receiver); receiver.send(JSON.stringify({ type: 'join', room })); await joined;
  const left = message(receiver); owner.close(); assert.equal((await left).type, 'sender-left'); assert.equal(app.rooms.has(room), false);
  const later = await connect(); const unavailable = message(later); later.send(JSON.stringify({ type: 'join', room })); assert.equal((await unavailable).type, 'unavailable');
});

test('a slow receiver pauses the relay sender instead of disconnecting it; every byte then arrives in order', { timeout: 20000 }, async t => {
  const { owner, receiver, relayedSender, relayedReceiver } = await relayPair(t);
  let peak = 0; const send = relayedReceiver.send;
  relayedReceiver.send = function (...args) { const result = send.apply(this, args); peak = Math.max(peak, this.bufferedAmount); return result; };
  const chunks = []; receiver.on('message', (data, binary) => { if (binary) chunks.push(data); });
  let closed = false; owner.on('close', () => { closed = true; });
  receiver.pause(); flood(owner);
  await until(() => relayedSender.isPaused, 'the relay to pause the sender');
  receiver.resume();
  await until(() => chunks.length === 512, 'every relayed message');
  await until(() => !relayedSender.isPaused, 'the relay to resume the sender');
  assert.equal(closed, false);
  // 512 KiB, plus at most one 64 KiB socket read already parsed when the sender is paused.
  assert.ok(peak <= 640 * 1024, `The relay buffered ${peak} bytes for one receiver`);
  chunks.forEach((chunk, i) => assert.ok(chunk.equals(Buffer.alloc(60 * 1024, i % 251)), `Message ${i} arrived intact and in order`));
});

test('a flood of tiny messages is paused by count, not only by bytes', { timeout: 20000 }, async t => {
  const { owner, receiver, relayedSender, relayedReceiver } = await relayPair(t);
  // Each queued message costs heap however small it is, so bytes alone do not bound memory.
  let queued = 0, peak = 0; const send = relayedReceiver.send;
  relayedReceiver.send = function (data, options, callback) {
    queued++; peak = Math.max(peak, queued);
    return send.call(this, data, options, (...args) => { queued--; callback?.(...args); });
  };
  let delivered = 0; receiver.on('message', (data, binary) => { if (binary) delivered++; });
  receiver.pause();
  for (let i = 0; i < 200_000; i++) owner.send(Buffer.alloc(64, i & 255)); // About 13 MiB on the wire.
  await until(() => relayedSender.isPaused, 'the relay to pause the sender');
  await delay(200);
  // 256 messages, plus at most one 64 KiB socket read of 70-byte frames (about 940).
  assert.ok(peak <= 1_300, `The relay queued ${peak} messages for one receiver`);
  receiver.resume();
  await until(() => delivered === 200_000, 'every tiny message');
});

test('a receiver that leaves while the relay holds the sender frees the link for the next recipient', { timeout: 20000 }, async t => {
  const { connect, owner, room, receiver, relayedSender } = await relayPair(t);
  receiver.pause(); flood(owner);
  await until(() => relayedSender.isPaused, 'the relay to pause the sender');
  const left = nextMessageOrClose(owner); receiver.terminate();
  assert.equal((await left).type, 'peer-left');
  // The pong proves the relay reads the sender again, after the rest of its backlog.
  await publish(owner, { count: 1, totalBytes: 1, names: [] });
  const next = await connect(); const joined = message(next); const ownerJoined = message(owner);
  next.send(JSON.stringify({ type: 'join', room }));
  assert.equal((await joined).type, 'joined'); assert.equal((await ownerJoined).type, 'peer-joined');
  const signalled = message(next); owner.send(JSON.stringify({ type: 'signal', payload: 'relay for the next session' }));
  assert.equal((await signalled).type, 'signal');
  const delivery = once(next, 'message'); owner.send(Buffer.from('next recipient'));
  assert.equal((await delivery)[0].toString(), 'next recipient');
});

test('a new receiver never gets data the sender queued for the previous one', { timeout: 20000 }, async t => {
  const { connect, owner, room, receiver } = await relayPair(t);
  const left = message(owner); receiver.terminate(); assert.equal((await left).type, 'peer-left');
  const next = await connect(); const joined = message(next); const ownerJoined = message(owner);
  next.send(JSON.stringify({ type: 'join', room }));
  assert.equal((await joined).type, 'joined'); assert.equal((await ownerJoined).type, 'peer-joined');
  const delivered = []; next.on('message', (data, binary) => delivered.push(binary ? `binary:${data}` : JSON.parse(data).type));
  // Ciphertext for the previous session can still be crossing a slow upload when the next receiver joins.
  // The sender's first message for the new session is a signal, so it follows all of that data.
  owner.send(Buffer.from('previous session'));
  owner.send(JSON.stringify({ type: 'signal', payload: 'relay for the next session' }));
  owner.send(Buffer.from('next session'));
  await until(() => delivered.includes('binary:next session'), 'the next session to arrive');
  assert.deepEqual(delivered, ['signal', 'binary:next session']);
});

test('the liveness check keeps a socket whose messages keep arriving and drops a silent one', { timeout: 20000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { url } = await setup(t);
  // A slow upload can hold a sender's pong behind megabytes of file data; autoPong: false models that.
  const open = async () => { const ws = new WebSocket(url, { origin: 'https://meatproxy.to', autoPong: false }); await once(ws, 'open'); const created = message(ws); ws.send(JSON.stringify({ type: 'create' })); await created; return ws; };
  const busy = await open(), silent = await open();
  const silentClosed = once(silent, 'close');
  for (let tick = 0; tick < 3; tick++) {
    await publish(busy, { count: 0, totalBytes: 0, names: [] });
    t.mock.timers.tick(25_000);
  }
  await silentClosed;
  assert.equal(busy.readyState, WebSocket.OPEN);
});

test('a sender held during the interval survives a liveness check that lands just after it resumes', { timeout: 20000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { owner, receiver, relayedSender } = await relayPair(t);
  receiver.pause(); flood(owner);
  await until(() => relayedSender.isPaused, 'the relay to pause the sender');
  const left = nextMessageOrClose(owner);
  t.mock.timers.tick(25_000);
  // The receiver drained just enough to release the sender, which has not read its pong yet.
  relayedSender.resume();
  t.mock.timers.tick(25_000);
  assert.equal((await left).type, 'peer-left');
  await publish(owner, { count: 0, totalBytes: 0, names: [] });
});

test('two sockets that flood each other and stop reading are both dropped by the liveness check', { timeout: 20000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { owner, receiver, relayedSender, relayedReceiver } = await relayPair(t);
  owner.pause(); receiver.pause(); flood(owner); flood(receiver);
  await until(() => relayedSender.isPaused && relayedReceiver.isPaused, 'the relay to pause both sockets');
  const closed = Promise.all([once(owner, 'close'), once(receiver, 'close')]);
  t.mock.timers.tick(25_000);
  t.mock.timers.tick(25_000);
  await closed;
});

test('the liveness check drops a stalled receiver but keeps the sender the relay is holding', { timeout: 20000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { owner, receiver, relayedSender } = await relayPair(t);
  receiver.pause(); flood(owner);
  await until(() => relayedSender.isPaused, 'the relay to pause the sender');
  const left = nextMessageOrClose(owner);
  t.mock.timers.tick(25_000); // Neither socket can return this ping's pong while it is paused.
  t.mock.timers.tick(25_000);
  assert.equal((await left).type, 'peer-left');
  await publish(owner, { count: 0, totalBytes: 0, names: [] });
  assert.equal(owner.readyState, WebSocket.OPEN);
});

// The page enforces the handoff limits; these limits stop a modified client using the relay as an open pipe.
const nextJSON = ws => new Promise(resolve => ws.on('message', function listener(data, binary) { if (!binary) { ws.off('message', listener); resolve(JSON.parse(data)); } }));
const closeOf = async ws => { const [code, reason] = await once(ws, 'close'); return `${code} ${reason}`; };
async function joinRelay(connect, owner, room, address) {
  const receiver = await connect(address); const joined = message(receiver); const ownerJoined = message(owner);
  receiver.send(JSON.stringify({ type: 'join', room }));
  assert.equal((await joined).type, 'joined'); assert.equal((await ownerJoined).type, 'peer-joined');
  const signalled = message(receiver); owner.send(JSON.stringify({ type: 'signal', payload: 'relay' })); await signalled;
  return receiver;
}
async function limitedPair(connect, receiverAddress) {
  const { owner, room } = await create(connect);
  return { owner, room, receiver: await joinRelay(connect, owner, room, receiverAddress) };
}
// The receiver's first relay frame ("ready") starts the session: 'admitted', or the refusal's close.
function startRelay({ owner, receiver }) {
  const outcome = new Promise(resolve => {
    owner.on('message', (data, binary) => { if (binary) resolve('admitted'); });
    receiver.once('close', (code, reason) => resolve(`${code} ${reason}`));
  });
  receiver.send(Buffer.from('ready'));
  return outcome;
}

test('one receiver connection relays at most one handoff and acknowledgement-sized traffic back; the other side learns why', { timeout: 10000 }, async t => {
  const { connect } = await setup(t, { limits: { toReceiver: 100_000, toSender: 1_000 } });
  const forward = await limitedPair(connect);
  let received = 0; forward.receiver.on('message', (data, binary) => { if (binary) received += data.length; });
  const senderClosed = closeOf(forward.owner), told = nextJSON(forward.receiver);
  for (const size of [60_000, 40_000, 1]) forward.owner.send(Buffer.alloc(size));
  assert.equal(await senderClosed, '1008 Relay limit reached for this handoff');
  assert.deepEqual(await told, { type: 'sender-left', reason: 'Relay limit reached for this handoff' });
  assert.equal(received, 100_000);
  const back = await limitedPair(connect);
  const receiverClosed = closeOf(back.receiver), ownerTold = nextJSON(back.owner);
  for (const size of [600, 400, 1]) back.receiver.send(Buffer.alloc(size));
  assert.equal(await receiverClosed, '1008 Relay limit reached for this handoff');
  assert.deepEqual(await ownerTold, { type: 'peer-left', reason: 'Relay limit reached for this handoff' });
});

test('signals count their bytes on the wire, per receiver connection', { timeout: 10000 }, async t => {
  const { connect } = await setup(t, { limits: { signals: 10_000 } });
  const { receiver } = await limitedPair(connect);
  // One character each, but six bytes once escaped in the JSON frame: about 6 KB per message.
  const escaped = JSON.stringify({ type: 'signal', payload: '\u0001'.repeat(1_000) });
  const closed = closeOf(receiver);
  receiver.send(escaped); receiver.send(escaped);
  assert.equal(await closed, '1008 Signal limit reached for this handoff');
});

test('reconnecting cannot turn signals into a pipe: they count toward the daily allowance', { timeout: 10000 }, async t => {
  const { connect } = await setup(t, { limits: { signals: 10_000, addressDaily: 20_000 } });
  const signal = JSON.stringify({ type: 'signal', payload: 'x'.repeat(5_970) }); // About 6 KB per receiver connection.
  for (let session = 0; session < 3; session++) {
    const { owner, receiver } = await limitedPair(connect, '203.0.113.5');
    const forwarded = message(owner); receiver.send(signal);
    assert.equal((await forwarded).type, 'signal', `Session ${session} is within the allowance`);
  }
  const { receiver } = await limitedPair(connect, '203.0.113.5');
  const closed = closeOf(receiver); receiver.send(signal);
  assert.equal(await closed, "1013 Your network has used today's relay allowance; try again after 00:00 UTC");
});

test('daily allowances are checked when a relay session starts, reserve its worst case, and refund the rest', { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 31, 12) });
  // Each session reserves 50,000: 40,000 to the receiver and 10,000 back.
  const { connect } = await setup(t, { limits: { toReceiver: 40_000, toSender: 10_000, addressDaily: 100_000, networkDaily: 150_000, daily: 260_000 } });
  const session = async address => { const pair = await limitedPair(connect, address); return { pair, outcome: await startRelay(pair) }; };
  const own = "1013 Your network has used today's relay allowance; try again after 00:00 UTC", everyone = "1013 The relay has reached today's limit; try again after 00:00 UTC";
  const first = await session('203.0.113.1');
  assert.equal(first.outcome, 'admitted');
  // An admitted session may use everything it reserved, even as others fill the day's allowance.
  let received = 0; first.pair.receiver.on('message', (data, binary) => { if (binary) received += data.length; });
  assert.equal((await session('203.0.113.1')).outcome, 'admitted');
  const refused = await limitedPair(connect, '203.0.113.1'), told = nextJSON(refused.owner);
  assert.equal(await startRelay(refused), own, 'A third session for one address');
  assert.deepEqual(await told, { type: 'peer-left', reason: own.slice(5) });
  assert.equal((await session('203.0.113.2')).outcome, 'admitted');
  assert.equal((await session('203.0.113.3')).outcome, own, 'A fourth session for one /24');
  assert.equal((await session('192.0.2.1')).outcome, 'admitted');
  const idle = await session('192.0.2.2');
  assert.equal(idle.outcome, 'admitted');
  assert.equal((await session('192.0.2.3')).outcome, everyone);
  first.pair.owner.send(Buffer.alloc(40_000));
  await until(() => received === 40_000, 'the whole reservation of the first session');
  idle.pair.receiver.close(); await nextJSON(idle.pair.owner); // It carried 5 bytes of its 50,000.
  assert.equal((await session('192.0.2.3')).outcome, 'admitted');
  t.mock.timers.tick(12 * 60 * 60 * 1000); // The next UTC day starts with fresh allowances.
  assert.equal((await session('203.0.113.1')).outcome, 'admitted');
});

test('a link has a relay allowance across its receivers', { timeout: 10000 }, async t => {
  const { connect } = await setup(t, { limits: { toReceiver: 40_000, toSender: 10_000, room: 120_000 } });
  const { owner, room } = await create(connect);
  for (let used = 0; used < 2; used++) {
    const receiver = await joinRelay(connect, owner, room);
    assert.equal(await startRelay({ owner, receiver }), 'admitted');
    owner.send(Buffer.alloc(40_000)); await once(receiver, 'message');
    const left = nextJSON(owner); receiver.close(); await left;
  }
  const receiver = await joinRelay(connect, owner, room);
  assert.equal(await startRelay({ owner, receiver }), '1013 This link has used its relay allowance; ask the sender for a fresh link');
});

test('behind a proxy, each address and network may hold a few connections, refused before the handshake', { timeout: 10000 }, async t => {
  const { connect, url } = await setup(t, { maxConnections: { address: 2, network: 3 } });
  const status = address => new Promise(resolve => {
    const ws = new WebSocket(url, { origin: 'https://meatproxy.to', headers: { 'X-Real-IP': address } });
    ws.on('unexpected-response', (_, response) => resolve(response.statusCode)); ws.on('open', () => resolve('open'));
  });
  const held = [await connect('2001:db8:1:2::1'), await connect('2001:db8:1:2:abcd::5')]; // One /64.
  assert.equal(await status('2001:db8:1:2:ffff::1'), 429);
  await connect('2001:db8:1:3::1'); // The /48's third.
  assert.equal(await status('2001:db8:1:4::1'), 429);
  await connect('198.51.100.7'); await connect('::ffff:198.51.100.7');
  assert.equal(await status('198.51.100.7'), 429);
  held[0].close(); await once(held[0], 'close'); await delay(50);
  await connect('2001:db8:1:2::9');
  for (let i = 0; i < 5; i++) await connect(); // Without X-Real-IP (no proxy), there are no per-address limits.
});

test('cross-origin sockets are refused and malformed messages do not crash the server', async t => {
  const { connect, url } = await setup(t);
  const foreign = new WebSocket(url, { origin: 'https://unrelated.example' });
  const error = await new Promise(resolve => foreign.once('error', resolve)); assert.match(error.message, /403/);
  const invalid = await connect(); const closed = once(invalid, 'close'); invalid.send('{'); assert.equal((await closed)[0], 1008);
  const good = await create(connect); assert.match(good.room, /^[\w-]{22}$/);
});

test('application encryption rejects a wrong key, altered bytes, and another session', async () => {
  const key = await importSecret(makeSecret()); const data = new TextEncoder().encode('Private notes: café 🥩');
  const packet = await encrypt(key, data, 'session:one'); assert.deepEqual(await decrypt(key, packet, 'session:one'), data);
  await assert.rejects(decrypt(await importSecret(makeSecret()), packet, 'session:one'));
  await assert.rejects(decrypt(key, packet, 'session:two'));
  packet[15] ^= 1; await assert.rejects(decrypt(key, packet, 'session:one'));
});

test('recipient rejects oversized and duplicate manifests before allocating file memory', () => {
  const file = { id: '12345678-1234-1234-1234-123456789abc', name: 'example.bin', size: 1, sha256: 'a'.repeat(64) };
  assert.throws(() => validateManifest([file, file]));
  assert.throws(() => validateManifest([{ ...file, size: 512 * 1024 * 1024 + 1 }]));
  assert.throws(() => validateManifest([{ ...file, size: -1 }]));
  assert.throws(() => validateManifest([], [file]));
  assert.throws(() => validateManifest([{ ...file, size: 2 }], [file]));
  assert.equal(validateManifest([{ ...file, size: 0 }]).length, 1);
});

test('video handoffs above 256 MiB are accepted within the 512 MiB aggregate limit', () => {
  const mib = 1024 * 1024;
  const video = { id: '12345678-1234-1234-1234-123456789abc', name: 'video.mp4', size: 283 * mib, sha256: 'a'.repeat(64) };
  assert.equal(validateManifest([video])[0].size, 283 * mib);
  assert.equal(validateManifest([{ ...video, size: 512 * mib }]).length, 1);
  const extra = { ...video, id: '22345678-1234-1234-1234-123456789abc', name: 'second.mp4' };
  assert.throws(() => validateManifest([video, extra]), /512 MB total limit/);
});

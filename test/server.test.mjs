import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect as connectTCP } from 'node:net';
import WebSocket from 'ws';
import { createApp, fingerprint } from '../server.mjs';
import { makeSecret, importSecret, encrypt, decrypt, validateManifest } from '../public/protocol.js';

async function setup(t) {
  const app = createApp({ origin: 'https://meatproxy.to' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/socket`;
  const connect = async () => { const ws = new WebSocket(url, { origin: 'https://meatproxy.to' }); await once(ws, 'open'); return ws; };
  return { app, connect, url };
}
const message = async ws => JSON.parse((await once(ws, 'message'))[0].toString());
async function create(connect) { const owner = await connect(); const response = message(owner); owner.send(JSON.stringify({ type: 'create' })); return { owner, room: (await response).room }; }
async function publish(owner, preview) {
  const processed = once(owner, 'pong');
  owner.send(JSON.stringify({ type: 'preview', ...preview })); owner.ping(); await processed;
}

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

test('modules import each other, and start the worker, at the exact URLs the page preloads', async t => {
  const { app } = await setup(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const html = await fetch(base + '/').then(response => response.text());
  const urls = Object.fromEntries(pageReferences(html).map(reference => [reference.split('?')[0], reference]));
  // A reference the fingerprinting misses would load a second copy of a module with separate state.
  const unversioned = /[`'"](?:\.{1,2}\/)*\/?(?:app|protocol|transfer|file-tasks|handoff|file-worker)\.js(?!\?v=[0-9a-f]{12})/;
  const workerURL = (await fetch(base + urls['/file-tasks.js']).then(response => response.text())).match(/'(\/file-worker\.js\?v=[0-9a-f]{12})'/)[1];
  for (const url of ['/', urls['/app.js'], urls['/protocol.js'], urls['/transfer.js'], urls['/file-tasks.js'], urls['/handoff.js'], workerURL]) {
    assert.doesNotMatch(await fetch(base + url).then(response => response.text()), unversioned, `${url} refers to every module by its version`);
  }
  for (const [module, dependencies] of [['/app.js', ['/file-tasks.js', '/handoff.js', '/protocol.js', '/transfer.js']], ['/transfer.js', ['/protocol.js']], ['/handoff.js', ['/protocol.js']], ['/file-tasks.js', ['/file-worker.js']]]) {
    const source = await fetch(base + urls[module]).then(response => response.text());
    const found = [...source.matchAll(/'\.?(\/[\w.-]+\.js)(\?v=[0-9a-f]{12})?'/g)];
    assert.deepEqual(found.map(match => match[1]).sort(), dependencies, `${module} references`);
    for (const [, path, query] of found) {
      assert.ok(query, `${module} references a versioned ${path}`);
      // One URL per module keeps a single shared instance of each module.
      if (urls[path]) assert.equal(path + query, urls[path], `${module} imports the preloaded ${path}`);
      else assert.equal(version(Buffer.from(await fetch(base + path + query).then(response => response.arrayBuffer()))), query.slice(3), `${path} names its exact bytes`);
    }
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

test('a public origin that is not a URL stops the service at startup, not on the first recipient link', () => {
  assert.throws(() => createApp({ origin: 'meatproxy.to' }), /Invalid URL/);
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

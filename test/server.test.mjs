import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { createApp } from '../server.mjs';
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
  assert.throws(() => validateManifest([{ ...file, size: 257 * 1024 * 1024 }]));
  assert.throws(() => validateManifest([{ ...file, size: -1 }]));
  assert.throws(() => validateManifest([], [file]));
  assert.throws(() => validateManifest([{ ...file, size: 2 }], [file]));
  assert.equal(validateManifest([{ ...file, size: 0 }]).length, 1);
});

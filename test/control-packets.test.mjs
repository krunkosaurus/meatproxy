import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { CHUNK_BYTES, encodeJSON, encodeControl, ControlReader, makeSecret, importSecret, encrypt, decrypt, validateManifest } from '../public/protocol.js';

test('previously supported ASCII manifests retain one legacy control packet above 16 KiB', () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ id: crypto.randomUUID(), name: 'x'.repeat(200) + index + '.txt', size: 0, sha256: '0'.repeat(64) }));
  validateManifest(files);
  const message = { type: 'manifest', files }, parts = encodeControl(message);
  assert.ok(encodeJSON(message).length > CHUNK_BYTES);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 0);
  assert.deepEqual(new ControlReader().read(0, parts[0].bytes), message);
});

test('control fragmentation starts only after the encrypted packet exceeds the legacy 64 KiB limit', async () => {
  const files = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), name: 'x'.repeat(500) + '界'.repeat(12), size: 0, sha256: '0'.repeat(64) }));
  const message = { type: 'manifest', files };
  let excess = encodeJSON(message).length - (64 * 1024 - 33);
  for (const file of files) {
    const removed = Math.min(excess, 500);
    file.name = file.name.slice(removed); excess -= removed;
    if (!excess) break;
  }
  validateManifest(files);
  assert.equal(encodeJSON(message).length, 64 * 1024 - 33);
  const [legacy] = encodeControl(message);
  assert.equal(encodeControl(message).length, 1);
  assert.equal(legacy.type, 0);
  const packet = new Uint8Array(5 + legacy.bytes.length); packet.set(legacy.bytes, 5);
  const key = await importSecret(makeSecret());
  assert.equal((await encrypt(key, packet, 'legacy-boundary')).length, 64 * 1024);

  files.find(file => file.name.length < 512).name += 'x';
  validateManifest(files);
  assert.equal(encodeJSON(message).length, 64 * 1024 - 32);
  const fragmented = encodeControl(message), reader = new ControlReader();
  assert.ok(fragmented.length > 1);
  let result;
  for (const part of fragmented) {
    assert.ok(part.bytes.length + 33 <= CHUNK_BYTES + 33);
    result = reader.read(part.type, part.bytes);
  }
  assert.deepEqual(result, message);
});

test('control packets keep a worst-case valid manifest below either transport limit and preserve UTF-8 across parts', async () => {
  const files = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), name: '\u0001'.repeat(256) + '界'.repeat(256), size: 0, sha256: '0'.repeat(64) }));
  validateManifest(files);
  const message = { type: 'manifest', files }, parts = encodeControl(message);
  assert.ok(encodeJSON(message).length > 64 * 1024);
  assert.ok(parts.length > 1);
  const key = await importSecret(makeSecret()), reader = new ControlReader();
  let result;
  for (const [sequence, part] of parts.entries()) {
    const plain = new Uint8Array(5 + part.bytes.length);
    new DataView(plain.buffer).setUint32(0, sequence); plain[4] = part.type; plain.set(part.bytes, 5);
    const encrypted = await encrypt(key, plain, 'manifest-test');
    assert.ok(encrypted.length <= CHUNK_BYTES + 33);
    const decrypted = await decrypt(key, encrypted, 'manifest-test');
    assert.equal(new DataView(decrypted.buffer).getUint32(0), sequence);
    result = reader.read(decrypted[4], decrypted.subarray(5));
    if (sequence < parts.length - 1) assert.equal(result, undefined);
  }
  assert.deepEqual(result, message);
  assert.deepEqual(reader.read(0, encodeJSON({ type: 'complete' })), { type: 'complete' });
  assert.equal(reader.read(1, new Uint8Array(CHUNK_BYTES)), undefined);
});

test('fragmented controls reject unbounded content and data interleaved before the final part', () => {
  const reader = new ControlReader();
  reader.read(2, encodeJSON({ type: 'manifest', files: [] }));
  assert.throws(() => reader.read(1, new Uint8Array()), /interrupted a control message/);
  const oversized = new ControlReader();
  assert.throws(() => { for (let i = 0; i < 100; i++) oversized.read(2, new Uint8Array(CHUNK_BYTES)); }, /control message is too large/);
});

async function page(t, url) {
  const worker = new Worker(new URL('./app-fixture.mjs', import.meta.url), { workerData: { url } });
  t.after(() => worker.terminate());
  const pending = new Map(); let sequence = 0;
  await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.ready) { resolve(); return; }
      const task = pending.get(message.id); pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
    });
  });
  const run = (command, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, command, ...args });
  });
  return { run, until: async predicate => {
    let snapshot;
    for (let attempt = 0; attempt < 500; attempt++) {
      snapshot = await run('snapshot');
      if (predicate(snapshot)) return snapshot;
      if (snapshot.notice) throw new Error(snapshot.notice);
      await delay(20);
    }
    assert.fail(`Timed out: ${JSON.stringify(snapshot)}`);
  } };
}

test('100 long Unicode filenames transfer through the real relay to a browser and the standalone receiver', { timeout: 30000 }, async t => {
  const app = createApp({ log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const temporary = await mkdtemp(join(tmpdir(), 'meatproxy-manifest-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sender = await page(t, `http://127.0.0.1:${app.server.address().port}/`);
  const names = Array.from({ length: 100 }, (_, index) => '界'.repeat(200) + index + '.txt');
  await sender.run('add', { files: names.map(name => ({ name, size: 1 })) });
  const ready = await sender.until(snapshot => snapshot.rows.length === 100 && snapshot.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(snapshot => snapshot.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  const received = await receiver.until(snapshot => snapshot.status === 'All files received');
  assert.deepEqual(received.rows.map(file => file.name), names);
  assert.ok(received.rows.every(file => file.detail.includes('verified')));
  await receiver.run('click', { element: 'download-all' });
  const [archive] = await receiver.run('downloads');
  assert.equal(archive.entries.length, 100);
  const expectedHash = createHash('sha256').update(new Uint8Array([71])).digest('hex');
  assert.ok(archive.entries.every(entry => entry.sha256 === expectedHash));
  await receiver.run('leave');
  await sender.until(snapshot => snapshot.status === 'The recipient has left.');
  const cli = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), ready.link, temporary]);
  t.after(() => { if (cli.exitCode === null) cli.kill(); });
  let output = '';
  cli.stdout.on('data', data => { output += data; });
  cli.stderr.on('data', data => { output += data; });
  const [code] = await once(cli, 'exit');
  assert.equal(code, 0, output);
  const saved = await readdir(temporary);
  assert.equal(saved.length, 100);
  for (const name of saved) assert.equal(createHash('sha256').update(await readFile(join(temporary, name))).digest('hex'), expectedHash);
  await sender.until(snapshot => snapshot.status === 'The recipient has left.');
});

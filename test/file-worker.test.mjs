import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

test('shipped worker handles hashing, transferred receive blocks, corruption, cleanup and ZIP jobs', { timeout: 10000 }, async () => {
  const moduleURL = new URL('../public/file-worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    import(${JSON.stringify(moduleURL)}).then(() => parentPort.on('message', data => self.onmessage({ data })));
  `, { eval: true });
  let sequence = 0;
  const pending = new Map();
  worker.on('message', message => {
    if ('progress' in message) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error)); else resolve(message.result);
  });
  const run = (type, payload, transfer = []) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
  try {
    const bytes = Uint8Array.from({ length: 256 * 1024 + 1 }, (_, i) => i % 211);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await run('hash', { file: new Blob([bytes]) }), sha256);
    await run('begin', { token: 'good', meta: { size: bytes.length, sha256 } });
    for (const part of [bytes.slice(0, -1), bytes.slice(-1)]) {
      await run('append', { token: 'good', bytes: part }, [part.buffer]);
      assert.equal(part.byteLength, 0, 'Receive block ownership transfers to the worker');
    }
    const result = await run('finish', { token: 'good' });
    assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
    await run('begin', { token: 'bad', meta: { size: bytes.length, sha256 } });
    await run('append', { token: 'bad', bytes: new Uint8Array(bytes.length) });
    await assert.rejects(run('finish', { token: 'bad' }), /verification failed/);
    await run('abort', { token: 'bad' });
    const zip = await run('zip', { items: [{ name: 'payload.bin', blob: result.blob }] });
    assert.equal(zip.type, 'application/zip');
    assert.ok(zip.size > bytes.length);
  } finally { await worker.terminate(); }
});

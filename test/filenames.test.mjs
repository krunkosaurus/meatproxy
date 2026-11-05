import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { safeName, uniqueName } from '../public/filenames.js';
import { createApp } from '../server.mjs';

test('portable save names retain extensions and full Unicode characters as collision numbers grow', () => {
  for (const name of ['x'.repeat(251) + '.txt', '界'.repeat(83) + 'ab.txt', '🙂'.repeat(62) + 'abc.txt']) {
    const used = new Set();
    const saved = Array.from({ length: 12 }, () => uniqueName(name, used));
    assert.equal(saved[0], name, 'The original valid name is retained when available');
    assert.equal(new Set(saved).size, saved.length);
    assert.ok(saved.every(value => Buffer.byteLength(value) <= 255 && value.endsWith('.txt')));
    assert.ok(saved.every(value => !value.includes('\ufffd')));
  }
  assert.equal(safeName('../notes.txt'), '__notes.txt');
  assert.equal(safeName('short.txt', 2), '2-short.txt');
  const oversized = safeName('界'.repeat(200) + '.md');
  assert.ok(Buffer.byteLength(oversized) <= 255 && oversized.endsWith('.md'));
  assert.ok(Buffer.byteLength(safeName('🙂.' + 'a'.repeat(250), 2)) <= 255, 'An extension too long to retain still produces a valid name');
});

async function senderPage(t, url, files) {
  const worker = new Worker(new URL('./app-fixture.mjs', import.meta.url), { workerData: { url } });
  t.after(() => worker.terminate());
  let sequence = 0;
  const pending = new Map();
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
  await run('add', { files });
  for (let attempt = 0; attempt < 500; attempt++) {
    const snapshot = await run('snapshot');
    if (snapshot.rows.length === files.length && snapshot.link.startsWith('http')) return snapshot.link;
    if (snapshot.notice) throw new Error(snapshot.notice);
    await delay(10);
  }
  assert.fail('Sender did not finish preparing the filename test files');
}

test('the standalone receiver can repeatedly save maximum-length filenames on the real filesystem', { timeout: 15000 }, async t => {
  const app = createApp({ log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const files = ['x'.repeat(251) + '.txt', '界'.repeat(83) + 'ab.txt', '🙂'.repeat(62) + 'abc.txt'].map((name, index) => ({ name, size: 7, byte: 65 + index }));
  const link = await senderPage(t, `http://127.0.0.1:${app.server.address().port}/`, files);
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-filenames-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  for (let run = 0; run < 3; run++) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), link, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, output);
  }
  const names = await readdir(destination);
  assert.equal(names.length, files.length * 3, 'Every run saves new files beside the previous verified copies');
  for (const file of files) {
    for (let number = 1; number <= 3; number++) {
      const name = safeName(file.name, number);
      assert.ok(Buffer.byteLength(name) <= 255);
      assert.deepEqual(await readFile(join(destination, name)), Buffer.alloc(file.size, file.byte));
    }
  }
});

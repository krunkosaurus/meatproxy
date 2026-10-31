import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

async function page(t, url, options = {}) {
  const worker = new Worker(new URL('./app-fixture.mjs', import.meta.url), { workerData: { url, ...options } });
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
  return { run, until: async predicate => {
    let snapshot;
    for (let attempt = 0; attempt < 300; attempt++) {
      snapshot = await run('snapshot');
      if (predicate(snapshot)) return snapshot;
      if (snapshot.notice) throw new Error(snapshot.notice);
      await delay(20);
    }
    assert.fail(`Timed out: ${JSON.stringify(snapshot)}`);
  } };
}

async function server(t) {
  const app = createApp();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  return `http://127.0.0.1:${app.server.address().port}/`;
}

test('actual composer removes files, edits/cancels notes and updates capacity', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.until(s => s.link.startsWith('http'));
  await sender.run('note', { text: 'Original note' });
  await sender.until(s => s.rows.length === 1);
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, 'Original note');
  await sender.run('note', { text: 'Revised note' });
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, 'Revised note');
  await sender.run('click', { element: 'cancel-note' });
  await sender.run('add', { files: [{ name: 'remove.bin', size: 5 }] });
  await sender.until(s => s.rows.length === 2);
  await sender.run('click', { label: 'Remove remove.bin' });
  const state = await sender.run('snapshot');
  assert.equal(state.rows.length, 1);
  assert.match(state.summary, /1 \/ 100 files/);
  assert.equal(state.mobile.action, 'copy');
  await sender.run('click', { label: 'Remove HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).rows.length, 0);
});

test('actual browser relay locks announced files, queues additions before completion, verifies and saves intact bytes', { timeout: 20000 }, async t => {
  const payloadBytes = 6 * 1024 * 1024; // Larger than the 4 MiB window, so the sender waits for ACKs.
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'payload.bin', size: payloadBytes }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { receiveDelay: 30 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await sender.until(s => s.rows[0].detail.includes('Sending'));
  await assert.rejects(sender.run('click', { label: 'Remove payload.bin' }), /unavailable/);
  await sender.run('note', { text: 'Queued while sending' });
  await receiver.until(s => s.status === 'All files received' && s.rows.length === 2);
  await sender.until(s => s.status === 'All files sent');
  await receiver.run('click', { element: 'copy-agent' });
  assert.match((await receiver.run('snapshot')).clipboard, /Queued while sending/);
  await receiver.run('click', { element: 'download-all' });
  const downloads = await receiver.run('downloads');
  assert.equal(downloads[0].name, 'meatproxy-handoff.zip');
  assert.ok(downloads[0].size > payloadBytes);
  assert.deepEqual(downloads[0].entries, [
    { name: 'payload.bin', sha256: createHash('sha256').update(new Uint8Array(payloadBytes).fill(71)).digest('hex') },
    { name: 'HANDOFF.md', sha256: createHash('sha256').update('Queued while sending\n').digest('hex') },
  ]);
  await receiver.run('click', { label: 'Save payload.bin' });
  assert.equal((await receiver.run('downloads'))[1].sha256, downloads[0].entries[0].sha256);
  assert.equal((await receiver.run('snapshot')).mobile.action, 'save');
});

test('Node receiver stays connected while a queued addition is still being hashed', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t), { hashDelay: 700 });
  await sender.run('add', { files: [{ name: 'first.bin', size: 8 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-queued-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), ready.link, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  await sender.until(s => s.rows[0].detail.includes('Sending'));
  await sender.run('note', { text: 'Prepared after the first file finished' });
  assert.equal(await exit, 0, output);
  assert.equal(await readFile(join(destination, 'HANDOFF.md'), 'utf8'), 'Prepared after the first file finished\n');
  assert.equal(createHash('sha256').update(await readFile(join(destination, 'first.bin'))).digest('hex'), createHash('sha256').update(new Uint8Array(8 * 1024 * 1024).fill(71)).digest('hex'));
});

test('an open note edit is held back on join, then its revised contents are delivered', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('note', { text: 'Unfinished draft' });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await sender.until(s => s.status === 'Finish editing your note');
  assert.equal((await receiver.run('snapshot')).rows.length, 0);
  await sender.run('note', { text: 'Finished draft' });
  await receiver.until(s => s.status === 'All files received');
  await receiver.run('click', { element: 'copy-agent' });
  assert.equal((await receiver.run('snapshot')).clipboard, '# HANDOFF.md\n\nFinished draft\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTCP } from 'node:net';
import { WebSocketServer } from 'ws';
import { createApp } from '../server.mjs';
import { makeSecret, importSecret, encrypt, encodeJSON, toBase64 } from '../public/protocol.js';
import { terminalTable, collapsedTerminalNote, restoredTerminalNote, pastedTerminalBullets, alignedTerminalBullets, pastedPageHtml, pastedPageText, pastedPageNote, copiedMarkdown, copiedMarkdownHtml, copiedMarkdownNote } from './note-formatting-fixture.mjs';

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

async function server(t, options) {
  const app = createApp(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  return `http://127.0.0.1:${app.server.address().port}/`;
}

test('idle and invalid composer selections use no sockets; first prepared content creates one room', { timeout: 15000 }, async t => {
  const app = createApp({ maxClients: 1, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/`;
  const sender = await page(t, base, { hashDelay: 200 }), other = await page(t, base);
  const idle = await sender.run('snapshot');
  assert.equal(idle.socketCount, 0);
  assert.equal(idle.copyDisabled, true);
  assert.equal(idle.commandDisabled, true);
  assert.equal(app.wss.clients.size, 0);
  assert.equal(app.rooms.size, 0);
  await sender.run('previewNames', { enabled: true });
  await sender.run('note', { text: ' \n\t ' });
  await sender.run('add', { files: [] });
  await other.run('add', { files: Array.from({ length: 101 }, (_, i) => ({ name: `${i}.txt`, size: 0 })) });
  await other.until(s => s.feedback.includes('limit is 100'));
  assert.equal((await sender.run('snapshot')).socketCount, 0);
  assert.equal((await other.run('snapshot')).socketCount, 0);
  assert.equal(app.rooms.size, 0);

  await sender.run('add', { files: [{ name: 'first.txt', size: 0 }] });
  await sender.until(s => s.feedback.startsWith('Adding first.txt'));
  assert.equal((await sender.run('snapshot')).socketCount, 0, 'Hashing finishes before a connection is reserved');
  await sender.run('add', { files: [{ name: 'second.txt', size: 0 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  assert.equal(ready.socketCount, 1);
  assert.equal(ready.copyDisabled, false);
  assert.equal(ready.commandDisabled, false);
  assert.equal(app.wss.clients.size, 1);
  assert.equal(app.rooms.size, 1);
  for (let attempt = 0; attempt < 100 && ![...app.rooms.values()][0].preview.names.length; attempt++) await delay(10);
  assert.deepEqual([...app.rooms.values()][0].preview.names, ['first.txt'], 'Preview settings chosen before connection apply to the new room');

  await sender.run('add', { files: [{ name: 'first.txt', size: 0 }] });
  await sender.until(s => s.feedback.startsWith('Already added'));
  await sender.run('note', { text: 'Another item' });
  const added = await sender.until(s => s.rows.length === 2);
  assert.equal(added.socketCount, 1);
  assert.equal(added.link, ready.link);
  assert.equal(app.rooms.size, 1);
  assert.equal((await other.run('snapshot')).socketCount, 0, 'An unused homepage does not compete for the one socket slot');
});

test('adding and editing a note retains indentation and trailing whitespace through verified delivery', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  const original = '    const first = 1;\n    const second = 2;  \n\n';
  await sender.run('note', { text: original });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, original);
  await sender.run('click', { element: 'cancel-note' });
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, original);
  const edited = '\n  - parent\n    continuation  \n\n';
  await sender.run('note', { text: edited });
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, edited);
  await sender.run('click', { element: 'cancel-note' });

  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'All files received');
  await receiver.run('click', { element: 'copy-agent' });
  assert.equal((await receiver.run('snapshot')).clipboard, `# HANDOFF.md\n\n${edited}\n`);
  await receiver.run('click', { element: 'download-all' });
  const [download] = await receiver.run('downloads');
  assert.equal(download.sha256, createHash('sha256').update(edited + '\n').digest('hex'));
});

test('actual paste restores a boxed table in the editor and delivers its row breaks intact', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('paste', { text: collapsedTerminalNote, enabled: false });
  assert.equal((await sender.run('snapshot')).note, collapsedTerminalNote, 'Unchecked formatting uses the original paste');
  await sender.run('paste', { text: terminalTable.replaceAll('\n', ' '), initial: 'Before\nreplace\nAfter', start: 7, end: 14 });
  assert.equal((await sender.run('snapshot')).note, 'Before\n' + terminalTable + '\nAfter', 'Cleanup replaces only the selected text');
  await sender.run('paste', { text: collapsedTerminalNote });
  assert.equal((await sender.run('snapshot')).note, restoredTerminalNote);
  await sender.run('click', { element: 'add-note' });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'All files received');
  await receiver.run('click', { element: 'copy-agent' });
  assert.equal((await receiver.run('snapshot')).clipboard, '# HANDOFF.md\n\n' + restoredTerminalNote + '\n');
  await receiver.run('click', { element: 'download-all' });
  const [download] = await receiver.run('downloads');
  assert.equal(download.sha256, createHash('sha256').update(restoredTerminalNote + '\n').digest('hex'));
});

test('actual paste left-aligns terminal bullet items and keeps them aligned when editing the saved note', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('paste', { text: '  • Just one item' });
  assert.equal((await sender.run('snapshot')).note, '• Just one item');
  await sender.run('paste', { text: pastedTerminalBullets });
  assert.equal((await sender.run('snapshot')).note, alignedTerminalBullets);
  await sender.run('click', { element: 'add-note' });
  await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, alignedTerminalBullets);
});

test('actual paste rebuilds a copied page from its HTML and keeps the result when editing the saved note', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('paste', { text: pastedPageText, html: pastedPageHtml, enabled: false });
  assert.equal((await sender.run('snapshot')).note, pastedPageText, 'Unchecked formatting uses the original paste');
  const styledBullets = `<div style="white-space: pre"><span>${pastedTerminalBullets}</span></div>`;
  await sender.run('paste', { text: pastedTerminalBullets, html: styledBullets });
  assert.equal((await sender.run('snapshot')).note, alignedTerminalBullets, 'HTML without lists or tables keeps the text cleanup');
  await sender.run('paste', { text: pastedPageText, html: pastedPageHtml });
  assert.equal((await sender.run('snapshot')).note, pastedPageNote);
  await sender.run('click', { element: 'add-note' });
  await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  await sender.run('click', { label: 'Edit HANDOFF.md' });
  assert.equal((await sender.run('snapshot')).note, pastedPageNote);
});

test('actual paste keeps a copy button\'s Markdown, and its records survive being copied and pasted again', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('paste', { text: copiedMarkdown, html: copiedMarkdownHtml });
  assert.equal((await sender.run('snapshot')).note, copiedMarkdownNote);
  await sender.run('paste', { text: copiedMarkdownNote, initial: copiedMarkdownNote, start: 0, end: copiedMarkdownNote.length });
  assert.equal((await sender.run('snapshot')).note, copiedMarkdownNote, 'Moving converted text within the note leaves it as it is');
  await sender.run('click', { element: 'add-note' });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'All files received');
  await receiver.run('click', { element: 'copy-agent' });
  const copied = (await receiver.run('snapshot')).clipboard;
  assert.equal(copied, `# HANDOFF.md\n\n${copiedMarkdownNote}\n`);
  const forward = await page(t, await server(t));
  await forward.run('paste', { text: copied });
  assert.equal((await forward.run('snapshot')).note, copied, 'Forwarding the copied notes keeps each record intact');
});

test('the page opens on the Note tab, and dragging files in shows the Files drop area', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
  let state = await sender.run('snapshot');
  assert.deepEqual([state.tab, state.notePanel, state.filesPanel], ['note-tab', true, false]);
  await sender.run('drag', { types: ['text/plain'] });
  state = await sender.run('snapshot');
  assert.equal(state.tab, 'note-tab', 'Dragging text keeps the note editor open');
  await sender.run('drag', { types: ['Files'] });
  state = await sender.run('snapshot');
  assert.deepEqual([state.tab, state.notePanel, state.filesPanel], ['files-tab', false, true]);
});

test('actual composer removes files, edits/cancels notes and updates capacity', { timeout: 15000 }, async t => {
  const sender = await page(t, await server(t));
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

// Unlike until(), keeps polling while the page shows a notice.
async function poll(page, predicate) {
  let snapshot;
  for (let attempt = 0; attempt < 300; attempt++) { snapshot = await page.run('snapshot'); if (predicate(snapshot)) return snapshot; await delay(20); }
  assert.fail(`Timed out: ${JSON.stringify(snapshot)}`);
}
const silence = 'The sender has not sent anything for a minute.';
// Data already received still counts as progress while it is processed, so keep moving the clock.
async function waitOutSilence(receiver) {
  let snapshot = await receiver.run('snapshot');
  for (let attempt = 0; attempt < 20 && !snapshot.notice; attempt++) {
    await receiver.run('advance', { ms: 61_000 }); await delay(500); snapshot = await receiver.run('snapshot');
  }
  return snapshot;
}

test('a receiver says when the sender goes silent mid-file, offers to reconnect, and carries on if it resumes', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'payload.bin', size: 32 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { receiveDelay: 40 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'Receiving payload.bin');
  await sender.run('stall');
  const stalled = await waitOutSilence(receiver);
  assert.match(stalled.notice, new RegExp(`^${silence} .*save the files you have and reconnect to start over`));
  assert.equal(stalled.mobile.action, 'retry');
  await sender.run('resume'); // Data arriving again, as after a slow file read, clears the warning.
  const done = await poll(receiver, s => s.status === 'All files received');
  assert.equal(done.notice, '');
});

test('a receiver notices a sender that gives up after a file while more files remain', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'a.bin', size: 1024 * 1024 }, { name: 'b.bin', size: 1024 * 1024, byte: 72 }] });
  const ready = await sender.until(s => s.rows.length === 2 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { finishDelay: 1000 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.finishing); // Saving a.bin; the sender then goes quiet before b.bin.
  await sender.run('stall');
  await poll(receiver, s => s.rows.some(row => row.name === 'a.bin' && row.detail.includes('verified')));
  assert.match((await waitOutSilence(receiver)).notice, new RegExp(`^${silence}`));
  await sender.run('resume');
  assert.equal((await poll(receiver, s => s.status === 'All files received')).notice, '');
});

test('when the sender leaves after the warning, the warning and Reconnect go away', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'payload.bin', size: 32 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { receiveDelay: 40 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'Receiving payload.bin');
  await sender.run('stall');
  assert.equal((await waitOutSilence(receiver)).mobile.action, 'retry');
  await sender.run('leave');
  const left = await poll(receiver, s => s.status === 'The sender has left.');
  assert.equal(left.notice, '');
  assert.notEqual(left.mobile.action, 'retry', 'Reconnecting needs a sender');
});

test('data arriving again clears only the silence warning, not a later notice', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('note', { text: 'Read me first' });
  await sender.run('add', { files: [{ name: 'payload.bin', size: 32 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 2 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { receiveDelay: 40 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'Receiving payload.bin');
  await sender.run('stall');
  await waitOutSilence(receiver);
  await receiver.run('blockClipboard');
  await receiver.run('click', { element: 'copy-agent' }); // Another notice replaces the warning.
  await sender.run('resume');
  const done = await poll(receiver, s => s.status === 'All files received');
  assert.match(done.notice, /^Clipboard access was blocked/);
});

test('when the receiver loses its connection after the warning, the warning goes and Reconnect stays', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'payload.bin', size: 32 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { receiveDelay: 40 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.status === 'Receiving payload.bin');
  await sender.run('stall');
  await waitOutSilence(receiver);
  await receiver.run('leave');
  const closed = await poll(receiver, s => s.status === 'Connection closed');
  assert.equal(closed.notice, '');
  assert.equal(closed.mobile.action, 'retry');
});

test('a receiver whose sender never confirms the last file offers to save instead of waiting', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'a.bin', size: 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { finishDelay: 1000 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.finishing);
  await sender.run('stall'); // The sender's completion message never leaves.
  const saved = await receiver.until(s => s.status === 'Files received');
  assert.equal(saved.mobile.action, 'save');
  assert.equal(saved.notice, '');
});

test('a receiver waits quietly while it saves a file or the sender prepares the next one', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t), { hashDelay: 3000 });
  await sender.run('add', { files: [{ name: 'first.bin', size: 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link, { finishDelay: 1500 });
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.finishing); // Every byte of first.bin is in; the receiver is saving it.
  await receiver.run('advance', { ms: 61_000 });
  await sender.run('add', { files: [{ name: 'second.bin', size: 1024 * 1024, byte: 72 }] });
  await receiver.until(s => s.rows.some(row => row.name === 'first.bin' && row.detail.includes('verified')));
  assert.match((await sender.run('snapshot')).feedback, /^Adding second\.bin/, 'The sender is still preparing second.bin');
  await receiver.run('advance', { ms: 61_000 });
  await delay(600);
  assert.equal((await receiver.run('snapshot')).notice, '', 'No warning while the sender prepares the next file');
  await receiver.until(s => s.status === 'All files received' && s.rows.length === 2);
});

test('when a relay limit closes the sender, both pages and the Node receiver say why', { timeout: 20000 }, async t => {
  const link = await server(t, { limits: { toReceiver: 300_000 } });
  const sender = await page(t, link);
  await sender.run('add', { files: [{ name: 'payload.bin', size: 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  let snapshot;
  for (let attempt = 0; attempt < 300 && snapshot?.status !== 'Connection closed'; attempt++) { await delay(20); snapshot = await sender.run('snapshot'); }
  assert.equal(snapshot.status, 'Connection closed');
  assert.equal(snapshot.detail, 'This connection sent more than a handoff allows.');
  const told = await receiver.until(s => s.status === 'The sender has left.');
  assert.equal(told.detail, "The sender's connection sent more than a handoff allows. Ask the sender for a fresh link.");
  // The downloadable receiver always uses the relay.
  const agentSender = await page(t, link);
  await agentSender.run('add', { files: [{ name: 'payload.bin', size: 1024 * 1024 }] });
  const agentReady = await agentSender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-limit-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), agentReady.link, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 1);
  assert.match(output, /The relay closed the sender's connection: Relay limit reached for this handoff\./);
});

test('the Node receiver reports why the sender left while it is still handling earlier messages', { timeout: 20000 }, async t => {
  // A stand-in relay sends a backlog, then the reason, and closes at once.
  const secret = makeSecret(), key = await importSecret(secret), room = 'A'.repeat(22);
  const backlog = await Promise.all(Array.from({ length: 200 }, async () => JSON.stringify({ type: 'signal', payload: toBase64(await encrypt(key, encodeJSON({ type: 'candidate' }), `signal:${room}`)) })));
  const http = createServer(), relay = new WebSocketServer({ server: http, path: '/socket' });
  relay.on('connection', socket => socket.once('message', () => {
    socket.send(JSON.stringify({ type: 'joined' }));
    for (const message of backlog) socket.send(message);
    socket.send(JSON.stringify({ type: 'sender-left', code: 4001, reason: 'Relay limit reached for this handoff' }));
    socket.close(1000, 'Sender left');
  }));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { relay.close(); http.close(); });
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-left-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), `http://127.0.0.1:${http.address().port}/s/${room}#${secret}`, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 1);
  assert.match(output, /The relay closed the sender's connection: Relay limit reached for this handoff\./);
});

test('when a link has used its relay allowance, each page says what to do instead of offering Reconnect', { timeout: 20000 }, async t => {
  const sender = await page(t, await server(t, { limits: { room: 1 } }));
  await sender.run('add', { files: [{ name: 'payload.bin', size: 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  const refused = await receiver.until(s => s.status === 'Connection closed');
  assert.equal(refused.detail, 'This link has used its relay allowance. Ask the sender for a fresh link.');
  assert.equal(refused.retry, false); assert.notEqual(refused.mobile.action, 'retry');
  const left = await sender.until(s => s.status === 'The recipient has left.');
  assert.equal(left.detail, 'This link has used its relay allowance. Start a new handoff to make a fresh link.');
});

test('a relay limit reached partway keeps received files and says to save them instead of offering Reconnect', { timeout: 20000 }, async t => {
  // Four 256 KiB slices a day. a.bin fits; b.bin, added later, runs out partway.
  const sender = await page(t, await server(t, { limits: { slice: 256 * 1024, daily: 1024 * 1024 } }));
  await sender.run('add', { files: [{ name: 'a.bin', size: 300_000 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const receiver = await page(t, ready.link);
  await receiver.until(s => s.status === 'Sender online');
  await receiver.run('click', { element: 'accept-files' });
  await receiver.until(s => s.rows.some(row => row.name === 'a.bin' && row.detail.includes('verified')));
  await sender.run('add', { files: [{ name: 'b.bin', size: 3 * 1024 * 1024, byte: 72 }] });
  const stopped = await receiver.until(s => s.status === 'Connection closed');
  assert.equal(stopped.detail, "The relay has reached today's limit. Try again after 00:00 UTC. Save the files you have received.");
  assert.deepEqual(stopped.rows.map(row => row.detail.split(' · ').pop()), ['verified', 'Interrupted']);
  assert.equal(stopped.retry, false, 'Reconnecting would clear a.bin and be refused again');
  assert.equal(stopped.mobile.action, 'save');
  const left = await sender.until(s => s.status === 'The recipient has left.');
  assert.match(left.detail, /^The relay has reached today's limit, so this recipient could not connect\. Recipients who can connect directly are not affected\./);
});

test('the Node receiver can run again into the same folder, including after an interrupted run', { timeout: 30000 }, async t => {
  const sender = await page(t, await server(t));
  await sender.run('add', { files: [{ name: 'one.bin', size: 32 * 1024 * 1024 }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-rerun-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const run = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), ready.link, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    return { child, exit: new Promise(resolve => child.on('exit', code => resolve({ code, output }))) };
  };
  const expected = createHash('sha256').update(new Uint8Array(32 * 1024 * 1024).fill(71)).digest('hex');
  const hash = async name => createHash('sha256').update(await readFile(join(destination, name))).digest('hex');
  assert.equal((await run().exit).code, 0);
  const again = await run().exit;
  assert.equal(again.code, 0, again.output);
  assert.equal(await hash('2-one.bin'), expected, 'A second run keeps the first file and saves beside it');
  // Interrupt a run once its partial file has data, then run again.
  const interrupted = run();
  for (let attempt = 0; attempt < 500; attempt++) {
    const partial = (await readdir(destination)).find(name => name.endsWith('.partial'));
    if (partial && (await stat(join(destination, partial))).size > 0) break;
    await delay(5);
  }
  interrupted.child.kill('SIGKILL'); await interrupted.exit;
  assert.ok((await readdir(destination)).some(name => name.endsWith('.partial')), 'The interrupted run left its partial file');
  const resumed = await run().exit;
  assert.equal(resumed.code, 0, resumed.output);
  assert.equal(await hash('3-one.bin'), expected);
  assert.deepEqual((await readdir(destination)).sort(), ['2-one.bin', '3-one.bin', 'one.bin']);
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

// In production, Nginx puts each client's address in X-Real-IP; this proxy stands in for it.
async function addressedProxy(t, upstream, address) {
  const target = new URL(upstream);
  const proxy = createServer((req, res) => {
    const forward = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-real-ip': address } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    req.pipe(forward);
  });
  proxy.on('upgrade', (req, socket, head) => {
    const upstreamSocket = connectTCP(target.port, target.hostname, () => {
      const headers = Object.entries({ ...req.headers, 'x-real-ip': address }).map(([name, value]) => `${name}: ${value}`).join('\r\n');
      upstreamSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`); upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstreamSocket.on('error', () => socket.destroy()); socket.on('error', () => upstreamSocket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  return `http://127.0.0.1:${proxy.address().port}/`;
}

test('a relayed handoff the work budget slows still arrives intact at the Node receiver', { timeout: 40000 }, async t => {
  const rate = 2 * 1024 * 1024, size = 12 * 1024 * 1024;
  const app = createApp({ maxWork: { address: rate, network: 4 * rate }, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = await addressedProxy(t, `http://127.0.0.1:${app.server.address().port}/`, '203.0.113.60');
  const sender = await page(t, base);
  await sender.run('add', { files: [{ name: 'budget.bin', size }] });
  const ready = await sender.until(s => s.rows.length === 1 && s.link.startsWith('http'));
  const destination = await mkdtemp(join(tmpdir(), 'meatproxy-budget-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const started = performance.now();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../public/receive.mjs', import.meta.url)), ready.link, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, output);
  assert.equal(createHash('sha256').update(await readFile(join(destination, 'budget.bin'))).digest('hex'), createHash('sha256').update(new Uint8Array(size).fill(71)).digest('hex'));
  // 12 MiB of chunks costs over 15 MiB of work; less the 4 MiB of credit, at 2 MiB/s that takes over 5.5 s.
  assert.ok(performance.now() - started >= 5_000, 'The budget slowed the transfer');
  assert.ok(app.summary().throttled >= 1);
});

import { MAX_BYTES, MAX_FILES, CHUNK_BYTES, makeSecret, importSecret, encrypt, decrypt, encodeJSON, decodeJSON, toBase64, fromBase64, validateManifest } from './protocol.js';
import { streamFile, TransferMeter, waitForDataChannel, createWaiters } from './transfer.js';
import { FileTasks } from './file-tasks.js';
import { prepareAdditions } from './handoff.js';

const $ = id => document.getElementById(id);
const isSender = location.pathname === '/';
const files = [];
const received = new Map();
const fileTasks = new FileTasks(), archiveTasks = new FileTasks();
const RECEIVE_BLOCK_BYTES = CHUNK_BYTES * 16;
let destinationParent, receiveFolder, folderNames = new Set(), saving = false;
let room = isSender ? '' : location.pathname.split('/')[2];
let secret = isSender ? makeSecret() : location.hash.slice(1);
let key, ws, peer, socketQueue = Promise.resolve(), preparing = false, ended = false;
let accepted = false, previewTimer;
let editingId = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
function status(title, detail, state = '') { $('status').textContent = title; $('status-detail').textContent = detail; $('status-dot').className = `status-dot ${state}`; updateMobileAction(); }
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
// The relay closes a connection with these codes when it reaches a limit. own: the reader's connection was closed.
function relayLimit(code, own) {
  const other = isSender ? 'The recipient' : 'The sender';
  return {
    4001: own ? 'This connection sent more than a handoff allows.' : `${other}'s connection sent more than a handoff allows.`,
    4002: `This link has used its relay allowance. ${isSender ? 'Start a new handoff to make a fresh link.' : 'Ask the sender for a fresh link.'}`,
    4003: own ? 'Your network has used its relay allowance for now. Try again later.' : `${other}'s network has used its relay allowance for now.`,
    4004: "The relay has reached today's limit. Try again after 00:00 UTC.",
    4005: 'Too many Meatproxy connections from your network. Close other Meatproxy tabs and try again.',
  }[code];
}
function packet(value) { if (ws?.readyState !== WebSocket.OPEN) throw new Error('The connection closed. Start a new handoff.'); ws.send(JSON.stringify(value)); }
function updateCommand() {
  $('agent-command').textContent = `node meatproxy-receive.mjs '${location.origin}/s/${room}#${secret}' ./handoff`;
  $('copy-command').disabled = false;
}
function publishPreview() {
  // Files can be selected before the room is created; created publishes them too.
  if (!room || ws?.readyState !== WebSocket.OPEN) return;
  packet({ type: 'preview', count: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0), names: $('preview-names').checked ? files.slice(0, 3).map(file => file.name.slice(0, 512)) : [] });
}
async function checkInvite() {
  let state;
  try {
    const response = await fetch(`/s/${room}/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not check the sender.');
    const preview = await response.json();
    if (accepted) return;
    state = preview.state;
    $('accept-files').disabled = state !== 'online';
    $('accept-files').hidden = state === 'offline';
    $('accept-folder').hidden = state === 'offline' || !window.showDirectoryPicker;
    $('accept-folder').disabled = state !== 'online';
    $('create-share').hidden = state !== 'offline';
    $('invite-help').textContent = state === 'offline' ? 'Start a new handoff with your own files.' : 'Receive from the sender’s browser. Both of you need to stay online.';
    $('invite-summary').textContent = state === 'offline' ? 'This link has expired.' : preview.count ? `${preview.count} ${preview.count === 1 ? 'file' : 'files'} · ${size(preview.totalBytes)}` : 'The sender is choosing files.';
    $('invite-names').textContent = preview.names.join(' · ') + (preview.names.length && preview.count > preview.names.length ? ` · + ${preview.count - preview.names.length} more` : '');
    $('invite-names').hidden = preview.names.length === 0;
    if (state === 'online') status('Sender online', 'Accept when you’re ready to receive.', 'active');
    else if (state === 'busy') status('Sender busy', 'Someone else is receiving. This page will update when it’s your turn.');
    else status('Sender offline', 'Ask the sender for a fresh link.');
  } catch {
    if (accepted) return;
    $('accept-files').disabled = true;
    $('accept-folder').disabled = true;
    status('Checking the sender…', 'Could not reach Meatproxy. Trying again shortly.');
  }
  if (state !== 'offline') previewTimer = setTimeout(checkInvite, 10_000);
}
function startProgress(p) {
  p.meter = new TransferMeter(p.done); p.progressActive = true; progress(p);
}
function progress(p, finished = false) {
  const { done, total } = p;
  $('progress').hidden = total === 0; $('progress').value = total ? done / total * 100 : 0;
  $('transfer-meta').textContent = total ? `${size(done)} of ${size(total)} · ${p.transport === 'direct' ? 'Direct connection' : 'Encrypted relay'}` : '';
  $('transfer-speed').hidden = total === 0;
  const stats = p.meter.update(done, total);
  const eta = stats.remaining < 60 ? `${stats.remaining} s` : stats.remaining < 3600 ? `${Math.ceil(stats.remaining / 60)} min` : `${Math.ceil(stats.remaining / 3600)} hr`;
  $('transfer-speed').textContent = finished ? `${size(stats.average)}/s average · Complete` : done === total ? 'Verifying files…' : stats.rate === null ? 'Estimating speed and time…' : stats.rate === 0 ? '0 B/s · Waiting for data…' : `${size(stats.rate)}/s · About ${eta} left`;
  if (finished) p.progressActive = false;
  updateMobileAction();
}
setInterval(() => { if (peer?.progressActive && !peer.closed && !peer.failed) progress(peer); }, 500);
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  notice(message); status('The handoff paused', message, 'error');
  if (peer) { peer.failed = true; peer.waiters.rejectAll(new Error(message)); }
  abortIncoming(peer);
  $('retry').hidden = isSender || !accepted;
  updateMobileAction();
}
function updateMobileAction() {
  const bar = $('mobile-actions'), button = $('mobile-action');
  bar.hidden = isSender && !files.length && !preparing;
  let action, label, hint = $('keep-open-text').textContent, disabled = false;
  let summary = $('status').textContent, amount = '';
  const active = peer?.progressActive && !peer.closed && !peer.failed && peer.total > 0;
  $('mobile-progress').hidden = !active;
  if (active) {
    $('mobile-progress').value = $('progress').value;
    label = isSender ? 'Sending…' : 'Receiving…'; disabled = true;
    summary = $('transfer-speed').textContent;
    amount = `${size(peer.done)} / ${size(peer.total)}`;
  } else if (isSender && peer?.failed && !peer.closed) {
    label = 'Transfer paused'; disabled = true; hint = 'Ask the recipient to reconnect.';
  } else if (isSender) {
    action = navigator.share ? 'share' : 'copy';
    label = preparing ? 'Adding files…' : navigator.share ? 'Share link ↗' : 'Copy link ↗';
    disabled = preparing || $('copy-link').disabled || ws?.readyState !== WebSocket.OPEN;
    summary = `${files.length} ${files.length === 1 ? 'file' : 'files'} ready`;
    amount = size(files.reduce((sum, file) => sum + file.size, 0));
  } else if (!accepted) {
    action = $('create-share').hidden ? 'accept' : 'create';
    label = action === 'create' ? 'Create new share link' : 'Accept files ↓';
    disabled = action === 'accept' && $('accept-files').disabled;
    summary = $('invite-summary').textContent;
    hint = action === 'create' ? 'Start a handoff with your own files.' : 'Both tabs need to stay open.';
  } else if (received.size) {
    const saved = [...received.values()].every(file => file.saved);
    action = 'save'; disabled = saving || saved;
    label = saving ? 'Preparing ZIP…' : saved ? 'Files saved ✓' : received.size === 1 ? 'Save file ↓' : 'Save all files ↓';
    summary = saving ? $('save-feedback').textContent : `${received.size} ${received.size === 1 ? 'file' : 'files'} verified`;
    hint = saved ? 'Saved to your chosen folder.' : 'Save your files before closing this tab.';
  } else if (!$('retry').hidden) {
    action = 'retry'; label = 'Reconnect'; hint = 'Keep the sender’s tab open.';
  } else { label = 'Waiting for files…'; disabled = true; }
  button.dataset.action = action || ''; button.textContent = label; button.disabled = disabled;
  $('mobile-summary').textContent = summary; $('mobile-amount').textContent = amount; $('mobile-hint').textContent = hint;
}
function abortIncoming(p) {
  if (p?.incoming) {
    fileTasks.run('abort', { token: p.incoming.token }).catch(() => {});
    p.incoming = null;
  }
}
function newPeer() {
  abortIncoming(peer);
  if (peer) { clearTimeout(peer.timer); peer.closed = true; peer.pc?.close(); peer.waiters.rejectAll(new Error('The recipient disconnected.')); }
  peer = { session: '', pc: null, dc: null, transport: '', tx: Promise.resolve(), rx: Promise.resolve(), outSeq: 0, inSeq: 0, candidates: [], ready: false, sent: new Set(), announced: new Set(), waiters: createWaiters(), closed: false, failed: false, sending: false, total: 0, done: 0 };
  return peer;
}
async function signal(value, p = peer) {
  const payload = toBase64(await encrypt(key, encodeJSON({ ...value, session: p?.session }), `signal:${room}`));
  packet({ type: 'signal', payload });
}
function attachChannel(p, channel) {
  p.dc = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 64 * 1024;
  channel.onmessage = event => receivePacket(p, event.data);
  channel.onopen = () => {
    if (p.closed || p.transport === 'relay') return;
    clearTimeout(p.timer); p.transport = 'direct';
    status('Connected', '', 'active');
    if (!isSender) sendControl(p, { type: 'ready' }).catch(fail);
  };
  channel.onclose = () => { if (p === peer && !p.closed && p.transport === 'direct') fail(new Error('The direct connection closed. Reconnect to receive the handoff again.')); };
  channel.onerror = () => { if (!p.transport) requestRelay(p).catch(fail); };
}
function setupRTC(p) {
  p.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  // No signals once relay data may flow: the relay treats the sender's next signal after a
  // receiver leaves as the end of that receiver's data.
  p.pc.onicecandidate = event => { if (event.candidate && p === peer && !p.closed && p.transport !== 'relay') signal({ type: 'ice', candidate: event.candidate.toJSON() }, p).catch(fail); };
  p.pc.ondatachannel = event => attachChannel(p, event.channel);
  p.pc.onconnectionstatechange = () => { if (p.pc.connectionState === 'failed' && !p.transport && p === peer) requestRelay(p).catch(fail); };
}
async function requestRelay(p) {
  if (p.closed || p.transport || p !== peer) return;
  if (isSender) {
    p.transport = 'relay'; p.pc?.close();
    await signal({ type: 'relay' }, p);
  } else await signal({ type: 'relay-request' }, p);
}
async function onSignal(payload) {
  let message;
  try { message = decodeJSON(await decrypt(key, fromBase64(payload), `signal:${room}`)); }
  catch { if (isSender) { packet({ type: 'reject' }); notice('A visitor used an incomplete or incorrect link. Your files were not shared.'); } else fail(new Error('The private key in this link is incorrect. Ask for the complete link.')); return; }
  let p = peer;
  if (message.type === 'hello' && isSender) {
    if (p.session) return;
    if (typeof message.session !== 'string' || !/^[a-f0-9-]{36}$/.test(message.session)) return;
    p.session = message.session;
    clearShareHighlight();
    $('lead').textContent = 'Keep this tab open until your files are sent.';
    status('Recipient joined', 'Connecting…', 'active');
    if (message.relay || !window.RTCPeerConnection) { await requestRelay(p); return; }
    try {
      setupRTC(p); attachChannel(p, p.pc.createDataChannel('handoff', { ordered: true }));
      await p.pc.setLocalDescription(await p.pc.createOffer());
      await signal({ type: 'offer', description: p.pc.localDescription.toJSON() }, p);
    } catch { await requestRelay(p); }
    p.timer = setTimeout(() => requestRelay(p).catch(fail), 8000);
    return;
  }
  if (!p || message.session !== p.session || p.closed) return;
  if (message.type === 'relay-request' && isSender) { await requestRelay(p); return; }
  if (message.type === 'relay' && !isSender && !p.transport) {
    p.transport = 'relay'; clearTimeout(p.timer); p.pc?.close();
    status('Connected', 'Using an encrypted relay.', 'active');
    await sendControl(p, { type: 'ready' }); return;
  }
  if (p.transport === 'relay') return;
  if (message.type === 'offer' && !isSender) {
    try {
      if (!p.pc) setupRTC(p);
      await p.pc.setRemoteDescription(message.description);
      for (const candidate of p.candidates.splice(0)) await p.pc.addIceCandidate(candidate);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await signal({ type: 'answer', description: p.pc.localDescription.toJSON() }, p);
    } catch { await requestRelay(p); }
  } else if (message.type === 'answer' && isSender && p.pc) {
    await p.pc.setRemoteDescription(message.description);
    for (const candidate of p.candidates.splice(0)) await p.pc.addIceCandidate(candidate);
  } else if (message.type === 'ice') {
    if (p.pc?.remoteDescription) await p.pc.addIceCandidate(message.candidate);
    else p.candidates.push(message.candidate);
  }
}
function sendPayload(p, type, bytes) {
  const result = p.tx.then(async () => {
    if (p !== peer || p.closed || p.failed) throw new Error('The connection ended.');
    const plain = new Uint8Array(5 + bytes.length); const view = new DataView(plain.buffer);
    view.setUint32(0, p.outSeq++); plain[4] = type; plain.set(bytes, 5);
    const encoded = await encrypt(key, plain, `data:${room}:${p.session}:${isSender ? 'sender' : 'receiver'}`);
    const channel = p.transport === 'direct' ? p.dc : ws;
    if (p.transport === 'direct') {
      if (channel.bufferedAmount > 256 * 1024) await waitForDataChannel(channel);
    } else {
      const deadline = Date.now() + 30_000;
      while (channel.bufferedAmount > 256 * 1024) {
        if (p.closed || p.failed || Date.now() > deadline) throw new Error('The receiver stopped responding. Reconnect and try again.');
        await delay(20);
      }
    }
    if (p.closed || p.failed) throw new Error('The connection ended.');
    if (p.transport === 'direct' ? channel.readyState !== 'open' : channel.readyState !== WebSocket.OPEN) throw new Error('The connection closed during transfer.');
    channel.send(encoded);
  });
  p.tx = result.catch(() => {}); return result;
}
const sendControl = (p, value) => sendPayload(p, 0, encodeJSON(value));
function receivePacket(p, raw) {
  p.rx = p.rx.then(async () => {
    if (p !== peer || p.closed || p.failed) return;
    const plain = await decrypt(key, raw, `data:${room}:${p.session}:${isSender ? 'receiver' : 'sender'}`);
    if (plain.length < 5 || new DataView(plain.buffer, plain.byteOffset).getUint32(0) !== p.inSeq++) throw new Error('Transfer order could not be verified. Reconnect to try again.');
    if (plain[4] === 0) await onControl(p, decodeJSON(plain.slice(5)));
    else if (plain[4] === 1 && !isSender && p.incoming) {
      const data = plain.slice(5); const item = p.incoming;
      if (item.offset + data.length > item.meta.size) throw new Error('The incoming file exceeds its declared size.');
      item.parts.push(data); item.buffered += data.length; item.offset += data.length; p.done += data.length;
      if (item.buffered >= RECEIVE_BLOCK_BYTES) await flushIncoming(item);
      if (item.offset % RECEIVE_BLOCK_BYTES === 0) await sendControl(p, { type: 'ack', id: item.meta.id, offset: item.offset });
    } else throw new Error('An unexpected transfer packet arrived.');
  }).catch(error => { if (p === peer && !p.closed) fail(error); });
}
async function flushIncoming(item) {
  if (!item.parts.length) return;
  const bytes = new Uint8Array(item.parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of item.parts) { bytes.set(part, offset); offset += part.length; }
  item.parts = []; item.buffered = 0;
  await fileTasks.run('append', { token: item.token, bytes }, { transfer: [bytes.buffer] });
}
async function onControl(p, message) {
  if (message.type === 'ready' && isSender) { p.ready = true; resumeSending(p); }
  else if (message.type === 'manifest' && !isSender) {
    const manifest = validateManifest(message.files, files);
    files.splice(0, files.length, ...manifest.map(meta => ({ ...meta, state: received.has(meta.id) ? received.get(meta.id).saved ? 'Saved to folder · verified' : 'Received · verified' : 'Waiting…' })));
    p.total = manifest.reduce((sum, file) => sum + file.size, 0); renderFiles(); startProgress(p);
    if (!manifest.length) status('Connected. Waiting for files.', 'The sender can add files or a note at any time.', 'active');
  } else if (message.type === 'start' && !isSender) {
    const meta = files.find(file => file.id === message.id);
    if (!meta || p.incoming || received.has(meta.id)) throw new Error('Unexpected file start.');
    const token = `${p.session}:${meta.id}`;
    const original = safeName(meta.name);
    let name = original, n = 2;
    while (folderNames.has(name.toLowerCase())) name = `${n++}-${original}`;
    folderNames.add(name.toLowerCase());
    p.incoming = { meta, token, parts: [], buffered: 0, offset: 0 };
    await fileTasks.run('begin', { token, meta, directory: receiveFolder, name });
    if (p !== peer || p.closed || p.failed) return;
    meta.state = 'Receiving…'; renderFiles();
    status(`Receiving ${meta.name}`, 'Keep this tab open until the handoff is complete.', 'active');
  } else if (message.type === 'end' && !isSender) {
    const item = p.incoming;
    if (!item || item.meta.id !== message.id) throw new Error('Unexpected file completion.');
    await flushIncoming(item);
    const result = await fileTasks.run('finish', { token: item.token });
    if (p !== peer || p.closed || p.failed) return;
    const note = /\.(md|txt)$/i.test(item.meta.name) && item.meta.size <= 1024 * 1024 ? await result.blob.text() : null;
    if (p !== peer || p.closed || p.failed) return;
    received.set(item.meta.id, { ...item.meta, ...result, note, url: URL.createObjectURL(result.blob) });
    item.meta.state = result.saved ? 'Saved to folder · verified' : 'Received · verified'; p.incoming = null; renderFiles();
    $('download-all').disabled = saving; $('copy-agent').disabled = ![...received.values()].some(file => /\.(md|txt)$/i.test(file.name) && file.size <= 1024 * 1024);
    await sendControl(p, { type: 'received', id: item.meta.id });
  } else if (message.type === 'ack' && isSender) p.waiters.resolve(`ack:${message.id}:${message.offset}`);
  else if (message.type === 'received' && isSender) p.waiters.resolve(`done:${message.id}`);
  else if (message.type === 'complete' && !isSender) {
    if (p.incoming || files.some(file => !received.has(file.id))) throw new Error('The handoff ended before all files arrived.');
    status(files.length ? 'All files received' : 'Waiting for files', files.length ? 'Every file verified.' : 'The sender can add files or a note.', 'active');
    if (files.length) {
      $('headline').textContent = 'Your files are here.';
      $('lead').textContent = receiveFolder ? `Saved in ${receiveFolder.name}.` : 'Save them below or copy the notes.';
      $('keep-open-text').textContent = receiveFolder ? 'Your files are saved and verified.' : 'Save your files before closing this tab.';
    }
    progress(p, true); $('receive-intro').hidden = files.length > 0;
  }
}
function resumeSending(p = peer) {
  if (p?.ready) pump(p).catch(error => { if (p === peer && !p.closed) fail(error); });
}
async function pump(p) {
  if (!p.ready || p.sending || p.closed || p.failed || preparing) return;
  p.sending = true;
  const batch = files.filter(file => file.id !== editingId);
  let continueBatch = false;
  for (const file of batch) p.announced.add(file.id);
  p.total = batch.reduce((sum, file) => sum + file.size, 0); startProgress(p); renderFiles();
  try {
    await sendControl(p, { type: 'manifest', files: batch.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 })) });
    for (const file of batch) {
      if (p.sent.has(file.id)) continue;
      file.state = 'Sending…'; renderFiles(); status(`Sending ${file.name}`, 'Keep this tab open. The receiver is getting your file.', 'active');
      await sendControl(p, { type: 'start', id: file.id });
      const base = p.done;
      await streamFile(file.file, {
        send: bytes => sendPayload(p, 1, bytes),
        waitForAck: offset => p.waiters.wait(`ack:${file.id}:${offset}`),
        onConfirmed: offset => { p.done = base + offset; },
      });
      const done = p.waiters.wait(`done:${file.id}`);
      await sendControl(p, { type: 'end', id: file.id });
      await done; p.done = base + file.size; p.sent.add(file.id); file.state = 'Delivered · verified'; renderFiles();
    }
    // Keep the recipient connected until additions selected during this batch are ready.
    if (preparing || files.some(file => file.id !== editingId && !p.sent.has(file.id))) { continueBatch = !preparing; return; }
    await sendControl(p, { type: 'complete' });
    progress(p, true);
    status(editingId ? 'Finish editing your note' : files.length ? 'All files sent' : 'Recipient connected', editingId ? 'Save or cancel the edit to send that note.' : files.length ? 'You can add more or close this tab.' : 'Add files or a note to send them.', 'active');
  } finally {
    p.sending = false;
    if (continueBatch && p === peer && !p.closed && !p.failed && !preparing) resumeSending(p);
  }
}
async function addFiles(incoming, { replaceId = null, noteText } = {}) {
  if (preparing) { addFeedback('Still adding your files…'); return false; }
  if (replaceId && !canEdit(files.find(file => file.id === replaceId))) { addFeedback('This note has already started sending. Add a new note instead.'); return false; }
  const firstAddition = files.length === 0;
  preparing = true; notice(''); renderFiles();
  try {
    const { additions, duplicates } = await prepareAdditions(files.filter(file => file.id !== replaceId), incoming, file => {
      addFeedback(`Adding ${file.name}…`);
      return fileTasks.run('hash', { file }, { onProgress: done => addFeedback(`Adding ${file.name} · ${Math.round(done / file.size * 100)}%`) });
    });
    if (!additions.length) { addFeedback('Already added. Check the list below.'); return false; }
    for (const file of additions) {
      if (noteText !== undefined) file.noteText = noteText;
      if (peer?.sending) file.state = 'Queued for next transfer';
    }
    if (replaceId) {
      files.splice(files.findIndex(file => file.id === replaceId), 1, ...additions);
      resetNoteEditor();
    } else files.push(...additions);
    publishPreview();
    addFeedback(peer?.sending ? 'Added. These files will send next.' : duplicates ? 'Skipped files already in this handoff.' : '');
    if (!peer?.ready || peer.closed) {
      status('Ready to send', 'They open the link and accept your files.', 'active');
      $('lead').textContent = 'Files added. Copy the link to send them.';
      highlightShare(firstAddition);
    }
    return true;
  } catch (error) { addFeedback(error.message); return false; }
  finally {
    preparing = false; renderFiles();
    resumeSending();
  }
}
function canEdit(file) { return !!file && !preparing && (!peer || peer.closed || !peer.announced.has(file.id)); }
function resetNoteEditor() {
  editingId = null; $('note').value = ''; $('add-note').textContent = 'Add note'; $('cancel-note').hidden = true;
}
function editNote(file) {
  if (!canEdit(file)) return;
  editingId = file.id; $('note').value = file.noteText;
  $('add-note').textContent = 'Save note'; $('cancel-note').hidden = false;
  selectInputTab($('note-tab')); renderFiles(); $('note').focus();
}
function removeFile(file) {
  if (!canEdit(file)) return;
  const index = files.indexOf(file); files.splice(index, 1);
  if (editingId === file.id) resetNoteEditor();
  publishPreview(); renderFiles();
  if (!files.length) {
    clearShareHighlight(); $('lead').textContent = 'Add them below. Share the link.';
    status('Ready when you are', '');
  }
  const buttons = $('file-list').querySelectorAll('.file-remove');
  (buttons[Math.min(index, buttons.length - 1)] || $('dropzone')).focus({ preventScroll: true });
}
function addFeedback(message) { $('add-feedback').textContent = message; $('add-feedback').hidden = !message; }
function highlightShare(scroll = false) {
  $('share-card').classList.add('share-ready');
  $('share-title').textContent = 'Now share the link';
  if (scroll && !$('copy-link').disabled && !matchMedia('(max-width: 759px)').matches) {
    $('copy-link').focus({ preventScroll: true });
    $('copy-link').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
function clearShareHighlight() {
  $('share-card').classList.remove('share-ready');
  $('share-title').textContent = 'Share the link';
}
function renderFiles() {
  if (isSender) {
    document.body.classList.toggle('has-files', files.length > 0);
    $('content-title').textContent = files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} added` : 'Add files or a note';
    $('content-step').textContent = files.length ? '✓' : '1';
    $('dropzone-label').textContent = preparing ? 'Adding…' : files.length ? 'Add more' : 'Choose files';
    $('dropzone').setAttribute('aria-label', preparing ? 'Adding files' : files.length ? 'Add more files' : 'Choose files');
    $('dropzone').setAttribute('aria-busy', String(preparing));
    $('dropzone').disabled = preparing; $('add-note').disabled = preparing;
    $('cancel-note').disabled = preparing;
    $('note').disabled = preparing;
  }
  $('queue-summary').textContent = `${files.length} / ${MAX_FILES} files · ${size(files.reduce((sum, file) => sum + file.size, 0))} / ${size(MAX_BYTES)}`;
  $('download-all').textContent = received.size === 1 ? 'Save file ↓' : 'Save all files ↓';
  $('queued-files').hidden = files.length === 0;
  if (!isSender) $('receive-intro').hidden = files.length > 0;
  $('file-list').replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = (file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
    const detail = document.createElement('small'); detail.textContent = `${size(file.size)} · ${file.id === editingId ? 'Editing note…' : file.state}`;
    info.append(name, detail); row.append(icon, info);
    if (isSender) {
      const actions = document.createElement('div'); actions.className = 'file-actions';
      if (file.noteText !== undefined) {
        const edit = document.createElement('button'); edit.className = 'text-button'; edit.textContent = 'Edit';
        edit.setAttribute('aria-label', `Edit ${file.name}`); edit.disabled = !canEdit(file) || !!editingId; edit.onclick = () => editNote(file); actions.append(edit);
      }
      const remove = document.createElement('button'); remove.className = 'text-button file-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${file.name}`); remove.disabled = !canEdit(file); remove.onclick = () => removeFile(file);
      if (peer?.announced.has(file.id) && !peer.closed) actions.title = 'Already announced to the receiver. It cannot be changed during this connection.';
      actions.append(remove); row.append(actions);
    }
    if (!isSender && received.has(file.id)) {
      const saved = received.get(file.id); const link = document.createElement('a'); link.href = saved.url; link.download = safeName(file.name); link.textContent = 'Save ↓'; link.setAttribute('aria-label', `Save ${file.name}`); row.append(link);
    }
    $('file-list').append(row);
    if (!isSender && received.has(file.id) && /^HANDOFF.*\.md$/i.test(file.name) && file.size < 200_000) {
      const preview = document.createElement('pre'); preview.className = 'note-preview'; preview.textContent = received.get(file.id).note; $('file-list').append(preview);
    }
  }
  updateMobileAction();
}
function safeName(name) { return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'file'; }
async function connect() {
  ended = false; $('retry').hidden = true; notice('');
  if (!isSender && destinationParent) {
    receiveFolder = await destinationParent.getDirectoryHandle(`meatproxy-${crypto.randomUUID()}`, { create: true });
    folderNames = new Set();
  }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/socket`); ws.binaryType = 'arraybuffer';
  ws.onopen = () => packet(isSender ? { type: 'create' } : { type: 'join', room });
  ws.onmessage = event => {
    if (typeof event.data !== 'string') { if (peer) receivePacket(peer, event.data); return; }
    socketQueue = socketQueue.then(async () => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'created') {
        room = msg.room; history.replaceState(null, '', `/s/${room}#${secret}`);
        $('share-link').value = location.href; $('copy-link').disabled = false;
        updateCommand(); publishPreview();
        status(files.length ? 'Ready to send' : 'Ready when you are', '', 'active');
        if (files.length && !peer?.ready) highlightShare(true);
      } else if (msg.type === 'peer-joined') newPeer();
      else if (msg.type === 'joined') {
        const p = newPeer(); p.session = crypto.randomUUID();
        await signal({ type: 'hello', relay: !window.RTCPeerConnection }, p);
        status('Finding the sender…', 'Establishing your encrypted connection.', 'active');
        p.timer = setTimeout(() => requestRelay(p).catch(fail), 8000);
      } else if (msg.type === 'signal') await onSignal(msg.payload);
      else if (msg.type === 'unavailable') { ended = true; fail(new Error('The sender is offline or this link has expired. Ask them to keep their tab open and send a fresh link.')); }
      else if (msg.type === 'busy') { ended = true; fail(new Error('Someone else is receiving this handoff. Try again after they close their tab.')); }
      else if (msg.type === 'peer-left') {
        if (peer) { peer.closed = true; peer.pc?.close(); clearTimeout(peer.timer); peer.waiters.rejectAll(new Error('The recipient disconnected.')); }
        const limit = relayLimit(msg.code, false);
        status('The recipient has left.', msg.code === 4002 ? limit : `${limit ? `${limit} ` : ''}Your link is still live. Someone else can open it now.`);
        renderFiles();
      } else if (msg.type === 'sender-left') {
        abortIncoming(peer);
        ended = true; if (peer) { peer.closed = true; peer.pc?.close(); clearTimeout(peer.timer); }
        const limit = relayLimit(msg.code, false);
        status('The sender has left.', `${limit ? `${limit} ` : ''}${received.size ? 'Your received files are still here. Save them before closing this tab.' : 'Ask the sender for a fresh link.'}`);
      }
    }).catch(fail);
  };
  ws.onerror = () => fail(new Error('Could not reach Meatproxy. Check your connection and try again.'));
  ws.onclose = event => {
    if (!ended) {
      if (peer?.transport === 'direct' && peer.dc?.readyState === 'open') { notice('The link service disconnected. Your current direct transfer can continue, but new recipients need a fresh link.'); return; }
      if (peer) { peer.progressActive = false; peer.closed = true; }
      abortIncoming(peer);
      // The server explains closes it initiates, such as relay limits.
      const advice = isSender ? 'Start a new handoff to make a fresh link.' : 'Save any completed files, then reconnect.';
      status('Connection closed', relayLimit(event.code, true) || (event.reason ? `${event.reason}. ${advice}` : advice), 'error');
      $('retry').hidden = isSender || event.code === 4002; // Reconnecting cannot restore a link's relay allowance.
      updateMobileAction();
    }
  };
}
async function copy(text, button, label) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied!'; setTimeout(() => { button.textContent = label; }, 1800); return true; }
  catch { notice('Clipboard access was blocked. Select and copy the link from the field above.'); }
}
$('copy-link').onclick = async () => {
  if (await copy($('share-link').value, $('copy-link'), 'Copy link ↗')) {
    clearShareHighlight();
    $('lead').textContent = 'Link copied. Send it and keep this tab open.';
  }
};
$('copy-command').onclick = () => copy($('agent-command').textContent, $('copy-command'), 'Copy command');
$('mobile-action').onclick = async () => {
  const action = $('mobile-action').dataset.action;
  if (action === 'share') {
    try { await navigator.share({ title: 'Meatproxy handoff', url: $('share-link').value }); clearShareHighlight(); }
    catch (error) { if (error.name !== 'AbortError') notice('Sharing was unavailable. Use Copy link in the share card.'); }
  } else if (action === 'copy') {
    if (await copy($('share-link').value, $('mobile-action'), 'Copy link ↗')) clearShareHighlight();
  } else ({ accept: $('accept-files'), create: $('create-share'), save: $('download-all'), retry: $('retry') })[action]?.click();
};
const inputTabs = [$('files-tab'), $('note-tab')];
function selectInputTab(tab) {
  for (const item of inputTabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of inputTabs) {
  tab.onclick = () => selectInputTab(tab);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? inputTabs[0] : event.key === 'End' ? inputTabs[1] : inputTabs.find(item => item !== tab);
    selectInputTab(next); next.focus();
  };
}
$('dropzone').onclick = () => $('file-input').click();
$('preview-names').onchange = publishPreview;
$('accept-files').onclick = () => {
  accepted = true; clearTimeout(previewTimer);
  $('receive-invite').hidden = true; $('receive-intro').hidden = false; $('receive-actions').hidden = false;
  $('content-title').textContent = 'Your files';
  $('lead').textContent = 'Receive here. Save when ready.';
  $('keep-open-text').textContent = 'Keep this tab open until received.';
  status('Connecting…', 'Starting your encrypted transfer.');
  connect().catch(fail);
};
$('accept-folder').onclick = async () => {
  try {
    destinationParent = await window.showDirectoryPicker({ mode: 'readwrite', id: 'meatproxy-receive' });
    $('accept-files').click();
  } catch (error) { if (error.name !== 'AbortError') notice(`Could not open that folder: ${error.message}`); }
};
$('file-input').onchange = event => { addFiles([...event.target.files]); event.target.value = ''; };
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').ondrop = event => addFiles([...event.dataTransfer.files]);
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('add-note').onclick = async () => {
  const text = $('note').value.trim(); if (!text) { $('note').focus(); return; }
  let name = editingId ? files.find(file => file.id === editingId).name : 'HANDOFF.md', n = 2;
  if (!editingId) while (files.some(file => file.name === name)) name = `HANDOFF-${n++}.md`;
  if (await addFiles([new File([text + '\n'], name, { type: 'text/markdown' })], { replaceId: editingId, noteText: text })) resetNoteEditor();
};
$('cancel-note').onclick = () => { resetNoteEditor(); renderFiles(); resumeSending(); };
$('retry').onclick = () => {
  abortIncoming(peer);
  if (peer) { peer.closed = true; peer.pc?.close(); clearTimeout(peer.timer); }
  if (ws) { ws.onclose = null; ws.close(); }
  for (const item of received.values()) URL.revokeObjectURL(item.url);
  received.clear(); files.splice(0); renderFiles(); $('download-all').disabled = true; $('copy-agent').disabled = true;
  $('headline').textContent = 'Files, coming your way.';
  $('lead').textContent = 'Receive here. Save when ready.';
  $('keep-open-text').textContent = 'Keep this tab open until received.';
  socketQueue = Promise.resolve(); connect().catch(fail);
};
$('copy-agent').onclick = () => {
  const notes = [...received.values()].filter(file => /\.(md|txt)$/i.test(file.name) && file.size <= 1024 * 1024);
  const text = notes.map(file => `# ${file.name}\n\n${file.note}`).join('\n\n---\n\n');
  copy(text, $('copy-agent'), 'Copy notes');
};
window.addEventListener('beforeunload', event => {
  if ((isSender && files.length) || (!isSender && (peer?.incoming || [...received.values()].some(file => !file.saved)))) { event.preventDefault(); event.returnValue = ''; }
});
if (!isSender) {
  document.body.classList.add('receiving');
  $('sender-controls').hidden = true; $('receive-invite').hidden = false;
  $('headline').textContent = 'Files, coming your way.';
  $('lead').textContent = 'Accept to receive them from the sender.';
  $('content-title').textContent = 'Peer-to-peer handoff'; $('share-title').textContent = 'Live connection';
  $('content-step').hidden = true; $('share-step').hidden = true; $('share-controls').hidden = true;
  $('keep-open-text').textContent = 'Files only transfer after you accept.';
  $('agent-title').textContent = 'Receive with an agent';
  $('agent-tip').textContent = 'Close this receiving tab before running the command. Keep the sender’s tab open. Files are saved, never run.';
  updateCommand();
}
try {
  key = await importSecret(secret);
  if (isSender) await connect();
  else { status('Checking the sender…', ''); await checkInvite(); }
} catch (error) { fail(error); }

$('download-all').onclick = async () => {
  if (saving) return;
  const items = [...received.values()], single = items.length === 1;
  const total = items.reduce((sum, item) => sum + item.size, 0);
  saving = true; $('download-all').disabled = true;
  $('save-feedback').hidden = false;
  $('save-feedback').textContent = single ? 'Starting download…' : 'Preparing ZIP…';
  updateMobileAction();
  try {
    const url = single ? items[0].url : URL.createObjectURL(await archiveTasks.run('zip', {
      items: items.map(({ name, blob }) => ({ name, blob })),
    }, { onProgress: done => { $('save-feedback').textContent = `Preparing ZIP · ${Math.round(done / total * 100)}%`; updateMobileAction(); } }));
    const link = document.createElement('a'); link.href = url;
    link.download = single ? safeName(items[0].name) : 'meatproxy-handoff.zip';
    link.click();
    if (!single) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $('save-feedback').textContent = 'Download started. Check your browser’s downloads.';
  } catch (error) { $('save-feedback').textContent = `Could not prepare the download: ${error.message}`; }
  finally { saving = false; $('download-all').disabled = received.size === 0; updateMobileAction(); }
};

import { MAX_BYTES, MAX_FILES, CHUNK_BYTES, makeSecret, importSecret, encrypt, decrypt, encodeJSON, decodeJSON, toBase64, fromBase64, digest, validateManifest } from './protocol.js';

const $ = id => document.getElementById(id);
const isSender = location.pathname === '/';
const files = [];
const received = new Map();
let room = isSender ? '' : location.pathname.split('/')[2];
let secret = isSender ? makeSecret() : location.hash.slice(1);
let key, ws, peer, socketQueue = Promise.resolve(), preparing = false, ended = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
function status(title, detail, state = '') { $('status').textContent = title; $('status-detail').textContent = detail; $('status-dot').className = `status-dot ${state}`; }
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function packet(value) { if (ws?.readyState !== WebSocket.OPEN) throw new Error('The connection closed. Start a new handoff.'); ws.send(JSON.stringify(value)); }
function updateCommand() {
  $('agent-command').textContent = `node meatproxy-receive.mjs '${location.origin}/s/${room}#${secret}' ./handoff`;
  $('copy-command').disabled = false;
}
function progress(done, total) {
  $('progress').hidden = total === 0; $('progress').value = total ? done / total * 100 : 0;
  $('transfer-meta').textContent = total ? `${size(done)} of ${size(total)} · ${peer?.transport === 'direct' ? 'Direct connection' : 'Encrypted relay'}` : '';
}
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  notice(message); status('The handoff paused', message, 'error');
  if (peer) { peer.failed = true; for (const waiter of peer.waiters.values()) waiter.reject(new Error(message)); peer.waiters.clear(); }
  $('retry').hidden = isSender;
}
function newPeer() {
  if (peer) { clearTimeout(peer.timer); peer.closed = true; peer.pc?.close(); for (const waiter of peer.waiters.values()) waiter.reject(new Error('The recipient disconnected.')); }
  peer = { session: '', pc: null, dc: null, transport: '', tx: Promise.resolve(), rx: Promise.resolve(), outSeq: 0, inSeq: 0, candidates: [], ready: false, sent: new Set(), waiters: new Map(), closed: false, failed: false, sending: false, total: 0, done: 0 };
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
    const deadline = Date.now() + 30_000;
    while (channel.bufferedAmount > 256 * 1024) {
      if (p.closed || p.failed || Date.now() > deadline) throw new Error('The receiver stopped responding. Reconnect and try again.');
      await delay(20);
    }
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
      item.bytes.set(data, item.offset); item.offset += data.length; p.done += data.length;
      progress(p.done, p.total);
      if (item.offset % (CHUNK_BYTES * 16) === 0) await sendControl(p, { type: 'ack', id: item.meta.id, offset: item.offset });
    } else throw new Error('An unexpected transfer packet arrived.');
  }).catch(fail);
}
function waitFor(p, id) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => { p.waiters.delete(id); reject(new Error('The other browser stopped responding. Reconnect and try again.')); }, 30_000);
    p.waiters.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  promise.catch(() => {}); return promise;
}
function resolveWait(p, id, value) { const waiter = p.waiters.get(id); if (waiter) { p.waiters.delete(id); waiter.resolve(value); } }
async function onControl(p, message) {
  if (message.type === 'ready' && isSender) { p.ready = true; pump(p).catch(fail); }
  else if (message.type === 'manifest' && !isSender) {
    const manifest = validateManifest(message.files, files);
    files.splice(0, files.length, ...manifest.map(meta => ({ ...meta, state: received.has(meta.id) ? 'Received · verified' : 'Waiting…' })));
    p.total = manifest.reduce((sum, file) => sum + file.size, 0); renderFiles();
    if (!manifest.length) status('Connected. Waiting for files.', 'The sender can add files or a note at any time.', 'active');
  } else if (message.type === 'start' && !isSender) {
    const meta = files.find(file => file.id === message.id);
    if (!meta || p.incoming || received.has(meta.id)) throw new Error('Unexpected file start.');
    p.incoming = { meta, bytes: new Uint8Array(meta.size), offset: 0 }; meta.state = 'Receiving…'; renderFiles();
    status(`Receiving ${meta.name}`, 'Keep this tab open until the handoff is complete.', 'active');
  } else if (message.type === 'end' && !isSender) {
    const item = p.incoming;
    if (!item || item.meta.id !== message.id || item.offset !== item.meta.size || await digest(item.bytes) !== item.meta.sha256) throw new Error('File verification failed. Please reconnect and try again.');
    received.set(item.meta.id, { ...item.meta, bytes: item.bytes, url: URL.createObjectURL(new Blob([item.bytes], { type: 'application/octet-stream' })) });
    item.meta.state = 'Received · verified'; p.incoming = null; renderFiles();
    $('download-all').disabled = false; $('copy-agent').disabled = ![...received.values()].some(file => /\.(md|txt)$/i.test(file.name) && file.size <= 1024 * 1024);
    await sendControl(p, { type: 'received', id: item.meta.id });
  } else if (message.type === 'ack' && isSender) resolveWait(p, `ack:${message.id}:${message.offset}`);
  else if (message.type === 'received' && isSender) resolveWait(p, `done:${message.id}`);
  else if (message.type === 'complete' && !isSender) {
    if (p.incoming || files.some(file => !received.has(file.id))) throw new Error('The handoff ended before all files arrived.');
    status(files.length ? 'All files received' : 'Waiting for files', files.length ? 'Every file verified.' : 'The sender can add files or a note.', 'active');
    if (files.length) {
      $('headline').textContent = 'Your files are here.';
      $('lead').textContent = 'Save them below or copy the notes.';
      $('keep-open-text').textContent = 'Save your files before closing this tab.';
    }
    progress(p.total, p.total); $('receive-intro').hidden = files.length > 0;
  }
}
async function pump(p) {
  if (!p.ready || p.sending || p.closed || p.failed || preparing) return;
  p.sending = true;
  try {
    await sendControl(p, { type: 'manifest', files: files.map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 })) });
    for (const file of files) {
      if (p.sent.has(file.id)) continue;
      file.state = 'Sending…'; renderFiles(); status(`Sending ${file.name}`, 'Keep this tab open. The receiver is getting your file.', 'active');
      await sendControl(p, { type: 'start', id: file.id });
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        const end = Math.min(offset + CHUNK_BYTES, file.size);
        const ack = end % (CHUNK_BYTES * 16) === 0 ? waitFor(p, `ack:${file.id}:${end}`) : null;
        await sendPayload(p, 1, new Uint8Array(await file.file.slice(offset, end).arrayBuffer()));
        p.done += end - offset;
        progress(p.done, files.reduce((sum, item) => sum + item.size, 0));
        if (ack) await ack;
      }
      const done = waitFor(p, `done:${file.id}`);
      await sendControl(p, { type: 'end', id: file.id });
      await done; p.sent.add(file.id); file.state = 'Delivered · verified'; renderFiles();
    }
    await sendControl(p, { type: 'complete' });
    status(files.length ? 'All files sent' : 'Recipient connected', files.length ? 'You can add more or close this tab.' : 'Add files or a note to send them.', 'active');
  } finally { p.sending = false; }
}
async function addFiles(incoming) {
  if (preparing) { notice('A file is still being prepared. Try adding the next files in a moment.'); return; }
  if (peer?.sending) { notice('Wait for the current transfer to finish before adding more files.'); return; }
  if (files.length + incoming.length > MAX_FILES || [...files, ...incoming].reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) { notice('This prototype supports up to 100 files and 256 MB total per handoff.'); return; }
  preparing = true; notice(''); $('add-note').disabled = true;
  try {
    for (const file of incoming) {
      const sha256 = await digest(await file.arrayBuffer());
      files.push({ id: crypto.randomUUID(), file, name: file.name, size: file.size, sha256, state: 'Ready to send' });
    }
    renderFiles();
    if (!peer?.ready) status('Ready to send', 'They open the link. Files start arriving.', 'active');
  } catch (error) { fail(error); }
  finally { preparing = false; $('add-note').disabled = false; }
  if (peer?.ready) pump(peer).catch(fail);
}
function renderFiles() {
  $('file-count').textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'} added`;
  $('queued-files').hidden = files.length === 0;
  if (!isSender) $('receive-intro').hidden = files.length > 0;
  $('file-list').replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = (file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
    const detail = document.createElement('small'); detail.textContent = `${size(file.size)} · ${file.state}`;
    info.append(name, detail); row.append(icon, info);
    if (!isSender && received.has(file.id)) {
      const saved = received.get(file.id); const link = document.createElement('a'); link.href = saved.url; link.download = safeName(file.name); link.textContent = 'Save ↓'; link.setAttribute('aria-label', `Save ${file.name}`); row.append(link);
    }
    $('file-list').append(row);
    if (!isSender && received.has(file.id) && /^HANDOFF.*\.md$/i.test(file.name) && file.size < 200_000) {
      const preview = document.createElement('pre'); preview.className = 'note-preview'; preview.textContent = new TextDecoder().decode(received.get(file.id).bytes); $('file-list').append(preview);
    }
  }
}
function safeName(name) { return name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'file'; }
async function connect() {
  ended = false; $('retry').hidden = true; notice('');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/socket`); ws.binaryType = 'arraybuffer';
  ws.onopen = () => packet(isSender ? { type: 'create' } : { type: 'join', room });
  ws.onmessage = event => {
    if (typeof event.data !== 'string') { if (peer) receivePacket(peer, event.data); return; }
    socketQueue = socketQueue.then(async () => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'created') {
        room = msg.room; history.replaceState(null, '', `/s/${room}#${secret}`);
        $('share-link').value = location.href; $('copy-link').disabled = false;
        updateCommand();
        status('Ready when you are', '', 'active');
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
        if (peer) { peer.closed = true; peer.pc?.close(); clearTimeout(peer.timer); for (const waiter of peer.waiters.values()) waiter.reject(new Error('The recipient disconnected.')); }
        status('The recipient has left.', 'Your link is still live. Someone else can open it now.');
      } else if (msg.type === 'sender-left') {
        ended = true; if (peer) { peer.closed = true; peer.pc?.close(); clearTimeout(peer.timer); }
        status('The sender has left.', received.size ? 'Your received files are still here. Save them before closing this tab.' : 'Ask the sender for a fresh link.');
      }
    }).catch(fail);
  };
  ws.onerror = () => fail(new Error('Could not reach Meatproxy. Check your connection and try again.'));
  ws.onclose = () => {
    if (!ended) {
      if (peer?.transport === 'direct' && peer.dc?.readyState === 'open') { notice('The link service disconnected. Your current direct transfer can continue, but new recipients need a fresh link.'); return; }
      status('Connection closed', isSender ? 'Start a new handoff to make a fresh link.' : 'Save any completed files, then reconnect.', 'error');
      $('retry').hidden = isSender;
    }
  };
}
async function copy(text, button, label) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied!'; setTimeout(() => { button.textContent = label; }, 1800); }
  catch { notice('Clipboard access was blocked. Select and copy the link from the field above.'); }
}
$('copy-link').onclick = () => copy($('share-link').value, $('copy-link'), 'Copy link ↗');
$('copy-command').onclick = () => copy($('agent-command').textContent, $('copy-command'), 'Copy command');
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
$('file-input').onchange = event => { addFiles([...event.target.files]); event.target.value = ''; };
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').ondrop = event => addFiles([...event.dataTransfer.files]);
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('add-note').onclick = async () => {
  const text = $('note').value.trim(); if (!text) { $('note').focus(); return; }
  const count = files.filter(file => /^HANDOFF.*\.md$/i.test(file.name)).length;
  const before = files.length; await addFiles([new File([text + '\n'], count ? `HANDOFF-${count + 1}.md` : 'HANDOFF.md', { type: 'text/markdown' })]);
  if (files.length > before) $('note').value = '';
};
$('retry').onclick = () => {
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
  const text = notes.map(file => `# ${file.name}\n\n${new TextDecoder().decode(file.bytes)}`).join('\n\n---\n\n');
  copy(text, $('copy-agent'), 'Copy notes');
};
window.addEventListener('beforeunload', event => {
  if ((isSender && files.length) || (!isSender && received.size)) { event.preventDefault(); event.returnValue = ''; }
});
if (!isSender) {
  document.body.classList.add('receiving');
  $('sender-controls').hidden = true; $('receive-intro').hidden = false; $('receive-actions').hidden = false;
  $('headline').textContent = 'Files, coming your way.';
  $('lead').textContent = 'Receive here. Save when ready.';
  $('content-title').textContent = 'Your files'; $('share-title').textContent = 'Transfer status';
  $('content-step').hidden = true; $('share-step').hidden = true; $('share-controls').hidden = true;
  $('queued-files').open = true; $('file-count').hidden = true;
  $('keep-open-text').textContent = 'Keep this tab open until received.';
  $('agent-title').textContent = 'Receive with an agent';
  $('agent-tip').textContent = 'Close this receiving tab before running the command. Keep the sender’s tab open. Files are saved, never run.';
  updateCommand();
}
try { key = await importSecret(secret); await connect(); } catch (error) { fail(error); }

// A stored ZIP keeps arbitrary file bytes intact and avoids third-party scripts.
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }
function zip(items) {
  const parts = [], directory = []; let offset = 0;
  const names = new Set();
  for (const item of items) {
    let name = safeName(item.name); let n = 2; const original = name;
    while (names.has(name)) name = `${n++}-${original}`; names.add(name);
    const filename = new TextEncoder().encode(name); const crc = crc32(item.bytes);
    const local = new Uint8Array(30 + filename.length); const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint32(14, crc, true); l.setUint32(18, item.size, true); l.setUint32(22, item.size, true); l.setUint16(26, filename.length, true); local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length); const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint32(16, crc, true); c.setUint32(20, item.size, true); c.setUint32(24, item.size, true); c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); central.set(filename, 46);
    parts.push(local, item.bytes); directory.push(central); offset += local.length + item.size;
  }
  const length = directory.reduce((sum, part) => sum + part.length, 0); const end = new Uint8Array(22); const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true); e.setUint16(10, items.length, true); e.setUint32(12, length, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
$('download-all').onclick = () => {
  const url = URL.createObjectURL(zip([...received.values()])); const link = document.createElement('a'); link.href = url; link.download = 'meatproxy-handoff.zip'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

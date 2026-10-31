// Bundled with protocol.js by ops/build-client.mjs; no external dependencies.
import { mkdir, open, link as linkFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

if (!process.argv[2] || !globalThis.WebSocket) {
  console.error('Usage (Node.js 22+): node meatproxy-receive.mjs "https://meatproxy.to/s/ROOM#KEY" [output-directory]');
  process.exit(1);
}
const shareURL = new URL(process.argv[2]);
if (!['https:', 'http:'].includes(shareURL.protocol) || (shareURL.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(shareURL.hostname)) || !/^\/s\/[A-Za-z0-9_-]{22}$/.test(shareURL.pathname)) throw new Error('Provide a complete Meatproxy HTTPS share link.');
const roomID = shareURL.pathname.split('/')[2];
const transferKey = await importSecret(shareURL.hash.slice(1));
const outputDir = resolve(process.argv[3] || `meatproxy-handoff-${roomID}`);
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const sessionID = randomUUID();
const socketURL = new URL('/socket', shareURL); socketURL.protocol = shareURL.protocol === 'https:' ? 'wss:' : 'ws:';
const clientSocket = new WebSocket(socketURL); clientSocket.binaryType = 'arraybuffer';
let inputSequence = 0, outputSequence = 0, queue = Promise.resolve(), manifest = [], currentFile, successful = false, stopped = false;
const completed = new Map();
let idleTimer;
function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => stop(new Error('No transfer activity for 60 seconds. Keep the sender tab open and retry.')), 60_000); }
async function stop(error) {
  if (stopped) return; stopped = true; clearTimeout(idleTimer);
  if (currentFile) await currentFile.handle.close().catch(() => {});
  console.error(error.message); clientSocket.close(); process.exitCode = 1;
}
async function sendClientControl(value) {
  const body = encodeJSON(value); const packet = new Uint8Array(5 + body.length);
  new DataView(packet.buffer).setUint32(0, outputSequence++); packet.set(body, 5);
  clientSocket.send(await encrypt(transferKey, packet, `data:${roomID}:${sessionID}:receiver`));
}
clientSocket.onopen = () => { resetIdle(); clientSocket.send(JSON.stringify({ type: 'join', room: roomID })); };
clientSocket.onerror = () => stop(new Error('Could not connect to Meatproxy.'));
clientSocket.onclose = event => { if (!successful && !stopped) stop(new Error(event.reason ? `Meatproxy closed the connection: ${event.reason}.` : 'The sender disconnected before the handoff finished.')); };
clientSocket.onmessage = event => {
  resetIdle();
  queue = queue.then(async () => {
    if (stopped) return;
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'joined') {
        const hello = { type: 'hello', session: sessionID, relay: true };
        const payload = toBase64(await encrypt(transferKey, encodeJSON(hello), `signal:${roomID}`));
        clientSocket.send(JSON.stringify({ type: 'signal', payload }));
      } else if (msg.type === 'signal') {
        const control = decodeJSON(await decrypt(transferKey, fromBase64(msg.payload), `signal:${roomID}`));
        if (control.type === 'relay' && control.session === sessionID) await sendClientControl({ type: 'ready' });
      } else if (msg.type === 'unavailable') throw new Error('The sender is offline or the link has expired.');
      else if (msg.type === 'busy') throw new Error('Another recipient is connected. Ask them to close their receiving tab.');
      else if (msg.type === 'sender-left') throw new Error(msg.reason ? `The relay closed the sender's connection: ${msg.reason}.` : 'The sender closed their tab.');
      return;
    }
    const plain = await decrypt(transferKey, event.data, `data:${roomID}:${sessionID}:sender`);
    if (plain.length < 5 || new DataView(plain.buffer, plain.byteOffset).getUint32(0) !== inputSequence++) throw new Error('Invalid transfer order.');
    if (plain[4] === 1) {
      if (!currentFile || currentFile.offset + plain.length - 5 > currentFile.meta.size) throw new Error('Unexpected file data.');
      const bytes = plain.slice(5); let written = 0;
      while (written < bytes.length) { const result = await currentFile.handle.write(bytes, written, bytes.length - written); written += result.bytesWritten; }
      currentFile.hash.update(bytes); currentFile.offset += bytes.length;
      if (currentFile.offset % (CHUNK_BYTES * 16) === 0) await sendClientControl({ type: 'ack', id: currentFile.meta.id, offset: currentFile.offset });
      return;
    }
    if (plain[4] !== 0) throw new Error('Unexpected packet type.');
    const control = decodeJSON(plain.slice(5));
    if (control.type === 'manifest') {
      manifest = validateManifest(control.files, manifest);
      console.log(`Receiving ${manifest.length} file(s) through an encrypted relay.`);
    } else if (control.type === 'start') {
      const meta = manifest.find(file => file.id === control.id);
      if (!meta || currentFile || completed.has(meta.id)) throw new Error('Unexpected file start.');
      const safe = meta.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'file';
      let filename = safe; let n = 2;
      while ([...completed.values()].some(file => file.name === filename)) filename = `${n++}-${safe}`;
      const partial = join(outputDir, `.meatproxy-${meta.id}.partial`);
      currentFile = { meta, name: filename, partial, handle: await open(partial, 'wx', 0o600), hash: createHash('sha256'), offset: 0 };
    } else if (control.type === 'end') {
      const file = currentFile;
      if (!file || file.meta.id !== control.id || file.offset !== file.meta.size || file.hash.digest('hex') !== file.meta.sha256) throw new Error('File integrity verification failed.');
      await file.handle.close();
      // A hard link publishes a verified file atomically and refuses to overwrite existing files.
      await linkFile(file.partial, join(outputDir, file.name)); await unlink(file.partial);
      completed.set(file.meta.id, { name: file.name, bytes: file.offset, sha256: file.meta.sha256 }); currentFile = null;
      console.log(`Verified: ${file.name} (${file.offset} bytes)`);
      await sendClientControl({ type: 'received', id: file.meta.id });
    } else if (control.type === 'complete' && manifest.length) {
      if (currentFile || manifest.some(file => !completed.has(file.id))) throw new Error('The handoff is incomplete.');
      successful = true; clearTimeout(idleTimer); clientSocket.close();
      console.log(`Saved to ${outputDir}. Received files have not been executed.`);
    }
  }).catch(stop);
};

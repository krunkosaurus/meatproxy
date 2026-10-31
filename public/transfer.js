import { CHUNK_BYTES } from './protocol.js';

const ACK_BYTES = CHUNK_BYTES * 16;
const READ_BYTES = 1024 * 1024;

// Wake as soon as WebRTC drains its buffer instead of sleeping for 20 ms.
export function waitForDataChannel(channel) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', drained);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
      if (error) reject(error); else resolve();
    };
    const drained = () => finish();
    const closed = () => finish(new Error('The direct connection closed during transfer.'));
    const timer = setTimeout(() => finish(new Error('The receiver stopped responding. Reconnect and try again.')), 30_000);
    channel.addEventListener('bufferedamountlow', drained);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
  });
}

// Stream small files through to the final checksum without stopping for an ACK.
// Larger files pipeline ACKs. Relay traffic stays below the server's 1 MiB buffer.
export async function streamFile(file, { transport, send, waitForAck, onConfirmed }) {
  const window = transport === 'direct' ? 16 : 3;
  const pending = [];
  for (let base = 0; base < file.size; base += READ_BYTES) {
    const block = new Uint8Array(await file.slice(base, Math.min(base + READ_BYTES, file.size)).arrayBuffer());
    for (let offset = 0; offset < block.length; offset += CHUNK_BYTES) {
      const bytes = block.subarray(offset, Math.min(offset + CHUNK_BYTES, block.length));
      const end = base + offset + bytes.length;
      if (end % ACK_BYTES === 0) {
        const ack = waitForAck(end).then(() => onConfirmed(end));
        ack.catch(() => {}); // A pending ACK may reject while another is awaited.
        pending.push(ack);
      }
      await send(bytes);
      if (pending.length >= window && end < file.size) await pending.shift();
    }
  }
  // The caller sends end next and waits for the receiver's verified checksum.
}

export class TransferMeter {
  constructor(bytes = 0, now = performance.now()) {
    this.started = { bytes, now };
    this.samples = [{ bytes, now }];
  }
  update(bytes, total, now = performance.now()) {
    this.samples.push({ bytes, now });
    while (this.samples.length > 2 && this.samples[1].now <= now - 3000) this.samples.shift();
    const first = this.samples[0];
    const seconds = (now - first.now) / 1000;
    const rate = seconds >= 0.5 ? (bytes - first.bytes) / seconds : null;
    const elapsed = (now - this.started.now) / 1000;
    return { rate, remaining: rate > 0 ? Math.ceil((total - bytes) / rate) : null, average: elapsed > 0 ? (bytes - this.started.bytes) / elapsed : 0 };
  }
}

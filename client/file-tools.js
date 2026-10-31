import { sha256 } from '@noble/hashes/sha2.js';

export const READ_BYTES = 1024 * 1024;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const safeName = name => name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '_') || 'file';

export function uniqueName(name, used) {
  const original = safeName(name);
  let result = original, number = 2;
  // Two selected files can have the same name, including on case-insensitive disks.
  while (used.has(result.toLowerCase())) result = `${number++}-${original}`;
  used.add(result.toLowerCase());
  return result;
}

export async function hashFile(file, onProgress = () => {}) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += READ_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + READ_BYTES).arrayBuffer());
      hash.update(bytes);
      onProgress(Math.min(offset + bytes.length, file.size));
    }
    return hex(hash.digest());
  } finally { hash.destroy(); }
}

export class IncomingFile {
  constructor(meta) {
    this.meta = meta;
    this.offset = 0;
    this.hash = sha256.create();
    this.parts = [];
  }
  static async create(meta, directory, name) {
    const file = new IncomingFile(meta);
    if (directory) {
      file.directory = directory;
      file.name = name;
      try {
        file.handle = await directory.getFileHandle(name, { create: true });
        file.writer = await file.handle.createWritable();
      } catch (error) { await file.abort(); throw error; }
    }
    return file;
  }
  async append(bytes) {
    if (this.offset + bytes.length > this.meta.size) throw new Error('The incoming file exceeds its declared size.');
    this.hash.update(bytes);
    if (this.writer) await this.writer.write(bytes);
    else this.parts.push(new Blob([bytes]));
    this.offset += bytes.length;
  }
  async finish() {
    if (this.offset !== this.meta.size || hex(this.hash.digest()) !== this.meta.sha256) {
      await this.abort();
      throw new Error('File verification failed. Please reconnect and try again.');
    }
    this.hash.destroy();
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
      this.saved = true;
      return { blob: await this.handle.getFile(), saved: true };
    }
    const blob = new Blob(this.parts, { type: 'application/octet-stream' });
    this.parts = [];
    return { blob, saved: false };
  }
  async abort() {
    this.hash.destroy();
    this.parts = [];
    if (this.writer) await this.writer.abort().catch(() => {});
    // Only this transfer's unfinished file, inside its newly created folder.
    if (this.handle && !this.saved) await this.directory.removeEntry(this.name).catch(() => {});
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

export async function createZip(items, onProgress = () => {}) {
  const parts = [], directory = [], names = new Set();
  let offset = 0, processed = 0;
  for (const item of items) {
    const filename = new TextEncoder().encode(uniqueName(item.name, names));
    let crc = 0xffffffff;
    for (let start = 0; start < item.blob.size; start += READ_BYTES) {
      const bytes = new Uint8Array(await item.blob.slice(start, start + READ_BYTES).arrayBuffer());
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
      processed += bytes.length; onProgress(processed);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + filename.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
    l.setUint32(14, crc, true); l.setUint32(18, item.blob.size, true); l.setUint32(22, item.blob.size, true);
    l.setUint16(26, filename.length, true); local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true); c.setUint32(20, item.blob.size, true); c.setUint32(24, item.blob.size, true);
    c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); central.set(filename, 46);
    parts.push(local, item.blob); directory.push(central); offset += local.length + item.blob.size;
  }
  const length = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true); e.setUint16(10, items.length, true);
  e.setUint32(12, length, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}

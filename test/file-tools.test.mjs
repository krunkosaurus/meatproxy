import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashFile, IncomingFile, createZip, READ_BYTES } from '../client/file-tools.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const meta = bytes => ({ size: bytes.length, sha256: digest(bytes) });

test('incremental SHA-256 matches Node for empty, partial and multiple blocks without a whole-file read', async () => {
  for (const size of [0, 1, 63, 64, 65, READ_BYTES * 2 + 137]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const blob = new Blob([bytes]);
    const progress = [];
    const source = { size, arrayBuffer: () => assert.fail('Must not read the whole file'), slice: (start, end) => {
      assert.ok(end - start <= READ_BYTES);
      return blob.slice(start, end);
    } };
    assert.equal(await hashFile(source, count => progress.push(count)), digest(bytes));
    if (size) assert.equal(progress.at(-1), size);
  }
});

test('browser receive verifies streamed blocks and retains a Blob, including empty files', async () => {
  for (const bytes of [new Uint8Array(), Uint8Array.from({ length: 700001 }, (_, i) => i % 199)]) {
    const file = await IncomingFile.create(meta(bytes));
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) await file.append(bytes.slice(offset, offset + 256 * 1024));
    const result = await file.finish();
    assert.equal(result.saved, false);
    assert.equal(file.parts.length, 0);
    assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
  }
});

function directoryFixture(existing = []) {
  const events = [], parts = [];
  const names = new Set(existing.map(name => name.normalize('NFC').toLowerCase()));
  const directory = {
    getFileHandle: async (name, { create = false } = {}) => {
      const normalized = name.normalize('NFC').toLowerCase();
      if (!create && !names.has(normalized)) throw new DOMException('Not found', 'NotFoundError');
      if (create) { events.push(['create', name]); names.add(normalized); }
      return {
        createWritable: async () => ({
          write: async bytes => { events.push(['write', bytes.length]); parts.push(bytes.slice()); },
          close: async () => events.push(['commit']),
          abort: async () => events.push(['abort']),
        }),
        getFile: async () => new Blob(parts),
      };
    },
    removeEntry: async name => events.push(['remove', name]),
  };
  return { directory, events };
}

test('folder receive commits only after verification, with no retained payload parts', async () => {
  const bytes = new TextEncoder().encode('verified payload');
  const { directory, events } = directoryFixture();
  const file = await IncomingFile.create(meta(bytes), directory, 'payload.txt');
  await file.append(bytes);
  assert.deepEqual(events, [['create', 'payload.txt'], ['write', bytes.length]]);
  assert.equal(file.parts.length, 0);
  const result = await file.finish();
  assert.equal(result.saved, true);
  assert.equal(await result.blob.text(), 'verified payload');
  assert.deepEqual(events.at(-1), ['commit']);
  await file.abort();
  assert.ok(!events.some(([event]) => event === 'remove'), 'A verified file must survive cleanup');
});

test('filesystem name aliases cannot overwrite an earlier verified file', async () => {
  const bytes = new TextEncoder().encode('new contents');
  const { directory, events } = directoryFixture(['café.txt']);
  const file = await IncomingFile.create(meta(bytes), directory, 'cafe\u0301.txt');
  await file.append(bytes); await file.finish();
  assert.deepEqual(events[0], ['create', '2-cafe\u0301.txt']);
});

test('truncated or corrupt folder receive aborts and removes only its own unfinished file', async () => {
  const bytes = new TextEncoder().encode('original');
  for (const payload of [bytes.slice(0, -1), new Uint8Array(bytes.length)]) {
    const { directory, events } = directoryFixture();
    const file = await IncomingFile.create(meta(bytes), directory, 'unfinished.txt');
    await file.append(payload);
    await assert.rejects(file.finish(), /verification failed/);
    assert.ok(!events.some(([event]) => event === 'commit'));
    assert.deepEqual(events.slice(-2), [['abort'], ['remove', 'unfinished.txt']]);
  }
});

test('oversized receive is refused before writing the excess bytes', async () => {
  const { directory, events } = directoryFixture();
  const file = await IncomingFile.create(meta(new Uint8Array(1)), directory, 'small.bin');
  await assert.rejects(file.append(new Uint8Array(2)), /declared size/);
  assert.ok(!events.some(([event]) => event === 'write'));
  await file.abort();
});

test('ZIP contains intact binary/empty files, UTF-8 names, unique names and correct CRC/directory offsets', async () => {
  const text = new Blob(['123456789']);
  const blob = await createZip([
    { name: '../test.txt', blob: text }, { name: '../TEST.txt', blob: text }, { name: '日本語.txt', blob: new Blob([]) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  const names = []; let offset = 0;
  for (let i = 0; i < 3; i++) {
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 6, true), 0x800);
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true);
    names.push(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length)));
    assert.equal(view.getUint32(offset + 14, true), i < 2 ? 0xcbf43926 : 0);
    assert.equal(new TextDecoder().decode(bytes.subarray(offset + 30 + length, offset + 30 + length + size)), i < 2 ? '123456789' : '');
    offset += 30 + length + size;
  }
  assert.deepEqual(names, ['__test.txt', '2-__TEST.txt', '日本語.txt']);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3);
  assert.equal(view.getUint32(end + 16, true), offset);
  assert.equal(view.getUint32(offset, true), 0x02014b50);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAdditions } from '../public/handoff.js';
import { MAX_BYTES, MAX_FILES } from '../public/protocol.js';

const hash = async file => file.hash;
test('duplicate selections at the byte limit are skipped, while same-name different contents remain distinct', async () => {
  const original = { name: 'large.bin', size: MAX_BYTES, sha256: 'a' };
  const unchanged = await prepareAdditions([original], [{ name: original.name, size: MAX_BYTES, hash: 'a' }], hash);
  assert.equal(unchanged.duplicates, 1);
  assert.deepEqual(unchanged.additions, []);
  const changed = await prepareAdditions([{ name: 'a.txt', size: 1, sha256: 'a' }], [{ name: 'a.txt', size: 1, hash: 'b' }], hash);
  assert.equal(changed.additions.length, 1);
  assert.equal(changed.additions[0].sha256, 'b');
});

test('mixed invalid additions are atomic, oversized files are not hashed, and limits include existing files', async () => {
  const current = [{ id: 'existing', name: 'a', size: 1, sha256: 'a' }];
  let reads = 0;
  const countedHash = async file => { reads++; return file.hash; };
  await assert.rejects(prepareAdditions(current, [{ name: 'b', size: 1, hash: 'b' }, { name: 'huge', size: MAX_BYTES + 1 }], countedHash), /limit/);
  assert.equal(reads, 1);
  assert.deepEqual(current, [{ id: 'existing', name: 'a', size: 1, sha256: 'a' }]);
  await assert.rejects(prepareAdditions(current, [{ name: 'max', size: MAX_BYTES, hash: 'c' }], hash), /total/);
  const full = Array.from({ length: MAX_FILES }, (_, i) => ({ name: String(i), size: 0, sha256: String(i) }));
  await assert.rejects(prepareAdditions(full, [{ name: 'new', size: 0, hash: 'new' }], hash), /101 files/);
  assert.equal((await prepareAdditions(full, [{ name: '0', size: 0, hash: '0' }], hash)).duplicates, 1);
});

test('replacing a note stages a fresh identity and checksum without modifying its original data', async () => {
  const original = { id: 'original', name: 'HANDOFF.md', size: 3, sha256: 'old' };
  const current = [original];
  const { additions } = await prepareAdditions(current.filter(file => file.id !== original.id), [{ name: original.name, size: 4, hash: 'new' }], hash);
  assert.equal(additions.length, 1);
  assert.notEqual(additions[0].id, original.id);
  assert.equal(additions[0].sha256, 'new');
  assert.deepEqual(current, [original]);
});

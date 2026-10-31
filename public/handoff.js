import { MAX_BYTES, MAX_FILES } from './protocol.js';

const size = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

// Stage atomically: a rejected selection must leave the existing handoff intact.
export async function prepareAdditions(existing, incoming, hash) {
  const additions = [];
  let duplicates = 0, total = existing.reduce((sum, file) => sum + file.size, 0);
  for (const file of incoming) {
    if (file.size > MAX_BYTES) throw new Error(`This file is ${size(file.size)}. The limit is ${size(MAX_BYTES)}.`);
    const sha256 = await hash(file);
    if ([...existing, ...additions].some(item => item.name === file.name && item.size === file.size && item.sha256 === sha256)) { duplicates++; continue; }
    const count = existing.length + additions.length + 1;
    if (count > MAX_FILES) throw new Error(`This handoff would contain ${count} files. The limit is ${MAX_FILES}.`);
    total += file.size;
    if (total > MAX_BYTES) throw new Error(`This handoff would total ${size(total)}. The limit is ${size(MAX_BYTES)}.`);
    additions.push({ id: crypto.randomUUID(), file, name: file.name, size: file.size, sha256, state: 'Ready to send' });
  }
  return { additions, duplicates };
}

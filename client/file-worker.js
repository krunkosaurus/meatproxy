import { hashFile, IncomingFile, createZip } from './file-tools.js';

const incoming = new Map();
let queue = Promise.resolve();
self.onmessage = ({ data: { id, type, payload } }) => {
  queue = queue.then(async () => {
    const progress = bytes => self.postMessage({ id, progress: bytes });
    try {
      let result;
      if (type === 'hash') result = await hashFile(payload.file, progress);
      else if (type === 'zip') result = await createZip(payload.items, progress);
      else if (type === 'begin') {
        incoming.set(payload.token, await IncomingFile.create(payload.meta, payload.directory, payload.name));
      } else if (type === 'append') await incoming.get(payload.token).append(payload.bytes);
      else if (type === 'finish') {
        result = await incoming.get(payload.token).finish();
        incoming.delete(payload.token);
      } else if (type === 'abort') {
        await incoming.get(payload.token)?.abort();
        incoming.delete(payload.token);
      }
      self.postMessage({ id, result });
    } catch (error) {
      if (payload.token) {
        await incoming.get(payload.token)?.abort();
        incoming.delete(payload.token);
      }
      self.postMessage({ id, error: error.message });
    }
  });
};

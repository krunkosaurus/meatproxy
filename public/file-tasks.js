// Separate instances keep ZIP preparation from delaying incoming transfer ACKs.
export class FileTasks {
  constructor() { this.pending = new Map(); this.sequence = 0; }
  run(type, payload, { transfer = [], onProgress } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.worker) {
      this.worker = new Worker('/file-worker.js', { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        if (!task) return; // A worker error may already have rejected its tasks.
        if ('progress' in data) { task.onProgress?.(data.progress); return; }
        this.pending.delete(data.id);
        if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
      };
      this.worker.onerror = () => {
        this.failure = new Error('File processing stopped. Reload this page and try again.');
        for (const task of this.pending.values()) task.reject(this.failure);
        this.pending.clear(); this.worker.terminate();
      };
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try { this.worker.postMessage({ id, type, payload }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}

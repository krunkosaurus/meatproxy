// DOM integration fixture: actual application, WebSocket relay and generated worker.
// This does not emulate CSS layout, a native file picker, or a WebRTC connection.
import { parentPort, workerData, Worker as Thread } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const { document, HTMLElement, HTMLAnchorElement } = parseHTML(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
const location = new URL(workerData.url), downloads = [];
let clipboard = '';
HTMLElement.prototype.focus = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
HTMLAnchorElement.prototype.click = function () { downloads.push({ url: this.href, name: this.download }); };
Object.assign(globalThis, {
  document, location,
  window: { addEventListener() {} },
  history: { replaceState: (_, __, path) => { location.href = new URL(path, location).href; } },
  matchMedia: () => ({ matches: false }),
  Worker: class {
    constructor() {
      this.thread = new Thread(`
        const { parentPort } = require('node:worker_threads');
        globalThis.self = { postMessage: data => parentPort.postMessage(data) };
        import(${JSON.stringify(new URL('../public/file-worker.js', import.meta.url).href)}).then(() => parentPort.on('message', data => self.onmessage({ data })));
      `, { eval: true });
      this.thread.on('message', data => this.onmessage?.({ data }));
      this.thread.on('error', error => this.onerror?.(error));
    }
    postMessage(data, transfer) {
      if (data.type === 'append' && workerData.receiveDelay) setTimeout(() => this.thread.postMessage(data, transfer), workerData.receiveDelay);
      else if (data.type === 'hash' && workerData.hashDelay) setTimeout(() => this.thread.postMessage(data, transfer), workerData.hashDelay);
      else this.thread.postMessage(data, transfer);
    }
    terminate() { this.thread.terminate(); }
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { clipboard = text; } } } });
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => nativeFetch(new URL(url, location), options);

await import('../public/app.js');
const $ = id => document.getElementById(id);
parentPort.on('message', async ({ id, command, ...args }) => {
  try {
    let result;
    if (command === 'snapshot') result = {
      link: $('share-link').value, status: $('status').textContent, detail: $('status-detail').textContent, notice: $('notice').textContent,
      feedback: $('add-feedback').textContent, summary: $('queue-summary').textContent,
      mobile: { label: $('mobile-action').textContent, disabled: $('mobile-action').disabled, action: $('mobile-action').dataset.action },
      rows: [...document.querySelectorAll('.file-row')].map(row => ({
        name: row.querySelector('.file-name').textContent, detail: row.querySelector('small').textContent,
        buttons: [...row.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label'), disabled: button.disabled })),
      })),
      note: $('note').value, editing: !$('cancel-note').hidden, clipboard,
    };
    else if (command === 'add') {
      const files = args.files.map(({ name, size, byte = 71 }) => new File([new Uint8Array(size).fill(byte)], name));
      $('file-input').onchange({ target: { files, value: '' } });
    } else if (command === 'note') { $('note').value = args.text; await $('add-note').onclick(); }
    else if (command === 'click') {
      const element = args.element ? $(args.element) : [...document.querySelectorAll('button,a')].find(button => button.getAttribute('aria-label') === args.label);
      if (!element || element.disabled) throw new Error('Control is unavailable');
      if (element.onclick) await element.onclick(); else element.click();
    } else if (command === 'downloads') {
      result = await Promise.all(downloads.map(async ({ url, name }) => {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const entries = [], view = new DataView(bytes.buffer);
        if (name.endsWith('.zip')) {
          for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
            const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true);
            const start = offset + 30 + length;
            entries.push({ name: new TextDecoder().decode(bytes.subarray(offset + 30, start)), sha256: createHash('sha256').update(bytes.subarray(start, start + size)).digest('hex') });
            offset = start + size;
          }
        }
        return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), entries };
      }));
    }
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: error.stack }); }
});
parentPort.postMessage({ ready: true });

import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { streamFile, TransferMeter, waitForDataChannel } from '../public/transfer.js';

test('direct backpressure resumes on buffer drain and rejects a disconnected channel', async () => {
  const channel = new EventTarget();
  let resumed = false;
  const waiting = waitForDataChannel(channel).then(() => { resumed = true; });
  await setImmediate(); assert.equal(resumed, false);
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await waiting; assert.equal(resumed, true);
  const disconnected = waitForDataChannel(channel);
  channel.dispatchEvent(new Event('close'));
  await assert.rejects(disconnected, /connection closed/);
});

for (const [transport, windowBytes] of [['direct', 4 * 1024 ** 2], ['relay', 768 * 1024]]) {
  test(`${transport}: a file that fits the window reaches its final checksum without waiting for chunk ACKs`, { timeout: 1000 }, async () => {
    const file = new Blob([new Uint8Array(windowBytes)]);
    let sent = 0;
    await streamFile(file, {
      transport,
      send: async bytes => { assert.ok(bytes.length <= 16 * 1024); sent += bytes.length; },
      waitForAck: () => new Promise(() => {}),
      onConfirmed: () => assert.fail('No intermediate ACK was supplied'),
    });
    assert.equal(sent, file.size);
  });

  test(`${transport}: a slow recipient cannot accumulate more than the bounded window`, { timeout: 1000 }, async () => {
    const source = Uint8Array.from({ length: windowBytes + 1024 ** 2 + 7 }, (_, i) => i % 251);
    const file = new Blob([source]);
    const acknowledgements = new Map();
    const parts = [];
    let sent = 0, confirmed = 0, maximum = 0, released = false, fill;
    const filled = new Promise(resolve => { fill = resolve; });
    const task = streamFile(file, {
      transport,
      waitForAck: offset => new Promise(resolve => { acknowledgements.set(offset, resolve); }),
      onConfirmed: offset => { confirmed = offset; },
      send: async bytes => {
        parts.push(bytes); sent += bytes.length; maximum = Math.max(maximum, sent - confirmed);
        if (sent === windowBytes) fill();
        if (released && acknowledgements.has(sent)) acknowledgements.get(sent)();
      },
    });
    await filled; await setImmediate();
    assert.equal(sent, windowBytes, 'Sender must pause at its memory bound');
    released = true;
    for (const resolve of acknowledgements.values()) resolve();
    await task;
    assert.ok(maximum <= windowBytes);
    assert.deepEqual(Buffer.concat(parts), Buffer.from(source), 'Every byte and the final partial chunk survive');
  });
}

test('transfer rate and ETA reflect recent bytes, including a stalled transfer', () => {
  const meter = new TransferMeter(0, 0);
  assert.equal(meter.update(0, 4096, 0).rate, null);
  assert.deepEqual(meter.update(1024, 4096, 500), { rate: 2048, remaining: 2, average: 2048 });
  meter.update(2048, 4096, 1000);
  meter.update(2048, 4096, 3500);
  const stalled = meter.update(2048, 4096, 4000);
  assert.equal(stalled.rate, 0);
  assert.equal(stalled.remaining, null);
});

test('a new batch estimates only newly transferred bytes', () => {
  const meter = new TransferMeter(1024, 5000);
  const stats = meter.update(2048, 4096, 6000);
  assert.equal(stats.rate, 1024);
  assert.equal(stats.average, 1024);
  assert.equal(stats.remaining, 2);
});

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { PresentationEventQueue } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../index.js', import.meta.url));
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const eventsPerTick of [1, 200]) {
  const times = [], heaps = [];
  for (let run = 0; run < 7; run++) {
    globalThis.gc?.(); const beforeHeap = process.memoryUsage().heapUsed, start = performance.now();
    const queue = new PresentationEventQueue({ retentionTicks: 120, adapters: { hit: { start() {} } } });
    for (let tick = 0; tick < 1000; tick++) {
      queue.confirmThrough(tick);
      for (let sequence = 0; sequence < eventsPerTick; sequence++) queue.emit({ tick, sequence, entityId: sequence, generation: 1, kind: 'hit', durationMs: 0 });
      queue.update(tick);
    }
    times.push(performance.now() - start); globalThis.gc?.();
    if (globalThis.gc) heaps.push(process.memoryUsage().heapUsed - beforeHeap);
    queue.dispose();
  }
  console.log(JSON.stringify({ environment: `Node ${process.version}`, scope: 'CPU fixture only; no renderer, GPU or browser FPS measurement', ticks: 1000, eventsPerTick, retentionTicks: 120, medianCpuMs: median(times), retainedHeapDeltaBytes: heaps.length ? median(heaps) : null }));
}

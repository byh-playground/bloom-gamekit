import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Optional source path permits the same workload against a baseline revision.
const { PerformanceProfiler } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../index.js', import.meta.url));
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(operation) {
  const times = [], heaps = [];
  for (let run = 0; run < 7; run++) {
    globalThis.gc?.();
    const beforeHeap = process.memoryUsage().heapUsed, start = performance.now();
    const profile = operation();
    times.push(performance.now() - start);
    globalThis.gc?.();
    if (globalThis.gc) heaps.push(process.memoryUsage().heapUsed - beforeHeap);
    profile?.dispose();
  }
  return { medianCpuMs: median(times), retainedHeapDeltaBytes: heaps.length ? median(heaps) : null };
}
for (const capacity of [30, 1000]) {
  const frames = measure(() => {
    let clock = 0; const profile = new PerformanceProfiler({ capacity, now: () => ++clock }); profile.setEnabled(true);
    for (let index = 0; index < 100000; index++) { profile.beginFrame(); profile.endFrame(); }
    return profile;
  });
  let clock = 0; const profile = new PerformanceProfiler({ capacity, now: () => ++clock }); profile.setEnabled(true);
  for (let index = 0; index < capacity; index++) { profile.beginFrame(); for (let stage = 0; stage < 16; stage++) profile.stage(`stage${stage}`, (index * 13 + stage) % 83); profile.endFrame(); }
  const snapshots = measure(() => { for (let index = 0; index < 500; index++) profile.snapshot({ limit: 30 }); });
  console.log(JSON.stringify({ environment: `Node ${process.version}`, scope: 'CPU fixture only; no renderer, GPU or browser FPS measurement', capacity, frameCount: 100000, snapshotCount: 500, stageNames: 16, frames, snapshots }));
  profile.dispose();
}

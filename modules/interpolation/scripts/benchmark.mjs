import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { InterpolationTimeline } from '../../../dist/interpolation.js';
const summary = { runtime: process.version };
// Informational microbenchmark, not FPS. Includes Map lookup, sample writes and call overhead.
const count = 256, frames = 2000;
const bench = new InterpolationTimeline({ stepMs: 100, schema: { x: 'number', y: 'number', z: 'number' } });
const entities = Array.from({ length: count }, (_, i) => ({ id: String(i), generation: 0, values: { x: i, y: i, z: i } }));
const outputs = entities.map(() => ({}));
const input = sequence => ({ revision: 0, sequence, timeMs: sequence * 100, entities });
const accepts = [], samples = new Float64Array(frames);
bench.accept(input(0), 0);
for (let f = 0; f < 200; f++) for (let i = 0; i < count; i++) bench.sampleInto(entities[i].id, 0, f, outputs[i]);
const heapBefore = process.memoryUsage().heapUsed;
for (let f = 0; f < frames; f++) {
  const now = 200 + f;
  if (f % 100 === 0) { const start = performance.now(); bench.accept(input(f + 1), now); accepts.push(performance.now() - start); }
  const start = performance.now();
  for (let i = 0; i < count; i++) bench.sampleInto(entities[i].id, 0, now, outputs[i]);
  samples[f] = performance.now() - start;
}
const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
samples.sort(); accepts.sort((a,b) => a-b);
summary.benchmark = { entities: count, frames, sampleBatchMs: { p50: samples[Math.floor(frames * .5)], p95: samples[Math.floor(frames * .95)] }, acceptBatchMs: { p50: accepts[Math.floor(accepts.length * .5)], p95: accepts[Math.floor(accepts.length * .95)] }, heapDeltaBytes, allocationContract: '256 caller outputs reused; accept allocates one Map and two field arrays plus one track per entity. Heap delta includes GC and benchmark bookkeeping, is not total allocation or a zero-allocation proof.', scope: 'Node CPU only; not browser FPS, GPU, mobile, or renderer performance.' };
// Statistical allocation sampling includes collected objects; isolate library stacks.
const inspector = new Session(); inspector.connect();
const post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
await post('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
for (let f = 0; f < 1000; f++) {
  const now = 3000 + f;
  if (f % 10 === 0) bench.accept(input(3000 + f), now);
  for (let i = 0; i < count; i++) bench.sampleInto(entities[i].id, 0, now, outputs[i]);
}
const { profile } = await post('HeapProfiler.stopSampling'); inspector.disconnect();
const allocation = { accept: 0, sampleInto: 0 };
function countAllocations(node, owner = null) {
  if (node.callFrame.functionName === 'accept' || node.callFrame.functionName === 'sampleInto') owner = node.callFrame.functionName;
  if (owner) allocation[owner] += node.selfSize;
  for (const child of node.children) countAllocations(child, owner);
}
countAllocations(profile.head);
summary.benchmark.allocationSampling = { intervalBytes: 1024, accepts: 100, samples: 256000, estimatedBytesUnderLibraryStacks: allocation, caveat: 'V8 statistical estimates, including collected objects; a zero estimate is below sampling resolution, not a no-allocation guarantee.' };
// Optional seed/mask accept cost is reported separately from unchanged sampling.
const seededEntities = entities.map(entity => ({ ...entity, initialValues: entity.values, resetFields: ['z'] }));
const seededAccepts = [];
for (let generation = 0; generation < 100; generation++) {
  for (const entity of seededEntities) entity.generation = generation + 1;
  const snapshot = { revision: 0, sequence: 10000 + generation, timeMs: (10000 + generation) * 100, entities: seededEntities };
  const start = performance.now(); const accepted = bench.accept(snapshot, 10000 + generation); seededAccepts.push(performance.now() - start);
  assert.equal(accepted, true);
}
seededAccepts.sort((a, b) => a - b);
summary.benchmark.newIdentityWithSeedAndMaskBatchMs = { entities: count, accepts: 100, p50: seededAccepts[50], p95: seededAccepts[95], scope: 'Optional feature cost; each entity has 3 seed fields and 1 reset field. Input preparation excluded; CPU only.' };
console.log(JSON.stringify(summary, null, 2));

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { InterpolationTimeline } from '../dist/interpolation.js';
import { createPresentation } from '../examples/interpolation/demo.js';

const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/worker-motion.json', import.meta.url)));
const values = x => ({ x, y: 1800, z: 0, health: 100, angle: 0, state: 'walking' });
const entity = (x, generation = 0) => ({ id: 'actor', generation, values: values(x) });
const packet = (sequence, x, extra = {}) => ({ revision: 0, sequence, timeMs: sequence * 100, entities: [entity(x)], ...extra });
const summary = { fixture: fixture.source, stages: [], runtime: process.version };

// One continuous integration harness: authority -> example adapter -> built package -> consumers.
// Start with the real 10 TPS Worker stream, then exercise changing arrival phases/rates.
for (const tps of [10, 20, 30]) {
  const step = 1000 / tps;
  for (const phase of [0, 1, 5, 10, 15]) {
    const app = createPresentation(step);
    const arrivals = fixture.samples.map((s, i) => ({ at: i * step + phase, x: s.x, sequence: i }));
    let next = 0, previous = null;
    const deltas = [];
    for (let now = 0; now < arrivals.at(-1).at; now += 1000 / 60) {
      while (next < arrivals.length && arrivals[next].at <= now + 1e-8) {
        const s = arrivals[next++]; app.receive(packet(s.sequence, s.x), Math.min(now, s.at));
      }
      const pose = app.frame(now);
      if (pose && previous !== null && now > phase + step * 2) deltas.push(pose.x - previous);
      previous = pose?.x ?? null;
    }
    const expected = 14 / (60 / tps);
    for (const delta of deltas) close(delta, expected);
  }
}
summary.stages.push('10/20/30 TPS × 60 Hz arrival phases: receipt-curve retarget; 10 TPS = 2.333333 units/frame');

const app = createPresentation(100); const out = app.pose;
const source = packet(0, 0); const before = JSON.stringify(source);
app.receive(source, 0); assert.equal(app.frame(0), out);
app.receive(packet(1, 14), 100); close(app.frame(150).x, 7);
// Freeze only a game-owned body animation value; never replace root pose with raw authority.
let bodyAnimationTime = 25;
const pose = app.frame(180); const camera = pose.x, shadow = pose.x, bodyRoot = pose.x;
assert.equal(camera, shadow); assert.equal(shadow, bodyRoot); assert.equal(bodyAnimationTime, 25);
const heldRoot = app.frame(190).x; assert.ok(heldRoot > bodyRoot); assert.equal(bodyAnimationTime, 25);
// Resume animation without resetting the moving root or switching it to authority.
bodyAnimationTime += 5; const resumedRoot = app.frame(195).x;
close(resumedRoot - heldRoot, 0.7); assert.equal(bodyAnimationTime, 30);
// Irregular 130/70 ms arrivals: a 30ms hold is an honest underflow, no extrapolation.
close(app.frame(200).x, 14); close(app.frame(225).x, 14);
app.receive(packet(2, 28), 230); close(app.frame(230).x, 14);
close(app.frame(299).x, 23.66);
app.receive(packet(3, 42), 300); close(app.frame(300).x, 23.8);
assert.equal(app.receive(packet(3, 999), 300), false);
assert.equal(app.receive(packet(2, 999), 300), false);
app.receive(packet(4, 56), 300); app.receive(packet(5, 70), 300);
close(app.frame(300).x, 23.8); close(app.frame(350).x, 46.9);
close(app.frame(500).x, 70); close(app.frame(700).x, 70);
summary.stages.push('130/70ms jitter, holds, coalesced latest retarget, duplicates/reordering, no extrapolation');

// Every failure must leave the entire accepted world and clock unchanged.
const invalid = packet(6, 84); invalid.entities.push({ id: 'broken', generation: 0, values: values(NaN) });
assert.throws(() => app.receive(invalid, 800), /finite/);
close(app.frame(710).x, 70); assert.equal(app.timeline.size, 1);
assert.throws(() => app.receive(packet(6, 84, { entities: [{ ...entity(84), values: { x: 84 } }] }), 800), /missing field/);
assert.throws(() => app.receive(packet(6, 84, { entities: [entity(84), entity(85)] }), 800), /duplicate/);
assert.throws(() => app.frame(709), /backwards/);
for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => app.receive(packet(6, bad), 800), /finite/);
assert.equal(JSON.stringify(source), before);
const frozen = packet(6, 84); Object.freeze(frozen.entities[0].values); Object.freeze(frozen.entities[0]); Object.freeze(frozen.entities); Object.freeze(frozen);
app.receive(frozen, 800); close(app.frame(850).x, 77);
assert.throws(() => app.receive(packet(0, -5, { revision: 1 }), 900), /new revision/);
app.receive(packet(0, -5, { revision: 1, mode: 'rollback', timeMs: -200 }), 900);
close(app.frame(900).x, -5); assert.equal(app.receive(packet(99, 999), 900), false);
app.receive(packet(1, 400, { revision: 1, entities: [{ ...entity(400), teleport: true }] }), 950);
close(app.frame(950).x, 400);
app.receive(packet(0, 10, { revision: 2, mode: 'load' }), 1000); close(app.frame(1000).x, 10);
app.receive(packet(0, 20, { revision: 3, mode: 'reset' }), 1100); close(app.frame(1100).x, 20);
app.receive(packet(1, 0, { revision: 3, entities: [] }), 1200); assert.equal(app.frame(1200), null);
app.receive(packet(2, 0, { revision: 3, entities: [entity(500, 1)] }), 1300);
assert.equal(app.frame(1300), null); assert.ok(app.timeline.sampleInto('actor', 1, 1300, out)); close(out.x, 500);
const untouched = { x: 123 };
assert.equal(app.timeline.sampleInto('actor', 0, 1300, untouched), false); close(untouched.x, 123);
assert.equal(app.timeline.sampleInto('missing', 1, 1300, untouched), false); close(untouched.x, 123);
app.receive(packet(3, 0, { revision: 3, entities: [entity(600, 2)] }), 1400);
assert.ok(app.timeline.sampleInto('actor', 2, 1400, out)); close(out.x, 600);
assert.equal(app.receive(packet(4, 0, { revision: 3, timeMs: 299, entities: [entity(800, 2)] }), 1500), false);
assert.ok(app.timeline.sampleInto('actor', 2, 1410, out)); close(out.x, 600);
assert.ok(app.receive(packet(4, 0, { revision: 3, timeMs: 300, entities: [entity(700, 2)] }), 1500));
summary.stages.push('atomic finite validation, source immutability, rollback revision, teleport, load/reset, despawn/generation reuse');

const timeline = new InterpolationTimeline({ stepMs: 100, schema: { angle: 'angle', health: 'number', progress: 'number', state: 'discrete' } });
const scalarPacket = (sequence, angle, health, progress, state) => ({ revision: 0, sequence, timeMs: sequence, entities: [{ id: 'a', generation: 0, values: { angle, health, progress, state } }] });
timeline.accept(scalarPacket(0, Math.PI * 350 / 180, 100, 0, 'idle'), 0);
timeline.accept(scalarPacket(1, Math.PI * 10 / 180, 0, 1, 'walking'), 10);
timeline.sampleInto('a', 0, 60, out); close(out.angle, 0); close(out.health, 50); close(out.progress, 0.5); assert.equal(out.state, 'walking');
timeline.accept(scalarPacket(2, 1.72, 100, 0, 'idle'), 200);
// Teleport the starting angle explicitly, then test a nonzero-origin half-turn tie.
const tieStart = scalarPacket(3, 1.72, 100, 0, 'idle'); tieStart.entities[0].teleport = true;
timeline.accept(tieStart, 300);
timeline.accept(scalarPacket(4, 1.72 + Math.PI, 100, 0, 'idle'), 300);
timeline.sampleInto('a', 0, 350, out); close(out.angle, 1.72 - Math.PI / 2);
const negativeTie = scalarPacket(5, -3.999, 100, 0, 'idle'); negativeTie.entities[0].teleport = true;
timeline.accept(negativeTie, 360); timeline.accept(scalarPacket(6, -3.999 + Math.PI, 100, 0, 'idle'), 360);
timeline.sampleInto('a', 0, 410, out); close(out.angle, -3.999 - Math.PI / 2 + Math.PI * 2);
const tiny = scalarPacket(7, -1e-16, 100, 0, 'idle'); tiny.entities[0].teleport = true;
timeline.accept(tiny, 420); timeline.sampleInto('a', 0, 420, out);
assert.ok(out.angle >= 0 && out.angle < Math.PI * 2);
const extremes = new InterpolationTimeline({ stepMs: 1, schema: { x: 'number' } });
const extremep = (sequence, x) => ({ revision: 0, sequence, timeMs: sequence, entities: [{ id: 'a', generation: 0, values: { x } }] });
extremes.accept(extremep(0, -Number.MAX_VALUE), 0); extremes.accept(extremep(1, Number.MAX_VALUE), 0); extremes.sampleInto('a', 0, 0.5, out); close(out.x, 0);
summary.stages.push('shortest radian angle, discrete arrival switch, health/progress, finite extreme-number interpolation');

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
console.log(JSON.stringify(summary, null, 2));

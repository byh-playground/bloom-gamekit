import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run: node --expose-gc scripts/benchmark-reviewed.mjs /path/to/baseline-checkout [current-checkout]
if (!process.argv[2]) throw Error('Provide the baseline source checkout path');
const baseline = resolve(process.argv[2]), current = resolve(process.argv[3] ?? '.');
// Accept both the pinned pre-restructure baseline and the module-first source tree.
const load = (root, path) => {
  const legacy = path.replace(/^modules\/([^/]+)\//, 'packages/$1/src/');
  return import(pathToFileURL(resolve(root, existsSync(resolve(root, path)) ? path : legacy)).href);
};
const beforeEvents = await load(baseline, 'modules/presentation-events/index.js');
const afterEvents = await load(current, 'modules/presentation-events/index.js');
const beforeLoop = await load(baseline, 'modules/simloop/loop.js');
const afterLoop = await load(current, 'modules/simloop/loop.js');
const { createSession } = await load(current, 'modules/rollback/core.js');

function presentation(Before, After) {

if (!global.gc) throw Error('Run with node --expose-gc');
const EVENTS_PER_TICK = 200, TICKS = 120, REPEATS = 60, SAMPLES = 7;
function fixture(Queue, instrument = false) {
  const q = new Queue({ retentionTicks: 120, maxPending: 25000, adapters: { hit: { start() {} } } });
  const counters = { releaseCalls: 0, tombstoneObjects: 0, journalScans: 0 };
  if (instrument) {
    const release = q._release, values = q.records.values, entries = q.records[Symbol.iterator];
    q._release = function (record) {
      counters.releaseCalls++;
      const previous = record.event;
      release.call(this, record);
      if (previous !== record.event) counters.tombstoneObjects++;
    };
    q.records.values = function () { counters.journalScans++; return values.call(this); };
    q.records[Symbol.iterator] = function () { counters.journalScans++; return entries.call(this); };
  }
  const payload = { actor: { history: new Array(1000).fill('state') } };
  for (let tick = 0; tick < TICKS; tick++) {
    q.confirmThrough(tick);
    for (let sequence = 0; sequence < EVENTS_PER_TICK; sequence++) {
      q.emit({ tick, sequence, entityId: sequence, generation: 1, kind: 'hit', durationMs: 0, payload });
    }
  }
  assert.equal(q.size, 24000); assert.equal(q.active.size, 0); assert.equal(q.stats.started, 24000);
  return { q, counters };
}
function repeated(q) { for (let i = 0; i < REPEATS; i++) q.confirmThrough(TICKS - 1); }
function advancing(q) { for (let tick = TICKS; tick < TICKS + REPEATS; tick++) q.confirmThrough(tick); }
function measure(fn) {
  const cpu = process.cpuUsage(), start = performance.now();
  const value = fn();
  const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
  return { value, elapsedMs: wallMs, processCpuMs: (used.user + used.system) / 1000 };
}
function run(Queue) {
  global.gc(); const heapBefore = process.memoryUsage().heapUsed;
  const setup = measure(() => fixture(Queue)), { q } = setup.value;
  global.gc(); const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
  const sameTick = measure(() => repeated(q));
  assert.equal(q.size, 24000); assert.equal(q.stats.started, 24000);
  const advanceTicks = measure(() => advancing(q));
  assert.equal(q.size, 12000); assert.equal(q.stats.collected, 12000);
  q.dispose();
  const timing = ({ elapsedMs, processCpuMs }) => ({ elapsedMs, processCpuMs });
  return { setup: timing(setup), sameTick: timing(sameTick), advanceTicks: timing(advanceTicks), retainedHeapBytes };
}
function allocationCounts(Queue) {
  const { q, counters } = fixture(Queue, true);
  const setup = { ...counters };
  const reset = () => { for (const name of Object.keys(counters)) counters[name] = 0; };
  reset(); repeated(q); const sameTick = { ...counters };
  reset(); advancing(q); const advanceTicks = { ...counters };
  q.dispose(); return { setup, sameTick, advanceTicks };
}
for (let warmup = 0; warmup < 2; warmup++) { run(Before); run(After); }
const samples = { before: [], after: [] };
for (let sample = 0; sample < SAMPLES; sample++) {
  for (const label of (sample % 2 ? ['after', 'before'] : ['before', 'after'])) samples[label].push(run(label === 'before' ? Before : After));
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function summary(label, Queue) {
  const medianTimings = Object.fromEntries(['setup', 'sameTick', 'advanceTicks'].map(phase => [phase, {
    elapsedMs: median(samples[label].map(x => x[phase].elapsedMs)),
    processCpuMs: median(samples[label].map(x => x[phase].processCpuMs)),
  }]));
  return { median: { ...medianTimings, retainedHeapBytes: median(samples[label].map(x => x.retainedHeapBytes)) }, exactInstrumentedCounts: allocationCounts(Queue), samples: samples[label] };
}
return {
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model },
  fixture: { events: 24000, ticks: TICKS, eventsPerTick: EVENTS_PER_TICK, unchangedConfirmations: REPEATS, advancingConfirmations: REPEATS, samples: SAMPLES, warmupsPerVersion: 2 },
  scope: 'Node synchronous CPU/allocation fixture only, not browser/mobile/GPU FPS. Timings are uninstrumented; exact tombstone object replacements and journal iterator calls are counted in a separate equal fixture. Retained heap is post-GC and includes queue metadata; it is not total allocation.',
  before: summary('before', Before), after: summary('after', After),
};

}
function pacing(oldLoop, newLoop) {
  const pulses = 20000, input = new Uint8Array(1), result = { status: 'advanced' };
  function run(createLoop, instrument = false) {
    const state = new Uint8Array([0]);
    const session = createSession({players:['a'], localPlayerId:'a', sessionId:'bench', simulationVersion:'1', inputSize:1,
      adapter:{save:()=>state, load(){}, step(){}, validateSnapshot:()=>true}, profile:{tickRate:20, maxCatchupSteps:5}});
    let snapshots = 0, steps = 0;
    if (instrument) {
      const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), 'metrics').get;
      Object.defineProperty(session, 'metrics', {get(){snapshots++; return getter.call(this)}});
    }
    session.poll = () => {};
    session.advance = () => {steps++; return result};
    const loop = createLoop({session, getInput:()=>input});
    loop.pulse(0); snapshots = 0;
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 1; i <= pulses; i++) loop.pulse(i * 250);
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    assert.equal(steps, pulses * 5); session.close();
    return {elapsedMs, processCpuMs:(used.user + used.system) / 1000, snapshots, steps};
  }
  for (let i = 0; i < 2; i++) {run(oldLoop); run(newLoop)}
  const samples = {before:[], after:[]};
  for (let i = 0; i < 7; i++) {
    for (const label of (i % 2 ? ['after','before'] : ['before','after'])) samples[label].push(run(label === 'before' ? oldLoop : newLoop));
  }
  const median = xs => [...xs].sort((a,b)=>a-b)[3];
  const summary = (label, loop) => ({
    median:{elapsedMs:median(samples[label].map(x=>x.elapsedMs)), processCpuMs:median(samples[label].map(x=>x.processCpuMs))},
    metricsSnapshots:run(loop, true).snapshots, steps:pulses*5, samples:samples[label],
  });
  return {pulses, stepsPerPulse:5, before:summary('before',oldLoop), after:summary('after',newLoop),
    scope:'Node isolated pacing overhead; real RollbackSession.metrics getter, poll/advance stubbed equally. Uninstrumented timing; snapshot getter counts measured separately. Not full game/browser/FPS.'};
}
console.log(JSON.stringify({baseline, current,
  presentation:presentation(beforeEvents.PresentationEventQueue, afterEvents.PresentationEventQueue),
  pacing:pacing(beforeLoop.createLoop, afterLoop.createLoop)}, null, 2));

import assert from 'node:assert/strict';
import { OrthographicProjection, CameraViewport } from '../dist/camera.js';
import { PresentationEventQueue } from '../dist/presentation-events.js';
import { resolveAnchorInto } from '../dist/hud.js';
import { DiagnosticRing, redactDiagnostic, copyDiagnostic, ReplayTimeline, compareStateFields } from '../dist/debug-tools.js';
const projection = new OrthographicProjection();
const camera = new CameraViewport({ projection, width: 640, height: 360, dpr: 2, left: 17, top: 29, x: 30, y: 20, zoom: 1.4, rotation: .3 });
camera.setShake(5, -3);
const screen = {}, ground = {}, plane = {};
camera.worldToScreenInto(72, 105, 13, screen); camera.screenToGroundInto(screen.x, screen.y, ground, { z: 13 });
assert.ok(Math.abs(ground.x - 72) < 1e-10 && Math.abs(ground.y - 105) < 1e-10);
const rc = camera.rendererCameraInto({}); projection.projectInto(72, 105, 13, plane);
assert.ok(Math.abs((Math.cos(rc.rotation) * (plane.x - rc.x) + Math.sin(rc.rotation) * (plane.y - rc.y)) * rc.zoom + 320 - screen.x) < 1e-10);
assert.equal(camera.screenToGroundInto(screen.x, screen.y, ground, { intersect: (x, y, p, out) => { p.groundInto(x, y, out, 13); return true; } }), true);
assert.throws(() => camera.setCamera({ zoom: 0 }));
const before = { ...camera.camera }; assert.throws(() => camera.setCamera({ x: 1, zoom: NaN })); assert.deepEqual(camera.camera, before);
const anchor = resolveAnchorInto(camera, { space: 'screen', x: -100, y: 700, clamp: true, margin: 10 }, {});
assert.deepEqual(anchor, { x: 10, y: 350, onScreen: false, visible: true });
let sounds = 0, starts = 0, cancels = 0, reconciles = 0, stops = 0;
const queue = new PresentationEventQueue({ retentionTicks: 2, adapters: {
  hit: { reversible: true, start: () => { starts++; return {}; }, stop: (_, reason) => { stops++; if (reason === 'cancelled') cancels++; }, reconcile: () => reconciles++ },
  sound: { start: () => { sounds++; } },
} });
const hit = { tick: 5, sequence: 1, entityId: 'mob', generation: 2, kind: 'hit', policy: 'speculative', durationMs: 150 };
const sound = { ...hit, kind: 'sound', policy: 'confirmed', durationMs: 200 };
queue.emit(hit); queue.emit(sound); queue.emit(hit); assert.equal(starts, 1); assert.equal(sounds, 0);
queue.beginRollback(5); queue.emit({ ...hit, payload: { damage: 20 } }); queue.emit(sound); queue.endRollback();
assert.equal(starts, 1); assert.equal(reconciles, 2); assert.equal(cancels, 0);
queue.beginRollback(5); queue.endRollback(); assert.equal(cancels, 1); assert.equal(sounds, 0);
queue.beginRollback(5); queue.emit(hit); queue.emit(sound); queue.endRollback(); assert.equal(starts, 2);
queue.confirmThrough(5); assert.equal(sounds, 1); queue.emit(sound); assert.equal(sounds, 1);
queue.update(250); queue.confirmThrough(8); assert.equal(queue.size, 0); assert.equal(queue.emit(hit), false);
assert.throws(() => queue.beginRollback(8)); assert.throws(() => queue.update(249));
assert.throws(() => queue.emit({ ...sound, tick: 9, policy: 'speculative' }));
queue.dispose(); queue.dispose(); assert.throws(() => queue.emit({ ...hit, tick: 9 }));
const ring = new DiagnosticRing({ capacity: 2, now: () => 10, release: 'test' });
ring.report('api_key=secret user@example.com https://host.test/?token=aaa'); ring.report('other'); ring.report('third');
assert.equal(ring.snapshot().dropped, 1); assert.equal(ring.snapshot().errors.length, 2);
assert.ok(!redactDiagnostic('Bearer abc password=foo user@test.com /home/user/private.txt').includes('foo'));
assert.deepEqual(await copyDiagnostic('safe', { clipboard: { writeText: async () => { throw Error('denied'); } } }), { copied: false, method: 'text', text: 'safe' });
let tick = 5, playing = true;
const replay = new ReplayTimeline({ read: () => ({ tick, firstTick: 0, lastTick: 10, playing }), seek: value => tick = value, setPlaying: value => playing = value });
replay.step(-2); assert.equal(tick, 3); assert.equal(playing, false); replay.seek(100); assert.equal(tick, 10);
assert.equal(compareStateFields({ n: 1 }, { n: 2 }, [{ name: 'count', read: s => s.n }]).mismatches, 1);
console.log(JSON.stringify({ presentation: 'camera inverse/render contract, HUD anchor, rollback resource reconciliation, confirmed sound, retention, diagnostics privacy, replay adapter passed', starts, sounds, cancels, stops }));
// Instant confirmed feedback must not retain full cloned actor graphs for the dedup window.
const largePayload = { actor: { history: new Array(1000).fill('state') } };
const instant = new PresentationEventQueue({ adapters: { hit: { start: event => event.payload } } });
instant.confirmThrough(0); instant.emit({ tick: 0, sequence: 0, entityId: 1, generation: 0, kind: 'hit', durationMs: 0, payload: largePayload });
assert.equal(instant.size, 1); assert.equal(instant.active.size, 0);
const tombstone = [...instant.records.values()][0]; assert.equal(tombstone.event.payload, undefined); assert.equal(tombstone.handle, undefined); assert.equal(largePayload.actor.history.length, 1000);
instant.emit({ tick: 0, sequence: 0, entityId: 1, generation: 0, kind: 'hit', durationMs: 0, payload: largePayload }); assert.equal(instant.stats.started, 1);
let fail = true;
const retry = new PresentationEventQueue({ adapters: { hit: { start() { if (fail) throw Error('temporary resource failure'); } } } });
retry.confirmThrough(0); const retryEvent = { tick: 0, sequence: 0, entityId: 1, generation: 0, kind: 'hit' };
assert.throws(() => retry.emit(retryEvent)); fail = false; retry.confirmThrough(0); assert.equal(retry.stats.started, 1);
// Confirmation at an unchanged, fully processed watermark neither scans nor replaces tombstones.
const retainedEvent = tombstone.event, instantStats = { ...instant.stats };
let retainedScans = 0;
const values = instant.records.values, entries = instant.records[Symbol.iterator];
instant.records.values = function () { retainedScans++; return values.call(this); };
instant.records[Symbol.iterator] = function () { retainedScans++; return entries.call(this); };
for (let i = 0; i < 60; i++) instant.confirmThrough(0);
assert.equal(tombstone.event, retainedEvent, 'released identity is compacted only once');
assert.equal(retainedScans, 0, 'unchanged confirmation must skip retained journal scans');
assert.deepEqual(instant.stats, instantStats);
instant.confirmThrough(1); assert.equal(tombstone.event, retainedEvent, 'advancing confirmation reuses the compact identity');
instant.confirmThrough(120); assert.equal(instant.size, 0); assert.equal(instant.stats.collected, 1);
// A failed start interrupts the watermark pass; retry both it and the records after it.
let failures = 2, retryStarts = 0, speculativeConfirms = 0;
const interrupted = new PresentationEventQueue({ retentionTicks: 2, adapters: { hit: {
  reversible: true, stop() {}, confirm() { speculativeConfirms++; },
  start(event) { if (event.sequence === 1 && failures-- > 0) throw Error('retry start'); retryStarts++; return event.payload; },
} } });
const interruptedEvent = { tick: 10, sequence: 0, entityId: 'retry', generation: 0, kind: 'hit', durationMs: 0, payload: largePayload };
for (let sequence = 0; sequence < 3; sequence++) interrupted.emit({ ...interruptedEvent, sequence });
const activeSpeculation = { ...interruptedEvent, sequence: 3, policy: 'speculative', durationMs: 100 };
interrupted.emit(activeSpeculation);
assert.throws(() => interrupted.confirmThrough(10), /retry start/);
assert.throws(() => interrupted.confirmThrough(10), /retry start/);
interrupted.confirmThrough(10); interrupted.confirmThrough(10);
assert.equal(retryStarts, 4); assert.equal(speculativeConfirms, 1); assert.equal(interrupted.active.size, 1);
for (const record of interrupted.records.values()) if (record.state !== 'active') assert.equal(record.event.payload, undefined);
interrupted.confirmThrough(12); assert.equal(interrupted.size, 1, 'active resource survives the retention cutoff');
assert.equal(interrupted.finish(activeSpeculation), true); assert.equal(interrupted.size, 0, 'late finish collects at the current cutoff');
let confirmAttempts = 0;
const interruptedHook = new PresentationEventQueue({ adapters: { hit: { reversible: true, start() {}, stop() {}, confirm() { if (++confirmAttempts === 1) throw Error('confirm hook'); } } } });
interruptedHook.emit({ ...retryEvent, policy: 'speculative' });
interruptedHook.emit({ ...retryEvent, sequence: 1 });
assert.throws(() => interruptedHook.confirmThrough(0), /confirm hook/);
interruptedHook.confirmThrough(0); interruptedHook.confirmThrough(0);
assert.equal(interruptedHook.stats.started, 2); assert.equal(confirmAttempts, 2, 'resume later records without replaying the interrupted hook');
// Late confirmed emits can fail after a clean confirmation, and must reopen same-tick retry work.
let lateFailures = 2;
const lateRetry = new PresentationEventQueue({ adapters: { hit: { start() { if (lateFailures-- > 0) throw Error('late retry'); } } } });
lateRetry.confirmThrough(0);
assert.throws(() => lateRetry.emit({ ...retryEvent, durationMs: 0, payload: largePayload }), /late retry/);
assert.throws(() => lateRetry.confirmThrough(0), /late retry/);
lateRetry.confirmThrough(0); lateRetry.confirmThrough(0);
assert.equal(lateRetry.stats.started, 1); assert.equal(lateRetry.active.size, 0);
assert.equal([...lateRetry.records.values()][0].event.payload, undefined);
// Finished or cancelled speculative identities compact on confirmation without replaying.
let speculativeStarts = 0;
const completedSpeculation = new PresentationEventQueue({ retentionTicks: 2, adapters: { hit: { reversible: true, stop() {}, start() { speculativeStarts++; } } } });
const speculativeEvent = { ...retryEvent, tick: 1, policy: 'speculative', durationMs: 0, payload: largePayload };
completedSpeculation.emit(speculativeEvent);
completedSpeculation.emit({ ...speculativeEvent, sequence: 1, tick: 2, durationMs: 100 });
completedSpeculation.beginRollback(2); completedSpeculation.endRollback();
completedSpeculation.confirmThrough(2);
const speculativeIdentities = [...completedSpeculation.records.values()].map(record => record.event);
assert.ok(speculativeIdentities.every(event => event.payload === undefined));
completedSpeculation.confirmThrough(2);
for (const [index, record] of [...completedSpeculation.records.values()].entries()) assert.equal(record.event, speculativeIdentities[index]);
completedSpeculation.emit(speculativeEvent); assert.equal(speculativeStarts, 2);
completedSpeculation.confirmThrough(4); assert.equal(completedSpeculation.size, 0);
const details = ring.report(new Error('metadata'), { source: 'https://secret.test', line: 42, column: 3, workerTimeMs: 9, cause: 'token=secret' });
assert.equal(details.source, '[source]'); assert.equal(details.line, 42); assert.equal(details.workerTimeMs, 9); assert.ok(!details.cause.includes('secret'));
// Dense-hit fixture: no arbitrary event cap/drop and no per-frame tombstone scan.
let denseHits = 0;
const dense = new PresentationEventQueue({ retentionTicks: 120, maxPending: 25000, adapters: { hit: { start: () => { denseHits++; } } } });
const denseStart = performance.now();
for (let tick = 0; tick < 100; tick++) {
  dense.confirmThrough(tick);
  for (let sequence = 0; sequence < 200; sequence++) dense.emit({ tick, sequence, entityId: sequence, generation: 1, kind: 'hit', durationMs: 0, payload: largePayload });
}
const denseEmitMs = performance.now() - denseStart, frameStart = performance.now();
for (let i = 0; i < 600; i++) dense.update(i * 1000 / 60);
const denseUpdateMs = performance.now() - frameStart;
assert.equal(denseHits, 20000); assert.equal(dense.active.size, 0); assert.equal(dense.size, 20000);
dense.confirmThrough(220); assert.equal(dense.size, 0);
console.log(JSON.stringify({ densePresentation: { events: denseHits, emitAndConfirmCpuMs: denseEmitMs, idle600UpdatesCpuMs: denseUpdateMs, environment: `Node ${process.version}`, scope: 'CPU fixture only; not mobile or browser FPS' } }));

projection.configure({ pixel2to1: true }); assert.equal(projection.K, .5); projection.configure({ pixel2to1: false }); assert.ok(Math.abs(projection.degrees - 40) < 1e-10);
const tiny = new CameraViewport({ width: .1, height: .2, dpr: 1 }); assert.equal(tiny.screenToBackingInto(.1, .2, {}).x, 1);
assert.throws(() => new PresentationEventQueue({ adapters: {}, retentionTicks: 0 }));

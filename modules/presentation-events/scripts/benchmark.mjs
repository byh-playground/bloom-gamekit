import assert from 'node:assert/strict';
import { PresentationEventQueue } from '../../../dist/presentation-events.js';
const largePayload = { actor: { history: new Array(1000).fill('state') } };
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

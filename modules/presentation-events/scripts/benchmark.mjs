import assert from 'node:assert/strict';
import { PresentationEventQueue } from '../../../dist/presentation-events.js';
const LARGE_PAYLOAD = {
    actor: {
        history: new Array(1000).fill('state'),
    },
};
// Dense-hit fixture: no arbitrary event cap/drop and no per-frame tombstone scan.
let denseHits = 0;
const DENSE = new PresentationEventQueue({
    retentionTicks: 120,
    maxPending: 25000,
    adapters: {
        hit: {
            start: () => {
                denseHits++;
            },
        },
    },
});
const DENSE_START = performance.now();
for (let tick = 0; tick < 100; tick++) {
    DENSE.confirmThrough(tick);
    for (let sequence = 0; sequence < 200; sequence++) {
        DENSE.emit({
            tick,
            sequence,
            entityId: sequence,
            generation: 1,
            kind: 'hit',
            durationMs: 0,
            payload: LARGE_PAYLOAD,
        });
    }
}
const DENSE_EMIT_MS = performance.now() - DENSE_START,
    FRAME_START = performance.now();
for (let i = 0; i < 600; i++) {
    DENSE.update((i * 1000) / 60);
}
const DENSE_UPDATE_MS = performance.now() - FRAME_START;
assert.equal(denseHits, 20000);
assert.equal(DENSE.active.size, 0);
assert.equal(DENSE.size, 20000);
DENSE.confirmThrough(220);
assert.equal(DENSE.size, 0);
console.log(
    JSON.stringify({
        densePresentation: {
            events: denseHits,
            emitAndConfirmCpuMs: DENSE_EMIT_MS,
            idle600UpdatesCpuMs: DENSE_UPDATE_MS,
            environment: `Node ${process.version}`,
            scope: 'CPU fixture only; not mobile or browser FPS',
        },
    }),
);

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { PresentationEventQueue: PRESENTATION_EVENT_QUEUE } = await import(
    process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../index.js', import.meta.url)
);
const MEDIAN = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const EVENTS_PER_TICK of [1, 200]) {
    const TIMES = [],
        HEAPS = [];
    for (let run = 0; run < 7; run++) {
        globalThis.gc?.();
        const BEFORE_HEAP = process.memoryUsage().heapUsed,
            START = performance.now();
        const QUEUE = new PRESENTATION_EVENT_QUEUE({
            retentionTicks: 120,
            adapters: {
                hit: {
                    start() {},
                },
            },
        });
        for (let tick = 0; tick < 1000; tick++) {
            QUEUE.confirmThrough(tick);
            for (let sequence = 0; sequence < EVENTS_PER_TICK; sequence++) {
                QUEUE.emit({
                    tick,
                    sequence,
                    entityId: sequence,
                    generation: 1,
                    kind: 'hit',
                    durationMs: 0,
                });
            }
            QUEUE.update(tick);
        }
        TIMES.push(performance.now() - START);
        globalThis.gc?.();
        if (globalThis.gc) {
            HEAPS.push(process.memoryUsage().heapUsed - BEFORE_HEAP);
        }
        QUEUE.dispose();
    }
    console.log(
        JSON.stringify({
            environment: `Node ${process.version}`,
            scope: 'CPU fixture only; no renderer, GPU or browser FPS measurement',
            ticks: 1000,
            eventsPerTick: EVENTS_PER_TICK,
            retentionTicks: 120,
            medianCpuMs: MEDIAN(TIMES),
            retainedHeapDeltaBytes: HEAPS.length ? MEDIAN(HEAPS) : null,
        }),
    );
}

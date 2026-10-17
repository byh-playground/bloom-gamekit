import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// Optional source path permits the same workload against a baseline revision.
const { PerformanceProfiler: PERFORMANCE_PROFILER } = await import(
    process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../index.js', import.meta.url)
);
const MEDIAN = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(operation) {
    const TIMES = [],
        HEAPS = [];
    for (let run = 0; run < 7; run++) {
        globalThis.gc?.();
        const BEFORE_HEAP = process.memoryUsage().heapUsed,
            START = performance.now();
        const PROFILE = operation();
        TIMES.push(performance.now() - START);
        globalThis.gc?.();
        if (globalThis.gc) {
            HEAPS.push(process.memoryUsage().heapUsed - BEFORE_HEAP);
        }
        PROFILE?.dispose();
    }
    return {
        medianCpuMs: MEDIAN(TIMES),
        retainedHeapDeltaBytes: HEAPS.length ? MEDIAN(HEAPS) : null,
    };
}
for (const CAPACITY of [30, 1000]) {
    const FRAMES = measure(() => {
        let clock = 0;
        const PROFILE = new PERFORMANCE_PROFILER({
            capacity: CAPACITY,
            now: () => ++clock,
        });
        PROFILE.setEnabled(true);
        for (let index = 0; index < 100000; index++) {
            PROFILE.beginFrame();
            PROFILE.endFrame();
        }
        return PROFILE;
    });
    let clock = 0;
    const PROFILE = new PERFORMANCE_PROFILER({
        capacity: CAPACITY,
        now: () => ++clock,
    });
    PROFILE.setEnabled(true);
    for (let index = 0; index < CAPACITY; index++) {
        PROFILE.beginFrame();
        for (let stage = 0; stage < 16; stage++) {
            PROFILE.stage(`stage${stage}`, (index * 13 + stage) % 83);
        }
        PROFILE.endFrame();
    }
    const SNAPSHOTS = measure(() => {
        for (let index = 0; index < 500; index++) {
            PROFILE.snapshot({
                limit: 30,
            });
        }
    });
    console.log(
        JSON.stringify({
            environment: `Node ${process.version}`,
            scope: 'CPU fixture only; no renderer, GPU or browser FPS measurement',
            capacity: CAPACITY,
            frameCount: 100000,
            snapshotCount: 500,
            stageNames: 16,
            frames: FRAMES,
            snapshots: SNAPSHOTS,
        }),
    );
    PROFILE.dispose();
}

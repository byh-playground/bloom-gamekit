import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { InterpolationTimeline } from '../../../dist/interpolation.js';
const SUMMARY = {
    runtime: process.version,
};
// Informational microbenchmark, not FPS. Includes Map lookup, sample writes and call overhead.
const COUNT = 256,
    FRAMES = 2000;
const BENCH = new InterpolationTimeline({
    stepMs: 100,
    schema: {
        x: 'number',
        y: 'number',
        z: 'number',
    },
});
const ENTITIES = Array.from(
    {
        length: COUNT,
    },
    (_, i) => ({
        id: String(i),
        generation: 0,
        values: {
            x: i,
            y: i,
            z: i,
        },
    }),
);
const OUTPUTS = ENTITIES.map(() => ({}));
const INPUT = (sequence) => ({
    revision: 0,
    sequence,
    timeMs: sequence * 100,
    entities: ENTITIES,
});
const ACCEPTS = [],
    SAMPLES = new Float64Array(FRAMES);
BENCH.accept(INPUT(0), 0);
for (let f = 0; f < 200; f++) {
    for (let i = 0; i < COUNT; i++) {
        BENCH.sampleInto(ENTITIES[i].id, 0, f, OUTPUTS[i]);
    }
}
const HEAP_BEFORE = process.memoryUsage().heapUsed;
for (let f = 0; f < FRAMES; f++) {
    const NOW = 200 + f;
    if (f % 100 === 0) {
        const START = performance.now();
        BENCH.accept(INPUT(f + 1), NOW);
        ACCEPTS.push(performance.now() - START);
    }
    const START = performance.now();
    for (let i = 0; i < COUNT; i++) {
        BENCH.sampleInto(ENTITIES[i].id, 0, NOW, OUTPUTS[i]);
    }
    SAMPLES[f] = performance.now() - START;
}
const HEAP_DELTA_BYTES = process.memoryUsage().heapUsed - HEAP_BEFORE;
SAMPLES.sort();
ACCEPTS.sort((a, b) => a - b);
SUMMARY.benchmark = {
    entities: COUNT,
    frames: FRAMES,
    sampleBatchMs: {
        p50: SAMPLES[Math.floor(FRAMES * 0.5)],
        p95: SAMPLES[Math.floor(FRAMES * 0.95)],
    },
    acceptBatchMs: {
        p50: ACCEPTS[Math.floor(ACCEPTS.length * 0.5)],
        p95: ACCEPTS[Math.floor(ACCEPTS.length * 0.95)],
    },
    heapDeltaBytes: HEAP_DELTA_BYTES,
    allocationContract:
        '256 caller outputs reused; accept allocates one Map and two field arrays plus one track per entity. Heap delta includes GC and benchmark bookkeeping, is not total allocation or a zero-allocation proof.',
    scope: 'Node CPU only; not browser FPS, GPU, mobile, or renderer performance.',
};
// Statistical allocation sampling includes collected objects; isolate library stacks.
const INSPECTOR = new Session();
INSPECTOR.connect();
const POST = (method, params = {}) =>
    new Promise((resolve, reject) =>
        INSPECTOR.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
    );
await POST('HeapProfiler.startSampling', {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
});
for (let f = 0; f < 1000; f++) {
    const NOW = 3000 + f;
    if (f % 10 === 0) {
        BENCH.accept(INPUT(3000 + f), NOW);
    }
    for (let i = 0; i < COUNT; i++) {
        BENCH.sampleInto(ENTITIES[i].id, 0, NOW, OUTPUTS[i]);
    }
}
const { profile: PROFILE } = await POST('HeapProfiler.stopSampling');
INSPECTOR.disconnect();
const ALLOCATION = {
    accept: 0,
    sampleInto: 0,
};
function countAllocations(node, owner = null) {
    if (node.callFrame.functionName === 'accept' || node.callFrame.functionName === 'sampleInto') {
        owner = node.callFrame.functionName;
    }
    if (owner) {
        ALLOCATION[owner] += node.selfSize;
    }
    for (const CHILD of node.children) {
        countAllocations(CHILD, owner);
    }
}
countAllocations(PROFILE.head);
SUMMARY.benchmark.allocationSampling = {
    intervalBytes: 1024,
    accepts: 100,
    samples: 256000,
    estimatedBytesUnderLibraryStacks: ALLOCATION,
    caveat: 'V8 statistical estimates, including collected objects; a zero estimate is below sampling resolution, not a no-allocation guarantee.',
};
// Optional seed/mask accept cost is reported separately from unchanged sampling.
const SEEDED_ENTITIES = ENTITIES.map((entity) => ({
    ...entity,
    initialValues: entity.values,
    resetFields: ['z'],
}));
const SEEDED_ACCEPTS = [];
for (let generation = 0; generation < 100; generation++) {
    for (const ENTITY of SEEDED_ENTITIES) {
        ENTITY.generation = generation + 1;
    }
    const SNAPSHOT = {
        revision: 0,
        sequence: 10000 + generation,
        timeMs: (10000 + generation) * 100,
        entities: SEEDED_ENTITIES,
    };
    const START = performance.now();
    const ACCEPTED = BENCH.accept(SNAPSHOT, 10000 + generation);
    SEEDED_ACCEPTS.push(performance.now() - START);
    assert.equal(ACCEPTED, true);
}
SEEDED_ACCEPTS.sort((a, b) => a - b);
SUMMARY.benchmark.newIdentityWithSeedAndMaskBatchMs = {
    entities: COUNT,
    accepts: 100,
    p50: SEEDED_ACCEPTS[50],
    p95: SEEDED_ACCEPTS[95],
    scope: 'Optional feature cost; each entity has 3 seed fields and 1 reset field. Input preparation excluded; CPU only.',
};
console.log(JSON.stringify(SUMMARY, null, 2));

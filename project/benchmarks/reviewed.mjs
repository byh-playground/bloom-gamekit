import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run: node --expose-gc project/benchmarks/reviewed.mjs /path/to/baseline-checkout [current-checkout]
if (!process.argv[2]) {
    throw Error('Provide the baseline source checkout path');
}
const BASELINE = resolve(process.argv[2]),
    CURRENT = resolve(process.argv[3] ?? '.');
// Accept both the pinned pre-restructure baseline and the module-first source tree.
const LOAD = (root, path) => {
    const LEGACY = path.replace(/^modules\/([^/]+)\//, 'packages/$1/src/');
    return import(pathToFileURL(resolve(root, existsSync(resolve(root, path)) ? path : LEGACY)).href);
};
const BEFORE_EVENTS = await LOAD(BASELINE, 'modules/presentation-events/index.js');
const AFTER_EVENTS = await LOAD(CURRENT, 'modules/presentation-events/index.js');
const BEFORE_LOOP = await LOAD(BASELINE, 'modules/simloop/loop.js');
const AFTER_LOOP = await LOAD(CURRENT, 'modules/simloop/loop.js');
const { createSession: CREATE_SESSION } = await LOAD(CURRENT, 'modules/rollback/core.js');
function presentation(beforeLocal, afterLocal) {
    if (!global.gc) {
        throw Error('Run with node --expose-gc');
    }
    const EVENTS_PER_TICK = 200,
        TICKS = 120,
        REPEATS = 60,
        SAMPLES = 7;
    function fixture(queue, instrument = false) {
        const Q = new queue({
            retentionTicks: 120,
            maxPending: 25000,
            adapters: {
                hit: {
                    start() {},
                },
            },
        });
        const COUNTERS = {
            releaseCalls: 0,
            tombstoneObjects: 0,
            journalScans: 0,
        };
        if (instrument) {
            const RELEASE = Q._release,
                VALUES = Q.records.values,
                ENTRIES = Q.records[Symbol.iterator];
            Q._release = function (record) {
                COUNTERS.releaseCalls++;
                const PREVIOUS = record.event;
                RELEASE.call(this, record);
                if (PREVIOUS !== record.event) {
                    COUNTERS.tombstoneObjects++;
                }
            };
            Q.records.values = function () {
                COUNTERS.journalScans++;
                return VALUES.call(this);
            };
            Q.records[Symbol.iterator] = function () {
                COUNTERS.journalScans++;
                return ENTRIES.call(this);
            };
        }
        const PAYLOAD = {
            actor: {
                history: new Array(1000).fill('state'),
            },
        };
        for (let tick = 0; tick < TICKS; tick++) {
            Q.confirmThrough(tick);
            for (let sequence = 0; sequence < EVENTS_PER_TICK; sequence++) {
                Q.emit({
                    tick,
                    sequence,
                    entityId: sequence,
                    generation: 1,
                    kind: 'hit',
                    durationMs: 0,
                    payload: PAYLOAD,
                });
            }
        }
        assert.equal(Q.size, 24000);
        assert.equal(Q.active.size, 0);
        assert.equal(Q.stats.started, 24000);
        return {
            q: Q,
            counters: COUNTERS,
        };
    }
    function repeated(q) {
        for (let i = 0; i < REPEATS; i++) {
            q.confirmThrough(TICKS - 1);
        }
    }
    function advancing(q) {
        for (let tick = TICKS; tick < TICKS + REPEATS; tick++) {
            q.confirmThrough(tick);
        }
    }
    function measure(fn) {
        const CPU = process.cpuUsage(),
            START = performance.now();
        const VALUE = fn();
        const WALL_MS = performance.now() - START,
            USED = process.cpuUsage(CPU);
        return {
            value: VALUE,
            elapsedMs: WALL_MS,
            processCpuMs: (USED.user + USED.system) / 1000,
        };
    }
    function run(queue) {
        global.gc();
        const HEAP_BEFORE = process.memoryUsage().heapUsed;
        const SETUP = measure(() => fixture(queue)),
            { q: Q } = SETUP.value;
        global.gc();
        const RETAINED_HEAP_BYTES = process.memoryUsage().heapUsed - HEAP_BEFORE;
        const SAME_TICK = measure(() => repeated(Q));
        assert.equal(Q.size, 24000);
        assert.equal(Q.stats.started, 24000);
        const ADVANCE_TICKS = measure(() => advancing(Q));
        assert.equal(Q.size, 12000);
        assert.equal(Q.stats.collected, 12000);
        Q.dispose();
        const TIMING = ({ elapsedMs, processCpuMs }) => ({
            elapsedMs,
            processCpuMs,
        });
        return {
            setup: TIMING(SETUP),
            sameTick: TIMING(SAME_TICK),
            advanceTicks: TIMING(ADVANCE_TICKS),
            retainedHeapBytes: RETAINED_HEAP_BYTES,
        };
    }
    function allocationCounts(queue) {
        const { q: Q, counters: COUNTERS } = fixture(queue, true);
        const SETUP = {
            ...COUNTERS,
        };
        const RESET = () => {
            for (const NAME of Object.keys(COUNTERS)) {
                COUNTERS[NAME] = 0;
            }
        };
        RESET();
        repeated(Q);
        const SAME_TICK = {
            ...COUNTERS,
        };
        RESET();
        advancing(Q);
        const ADVANCE_TICKS = {
            ...COUNTERS,
        };
        Q.dispose();
        return {
            setup: SETUP,
            sameTick: SAME_TICK,
            advanceTicks: ADVANCE_TICKS,
        };
    }
    for (let warmup = 0; warmup < 2; warmup++) {
        run(beforeLocal);
        run(afterLocal);
    }
    const SAMPLES_LOCAL = {
        before: [],
        after: [],
    };
    for (let sample = 0; sample < SAMPLES; sample++) {
        for (const LABEL of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
            SAMPLES_LOCAL[LABEL].push(run(LABEL === 'before' ? beforeLocal : afterLocal));
        }
    }
    const MEDIAN = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    function summary(label, queue) {
        const MEDIAN_TIMINGS = Object.fromEntries(
            ['setup', 'sameTick', 'advanceTicks'].map((phase) => [
                phase,
                {
                    elapsedMs: MEDIAN(SAMPLES_LOCAL[label].map((x) => x[phase].elapsedMs)),
                    processCpuMs: MEDIAN(SAMPLES_LOCAL[label].map((x) => x[phase].processCpuMs)),
                },
            ]),
        );
        return {
            median: {
                ...MEDIAN_TIMINGS,
                retainedHeapBytes: MEDIAN(SAMPLES_LOCAL[label].map((x) => x.retainedHeapBytes)),
            },
            exactInstrumentedCounts: allocationCounts(queue),
            samples: SAMPLES_LOCAL[label],
        };
    }
    return {
        environment: {
            node: process.version,
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0].model,
        },
        fixture: {
            events: 24000,
            ticks: TICKS,
            eventsPerTick: EVENTS_PER_TICK,
            unchangedConfirmations: REPEATS,
            advancingConfirmations: REPEATS,
            samples: SAMPLES,
            warmupsPerVersion: 2,
        },
        scope: 'Node synchronous CPU/allocation fixture only, not browser/mobile/GPU FPS. Timings are uninstrumented; exact tombstone object replacements and journal iterator calls are counted in a separate equal fixture. Retained heap is post-GC and includes queue metadata; it is not total allocation.',
        before: summary('before', beforeLocal),
        after: summary('after', afterLocal),
    };
}
function pacing(oldLoop, newLoop) {
    const PULSES = 20000,
        INPUT = new Uint8Array(1),
        RESULT = {
            status: 'advanced',
        };
    function run(createLoop, instrument = false) {
        const STATE = new Uint8Array([0]);
        const SESSION = CREATE_SESSION({
            players: ['a'],
            localPlayerId: 'a',
            sessionId: 'bench',
            simulationVersion: '1',
            inputSize: 1,
            adapter: {
                save: () => STATE,
                load() {},
                step() {},
                validateSnapshot: () => true,
            },
            profile: {
                tickRate: 20,
                maxCatchupSteps: 5,
            },
        });
        let snapshots = 0;
        let steps = 0;
        if (instrument) {
            const GETTER = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(SESSION), 'metrics').get;
            Object.defineProperty(SESSION, 'metrics', {
                get() {
                    snapshots++;
                    return GETTER.call(this);
                },
            });
        }
        SESSION.poll = () => {};
        SESSION.advance = () => {
            steps++;
            return RESULT;
        };
        const LOOP = createLoop({
            session: SESSION,
            getInput: () => INPUT,
        });
        LOOP.pulse(0);
        snapshots = 0;
        const CPU = process.cpuUsage(),
            START = performance.now();
        for (let i = 1; i <= PULSES; i++) {
            LOOP.pulse(i * 250);
        }
        const ELAPSED_MS = performance.now() - START,
            USED = process.cpuUsage(CPU);
        assert.equal(steps, PULSES * 5);
        SESSION.close();
        return {
            elapsedMs: ELAPSED_MS,
            processCpuMs: (USED.user + USED.system) / 1000,
            snapshots,
            steps,
        };
    }
    for (let i = 0; i < 2; i++) {
        run(oldLoop);
        run(newLoop);
    }
    const SAMPLES_LOCAL = {
        before: [],
        after: [],
    };
    for (let i = 0; i < 7; i++) {
        for (const LABEL of i % 2 ? ['after', 'before'] : ['before', 'after']) {
            SAMPLES_LOCAL[LABEL].push(run(LABEL === 'before' ? oldLoop : newLoop));
        }
    }
    const MEDIAN = (xs) => [...xs].sort((a, b) => a - b)[3];
    const SUMMARY = (label, loop) => ({
        median: {
            elapsedMs: MEDIAN(SAMPLES_LOCAL[label].map((x) => x.elapsedMs)),
            processCpuMs: MEDIAN(SAMPLES_LOCAL[label].map((x) => x.processCpuMs)),
        },
        metricsSnapshots: run(loop, true).snapshots,
        steps: PULSES * 5,
        samples: SAMPLES_LOCAL[label],
    });
    return {
        pulses: PULSES,
        stepsPerPulse: 5,
        before: SUMMARY('before', oldLoop),
        after: SUMMARY('after', newLoop),
        scope: 'Node isolated pacing overhead; real RollbackSession.metrics getter, poll/advance stubbed equally. Uninstrumented timing; snapshot getter counts measured separately. Not full game/browser/FPS.',
    };
}
console.log(
    JSON.stringify(
        {
            baseline: BASELINE,
            current: CURRENT,
            presentation: presentation(BEFORE_EVENTS.PresentationEventQueue, AFTER_EVENTS.PresentationEventQueue),
            pacing: pacing(BEFORE_LOOP.createLoop, AFTER_LOOP.createLoop),
        },
        null,
        2,
    ),
);

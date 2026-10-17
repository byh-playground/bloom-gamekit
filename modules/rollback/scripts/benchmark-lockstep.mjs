import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createSession } from '../core.js';
import { hashBytes } from '../../deterministic/utilities.js';

// Identical deterministic entity simulation + canonical JSON save in both modes.
// Actual consumer adapter measurements are reported in their owning repositories.
const TICKS = 300,
    SAMPLES = 5,
    INTERVAL = 20;
const MEDIAN = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function run(mode, count) {
    global.gc?.();
    const HEAP_BEFORE = process.memoryUsage().heapUsed;
    let state = {
        tick: 0,
        entities: Array.from(
            {
                length: count,
            },
            (_, id) => ({
                id,
                x: id * 3,
                y: id * 7,
                hp: 100,
                energy: 50,
                target: id % 7,
                flags: 0,
            }),
        ),
    };
    let saveMs = 0;
    let simulationMs = 0;
    const ENCODER = new TextEncoder(),
        DECODER = new TextDecoder();
    const ADAPTER = {
        save() {
            const START = performance.now();
            const BYTES = ENCODER.encode(JSON.stringify(state));
            saveMs += performance.now() - START;
            return BYTES;
        },
        load(bytes) {
            state = JSON.parse(DECODER.decode(bytes));
        },
        validateSnapshot: () => true,
        step({ tick, inputs }) {
            const START = performance.now();
            assert.equal(tick, state.tick);
            const N = inputs[0].input[0];
            for (const E of state.entities) {
                E.x = (E.x + N + E.id) % 10000;
                E.y = (E.y + E.target) % 10000;
                E.energy = (E.energy + 1) % 101;
                E.flags = (tick + E.id) & 3;
            }
            state.tick++;
            simulationMs += performance.now() - START;
        },
    };
    const SESSION = createSession({
        players: ['a'],
        localPlayerId: 'a',
        sessionId: 'bench',
        simulationVersion: '1',
        inputSize: 1,
        adapter: ADAPTER,
        recordReplay: true,
        profile: {
            mode,
            tickRate: 20,
            baseInputDelayTicks: 0,
            minInputDelayTicks: 0,
            maxInputDelayTicks: 0,
            adaptiveInputDelay: false,
            pacingPolicy: 'none',
            stateHistorySize: 64,
            checksumInterval: INTERVAL,
        },
    });
    const SAMPLES_LOCAL = [],
        STARTED = performance.now();
    for (let tick = 0; tick < TICKS; tick++) {
        const START = performance.now();
        assert.equal(SESSION.advance(new Uint8Array([tick % 13])).status, 'advanced');
        SAMPLES_LOCAL.push(performance.now() - START);
    }
    const ELAPSED_MS = performance.now() - STARTED,
        METRICS = SESSION.metrics;
    global.gc?.();
    const HEAP_AFTER = process.memoryUsage().heapUsed;
    const HASH = hashBytes(ENCODER.encode(JSON.stringify(state)));
    const RESULT = {
        elapsedMs: ELAPSED_MS,
        medianAdvanceMs: MEDIAN(SAMPLES_LOCAL),
        saveMs,
        simulationMs,
        snapshotSaves: METRICS.snapshotSaves,
        serializedSnapshotBytes: METRICS.serializedSnapshotBytes,
        retainedSnapshotBytes: METRICS.retainedSnapshotBytes,
        postGcHeapDeltaBytes: HEAP_AFTER - HEAP_BEFORE,
        hash: HASH,
    };
    assert.equal(METRICS.snapshotSaves, mode === 'rollback' ? TICKS + 1 : 1 + TICKS / INTERVAL);
    SESSION.close();
    return RESULT;
}
const RESULTS = [];
for (const ENTITIES of [1, 155, 1000]) {
    for (const MODE of ['rollback', 'lockstep']) {
        run(MODE, ENTITIES);
    }
    const SAMPLES_LOCAL = {
        rollback: [],
        lockstep: [],
    };
    for (let i = 0; i < SAMPLES; i++) {
        for (const MODE of i % 2 ? ['lockstep', 'rollback'] : ['rollback', 'lockstep']) {
            SAMPLES_LOCAL[MODE].push(run(MODE, ENTITIES));
        }
    }
    assert.ok(
        [...SAMPLES_LOCAL.rollback, ...SAMPLES_LOCAL.lockstep].every((x) => x.hash === SAMPLES_LOCAL.rollback[0].hash),
    );
    RESULTS.push({
        entities: ENTITIES,
        ...Object.fromEntries(
            Object.entries(SAMPLES_LOCAL).map(([mode, values]) => [
                mode,
                {
                    median: Object.fromEntries(Object.keys(values[0]).map((k) => [k, MEDIAN(values.map((x) => x[k]))])),
                    samples: values,
                },
            ]),
        ),
    });
}
console.log(
    JSON.stringify(
        {
            environment: {
                node: process.version,
                cpu: cpus()[0].model,
                gc: !!global.gc,
            },
            fixture: {
                ticks: TICKS,
                samples: SAMPLES,
                checksumInterval: INTERVAL,
                historyTicks: 64,
                recordReplay: true,
            },
            scope: 'Node entity fixture, canonical JSON serialization, same adapter/inputs. Includes simulation and SDK save/copy cost; excludes network/browser/render/GPU. Timings are local medians, not phone FPS. Post-GC heap delta is noisy and not total allocation.',
            results: RESULTS,
        },
        null,
        2,
    ),
);

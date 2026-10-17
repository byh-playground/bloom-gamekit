// 코어 비용만 측정한다. 게임 simulation/serialization/render 비용은 포함하지 않는다.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as current from '../../../dist/rollback.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SIZES = process.env.SNAPSHOT_BYTES
    ? [Number(process.env.SNAPSHOT_BYTES)]
    : [128 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024];
const STEPS = Number(process.env.BENCH_STEPS || 240),
    RESULTS = [];
const VERSIONS = [['current', current]];
// 비교는 사용자가 보존한 독립 번들만 명시적으로 읽는다. 삭제될 저장소의 git 이력에 의존하지 않는다.
const BASELINE_PATH = process.env.BENCH_BASELINE_MODULE;
if (BASELINE_PATH) {
    VERSIONS.unshift([
        `baseline:${path.resolve(BASELINE_PATH)}`,
        await import(pathToFileURL(path.resolve(BASELINE_PATH)).href),
    ]);
}
for (const SIZE of SIZES) {
    assert.ok(Number.isSafeInteger(SIZE) && SIZE >= 4, 'SNAPSHOT_BYTES must be an integer >= 4');
}
assert.ok(Number.isSafeInteger(STEPS) && STEPS > 0, 'BENCH_STEPS must be a positive integer');
for (const PROFILE_NAME of ['rts', 'action']) {
    for (const SIZE of SIZES) {
        for (const [VERSION, API] of VERSIONS) {
            const STATE = new Uint8Array(SIZE),
                VIEW = new DataView(STATE.buffer),
                PROFILE = API.profiles[PROFILE_NAME];
            const HISTORY_BYTES = SIZE * PROFILE.stateHistorySize,
                DEFAULT_BUDGET_FITS = HISTORY_BYTES <= PROFILE.maxHistoryBytes;
            const SESSION = API.createSession({
                players: ['a'],
                localPlayerId: 'a',
                sessionId: 'benchmark',
                simulationVersion: 'blob-v1',
                inputSize: 1,
                recordReplay: false,
                profile: {
                    ...PROFILE,
                    baseInputDelayTicks: 0,
                    adaptiveInputDelay: false,
                    pacingPolicy: 'none',
                    maxHistoryBytes: Math.max(PROFILE.maxHistoryBytes, HISTORY_BYTES),
                },
                adapter: {
                    save: () => STATE,
                    load: (data) => STATE.set(data),
                    validateSnapshot: (data) => data.length === SIZE,
                    step: ({ tick }) => VIEW.setUint32(0, tick + 1, true),
                },
            });
            const COSTS = [],
                INPUT = new Uint8Array(1);
            for (let tick = 0; tick < STEPS; tick++) {
                const START = performance.now();
                SESSION.advance(INPUT);
                COSTS.push(performance.now() - START);
            }
            assert.equal(VIEW.getUint32(0, true), STEPS);
            COSTS.sort((a, b) => a - b);
            const HASH = SESSION.getStateHash(),
                ROW = {
                    version: VERSION,
                    profile: PROFILE_NAME,
                    snapshotBytes: SIZE,
                    steps: STEPS,
                    retainedSnapshotBytes: HISTORY_BYTES,
                    defaultBudgetFits: DEFAULT_BUDGET_FITS,
                    p50Ms: COSTS[Math.floor(STEPS * 0.5)],
                    p95Ms: COSTS[Math.floor(STEPS * 0.95)],
                    p99Ms: COSTS[Math.floor(STEPS * 0.99)],
                    hash: HASH,
                    stateHashComputations: SESSION.metrics.stateHashComputations ?? null,
                };
            RESULTS.push(ROW);
            SESSION.close();
            console.log(JSON.stringify(ROW));
        }
    }
}
for (const RESULT of RESULTS.filter((r) => r.version === 'current')) {
    const BASELINE = RESULTS.find(
        (r) => r.version !== 'current' && r.profile === RESULT.profile && r.snapshotBytes === RESULT.snapshotBytes,
    );
    if (BASELINE) {
        assert.equal(RESULT.hash, BASELINE.hash, 'Optimization preserves exact simulation result');
    }
}
fs.mkdirSync(path.join(ROOT, 'test-results/rollback'), {
    recursive: true,
});
fs.writeFileSync(
    path.join(ROOT, 'test-results/rollback/benchmark.json'),
    JSON.stringify(
        {
            environment: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
            },
            results: RESULTS,
        },
        null,
        2,
    ),
);

// 선택적 실제 Rally Adapter 벤치. 게임 파일/배포는 수정하지 않는다.
// RALLY_HTML: StrategySim/RallySimulationAdapter를 포함한 로컬 단일 HTML.
// 이전 게임/SDK 비교는 RALLY_BASELINE_HTML/RALLY_BASELINE_MODULE 파일을 명시할 때만 추가한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchBrowser, resultsDirectory } from './browser-helpers.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (!process.env.RALLY_HTML) {
    throw Error(
        'RALLY_HTML을 StrategySim/RallySimulationAdapter가 포함된 게임 index.html로 지정하세요. 선택적 도구이며 기본 CI에 포함하지 않습니다.',
    );
}
const HTML_PATH = path.resolve(process.env.RALLY_HTML),
    GAME_ROOT = fs.realpathSync(path.dirname(HTML_PATH));
const CURRENT_HTML = fs.readFileSync(HTML_PATH, 'utf8');
const LEGACY_PATH = process.env.RALLY_BASELINE_HTML ? path.resolve(process.env.RALLY_BASELINE_HTML) : null;
const LEGACY_HTML = LEGACY_PATH ? fs.readFileSync(LEGACY_PATH, 'utf8') : null;
const SDK_SOURCE = fs.readFileSync(path.join(ROOT, 'dist/rollback.js'), 'utf8');
const DETERMINISTIC_SOURCE = fs.readFileSync(path.join(ROOT, 'dist/deterministic.js'), 'utf8');
const BASELINE_SOURCE = process.env.RALLY_BASELINE_MODULE
    ? fs.readFileSync(path.resolve(process.env.RALLY_BASELINE_MODULE), 'utf8')
    : null;
const COUNTS = (process.env.RALLY_COUNTS || '20,60,200').split(',').map(Number),
    STEPS = Number(process.env.RALLY_STEPS || 60),
    WARMUP = 12;
assert.ok(
    COUNTS.length && COUNTS.every((count) => Number.isSafeInteger(count) && count > 0),
    'RALLY_COUNTS must contain positive integers',
);
assert.ok(Number.isSafeInteger(STEPS) && STEPS > 0, 'RALLY_STEPS must be a positive integer');
const BROWSER = await launchBrowser(),
    RESULTS = [],
    PAGE_ERRORS = [];
async function prepare(html, name, assetRoot = GAME_ROOT) {
    const PAGE = await BROWSER.newPage(),
        AT = html.lastIndexOf('})();');
    assert.ok(AT > 0, 'Rally fixture must expose its simulation inside the expected closing IIFE');
    const BODY =
        html.slice(0, AT) +
        `window.__rallyPerf={StrategySim,GameRuleDefinition,HashUtil,StableSerializationUtil,
    RallySimulationAdapter:typeof RallySimulationAdapter==='undefined'?null:RallySimulationAdapter,
    RallyCommandCodec:typeof RallyCommandCodec==='undefined'?null:RallyCommandCodec};` +
        html.slice(AT);
    PAGE.on('pageerror', (error) =>
        PAGE_ERRORS.push({
            page: name,
            message: error.message,
        }),
    );
    await PAGE.route('http://rally-perf.local/**', async (route) => {
        const PATHNAME = new URL(route.request().url()).pathname;
        if (PATHNAME === '/deterministic.mjs') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: DETERMINISTIC_SOURCE,
            });
        }
        if (PATHNAME === '/candidate.mjs') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: SDK_SOURCE,
            });
        }
        if (PATHNAME === '/baseline.mjs' && BASELINE_SOURCE) {
            return route.fulfill({
                contentType: 'text/javascript',
                body: BASELINE_SOURCE,
            });
        }
        if (PATHNAME === `/game/${name}.html`) {
            return route.fulfill({
                contentType: 'text/html',
                body: BODY,
            });
        }
        // 게임이 함께 보관한 로컬 자원은 실제 파일로 제공한다. 임의 URL에 HTML/SDK를 대신 반환하지 않는다.
        try {
            if (!PATHNAME.startsWith('/game/')) {
                return route.fulfill({
                    status: 404,
                    body: 'Not found',
                });
            }
            const FILE = fs.realpathSync(path.resolve(assetRoot, decodeURIComponent(PATHNAME.slice('/game/'.length))));
            if (!FILE.startsWith(assetRoot + path.sep)) {
                return route.fulfill({
                    status: 403,
                    body: 'Forbidden',
                });
            }
            const TYPES = {
                '.js': 'text/javascript',
                '.mjs': 'text/javascript',
                '.json': 'application/json',
                '.css': 'text/css',
                '.png': 'image/png',
                '.svg': 'image/svg+xml',
            };
            return route.fulfill({
                contentType: TYPES[path.extname(FILE)] || 'application/octet-stream',
                body: fs.readFileSync(FILE),
            });
        } catch {
            return route.fulfill({
                status: 404,
                body: 'Not found',
            });
        }
    });
    await PAGE.goto(`http://rally-perf.local/game/${name}.html`);
    await PAGE.waitForFunction(() => window.__rallyPerf);
    if (name === 'current') {
        await PAGE.evaluate(async (hasBaseline) => {
            window.__newSDK = await import('/candidate.mjs');
            window.__hashBytes = (await import('/deterministic.mjs')).hashBytes;
            window.__baselineSDK = hasBaseline ? await import('/baseline.mjs') : null;
            const Q = window.__rallyPerf;
            if (typeof Q.RallySimulationAdapter !== 'function' || typeof Q.RallyCommandCodec?.encode !== 'function') {
                throw Error('RALLY_HTML must provide RallySimulationAdapter and RallyCommandCodec.encode');
            }
        }, Boolean(BASELINE_SOURCE));
    }
    return PAGE;
}
async function measure({ mode, count, steps, warmup, round }) {
    const Q = window.__rallyPerf,
        ALL = steps + warmup,
        SAVE_COSTS = [],
        LOAD_COSTS = [],
        STEP_COSTS = [],
        TOTALS = [];
    const RULES = Q.GameRuleDefinition.resolve({
        overrides: {
            simulation: {
                tps: 20,
            },
        },
    });
    Q.GameRuleDefinition.current = RULES;
    const START = performance.now(),
        DRAFT = {
            decks: {
                host: ['swordsman'],
                guest: ['swordsman'],
            },
            defenseCards: {
                host: [],
                guest: [],
            },
        };
    const SIM = new Q.StrategySim(DRAFT, 831047, RULES);
    SIM.applyDebugScenario({
        kind: 'unit-combat',
        allyType: 'swordsman',
        enemyType: 'swordsman',
        allyCount: Math.min(count, 60),
        enemyCount: Math.min(count, 60),
        research: false,
        humanRole: 'host',
    });
    // A benchmark scenario supplies only its initial roster through real spawn APIs.
    if (count > 60) {
        for (const SIDE of [0, 1]) {
            for (let i = 60; i < count; i++) {
                const COL = (i - 60) % 16,
                    ROW = Math.floor((i - 60) / 16);
                SIM.spawnUnit(
                    SIDE,
                    'swordsman',
                    SIM.world.width * 0.5 + (COL - 7.5) * 40,
                    SIM.world.height * 0.5 + (SIDE === 0 ? 1 : -1) * (240 + ROW * 40),
                );
            }
        }
    }
    SIM.rebuildRuntimeIndexes();
    const INITIAL_UNITS = SIM.units.length,
        SETUP_MS = performance.now() - START;
    const PROTO = Q.StrategySim.prototype,
        ORIGINAL_STEP = PROTO.step;
    PROTO.step = function (...args) {
        const T = performance.now();
        try {
            return ORIGINAL_STEP.apply(this, args);
        } finally {
            STEP_COSTS.push(performance.now() - T);
        }
    };
    let core = null;
    let adapter = null;
    let initialBytes = null;
    let sequence = 0;
    const SDK = mode === 'sdk-current' ? window.__newSDK : window.__baselineSDK;
    if (mode.startsWith('sdk')) {
        adapter = new Q.RallySimulationAdapter({
            sim: SIM,
            onNetcodeFrameApplied() {},
        });
        const SAVE = adapter.save.bind(adapter),
            LOAD = adapter.load.bind(adapter);
        adapter.save = () => {
            const T = performance.now();
            try {
                return SAVE();
            } finally {
                SAVE_COSTS.push(performance.now() - T);
            }
        };
        adapter.load = (b) => {
            const T = performance.now();
            try {
                return LOAD(b);
            } finally {
                LOAD_COSTS.push(performance.now() - T);
            }
        };
        initialBytes = adapter.save().length;
        core = SDK.createSession({
            players: ['host'],
            localPlayerId: 'host',
            sessionId: 'rally-perf',
            simulationVersion: 'rally-perf-182',
            inputSize: 1,
            seed: 831047,
            adapter,
            recordReplay: true,
            profile: {
                ...SDK.profiles.rts,
                baseInputDelayTicks: 0,
                adaptiveInputDelay: false,
                pacingPolicy: 'none',
                maxSnapshotBytes: 8 * 1024 * 1024,
                maxHistoryBytes: 256 * 1024 * 1024,
            },
        });
    }
    const INPUT = new Uint8Array(1);
    try {
        for (let tick = 0; tick < ALL; tick++) {
            const ACTION =
                tick % 17 === 4
                    ? {
                          type: 'SET_FLAG',
                          x: SIM.world.width * 0.5 + (tick % 3) * 10,
                          y: SIM.world.height * 0.5 - 300,
                          forced: true,
                      }
                    : null;
            if (ACTION) {
                sequence++;
                if (core) {
                    core.queueCommand(Q.RallyCommandCodec.encode(ACTION));
                } else {
                    SIM.queueCommand({
                        actor: 'host',
                        seq: tick * 4096 + 1,
                        tick: tick + 1,
                        netcodeSequence: sequence,
                        action: ACTION,
                    });
                }
            }
            const BEFORE = performance.now();
            if (core) {
                const RESULT = core.advance(INPUT);
                if (RESULT.status !== 'advanced') {
                    throw Error(RESULT.status);
                }
            } else {
                SIM.step();
            }
            TOTALS.push(performance.now() - BEFORE);
        }
        const STATS = (list) => {
            const SORTED = list.slice(-steps).sort((a, b) => a - b);
            return {
                p50: SORTED[Math.floor(SORTED.length * 0.5)] || 0,
                p95: SORTED[Math.floor(SORTED.length * 0.95)] || 0,
                total: list.reduce((a, b) => a + b, 0),
            };
        };
        const FINAL_GAMEPLAY_HASH = SIM.checksumBundle({
            includeScheduled: false,
        }).root;
        const STATE_HASH = adapter ? window.__hashBytes(adapter.save()) : null;
        const SNAPSHOT = adapter?.save();
        if (SNAPSHOT) {
            for (let i = 0; i < 8; i++) {
                adapter.load(SNAPSHOT);
            }
        }
        return {
            round,
            mode,
            initialUnits: INITIAL_UNITS,
            finalUnits: SIM.units.length,
            tps: SIM.tps,
            ticks: SIM.tick,
            setupMs: SETUP_MS,
            snapshotBytes: initialBytes,
            totalMs: STATS(TOTALS),
            gameStepMs: STATS(STEP_COSTS),
            adapterSaveMs: STATS(SAVE_COSTS),
            adapterLoadMs: STATS(LOAD_COSTS),
            finalGameplayHash: FINAL_GAMEPLAY_HASH,
            stateHash: STATE_HASH,
            coreMetrics: core?.metrics || null,
        };
    } finally {
        PROTO.step = ORIGINAL_STEP;
        core?.close();
        SIM.dispose('benchmark');
    }
}
async function measurePaired({ count, steps, warmup }) {
    const Q = window.__rallyPerf,
        MODES = ['raw-current', ...(window.__baselineSDK ? ['sdk-baseline'] : []), 'sdk-current'],
        CASES = [],
        RULES = Q.GameRuleDefinition.resolve({
            overrides: {
                simulation: {
                    tps: 20,
                },
            },
        });
    Q.GameRuleDefinition.current = RULES;
    const ORIGINAL = Q.StrategySim.prototype.step;
    let active = null;
    Q.StrategySim.prototype.step = function (...args) {
        const START = performance.now();
        try {
            return ORIGINAL.apply(this, args);
        } finally {
            if (active) {
                active.step += performance.now() - START;
            }
        }
    };
    const SAMPLE = (values) => {
        const SORTED = values.slice(warmup).sort((a, b) => a - b);
        return {
            p50: SORTED[Math.floor(SORTED.length * 0.5)],
            p95: SORTED[Math.floor(SORTED.length * 0.95)],
            mean: SORTED.reduce((a, b) => a + b, 0) / SORTED.length,
        };
    };
    try {
        for (const MODE of MODES) {
            const SIM = new Q.StrategySim(
                {
                    decks: {
                        host: ['swordsman'],
                        guest: ['swordsman'],
                    },
                    defenseCards: {
                        host: [],
                        guest: [],
                    },
                },
                831047,
                RULES,
            );
            SIM.applyDebugScenario({
                kind: 'unit-combat',
                allyType: 'swordsman',
                enemyType: 'swordsman',
                allyCount: Math.min(count, 60),
                enemyCount: Math.min(count, 60),
                research: false,
                humanRole: 'host',
            });
            if (count > 60) {
                for (const SIDE of [0, 1]) {
                    for (let i = 60; i < count; i++) {
                        SIM.spawnUnit(
                            SIDE,
                            'swordsman',
                            SIM.world.width * 0.5 + (((i - 60) % 16) - 7.5) * 40,
                            SIM.world.height * 0.5 + (SIDE === 0 ? 1 : -1) * (240 + Math.floor((i - 60) / 16) * 40),
                        );
                    }
                }
            }
            SIM.rebuildRuntimeIndexes();
            const ROW = {
                mode: MODE,
                sim: SIM,
                initialUnits: SIM.units.length,
                total: [],
                game: [],
                save: [],
                coreOnly: [],
                core: null,
                adapter: null,
            };
            if (MODE.startsWith('sdk')) {
                const SDK = MODE === 'sdk-current' ? window.__newSDK : window.__baselineSDK,
                    ADAPTER = new Q.RallySimulationAdapter({
                        sim: SIM,
                        onNetcodeFrameApplied() {},
                    }),
                    SAVE = ADAPTER.save.bind(ADAPTER);
                ROW.snapshotBytes = SAVE().length;
                ADAPTER.save = () => {
                    const START = performance.now();
                    try {
                        return SAVE();
                    } finally {
                        if (active) {
                            active.save += performance.now() - START;
                        }
                    }
                };
                ROW.adapter = ADAPTER;
                ROW.core = SDK.createSession({
                    players: ['host'],
                    localPlayerId: 'host',
                    sessionId: 'paired',
                    simulationVersion: 'rally-perf-182',
                    inputSize: 1,
                    seed: 831047,
                    adapter: ADAPTER,
                    recordReplay: true,
                    profile: {
                        ...SDK.profiles.rts,
                        baseInputDelayTicks: 0,
                        adaptiveInputDelay: false,
                        pacingPolicy: 'none',
                        maxSnapshotBytes: 8 * 1024 * 1024,
                        maxHistoryBytes: 256 * 1024 * 1024,
                    },
                });
            }
            CASES.push(ROW);
        }
        const INPUT = new Uint8Array(1);
        let sequence = 0;
        for (let tick = 0; tick < steps + warmup; tick++) {
            const ACTION =
                tick % 17 === 4
                    ? {
                          type: 'SET_FLAG',
                          x: CASES[0].sim.world.width * 0.5 + (tick % 3) * 10,
                          y: CASES[0].sim.world.height * 0.5 - 300,
                          forced: true,
                      }
                    : null;
            if (ACTION) {
                sequence++;
            }
            const ORDER = tick % 2 ? [...CASES].reverse() : CASES;
            for (const ROW of ORDER) {
                if (ACTION) {
                    if (ROW.core) {
                        ROW.core.queueCommand(Q.RallyCommandCodec.encode(ACTION));
                    } else {
                        ROW.sim.queueCommand({
                            actor: 'host',
                            seq: tick * 4096 + 1,
                            tick: tick + 1,
                            netcodeSequence: sequence,
                            action: ACTION,
                        });
                    }
                }
                active = {
                    step: 0,
                    save: 0,
                };
                const START = performance.now();
                if (ROW.core) {
                    if (ROW.core.advance(INPUT).status !== 'advanced') {
                        throw Error('Core did not advance');
                    }
                    if (ROW.core.tick % 20 === 0) {
                        ROW.core.getStateHash();
                    }
                } else {
                    ROW.sim.step();
                }
                const TOTAL = performance.now() - START;
                ROW.total.push(TOTAL);
                ROW.game.push(active.step);
                ROW.save.push(active.save);
                ROW.coreOnly.push(Math.max(0, TOTAL - active.step - active.save));
                active = null;
            }
        }
        const REPORT = CASES.map((row) => ({
            mode: row.mode,
            initialUnits: row.initialUnits,
            finalUnits: row.sim.units.length,
            snapshotBytes: row.snapshotBytes ?? null,
            ticks: row.sim.tick,
            tps: row.sim.tps,
            totalMs: SAMPLE(row.total),
            gameStepMs: SAMPLE(row.game),
            adapterSaveMs: SAMPLE(row.save),
            runtimeResidualMs: SAMPLE(row.coreOnly),
            finalGameplayHash: row.sim.checksumBundle({
                includeScheduled: false,
            }).root,
            stateHash: row.adapter ? window.__hashBytes(row.adapter.save()) : null,
        }));
        if (
            new Set(REPORT.map((r) => r.finalGameplayHash)).size !== 1 ||
            new Set(REPORT.filter((r) => r.stateHash !== null).map((r) => r.stateHash)).size !== 1
        ) {
            throw Error('Paired gameplay/state mismatch');
        }
        return REPORT;
    } finally {
        active = null;
        Q.StrategySim.prototype.step = ORIGINAL;
        for (const ROW of CASES) {
            ROW.core?.close();
            ROW.sim.dispose('paired-benchmark');
        }
    }
}
try {
    const LEGACY = LEGACY_HTML
            ? await prepare(LEGACY_HTML, 'legacy', fs.realpathSync(path.dirname(LEGACY_PATH)))
            : null,
        CURRENT = await prepare(CURRENT_HTML, 'current');
    const PAIRED = process.env.RALLY_PAIRED === '1';
    if (PAIRED) {
        for (const COUNT of COUNTS) {
            const GROUP = await CURRENT.evaluate(measurePaired, {
                count: COUNT,
                steps: STEPS,
                warmup: WARMUP,
            });
            RESULTS.push(...GROUP);
            console.log(JSON.stringify(GROUP));
        }
    } else {
        for (let round = 0; round < 2; round++) {
            for (const COUNT of COUNTS) {
                const ORDERED = [
                    ...(LEGACY ? ['raw-legacy'] : []),
                    'raw-current',
                    ...(BASELINE_SOURCE ? ['sdk-baseline'] : []),
                    'sdk-current',
                ];
                const MODES = round ? ORDERED.reverse() : ORDERED,
                    GROUP = [];
                for (const MODE of MODES) {
                    const RESULT = await (MODE === 'raw-legacy' ? LEGACY : CURRENT).evaluate(measure, {
                        mode: MODE,
                        count: COUNT,
                        steps: STEPS,
                        warmup: WARMUP,
                        round,
                    });
                    RESULTS.push(RESULT);
                    GROUP.push(RESULT);
                    console.log(JSON.stringify(RESULT));
                }
                assert.equal(
                    new Set(GROUP.map((r) => r.finalGameplayHash)).size,
                    1,
                    'Same scenario/input timeline must preserve gameplay',
                );
                assert.equal(
                    new Set(GROUP.filter((r) => r.stateHash !== null).map((r) => r.stateHash)).size,
                    1,
                    'SDK comparison must preserve the complete game memento',
                );
            }
        }
    }
    assert.deepEqual(PAGE_ERRORS, [], 'Game fixture must not report uncaught browser errors');
    fs.mkdirSync(resultsDirectory, {
        recursive: true,
    });
    fs.writeFileSync(
        path.join(resultsDirectory, PAIRED ? 'rally-paired-benchmark.json' : 'rally-benchmark.json'),
        JSON.stringify(
            {
                htmlPath: HTML_PATH,
                baselineHtml: process.env.RALLY_BASELINE_HTML ?? null,
                baselineModule: process.env.RALLY_BASELINE_MODULE ?? null,
                browser: BROWSER.version(),
                steps: STEPS,
                warmup: WARMUP,
                interleaved: PAIRED,
                periodicHashInterval: PAIRED ? 20 : null,
                results: RESULTS,
            },
            null,
            2,
        ),
    );
} finally {
    await BROWSER.close();
}

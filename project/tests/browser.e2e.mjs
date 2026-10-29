import { exerciseFrameMetrics } from '../../modules/debug-tools/tests/frame-metrics.browser.mjs';
import { exerciseBudgetedScheduler } from '../../modules/work-scheduler/tests/work-scheduler.browser.mjs';
import {
    exercisePseudoRandomDistribution,
    exercisePseudoRandomDistributionJobs,
} from '../../modules/deterministic/tests/pseudo-random-distribution.mjs';
/* global demo, inputPreviewDemo, renderProbe */
import { runFrameChecks } from '../../modules/interpolation/tests/presentation-frame.browser.js';
import { exerciseVectorAssets } from '../../modules/vector-assets/tests/runtime.browser.mjs';
import { exerciseVectorAssetQualityExample } from '../../modules/vector-assets/tests/quality-example.browser.mjs';
import {
    exerciseWebGLDevice,
    exerciseVectorRenderer,
    exerciseFontAssetLoader,
} from '../../modules/rendering/tests/device.browser.mjs';
import { exerciseReusableMeshes } from '../../modules/rendering/tests/mesh.browser.mjs';
import { exerciseRendererInterleaving } from '../../modules/rendering/tests/interop.browser.mjs';
import { exerciseOrderedAssetBatch } from '../../modules/rendering/tests/ordered-batch.browser.mjs';
import { exerciseMeshDepth } from '../../modules/rendering/tests/mesh-depth.browser.mjs';
import { exerciseMeshAlphaDepthWrite } from '../../modules/rendering/tests/mesh-alpha-depth.browser.mjs';
import { exercisePrimitiveShapes } from '../../modules/rendering/tests/primitive-shapes.browser.mjs';
import { exerciseVectorContext } from '../../modules/rendering/tests/vector-context.browser.mjs';
import { exerciseVectorGameCoverage } from '../../modules/rendering/tests/vector-game-coverage.browser.mjs';
import { runPresentationChecks } from './presentation.browser.js';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { runRenderObjectChecks } from '../../modules/interpolation/tests/render-object.browser.js';
import { createHash } from 'node:crypto';
import { compileVectorAsset } from '../../modules/vector-assets/compiler.js';
const ROOT = resolve('.');
const DETERMINISTIC_RANDOMNESS = exercisePseudoRandomDistribution();
const DETERMINISTIC_RANDOMNESS_JOBS = exercisePseudoRandomDistributionJobs();
let retryFontRequests = 0;
let sharedFontRequests = 0;
let vectorSvgFetches = 0;
const SERVER = createServer(async (req, res) => {
    try {
        const PATHNAME = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (PATHNAME === '/__font-retry' && ++retryFontRequests === 1) {
            res.writeHead(503, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            }).end();
            return;
        }
        if (PATHNAME === '/__font-delay') {
            setTimeout(() => serveFont(res), 200);
            return;
        }
        if (PATHNAME === '/__font-retry') {
            await serveFont(res);
            return;
        }
        if (PATHNAME === '/modules/vector-assets/assets/seed-scout.svg') {
            vectorSvgFetches++;
        }
        const PATH = resolve(ROOT, '.' + PATHNAME);
        if (!PATH.startsWith(ROOT + sep)) {
            res.writeHead(403).end();
            return;
        }
        res.setHeader(
            'Content-Type',
            {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.json': 'application/json',
            }[extname(PATH)] ?? 'application/octet-stream',
        );
        if (PATHNAME === '/dist/assets/fonts/noto-sans-kr-700-v1.json' && req.headers.host?.startsWith('127.0.0.1:')) {
            sharedFontRequests++;
        }
        if (PATHNAME.startsWith('/dist/assets/fonts/') && !req.headers.host?.startsWith('localhost:')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
        res.end(await readFile(PATH));
    } catch {
        res.writeHead(404).end();
    }
});
async function serveFont(res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(await readFile(resolve(ROOT, 'dist/assets/fonts/noto-sans-kr-700-v1.json')));
}
await new Promise((resolve) => SERVER.listen(0, '127.0.0.1', resolve));
let browser;
const REPORT = {
    stages: [],
    deterministicRandomness: DETERMINISTIC_RANDOMNESS,
    deterministicRandomnessJobs: DETERMINISTIC_RANDOMNESS_JOBS,
};
REPORT.stages.push('deterministic PRD mean, variance, failure streaks, seeded replay, and state restore');
REPORT.stages.push('bounded PRD job chunk invariance, capture/restore, and aggregate-only completion');
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : {}),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const PAGE = await browser.newPage({
        viewport: {
            width: 1000,
            height: 800,
        },
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => {
        ERRORS.push(error.message);
        console.error('Browser runtime:', error.stack ?? error.message);
    });
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/interpolation/examples/index.html`);
    await PAGE.waitForFunction(() => window.demo?.diagnostics.frames >= 30);
    assert.equal(await PAGE.evaluate(() => demo.renderer.stats().backend), 'webgl2');
    const CLOCK_CHECK = await PAGE.evaluate(async () => {
        const {
            createLoop: CREATE_LOOP,
            createDeadlineScheduler: CREATE_DEADLINE_SCHEDULER,
            clockRates: CLOCK_RATES,
        } = await import('/dist/simloop.js');
        const { InterpolationTimeline: INTERPOLATION_TIMELINE } = await import('/dist/interpolation.js');
        let rejected = false;
        try {
            CLOCK_RATES({
                baseHz: 60,
                tickRate: 45,
                inputHz: 60,
                renderHz: 60,
            });
        } catch (e) {
            rejected = e instanceof RangeError;
        }
        const VALID = CLOCK_RATES({
            baseHz: 60,
            tickRate: 30,
            inputHz: 60,
            renderHz: 60,
        });
        const SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 30,
                maxCatchupSteps: 2,
            },
            poll() {},
            releaseInput() {},
            advance() {
                this.tick++;
                return {
                    status: 'advanced',
                };
            },
        };
        const LOOP = CREATE_LOOP({
            session: SESSION,
            backlogPolicy: 'retain',
            maxBacklogTicks: 2,
            rates: VALID,
        });
        let now = 0;
        let callback = null;
        let delay = 0;
        LOOP.observeInput(0);
        LOOP.pulse(0, {
            render: false,
            input: false,
        });
        const TIMER = CREATE_DEADLINE_SCHEDULER({
            getDeadlineMs: () => LOOP.nextDeadlineMs,
            pulse: (t) =>
                LOOP.pulse(t, {
                    render: false,
                    input: false,
                }),
            now: () => now,
            setTimer: (cb, ms) => {
                callback = cb;
                delay = ms;
                return 1;
            },
            clearTimer() {
                callback = null;
            },
        });
        TIMER.start();
        const ADVANCES = [];
        for (let i = 0; i < 12; i++) {
            now += delay + (i % 2 ? 0.1 : 2);
            const BEFORE = SESSION.tick;
            callback();
            ADVANCES.push(SESSION.tick - BEFORE);
        }
        now += 1000;
        callback();
        for (let i = 0; i < 20 && LOOP.nextDeadlineMs <= now; i++) {
            now += delay;
            callback();
        }
        const CAUGHT_UP = SESSION.tick >= 40;
        TIMER.stop();
        const DEFER_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 2,
            },
            polls: 0,
            attempts: 0,
            poll() {
                this.polls++;
            },
            releaseInput() {},
            advance() {
                this.attempts++;
                if (this.waitOnce) {
                    this.waitOnce = false;
                    return {
                        status: 'waiting',
                        tick: this.tick,
                    };
                }
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        const OVERFLOW = [];
        let allowDefer = false;
        const DEFER = CREATE_LOOP({
            session: DEFER_SESSION,
            backlogPolicy: 'defer',
            maxBacklogTicks: 3,
            getInput: () => Uint8Array.of(0),
            canAdvance: () => allowDefer,
            onBacklogDrop: (event) => OVERFLOW.push(event),
        });
        const DEFER_PULSES = [];
        const PULSE_DEFER = (at) => {
            const BEFORE_TICK = DEFER_SESSION.tick,
                BEFORE_ATTEMPTS = DEFER_SESSION.attempts;
            DEFER.pulse(at, {
                render: false,
            });
            DEFER_PULSES.push({
                tickDelta: DEFER_SESSION.tick - BEFORE_TICK,
                attempts: DEFER_SESSION.attempts - BEFORE_ATTEMPTS,
                debt: DEFER.simulationTimeMs === null ? 0 : at - DEFER.simulationTimeMs,
            });
        };
        PULSE_DEFER(0);
        PULSE_DEFER(100);
        DEFER_SESSION.resimulating = true;
        PULSE_DEFER(200);
        DEFER_SESSION.resimulating = false;
        PULSE_DEFER(300);
        PULSE_DEFER(350);
        allowDefer = true;
        DEFER_SESSION.waitOnce = true;
        PULSE_DEFER(450);
        PULSE_DEFER(450);
        DEFER_SESSION.resimulating = true;
        PULSE_DEFER(550);
        DEFER_SESSION.resimulating = false;
        PULSE_DEFER(550);
        allowDefer = false;
        PULSE_DEFER(650);
        allowDefer = true;
        PULSE_DEFER(650);
        const DEFER_PASSED =
            DEFER_SESSION.tick === 5 &&
            DEFER_PULSES.every((p) => p.attempts <= 2 && p.debt <= 300) &&
            DEFER_SESSION.polls === DEFER_PULSES.length &&
            DEFER_PULSES.map((p) => p.tickDelta).join(',') === '0,0,0,0,0,0,2,0,2,0,1' &&
            OVERFLOW.length === 2 &&
            OVERFLOW[0].reason === 'backlog-overflow' &&
            OVERFLOW[0].droppedMs === 50 &&
            OVERFLOW[1].reason === 'backlog-overflow' &&
            OVERFLOW[1].droppedMs === 100;
        const DROP_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 2,
            },
            poll() {},
            releaseInput() {},
            advance() {
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        let dropEvent;
        const DROP = CREATE_LOOP({
            session: DROP_SESSION,
            maxBacklogTicks: 2,
            canAdvance: () => false,
            onBacklogDrop: (event) => (dropEvent = event),
        });
        DROP.pulse(0, {
            render: false,
        });
        DROP.pulse(100, {
            render: false,
        });
        DROP.pulse(301, {
            render: false,
        });
        const DROP_COMPATIBLE =
            DROP_SESSION.tick === 0 &&
            DROP.simulationTimeMs === 301 &&
            dropEvent?.elapsedMs === 201 &&
            dropEvent.droppedTicks === 3 &&
            dropEvent.droppedMs === 301 &&
            dropEvent.reason === 'clock-gap' &&
            dropEvent.timestamp === 301 &&
            Object.keys(dropEvent).length === 5;
        const CLAMP_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 1,
            },
            poll() {},
            releaseInput() {},
            advance() {
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        const CLAMP_EVENTS = [],
            CLAMP = CREATE_LOOP({
                session: CLAMP_SESSION,
                maxBacklogTicks: 4,
                onBacklogDrop: (event) => CLAMP_EVENTS.push(event),
            });
        CLAMP.pulse(0, {
            render: false,
        });
        CLAMP.pulse(300, {
            render: false,
        });
        const CLAMP_REPORTING_PASSED =
            CLAMP_SESSION.tick === 1 &&
            CLAMP_EVENTS.length === 2 &&
            CLAMP_EVENTS[0].reason === 'input-dt-clamp' &&
            CLAMP_EVENTS[0].droppedMs === 50 &&
            CLAMP_EVENTS[0].droppedTicks === 0 &&
            CLAMP_EVENTS[1].reason === 'backlog-overflow' &&
            CLAMP_EVENTS[1].droppedMs === 150 &&
            CLAMP_EVENTS[1].droppedTicks === 1;
        const STALLED_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 3,
            },
            poll() {},
            releaseInput() {},
            advance() {
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        let stalledDrop;
        const STALLED = CREATE_LOOP({
            session: STALLED_SESSION,
            maxBacklogTicks: 3,
            canAdvance: () => false,
            onBacklogDrop: (event) => (stalledDrop = event),
        });
        STALLED.pulse(0, {
            render: false,
        });
        STALLED.pulse(200, {
            render: false,
        });
        const STALLED_REPORTING_PASSED =
            stalledDrop?.reason === 'drop-policy' &&
            stalledDrop.droppedMs === 100 &&
            stalledDrop.droppedTicks === 1 &&
            STALLED.simulationTimeMs === 100;
        const GAP_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 2,
            },
            poll() {},
            releaseInput() {},
            advance() {
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        let gapEvent;
        const GAP = CREATE_LOOP({
            session: GAP_SESSION,
            backlogPolicy: 'defer',
            maxBacklogTicks: 3,
            canAdvance: () => false,
            onBacklogDrop: (event) => (gapEvent = event),
        });
        GAP.pulse(0, {
            render: false,
        });
        GAP.pulse(300, {
            render: false,
        });
        GAP.pulse(700, {
            render: false,
        });
        const LONG_GAP_PASSED =
            gapEvent?.reason === 'clock-gap' &&
            gapEvent.elapsedMs === 400 &&
            gapEvent.droppedMs === 700 &&
            GAP.simulationTimeMs === 700;
        const PAUSE_SESSION = {
            inputSize: 1,
            tick: 0,
            pace: 1,
            closed: false,
            resimulating: false,
            profile: {
                tickRate: 10,
                maxCatchupSteps: 2,
            },
            poll() {},
            releaseInput() {},
            advance() {
                return {
                    status: 'advanced',
                    tick: ++this.tick,
                };
            },
        };
        let resumeAllowed = false;
        const PAUSED = CREATE_LOOP({
            session: PAUSE_SESSION,
            backlogPolicy: 'defer',
            maxBacklogTicks: 3,
            canAdvance: () => resumeAllowed,
        });
        PAUSED.pulse(0, {
            render: false,
        });
        PAUSED.pulse(80, {
            render: false,
        });
        PAUSED.resetTiming();
        resumeAllowed = true;
        PAUSED.pulse(1000, {
            render: false,
        });
        const PAUSE_CLEARED = PAUSED.simulationTimeMs === 1000 && PAUSE_SESSION.tick === 0;
        PAUSED.pulse(1100, {
            render: false,
        });
        const PAUSE_PASSED = PAUSE_CLEARED && PAUSE_SESSION.tick === 1;
        const VISIBILITY_DESCRIPTOR = Object.getOwnPropertyDescriptor(document, 'hidden');
        let visibilityPassed;
        try {
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                value: false,
            });
            const CALLBACKS = [];
            let visibleAllowed = false;
            const VISIBLE_SESSION = {
                inputSize: 1,
                tick: 0,
                pace: 1,
                closed: false,
                resimulating: false,
                profile: {
                    tickRate: 10,
                    maxCatchupSteps: 2,
                },
                poll() {},
                released: 0,
                releaseInput() {
                    this.released++;
                },
                advance() {
                    return {
                        status: 'advanced',
                        tick: ++this.tick,
                    };
                },
            };
            const VISIBLE_LOOP = CREATE_LOOP({
                session: VISIBLE_SESSION,
                backlogPolicy: 'defer',
                maxBacklogTicks: 3,
                canAdvance: () => visibleAllowed,
                getInput: () => Uint8Array.of(0),
                requestFrame: (callback) => {
                    CALLBACKS.push(callback);
                    return CALLBACKS.length;
                },
                cancelFrame: () => {},
            });
            const FIRE = (at) => {
                const CALLBACK = CALLBACKS.shift();
                if (!CALLBACK) {
                    throw Error('missing fake frame');
                }
                CALLBACK(at);
            };
            VISIBLE_LOOP.start();
            FIRE(0);
            FIRE(100);
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                value: true,
            });
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                value: false,
            });
            visibleAllowed = true;
            FIRE(1000);
            const NO_HIDDEN_CATCHUP = VISIBLE_LOOP.simulationTimeMs === 1000 && VISIBLE_SESSION.tick === 0;
            FIRE(1100);
            visibilityPassed = NO_HIDDEN_CATCHUP && VISIBLE_SESSION.tick === 1 && VISIBLE_SESSION.released === 1;
            VISIBLE_LOOP.stop();
        } finally {
            if (VISIBILITY_DESCRIPTOR) {
                Object.defineProperty(document, 'hidden', VISIBILITY_DESCRIPTOR);
            } else {
                delete document.hidden;
            }
        }
        const TIMELINE = new INTERPOLATION_TIMELINE({
            stepMs: 1000 / 30,
            delayMs: 2000 / 30,
            schema: {
                x: 'number',
            },
        });
        const PACKET = (tick, x) => ({
            revision: 0,
            sequence: tick,
            timeMs: (tick * 1000) / 30,
            entities: [
                {
                    id: 'u',
                    generation: 0,
                    values: {
                        x,
                    },
                },
            ],
        });
        TIMELINE.accept(PACKET(0, 0), 0);
        TIMELINE.accept(PACKET(1, 10), 38);
        TIMELINE.accept(PACKET(2, 20), 70);
        const OUT = {};
        TIMELINE.sampleInto('u', 0, 83.3333333333, OUT);
        const X = OUT.x;
        TIMELINE.accept(PACKET(3, 30), 103);
        TIMELINE.accept(PACKET(4, 40), 134);
        TIMELINE.sampleInto('u', 0, 150, OUT);
        return {
            rejected,
            divisor: VALID.simulationDivisor,
            advances: ADVANCES,
            caughtUp: CAUGHT_UP,
            x: X,
            end: OUT.x,
            deferPassed: DEFER_PASSED,
            dropCompatible: DROP_COMPATIBLE,
            longGapPassed: LONG_GAP_PASSED,
            clampReportingPassed: CLAMP_REPORTING_PASSED,
            stalledReportingPassed: STALLED_REPORTING_PASSED,
            pausePassed: PAUSE_PASSED,
            visibilityPassed,
            deferTicks: DEFER_SESSION.tick,
            deferPolls: DEFER_SESSION.polls,
            deferPulses: DEFER_PULSES,
            overflow: OVERFLOW,
            gapEvent,
        };
    });
    assert.equal(CLOCK_CHECK.rejected, true);
    assert.equal(CLOCK_CHECK.divisor, 2);
    assert.deepEqual(CLOCK_CHECK.advances, Array(12).fill(1));
    assert.equal(CLOCK_CHECK.caughtUp, true);
    assert.ok(
        CLOCK_CHECK.deferPassed &&
            CLOCK_CHECK.dropCompatible &&
            CLOCK_CHECK.longGapPassed &&
            CLOCK_CHECK.clampReportingPassed &&
            CLOCK_CHECK.stalledReportingPassed &&
            CLOCK_CHECK.pausePassed &&
            CLOCK_CHECK.visibilityPassed,
        `bounded defer policy verification: ${JSON.stringify(CLOCK_CHECK)}`,
    );
    assert.ok(Math.abs(CLOCK_CHECK.x - 5) < 1e-6);
    assert.ok(Math.abs(CLOCK_CHECK.end - 25) < 1e-6);
    REPORT.stages.push(
        'integer clock divisors, loop-owned jittered deadlines, default drop compatibility, explicit retain/defer timing, bounded overflow diagnostics, hold/resim polling, pause/hidden reset and simulation-time interpolation',
    );
    REPORT.presentationFrame = await runFrameChecks(PAGE);
    const FRAME_PAGE = await browser.newPage();
    const FRAME_ERRORS = [];
    FRAME_PAGE.on('pageerror', (e) => FRAME_ERRORS.push(e.message));
    await FRAME_PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/interpolation/examples/frame.html`);
    await FRAME_PAGE.waitForFunction(() => document.querySelector('#status').textContent.includes('displayed: 1'));
    await FRAME_PAGE.locator('#rollback').click();
    await FRAME_PAGE.locator('#spawn').click();
    assert.deepEqual(FRAME_ERRORS, []);
    await FRAME_PAGE.close();
    const INITIAL_X = await PAGE.evaluate(() => demo.diagnostics.authorityX);
    await PAGE.keyboard.down('KeyD');
    await PAGE.waitForFunction((x) => demo.diagnostics.authorityX > x + 25, INITIAL_X);
    await PAGE.keyboard.up('KeyD');
    await PAGE.waitForFunction(() => Math.abs(demo.diagnostics.poseX - demo.diagnostics.authorityX) < 0.1);
    REPORT.stages.push('real DOM keyboard → 100ms authority → interpolation → WebGL rAF movement');

    // Several render-time samples cannot erase a down/up entirely between simulation ticks.
    await PAGE.evaluate(() => demo.pause());
    const ROLLS = await PAGE.evaluate(() => demo.diagnostics.rolls);
    await PAGE.keyboard.press('Space');
    const TAP = await PAGE.evaluate(() => {
        const OUT = {};
        for (let i = 0; i < 8; i++) {
            demo.actions.sampleInto('roll', OUT);
        }
        return OUT;
    });
    assert.deepEqual(TAP, {
        held: false,
        pressed: true,
        released: true,
    });
    await PAGE.evaluate(() => demo.pause(false));
    await PAGE.waitForFunction((n) => demo.diagnostics.rolls === n + 1, ROLLS);
    // UI controls never generate a held game action.
    await PAGE.locator('#zoom').focus();
    await PAGE.keyboard.down('ArrowRight');
    assert.equal(await PAGE.evaluate(() => demo.actions.sample('right').held), false);
    await PAGE.keyboard.up('ArrowRight');
    REPORT.stages.push('quick tap survives render samples until fixed-step consume; editable UI excluded');
    const BOUNDS = await PAGE.locator('canvas').boundingBox();
    await PAGE.touchscreen.tap(BOUNDS.x + BOUNDS.width * 0.72, BOUNDS.y + BOUNDS.height * 0.6);
    const ROLL_BEFORE_TOUCH = await PAGE.evaluate(() => demo.diagnostics.rolls);
    await PAGE.touchscreen.tap(BOUNDS.x + BOUNDS.width * 0.72 + 2, BOUNDS.y + BOUNDS.height * 0.6 + 2);
    await PAGE.waitForFunction((n) => demo.diagnostics.rolls > n, ROLL_BEFORE_TOUCH);
    await PAGE.keyboard.down('KeyW');
    await PAGE.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await PAGE.evaluate(() => demo.actions.sample('up').held), false);
    await PAGE.keyboard.up('KeyW');
    REPORT.stages.push('actual touch double-tap maps to game roll; blur releases held keyboard');
    await PAGE.setViewportSize({
        width: 620,
        height: 800,
    });
    await PAGE.waitForFunction(() => {
        const C = document.querySelector('canvas');
        return C.width === Math.round(C.getBoundingClientRect().width * 2);
    });
    REPORT.scene = await PAGE.evaluate(() => {
        const D = demo.diagnostics,
            R = demo.renderer,
            GL = R.device.gl;
        const INTERVALS = D.frameIntervals.slice().sort((a, b) => a - b);
        return {
            frames: D.frames,
            tick: D.tick,
            observedFps: D.fps,
            cpuSubmitMs: D.cpuSubmitMs,
            intervalP50Ms: INTERVALS[Math.floor(INTERVALS.length / 2)],
            intervalP95Ms: INTERVALS[Math.floor(INTERVALS.length * 0.95)],
            viewport: [...GL.getParameter(GL.VIEWPORT)],
            stats: R.stats(),
            error: GL.getError(),
        };
    });
    assert.equal(REPORT.scene.error, 0);
    assert.equal(REPORT.scene.stats.textureUploads, 0);
    assert.equal(REPORT.scene.stats.drawCalls, 1, 'the composed example draws its frame in one stream draw');
    assert.ok(REPORT.scene.stats.vertices > 500);
    assert.ok(REPORT.scene.stats.uploadedBytes > 0);
    REPORT.scenePixels = await PAGE.evaluate(
        () =>
            new Promise((resolve) =>
                requestAnimationFrame(() => {
                    const R = demo.renderer,
                        GL = R.device.gl,
                        PIXELS = new Uint8Array(R.canvas.width * R.canvas.height * 4);
                    GL.readPixels(0, 0, R.canvas.width, R.canvas.height, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                    let colored = 0;
                    for (let i = 0; i < PIXELS.length; i += 4) {
                        if (PIXELS[i + 1] > 100 || PIXELS[i + 2] > 120) {
                            colored++;
                        }
                    }
                    resolve({
                        colored,
                        error: GL.getError(),
                    });
                }),
            ),
    );
    assert.ok(REPORT.scenePixels.colored > 100, 'composed input/interpolation example must draw visible geometry');
    assert.equal(REPORT.scenePixels.error, 0);
    await PAGE.evaluate(() => demo.pause());

    // Continue the same built-bundle/browser flow with focused pixel/lifecycle probes.
    REPORT.rendererInterleaving = await exerciseRendererInterleaving(PAGE);
    assert.deepEqual(REPORT.rendererInterleaving.redVector, [255, 0, 0, 255], 'vector fill before the mesh');
    assert.deepEqual(
        REPORT.rendererInterleaving.blueMesh,
        [0, 0, 255, 255],
        'MeshRenderer draws between vector stream submissions',
    );
    assert.deepEqual(
        REPORT.rendererInterleaving.greenVector,
        [0, 255, 0, 255],
        'vector stream rebinds after MeshRenderer changes WebGL state',
    );
    assert.equal(REPORT.rendererInterleaving.glError, 0, 'interleaved draw stream leaves no WebGL error');
    REPORT.stages.push(
        'VectorContext stream and MeshRenderer interleave ordered draws on one WebGL2 canvas with clean state and expected pixels',
    );
    REPORT.orderedAssetBatch = await exerciseOrderedAssetBatch(PAGE);
    assert.equal(
        REPORT.orderedAssetBatch.pixelMismatch,
        0,
        'combined SVG geometry is pixel-identical to ordered individual draws',
    );
    assert.equal(REPORT.orderedAssetBatch.batched.draws, 1, 'compatible ordered assets submit in one draw');
    REPORT.stages.push(
        'MeshBuilder.combine batches painter-ordered asset geometries with per-part transforms, opacity, and shared clipping',
    );
    REPORT.meshDepth = await exerciseMeshDepth(PAGE);
    assert.equal(REPORT.meshDepth.glError, 0, 'per-instance/per-part depth leaves a clean WebGL state');
    REPORT.stages.push('MeshRenderer depth and transparent painter order compose with a following vector stream pass');
    REPORT.meshAlphaDepthWrite = await exerciseMeshAlphaDepthWrite(PAGE);
    assert.deepEqual(REPORT.meshAlphaDepthWrite.orderedRuns.pixel, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.meshAlphaDepthWrite.partOpacity.pixel, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.meshAlphaDepthWrite.instanceOpacity.pixel, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.meshAlphaDepthWrite.afterRestore.pixel, [255, 0, 0, 255]);
    REPORT.stages.push(
        'MeshRenderer alpha-threshold depth writes preserve triangle and instance painter order, opacity variants, and lifecycle',
    );
    REPORT.primitiveShapes = await exercisePrimitiveShapes(PAGE);
    assert.deepEqual(REPORT.primitiveShapes.circle, [0, 255, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.ellipse, [255, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.rect, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.primitiveShapes.rotatedRect, [255, 0, 255, 255]);
    assert.deepEqual(REPORT.primitiveShapes.line, [255, 255, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.overlap, [64, 0, 128, 255]);
    assert.deepEqual(REPORT.primitiveShapes.clippedInside, [255, 255, 255, 255]);
    assert.deepEqual(REPORT.primitiveShapes.clippedOutside, [0, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.ellipseWide, [255, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.ellipseFlat, [0, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.ellipseRotatedTall, [0, 255, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.ellipseRotatedNarrow, [0, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.boxWide, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.boxFlat, [0, 0, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.boxRotatedTall, [255, 255, 0, 255]);
    assert.deepEqual(REPORT.primitiveShapes.painter.boxRotatedNarrow, [0, 0, 0, 255]);
    assert.equal(REPORT.primitiveShapes.painter.drawCalls, 1);
    assert.equal(REPORT.primitiveShapes.painter.glError, 0);
    const VECTOR_CONTEXT_RESULT = await exerciseVectorContext(PAGE);
    REPORT.vectorContext = {
        batchedDrawCalls: VECTOR_CONTEXT_RESULT.batched.drawCalls,
        contextLossRestored: VECTOR_CONTEXT_RESULT.restored,
    };
    const VECTOR_GAME_COVERAGE_RESULT = await exerciseVectorGameCoverage(PAGE);
    REPORT.vectorGameCoverage = {
        contextLossRestored: VECTOR_GAME_COVERAGE_RESULT.restored,
    };
    assert.equal(REPORT.primitiveShapes.pathTessellations, 0);
    assert.equal(REPORT.primitiveShapes.pathStrokeBuilds, 0);
    assert.equal(REPORT.primitiveShapes.arcPointBuilds, 0);
    assert.equal(REPORT.primitiveShapes.bufferAllocationsAfterWarmup, 0);
    assert.equal(
        REPORT.primitiveShapes.drawCalls,
        1,
        'circles, ellipses, rectangles, lines, alpha and plane clips share one stream draw',
    );
    assert.ok(REPORT.primitiveShapes.uploadedBytes > 0, 'warm primitive frames upload the vertex stream');
    assert.equal(REPORT.primitiveShapes.glError, 0);
    REPORT.stages.push(
        'analytic primitives in the vector stream draw circles, ellipses, rectangles, and capped lines with order, clips, alpha, and transforms',
    );
    REPORT.rendering = await PAGE.evaluate(async () => {
        const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import('/dist/rendering.js');
        const { CameraViewport: CAMERA_VIEWPORT } = await import('/dist/camera.js');
        const CHECK = (condition, message) => {
            if (!condition) {
                throw new Error(message);
            }
        };
        const NEAR = (actual, expected, message) =>
            CHECK(
                actual.every((value, i) => Math.abs(value - expected[i]) <= 3),
                `${message}: ${actual} expected ${expected}`,
            );
        const CANVAS = document.createElement('canvas');
        CANVAS.style.cssText = 'width:64px;height:64px';
        document.body.append(CANVAS);
        const CAMERA = new CAMERA_VIEWPORT({ width: 64, height: 64, dpr: 2, x: 32, y: 32 }).resizeCanvas(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            antialias: false,
            preserveDrawingBuffer: true,
        });
        const CONTEXT = new VECTOR_CONTEXT(DEVICE);
        const ATLAS = DEVICE.textureAtlas;
        const GL = DEVICE.gl;
        const PIXEL = (x, y) => {
            const OUT = new Uint8Array(4);
            GL.readPixels(
                Math.floor(x * 2),
                CANVAS.height - 1 - Math.floor(y * 2),
                1,
                1,
                GL.RGBA,
                GL.UNSIGNED_BYTE,
                OUT,
            );
            return [...OUT];
        };
        const FRAME = (clearColor, draw) => {
            CHECK(CONTEXT.beginFrame({ clearColor }), 'frame available');
            CAMERA.applyToContext(CONTEXT);
            draw();
            return { ...CONTEXT.endFrame() };
        };
        // Center-anchored helpers in camera world units.
        const RECT = (x, y, width, height, paint) => {
            CONTEXT.fillStyle = paint;
            CONTEXT.fillRect(x - width / 2, y - height / 2, width, height);
        };
        const IMAGE_AT = (region, x, y, width, height) =>
            CONTEXT.drawRegion(region, x - width / 2, y - height / 2, width, height);
        const BYTES = (width, height, data, filter = 'nearest') => {
            const REGION = ATLAS.allocate(width, height, { filter });
            ATLAS.upload(REGION, { width, height, data: new Uint8Array(data) });
            return REGION;
        };
        const RED = [1, 0, 0, 0.5],
            BLUE = [0, 0, 1, 1],
            GREEN = [0, 1, 0, 1];
        const HALF_RED = BYTES(1, 1, [255, 0, 0, 128]);
        FRAME(BLUE, () => {
            RECT(16, 32, 20, 30, RED);
            IMAGE_AT(HALF_RED, 48, 32, 20, 30);
        });
        const PRIMITIVE_ALPHA = PIXEL(16, 32),
            TEXTURE_ALPHA = PIXEL(48, 32);
        NEAR(PRIMITIVE_ALPHA, [128, 0, 127, 255], 'primitive premultiplied alpha');
        NEAR(TEXTURE_ALPHA, [128, 0, 127, 255], 'byte region must be premultiplied exactly once');
        const IMAGE = document.createElement('canvas');
        IMAGE.width = IMAGE.height = 1;
        IMAGE.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([255, 0, 0, 128]), 1, 1), 0, 0);
        const DOM_REGION = ATLAS.allocate(1, 1, { filter: 'nearest' });
        ATLAS.upload(DOM_REGION, IMAGE);
        FRAME(BLUE, () => IMAGE_AT(DOM_REGION, 32, 32, 32, 32));
        NEAR(PIXEL(32, 32), [128, 0, 127, 255], 'DOM source alpha');
        const BITMAP = await createImageBitmap(IMAGE, {
            premultiplyAlpha: 'none',
        });
        let bitmapRejected = false;
        try {
            ATLAS.upload(DOM_REGION, BITMAP);
        } catch {
            bitmapRejected = true;
        } finally {
            BITMAP.close();
        }
        CHECK(bitmapRejected, 'ambiguous bitmap alpha must be rejected');
        const ORDER_STATS = FRAME(BLUE, () => {
            IMAGE_AT(HALF_RED, 32, 32, 40, 40);
            RECT(32, 32, 40, 40, GREEN);
            IMAGE_AT(HALF_RED, 32, 32, 20, 20);
        });
        NEAR(PIXEL(32, 32), [128, 127, 0, 255], 'regions and fills keep transparent painter order');
        NEAR(PIXEL(17, 32), [0, 255, 0, 255], 'outer opaque layer');
        CHECK(ORDER_STATS.drawCalls === 1, `regions and fills share one stream draw: ${ORDER_STATS.drawCalls}`);
        const QUAD = BYTES(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
        FRAME([0, 0, 0, 0], () => IMAGE_AT(QUAD, 32, 32, 40, 40));
        NEAR(PIXEL(20, 20), [255, 0, 0, 255], 'region top-left');
        NEAR(PIXEL(44, 20), [0, 255, 0, 255], 'region top-right');
        NEAR(PIXEL(20, 44), [0, 0, 255, 255], 'region bottom-left');
        // NPOT and transparent gutter linear filtering operate on premultiplied texels.
        const LINEAR = BYTES(3, 1, [255, 0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0], 'linear');
        FRAME(BLUE, () => IMAGE_AT(LINEAR, 32, 32, 48, 20));
        const FILTERED = PIXEL(24, 32);
        CHECK(FILTERED[0] > 60 && FILTERED[0] < 200 && FILTERED[1] <= 2, `filtered fringe: ${FILTERED}`);
        // Updating a region with queued draws first submits them; the next draw sees the update.
        FRAME(BLUE, () => {
            IMAGE_AT(HALF_RED, 16, 32, 20, 20);
            ATLAS.upload(HALF_RED, { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) });
            IMAGE_AT(HALF_RED, 48, 32, 20, 20);
        });
        NEAR(PIXEL(16, 32), [128, 0, 127, 255], 'queued old region pixels');
        NEAR(PIXEL(48, 32), [0, 255, 0, 255], 'updated region pixels');
        const RECTS = () => {
            for (let i = 0; i < 25; i++) {
                RECT(i * 2, 32, 2, 2, GREEN);
            }
        };
        FRAME([0, 0, 0, 0], RECTS);
        const ALLOCATIONS = DEVICE.stats.bufferAllocations;
        const STATS = FRAME([0, 0, 0, 0], RECTS);
        CHECK(
            STATS.drawCalls === 1 && STATS.textureUploads === 0 && STATS.uploadedBytes > 0,
            `steady frame is one stream draw without texture uploads: ${JSON.stringify(STATS)}`,
        );
        CHECK(DEVICE.stats.bufferAllocations === ALLOCATIONS, 'steady frames reuse the stream buffer');
        CAMERA.setCamera({
            x: 12,
            y: 24,
            zoom: 2,
            rotation: Math.PI / 2,
        });
        const SCREEN = {},
            WORLD = {};
        CAMERA.planeToScreenInto(15, 28, SCREEN);
        CAMERA.screenToPlaneInto(SCREEN.x, SCREEN.y, WORLD);
        CHECK(Math.abs(WORLD.x - 15) < 1e-6 && Math.abs(WORLD.y - 28) < 1e-6, 'camera inverse roundtrip');
        FRAME([0, 0, 0, 0], () => {
            RECT(12, 24, 2, 2, GREEN);
            RECT(16, 24, 2, 2, GREEN);
        });
        NEAR(PIXEL(32, 32), [0, 255, 0, 255], 'camera center at viewport center');
        NEAR(PIXEL(32, 24), [0, 255, 0, 255], 'camera rotation/zoom moves positive world x upward');
        CHECK(GL.getError() === GL.NO_ERROR, 'actual GL error must be NO_ERROR');
        window.renderProbe = {
            canvas: CANVAS,
            device: DEVICE,
            context: CONTEXT,
            camera: CAMERA,
            region: HALF_RED,
            pixel: PIXEL,
            frame: FRAME,
            imageAt: IMAGE_AT,
        };
        return {
            primitiveAlpha: PRIMITIVE_ALPHA,
            textureAlpha: TEXTURE_ALPHA,
            filtered: FILTERED,
            version: GL.getParameter(GL.VERSION),
            shadingLanguage: GL.getParameter(GL.SHADING_LANGUAGE_VERSION),
            stats: STATS,
            viewport: [...GL.getParameter(GL.VIEWPORT)],
            bitmapRejected,
        };
    });
    assert.deepEqual(REPORT.rendering.viewport, [0, 0, 128, 128]);
    REPORT.stages.push(
        'actual WebGL readPixels alpha/order/region orientation/update, NPOT, camera/DPR, one reused stream buffer',
    );
    const SUPPORTS_LOSS = await PAGE.evaluate(() => {
        renderProbe.loss = renderProbe.device.gl.getExtension('WEBGL_lose_context');
        if (!renderProbe.loss) {
            return false;
        }
        renderProbe.loss.loseContext();
        return true;
    });
    if (SUPPORTS_LOSS) {
        await PAGE.waitForFunction(() => renderProbe.device.state === 'lost');
        assert.equal(await PAGE.evaluate(() => renderProbe.context.beginFrame()), false);
        await PAGE.evaluate(() => renderProbe.loss.restoreContext());
        await PAGE.waitForFunction(() => renderProbe.device.state === 'ready' && renderProbe.context.state === 'ready');
        const RESTORED = await PAGE.evaluate(() => {
            const { camera: CAMERA, region: REGION, pixel: PIXEL, frame: FRAME, imageAt: IMAGE_AT } = renderProbe;
            CAMERA.setCamera({
                x: 32,
                y: 32,
                zoom: 1,
                rotation: 0,
            });
            FRAME([0, 0, 1, 1], () => IMAGE_AT(REGION, 32, 32, 24, 24));
            return {
                pixel: PIXEL(32, 32),
                error: renderProbe.device.gl.getError(),
            };
        });
        assert.deepEqual(RESTORED.pixel, [0, 255, 0, 255]);
        assert.equal(RESTORED.error, 0);
        REPORT.stages.push('WEBGL_lose_context → skipped lost frame → stream, pipeline and atlas region restoration');
    } else {
        REPORT.stages.push('WEBGL_lose_context unavailable: restoration not executed');
    }
    REPORT.input = await PAGE.evaluate(async () => {
        const { ActionState: ACTION_STATE, createDOMInput: CREATE_DOM_INPUT } = await import('/dist/input.js');
        const CHECK = (condition, message) => {
            if (!condition) {
                throw new Error(message);
            }
        };
        const CANVAS = renderProbe.canvas,
            STATE = new ACTION_STATE(),
            POINTER_EVENTS = [],
            RELEASES = [];
        const INPUT = CREATE_DOM_INPUT({
            target: CANVAS,
            state: STATE,
            keys: {
                KeyQ: 'hold',
            },
            pointerButtons: {
                0: 'hold',
            },
            onPointer: (event) => POINTER_EVENTS.push(event),
            onRelease: (event) => RELEASES.push(event.reason),
        });
        const RECT = CANVAS.getBoundingClientRect();
        const DISPATCH = (type, id, buttons) =>
            CANVAS.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: id,
                    pointerType: 'touch',
                    button: 0,
                    buttons,
                    clientX: RECT.left + 16,
                    clientY: RECT.top + 32,
                }),
            );
        DISPATCH('pointerdown', 101, 1);
        DISPATCH('pointerdown', 102, 1);
        const POSITION = {};
        CHECK(
            INPUT.samplePointerInto(101, POSITION) &&
                POSITION.x === 16 &&
                POSITION.y === 32 &&
                POSITION.u === 0.25 &&
                POSITION.v === 0.5,
            'CSS coordinates ignore backing DPR',
        );
        STATE.consume();
        DISPATCH('pointercancel', 101, 0);
        CHECK(STATE.sample('hold').held && !STATE.sample('hold').released, 'second touch still holds action');
        CANVAS.dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyQ',
                bubbles: true,
            }),
        );
        DISPATCH('lostpointercapture', 102, 0);
        CHECK(STATE.sample('hold').held, 'keyboard source survives pointer cancel');
        window.dispatchEvent(new Event('blur'));
        CHECK(!STATE.sample('hold').held && STATE.sample('hold').released, 'blur releases remaining source');
        CHECK(
            POINTER_EVENTS.map((event) => `${event.type}:${event.pointerId}`).join(',') ===
                'down:101,down:102,cancel:101,cancel:102',
            'callback identity and cancellation order',
        );
        CHECK(
            POINTER_EVENTS[0].originalEvent instanceof PointerEvent && POINTER_EVENTS[0].u === 0.25,
            'callback original DOM event and CSS sample',
        );
        CHECK(RELEASES.includes('blur'), 'callback blur reason');
        STATE.consume();
        INPUT.dispose();
        INPUT.dispose();
        DISPATCH('pointerdown', 103, 1);
        CHECK(POINTER_EVENTS.length === 4, 'dispose removes pointer callbacks');
        CANVAS.dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyQ',
                bubbles: true,
            }),
        );
        CHECK(!STATE.sample('hold').held && !STATE.sample('hold').pressed, 'dispose removes listeners');
        return {
            coordinates: POSITION,
            multisource: true,
            pointerCancel: true,
            captureLoss: true,
            disposal: true,
            ownedCallbacks: true,
            eventScope:
                'Real DOM dispatch for deterministic multi-pointer cancellation; trusted touchscreen tap tested above.',
        };
    });
    REPORT.stages.push(
        'DOM multi-pointer identity/coordinates/cancel/capture loss + keyboard aggregation + listener disposal',
    );
    const MODULE_ERRORS = [];
    for (const [NAME, CHECK] of [
        ['renderObject', runRenderObjectChecks],
        ['presentation', runPresentationChecks],
        ['device', exerciseWebGLDevice],
        ['vectorRenderer', exerciseVectorRenderer],
        ['frameMetrics', exerciseFrameMetrics],
        ['workScheduler', exerciseBudgetedScheduler],
        ['reusableMeshes', (p) => exerciseReusableMeshes(p)],
        ['fontAssets', (p) => exerciseFontAssetLoader(p, `http://127.0.0.1:${SERVER.address().port}`)],
    ]) {
        try {
            REPORT[NAME] = await CHECK(PAGE);
        } catch (error) {
            console.error(`Browser module ${NAME}:`, error);
            MODULE_ERRORS.push(`${NAME}: ${error.message}`);
        }
    }
    assert.equal(
        sharedFontRequests,
        1,
        'concurrent devices and loaders share one fetch and CPU decode in this JavaScript realm',
    );
    const DISPOSAL = await PAGE.evaluate(() => {
        const { device: DEVICE, context: CONTEXT } = renderProbe;
        CONTEXT.dispose();
        CONTEXT.dispose();
        DEVICE.dispose();
        DEVICE.dispose();
        const RESULT = {
            contextState: CONTEXT.state,
            deviceState: DEVICE.state,
            buffers: DEVICE.buffers.size,
            textures: DEVICE.textures.size,
            pipelines: DEVICE.pipelines.size,
        };
        demo.dispose();
        return RESULT;
    });
    assert.deepEqual(DISPOSAL, {
        contextState: 'disposed',
        deviceState: 'disposed',
        buffers: 0,
        textures: 0,
        pipelines: 0,
    });
    assert.equal(ERRORS.length, 0, ERRORS.join('\n'));
    assert.equal(MODULE_ERRORS.length, 0, MODULE_ERRORS.join('\n'));
    assert.deepEqual(
        REPORT.reusableMeshes?.scenes.map(({ backend, legacyExtensionMasked, legacyExtensionQueries, antialias }) => [
            backend,
            legacyExtensionMasked,
            legacyExtensionQueries,
            antialias,
        ]),
        [
            ['webgl2-core-instanced-mesh', false, 0, false],
            ['webgl2-core-instanced-mesh', true, 0, false],
            ['webgl2-core-instanced-mesh', false, 0, true],
            ['webgl2-core-instanced-mesh', true, 0, true],
        ],
        'reusable mesh helper must exercise core instancing with and without legacy ANGLE availability and MSAA',
    );
    REPORT.stages.push(
        'retained animated mesh → silhouette/instance batching → vector painter order → nested/rotated clipping → native context restoration/disposal, WebGL2 core instancing with legacy extension masked, MSAA off/on',
    );
    const VECTOR_EXAMPLE = await browser.newPage({
            viewport: {
                width: 1000,
                height: 700,
            },
        }),
        EXAMPLE_ERRORS = [];
    VECTOR_EXAMPLE.on('pageerror', (error) => EXAMPLE_ERRORS.push(error.message));
    await VECTOR_EXAMPLE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/rendering/examples/vector/index.html`);
    await VECTOR_EXAMPLE.waitForFunction(() => document.querySelector('#stats')?.textContent.includes('draw calls'));
    REPORT.vectorExample = await VECTOR_EXAMPLE.evaluate(() => {
        const { device: DEVICE, cpuSubmitMs: CPU_SUBMIT_MS } = window.vectorExample,
            GL = DEVICE.gl,
            PIXEL = new Uint8Array(4);
        GL.readPixels(450, 499 - 200, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, PIXEL);
        return {
            pixels: [...PIXEL],
            stats: {
                ...DEVICE.stats,
            },
            cpuSubmitMs: CPU_SUBMIT_MS,
            text: document.querySelector('#stats').textContent,
            error: GL.getError(),
        };
    });
    assert.ok(
        REPORT.vectorExample.pixels[0] > 100 && REPORT.vectorExample.pixels[0] > REPORT.vectorExample.pixels[1] * 3,
        'native example has group-composited red pixels',
    );
    assert.equal(REPORT.vectorExample.error, 0);
    assert.ok(REPORT.vectorExample.stats.gpuRenderTargetBytes > 0);
    assert.equal(EXAMPLE_ERRORS.length, 0, EXAMPLE_ERRORS.join('\n'));
    await VECTOR_EXAMPLE.close();
    REPORT.stages.push('native vector/text/group-opacity example draws WebGL pixels');
    REPORT.textureArrayExample = [];
    for (const [NAME, OPTIONS] of [
        ['desktop', { viewport: { width: 1000, height: 700 } }],
        ['touch', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
    ]) {
        const TEXTURE_ARRAY_PAGE = await browser.newPage(OPTIONS),
            TEXTURE_ARRAY_ERRORS = [];
        TEXTURE_ARRAY_PAGE.on('pageerror', (error) => TEXTURE_ARRAY_ERRORS.push(error.message));
        await TEXTURE_ARRAY_PAGE.goto(
            `http://127.0.0.1:${SERVER.address().port}/modules/rendering/examples/texture-array/index.html`,
        );
        await TEXTURE_ARRAY_PAGE.waitForFunction(() => Boolean(window.textureArrayExample));
        const LAYOUT = await TEXTURE_ARRAY_PAGE.evaluate(() => {
            const CANVAS_RECT = document.querySelector('#scene').getBoundingClientRect();
            return {
                horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
                canvasBottom: CANVAS_RECT.bottom,
                viewportHeight: window.innerHeight,
                buttonHeights: [...document.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height),
            };
        });
        assert.ok(LAYOUT.horizontalOverflow <= 0, `${NAME}: no horizontal scroll`);
        assert.ok(LAYOUT.canvasBottom <= LAYOUT.viewportHeight, `${NAME}: canvas inside the first screen`);
        assert.ok(
            LAYOUT.buttonHeights.every((height) => height >= 56),
            `${NAME}: buttons are at least 56px tall`,
        );
        const ARRAY_RESULT = await TEXTURE_ARRAY_PAGE.evaluate(() => ({
            drawCalls: window.textureArrayExample.drawCalls,
            pixels: [...window.textureArrayExample.readPixels()],
        }));
        if (NAME === 'touch') {
            await TEXTURE_ARRAY_PAGE.tap('#mode-mixed');
        } else {
            await TEXTURE_ARRAY_PAGE.click('#mode-mixed');
        }
        const MIXED_RESULT = await TEXTURE_ARRAY_PAGE.evaluate(() => ({
            mode: window.textureArrayExample.mode,
            drawCalls: window.textureArrayExample.drawCalls,
            pixels: [...window.textureArrayExample.readPixels()],
            glError: window.textureArrayExample.device.gl.getError(),
        }));
        assert.equal(MIXED_RESULT.mode, 'mixed', `${NAME}: mode button switches`);
        assert.equal(ARRAY_RESULT.drawCalls, 1, `${NAME}: 240 sprites from 4 atlas regions in one draw call`);
        assert.equal(MIXED_RESULT.drawCalls, 1, `${NAME}: 240 interleaved rectangles keep the single draw call`);
        assert.equal(MIXED_RESULT.glError, 0);
        assert.notDeepEqual(ARRAY_RESULT.pixels, MIXED_RESULT.pixels, `${NAME}: interleaved rectangles are visible`);
        assert.equal(TEXTURE_ARRAY_ERRORS.length, 0, TEXTURE_ARRAY_ERRORS.join('\n'));
        REPORT.textureArrayExample.push({
            name: NAME,
            arrayDrawCalls: ARRAY_RESULT.drawCalls,
            mixedDrawCalls: MIXED_RESULT.drawCalls,
        });
        await TEXTURE_ARRAY_PAGE.close();
    }
    REPORT.stages.push(
        'texture-array example: sprites from several atlas regions plus interleaved rectangles in 1 draw call, desktop and touch emulation (not real-device verification)',
    );
    const PREVIEW_PAGE = await browser.newPage({
            viewport: {
                width: 900,
                height: 620,
            },
            deviceScaleFactor: 1,
        }),
        PREVIEW_ERRORS = [];
    PREVIEW_PAGE.on('pageerror', (error) => {
        PREVIEW_ERRORS.push(error.message);
        console.error('Input preview scenario:', error.stack);
    });
    await PREVIEW_PAGE.goto(
        `http://127.0.0.1:${SERVER.address().port}/modules/simloop/examples/input-preview/index.html`,
    );
    await PREVIEW_PAGE.waitForFunction(() => window.inputPreviewDemo?.diagnostics.frames > 10);
    await PREVIEW_PAGE.locator('canvas').focus();
    const NEXT_BOUNDARY = await PREVIEW_PAGE.evaluate(() => inputPreviewDemo.diagnostics.authorityTick);
    await PREVIEW_PAGE.waitForFunction((t) => inputPreviewDemo.diagnostics.authorityTick > t, NEXT_BOUNDARY, {
        timeout: 1500,
        polling: 'raf',
    });
    const BEFORE_PREVIEW = await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics);
    await PREVIEW_PAGE.evaluate(() => {
        window.inputEventAt = performance.now();
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyD',
                bubbles: true,
            }),
        );
        return window.inputEventAt;
    });
    await PREVIEW_PAGE.waitForFunction(
        (x) => window.inputPreviewDemo.diagnostics.displayedX > x + 0.5,
        BEFORE_PREVIEW.displayedX,
        {
            timeout: 1500,
            polling: 'raf',
        },
    );
    const FIRST_RESPONSE = await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics);
    const INPUT_TO_DISPLAY_MS = await PREVIEW_PAGE.evaluate(() => performance.now() - window.inputEventAt);
    assert.ok(
        FIRST_RESPONSE.authorityX < BEFORE_PREVIEW.authorityX + 8,
        'preview responds before delayed authority confirmation',
    );
    assert.equal(
        FIRST_RESPONSE.authorityTick,
        BEFORE_PREVIEW.authorityTick,
        'input changes display before authority tick',
    );
    assert.equal(
        FIRST_RESPONSE.authorityHash,
        BEFORE_PREVIEW.authorityHash,
        'observing input leaves actual authority bytes/hash unchanged',
    );
    const SMOOTH_HOLD = await PREVIEW_PAGE.evaluate(async () => {
        const POSITIONS = [];
        for (let i = 0; i < 4; i++) {
            await new Promise(requestAnimationFrame);
            POSITIONS.push(inputPreviewDemo.diagnostics.displayedX);
        }
        return POSITIONS;
    });
    assert.ok(
        new Set(SMOOTH_HOLD.map((x) => x.toFixed(3))).size > 1,
        'cached future schema sample moves BETWEEN authority ticks',
    );
    assert.ok(
        SMOOTH_HOLD.slice(1).every((x, i) => Math.abs(x - SMOOTH_HOLD[i]) < 20),
        'preview does not jump a whole simulation step per RAF',
    );
    assert.equal(FIRST_RESPONSE.remoteX, 575, 'remote authoritative identity is not replaced by local prediction');
    assert.ok(
        INPUT_TO_DISPLAY_MS < 400,
        `local response did not reach its first sampled render within 400ms: ${INPUT_TO_DISPLAY_MS}ms`,
    );
    const RENDERED_PREVIEW_PIXEL = await PREVIEW_PAGE.evaluate(() => {
        const { renderer: RENDERER } = window.inputPreviewDemo,
            GL = RENDERER.device.gl,
            PIXELS = new Uint8Array(RENDERER.canvas.width * RENDERER.canvas.height * 4);
        GL.readPixels(0, 0, RENDERER.canvas.width, RENDERER.canvas.height, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
        let green = 0;
        for (let i = 0; i < PIXELS.length; i += 4) {
            if (PIXELS[i + 1] > 180 && PIXELS[i] < 90 && PIXELS[i + 2] > 70) {
                green++;
            }
        }
        return {
            greenPixels: green,
            error: GL.getError(),
        };
    });
    assert.ok(
        RENDERED_PREVIEW_PIXEL.greenPixels > 20,
        'selected local fork is rendered from its schema model in WebGL',
    );
    assert.equal(RENDERED_PREVIEW_PIXEL.error, 0);
    const RESTORE_COUNT_BEFORE_STEADY_HOLD = FIRST_RESPONSE.forkRestores,
        CONTINUED_BEFORE_STEADY_HOLD = FIRST_RESPONSE.metrics.continuedCheckpoints;
    await PREVIEW_PAGE.waitForFunction(
        (t) => inputPreviewDemo.diagnostics.authorityTick >= t + 6,
        FIRST_RESPONSE.authorityTick,
        {
            timeout: 2500,
            polling: 'raf',
        },
    );
    const STEADY_HOLD = await PREVIEW_PAGE.evaluate(() => inputPreviewDemo.diagnostics);
    assert.ok(
        STEADY_HOLD.metrics.continuedCheckpoints >= CONTINUED_BEFORE_STEADY_HOLD + 4,
        'matching confirmed ticks continue the existing prediction fork',
    );
    assert.ok(
        STEADY_HOLD.forkRestores <= RESTORE_COUNT_BEFORE_STEADY_HOLD + 2,
        'steady held input does not reinstall the full preview snapshot each authority tick',
    );
    await PREVIEW_PAGE.evaluate(() => inputPreviewDemo.clockGap());
    await PREVIEW_PAGE.waitForFunction(
        (t) => inputPreviewDemo.diagnostics.authorityTick >= t + 2,
        STEADY_HOLD.authorityTick,
        {
            timeout: 1500,
            polling: 'raf',
        },
    );
    const AFTER_CLOCK_GAP = await PREVIEW_PAGE.evaluate(() => inputPreviewDemo.diagnostics);
    assert.ok(
        AFTER_CLOCK_GAP.metrics.clockGaps > STEADY_HOLD.metrics.clockGaps,
        'clock gap clears the stale rendered sample',
    );
    assert.ok(
        AFTER_CLOCK_GAP.metrics.continuedCheckpoints > STEADY_HOLD.metrics.continuedCheckpoints,
        'exact current input continues the same fork after an active clock gap',
    );
    assert.ok(
        AFTER_CLOCK_GAP.forkRestores <= STEADY_HOLD.forkRestores + 1,
        'valid clock-gap continuation avoids full snapshot reinstall',
    );
    await PREVIEW_PAGE.evaluate(() =>
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keyup', {
                code: 'KeyD',
                bubbles: true,
            }),
        ),
    );
    await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics.displayedX);
    await PREVIEW_PAGE.keyboard.press('Space');
    await PREVIEW_PAGE.waitForFunction(() => inputPreviewDemo.diagnostics.displayFlash > 0.1, undefined, {
        timeout: 1500,
        polling: 'raf',
    });
    await PREVIEW_PAGE.waitForFunction(
        () => window.inputPreviewDemo.diagnostics.confirmedCommandSequence > 0,
        undefined,
        {
            timeout: 2000,
            polling: 'raf',
        },
    );
    const CAPTURE_METADATA = await PREVIEW_PAGE.evaluate(() => inputPreviewDemo.session.localInputState);
    assert.equal(
        CAPTURE_METADATA.capture.executeTick - CAPTURE_METADATA.capture.captureTick,
        2,
        'actual SDK input delay is retained in execution metadata',
    );
    assert.equal(
        CAPTURE_METADATA.commandSequence,
        CAPTURE_METADATA.executedCommandSequence,
        'observed roll binds once and is confirmed at actual execution',
    );
    assert.equal(
        PREVIEW_ERRORS.length,
        0,
        'detached fork tick/command guards reject compressed gaps or changed execution T',
    );
    const BEFORE_DIRECTION_SWITCH = await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics.displayedX);
    await PREVIEW_PAGE.evaluate(() =>
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyA',
                bubbles: true,
            }),
        ),
    );
    await PREVIEW_PAGE.waitForFunction(
        (x) => window.inputPreviewDemo.diagnostics.displayedX < x - 0.5,
        BEFORE_DIRECTION_SWITCH,
        {
            timeout: 1000,
            polling: 'raf',
        },
    );
    await PREVIEW_PAGE.evaluate(() =>
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keyup', {
                code: 'KeyA',
                bubbles: true,
            }),
        ),
    );
    const ROLL_COUNT_BEFORE = await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics.lastConfirm);
    await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.forceCollision());
    await PREVIEW_PAGE.waitForFunction(() => window.inputPreviewDemo.diagnostics.displayedX > 650, {
        timeout: 1500,
    });
    await PREVIEW_PAGE.waitForFunction(
        () =>
            Math.abs(window.inputPreviewDemo.diagnostics.displayedX - window.inputPreviewDemo.diagnostics.authorityX) <
            2,
        {
            timeout: 1500,
        },
    );
    await PREVIEW_PAGE.locator('#preview').uncheck();
    await PREVIEW_PAGE.locator('canvas').focus();
    const OFF_AUTHORITY_BEFORE = await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics.authorityX);
    await PREVIEW_PAGE.evaluate(() =>
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyA',
                bubbles: true,
            }),
        ),
    );
    await PREVIEW_PAGE.waitForFunction(
        (x) => window.inputPreviewDemo.diagnostics.authorityX < x - 0.5,
        OFF_AUTHORITY_BEFORE,
        {
            timeout: 1500,
            polling: 'raf',
        },
    );
    assert.equal(
        await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.preview.pendingCount),
        0,
        'preview OFF retains authoritative-only route',
    );
    await PREVIEW_PAGE.evaluate(() =>
        document.querySelector('canvas').dispatchEvent(
            new KeyboardEvent('keyup', {
                code: 'KeyA',
                bubbles: true,
            }),
        ),
    );
    await PREVIEW_PAGE.locator('#preview').check();
    await PREVIEW_PAGE.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(
        await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.diagnostics.pending),
        0,
        'blur clears speculative inputs',
    );
    await PREVIEW_PAGE.locator('#gap').click();
    await PREVIEW_PAGE.locator('#restart').click();
    await PREVIEW_PAGE.waitForFunction(
        () => Math.abs(window.inputPreviewDemo.diagnostics.displayedX - 80) < 2,
        undefined,
        {
            timeout: 1000,
            polling: 'raf',
        },
    );
    REPORT.inputPreview = await PREVIEW_PAGE.evaluate(() => ({
        diagnostics: window.inputPreviewDemo.diagnostics,
        glError: window.inputPreviewDemo.renderer.device.gl.getError(),
    }));
    assert.equal(REPORT.inputPreview.glError, 0);
    assert.equal(PREVIEW_ERRORS.length, 0, PREVIEW_ERRORS.join('\n'));
    REPORT.inputPreview.inputToFirstDisplayMs = INPUT_TO_DISPLAY_MS;
    REPORT.inputPreview.webglPixel = RENDERED_PREVIEW_PIXEL;
    REPORT.inputPreview.lastConfirmBeforeCollision = ROLL_COUNT_BEFORE;
    REPORT.inputPreview.preTick = {
        tick: BEFORE_PREVIEW.authorityTick,
        hash: BEFORE_PREVIEW.authorityHash,
        smoothHold: SMOOTH_HOLD,
    };
    REPORT.inputPreview.capture = {
        captureTick: CAPTURE_METADATA.capture.captureTick,
        executeTick: CAPTURE_METADATA.capture.executeTick,
        commandSequence: CAPTURE_METADATA.commandSequence,
    };
    REPORT.stages.push(
        'detached same-update input fork → first sampled schema render → delayed authority correction → collision/roll/press-release/direction/off/blur/gap/restart',
    );
    await PREVIEW_PAGE.evaluate(() => window.inputPreviewDemo.dispose());
    REPORT.manualOwnerRelease = await PREVIEW_PAGE.evaluate(async () => {
        const { createLoop: CREATE_LOOP, LocalInputPreview: LOCAL_INPUT_PREVIEW } = await import('/dist/simloop.js');
        const { createSession: CREATE_SESSION, profiles: PROFILES } = await import('/dist/rollback.js');
        const { ActionState: ACTION_STATE, createDOMInput: CREATE_DOM_INPUT } = await import('/dist/input.js');
        const STATE = {
                x: 0,
                tick: 0,
                edges: 0,
            },
            UPDATE = (world, input, commands = []) => {
                world.x += input[0];
                world.edges += commands.length;
                world.tick++;
            };
        let forkRestores = 0;
        let confirmedReplaySteps = 0;
        const CONFIRMED_ADVANCE_RESULTS = [];
        const CONFIRMED_ADVANCE_RESTORE_DELTAS = [];
        const ADAPTER = {
            save: () => Uint8Array.of(STATE.x, STATE.tick, STATE.edges),
            load: (bytes) => {
                STATE.x = bytes[0];
                STATE.tick = bytes[1];
                STATE.edges = bytes[2];
            },
            validateSnapshot: (bytes) => bytes.length === 3,
            step: (frame) => UPDATE(STATE, frame.inputs[0].input, frame.inputs[0].commands),
        };
        const SESSION = CREATE_SESSION({
            players: ['local'],
            localPlayerId: 'local',
            sessionId: 'manual-blur',
            simulationVersion: 'manual-v1',
            seed: 1,
            inputSize: 1,
            adapter: ADAPTER,
            profile: {
                ...PROFILES.lockstep,
                tickRate: 10,
                maxCatchupSteps: 1,
                baseInputDelayTicks: 0,
                minInputDelayTicks: 0,
                maxInputDelayTicks: 0,
                adaptiveInputDelay: false,
                pacingPolicy: 'none',
            },
        });
        const ACTIONS = new ACTION_STATE(),
            CANVAS = document.querySelector('canvas'),
            INPUT = CREATE_DOM_INPUT({
                target: CANVAS,
                state: ACTIONS,
                keys: {
                    KeyQ: 'hold',
                    KeyE: 'tap',
                },
            });
        const PREVIEW = new LOCAL_INPUT_PREVIEW({
            maxAgeMs: 1000,
            createFork: (bytes) => {
                const FORK = {
                    x: bytes[0],
                    tick: bytes[1],
                    edges: bytes[2],
                };
                return {
                    restore(snapshot) {
                        FORK.x = snapshot[0];
                        FORK.tick = snapshot[1];
                        FORK.edges = snapshot[2];
                        forkRestores++;
                    },
                    step: (input, context) => {
                        if (context.confirmedReplay) {
                            confirmedReplaySteps++;
                        }
                        UPDATE(FORK, input, context.commands);
                    },
                };
            },
            readEntities: () => [],
        });
        // Integer fixture times keep exact 100ms deadlines free of floating subtraction jitter.
        const NOW = Math.ceil(performance.now()),
            CONTINUATION_KEY = 'manual-blur';
        PREVIEW.reconcile({
            snapshot: ADAPTER.save(),
            input: Uint8Array.of(0),
            revision: 0,
            tick: 0,
            epoch: 0,
            continuationKey: CONTINUATION_KEY,
            confirmedCommandSequence: 0,
            timeMs: NOW,
            mode: 'reset',
        });
        let previewCheckpointTime = NOW;
        let observations = 0;
        let lifecycleBoundary = null;
        const LIFECYCLE_REBASES = [];
        const LOOP = CREATE_LOOP({
            session: SESSION,
            inputPreview: PREVIEW,
            getInput() {
                observations++;
                const HELD = ACTIONS.sample('hold').held,
                    EDGE = ACTIONS.sample('tap').pressed;
                ACTIONS.consume();
                return {
                    input: Uint8Array.of(HELD ? 1 : 0),
                    commands: EDGE
                        ? [
                              {
                                  payload: Uint8Array.of(7),
                              },
                          ]
                        : [],
                    predict: HELD || EDGE,
                    continuationKey: CONTINUATION_KEY,
                };
            },
            onAdvance(result, submission) {
                if (result.status !== 'advanced') {
                    return;
                }
                const METADATA = SESSION.localInputState,
                    CHECKPOINT = {
                        input: METADATA.replayInput ?? METADATA.executedInput ?? Uint8Array.of(0),
                        revision: 0,
                        tick: SESSION.tick,
                        epoch: METADATA.epoch ?? 0,
                        continuationKey: CONTINUATION_KEY,
                        confirmedCommandSequence: METADATA.executedCommandSequence ?? 0,
                        timeMs: (previewCheckpointTime = Math.max(
                            previewCheckpointTime + 1,
                            submission?.timeMs ?? performance.now(),
                        )),
                    };
                if (lifecycleBoundary) {
                    if (PREVIEW.continueFromCheckpoint(CHECKPOINT)) {
                        throw Error('cleared lifecycle fork unexpectedly continued');
                    }
                    PREVIEW.reconcile({
                        ...CHECKPOINT,
                        snapshot: ADAPTER.save(),
                        mode: 'reset',
                    });
                    LIFECYCLE_REBASES.push(lifecycleBoundary);
                    lifecycleBoundary = null;
                } else if (submission?.predict) {
                    if (!PREVIEW.continueFromCheckpoint(CHECKPOINT)) {
                        throw Error('predicted confirmation did not continue its exact fork');
                    }
                } else {
                    const RESTORES = forkRestores;
                    if (PREVIEW.advanceConfirmedCheckpoint(CHECKPOINT)) {
                        CONFIRMED_ADVANCE_RESULTS.push(CHECKPOINT.tick);
                        CONFIRMED_ADVANCE_RESTORE_DELTAS.push(forkRestores - RESTORES);
                        if (
                            PREVIEW.advanceConfirmedCheckpoint({
                                ...CHECKPOINT,
                                tick: CHECKPOINT.tick + 1,
                                timeMs: CHECKPOINT.timeMs + 1,
                            })
                        ) {
                            throw Error('confirmed-only continuation exceeded its one-step bound');
                        }
                    }
                }
            },
        });
        const RELEASE = () => LOOP.releaseInput();
        window.addEventListener('blur', RELEASE);
        try {
            LOOP.pulse(NOW);
            CANVAS.dispatchEvent(
                new KeyboardEvent('keydown', {
                    code: 'KeyQ',
                    bubbles: true,
                }),
            );
            CANVAS.dispatchEvent(
                new KeyboardEvent('keydown', {
                    code: 'KeyE',
                    bubbles: true,
                }),
            );
            CANVAS.dispatchEvent(
                new KeyboardEvent('keyup', {
                    code: 'KeyE',
                    bubbles: true,
                }),
            );
            if (STATE.x !== 0) {
                throw Error('DOM input advanced authority');
            }
            LOOP.pulse(NOW + 100);
            const DEADLINE_HELD_X = STATE.x;
            if (DEADLINE_HELD_X !== 1 || STATE.edges !== 1 || observations !== 2) {
                throw Error('deadline failed to refresh held/quick edge without RAF');
            }
            LOOP.pulse(NOW + 100);
            if (observations !== 2) {
                throw Error('same timestamp observed twice');
            }
            CANVAS.dispatchEvent(
                new KeyboardEvent('keyup', {
                    code: 'KeyQ',
                    bubbles: true,
                }),
            );
            LOOP.observeInput(NOW + 150);
            LOOP.pulse(NOW + 150);
            LOOP.pulse(NOW + 200);
            if (observations !== 3 || STATE.x !== 1) {
                throw Error('recent RAF observation was not reused by deadline');
            }
            CANVAS.dispatchEvent(
                new KeyboardEvent('keydown', {
                    code: 'KeyQ',
                    bubbles: true,
                }),
            );
            LOOP.pulse(NOW + 300);
            const HELD_X = STATE.x;
            if (HELD_X !== 2) {
                throw Error('later held change stayed stale without RAF');
            }
            const CONFIRMED_STATE = {
                confirmedAdvances: PREVIEW.metrics.confirmedAdvances,
                confirmedAdvanceRejected: PREVIEW.metrics.confirmedAdvanceRejected,
                confirmedAdvanceRejectedLimit: PREVIEW.metrics.confirmedAdvanceRejectedLimit,
                confirmedAdvanceResults: [...CONFIRMED_ADVANCE_RESULTS],
                confirmedAdvanceRestoreDeltas: [...CONFIRMED_ADVANCE_RESTORE_DELTAS],
                confirmedReplaySteps,
                forkRestores,
            };
            lifecycleBoundary = 'blur';
            window.dispatchEvent(new Event('blur'));
            LOOP.pulse(NOW + 400);
            LOOP.pulse(NOW + 500);
            if (
                STATE.x !== HELD_X ||
                SESSION.localInputState.capture.input[0] !== 0 ||
                SESSION.localInputState.executedInput[0] !== 0
            ) {
                throw Error('manual owner retained stale held cache after the reserved release frame');
            }
            if (
                STATE.edges !== 1 ||
                SESSION.localInputState.commandSequence !== 1 ||
                SESSION.localInputState.executedCommandSequence !== 1
            ) {
                throw Error('deadline refresh duplicated or lost edge command');
            }
            const RETAINED_EDGES = [];
            for (const [INDEX, BOUNDARY] of ['blur', 'resetTiming', 'stop'].entries()) {
                const AT = NOW + 550 + INDEX * 400,
                    PREVIOUS_EDGES = STATE.edges;
                CANVAS.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        code: 'KeyE',
                        bubbles: true,
                    }),
                );
                CANVAS.dispatchEvent(
                    new KeyboardEvent('keyup', {
                        code: 'KeyE',
                        bubbles: true,
                    }),
                );
                LOOP.observeInput(AT);
                lifecycleBoundary = BOUNDARY;
                if (BOUNDARY === 'blur') {
                    window.dispatchEvent(new Event('blur'));
                } else {
                    LOOP[BOUNDARY]();
                }
                LOOP.pulse(AT + 50);
                LOOP.pulse(AT + 150);
                LOOP.pulse(AT + 250);
                if (
                    STATE.edges !== PREVIOUS_EDGES + 1 ||
                    SESSION.localInputState.executedCommandSequence !== STATE.edges
                ) {
                    throw Error(BOUNDARY + ' lost or duplicated an observed edge before tick consumption');
                }
                if (STATE.x !== HELD_X) {
                    throw Error(BOUNDARY + ' restored stale held input');
                }
                RETAINED_EDGES.push(BOUNDARY);
            }
            return {
                deadlineHeldX: DEADLINE_HELD_X,
                heldX: HELD_X,
                afterBlurX: STATE.x,
                edges: STATE.edges,
                retainedEdges: RETAINED_EDGES,
                lifecycleRebases: LIFECYCLE_REBASES,
                observationReads: observations,
                neutral: SESSION.localInputState.capture.input[0],
                automaticRafStarted: LOOP.running,
                ...CONFIRMED_STATE,
            };
        } finally {
            window.removeEventListener('blur', RELEASE);
            LOOP.stop();
            PREVIEW.dispose();
            SESSION.close();
            INPUT.dispose();
        }
    });
    assert.equal(REPORT.manualOwnerRelease.automaticRafStarted, false);
    assert.deepEqual(
        REPORT.manualOwnerRelease.lifecycleRebases,
        ['blur', 'blur', 'resetTiming', 'stop'],
        'each lifecycle clear rejects continuation and installs a fresh authority checkpoint',
    );
    assert.equal(
        REPORT.manualOwnerRelease.confirmedAdvances,
        1,
        'one exact idle frame advances the detached local fork without a checkpoint restore',
    );
    assert.equal(
        REPORT.manualOwnerRelease.confirmedReplaySteps,
        1,
        'confirmed-only continuation still executes the same detached game step',
    );
    assert.ok(
        REPORT.manualOwnerRelease.confirmedAdvanceRejected >= 1,
        'a second speculative confirmed-only step is rejected until another prediction or snapshot rebase',
    );
    assert.ok(
        REPORT.manualOwnerRelease.confirmedAdvanceRejectedLimit >= 1,
        'the confirmed-only horizon rejects a second consecutive step',
    );
    assert.deepEqual(
        REPORT.manualOwnerRelease.confirmedAdvanceRestoreDeltas,
        [0],
        'the bounded confirmed-only step avoids reinstalling the full snapshot',
    );
    REPORT.stages.push(
        'manual deadline refreshes held/quick edges without RAF, reuses observations, stays neutral and retains one edge across blur/resetTiming/stop until tick consumption',
    );
    await PREVIEW_PAGE.evaluate(() => {
        window.inputPreviewDemo.dispose();
        window.dispatchEvent(
            new PageTransitionEvent('pagehide', {
                persisted: false,
            }),
        );
    });
    assert.equal(PREVIEW_ERRORS.length, 0, PREVIEW_ERRORS.join('\n'));
    await PREVIEW_PAGE.close();
    assert.equal(PREVIEW_ERRORS.length, 0, PREVIEW_ERRORS.join('\n'));
    REPORT.stages.push(
        'explicit disposal, repeated disposal and pagehide release the demo once without lifecycle errors',
    );
    const VECTOR_ASSET_PAGE = await browser.newPage({
        viewport: {
            width: 1000,
            height: 800,
        },
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    const VECTOR_ASSET_ERRORS = [];
    VECTOR_ASSET_PAGE.on('pageerror', (error) => VECTOR_ASSET_ERRORS.push(error.message));
    await VECTOR_ASSET_PAGE.goto(
        `http://127.0.0.1:${SERVER.address().port}/dist/previews/vector-assets.html?fixture=seed-scout`,
    );
    await VECTOR_ASSET_PAGE.waitForFunction(
        () => Boolean(window.vectorAssetDemo?.ready || window.vectorAssetDemo?.error),
        null,
        {
            timeout: 15000,
        },
    );
    assert.equal(
        await VECTOR_ASSET_PAGE.evaluate(() => window.vectorAssetDemo?.error ?? null),
        null,
        'standalone vector-assets preview initializes',
    );
    REPORT.vectorAssets = await exerciseVectorAssets(VECTOR_ASSET_PAGE);
    const SKETCH_PIXEL_PARITY = await VECTOR_ASSET_PAGE.evaluate(() => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorContext: VECTOR_CONTEXT,
            createStyleSample: CREATE_STYLE_SAMPLE,
        } = window.vectorAssetRuntime;
        const CANVAS = document.createElement('canvas');
        CANVAS.width = 320;
        CANVAS.height = 360;
        document.body.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const CONTEXT = new VECTOR_CONTEXT(DEVICE),
            ACTOR = CREATE_STYLE_SAMPLE('sketch-fox', CONTEXT, {
                clip: 'idle',
                startedAtMs: 0,
            }),
            MESHES = CONTEXT.meshRenderer;
        const PROJECTION = [2 / 160, 0, 0, 0, -2 / 180, 0, -1, 1, 1];
        const CAPTURE = (timeMs) => {
            ACTOR.seek(timeMs);
            DEVICE.beginFrame({
                width: CANVAS.width,
                height: CANVAS.height,
                clearColor: [0.875, 0.91, 0.8, 1],
            });
            MESHES.beginFrame();
            ACTOR.draw({
                projection: PROJECTION,
            });
            MESHES.flush();
            DEVICE.endFrame();
            const PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
            DEVICE.gl.readPixels(0, 0, CANVAS.width, CANVAS.height, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        };
        const FIRST = CAPTURE(987.5),
            LATER = CAPTURE(2100),
            REPEATED = CAPTURE(987.5);
        let changedChannels = 0;
        let repeatedChannels = 0;
        for (let index = 0; index < FIRST.length; index++) {
            if (FIRST[index] !== LATER[index]) {
                changedChannels++;
            }
            if (FIRST[index] !== REPEATED[index]) {
                repeatedChannels++;
            }
        }
        const RESULT = {
            changedChannels,
            repeatedChannels,
            glError: DEVICE.gl.getError(),
            morphCount: [...MESHES.meshes][0].morphCount,
        };
        ACTOR.dispose();
        CONTEXT.dispose();
        DEVICE.dispose();
        CANVAS.remove();
        return RESULT;
    });
    assert.equal(SKETCH_PIXEL_PARITY.glError, 0);
    assert.equal(SKETCH_PIXEL_PARITY.morphCount, 2);
    assert.ok(SKETCH_PIXEL_PARITY.changedChannels > 0, 'animated sketch morphs change actual WebGL pixels');
    assert.equal(SKETCH_PIXEL_PARITY.repeatedChannels, 0, 'the same sketch time reproduces identical WebGL pixels');
    assert.equal(VECTOR_ASSET_ERRORS.length, 0, VECTOR_ASSET_ERRORS.join('\n'));
    await VECTOR_ASSET_PAGE.evaluate(() => {
        const DEMO = window.vectorAssetDemo;
        DEMO.actor.dispose();
        DEMO.context.dispose();
        DEMO.device.dispose();
    });
    await VECTOR_ASSET_PAGE.close();
    REPORT.stages.push(
        'single SVG SSOT compiled through pinned Three SVGLoader, rendered as shared retained GameKit WebGL mesh with deterministic Anime.js seek',
    );
    const QUALITY_EXAMPLE_PAGE = await browser.newPage({
        viewport: {
            width: 1200,
            height: 900,
        },
        deviceScaleFactor: 1,
    });
    const QUALITY_EXAMPLE_ERRORS = [];
    QUALITY_EXAMPLE_PAGE.on('pageerror', (error) => QUALITY_EXAMPLE_ERRORS.push(error.message));
    REPORT.vectorAssetQuality = await exerciseVectorAssetQualityExample(
        QUALITY_EXAMPLE_PAGE,
        `http://127.0.0.1:${SERVER.address().port}/dist/previews/vector-assets.html`,
    );
    assert.equal(QUALITY_EXAMPLE_ERRORS.length, 0, QUALITY_EXAMPLE_ERRORS.join('\n'));
    await QUALITY_EXAMPLE_PAGE.close();
    REPORT.stages.push(
        'vector-assets example loads a GitHub SVG URL and compares independently configurable curve/stroke tessellation',
    );
    const SOURCE_PATH = 'modules/vector-assets/assets/seed-scout.svg';
    const SOURCE_BYTES = await readFile(resolve(ROOT, SOURCE_PATH));
    const EXPECTED_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex');
    const NODE_ASSET = compileVectorAsset(SOURCE_BYTES, SOURCE_PATH);
    const LEGACY_NODE_ASSET = compileVectorAsset(SOURCE_BYTES, SOURCE_PATH, {
        curveSegments: 16,
        strokeArcDivisions: 12,
    });
    const STABLE = (value) => {
        if (ArrayBuffer.isView(value)) {
            return Array.from(value, STABLE);
        }
        if (Array.isArray(value)) {
            return value.map(STABLE);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, STABLE(value[key])]),
            );
        }
        return value;
    };
    const NODE_GEOMETRY_SHA256 = createHash('sha256')
        .update(JSON.stringify(STABLE(NODE_ASSET.geometry)))
        .digest('hex');
    const LEGACY_NODE_GEOMETRY_SHA256 = createHash('sha256')
        .update(JSON.stringify(STABLE(LEGACY_NODE_ASSET.geometry)))
        .digest('hex');
    const LOW_QUALITY_EXPECTED = [1, 2, 3].map((value) => {
        const COMPILED = compileVectorAsset(SOURCE_BYTES, SOURCE_PATH, {
            curveSegments: value,
            strokeArcDivisions: value,
        });
        assert.ok(
            COMPILED.geometry.vertices.every(Number.isFinite),
            `${value}/${value} Node geometry contains only finite vertices`,
        );
        return {
            value,
            geometrySha256: createHash('sha256')
                .update(JSON.stringify(STABLE(COMPILED.geometry)))
                .digest('hex'),
        };
    });
    const STARTUP_FETCH_BASELINE = vectorSvgFetches;
    const STARTUP_PAGE = await browser.newPage({
        viewport: {
            width: 1000,
            height: 800,
        },
        deviceScaleFactor: 1,
    });
    const STARTUP_ERRORS = [];
    STARTUP_PAGE.on('pageerror', (error) => STARTUP_ERRORS.push(error.message));
    await STARTUP_PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/interpolation/examples/index.html`);
    const LOADED_STARTUP = await STARTUP_PAGE.evaluate(
        async ({ expectedSha256, nodeGeometrySha256, legacyNodeGeometrySha256, lowQualityExpected, sourcePath }) => {
            const { createVectorAssetLoader: CREATE_VECTOR_ASSET_LOADER, VECTOR_ASSET_QUALITY_PRESETS } =
                await import('/dist/vector-assets-loader.js');
            const { createVectorActor: CREATE_VECTOR_ACTOR } = await import('/dist/vector-assets.js');
            const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import('/dist/rendering.js');
            const URL_LOCAL = '/modules/vector-assets/assets/seed-scout.svg';
            const LOADER = CREATE_VECTOR_ASSET_LOADER({
                maxEntries: 2,
            });
            const OPTIONS = {
                sourcePath,
                expectedSha256,
                maxBytes: 512 * 1024,
            };
            const [COMPILED_ASSET, SAME_COMPILED_ASSET] = await Promise.all([
                LOADER.load(URL_LOCAL, OPTIONS),
                LOADER.load(URL_LOCAL, OPTIONS),
            ]);
            if (COMPILED_ASSET !== SAME_COMPILED_ASSET || LOADER.size !== 1) {
                throw new Error('Concurrent SVG startup loads did not share the cached compilation');
            }
            const EXPLICIT_DEFAULT_ASSET = await LOADER.load(URL_LOCAL, {
                ...OPTIONS,
                ...VECTOR_ASSET_QUALITY_PRESETS.standard,
            });
            if (EXPLICIT_DEFAULT_ASSET !== COMPILED_ASSET) {
                throw new Error('Explicit standard SVG quality did not normalize to the shared cache key');
            }
            const COARSE_ARC_OPTIONS = {
                ...OPTIONS,
                curveSegments: VECTOR_ASSET_QUALITY_PRESETS.standard.curveSegments,
                strokeArcDivisions: 8,
            };
            const COARSE_ARC_ASSET = await LOADER.load(URL_LOCAL, COARSE_ARC_OPTIONS);
            const SAME_COARSE_ARC_ASSET = await LOADER.load(URL_LOCAL, COARSE_ARC_OPTIONS);
            if (
                COARSE_ARC_ASSET !== SAME_COARSE_ARC_ASSET ||
                COARSE_ARC_ASSET === COMPILED_ASSET ||
                LOADER.size !== 2
            ) {
                throw new Error('Distinct stroke arc quality did not use its own cached compilation');
            }
            if (
                COMPILED_ASSET.compilerOptions.curveSegments !== 4 ||
                COMPILED_ASSET.compilerOptions.strokeArcDivisions !== 2 ||
                COARSE_ARC_ASSET.compilerOptions.strokeArcDivisions !== 8
            ) {
                throw new Error('Browser loader did not record the standard or selected stroke arc quality');
            }
            if (
                JSON.stringify(Array.from(COMPILED_ASSET.geometry.indices)) ===
                JSON.stringify(Array.from(COARSE_ARC_ASSET.geometry.indices))
            ) {
                throw new Error('Non-default round stroke arc quality produced the default triangle list');
            }
            if (COMPILED_ASSET.sourceSha256 !== expectedSha256 || 'sourcePaths' in COMPILED_ASSET) {
                throw new Error('Loaded SVG hash or default debug-data policy is incorrect');
            }
            const CANONICAL = (value) => {
                if (ArrayBuffer.isView(value)) {
                    return Array.from(value, CANONICAL);
                }
                if (Array.isArray(value)) {
                    return value.map(CANONICAL);
                }
                if (value && typeof value === 'object') {
                    return Object.fromEntries(
                        Object.keys(value)
                            .sort()
                            .map((key) => [key, CANONICAL(value[key])]),
                    );
                }
                return value;
            };
            const DIGEST = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(JSON.stringify(CANONICAL(COMPILED_ASSET.geometry))),
                ),
            );
            const BROWSER_GEOMETRY_SHA256 = [...DIGEST].map((value) => value.toString(16).padStart(2, '0')).join('');
            if (BROWSER_GEOMETRY_SHA256 !== nodeGeometrySha256) {
                throw new Error('Browser and Node SVG compiler geometry differ');
            }
            const LEGACY_ASSET = await LOADER.load(URL_LOCAL, {
                ...OPTIONS,
                curveSegments: 16,
                strokeArcDivisions: 12,
            });
            const LEGACY_DIGEST = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(JSON.stringify(CANONICAL(LEGACY_ASSET.geometry))),
                ),
            );
            const LEGACY_GEOMETRY_SHA256 = [...LEGACY_DIGEST]
                .map((value) => value.toString(16).padStart(2, '0'))
                .join('');
            if (LEGACY_GEOMETRY_SHA256 !== legacyNodeGeometrySha256) {
                throw new Error('Explicit 16/12 browser quality differs from the preserved Node geometry');
            }
            const LOW_QUALITY_RESULTS = [];
            let previousQualityAsset = COMPILED_ASSET;
            for (const { value: VALUE, geometrySha256: GEOMETRY_SHA256 } of lowQualityExpected) {
                const QUALITY_OPTIONS = {
                    ...OPTIONS,
                    curveSegments: VALUE,
                    strokeArcDivisions: VALUE,
                };
                const [QUALITY_ASSET, SAME_QUALITY_ASSET] = await Promise.all([
                    LOADER.load(URL_LOCAL, QUALITY_OPTIONS),
                    LOADER.load(URL_LOCAL, QUALITY_OPTIONS),
                ]);
                if (QUALITY_ASSET !== SAME_QUALITY_ASSET || QUALITY_ASSET === previousQualityAsset) {
                    throw new Error(`Low SVG quality ${VALUE}/${VALUE} did not use its own stable cache entry`);
                }
                if (
                    !QUALITY_ASSET.geometry.vertices.every(Number.isFinite) ||
                    QUALITY_ASSET.geometry.indices.length % 3
                ) {
                    throw new Error(`Low SVG quality ${VALUE}/${VALUE} produced invalid triangle buffers`);
                }
                const QUALITY_DIGEST = new Uint8Array(
                    await crypto.subtle.digest(
                        'SHA-256',
                        new TextEncoder().encode(JSON.stringify(CANONICAL(QUALITY_ASSET.geometry))),
                    ),
                );
                const QUALITY_GEOMETRY_SHA256 = [...QUALITY_DIGEST]
                    .map((number) => number.toString(16).padStart(2, '0'))
                    .join('');
                if (QUALITY_GEOMETRY_SHA256 !== GEOMETRY_SHA256) {
                    throw new Error(`Browser and Node geometry differ at low quality ${VALUE}/${VALUE}`);
                }
                LOW_QUALITY_RESULTS.push({
                    value: VALUE,
                    geometrySha256: QUALITY_GEOMETRY_SHA256,
                    triangles: QUALITY_ASSET.geometry.indices.length / 3,
                });
                previousQualityAsset = QUALITY_ASSET;
            }
            const CANVAS = document.createElement('canvas');
            CANVAS.width = 200;
            CANVAS.height = 220;
            document.body.append(CANVAS);
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                alpha: false,
                antialias: false,
                preserveDrawingBuffer: true,
                checkGLErrors: true,
            });
            const CONTEXT = new VECTOR_CONTEXT(DEVICE);
            const ACTOR = CREATE_VECTOR_ACTOR(CONTEXT, COMPILED_ASSET, {
                clip: 'idle',
                startedAtMs: 0,
            });
            const MESHES = CONTEXT.meshRenderer;
            DEVICE.beginFrame({
                width: 200,
                height: 220,
                clearColor: [0.875, 0.91, 0.8, 1],
            });
            MESHES.beginFrame();
            ACTOR.draw({
                projection: [2 / 200, 0, 0, 0, -2 / 220, 0, -1, 1, 1],
            });
            MESHES.flush();
            DEVICE.endFrame();
            const PIXEL = new Uint8Array(4);
            DEVICE.gl.readPixels(100, 107, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXEL);
            if (PIXEL[1] < 100 || DEVICE.gl.getError() !== 0 || DEVICE.stats.drawCalls < 1) {
                throw new Error(`Browser-compiled SVG did not render in WebGL: ${[...PIXEL]}`);
            }
            if (MESHES.stats().geometryUploads !== 0) {
                throw new Error('The retained SVG mesh uploaded geometry during its draw');
            }
            ACTOR.dispose();
            CONTEXT.dispose();
            DEVICE.dispose();
            CANVAS.remove();
            const MISMATCH_LOADER = CREATE_VECTOR_ASSET_LOADER({
                maxEntries: 2,
            });
            let mismatchRejected = false;
            try {
                await MISMATCH_LOADER.load(URL_LOCAL, {
                    sourcePath,
                    expectedSha256: '0'.repeat(64),
                });
            } catch (error) {
                mismatchRejected = /SHA-256 mismatch/.test(error.message);
            }
            if (!mismatchRejected || MISMATCH_LOADER.size !== 0) {
                throw new Error('A hash-mismatched SVG was compiled or cached');
            }
            MISMATCH_LOADER.dispose();
            LOADER.clear();
            LOADER.dispose();
            return {
                geometrySha256: BROWSER_GEOMETRY_SHA256,
                lowQualityResults: LOW_QUALITY_RESULTS,
            };
        },
        {
            expectedSha256: EXPECTED_SHA256,
            nodeGeometrySha256: NODE_GEOMETRY_SHA256,
            legacyNodeGeometrySha256: LEGACY_NODE_GEOMETRY_SHA256,
            lowQualityExpected: LOW_QUALITY_EXPECTED,
            sourcePath: SOURCE_PATH,
        },
    );
    assert.equal(
        LOADED_STARTUP.geometrySha256,
        NODE_GEOMETRY_SHA256,
        'browser and Node compilers emit identical geometry',
    );
    assert.deepEqual(
        LOADED_STARTUP.lowQualityResults.map((item) => item.value),
        [1, 2, 3],
        'browser compiles each requested low quality',
    );
    const STARTUP_FETCHES = vectorSvgFetches - STARTUP_FETCH_BASELINE;
    assert.equal(
        STARTUP_FETCHES,
        7,
        'same-key startup loads share one fetch and each independent quality key, explicit 16/12 override, and hash mismatch fetches once',
    );
    assert.equal(STARTUP_ERRORS.length, 0, STARTUP_ERRORS.join('\n'));
    await STARTUP_PAGE.close();
    REPORT.browserSvgStartup = {
        sourceSha256: EXPECTED_SHA256,
        geometrySha256: LOADED_STARTUP.geometrySha256,
        lowQuality: LOADED_STARTUP.lowQualityResults,
        requests: STARTUP_FETCHES,
        scope: 'same-key promise/cache deduplication, low-quality browser/Node geometry parity, expected-hash rejection before caching, and actual WebGL2 draw of the browser-compiled SVG',
    };
    REPORT.stages.push(
        'browser SVG startup loader verifies source SHA-256, compiles once with bounded cache, and renders the same geometry as Node',
    );
    const CENTERED_SOURCE_PATH = 'modules/vector-assets/tests/centered-viewbox.svg';
    const CENTERED_SOURCE_BYTES = await readFile(resolve(ROOT, CENTERED_SOURCE_PATH));
    const CENTERED_SOURCE_SHA256 = createHash('sha256').update(CENTERED_SOURCE_BYTES).digest('hex');
    const CENTERED_NODE_ASSET = compileVectorAsset(CENTERED_SOURCE_BYTES, CENTERED_SOURCE_PATH, {
        normalizeCenteredViewBox: true,
    });
    const CENTERED_GEOMETRY_SHA256 = createHash('sha256')
        .update(JSON.stringify(STABLE(CENTERED_NODE_ASSET.geometry)))
        .digest('hex');
    const CENTERED_PAGE = await browser.newPage({
        viewport: {
            width: 800,
            height: 600,
        },
        deviceScaleFactor: 1,
    });
    const CENTERED_ERRORS = [];
    CENTERED_PAGE.on('pageerror', (error) => CENTERED_ERRORS.push(error.message));
    await CENTERED_PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/interpolation/examples/index.html`);
    const CENTERED_RESULT = await CENTERED_PAGE.evaluate(
        async ({ sourcePath, sourceSha256, nodeGeometrySha256 }) => {
            const { createVectorAssetLoader: CREATE_VECTOR_ASSET_LOADER } =
                await import('/dist/vector-assets-loader.js');
            const { createVectorActor: CREATE_VECTOR_ACTOR } = await import('/dist/vector-assets.js');
            const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import('/dist/rendering.js');
            const URL_LOCAL = '/modules/vector-assets/tests/centered-viewbox.svg';
            const LOADER = CREATE_VECTOR_ASSET_LOADER({
                maxEntries: 4,
            });
            const SOURCE_RESPONSE = await fetch(URL_LOCAL, {
                cache: 'no-store',
            });
            const ORIGINAL_TEXT = await SOURCE_RESPONSE.text();
            const NORMALIZED_ASSET = await LOADER.load(URL_LOCAL, {
                sourcePath,
                expectedSha256: sourceSha256,
                maxBytes: 512 * 1024,
                normalizeCenteredViewBox: true,
            });
            if (
                NORMALIZED_ASSET.sourceSha256 !== sourceSha256 ||
                JSON.stringify(NORMALIZED_ASSET.viewBox) !== JSON.stringify([-36, -40, 72, 80])
            ) {
                throw new Error('Centered SVG result did not retain the original byte digest and viewBox');
            }
            const CANONICAL = (value) => {
                if (ArrayBuffer.isView(value)) {
                    return Array.from(value, CANONICAL);
                }
                if (Array.isArray(value)) {
                    return value.map(CANONICAL);
                }
                if (value && typeof value === 'object') {
                    return Object.fromEntries(
                        Object.keys(value)
                            .sort()
                            .map((key) => [key, CANONICAL(value[key])]),
                    );
                }
                return value;
            };
            const DIGEST = async (value) => {
                const BYTES = new Uint8Array(
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(CANONICAL(value)))),
                );
                return [...BYTES].map((item) => item.toString(16).padStart(2, '0')).join('');
            };
            if ((await DIGEST(NORMALIZED_ASSET.geometry)) !== nodeGeometrySha256) {
                throw new Error('Centered browser and Node compiler geometry differ');
            }

            // Recreate the previous build-only normalization as a reference, then
            // compare actual WebGL frames including the authored part/pivot/clip data.
            const SVG_DOCUMENT = new DOMParser().parseFromString(ORIGINAL_TEXT, 'image/svg+xml');
            const ROOT = SVG_DOCUMENT.documentElement;
            const VIEW_BOX = ROOT.getAttribute('viewBox')
                .trim()
                .split(/[\s,]+/)
                .map(Number);
            ROOT.setAttribute('width', String(VIEW_BOX[2]));
            ROOT.setAttribute('height', String(VIEW_BOX[3]));
            ROOT.setAttribute('viewBox', `0 0 ${VIEW_BOX[2]} ${VIEW_BOX[3]}`);
            const METADATA_NODE = [...ROOT.children].find(
                (child) => child.localName === 'metadata' && child.id === 'vector-asset',
            );
            const METADATA = JSON.parse(METADATA_NODE.textContent);
            for (const CLIP of Object.values(METADATA.clips ?? {})) {
                for (const FRAME of CLIP.keyframes ?? []) {
                    for (const [PART, POSE] of Object.entries(FRAME.parts ?? {})) {
                        if (
                            POSE &&
                            typeof POSE === 'object' &&
                            !Array.isArray(POSE) &&
                            Object.keys(POSE).length === 0
                        ) {
                            delete FRAME.parts[PART];
                        }
                    }
                }
            }
            METADATA_NODE.textContent = JSON.stringify(METADATA);
            const NORMALIZED_TEXT = new XMLSerializer().serializeToString(SVG_DOCUMENT);
            const NORMALIZED_BYTES = new TextEncoder().encode(NORMALIZED_TEXT);
            const NORMALIZED_DIGEST = new Uint8Array(await crypto.subtle.digest('SHA-256', NORMALIZED_BYTES));
            const NORMALIZED_HASH = [...NORMALIZED_DIGEST].map((item) => item.toString(16).padStart(2, '0')).join('');
            const BLOB_URL = URL.createObjectURL(
                new Blob([NORMALIZED_BYTES], {
                    type: 'image/svg+xml',
                }),
            );
            let referenceAsset;
            try {
                referenceAsset = await LOADER.load(BLOB_URL, {
                    sourcePath,
                    expectedSha256: NORMALIZED_HASH,
                    maxBytes: 512 * 1024,
                });
            } finally {
                URL.revokeObjectURL(BLOB_URL);
            }
            if ((await DIGEST(referenceAsset.geometry)) !== nodeGeometrySha256) {
                throw new Error('Legacy-normalized SVG reference geometry differs');
            }
            if (JSON.stringify(NORMALIZED_ASSET.metadata) !== JSON.stringify(referenceAsset.metadata)) {
                throw new Error('Centered compiler changed parts, pivots, sockets, or non-empty clip poses');
            }
            if (
                JSON.stringify(NORMALIZED_ASSET.metadata.parts.map((part) => part.pivot)) !==
                JSON.stringify([
                    [0, 0],
                    [-12, 2],
                    [-12, -14],
                ])
            ) {
                throw new Error('Centered part pivots were not preserved');
            }
            if (JSON.stringify(NORMALIZED_ASSET.metadata.sockets.grip.point) !== JSON.stringify([-12, -18])) {
                throw new Error('Centered socket coordinates were not preserved');
            }
            const CANVAS = window.document.createElement('canvas');
            CANVAS.width = 200;
            CANVAS.height = 220;
            window.document.body.append(CANVAS);
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                alpha: false,
                antialias: false,
                preserveDrawingBuffer: true,
                checkGLErrors: true,
            });
            const CONTEXT = new VECTOR_CONTEXT(DEVICE);
            const NORMALIZED_ACTOR = CREATE_VECTOR_ACTOR(CONTEXT, NORMALIZED_ASSET, {
                clip: 'test',
                startedAtMs: 0,
            });
            const REFERENCE_ACTOR = CREATE_VECTOR_ACTOR(CONTEXT, referenceAsset, {
                clip: 'test',
                startedAtMs: 0,
            });
            const MESHES = CONTEXT.meshRenderer;
            const PROJECTION = [2 / 72, 0, 0, 0, -2 / 80, 0, 0, 0, 1];
            const CAPTURE = (actor, timeMs) => {
                actor.seek(timeMs);
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.93, 0.95, 0.98, 1],
                });
                MESHES.beginFrame();
                actor.draw({
                    projection: PROJECTION,
                });
                MESHES.flush();
                DEVICE.endFrame();
                const PIXELS = new Uint8Array(200 * 220 * 4);
                DEVICE.gl.readPixels(0, 0, 200, 220, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                return PIXELS;
            };
            const FRAME_HASHES = [];
            let movingPixels = 0;
            let redPixels = 0;
            let greenPixels = 0;
            let bluePixels = 0;
            for (const TIME_MS of [0, 50, 100]) {
                const COMPILED_PIXELS = CAPTURE(NORMALIZED_ACTOR, TIME_MS);
                const LEGACY_PIXELS = CAPTURE(REFERENCE_ACTOR, TIME_MS);
                if (COMPILED_PIXELS.some((channel, index) => channel !== LEGACY_PIXELS[index])) {
                    throw new Error(`Centered SVG WebGL pixels differ from the previous normalizer at ${TIME_MS}ms`);
                }
                FRAME_HASHES.push(await DIGEST(COMPILED_PIXELS));
                for (let index = 0; index < COMPILED_PIXELS.length; index += 4) {
                    const [RED, GREEN, BLUE] = COMPILED_PIXELS.subarray(index, index + 3);
                    if (RED > 150 && GREEN < 100 && BLUE < 100) {
                        redPixels++;
                    }
                    if (GREEN > 80 && GREEN > RED * 1.3 && GREEN > BLUE * 1.3) {
                        greenPixels++;
                    }
                    if (BLUE > 100 && BLUE > RED * 1.3 && BLUE > GREEN * 1.3) {
                        bluePixels++;
                    }
                }
                if (TIME_MS === 100) {
                    const INITIAL = CAPTURE(NORMALIZED_ACTOR, 0);
                    for (let index = 0; index < COMPILED_PIXELS.length; index += 4) {
                        if (
                            COMPILED_PIXELS[index] !== INITIAL[index] ||
                            COMPILED_PIXELS[index + 1] !== INITIAL[index + 1] ||
                            COMPILED_PIXELS[index + 2] !== INITIAL[index + 2] ||
                            COMPILED_PIXELS[index + 3] !== INITIAL[index + 3]
                        ) {
                            movingPixels++;
                        }
                    }
                }
            }
            if (
                FRAME_HASHES[0] === FRAME_HASHES[2] ||
                movingPixels < 20 ||
                redPixels < 500 ||
                greenPixels < 20 ||
                bluePixels < 20
            ) {
                throw new Error(
                    `Centered SVG frame lost geometry or clip motion: ${JSON.stringify({
                        frameHashes: FRAME_HASHES,
                        movingPixels,
                        redPixels,
                        greenPixels,
                        bluePixels,
                    })}`,
                );
            }
            const FINAL_ERROR = DEVICE.gl.getError();
            NORMALIZED_ACTOR.dispose();
            REFERENCE_ACTOR.dispose();
            CONTEXT.dispose();
            DEVICE.dispose();
            CANVAS.remove();
            LOADER.dispose();
            if (FINAL_ERROR !== 0) {
                throw new Error(`Centered SVG WebGL render error ${FINAL_ERROR}`);
            }
            return {
                sourceSha256: NORMALIZED_ASSET.sourceSha256,
                viewBox: NORMALIZED_ASSET.viewBox,
                frameHashes: FRAME_HASHES,
                movingPixels,
                redPixels,
                greenPixels,
                bluePixels,
            };
        },
        {
            sourcePath: CENTERED_SOURCE_PATH,
            sourceSha256: CENTERED_SOURCE_SHA256,
            nodeGeometrySha256: CENTERED_GEOMETRY_SHA256,
        },
    );
    assert.equal(CENTERED_ERRORS.length, 0, CENTERED_ERRORS.join('\n'));
    await CENTERED_PAGE.close();
    REPORT.centeredSvgStartup = CENTERED_RESULT;
    REPORT.stages.push(
        'centered-viewBox normalization preserves original provenance, geometry, pivots, sockets, clip transforms, and actual WebGL pixels versus the prior build-time normalizer',
    );
    REPORT.browser = await browser.version();
    REPORT.contextLoss = SUPPORTS_LOSS;
    REPORT.scope =
        'Headless Chromium with actual WebGL2/SwiftShader pixels and built ESMs. CPU/interval observations are not mobile FPS or hardware-GPU certification. No screenshot/artifact retention.';
    console.log(JSON.stringify(REPORT, null, 2));
} finally {
    await browser?.close();
    await new Promise((resolve) => SERVER.close(resolve));
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';
import { buildPreviews } from '../../../project/previews.mjs';
import { summarizeSamples } from '../examples/raster-benchmark.js';
import { createAccumulation } from '../examples/raster-accumulation.js';

const STAT_CHECK = summarizeSamples([1, 2, 100]);
assert.equal(STAT_CHECK.mean, 103 / 3);
assert.equal(STAT_CHECK.p95, 90.19999999999999);
assert.ok(Math.abs(STAT_CHECK.p99 - 98.04) < 1e-10);
assert.equal(STAT_CHECK.max, 100);
assert.equal(STAT_CHECK.overBudgetCount, 1);
assert.equal(summarizeSamples([]).mean, null);
const ACCUMULATOR_CHECK = createAccumulation();
const ROUND_FIXTURE = (status) => ({
    setup: { wallMs: 2, atlasAllocatedBytes: 16, snapshot: { preparation: { cpuMs: 10 } } },
    methods: ['vector', 'raster', 'sprite'].map((mode) => ({
        mode,
        measuredFrames: 3,
        gpuMs: { status },
        raw: {
            cpuTotalMs: [1, 2, 100],
            submitMs: [0.5, 1, 90],
            frameIntervalsMs: [16, 17, 100],
            gpuSamples: [{ ms: 0.3 }],
            frames: [{ drawCalls: 1 }, { drawCalls: 1 }, { drawCalls: 1 }],
        },
    })),
});
ACCUMULATOR_CHECK.append('same', 'same condition', ROUND_FIXTURE('partial'));
const ACCUMULATED_CHECK = ACCUMULATOR_CHECK.append('same', 'same condition', ROUND_FIXTURE('disjoint'));
assert.equal(ACCUMULATED_CHECK[0].methods[0].measuredFrames, 6);
assert.equal(ACCUMULATED_CHECK[0].methods[0].gpuMs.count, 1);
assert.equal(ACCUMULATED_CHECK[0].methods[0].gpuMs.expectedCount, 6);
assert.equal(ACCUMULATED_CHECK[0].methods[0].gpuMs.mean, 0.3);
assert.equal(ACCUMULATED_CHECK[0].methods[0].gpuMs.invalidRounds, 1);
for (let index = 0; index < 6; index++) {
    ACCUMULATOR_CHECK.append(String(index), 'distinct condition', ROUND_FIXTURE('unsupported'));
}
assert.equal(ACCUMULATOR_CHECK.snapshot().length, 5);
assert.equal(ACCUMULATOR_CHECK.snapshot()[0].key, '1');
const OVERSIZE = ROUND_FIXTURE('available');
OVERSIZE.methods[0].raw.cpuTotalMs = new Array(6001).fill(1);
assert.throws(() => ACCUMULATOR_CHECK.append('oversize', 'limit', OVERSIZE), RangeError);
ACCUMULATOR_CHECK.reset();
assert.deepEqual(ACCUMULATOR_CHECK.snapshot(), []);

const ROOT = resolve('.');
const SOURCE = 'modules/vector-assets/assets/seed-scout.svg';
const COMPILED = await compileVectorAssetFile(SOURCE, SOURCE);
const LOOP_SOURCE = 'modules/vector-assets/assets/seed-scout-raster-comparison.svg';
const LOOP_FIXTURE = await compileVectorAssetFile(LOOP_SOURCE, LOOP_SOURCE);
assert.deepEqual(LOOP_FIXTURE.geometry, COMPILED.geometry, 'Comparison fixture preserves original SVG geometry');
assert.deepEqual(LOOP_FIXTURE.metadata.clips.bounce, COMPILED.metadata.clips.bounce, 'Original once clip is unchanged');
assert.deepEqual(LOOP_FIXTURE.metadata.clips['transform-repeat'], {
    ...COMPILED.metadata.clips.bounce,
    loop: 'repeat',
});
const SKETCH_SOURCE = 'modules/vector-assets/assets/sketch-fox.svg';
const SKETCH_COMPILED = await compileVectorAssetFile(SKETCH_SOURCE, SKETCH_SOURCE);
const SHADER_SOURCE = 'modules/vector-assets/tests/world-shader.svg';
const SHADER_COMPILED = await compileVectorAssetFile(SHADER_SOURCE, SHADER_SOURCE);
const RENDERING_URL =
    'data:text/javascript;base64,' + (await readFile(resolve(ROOT, 'dist/rendering.js'))).toString('base64');
const VECTOR_URL =
    'data:text/javascript;base64,' + (await readFile(resolve(ROOT, 'dist/vector-assets.js'))).toString('base64');
const ASSET_URL =
    'data:text/javascript;base64,' + Buffer.from(compiledAssetModuleSource(COMPILED, 'asset')).toString('base64');
const SKETCH_URL =
    'data:text/javascript;base64,' +
    Buffer.from(compiledAssetModuleSource(SKETCH_COMPILED, 'asset')).toString('base64');
const SHADER_URL =
    'data:text/javascript;base64,' +
    Buffer.from(compiledAssetModuleSource(SHADER_COMPILED, 'asset')).toString('base64');
await buildPreviews(ROOT);
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
const ERRORS = [];
const CONSOLE_MESSAGES = [];
const SCRUB = (value) =>
    String(value ?? '')
        .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[bundled module]')
        .slice(0, 12000);
let preview;
let direct;
let directPage;
try {
    const PREVIEW_PAGE = await BROWSER.newPage({ viewport: { width: 1100, height: 720 } });
    PREVIEW_PAGE.on('pageerror', (error) => ERRORS.push('preview: ' + SCRUB(error.stack)));
    PREVIEW_PAGE.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
            CONSOLE_MESSAGES.push({ stage: 'preview', type: message.type(), text: SCRUB(message.text()) });
        }
    });
    await PREVIEW_PAGE.goto(pathToFileURL(resolve(ROOT, 'dist/previews/vector-raster-comparison.html')).href);
    await PREVIEW_PAGE.waitForFunction(
        () => window.__rasterComparison?.ready || window.__rasterComparison?.error,
        null,
        {
            timeout: 20000,
        },
    );
    preview = await PREVIEW_PAGE.evaluate(async () => {
        const DEMO = window.__rasterComparison;
        if (DEMO.error) {
            throw new Error(DEMO.error);
        }
        DEMO.setAutoRender(false);
        const DEFAULT_FRAME = DEMO.renderOnce({ timeMs: 130 });
        const DEFAULT_PATHS = {
            modes: DEFAULT_FRAME.comparisonModes,
            mode: DEFAULT_FRAME.mode,
            atlas: DEFAULT_FRAME.atlas,
            rasterDraws: DEFAULT_FRAME.rasterResult.rasterDraws,
            partBytes: DEFAULT_FRAME.preparation.partAtlasBytes,
            tradeoffPaths: Object.keys(DEFAULT_FRAME.tradeoff.paths),
            partCardDisplay: getComputedStyle(document.getElementById('raster-card')).display,
        };
        document.getElementById('part-enabled').click();
        const ADVANCED_FRAME = DEMO.renderOnce({ timeMs: 130 });
        const ADVANCED_PATHS = {
            modes: ADVANCED_FRAME.comparisonModes,
            mode: ADVANCED_FRAME.mode,
            partBytes: ADVANCED_FRAME.preparation.partAtlasBytes,
            partCardDisplay: getComputedStyle(document.getElementById('raster-card')).display,
        };
        DEMO.setCount(1);
        DEMO.setClip('bounce');
        const LIVE_HUD = [];
        for (const MODE of ['split3', 'split', 'vector', 'raster', 'sprite']) {
            DEMO.setMode(MODE);
            const FRAME = DEMO.renderOnce({ timeMs: 130 });
            LIVE_HUD.push({
                mode: MODE,
                submitMs: FRAME.submitMs,
                frameText: document.getElementById('frame-metrics').textContent,
                cards: ['vector', 'raster', 'sprite'].map((side) => {
                    const CARD = document.getElementById(`${side}-card`);
                    return {
                        side,
                        label: CARD.querySelector('.cpu-label').textContent,
                        cpu: CARD.querySelector('.cpu').textContent,
                    };
                }),
            });
        }
        DEMO.setMode('raster');
        DEMO.setResolution(512);
        const FRAMES = [];
        for (const ZOOM of [0.5, 1, 3]) {
            DEMO.setZoom(ZOOM);
            FRAMES.push(DEMO.renderOnce({ timeMs: 130 }));
        }
        DEMO.setResolution(512);
        const SAME_RESOLUTION = DEMO.renderOnce({ timeMs: 130 });
        DEMO.setClip('idle');
        const OPACITY = DEMO.renderOnce({ timeMs: 130 });
        const PREWARM_CASES = [];
        for (const [RESOLUTION, INTERVAL] of [
            [64, 100],
            [128, 50],
        ]) {
            DEMO.setResolution(RESOLUTION);
            DEMO.setSampleInterval(INTERVAL);
            DEMO.setExpression('neutral');
            DEMO.setClip('transform-repeat');
            DEMO.setMode('sprite');
            let preparedFrame = null;
            for (let attempt = 0; attempt < 40; attempt++) {
                preparedFrame = DEMO.renderOnce({ timeMs: 130 });
                if (preparedFrame.preparation?.status === 'ready') {
                    break;
                }
            }
            const BASELINE = {
                preparation: preparedFrame?.preparation ?? null,
                imageTexUploadCount: preparedFrame?.imageTexUploadCount,
                imageTexUploadBytes: preparedFrame?.imageTexUploadBytes,
            };
            const SWITCHES = [];
            for (const CLIP of ['transform-repeat', 'bounce', 'idle']) {
                DEMO.setClip(CLIP);
                for (const EXPRESSION of ['neutral', 'happy', 'surprised']) {
                    DEMO.setExpression(EXPRESSION);
                    for (const TIME_MS of [40, 230]) {
                        const FRAME = DEMO.renderOnce({ timeMs: TIME_MS });
                        SWITCHES.push({
                            clip: CLIP,
                            expression: EXPRESSION,
                            timeMs: TIME_MS,
                            spriteDraws: FRAME.spriteResult.spriteDraws,
                            vectorFallbacks: FRAME.spriteResult.vectorFallbacks,
                            preparationStatus: FRAME.preparation?.status,
                            generation: FRAME.preparation?.generation,
                            bakeCounts: FRAME.preparation?.entries?.map((entry) => entry.bakeCount),
                            imageTexUploadCount: FRAME.imageTexUploadCount,
                            imageTexUploadBytes: FRAME.imageTexUploadBytes,
                        });
                    }
                }
            }
            PREWARM_CASES.push({ resolution: RESOLUTION, interval: INTERVAL, baseline: BASELINE, switches: SWITCHES });
        }
        DEMO.setMode('vector');
        DEMO.setClip('transform-repeat');
        DEMO.setExpression('neutral');
        DEMO.setPixelSize(64);
        DEMO.setSpread(100);
        DEMO.setSeed(4242);
        DEMO.setCount(100);
        document.getElementById('single-tab').click();
        const SINGLE = DEMO.renderOnce({ timeMs: 500 });
        const SINGLE_SELECTED = document.getElementById('single-tab').getAttribute('aria-selected');
        document.getElementById('crowd-tab').click();
        DEMO.setCount(1);
        const CROWD_ONE = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setCount(100);
        const CROWD_HUNDRED = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setCount(500);
        const CROWD_FIVE_HUNDRED = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setCount(1000);
        const CROWD_THOUSAND = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setSpread(35);
        const NARROW_SPREAD = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setSpread(100);
        DEMO.setSeed(4243);
        const DIFFERENT_SEED = DEMO.renderOnce({ timeMs: 500 });
        DEMO.setSeed(4242);
        const RESTORED_LAYOUT = DEMO.renderOnce({ timeMs: 500 });
        const CROWD_SELECTED = document.getElementById('crowd-tab').getAttribute('aria-selected');
        const CACHE = (frame) => ({
            generation: frame.preparation.generation,
            bakeCounts: frame.preparation.entries.map((entry) => entry.bakeCount),
            imageTexUploadCount: frame.imageTexUploadCount,
            imageTexUploadBytes: frame.imageTexUploadBytes,
        });
        const LAYOUT_CASES = {
            single: { count: SINGLE.count, layout: SINGLE.layout, selected: SINGLE_SELECTED },
            one: { count: CROWD_ONE.count, layout: CROWD_ONE.layout },
            hundred: { count: CROWD_HUNDRED.count, layout: CROWD_HUNDRED.layout },
            fiveHundred: { count: CROWD_FIVE_HUNDRED.count, layout: CROWD_FIVE_HUNDRED.layout },
            thousand: { count: CROWD_THOUSAND.count, layout: CROWD_THOUSAND.layout },
            narrow: NARROW_SPREAD.layout,
            differentSeed: DIFFERENT_SEED.layout,
            restored: RESTORED_LAYOUT.layout,
            crowdSelected: CROWD_SELECTED,
            caches: [
                CROWD_ONE,
                CROWD_HUNDRED,
                CROWD_FIVE_HUNDRED,
                CROWD_THOUSAND,
                NARROW_SPREAD,
                DIFFERENT_SEED,
                RESTORED_LAYOUT,
            ].map(CACHE),
        };
        DEMO.setCount(100);
        DEMO.setMode('vector');
        DEMO.setClip('transform-repeat');
        DEMO.setExpression('happy');
        DEMO.setSpread(35);
        DEMO.setZoom(2);
        const QUALITY_STATE = (frame) => ({
            clip: frame.clip,
            expression: frame.expression,
            count: frame.count,
            timeMs: frame.timeMs,
            zoom: frame.zoom,
            mixed: frame.mixed,
            phaseSignature: frame.phaseSignature,
            layout: frame.layout,
        });
        const QUALITY_CACHE = (frame) => ({
            compileCount: frame.quality.compileCount,
            preparationGeneration: frame.preparation.generation,
            bakeCounts: frame.preparation.entries.map((entry) => entry.bakeCount),
            atlasBakeCount: frame.atlas.bakeCount,
            imageTexUploadCount: frame.imageTexUploadCount,
            imageTexUploadBytes: frame.imageTexUploadBytes,
        });
        const QUALITY_FRAME = (frame) => ({
            sourceSha256: frame.sourceSha256,
            quality: frame.quality,
            tradeoff: frame.tradeoff,
            state: QUALITY_STATE(frame),
            cache: QUALITY_CACHE(frame),
            vectorGpuPoses: frame.poses.gpuDrawInstances,
        });
        const STEADY_QUALITY_FRAME = (timeMs) => {
            DEMO.renderOnce({ timeMs });
            return QUALITY_FRAME(DEMO.renderOnce({ timeMs }));
        };
        const STANDARD_BEFORE = STEADY_QUALITY_FRAME(230);
        const QUALITY_PATHS = [];
        const COMPARE_QUALITY_PIXELS = (vector, raster) => {
            if (vector.width !== raster.width || vector.height !== raster.height) {
                throw new Error('Quality path comparison viewport mismatch');
            }
            let foreground = 0;
            let difference = 0;
            let changed = 0;
            let spurious = 0;
            for (let offset = 0; offset < vector.pixels.length; offset += 4) {
                const VECTOR_PAINT = vector.pixels[offset + 3] > 8;
                const RASTER_PAINT = raster.pixels[offset + 3] > 8;
                if (!VECTOR_PAINT && !RASTER_PAINT) {
                    continue;
                }
                foreground++;
                let channelMax = 0;
                for (let channel = 0; channel < 4; channel++) {
                    const DELTA = Math.abs(vector.pixels[offset + channel] - raster.pixels[offset + channel]);
                    difference += DELTA;
                    channelMax = Math.max(channelMax, DELTA);
                }
                changed += Number(channelMax > 48);
                spurious += Number(!VECTOR_PAINT && RASTER_PAINT && channelMax > 32);
            }
            return {
                foregroundPixels: foreground,
                meanForegroundChannelError: foreground ? difference / (foreground * 4) : 0,
                changedFraction: foreground ? changed / foreground : 0,
                spuriousFraction: foreground ? spurious / foreground : 0,
            };
        };
        const CHECK_QUALITY_PATHS = (preset) => {
            DEMO.setCount(1);
            DEMO.setMode('vector');
            DEMO.renderOnce({ timeMs: 230 });
            const VECTOR_PIXELS = DEMO.capturePixels();
            DEMO.setMode('raster');
            const RASTER = DEMO.renderOnce({ timeMs: 230 });
            const RASTER_PIXELS = DEMO.capturePixels();
            DEMO.setMode('sprite');
            const SPRITE = DEMO.renderOnce({ timeMs: 230 });
            DEMO.setMode('vector');
            DEMO.setCount(100);
            QUALITY_PATHS.push({
                preset,
                rasterDraws: RASTER.rasterResult.rasterDraws,
                rasterFallbacks: RASTER.rasterResult.vectorFallbacks,
                spriteDraws: SPRITE.spriteResult.spriteDraws,
                spriteFallbacks: SPRITE.spriteResult.vectorFallbacks,
                vectorRasterPixels: COMPARE_QUALITY_PIXELS(VECTOR_PIXELS, RASTER_PIXELS),
            });
        };
        await DEMO.setQuality('low');
        const LOW = STEADY_QUALITY_FRAME(230);
        CHECK_QUALITY_PATHS('low');
        await DEMO.setQuality('high');
        const HIGH = STEADY_QUALITY_FRAME(230);
        CHECK_QUALITY_PATHS('high');
        await DEMO.setQuality('high');
        const HIGH_RESELECTED = STEADY_QUALITY_FRAME(230);
        const HIGH_NORMAL_FRAME = QUALITY_FRAME(DEMO.renderOnce({ timeMs: 246 }));
        await DEMO.setQuality('standard');
        const STANDARD_AFTER = STEADY_QUALITY_FRAME(230);
        const QUALITY_CASES = {
            standardBefore: STANDARD_BEFORE,
            low: LOW,
            high: HIGH,
            highReselected: HIGH_RESELECTED,
            highNormalFrame: HIGH_NORMAL_FRAME,
            standardAfter: STANDARD_AFTER,
            paths: QUALITY_PATHS,
        };
        DEMO.setCount(1);
        const BEFORE_BENCHMARK = DEMO.benchmarkState;
        const BENCHMARK_RESULT = await DEMO.runBenchmark({
            scene: 'crowd',
            count: 1,
            pixelSize: 64,
            spread: 100,
            seed: 4242,
            warmupFrames: 30,
            sampleFrames: 60,
        });
        const BENCHMARK = {
            config: BENCHMARK_RESULT.config,
            preparationGeneration: BENCHMARK_RESULT.preparationGeneration,
            methods: BENCHMARK_RESULT.methods.map((method) => ({
                mode: method.mode,
                warmupFrames: method.warmupFrames,
                measuredFrames: method.measuredFrames,
                fps: method.fps,
                frameIntervalMs: method.frameIntervalMs,
                cpuTotalMs: method.cpuTotalMs,
                submitMs: method.submitMs,
                gpuMs: method.gpuMs,
                rawFrames: method.raw.frames.length,
                rawIntervals: method.raw.frameIntervalsMs.length,
                firstDisplayTime: method.raw.frames[0]?.sourceTimeMs,
                lastDisplayTime: method.raw.frames.at(-1)?.sourceTimeMs,
            })),
            stateRestored: JSON.stringify(DEMO.benchmarkState) === JSON.stringify(BEFORE_BENCHMARK),
        };
        const ACCUMULATION_FIRST = await DEMO.startAccumulation({ maxRounds: 1 });
        const ACCUMULATION_RESUMED = await DEMO.startAccumulation({ maxRounds: 1 });
        const BEFORE_CANCEL = JSON.stringify(DEMO.accumulation.history);
        const CANCELLED_RUN = DEMO.startAccumulation();
        document.getElementById('accumulate-stop').click();
        await CANCELLED_RUN;
        const CANCEL_PRESERVED = JSON.stringify(DEMO.accumulation.history) === BEFORE_CANCEL;
        const AFTER_CANCEL = DEMO.accumulation;
        DEMO.setScene('single');
        const ACCUMULATION_NEW_CONDITION = await DEMO.startAccumulation({ maxRounds: 1 });
        const NEW_CONDITION_TEXT = document.getElementById('accumulated-results').textContent;
        const RESIZE_RUN = DEMO.startAccumulation();
        window.dispatchEvent(new Event('resize'));
        await RESIZE_RUN;
        const AFTER_RESIZE = DEMO.accumulation;
        const STOP_STATUS = document.getElementById('accumulation-status').textContent;
        const TOGGLE_RUN = DEMO.startAccumulation();
        DEMO.setPartEnabled(false);
        await TOGGLE_RUN;
        const BASIC_FRAME = DEMO.renderOnce({ timeMs: 130 });
        const BASIC_MEASUREMENT = await DEMO.runBenchmark();
        const BASIC_HISTORY = await DEMO.startAccumulation({ maxRounds: 1 });
        const BEFORE_RESELECT = DEMO.renderOnce({ timeMs: 130 });
        DEMO.setPartEnabled(false);
        const AFTER_RESELECT = DEMO.renderOnce({ timeMs: 150 });
        const BASIC_PATHS = {
            atlas: BASIC_FRAME.atlas,
            partBytes: BASIC_FRAME.preparation.partAtlasBytes,
            rasterDraws: BASIC_FRAME.rasterResult.rasterDraws,
            methods: BASIC_MEASUREMENT.methods.map((method) => method.mode),
            historyModes: BASIC_HISTORY.map((condition) => condition.methods.map((method) => method.mode)),
            historyKeys: BASIC_HISTORY.map((condition) => JSON.parse(condition.key).paths),
            partCardDisplay: getComputedStyle(document.getElementById('raster-card')).display,
            stableGeneration: BEFORE_RESELECT.preparation.generation === AFTER_RESELECT.preparation.generation,
            stableImages: BEFORE_RESELECT.imageTexUploadCount === AFTER_RESELECT.imageTexUploadCount,
            stableBakeCounts:
                JSON.stringify(BEFORE_RESELECT.preparation.entries.map((entry) => entry.bakeCount)) ===
                JSON.stringify(AFTER_RESELECT.preparation.entries.map((entry) => entry.bakeCount)),
        };
        document.getElementById('accumulate-reset').click();
        const RESET_HISTORY = DEMO.accumulation;
        const ACCUMULATION_STATE_RESTORED = DEMO.benchmarkState.mode === BEFORE_BENCHMARK.mode;
        const DISPOSE_RUN = DEMO.startAccumulation();
        const DISPOSED = DEMO.dispose();
        await DISPOSE_RUN;
        return {
            frames: FRAMES,
            liveHud: LIVE_HUD,
            pathSelection: { defaults: DEFAULT_PATHS, advanced: ADVANCED_PATHS, basic: BASIC_PATHS },
            sameResolution: SAME_RESOLUTION,
            opacity: OPACITY,
            prewarmCases: PREWARM_CASES,
            layoutCases: LAYOUT_CASES,
            qualityCases: QUALITY_CASES,
            benchmark: BENCHMARK,
            accumulation: {
                first: ACCUMULATION_FIRST,
                resumed: ACCUMULATION_RESUMED,
                cancelPreserved: CANCEL_PRESERVED,
                afterCancel: AFTER_CANCEL,
                newCondition: ACCUMULATION_NEW_CONDITION,
                newConditionText: NEW_CONDITION_TEXT,
                afterResize: AFTER_RESIZE,
                stopStatus: STOP_STATUS,
                reset: RESET_HISTORY,
                stateRestored: ACCUMULATION_STATE_RESTORED,
                disposeRunning: DEMO.accumulation.running,
            },
            disposed: DISPOSED,
        };
    });
    assert.equal(preview.disposed, true);
    assert.deepEqual(preview.pathSelection.defaults.modes, ['vector', 'sprite']);
    assert.equal(preview.pathSelection.defaults.mode, 'split2');
    assert.equal(preview.pathSelection.defaults.atlas, null);
    assert.equal(preview.pathSelection.defaults.partBytes, 0);
    assert.equal(preview.pathSelection.defaults.rasterDraws, 0);
    assert.deepEqual(preview.pathSelection.defaults.tradeoffPaths, ['vector', 'sprite']);
    assert.equal(preview.pathSelection.defaults.partCardDisplay, 'none');
    assert.deepEqual(preview.pathSelection.advanced.modes, ['vector', 'raster', 'sprite']);
    assert.equal(preview.pathSelection.advanced.mode, 'split3');
    assert.ok(preview.pathSelection.advanced.partBytes > 0);
    assert.notEqual(preview.pathSelection.advanced.partCardDisplay, 'none');
    assert.equal(preview.pathSelection.basic.atlas, null);
    assert.equal(preview.pathSelection.basic.partBytes, 0);
    assert.equal(preview.pathSelection.basic.rasterDraws, 0);
    assert.deepEqual(preview.pathSelection.basic.methods, ['vector', 'sprite']);
    assert.deepEqual(preview.pathSelection.basic.historyModes.at(-1), ['vector', 'sprite']);
    assert.deepEqual(preview.pathSelection.basic.historyModes[0], ['vector', 'raster', 'sprite']);
    assert.deepEqual(preview.pathSelection.basic.historyKeys.at(-1), ['vector', 'sprite']);
    assert.equal(preview.pathSelection.basic.partCardDisplay, 'none');
    assert.equal(preview.pathSelection.basic.stableGeneration, true);
    assert.equal(preview.pathSelection.basic.stableImages, true);
    assert.equal(preview.pathSelection.basic.stableBakeCounts, true);
    for (const HUD of preview.liveHud) {
        assert.ok(
            HUD.frameText.startsWith(HUD.mode.startsWith('split') ? 'Shared visible paths' : 'Current full viewport'),
        );
        for (const CARD of HUD.cards) {
            if (HUD.mode === CARD.side) {
                assert.equal(CARD.label, 'Live submit (incl. flush)');
                assert.equal(CARD.cpu, `${HUD.submitMs.toFixed(2)} ms`);
            } else {
                assert.equal(CARD.label, 'CPU timing');
                assert.equal(CARD.cpu, 'Use sequential comparison');
            }
        }
    }
    for (const FRAME of preview.frames) {
        assert.equal(FRAME.rasterResult.rasterDraws, 1, JSON.stringify(FRAME.rasterResult));
        assert.equal(FRAME.rasterResult.vectorFallbacks, 0);
        assert.equal(FRAME.atlas.runCount, 7);
        assert.ok(FRAME.atlas.atlasBytes > 0);
    }
    assert.equal(preview.opacity.rasterResult.vectorFallbacks, 1);
    assert.ok(preview.sameResolution.textureBytes < preview.sameResolution.atlas.atlasBytes);
    assert.ok(preview.opacity.rasterResult.reasons.includes('opacityChannel'));
    assert.equal(preview.prewarmCases.length, 2);
    assert.ok(preview.prewarmCases.every((entry) => entry.baseline.preparation));
    assert.notEqual(
        preview.prewarmCases[0].baseline.preparation.generation,
        preview.prewarmCases[1].baseline.preparation.generation,
        'Resolution and interval change require a fresh initial preparation',
    );
    for (const CASE of preview.prewarmCases) {
        const PREPARATION = CASE.baseline.preparation;
        assert.equal(PREPARATION.status, 'ready', JSON.stringify(PREPARATION));
        assert.equal(PREPARATION.total, 9);
        assert.equal(PREPARATION.completed, 9);
        assert.equal(PREPARATION.entries.length, 9);
        assert.equal(new Set(PREPARATION.entries.map((entry) => entry.key)).size, 9);
        assert.deepEqual(
            new Set(PREPARATION.entries.map((entry) => entry.clip)),
            new Set(['transform-repeat', 'bounce', 'idle']),
        );
        assert.deepEqual(
            new Set(PREPARATION.entries.map((entry) => entry.expression)),
            new Set(['neutral', 'happy', 'surprised']),
        );
        assert.ok(PREPARATION.entries.every((entry) => entry.ready && entry.bakeCount === 1));
        assert.ok(PREPARATION.allocatedBytes > 0 && PREPARATION.allocatedBytes <= PREPARATION.budgetBytes);
        assert.ok(Number.isSafeInteger(CASE.baseline.imageTexUploadCount));
        assert.ok(Number.isSafeInteger(CASE.baseline.imageTexUploadBytes));
        const BAKE_COUNTS = PREPARATION.entries.map((entry) => entry.bakeCount);
        assert.equal(CASE.switches.length, 18);
        for (const SWITCH of CASE.switches) {
            const LABEL = `${CASE.resolution}px/${CASE.interval}ms ${SWITCH.clip}/${SWITCH.expression}@${SWITCH.timeMs}`;
            assert.equal(SWITCH.spriteDraws, 1, LABEL);
            assert.equal(SWITCH.vectorFallbacks, 0, LABEL);
            assert.equal(SWITCH.preparationStatus, 'ready', LABEL);
            assert.equal(SWITCH.generation, PREPARATION.generation, LABEL);
            assert.deepEqual(SWITCH.bakeCounts, BAKE_COUNTS, `${LABEL}: no bake during prepared playback`);
            assert.equal(
                SWITCH.imageTexUploadCount,
                CASE.baseline.imageTexUploadCount,
                `${LABEL}: no image texture upload during prepared playback`,
            );
            assert.equal(
                SWITCH.imageTexUploadBytes,
                CASE.baseline.imageTexUploadBytes,
                `${LABEL}: no image texture bytes during prepared playback`,
            );
        }
    }
    assert.equal(preview.layoutCases.single.selected, 'true');
    assert.equal(preview.layoutCases.single.count, 1);
    assert.equal(preview.layoutCases.single.layout.scene, 'single');
    assert.equal(preview.layoutCases.crowdSelected, 'true');
    assert.equal(preview.layoutCases.one.count, 1);
    assert.equal(preview.layoutCases.hundred.count, 100);
    assert.equal(preview.layoutCases.fiveHundred.count, 500);
    assert.equal(preview.layoutCases.thousand.count, 1000);
    assert.equal(preview.layoutCases.hundred.layout.pixelSize, 64);
    assert.equal(preview.layoutCases.fiveHundred.layout.pixelSize, 64);
    assert.equal(preview.layoutCases.thousand.layout.pixelSize, 64);
    assert.deepEqual(
        preview.layoutCases.one.layout.positions,
        preview.layoutCases.hundred.layout.positions.slice(0, 1),
    );
    assert.deepEqual(preview.layoutCases.hundred.layout.positions, preview.layoutCases.fiveHundred.layout.positions);
    assert.deepEqual(preview.layoutCases.fiveHundred.layout.positions, preview.layoutCases.thousand.layout.positions);
    for (const CACHE of preview.layoutCases.caches) {
        assert.deepEqual(
            CACHE,
            preview.layoutCases.caches[0],
            'Count, spread, and seed changes reuse prepared atlases',
        );
    }
    assert.notEqual(
        preview.layoutCases.narrow.positionSignature,
        preview.layoutCases.fiveHundred.layout.positionSignature,
    );
    assert.notEqual(
        preview.layoutCases.differentSeed.positionSignature,
        preview.layoutCases.fiveHundred.layout.positionSignature,
    );
    assert.equal(
        preview.layoutCases.restored.positionSignature,
        preview.layoutCases.fiveHundred.layout.positionSignature,
    );
    const QUALITY = preview.qualityCases;
    assert.deepEqual(
        [QUALITY.low.quality.key, QUALITY.high.quality.key, QUALITY.standardAfter.quality.key],
        ['low', 'high', 'standard'],
    );
    assert.deepEqual(
        [
            QUALITY.low.quality.curveSegments,
            QUALITY.standardAfter.quality.curveSegments,
            QUALITY.high.quality.curveSegments,
        ],
        [2, 4, 16],
    );
    for (const FRAME of [QUALITY.low, QUALITY.high, QUALITY.standardAfter]) {
        assert.equal(FRAME.quality.strokeArcDivisions, 2);
        assert.equal(FRAME.quality.compileWallMs, null, 'Loader does not claim a compiler-only duration');
        assert.equal(FRAME.quality.loadStatus, 'ready');
        assert.equal(
            FRAME.sourceSha256,
            QUALITY.standardBefore.sourceSha256,
            'All quality levels use the same source SVG',
        );
        assert.deepEqual(
            FRAME.state,
            QUALITY.standardBefore.state,
            'Quality switch preserves scene and animation state',
        );
        assert.equal(FRAME.vectorGpuPoses, 100);
        assert.equal(FRAME.tradeoff.activeCpuSourceGeometryBytes, FRAME.quality.cpuSourceGeometryBytes);
        assert.equal(FRAME.tradeoff.paths.vector.uniqueVerticesPerActor, FRAME.quality.sourceVertexCount);
        assert.equal(FRAME.tradeoff.paths.vector.logicalRgbaBytes, 0);
        assert.equal(FRAME.tradeoff.paths.vector.initialPrepareMs, null);
        assert.ok(FRAME.tradeoff.paths.raster.logicalRgbaBytes > 0);
        assert.ok(FRAME.tradeoff.paths.sprite.logicalRgbaBytes > 0);
        assert.equal(FRAME.cache.imageTexUploadCount, QUALITY.standardBefore.cache.imageTexUploadCount);
        assert.equal(FRAME.cache.imageTexUploadBytes, QUALITY.standardBefore.cache.imageTexUploadBytes);
    }
    assert.ok(QUALITY.low.quality.loadWallMs > 0);
    assert.ok(QUALITY.high.quality.loadWallMs > 0);
    assert.ok(QUALITY.high.quality.sourceVertexCount > QUALITY.low.quality.sourceVertexCount);
    assert.ok(QUALITY.high.quality.expressionTriangles > QUALITY.low.quality.expressionTriangles);
    assert.ok(QUALITY.high.quality.cpuSourceGeometryBytes > QUALITY.low.quality.cpuSourceGeometryBytes);
    assert.ok(QUALITY.standardAfter.quality.sourceVertexCount >= QUALITY.low.quality.sourceVertexCount);
    assert.ok(QUALITY.standardAfter.quality.sourceVertexCount <= QUALITY.high.quality.sourceVertexCount);
    assert.equal(QUALITY.low.cache.compileCount, QUALITY.standardBefore.cache.compileCount + 1);
    assert.equal(QUALITY.high.cache.compileCount, QUALITY.low.cache.compileCount + 1);
    assert.equal(QUALITY.standardAfter.cache.compileCount, QUALITY.high.cache.compileCount);
    assert.deepEqual(QUALITY.highReselected.cache, QUALITY.high.cache, 'Reselecting high does not recompile or rebake');
    assert.deepEqual(QUALITY.highNormalFrame.cache, QUALITY.high.cache, 'Ordinary frames do not recompile or rebake');
    assert.equal(QUALITY.paths.length, 2);
    for (const PATH of QUALITY.paths) {
        assert.ok(['low', 'high'].includes(PATH.preset));
        assert.equal(PATH.rasterDraws, 1);
        assert.equal(PATH.rasterFallbacks, 0);
        assert.equal(PATH.spriteDraws, 1);
        assert.equal(PATH.spriteFallbacks, 0);
        assert.ok(PATH.vectorRasterPixels.foregroundPixels > 100, JSON.stringify(PATH));
        assert.ok(PATH.vectorRasterPixels.meanForegroundChannelError <= 5, JSON.stringify(PATH));
        assert.ok(PATH.vectorRasterPixels.changedFraction <= 0.05, JSON.stringify(PATH));
        assert.ok(PATH.vectorRasterPixels.spuriousFraction <= 0.01, JSON.stringify(PATH));
    }
    assert.equal(preview.benchmark.stateRestored, true);
    const ACCUMULATION = preview.accumulation;
    assert.equal(ACCUMULATION.first.length, 1);
    assert.equal(ACCUMULATION.first[0].methods[0].measuredFrames, 60);
    assert.equal(ACCUMULATION.resumed[0].methods[0].measuredFrames, 120);
    assert.equal(ACCUMULATION.cancelPreserved, true);
    assert.equal(ACCUMULATION.afterCancel.running, false);
    assert.equal(ACCUMULATION.newCondition.length, 2);
    assert.equal(ACCUMULATION.newCondition[0].methods[0].measuredFrames, 120);
    assert.equal(ACCUMULATION.newCondition[1].methods[0].measuredFrames, 60);
    assert.ok(ACCUMULATION.newConditionText.includes('p99'));
    assert.ok(ACCUMULATION.newConditionText.includes('steady image upload / bake Δ0'));
    assert.equal(ACCUMULATION.afterResize.running, false);
    assert.ok(ACCUMULATION.stopStatus.startsWith('Stopped.'));
    assert.deepEqual(ACCUMULATION.reset.history, []);
    assert.equal(ACCUMULATION.stateRestored, true);
    assert.equal(ACCUMULATION.disposeRunning, false);
    for (const CONDITION of ACCUMULATION.newCondition) {
        for (const METHOD of CONDITION.methods) {
            assert.equal(METHOD.cpuTotalMs.count, METHOD.measuredFrames);
            assert.equal(METHOD.frameIntervalMs.count, METHOD.measuredFrames);
            assert.ok(METHOD.cpuTotalMs.p50 <= METHOD.cpuTotalMs.p95);
            assert.ok(METHOD.cpuTotalMs.p95 <= METHOD.cpuTotalMs.p99);
            assert.ok(METHOD.cpuTotalMs.p99 <= METHOD.cpuTotalMs.max);
            assert.ok(METHOD.measuredDurationMs > 0);
            assert.ok(METHOD.gpuMs.count <= METHOD.gpuMs.expectedCount);
            assert.ok(METHOD.gpuMs.count > 0 || METHOD.gpuMs.mean === null);
        }
    }
    assert.deepEqual(
        preview.benchmark.methods.map((method) => method.mode),
        ['vector', 'raster', 'sprite'],
    );
    for (const METHOD of preview.benchmark.methods) {
        assert.equal(METHOD.warmupFrames, 30);
        assert.equal(METHOD.measuredFrames, 60);
        assert.equal(METHOD.rawFrames, 60);
        assert.equal(METHOD.rawIntervals, 60);
        assert.equal(METHOD.firstDisplayTime, 500);
        assert.ok(Math.abs(METHOD.lastDisplayTime - (500 + (59 * 1000) / 60)) < 1e-6);
        assert.ok(METHOD.fps > 0 && Number.isFinite(METHOD.fps));
        assert.ok(METHOD.frameIntervalMs.p50 > 0 && METHOD.frameIntervalMs.p95 > 0);
        assert.ok(METHOD.cpuTotalMs.p50 >= 0 && METHOD.cpuTotalMs.p95 >= 0);
        assert.ok(METHOD.submitMs.p50 >= 0 && METHOD.submitMs.p95 >= 0);
        assert.ok(
            ['available', 'partial', 'unsupported', 'pending', 'unavailable', 'disjoint'].includes(METHOD.gpuMs.status),
        );
    }
    await PREVIEW_PAGE.close();

    const PAGE = await BROWSER.newPage({ viewport: { width: 384, height: 384 }, deviceScaleFactor: 1 });
    directPage = PAGE;
    PAGE.on('pageerror', (error) => ERRORS.push('direct: ' + SCRUB(error.stack)));
    PAGE.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
            CONSOLE_MESSAGES.push({ stage: 'direct', type: message.type(), text: SCRUB(message.text()) });
        }
    });
    await PAGE.setContent('<canvas width="384" height="384"></canvas>');
    direct = await PAGE.evaluate(
        async ({ rendering, vectors, assetUrl, sketchUrl, shaderUrl }) => {
            const R = await import(rendering),
                V = await import(vectors),
                COMPILED_ASSET = (await import(assetUrl)).asset,
                SKETCH_COMPILED_ASSET = (await import(sketchUrl)).asset,
                SHADER_COMPILED_ASSET = (await import(shaderUrl)).asset,
                CANVAS = document.querySelector('canvas'),
                WIDTH = 384,
                HEIGHT = 384,
                DEVICE = new R.WebGLDevice(CANVAS, {
                    alpha: true,
                    antialias: true,
                    preserveDrawingBuffer: true,
                    checkGLErrors: true,
                }),
                MESHES = new R.MeshRenderer(DEVICE),
                ASSET = V.createVectorAsset(MESHES, COMPILED_ASSET),
                PLAYER = ASSET.createPlayer({ clip: 'bounce' }),
                ATLAS = V.createVectorRasterAtlas(MESHES, ASSET, COMPILED_ASSET, { pixelsPerUnit: 4, padding: 2 }),
                GL = DEVICE.gl;
            let stage = 'initial-assets';
            const CHECK_GL = (label) => {
                const ERROR = GL.getError();
                if (ERROR !== GL.NO_ERROR) {
                    window.__rasterDebug = {
                        label,
                        previousStage: stage,
                        glError: ERROR,
                        deviceFrame: DEVICE.stats.frame,
                        meshStats: MESHES.stats(),
                    };
                    throw new Error(`WebGL error ${ERROR} at ${label}; previous stage ${stage}`);
                }
            };
            const STAGE = (label) => {
                CHECK_GL(`before ${label}`);
                stage = label;
                window.__rasterTestStage = label;
            };
            STAGE('first-pixel-read');
            const READ = () => {
                const PIXELS = new Uint8Array(WIDTH * HEIGHT * 4);
                GL.readPixels(0, 0, WIDTH, HEIGHT, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                CHECK_GL(`readPixels ${stage}`);
                return PIXELS;
            };
            const CHECKER = () => {
                GL.enable(GL.SCISSOR_TEST);
                for (let y = 0; y < HEIGHT; y += 32) {
                    for (let x = 0; x < WIDTH; x += 32) {
                        const LIGHT = (x / 32 + y / 32) % 2 === 0;
                        GL.scissor(x, y, 32, 32);
                        GL.clearColor(...(LIGHT ? [0.88, 0.91, 0.84, 1] : [0.09, 0.13, 0.11, 1]));
                        GL.clear(GL.COLOR_BUFFER_BIT);
                    }
                }
                GL.disable(GL.SCISSOR_TEST);
            };
            const BEGIN = (background, width = WIDTH, height = HEIGHT, label = `frame:${background}`) => {
                STAGE(label);
                DEVICE.beginFrame({
                    width,
                    height,
                    clearColor: background === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 1],
                });
                MESHES.beginFrame();
                if (background === 'checker') {
                    CHECKER();
                }
                CHECK_GL(`begin ${stage}`);
            };
            const END = () => {
                MESHES.flush();
                DEVICE.endFrame();
                CHECK_GL(`end ${stage}`);
                return READ();
            };
            const PROJECTION = [2 / WIDTH, 0, 0, 0, -2 / HEIGHT, 0, -1, 1, 1];
            const MATRIX_FOR = (box, zoom) => {
                const BOX = box,
                    SCALE = Math.min(280 / BOX[2], 280 / BOX[3]) * zoom;
                return [
                    SCALE,
                    0,
                    0,
                    SCALE,
                    WIDTH / 2 - (BOX[0] + BOX[2] / 2) * SCALE,
                    HEIGHT / 2 - (BOX[1] + BOX[3] / 2) * SCALE,
                ];
            };
            const MATRIX = (zoom) => MATRIX_FOR(COMPILED_ASSET.viewBox, zoom);
            const RENDER = (kind, background, zoom, options = {}) => {
                BEGIN(background, WIDTH, HEIGHT, `${kind}:${background}:zoom${zoom}`);
                PLAYER.seek(130);
                const DRAW_OPTIONS = { projection: PROJECTION, matrix: MATRIX(zoom), ...options };
                const RESULT = kind === 'raster' ? ATLAS.draw(PLAYER, DRAW_OPTIONS) : PLAYER.draw(DRAW_OPTIONS);
                const PIXELS = END();
                return { result: RESULT, pixels: PIXELS, poses: MESHES.poseStats() };
            };
            const BACKGROUND = (background) => {
                BEGIN(background, WIDTH, HEIGHT, `background:${background}`);
                return END();
            };
            const COMPARE = (baseline, vector, raster) => {
                let foreground = 0,
                    changed = 0,
                    spurious = 0,
                    difference = 0,
                    maximum = 0;
                for (let offset = 0; offset < baseline.length; offset += 4) {
                    let vectorPaint = false,
                        rasterPaint = false,
                        channelMax = 0,
                        channelTotal = 0;
                    for (let channel = 0; channel < 4; channel++) {
                        const BASE = baseline[offset + channel],
                            LEFT = vector[offset + channel],
                            RIGHT = raster[offset + channel],
                            DELTA = Math.abs(LEFT - RIGHT);
                        vectorPaint ||= Math.abs(LEFT - BASE) > 8;
                        rasterPaint ||= Math.abs(RIGHT - BASE) > 8;
                        channelMax = Math.max(channelMax, DELTA);
                        maximum = Math.max(maximum, DELTA);
                        channelTotal += DELTA;
                    }
                    if (vectorPaint || rasterPaint) {
                        foreground++;
                        difference += channelTotal;
                        changed += Number(channelMax > 48);
                        spurious += Number(!vectorPaint && rasterPaint && channelMax > 32);
                    }
                }
                return {
                    foregroundPixels: foreground,
                    meanForegroundChannelError: foreground ? difference / (foreground * 4) : 0,
                    changedFraction: foreground ? changed / foreground : 0,
                    spuriousFraction: foreground ? spurious / foreground : 0,
                    maxChannelError: maximum,
                };
            };
            const COMPARISONS = [];
            for (const BACKDROP of ['black', 'white', 'checker']) {
                const EMPTY = BACKGROUND(BACKDROP);
                for (const ZOOM of [0.5, 1, 4]) {
                    const VECTOR = RENDER('vector', BACKDROP, ZOOM),
                        RASTER = RENDER('raster', BACKDROP, ZOOM);
                    COMPARISONS.push({
                        background: BACKDROP,
                        zoom: ZOOM,
                        backend: RASTER.result.backend,
                        ...COMPARE(EMPTY, VECTOR.pixels, RASTER.pixels),
                    });
                }
            }
            const EXPRESSION_COMPARISONS = [];
            for (const EXPRESSION of ['neutral', 'happy', 'surprised']) {
                PLAYER.setExpression(EXPRESSION);
                const EMPTY = BACKGROUND('black'),
                    VECTOR = RENDER('vector', 'black', 1),
                    RASTER = RENDER('raster', 'black', 1);
                EXPRESSION_COMPARISONS.push({
                    expression: EXPRESSION,
                    backend: RASTER.result.backend,
                    faceVisible: PLAYER.getPartPose(`face-${EXPRESSION}`).visible,
                    ...COMPARE(EMPTY, VECTOR.pixels, RASTER.pixels),
                });
            }
            PLAYER.setExpression('neutral');
            PLAYER.setPartVisible('face-happy', true);
            {
                const EMPTY = BACKGROUND('black'),
                    VECTOR = RENDER('vector', 'black', 1),
                    RASTER = RENDER('raster', 'black', 1);
                EXPRESSION_COMPARISONS.push({
                    expression: 'neutral+visibilityOverride',
                    backend: RASTER.result.backend,
                    faceVisible: PLAYER.getPartPose('face-happy').visible,
                    ...COMPARE(EMPTY, VECTOR.pixels, RASTER.pixels),
                });
            }
            PLAYER.setExpression('neutral');
            {
                const EMPTY = BACKGROUND('black'),
                    EXCLUDED = new Set(['body']),
                    VECTOR = RENDER('vector', 'black', 1, { excludeParts: EXCLUDED }),
                    RASTER = RENDER('raster', 'black', 1, { excludeParts: EXCLUDED });
                EXPRESSION_COMPARISONS.push({
                    expression: 'neutral+excludeParent',
                    backend: RASTER.result.backend,
                    childStillVisible: PLAYER.getPartPose('sprout').visible,
                    ...COMPARE(EMPTY, VECTOR.pixels, RASTER.pixels),
                });
            }
            const FALLBACKS = {};
            PLAYER.play('idle', 0);
            FALLBACKS.opacityChannel = RENDER('raster', 'black', 1).result;
            PLAYER.play('bounce', 0);
            PLAYER.setBasePose(COMPILED_ASSET.metadata.parts[0].id, { opacity: 0.7 });
            FALLBACKS.baseOpacity = RENDER('raster', 'black', 1).result;
            PLAYER.setBasePose(COMPILED_ASSET.metadata.parts[0].id, { opacity: 1 });
            FALLBACKS.globalOpacity = RENDER('raster', 'black', 1, { alpha: 0.5 }).result;
            FALLBACKS.colorOpacity = RENDER('raster', 'black', 1, { color: [1, 1, 1, 0.5] }).result;
            const LIMIT = V.createVectorRasterAtlas(MESHES, ASSET, COMPILED_ASSET, { maxAtlasBytes: 4 });
            BEGIN('black');
            FALLBACKS.atlasLimit = LIMIT.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
            END();
            LIMIT.dispose();
            const ORIGINAL_CREATE = DEVICE.createRenderTarget;
            DEVICE.createRenderTarget = () => {
                throw new Error('Injected raster target allocation failure');
            };
            const FAULT_ATLAS = V.createVectorRasterAtlas(MESHES, ASSET, COMPILED_ASSET, { pixelsPerUnit: 3 });
            BEGIN('black');
            FALLBACKS.bakeFailed = FAULT_ATLAS.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
            END();
            DEVICE.createRenderTarget = ORIGINAL_CREATE;
            BEGIN('black');
            const RECOVERED = FAULT_ATLAS.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
            END();
            FAULT_ATLAS.dispose();
            STAGE('cpu-pose-create');
            const CPU_MESHES = new R.MeshRenderer(DEVICE, { poseBackend: 'cpu' }),
                CPU_ASSET = V.createVectorAsset(CPU_MESHES, COMPILED_ASSET),
                CPU_PLAYER = CPU_ASSET.createPlayer({ clip: 'bounce' }),
                CPU_ATLAS = V.createVectorRasterAtlas(CPU_MESHES, CPU_ASSET, COMPILED_ASSET);
            CHECK_GL('after cpu-pose-create');
            STAGE('cpu-pose-atlas');
            CPU_PLAYER.seek(130);
            DEVICE.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0, 0, 0, 1] });
            CPU_MESHES.beginFrame();
            const CPU_POSE_RESULT = CPU_ATLAS.draw(CPU_PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
            CPU_MESHES.flush();
            DEVICE.endFrame();
            CHECK_GL('after cpu-pose-atlas frame');
            const CPU_POSE = {
                backend: CPU_POSE_RESULT.backend,
                drawInstances: CPU_MESHES.poseStats().cpuDrawInstances,
                sampledDraws: CPU_ATLAS.stats.sampledCpuDraws,
            };
            CPU_ATLAS.dispose();
            CPU_PLAYER.dispose();
            CPU_ASSET.dispose();
            CPU_MESHES.dispose();
            CHECK_GL('after cpu-pose-atlas dispose');
            STAGE('sampled-cpu-atlas');
            const SAMPLED_MESHES = new R.MeshRenderer(DEVICE);
            SAMPLED_MESHES.createPoseSource = () => null;
            const SAMPLED_ASSET = V.createVectorAsset(SAMPLED_MESHES, COMPILED_ASSET),
                SAMPLED_PLAYER = SAMPLED_ASSET.createPlayer({ clip: 'bounce' }),
                SAMPLED_ATLAS = V.createVectorRasterAtlas(SAMPLED_MESHES, SAMPLED_ASSET, COMPILED_ASSET);
            delete SAMPLED_MESHES.createPoseSource;
            SAMPLED_PLAYER.seek(130);
            DEVICE.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0, 0, 0, 1] });
            SAMPLED_MESHES.beginFrame();
            const SAMPLED_RESULT = SAMPLED_ATLAS.draw(SAMPLED_PLAYER, {
                projection: PROJECTION,
                matrix: MATRIX(1),
            });
            SAMPLED_MESHES.flush();
            DEVICE.endFrame();
            CHECK_GL('after sampled-cpu-atlas frame');
            const SAMPLED = {
                backend: SAMPLED_RESULT.backend,
                draws: SAMPLED_ATLAS.stats.sampledCpuDraws,
                fullSamples: SAMPLED_PLAYER.poseMetrics.fullSamples,
            };
            SAMPLED_ATLAS.dispose();
            SAMPLED_PLAYER.dispose();
            SAMPLED_ASSET.dispose();
            SAMPLED_MESHES.dispose();
            CHECK_GL('after sampled-cpu-atlas dispose');
            window.__rasterPartial = {
                comparisons: COMPARISONS,
                expressionComparisons: EXPRESSION_COMPARISONS,
                fallbacks: FALLBACKS,
                cpuPose: CPU_POSE,
                sampledCpu: SAMPLED,
            };
            STAGE('sprite-baker-create');
            const SPRITE_BAKER = V.createVectorSpriteAtlas(MESHES, ASSET, COMPILED_ASSET, {
                clip: 'bounce',
                expression: 'happy',
                sampleIntervalMs: 125,
                pixelsPerUnit: 4,
            });
            const SPRITE_COPY = V.createVectorSpriteAtlas(MESHES, ASSET, COMPILED_ASSET, {
                clip: 'bounce',
                expression: 'happy',
                sampleIntervalMs: 125,
                pixelsPerUnit: 4,
            });
            BEGIN('black');
            const SPRITE_BAKE = SPRITE_BAKER.bake();
            END();
            const SPRITE_CACHE = {
                refs: SPRITE_BAKER.stats.refCount,
                sharedTexture: SPRITE_BAKER.texture === SPRITE_COPY.texture,
                frameCount: SPRITE_BAKER.stats.frameCount,
                sampleTimesMs: SPRITE_BAKER.stats.sampleTimesMs,
                sampledDurationMs: SPRITE_BAKER.stats.sampledDurationMs,
                sourceDurationMs: COMPILED_ASSET.metadata.clips.bounce.durationMs,
                backend: SPRITE_BAKE.backend,
            };
            const SPRITE = R.createSpriteAnimation(MESHES, SPRITE_BAKER.texture, SPRITE_BAKER.definition);
            CHECK_GL('after create seed sprite');

            const SPRITE_PLAYER = SPRITE.createPlayer({ clip: 'bounce' }),
                VECTOR_REFERENCE = ASSET.createPlayer({ clip: 'bounce' });
            VECTOR_REFERENCE.setExpression('happy');
            const SAMPLE_TIME = SPRITE_BAKER.stats.sampleTimesMs[1],
                EMPTY_SPRITE_BACKGROUND = BACKGROUND('black');
            BEGIN('black');
            VECTOR_REFERENCE.seek(SAMPLE_TIME);
            VECTOR_REFERENCE.draw({ projection: PROJECTION, matrix: MATRIX(1) });
            const SVG_SAMPLE = END();
            BEGIN('black');
            const SPRITE_MATRIX = MATRIX(1);
            for (let index = 0; index < 4; index++) {
                SPRITE_MATRIX[index] /= 4;
            }
            const SPRITE_SAMPLE = SPRITE_PLAYER.draw({
                timeMs: SAMPLE_TIME,
                projection: PROJECTION,
                matrix: SPRITE_MATRIX,
            });
            const SPRITE_PIXELS = END();
            const SPRITE_COMPARISON = {
                frameIndex: SPRITE_SAMPLE.frameIndex,
                sampleTimeMs: SAMPLE_TIME,
                ...COMPARE(EMPTY_SPRITE_BACKGROUND, SVG_SAMPLE, SPRITE_PIXELS),
            };
            const END_TIME = COMPILED_ASSET.metadata.clips.bounce.durationMs;
            BEGIN('black');
            VECTOR_REFERENCE.seek(END_TIME);
            VECTOR_REFERENCE.draw({ projection: PROJECTION, matrix: MATRIX(1) });
            const SVG_END = END();
            BEGIN('black');
            const SPRITE_END_SAMPLE = SPRITE_PLAYER.draw({
                timeMs: END_TIME,
                projection: PROJECTION,
                matrix: SPRITE_MATRIX,
            });
            const SPRITE_END_PIXELS = END();
            const SPRITE_END_COMPARISON = {
                frameIndex: SPRITE_END_SAMPLE.frameIndex,
                sampleTimeMs: SPRITE_BAKER.stats.sampleTimesMs.at(-1),
                ...COMPARE(EMPTY_SPRITE_BACKGROUND, SVG_END, SPRITE_END_PIXELS),
            };
            const BAKE_COUNT = SPRITE_BAKER.stats.bakeCount;
            BEGIN('black');
            SPRITE_BAKER.bake();
            END();
            SPRITE_CACHE.unchangedAcrossOrdinaryFrame = SPRITE_BAKER.stats.bakeCount === BAKE_COUNT;
            SPRITE_COPY.dispose();
            SPRITE_CACHE.refAfterCopyDispose = SPRITE_BAKER.stats.refCount;
            VECTOR_REFERENCE.dispose();
            CHECK_GL('after seed sprite resource dispose');
            STAGE('sketch-asset-create');
            const SKETCH_ASSET = V.createVectorAsset(MESHES, SKETCH_COMPILED_ASSET);
            CHECK_GL('after sketch-asset-create');
            STAGE('sketch-baker-plan');
            const SKETCH_BAKER = V.createVectorSpriteAtlas(MESHES, SKETCH_ASSET, SKETCH_COMPILED_ASSET, {
                    clip: 'idle',
                    sampleIntervalMs: 300,
                    pixelsPerUnit: 4,
                }),
                SKETCH_PLAYER = SKETCH_ASSET.createPlayer({ clip: 'idle' });
            CHECK_GL('after sketch-baker-plan');
            BEGIN('black');
            const SKETCH_BAKE = SKETCH_BAKER.bake();
            END();
            const EMPTY_SKETCH_BACKGROUND = BACKGROUND('black');
            BEGIN('black');
            SKETCH_PLAYER.seek(450);
            SKETCH_PLAYER.draw({ projection: PROJECTION, matrix: MATRIX_FOR(SKETCH_COMPILED_ASSET.viewBox, 1) });
            const SKETCH_VECTOR = END();
            const SKETCH_COMPARISON = {
                backend: SKETCH_BAKE.backend,
                reason: SKETCH_BAKE.reason,
                texture: SKETCH_BAKER.texture,
                definition: SKETCH_BAKER.definition,
                frameCount: SKETCH_BAKER.stats.frameCount,
                bakeCount: SKETCH_BAKER.stats.bakeCount,
                allocatedBytes: SKETCH_BAKER.stats.allocatedBytes,
                vectorForegroundPixels: COMPARE(EMPTY_SKETCH_BACKGROUND, SKETCH_VECTOR, SKETCH_VECTOR).foregroundPixels,
            };
            SKETCH_PLAYER.dispose();
            SKETCH_BAKER.dispose();
            SKETCH_ASSET.dispose();
            CHECK_GL('after sketch resource dispose');
            STAGE('shader-surface-fallback-create');
            const SURFACES = new R.YarnSurfaceRenderer(DEVICE),
                SHADER_ASSET = V.createVectorAsset(MESHES, SHADER_COMPILED_ASSET, { surfaceRenderer: SURFACES }),
                SHADER_RASTER = V.createVectorRasterAtlas(MESHES, SHADER_ASSET, SHADER_COMPILED_ASSET),
                SHADER_SPRITE = V.createVectorSpriteAtlas(MESHES, SHADER_ASSET, SHADER_COMPILED_ASSET, {
                    clip: Object.keys(SHADER_COMPILED_ASSET.metadata.clips)[0],
                });
            const SHADER_FALLBACK = {
                raster: SHADER_RASTER.stats.reason,
                sprite: SHADER_SPRITE.stats.reason,
                spriteTexture: SHADER_SPRITE.texture,
            };
            SHADER_RASTER.dispose();
            SHADER_SPRITE.dispose();
            SHADER_ASSET.dispose();
            SURFACES.dispose();
            CHECK_GL('after shader-surface-fallback dispose');
            BEGIN('black', 448, 384);
            const RESIZE = ATLAS.draw(PLAYER, {
                projection: [2 / 448, 0, 0, 0, -2 / 384, 0, -1, 1, 1],
                matrix: MATRIX(1),
            });
            MESHES.flush();
            DEVICE.endFrame();
            const BEFORE_RESTORE = ATLAS.stats.bakeCount;
            const LOSE = GL.getExtension('WEBGL_lose_context');
            let restore = { supported: Boolean(LOSE), before: BEFORE_RESTORE, after: null, backend: null };
            if (LOSE) {
                const RESTORED = new Promise((resolve) =>
                    CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
                );
                LOSE.loseContext();
                await new Promise((resolve) => setTimeout(resolve, 30));
                LOSE.restoreContext();
                await Promise.race([
                    RESTORED,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Context restore timed out')), 8000)),
                ]);
                await new Promise((resolve) => setTimeout(resolve, 0));
                BEGIN('black');
                const RESULT = ATLAS.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
                const SPRITE_RESULT = SPRITE_BAKER.bake();
                END();
                BEGIN('black');
                SPRITE_PLAYER.draw({ timeMs: SAMPLE_TIME, projection: PROJECTION, matrix: SPRITE_MATRIX });
                const RESTORED_SPRITE_PIXELS = END();
                restore = {
                    supported: true,
                    before: BEFORE_RESTORE,
                    after: ATLAS.stats.bakeCount,
                    backend: RESULT.backend,
                    spriteBackend: SPRITE_RESULT.backend,
                    spriteBakeCount: SPRITE_BAKER.stats.bakeCount,
                    spritePixels: COMPARE(EMPTY_SPRITE_BACKGROUND, SPRITE_PIXELS, RESTORED_SPRITE_PIXELS),
                };
            }
            SPRITE_PLAYER.dispose();
            SPRITE.dispose();
            SPRITE_BAKER.dispose();
            const DEAD_ASSET = V.createVectorAsset(MESHES, COMPILED_ASSET),
                DEAD_BAKER = V.createVectorSpriteAtlas(MESHES, DEAD_ASSET, COMPILED_ASSET, { clip: 'bounce' });
            DEAD_ASSET.dispose();
            let deletedSourceThrows = false;
            try {
                DEAD_BAKER.bake();
            } catch {
                deletedSourceThrows = true;
            }
            DEAD_BAKER.dispose();
            const ATLAS_STATS = ATLAS.stats;
            ATLAS.dispose();
            const SOURCE_PRESERVED = !ASSET.disposed && ASSET.ownsPlayer(PLAYER);
            PLAYER.dispose();
            ASSET.dispose();
            MESHES.dispose();
            const RESOURCES = {
                renderTargets: DEVICE.stats.renderTargetCount,
                textures: DEVICE.stats.textureCount,
                buffers: DEVICE.stats.bufferCount,
                glError: GL.getError(),
            };
            DEVICE.dispose();
            return {
                comparisons: COMPARISONS,
                expressionComparisons: EXPRESSION_COMPARISONS,
                fallbacks: FALLBACKS,
                recovered: RECOVERED,
                cpuPose: CPU_POSE,
                sampledCpu: SAMPLED,
                spriteCache: SPRITE_CACHE,
                spriteComparison: SPRITE_COMPARISON,
                spriteEndComparison: SPRITE_END_COMPARISON,
                sketchComparison: SKETCH_COMPARISON,
                shaderFallback: SHADER_FALLBACK,
                deletedSourceThrows,
                resize: RESIZE,
                restore: restore,
                atlas: ATLAS_STATS,
                sourcePreserved: SOURCE_PRESERVED,
                resources: RESOURCES,
            };
        },
        {
            rendering: RENDERING_URL,
            vectors: VECTOR_URL,
            assetUrl: ASSET_URL,
            sketchUrl: SKETCH_URL,
            shaderUrl: SHADER_URL,
        },
    );
    await PAGE.close();
    assert.equal(direct.comparisons.length, 9);
    for (const COMPARISON of direct.comparisons) {
        assert.equal(COMPARISON.backend, 'raster', JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.foregroundPixels > 100, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.meanForegroundChannelError <= 5, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.changedFraction <= 0.05, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.spuriousFraction <= 0.01, JSON.stringify(COMPARISON));
    }
    assert.equal(direct.expressionComparisons.length, 5);
    for (const COMPARISON of direct.expressionComparisons) {
        assert.equal(COMPARISON.backend, 'raster', JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.foregroundPixels > 40, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.meanForegroundChannelError <= 5, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.changedFraction <= 0.05, JSON.stringify(COMPARISON));
    }
    assert.ok(direct.expressionComparisons.every((comparison) => comparison.faceVisible !== false));
    assert.equal(direct.expressionComparisons.at(-1).childStillVisible, true);
    for (const REASON of ['opacityChannel', 'baseOpacity', 'globalOpacity', 'atlasLimit', 'bakeFailed']) {
        assert.equal(direct.fallbacks[REASON]?.reason, REASON);
    }
    assert.equal(direct.fallbacks.colorOpacity.reason, 'globalOpacity');
    assert.equal(direct.recovered.backend, 'raster');
    assert.equal(direct.cpuPose.backend, 'raster');
    assert.ok(direct.cpuPose.drawInstances >= 1);
    assert.equal(direct.cpuPose.sampledDraws, 0);
    assert.equal(direct.sampledCpu.backend, 'raster');
    assert.equal(direct.sampledCpu.draws, 1);
    assert.ok(direct.sampledCpu.fullSamples >= 1);
    assert.equal(direct.spriteCache.backend, 'sprite');
    assert.equal(direct.spriteCache.refs, 2);
    assert.equal(direct.spriteCache.sharedTexture, true);
    assert.equal(direct.spriteCache.refAfterCopyDispose, 1);
    assert.equal(direct.spriteCache.sampledDurationMs, direct.spriteCache.sourceDurationMs);
    assert.equal(direct.spriteCache.unchangedAcrossOrdinaryFrame, true);
    assert.equal(direct.spriteCache.frameCount, 4);
    assert.equal(direct.spriteComparison.frameIndex, 1);
    assert.ok(direct.spriteComparison.foregroundPixels > 100);
    assert.ok(direct.spriteComparison.meanForegroundChannelError <= 5, JSON.stringify(direct.spriteComparison));
    assert.equal(direct.spriteEndComparison.frameIndex, direct.spriteCache.frameCount - 1);
    assert.equal(direct.spriteEndComparison.sampleTimeMs, direct.spriteCache.sourceDurationMs);
    assert.ok(direct.spriteEndComparison.foregroundPixels > 100);
    assert.ok(direct.spriteEndComparison.meanForegroundChannelError <= 5, JSON.stringify(direct.spriteEndComparison));
    assert.equal(direct.sketchComparison.backend, 'vector');
    assert.equal(direct.sketchComparison.reason, 'timeDependentMorph');
    assert.equal(direct.sketchComparison.texture, null);
    assert.equal(direct.sketchComparison.definition, null);
    assert.equal(direct.sketchComparison.frameCount, 0);
    assert.equal(direct.sketchComparison.bakeCount, 0);
    assert.equal(direct.sketchComparison.allocatedBytes, 0);
    assert.ok(direct.sketchComparison.vectorForegroundPixels > 100);
    assert.deepEqual(direct.shaderFallback, {
        raster: 'shaderSurfaces',
        sprite: 'shaderSurfaces',
        spriteTexture: null,
    });
    assert.equal(direct.deletedSourceThrows, true);
    assert.equal(direct.resize.backend, 'raster');
    assert.ok(direct.restore.supported);
    assert.equal(direct.restore.backend, 'raster');
    assert.ok(direct.restore.after > direct.restore.before);
    assert.equal(direct.restore.spriteBackend, 'sprite');
    assert.equal(direct.restore.spriteBakeCount, 2);
    assert.ok(direct.restore.spritePixels.foregroundPixels > 100);
    assert.ok(direct.restore.spritePixels.meanForegroundChannelError <= 5);
    assert.equal(direct.sourcePreserved, true);
    assert.equal(direct.resources.renderTargets, 0);
    assert.equal(direct.resources.textures, 0);
    assert.equal(direct.resources.buffers, 0);
    assert.equal(direct.resources.glError, 0);
    assert.deepEqual(ERRORS, []);
    const REPORT = {
        sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceDirty: Boolean(
            execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(),
        ),
        sourceSha256: COMPILED.sourceSha256,
        execution:
            'Local Chromium public dist bundles and built preview; lossy RGBA atlas versus native vector pixels.',
        browser: await BROWSER.version(),
        thresholds: {
            foregroundPixelsMin: 100,
            meanForegroundChannelErrorMax: 5,
            changedFractionOver48Max: 0.05,
            spuriousFractionOver32Max: 0.01,
        },
        preview: preview,
        direct: direct,
        errors: ERRORS,
        consoleMessages: CONSOLE_MESSAGES,
    };
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(resolve(ROOT, 'test-results/raster-comparison.json'), JSON.stringify(REPORT, null, 2));
    console.log(JSON.stringify(REPORT, null, 2));
} catch (error) {
    const STAGE = directPage
        ? await directPage
              .evaluate(() => window.__rasterTestStage ?? 'direct-bootstrap')
              .catch(() => 'direct-page-lost')
        : 'preview';
    const FAILURE = {
        stage: STAGE,
        message: SCRUB(error.message),
        stack: SCRUB(error.stack),
        pageErrors: ERRORS,
        consoleMessages: CONSOLE_MESSAGES,
        preview,
        directScene: direct,
        debug: directPage ? await directPage.evaluate(() => window.__rasterDebug ?? null).catch(() => null) : null,
        partial: directPage ? await directPage.evaluate(() => window.__rasterPartial ?? null).catch(() => null) : null,
    };
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(resolve(ROOT, 'test-results/raster-comparison-failure.json'), JSON.stringify(FAILURE, null, 2));
    error.message = `Raster comparison failed at ${STAGE}: ${FAILURE.message}`;
    error.stack = `Error: ${error.message}\nSee test-results/raster-comparison-failure.json for the scrubbed diagnostic stack.`;
    throw error;
} finally {
    await BROWSER.close();
}

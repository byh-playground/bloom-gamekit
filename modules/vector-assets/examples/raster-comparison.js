import { WebGLDevice, MeshRenderer, createSpriteAnimation } from '/dist/rendering.js';
import { createVectorAsset, createVectorRasterAtlas, createVectorSpriteAtlas } from '/dist/vector-assets.js';
import { createVectorAssetLoader } from '/dist/vector-assets-loader.js';
import { seedScout, seedScoutSvg } from '../seed-scout-raster-comparison.compiled.js';
import { runComparison } from './raster-benchmark.js';
import { createAccumulation, ACCUMULATION_LIMIT } from './raster-accumulation.js';

const BY_ID = (id) => document.getElementById(id);
const CANVAS = BY_ID('canvas');
const STAGE = BY_ID('stage');
const MODE_INPUT = BY_ID('mode');
const PART_INPUT = BY_ID('part-enabled');
const PATH_LABELS = { vector: '벡터', raster: '부위 텍스처', sprite: '전체 스프라이트' };
const SCENE_INPUT = BY_ID('scene');
const COUNT_INPUT = BY_ID('count');
const PIXEL_SIZE_INPUT = BY_ID('pixel-size');
const SPREAD_INPUT = BY_ID('spread');
const SEED_INPUT = BY_ID('seed');
const RESOLUTION_INPUT = BY_ID('resolution');
const QUALITY_INPUT = BY_ID('quality');
const CLIP_INPUT = BY_ID('clip');
const EXPRESSION_INPUT = BY_ID('expression');
const MIXED_INPUT = BY_ID('mixed');
const SAMPLE_INTERVAL_INPUT = BY_ID('sample-interval');
const PLAYBACK_RATE_INPUT = BY_ID('playback-rate');
const TIME_INPUT = BY_ID('time');
const ZOOM_INPUT = BY_ID('zoom');
const PLAY_BUTTON = BY_ID('play');
const STATUS = BY_ID('status');
const FRAME_METRICS = BY_ID('frame-metrics');
const BAKE_METRICS = BY_ID('bake-metrics');
const SPRITE_METRICS = BY_ID('sprite-metrics');
const PREPARATION_METRICS = BY_ID('preparation-metrics');
const PATH_METRICS = BY_ID('path-metrics');
const DEVICE = new WebGLDevice(CANVAS, { alpha: true, antialias: true });
const MESHES = new MeshRenderer(DEVICE, { maxMeshes: 16, maxInstances: 1024 });
let compiled = seedScout;
let asset = createVectorAsset(MESHES, compiled);
let viewBox = asset.viewBox;
const QUALITY_PRESETS = Object.freeze({ low: 2, standard: 4, high: 16 });
const QUALITY_LOADER = createVectorAssetLoader({ maxEntries: 3 });
const QUALITY_CACHE = new Map([['standard', seedScout]]);
const SVG_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(seedScoutSvg)}`;
const SVG_SOURCE_PATH = 'modules/vector-assets/assets/seed-scout-raster-comparison.svg';
const SPRITE_CLIPS = ['transform-repeat', 'bounce', 'idle'];
const SPRITE_EXPRESSIONS = ['neutral', 'happy', 'surprised'];
const ATLAS_BUDGET_BYTES = 192 * 1024 * 1024;
// One part atlas layer plus one sprite layer per clip/expression; every textured draw samples this one array.
const LAYER_COUNT = 1 + SPRITE_CLIPS.length * SPRITE_EXPRESSIONS.length;
let layerArray = null;
let layerArrayResolution = 0;
let timer = createGpuTimer(DEVICE.gl);
let hardware = readHardware();
const STATE = {
    ready: false,
    playing: true,
    autoRender: true,
    timeMs: 0,
    previousFrameMs: null,
    atlas: null,
    atlasResolution: 0,
    atlasReason: null,
    bakeCpuMs: null,
    spriteSets: new Map(),
    spriteBakeCpuMs: null,
    spriteNeedsRebuild: false,
    preparationKey: null,
    preparationGeneration: 0,
    preparation: null,
    frameOrdinal: 0,
    fpsSamples: [],
    fps: null,
    layout: null,
    benchmark: null,
    qualityKey: 'standard',
    qualityGeneration: 0,
    qualityAppliedGeneration: 0,
    qualityLoading: false,
    compileCount: 0,
    compileWallMs: null,
    loadWallMs: null,
    previousImageTexUploadCount: null,
    renderBaseline: { drawCalls: 0, vertices: 0 },
    last: null,
    error: null,
    disposed: false,
    contextLost: false,
    partEnabled: false,
};
const PLAYERS = [];
let nextReadoutMs = 0;
let frameHandle = null;
let benchmarkRunning = false;
const ACCUMULATION = createAccumulation();
let accumulationController = null;

function comparisonModes() {
    return PART_INPUT.checked ? ['vector', 'raster', 'sprite'] : ['vector', 'sprite'];
}

function setPartEnabled(value) {
    if (STATE.partEnabled === Boolean(value)) {
        return;
    }
    stopAccumulation();
    PART_INPUT.checked = Boolean(value);
    STATE.partEnabled = PART_INPUT.checked;
    document.body.dataset.parts = String(PART_INPUT.checked);
    for (const OPTION of MODE_INPUT.options) {
        if (['raster', 'split', 'split3'].includes(OPTION.value)) {
            OPTION.hidden = !PART_INPUT.checked;
            OPTION.disabled = !PART_INPUT.checked;
        }
    }
    if (PART_INPUT.checked && MODE_INPUT.value === 'split2') {
        MODE_INPUT.value = 'split3';
    }
    if (!PART_INPUT.checked && ['raster', 'split', 'split3'].includes(MODE_INPUT.value)) {
        MODE_INPUT.value = 'split2';
    }
    STATE.benchmark = null;
    document.querySelector('.benchmark-results').textContent = 'Enabled paths changed. Run the comparison again.';
    if (PART_INPUT.checked) {
        // Baking requires an active render frame, never an input event.
        STATE.atlasResolution = 0;
    } else {
        ensureAtlas();
    }
    invalidatePreparation(true);
    resetTimer();
    synchronizeTimeControl();
}

function benchmarkConfigKey(config = {}) {
    return JSON.stringify({
        scene: config.scene ?? SCENE_INPUT.value,
        paths: comparisonModes(),
        count: config.count ?? (SCENE_INPUT.value === 'single' ? 1 : Number(COUNT_INPUT.value)),
        pixelSize: config.pixelSize ?? Number(PIXEL_SIZE_INPUT.value),
        spread: config.spread ?? Number(SPREAD_INPUT.value),
        seed: config.seed ?? Number(SEED_INPUT.value),
        clip: CLIP_INPUT.value,
        expression: EXPRESSION_INPUT.value,
        resolution: Number(RESOLUTION_INPUT.value),
        interval: Number(SAMPLE_INTERVAL_INPUT.value),
        playbackRate: Number(PLAYBACK_RATE_INPUT.value),
        mixed: MIXED_INPUT.checked,
        zoom: Number(ZOOM_INPUT.value),
        quality: STATE.qualityKey,
        curveSegments: compiled.compilerOptions.curveSegments,
        strokeArcDivisions: compiled.compilerOptions.strokeArcDivisions,
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
        dpr: devicePixelRatio || 1,
        restores: DEVICE.stats.restores,
    });
}

function showAccumulation() {
    const RESULTS = BY_ID('accumulated-results');
    RESULTS.replaceChildren();
    for (const CONDITION of ACCUMULATION.snapshot().reverse()) {
        const TITLE = document.createElement('p');
        TITLE.textContent = `${CONDITION.label} · ${CONDITION.rounds} balanced rounds · setup wall ${benchmarkValue(CONDITION.setupWallMs)} · initial atlas CPU ${benchmarkValue(CONDITION.initialPreparationCpuMs)} · logical atlas ${CONDITION.atlasAllocatedBytes.toLocaleString()} B · steady image upload / bake Δ0`;
        const TABLE = document.createElement('table');
        const HEAD = TABLE.createTHead().insertRow();
        for (const LABEL of [
            'Path / metric (ms)',
            'n / expected',
            'Mean',
            'p50',
            'p95',
            'p99',
            'Max',
            '>16.7 ms',
            'Sampled time / RAF FPS',
        ]) {
            const CELL = document.createElement('th');
            CELL.textContent = LABEL;
            HEAD.append(CELL);
        }
        const BODY = TABLE.createTBody();
        for (const METHOD of CONDITION.methods) {
            for (const [LABEL, STATS] of [
                ['CPU total', METHOD.cpuTotalMs],
                ['CPU submit', METHOD.submitMs],
                ['GPU', METHOD.gpuMs],
                ['RAF interval', METHOD.frameIntervalMs],
            ]) {
                const ROW = BODY.insertRow();
                const GPU = LABEL === 'GPU';
                const COUNT = GPU
                    ? `${STATS.count}/${STATS.expectedCount} (${(STATS.coverage * 100).toFixed(0)}%)`
                    : String(STATS.count);
                for (const VALUE of [
                    `${PATH_LABELS[METHOD.mode]} · ${LABEL}`,
                    COUNT,
                    ...['mean', 'p50', 'p95', 'p99', 'max'].map((field) => benchmarkValue(STATS[field], '')),
                    STATS.count ? String(STATS.overBudgetCount) : 'not measured',
                    `${(METHOD.measuredDurationMs / 1000).toFixed(2)} s / ${benchmarkValue(METHOD.fps, ' FPS')}`,
                ]) {
                    ROW.insertCell().textContent = VALUE;
                }
            }
            const NOTE = BODY.insertRow().insertCell();
            NOTE.colSpan = 9;
            NOTE.textContent = `${METHOD.mode}: GPU ${METHOD.gpuMs.status} (${METHOD.gpuMs.observedStatuses}); disjoint rounds discarded ${METHOD.gpuMs.invalidRounds}. GPU statistics cover only valid returned samples. Draw calls p50 ${METHOD.drawCalls.p50}.`;
        }
        RESULTS.append(TITLE, TABLE);
    }
    if (!RESULTS.childNodes.length) {
        RESULTS.textContent = 'No accumulated samples. Start to collect balanced full-viewport rounds.';
    }
}

function stopAccumulation() {
    accumulationController?.abort();
}

function resetAccumulation() {
    if (accumulationController) {
        throw new Error('Stop measurement before resetting');
    }
    ACCUMULATION.reset();
    STATE.benchmark = null;
    document.querySelector('.benchmark-results').textContent = 'Measurements cleared.';
    showAccumulation();
    BY_ID('accumulation-status').textContent = 'Cleared. No accumulated samples.';
}

async function startAccumulation({ maxRounds = 100 } = {}) {
    if (benchmarkRunning || STATE.qualityLoading || !STATE.ready) {
        throw new Error('Wait for preparation or the current comparison to finish');
    }
    if (CLIP_INPUT.value !== 'transform-repeat' || MIXED_INPUT.checked) {
        BY_ID('accumulation-status').textContent = 'Select transform-repeat and turn off mixed motion.';
        return ACCUMULATION.snapshot();
    }
    const KEY = benchmarkConfigKey();
    const CONFIG = JSON.parse(KEY);
    const LABEL = `${CONFIG.paths.join(' / ')} · ${CONFIG.scene} N=${CONFIG.count} · ${CONFIG.quality} curve=${CONFIG.curveSegments}/arc=${CONFIG.strokeArcDivisions} · image=${CONFIG.resolution}px step=${CONFIG.interval}ms · ${CONFIG.clip}/${CONFIG.expression} · size=${CONFIG.pixelSize}px spread=${CONFIG.spread}% seed=${CONFIG.seed} zoom=${CONFIG.zoom} · ${CONFIG.canvasWidth}×${CONFIG.canvasHeight} DPR=${CONFIG.dpr} · speed=${CONFIG.playbackRate} · restore=${CONFIG.restores}`;
    const CONTROLLER = new AbortController();
    accumulationController = CONTROLLER;
    benchmarkRunning = true;
    const CONTROLS = [
        ...document.querySelectorAll(
            'header input, header select, header button, #benchmark, #accumulate-start, #accumulate-reset',
        ),
    ];
    const DISABLED = CONTROLS.map((control) => control.disabled);
    CONTROLS.forEach((control) => {
        control.disabled = true;
    });
    BY_ID('accumulate-stop').disabled = false;
    const STATUS_TEXT = BY_ID('accumulation-status');
    const INTERRUPT = () => CONTROLLER.abort();
    const HIDDEN = () => {
        if (document.hidden) {
            INTERRUPT();
        }
    };
    window.addEventListener('resize', INTERRUPT);
    document.addEventListener('visibilitychange', HIDDEN);
    CANVAS.addEventListener('webglcontextlost', INTERRUPT);
    try {
        for (let round = 0; round < maxRounds; round++) {
            const PREVIOUS = ACCUMULATION.snapshot().find((entry) => entry.key === KEY);
            if ((PREVIOUS?.methods[0].measuredFrames ?? 0) >= ACCUMULATION_LIMIT) {
                STATUS_TEXT.textContent = '6,000 exact samples per path reached. Reset or choose another condition.';
                break;
            }
            const ORDER = comparisonModes();
            if ((PREVIOUS?.rounds ?? 0) % 2) {
                ORDER.reverse();
            }
            const RESULT = await runComparison(globalThis.__rasterComparison, {
                orders: [ORDER],
                signal: CONTROLLER.signal,
                shouldCancel: () => benchmarkConfigKey() !== KEY,
                onProgress: ({ mode, phase }) => {
                    STATUS_TEXT.textContent = `${mode}: ${phase} · ${PREVIOUS?.rounds ?? 0} completed rounds. Stop discards only the incomplete round.`;
                },
            });
            if (CONTROLLER.signal.aborted || benchmarkConfigKey() !== KEY) {
                throw new DOMException('Conditions changed', 'AbortError');
            }
            const HISTORY = ACCUMULATION.append(KEY, LABEL, RESULT);
            STATE.benchmark = { key: KEY, methods: HISTORY.find((entry) => entry.key === KEY).methods };
            showAccumulation();
            STATUS_TEXT.textContent = 'Round saved. Initial preparation and 30 warmup frames per path excluded.';
        }
    } catch (error) {
        STATUS_TEXT.textContent =
            error.name === 'AbortError'
                ? 'Stopped. Completed balanced rounds retained; incomplete round discarded. Resume with unchanged settings to append.'
                : `Measurement failed: ${error.message}. Completed rounds retained.`;
        if (error.name !== 'AbortError') {
            throw error;
        }
    } finally {
        window.removeEventListener('resize', INTERRUPT);
        document.removeEventListener('visibilitychange', HIDDEN);
        CANVAS.removeEventListener('webglcontextlost', INTERRUPT);
        CONTROLS.forEach((control, index) => {
            control.disabled = DISABLED[index];
        });
        BY_ID('accumulate-stop').disabled = true;
        accumulationController = null;
        benchmarkRunning = false;
    }
    return ACCUMULATION.snapshot();
}

function benchmarkValue(value, suffix = ' ms') {
    return value === null || value === undefined ? 'unavailable' : `${value.toFixed(2)}${suffix}`;
}

function showBenchmarkResult(result) {
    const RESULTS = document.querySelector('.benchmark-results');
    RESULTS.replaceChildren();
    const TABLE = document.createElement('table');
    const HEAD = document.createElement('thead');
    const HEADER_ROW = document.createElement('tr');
    for (const LABEL of [
        'Path',
        'FPS',
        'Frame interval p50 / p95',
        'CPU total p50 / p95',
        'CPU submit p50 / p95',
        'GPU p50 / p95',
    ]) {
        const CELL = document.createElement('th');
        CELL.textContent = LABEL;
        HEADER_ROW.append(CELL);
    }
    HEAD.append(HEADER_ROW);
    TABLE.append(HEAD);
    const BODY = document.createElement('tbody');
    for (const METHOD of result.methods) {
        const ROW = document.createElement('tr');
        const COVERAGE = `${METHOD.gpuMs.count}/${METHOD.gpuMs.expectedCount ?? METHOD.measuredFrames}`;
        const GPU =
            METHOD.gpuMs.status === 'available'
                ? `${benchmarkValue(METHOD.gpuMs.p50)} / ${benchmarkValue(METHOD.gpuMs.p95)} (${COVERAGE})`
                : `${METHOD.gpuMs.status} (${COVERAGE})`;
        for (const VALUE of [
            PATH_LABELS[METHOD.mode],
            benchmarkValue(METHOD.fps, ' FPS'),
            `${benchmarkValue(METHOD.frameIntervalMs.p50)} / ${benchmarkValue(METHOD.frameIntervalMs.p95)}`,
            `${benchmarkValue(METHOD.cpuTotalMs.p50)} / ${benchmarkValue(METHOD.cpuTotalMs.p95)}`,
            `${benchmarkValue(METHOD.submitMs.p50)} / ${benchmarkValue(METHOD.submitMs.p95)}`,
            GPU,
        ]) {
            const CELL = document.createElement('td');
            CELL.textContent = VALUE;
            ROW.append(CELL);
        }
        BODY.append(ROW);
    }
    TABLE.append(BODY);
    const CAPTION = document.createElement('p');
    const PLACEMENT =
        result.config.scene === 'single'
            ? `zoom ${Number(ZOOM_INPUT.value).toFixed(1)}×`
            : `${result.config.pixelSize} CSS px · spread ${result.config.spread}% · seed ${result.config.seed}`;
    CAPTION.textContent = `Sequential full-viewport comparison · ${result.config.scene} · ${result.config.count} characters · ${PLACEMENT} · ${CLIP_INPUT.value}/${EXPRESSION_INPUT.value}`;
    RESULTS.append(CAPTION, TABLE);
}

async function runBenchmark(options = {}) {
    if (benchmarkRunning) {
        throw new Error('Comparison already running');
    }
    if (CLIP_INPUT.value !== 'transform-repeat' || MIXED_INPUT.checked) {
        document.querySelector('.benchmark-results').textContent =
            'Select transform-repeat and turn off mixed motion for the repeatable sequential comparison.';
        throw new Error('Sequential comparison requires transform-repeat and mixed motion off.');
    }
    benchmarkRunning = true;
    const BUTTON = BY_ID('benchmark');
    const RESULTS = document.querySelector('.benchmark-results');
    const CONTROLS = [
        ...document.querySelectorAll(
            'header input, header select, header button, #benchmark, #accumulate-start, #accumulate-reset',
        ),
    ];
    const DISABLED = CONTROLS.map((control) => control.disabled);
    for (const CONTROL of CONTROLS) {
        CONTROL.disabled = true;
    }
    BUTTON.disabled = true;
    RESULTS.textContent =
        'Measuring sequential full-viewport paths. Atlas preparation is separate from measured frames.';
    try {
        const RESULT = await runComparison(globalThis.__rasterComparison, options);
        STATE.benchmark = { key: benchmarkConfigKey(RESULT.config), methods: RESULT.methods };
        showBenchmarkResult(RESULT);
        return RESULT;
    } catch (error) {
        RESULTS.textContent = `Comparison failed: ${error.message}`;
        throw error;
    } finally {
        CONTROLS.forEach((control, index) => {
            control.disabled = DISABLED[index];
        });
        benchmarkRunning = false;
    }
}

function readHardware() {
    const GL = DEVICE.gl;
    const DEBUG = GL.getExtension('WEBGL_debug_renderer_info');
    return {
        backend: DEVICE.stats.backend ?? 'WebGL 2',
        renderer: GL.getParameter(DEBUG?.UNMASKED_RENDERER_WEBGL ?? GL.RENDERER),
        vendor: GL.getParameter(DEBUG?.UNMASKED_VENDOR_WEBGL ?? GL.VENDOR),
    };
}

function resetTimer() {
    if (!STATE.contextLost && !DEVICE.gl.isContextLost()) {
        timer.clearDisplay();
    }
}

function scheduleNextFrame() {
    if (STATE.autoRender && !STATE.disposed && frameHandle === null) {
        frameHandle = requestAnimationFrame(render);
    }
}

function setAutoRender(enabled) {
    STATE.autoRender = Boolean(enabled);
    STATE.previousFrameMs = null;
    if (!STATE.autoRender && frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }
    scheduleNextFrame();
}

function createGpuTimer(gl) {
    const EXTENSION = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const PENDING = [];
    const COMPLETED = [];
    let lastMs = null;
    let lastLabel = null;
    let condition = EXTENSION ? '대기 중' : '지원하지 않음';
    let discardedCount = 0;
    let activeEntry = null;
    let evictedCount = 0;
    const DISCARD_DISJOINT = () => {
        discardedCount += PENDING.length + COMPLETED.length;
        COMPLETED.length = 0;
        for (const ENTRY of PENDING.splice(0)) {
            gl.deleteQuery(ENTRY.query);
        }
        lastMs = null;
        lastLabel = null;
        condition = '측정 무효 · GPU disjoint';
    };
    return {
        get supported() {
            return Boolean(EXTENSION);
        },
        begin(label) {
            if (!EXTENSION || activeEntry || PENDING.length >= 6) {
                return null;
            }
            if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                DISCARD_DISJOINT();
                return null;
            }
            const QUERY = gl.createQuery();
            if (!QUERY) {
                return null;
            }
            gl.beginQuery(EXTENSION.TIME_ELAPSED_EXT, QUERY);
            activeEntry = { query: QUERY, label };
            return activeEntry;
        },
        end(entry) {
            if (!entry) {
                return;
            }
            gl.endQuery(EXTENSION.TIME_ELAPSED_EXT);
            activeEntry = null;
            PENDING.push(entry);
        },
        poll() {
            if (!EXTENSION) {
                return this.result;
            }
            if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                DISCARD_DISJOINT();
                return this.result;
            }
            while (PENDING.length && gl.getQueryParameter(PENDING[0].query, gl.QUERY_RESULT_AVAILABLE)) {
                const ENTRY = PENDING.shift();
                const GPU_MS = gl.getQueryParameter(ENTRY.query, gl.QUERY_RESULT) / 1e6;
                gl.deleteQuery(ENTRY.query);
                if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                    discardedCount++;
                    DISCARD_DISJOINT();
                    return this.result;
                }
                lastMs = GPU_MS;
                lastLabel = ENTRY.label;
                COMPLETED.push({ ...ENTRY.label, gpuMs: GPU_MS });
                if (COMPLETED.length > 4096) {
                    COMPLETED.shift();
                    evictedCount++;
                }
                condition = '비동기 측정';
            }
            return this.result;
        },
        get result() {
            return {
                ms: lastMs,
                label: lastLabel,
                condition,
                pendingCount: PENDING.length,
                discardedCount,
                evictedCount,
            };
        },
        drain() {
            return COMPLETED.splice(0);
        },
        clearDisplay() {
            lastMs = null;
            lastLabel = null;
            condition = EXTENSION ? '대기 중' : '지원하지 않음';
        },
        reset() {
            if (activeEntry) {
                if (!gl.isContextLost()) {
                    gl.endQuery(EXTENSION.TIME_ELAPSED_EXT);
                }
                gl.deleteQuery(activeEntry.query);
                activeEntry = null;
            }
            for (const ENTRY of PENDING.splice(0)) {
                gl.deleteQuery(ENTRY.query);
            }
            COMPLETED.length = 0;
            lastMs = null;
            lastLabel = null;
            condition = EXTENSION ? '대기 중' : '지원하지 않음';
        },
        dispose() {
            this.reset();
        },
    };
}

function setStatus(message, error = false) {
    STATUS.textContent = message;
    STATUS.classList.toggle('error', error);
}

function invalidatePreparation(force = false) {
    const CONFIG_KEY = JSON.stringify([
        asset.sourceSha256,
        STATE.qualityKey,
        PART_INPUT.checked,
        Number(RESOLUTION_INPUT.value),
        Number(SAMPLE_INTERVAL_INPUT.value),
        DEVICE.stats.restores ?? 0,
    ]);
    if (!force && !STATE.spriteNeedsRebuild && STATE.preparationKey === CONFIG_KEY) {
        return;
    }
    STATE.preparationKey = null;
    STATE.spriteNeedsRebuild = true;
    STATE.ready = false;
    STATE.previousFrameMs = null;
    if (STATE.preparation) {
        STATE.preparation.status = 'stale';
    }
    PREPARATION_METRICS.textContent = 'Atlas preparation pending configuration change';
    scheduleNextFrame();
}

function phaseFor(index, clip) {
    if (index === 0) {
        return 0;
    }
    return Math.floor((((index * 73) % 997) / 997) * asset.metadata.clips[clip].durationMs);
}

function clipFor(index) {
    const CHOSEN = CLIP_INPUT.value;
    return MIXED_INPUT.checked && index % 2 ? (CHOSEN === 'idle' ? 'bounce' : 'idle') : CHOSEN;
}

function synchronizePlayers() {
    const COUNT = SCENE_INPUT.value === 'single' ? 1 : Number(COUNT_INPUT.value);
    while (PLAYERS.length > COUNT) {
        PLAYERS.pop().dispose();
    }
    while (PLAYERS.length < COUNT) {
        const INDEX = PLAYERS.length;
        const CLIP = clipFor(INDEX);
        const PLAYER = asset.createPlayer({ clip: CLIP, startedAtMs: -phaseFor(INDEX, CLIP) });
        PLAYER.setExpression(EXPRESSION_INPUT.value);
        PLAYERS.push(PLAYER);
    }
    for (let index = 0; index < PLAYERS.length; index++) {
        const PLAYER = PLAYERS[index];
        const CLIP = clipFor(index);
        if (PLAYER.currentClip !== CLIP) {
            PLAYER.play(CLIP, -phaseFor(index, CLIP));
        }
        if (PLAYER.currentExpression !== EXPRESSION_INPUT.value) {
            PLAYER.setExpression(EXPRESSION_INPUT.value);
        }
    }
}

function unitHash(index, seed, axis) {
    let value = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b) ^ axis) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967296;
}

function layoutPoints(count) {
    if (SCENE_INPUT.value === 'single') {
        return [[0.5, 0.5]];
    }
    const SEED = Number(SEED_INPUT.value);
    const SPREAD = Number(SPREAD_INPUT.value) / 100;
    const POINTS = new Array(count);
    for (let index = 0; index < count; index++) {
        POINTS[index] = [
            0.5 + (unitHash(index, SEED, 0x243f6a88) - 0.5) * SPREAD,
            0.5 + (unitHash(index, SEED, 0x13198a2e) - 0.5) * SPREAD,
        ];
    }
    return POINTS;
}

function cameraLayout(side, width, height, points) {
    const THREE_WAY = MODE_INPUT.value === 'split3';
    const SPLIT = MODE_INPUT.value === 'split' || MODE_INPUT.value === 'split2';
    const PANEL_WIDTH = THREE_WAY ? width / 3 : SPLIT ? width / 2 : width;
    const PANEL_X = THREE_WAY
        ? side === 'vector'
            ? 0
            : side === 'raster'
              ? width / 3
              : (width * 2) / 3
        : SPLIT && side !== 'vector'
          ? width / 2
          : 0;
    const COUNT = PLAYERS.length;
    const SINGLE = SCENE_INPUT.value === 'single';
    const SIZE = SINGLE
        ? Math.max(1, Math.min(PANEL_WIDTH, height) * 0.68 * Number(ZOOM_INPUT.value))
        : Number(PIXEL_SIZE_INPUT.value);
    const MARGIN_X = Math.min(PANEL_WIDTH / 2, SIZE * 0.75);
    const MARGIN_Y = Math.min(height / 2, SIZE * 0.75);
    const SCALE = SIZE / Math.max(viewBox[2], viewBox[3]);
    const POSITIONS = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        const CENTER_X = PANEL_X + MARGIN_X + (SINGLE ? 0.5 : points[i][0]) * (PANEL_WIDTH - 2 * MARGIN_X);
        const CENTER_Y = MARGIN_Y + (SINGLE ? 0.5 : points[i][1]) * (height - 2 * MARGIN_Y);
        POSITIONS[i] = [
            SCALE,
            0,
            0,
            SCALE,
            CENTER_X - (viewBox[0] + viewBox[2] / 2) * SCALE,
            CENTER_Y - (viewBox[1] + viewBox[3] / 2) * SCALE,
        ];
    }
    return POSITIONS;
}

function synchronizeTimeControl() {
    const CLIP = asset.metadata.clips[CLIP_INPUT.value];
    const DURATION = CLIP.durationMs * (CLIP.loop === 'alternate' ? 2 : 1);
    const DISPLAY_TIME = CLIP.loop === 'once' ? Math.min(DURATION, STATE.timeMs) : STATE.timeMs % DURATION;
    TIME_INPUT.max = String(DURATION);
    TIME_INPUT.value = String(Math.max(0, Math.round(DISPLAY_TIME)));
    BY_ID('time-value').value = `${Math.round(DISPLAY_TIME)} / ${DURATION} ms`;
    BY_ID('zoom-value').value = `${Number(ZOOM_INPUT.value).toFixed(1)}×`;
    PLAY_BUTTON.textContent = STATE.playing ? '일시정지' : '재생';
    PLAY_BUTTON.setAttribute('aria-pressed', String(STATE.playing));
    BY_ID('spread-value').value = `${SPREAD_INPUT.value}%`;
    STAGE.dataset.mode = MODE_INPUT.value;
}

function setScene(value) {
    if (value !== 'single' && value !== 'crowd') {
        throw new RangeError('Scene must be single or crowd');
    }
    SCENE_INPUT.value = value;
    document.body.dataset.scene = value;
    BY_ID('single-tab').setAttribute('aria-selected', String(value === 'single'));
    BY_ID('crowd-tab').setAttribute('aria-selected', String(value === 'crowd'));
    if (!benchmarkRunning) {
        STATE.benchmark = null;
        document.querySelector('.benchmark-results').textContent =
            'Scene changed. Run the sequential comparison again.';
    }
    resetTimer();
    synchronizePlayers();
}

function setPixelSize(value) {
    if (!Number.isFinite(value) || value < 1 || value > 512) {
        throw new RangeError('Character CSS pixel size must be between 1 and 512');
    }
    PIXEL_SIZE_INPUT.value = String(value);
    resetTimer();
}

function setSpread(value) {
    if (!Number.isFinite(value) || value < 25 || value > 100) {
        throw new RangeError('Spread must be between 25 and 100');
    }
    SPREAD_INPUT.value = String(value);
    synchronizeTimeControl();
    resetTimer();
}

function setSeed(value) {
    if (!Number.isSafeInteger(value)) {
        throw new TypeError('Seed must be a safe integer');
    }
    SEED_INPUT.value = String(value);
    resetTimer();
}

async function setQuality(value) {
    if (!Object.hasOwn(QUALITY_PRESETS, value)) {
        throw new RangeError('Quality must be low, standard, or high');
    }
    QUALITY_INPUT.value = value;
    const GENERATION = ++STATE.qualityGeneration;
    if (value === STATE.qualityKey) {
        STATE.qualityLoading = false;
        scheduleNextFrame();
        return STATE.qualityKey;
    }
    STATE.qualityLoading = true;
    STATE.ready = false;
    STATE.previousFrameMs = null;
    setStatus(`Loading ${value} SVG mesh quality…`);
    const STARTED = performance.now();
    let descriptor;
    let compiledNow = false;
    try {
        descriptor = QUALITY_CACHE.get(value);
        if (!descriptor) {
            descriptor = await QUALITY_LOADER.load(SVG_DATA_URL, {
                sourcePath: SVG_SOURCE_PATH,
                expectedSha256: seedScout.sourceSha256,
                curveSegments: QUALITY_PRESETS[value],
                strokeArcDivisions: 2,
            });
            compiledNow = true;
            if (!STATE.disposed && !QUALITY_CACHE.has(value)) {
                QUALITY_CACHE.set(value, descriptor);
                STATE.compileCount++;
            }
        }
        const LOAD_WALL_MS = compiledNow ? performance.now() - STARTED : null;
        if (STATE.disposed || GENERATION !== STATE.qualityGeneration) {
            return null;
        }
        if (STATE.contextLost || DEVICE.state !== 'ready' || DEVICE.gl.isContextLost()) {
            throw new Error('Graphics context is unavailable during mesh quality switch');
        }
        const NEXT_ASSET = createVectorAsset(MESHES, descriptor);
        clearSpriteSets();
        STATE.atlas?.dispose();
        STATE.atlas = null;
        STATE.atlasResolution = 0;
        for (const PLAYER of PLAYERS.splice(0)) {
            PLAYER.dispose();
        }
        asset.dispose();
        asset = NEXT_ASSET;
        compiled = descriptor;
        viewBox = asset.viewBox;
        STATE.qualityKey = value;
        STATE.benchmark = null;
        STATE.qualityAppliedGeneration++;
        STATE.compileWallMs = null;
        STATE.loadWallMs = LOAD_WALL_MS;
        STATE.qualityLoading = false;
        STATE.previousFrameMs = null;
        invalidatePreparation(true);
        setStatus(`${value} mesh quality ready; preparing atlases…`);
        scheduleNextFrame();
        return value;
    } catch (error) {
        if (!STATE.disposed && GENERATION === STATE.qualityGeneration) {
            QUALITY_INPUT.value = STATE.qualityKey;
            STATE.qualityLoading = false;
            STATE.previousFrameMs = null;
            setStatus(`Mesh quality load failed: ${error.message}`, true);
            scheduleNextFrame();
        }
        throw error;
    }
}

/** Layers are all one size, so the array is rebuilt (after its atlases are released) when the resolution changes. */
function ensureLayerArray(resolution) {
    if (layerArray && layerArrayResolution === resolution) {
        return layerArray;
    }
    clearSpriteSets();
    STATE.atlas?.dispose();
    STATE.atlas = null;
    STATE.atlasResolution = 0;
    STATE.spriteNeedsRebuild = true;
    if (layerArray) {
        DEVICE.deleteTexture(layerArray);
    }
    const SIZE = Math.min(DEVICE.maxTextureSize, 2048, 2 ** Math.ceil(Math.log2(resolution * 8)));
    layerArray = DEVICE.createTextureArray(SIZE, SIZE, LAYER_COUNT);
    layerArrayResolution = resolution;
    return layerArray;
}

function ensureAtlas() {
    if (!PART_INPUT.checked) {
        STATE.atlas?.dispose();
        STATE.atlas = null;
        STATE.atlasResolution = 0;
        STATE.atlasReason = 'advancedDisabled';
        STATE.bakeCpuMs = null;
        return;
    }
    const RESOLUTION = Number(RESOLUTION_INPUT.value);
    if (STATE.atlasResolution === RESOLUTION && layerArrayResolution === RESOLUTION) {
        return;
    }
    ensureLayerArray(RESOLUTION);
    STATE.atlas?.dispose();
    STATE.atlas = null;
    STATE.atlasReason = null;
    STATE.atlasResolution = RESOLUTION;
    const STARTED = performance.now();
    let candidate = null;
    try {
        candidate = createVectorRasterAtlas(MESHES, asset, compiled, {
            pixelsPerUnit: RESOLUTION / Math.max(viewBox[2], viewBox[3]),
            padding: 2,
            textureArray: layerArray,
            layer: 0,
        });
        const RESULT = candidate.bake();
        if (RESULT.backend === 'raster') {
            STATE.atlas = candidate;
        } else {
            STATE.atlasReason = RESULT.reason ?? candidate.stats.reason ?? 'atlasUnavailable';
            candidate.dispose();
        }
        STATE.bakeCpuMs = performance.now() - STARTED;
        setStatus(`같은 SVG ${asset.sourceSha256.slice(0, 12)} · 래스터 부위 그림 ${RESOLUTION}px`);
    } catch (error) {
        candidate?.dispose();
        STATE.atlasReason = error.message;
        STATE.bakeCpuMs = performance.now() - STARTED;
        setStatus(`래스터 굽기에 실패해 벡터로 표시합니다: ${error.message}`, true);
    }
}

function releaseSpriteSet(entry) {
    for (const PLAYER of entry.players.values()) {
        PLAYER.dispose();
    }
    entry.resource?.dispose();
    entry.baker?.dispose();
}

function clearSpriteSets() {
    for (const ENTRY of STATE.spriteSets.values()) {
        releaseSpriteSet(ENTRY);
    }
    STATE.spriteSets.clear();
}

function ensureSpriteSets(forceAll = false) {
    const CONFIG_KEY = JSON.stringify([
        asset.sourceSha256,
        STATE.qualityKey,
        PART_INPUT.checked,
        Number(RESOLUTION_INPUT.value),
        Number(SAMPLE_INTERVAL_INPUT.value),
        DEVICE.stats.restores ?? 0,
    ]);
    if (STATE.spriteNeedsRebuild || STATE.preparationKey !== CONFIG_KEY) {
        ensureLayerArray(Number(RESOLUTION_INPUT.value));
        clearSpriteSets();
        STATE.spriteNeedsRebuild = false;
        STATE.preparationKey = CONFIG_KEY;
        const PART_BYTES = STATE.atlas?.stats.allocatedBytes ?? 0;
        STATE.preparation = {
            generation: ++STATE.preparationGeneration,
            status: 'preparing',
            completed: 0,
            total: SPRITE_CLIPS.length * SPRITE_EXPRESSIONS.length,
            estimatedBytes: STATE.atlas?.stats.atlasBytes ?? 0,
            allocatedBytes: PART_BYTES,
            budgetBytes: ATLAS_BUDGET_BYTES,
            partAtlasBytes: PART_BYTES,
            cpuMs: STATE.bakeCpuMs ?? 0,
            entries: [],
        };
    }
    const PREPARATION = STATE.preparation;
    if (PREPARATION.status !== 'preparing') {
        return true;
    }
    const ATTEMPTS = forceAll ? PREPARATION.total - PREPARATION.completed : 1;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const INDEX = PREPARATION.completed;
        const CLIP = SPRITE_CLIPS[Math.floor(INDEX / SPRITE_EXPRESSIONS.length)];
        const EXPRESSION = SPRITE_EXPRESSIONS[INDEX % SPRITE_EXPRESSIONS.length];
        const KEY = spriteKey(CLIP, EXPRESSION);
        const ENTRY_STARTED = performance.now();
        let baker = null;
        let resource = null;
        let reason = null;
        let plannedBytes = 0;
        let bakeCount = 0;
        try {
            baker = createVectorSpriteAtlas(MESHES, asset, compiled, {
                clip: CLIP,
                expression: EXPRESSION,
                sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
                pixelsPerUnit: Number(RESOLUTION_INPUT.value) / Math.max(viewBox[2], viewBox[3]),
                padding: 2,
                textureArray: layerArray,
                layer: 1 + INDEX,
            });
            plannedBytes = baker.stats.atlasBytes;
            PREPARATION.estimatedBytes += plannedBytes;
            if (baker.stats.reason) {
                reason = baker.stats.reason;
            } else if (PREPARATION.allocatedBytes + plannedBytes > ATLAS_BUDGET_BYTES) {
                reason = 'manifestBudgetExceeded';
            } else {
                const RESULT = baker.bake();
                bakeCount = baker.stats.bakeCount;
                if (RESULT.backend === 'sprite' && baker.texture && baker.definition) {
                    resource = createSpriteAnimation(MESHES, baker.texture, baker.definition);
                    PREPARATION.allocatedBytes += baker.stats.allocatedBytes;
                } else {
                    reason = RESULT.reason ?? baker.stats.reason ?? 'spriteUnavailable';
                }
            }
        } catch (error) {
            reason = error.message;
            resource?.dispose();
            resource = null;
        }
        if (!resource) {
            baker?.dispose();
            baker = null;
        }
        const ENTRY = {
            key: KEY,
            clip: CLIP,
            expression: EXPRESSION,
            baker,
            resource,
            reason,
            plannedBytes,
            bakeCount,
            players: new Map(),
            bakeCpuMs: performance.now() - ENTRY_STARTED,
        };
        STATE.spriteSets.set(KEY, ENTRY);
        PREPARATION.entries.push({
            key: KEY,
            clip: CLIP,
            expression: EXPRESSION,
            reason,
            ready: Boolean(resource),
            bakeCount,
            atlasBytes: plannedBytes,
            allocatedBytes: baker?.stats.allocatedBytes ?? 0,
        });
        PREPARATION.completed++;
        PREPARATION.cpuMs += performance.now() - ENTRY_STARTED;
        setStatus(`Sprite preparation ${PREPARATION.completed}/${PREPARATION.total}`);
        PREPARATION_METRICS.textContent = `${PREPARATION.completed}/${PREPARATION.total} prepared · estimated ${PREPARATION.estimatedBytes.toLocaleString()} B · allocated ${PREPARATION.allocatedBytes.toLocaleString()} / ${ATLAS_BUDGET_BYTES.toLocaleString()} B`;
    }
    if (PREPARATION.completed === PREPARATION.total) {
        PREPARATION.status =
            PREPARATION.entries.every((entry) => entry.ready) && (!PART_INPUT.checked || STATE.atlas)
                ? 'ready'
                : 'degraded';
        const FIRST_FAILURE = PREPARATION.entries.find((entry) => !entry.ready);
        setStatus(
            `Atlas preparation ${PREPARATION.completed}/${PREPARATION.total} · ${PREPARATION.status}${FIRST_FAILURE ? ` · ${FIRST_FAILURE.clip}/${FIRST_FAILURE.expression}: ${FIRST_FAILURE.reason}` : ''} · ${PREPARATION.allocatedBytes.toLocaleString()} / ${ATLAS_BUDGET_BYTES.toLocaleString()} B`,
            PREPARATION.status !== 'ready',
        );
    }
    return PREPARATION.status !== 'preparing';
}

function spriteKey(clip, expression = EXPRESSION_INPUT.value) {
    return JSON.stringify([
        asset.sourceSha256,
        STATE.qualityKey,
        clip,
        expression,
        Number(RESOLUTION_INPUT.value),
        Number(SAMPLE_INTERVAL_INPUT.value),
    ]);
}

function qualitySnapshot() {
    const GEOMETRY = compiled.geometry;
    const EXPRESSION_INDICES = GEOMETRY.expressionIndices?.[EXPRESSION_INPUT.value] ?? GEOMETRY.indices;
    const EXPRESSION_BYTES = Object.values(GEOMETRY.expressionIndices ?? {}).reduce(
        (sum, indices) => sum + indices.byteLength,
        0,
    );
    return {
        key: STATE.qualityKey,
        generation: STATE.qualityAppliedGeneration,
        loadStatus: STATE.qualityLoading ? 'loading' : 'ready',
        curveSegments: compiled.compilerOptions.curveSegments,
        strokeArcDivisions: compiled.compilerOptions.strokeArcDivisions,
        compileCount: STATE.compileCount,
        compileWallMs: STATE.compileWallMs,
        loadWallMs: STATE.loadWallMs,
        sourceVertexCount: GEOMETRY.vertices.length / 11,
        expressionTriangles: EXPRESSION_INDICES.length / 3,
        cpuSourceGeometryBytes: GEOMETRY.vertices.byteLength + GEOMETRY.indices.byteLength + EXPRESSION_BYTES,
    };
}

function tradeoffSnapshot(submitMs, gpuMs, atlasStats, spriteSets, deviceStats) {
    const QUALITY = qualitySnapshot();
    const SELECTED_SPRITE = STATE.spriteSets.get(spriteKey(CLIP_INPUT.value, EXPRESSION_INPUT.value));
    const BENCHMARK = STATE.benchmark?.key === benchmarkConfigKey() ? STATE.benchmark : null;
    const PATHS = {};
    for (const SIDE of comparisonModes()) {
        const METHOD = BENCHMARK?.methods.find((entry) => entry.mode === SIDE);
        const FULL_PATH = MODE_INPUT.value === SIDE;
        PATHS[SIDE] = {
            scope: METHOD ? 'sequential' : FULL_PATH ? 'current full viewport' : 'not individually measured',
            uniqueVerticesPerActor:
                SIDE === 'vector'
                    ? QUALITY.sourceVertexCount
                    : SIDE === 'raster'
                      ? atlasStats
                          ? atlasStats.runCount * 4
                          : null
                      : 4,
            geometryTrianglesPerActor:
                SIDE === 'vector'
                    ? QUALITY.expressionTriangles
                    : SIDE === 'raster'
                      ? atlasStats
                          ? atlasStats.runCount * 2
                          : null
                      : 2,
            drawCalls: METHOD?.drawCalls?.p50 ?? null,
            liveDrawCalls: FULL_PATH ? deviceStats.drawCalls - STATE.renderBaseline.drawCalls : null,
            fps: METHOD?.fps ?? null,
            liveFps: FULL_PATH ? STATE.fps : null,
            submitMsP50: METHOD?.submitMs.p50 ?? null,
            submitMsP95: METHOD?.submitMs.p95 ?? null,
            liveSubmitMs: FULL_PATH ? submitMs : null,
            gpuMsP50: METHOD?.gpuMs.p50 ?? null,
            gpuMsP95: METHOD?.gpuMs.p95 ?? null,
            liveGpuMs: FULL_PATH ? gpuMs : null,
            gpuStatus:
                METHOD?.gpuMs.status ??
                (FULL_PATH ? (gpuMs === null ? 'pending or unsupported' : 'available') : 'not individually measured'),
            logicalRgbaBytes:
                SIDE === 'vector'
                    ? 0
                    : SIDE === 'raster'
                      ? (atlasStats?.allocatedBytes ?? null)
                      : (SELECTED_SPRITE?.baker?.stats.allocatedBytes ?? null),
            initialPrepareMs:
                SIDE === 'vector'
                    ? null
                    : SIDE === 'raster'
                      ? STATE.bakeCpuMs
                      : spriteSets.length
                        ? spriteSets.reduce((sum, entry) => sum + entry.bakeCpuMs, 0)
                        : null,
            submittedTriangles: FULL_PATH ? (deviceStats.vertices - STATE.renderBaseline.vertices) / 3 : null,
        };
    }
    return {
        paths: PATHS,
        activeCpuSourceGeometryBytes: QUALITY.cpuSourceGeometryBytes,
        retainedMeshBytes: MESHES.stats().retainedBytes,
        selectedSpriteLogicalRgbaBytes: PATHS.sprite.logicalRgbaBytes,
        partLogicalRgbaBytes: PATHS.raster?.logicalRgbaBytes ?? 0,
        allPreparedAtlasBytes: STATE.preparation?.allocatedBytes ?? null,
        gpuTextureBytesIncludingTargets: deviceStats.gpuTextureBytes,
        imageTexUploadDelta:
            STATE.previousImageTexUploadCount === null
                ? null
                : deviceStats.imageTexUploadCount - STATE.previousImageTexUploadCount,
    };
}

function showTradeoffTable(tradeoff, quality) {
    BY_ID('quality-metrics').textContent =
        `${quality.key} · curve ${quality.curveSegments} / stroke arc ${quality.strokeArcDivisions} · ${quality.loadStatus} · loader compilations ${quality.compileCount} · ${quality.loadWallMs === null ? 'build-precompiled or cached; compile wall time not separately measured' : `first loader call (fetch + SHA + compile) ${quality.loadWallMs.toFixed(1)} ms`}`;
    const FORMAT = (value, suffix = '') =>
        value === null || value === undefined ? 'not measured' : `${Number(value).toLocaleString()}${suffix}`;
    const ROWS = [
        ['Unique geometry vertices / actor', 'uniqueVerticesPerActor'],
        ['Geometry triangles / actor', 'geometryTrianglesPerActor'],
        ['Sequential draw calls p50', 'drawCalls'],
        ['Sequential FPS', 'fps'],
        ['Sequential CPU submit p50 / p95 ms', 'submitMsP50', 'submitMsP95'],
        ['Sequential GPU p50 / p95 ms', 'gpuMsP50', 'gpuMsP95'],
        ['Live full-path draw calls', 'liveDrawCalls'],
        ['Live submitted triangles', 'submittedTriangles'],
        ['Live shared RAF FPS', 'liveFps'],
        ['Live full-path CPU submit ms', 'liveSubmitMs'],
        ['Live full-path GPU ms', 'liveGpuMs'],
        ['Logical RGBA atlas bytes', 'logicalRgbaBytes'],
        ['Initial preparation ms', 'initialPrepareMs'],
    ];
    const TABLE = document.createElement('table');
    const HEADER = TABLE.createTHead().insertRow();
    for (const LABEL of [
        'Measure',
        ...comparisonModes().map(
            (mode) => ({ vector: '벡터', raster: '부위 텍스처', sprite: '전체 스프라이트' })[mode],
        ),
    ]) {
        const CELL = document.createElement('th');
        CELL.textContent = LABEL;
        HEADER.append(CELL);
    }
    const BODY = TABLE.createTBody();
    for (const [LABEL, FIELD, P95] of ROWS) {
        const ROW = BODY.insertRow();
        const TITLE = ROW.insertCell();
        TITLE.textContent = LABEL;
        for (const SIDE of comparisonModes()) {
            const PATH = tradeoff.paths[SIDE];
            const CELL = ROW.insertCell();
            CELL.textContent = P95
                ? `${FORMAT(PATH[FIELD])} / ${FORMAT(PATH[P95])}${FIELD === 'gpuMsP50' ? ` (${PATH.gpuStatus})` : ''}`
                : FORMAT(PATH[FIELD]);
        }
    }
    const NOTE = document.createElement('p');
    NOTE.textContent = `Current full-viewport submitted triangles exclude preparation draws and are measured only in single-path mode. CPU source geometry ${FORMAT(tradeoff.activeCpuSourceGeometryBytes, ' B')} (active descriptor only); MeshRenderer retained ${FORMAT(tradeoff.retainedMeshBytes, ' B')} (aggregate). Logical image bytes are RGBA target/sheet allocation, not physical VRAM or per-actor copies. Sprite initial preparation sums all 9 clip/expression sheets; the sprite image-byte column shows only the selected sheet. All 9 prepared atlases ${FORMAT(tradeoff.allPreparedAtlasBytes, ' B')}; Device GPU texture total ${FORMAT(tradeoff.gpuTextureBytesIncludingTargets, ' B')} already includes render-target color. Current-frame image upload delta ${FORMAT(tradeoff.imageTexUploadDelta)} (shared; not assigned to paths).`;
    BY_ID('tradeoff-table').replaceChildren(TABLE, NOTE);
}

function drawActors(side, positions, projection) {
    let rasterDraws = 0;
    let vectorFallbacks = 0;
    const REASONS = new Set();
    for (let i = 0; i < PLAYERS.length; i++) {
        const OPTIONS = { projection, matrix: positions[i] };
        if (side === 'vector') {
            PLAYERS[i].draw(OPTIONS);
            continue;
        }
        if (!STATE.atlas) {
            PLAYERS[i].draw(OPTIONS);
            vectorFallbacks++;
            REASONS.add('atlas unavailable');
            continue;
        }
        const RESULT = STATE.atlas.draw(PLAYERS[i], OPTIONS);
        if (RESULT.backend === 'raster') {
            rasterDraws++;
        } else {
            vectorFallbacks++;
            REASONS.add(RESULT.reason ?? 'vector fallback');
        }
    }
    return { rasterDraws, vectorFallbacks, reasons: [...REASONS] };
}

function drawSpriteActors(positions, projection) {
    let spriteDraws = 0;
    let vectorFallbacks = 0;
    const REASONS = new Set();
    const PIXELS_PER_UNIT = Number(RESOLUTION_INPUT.value) / Math.max(viewBox[2], viewBox[3]);
    for (let i = 0; i < PLAYERS.length; i++) {
        const VECTOR_PLAYER = PLAYERS[i];
        const ENTRY = STATE.spriteSets.get(spriteKey(VECTOR_PLAYER.currentClip, VECTOR_PLAYER.currentExpression));
        const OPTIONS = { projection, matrix: positions[i] };
        if (!ENTRY?.resource) {
            VECTOR_PLAYER.draw(OPTIONS);
            vectorFallbacks++;
            REASONS.add(ENTRY?.reason ?? 'spriteUnavailable');
            continue;
        }
        let spritePlayer = ENTRY.players.get(i);
        if (!spritePlayer) {
            spritePlayer = ENTRY.resource.createPlayer({
                clip: VECTOR_PLAYER.currentClip,
                startedAtMs: -phaseFor(i, VECTOR_PLAYER.currentClip),
            });
            ENTRY.players.set(i, spritePlayer);
        }
        const MATRIX = positions[i].slice();
        MATRIX[0] /= PIXELS_PER_UNIT;
        MATRIX[1] /= PIXELS_PER_UNIT;
        MATRIX[2] /= PIXELS_PER_UNIT;
        MATRIX[3] /= PIXELS_PER_UNIT;
        spritePlayer.draw({ timeMs: STATE.timeMs, projection, matrix: MATRIX });
        spriteDraws++;
    }
    return { spriteDraws, vectorFallbacks, reasons: [...REASONS] };
}

function writeMetrics(cpuMs, animationMs, submitMs, pathCpuMs, rasterResult, spriteResult, updateReadout = true) {
    const POSES = MESHES.poseStats();
    const MESH_STATS = MESHES.stats();
    const ATLAS_STATS = STATE.atlas?.stats ?? null;
    const GPU = timer.result;
    const DEVICE_STATS = DEVICE.stats;
    const VECTOR_TRIANGLES =
        (compiled.geometry.expressionIndices?.[EXPRESSION_INPUT.value]?.length ?? compiled.geometry.indices.length) / 3;
    const SPRITE_SETS = [...STATE.spriteSets.values()];
    const SPRITE_BYTES = SPRITE_SETS.reduce((sum, entry) => sum + entry.plannedBytes, 0);
    const SPRITE_ALLOCATED_BYTES = SPRITE_SETS.reduce(
        (sum, entry) => sum + (entry.baker?.stats.allocatedBytes ?? 0),
        0,
    );
    const SPRITE_FRAMES = SPRITE_SETS.reduce((sum, entry) => sum + (entry.baker?.stats?.frameCount ?? 0), 0);
    const SPRITE_BAKE_MS = SPRITE_SETS.reduce((sum, entry) => sum + entry.bakeCpuMs, 0);
    const PREPARATION = STATE.preparation;
    const GPU_CURRENT =
        GPU.label?.mode === MODE_INPUT.value &&
        GPU.label?.quality === STATE.qualityKey &&
        GPU.label?.scene === SCENE_INPUT.value &&
        GPU.label?.seed === Number(SEED_INPUT.value) &&
        GPU.label?.pixelSize === Number(PIXEL_SIZE_INPUT.value) &&
        GPU.label?.spread === Number(SPREAD_INPUT.value) &&
        GPU.label?.clip === CLIP_INPUT.value &&
        GPU.label?.expression === EXPRESSION_INPUT.value &&
        GPU.label?.mixed === MIXED_INPUT.checked &&
        GPU.label?.zoom === Number(ZOOM_INPUT.value) &&
        GPU.label?.count === PLAYERS.length &&
        GPU.label?.resolution === Number(RESOLUTION_INPUT.value) &&
        GPU.label?.sampleIntervalMs === Number(SAMPLE_INTERVAL_INPUT.value);
    const GPU_MS = GPU_CURRENT ? GPU.ms : null;
    if (!benchmarkRunning && STATE.benchmark && STATE.benchmark.key !== benchmarkConfigKey()) {
        STATE.benchmark = null;
        document.querySelector('.benchmark-results').textContent =
            'Previous measurement is stale after a scene, display, or graphics change. Run the comparison again.';
    }
    const QUALITY = qualitySnapshot();
    const TRADEOFF = tradeoffSnapshot(submitMs, GPU_MS, ATLAS_STATS, SPRITE_SETS, DEVICE_STATS);
    if (updateReadout) {
        BY_ID('part-label').textContent = rasterResult.vectorFallbacks
            ? `부위 텍스처 · 벡터 대체 ${rasterResult.vectorFallbacks}/${PLAYERS.length}`
            : '부위 텍스처';
        BY_ID('sprite-label').textContent = spriteResult.vectorFallbacks
            ? `전체 스프라이트 · 벡터 대체 ${spriteResult.vectorFallbacks}/${PLAYERS.length}`
            : '전체 스프라이트';
        const GPU_TEXT = GPU_MS === null ? GPU.condition : `${GPU_MS.toFixed(2)} ms (${GPU.condition})`;
        const BENCHMARK_CURRENT = STATE.benchmark?.key === benchmarkConfigKey();
        for (const [SIDE, CARD] of [
            ['vector', BY_ID('vector-card')],
            ['raster', BY_ID('raster-card')],
            ['sprite', BY_ID('sprite-card')],
        ]) {
            if (!comparisonModes().includes(SIDE)) {
                continue;
            }
            const METHOD = BENCHMARK_CURRENT ? STATE.benchmark.methods.find((item) => item.mode === SIDE) : null;
            if (METHOD) {
                CARD.querySelector('.fps').textContent = `Sequential ${benchmarkValue(METHOD.fps, ' FPS')}`;
                CARD.querySelector('.cpu-label').textContent = 'Submit p50 / p95';
                CARD.querySelector('.cpu').textContent =
                    `${benchmarkValue(METHOD.submitMs.p50)} / ${benchmarkValue(METHOD.submitMs.p95)}`;
                const GPU_STATS = METHOD.gpuMs;
                const COVERAGE = `${GPU_STATS.count}/${GPU_STATS.expectedCount ?? METHOD.measuredFrames}`;
                CARD.querySelector('.gpu').textContent =
                    GPU_STATS.status === 'available'
                        ? `${benchmarkValue(GPU_STATS.p50)} / ${benchmarkValue(GPU_STATS.p95)} (${COVERAGE})`
                        : `${GPU_STATS.status} (${COVERAGE})`;
            } else {
                CARD.querySelector('.fps').textContent =
                    STATE.fps === null ? 'Shared RAF unavailable' : `Shared RAF ${STATE.fps.toFixed(1)} FPS`;
                // Split calls can flush the previous path's pending mesh. Only
                // a full-viewport submission includes its own final flush.
                const FULL_PATH = MODE_INPUT.value === SIDE;
                CARD.querySelector('.cpu-label').textContent = FULL_PATH ? 'Live submit (incl. flush)' : 'CPU timing';
                CARD.querySelector('.cpu').textContent = FULL_PATH
                    ? `${submitMs.toFixed(2)} ms`
                    : 'Use sequential comparison';
                CARD.querySelector('.gpu').textContent =
                    GPU_MS !== null && MODE_INPUT.value === SIDE ? `${GPU_MS.toFixed(2)} ms` : 'unavailable';
            }
        }
        FRAME_METRICS.textContent =
            `${MODE_INPUT.value.startsWith('split') ? 'Shared visible paths' : 'Current full viewport'} · ` +
            `CPU 전체 ${cpuMs.toFixed(2)} ms (동작 준비 ${animationMs.toFixed(2)} / 제출 ${submitMs.toFixed(2)} ms) · ` +
            `GPU ${GPU_TEXT} · 드로우 ${DEVICE_STATS.drawCalls}회 · ` +
            `버퍼 업로드 ${DEVICE_STATS.bufferBytes.toLocaleString()} B · 텍스처 업로드 ${DEVICE_STATS.textureBytes.toLocaleString()} B`;
        BAKE_METRICS.textContent = !PART_INPUT.checked
            ? '부위 텍스처 OFF · 준비/보유 이미지 메모리 0 B'
            : ATLAS_STATS
              ? `${RESOLUTION_INPUT.value}px / 큰 축 · 굽기 ${ATLAS_STATS.bakeCpuMs.toFixed(1)} ms (호출 벽시계 ${STATE.bakeCpuMs?.toFixed(1) ?? '—'} ms) · ` +
                `${ATLAS_STATS.runCount}개 부위 그림 · ${ATLAS_STATS.atlasWidth}×${ATLAS_STATS.atlasHeight} · ` +
                `${ATLAS_STATS.atlasBytes.toLocaleString()} B · 굽기 ${ATLAS_STATS.bakeCount}회`
              : `래스터 아틀라스를 사용할 수 없습니다 · 시도 ${STATE.bakeCpuMs?.toFixed(1) ?? '—'} ms`;
        SPRITE_METRICS.textContent =
            `${SAMPLE_INTERVAL_INPUT.value}ms 간격 · ${SPRITE_FRAMES}프레임 · 처음 굽기 ${SPRITE_BAKE_MS.toFixed(1)} ms · ` +
            `아틀라스 ${SPRITE_BYTES.toLocaleString()} B · 프레임 선택 오차 최대 ${SAMPLE_INTERVAL_INPUT.value}ms · ` +
            `스프라이트 ${spriteResult.spriteDraws}개 / 벡터 대체 ${spriteResult.vectorFallbacks}개` +
            (spriteResult.reasons.length ? ` (${spriteResult.reasons.join(', ')})` : '');
        const FAILED_PREPARATIONS = PREPARATION?.entries.filter((entry) => !entry.ready) ?? [];
        PREPARATION_METRICS.textContent = PREPARATION
            ? `${PREPARATION.status} ${PREPARATION.completed}/${PREPARATION.total} · planned ${PREPARATION.estimatedBytes.toLocaleString()} B · allocated ${PREPARATION.allocatedBytes.toLocaleString()} / ${PREPARATION.budgetBytes.toLocaleString()} B · initial CPU ${PREPARATION.cpuMs.toFixed(1)} ms · ${PREPARATION.entries.filter((entry) => entry.ready).length} sprite layers of one texture array${FAILED_PREPARATIONS.length ? ` · ${FAILED_PREPARATIONS.map((entry) => `${entry.clip}/${entry.expression}:${entry.reason}`).join(', ')}` : ''}`
            : 'Preparing atlas manifest…';
        PATH_METRICS.textContent =
            `SVG SHA ${asset.sourceSha256.slice(0, 12)} · 래스터 ${rasterResult.rasterDraws}개 · 벡터 대체 ${rasterResult.vectorFallbacks}개` +
            (rasterResult.reasons.length ? ` (${rasterResult.reasons.join(', ')})` : '') +
            ` · GPU pose ${POSES?.gpuDrawInstances ?? 0}개 · CPU pose ${POSES?.cpuDrawInstances ?? 0}개 · ` +
            `GPU 버퍼 ${DEVICE_STATS.gpuBufferBytes.toLocaleString()} B · GPU 텍스처 ${DEVICE_STATS.gpuTextureBytes.toLocaleString()} B · ` +
            `메시 업로드 ${MESH_STATS.geometryBytesUploaded.toLocaleString()} B · ` +
            `선택 표정 벡터 ${VECTOR_TRIANGLES} 삼각형 / 부위 atlas ${ATLAS_STATS ? ATLAS_STATS.runCount * 2 : 0} 삼각형 · ` +
            `${hardware.backend} · ${hardware.renderer} · ${hardware.vendor}`;
        BY_ID('memory-metrics').textContent =
            `GPU buffers ${DEVICE_STATS.gpuBufferBytes.toLocaleString()} B · textures ${DEVICE_STATS.gpuTextureBytes.toLocaleString()} B (render-target color included) · render targets ${DEVICE_STATS.gpuRenderTargetBytes.toLocaleString()} B (overlap with textures; do not sum)`;
        showTradeoffTable(TRADEOFF, QUALITY);
    }
    STATE.last = {
        comparisonModes: comparisonModes(),
        frame: STATE.frameOrdinal,
        assetId: asset.id,
        sourceSha256: asset.sourceSha256,
        mode: MODE_INPUT.value,
        layout: STATE.layout,
        count: PLAYERS.length,
        clip: CLIP_INPUT.value,
        expression: EXPRESSION_INPUT.value,
        zoom: Number(ZOOM_INPUT.value),
        mixed: MIXED_INPUT.checked,
        phaseSignature: Array.from({ length: Math.min(PLAYERS.length, 8) }, (_, index) =>
            phaseFor(index, clipFor(index)),
        ).join(','),
        quality: QUALITY,
        tradeoff: TRADEOFF,
        resolution: Number(RESOLUTION_INPUT.value),
        timeMs: STATE.timeMs,
        cpuMs,
        animationMs,
        submitMs,
        gpuMs: GPU_MS,
        gpuStatus: GPU.condition,
        gpuDiscardedCount: GPU.discardedCount,
        drawCalls: DEVICE_STATS.drawCalls,
        renderDrawCalls: DEVICE_STATS.drawCalls - STATE.renderBaseline.drawCalls,
        renderTrianglesSubmitted: (DEVICE_STATS.vertices - STATE.renderBaseline.vertices) / 3,
        uploadedBytes: DEVICE_STATS.bufferBytes,
        textureBytes: DEVICE_STATS.textureBytes,
        gpuBufferBytes: DEVICE_STATS.gpuBufferBytes,
        gpuTextureBytes: DEVICE_STATS.gpuTextureBytes,
        gpuRenderTargetBytes: DEVICE_STATS.gpuRenderTargetBytes,
        pathCpuMs,
        fps: STATE.fps,
        imageTexUploadCount: DEVICE_STATS.imageTexUploadCount,
        imageTexUploadBytes: DEVICE_STATS.imageTexUploadBytes,
        atlas: ATLAS_STATS,
        bakeCpuMs: STATE.bakeCpuMs,
        poses: POSES,
        rasterResult,
        spriteResult,
        preparation: PREPARATION
            ? { ...PREPARATION, entries: PREPARATION.entries.map((entry) => ({ ...entry })) }
            : null,
        sprite: {
            sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
            quantizationMaxMs: Number(SAMPLE_INTERVAL_INPUT.value),
            frameCount: SPRITE_FRAMES,
            atlasBytes: SPRITE_BYTES,
            allocatedBytes: SPRITE_ALLOCATED_BYTES,
            bakeCpuMs: SPRITE_BAKE_MS,
            sets: SPRITE_SETS.map((entry) => ({
                key: entry.key,
                clip: entry.clip,
                expression: entry.expression,
                reason: entry.reason,
                ready: Boolean(entry.resource),
                bakeCount: entry.bakeCount,
                atlasBytes: entry.plannedBytes,
                stats: entry.baker?.stats ?? null,
            })),
        },
        playbackRate: Number(PLAYBACK_RATE_INPUT.value),
        sourceTriangles: compiled.geometry.indices.length / 3,
        vectorTriangles: VECTOR_TRIANGLES,
        rasterTriangles: ATLAS_STATS ? ATLAS_STATS.runCount * 2 : 0,
        backend: hardware.backend,
        renderer: hardware.renderer,
        vendor: hardware.vendor,
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
    };
    STATE.previousImageTexUploadCount = DEVICE_STATS.imageTexUploadCount;
}

function render(now, forcePreparation = false, updateReadout = true) {
    frameHandle = null;
    if (STATE.disposed) {
        return;
    }
    if (STATE.contextLost || DEVICE.state === 'lost' || DEVICE.gl.isContextLost()) {
        STATE.contextLost = true;
        STATE.ready = false;
        STATE.previousFrameMs = null;
        setStatus('그래픽 화면을 복구하고 있습니다. 재생 시간은 멈춰 있습니다.');
        scheduleNextFrame();
        return;
    }
    if (STATE.qualityLoading) {
        STATE.ready = false;
        STATE.previousFrameMs = null;
        scheduleNextFrame();
        return;
    }
    if (DEVICE.state !== 'ready') {
        STATE.error = `그래픽 장치 상태: ${DEVICE.state}`;
        STATE.ready = false;
        setStatus(STATE.error, true);
        disposeComparison();
        return;
    }
    try {
        const STARTED = performance.now();
        if (STATE.autoRender) {
            STATE.fpsSamples.push(now);
            while (STATE.fpsSamples.length > 1 && now - STATE.fpsSamples[0] > 1000) {
                STATE.fpsSamples.shift();
            }
            STATE.fps =
                STATE.fpsSamples.length > 1
                    ? ((STATE.fpsSamples.length - 1) * 1000) / (now - STATE.fpsSamples[0])
                    : null;
        }
        timer.poll();
        if (STATE.previousFrameMs !== null && STATE.playing) {
            STATE.timeMs += Math.max(0, Math.min(80, now - STATE.previousFrameMs)) * Number(PLAYBACK_RATE_INPUT.value);
            const CLIP = asset.metadata.clips[CLIP_INPUT.value];
            if (CLIP.loop === 'once' && STATE.timeMs >= CLIP.durationMs) {
                STATE.timeMs = CLIP.durationMs;
                STATE.playing = false;
            }
        }
        STATE.previousFrameMs = now;
        synchronizePlayers();
        synchronizeTimeControl();
        const RECT = CANVAS.getBoundingClientRect();
        const DPR = Math.min(2, devicePixelRatio || 1);
        const CSS_WIDTH = Math.max(1, RECT.width);
        const CSS_HEIGHT = Math.max(1, RECT.height);
        const WIDTH = Math.max(1, Math.round(CSS_WIDTH * DPR));
        const HEIGHT = Math.max(1, Math.round(CSS_HEIGHT * DPR));
        const PROJECTION = [2 / CSS_WIDTH, 0, 0, 0, -2 / CSS_HEIGHT, 0, -1, 1, 1];
        DEVICE.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0, 0, 0, 0] });
        MESHES.beginFrame();
        const MODE = MODE_INPUT.value;
        const POINTS = layoutPoints(PLAYERS.length);
        STATE.layout = {
            scene: SCENE_INPUT.value,
            coordinateSpace: 'normalized-panel',
            seed: Number(SEED_INPUT.value),
            pixelSize: Number(PIXEL_SIZE_INPUT.value),
            spread: Number(SPREAD_INPUT.value),
            positionSignature: (SCENE_INPUT.value === 'single' ? POINTS : layoutPoints(8))
                .map((point) => point.map((value) => value.toFixed(8)).join(','))
                .join(';'),
            positions: POINTS.slice(0, 8).map((point) => point.slice()),
        };
        const PREPARATION_STARTED = performance.now();
        ensureAtlas();
        const PREPARED = ensureSpriteSets(forcePreparation);
        const PREPARATION_MS = performance.now() - PREPARATION_STARTED;
        if (!PREPARED) {
            MESHES.flush();
            DEVICE.endFrame();
            STATE.ready = false;
            STATE.previousFrameMs = null;
            scheduleNextFrame();
            return;
        }
        STATE.renderBaseline = { drawCalls: DEVICE.stats.drawCalls, vertices: DEVICE.stats.vertices };
        const QUERY = timer.begin({
            frame: ++STATE.frameOrdinal,
            mode: MODE_INPUT.value,
            quality: STATE.qualityKey,
            scene: SCENE_INPUT.value,
            seed: Number(SEED_INPUT.value),
            pixelSize: Number(PIXEL_SIZE_INPUT.value),
            spread: Number(SPREAD_INPUT.value),
            clip: CLIP_INPUT.value,
            expression: EXPRESSION_INPUT.value,
            mixed: MIXED_INPUT.checked,
            zoom: Number(ZOOM_INPUT.value),
            count: PLAYERS.length,
            resolution: Number(RESOLUTION_INPUT.value),
            sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
        });
        const ANIMATION_START = performance.now();
        const VECTOR_PLAYERS =
            MODE === 'sprite'
                ? PLAYERS.filter(
                      (player) =>
                          !STATE.spriteSets.get(spriteKey(player.currentClip, player.currentExpression))?.resource,
                  )
                : PLAYERS;
        for (const PLAYER of VECTOR_PLAYERS) {
            PLAYER.seek(STATE.timeMs);
            PLAYER.preparePose();
        }
        if (VECTOR_PLAYERS.length) {
            MESHES.preparePoses();
        }
        const ANIMATION_MS = performance.now() - ANIMATION_START;
        const SUBMIT_START = performance.now();
        const PATH_CPU_MS = { vector: null, raster: null, sprite: null };
        if (MODE === 'vector' || MODE === 'split' || MODE === 'split2' || MODE === 'split3') {
            const PATH_START = performance.now();
            drawActors('vector', cameraLayout('vector', CSS_WIDTH, CSS_HEIGHT, POINTS), PROJECTION);
            PATH_CPU_MS.vector = performance.now() - PATH_START;
        }
        const RASTER_START = performance.now();
        const RASTER_RESULT =
            MODE === 'raster' || MODE === 'split' || MODE === 'split3'
                ? drawActors('raster', cameraLayout('raster', CSS_WIDTH, CSS_HEIGHT, POINTS), PROJECTION)
                : { rasterDraws: 0, vectorFallbacks: 0, reasons: [] };
        if (MODE === 'raster' || MODE === 'split' || MODE === 'split3') {
            PATH_CPU_MS.raster = performance.now() - RASTER_START;
        }
        const SPRITE_START = performance.now();
        const SPRITE_RESULT =
            MODE === 'sprite' || MODE === 'split2' || MODE === 'split3'
                ? drawSpriteActors(cameraLayout('sprite', CSS_WIDTH, CSS_HEIGHT, POINTS), PROJECTION)
                : { spriteDraws: 0, vectorFallbacks: 0, reasons: [] };
        if (MODE === 'sprite' || MODE === 'split2' || MODE === 'split3') {
            PATH_CPU_MS.sprite = performance.now() - SPRITE_START;
        }
        MESHES.flush();
        const SUBMIT_MS = performance.now() - SUBMIT_START;
        timer.end(QUERY);
        DEVICE.endFrame();
        const CPU_MS = Math.max(0, performance.now() - STARTED - PREPARATION_MS);
        if (!STATE.autoRender || now >= nextReadoutMs || !STATE.ready) {
            writeMetrics(CPU_MS, ANIMATION_MS, SUBMIT_MS, PATH_CPU_MS, RASTER_RESULT, SPRITE_RESULT, updateReadout);
            nextReadoutMs = now + 250;
        } else {
            writeMetrics(CPU_MS, ANIMATION_MS, SUBMIT_MS, PATH_CPU_MS, RASTER_RESULT, SPRITE_RESULT, false);
        }
        STATE.ready = true;
    } catch (error) {
        if (DEVICE.gl.isContextLost() || DEVICE.state === 'lost') {
            STATE.contextLost = true;
            STATE.ready = false;
            STATE.previousFrameMs = null;
            scheduleNextFrame();
            return;
        }
        STATE.ready = false;
        STATE.error = error.message;
        setStatus(error.message, true);
        console.error(error);
        disposeComparison();
    }
    scheduleNextFrame();
}

function disposeComparison() {
    stopAccumulation();
    if (STATE.disposed) {
        return false;
    }
    STATE.disposed = true;
    STATE.qualityGeneration++;
    QUALITY_LOADER.dispose();
    QUALITY_CACHE.clear();
    if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }
    if (!STATE.contextLost && !DEVICE.gl.isContextLost()) {
        timer.dispose();
    }
    for (const PLAYER of PLAYERS.splice(0)) {
        PLAYER.dispose();
    }
    clearSpriteSets();
    STATE.atlas?.dispose();
    STATE.atlas = null;
    asset.dispose();
    MESHES.dispose();
    DEVICE.dispose();
    return true;
}

CANVAS.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    STATE.contextLost = true;
    STATE.ready = false;
    STATE.previousFrameMs = null;
    if (STATE.preparation) {
        STATE.preparation.status = 'stale';
    }
    setStatus('그래픽 화면을 복구하고 있습니다. 재생 시간은 멈춰 있습니다.');
});
CANVAS.addEventListener('webglcontextrestored', () => {
    setTimeout(() => {
        if (STATE.disposed || DEVICE.gl.isContextLost()) {
            return;
        }
        if (DEVICE.state !== 'ready' || MESHES.state !== 'ready') {
            STATE.error = '그래픽 화면을 복구하지 못했습니다.';
            STATE.ready = false;
            setStatus(STATE.error, true);
            disposeComparison();
            return;
        }
        timer = createGpuTimer(DEVICE.gl);
        hardware = readHardware();
        STATE.contextLost = false;
        STATE.previousFrameMs = null;
        STATE.atlasResolution = 0;
        invalidatePreparation(true);
        setStatus('그래픽 화면을 복구했습니다.');
        scheduleNextFrame();
    }, 0);
});

MODE_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizeTimeControl();
});
BY_ID('single-tab').addEventListener('click', () => setScene('single'));
BY_ID('crowd-tab').addEventListener('click', () => setScene('crowd'));
PIXEL_SIZE_INPUT.addEventListener('change', resetTimer);
SPREAD_INPUT.addEventListener('input', () => setSpread(Number(SPREAD_INPUT.value)));
SEED_INPUT.addEventListener('change', () => setSeed(Number(SEED_INPUT.value)));
COUNT_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
CLIP_INPUT.addEventListener('change', () => {
    resetTimer();
    STATE.timeMs = 0;
    synchronizePlayers();
    synchronizeTimeControl();
});
EXPRESSION_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
MIXED_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
RESOLUTION_INPUT.addEventListener('change', () => {
    resetTimer();
    invalidatePreparation();
});
QUALITY_INPUT.addEventListener('change', () => {
    setQuality(QUALITY_INPUT.value).catch(console.error);
});
SAMPLE_INTERVAL_INPUT.addEventListener('change', () => {
    resetTimer();
    invalidatePreparation();
});
PLAYBACK_RATE_INPUT.addEventListener('change', resetTimer);
ZOOM_INPUT.addEventListener('input', () => {
    resetTimer();
    synchronizeTimeControl();
});
TIME_INPUT.addEventListener('input', () => {
    resetTimer();
    STATE.timeMs = Number(TIME_INPUT.value);
    STATE.playing = false;
    synchronizeTimeControl();
});
PLAY_BUTTON.addEventListener('click', () => {
    resetTimer();
    const CLIP = asset.metadata.clips[CLIP_INPUT.value];
    if (!STATE.playing && CLIP.loop === 'once' && STATE.timeMs >= CLIP.durationMs) {
        STATE.timeMs = 0;
    }
    STATE.playing = !STATE.playing;
    synchronizeTimeControl();
});
BY_ID('benchmark').addEventListener('click', () => {
    runBenchmark({
        scene: SCENE_INPUT.value,
        count: SCENE_INPUT.value === 'single' ? 1 : Number(COUNT_INPUT.value),
        pixelSize: Number(PIXEL_SIZE_INPUT.value),
        spread: Number(SPREAD_INPUT.value),
        seed: Number(SEED_INPUT.value),
    }).catch(console.error);
});
BY_ID('accumulate-start').addEventListener('click', () => {
    startAccumulation().catch(console.error);
});
BY_ID('accumulate-stop').addEventListener('click', stopAccumulation);
BY_ID('accumulate-reset').addEventListener('click', resetAccumulation);
PART_INPUT.addEventListener('change', () => setPartEnabled(PART_INPUT.checked));
document.querySelector('header').addEventListener('change', (event) => {
    if (
        !benchmarkRunning &&
        [
            'count',
            'pixel-size',
            'spread',
            'seed',
            'clip',
            'expression',
            'resolution',
            'sample-interval',
            'mixed',
            'zoom',
        ].includes(event.target.id)
    ) {
        STATE.benchmark = null;
        document.querySelector('.benchmark-results').textContent =
            'Settings changed. Run the sequential comparison again.';
    }
});
window.addEventListener('pagehide', disposeComparison, { once: true });

globalThis.__rasterComparison = {
    get quality() {
        return qualitySnapshot();
    },
    get gpuTimerSupported() {
        return timer.supported;
    },
    get benchmarkState() {
        return {
            scene: SCENE_INPUT.value,
            mode: MODE_INPUT.value,
            count: Number(COUNT_INPUT.value),
            pixelSize: Number(PIXEL_SIZE_INPUT.value),
            spread: Number(SPREAD_INPUT.value),
            seed: Number(SEED_INPUT.value),
            timeMs: STATE.timeMs,
            playing: STATE.playing,
            autoRender: STATE.autoRender,
        };
    },
    graphicsStatus() {
        return {
            state: DEVICE.state,
            contextLost: STATE.contextLost || DEVICE.gl.isContextLost(),
            glError: DEVICE.gl.getError(),
            error: STATE.error,
        };
    },
    restoreBenchmarkState(state) {
        if (STATE.disposed) {
            return;
        }
        setAutoRender(false);
        setScene(state.scene);
        MODE_INPUT.value =
            !PART_INPUT.checked && ['raster', 'split', 'split3'].includes(state.mode) ? 'split2' : state.mode;
        COUNT_INPUT.value = String(state.count);
        setPixelSize(state.pixelSize);
        setSpread(state.spread);
        setSeed(state.seed);
        synchronizePlayers();
        STATE.timeMs = state.timeMs;
        STATE.playing = state.playing;
        synchronizeTimeControl();
        setAutoRender(state.autoRender);
    },
    get ready() {
        return STATE.ready;
    },
    get error() {
        return STATE.error;
    },
    get snapshot() {
        return STATE.last;
    },
    get preparation() {
        return STATE.preparation
            ? { ...STATE.preparation, entries: STATE.preparation.entries.map((entry) => ({ ...entry })) }
            : null;
    },
    dispose: disposeComparison,
    setQuality,
    capturePixels() {
        if (STATE.contextLost || DEVICE.gl.isContextLost() || !STATE.ready) {
            throw new Error('Graphics frame is unavailable');
        }
        const GL = DEVICE.gl;
        const PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
        GL.readPixels(0, 0, CANVAS.width, CANVAS.height, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
        const ERROR = GL.getError();
        if (ERROR !== GL.NO_ERROR) {
            throw new Error(`Pixel capture failed: WebGL ${ERROR}`);
        }
        return { width: CANVAS.width, height: CANVAS.height, pixels: PIXELS };
    },
    setAutoRender,
    get comparisonModes() {
        return comparisonModes();
    },
    setPartEnabled,
    pollGpuTimers() {
        return STATE.contextLost || DEVICE.gl.isContextLost() ? timer.result : timer.poll();
    },
    drainGpuSamples() {
        return timer.drain();
    },
    runBenchmark,
    startAccumulation,
    stopAccumulation,
    resetAccumulation,
    get accumulation() {
        return { running: Boolean(accumulationController), history: ACCUMULATION.snapshot() };
    },
    renderOnce({ timeMs, updateReadout = true } = {}) {
        if (STATE.qualityLoading) {
            throw new Error('Mesh quality is still loading');
        }
        setAutoRender(false);
        if (timeMs !== undefined) {
            if (!Number.isFinite(timeMs)) {
                throw new TypeError('Finite timeMs required');
            }
            STATE.timeMs = timeMs;
            STATE.playing = false;
        }
        render(performance.now(), true, updateReadout);
        if (STATE.contextLost) {
            throw new Error('Graphics context is temporarily unavailable');
        }
        if (STATE.error) {
            throw new Error(STATE.error);
        }
        return STATE.last;
    },
    setMode(value) {
        if (!PART_INPUT.checked && ['raster', 'split', 'split3'].includes(value)) {
            throw new Error('Enable advanced part textures before selecting this view');
        }
        MODE_INPUT.value = value;
        MODE_INPUT.dispatchEvent(new Event('change'));
    },
    setScene,
    setPixelSize,
    setSpread,
    setSeed,
    setCount(value) {
        COUNT_INPUT.value = String(value);
        COUNT_INPUT.dispatchEvent(new Event('change'));
    },
    setTime(value) {
        TIME_INPUT.value = String(value);
        TIME_INPUT.dispatchEvent(new Event('input'));
    },
    setClip(value) {
        CLIP_INPUT.value = value;
        CLIP_INPUT.dispatchEvent(new Event('change'));
    },
    setExpression(value) {
        EXPRESSION_INPUT.value = value;
        EXPRESSION_INPUT.dispatchEvent(new Event('change'));
    },
    setResolution(value) {
        RESOLUTION_INPUT.value = String(value);
        RESOLUTION_INPUT.dispatchEvent(new Event('change'));
    },
    setSampleInterval(value) {
        SAMPLE_INTERVAL_INPUT.value = String(value);
        SAMPLE_INTERVAL_INPUT.dispatchEvent(new Event('change'));
    },
    setPlaybackRate(value) {
        PLAYBACK_RATE_INPUT.value = String(value);
        PLAYBACK_RATE_INPUT.dispatchEvent(new Event('change'));
    },
    setMixed(value) {
        MIXED_INPUT.checked = Boolean(value);
        MIXED_INPUT.dispatchEvent(new Event('change'));
    },
    setZoom(value) {
        ZOOM_INPUT.value = String(value);
        ZOOM_INPUT.dispatchEvent(new Event('input'));
    },
};
scheduleNextFrame();

const MODES = ['vector', 'raster', 'sprite'];
const DISPLAY_STEP_MS = 1000 / 60;

const NEXT_FRAME = () => new Promise((resolve) => requestAnimationFrame(resolve));

function percentile(values, fraction) {
    if (!values.length) {
        return null;
    }
    const SORTED = [...values].sort((left, right) => left - right);
    const POSITION = (SORTED.length - 1) * fraction;
    const LOWER = Math.floor(POSITION);
    const UPPER = Math.ceil(POSITION);
    return SORTED[LOWER] + (SORTED[UPPER] - SORTED[LOWER]) * (POSITION - LOWER);
}

function summary(values, includeMean = false) {
    const RESULT = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
    if (includeMean) {
        RESULT.mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }
    return RESULT;
}

function validateOrders(orders) {
    if (!Array.isArray(orders) || !orders.length) {
        throw new TypeError('At least one benchmark mode order is required');
    }
    for (const ORDER of orders) {
        if (!Array.isArray(ORDER) || ORDER.length !== MODES.length || new Set(ORDER).size !== MODES.length) {
            throw new TypeError('Each benchmark order must contain vector, raster, and sprite once');
        }
        if (ORDER.some((mode) => !MODES.includes(mode))) {
            throw new TypeError('Unknown benchmark mode');
        }
    }
}

function assertGraphics(bridge) {
    const STATUS = bridge.graphicsStatus();
    if (STATUS.contextLost || STATUS.state !== 'ready' || STATUS.error || STATUS.glError !== 0) {
        throw new Error(`Graphics unavailable during benchmark: ${JSON.stringify(STATUS)}`);
    }
}

function assertPrepared(frame, baseline, mode, count, sourceTimeMs) {
    const PREPARATION = frame.preparation;
    if (!PREPARATION || PREPARATION.status !== 'ready' || PREPARATION.generation !== baseline.generation) {
        throw new Error(`Prepared atlas changed during ${mode} benchmark`);
    }
    if (
        PREPARATION.entries.length !== baseline.bakeCounts.length ||
        PREPARATION.entries.some((entry, index) => entry.bakeCount !== baseline.bakeCounts[index])
    ) {
        throw new Error(`Atlas rebaked during ${mode} benchmark`);
    }
    if (
        frame.imageTexUploadCount !== baseline.imageTexUploadCount ||
        frame.imageTexUploadBytes !== baseline.imageTexUploadBytes
    ) {
        throw new Error(`Image texture uploaded during ${mode} benchmark`);
    }
    if (frame.mode !== mode || frame.count !== count) {
        throw new Error(`Benchmark scene changed during ${mode} sampling`);
    }
    if (!Number.isSafeInteger(frame.renderDrawCalls) || frame.renderDrawCalls < 0) {
        throw new Error('Post-preparation render draw-call count is unavailable');
    }
    if (!frame.atlas?.baked || frame.atlas.bakeCount !== baseline.partBakeCount) {
        throw new Error(`Part atlas rebaked during ${mode} benchmark`);
    }
    if (
        frame.sourceSha256 !== baseline.sourceSha256 ||
        frame.quality?.key !== baseline.qualityKey ||
        frame.quality?.curveSegments !== baseline.curveSegments ||
        frame.quality?.strokeArcDivisions !== baseline.strokeArcDivisions ||
        frame.clip !== baseline.clip ||
        frame.expression !== baseline.expression ||
        frame.canvasWidth !== baseline.canvasWidth ||
        frame.canvasHeight !== baseline.canvasHeight ||
        frame.layout?.scene !== baseline.scene ||
        frame.layout?.seed !== baseline.seed ||
        frame.layout?.pixelSize !== baseline.pixelSize ||
        frame.layout?.spread !== baseline.spread ||
        frame.layout?.positionSignature !== baseline.positionSignature ||
        Math.abs(frame.timeMs - sourceTimeMs) > 1e-6
    ) {
        throw new Error(`Benchmark source, layout, viewport, or display time changed during ${mode} sampling`);
    }
    if (mode === 'vector' && frame.poses?.gpuDrawInstances !== count) {
        throw new Error(`Vector GPU pose backend unavailable: ${frame.poses?.gpuDrawInstances ?? 'missing'}/${count}`);
    }
    if (mode === 'raster' && (frame.rasterResult?.rasterDraws !== count || frame.rasterResult.vectorFallbacks)) {
        throw new Error(
            `Raster backend unavailable for ${frame.clip}: ${frame.rasterResult?.reasons?.join(', ') || 'missing draws'}`,
        );
    }
    if (mode === 'sprite' && (frame.spriteResult?.spriteDraws !== count || frame.spriteResult.vectorFallbacks)) {
        throw new Error(
            `Sprite backend unavailable for ${frame.clip}: ${frame.spriteResult?.reasons?.join(', ') || 'missing draws'}`,
        );
    }
}

/** Measures each full-viewport backend in separate, identically timed rAF sequences. */
export async function runComparison(
    bridge,
    { scene, count, pixelSize, spread, seed, warmupFrames = 30, sampleFrames = 60, orders = [MODES] } = {},
) {
    for (const NAME of [
        'setAutoRender',
        'setScene',
        'setMode',
        'setCount',
        'setPixelSize',
        'setSpread',
        'setSeed',
        'renderOnce',
        'pollGpuTimers',
        'drainGpuSamples',
        'graphicsStatus',
        'restoreBenchmarkState',
    ]) {
        if (typeof bridge?.[NAME] !== 'function') {
            throw new TypeError(`Benchmark bridge requires ${NAME}()`);
        }
    }
    if (!Number.isSafeInteger(warmupFrames) || warmupFrames < 30) {
        throw new RangeError('Benchmark requires at least 30 warmup frames');
    }
    if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 60) {
        throw new RangeError('Benchmark requires at least 60 measured frames');
    }
    validateOrders(orders);
    const PREVIOUS = bridge.benchmarkState;
    if (!PREVIOUS) {
        throw new TypeError('Benchmark bridge must expose benchmarkState');
    }
    const CONFIG = {
        scene: scene ?? PREVIOUS.scene,
        count: count ?? PREVIOUS.count,
        pixelSize: pixelSize ?? PREVIOUS.pixelSize,
        spread: spread ?? PREVIOUS.spread,
        seed: seed ?? PREVIOUS.seed,
        warmupFrames,
        sampleFrames,
        orders: orders.map((order) => [...order]),
    };
    if (CONFIG.scene === 'single') {
        CONFIG.count = 1;
    }
    const SCOPES = new Map();
    const COLLECT_GPU = () => {
        const STATUS = bridge.pollGpuTimers();
        for (const SAMPLE of bridge.drainGpuSamples()) {
            const SCOPE = SCOPES.get(SAMPLE.frame);
            if (!SCOPE) {
                continue;
            }
            if (SAMPLE.mode !== SCOPE.mode || SAMPLE.count !== CONFIG.count) {
                throw new Error(`GPU timer label does not match frame ${SAMPLE.frame}`);
            }
            if (!Number.isFinite(SAMPLE.gpuMs) || SAMPLE.gpuMs < 0) {
                throw new Error('Invalid asynchronous GPU timer sample');
            }
            SCOPE.raw.gpuSamples.push({ ...SAMPLE, ms: SAMPLE.gpuMs });
        }
        return STATUS;
    };
    try {
        bridge.setAutoRender(false);
        bridge.setScene(CONFIG.scene);
        bridge.setCount(CONFIG.count);
        bridge.setPixelSize(CONFIG.pixelSize);
        bridge.setSpread(CONFIG.spread);
        bridge.setSeed(CONFIG.seed);
        assertGraphics(bridge);
        const SETUP_STARTED = performance.now();
        bridge.drainGpuSamples();
        const INITIAL = bridge.renderOnce({ timeMs: 500 });
        assertGraphics(bridge);
        if (INITIAL.preparation?.status !== 'ready' || INITIAL.preparation.completed !== INITIAL.preparation.total) {
            throw new Error(`Initial atlas manifest is not ready: ${INITIAL.preparation?.status ?? 'missing'}`);
        }
        if (INITIAL.preparation.entries.some((entry) => !entry.ready || entry.bakeCount !== 1)) {
            throw new Error('Initial atlas manifest contains an unavailable or repeatedly baked entry');
        }
        for (const VALUE of [INITIAL.imageTexUploadCount, INITIAL.imageTexUploadBytes]) {
            if (!Number.isSafeInteger(VALUE) || VALUE < 0) {
                throw new Error('Cumulative image upload counters are unavailable');
            }
        }
        const BASELINE = {
            generation: INITIAL.preparation.generation,
            partBakeCount: INITIAL.atlas?.bakeCount,
            bakeCounts: INITIAL.preparation.entries.map((entry) => entry.bakeCount),
            imageTexUploadCount: INITIAL.imageTexUploadCount,
            imageTexUploadBytes: INITIAL.imageTexUploadBytes,
            sourceSha256: INITIAL.sourceSha256,
            qualityKey: INITIAL.quality?.key,
            curveSegments: INITIAL.quality?.curveSegments,
            strokeArcDivisions: INITIAL.quality?.strokeArcDivisions,
            clip: INITIAL.clip,
            expression: INITIAL.expression,
            canvasWidth: INITIAL.canvasWidth,
            canvasHeight: INITIAL.canvasHeight,
            scene: INITIAL.layout?.scene,
            seed: INITIAL.layout?.seed,
            pixelSize: INITIAL.layout?.pixelSize,
            spread: INITIAL.layout?.spread,
            positionSignature: INITIAL.layout?.positionSignature,
        };
        const SETUP = {
            wallMs: performance.now() - SETUP_STARTED,
            snapshot: INITIAL,
            gpuBufferBytes: INITIAL.gpuBufferBytes ?? null,
            gpuTextureBytes: INITIAL.gpuTextureBytes ?? null,
            atlasAllocatedBytes: INITIAL.preparation.allocatedBytes,
        };
        const TIMER_START = COLLECT_GPU();
        const ROUNDS = [];
        for (const ORDER of CONFIG.orders) {
            const METHODS = [];
            for (const MODE of ORDER) {
                bridge.setMode(MODE);
                let previousTimestamp = null;
                const RAW = { frameIntervalsMs: [], cpuTotalMs: [], submitMs: [], frames: [], gpuSamples: [] };
                const SCOPE = { mode: MODE, raw: RAW };
                for (let index = 0; index < warmupFrames + sampleFrames; index++) {
                    const TIMESTAMP = await NEXT_FRAME();
                    assertGraphics(bridge);
                    const DISPLAY_TIME_MS = 500 + (index - warmupFrames) * DISPLAY_STEP_MS;
                    const FRAME = bridge.renderOnce({ timeMs: DISPLAY_TIME_MS, updateReadout: false });
                    assertGraphics(bridge);
                    assertPrepared(FRAME, BASELINE, MODE, CONFIG.count, DISPLAY_TIME_MS);
                    if (index >= warmupFrames) {
                        const INTERVAL_MS = TIMESTAMP - previousTimestamp;
                        if (!(INTERVAL_MS > 0)) {
                            throw new Error('Nonpositive requestAnimationFrame interval');
                        }
                        RAW.frameIntervalsMs.push(INTERVAL_MS);
                        RAW.cpuTotalMs.push(FRAME.cpuMs);
                        RAW.submitMs.push(FRAME.submitMs);
                        RAW.frames.push({
                            frame: FRAME.frame,
                            sourceTimeMs: DISPLAY_TIME_MS,
                            rafTimestampMs: TIMESTAMP,
                            intervalMs: INTERVAL_MS,
                            cpuTotalMs: FRAME.cpuMs,
                            animationMs: FRAME.animationMs,
                            submitMs: FRAME.submitMs,
                            uploadedBytes: FRAME.uploadedBytes,
                            textureBytes: FRAME.textureBytes,
                            imageTexUploadCount: FRAME.imageTexUploadCount,
                            imageTexUploadBytes: FRAME.imageTexUploadBytes,
                            gpuBufferBytes: FRAME.gpuBufferBytes,
                            gpuTextureBytes: FRAME.gpuTextureBytes,
                            bakeCounts: FRAME.preparation.entries.map((entry) => entry.bakeCount),
                            preparationGeneration: FRAME.preparation.generation,
                            drawCalls: FRAME.renderDrawCalls,
                        });
                        SCOPES.set(FRAME.frame, SCOPE);
                    }
                    COLLECT_GPU();
                    previousTimestamp = TIMESTAMP;
                }
                METHODS.push({ mode: MODE, warmupFrames, measuredFrames: sampleFrames, raw: RAW });
            }
            ROUNDS.push({ order: [...ORDER], methods: METHODS });
        }
        let timerEnd = COLLECT_GPU();
        if (bridge.gpuTimerSupported && timerEnd.pendingCount) {
            for (let attempt = 0; attempt < 120 && timerEnd.pendingCount; attempt++) {
                await NEXT_FRAME();
                assertGraphics(bridge);
                timerEnd = COLLECT_GPU();
            }
        }
        const DISCARDED_COUNT = (timerEnd?.discardedCount ?? 0) - (TIMER_START?.discardedCount ?? 0);
        for (const ROUND of ROUNDS) {
            for (const METHOD of ROUND.methods) {
                const RAW = METHOD.raw;
                const INTERVAL = summary(RAW.frameIntervalsMs, true);
                const GPU_VALUES = RAW.gpuSamples.map((sample) => sample.ms);
                const GPU_STATUS = !bridge.gpuTimerSupported
                    ? 'unsupported'
                    : DISCARDED_COUNT > 0
                      ? 'disjoint'
                      : GPU_VALUES.length === sampleFrames
                        ? 'available'
                        : GPU_VALUES.length
                          ? 'partial'
                          : timerEnd?.pendingCount
                            ? 'pending'
                            : 'unavailable';
                Object.assign(METHOD, {
                    fps: INTERVAL.mean ? 1000 / INTERVAL.mean : null,
                    frameIntervalMs: INTERVAL,
                    cpuTotalMs: summary(RAW.cpuTotalMs),
                    submitMs: summary(RAW.submitMs),
                    drawCalls: summary(RAW.frames.map((frame) => frame.drawCalls)),
                    gpuMs: {
                        ...(GPU_STATUS === 'available' ? summary(GPU_VALUES) : { p50: null, p95: null }),
                        count: GPU_VALUES.length,
                        expectedCount: sampleFrames,
                        coverage: GPU_VALUES.length / sampleFrames,
                        status: GPU_STATUS,
                    },
                });
            }
        }
        return {
            config: CONFIG,
            preparationGeneration: BASELINE.generation,
            presentation:
                'Sequential full-viewport render; identical 60 Hz display-time samples; FPS from actual rAF intervals',
            setup: SETUP,
            rounds: ROUNDS,
            methods: ROUNDS[0].methods,
            gpuDiscardedCount: DISCARDED_COUNT,
            gpuTimerSupported: bridge.gpuTimerSupported,
        };
    } finally {
        bridge.restoreBenchmarkState(PREVIOUS);
    }
}

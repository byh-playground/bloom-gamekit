import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';
import { buildPreviews } from '../../../project/previews.mjs';

const ROOT = resolve('.');
const SOURCE = 'modules/vector-assets/assets/seed-scout.svg';
const COMPILED = await compileVectorAssetFile(SOURCE, SOURCE);
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
    preview = await PREVIEW_PAGE.evaluate(() => {
        const DEMO = window.__rasterComparison;
        if (DEMO.error) {
            throw new Error(DEMO.error);
        }
        DEMO.setAutoRender(false);
        DEMO.setCount(1);
        DEMO.setClip('bounce');
        DEMO.setMode('raster');
        DEMO.setResolution(512);
        const FRAMES = [];
        for (const ZOOM of [0.5, 1, 3]) {
            DEMO.setZoom(ZOOM);
            FRAMES.push(DEMO.renderOnce({ timeMs: 130 }));
        }
        DEMO.setClip('idle');
        const OPACITY = DEMO.renderOnce({ timeMs: 130 });
        const DISPOSED = DEMO.dispose();
        return { frames: FRAMES, opacity: OPACITY, disposed: DISPOSED };
    });
    assert.equal(preview.disposed, true);
    for (const FRAME of preview.frames) {
        assert.equal(FRAME.rasterResult.rasterDraws, 1, JSON.stringify(FRAME.rasterResult));
        assert.equal(FRAME.rasterResult.vectorFallbacks, 0);
        assert.equal(FRAME.atlas.runCount, 7);
        assert.ok(FRAME.atlas.atlasBytes > 0);
    }
    assert.equal(preview.opacity.rasterResult.vectorFallbacks, 1);
    assert.ok(preview.opacity.rasterResult.reasons.includes('opacityChannel'));
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
                    const PROGRAM = GL.getParameter(GL.CURRENT_PROGRAM);
                    const SAMPLERS = [];
                    if (PROGRAM) {
                        for (let index = 0; index < GL.getProgramParameter(PROGRAM, GL.ACTIVE_UNIFORMS); index++) {
                            const UNIFORM = GL.getActiveUniform(PROGRAM, index);
                            if (UNIFORM?.type === GL.SAMPLER_2D) {
                                const LOCATION = GL.getUniformLocation(PROGRAM, UNIFORM.name);
                                SAMPLERS.push({ name: UNIFORM.name, unit: GL.getUniform(PROGRAM, LOCATION) });
                            }
                        }
                    }
                    window.__rasterDebug = {
                        label,
                        previousStage: stage,
                        glError: ERROR,
                        framebufferBound: Boolean(GL.getParameter(GL.FRAMEBUFFER_BINDING)),
                        programBound: Boolean(PROGRAM),
                        programLinked: PROGRAM ? GL.getProgramParameter(PROGRAM, GL.LINK_STATUS) : null,
                        samplers: SAMPLERS,
                        maxTextureUnits: GL.getParameter(GL.MAX_TEXTURE_IMAGE_UNITS),
                        activeTexture: GL.getParameter(GL.ACTIVE_TEXTURE) - GL.TEXTURE0,
                        activeRenderTarget: Boolean(DEVICE.activeRenderTarget),
                        deviceActive: DEVICE.active,
                        deviceState: DEVICE.state,
                        deviceStats: {
                            frame: DEVICE.stats.frame,
                            drawCalls: DEVICE.stats.drawCalls,
                            bufferBytes: DEVICE.stats.bufferBytes,
                            textureBytes: DEVICE.stats.textureBytes,
                            textureCount: DEVICE.stats.textureCount,
                            renderTargetCount: DEVICE.stats.renderTargetCount,
                        },
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
            FALLBACKS.bakeFailure = FAULT_ATLAS.draw(PLAYER, { projection: PROJECTION, matrix: MATRIX(1) });
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
            const SPRITE = R.createSpriteAnimation(MESHES, SPRITE_BAKER.texture, SPRITE_BAKER.definition),
                SPRITE_PLAYER = SPRITE.createPlayer({ clip: 'bounce' }),
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
            CHECK_GL('after seed sprite submit before flush');
            const SPRITE_PIXELS = END();
            const SPRITE_COMPARISON = {
                frameIndex: SPRITE_SAMPLE.frameIndex,
                sampleTimeMs: SAMPLE_TIME,
                ...COMPARE(EMPTY_SPRITE_BACKGROUND, SVG_SAMPLE, SPRITE_PIXELS),
            };
            const BAKE_COUNT = SPRITE_BAKER.stats.bakeCount;
            BEGIN('black');
            SPRITE_BAKER.bake();
            END();
            SPRITE_CACHE.unchangedAcrossOrdinaryFrame = SPRITE_BAKER.stats.bakeCount === BAKE_COUNT;
            SPRITE_COPY.dispose();
            SPRITE_CACHE.refAfterCopyDispose = SPRITE_BAKER.stats.refCount;
            SPRITE_PLAYER.dispose();
            SPRITE.dispose();
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
            const SKETCH_SPRITE = R.createSpriteAnimation(MESHES, SKETCH_BAKER.texture, SKETCH_BAKER.definition),
                SKETCH_SPRITE_PLAYER = SKETCH_SPRITE.createPlayer({ clip: 'idle' }),
                SKETCH_TIME = SKETCH_BAKER.stats.sampleTimesMs[1],
                EMPTY_SKETCH_BACKGROUND = BACKGROUND('black');
            BEGIN('black');
            SKETCH_PLAYER.seek(SKETCH_TIME);
            SKETCH_PLAYER.draw({ projection: PROJECTION, matrix: MATRIX_FOR(SKETCH_COMPILED_ASSET.viewBox, 1) });
            const SKETCH_SVG = END();
            BEGIN('black');
            const SKETCH_MATRIX = MATRIX_FOR(SKETCH_COMPILED_ASSET.viewBox, 1);
            for (let index = 0; index < 4; index++) {
                SKETCH_MATRIX[index] /= 4;
            }
            SKETCH_SPRITE_PLAYER.draw({ timeMs: SKETCH_TIME, projection: PROJECTION, matrix: SKETCH_MATRIX });
            const SKETCH_PIXELS = END();
            const SKETCH_COMPARISON = {
                backend: SKETCH_BAKE.backend,
                frameCount: SKETCH_BAKER.stats.frameCount,
                alternateSlots: SKETCH_BAKER.definition.clips.idle.frames.length,
                sampledDurationMs: SKETCH_BAKER.stats.sampledDurationMs,
                sourceDurationMs: SKETCH_COMPILED_ASSET.metadata.clips.idle.durationMs,
                ...COMPARE(EMPTY_SKETCH_BACKGROUND, SKETCH_SVG, SKETCH_PIXELS),
            };
            SKETCH_SPRITE_PLAYER.dispose();
            SKETCH_SPRITE.dispose();
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
                restore = {
                    supported: true,
                    before: BEFORE_RESTORE,
                    after: ATLAS.stats.bakeCount,
                    backend: RESULT.backend,
                    spriteBackend: SPRITE_RESULT.backend,
                    spriteBakeCount: SPRITE_BAKER.stats.bakeCount,
                };
            }
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
        assert.ok(COMPARISON.meanForegroundChannelError <= 55, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.changedFraction <= 0.6, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.spuriousFraction <= 0.35, JSON.stringify(COMPARISON));
    }
    assert.equal(direct.expressionComparisons.length, 5);
    for (const COMPARISON of direct.expressionComparisons) {
        assert.equal(COMPARISON.backend, 'raster', JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.foregroundPixels > 40, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.meanForegroundChannelError <= 55, JSON.stringify(COMPARISON));
        assert.ok(COMPARISON.changedFraction <= 0.6, JSON.stringify(COMPARISON));
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
    assert.ok(direct.spriteComparison.meanForegroundChannelError <= 55, JSON.stringify(direct.spriteComparison));
    assert.equal(direct.sketchComparison.backend, 'sprite');
    assert.equal(direct.sketchComparison.alternateSlots, direct.sketchComparison.frameCount * 2);
    assert.equal(direct.sketchComparison.sampledDurationMs, direct.sketchComparison.sourceDurationMs);
    assert.ok(direct.sketchComparison.foregroundPixels > 100);
    assert.ok(direct.sketchComparison.meanForegroundChannelError <= 55, JSON.stringify(direct.sketchComparison));
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
            meanForegroundChannelErrorMax: 55,
            changedFractionOver48Max: 0.6,
            spuriousFractionOver32Max: 0.35,
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
        debug: directPage ? await directPage.evaluate(() => window.__rasterDebug ?? null).catch(() => null) : null,
    };
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(resolve(ROOT, 'test-results/raster-comparison-failure.json'), JSON.stringify(FAILURE, null, 2));
    error.message = `Raster comparison failed at ${STAGE}: ${FAILURE.message}`;
    error.stack = `Error: ${error.message}\nSee test-results/raster-comparison-failure.json for the scrubbed diagnostic stack.`;
    throw error;
} finally {
    await BROWSER.close();
}

import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';

// Fixed user scenario: mixed native assets, interleaved paint, independent clocks,
// nested transitions, row reuse/growth, resize, context recovery and disposal.
// Optional consumer SVGs exercise the same API without adding app rules to it.
const FIXTURES = process.env.GAMEKIT_VECTOR_FIXTURES
    ? JSON.parse(process.env.GAMEKIT_VECTOR_FIXTURES)
    : [
          'modules/vector-assets/assets/seed-scout.svg',
          'modules/vector-assets/assets/sketch-fox.svg',
          'modules/vector-assets/assets/yarn-fox.svg',
      ];
const ASSETS = [];
for (const FILE of FIXTURES) {
    const ASSET = await compileVectorAssetFile(FILE, FILE);
    ASSETS.push({
        id: ASSET.metadata.id,
        sourceSha256: ASSET.sourceSha256,
        module:
            'data:text/javascript;base64,' + Buffer.from(compiledAssetModuleSource(ASSET, 'asset')).toString('base64'),
    });
}
const RENDERING = 'data:text/javascript;base64,' + (await readFile('dist/rendering.js')).toString('base64');
const VECTOR_ASSETS = 'data:text/javascript;base64,' + (await readFile('dist/vector-assets.js')).toString('base64');
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
const RESULTS = [];
const ERRORS = [];
const SOURCE_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const SOURCE_DIRTY =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
try {
    for (const BACKEND of ['uniform', 'auto', 'cpu']) {
        const PAGE = await BROWSER.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
        PAGE.on('pageerror', (error) => ERRORS.push(error.stack));
        await PAGE.setContent('<canvas width="800" height="600"></canvas>');
        const RESULT = await PAGE.evaluate(
            async ({ rendering, vectors, assets, backend }) => {
                const R = await import(rendering);
                const V = await import(vectors);
                const COMPILED = await Promise.all(assets.map(async (asset) => (await import(asset.module)).asset));
                const CANVAS = document.querySelector('canvas');
                const DEVICE = new R.WebGLDevice(CANVAS, {
                    alpha: false,
                    antialias: true,
                    preserveDrawingBuffer: true,
                    checkGLErrors: true,
                });
                const MESHES = new R.MeshRenderer(DEVICE, { poseBackend: backend });
                const CONTEXT = new R.VectorContext(DEVICE);
                CONTEXT.meshRenderer = MESHES;
                const SURFACES = new R.YarnSurfaceRenderer(DEVICE);
                const RESOURCES = COMPILED.map((asset) =>
                    V.createVectorAsset(MESHES, asset, { surfaceRenderer: SURFACES }),
                );
                const PLAYERS = [];
                const INFO = DEVICE.gl.getExtension('WEBGL_debug_renderer_info');
                const HARDWARE = {
                    renderer: INFO
                        ? DEVICE.gl.getParameter(INFO.UNMASKED_RENDERER_WEBGL)
                        : DEVICE.gl.getParameter(DEVICE.gl.RENDERER),
                    vendor: INFO
                        ? DEVICE.gl.getParameter(INFO.UNMASKED_VENDOR_WEBGL)
                        : DEVICE.gl.getParameter(DEVICE.gl.VENDOR),
                };
                function addPlayer(index) {
                    const ASSET_INDEX = index % RESOURCES.length;
                    const NAMES = Object.keys(COMPILED[ASSET_INDEX].metadata.clips);
                    const CLIP = NAMES.includes('walk') ? 'walk' : NAMES[0];
                    PLAYERS[index] = {
                        player: RESOURCES[ASSET_INDEX].createPlayer({ clip: CLIP, startedAtMs: -index * 37.197 }),
                        assetIndex: ASSET_INDEX,
                        names: NAMES,
                    };
                }
                for (let i = 0; i < 20; i++) {
                    addPlayer(i);
                }
                const FRAMES = [];
                const FAULTS = {
                    uploadDirtyRetained: null,
                    restoredStateRefresh: null,
                    capacityRollback: null,
                    programRebuildRollback: null,
                    sourceReleaseNoAllocation: null,
                };
                const TIMES = [0, 37.25, 131, 249, 500.125, 801.3, 1100, 1100, 37.25];
                for (let frame = 0; frame < TIMES.length; frame++) {
                    const TIME = TIMES[frame];
                    if (frame === 6) {
                        CANVAS.width = 720;
                        CANVAS.height = 520;
                    }
                    CONTEXT.beginFrame({
                        width: CANVAS.width,
                        height: CANVAS.height,
                        clearColor: [0.09, 0.11, 0.13, 1],
                    });
                    if (frame === 1) {
                        // Grow the row atlas while an earlier visible mesh is queued.
                        const FIRST = PLAYERS[0].player;
                        FIRST.seek(TIME);
                        CONTEXT.drawVectorAsset(FIRST, { matrix: [0.13, 0, 0, 0.13, 15, 10], alpha: 0.65 });
                        for (let i = 20; i < 80; i++) {
                            addPlayer(i);
                        }
                    }
                    if (frame === 5) {
                        // Same application indices, new opaque player identities and recycled rows.
                        for (let i = 0; i < PLAYERS.length; i += 7) {
                            PLAYERS[i].player.dispose();
                            addPlayer(i);
                        }
                    }
                    const PREPARED = [];
                    const CLOCKS = [];
                    for (let i = 0; i < PLAYERS.length; i++) {
                        const ENTRY = PLAYERS[i];
                        const PLAYER = ENTRY.player;
                        const META = COMPILED[ENTRY.assetIndex].metadata;
                        if (frame === 2) {
                            PLAYER.transitionTo(ENTRY.names[(i + 1) % ENTRY.names.length], 100 + i * 0.2, 180);
                        }
                        if (frame === 3) {
                            PLAYER.transitionTo(ENTRY.names[(i + 2) % ENTRY.names.length], 220 + i * 0.15, 220);
                        }
                        PLAYER.seek(TIME);
                        PLAYER.setExpression(Object.keys(META.expressions)[i % Object.keys(META.expressions).length]);
                        PLAYER.setBasePose(META.parts[0].id, {
                            x: Math.sin(TIME * 0.003 + i) * 1.5,
                            rotation: Math.sin(TIME * 0.002 + i) * 0.025,
                            scaleX: 1 + (i % 3) * 0.01,
                            scaleY: 1 - (i % 2) * 0.01,
                            opacity: i % 6 === 0 ? 0.8 : 1,
                        });
                        if (META.parts.length > 2 && i % 9 === 0) {
                            PLAYER.setPartVisible(META.parts[1].id, frame % 2 === 0);
                        }
                        const EXCLUDED = frame === 4 && i % 8 === 0 ? new Set([META.parts[0].id]) : null;
                        const CULLED = (frame === 2 || frame === 3) && i % 5 === 0;
                        const HANDLE = CULLED ? null : PLAYER.preparePose({ excludeParts: EXCLUDED });
                        PREPARED.push({ handle: HANDLE, excluded: EXCLUDED, culled: CULLED });
                        CLOCKS.push(PLAYER.currentTimeMs);
                    }
                    if (frame === 0 && backend === 'auto') {
                        const UPDATE = DEVICE.updateDataTexture;
                        DEVICE.updateDataTexture = () => {
                            throw new Error('Injected pose state upload failure');
                        };
                        try {
                            MESHES.preparePoses();
                            throw new Error('Upload failure injection did not execute');
                        } catch (error) {
                            if (error.message !== 'Injected pose state upload failure') {
                                throw error;
                            }
                            FAULTS.uploadDirtyRetained = [...MESHES.poseRenderer.instances.values()]
                                .filter((record) => record.mode === 'gpu')
                                .every((record) => record.stateDirty);
                        } finally {
                            DEVICE.updateDataTexture = UPDATE;
                        }
                    }
                    MESHES.preparePoses();
                    const PREPARED_STATS = MESHES.poseStats();
                    for (let i = 0; i < PLAYERS.length; i++) {
                        if (PREPARED[i].culled) {
                            continue;
                        }
                        const ENTRY = PLAYERS[i];
                        const META = COMPILED[ENTRY.assetIndex].metadata;
                        const X = (i % 10) * 65 + 10;
                        const Y = Math.floor(i / 10) * 58 + 15;
                        const SCALE = 48 / COMPILED[ENTRY.assetIndex].viewBox[3];
                        CONTEXT.drawVectorAsset(ENTRY.player, {
                            matrix: [SCALE, 0, 0, SCALE, X, Y],
                            alpha: i % 4 === 0 ? 0.55 : 1,
                            excludeParts: PREPARED[i].excluded,
                            whiteFlash: i % 11 === 0,
                        });
                        const SOCKET_ID = Object.keys(META.sockets)[0];
                        if (SOCKET_ID) {
                            const SOCKET = ENTRY.player.getSocket(SOCKET_ID);
                            CONTEXT.fillStyle = '#c34b617f';
                            CONTEXT.beginPath();
                            CONTEXT.ellipse(X + SOCKET.x * SCALE, Y + SOCKET.y * SCALE, 4, 2, 0, 0, Math.PI * 2);
                            CONTEXT.fill();
                        }
                        CONTEXT.strokeStyle = '#415c78aa';
                        CONTEXT.lineWidth = 1;
                        CONTEXT.beginPath();
                        CONTEXT.moveTo(X + 15, Y + 15);
                        CONTEXT.lineTo(X + 24, Y + 20);
                        CONTEXT.stroke();
                    }
                    CONTEXT.endFrame();
                    const GL = DEVICE.gl;
                    const PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
                    GL.readPixels(0, 0, CANVAS.width, CANVAS.height, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                    let binary = '';
                    for (let i = 0; i < PIXELS.length; i += 32768) {
                        binary += String.fromCharCode(...PIXELS.subarray(i, i + 32768));
                    }
                    const POSE_STATS = MESHES.poseStats();
                    if (POSE_STATS.flushRecordVisits !== PREPARED_STATS.flushRecordVisits) {
                        throw new Error('Drawing unchanged prepared poses must not rescan the atlas');
                    }
                    if (POSE_STATS.cpuPoseUploadBytes !== PREPARED_STATS.cpuPoseUploadBytes) {
                        throw new Error('Drawing unchanged prepared CPU poses must not upload rows again');
                    }
                    FRAMES.push({
                        width: CANVAS.width,
                        height: CANVAS.height,
                        pixels: btoa(binary),
                        clocks: CLOCKS,
                        stats: POSE_STATS,
                        glError: GL.getError(),
                        fullSamples: PLAYERS.reduce((total, entry) => total + entry.player.poseMetrics.fullSamples, 0),
                    });
                    if (frame === 6) {
                        const EXTENSION = GL.getExtension('WEBGL_lose_context');
                        if (!EXTENSION) {
                            throw new Error('Context loss scenario requires WEBGL_lose_context');
                        }
                        const LOST = new Promise((resolve) =>
                            CANVAS.addEventListener('webglcontextlost', resolve, { once: true }),
                        );
                        const RESTORED = new Promise((resolve) =>
                            CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
                        );
                        if (backend === 'auto') {
                            // Emulate retained pixels lagging staged CPU state after an interrupted upload.
                            DEVICE.textures.get(MESHES.poseRenderer.stateTexture).source.fill(0);
                            DEVICE.textures.get(MESHES.poseRenderer.overrideTexture).source.fill(0);
                        }
                        EXTENSION.loseContext();
                        await LOST;
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        EXTENSION.restoreContext();
                        await Promise.race([
                            RESTORED,
                            new Promise((_resolve, reject) =>
                                setTimeout(() => reject(new Error('Context restoration timed out')), 10000),
                            ),
                        ]);
                        if (DEVICE.state !== 'ready') {
                            throw new Error('Device did not restore: ' + DEVICE.state);
                        }
                        if (backend === 'auto') {
                            FAULTS.restoredStateRefresh = [...MESHES.poseRenderer.instances.values()]
                                .filter((record) => record.mode === 'gpu')
                                .every((record) => record.stateDirty && record.overrideDirty);
                        }
                    }
                }
                const SNAPSHOT = {
                    backend,
                    hardware: HARDWARE,
                    frames: FRAMES,
                    faults: FAULTS,
                };
                if (backend === 'auto' && MESHES.poseRenderer?.sources.size > 1) {
                    const POSES = MESHES.poseRenderer;
                    const CREATE = DEVICE.createDataTexture;
                    const CAPACITY = POSES.capacity;
                    const STATE_TEXTURE = POSES.stateTexture;
                    const OVERRIDE_TEXTURE = POSES.overrideTexture;
                    const TEXTURE_COUNT = DEVICE.textures.size;
                    DEVICE.createDataTexture = () => {
                        throw new Error('Injected pose data allocation failure');
                    };
                    try {
                        POSES._ensureCapacity(CAPACITY + 1);
                        throw new Error('Capacity failure injection did not execute');
                    } catch (error) {
                        if (error.message !== 'Injected pose data allocation failure') {
                            throw error;
                        }
                        FAULTS.capacityRollback =
                            POSES.capacity === CAPACITY &&
                            POSES.stateTexture === STATE_TEXTURE &&
                            POSES.overrideTexture === OVERRIDE_TEXTURE &&
                            DEVICE.textures.size === TEXTURE_COUNT;
                    } finally {
                        DEVICE.createDataTexture = CREATE;
                    }
                    const RELEASED_PROGRAM = [...POSES.sources.values()][0].program;
                    const SOURCE_COUNT = POSES.sources.size;
                    DEVICE.createDataTexture = () => {
                        throw new Error('Source release must not allocate');
                    };
                    try {
                        RESOURCES[0].dispose();
                        FAULTS.sourceReleaseNoAllocation =
                            RESOURCES[0].disposed && POSES.sources.size === SOURCE_COUNT - 1;
                    } finally {
                        DEVICE.createDataTexture = CREATE;
                    }
                    const BEFORE_SOURCES = [...POSES.sources].map(([handle, source]) => ({
                        handle,
                        offset: source.offset,
                    }));
                    const PROGRAM_TEXTURE = POSES.programTexture;
                    DEVICE.createDataTexture = () => {
                        throw new Error('Injected pose program allocation failure');
                    };
                    try {
                        MESHES.createPoseSource(RELEASED_PROGRAM);
                        throw new Error('Program failure injection did not execute');
                    } catch (error) {
                        if (error.message !== 'Injected pose program allocation failure') {
                            throw error;
                        }
                        FAULTS.programRebuildRollback =
                            POSES.sources.size === BEFORE_SOURCES.length &&
                            POSES.programTexture === PROGRAM_TEXTURE &&
                            BEFORE_SOURCES.every(({ handle, offset }) => POSES.sources.get(handle)?.offset === offset);
                    } finally {
                        DEVICE.createDataTexture = CREATE;
                    }
                }
                for (const RESOURCE of RESOURCES) {
                    RESOURCE.dispose();
                }
                SURFACES.dispose();
                CONTEXT.dispose();
                MESHES.dispose();
                SNAPSHOT.afterDispose = {
                    buffers: DEVICE.buffers.size,
                    textures: DEVICE.textures.size,
                    targets: DEVICE.renderTargets.size,
                    pipelines: DEVICE.pipelines.size,
                };
                DEVICE.dispose();
                return SNAPSHOT;
            },
            { rendering: RENDERING, vectors: VECTOR_ASSETS, assets: ASSETS, backend: BACKEND },
        );
        RESULTS.push(RESULT);
        await PAGE.close();
    }
    const DIFFERENCES = [];
    const REFERENCE_PIXELS = RESULTS[0].frames.map((frame) => Buffer.from(frame.pixels, 'base64'));
    for (const RESULT of RESULTS) {
        if (RESULT.backend === 'auto') {
            assert.ok(
                RESULT.frames[0].stats.gpuDrawInstances > 0,
                'supported auto backend must actually draw GPU poses',
            );
            for (const FRAME of [2, 3]) {
                assert.ok(
                    RESULT.frames[FRAME].stats.cpuDrawInstances > 0 &&
                        RESULT.frames[FRAME].stats.fallbackReasons.transitionBlend > 0,
                    'nested transition must use the declared CPU blend path',
                );
            }
            assert.ok(
                RESULT.frames[4].stats.gpuDrawInstances > 0 && RESULT.frames[4].stats.cpuDrawInstances === 0,
                'completed transitions must return to GPU without resetting clocks',
            );
            assert.ok(RESULT.frames[7].stats.gpuDrawInstances > 0, 'restored supported context must resume GPU poses');
            assert.deepEqual(RESULT.faults, {
                uploadDirtyRetained: true,
                restoredStateRefresh: true,
                capacityRollback: true,
                programRebuildRollback: true,
                sourceReleaseNoAllocation: true,
            });
        }
        assert.deepEqual(RESULT.afterDispose, { buffers: 0, textures: 0, targets: 0, pipelines: 0 });
        for (let frame = 0; frame < RESULT.frames.length; frame++) {
            const ACTUAL = RESULT.frames[frame];
            const REFERENCE = RESULTS[0].frames[frame];
            assert.equal(ACTUAL.glError, 0);
            assert.deepEqual(ACTUAL.clocks, REFERENCE.clocks, 'Backend changes cannot reset player clocks');
            const A = Buffer.from(ACTUAL.pixels, 'base64');
            const B = REFERENCE_PIXELS[frame];
            assert.equal(A.length, B.length);
            let changed = 0;
            let maximum = 0;
            let total = 0;
            const LOCATIONS = [];
            for (let i = 0; i < A.length; i += 4) {
                let difference = 0;
                for (let channel = 0; channel < 4; channel++) {
                    const DELTA = Math.abs(A[i + channel] - B[i + channel]);
                    difference = Math.max(difference, DELTA);
                    maximum = Math.max(maximum, DELTA);
                    total += DELTA;
                }
                if (difference) {
                    changed++;
                    if (LOCATIONS.length < 16) {
                        LOCATIONS.push({
                            x: (i / 4) % ACTUAL.width,
                            y: ACTUAL.height - 1 - Math.floor(i / 4 / ACTUAL.width),
                            delta: difference,
                        });
                    }
                }
            }
            const COMPARISON = {
                backend: RESULT.backend,
                frame,
                timeMs: [0, 37.25, 131, 249, 500.125, 801.3, 1100, 1100, 37.25][frame],
                changedPixels: changed,
                changedFraction: changed / (A.length / 4),
                maxChannelError: maximum,
                meanAbsoluteChannelError: total / A.length,
                firstChangedLocations: LOCATIONS,
            };
            DIFFERENCES.push(COMPARISON);
            assert.ok(
                COMPARISON.changedFraction <= 0.001 && maximum <= 64 && COMPARISON.meanAbsoluteChannelError <= 0.05,
                JSON.stringify(COMPARISON),
            );
            delete ACTUAL.pixels;
        }
    }
    assert.deepEqual(ERRORS, []);
    const REPORT = {
        sourceHead: SOURCE_HEAD,
        sourceDirty: SOURCE_DIRTY,
        execution:
            'Local Chromium WebGL 2 pixels and reported GPU; GitHub build CI and physical mobile are separate verification scopes.',
        fixtures: ASSETS.map(({ id, sourceSha256 }) => ({ id, sourceSha256 })),
        browser: await BROWSER.version(),
        thresholds: {
            matrixSvgUnits: 0.001,
            opacity: 0.000001,
            morph: 0.000001,
            changedFraction: 0.001,
            maxChannel: 64,
            meanChannel: 0.05,
        },
        differences: DIFFERENCES,
        results: RESULTS,
    };
    await mkdir(resolve('test-results'), { recursive: true });
    await writeFile(resolve('test-results/gpu-poses.json'), JSON.stringify(REPORT, null, 2));
    console.log(JSON.stringify(REPORT, null, 2));
} finally {
    await BROWSER.close();
}

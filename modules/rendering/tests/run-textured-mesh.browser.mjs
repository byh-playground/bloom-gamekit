import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../../vector-assets/compiler.js';

// Public-bundle canvas contract: retained UVs, premultiplied paint, ordered
// mixed submissions, a real seven-part pose, context recovery and disposal.
const ASSET = await compileVectorAssetFile(
    'modules/vector-assets/assets/seed-scout.svg',
    'modules/vector-assets/assets/seed-scout.svg',
);
const SINGLE_PART_ASSET = await compileVectorAssetFile(
    'modules/vector-assets/assets/sketch-fox.svg',
    'modules/vector-assets/assets/sketch-fox.svg',
);
const RENDERING_BYTES = await readFile('dist/rendering.js');
const VECTOR_ASSETS_BYTES = await readFile('dist/vector-assets.js');
const RENDERING_URL = 'data:text/javascript;base64,' + RENDERING_BYTES.toString('base64');
const VECTOR_ASSETS_URL = 'data:text/javascript;base64,' + VECTOR_ASSETS_BYTES.toString('base64');
const PROVENANCE = {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
    renderingSha256: createHash('sha256').update(RENDERING_BYTES).digest('hex'),
    vectorAssetsSha256: createHash('sha256').update(VECTOR_ASSETS_BYTES).digest('hex'),
};
const ASSET_URL =
    'data:text/javascript;base64,' + Buffer.from(compiledAssetModuleSource(ASSET, 'asset')).toString('base64');
const SINGLE_PART_ASSET_URL =
    'data:text/javascript;base64,' +
    Buffer.from(compiledAssetModuleSource(SINGLE_PART_ASSET, 'asset')).toString('base64');
const SCRUB_INLINE_MODULES = (value) =>
    String(value).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<inline module>');
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
let report = { status: 'FAIL', provenance: { ...PROVENANCE, browserVersion: BROWSER.version() } };
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(SCRUB_INLINE_MODULES(error.stack)));
    await PAGE.setContent('<canvas width="128" height="128"></canvas>');
    const RESULT = await PAGE.evaluate(
        async ({ renderingURL, vectorAssetsURL, assetURL, singlePartAssetURL }) => {
            const R = await import(renderingURL);
            const V = await import(vectorAssetsURL);
            const COMPILED = (await import(assetURL)).asset;
            const SINGLE_PART_COMPILED = (await import(singlePartAssetURL)).asset;
            const CHECK = (condition, message) => {
                if (!condition) {
                    throw new Error(message);
                }
            };
            const NEAR = (actual, expected, label, tolerance = 3) => {
                CHECK(
                    actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
                    `${label}: ${actual}, expected ${expected}`,
                );
            };
            const CANVAS = document.querySelector('canvas');
            const DEVICE = new R.WebGLDevice(CANVAS, {
                alpha: false,
                antialias: false,
                preserveDrawingBuffer: true,
                checkGLErrors: true,
            });
            const CTX = new R.VectorContext(DEVICE);
            const GL = DEVICE.gl;
            const INFO = GL.getExtension('WEBGL_debug_renderer_info');
            const HARDWARE = {
                renderer: INFO ? GL.getParameter(INFO.UNMASKED_RENDERER_WEBGL) : GL.getParameter(GL.RENDERER),
                vendor: INFO ? GL.getParameter(INFO.UNMASKED_VENDOR_WEBGL) : GL.getParameter(GL.VENDOR),
                version: GL.getParameter(GL.VERSION),
            };
            const PIXEL = (x, y) => {
                const BYTES = new Uint8Array(4);
                GL.readPixels(x, 127 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, BYTES);
                return [...BYTES];
            };
            const VERTEX = (x, y, color = [1, 1, 1, 1]) => [x, y, ...color, 0, 0, 0, 0, 0];
            const GEOMETRY = (color = [1, 1, 1, 1], partCount = 1) => ({
                vertices: new Float32Array(
                    [VERTEX(0, 0, color), VERTEX(32, 0, color), VERTEX(32, 32, color), VERTEX(0, 32, color)].flat(),
                ),
                indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
                strideFloats: 11,
                partCount,
                morphCount: 0,
            });
            const UVS = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
            const QUAD_DATA = GEOMETRY();
            const EXPECT_THROW = (action, label) => {
                let threw = false;
                try {
                    action();
                } catch (error) {
                    threw = error instanceof TypeError || error instanceof RangeError;
                }
                CHECK(threw, label);
            };
            let resource;
            let player;
            let singlePartResource;
            let singlePartPlayer;
            let largeLeft;
            let largeRight;
            let largeTexture;
            try {
                EXPECT_THROW(
                    () => CTX.createMesh({ ...QUAD_DATA, uvs: new Float32Array([0, 1]) }),
                    'incorrect UV count rejected',
                );
                EXPECT_THROW(
                    () => CTX.createMesh({ ...QUAD_DATA, uvs: new Float32Array([0, 1, NaN, 1, 1, 0, 0, 0]) }),
                    'non-finite UV rejected',
                );
                const TEXTURED = CTX.createMesh({ ...QUAD_DATA, uvs: UVS });
                const PLAIN = CTX.createMesh(GEOMETRY([1, 1, 0, 1]));
                const TINTED = CTX.createMesh({ ...GEOMETRY([0.5, 0.25, 1, 1]), uvs: UVS });
                const TEXTURED_POSE = CTX.createMesh({
                    ...GEOMETRY([1, 1, 1, 1], COMPILED.metadata.parts.length),
                    uvs: UVS,
                });
                const TEXTURED_SINGLE_POSE = CTX.createMesh({ ...QUAD_DATA, uvs: UVS });
                CHECK(TEXTURED.strideFloats === 11 && TEXTURED.bufferStrideFloats === 13, 'CPU/GPU stride split');
                CHECK(TEXTURED.vertices.length === 44 && TEXTURED.gpuVertices.length === 52, 'UVs packed once');
                CHECK(TEXTURED.byteLength === 44 * 4 + 52 * 4 + 12, 'CPU and GPU retained bytes counted');
                const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]);
                const TEXTURE_A = DEVICE.createTexture({ width: 2, height: 2, data: PIXELS }, { filter: 'nearest' });
                const TEXTURE_B = DEVICE.createTexture(
                    { width: 1, height: 1, data: new Uint8Array([0, 255, 255, 255]) },
                    { filter: 'nearest' },
                );
                const TEXTURE_LINEAR = DEVICE.createTexture(
                    {
                        width: 2,
                        height: 2,
                        data: new Uint8Array([255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0]),
                    },
                    { filter: 'linear' },
                );
                const WHITE_TEXTURE = DEVICE.createTexture(
                    { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
                    { filter: 'nearest' },
                );
                const DRAW = (mesh, texture, x, y) => CTX.drawMesh(mesh, { transform: [1, 0, 0, 1, x, y], texture });
                const BEGIN = () => CHECK(CTX.beginFrame({ clearColor: [0, 0, 0, 1] }), 'frame available');
                const SCENE = () => {
                    BEGIN();
                    EXPECT_THROW(() => DRAW(TEXTURED, null, 0, 0), 'UV mesh requires texture');
                    EXPECT_THROW(() => DRAW(PLAIN, TEXTURE_A, 0, 0), 'plain mesh cannot sample texture');
                    DRAW(TEXTURED, TEXTURE_A, 8, 8);
                    DRAW(TEXTURED, TEXTURE_B, 48, 8);
                    CTX.fillStyle = '#ffffff';
                    CTX.fillRect(16, 16, 8, 8);
                    DRAW(PLAIN, null, 96, 8);
                    DRAW(TEXTURED, TEXTURE_LINEAR, 8, 48);
                    DRAW(TINTED, WHITE_TEXTURE, 48, 48);
                    CTX.save();
                    CTX.globalAlpha = 0.5;
                    CTX.filter = 'brightness(0) invert(1)';
                    DRAW(TEXTURED, TEXTURE_A, 88, 48);
                    CTX.restore();
                    CTX.withColor([0, 1, 0, 0.5], () => DRAW(TEXTURED, TEXTURE_A, 8, 88));
                    EXPECT_THROW(
                        () =>
                            CTX.meshRenderer.drawMesh(TEXTURED, {
                                matrix: [1, 0, 0, 1, 0, 0],
                                projection: CTX.vector.projection,
                                texture: TEXTURE_A,
                                depthWriteAlphaThreshold: 0.5,
                            }),
                        'raster alpha cannot use CPU depth classifier',
                    );
                    return CTX.endFrame();
                };
                const FIRST = SCENE();
                const SAMPLES = {
                    topLeft: PIXEL(12, 12),
                    bottomLeft: PIXEL(12, 36),
                    bottomRight: PIXEL(36, 36),
                    transparent: PIXEL(36, 12),
                    textureChange: PIXEL(64, 24),
                    analyticOverlay: PIXEL(20, 20),
                    plain: PIXEL(112, 24),
                    linearEdge: PIXEL(24, 72),
                    tint: PIXEL(64, 64),
                    flash: PIXEL(92, 52),
                    forceColor: PIXEL(12, 92),
                };
                NEAR(SAMPLES.topLeft, [0, 0, 255, 255], 'top-left UV orientation');
                NEAR(SAMPLES.bottomLeft, [255, 0, 0, 255], 'bottom-left UV orientation');
                NEAR(SAMPLES.bottomRight, [0, 255, 0, 255], 'bottom-right UV orientation');
                NEAR(SAMPLES.transparent, [0, 0, 0, 255], 'transparent texel');
                NEAR(SAMPLES.textureChange, [0, 255, 255, 255], 'texture identity boundary');
                NEAR(SAMPLES.analyticOverlay, [255, 255, 255, 255], 'analytic painter order');
                NEAR(SAMPLES.plain, [255, 255, 0, 255], 'untextured shader remains usable');
                NEAR(SAMPLES.linearEdge, [128, 0, 0, 255], 'premultiplied linear edge avoids white fringe', 8);
                NEAR(SAMPLES.tint, [128, 64, 255, 255], 'vertex color tint');
                NEAR(SAMPLES.flash, [128, 128, 128, 255], 'flash preserves texture alpha');
                NEAR(SAMPLES.forceColor, [0, 128, 0, 255], 'force color uses texel alpha');
                CHECK(FIRST.mesh.drawDispatchReasons.texture > 0, 'texture switch flushed a batch');
                CHECK(GL.getError() === GL.NO_ERROR, 'paint scene GL error');

                const STENCIL_PATH = CTX.createClipPath(new Float32Array([72, 8, 88, 8, 88, 40, 72, 40]));
                BEGIN();
                CTX.save();
                CTX.clipRect(16, 8, 16, 32);
                DRAW(TEXTURED, TEXTURE_B, 8, 8);
                CTX.restore();
                DRAW(PLAIN, null, 40, 8);
                CTX.save();
                CTX.clipPath(STENCIL_PATH);
                CHECK(CTX.stencilRef === 1, 'retained clip activates stencil for textured mesh');
                DRAW(TEXTURED, TEXTURE_A, 64, 8);
                CTX.restore();
                DRAW(TEXTURED, TEXTURE_B, 96, 8);
                CTX.endFrame();
                const CLIPPED_SAMPLES = {
                    planeOutside: PIXEL(12, 16),
                    planeInside: PIXEL(20, 16),
                    planeOutsideRight: PIXEL(36, 16),
                    afterPlane: PIXEL(52, 16),
                    stencilOutside: PIXEL(68, 16),
                    stencilInside: PIXEL(76, 16),
                    stencilOutsideRight: PIXEL(92, 16),
                    afterStencil: PIXEL(108, 16),
                };
                NEAR(CLIPPED_SAMPLES.planeOutside, [0, 0, 0, 255], 'textured mesh clip plane excludes left');
                NEAR(CLIPPED_SAMPLES.planeInside, [0, 255, 255, 255], 'textured mesh clip plane includes center');
                NEAR(CLIPPED_SAMPLES.planeOutsideRight, [0, 0, 0, 255], 'textured mesh clip plane excludes right');
                NEAR(CLIPPED_SAMPLES.afterPlane, [255, 255, 0, 255], 'plain mesh after clip plane');
                NEAR(
                    CLIPPED_SAMPLES.stencilOutside,
                    [255, 255, 0, 255],
                    'textured mesh stencil retains prior plain mesh',
                );
                NEAR(CLIPPED_SAMPLES.stencilInside, [0, 0, 255, 255], 'textured mesh stencil includes center');
                NEAR(CLIPPED_SAMPLES.stencilOutsideRight, [0, 0, 0, 255], 'textured mesh stencil excludes right');
                NEAR(CLIPPED_SAMPLES.afterStencil, [0, 255, 255, 255], 'textured mesh after stencil restore');
                CHECK(GL.getError() === GL.NO_ERROR, 'clipped textured scene GL error');
                CTX.deleteClipPath(STENCIL_PATH);

                BEGIN();
                CTX.fillStyle = 'rgba(255,0,0,0.5)';
                CTX.fillRect(8, 8, 32, 32);
                CTX.save();
                CTX.globalCompositeOperation = 'lighter';
                CTX.fillStyle = 'rgba(0,255,0,0.5)';
                CTX.fillRect(8, 8, 32, 32);
                // Image meshes retain their source-over material contract while
                // forcing the preceding additive primitive batch to submit.
                DRAW(TEXTURED, TEXTURE_B, 48, 8);
                CTX.beginPath();
                CTX.moveTo(8, 48);
                CTX.lineTo(40, 48);
                CTX.lineTo(24, 80);
                CTX.closePath();
                CTX.fill();
                CTX.restore();
                CTX.fillStyle = 'rgba(0,0,255,0.5)';
                CTX.fillRect(8, 8, 32, 32);
                CTX.endFrame();
                NEAR(PIXEL(24, 24), [64, 64, 128, 255], 'additive primitive then texture then restored source-over');
                NEAR(PIXEL(64, 24), [0, 255, 255, 255], 'texture boundary preserves image material');
                NEAR(PIXEL(24, 56), [0, 128, 0, 255], 'additive vector path after texture');
                CHECK(CTX.globalCompositeOperation === 'source-over', 'composite state restored');
                CHECK(GL.getError() === GL.NO_ERROR, 'additive/vector/texture boundary GL error');

                const LARGE_WIDTH = Math.min(8192, DEVICE.maxTextureSize);
                CHECK(LARGE_WIDTH >= 2048, 'WebGL2 texture size supports precision scene');
                const LARGE_PIXELS = new Uint8Array(LARGE_WIDTH * 4 * 4);
                for (let pixel = 3; pixel < LARGE_PIXELS.length; pixel += 4) {
                    LARGE_PIXELS[pixel] = 255;
                }
                for (let row = 1; row <= 2; row++) {
                    for (let column = 0; column < 2; column++) {
                        LARGE_PIXELS[(row * LARGE_WIDTH + column) * 4] = 255;
                        LARGE_PIXELS[(row * LARGE_WIDTH + LARGE_WIDTH - 4 + column) * 4 + 1] = 255;
                    }
                }
                largeTexture = DEVICE.createTexture(
                    { width: LARGE_WIDTH, height: 4, data: LARGE_PIXELS },
                    { filter: 'nearest' },
                );
                const TILE_UVS = (start, end) =>
                    new Float32Array([
                        start / LARGE_WIDTH,
                        0.75,
                        end / LARGE_WIDTH,
                        0.75,
                        end / LARGE_WIDTH,
                        0.25,
                        start / LARGE_WIDTH,
                        0.25,
                    ]);
                largeLeft = CTX.createMesh({ ...QUAD_DATA, uvs: TILE_UVS(0, 2) });
                largeRight = CTX.createMesh({ ...QUAD_DATA, uvs: TILE_UVS(LARGE_WIDTH - 4, LARGE_WIDTH - 2) });
                BEGIN();
                DRAW(largeLeft, largeTexture, 8, 8);
                DRAW(largeRight, largeTexture, 48, 8);
                CTX.endFrame();
                const LARGE_UV_SAMPLES = { left: PIXEL(24, 24), right: PIXEL(64, 24) };
                NEAR(LARGE_UV_SAMPLES.left, [255, 0, 0, 255], 'large atlas left red tile');
                NEAR(LARGE_UV_SAMPLES.right, [0, 255, 0, 255], 'large atlas right green tile before gutter');
                CHECK(GL.getError() === GL.NO_ERROR, 'large atlas UV scene GL error');

                resource = V.createVectorAsset(CTX.meshRenderer, COMPILED);
                player = resource.createPlayer({ clip: Object.keys(COMPILED.metadata.clips)[0], startedAtMs: 0 });
                player.seek(120);
                const POSE = player.preparePose();
                CHECK(POSE !== null, 'seven-part pose prepared');
                BEGIN();
                CTX.meshRenderer.preparePoses();
                CTX.meshRenderer.drawMesh(TEXTURED_POSE, {
                    matrix: [1, 0, 0, 1, 48, 88],
                    projection: CTX.vector.projection,
                    pose: POSE,
                    texture: TEXTURE_B,
                });
                CTX.endFrame();
                CHECK(GL.getError() === GL.NO_ERROR, 'textured seven-part pose GL error');
                const POSE_STATS = CTX.meshRenderer.poseStats();
                CHECK(POSE_STATS.totalDrawInstances === 1, 'textured mesh consumed the borrowed pose');

                singlePartResource = V.createVectorAsset(CTX.meshRenderer, SINGLE_PART_COMPILED);
                singlePartPlayer = singlePartResource.createPlayer({ clip: 'idle', startedAtMs: 0 });
                singlePartPlayer.seek(0);
                singlePartPlayer.setBasePose('body', { x: 20 });
                const SINGLE_POSE = singlePartPlayer.preparePose();
                CHECK(SINGLE_POSE !== null, 'one-part pose prepared');
                BEGIN();
                CTX.meshRenderer.preparePoses();
                CTX.meshRenderer.drawMesh(TEXTURED_SINGLE_POSE, {
                    matrix: [1, 0, 0, 1, 8, 88],
                    projection: CTX.vector.projection,
                    pose: SINGLE_POSE,
                    texture: TEXTURE_B,
                });
                CTX.endFrame();
                NEAR(PIXEL(52, 104), [0, 255, 255, 255], 'one-part borrowed pose translates textured quad');
                NEAR(PIXEL(16, 104), [0, 0, 0, 255], 'one-part borrowed pose leaves old location clear');
                CHECK(GL.getError() === GL.NO_ERROR, 'one-part borrowed pose GL error');

                const EXTENSION = GL.getExtension('WEBGL_lose_context');
                CHECK(EXTENSION, 'context loss extension required');
                const LOST = new Promise((resolve) =>
                    CANVAS.addEventListener('webglcontextlost', resolve, { once: true }),
                );
                const RESTORED = new Promise((resolve) =>
                    CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
                );
                EXTENSION.loseContext();
                await LOST;
                await new Promise((resolve) => setTimeout(resolve, 50));
                EXTENSION.restoreContext();
                await Promise.race([
                    RESTORED,
                    new Promise((_resolve, reject) =>
                        setTimeout(() => reject(new Error('Context restore timed out')), 10000),
                    ),
                ]);
                CHECK(DEVICE.state === 'ready', 'device restored');
                SCENE();
                const RESTORED_SAMPLES = {
                    topLeft: PIXEL(12, 12),
                    textureChange: PIXEL(64, 24),
                    linearEdge: PIXEL(24, 72),
                    forceColor: PIXEL(12, 92),
                };
                for (const [NAME, VALUE] of Object.entries(RESTORED_SAMPLES)) {
                    NEAR(VALUE, SAMPLES[NAME], `retained UV/texture restore: ${NAME}`);
                }
                CHECK(GL.getError() === GL.NO_ERROR, 'restored scene GL error');
                player.dispose();
                resource.dispose();
                singlePartPlayer.dispose();
                singlePartResource.dispose();
                CTX.deleteMesh(TEXTURED);
                CTX.deleteMesh(PLAIN);
                CTX.deleteMesh(TINTED);
                CTX.deleteMesh(TEXTURED_POSE);
                CTX.deleteMesh(TEXTURED_SINGLE_POSE);
                CTX.deleteMesh(largeLeft);
                CTX.deleteMesh(largeRight);
                CTX.dispose();
                for (const TEXTURE of [TEXTURE_A, TEXTURE_B, TEXTURE_LINEAR, WHITE_TEXTURE, largeTexture]) {
                    DEVICE.deleteTexture(TEXTURE);
                }
                const COUNTS = {
                    buffers: DEVICE.buffers.size,
                    textures: DEVICE.textures.size,
                    renderTargets: DEVICE.renderTargets.size,
                    pipelines: DEVICE.pipelines.size,
                    gpuBufferBytes: DEVICE.stats.gpuBufferBytes,
                    gpuTextureBytes: DEVICE.stats.gpuTextureBytes,
                };
                CHECK(
                    Object.values(COUNTS).every((value) => value === 0),
                    'disposal releases all GPU resources',
                );
                return {
                    hardware: HARDWARE,
                    samples: SAMPLES,
                    clippedSamples: CLIPPED_SAMPLES,
                    largeUv: { width: LARGE_WIDTH, samples: LARGE_UV_SAMPLES },
                    restoredSamples: RESTORED_SAMPLES,
                    first: FIRST.mesh,
                    pose: POSE_STATS,
                    counts: COUNTS,
                };
            } finally {
                player?.dispose();
                resource?.dispose();
                singlePartPlayer?.dispose();
                singlePartResource?.dispose();
                CTX.dispose();
                DEVICE.dispose();
                CANVAS.remove();
            }
        },
        {
            renderingURL: RENDERING_URL,
            vectorAssetsURL: VECTOR_ASSETS_URL,
            assetURL: ASSET_URL,
            singlePartAssetURL: SINGLE_PART_ASSET_URL,
        },
    );
    assert.deepEqual(ERRORS, []);
    report = { status: 'PASS', provenance: report.provenance, scene: RESULT };
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    error.stack = SCRUB_INLINE_MODULES(error.stack);
    report = { ...report, error: error.stack };
    throw error;
} finally {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/textured-mesh-browser.json', JSON.stringify(report, null, 2));
    await BROWSER.close();
}

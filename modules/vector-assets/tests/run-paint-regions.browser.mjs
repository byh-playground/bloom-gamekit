import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { compileVectorAsset, compiledAssetModuleSource } from '../compiler.js';
import { applySvgPaintRegions } from '../paint-regions.js';

// One user flow: original SVG -> two independent palettes -> expression/motion -> RESET -> context recovery.
const SOURCE = await readFile('modules/vector-assets/tests/paint-regions.svg', 'utf8');
const PALETTES = [{ cheeks: [1, 0, 0], badge: [0, 1, 0] }, { cheeks: [0, 0, 1] }, null];
const ROOT = new DOMParser().parseFromString(SOURCE, 'image/svg+xml').documentElement;
const ORIGINAL = new XMLSerializer().serializeToString(ROOT);
const UI_SOURCES = PALETTES.map((palette) =>
    new XMLSerializer().serializeToString(applySvgPaintRegions(ROOT, palette)),
);
assert.equal(new XMLSerializer().serializeToString(ROOT), ORIGINAL, 'UI helper preserves the reusable source');
const ASSETS = [SOURCE, ...UI_SOURCES].map((source) =>
    compileVectorAsset(source, 'named-paint-scout.svg', { curveSegments: 16, strokeArcDivisions: 8 }),
);
const PLAIN = compileVectorAsset(SOURCE.replace(/ data-paint-region="[^"]+"/g, ''), 'plain.svg', {
    curveSegments: 16,
    strokeArcDivisions: 8,
});
assert.equal(PLAIN.geometry.paintRegions, undefined);
for (let i = 0; i < PLAIN.geometry.indices.length; i++) {
    for (let channel = 0; channel < 11; channel++) {
        assert.equal(
            ASSETS[0].geometry.vertices[ASSETS[0].geometry.indices[i] * 11 + channel],
            PLAIN.geometry.vertices[PLAIN.geometry.indices[i] * 11 + channel],
        );
    }
}
assert.throws(() => applySvgPaintRegions(ROOT, { missing: [1, 0, 0] }), /Unknown paint region/);
assert.throws(() => applySvgPaintRegions(ROOT, { cheeks: [1, 0, 0, 0.5] }), /three finite channels/);
assert.throws(
    () => compileVectorAsset(SOURCE.replace('data-paint-region="badge"', 'data-paint-region=""')),
    /stable name/,
);
assert.throws(
    () => compileVectorAsset(SOURCE.replace('id="body"', 'id="body" data-paint-region="body"')),
    /filled shape/,
);
const MODULE = (bytes) => 'data:text/javascript;base64,' + Buffer.from(bytes).toString('base64');
const INPUT = {
    rendering: MODULE(await readFile('dist/rendering.js')),
    vectors: MODULE(await readFile('dist/vector-assets.js')),
    loader: MODULE(await readFile('dist/vector-assets-loader.js')),
    assets: ASSETS.map((asset) => MODULE(compiledAssetModuleSource(asset, 'asset'))),
    source: SOURCE,
    uiSources: UI_SOURCES,
    palettes: PALETTES,
};
const OUTPUT = 'test-results/paint-regions';
await mkdir(OUTPUT, { recursive: true });
const SERVER = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Named fills</title>');
});
await new Promise((resolve) => SERVER.listen(0, '127.0.0.1', resolve));
const BROWSER = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const DEADLINE = setTimeout(() => BROWSER.close(), 180000);
DEADLINE.unref();
const RESULTS = [];
const ERRORS = [];
try {
    for (const BACKEND of ['uniform', 'auto', 'cpu']) {
        const PAGE = await BROWSER.newPage({ viewport: { width: 520, height: 330 }, deviceScaleFactor: 1 });
        PAGE.on('pageerror', (error) => ERRORS.push(error.message));
        await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/`);
        await PAGE.setContent(
            '<style>body{margin:16px;background:#fff;font:14px sans-serif}canvas{display:block;width:480px;height:100px;border:1px solid #aaa}.sources{display:flex}.sources svg{width:160px;height:100px}p{margin:8px 0}</style><p>GPU: red + green / blue / original</p><canvas width="480" height="100"></canvas><p>Original SVG with the same named fills</p><div class="sources"></div>',
        );
        const RESULT = await PAGE.evaluate(
            async ({ rendering, vectors, loader, assets, source, uiSources, palettes, backend }) => {
                const R = await import(rendering),
                    V = await import(vectors),
                    COMPILED = await Promise.all(assets.map(async (asset) => (await import(asset)).asset));
                const L = await import(loader),
                    LOADER = L.createVectorAssetLoader({ fetch: async () => new Response(source, { status: 200 }) }),
                    BROWSER_COMPILED = await LOADER.load('named-paint-scout.svg', {
                        sourcePath: 'named-paint-scout.svg',
                        expectedSha256: COMPILED[0].sourceSha256,
                        curveSegments: 16,
                        strokeArcDivisions: 8,
                    });
                if (
                    BROWSER_COMPILED.geometry.vertices.length !== COMPILED[0].geometry.vertices.length ||
                    !BROWSER_COMPILED.geometry.vertices.every(
                        (value, index) => value === COMPILED[0].geometry.vertices[index],
                    ) ||
                    JSON.stringify(BROWSER_COMPILED.geometry.paintRegions.names) !==
                        JSON.stringify(COMPILED[0].geometry.paintRegions.names) ||
                    !BROWSER_COMPILED.geometry.paintRegions.indices.every(
                        (value, index) => value === COMPILED[0].geometry.paintRegions.indices[index],
                    )
                ) {
                    throw new Error('Browser/Node named fill compiler mismatch');
                }
                COMPILED[0] = BROWSER_COMPILED;
                LOADER.dispose();
                const CANVAS = document.querySelector('canvas'),
                    DEVICE = new R.WebGLDevice(CANVAS, {
                        alpha: true,
                        depth: true,
                        antialias: false,
                        preserveDrawingBuffer: true,
                        checkGLErrors: true,
                    }),
                    MESHES = new R.MeshRenderer(DEVICE, { poseBackend: backend }),
                    RESOURCES = COMPILED.map((asset) => V.createVectorAsset(MESHES, asset)),
                    ACTUAL = Array.from({ length: 3 }, () => RESOURCES[0].createPlayer({ clip: 'idle' })),
                    REFERENCES = RESOURCES.slice(1).map((asset) => asset.createPlayer({ clip: 'idle' })),
                    PROJECTION = new Float32Array([2 / 480, 0, 0, 0, -2 / 100, 0, -1, 1, 1]);
                const CHECK = (value, message) => {
                    if (!value) {
                        throw new Error(message);
                    }
                };
                const SVG_ROOT = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
                const ORIGINAL = new XMLSerializer().serializeToString(SVG_ROOT);
                for (let i = 0; i < palettes.length; i++) {
                    const COLOURED = V.applySvgPaintRegions(SVG_ROOT, palettes[i]);
                    CHECK(
                        new XMLSerializer().serializeToString(COLOURED) === uiSources[i],
                        'Node/browser named-fill helper parity',
                    );
                    document.querySelector('.sources').append(COLOURED);
                }
                CHECK(
                    new XMLSerializer().serializeToString(SVG_ROOT) === ORIGINAL,
                    'No mutation or palette contamination of the original SVG',
                );
                const INFO = DEVICE.gl.getExtension('WEBGL_debug_renderer_info');
                const GPU = INFO
                    ? DEVICE.gl.getParameter(INFO.UNMASKED_RENDERER_WEBGL)
                    : DEVICE.gl.getParameter(DEVICE.gl.RENDERER);
                const GEOMETRY_BUFFERS = new Set(RESOURCES.map((resource) => resource.mesh.buffer));
                let geometryUpdates = 0;
                const UPLOAD = DEVICE.uploadVertices.bind(DEVICE);
                DEVICE.uploadVertices = (handle, data) => {
                    if (GEOMETRY_BUFFERS.has(handle)) {
                        geometryUpdates++;
                    }
                    return UPLOAD(handle, data);
                };
                function frame(
                    players,
                    paints,
                    { expression = 'neutral', motion = 'idle', time = 0, world = false, ...options } = {},
                ) {
                    DEVICE.beginFrame({ width: 480, height: 100, clearColor: [0, 0, 0, 0] });
                    MESHES.beginFrame();
                    for (let i = 0; i < players.length; i++) {
                        players[i].setExpression(expression);
                        if (players[i].currentClip !== motion) {
                            players[i].play(motion, 0);
                        }
                        players[i].seek(time);
                        players[i].draw({
                            ...(world
                                ? {
                                      viewProjection: [2 / 480, 0, 0, 0, 0, -2 / 100, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1],
                                      worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                                  }
                                : { projection: PROJECTION }),
                            matrix: [1, 0, 0, 1, i * 160, 0],
                            paintRegions: paints[i],
                            ...options,
                        });
                    }
                    MESHES.flush();
                    const PIXELS = new Uint8Array(480 * 100 * 4);
                    DEVICE.gl.readPixels(0, 0, 480, 100, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                    const GL_ERROR = DEVICE.gl.getError();
                    DEVICE.endFrame();
                    CHECK(GL_ERROR === DEVICE.gl.NO_ERROR, 'WebGL GL_ERROR ' + GL_ERROR);
                    return PIXELS;
                }
                let maxDifference = 0;
                const CASES = [
                    {},
                    { expression: 'happy' },
                    { motion: 'walk', time: 125 },
                    { motion: 'walk', time: 500, expression: 'happy', color: [0.8, 0.9, 1, 0.7], alpha: 0.6 },
                    { whiteFlash: true },
                    { forceColor: true, color: [0.2, 0.5, 0.9, 0.4] },
                    {
                        clips: [
                            [
                                { x: 8, y: 8 },
                                { x: 472, y: 8 },
                                { x: 472, y: 88 },
                                { x: 8, y: 88 },
                            ],
                        ],
                    },
                    { world: true, expression: 'happy' },
                    {
                        world: true,
                        clips: [
                            [
                                { x: 8, y: 8 },
                                { x: 472, y: 8 },
                                { x: 472, y: 88 },
                                { x: 8, y: 88 },
                            ],
                        ],
                    },
                ];
                if (backend === 'cpu') {
                    CASES.push({ depthWrite: true, depthWriteAlphaThreshold: 0.7 });
                }
                for (const OPTIONS of CASES) {
                    const EXPECTED = frame(REFERENCES, [null, null, null], OPTIONS),
                        ACTUAL_PIXELS = frame(ACTUAL, palettes, OPTIONS);
                    for (let i = 0; i < ACTUAL_PIXELS.length; i++) {
                        maxDifference = Math.max(maxDifference, Math.abs(ACTUAL_PIXELS[i] - EXPECTED[i]));
                    }
                    CHECK(
                        maxDifference <= 1,
                        'Named RGB override changed original alpha, stroke, expression or geometry: ' + maxDifference,
                    );
                }
                const BASELINE = frame(ACTUAL, [null, null, null]);
                const RESET = frame(ACTUAL, [{}, null, {}]);
                CHECK(
                    RESET.every((value, index) => value === BASELINE[index]),
                    'Reset restores original colours',
                );
                const CREATION_COUNT = DEVICE.stats.meshCreates;
                for (let i = 0; i < 60; i++) {
                    frame(ACTUAL, i % 2 ? palettes : [palettes[1], null, palettes[0]], {
                        time: i * 13.7,
                        motion: 'walk',
                    });
                }
                CHECK(
                    geometryUpdates === 0 && DEVICE.stats.meshCreates === CREATION_COUNT,
                    'Per-frame geometry recreation or upload',
                );
                // Capture overrides before the caller mutates them, even before the batch flushes.
                DEVICE.beginFrame({ width: 480, height: 100, clearColor: [0, 0, 0, 0] });
                MESHES.beginFrame();
                const MUTABLE = { cheeks: [1, 0, 0], badge: [0, 1, 0] };
                ACTUAL[0].play('idle', 0);
                ACTUAL[0].seek(0);
                ACTUAL[0].draw({ projection: PROJECTION, paintRegions: MUTABLE });
                let rejected = false;
                try {
                    ACTUAL[1].draw({ projection: PROJECTION, paintRegions: { missing: [1, 0, 0] } });
                } catch (error) {
                    rejected = /Unknown paint region/.test(error.message);
                }
                CHECK(rejected, 'Unknown runtime region rejected without changing the queued palette');
                MUTABLE.cheeks[0] = 0;
                MUTABLE.cheeks[2] = 1;
                MESHES.flush();
                const CAPTURED = new Uint8Array(480 * 100 * 4);
                DEVICE.gl.readPixels(0, 0, 480, 100, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, CAPTURED);
                DEVICE.endFrame();
                const EXPECTED_CAPTURE = frame(REFERENCES, [null, null, null]);
                CHECK(
                    CAPTURED.every(
                        (value, index) =>
                            Math.floor(index / 4) % 480 >= 160 || Math.abs(value - EXPECTED_CAPTURE[index]) <= 1,
                    ),
                    'Queued draw captured RGB values before caller mutation',
                );
                const CAPTURE_PIXELS = frame(ACTUAL, palettes);
                CHECK(
                    CAPTURE_PIXELS.every((value, index) => Math.abs(value - EXPECTED_CAPTURE[index]) <= 1),
                    'Independent player palettes',
                );
                // Browser context recovery must re-upload the packed region attribute, not the 11-float source layout.
                const EXT = DEVICE.gl.getExtension('WEBGL_lose_context');
                CHECK(EXT, 'Context loss extension required');
                const LOST = new Promise((resolve) =>
                    CANVAS.addEventListener(
                        'webglcontextlost',
                        (event) => {
                            event.preventDefault();
                            resolve();
                        },
                        { once: true },
                    ),
                );
                EXT.loseContext();
                await LOST;
                await new Promise((resolve) => setTimeout(resolve, 50));
                const RESTORED = new Promise((resolve) =>
                    CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
                );
                EXT.restoreContext();
                await Promise.race([
                    RESTORED,
                    new Promise((_resolve, reject) =>
                        setTimeout(() => reject(new Error('Context restoration timed out')), 10000),
                    ),
                ]);
                const RESTORED_PIXELS = frame(ACTUAL, palettes),
                    EXPECTED_RESTORED = frame(REFERENCES, [null, null, null]);
                CHECK(
                    RESTORED_PIXELS.every((value, index) => Math.abs(value - EXPECTED_RESTORED[index]) <= 1),
                    'Restored named fills match originals',
                );
                frame(ACTUAL, palettes);
                const STATS = MESHES.stats();
                const BEFORE_DISPOSE = {
                    contextRestoreGeometryUploads: geometryUpdates,
                    retainedMeshes: MESHES.meshes.size,
                    sharedAssetPlayers: RESOURCES[0].playerCount,
                    geometryUploads: STATS.geometryUploads,
                    meshCreates: DEVICE.stats.meshCreates,
                };
                for (const RESOURCE of RESOURCES) {
                    RESOURCE.dispose();
                }
                CHECK(MESHES.meshes.size === 0 && MESHES.bytes === 0, 'Dispose releases retained mesh resources');
                MESHES.dispose();
                DEVICE.dispose();
                return {
                    backend,
                    gpu: GPU,
                    maxDifference,
                    scenarios: CASES.length,
                    framesWithoutGeometryUploads: 60,
                    beforeDispose: BEFORE_DISPOSE,
                };
            },
            { ...INPUT, backend: BACKEND },
        );
        RESULTS.push(RESULT);
        await PAGE.screenshot({ path: `${OUTPUT}/${BACKEND}.png` });
        await PAGE.close();
    }
    assert.deepEqual(ERRORS, []);
    await writeFile(
        `${OUTPUT}/report.json`,
        JSON.stringify({ status: 'PASS', results: RESULTS, errors: ERRORS }, null, 2),
    );
    console.log(JSON.stringify({ status: 'PASS', results: RESULTS }));
} finally {
    clearTimeout(DEADLINE);
    await BROWSER.close();
    SERVER.close();
}

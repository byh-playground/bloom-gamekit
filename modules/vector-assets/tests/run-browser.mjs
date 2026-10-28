import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { exerciseVectorAssets } from './runtime.browser.mjs';
import { exerciseRendererInterleaving } from '../../rendering/tests/interop.browser.mjs';
import { exerciseOrderedAssetBatch } from '../../rendering/tests/ordered-batch.browser.mjs';
import { exerciseMeshDepth } from '../../rendering/tests/mesh-depth.browser.mjs';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseNonScalingStroke } from './non-scaling-stroke.browser.mjs';
import { exerciseWorldVectorRendering } from './world-rendering.browser.mjs';
const ROOT = resolve('.');
const SOURCE_URL =
    'https://raw.githubusercontent.com/byh-playground/budmori-io/69b267960252e009e754ae1aa38b03bfa0329d4f/assets/troops/pea.svg';
const SOURCE_BYTES = await readFile(resolve(ROOT, 'modules/vector-assets/assets/seed-scout.svg'));
const RENDERING_BUNDLE = await readFile(resolve(ROOT, 'dist/rendering.js'));
const RENDERING_MODULE_URL = 'data:text/javascript;base64,' + RENDERING_BUNDLE.toString('base64');
const VECTOR_ASSETS_BUNDLE = await readFile(resolve(ROOT, 'dist/vector-assets.js'));
const VECTOR_ASSETS_MODULE_URL = 'data:text/javascript;base64,' + VECTOR_ASSETS_BUNDLE.toString('base64');
const EXECUTABLE_PATH =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((path) => existsSync(path));
if (!EXECUTABLE_PATH) {
    throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
}
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const FALLBACK_PAGE = await BROWSER.newPage({
        viewport: {
            width: 844,
            height: 390,
        },
        hasTouch: true,
        deviceScaleFactor: 1,
    });
    await FALLBACK_PAGE.route(SOURCE_URL, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'image/svg+xml; charset=utf-8',
            body: SOURCE_BYTES,
        }),
    );
    const FALLBACK_ERRORS = [];
    FALLBACK_PAGE.on('pageerror', (error) => FALLBACK_ERRORS.push(error.message));
    await FALLBACK_PAGE.addInitScript(() => {
        const GET_CONTEXT = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...options) {
            if (type === 'webgl2') {
                return null;
            }
            return GET_CONTEXT.call(this, type, ...options);
        };
    });
    await FALLBACK_PAGE.goto(pathToFileURL(resolve(ROOT, 'dist/previews/vector-assets.html')).href);
    await FALLBACK_PAGE.waitForFunction(
        () => Boolean(window.vectorAssetDemo?.sourceLoaded || window.vectorAssetDemo?.error),
        null,
        {
            timeout: 15000,
        },
    );
    const FALLBACK = await FALLBACK_PAGE.evaluate(() => {
        const DEMO = window.vectorAssetDemo,
            SVG = document.querySelector('#source-svg');
        const SOURCE_STAGE = document.querySelector('#source-stage').getBoundingClientRect();
        return {
            sourceLoaded: Boolean(
                DEMO?.sourceSvg && SVG?.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').length,
            ),
            sourceVisible: Boolean(
                SVG && getComputedStyle(SVG).display !== 'none' && SOURCE_STAGE.width > 0 && SOURCE_STAGE.height > 0,
            ),
            sourceMetrics: document.querySelector('#source-metrics').textContent,
            webglNotice: document.querySelector('#gamekit-metrics').textContent,
            webglNoticeVisible:
                document.querySelector('#gamekit-metrics').closest('.panel').id === 'gamekit-stage' ||
                document
                    .querySelector('#gamekit-stage')
                    .closest('.panel')
                    .contains(document.querySelector('#gamekit-metrics')),
            gamekitMetrics: document.querySelector('#gamekit-metrics').textContent,
            exampleError: DEMO?.error ?? null,
        };
    });
    assert.equal(
        FALLBACK.sourceLoaded,
        true,
        'the remote source SVG is loaded independently before WebGL initialization: ' + JSON.stringify(FALLBACK),
    );
    assert.equal(
        FALLBACK.sourceVisible,
        true,
        'the source SVG remains visible in a browser with WebGL disabled: ' + JSON.stringify(FALLBACK),
    );
    assert.match(
        FALLBACK.sourceMetrics,
        /SHA [a-f0-9]{12}/,
        'source metrics remain available without WebGL: ' + JSON.stringify(FALLBACK),
    );
    assert.match(FALLBACK.webglNotice, /WebGL unavailable/i);
    assert.equal(FALLBACK.webglNoticeVisible, true, 'the WebGL error appears in the GameKit panel');
    assert.match(FALLBACK.gamekitMetrics, /did not provide a WebGL 2 context/i);
    assert.equal(FALLBACK.exampleError, 'WebGL 2 required');
    if (FALLBACK_ERRORS.length) {
        throw new Error('WebGL-unavailable page errors: ' + FALLBACK_ERRORS.join('; '));
    }
    await FALLBACK_PAGE.close();
    const PAGE = await BROWSER.newPage({
        viewport: {
            width: 1200,
            height: 800,
        },
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    await PAGE.route(SOURCE_URL, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'image/svg+xml; charset=utf-8',
            body: SOURCE_BYTES,
        }),
    );
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(pathToFileURL(resolve(ROOT, 'dist/previews/vector-assets.html')).href);
    await PAGE.waitForFunction(() => Boolean(window.vectorAssetDemo?.ready || window.vectorAssetDemo?.error), null, {
        timeout: 15000,
    });
    const EXAMPLE_ERROR = await PAGE.evaluate(() => window.vectorAssetDemo?.error ?? null);
    if (EXAMPLE_ERROR) {
        throw new Error('Example initialization failed: ' + EXAMPLE_ERROR);
    }
    const INCLUDE_POPULATION_TIMING_DIAGNOSTICS = process.argv.includes('--population-timing');
    const REPORT = await exerciseVectorAssets(PAGE, {
        includePopulationTimingDiagnostics: INCLUDE_POPULATION_TIMING_DIAGNOSTICS,
    });
    REPORT.rendererInterleaving = await exerciseRendererInterleaving(PAGE, RENDERING_MODULE_URL);
    assert.deepEqual(REPORT.rendererInterleaving.redVector, [255, 0, 0, 255]);
    assert.deepEqual(REPORT.rendererInterleaving.blueMesh, [0, 0, 255, 255]);
    assert.deepEqual(REPORT.rendererInterleaving.greenVector, [0, 255, 0, 255]);
    assert.equal(REPORT.rendererInterleaving.glError, 0);
    REPORT.orderedAssetBatch = await exerciseOrderedAssetBatch(PAGE, RENDERING_MODULE_URL);
    assert.equal(REPORT.orderedAssetBatch.pixelMismatch, 0);
    assert.equal(REPORT.orderedAssetBatch.batched.draws, 1);
    REPORT.meshDepth = await exerciseMeshDepth(PAGE, RENDERING_MODULE_URL);
    const NON_SCALING_ASSET = await compileVectorAssetFile(
        resolve(ROOT, 'modules/vector-assets/tests/non-scaling-stroke.svg'),
    );
    const EVIDENCE_DIRECTORY = resolve(ROOT, '..', 'evidence');
    await mkdir(EVIDENCE_DIRECTORY, {
        recursive: true,
    });
    const NON_SCALING_EVIDENCE = resolve(EVIDENCE_DIRECTORY, 'non-scaling-stroke-webgl.png');
    REPORT.nonScalingStroke = await exerciseNonScalingStroke(
        BROWSER,
        RENDERING_MODULE_URL,
        {
            ...NON_SCALING_ASSET.geometry,
            vertices: Array.from(NON_SCALING_ASSET.geometry.vertices),
            indices: Array.from(NON_SCALING_ASSET.geometry.indices),
        },
        NON_SCALING_EVIDENCE,
    );
    REPORT.nonScalingStroke.evidencePath = NON_SCALING_EVIDENCE;
    const WORLD_VECTOR_ASSET = await compileVectorAssetFile(
        resolve(ROOT, 'modules/vector-assets/tests/world-shader.svg'),
    );
    const WORLD_GEOMETRY = WORLD_VECTOR_ASSET.geometry;
    const WORLD_COMPILED = {
        ...WORLD_VECTOR_ASSET,
        geometry: {
            ...WORLD_GEOMETRY,
            vertices: Array.from(WORLD_GEOMETRY.vertices),
            indices: Array.from(WORLD_GEOMETRY.indices),
            expressionIndices: Object.fromEntries(
                Object.entries(WORLD_GEOMETRY.expressionIndices ?? {}).map(([key, value]) => [key, Array.from(value)]),
            ),
            indexVariants: Object.fromEntries(
                Object.entries(WORLD_GEOMETRY.indexVariants ?? {}).map(([key, value]) => [key, Array.from(value)]),
            ),
            shaderSurfaces: WORLD_GEOMETRY.shaderSurfaces?.map((surface) => ({
                ...surface,
                fillVertices: Array.from(surface.fillVertices),
                outline: Array.from(surface.outline),
                edgeColors: Array.from(surface.edgeColors),
            })),
        },
    };
    REPORT.worldVector = await exerciseWorldVectorRendering(
        BROWSER,
        RENDERING_MODULE_URL,
        VECTOR_ASSETS_MODULE_URL,
        WORLD_COMPILED,
        resolve(EVIDENCE_DIRECTORY, 'digmory-world-vector.png'),
    );
    await PAGE.locator('#style-comparison').click();
    await PAGE.waitForFunction(() => window.vectorAssetDemo?.styleReady || window.vectorAssetDemo?.styleError, null, {
        timeout: 15000,
    });
    const STYLE_ERROR = await PAGE.evaluate(() => window.vectorAssetDemo?.styleError ?? null);
    if (STYLE_ERROR) {
        throw new Error('Style sample initialization failed: ' + STYLE_ERROR);
    }
    const STYLES = await PAGE.evaluate(() => {
        const DEMO = window.vectorAssetDemo;
        const SAMPLE = (time) => {
            for (const ITEM of DEMO.styleInstances) {
                ITEM.actor.seek(time);
            }
            return JSON.stringify(DEMO.styleInstances.map((item) => item.actor.partPoses()));
        };
        const FIRST = SAMPLE(987.5),
            MIDDLE = SAMPLE(2100),
            REPEATED = SAMPLE(987.5);
        const SKETCH = DEMO.styleInstances.find((item) => item.id === 'sketch-fox');
        const MORPH_AT = (time) => {
            SKETCH.actor.seek(time);
            return SKETCH.actor.partPoses().map((pose) => pose.morph);
        };
        const MORPH_FIRST = MORPH_AT(987.5),
            MORPH_LATER = MORPH_AT(2100),
            MORPH_REPEATED = MORPH_AT(987.5);
        const PIXELS_AT = (time) => {
            DEMO.renderStyleSamples(time);
            const GL = SKETCH.device.gl,
                PIXELS = new Uint8Array(SKETCH.canvas.width * SKETCH.canvas.height * 4);
            GL.readPixels(0, 0, SKETCH.canvas.width, SKETCH.canvas.height, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        };
        const SKETCH_PIXELS_FIRST = PIXELS_AT(987.5),
            SKETCH_PIXELS_LATER = PIXELS_AT(2100),
            SKETCH_PIXELS_REPEATED = PIXELS_AT(987.5);
        let sketchPixelDifference = 0;
        let sketchPixelRepeatDifference = 0;
        for (let index = 0; index < SKETCH_PIXELS_FIRST.length; index++) {
            if (SKETCH_PIXELS_FIRST[index] !== SKETCH_PIXELS_LATER[index]) {
                sketchPixelDifference++;
            }
            if (SKETCH_PIXELS_FIRST[index] !== SKETCH_PIXELS_REPEATED[index]) {
                sketchPixelRepeatDifference++;
            }
        }
        DEMO.renderStyleSamples(987.5);
        const CANVASES = [...document.querySelectorAll('#style-dialog canvas')];
        const RESULT = {
            opened: document.querySelector('#style-dialog').open,
            ids: DEMO.styleInstances.map((item) => item.id),
            sameSourceBytes: DEMO.styleInstances.map((item) => item.sourceSha),
            visibleSources: ['#style-yarn-source svg', '#style-sketch-source svg'].map((selector) =>
                Boolean(document.querySelector(selector)),
            ),
            renderedCanvases: CANVASES.length,
            actualWebGL: DEMO.styleInstances.every(
                (item) => item.device.state === 'ready' && item.meshes.stats().draws > 0,
            ),
            deterministicAbsoluteSeek: FIRST === REPEATED,
            changedBetweenSamples: FIRST !== MIDDLE,
            deterministicPartMorphSeek: JSON.stringify(MORPH_FIRST) === JSON.stringify(MORPH_REPEATED),
            partMorphChangesWithDisplayTime: JSON.stringify(MORPH_FIRST) !== JSON.stringify(MORPH_LATER),
            sketchPixelDifference,
            sketchPixelRepeatDifference,
            partMorphWeights: MORPH_FIRST,
            morphCounts: DEMO.styleInstances.map((item) => item.asset.mesh.morphCount),
            metrics: ['#style-yarn-metrics', '#style-sketch-metrics'].map(
                (selector) => document.querySelector(selector).textContent,
            ),
        };
        return RESULT;
    });
    assert.deepEqual(STYLES.ids, ['yarn-fox', 'sketch-fox']);
    assert.deepEqual(STYLES.visibleSources, [true, true], 'each source SVG appears beside its compiled GameKit render');
    assert.equal(STYLES.renderedCanvases, 2);
    assert.equal(STYLES.actualWebGL, true, 'both authored style samples render through GameKit WebGL');
    assert.equal(STYLES.deterministicAbsoluteSeek, true, 'rollback/seek recreates the exact same authored pose');
    assert.equal(STYLES.changedBetweenSamples, true, 'the authored clip changes as display time moves');
    assert.equal(STYLES.deterministicPartMorphSeek, true, 'part-level morph weights reproduce after rollback seek');
    assert.equal(STYLES.partMorphChangesWithDisplayTime, true, 'part-level morph weights follow absolute display time');
    assert.ok(STYLES.sketchPixelDifference > 0, 'animated sketch morphs change actual WebGL pixels');
    assert.equal(STYLES.sketchPixelRepeatDifference, 0, 'the same sketch timestamp reproduces the same WebGL pixels');
    assert.deepEqual(STYLES.morphCounts, [0, 2], 'only the sketch clip declares two fixed-topology targets');
    REPORT.styles = STYLES;
    await PAGE.locator('#style-dialog-close').click();
    const DISPOSED = await PAGE.evaluate(() => {
        const DEMO = window.vectorAssetDemo,
            OLD_DEVICES = DEMO.styleInstances.map((item) => item.device);
        DEMO.disposeStyleSamples();
        return {
            states: OLD_DEVICES.map((device) => device.state),
            liveAssets: DEMO.styleInstances.length,
        };
    });
    assert.deepEqual(DISPOSED.states, ['disposed', 'disposed']);
    assert.equal(DISPOSED.liveAssets, 0);
    await PAGE.locator('#style-comparison').click();
    await PAGE.waitForFunction(() => window.vectorAssetDemo?.styleReady || window.vectorAssetDemo?.styleError, null, {
        timeout: 15000,
    });
    const RECREATED = await PAGE.evaluate(() => ({
        count: window.vectorAssetDemo.styleInstances.length,
        devicesReady: window.vectorAssetDemo.styleInstances.every((item) => item.device.state === 'ready'),
    }));
    assert.deepEqual(
        RECREATED,
        {
            count: 2,
            devicesReady: true,
        },
        'style assets recreate after clean disposal',
    );
    REPORT.stylesLifecycle = {
        disposed: DISPOSED,
        recreated: RECREATED,
    };
    if (ERRORS.length) {
        throw new Error('Browser page errors: ' + ERRORS.join('; '));
    }
    console.log(
        JSON.stringify(
            {
                ...REPORT,
                fallback: FALLBACK,
                browser: await BROWSER.version(),
                execution:
                    'file:// standalone HTML; browser fetch served the exact committed source SVG bytes for offline determinism; Chromium WebGL 2 / SwiftShader and WebGL-disabled fallback',
            },
            null,
            2,
        ),
    );
    await PAGE.close();
} finally {
    await BROWSER.close();
}

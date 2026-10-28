import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Real WebGL2: regions of one array layer keep their own pixels, gutters extend or stay clear,
// released rectangles are cleared and reused, and context restoration replays every retained region.
const BYTES = await readFile('dist/rendering.js');
const MODULE_URL = 'data:text/javascript;base64,' + BYTES.toString('base64');
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
try {
    const PAGE = await BROWSER.newPage();
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.stack));
    await PAGE.setContent('<canvas width="64" height="64"></canvas>');
    const RESULT = await PAGE.evaluate(async (url) => {
        const { WebGLDevice: WEB_GL_DEVICE, TextureAtlasArray: TEXTURE_ATLAS_ARRAY } = await import(url);
        const CHECK = (condition, message) => {
            if (!condition) {
                throw new Error(message);
            }
        };
        const CANVAS = document.querySelector('canvas');
        const DEVICE = new WEB_GL_DEVICE(CANVAS, { alpha: false, preserveDrawingBuffer: true, checkGLErrors: true });
        const ATLAS = new TEXTURE_ATLAS_ARRAY(DEVICE, { width: 32, height: 32, layers: 2, gutter: 1 });
        const SOLID = (width, height, color) => {
            const DATA = new Uint8Array(width * height * 4);
            for (let i = 0; i < width * height; i++) {
                DATA.set(color, i * 4);
            }
            return { width, height, data: DATA };
        };
        const READ = (layer, x, y) => {
            const TARGET = DEVICE.createTextureLayerTarget(ATLAS.texture, layer);
            DEVICE.beginFrame({ width: 64, height: 64 });
            DEVICE.bindRenderTarget(TARGET);
            const PIXEL = new Uint8Array(4);
            DEVICE.gl.readPixels(x, y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXEL);
            DEVICE.unbindRenderTarget(TARGET);
            DEVICE.endFrame();
            DEVICE.deleteRenderTarget(TARGET);
            return Array.from(PIXEL);
        };
        const A = ATLAS.allocate(4, 4),
            B = ATLAS.allocate(4, 4),
            C = ATLAS.allocate(4, 1);
        CHECK(A.layer === 0 && B.layer === 0 && B.x > A.x, 'Same-height regions share a shelf');
        CHECK(A.uvRect[2] === 4 / 32, 'uvRect is normalized by the array size');
        ATLAS.upload(A, SOLID(4, 4, [255, 0, 0, 255]));
        ATLAS.upload(B, SOLID(4, 4, [0, 255, 0, 255]), { extendEdges: true });
        ATLAS.upload(C, SOLID(4, 1, [0, 0, 255, 255]), { extendEdges: true });
        const SNAPSHOT = () => ({
            a: READ(A.layer, A.x + 1, A.y + 1),
            aGutter: READ(A.layer, A.x - 1, A.y),
            bGutter: READ(B.layer, B.x - 1, B.y),
            cGutterAbove: READ(C.layer, C.x, C.y - 1),
        });
        const BEFORE = SNAPSHOT();
        CHECK(BEFORE.a.join() === '255,0,0,255', 'Region keeps its own pixels');
        CHECK(BEFORE.aGutter[3] === 0, 'Gutter stays transparent without extendEdges');
        CHECK(BEFORE.bGutter.join() === '0,255,0,255', 'extendEdges replicates the edge into the gutter');
        CHECK(BEFORE.cGutterAbove.join() === '0,0,255,255', '1-row ramp extends vertically');
        let full = null;
        try {
            for (let i = 0; i < 100; i++) {
                ATLAS.allocate(30, 30);
            }
        } catch (error) {
            full = error.message;
        }
        CHECK(/full/.test(full), 'Exhausted array is reported');
        const OLD = { layer: A.layer, x: A.x, y: A.y };
        CHECK(ATLAS.release(A) && !ATLAS.release(A), 'Release is idempotent');
        CHECK(READ(OLD.layer, OLD.x + 1, OLD.y + 1)[3] === 0, 'Released pixels are cleared');
        const REUSED = ATLAS.allocate(4, 4);
        CHECK(REUSED.layer === OLD.layer && REUSED.x === OLD.x && REUSED.y === OLD.y, 'Same-size rectangle reused');
        ATLAS.upload(REUSED, SOLID(4, 4, [9, 9, 9, 255]));
        const EXT = DEVICE.gl.getExtension('WEBGL_lose_context');
        const LOST = new Promise((resolve) =>
            CANVAS.addEventListener('webglcontextlost', (event) => (event.preventDefault(), resolve()), { once: true }),
        );
        EXT.loseContext();
        await LOST;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const RESTORED = new Promise((resolve) =>
            CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
        );
        EXT.restoreContext();
        await RESTORED;
        CHECK(READ(REUSED.layer, REUSED.x + 1, REUSED.y + 1).join() === '9,9,9,255', 'Restore replays reused region');
        CHECK(READ(B.layer, B.x - 1, B.y).join() === '0,255,0,255', 'Restore replays gutter extension');
        CHECK(DEVICE.gl.getError() === DEVICE.gl.NO_ERROR, 'No GL error');
        return { checks: 'ok', stats: ATLAS.stats };
    }, MODULE_URL);
    assert.deepEqual(ERRORS, []);
    console.log(JSON.stringify({ status: 'PASS', ...RESULT }));
} finally {
    await BROWSER.close();
}

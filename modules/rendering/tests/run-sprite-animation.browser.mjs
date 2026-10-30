import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

// Public bundle on a real WebGL2 canvas. Two independent clocks sample one region of the shared texture atlas
// through the VectorContext stream, before/after context restoration.
const RENDERING_BYTES = await readFile('dist/rendering.js');
const MODULE_URL = 'data:text/javascript;base64,' + RENDERING_BYTES.toString('base64');
const PROVENANCE = {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty:
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
    renderingSha256: createHash('sha256').update(RENDERING_BYTES).digest('hex'),
};
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
let report = { status: 'FAIL', provenance: { ...PROVENANCE, browserVersion: BROWSER.version() } };
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 160, height: 128 }, deviceScaleFactor: 1 });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.stack));
    await PAGE.setContent('<canvas width="128" height="128"></canvas>');
    const RESULT = await PAGE.evaluate(async (url) => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorContext: VECTOR_CONTEXT,
            createSpriteAnimation: CREATE_SPRITE,
        } = await import(url);
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
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const CTX = new VECTOR_CONTEXT(DEVICE);
        const GL = DEVICE.gl;
        const INFO = GL.getExtension('WEBGL_debug_renderer_info');
        const HARDWARE = {
            renderer: INFO ? GL.getParameter(INFO.UNMASKED_RENDERER_WEBGL) : GL.getParameter(GL.RENDERER),
            vendor: INFO ? GL.getParameter(INFO.UNMASKED_VENDOR_WEBGL) : GL.getParameter(GL.VENDOR),
            version: GL.getParameter(GL.VERSION),
        };
        const SHEET_BYTES = new Uint8Array(14 * 6 * 4);
        // Row zero is the GPU bottom row. Each 2x2 cell has a one-pixel
        // transparent gutter, so linear filtering cannot sample its neighbor.
        for (let row = 3; row <= 4; row++) {
            for (let column = 1; column <= 2; column++) {
                SHEET_BYTES.set([255, 0, 0, 255], (row * 14 + column) * 4);
            }
            for (let column = 5; column <= 6; column++) {
                SHEET_BYTES.set([0, 255, 0, 128], (row * 14 + column) * 4);
            }
        }
        for (let row = 2; row <= 4; row++) {
            for (let column = 10; column <= 12; column++) {
                SHEET_BYTES.set([0, 0, 255, 255], (row * 14 + column) * 4);
            }
        }
        const REGION = DEVICE.textureAtlas.allocate(14, 6);
        DEVICE.textureAtlas.upload(REGION, { width: 14, height: 6, data: SHEET_BYTES });
        const DEFINITION = {
            textureOrigin: 'bottom-left',
            sourceWidth: 4,
            sourceHeight: 4,
            pivotX: 2,
            pivotY: 2,
            gutter: 1,
            frames: [
                { x: 1, y: 1, width: 2, height: 2, sourceX: 1, sourceY: 1, durationMs: 50 },
                { x: 5, y: 1, width: 2, height: 2, sourceX: 1, sourceY: 1, durationMs: 100 },
                {
                    x: 10,
                    y: 1,
                    width: 3,
                    height: 3,
                    sourceX: 1,
                    sourceY: 1,
                    sourceWidth: 6,
                    sourceHeight: 5,
                    pivotX: 2,
                    pivotY: 2,
                    durationMs: 75,
                },
            ],
            clips: {
                loop: { frames: [0, 1], loop: 'loop' },
                once: { frames: [0, 1], loop: 'once' },
                large: { frames: [2], loop: 'once' },
            },
        };
        let sprite;
        let first;
        let second;
        let third;
        try {
            const EXPECT_THROW = (action, label) => {
                let threw = false;
                try {
                    action();
                } catch (error) {
                    threw = error instanceof TypeError || error instanceof RangeError;
                }
                CHECK(threw, label);
            };
            EXPECT_THROW(
                () => CREATE_SPRITE(CTX, REGION, { ...DEFINITION, textureOrigin: 'sideways' }),
                'invalid texture origin rejected',
            );
            EXPECT_THROW(
                () => CREATE_SPRITE(CTX, REGION, { ...DEFINITION, gutter: 2 }),
                'gutter outside atlas rejected',
            );
            EXPECT_THROW(
                () =>
                    CREATE_SPRITE(CTX, REGION, {
                        ...DEFINITION,
                        clips: { bad: { frames: [DEFINITION.frames.length] } },
                    }),
                'unknown clip frame rejected',
            );
            sprite = CREATE_SPRITE(CTX, REGION, DEFINITION);
            first = sprite.createActor({ clip: 'loop', startedAtMs: 0 });
            second = sprite.createActor({ clip: 'loop', startedAtMs: 50 });
            const STATS = sprite.stats();
            CHECK(
                STATS.frameCount === 3 &&
                    STATS.clipCount === 3 &&
                    STATS.actorCount === 2 &&
                    STATS.retainedBytes === 0 &&
                    STATS.textureOwned === false,
                'sprite animation retains no GPU geometry and borrows its atlas region',
            );
            CHECK(first.sample(-100).frameIndex === 0, 'negative time clamps to first frame');
            CHECK(first.sample(50).frameIndex === 1, 'exact frame boundary selects next frame');
            CHECK(first.sample(150).frameIndex === 0, 'loop wraps on total duration');
            CHECK(first.sample(1_500_000_075).frameIndex === 1, 'large delta uses modulo without tick stepping');
            second.setClip('once', 0);
            CHECK(second.sample(500).frameIndex === 1 && second.sample(500).finished, 'once holds last frame');
            second.setClip('loop', 50);
            CHECK(first.sample(75).frameIndex === 1 && second.sample(75).frameIndex === 0, 'independent phase');
            first.setPaused(true, 75);
            CHECK(first.sample(1000).frameIndex === 1, 'pause holds phase');
            first.setRate(2, 1000).setPaused(false, 1000);
            CHECK(first.sample(1020).frameIndex === 1, 'rate change preserves phase');
            first.seek(0, 1050);
            CHECK(first.sample(1050).frameIndex === 0, 'absolute-time seek scrubs to first frame');
            first.seek(75, 75);
            first.setRate(1, 75);
            const PIXEL = (x, y) => {
                const BYTES = new Uint8Array(4);
                GL.readPixels(x, CANVAS.height - 1 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, BYTES);
                return [...BYTES];
            };
            const DRAW_SCENE = (timeMs) => {
                CHECK(
                    CTX.beginFrame({ width: CANVAS.width, height: CANVAS.height, clearColor: [0, 0, 0, 1] }),
                    'frame available',
                );
                first.draw({ timeMs, matrix: [16, 0, 0, 16, 24, 24] });
                second.draw({ timeMs, matrix: [16, 0, 0, 16, 72, 24] });
                const FRAME = CTX.endFrame();
                CHECK(GL.getError() === GL.NO_ERROR, 'sprite scene GL error');
                return FRAME;
            };
            const COLD = DRAW_SCENE(75);
            const BEFORE = {
                first: PIXEL(24, 24),
                second: PIXEL(72, 24),
                trimOutside: PIXEL(6, 24),
                gutterEdge: PIXEL(9, 24),
            };
            NEAR(BEFORE.first, [0, 128, 0, 255], 'second atlas frame alpha blends premultiplied');
            NEAR(BEFORE.second, [255, 0, 0, 255], 'independent first atlas frame');
            NEAR(BEFORE.trimOutside, [0, 0, 0, 255], 'trim and pivot place quad correctly');
            CHECK(BEFORE.gutterEdge[0] === 0 && BEFORE.gutterEdge[2] === 0, 'linear edge cannot bleed other frame');
            CHECK(COLD.drawCalls === 1, 'different atlas frames share one stream draw');
            third = sprite.createActor({ clip: 'large' });
            const ROTATED_MATRIX = [0, 16, -16, 0, 100, 50];
            CHECK(CTX.beginFrame({ width: 128, height: 128, clearColor: [0, 0, 0, 1] }), 'mixed frame available');
            first.draw({ timeMs: 75, matrix: [16, 0, 0, 16, 64, 64] });
            second.draw({ timeMs: 75, matrix: [16, 0, 0, 16, 64, 64] });
            third.draw({ timeMs: 75, matrix: ROTATED_MATRIX });
            const MIXED_FRAME = CTX.endFrame();
            CHECK(GL.getError() === GL.NO_ERROR, 'mixed sprite frame GL error');
            CHECK(MIXED_FRAME.drawCalls === 1, 'mixed trim, size, and UV rects share one batch');
            NEAR(PIXEL(64, 64), [255, 0, 0, 255], 'opaque later frame preserves painter order');
            NEAR(PIXEL(100, 50), [0, 0, 255, 255], 'rotated, differently trimmed frame uses its own local rect');
            NEAR(PIXEL(124, 50), [0, 0, 0, 255], 'trimmed frame outside remains transparent');
            CHECK(ROTATED_MATRIX.join(',') === '0,16,-16,0,100,50', 'caller matrix remains unchanged');
            const DOM_SHEET = document.createElement('canvas');
            DOM_SHEET.width = DOM_SHEET.height = 2;
            DOM_SHEET.getContext('2d').putImageData(
                new ImageData(
                    new Uint8ClampedArray([0, 0, 255, 255, 255, 255, 0, 255, 255, 0, 0, 255, 0, 255, 255, 255]),
                    2,
                    2,
                ),
                0,
                0,
            );
            const DOM_REGION = DEVICE.textureAtlas.allocate(2, 2, { filter: 'nearest' });
            DEVICE.textureAtlas.upload(DOM_REGION, DOM_SHEET);
            const DOM_SPRITE = CREATE_SPRITE(CTX, DOM_REGION, {
                frames: [{ x: 0, y: 0, width: 2, height: 2, durationMs: 100 }],
                clips: { still: { frames: [0], loop: 'once' } },
            });
            const DOM_ACTOR = DOM_SPRITE.createActor();
            CHECK(CTX.beginFrame({ width: 128, height: 128, clearColor: [0, 0, 0, 1] }), 'DOM frame available');
            DOM_ACTOR.draw({ timeMs: 0, matrix: [16, 0, 0, 16, 88, 80] });
            CTX.endFrame();
            const DOM_SAMPLES = { topLeft: PIXEL(96, 88), bottomLeft: PIXEL(96, 104) };
            NEAR(DOM_SAMPLES.topLeft, [0, 0, 255, 255], 'default DOM sheet top-left origin');
            NEAR(DOM_SAMPLES.bottomLeft, [255, 0, 0, 255], 'default DOM sheet bottom row');
            DOM_ACTOR.dispose();
            DOM_SPRITE.dispose();
            DEVICE.textureAtlas.release(DOM_REGION);
            CANVAS.width = 160;
            CANVAS.height = 128;
            DRAW_SCENE(75);
            NEAR(PIXEL(24, 24), BEFORE.first, 'resize preserves atlas UVs');
            const EXTENSION = GL.getExtension('WEBGL_lose_context');
            CHECK(EXTENSION, 'context loss extension required');
            const LOST = new Promise((resolve) => CANVAS.addEventListener('webglcontextlost', resolve, { once: true }));
            const RESTORED = new Promise((resolve) =>
                CANVAS.addEventListener('webglcontextrestored', resolve, { once: true }),
            );
            EXTENSION.loseContext();
            await LOST;
            await new Promise((resolve) => setTimeout(resolve, 50));
            EXTENSION.restoreContext();
            await Promise.race([
                RESTORED,
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Restore timed out')), 10000)),
            ]);
            CHECK(DEVICE.state === 'ready', 'WebGL2 device restored');
            DRAW_SCENE(75);
            const AFTER = { first: PIXEL(24, 24), second: PIXEL(72, 24) };
            NEAR(AFTER.first, BEFORE.first, 'atlas region restored');
            NEAR(AFTER.second, BEFORE.second, 'second actor phase restored');
            first.dispose();
            second.dispose();
            third.dispose();
            CHECK(
                sprite.dispose() && DEVICE.textureAtlas.regions.has(REGION),
                'sprite disposal leaves the borrowed atlas region alive',
            );
            CTX.dispose();
            CHECK(DEVICE.textureAtlas.regions.has(REGION), 'borrowed region survives context disposal');
            DEVICE.textureAtlas.release(REGION);
            const COUNTS = {
                buffers: DEVICE.buffers.size,
                textures: DEVICE.textures.size,
                targets: DEVICE.renderTargets.size,
                pipelines: DEVICE.pipelines.size,
                bufferBytes: DEVICE.stats.gpuBufferBytes,
                textureBytes: DEVICE.stats.gpuTextureBytes,
            };
            CHECK(
                Object.values(COUNTS).every((value) => value === 0),
                'all resources released after the last region is released',
            );
            return {
                hardware: HARDWARE,
                samples: BEFORE,
                domSamples: DOM_SAMPLES,
                restored: AFTER,
                stats: STATS,
                counts: COUNTS,
            };
        } finally {
            first?.dispose();
            second?.dispose();
            third?.dispose();
            sprite?.dispose();
            CTX.dispose();
            DEVICE.dispose();
            CANVAS.remove();
        }
    }, MODULE_URL);
    assert.deepEqual(ERRORS, []);
    report = { status: 'PASS', provenance: report.provenance, scene: RESULT };
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    report = { ...report, error: error.stack };
    throw error;
} finally {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/sprite-animation-browser.json', JSON.stringify(report, null, 2));
    await BROWSER.close();
}

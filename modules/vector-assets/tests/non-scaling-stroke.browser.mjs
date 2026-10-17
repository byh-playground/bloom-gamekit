import assert from 'node:assert/strict';
export async function exerciseNonScalingStroke(browser, moduleURL, compiledGeometry, screenshotPath) {
    const PAGE = await browser.newPage({
        viewport: {
            width: 420,
            height: 290,
        },
        deviceScaleFactor: 2,
    });
    const PAGE_ERRORS = [];
    PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    try {
        await PAGE.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:28px;background:#101820;color:#e8f0f3;font:16px/1.5 system-ui,sans-serif}
      h1{font-size:18px;font-weight:600;margin:0 0 14px}p{font-size:13px;color:#9fb0bb;margin:0 0 16px}
      canvas{display:block;background:#26343d;border:1px solid #6b7d87;image-rendering:auto}
    </style><h1>GameKit WebGL • SVG non-scaling-stroke</h1>
    <p>1.5 CSS px · retained SVG line · DPR 2 · non-uniform part transform</p><canvas></canvas>`);
        const RESULT = await PAGE.evaluate(
            async ({ moduleURL, geometry, screenshotPath: _screenshotPath }) => {
                const { WebGLDevice: WEB_GL_DEVICE, MeshRenderer: MESH_RENDERER } = await import(moduleURL);
                const CANVAS = document.querySelector('canvas');
                const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                    alpha: true,
                    antialias: true,
                    depth: true,
                });
                const RENDERER = new MESH_RENDERER(DEVICE);
                const MESH = RENDERER.createMesh({
                    ...geometry,
                    vertices: Float32Array.from(geometry.vertices),
                    indices: Uint16Array.from(geometry.indices),
                });
                const GEOMETRY_UPLOADS_AT_CREATION = RENDERER.stats().geometryUploads;
                const IDENTITY = [1, 0, 0, 1, 0, 0];
                const PROJECTION_FOR = (width, height, zoom = 1) => [
                    (2 * zoom) / width,
                    0,
                    0,
                    0,
                    (-2 * zoom) / height,
                    0,
                    -zoom,
                    zoom,
                    1,
                ];
                const TRANSFORMED = (x, y, part) => ({
                    x: part[0] * x + part[2] * y + part[4],
                    y: part[1] * x + part[3] * y + part[5],
                });
                const SCREEN = (point, projection, width, height) => {
                    const X = projection[0] * point.x + projection[3] * point.y + projection[6];
                    const Y = projection[1] * point.x + projection[4] * point.y + projection[7];
                    const W = projection[2] * point.x + projection[5] * point.y + projection[8];
                    return {
                        x: ((X / W + 1) * width) / 2,
                        y: ((1 - Y / W) * height) / 2,
                    };
                };
                const PIXEL_AT = (pixels, width, height, dpr, x, y) => {
                    const PX = Math.floor(x * dpr),
                        PY = height * dpr - 1 - Math.floor(y * dpr),
                        AT = (PY * width * dpr + PX) * 4;
                    return Array.from(pixels.subarray(AT, AT + 4));
                };
                const MEASURE = (pixels, width, height, dpr, start, end) => {
                    const DX = end.x - start.x,
                        DY = end.y - start.y,
                        LENGTH = Math.hypot(DX, DY),
                        WINDOW_START = 0.2,
                        WINDOW_END = 0.8;
                    let alpha = 0;
                    let maximum = 0;
                    let highestY = -Infinity;
                    for (let py = 0; py < height * dpr; py++) {
                        for (let px = 0; px < width * dpr; px++) {
                            const AT = (py * width * dpr + px) * 4 + 3,
                                VALUE = pixels[AT] / 255;
                            if (!VALUE) {
                                continue;
                            }
                            maximum = Math.max(maximum, pixels[AT]);
                            const X = (px + 0.5) / dpr,
                                Y = height - (py + 0.5) / dpr;
                            highestY = Math.max(highestY, Y);
                            const T = ((X - start.x) * DX + (Y - start.y) * DY) / (LENGTH * LENGTH);
                            const DISTANCE = Math.abs(DX * (start.y - Y) - (start.x - X) * DY) / LENGTH;
                            if (T >= WINDOW_START && T <= WINDOW_END && DISTANCE <= 4) {
                                alpha += VALUE;
                            }
                        }
                    }
                    return {
                        cssWidth: alpha / (dpr * dpr) / (LENGTH * (WINDOW_END - WINDOW_START)),
                        maximumAlpha: maximum,
                        highestY,
                        length: LENGTH,
                    };
                };
                const RENDER = (
                    name,
                    { width = 160, height = 100, dpr = 1, zoom = 1, part = IDENTITY, alpha = 1, clips = [] } = {},
                ) => {
                    CANVAS.style.width = `${width}px`;
                    CANVAS.style.height = `${height}px`;
                    const BACKING_WIDTH = width * dpr,
                        BACKING_HEIGHT = height * dpr;
                    DEVICE.beginFrame({
                        width: BACKING_WIDTH,
                        height: BACKING_HEIGHT,
                        clearColor: [0, 0, 0, 0],
                    });
                    RENDERER.beginFrame();
                    const PROJECTION = PROJECTION_FOR(width, height, zoom);
                    const PART_POSE = [
                        {
                            transform: part,
                        },
                    ];
                    RENDERER.drawMesh(MESH, {
                        projection: PROJECTION,
                        parts: PART_POSE,
                        alpha,
                        clips,
                        depthTest: true,
                        depthWrite: false,
                    });
                    RENDERER.flush();
                    const GL = DEVICE.gl,
                        PIXELS = new Uint8Array(BACKING_WIDTH * BACKING_HEIGHT * 4);
                    GL.readPixels(0, 0, BACKING_WIDTH, BACKING_HEIGHT, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                    DEVICE.endFrame();
                    const START_LOCAL = TRANSFORMED(20, 50, part),
                        END_LOCAL = TRANSFORMED(80, 50, part);
                    return {
                        name,
                        width,
                        height,
                        dpr,
                        pixels: PIXELS,
                        measure: MEASURE(
                            PIXELS,
                            width,
                            height,
                            dpr,
                            SCREEN(START_LOCAL, PROJECTION, width, height),
                            SCREEN(END_LOCAL, PROJECTION, width, height),
                        ),
                        fillSample: PIXEL_AT(PIXELS, width, height, dpr, 50, 10),
                        draws: RENDERER.stats().draws,
                    };
                };
                const IDENTITY_PART = [1, 0, 0, 1, 40, 0];
                const BASE = RENDER('css-160-dpr1', {
                    part: IDENTITY_PART,
                    dpr: 1,
                });
                const DPR2 = RENDER('css-160-dpr2', {
                    part: IDENTITY_PART,
                    dpr: 2,
                });
                const ZOOMED = RENDER('camera-zoom-1_5', {
                    part: IDENTITY_PART,
                    dpr: 2,
                    zoom: 1.5,
                });
                const ANIMATED_PART = [1, 0.35, -0.55, 0.65, 35, 20];
                const ANIMATED = RENDER('part-nonuniform-rotation', {
                    part: ANIMATED_PART,
                    dpr: 2,
                });
                const LARGER = RENDER('css-320-dpr1', {
                    width: 320,
                    height: 200,
                    part: [1, 0, 0, 1, 80, 0],
                    dpr: 1,
                });
                const RENDER_TARGET = DEVICE.createRenderTarget(320, 200);
                let renderTargetRequiresViewport = false;
                DEVICE.beginFrame({
                    width: 320,
                    height: 200,
                    clearColor: [0, 0, 0, 0],
                });
                RENDERER.beginFrame();
                DEVICE.bindRenderTarget(RENDER_TARGET);
                DEVICE.clear({
                    color: [0, 0, 0, 0],
                });
                try {
                    RENDERER.drawMesh(MESH, {
                        projection: PROJECTION_FOR(160, 100),
                        parts: [
                            {
                                transform: IDENTITY_PART,
                            },
                        ],
                    });
                } catch (error) {
                    renderTargetRequiresViewport = /strokeViewport/.test(error.message);
                }
                RENDERER.drawMesh(MESH, {
                    projection: PROJECTION_FOR(160, 100),
                    matrix: IDENTITY,
                    parts: [
                        {
                            transform: IDENTITY_PART,
                        },
                    ],
                    strokeViewport: [160, 100],
                });
                RENDERER.flush();
                const TARGET_PIXELS = new Uint8Array(320 * 200 * 4);
                DEVICE.gl.readPixels(0, 0, 320, 200, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, TARGET_PIXELS);
                DEVICE.unbindRenderTarget(RENDER_TARGET);
                DEVICE.endFrame();
                const OFFSCREEN = {
                    cssWidth: MEASURE(
                        TARGET_PIXELS,
                        160,
                        100,
                        2,
                        SCREEN(TRANSFORMED(20, 50, IDENTITY_PART), PROJECTION_FOR(160, 100), 160, 100),
                        SCREEN(TRANSFORMED(80, 50, IDENTITY_PART), PROJECTION_FOR(160, 100), 160, 100),
                    ).cssWidth,
                };
                const CLIPPED = RENDER('clipped-expanded-edge', {
                    part: IDENTITY_PART,
                    dpr: 2,
                    clips: [
                        [
                            {
                                x: 0,
                                y: 0,
                            },
                            {
                                x: 160,
                                y: 0,
                            },
                            {
                                x: 160,
                                y: 50.5,
                            },
                            {
                                x: 0,
                                y: 50.5,
                            },
                        ],
                    ],
                });
                const HALF_ALPHA = RENDER('half-alpha-depth', {
                    part: IDENTITY_PART,
                    dpr: 2,
                    alpha: 0.5,
                });
                const BASE_ALPHA = BASE.pixels.filter((_, i) => i % 4 === 3);
                if (!BASE_ALPHA.some((value) => value > 0)) {
                    throw new Error('WebGL stroke produced no pixels');
                }
                const CLIPPED_PIXELS = [];
                for (let py = 0; py < CLIPPED.height * CLIPPED.dpr; py++) {
                    for (let px = 0; px < CLIPPED.width * CLIPPED.dpr; px++) {
                        if (CLIPPED.pixels[(py * CLIPPED.width * CLIPPED.dpr + px) * 4 + 3]) {
                            CLIPPED_PIXELS.push(CLIPPED.height - (py + 0.5) / CLIPPED.dpr);
                        }
                    }
                }
                const RESTORED = await (async () => {
                    const EXTENSION = DEVICE.gl.getExtension('WEBGL_lose_context');
                    if (!EXTENSION) {
                        return {
                            supported: false,
                        };
                    }
                    const WAIT_FOR_STATE = (state) =>
                        new Promise((resolve, reject) => {
                            const DEADLINE = performance.now() + 10000;
                            const POLL = () => {
                                if (RENDERER.stats().state === state) {
                                    return resolve();
                                }
                                if (RENDERER.stats().state === 'failed') {
                                    return reject(new Error('MeshRenderer failed during WebGL restore'));
                                }
                                if (performance.now() > DEADLINE) {
                                    return reject(new Error('WebGL context ' + state + ' timed out'));
                                }
                                requestAnimationFrame(POLL);
                            };
                            POLL();
                        });
                    EXTENSION.loseContext();
                    await WAIT_FOR_STATE('lost');
                    EXTENSION.restoreContext();
                    await WAIT_FOR_STATE('ready');
                    const AFTER = RENDER('context-restored', {
                        part: IDENTITY_PART,
                        dpr: 2,
                    });
                    return {
                        supported: true,
                        state: RENDERER.stats().state,
                        width: AFTER.measure.cssWidth,
                    };
                })();
                const SCREENSHOT_CASE = RENDER('evidence', {
                    width: 320,
                    height: 200,
                    part: [1.3, 0.4, -0.8, 0.5, 65, -20],
                    dpr: 2,
                });
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                await document.fonts.ready;
                // The enclosing Playwright call saves the canvas and caption as one reviewable image.
                const REPORT = {
                    base: {
                        ...BASE.measure,
                        fillSample: BASE.fillSample,
                    },
                    dpr2: DPR2.measure,
                    zoomed: ZOOMED.measure,
                    animated: {
                        ...ANIMATED.measure,
                        draws: ANIMATED.draws,
                    },
                    larger: LARGER.measure,
                    offscreen: OFFSCREEN,
                    renderTargetRequiresViewport,
                    clippedPixelCount: CLIPPED_PIXELS.length,
                    clippedMaxY: Math.max(...CLIPPED_PIXELS),
                    halfAlphaMaximum: HALF_ALPHA.measure.maximumAlpha,
                    restored: RESTORED,
                    geometryUploadsAtCreation: GEOMETRY_UPLOADS_AT_CREATION,
                    geometryUploadsAfterFrames: RENDERER.stats().geometryUploads,
                    screenshot: {
                        cssWidth: 320,
                        cssHeight: 200,
                        dpr: 2,
                        nonScalingWidth: SCREENSHOT_CASE.measure.cssWidth,
                    },
                };
                window.__nonScalingStrokeTest = {
                    dispose() {
                        RENDERER.deleteMesh(MESH);
                        const DISPOSED = RENDERER.stats().meshCount;
                        const TARGET_DISPOSED = DEVICE.deleteRenderTarget(RENDER_TARGET);
                        RENDERER.dispose();
                        DEVICE.dispose();
                        return {
                            disposed: DISPOSED,
                            targetDisposed: TARGET_DISPOSED,
                        };
                    },
                };
                return REPORT;
            },
            {
                moduleURL,
                geometry: compiledGeometry,
            },
        );
        assert.ok(
            Math.abs(RESULT.base.cssWidth - 1.5) < 0.42,
            `DPR1 rendered ${RESULT.base.cssWidth.toFixed(3)} CSS px, expected 1.5`,
        );
        for (const KEY of ['dpr2', 'zoomed', 'animated', 'larger']) {
            assert.ok(
                Math.abs(RESULT[KEY].cssWidth - 1.5) < 0.42,
                `${KEY} rendered ${RESULT[KEY].cssWidth.toFixed(3)} CSS px`,
            );
        }
        assert.ok(
            Math.abs(RESULT.base.cssWidth - RESULT.dpr2.cssWidth) < 0.28,
            'CSS stroke width is invariant across device-pixel ratios',
        );
        assert.ok(
            Math.abs(RESULT.base.cssWidth - RESULT.zoomed.cssWidth) < 0.28,
            'camera zoom does not scale stroke width',
        );
        assert.ok(
            Math.abs(RESULT.base.cssWidth - RESULT.animated.cssWidth) < 0.28,
            'part rotation and non-uniform scale do not scale stroke width',
        );
        assert.ok(
            Math.abs(RESULT.base.cssWidth - RESULT.larger.cssWidth) < 0.28,
            'the same scene keeps its CSS-pixel width in a larger viewport',
        );
        assert.ok(
            RESULT.base.fillSample[3] >= 250 && RESULT.base.fillSample[0] > 120,
            'the ordinary SVG fill remains visible in a mesh that also contains non-scaling strokes',
        );
        assert.ok(
            Math.abs(RESULT.offscreen.cssWidth - 1.5) < 0.42,
            'offscreen render targets preserve CSS-pixel width when the host supplies the logical viewport',
        );
        assert.equal(
            RESULT.renderTargetRequiresViewport,
            true,
            'offscreen targets fail clearly when their CSS viewport is not supplied',
        );
        assert.ok(
            RESULT.clippedMaxY <= 50.75,
            `expanded stroke pixels must still obey the clip polygon (max y=${RESULT.clippedMaxY})`,
        );
        assert.ok(RESULT.clippedPixelCount > 0, 'the clipped stroke keeps its portion inside the clip polygon');
        assert.ok(
            RESULT.halfAlphaMaximum <= 129 && RESULT.halfAlphaMaximum >= 120,
            'stroke alpha remains part of the normal premultiplied blend path',
        );
        assert.equal(RESULT.geometryUploadsAtCreation, 1, 'the retained line uploads its static geometry once');
        assert.equal(
            RESULT.geometryUploadsAfterFrames,
            0,
            'ordinary frames do not upload or tessellate stroke geometry',
        );
        assert.equal(
            RESULT.restored.supported,
            true,
            'the browser provides WEBGL_lose_context for the retained-mesh restore check',
        );
        assert.equal(RESULT.restored.state, 'ready');
        assert.ok(Math.abs(RESULT.restored.width - 1.5) < 0.28, 'restored mesh keeps its screen-space stroke width');
        if (PAGE_ERRORS.length) {
            throw new Error('WebGL non-scaling stroke page errors: ' + PAGE_ERRORS.join('; '));
        }
        await PAGE.screenshot({
            path: screenshotPath,
            fullPage: true,
        });
        const DISPOSED = await PAGE.evaluate(() => window.__nonScalingStrokeTest.dispose());
        RESULT.disposedMeshCount = DISPOSED.disposed;
        assert.equal(RESULT.disposedMeshCount, 0, 'the retained mesh disposes normally');
        assert.equal(DISPOSED.targetDisposed, true, 'the offscreen target disposes normally');
        return RESULT;
    } finally {
        await PAGE.close();
    }
}

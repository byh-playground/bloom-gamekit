import assert from 'node:assert/strict';
export async function exerciseYarnShader(browser, moduleURL, screenshotPath) {
    const PAGE = await browser.newPage({
        viewport: {
            width: 420,
            height: 260,
        },
        deviceScaleFactor: 1,
    });
    const PAGE_ERRORS = [];
    PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    try {
        await PAGE.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:18px;background:#f1f0e8;color:#293e36;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:17px;margin:0 0 12px}.row{display:flex;align-items:flex-start;gap:22px}.card{padding:10px;background:#fffdf4;border:1px solid #d5dec2;border-radius:8px}
      canvas{display:block;background:repeating-conic-gradient(#cfdbb8 0 25%,#dfe8cb 0 50%) 0/16px 16px}small{display:block;margin-top:6px}
    </style><h1>GameKit yarn shader · retained fill + fixed contour strip</h1>
    <div class="row"><div class="card"><canvas id="mobile"></canvas><small>47 CSS px</small></div><div class="card"><canvas id="desktop"></canvas><small>74 CSS px</small></div></div>`);
        const RESULT = await PAGE.evaluate(
            async ({ moduleURL }) => {
                const {
                    WebGLDevice: WEB_GL_DEVICE,
                    VectorContext: VECTOR_CONTEXT,
                    buildYarnSurfaceMesh: BUILD_YARN_SURFACE_MESH,
                } = await import(moduleURL);
                // A surface is one retained mesh whose vertices carry a material; this test keeps the shape of its old
                // scenarios (create, draw, delete a surface) over the mesh renderer's API.
                const MAKE_SURFACES = (device, context = null) => {
                    const CONTEXT = context ?? new VECTOR_CONTEXT(device),
                        MESHES = CONTEXT.acquireMeshRenderer(),
                        LIVE = new Set();
                    let disposed = false;
                    return {
                        createSurface(descriptor) {
                            const MESH = MESHES.createMesh(BUILD_YARN_SURFACE_MESH(descriptor));
                            LIVE.add(MESH);
                            return MESH;
                        },
                        drawSurface(mesh, { transform, depth, z = 0, ...options }) {
                            MESHES.drawMesh(mesh, {
                                ...options,
                                matrix: transform,
                                depth: z,
                                depthTest: Boolean(depth),
                                depthWrite: Boolean(depth),
                            });
                            MESHES.flush();
                        },
                        deleteSurface(mesh) {
                            return LIVE.delete(mesh) && MESHES.deleteMesh(mesh);
                        },
                        stats() {
                            return { state: MESHES.stats().state, surfaceCount: LIVE.size };
                        },
                        dispose() {
                            if (disposed) {
                                return false;
                            }
                            disposed = true;
                            if (context === null) {
                                CONTEXT.dispose();
                            }
                            return true;
                        },
                    };
                };
                const MAKE_CANVAS = (id) => document.getElementById(id);
                const OUTLINE = [];
                for (let i = 0; i < 72; i++) {
                    const ANGLE = (i / 72) * Math.PI * 2;
                    OUTLINE.push(80 + Math.cos(ANGLE) * 56, 90 + Math.sin(ANGLE) * 68);
                }
                const FILL_VERTICES = [];
                for (let i = 0; i < 72; i++) {
                    const A = (i / 72) * Math.PI * 2,
                        B = ((i + 1) / 72) * Math.PI * 2;
                    FILL_VERTICES.push(
                        80,
                        90,
                        0.84,
                        0.49,
                        0.29,
                        1,
                        80 + Math.cos(A) * 56,
                        90 + Math.sin(A) * 68,
                        0.84,
                        0.49,
                        0.29,
                        1,
                        80 + Math.cos(B) * 56,
                        90 + Math.sin(B) * 68,
                        0.84,
                        0.49,
                        0.29,
                        1,
                    );
                }
                const STYLE = {
                    kind: 'yarn',
                    seed: 41,
                    stitchWidth: 14.4,
                    stitchHeight: 15.6,
                    thickness: 0.4102564103,
                    irregularity: 0.13,
                    contrast: 0.23,
                    edgeSpacing: 10,
                    edgeRelief: 3.04,
                    edgeWidth: 3.92,
                    fiberLength: 8.8,
                    fiberWidth: 0.88,
                    fiberOpacity: 0.65,
                    fiberSpacing: 4,
                    fiberMax: 155,
                    curved: true,
                    pattern: true,
                    detail: false,
                    fiber: true,
                };
                const OUTLINE_DATA = Float32Array.from(OUTLINE),
                    FILL_DATA = Float32Array.from(FILL_VERTICES);
                const COLOR_DATA = Float32Array.from(
                    Array.from(
                        {
                            length: 72,
                        },
                        (_, i) => {
                            const T = i / 72;
                            return [0.82 - T * 0.12, 0.48 - T * 0.08, 0.28 - T * 0.06, 1];
                        },
                    ).flat(),
                );
                const SAMPLES = {};
                for (const [ID, SIZE] of [
                    ['mobile', 47],
                    ['desktop', 74],
                ]) {
                    const CANVAS = MAKE_CANVAS(ID),
                        DPR = 2;
                    CANVAS.style.width = `${SIZE + 24}px`;
                    CANVAS.style.height = `${SIZE + 24}px`;
                    CANVAS.width = (SIZE + 24) * DPR;
                    CANVAS.height = (SIZE + 24) * DPR;
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: true,
                        antialias: true,
                        depth: true,
                        preserveDrawingBuffer: true,
                    });
                    const SURFACES = MAKE_SURFACES(DEVICE);
                    const SURFACE = SURFACES.createSurface({
                        fillVertices: FILL_DATA,
                        outline: OUTLINE_DATA,
                        edgeColors: COLOR_DATA,
                        style: STYLE,
                    });
                    const RENDER = () => {
                        if (
                            !DEVICE.beginFrame({
                                width: CANVAS.width,
                                height: CANVAS.height,
                                clearColor: [0, 0, 0, 0],
                            })
                        ) {
                            throw new Error('WebGL context did not begin');
                        }
                        const SCALE = SIZE / 150,
                            LEFT = 12 + (SIZE + 24) / 2 - 80 * SCALE,
                            TOP = 12 + (SIZE + 24) / 2 - 90 * SCALE;
                        const TRANSFORM = [SCALE, 0, 0, SCALE, LEFT, TOP];
                        const PROJECTION = [2 / (SIZE + 24), 0, 0, 0, -2 / (SIZE + 24), 0, -1, 1, 1];
                        SURFACES.drawSurface(SURFACE, {
                            projection: PROJECTION,
                            transform: TRANSFORM,
                            clips: [
                                [
                                    {
                                        x: 1,
                                        y: 1,
                                    },
                                    {
                                        x: SIZE + 23,
                                        y: 1,
                                    },
                                    {
                                        x: SIZE + 23,
                                        y: SIZE + 23,
                                    },
                                    {
                                        x: 1,
                                        y: SIZE + 23,
                                    },
                                ],
                            ],
                            alpha: 0.8,
                            z: 0.25,
                            depth: true,
                        });
                        DEVICE.endFrame();
                        const PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
                        DEVICE.gl.readPixels(
                            0,
                            0,
                            CANVAS.width,
                            CANVAS.height,
                            DEVICE.gl.RGBA,
                            DEVICE.gl.UNSIGNED_BYTE,
                            PIXELS,
                        );
                        let covered = 0;
                        let varied = 0;
                        let dark = 0;
                        for (let i = 0; i < PIXELS.length; i += 4) {
                            if (PIXELS[i + 3]) {
                                covered++;
                                const PIXEL = i / 4,
                                    X = PIXEL % CANVAS.width,
                                    Y = Math.floor(PIXEL / CANVAS.width);
                                const INTERIOR =
                                    Math.abs(X - CANVAS.width / 2) < SIZE * 0.3 * DPR &&
                                    Math.abs(Y - CANVAS.height / 2) < SIZE * 0.3 * DPR;
                                if (
                                    INTERIOR &&
                                    Math.abs(PIXELS[i] - 171) +
                                        Math.abs(PIXELS[i + 1] - 100) +
                                        Math.abs(PIXELS[i + 2] - 59) >
                                        24
                                ) {
                                    varied++;
                                }
                                if (INTERIOR && PIXELS[i + 3] > 200 && PIXELS[i] < 150) {
                                    dark++;
                                }
                            }
                        }
                        const OUTSIDE_AT = (CANVAS.height - 2) * CANVAS.width * 4 + (CANVAS.width - 2) * 4;
                        const OUTSIDE = PIXELS[OUTSIDE_AT + 3];
                        return {
                            size: SIZE,
                            dpr: DPR,
                            covered,
                            varied,
                            dark,
                            outside: OUTSIDE,
                            drawCalls: DEVICE.stats.drawCalls,
                            vertexCount: DEVICE.stats.vertices,
                            meshVertices: SURFACE.vertices.length / 11,
                        };
                    };
                    SAMPLES[ID] = RENDER();
                    if (ID === 'mobile') {
                        const EXT = DEVICE.gl.getExtension('WEBGL_lose_context');
                        if (!EXT) {
                            throw new Error('WEBGL_lose_context extension unavailable');
                        }
                        const LOST = new Promise((resolve) =>
                            CANVAS.addEventListener('webglcontextlost', () => resolve(true), {
                                once: true,
                            }),
                        );
                        EXT.loseContext();
                        await LOST;
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        const RESTORED = new Promise((resolve) =>
                            CANVAS.addEventListener('webglcontextrestored', () => resolve(true), {
                                once: true,
                            }),
                        );
                        EXT.restoreContext();
                        await RESTORED;
                        SAMPLES.mobileRestored = {
                            ...RENDER(),
                            state: SURFACES.stats().state,
                        };
                        if (!SURFACES.deleteSurface(SURFACE) || SURFACES.stats().surfaceCount !== 0) {
                            throw new Error('Surface disposal failed');
                        }
                        SURFACES.dispose();
                        if (SURFACES.dispose() !== false) {
                            throw new Error('Renderer disposal must be idempotent');
                        }
                        DEVICE.dispose();
                    } else {
                        if (!SURFACES.deleteSurface(SURFACE) || SURFACES.stats().surfaceCount !== 0) {
                            throw new Error('Surface disposal failed');
                        }
                        SURFACES.dispose();
                        DEVICE.dispose();
                    }
                }
                {
                    const CANVAS = document.createElement('canvas');
                    CANVAS.width = 220;
                    CANVAS.height = 140;
                    CANVAS.style.cssText = 'display:block;margin:12px auto;background:#fffdf4;border:1px solid #b9c3aa';
                    document.body.append(CANVAS);
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: true,
                        antialias: false,
                        depth: false,
                        stencil: true,
                        preserveDrawingBuffer: true,
                    });
                    const CTX = new VECTOR_CONTEXT(DEVICE, {
                            initialVertices: 128,
                            maxVertices: 4096,
                        }),
                        SURFACES = MAKE_SURFACES(DEVICE, CTX);
                    const QUAD = Float32Array.from([
                        5, 5, 0.82, 0.48, 0.28, 1, 105, 5, 0.82, 0.48, 0.28, 1, 105, 105, 0.82, 0.48, 0.28, 1, 5, 5,
                        0.82, 0.48, 0.28, 1, 105, 105, 0.82, 0.48, 0.28, 1, 5, 105, 0.82, 0.48, 0.28, 1,
                    ]);
                    const OUTLINE = Float32Array.from([5, 5, 105, 5, 105, 105, 5, 105]),
                        EDGE_COLORS = Float32Array.from([
                            0.86, 0.57, 0.34, 1, 0.78, 0.43, 0.25, 1, 0.7, 0.36, 0.2, 1, 0.82, 0.49, 0.29, 1,
                        ]);
                    const STYLE = {
                        kind: 'yarn',
                        seed: 13,
                        stitchWidth: 14,
                        stitchHeight: 16,
                        thickness: 0.41,
                        irregularity: 0.13,
                        contrast: 0.23,
                        edgeSpacing: 10,
                        edgeRelief: 3,
                        edgeWidth: 4,
                        fiberLength: 8,
                        fiberWidth: 0.8,
                        fiberOpacity: 0.65,
                        fiberSpacing: 4,
                        fiberMax: 155,
                        curved: true,
                        pattern: true,
                        detail: false,
                        fiber: true,
                    };
                    const SURFACE = SURFACES.createSurface({
                        fillVertices: QUAD,
                        outline: OUTLINE,
                        edgeColors: EDGE_COLORS,
                        style: STYLE,
                    });
                    const CLIP = CTX.createClipPath(
                        new Float32Array([10, 10, 100, 10, 100, 30, 30, 30, 30, 100, 10, 100]),
                    );
                    const PROJECTION = [2 / 220, 0, 0, 0, -2 / 140, 0, -1, 1, 1],
                        PIXEL = (x, y) => {
                            const P = new Uint8Array(4);
                            DEVICE.gl.readPixels(x, 139 - y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, P);
                            return [...P];
                        };
                    const DRAW_CLIPPED = () => {
                        CTX.save();
                        CTX.clipPath(CLIP);
                        const REF = CTX.stencilRef;
                        if (REF !== 1) {
                            throw new Error(`expected active stencil ref 1, got ${REF}`);
                        }
                        SURFACES.drawSurface(SURFACE, {
                            projection: PROJECTION,
                            stencilRef: REF,
                            alpha: 0.9,
                            z: 0.2,
                        });
                        return REF;
                    };
                    CTX.beginFrame({
                        clearColor: [0, 0, 0, 0],
                    });
                    DRAW_CLIPPED();
                    CTX.restore();
                    SURFACES.drawSurface(SURFACE, {
                        projection: PROJECTION,
                        transform: [0.42, 0, 0, 0.42, 125, 62],
                        alpha: 0.9,
                        z: 0.2,
                    });
                    CTX.endFrame();
                    const FIRST = {
                        upperArm: PIXEL(60, 20),
                        leftArm: PIXEL(20, 75),
                        notch: PIXEL(80, 75),
                        unclippedAfter: PIXEL(155, 90),
                        drawCalls: DEVICE.stats.drawCalls,
                        glError: DEVICE.gl.getError(),
                    };
                    let restored = false;
                    let restoredPixels = null;
                    const LOSS = DEVICE.gl.getExtension('WEBGL_lose_context');
                    if (LOSS) {
                        const EVENT = (name, trigger) =>
                            new Promise((resolve, reject) => {
                                const TIMER = setTimeout(
                                    () => reject(new Error(`Timed out waiting for ${name}`)),
                                    20000,
                                );
                                CANVAS.addEventListener(
                                    name,
                                    () => {
                                        clearTimeout(TIMER);
                                        resolve(true);
                                    },
                                    {
                                        once: true,
                                    },
                                );
                                trigger();
                            });
                        CTX.beginFrame({
                            clearColor: [0, 0, 0, 0],
                        });
                        DRAW_CLIPPED();
                        CTX.endFrame();
                        await EVENT('webglcontextlost', () => LOSS.loseContext());
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        await EVENT('webglcontextrestored', () => LOSS.restoreContext());
                        await new Promise((resolve) => setTimeout(resolve, 80));
                        CTX.beginFrame({
                            clearColor: [0, 0, 0, 0],
                        });
                        if (CTX.stencilRef !== 1) {
                            throw new Error('retained stencil ref did not survive context restoration');
                        }
                        SURFACES.drawSurface(SURFACE, {
                            projection: PROJECTION,
                            stencilRef: CTX.stencilRef,
                            alpha: 0.9,
                            z: 0.2,
                        });
                        CTX.restore();
                        CTX.endFrame();
                        restoredPixels = {
                            upperArm: PIXEL(60, 20),
                            notch: PIXEL(80, 75),
                            state: SURFACES.stats().state,
                        };
                        restored = true;
                    }
                    let missingStencilRejected = false;
                    let invalidStencilRefRejected = false;
                    const NO_STENCIL_CANVAS = document.createElement('canvas');
                    NO_STENCIL_CANVAS.width = NO_STENCIL_CANVAS.height = 32;
                    const NO_STENCIL = new WEB_GL_DEVICE(NO_STENCIL_CANVAS, {
                            stencil: false,
                            depth: false,
                        }),
                        NO_STENCIL_SURFACES = MAKE_SURFACES(NO_STENCIL);
                    const TINY_FILL = Float32Array.from([
                            0, 0, 0.5, 0.5, 0.5, 1, 10, 0, 0.5, 0.5, 0.5, 1, 10, 10, 0.5, 0.5, 0.5, 1,
                        ]),
                        TINY_OUTLINE = Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10]),
                        TINY_COLORS = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
                    const TINY = NO_STENCIL_SURFACES.createSurface({
                        fillVertices: TINY_FILL,
                        outline: TINY_OUTLINE,
                        edgeColors: TINY_COLORS,
                        style: STYLE,
                    });
                    NO_STENCIL.beginFrame();
                    try {
                        NO_STENCIL_SURFACES.drawSurface(TINY, {
                            projection: [2 / 32, 0, 0, 0, -2 / 32, 0, -1, 1, 1],
                            stencilRef: 256,
                        });
                    } catch (error) {
                        invalidStencilRefRejected = /\[0,255\]/.test(error.message);
                    }
                    try {
                        NO_STENCIL_SURFACES.drawSurface(TINY, {
                            projection: [2 / 32, 0, 0, 0, -2 / 32, 0, -1, 1, 1],
                            stencilRef: 1,
                        });
                    } catch (error) {
                        missingStencilRejected = /active stencil attachment/.test(error.message);
                    }
                    NO_STENCIL.endFrame();
                    NO_STENCIL_SURFACES.deleteSurface(TINY);
                    NO_STENCIL_SURFACES.dispose();
                    NO_STENCIL.dispose();
                    if (!SURFACES.deleteSurface(SURFACE) || SURFACES.stats().surfaceCount !== 0) {
                        throw new Error('stencil surface disposal failed');
                    }
                    SURFACES.dispose();
                    CTX.dispose();
                    DEVICE.dispose();
                    SAMPLES.stencil = {
                        ...FIRST,
                        restored,
                        restoredPixels,
                        missingStencilRejected,
                        invalidStencilRefRejected,
                        disposed: DEVICE.stats.gpuBufferBytes === 0 && DEVICE.stats.textureCount === 0,
                    };
                }
                {
                    // Sketch hatching must follow hatchAngle and hatchSpacing: a wrong uniform slot turned the whole
                    // fill into one flat darker color.
                    const CANVAS = document.createElement('canvas');
                    CANVAS.width = 140;
                    CANVAS.height = 140;
                    document.body.append(CANVAS);
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: true,
                        antialias: false,
                        depth: false,
                        stencil: false,
                        preserveDrawingBuffer: true,
                    });
                    const SURFACES = MAKE_SURFACES(DEVICE);
                    const COLOR = [0.82, 0.48, 0.28, 1];
                    const SURFACE = SURFACES.createSurface({
                        fillVertices: Float32Array.from([
                            10,
                            10,
                            ...COLOR,
                            130,
                            10,
                            ...COLOR,
                            130,
                            130,
                            ...COLOR,
                            10,
                            10,
                            ...COLOR,
                            130,
                            130,
                            ...COLOR,
                            10,
                            130,
                            ...COLOR,
                        ]),
                        outline: Float32Array.from([10, 10, 130, 10, 130, 130, 10, 130]),
                        edgeColors: Float32Array.from([...COLOR, ...COLOR, ...COLOR, ...COLOR]),
                        style: {
                            kind: 'sketch',
                            seed: 73,
                            periodMs: 135,
                            amplitude: 1.3,
                            frequency: 4,
                            echoX: 1.1,
                            echoY: -0.8,
                            echoWidth: 1.4,
                            echoOpacity: 0.24,
                            hatchAngle: 0.72,
                            hatchSpacing: 7,
                            hatchWidth: 0.8,
                            hatchOpacity: 0.36,
                        },
                    });
                    DEVICE.beginFrame({ width: 140, height: 140, clearColor: [0, 0, 0, 0] });
                    SURFACES.drawSurface(SURFACE, {
                        projection: [2 / 140, 0, 0, 0, -2 / 140, 0, -1, 1, 1],
                        timeMs: 0,
                    });
                    DEVICE.endFrame();
                    const PIXELS = new Uint8Array(140 * 140 * 4);
                    DEVICE.gl.readPixels(0, 0, 140, 140, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                    const REDS = [];
                    for (let y = 40; y < 100; y++) {
                        for (let x = 40; x < 100; x++) {
                            REDS.push(PIXELS[(y * 140 + x) * 4]);
                        }
                    }
                    const MEDIAN = REDS.slice().sort((a, b) => a - b)[REDS.length >> 1];
                    const HATCHED = REDS.filter((red) => Math.abs(red - MEDIAN) > 8).length;
                    SURFACES.deleteSurface(SURFACE);
                    SURFACES.dispose();
                    DEVICE.dispose();
                    SAMPLES.sketchHatch = { median: MEDIAN, hatchedFraction: HATCHED / REDS.length };
                }
                return SAMPLES;
            },
            {
                moduleURL,
            },
        );
        assert.deepEqual(PAGE_ERRORS, []);
        for (const NAME of ['mobile', 'desktop', 'mobileRestored']) {
            const SAMPLE = RESULT[NAME];
            assert.ok(SAMPLE.covered > 120, `${NAME}: surface pixels should be visible`);
            assert.ok(SAMPLE.varied > 40, `${NAME}: shader should produce multiple yarn colors`);
            assert.ok(SAMPLE.dark > 0, `${NAME}: dark yarn grooves should render (observed ${SAMPLE.dark})`);
            assert.equal(SAMPLE.outside, 0, `${NAME}: clip should leave outside pixels transparent`);
            assert.equal(SAMPLE.drawCalls, 2, `${NAME}: fill and contour strip draw once each`);
            assert.ok(SAMPLE.meshVertices < 1000, `${NAME}: retained vertices must stay bounded`);
        }
        assert.equal(RESULT.mobileRestored.state, 'ready');
        assert.ok(
            RESULT.sketchHatch.hatchedFraction > 0.03 && RESULT.sketchHatch.hatchedFraction < 0.5,
            `sketch fill shows diagonal hatch lines, not one flat color: ${JSON.stringify(RESULT.sketchHatch)}`,
        );
        assert.ok(
            RESULT.stencil.upperArm[3] > 0 && RESULT.stencil.leftArm[3] > 0,
            `concave stencil keeps both Yarn arms: ${JSON.stringify(RESULT.stencil)}`,
        );
        assert.equal(RESULT.stencil.notch[3], 0, 'Yarn fill and contour stay inside the concave stencil notch');
        assert.ok(
            RESULT.stencil.unclippedAfter[3] > 0,
            'stencilRef null explicitly disables the previous stencil state',
        );
        assert.equal(
            RESULT.stencil.drawCalls,
            3,
            'stencil mask, one clipped Yarn draw, then one unclipped Yarn draw preserve draw ordering',
        );
        assert.equal(RESULT.stencil.glError, 0);
        assert.equal(
            RESULT.stencil.missingStencilRejected,
            true,
            'stencil clipping without an attachment fails explicitly',
        );
        assert.equal(RESULT.stencil.invalidStencilRefRejected, true, 'stencil refs outside [0,255] fail explicitly');
        assert.equal(RESULT.stencil.disposed, true);
        if (RESULT.stencil.restored) {
            assert.ok(RESULT.stencil.restoredPixels.upperArm[3] > 0);
            assert.equal(RESULT.stencil.restoredPixels.notch[3], 0);
            assert.equal(RESULT.stencil.restoredPixels.state, 'ready');
        }
        await PAGE.screenshot({
            path: screenshotPath,
            fullPage: true,
        });
        return {
            samples: RESULT,
            screenshotPath,
        };
    } finally {
        await PAGE.close();
    }
}

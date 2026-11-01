/** Checks ordered VectorContext stream and MeshRenderer submission on one WebGL2 canvas. */
export async function exerciseRendererInterleaving(page, moduleURL = '/dist/rendering.js') {
    const RESULT = await page.evaluate(async (url) => {
        const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import(url);
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        CANVAS.style.cssText = 'width:64px;height:64px';
        document.body.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: true,
            antialias: false,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const CONTEXT = new VECTOR_CONTEXT(DEVICE);
        const VERTICES = new Float32Array([
            24, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0, 40, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0, 32, 40, 0, 0, 1, 1, 0, 0, 0, 0, 0,
        ]);
        const MESH = CONTEXT.createMesh({
            vertices: VERTICES,
            strideFloats: 11,
            partCount: 1,
            morphCount: 0,
        });
        const TRIANGLE = (x, paint) => {
            CONTEXT.fillStyle = paint;
            CONTEXT.beginPath();
            CONTEXT.moveTo(x - 4, 8);
            CONTEXT.lineTo(x + 4, 8);
            CONTEXT.lineTo(x, 16);
            CONTEXT.closePath();
            CONTEXT.fill();
        };
        CONTEXT.beginFrame({
            width: 64,
            height: 64,
            clearColor: [0, 0, 0, 1],
        });
        TRIANGLE(12, [1, 0, 0, 1]);
        CONTEXT.drawMesh(MESH);
        TRIANGLE(50, [0, 1, 0, 1]);
        const FRAME = CONTEXT.endFrame();
        DEVICE.gl.finish();
        const PIXEL = (x, y) => {
            const OUTPUT = new Uint8Array(4);
            DEVICE.gl.readPixels(x, 63 - y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, OUTPUT);
            return [...OUTPUT];
        };
        const RESULT = {
            redVector: PIXEL(12, 11),
            blueMesh: PIXEL(32, 30),
            greenVector: PIXEL(50, 11),
            glError: DEVICE.gl.getError(),
            meshDraws: CONTEXT.meshRenderer.stats().draws,
            deviceDraws: FRAME.drawCalls,
        };
        CONTEXT.deleteMesh(MESH);
        CONTEXT.dispose();
        DEVICE.dispose();
        CANVAS.remove();
        return RESULT;
    }, moduleURL);
    RESULT.orderedMeshQuads = await exerciseOrderedMeshQuads(page, moduleURL);
    return RESULT;
}

/** Native mesh/atlas commands preserve the existing painter order, even across state/resource boundaries. */
async function exerciseOrderedMeshQuads(page, moduleURL) {
    return page.evaluate(async (url) => {
        const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import(url);
        const CHECK = (condition, message) => {
                if (!condition) {
                    throw new Error(message);
                }
            },
            SAME = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]),
            CONFIGURATIONS = [
                { name: 'existing', orderedMeshQuads: false, maxInstances: 128 },
                { name: 'ordered', orderedMeshQuads: true, maxInstances: 128 },
                { name: 'capacity-one', orderedMeshQuads: true, maxInstances: 1 },
            ],
            RESULTS = [];
        for (const CONFIG of CONFIGURATIONS) {
            const CANVAS = document.createElement('canvas');
            CANVAS.width = CANVAS.height = 64;
            document.body.append(CANVAS);
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                    alpha: true,
                    antialias: false,
                    depth: true,
                    stencil: true,
                    preserveDrawingBuffer: true,
                    checkGLErrors: true,
                }),
                CTX = new VECTOR_CONTEXT(DEVICE, {
                    mesh: {
                        orderedMeshQuads: CONFIG.orderedMeshQuads,
                        maxInstances: CONFIG.maxInstances,
                    },
                }),
                MESHES = CTX.acquireMeshRenderer(),
                ATLAS = DEVICE.textureAtlas,
                REGION = ATLAS.allocate(2, 2, { filter: 'nearest' }),
                WHITE = ATLAS.allocate(1, 1, { filter: 'nearest' }),
                PIXELS = new Uint8Array(64 * 64 * 4),
                GL = DEVICE.gl;
            const SOLID = (r, g, b) => ({
                    width: 2,
                    height: 2,
                    data: new Uint8Array(Array.from({ length: 4 }, () => [r, g, b, 255]).flat()),
                }),
                PATTERN = {
                    width: 2,
                    height: 2,
                    data: new Uint8Array([255, 0, 0, 255, 0, 128, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0]),
                };
            ATLAS.upload(REGION, PATTERN, { premultiplied: true });
            ATLAS.upload(
                WHITE,
                { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
                { premultiplied: true },
            );
            const GEOMETRY = (points, colors, palette = false) => ({
                    vertices: Float32Array.from(
                        points.flatMap((point, index) => [...point, ...colors[index], 0, 0, 0, 0, 0]),
                    ),
                    strideFloats: 11,
                    partCount: 1,
                    morphCount: 0,
                    indices: Uint16Array.from(points.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]),
                    ...(palette
                        ? { paintRegions: { names: ['body'], indices: new Uint16Array(points.length).fill(1) } }
                        : {}),
                }),
                QUAD = [
                    [0, 0],
                    [32, 0],
                    [32, 32],
                    [0, 32],
                ],
                A = CTX.createMesh(
                    GEOMETRY(
                        QUAD,
                        QUAD.map(() => [1, 1, 1, 1]),
                    ),
                ),
                B = CTX.createMesh(
                    GEOMETRY(
                        [
                            [0, 0],
                            [32, 0],
                            [16, 32],
                        ],
                        Array.from({ length: 3 }, () => [1, 1, 1, 1]),
                    ),
                ),
                PALETTE = CTX.createMesh(
                    GEOMETRY(
                        QUAD,
                        [
                            [1, 0, 0, 0.25],
                            [0, 1, 0, 0.5],
                            [0, 0, 1, 1],
                            [1, 1, 1, 0.75],
                        ],
                        true,
                    ),
                ),
                // A fixture renderable delegates the public actor protocol to the actual retained WebGL mesh.
                ACTORS = new Map(
                    [A, B, PALETTE].map((mesh) => [
                        mesh,
                        {
                            draw: (options) => MESHES.drawMesh(mesh, options),
                        },
                    ]),
                ),
                DRAW = (mesh, x, y, options = {}) =>
                    CTX.drawVectorActor(ACTORS.get(mesh), {
                        matrix: [1, 0, 0, 1, x, y],
                        ...options,
                    }),
                OUTER = CTX.createClipPath(Float32Array.of(4, 4, 60, 4, 60, 20, 28, 20, 28, 60, 4, 60)),
                INNER = CTX.createClipPath(Float32Array.of(8, 8, 54, 8, 54, 16, 20, 16, 20, 54, 8, 54)),
                READ = () => {
                    const FRAME = CTX.endFrame();
                    GL.readPixels(0, 0, 64, 64, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                    CHECK(GL.getError() === GL.NO_ERROR, CONFIG.name + ': no WebGL error');
                    return { pixels: Array.from(PIXELS), draws: FRAME.drawCalls, ordered: MESHES.stats().ordered };
                },
                BEGIN = () => {
                    CTX.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1] });
                    CTX.resetTransform();
                    CTX.globalAlpha = 1;
                    CTX.forceColor = null;
                    CTX.filter = 'none';
                },
                SAMPLE = (frame, x, y) => frame.pixels.slice(((63 - y) * 64 + x) * 4, ((63 - y) * 64 + x) * 4 + 4);
            const BATCH = () => {
                BEGIN();
                const LIST = [
                    [A, 0, 0, [1, 0, 0, 1]],
                    [B, 8, 8, [0, 1, 0, 1]],
                    [A, 16, 16, [0, 0, 1, 1]],
                    [B, 24, 24, [1, 1, 0, 1]],
                ];
                for (const [MESH, X, Y, COLOR] of LIST) {
                    DRAW(MESH, X, Y, { color: COLOR, forceColor: true });
                    CTX.globalAlpha = 0.5;
                    CTX.drawRegion(WHITE, X + 4, Y + 4, 16, 16);
                    CTX.globalAlpha = 1;
                }
                return READ();
            };
            const PAINT = () => {
                ATLAS.upload(REGION, PATTERN, { premultiplied: true });
                BEGIN();
                const GRADIENT = CTX.createLinearGradient(0, 0, 64, 64);
                GRADIENT.addColorStop(0, '#204080');
                GRADIENT.addColorStop(1, '#602040');
                CTX.fillStyle = GRADIENT;
                CTX.fillRect(0, 0, 64, 64);
                const COLORS = { body: [0.125, 0.75, 0.25] };
                DRAW(PALETTE, 2, 2, { paintRegions: COLORS, alpha: 0.5 });
                COLORS.body = [0.75, 0.125, 0.5];
                DRAW(PALETTE, 8, 8, { paintRegions: COLORS, alpha: 0.75 });
                DRAW(PALETTE, 16, 16, { whiteFlash: true, alpha: 0.5 });
                DRAW(PALETTE, 24, 24, { color: [0.25, 0.5, 0.75, 0.5], forceColor: true });
                CTX.drawQuads({
                    layer: REGION.layer,
                    filter: 'nearest',
                    uvRects: Float32Array.of(
                        REGION.uvRect[0] + REGION.uvRect[2],
                        REGION.uvRect[1],
                        -REGION.uvRect[2],
                        REGION.uvRect[3],
                    ),
                    localRects: Float32Array.of(54, 4, -16, 16),
                    color: [0.25, 0.5, 0.75, 1],
                    forceColor: true,
                    alpha: 0.5,
                });
                CTX.filter = 'brightness(0) invert(1)';
                CTX.drawRegion(REGION, 36, 24, 20, 20);
                CTX.filter = 'none';
                CTX.save();
                CTX.clipRect(6, 6, 28, 28);
                DRAW(A, 0, 0, { color: [1, 0, 0, 0.25], forceColor: true });
                CTX.drawRegion(REGION, 0, 0, 32, 32);
                CTX.restore();
                DRAW(B, 32, 32, { color: [0, 1, 1, 0.5], forceColor: true });
                return READ();
            };
            const MUTATION = () => {
                ATLAS.upload(REGION, SOLID(255, 0, 0), { premultiplied: true });
                BEGIN();
                DRAW(A, 0, 0, { color: [0, 0, 1, 1], forceColor: true });
                CTX.drawRegion(REGION, 0, 0, 16, 16);
                ATLAS.upload(REGION, SOLID(0, 255, 0), { premultiplied: true });
                CTX.drawRegion(REGION, 32, 0, 16, 16);
                DRAW(B, 32, 32, { color: [0, 0, 1, 1], forceColor: true });
                const FRAME = READ();
                CHECK(
                    SAME(SAMPLE(FRAME, 8, 8), [255, 0, 0, 255]),
                    CONFIG.name + ': earlier quad keeps pre-upload texels',
                );
                CHECK(SAME(SAMPLE(FRAME, 40, 8), [0, 255, 0, 255]), CONFIG.name + ': later quad uses updated texels');
                return FRAME;
            };
            const STENCIL = () => {
                BEGIN();
                CTX.save();
                CTX.clipPath(OUTER);
                DRAW(A, 0, 0, { matrix: [2, 0, 0, 2, 0, 0], color: [0, 0, 1, 1], forceColor: true });
                CTX.save();
                CTX.clipPath(INNER);
                DRAW(B, 0, 0, { matrix: [2, 0, 0, 2, 0, 0], color: [1, 0, 0, 1], forceColor: true });
                CTX.drawRegion(WHITE, 10, 10, 32, 32);
                CTX.restore();
                CTX.restore();
                const FRAME = READ();
                CHECK(
                    SAME(SAMPLE(FRAME, 12, 12), [255, 255, 255, 255]),
                    CONFIG.name + ': queued nested stencil paint survives restore',
                );
                CHECK(SAME(SAMPLE(FRAME, 48, 48), [0, 0, 0, 255]), CONFIG.name + ': concave notch remains empty');
                return FRAME;
            };
            const SCENES = { batch: BATCH, paint: PAINT, mutation: MUTATION, stencil: STENCIL },
                BEFORE = Object.fromEntries(Object.entries(SCENES).map(([name, draw]) => [name, draw()]));
            // Lose a context with queued commands too; the restored frame must not replay that discarded paint.
            BEGIN();
            DRAW(A, 0, 0, { color: [1, 0, 1, 1], forceColor: true });
            CTX.drawRegion(WHITE, 0, 0, 64, 64);
            const LOSS = GL.getExtension('WEBGL_lose_context'),
                EVENT = (type) =>
                    new Promise((resolve) =>
                        CANVAS.addEventListener(
                            type,
                            (event) => {
                                event.preventDefault();
                                resolve();
                            },
                            { once: true },
                        ),
                    );
            CHECK(LOSS, CONFIG.name + ': context restoration extension');
            const LOST = EVENT('webglcontextlost');
            LOSS.loseContext();
            await LOST;
            CHECK(CTX.beginFrame() === false, CONFIG.name + ': lost context cannot begin a frame');
            await new Promise((resolve) => setTimeout(resolve, 50));
            const RESTORED = EVENT('webglcontextrestored');
            LOSS.restoreContext();
            await RESTORED;
            const AFTER = Object.fromEntries(Object.entries(SCENES).map(([name, draw]) => [name, draw()]));
            for (const NAME of Object.keys(SCENES)) {
                CHECK(
                    SAME(BEFORE[NAME].pixels, AFTER[NAME].pixels),
                    CONFIG.name + ': ' + NAME + ' restoration pixel parity',
                );
            }
            let indexBoundary = null;
            if (CONFIG.name !== 'capacity-one') {
                // Use the public default capacity: a smaller triangle budget would split before index 0xffff.
                const BOUNDARY = new VECTOR_CONTEXT(DEVICE, { mesh: { orderedMeshQuads: CONFIG.orderedMeshQuads } }),
                    VERTICES = new Float32Array(65532 * 11);
                for (let index = 0; index < 65532; index++) {
                    const AT = index * 11;
                    VERTICES[AT] = VERTICES[AT + 1] = -100;
                    VERTICES[AT + 2] = VERTICES[AT + 5] = 1;
                }
                for (const [INDEX, POINT] of [
                    [0, [2, 2]],
                    [1, [18, 2]],
                    [2, [2, 18]],
                ]) {
                    VERTICES.set(POINT, INDEX * 11);
                }
                const LARGE = BOUNDARY.createMesh({
                    vertices: VERTICES,
                    strideFloats: 11,
                    partCount: 1,
                    morphCount: 0,
                });
                BOUNDARY.beginFrame({ clearColor: [0, 0, 0, 1] });
                BOUNDARY.drawMesh(LARGE);
                BOUNDARY.drawRegion(WHITE, 32, 32, 24, 24);
                const FRAME = BOUNDARY.endFrame();
                GL.readPixels(0, 0, 64, 64, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
                indexBoundary = {
                    pixels: Array.from(PIXELS),
                    draws: FRAME.drawCalls,
                    ordered: BOUNDARY.meshRenderer.stats().ordered,
                };
                CHECK(
                    SAME(SAMPLE(indexBoundary, 8, 8), [255, 0, 0, 255]),
                    CONFIG.name + ': first triangle of the large unindexed mesh remains visible',
                );
                CHECK(
                    SAME(SAMPLE(indexBoundary, 36, 52), [255, 255, 255, 255]),
                    CONFIG.name + ': quad second triangle is not a Uint16 primitive restart',
                );
                CHECK(GL.getError() === GL.NO_ERROR, CONFIG.name + ': large mesh/quad leaves no WebGL error');
                BOUNDARY.dispose();
            }
            RESULTS.push({ name: CONFIG.name, frames: BEFORE, restored: true, indexBoundary });
            CTX.deleteClipPath(INNER);
            CTX.deleteClipPath(OUTER);
            CTX.dispose();
            DEVICE.dispose();
            CANVAS.remove();
        }
        const REFERENCE = RESULTS[0];
        for (const RESULT of RESULTS.slice(1)) {
            for (const NAME of Object.keys(REFERENCE.frames)) {
                CHECK(
                    SAME(REFERENCE.frames[NAME].pixels, RESULT.frames[NAME].pixels),
                    RESULT.name + ': ' + NAME + ' must equal the existing renderer pixel for pixel',
                );
            }
            CHECK(
                RESULT.frames.batch.draws < REFERENCE.frames.batch.draws,
                RESULT.name + ': ordered mesh/quads reduce actual draw calls',
            );
        }
        CHECK(
            SAME(RESULTS[0].indexBoundary.pixels, RESULTS[1].indexBoundary.pixels),
            'A 65,532-vertex mesh followed by a quad matches the existing renderer pixel for pixel',
        );
        CHECK(
            RESULTS[1].indexBoundary.ordered.flushReasons.capacity >= 1,
            'The reserved Uint16 restart index forces a capacity flush before the quad',
        );
        CHECK(RESULTS[1].frames.batch.draws === 1, 'A/quad/B/quad/A/quad/B/quad share one ordered draw');
        CHECK(
            RESULTS[2].frames.batch.draws === 2,
            'One-instance capacity splits after four ordered commands without losing order',
        );
        return RESULTS.map(({ name, frames, restored, indexBoundary }) => ({
            name,
            restored,
            indexBoundary: indexBoundary
                ? { draws: indexBoundary.draws, ordered: indexBoundary.ordered, pixelParity: true }
                : null,
            frames: Object.fromEntries(
                Object.entries(frames).map(([key, value]) => [
                    key,
                    {
                        draws: value.draws,
                        ordered: value.ordered,
                        pixelParity: true,
                    },
                ]),
            ),
        }));
    }, moduleURL);
}

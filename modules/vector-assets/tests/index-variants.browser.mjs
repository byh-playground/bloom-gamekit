export async function exercisePr15IndexVariants(page, moduleURL, input) {
    return page.evaluate(
        async ({ url, input }) => {
            const { WebGLDevice: WEB_GL_DEVICE, MeshRenderer: MESH_RENDERER } = await import(url);
            const CANVAS = document.createElement('canvas');
            CANVAS.width = CANVAS.height = 200;
            CANVAS.style.width = CANVAS.style.height = '200px';
            document.body.append(CANVAS);
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                alpha: false,
                antialias: false,
                preserveDrawingBuffer: true,
                checkGLErrors: true,
            });
            const MESHES = new MESH_RENDERER(DEVICE, {
                maxMeshes: 2,
                maxInstances: 8,
            });
            const MAP = (values) =>
                Object.fromEntries(Object.entries(values).map(([name, indices]) => [name, Uint16Array.from(indices)]));
            const MESH = MESHES.createMesh({
                vertices: Float32Array.from(input.vertices),
                indices: Uint16Array.from(input.indices),
                expressionIndices: MAP(input.expressionIndices),
                indexVariants: MAP(input.indexVariants),
                strideFloats: 11,
                partCount: input.partCount,
                morphCount: 0,
            });
            const EXPECTED_BYTES =
                MESH.vertices.byteLength +
                MESH.indices.byteLength +
                [...MESH.expressionIndices.values(), ...MESH.indexVariants.values()].reduce(
                    (sum, variant) => sum + variant.indices.byteLength,
                    0,
                );
            if (
                MESH.byteLength !== EXPECTED_BYTES ||
                !MESH.indexVariants.has('paint_0') ||
                MESH.expressionIndices.has('paint_0') ||
                !MESH.expressionIndices.has('neutral')
            ) {
                throw new Error('Named index maps were not retained separately');
            }
            const PROJECTION = [2 / 200, 0, 0, 0, -2 / 200, 0, -1, 1, 1];
            const RENDER = (draw) => {
                if (
                    !DEVICE.beginFrame({
                        width: 200,
                        height: 200,
                        clearColor: [0.06, 0.08, 0.1, 1],
                    })
                ) {
                    throw new Error('WebGL frame did not begin');
                }
                MESHES.beginFrame();
                draw();
                MESHES.flush();
                const PIXELS = new Uint8Array(200 * 200 * 4);
                DEVICE.gl.readPixels(0, 0, 200, 200, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                const DRAWS = MESHES.stats().draws,
                    GL_ERROR = DEVICE.gl.getError();
                DEVICE.endFrame();
                return {
                    pixels: PIXELS,
                    draws: DRAWS,
                    glError: GL_ERROR,
                };
            };
            try {
                const BASE = RENDER(() =>
                    MESHES.drawMesh(MESH, {
                        projection: PROJECTION,
                    }),
                );
                const ORDERED_MESH_RANGES = RENDER(() => {
                    for (const LAYER of input.paintOrder) {
                        if (LAYER.kind === 'mesh') {
                            MESHES.drawMesh(MESH, {
                                projection: PROJECTION,
                                indexVariant: LAYER.indexVariant,
                            });
                        }
                    }
                });
                const EXPRESSION = RENDER(() =>
                    MESHES.drawMesh(MESH, {
                        projection: PROJECTION,
                        indexVariant: 'neutral',
                    }),
                );
                const EXPRESSION_HAPPY = RENDER(() =>
                    MESHES.drawMesh(MESH, {
                        projection: PROJECTION,
                        indexVariant: 'happy',
                    }),
                );
                let painterPixelMismatch = 0;
                let expressionPixelDifference = 0;
                for (let index = 0; index < BASE.pixels.length; index++) {
                    if (BASE.pixels[index] !== ORDERED_MESH_RANGES.pixels[index]) {
                        painterPixelMismatch++;
                    }
                    if (EXPRESSION.pixels[index] !== EXPRESSION_HAPPY.pixels[index]) {
                        expressionPixelDifference++;
                    }
                }
                const REPORT = {
                    fixture: 'Squish PR15 enemy-boss compiled SVG',
                    viewportCss: [200, 200],
                    genericVariantNames: [...MESH.indexVariants.keys()],
                    semanticExpressionNames: [...MESH.expressionIndices.keys()],
                    baseDraws: BASE.draws,
                    painterRangeDraws: ORDERED_MESH_RANGES.draws,
                    painterPixelMismatch,
                    expressionPixelDifference,
                    glErrors: [BASE.glError, ORDERED_MESH_RANGES.glError, EXPRESSION.glError, EXPRESSION_HAPPY.glError],
                    retainedBytes: MESH.byteLength,
                };
                if (
                    REPORT.painterPixelMismatch !== 0 ||
                    REPORT.expressionPixelDifference === 0 ||
                    REPORT.baseDraws !== 1 ||
                    REPORT.painterRangeDraws !== 2 ||
                    REPORT.glErrors.some((error) => error !== 0)
                ) {
                    throw new Error('PR15 named index variant pixel check failed: ' + JSON.stringify(REPORT));
                }
                const GPU_BYTES_BEFORE_DELETE = DEVICE.stats.gpuBufferBytes;
                if (
                    !MESHES.deleteMesh(MESH) ||
                    MESHES.stats().retainedBytes !== 0 ||
                    DEVICE.stats.gpuBufferBytes >= GPU_BYTES_BEFORE_DELETE
                ) {
                    throw new Error('Named variant buffers were not released with the retained mesh');
                }
                return REPORT;
            } finally {
                MESHES.dispose();
                DEVICE.dispose();
                CANVAS.remove();
            }
        },
        {
            url: moduleURL,
            input,
        },
    );
}

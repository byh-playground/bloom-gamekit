/** Compares separate asset draws with a single painter-ordered retained mesh. */
export async function exerciseOrderedAssetBatch(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            MeshRenderer: MESH_RENDERER,
            MeshBuilder: MESH_BUILDER,
        } = await import(url);
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            checkGLErrors: true,
        });
        const MESHES = new MESH_RENDERER(DEVICE, {
            maxMeshes: 8,
            maxInstances: 8,
        });
        const QUAD = (color, dx = 0, dy = 0) => {
            const BUILDER = new MESH_BUILDER();
            BUILDER.fillTriangleFan(
                [
                    [6 + dx, 6 + dy],
                    [26 + dx, 6 + dy],
                    [26 + dx, 26 + dy],
                    [6 + dx, 26 + dy],
                ],
                color,
            );
            return BUILDER;
        };
        const RED_DATA = QUAD([1, 0, 0, 1]).build();
        const GREEN_DATA = QUAD([0, 1, 0, 1]).build({
            morphs: [QUAD([0, 1, 0, 1], 2), QUAD([0, 1, 0, 1], 0, 2)],
        });
        const BLUE_DATA = QUAD([0, 0, 1, 1]).build({
            morphs: [QUAD([0, 0, 1, 1], 2, 2)],
        });
        const INDIVIDUAL = [RED_DATA, GREEN_DATA, BLUE_DATA].map((data) => MESHES.createMesh(data));
        const COMBINED_DATA = MESH_BUILDER.combine([MESH_BUILDER.combine([RED_DATA, GREEN_DATA]), BLUE_DATA]);
        const COMBINED = MESHES.createMesh(COMBINED_DATA);
        const PROJECTION = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
        const CLIPS = [
            [
                {
                    x: 0,
                    y: 0,
                },
                {
                    x: 24,
                    y: 0,
                },
                {
                    x: 24,
                    y: 42,
                },
                {
                    x: 0,
                    y: 42,
                },
            ],
        ];
        const TRANSFORMS = [
            [1, 0, 0, 1, 0, 0],
            [1, 0, 0, 1, 10, 10],
            [1, 0, 0, 1, 10, 10],
        ];
        const MORPHS = [
            [0, 0],
            [0.25, 0.1],
            [0.1, 0.25],
        ];
        const PIXEL_BYTES = () => {
            const PIXELS = new Uint8Array(64 * 64 * 4);
            DEVICE.gl.readPixels(0, 0, 64, 64, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        };
        const FRAME = (paint) => {
            DEVICE.beginFrame({
                width: 64,
                height: 64,
                clearColor: [0, 0, 0, 1],
            });
            MESHES.beginFrame();
            paint();
            MESHES.flush();
            const DEVICE_STATS = DEVICE.endFrame();
            DEVICE.gl.finish();
            return {
                pixels: PIXEL_BYTES(),
                meshStats: MESHES.stats(),
                deviceStats: DEVICE_STATS,
            };
        };
        try {
            const SEPARATE = FRAME(() => {
                for (let index = 0; index < INDIVIDUAL.length; index++) {
                    MESHES.drawMesh(INDIVIDUAL[index], {
                        projection: PROJECTION,
                        matrix: TRANSFORMS[index],
                        clips: CLIPS,
                        morph: MORPHS[index],
                        alpha: index === 2 ? 0.5 : 1,
                    });
                }
            });
            const ORDERED_PARTS = TRANSFORMS.map((transform, index) => ({
                transform,
                morph: MORPHS[index],
                opacity: index === 2 ? 0.5 : 1,
            }));
            const BATCHED = FRAME(() =>
                MESHES.drawMesh(COMBINED, {
                    projection: PROJECTION,
                    parts: ORDERED_PARTS,
                    clips: CLIPS,
                }),
            );
            let rejectsOverflow = false;
            try {
                MESH_BUILDER.combine(
                    Array.from(
                        {
                            length: 17,
                        },
                        () => RED_DATA,
                    ),
                );
            } catch (error) {
                rejectsOverflow = error instanceof TypeError;
            }
            const READ_PIXEL = (pixels, x, y) => {
                const AT = ((63 - y) * 64 + x) * 4;
                return [...pixels.subarray(AT, AT + 4)];
            };
            const PIXEL_MISMATCH = SEPARATE.pixels.reduce(
                (total, value, index) => total + Number(value !== BATCHED.pixels[index]),
                0,
            );
            const REPORT = {
                separate: {
                    draws: SEPARATE.meshStats.draws,
                    instances: SEPARATE.meshStats.instances,
                    instanceBytes: SEPARATE.meshStats.instanceBytesUploaded,
                },
                batched: {
                    draws: BATCHED.meshStats.draws,
                    instances: BATCHED.meshStats.instances,
                    instanceBytes: BATCHED.meshStats.instanceBytesUploaded,
                    geometryUploads: BATCHED.meshStats.geometryUploads,
                    retainedBytes: BATCHED.meshStats.retainedBytes,
                },
                combined: {
                    parts: COMBINED_DATA.partCount,
                    morphs: COMBINED_DATA.morphCount,
                    vertices: COMBINED_DATA.vertices.length / 11,
                },
                overlap: READ_PIXEL(BATCHED.pixels, 22, 22),
                clipped: READ_PIXEL(BATCHED.pixels, 28, 22),
                pixelMismatch: PIXEL_MISMATCH,
                glError: DEVICE.gl.getError(),
                instancing: MESHES.stats().instanced,
            };
            if (
                REPORT.combined.parts !== 3 ||
                REPORT.separate.draws !== 3 ||
                REPORT.batched.draws !== 1 ||
                REPORT.overlap[0] > 2 ||
                Math.abs(REPORT.overlap[1] - 128) > 2 ||
                Math.abs(REPORT.overlap[2] - 128) > 2 ||
                REPORT.clipped.some((value, index) => value !== [0, 0, 0, 255][index]) ||
                REPORT.combined.morphs !== 2 ||
                !rejectsOverflow ||
                REPORT.pixelMismatch !== 0 ||
                REPORT.glError !== 0
            ) {
                throw new Error('Ordered asset batch mismatch: ' + JSON.stringify(REPORT));
            }
            return REPORT;
        } finally {
            MESHES.dispose();
            DEVICE.dispose();
            CANVAS.remove();
        }
    }, moduleURL);
}

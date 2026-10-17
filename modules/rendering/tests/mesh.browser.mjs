import assert from 'node:assert/strict';

/** One retained animated-art scene, including compositing, device recovery and shutdown. */
export async function exerciseReusableMeshes(page) {
    const RESULTS = [];
    for (const ANTIALIAS of [false, true]) {
        for (const WITHOUT_ANGLE of [false, true]) {
            RESULTS.push(
                await page.evaluate(
                    async ({ withoutANGLE, antialias }) => {
                        const {
                            WebGLDevice: WEB_GL_DEVICE,
                            VectorContext: VECTOR_CONTEXT,
                            MeshBuilder: MESH_BUILDER,
                            PrimitivePainter: PRIMITIVE_PAINTER,
                        } = await import('/dist/rendering.js');
                        const CHECK = (ok, message) => {
                            if (!ok) {
                                throw new Error(message);
                            }
                        };
                        const NEAR = (actual, expected, message) =>
                            CHECK(
                                actual.every((v, i) => Math.abs(v - expected[i]) <= 2),
                                `${message}: ${actual}, expected ${expected}`,
                            );
                        const CANVAS = document.createElement('canvas');
                        CANVAS.width = CANVAS.height = 128;
                        document.body.append(CANVAS);
                        const NATIVE_GET_CONTEXT = CANVAS.getContext.bind(CANVAS);
                        let interceptedGL;
                        let nativeGetExtension;
                        if (withoutANGLE) {
                            CANVAS.getContext = (...args) => {
                                const GL = NATIVE_GET_CONTEXT(...args);
                                interceptedGL = GL;
                                nativeGetExtension = GL.getExtension;
                                GL.getExtension = (name) =>
                                    name === 'ANGLE_instanced_arrays' ? null : nativeGetExtension.call(GL, name);
                                return GL;
                            };
                        }
                        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                            alpha: false,
                            antialias,
                            preserveDrawingBuffer: true,
                        });
                        if (withoutANGLE) {
                            interceptedGL.getExtension = nativeGetExtension;
                            CANVAS.getContext = NATIVE_GET_CONTEXT;
                        }
                        const CTX = new VECTOR_CONTEXT(DEVICE),
                            GL = DEVICE.gl;
                        try {
                            CHECK(DEVICE.instancingSupported === !withoutANGLE, 'real device backend selection');
                            const SAMPLES_LOCAL = GL.getParameter(GL.SAMPLES);
                            CHECK(
                                !antialias || (GL.getContextAttributes().antialias && SAMPLES_LOCAL > 1),
                                'requested MSAA is actually active',
                            );
                            const PIXEL = (x, y) => {
                                const BYTES = new Uint8Array(4);
                                GL.readPixels(x, 127 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, BYTES);
                                return [...BYTES];
                            };
                            const PIXELS = () => {
                                const BYTES = new Uint8Array(128 * 128 * 4);
                                GL.readPixels(0, 0, 128, 128, GL.RGBA, GL.UNSIGNED_BYTE, BYTES);
                                return BYTES;
                            };
                            const BEGIN = () => {
                                CHECK(
                                    CTX.beginFrame({
                                        clearColor: [0, 0, 0, 1],
                                    }),
                                    'scene frame available',
                                );
                            };
                            const ART = (right = 6, top = -6) => {
                                const BUILDER = new MESH_BUILDER();
                                new PRIMITIVE_PAINTER(BUILDER).quad(
                                    -6,
                                    top,
                                    right,
                                    top,
                                    right,
                                    6,
                                    -6,
                                    6,
                                    [1, 0, 0, 0.5],
                                );
                                return BUILDER;
                            };
                            const BASE = ART(),
                                DATA = BASE.build({
                                    morphs: [ART(14), ART(6, -12)],
                                });
                            BEGIN();
                            const MESH = CTX.createMesh(DATA);
                            for (const X of [24, 64]) {
                                CTX.save();
                                CTX.translate(X, 24);
                                CTX.withSilhouette('#00ff00', 3, () => CTX.drawMesh(MESH), 20);
                                CTX.restore();
                            }
                            const COLD = CTX.endFrame();
                            NEAR(PIXEL(16, 24), [0, 255, 0, 255], 'retained silhouette edge');
                            NEAR(PIXEL(24, 24), [128, 127, 0, 255], 'body follows forced-color silhouette');
                            CHECK(
                                COLD.mesh.geometryUploads === 1 &&
                                    COLD.mesh.geometryBytesUploaded === DATA.vertices.byteLength,
                                'cold geometry uploaded exactly once',
                            );
                            CHECK(COLD.mesh.instances === 20, 'two silhouettes reuse one mesh for all twenty passes');
                            CHECK(
                                COLD.uploadedBytes >= COLD.mesh.geometryBytesUploaded + COLD.mesh.instanceBytesUploaded,
                                'cold upload accounting includes retained geometry and any instance records without assuming no vector group submissions',
                            );
                            BEGIN();
                            for (const X of [24, 64, 104]) {
                                CTX.drawMesh(MESH, {
                                    transform: [1, 0, 0, 1, X, 24],
                                });
                            }
                            const WARM = CTX.endFrame();
                            for (const X of [24, 64, 104]) {
                                NEAR(PIXEL(X, 24), [128, 0, 0, 255], 'adjacent retained instances');
                            }
                            CHECK(
                                WARM.mesh.geometryUploads === 0 && WARM.mesh.geometryBytesUploaded === 0,
                                'warm scene never rebuilds/uploads geometry',
                            );
                            CHECK(
                                WARM.mesh.draws === (withoutANGLE ? 3 : 1) && WARM.mesh.instances === 3,
                                'adjacent same-mesh batch',
                            );
                            CHECK(
                                DEVICE.stats.instancedDrawCalls === (withoutANGLE ? 0 : 1),
                                'device records actual instanced draw',
                            );
                            CHECK(
                                WARM.uploadedBytes === (withoutANGLE ? 0 : 3 * 64) &&
                                    WARM.mesh.instanceBytesUploaded === WARM.uploadedBytes,
                                'warm upload contains only instance records, uniform backend uploads none',
                            );
                            BEGIN();
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 24, 24],
                            });
                            CTX.save();
                            CTX.translate(70, 32);
                            CTX.rotate(Math.PI / 2);
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 0, -10],
                                morph: [0.5, 0.5],
                            });
                            CTX.restore();
                            CTX.endFrame();
                            NEAR(
                                PIXEL(24, 24),
                                [128, 0, 0, 255],
                                'earlier instance keeps its captured transform/morph',
                            );
                            NEAR(PIXEL(88, 32), [128, 0, 0, 255], 'second morph expands rotated top edge');
                            NEAR(PIXEL(80, 40), [128, 0, 0, 255], 'first morph expands rotated right edge');
                            NEAR(PIXEL(90, 32), [0, 0, 0, 255], 'animated mesh retains its exact boundary');
                            BEGIN();
                            CTX.save();
                            CTX.translate(20, 20);
                            CTX.rotate(Math.PI / 2);
                            const SINGLE_POSE = [
                                {
                                    transform: [2, 0, 0, 0.5, 12, 0],
                                    morph: [0.5, 0.25],
                                },
                            ];
                            CTX.drawMesh(MESH, {
                                parts: SINGLE_POSE,
                                morph: [0.25, 0.25],
                            });
                            SINGLE_POSE[0].transform[4] = 60;
                            CTX.drawMesh(MESH, {
                                parts: SINGLE_POSE,
                                morph: [0.25, 0.25],
                            });
                            SINGLE_POSE[0].transform[4] = 95;
                            SINGLE_POSE[0].visible = false;
                            CTX.drawMesh(MESH, {
                                parts: SINGLE_POSE,
                                morph: [0.25, 0.25],
                            });
                            CTX.restore();
                            const SINGLE_POSE_STATS = CTX.endFrame();
                            NEAR(
                                PIXEL(22, 24),
                                [128, 0, 0, 255],
                                'single-part pose retains its original non-identity transform',
                            );
                            NEAR(
                                PIXEL(22, 54),
                                [128, 0, 0, 255],
                                'single-part pose adds local and instance morph weights',
                            );
                            NEAR(
                                PIXEL(22, 72),
                                [128, 0, 0, 255],
                                'in-place single-part transform change affects only the next instance',
                            );
                            NEAR(
                                PIXEL(22, 110),
                                [0, 0, 0, 255],
                                'hidden single part remains absent after pose mutation',
                            );
                            CHECK(
                                SINGLE_POSE_STATS.mesh.draws === (withoutANGLE ? 3 : 1) &&
                                    SINGLE_POSE_STATS.mesh.partUniformBytesSubmitted === 0,
                                'single-part pose is folded into adjacent instances, not per-vertex uniforms',
                            );
                            BEGIN();
                            CTX.globalAlpha = 0.5;
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 16, 24],
                            });
                            CTX.withColor([0, 1, 0, 0.5], () =>
                                CTX.drawMesh(MESH, {
                                    transform: [1, 0, 0, 1, 48, 24],
                                }),
                            );
                            CTX.filter = 'brightness(0) invert(1)';
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 80, 24],
                            });
                            CTX.withColor([0, 1, 0, 0.5], () =>
                                CTX.drawMesh(MESH, {
                                    transform: [1, 0, 0, 1, 112, 24],
                                }),
                            );
                            CTX.filter = 'none';
                            CTX.globalAlpha = 1;
                            CTX.endFrame();
                            NEAR(PIXEL(16, 24), [64, 0, 0, 255], 'authored alpha times instance alpha');
                            NEAR(PIXEL(48, 24), [0, 64, 0, 255], 'forced color replaces authored color/alpha');
                            NEAR(PIXEL(80, 24), [64, 64, 64, 255], 'white flash preserves authored alpha');
                            NEAR(
                                PIXEL(112, 24),
                                [64, 64, 64, 255],
                                'white flash follows forced color without losing alpha',
                            );
                            BEGIN();
                            CTX.fillTriangleFan(
                                [
                                    [12, 12],
                                    [36, 12],
                                    [36, 36],
                                    [12, 36],
                                ],
                                '#0000ff',
                            );
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 24, 24],
                            });
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 72, 24],
                            });
                            CTX.fillTriangleFan(
                                [
                                    [60, 12],
                                    [84, 12],
                                    [84, 36],
                                    [60, 36],
                                ],
                                '#0000ff',
                            );
                            CTX.endFrame();
                            NEAR(PIXEL(24, 24), [128, 0, 127, 255], 'queued vector then mesh painter order');
                            NEAR(PIXEL(72, 24), [0, 0, 255, 255], 'queued mesh then vector painter order');
                            const CLIPPED_SCENE = (retained, nested = true) => {
                                BEGIN();
                                CTX.save();
                                const PAINT = () => {
                                    CTX.translate(64, 64);
                                    CTX.rotate(Math.PI / 4);
                                    CTX.clipRect(-18, -12, 36, 24);
                                    CTX.resetTransform();
                                    CTX.withColor('#ff0000', () => {
                                        if (retained) {
                                            CTX.drawMesh(MESH, {
                                                transform: [5, 0, 0, 5, 64, 64],
                                            });
                                        } else {
                                            CTX.fillTriangleFan(
                                                [
                                                    [34, 34],
                                                    [94, 34],
                                                    [94, 94],
                                                    [34, 94],
                                                ],
                                                '#ff0000',
                                            );
                                        }
                                    });
                                };
                                if (nested) {
                                    CTX.withGroupOpacity(
                                        0.5,
                                        () =>
                                            CTX.withGroupOpacity(0.5, PAINT, {
                                                x: 24,
                                                y: 24,
                                                width: 80,
                                                height: 80,
                                            }),
                                        {
                                            x: 8,
                                            y: 8,
                                            width: 112,
                                            height: 112,
                                        },
                                    );
                                } else {
                                    PAINT();
                                } // Actual multisampled default framebuffer, not a single-sample opacity FBO.
                                CTX.restore();
                                CTX.endFrame();
                                return PIXELS();
                            };
                            const CLIPPED = CLIPPED_SCENE(true);
                            NEAR(PIXEL(64, 64), [64, 0, 0, 255], 'nested opacity applied once at each target');
                            NEAR(PIXEL(70, 60), [64, 0, 0, 255], 'rotated clip interior');
                            NEAR(PIXEL(85, 85), [0, 0, 0, 255], 'rotated clip excludes bounding-box corner');
                            const VECTOR_REFERENCE = CLIPPED_SCENE(false);
                            let clipDifference = 0;
                            let maxClipDifference = 0;
                            let clipInteriorDifference = 0;
                            let clipExteriorDifference = 0;
                            let maxClipEdgeDifference = 0;
                            for (let i = 0; i < CLIPPED.length; i++) {
                                const DELTA = Math.abs(CLIPPED[i] - VECTOR_REFERENCE[i]);
                                const PIXEL_INDEX = Math.floor(i / 4),
                                    DX = (PIXEL_INDEX % 128) + 0.5 - 64,
                                    DY = 127 - Math.floor(PIXEL_INDEX / 128) + 0.5 - 64;
                                const DISTANCE = Math.min(
                                    18 - Math.abs((DX + DY) * Math.SQRT1_2),
                                    12 - Math.abs((-DX + DY) * Math.SQRT1_2),
                                );
                                if (DELTA > 2) {
                                    clipDifference++;
                                    if (DISTANCE > 2) {
                                        clipInteriorDifference++;
                                    } else if (DISTANCE < -2) {
                                        clipExteriorDifference++;
                                    }
                                }
                                maxClipDifference = Math.max(maxClipDifference, DELTA);
                                if (Math.abs(DISTANCE) <= 2) {
                                    maxClipEdgeDifference = Math.max(maxClipEdgeDifference, DELTA);
                                }
                            }
                            CHECK(
                                clipInteriorDifference === 0 && clipExteriorDifference === 0,
                                `mesh/vector rotated clip interior/exterior parity: ${clipInteriorDifference}/${clipExteriorDifference}`,
                            );
                            // Fragment-plane discard and MSAA-tessellated vector edges have distinct coverage;
                            // report those edge pixels explicitly rather than disguising them as exact parity.
                            CHECK(
                                antialias || clipDifference === 0,
                                `non-MSAA full rotated clip parity: ${clipDifference} channels, max ${maxClipDifference}`,
                            );
                            const DIRECT_CLIPPED = CLIPPED_SCENE(true, false),
                                DIRECT_VECTOR = CLIPPED_SCENE(false, false);
                            let directInteriorDifference = 0;
                            let directExteriorDifference = 0;
                            let directEdgeDifference = 0;
                            let directMaxEdgeDifference = 0;
                            for (let p = 0; p < 128 * 128; p++) {
                                const DX = (p % 128) + 0.5 - 64,
                                    DY = 127 - Math.floor(p / 128) + 0.5 - 64;
                                const DISTANCE = Math.min(
                                    18 - Math.abs((DX + DY) * Math.SQRT1_2),
                                    12 - Math.abs((-DX + DY) * Math.SQRT1_2),
                                );
                                for (let c = 0; c < 4; c++) {
                                    const DELTA = Math.abs(DIRECT_CLIPPED[p * 4 + c] - DIRECT_VECTOR[p * 4 + c]);
                                    if (Math.abs(DISTANCE) <= 2) {
                                        directMaxEdgeDifference = Math.max(directMaxEdgeDifference, DELTA);
                                        if (DELTA > 2) {
                                            directEdgeDifference++;
                                        }
                                    } else if (DELTA > 2) {
                                        if (DISTANCE > 2) {
                                            directInteriorDifference++;
                                        } else {
                                            directExteriorDifference++;
                                        }
                                    }
                                }
                            }
                            CHECK(
                                directInteriorDifference === 0 && directExteriorDifference === 0,
                                `default-framebuffer rotated clip interior/exterior parity: ${directInteriorDifference}/${directExteriorDifference}`,
                            );
                            CHECK(
                                antialias || directEdgeDifference === 0,
                                'non-MSAA direct clip has exact vector edge coverage',
                            );

                            // Three authored overlapping translucent parts stay one ordered mesh, even
                            // when independent part animation and silhouette instances are combined.
                            const AUTHORED = [
                                {
                                    points: [
                                        [-12, -8],
                                        [12, -8],
                                        [12, 8],
                                        [-12, 8],
                                    ],
                                    color: [1, 0, 0, 0.5],
                                    targets: [
                                        [
                                            [-12, -8],
                                            [20, -8],
                                            [20, 8],
                                            [-12, 8],
                                        ],
                                        [
                                            [-12, -12],
                                            [12, -12],
                                            [12, 8],
                                            [-12, 8],
                                        ],
                                    ],
                                },
                                {
                                    points: [
                                        [-9, -11],
                                        [9, -11],
                                        [9, 11],
                                        [-9, 11],
                                    ],
                                    color: [0, 1, 0, 0.4],
                                    targets: [
                                        [
                                            [-9, -11],
                                            [14, -11],
                                            [14, 11],
                                            [-9, 11],
                                        ],
                                        [
                                            [-9, -11],
                                            [9, -11],
                                            [9, 17],
                                            [-9, 17],
                                        ],
                                    ],
                                },
                                {
                                    points: [
                                        [-8, -8],
                                        [10, -6],
                                        [0, 12],
                                    ],
                                    color: [0, 0, 1, 0.6],
                                    targets: [
                                        [
                                            [-8, -8],
                                            [10, -6],
                                            [6, 12],
                                        ],
                                        [
                                            [-8, -8],
                                            [10, -6],
                                            [0, 20],
                                        ],
                                    ],
                                },
                            ];
                            const BUILD_PART = (points, color) => {
                                const B = new MESH_BUILDER();
                                new PRIMITIVE_PAINTER(B).poly(points, color);
                                return B;
                            };
                            const PACKED_DATA = MESH_BUILDER.combine(
                                AUTHORED.map((a) =>
                                    BUILD_PART(a.points, a.color).build({
                                        morphs: a.targets.map((p) => BUILD_PART(p, a.color)),
                                    }),
                                ),
                            );
                            CHECK(
                                PACKED_DATA.strideFloats === 11 && PACKED_DATA.partCount === 3,
                                'packed authored schema',
                            );
                            const ROTATION = (angle, x, y) => [
                                Math.cos(angle),
                                Math.sin(angle),
                                -Math.sin(angle),
                                Math.cos(angle),
                                x,
                                y,
                            ];
                            const POSES = () => [
                                {
                                    transform: [1, 0, 0, 1, 0, 0],
                                    morph: [0.25, 0.1],
                                    visible: true,
                                },
                                {
                                    transform: ROTATION(Math.PI / 6, 2, 1),
                                    morph: [0.2, 0.3],
                                    visible: true,
                                },
                                {
                                    transform: ROTATION(-Math.PI / 5, -2, -1),
                                    morph: [0.1, 0.2],
                                    visible: false,
                                },
                            ];
                            const GLOBAL_MORPH = [0.125, 0.1];
                            const PART_POINTS = (a, part) =>
                                a.points.map((p, i) =>
                                    p.map(
                                        (v, axis) =>
                                            v +
                                            (a.targets[0][i][axis] - v) * (GLOBAL_MORPH[0] + part.morph[0]) +
                                            (a.targets[1][i][axis] - v) * (GLOBAL_MORPH[1] + part.morph[1]),
                                    ),
                                );
                            const REFERENCE = (parts) => {
                                for (let i = 0; i < AUTHORED.length; i++) {
                                    const PART = parts[i];
                                    if (PART.visible === false) {
                                        continue;
                                    }
                                    CTX.save();
                                    CTX.transform(...PART.transform);
                                    CTX.fillTriangleFan(PART_POINTS(AUTHORED[i], PART), AUTHORED[i].color);
                                    CTX.restore();
                                }
                            };
                            BEGIN();
                            const PACKED_MESH = CTX.createMesh(PACKED_DATA),
                                INITIAL_PARTS = POSES();
                            CTX.drawMesh(PACKED_MESH, {
                                transform: [1, 0, 0, 1, 34, 64],
                                parts: INITIAL_PARTS,
                                morph: GLOBAL_MORPH,
                            });
                            const PACKED_COLD = CTX.endFrame();
                            CHECK(
                                PACKED_COLD.mesh.geometryUploads === 1 &&
                                    PACKED_COLD.mesh.geometryBytesUploaded ===
                                        PACKED_DATA.vertices.byteLength + PACKED_DATA.indices.byteLength,
                                'combined indexed geometry uploaded once',
                            );
                            NEAR(
                                PIXEL(34, 64),
                                [77, 102, 0, 255],
                                'original red then green order, hidden blue part absent',
                            );
                            const PAINT_PACKED_SCENE = (retained, draws, silhouette = false) => {
                                BEGIN();
                                let callbacks = 0;
                                for (const { x: X, y: Y, parts: PARTS } of draws) {
                                    CTX.save();
                                    CTX.translate(X, Y);
                                    const PAINT = () => {
                                        callbacks++;
                                        if (retained) {
                                            CTX.drawMesh(PACKED_MESH, {
                                                parts: PARTS,
                                                morph: GLOBAL_MORPH,
                                            });
                                        } else {
                                            REFERENCE(PARTS);
                                        }
                                    };
                                    if (silhouette) {
                                        CTX.withSilhouette('#ffe000', 3, PAINT, 40);
                                    } else {
                                        PAINT();
                                    }
                                    CTX.restore();
                                }
                                const STATS = CTX.endFrame();
                                return {
                                    bytes: PIXELS(),
                                    stats: STATS,
                                    callbacks,
                                };
                            };
                            const POLYGON_POINTS = (draws) =>
                                draws.flatMap((draw) =>
                                    AUTHORED.flatMap((a, i) => {
                                        const PART = draw.parts[i];
                                        if (PART.visible === false) {
                                            return [];
                                        }
                                        const M = PART.transform;
                                        return [
                                            PART_POINTS(a, PART).map(([x, y]) => [
                                                M[0] * x + M[2] * y + M[4] + draw.x,
                                                M[1] * x + M[3] * y + M[5] + draw.y,
                                            ]),
                                        ];
                                    }),
                                );
                            const COMPARE_PACKED = (actual, expected, draws, silhouette = false) => {
                                let differentChannels = 0;
                                let interiorDifferentChannels = 0;
                                let maxDifference = 0;
                                const POLYGONS = POLYGON_POINTS(draws),
                                    OFFSETS = [[0, 0]];
                                if (silhouette) {
                                    for (let i = 0; i < 8; i++) {
                                        OFFSETS.push([
                                            Math.cos((i * Math.PI) / 4) * 3,
                                            Math.sin((i * Math.PI) / 4) * 3,
                                        ]);
                                    }
                                }
                                for (let p = 0; p < 128 * 128; p++) {
                                    const X = (p % 128) + 0.5,
                                        Y = 127 - Math.floor(p / 128) + 0.5;
                                    let distance = Infinity;
                                    for (const POLYGON of POLYGONS) {
                                        for (const [OX, OY] of OFFSETS) {
                                            for (let j = 0; j < POLYGON.length; j++) {
                                                const A = POLYGON[j],
                                                    B = POLYGON[(j + 1) % POLYGON.length],
                                                    DX = B[0] - A[0],
                                                    DY = B[1] - A[1];
                                                const T = Math.max(
                                                    0,
                                                    Math.min(
                                                        1,
                                                        ((X - OX - A[0]) * DX + (Y - OY - A[1]) * DY) /
                                                            (DX * DX + DY * DY),
                                                    ),
                                                );
                                                distance = Math.min(
                                                    distance,
                                                    Math.hypot(X - OX - A[0] - T * DX, Y - OY - A[1] - T * DY),
                                                );
                                            }
                                        }
                                    }
                                    for (let c = 0; c < 4; c++) {
                                        const DELTA = Math.abs(actual[p * 4 + c] - expected[p * 4 + c]);
                                        maxDifference = Math.max(maxDifference, DELTA);
                                        if (DELTA > 2) {
                                            differentChannels++;
                                            if (distance > 1.5) {
                                                interiorDifferentChannels++;
                                            }
                                        }
                                    }
                                }
                                CHECK(
                                    interiorDifferentChannels === 0,
                                    `packed authored order/animation interior parity: ${interiorDifferentChannels} channels`,
                                );
                                CHECK(
                                    antialias || differentChannels === 0,
                                    `non-MSAA packed scene pixel parity: ${differentChannels} channels, max ${maxDifference}`,
                                );
                                return {
                                    differentChannels,
                                    interiorDifferentChannels,
                                    maxDifference,
                                };
                            };
                            const ANIMATED_PARTS = POSES(),
                                BEFORE_MUTATION = structuredClone(ANIMATED_PARTS);
                            BEGIN();
                            CTX.drawMesh(PACKED_MESH, {
                                transform: [1, 0, 0, 1, 34, 64],
                                parts: ANIMATED_PARTS,
                                morph: GLOBAL_MORPH,
                            });
                            ANIMATED_PARTS[0].transform[4] = 7;
                            ANIMATED_PARTS[1].transform.splice(0, 4, ...ROTATION(-Math.PI / 7, 0, 0).slice(0, 4));
                            ANIMATED_PARTS[1].morph[0] = 0.75;
                            ANIMATED_PARTS[2].visible = true;
                            ANIMATED_PARTS[2].morph[1] = 0.5;
                            const AFTER_MUTATION = structuredClone(ANIMATED_PARTS);
                            CTX.drawMesh(PACKED_MESH, {
                                transform: [1, 0, 0, 1, 94, 64],
                                parts: ANIMATED_PARTS,
                                morph: GLOBAL_MORPH,
                            });
                            CHECK(
                                DEVICE.stats.drawCalls === 1,
                                'in-place part mutation flushes the earlier captured instance immediately',
                            );
                            NEAR(
                                PIXEL(34, 64),
                                [77, 102, 0, 255],
                                'first submitted instance keeps pre-mutation colors/visibility/pose',
                            );
                            ANIMATED_PARTS[2].visible = false;
                            for (const PART of ANIMATED_PARTS) {
                                PART.transform[4] += 1000;
                            }
                            const MUTATION_STATS = CTX.endFrame(),
                                MUTATION_PIXELS = PIXELS();
                            NEAR(
                                PIXEL(94, 64),
                                [31, 41, 153, 255],
                                'second queued instance keeps captured pose after caller mutates again',
                            );
                            CHECK(
                                MUTATION_STATS.mesh.draws === 2 && MUTATION_STATS.mesh.geometryUploads === 0,
                                'part-state boundary uses two ordered draws without geometry upload',
                            );
                            const MUTATION_DRAWS = [
                                {
                                    x: 34,
                                    y: 64,
                                    parts: BEFORE_MUTATION,
                                },
                                {
                                    x: 94,
                                    y: 64,
                                    parts: AFTER_MUTATION,
                                },
                            ];
                            const MUTATION_REFERENCE = PAINT_PACKED_SCENE(false, MUTATION_DRAWS);
                            const MUTATION_PARITY = COMPARE_PACKED(
                                MUTATION_PIXELS,
                                MUTATION_REFERENCE.bytes,
                                MUTATION_DRAWS,
                            );
                            const SILHOUETTE_PARTS = POSES();
                            SILHOUETTE_PARTS[2].visible = true;
                            const SILHOUETTE_DRAWS = [
                                {
                                    x: 64,
                                    y: 64,
                                    parts: SILHOUETTE_PARTS,
                                },
                            ];
                            const SILHOUETTE_PACKED = PAINT_PACKED_SCENE(true, SILHOUETTE_DRAWS, true);
                            CHECK(
                                SILHOUETTE_PACKED.callbacks === 10 && SILHOUETTE_PACKED.stats.mesh.instances === 10,
                                'three-part silhouette submits exactly ten whole-mesh instances',
                            );
                            CHECK(
                                SILHOUETTE_PACKED.stats.mesh.geometryUploads === 0 &&
                                    SILHOUETTE_PACKED.stats.mesh.geometryBytesUploaded === 0,
                                'warm combined silhouette reuses retained geometry',
                            );
                            const SILHOUETTE_REFERENCE = PAINT_PACKED_SCENE(false, SILHOUETTE_DRAWS, true);
                            const SILHOUETTE_PARITY = COMPARE_PACKED(
                                SILHOUETTE_PACKED.bytes,
                                SILHOUETTE_REFERENCE.bytes,
                                SILHOUETTE_DRAWS,
                                true,
                            );
                            BEGIN();
                            CTX.save();
                            CTX.translate(64, 64);
                            CTX.drawMeshSilhouette(PACKED_MESH, {
                                parts: SILHOUETTE_PARTS,
                                morph: GLOBAL_MORPH,
                                color: '#ffe000',
                                width: 3,
                                radius: 40,
                            });
                            CTX.restore();
                            const BATCHED_SILHOUETTE_STATS = CTX.endFrame(),
                                BATCHED_SILHOUETTE_PIXELS = PIXELS();
                            const BATCHED_SILHOUETTE_PARITY = COMPARE_PACKED(
                                BATCHED_SILHOUETTE_PIXELS,
                                SILHOUETTE_REFERENCE.bytes,
                                SILHOUETTE_DRAWS,
                                true,
                            );
                            CHECK(
                                BATCHED_SILHOUETTE_PIXELS.every((value, i) => value === SILHOUETTE_PACKED.bytes[i]),
                                'mesh silhouette batching is pixel-identical to the repeated WebGL draw path',
                            );
                            CHECK(
                                BATCHED_SILHOUETTE_STATS.mesh.instances === 10 &&
                                    BATCHED_SILHOUETTE_STATS.mesh.geometryUploads === 0,
                                'one silhouette API preserves ten ordered instances on retained geometry',
                            );
                            const PAINT_SCALED_SILHOUETTE = () => {
                                BEGIN();
                                CTX.save();
                                CTX.translate(64, 64);
                                CTX.drawMeshSilhouette(PACKED_MESH, {
                                    parts: SILHOUETTE_PARTS,
                                    morph: GLOBAL_MORPH,
                                    color: '#ffe000',
                                    width: 3,
                                    radius: 40,
                                    outlineScale: 1.12,
                                });
                                CTX.restore();
                                const STATS = CTX.endFrame();
                                return {
                                    stats: STATS,
                                    bytes: PIXELS(),
                                };
                            };
                            const SCALED_SILHOUETTE = PAINT_SCALED_SILHOUETTE();
                            let scaledOutlineColorPixels = 0;
                            for (let i = 0; i < SCALED_SILHOUETTE.bytes.length; i += 4) {
                                if (
                                    SCALED_SILHOUETTE.bytes[i] > 200 &&
                                    SCALED_SILHOUETTE.bytes[i + 1] > 150 &&
                                    SCALED_SILHOUETTE.bytes[i + 2] < 80 &&
                                    SCALED_SILHOUETTE.bytes[i + 3] > 0
                                ) {
                                    scaledOutlineColorPixels++;
                                }
                            }
                            CHECK(
                                SCALED_SILHOUETTE.stats.mesh.instances === 2 &&
                                    SCALED_SILHOUETTE.stats.mesh.geometryUploads === 0,
                                'outlineScale submits one scaled silhouette and one body instance using retained geometry',
                            );
                            CHECK(
                                scaledOutlineColorPixels > 0,
                                'scaled silhouette preserves the requested rarity outline color',
                            );
                            const RENDER_ORDERED_SILHOUETTE = (batched) => {
                                BEGIN();
                                CTX.fillStyle = '#202020';
                                CTX.fillRect(0, 0, 128, 128);
                                CTX.save();
                                CTX.translate(64, 64);
                                if (batched) {
                                    CTX.drawMeshSilhouette(PACKED_MESH, {
                                        parts: SILHOUETTE_PARTS,
                                        morph: GLOBAL_MORPH,
                                        color: '#ffe000',
                                        width: 3,
                                        radius: 40,
                                    });
                                } else {
                                    CTX.withSilhouette(
                                        '#ffe000',
                                        3,
                                        () =>
                                            CTX.drawMesh(PACKED_MESH, {
                                                parts: SILHOUETTE_PARTS,
                                                morph: GLOBAL_MORPH,
                                            }),
                                        40,
                                    );
                                }
                                CTX.restore();
                                CTX.fillStyle = '#00ccff';
                                CTX.fillRect(60, 60, 8, 8);
                                CTX.endFrame();
                                return PIXELS();
                            };
                            const ORDERED_SILHOUETTE_REFERENCE = RENDER_ORDERED_SILHOUETTE(false),
                                ORDERED_SILHOUETTE_BATCH = RENDER_ORDERED_SILHOUETTE(true);
                            CHECK(
                                ORDERED_SILHOUETTE_BATCH.every((value, i) => value === ORDERED_SILHOUETTE_REFERENCE[i]),
                                'batched silhouette preserves painter order against surrounding vector draws',
                            );
                            const RENDER_TRANSFORMED_SILHOUETTE = (batched) => {
                                BEGIN();
                                CTX.save();
                                CTX.translate(62, 61);
                                CTX.rotate(Math.PI / 7);
                                CTX.globalAlpha = 0.5;
                                const TRANSFORM = [0.9, 0, 0, 1.1, 2, -1];
                                if (batched) {
                                    CTX.drawMeshSilhouette(PACKED_MESH, {
                                        transform: TRANSFORM,
                                        parts: SILHOUETTE_PARTS,
                                        morph: GLOBAL_MORPH,
                                        color: '#ffe000',
                                        width: 3,
                                        radius: 40,
                                    });
                                } else {
                                    CTX.withSilhouette(
                                        '#ffe000',
                                        3,
                                        () =>
                                            CTX.drawMesh(PACKED_MESH, {
                                                transform: TRANSFORM,
                                                parts: SILHOUETTE_PARTS,
                                                morph: GLOBAL_MORPH,
                                            }),
                                        40,
                                    );
                                }
                                CTX.restore();
                                CTX.endFrame();
                                return PIXELS();
                            };
                            const TRANSFORMED_SILHOUETTE_REFERENCE = RENDER_TRANSFORMED_SILHOUETTE(false),
                                TRANSFORMED_SILHOUETTE_BATCH = RENDER_TRANSFORMED_SILHOUETTE(true);
                            CHECK(
                                TRANSFORMED_SILHOUETTE_BATCH.every(
                                    (value, i) => value === TRANSFORMED_SILHOUETTE_REFERENCE[i],
                                ),
                                'batched silhouette preserves local/context transforms and outer group alpha',
                            );
                            const RENDER_FORCED_FLASH_SILHOUETTE = (batched) => {
                                BEGIN();
                                CTX.save();
                                CTX.translate(64, 64);
                                CTX.filter = 'brightness(0) invert(1)';
                                CTX.withColor([0.2, 0.8, 0.3, 0.35], () => {
                                    if (batched) {
                                        CTX.drawMeshSilhouette(PACKED_MESH, {
                                            parts: SILHOUETTE_PARTS,
                                            morph: GLOBAL_MORPH,
                                            color: '#ffe000',
                                            width: 3,
                                            radius: 40,
                                        });
                                    } else {
                                        CTX.withSilhouette(
                                            '#ffe000',
                                            3,
                                            () =>
                                                CTX.drawMesh(PACKED_MESH, {
                                                    parts: SILHOUETTE_PARTS,
                                                    morph: GLOBAL_MORPH,
                                                }),
                                            40,
                                        );
                                    }
                                });
                                CTX.restore();
                                CTX.endFrame();
                                return PIXELS();
                            };
                            const FORCED_FLASH_REFERENCE = RENDER_FORCED_FLASH_SILHOUETTE(false),
                                FORCED_FLASH_BATCH = RENDER_FORCED_FLASH_SILHOUETTE(true);
                            CHECK(
                                FORCED_FLASH_BATCH.every((value, i) => value === FORCED_FLASH_REFERENCE[i]),
                                'batched silhouette preserves outer forceColor and white-flash alpha',
                            );
                            const BEFORE_RESTORE = CLIPPED_SCENE(true),
                                LOSS = GL.getExtension('WEBGL_lose_context');
                            const COMBINED_BEFORE_RESTORE = PAINT_PACKED_SCENE(true, SILHOUETTE_DRAWS, true).bytes;
                            CHECK(LOSS, 'real context-loss extension available');
                            const LOST = new Promise((resolve) =>
                                CANVAS.addEventListener('webglcontextlost', resolve, {
                                    once: true,
                                }),
                            );
                            LOSS.loseContext();
                            await LOST;
                            CHECK(CTX.beginFrame() === false, 'lost scene skips frame');
                            await new Promise((resolve) => setTimeout(resolve, 80));
                            const RESTORED = new Promise((resolve) =>
                                CANVAS.addEventListener('webglcontextrestored', resolve, {
                                    once: true,
                                }),
                            );
                            LOSS.restoreContext();
                            await RESTORED;
                            CHECK(DEVICE.state === 'ready' && CTX.state === 'ready', 'scene/device restored');
                            const AFTER_RESTORE = CLIPPED_SCENE(true);
                            CHECK(
                                BEFORE_RESTORE.every((v, i) => v === AFTER_RESTORE[i]),
                                'same retained handle restores identical scene pixels',
                            );
                            const COMBINED_AFTER_RESTORE = PAINT_PACKED_SCENE(true, SILHOUETTE_DRAWS, true).bytes;
                            CHECK(
                                COMBINED_BEFORE_RESTORE.every((v, i) => v === COMBINED_AFTER_RESTORE[i]),
                                'same combined mesh handle restores identical animated silhouette pixels',
                            );
                            const SCALED_AFTER_RESTORE = PAINT_SCALED_SILHOUETTE().bytes;
                            CHECK(
                                SCALED_SILHOUETTE.bytes.every((v, i) => v === SCALED_AFTER_RESTORE[i]),
                                'scaled silhouette reuses the same retained pose after context restoration',
                            );
                            CHECK(GL.getError() === GL.NO_ERROR, 'actual WebGL path has no GL errors');
                            BEGIN();
                            CTX.drawMesh(MESH, {
                                transform: [1, 0, 0, 1, 24, 24],
                            });
                            CHECK(
                                CTX.deleteMesh(MESH) && !CTX.deleteMesh(MESH),
                                'deletion flushes queued drawing and is idempotent',
                            );
                            CHECK(CTX.deleteMesh(PACKED_MESH), 'combined geometry is explicitly released');
                            CTX.endFrame();
                            NEAR(PIXEL(24, 24), [128, 0, 0, 255], 'queued last use remains visible after deletion');
                            CHECK(
                                CTX.stats().mesh.meshCount === 0 && CTX.stats().mesh.retainedBytes === 0,
                                'deleted geometry leaves no retained allocation',
                            );
                            CTX.dispose();
                            CTX.dispose();
                            CHECK(
                                DEVICE.state === 'ready' &&
                                    DEVICE.stats.bufferCount === 0 &&
                                    DEVICE.stats.pipelineCount === 0 &&
                                    DEVICE.stats.textureCount === 0 &&
                                    DEVICE.stats.renderTargetCount === 0,
                                'scene disposal releases its resources without disposing caller device',
                            );
                            return {
                                backend: withoutANGLE ? 'uniform-retained-mesh' : 'ANGLE-instanced-mesh',
                                antialias,
                                samples: SAMPLES_LOCAL,
                                cold: COLD.mesh,
                                coldUploadedBytes: COLD.uploadedBytes,
                                warm: WARM.mesh,
                                warmUploadedBytes: WARM.uploadedBytes,
                                clipDifference,
                                maxClipDifference,
                                clipInteriorDifference,
                                clipExteriorDifference,
                                maxClipEdgeDifference,
                                directClip: {
                                    interiorDifference: directInteriorDifference,
                                    exteriorDifference: directExteriorDifference,
                                    edgeDifference: directEdgeDifference,
                                    maxEdgeDifference: directMaxEdgeDifference,
                                },
                                packedParts: {
                                    partCount: PACKED_DATA.partCount,
                                    coldGeometryBytes: PACKED_COLD.mesh.geometryBytesUploaded,
                                    mutationDraws: MUTATION_STATS.mesh.draws,
                                    mutationParity: MUTATION_PARITY,
                                    silhouetteDraws: SILHOUETTE_PACKED.stats.mesh.draws,
                                    silhouetteInstances: SILHOUETTE_PACKED.stats.mesh.instances,
                                    silhouetteUploadedBytes: SILHOUETTE_PACKED.stats.uploadedBytes,
                                    silhouetteGeometryUploads: SILHOUETTE_PACKED.stats.mesh.geometryUploads,
                                    silhouetteParity: SILHOUETTE_PARITY,
                                    batchedSilhouette: {
                                        draws: BATCHED_SILHOUETTE_STATS.mesh.draws,
                                        instances: BATCHED_SILHOUETTE_STATS.mesh.instances,
                                        uploadedBytes: BATCHED_SILHOUETTE_STATS.uploadedBytes,
                                        parity: BATCHED_SILHOUETTE_PARITY,
                                        transformedAlphaParity: true,
                                        forcedFlashParity: true,
                                    },
                                    sameHandleRestoration: true,
                                    maxVertexAttributes: GL.getParameter(GL.MAX_VERTEX_ATTRIBS),
                                    maxVertexUniformVectors: GL.getParameter(GL.MAX_VERTEX_UNIFORM_VECTORS),
                                },
                                transformsAndTwoMorphs: true,
                                silhouette: true,
                                whiteFlashAlpha: true,
                                painterOrder: true,
                                nestedOpacityRotatedClip: true,
                                sameHandleRestoration: true,
                                deletionAndDisposal: true,
                            };
                        } finally {
                            CTX.dispose();
                            DEVICE.dispose();
                            CANVAS.remove();
                        }
                    },
                    {
                        withoutANGLE: WITHOUT_ANGLE,
                        antialias: ANTIALIAS,
                    },
                ),
            );
        }
    }
    assert.equal(RESULTS.length, 4);
    return {
        scenes: RESULTS,
        scope: 'Actual Chromium WebGL1 pixels, retained geometry and instance-upload counters; forced extension absence uses the same native GL context, not fake GL. Not a mobile performance benchmark.',
    };
}

/** Exercises alpha-aware depth writes on retained, indexed and expanded WebGL1 meshes. */
export async function exerciseMeshAlphaDepthWrite(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
        const { WebGLDevice: WEB_GL_DEVICE, MeshRenderer: MESH_RENDERER } = await import(url);
        const CHECK = (condition, message) => {
            if (!condition) {
                throw new Error(message);
            }
        };
        const NEAR = (actual, expected, message, tolerance = 2) =>
            CHECK(
                actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance),
                message + ': ' + actual,
            );
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            depth: true,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const MESHES = new MESH_RENDERER(DEVICE, {
            maxMeshes: 2,
            maxInstances: 512,
        });
        const PROJECTION = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
        const GL = DEVICE.gl;
        const READ = () => {
            const PIXEL = new Uint8Array(4);
            GL.readPixels(32, 64 - 32, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, PIXEL);
            return [...PIXEL];
        };
        const COLORS = [
            [1, 0, 0, 1],
            [0, 1, 0, 0.5],
            [0, 0, 1, 1],
        ];
        const POINTS = [
            [8, 8],
            [56, 8],
            [32, 56],
        ];
        const VERTICES = new Float32Array(9 * 11);
        for (let triangle = 0; triangle < 3; triangle++) {
            for (let corner = 0; corner < 3; corner++) {
                const AT = (triangle * 3 + corner) * 11,
                    POINT = POINTS[corner],
                    COLOR = COLORS[triangle];
                VERTICES.set(
                    [POINT[0], POINT[1], COLOR[0], COLOR[1], COLOR[2], COLOR[3], 0, 0, 0, 0, triangle === 2 ? 1 : 0],
                    AT,
                );
            }
        }
        const MESH = MESHES.createMesh({
            vertices: VERTICES,
            strideFloats: 11,
            partCount: 2,
            morphCount: 0,
            expressionIndices: {
                red: new Uint16Array([0, 1, 2]),
                green: new Uint16Array([3, 4, 5]),
                blue: new Uint16Array([6, 7, 8]),
            },
        });
        const FRAME = (paint) => {
            CHECK(
                DEVICE.beginFrame({
                    width: 64,
                    height: 64,
                    clearColor: [0, 0, 0, 1],
                    clearDepth: 1,
                }),
                'frame begins',
            );
            MESHES.beginFrame();
            paint();
            MESHES.flush();
            GL.finish();
            const REPORT = {
                pixel: READ(),
                draws: MESHES.stats().draws,
                instances: MESHES.stats().instances,
                instanceBytesUploaded: MESHES.stats().instanceBytesUploaded,
                deviceDrawCalls: DEVICE.stats.drawCalls,
                glError: GL.getError(),
            };
            DEVICE.endFrame();
            return REPORT;
        };
        const OPAQUE_OPTIONS = {
            projection: PROJECTION,
            depthTest: true,
            depthWrite: true,
            depthWriteAlphaThreshold: 0.999,
        };
        try {
            const ORDERED_RUNS = FRAME(() => MESHES.drawMesh(MESH, OPAQUE_OPTIONS));
            CHECK(
                ORDERED_RUNS.draws === 3,
                'mixed opacity becomes three adjacent original-order runs: ' + JSON.stringify(ORDERED_RUNS),
            );
            CHECK(
                ORDERED_RUNS.pixel[0] <= 2 && ORDERED_RUNS.pixel[1] <= 2 && ORDERED_RUNS.pixel[2] >= 253,
                'translucent green remains between the two opaque source triangles; opaque-first sorting would change this pixel: ' +
                    JSON.stringify(ORDERED_RUNS),
            );
            const EXPRESSION_ALPHA = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'green',
                    depth: -0.4,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: 0.4,
                });
            });
            CHECK(
                EXPRESSION_ALPHA.pixel[0] >= 253 && EXPRESSION_ALPHA.pixel[1] <= 2 && EXPRESSION_ALPHA.pixel[2] <= 2,
                'selected transparent expression indices do not write depth: ' + JSON.stringify(EXPRESSION_ALPHA),
            );
            const PART_OPACITY = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: -0.4,
                    parts: [
                        {
                            opacity: 0.5,
                        },
                        {
                            opacity: 1,
                        },
                    ],
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'blue',
                    depth: 0.4,
                });
            });
            CHECK(
                PART_OPACITY.pixel[2] >= 253 && PART_OPACITY.pixel[0] <= 2,
                'part opacity is part of effective alpha: ' + JSON.stringify(PART_OPACITY),
            );
            const INSTANCE_OPACITY = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: -0.4,
                    alpha: 0.5,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'blue',
                    depth: 0.4,
                });
            });
            CHECK(
                INSTANCE_OPACITY.pixel[2] >= 253 && INSTANCE_OPACITY.pixel[0] <= 2,
                'instance alpha is part of effective alpha: ' + JSON.stringify(INSTANCE_OPACITY),
            );
            const COLOR_OPACITY = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: -0.4,
                    color: [1, 1, 1, 0.5],
                    forceColor: true,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'blue',
                    depth: 0.4,
                });
            });
            CHECK(
                COLOR_OPACITY.pixel[2] >= 253 && COLOR_OPACITY.pixel[0] <= 2,
                'instance color alpha is part of effective alpha: ' + JSON.stringify(COLOR_OPACITY),
            );
            const FORCE_COLOR = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'green',
                    depth: -0.4,
                    color: [1, 0, 0, 1],
                    forceColor: true,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'blue',
                    depth: 0.4,
                });
            });
            CHECK(
                FORCE_COLOR.pixel[0] >= 253 && FORCE_COLOR.pixel[1] <= 2 && FORCE_COLOR.pixel[2] <= 2,
                'forceColor replaces authored vertex alpha before classification: ' + JSON.stringify(FORCE_COLOR),
            );
            const THRESHOLD_BOUNDARY = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'green',
                    depth: -0.4,
                    depthWriteAlphaThreshold: 0.5,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: 0.4,
                });
            });
            NEAR(THRESHOLD_BOUNDARY.pixel, [0, 128, 0, 255], 'alpha exactly at threshold writes depth');
            const LEGACY_WHOLE_MESH = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    indexVariant: 'green',
                    depth: -0.4,
                    depthTest: true,
                    depthWrite: true,
                });
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    indexVariant: 'blue',
                    depth: 0.4,
                    depthTest: true,
                    depthWrite: false,
                });
            });
            NEAR(
                LEGACY_WHOLE_MESH.pixel,
                [0, 128, 0, 255],
                'omitted threshold preserves the legacy mesh-wide depthWrite behavior',
            );
            const LEGACY_NO_WRITE = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    indexVariant: 'green',
                    depth: -0.4,
                    depthTest: true,
                    depthWrite: false,
                });
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    indexVariant: 'blue',
                    depth: 0.4,
                    depthTest: true,
                    depthWrite: false,
                });
            });
            CHECK(
                LEGACY_NO_WRITE.pixel[2] >= 253 && LEGACY_NO_WRITE.pixel[1] <= 2,
                'legacy depthWrite:false preserves painter-order visibility: ' + JSON.stringify(LEGACY_NO_WRITE),
            );
            let invalidThresholdRejected = false;
            CHECK(
                DEVICE.beginFrame({
                    width: 64,
                    height: 64,
                }),
                'invalid-input frame begins',
            );
            MESHES.beginFrame();
            try {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    depthWriteAlphaThreshold: 1.01,
                });
            } catch (error) {
                invalidThresholdRejected = error instanceof RangeError;
            }
            DEVICE.endFrame();
            CHECK(invalidThresholdRejected, 'threshold outside [0,1] is rejected');
            const LOSS = GL.getExtension('WEBGL_lose_context');
            CHECK(LOSS, 'real context-loss extension available');
            const LOST = new Promise((resolve) =>
                CANVAS.addEventListener(
                    'webglcontextlost',
                    (event) => {
                        event.preventDefault();
                        resolve();
                    },
                    {
                        once: true,
                    },
                ),
            );
            LOSS.loseContext();
            await LOST;
            CHECK(
                DEVICE.beginFrame({
                    width: 64,
                    height: 64,
                }) === false,
                'lost context skips a frame',
            );
            await new Promise((resolve) => setTimeout(resolve, 80));
            const RESTORED = new Promise((resolve) =>
                CANVAS.addEventListener('webglcontextrestored', resolve, {
                    once: true,
                }),
            );
            LOSS.restoreContext();
            await RESTORED;
            CHECK(DEVICE.state === 'ready' && MESHES.state === 'ready', 'device and alpha-aware mesh restore');
            const AFTER_RESTORE = FRAME(() => {
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'green',
                    depth: -0.4,
                });
                MESHES.drawMesh(MESH, {
                    ...OPAQUE_OPTIONS,
                    indexVariant: 'red',
                    depth: 0.4,
                });
            });
            CHECK(
                AFTER_RESTORE.pixel[0] >= 253 && AFTER_RESTORE.pixel[1] <= 2 && AFTER_RESTORE.pixel[2] <= 2,
                'restored expression index buffer is classified and drawn: ' + JSON.stringify(AFTER_RESTORE),
            );
            MESHES.dispose();
            const DISPOSED = MESHES.stats();
            CHECK(
                DISPOSED.meshCount === 0 &&
                    DISPOSED.retainedBytes === 0 &&
                    DISPOSED.pipelineCount === 0 &&
                    DEVICE.stats.bufferCount === 0 &&
                    DEVICE.stats.pipelineCount === 0,
                'dispose releases retained mesh, expression index, instance buffer, and pipeline resources',
            );
            return {
                orderedRuns: ORDERED_RUNS,
                expressionAlpha: EXPRESSION_ALPHA,
                partOpacity: PART_OPACITY,
                instanceOpacity: INSTANCE_OPACITY,
                colorOpacity: COLOR_OPACITY,
                forceColor: FORCE_COLOR,
                thresholdBoundary: THRESHOLD_BOUNDARY,
                legacyWholeMesh: LEGACY_WHOLE_MESH,
                legacyNoWrite: LEGACY_NO_WRITE,
                afterRestore: AFTER_RESTORE,
                invalidThresholdRejected,
                disposed: true,
            };
        } finally {
            MESHES.dispose();
            DEVICE.dispose();
            CANVAS.remove();
        }
    }, moduleURL);
}

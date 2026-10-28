/** Exercises WebGL depth per mesh instance/part and the following vector stream pass. */
export async function exerciseMeshDepth(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
        const {
            VectorContext: VECTOR_CONTEXT,
            WebGLDevice: WEB_GL_DEVICE,
            MeshBuilder: MESH_BUILDER,
        } = await import(url);
        const CHECK = (condition, message) => {
            if (!condition) {
                throw new Error(message);
            }
        };
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const CONTEXT = new VECTOR_CONTEXT(DEVICE),
            MESHES = CONTEXT.acquireMeshRenderer();
        const BUILDER = new MESH_BUILDER();
        BUILDER.fillTriangleFan(
            [
                [8, 8],
                [56, 8],
                [32, 56],
            ],
            [1, 1, 1, 1],
        );
        const GEOMETRY = BUILDER.build();
        const MESH = MESHES.createMesh(GEOMETRY);
        const RED_BUILDER = new MESH_BUILDER();
        RED_BUILDER.fillTriangleFan(
            [
                [8, 8],
                [56, 8],
                [32, 56],
            ],
            [1, 0, 0, 1],
        );
        const BLUE_BUILDER = new MESH_BUILDER();
        BLUE_BUILDER.fillTriangleFan(
            [
                [8, 8],
                [56, 8],
                [32, 56],
            ],
            [0, 0, 1, 1],
        );
        const PARTS = MESHES.createMesh(MESH_BUILDER.combine([RED_BUILDER.build(), BLUE_BUILDER.build()]));
        const PROJECTION = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
        const GL = DEVICE.gl;
        const READ = () => {
            const PIXEL = new Uint8Array(4);
            GL.readPixels(32, 64 - 32, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, PIXEL);
            return [...PIXEL];
        };
        try {
            CONTEXT.beginFrame({
                width: 64,
                height: 64,
                clearColor: [0, 0, 0, 1],
            });
            MESHES.drawMesh(MESH, {
                projection: PROJECTION,
                color: [1, 0, 0, 1],
                forceColor: true,
                depth: -0.4,
                depthTest: true,
                depthWrite: true,
            });
            MESHES.drawMesh(MESH, {
                projection: PROJECTION,
                color: [0, 1, 0, 0.5],
                forceColor: true,
                depth: -0.4,
                depthTest: true,
                depthWrite: false,
            });
            MESHES.drawMesh(MESH, {
                projection: PROJECTION,
                color: [0, 0, 1, 1],
                forceColor: true,
                depth: 0.4,
                depthTest: true,
                depthWrite: false,
            });
            MESHES.flush();
            GL.finish();
            const TRANSPARENT_DEPTH_PIXEL = READ();
            const DEPTH_STATE_AFTER_MESHES = {
                enabled: GL.isEnabled(GL.DEPTH_TEST),
                write: GL.getParameter(GL.DEPTH_WRITEMASK),
            };
            CONTEXT.fillStyle = [1, 1, 0, 1];
            CONTEXT.beginPath();
            CONTEXT.moveTo(8, 8);
            CONTEXT.lineTo(56, 8);
            CONTEXT.lineTo(32, 56);
            CONTEXT.closePath();
            CONTEXT.fill();
            CONTEXT.flush();
            GL.finish();
            const INTERLEAVED_PIXEL = READ();
            const DEPTH_STATE_AFTER_VECTOR = {
                enabled: GL.isEnabled(GL.DEPTH_TEST),
                write: GL.getParameter(GL.DEPTH_WRITEMASK),
            };
            CONTEXT.endFrame();
            DEVICE.beginFrame({
                width: 64,
                height: 64,
                clearColor: [0, 0, 0, 1],
                clearDepth: 1,
            });
            MESHES.beginFrame();
            MESHES.drawMesh(PARTS, {
                projection: PROJECTION,
                parts: [
                    {
                        depth: -0.6,
                    },
                    {
                        depth: 0.6,
                    },
                ],
                depthTest: true,
                depthWrite: true,
            });
            MESHES.flush();
            GL.finish();
            const PART_DEPTH_PIXEL = READ();
            DEVICE.endFrame();
            const REPORT = {
                transparentDepthPixel: TRANSPARENT_DEPTH_PIXEL,
                depthStateAfterMeshes: DEPTH_STATE_AFTER_MESHES,
                interleavedPixel: INTERLEAVED_PIXEL,
                depthStateAfterVector: DEPTH_STATE_AFTER_VECTOR,
                partDepthPixel: PART_DEPTH_PIXEL,
                draws: MESHES.stats().draws,
                instances: MESHES.stats().instances,
                glError: GL.getError(),
            };
            CHECK(
                TRANSPARENT_DEPTH_PIXEL[0] >= 126 &&
                    TRANSPARENT_DEPTH_PIXEL[0] <= 130 &&
                    TRANSPARENT_DEPTH_PIXEL[1] >= 125 &&
                    TRANSPARENT_DEPTH_PIXEL[1] <= 129 &&
                    TRANSPARENT_DEPTH_PIXEL[2] <= 2,
                'equal-depth transparent paint keeps painter order and a farther fragment is rejected: ' +
                    JSON.stringify(REPORT),
            );
            CHECK(
                DEPTH_STATE_AFTER_MESHES.enabled && DEPTH_STATE_AFTER_MESHES.write === false,
                'mesh depth policy is explicit at the end of its pass',
            );
            CHECK(
                INTERLEAVED_PIXEL[0] >= 253 && INTERLEAVED_PIXEL[1] >= 253 && INTERLEAVED_PIXEL[2] <= 2,
                'vector pass paints above a depth-tested mesh on the same default framebuffer: ' +
                    JSON.stringify(REPORT),
            );
            CHECK(
                !DEPTH_STATE_AFTER_VECTOR.enabled && DEPTH_STATE_AFTER_VECTOR.write === false,
                'vector flush resets depth test and write state',
            );
            CHECK(
                PART_DEPTH_PIXEL[0] >= 253 && PART_DEPTH_PIXEL[2] <= 2,
                'per-part depth reaches the shader: ' + JSON.stringify(REPORT),
            );
            CHECK(
                MESHES.stats().draws === 1 && MESHES.stats().instances === 1 && REPORT.glError === 0,
                'part-depth fixture draws once without WebGL errors: ' + JSON.stringify(REPORT),
            );
            let rejectsDepthOutsideClip = false;
            try {
                DEVICE.beginFrame({
                    width: 64,
                    height: 64,
                });
                MESHES.beginFrame();
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    depth: 1.01,
                });
            } catch (error) {
                rejectsDepthOutsideClip = error instanceof RangeError;
            } finally {
                if (DEVICE.active) {
                    DEVICE.endFrame();
                }
            }
            CHECK(rejectsDepthOutsideClip, 'depth outside the clip-space interval is rejected');
            return REPORT;
        } finally {
            CONTEXT.dispose();
            DEVICE.dispose();
            CANVAS.remove();
        }
    }, moduleURL);
}

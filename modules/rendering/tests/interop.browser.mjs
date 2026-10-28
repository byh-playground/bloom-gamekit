/** Checks ordered VectorContext stream and MeshRenderer submission on one WebGL2 canvas. */
export async function exerciseRendererInterleaving(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
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
}

/** Checks ordered Renderer2D/MeshRenderer submission on one shared WebGL2 canvas. */
export async function exerciseRendererInterleaving(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
        const { Renderer2D: RENDERER2_D, WebGLDevice: WEB_GL_DEVICE, MeshRenderer: MESH_RENDERER } = await import(url);
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        CANVAS.style.cssText = 'width:64px;height:64px';
        document.body.append(CANVAS);
        const RENDERER = new RENDERER2_D(CANVAS, {
            batchVertices: 18,
            antialias: false,
            preserveDrawingBuffer: true,
        });
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: true,
            antialias: false,
            preserveDrawingBuffer: true,
            checkGLErrors: true,
        });
        const MESHES = new MESH_RENDERER(DEVICE, {
            maxMeshes: 2,
            maxInstances: 4,
        });
        const VERTICES = new Float32Array([
            24, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0, 40, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0, 32, 40, 0, 0, 1, 1, 0, 0, 0, 0, 0,
        ]);
        const MESH = MESHES.createMesh({
            vertices: VERTICES,
            strideFloats: 11,
            partCount: 1,
            morphCount: 0,
        });
        const PROJECTION = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
        DEVICE.beginFrame({
            width: 64,
            height: 64,
            clearColor: [0, 0, 0, 1],
        });
        MESHES.beginFrame();
        RENDERER.beginFrame([0, 0, 0, 1]);
        RENDERER.triangle(8, 8, 16, 8, 12, 16, [1, 0, 0, 1]);
        RENDERER.flush();
        MESHES.drawMesh(MESH, {
            projection: PROJECTION,
        });
        MESHES.flush();
        RENDERER.triangle(46, 8, 54, 8, 50, 16, [0, 1, 0, 1]);
        RENDERER.flush();
        RENDERER.endFrame();
        const FRAME = DEVICE.endFrame();
        DEVICE.gl.finish();
        const PIXEL = (x, y) => {
            const OUTPUT = new Uint8Array(4);
            DEVICE.gl.readPixels(x, 63 - y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, OUTPUT);
            return [...OUTPUT];
        };
        const RESULT = {
            red2d: PIXEL(12, 11),
            blueMesh: PIXEL(32, 30),
            green2d: PIXEL(50, 11),
            glError: DEVICE.gl.getError(),
            meshDraws: MESHES.stats().draws,
            rendererDraws: RENDERER.stats.drawCalls,
            deviceDraws: FRAME.drawCalls,
        };
        RENDERER.dispose();
        MESHES.dispose();
        DEVICE.dispose();
        CANVAS.remove();
        return RESULT;
    }, moduleURL);
}

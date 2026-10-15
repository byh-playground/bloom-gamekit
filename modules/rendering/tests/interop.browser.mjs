/** Checks ordered Renderer2D/MeshRenderer submission on one shared WebGL1 canvas. */
export async function exerciseRendererInterleaving(page, moduleURL = '/dist/rendering.js') {
  return page.evaluate(async url => {
    const { Renderer2D, WebGLDevice, MeshRenderer } = await import(url);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    canvas.style.cssText = 'width:64px;height:64px'; document.body.append(canvas);
    const renderer = new Renderer2D(canvas, { batchVertices: 18, antialias: false, preserveDrawingBuffer: true });
    const device = new WebGLDevice(canvas, { alpha: true, antialias: false, preserveDrawingBuffer: true, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 2, maxInstances: 4 });
    const vertices = new Float32Array([
      24, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0,
      40, 24, 0, 0, 1, 1, 0, 0, 0, 0, 0,
      32, 40, 0, 0, 1, 1, 0, 0, 0, 0, 0,
    ]);
    const mesh = meshes.createMesh({ vertices, strideFloats: 11, partCount: 1, morphCount: 0 });
    const projection = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
    device.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1] });
    meshes.beginFrame();
    renderer.beginFrame([0, 0, 0, 1]);
    renderer.triangle(8, 8, 16, 8, 12, 16, [1, 0, 0, 1]);
    renderer.flush();
    meshes.drawMesh(mesh, { projection });
    meshes.flush();
    renderer.triangle(46, 8, 54, 8, 50, 16, [0, 1, 0, 1]);
    renderer.flush();
    renderer.endFrame();
    const frame = device.endFrame();
    device.gl.finish();
    const pixel = (x, y) => {
      const output = new Uint8Array(4);
      device.gl.readPixels(x, 63 - y, 1, 1, device.gl.RGBA, device.gl.UNSIGNED_BYTE, output);
      return [...output];
    };
    const result = { red2d: pixel(12, 11), blueMesh: pixel(32, 30), green2d: pixel(50, 11), glError: device.gl.getError(),
      meshDraws: meshes.stats().draws, rendererDraws: renderer.stats.drawCalls, deviceDraws: frame.drawCalls };
    renderer.dispose(); meshes.dispose(); device.dispose(); canvas.remove();
    return result;
  }, moduleURL);
}

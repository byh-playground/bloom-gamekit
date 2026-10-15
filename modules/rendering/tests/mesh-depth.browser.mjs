/** Exercises WebGL depth per mesh instance/part and the following 2D painter pass. */
export async function exerciseMeshDepth(page, moduleURL = '/dist/rendering.js') {
  return page.evaluate(async url => {
    const { Renderer2D, WebGLDevice, MeshRenderer, MeshBuilder } = await import(url);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const renderer2d = new Renderer2D(canvas, { antialias: false, depth: true, preserveDrawingBuffer: true });
    const device = new WebGLDevice(canvas, { alpha: false, antialias: false, preserveDrawingBuffer: true, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 4, maxInstances: 8 });
    const builder = new MeshBuilder();
    builder.fillTriangleFan([[8, 8], [56, 8], [32, 56]], [1, 1, 1, 1]);
    const geometry = builder.build();
    const mesh = meshes.createMesh(geometry);
    const redBuilder = new MeshBuilder(); redBuilder.fillTriangleFan([[8, 8], [56, 8], [32, 56]], [1, 0, 0, 1]);
    const blueBuilder = new MeshBuilder(); blueBuilder.fillTriangleFan([[8, 8], [56, 8], [32, 56]], [0, 0, 1, 1]);
    const parts = meshes.createMesh(MeshBuilder.combine([redBuilder.build(), blueBuilder.build()]));
    const projection = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
    const gl = device.gl;
    const read = () => { const pixel = new Uint8Array(4); gl.readPixels(32, 64 - 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return [...pixel]; };
    try {
      device.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1], clearDepth: 1 });
      meshes.beginFrame();
      renderer2d.beginFrame([0, 0, 0, 1]);
      meshes.drawMesh(mesh, { projection, color: [1, 0, 0, 1], forceColor: true, depth: -0.4, depthTest: true, depthWrite: true });
      meshes.drawMesh(mesh, { projection, color: [0, 1, 0, 0.5], forceColor: true, depth: -0.4, depthTest: true, depthWrite: false });
      meshes.drawMesh(mesh, { projection, color: [0, 0, 1, 1], forceColor: true, depth: 0.4, depthTest: true, depthWrite: false });
      meshes.flush(); gl.finish();
      const transparentDepthPixel = read();
      const depthStateAfterMeshes = { enabled: gl.isEnabled(gl.DEPTH_TEST), write: gl.getParameter(gl.DEPTH_WRITEMASK) };
      renderer2d.triangle(8, 8, 56, 8, 32, 56, [1, 1, 0, 1]); renderer2d.flush(); gl.finish();
      const interleavedPixel = read();
      const depthStateAfter2D = { enabled: gl.isEnabled(gl.DEPTH_TEST), write: gl.getParameter(gl.DEPTH_WRITEMASK) };
      renderer2d.endFrame(); device.endFrame();

      device.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1], clearDepth: 1 }); meshes.beginFrame();
      meshes.drawMesh(parts, { projection, parts: [{ depth: -0.6 }, { depth: 0.6 }], depthTest: true, depthWrite: true });
      meshes.flush(); gl.finish();
      const partDepthPixel = read(); device.endFrame();
      const report = { transparentDepthPixel, depthStateAfterMeshes, interleavedPixel, depthStateAfter2D,
        partDepthPixel, draws: meshes.stats().draws, instances: meshes.stats().instances, glError: gl.getError() };
      check(transparentDepthPixel[0] >= 126 && transparentDepthPixel[0] <= 130
        && transparentDepthPixel[1] >= 125 && transparentDepthPixel[1] <= 129 && transparentDepthPixel[2] <= 2,
      'equal-depth transparent paint keeps painter order and a farther fragment is rejected: ' + JSON.stringify(report));
      check(depthStateAfterMeshes.enabled && depthStateAfterMeshes.write === false, 'mesh depth policy is explicit at the end of its pass');
      check(interleavedPixel[0] >= 253 && interleavedPixel[1] >= 253 && interleavedPixel[2] <= 2,
        '2D pass paints above a depth-tested mesh on the same default framebuffer: ' + JSON.stringify(report));
      check(!depthStateAfter2D.enabled && depthStateAfter2D.write === false, '2D flush resets depth test and write state');
      check(partDepthPixel[0] >= 253 && partDepthPixel[2] <= 2, 'per-part depth reaches the shader: ' + JSON.stringify(report));
      check(meshes.stats().draws === 1 && meshes.stats().instances === 1 && report.glError === 0,
        'part-depth fixture draws once without WebGL errors: ' + JSON.stringify(report));
      let rejectsDepthOutsideClip = false;
      try { device.beginFrame({ width: 64, height: 64 }); meshes.beginFrame(); meshes.drawMesh(mesh, { projection, depth: 1.01 }); }
      catch (error) { rejectsDepthOutsideClip = error instanceof RangeError; }
      finally { if (device.active) device.endFrame(); }
      check(rejectsDepthOutsideClip, 'depth outside the clip-space interval is rejected');
      return report;
    } finally {
      meshes.dispose(); renderer2d.dispose(); device.dispose(); canvas.remove();
    }
  }, moduleURL);
}

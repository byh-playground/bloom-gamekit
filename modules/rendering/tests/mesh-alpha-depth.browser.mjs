/** Exercises alpha-aware depth writes on retained, indexed and expanded WebGL1 meshes. */
export async function exerciseMeshAlphaDepthWrite(page, moduleURL = '/dist/rendering.js') {
  return page.evaluate(async url => {
    const { WebGLDevice, MeshRenderer } = await import(url);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const near = (actual, expected, message, tolerance = 2) =>
      check(actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance), message + ': ' + actual);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const device = new WebGLDevice(canvas, { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 2, maxInstances: 512 });
    const projection = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
    const gl = device.gl;
    const read = () => { const pixel = new Uint8Array(4); gl.readPixels(32, 64 - 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return [...pixel]; };
    const colors = [[1, 0, 0, 1], [0, 1, 0, 0.5], [0, 0, 1, 1]];
    const points = [[8, 8], [56, 8], [32, 56]];
    const vertices = new Float32Array(9 * 11);
    for (let triangle = 0; triangle < 3; triangle++) {
      for (let corner = 0; corner < 3; corner++) {
        const at = (triangle * 3 + corner) * 11, point = points[corner], color = colors[triangle];
        vertices.set([point[0], point[1], color[0], color[1], color[2], color[3], 0, 0, 0, 0, triangle === 2 ? 1 : 0], at);
      }
    }
    const mesh = meshes.createMesh({ vertices, strideFloats: 11, partCount: 2, morphCount: 0,
      expressionIndices: {
        red: new Uint16Array([0, 1, 2]),
        green: new Uint16Array([3, 4, 5]),
        blue: new Uint16Array([6, 7, 8]),
      },
    });
    const frame = paint => {
      check(device.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1], clearDepth: 1 }), 'frame begins');
      meshes.beginFrame(); paint(); meshes.flush(); gl.finish();
      const report = { pixel: read(), draws: meshes.stats().draws, instances: meshes.stats().instances,
        instanceBytesUploaded: meshes.stats().instanceBytesUploaded, deviceDrawCalls: device.stats.drawCalls, glError: gl.getError() };
      device.endFrame();
      return report;
    };
    const opaqueOptions = { projection, depthTest: true, depthWrite: true, depthWriteAlphaThreshold: 0.999 };
    try {
      const orderedRuns = frame(() => meshes.drawMesh(mesh, opaqueOptions));
      check(orderedRuns.draws === 3, 'mixed opacity becomes three adjacent original-order runs: ' + JSON.stringify(orderedRuns));
      check(orderedRuns.pixel[0] <= 2 && orderedRuns.pixel[1] <= 2 && orderedRuns.pixel[2] >= 253,
        'translucent green remains between the two opaque source triangles; opaque-first sorting would change this pixel: ' + JSON.stringify(orderedRuns));

      const expressionAlpha = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'green', depth: -0.4 });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: 0.4 });
      });
      check(expressionAlpha.pixel[0] >= 253 && expressionAlpha.pixel[1] <= 2 && expressionAlpha.pixel[2] <= 2,
        'selected transparent expression indices do not write depth: ' + JSON.stringify(expressionAlpha));

      const partOpacity = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: -0.4, parts: [{ opacity: 0.5 }, { opacity: 1 }] });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'blue', depth: 0.4 });
      });
      check(partOpacity.pixel[2] >= 253 && partOpacity.pixel[0] <= 2,
        'part opacity is part of effective alpha: ' + JSON.stringify(partOpacity));

      const instanceOpacity = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: -0.4, alpha: 0.5 });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'blue', depth: 0.4 });
      });
      check(instanceOpacity.pixel[2] >= 253 && instanceOpacity.pixel[0] <= 2,
        'instance alpha is part of effective alpha: ' + JSON.stringify(instanceOpacity));

      const colorOpacity = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: -0.4, color: [1, 1, 1, 0.5], forceColor: true });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'blue', depth: 0.4 });
      });
      check(colorOpacity.pixel[2] >= 253 && colorOpacity.pixel[0] <= 2,
        'instance color alpha is part of effective alpha: ' + JSON.stringify(colorOpacity));

      const forceColor = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'green', depth: -0.4, color: [1, 0, 0, 1], forceColor: true });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'blue', depth: 0.4 });
      });
      check(forceColor.pixel[0] >= 253 && forceColor.pixel[1] <= 2 && forceColor.pixel[2] <= 2,
        'forceColor replaces authored vertex alpha before classification: ' + JSON.stringify(forceColor));

      const thresholdBoundary = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'green', depth: -0.4, depthWriteAlphaThreshold: 0.5 });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: 0.4 });
      });
      near(thresholdBoundary.pixel, [0, 128, 0, 255], 'alpha exactly at threshold writes depth');

      const legacyWholeMesh = frame(() => {
        meshes.drawMesh(mesh, { projection, indexVariant: 'green', depth: -0.4, depthTest: true, depthWrite: true });
        meshes.drawMesh(mesh, { projection, indexVariant: 'blue', depth: 0.4, depthTest: true, depthWrite: false });
      });
      near(legacyWholeMesh.pixel, [0, 128, 0, 255], 'omitted threshold preserves the legacy mesh-wide depthWrite behavior');

      const legacyNoWrite = frame(() => {
        meshes.drawMesh(mesh, { projection, indexVariant: 'green', depth: -0.4, depthTest: true, depthWrite: false });
        meshes.drawMesh(mesh, { projection, indexVariant: 'blue', depth: 0.4, depthTest: true, depthWrite: false });
      });
      check(legacyNoWrite.pixel[2] >= 253 && legacyNoWrite.pixel[1] <= 2,
        'legacy depthWrite:false preserves painter-order visibility: ' + JSON.stringify(legacyNoWrite));

      let invalidThresholdRejected = false;
      check(device.beginFrame({ width: 64, height: 64 }), 'invalid-input frame begins');
      meshes.beginFrame();
      try { meshes.drawMesh(mesh, { ...opaqueOptions, depthWriteAlphaThreshold: 1.01 }); }
      catch (error) { invalidThresholdRejected = error instanceof RangeError; }
      device.endFrame();
      check(invalidThresholdRejected, 'threshold outside [0,1] is rejected');

      const loss = gl.getExtension('WEBGL_lose_context');
      check(loss, 'real context-loss extension available');
      const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); resolve(); }, { once: true }));
      loss.loseContext(); await lost;
      check(device.beginFrame({ width: 64, height: 64 }) === false, 'lost context skips a frame');
      await new Promise(resolve => setTimeout(resolve, 80));
      const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      loss.restoreContext(); await restored;
      check(device.state === 'ready' && meshes.state === 'ready', 'device and alpha-aware mesh restore');
      const afterRestore = frame(() => {
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'green', depth: -0.4 });
        meshes.drawMesh(mesh, { ...opaqueOptions, indexVariant: 'red', depth: 0.4 });
      });
      check(afterRestore.pixel[0] >= 253 && afterRestore.pixel[1] <= 2 && afterRestore.pixel[2] <= 2,
        'restored expression index buffer is classified and drawn: ' + JSON.stringify(afterRestore));

      meshes.dispose();
      const disposed = meshes.stats();
      check(disposed.meshCount === 0 && disposed.retainedBytes === 0 && disposed.pipelineCount === 0
        && device.stats.bufferCount === 0 && device.stats.pipelineCount === 0,
      'dispose releases retained mesh, expression index, instance buffer, and pipeline resources');
      return { orderedRuns, expressionAlpha, partOpacity, instanceOpacity, colorOpacity, forceColor,
        thresholdBoundary, legacyWholeMesh, legacyNoWrite, afterRestore, invalidThresholdRejected,
        disposed: true };
    } finally { meshes.dispose(); device.dispose(); canvas.remove(); }
  }, moduleURL);
}

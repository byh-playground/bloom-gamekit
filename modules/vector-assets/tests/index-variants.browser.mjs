export async function exercisePr15IndexVariants(page, moduleURL, input) {
  return page.evaluate(async ({ url, input }) => {
    const { WebGLDevice, MeshRenderer } = await import(url);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 200;
    canvas.style.width = canvas.style.height = '200px';
    document.body.append(canvas);
    const device = new WebGLDevice(canvas, { alpha: false, antialias: false, preserveDrawingBuffer: true, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 2, maxInstances: 8 });
    const map = values => Object.fromEntries(Object.entries(values).map(([name, indices]) => [name, Uint16Array.from(indices)]));
    const mesh = meshes.createMesh({
      vertices: Float32Array.from(input.vertices), indices: Uint16Array.from(input.indices),
      expressionIndices: map(input.expressionIndices), indexVariants: map(input.indexVariants),
      strideFloats: 11, partCount: input.partCount, morphCount: 0,
    });
    const expectedBytes = mesh.vertices.byteLength + mesh.indices.byteLength
      + [...mesh.expressionIndices.values(), ...mesh.indexVariants.values()].reduce((sum, variant) => sum + variant.indices.byteLength, 0);
    if (mesh.byteLength !== expectedBytes || !mesh.indexVariants.has('paint_0') || mesh.expressionIndices.has('paint_0')
        || !mesh.expressionIndices.has('neutral')) throw new Error('Named index maps were not retained separately');
    const projection = [2 / 200, 0, 0, 0, -2 / 200, 0, -1, 1, 1];
    const render = draw => {
      if (!device.beginFrame({ width: 200, height: 200, clearColor: [0.06, 0.08, 0.1, 1] })) throw new Error('WebGL frame did not begin');
      meshes.beginFrame();
      draw();
      meshes.flush();
      const pixels = new Uint8Array(200 * 200 * 4);
      device.gl.readPixels(0, 0, 200, 200, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixels);
      const draws = meshes.stats().draws, glError = device.gl.getError();
      device.endFrame();
      return { pixels, draws, glError };
    };
    try {
      const base = render(() => meshes.drawMesh(mesh, { projection }));
      const orderedMeshRanges = render(() => {
        for (const layer of input.paintOrder) if (layer.kind === 'mesh') {
          meshes.drawMesh(mesh, { projection, indexVariant: layer.indexVariant });
        }
      });
      const expression = render(() => meshes.drawMesh(mesh, { projection, indexVariant: 'neutral' }));
      const expressionHappy = render(() => meshes.drawMesh(mesh, { projection, indexVariant: 'happy' }));
      let painterPixelMismatch = 0, expressionPixelDifference = 0;
      for (let index = 0; index < base.pixels.length; index++) {
        if (base.pixels[index] !== orderedMeshRanges.pixels[index]) painterPixelMismatch++;
        if (expression.pixels[index] !== expressionHappy.pixels[index]) expressionPixelDifference++;
      }
      const report = {
        fixture: 'Squish PR15 enemy-boss compiled SVG', viewportCss: [200, 200],
        genericVariantNames: [...mesh.indexVariants.keys()], semanticExpressionNames: [...mesh.expressionIndices.keys()],
        baseDraws: base.draws, painterRangeDraws: orderedMeshRanges.draws, painterPixelMismatch,
        expressionPixelDifference, glErrors: [base.glError, orderedMeshRanges.glError, expression.glError, expressionHappy.glError],
        retainedBytes: mesh.byteLength,
      };
      if (report.painterPixelMismatch !== 0 || report.expressionPixelDifference === 0
          || report.baseDraws !== 1 || report.painterRangeDraws !== 2 || report.glErrors.some(error => error !== 0)) {
        throw new Error('PR15 named index variant pixel check failed: ' + JSON.stringify(report));
      }
      const gpuBytesBeforeDelete = device.stats.gpuBufferBytes;
      if (!meshes.deleteMesh(mesh) || meshes.stats().retainedBytes !== 0 || device.stats.gpuBufferBytes >= gpuBytesBeforeDelete) {
        throw new Error('Named variant buffers were not released with the retained mesh');
      }
      return report;
    } finally {
      meshes.dispose();
      device.dispose();
      canvas.remove();
    }
  }, { url: moduleURL, input });
}

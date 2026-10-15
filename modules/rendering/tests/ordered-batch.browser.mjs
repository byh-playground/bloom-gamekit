/** Compares separate asset draws with a single painter-ordered retained mesh. */
export async function exerciseOrderedAssetBatch(page, moduleURL = '/dist/rendering.js') {
  return page.evaluate(async url => {
    const { WebGLDevice, MeshRenderer, MeshBuilder } = await import(url);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const device = new WebGLDevice(canvas, { alpha: false, antialias: false, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 8, maxInstances: 8 });
    const quad = (color, dx = 0, dy = 0) => {
      const builder = new MeshBuilder();
      builder.fillTriangleFan([[6 + dx, 6 + dy], [26 + dx, 6 + dy], [26 + dx, 26 + dy], [6 + dx, 26 + dy]], color);
      return builder;
    };
    const redData = quad([1, 0, 0, 1]).build();
    const greenData = quad([0, 1, 0, 1]).build({ morphs: [quad([0, 1, 0, 1], 2), quad([0, 1, 0, 1], 0, 2)] });
    const blueData = quad([0, 0, 1, 1]).build({ morphs: [quad([0, 0, 1, 1], 2, 2)] });
    const individual = [redData, greenData, blueData].map(data => meshes.createMesh(data));
    const combinedData = MeshBuilder.combine([MeshBuilder.combine([redData, greenData]), blueData]);
    const combined = meshes.createMesh(combinedData);
    const projection = [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1];
    const clips = [[{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 42 }, { x: 0, y: 42 }]];
    const transforms = [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 10, 10], [1, 0, 0, 1, 10, 10]];
    const morphs = [[0, 0], [0.25, 0.1], [0.1, 0.25]];
    const pixelBytes = () => {
      const pixels = new Uint8Array(64 * 64 * 4);
      device.gl.readPixels(0, 0, 64, 64, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const frame = paint => {
      device.beginFrame({ width: 64, height: 64, clearColor: [0, 0, 0, 1] });
      meshes.beginFrame(); paint(); meshes.flush();
      const deviceStats = device.endFrame(); device.gl.finish();
      return { pixels: pixelBytes(), meshStats: meshes.stats(), deviceStats };
    };
    try {
      const separate = frame(() => {
        for (let index = 0; index < individual.length; index++) meshes.drawMesh(individual[index], {
          projection, matrix: transforms[index], clips, morph: morphs[index], alpha: index === 2 ? 0.5 : 1,
        });
      });
      const orderedParts = transforms.map((transform, index) => ({ transform, morph: morphs[index], opacity: index === 2 ? 0.5 : 1 }));
      const batched = frame(() => meshes.drawMesh(combined, { projection, parts: orderedParts, clips }));
      let rejectsOverflow = false;
      try { MeshBuilder.combine(Array.from({ length: 17 }, () => redData)); } catch (error) { rejectsOverflow = error instanceof TypeError; }
      const readPixel = (pixels, x, y) => {
        const at = ((63 - y) * 64 + x) * 4;
        return [...pixels.subarray(at, at + 4)];
      };
      const pixelMismatch = separate.pixels.reduce((total, value, index) => total + Number(value !== batched.pixels[index]), 0);
      const report = {
        separate: { draws: separate.meshStats.draws, instances: separate.meshStats.instances, instanceBytes: separate.meshStats.instanceBytesUploaded },
        batched: { draws: batched.meshStats.draws, instances: batched.meshStats.instances, instanceBytes: batched.meshStats.instanceBytesUploaded,
          geometryUploads: batched.meshStats.geometryUploads, retainedBytes: batched.meshStats.retainedBytes },
        combined: { parts: combinedData.partCount, morphs: combinedData.morphCount, vertices: combinedData.vertices.length / 11 },
        overlap: readPixel(batched.pixels, 22, 22), clipped: readPixel(batched.pixels, 28, 22), pixelMismatch,
        glError: device.gl.getError(), instancing: meshes.stats().instanced,
      };
      if (report.combined.parts !== 3 || report.separate.draws !== 3 || report.batched.draws !== 1
        || report.overlap[0] > 2 || Math.abs(report.overlap[1] - 128) > 2 || Math.abs(report.overlap[2] - 128) > 2
        || report.clipped.some((value, index) => value !== [0, 0, 0, 255][index])
        || report.combined.morphs !== 2 || !rejectsOverflow || report.pixelMismatch !== 0 || report.glError !== 0) {
        throw new Error('Ordered asset batch mismatch: ' + JSON.stringify(report));
      }
      return report;
    } finally {
      meshes.dispose(); device.dispose(); canvas.remove();
    }
  }, moduleURL);
}

import assert from 'node:assert/strict';

export async function exerciseWorldVectorRendering(browser, renderingURL, vectorAssetsURL, compiled, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 360, height: 280 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#111820;color:#e8edf2;font:14px/1.45 system-ui,sans-serif;padding:18px}
      h1{font-size:16px;margin:0 0 6px}p{margin:0 0 12px;color:#aab7c4}canvas{display:block;background:#071018;border:1px solid #71808a}
    </style><h1>GameKit retained SVG + shader surface / 3D world transforms</h1>
    <p>47 and 74 CSS-pixel actors · SVG order · object-space clipping · depth-tested WebGL</p><canvas width="240" height="180" style="width:240px;height:180px"></canvas>`);
    const result = await page.evaluate(async ({ renderingURL, vectorAssetsURL, compiled }) => {
      const [{ WebGLDevice, MeshRenderer, YarnSurfaceRenderer }, { createVectorAsset }] = await Promise.all([
        import(renderingURL), import(vectorAssetsURL),
      ]);
      const data = { ...compiled, geometry: { ...compiled.geometry,
        vertices: Float32Array.from(compiled.geometry.vertices), indices: Uint16Array.from(compiled.geometry.indices),
        expressionIndices: Object.fromEntries(Object.entries(compiled.geometry.expressionIndices ?? {}).map(([key, value]) => [key, Uint16Array.from(value)])),
        indexVariants: Object.fromEntries(Object.entries(compiled.geometry.indexVariants ?? {}).map(([key, value]) => [key, Uint16Array.from(value)])),
        shaderSurfaces: compiled.geometry.shaderSurfaces?.map(surface => ({ ...surface,
          fillVertices: Float32Array.from(surface.fillVertices), outline: Float32Array.from(surface.outline), edgeColors: Float32Array.from(surface.edgeColors),
        })),
      } };
      const canvas = document.querySelector('canvas');
      const device = new WebGLDevice(canvas, { alpha: true, antialias: true, depth: true, stencil: true, preserveDrawingBuffer: true });
      const meshes = new MeshRenderer(device), surfaces = new YarnSurfaceRenderer(device), asset = createVectorAsset(meshes, data, { surfaceRenderer: surfaces });
      const fallbackGeometry = { ...data.geometry }; delete fallbackGeometry.drawOrder; delete fallbackGeometry.shaderSurfaces;
      const fallbackData = { ...data, geometry: fallbackGeometry };
      const fallbackAsset = createVectorAsset(meshes, fallbackData), fallbackPlayer = fallbackAsset.createPlayer({ clip: 'idle', startedAtMs: 0 });
      const meshUploadsAtCreation = meshes.stats().geometryUploads;
      const player = asset.createPlayer({ clip: 'idle', startedAtMs: 0 }); player.seek(50);
      const vp = Float32Array.of(2 / 240, 0, 0, 0, 0, -2 / 180, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1);
      const model = (centerX, size, angle = 0.12) => {
        const sx = size / 100, sy = size * 0.82 / 100, c = Math.cos(angle), s = Math.sin(angle);
        const a = sx * c, b = sx * s, d = sy * c, e = -sy * s;
        return Float32Array.of(a, b, 0, 0, e, d, 0, 0, 0, 0, 1, 0, centerX - 50 * a - 50 * e, 90 - 50 * b - 50 * d, 0, 1);
      };
      const clips = [[{ x: 0, y: 0 }, { x: 190, y: 0 }, { x: 190, y: 180 }, { x: 0, y: 180 }]];
      const draw = () => {
        device.beginFrame({ width: canvas.width, height: canvas.height, clearColor: [0, 0, 0, 0] }); meshes.beginFrame();
        for (const [center, size] of [[59, 47], [172, 74]]) {
          player.draw({ viewProjection: vp, worldMatrix: model(center, size), clips, depthTest: true, depthWrite: false });
        }
        fallbackPlayer.draw({ viewProjection: vp, worldMatrix: model(26, 24), color: [1, 0.6, 0.2, 1], clips, depthTest: true, depthWrite: false });
        meshes.flush();
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        device.gl.readPixels(0, 0, canvas.width, canvas.height, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixels);
        device.endFrame();
        return pixels;
      };
      const pixels = draw();
      const clipTriangleCount = Math.ceil((surfaces.stats().maxClipPlanes + 1) / 3);
      const overflowClips = Array.from({ length: clipTriangleCount }, (_, index) => {
        const x = index * 6; return [{ x, y: 0 }, { x: x + 4, y: 0 }, { x: x + 2, y: 4 }];
      });
      device.beginFrame({ width: canvas.width, height: canvas.height, clearColor: [0, 0, 0, 0] }); meshes.beginFrame();
      const clipLimitBefore = meshes.stats().draws;
      let clipLimitError = '';
      try { player.draw({ viewProjection: vp, worldMatrix: model(59, 47), clips: overflowClips }); }
      catch (error) { clipLimitError = error.message; }
      meshes.flush();
      const clipLimitPreflight = /shader surface limit/.test(clipLimitError) && meshes.stats().draws === clipLimitBefore;
      device.endFrame();
      device.beginFrame({ width: canvas.width, height: canvas.height, clearColor: [0, 0, 0, 0] }); meshes.beginFrame();
      const depthParts = player.partPoses().map(({ transform, morph, opacity, visible }) => ({ transform, morph, opacity, visible }));
      meshes.drawMesh(asset.mesh, { viewProjection: vp, worldMatrix: model(26, 24), parts: depthParts, color: [0, 0, 1, 1], forceColor: true, depth: -0.5, depthTest: true, depthWrite: true });
      meshes.drawMesh(asset.mesh, { viewProjection: vp, worldMatrix: model(26, 24), parts: depthParts, color: [1, 0, 0, 1], forceColor: true, depth: 0.5, depthTest: true, depthWrite: true });
      meshes.flush();
      const depthPixels = new Uint8Array(canvas.width * canvas.height * 4);
      device.gl.readPixels(0, 0, canvas.width, canvas.height, device.gl.RGBA, device.gl.UNSIGNED_BYTE, depthPixels); device.endFrame();
      const depthAt = ((canvas.height - 1 - 90) * canvas.width + 26) * 4, depthPixel = Array.from(depthPixels.subarray(depthAt, depthAt + 4));
      const sample = (x, y) => {
        const at = ((canvas.height - 1 - Math.floor(y)) * canvas.width + Math.floor(x)) * 4;
        return Array.from(pixels.subarray(at, at + 4));
      };
      const screen = (center, size, localX, localY, angle = 0.12) => {
        const sx = size / 100, sy = size * 0.82 / 100, c = Math.cos(angle), s = Math.sin(angle);
        const a = sx * c, b = sx * s, e = -sy * s, d = sy * c;
        const worldX = a * localX + e * localY + center - 50 * a - 50 * e;
        const worldY = b * localX + d * localY + 90 - 50 * b - 50 * d;
        return { x: worldX, y: worldY };
      };
      const bounds = (left, right) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = left; x < right; x++) {
          const alpha = pixels[(y * canvas.width + x) * 4 + 3];
          if (!alpha) continue;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
        }
        return { width: maxX - minX + 1, height: maxY - minY + 1, count };
      };
      const sampleAt = (center, size, x, y) => { const point = screen(center, size, x, y); return sample(point.x, point.y); };
      const smallBounds = bounds(39, 90), largeBounds = bounds(130, 215);
      const under = sampleAt(59, 47, 12, 12), cloth = sampleAt(59, 47, 25, 25), over = sampleAt(59, 47, 50, 50), clipped = sampleAt(172, 74, 90, 50), fallbackWorldDraw = sampleAt(26, 24, 50, 50);
      const clothColors = new Set();
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const at = (y * canvas.width + x) * 4, alpha = pixels[at + 3];
        if (alpha && x >= 48 && x <= 70 && y >= 72 && y <= 100) clothColors.add(pixels.subarray(at, at + 3).join(','));
      }
      const state = { smallBounds, largeBounds, under, cloth, over, clipped, fallbackWorldDraw, depthPixel, yarnColorCount: clothColors.size,
        clipLimitPreflight,
        meshDraws: meshes.stats().draws, meshUploadsAtCreation, meshUploadsAfterFrame: meshes.stats().geometryUploads,
        surfaceCount: surfaces.stats().surfaceCount, retainedSurfaceBytes: surfaces.stats().retainedBytes, glError: device.gl.getError() };
      const lose = device.gl.getExtension('WEBGL_lose_context');
      if (lose) {
        const waitFor = expected => new Promise((resolve, reject) => {
          const end = performance.now() + 8000;
          const poll = () => {
            if (meshes.stats().state === expected && surfaces.stats().state === expected) return resolve();
            if (meshes.stats().state === 'failed' || surfaces.stats().state === 'failed' || performance.now() > end) return reject(new Error('WebGL retained SVG context ' + expected + ' failed'));
            requestAnimationFrame(poll);
          }; poll();
        });
        lose.loseContext(); await waitFor('lost'); lose.restoreContext(); await waitFor('ready');
        const restored = draw();
        state.restoredPixel = Array.from(restored.subarray(((canvas.height - 1 - 90) * canvas.width + 172) * 4, ((canvas.height - 1 - 90) * canvas.width + 172) * 4 + 4));
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__worldVectorTest = { dispose() {
        asset.dispose(); fallbackAsset.dispose(); const meshCount = meshes.stats().meshCount, retainedSurfaces = surfaces.stats().surfaceCount;
        surfaces.dispose(); meshes.dispose(); device.dispose(); return { meshCount, retainedSurfaces };
      } };
      return state;
    }, { renderingURL, vectorAssetsURL, compiled });
    assert.ok(result.smallBounds.count > 200 && result.largeBounds.count > 600, 'both retained SVG actors cover real WebGL pixels');
    assert.ok(result.largeBounds.height / result.smallBounds.height > 1.4 && result.largeBounds.height / result.smallBounds.height < 1.75,
      'unclipped vertical extent scales proportionally; the large actor is deliberately clipped horizontally: ' + JSON.stringify({small:result.smallBounds,large:result.largeBounds}));
    assert.ok(result.under[2] > result.under[0] && result.under[3] > 240, 'pre-surface SVG geometry paints beneath the shader surface');
    assert.ok(result.cloth[3] > 240 && result.yarnColorCount > 4, 'the retained yarn material produces filled, non-solid shader pixels');
    assert.ok(result.over[1] > result.over[0] && result.over[3] > 240, 'post-surface SVG geometry paints above the shader surface');
    assert.equal(result.clipped[3], 0, 'one shared world-space clip follows both differently transformed actors');
    assert.ok(result.fallbackWorldDraw[3] > 0, 'assets without draw-order metadata accept 3D world transforms');
    assert.ok(result.depthPixel[2] > result.depthPixel[0] * 2, 'depth testing keeps the nearer world-space mesh when a farther draw is submitted later');
    assert.equal(result.clipLimitPreflight, true, 'shared clip capacity is rejected before any painter-order geometry is submitted');
    assert.equal(result.glError, 0, 'WebGL reports no error after the mixed 3D painter-order draw');
    assert.equal(result.surfaceCount, 1, 'the shader surface is retained once for both actors');
    assert.ok(result.restoredPixel?.[3] > 0, 'the retained SVG mesh and surface redraw after context restoration');
    if (errors.length) throw new Error('3D vector browser page errors: ' + errors.join('; '));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const disposed = await page.evaluate(() => window.__worldVectorTest.dispose());
    assert.deepEqual(disposed, { meshCount: 0, retainedSurfaces: 0 }, 'asset disposal releases its mesh and shader surface');
    return { ...result, disposed, evidencePath: screenshotPath };
  } finally {
    await page.close();
  }
}

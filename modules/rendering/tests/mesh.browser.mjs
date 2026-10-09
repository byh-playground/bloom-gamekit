import assert from 'node:assert/strict';

/** One retained animated-art scene, including compositing, device recovery and shutdown. */
export async function exerciseReusableMeshes(page) {
  const results = [];
  for (const antialias of [false, true]) for (const withoutANGLE of [false, true]) {
    results.push(await page.evaluate(async ({ withoutANGLE, antialias }) => {
      const { WebGLDevice, VectorContext, MeshBuilder, PrimitivePainter } = await import('/dist/rendering.js');
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      const near = (actual, expected, message) => check(actual.every((v, i) => Math.abs(v - expected[i]) <= 2), `${message}: ${actual}, expected ${expected}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; document.body.append(canvas);
      const nativeGetContext = canvas.getContext.bind(canvas);
      let interceptedGL, nativeGetExtension;
      if (withoutANGLE) canvas.getContext = (...args) => {
        const gl = nativeGetContext(...args);
        interceptedGL = gl; nativeGetExtension = gl.getExtension;
        gl.getExtension = name => name === 'ANGLE_instanced_arrays' ? null : nativeGetExtension.call(gl, name);
        return gl;
      };
      const device = new WebGLDevice(canvas, { alpha: false, antialias, preserveDrawingBuffer: true });
      if (withoutANGLE) {
        interceptedGL.getExtension = nativeGetExtension;
        canvas.getContext = nativeGetContext;
      }
      const ctx = new VectorContext(device), gl = device.gl;
      try {
        check(device.instancingSupported === !withoutANGLE, 'real device backend selection');
        const samples = gl.getParameter(gl.SAMPLES);
        check(!antialias || gl.getContextAttributes().antialias && samples > 1, 'requested MSAA is actually active');
        const pixel = (x, y) => { const bytes = new Uint8Array(4); gl.readPixels(x, 127 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return [...bytes]; };
        const pixels = () => { const bytes = new Uint8Array(128 * 128 * 4); gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return bytes; };
        const begin = () => { check(ctx.beginFrame({ clearColor: [0, 0, 0, 1] }), 'scene frame available'); };
        const art = (right = 6, top = -6) => {
          const builder = new MeshBuilder();
          new PrimitivePainter(builder).quad(-6, top, right, top, right, 6, -6, 6, [1, 0, 0, .5]);
          return builder;
        };
        const base = art(), data = base.build({ morphs: [art(14), art(6, -12)] });
        begin();
        const mesh = ctx.createMesh(data);
        for (const x of [24, 64]) {
          ctx.save(); ctx.translate(x, 24);
          ctx.withSilhouette('#00ff00', 3, () => ctx.drawMesh(mesh), 20);
          ctx.restore();
        }
        const cold = ctx.endFrame();
        near(pixel(16, 24), [0, 255, 0, 255], 'retained silhouette edge');
        near(pixel(24, 24), [128, 127, 0, 255], 'body follows forced-color silhouette');
        check(cold.mesh.geometryUploads === 1 && cold.mesh.geometryBytesUploaded === data.vertices.byteLength, 'cold geometry uploaded exactly once');
        check(cold.mesh.instances === 20, 'two silhouettes reuse one mesh for all twenty passes');
        check(cold.uploadedBytes === data.vertices.byteLength + (withoutANGLE ? 0 : 20 * 64), 'cold bytes are geometry plus instance records only');

        begin();
        for (const x of [24, 64, 104]) ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, x, 24] });
        const warm = ctx.endFrame();
        for (const x of [24, 64, 104]) near(pixel(x, 24), [128, 0, 0, 255], 'adjacent retained instances');
        check(warm.mesh.geometryUploads === 0 && warm.mesh.geometryBytesUploaded === 0, 'warm scene never rebuilds/uploads geometry');
        check(warm.mesh.draws === (withoutANGLE ? 3 : 1) && warm.mesh.instances === 3, 'adjacent same-mesh batch');
        check(device.stats.instancedDrawCalls === (withoutANGLE ? 0 : 1), 'device records actual instanced draw');
        check(warm.uploadedBytes === (withoutANGLE ? 0 : 3 * 64) && warm.mesh.instanceBytesUploaded === warm.uploadedBytes, 'warm upload contains only instance records, uniform backend uploads none');

        begin();
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 24, 24] });
        ctx.save(); ctx.translate(70, 32); ctx.rotate(Math.PI / 2);
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 0, -10], morph: [.5, .5] });
        ctx.restore(); ctx.endFrame();
        near(pixel(24, 24), [128, 0, 0, 255], 'earlier instance keeps its captured transform/morph');
        near(pixel(88, 32), [128, 0, 0, 255], 'second morph expands rotated top edge');
        near(pixel(80, 40), [128, 0, 0, 255], 'first morph expands rotated right edge');
        near(pixel(90, 32), [0, 0, 0, 255], 'animated mesh retains its exact boundary');

        begin(); ctx.globalAlpha = .5;
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 16, 24] });
        ctx.withColor([0, 1, 0, .5], () => ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 48, 24] }));
        ctx.filter = 'brightness(0) invert(1)';
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 80, 24] });
        ctx.withColor([0, 1, 0, .5], () => ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 112, 24] }));
        ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.endFrame();
        near(pixel(16, 24), [64, 0, 0, 255], 'authored alpha times instance alpha');
        near(pixel(48, 24), [0, 64, 0, 255], 'forced color replaces authored color/alpha');
        near(pixel(80, 24), [64, 64, 64, 255], 'white flash preserves authored alpha');
        near(pixel(112, 24), [64, 64, 64, 255], 'white flash follows forced color without losing alpha');

        begin();
        ctx.fillTriangleFan([[12, 12], [36, 12], [36, 36], [12, 36]], '#0000ff');
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 24, 24] });
        ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 72, 24] });
        ctx.fillTriangleFan([[60, 12], [84, 12], [84, 36], [60, 36]], '#0000ff');
        ctx.endFrame();
        near(pixel(24, 24), [128, 0, 127, 255], 'queued vector then mesh painter order');
        near(pixel(72, 24), [0, 0, 255, 255], 'queued mesh then vector painter order');

        const clippedScene = (retained, nested = true) => {
          begin(); ctx.save();
          const paint = () => {
            ctx.translate(64, 64); ctx.rotate(Math.PI / 4); ctx.clipRect(-18, -12, 36, 24); ctx.resetTransform();
            ctx.withColor('#ff0000', () => {
              if (retained) ctx.drawMesh(mesh, { transform: [5, 0, 0, 5, 64, 64] });
              else ctx.fillTriangleFan([[34, 34], [94, 34], [94, 94], [34, 94]], '#ff0000');
            });
          };
          if (nested) ctx.withGroupOpacity(.5, () => ctx.withGroupOpacity(.5, paint,
            { x: 24, y: 24, width: 80, height: 80 }), { x: 8, y: 8, width: 112, height: 112 });
          else paint(); // Actual multisampled default framebuffer, not a single-sample opacity FBO.
          ctx.restore(); ctx.endFrame();
          return pixels();
        };
        const clipped = clippedScene(true);
        near(pixel(64, 64), [64, 0, 0, 255], 'nested opacity applied once at each target');
        near(pixel(70, 60), [64, 0, 0, 255], 'rotated clip interior');
        near(pixel(85, 85), [0, 0, 0, 255], 'rotated clip excludes bounding-box corner');
        const vectorReference = clippedScene(false);
        let clipDifference = 0, maxClipDifference = 0, clipInteriorDifference = 0, clipExteriorDifference = 0, maxClipEdgeDifference = 0;
        for (let i = 0; i < clipped.length; i++) {
          const delta = Math.abs(clipped[i] - vectorReference[i]);
          const pixelIndex = Math.floor(i / 4), dx = pixelIndex % 128 + .5 - 64, dy = 127 - Math.floor(pixelIndex / 128) + .5 - 64;
          const distance = Math.min(18 - Math.abs((dx + dy) * Math.SQRT1_2), 12 - Math.abs((-dx + dy) * Math.SQRT1_2));
          if (delta > 2) {
            clipDifference++;
            if (distance > 2) clipInteriorDifference++;
            else if (distance < -2) clipExteriorDifference++;
          }
          maxClipDifference = Math.max(maxClipDifference, delta);
          if (Math.abs(distance) <= 2) maxClipEdgeDifference = Math.max(maxClipEdgeDifference, delta);
        }
        check(clipInteriorDifference === 0 && clipExteriorDifference === 0, `mesh/vector rotated clip interior/exterior parity: ${clipInteriorDifference}/${clipExteriorDifference}`);
        // Fragment-plane discard and MSAA-tessellated vector edges have distinct coverage;
        // report those edge pixels explicitly rather than disguising them as exact parity.
        check(antialias || clipDifference === 0, `non-MSAA full rotated clip parity: ${clipDifference} channels, max ${maxClipDifference}`);

        const directClipped = clippedScene(true, false), directVector = clippedScene(false, false);
        let directInteriorDifference = 0, directExteriorDifference = 0, directEdgeDifference = 0, directMaxEdgeDifference = 0;
        for (let p = 0; p < 128 * 128; p++) {
          const dx = p % 128 + .5 - 64, dy = 127 - Math.floor(p / 128) + .5 - 64;
          const distance = Math.min(18 - Math.abs((dx + dy) * Math.SQRT1_2), 12 - Math.abs((-dx + dy) * Math.SQRT1_2));
          for (let c = 0; c < 4; c++) {
            const delta = Math.abs(directClipped[p * 4 + c] - directVector[p * 4 + c]);
            if (Math.abs(distance) <= 2) {
              directMaxEdgeDifference = Math.max(directMaxEdgeDifference, delta);
              if (delta > 2) directEdgeDifference++;
            } else if (delta > 2) {
              if (distance > 2) directInteriorDifference++;
              else directExteriorDifference++;
            }
          }
        }
        check(directInteriorDifference === 0 && directExteriorDifference === 0, `default-framebuffer rotated clip interior/exterior parity: ${directInteriorDifference}/${directExteriorDifference}`);
        check(antialias || directEdgeDifference === 0, 'non-MSAA direct clip has exact vector edge coverage');

        const beforeRestore = clippedScene(true), loss = gl.getExtension('WEBGL_lose_context');
        check(loss, 'real context-loss extension available');
        const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        loss.loseContext(); await lost;
        check(ctx.beginFrame() === false, 'lost scene skips frame');
        await new Promise(resolve => setTimeout(resolve, 80));
        const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
        loss.restoreContext(); await restored;
        check(device.state === 'ready' && ctx.state === 'ready', 'scene/device restored');
        const afterRestore = clippedScene(true);
        check(beforeRestore.every((v, i) => v === afterRestore[i]), 'same retained handle restores identical scene pixels');
        check(gl.getError() === gl.NO_ERROR, 'actual WebGL path has no GL errors');

        begin(); ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 24, 24] });
        check(ctx.deleteMesh(mesh) && !ctx.deleteMesh(mesh), 'deletion flushes queued drawing and is idempotent');
        ctx.endFrame(); near(pixel(24, 24), [128, 0, 0, 255], 'queued last use remains visible after deletion');
        check(ctx.stats().mesh.meshCount === 0 && ctx.stats().mesh.retainedBytes === 0, 'deleted geometry leaves no retained allocation');
        ctx.dispose(); ctx.dispose();
        check(device.state === 'ready' && device.stats.bufferCount === 0 && device.stats.pipelineCount === 0 && device.stats.textureCount === 0 && device.stats.renderTargetCount === 0, 'scene disposal releases its resources without disposing caller device');
        return { backend: withoutANGLE ? 'uniform-retained-mesh' : 'ANGLE-instanced-mesh', antialias, samples, cold: cold.mesh, coldUploadedBytes: cold.uploadedBytes,
          warm: warm.mesh, warmUploadedBytes: warm.uploadedBytes, clipDifference, maxClipDifference, clipInteriorDifference, clipExteriorDifference, maxClipEdgeDifference,
          directClip: { interiorDifference: directInteriorDifference, exteriorDifference: directExteriorDifference, edgeDifference: directEdgeDifference, maxEdgeDifference: directMaxEdgeDifference },
          transformsAndTwoMorphs: true, silhouette: true, whiteFlashAlpha: true, painterOrder: true,
          nestedOpacityRotatedClip: true, sameHandleRestoration: true, deletionAndDisposal: true };
      } finally { ctx.dispose(); device.dispose(); canvas.remove(); }
    }, { withoutANGLE, antialias }));
  }
  assert.equal(results.length, 4);
  return { scenes: results, scope: 'Actual Chromium WebGL1 pixels, retained geometry and instance-upload counters; forced extension absence uses the same native GL context, not fake GL. Not a mobile performance benchmark.' };
}

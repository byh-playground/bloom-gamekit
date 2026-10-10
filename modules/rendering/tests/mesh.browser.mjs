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
        check(cold.mesh.draws === (withoutANGLE ? 20 : 1), 'opaque group boundaries preserve adjacent same-mesh unit batching');
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

        begin();ctx.save();ctx.translate(20,20);ctx.rotate(Math.PI/2);
        const singlePose=[{transform:[2,0,0,.5,12,0],morph:[.5,.25]}];
        ctx.drawMesh(mesh,{parts:singlePose,morph:[.25,.25]});
        singlePose[0].transform[4]=60;
        ctx.drawMesh(mesh,{parts:singlePose,morph:[.25,.25]});
        singlePose[0].transform[4]=95;singlePose[0].visible=false;
        ctx.drawMesh(mesh,{parts:singlePose,morph:[.25,.25]});
        ctx.restore();const singlePoseStats=ctx.endFrame();
        near(pixel(22,24),[128,0,0,255],'single-part pose retains its original non-identity transform');
        near(pixel(22,54),[128,0,0,255],'single-part pose adds local and instance morph weights');
        near(pixel(22,72),[128,0,0,255],'in-place single-part transform change affects only the next instance');
        near(pixel(22,110),[0,0,0,255],'hidden single part remains absent after pose mutation');
        check(singlePoseStats.mesh.draws===(withoutANGLE?3:1)&&singlePoseStats.mesh.partUniformBytesSubmitted===0,
          'single-part pose is folded into adjacent instances, not per-vertex uniforms');

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

        // Three authored overlapping translucent parts stay one ordered mesh, even
        // when independent part animation and silhouette instances are combined.
        const authored = [
          { points: [[-12, -8], [12, -8], [12, 8], [-12, 8]], color: [1, 0, 0, .5],
            targets: [[[-12, -8], [20, -8], [20, 8], [-12, 8]], [[-12, -12], [12, -12], [12, 8], [-12, 8]]] },
          { points: [[-9, -11], [9, -11], [9, 11], [-9, 11]], color: [0, 1, 0, .4],
            targets: [[[-9, -11], [14, -11], [14, 11], [-9, 11]], [[-9, -11], [9, -11], [9, 17], [-9, 17]]] },
          { points: [[-8, -8], [10, -6], [0, 12]], color: [0, 0, 1, .6],
            targets: [[[-8, -8], [10, -6], [6, 12]], [[-8, -8], [10, -6], [0, 20]]] }
        ];
        const buildPart = (points, color) => { const b = new MeshBuilder(); new PrimitivePainter(b).poly(points, color); return b; };
        const packedData = MeshBuilder.combine(authored.map(a => buildPart(a.points, a.color).build({ morphs: a.targets.map(p => buildPart(p, a.color)) })));
        check(packedData.strideFloats === 11 && packedData.partCount === 3, 'packed authored schema');
        const rotation = (angle, x, y) => [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), x, y];
        const poses = () => [
          { transform: [1, 0, 0, 1, 0, 0], morph: [.25, .1], visible: true },
          { transform: rotation(Math.PI / 6, 2, 1), morph: [.2, .3], visible: true },
          { transform: rotation(-Math.PI / 5, -2, -1), morph: [.1, .2], visible: false }
        ];
        const globalMorph = [.125, .1];
        const partPoints = (a, part) => a.points.map((p, i) => p.map((v, axis) => v +
          (a.targets[0][i][axis] - v) * (globalMorph[0] + part.morph[0]) +
          (a.targets[1][i][axis] - v) * (globalMorph[1] + part.morph[1])));
        const reference = parts => {
          for (let i = 0; i < authored.length; i++) {
            const part = parts[i]; if (part.visible === false) continue;
            ctx.save(); ctx.transform(...part.transform);
            ctx.fillTriangleFan(partPoints(authored[i], part), authored[i].color); ctx.restore();
          }
        };
        begin();
        const packedMesh = ctx.createMesh(packedData), initialParts = poses();
        ctx.drawMesh(packedMesh, { transform: [1, 0, 0, 1, 34, 64], parts: initialParts, morph: globalMorph });
        const packedCold = ctx.endFrame();
        check(packedCold.mesh.geometryUploads === 1 && packedCold.mesh.geometryBytesUploaded === packedData.vertices.byteLength, 'combined geometry uploaded once');
        near(pixel(34, 64), [77, 102, 0, 255], 'original red then green order, hidden blue part absent');

        const paintPackedScene = (retained, draws, silhouette = false) => {
          begin(); let callbacks = 0;
          for (const { x, y, parts } of draws) {
            ctx.save(); ctx.translate(x, y);
            const paint = () => { callbacks++; if (retained) ctx.drawMesh(packedMesh, { parts, morph: globalMorph }); else reference(parts); };
            if (silhouette) ctx.withSilhouette('#ffe000', 3, paint, 40); else paint();
            ctx.restore();
          }
          const stats = ctx.endFrame(); return { bytes: pixels(), stats, callbacks };
        };
        const polygonPoints = draws => draws.flatMap(draw => authored.flatMap((a, i) => {
          const part = draw.parts[i]; if (part.visible === false) return [];
          const m = part.transform;
          return [partPoints(a, part).map(([x, y]) => [m[0] * x + m[2] * y + m[4] + draw.x, m[1] * x + m[3] * y + m[5] + draw.y])];
        }));
        const comparePacked = (actual, expected, draws, silhouette = false) => {
          let differentChannels = 0, interiorDifferentChannels = 0, maxDifference = 0;
          const polygons = polygonPoints(draws), offsets = [[0, 0]];
          if (silhouette) for (let i = 0; i < 8; i++) offsets.push([Math.cos(i * Math.PI / 4) * 3, Math.sin(i * Math.PI / 4) * 3]);
          for (let p = 0; p < 128 * 128; p++) {
            const x = p % 128 + .5, y = 127 - Math.floor(p / 128) + .5;
            let distance = Infinity;
            for (const polygon of polygons) for (const [ox, oy] of offsets) for (let j = 0; j < polygon.length; j++) {
              const a = polygon[j], b = polygon[(j + 1) % polygon.length], dx = b[0] - a[0], dy = b[1] - a[1];
              const t = Math.max(0, Math.min(1, ((x - ox - a[0]) * dx + (y - oy - a[1]) * dy) / (dx * dx + dy * dy)));
              distance = Math.min(distance, Math.hypot(x - ox - a[0] - t * dx, y - oy - a[1] - t * dy));
            }
            for (let c = 0; c < 4; c++) {
              const delta = Math.abs(actual[p * 4 + c] - expected[p * 4 + c]); maxDifference = Math.max(maxDifference, delta);
              if (delta > 2) { differentChannels++; if (distance > 1.5) interiorDifferentChannels++; }
            }
          }
          check(interiorDifferentChannels === 0, `packed authored order/animation interior parity: ${interiorDifferentChannels} channels`);
          check(antialias || differentChannels === 0, `non-MSAA packed scene pixel parity: ${differentChannels} channels, max ${maxDifference}`);
          return { differentChannels, interiorDifferentChannels, maxDifference };
        };

        const animatedParts = poses(), beforeMutation = structuredClone(animatedParts);
        begin(); ctx.drawMesh(packedMesh, { transform: [1, 0, 0, 1, 34, 64], parts: animatedParts, morph: globalMorph });
        animatedParts[0].transform[4] = 7;
        animatedParts[1].transform.splice(0, 4, ...rotation(-Math.PI / 7, 0, 0).slice(0, 4));
        animatedParts[1].morph[0] = .75; animatedParts[2].visible = true; animatedParts[2].morph[1] = .5;
        const afterMutation = structuredClone(animatedParts);
        ctx.drawMesh(packedMesh, { transform: [1, 0, 0, 1, 94, 64], parts: animatedParts, morph: globalMorph });
        check(device.stats.drawCalls === 1, 'in-place part mutation flushes the earlier captured instance immediately');
        near(pixel(34, 64), [77, 102, 0, 255], 'first submitted instance keeps pre-mutation colors/visibility/pose');
        animatedParts[2].visible = false;
        for (const part of animatedParts) part.transform[4] += 1000;
        const mutationStats = ctx.endFrame(), mutationPixels = pixels();
        near(pixel(94, 64), [31, 41, 153, 255], 'second queued instance keeps captured pose after caller mutates again');
        check(mutationStats.mesh.draws === 2 && mutationStats.mesh.geometryUploads === 0, 'part-state boundary uses two ordered draws without geometry upload');
        const mutationDraws = [{ x: 34, y: 64, parts: beforeMutation }, { x: 94, y: 64, parts: afterMutation }];
        const mutationReference = paintPackedScene(false, mutationDraws);
        const mutationParity = comparePacked(mutationPixels, mutationReference.bytes, mutationDraws);

        const silhouetteParts = poses(); silhouetteParts[2].visible = true;
        const silhouetteDraws = [{ x: 64, y: 64, parts: silhouetteParts }];
        const silhouettePacked = paintPackedScene(true, silhouetteDraws, true);
        check(silhouettePacked.callbacks === 10 && silhouettePacked.stats.mesh.instances === 10, 'three-part silhouette submits exactly ten whole-mesh instances');
        check(silhouettePacked.stats.mesh.draws === (withoutANGLE ? 10 : 1), 'ten combined silhouette instances use one ANGLE draw');
        check(device.stats.instancedDrawCalls === (withoutANGLE ? 0 : 1), 'actual device confirms combined silhouette instancing');
        check(silhouettePacked.stats.mesh.geometryUploads === 0 && silhouettePacked.stats.uploadedBytes === (withoutANGLE ? 0 : 640), 'warm combined silhouette only uploads instance records');
        const silhouetteReference = paintPackedScene(false, silhouetteDraws, true);
        const silhouetteParity = comparePacked(silhouettePacked.bytes, silhouetteReference.bytes, silhouetteDraws, true);

        begin(); ctx.save(); ctx.translate(64, 64);
        ctx.drawMeshSilhouette(packedMesh, { parts: silhouetteParts, morph: globalMorph, color: '#ffe000', width: 3, radius: 40 });
        ctx.restore(); const batchedSilhouetteStats = ctx.endFrame(), batchedSilhouettePixels = pixels();
        const batchedSilhouetteParity = comparePacked(batchedSilhouettePixels, silhouetteReference.bytes, silhouetteDraws, true);
        check(batchedSilhouettePixels.every((value, i) => value === silhouettePacked.bytes[i]), 'mesh silhouette batching is pixel-identical to the repeated WebGL draw path');
        check(batchedSilhouetteStats.mesh.instances === 10 && batchedSilhouetteStats.mesh.draws === (withoutANGLE ? 10 : 1), 'one silhouette API preserves ten ordered instances and the non-instanced fallback');
        check(batchedSilhouetteStats.mesh.geometryUploads === 0 && batchedSilhouetteStats.uploadedBytes === (withoutANGLE ? 0 : 640), 'batched silhouette uploads instance records only');
        const renderOrderedSilhouette = batched => {
          begin(); ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, 128, 128);
          ctx.save(); ctx.translate(64, 64);
          if (batched) ctx.drawMeshSilhouette(packedMesh, { parts: silhouetteParts, morph: globalMorph, color: '#ffe000', width: 3, radius: 40 });
          else ctx.withSilhouette('#ffe000', 3, () => ctx.drawMesh(packedMesh, { parts: silhouetteParts, morph: globalMorph }), 40);
          ctx.restore(); ctx.fillStyle = '#00ccff'; ctx.fillRect(60, 60, 8, 8); ctx.endFrame(); return pixels();
        };
        const orderedSilhouetteReference = renderOrderedSilhouette(false), orderedSilhouetteBatch = renderOrderedSilhouette(true);
        check(orderedSilhouetteBatch.every((value, i) => value === orderedSilhouetteReference[i]), 'batched silhouette preserves painter order against surrounding vector draws');
        const renderTransformedSilhouette = batched => {
          begin(); ctx.save(); ctx.translate(62, 61); ctx.rotate(Math.PI / 7); ctx.globalAlpha = .5;
          const transform = [.9, 0, 0, 1.1, 2, -1];
          if (batched) ctx.drawMeshSilhouette(packedMesh, { transform, parts: silhouetteParts, morph: globalMorph, color: '#ffe000', width: 3, radius: 40 });
          else ctx.withSilhouette('#ffe000', 3, () => ctx.drawMesh(packedMesh, { transform, parts: silhouetteParts, morph: globalMorph }), 40);
          ctx.restore(); ctx.endFrame(); return pixels();
        };
        const transformedSilhouetteReference = renderTransformedSilhouette(false), transformedSilhouetteBatch = renderTransformedSilhouette(true);
        check(transformedSilhouetteBatch.every((value, i) => value === transformedSilhouetteReference[i]), 'batched silhouette preserves local/context transforms and outer group alpha');
        const renderForcedFlashSilhouette = batched => {
          begin(); ctx.save(); ctx.translate(64, 64); ctx.filter = 'brightness(0) invert(1)';
          ctx.withColor([.2, .8, .3, .35], () => {
            if (batched) ctx.drawMeshSilhouette(packedMesh, { parts: silhouetteParts, morph: globalMorph, color: '#ffe000', width: 3, radius: 40 });
            else ctx.withSilhouette('#ffe000', 3, () => ctx.drawMesh(packedMesh, { parts: silhouetteParts, morph: globalMorph }), 40);
          });
          ctx.restore(); ctx.endFrame(); return pixels();
        };
        const forcedFlashReference = renderForcedFlashSilhouette(false), forcedFlashBatch = renderForcedFlashSilhouette(true);
        check(forcedFlashBatch.every((value, i) => value === forcedFlashReference[i]), 'batched silhouette preserves outer forceColor and white-flash alpha');

        const beforeRestore = clippedScene(true), loss = gl.getExtension('WEBGL_lose_context');
        const combinedBeforeRestore = paintPackedScene(true, silhouetteDraws, true).bytes;
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
        const combinedAfterRestore = paintPackedScene(true, silhouetteDraws, true).bytes;
        check(combinedBeforeRestore.every((v, i) => v === combinedAfterRestore[i]), 'same combined mesh handle restores identical animated silhouette pixels');
        check(gl.getError() === gl.NO_ERROR, 'actual WebGL path has no GL errors');

        begin(); ctx.drawMesh(mesh, { transform: [1, 0, 0, 1, 24, 24] });
        check(ctx.deleteMesh(mesh) && !ctx.deleteMesh(mesh), 'deletion flushes queued drawing and is idempotent');
        check(ctx.deleteMesh(packedMesh), 'combined geometry is explicitly released');
        ctx.endFrame(); near(pixel(24, 24), [128, 0, 0, 255], 'queued last use remains visible after deletion');
        check(ctx.stats().mesh.meshCount === 0 && ctx.stats().mesh.retainedBytes === 0, 'deleted geometry leaves no retained allocation');
        ctx.dispose(); ctx.dispose();
        check(device.state === 'ready' && device.stats.bufferCount === 0 && device.stats.pipelineCount === 0 && device.stats.textureCount === 0 && device.stats.renderTargetCount === 0, 'scene disposal releases its resources without disposing caller device');
        return { backend: withoutANGLE ? 'uniform-retained-mesh' : 'ANGLE-instanced-mesh', antialias, samples, cold: cold.mesh, coldUploadedBytes: cold.uploadedBytes,
          warm: warm.mesh, warmUploadedBytes: warm.uploadedBytes, clipDifference, maxClipDifference, clipInteriorDifference, clipExteriorDifference, maxClipEdgeDifference,
          directClip: { interiorDifference: directInteriorDifference, exteriorDifference: directExteriorDifference, edgeDifference: directEdgeDifference, maxEdgeDifference: directMaxEdgeDifference },
          packedParts: { partCount: packedData.partCount, coldGeometryBytes: packedCold.mesh.geometryBytesUploaded,
            mutationDraws: mutationStats.mesh.draws, mutationParity, silhouetteDraws: silhouettePacked.stats.mesh.draws,
            silhouetteInstances: silhouettePacked.stats.mesh.instances, silhouetteUploadedBytes: silhouettePacked.stats.uploadedBytes,
            silhouetteGeometryUploads: silhouettePacked.stats.mesh.geometryUploads, silhouetteParity,
            batchedSilhouette: { draws: batchedSilhouetteStats.mesh.draws, instances: batchedSilhouetteStats.mesh.instances,
              uploadedBytes: batchedSilhouetteStats.uploadedBytes, parity: batchedSilhouetteParity,
              transformedAlphaParity: true, forcedFlashParity: true }, sameHandleRestoration: true,
            maxVertexAttributes: gl.getParameter(gl.MAX_VERTEX_ATTRIBS), maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) },
          transformsAndTwoMorphs: true, silhouette: true, whiteFlashAlpha: true, painterOrder: true,
          nestedOpacityRotatedClip: true, sameHandleRestoration: true, deletionAndDisposal: true };
      } finally { ctx.dispose(); device.dispose(); canvas.remove(); }
    }, { withoutANGLE, antialias }));
  }
  assert.equal(results.length, 4);
  return { scenes: results, scope: 'Actual Chromium WebGL1 pixels, retained geometry and instance-upload counters; forced extension absence uses the same native GL context, not fake GL. Not a mobile performance benchmark.' };
}

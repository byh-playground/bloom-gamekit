import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileVectorAssetFile } from '../compiler.js';

/** Exercises the compiled SVG through GameKit's real WebGL1 device and retained mesh renderer. */
export async function exerciseVectorAssets(page) {
  const compileStart = performance.now();
  const referenceAsset = await compileVectorAssetFile('modules/vector-assets/assets/seed-scout.svg', 'modules/vector-assets/assets/seed-scout.svg');
  const threeCompileMs = performance.now() - compileStart;
  await page.setViewportSize({ width: 844, height: 390 });
  const panelState = await page.evaluate(async () => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await waitFrame(); await waitFrame();
    const demo = window.vectorAssetDemo;
    const fail = message => { throw new Error('Three-view example: ' + message); };
    if (!demo?.ready || !demo.asset || !demo.actor) fail('SVG source and WebGL resources did not finish loading');
    const clip = document.querySelector('#clip'), time = document.querySelector('#time');
    const expression = document.querySelector('#expression'), zoom = document.querySelector('#zoom');
    clip.value = 'bounce'; clip.dispatchEvent(new Event('change', { bubbles: true }));
    time.value = '220'; time.dispatchEvent(new Event('input', { bubbles: true }));
    expression.value = 'happy'; expression.dispatchEvent(new Event('change', { bubbles: true }));
    zoom.value = '1.50'; zoom.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#play-toggle').click();
    await waitFrame(); await waitFrame();
    const body = demo.actor.getPartPose('body');
    const sourceBody = demo.sourceSvg.querySelector('[data-vector-part="body"]').getAttribute('transform');
    const sourceMatrix = sourceBody.slice(7, -1).split(/[ ,]+/).map(Number);
    const stages = [...document.querySelectorAll('.stage')].map(stage => {
      const rect = stage.getBoundingClientRect(); return { width: rect.width, height: rect.height };
    });
    const result = {
      ready: demo.ready, clip: demo.actor.currentClip, timeMs: demo.actor.currentTimeMs,
      expression: demo.actor.currentExpression, zoom: demo.camera.zoom, sourceSha256: demo.sourceSvg ? demo.asset.sourceSha256 : '',
      sourceBodyPoseMatches: sourceMatrix.length === 6 && sourceMatrix.every((value, index) => Math.abs(value - body.transform[index]) <= 0.006),
      happyShown: demo.sourceSvg.querySelector('[data-vector-part="face-happy"]').style.display !== 'none',
      neutralHidden: demo.sourceSvg.querySelector('[data-vector-part="face-neutral"]').style.display === 'none',
      triangles: demo.topology.triangles, compiledTriangles: demo.asset.mesh.vertices.length / 33,
      visibleTriangles: demo.lastFrame.topology.visibleTriangles, uniqueEdges: demo.topology.uniqueEdges,
      webglBackend: demo.device.instancingSupported ? 'WebGL 1 + ANGLE instancing' : 'WebGL 1 + per-draw uniforms',
      drawCalls: demo.lastFrame.gamekit.device.drawCalls,
      meshBytes: demo.asset.mesh.byteLength, sourceMetrics: document.querySelector('#source-metrics').textContent,
      topologyMetrics: document.querySelector('#topology-metrics').textContent, gamekitMetrics: document.querySelector('#gamekit-metrics').textContent,
      stages, sourceViewBox: demo.sourceSvg.getAttribute('viewBox'), viewport: [innerWidth, innerHeight],
      bodyHeight: document.body.getBoundingClientRect().height, mainHeight: document.querySelector('main').getBoundingClientRect().height,
    };
    clip.value = 'idle'; clip.dispatchEvent(new Event('change', { bubbles: true }));
    expression.value = 'neutral'; expression.dispatchEvent(new Event('change', { bubbles: true }));
    zoom.value = '1.00'; zoom.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#center-camera').click();
    time.value = '0'; time.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#play-toggle').click();
    await waitFrame(); await waitFrame();
    return result;
  });
  assert.equal(panelState.ready, true);
  assert.equal(panelState.clip, 'bounce');
  assert.equal(panelState.timeMs, 220, 'shared absolute time is applied to the GameKit player');
  assert.equal(panelState.expression, 'happy');
  assert.equal(panelState.zoom, 1.5);
  assert.match(panelState.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(panelState.sourceBodyPoseMatches, true, 'the source SVG view uses the same authored part pose');
  assert.equal(panelState.happyShown, true);
  assert.equal(panelState.neutralHidden, true);
  assert.equal(panelState.triangles, panelState.compiledTriangles);
  assert.ok(panelState.visibleTriangles > 0 && panelState.visibleTriangles < panelState.triangles);
  assert.ok(panelState.uniqueEdges > panelState.triangles);
  assert.match(panelState.webglBackend, /^WebGL 1/);
  assert.ok(panelState.drawCalls > 0 && panelState.meshBytes > 100_000);
  assert.match(panelState.sourceMetrics, /source bytes/);
  assert.match(panelState.topologyMetrics, /visible triangles/);
  assert.match(panelState.gamekitMetrics, /draw calls/);
  assert.ok(Math.min(...panelState.stages.map(stage => stage.width)) > 200, 'all three panels remain readable at mobile landscape width');
  assert.ok(Math.min(...panelState.stages.map(stage => stage.height)) > 100, 'all three panels remain visible at mobile landscape height');
  assert.ok(Math.max(...panelState.stages.map(stage => stage.height)) < 260, 'three panels fit the mobile landscape viewport without vertical overflow');
  assert.ok(Math.max(...panelState.stages.map(stage => stage.height)) - Math.min(...panelState.stages.map(stage => stage.height)) < 1.5,
    'the three camera viewports have matching dimensions');
  const panStage = page.locator('#source-stage'), box = await panStage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 4); await page.mouse.up();
  const movedCamera = await page.evaluate(() => ({ x: vectorAssetDemo.camera.x, y: vectorAssetDemo.camera.y }));
  assert.notEqual(movedCamera.x, 100, 'dragging one panel pans the shared camera');
  assert.notEqual(movedCamera.y, 110, 'vertical pan is shared');
  await page.locator('#center-camera').click();
  const centeredCamera = await page.evaluate(() => ({ x: vectorAssetDemo.camera.x, y: vectorAssetDemo.camera.y }));
  assert.deepEqual(centeredCamera, { x: 100, y: 110 }, 'center resets the shared camera');
  const report = await page.evaluate(async ({ sourcePaths, threeCompileMs }) => {
    const modules = window.vectorAssetRuntime ?? {
      ...await import('/dist/rendering.js'), ...await import('/dist/vector-assets.js'),
    };
    const { WebGLDevice, MeshRenderer, VectorContext, createSeedScout, seedScoutMetadata } = modules;
    const assertThat = (condition, message) => { if (!condition) throw new Error(message); };
    const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;
    const beginGpuQuery = device => {
      const extension = device.gl.getExtension('EXT_disjoint_timer_query');
      if (!extension) return null;
      const query = extension.createQueryEXT(); extension.beginQueryEXT(extension.TIME_ELAPSED_EXT, query);
      return { extension, query };
    };
    const endGpuQuery = (device, record) => {
      if (!record) return { elapsedNs: null, status: 'unsupported' };
      const { extension, query } = record;
      extension.endQueryEXT(extension.TIME_ELAPSED_EXT); device.gl.finish();
      const ready = extension.getQueryObjectEXT(query, extension.QUERY_RESULT_AVAILABLE_EXT);
      const disjoint = device.gl.getParameter(extension.GPU_DISJOINT_EXT);
      const elapsedNs = ready && !disjoint ? extension.getQueryObjectEXT(query, extension.QUERY_RESULT_EXT) : null;
      extension.deleteQueryEXT(query);
      return { elapsedNs, status: !ready ? 'unavailable' : disjoint ? 'disjoint' : 'measured' };
    };
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 220;
    canvas.style.cssText = 'width: 200px; height: 220px'; document.body.append(canvas);
    const rendererInitStart = performance.now();
    const device = new WebGLDevice(canvas, { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, checkGLErrors: true });
    const meshes = new MeshRenderer(device, { maxMeshes: 4, maxInstances: 1024 });
    const rendererInitializationMs = performance.now() - rendererInitStart;
    const coldStart = performance.now(), asset = createSeedScout(meshes), initializationMs = performance.now() - coldStart;
    const resourceCreationStats = meshes.stats();
    const player = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    const projection = [2 / 200, 0, 0, 0, -2 / 220, 0, -1, 1, 1];
    const paint = (actors = [player], timeMs = 0) => {
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1], clearDepth: 1, clearStencil: 0 });
      meshes.beginFrame();
      for (const actor of actors) { actor.seek(timeMs); actor.draw({ projection }); }
      meshes.flush(); device.endFrame();
      return { mesh: meshes.stats(), device: { ...device.stats }, glError: device.gl.getError() };
    };
    const pixel = (x, y) => { const data = new Uint8Array(4); device.gl.readPixels(x, 219 - y, 1, 1, device.gl.RGBA, device.gl.UNSIGNED_BYTE, data); return [...data]; };
    const initialFrame = paint();
    const bodyPixel = pixel(100, 112), holePixel = pixel(80, 48), background = [223, 232, 204, 255];
    assertThat(bodyPixel[1] > 100 && bodyPixel[0] < background[0] && bodyPixel[0] > 60, `SVG body color reaches WebGL pixels: ${bodyPixel}`);
    player.setPartVisible('leaf-left', false); paint(); const underHolePixel = pixel(80, 48); player.setPartVisible('leaf-left', true);
    assertThat(holePixel.every((channel, index) => Math.abs(channel - underHolePixel[index]) <= 2), `evenodd compound leaf hole matches its visible under-layer: ${holePixel}/${underHolePixel}`);
    assertThat(initialFrame.glError === 0 && initialFrame.device.drawCalls >= 1, 'real WebGL draw and GL error check');
    assertThat(initialFrame.mesh.geometryUploads === 0 && initialFrame.mesh.geometryBytesUploaded === 0, 'asset geometry was uploaded only at resource creation');
    assertThat(asset.mesh.byteLength > 100_000 && meshes.stats().meshCount === 1, 'one retained static SVG geometry handle');
    assertThat(near(player.getSocket('mouth').x, 100) && near(player.getSocket('mouth').y, 146), 'authored socket at SVG coordinates');

    const firstPose = player.seek(375).getPartPose('body');
    player.seek(900); const rollbackPose = player.seek(375).getPartPose('body');
    assertThat(JSON.stringify(firstPose) === JSON.stringify(rollbackPose), 'same absolute clip time reproduces exactly the same pose after rollback seek');
    player.transitionTo('bounce', 1000, 200); const transition = player.seek(1100).getPartPose('body');
    player.seek(1400); const transitionRollback = player.seek(1100).getPartPose('body');
    assertThat(JSON.stringify(transition) === JSON.stringify(transitionRollback), 'clip transition is deterministic under seek rollback');
    player.seek(300);
    const transformedSocket = player.getSocket('mouth');
    assertThat(!near(transformedSocket.y, 146), 'part rotation/scale/translation transforms visual socket');
    player.setExpression('happy');
    assertThat(player.currentExpression === 'happy' && !player.getPartPose('face-neutral').visible && player.getPartPose('face-happy').visible, 'expression variants toggle SVG-authored groups');
    player.setExpression('neutral');
    player.setBasePose('body', { opacity: 1 }); paint([player], 300); const opaqueShellPixel = pixel(100, 90);
    player.setBasePose('body', { opacity: 0.5 });
    const fadedChild = player.partPoses().find(part => part.index === seedScoutMetadata.parts.findIndex(item => item.id === 'face-neutral'));
    assertThat(near(fadedChild.opacity, 0.5 * player.getPartPose('body').opacity), 'parent part opacity composes into descendant parts');
    paint([player], 300); const fadedShellPixel = pixel(100, 90);
    assertThat(fadedShellPixel.some((channel, index) => Math.abs(channel - opaqueShellPixel[index]) > 2), `per-part opacity changes actual WebGL pixels: ${opaqueShellPixel}/${fadedShellPixel}`);
    player.setPartVisible('body', false);
    assertThat(!player.getPartPose('face-neutral').visible, 'parent visibility hides descendants');
    player.setPartVisible('body', true); player.setBasePose('body', { opacity: 1 });

    const coldMetrics = { initializationMs, retainedGeometryBytes: asset.mesh.byteLength, sourceSha256: asset.sourceSha256,
      partCount: seedScoutMetadata.parts.length, instanceUploadsPerActor: initialFrame.mesh.instanceBytesUploaded,
      geometryUploadsAtCreate: resourceCreationStats.geometryUploads, geometryUploadBytesAtCreate: resourceCreationStats.geometryBytesUploaded, gpuBufferBytes: device.stats.gpuBufferBytes,
      gpuDrawCalls: initialFrame.device.drawCalls, rendererInitializationMs, gpuTimerExtension: Boolean(device.gl.getExtension('EXT_disjoint_timer_query')),
      backend: device.instancingSupported ? 'ANGLE_instanced_arrays' : 'uniform-per-actor',
      viewportCss: [innerWidth, innerHeight], socket: player.getSocket('mouth') };
    const warmFrame = paint([player], 400);
    assertThat(warmFrame.mesh.geometryUploads === 0 && warmFrame.mesh.geometryBytesUploaded === 0 && warmFrame.glError === 0, 'warm frame does not upload geometry');

    const benchmark = [];
    for (const count of [100, 400]) {
      const createStart = performance.now();
      const actors = Array.from({ length: count }, () => asset.createPlayer({ clip: 'idle', startedAtMs: 0 }));
      const createMs = performance.now() - createStart;
      actors[0].seek(300); actors[1].seek(300);
      const sharedPoseState = JSON.stringify(actors[0].partPoses()) === JSON.stringify(actors[1].partPoses());
      const matrices = actors.map((_, i) => [0.045, 0, 0, 0.045, 8 + (i % 20) * 9, 7 + Math.floor(i / 20) * 10]);
      let cpuStart = performance.now();
      const coldQuery = beginGpuQuery(device);
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
      for (let i = 0; i < count; i++) { actors[i].seek(300); actors[i].draw({ projection, matrix: matrices[i] }); }
      const submitCpuMs = performance.now() - cpuStart;
      meshes.flush(); device.endFrame();
      const coldGpuTimeNs = endGpuQuery(device, coldQuery);
      const firstDraw = { ...meshes.stats() }, firstDevice = { ...device.stats };
      cpuStart = performance.now();
      const warmQuery = beginGpuQuery(device);
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
      for (let i = 0; i < count; i++) { actors[i].seek(450); actors[i].draw({ projection, matrix: matrices[i] }); }
      const warmCpuMs = performance.now() - cpuStart;
      meshes.flush(); device.endFrame();
      const warmGpuTimeNs = endGpuQuery(device, warmQuery);
      const warm = { ...meshes.stats() }, warmDevice = { ...device.stats };
      assertThat(warmDevice.drawCalls === (device.instancingSupported ? 1 : count), `retained actors should batch by shared pose (${count}): ${warmDevice.drawCalls} draws`);
      benchmark.push({ actors: count, playerInitMs: createMs, cpuSubmitMs: submitCpuMs, warmCpuSubmitMs: warmCpuMs,
        sharedPoseState, gpuTimerCold: coldGpuTimeNs, gpuTimerWarm: warmGpuTimeNs,
        geometryBytes: asset.mesh.byteLength, geometryUploadBytesCold: firstDraw.geometryBytesUploaded,
        instanceUploadBytesCold: firstDraw.instanceBytesUploaded, instanceUploadBytesWarm: warm.instanceBytesUploaded,
        partUniformBytesSubmitted: warm.partUniformBytesSubmitted, drawsCold: firstDevice.drawCalls, drawsWarm: warmDevice.drawCalls,
        totalGpuBufferBytes: warmDevice.gpuBufferBytes, rendererStagingBytes: warm.stagingBytes,
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null });
      for (const actor of actors) actor.dispose();
    }

    const expressionTargets = new Set(Object.values(seedScoutMetadata.expressions).flatMap(item => [...item.show, ...item.hide]));
    const expressionVisible = new Set(seedScoutMetadata.expressions[seedScoutMetadata.defaultExpression].show);
    const visibleSourcePaths = sourcePaths.filter(path => !expressionTargets.has(path.part) || expressionVisible.has(path.part));
    const pathPipelineBenchmark = [];
    for (const count of [100, 400]) {
      const pathCanvas = document.createElement('canvas'); pathCanvas.width = 200; pathCanvas.height = 220;
      const pathStart = performance.now();
      const pathDevice = new WebGLDevice(pathCanvas, { alpha: false, antialias: false, depth: false, stencil: false });
      const context = new VectorContext(pathDevice, { initialVertices: 16384, maxVertices: 524288 });
      const initializeMs = performance.now() - pathStart;
      const columns = 20, actorScale = 0.045;
      const started = performance.now();
      const pathQuery = beginGpuQuery(pathDevice);
      context.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] });
      for (let actorIndex = 0; actorIndex < count; actorIndex++) {
        const x = 8 + (actorIndex % columns) * 9, y = 7 + Math.floor(actorIndex / columns) * 10;
        context.save(); context.setTransform(actorScale, 0, 0, actorScale, x, y);
        for (const path of visibleSourcePaths) {
          context.beginPath();
          for (const subpath of path.subpaths) {
            if (!subpath.points.length) continue;
            context.moveTo(...subpath.points[0]);
            for (let pointIndex = 1; pointIndex < subpath.points.length; pointIndex++) context.lineTo(...subpath.points[pointIndex]);
            if (subpath.closed) context.closePath();
          }
          if (path.fill !== 'none' && path.fillOpacity * path.opacity > 0) {
            context.fillStyle = path.fill; context.globalAlpha = path.fillOpacity * path.opacity; context.fill(path.fillRule);
          }
          if (path.stroke !== 'none' && path.strokeWidth > 0 && path.strokeOpacity * path.opacity > 0) {
            context.strokeStyle = path.stroke; context.lineWidth = path.strokeWidth; context.lineCap = path.strokeLineCap;
            context.lineJoin = path.strokeLineJoin; context.miterLimit = path.strokeMiterLimit;
            context.globalAlpha = path.strokeOpacity * path.opacity; context.stroke();
          }
        }
        context.restore();
      }
      const pathStats = context.endFrame(), pathCpuMs = performance.now() - started, pathDeviceStats = { ...pathDevice.stats };
      const pathGpuTimer = endGpuQuery(pathDevice, pathQuery);
      const uploadedBytes = pathStats.uploadedBytes, drawCalls = pathStats.drawCalls;
      context.dispose(); pathDevice.dispose();
      pathPipelineBenchmark.push({ actors: count, rendererInitializationMs: initializeMs, cpuSubmitAndTessellateMs: pathCpuMs, gpuTimer: pathGpuTimer,
        uploadsBytes: uploadedBytes, drawCalls, vertices: pathStats.vertices, stagingBytes: pathStats.stagingBytes,
        gpuBufferBytes: pathStats.gpuBufferBytes, bufferUploads: pathDeviceStats.bufferUploads, sourcePathsPerActor: visibleSourcePaths.length });
      pathCanvas.remove();
    }

    const oldMeshCount = meshes.stats().meshCount, oldBufferBytes = device.stats.gpuBufferBytes;
    const disposedPlayer = player; assertThat(disposedPlayer.dispose(), 'player disposes once');
    assertThat(asset.dispose() && !asset.dispose(), 'asset disposes idempotently');
    assertThat(meshes.stats().meshCount === oldMeshCount - 1 && meshes.stats().retainedBytes === 0, 'asset disposal releases exactly its retained geometry');
    assertThat(device.stats.gpuBufferBytes < oldBufferBytes, 'GPU buffer storage drops after asset disposal');
    const replacement = createSeedScout(meshes), replacementPlayer = replacement.createPlayer();
    paint([replacementPlayer], 0);
    assertThat(meshes.stats().meshCount === 1 && device.gl.getError() === 0, 'dispose and recreate renders again on the same renderer/device');
    replacementPlayer.dispose(); replacement.dispose(); meshes.dispose(); device.dispose(); canvas.remove();
    return { status: 'PASS', sourceSha256: asset.sourceSha256, coldMetrics, warm: { geometryUploads: warmFrame.mesh.geometryUploads, geometryBytesUploaded: warmFrame.mesh.geometryBytesUploaded },
      benchmark: { svgLoaderCompileMs: threeCompileMs, retainedMeshInstances: benchmark, vectorContextPerFramePathTessellation: pathPipelineBenchmark,
        threeBasedProcessing: { svgLoader: 'Three SVGLoader build-time only', runtimeRenderer: 'not introduced', outputGeometryBytes: asset.mesh.byteLength,
          gpuPath: 'same retained GameKit MeshRenderer mesh; see retainedMeshInstances (compiled source mesh uploaded once)' } },
      checks: ['WebGL1 real draw and zero GL error', 'evenodd hole and stroke/pixel color', 'SVG metadata pivots and sockets', 'part hierarchy visibility and opacity',
        'neutral/happy expression group variants', 'clip switch and repeat seek after rollback', 'transition seek after rollback', 'dispose and recreate', 'mobile landscape viewport'] };
  }, { sourcePaths: referenceAsset.sourcePaths, threeCompileMs });
  assert.equal(report.status, 'PASS');
  assert.equal(report.benchmark.retainedMeshInstances.length, 2);
  assert.equal(report.benchmark.vectorContextPerFramePathTessellation.length, 2);
  for (const row of [...report.benchmark.retainedMeshInstances, ...report.benchmark.vectorContextPerFramePathTessellation]) assert.ok(row.actors === 100 || row.actors === 400);
  report.threeViewExample = panelState;
  report.checks.unshift('same authored SVG source SHA and pose across original/source, compiled triangle topology, and GameKit WebGL panels; shared time/expression/zoom/pan; mobile landscape layout');
  return report;
}

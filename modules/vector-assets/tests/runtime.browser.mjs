import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileVectorAssetFile } from '../compiler.js';

/** Exercises the compiled SVG through GameKit's real WebGL1 device and retained mesh renderer. */
export async function exerciseVectorAssets(page, { includePopulationTimingDiagnostics = false } = {}) {
  const compileStart = performance.now();
  const referenceAsset = await compileVectorAssetFile('modules/vector-assets/assets/seed-scout.svg', 'modules/vector-assets/assets/seed-scout.svg');
  const legacyReferenceAsset = await compileVectorAssetFile('modules/vector-assets/assets/seed-scout.svg', 'modules/vector-assets/assets/seed-scout.svg',
    { curveSegments: 16, strokeArcDivisions: 12 });
  const retainedBytes = asset => asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength
    + [...Object.values(asset.geometry.expressionIndices ?? {}), ...Object.values(asset.geometry.indexVariants ?? {})]
      .reduce((total, indices) => total + indices.byteLength, 0);
  const standardMeshBytes = retainedBytes(referenceAsset), legacyMeshBytes = retainedBytes(legacyReferenceAsset);
  assert.ok(standardMeshBytes > 0 && standardMeshBytes < legacyMeshBytes,
    'the same seed-scout fixture produces valid 4/2 geometry smaller than explicit 16/12 geometry');
  const threeCompileMs = performance.now() - compileStart;
  await page.setViewportSize({ width: 844, height: 390 });
  const panelState = await page.evaluate(async () => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await waitFrame(); await waitFrame();
    const demo = window.vectorAssetDemo;
    const fail = message => { throw new Error('Three-view example: ' + message); };
    if (!demo?.ready || !demo.asset || !demo.actor) fail('SVG source and WebGL resources did not finish loading');
    const submittedVariants = [];
    const drawMesh = demo.meshes.drawMesh.bind(demo.meshes);
    demo.meshes.drawMesh = (mesh, options) => { submittedVariants.push(options?.indexVariant ?? null); return drawMesh(mesh, options); };
    const clip = document.querySelector('#clip'), time = document.querySelector('#time');
    const expression = document.querySelector('#expression'), zoom = document.querySelector('#zoom');
    clip.value = 'bounce'; clip.dispatchEvent(new Event('change', { bubbles: true }));
    time.value = '220'; time.dispatchEvent(new Event('input', { bubbles: true }));
    expression.value = 'happy'; expression.dispatchEvent(new Event('change', { bubbles: true }));
    zoom.value = '1.50'; zoom.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#play-toggle').click();
    await waitFrame(); await waitFrame();
    const expressionIndexVariantUsed = submittedVariants.includes('happy');
    demo.actor.setPartVisible('face-happy', false);
    await waitFrame();
    const explicitVisibilityUsesFullGeometry = submittedVariants.at(-1) === null;
    demo.actor.setExpression('happy');
    await waitFrame();
    const expressionVariantRestoredAfterOverride = submittedVariants.at(-1) === 'happy';
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
      expressionIndexVariantUsed, explicitVisibilityUsesFullGeometry, expressionVariantRestoredAfterOverride,
      triangles: demo.topology.triangles, compiledTriangles: demo.asset.mesh.indices.length / 3,
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
  assert.equal(panelState.expressionIndexVariantUsed, true, 'authored expressions select their prefiltered retained triangle indices');
  assert.equal(panelState.explicitVisibilityUsesFullGeometry, true, 'explicit per-part visibility keeps the unfiltered geometry path');
  assert.equal(panelState.expressionVariantRestoredAfterOverride, true, 'selecting a new expression restores the matching index variant');
  assert.equal(panelState.triangles, panelState.compiledTriangles);
  assert.ok(panelState.visibleTriangles > 0 && panelState.visibleTriangles < panelState.triangles);
  assert.ok(panelState.uniqueEdges > panelState.triangles);
  assert.match(panelState.webglBackend, /^WebGL 1/);
  assert.ok(panelState.drawCalls > 0 && panelState.meshBytes === standardMeshBytes && panelState.meshBytes < legacyMeshBytes,
    'the three-view example retains the same valid 4/2 geometry measured from its source');
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
  const report = await page.evaluate(async ({ sourcePaths, threeCompileMs, includePopulationTimingDiagnostics, standardMeshBytes, legacyMeshBytes }) => {
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
    const staticPartPoses = player.partPoses();
    assertThat(staticPartPoses.every(pose => Array.isArray(pose.morph) && pose.morph.length === 2
      && pose.morph[0] === 0 && pose.morph[1] === 0), 'styleless assets preserve the public two-weight part pose with default zero morph values');
    assertThat(staticPartPoses.every((pose, index) => index === 0 || pose.morph !== staticPartPoses[0].morph)
      && !Object.isFrozen(staticPartPoses[0].morph),
      'public styleless part poses keep independent mutable zero-morph tuples');
    const projection = [2 / 200, 0, 0, 0, -2 / 220, 0, -1, 1, 1];
    const paint = (actors = [player], timeMs = 0) => {
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1], clearDepth: 1, clearStencil: 0 });
      meshes.beginFrame();
      for (const actor of actors) { actor.seek(timeMs); actor.draw({ projection }); }
      meshes.flush(); device.endFrame();
      return { mesh: meshes.stats(), device: { ...device.stats }, glError: device.gl.getError() };
    };
    const pixel = (x, y) => { const data = new Uint8Array(4); device.gl.readPixels(x, 219 - y, 1, 1, device.gl.RGBA, device.gl.UNSIGNED_BYTE, data); return [...data]; };
    const originalDrawMesh = meshes.drawMesh;
    let submittedParts, submittedMorph;
    meshes.drawMesh = function(mesh, options) {
      submittedParts = options.parts; submittedMorph = options.morph;
      return originalDrawMesh.call(this, mesh, options);
    };
    const initialFrame = paint();
    meshes.drawMesh = originalDrawMesh;
    assertThat(submittedParts?.every(pose => !Object.hasOwn(pose, 'morph'))
      && Array.isArray(submittedMorph) && submittedMorph[0] === 0 && submittedMorph[1] === 0,
      'render-only part poses omit discarded per-part morph arrays and retain the draw-level morph value');
    console.log('VECTOR_STAGE initial-frame');
    const bodyPixel = pixel(100, 112), holePixel = pixel(80, 48), background = [223, 232, 204, 255];
    assertThat(bodyPixel[1] > 100 && bodyPixel[0] < background[0] && bodyPixel[0] > 60, `SVG body color reaches WebGL pixels: ${bodyPixel}`);
    player.setPartVisible('leaf-left', false); paint(); const underHolePixel = pixel(80, 48); player.setPartVisible('leaf-left', true);
    assertThat(holePixel.every((channel, index) => Math.abs(channel - underHolePixel[index]) <= 2), `evenodd compound leaf hole matches its visible under-layer: ${holePixel}/${underHolePixel}`);
    assertThat(initialFrame.glError === 0 && initialFrame.device.drawCalls >= 1, 'real WebGL draw and GL error check');
    assertThat(initialFrame.mesh.geometryUploads === 0 && initialFrame.mesh.geometryBytesUploaded === 0, 'asset geometry was uploaded only at resource creation');
    assertThat(asset.mesh.byteLength === standardMeshBytes && asset.mesh.byteLength > 0 && asset.mesh.byteLength < legacyMeshBytes
      && meshes.stats().meshCount === 1, 'the bundled fixture retains valid default geometry smaller than explicit 16/12');
    assertThat(near(player.getSocket('mouth').x, 100) && near(player.getSocket('mouth').y, 146), 'authored socket at SVG coordinates');

    const beforeFailedCreate = { bytes: device.stats.gpuBufferBytes, retained: meshes.stats().retainedBytes, meshes: meshes.stats().meshCount };
    const uploadIndices = device.uploadIndices;
    let indexUploads = 0, failedCreate = null;
    device.uploadIndices = function(buffer, indices) {
      indexUploads++;
      if (indexUploads === 2) throw new Error('injected expression index upload failure');
      return uploadIndices.call(this, buffer, indices);
    };
    const geometryInput = {
      vertices: asset.mesh.vertices, strideFloats: 11, partCount: asset.mesh.partCount, morphCount: asset.mesh.morphCount,
      indices: asset.mesh.indices,
      expressionIndices: Object.fromEntries([...asset.mesh.expressionIndices].map(([name, variant]) => [name, variant.indices])),
    };
    try { meshes.createMesh(geometryInput); } catch (error) { failedCreate = error; }
    finally { device.uploadIndices = uploadIndices; }
    assertThat(failedCreate?.message === 'injected expression index upload failure', 'expression index upload failure reaches the caller');
    assertThat(device.stats.gpuBufferBytes === beforeFailedCreate.bytes && meshes.stats().retainedBytes === beforeFailedCreate.retained
      && meshes.stats().meshCount === beforeFailedCreate.meshes, 'failed expression index upload releases every partial GPU allocation');
    let nullVariantsRejected = false;
    try { meshes.createMesh({ ...geometryInput, expressionIndices: null }); } catch (error) { nullVariantsRejected = /triangles/.test(error.message); }
    assertThat(nullVariantsRejected, 'an explicit null expression index map is rejected instead of silently treated as absent');

    player.seek(0);
    const expandedVertices = new Float32Array(asset.mesh.indices.length * 11);
    for (let i = 0; i < asset.mesh.indices.length; i++) expandedVertices.set(asset.mesh.vertices.subarray(asset.mesh.indices[i] * 11, asset.mesh.indices[i] * 11 + 11), i * 11);
    const expandedMesh = meshes.createMesh({ vertices: expandedVertices, strideFloats: 11, partCount: asset.mesh.partCount, morphCount: asset.mesh.morphCount });
    const actorParts = player.partPoses().map(({ transform, opacity, visible }) => ({ transform, opacity, visible }));
    const capture = mesh => {
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
      meshes.drawMesh(mesh, { projection, parts: actorParts }); meshes.flush(); device.endFrame();
      const pixels = new Uint8Array(200 * 220 * 4); device.gl.readPixels(0, 0, 200, 220, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixels);
      return { pixels, glError: device.gl.getError() };
    };
    const indexedCapture = capture(asset.mesh), expandedCapture = capture(expandedMesh);
    let pixelMismatch = 0;
    for (let i = 0; i < indexedCapture.pixels.length; i++) if (indexedCapture.pixels[i] !== expandedCapture.pixels[i]) pixelMismatch++;
    assertThat(indexedCapture.glError === 0 && expandedCapture.glError === 0 && pixelMismatch === 0,
      `indexed and expanded retained geometry render the same pixels (${pixelMismatch} channel differences)`);
    const indexedParity = { pixelMismatch, indexedBytes: asset.mesh.byteLength, expandedBytes: expandedVertices.byteLength,
      savedBytes: expandedVertices.byteLength - asset.mesh.byteLength };
    meshes.deleteMesh(expandedMesh);

    const firstPose = player.seek(375).getPartPose('body');
    player.seek(900); const rollbackPose = player.seek(375).getPartPose('body');
    assertThat(JSON.stringify(firstPose) === JSON.stringify(rollbackPose), 'same absolute clip time reproduces exactly the same pose after rollback seek');
    player.transitionTo('bounce', 1000, 200); const transition = player.seek(1100).getPartPose('body');
    player.seek(1400); const transitionRollback = player.seek(1100).getPartPose('body');
    assertThat(JSON.stringify(transition) === JSON.stringify(transitionRollback), 'clip transition is deterministic under seek rollback');
    const mapConstructionsDuring = callback => {
      const NativeMap = window.Map;
      let constructions = 0;
      window.Map = class CountingMap extends NativeMap {
        constructor(...args) { constructions++; super(...args); }
      };
      try { callback(); return constructions; }
      finally { window.Map = NativeMap; }
    };
    const boundaryPlayer = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    const idleAtStart = asset.createPlayer({ clip: 'idle', startedAtMs: 0 }).seek(1000).getPartPose('body');
    const bounceAtStart = asset.createPlayer({ clip: 'bounce', startedAtMs: 1000 }).seek(1000).getPartPose('body');
    const idleProbe = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    const bounceProbe = asset.createPlayer({ clip: 'bounce', startedAtMs: 1000 });
    boundaryPlayer.transitionTo('bounce', 1000, 200);
    const directSourceMaps = mapConstructionsDuring(() => idleProbe.seek(1100));
    const directTargetMaps = mapConstructionsDuring(() => bounceProbe.seek(1100));
    const beforeStartMaps = mapConstructionsDuring(() => boundaryPlayer.seek(999));
    const atStartMaps = mapConstructionsDuring(() => boundaryPlayer.seek(1000));
    const activeTransitionMaps = mapConstructionsDuring(() => boundaryPlayer.seek(1100));
    const completedTransitionMaps = mapConstructionsDuring(() => boundaryPlayer.seek(1200));
    const beforeTransition = boundaryPlayer.seek(999).getPartPose('body');
    const atTransitionStart = boundaryPlayer.seek(1000).getPartPose('body');
    const atTransitionEnd = boundaryPlayer.seek(1200).getPartPose('body');
    assertThat(beforeStartMaps === directSourceMaps, `a transition before its start samples only its source (${beforeStartMaps} vs ${directSourceMaps} Map constructions)`);
    assertThat(atStartMaps === directSourceMaps, `a positive-duration transition samples only its source at the zero-progress start boundary (${atStartMaps} vs ${directSourceMaps} Map constructions)`);
    assertThat(activeTransitionMaps === directSourceMaps + directTargetMaps + 1,
      `an active transition samples both clips and allocates one blended pose map (${activeTransitionMaps} constructions)`);
    assertThat(completedTransitionMaps === directTargetMaps, `a completed transition samples only its target (${completedTransitionMaps} vs ${directTargetMaps} Map constructions)`);
    assertThat(JSON.stringify(beforeTransition) === JSON.stringify(idleAtStart), 'a transition samples only its source before the start time');
    assertThat(JSON.stringify(atTransitionStart) === JSON.stringify(idleAtStart), 'a transition begins at its source pose exactly at the start boundary');
    assertThat(JSON.stringify(atTransitionEnd) === JSON.stringify(bounceAtStart), 'a completed transition returns its target pose exactly at the end boundary');
    const zeroDurationPlayer = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    zeroDurationPlayer.transitionTo('bounce', 1000, 0);
    assertThat(JSON.stringify(zeroDurationPlayer.seek(999).getPartPose('body')) === JSON.stringify(idleAtStart), 'a zero-duration transition keeps its source before its start');
    assertThat(mapConstructionsDuring(() => zeroDurationPlayer.seek(1000)) === directTargetMaps, 'a zero-duration transition samples only its target at the start boundary');
    assertThat(JSON.stringify(zeroDurationPlayer.seek(1000).getPartPose('body')) === JSON.stringify(bounceAtStart), 'a zero-duration transition selects its target at the start boundary');

    const overlappingPlayer = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    overlappingPlayer.transitionTo('bounce', 1000, 200);
    overlappingPlayer.transitionTo('idle', 1150, 200);
    overlappingPlayer.transitionTo('bounce', 1250, 0);
    const overlappingTimes = [1125, 1175, 1249, 1250, 1275, 1350];
    const overlappingForward = overlappingTimes.map(time => JSON.stringify(overlappingPlayer.seek(time).getPartPose('body')));
    overlappingPlayer.seek(3000);
    const overlappingBackward = overlappingTimes.map(time => JSON.stringify(overlappingPlayer.seek(time).getPartPose('body')));
    assertThat(JSON.stringify(overlappingForward) === JSON.stringify(overlappingBackward), 'overlapping and completed transitions retain deterministic backward seeks across their full history');

    const simpleSamplingProbe = asset.createPlayer({ clip: 'bounce', startedAtMs: 0 });
    const completedChainProbe = asset.createPlayer({ clip: 'idle', startedAtMs: 0 });
    for (let index = 0; index < 16; index++) {
      completedChainProbe.transitionTo(index % 2 ? 'idle' : 'bounce', 1000 + index * 300, 100);
    }
    const settledTime = 1000 + 15 * 300 + 500;
    const simpleSeekMapConstructions = mapConstructionsDuring(() => simpleSamplingProbe.seek(settledTime));
    const completedChainMapConstructions = mapConstructionsDuring(() => completedChainProbe.seek(settledTime));
    assertThat(completedChainMapConstructions === simpleSeekMapConstructions,
      `a settled 16-transition playback chain samples its target with the same Map construction count as one direct clip (${completedChainMapConstructions} vs ${simpleSeekMapConstructions})`);
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
      const createStart = includePopulationTimingDiagnostics ? performance.now() : null;
      const actors = Array.from({ length: count }, () => asset.createPlayer({ clip: 'idle', startedAtMs: 0 }));
      const createMs = createStart === null ? null : performance.now() - createStart;
      actors[0].seek(300); actors[1].seek(300);
      const sharedPoseState = JSON.stringify(actors[0].partPoses()) === JSON.stringify(actors[1].partPoses());
      const matrices = actors.map((_, i) => [0.045, 0, 0, 0.045, 8 + (i % 20) * 9, 7 + Math.floor(i / 20) * 10]);
      let cpuStart = includePopulationTimingDiagnostics ? performance.now() : null;
      const coldQuery = includePopulationTimingDiagnostics ? beginGpuQuery(device) : null;
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
      for (let i = 0; i < count; i++) { actors[i].seek(300); actors[i].draw({ projection, matrix: matrices[i] }); }
      const submitCpuMs = cpuStart === null ? null : performance.now() - cpuStart;
      meshes.flush(); device.endFrame();
      const coldGpuTimeNs = includePopulationTimingDiagnostics ? endGpuQuery(device, coldQuery) : null;
      const firstDraw = { ...meshes.stats() }, firstDevice = { ...device.stats };
      cpuStart = includePopulationTimingDiagnostics ? performance.now() : null;
      const warmQuery = includePopulationTimingDiagnostics ? beginGpuQuery(device) : null;
      device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
      for (let i = 0; i < count; i++) { actors[i].seek(450); actors[i].draw({ projection, matrix: matrices[i] }); }
      const warmCpuMs = cpuStart === null ? null : performance.now() - cpuStart;
      meshes.flush(); device.endFrame();
      const warmGpuTimeNs = includePopulationTimingDiagnostics ? endGpuQuery(device, warmQuery) : null;
      const warm = { ...meshes.stats() }, warmDevice = { ...device.stats };
      assertThat(warmDevice.drawCalls === (device.instancingSupported ? 1 : count), `retained actors should batch by shared pose (${count}): ${warmDevice.drawCalls} draws`);
      benchmark.push({ actors: count, ...(includePopulationTimingDiagnostics ? {
        playerInitMs: createMs, cpuSubmitMs: submitCpuMs, warmCpuSubmitMs: warmCpuMs,
        gpuTimerCold: coldGpuTimeNs, gpuTimerWarm: warmGpuTimeNs,
        jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
      } : {}),
        sharedPoseState,
        geometryBytes: asset.mesh.byteLength, geometryUploadBytesCold: firstDraw.geometryBytesUploaded,
        instanceUploadBytesCold: firstDraw.instanceBytesUploaded, instanceUploadBytesWarm: warm.instanceBytesUploaded,
        partUniformBytesSubmitted: warm.partUniformBytesSubmitted, drawsCold: firstDevice.drawCalls, drawsWarm: warmDevice.drawCalls,
        totalGpuBufferBytes: warmDevice.gpuBufferBytes, rendererStagingBytes: warm.stagingBytes });
      for (const actor of actors) actor.dispose();
    }

    const independentAnimationActors = [];
    for (const count of [100, 400]) {
      const clips = Object.keys(seedScoutMetadata.clips), expressions = Object.keys(seedScoutMetadata.expressions);
      const groupCounts = new Map(clips.map(clip => [clip, Array.from({ length: count }, (_, i) => clips[i % clips.length]).filter(name => name === clip).length]));
      const groupIndices = new Map(clips.map(clip => [clip, 0]));
      const createStart = includePopulationTimingDiagnostics ? performance.now() : null;
      const actors = Array.from({ length: count }, (_, index) => {
        const clip = clips[index % clips.length], ordinal = groupIndices.get(clip), groupCount = groupCounts.get(clip);
        groupIndices.set(clip, ordinal + 1);
        const durationMs = seedScoutMetadata.clips[clip].durationMs;
        const phaseSpanMs = Math.max(1, durationMs / 3 - 32);
        const phaseMs = (ordinal + 0.5) * phaseSpanMs / groupCount;
        const actor = asset.createPlayer({ clip, startedAtMs: 1000 - phaseMs });
        actor.setExpression(expressions[index % expressions.length]);
        return actor;
      });
      const createMs = createStart === null ? null : performance.now() - createStart;
      const matrices = actors.map((_, i) => [0.045, 0, 0, 0.045, 8 + (i % 20) * 9, 7 + Math.floor(i / 20) * 10]);
      const frames = [];
      const poseStates = [];
      let distinctPoseCount = 0;
      for (const displayTimeMs of [1000, 1016]) {
        for (const actor of actors) actor.seek(displayTimeMs);
        const poseKeys = new Map(), duplicatePoseIndices = [];
        poseStates.push(JSON.stringify(actors.map(actor => actor.partPoses())));
        actors.forEach((actor, index) => {
          const signature = JSON.stringify(actor.partPoses()), earlier = poseKeys.get(signature);
          if (earlier === undefined) poseKeys.set(signature, index);
          else duplicatePoseIndices.push([earlier, index]);
        });
        distinctPoseCount = Math.min(distinctPoseCount || count, poseKeys.size);
        const cpuStart = includePopulationTimingDiagnostics ? performance.now() : null;
        const query = includePopulationTimingDiagnostics ? beginGpuQuery(device) : null;
        device.beginFrame({ width: 200, height: 220, clearColor: [0.875, 0.91, 0.80, 1] }); meshes.beginFrame();
        for (let i = 0; i < count; i++) actors[i].draw({ projection, matrix: matrices[i] });
        const cpuSubmitMs = cpuStart === null ? null : performance.now() - cpuStart;
        meshes.flush(); device.endFrame();
        const gpuTime = includePopulationTimingDiagnostics ? endGpuQuery(device, query) : null;
        const meshStats = { ...meshes.stats() }, deviceStats = { ...device.stats }, glError = device.gl.getError();
        assertThat(poseKeys.size === count, `independent clip/phase/expression fixture must produce ${count} unique part poses at ${displayTimeMs}: ${poseKeys.size}; duplicates=${JSON.stringify(duplicatePoseIndices)}`);
        assertThat(meshStats.draws === count && deviceStats.drawCalls === count && meshStats.geometryUploads === 0 && meshStats.geometryBytesUploaded === 0,
          `independent ${count}-actor poses should submit one retained mesh draw each without frame geometry uploads: ${meshStats.draws}`);
        frames.push({ displayTimeMs, ...(includePopulationTimingDiagnostics ? { cpuSubmitMs, gpuTimer: gpuTime } : {}), draws: meshStats.draws, instances: meshStats.instances,
          geometryUploads: meshStats.geometryUploads, geometryBytesUploaded: meshStats.geometryBytesUploaded,
          instanceBytesUploaded: meshStats.instanceBytesUploaded, partUniformBytesSubmitted: meshStats.partUniformBytesSubmitted,
          glError });
        assertThat(glError === 0, `independent ${count}-actor frame has no WebGL error`);
      }
      for (const actor of actors) actor.seek(1000);
      assertThat(JSON.stringify(actors.map(actor => actor.partPoses())) === poseStates[0],
        `independent ${count}-actor clip/phase/expression poses reproduce after a rollback seek`);
      independentAnimationActors.push({ actors: count, ...(includePopulationTimingDiagnostics ? { playerInitMs: createMs } : {}), clips: clips.map(name => ({ name, count: groupCounts.get(name) })),
        expressionCount: expressions.length, distinctPoseCount, frames });
      for (const actor of actors) actor.dispose();
    }

    player.setExpression('happy');
    const drawMesh = meshes.drawMesh;
    const observedVariants = [];
    meshes.drawMesh = (mesh, options) => { observedVariants.push(options.indexVariant); return drawMesh.call(meshes, mesh, options); };
    const poseAt375 = player.seek(375).getPartPose('body').transform;
    paint([player], 375);
    const poseAt700 = player.seek(700).getPartPose('body').transform;
    paint([player], 700);
    assertThat(JSON.stringify(poseAt375) !== JSON.stringify(poseAt700), 'absolute seek changes the authored animated pose');
    assertThat(observedVariants.length === 2 && observedVariants.every(name => name === 'happy'),
      'seek and clip animation keep selecting the same authored expression indices');
    observedVariants.length = 0;
    const beforeRestore = paint([player], 375);
    const pixelsBeforeRestore = new Uint8Array(200 * 220 * 4);
    device.gl.readPixels(0, 0, 200, 220, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixelsBeforeRestore);
    const loss = device.gl.getExtension('WEBGL_lose_context');
    assertThat(Boolean(loss), 'Chromium provides WEBGL_lose_context for expression index restoration coverage');
    const waitForContextEvent = name => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(name + ' did not arrive within 5 seconds')), 5000);
      canvas.addEventListener(name, event => { clearTimeout(timeout); resolve(event); }, { once: true });
    });
    const lost = waitForContextEvent('webglcontextlost');
    loss.loseContext(); await lost;
    assertThat(device.state === 'lost' && meshes.stats().state === 'lost', 'device and retained renderer enter lost state together');
    await new Promise(resolve => setTimeout(resolve, 80));
    const restored = waitForContextEvent('webglcontextrestored');
    loss.restoreContext(); await restored;
    assertThat(device.state === 'ready' && meshes.stats().state === 'ready', 'device and expression index buffers restore together');
    const afterRestore = paint([player], 375);
    const pixelsAfterRestore = new Uint8Array(200 * 220 * 4);
    device.gl.readPixels(0, 0, 200, 220, device.gl.RGBA, device.gl.UNSIGNED_BYTE, pixelsAfterRestore);
    let restorePixelMismatch = 0;
    for (let index = 0; index < pixelsBeforeRestore.length; index++) if (pixelsBeforeRestore[index] !== pixelsAfterRestore[index]) restorePixelMismatch++;
    assertThat(observedVariants.at(-1) === 'happy' && afterRestore.glError === 0 && restorePixelMismatch === 0,
      `restored expression index buffer draws the same pixels (${restorePixelMismatch} channel differences)`);
    meshes.drawMesh = drawMesh;

    const expressionTargets = new Set(Object.values(seedScoutMetadata.expressions).flatMap(item => [...item.show, ...item.hide]));
    const expressionVisible = new Set(seedScoutMetadata.expressions[seedScoutMetadata.defaultExpression].show);
    const visibleSourcePaths = sourcePaths.filter(path => !expressionTargets.has(path.part) || expressionVisible.has(path.part));
    const pathPipelineBenchmark = [];
    if (includePopulationTimingDiagnostics) for (const count of [100, 400]) {
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
    assertThat(oldBufferBytes - device.stats.gpuBufferBytes === asset.mesh.byteLength, 'asset disposal releases base and expression index buffer bytes');
    const replacement = createSeedScout(meshes), replacementPlayer = replacement.createPlayer();
    paint([replacementPlayer], 0);
    assertThat(meshes.stats().meshCount === 1 && device.gl.getError() === 0, 'dispose and recreate renders again on the same renderer/device');
    replacementPlayer.dispose();
    const rendererBuffersBeforeDispose = device.stats.gpuBufferBytes;
    meshes.dispose();
    assertThat(meshes.stats().retainedBytes === 0 && device.stats.gpuBufferBytes === 0,
      `renderer disposal releases every expression buffer (${rendererBuffersBeforeDispose} bytes before disposal)`);
    replacement.dispose(); device.dispose(); canvas.remove();
    return { status: 'PASS', sourceSha256: asset.sourceSha256, coldMetrics, indexedParity, warm: { geometryUploads: warmFrame.mesh.geometryUploads, geometryBytesUploaded: warmFrame.mesh.geometryBytesUploaded },
      benchmark: { timingDiagnosticsEnabled: includePopulationTimingDiagnostics, svgLoaderCompileMs: threeCompileMs, retainedMeshInstances: benchmark, independentAnimationActors,
        vectorContextPerFramePathTessellation: pathPipelineBenchmark,
        threeBasedProcessing: { svgLoader: 'Three SVGLoader build-time only', runtimeRenderer: 'not introduced', outputGeometryBytes: asset.mesh.byteLength,
          gpuPath: 'same retained GameKit MeshRenderer mesh; see retainedMeshInstances (compiled source mesh uploaded once)' } },
      expressionIndexLifecycle: { indexedCreateFailureCleanupBytes: beforeFailedCreate.bytes, seekVariants: observedVariants, contextRestorePixelMismatch: restorePixelMismatch,
        retainedMeshBytesReleased: asset.mesh.byteLength, rendererBufferBytesReleased: rendererBuffersBeforeDispose },
      checks: ['WebGL1 real draw and zero GL error', 'evenodd hole and stroke/pixel color', 'SVG metadata pivots and sockets', 'part hierarchy visibility and opacity',
        'neutral/happy expression group variants', 'expression variants across animated seek and context restore', 'failed expression index allocation cleanup',
        'mesh/renderer disposal releases expression index buffers', 'clip switch and repeat seek after rollback', 'transition seek after rollback', 'dispose and recreate', 'mobile landscape viewport'] };
  }, { sourcePaths: referenceAsset.sourcePaths, threeCompileMs, includePopulationTimingDiagnostics, standardMeshBytes, legacyMeshBytes });
  assert.equal(report.status, 'PASS');
  assert.equal(report.benchmark.timingDiagnosticsEnabled, includePopulationTimingDiagnostics);
  assert.equal(report.benchmark.retainedMeshInstances.length, 2);
  assert.equal(report.benchmark.independentAnimationActors.length, 2);
  assert.equal(report.benchmark.vectorContextPerFramePathTessellation.length, includePopulationTimingDiagnostics ? 2 : 0);
  for (const row of [...report.benchmark.retainedMeshInstances, ...report.benchmark.independentAnimationActors, ...report.benchmark.vectorContextPerFramePathTessellation]) assert.ok(row.actors === 100 || row.actors === 400);
  for (const row of report.benchmark.independentAnimationActors) assert.equal(row.distinctPoseCount, row.actors);
  report.checks.push('100/400 independently phased clips and expression variants remain seek-deterministic, submit one draw per distinct multipart pose, and reuse retained geometry');
  report.threeViewExample = panelState;
  report.checks.unshift('same authored SVG source SHA and pose across original/source, compiled triangle topology, and GameKit WebGL panels; shared time/expression/zoom/pan; mobile landscape layout');
  return report;
}

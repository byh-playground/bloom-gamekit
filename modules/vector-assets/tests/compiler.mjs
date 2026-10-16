import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compileVectorAsset, compileVectorAssetFile, VECTOR_ASSET_QUALITY_PRESETS } from '../compiler.js';
import { createVectorAssetLoader } from '../browser-loader.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';

const sourcePath = 'modules/vector-assets/assets/seed-scout.svg';
const source = await readFile(sourcePath);
assert.deepEqual(VECTOR_ASSET_QUALITY_PRESETS, {
  standard: { curveSegments: 4, strokeArcDivisions: 2 },
  smallAsset: { curveSegments: 2, strokeArcDivisions: 2 },
});
assert.ok(Object.isFrozen(VECTOR_ASSET_QUALITY_PRESETS) && Object.values(VECTOR_ASSET_QUALITY_PRESETS).every(Object.isFrozen),
  'named quality presets and their option objects are immutable');
const asset = await compileVectorAssetFile(sourcePath, sourcePath);
const legacyAsset = await compileVectorAssetFile(sourcePath, sourcePath, { curveSegments: 16, strokeArcDivisions: 12 });
validateCompiledAsset(asset);
validateCompiledAsset(legacyAsset);
let loaderFetches = 0;
const loader = createVectorAssetLoader({ fetch: async () => { loaderFetches++; return new Response(source, { status: 200 }); }, maxEntries: 1 });
const loadOptions = { sourcePath, expectedSha256: asset.sourceSha256, maxBytes: source.byteLength };
const [browserCoreAsset, sharedBrowserCoreAsset] = await Promise.all([
  loader.load('/startup/seed-scout.svg', loadOptions), loader.load('/startup/seed-scout.svg', loadOptions),
]);
assert.equal(loaderFetches, 1, 'same-key concurrent browser startup requests share one fetch');
assert.equal(browserCoreAsset, sharedBrowserCoreAsset, 'same-key startup requests share one compile result');
assert.equal(loader.size, 1, 'successful startup compile is retained in the bounded cache');
assert.deepEqual(browserCoreAsset.geometry, asset.geometry, 'browser loader and Node compiler core emit identical geometry');
assert.equal(browserCoreAsset.sourceSha256, asset.sourceSha256, 'browser Web Crypto digest matches Node SHA-256');
assert.deepEqual(browserCoreAsset.compilerOptions, { curveSegments: 4, normalizeCenteredViewBox: false, strokeArcDivisions: 2 },
  'browser loader records the shared standard quality defaults');
assert.equal('sourcePaths' in browserCoreAsset, false, 'browser runtime omits optional debug paths by default');
const debugAsset = await loader.load('/startup/seed-scout.svg', { ...loadOptions, includeSourcePaths: true });
assert.ok(Array.isArray(debugAsset.sourcePaths), 'debug source paths can be requested explicitly');
assert.ok(loader.size <= 1, 'the compiled-asset cache stays within its configured entry bound');
const mismatchLoader = createVectorAssetLoader({ fetch: async () => new Response(source, { status: 200 }) });
await assert.rejects(mismatchLoader.load('/startup/seed-scout.svg', { expectedSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
assert.equal(mismatchLoader.size, 0, 'a hash mismatch is rejected before compiling or caching');
const boundedLoader = createVectorAssetLoader({ fetch: async () => new Response(source, { status: 200 }) });
await assert.rejects(boundedLoader.load('/startup/seed-scout.svg', { maxBytes: source.byteLength - 1 }), /exceeds/);
assert.equal(boundedLoader.size, 0, 'over-limit SVG bytes are not cached');
let strokeLoaderFetches = 0;
const strokeLoader = createVectorAssetLoader({ fetch: async () => { strokeLoaderFetches++; return new Response(source, { status: 200 }); }, maxEntries: 2 });
const [defaultStrokeLoad, explicitDefaultStrokeLoad] = await Promise.all([
  strokeLoader.load('/startup/seed-scout.svg', { sourcePath }),
  strokeLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments: 4, strokeArcDivisions: 2 }),
]);
assert.equal(defaultStrokeLoad, explicitDefaultStrokeLoad, 'omitted and explicit standard quality normalize to the same cache key');
const [coarseStrokeLoad, sameCoarseStrokeLoad] = await Promise.all([
  strokeLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions: 8 }),
  strokeLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions: 8 }),
]);
assert.equal(coarseStrokeLoad, sameCoarseStrokeLoad, 'same non-default arc quality shares the in-flight compilation');
assert.equal(strokeLoaderFetches, 2, 'a changed stroke quality uses a distinct loader cache key');
assert.equal(strokeLoader.size, 2, 'both default and custom stroke tessellations fit the bounded cache');
assert.deepEqual(defaultStrokeLoad.compilerOptions, { curveSegments: 4, normalizeCenteredViewBox: false, strokeArcDivisions: 2 });
assert.equal(coarseStrokeLoad.compilerOptions.strokeArcDivisions, 8);
assert.notDeepEqual(coarseStrokeLoad.geometry, defaultStrokeLoad.geometry, 'browser loader forwards the selected stroke tessellation');
await assert.rejects(strokeLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions: 0 }), /strokeArcDivisions/i);
await assert.rejects(strokeLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions: null }), /strokeArcDivisions/i,
  'browser loader rejects explicit null instead of silently restoring the default');
for (const strokeArcDivisions of [65, 8.5]) {
  await assert.rejects(strokeLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions }), /strokeArcDivisions/i,
    'browser loader rejects out-of-range and fractional stroke subdivisions');
}
let qualityLoaderFetches = 0;
const qualityLoader = createVectorAssetLoader({ fetch: async () => { qualityLoaderFetches++; return new Response(source, { status: 200 }); }, maxEntries: 8 });
const [curveThree, sameCurveThree] = await Promise.all([
  qualityLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments: 3 }),
  qualityLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments: 3 }),
]);
assert.equal(curveThree, sameCurveThree, 'the same low curve quality reuses its cached browser-loader compile');
const arcThree = await qualityLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions: 3 });
const curveAndArcThree = await qualityLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments: 3, strokeArcDivisions: 3 });
assert.notEqual(curveThree, arcThree, 'strokeArcDivisions remains part of the browser-loader cache key');
assert.notEqual(curveThree, curveAndArcThree, 'curveSegments remains part of the browser-loader cache key');
assert.equal(qualityLoaderFetches, 3, 'only distinct quality contracts fetch and compile');
for (const curveSegments of [0, 65, 8.5]) {
  await assert.rejects(qualityLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments }), /curveSegments/i,
    'browser loader rejects out-of-range and fractional curve subdivisions');
}
await assert.rejects(qualityLoader.load('/startup/seed-scout.svg', { sourcePath, curveSegments: null }), /curveSegments/i,
  'browser loader rejects explicit null rather than restoring the default');
for (const strokeArcDivisions of [65, 8.5]) {
  await assert.rejects(qualityLoader.load('/startup/seed-scout.svg', { sourcePath, strokeArcDivisions }), /strokeArcDivisions/i,
    'browser loader rejects out-of-range and fractional stroke subdivisions');
}
loader.clear(); loader.dispose(); mismatchLoader.dispose(); boundedLoader.dispose(); strokeLoader.dispose(); qualityLoader.dispose();
assert.equal(asset.schemaVersion, 1);
assert.equal(asset.compilerVersion, '0.11.0');
const { compilerOptions: ignoredCompilerOptions, ...assetWithoutCompilerOptions } = asset;
assert.doesNotThrow(() => validateCompiledAsset({ ...assetWithoutCompilerOptions, compilerVersion: '0.2.0' }), 'previous compiled meshes remain valid under the unchanged asset schema');
assert.throws(() => validateCompiledAsset({ ...assetWithoutCompilerOptions, compilerVersion: '0.8.0' }), /compiler options/i,
  'compiler 0.8 output must identify its tessellation setting');
assert.doesNotThrow(() => validateCompiledAsset({ ...assetWithoutCompilerOptions, compilerVersion: '0.7.0' }), 'existing 0.7 compiled assets remain readable');
assert.doesNotThrow(() => validateCompiledAsset({ ...assetWithoutCompilerOptions, compilerVersion: '0.6.0' }), 'existing 0.6 compiled assets remain readable');
assert.doesNotThrow(() => validateCompiledAsset({ ...asset, compilerVersion: '0.9.0', compilerOptions: { curveSegments: 16, normalizeCenteredViewBox: false } }),
  'previous 0.9 compiler options remain readable');
assert.doesNotThrow(() => validateCompiledAsset({ ...legacyAsset, compilerVersion: '0.10.0' }),
  'previous 0.10 compiler options remain readable after the compiler version advances');
assert.throws(() => validateCompiledAsset({ ...asset, compilerOptions: { ...asset.compilerOptions, strokeArcDivisions: null } }), /compiler options/i,
  'the recorded stroke subdivision must be a bounded safe integer');
for (const value of [0, 1.5, 65]) {
  assert.throws(() => validateCompiledAsset({ ...asset, compilerOptions: { ...asset.compilerOptions, curveSegments: value } }), /compiler options/i,
    'compiled asset schema rejects invalid curve subdivisions');
  assert.throws(() => validateCompiledAsset({ ...asset, compilerOptions: { ...asset.compilerOptions, strokeArcDivisions: value } }), /compiler options/i,
    'compiled asset schema rejects invalid stroke subdivisions');
}
assert.equal(asset.compilerOptions.curveSegments, 4, 'the standard curve quality is recorded in compiled output');
assert.equal(asset.compilerOptions.normalizeCenteredViewBox, false, 'the default viewport normalization mode is recorded');
assert.equal(asset.compilerOptions.strokeArcDivisions, 2, 'the standard round-stroke tessellation is recorded in compiled output');
assert.deepEqual(legacyAsset.compilerOptions, { curveSegments: 16, normalizeCenteredViewBox: false, strokeArcDivisions: 12 },
  'explicit 16/12 options still select the prior compiled settings');
assert.notDeepEqual(asset.geometry, legacyAsset.geometry, 'the requested standard default uses a deliberately lower retained tessellation');
assert.equal(asset.geometry.strideFloats, 11);
assert.ok(asset.geometry.indices instanceof Uint16Array, 'SVG compiler retains unique vertices and triangle indices');
assert.equal(asset.geometry.indices.length % 3, 0);
assert.ok(asset.geometry.indices.length / (asset.geometry.vertices.length / 11) > 2.5, 'static SVG triangulation contains reusable vertex attributes');
assert.equal(asset.geometry.partCount, 7);
for (const [name, indices] of Object.entries(asset.geometry.expressionIndices)) {
  assert.ok(indices instanceof Uint16Array && indices.length % 3 === 0, `${name} compiles a retained triangle index variant`);
  assert.ok(indices.length < asset.geometry.indices.length, `${name} omits the mutually exclusive expression geometry`);
  const expression = asset.metadata.expressions[name], hidden = new Set(expression.hide);
  for (const index of indices) {
    const partId = asset.metadata.parts[asset.geometry.vertices[index * 11 + 10]].id;
    assert.ok(!hidden.has(partId), `${name} index variant excludes hidden part ${partId}`);
  }
}
const coarseAsset = compileVectorAsset(source, sourcePath, { curveSegments: 8 });
validateCompiledAsset(coarseAsset);
assert.equal(coarseAsset.compilerOptions.curveSegments, 8);
assert.ok(coarseAsset.geometry.indices.length < legacyAsset.geometry.indices.length * 0.7,
  'eight-segment curves reduce the same authored SVG triangle references by at least 30%');
for (const curveSegments of [1, 2, 3, 64]) {
  const boundaryAsset = compileVectorAsset(source, sourcePath, { curveSegments });
  validateCompiledAsset(boundaryAsset);
  assert.equal(boundaryAsset.compilerOptions.curveSegments, curveSegments, `${curveSegments} is an accepted curveSegments boundary`);
  assert.ok(boundaryAsset.geometry.vertices.every(Number.isFinite), `${curveSegments} curve segments produce only finite vertex buffers`);
  assert.ok(boundaryAsset.geometry.indices instanceof Uint16Array && boundaryAsset.geometry.indices.length % 3 === 0,
    `${curveSegments} curve segments preserve complete triangle indices`);
}
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 0 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 65 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { quality: 'low' }), /Only curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 1.5 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: null }), /curveSegments/i,
  'explicit null is rejected instead of silently selecting the default');
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: Number.MAX_SAFE_INTEGER + 1 }), /curveSegments/i,
  'unsafe integers are rejected before compilation');
const explicitDefaultArcAsset = compileVectorAsset(source, sourcePath, { curveSegments: 4, strokeArcDivisions: 2 });
assert.deepEqual(explicitDefaultArcAsset.geometry, asset.geometry, 'omitted and explicit standard subdivisions preserve exact geometry');
const coarseArcAsset = compileVectorAsset(source, sourcePath, { strokeArcDivisions: 8 });
assert.equal(coarseArcAsset.compilerOptions.strokeArcDivisions, 8);
assert.notDeepEqual(coarseArcAsset.geometry, asset.geometry, 'round joins and caps use the selected arc subdivision');
for (const strokeArcDivisions of [1, 2, 3, 64]) {
  const boundaryAsset = compileVectorAsset(source, sourcePath, { strokeArcDivisions });
  validateCompiledAsset(boundaryAsset);
  assert.equal(boundaryAsset.compilerOptions.strokeArcDivisions, strokeArcDivisions, `${strokeArcDivisions} is an accepted stroke arc boundary`);
  assert.ok(boundaryAsset.geometry.vertices.every(Number.isFinite), `${strokeArcDivisions} stroke arc divisions produce only finite vertex buffers`);
  assert.ok(boundaryAsset.geometry.indices instanceof Uint16Array && boundaryAsset.geometry.indices.length % 3 === 0,
    `${strokeArcDivisions} stroke arc divisions preserve complete triangle indices`);
}
assert.throws(() => compileVectorAsset(source, sourcePath, { strokeArcDivisions: 0 }), /strokeArcDivisions/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { strokeArcDivisions: 65 }), /strokeArcDivisions/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { strokeArcDivisions: 1.5 }), /strokeArcDivisions/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { strokeArcDivisions: null }), /strokeArcDivisions/i,
  'explicit null is rejected instead of silently selecting the default');
assert.throws(() => compileVectorAsset(source, sourcePath, { strokeArcDivisions: Number.MAX_SAFE_INTEGER + 1 }), /strokeArcDivisions/i,
  'unsafe arc subdivision integers are rejected');
const collapsedCurveMetadata = {
  schemaVersion: 1, id: 'collapsed-curve', defaultExpression: 'default',
  parts: [{ id: 'body', parent: null, pivot: [0, 0] }], expressions: { default: { show: [], hide: [] } }, sockets: {},
  clips: { idle: { durationMs: 100, loop: 'repeat', easing: 'linear', keyframes: [
    { timeMs: 0, easing: 'linear', parts: {} }, { timeMs: 100, easing: 'linear', parts: {} },
  ] } },
};
const collapsedCurveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><metadata id="vector-asset">${JSON.stringify(collapsedCurveMetadata)}</metadata><g id="body"><path id="body-shape" d="M0 0 C0 0 0 0 0 0 Z" fill="#f00"/></g></svg>`;
assert.throws(() => compileVectorAsset(Buffer.from(collapsedCurveSvg), 'collapsed-curve.svg', { curveSegments: 1 }),
  /at this tessellation; increase the selected subdivision/, 'an all-degenerate low-quality SVG fails with a clear instruction to raise tessellation');
const nonScalingStrokeSourcePath = 'modules/vector-assets/tests/non-scaling-stroke.svg';
const nonScalingStrokeSourceBytes = await readFile(nonScalingStrokeSourcePath);
const nonScalingDefaultAsset = compileVectorAsset(nonScalingStrokeSourceBytes, nonScalingStrokeSourcePath);
const nonScalingArc8Asset = compileVectorAsset(nonScalingStrokeSourceBytes, nonScalingStrokeSourcePath, { strokeArcDivisions: 8 });
assert.deepEqual(compileVectorAsset(nonScalingStrokeSourceBytes, nonScalingStrokeSourcePath, { curveSegments: 4, strokeArcDivisions: 2 }).geometry, nonScalingDefaultAsset.geometry,
  'explicit default arc divisions preserve custom non-scaling round caps exactly');
assert.notDeepEqual(nonScalingArc8Asset.geometry, nonScalingDefaultAsset.geometry, 'non-scaling round caps use the selected arc subdivision');
const cli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', '8'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).compilerOptions.curveSegments, 8, 'CLI exposes the same recorded tessellation contract');
const arcCli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--stroke-arc-divisions', '8'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(arcCli.status, 0, arcCli.stderr);
assert.equal(JSON.parse(arcCli.stdout).compilerOptions.strokeArcDivisions, 8, 'CLI exposes the recorded stroke tessellation contract');
const legacyCli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', '16', '--stroke-arc-divisions', '12'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(legacyCli.status, 0, legacyCli.stderr);
assert.deepEqual(JSON.parse(legacyCli.stdout).compilerOptions,
  { curveSegments: 16, normalizeCenteredViewBox: false, strokeArcDivisions: 12 }, 'CLI still supports the previous explicit 16/12 tessellation');
const invalidArcCli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--stroke-arc-divisions', '0'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.notEqual(invalidArcCli.status, 0, 'CLI rejects stroke arc values below the documented boundary');
const invalidCli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', '0'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.notEqual(invalidCli.status, 0, 'CLI rejects values below the documented boundary');
for (const curveSegments of [1, 2, 3, 64]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', String(curveSegments)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).compilerOptions.curveSegments, curveSegments, 'CLI accepts the requested low values and upper boundary');
}
for (const value of [1.5, 65]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', String(value)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.notEqual(result.status, 0, `CLI rejects invalid curve subdivision ${value}`);
}
for (const strokeArcDivisions of [1, 2, 3, 64]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--stroke-arc-divisions', String(strokeArcDivisions)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).compilerOptions.strokeArcDivisions, strokeArcDivisions, 'CLI accepts low round-stroke values and the upper boundary');
}
for (const value of [1.5, 65]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--stroke-arc-divisions', String(value)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.notEqual(result.status, 0, `CLI rejects invalid stroke subdivision ${value}`);
}
for (const args of [['8.5'], ['0x10'], ['8', '--curve-segments', '9']]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.notEqual(result.status, 0, `CLI rejects malformed tessellation arguments: ${args.join(' ')}`);
}
const sparseExpressionSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata id="vector-asset">${JSON.stringify({
  schemaVersion: 1, id: 'sparse-expression-fixture', defaultExpression: 'default',
  parts: [{ id: 'body', parent: null, pivot: [0, 0] }, { id: 'eyes', parent: 'body', pivot: [0, 0] }],
  expressions: { default: { show: [], hide: [] }, hidden: { show: [], hide: ['eyes'] } }, sockets: {},
  clips: { idle: { durationMs: 100, loop: 'repeat', easing: 'linear', keyframes: [
    { timeMs: 0, easing: 'linear', parts: {} }, { timeMs: 100, easing: 'linear', parts: {} },
  ] } },
})}</metadata><g id="body"><rect id="body-shape" x="0" y="0" width="20" height="20" fill="#f00"/><g id="eyes"><circle id="eyes-shape" cx="10" cy="10" r="3" fill="#00f"/></g></g></svg>`;
const sparseExpressionAsset = compileVectorAsset(Buffer.from(sparseExpressionSvg), 'sparse-expression-fixture.svg');
const eyesPart = sparseExpressionAsset.metadata.parts.findIndex(part => part.id === 'eyes');
assert.ok([...sparseExpressionAsset.geometry.expressionIndices.default].some(index => sparseExpressionAsset.geometry.vertices[index * 11 + 10] === eyesPart),
  'an expression variant keeps an omitted part because the initial player state leaves it visible');

const centeredSource = await readFile('modules/vector-assets/tests/centered-viewbox.svg');
const centeredText = centeredSource.toString('utf8');
const centeredRoot = /<svg\b[^>]*>/.exec(centeredText)?.[0];
const centeredMetadataBlock = /<metadata\s+id="vector-asset">([\s\S]*?)<\/metadata>/.exec(centeredText);
assert.ok(centeredRoot && centeredMetadataBlock, 'centered fixture has a root viewport and vector metadata');
const centeredViewBox = centeredRoot.match(/\bviewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
const normalizedMetadata = JSON.parse(centeredMetadataBlock[1]);
for (const clip of Object.values(normalizedMetadata.clips)) {
  for (const frame of clip.keyframes) {
    for (const [part, pose] of Object.entries(frame.parts)) {
      if (pose && typeof pose === 'object' && !Array.isArray(pose) && Object.keys(pose).length === 0) delete frame.parts[part];
    }
  }
}
const quote = String.fromCharCode(34);
const normalizedRoot = centeredRoot
  .replace(/\bwidth="[^"]+"/, `width=${quote}${centeredViewBox[2]}${quote}`)
  .replace(/\bheight="[^"]+"/, `height=${quote}${centeredViewBox[3]}${quote}`)
  .replace(/\bviewBox="[^"]+"/, `viewBox=${quote}0 0 ${centeredViewBox[2]} ${centeredViewBox[3]}${quote}`);
const normalizedSource = centeredText
  .replace(centeredRoot, normalizedRoot)
  .replace(centeredMetadataBlock[0], `<metadata id=${quote}vector-asset${quote}>${JSON.stringify(normalizedMetadata)}</metadata>`);
const centeredExpectedHash = createHash('sha256').update(centeredSource).digest('hex');
const centeredAsset = compileVectorAsset(centeredSource, 'centered-viewbox.svg', { normalizeCenteredViewBox: true });
const legacyNormalizedAsset = compileVectorAsset(normalizedSource, 'centered-viewbox.svg');
validateCompiledAsset(centeredAsset);
assert.deepEqual(centeredAsset.viewBox, [-36, -40, 72, 80], 'normalization preserves the original centered viewBox for the host renderer');
assert.equal(centeredAsset.sourceSha256, centeredExpectedHash, 'compiled source provenance hashes the original, unnormalized bytes');
assert.deepEqual(centeredAsset.geometry, legacyNormalizedAsset.geometry, 'all retained geometry and clip part assignments match the existing Bounko normalization');
assert.deepEqual(centeredAsset.sourcePaths, legacyNormalizedAsset.sourcePaths, 'path provenance is unaffected by centered viewport normalization');
assert.deepEqual(centeredAsset.metadata, legacyNormalizedAsset.metadata, 'parts, pivots, sockets, and non-empty clip transforms match the old normalizer');
assert.deepEqual(centeredAsset.metadata.parts.map(part => part.pivot), [[0, 0], [-12, 2], [-12, -14]]);
assert.deepEqual(centeredAsset.metadata.sockets, { origin: { part: 'body', point: [0, 0] }, grip: { part: 'hand', point: [-12, -18] } });
assert.deepEqual(centeredAsset.metadata.clips.test.keyframes[1].parts, {}, 'empty no-op poses are removed without dropping their keyframe');
assert.deepEqual(centeredAsset.metadata.clips.test.keyframes[2].parts.arm, { rotation: 0.45 }, 'non-empty clip transforms remain authored');
assert.throws(() => compileVectorAsset(centeredSource, 'centered-viewbox.svg'), /viewBox/i,
  'centered viewport compatibility stays explicit and does not broaden the default compiler contract');
let centeredLoaderFetches = 0;
const centeredLoader = createVectorAssetLoader({ fetch: async () => {
  centeredLoaderFetches++;
  return new Response(centeredSource, { status: 200 });
} });
const centeredLoadOptions = { sourcePath: 'centered-viewbox.svg', expectedSha256: centeredExpectedHash,
  maxBytes: centeredSource.byteLength, normalizeCenteredViewBox: true };
const centeredLoaded = await centeredLoader.load('/startup/centered.svg', centeredLoadOptions);
assert.deepEqual(centeredLoaded.geometry, centeredAsset.geometry, 'browser startup and Node compiler share the centered-viewBox normalization core');
assert.deepEqual(centeredLoaded.viewBox, [-36, -40, 72, 80]);
assert.equal(centeredLoaded.sourceSha256, centeredExpectedHash);
await assert.rejects(centeredLoader.load('/startup/centered.svg', { ...centeredLoadOptions, normalizeCenteredViewBox: false }), /viewBox/i,
  'the cache key separates legacy-normalized and strict compiler contracts');
assert.equal(centeredLoader.size, 1);
const badCenteredLoader = createVectorAssetLoader({ fetch: async () => new Response(centeredSource, { status: 200 }) });
await assert.rejects(badCenteredLoader.load('/startup/centered.svg', { ...centeredLoadOptions, expectedSha256: '0'.repeat(64) }), /SHA-256 mismatch/);
assert.equal(badCenteredLoader.size, 0, 'an incorrect original-byte hash rejects before normalization and caching');
assert.equal(centeredLoaderFetches, 2, 'a distinct compiler normalization mode receives its own fetch/compile key');
centeredLoader.dispose(); badCenteredLoader.dispose();
const combinedAssetGeometry = MeshBuilder.combine([asset.geometry, asset.geometry]);
assert.equal(combinedAssetGeometry.partCount, 14);
assert.equal(combinedAssetGeometry.indices.length, asset.geometry.indices.length * 2, 'combining indexed assets offsets each source index');
assert.ok(combinedAssetGeometry.indices.slice(asset.geometry.indices.length).some(index => index >= asset.geometry.vertices.length / 11),
  'the second combined asset references its own remapped vertex range');
assert.ok(legacyAsset.geometry.vertices.byteLength > 100_000, 'the prior explicit 16/12 geometry fixture remains available');
assert.ok(asset.geometry.vertices.byteLength < legacyAsset.geometry.vertices.byteLength,
  'the standard preset retains fewer initial vertex bytes than the explicit legacy 16/12 quality');
assert.equal(asset.metadata.parts.find(part => part.id === 'leaf-left').parent, 'sprout');
assert.ok(asset.metadata.clips.idle.keyframes.length >= 3);
assert.ok(asset.metadata.sockets.mouth);

const yarnAsset = await compileVectorAssetFile('modules/vector-assets/assets/yarn-fox.svg');
const sketchAsset = await compileVectorAssetFile('modules/vector-assets/assets/sketch-fox.svg');
assert.equal(yarnAsset.metadata.styles[0].kind, 'yarn');
assert.equal(yarnAsset.geometry.morphCount, 0, 'yarn stitches/fibers are static retained vector geometry');
assert.ok(yarnAsset.geometry.vertices.byteLength < 4_000_000, 'yarn texture stays bounded as vector triangles');
assert.equal(yarnAsset.geometry.indices.length % 3, 0);
assert.ok(yarnAsset.geometry.vertices.some((value, index) => index % 11 === 2 && value > 0.9)
  && yarnAsset.geometry.vertices.some((value, index) => index % 11 === 2 && value < 0.2), 'linear gradient is split at stops and stored as vertex RGB');
assert.ok(yarnAsset.geometry.vertices.some((value, index) => index % 11 === 5 && value > 0.6), 'gradient stop alpha reaches the compiled mesh');
assert.equal(sketchAsset.metadata.styles[0].kind, 'sketch');
assert.equal(sketchAsset.geometry.morphCount, 2, 'sketch boil compiles two deterministic morph targets');
assert.ok(sketchAsset.geometry.vertices.some((value, index) => index % 11 === 6 && Math.abs(value) > 1e-6), 'sketch mesh contains authored morph deltas');
const sketchAgain = await compileVectorAssetFile('modules/vector-assets/assets/sketch-fox.svg');
assert.deepEqual(sketchAgain.geometry.vertices, sketchAsset.geometry.vertices, 'sketch geometry generation is deterministic');

const shaderSurfaceSvg = await readFile('modules/vector-assets/tests/world-shader.svg', 'utf8');
const shaderSurfaceAsset = compileVectorAsset(Buffer.from(shaderSurfaceSvg), 'shader-surface-fixture.svg');
validateCompiledAsset(shaderSurfaceAsset);
assert.equal(shaderSurfaceAsset.compilerVersion, '0.11.0');
assert.equal(shaderSurfaceAsset.geometry.morphCount, 0, 'shader-backed sketch/yarn do not generate dynamic mesh morph data');
assert.equal(shaderSurfaceAsset.geometry.shaderSurfaces.length, 1, 'the compiler retains one shader surface descriptor');
assert.ok(shaderSurfaceAsset.geometry.shaderSurfaces[0].fillVertices instanceof Float32Array);
assert.ok(shaderSurfaceAsset.geometry.shaderSurfaces[0].outline.length >= 6, 'shader material retains the sampled authored contour');
assert.deepEqual(shaderSurfaceAsset.geometry.drawOrder.map(command => command.kind), ['mesh', 'surface', 'mesh'],
  'ordinary SVG paint ranges keep their exact order around shader-backed surfaces');
assert.deepEqual(shaderSurfaceAsset.geometry.drawOrder.filter(command => command.kind === 'mesh').map(command => command.indexCount), [6, 6]);
const mismatchedSurfaceStyle = { ...shaderSurfaceAsset.geometry.shaderSurfaces[0], style: { ...shaderSurfaceAsset.geometry.shaderSurfaces[0].style, edgeWidth: 9 } };
assert.throws(() => validateCompiledAsset({ ...shaderSurfaceAsset, geometry: { ...shaderSurfaceAsset.geometry, shaderSurfaces: [mismatchedSurfaceStyle] } }),
  /exactly match/i, 'retained surface style cannot diverge from its authored metadata');
const shaderOnlySvg = shaderSurfaceSvg.replace(/\s*<rect id="under"[^>]*\/>/, '').replace(/\s*<rect id="over"[^>]*\/>/, '');
const shaderOnlyAsset = compileVectorAsset(Buffer.from(shaderOnlySvg), 'shader-only-fixture.svg');
validateCompiledAsset(shaderOnlyAsset);
assert.equal(shaderOnlyAsset.geometry.vertices.length, 0, 'surface-only assets do not need a transparent sentinel mesh');
assert.equal(shaderOnlyAsset.geometry.indices.length, 0);
assert.deepEqual(shaderOnlyAsset.geometry.drawOrder, [{ kind: 'surface', surfaceIndex: 0 }]);
assert.throws(() => compileVectorAsset(Buffer.from(shaderSurfaceSvg.replace('"backend":"shader"', '"backend":"software-fallback"')),
  'unsupported-style-backend.svg'), /backend/i, 'unsupported style backends fail instead of silently selecting baked triangles');

const nonScalingLine = await compileVectorAssetFile('modules/vector-assets/tests/non-scaling-stroke.svg');
const legacyNonScalingLine = await compileVectorAssetFile('modules/vector-assets/tests/non-scaling-stroke.svg', 'modules/vector-assets/tests/non-scaling-stroke.svg',
  { curveSegments: 16, strokeArcDivisions: 12 });
validateCompiledAsset(nonScalingLine);
assert.equal(nonScalingLine.geometry.nonScalingStroke, true, 'non-scaling line stroke metadata is retained');
assert.equal(nonScalingLine.geometry.morphCount, 0, 'non-scaling stroke does not repurpose morph data');
assert.equal(nonScalingLine.geometry.strideFloats, 11, 'the existing mesh record layout remains unchanged');
assert.equal(nonScalingLine.geometry.indices.length, 24, 'standard 4/2 quality retains round line caps with the SVG fill triangles');
assert.equal(legacyNonScalingLine.geometry.indices.length, 84, 'explicit 16/12 quality retains the previous round line cap geometry');
let lineVertexCount=0,fillVertexCount=0;
for (let index=0;index<nonScalingLine.geometry.vertices.length;index+=11) {
  const tangentLength=Math.hypot(nonScalingLine.geometry.vertices[index+6],nonScalingLine.geometry.vertices[index+7]);
  if(tangentLength<0.9){
    fillVertexCount++;
    assert.equal(tangentLength,0,'ordinary SVG fill vertices have no screen-stroke marker');
    continue;
  }
  lineVertexCount++;
  assert.ok(Math.abs(tangentLength-1)<1e-6,'each expanded line vertex retains a normalized tangent');
  const radius=Math.hypot(nonScalingLine.geometry.vertices[index+8],nonScalingLine.geometry.vertices[index+9]);
  assert.ok(radius<1e-6||Math.abs(radius-0.75)<1e-6,
    'stroke outline offsets are authored in CSS-pixel units');
}
assert.ok(lineVertexCount>0&&fillVertexCount>0,'one retained vector mesh can carry both non-scaling lines and ordinary SVG fills');
const nonScalingSource=await readFile('modules/vector-assets/tests/non-scaling-stroke.svg','utf8');
assert.throws(()=>compileVectorAsset(Buffer.from(nonScalingSource.replace('<line id="crack"','<path id="crack" d="M20 50 L80 50"')), 'unsupported-vector-effect.svg'), /only <line>/i,
  'unsupported path outlines fail explicitly instead of falling back to a scaling stroke');
assert.throws(()=>compileVectorAsset(Buffer.from(nonScalingSource.replace('non-scaling-stroke"','scale-stroke"')), 'unsupported-vector-effect-value.svg'), /Unsupported SVG vector-effect/i,
  'unknown vector-effect values fail compilation');
const buttCapAsset=compileVectorAsset(Buffer.from(nonScalingSource.replace('stroke-linecap="round"','stroke-linecap="butt"')),'non-scaling-butt-cap.svg');
const squareCapAsset=compileVectorAsset(Buffer.from(nonScalingSource.replace('stroke-linecap="round"','stroke-linecap="square"')),'non-scaling-square-cap.svg');
assert.equal(buttCapAsset.geometry.indices.length,12,'butt caps keep a two-triangle static line body beside the fill triangles');
assert.equal(squareCapAsset.geometry.indices.length,12,'square caps keep a two-triangle static line body beside the fill triangles');
assert.ok(squareCapAsset.geometry.vertices.some((value,index)=>index%11===8&&Math.abs(value)>=0.75),
  'square caps extend their retained geometry by half the authored width');

const reject = (fragment, message, replacement = '') => {
  assert.throws(() => compileVectorAsset(Buffer.from(source.toString('utf8').replace(fragment, replacement)), 'invalid.svg'), message);
};
reject('<g id="body">', /metadata|part|id/i, '<g id="body-renamed">');
reject('<g id="body">', /Script|foreignObject|raster/i, '<script>alert(1)</script><g id="body">');
reject('<g id="body">', /Script|foreignObject|raster/i, '<foreignObject></foreignObject><g id="body">');
reject('<g id="body">', /Script|foreignObject|raster/i, '<image href="data:image/png;base64,AA=="/><g id="body">');
reject('<g id="body">', /external reference/i, '<g id="body" data="https://example.test/art.svg">');
reject('<g id="body">', /Unsupported SVG element/i, '<text id="unsupported">x</text><g id="body">');
reject('id="body-outline"', /unique/i, 'id="body"');
reject('"schemaVersion": 1,', /valid JSON/i, '"schemaVersion": nope,');
reject('id="vector-asset"', /metadata#vector-asset/i, 'id="author-notes"');
const yarnSource = await readFile('modules/vector-assets/assets/yarn-fox.svg', 'utf8');
const yarnMetadata = /<metadata id="vector-asset">([\s\S]*?)<\/metadata>/.exec(yarnSource)?.[1];
assert.ok(yarnMetadata, 'the yarn fixture retains its authored metadata');
const yarnEdgeMetadata = yarnMetadata.replace('"pattern":true', '"pattern":false').replace('"fiber":true', '"fiber":false');
const yarnEdgeSource = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><metadata id="vector-asset">${yarnEdgeMetadata}</metadata><defs><linearGradient id="yarn-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.53" stop-color="#888888"/><stop offset="1" stop-color="#000000"/></linearGradient></defs><g id="body"><path id="yarn-shell" fill="url(#yarn-gradient)" d="M0 0 H100 V100 H0 Z"/></g></svg>`;
const yarnEdgeAsset = compileVectorAsset(Buffer.from(yarnEdgeSource), 'yarn-gradient-edge.svg');
const yarnVertices = yarnEdgeAsset.geometry.vertices;
const darkEdgeSamples = [];
for (let index = 0; index < yarnVertices.length; index += 11) {
  if (Math.abs(yarnVertices[index + 5] - 0.7) < 0.01) darkEdgeSamples.push({ x: yarnVertices[index], red: yarnVertices[index + 2] });
}
const leftEdgeRed = darkEdgeSamples.filter(sample => sample.x < 15).map(sample => sample.red);
const rightEdgeRed = darkEdgeSamples.filter(sample => sample.x > 85).map(sample => sample.red);
assert.ok(leftEdgeRed.length && rightEdgeRed.length, 'the yarn edge fixtures produce dark pass vertices on both gradient ends');
assert.ok(Math.min(...leftEdgeRed) > Math.max(...rightEdgeRed) + 0.25,
  'yarn edge-loop palette follows the authored gradient position instead of sampling one midpoint color');
let gradientBandsChecked = 0;
for (let index = 0; index < yarnEdgeAsset.geometry.indices.length; index += 3) {
  const vertices = [0, 1, 2].map(corner => yarnEdgeAsset.geometry.indices[index + corner] * 11);
  if (!vertices.every(vertex => Math.abs(yarnVertices[vertex + 5] - 0.7) < 0.01)) continue;
  const t = vertices.map(vertex => yarnVertices[vertex] / 100);
  assert.ok(Math.max(...t) <= 0.53 + 1e-5 || Math.min(...t) >= 0.53 - 1e-5,
    `each yarn edge triangle stays within one authored gradient stop band: ${JSON.stringify(t)}`);
  gradientBandsChecked++;
}
assert.ok(gradientBandsChecked > 0, 'yarn edge geometry is subdivided at the middle gradient stop');
const yarnAlphaSource = yarnEdgeSource
  .replace('offset="0" stop-color="#ffffff"', 'offset="0" stop-color="#ffffff" stop-opacity="1"')
  .replace('offset="0.53" stop-color="#888888"', 'offset="0.53" stop-color="#888888" stop-opacity="0.5"')
  .replace('offset="1" stop-color="#000000"', 'offset="1" stop-color="#000000" stop-opacity="0.25"');
const yarnAlphaVertices = compileVectorAsset(Buffer.from(yarnAlphaSource), 'yarn-gradient-alpha.svg').geometry.vertices;
const leftDarkAlpha = [], rightDarkAlpha = [];
for (let index = 0; index < yarnAlphaVertices.length; index += 11) {
  const x = yarnAlphaVertices[index], alpha = yarnAlphaVertices[index + 5];
  if (x < 2 && Math.abs(alpha - 0.7) < 0.01) leftDarkAlpha.push(alpha);
  if (x > 98 && alpha > 0.16 && alpha < 0.19) rightDarkAlpha.push(alpha);
}
assert.ok(leftDarkAlpha.length && rightDarkAlpha.length && Math.min(...leftDarkAlpha) > Math.max(...rightDarkAlpha) * 3.5,
  'yarn thread alpha follows authored stop-opacity across the gradient');
assert.throws(() => compileVectorAsset(Buffer.from(yarnSource.replace('"fiberMax":155', '"fiberMax":999')), 'invalid.svg'), /fiberMax/i);
assert.throws(() => compileVectorAsset(Buffer.from(yarnSource.replace('url(#yarn-gradient)', 'url(#missing-gradient)')), 'invalid.svg'), /unknown linearGradient/i);
assert.throws(() => compileVectorAsset(Buffer.from(yarnSource.replace('<linearGradient id="yarn-gradient"', '<radialGradient id="yarn-gradient"').replace('</linearGradient>', '</radialGradient>')), 'invalid.svg'), /Unsupported SVG element/i);

const gradientMetadata = JSON.stringify({ schemaVersion: 1, id: 'gradient-alpha', defaultExpression: 'neutral',
  parts: [{ id: 'body', parent: null, pivot: [50, 50] }], expressions: { neutral: { show: [], hide: [] } }, sockets: {},
  clips: { idle: { durationMs: 1, loop: 'once', easing: 'linear', keyframes: [
    { timeMs: 0, easing: 'linear', parts: { body: { x: 0 } } }, { timeMs: 1, easing: 'linear', parts: { body: { x: 0 } } },
  ] } } });
const gradientFixture = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><metadata id="vector-asset">${gradientMetadata}</metadata><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/><stop offset="0.53" stop-color="#888888"/><stop offset="1" stop-color="#000000" stop-opacity="0.25"/></linearGradient></defs><g id="body"><path id="ring" fill="url(#g)" fill-opacity="0.6" opacity="0.5" fill-rule="evenodd" d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z"/></g></svg>`;
const gradientFixtureAsset = compileVectorAsset(Buffer.from(gradientFixture), 'gradient-alpha.svg');
const curvedGradientFixture = gradientFixture.replace('d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z"',
  'd="M10 50 Q10 10 50 10 Q90 10 90 50 Q90 90 50 90 Q10 90 10 50 Z"');
const curvedGradient16 = compileVectorAsset(Buffer.from(curvedGradientFixture), 'curved-gradient.svg', { curveSegments: 16 });
const curvedGradient8 = compileVectorAsset(Buffer.from(curvedGradientFixture), 'curved-gradient.svg', { curveSegments: 8 });
assert.ok(curvedGradient8.geometry.indices.length < curvedGradient16.geometry.indices.length,
  'curveSegments also controls gradient-fill tessellation without moving gradient object bounds');
const ringAlpha = [...gradientFixtureAsset.geometry.vertices].filter((_, index) => index % 11 === 5);
assert.ok(Math.min(...ringAlpha) >= 0.074 && Math.max(...ringAlpha) <= 0.301, 'fill opacity, element opacity, and stop alpha multiply at vertices');
assert.ok(new Set([...gradientFixtureAsset.geometry.vertices].filter((_, index) => index % 11 === 2).map(value => value.toFixed(3))).size > 2,
  'gradient fill mesh contains interpolated vertex colors');
const transformedGradientFixture = gradientFixture.replace('id="ring" fill=', 'id="ring" transform="translate(4 6) rotate(90 50 50)" fill=');
const transformedGradientAsset = compileVectorAsset(Buffer.from(transformedGradientFixture), 'gradient-transformed.svg');
assert.ok(transformedGradientAsset.geometry.vertices.some((value, index) => index % 11 === 0 && value > 90)
  && transformedGradientAsset.geometry.vertices.some((value, index) => index % 11 === 1 && value > 90),
  'objectBoundingBox gradient target bounds are transformed with the path instead of using a world-axis-aligned box');

const expressionVariantBytes = Object.values(asset.geometry.expressionIndices).reduce((total, indices) => total + indices.byteLength, 0);
console.log(JSON.stringify({ status: 'PASS', sourceSha256: asset.sourceSha256, compiledVertices: asset.geometry.vertices.length / 11,
  expressionVariantBytes, compiledBytes: asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength + expressionVariantBytes, expandedBytes: asset.geometry.indices.length * 44,
  checks: ['DOMParser round trip preserves metadata and all DOM ids', 'Three SVGLoader Node compilation', 'indexed retained triangle geometry',
    'linear gradient stops and alpha in retained triangles', 'gradient-following yarn palette with stop-boundary color/alpha', 'hole, stroke and gradient geometry', 'scallop/two-loop yarn and boundary fibers',
    'two-target sketch morph geometry', 'repeat compilation determinism',
    'bad ids and metadata', 'scripts/foreignObject/raster/external refs/unknown elements rejected'] }));

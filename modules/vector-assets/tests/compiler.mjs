import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compileVectorAsset, compileVectorAssetFile } from '../compiler.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';

const sourcePath = 'modules/vector-assets/assets/seed-scout.svg';
const source = await readFile(sourcePath);
const asset = await compileVectorAssetFile(sourcePath, sourcePath);
validateCompiledAsset(asset);
assert.equal(asset.schemaVersion, 1);
assert.equal(asset.compilerVersion, '0.6.0');
assert.doesNotThrow(() => validateCompiledAsset({ ...asset, compilerVersion: '0.2.0' }), 'previous compiled meshes remain valid under the unchanged asset schema');
const { compilerOptions: ignoredCompilerOptions, ...assetWithoutCompilerOptions } = asset;
assert.throws(() => validateCompiledAsset({ ...assetWithoutCompilerOptions, compilerVersion: '0.6.0' }), /compiler options/i,
  'compiler 0.6 output must identify its tessellation setting');
assert.equal(asset.compilerOptions.curveSegments, 16, 'the default curve quality is recorded in compiled output');
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
assert.ok(coarseAsset.geometry.indices.length < asset.geometry.indices.length * 0.7,
  'eight-segment curves reduce the same authored SVG triangle references by at least 30%');
for (const curveSegments of [4, 64]) {
  const boundaryAsset = compileVectorAsset(source, sourcePath, { curveSegments });
  validateCompiledAsset(boundaryAsset);
  assert.equal(boundaryAsset.compilerOptions.curveSegments, curveSegments, `${curveSegments} is an accepted curveSegments boundary`);
}
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 3 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 65 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { quality: 'low' }), /Only curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: 8.5 }), /curveSegments/i);
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: null }), /curveSegments/i,
  'explicit null is rejected instead of silently selecting the default');
assert.throws(() => compileVectorAsset(source, sourcePath, { curveSegments: Number.MAX_SAFE_INTEGER + 1 }), /curveSegments/i,
  'unsafe integers are rejected before compilation');
const cli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', '8'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.equal(cli.status, 0, cli.stderr);
assert.equal(JSON.parse(cli.stdout).compilerOptions.curveSegments, 8, 'CLI exposes the same recorded tessellation contract');
const invalidCli = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', '3'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024 });
assert.notEqual(invalidCli.status, 0, 'CLI rejects values below the documented boundary');
for (const curveSegments of [4, 64]) {
  const result = spawnSync(process.execPath, ['modules/vector-assets/scripts/compile.mjs', sourcePath, '--curve-segments', String(curveSegments)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).compilerOptions.curveSegments, curveSegments, 'CLI accepts both inclusive bounds');
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
const combinedAssetGeometry = MeshBuilder.combine([asset.geometry, asset.geometry]);
assert.equal(combinedAssetGeometry.partCount, 14);
assert.equal(combinedAssetGeometry.indices.length, asset.geometry.indices.length * 2, 'combining indexed assets offsets each source index');
assert.ok(combinedAssetGeometry.indices.slice(asset.geometry.indices.length).some(index => index >= asset.geometry.vertices.length / 11),
  'the second combined asset references its own remapped vertex range');
assert.ok(asset.geometry.vertices.byteLength > 100_000);
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

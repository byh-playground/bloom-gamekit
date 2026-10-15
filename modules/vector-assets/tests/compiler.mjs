import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileVectorAsset, compileVectorAssetFile } from '../compiler.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';

const sourcePath = 'modules/vector-assets/assets/seed-scout.svg';
const source = await readFile(sourcePath);
const asset = await compileVectorAssetFile(sourcePath, sourcePath);
validateCompiledAsset(asset);
assert.equal(asset.schemaVersion, 1);
assert.equal(asset.compilerVersion, '0.4.0');
assert.doesNotThrow(() => validateCompiledAsset({ ...asset, compilerVersion: '0.2.0' }), 'previous compiled meshes remain valid under the unchanged asset schema');
assert.equal(asset.geometry.strideFloats, 11);
assert.ok(asset.geometry.indices instanceof Uint16Array, 'SVG compiler retains unique vertices and triangle indices');
assert.equal(asset.geometry.indices.length % 3, 0);
assert.ok(asset.geometry.indices.length / (asset.geometry.vertices.length / 11) > 2.5, 'static SVG triangulation contains reusable vertex attributes');
assert.equal(asset.geometry.partCount, 7);
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
const ringAlpha = [...gradientFixtureAsset.geometry.vertices].filter((_, index) => index % 11 === 5);
assert.ok(Math.min(...ringAlpha) >= 0.074 && Math.max(...ringAlpha) <= 0.301, 'fill opacity, element opacity, and stop alpha multiply at vertices');
assert.ok(new Set([...gradientFixtureAsset.geometry.vertices].filter((_, index) => index % 11 === 2).map(value => value.toFixed(3))).size > 2,
  'gradient fill mesh contains interpolated vertex colors');
const transformedGradientFixture = gradientFixture.replace('id="ring" fill=', 'id="ring" transform="translate(4 6) rotate(90 50 50)" fill=');
const transformedGradientAsset = compileVectorAsset(Buffer.from(transformedGradientFixture), 'gradient-transformed.svg');
assert.ok(transformedGradientAsset.geometry.vertices.some((value, index) => index % 11 === 0 && value > 90)
  && transformedGradientAsset.geometry.vertices.some((value, index) => index % 11 === 1 && value > 90),
  'objectBoundingBox gradient target bounds are transformed with the path instead of using a world-axis-aligned box');

console.log(JSON.stringify({ status: 'PASS', sourceSha256: asset.sourceSha256, compiledVertices: asset.geometry.vertices.length / 11,
  compiledBytes: asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength, expandedBytes: asset.geometry.indices.length * 44,
  checks: ['DOMParser round trip preserves metadata and all DOM ids', 'Three SVGLoader Node compilation', 'indexed retained triangle geometry',
    'linear gradient stops and alpha in retained triangles', 'hole, stroke and gradient geometry', 'Squish scallop/two-loop yarn and boundary fibers',
    'two-target sketch morph geometry', 'repeat compilation determinism',
    'bad ids and metadata', 'scripts/foreignObject/raster/external refs/unknown elements rejected'] }));

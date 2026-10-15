import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileVectorAsset, compileVectorAssetFile } from '../compiler.js';
import { validateCompiledAsset } from '../schema.js';

const sourcePath = 'modules/vector-assets/assets/seed-scout.svg';
const source = await readFile(sourcePath);
const asset = await compileVectorAssetFile(sourcePath, sourcePath);
validateCompiledAsset(asset);
assert.equal(asset.schemaVersion, 1);
assert.equal(asset.compilerVersion, '0.2.0');
assert.equal(asset.geometry.strideFloats, 11);
assert.equal(asset.geometry.partCount, 7);
assert.ok(asset.geometry.vertices.byteLength > 100_000);
assert.equal(asset.metadata.parts.find(part => part.id === 'leaf-left').parent, 'sprout');
assert.ok(asset.metadata.clips.idle.keyframes.length >= 3);
assert.ok(asset.metadata.sockets.mouth);

const yarnAsset = await compileVectorAssetFile('modules/vector-assets/assets/yarn-fox.svg');
const sketchAsset = await compileVectorAssetFile('modules/vector-assets/assets/sketch-fox.svg');
assert.equal(yarnAsset.metadata.styles[0].kind, 'yarn');
assert.equal(yarnAsset.geometry.morphCount, 0, 'yarn stitches/fibers are static retained vector geometry');
assert.ok(yarnAsset.geometry.vertices.byteLength < 4_000_000, 'yarn texture stays bounded as vector triangles');
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
assert.throws(() => compileVectorAsset(Buffer.from(yarnSource.replace('"fiberMax":95', '"fiberMax":999')), 'invalid.svg'), /fiberMax/i);

console.log(JSON.stringify({ status: 'PASS', sourceSha256: asset.sourceSha256, compiledVertices: asset.geometry.vertices.length / 11,
  compiledBytes: asset.geometry.vertices.byteLength, checks: ['DOMParser round trip preserves metadata and all DOM ids', 'Three SVGLoader Node compilation',
    'holes/strokes in source', 'seeded yarn vector geometry', 'two-target sketch morph geometry', 'repeat compilation determinism',
    'bad ids and metadata', 'scripts/foreignObject/raster/external refs/unknown elements rejected'] }));

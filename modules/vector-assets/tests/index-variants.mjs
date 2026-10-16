import assert from 'node:assert/strict';
import { compiledAsset as pr15Asset } from './fixtures/squish-pr15-enemy-boss.js';
import { createVectorAsset } from '../runtime.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';

function compileSemanticExpressionIndices(asset) {
  const { vertices, indices, partCount } = asset.geometry;
  const parts = asset.metadata.parts, partIndices = new Map(parts.map((part, index) => [part.id, index]));
  const output = {};
  for (const [name, expression] of Object.entries(asset.metadata.expressions)) {
    const visible = parts.map(() => true);
    for (const id of expression.show) visible[partIndices.get(id)] = true;
    for (const id of expression.hide) visible[partIndices.get(id)] = false;
    for (let index = 0; index < parts.length; index++) {
      let parent = parts[index].parent;
      while (parent !== null) {
        if (!visible[partIndices.get(parent)]) { visible[index] = false; break; }
        parent = parts[partIndices.get(parent)].parent;
      }
    }
    const retained = [];
    for (let offset = 0; offset < indices.length; offset += 3) {
      const [a, b, c] = indices.subarray(offset, offset + 3);
      const part = vertices[a * 11 + 10];
      assert.equal(vertices[b * 11 + 10], part, 'fixture triangle keeps a single authored part');
      assert.equal(vertices[c * 11 + 10], part, 'fixture triangle keeps a single authored part');
      if (visible[part]) retained.push(a, b, c);
    }
    output[name] = new Uint16Array(retained);
  }
  assert.equal(partCount, parts.length);
  return output;
}

assert.throws(() => validateCompiledAsset(pr15Asset), /expression index variant: paint_0/,
  'the unmodified PR15 compiled asset reproduces the startup collision');
assert.throws(() => createVectorAsset({ createMesh() {}, drawMesh() {}, deleteMesh() {} }, pr15Asset), /expression index variant: paint_0/,
  'createVectorAsset rejects the unmodified PR15 asset during initialization');
assert.equal(pr15Asset.compilerVersion, '0.6.0');
assert.deepEqual(Object.keys(pr15Asset.metadata.expressions), ['neutral', 'happy', 'surprised', 'angry']);
assert.deepEqual(Object.keys(pr15Asset.geometry.expressionIndices), ['paint_0', 'paint_1']);

const { expressionIndices: painterRanges, ...pr15Geometry } = pr15Asset.geometry;
const migratedAsset = {
  ...pr15Asset,
  geometry: {
    ...pr15Geometry,
    indexVariants: painterRanges,
    expressionIndices: compileSemanticExpressionIndices(pr15Asset),
  },
};
validateCompiledAsset(migratedAsset);
assert.deepEqual(Object.keys(migratedAsset.geometry.expressionIndices), Object.keys(pr15Asset.metadata.expressions),
  'semantic expression keys remain authored expression names');
assert.deepEqual(Object.keys(migratedAsset.geometry.indexVariants), ['paint_0', 'paint_1'],
  'painter ranges have their own generic index-variant map');
const paintedTriangles = new Uint16Array([...painterRanges.paint_0, ...painterRanges.paint_1]);
assert.deepEqual(paintedTriangles, pr15Asset.geometry.indices,
  'the two actual PR15 mesh runs preserve their source painter order');
assert.throws(() => validateCompiledAsset({
  ...migratedAsset,
  geometry: { ...migratedAsset.geometry, indexVariants: { ...migratedAsset.geometry.indexVariants, neutral: new Uint16Array([0, 1, 2]) } },
}), /named index variant: neutral/, 'the two namespaces cannot collide');
assert.throws(() => validateCompiledAsset({
  ...migratedAsset,
  geometry: { ...migratedAsset.geometry, indexVariants: { 'paint #0': new Uint16Array([0, 1, 2]) } },
}), /named index variant/, 'generic variant names must use the stable identifier contract');

let capturedGeometry, capturedDraws = 0, deleted = false;
const mesh = {};
const renderer = {
  createMesh(geometry) { capturedGeometry = geometry; return mesh; },
  drawMesh(drawMesh, options) { assert.equal(drawMesh, mesh); capturedDraws++; this.lastOptions = options; },
  deleteMesh(drawMesh) { assert.equal(drawMesh, mesh); deleted = true; },
};
const vector = createVectorAsset(renderer, migratedAsset);
assert.equal(capturedGeometry.indexVariants, migratedAsset.geometry.indexVariants,
  'createVectorAsset forwards generic painter ranges unchanged');
assert.equal(capturedGeometry.expressionIndices, migratedAsset.geometry.expressionIndices,
  'createVectorAsset forwards semantic expressions separately');
const actor = vector.createPlayer();
actor.draw({ projection: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
assert.equal(renderer.lastOptions.indexVariant, 'neutral', 'the vector player auto-selects only the authored default expression');
actor.setExpression('happy').draw({ projection: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
assert.equal(renderer.lastOptions.indexVariant, 'happy');
actor.setPartVisible('face-happy', false).draw({ projection: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
assert.equal(renderer.lastOptions.indexVariant, null, 'manual part visibility disables semantic index optimization');
assert.equal(capturedDraws, 3);
actor.dispose();
vector.dispose();
assert.equal(deleted, true);

function triangleGeometry(expressionIndices = {}) {
  const vertices = new Float32Array(3 * 11);
  for (let index = 0; index < 3; index++) vertices.set([index, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0], index * 11);
  return { vertices, indices: new Uint16Array([0, 1, 2]), strideFloats: 11, partCount: 1, morphCount: 0, expressionIndices };
}
const combined = MeshBuilder.combine([
  triangleGeometry({ happy: new Uint16Array([0, 1, 2]) }),
  triangleGeometry({ sad: new Uint16Array([0, 1, 2]) }),
]);
assert.deepEqual(combined.expressionIndices.happy, new Uint16Array([0, 1, 2, 3, 4, 5]),
  'combined expression lists include base triangles for inputs without that expression');
assert.deepEqual(combined.expressionIndices.sad, new Uint16Array([0, 1, 2, 3, 4, 5]));
assert.throws(() => MeshBuilder.combine([{
  ...triangleGeometry(), indexVariants: { paint_0: new Uint16Array([0, 1, 2]) },
}]), /cannot flatten painter-order indexVariants/,
'combining painter ranges fails explicitly instead of dropping or regrouping their draw order');

console.log(JSON.stringify({
  fixtureBlob: '547267ada66bc4e59bb98d5972b28026b1c80c5c',
  pr15Failure: 'expression index variant: paint_0',
  genericIndexVariants: Object.keys(migratedAsset.geometry.indexVariants),
  semanticExpressions: Object.keys(migratedAsset.geometry.expressionIndices),
  sourceOrderPreserved: true,
  vectorRuntimeAutoSelectsSemanticExpression: true,
  meshBuilderVariantBehavior: 'semantic-merge; generic painter ranges explicitly rejected',
}));

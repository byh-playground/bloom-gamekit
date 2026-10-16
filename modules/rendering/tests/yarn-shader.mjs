import assert from 'node:assert/strict';
import { buildYarnSurfaceGeometry } from '../yarn-shader.js';

const style = {
  kind: 'yarn', seed: 41, stitchWidth: 17, stitchHeight: 19, thickness: 0.4102564103,
  irregularity: 0.13, contrast: 0.23, edgeSpacing: 9, edgeRelief: 2,
  edgeWidth: 2.4, fiberLength: 11, fiberWidth: 0.9, fiberOpacity: 0.65,
  fiberSpacing: 4, fiberMax: 155, curved: true, pattern: true, detail: false, fiber: true,
};

const points = [
  [-20, 0], [-14, -14], [0, -20], [14, -14], [20, 0], [14, 14], [0, 20], [-14, 14],
];
const fill = new Float32Array([
  0, 0, 0.82, 0.48, 0.28, 1, -20, 0, 0.74, 0.4, 0.22, 1,
  0, 0, 0.82, 0.48, 0.28, 1, 0, -20, 0.88, 0.55, 0.33, 1,
  0, 0, 0.82, 0.48, 0.28, 1, 20, 0, 0.7, 0.36, 0.2, 1,
]);
const outline = Float32Array.from(points.flat());
const edgeColors = new Float32Array(points.flatMap((_, index) => {
  const t = index / points.length;
  return [0.82 - t * 0.12, 0.48 - t * 0.08, 0.28 - t * 0.06, 1];
}));
const base = buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors, style });
// SVG contours commonly repeat the first/adjacent point. Colors must follow
// the same vertex normalization instead of rejecting an otherwise valid asset.
const duplicated = [0, 1, 1, 2, 3, 4, 5, 6, 7, 0];
const normalized = buildYarnSurfaceGeometry({ fillVertices: fill,
  outline: Float32Array.from(duplicated.flatMap(i => points[i])),
  edgeColors: Float32Array.from(duplicated.flatMap(i => Array.from(edgeColors.subarray(i * 4, i * 4 + 4)))), style });
assert.deepEqual(normalized.vertices, base.vertices, 'duplicate contour vertices retain matching gradient colors');
assert.ok(base.vertices.length > fill.length);
assert.equal(base.fillCount, fill.length / 6);
assert.equal(base.edgeCount, points.length * 6);
assert.equal(base.vertices.length % 9, 0);
assert.ok(base.vertices.every(Number.isFinite));
assert.ok(base.contourLength > 0);

for (const changed of [
  { ...style, stitchWidth: 2, stitchHeight: 2 },
  { ...style, fiberSpacing: 0.5, fiberMax: 512, fiberLength: 19 },
  { ...style, edgeSpacing: 0.1, stitchWidth: 1, fiberSpacing: 0.25 },
]) {
  const geometry = buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors, style: changed });
  assert.equal(geometry.vertices.length, base.vertices.length, 'effect density must not add retained mesh vertices');
  assert.equal(geometry.edgeCount, base.edgeCount, 'contour strip topology is independent of stitch/fiber density');
}

assert.throws(() => buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors, style: { ...style, stitchWidth: 0 } }), /positive/);
assert.throws(() => buildYarnSurfaceGeometry({ fillVertices: fill, outline: [0, 0, 1], style }), /contour/);
assert.throws(() => buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors: new Float32Array(4), style }), /edgeColors/);
const invalidEdgeColor = edgeColors.slice(); invalidEdgeColor[0] = 2;
assert.throws(() => buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors: invalidEdgeColor, style }), /\[0,1\]/);
const invalidColor = fill.slice(); invalidColor[2] = NaN;
assert.throws(() => buildYarnSurfaceGeometry({ fillVertices: invalidColor, outline, style }), /finite/);

const sketchStyle = {
  kind: 'sketch', seed: 7, periodMs: 900, amplitude: 2, frequency: 3, echoX: 1,
  echoY: 1, echoWidth: 1.2, echoOpacity: 0.6, hatchAngle: 0.8, hatchSpacing: 8,
  hatchWidth: 0.7, hatchOpacity: 0.48,
};
const sketch = buildYarnSurfaceGeometry({ fillVertices: fill, outline, edgeColors, style: sketchStyle });
assert.equal(sketch.vertices.length, base.vertices.length, 'sketch shader uses the same fixed contour mesh');

console.log(JSON.stringify({
  yarnSurfaceVertices: base.vertices.length / 9,
  fillVertices: base.fillCount,
  edgeVertices: base.edgeCount,
  contourLength: Number(base.contourLength.toFixed(3)),
  densityInvariantCases: 3,
  sketchSurfaceVertices: sketch.vertices.length / 9,
}));

import assert from 'node:assert/strict';
import { buildYarnSurfaceGeometry } from '../yarn-shader.js';
const STYLE = {
    kind: 'yarn',
    seed: 41,
    stitchWidth: 17,
    stitchHeight: 19,
    thickness: 0.4102564103,
    irregularity: 0.13,
    contrast: 0.23,
    edgeSpacing: 9,
    edgeRelief: 2,
    edgeWidth: 2.4,
    fiberLength: 11,
    fiberWidth: 0.9,
    fiberOpacity: 0.65,
    fiberSpacing: 4,
    fiberMax: 155,
    curved: true,
    pattern: true,
    detail: false,
    fiber: true,
};
const POINTS = [
    [-20, 0],
    [-14, -14],
    [0, -20],
    [14, -14],
    [20, 0],
    [14, 14],
    [0, 20],
    [-14, 14],
];
const FILL = new Float32Array([
    0, 0, 0.82, 0.48, 0.28, 1, -20, 0, 0.74, 0.4, 0.22, 1, 0, 0, 0.82, 0.48, 0.28, 1, 0, -20, 0.88, 0.55, 0.33, 1, 0, 0,
    0.82, 0.48, 0.28, 1, 20, 0, 0.7, 0.36, 0.2, 1,
]);
const OUTLINE = Float32Array.from(POINTS.flat());
const EDGE_COLORS = new Float32Array(
    POINTS.flatMap((_, index) => {
        const T = index / POINTS.length;
        return [0.82 - T * 0.12, 0.48 - T * 0.08, 0.28 - T * 0.06, 1];
    }),
);
const BASE = buildYarnSurfaceGeometry({
    fillVertices: FILL,
    outline: OUTLINE,
    edgeColors: EDGE_COLORS,
    style: STYLE,
});
// SVG contours commonly repeat the first/adjacent point. Colors must follow
// the same vertex normalization instead of rejecting an otherwise valid asset.
const DUPLICATED = [0, 1, 1, 2, 3, 4, 5, 6, 7, 0];
const NORMALIZED = buildYarnSurfaceGeometry({
    fillVertices: FILL,
    outline: Float32Array.from(DUPLICATED.flatMap((i) => POINTS[i])),
    edgeColors: Float32Array.from(DUPLICATED.flatMap((i) => Array.from(EDGE_COLORS.subarray(i * 4, i * 4 + 4)))),
    style: STYLE,
});
assert.deepEqual(NORMALIZED.vertices, BASE.vertices, 'duplicate contour vertices retain matching gradient colors');
assert.ok(BASE.vertices.length > FILL.length);
assert.equal(BASE.fillCount, FILL.length / 6);
assert.equal(BASE.edgeCount, POINTS.length * 6);
assert.equal(BASE.vertices.length % 9, 0);
assert.ok(BASE.vertices.every(Number.isFinite));
assert.ok(BASE.contourLength > 0);
for (const CHANGED of [
    {
        ...STYLE,
        stitchWidth: 2,
        stitchHeight: 2,
    },
    {
        ...STYLE,
        fiberSpacing: 0.5,
        fiberMax: 512,
        fiberLength: 19,
    },
    {
        ...STYLE,
        edgeSpacing: 0.1,
        stitchWidth: 1,
        fiberSpacing: 0.25,
    },
]) {
    const GEOMETRY = buildYarnSurfaceGeometry({
        fillVertices: FILL,
        outline: OUTLINE,
        edgeColors: EDGE_COLORS,
        style: CHANGED,
    });
    assert.equal(GEOMETRY.vertices.length, BASE.vertices.length, 'effect density must not add retained mesh vertices');
    assert.equal(GEOMETRY.edgeCount, BASE.edgeCount, 'contour strip topology is independent of stitch/fiber density');
}
assert.throws(
    () =>
        buildYarnSurfaceGeometry({
            fillVertices: FILL,
            outline: OUTLINE,
            edgeColors: EDGE_COLORS,
            style: {
                ...STYLE,
                stitchWidth: 0,
            },
        }),
    /positive/,
);
assert.throws(
    () =>
        buildYarnSurfaceGeometry({
            fillVertices: FILL,
            outline: [0, 0, 1],
            style: STYLE,
        }),
    /contour/,
);
assert.throws(
    () =>
        buildYarnSurfaceGeometry({
            fillVertices: FILL,
            outline: OUTLINE,
            edgeColors: new Float32Array(4),
            style: STYLE,
        }),
    /edgeColors/,
);
const INVALID_EDGE_COLOR = EDGE_COLORS.slice();
INVALID_EDGE_COLOR[0] = 2;
assert.throws(
    () =>
        buildYarnSurfaceGeometry({
            fillVertices: FILL,
            outline: OUTLINE,
            edgeColors: INVALID_EDGE_COLOR,
            style: STYLE,
        }),
    /\[0,1\]/,
);
const INVALID_COLOR = FILL.slice();
INVALID_COLOR[2] = NaN;
assert.throws(
    () =>
        buildYarnSurfaceGeometry({
            fillVertices: INVALID_COLOR,
            outline: OUTLINE,
            style: STYLE,
        }),
    /finite/,
);
const SKETCH_STYLE = {
    kind: 'sketch',
    seed: 7,
    periodMs: 900,
    amplitude: 2,
    frequency: 3,
    echoX: 1,
    echoY: 1,
    echoWidth: 1.2,
    echoOpacity: 0.6,
    hatchAngle: 0.8,
    hatchSpacing: 8,
    hatchWidth: 0.7,
    hatchOpacity: 0.48,
};
const SKETCH = buildYarnSurfaceGeometry({
    fillVertices: FILL,
    outline: OUTLINE,
    edgeColors: EDGE_COLORS,
    style: SKETCH_STYLE,
});
assert.equal(SKETCH.vertices.length, BASE.vertices.length, 'sketch shader uses the same fixed contour mesh');
console.log(
    JSON.stringify({
        yarnSurfaceVertices: BASE.vertices.length / 9,
        fillVertices: BASE.fillCount,
        edgeVertices: BASE.edgeCount,
        contourLength: Number(BASE.contourLength.toFixed(3)),
        densityInvariantCases: 3,
        sketchSurfaceVertices: SKETCH.vertices.length / 9,
    }),
);

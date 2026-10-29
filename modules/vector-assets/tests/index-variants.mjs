import assert from 'node:assert/strict';
import { compiledAsset as pr15Asset } from './fixtures/squish-pr15-enemy-boss.js';
import { createVectorActor } from '../runtime.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';
function compileSemanticExpressionIndices(asset) {
    const { vertices: VERTICES, indices: INDICES, partCount: PART_COUNT } = asset.geometry;
    const PARTS = asset.metadata.parts,
        PART_INDICES = new Map(PARTS.map((part, index) => [part.id, index]));
    const OUTPUT = {};
    for (const [NAME, EXPRESSION] of Object.entries(asset.metadata.expressions)) {
        const VISIBLE = PARTS.map(() => true);
        for (const ID of EXPRESSION.show) {
            VISIBLE[PART_INDICES.get(ID)] = true;
        }
        for (const ID of EXPRESSION.hide) {
            VISIBLE[PART_INDICES.get(ID)] = false;
        }
        for (let index = 0; index < PARTS.length; index++) {
            let parent = PARTS[index].parent;
            while (parent !== null) {
                if (!VISIBLE[PART_INDICES.get(parent)]) {
                    VISIBLE[index] = false;
                    break;
                }
                parent = PARTS[PART_INDICES.get(parent)].parent;
            }
        }
        const RETAINED = [];
        for (let offset = 0; offset < INDICES.length; offset += 3) {
            const [A, B, C] = INDICES.subarray(offset, offset + 3);
            const PART = VERTICES[A * 11 + 10];
            assert.equal(VERTICES[B * 11 + 10], PART, 'fixture triangle keeps a single authored part');
            assert.equal(VERTICES[C * 11 + 10], PART, 'fixture triangle keeps a single authored part');
            if (VISIBLE[PART]) {
                RETAINED.push(A, B, C);
            }
        }
        OUTPUT[NAME] = new Uint16Array(RETAINED);
    }
    assert.equal(PART_COUNT, PARTS.length);
    return OUTPUT;
}
assert.throws(
    () => validateCompiledAsset(pr15Asset),
    /expression index variant: paint_0/,
    'the unmodified PR15 compiled asset reproduces the startup collision',
);
const FAKE_CONTEXT = (renderer) => ({
    acquireMeshRenderer: () => renderer,
    onDispose() {},
});
assert.throws(
    () =>
        createVectorActor(
            FAKE_CONTEXT({
                createMesh() {},
                drawMesh() {},
                deleteMesh() {},
            }),
            pr15Asset,
        ),
    /expression index variant: paint_0/,
    'createVectorActor rejects the unmodified PR15 asset during initialization',
);
assert.equal(pr15Asset.compilerVersion, '0.6.0');
assert.deepEqual(Object.keys(pr15Asset.metadata.expressions), ['neutral', 'happy', 'surprised', 'angry']);
assert.deepEqual(Object.keys(pr15Asset.geometry.expressionIndices), ['paint_0', 'paint_1']);
const { expressionIndices: PAINTER_RANGES, ...PR15_GEOMETRY } = pr15Asset.geometry;
const MIGRATED_ASSET = {
    ...pr15Asset,
    geometry: {
        ...PR15_GEOMETRY,
        indexVariants: PAINTER_RANGES,
        expressionIndices: compileSemanticExpressionIndices(pr15Asset),
    },
};
validateCompiledAsset(MIGRATED_ASSET);
assert.deepEqual(
    Object.keys(MIGRATED_ASSET.geometry.expressionIndices),
    Object.keys(pr15Asset.metadata.expressions),
    'semantic expression keys remain authored expression names',
);
assert.deepEqual(
    Object.keys(MIGRATED_ASSET.geometry.indexVariants),
    ['paint_0', 'paint_1'],
    'painter ranges have their own generic index-variant map',
);
const PAINTED_TRIANGLES = new Uint16Array([...PAINTER_RANGES.paint_0, ...PAINTER_RANGES.paint_1]);
assert.deepEqual(
    PAINTED_TRIANGLES,
    pr15Asset.geometry.indices,
    'the two actual PR15 mesh runs preserve their source painter order',
);
assert.throws(
    () =>
        validateCompiledAsset({
            ...MIGRATED_ASSET,
            geometry: {
                ...MIGRATED_ASSET.geometry,
                indexVariants: {
                    ...MIGRATED_ASSET.geometry.indexVariants,
                    neutral: new Uint16Array([0, 1, 2]),
                },
            },
        }),
    /named index variant: neutral/,
    'the two namespaces cannot collide',
);
assert.throws(
    () =>
        validateCompiledAsset({
            ...MIGRATED_ASSET,
            geometry: {
                ...MIGRATED_ASSET.geometry,
                indexVariants: {
                    'paint #0': new Uint16Array([0, 1, 2]),
                },
            },
        }),
    /named index variant/,
    'generic variant names must use the stable identifier contract',
);
let capturedGeometry;
let capturedDraws = 0;
let deleted = false;
const MESH = {};
const RENDERER = {
    createMesh(geometry) {
        capturedGeometry = geometry;
        return MESH;
    },
    drawMesh(drawMesh, options) {
        assert.equal(drawMesh, MESH);
        capturedDraws++;
        this.lastOptions = options;
    },
    deleteMesh(drawMesh) {
        assert.equal(drawMesh, MESH);
        deleted = true;
    },
};
const ACTOR = createVectorActor(FAKE_CONTEXT(RENDERER), MIGRATED_ASSET);
assert.equal(
    capturedGeometry.indexVariants,
    MIGRATED_ASSET.geometry.indexVariants,
    'createVectorActor forwards generic painter ranges unchanged',
);
assert.equal(
    capturedGeometry.expressionIndices,
    MIGRATED_ASSET.geometry.expressionIndices,
    'createVectorActor forwards semantic expressions separately',
);
ACTOR.draw({
    projection: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});
assert.equal(
    RENDERER.lastOptions.indexVariant,
    'neutral',
    'the vector actor auto-selects only the authored default expression',
);
ACTOR.setExpression('happy').draw({
    projection: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});
assert.equal(RENDERER.lastOptions.indexVariant, 'happy');
ACTOR.setPartVisible('face-happy', false).draw({
    projection: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});
assert.equal(RENDERER.lastOptions.indexVariant, null, 'manual part visibility disables semantic index optimization');
assert.equal(capturedDraws, 3);
ACTOR.dispose();
assert.equal(deleted, true, 'the last actor of a compiled SVG releases its GPU mesh');
function triangleGeometry(expressionIndices = {}) {
    const VERTICES = new Float32Array(3 * 11);
    for (let index = 0; index < 3; index++) {
        VERTICES.set([index, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0], index * 11);
    }
    return {
        vertices: VERTICES,
        indices: new Uint16Array([0, 1, 2]),
        strideFloats: 11,
        partCount: 1,
        morphCount: 0,
        expressionIndices,
    };
}
const COMBINED = MeshBuilder.combine([
    triangleGeometry({
        happy: new Uint16Array([0, 1, 2]),
    }),
    triangleGeometry({
        sad: new Uint16Array([0, 1, 2]),
    }),
]);
assert.deepEqual(
    COMBINED.expressionIndices.happy,
    new Uint16Array([0, 1, 2, 3, 4, 5]),
    'combined expression lists include base triangles for inputs without that expression',
);
assert.deepEqual(COMBINED.expressionIndices.sad, new Uint16Array([0, 1, 2, 3, 4, 5]));
assert.throws(
    () =>
        MeshBuilder.combine([
            {
                ...triangleGeometry(),
                indexVariants: {
                    paint_0: new Uint16Array([0, 1, 2]),
                },
            },
        ]),
    /cannot flatten painter-order indexVariants/,
    'combining painter ranges fails explicitly instead of dropping or regrouping their draw order',
);
console.log(
    JSON.stringify({
        fixtureBlob: '547267ada66bc4e59bb98d5972b28026b1c80c5c',
        pr15Failure: 'expression index variant: paint_0',
        genericIndexVariants: Object.keys(MIGRATED_ASSET.geometry.indexVariants),
        semanticExpressions: Object.keys(MIGRATED_ASSET.geometry.expressionIndices),
        sourceOrderPreserved: true,
        vectorRuntimeAutoSelectsSemanticExpression: true,
        meshBuilderVariantBehavior: 'semantic-merge; generic painter ranges explicitly rejected',
    }),
);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compileVectorAsset, compileVectorAssetFile, VECTOR_ASSET_QUALITY_PRESETS } from '../compiler.js';
import { createVectorAssetLoader } from '../browser-loader.js';
import { validateCompiledAsset } from '../schema.js';
import { MeshBuilder } from '../../rendering/mesh-builder.js';
const SOURCE_PATH = 'modules/vector-assets/assets/seed-scout.svg';
const SOURCE = await readFile(SOURCE_PATH);
assert.deepEqual(VECTOR_ASSET_QUALITY_PRESETS, {
    standard: {
        curveSegments: 4,
        strokeArcDivisions: 2,
    },
    smallAsset: {
        curveSegments: 2,
        strokeArcDivisions: 2,
    },
});
assert.ok(
    Object.isFrozen(VECTOR_ASSET_QUALITY_PRESETS) && Object.values(VECTOR_ASSET_QUALITY_PRESETS).every(Object.isFrozen),
    'named quality presets and their option objects are immutable',
);
const ASSET = await compileVectorAssetFile(SOURCE_PATH, SOURCE_PATH);
const LEGACY_ASSET = await compileVectorAssetFile(SOURCE_PATH, SOURCE_PATH, {
    curveSegments: 16,
    strokeArcDivisions: 12,
});
validateCompiledAsset(ASSET);
validateCompiledAsset(LEGACY_ASSET);
let loaderFetches = 0;
const LOADER = createVectorAssetLoader({
    fetch: async () => {
        loaderFetches++;
        return new Response(SOURCE, {
            status: 200,
        });
    },
    maxEntries: 1,
});
const LOAD_OPTIONS = {
    sourcePath: SOURCE_PATH,
    expectedSha256: ASSET.sourceSha256,
    maxBytes: SOURCE.byteLength,
};
const [BROWSER_CORE_ASSET, SHARED_BROWSER_CORE_ASSET] = await Promise.all([
    LOADER.load('/startup/seed-scout.svg', LOAD_OPTIONS),
    LOADER.load('/startup/seed-scout.svg', LOAD_OPTIONS),
]);
assert.equal(loaderFetches, 1, 'same-key concurrent browser startup requests share one fetch');
assert.equal(BROWSER_CORE_ASSET, SHARED_BROWSER_CORE_ASSET, 'same-key startup requests share one compile result');
assert.equal(LOADER.size, 1, 'successful startup compile is retained in the bounded cache');
assert.deepEqual(
    BROWSER_CORE_ASSET.geometry,
    ASSET.geometry,
    'browser loader and Node compiler core emit identical geometry',
);
assert.equal(BROWSER_CORE_ASSET.sourceSha256, ASSET.sourceSha256, 'browser Web Crypto digest matches Node SHA-256');
assert.deepEqual(
    BROWSER_CORE_ASSET.compilerOptions,
    {
        curveSegments: 4,
        normalizeCenteredViewBox: false,
        strokeArcDivisions: 2,
    },
    'browser loader records the shared standard quality defaults',
);
assert.equal('sourcePaths' in BROWSER_CORE_ASSET, false, 'browser runtime omits optional debug paths by default');
const DEBUG_ASSET = await LOADER.load('/startup/seed-scout.svg', {
    ...LOAD_OPTIONS,
    includeSourcePaths: true,
});
assert.ok(Array.isArray(DEBUG_ASSET.sourcePaths), 'debug source paths can be requested explicitly');
assert.ok(LOADER.size <= 1, 'the compiled-asset cache stays within its configured entry bound');
const MISMATCH_LOADER = createVectorAssetLoader({
    fetch: async () =>
        new Response(SOURCE, {
            status: 200,
        }),
});
await assert.rejects(
    MISMATCH_LOADER.load('/startup/seed-scout.svg', {
        expectedSha256: '0'.repeat(64),
    }),
    /SHA-256 mismatch/,
);
assert.equal(MISMATCH_LOADER.size, 0, 'a hash mismatch is rejected before compiling or caching');
const BOUNDED_LOADER = createVectorAssetLoader({
    fetch: async () =>
        new Response(SOURCE, {
            status: 200,
        }),
});
await assert.rejects(
    BOUNDED_LOADER.load('/startup/seed-scout.svg', {
        maxBytes: SOURCE.byteLength - 1,
    }),
    /exceeds/,
);
assert.equal(BOUNDED_LOADER.size, 0, 'over-limit SVG bytes are not cached');
let strokeLoaderFetches = 0;
const STROKE_LOADER = createVectorAssetLoader({
    fetch: async () => {
        strokeLoaderFetches++;
        return new Response(SOURCE, {
            status: 200,
        });
    },
    maxEntries: 2,
});
const [DEFAULT_STROKE_LOAD, EXPLICIT_DEFAULT_STROKE_LOAD] = await Promise.all([
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
    }),
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        curveSegments: 4,
        strokeArcDivisions: 2,
    }),
]);
assert.equal(
    DEFAULT_STROKE_LOAD,
    EXPLICIT_DEFAULT_STROKE_LOAD,
    'omitted and explicit standard quality normalize to the same cache key',
);
const [COARSE_STROKE_LOAD, SAME_COARSE_STROKE_LOAD] = await Promise.all([
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        strokeArcDivisions: 8,
    }),
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        strokeArcDivisions: 8,
    }),
]);
assert.equal(
    COARSE_STROKE_LOAD,
    SAME_COARSE_STROKE_LOAD,
    'same non-default arc quality shares the in-flight compilation',
);
assert.equal(strokeLoaderFetches, 2, 'a changed stroke quality uses a distinct loader cache key');
assert.equal(STROKE_LOADER.size, 2, 'both default and custom stroke tessellations fit the bounded cache');
assert.deepEqual(DEFAULT_STROKE_LOAD.compilerOptions, {
    curveSegments: 4,
    normalizeCenteredViewBox: false,
    strokeArcDivisions: 2,
});
assert.equal(COARSE_STROKE_LOAD.compilerOptions.strokeArcDivisions, 8);
assert.notDeepEqual(
    COARSE_STROKE_LOAD.geometry,
    DEFAULT_STROKE_LOAD.geometry,
    'browser loader forwards the selected stroke tessellation',
);
await assert.rejects(
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        strokeArcDivisions: 0,
    }),
    /strokeArcDivisions/i,
);
await assert.rejects(
    STROKE_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        strokeArcDivisions: null,
    }),
    /strokeArcDivisions/i,
    'browser loader rejects explicit null instead of silently restoring the default',
);
for (const STROKE_ARC_DIVISIONS of [65, 8.5]) {
    await assert.rejects(
        STROKE_LOADER.load('/startup/seed-scout.svg', {
            sourcePath: SOURCE_PATH,
            strokeArcDivisions: STROKE_ARC_DIVISIONS,
        }),
        /strokeArcDivisions/i,
        'browser loader rejects out-of-range and fractional stroke subdivisions',
    );
}
let qualityLoaderFetches = 0;
const QUALITY_LOADER = createVectorAssetLoader({
    fetch: async () => {
        qualityLoaderFetches++;
        return new Response(SOURCE, {
            status: 200,
        });
    },
    maxEntries: 8,
});
const [CURVE_THREE, SAME_CURVE_THREE] = await Promise.all([
    QUALITY_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        curveSegments: 3,
    }),
    QUALITY_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        curveSegments: 3,
    }),
]);
assert.equal(CURVE_THREE, SAME_CURVE_THREE, 'the same low curve quality reuses its cached browser-loader compile');
const ARC_THREE = await QUALITY_LOADER.load('/startup/seed-scout.svg', {
    sourcePath: SOURCE_PATH,
    strokeArcDivisions: 3,
});
const CURVE_AND_ARC_THREE = await QUALITY_LOADER.load('/startup/seed-scout.svg', {
    sourcePath: SOURCE_PATH,
    curveSegments: 3,
    strokeArcDivisions: 3,
});
assert.notEqual(CURVE_THREE, ARC_THREE, 'strokeArcDivisions remains part of the browser-loader cache key');
assert.notEqual(CURVE_THREE, CURVE_AND_ARC_THREE, 'curveSegments remains part of the browser-loader cache key');
assert.equal(qualityLoaderFetches, 3, 'only distinct quality contracts fetch and compile');
for (const CURVE_SEGMENTS of [0, 65, 8.5]) {
    await assert.rejects(
        QUALITY_LOADER.load('/startup/seed-scout.svg', {
            sourcePath: SOURCE_PATH,
            curveSegments: CURVE_SEGMENTS,
        }),
        /curveSegments/i,
        'browser loader rejects out-of-range and fractional curve subdivisions',
    );
}
await assert.rejects(
    QUALITY_LOADER.load('/startup/seed-scout.svg', {
        sourcePath: SOURCE_PATH,
        curveSegments: null,
    }),
    /curveSegments/i,
    'browser loader rejects explicit null rather than restoring the default',
);
for (const STROKE_ARC_DIVISIONS of [65, 8.5]) {
    await assert.rejects(
        QUALITY_LOADER.load('/startup/seed-scout.svg', {
            sourcePath: SOURCE_PATH,
            strokeArcDivisions: STROKE_ARC_DIVISIONS,
        }),
        /strokeArcDivisions/i,
        'browser loader rejects out-of-range and fractional stroke subdivisions',
    );
}
LOADER.clear();
LOADER.dispose();
MISMATCH_LOADER.dispose();
BOUNDED_LOADER.dispose();
STROKE_LOADER.dispose();
QUALITY_LOADER.dispose();
assert.equal(ASSET.schemaVersion, 1);
assert.equal(ASSET.compilerVersion, '0.12.0');
const { compilerOptions: IGNORED_COMPILER_OPTIONS, ...ASSET_WITHOUT_COMPILER_OPTIONS } = ASSET;
assert.doesNotThrow(
    () =>
        validateCompiledAsset({
            ...ASSET_WITHOUT_COMPILER_OPTIONS,
            compilerVersion: '0.2.0',
        }),
    'previous compiled meshes remain valid under the unchanged asset schema',
);
assert.throws(
    () =>
        validateCompiledAsset({
            ...ASSET_WITHOUT_COMPILER_OPTIONS,
            compilerVersion: '0.8.0',
        }),
    /compiler options/i,
    'compiler 0.8 output must identify its tessellation setting',
);
assert.doesNotThrow(
    () =>
        validateCompiledAsset({
            ...ASSET_WITHOUT_COMPILER_OPTIONS,
            compilerVersion: '0.7.0',
        }),
    'existing 0.7 compiled assets remain readable',
);
assert.doesNotThrow(
    () =>
        validateCompiledAsset({
            ...ASSET_WITHOUT_COMPILER_OPTIONS,
            compilerVersion: '0.6.0',
        }),
    'existing 0.6 compiled assets remain readable',
);
assert.doesNotThrow(
    () =>
        validateCompiledAsset({
            ...ASSET,
            compilerVersion: '0.9.0',
            compilerOptions: {
                curveSegments: 16,
                normalizeCenteredViewBox: false,
            },
        }),
    'previous 0.9 compiler options remain readable',
);
assert.doesNotThrow(
    () =>
        validateCompiledAsset({
            ...LEGACY_ASSET,
            compilerVersion: '0.10.0',
        }),
    'previous 0.10 compiler options remain readable after the compiler version advances',
);
assert.throws(
    () =>
        validateCompiledAsset({
            ...ASSET,
            compilerOptions: {
                ...ASSET.compilerOptions,
                strokeArcDivisions: null,
            },
        }),
    /compiler options/i,
    'the recorded stroke subdivision must be a bounded safe integer',
);
for (const VALUE of [0, 1.5, 65]) {
    assert.throws(
        () =>
            validateCompiledAsset({
                ...ASSET,
                compilerOptions: {
                    ...ASSET.compilerOptions,
                    curveSegments: VALUE,
                },
            }),
        /compiler options/i,
        'compiled asset schema rejects invalid curve subdivisions',
    );
    assert.throws(
        () =>
            validateCompiledAsset({
                ...ASSET,
                compilerOptions: {
                    ...ASSET.compilerOptions,
                    strokeArcDivisions: VALUE,
                },
            }),
        /compiler options/i,
        'compiled asset schema rejects invalid stroke subdivisions',
    );
}
assert.equal(ASSET.compilerOptions.curveSegments, 4, 'the standard curve quality is recorded in compiled output');
assert.equal(
    ASSET.compilerOptions.normalizeCenteredViewBox,
    false,
    'the default viewport normalization mode is recorded',
);
assert.equal(
    ASSET.compilerOptions.strokeArcDivisions,
    2,
    'the standard round-stroke tessellation is recorded in compiled output',
);
assert.deepEqual(
    LEGACY_ASSET.compilerOptions,
    {
        curveSegments: 16,
        normalizeCenteredViewBox: false,
        strokeArcDivisions: 12,
    },
    'explicit 16/12 options still select the prior compiled settings',
);
assert.notDeepEqual(
    ASSET.geometry,
    LEGACY_ASSET.geometry,
    'the requested standard default uses a deliberately lower retained tessellation',
);
assert.equal(ASSET.geometry.strideFloats, 11);
assert.ok(ASSET.geometry.indices instanceof Uint16Array, 'SVG compiler retains unique vertices and triangle indices');
assert.equal(ASSET.geometry.indices.length % 3, 0);
assert.ok(
    ASSET.geometry.indices.length / (ASSET.geometry.vertices.length / 11) > 2.5,
    'static SVG triangulation contains reusable vertex attributes',
);
assert.equal(ASSET.geometry.partCount, 7);
for (const [NAME, INDICES] of Object.entries(ASSET.geometry.expressionIndices)) {
    assert.ok(
        INDICES instanceof Uint16Array && INDICES.length % 3 === 0,
        `${NAME} compiles a retained triangle index variant`,
    );
    assert.ok(
        INDICES.length < ASSET.geometry.indices.length,
        `${NAME} omits the mutually exclusive expression geometry`,
    );
    const EXPRESSION = ASSET.metadata.expressions[NAME],
        HIDDEN = new Set(EXPRESSION.hide);
    for (const INDEX of INDICES) {
        const PART_ID = ASSET.metadata.parts[ASSET.geometry.vertices[INDEX * 11 + 10]].id;
        assert.ok(!HIDDEN.has(PART_ID), `${NAME} index variant excludes hidden part ${PART_ID}`);
    }
}
const COARSE_ASSET = compileVectorAsset(SOURCE, SOURCE_PATH, {
    curveSegments: 8,
});
validateCompiledAsset(COARSE_ASSET);
assert.equal(COARSE_ASSET.compilerOptions.curveSegments, 8);
assert.ok(
    COARSE_ASSET.geometry.indices.length < LEGACY_ASSET.geometry.indices.length * 0.7,
    'eight-segment curves reduce the same authored SVG triangle references by at least 30%',
);
for (const CURVE_SEGMENTS of [1, 2, 3, 64]) {
    const BOUNDARY_ASSET = compileVectorAsset(SOURCE, SOURCE_PATH, {
        curveSegments: CURVE_SEGMENTS,
    });
    validateCompiledAsset(BOUNDARY_ASSET);
    assert.equal(
        BOUNDARY_ASSET.compilerOptions.curveSegments,
        CURVE_SEGMENTS,
        `${CURVE_SEGMENTS} is an accepted curveSegments boundary`,
    );
    assert.ok(
        BOUNDARY_ASSET.geometry.vertices.every(Number.isFinite),
        `${CURVE_SEGMENTS} curve segments produce only finite vertex buffers`,
    );
    assert.ok(
        BOUNDARY_ASSET.geometry.indices instanceof Uint16Array && BOUNDARY_ASSET.geometry.indices.length % 3 === 0,
        `${CURVE_SEGMENTS} curve segments preserve complete triangle indices`,
    );
}
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            curveSegments: 0,
        }),
    /curveSegments/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            curveSegments: 65,
        }),
    /curveSegments/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            quality: 'low',
        }),
    /Only curveSegments/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            curveSegments: 1.5,
        }),
    /curveSegments/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            curveSegments: null,
        }),
    /curveSegments/i,
    'explicit null is rejected instead of silently selecting the default',
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            curveSegments: Number.MAX_SAFE_INTEGER + 1,
        }),
    /curveSegments/i,
    'unsafe integers are rejected before compilation',
);
const EXPLICIT_DEFAULT_ARC_ASSET = compileVectorAsset(SOURCE, SOURCE_PATH, {
    curveSegments: 4,
    strokeArcDivisions: 2,
});
assert.deepEqual(
    EXPLICIT_DEFAULT_ARC_ASSET.geometry,
    ASSET.geometry,
    'omitted and explicit standard subdivisions preserve exact geometry',
);
const COARSE_ARC_ASSET = compileVectorAsset(SOURCE, SOURCE_PATH, {
    strokeArcDivisions: 8,
});
assert.equal(COARSE_ARC_ASSET.compilerOptions.strokeArcDivisions, 8);
assert.notDeepEqual(COARSE_ARC_ASSET.geometry, ASSET.geometry, 'round joins and caps use the selected arc subdivision');
for (const STROKE_ARC_DIVISIONS of [1, 2, 3, 64]) {
    const BOUNDARY_ASSET = compileVectorAsset(SOURCE, SOURCE_PATH, {
        strokeArcDivisions: STROKE_ARC_DIVISIONS,
    });
    validateCompiledAsset(BOUNDARY_ASSET);
    assert.equal(
        BOUNDARY_ASSET.compilerOptions.strokeArcDivisions,
        STROKE_ARC_DIVISIONS,
        `${STROKE_ARC_DIVISIONS} is an accepted stroke arc boundary`,
    );
    assert.ok(
        BOUNDARY_ASSET.geometry.vertices.every(Number.isFinite),
        `${STROKE_ARC_DIVISIONS} stroke arc divisions produce only finite vertex buffers`,
    );
    assert.ok(
        BOUNDARY_ASSET.geometry.indices instanceof Uint16Array && BOUNDARY_ASSET.geometry.indices.length % 3 === 0,
        `${STROKE_ARC_DIVISIONS} stroke arc divisions preserve complete triangle indices`,
    );
}
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            strokeArcDivisions: 0,
        }),
    /strokeArcDivisions/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            strokeArcDivisions: 65,
        }),
    /strokeArcDivisions/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            strokeArcDivisions: 1.5,
        }),
    /strokeArcDivisions/i,
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            strokeArcDivisions: null,
        }),
    /strokeArcDivisions/i,
    'explicit null is rejected instead of silently selecting the default',
);
assert.throws(
    () =>
        compileVectorAsset(SOURCE, SOURCE_PATH, {
            strokeArcDivisions: Number.MAX_SAFE_INTEGER + 1,
        }),
    /strokeArcDivisions/i,
    'unsafe arc subdivision integers are rejected',
);
const COLLAPSED_CURVE_METADATA = {
    schemaVersion: 1,
    id: 'collapsed-curve',
    defaultExpression: 'default',
    parts: [
        {
            id: 'body',
            parent: null,
            pivot: [0, 0],
        },
    ],
    expressions: {
        default: {
            show: [],
            hide: [],
        },
    },
    sockets: {},
    clips: {
        idle: {
            durationMs: 100,
            loop: 'repeat',
            easing: 'linear',
            keyframes: [
                {
                    timeMs: 0,
                    easing: 'linear',
                    parts: {},
                },
                {
                    timeMs: 100,
                    easing: 'linear',
                    parts: {},
                },
            ],
        },
    },
};
const COLLAPSED_CURVE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><metadata id="vector-asset">${JSON.stringify(COLLAPSED_CURVE_METADATA)}</metadata><g id="body"><path id="body-shape" d="M0 0 C0 0 0 0 0 0 Z" fill="#f00"/></g></svg>`;
assert.throws(
    () =>
        compileVectorAsset(Buffer.from(COLLAPSED_CURVE_SVG), 'collapsed-curve.svg', {
            curveSegments: 1,
        }),
    /at this tessellation; increase the selected subdivision/,
    'an all-degenerate low-quality SVG fails with a clear instruction to raise tessellation',
);
const NON_SCALING_STROKE_SOURCE_PATH = 'modules/vector-assets/tests/non-scaling-stroke.svg';
const NON_SCALING_STROKE_SOURCE_BYTES = await readFile(NON_SCALING_STROKE_SOURCE_PATH);
const NON_SCALING_DEFAULT_ASSET = compileVectorAsset(NON_SCALING_STROKE_SOURCE_BYTES, NON_SCALING_STROKE_SOURCE_PATH);
const NON_SCALING_ARC8_ASSET = compileVectorAsset(NON_SCALING_STROKE_SOURCE_BYTES, NON_SCALING_STROKE_SOURCE_PATH, {
    strokeArcDivisions: 8,
});
assert.deepEqual(
    compileVectorAsset(NON_SCALING_STROKE_SOURCE_BYTES, NON_SCALING_STROKE_SOURCE_PATH, {
        curveSegments: 4,
        strokeArcDivisions: 2,
    }).geometry,
    NON_SCALING_DEFAULT_ASSET.geometry,
    'explicit default arc divisions preserve custom non-scaling round caps exactly',
);
assert.notDeepEqual(
    NON_SCALING_ARC8_ASSET.geometry,
    NON_SCALING_DEFAULT_ASSET.geometry,
    'non-scaling round caps use the selected arc subdivision',
);
const CLI = spawnSync(
    process.execPath,
    ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--curve-segments', '8'],
    {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    },
);
assert.equal(CLI.status, 0, CLI.stderr);
assert.equal(
    JSON.parse(CLI.stdout).compilerOptions.curveSegments,
    8,
    'CLI exposes the same recorded tessellation contract',
);
const ARC_CLI = spawnSync(
    process.execPath,
    ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--stroke-arc-divisions', '8'],
    {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    },
);
assert.equal(ARC_CLI.status, 0, ARC_CLI.stderr);
assert.equal(
    JSON.parse(ARC_CLI.stdout).compilerOptions.strokeArcDivisions,
    8,
    'CLI exposes the recorded stroke tessellation contract',
);
const LEGACY_CLI = spawnSync(
    process.execPath,
    [
        'modules/vector-assets/scripts/compile.mjs',
        SOURCE_PATH,
        '--curve-segments',
        '16',
        '--stroke-arc-divisions',
        '12',
    ],
    {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    },
);
assert.equal(LEGACY_CLI.status, 0, LEGACY_CLI.stderr);
assert.deepEqual(
    JSON.parse(LEGACY_CLI.stdout).compilerOptions,
    {
        curveSegments: 16,
        normalizeCenteredViewBox: false,
        strokeArcDivisions: 12,
    },
    'CLI still supports the previous explicit 16/12 tessellation',
);
const INVALID_ARC_CLI = spawnSync(
    process.execPath,
    ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--stroke-arc-divisions', '0'],
    {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    },
);
assert.notEqual(INVALID_ARC_CLI.status, 0, 'CLI rejects stroke arc values below the documented boundary');
const INVALID_CLI = spawnSync(
    process.execPath,
    ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--curve-segments', '0'],
    {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    },
);
assert.notEqual(INVALID_CLI.status, 0, 'CLI rejects values below the documented boundary');
for (const CURVE_SEGMENTS of [1, 2, 3, 64]) {
    const RESULT = spawnSync(
        process.execPath,
        ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--curve-segments', String(CURVE_SEGMENTS)],
        {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    );
    assert.equal(RESULT.status, 0, RESULT.stderr);
    assert.equal(
        JSON.parse(RESULT.stdout).compilerOptions.curveSegments,
        CURVE_SEGMENTS,
        'CLI accepts the requested low values and upper boundary',
    );
}
for (const VALUE of [1.5, 65]) {
    const RESULT = spawnSync(
        process.execPath,
        ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--curve-segments', String(VALUE)],
        {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    );
    assert.notEqual(RESULT.status, 0, `CLI rejects invalid curve subdivision ${VALUE}`);
}
for (const STROKE_ARC_DIVISIONS of [1, 2, 3, 64]) {
    const RESULT = spawnSync(
        process.execPath,
        [
            'modules/vector-assets/scripts/compile.mjs',
            SOURCE_PATH,
            '--stroke-arc-divisions',
            String(STROKE_ARC_DIVISIONS),
        ],
        {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    );
    assert.equal(RESULT.status, 0, RESULT.stderr);
    assert.equal(
        JSON.parse(RESULT.stdout).compilerOptions.strokeArcDivisions,
        STROKE_ARC_DIVISIONS,
        'CLI accepts low round-stroke values and the upper boundary',
    );
}
for (const VALUE of [1.5, 65]) {
    const RESULT = spawnSync(
        process.execPath,
        ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--stroke-arc-divisions', String(VALUE)],
        {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    );
    assert.notEqual(RESULT.status, 0, `CLI rejects invalid stroke subdivision ${VALUE}`);
}
for (const ARGS of [['8.5'], ['0x10'], ['8', '--curve-segments', '9']]) {
    const RESULT = spawnSync(
        process.execPath,
        ['modules/vector-assets/scripts/compile.mjs', SOURCE_PATH, '--curve-segments', ...ARGS],
        {
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    );
    assert.notEqual(RESULT.status, 0, `CLI rejects malformed tessellation arguments: ${ARGS.join(' ')}`);
}
const SPARSE_EXPRESSION_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><metadata id="vector-asset">${JSON.stringify(
    {
        schemaVersion: 1,
        id: 'sparse-expression-fixture',
        defaultExpression: 'default',
        parts: [
            {
                id: 'body',
                parent: null,
                pivot: [0, 0],
            },
            {
                id: 'eyes',
                parent: 'body',
                pivot: [0, 0],
            },
        ],
        expressions: {
            default: {
                show: [],
                hide: [],
            },
            hidden: {
                show: [],
                hide: ['eyes'],
            },
        },
        sockets: {},
        clips: {
            idle: {
                durationMs: 100,
                loop: 'repeat',
                easing: 'linear',
                keyframes: [
                    {
                        timeMs: 0,
                        easing: 'linear',
                        parts: {},
                    },
                    {
                        timeMs: 100,
                        easing: 'linear',
                        parts: {},
                    },
                ],
            },
        },
    },
)}</metadata><g id="body"><rect id="body-shape" x="0" y="0" width="20" height="20" fill="#f00"/><g id="eyes"><circle id="eyes-shape" cx="10" cy="10" r="3" fill="#00f"/></g></g></svg>`;
const SPARSE_EXPRESSION_ASSET = compileVectorAsset(Buffer.from(SPARSE_EXPRESSION_SVG), 'sparse-expression-fixture.svg');
const EYES_PART = SPARSE_EXPRESSION_ASSET.metadata.parts.findIndex((part) => part.id === 'eyes');
assert.ok(
    [...SPARSE_EXPRESSION_ASSET.geometry.expressionIndices.default].some(
        (index) => SPARSE_EXPRESSION_ASSET.geometry.vertices[index * 11 + 10] === EYES_PART,
    ),
    'an expression variant keeps an omitted part because the initial player state leaves it visible',
);
const CENTERED_SOURCE = await readFile('modules/vector-assets/tests/centered-viewbox.svg');
const CENTERED_TEXT = CENTERED_SOURCE.toString('utf8');
const CENTERED_ROOT = /<svg\b[^>]*>/.exec(CENTERED_TEXT)?.[0];
const CENTERED_METADATA_BLOCK = /<metadata\s+id="vector-asset">([\s\S]*?)<\/metadata>/.exec(CENTERED_TEXT);
assert.ok(CENTERED_ROOT && CENTERED_METADATA_BLOCK, 'centered fixture has a root viewport and vector metadata');
const CENTERED_VIEW_BOX = CENTERED_ROOT.match(/\bviewBox="([^"]+)"/)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
const NORMALIZED_METADATA = JSON.parse(CENTERED_METADATA_BLOCK[1]);
for (const CLIP of Object.values(NORMALIZED_METADATA.clips)) {
    for (const FRAME of CLIP.keyframes) {
        for (const [PART, POSE] of Object.entries(FRAME.parts)) {
            if (POSE && typeof POSE === 'object' && !Array.isArray(POSE) && Object.keys(POSE).length === 0) {
                delete FRAME.parts[PART];
            }
        }
    }
}
const QUOTE = String.fromCharCode(34);
const NORMALIZED_ROOT = CENTERED_ROOT.replace(/\bwidth="[^"]+"/, `width=${QUOTE}${CENTERED_VIEW_BOX[2]}${QUOTE}`)
    .replace(/\bheight="[^"]+"/, `height=${QUOTE}${CENTERED_VIEW_BOX[3]}${QUOTE}`)
    .replace(/\bviewBox="[^"]+"/, `viewBox=${QUOTE}0 0 ${CENTERED_VIEW_BOX[2]} ${CENTERED_VIEW_BOX[3]}${QUOTE}`);
const NORMALIZED_SOURCE = CENTERED_TEXT.replace(CENTERED_ROOT, NORMALIZED_ROOT).replace(
    CENTERED_METADATA_BLOCK[0],
    `<metadata id=${QUOTE}vector-asset${QUOTE}>${JSON.stringify(NORMALIZED_METADATA)}</metadata>`,
);
const CENTERED_EXPECTED_HASH = createHash('sha256').update(CENTERED_SOURCE).digest('hex');
const CENTERED_ASSET = compileVectorAsset(CENTERED_SOURCE, 'centered-viewbox.svg', {
    normalizeCenteredViewBox: true,
});
const LEGACY_NORMALIZED_ASSET = compileVectorAsset(NORMALIZED_SOURCE, 'centered-viewbox.svg');
validateCompiledAsset(CENTERED_ASSET);
assert.deepEqual(
    CENTERED_ASSET.viewBox,
    [-36, -40, 72, 80],
    'normalization preserves the original centered viewBox for the host renderer',
);
assert.equal(
    CENTERED_ASSET.sourceSha256,
    CENTERED_EXPECTED_HASH,
    'compiled source provenance hashes the original, unnormalized bytes',
);
assert.deepEqual(
    CENTERED_ASSET.geometry,
    LEGACY_NORMALIZED_ASSET.geometry,
    'all retained geometry and clip part assignments match the existing Bounko normalization',
);
assert.deepEqual(
    CENTERED_ASSET.sourcePaths,
    LEGACY_NORMALIZED_ASSET.sourcePaths,
    'path provenance is unaffected by centered viewport normalization',
);
assert.deepEqual(
    CENTERED_ASSET.metadata,
    LEGACY_NORMALIZED_ASSET.metadata,
    'parts, pivots, sockets, and non-empty clip transforms match the old normalizer',
);
assert.deepEqual(
    CENTERED_ASSET.metadata.parts.map((part) => part.pivot),
    [
        [0, 0],
        [-12, 2],
        [-12, -14],
    ],
);
assert.deepEqual(CENTERED_ASSET.metadata.sockets, {
    origin: {
        part: 'body',
        point: [0, 0],
    },
    grip: {
        part: 'hand',
        point: [-12, -18],
    },
});
assert.deepEqual(
    CENTERED_ASSET.metadata.clips.test.keyframes[1].parts,
    {},
    'empty no-op poses are removed without dropping their keyframe',
);
assert.deepEqual(
    CENTERED_ASSET.metadata.clips.test.keyframes[2].parts.arm,
    {
        rotation: 0.45,
    },
    'non-empty clip transforms remain authored',
);
assert.throws(
    () => compileVectorAsset(CENTERED_SOURCE, 'centered-viewbox.svg'),
    /viewBox/i,
    'centered viewport compatibility stays explicit and does not broaden the default compiler contract',
);
let centeredLoaderFetches = 0;
const CENTERED_LOADER = createVectorAssetLoader({
    fetch: async () => {
        centeredLoaderFetches++;
        return new Response(CENTERED_SOURCE, {
            status: 200,
        });
    },
});
const CENTERED_LOAD_OPTIONS = {
    sourcePath: 'centered-viewbox.svg',
    expectedSha256: CENTERED_EXPECTED_HASH,
    maxBytes: CENTERED_SOURCE.byteLength,
    normalizeCenteredViewBox: true,
};
const CENTERED_LOADED = await CENTERED_LOADER.load('/startup/centered.svg', CENTERED_LOAD_OPTIONS);
assert.deepEqual(
    CENTERED_LOADED.geometry,
    CENTERED_ASSET.geometry,
    'browser startup and Node compiler share the centered-viewBox normalization core',
);
assert.deepEqual(CENTERED_LOADED.viewBox, [-36, -40, 72, 80]);
assert.equal(CENTERED_LOADED.sourceSha256, CENTERED_EXPECTED_HASH);
await assert.rejects(
    CENTERED_LOADER.load('/startup/centered.svg', {
        ...CENTERED_LOAD_OPTIONS,
        normalizeCenteredViewBox: false,
    }),
    /viewBox/i,
    'the cache key separates legacy-normalized and strict compiler contracts',
);
assert.equal(CENTERED_LOADER.size, 1);
const BAD_CENTERED_LOADER = createVectorAssetLoader({
    fetch: async () =>
        new Response(CENTERED_SOURCE, {
            status: 200,
        }),
});
await assert.rejects(
    BAD_CENTERED_LOADER.load('/startup/centered.svg', {
        ...CENTERED_LOAD_OPTIONS,
        expectedSha256: '0'.repeat(64),
    }),
    /SHA-256 mismatch/,
);
assert.equal(BAD_CENTERED_LOADER.size, 0, 'an incorrect original-byte hash rejects before normalization and caching');
assert.equal(centeredLoaderFetches, 2, 'a distinct compiler normalization mode receives its own fetch/compile key');
CENTERED_LOADER.dispose();
BAD_CENTERED_LOADER.dispose();
const COMBINED_ASSET_GEOMETRY = MeshBuilder.combine([ASSET.geometry, ASSET.geometry]);
assert.equal(COMBINED_ASSET_GEOMETRY.partCount, 14);
assert.equal(
    COMBINED_ASSET_GEOMETRY.indices.length,
    ASSET.geometry.indices.length * 2,
    'combining indexed assets offsets each source index',
);
assert.ok(
    COMBINED_ASSET_GEOMETRY.indices
        .slice(ASSET.geometry.indices.length)
        .some((index) => index >= ASSET.geometry.vertices.length / 11),
    'the second combined asset references its own remapped vertex range',
);
assert.ok(
    LEGACY_ASSET.geometry.vertices.byteLength > 100_000,
    'the prior explicit 16/12 geometry fixture remains available',
);
assert.ok(
    ASSET.geometry.vertices.byteLength < LEGACY_ASSET.geometry.vertices.byteLength,
    'the standard preset retains fewer initial vertex bytes than the explicit legacy 16/12 quality',
);
assert.equal(ASSET.metadata.parts.find((part) => part.id === 'leaf-left').parent, 'sprout');
assert.ok(ASSET.metadata.clips.idle.keyframes.length >= 3);
assert.ok(ASSET.metadata.sockets.mouth);
const YARN_ASSET = await compileVectorAssetFile('modules/vector-assets/assets/yarn-fox.svg');
const SKETCH_ASSET = await compileVectorAssetFile('modules/vector-assets/assets/sketch-fox.svg');
assert.equal(YARN_ASSET.metadata.styles[0].kind, 'yarn');
assert.equal(YARN_ASSET.geometry.morphCount, 0, 'yarn stitches/fibers are static retained vector geometry');
assert.ok(YARN_ASSET.geometry.vertices.byteLength < 4_000_000, 'yarn texture stays bounded as vector triangles');
assert.equal(YARN_ASSET.geometry.indices.length % 3, 0);
assert.ok(
    YARN_ASSET.geometry.vertices.some((value, index) => index % 11 === 2 && value > 0.9) &&
        YARN_ASSET.geometry.vertices.some((value, index) => index % 11 === 2 && value < 0.2),
    'linear gradient is split at stops and stored as vertex RGB',
);
assert.ok(
    YARN_ASSET.geometry.vertices.some((value, index) => index % 11 === 5 && value > 0.6),
    'gradient stop alpha reaches the compiled mesh',
);
assert.equal(SKETCH_ASSET.metadata.styles[0].kind, 'sketch');
assert.equal(SKETCH_ASSET.geometry.morphCount, 2, 'sketch boil compiles two deterministic morph targets');
assert.ok(
    SKETCH_ASSET.geometry.vertices.some((value, index) => index % 11 === 6 && Math.abs(value) > 1e-6),
    'sketch mesh contains authored morph deltas',
);
const SKETCH_AGAIN = await compileVectorAssetFile('modules/vector-assets/assets/sketch-fox.svg');
assert.deepEqual(
    SKETCH_AGAIN.geometry.vertices,
    SKETCH_ASSET.geometry.vertices,
    'sketch geometry generation is deterministic',
);
const SHADER_SURFACE_SVG = await readFile('modules/vector-assets/tests/world-shader.svg', 'utf8');
const SHADER_SURFACE_ASSET = compileVectorAsset(Buffer.from(SHADER_SURFACE_SVG), 'shader-surface-fixture.svg');
validateCompiledAsset(SHADER_SURFACE_ASSET);
assert.equal(SHADER_SURFACE_ASSET.compilerVersion, '0.12.0');
assert.equal(
    SHADER_SURFACE_ASSET.geometry.morphCount,
    0,
    'shader-backed sketch/yarn do not generate dynamic mesh morph data',
);
assert.equal(SHADER_SURFACE_ASSET.geometry.shaderSurfaces, undefined, 'surfaces are mesh triangles, not a second list');
assert.equal(SHADER_SURFACE_ASSET.geometry.drawOrder, undefined, 'painter order is the index order');
const MATERIALS = SHADER_SURFACE_ASSET.geometry.materials;
assert.equal(MATERIALS.table.length, 20, 'one surface is one five-vec4 record');
assert.equal(
    MATERIALS.vertices.length,
    (SHADER_SURFACE_ASSET.geometry.vertices.length / 11) * 4,
    'every vertex has a material record',
);
// Ordinary rectangles paint before and after the surface; the surface is a fill run followed by its edge strip.
const KIND_OF_TRIANGLE = (triangle) => MATERIALS.vertices[SHADER_SURFACE_ASSET.geometry.indices[triangle * 3] * 4];
const TRIANGLE_KINDS = Array.from({ length: SHADER_SURFACE_ASSET.geometry.indices.length / 3 }, (_, index) =>
    KIND_OF_TRIANGLE(index),
);
assert.deepEqual(TRIANGLE_KINDS.slice(0, 2), [0, 0], 'ordinary geometry paints before the surface');
assert.deepEqual(TRIANGLE_KINDS.slice(-2), [0, 0], 'ordinary geometry paints after the surface');
const SURFACE_KINDS = TRIANGLE_KINDS.slice(2, -2);
const FIRST_EDGE = SURFACE_KINDS.findIndex((kind) => kind === 2 || kind === 4);
assert.ok(FIRST_EDGE > 0, 'the surface fill precedes its contour strip');
assert.ok(
    SURFACE_KINDS.slice(0, FIRST_EDGE).every((kind) => kind === 1 || kind === 3) &&
        SURFACE_KINDS.slice(FIRST_EDGE).every((kind) => kind === 2 || kind === 4),
    'fill triangles then edge triangles, nothing else between the ordinary rectangles',
);
assert.throws(
    () =>
        validateCompiledAsset({
            ...SHADER_SURFACE_ASSET,
            geometry: { ...SHADER_SURFACE_ASSET.geometry, shaderSurfaces: [] },
        }),
    /compile the SVG again/i,
    'assets compiled with the old surface list are rejected instead of drawn wrongly',
);
const BAD_MATERIAL_VERTICES = MATERIALS.vertices.slice();
BAD_MATERIAL_VERTICES[(SHADER_SURFACE_ASSET.geometry.vertices.length / 11 - 1) * 4] = 9;
assert.throws(
    () =>
        validateCompiledAsset({
            ...SHADER_SURFACE_ASSET,
            geometry: {
                ...SHADER_SURFACE_ASSET.geometry,
                materials: { ...MATERIALS, vertices: BAD_MATERIAL_VERTICES },
            },
        }),
    /material/i,
    'an unknown material kind is rejected',
);
const SHADER_ONLY_SVG = SHADER_SURFACE_SVG.replace(/\s*<rect id="under"[^>]*\/>/, '').replace(
    /\s*<rect id="over"[^>]*\/>/,
    '',
);
const SHADER_ONLY_ASSET = compileVectorAsset(Buffer.from(SHADER_ONLY_SVG), 'shader-only-fixture.svg');
validateCompiledAsset(SHADER_ONLY_ASSET);
assert.ok(
    SHADER_ONLY_ASSET.geometry.vertices.length >= 33 &&
        Array.from(
            SHADER_ONLY_ASSET.geometry.indices,
            (index) => SHADER_ONLY_ASSET.geometry.materials.vertices[index * 4],
        ).every((kind) => kind >= 1),
    'a surface-only asset is a mesh made only of material triangles',
);
assert.throws(
    () =>
        compileVectorAsset(
            Buffer.from(SHADER_SURFACE_SVG.replace('"backend":"shader"', '"backend":"software-fallback"')),
            'unsupported-style-backend.svg',
        ),
    /backend/i,
    'unsupported style backends fail instead of silently selecting baked triangles',
);
const NON_SCALING_LINE = await compileVectorAssetFile('modules/vector-assets/tests/non-scaling-stroke.svg');
const LEGACY_NON_SCALING_LINE = await compileVectorAssetFile(
    'modules/vector-assets/tests/non-scaling-stroke.svg',
    'modules/vector-assets/tests/non-scaling-stroke.svg',
    {
        curveSegments: 16,
        strokeArcDivisions: 12,
    },
);
validateCompiledAsset(NON_SCALING_LINE);
assert.equal(NON_SCALING_LINE.geometry.nonScalingStroke, true, 'non-scaling line stroke metadata is retained');
assert.equal(NON_SCALING_LINE.geometry.morphCount, 0, 'non-scaling stroke does not repurpose morph data');
assert.equal(NON_SCALING_LINE.geometry.strideFloats, 11, 'the existing mesh record layout remains unchanged');
assert.equal(
    NON_SCALING_LINE.geometry.indices.length,
    24,
    'standard 4/2 quality retains round line caps with the SVG fill triangles',
);
assert.equal(
    LEGACY_NON_SCALING_LINE.geometry.indices.length,
    84,
    'explicit 16/12 quality retains the previous round line cap geometry',
);
let lineVertexCount = 0;
let fillVertexCount = 0;
for (let index = 0; index < NON_SCALING_LINE.geometry.vertices.length; index += 11) {
    const TANGENT_LENGTH = Math.hypot(
        NON_SCALING_LINE.geometry.vertices[index + 6],
        NON_SCALING_LINE.geometry.vertices[index + 7],
    );
    if (TANGENT_LENGTH < 0.9) {
        fillVertexCount++;
        assert.equal(TANGENT_LENGTH, 0, 'ordinary SVG fill vertices have no screen-stroke marker');
        continue;
    }
    lineVertexCount++;
    assert.ok(Math.abs(TANGENT_LENGTH - 1) < 1e-6, 'each expanded line vertex retains a normalized tangent');
    const RADIUS = Math.hypot(
        NON_SCALING_LINE.geometry.vertices[index + 8],
        NON_SCALING_LINE.geometry.vertices[index + 9],
    );
    assert.ok(
        RADIUS < 1e-6 || Math.abs(RADIUS - 0.75) < 1e-6,
        'stroke outline offsets are authored in CSS-pixel units',
    );
}
assert.ok(
    lineVertexCount > 0 && fillVertexCount > 0,
    'one retained vector mesh can carry both non-scaling lines and ordinary SVG fills',
);
const NON_SCALING_SOURCE = await readFile('modules/vector-assets/tests/non-scaling-stroke.svg', 'utf8');
assert.throws(
    () =>
        compileVectorAsset(
            Buffer.from(NON_SCALING_SOURCE.replace('<line id="crack"', '<path id="crack" d="M20 50 L80 50"')),
            'unsupported-vector-effect.svg',
        ),
    /only <line>/i,
    'unsupported path outlines fail explicitly instead of falling back to a scaling stroke',
);
assert.throws(
    () =>
        compileVectorAsset(
            Buffer.from(NON_SCALING_SOURCE.replace('non-scaling-stroke"', 'scale-stroke"')),
            'unsupported-vector-effect-value.svg',
        ),
    /Unsupported SVG vector-effect/i,
    'unknown vector-effect values fail compilation',
);
const BUTT_CAP_ASSET = compileVectorAsset(
    Buffer.from(NON_SCALING_SOURCE.replace('stroke-linecap="round"', 'stroke-linecap="butt"')),
    'non-scaling-butt-cap.svg',
);
const SQUARE_CAP_ASSET = compileVectorAsset(
    Buffer.from(NON_SCALING_SOURCE.replace('stroke-linecap="round"', 'stroke-linecap="square"')),
    'non-scaling-square-cap.svg',
);
assert.equal(
    BUTT_CAP_ASSET.geometry.indices.length,
    12,
    'butt caps keep a two-triangle static line body beside the fill triangles',
);
assert.equal(
    SQUARE_CAP_ASSET.geometry.indices.length,
    12,
    'square caps keep a two-triangle static line body beside the fill triangles',
);
assert.ok(
    SQUARE_CAP_ASSET.geometry.vertices.some((value, index) => index % 11 === 8 && Math.abs(value) >= 0.75),
    'square caps extend their retained geometry by half the authored width',
);
const REJECT = (fragment, message, replacement = '') => {
    assert.throws(
        () => compileVectorAsset(Buffer.from(SOURCE.toString('utf8').replace(fragment, replacement)), 'invalid.svg'),
        message,
    );
};
REJECT('<g id="body">', /metadata|part|id/i, '<g id="body-renamed">');
REJECT('<g id="body">', /Script|foreignObject|raster/i, '<script>alert(1)</script><g id="body">');
REJECT('<g id="body">', /Script|foreignObject|raster/i, '<foreignObject></foreignObject><g id="body">');
REJECT('<g id="body">', /Script|foreignObject|raster/i, '<image href="data:image/png;base64,AA=="/><g id="body">');
REJECT('<g id="body">', /external reference/i, '<g id="body" data="https://example.test/art.svg">');
REJECT('<g id="body">', /Unsupported SVG element/i, '<text id="unsupported">x</text><g id="body">');
REJECT('id="body-outline"', /unique/i, 'id="body"');
REJECT('"schemaVersion": 1,', /valid JSON/i, '"schemaVersion": nope,');
REJECT('id="vector-asset"', /metadata#vector-asset/i, 'id="author-notes"');
const YARN_SOURCE = await readFile('modules/vector-assets/assets/yarn-fox.svg', 'utf8');
const YARN_METADATA = /<metadata id="vector-asset">([\s\S]*?)<\/metadata>/.exec(YARN_SOURCE)?.[1];
assert.ok(YARN_METADATA, 'the yarn fixture retains its authored metadata');
const YARN_EDGE_METADATA = YARN_METADATA.replace('"pattern":true', '"pattern":false').replace(
    '"fiber":true',
    '"fiber":false',
);
const YARN_EDGE_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><metadata id="vector-asset">${YARN_EDGE_METADATA}</metadata><defs><linearGradient id="yarn-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.53" stop-color="#888888"/><stop offset="1" stop-color="#000000"/></linearGradient></defs><g id="body"><path id="yarn-shell" fill="url(#yarn-gradient)" d="M0 0 H100 V100 H0 Z"/></g></svg>`;
const YARN_EDGE_ASSET = compileVectorAsset(Buffer.from(YARN_EDGE_SOURCE), 'yarn-gradient-edge.svg');
const YARN_VERTICES = YARN_EDGE_ASSET.geometry.vertices;
const DARK_EDGE_SAMPLES = [];
for (let index = 0; index < YARN_VERTICES.length; index += 11) {
    if (Math.abs(YARN_VERTICES[index + 5] - 0.7) < 0.01) {
        DARK_EDGE_SAMPLES.push({
            x: YARN_VERTICES[index],
            red: YARN_VERTICES[index + 2],
        });
    }
}
const LEFT_EDGE_RED = DARK_EDGE_SAMPLES.filter((sample) => sample.x < 15).map((sample) => sample.red);
const RIGHT_EDGE_RED = DARK_EDGE_SAMPLES.filter((sample) => sample.x > 85).map((sample) => sample.red);
assert.ok(
    LEFT_EDGE_RED.length && RIGHT_EDGE_RED.length,
    'the yarn edge fixtures produce dark pass vertices on both gradient ends',
);
assert.ok(
    Math.min(...LEFT_EDGE_RED) > Math.max(...RIGHT_EDGE_RED) + 0.25,
    'yarn edge-loop palette follows the authored gradient position instead of sampling one midpoint color',
);
let gradientBandsChecked = 0;
for (let index = 0; index < YARN_EDGE_ASSET.geometry.indices.length; index += 3) {
    const VERTICES = [0, 1, 2].map((corner) => YARN_EDGE_ASSET.geometry.indices[index + corner] * 11);
    if (!VERTICES.every((vertex) => Math.abs(YARN_VERTICES[vertex + 5] - 0.7) < 0.01)) {
        continue;
    }
    const T = VERTICES.map((vertex) => YARN_VERTICES[vertex] / 100);
    assert.ok(
        Math.max(...T) <= 0.53 + 1e-5 || Math.min(...T) >= 0.53 - 1e-5,
        `each yarn edge triangle stays within one authored gradient stop band: ${JSON.stringify(T)}`,
    );
    gradientBandsChecked++;
}
assert.ok(gradientBandsChecked > 0, 'yarn edge geometry is subdivided at the middle gradient stop');
const YARN_ALPHA_SOURCE = YARN_EDGE_SOURCE.replace(
    'offset="0" stop-color="#ffffff"',
    'offset="0" stop-color="#ffffff" stop-opacity="1"',
)
    .replace('offset="0.53" stop-color="#888888"', 'offset="0.53" stop-color="#888888" stop-opacity="0.5"')
    .replace('offset="1" stop-color="#000000"', 'offset="1" stop-color="#000000" stop-opacity="0.25"');
const YARN_ALPHA_VERTICES = compileVectorAsset(Buffer.from(YARN_ALPHA_SOURCE), 'yarn-gradient-alpha.svg').geometry
    .vertices;
const LEFT_DARK_ALPHA = [],
    RIGHT_DARK_ALPHA = [];
for (let index = 0; index < YARN_ALPHA_VERTICES.length; index += 11) {
    const X = YARN_ALPHA_VERTICES[index],
        ALPHA = YARN_ALPHA_VERTICES[index + 5];
    if (X < 2 && Math.abs(ALPHA - 0.7) < 0.01) {
        LEFT_DARK_ALPHA.push(ALPHA);
    }
    if (X > 98 && ALPHA > 0.16 && ALPHA < 0.19) {
        RIGHT_DARK_ALPHA.push(ALPHA);
    }
}
assert.ok(
    LEFT_DARK_ALPHA.length &&
        RIGHT_DARK_ALPHA.length &&
        Math.min(...LEFT_DARK_ALPHA) > Math.max(...RIGHT_DARK_ALPHA) * 3.5,
    'yarn thread alpha follows authored stop-opacity across the gradient',
);
assert.throws(
    () => compileVectorAsset(Buffer.from(YARN_SOURCE.replace('"fiberMax":155', '"fiberMax":999')), 'invalid.svg'),
    /fiberMax/i,
);
assert.throws(
    () =>
        compileVectorAsset(
            Buffer.from(YARN_SOURCE.replace('url(#yarn-gradient)', 'url(#missing-gradient)')),
            'invalid.svg',
        ),
    /unknown linearGradient/i,
);
assert.throws(
    () =>
        compileVectorAsset(
            Buffer.from(
                YARN_SOURCE.replace('<linearGradient id="yarn-gradient"', '<radialGradient id="yarn-gradient"').replace(
                    '</linearGradient>',
                    '</radialGradient>',
                ),
            ),
            'invalid.svg',
        ),
    /Unsupported SVG element/i,
);
const GRADIENT_METADATA = JSON.stringify({
    schemaVersion: 1,
    id: 'gradient-alpha',
    defaultExpression: 'neutral',
    parts: [
        {
            id: 'body',
            parent: null,
            pivot: [50, 50],
        },
    ],
    expressions: {
        neutral: {
            show: [],
            hide: [],
        },
    },
    sockets: {},
    clips: {
        idle: {
            durationMs: 1,
            loop: 'once',
            easing: 'linear',
            keyframes: [
                {
                    timeMs: 0,
                    easing: 'linear',
                    parts: {
                        body: {
                            x: 0,
                        },
                    },
                },
                {
                    timeMs: 1,
                    easing: 'linear',
                    parts: {
                        body: {
                            x: 0,
                        },
                    },
                },
            ],
        },
    },
});
const GRADIENT_FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><metadata id="vector-asset">${GRADIENT_METADATA}</metadata><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/><stop offset="0.53" stop-color="#888888"/><stop offset="1" stop-color="#000000" stop-opacity="0.25"/></linearGradient></defs><g id="body"><path id="ring" fill="url(#g)" fill-opacity="0.6" opacity="0.5" fill-rule="evenodd" d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z"/></g></svg>`;
const GRADIENT_FIXTURE_ASSET = compileVectorAsset(Buffer.from(GRADIENT_FIXTURE), 'gradient-alpha.svg');
const CURVED_GRADIENT_FIXTURE = GRADIENT_FIXTURE.replace(
    'd="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z"',
    'd="M10 50 Q10 10 50 10 Q90 10 90 50 Q90 90 50 90 Q10 90 10 50 Z"',
);
const CURVED_GRADIENT16 = compileVectorAsset(Buffer.from(CURVED_GRADIENT_FIXTURE), 'curved-gradient.svg', {
    curveSegments: 16,
});
const CURVED_GRADIENT8 = compileVectorAsset(Buffer.from(CURVED_GRADIENT_FIXTURE), 'curved-gradient.svg', {
    curveSegments: 8,
});
assert.ok(
    CURVED_GRADIENT8.geometry.indices.length < CURVED_GRADIENT16.geometry.indices.length,
    'curveSegments also controls gradient-fill tessellation without moving gradient object bounds',
);
const RING_ALPHA = [...GRADIENT_FIXTURE_ASSET.geometry.vertices].filter((_, index) => index % 11 === 5);
assert.ok(
    Math.min(...RING_ALPHA) >= 0.074 && Math.max(...RING_ALPHA) <= 0.301,
    'fill opacity, element opacity, and stop alpha multiply at vertices',
);
assert.ok(
    new Set(
        [...GRADIENT_FIXTURE_ASSET.geometry.vertices]
            .filter((_, index) => index % 11 === 2)
            .map((value) => value.toFixed(3)),
    ).size > 2,
    'gradient fill mesh contains interpolated vertex colors',
);
const TRANSFORMED_GRADIENT_FIXTURE = GRADIENT_FIXTURE.replace(
    'id="ring" fill=',
    'id="ring" transform="translate(4 6) rotate(90 50 50)" fill=',
);
const TRANSFORMED_GRADIENT_ASSET = compileVectorAsset(
    Buffer.from(TRANSFORMED_GRADIENT_FIXTURE),
    'gradient-transformed.svg',
);
assert.ok(
    TRANSFORMED_GRADIENT_ASSET.geometry.vertices.some((value, index) => index % 11 === 0 && value > 90) &&
        TRANSFORMED_GRADIENT_ASSET.geometry.vertices.some((value, index) => index % 11 === 1 && value > 90),
    'objectBoundingBox gradient target bounds are transformed with the path instead of using a world-axis-aligned box',
);
const EXPRESSION_VARIANT_BYTES = Object.values(ASSET.geometry.expressionIndices).reduce(
    (total, indices) => total + indices.byteLength,
    0,
);
console.log(
    JSON.stringify({
        status: 'PASS',
        sourceSha256: ASSET.sourceSha256,
        compiledVertices: ASSET.geometry.vertices.length / 11,
        expressionVariantBytes: EXPRESSION_VARIANT_BYTES,
        compiledBytes:
            ASSET.geometry.vertices.byteLength + ASSET.geometry.indices.byteLength + EXPRESSION_VARIANT_BYTES,
        expandedBytes: ASSET.geometry.indices.length * 44,
        checks: [
            'DOMParser round trip preserves metadata and all DOM ids',
            'Three SVGLoader Node compilation',
            'indexed retained triangle geometry',
            'linear gradient stops and alpha in retained triangles',
            'gradient-following yarn palette with stop-boundary color/alpha',
            'hole, stroke and gradient geometry',
            'scallop/two-loop yarn and boundary fibers',
            'two-target sketch morph geometry',
            'repeat compilation determinism',
            'bad ids and metadata',
            'scripts/foreignObject/raster/external refs/unknown elements rejected',
        ],
    }),
);

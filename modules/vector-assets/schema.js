import { validatePaintRegionData } from '../rendering/paint-regions.js';
import { MATERIAL_KIND, MATERIAL_RECORD_FLOATS, MAX_MATERIAL_SURFACES } from '../rendering/yarn-material-record.js';
export const VECTOR_ASSET_SCHEMA_VERSION = 1;
export const VECTOR_ASSET_COMPILER_VERSION = '0.12.0';
const ACCEPTED_COMPILER_VERSIONS = new Set([
    '0.2.0',
    '0.3.0',
    '0.4.0',
    '0.5.0',
    '0.6.0',
    '0.7.0',
    '0.8.0',
    '0.9.0',
    '0.10.0',
    '0.11.0',
    VECTOR_ASSET_COMPILER_VERSION,
]);
export const NUMERIC_POSE_FIELDS = Object.freeze(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']);
const EASINGS = new Set([
    'linear',
    'inSine',
    'outSine',
    'inOutSine',
    'inQuad',
    'outQuad',
    'inOutQuad',
    'inCubic',
    'outCubic',
    'inOutCubic',
]);
const IS_OBJECT = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const EXACT_KEYS = (value, keys) =>
    IS_OBJECT(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const FINITE = (value) => typeof value === 'number' && Number.isFinite(value);
function requireId(value, name) {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
        throw new TypeError(name + ' must be a stable SVG id');
    }
}
function requirePoint(value, name) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(FINITE)) {
        throw new TypeError(name + ' must be two finite numbers');
    }
}
export function validateAssetMetadata(metadata, idNodes) {
    const METADATA_KEYS = ['schemaVersion', 'id', 'defaultExpression', 'parts', 'expressions', 'sockets', 'clips'];
    if (
        !IS_OBJECT(metadata) ||
        ![METADATA_KEYS.length, METADATA_KEYS.length + 1].includes(Object.keys(metadata).length) ||
        METADATA_KEYS.some((key) => !Object.hasOwn(metadata, key)) ||
        Object.keys(metadata).some((key) => ![...METADATA_KEYS, 'styles'].includes(key)) ||
        metadata.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION
    ) {
        throw new TypeError('SVG metadata must use the exact vector asset schemaVersion 1 fields');
    }
    requireId(metadata.id, 'asset id');
    if (!Array.isArray(metadata.parts) || metadata.parts.length < 1 || metadata.parts.length > 16) {
        throw new RangeError('1..16 parts are supported');
    }
    const PARTS = new Map();
    for (const PART of metadata.parts) {
        if (!EXACT_KEYS(PART, ['id', 'parent', 'pivot'])) {
            throw new TypeError('part fields must be id, parent, and pivot');
        }
        requireId(PART.id, 'part id');
        if (PARTS.has(PART.id) || !idNodes.has(PART.id) || idNodes.get(PART.id).nodeName !== 'g') {
            throw new TypeError('part id must uniquely target an authored SVG g element: ' + PART.id);
        }
        if (PART.parent !== null) {
            requireId(PART.parent, 'part parent');
        }
        requirePoint(PART.pivot, 'part pivot');
        PARTS.set(PART.id, PART);
    }
    for (const PART of metadata.parts) {
        if (PART.parent !== null && !PARTS.has(PART.parent)) {
            throw new TypeError('unknown part parent: ' + PART.parent);
        }
        const SEEN = new Set([PART.id]);
        let parent = PART.parent;
        while (parent !== null) {
            if (SEEN.has(parent)) {
                throw new TypeError('part hierarchy contains a cycle: ' + PART.id);
            }
            SEEN.add(parent);
            parent = PARTS.get(parent).parent;
        }
    }
    if (!IS_OBJECT(metadata.expressions) || !Object.keys(metadata.expressions).length) {
        throw new TypeError('at least one expression variant is required');
    }
    if (
        typeof metadata.defaultExpression !== 'string' ||
        !Object.hasOwn(metadata.expressions, metadata.defaultExpression)
    ) {
        throw new TypeError('defaultExpression must name an expression variant');
    }
    for (const [NAME, EXPRESSION] of Object.entries(metadata.expressions)) {
        requireId(NAME, 'expression id');
        if (
            !EXACT_KEYS(EXPRESSION, ['show', 'hide']) ||
            !Array.isArray(EXPRESSION.show) ||
            !Array.isArray(EXPRESSION.hide)
        ) {
            throw new TypeError('expressions need show and hide part id arrays');
        }
        const SEEN = new Set();
        for (const ID of [...EXPRESSION.show, ...EXPRESSION.hide]) {
            requireId(ID, 'expression part id');
            if (!PARTS.has(ID) || SEEN.has(ID)) {
                throw new TypeError('expression references an unknown or repeated part: ' + ID);
            }
            SEEN.add(ID);
        }
    }
    if (!IS_OBJECT(metadata.sockets)) {
        throw new TypeError('sockets must be an object keyed by socket id');
    }
    for (const [NAME, SOCKET] of Object.entries(metadata.sockets)) {
        requireId(NAME, 'socket id');
        if (!EXACT_KEYS(SOCKET, ['part', 'point']) || !PARTS.has(SOCKET.part)) {
            throw new TypeError('socket must reference a known part');
        }
        requirePoint(SOCKET.point, 'socket point');
    }
    if (metadata.styles !== undefined) {
        if (!Array.isArray(metadata.styles) || metadata.styles.length > 128) {
            throw new RangeError('styles must contain at most 128 SVG target declarations');
        }
        const TARGETS = new Set();
        let sketchPeriod = null;
        for (const STYLE of metadata.styles) {
            if (!IS_OBJECT(STYLE) || typeof STYLE.target !== 'string') {
                throw new TypeError('A style target must name an SVG shape id');
            }
            requireId(STYLE.target, 'style target');
            if (
                TARGETS.has(STYLE.target) ||
                !idNodes.has(STYLE.target) ||
                !['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(
                    idNodes.get(STYLE.target).nodeName,
                )
            ) {
                throw new TypeError('Style targets must uniquely reference an authored SVG shape: ' + STYLE.target);
            }
            TARGETS.add(STYLE.target);
            if (STYLE.kind === 'yarn') {
                const REQUIRED = [
                    'target',
                    'kind',
                    'seed',
                    'stitchWidth',
                    'stitchHeight',
                    'thickness',
                    'irregularity',
                    'contrast',
                    'edgeSpacing',
                    'edgeRelief',
                    'edgeWidth',
                    'fiberLength',
                    'fiberWidth',
                    'fiberOpacity',
                    'fiberMax',
                ];
                const OPTIONAL = ['fiberSpacing', 'curved', 'pattern', 'detail', 'fiber', 'backend'];
                if (
                    !IS_OBJECT(STYLE) ||
                    REQUIRED.some((key) => !Object.hasOwn(STYLE, key)) ||
                    Object.keys(STYLE).some((key) => ![...REQUIRED, ...OPTIONAL].includes(key))
                ) {
                    throw new TypeError('Yarn style fields are incomplete or unsupported: ' + STYLE.target);
                }
                for (const KEY of [
                    'stitchWidth',
                    'stitchHeight',
                    'thickness',
                    'edgeSpacing',
                    'edgeRelief',
                    'edgeWidth',
                    'fiberLength',
                    'fiberWidth',
                    ...(STYLE.fiberSpacing === undefined ? [] : ['fiberSpacing']),
                ]) {
                    if (!FINITE(STYLE[KEY]) || STYLE[KEY] <= 0) {
                        throw new RangeError('Yarn ' + KEY + ' must be positive');
                    }
                }
                for (const KEY of ['irregularity', 'contrast', 'fiberOpacity']) {
                    if (!FINITE(STYLE[KEY]) || STYLE[KEY] < 0 || STYLE[KEY] > 1) {
                        throw new RangeError('Yarn ' + KEY + ' must be in [0,1]');
                    }
                }
                for (const KEY of ['curved', 'pattern', 'detail', 'fiber']) {
                    if (STYLE[KEY] !== undefined && typeof STYLE[KEY] !== 'boolean') {
                        throw new TypeError('Yarn ' + KEY + ' must be boolean');
                    }
                }
                if (STYLE.backend !== undefined && STYLE.backend !== 'shader') {
                    throw new TypeError('Yarn backend supports only the explicit shader value');
                }
                if (
                    !Number.isSafeInteger(STYLE.seed) ||
                    STYLE.seed < 0 ||
                    STYLE.seed > 0x7fffffff ||
                    !Number.isSafeInteger(STYLE.fiberMax) ||
                    STYLE.fiberMax < 0 ||
                    STYLE.fiberMax > 512
                ) {
                    throw new RangeError('Yarn seed/fiberMax is outside its bound');
                }
            } else if (STYLE.kind === 'sketch') {
                const REQUIRED = [
                    'target',
                    'kind',
                    'seed',
                    'periodMs',
                    'amplitude',
                    'frequency',
                    'echoX',
                    'echoY',
                    'echoWidth',
                    'echoOpacity',
                    'hatchAngle',
                    'hatchSpacing',
                    'hatchWidth',
                    'hatchOpacity',
                ];
                if (
                    !IS_OBJECT(STYLE) ||
                    REQUIRED.some((key) => !Object.hasOwn(STYLE, key)) ||
                    Object.keys(STYLE).some((key) => ![...REQUIRED, 'backend'].includes(key))
                ) {
                    throw new TypeError('Sketch style fields are incomplete or unsupported: ' + STYLE.target);
                }
                if (STYLE.backend !== undefined && STYLE.backend !== 'shader') {
                    throw new TypeError('Sketch backend supports only the explicit shader value');
                }
                for (const KEY of ['amplitude', 'frequency', 'echoWidth', 'hatchSpacing', 'hatchWidth']) {
                    if (!FINITE(STYLE[KEY]) || STYLE[KEY] <= 0) {
                        throw new RangeError('Sketch ' + KEY + ' must be positive');
                    }
                }
                for (const KEY of ['echoX', 'echoY', 'hatchAngle']) {
                    if (!FINITE(STYLE[KEY])) {
                        throw new TypeError('Sketch ' + KEY + ' must be finite');
                    }
                }
                for (const KEY of ['echoOpacity', 'hatchOpacity']) {
                    if (!FINITE(STYLE[KEY]) || STYLE[KEY] < 0 || STYLE[KEY] > 1) {
                        throw new RangeError('Sketch ' + KEY + ' must be in [0,1]');
                    }
                }
                if (
                    !Number.isSafeInteger(STYLE.seed) ||
                    STYLE.seed < 0 ||
                    STYLE.seed > 0x7fffffff ||
                    !Number.isSafeInteger(STYLE.periodMs) ||
                    STYLE.periodMs < 16 ||
                    STYLE.periodMs > 10000
                ) {
                    throw new RangeError('Sketch seed/periodMs is outside its bound');
                }
                if (sketchPeriod !== null && sketchPeriod !== STYLE.periodMs) {
                    throw new RangeError('All sketch targets in one SVG must share a periodMs');
                }
                sketchPeriod = STYLE.periodMs;
            } else {
                throw new TypeError('Unsupported authored style kind: ' + String(STYLE.kind));
            }
        }
    }
    if (!IS_OBJECT(metadata.clips) || !Object.keys(metadata.clips).length) {
        throw new TypeError('at least one authored clip is required');
    }
    for (const [NAME, CLIP] of Object.entries(metadata.clips)) {
        requireId(NAME, 'clip id');
        if (
            !EXACT_KEYS(CLIP, ['durationMs', 'loop', 'easing', 'keyframes']) ||
            !FINITE(CLIP.durationMs) ||
            CLIP.durationMs <= 0 ||
            !['once', 'repeat', 'alternate'].includes(CLIP.loop) ||
            !EASINGS.has(CLIP.easing) ||
            !Array.isArray(CLIP.keyframes) ||
            CLIP.keyframes.length < 2
        ) {
            throw new TypeError('clip fields, duration, loop, easing, or keyframes are unsupported: ' + NAME);
        }
        let previousTime = -1;
        for (const FRAME of CLIP.keyframes) {
            if (
                !EXACT_KEYS(FRAME, ['timeMs', 'easing', 'parts']) ||
                !FINITE(FRAME.timeMs) ||
                FRAME.timeMs <= previousTime ||
                !EASINGS.has(FRAME.easing) ||
                !IS_OBJECT(FRAME.parts)
            ) {
                throw new TypeError('keyframe fields, time, or easing are invalid: ' + NAME);
            }
            for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
                if (!PARTS.has(PART_ID) || !IS_OBJECT(POSE) || !Object.keys(POSE).length) {
                    throw new TypeError('keyframe targets an unknown part or empty pose: ' + PART_ID);
                }
                for (const [FIELD, VALUE] of Object.entries(POSE)) {
                    if (!NUMERIC_POSE_FIELDS.includes(FIELD) || !FINITE(VALUE)) {
                        throw new TypeError('keyframe may only animate finite numeric pose fields');
                    }
                    if (FIELD === 'opacity' && (VALUE < 0 || VALUE > 1)) {
                        throw new RangeError('part opacity must be in [0,1]');
                    }
                }
            }
            previousTime = FRAME.timeMs;
        }
        if (CLIP.keyframes[0].timeMs !== 0 || previousTime !== CLIP.durationMs) {
            throw new RangeError('clip keyframes must start at 0 and end at durationMs: ' + NAME);
        }
    }
    return metadata;
}
export function validateCompiledAsset(asset) {
    if (
        !IS_OBJECT(asset) ||
        asset.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION ||
        !ACCEPTED_COMPILER_VERSIONS.has(asset.compilerVersion) ||
        typeof asset.sourceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(asset.sourceSha256) ||
        !IS_OBJECT(asset.metadata) ||
        !IS_OBJECT(asset.geometry) ||
        !(asset.geometry.vertices instanceof Float32Array) ||
        asset.geometry.vertices.length < 33 ||
        asset.geometry.vertices.length % 11 ||
        asset.geometry.strideFloats !== 11 ||
        (asset.geometry.nonScalingStroke !== undefined && typeof asset.geometry.nonScalingStroke !== 'boolean') ||
        (asset.geometry.nonScalingStroke && asset.geometry.morphCount !== 0) ||
        asset.geometry.partCount !== asset.metadata.parts?.length ||
        ![0, 2].includes(asset.geometry.morphCount)
    ) {
        throw new TypeError('Invalid compiled SVG vector asset');
    }
    const VERTEX_COUNT = asset.geometry.vertices.length / 11,
        INDICES = asset.geometry.indices;
    if (
        INDICES !== undefined &&
        (!(INDICES instanceof Uint16Array) ||
            INDICES.length < 3 ||
            INDICES.length % 3 ||
            VERTEX_COUNT > 0x10000 ||
            INDICES.some((index) => index >= VERTEX_COUNT))
    ) {
        throw new TypeError('Invalid compiled SVG vertex indices');
    }
    if (INDICES === undefined && VERTEX_COUNT % 3) {
        throw new TypeError('Non-indexed compiled SVG geometry must contain complete triangles');
    }
    validatePaintRegionData(asset.geometry.paintRegions, VERTEX_COUNT, INDICES);
    if (
        ['0.8.0', '0.9.0', '0.10.0', VECTOR_ASSET_COMPILER_VERSION].includes(asset.compilerVersion) &&
        asset.compilerOptions === undefined
    ) {
        throw new TypeError('Current SVG compiler options are required');
    }
    if (asset.compilerOptions !== undefined) {
        const CURRENT = asset.compilerVersion === VECTOR_ASSET_COMPILER_VERSION;
        const ROUND_STROKE_VERSION = CURRENT || asset.compilerVersion === '0.10.0';
        const CENTERED_VIEW_BOX_VERSION = ROUND_STROKE_VERSION || asset.compilerVersion === '0.9.0';
        const EXPECTED_KEYS = ROUND_STROKE_VERSION
            ? ['curveSegments', 'normalizeCenteredViewBox', 'strokeArcDivisions']
            : CENTERED_VIEW_BOX_VERSION
              ? ['curveSegments', 'normalizeCenteredViewBox']
              : ['curveSegments'];
        if (
            !EXACT_KEYS(asset.compilerOptions, EXPECTED_KEYS) ||
            !Number.isSafeInteger(asset.compilerOptions.curveSegments) ||
            asset.compilerOptions.curveSegments < 1 ||
            asset.compilerOptions.curveSegments > 64 ||
            (CENTERED_VIEW_BOX_VERSION && typeof asset.compilerOptions.normalizeCenteredViewBox !== 'boolean') ||
            (ROUND_STROKE_VERSION &&
                (!Number.isSafeInteger(asset.compilerOptions.strokeArcDivisions) ||
                    asset.compilerOptions.strokeArcDivisions < 1 ||
                    asset.compilerOptions.strokeArcDivisions > 64))
        ) {
            throw new TypeError('Invalid SVG compiler options');
        }
    }
    const EXPRESSION_INDICES = asset.geometry.expressionIndices;
    const INDEX_VARIANTS = asset.geometry.indexVariants;
    if (INDEX_VARIANTS !== undefined && !IS_OBJECT(INDEX_VARIANTS)) {
        throw new TypeError('Invalid compiled SVG index variants');
    }
    if (EXPRESSION_INDICES !== undefined) {
        if (!IS_OBJECT(EXPRESSION_INDICES)) {
            throw new TypeError('Invalid compiled SVG expression indices');
        }
        for (const [NAME, VARIANT] of Object.entries(EXPRESSION_INDICES)) {
            if (
                !Object.hasOwn(asset.metadata.expressions ?? {}, NAME) ||
                !(VARIANT instanceof Uint16Array) ||
                VARIANT.length % 3 ||
                VARIANT.some((index) => index >= VERTEX_COUNT)
            ) {
                throw new TypeError('Invalid compiled SVG expression index variant: ' + NAME);
            }
        }
    }
    for (const [NAME, VARIANT] of Object.entries(INDEX_VARIANTS ?? {})) {
        if (
            !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(NAME) ||
            Object.hasOwn(EXPRESSION_INDICES ?? {}, NAME) ||
            !(VARIANT instanceof Uint16Array) ||
            VARIANT.length % 3 ||
            VARIANT.some((index) => index >= VERTEX_COUNT)
        ) {
            throw new TypeError('Invalid compiled SVG named index variant: ' + NAME);
        }
    }
    if (asset.geometry.paintRegions) {
        for (const VARIANT of [...Object.values(EXPRESSION_INDICES ?? {}), ...Object.values(INDEX_VARIANTS ?? {})]) {
            validatePaintRegionData(asset.geometry.paintRegions, VERTEX_COUNT, VARIANT);
        }
    }
    if (asset.geometry.shaderSurfaces !== undefined || asset.geometry.drawOrder !== undefined) {
        throw new TypeError(
            'Compiled SVG assets from compiler 0.11.0 or earlier keep shader surfaces outside the mesh; compile the SVG again',
        );
    }
    const MATERIALS = asset.geometry.materials;
    if (MATERIALS !== undefined) {
        const SURFACES = MATERIALS?.table?.length / MATERIAL_RECORD_FLOATS;
        if (
            !IS_OBJECT(MATERIALS) ||
            !(MATERIALS.vertices instanceof Float32Array) ||
            !(MATERIALS.table instanceof Float32Array) ||
            MATERIALS.vertices.length !== VERTEX_COUNT * 4 ||
            !Number.isSafeInteger(SURFACES) ||
            SURFACES < 1 ||
            SURFACES > MAX_MATERIAL_SURFACES ||
            MATERIALS.table.some((value) => !Number.isFinite(value))
        ) {
            throw new TypeError('Invalid compiled SVG materials');
        }
        const SHADER_STYLES = (asset.metadata.styles ?? []).filter((style) => style.backend === 'shader');
        if (!SHADER_STYLES.length) {
            throw new TypeError('Compiled SVG materials need a shader-backed style in the metadata');
        }
        for (let at = 0; at < MATERIALS.vertices.length; at += 4) {
            const KIND = MATERIALS.vertices[at],
                SURFACE = MATERIALS.vertices[at + 1];
            if (
                !Number.isInteger(KIND) ||
                KIND < MATERIAL_KIND.none ||
                KIND > MATERIAL_KIND.sketchEdge ||
                !Number.isInteger(SURFACE) ||
                SURFACE < 0 ||
                SURFACE >= SURFACES ||
                !Number.isFinite(MATERIALS.vertices[at + 2]) ||
                !Number.isFinite(MATERIALS.vertices[at + 3])
            ) {
                throw new TypeError('Invalid compiled SVG material vertex');
            }
        }
    }
    return asset;
}
export function freezeData(value) {
    if (!IS_OBJECT(value) && !Array.isArray(value)) {
        return value;
    }
    for (const CHILD of Object.values(value)) {
        freezeData(CHILD);
    }
    return Object.freeze(value);
}

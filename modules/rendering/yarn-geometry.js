// Pure geometry for SVG-authored yarn and sketch surfaces: a fill triangle list and a contour strip with the
// distance along and across the contour. No GL, so the vector-assets compiler can use it. The mesh renderer shades
// the result with the material in yarn-material.js.
import { MATERIAL_KIND, MAX_MATERIAL_SURFACES, materialRecord } from './yarn-material-record.js';
const STRIDE_FLOATS = 9;
export function validateStyle(style) {
    if (!style || typeof style !== 'object' || Array.isArray(style)) {
        throw new TypeError('A complete SVG-authored yarn or sketch style is required');
    }
    const YARN_REQUIRED = [
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
    const SKETCH_REQUIRED = [
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
    const FIELDS = style.kind === 'yarn' ? YARN_REQUIRED : style.kind === 'sketch' ? SKETCH_REQUIRED : null;
    if (!FIELDS || FIELDS.some((key) => !Number.isFinite(style[key]))) {
        throw new TypeError('Unsupported or incomplete SVG surface style');
    }
    if (style.seed < 0 || style.seed > 0x7fffffff || !Number.isSafeInteger(style.seed)) {
        throw new RangeError('Surface seed must be a nonnegative 31-bit integer');
    }
    if (style.kind === 'yarn') {
        for (const KEY of [
            'stitchWidth',
            'stitchHeight',
            'thickness',
            'edgeSpacing',
            'edgeRelief',
            'edgeWidth',
            'fiberLength',
            'fiberWidth',
        ]) {
            if (style[KEY] <= 0) {
                throw new RangeError(`Yarn ${KEY} must be positive`);
            }
        }
        for (const KEY of ['irregularity', 'contrast', 'fiberOpacity']) {
            if (style[KEY] < 0 || style[KEY] > 1) {
                throw new RangeError(`Yarn ${KEY} must be in [0,1]`);
            }
        }
        if (!Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) {
            throw new RangeError('Yarn fiberMax must be an integer from 0 to 512');
        }
        for (const KEY of ['fiberSpacing', 'curved', 'pattern', 'detail', 'fiber']) {
            if (
                style[KEY] !== undefined &&
                (KEY === 'fiberSpacing'
                    ? !Number.isFinite(style[KEY]) || style[KEY] <= 0
                    : typeof style[KEY] !== 'boolean')
            ) {
                throw new TypeError(`Invalid Yarn ${KEY}`);
            }
        }
    } else {
        if (!Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 10000) {
            throw new RangeError('Sketch periodMs must be 16..10000');
        }
        for (const KEY of ['amplitude', 'frequency', 'echoWidth', 'hatchSpacing', 'hatchWidth']) {
            if (style[KEY] <= 0) {
                throw new RangeError(`Sketch ${KEY} must be positive`);
            }
        }
        for (const KEY of ['echoOpacity', 'hatchOpacity']) {
            if (style[KEY] < 0 || style[KEY] > 1) {
                throw new RangeError(`Sketch ${KEY} must be in [0,1]`);
            }
        }
    }
}
function normalizeOutline(outline, sourceIndices) {
    if (!(outline instanceof Float32Array || Array.isArray(outline)) || outline.length < 8 || outline.length % 2) {
        throw new TypeError('Closed SVG contour must contain at least four x/y points');
    }
    const POINTS = [];
    for (let i = 0; i < outline.length; i += 2) {
        const X = outline[i],
            Y = outline[i + 1];
        if (!Number.isFinite(X) || !Number.isFinite(Y)) {
            throw new TypeError('SVG contour points must be finite');
        }
        if (!POINTS.length || Math.hypot(X - POINTS.at(-1)[0], Y - POINTS.at(-1)[1]) > 1e-6) {
            POINTS.push([X, Y]);
            sourceIndices?.push(i / 2);
        }
    }
    if (POINTS.length > 4 && Math.hypot(POINTS[0][0] - POINTS.at(-1)[0], POINTS[0][1] - POINTS.at(-1)[1]) < 1e-6) {
        POINTS.pop();
        sourceIndices?.pop();
    }
    if (POINTS.length < 3) {
        throw new TypeError('SVG contour requires at least three distinct points');
    }
    return POINTS;
}
export function surfaceGeometry(fillVertices, outline, edgeColors, style) {
    if (!(fillVertices instanceof Float32Array) || fillVertices.length < 18 || fillVertices.length % 18) {
        throw new TypeError('Filled surface requires complete triangles in a six-float position/color layout');
    }
    const SOURCE_INDICES = [],
        POINTS = normalizeOutline(outline, SOURCE_INDICES);
    if (
        edgeColors !== undefined &&
        (!(edgeColors instanceof Float32Array) ||
            (edgeColors.length !== POINTS.length * 4 && edgeColors.length !== outline.length * 2))
    ) {
        throw new TypeError('edgeColors must contain one RGBA color per contour point');
    }
    if (edgeColors && edgeColors.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new RangeError('edgeColors must contain finite RGBA values in [0,1]');
    }
    if (edgeColors && edgeColors.length !== POINTS.length * 4) {
        const ORIGINAL_COLORS = edgeColors;
        edgeColors = Float32Array.from(
            SOURCE_INDICES.flatMap((index) => Array.from(ORIGINAL_COLORS.subarray(index * 4, index * 4 + 4))),
        );
    }
    for (let i = 0; i < fillVertices.length; i++) {
        if (!Number.isFinite(fillVertices[i])) {
            throw new TypeError('Filled surface vertices must be finite');
        }
        const FIELD = i % 6;
        if (FIELD >= 2 && (fillVertices[i] < 0 || fillVertices[i] > 1)) {
            throw new RangeError('Surface colors must be in [0,1]');
        }
    }
    const LENGTHS = [],
        NORMALS = [];
    let total = 0;
    let signedArea = 0;
    for (let i = 0; i < POINTS.length; i++) {
        const A = POINTS[i],
            B = POINTS[(i + 1) % POINTS.length],
            DX = B[0] - A[0],
            DY = B[1] - A[1],
            LENGTH = Math.hypot(DX, DY);
        if (!LENGTH) {
            throw new TypeError('SVG contour cannot contain zero-length edges');
        }
        LENGTHS.push(LENGTH);
        total += LENGTH;
        signedArea += A[0] * B[1] - B[0] * A[1];
        NORMALS.push([DY / LENGTH, -DX / LENGTH]);
    }
    if (Math.abs(signedArea) < 1e-6) {
        throw new TypeError('SVG contour cannot have zero area');
    }
    const WINDING = signedArea >= 0 ? 1 : -1;
    const BOUNDS = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < fillVertices.length; i += 6) {
        BOUNDS[0] = Math.min(BOUNDS[0], fillVertices[i]);
        BOUNDS[1] = Math.min(BOUNDS[1], fillVertices[i + 1]);
        BOUNDS[2] = Math.max(BOUNDS[2], fillVertices[i]);
        BOUNDS[3] = Math.max(BOUNDS[3], fillVertices[i + 1]);
    }
    if (!(BOUNDS[2] > BOUNDS[0] && BOUNDS[3] > BOUNDS[1])) {
        throw new TypeError('Filled surface bounds must have positive area');
    }
    const RGBA = edgeColors
        ? edgeColors
        : (() => {
              const COLOR = [0, 0, 0, 0];
              for (let i = 0; i < fillVertices.length; i += 6) {
                  for (let c = 0; c < 4; c++) {
                      COLOR[c] += fillVertices[i + 2 + c];
                  }
              }
              for (let c = 0; c < 4; c++) {
                  COLOR[c] /= fillVertices.length / 6;
              }
              return Float32Array.from(POINTS.flatMap(() => COLOR));
          })();
    const EDGE_WIDTH = style.kind === 'yarn' ? style.edgeWidth : style.amplitude + style.echoWidth;
    const FIBER_LENGTH = style.kind === 'yarn' && style.fiber !== false ? style.fiberLength : EDGE_WIDTH;
    const FILL_RECORDS = new Float32Array((fillVertices.length / 6) * STRIDE_FLOATS);
    let write = 0;
    for (let i = 0; i < fillVertices.length; i += 6) {
        FILL_RECORDS.set(fillVertices.subarray(i, i + 6), write);
        FILL_RECORDS[write + 6] = 0;
        write += STRIDE_FLOATS;
    }
    const CUMULATIVE = [0];
    for (const LENGTH of LENGTHS) {
        CUMULATIVE.push(CUMULATIVE.at(-1) + LENGTH);
    }
    const RING = [];
    for (let i = 0; i < POINTS.length; i++) {
        const PREVIOUS = NORMALS[(i + POINTS.length - 1) % POINTS.length],
            CURRENT = NORMALS[i];
        let mx = (PREVIOUS[0] + CURRENT[0]) * WINDING;
        let my = (PREVIOUS[1] + CURRENT[1]) * WINDING;
        const MITER_LENGTH = Math.hypot(mx, my);
        if (MITER_LENGTH < 1e-5) {
            mx = CURRENT[0] * WINDING;
            my = CURRENT[1] * WINDING;
        } else {
            mx /= MITER_LENGTH;
            my /= MITER_LENGTH;
        }
        const DENOMINATOR = Math.max(0.25, Math.abs(mx * CURRENT[0] * WINDING + my * CURRENT[1] * WINDING));
        const SCALE = Math.min(4, 1 / DENOMINATOR);
        RING.push([mx * SCALE, my * SCALE]);
    }
    // The strip follows the source contour; stitch/fiber density is fragment-only.
    // Reorder the edge rows into a triangle list. This duplicates only contour vertices,
    // independent of stitchWidth, fiberSpacing, and fiberMax.
    const EDGE_RECORDS = [];
    // A sketch echo is the contour translated by (echoX, echoY): its strip follows the translated contour, so the
    // across distance the shader reads is the distance from the echo line and corners stay exact.
    const ECHO_X = style.kind === 'sketch' ? style.echoX : 0,
        ECHO_Y = style.kind === 'sketch' ? style.echoY : 0;
    const COLOR_AT = (index) => RGBA.subarray(index * 4, index * 4 + 4);
    for (let i = 0; i < POINTS.length; i++) {
        const J = (i + 1) % POINTS.length;
        const EMIT = (pointIndex, distance) => {
            const POINT = POINTS[pointIndex],
                NORMAL = RING[pointIndex],
                X = POINT[0] + ECHO_X + NORMAL[0] * distance,
                Y = POINT[1] + ECHO_Y + NORMAL[1] * distance;
            EDGE_RECORDS.push(X, Y, ...COLOR_AT(pointIndex), 1, CUMULATIVE[pointIndex] / total, distance);
        };
        EMIT(i, -EDGE_WIDTH);
        EMIT(i, FIBER_LENGTH);
        EMIT(J, FIBER_LENGTH);
        EMIT(i, -EDGE_WIDTH);
        EMIT(J, FIBER_LENGTH);
        EMIT(J, -EDGE_WIDTH);
    }
    const EDGE_RECORD_ARRAY = Float32Array.from(EDGE_RECORDS);
    const VERTICES = new Float32Array(FILL_RECORDS.length + EDGE_RECORD_ARRAY.length);
    VERTICES.set(FILL_RECORDS);
    VERTICES.set(EDGE_RECORD_ARRAY, FILL_RECORDS.length);
    return Object.freeze({
        vertices: VERTICES,
        fillFirst: 0,
        fillCount: fillVertices.length / 6,
        edgeFirst: fillVertices.length / 6,
        edgeCount: EDGE_RECORD_ARRAY.length / STRIDE_FLOATS,
        edgeByteOffset: FILL_RECORDS.length * 4,
        bounds: Float32Array.of(BOUNDS[0], BOUNDS[1], BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1]),
        contourLength: total,
    });
}
/**
 * Appends one surface as ordinary mesh vertices (11 floats each) plus the matching material records (4 floats each):
 * the fill triangles first, then the contour strip.
 */
export function appendSurfaceVertices(vertices, materials, surface, surfaceIndex, style, partIndex) {
    const YARN = style.kind === 'yarn';
    // surfaceGeometry records are x, y, r, g, b, a, edge flag, distance along, distance across.
    for (let record = 0; record < surface.fillCount + surface.edgeCount; record++) {
        const AT = record * STRIDE_FLOATS,
            EDGE = record >= surface.edgeFirst;
        vertices.push(
            surface.vertices[AT],
            surface.vertices[AT + 1],
            surface.vertices[AT + 2],
            surface.vertices[AT + 3],
            surface.vertices[AT + 4],
            surface.vertices[AT + 5],
            0,
            0,
            0,
            0,
            partIndex,
        );
        materials.push(
            EDGE
                ? YARN
                    ? MATERIAL_KIND.yarnEdge
                    : MATERIAL_KIND.sketchEdge
                : YARN
                  ? MATERIAL_KIND.yarnFill
                  : MATERIAL_KIND.sketchFill,
            surfaceIndex,
            EDGE ? surface.vertices[AT + 7] : 0,
            EDGE ? surface.vertices[AT + 8] : 0,
        );
    }
}

/**
 * A complete mesh for MeshRenderer.createMesh: the same triangles and material data the SVG compiler writes, for
 * callers that hold surfaces outside a compiled SVG. Pass one surface or a list; the surfaces share the mesh, in order.
 */
export function buildYarnSurfaceMesh(surfaces) {
    const LIST = Array.isArray(surfaces) ? surfaces : [surfaces];
    if (!LIST.length || LIST.length > MAX_MATERIAL_SURFACES) {
        throw new RangeError('A mesh holds 1..' + MAX_MATERIAL_SURFACES + ' surfaces');
    }
    const VERTICES = [],
        MATERIALS = [],
        TABLE = [];
    let partCount = 1;
    LIST.forEach(({ fillVertices, outline, edgeColors, style, partIndex = 0 }, index) => {
        validateStyle(style);
        const SURFACE = surfaceGeometry(fillVertices, outline, edgeColors, style);
        TABLE.push(...materialRecord(style, SURFACE.bounds, SURFACE.contourLength));
        appendSurfaceVertices(VERTICES, MATERIALS, SURFACE, index, style, partIndex);
        partCount = Math.max(partCount, partIndex + 1);
    });
    return {
        vertices: Float32Array.from(VERTICES),
        strideFloats: 11,
        partCount,
        morphCount: 0,
        materials: {
            vertices: Float32Array.from(MATERIALS),
            table: Float32Array.from(TABLE),
        },
    };
}

/** Exposed for exact bounded-geometry assertions; it never creates per-stitch or per-fiber vertices. */
export function buildYarnSurfaceGeometry(options) {
    validateStyle(options?.style);
    return surfaceGeometry(options.fillVertices, options.outline, options.edgeColors, options.style);
}

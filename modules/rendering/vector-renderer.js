import {
    VECTOR_VERTEX_FLOATS as VERTEX_FLOATS,
    VECTOR_FRAGMENT_VARYINGS as FRAGMENT_VARYINGS,
    VECTOR_FRAGMENT_FINISH as FINISH,
    vectorFragmentShader as fragmentShader,
} from './vector-shader.js';
import { validateQuads } from './quad-data.js';
import { stencilEqual } from './draw-state.js';
import { clipPlanes } from './clip-planes.js';
import { poseRendererOf } from './pose-renderer.js';
import { POSE_PROGRAM_FUNCTIONS } from './pose-shader.js';

/** Initial atlas regions reserved by each VectorRenderer, in allocation order. */
export const VECTOR_RENDERER_ATLAS_REGIONS = Object.freeze([Object.freeze({ width: 1, height: 1 })]);

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const EMPTY_OPTIONS = Object.freeze({});
const BLACK = Object.freeze([0, 0, 0, 1]);
const NO_RADIAL = Object.freeze([0, 0, 0, 0]);
// Corner uv of the analytic primitive square, in the triangle order 0,1,2 and 0,2,3.
const PRIMITIVE_CORNERS = Object.freeze([-1, -1, 1, -1, 1, 1, -1, 1]);
// One vertex layout for every textured draw: texture identity, gradient kind and flash are vertex data,
// so fills, gradients, glyphs and sprites of one blend/clip state batch together. Floats per vertex: position 2,
// uv 2, color 4, paint (atlas layer, white flash, mode, nearest) 4, radial parameters 4, ramp rectangle 4, clip-space depth 1.
// Mode 4 is a posed sprite corner: position is the part-local corner, radial holds the entity matrix a,b,c,d and
// the ramp rectangle holds its e,f plus the pose row and part, so the vertex shader evaluates the keyframes.
const DEPTH_FUNCTIONS = new Set(['never', 'less', 'equal', 'lequal', 'greater', 'notequal', 'gequal', 'always']);
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const MODE_POSED = 4;
// Round joins and caps are arcs whose chord may deviate from the true circle by at most this many pixels, so thin
// lines get few segments and thick lines get enough to stay round.
const ARC_TOLERANCE = 0.125;
// Mode 5 is an analytic primitive (circle, rectangle, capsule line; filled or stroked): uv carries the local
// [-1,1] coordinates, radial the kind/stroke/width/option parameters and the ramp rectangle the matrix a,c,b,d.
const MODE_PRIMITIVE = 5;
const POSED_CORNERS = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
    [1, 1],
    [0, 1],
];
const VERTEX_ATTRIBUTES = [
    { name: 'a_position', size: 2, offset: 0 },
    { name: 'a_uv', size: 2, offset: 8 },
    { name: 'a_color', size: 4, offset: 16 },
    { name: 'a_paint', size: 4, offset: 32 },
    { name: 'a_radial', size: 4, offset: 48 },
    { name: 'a_rect', size: 4, offset: 64 },
    { name: 'a_depth', size: 1, offset: 80 },
];
const POSED_CORNER = `if(a_paint.z>3.5&&a_paint.z<4.5){vec4 row0;vec4 row1;vec4 pose;
poseEval(int(a_rect.w+0.5),int(a_rect.z+0.5),row0,row1,pose);
vec2 q=vec2(dot(row0.xy,a_position)+row0.z,dot(row1.xy,a_position)+row1.z);
position=vec2(a_radial.x*q.x+a_radial.z*q.y+a_rect.x,a_radial.y*q.x+a_radial.w*q.y+a_rect.y);
color.a*=pose.z;paint.z=0.0;radial=vec4(0.0);rect=vec4(0.0);}`;
function vertexShader(posed) {
    return `attribute vec2 a_position; attribute vec2 a_uv; attribute vec4 a_color; attribute vec4 a_paint; attribute vec4 a_radial; attribute vec4 a_rect; attribute float a_depth;
uniform mat3 u_projection; ${FRAGMENT_VARYINGS}${posed ? ' varying highp vec2 v_position;' : ''}
${posed ? POSE_PROGRAM_FUNCTIONS : ''}
void main(){vec2 position=a_position;vec4 color=a_color;vec4 paint=a_paint;vec4 radial=a_radial;vec4 rect=a_rect;
${posed ? POSED_CORNER : ''}
vec3 p=u_projection*vec3(position,1.0);gl_Position=vec4(p.xy,a_depth,1.0);${posed ? 'v_position=position;' : ''}v_uv=a_uv;v_color=color;v_paint=paint;v_radial=radial;v_rect=rect;}`;
}
const VERTEX = vertexShader(false);
const CLIP_VERTEX = `attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;void main(){vec3 p=u_projection*u_transform*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);}`;
const CLIP_FRAGMENT = 'precision mediump float;void main(){gl_FragColor=vec4(1.0);}';
const FRAGMENT = fragmentShader(0);
// Offscreen groups are the one render-target (not atlas) sample, so they keep a plain 2D sampler.
const GROUP_FRAGMENT = `precision mediump float; uniform sampler2D u_texture;uniform float u_depthWrite;
${FRAGMENT_VARYINGS}
void main(){vec4 texel=texture2D(u_texture,v_uv);${FINISH}}`;
const FINITE = (n, label) => {
    if (!Number.isFinite(n)) {
        throw new TypeError(`${label} must be finite`);
    }
};
function rgba(value) {
    if (!value || value.length !== 4) {
        throw new TypeError('RGBA channels must be in [0,1]');
    }
    for (let i = 0; i < 4; i++) {
        const N = value[i];
        if (!Number.isFinite(N) || N < 0 || N > 1) {
            throw new TypeError('RGBA channels must be in [0,1]');
        }
    }
    return value;
}
function point(m, x, y) {
    return {
        x: m[0] * x + m[2] * y + m[4],
        y: m[1] * x + m[3] * y + m[5],
    };
}
/** compose() into `out` (six values, not aliasing `a` or `b`). */
function composeInto(a, b, out) {
    const A0 = a[0],
        A1 = a[1],
        A2 = a[2],
        A3 = a[3],
        A4 = a[4],
        A5 = a[5];
    out[0] = A0 * b[0] + A2 * b[1];
    out[1] = A1 * b[0] + A3 * b[1];
    out[2] = A0 * b[2] + A2 * b[3];
    out[3] = A1 * b[2] + A3 * b[3];
    out[4] = A0 * b[4] + A2 * b[5] + A4;
    out[5] = A1 * b[4] + A3 * b[5] + A5;
    return out;
}
// Options of the program-form pose resolve; frozen because resolve only reads them.
const PROGRAM_RESOLVE = Object.freeze({ program: true });
function compose(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}
// Edge fields, one row of seven doubles per edge: a.x, a.y, b.x, b.y, winding sign, min y, max y.
const EDGE_FLOATS = 7;
// Tessellation scratch shared by every renderer: tessellate runs to completion (no callbacks) and is not reentrant.
const TESSELLATION = {
    edges: new Float64Array(EDGE_FLOATS * 64),
    ys: new Float64Array(128),
    ySortScratch: new Float64Array(128),
    starts: new Int32Array(64),
    sortScratch: new Int32Array(64),
    active: [],
    keys: new Float64Array(64),
    out: new Float64Array(12 * 64),
};
function growFloat64(array, required) {
    const NEXT = new Float64Array(Math.max(required, array.length * 2));
    NEXT.set(array);
    return NEXT;
}
/** x of edge `edge` (an edge row index) at height `y`; the same expression as the former object form. */
function edgeXAt(edges, edge, y) {
    const AT = edge * EDGE_FLOATS,
        AX = edges[AT],
        AY = edges[AT + 1];
    return AX + ((edges[AT + 2] - AX) * (y - AY)) / (edges[AT + 3] - AY);
}
/**
 * Stable merge sort of `count` edge indices in `order` by their min y, using `scratch` of the same length. A stable sort
 * gives the same order as the former stable Array.prototype.sort with the comparator `a.minY - b.minY`.
 */
function sortEdgesByMinY(order, scratch, count, edges) {
    let source = order,
        target = scratch;
    for (let width = 1; width < count; width *= 2) {
        for (let start = 0; start < count; start += width * 2) {
            const MIDDLE = Math.min(start + width, count),
                END = Math.min(start + width * 2, count);
            let left = start,
                right = MIDDLE,
                at = start;
            while (left < MIDDLE && right < END) {
                // Take the right run only when strictly smaller, which keeps equal keys in their original order.
                if (edges[source[right] * EDGE_FLOATS + 5] < edges[source[left] * EDGE_FLOATS + 5]) {
                    target[at++] = source[right++];
                } else {
                    target[at++] = source[left++];
                }
            }
            while (left < MIDDLE) {
                target[at++] = source[left++];
            }
            while (right < END) {
                target[at++] = source[right++];
            }
        }
        const SWAP = source;
        source = target;
        target = SWAP;
    }
    if (source !== order) {
        for (let i = 0; i < count; i++) {
            order[i] = source[i];
        }
    }
}
/**
 * Stable ascending merge sort of the first `count` values of `values` using `scratch` of the same length. Being
 * stable it keeps +0 and -0 in their original order, exactly as the former Array.prototype.sort with `a - b`.
 */
function sortValues(values, scratch, count) {
    let source = values,
        target = scratch;
    for (let width = 1; width < count; width *= 2) {
        for (let start = 0; start < count; start += width * 2) {
            const MIDDLE = Math.min(start + width, count),
                END = Math.min(start + width * 2, count);
            let left = start,
                right = MIDDLE,
                at = start;
            while (left < MIDDLE && right < END) {
                target[at++] = source[right] < source[left] ? source[right++] : source[left++];
            }
            while (left < MIDDLE) {
                target[at++] = source[left++];
            }
            while (right < END) {
                target[at++] = source[right++];
            }
        }
        const SWAP = source;
        source = target;
        target = SWAP;
    }
    if (source !== values) {
        for (let i = 0; i < count; i++) {
            values[i] = source[i];
        }
    }
}
/**
 * Scanline tessellation of `contours` (arrays of {x, y}) into triangles written to `TESSELLATION.out` as x, y pairs;
 * returns the vertex count. The output buffer is reused by the next call, so callers consume it first.
 */
function tessellate(contours, rule) {
    const T = TESSELLATION;
    let edges = T.edges,
        ys = T.ys,
        edgeCount = 0,
        yCount = 0;
    for (let c = 0; c < contours.length; c++) {
        const CONTOUR = contours[c];
        if (CONTOUR.length < 3) {
            continue;
        }
        for (let i = 0; i < CONTOUR.length; i++) {
            const A = CONTOUR[i],
                B = CONTOUR[(i + 1) % CONTOUR.length];
            if (Math.abs(A.y - B.y) < 1e-9) {
                continue;
            }
            if ((edgeCount + 1) * EDGE_FLOATS > edges.length) {
                edges = T.edges = growFloat64(edges, (edgeCount + 1) * EDGE_FLOATS);
            }
            if (yCount + 2 > ys.length) {
                ys = T.ys = growFloat64(ys, yCount + 2);
                T.ySortScratch = new Float64Array(ys.length);
            }
            const AT = edgeCount++ * EDGE_FLOATS;
            edges[AT] = A.x;
            edges[AT + 1] = A.y;
            edges[AT + 2] = B.x;
            edges[AT + 3] = B.y;
            edges[AT + 4] = B.y > A.y ? 1 : -1;
            edges[AT + 5] = Math.min(A.y, B.y);
            edges[AT + 6] = Math.max(A.y, B.y);
            ys[yCount++] = A.y;
            ys[yCount++] = B.y;
        }
    }
    sortValues(ys, T.ySortScratch, yCount);
    // Levels are compacted in place at the front of the sorted y list.
    let levelCount = 0;
    for (let i = 0; i < yCount; i++) {
        const Y = ys[i];
        if (!levelCount || Y - ys[levelCount - 1] > 1e-8) {
            ys[levelCount++] = Y;
        }
    }
    if (edgeCount > T.starts.length) {
        T.starts = new Int32Array(Math.max(edgeCount, T.starts.length * 2));
        T.sortScratch = new Int32Array(T.starts.length);
        T.keys = new Float64Array(T.starts.length);
    }
    const STARTS = T.starts,
        ACTIVE = T.active,
        KEYS = T.keys;
    for (let i = 0; i < edgeCount; i++) {
        STARTS[i] = i;
    }
    sortEdgesByMinY(STARTS, T.sortScratch, edgeCount, edges);
    ACTIVE.length = 0;
    let out = T.out,
        outFloats = 0,
        nextStart = 0;
    const EVEN_ODD = rule === 'evenodd';
    for (let band = 0; band + 1 < levelCount; band++) {
        const Y0 = ys[band],
            Y1 = ys[band + 1],
            YM = (Y0 + Y1) / 2;
        if (Y1 - Y0 < 1e-8) {
            continue;
        }
        while (nextStart < edgeCount && edges[STARTS[nextStart] * EDGE_FLOATS + 5] < YM) {
            ACTIVE.push(STARTS[nextStart++]);
        }
        for (let i = ACTIVE.length - 1; i >= 0; i--) {
            if (edges[ACTIVE[i] * EDGE_FLOATS + 6] <= YM) {
                ACTIVE[i] = ACTIVE[ACTIVE.length - 1];
                ACTIVE.pop();
            }
        }
        // Stable insertion sort by x at the band middle: the same order as the former stable comparator sort.
        for (let i = 0; i < ACTIVE.length; i++) {
            KEYS[ACTIVE[i]] = edgeXAt(edges, ACTIVE[i], YM);
        }
        for (let i = 1; i < ACTIVE.length; i++) {
            const EDGE = ACTIVE[i],
                KEY = KEYS[EDGE];
            let j = i - 1;
            while (j >= 0 && KEYS[ACTIVE[j]] - KEY > 0) {
                ACTIVE[j + 1] = ACTIVE[j];
                j--;
            }
            ACTIVE[j + 1] = EDGE;
        }
        let winding = 0;
        let inside = false;
        let left = -1;
        for (let i = 0; i < ACTIVE.length; i++) {
            const EDGE = ACTIVE[i];
            const BEFORE = EVEN_ODD ? inside : winding !== 0;
            if (EVEN_ODD) {
                inside = !inside;
            } else {
                winding += edges[EDGE * EDGE_FLOATS + 4];
            }
            const AFTER = EVEN_ODD ? inside : winding !== 0;
            if (!BEFORE && AFTER) {
                left = EDGE;
            } else if (BEFORE && !AFTER && left >= 0) {
                if (outFloats + 12 > out.length) {
                    out = T.out = growFloat64(out, outFloats + 12);
                }
                const AX = edgeXAt(edges, left, Y0),
                    BX = edgeXAt(edges, EDGE, Y0),
                    CX = edgeXAt(edges, EDGE, Y1),
                    DX = edgeXAt(edges, left, Y1);
                // Triangles A, B, C and A, C, D of the band trapezoid.
                out[outFloats] = AX;
                out[outFloats + 1] = Y0;
                out[outFloats + 2] = BX;
                out[outFloats + 3] = Y0;
                out[outFloats + 4] = CX;
                out[outFloats + 5] = Y1;
                out[outFloats + 6] = AX;
                out[outFloats + 7] = Y0;
                out[outFloats + 8] = CX;
                out[outFloats + 9] = Y1;
                out[outFloats + 10] = DX;
                out[outFloats + 11] = Y1;
                outFloats += 12;
                left = -1;
            }
        }
    }
    ACTIVE.length = 0;
    return outFloats / 2;
}
function clipContour(points, rule) {
    if (rule !== 'nonzero' && rule !== 'evenodd') {
        throw new TypeError('clip rule must be nonzero or evenodd');
    }
    if (!(points instanceof Float32Array) && !(points instanceof Float64Array) && !Array.isArray(points)) {
        throw new TypeError('Clip contour must be a flat numeric array of x/y pairs');
    }
    if (points.length % 2) {
        throw new RangeError('Clip contour needs x/y pairs');
    }
    const FLAT = Float32Array.from(points);
    if (FLAT.some((value) => !Number.isFinite(value))) {
        throw new TypeError('Clip contour coordinates must be finite');
    }
    const COUNT = FLAT.length / 2;
    if (COUNT > 256) {
        throw new RangeError('Retained clip contours support at most 256 authored points');
    }
    let end = COUNT;
    if (COUNT > 3 && FLAT[0] === FLAT[(COUNT - 1) * 2] && FLAT[1] === FLAT[(COUNT - 1) * 2 + 1]) {
        end--;
    }
    if (end < 3) {
        throw new RangeError('Clip contour requires at least three distinct points');
    }
    const CONTOUR = Array.from(
        {
            length: end,
        },
        (_, i) => ({
            x: FLAT[i * 2],
            y: FLAT[i * 2 + 1],
        }),
    );
    for (let i = 0; i < end; i++) {
        const A = CONTOUR[i],
            B = CONTOUR[(i + 1) % end];
        if (A.x === B.x && A.y === B.y) {
            throw new RangeError('Clip contour cannot contain consecutive duplicate points');
        }
    }
    const ORIENT = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
        ON = (a, b, p) =>
            Math.abs(ORIENT(a, b, p)) < 1e-9 &&
            p.x >= Math.min(a.x, b.x) - 1e-9 &&
            p.x <= Math.max(a.x, b.x) + 1e-9 &&
            p.y >= Math.min(a.y, b.y) - 1e-9 &&
            p.y <= Math.max(a.y, b.y) + 1e-9;
    for (let i = 0; i < end; i++) {
        for (let j = i + 1; j < end; j++) {
            if (j === i + 1 || (i === 0 && j === end - 1)) {
                continue;
            }
            const A = CONTOUR[i],
                B = CONTOUR[(i + 1) % end],
                C = CONTOUR[j],
                D = CONTOUR[(j + 1) % end],
                O1 = ORIENT(A, B, C),
                O2 = ORIENT(A, B, D),
                O3 = ORIENT(C, D, A),
                O4 = ORIENT(C, D, B);
            if ((O1 * O2 < 0 && O3 * O4 < 0) || ON(A, B, C) || ON(A, B, D) || ON(C, D, A) || ON(C, D, B)) {
                throw new RangeError('Retained clip contours must be simple and non-self-intersecting');
            }
        }
    }
    let area = 0;
    for (let i = 0; i < end; i++) {
        const A = CONTOUR[i],
            B = CONTOUR[(i + 1) % end];
        area += A.x * B.y - B.x * A.y;
    }
    if (Math.abs(area) < 1e-9) {
        throw new RangeError('Clip contour area must be nonzero');
    }
    const VERTEX_COUNT = tessellate([CONTOUR], rule);
    if (!VERTEX_COUNT) {
        throw new RangeError('Clip contour could not be tessellated');
    }
    if (VERTEX_COUNT / 3 > 16384) {
        throw new RangeError('Retained clip tessellation exceeds 16384 triangles');
    }
    return {
        flat: FLAT,
        triangles: new Float32Array(TESSELLATION.out.subarray(0, VERTEX_COUNT * 2)),
    };
}
function convexContour(contour) {
    let sign = 0;
    for (let i = 0; i < contour.length; i++) {
        const A = contour[i],
            B = contour[(i + 1) % contour.length],
            C = contour[(i + 2) % contour.length],
            CROSS = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x);
        if (Math.abs(CROSS) < 1e-8) {
            continue;
        }
        const NEXT = Math.sign(CROSS);
        if (sign && NEXT !== sign) {
            return false;
        }
        sign = NEXT;
    }
    return sign !== 0;
}

/** Ordered vector/path submission over WebGLDevice. The caller owns art, projection and painter order. */
export class VectorRenderer {
    constructor(device, { initialVertices = 4096, maxVertices = 262144, glyphAtlas = null } = {}) {
        if (!device?.createPipeline || !device?.draw) {
            throw new TypeError('A WebGLDevice is required');
        }
        if (
            !Number.isSafeInteger(maxVertices) ||
            maxVertices < 3 ||
            !Number.isSafeInteger(initialVertices) ||
            initialVertices < 3 ||
            initialVertices > maxVertices
        ) {
            throw new RangeError('3 <= initialVertices <= maxVertices is required');
        }
        if (initialVertices * VERTEX_BYTES > device.maxBufferBytes) {
            throw new RangeError('initial vector buffer exceeds the device byte limit');
        }
        this.device = device;
        this.gl = device.gl;
        this.canvas = device.canvas;
        this.glyphAtlas = glyphAtlas;
        this.maxVertices = Math.min(maxVertices, Math.floor(device.maxBufferBytes / VERTEX_BYTES));
        this.maxClipPlanes = Math.max(
            1,
            Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2),
        );
        this.pipeline = device.createPipeline({
            vertex: VERTEX,
            fragment: FRAGMENT,
            stride: VERTEX_BYTES,
            attributes: VERTEX_ATTRIBUTES,
            uniforms: {
                u_projection: 'matrix3fv',
                u_texture: '1i',
                u_depthWrite: '1f',
            },
        });
        // Created with the first posed sprite: it adds the keyframe evaluator and the edge-plane clip.
        this.posePipeline = null;
        this.poseBatch = null;
        this.clipSerial = 0;
        this.batchSerial = 0;
        this.planeScratch = new Float32Array(this.maxClipPlanes * 3);
        this.clipPipeline = device.createPipeline({
            vertex: CLIP_VERTEX,
            fragment: CLIP_FRAGMENT,
            stride: 8,
            attributes: [
                {
                    name: 'a_position',
                    size: 2,
                    offset: 0,
                },
            ],
            uniforms: {
                u_projection: 'matrix3fv',
                u_transform: 'matrix3fv',
            },
        });
        this.buffer = device.createVertexBuffer({
            capacityBytes: initialVertices * VERTEX_BYTES,
        });
        this.dynamicClipBuffer = device.createVertexBuffer({
            capacityBytes: 0,
        });
        this.atlas = device.textureAtlas;
        this.whiteRegion = this.atlas.allocate(
            VECTOR_RENDERER_ATLAS_REGIONS[0].width,
            VECTOR_RENDERER_ATLAS_REGIONS[0].height,
        );
        this.atlas.upload(
            this.whiteRegion,
            { ...VECTOR_RENDERER_ATLAS_REGIONS[0], data: new Uint8Array([255, 255, 255, 255]) },
            { premultiplied: true, extendEdges: true },
        );
        this.vertices = new Float32Array(initialVertices * VERTEX_FLOATS);
        this.count = 0;
        this.matrix = IDENTITY.slice();
        this.stack = [];
        this.statePool = [];
        this.path = [];
        this.cursor = null;
        this.subpath = null;
        this.clips = [];
        this.groups = [];
        this.groupTargets = [];
        this.activeTarget = null;
        this.activePaint = null;
        this.activeRadial = false;
        this.activeWhiteFlash = false;
        this.activeGradient = null;
        this.paintTemplate = new Float32Array(12);
        this.flatUV = [0, 0];
        this.triangle = new Float64Array(6);
        this.quadCheck = {};
        this.poseBatchRecord = {
            owner: null,
            textures: null,
            programWidth: 1,
            planeKey: 0,
            planeCount: 0,
            planes: null,
            serial: 0,
        };
        this.submitCall = {
            pipeline: null,
            buffer: null,
            count: 0,
            uniforms: null,
            textures: null,
            blend: 'source-over',
            depth: null,
            stencil: false,
        };
        this.submitTextures = [];
        this.posedUniforms = {
            u_projection: null,
            u_depthWrite: 0,
            u_program: 0,
            u_state: 1,
            u_overrides: 2,
            u_texture: 3,
            u_programWidth: 1,
            'u_planes[0]': null,
            u_planeCount: 0,
        };
        this.flatUniforms = { u_projection: null, u_depthWrite: 0, u_texture: 0 };
        this.quadTint = [1, 1, 1, 1];
        this.quadMatrix = [1, 0, 0, 1, 0, 0];
        // Stroke scratch: contour x, y pairs and per-segment direction and normal pairs, grown as paths need.
        this.strokePoints = new Float64Array(64);
        this.strokeDirections = new Float64Array(64);
        this.strokeNormals = new Float64Array(64);
        this._setPaint(this.whiteRegion);
        this.blend = 'source-over';
        this.depth = 0;
        this._depthPolicy = { test: false, write: false, func: 'lequal' };
        this.stencilClips = [];
        this.clipPaths = new Map();
        this.clipPathBytes = 0;
        this.stencilDepth = 0;
        this.stencilNeedsRebuild = false;
        this.state = 'ready';
        this.unregisterBatcher = device.registerBatcher(() => {
            if (this.state === 'ready' && this.device.active) {
                this._submit();
            }
        });
        this.onLost = () => {
            this.count = 0;
            this.poseBatch = null;
            this.stencilNeedsRebuild = this.stencilClips.length > 0;
        };
        this.onRestored = () => {
            if (this.state === 'disposed') {
                return;
            }
            try {
                for (const RECORD of this.clipPaths.values()) {
                    this.device.uploadVertices(RECORD.buffer, RECORD.triangles);
                }
            } catch {
                this.state = 'failed';
            }
        };
        this.canvas.addEventListener('webglcontextlost', this.onLost);
        this.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this.projection = new Float32Array([2 / this.canvas.width, 0, 0, 0, -2 / this.canvas.height, 0, -1, 1, 1]);
        this.groupPipeline = null;
        try {
            this.groupPipeline = device.createPipeline({
                vertex: VERTEX,
                fragment: GROUP_FRAGMENT,
                stride: VERTEX_BYTES,
                attributes: VERTEX_ATTRIBUTES,
                uniforms: {
                    u_projection: 'matrix3fv',
                    u_texture: '1i',
                    u_depthWrite: '1f',
                },
            });
        } catch (error) {
            try {
                this.dispose();
            } catch {
                // Preserve the original pipeline creation error.
            }
            throw error;
        }
    }
    get clips() {
        return this._clips;
    }
    // Every change bumps the serial, so a batch can tell cheaply whether its clip may have changed.
    set clips(value) {
        this._clips = value;
        this.clipSerial++;
    }
    get depth() {
        return this._depth;
    }
    set depth(value) {
        if (!Number.isFinite(value) || value < -1 || value > 1) {
            throw new RangeError('depth must be in [-1,1]');
        }
        this._depth = value;
    }
    get depthTest() {
        return this._depthPolicy.test;
    }
    set depthTest(value) {
        if (typeof value !== 'boolean') {
            throw new TypeError('depthTest must be a boolean');
        }
        this._setDepthPolicy({ ...this._depthPolicy, test: value });
    }
    get depthWrite() {
        return this._depthPolicy.write;
    }
    set depthWrite(value) {
        if (typeof value !== 'boolean') {
            throw new TypeError('depthWrite must be a boolean');
        }
        this._setDepthPolicy({ ...this._depthPolicy, write: value });
    }
    get depthFunc() {
        return this._depthPolicy.func;
    }
    set depthFunc(value) {
        if (!DEPTH_FUNCTIONS.has(value)) {
            throw new TypeError('Unsupported depth function');
        }
        this._setDepthPolicy({ ...this._depthPolicy, func: value });
    }
    _setDepthPolicy(policy) {
        if (
            policy.test !== this._depthPolicy.test ||
            policy.write !== this._depthPolicy.write ||
            policy.func !== this._depthPolicy.func
        ) {
            this._submit();
            this._depthPolicy = policy;
        }
    }
    _assertDepthTarget() {
        if (
            (this._depthPolicy.test || this._depthPolicy.write) &&
            (!this.device.depthAvailable || this.device.activeRenderTarget)
        ) {
            throw new Error('The active framebuffer has no depth attachment');
        }
    }
    _pushClip(contour) {
        this._clips.push(contour);
        this.clipSerial++;
    }
    _frame() {
        if (this.state !== 'ready') {
            throw new Error(`VectorRenderer is ${this.state}`);
        }
        if (!this.device.active) {
            throw new Error('WebGLDevice.beginFrame is required');
        }
        this._assertDepthTarget();
        let group = null;
        for (let i = this.groups.length - 1; i >= 0; i--) {
            if (!this.groups[i].direct) {
                group = this.groups[i];
                break;
            }
        }
        if (group) {
            this._setProjection(group.bounds, group.target);
        } else {
            this._setProjection(null);
        }
        if (this.stencilNeedsRebuild) {
            this._rebuildStencil();
            this.stencilNeedsRebuild = false;
        }
    }
    _setProjection(bounds, target = null) {
        const W = target?.width ?? this.canvas.width,
            H = target?.height ?? this.canvas.height,
            X = bounds?.x ?? 0,
            Y = bounds?.y ?? 0;
        this.projection[0] = 2 / W;
        this.projection[1] = 0;
        this.projection[2] = 0;
        this.projection[3] = 0;
        this.projection[4] = -2 / H;
        this.projection[5] = 0;
        this.projection[6] = -1 - (2 * X) / W;
        this.projection[7] = 1 + (2 * Y) / H;
        this.projection[8] = 1;
    }
    beginPath() {
        this._frame();
        this.path = [];
        this.cursor = this.subpath = null;
    }
    moveTo(x, y) {
        this._frame();
        FINITE(x, 'x');
        FINITE(y, 'y');
        const P = point(this.matrix, x, y);
        this.path.push([P]);
        this.cursor = this.subpath = P;
    }
    lineTo(x, y) {
        this._frame();
        FINITE(x, 'x');
        FINITE(y, 'y');
        if (!this.cursor) {
            return this.moveTo(x, y);
        }
        const P = point(this.matrix, x, y);
        this.path[this.path.length - 1].push(P);
        this.cursor = P;
    }
    quadraticCurveTo(cx, cy, x, y, segments = 12) {
        this._curve(cx, cy, x, y, 0, 0, segments, false);
    }
    bezierCurveTo(a, b, c, d, x, y, segments = 16) {
        this._curve(a, b, c, d, x, y, segments, true);
    }
    /** Flattens a quadratic (control x1, y1; end x2, y2) or cubic (controls 1 and 2; end x3, y3) curve. */
    _curve(x1, y1, x2, y2, x3, y3, n, cubic) {
        this._frame();
        if (!Number.isSafeInteger(n) || n < 2 || n > 256) {
            throw new RangeError('curve segments must be 2..256');
        }
        if (!this.cursor) {
            return this.moveTo(x1, y1);
        }
        const M = this.matrix,
            START = this.cursor,
            P0X = M[0] * x1 + M[2] * y1 + M[4],
            P0Y = M[1] * x1 + M[3] * y1 + M[5],
            P1X = M[0] * x2 + M[2] * y2 + M[4],
            P1Y = M[1] * x2 + M[3] * y2 + M[5],
            P2X = cubic ? M[0] * x3 + M[2] * y3 + M[4] : 0,
            P2Y = cubic ? M[1] * x3 + M[3] * y3 + M[5] : 0,
            CONTOUR = this.path[this.path.length - 1];
        for (let i = 1; i <= n; i++) {
            const T = i / n,
                Q = 1 - T;
            let x;
            let y;
            if (cubic) {
                x = Q * Q * Q * START.x + 3 * Q * Q * T * P0X + 3 * Q * T * T * P1X + T * T * T * P2X;
                y = Q * Q * Q * START.y + 3 * Q * Q * T * P0Y + 3 * Q * T * T * P1Y + T * T * T * P2Y;
            } else {
                x = Q * Q * START.x + 2 * Q * T * P0X + T * T * P1X;
                y = Q * Q * START.y + 2 * Q * T * P0Y + T * T * P1Y;
            }
            CONTOUR.push({
                x,
                y,
            });
        }
        this.cursor = CONTOUR[CONTOUR.length - 1];
    }
    closePath() {
        if (this.cursor && this.subpath) {
            const P = this.path.at(-1);
            if (P.at(-1) !== this.subpath) {
                P.push(this.subpath);
            }
            this.cursor = this.subpath;
        }
    }
    save() {
        this._frame();
        // One pooled record per stack depth. Clip polygons and their points are never changed after they are pushed
        // and stencil clip lists are replaced rather than changed, so the saved state holds references, not copies.
        const STATE = (this.statePool[this.stack.length] ??= {
            matrix: [1, 0, 0, 1, 0, 0],
            depth: 0,
            depthPolicy: null,
            clips: [],
            stencilClips: null,
        });
        for (let i = 0; i < 6; i++) {
            STATE.matrix[i] = this.matrix[i];
        }
        STATE.depth = this.depth;
        STATE.depthPolicy = this._depthPolicy;
        STATE.clips.length = 0;
        for (let i = 0; i < this.clips.length; i++) {
            STATE.clips.push(this.clips[i]);
        }
        STATE.stencilClips = this.stencilClips;
        this.stack.push(STATE);
    }
    restore() {
        this._frame();
        const S = this.stack.pop();
        if (!S) {
            throw new Error('restore without save');
        }
        // Queued vertices hold final positions and depth; only policy or stencil changes submit the batch.
        this.depth = S.depth;
        this._setDepthPolicy(S.depthPolicy);
        for (let i = 0; i < 6; i++) {
            this.matrix[i] = S.matrix[i];
        }
        // The saved clip list becomes the live one; the former live list returns to the pool for the next save.
        const LIVE_CLIPS = this.clips;
        this.clips = S.clips;
        S.clips = LIVE_CLIPS;
        let sameStencil = S.stencilClips.length === this.stencilClips.length;
        for (let i = 0; sameStencil && i < S.stencilClips.length; i++) {
            sameStencil = S.stencilClips[i] === this.stencilClips[i];
        }
        if (!sameStencil) {
            this._submit();
            this.stencilClips = S.stencilClips;
            this._rebuildStencil();
        }
    }
    setTransform(a, b, c, d, e, f) {
        this._frame();
        if (
            !Number.isFinite(a) ||
            !Number.isFinite(b) ||
            !Number.isFinite(c) ||
            !Number.isFinite(d) ||
            !Number.isFinite(e) ||
            !Number.isFinite(f)
        ) {
            const INDEX = [a, b, c, d, e, f].findIndex((n) => !Number.isFinite(n));
            throw new TypeError(`transform[${INDEX}] must be finite`);
        }
        // Written in place: holders of the matrix (saved states, groups, gradients) keep their own copies.
        const M = this.matrix;
        M[0] = a;
        M[1] = b;
        M[2] = c;
        M[3] = d;
        M[4] = e;
        M[5] = f;
    }
    transform(a, b, c, d, e, f) {
        const M = this.matrix;
        this.setTransform(
            M[0] * a + M[2] * b,
            M[1] * a + M[3] * b,
            M[0] * c + M[2] * d,
            M[1] * c + M[3] * d,
            M[0] * e + M[2] * f + M[4],
            M[1] * e + M[3] * f + M[5],
        );
    }
    translate(x, y) {
        this.transform(1, 0, 0, 1, x, y);
    }
    rotate(angle) {
        this.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0);
    }
    scale(x, y = x) {
        this.transform(x, 0, 0, y, 0, 0);
    }
    clipRect(x, y, width, height) {
        this._frame();
        if (width < 0 || height < 0) {
            throw new RangeError('clip size must be non-negative');
        }
        const CONTOUR = [
            point(this.matrix, x, y),
            point(this.matrix, x + width, y),
            point(this.matrix, x + width, y + height),
            point(this.matrix, x, y + height),
        ];
        if (width === 0 || height === 0) {
            this._pushClip(CONTOUR);
        } else {
            this._addConvexClip(CONTOUR);
        }
    }
    /** Add the current transformed path contours to the clip stack. */
    _addConvexClip(contour) {
        if (contour.length > 1024) {
            throw new RangeError('Dynamic convex clips support at most 1024 authored points');
        }
        if (!convexContour(contour)) {
            throw new RangeError('clip() accepts convex contours; create a retained ClipPath for concave contours');
        }
        const AREA = contour.reduce(
            (sum, p, i) => sum + p.x * contour[(i + 1) % contour.length].y - contour[(i + 1) % contour.length].x * p.y,
            0,
        );
        if (Math.abs(AREA) < 1e-9) {
            this._pushClip(contour);
            return;
        }
        const PLANE_COUNT = this.clips.reduce((sum, polygon) => sum + polygon.length, 0);
        if (PLANE_COUNT + contour.length > this.maxClipPlanes) {
            this._pushDynamicStencilClip(contour);
            return;
        }
        this._pushClip(contour);
    }
    _pushDynamicStencilClip(contour) {
        if (!this.device.activeStencilAvailable) {
            throw new Error(
                'Clip contours exceeding the mesh edge-plane limit require stencil; no fallback is available',
            );
        }
        if (this.stencilClips.length >= 255) {
            throw new RangeError('At most 255 nested stencil clips are supported');
        }
        const TRIANGLES = new Float32Array((contour.length - 2) * 6);
        let at = 0;
        for (let i = 1; i + 1 < contour.length; i++) {
            for (const P of [contour[0], contour[i], contour[i + 1]]) {
                TRIANGLES[at++] = P.x;
                TRIANGLES[at++] = P.y;
            }
        }
        this._submit();
        if (!this.stencilDepth) {
            this.device.clear({
                stencil: 0,
            });
        }
        const ENTRY = {
            dynamic: true,
            triangles: TRIANGLES,
        };
        this._drawStencilClip(ENTRY, this.stencilDepth);
        this.stencilClips = [...this.stencilClips, ENTRY];
        this.stencilDepth++;
    }
    clip(rule = 'nonzero') {
        this._frame();
        if (rule !== 'nonzero' && rule !== 'evenodd') {
            throw new TypeError('rule must be nonzero or evenodd');
        }
        const CONTOURS = this.path
            .filter((path) => path.length >= 3)
            .map((path) =>
                path.map((p) => ({
                    ...p,
                })),
            );
        if (!CONTOURS.length) {
            return;
        }
        if (CONTOURS.length !== 1) {
            throw new RangeError('clip() accepts one contour; use a retained ClipPath for multi-contour geometry');
        }
        const CONTOUR = CONTOURS[0];
        if (CONTOUR.length > 3 && CONTOUR[0].x === CONTOUR.at(-1).x && CONTOUR[0].y === CONTOUR.at(-1).y) {
            CONTOUR.pop();
        }
        this._addConvexClip(CONTOUR);
    }
    createClipPath(points, { rule = 'nonzero' } = {}) {
        if (this.state !== 'ready' || this.device.state !== 'ready') {
            throw new Error('VectorRenderer is not ready');
        }
        if (this.device.active) {
            throw new Error('Create retained ClipPaths outside an active frame');
        }
        if (this.clipPaths.size >= 64) {
            throw new RangeError('At most 64 retained ClipPaths may be live');
        }
        const GEOMETRY = clipContour(points, rule);
        if (this.clipPathBytes + GEOMETRY.triangles.byteLength > 16 * 1024 * 1024) {
            throw new RangeError('Retained ClipPaths exceed the 16 MiB budget');
        }
        const BUFFER = this.device.createVertexBuffer({
            capacityBytes: GEOMETRY.triangles.byteLength,
        });
        try {
            this.device.uploadVertices(BUFFER, GEOMETRY.triangles);
        } catch (error) {
            this.device.deleteVertexBuffer(BUFFER);
            throw error;
        }
        const HANDLE = Object.freeze({
            renderer: this,
            buffer: BUFFER,
        });
        this.clipPaths.set(HANDLE, {
            buffer: BUFFER,
            triangles: GEOMETRY.triangles,
            count: GEOMETRY.triangles.length / 2,
            byteLength: GEOMETRY.triangles.byteLength,
            contour: GEOMETRY.flat,
            rule,
        });
        this.clipPathBytes += GEOMETRY.triangles.byteLength;
        return HANDLE;
    }
    deleteClipPath(handle) {
        const RECORD = this.clipPaths.get(handle);
        if (!RECORD) {
            return false;
        }
        const REFERENCED =
            this.stencilClips.some((entry) => entry.handle === handle) ||
            this.stack.some((state) => state.stencilClips.some((entry) => entry.handle === handle)) ||
            this.groups.some((group) => group.stencilClips?.some((entry) => entry.handle === handle));
        if (REFERENCED) {
            throw new Error('Remove a ClipPath from every saved clip stack before deleting it');
        }
        this.device.deleteVertexBuffer(RECORD.buffer);
        this.clipPaths.delete(handle);
        this.clipPathBytes -= RECORD.byteLength;
        return true;
    }
    clipPath(handle, { transform = null } = {}) {
        this._frame();
        const RECORD = this.clipPaths.get(handle);
        if (!RECORD) {
            throw new TypeError('ClipPath owned by this VectorRenderer is required');
        }
        if (!this.device.activeStencilAvailable) {
            throw new Error('Concave ClipPath requires an active stencil attachment; no fallback is available');
        }
        if (this.stencilClips.length >= 255) {
            throw new RangeError('At most 255 nested stencil ClipPaths are supported');
        }
        const LOCAL = transform ?? IDENTITY;
        if (LOCAL.length !== 6 || Array.from(LOCAL).some((value) => !Number.isFinite(value))) {
            throw new TypeError('ClipPath transform needs six finite values');
        }
        const MATRIX = compose(this.matrix, LOCAL);
        if (Math.abs(MATRIX[0] * MATRIX[3] - MATRIX[1] * MATRIX[2]) < 1e-12) {
            throw new RangeError('ClipPath transform must be invertible');
        }
        this._submit();
        if (!this.stencilDepth) {
            this.device.clear({
                stencil: 0,
            });
        }
        const ENTRY = {
            handle,
            matrix: Float32Array.from(MATRIX),
        };
        this._drawStencilClip(ENTRY, this.stencilDepth);
        this.stencilClips = [...this.stencilClips, ENTRY];
        this.stencilDepth++;
    }
    _drawStencilClip(entry, ref) {
        let buffer;
        let count;
        let transform;
        if (entry.dynamic) {
            buffer = this.dynamicClipBuffer;
            this.device.uploadVertices(buffer, entry.triangles);
            count = entry.triangles.length / 2;
            transform = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        } else {
            const RECORD = this.clipPaths.get(entry.handle);
            if (!RECORD) {
                throw new Error('A ClipPath in the active stack was deleted');
            }
            buffer = RECORD.buffer;
            count = RECORD.count;
            const M = entry.matrix;
            transform = Float32Array.from([M[0], M[1], 0, M[2], M[3], 0, M[4], M[5], 1]);
        }
        this.device.draw({
            pipeline: this.clipPipeline,
            buffer,
            count,
            uniforms: {
                u_projection: this.projection,
                u_transform: transform,
            },
            blend: false,
            colorMask: [false, false, false, false],
            stencil: {
                func: 'equal',
                ref,
                mask: 255,
                writeMask: 255,
                pass: 'increment',
            },
        });
    }
    _rebuildStencil() {
        this.beforeStencilChange?.();
        if (!this.stencilClips.length) {
            this.stencilDepth = 0;
            this.stencilNeedsRebuild = false;
            return;
        }
        if (!this.device.activeStencilAvailable) {
            throw new Error('Saved concave ClipPath requires a stencil attachment');
        }
        this.device.clear({
            stencil: 0,
        });
        this.stencilDepth = 0;
        for (const ENTRY of this.stencilClips) {
            this._drawStencilClip(ENTRY, this.stencilDepth);
            this.stencilDepth++;
        }
        this.stencilNeedsRebuild = false;
    }
    _clipTriangle(a, b, c, uv) {
        let poly = [a, b, c].map((p, i) =>
            uv
                ? {
                      ...p,
                      u: uv[i][0],
                      v: uv[i][1],
                  }
                : p,
        );
        for (const CLIP of this.clips) {
            let orientation = 0;
            for (let i = 0; i < CLIP.length; i++) {
                orientation += CLIP[i].x * CLIP[(i + 1) % CLIP.length].y - CLIP[(i + 1) % CLIP.length].x * CLIP[i].y;
            }
            const DIRECTION = orientation >= 0 ? 1 : -1;
            for (let i = 0; i < CLIP.length; i++) {
                const P = CLIP[i],
                    Q = CLIP[(i + 1) % CLIP.length],
                    SIDE = (v) => DIRECTION * ((Q.x - P.x) * (v.y - P.y) - (Q.y - P.y) * (v.x - P.x)),
                    OUT = [];
                let prev = poly.at(-1);
                let pv = SIDE(prev);
                for (const CUR of poly) {
                    const CV = SIDE(CUR);
                    if (pv < -1e-8 !== CV < -1e-8) {
                        const T = pv / (pv - CV),
                            VERTEX_LOCAL = {
                                x: prev.x + (CUR.x - prev.x) * T,
                                y: prev.y + (CUR.y - prev.y) * T,
                            };
                        if (uv) {
                            VERTEX_LOCAL.u = prev.u + (CUR.u - prev.u) * T;
                            VERTEX_LOCAL.v = prev.v + (CUR.v - prev.v) * T;
                        }
                        OUT.push(VERTEX_LOCAL);
                    }
                    if (CV >= -1e-8) {
                        OUT.push(CUR);
                    }
                    prev = CUR;
                    pv = CV;
                }
                poly = OUT;
                if (!poly.length) {
                    return poly;
                }
            }
        }
        return poly;
    }
    /** Makes room for `vertexCount` more vertices, submitting first when the buffer limit would be exceeded. */
    _reserve(vertexCount) {
        if (this.count + vertexCount > this.maxVertices) {
            this._submit();
        }
        if (!this.count) {
            this.batchSerial = this.clipSerial;
        }
        if ((this.count + vertexCount) * VERTEX_FLOATS > this.vertices.length) {
            const SIZE = Math.min(this.maxVertices, Math.max(this.count + vertexCount, this.count * 2));
            const NEXT = new Float32Array(SIZE * VERTEX_FLOATS);
            NEXT.set(this.vertices.subarray(0, this.count * VERTEX_FLOATS));
            this.vertices = NEXT;
        }
    }
    /** A batch holding posed sprites tests one plane set per fragment; CPU-clipped vertices must lie inside it. */
    _planesAllow() {
        const BATCH = this.poseBatch;
        if (!BATCH || BATCH.planeCount === 0 || BATCH.serial === this.clipSerial) {
            return true;
        }
        return clipPlanes(this.clips, this.maxClipPlanes).key === BATCH.planeKey;
    }
    _emitTriangle(a, b, c, color, uv = null) {
        rgba(color);
        this._emit(a, b, c, color, uv);
    }
    /**
     * Emits one triangle; the caller has validated `color`. Without a clip, uv or gradient (the common case of every
     * fill and stroke) the three vertices are written directly, without temporary arrays.
     */
    _emit(a, b, c, color, uv = null) {
        if (!this._planesAllow()) {
            this._submit();
        }
        if (!uv && !this.clips.length && !this.activeGradient) {
            this._reserve(3);
            const U = this.flatUV[0],
                V = this.flatUV[1];
            this._writeVertex(a.x, a.y, a.u ?? U, a.v ?? V, color);
            this._writeVertex(b.x, b.y, b.u ?? U, b.v ?? V, color);
            this._writeVertex(c.x, c.y, c.u ?? U, c.v ?? V, color);
            return;
        }
        if (this.activeGradient && !uv) {
            uv = [this._gradientUV(a), this._gradientUV(b), this._gradientUV(c)];
        }
        const POLY = this.clips.length
            ? this._clipTriangle(a, b, c, uv)
            : uv
              ? [a, b, c].map((point, i) => ({
                    ...point,
                    u: uv[i][0],
                    v: uv[i][1],
                }))
              : [a, b, c];
        for (let i = 1; i + 1 < POLY.length; i++) {
            this._reserve(3);
            for (const POINT of [POLY[0], POLY[i], POLY[i + 1]]) {
                const K = this.count++ * VERTEX_FLOATS;
                this.vertices[K] = POINT.x;
                this.vertices[K + 1] = POINT.y;
                this.vertices[K + 2] = POINT.u ?? this.flatUV[0];
                this.vertices[K + 3] = POINT.v ?? this.flatUV[1];
                this.vertices.set(color, K + 4);
                this.vertices.set(this.paintTemplate, K + 8);
                this.vertices[K + 20] = this.depth;
            }
        }
    }
    /**
     * _emit for the triangle in `this.triangle` (ax, ay, bx, by, cx, cy; no uv): the common unclipped, ungradiented case
     * writes the vertices directly; otherwise three point objects go through _emit exactly as before.
     */
    _emitBufferedTriangle(color) {
        const T = this.triangle;
        if (!this.clips.length && !this.activeGradient) {
            if (!this._planesAllow()) {
                this._submit();
            }
            this._reserve(3);
            const U = this.flatUV[0],
                V = this.flatUV[1];
            this._writeVertex(T[0], T[1], U, V, color);
            this._writeVertex(T[2], T[3], U, V, color);
            this._writeVertex(T[4], T[5], U, V, color);
            return;
        }
        this._emit({ x: T[0], y: T[1] }, { x: T[2], y: T[3] }, { x: T[4], y: T[5] }, color);
    }
    _writeVertex(x, y, u, v, color) {
        const K = this.count++ * VERTEX_FLOATS,
            DATA = this.vertices;
        DATA[K] = x;
        DATA[K + 1] = y;
        DATA[K + 2] = u;
        DATA[K + 3] = v;
        DATA[K + 4] = color[0];
        DATA[K + 5] = color[1];
        DATA[K + 6] = color[2];
        DATA[K + 7] = color[3];
        DATA.set(this.paintTemplate, K + 8);
        DATA[K + 20] = this.depth;
    }
    _submit() {
        if (!this.count) {
            return;
        }
        this._assertDepthTarget();
        if (
            !this.poseBatch &&
            !this.activeTarget &&
            !this.device.activeRenderTarget &&
            this.submitTriangles?.(this.vertices.subarray(0, this.count * VERTEX_FLOATS), this.count, {
                projection: this.projection,
                clips: [],
                stencilRef: this.stencilDepth || null,
                depthTest: this.depthTest,
                depthWrite: this.depthWrite,
                depthFunc: this.depthFunc,
                blend: this.blend,
            })
        ) {
            this.count = 0;
            return;
        }
        this.beforeSubmit?.();
        this.device.stats.vectorSubmissions++;
        const POSED = this.poseBatch;
        this.poseBatch = null;
        if (POSED) {
            POSED.owner.flushUpdates();
            this.posePipeline ??= this._createPosePipeline();
            this.planeScratch.fill(0);
            if (POSED.planes) {
                this.planeScratch.set(POSED.planes);
            }
        }
        this.device.uploadVertices(this.buffer, this.vertices.subarray(0, this.count * VERTEX_FLOATS));
        // Reused call, uniform and texture records: device.draw reads them before returning.
        const CALL = this.submitCall,
            TEXTURES = this.submitTextures;
        TEXTURES.length = 0;
        if (POSED) {
            const UNIFORMS = this.posedUniforms;
            UNIFORMS.u_projection = this.projection;
            UNIFORMS.u_depthWrite = Number(this.depthWrite);
            UNIFORMS.u_programWidth = POSED.programWidth;
            UNIFORMS['u_planes[0]'] = this.planeScratch;
            UNIFORMS.u_planeCount = POSED.planeCount;
            CALL.uniforms = UNIFORMS;
            for (let i = 0; i < POSED.textures.length; i++) {
                TEXTURES.push(POSED.textures[i]);
            }
            TEXTURES.push(this.atlas.texture);
        } else {
            const UNIFORMS = this.flatUniforms;
            UNIFORMS.u_projection = this.projection;
            UNIFORMS.u_depthWrite = Number(this.depthWrite);
            CALL.uniforms = UNIFORMS;
            TEXTURES.push(this.activeTarget ?? this.atlas.texture);
        }
        CALL.pipeline = POSED ? this.posePipeline : this.activeTarget ? this.groupPipeline : this.pipeline;
        CALL.buffer = this.buffer;
        CALL.count = this.count;
        CALL.textures = TEXTURES;
        CALL.blend = this.blend;
        CALL.depth = this._depthPolicy;
        CALL.stencil = this.stencilDepth ? stencilEqual(this.stencilDepth) : false;
        try {
            this.device.draw(CALL);
        } finally {
            TEXTURES.length = 0;
            CALL.uniforms = CALL.textures = null;
            if (POSED) {
                POSED.owner = POSED.textures = POSED.planes = null;
            }
        }
        this.count = 0;
    }
    _createPosePipeline() {
        return this.device.createPipeline({
            vertex: vertexShader(true),
            fragment: fragmentShader(this.maxClipPlanes),
            stride: VERTEX_BYTES,
            attributes: VERTEX_ATTRIBUTES,
            uniforms: {
                u_projection: 'matrix3fv',
                u_program: '1i',
                u_state: '1i',
                u_overrides: '1i',
                u_texture: '1i',
                u_depthWrite: '1f',
                u_programWidth: '1i',
                'u_planes[0]': '3fv',
                u_planeCount: '1i',
            },
        });
    }
    // Only source-over and the additive 'lighter' are offered; a change submits what the other operation queued.
    setBlend(blend) {
        if (blend !== 'source-over' && blend !== 'lighter') {
            throw new RangeError('VectorRenderer supports only source-over and lighter blending');
        }
        if (blend !== this.blend) {
            this._submit();
            this.blend = blend;
        }
    }
    /**
     * Selects the atlas region later vertices sample. Paint is vertex data, so changing it never submits: only the
     * switch between the atlas and an offscreen group target (a different sampler) does.
     */
    _setPaint(region, { radial = false, whiteFlash = false, gradient = null } = EMPTY_OPTIONS) {
        if (this.activeTarget) {
            this._submit();
            this.activeTarget = null;
        }
        const RECT = region.uvRect,
            U = RECT[0],
            V = RECT[1],
            W = RECT[2],
            H = RECT[3],
            MODE = radial ? (gradient?.radialEmpty ? 2 : 1) : gradient ? 3 : 0,
            PARAMS = radial ? (gradient?.radialParams ?? NO_RADIAL) : NO_RADIAL;
        this.activeRadial = radial;
        this.activeWhiteFlash = whiteFlash;
        this.activeGradient = gradient;
        this.activeRegion = region;
        this.flatUV[0] = U + W / 2;
        this.flatUV[1] = V + H / 2;
        const TEMPLATE = this.paintTemplate;
        TEMPLATE[0] = region.layer;
        TEMPLATE[1] = whiteFlash ? 1 : 0;
        TEMPLATE[2] = MODE;
        TEMPLATE[3] = region.filter === 'nearest' ? 1 : 0;
        TEMPLATE[4] = PARAMS[0];
        TEMPLATE[5] = PARAMS[1];
        TEMPLATE[6] = PARAMS[2];
        TEMPLATE[7] = PARAMS[3];
        TEMPLATE[8] = U;
        TEMPLATE[9] = V;
        TEMPLATE[10] = W;
        TEMPLATE[11] = H;
    }
    /** Switches later vertices to plain per-vertex paint (no atlas region, gradient or group target). */
    _useVertexPaint(template, whiteFlash = false) {
        this._beginVertexPaint(whiteFlash);
        this.paintTemplate.set(template);
    }
    /** _useVertexPaint without the template copy: the caller writes `paintTemplate` itself. */
    _beginVertexPaint(whiteFlash) {
        if (this.activeTarget) {
            this._submit();
            this.activeTarget = null;
        }
        this.activeRegion = null;
        this.activeRadial = false;
        this.activeWhiteFlash = whiteFlash;
        this.activeGradient = null;
    }
    /**
     * Fills or strokes one analytic primitive: `matrix` maps the local square [-1,1]^2 to screen space (the caller
     * has applied the current transform) and `params` is [kind (0 ellipse, 1 rectangle, 2 line), stroke, width, option].
     */
    drawPrimitive({ matrix, color, params }) {
        this._frame();
        rgba(color);
        if (matrix?.length !== 6 || params?.length !== 4) {
            throw new TypeError('drawPrimitive requires a 6-value matrix and 4 parameters');
        }
        for (let i = 0; i < 6; i++) {
            FINITE(matrix[i], 'drawPrimitive value');
        }
        for (let i = 0; i < 4; i++) {
            FINITE(params[i], 'drawPrimitive value');
        }
        const M = matrix,
            TEMPLATE = this.paintTemplate;
        this._beginVertexPaint(false);
        TEMPLATE[0] = 0;
        TEMPLATE[1] = 0;
        TEMPLATE[2] = MODE_PRIMITIVE;
        TEMPLATE[3] = 0;
        TEMPLATE[4] = params[0];
        TEMPLATE[5] = params[1];
        TEMPLATE[6] = params[2];
        TEMPLATE[7] = params[3];
        TEMPLATE[8] = M[0];
        TEMPLATE[9] = M[2];
        TEMPLATE[10] = M[1];
        TEMPLATE[11] = M[3];
        if (!this.clips.length) {
            // Unclipped (the common case): the two triangles 0,1,2 and 0,2,3 are written directly.
            for (let triangle = 0; triangle < 2; triangle++) {
                if (!this._planesAllow()) {
                    this._submit();
                }
                this._reserve(3);
                for (let corner = 0; corner < 3; corner++) {
                    const AT = (corner === 0 ? 0 : corner + triangle) * 2,
                        X = PRIMITIVE_CORNERS[AT],
                        Y = PRIMITIVE_CORNERS[AT + 1];
                    this._writeVertex(M[0] * X + M[2] * Y + M[4], M[1] * X + M[3] * Y + M[5], X, Y, color);
                }
            }
            return;
        }
        const CORNERS = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
        ];
        const WORLD = CORNERS.map((corner) => point(M, corner[0], corner[1]));
        this._emitTriangle(WORLD[0], WORLD[1], WORLD[2], color, [CORNERS[0], CORNERS[1], CORNERS[2]]);
        this._emitTriangle(WORLD[0], WORLD[2], WORLD[3], color, [CORNERS[0], CORNERS[2], CORNERS[3]]);
    }
    /**
     * Draws atlas rectangles in painter order. Run i places `localRects[i]` (x, y, width, height) on the current
     * transform composed with `matrix` and samples `uvRects[i]` of `layer`; uv and size may be negative for content that
     * was rendered rather than uploaded. With `pose` (a handle of a PoseRenderer, evaluated on the GPU from its
     * keyframe program) every run also follows the pose part `parts[i]`. All runs join the current batch, so one
     * blend/clip state is one draw whatever mix of sprites, shapes and glyphs it holds.
     */
    drawQuads({
        layer,
        uvRects,
        localRects,
        parts = null,
        pose = null,
        matrix = IDENTITY,
        color = [1, 1, 1, 1],
        alpha = 1,
        whiteFlash = false,
        forceColor = false,
        filter = 'linear',
        depthWriteAlphaThreshold = 0,
    } = {}) {
        this._frame();
        const COUNT = uvRects?.length / 4;
        // Validation, tint and composed matrix use reused records: every value is copied into vertices below.
        const CHECK = this.quadCheck;
        CHECK.layer = layer;
        CHECK.uvRects = uvRects;
        CHECK.localRects = localRects;
        CHECK.matrix = matrix;
        CHECK.color = color;
        CHECK.alpha = alpha;
        CHECK.filter = filter;
        CHECK.parts = parts;
        CHECK.pose = pose;
        CHECK.depthWriteAlphaThreshold = depthWriteAlphaThreshold;
        try {
            validateQuads(CHECK);
        } finally {
            CHECK.uvRects = CHECK.localRects = CHECK.matrix = CHECK.color = CHECK.parts = CHECK.pose = null;
        }
        const TINT = this.quadTint,
            M = composeInto(this.matrix, matrix, this.quadMatrix),
            TEMPLATE = this.paintTemplate;
        TINT[0] = color[0];
        TINT[1] = color[1];
        TINT[2] = color[2];
        TINT[3] = color[3] * alpha;
        this._beginVertexPaint(whiteFlash);
        TEMPLATE.fill(0);
        TEMPLATE[0] = layer + depthWriteAlphaThreshold * 0.49;
        TEMPLATE[1] = whiteFlash ? 1 : forceColor ? 2 : 0;
        TEMPLATE[3] = filter === 'nearest' ? 1 : 0;
        TEMPLATE[10] = 1;
        TEMPLATE[11] = 1;
        if (pose === null) {
            if (parts !== null) {
                throw new TypeError('parts require a pose');
            }
            this.device.stats.spriteRuns += COUNT;
            for (let i = 0; i < COUNT; i++) {
                const AT = i * 4,
                    LX = localRects[AT],
                    LY = localRects[AT + 1],
                    LW = localRects[AT + 2],
                    LH = localRects[AT + 3],
                    U = uvRects[AT],
                    V = uvRects[AT + 1],
                    UW = uvRects[AT + 2],
                    VH = uvRects[AT + 3];
                if (!this.clips.length) {
                    if (!this._planesAllow()) {
                        this._submit();
                    }
                    // Same corners and triangle order as the clipped path, without allocating point/UV arrays
                    // or copying three point objects per triangle. Reserve per triangle for tiny batch limits.
                    const RX = LX + LW,
                        BY = LY + LH,
                        X0 = M[0] * LX + M[2] * LY + M[4],
                        Y0 = M[1] * LX + M[3] * LY + M[5],
                        X1 = M[0] * RX + M[2] * LY + M[4],
                        Y1 = M[1] * RX + M[3] * LY + M[5],
                        X2 = M[0] * RX + M[2] * BY + M[4],
                        Y2 = M[1] * RX + M[3] * BY + M[5],
                        X3 = M[0] * LX + M[2] * BY + M[4],
                        Y3 = M[1] * LX + M[3] * BY + M[5];
                    this._reserve(3);
                    this._writeVertex(X0, Y0, U, V, TINT);
                    this._writeVertex(X1, Y1, U + UW, V, TINT);
                    this._writeVertex(X2, Y2, U + UW, V + VH, TINT);
                    this._reserve(3);
                    this._writeVertex(X0, Y0, U, V, TINT);
                    this._writeVertex(X2, Y2, U + UW, V + VH, TINT);
                    this._writeVertex(X3, Y3, U, V + VH, TINT);
                    continue;
                }
                const CORNERS = [
                    [point(M, LX, LY), [U, V]],
                    [point(M, LX + LW, LY), [U + UW, V]],
                    [point(M, LX + LW, LY + LH), [U + UW, V + VH]],
                    [point(M, LX, LY + LH), [U, V + VH]],
                ];
                // The clipped path keeps per-triangle corner arrays; the tint is copied into vertices at once.
                this._emitTriangle(CORNERS[0][0], CORNERS[1][0], CORNERS[2][0], TINT, [
                    CORNERS[0][1],
                    CORNERS[1][1],
                    CORNERS[2][1],
                ]);
                this._emitTriangle(CORNERS[0][0], CORNERS[2][0], CORNERS[3][0], TINT, [
                    CORNERS[0][1],
                    CORNERS[2][1],
                    CORNERS[3][1],
                ]);
            }
            return;
        }
        const OWNER = poseRendererOf(pose);
        if (!OWNER || parts?.length !== COUNT) {
            throw new TypeError('A live pose handle and one part per run are required');
        }
        const DRAW = OWNER.resolve(pose, PROGRAM_RESOLVE);
        if (DRAW.kind !== 'program') {
            throw new TypeError('Posed sprites require a keyframe program pose');
        }
        for (let i = 0; i < COUNT; i++) {
            if (!Number.isInteger(parts[i]) || parts[i] < 0 || parts[i] >= DRAW.partCount) {
                throw new RangeError('parts must be pose part indices');
            }
        }
        this._beginPosed(OWNER, DRAW);
        OWNER.noteDraw(pose);
        this.device.stats.spriteRuns += COUNT;
        for (let i = 0; i < COUNT; i++) {
            const AT = i * 4,
                LX = localRects[AT],
                LY = localRects[AT + 1],
                LW = localRects[AT + 2],
                LH = localRects[AT + 3],
                U = uvRects[AT],
                V = uvRects[AT + 1],
                UW = uvRects[AT + 2],
                VH = uvRects[AT + 3];
            this._reserve(6);
            for (let corner = 0; corner < POSED_CORNERS.length; corner++) {
                const CX = POSED_CORNERS[corner][0],
                    CY = POSED_CORNERS[corner][1];
                const K = this.count++ * VERTEX_FLOATS;
                this.vertices[K] = LX + CX * LW;
                this.vertices[K + 1] = LY + CY * LH;
                this.vertices[K + 2] = U + CX * UW;
                this.vertices[K + 3] = V + CY * VH;
                this.vertices.set(TINT, K + 4);
                this.vertices.set(this.paintTemplate, K + 8);
                this.vertices[K + 10] = MODE_POSED;
                this.vertices[K + 12] = M[0];
                this.vertices[K + 13] = M[1];
                this.vertices[K + 14] = M[2];
                this.vertices[K + 15] = M[3];
                this.vertices[K + 16] = M[4];
                this.vertices[K + 17] = M[5];
                this.vertices[K + 18] = DRAW.row;
                this.vertices[K + 19] = parts[i];
                this.vertices[K + 20] = this.depth;
            }
        }
    }
    /** Joins or opens the batch's posed section: one pose texture set and one clip plane set per draw. */
    _beginPosed(owner, draw) {
        const PLANES = clipPlanes(this.clips, this.maxClipPlanes),
            BATCH = this.poseBatch;
        let otherTextures = false;
        if (BATCH) {
            for (let i = 0; i < BATCH.textures.length; i++) {
                otherTextures ||= BATCH.textures[i] !== draw.textures[i];
            }
        }
        if (
            BATCH &&
            (BATCH.owner !== owner ||
                otherTextures ||
                (BATCH.planeKey !== PLANES.key && BATCH.planeCount + PLANES.count > 0))
        ) {
            this._submit();
        } else if (!BATCH && this.count && PLANES.count > 0 && this.batchSerial !== this.clipSerial) {
            // CPU-clipped vertices of an earlier clip would be cut by this clip's planes.
            this._submit();
        }
        if (!this.poseBatch) {
            // One reused batch record: _submit reads it and clears `poseBatch` before the next one opens.
            const NEXT = this.poseBatchRecord;
            NEXT.owner = owner;
            NEXT.textures = draw.textures;
            NEXT.programWidth = draw.programWidth;
            NEXT.planeKey = PLANES.key;
            NEXT.planeCount = PLANES.count;
            NEXT.planes = PLANES.values;
            NEXT.serial = this.clipSerial;
            this.poseBatch = NEXT;
        }
    }
    _useTarget(target) {
        if (this.activeTarget !== target) {
            this._submit();
        }
        this.activeTarget = target;
        this.activeRegion = null;
        this.activeRadial = false;
        this.activeWhiteFlash = false;
        this.activeGradient = null;
        this.flatUV[0] = 0;
        this.flatUV[1] = 0;
        this.paintTemplate.fill(0);
        this.paintTemplate[10] = 1;
        this.paintTemplate[11] = 1;
    }
    fill(colorValue = BLACK, rule = 'nonzero') {
        this._frame();
        if (rule !== 'nonzero' && rule !== 'evenodd') {
            throw new TypeError('rule must be nonzero or evenodd');
        }
        this._setPaint(this.whiteRegion);
        this.device.stats.pathTessellations++;
        const COL = rgba(colorValue);
        this._emitTessellation(tessellate(this.path, rule), COL);
    }
    fillRadialGradient(gradient) {
        this._frame();
        if (
            !gradient?.region ||
            !gradient.matrixInverse ||
            !Number.isFinite(gradient.radialScale) ||
            gradient.radialScale <= 0 ||
            !Array.isArray(gradient.radialParams) ||
            gradient.radialParams.length !== 4 ||
            gradient.radialParams.some((value) => !Number.isFinite(value))
        ) {
            throw new TypeError('valid two-circle radial gradient texture and transform are required');
        }
        this._setPaint(gradient.region, {
            radial: true,
            whiteFlash: gradient.whiteFlash,
            gradient,
        });
        this.device.stats.pathTessellations++;
        const VERTEX_COUNT = tessellate(this.path, gradient.rule ?? 'nonzero');
        if (VERTEX_COUNT) {
            rgba(gradient.color);
        }
        this._emitTessellation(VERTEX_COUNT, gradient.color);
    }
    fillLinearGradient(gradient) {
        this._frame();
        if (
            !gradient?.region ||
            !gradient.matrixInverse ||
            ![gradient.x0, gradient.y0, gradient.x1, gradient.y1].every(Number.isFinite)
        ) {
            throw new TypeError('valid linear gradient texture and transform are required');
        }
        this._setPaint(gradient.region, {
            whiteFlash: gradient.whiteFlash,
            gradient,
        });
        const VERTEX_COUNT = tessellate(this.path, gradient.rule ?? 'nonzero');
        if (VERTEX_COUNT) {
            rgba(gradient.color);
        }
        this._emitTessellation(VERTEX_COUNT, gradient.color);
    }
    /** Emits the triangles the last tessellate() call left in its output buffer. */
    _emitTessellation(vertexCount, color) {
        const OUT = TESSELLATION.out;
        for (let i = 0; i + 2 < vertexCount; i += 3) {
            const AT = i * 2;
            const TRIANGLE = this.triangle;
            TRIANGLE[0] = OUT[AT];
            TRIANGLE[1] = OUT[AT + 1];
            TRIANGLE[2] = OUT[AT + 2];
            TRIANGLE[3] = OUT[AT + 3];
            TRIANGLE[4] = OUT[AT + 4];
            TRIANGLE[5] = OUT[AT + 5];
            this._emitBufferedTriangle(color);
        }
    }
    _gradientUV(p) {
        const G = this.activeGradient,
            M = G.matrixInverse,
            X = M[0] * p.x + M[2] * p.y + M[4],
            Y = M[1] * p.x + M[3] * p.y + M[5];
        if (this.activeRadial) {
            return [(X - G.x0) / G.radialScale, (Y - G.y0) / G.radialScale];
        }
        const DX = G.x1 - G.x0,
            DY = G.y1 - G.y0,
            DENOM = DX * DX + DY * DY;
        return [DENOM ? ((X - G.x0) * DX + (Y - G.y0) * DY) / DENOM : 1, 0.5];
    }
    stroke(
        colorValue = BLACK,
        width = 1,
        { lineCap = 'butt', lineJoin = 'miter', miterLimit = 10 } = EMPTY_OPTIONS,
        gradient = null,
    ) {
        this._frame();
        this._setPaint(gradient?.region ?? this.whiteRegion, {
            radial: gradient?.kind === 'radial',
            whiteFlash: gradient?.whiteFlash ?? false,
            gradient,
        });
        this.device.stats.pathStrokeBuilds++;
        const TRIANGLE = this.triangle;
        rgba(colorValue);
        if (!Number.isFinite(width) || width <= 0) {
            throw new RangeError('line width must be positive');
        }
        if (
            (lineCap !== 'butt' && lineCap !== 'round' && lineCap !== 'square') ||
            (lineJoin !== 'miter' && lineJoin !== 'round' && lineJoin !== 'bevel') ||
            !Number.isFinite(miterLimit) ||
            miterLimit <= 0
        ) {
            throw new TypeError('invalid stroke style');
        }
        const HALF = width / 2,
            ARC_STEP =
                HALF > ARC_TOLERANCE ? Math.min(Math.PI / 2, 2 * Math.acos(1 - ARC_TOLERANCE / HALF)) : Math.PI / 2;
        for (let s = 0; s < this.path.length; s++) {
            const SOURCE = this.path[s];
            // Contour x, y pairs without consecutive repeats; then per segment its unit direction and half-width normal.
            if (SOURCE.length * 2 > this.strokePoints.length) {
                const SIZE = Math.max(SOURCE.length * 2, this.strokePoints.length * 2);
                this.strokePoints = new Float64Array(SIZE);
                this.strokeDirections = new Float64Array(SIZE);
                this.strokeNormals = new Float64Array(SIZE);
            }
            const POINTS = this.strokePoints,
                DIRS = this.strokeDirections,
                NORMALS = this.strokeNormals;
            let length = 0;
            for (let i = 0; i < SOURCE.length; i++) {
                const P = SOURCE[i];
                if (!i || P.x !== SOURCE[i - 1].x || P.y !== SOURCE[i - 1].y) {
                    POINTS[length * 2] = P.x;
                    POINTS[length * 2 + 1] = P.y;
                    length++;
                }
            }
            if (length < 2) {
                continue;
            }
            const CLOSED =
                length > 2 && POINTS[0] === POINTS[(length - 1) * 2] && POINTS[1] === POINTS[(length - 1) * 2 + 1];
            if (CLOSED) {
                length--;
            }
            const COUNT = CLOSED ? length : length - 1;
            for (let i = 0; i < COUNT; i++) {
                const A = i * 2,
                    B = ((i + 1) % length) * 2,
                    DX = POINTS[B] - POINTS[A],
                    DY = POINTS[B + 1] - POINTS[A + 1],
                    L = Math.hypot(DX, DY);
                if (!L) {
                    DIRS[i * 2] = DIRS[i * 2 + 1] = NORMALS[i * 2] = NORMALS[i * 2 + 1] = 0;
                    continue;
                }
                DIRS[i * 2] = DX / L;
                DIRS[i * 2 + 1] = DY / L;
                NORMALS[i * 2] = (-DY / L) * HALF;
                NORMALS[i * 2 + 1] = (DX / L) * HALF;
            }
            for (let i = 0; i < COUNT; i++) {
                const A = i * 2,
                    B = ((i + 1) % length) * 2,
                    DIR_X = DIRS[i * 2],
                    DIR_Y = DIRS[i * 2 + 1],
                    NX = NORMALS[i * 2],
                    NY = NORMALS[i * 2 + 1];
                if (!DIR_X && !DIR_Y) {
                    continue;
                }
                const EXTEND = !CLOSED && lineCap === 'square' && (i === 0 || i === COUNT - 1) ? HALF : 0,
                    AX = POINTS[A] - DIR_X * EXTEND,
                    AY = POINTS[A + 1] - DIR_Y * EXTEND,
                    BX = POINTS[B] + DIR_X * EXTEND,
                    BY = POINTS[B + 1] + DIR_Y * EXTEND;
                // Quad P, Q, R, S as triangles P, Q, R and P, R, S.
                TRIANGLE[0] = AX + NX;
                TRIANGLE[1] = AY + NY;
                TRIANGLE[2] = BX + NX;
                TRIANGLE[3] = BY + NY;
                TRIANGLE[4] = BX - NX;
                TRIANGLE[5] = BY - NY;
                this._emitBufferedTriangle(colorValue);
                TRIANGLE[0] = AX + NX;
                TRIANGLE[1] = AY + NY;
                TRIANGLE[2] = BX - NX;
                TRIANGLE[3] = BY - NY;
                TRIANGLE[4] = AX - NX;
                TRIANGLE[5] = AY - NY;
                this._emitBufferedTriangle(colorValue);
            }
            const JOIN_START = CLOSED ? 0 : 1,
                JOIN_END = CLOSED ? length : length - 1;
            for (let i = JOIN_START; i < JOIN_END; i++) {
                const PREV = ((i - 1 + COUNT) % COUNT) * 2,
                    NEXT = (i % COUNT) * 2,
                    V = (i % length) * 2,
                    VX = POINTS[V],
                    VY = POINTS[V + 1],
                    D0X = DIRS[PREV],
                    D0Y = DIRS[PREV + 1],
                    D1X = DIRS[NEXT],
                    D1Y = DIRS[NEXT + 1],
                    N0X = NORMALS[PREV],
                    N0Y = NORMALS[PREV + 1],
                    N1X = NORMALS[NEXT],
                    N1Y = NORMALS[NEXT + 1],
                    CROSS = D0X * D1Y - D0Y * D1X;
                if (Math.abs(CROSS) < 1e-8) {
                    continue;
                }
                const SIGN = CROSS > 0 ? -1 : 1,
                    AX = VX + N0X * SIGN,
                    AY = VY + N0Y * SIGN,
                    BX = VX + N1X * SIGN,
                    BY = VY + N1Y * SIGN;
                if (lineJoin === 'round') {
                    const START = Math.atan2(AY - VY, AX - VX);
                    // The join is the short arc between the two outer offset points, fanned from the vertex.
                    let sweep = Math.atan2(BY - VY, BX - VX) - START;
                    while (sweep > Math.PI) {
                        sweep -= Math.PI * 2;
                    }
                    while (sweep < -Math.PI) {
                        sweep += Math.PI * 2;
                    }
                    const STEPS = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
                    let previousX = AX,
                        previousY = AY;
                    for (let j = 1; j <= STEPS; j++) {
                        const T = START + (sweep * j) / STEPS,
                            X = VX + Math.cos(T) * HALF,
                            Y = VY + Math.sin(T) * HALF;
                        TRIANGLE[0] = VX;
                        TRIANGLE[1] = VY;
                        TRIANGLE[2] = previousX;
                        TRIANGLE[3] = previousY;
                        TRIANGLE[4] = X;
                        TRIANGLE[5] = Y;
                        this._emitBufferedTriangle(colorValue);
                        previousX = X;
                        previousY = Y;
                    }
                } else if (lineJoin === 'miter') {
                    const MX = N0X * SIGN + N1X * SIGN,
                        MY = N0Y * SIGN + N1Y * SIGN,
                        ML = Math.hypot(MX, MY),
                        DENOM = ML ? (MX / ML) * (N1X * SIGN) + (MY / ML) * (N1Y * SIGN) : 0,
                        MITER = DENOM ? HALF / DENOM : Infinity;
                    if (Number.isFinite(MITER) && Math.abs(MITER) <= HALF * miterLimit) {
                        TRIANGLE[0] = AX;
                        TRIANGLE[1] = AY;
                        TRIANGLE[2] = VX + (MX / ML) * MITER;
                        TRIANGLE[3] = VY + (MY / ML) * MITER;
                        TRIANGLE[4] = BX;
                        TRIANGLE[5] = BY;
                        this._emitBufferedTriangle(colorValue);
                    } else {
                        TRIANGLE[0] = VX;
                        TRIANGLE[1] = VY;
                        TRIANGLE[2] = AX;
                        TRIANGLE[3] = AY;
                        TRIANGLE[4] = BX;
                        TRIANGLE[5] = BY;
                        this._emitBufferedTriangle(colorValue);
                    }
                } else {
                    TRIANGLE[0] = VX;
                    TRIANGLE[1] = VY;
                    TRIANGLE[2] = AX;
                    TRIANGLE[3] = AY;
                    TRIANGLE[4] = BX;
                    TRIANGLE[5] = BY;
                    this._emitBufferedTriangle(colorValue);
                }
            }
            if (!CLOSED && lineCap === 'round') {
                const CAP_STEPS = Math.max(2, Math.ceil(Math.PI / ARC_STEP));
                for (let cap = 0; cap < 2; cap++) {
                    const SEGMENT = cap === 0 ? 0 : (COUNT - 1) * 2,
                        ANGLE = Math.atan2(DIRS[SEGMENT + 1], DIRS[SEGMENT]) + (cap === 0 ? Math.PI : 0),
                        // As before, the end cap of a one-segment line (segment index 0) is centred on the first
                        // point; kept unchanged so the drawn output stays the same.
                        V = SEGMENT === 0 ? 0 : (length - 1) * 2,
                        VX = POINTS[V],
                        VY = POINTS[V + 1],
                        START = ANGLE - Math.PI / 2;
                    let previousX = 0,
                        previousY = 0;
                    for (let j = 0; j <= CAP_STEPS; j++) {
                        const T = START + (Math.PI * j) / CAP_STEPS,
                            X = VX + Math.cos(T) * HALF,
                            Y = VY + Math.sin(T) * HALF;
                        if (j) {
                            TRIANGLE[0] = VX;
                            TRIANGLE[1] = VY;
                            TRIANGLE[2] = previousX;
                            TRIANGLE[3] = previousY;
                            TRIANGLE[4] = X;
                            TRIANGLE[5] = Y;
                            this._emitBufferedTriangle(colorValue);
                        }
                        previousX = X;
                        previousY = Y;
                    }
                }
            }
        }
    }
    polygon(points, colorValue = [0, 0, 0, 1]) {
        this.beginPath();
        points.forEach((p, i) => (i ? this.lineTo(p[0], p[1]) : this.moveTo(p[0], p[1])));
        this.closePath();
        this.fill(colorValue);
    }
    /** Submit the caller's authored fan topology directly, including clipping. */
    triangleFan(points, colorValue = [1, 1, 1, 1]) {
        this._frame();
        if (!points || points.length < 3) {
            return;
        }
        this._setPaint(this.whiteRegion);
        const M = this.matrix,
            ANCHOR = point(M, points[0][0], points[0][1]);
        let previous = point(M, points[1][0], points[1][1]);
        for (let i = 2; i < points.length; i++) {
            const CURRENT = point(M, points[i][0], points[i][1]);
            this._emitTriangle(ANCHOR, previous, CURRENT, colorValue);
            previous = CURRENT;
        }
    }
    fillText(text, x, y, options = {}) {
        this._frame();
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        return this.glyphAtlas.fillText(this, text, x, y, options);
    }
    strokeText(text, x, y, options = {}) {
        this._frame();
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        return this.glyphAtlas.strokeText(this, text, x, y, options);
    }
    measureText(text, options = {}) {
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        return this.glyphAtlas.measureText(text, options);
    }
    /** `region` is the glyph atlas region (its layer selects the page); `uv` is already in array coordinates. */
    drawGlyphQuad(region, x, y, width, height, uv, colorValue) {
        this._frame();
        this._setPaint(region);
        const A = {
                ...point(this.matrix, x, y),
            },
            B = {
                ...point(this.matrix, x + width, y),
            },
            C = {
                ...point(this.matrix, x + width, y + height),
            },
            D = {
                ...point(this.matrix, x, y + height),
            };
        this._emitTriangle(A, B, C, colorValue, [
            [uv.u0, uv.v0],
            [uv.u1, uv.v0],
            [uv.u1, uv.v1],
        ]);
        this._emitTriangle(A, C, D, colorValue, [
            [uv.u0, uv.v0],
            [uv.u1, uv.v1],
            [uv.u0, uv.v1],
        ]);
    }
    flush() {
        this._frame();
        this.device.stats.vectorFlushCalls++;
        this._submit();
    }
    beginGroup(opacity = 1, bounds = null) {
        this._frame();
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            throw new RangeError('group opacity must be in [0,1]');
        }
        this._submit();
        if (opacity === 1) {
            this.groups.push({
                direct: true,
            });
            return;
        }
        if (this.depthTest || this.depthWrite) {
            throw new Error('Opacity groups require depth testing and writes to be disabled');
        }
        const REQUESTED = bounds ?? {
            x: 0,
            y: 0,
            width: this.canvas.width,
            height: this.canvas.height,
        };
        for (const KEY of ['x', 'y', 'width', 'height']) {
            if (!Number.isFinite(REQUESTED[KEY])) {
                throw new TypeError(`group bounds.${KEY} must be finite`);
            }
        }
        if (REQUESTED.width <= 0 || REQUESTED.height <= 0) {
            throw new RangeError('group bounds must have positive size');
        }
        const X = Math.max(0, Math.floor(REQUESTED.x)),
            Y = Math.max(0, Math.floor(REQUESTED.y)),
            RIGHT = Math.min(this.canvas.width, Math.ceil(REQUESTED.x + REQUESTED.width)),
            BOTTOM = Math.min(this.canvas.height, Math.ceil(REQUESTED.y + REQUESTED.height)),
            WIDTH = RIGHT - X,
            HEIGHT = BOTTOM - Y;
        if (WIDTH <= 0 || HEIGHT <= 0) {
            this.groups.push({
                direct: true,
                empty: true,
            });
            return;
        }
        const DEPTH = this.groups.filter((g) => !g.direct).length;
        let target = this.groupTargets[DEPTH];
        const ALLOCATION = (n) => Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(n))),
            NEED_W = ALLOCATION(WIDTH),
            NEED_H = ALLOCATION(HEIGHT),
            NEED_STENCIL = this.device.stencilAvailable;
        if (
            !target ||
            target.width < WIDTH ||
            target.height < HEIGHT ||
            Boolean(this.device.renderTargets.get(target)?.stencil) !== NEED_STENCIL
        ) {
            if (target) {
                this.device.deleteRenderTarget(target);
            }
            target = this.groupTargets[DEPTH] = this.device.createRenderTarget(NEED_W, NEED_H, {
                filter: 'nearest',
                stencil: NEED_STENCIL,
            });
        }
        const GROUP = {
            target,
            opacity,
            bounds: {
                x: X,
                y: Y,
                width: WIDTH,
                height: HEIGHT,
            },
            matrix: this.matrix.slice(),
            clips: this.clips,
            stencilClips: this.stencilClips.slice(),
            projection: this.projection.slice(),
        };
        this.device.bindRenderTarget(target);
        this.groups.push(GROUP);
        this._setProjection(GROUP.bounds, target);
        this.device.clear({
            color: [0, 0, 0, 0],
            ...(this.device.activeStencilAvailable
                ? {
                      stencil: 0,
                  }
                : {}),
        });
        this.stencilDepth = 0;
        if (this.stencilClips.length) {
            this._rebuildStencil();
        }
        this.clips = [
            ...this.clips,
            [
                {
                    x: X,
                    y: Y,
                },
                {
                    x: RIGHT,
                    y: Y,
                },
                {
                    x: RIGHT,
                    y: BOTTOM,
                },
                {
                    x: X,
                    y: BOTTOM,
                },
            ],
        ];
    }
    endGroup() {
        this._frame();
        const GROUP = this.groups.pop();
        if (!GROUP) {
            throw new Error('endGroup without beginGroup');
        }
        this._submit();
        if (GROUP.direct) {
            return;
        }
        this.device.unbindRenderTarget(GROUP.target);
        this.matrix = GROUP.matrix;
        this.clips = GROUP.clips;
        this.stencilClips = GROUP.stencilClips;
        this.stencilDepth = this.stencilClips.length;
        this.projection.set(GROUP.projection);
        this._useTarget(GROUP.target);
        const { x: X, y: Y, width: WIDTH, height: HEIGHT } = GROUP.bounds,
            U = WIDTH / GROUP.target.width,
            V = HEIGHT / GROUP.target.height,
            A = {
                x: X,
                y: Y,
            },
            B = {
                x: X + WIDTH,
                y: Y,
            },
            C = {
                x: X + WIDTH,
                y: Y + HEIGHT,
            },
            D = {
                x: X,
                y: Y + HEIGHT,
            },
            ALPHA = [1, 1, 1, GROUP.opacity];
        this._emitTriangle(A, B, C, ALPHA, [
            [0, 1],
            [U, 1],
            [U, 1 - V],
        ]);
        this._emitTriangle(A, C, D, ALPHA, [
            [0, 1],
            [U, 1 - V],
            [0, 1 - V],
        ]);
        this._submit();
        this._setPaint(this.whiteRegion);
    }
    dispose() {
        if (this.state === 'disposed') {
            return;
        }
        this.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.count = 0;
        for (const TARGET of this.groupTargets) {
            this.device.deleteRenderTarget(TARGET);
        }
        for (const RECORD of this.clipPaths.values()) {
            this.device.deleteVertexBuffer(RECORD.buffer);
        }
        this.clipPaths.clear();
        this.clipPathBytes = 0;
        this.device.deleteVertexBuffer(this.dynamicClipBuffer);
        this.device.deleteVertexBuffer(this.buffer);
        this.device.deletePipeline(this.clipPipeline);
        this.device.deletePipeline(this.groupPipeline);
        this.device.deletePipeline(this.pipeline);
        if (this.posePipeline) {
            this.device.deletePipeline(this.posePipeline);
        }
        this.unregisterBatcher();
        if (this.whiteRegion && this.device.state === 'ready') {
            this.atlas.release(this.whiteRegion);
        }
        this.buffer =
            this.dynamicClipBuffer =
            this.clipPipeline =
            this.groupPipeline =
            this.posePipeline =
            this.pipeline =
            this.whiteRegion =
                null;
        this.state = 'disposed';
    }
}

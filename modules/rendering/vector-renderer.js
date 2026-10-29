import { clipPlanes } from './clip-planes.js';
import { poseRendererOf } from './pose-renderer.js';
import { POSE_PROGRAM_FUNCTIONS } from './pose-shader.js';

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
// One vertex layout for every textured draw: texture identity, gradient kind and flash are vertex data,
// so fills, gradients, glyphs and sprites of one blend/clip state batch together. Floats per vertex: position 2,
// uv 2, color 4, paint (atlas layer, white flash, mode, nearest) 4, radial parameters 4, ramp rectangle 4.
// Mode 4 is a posed sprite corner: position is the part-local corner, radial holds the entity matrix a,b,c,d and
// the ramp rectangle holds its e,f plus the pose row and part, so the vertex shader evaluates the keyframes.
const VERTEX_FLOATS = 20;
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
];
const FRAGMENT_VARYINGS =
    'varying highp vec2 v_uv; varying vec4 v_color; varying highp vec4 v_paint; varying highp vec4 v_radial; varying highp vec4 v_rect;';
const POSED_CORNER = `if(a_paint.z>3.5&&a_paint.z<4.5){vec4 row0;vec4 row1;vec4 pose;
poseEval(int(a_rect.w+0.5),int(a_rect.z+0.5),row0,row1,pose);
vec2 q=vec2(dot(row0.xy,a_position)+row0.z,dot(row1.xy,a_position)+row1.z);
position=vec2(a_radial.x*q.x+a_radial.z*q.y+a_rect.x,a_radial.y*q.x+a_radial.w*q.y+a_rect.y);
color.a*=pose.z;paint.z=0.0;radial=vec4(0.0);rect=vec4(0.0);}`;
function vertexShader(posed) {
    return `attribute vec2 a_position; attribute vec2 a_uv; attribute vec4 a_color; attribute vec4 a_paint; attribute vec4 a_radial; attribute vec4 a_rect;
uniform mat3 u_projection; ${FRAGMENT_VARYINGS}${posed ? ' varying highp vec2 v_position;' : ''}
${posed ? POSE_PROGRAM_FUNCTIONS : ''}
void main(){vec2 position=a_position;vec4 color=a_color;vec4 paint=a_paint;vec4 radial=a_radial;vec4 rect=a_rect;
${posed ? POSED_CORNER : ''}
vec3 p=u_projection*vec3(position,1.0);gl_Position=vec4(p.xy,0.0,1.0);${posed ? 'v_position=position;' : ''}v_uv=a_uv;v_color=color;v_paint=paint;v_radial=radial;v_rect=rect;}`;
}
const VERTEX = vertexShader(false);
const CLIP_VERTEX = `attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;void main(){vec3 p=u_projection*u_transform*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);}`;
const CLIP_FRAGMENT = 'precision mediump float;void main(){gl_FragColor=vec4(1.0);}';
// paint.y: 0 normal, 1 white flash, 2 forced color (the texel only contributes its coverage).
const FINISH =
    'float a=texel.a*v_color.a;vec3 rgb=v_paint.y>1.5?v_color.rgb*a:mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),v_paint.y);gl_FragColor=vec4(rgb,a);';
const PRIMITIVE_OUTSIDE = `bool primitiveOutside(vec2 l,vec4 p,vec4 m){
  float kind=p.x,stroke=p.y,width=p.z,option=p.w;
  if(kind<0.5){
    if(stroke<0.5)return length(l)>1.0;
    float ql=length(l);vec2 n=ql>0.000001?l/ql:vec2(1.0,0.0);float det=m.x*m.w-m.y*m.z;
    vec2 g=vec2(m.w*n.x-m.z*n.y,-m.y*n.x+m.x*n.y)/max(abs(det),0.000001);
    return abs((ql-1.0)/max(length(g),0.000001))>width*0.5;
  }
  if(kind<1.5){
    if(stroke<0.5)return max(abs(l.x),abs(l.y))>1.0;
    float sx=length(vec2(m.x,m.z));float sy=length(vec2(m.y,m.w));
    if(option>0.5){
      float ox=1.0+width/(2.0*max(sx,0.000001));float oy=1.0+width/(2.0*max(sy,0.000001));
      float ix=max(0.0,1.0-width/(2.0*max(sx,0.000001)));float iy=max(0.0,1.0-width/(2.0*max(sy,0.000001)));
      return max(abs(l.x)/ox,abs(l.y)/oy)>1.0||max(abs(l.x)/max(ix,0.000001),abs(l.y)/max(iy,0.000001))<1.0;
    }
    vec2 q=(abs(l)-vec2(1.0))*vec2(sx,sy);float sd=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0);
    return abs(sd)>width*0.5;
  }
  float halfLength=length(vec2(m.x,m.z));float halfWidth=length(vec2(m.y,m.w));
  float x=l.x*halfLength;float y=l.y*halfWidth;float center=halfLength-(option>0.5?halfWidth:0.0);float d;
  if(option<0.5)d=max(abs(x)-center,abs(y)-halfWidth);
  else if(option<1.5)d=max(abs(x)-center-halfWidth,abs(y)-halfWidth);
  else d=length(vec2(max(abs(x)-center,0.0),y))-halfWidth;
  return d>0.0;
}`;
// Posed sprites move on the GPU, so their clip is tested per fragment against the batch's edge planes; every
// other vertex was clipped on the CPU and passes this test trivially.
function fragmentShader(planes) {
    const PLANES = planes
        ? `varying highp vec2 v_position; uniform vec3 u_planes[${planes}]; uniform int u_planeCount;`
        : '';
    const CLIP = planes
        ? `for(int i=0;i<${planes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}`
        : '';
    return `precision mediump float; precision mediump sampler2DArray; uniform sampler2DArray u_texture;
${FRAGMENT_VARYINGS}${PLANES}
float radialParameter(vec2 q){
  vec2 d=v_radial.xy;float r0=v_radial.z,dr=v_radial.w;
  float a=dot(d,d)-dr*dr,b=-2.0*(dot(q,d)+r0*dr),c=dot(q,q)-r0*r0;
  if(abs(a)<0.000001){if(abs(b)<0.000001)return -10000.0;float t=-c/b;return r0+dr*t>0.0?t:-10000.0;}
  float discriminant=b*b-4.0*a*c;if(discriminant<0.0)return -10000.0;
  float root=sqrt(max(discriminant,0.0)),t0=(-b-root)/(2.0*a),t1=(-b+root)/(2.0*a),chosen=-10000.0;
  if(r0+dr*t0>0.0)chosen=t0;if(r0+dr*t1>0.0)chosen=max(chosen,t1);return chosen;
}
${PRIMITIVE_OUTSIDE}
void main(){${CLIP}if(v_paint.z>4.5){if(primitiveOutside(v_uv,v_radial,v_rect))discard;gl_FragColor=vec4(v_color.rgb*v_color.a,v_color.a);return;}
if(v_paint.z>1.5&&v_paint.z<2.5)discard;vec2 uv=v_uv;
if(v_paint.z>2.5){uv=v_rect.xy+vec2(clamp(v_uv.x,0.0,1.0),0.5)*v_rect.zw;}
else if(v_paint.z>0.5){float t=radialParameter(v_uv);if(t< -1000.0)discard;uv=v_rect.xy+vec2(clamp(t,0.0,1.0),0.5)*v_rect.zw;}
if(v_paint.w>0.5){vec2 size=vec2(textureSize(u_texture,0).xy);uv=(floor(uv*size)+0.5)/size;}
vec4 texel=texture2D(u_texture,vec3(uv,floor(v_paint.x+0.5)));${FINISH}}`;
}
const FRAGMENT = fragmentShader(0);
// Offscreen groups are the one render-target (not atlas) sample, so they keep a plain 2D sampler.
const GROUP_FRAGMENT = `precision mediump float; uniform sampler2D u_texture;
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
function tessellate(contours, rule) {
    const EDGES = [],
        YS = [];
    for (const CONTOUR of contours) {
        if (CONTOUR.length < 3) {
            continue;
        }
        for (let i = 0; i < CONTOUR.length; i++) {
            const A = CONTOUR[i],
                B = CONTOUR[(i + 1) % CONTOUR.length];
            if (Math.abs(A.y - B.y) < 1e-9) {
                continue;
            }
            const MIN_Y = Math.min(A.y, B.y),
                MAX_Y = Math.max(A.y, B.y);
            EDGES.push({
                a: A,
                b: B,
                sign: B.y > A.y ? 1 : -1,
                minY: MIN_Y,
                maxY: MAX_Y,
            });
            YS.push(A.y, B.y);
        }
    }
    YS.sort((a, b) => a - b);
    const LEVELS = [];
    for (const Y of YS) {
        if (!LEVELS.length || Y - LEVELS.at(-1) > 1e-8) {
            LEVELS.push(Y);
        }
    }
    const STARTS = EDGES.slice().sort((a, b) => a.minY - b.minY),
        ACTIVE = [],
        TRIANGLES = [];
    let nextStart = 0;
    for (let band = 0; band + 1 < LEVELS.length; band++) {
        const Y0 = LEVELS[band],
            Y1 = LEVELS[band + 1],
            YM = (Y0 + Y1) / 2;
        if (Y1 - Y0 < 1e-8) {
            continue;
        }
        while (nextStart < STARTS.length && STARTS[nextStart].minY < YM) {
            ACTIVE.push(STARTS[nextStart++]);
        }
        for (let i = ACTIVE.length - 1; i >= 0; i--) {
            if (ACTIVE[i].maxY <= YM) {
                ACTIVE[i] = ACTIVE[ACTIVE.length - 1];
                ACTIVE.pop();
            }
        }
        ACTIVE.sort((a, b) => xAt(a, YM) - xAt(b, YM));
        let winding = 0;
        let inside = false;
        let left = null;
        for (const EDGE of ACTIVE) {
            const BEFORE = rule === 'evenodd' ? inside : winding !== 0;
            if (rule === 'evenodd') {
                inside = !inside;
            } else {
                winding += EDGE.sign;
            }
            const AFTER = rule === 'evenodd' ? inside : winding !== 0;
            if (!BEFORE && AFTER) {
                left = EDGE;
            } else if (BEFORE && !AFTER && left) {
                const A = {
                        x: xAt(left, Y0),
                        y: Y0,
                    },
                    B = {
                        x: xAt(EDGE, Y0),
                        y: Y0,
                    },
                    C = {
                        x: xAt(EDGE, Y1),
                        y: Y1,
                    },
                    D = {
                        x: xAt(left, Y1),
                        y: Y1,
                    };
                TRIANGLES.push(A, B, C, A, C, D);
                left = null;
            }
        }
    }
    return TRIANGLES;
}
function xAt(edge, y) {
    const { a: A, b: B } = edge;
    return A.x + ((B.x - A.x) * (y - A.y)) / (B.y - A.y);
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
    const TRIANGLES = tessellate([CONTOUR], rule);
    if (!TRIANGLES.length) {
        throw new RangeError('Clip contour could not be tessellated');
    }
    if (TRIANGLES.length / 3 > 16384) {
        throw new RangeError('Retained clip tessellation exceeds 16384 triangles');
    }
    return {
        flat: FLAT,
        triangles: Float32Array.from(TRIANGLES.flatMap((p) => [p.x, p.y])),
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
        this.whiteRegion = this.atlas.allocate(1, 1);
        this.atlas.upload(
            this.whiteRegion,
            { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
            { premultiplied: true, extendEdges: true },
        );
        this.vertices = new Float32Array(initialVertices * VERTEX_FLOATS);
        this.count = 0;
        this.matrix = IDENTITY.slice();
        this.stack = [];
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
        this._setPaint(this.whiteRegion);
        this.blend = 'source-over';
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
        const G = [...this.groups].reverse().find((group) => !group.direct);
        if (G) {
            this._setProjection(G.bounds, G.target);
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
        this.path.at(-1).push(P);
        this.cursor = P;
    }
    quadraticCurveTo(cx, cy, x, y, segments = 12) {
        this._curve([cx, cy, x, y], segments, false);
    }
    bezierCurveTo(a, b, c, d, x, y, segments = 16) {
        this._curve([a, b, c, d, x, y], segments, true);
    }
    _curve(v, n, cubic) {
        this._frame();
        if (!Number.isSafeInteger(n) || n < 2 || n > 256) {
            throw new RangeError('curve segments must be 2..256');
        }
        if (!this.cursor) {
            return this.moveTo(v[0], v[1]);
        }
        const START = this.cursor,
            P = cubic
                ? [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3]), point(this.matrix, v[4], v[5])]
                : [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3])];
        for (let i = 1; i <= n; i++) {
            const T = i / n,
                Q = 1 - T;
            let x;
            let y;
            if (cubic) {
                x = Q * Q * Q * START.x + 3 * Q * Q * T * P[0].x + 3 * Q * T * T * P[1].x + T * T * T * P[2].x;
                y = Q * Q * Q * START.y + 3 * Q * Q * T * P[0].y + 3 * Q * T * T * P[1].y + T * T * T * P[2].y;
            } else {
                x = Q * Q * START.x + 2 * Q * T * P[0].x + T * T * P[1].x;
                y = Q * Q * START.y + 2 * Q * T * P[0].y + T * T * P[1].y;
            }
            this.path.at(-1).push({
                x,
                y,
            });
        }
        this.cursor = this.path.at(-1).at(-1);
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
        this.stack.push({
            matrix: this.matrix.slice(),
            clips: this.clips.map((polygon) =>
                polygon.map((p) => ({
                    ...p,
                })),
            ),
            stencilClips: this.stencilClips.slice(),
        });
    }
    restore() {
        this._frame();
        const S = this.stack.pop();
        if (!S) {
            throw new Error('restore without save');
        }
        // Queued vertices already hold final positions, so only a stencil change needs the batch submitted first.
        this.matrix = S.matrix;
        this.clips = S.clips;
        if (
            S.stencilClips.length !== this.stencilClips.length ||
            S.stencilClips.some((clip, i) => clip !== this.stencilClips[i])
        ) {
            this._submit();
            this.stencilClips = S.stencilClips;
            this._rebuildStencil();
        }
    }
    setTransform(a, b, c, d, e, f) {
        this._frame();
        [a, b, c, d, e, f].forEach((n, i) => FINITE(n, `transform[${i}]`));
        this.matrix = [a, b, c, d, e, f];
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
            }
        }
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
    }
    _submit() {
        if (!this.count) {
            return;
        }
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
        this.device.draw({
            pipeline: POSED ? this.posePipeline : this.activeTarget ? this.groupPipeline : this.pipeline,
            buffer: this.buffer,
            count: this.count,
            uniforms: POSED
                ? {
                      u_projection: this.projection,
                      u_program: 0,
                      u_state: 1,
                      u_overrides: 2,
                      u_texture: 3,
                      u_programWidth: POSED.programWidth,
                      'u_planes[0]': this.planeScratch,
                      u_planeCount: POSED.planeCount,
                  }
                : {
                      u_projection: this.projection,
                      u_texture: 0,
                  },
            textures: POSED ? [...POSED.textures, this.atlas.texture] : [this.activeTarget ?? this.atlas.texture],
            blend: this.blend,
            stencil: this.stencilDepth
                ? {
                      func: 'equal',
                      ref: this.stencilDepth,
                      mask: 255,
                      writeMask: 0,
                      pass: 'keep',
                  }
                : false,
        });
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
    _setPaint(region, { radial = false, whiteFlash = false, gradient = null } = {}) {
        if (this.activeTarget) {
            this._submit();
            this.activeTarget = null;
        }
        const [U, V, W, H] = region.uvRect,
            MODE = radial ? (gradient?.radialEmpty ? 2 : 1) : gradient ? 3 : 0,
            PARAMS = radial ? (gradient?.radialParams ?? [0, 0, 0, 0]) : [0, 0, 0, 0];
        this.activeRadial = radial;
        this.activeWhiteFlash = whiteFlash;
        this.activeGradient = gradient;
        this.activeRegion = region;
        this.flatUV = [U + W / 2, V + H / 2];
        this.paintTemplate.set([
            region.layer,
            whiteFlash ? 1 : 0,
            MODE,
            region.filter === 'nearest' ? 1 : 0,
            ...PARAMS,
            U,
            V,
            W,
            H,
        ]);
    }
    /** Switches later vertices to plain per-vertex paint (no atlas region, gradient or group target). */
    _useVertexPaint(template, whiteFlash = false) {
        if (this.activeTarget) {
            this._submit();
            this.activeTarget = null;
        }
        this.activeRegion = null;
        this.activeRadial = false;
        this.activeWhiteFlash = whiteFlash;
        this.activeGradient = null;
        this.paintTemplate.set(template);
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
        for (const VALUE of [...matrix, ...params]) {
            FINITE(VALUE, 'drawPrimitive value');
        }
        const M = matrix;
        this._useVertexPaint([0, 0, MODE_PRIMITIVE, 0, ...params, M[0], M[2], M[1], M[3]]);
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
    } = {}) {
        this._frame();
        const COUNT = uvRects?.length / 4;
        if (
            !Number.isSafeInteger(layer) ||
            layer < 0 ||
            !Number.isInteger(COUNT) ||
            COUNT < 1 ||
            localRects?.length !== COUNT * 4 ||
            matrix.length !== 6 ||
            (filter !== 'linear' && filter !== 'nearest')
        ) {
            throw new TypeError('drawQuads requires a layer and matching uvRects and localRects');
        }
        for (const LIST of [uvRects, localRects, matrix]) {
            for (let i = 0; i < LIST.length; i++) {
                FINITE(LIST[i], 'drawQuads value');
            }
        }
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
            throw new RangeError('alpha must be in [0,1]');
        }
        rgba(color);
        const TINT = [color[0], color[1], color[2], color[3] * alpha],
            M = compose(this.matrix, matrix);
        this._useVertexPaint(
            [layer, whiteFlash ? 1 : forceColor ? 2 : 0, 0, filter === 'nearest' ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 1],
            whiteFlash,
        );
        if (pose === null) {
            if (parts !== null) {
                throw new TypeError('parts require a pose');
            }
            this.device.stats.spriteRuns += COUNT;
            for (let i = 0; i < COUNT; i++) {
                const [LX, LY, LW, LH] = localRects.subarray(i * 4, i * 4 + 4),
                    [U, V, UW, VH] = uvRects.subarray(i * 4, i * 4 + 4),
                    CORNERS = [
                        [point(M, LX, LY), [U, V]],
                        [point(M, LX + LW, LY), [U + UW, V]],
                        [point(M, LX + LW, LY + LH), [U + UW, V + VH]],
                        [point(M, LX, LY + LH), [U, V + VH]],
                    ];
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
        const DRAW = OWNER.resolve(pose);
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
            const [LX, LY, LW, LH] = localRects.subarray(i * 4, i * 4 + 4),
                [U, V, UW, VH] = uvRects.subarray(i * 4, i * 4 + 4);
            this._reserve(6);
            for (const [CX, CY] of POSED_CORNERS) {
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
            }
        }
    }
    /** Joins or opens the batch's posed section: one pose texture set and one clip plane set per draw. */
    _beginPosed(owner, draw) {
        const PLANES = clipPlanes(this.clips, this.maxClipPlanes),
            BATCH = this.poseBatch;
        if (
            BATCH &&
            (BATCH.owner !== owner ||
                BATCH.textures.some((texture, i) => texture !== draw.textures[i]) ||
                (BATCH.planeKey !== PLANES.key && BATCH.planeCount + PLANES.count > 0))
        ) {
            this._submit();
        } else if (!BATCH && this.count && PLANES.count > 0 && this.batchSerial !== this.clipSerial) {
            // CPU-clipped vertices of an earlier clip would be cut by this clip's planes.
            this._submit();
        }
        if (!this.poseBatch) {
            this.poseBatch = {
                owner,
                textures: draw.textures,
                programWidth: draw.programWidth,
                planeKey: PLANES.key,
                planeCount: PLANES.count,
                planes: PLANES.values,
                serial: this.clipSerial,
            };
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
        this.flatUV = [0, 0];
        this.paintTemplate.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    }
    fill(colorValue = [0, 0, 0, 1], rule = 'nonzero') {
        this._frame();
        if (rule !== 'nonzero' && rule !== 'evenodd') {
            throw new TypeError('rule must be nonzero or evenodd');
        }
        this._setPaint(this.whiteRegion);
        this.device.stats.pathTessellations++;
        const COL = rgba(colorValue),
            VERTICES = tessellate(this.path, rule);
        for (let i = 0; i + 2 < VERTICES.length; i += 3) {
            this._emit(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], COL);
        }
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
        const VERTICES = tessellate(this.path, gradient.rule ?? 'nonzero');
        for (let i = 0; i + 2 < VERTICES.length; i += 3) {
            this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], gradient.color);
        }
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
        const VERTICES = tessellate(this.path, gradient.rule ?? 'nonzero');
        for (let i = 0; i + 2 < VERTICES.length; i += 3) {
            this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], gradient.color);
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
        colorValue = [0, 0, 0, 1],
        width = 1,
        { lineCap = 'butt', lineJoin = 'miter', miterLimit = 10 } = {},
        gradient = null,
    ) {
        this._frame();
        this._setPaint(gradient?.region ?? this.whiteRegion, {
            radial: gradient?.kind === 'radial',
            whiteFlash: gradient?.whiteFlash ?? false,
            gradient,
        });
        this.device.stats.pathStrokeBuilds++;
        rgba(colorValue);
        if (!Number.isFinite(width) || width <= 0) {
            throw new RangeError('line width must be positive');
        }
        if (
            !['butt', 'round', 'square'].includes(lineCap) ||
            !['miter', 'round', 'bevel'].includes(lineJoin) ||
            !Number.isFinite(miterLimit) ||
            miterLimit <= 0
        ) {
            throw new TypeError('invalid stroke style');
        }
        const HALF = width / 2,
            ARC_STEP =
                HALF > ARC_TOLERANCE ? Math.min(Math.PI / 2, 2 * Math.acos(1 - ARC_TOLERANCE / HALF)) : Math.PI / 2,
            FAN = (center, points) => {
                for (let i = 1; i < points.length; i++) {
                    this._emit(center, points[i - 1], points[i], colorValue);
                }
            };
        for (const SOURCE of this.path) {
            const CONTOUR = SOURCE.filter((p, i) => !i || p.x !== SOURCE[i - 1].x || p.y !== SOURCE[i - 1].y);
            if (CONTOUR.length < 2) {
                continue;
            }
            const CLOSED = CONTOUR.length > 2 && CONTOUR[0].x === CONTOUR.at(-1).x && CONTOUR[0].y === CONTOUR.at(-1).y;
            if (CLOSED) {
                CONTOUR.pop();
            }
            const COUNT = CLOSED ? CONTOUR.length : CONTOUR.length - 1,
                DIRS = [],
                NORMALS = [];
            for (let i = 0; i < COUNT; i++) {
                const A = CONTOUR[i],
                    B = CONTOUR[(i + 1) % CONTOUR.length],
                    DX = B.x - A.x,
                    DY = B.y - A.y,
                    L = Math.hypot(DX, DY);
                if (!L) {
                    DIRS.push({
                        x: 0,
                        y: 0,
                    });
                    NORMALS.push({
                        x: 0,
                        y: 0,
                    });
                    continue;
                }
                DIRS.push({
                    x: DX / L,
                    y: DY / L,
                });
                NORMALS.push({
                    x: (-DY / L) * HALF,
                    y: (DX / L) * HALF,
                });
            }
            for (let i = 0; i < COUNT; i++) {
                const A = CONTOUR[i],
                    B = CONTOUR[(i + 1) % CONTOUR.length],
                    D = DIRS[i],
                    N = NORMALS[i];
                if (!D.x && !D.y) {
                    continue;
                }
                const EXTEND = !CLOSED && lineCap === 'square' && (i === 0 || i === COUNT - 1) ? HALF : 0,
                    AX = A.x - D.x * EXTEND,
                    AY = A.y - D.y * EXTEND,
                    BX = B.x + D.x * EXTEND,
                    BY = B.y + D.y * EXTEND,
                    P = {
                        x: AX + N.x,
                        y: AY + N.y,
                    },
                    Q = {
                        x: BX + N.x,
                        y: BY + N.y,
                    },
                    R = {
                        x: BX - N.x,
                        y: BY - N.y,
                    },
                    S = {
                        x: AX - N.x,
                        y: AY - N.y,
                    };
                this._emit(P, Q, R, colorValue);
                this._emit(P, R, S, colorValue);
            }
            const JOIN_START = CLOSED ? 0 : 1,
                JOIN_END = CLOSED ? CONTOUR.length : CONTOUR.length - 1;
            for (let i = JOIN_START; i < JOIN_END; i++) {
                const PREV = (i - 1 + COUNT) % COUNT,
                    NEXT = i % COUNT,
                    V = CONTOUR[i % CONTOUR.length],
                    D0 = DIRS[PREV],
                    D1 = DIRS[NEXT],
                    N0 = NORMALS[PREV],
                    N1 = NORMALS[NEXT],
                    CROSS = D0.x * D1.y - D0.y * D1.x;
                if (Math.abs(CROSS) < 1e-8) {
                    continue;
                }
                const SIGN = CROSS > 0 ? -1 : 1,
                    A = {
                        x: V.x + N0.x * SIGN,
                        y: V.y + N0.y * SIGN,
                    },
                    B = {
                        x: V.x + N1.x * SIGN,
                        y: V.y + N1.y * SIGN,
                    };
                if (lineJoin === 'round') {
                    const START = Math.atan2(A.y - V.y, A.x - V.x);
                    // The join is the short arc between the two outer offset points.
                    let sweep = Math.atan2(B.y - V.y, B.x - V.x) - START;
                    while (sweep > Math.PI) {
                        sweep -= Math.PI * 2;
                    }
                    while (sweep < -Math.PI) {
                        sweep += Math.PI * 2;
                    }
                    const STEPS = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP)),
                        ARC = [A];
                    for (let j = 1; j <= STEPS; j++) {
                        const T = START + (sweep * j) / STEPS;
                        ARC.push({
                            x: V.x + Math.cos(T) * HALF,
                            y: V.y + Math.sin(T) * HALF,
                        });
                    }
                    FAN(V, ARC);
                } else if (lineJoin === 'miter') {
                    const MX = N0.x * SIGN + N1.x * SIGN,
                        MY = N0.y * SIGN + N1.y * SIGN,
                        ML = Math.hypot(MX, MY),
                        DENOM = ML ? (MX / ML) * (N1.x * SIGN) + (MY / ML) * (N1.y * SIGN) : 0,
                        MITER = DENOM ? HALF / DENOM : Infinity;
                    if (Number.isFinite(MITER) && Math.abs(MITER) <= HALF * miterLimit) {
                        const TIP = {
                            x: V.x + (MX / ML) * MITER,
                            y: V.y + (MY / ML) * MITER,
                        };
                        this._emit(A, TIP, B, colorValue);
                    } else {
                        this._emit(V, A, B, colorValue);
                    }
                } else {
                    this._emit(V, A, B, colorValue);
                }
            }
            if (!CLOSED && lineCap === 'round') {
                for (const [INDEX, ANGLE] of [
                    [0, Math.atan2(DIRS[0].y, DIRS[0].x) + Math.PI],
                    [COUNT - 1, Math.atan2(DIRS[COUNT - 1].y, DIRS[COUNT - 1].x)],
                ]) {
                    const V = CONTOUR[INDEX === 0 ? 0 : CONTOUR.length - 1],
                        START = ANGLE - Math.PI / 2,
                        ARC = [];
                    const CAP_STEPS = Math.max(2, Math.ceil(Math.PI / ARC_STEP));
                    for (let j = 0; j <= CAP_STEPS; j++) {
                        const T = START + (Math.PI * j) / CAP_STEPS;
                        ARC.push({
                            x: V.x + Math.cos(T) * HALF,
                            y: V.y + Math.sin(T) * HALF,
                        });
                    }
                    FAN(V, ARC);
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

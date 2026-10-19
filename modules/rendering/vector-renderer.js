const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const VERTEX = `attribute vec2 a_position; attribute vec2 a_uv; attribute vec4 a_color;
uniform mat3 u_projection; varying vec2 v_uv; varying vec4 v_color;
void main(){vec3 p=u_projection*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);v_uv=a_uv;v_color=a_color;}`;
const CLIP_VERTEX = `attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;void main(){vec3 p=u_projection*u_transform*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);}`;
const CLIP_FRAGMENT = 'precision mediump float;void main(){gl_FragColor=vec4(1.0);}';
const FRAGMENT = `precision mediump float; uniform sampler2D u_texture; uniform float u_textured; uniform float u_radial; uniform vec4 u_radial_params; uniform float u_whiteFlash;
varying vec2 v_uv; varying vec4 v_color;
float radialParameter(vec2 q){
  vec2 d=u_radial_params.xy;float r0=u_radial_params.z,dr=u_radial_params.w;
  float a=dot(d,d)-dr*dr,b=-2.0*(dot(q,d)+r0*dr),c=dot(q,q)-r0*r0;
  if(abs(a)<0.000001){if(abs(b)<0.000001)return -10000.0;float t=-c/b;return r0+dr*t>0.0?t:-10000.0;}
  float discriminant=b*b-4.0*a*c;if(discriminant<0.0)return -10000.0;
  float root=sqrt(max(discriminant,0.0)),t0=(-b-root)/(2.0*a),t1=(-b+root)/(2.0*a),chosen=-10000.0;
  if(r0+dr*t0>0.0)chosen=t0;if(r0+dr*t1>0.0)chosen=max(chosen,t1);return chosen;
}
void main(){if(u_radial>1.5)discard;float t=u_radial>0.5?radialParameter(v_uv):0.0;if(u_radial>0.5&&t< -1000.0)discard;vec2 uv=u_radial>0.5?vec2(clamp(t,0.0,1.0),0.5):v_uv;vec4 texel=mix(vec4(1.0),texture2D(u_texture,uv),u_textured);float a=texel.a*v_color.a;vec3 rgb=mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),u_whiteFlash);gl_FragColor=vec4(rgb,a);}`;
const NON_RADIAL_FRAGMENT = `precision mediump float; uniform sampler2D u_texture; uniform float u_textured; uniform float u_whiteFlash;
varying vec2 v_uv; varying vec4 v_color;
void main(){vec4 texel=mix(vec4(1.0),texture2D(u_texture,v_uv),u_textured);float a=texel.a*v_color.a;vec3 rgb=mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),u_whiteFlash);gl_FragColor=vec4(rgb,a);}`;
const FINITE = (n, label) => {
    if (!Number.isFinite(n)) {
        throw new TypeError(`${label} must be finite`);
    }
};
function rgba(value) {
    if (!value || value.length !== 4 || Array.from(value).some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new TypeError('RGBA channels must be in [0,1]');
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
        if (initialVertices * 32 > device.maxBufferBytes) {
            throw new RangeError('initial vector buffer exceeds the device byte limit');
        }
        this.device = device;
        this.gl = device.gl;
        this.canvas = device.canvas;
        this.glyphAtlas = glyphAtlas;
        this.maxVertices = Math.min(maxVertices, Math.floor(device.maxBufferBytes / 32));
        this.maxClipPlanes = Math.max(
            1,
            Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2),
        );
        this.pipeline = device.createPipeline({
            vertex: VERTEX,
            fragment: FRAGMENT,
            stride: 32,
            attributes: [
                {
                    name: 'a_position',
                    size: 2,
                    offset: 0,
                },
                {
                    name: 'a_uv',
                    size: 2,
                    offset: 8,
                },
                {
                    name: 'a_color',
                    size: 4,
                    offset: 16,
                },
            ],
            uniforms: {
                u_projection: 'matrix3fv',
                u_texture: '1i',
                u_textured: '1f',
                u_radial: '1f',
                u_radial_params: '4f',
                u_whiteFlash: '1f',
            },
        });
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
            capacityBytes: initialVertices * 32,
        });
        this.dynamicClipBuffer = device.createVertexBuffer({
            capacityBytes: 0,
        });
        this.white = device.createTexture(
            {
                width: 1,
                height: 1,
                data: new Uint8Array([255, 255, 255, 255]),
            },
            {
                format: 'rgba',
                premultiplied: true,
                filter: 'nearest',
            },
        );
        this.vertices = new Float32Array(initialVertices * 8);
        this.count = 0;
        this.matrix = IDENTITY.slice();
        this.stack = [];
        this.path = [];
        this.cursor = null;
        this.subpath = null;
        this.clips = [];
        this.groups = [];
        this.groupTargets = [];
        this.activeTexture = this.white;
        this.activeRadial = false;
        this.activeWhiteFlash = false;
        this.activeGradient = null;
        this.stencilClips = [];
        this.clipPaths = new Map();
        this.clipPathBytes = 0;
        this.stencilDepth = 0;
        this.stencilNeedsRebuild = false;
        this.state = 'ready';
        this.onLost = () => {
            this.count = 0;
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
        this.nonRadialPipeline = null;
        try {
            this.nonRadialPipeline = device.createPipeline({
                vertex: VERTEX,
                fragment: NON_RADIAL_FRAGMENT,
                stride: 32,
                attributes: [
                    {
                        name: 'a_position',
                        size: 2,
                        offset: 0,
                    },
                    {
                        name: 'a_uv',
                        size: 2,
                        offset: 8,
                    },
                    {
                        name: 'a_color',
                        size: 4,
                        offset: 16,
                    },
                ],
                uniforms: {
                    u_projection: 'matrix3fv',
                    u_texture: '1i',
                    u_textured: '1f',
                    u_whiteFlash: '1f',
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
        this._submit();
        this.matrix = S.matrix;
        this.clips = S.clips;
        if (
            S.stencilClips.length !== this.stencilClips.length ||
            S.stencilClips.some((clip, i) => clip !== this.stencilClips[i])
        ) {
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
            this.clips.push(CONTOUR);
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
            this.clips.push(contour);
            return;
        }
        const PLANE_COUNT = this.clips.reduce((sum, polygon) => sum + polygon.length, 0);
        if (PLANE_COUNT + contour.length > this.maxClipPlanes) {
            this._pushDynamicStencilClip(contour);
            return;
        }
        this.clips.push(contour);
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
    _emitTriangle(a, b, c, color, uv = null) {
        rgba(color);
        if (this.activeGradient && !uv) {
            uv = [this._gradientUV(a), this._gradientUV(b), this._gradientUV(c)];
        }
        if (!this.clips.length && !uv) {
            if (this.count + 3 > this.maxVertices) {
                this._submit();
            }
            if (this.count + 3 > this.vertices.length / 8) {
                const SIZE = Math.min(this.maxVertices, Math.max(this.count + 3, this.vertices.length / 4));
                const NEXT = new Float32Array(SIZE * 8);
                NEXT.set(this.vertices);
                this.vertices = NEXT;
            }
            const DATA = this.vertices;
            for (let i = 0; i < 3; i++) {
                const POINT = i === 0 ? a : i === 1 ? b : c,
                    K = this.count++ * 8;
                DATA[K] = POINT.x;
                DATA[K + 1] = POINT.y;
                DATA[K + 2] = DATA[K + 3] = 0;
                DATA.set(color, K + 4);
            }
            return;
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
            if (this.count + 3 > this.maxVertices) {
                this._submit();
            }
            if (this.count + 3 > this.vertices.length / 8) {
                const SIZE = Math.min(this.maxVertices, Math.max(this.count + 3, this.vertices.length / 4));
                const NEXT = new Float32Array(SIZE * 8);
                NEXT.set(this.vertices);
                this.vertices = NEXT;
            }
            for (const POINT of [POLY[0], POLY[i], POLY[i + 1]]) {
                const K = this.count++ * 8;
                this.vertices[K] = POINT.x;
                this.vertices[K + 1] = POINT.y;
                this.vertices[K + 2] = POINT.u ?? 0;
                this.vertices[K + 3] = POINT.v ?? 0;
                this.vertices.set(color, K + 4);
            }
        }
    }
    _submit() {
        if (!this.count) {
            return;
        }
        this.device.stats.vectorSubmissions++;
        const TEXTURE = this.activeTexture ?? this.white,
            GRADIENT = this.activeGradient,
            RADIAL = this.activeRadial;
        this.device.uploadVertices(this.buffer, this.vertices.subarray(0, this.count * 8));
        this.device.draw({
            pipeline: RADIAL ? this.pipeline : this.nonRadialPipeline,
            buffer: this.buffer,
            count: this.count,
            uniforms: {
                u_projection: this.projection,
                u_texture: 0,
                u_textured: TEXTURE === this.white ? 0 : 1,
                u_whiteFlash: this.activeWhiteFlash ? 1 : 0,
                ...(RADIAL
                    ? {
                          u_radial: GRADIENT?.radialEmpty ? 2 : 1,
                          u_radial_params: GRADIENT?.radialParams ?? [0, 0, 0, 0],
                      }
                    : {}),
            },
            textures: [TEXTURE],
            blend: 'source-over',
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
    _useTexture(texture, { radial = false, whiteFlash = false, gradient = null } = {}) {
        if (
            this.activeTexture !== texture ||
            this.activeRadial !== radial ||
            this.activeWhiteFlash !== whiteFlash ||
            this.activeGradient?.gradient !== gradient?.gradient
        ) {
            this._submit();
        }
        this.activeTexture = texture;
        this.activeRadial = radial;
        this.activeWhiteFlash = whiteFlash;
        this.activeGradient = gradient;
    }
    fill(colorValue = [0, 0, 0, 1], rule = 'nonzero') {
        this._frame();
        if (rule !== 'nonzero' && rule !== 'evenodd') {
            throw new TypeError('rule must be nonzero or evenodd');
        }
        this._useTexture(this.white);
        this.device.stats.pathTessellations++;
        const COL = rgba(colorValue),
            VERTICES = tessellate(this.path, rule);
        for (let i = 0; i + 2 < VERTICES.length; i += 3) {
            this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], COL);
        }
    }
    fillRadialGradient(gradient) {
        this._frame();
        if (
            !gradient?.texture ||
            !gradient.matrixInverse ||
            !Number.isFinite(gradient.radialScale) ||
            gradient.radialScale <= 0 ||
            !Array.isArray(gradient.radialParams) ||
            gradient.radialParams.length !== 4 ||
            gradient.radialParams.some((value) => !Number.isFinite(value))
        ) {
            throw new TypeError('valid two-circle radial gradient texture and transform are required');
        }
        this._useTexture(gradient.texture, {
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
            !gradient?.texture ||
            !gradient.matrixInverse ||
            ![gradient.x0, gradient.y0, gradient.x1, gradient.y1].every(Number.isFinite)
        ) {
            throw new TypeError('valid linear gradient texture and transform are required');
        }
        this._useTexture(gradient.texture, {
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
        this._useTexture(gradient?.texture ?? this.white, {
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
            FAN = (center, points) => {
                for (let i = 1; i < points.length; i++) {
                    this._emitTriangle(center, points[i - 1], points[i], colorValue);
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
                this._emitTriangle(P, Q, R, colorValue);
                this._emitTriangle(P, R, S, colorValue);
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
                    const END = Math.atan2(B.y - V.y, B.x - V.x);
                    let sweep = END - START;
                    if (CROSS > 0) {
                        while (sweep > 0) {
                            sweep -= Math.PI * 2;
                        }
                    } else {
                        while (sweep < 0) {
                            sweep += Math.PI * 2;
                        }
                    }
                    const STEPS = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 8))),
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
                        this._emitTriangle(A, TIP, B, colorValue);
                    } else {
                        this._emitTriangle(V, A, B, colorValue);
                    }
                } else {
                    this._emitTriangle(V, A, B, colorValue);
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
                    for (let j = 0; j <= 8; j++) {
                        const T = START + (Math.PI * j) / 8;
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
        this._useTexture(this.white);
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
    drawGlyphQuad(texture, x, y, width, height, uv, colorValue) {
        this._frame();
        this._useTexture(texture);
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
        this._useTexture(GROUP.target);
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
        this._useTexture(this.white);
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
        this.device.deletePipeline(this.nonRadialPipeline);
        this.device.deletePipeline(this.pipeline);
        this.device.deleteTexture(this.white);
        this.buffer =
            this.dynamicClipBuffer =
            this.clipPipeline =
            this.nonRadialPipeline =
            this.pipeline =
            this.white =
                null;
        this.state = 'disposed';
    }
}

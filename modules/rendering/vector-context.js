import { VectorRenderer } from './vector-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';
import { PrimitiveRenderer } from './primitive-renderer.js';
const TAU = Math.PI * 2;
const MAX_LINEAR_GRADIENT_STOPS = 32;
const LINEAR_GRADIENT_SIZE = 1024;
const MAX_GRADIENT_TEXTURES = 64;
const SILHOUETTE_OFFSETS = Object.freeze(
    Array.from(
        {
            length: 8,
        },
        (_, i) => Object.freeze([Math.cos((i * TAU) / 8), Math.sin((i * TAU) / 8)]),
    ),
);
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const WHITE = Object.freeze([1, 1, 1, 1]);
function composeTransform(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}
function transformedPoint(matrix, x, y) {
    return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
function isFullArc(start, end, ccw) {
    let sweep = end - start;
    if (!ccw) {
        if (sweep >= TAU) {
            return true;
        }
        while (sweep < 0) {
            sweep += TAU;
        }
    } else {
        if (sweep <= -TAU) {
            return true;
        }
        while (sweep > 0) {
            sweep -= TAU;
        }
    }
    return Math.abs(sweep) >= TAU;
}
const NAMED = Object.freeze({
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    orange: '#ffa500',
    purple: '#800080',
    pink: '#ffc0cb',
    gray: '#808080',
    grey: '#808080',
    silver: '#c0c0c0',
    maroon: '#800000',
    olive: '#808000',
    lime: '#00ff00',
    aqua: '#00ffff',
    cyan: '#00ffff',
    teal: '#008080',
    navy: '#000080',
    fuchsia: '#ff00ff',
    magenta: '#ff00ff',
    rebeccapurple: '#663399',
    transparent: '#00000000',
});
function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}
function finite(value, name) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be finite`);
    }
}
export function normalizeColor(value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        if (value.length !== 4) {
            throw new TypeError('RGBA paint must have four channels');
        }
        const OUT = Array.from(value);
        if (OUT.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
            throw new RangeError('RGBA channels must be in [0,1]');
        }
        return OUT;
    }
    let text = String(value ?? 'black')
        .trim()
        .toLowerCase();
    text = NAMED[text] ?? text;
    if (text === 'currentcolor' && typeof getComputedStyle === 'function') {
        text = getComputedStyle(document.documentElement).color;
    }
    if (text[0] === '#') {
        let hex = text.slice(1);
        if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) {
            throw new TypeError(`Invalid CSS color: ${value}`);
        }
        if (hex.length < 5) {
            hex = [...hex].map((c) => c + c).join('');
        }
        return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        ];
    }
    const RGB = text.match(/^rgba?\((.*)\)$/);
    if (RGB) {
        const FIELDS = RGB[1]
            .trim()
            .replace(/\s*\/\s*/, ' ')
            .split(/[\s,]+/)
            .filter(Boolean);
        if (FIELDS.length < 3 || FIELDS.length > 4) {
            throw new TypeError(`Invalid CSS color: ${value}`);
        }
        const CHANNEL = (s) => clamp(s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s) / 255);
        const ALPHA =
            FIELDS[3] === undefined
                ? 1
                : clamp(FIELDS[3].endsWith('%') ? parseFloat(FIELDS[3]) / 100 : parseFloat(FIELDS[3]));
        const OUT = [...FIELDS.slice(0, 3).map(CHANNEL), ALPHA];
        if (OUT.some(Number.isNaN)) {
            throw new TypeError(`Invalid CSS color: ${value}`);
        }
        return OUT;
    }
    const HSL = text.match(/^hsla?\((.*)\)$/);
    if (HSL) {
        const FIELDS = HSL[1]
            .trim()
            .replace(/\s*\/\s*/, ' ')
            .split(/[\s,]+/)
            .filter(Boolean);
        if (FIELDS.length < 3 || FIELDS.length > 4) {
            throw new TypeError(`Invalid CSS color: ${value}`);
        }
        const H = (((parseFloat(FIELDS[0]) % 360) + 360) % 360) / 360,
            S = clamp(parseFloat(FIELDS[1]) / 100),
            L = clamp(parseFloat(FIELDS[2]) / 100),
            A =
                FIELDS[3] === undefined
                    ? 1
                    : clamp(FIELDS[3].endsWith('%') ? parseFloat(FIELDS[3]) / 100 : parseFloat(FIELDS[3]));
        const F = (n) => {
            const K = (n + H * 12) % 12;
            return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(K - 3, 9 - K, 1));
        };
        return [F(0), F(8), F(4), A];
    }
    if (typeof document !== 'undefined' && document.createElement && document.body) {
        const PROBE = document.createElement('span');
        PROBE.style.color = '';
        PROBE.style.color = text;
        if (PROBE.style.color) {
            document.body.append(PROBE);
            const RESOLVED = getComputedStyle(PROBE).color;
            PROBE.remove();
            if (RESOLVED !== text) {
                return normalizeColor(RESOLVED);
            }
        }
    }
    throw new TypeError(`Unsupported CSS color: ${value}`);
}
function transformed(matrix, x, y) {
    return {
        x: matrix[0] * x + matrix[2] * y + matrix[4],
        y: matrix[1] * x + matrix[3] * y + matrix[5],
    };
}
function invert(matrix) {
    const D = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (Math.abs(D) < 1e-15) {
        return null;
    }
    return [
        matrix[3] / D,
        -matrix[1] / D,
        -matrix[2] / D,
        matrix[0] / D,
        (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / D,
        (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / D,
    ];
}
class RadialGradient {
    constructor(matrix, x0, y0, r0, x1, y1, r1) {
        for (const [N, V] of Object.entries({
            x0,
            y0,
            r0,
            x1,
            y1,
            r1,
        })) {
            finite(V, N);
        }
        if (r0 < 0 || r1 < 0) {
            throw new RangeError('Gradient radii must be non-negative');
        }
        this.matrix = matrix.slice();
        this.x0 = x0;
        this.y0 = y0;
        this.r0 = r0;
        this.x1 = x1;
        this.y1 = y1;
        this.r1 = r1;
        this.stops = [];
        this.pixels = null;
        this.revision = 0;
    }
    addColorStop(offset, value) {
        if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
            throw new RangeError('Invalid gradient stop');
        }
        this.stops.push({
            offset,
            color: normalizeColor(value),
        });
        this.stops.sort((a, b) => a.offset - b.offset);
        this.pixels = null;
        this.revision++;
    }
    raster() {
        if (this.pixels) {
            return this.pixels;
        }
        const DATA = new Uint8Array(256 * 4),
            STOPS = this.stops.length
                ? this.stops
                : [
                      {
                          offset: 0,
                          color: [0, 0, 0, 0],
                      },
                  ];
        for (let i = 0; i < 256; i++) {
            const T = i / 255;
            let lo = STOPS[0];
            let hi = STOPS.at(-1);
            for (let j = 1; j < STOPS.length; j++) {
                if (T < STOPS[j].offset) {
                    lo = STOPS[j - 1];
                    hi = STOPS[j];
                    break;
                }
            }
            const Q = clamp((T - lo.offset) / (hi.offset - lo.offset || 1)),
                ALPHA = lo.color[3] + (hi.color[3] - lo.color[3]) * Q;
            for (let k = 0; k < 3; k++) {
                DATA[i * 4 + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * Q) * ALPHA * 255);
            }
            DATA[i * 4 + 3] = Math.round(ALPHA * 255);
        }
        this.pixels = DATA;
        return DATA;
    }
}
class LinearGradient {
    constructor(matrix, x0, y0, x1, y1) {
        for (const [NAME, VALUE] of Object.entries({
            x0,
            y0,
            x1,
            y1,
        })) {
            finite(VALUE, NAME);
        }
        this.matrix = matrix.slice();
        this.x0 = x0;
        this.y0 = y0;
        this.x1 = x1;
        this.y1 = y1;
        this.stops = [];
        this.pixels = null;
        this.revision = 0;
    }
    addColorStop(offset, value) {
        if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
            throw new RangeError('Invalid gradient stop');
        }
        if (this.stops.length >= MAX_LINEAR_GRADIENT_STOPS) {
            throw new RangeError(`Linear gradients support at most ${MAX_LINEAR_GRADIENT_STOPS} color stops`);
        }
        const STOP = {
            offset,
            color: normalizeColor(value),
            order: this.stops.length,
        };
        this.stops.push(STOP);
        this.stops.sort((a, b) => a.offset - b.offset || a.order - b.order);
        this.pixels = null;
        this.revision++;
    }
    raster() {
        if (this.pixels) {
            return this.pixels;
        }
        const DATA = new Uint8Array(LINEAR_GRADIENT_SIZE * 4),
            STOPS = this.stops;
        for (let i = 0; i < LINEAR_GRADIENT_SIZE; i++) {
            const T = i / (LINEAR_GRADIENT_SIZE - 1);
            let lo;
            let hi;
            let q;
            if (!STOPS.length) {
                lo = hi = {
                    color: [0, 0, 0, 0],
                };
                q = 0;
            } else if (STOPS.length === 1 || T < STOPS[0].offset) {
                lo = hi = STOPS[0];
                q = 0;
            } else {
                let next = 0;
                while (next < STOPS.length && T >= STOPS[next].offset) {
                    next++;
                }
                if (next === STOPS.length) {
                    lo = hi = STOPS.at(-1);
                    q = 0;
                } else {
                    lo = STOPS[next - 1];
                    hi = STOPS[next];
                    q = (T - lo.offset) / (hi.offset - lo.offset);
                }
            }
            const ALPHA = lo.color[3] + (hi.color[3] - lo.color[3]) * q,
                AT = i * 4;
            for (let k = 0; k < 3; k++) {
                DATA[AT + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * q) * ALPHA * 255);
            }
            DATA[AT + 3] = Math.round(ALPHA * 255);
        }
        this.pixels = DATA;
        return DATA;
    }
}

/** Canvas-style paint/path context over a caller-owned WebGLDevice and shared VectorRenderer. */
export class VectorContext {
    constructor(
        device,
        {
            vectorRenderer = null,
            glyphAtlas = vectorRenderer?.glyphAtlas ?? null,
            initialVertices = 4096,
            maxVertices = 262144,
            onError = null,
            safeAlphaRunBatching = true,
        } = {},
    ) {
        if (!device?.beginFrame || !device?.endFrame || !device?.createVertexBuffer) {
            throw new TypeError('WebGLDevice is required');
        }
        if (vectorRenderer && vectorRenderer.device !== device) {
            throw new TypeError('vectorRenderer must use the supplied WebGLDevice');
        }
        this.device = device;
        this.canvas = device.canvas;
        this.vector =
            vectorRenderer ??
            new VectorRenderer(device, {
                initialVertices,
                maxVertices,
                glyphAtlas,
            });
        this.ownsVector = !vectorRenderer;
        this.glyphAtlas = glyphAtlas ?? this.vector.glyphAtlas;
        this.onError = typeof onError === 'function' ? onError : null;
        if (typeof safeAlphaRunBatching !== 'boolean') {
            throw new TypeError('safeAlphaRunBatching must be a boolean');
        }
        this.safeAlphaRunBatching = safeAlphaRunBatching;
        this.meshRenderer = null;
        this.primitiveRenderer = null;
        this.primitivePath = {
            type: 'empty',
        };
        this.active = false;
        this.state = 'ready';
        this.frame = 0;
        this.pathCount = 0;
        this.staticMeshes = new Set();
        this.deferredMeshes = [];
        this.gradientTextures = new Map();
        this._silhouetteMatrices = new Float32Array(60);
        this._scaledSilhouetteMatrices = new Float32Array(12);
        this._silhouetteColorCache = new Map();
        this.onLost = (event) => {
            event.preventDefault();
            this.active = false;
            this.state = 'lost';
            this.meshRenderer?.discard();
        };
        this.onRestored = () => {
            if (this.state === 'disposed') {
                return;
            }
            try {
                for (const MESH of this.staticMeshes) {
                    this.device.uploadVertices(MESH.buffer, MESH.vertices);
                }
                this.state = 'ready';
            } catch (error) {
                this.state = 'failed';
                this.onError?.(error, {
                    phase: 'restore',
                });
            }
        };
        this.canvas.addEventListener('webglcontextlost', this.onLost);
        this.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this._fillStyle = '#000';
        this._strokeStyle = '#000';
        this._globalAlpha = 1;
        this._lineWidth = 1;
        this._lineCap = 'butt';
        this._lineJoin = 'round';
        this._miterLimit = 10;
        this._lineDash = [];
        this._lineDashOffset = 0;
        this._font = '10px sans-serif';
        this._textAlign = 'start';
        this._textBaseline = 'alphabetic';
        this._direction = 'inherit';
        this._filter = 'none';
        this.forceColor = null;
        this.stack = [];
        this.frameStats = {};
        this.total = {
            frames: 0,
            drawCalls: 0,
            vertices: 0,
            uploadedBytes: 0,
        };
    }
    get globalAlpha() {
        return this._globalAlpha;
    }
    set globalAlpha(v) {
        finite(v, 'globalAlpha');
        this._globalAlpha = clamp(v);
    }
    get fillStyle() {
        return this._fillStyle;
    }
    set fillStyle(v) {
        if (!(v instanceof RadialGradient) && !(v instanceof LinearGradient)) {
            normalizeColor(v);
        }
        this._fillStyle = v;
    }
    get strokeStyle() {
        return this._strokeStyle;
    }
    set strokeStyle(v) {
        if (!(v instanceof RadialGradient) && !(v instanceof LinearGradient)) {
            normalizeColor(v);
        }
        this._strokeStyle = v;
    }
    get lineWidth() {
        return this._lineWidth;
    }
    set lineWidth(v) {
        finite(v, 'lineWidth');
        if (v >= 0) {
            this._lineWidth = v;
        }
    }
    get lineCap() {
        return this._lineCap;
    }
    set lineCap(v) {
        if (['butt', 'round', 'square'].includes(v)) {
            this._lineCap = v;
        }
    }
    get lineJoin() {
        return this._lineJoin;
    }
    set lineJoin(v) {
        if (['round', 'bevel', 'miter'].includes(v)) {
            this._lineJoin = v;
        }
    }
    get miterLimit() {
        return this._miterLimit;
    }
    set miterLimit(v) {
        finite(v, 'miterLimit');
        if (v > 0) {
            this._miterLimit = v;
        }
    }
    get lineDashOffset() {
        return this._lineDashOffset;
    }
    set lineDashOffset(v) {
        finite(v, 'lineDashOffset');
        this._lineDashOffset = v;
    }
    get font() {
        return this._font;
    }
    set font(v) {
        this._font = String(v);
    }
    get textAlign() {
        return this._textAlign;
    }
    set textAlign(v) {
        if (['start', 'end', 'left', 'right', 'center'].includes(v)) {
            this._textAlign = v;
        }
    }
    get textBaseline() {
        return this._textBaseline;
    }
    set textBaseline(v) {
        if (['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'].includes(v)) {
            this._textBaseline = v;
        }
    }
    get direction() {
        return this._direction;
    }
    set direction(v) {
        if (['ltr', 'rtl', 'inherit'].includes(v)) {
            this._direction = v;
        }
    }
    get filter() {
        return this._filter;
    }
    set filter(v) {
        if (v !== 'none' && v !== 'brightness(0) invert(1)') {
            throw new RangeError('VectorContext supports only none and brightness(0) invert(1) filters');
        }
        this._filter = v;
    }
    get stencilRef() {
        return this.vector.stencilDepth || null;
    }
    _frame() {
        if (!this.active || this.device.state !== 'ready') {
            throw new Error('VectorContext frame is unavailable');
        }
    }
    _paint(style) {
        if (style instanceof RadialGradient || style instanceof LinearGradient) {
            throw new TypeError('Gradient paint must be submitted through a vector fill or stroke');
        }
        const COLOR = normalizeColor(this.forceColor ?? style);
        COLOR[3] *= this._globalAlpha;
        if (this._filter === 'brightness(0) invert(1)') {
            COLOR[0] = COLOR[1] = COLOR[2] = 1;
        }
        return COLOR;
    }
    _gradientPaint(gradient) {
        let cached = this.gradientTextures.get(gradient);
        if (!cached) {
            if (this.gradientTextures.size >= MAX_GRADIENT_TEXTURES) {
                const EXPIRED = [...this.gradientTextures].find(([, entry]) => entry.lastFrame < this.frame);
                if (!EXPIRED) {
                    throw new RangeError(
                        `VectorContext supports at most ${MAX_GRADIENT_TEXTURES} distinct gradients in one frame`,
                    );
                }
                this.device.deleteTexture(EXPIRED[1].texture);
                this.gradientTextures.delete(EXPIRED[0]);
            }
            const LINEAR = gradient instanceof LinearGradient,
                WIDTH = LINEAR ? LINEAR_GRADIENT_SIZE : 256,
                HEIGHT = 1,
                DATA = gradient.raster();
            cached = {
                texture: this.device.createTexture(
                    {
                        width: WIDTH,
                        height: HEIGHT,
                        data: DATA,
                    },
                    {
                        format: 'rgba',
                        premultiplied: true,
                        filter: 'linear',
                    },
                ),
                revision: gradient.revision,
                lastFrame: this.frame,
                linear: LINEAR,
            };
            this.gradientTextures.set(gradient, cached);
        } else if (cached.revision !== gradient.revision) {
            this.vector.flush();
            const LINEAR = gradient instanceof LinearGradient,
                WIDTH = LINEAR ? LINEAR_GRADIENT_SIZE : 256;
            this.device.updateTexture(cached.texture, {
                width: WIDTH,
                height: 1,
                data: gradient.raster(),
            });
            cached.revision = gradient.revision;
            cached.linear = LINEAR;
        }
        cached.lastFrame = this.frame;
        const MATRIX_INVERSE = invert(gradient.matrix);
        if (!MATRIX_INVERSE) {
            throw new RangeError('Gradient transform is singular');
        }
        const COLOR = normalizeColor(this.forceColor ?? [1, 1, 1, 1]);
        COLOR[3] *= this._globalAlpha;
        if (gradient instanceof LinearGradient) {
            return {
                texture: cached.texture,
                kind: 'linear',
                gradient,
                x0: gradient.x0,
                y0: gradient.y0,
                x1: gradient.x1,
                y1: gradient.y1,
                matrixInverse: MATRIX_INVERSE,
                color: COLOR,
                whiteFlash: this._filter === 'brightness(0) invert(1)',
            };
        }
        const DX = gradient.x1 - gradient.x0,
            DY = gradient.y1 - gradient.y0,
            DR = gradient.r1 - gradient.r0,
            SCALE = Math.max(1, Math.hypot(DX, DY), Math.abs(gradient.r0), Math.abs(gradient.r1));
        return {
            texture: cached.texture,
            kind: 'radial',
            gradient,
            x0: gradient.x0,
            y0: gradient.y0,
            radialScale: SCALE,
            radialParams: [DX / SCALE, DY / SCALE, gradient.r0 / SCALE, DR / SCALE],
            radialEmpty: DX === 0 && DY === 0 && DR === 0,
            matrixInverse: MATRIX_INVERSE,
            color: COLOR,
            whiteFlash: this._filter === 'brightness(0) invert(1)',
        };
    }
    _releaseGradientTextures() {
        for (const [GRADIENT, CACHED] of this.gradientTextures) {
            try {
                this.device.deleteTexture(CACHED.texture);
            } catch (error) {
                try {
                    this.onError?.(error, {
                        phase: 'gradient-release',
                    });
                } catch {
                    // An error observer must not prevent the gradient resources from being released.
                }
            } finally {
                GRADIENT.pixels = null;
            }
        }
        this.gradientTextures.clear();
    }
    beginFrame({ width = this.canvas.width, height = this.canvas.height, clearColor = [0, 0, 0, 0] } = {}) {
        if (this.active) {
            throw new Error('endFrame is required before beginFrame');
        }
        if (this.state === 'lost' || this.device.state === 'lost') {
            return false;
        }
        if (this.state !== 'ready') {
            throw new Error(`VectorContext is ${this.state}`);
        }
        try {
            const READY = this.device.beginFrame({
                width,
                height,
                clearColor,
            });
            if (!READY) {
                return false;
            }
            this.active = true;
            this.meshRenderer?.beginFrame();
            this.primitiveRenderer?.beginFrame();
            this.frame++;
            this.pathCount = 0;
            this.vector.beginPath();
            this.primitivePath = {
                type: 'empty',
            };
            return true;
        } catch (error) {
            this.onError?.(error, {
                phase: 'beginFrame',
            });
            throw error;
        }
    }
    endFrame() {
        this._frame();
        try {
            this.flush('frameEnd');
            const STATS = this.device.endFrame();
            this.active = false;
            for (const MESH of this.deferredMeshes.splice(0)) {
                this.deleteStaticMesh(MESH);
            }
            this.frameStats = {
                drawCalls: STATS.drawCalls,
                vertices: STATS.vertices,
                uploadedBytes: STATS.bufferBytes ?? STATS.uploadedBytes ?? 0,
                textureUploads: STATS.textureUploads ?? 0,
                textureBytes: STATS.textureBytes ?? 0,
                gpuRenderTargetBytes: STATS.gpuRenderTargetBytes ?? 0,
                paths: this.pathCount,
                primitives: this.primitiveRenderer?.stats().frame ?? null,
            };
            this.total.frames++;
            this.total.drawCalls += this.frameStats.drawCalls;
            this.total.vertices += this.frameStats.vertices;
            this.total.uploadedBytes += this.frameStats.uploadedBytes;
            return this.stats();
        } catch (error) {
            this.active = false;
            this.vector.count = 0;
            this.onError?.(error, {
                phase: 'endFrame',
            });
            throw error;
        }
    }
    save() {
        this._frame();
        this.stack.push({
            fillStyle: this._fillStyle,
            strokeStyle: this._strokeStyle,
            globalAlpha: this._globalAlpha,
            lineWidth: this._lineWidth,
            lineCap: this._lineCap,
            lineJoin: this._lineJoin,
            miterLimit: this._miterLimit,
            lineDash: this._lineDash.slice(),
            lineDashOffset: this._lineDashOffset,
            font: this._font,
            textAlign: this._textAlign,
            textBaseline: this._textBaseline,
            direction: this._direction,
            filter: this._filter,
            forceColor: this.forceColor,
        });
        this.vector.save();
    }
    restore() {
        this._frame();
        const S = this.stack.pop();
        if (!S) {
            return;
        }
        this.primitiveRenderer?.flush('stateRestore');
        this.meshRenderer?.flush('stateRestore');
        this.vector.restore();
        Object.assign(this, {
            _fillStyle: S.fillStyle,
            _strokeStyle: S.strokeStyle,
            _globalAlpha: S.globalAlpha,
            _lineWidth: S.lineWidth,
            _lineCap: S.lineCap,
            _lineJoin: S.lineJoin,
            _miterLimit: S.miterLimit,
            _lineDash: S.lineDash,
            _lineDashOffset: S.lineDashOffset,
            _font: S.font,
            _textAlign: S.textAlign,
            _textBaseline: S.textBaseline,
            _direction: S.direction,
            _filter: S.filter,
            forceColor: S.forceColor,
        });
    }
    setTransform(a, b, c, d, e, f) {
        this.vector.setTransform(a, b, c, d, e, f);
    }
    resetTransform() {
        this.vector.setTransform(...IDENTITY);
    }
    getTransform() {
        const M = this.vector.matrix;
        return {
            a: M[0],
            b: M[1],
            c: M[2],
            d: M[3],
            e: M[4],
            f: M[5],
        };
    }
    transform(a, b, c, d, e, f) {
        this.vector.transform(a, b, c, d, e, f);
    }
    translate(x, y) {
        this.vector.translate(x, y);
    }
    rotate(angle) {
        this.vector.rotate(angle);
    }
    scale(x, y) {
        this.vector.scale(x, y);
    }
    beginPath() {
        this._frame();
        this.pathCount++;
        this.vector.beginPath();
        this.primitivePath = {
            type: 'empty',
        };
    }
    _materializePrimitivePath() {
        const PATH = this.primitivePath;
        if (PATH?.type !== 'ellipse') {
            return;
        }
        const MATRIX = this.vector.matrix;
        this.primitivePath = null;
        this.vector.matrix = PATH.matrix.slice();
        try {
            const POINTS = this._arcPoints(
                PATH.x,
                PATH.y,
                PATH.rx,
                PATH.ry,
                PATH.rotation,
                PATH.start,
                PATH.end,
                PATH.ccw,
            );
            this.vector.moveTo(...POINTS[0]);
            for (let i = 1; i < POINTS.length; i++) {
                this.vector.lineTo(...POINTS[i]);
            }
        } finally {
            this.vector.matrix = MATRIX;
        }
    }
    moveTo(x, y) {
        this._materializePrimitivePath();
        const POINT = transformedPoint(this.vector.matrix, x, y);
        this.primitivePath =
            this.primitivePath?.type === 'empty'
                ? {
                      type: 'line',
                      start: POINT,
                      end: null,
                  }
                : null;
        this.vector.moveTo(x, y);
    }
    lineTo(x, y) {
        this._materializePrimitivePath();
        if (!this.vector.cursor && this.primitivePath?.type === 'empty') {
            this.primitivePath = {
                type: 'line',
                start: transformedPoint(this.vector.matrix, x, y),
                end: null,
            };
        } else if (this.primitivePath?.type === 'line' && !this.primitivePath.end) {
            this.primitivePath.end = transformedPoint(this.vector.matrix, x, y);
        } else {
            this.primitivePath = null;
        }
        this.vector.lineTo(x, y);
    }
    closePath() {
        this._materializePrimitivePath();
        this.primitivePath = null;
        this.vector.closePath();
    }
    quadraticCurveTo(cx, cy, x, y) {
        this._materializePrimitivePath();
        this.primitivePath = null;
        this.vector.quadraticCurveTo(cx, cy, x, y);
    }
    bezierCurveTo(x1, y1, x2, y2, x, y) {
        this._materializePrimitivePath();
        this.primitivePath = null;
        this.vector.bezierCurveTo(x1, y1, x2, y2, x, y);
    }
    _arcPoints(x, y, rx, ry, rotation, start, end, ccw) {
        if (rx < 0 || ry < 0) {
            throw new RangeError('ellipse radii must be non-negative');
        }
        let sweep = end - start;
        if (!ccw) {
            if (sweep >= TAU) {
                sweep = TAU;
            } else {
                while (sweep < 0) {
                    sweep += TAU;
                }
            }
        } else if (sweep <= -TAU) {
            sweep = -TAU;
        } else {
            while (sweep > 0) {
                sweep -= TAU;
            }
        }
        const M = this.vector.matrix,
            R = Math.max(rx, ry) * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3])),
            STEP = R > 0.2 ? 2 * Math.acos(clamp(1 - 0.2 / R, -1, 1)) : Math.PI / 2,
            N = Math.max(1, Math.min(256, Math.ceil(Math.abs(sweep) / Math.max(0.01, STEP)))),
            C = Math.cos(rotation),
            S = Math.sin(rotation),
            OUT = [];
        for (let i = 0; i <= N; i++) {
            const A = start + (sweep * i) / N;
            OUT.push([
                x + Math.cos(A) * rx * C - Math.sin(A) * ry * S,
                y + Math.cos(A) * rx * S + Math.sin(A) * ry * C,
            ]);
        }
        return OUT;
    }
    arc(x, y, r, start, end, ccw = false) {
        this.ellipse(x, y, r, r, 0, start, end, ccw);
    }
    ellipse(x, y, rx, ry, rotation = 0, start = 0, end = TAU, ccw = false) {
        if (rx < 0 || ry < 0) {
            throw new RangeError('ellipse radii must be non-negative');
        }
        this._frame();
        this._materializePrimitivePath();
        const MATRIX = this.vector.matrix.slice();
        const FULL = isFullArc(start, end, ccw);
        const FAST =
            this.primitivePath?.type === 'empty' &&
            !this.vector.cursor &&
            FULL &&
            [x, y, rx, ry, rotation, start, end].every(Number.isFinite);
        this.primitivePath = FAST
            ? {
                  type: 'ellipse',
                  x,
                  y,
                  rx,
                  ry,
                  rotation,
                  start,
                  end,
                  ccw,
                  matrix: MATRIX,
              }
            : null;
        if (FAST) {
            return;
        }
        const POINTS = this._arcPoints(x, y, rx, ry, rotation, start, end, ccw);
        if (!this.vector.cursor) {
            this.vector.moveTo(...POINTS[0]);
        } else {
            this.vector.lineTo(...POINTS[0]);
        }
        for (let i = 1; i < POINTS.length; i++) {
            this.vector.lineTo(...POINTS[i]);
        }
    }
    rect(x, y, w, h) {
        this._materializePrimitivePath();
        const MATRIX = this.vector.matrix.slice();
        this.primitivePath =
            this.primitivePath?.type === 'empty' && !this.vector.cursor
                ? {
                      type: 'rect',
                      x,
                      y,
                      w,
                      h,
                      matrix: MATRIX,
                  }
                : null;
        this.vector.moveTo(x, y);
        this.vector.lineTo(x + w, y);
        this.vector.lineTo(x + w, y + h);
        this.vector.lineTo(x, y + h);
        this.vector.closePath();
    }
    roundRect(x, y, w, h, r = 0) {
        this._materializePrimitivePath();
        this.primitivePath = null;
        const RADII = Array.isArray(r) ? r : [r, r, r, r];
        const MAX = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
        const Q = RADII.map((v) => clamp(Number(v) || 0, 0, MAX));
        this.moveTo(x + Q[0], y);
        this.lineTo(x + w - Q[1], y);
        this.arc(x + w - Q[1], y + Q[1], Q[1], -Math.PI / 2, 0);
        this.lineTo(x + w, y + h - Q[2]);
        this.arc(x + w - Q[2], y + h - Q[2], Q[2], 0, Math.PI / 2);
        this.lineTo(x + Q[3], y + h);
        this.arc(x + Q[3], y + h - Q[3], Q[3], Math.PI / 2, Math.PI);
        this.lineTo(x, y + Q[0]);
        this.arc(x + Q[0], y + Q[0], Q[0], Math.PI, Math.PI * 1.5);
        this.closePath();
    }
    _temporaryPath(callback) {
        const V = this.vector,
            SAVED = {
                path: V.path,
                cursor: V.cursor,
                subpath: V.subpath,
                primitivePath: this.primitivePath,
            };
        try {
            this.primitivePath = {
                type: 'empty',
            };
            callback();
        } finally {
            V.path = SAVED.path;
            V.cursor = SAVED.cursor;
            V.subpath = SAVED.subpath;
            this.primitivePath = SAVED.primitivePath;
        }
    }
    _primitiveTransform(path) {
        let local;
        if (path.type === 'ellipse') {
            const COS = Math.cos(path.rotation);
            const SIN = Math.sin(path.rotation);
            local = [path.rx * COS, path.rx * SIN, -path.ry * SIN, path.ry * COS, path.x, path.y];
        } else {
            local = [path.w / 2, 0, 0, path.h / 2, path.x + path.w / 2, path.y + path.h / 2];
        }
        return composeTransform(path.matrix, local);
    }
    _submitPrimitive(matrix, color, params) {
        this.meshRenderer?.flush('primitiveBoundary');
        this.vector.flush();
        this.primitiveRenderer ??= new PrimitiveRenderer(this.device);
        return this.primitiveRenderer.draw({
            matrix,
            color,
            params,
            projection: this.vector.projection,
            clips: this.vector.clips,
            stencilRef: this.vector.stencilDepth || null,
        });
    }
    _tryPrimitiveFill() {
        const PATH = this.primitivePath;
        if (!PATH || (PATH.type !== 'ellipse' && PATH.type !== 'rect')) {
            return false;
        }
        if (this._fillStyle instanceof RadialGradient || this._fillStyle instanceof LinearGradient) {
            return false;
        }
        if (PATH.type === 'ellipse' && (!PATH.rx || !PATH.ry)) {
            return true;
        }
        if (PATH.type === 'rect' && (!PATH.w || !PATH.h)) {
            return true;
        }
        const TYPE = PATH.type === 'ellipse' ? 0 : 1;
        return this._submitPrimitive(this._primitiveTransform(PATH), this._paint(this._fillStyle), [TYPE, 0, 0, 0]);
    }
    _tryPrimitiveStroke(width) {
        const PATH = this.primitivePath;
        if (!PATH || this._strokeStyle instanceof RadialGradient || this._strokeStyle instanceof LinearGradient) {
            return false;
        }
        if (PATH.type === 'ellipse') {
            if (!PATH.rx || !PATH.ry) {
                return false;
            }
            return this._submitPrimitive(this._primitiveTransform(PATH), this._paint(this._strokeStyle), [
                0,
                1,
                width,
                0,
            ]);
        }
        if (PATH.type === 'rect') {
            if (!PATH.w || !PATH.h) {
                return false;
            }
            const MATRIX = this._primitiveTransform(PATH);
            const SCALE_X = Math.hypot(MATRIX[0], MATRIX[1]);
            const SCALE_Y = Math.hypot(MATRIX[2], MATRIX[3]);
            const DOT = MATRIX[0] * MATRIX[2] + MATRIX[1] * MATRIX[3];
            if (Math.abs(DOT) > 1e-6 * SCALE_X * SCALE_Y) {
                return false;
            }
            if (this._lineJoin === 'miter') {
                if (this._miterLimit < Math.SQRT2) {
                    return false;
                }
            } else if (this._lineJoin !== 'round') {
                return false;
            }
            return this._submitPrimitive(MATRIX, this._paint(this._strokeStyle), [
                1,
                1,
                width,
                this._lineJoin === 'miter' ? 1 : 0,
            ]);
        }
        if (PATH.type === 'line' && PATH.end) {
            const DX = PATH.end[0] - PATH.start[0];
            const DY = PATH.end[1] - PATH.start[1];
            const LENGTH = Math.hypot(DX, DY);
            if (!LENGTH) {
                return false;
            }
            const CAP = this._lineCap === 'butt' ? 0 : this._lineCap === 'square' ? 1 : 2;
            const UNIT_X = DX / LENGTH;
            const UNIT_Y = DY / LENGTH;
            const PAD = CAP === 0 ? 0 : width / 2;
            const HALF_LENGTH = LENGTH / 2 + PAD;
            const MATRIX = [
                UNIT_X * HALF_LENGTH,
                UNIT_Y * HALF_LENGTH,
                (-UNIT_Y * width) / 2,
                (UNIT_X * width) / 2,
                (PATH.start[0] + PATH.end[0]) / 2,
                (PATH.start[1] + PATH.end[1]) / 2,
            ];
            return this._submitPrimitive(MATRIX, this._paint(this._strokeStyle), [2, 1, width, CAP]);
        }
        return false;
    }
    fill(rule = 'nonzero') {
        this._frame();
        if ((rule === 'nonzero' || rule === 'evenodd') && this._tryPrimitiveFill()) {
            return;
        }
        this._materializePrimitivePath();
        this.primitiveRenderer?.flush('vectorBoundary');
        this.meshRenderer?.flush('vectorBoundary');
        if (this._fillStyle instanceof RadialGradient) {
            this.vector.fillRadialGradient({
                ...this._gradientPaint(this._fillStyle),
                rule,
            });
        } else if (this._fillStyle instanceof LinearGradient) {
            this.vector.fillLinearGradient({
                ...this._gradientPaint(this._fillStyle),
                rule,
            });
        } else {
            this.vector.fill(this._paint(this._fillStyle), rule);
        }
    }
    fillRect(x, y, w, h) {
        this._frame();
        this._temporaryPath(() => {
            this.vector.beginPath();
            this.rect(x, y, w, h);
            this.fill();
        });
    }
    stroke() {
        this._frame();
        if (!(this._lineWidth > 0)) {
            return;
        }
        const M = this.vector.matrix,
            WIDTH = this._lineWidth * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3])),
            GRADIENT =
                this._strokeStyle instanceof RadialGradient || this._strokeStyle instanceof LinearGradient
                    ? this._gradientPaint(this._strokeStyle)
                    : null,
            PAINT = GRADIENT ? GRADIENT.color : this._paint(this._strokeStyle),
            STYLE = {
                lineCap: this._lineCap,
                lineJoin: this._lineJoin,
                miterLimit: this._miterLimit,
            },
            DASH = this._lineDash,
            PERIOD = DASH.reduce((a, b) => a + b, 0);
        if ((!DASH.length || !PERIOD) && !GRADIENT && this._tryPrimitiveStroke(WIDTH)) {
            return;
        }
        this._materializePrimitivePath();
        this.primitiveRenderer?.flush('vectorBoundary');
        this.meshRenderer?.flush('vectorBoundary');
        if (!DASH.length || !PERIOD) {
            this.vector.stroke(PAINT, WIDTH, STYLE, GRADIENT);
            return;
        }
        const V = this.vector,
            ORIGINAL = V.path,
            MATRIX = V.matrix.slice();
        V.beginPath();
        V.setTransform(...IDENTITY);
        let phase = ((this._lineDashOffset % PERIOD) + PERIOD) % PERIOD;
        let index = 0;
        while (phase >= DASH[index] && DASH[index] > 0) {
            phase -= DASH[index];
            index = (index + 1) % DASH.length;
        }
        let remaining = DASH[index] - phase;
        for (const PATH of ORIGINAL) {
            for (let i = 1; i < PATH.length; i++) {
                const A = PATH[i - 1],
                    B = PATH[i],
                    LENGTH = Math.hypot(B.x - A.x, B.y - A.y);
                let at = 0;
                while (at < LENGTH - 1e-7) {
                    if (remaining <= 1e-7) {
                        index = (index + 1) % DASH.length;
                        remaining = DASH[index];
                        continue;
                    }
                    const STOP = Math.min(LENGTH, at + remaining);
                    if (index % 2 === 0) {
                        V.moveTo(A.x + ((B.x - A.x) * at) / LENGTH, A.y + ((B.y - A.y) * at) / LENGTH);
                        V.lineTo(A.x + ((B.x - A.x) * STOP) / LENGTH, A.y + ((B.y - A.y) * STOP) / LENGTH);
                    }
                    remaining -= STOP - at;
                    at = STOP;
                }
            }
        }
        V.stroke(PAINT, WIDTH, STYLE, GRADIENT);
        V.matrix = MATRIX;
        V.path = ORIGINAL;
        V.cursor = ORIGINAL.at(-1)?.at(-1) ?? null;
        V.subpath = ORIGINAL[0]?.[0] ?? null;
    }
    strokeRect(x, y, w, h) {
        this._frame();
        this._temporaryPath(() => {
            this.vector.beginPath();
            this.rect(x, y, w, h);
            this.stroke();
        });
    }
    setLineDash(values) {
        if (!Array.isArray(values) || values.some((v) => !Number.isFinite(v) || v < 0)) {
            throw new TypeError('dash must contain non-negative finite values');
        }
        if (values.length % 2) {
            values = values.concat(values);
        }
        this._lineDash = values.slice();
    }
    getLineDash() {
        return this._lineDash.slice();
    }
    clip(rule = 'nonzero') {
        this._frame();
        this._materializePrimitivePath();
        this.primitiveRenderer?.flush('clipBoundary');
        this.meshRenderer?.flush('clipBoundary');
        if (this.vector.path.filter((p) => p.length >= 3).length > 1) {
            throw new RangeError('clip supports one contour per clip call');
        }
        this.vector.clip(rule);
    }
    createClipPath(points, { rule = 'nonzero' } = {}) {
        return this.vector.createClipPath(points, {
            rule,
        });
    }
    clipPath(handle, { transform = null } = {}) {
        this._frame();
        this.primitiveRenderer?.flush('stencilChange');
        this.meshRenderer?.flush('stencilChange');
        this.vector.flush();
        this.vector.clipPath(handle, {
            transform,
        });
    }
    deleteClipPath(handle) {
        return this.vector.deleteClipPath(handle);
    }
    clipRect(x, y, w, h) {
        this._frame();
        this.primitiveRenderer?.flush('clipBoundary');
        this.meshRenderer?.flush('clipBoundary');
        this.vector.clipRect(x, y, w, h);
    }
    fillTriangleFan(points, paint = this._fillStyle) {
        this._frame();
        this.primitiveRenderer?.flush('vectorBoundary');
        this.meshRenderer?.flush('vectorBoundary');
        if (points.length < 3) {
            return;
        }
        this.vector.triangleFan(points, this._paint(paint));
    }
    beginGroup(opacity = 1, bounds = null) {
        this._frame();
        this.primitiveRenderer?.flush('groupBoundary');
        if (opacity !== 1) {
            this.meshRenderer?.flush('groupBoundary');
        }
        this.vector.beginGroup(opacity, bounds);
    }
    endGroup() {
        if (!this.vector.groups.at(-1)?.direct) {
            this.primitiveRenderer?.flush('groupBoundary');
            this.meshRenderer?.flush('groupBoundary');
        }
        this.vector.endGroup();
    }
    withGroupOpacity(opacity, callback, bounds = null) {
        this._frame();
        const PREVIOUS = this._globalAlpha;
        this.beginGroup(opacity, bounds);
        this._globalAlpha = 1;
        try {
            return callback();
        } finally {
            try {
                this.endGroup();
            } finally {
                this._globalAlpha = PREVIOUS;
            }
        }
    }
    groupBounds(x, y, radius) {
        const M = this.vector.matrix,
            P = transformed(M, x, y),
            R = radius * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3]));
        return {
            x: P.x - R,
            y: P.y - R,
            width: R * 2,
            height: R * 2,
        };
    }
    withColor(color, callback) {
        const PREVIOUS = this.forceColor;
        this.forceColor = normalizeColor(color);
        try {
            return callback();
        } finally {
            this.forceColor = PREVIOUS;
        }
    }
    withSilhouette(color, width, paint, radius = 128) {
        const ALPHA = this._globalAlpha,
            BOUNDS = this.groupBounds(0, 0, radius + width);
        return this.withGroupOpacity(
            ALPHA,
            () => {
                this.withColor(color, () => {
                    for (let i = 0; i < 8; i++) {
                        this.save();
                        const A = (i * TAU) / 8;
                        this.translate(Math.cos(A) * width, Math.sin(A) * width);
                        try {
                            paint();
                        } finally {
                            this.restore();
                        }
                    }
                    paint();
                });
                paint();
            },
            BOUNDS,
        );
    }
    _fontSize() {
        const M = this._font.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/);
        return M ? Number(M[1]) : 10;
    }
    _align() {
        if (this._textAlign === 'center') {
            return 'center';
        }
        if (
            this._textAlign === 'right' ||
            (this._textAlign === 'end' && this._direction !== 'rtl') ||
            (this._textAlign === 'start' && this._direction === 'rtl')
        ) {
            return 'right';
        }
        return 'left';
    }
    measureText(text) {
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        return this.glyphAtlas.measureText(String(text), {
            fontSize: this._fontSize(),
            align: this._align(),
        });
    }
    fillText(text, x, y, maxWidth) {
        this._frame();
        this.primitiveRenderer?.flush('vectorBoundary');
        this.meshRenderer?.flush('vectorBoundary');
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        const COLOR = this._paint(this._fillStyle),
            FONT_SIZE = this._fontSize(),
            ALIGN = this._align(),
            BASELINE = this._textBaseline,
            MEASURED = this.glyphAtlas.measureText(String(text), {
                fontSize: FONT_SIZE,
            }).width,
            SCALE = maxWidth && Number.isFinite(maxWidth) ? Math.min(1, maxWidth / (MEASURED || 1)) : 1;
        if (SCALE !== 1) {
            this.vector.save();
            this.vector.translate(x, y);
            this.vector.scale(SCALE, 1);
            this.vector.translate(-x, -y);
        }
        try {
            return this.vector.fillText(String(text), x, y, {
                fontSize: FONT_SIZE,
                align: ALIGN,
                baseline: BASELINE,
                color: COLOR,
            });
        } finally {
            if (SCALE !== 1) {
                this.vector.restore();
            }
        }
    }
    strokeText(text, x, y, maxWidth) {
        this._frame();
        this.primitiveRenderer?.flush('vectorBoundary');
        this.meshRenderer?.flush('vectorBoundary');
        if (!this.glyphAtlas) {
            throw new Error('GlyphAtlas is not configured');
        }
        const SCALE =
            maxWidth && Number.isFinite(maxWidth)
                ? Math.min(
                      1,
                      maxWidth /
                          (this.glyphAtlas.measureText(String(text), {
                              fontSize: this._fontSize(),
                          }).width || 1),
                  )
                : 1;
        this.vector.save();
        try {
            if (SCALE !== 1) {
                this.vector.translate(x, y);
                this.vector.scale(SCALE, 1);
                this.vector.translate(-x, -y);
            }
            return this.vector.strokeText(String(text), x, y, {
                fontSize: this._fontSize(),
                align: this._align(),
                baseline: this._textBaseline,
                color: this._paint(this._strokeStyle),
                lineWidth: this._lineWidth,
            });
        } finally {
            this.vector.restore();
        }
    }
    createLinearGradient(x0, y0, x1, y1) {
        return new LinearGradient(this.vector.matrix, x0, y0, x1, y1);
    }
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
        return new RadialGradient(this.vector.matrix, x0, y0, r0, x1, y1, r1);
    }
    /** Retains caller-authored local-space triangles once; caller explicitly releases the handle. */
    createMesh(data) {
        if (this.state !== 'ready' || this.device.state !== 'ready') {
            throw new Error('VectorContext is not ready');
        }
        this.meshRenderer ??= new MeshRenderer(this.device, {
            safeAlphaRunBatching: this.safeAlphaRunBatching,
        });
        return this.meshRenderer.createMesh(data);
    }
    deleteMesh(mesh) {
        return this.meshRenderer?.deleteMesh(mesh) ?? false;
    }
    /** Local transform composes with current Canvas-style transform; all paint state is captured by value. */
    drawMesh(mesh, { transform = null, morph = [0, 0], parts = null } = {}) {
        this._frame();
        if (!this.meshRenderer) {
            throw new TypeError('createMesh required');
        }
        this.primitiveRenderer?.flush('meshBoundary');
        this.vector.flush();
        let matrix = this.vector.matrix;
        if (transform) {
            if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) {
                throw new TypeError('Six finite transform values required');
            }
            const M = matrix,
                [A, B, C, D, E, F] = transform;
            matrix = [
                M[0] * A + M[2] * B,
                M[1] * A + M[3] * B,
                M[0] * C + M[2] * D,
                M[1] * C + M[3] * D,
                M[0] * E + M[2] * F + M[4],
                M[1] * E + M[3] * F + M[5],
            ];
        }
        this.meshRenderer.drawMesh(mesh, {
            matrix,
            projection: this.vector.projection,
            clips: this.vector.clips,
            morph,
            parts,
            color: this.forceColor ?? [1, 1, 1, 1],
            forceColor: this.forceColor !== null,
            alpha: this._globalAlpha,
            whiteFlash: this._filter === 'brightness(0) invert(1)',
            stencilRef: this.vector.stencilDepth || null,
        });
    }
    /** Draw a retained mesh silhouette and body in one ordered instance batch. */
    drawMeshSilhouette(
        mesh,
        {
            transform = null,
            morph = [0, 0],
            parts = null,
            color = 'black',
            width,
            radius = 128,
            outlineScale = null,
        } = {},
    ) {
        this._frame();
        if (!this.meshRenderer) {
            throw new TypeError('createMesh required');
        }
        finite(width, 'silhouette width');
        finite(radius, 'silhouette radius');
        if (width < 0 || radius < 0) {
            throw new RangeError('silhouette dimensions must be non-negative');
        }
        if (outlineScale !== null) {
            finite(outlineScale, 'silhouette outlineScale');
            if (outlineScale < 1) {
                throw new RangeError('silhouette outlineScale must be at least one');
            }
        }
        let outline;
        if (typeof color === 'string' && color[0] === '#') {
            outline = this._silhouetteColorCache.get(color);
            if (!outline) {
                outline = normalizeColor(color);
                if (this._silhouetteColorCache.size === 16) {
                    this._silhouetteColorCache.delete(this._silhouetteColorCache.keys().next().value);
                }
                this._silhouetteColorCache.set(color, outline);
            }
        } else {
            outline = normalizeColor(color);
        }
        const OUTLINE_INSTANCES = outlineScale === null ? 9 : 1,
            COUNT = OUTLINE_INSTANCES + 1,
            MATRICES = outlineScale === null ? this._silhouetteMatrices : this._scaledSilhouetteMatrices;
        const BOUNDS = this.groupBounds(0, 0, Math.max(radius + width, radius * (outlineScale ?? 1)));
        return this.withGroupOpacity(
            this._globalAlpha,
            () => {
                this.vector.flush();
                const SOURCE = this.vector.matrix,
                    A = SOURCE[0],
                    B = SOURCE[1],
                    C = SOURCE[2],
                    D = SOURCE[3],
                    E = SOURCE[4],
                    F = SOURCE[5];
                let ta = 1;
                let tb = 0;
                let tc = 0;
                let td = 1;
                let te = 0;
                let tf = 0;
                if (transform) {
                    if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) {
                        throw new TypeError('Six finite transform values required');
                    }
                    [ta, tb, tc, td, te, tf] = transform;
                }
                for (let i = 0; i < COUNT; i++) {
                    const OUTLINE_PASS = i < OUTLINE_INSTANCES,
                        OFFSET = outlineScale === null && OUTLINE_PASS && i < 8,
                        DIRECTION = OFFSET ? SILHOUETTE_OFFSETS[i] : null,
                        DX = DIRECTION ? DIRECTION[0] * width : 0,
                        DY = DIRECTION ? DIRECTION[1] * width : 0,
                        SCALE = outlineScale !== null && i === 0 ? outlineScale : 1,
                        AT = i * 6;
                    const E_OFFSET = E + A * DX + C * DY,
                        F_OFFSET = F + B * DX + D * DY;
                    MATRICES[AT] = (A * ta + C * tb) * SCALE;
                    MATRICES[AT + 1] = (B * ta + D * tb) * SCALE;
                    MATRICES[AT + 2] = (A * tc + C * td) * SCALE;
                    MATRICES[AT + 3] = (B * tc + D * td) * SCALE;
                    MATRICES[AT + 4] = A * te + C * tf + E_OFFSET;
                    MATRICES[AT + 5] = B * te + D * tf + F_OFFSET;
                }
                this.meshRenderer._drawMeshInstances(mesh, {
                    matrices: MATRICES,
                    count: COUNT,
                    projection: this.vector.projection,
                    morph,
                    parts,
                    color: this.forceColor ?? WHITE,
                    forceColor: this.forceColor !== null,
                    prefixColor: outline,
                    prefixCount: OUTLINE_INSTANCES,
                    forceColorPrefixCount: OUTLINE_INSTANCES,
                    alpha: this._globalAlpha,
                    whiteFlash: this._filter === 'brightness(0) invert(1)',
                    clips: this.vector.clips,
                    stencilRef: this.vector.stencilDepth || null,
                });
            },
            BOUNDS,
        );
    }
    flush(reason = 'explicit') {
        this._frame();
        this.primitiveRenderer?.flush(reason);
        this.meshRenderer?.flush(reason);
        this.vector.flush();
    }
    createStaticMesh(vertices, { strideFloats = 6 } = {}) {
        if (this.state !== 'ready' || this.device.state !== 'ready') {
            throw new Error('VectorContext is not ready');
        }
        if (
            !(vertices instanceof Float32Array) ||
            !Number.isSafeInteger(strideFloats) ||
            strideFloats < 2 ||
            vertices.length % strideFloats
        ) {
            throw new TypeError('mesh requires Float32Array and a matching strideFloats');
        }
        const BUFFER = this.device.createVertexBuffer({
            capacityBytes: vertices.byteLength,
        });
        this.device.uploadVertices(BUFFER, vertices);
        const MESH = {
            context: this,
            buffer: BUFFER,
            vertices,
            count: vertices.length / strideFloats,
            strideFloats,
        };
        this.staticMeshes.add(MESH);
        return MESH;
    }
    deleteStaticMesh(mesh) {
        if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh)) {
            return false;
        }
        this.device.deleteVertexBuffer(mesh.buffer);
        this.staticMeshes.delete(mesh);
        return true;
    }
    deferDeleteStaticMesh(mesh) {
        if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh) || this.deferredMeshes.includes(mesh)) {
            return false;
        }
        this.deferredMeshes.push(mesh);
        return true;
    }
    drawStaticMesh(
        mesh,
        { pipeline, projection, uniforms = {}, textures = [], blend = 'source-over', depth = null } = {},
    ) {
        this._frame();
        if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh) || !pipeline) {
            throw new TypeError('mesh owned by this context and caller pipeline are required');
        }
        this.flush('staticMeshBoundary');
        const VALUES = {
            ...uniforms,
        };
        if (projection) {
            VALUES.u_projection = projection;
        }
        this.device.draw({
            pipeline,
            buffer: mesh.buffer,
            count: mesh.count,
            uniforms: VALUES,
            textures,
            blend,
            depth,
            stencil: this.vector.stencilDepth
                ? {
                      func: 'equal',
                      ref: this.vector.stencilDepth,
                      mask: 255,
                      writeMask: 0,
                      pass: 'keep',
                  }
                : false,
        });
    }
    stats() {
        return {
            backend: 'webgl1',
            available: this.device.state === 'ready',
            contextLost: this.device.state === 'lost',
            failure: this.device.failure ?? null,
            frame: this.frame,
            ...this.frameStats,
            mesh: this.meshRenderer?.stats() ?? null,
            primitives: this.primitiveRenderer?.stats() ?? null,
            stagingBytes: this.vector.vertices.byteLength,
            gpuBufferBytes: this.device.stats.gpuBufferBytes ?? 0,
            gpuRenderTargetBytes: this.device.stats.gpuRenderTargetBytes ?? 0,
            textureCount: this.device.stats.textureCount ?? 0,
            activeGradientTextureCount: this.gradientTextures.size,
            renderTargetCount: this.device.stats.renderTargetCount ?? 0,
            bufferAllocations: this.device.stats.bufferAllocations ?? 0,
            totals: {
                ...this.total,
            },
        };
    }
    dispose() {
        if (this.state === 'disposed') {
            return;
        }
        this.vector.count = 0;
        this.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.primitiveRenderer?.dispose();
        this.meshRenderer?.dispose();
        for (const MESH of this.staticMeshes) {
            this.device.deleteVertexBuffer(MESH.buffer);
        }
        this._releaseGradientTextures();
        this.staticMeshes.clear();
        this.deferredMeshes.length = 0;
        if (this.ownsVector) {
            this.vector.dispose();
        }
        this.active = false;
        this.state = 'disposed';
    }
}

/** Reusable low-poly primitive emitters; art-specific recipes remain with the caller. */
export class PrimitivePainter {
    constructor(target, { point = null, alphaMultiplier = 1 } = {}) {
        if (!target?.fillTriangleFan && !(target?.beginPath && target?.fill)) {
            throw new TypeError('VectorContext or native Canvas2D context is required');
        }
        this.context = target;
        this.pointTransform = point;
        this.alphaMultiplier = alphaMultiplier;
    }
    point(x, y) {
        const RESULT = this.pointTransform ? this.pointTransform(x, y) : [x, y];
        return Array.isArray(RESULT) ? RESULT : [RESULT.x, RESULT.y];
    }
    _paint(points, paint) {
        if (points.length < 3) {
            return;
        }
        const CTX = this.context,
            OLD_ALPHA = CTX.globalAlpha ?? 1,
            MUL = typeof this.alphaMultiplier === 'function' ? this.alphaMultiplier() : this.alphaMultiplier;
        CTX.globalAlpha = OLD_ALPHA * clamp(MUL);
        try {
            if (typeof CTX.fillTriangleFan === 'function') {
                CTX.fillTriangleFan(
                    points.map((p) => this.point(p[0], p[1])),
                    paint,
                );
                return;
            }
            const RGBA = normalizeColor(paint);
            CTX.fillStyle = `rgba(${Math.round(RGBA[0] * 255)},${Math.round(RGBA[1] * 255)},${Math.round(RGBA[2] * 255)},${RGBA[3]})`;
            CTX.beginPath();
            const A = this.point(points[0][0], points[0][1]);
            for (let i = 1; i < points.length - 1; i++) {
                const B = this.point(points[i][0], points[i][1]),
                    C = this.point(points[i + 1][0], points[i + 1][1]);
                CTX.moveTo(A[0], A[1]);
                CTX.lineTo(B[0], B[1]);
                CTX.lineTo(C[0], C[1]);
                CTX.closePath();
            }
            CTX.fill();
        } finally {
            CTX.globalAlpha = OLD_ALPHA;
        }
    }
    poly(points, paint) {
        this._paint(points, paint);
    }
    tri(x1, y1, x2, y2, x3, y3, paint) {
        this.poly(
            [
                [x1, y1],
                [x2, y2],
                [x3, y3],
            ],
            paint,
        );
    }
    quad(x1, y1, x2, y2, x3, y3, x4, y4, paint) {
        this.poly(
            [
                [x1, y1],
                [x2, y2],
                [x3, y3],
                [x4, y4],
            ],
            paint,
        );
    }
    regularPolygon(x, y, radius, paint, sides = 10, rotation = 0) {
        if (sides < 3 || radius <= 0) {
            return;
        }
        let unit = PRIMITIVE_DIRECTIONS.get(`${sides}|${rotation}`);
        if (!unit) {
            unit = Array.from(
                {
                    length: sides,
                },
                (_, i) => [Math.cos(rotation + (i / sides) * TAU), Math.sin(rotation + (i / sides) * TAU)],
            );
            PRIMITIVE_DIRECTIONS.set(`${sides}|${rotation}`, unit);
        }
        this.poly(
            unit.map((p) => [x + p[0] * radius, y + p[1] * radius]),
            paint,
        );
    }
    circle(x, y, radius, paint, segments = 10) {
        this.regularPolygon(x, y, radius, paint, segments, 0);
    }
    hex(x, y, radius, paint) {
        this.regularPolygon(x, y, radius, paint, 6, Math.PI / 6);
    }
    line(x0, y0, x1, y1, width, paint) {
        const DX = x1 - x0,
            DY = y1 - y0,
            LENGTH = Math.hypot(DX, DY) || 1,
            NX = ((-DY / LENGTH) * width) / 2,
            NY = ((DX / LENGTH) * width) / 2;
        this.quad(x0 + NX, y0 + NY, x1 + NX, y1 + NY, x1 - NX, y1 - NY, x0 - NX, y0 - NY, paint);
    }
    fan(points, paint) {
        this.poly(points, paint);
    }
}
const PRIMITIVE_DIRECTIONS = new Map();

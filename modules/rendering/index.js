/** WebGL 1 전용 즉시 제출 2D renderer. 게임·DOM 입력·시간선에 의존하지 않습니다. */
const WHITE = Object.freeze([1, 1, 1, 1]);
const CLEAR = Object.freeze([0, 0, 0, 0]);
const VERTEX = `
attribute vec2 a_position;
attribute vec2 a_uv;
attribute vec4 a_color;
uniform mat3 u_projection;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec3 p = u_projection * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = a_uv; v_color = a_color;
}`;
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec4 t = texture2D(u_texture, v_uv);
  float alpha = t.a * v_color.a;
  gl_FragColor = vec4(t.rgb * v_color.rgb * v_color.a, alpha);
}`;
function finite(value, name) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be finite`);
    }
}
function positive(value, name) {
    finite(value, name);
    if (value <= 0) {
        throw new RangeError(`${name} must be positive`);
    }
}
/**
 * RGBA 바이트 범위를 제자리에서 premultiply합니다. 범위의 알파가 모두 255이면 곱셈이 항등이라 건너뜁니다.
 * 결과는 항상 `Math.round(channel * alpha / 255)`와 같습니다.
 */
function premultiplyBytes(bytes, start, end) {
    let opaque = true;
    for (let i = start + 3; i < end; i += 4) {
        if (bytes[i] !== 255) {
            opaque = false;
            break;
        }
    }
    if (opaque) {
        return;
    }
    for (let i = start; i < end; i += 4) {
        const A = bytes[i + 3] / 255;
        bytes[i] = Math.round(bytes[i] * A);
        bytes[i + 1] = Math.round(bytes[i + 1] * A);
        bytes[i + 2] = Math.round(bytes[i + 2] * A);
    }
}
function color(value) {
    if (!value || value.length !== 4) {
        throw new TypeError('color must be [r,g,b,a]');
    }
    for (let i = 0; i < 4; i++) {
        if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) {
            throw new RangeError('color channels must be in [0,1]');
        }
    }
}
function compile(gl, type, source) {
    const SHADER = gl.createShader(type);
    if (!SHADER) {
        throw new Error('WebGL shader allocation failed');
    }
    gl.shaderSource(SHADER, source);
    gl.compileShader(SHADER);
    if (!gl.getShaderParameter(SHADER, gl.COMPILE_STATUS)) {
        const MESSAGE = gl.getShaderInfoLog(SHADER);
        gl.deleteShader(SHADER);
        throw new Error(`WebGL shader: ${MESSAGE}`);
    }
    return SHADER;
}

/**
 * Painter-order quads/triangles, one reusable vertex buffer. No implicit loop/sorting.
 * Owns its program and stream buffer. It can interleave with a WebGLDevice/MeshRenderer
 * on the same WebGL 1 context when each renderer is flushed before switching passes.
 * All public numbers use CSS/world units, angles use radians, RGBA colors are straight-alpha normalized numbers.
 */
export class Renderer2D {
    constructor(canvas, { batchVertices = 6144, antialias = true, depth = false, preserveDrawingBuffer = false } = {}) {
        if (!canvas?.getContext || !canvas?.addEventListener) {
            throw new TypeError('canvas is required');
        }
        if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1_048_576) {
            throw new RangeError('batchVertices must be 6..1048576');
        }
        if (typeof depth !== 'boolean') {
            throw new TypeError('depth must be boolean');
        }
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', {
            alpha: true,
            premultipliedAlpha: true,
            antialias,
            depth,
            stencil: false,
            preserveDrawingBuffer,
        });
        if (!this.gl) {
            throw new Error('WebGL 1 is required; no Canvas2D fallback');
        }
        this.state = 'ready';
        this.failure = null;
        this.active = false;
        this.vertices = new Float32Array(batchVertices * 8);
        this.vertexCount = 0;
        this.projection = new Float32Array(9);
        this.textures = new Map();
        this.width = canvas.width || 1;
        this.height = canvas.height || 1;
        this.dpr = 1;
        this.camera = {
            x: this.width / 2,
            y: this.height / 2,
            zoom: 1,
            rotation: 0,
        };
        this.stats = {
            backend: 'webgl1',
            frame: 0,
            drawCalls: 0,
            vertices: 0,
            uploadedBytes: 0,
            bufferViews: 0,
            textureUploads: 0,
            totalTextureUploads: 0,
            textureCount: 0,
            stagingBytes: this.vertices.byteLength,
            bufferAllocations: 0,
        };
        this.onLost = (event) => {
            event.preventDefault();
            this.state = 'lost';
            this.active = false;
            this.vertexCount = 0;
            this.batchTexture = null;
        };
        this.onRestored = () => {
            if (this.state === 'disposed') {
                return;
            }
            try {
                this._initialize();
                this.state = 'ready';
                this.failure = null;
            } catch (error) {
                this.state = 'failed';
                this.failure = error.message;
                this._deleteGPU();
            }
        };
        try {
            this._initialize();
        } catch (error) {
            this._deleteGPU();
            this.state = 'failed';
            throw error;
        }
        canvas.addEventListener('webglcontextlost', this.onLost);
        canvas.addEventListener('webglcontextrestored', this.onRestored);
    }
    _ready() {
        if (this.state !== 'ready') {
            throw new Error(`Renderer is ${this.state}${this.failure ? `: ${this.failure}` : ''}`);
        }
    }
    _frame() {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame is required');
        }
    }
    _initialize() {
        const GL = this.gl;
        let vertex;
        let fragment;
        try {
            vertex = compile(GL, GL.VERTEX_SHADER, VERTEX);
            fragment = compile(GL, GL.FRAGMENT_SHADER, FRAGMENT);
            this.program = GL.createProgram();
            if (!this.program) {
                throw new Error('WebGL program allocation failed');
            }
            GL.attachShader(this.program, vertex);
            GL.attachShader(this.program, fragment);
            GL.linkProgram(this.program);
            if (!GL.getProgramParameter(this.program, GL.LINK_STATUS)) {
                throw new Error(`WebGL link: ${GL.getProgramInfoLog(this.program)}`);
            }
        } finally {
            if (vertex) {
                GL.deleteShader(vertex);
            }
            if (fragment) {
                GL.deleteShader(fragment);
            }
        }
        this.buffer = GL.createBuffer();
        if (!this.buffer) {
            throw new Error('WebGL buffer allocation failed');
        }
        GL.bindBuffer(GL.ARRAY_BUFFER, this.buffer);
        GL.bufferData(GL.ARRAY_BUFFER, this.vertices.byteLength, GL.DYNAMIC_DRAW);
        this.stats.bufferAllocations++;
        GL.useProgram(this.program);
        this.instancingExtension = GL.getExtension('ANGLE_instanced_arrays');
        this.attributeLocations = [];
        for (const [NAME, SIZE, OFFSET] of [
            ['a_position', 2, 0],
            ['a_uv', 2, 8],
            ['a_color', 4, 16],
        ]) {
            const LOCATION = GL.getAttribLocation(this.program, NAME);
            this.attributeLocations.push([LOCATION, SIZE, OFFSET]);
            GL.enableVertexAttribArray(LOCATION);
            GL.vertexAttribPointer(LOCATION, SIZE, GL.FLOAT, false, 32, OFFSET);
        }
        this.uProjection = GL.getUniformLocation(this.program, 'u_projection');
        this.uTexture = GL.getUniformLocation(this.program, 'u_texture');
        GL.uniform1i(this.uTexture, 0);
        GL.activeTexture(GL.TEXTURE0);
        GL.disable(GL.DEPTH_TEST);
        GL.disable(GL.CULL_FACE);
        GL.disable(GL.DITHER);
        GL.enable(GL.BLEND);
        GL.blendEquation(GL.FUNC_ADD);
        GL.blendFunc(GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
        GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
        GL.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, GL.NONE);
        this.white = {
            width: 1,
            height: 1,
            source: new Uint8Array([255, 255, 255, 255]),
            filter: 'nearest',
            texture: null,
        };
        this._upload(this.white);
        for (const RECORD of this.textures.values()) {
            RECORD.texture = null;
            this._upload(RECORD);
        }
        this.batchTexture = null;
        this.vertexCount = 0;
        GL.viewport(0, 0, this.canvas.width, this.canvas.height);
        this._projection();
    }
    _projection() {
        const { x: X, y: Y, zoom: ZOOM, rotation: ROTATION } = this.camera;
        const C = Math.cos(ROTATION) * ZOOM,
            S = Math.sin(ROTATION) * ZOOM;
        const M = this.projection,
            W = this.width,
            H = this.height;
        M[0] = (2 * C) / W;
        M[1] = (2 * S) / H;
        M[2] = 0;
        M[3] = (2 * S) / W;
        M[4] = (-2 * C) / H;
        M[5] = 0;
        M[6] = (-2 * (C * X + S * Y)) / W;
        M[7] = (2 * (C * Y - S * X)) / H;
        M[8] = 1;
        this.gl.useProgram(this.program);
        this.gl.uniformMatrix3fv(this.uProjection, false, M);
    }
    /** CSS viewport dimensions; does not change CSS style. Game controls camera separately. */
    resize(width, height, dpr = 1) {
        this._ready();
        positive(width, 'width');
        positive(height, 'height');
        positive(dpr, 'dpr');
        const PIXEL_WIDTH = Math.max(1, Math.round(width * dpr)),
            PIXEL_HEIGHT = Math.max(1, Math.round(height * dpr));
        const LIMIT = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
        if (PIXEL_WIDTH > LIMIT[0] || PIXEL_HEIGHT > LIMIT[1]) {
            throw new RangeError('viewport exceeds WebGL limits');
        }
        if (this.active) {
            throw new Error('resize must be outside beginFrame/endFrame');
        }
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        if (this.canvas.width !== PIXEL_WIDTH) {
            this.canvas.width = PIXEL_WIDTH;
        }
        if (this.canvas.height !== PIXEL_HEIGHT) {
            this.canvas.height = PIXEL_HEIGHT;
        }
        this.gl.viewport(0, 0, PIXEL_WIDTH, PIXEL_HEIGHT);
        this._projection();
    }
    /** Camera center in world units; zoom is CSS pixels per world unit. */
    setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
        this._ready();
        finite(x, 'x');
        finite(y, 'y');
        positive(zoom, 'zoom');
        finite(rotation, 'rotation');
        if (this.active) {
            this.flush();
        }
        this.camera.x = x;
        this.camera.y = y;
        this.camera.zoom = zoom;
        this.camera.rotation = rotation;
        this._projection();
    }
    /** Caller-owned output; no world/simulation state is read or changed. */
    worldToScreenInto(x, y, out) {
        finite(x, 'x');
        finite(y, 'y');
        const CAMERA = this.camera;
        const C = Math.cos(CAMERA.rotation),
            S = Math.sin(CAMERA.rotation),
            DX = x - CAMERA.x,
            DY = y - CAMERA.y;
        out.x = (C * DX + S * DY) * CAMERA.zoom + this.width / 2;
        out.y = (-S * DX + C * DY) * CAMERA.zoom + this.height / 2;
        return out;
    }
    screenToWorldInto(x, y, out) {
        finite(x, 'x');
        finite(y, 'y');
        const CAMERA = this.camera;
        const C = Math.cos(CAMERA.rotation),
            S = Math.sin(CAMERA.rotation),
            DX = (x - this.width / 2) / CAMERA.zoom,
            DY = (y - this.height / 2) / CAMERA.zoom;
        out.x = C * DX - S * DY + CAMERA.x;
        out.y = S * DX + C * DY + CAMERA.y;
        return out;
    }
    _source(source, filter, premultiplied = false) {
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new RangeError('filter must be nearest or linear');
        }
        if (Object.prototype.toString.call(source) === '[object ImageBitmap]') {
            throw new TypeError('ImageBitmap alpha mode cannot be inspected; use an image/canvas or RGBA bytes');
        }
        const WIDTH = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
        const HEIGHT = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
        const MAX = (this.maxTextureSize ??= this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
        if (
            !Number.isSafeInteger(WIDTH) ||
            !Number.isSafeInteger(HEIGHT) ||
            WIDTH < 1 ||
            HEIGHT < 1 ||
            WIDTH > MAX ||
            HEIGHT > MAX
        ) {
            throw new RangeError('texture dimensions are invalid');
        }
        let retained = source;
        if (source.data !== undefined) {
            if (
                !(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) ||
                source.data.length !== WIDTH * HEIGHT * 4
            ) {
                throw new TypeError('texture data must be width*height*4 RGBA bytes');
            }
            retained = new Uint8Array(source.data); // owns premultiplied restoration pixels
            if (!premultiplied) {
                premultiplyBytes(retained, 0, retained.length);
            }
        }
        return {
            width: WIDTH,
            height: HEIGHT,
            source: retained,
            filter,
            premultiplied,
            texture: null,
        };
    }
    _upload(record) {
        const GL = this.gl;
        const TEXTURE = GL.createTexture();
        if (!TEXTURE) {
            throw new Error('WebGL texture allocation failed');
        }
        record.texture = TEXTURE;
        try {
            GL.bindTexture(GL.TEXTURE_2D, TEXTURE);
            GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(record.source instanceof Uint8Array));
            if (record.source instanceof Uint8Array) {
                GL.texImage2D(
                    GL.TEXTURE_2D,
                    0,
                    GL.RGBA,
                    record.width,
                    record.height,
                    0,
                    GL.RGBA,
                    GL.UNSIGNED_BYTE,
                    record.source,
                );
            } else {
                GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, record.source);
            }
            const FILTER = record.filter === 'linear' ? GL.LINEAR : GL.NEAREST;
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, FILTER);
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, FILTER);
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`WebGL texture upload error ${ERROR}`);
            }
            this.stats.textureUploads++;
            this.stats.totalTextureUploads++;
        } catch (error) {
            GL.deleteTexture(TEXTURE);
            record.texture = null;
            throw error;
        }
    }
    /**
     * Loaded origin-clean image/canvas, or {width,height,data: RGBA bytes}.
     * `premultiplied:true` declares that RGBA bytes already have alpha multiplied into RGB, so no CPU pass runs.
     */
    createTexture(source, { filter = 'linear', premultiplied = false } = {}) {
        this._ready();
        if (typeof premultiplied !== 'boolean') {
            throw new TypeError('premultiplied must be boolean');
        }
        const RECORD = this._source(source, filter, premultiplied);
        if (this.active) {
            this.flush();
        }
        this._upload(RECORD);
        const HANDLE = Object.freeze({
            width: RECORD.width,
            height: RECORD.height,
        });
        this.textures.set(HANDLE, RECORD);
        this.stats.textureCount = this.textures.size;
        return HANDLE;
    }
    /**
     * Replacement dimensions must match the handle. Upload is explicit, never per sprite.
     * RGBA byte sources update the existing GPU texture in place (no reallocation) and may name the changed
     * `{x,y,width,height}` region: only those rows are copied, premultiplied and uploaded. The source is still the
     * full image, and pixels outside the region must be unchanged since the previous upload. Bytes follow the
     * `premultiplied` flag the texture was created with.
     */
    updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
        this._ready();
        const PREVIOUS = this.textures.get(handle);
        if (!PREVIOUS) {
            throw new Error('unknown/deleted texture');
        }
        const PREMULTIPLIED = PREVIOUS.premultiplied === true;
        const WHOLE = x === 0 && y === 0 && width === handle.width && height === handle.height;
        const IN_PLACE = source?.data !== undefined && PREVIOUS.source instanceof Uint8Array;
        if (!IN_PLACE) {
            if (!WHOLE) {
                throw new TypeError('region updates require RGBA byte data on a byte texture');
            }
            const RECORD = this._source(source, PREVIOUS.filter, PREMULTIPLIED);
            if (RECORD.width !== handle.width || RECORD.height !== handle.height) {
                throw new RangeError('texture update dimensions must match');
            }
            if (this.active) {
                this.flush();
            }
            this._upload(RECORD);
            this.gl.deleteTexture(PREVIOUS.texture);
            this.textures.set(handle, RECORD);
            return;
        }
        for (const [VALUE, NAME] of [
            [x, 'x'],
            [y, 'y'],
            [width, 'width'],
            [height, 'height'],
        ]) {
            if (!Number.isSafeInteger(VALUE) || VALUE < (NAME === 'width' || NAME === 'height' ? 1 : 0)) {
                throw new RangeError(`${NAME} must be an integer`);
            }
        }
        if (x + width > handle.width || y + height > handle.height) {
            throw new RangeError('texture region outside bounds');
        }
        const DATA = source.data;
        if (
            source.width !== handle.width ||
            source.height !== handle.height ||
            !(DATA instanceof Uint8Array || DATA instanceof Uint8ClampedArray) ||
            DATA.length !== handle.width * handle.height * 4
        ) {
            throw new RangeError('texture update dimensions must match');
        }
        if (this.active) {
            this.flush();
        }
        const RETAINED = PREVIOUS.source,
            ROW = handle.width * 4;
        if (WHOLE) {
            RETAINED.set(DATA);
            if (!PREMULTIPLIED) {
                premultiplyBytes(RETAINED, 0, RETAINED.length);
            }
        } else {
            for (let row = 0; row < height; row++) {
                const START = (y + row) * ROW + x * 4;
                RETAINED.set(DATA.subarray(START, START + width * 4), START);
                if (!PREMULTIPLIED) {
                    premultiplyBytes(RETAINED, START, START + width * 4);
                }
            }
        }
        const GL = this.gl;
        let pixels = RETAINED;
        if (!WHOLE) {
            const NEEDED = width * height * 4;
            if (!this.regionBytes || this.regionBytes.length !== NEEDED) {
                this.regionBytes = new Uint8Array(NEEDED);
            }
            for (let row = 0; row < height; row++) {
                const START = (y + row) * ROW + x * 4;
                this.regionBytes.set(RETAINED.subarray(START, START + width * 4), row * width * 4);
            }
            pixels = this.regionBytes;
        }
        GL.bindTexture(GL.TEXTURE_2D, PREVIOUS.texture);
        GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
        GL.texSubImage2D(GL.TEXTURE_2D, 0, x, y, width, height, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
        const ERROR = GL.getError();
        if (ERROR !== GL.NO_ERROR) {
            throw new Error(`WebGL texture upload error ${ERROR}`);
        }
        this.stats.textureUploads++;
        this.stats.totalTextureUploads++;
    }
    deleteTexture(handle) {
        if (this.state === 'disposed') {
            return false;
        }
        const RECORD = this.textures.get(handle);
        if (!RECORD) {
            return false;
        }
        if (this.active) {
            this.flush();
        }
        this.gl.deleteTexture(RECORD.texture);
        this.textures.delete(handle);
        this.stats.textureCount = this.textures.size;
        return true;
    }
    /** Returns false while context is lost. Caller skips that frame; restore is automatic. */
    beginFrame(clear = CLEAR) {
        if (this.state === 'lost') {
            return false;
        }
        this._ready();
        if (this.active) {
            throw new Error('endFrame is required');
        }
        color(clear);
        this.active = true;
        this.vertexCount = 0;
        this.batchTexture = null;
        const STATS = this.stats;
        STATS.frame++;
        STATS.drawCalls = STATS.vertices = STATS.uploadedBytes = STATS.bufferViews = STATS.textureUploads = 0;
        const GL = this.gl;
        GL.viewport(0, 0, this.canvas.width, this.canvas.height);
        GL.disable(GL.SCISSOR_TEST);
        GL.colorMask(true, true, true, true);
        GL.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
        GL.clear(GL.COLOR_BUFFER_BIT);
        return true;
    }
    _reserve(count, texture) {
        this._frame();
        if (this.batchTexture !== texture || this.vertexCount + count > this.vertices.length / 8) {
            this.flush();
        }
        this.batchTexture = texture;
    }
    _vertex(x, y, u, v, tint) {
        const DATA = this.vertices;
        let i = this.vertexCount++ * 8;
        DATA[i++] = x;
        DATA[i++] = y;
        DATA[i++] = u;
        DATA[i++] = v;
        DATA[i++] = tint[0];
        DATA[i++] = tint[1];
        DATA[i++] = tint[2];
        DATA[i] = tint[3];
    }
    triangle(x0, y0, x1, y1, x2, y2, tint = WHITE) {
        finite(x0, 'x0');
        finite(y0, 'y0');
        finite(x1, 'x1');
        finite(y1, 'y1');
        finite(x2, 'x2');
        finite(y2, 'y2');
        color(tint);
        this._reserve(3, this.white.texture);
        this._vertex(x0, y0, 0, 0, tint);
        this._vertex(x1, y1, 0, 0, tint);
        this._vertex(x2, y2, 0, 0, tint);
    }
    _quad(texture, x, y, width, height, angle, tint, u0, v0, u1, v1) {
        finite(x, 'x');
        finite(y, 'y');
        positive(width, 'width');
        positive(height, 'height');
        finite(angle, 'angle');
        color(tint);
        this._reserve(6, texture);
        const C = Math.cos(angle),
            S = Math.sin(angle),
            HX = width / 2,
            HY = height / 2;
        const AX = x - C * HX + S * HY,
            AY = y - S * HX - C * HY;
        const BX = x + C * HX + S * HY,
            BY = y + S * HX - C * HY;
        const CX = x + C * HX - S * HY,
            CY = y + S * HX + C * HY;
        const DX = x - C * HX - S * HY,
            DY = y - S * HX + C * HY;
        this._vertex(AX, AY, u0, v0, tint);
        this._vertex(BX, BY, u1, v0, tint);
        this._vertex(CX, CY, u1, v1, tint);
        this._vertex(AX, AY, u0, v0, tint);
        this._vertex(CX, CY, u1, v1, tint);
        this._vertex(DX, DY, u0, v1, tint);
    }
    /** Center-anchored rectangle, positive size, clockwise rotation in y-down world. */
    rect(x, y, width, height, tint = WHITE, angle = 0) {
        this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1);
    }
    /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
    sprite(
        texture,
        x,
        y,
        width = texture.width,
        height = texture.height,
        { angle = 0, tint = WHITE, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {},
    ) {
        const RECORD = this.textures.get(texture);
        if (!RECORD) {
            throw new Error('unknown/deleted texture');
        }
        if (
            !Number.isFinite(u0) ||
            !Number.isFinite(v0) ||
            !Number.isFinite(u1) ||
            !Number.isFinite(v1) ||
            Math.min(u0, v0, u1, v1) < 0 ||
            Math.max(u0, v0, u1, v1) > 1
        ) {
            throw new RangeError('UV must be in [0,1]');
        }
        this._quad(RECORD.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
    }
    /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
    ellipse(x, y, radiusX, radiusY, tint = WHITE, segments = 24) {
        finite(x, 'x');
        finite(y, 'y');
        positive(radiusX, 'radiusX');
        positive(radiusY, 'radiusY');
        color(tint);
        if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) {
            throw new RangeError('segments must be 3..256');
        }
        for (let i = 0; i < segments; i++) {
            const A = (i / segments) * Math.PI * 2,
                B = ((i + 1) / segments) * Math.PI * 2;
            this._reserve(3, this.white.texture);
            this._vertex(x, y, 0, 0, tint);
            this._vertex(x + Math.cos(A) * radiusX, y + Math.sin(A) * radiusY, 0, 0, tint);
            this._vertex(x + Math.cos(B) * radiusX, y + Math.sin(B) * radiusY, 0, 0, tint);
        }
    }
    line(x0, y0, x1, y1, width, tint = WHITE) {
        finite(x0, 'x0');
        finite(y0, 'y0');
        finite(x1, 'x1');
        finite(y1, 'y1');
        positive(width, 'width');
        color(tint);
        this._frame();
        const LENGTH = Math.hypot(x1 - x0, y1 - y0);
        if (!LENGTH) {
            return;
        }
        this.rect((x0 + x1) / 2, (y0 + y1) / 2, LENGTH, width, tint, Math.atan2(y1 - y0, x1 - x0));
    }
    flush() {
        this._frame();
        if (!this.vertexCount) {
            return;
        }
        const GL = this.gl,
            VIEW = this.vertices.subarray(0, this.vertexCount * 8);
        GL.useProgram(this.program);
        GL.bindBuffer(GL.ARRAY_BUFFER, this.buffer);
        for (const [LOCATION, SIZE, OFFSET] of this.attributeLocations) {
            GL.enableVertexAttribArray(LOCATION);
            this.instancingExtension?.vertexAttribDivisorANGLE(LOCATION, 0);
            GL.vertexAttribPointer(LOCATION, SIZE, GL.FLOAT, false, 32, OFFSET);
        }
        GL.activeTexture(GL.TEXTURE0);
        GL.bindTexture(GL.TEXTURE_2D, this.batchTexture);
        GL.uniform1i(this.uTexture, 0);
        GL.uniformMatrix3fv(this.uProjection, false, this.projection);
        GL.disable(GL.SCISSOR_TEST);
        GL.disable(GL.DEPTH_TEST);
        GL.depthMask(false);
        GL.disable(GL.STENCIL_TEST);
        GL.disable(GL.CULL_FACE);
        GL.disable(GL.DITHER);
        GL.colorMask(true, true, true, true);
        GL.enable(GL.BLEND);
        GL.blendEquation(GL.FUNC_ADD);
        GL.blendFunc(GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
        GL.bufferSubData(GL.ARRAY_BUFFER, 0, VIEW);
        GL.drawArrays(GL.TRIANGLES, 0, this.vertexCount);
        this.stats.drawCalls++;
        this.stats.vertices += this.vertexCount;
        this.stats.uploadedBytes += VIEW.byteLength;
        this.stats.bufferViews++;
        this.vertexCount = 0;
    }
    /** Stats is a reused object, valid until next frame; CPU submission, not GPU timing. */
    endFrame() {
        this.flush();
        this.active = false;
        this.batchTexture = null;
        return this.stats;
    }
    _deleteGPU() {
        const GL = this.gl;
        // Bound programs otherwise remain delete-pending until another program is used.
        GL.useProgram(null);
        GL.bindBuffer(GL.ARRAY_BUFFER, null);
        GL.bindTexture(GL.TEXTURE_2D, null);
        for (const RECORD of this.textures.values()) {
            if (RECORD.texture) {
                GL.deleteTexture(RECORD.texture);
            }
        }
        if (this.white?.texture) {
            GL.deleteTexture(this.white.texture);
        }
        if (this.buffer) {
            GL.deleteBuffer(this.buffer);
        }
        if (this.program) {
            GL.deleteProgram(this.program);
        }
    }
    /** Idempotent. Removes context listeners and releases retained sources/GPU resources. */
    dispose() {
        if (this.state === 'disposed') {
            return;
        }
        this.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this._deleteGPU();
        this.textures.clear();
        this.white = null;
        this.buffer = this.program = null;
        this.stats.textureCount = 0;
        this.active = false;
        this.vertexCount = 0;
        this.state = 'disposed';
    }
}
export { WebGLDevice } from './device.js';
export { VectorRenderer } from './vector-renderer.js';
export { VectorContext, PrimitivePainter } from './vector-context.js';
export { MeshBuilder } from './mesh-builder.js';
export { MeshRenderer } from './mesh-renderer.js';
export { YarnSurfaceRenderer, buildYarnSurfaceGeometry } from './yarn-shader.js';
export { GlyphAtlas } from './glyph-atlas.js';
export { FontAssetLoader } from './font-assets.js';

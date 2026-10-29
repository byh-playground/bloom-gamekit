import { TextureAtlasArray } from './texture-atlas.js';
/** Programmable WebGL 2 resource/stream/pass core. Game owns geometry and materials. */
const FUNCTIONS = Object.freeze({
    never: 'NEVER',
    less: 'LESS',
    equal: 'EQUAL',
    lequal: 'LEQUAL',
    greater: 'GREATER',
    notequal: 'NOTEQUAL',
    gequal: 'GEQUAL',
    always: 'ALWAYS',
});
const OPERATIONS = Object.freeze({
    keep: 'KEEP',
    zero: 'ZERO',
    replace: 'REPLACE',
    increment: 'INCR',
    decrement: 'DECR',
    invert: 'INVERT',
    'increment-wrap': 'INCR_WRAP',
    'decrement-wrap': 'DECR_WRAP',
});
const UNIFORMS = new Set([
    '1f',
    '2f',
    '3f',
    '4f',
    '1i',
    '2i',
    '3i',
    '4i',
    '1iv',
    '1fv',
    '2fv',
    '3fv',
    '4fv',
    'matrix3fv',
    'matrix4fv',
]);
const BLENDS = new Set(['source-over', 'straight-alpha', 'copy', 'lighter', 'source-in', 'destination-in']);
const ALL_COLOR = Object.freeze([true, true, true, true]);
function integer(n, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw new RangeError(`${name}: ${min}..${max}`);
    }
}
function finiteArray(value, count, name) {
    if (!value || value.length !== count || !Array.from(value).every(Number.isFinite)) {
        throw new TypeError(`${name} needs ${count} finite numbers`);
    }
}
function normalizeShader(source, fragment) {
    if (/^\s*#version\s+300\s+es\b/.test(source)) {
        return source.trimStart();
    }
    if (/^\s*#version\s+100\b/.test(source)) {
        source = source.replace(/^\s*#version\s+100[^\r\n]*(?:\r?\n|$)/, '');
    } else if (/^\s*#version\b/.test(source)) {
        throw new Error('Only GLSL ES 100 and 300 shaders are supported');
    }
    let converted = source
        .replace(/^\s*#extension\s+GL_OES_standard_derivatives\s*:\s*enable\s*$/gm, '')
        .replace(/\battribute\b/g, 'in')
        .replace(/\bvarying\b/g, fragment ? 'in' : 'out')
        .replace(/\btexture2D\b/g, 'texture')
        .replace(/\btextureCube\b/g, 'texture');
    if (fragment) {
        converted = converted.replace(/\bgl_FragColor\b/g, '_deviceFragColor');
        return `#version 300 es\nprecision mediump float;\nout vec4 _deviceFragColor;\n${converted}`;
    }
    return `#version 300 es\n${converted}`;
}
function compile(gl, type, source) {
    const SHADER = gl.createShader(type);
    if (!SHADER) {
        throw new Error('Shader allocation failed');
    }
    gl.shaderSource(SHADER, normalizeShader(source, type === gl.FRAGMENT_SHADER));
    gl.compileShader(SHADER);
    if (!gl.getShaderParameter(SHADER, gl.COMPILE_STATUS)) {
        const MESSAGE = gl.getShaderInfoLog(SHADER);
        gl.deleteShader(SHADER);
        throw new Error(`Shader compilation failed: ${MESSAGE}`);
    }
    return SHADER;
}

/**
 * Stable resource handles survive context restoration. Streaming buffers are reallocated
 * empty on restore: upload this frame's geometry again. No loop, sorting, art or game state.
 * Shader outputs select explicit premultiplied or straight-alpha blending per draw.
 */
function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export class WebGLDevice {
    constructor(
        canvas,
        {
            alpha = false,
            antialias = true,
            depth = true,
            stencil = true,
            preserveDrawingBuffer = false,
            powerPreference = 'default',
            failIfMajorPerformanceCaveat = false,
            checkGLErrors = false,
            maxTextures = 8,
            maxBufferBytes = 128 * 1024 * 1024,
            textureAtlas = {},
        } = {},
    ) {
        if (!canvas?.getContext || !canvas?.addEventListener) {
            throw new TypeError('canvas required');
        }
        if (!['default', 'low-power', 'high-performance'].includes(powerPreference)) {
            throw new TypeError('Invalid WebGL powerPreference');
        }
        if (typeof failIfMajorPerformanceCaveat !== 'boolean') {
            throw new TypeError('failIfMajorPerformanceCaveat must be boolean');
        }
        if (typeof checkGLErrors !== 'boolean') {
            throw new TypeError('checkGLErrors must be boolean');
        }
        this.checkGLErrors = checkGLErrors;
        this.textureAtlasOptions = { ...textureAtlas };
        this._textureAtlas = null;
        this.batchers = new Set();
        integer(maxTextures, 'maxTextures', 1, 32);
        integer(maxBufferBytes, 'maxBufferBytes', 4);
        this.canvas = canvas;
        this.maxBufferBytes = maxBufferBytes;
        this.requestedMaxTextures = maxTextures;
        this.gl = canvas.getContext('webgl2', {
            alpha,
            antialias,
            depth,
            stencil,
            premultipliedAlpha: true,
            preserveDrawingBuffer,
            powerPreference,
            failIfMajorPerformanceCaveat,
        });
        if (!this.gl) {
            throw new Error('WebGL 2 required');
        }
        this.instancingSupported = true;
        this.floatRenderTargetsSupported = !!this.gl.getExtension('EXT_color_buffer_float');
        this.vertexArray = this.gl.createVertexArray();
        if (!this.vertexArray) {
            throw new Error('Vertex array allocation failed');
        }
        this.maxVertexAttributes = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
        this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
        this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
        this.maxArrayTextureLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS);
        this.depthAvailable = !!this.gl.getContextAttributes().depth;
        this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
        this.state = 'ready';
        this.failure = null;
        this.active = false;
        this.boundTextureCount = 0;
        this.arrayTextureUnits = new Set();
        this.pipelines = new Map();
        this.buffers = new Map();
        this.textures = new Map();
        this.renderTargets = new Map();
        this.renderTargetStack = [];
        this.activeRenderTarget = null;
        this.stats = {
            frame: 0,
            vectorFlushCalls: 0,
            vectorSubmissions: 0,
            spriteRuns: 0,
            pathTessellations: 0,
            pathStrokeBuilds: 0,
            meshCreates: 0,
            drawCalls: 0,
            instancedDrawCalls: 0,
            vertices: 0,
            bufferUploads: 0,
            bufferBytes: 0,
            textureUploads: 0,
            textureBytes: 0,
            imageTexUploadCount: 0,
            regionClears: 0,
            imageTexUploadBytes: 0,
            frameCopies: 0,
            bufferAllocations: 0,
            gpuBufferBytes: 0,
            gpuRenderTargetBytes: 0,
            gpuTextureBytes: 0,
            pipelineCount: 0,
            bufferCount: 0,
            textureCount: 0,
            renderTargetCount: 0,
            restores: 0,
        };
        this.onLost = (event) => {
            event.preventDefault();
            this.active = false;
            this.renderTargetStack.length = 0;
            this.activeRenderTarget = null;
            this.state = 'lost';
        };
        this.onRestored = () => {
            if (this.state === 'disposed') {
                return;
            }
            try {
                this.boundTextureCount = 0;
                this.arrayTextureUnits.clear();
                this.floatRenderTargetsSupported = !!this.gl.getExtension('EXT_color_buffer_float');
                this.maxTextures = Math.min(
                    this.requestedMaxTextures,
                    this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS),
                );
                this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
                this.maxArrayTextureLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS);
                this.maxVertexAttributes = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
                this.depthAvailable = !!this.gl.getContextAttributes().depth;
                this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
                this.vertexArray = this.gl.createVertexArray();
                if (!this.vertexArray) {
                    throw new Error('Vertex array allocation failed');
                }
                for (const RECORD of this.pipelines.values()) {
                    this._pipeline(RECORD);
                }
                for (const RECORD of this.buffers.values()) {
                    RECORD.gpu = this.gl.createBuffer();
                    if (!RECORD.gpu) {
                        throw new Error('Buffer allocation failed');
                    }
                    this.gl.bindBuffer(RECORD.target, RECORD.gpu);
                    this.gl.bufferData(RECORD.target, RECORD.capacity, this.gl.DYNAMIC_DRAW);
                    RECORD.used = 0;
                    this.stats.bufferAllocations++;
                }
                for (const RECORD of this.textures.values()) {
                    RECORD.gpu = null;
                    this._texture(RECORD);
                }
                for (const RECORD of this.renderTargets.values()) {
                    RECORD.framebuffer = null;
                    RECORD.stencilBuffer = null;
                    if (RECORD.format === 'rgba32f' && !this.floatRenderTargetsSupported) {
                        RECORD.available = false;
                        continue;
                    }
                    try {
                        this._renderTarget(RECORD);
                        RECORD.available = true;
                    } catch (error) {
                        if (RECORD.format !== 'rgba32f') {
                            throw error;
                        }
                        RECORD.available = false;
                    }
                }
                this.state = 'ready';
                this.failure = null;
                this.stats.restores++;
            } catch (error) {
                this.state = 'failed';
                this.failure = error.message;
                this._deleteGPU();
            }
        };
        canvas.addEventListener('webglcontextlost', this.onLost);
        canvas.addEventListener('webglcontextrestored', this.onRestored);
    }
    _ready() {
        if (this.state !== 'ready') {
            throw new Error(`WebGLDevice is ${this.state}${this.failure ? `: ${this.failure}` : ''}`);
        }
    }
    get activeStencilAvailable() {
        if (!this.stencilAvailable) {
            return false;
        }
        if (!this.activeRenderTarget) {
            return true;
        }
        return this.renderTargets.get(this.activeRenderTarget)?.stencil === true;
    }
    _handle(map, handle, name) {
        const RECORD = map.get(handle);
        if (!RECORD) {
            throw new Error(`Unknown/deleted ${name}`);
        }
        return RECORD;
    }
    _pipeline(record) {
        const GL = this.gl;
        let vertex;
        let fragment;
        let program;
        try {
            vertex = compile(GL, GL.VERTEX_SHADER, record.vertex);
            fragment = compile(GL, GL.FRAGMENT_SHADER, record.fragment);
            program = GL.createProgram();
            if (!program) {
                throw new Error('Program allocation failed');
            }
            GL.attachShader(program, vertex);
            GL.attachShader(program, fragment);
            GL.linkProgram(program);
            if (!GL.getProgramParameter(program, GL.LINK_STATUS)) {
                throw new Error(`Program link failed: ${GL.getProgramInfoLog(program)}`);
            }
            record.locations = record.attributes.map((attribute) => ({
                ...attribute,
                location: GL.getAttribLocation(program, attribute.name),
            }));
            record.uniformLocations = new Map();
            for (const NAME of Object.keys(record.uniforms)) {
                record.uniformLocations.set(NAME, GL.getUniformLocation(program, NAME));
            }
            record.gpu = program;
        } catch (error) {
            if (program) {
                GL.deleteProgram(program);
            }
            throw error;
        } finally {
            if (vertex) {
                GL.deleteShader(vertex);
            }
            if (fragment) {
                GL.deleteShader(fragment);
            }
        }
    }
    /** Attributes use interleaved FLOAT components and byte offsets in their vertex/instance source. */
    createPipeline({ vertex, fragment, stride, instanceStride = 0, attributes, uniforms = {} }) {
        this._ready();
        if (typeof vertex !== 'string' || typeof fragment !== 'string') {
            throw new TypeError('Shader sources required');
        }
        integer(stride, 'stride', 4, 255);
        if (stride % 4) {
            throw new RangeError('stride must align to FLOAT');
        }
        integer(instanceStride, 'instanceStride', 0, 255);
        if (instanceStride % 4) {
            throw new RangeError('instanceStride must align to FLOAT');
        }
        if (!Array.isArray(attributes) || !attributes.length) {
            throw new TypeError('attributes required');
        }
        const NAMES = new Set();
        for (const A of attributes) {
            if (!A || typeof A.name !== 'string' || !A.name || NAMES.has(A.name)) {
                throw new TypeError('Unique attribute names required');
            }
            NAMES.add(A.name);
            integer(A.size, 'attribute size', 1, 4);
            const SOURCE = A.source ?? 'vertex';
            if (SOURCE !== 'vertex' && SOURCE !== 'instance') {
                throw new TypeError('attribute source must be vertex or instance');
            }
            const SOURCE_STRIDE = SOURCE === 'instance' ? instanceStride : stride;
            if (!SOURCE_STRIDE) {
                throw new RangeError('instance attributes require instanceStride');
            }
            integer(A.offset, 'attribute offset', 0, SOURCE_STRIDE - 4);
            if (A.offset % 4 || A.offset + A.size * 4 > SOURCE_STRIDE) {
                throw new RangeError('attribute outside source stride');
            }
        }
        if (!uniforms || typeof uniforms !== 'object') {
            throw new TypeError('uniform descriptors required');
        }
        for (const TYPE of Object.values(uniforms)) {
            if (!UNIFORMS.has(TYPE)) {
                throw new TypeError(`Unsupported uniform ${TYPE}`);
            }
        }
        const RECORD = {
            vertex,
            fragment,
            stride,
            instanceStride,
            instanced: attributes.some((a) => a.source === 'instance'),
            attributes: attributes.map((a) => ({
                ...a,
                source: a.source ?? 'vertex',
            })),
            uniforms: {
                ...uniforms,
            },
            gpu: null,
        };
        this._pipeline(RECORD);
        const HANDLE = Object.freeze({
            stride,
            instanceStride,
        });
        this.pipelines.set(HANDLE, RECORD);
        this.stats.pipelineCount = this.pipelines.size;
        return HANDLE;
    }
    deletePipeline(handle) {
        const R = this.pipelines.get(handle);
        if (!R) {
            return false;
        }
        this.gl.useProgram(null);
        this.gl.deleteProgram(R.gpu);
        this.pipelines.delete(handle);
        this.stats.pipelineCount = this.pipelines.size;
        return true;
    }
    createVertexBuffer({ capacityBytes = 0 } = {}) {
        this._ready();
        integer(capacityBytes, 'capacityBytes', 0, this.maxBufferBytes);
        if (capacityBytes % 4) {
            throw new RangeError('capacityBytes must align to FLOAT');
        }
        const GL = this.gl,
            GPU = GL.createBuffer();
        if (!GPU) {
            throw new Error('Buffer allocation failed');
        }
        GL.bindBuffer(GL.ARRAY_BUFFER, GPU);
        GL.bufferData(GL.ARRAY_BUFFER, capacityBytes, GL.DYNAMIC_DRAW);
        const HANDLE = Object.freeze({});
        this.buffers.set(HANDLE, {
            gpu: GPU,
            target: GL.ARRAY_BUFFER,
            capacity: capacityBytes,
            used: 0,
        });
        this.stats.bufferAllocations++;
        this.stats.gpuBufferBytes += capacityBytes;
        this.stats.bufferCount = this.buffers.size;
        return HANDLE;
    }
    createIndexBuffer({ capacityBytes = 0 } = {}) {
        this._ready();
        integer(capacityBytes, 'capacityBytes', 0, this.maxBufferBytes);
        if (capacityBytes % 2) {
            throw new RangeError('Index buffer capacity must align to UNSIGNED_SHORT');
        }
        const GL = this.gl,
            GPU = GL.createBuffer();
        if (!GPU) {
            throw new Error('Index buffer allocation failed');
        }
        GL.bindVertexArray(null);
        GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, GPU);
        GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, capacityBytes, GL.DYNAMIC_DRAW);
        const HANDLE = Object.freeze({});
        this.buffers.set(HANDLE, {
            gpu: GPU,
            target: GL.ELEMENT_ARRAY_BUFFER,
            capacity: capacityBytes,
            used: 0,
        });
        this.stats.bufferAllocations++;
        this.stats.gpuBufferBytes += capacityBytes;
        this.stats.bufferCount = this.buffers.size;
        return HANDLE;
    }
    /** View is uploaded synchronously, never copied into another CPU arena or retained. */
    uploadVertices(handle, data) {
        this._ready();
        const R = this._handle(this.buffers, handle, 'buffer');
        if (R.target !== this.gl.ARRAY_BUFFER || !(data instanceof Float32Array)) {
            throw new TypeError('An ARRAY_BUFFER and Float32Array are required');
        }
        if (data.byteLength > this.maxBufferBytes) {
            throw new RangeError('Stream exceeds maxBufferBytes');
        }
        const GL = this.gl;
        GL.bindBuffer(GL.ARRAY_BUFFER, R.gpu);
        if (data.byteLength > R.capacity) {
            let capacity = Math.max(4, R.capacity);
            while (capacity < data.byteLength) {
                capacity = Math.min(this.maxBufferBytes, capacity * 2);
            }
            GL.bufferData(GL.ARRAY_BUFFER, capacity, GL.DYNAMIC_DRAW);
            this.stats.gpuBufferBytes += capacity - R.capacity;
            R.capacity = capacity;
            this.stats.bufferAllocations++;
        }
        if (data.byteLength) {
            GL.bufferSubData(GL.ARRAY_BUFFER, 0, data);
            this.stats.bufferUploads++;
            this.stats.bufferBytes += data.byteLength;
        }
        R.used = data.byteLength;
    }
    uploadIndices(handle, data) {
        this._ready();
        const R = this._handle(this.buffers, handle, 'index buffer');
        if (R.target !== this.gl.ELEMENT_ARRAY_BUFFER || !(data instanceof Uint16Array)) {
            throw new TypeError('An ELEMENT_ARRAY_BUFFER and Uint16Array are required');
        }
        if (data.byteLength > this.maxBufferBytes) {
            throw new RangeError('Index stream exceeds maxBufferBytes');
        }
        const GL = this.gl;
        GL.bindVertexArray(null);
        GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, R.gpu);
        if (data.byteLength > R.capacity) {
            let capacity = Math.max(2, R.capacity);
            while (capacity < data.byteLength) {
                capacity = Math.min(
                    this.maxBufferBytes,
                    this.maxBufferBytes % 2 ? this.maxBufferBytes - 1 : this.maxBufferBytes,
                    capacity * 2,
                );
            }
            GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, capacity, GL.DYNAMIC_DRAW);
            this.stats.gpuBufferBytes += capacity - R.capacity;
            R.capacity = capacity;
            this.stats.bufferAllocations++;
        }
        if (data.byteLength) {
            GL.bufferSubData(GL.ELEMENT_ARRAY_BUFFER, 0, data);
            this.stats.bufferUploads++;
            this.stats.bufferBytes += data.byteLength;
        }
        R.used = data.byteLength;
    }
    deleteVertexBuffer(handle) {
        return this._deleteBuffer(handle, this.gl.ARRAY_BUFFER);
    }
    deleteIndexBuffer(handle) {
        return this._deleteBuffer(handle, this.gl.ELEMENT_ARRAY_BUFFER);
    }
    _deleteBuffer(handle, target) {
        const R = this.buffers.get(handle);
        if (!R) {
            return false;
        }
        if (R.target !== target) {
            throw new TypeError('Buffer target does not match delete operation');
        }
        const GL = this.gl;
        if (target === GL.ARRAY_BUFFER && this.state === 'ready' && this.vertexArray && !GL.isContextLost()) {
            const PREVIOUS_VERTEX_ARRAY = GL.getParameter(GL.VERTEX_ARRAY_BINDING);
            try {
                GL.bindVertexArray(this.vertexArray);
                GL.deleteBuffer(R.gpu);
            } finally {
                GL.bindVertexArray(PREVIOUS_VERTEX_ARRAY);
            }
        } else {
            GL.deleteBuffer(R.gpu);
        }
        this.buffers.delete(handle);
        this.stats.gpuBufferBytes -= R.capacity;
        this.stats.bufferCount = this.buffers.size;
        return true;
    }
    _source(source, format, premultiplied) {
        if (source === this.canvas) {
            throw new TypeError('Use copyFrameToTexture for GPU frame composition, not canvas upload');
        }
        if (typeof premultiplied !== 'boolean') {
            throw new TypeError('premultiplied must be boolean');
        }
        if (Object.prototype.toString.call(source) === '[object ImageBitmap]') {
            throw new TypeError('ImageBitmap alpha mode is not inspectable');
        }
        const WIDTH = source?.naturalWidth ?? source?.width,
            HEIGHT = source?.naturalHeight ?? source?.height;
        integer(WIDTH, 'texture width', 1, this.maxTextureSize);
        integer(HEIGHT, 'texture height', 1, this.maxTextureSize);
        if (format !== 'rgba' && format !== 'luminance') {
            throw new TypeError('texture format must be rgba or luminance');
        }
        let retained = source;
        if (source.data !== undefined) {
            const DATA = source.data,
                COMPONENTS = format === 'rgba' ? 4 : 1;
            if (
                DATA !== null &&
                (!(DATA instanceof Uint8Array || DATA instanceof Uint8ClampedArray) ||
                    DATA.length !== WIDTH * HEIGHT * COMPONENTS)
            ) {
                throw new TypeError('Texture byte count does not match dimensions/format');
            }
            retained = DATA === null ? null : new Uint8Array(DATA);
            if (retained && format === 'rgba' && !premultiplied) {
                for (let i = 0; i < retained.length; i += 4) {
                    const ALPHA = retained[i + 3] / 255;
                    retained[i] = Math.round(retained[i] * ALPHA);
                    retained[i + 1] = Math.round(retained[i + 1] * ALPHA);
                    retained[i + 2] = Math.round(retained[i + 2] * ALPHA);
                }
            }
        } else if (format !== 'rgba' || premultiplied) {
            throw new TypeError('DOM sources require rgba and premultiplied:false');
        }
        return {
            source: retained,
            width: WIDTH,
            height: HEIGHT,
            format,
            premultiplied,
        };
    }
    _texture(record) {
        const GL = this.gl;
        record.gpu = GL.createTexture();
        if (!record.gpu) {
            throw new Error('Texture allocation failed');
        }
        try {
            this._bindTexture(0, record);
            this.boundTextureCount = Math.max(1, this.boundTextureCount);
            this._resetUnpackState();
            if (record.target === 'array') {
                GL.texStorage3D(GL.TEXTURE_2D_ARRAY, 1, GL.RGBA8, record.width, record.height, record.layers);
                for (let layer = 0; layer < record.layers; layer++) {
                    this._uploadLayer(record, layer);
                }
            } else {
                const PIXELS =
                        record.source === null ||
                        record.source instanceof Uint8Array ||
                        record.source instanceof Float32Array,
                    FORMAT =
                        record.copyFormat === 'rgb'
                            ? GL.RGB
                            : record.format === 'rgba' || record.format === 'rgba32f'
                              ? GL.RGBA
                              : GL.LUMINANCE,
                    INTERNAL =
                        record.copyFormat === 'rgb'
                            ? GL.RGB8
                            : record.format === 'rgba32f'
                              ? GL.RGBA32F
                              : record.format === 'rgba'
                                ? GL.RGBA8
                                : GL.LUMINANCE,
                    TYPE = record.format === 'rgba32f' ? GL.FLOAT : GL.UNSIGNED_BYTE;
                GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !PIXELS);
                if (PIXELS) {
                    GL.texImage2D(
                        GL.TEXTURE_2D,
                        0,
                        INTERNAL,
                        record.width,
                        record.height,
                        0,
                        FORMAT,
                        TYPE,
                        record.source,
                    );
                } else {
                    GL.texImage2D(GL.TEXTURE_2D, 0, INTERNAL, FORMAT, TYPE, record.source);
                }
            }
            this._filter(record.filter, record);
            GL.texParameteri(this._glTarget(record), GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
            GL.texParameteri(this._glTarget(record), GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`Texture upload error ${ERROR}`);
            }
            this.stats.textureUploads++;
            this.stats.textureBytes += this._textureBytes(record);
            if (record.kind === 'image' && record.source !== null) {
                this.stats.imageTexUploadCount++;
                this.stats.imageTexUploadBytes += this._textureBytes(record);
            }
        } catch (error) {
            GL.deleteTexture(record.gpu);
            record.gpu = null;
            throw error;
        }
    }
    /** WebGL binding point of a texture record; the record's target is the only place that decides it. */
    _glTarget(record) {
        return record.target === 'array' ? this.gl.TEXTURE_2D_ARRAY : this.gl.TEXTURE_2D;
    }
    /** Binds a record to a texture unit; leaves that unit active. */
    _bindTexture(unit, record) {
        const GL = this.gl;
        GL.activeTexture(GL.TEXTURE0 + unit);
        GL.bindTexture(this._glTarget(record), record.gpu);
        if (record.target === 'array') {
            this.arrayTextureUnits.add(unit);
        }
    }
    /** Pixel-unpack state every CPU upload assumes; premultiply is set per upload. */
    _resetUnpackState() {
        const GL = this.gl;
        GL.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null);
        GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
        GL.pixelStorei(GL.UNPACK_ROW_LENGTH, 0);
        GL.pixelStorei(GL.UNPACK_SKIP_PIXELS, 0);
        GL.pixelStorei(GL.UNPACK_SKIP_ROWS, 0);
        GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
        GL.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, GL.NONE);
    }
    /** Clears the 2D binding point, and the array binding point only if this device bound an array to the unit. */
    _unbindTextureUnit(unit) {
        const GL = this.gl;
        GL.activeTexture(GL.TEXTURE0 + unit);
        GL.bindTexture(GL.TEXTURE_2D, null);
        if (this.arrayTextureUnits.delete(unit)) {
            GL.bindTexture(GL.TEXTURE_2D_ARRAY, null);
        }
    }
    /** Uploads one retained layer of the array bound to the active unit; empty layers stay transparent. */
    _uploadLayer(record, layer) {
        for (const REGION of record.layerRegions[layer]) {
            this._uploadRegion(layer, REGION);
        }
        const GL = this.gl,
            LAYER = record.layerSources[layer];
        if (LAYER === null) {
            return;
        }
        // DOM sources are premultiplied by the browser on upload; byte planes already carry their alpha form.
        GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(LAYER.source instanceof Uint8Array));
        GL.texSubImage3D(
            GL.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            layer,
            record.width,
            record.height,
            1,
            GL.RGBA,
            GL.UNSIGNED_BYTE,
            LAYER.source,
        );
        this.stats.textureUploads++;
        this.stats.textureBytes += record.width * record.height * 4;
        this.stats.imageTexUploadCount++;
        this.stats.imageTexUploadBytes += record.width * record.height * 4;
    }
    /** Uploads one retained rectangle of the array bound to the active unit. */
    _uploadRegion(layer, region) {
        const GL = this.gl;
        GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(region.source instanceof Uint8Array));
        GL.texSubImage3D(
            GL.TEXTURE_2D_ARRAY,
            0,
            region.x,
            region.y,
            layer,
            region.width,
            region.height,
            1,
            GL.RGBA,
            GL.UNSIGNED_BYTE,
            region.source,
        );
        this.stats.textureUploads++;
        this.stats.textureBytes += region.width * region.height * 4;
        this.stats.imageTexUploadCount++;
        this.stats.imageTexUploadBytes += region.width * region.height * 4;
    }
    _textureBytes(record) {
        return (
            record.width *
            record.height *
            (record.layers ?? 1) *
            (record.copyFormat === 'rgb' ? 3 : record.format === 'rgba32f' ? 16 : record.format === 'rgba' ? 4 : 1)
        );
    }
    _filter(filter, record) {
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('filter must be nearest or linear');
        }
        const GL = this.gl,
            TARGET = this._glTarget(record),
            VALUE = filter === 'nearest' ? GL.NEAREST : GL.LINEAR;
        GL.texParameteri(TARGET, GL.TEXTURE_MIN_FILTER, VALUE);
        GL.texParameteri(TARGET, GL.TEXTURE_MAG_FILTER, VALUE);
    }
    _renderTarget(record) {
        const GL = this.gl,
            PREVIOUS = GL.getParameter(GL.FRAMEBUFFER_BINDING),
            PREVIOUS_RENDERBUFFER = GL.getParameter(GL.RENDERBUFFER_BINDING),
            FRAMEBUFFER_LOCAL = GL.createFramebuffer();
        let stencilBuffer = null;
        if (!FRAMEBUFFER_LOCAL) {
            throw new Error('Render target framebuffer allocation failed');
        }
        try {
            GL.bindFramebuffer(GL.FRAMEBUFFER, FRAMEBUFFER_LOCAL);
            if (record.arrayRecord) {
                GL.framebufferTextureLayer(
                    GL.FRAMEBUFFER,
                    GL.COLOR_ATTACHMENT0,
                    record.arrayRecord.gpu,
                    0,
                    record.layer,
                );
            } else {
                GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, record.gpu, 0);
            }
            if (record.stencil) {
                stencilBuffer = GL.createRenderbuffer();
                if (!stencilBuffer) {
                    throw new Error('Render target stencil allocation failed');
                }
                GL.bindRenderbuffer(GL.RENDERBUFFER, stencilBuffer);
                GL.renderbufferStorage(GL.RENDERBUFFER, GL.STENCIL_INDEX8, record.width, record.height);
                GL.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.STENCIL_ATTACHMENT, GL.RENDERBUFFER, stencilBuffer);
            }
            const STATUS = GL.checkFramebufferStatus(GL.FRAMEBUFFER);
            if (STATUS !== GL.FRAMEBUFFER_COMPLETE) {
                throw new Error(`Render target framebuffer incomplete: ${STATUS}`);
            }
            record.framebuffer = FRAMEBUFFER_LOCAL;
            record.stencilBuffer = stencilBuffer;
        } catch (error) {
            GL.deleteFramebuffer(FRAMEBUFFER_LOCAL);
            if (stencilBuffer) {
                GL.deleteRenderbuffer(stencilBuffer);
            }
            throw error;
        } finally {
            GL.bindFramebuffer(GL.FRAMEBUFFER, PREVIOUS);
            GL.bindRenderbuffer(GL.RENDERBUFFER, PREVIOUS_RENDERBUFFER);
        }
    }
    /** Creates a reusable RGBA texture/FBO pair; the handle is also a draw texture. */
    createRenderTarget(width, height, { format = 'rgba', filter, stencil = false } = {}) {
        this._ready();
        integer(width, 'render target width', 1, this.maxTextureSize);
        integer(height, 'render target height', 1, this.maxTextureSize);
        filter = filter ?? (format === 'rgba32f' ? 'nearest' : 'linear');
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('filter must be nearest or linear');
        }
        if (typeof stencil !== 'boolean') {
            throw new TypeError('stencil must be boolean');
        }
        if (stencil && !this.stencilAvailable) {
            throw new Error('Context has no stencil buffer');
        }
        if (format !== 'rgba' && format !== 'rgba32f') {
            throw new TypeError('render target format must be rgba or rgba32f');
        }
        if (format === 'rgba32f' && !this.floatRenderTargetsSupported) {
            throw new Error('EXT_color_buffer_float required for RGBA32F render targets');
        }
        const RECORD = {
            kind: 'renderTarget',
            width,
            height,
            format,
            premultiplied: true,
            source: null,
            filter,
            stencil,
            gpu: null,
            framebuffer: null,
            stencilBuffer: null,
            available: true,
        };
        this._texture(RECORD);
        try {
            this._renderTarget(RECORD);
        } catch (error) {
            this.gl.deleteTexture(RECORD.gpu);
            RECORD.gpu = null;
            throw error;
        }
        const HANDLE = Object.freeze({
            width,
            height,
            stencil,
        });
        this.textures.set(HANDLE, RECORD);
        this.renderTargets.set(HANDLE, RECORD);
        this.stats.textureCount = this.textures.size;
        this.stats.renderTargetCount = this.renderTargets.size;
        this.stats.gpuTextureBytes += this._textureBytes(RECORD);
        this.stats.gpuRenderTargetBytes +=
            width * height * (format === 'rgba32f' ? 16 : 4) + width * height * (stencil ? 1 : 0);
        return HANDLE;
    }
    /**
     * Renders into one layer of a texture array. The handle works with bind/unbindRenderTarget but is not a draw
     * texture: draw the array and select the layer. Contents are empty after context restoration, so the producer
     * repaints them. The array stays owned by the caller and must outlive the target.
     */
    createTextureLayerTarget(array, layer) {
        this._ready();
        const ARRAY = this._handle(this.textures, array, 'texture array');
        if (ARRAY.target !== 'array') {
            throw new TypeError('A texture array is required');
        }
        integer(layer, 'layer', 0, ARRAY.layers - 1);
        const RECORD = {
            kind: 'renderTarget',
            arrayRecord: ARRAY,
            layer,
            width: ARRAY.width,
            height: ARRAY.height,
            format: 'rgba',
            premultiplied: true,
            stencil: false,
            framebuffer: null,
            stencilBuffer: null,
            available: true,
        };
        this._renderTarget(RECORD);
        const HANDLE = Object.freeze({ width: ARRAY.width, height: ARRAY.height, layer });
        this.renderTargets.set(HANDLE, RECORD);
        this.stats.renderTargetCount = this.renderTargets.size;
        return HANDLE;
    }
    /**
     * Copies `source` into the rectangle (x, y, width, height) of `target`, measured from the target's bottom-left,
     * with linear filtering when the sizes differ. A 2:1 copy averages exactly each 2x2 texel footprint.
     */
    blitRenderTarget(source, target, { x = 0, y = 0, width = target.width, height = target.height } = {}) {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        const FROM = this._handle(this.renderTargets, source, 'render target'),
            TO = this._handle(this.renderTargets, target, 'render target');
        integer(x, 'blit x', 0, TO.width - 1);
        integer(y, 'blit y', 0, TO.height - 1);
        integer(width, 'blit width', 1, TO.width - x);
        integer(height, 'blit height', 1, TO.height - y);
        if (!FROM.available || !TO.available || FROM === TO) {
            throw new Error('Blit needs two distinct available render targets');
        }
        const GL = this.gl,
            PREVIOUS = GL.getParameter(GL.FRAMEBUFFER_BINDING);
        GL.bindFramebuffer(GL.READ_FRAMEBUFFER, FROM.framebuffer);
        GL.bindFramebuffer(GL.DRAW_FRAMEBUFFER, TO.framebuffer);
        GL.blitFramebuffer(
            0,
            0,
            FROM.width,
            FROM.height,
            x,
            y,
            x + width,
            y + height,
            GL.COLOR_BUFFER_BIT,
            width === FROM.width && height === FROM.height ? GL.NEAREST : GL.LINEAR,
        );
        GL.bindFramebuffer(GL.FRAMEBUFFER, PREVIOUS);
    }
    /** Float targets can become unavailable after restore while ordinary rendering stays ready. */
    isRenderTargetAvailable(handle) {
        const R = this._handle(this.renderTargets, handle, 'render target');
        return this.state === 'ready' && R.available === true;
    }
    /** Binds a target inside an active frame. Bindings may nest and must unwind in LIFO order. */
    bindRenderTarget(handle) {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        const RECORD = this._handle(this.renderTargets, handle, 'render target');
        if (!RECORD.available) {
            throw new Error('Render target is unavailable after context restoration');
        }
        if (this.activeRenderTarget === handle || this.renderTargetStack.some((entry) => entry.handle === handle)) {
            throw new Error('Render target is already bound');
        }
        const GL = this.gl;
        this.renderTargetStack.push({
            handle: this.activeRenderTarget,
            framebuffer: GL.getParameter(GL.FRAMEBUFFER_BINDING),
            viewport: GL.getParameter(GL.VIEWPORT),
        });
        GL.bindFramebuffer(GL.FRAMEBUFFER, RECORD.framebuffer);
        GL.viewport(0, 0, RECORD.width, RECORD.height);
        this.activeRenderTarget = handle;
        return handle;
    }
    /** Completes the target pass and restores the previous framebuffer and viewport. */
    unbindRenderTarget(handle) {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        if (!this.renderTargetStack.length) {
            throw new Error('No render target is bound');
        }
        if (handle !== undefined && handle !== this.activeRenderTarget) {
            throw new Error('Render targets must be unbound in LIFO order');
        }
        const PREVIOUS = this.renderTargetStack.pop(),
            GL = this.gl;
        GL.bindFramebuffer(GL.FRAMEBUFFER, PREVIOUS.framebuffer);
        GL.viewport(...PREVIOUS.viewport);
        this.activeRenderTarget = PREVIOUS.handle;
        return this.activeRenderTarget;
    }
    deleteRenderTarget(handle) {
        const RECORD = this.renderTargets.get(handle);
        if (!RECORD) {
            return false;
        }
        if (this.renderTargetStack.some((entry) => entry.handle === handle) || this.activeRenderTarget === handle) {
            throw new Error('Cannot delete a bound render target');
        }
        this.gl.deleteFramebuffer(RECORD.framebuffer);
        if (RECORD.arrayRecord) {
            // A layer view owns only its framebuffer; the array texture and its bytes belong to the caller.
            this.renderTargets.delete(handle);
            this.stats.renderTargetCount = this.renderTargets.size;
            return true;
        }
        if (RECORD.stencilBuffer) {
            this.gl.deleteRenderbuffer(RECORD.stencilBuffer);
        }
        this.gl.deleteTexture(RECORD.gpu);
        this.renderTargets.delete(handle);
        this.textures.delete(handle);
        this.stats.textureCount = this.textures.size;
        this.stats.renderTargetCount = this.renderTargets.size;
        this.stats.gpuTextureBytes -= this._textureBytes(RECORD);
        this.stats.gpuRenderTargetBytes -=
            RECORD.width * RECORD.height * (RECORD.format === 'rgba32f' ? 16 : 4) +
            RECORD.width * RECORD.height * (RECORD.stencil ? 1 : 0);
        return true;
    }
    createTexture(source, { format = 'rgba', premultiplied = false, filter = 'linear' } = {}) {
        this._ready();
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('Invalid filter');
        }
        const RECORD = {
            ...this._source(source, format, premultiplied),
            kind: 'image',
            filter,
            gpu: null,
        };
        this._texture(RECORD);
        const HANDLE = Object.freeze({
            width: RECORD.width,
            height: RECORD.height,
        });
        this.textures.set(HANDLE, RECORD);
        this.stats.textureCount = this.textures.size;
        this.stats.gpuTextureBytes += this._textureBytes(RECORD);
        return HANDLE;
    }
    /**
     * One TEXTURE_2D_ARRAY of equally sized RGBA layers, bound as a single sampler2DArray. Every layer is allocated
     * up front, so memory is width * height * 4 * layers regardless of how much of each layer an atlas fills;
     * unused layers and unused layer area stay transparent.
     */
    createTextureArray(width, height, layers, { filter = 'linear' } = {}) {
        this._ready();
        integer(width, 'texture array width', 1, this.maxTextureSize);
        integer(height, 'texture array height', 1, this.maxTextureSize);
        integer(layers, 'texture array layers', 1, this.maxArrayTextureLayers);
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('Invalid filter');
        }
        const RECORD = {
            kind: 'imageArray',
            target: 'array',
            width,
            height,
            layers,
            layerSources: new Array(layers).fill(null),
            layerRegions: Array.from({ length: layers }, () => []),
            format: 'rgba',
            premultiplied: true,
            source: null,
            filter,
            gpu: null,
        };
        this._texture(RECORD);
        const HANDLE = Object.freeze({ width, height, layers });
        this.textures.set(HANDLE, RECORD);
        this.stats.textureCount = this.textures.size;
        this.stats.gpuTextureBytes += this._textureBytes(RECORD);
        return HANDLE;
    }
    /** Replaces one whole layer; the source must have the array's width and height. */
    updateTextureLayer(handle, layer, source, { premultiplied = false } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture array');
        if (R.target !== 'array') {
            throw new TypeError('A texture array is required');
        }
        integer(layer, 'layer', 0, R.layers - 1);
        const NEXT = this._source(source, 'rgba', premultiplied);
        if (NEXT.width !== R.width || NEXT.height !== R.height || NEXT.source === null) {
            throw new RangeError('Layer source must supply every pixel at the array width and height');
        }
        const PREVIOUS = R.layerSources[layer];
        R.layerSources[layer] = NEXT;
        try {
            this._bindTexture(0, R);
            this.boundTextureCount = Math.max(1, this.boundTextureCount);
            this._resetUnpackState();
            this._uploadLayer(R, layer);
            if (this.checkGLErrors) {
                const ERROR = this.gl.getError();
                if (ERROR !== this.gl.NO_ERROR) {
                    throw new Error(`Texture layer upload error ${ERROR}`);
                }
            }
        } catch (error) {
            R.layerSources[layer] = PREVIOUS;
            throw error;
        }
    }
    /**
     * Writes a rectangle inside one layer without touching the rest, so many small images (glyph pages, gradient
     * ramps, a 1x1 white texel) share a layer. The source is retained and replayed after context restoration; a
     * rectangle replaces any retained rectangle it overlaps.
     */
    updateTextureRegion(handle, layer, x, y, source, { premultiplied = false } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture array');
        if (R.target !== 'array') {
            throw new TypeError('A texture array is required');
        }
        integer(layer, 'layer', 0, R.layers - 1);
        integer(x, 'region x', 0, R.width - 1);
        integer(y, 'region y', 0, R.height - 1);
        const NEXT = this._source(source, 'rgba', premultiplied);
        if (NEXT.source === null || x + NEXT.width > R.width || y + NEXT.height > R.height) {
            throw new RangeError('Region must be fully supplied and inside the layer');
        }
        const REGION = { x, y, width: NEXT.width, height: NEXT.height, source: NEXT.source },
            PREVIOUS = R.layerRegions[layer];
        R.layerRegions[layer] = [...PREVIOUS.filter((r) => !overlaps(r, REGION)), REGION];
        try {
            this._bindTexture(0, R);
            this.boundTextureCount = Math.max(1, this.boundTextureCount);
            this._resetUnpackState();
            this._uploadRegion(layer, REGION);
            if (this.checkGLErrors) {
                const ERROR = this.gl.getError();
                if (ERROR !== this.gl.NO_ERROR) {
                    throw new Error(`Texture region upload error ${ERROR}`);
                }
            }
        } catch (error) {
            R.layerRegions[layer] = PREVIOUS;
            throw error;
        }
    }
    /** Forgets a retained rectangle and makes its pixels transparent so a later owner starts clean. */
    clearTextureRegion(handle, layer, x, y, width, height) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture array');
        if (R.target !== 'array') {
            throw new TypeError('A texture array is required');
        }
        integer(layer, 'layer', 0, R.layers - 1);
        integer(width, 'region width', 1, R.width);
        integer(height, 'region height', 1, R.height);
        // Zeroing a released rectangle is maintenance, not an image upload: it is counted as a clear.
        const IMAGE_UPLOADS = this.stats.imageTexUploadCount,
            IMAGE_BYTES = this.stats.imageTexUploadBytes;
        this.updateTextureRegion(
            handle,
            layer,
            x,
            y,
            { width, height, data: new Uint8Array(width * height * 4) },
            { premultiplied: true },
        );
        this.stats.imageTexUploadCount = IMAGE_UPLOADS;
        this.stats.imageTexUploadBytes = IMAGE_BYTES;
        this.stats.regionClears++;
        R.layerRegions[layer] = R.layerRegions[layer].filter(
            (r) => !(r.x === x && r.y === y && r.width === width && r.height === height),
        );
    }
    /**
     * A renderer that queues draws registers its flush here, so a shared GPU resource that is about to change
     * (pose rows, data textures) first submits everything already queued against its old contents.
     * Returns the function that unregisters it.
     */
    registerBatcher(flush) {
        if (typeof flush !== 'function') {
            throw new TypeError('A flush function is required');
        }
        this.batchers.add(flush);
        return () => this.batchers.delete(flush);
    }
    flushBatchers(reason) {
        for (const FLUSH of this.batchers) {
            FLUSH(reason);
        }
    }
    /**
     * The device's shared image atlas (SSOT): vector fills, gradients and glyphs allocate regions here, so every
     * vector draw samples one TEXTURE_2D_ARRAY. Created on first use from the `textureAtlas` device option.
     */
    get textureAtlas() {
        this._ready();
        this._textureAtlas ??= new TextureAtlasArray(this, this.textureAtlasOptions);
        return this._textureAtlas;
    }
    /** Called by the atlas when it is disposed: deletes its array and lets the next user create a fresh atlas. */
    textureAtlasDisposed(atlas) {
        if (this._textureAtlas === atlas) {
            this._textureAtlas = null;
        }
        if (this.state === 'ready' && this.textures.has(atlas.texture)) {
            this.deleteTexture(atlas.texture);
        }
    }
    isTextureArray(handle) {
        return this._handle(this.textures, handle, 'texture').target === 'array';
    }
    /** Retained RGBA32F pixels; usable for sampling without float render-target support. */
    createDataTexture(width, height, { data = null } = {}) {
        this._ready();
        integer(width, 'data texture width', 1, this.maxTextureSize);
        integer(height, 'data texture height', 1, this.maxTextureSize);
        if (data !== null && (!(data instanceof Float32Array) || data.length !== width * height * 4)) {
            throw new TypeError('RGBA32F data must match the texture dimensions');
        }
        const RECORD = {
            kind: 'numeric',
            width,
            height,
            format: 'rgba32f',
            premultiplied: false,
            source: data === null ? new Float32Array(width * height * 4) : new Float32Array(data),
            filter: 'nearest',
            gpu: null,
        };
        this._texture(RECORD);
        const HANDLE = Object.freeze({ width, height });
        this.textures.set(HANDLE, RECORD);
        this.stats.textureCount = this.textures.size;
        this.stats.gpuTextureBytes += this._textureBytes(RECORD);
        return HANDLE;
    }
    /** Updates a packed subregion and retains the full pixel plane for context restoration. */
    updateDataTexture(handle, data, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'data texture');
        if (R.format !== 'rgba32f' || this.renderTargets.has(handle)) {
            throw new TypeError('A CPU-owned RGBA32F data texture is required');
        }
        integer(x, 'x');
        integer(y, 'y');
        integer(width, 'width', 1);
        integer(height, 'height', 1);
        if (x + width > R.width || y + height > R.height) {
            throw new RangeError('Data texture region outside bounds');
        }
        if (!(data instanceof Float32Array) || data.length !== width * height * 4) {
            throw new TypeError('RGBA32F region data must match dimensions');
        }
        const GL = this.gl;
        this._bindTexture(0, R);
        GL.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null);
        this.boundTextureCount = Math.max(1, this.boundTextureCount);
        GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
        GL.pixelStorei(GL.UNPACK_ROW_LENGTH, 0);
        GL.pixelStorei(GL.UNPACK_SKIP_PIXELS, 0);
        GL.pixelStorei(GL.UNPACK_SKIP_ROWS, 0);
        GL.texSubImage2D(GL.TEXTURE_2D, 0, x, y, width, height, GL.RGBA, GL.FLOAT, data);
        if (this.checkGLErrors) {
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`Data texture update error ${ERROR}`);
            }
        }
        for (let row = 0; row < height; row++) {
            R.source.set(data.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * R.width + x) * 4);
        }
        this.stats.textureUploads++;
        this.stats.textureBytes += data.byteLength;
    }
    /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
    updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture');
        if (this.renderTargets.has(handle)) {
            throw new Error('Render targets cannot be updated from CPU pixels');
        }
        if (R.format === 'rgba32f') {
            throw new TypeError('Use updateDataTexture for RGBA32F pixels');
        }
        if (R.target === 'array') {
            throw new TypeError('Use updateTextureLayer for texture arrays');
        }
        integer(x, 'x');
        integer(y, 'y');
        integer(width, 'width', 1);
        integer(height, 'height', 1);
        if (x + width > R.width || y + height > R.height) {
            throw new RangeError('Texture region outside bounds');
        }
        const NEXT = this._source(source, R.format, R.premultiplied);
        if (NEXT.width !== R.width || NEXT.height !== R.height || NEXT.source === null) {
            throw new RangeError('Update requires matching full source');
        }
        if (R.copyFormat) {
            const REPLACEMENT = { ...NEXT, kind: R.kind, filter: R.filter, gpu: null };
            this._texture(REPLACEMENT);
            this.gl.deleteTexture(R.gpu);
            this.stats.gpuTextureBytes += this._textureBytes(REPLACEMENT) - this._textureBytes(R);
            Object.assign(R, REPLACEMENT);
            delete R.copyFormat;
            return;
        }
        const GL = this.gl,
            FORMAT = R.format === 'rgba' ? GL.RGBA : GL.LUMINANCE;
        let pixels = NEXT.source;
        if (pixels instanceof Uint8Array) {
            const COMPONENTS = R.format === 'rgba' ? 4 : 1;
            if (x || y || width !== R.width || height !== R.height) {
                const NEEDED = width * height * COMPONENTS;
                if (!this.regionBytes || this.regionBytes.length !== NEEDED) {
                    this.regionBytes = new Uint8Array(NEEDED);
                }
                for (let row = 0; row < height; row++) {
                    const START = ((y + row) * R.width + x) * COMPONENTS;
                    this.regionBytes.set(pixels.subarray(START, START + width * COMPONENTS), row * width * COMPONENTS);
                }
                pixels = this.regionBytes;
            }
            GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        } else {
            if (x || y || width !== R.width || height !== R.height) {
                if (!this.regionCanvas) {
                    const DOC = this.canvas.ownerDocument;
                    if (!DOC?.createElement) {
                        throw new Error('DOM region uploads require canvas.ownerDocument');
                    }
                    this.regionCanvas = DOC.createElement('canvas');
                    this.regionContext = this.regionCanvas.getContext('2d');
                    if (!this.regionContext) {
                        throw new Error('Asset-region Canvas2D unavailable');
                    }
                }
                const C = this.regionCanvas,
                    Q = this.regionContext;
                if (C.width !== width || C.height !== height) {
                    C.width = width;
                    C.height = height;
                } else {
                    Q.clearRect(0, 0, width, height);
                }
                Q.drawImage(NEXT.source, x, y, width, height, 0, 0, width, height);
                pixels = C;
            }
            GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        }
        this._bindTexture(0, R);
        GL.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null);
        this.boundTextureCount = Math.max(1, this.boundTextureCount);
        GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
        if (pixels instanceof Uint8Array) {
            GL.texSubImage2D(GL.TEXTURE_2D, 0, x, y, width, height, FORMAT, GL.UNSIGNED_BYTE, pixels);
        } else {
            GL.texSubImage2D(GL.TEXTURE_2D, 0, x, y, FORMAT, GL.UNSIGNED_BYTE, pixels);
        }
        if (this.checkGLErrors) {
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`Texture update error ${ERROR}`);
            }
        }
        R.source = NEXT.source;
        this.stats.textureUploads++;
        this.stats.textureBytes += width * height * (R.format === 'rgba' ? 4 : 1);
        if (R.kind === 'image') {
            this.stats.imageTexUploadCount++;
            this.stats.imageTexUploadBytes += width * height * (R.format === 'rgba' ? 4 : 1);
        }
    }
    /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
    copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture');
        if (this.renderTargets.has(handle)) {
            throw new Error('Render targets cannot be copied from the default framebuffer');
        }
        if (R.target === 'array') {
            throw new TypeError('Texture arrays cannot receive a framebuffer copy');
        }
        integer(x, 'x');
        integer(y, 'y');
        if (R.format !== 'rgba' || x + R.width > this.canvas.width || y + R.height > this.canvas.height) {
            throw new RangeError('Framebuffer copy outside bounds');
        }
        const GL = this.gl;
        this._bindTexture(0, R);
        this.boundTextureCount = Math.max(1, this.boundTextureCount);
        let allocated = false;
        if (!GL.getContextAttributes().alpha && R.copyFormat !== 'rgb') {
            GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGB8, R.width, R.height, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
            R.copyFormat = 'rgb';
            allocated = true;
            this.stats.gpuTextureBytes -= R.width * R.height;
            this.stats.textureUploads++;
            this.stats.textureBytes += R.width * R.height * 3;
        }
        GL.copyTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, x, y, R.width, R.height);
        if (allocated || this.checkGLErrors) {
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`Framebuffer copy error ${ERROR}`);
            }
        }
        R.source = null;
        this.stats.frameCopies++;
    }
    deleteTexture(handle) {
        const R = this.textures.get(handle);
        if (!R) {
            return false;
        }
        if (this.renderTargets.has(handle)) {
            throw new Error('Use deleteRenderTarget for render targets');
        }
        if (R.target === 'array' && [...this.renderTargets.values()].some((target) => target.arrayRecord === R)) {
            throw new Error('Delete the texture array layer targets first');
        }
        this.gl.deleteTexture(R.gpu);
        this.textures.delete(handle);
        this.stats.gpuTextureBytes -= this._textureBytes(R);
        this.stats.textureCount = this.textures.size;
        return true;
    }
    beginFrame({
        width = this.canvas.width,
        height = this.canvas.height,
        clearColor = [0, 0, 0, 0],
        clearDepth = 1,
        clearStencil = 0,
    } = {}) {
        if (this.state === 'lost') {
            return false;
        }
        this._ready();
        if (this.active) {
            throw new Error('endFrame required');
        }
        integer(width, 'width', 1);
        integer(height, 'height', 1);
        const GL = this.gl,
            LIMIT = GL.getParameter(GL.MAX_VIEWPORT_DIMS);
        if (width > LIMIT[0] || height > LIMIT[1]) {
            throw new RangeError('Viewport exceeds WebGL limit');
        }
        if (this.canvas.width !== width) {
            this.canvas.width = width;
        }
        if (this.canvas.height !== height) {
            this.canvas.height = height;
        }
        GL.bindFramebuffer(GL.FRAMEBUFFER, null);
        GL.viewport(0, 0, width, height);
        this.renderTargetStack.length = 0;
        this.activeRenderTarget = null;
        this.stats.frame++;
        for (const NAME of [
            'vectorFlushCalls',
            'vectorSubmissions',
            'spriteRuns',
            'pathTessellations',
            'pathStrokeBuilds',
            'meshCreates',
            'drawCalls',
            'instancedDrawCalls',
            'vertices',
            'bufferUploads',
            'bufferBytes',
            'textureUploads',
            'textureBytes',
            'frameCopies',
        ]) {
            this.stats[NAME] = 0;
        }
        this.active = true;
        this.clear({
            color: clearColor,
            depth: clearDepth,
            stencil: clearStencil,
        });
        return true;
    }
    clear({ color, depth, stencil } = {}) {
        this._ready();
        const GL = this.gl;
        let flags = 0;
        if (color !== undefined) {
            finiteArray(color, 4, 'clear color');
            GL.colorMask(true, true, true, true);
            GL.clearColor(...color);
            flags |= GL.COLOR_BUFFER_BIT;
        }
        if (depth !== undefined) {
            if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
                throw new RangeError('clear depth 0..1');
            }
            GL.depthMask(true);
            GL.clearDepth(depth);
            flags |= GL.DEPTH_BUFFER_BIT;
        }
        if (stencil !== undefined) {
            integer(stencil, 'clear stencil', 0, 255);
            GL.stencilMask(255);
            GL.clearStencil(stencil);
            flags |= GL.STENCIL_BUFFER_BIT;
        }
        GL.disable(GL.SCISSOR_TEST);
        GL.clear(flags);
    }
    /** Full pass state is explicit per draw; no state leakage between game materials. */
    draw({
        pipeline,
        buffer,
        indexBuffer,
        instanceBuffer,
        instances = 1,
        first = 0,
        count,
        uniforms = {},
        textures = [],
        blend = 'source-over',
        depth = false,
        stencil = false,
        colorMask = ALL_COLOR,
        filter,
    } = {}) {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        const P = this._handle(this.pipelines, pipeline, 'pipeline'),
            B = this._handle(this.buffers, buffer, 'buffer');
        if (B.target !== this.gl.ARRAY_BUFFER) {
            throw new TypeError('A vertex buffer is required');
        }
        integer(first, 'first');
        integer(count, 'count');
        const ELEMENTS =
            indexBuffer === undefined || indexBuffer === null
                ? null
                : this._handle(this.buffers, indexBuffer, 'index buffer');
        if (ELEMENTS) {
            if (
                ELEMENTS.target !== this.gl.ELEMENT_ARRAY_BUFFER ||
                ELEMENTS.used % 2 ||
                first + count > ELEMENTS.used / 2
            ) {
                throw new RangeError('draw exceeds uploaded indices');
            }
        } else if (first + count > B.used / P.stride) {
            throw new RangeError('draw exceeds uploaded vertices');
        }
        integer(instances, 'instances', 1);
        let instanceRecord;
        if (P.instanced) {
            instanceRecord = this._handle(this.buffers, instanceBuffer, 'instance buffer');
            if (instanceRecord.target !== this.gl.ARRAY_BUFFER) {
                throw new TypeError('An instance vertex buffer is required');
            }
            if (instances > instanceRecord.used / P.instanceStride) {
                throw new RangeError('draw exceeds uploaded instances');
            }
        } else if (instances !== 1) {
            throw new RangeError('Multiple instances require instance attributes');
        }
        if (!Number.isSafeInteger(count * instances)) {
            throw new RangeError('draw vertex count exceeds safe integer range');
        }
        const DEPTH_STATE =
            depth === false || depth == null
                ? null
                : depth === true
                  ? {
                        test: true,
                        write: true,
                        func: 'lequal',
                    }
                  : typeof depth === 'object' && !Array.isArray(depth)
                    ? {
                          test: depth.test ?? true,
                          write: depth.write ?? true,
                          func: depth.func ?? 'lequal',
                      }
                    : (() => {
                          throw new TypeError('depth must be false or a depth policy object');
                      })();
        if (DEPTH_STATE && (typeof DEPTH_STATE.test !== 'boolean' || typeof DEPTH_STATE.write !== 'boolean')) {
            throw new TypeError('depth.test and depth.write must be booleans');
        }
        if ((DEPTH_STATE?.test || DEPTH_STATE?.write) && !this.depthAvailable) {
            throw new Error('Context has no depth buffer');
        }
        if (stencil && !this.activeStencilAvailable) {
            throw new Error('The active framebuffer has no stencil attachment');
        }
        if (blend !== false && !BLENDS.has(blend)) {
            throw new TypeError('Unsupported blend');
        }
        if (DEPTH_STATE && !FUNCTIONS[DEPTH_STATE.func]) {
            throw new TypeError('Unsupported depth function');
        }
        if (stencil) {
            if (!FUNCTIONS[stencil.func ?? 'always']) {
                throw new TypeError('Unsupported stencil function');
            }
            for (const KEY of ['fail', 'zfail', 'pass']) {
                if (!OPERATIONS[stencil[KEY] ?? 'keep']) {
                    throw new TypeError('Unsupported stencil operation');
                }
            }
            for (const KEY of ['ref', 'mask', 'writeMask']) {
                integer(stencil[KEY] ?? (KEY === 'ref' ? 0 : 255), KEY, 0, 255);
            }
        }
        if (!colorMask || colorMask.length !== 4 || !Array.from(colorMask).every((v) => typeof v === 'boolean')) {
            throw new TypeError('colorMask must contain booleans');
        }
        if (!Array.isArray(textures) || textures.length > this.maxTextures) {
            throw new RangeError('Too many textures');
        }
        for (const HANDLE of textures) {
            this._handle(this.textures, HANDLE, 'texture');
            if (HANDLE === this.activeRenderTarget) {
                throw new Error('Cannot sample the active render target');
            }
        }
        if (filter !== undefined && filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('Unsupported filter');
        }
        const GL = this.gl;
        GL.useProgram(P.gpu);
        GL.bindVertexArray(this.vertexArray);
        try {
            for (let index = 0; index < this.maxVertexAttributes; index++) {
                GL.vertexAttribDivisor(index, 0);
                GL.disableVertexAttribArray(index);
            }
            let boundBuffer = null;
            for (const A of P.locations) {
                if (A.location >= 0) {
                    const IS_INSTANCE = A.source === 'instance',
                        SOURCE_BUFFER = IS_INSTANCE ? instanceRecord : B;
                    if (boundBuffer !== SOURCE_BUFFER.gpu) {
                        GL.bindBuffer(GL.ARRAY_BUFFER, SOURCE_BUFFER.gpu);
                        boundBuffer = SOURCE_BUFFER.gpu;
                    }
                    GL.enableVertexAttribArray(A.location);
                    GL.vertexAttribPointer(
                        A.location,
                        A.size,
                        GL.FLOAT,
                        false,
                        IS_INSTANCE ? P.instanceStride : P.stride,
                        A.offset,
                    );
                    GL.vertexAttribDivisor(A.location, IS_INSTANCE ? 1 : 0);
                }
            }
            for (const [NAME, VALUE] of Object.entries(uniforms)) {
                const TYPE = P.uniforms[NAME];
                if (!TYPE) {
                    throw new TypeError(`Undeclared uniform ${NAME}`);
                }
                const LOCATION = P.uniformLocations.get(NAME);
                if (LOCATION === null) {
                    continue;
                }
                if (TYPE.startsWith('matrix')) {
                    GL[`uniformMatrix${TYPE[6]}fv`](LOCATION, false, VALUE);
                } else if (TYPE.endsWith('v')) {
                    GL[`uniform${TYPE}`](LOCATION, VALUE);
                } else if (TYPE[0] === '1') {
                    GL[`uniform${TYPE}`](LOCATION, VALUE);
                } else {
                    GL[`uniform${TYPE}`](LOCATION, ...VALUE);
                }
            }
            const TEXTURE_UNITS = Math.max(this.boundTextureCount, textures.length);
            for (let i = 0; i < TEXTURE_UNITS; i++) {
                if (i < textures.length) {
                    const R = this.textures.get(textures[i]);
                    this._bindTexture(i, R);
                    this._filter(filter ?? R.filter, R);
                } else {
                    this._unbindTextureUnit(i);
                }
            }
            if (TEXTURE_UNITS) {
                GL.activeTexture(GL.TEXTURE0);
            }
            this.boundTextureCount = textures.length;
            if (blend === false) {
                GL.disable(GL.BLEND);
            } else {
                GL.enable(GL.BLEND);
                GL.blendEquation(GL.FUNC_ADD);
                const FACTORS =
                    blend === 'source-over'
                        ? [GL.ONE, GL.ONE_MINUS_SRC_ALPHA]
                        : blend === 'straight-alpha'
                          ? [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA]
                          : blend === 'copy'
                            ? [GL.ONE, GL.ZERO]
                            : blend === 'lighter'
                              ? [GL.ONE, GL.ONE]
                              : blend === 'source-in'
                                ? [GL.DST_ALPHA, GL.ZERO]
                                : [GL.ZERO, GL.SRC_ALPHA];
                GL.blendFunc(...FACTORS);
            }
            if (DEPTH_STATE?.test) {
                GL.enable(GL.DEPTH_TEST);
                GL.depthFunc(GL[FUNCTIONS[DEPTH_STATE.func]]);
            } else {
                GL.disable(GL.DEPTH_TEST);
            }
            GL.depthMask(DEPTH_STATE?.write ?? false);
            if (stencil) {
                GL.enable(GL.STENCIL_TEST);
                GL.stencilFunc(GL[FUNCTIONS[stencil.func ?? 'always']], stencil.ref ?? 0, stencil.mask ?? 255);
                GL.stencilMask(stencil.writeMask ?? 255);
                GL.stencilOp(
                    GL[OPERATIONS[stencil.fail ?? 'keep']],
                    GL[OPERATIONS[stencil.zfail ?? 'keep']],
                    GL[OPERATIONS[stencil.pass ?? 'keep']],
                );
            } else {
                GL.disable(GL.STENCIL_TEST);
            }
            GL.colorMask(...colorMask);
            GL.disable(GL.CULL_FACE);
            GL.disable(GL.DITHER);
            GL.disable(GL.SCISSOR_TEST);
            GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, ELEMENTS?.gpu ?? null);
            if (P.instanced) {
                if (ELEMENTS) {
                    GL.drawElementsInstanced(GL.TRIANGLES, count, GL.UNSIGNED_SHORT, first * 2, instances);
                } else {
                    GL.drawArraysInstanced(GL.TRIANGLES, first, count, instances);
                }
                this.stats.instancedDrawCalls++;
            } else if (ELEMENTS) {
                GL.drawElements(GL.TRIANGLES, count, GL.UNSIGNED_SHORT, first * 2);
            } else {
                GL.drawArrays(GL.TRIANGLES, first, count);
            }
        } finally {
            GL.bindVertexArray(null);
        }
        this.stats.drawCalls++;
        this.stats.vertices += count * instances;
    }
    endFrame() {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        if (this.renderTargetStack.length) {
            throw new Error('Unbind render targets before endFrame');
        }
        this.active = false;
        return this.stats;
    }
    _deleteGPU() {
        const GL = this.gl;
        if (GL.isContextLost()) {
            return;
        }
        GL.useProgram(null);
        GL.bindVertexArray(null);
        GL.deleteVertexArray(this.vertexArray);
        this.vertexArray = null;
        GL.bindBuffer(GL.ARRAY_BUFFER, null);
        GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, null);
        GL.bindRenderbuffer(GL.RENDERBUFFER, null);
        for (let i = 0; i < this.maxTextures; i++) {
            this._unbindTextureUnit(i);
        }
        GL.activeTexture(GL.TEXTURE0);
        for (const R of this.pipelines.values()) {
            GL.deleteProgram(R.gpu);
        }
        for (const R of this.buffers.values()) {
            GL.deleteBuffer(R.gpu);
        }
        for (const R of this.renderTargets.values()) {
            GL.deleteFramebuffer(R.framebuffer);
            if (R.stencilBuffer) {
                GL.deleteRenderbuffer(R.stencilBuffer);
            }
        }
        for (const R of this.textures.values()) {
            GL.deleteTexture(R.gpu);
        }
    }
    dispose() {
        if (this.state === 'disposed') {
            return;
        }
        this.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this._deleteGPU();
        this.vertexArray = null;
        this.pipelines.clear();
        this.buffers.clear();
        this.textures.clear();
        this.renderTargets.clear();
        this.renderTargetStack.length = 0;
        this.activeRenderTarget = null;
        this.regionCanvas = this.regionContext = this.regionBytes = null;
        if (this._textureAtlas) {
            this._textureAtlas.disposed = true;
            this._textureAtlas = null;
        }
        this.stats.pipelineCount =
            this.stats.bufferCount =
            this.stats.textureCount =
            this.stats.renderTargetCount =
            this.stats.gpuBufferBytes =
            this.stats.gpuRenderTargetBytes =
            this.stats.gpuTextureBytes =
                0;
        this.active = false;
        this.state = 'disposed';
    }
}

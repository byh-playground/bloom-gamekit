/** Programmable WebGL 1 resource/stream/pass core. Game owns geometry and materials. */
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
function compile(gl, type, source) {
    const SHADER = gl.createShader(type);
    if (!SHADER) {
        throw new Error('Shader allocation failed');
    }
    gl.shaderSource(SHADER, source);
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
        integer(maxTextures, 'maxTextures', 1, 32);
        integer(maxBufferBytes, 'maxBufferBytes', 4);
        this.canvas = canvas;
        this.maxBufferBytes = maxBufferBytes;
        this.gl = canvas.getContext('webgl', {
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
            throw new Error('WebGL 1 required');
        }
        this._instancingExtension = this.gl.getExtension('ANGLE_instanced_arrays');
        this.instancingSupported = !!this._instancingExtension;
        this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
        this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
        this.depthAvailable = !!this.gl.getContextAttributes().depth;
        this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
        this.state = 'ready';
        this.failure = null;
        this.active = false;
        this.boundTextureCount = 0;
        this.pipelines = new Map();
        this.buffers = new Map();
        this.textures = new Map();
        this.renderTargets = new Map();
        this.renderTargetStack = [];
        this.activeRenderTarget = null;
        this.enabledAttributes = new Set();
        this.stats = {
            frame: 0,
            drawCalls: 0,
            instancedDrawCalls: 0,
            vertices: 0,
            bufferUploads: 0,
            bufferBytes: 0,
            textureUploads: 0,
            textureBytes: 0,
            frameCopies: 0,
            bufferAllocations: 0,
            gpuBufferBytes: 0,
            gpuRenderTargetBytes: 0,
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
                this.enabledAttributes.clear();
                this.boundTextureCount = 0;
                this._instancingExtension = this.gl.getExtension('ANGLE_instanced_arrays');
                this.instancingSupported = !!this._instancingExtension;
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
                    this._renderTarget(RECORD);
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
        this.gl.deleteBuffer(R.gpu);
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
            GL.activeTexture(GL.TEXTURE0);
            GL.bindTexture(GL.TEXTURE_2D, record.gpu);
            this.boundTextureCount = Math.max(1, this.boundTextureCount);
            GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
            GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
            GL.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, GL.NONE);
            const PIXELS = record.source === null || record.source instanceof Uint8Array,
                FORMAT = record.copyFormat === 'rgb' ? GL.RGB : record.format === 'rgba' ? GL.RGBA : GL.LUMINANCE;
            GL.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !PIXELS);
            if (PIXELS) {
                GL.texImage2D(
                    GL.TEXTURE_2D,
                    0,
                    FORMAT,
                    record.width,
                    record.height,
                    0,
                    FORMAT,
                    GL.UNSIGNED_BYTE,
                    record.source,
                );
            } else {
                GL.texImage2D(GL.TEXTURE_2D, 0, FORMAT, FORMAT, GL.UNSIGNED_BYTE, record.source);
            }
            this._filter(record.filter);
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
            GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
            const ERROR = GL.getError();
            if (ERROR !== GL.NO_ERROR) {
                throw new Error(`Texture upload error ${ERROR}`);
            }
            this.stats.textureUploads++;
            this.stats.textureBytes += record.width * record.height * (record.format === 'rgba' ? 4 : 1);
        } catch (error) {
            GL.deleteTexture(record.gpu);
            record.gpu = null;
            throw error;
        }
    }
    _filter(filter) {
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('filter must be nearest or linear');
        }
        const GL = this.gl,
            VALUE = filter === 'nearest' ? GL.NEAREST : GL.LINEAR;
        GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, VALUE);
        GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, VALUE);
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
            GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, record.gpu, 0);
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
    /** Creates a reusable, premultiplied RGBA texture/FBO pair; the handle is also a draw texture. */
    createRenderTarget(width, height, { filter = 'linear', stencil = false } = {}) {
        this._ready();
        integer(width, 'render target width', 1, this.maxTextureSize);
        integer(height, 'render target height', 1, this.maxTextureSize);
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('filter must be nearest or linear');
        }
        if (typeof stencil !== 'boolean') {
            throw new TypeError('stencil must be boolean');
        }
        if (stencil && !this.stencilAvailable) {
            throw new Error('Context has no stencil buffer');
        }
        const RECORD = {
            width,
            height,
            format: 'rgba',
            premultiplied: true,
            source: null,
            filter,
            stencil,
            gpu: null,
            framebuffer: null,
            stencilBuffer: null,
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
        this.stats.gpuRenderTargetBytes += width * height * (4 + (stencil ? 1 : 0));
        return HANDLE;
    }
    /** Binds a target inside an active frame. Bindings may nest and must unwind in LIFO order. */
    bindRenderTarget(handle) {
        this._ready();
        if (!this.active) {
            throw new Error('beginFrame required');
        }
        const RECORD = this._handle(this.renderTargets, handle, 'render target');
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
        if (RECORD.stencilBuffer) {
            this.gl.deleteRenderbuffer(RECORD.stencilBuffer);
        }
        this.gl.deleteTexture(RECORD.gpu);
        this.renderTargets.delete(handle);
        this.textures.delete(handle);
        this.stats.textureCount = this.textures.size;
        this.stats.renderTargetCount = this.renderTargets.size;
        this.stats.gpuRenderTargetBytes -= RECORD.width * RECORD.height * (4 + (RECORD.stencil ? 1 : 0));
        return true;
    }
    createTexture(source, { format = 'rgba', premultiplied = false, filter = 'linear' } = {}) {
        this._ready();
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('Invalid filter');
        }
        const RECORD = {
            ...this._source(source, format, premultiplied),
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
        return HANDLE;
    }
    /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
    updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture');
        if (this.renderTargets.has(handle)) {
            throw new Error('Render targets cannot be updated from CPU pixels');
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
            const REPLACEMENT = {
                ...NEXT,
                filter: R.filter,
                gpu: null,
            };
            this._texture(REPLACEMENT);
            this.gl.deleteTexture(R.gpu);
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
        GL.activeTexture(GL.TEXTURE0);
        GL.bindTexture(GL.TEXTURE_2D, R.gpu);
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
    }
    /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
    copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
        this._ready();
        const R = this._handle(this.textures, handle, 'texture');
        if (this.renderTargets.has(handle)) {
            throw new Error('Render targets cannot be copied from the default framebuffer');
        }
        integer(x, 'x');
        integer(y, 'y');
        if (R.format !== 'rgba' || x + R.width > this.canvas.width || y + R.height > this.canvas.height) {
            throw new RangeError('Framebuffer copy outside bounds');
        }
        const GL = this.gl;
        GL.activeTexture(GL.TEXTURE0);
        GL.bindTexture(GL.TEXTURE_2D, R.gpu);
        this.boundTextureCount = Math.max(1, this.boundTextureCount);
        // WebGL 1 cannot copy RGB default-framebuffer pixels into RGBA storage.
        // Preserve RGB-only contexts (both games) without requesting an alpha buffer.
        let allocated = false;
        if (!GL.getContextAttributes().alpha && R.copyFormat !== 'rgb') {
            GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGB, R.width, R.height, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
            R.copyFormat = 'rgb';
            allocated = true;
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
        this.gl.deleteTexture(R.gpu);
        this.textures.delete(handle);
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
            if (!this._instancingExtension) {
                throw new Error('ANGLE_instanced_arrays required for instance attributes');
            }
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
        const GL = this.gl,
            INSTANCING = this._instancingExtension;
        GL.useProgram(P.gpu);
        for (const INDEX of this.enabledAttributes) {
            if (INSTANCING) {
                INSTANCING.vertexAttribDivisorANGLE(INDEX, 0);
            }
            GL.disableVertexAttribArray(INDEX);
        }
        this.enabledAttributes.clear();
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
                if (INSTANCING) {
                    INSTANCING.vertexAttribDivisorANGLE(A.location, IS_INSTANCE ? 1 : 0);
                }
                this.enabledAttributes.add(A.location);
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
            GL.activeTexture(GL.TEXTURE0 + i);
            const R = i < textures.length ? this.textures.get(textures[i]) : null;
            GL.bindTexture(GL.TEXTURE_2D, R?.gpu ?? null);
            if (R) {
                this._filter(filter ?? R.filter);
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
        if (ELEMENTS) {
            GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, ELEMENTS.gpu);
        }
        if (P.instanced) {
            if (ELEMENTS) {
                INSTANCING.drawElementsInstancedANGLE(GL.TRIANGLES, count, GL.UNSIGNED_SHORT, first * 2, instances);
            } else {
                INSTANCING.drawArraysInstancedANGLE(GL.TRIANGLES, first, count, instances);
            }
            this.stats.instancedDrawCalls++;
        } else if (ELEMENTS) {
            GL.drawElements(GL.TRIANGLES, count, GL.UNSIGNED_SHORT, first * 2);
        } else {
            GL.drawArrays(GL.TRIANGLES, first, count);
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
        GL.useProgram(null);
        GL.bindBuffer(GL.ARRAY_BUFFER, null);
        GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, null);
        GL.bindRenderbuffer(GL.RENDERBUFFER, null);
        for (let i = 0; i < this.maxTextures; i++) {
            GL.activeTexture(GL.TEXTURE0 + i);
            GL.bindTexture(GL.TEXTURE_2D, null);
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
        this.pipelines.clear();
        this.buffers.clear();
        this.textures.clear();
        this.renderTargets.clear();
        this.renderTargetStack.length = 0;
        this.activeRenderTarget = null;
        this.enabledAttributes.clear();
        this.regionCanvas = this.regionContext = this.regionBytes = null;
        this.stats.pipelineCount =
            this.stats.bufferCount =
            this.stats.textureCount =
            this.stats.renderTargetCount =
            this.stats.gpuBufferBytes =
            this.stats.gpuRenderTargetBytes =
                0;
        this.active = false;
        this.state = 'disposed';
    }
}

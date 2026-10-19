// modules/rendering/device.js
var FUNCTIONS = Object.freeze({
  never: "NEVER",
  less: "LESS",
  equal: "EQUAL",
  lequal: "LEQUAL",
  greater: "GREATER",
  notequal: "NOTEQUAL",
  gequal: "GEQUAL",
  always: "ALWAYS"
});
var OPERATIONS = Object.freeze({
  keep: "KEEP",
  zero: "ZERO",
  replace: "REPLACE",
  increment: "INCR",
  decrement: "DECR",
  invert: "INVERT",
  "increment-wrap": "INCR_WRAP",
  "decrement-wrap": "DECR_WRAP"
});
var UNIFORMS = /* @__PURE__ */ new Set([
  "1f",
  "2f",
  "3f",
  "4f",
  "1i",
  "2i",
  "3i",
  "4i",
  "1iv",
  "1fv",
  "2fv",
  "3fv",
  "4fv",
  "matrix3fv",
  "matrix4fv"
]);
var BLENDS = /* @__PURE__ */ new Set(["source-over", "straight-alpha", "copy", "lighter", "source-in", "destination-in"]);
var ALL_COLOR = Object.freeze([true, true, true, true]);
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
    throw new Error("Shader allocation failed");
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
var WebGLDevice = class {
  constructor(canvas, {
    alpha = false,
    antialias = true,
    depth = true,
    stencil = true,
    preserveDrawingBuffer = false,
    powerPreference = "default",
    failIfMajorPerformanceCaveat = false,
    checkGLErrors = false,
    maxTextures = 8,
    maxBufferBytes = 128 * 1024 * 1024
  } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) {
      throw new TypeError("canvas required");
    }
    if (!["default", "low-power", "high-performance"].includes(powerPreference)) {
      throw new TypeError("Invalid WebGL powerPreference");
    }
    if (typeof failIfMajorPerformanceCaveat !== "boolean") {
      throw new TypeError("failIfMajorPerformanceCaveat must be boolean");
    }
    if (typeof checkGLErrors !== "boolean") {
      throw new TypeError("checkGLErrors must be boolean");
    }
    this.checkGLErrors = checkGLErrors;
    integer(maxTextures, "maxTextures", 1, 32);
    integer(maxBufferBytes, "maxBufferBytes", 4);
    this.canvas = canvas;
    this.maxBufferBytes = maxBufferBytes;
    this.gl = canvas.getContext("webgl", {
      alpha,
      antialias,
      depth,
      stencil,
      premultipliedAlpha: true,
      preserveDrawingBuffer,
      powerPreference,
      failIfMajorPerformanceCaveat
    });
    if (!this.gl) {
      throw new Error("WebGL 1 required");
    }
    this._instancingExtension = this.gl.getExtension("ANGLE_instanced_arrays");
    this.instancingSupported = !!this._instancingExtension;
    this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.depthAvailable = !!this.gl.getContextAttributes().depth;
    this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
    this.state = "ready";
    this.failure = null;
    this.active = false;
    this.boundTextureCount = 0;
    this.pipelines = /* @__PURE__ */ new Map();
    this.buffers = /* @__PURE__ */ new Map();
    this.textures = /* @__PURE__ */ new Map();
    this.renderTargets = /* @__PURE__ */ new Map();
    this.renderTargetStack = [];
    this.activeRenderTarget = null;
    this.enabledAttributes = /* @__PURE__ */ new Set();
    this.stats = {
      frame: 0,
      vectorFlushCalls: 0,
      vectorSubmissions: 0,
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
      frameCopies: 0,
      bufferAllocations: 0,
      gpuBufferBytes: 0,
      gpuRenderTargetBytes: 0,
      pipelineCount: 0,
      bufferCount: 0,
      textureCount: 0,
      renderTargetCount: 0,
      restores: 0
    };
    this.onLost = (event) => {
      event.preventDefault();
      this.active = false;
      this.renderTargetStack.length = 0;
      this.activeRenderTarget = null;
      this.state = "lost";
    };
    this.onRestored = () => {
      if (this.state === "disposed") {
        return;
      }
      try {
        this.enabledAttributes.clear();
        this.boundTextureCount = 0;
        this._instancingExtension = this.gl.getExtension("ANGLE_instanced_arrays");
        this.instancingSupported = !!this._instancingExtension;
        for (const RECORD of this.pipelines.values()) {
          this._pipeline(RECORD);
        }
        for (const RECORD of this.buffers.values()) {
          RECORD.gpu = this.gl.createBuffer();
          if (!RECORD.gpu) {
            throw new Error("Buffer allocation failed");
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
        this.state = "ready";
        this.failure = null;
        this.stats.restores++;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
        this._deleteGPU();
      }
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _ready() {
    if (this.state !== "ready") {
      throw new Error(`WebGLDevice is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
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
    let fragment3;
    let program;
    try {
      vertex = compile(GL, GL.VERTEX_SHADER, record.vertex);
      fragment3 = compile(GL, GL.FRAGMENT_SHADER, record.fragment);
      program = GL.createProgram();
      if (!program) {
        throw new Error("Program allocation failed");
      }
      GL.attachShader(program, vertex);
      GL.attachShader(program, fragment3);
      GL.linkProgram(program);
      if (!GL.getProgramParameter(program, GL.LINK_STATUS)) {
        throw new Error(`Program link failed: ${GL.getProgramInfoLog(program)}`);
      }
      record.locations = record.attributes.map((attribute) => ({
        ...attribute,
        location: GL.getAttribLocation(program, attribute.name)
      }));
      record.uniformLocations = /* @__PURE__ */ new Map();
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
      if (fragment3) {
        GL.deleteShader(fragment3);
      }
    }
  }
  /** Attributes use interleaved FLOAT components and byte offsets in their vertex/instance source. */
  createPipeline({ vertex, fragment: fragment3, stride, instanceStride = 0, attributes, uniforms = {} }) {
    this._ready();
    if (typeof vertex !== "string" || typeof fragment3 !== "string") {
      throw new TypeError("Shader sources required");
    }
    integer(stride, "stride", 4, 255);
    if (stride % 4) {
      throw new RangeError("stride must align to FLOAT");
    }
    integer(instanceStride, "instanceStride", 0, 255);
    if (instanceStride % 4) {
      throw new RangeError("instanceStride must align to FLOAT");
    }
    if (!Array.isArray(attributes) || !attributes.length) {
      throw new TypeError("attributes required");
    }
    const NAMES = /* @__PURE__ */ new Set();
    for (const A of attributes) {
      if (!A || typeof A.name !== "string" || !A.name || NAMES.has(A.name)) {
        throw new TypeError("Unique attribute names required");
      }
      NAMES.add(A.name);
      integer(A.size, "attribute size", 1, 4);
      const SOURCE = A.source ?? "vertex";
      if (SOURCE !== "vertex" && SOURCE !== "instance") {
        throw new TypeError("attribute source must be vertex or instance");
      }
      const SOURCE_STRIDE = SOURCE === "instance" ? instanceStride : stride;
      if (!SOURCE_STRIDE) {
        throw new RangeError("instance attributes require instanceStride");
      }
      integer(A.offset, "attribute offset", 0, SOURCE_STRIDE - 4);
      if (A.offset % 4 || A.offset + A.size * 4 > SOURCE_STRIDE) {
        throw new RangeError("attribute outside source stride");
      }
    }
    if (!uniforms || typeof uniforms !== "object") {
      throw new TypeError("uniform descriptors required");
    }
    for (const TYPE of Object.values(uniforms)) {
      if (!UNIFORMS.has(TYPE)) {
        throw new TypeError(`Unsupported uniform ${TYPE}`);
      }
    }
    const RECORD = {
      vertex,
      fragment: fragment3,
      stride,
      instanceStride,
      instanced: attributes.some((a) => a.source === "instance"),
      attributes: attributes.map((a) => ({
        ...a,
        source: a.source ?? "vertex"
      })),
      uniforms: {
        ...uniforms
      },
      gpu: null
    };
    this._pipeline(RECORD);
    const HANDLE = Object.freeze({
      stride,
      instanceStride
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
    integer(capacityBytes, "capacityBytes", 0, this.maxBufferBytes);
    if (capacityBytes % 4) {
      throw new RangeError("capacityBytes must align to FLOAT");
    }
    const GL = this.gl, GPU = GL.createBuffer();
    if (!GPU) {
      throw new Error("Buffer allocation failed");
    }
    GL.bindBuffer(GL.ARRAY_BUFFER, GPU);
    GL.bufferData(GL.ARRAY_BUFFER, capacityBytes, GL.DYNAMIC_DRAW);
    const HANDLE = Object.freeze({});
    this.buffers.set(HANDLE, {
      gpu: GPU,
      target: GL.ARRAY_BUFFER,
      capacity: capacityBytes,
      used: 0
    });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return HANDLE;
  }
  createIndexBuffer({ capacityBytes = 0 } = {}) {
    this._ready();
    integer(capacityBytes, "capacityBytes", 0, this.maxBufferBytes);
    if (capacityBytes % 2) {
      throw new RangeError("Index buffer capacity must align to UNSIGNED_SHORT");
    }
    const GL = this.gl, GPU = GL.createBuffer();
    if (!GPU) {
      throw new Error("Index buffer allocation failed");
    }
    GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, GPU);
    GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, capacityBytes, GL.DYNAMIC_DRAW);
    const HANDLE = Object.freeze({});
    this.buffers.set(HANDLE, {
      gpu: GPU,
      target: GL.ELEMENT_ARRAY_BUFFER,
      capacity: capacityBytes,
      used: 0
    });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return HANDLE;
  }
  /** View is uploaded synchronously, never copied into another CPU arena or retained. */
  uploadVertices(handle, data) {
    this._ready();
    const R = this._handle(this.buffers, handle, "buffer");
    if (R.target !== this.gl.ARRAY_BUFFER || !(data instanceof Float32Array)) {
      throw new TypeError("An ARRAY_BUFFER and Float32Array are required");
    }
    if (data.byteLength > this.maxBufferBytes) {
      throw new RangeError("Stream exceeds maxBufferBytes");
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
    const R = this._handle(this.buffers, handle, "index buffer");
    if (R.target !== this.gl.ELEMENT_ARRAY_BUFFER || !(data instanceof Uint16Array)) {
      throw new TypeError("An ELEMENT_ARRAY_BUFFER and Uint16Array are required");
    }
    if (data.byteLength > this.maxBufferBytes) {
      throw new RangeError("Index stream exceeds maxBufferBytes");
    }
    const GL = this.gl;
    GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, R.gpu);
    if (data.byteLength > R.capacity) {
      let capacity = Math.max(2, R.capacity);
      while (capacity < data.byteLength) {
        capacity = Math.min(
          this.maxBufferBytes,
          this.maxBufferBytes % 2 ? this.maxBufferBytes - 1 : this.maxBufferBytes,
          capacity * 2
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
      throw new TypeError("Buffer target does not match delete operation");
    }
    this.gl.deleteBuffer(R.gpu);
    this.buffers.delete(handle);
    this.stats.gpuBufferBytes -= R.capacity;
    this.stats.bufferCount = this.buffers.size;
    return true;
  }
  _source(source, format, premultiplied) {
    if (source === this.canvas) {
      throw new TypeError("Use copyFrameToTexture for GPU frame composition, not canvas upload");
    }
    if (typeof premultiplied !== "boolean") {
      throw new TypeError("premultiplied must be boolean");
    }
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") {
      throw new TypeError("ImageBitmap alpha mode is not inspectable");
    }
    const WIDTH = source?.naturalWidth ?? source?.width, HEIGHT = source?.naturalHeight ?? source?.height;
    integer(WIDTH, "texture width", 1, this.maxTextureSize);
    integer(HEIGHT, "texture height", 1, this.maxTextureSize);
    if (format !== "rgba" && format !== "luminance") {
      throw new TypeError("texture format must be rgba or luminance");
    }
    let retained = source;
    if (source.data !== void 0) {
      const DATA = source.data, COMPONENTS = format === "rgba" ? 4 : 1;
      if (DATA !== null && (!(DATA instanceof Uint8Array || DATA instanceof Uint8ClampedArray) || DATA.length !== WIDTH * HEIGHT * COMPONENTS)) {
        throw new TypeError("Texture byte count does not match dimensions/format");
      }
      retained = DATA === null ? null : new Uint8Array(DATA);
      if (retained && format === "rgba" && !premultiplied) {
        for (let i = 0; i < retained.length; i += 4) {
          const ALPHA = retained[i + 3] / 255;
          retained[i] = Math.round(retained[i] * ALPHA);
          retained[i + 1] = Math.round(retained[i + 1] * ALPHA);
          retained[i + 2] = Math.round(retained[i + 2] * ALPHA);
        }
      }
    } else if (format !== "rgba" || premultiplied) {
      throw new TypeError("DOM sources require rgba and premultiplied:false");
    }
    return {
      source: retained,
      width: WIDTH,
      height: HEIGHT,
      format,
      premultiplied
    };
  }
  _texture(record) {
    const GL = this.gl;
    record.gpu = GL.createTexture();
    if (!record.gpu) {
      throw new Error("Texture allocation failed");
    }
    try {
      GL.activeTexture(GL.TEXTURE0);
      GL.bindTexture(GL.TEXTURE_2D, record.gpu);
      this.boundTextureCount = Math.max(1, this.boundTextureCount);
      GL.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
      GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
      GL.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, GL.NONE);
      const PIXELS = record.source === null || record.source instanceof Uint8Array, FORMAT = record.copyFormat === "rgb" ? GL.RGB : record.format === "rgba" ? GL.RGBA : GL.LUMINANCE;
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
          record.source
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
      this.stats.textureBytes += record.width * record.height * (record.format === "rgba" ? 4 : 1);
    } catch (error) {
      GL.deleteTexture(record.gpu);
      record.gpu = null;
      throw error;
    }
  }
  _filter(filter) {
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("filter must be nearest or linear");
    }
    const GL = this.gl, VALUE = filter === "nearest" ? GL.NEAREST : GL.LINEAR;
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, VALUE);
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, VALUE);
  }
  _renderTarget(record) {
    const GL = this.gl, PREVIOUS = GL.getParameter(GL.FRAMEBUFFER_BINDING), PREVIOUS_RENDERBUFFER = GL.getParameter(GL.RENDERBUFFER_BINDING), FRAMEBUFFER_LOCAL = GL.createFramebuffer();
    let stencilBuffer = null;
    if (!FRAMEBUFFER_LOCAL) {
      throw new Error("Render target framebuffer allocation failed");
    }
    try {
      GL.bindFramebuffer(GL.FRAMEBUFFER, FRAMEBUFFER_LOCAL);
      GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, record.gpu, 0);
      if (record.stencil) {
        stencilBuffer = GL.createRenderbuffer();
        if (!stencilBuffer) {
          throw new Error("Render target stencil allocation failed");
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
  createRenderTarget(width, height, { filter = "linear", stencil = false } = {}) {
    this._ready();
    integer(width, "render target width", 1, this.maxTextureSize);
    integer(height, "render target height", 1, this.maxTextureSize);
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("filter must be nearest or linear");
    }
    if (typeof stencil !== "boolean") {
      throw new TypeError("stencil must be boolean");
    }
    if (stencil && !this.stencilAvailable) {
      throw new Error("Context has no stencil buffer");
    }
    const RECORD = {
      width,
      height,
      format: "rgba",
      premultiplied: true,
      source: null,
      filter,
      stencil,
      gpu: null,
      framebuffer: null,
      stencilBuffer: null
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
      stencil
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
      throw new Error("beginFrame required");
    }
    const RECORD = this._handle(this.renderTargets, handle, "render target");
    if (this.activeRenderTarget === handle || this.renderTargetStack.some((entry) => entry.handle === handle)) {
      throw new Error("Render target is already bound");
    }
    const GL = this.gl;
    this.renderTargetStack.push({
      handle: this.activeRenderTarget,
      framebuffer: GL.getParameter(GL.FRAMEBUFFER_BINDING),
      viewport: GL.getParameter(GL.VIEWPORT)
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
      throw new Error("beginFrame required");
    }
    if (!this.renderTargetStack.length) {
      throw new Error("No render target is bound");
    }
    if (handle !== void 0 && handle !== this.activeRenderTarget) {
      throw new Error("Render targets must be unbound in LIFO order");
    }
    const PREVIOUS = this.renderTargetStack.pop(), GL = this.gl;
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
      throw new Error("Cannot delete a bound render target");
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
  createTexture(source, { format = "rgba", premultiplied = false, filter = "linear" } = {}) {
    this._ready();
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("Invalid filter");
    }
    const RECORD = {
      ...this._source(source, format, premultiplied),
      filter,
      gpu: null
    };
    this._texture(RECORD);
    const HANDLE = Object.freeze({
      width: RECORD.width,
      height: RECORD.height
    });
    this.textures.set(HANDLE, RECORD);
    this.stats.textureCount = this.textures.size;
    return HANDLE;
  }
  /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
  updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
    this._ready();
    const R = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) {
      throw new Error("Render targets cannot be updated from CPU pixels");
    }
    integer(x, "x");
    integer(y, "y");
    integer(width, "width", 1);
    integer(height, "height", 1);
    if (x + width > R.width || y + height > R.height) {
      throw new RangeError("Texture region outside bounds");
    }
    const NEXT = this._source(source, R.format, R.premultiplied);
    if (NEXT.width !== R.width || NEXT.height !== R.height || NEXT.source === null) {
      throw new RangeError("Update requires matching full source");
    }
    if (R.copyFormat) {
      const REPLACEMENT = {
        ...NEXT,
        filter: R.filter,
        gpu: null
      };
      this._texture(REPLACEMENT);
      this.gl.deleteTexture(R.gpu);
      Object.assign(R, REPLACEMENT);
      delete R.copyFormat;
      return;
    }
    const GL = this.gl, FORMAT = R.format === "rgba" ? GL.RGBA : GL.LUMINANCE;
    let pixels = NEXT.source;
    if (pixels instanceof Uint8Array) {
      const COMPONENTS = R.format === "rgba" ? 4 : 1;
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
            throw new Error("DOM region uploads require canvas.ownerDocument");
          }
          this.regionCanvas = DOC.createElement("canvas");
          this.regionContext = this.regionCanvas.getContext("2d");
          if (!this.regionContext) {
            throw new Error("Asset-region Canvas2D unavailable");
          }
        }
        const C = this.regionCanvas, Q = this.regionContext;
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
    this.stats.textureBytes += width * height * (R.format === "rgba" ? 4 : 1);
  }
  /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
  copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
    this._ready();
    const R = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) {
      throw new Error("Render targets cannot be copied from the default framebuffer");
    }
    integer(x, "x");
    integer(y, "y");
    if (R.format !== "rgba" || x + R.width > this.canvas.width || y + R.height > this.canvas.height) {
      throw new RangeError("Framebuffer copy outside bounds");
    }
    const GL = this.gl;
    GL.activeTexture(GL.TEXTURE0);
    GL.bindTexture(GL.TEXTURE_2D, R.gpu);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    let allocated = false;
    if (!GL.getContextAttributes().alpha && R.copyFormat !== "rgb") {
      GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGB, R.width, R.height, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
      R.copyFormat = "rgb";
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
      throw new Error("Use deleteRenderTarget for render targets");
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
    clearStencil = 0
  } = {}) {
    if (this.state === "lost") {
      return false;
    }
    this._ready();
    if (this.active) {
      throw new Error("endFrame required");
    }
    integer(width, "width", 1);
    integer(height, "height", 1);
    const GL = this.gl, LIMIT = GL.getParameter(GL.MAX_VIEWPORT_DIMS);
    if (width > LIMIT[0] || height > LIMIT[1]) {
      throw new RangeError("Viewport exceeds WebGL limit");
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
      "vectorFlushCalls",
      "vectorSubmissions",
      "pathTessellations",
      "pathStrokeBuilds",
      "meshCreates",
      "drawCalls",
      "instancedDrawCalls",
      "vertices",
      "bufferUploads",
      "bufferBytes",
      "textureUploads",
      "textureBytes",
      "frameCopies"
    ]) {
      this.stats[NAME] = 0;
    }
    this.active = true;
    this.clear({
      color: clearColor,
      depth: clearDepth,
      stencil: clearStencil
    });
    return true;
  }
  clear({ color: color2, depth, stencil } = {}) {
    this._ready();
    const GL = this.gl;
    let flags = 0;
    if (color2 !== void 0) {
      finiteArray(color2, 4, "clear color");
      GL.colorMask(true, true, true, true);
      GL.clearColor(...color2);
      flags |= GL.COLOR_BUFFER_BIT;
    }
    if (depth !== void 0) {
      if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
        throw new RangeError("clear depth 0..1");
      }
      GL.depthMask(true);
      GL.clearDepth(depth);
      flags |= GL.DEPTH_BUFFER_BIT;
    }
    if (stencil !== void 0) {
      integer(stencil, "clear stencil", 0, 255);
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
    blend = "source-over",
    depth = false,
    stencil = false,
    colorMask = ALL_COLOR,
    filter
  } = {}) {
    this._ready();
    if (!this.active) {
      throw new Error("beginFrame required");
    }
    const P = this._handle(this.pipelines, pipeline, "pipeline"), B = this._handle(this.buffers, buffer, "buffer");
    if (B.target !== this.gl.ARRAY_BUFFER) {
      throw new TypeError("A vertex buffer is required");
    }
    integer(first, "first");
    integer(count, "count");
    const ELEMENTS = indexBuffer === void 0 || indexBuffer === null ? null : this._handle(this.buffers, indexBuffer, "index buffer");
    if (ELEMENTS) {
      if (ELEMENTS.target !== this.gl.ELEMENT_ARRAY_BUFFER || ELEMENTS.used % 2 || first + count > ELEMENTS.used / 2) {
        throw new RangeError("draw exceeds uploaded indices");
      }
    } else if (first + count > B.used / P.stride) {
      throw new RangeError("draw exceeds uploaded vertices");
    }
    integer(instances, "instances", 1);
    let instanceRecord;
    if (P.instanced) {
      if (!this._instancingExtension) {
        throw new Error("ANGLE_instanced_arrays required for instance attributes");
      }
      instanceRecord = this._handle(this.buffers, instanceBuffer, "instance buffer");
      if (instanceRecord.target !== this.gl.ARRAY_BUFFER) {
        throw new TypeError("An instance vertex buffer is required");
      }
      if (instances > instanceRecord.used / P.instanceStride) {
        throw new RangeError("draw exceeds uploaded instances");
      }
    } else if (instances !== 1) {
      throw new RangeError("Multiple instances require instance attributes");
    }
    if (!Number.isSafeInteger(count * instances)) {
      throw new RangeError("draw vertex count exceeds safe integer range");
    }
    const DEPTH_STATE = depth === false || depth == null ? null : depth === true ? {
      test: true,
      write: true,
      func: "lequal"
    } : typeof depth === "object" && !Array.isArray(depth) ? {
      test: depth.test ?? true,
      write: depth.write ?? true,
      func: depth.func ?? "lequal"
    } : (() => {
      throw new TypeError("depth must be false or a depth policy object");
    })();
    if (DEPTH_STATE && (typeof DEPTH_STATE.test !== "boolean" || typeof DEPTH_STATE.write !== "boolean")) {
      throw new TypeError("depth.test and depth.write must be booleans");
    }
    if ((DEPTH_STATE?.test || DEPTH_STATE?.write) && !this.depthAvailable) {
      throw new Error("Context has no depth buffer");
    }
    if (stencil && !this.activeStencilAvailable) {
      throw new Error("The active framebuffer has no stencil attachment");
    }
    if (blend !== false && !BLENDS.has(blend)) {
      throw new TypeError("Unsupported blend");
    }
    if (DEPTH_STATE && !FUNCTIONS[DEPTH_STATE.func]) {
      throw new TypeError("Unsupported depth function");
    }
    if (stencil) {
      if (!FUNCTIONS[stencil.func ?? "always"]) {
        throw new TypeError("Unsupported stencil function");
      }
      for (const KEY of ["fail", "zfail", "pass"]) {
        if (!OPERATIONS[stencil[KEY] ?? "keep"]) {
          throw new TypeError("Unsupported stencil operation");
        }
      }
      for (const KEY of ["ref", "mask", "writeMask"]) {
        integer(stencil[KEY] ?? (KEY === "ref" ? 0 : 255), KEY, 0, 255);
      }
    }
    if (!colorMask || colorMask.length !== 4 || !Array.from(colorMask).every((v) => typeof v === "boolean")) {
      throw new TypeError("colorMask must contain booleans");
    }
    if (!Array.isArray(textures) || textures.length > this.maxTextures) {
      throw new RangeError("Too many textures");
    }
    for (const HANDLE of textures) {
      this._handle(this.textures, HANDLE, "texture");
      if (HANDLE === this.activeRenderTarget) {
        throw new Error("Cannot sample the active render target");
      }
    }
    if (filter !== void 0 && filter !== "nearest" && filter !== "linear") {
      throw new TypeError("Unsupported filter");
    }
    const GL = this.gl, INSTANCING = this._instancingExtension;
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
        const IS_INSTANCE = A.source === "instance", SOURCE_BUFFER = IS_INSTANCE ? instanceRecord : B;
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
          A.offset
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
      if (TYPE.startsWith("matrix")) {
        GL[`uniformMatrix${TYPE[6]}fv`](LOCATION, false, VALUE);
      } else if (TYPE.endsWith("v")) {
        GL[`uniform${TYPE}`](LOCATION, VALUE);
      } else if (TYPE[0] === "1") {
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
      const FACTORS = blend === "source-over" ? [GL.ONE, GL.ONE_MINUS_SRC_ALPHA] : blend === "straight-alpha" ? [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA] : blend === "copy" ? [GL.ONE, GL.ZERO] : blend === "lighter" ? [GL.ONE, GL.ONE] : blend === "source-in" ? [GL.DST_ALPHA, GL.ZERO] : [GL.ZERO, GL.SRC_ALPHA];
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
      GL.stencilFunc(GL[FUNCTIONS[stencil.func ?? "always"]], stencil.ref ?? 0, stencil.mask ?? 255);
      GL.stencilMask(stencil.writeMask ?? 255);
      GL.stencilOp(
        GL[OPERATIONS[stencil.fail ?? "keep"]],
        GL[OPERATIONS[stencil.zfail ?? "keep"]],
        GL[OPERATIONS[stencil.pass ?? "keep"]]
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
      throw new Error("beginFrame required");
    }
    if (this.renderTargetStack.length) {
      throw new Error("Unbind render targets before endFrame");
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
    if (this.state === "disposed") {
      return;
    }
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this._deleteGPU();
    this.pipelines.clear();
    this.buffers.clear();
    this.textures.clear();
    this.renderTargets.clear();
    this.renderTargetStack.length = 0;
    this.activeRenderTarget = null;
    this.enabledAttributes.clear();
    this.regionCanvas = this.regionContext = this.regionBytes = null;
    this.stats.pipelineCount = this.stats.bufferCount = this.stats.textureCount = this.stats.renderTargetCount = this.stats.gpuBufferBytes = this.stats.gpuRenderTargetBytes = 0;
    this.active = false;
    this.state = "disposed";
  }
};

// modules/rendering/vector-renderer.js
var IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
var VERTEX = `attribute vec2 a_position; attribute vec2 a_uv; attribute vec4 a_color;
uniform mat3 u_projection; varying vec2 v_uv; varying vec4 v_color;
void main(){vec3 p=u_projection*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);v_uv=a_uv;v_color=a_color;}`;
var CLIP_VERTEX = `attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;void main(){vec3 p=u_projection*u_transform*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);}`;
var CLIP_FRAGMENT = "precision mediump float;void main(){gl_FragColor=vec4(1.0);}";
var FRAGMENT = `precision mediump float; uniform sampler2D u_texture; uniform float u_textured; uniform float u_radial; uniform vec4 u_radial_params; uniform float u_whiteFlash;
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
var NON_RADIAL_FRAGMENT = `precision mediump float; uniform sampler2D u_texture; uniform float u_textured; uniform float u_whiteFlash;
varying vec2 v_uv; varying vec4 v_color;
void main(){vec4 texel=mix(vec4(1.0),texture2D(u_texture,v_uv),u_textured);float a=texel.a*v_color.a;vec3 rgb=mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),u_whiteFlash);gl_FragColor=vec4(rgb,a);}`;
var FINITE = (n, label) => {
  if (!Number.isFinite(n)) {
    throw new TypeError(`${label} must be finite`);
  }
};
function rgba(value) {
  if (!value || value.length !== 4 || Array.from(value).some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new TypeError("RGBA channels must be in [0,1]");
  }
  return value;
}
function point(m, x, y) {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5]
  };
}
function compose(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
function tessellate(contours, rule) {
  const EDGES = [], YS = [];
  for (const CONTOUR of contours) {
    if (CONTOUR.length < 3) {
      continue;
    }
    for (let i = 0; i < CONTOUR.length; i++) {
      const A = CONTOUR[i], B = CONTOUR[(i + 1) % CONTOUR.length];
      if (Math.abs(A.y - B.y) < 1e-9) {
        continue;
      }
      const MIN_Y = Math.min(A.y, B.y), MAX_Y = Math.max(A.y, B.y);
      EDGES.push({
        a: A,
        b: B,
        sign: B.y > A.y ? 1 : -1,
        minY: MIN_Y,
        maxY: MAX_Y
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
  const STARTS = EDGES.slice().sort((a, b) => a.minY - b.minY), ACTIVE = [], TRIANGLES = [];
  let nextStart = 0;
  for (let band = 0; band + 1 < LEVELS.length; band++) {
    const Y0 = LEVELS[band], Y1 = LEVELS[band + 1], YM = (Y0 + Y1) / 2;
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
      const BEFORE = rule === "evenodd" ? inside : winding !== 0;
      if (rule === "evenodd") {
        inside = !inside;
      } else {
        winding += EDGE.sign;
      }
      const AFTER = rule === "evenodd" ? inside : winding !== 0;
      if (!BEFORE && AFTER) {
        left = EDGE;
      } else if (BEFORE && !AFTER && left) {
        const A = {
          x: xAt(left, Y0),
          y: Y0
        }, B = {
          x: xAt(EDGE, Y0),
          y: Y0
        }, C = {
          x: xAt(EDGE, Y1),
          y: Y1
        }, D = {
          x: xAt(left, Y1),
          y: Y1
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
  return A.x + (B.x - A.x) * (y - A.y) / (B.y - A.y);
}
function clipContour(points, rule) {
  if (rule !== "nonzero" && rule !== "evenodd") {
    throw new TypeError("clip rule must be nonzero or evenodd");
  }
  if (!(points instanceof Float32Array) && !(points instanceof Float64Array) && !Array.isArray(points)) {
    throw new TypeError("Clip contour must be a flat numeric array of x/y pairs");
  }
  if (points.length % 2) {
    throw new RangeError("Clip contour needs x/y pairs");
  }
  const FLAT = Float32Array.from(points);
  if (FLAT.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Clip contour coordinates must be finite");
  }
  const COUNT = FLAT.length / 2;
  if (COUNT > 256) {
    throw new RangeError("Retained clip contours support at most 256 authored points");
  }
  let end = COUNT;
  if (COUNT > 3 && FLAT[0] === FLAT[(COUNT - 1) * 2] && FLAT[1] === FLAT[(COUNT - 1) * 2 + 1]) {
    end--;
  }
  if (end < 3) {
    throw new RangeError("Clip contour requires at least three distinct points");
  }
  const CONTOUR = Array.from(
    {
      length: end
    },
    (_, i) => ({
      x: FLAT[i * 2],
      y: FLAT[i * 2 + 1]
    })
  );
  for (let i = 0; i < end; i++) {
    const A = CONTOUR[i], B = CONTOUR[(i + 1) % end];
    if (A.x === B.x && A.y === B.y) {
      throw new RangeError("Clip contour cannot contain consecutive duplicate points");
    }
  }
  const ORIENT = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), ON = (a, b, p) => Math.abs(ORIENT(a, b, p)) < 1e-9 && p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
  for (let i = 0; i < end; i++) {
    for (let j = i + 1; j < end; j++) {
      if (j === i + 1 || i === 0 && j === end - 1) {
        continue;
      }
      const A = CONTOUR[i], B = CONTOUR[(i + 1) % end], C = CONTOUR[j], D = CONTOUR[(j + 1) % end], O1 = ORIENT(A, B, C), O2 = ORIENT(A, B, D), O3 = ORIENT(C, D, A), O4 = ORIENT(C, D, B);
      if (O1 * O2 < 0 && O3 * O4 < 0 || ON(A, B, C) || ON(A, B, D) || ON(C, D, A) || ON(C, D, B)) {
        throw new RangeError("Retained clip contours must be simple and non-self-intersecting");
      }
    }
  }
  let area = 0;
  for (let i = 0; i < end; i++) {
    const A = CONTOUR[i], B = CONTOUR[(i + 1) % end];
    area += A.x * B.y - B.x * A.y;
  }
  if (Math.abs(area) < 1e-9) {
    throw new RangeError("Clip contour area must be nonzero");
  }
  const TRIANGLES = tessellate([CONTOUR], rule);
  if (!TRIANGLES.length) {
    throw new RangeError("Clip contour could not be tessellated");
  }
  if (TRIANGLES.length / 3 > 16384) {
    throw new RangeError("Retained clip tessellation exceeds 16384 triangles");
  }
  return {
    flat: FLAT,
    triangles: Float32Array.from(TRIANGLES.flatMap((p) => [p.x, p.y]))
  };
}
function convexContour(contour) {
  let sign = 0;
  for (let i = 0; i < contour.length; i++) {
    const A = contour[i], B = contour[(i + 1) % contour.length], C = contour[(i + 2) % contour.length], CROSS = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x);
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
var VectorRenderer = class {
  constructor(device, { initialVertices = 4096, maxVertices = 262144, glyphAtlas = null } = {}) {
    if (!device?.createPipeline || !device?.draw) {
      throw new TypeError("A WebGLDevice is required");
    }
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(initialVertices) || initialVertices < 3 || initialVertices > maxVertices) {
      throw new RangeError("3 <= initialVertices <= maxVertices is required");
    }
    if (initialVertices * 32 > device.maxBufferBytes) {
      throw new RangeError("initial vector buffer exceeds the device byte limit");
    }
    this.device = device;
    this.gl = device.gl;
    this.canvas = device.canvas;
    this.glyphAtlas = glyphAtlas;
    this.maxVertices = Math.min(maxVertices, Math.floor(device.maxBufferBytes / 32));
    this.maxClipPlanes = Math.max(
      1,
      Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2)
    );
    this.pipeline = device.createPipeline({
      vertex: VERTEX,
      fragment: FRAGMENT,
      stride: 32,
      attributes: [
        {
          name: "a_position",
          size: 2,
          offset: 0
        },
        {
          name: "a_uv",
          size: 2,
          offset: 8
        },
        {
          name: "a_color",
          size: 4,
          offset: 16
        }
      ],
      uniforms: {
        u_projection: "matrix3fv",
        u_texture: "1i",
        u_textured: "1f",
        u_radial: "1f",
        u_radial_params: "4f",
        u_whiteFlash: "1f"
      }
    });
    this.clipPipeline = device.createPipeline({
      vertex: CLIP_VERTEX,
      fragment: CLIP_FRAGMENT,
      stride: 8,
      attributes: [
        {
          name: "a_position",
          size: 2,
          offset: 0
        }
      ],
      uniforms: {
        u_projection: "matrix3fv",
        u_transform: "matrix3fv"
      }
    });
    this.buffer = device.createVertexBuffer({
      capacityBytes: initialVertices * 32
    });
    this.dynamicClipBuffer = device.createVertexBuffer({
      capacityBytes: 0
    });
    this.white = device.createTexture(
      {
        width: 1,
        height: 1,
        data: new Uint8Array([255, 255, 255, 255])
      },
      {
        format: "rgba",
        premultiplied: true,
        filter: "nearest"
      }
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
    this.clipPaths = /* @__PURE__ */ new Map();
    this.clipPathBytes = 0;
    this.stencilDepth = 0;
    this.stencilNeedsRebuild = false;
    this.state = "ready";
    this.onLost = () => {
      this.count = 0;
      this.stencilNeedsRebuild = this.stencilClips.length > 0;
    };
    this.onRestored = () => {
      if (this.state === "disposed") {
        return;
      }
      try {
        for (const RECORD of this.clipPaths.values()) {
          this.device.uploadVertices(RECORD.buffer, RECORD.triangles);
        }
      } catch {
        this.state = "failed";
      }
    };
    this.canvas.addEventListener("webglcontextlost", this.onLost);
    this.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.projection = new Float32Array([2 / this.canvas.width, 0, 0, 0, -2 / this.canvas.height, 0, -1, 1, 1]);
    this.nonRadialPipeline = null;
    try {
      this.nonRadialPipeline = device.createPipeline({
        vertex: VERTEX,
        fragment: NON_RADIAL_FRAGMENT,
        stride: 32,
        attributes: [
          {
            name: "a_position",
            size: 2,
            offset: 0
          },
          {
            name: "a_uv",
            size: 2,
            offset: 8
          },
          {
            name: "a_color",
            size: 4,
            offset: 16
          }
        ],
        uniforms: {
          u_projection: "matrix3fv",
          u_texture: "1i",
          u_textured: "1f",
          u_whiteFlash: "1f"
        }
      });
    } catch (error) {
      try {
        this.dispose();
      } catch {
      }
      throw error;
    }
  }
  _frame() {
    if (this.state !== "ready") {
      throw new Error(`VectorRenderer is ${this.state}`);
    }
    if (!this.device.active) {
      throw new Error("WebGLDevice.beginFrame is required");
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
    const W = target?.width ?? this.canvas.width, H = target?.height ?? this.canvas.height, X = bounds?.x ?? 0, Y = bounds?.y ?? 0;
    this.projection[0] = 2 / W;
    this.projection[1] = 0;
    this.projection[2] = 0;
    this.projection[3] = 0;
    this.projection[4] = -2 / H;
    this.projection[5] = 0;
    this.projection[6] = -1 - 2 * X / W;
    this.projection[7] = 1 + 2 * Y / H;
    this.projection[8] = 1;
  }
  beginPath() {
    this._frame();
    this.path = [];
    this.cursor = this.subpath = null;
  }
  moveTo(x, y) {
    this._frame();
    FINITE(x, "x");
    FINITE(y, "y");
    const P = point(this.matrix, x, y);
    this.path.push([P]);
    this.cursor = this.subpath = P;
  }
  lineTo(x, y) {
    this._frame();
    FINITE(x, "x");
    FINITE(y, "y");
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
      throw new RangeError("curve segments must be 2..256");
    }
    if (!this.cursor) {
      return this.moveTo(v[0], v[1]);
    }
    const START = this.cursor, P = cubic ? [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3]), point(this.matrix, v[4], v[5])] : [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3])];
    for (let i = 1; i <= n; i++) {
      const T = i / n, Q = 1 - T;
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
        y
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
      clips: this.clips.map(
        (polygon) => polygon.map((p) => ({
          ...p
        }))
      ),
      stencilClips: this.stencilClips.slice()
    });
  }
  restore() {
    this._frame();
    const S = this.stack.pop();
    if (!S) {
      throw new Error("restore without save");
    }
    this._submit();
    this.matrix = S.matrix;
    this.clips = S.clips;
    if (S.stencilClips.length !== this.stencilClips.length || S.stencilClips.some((clip, i) => clip !== this.stencilClips[i])) {
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
      M[1] * e + M[3] * f + M[5]
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
      throw new RangeError("clip size must be non-negative");
    }
    const CONTOUR = [
      point(this.matrix, x, y),
      point(this.matrix, x + width, y),
      point(this.matrix, x + width, y + height),
      point(this.matrix, x, y + height)
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
      throw new RangeError("Dynamic convex clips support at most 1024 authored points");
    }
    if (!convexContour(contour)) {
      throw new RangeError("clip() accepts convex contours; create a retained ClipPath for concave contours");
    }
    const AREA = contour.reduce(
      (sum, p, i) => sum + p.x * contour[(i + 1) % contour.length].y - contour[(i + 1) % contour.length].x * p.y,
      0
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
        "Clip contours exceeding the mesh edge-plane limit require stencil; no fallback is available"
      );
    }
    if (this.stencilClips.length >= 255) {
      throw new RangeError("At most 255 nested stencil clips are supported");
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
        stencil: 0
      });
    }
    const ENTRY = {
      dynamic: true,
      triangles: TRIANGLES
    };
    this._drawStencilClip(ENTRY, this.stencilDepth);
    this.stencilClips = [...this.stencilClips, ENTRY];
    this.stencilDepth++;
  }
  clip(rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") {
      throw new TypeError("rule must be nonzero or evenodd");
    }
    const CONTOURS = this.path.filter((path) => path.length >= 3).map(
      (path) => path.map((p) => ({
        ...p
      }))
    );
    if (!CONTOURS.length) {
      return;
    }
    if (CONTOURS.length !== 1) {
      throw new RangeError("clip() accepts one contour; use a retained ClipPath for multi-contour geometry");
    }
    const CONTOUR = CONTOURS[0];
    if (CONTOUR.length > 3 && CONTOUR[0].x === CONTOUR.at(-1).x && CONTOUR[0].y === CONTOUR.at(-1).y) {
      CONTOUR.pop();
    }
    this._addConvexClip(CONTOUR);
  }
  createClipPath(points, { rule = "nonzero" } = {}) {
    if (this.state !== "ready" || this.device.state !== "ready") {
      throw new Error("VectorRenderer is not ready");
    }
    if (this.device.active) {
      throw new Error("Create retained ClipPaths outside an active frame");
    }
    if (this.clipPaths.size >= 64) {
      throw new RangeError("At most 64 retained ClipPaths may be live");
    }
    const GEOMETRY = clipContour(points, rule);
    if (this.clipPathBytes + GEOMETRY.triangles.byteLength > 16 * 1024 * 1024) {
      throw new RangeError("Retained ClipPaths exceed the 16 MiB budget");
    }
    const BUFFER = this.device.createVertexBuffer({
      capacityBytes: GEOMETRY.triangles.byteLength
    });
    try {
      this.device.uploadVertices(BUFFER, GEOMETRY.triangles);
    } catch (error) {
      this.device.deleteVertexBuffer(BUFFER);
      throw error;
    }
    const HANDLE = Object.freeze({
      renderer: this,
      buffer: BUFFER
    });
    this.clipPaths.set(HANDLE, {
      buffer: BUFFER,
      triangles: GEOMETRY.triangles,
      count: GEOMETRY.triangles.length / 2,
      byteLength: GEOMETRY.triangles.byteLength,
      contour: GEOMETRY.flat,
      rule
    });
    this.clipPathBytes += GEOMETRY.triangles.byteLength;
    return HANDLE;
  }
  deleteClipPath(handle) {
    const RECORD = this.clipPaths.get(handle);
    if (!RECORD) {
      return false;
    }
    const REFERENCED = this.stencilClips.some((entry) => entry.handle === handle) || this.stack.some((state) => state.stencilClips.some((entry) => entry.handle === handle)) || this.groups.some((group) => group.stencilClips?.some((entry) => entry.handle === handle));
    if (REFERENCED) {
      throw new Error("Remove a ClipPath from every saved clip stack before deleting it");
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
      throw new TypeError("ClipPath owned by this VectorRenderer is required");
    }
    if (!this.device.activeStencilAvailable) {
      throw new Error("Concave ClipPath requires an active stencil attachment; no fallback is available");
    }
    if (this.stencilClips.length >= 255) {
      throw new RangeError("At most 255 nested stencil ClipPaths are supported");
    }
    const LOCAL = transform ?? IDENTITY;
    if (LOCAL.length !== 6 || Array.from(LOCAL).some((value) => !Number.isFinite(value))) {
      throw new TypeError("ClipPath transform needs six finite values");
    }
    const MATRIX = compose(this.matrix, LOCAL);
    if (Math.abs(MATRIX[0] * MATRIX[3] - MATRIX[1] * MATRIX[2]) < 1e-12) {
      throw new RangeError("ClipPath transform must be invertible");
    }
    this._submit();
    if (!this.stencilDepth) {
      this.device.clear({
        stencil: 0
      });
    }
    const ENTRY = {
      handle,
      matrix: Float32Array.from(MATRIX)
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
        throw new Error("A ClipPath in the active stack was deleted");
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
        u_transform: transform
      },
      blend: false,
      colorMask: [false, false, false, false],
      stencil: {
        func: "equal",
        ref,
        mask: 255,
        writeMask: 255,
        pass: "increment"
      }
    });
  }
  _rebuildStencil() {
    if (!this.stencilClips.length) {
      this.stencilDepth = 0;
      this.stencilNeedsRebuild = false;
      return;
    }
    if (!this.device.activeStencilAvailable) {
      throw new Error("Saved concave ClipPath requires a stencil attachment");
    }
    this.device.clear({
      stencil: 0
    });
    this.stencilDepth = 0;
    for (const ENTRY of this.stencilClips) {
      this._drawStencilClip(ENTRY, this.stencilDepth);
      this.stencilDepth++;
    }
    this.stencilNeedsRebuild = false;
  }
  _clipTriangle(a, b, c, uv) {
    let poly = [a, b, c].map(
      (p, i) => uv ? {
        ...p,
        u: uv[i][0],
        v: uv[i][1]
      } : p
    );
    for (const CLIP of this.clips) {
      let orientation = 0;
      for (let i = 0; i < CLIP.length; i++) {
        orientation += CLIP[i].x * CLIP[(i + 1) % CLIP.length].y - CLIP[(i + 1) % CLIP.length].x * CLIP[i].y;
      }
      const DIRECTION = orientation >= 0 ? 1 : -1;
      for (let i = 0; i < CLIP.length; i++) {
        const P = CLIP[i], Q = CLIP[(i + 1) % CLIP.length], SIDE = (v) => DIRECTION * ((Q.x - P.x) * (v.y - P.y) - (Q.y - P.y) * (v.x - P.x)), OUT = [];
        let prev = poly.at(-1);
        let pv = SIDE(prev);
        for (const CUR of poly) {
          const CV = SIDE(CUR);
          if (pv < -1e-8 !== CV < -1e-8) {
            const T = pv / (pv - CV), VERTEX_LOCAL = {
              x: prev.x + (CUR.x - prev.x) * T,
              y: prev.y + (CUR.y - prev.y) * T
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
  _emitTriangle(a, b, c, color2, uv = null) {
    rgba(color2);
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
        const POINT = i === 0 ? a : i === 1 ? b : c, K = this.count++ * 8;
        DATA[K] = POINT.x;
        DATA[K + 1] = POINT.y;
        DATA[K + 2] = DATA[K + 3] = 0;
        DATA.set(color2, K + 4);
      }
      return;
    }
    const POLY = this.clips.length ? this._clipTriangle(a, b, c, uv) : uv ? [a, b, c].map((point2, i) => ({
      ...point2,
      u: uv[i][0],
      v: uv[i][1]
    })) : [a, b, c];
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
        this.vertices.set(color2, K + 4);
      }
    }
  }
  _submit() {
    if (!this.count) {
      return;
    }
    this.device.stats.vectorSubmissions++;
    const TEXTURE = this.activeTexture ?? this.white, GRADIENT = this.activeGradient, RADIAL = this.activeRadial;
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
        ...RADIAL ? {
          u_radial: GRADIENT?.radialEmpty ? 2 : 1,
          u_radial_params: GRADIENT?.radialParams ?? [0, 0, 0, 0]
        } : {}
      },
      textures: [TEXTURE],
      blend: "source-over",
      stencil: this.stencilDepth ? {
        func: "equal",
        ref: this.stencilDepth,
        mask: 255,
        writeMask: 0,
        pass: "keep"
      } : false
    });
    this.count = 0;
  }
  _useTexture(texture, { radial = false, whiteFlash = false, gradient = null } = {}) {
    if (this.activeTexture !== texture || this.activeRadial !== radial || this.activeWhiteFlash !== whiteFlash || this.activeGradient?.gradient !== gradient?.gradient) {
      this._submit();
    }
    this.activeTexture = texture;
    this.activeRadial = radial;
    this.activeWhiteFlash = whiteFlash;
    this.activeGradient = gradient;
  }
  fill(colorValue = [0, 0, 0, 1], rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") {
      throw new TypeError("rule must be nonzero or evenodd");
    }
    this._useTexture(this.white);
    this.device.stats.pathTessellations++;
    const COL = rgba(colorValue), VERTICES = tessellate(this.path, rule);
    for (let i = 0; i + 2 < VERTICES.length; i += 3) {
      this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], COL);
    }
  }
  fillRadialGradient(gradient) {
    this._frame();
    if (!gradient?.texture || !gradient.matrixInverse || !Number.isFinite(gradient.radialScale) || gradient.radialScale <= 0 || !Array.isArray(gradient.radialParams) || gradient.radialParams.length !== 4 || gradient.radialParams.some((value) => !Number.isFinite(value))) {
      throw new TypeError("valid two-circle radial gradient texture and transform are required");
    }
    this._useTexture(gradient.texture, {
      radial: true,
      whiteFlash: gradient.whiteFlash,
      gradient
    });
    this.device.stats.pathTessellations++;
    const VERTICES = tessellate(this.path, gradient.rule ?? "nonzero");
    for (let i = 0; i + 2 < VERTICES.length; i += 3) {
      this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], gradient.color);
    }
  }
  fillLinearGradient(gradient) {
    this._frame();
    if (!gradient?.texture || !gradient.matrixInverse || ![gradient.x0, gradient.y0, gradient.x1, gradient.y1].every(Number.isFinite)) {
      throw new TypeError("valid linear gradient texture and transform are required");
    }
    this._useTexture(gradient.texture, {
      whiteFlash: gradient.whiteFlash,
      gradient
    });
    const VERTICES = tessellate(this.path, gradient.rule ?? "nonzero");
    for (let i = 0; i + 2 < VERTICES.length; i += 3) {
      this._emitTriangle(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], gradient.color);
    }
  }
  _gradientUV(p) {
    const G = this.activeGradient, M = G.matrixInverse, X = M[0] * p.x + M[2] * p.y + M[4], Y = M[1] * p.x + M[3] * p.y + M[5];
    if (this.activeRadial) {
      return [(X - G.x0) / G.radialScale, (Y - G.y0) / G.radialScale];
    }
    const DX = G.x1 - G.x0, DY = G.y1 - G.y0, DENOM = DX * DX + DY * DY;
    return [DENOM ? ((X - G.x0) * DX + (Y - G.y0) * DY) / DENOM : 1, 0.5];
  }
  stroke(colorValue = [0, 0, 0, 1], width = 1, { lineCap = "butt", lineJoin = "miter", miterLimit = 10 } = {}, gradient = null) {
    this._frame();
    this._useTexture(gradient?.texture ?? this.white, {
      radial: gradient?.kind === "radial",
      whiteFlash: gradient?.whiteFlash ?? false,
      gradient
    });
    this.device.stats.pathStrokeBuilds++;
    rgba(colorValue);
    if (!Number.isFinite(width) || width <= 0) {
      throw new RangeError("line width must be positive");
    }
    if (!["butt", "round", "square"].includes(lineCap) || !["miter", "round", "bevel"].includes(lineJoin) || !Number.isFinite(miterLimit) || miterLimit <= 0) {
      throw new TypeError("invalid stroke style");
    }
    const HALF = width / 2, FAN = (center, points) => {
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
      const COUNT = CLOSED ? CONTOUR.length : CONTOUR.length - 1, DIRS = [], NORMALS = [];
      for (let i = 0; i < COUNT; i++) {
        const A = CONTOUR[i], B = CONTOUR[(i + 1) % CONTOUR.length], DX = B.x - A.x, DY = B.y - A.y, L = Math.hypot(DX, DY);
        if (!L) {
          DIRS.push({
            x: 0,
            y: 0
          });
          NORMALS.push({
            x: 0,
            y: 0
          });
          continue;
        }
        DIRS.push({
          x: DX / L,
          y: DY / L
        });
        NORMALS.push({
          x: -DY / L * HALF,
          y: DX / L * HALF
        });
      }
      for (let i = 0; i < COUNT; i++) {
        const A = CONTOUR[i], B = CONTOUR[(i + 1) % CONTOUR.length], D = DIRS[i], N = NORMALS[i];
        if (!D.x && !D.y) {
          continue;
        }
        const EXTEND = !CLOSED && lineCap === "square" && (i === 0 || i === COUNT - 1) ? HALF : 0, AX = A.x - D.x * EXTEND, AY = A.y - D.y * EXTEND, BX = B.x + D.x * EXTEND, BY = B.y + D.y * EXTEND, P = {
          x: AX + N.x,
          y: AY + N.y
        }, Q = {
          x: BX + N.x,
          y: BY + N.y
        }, R = {
          x: BX - N.x,
          y: BY - N.y
        }, S = {
          x: AX - N.x,
          y: AY - N.y
        };
        this._emitTriangle(P, Q, R, colorValue);
        this._emitTriangle(P, R, S, colorValue);
      }
      const JOIN_START = CLOSED ? 0 : 1, JOIN_END = CLOSED ? CONTOUR.length : CONTOUR.length - 1;
      for (let i = JOIN_START; i < JOIN_END; i++) {
        const PREV = (i - 1 + COUNT) % COUNT, NEXT = i % COUNT, V = CONTOUR[i % CONTOUR.length], D0 = DIRS[PREV], D1 = DIRS[NEXT], N0 = NORMALS[PREV], N1 = NORMALS[NEXT], CROSS = D0.x * D1.y - D0.y * D1.x;
        if (Math.abs(CROSS) < 1e-8) {
          continue;
        }
        const SIGN = CROSS > 0 ? -1 : 1, A = {
          x: V.x + N0.x * SIGN,
          y: V.y + N0.y * SIGN
        }, B = {
          x: V.x + N1.x * SIGN,
          y: V.y + N1.y * SIGN
        };
        if (lineJoin === "round") {
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
          const STEPS = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 8))), ARC = [A];
          for (let j = 1; j <= STEPS; j++) {
            const T = START + sweep * j / STEPS;
            ARC.push({
              x: V.x + Math.cos(T) * HALF,
              y: V.y + Math.sin(T) * HALF
            });
          }
          FAN(V, ARC);
        } else if (lineJoin === "miter") {
          const MX = N0.x * SIGN + N1.x * SIGN, MY = N0.y * SIGN + N1.y * SIGN, ML = Math.hypot(MX, MY), DENOM = ML ? MX / ML * (N1.x * SIGN) + MY / ML * (N1.y * SIGN) : 0, MITER = DENOM ? HALF / DENOM : Infinity;
          if (Number.isFinite(MITER) && Math.abs(MITER) <= HALF * miterLimit) {
            const TIP = {
              x: V.x + MX / ML * MITER,
              y: V.y + MY / ML * MITER
            };
            this._emitTriangle(A, TIP, B, colorValue);
          } else {
            this._emitTriangle(V, A, B, colorValue);
          }
        } else {
          this._emitTriangle(V, A, B, colorValue);
        }
      }
      if (!CLOSED && lineCap === "round") {
        for (const [INDEX, ANGLE] of [
          [0, Math.atan2(DIRS[0].y, DIRS[0].x) + Math.PI],
          [COUNT - 1, Math.atan2(DIRS[COUNT - 1].y, DIRS[COUNT - 1].x)]
        ]) {
          const V = CONTOUR[INDEX === 0 ? 0 : CONTOUR.length - 1], START = ANGLE - Math.PI / 2, ARC = [];
          for (let j = 0; j <= 8; j++) {
            const T = START + Math.PI * j / 8;
            ARC.push({
              x: V.x + Math.cos(T) * HALF,
              y: V.y + Math.sin(T) * HALF
            });
          }
          FAN(V, ARC);
        }
      }
    }
  }
  polygon(points, colorValue = [0, 0, 0, 1]) {
    this.beginPath();
    points.forEach((p, i) => i ? this.lineTo(p[0], p[1]) : this.moveTo(p[0], p[1]));
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
    const M = this.matrix, ANCHOR = point(M, points[0][0], points[0][1]);
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
      throw new Error("GlyphAtlas is not configured");
    }
    return this.glyphAtlas.fillText(this, text, x, y, options);
  }
  strokeText(text, x, y, options = {}) {
    this._frame();
    if (!this.glyphAtlas) {
      throw new Error("GlyphAtlas is not configured");
    }
    return this.glyphAtlas.strokeText(this, text, x, y, options);
  }
  measureText(text, options = {}) {
    if (!this.glyphAtlas) {
      throw new Error("GlyphAtlas is not configured");
    }
    return this.glyphAtlas.measureText(text, options);
  }
  drawGlyphQuad(texture, x, y, width, height, uv, colorValue) {
    this._frame();
    this._useTexture(texture);
    const A = {
      ...point(this.matrix, x, y)
    }, B = {
      ...point(this.matrix, x + width, y)
    }, C = {
      ...point(this.matrix, x + width, y + height)
    }, D = {
      ...point(this.matrix, x, y + height)
    };
    this._emitTriangle(A, B, C, colorValue, [
      [uv.u0, uv.v0],
      [uv.u1, uv.v0],
      [uv.u1, uv.v1]
    ]);
    this._emitTriangle(A, C, D, colorValue, [
      [uv.u0, uv.v0],
      [uv.u1, uv.v1],
      [uv.u0, uv.v1]
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
      throw new RangeError("group opacity must be in [0,1]");
    }
    this._submit();
    if (opacity === 1) {
      this.groups.push({
        direct: true
      });
      return;
    }
    const REQUESTED = bounds ?? {
      x: 0,
      y: 0,
      width: this.canvas.width,
      height: this.canvas.height
    };
    for (const KEY of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(REQUESTED[KEY])) {
        throw new TypeError(`group bounds.${KEY} must be finite`);
      }
    }
    if (REQUESTED.width <= 0 || REQUESTED.height <= 0) {
      throw new RangeError("group bounds must have positive size");
    }
    const X = Math.max(0, Math.floor(REQUESTED.x)), Y = Math.max(0, Math.floor(REQUESTED.y)), RIGHT = Math.min(this.canvas.width, Math.ceil(REQUESTED.x + REQUESTED.width)), BOTTOM = Math.min(this.canvas.height, Math.ceil(REQUESTED.y + REQUESTED.height)), WIDTH = RIGHT - X, HEIGHT = BOTTOM - Y;
    if (WIDTH <= 0 || HEIGHT <= 0) {
      this.groups.push({
        direct: true,
        empty: true
      });
      return;
    }
    const DEPTH = this.groups.filter((g) => !g.direct).length;
    let target = this.groupTargets[DEPTH];
    const ALLOCATION = (n) => Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(n))), NEED_W = ALLOCATION(WIDTH), NEED_H = ALLOCATION(HEIGHT), NEED_STENCIL = this.device.stencilAvailable;
    if (!target || target.width < WIDTH || target.height < HEIGHT || Boolean(this.device.renderTargets.get(target)?.stencil) !== NEED_STENCIL) {
      if (target) {
        this.device.deleteRenderTarget(target);
      }
      target = this.groupTargets[DEPTH] = this.device.createRenderTarget(NEED_W, NEED_H, {
        filter: "nearest",
        stencil: NEED_STENCIL
      });
    }
    const GROUP = {
      target,
      opacity,
      bounds: {
        x: X,
        y: Y,
        width: WIDTH,
        height: HEIGHT
      },
      matrix: this.matrix.slice(),
      clips: this.clips,
      stencilClips: this.stencilClips.slice(),
      projection: this.projection.slice()
    };
    this.device.bindRenderTarget(target);
    this.groups.push(GROUP);
    this._setProjection(GROUP.bounds, target);
    this.device.clear({
      color: [0, 0, 0, 0],
      ...this.device.activeStencilAvailable ? {
        stencil: 0
      } : {}
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
          y: Y
        },
        {
          x: RIGHT,
          y: Y
        },
        {
          x: RIGHT,
          y: BOTTOM
        },
        {
          x: X,
          y: BOTTOM
        }
      ]
    ];
  }
  endGroup() {
    this._frame();
    const GROUP = this.groups.pop();
    if (!GROUP) {
      throw new Error("endGroup without beginGroup");
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
    const { x: X, y: Y, width: WIDTH, height: HEIGHT } = GROUP.bounds, U = WIDTH / GROUP.target.width, V = HEIGHT / GROUP.target.height, A = {
      x: X,
      y: Y
    }, B = {
      x: X + WIDTH,
      y: Y
    }, C = {
      x: X + WIDTH,
      y: Y + HEIGHT
    }, D = {
      x: X,
      y: Y + HEIGHT
    }, ALPHA = [1, 1, 1, GROUP.opacity];
    this._emitTriangle(A, B, C, ALPHA, [
      [0, 1],
      [U, 1],
      [U, 1 - V]
    ]);
    this._emitTriangle(A, C, D, ALPHA, [
      [0, 1],
      [U, 1 - V],
      [0, 1 - V]
    ]);
    this._submit();
    this._useTexture(this.white);
  }
  dispose() {
    if (this.state === "disposed") {
      return;
    }
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
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
    this.buffer = this.dynamicClipBuffer = this.clipPipeline = this.nonRadialPipeline = this.pipeline = this.white = null;
    this.state = "disposed";
  }
};

// modules/rendering/mesh-renderer.js
var IDENTITY2 = Object.freeze([1, 0, 0, 1, 0, 0]);
var ZERO_MORPH = Object.freeze([0, 0]);
var EMPTY_CLIP = Object.freeze({
  key: "",
  values: null,
  count: 0
});
var WHITE = Object.freeze([1, 1, 1, 1]);
var ATTRIBUTES = [
  {
    name: "a_position",
    size: 2,
    offset: 0
  },
  {
    name: "a_color",
    size: 4,
    offset: 8
  },
  {
    name: "a_morph",
    size: 4,
    offset: 24
  },
  {
    name: "a_part",
    size: 1,
    offset: 40
  }
];
var INSTANCE_ATTRIBUTES = ["i_row0", "i_row1", "i_color", "i_params"].map((name, i) => ({
  name,
  size: 4,
  offset: i * 16,
  source: "instance"
}));
var WORLD_INSTANCE_ATTRIBUTES = ["i_row0", "i_row1", "i_row2", "i_params"].map((name, i) => ({
  name,
  size: 4,
  offset: i * 16,
  source: "instance"
}));
function shader(instanced, partCount, morphCount, clipped, nonScalingStroke, worldMode = false) {
  const INPUTS = ["i_row0", "i_row1", "i_color", "i_params"].map((name) => `${instanced ? "attribute" : "uniform"} vec4 ${name};`).join("\n");
  const LOCAL = morphCount ? "a_position+a_morph.xy*(i_params.x" + (partCount > 1 ? "+pose.x" : "") + ")" + (morphCount > 1 ? "+a_morph.zw*(i_params.y" + (partCount > 1 ? "+pose.y" : "") + ")" : "") : "a_position";
  const STROKE_INPUTS = nonScalingStroke ? "attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;" : "";
  const STROKE_VARYING = clipped && nonScalingStroke ? "uniform mat3 u_inverseProjection;" : "";
  const STROKE_POSITION = nonScalingStroke ? `
vec2 tangentLocal=local+a_stroke.xy;
vec2 tangentPart=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))" : "tangentLocal"};
vec2 tangentWorld=vec2(dot(i_row0.xyz,vec3(tangentPart,1.0)),dot(i_row1.xyz,vec3(tangentPart,1.0)));
vec3 tangentProjected=u_projection*vec3(tangentWorld,1.0);
vec2 tangent=(tangentProjected.xy/tangentProjected.z-projected.xy/projected.z)*u_strokeViewportSize*0.5;float tangentLength=length(tangent);
if(dot(a_stroke.xy,a_stroke.xy)>0.5){
  if(tangentLength<0.000001){projected.z=0.0;}
  else{
    tangent/=tangentLength;vec2 normal=vec2(-tangent.y,tangent.x);
    vec2 pxOffset=tangent*a_stroke.z+normal*a_stroke.w;
    vec2 clipOffset=pxOffset*2.0/u_strokeViewportSize;
    projected.xy+=clipOffset*projected.z;
    ${clipped ? "vec3 clippedWorld=u_inverseProjection*vec3(projected.xy,projected.z);v_position=clippedWorld.xy/clippedWorld.z;" : ""}
  }
}` : "";
  if (worldMode) {
    const WORLD_INPUTS = ["i_row0", "i_row1", "i_row2", "i_params"].map((name) => `${instanced ? "attribute" : "uniform"} vec4 ${name};`).join("\n");
    const WORLD_STROKE_INPUTS = nonScalingStroke ? "attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;" + (clipped ? "uniform mat4 u_inverseViewProjection;" : "") : "";
    const WORLD_STROKE = nonScalingStroke ? `
vec2 tangentLocal=local+a_stroke.xy;
vec2 tangentPlane=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))" : "tangentLocal"};
vec3 tangentWorld=vec3(dot(i_row0.xyz,vec3(tangentPlane,1.0)),dot(i_row1.xyz,vec3(tangentPlane,1.0)),dot(i_row2.xyz,vec3(tangentPlane,1.0)));
vec4 tangentProjected=u_viewProjection*vec4(tangentWorld,1.0);vec2 tangent=(tangentProjected.xy/tangentProjected.w-projected.xy/projected.w)*u_strokeViewportSize*0.5;float tangentLength=length(tangent);
if(dot(a_stroke.xy,a_stroke.xy)>0.5){
  if(tangentLength<0.000001){projected.w=0.0;}
  else{tangent/=tangentLength;vec2 normal=vec2(-tangent.y,tangent.x);vec2 pxOffset=tangent*a_stroke.z+normal*a_stroke.w;
    projected.xy+=pxOffset*2.0/u_strokeViewportSize*projected.w;${clipped ? "vec4 clippedWorld=u_inverseViewProjection*projected;v_position=clippedWorld.xy/clippedWorld.w;" : ""}}
}` : "";
    return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? "attribute vec4 a_morph;" : ""} ${partCount > 1 ? "attribute float a_part;uniform vec4 u_parts[" + partCount * 3 + "];" : ""}
${WORLD_INPUTS}${WORLD_STROKE_INPUTS}
uniform mat4 u_viewProjection; uniform vec4 u_color; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}
void main(){${partCount > 1 ? "int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];" : ""}
vec2 local=${LOCAL};vec2 plane=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec3 world=vec3(dot(i_row0.xyz,vec3(plane,1.0)),dot(i_row1.xyz,vec3(plane,1.0)),dot(i_row2.xyz,vec3(plane,1.0)));
vec4 projected=u_viewProjection*vec4(world,1.0);${clipped ? "v_position=world.xy;" : ""}${WORLD_STROKE}
projected.z+=(i_params.w+${partCount > 1 ? "pose.w" : "0.0"})*projected.w;gl_Position=projected;
vec4 color=mix(a_color*u_color,u_color,i_row1.w);color.a*=i_row0.w${partCount > 1 ? "*pose.z" : ""};color.rgb=mix(color.rgb,vec3(1.0),i_row2.w);v_color=vec4(color.rgb*color.a,color.a);
}`;
  }
  return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? "attribute vec4 a_morph;" : ""} ${partCount > 1 ? "attribute float a_part;uniform vec4 u_parts[" + partCount * 3 + "];" : ""}
${INPUTS}${STROKE_INPUTS}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}${STROKE_VARYING}
void main(){${partCount > 1 ? "int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];" : ""}
vec2 local=${LOCAL};vec2 p=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? "v_position=world;" : ""}${STROKE_POSITION}
gl_Position=vec4(projected.xy,(i_params.w+${partCount > 1 ? "pose.w" : "0.0"})*projected.z,projected.z);
vec4 color=mix(a_color*i_color,i_color,i_row1.w);color.a*=i_row0.w${partCount > 1 ? "*pose.z" : ""};
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);}`;
}
function fragment(maxPlanes, clipped) {
  if (!clipped) {
    return "precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}";
  }
  return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}gl_FragColor=v_color;}`;
}
function finiteArray2(value, size, name) {
  if (!value || value.length !== size) {
    throw new TypeError(`${name}: ${size} finite numbers required`);
  }
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(value[i])) {
      throw new TypeError(`${name}: ${size} finite numbers required`);
    }
  }
}
function affineMatrix4(value, name) {
  finiteArray2(value, 16, name);
  if (Math.abs(value[3]) > 1e-7 || Math.abs(value[7]) > 1e-7 || Math.abs(value[11]) > 1e-7 || Math.abs(value[15] - 1) > 1e-7) {
    throw new TypeError(`${name} must be an affine column-major 4x4 matrix`);
  }
}
function invertMatrix4(matrix) {
  const ROWS = Array.from(
    {
      length: 4
    },
    (_, row) => [
      matrix[row],
      matrix[4 + row],
      matrix[8 + row],
      matrix[12 + row],
      ...row === 0 ? [1, 0, 0, 0] : row === 1 ? [0, 1, 0, 0] : row === 2 ? [0, 0, 1, 0] : [0, 0, 0, 1]
    ]
  );
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) {
      if (Math.abs(ROWS[row][column]) > Math.abs(ROWS[pivot][column])) {
        pivot = row;
      }
    }
    if (!Number.isFinite(ROWS[pivot][column]) || Math.abs(ROWS[pivot][column]) < 1e-12) {
      throw new RangeError("Clipped non-scaling strokes require an invertible viewProjection");
    }
    [ROWS[column], ROWS[pivot]] = [ROWS[pivot], ROWS[column]];
    const DIVISOR = ROWS[column][column];
    for (let j = 0; j < 8; j++) {
      ROWS[column][j] /= DIVISOR;
    }
    for (let row = 0; row < 4; row++) {
      if (row !== column) {
        const SCALE = ROWS[row][column];
        for (let j = 0; j < 8; j++) {
          ROWS[row][j] -= SCALE * ROWS[column][j];
        }
      }
    }
  }
  const INVERSE = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      INVERSE[column * 4 + row] = ROWS[row][column + 4];
    }
  }
  return INVERSE;
}
function invertProjection(projection) {
  const [A_LOCAL, D_LOCAL, G_LOCAL, B_LOCAL, E_LOCAL, H_LOCAL, C_LOCAL, F_LOCAL, I_LOCAL] = projection;
  const A = E_LOCAL * I_LOCAL - F_LOCAL * H_LOCAL, B = F_LOCAL * G_LOCAL - D_LOCAL * I_LOCAL, C = D_LOCAL * H_LOCAL - E_LOCAL * G_LOCAL, D = C_LOCAL * H_LOCAL - B_LOCAL * I_LOCAL, E = A_LOCAL * I_LOCAL - C_LOCAL * G_LOCAL, F = B_LOCAL * G_LOCAL - A_LOCAL * H_LOCAL, G = B_LOCAL * F_LOCAL - C_LOCAL * E_LOCAL, H = C_LOCAL * D_LOCAL - A_LOCAL * F_LOCAL, I = A_LOCAL * E_LOCAL - B_LOCAL * D_LOCAL;
  const DETERMINANT = A_LOCAL * A + B_LOCAL * B + C_LOCAL * C;
  if (!Number.isFinite(DETERMINANT) || Math.abs(DETERMINANT) < 1e-12) {
    throw new RangeError("Non-scaling strokes require an invertible projection");
  }
  return Float32Array.from([A, B, C, D, E, F, G, H, I], (value) => value / DETERMINANT);
}
function packParts(parts, count, output) {
  if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) {
    throw new TypeError("One pose per authored mesh part required");
  }
  for (let i = 0; i < count; i++) {
    const PART = parts?.[i], M = PART?.transform ?? IDENTITY2, MORPH = PART?.morph ?? ZERO_MORPH;
    finiteArray2(M, 6, "part transform");
    finiteArray2(MORPH, 2, "part morph");
    const OPACITY = PART?.opacity ?? 1;
    if (!Number.isFinite(OPACITY) || OPACITY < 0 || OPACITY > 1) {
      throw new RangeError("part opacity must be in [0,1]");
    }
    const AT = i * 12;
    output[AT] = M[0];
    output[AT + 1] = M[2];
    output[AT + 2] = M[4];
    output[AT + 3] = 0;
    output[AT + 4] = M[1];
    output[AT + 5] = M[3];
    output[AT + 6] = M[5];
    output[AT + 7] = 0;
    const DEPTH = PART?.depth ?? 0;
    if (!Number.isFinite(DEPTH) || DEPTH < -1 || DEPTH > 1) {
      throw new RangeError("part depth must be in [-1,1]");
    }
    output[AT + 8] = MORPH[0];
    output[AT + 9] = MORPH[1];
    output[AT + 10] = PART?.visible === false ? 0 : OPACITY;
    output[AT + 11] = DEPTH;
  }
}
function clipState(clips, maxPlanes) {
  if (!clips?.length) {
    return EMPTY_CLIP;
  }
  const VALUES = [], KEY = [];
  for (const POLYGON of clips) {
    if (!Array.isArray(POLYGON) || POLYGON.length < 3 || POLYGON.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
      throw new TypeError("Finite convex clip polygons required");
    }
    let area = 0;
    for (let i = 0; i < POLYGON.length; i++) {
      const P = POLYGON[i], Q = POLYGON[(i + 1) % POLYGON.length];
      area += P.x * Q.y - Q.x * P.y;
    }
    if (Math.abs(area) < 1e-12) {
      return {
        key: "empty",
        values: [0, 0, -1],
        count: 1
      };
    }
    const SIGN = area >= 0 ? 1 : -1;
    for (let i = 0; i < POLYGON.length; i++) {
      const P = POLYGON[i], Q = POLYGON[(i + 1) % POLYGON.length], DX = Q.x - P.x, DY = Q.y - P.y, LENGTH = Math.hypot(DX, DY);
      if (!LENGTH) {
        continue;
      }
      const A_LOCAL = -DY / LENGTH * SIGN, B_LOCAL = DX / LENGTH * SIGN, C_LOCAL = -(A_LOCAL * P.x + B_LOCAL * P.y);
      VALUES.push(A_LOCAL, B_LOCAL, C_LOCAL);
      KEY.push(A_LOCAL, B_LOCAL, C_LOCAL);
    }
  }
  if (VALUES.length / 3 > maxPlanes) {
    throw new RangeError(`Mesh clipping exceeds ${maxPlanes} edge planes`);
  }
  return {
    key: KEY.join(","),
    values: VALUES,
    count: VALUES.length / 3
  };
}
function meshPartBounds(vertices, partCount, morphCount) {
  const BOUNDS = Array.from(
    {
      length: partCount
    },
    () => ({
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      minDx0: Infinity,
      minDy0: Infinity,
      maxDx0: -Infinity,
      maxDy0: -Infinity,
      minDx1: Infinity,
      minDy1: Infinity,
      maxDx1: -Infinity,
      maxDy1: -Infinity
    })
  );
  for (let at = 0; at < vertices.length; at += 11) {
    const BOUND = BOUNDS[vertices[at + 10]], X = vertices[at], Y = vertices[at + 1];
    BOUND.minX = Math.min(BOUND.minX, X);
    BOUND.maxX = Math.max(BOUND.maxX, X);
    BOUND.minY = Math.min(BOUND.minY, Y);
    BOUND.maxY = Math.max(BOUND.maxY, Y);
    const DX0 = morphCount > 0 ? vertices[at + 6] : 0, DY0 = morphCount > 0 ? vertices[at + 7] : 0;
    const DX1 = morphCount > 1 ? vertices[at + 8] : 0, DY1 = morphCount > 1 ? vertices[at + 9] : 0;
    BOUND.minDx0 = Math.min(BOUND.minDx0, DX0);
    BOUND.maxDx0 = Math.max(BOUND.maxDx0, DX0);
    BOUND.minDy0 = Math.min(BOUND.minDy0, DY0);
    BOUND.maxDy0 = Math.max(BOUND.maxDy0, DY0);
    BOUND.minDx1 = Math.min(BOUND.minDx1, DX1);
    BOUND.maxDx1 = Math.max(BOUND.maxDx1, DX1);
    BOUND.minDy1 = Math.min(BOUND.minDy1, DY1);
    BOUND.maxDy1 = Math.max(BOUND.maxDy1, DY1);
  }
  for (const BOUND of BOUNDS) {
    if (!Number.isFinite(BOUND.minX)) {
      BOUND.minX = BOUND.minY = BOUND.maxX = BOUND.maxY = 0;
    }
    for (const KEY of ["minDx0", "minDy0", "maxDx0", "maxDy0", "minDx1", "minDy1", "maxDx1", "maxDy1"]) {
      if (!Number.isFinite(BOUND[KEY])) {
        BOUND[KEY] = 0;
      }
    }
  }
  return BOUNDS;
}
var MeshRenderer = class {
  constructor(device, { maxMeshes = 512, maxMeshBytes = 32 * 1024 * 1024, maxInstances = 2048, safeAlphaRunBatching = true } = {}) {
    for (const [KEY, VALUE] of Object.entries({
      maxMeshes,
      maxMeshBytes,
      maxInstances
    })) {
      if (!Number.isSafeInteger(VALUE) || VALUE < 1) {
        throw new RangeError(`${KEY} must be positive`);
      }
    }
    if (typeof safeAlphaRunBatching !== "boolean") {
      throw new TypeError("safeAlphaRunBatching must be a boolean");
    }
    this.device = device;
    this.maxMeshes = maxMeshes;
    this.maxMeshBytes = maxMeshBytes;
    this.maxInstances = maxInstances;
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    if (maxInstances * 64 > device.maxBufferBytes) {
      throw new RangeError("Mesh instance buffer exceeds device byte limit");
    }
    this.maxPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
    this.instanced = device.instancingSupported === true;
    this.instances = new Float32Array(maxInstances * 16);
    this.instanceBuffer = this.instanced ? device.createVertexBuffer({
      capacityBytes: this.instances.byteLength
    }) : null;
    this.pipelines = /* @__PURE__ */ new Map();
    this.meshes = /* @__PURE__ */ new Set();
    this.bytes = 0;
    this.count = 0;
    this.pending = null;
    this.planes = new Float32Array(this.maxPlanes * 3);
    this.partScratch = new Float32Array(16 * 12);
    this.alphaRunScratch = [];
    this.alphaRunCache = /* @__PURE__ */ new WeakMap();
    this.alphaQueue = new Array(maxInstances);
    this.alphaQueueBounds = {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0
    };
    this.alphaBoundsScratch = {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0
    };
    this.alphaQueueParts = new Float32Array(16 * 12);
    this.alphaQueueCount = 0;
    this.alphaQueueState = null;
    this.metrics = {
      draws: 0,
      instances: 0,
      geometryUploads: 0,
      geometryBytesUploaded: 0,
      instanceBytesUploaded: 0,
      partUniformBytesSubmitted: 0,
      alphaRunCacheHits: 0,
      alphaRunCacheMisses: 0,
      alphaRunSafeBatches: 0,
      alphaRunBatchedInstances: 0,
      alphaRunDrawsSaved: 0,
      alphaRunSafeRunDraws: 0,
      alphaRunImmediateRunDraws: 0,
      alphaRunOverlapBoundaries: 0,
      alphaRunSignatureBoundaries: 0,
      alphaRunUnbatchableBounds: 0,
      alphaRunImmediateInstances: 0,
      flushReasons: /* @__PURE__ */ Object.create(null),
      drawDispatchReasons: /* @__PURE__ */ Object.create(null)
    };
    this.state = "ready";
    this.failure = null;
    this.onLost = () => {
      this.discard();
      this.state = "lost";
    };
    this.onRestored = () => {
      try {
        if (this.instanced && !device.instancingSupported) {
          throw new Error("Restored context no longer supports mesh instancing");
        }
        for (const MESH of this.meshes) {
          device.uploadVertices(MESH.buffer, MESH.vertices);
          if (MESH.indices) {
            device.uploadIndices(MESH.indexBuffer, MESH.indices);
          }
          for (const VARIANT of MESH.expressionIndices.values()) {
            if (VARIANT.indices.length) {
              device.uploadIndices(VARIANT.indexBuffer, VARIANT.indices);
            }
          }
          for (const VARIANT of MESH.indexVariants.values()) {
            if (VARIANT.indices.length) {
              device.uploadIndices(VARIANT.indexBuffer, VARIANT.indices);
            }
          }
        }
        this.state = "ready";
        this.failure = null;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
      }
    };
    device.canvas.addEventListener("webglcontextlost", this.onLost);
    device.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.disposed = false;
  }
  _pipeline(mesh, clipped, worldMode = false) {
    const KEY = mesh.partCount + ":" + mesh.morphCount + ":" + Number(clipped) + ":" + Number(mesh.hasNonScalingStroke) + ":" + Number(worldMode);
    let pipeline = this.pipelines.get(KEY);
    if (pipeline) {
      return pipeline;
    }
    const UNIFORMS2 = worldMode ? {
      u_viewProjection: "matrix4fv",
      u_color: "4f"
    } : {
      u_projection: "matrix3fv"
    };
    if (clipped) {
      Object.assign(UNIFORMS2, {
        "u_planes[0]": "3fv",
        u_planeCount: "1i"
      });
    }
    if (clipped && worldMode && mesh.hasNonScalingStroke) {
      UNIFORMS2.u_inverseViewProjection = "matrix4fv";
    }
    if (mesh.hasNonScalingStroke) {
      UNIFORMS2.u_strokeViewportSize = "2f";
      if (clipped && !worldMode) {
        UNIFORMS2.u_inverseProjection = "matrix3fv";
      }
    }
    if (mesh.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = "4fv";
    }
    if (!this.instanced) {
      for (const NAME of worldMode ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"]) {
        UNIFORMS2[NAME] = "4f";
      }
    }
    pipeline = this.device.createPipeline({
      vertex: shader(
        this.instanced,
        mesh.partCount,
        mesh.morphCount,
        clipped,
        mesh.hasNonScalingStroke,
        worldMode
      ),
      fragment: fragment(this.maxPlanes, clipped),
      stride: mesh.strideFloats * 4,
      ...this.instanced ? {
        instanceStride: 64
      } : {},
      attributes: [
        ...mesh.hasNonScalingStroke ? ATTRIBUTES.filter((attribute) => attribute.name !== "a_morph") : ATTRIBUTES,
        ...mesh.hasNonScalingStroke ? [
          {
            name: "a_stroke",
            size: 4,
            offset: 24
          }
        ] : [],
        ...this.instanced ? worldMode ? WORLD_INSTANCE_ATTRIBUTES : INSTANCE_ATTRIBUTES : []
      ],
      uniforms: UNIFORMS2
    });
    this.pipelines.set(KEY, pipeline);
    return pipeline;
  }
  createMesh(data) {
    this._ready();
    const INDICES = data?.indices;
    const EXPRESSION_INDICES = data?.expressionIndices === void 0 ? {} : data.expressionIndices;
    const INDEX_VARIANTS = data?.indexVariants === void 0 ? {} : data.indexVariants;
    const NON_SCALING_STROKE = data?.nonScalingStroke ?? false;
    if (!(data?.vertices instanceof Float32Array) || data.vertices.length < 33 || data.vertices.length % 11 || data.strideFloats !== 11 || typeof NON_SCALING_STROKE !== "boolean" || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > 16 || !Number.isSafeInteger(data.morphCount) || data.morphCount < 0 || data.morphCount > 2 || INDICES !== void 0 && (!(INDICES instanceof Uint16Array) || INDICES.length < 3 || INDICES.length % 3 || data.vertices.length / 11 > 65536 || INDICES.some((index) => index >= data.vertices.length / 11)) || INDICES === void 0 && data.vertices.length % 33 || !EXPRESSION_INDICES || typeof EXPRESSION_INDICES !== "object" || Array.isArray(EXPRESSION_INDICES) || !INDEX_VARIANTS || typeof INDEX_VARIANTS !== "object" || Array.isArray(INDEX_VARIANTS)) {
      throw new TypeError("Mesh geometry with complete triangles and 1..16 parts required");
    }
    const EXPRESSION_ENTRIES = Object.entries(EXPRESSION_INDICES), INDEX_VARIANT_ENTRIES = Object.entries(INDEX_VARIANTS);
    const VARIANT_NAMES = new Set(EXPRESSION_ENTRIES.map(([name]) => name));
    if (EXPRESSION_ENTRIES.some(
      ([name, variant]) => !name || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= data.vertices.length / 11)
    ) || INDEX_VARIANT_ENTRIES.some(
      ([name, variant]) => !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || VARIANT_NAMES.has(name) || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= data.vertices.length / 11)
    )) {
      throw new TypeError("Invalid named mesh index variants or expression index variants");
    }
    if (data.vertices.some((n) => !Number.isFinite(n))) {
      throw new TypeError("Mesh values must be finite");
    }
    for (let i = 0; i < data.vertices.length; i++) {
      if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) {
        throw new RangeError("Mesh RGBA channels must be in [0,1]");
      }
      if (i % 11 === 10 && (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)) {
        throw new RangeError("Mesh part index outside partCount");
      }
      if (i % 11 >= 6 + data.morphCount * 2 && i % 11 < 10 && data.vertices[i] !== 0 && !NON_SCALING_STROKE) {
        throw new RangeError("Mesh deltas exceed declared morphCount");
      }
    }
    if (NON_SCALING_STROKE && data.morphCount) {
      throw new TypeError("Non-scaling stroke meshes cannot use vertex morph targets");
    }
    const VARIANT_BYTE_LENGTH = [...EXPRESSION_ENTRIES, ...INDEX_VARIANT_ENTRIES].reduce(
      (total, [, variant]) => total + variant.byteLength,
      0
    );
    const BYTE_LENGTH = data.vertices.byteLength + (INDICES?.byteLength ?? 0) + VARIANT_BYTE_LENGTH;
    if (this.meshes.size >= this.maxMeshes || this.bytes + BYTE_LENGTH > this.maxMeshBytes) {
      throw new RangeError("Retained mesh budget exceeded");
    }
    const VERTICES = data.vertices.slice(), OWNED_INDICES = INDICES?.slice(), BUFFER = this.device.createVertexBuffer({
      capacityBytes: VERTICES.byteLength
    });
    let indexBuffer;
    const OWNED_EXPRESSIONS = /* @__PURE__ */ new Map(), OWNED_VARIANTS = /* @__PURE__ */ new Map();
    try {
      this.device.uploadVertices(BUFFER, VERTICES);
      if (OWNED_INDICES) {
        indexBuffer = this.device.createIndexBuffer({
          capacityBytes: OWNED_INDICES.byteLength
        });
        this.device.uploadIndices(indexBuffer, OWNED_INDICES);
      }
      for (const [NAME, SOURCE] of EXPRESSION_ENTRIES) {
        const VARIANT_INDICES = SOURCE.slice();
        const VARIANT_BUFFER = VARIANT_INDICES.length ? this.device.createIndexBuffer({
          capacityBytes: VARIANT_INDICES.byteLength
        }) : null;
        const VARIANT = {
          indices: VARIANT_INDICES,
          indexBuffer: VARIANT_BUFFER,
          count: VARIANT_INDICES.length
        };
        OWNED_EXPRESSIONS.set(NAME, VARIANT);
        if (VARIANT_BUFFER) {
          this.device.uploadIndices(VARIANT_BUFFER, VARIANT_INDICES);
        }
      }
      for (const [NAME, SOURCE] of INDEX_VARIANT_ENTRIES) {
        const VARIANT_INDICES = SOURCE.slice();
        const VARIANT_BUFFER = VARIANT_INDICES.length ? this.device.createIndexBuffer({
          capacityBytes: VARIANT_INDICES.byteLength
        }) : null;
        const VARIANT = {
          indices: VARIANT_INDICES,
          indexBuffer: VARIANT_BUFFER,
          count: VARIANT_INDICES.length
        };
        OWNED_VARIANTS.set(NAME, VARIANT);
        if (VARIANT_BUFFER) {
          this.device.uploadIndices(VARIANT_BUFFER, VARIANT_INDICES);
        }
      }
    } catch (error) {
      for (const VARIANT of OWNED_EXPRESSIONS.values()) {
        if (VARIANT.indexBuffer) {
          this.device.deleteIndexBuffer(VARIANT.indexBuffer);
        }
      }
      for (const VARIANT of OWNED_VARIANTS.values()) {
        if (VARIANT.indexBuffer) {
          this.device.deleteIndexBuffer(VARIANT.indexBuffer);
        }
      }
      if (indexBuffer) {
        this.device.deleteIndexBuffer(indexBuffer);
      }
      this.device.deleteVertexBuffer(BUFFER);
      throw error;
    }
    const MESH = Object.freeze({
      renderer: this,
      buffer: BUFFER,
      indexBuffer,
      vertices: VERTICES,
      indices: OWNED_INDICES,
      expressionIndices: OWNED_EXPRESSIONS,
      indexVariants: OWNED_VARIANTS,
      count: OWNED_INDICES?.length ?? VERTICES.length / 11,
      byteLength: BYTE_LENGTH,
      partCount: data.partCount,
      morphCount: data.morphCount,
      strideFloats: 11,
      hasNonScalingStroke: NON_SCALING_STROKE,
      partBounds: meshPartBounds(VERTICES, data.partCount, data.morphCount)
    });
    this.meshes.add(MESH);
    this.bytes += BYTE_LENGTH;
    this.device.stats.meshCreates++;
    this.metrics.geometryUploads++;
    this.metrics.geometryBytesUploaded += BYTE_LENGTH;
    return MESH;
  }
  deleteMesh(mesh) {
    if (!this.meshes.has(mesh)) {
      return false;
    }
    if (this.pending?.mesh === mesh || this.alphaQueueCount && this.alphaQueueState.mesh === mesh) {
      this.flush("deleteMesh");
    }
    this.alphaRunCache.delete(mesh);
    this.device.deleteVertexBuffer(mesh.buffer);
    if (mesh.indexBuffer) {
      this.device.deleteIndexBuffer(mesh.indexBuffer);
    }
    for (const VARIANT of mesh.expressionIndices.values()) {
      if (VARIANT.indexBuffer) {
        this.device.deleteIndexBuffer(VARIANT.indexBuffer);
      }
    }
    for (const VARIANT of mesh.indexVariants.values()) {
      if (VARIANT.indexBuffer) {
        this.device.deleteIndexBuffer(VARIANT.indexBuffer);
      }
    }
    this.meshes.delete(mesh);
    this.bytes -= mesh.byteLength;
    return true;
  }
  /** Captures state by value; subsequent transform/paint changes do not alter queued instances. */
  drawMesh(mesh, options = {}) {
    const {
      matrix: MATRIX = IDENTITY2,
      projection: PROJECTION,
      morph: MORPH = [0, 0],
      parts: PARTS = null,
      color: COLOR = WHITE,
      forceColor: FORCE_COLOR = false,
      alpha: ALPHA = 1,
      whiteFlash: WHITE_FLASH = false,
      clips: CLIPS = [],
      depth: DEPTH = 0,
      depthTest: DEPTH_TEST = false,
      depthWrite: DEPTH_WRITE = false,
      depthWriteAlphaThreshold: DEPTH_WRITE_ALPHA_THRESHOLD = null,
      depthFunc: DEPTH_FUNC = "lequal",
      indexVariant: INDEX_VARIANT = null,
      indexRange: INDEX_RANGE = null,
      strokeViewport: STROKE_VIEWPORT = null,
      stencilRef: STENCIL_REF = null,
      viewProjection: VIEW_PROJECTION,
      worldMatrix: WORLD_MATRIX
    } = options;
    this._drawMeshInstances(mesh, {
      matrices: MATRIX,
      count: 1,
      projection: PROJECTION,
      viewProjection: VIEW_PROJECTION,
      worldMatrix: WORLD_MATRIX,
      morph: MORPH,
      parts: PARTS,
      color: COLOR,
      forceColor: FORCE_COLOR,
      alpha: ALPHA,
      whiteFlash: WHITE_FLASH,
      clips: CLIPS,
      indexVariant: INDEX_VARIANT,
      indexRange: INDEX_RANGE,
      depth: DEPTH,
      depthTest: DEPTH_TEST,
      depthWrite: DEPTH_WRITE,
      depthWriteAlphaThreshold: DEPTH_WRITE_ALPHA_THRESHOLD,
      depthFunc: DEPTH_FUNC,
      strokeViewport: STROKE_VIEWPORT,
      stencilRef: STENCIL_REF
    });
  }
  _screenBounds(mesh, matrices, instanceIndex, projection, morph) {
    if (mesh.hasNonScalingStroke || projection[2] !== 0 || projection[5] !== 0 || Math.abs(projection[8]) < 1e-12) {
      return null;
    }
    const WIDTH = this.device.activeRenderTarget?.width ?? this.device.canvas.width;
    const HEIGHT = this.device.activeRenderTarget?.height ?? this.device.canvas.height;
    const MATRIX_AT = instanceIndex * 6, M0 = matrices[MATRIX_AT], M1 = matrices[MATRIX_AT + 1], M2 = matrices[MATRIX_AT + 2], M3 = matrices[MATRIX_AT + 3], M4 = matrices[MATRIX_AT + 4], M5 = matrices[MATRIX_AT + 5];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let partIndex = 0; partIndex < mesh.partCount; partIndex++) {
      const BOUND = mesh.partBounds[partIndex], AT = partIndex * 12, POSE_MORPH0 = morph[0] + this.partScratch[AT + 8], POSE_MORPH1 = morph[1] + this.partScratch[AT + 9];
      const X0 = BOUND.minX + (POSE_MORPH0 < 0 ? BOUND.maxDx0 : BOUND.minDx0) * POSE_MORPH0 + (POSE_MORPH1 < 0 ? BOUND.maxDx1 : BOUND.minDx1) * POSE_MORPH1;
      const X1 = BOUND.maxX + (POSE_MORPH0 < 0 ? BOUND.minDx0 : BOUND.maxDx0) * POSE_MORPH0 + (POSE_MORPH1 < 0 ? BOUND.minDx1 : BOUND.maxDx1) * POSE_MORPH1;
      const Y0 = BOUND.minY + (POSE_MORPH0 < 0 ? BOUND.maxDy0 : BOUND.minDy0) * POSE_MORPH0 + (POSE_MORPH1 < 0 ? BOUND.maxDy1 : BOUND.minDy1) * POSE_MORPH1;
      const Y1 = BOUND.maxY + (POSE_MORPH0 < 0 ? BOUND.minDy0 : BOUND.maxDy0) * POSE_MORPH0 + (POSE_MORPH1 < 0 ? BOUND.minDy1 : BOUND.maxDy1) * POSE_MORPH1;
      const PA = this.partScratch[AT], PC = this.partScratch[AT + 1], PE = this.partScratch[AT + 2];
      const PB = this.partScratch[AT + 4], PD = this.partScratch[AT + 5], PF = this.partScratch[AT + 6];
      for (let xi = 0; xi < 2; xi++) {
        for (let yi = 0; yi < 2; yi++) {
          const X = xi ? X1 : X0, Y = yi ? Y1 : Y0, PART_X = PA * X + PC * Y + PE, PART_Y = PB * X + PD * Y + PF;
          const WORLD_X = M0 * PART_X + M2 * PART_Y + M4, WORLD_Y = M1 * PART_X + M3 * PART_Y + M5;
          const CLIP_X = projection[0] * WORLD_X + projection[3] * WORLD_Y + projection[6], CLIP_Y = projection[1] * WORLD_X + projection[4] * WORLD_Y + projection[7];
          const PX = (CLIP_X / projection[8] + 1) * WIDTH / 2, PY = (1 - CLIP_Y / projection[8]) * HEIGHT / 2;
          if (!Number.isFinite(PX) || !Number.isFinite(PY)) {
            return null;
          }
          minX = Math.min(minX, PX);
          maxX = Math.max(maxX, PX);
          minY = Math.min(minY, PY);
          maxY = Math.max(maxY, PY);
        }
      }
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    const BOUNDS = this.alphaBoundsScratch;
    BOUNDS.minX = minX - 1.5;
    BOUNDS.minY = minY - 1.5;
    BOUNDS.maxX = maxX + 1.5;
    BOUNDS.maxY = maxY + 1.5;
    return BOUNDS;
  }
  _boundsOverlap(a, b) {
    return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
  }
  _extendAlphaQueueBounds(bounds) {
    const GROUP = this.alphaQueueBounds;
    if (!this.alphaQueueCount) {
      Object.assign(GROUP, bounds);
    } else {
      GROUP.minX = Math.min(GROUP.minX, bounds.minX);
      GROUP.minY = Math.min(GROUP.minY, bounds.minY);
      GROUP.maxX = Math.max(GROUP.maxX, bounds.maxX);
      GROUP.maxY = Math.max(GROUP.maxY, bounds.maxY);
    }
  }
  _alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    const STATE = this.alphaQueueState;
    if (!STATE) {
      return true;
    }
    if (STATE.mesh !== mesh || STATE.indexVariant !== indexVariant || STATE.clip.key !== clip.key || STATE.stencilRef !== stencilRef || STATE.depthTest !== depthTest || STATE.depthFunc !== depthFunc || STATE.runKey !== runs.join(",") || projection.some((n, i) => Math.fround(n) !== STATE.projection[i])) {
      return false;
    }
    for (let i = 0; i < mesh.partCount * 12; i++) {
      if (this.partScratch[i] !== this.alphaQueueParts[i]) {
        return false;
      }
    }
    return true;
  }
  _startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    this.alphaQueueParts.set(this.partScratch.subarray(0, mesh.partCount * 12));
    this.alphaQueueState = {
      mesh,
      projection: Float32Array.from(projection),
      clip,
      stencilRef,
      depthTest,
      depthFunc,
      indexVariant,
      runs: runs.slice(),
      runKey: runs.join(",")
    };
  }
  _flushAlphaQueue(reason) {
    if (!this.alphaQueueCount) {
      return;
    }
    const STATE = this.alphaQueueState, MESH = STATE.mesh, PARTS = this.alphaQueueParts.subarray(0, MESH.partCount * 12);
    const INDEX_BUFFER_VARIANT = STATE.indexVariant === null ? null : MESH.indexVariants.get(STATE.indexVariant) ?? MESH.expressionIndices.get(STATE.indexVariant);
    const PROJECTION = STATE.projection, CLIP = STATE.clip, PIPELINE = this._pipeline(MESH, CLIP.count > 0), UNIFORMS2 = {
      u_projection: PROJECTION
    };
    this.planes.fill(0);
    if (CLIP.values) {
      this.planes.set(CLIP.values);
    }
    if (CLIP.count) {
      Object.assign(UNIFORMS2, {
        "u_planes[0]": this.planes,
        u_planeCount: CLIP.count
      });
    }
    if (MESH.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = PARTS;
    }
    const INSTANCES = this.alphaQueueCount;
    this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, INSTANCES * 16));
    this.metrics.instanceBytesUploaded += INSTANCES * 64;
    for (let run = 0; run < STATE.runs.length; run += 3) {
      this.device.draw({
        pipeline: PIPELINE,
        buffer: MESH.buffer,
        indexBuffer: INDEX_BUFFER_VARIANT?.indexBuffer ?? MESH.indexBuffer,
        first: STATE.runs[run],
        count: STATE.runs[run + 1],
        instanceBuffer: this.instanceBuffer,
        instances: INSTANCES,
        uniforms: UNIFORMS2,
        depth: {
          test: STATE.depthTest,
          write: STATE.runs[run + 2],
          func: STATE.depthFunc
        },
        stencil: STATE.stencilRef === null ? false : {
          func: "equal",
          ref: STATE.stencilRef,
          mask: 255,
          writeMask: 0,
          pass: "keep"
        }
      });
      this.metrics.draws++;
      this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
      this.metrics.alphaRunSafeRunDraws++;
      if (MESH.partCount > 1) {
        this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
      }
    }
    this.metrics.instances += INSTANCES;
    if (INSTANCES > 1) {
      this.metrics.alphaRunSafeBatches++;
      this.metrics.alphaRunBatchedInstances += INSTANCES;
      this.metrics.alphaRunDrawsSaved += (INSTANCES - 1) * (STATE.runs.length / 3);
    }
    this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
    this.alphaQueueCount = 0;
    this.alphaQueueState = null;
  }
  /** Internal ordered instance append used when one retained pose has several transforms. */
  _drawMeshInstances(mesh, {
    matrices,
    count,
    projection,
    viewProjection,
    worldMatrix,
    morph = [0, 0],
    parts = null,
    color: color2 = WHITE,
    forceColor = false,
    alpha = 1,
    whiteFlash = false,
    clips = [],
    prefixColor = null,
    prefixCount = 0,
    forceColorPrefixCount = 0,
    depth = 0,
    depthTest = false,
    depthWrite = false,
    depthWriteAlphaThreshold = null,
    depthFunc = "lequal",
    indexVariant = null,
    indexRange = null,
    strokeViewport = null,
    stencilRef = null
  } = {}) {
    this._ready();
    if (!this.meshes.has(mesh)) {
      throw new TypeError("Mesh owned by this renderer required");
    }
    if (indexVariant !== null && (typeof indexVariant !== "string" || !mesh.expressionIndices.has(indexVariant) && !mesh.indexVariants.has(indexVariant))) {
      throw new TypeError("Known mesh index variant required");
    }
    if (!this.device.active) {
      throw new Error("beginFrame required");
    }
    if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) {
      throw new RangeError("stencilRef must be null or in [0,255]");
    }
    if (stencilRef !== null && !this.device.activeStencilAvailable) {
      throw new Error("A stencil-tested mesh requires an active stencil attachment");
    }
    if (!Number.isSafeInteger(count) || count < 1 || !matrices || matrices.length !== count * 6) {
      throw new TypeError("Packed mesh instance matrices required");
    }
    for (let i = 0; i < matrices.length; i++) {
      if (!Number.isFinite(matrices[i])) {
        throw new TypeError("Mesh matrix values must be finite");
      }
    }
    const WORLD_MODE = viewProjection !== void 0 || worldMatrix !== void 0;
    if (WORLD_MODE) {
      if (projection !== void 0 || viewProjection === void 0 || worldMatrix === void 0) {
        throw new TypeError(
          "3D mesh draws require viewProjection and worldMatrix and cannot include projection"
        );
      }
      finiteArray2(viewProjection, 16, "viewProjection");
      affineMatrix4(worldMatrix, "worldMatrix");
    } else {
      finiteArray2(projection, 9, "projection");
    }
    finiteArray2(morph, 2, "morph");
    finiteArray2(color2, 4, "color");
    let strokeSize = null;
    let inverseStrokeProjection = null;
    let inverseViewProjection = null;
    if (mesh.hasNonScalingStroke) {
      if (strokeViewport === null) {
        if (this.device.activeRenderTarget) {
          throw new Error("A strokeViewport is required for non-scaling strokes rendered to a render target");
        }
        strokeSize = [this.device.canvas.clientWidth, this.device.canvas.clientHeight];
      } else {
        finiteArray2(strokeViewport, 2, "strokeViewport");
        strokeSize = [strokeViewport[0], strokeViewport[1]];
      }
      if (strokeSize.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new RangeError("Non-scaling strokes require a positive CSS-pixel viewport size");
      }
      if (!WORLD_MODE) {
        inverseStrokeProjection = invertProjection(projection);
      } else if (clipState(clips, this.maxPlanes).count) {
        inverseViewProjection = invertMatrix4(viewProjection);
      }
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color2.some((n) => n < 0 || n > 1)) {
      throw new RangeError("RGBA/alpha in [0,1] required");
    }
    if (!Number.isFinite(depth) || depth < -1 || depth > 1) {
      throw new RangeError("depth must be in [-1,1]");
    }
    if (typeof depthTest !== "boolean" || typeof depthWrite !== "boolean") {
      throw new TypeError("depthTest and depthWrite must be booleans");
    }
    if (depthWriteAlphaThreshold !== null && (!Number.isFinite(depthWriteAlphaThreshold) || depthWriteAlphaThreshold < 0 || depthWriteAlphaThreshold > 1)) {
      throw new RangeError("depthWriteAlphaThreshold must be in [0,1]");
    }
    if (WORLD_MODE && depthWriteAlphaThreshold !== null) {
      throw new TypeError("depthWriteAlphaThreshold is currently supported only for 2D mesh draws");
    }
    if (!["never", "less", "equal", "lequal", "greater", "notequal", "gequal", "always"].includes(depthFunc)) {
      throw new TypeError("Unsupported depthFunc");
    }
    if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > count || !Number.isSafeInteger(forceColorPrefixCount) || forceColorPrefixCount < 0 || forceColorPrefixCount > count) {
      throw new RangeError("Instance color prefix count is invalid");
    }
    if (prefixCount && !prefixColor) {
      throw new TypeError("A prefix color is required for colored mesh instances");
    }
    if (prefixColor !== null) {
      finiteArray2(prefixColor, 4, "prefix color");
      if (prefixColor.some((n) => n < 0 || n > 1)) {
        throw new RangeError("RGBA channels must be in [0,1]");
      }
    }
    if (WORLD_MODE && (prefixCount || forceColorPrefixCount)) {
      throw new TypeError("Per-instance color prefixes are not supported for 3D mesh draws");
    }
    if (indexRange !== null && (indexVariant !== null || !Array.isArray(indexRange) || indexRange.length !== 2 || !Number.isSafeInteger(indexRange[0]) || !Number.isSafeInteger(indexRange[1]) || indexRange[0] < 0 || indexRange[1] < 0 || indexRange[0] % 3 || indexRange[1] % 3)) {
      throw new TypeError(
        "indexRange must be [firstIndex, triangleAlignedCount] and cannot be combined with indexVariant"
      );
    }
    if (indexRange !== null && depthWriteAlphaThreshold !== null) {
      throw new TypeError("indexRange is currently supported only for ordinary ordered mesh draws");
    }
    const CLIP = clipState(clips, this.maxPlanes), PENDING = this.pending;
    const VARIANT = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    const FIRST_INDEX = indexRange?.[0] ?? 0, INDEX_COUNT = indexRange?.[1] ?? VARIANT?.count ?? mesh.count;
    if (FIRST_INDEX + INDEX_COUNT > (VARIANT?.count ?? mesh.count)) {
      throw new RangeError("indexRange exceeds the selected mesh index data");
    }
    packParts(parts, mesh.partCount, this.partScratch);
    for (let i = 0; i < mesh.partCount; i++) {
      if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) {
        throw new RangeError("combined mesh and part depth must be in [-1,1]");
      }
    }
    const DEPTH_STATE_KEY = Number(depthTest) + ":" + Number(depthWrite) + ":" + depthFunc;
    const ALPHA_DEPTH_WRITE = depthWrite && depthWriteAlphaThreshold !== null;
    if (!ALPHA_DEPTH_WRITE) {
      if (this.alphaQueueCount) {
        this._flushAlphaQueue("alphaBoundary");
      }
      if (PENDING) {
        const MATRIX = WORLD_MODE ? viewProjection : projection;
        const PREVIOUS_COLOR = PENDING.color;
        const REASON = PENDING.mesh !== mesh ? "mesh" : PENDING.worldMode !== WORLD_MODE ? "transformMode" : PENDING.indexVariant !== indexVariant ? "indexVariant" : PENDING.firstIndex !== FIRST_INDEX || PENDING.indexCount !== INDEX_COUNT ? "indexRange" : PENDING.clip.key !== CLIP.key ? "clip" : PENDING.stencilRef !== stencilRef ? "stencil" : PENDING.depthStateKey !== DEPTH_STATE_KEY ? "depthState" : MATRIX.some((n, i) => Math.fround(n) !== PENDING.projection[i]) ? "projection" : strokeSize && strokeSize.some((n, i) => n !== PENDING.strokeSize?.[i]) ? "strokeViewport" : WORLD_MODE && color2.some((n, i) => n !== PREVIOUS_COLOR[i]) ? "color" : mesh.partCount > 1 && PENDING.parts.some((n, i) => n !== this.partScratch[i]) ? "parts" : this.count === this.maxInstances ? "capacity" : null;
        if (REASON) {
          this.flush(REASON);
        }
      }
      if (VARIANT?.count === 0) {
        return;
      }
      const PART2 = this.partScratch, SINGLE_PART2 = mesh.partCount === 1;
      for (let i = 0; i < count; i++) {
        if (this.count === this.maxInstances) {
          this.flush("capacity");
        }
        if (!this.pending) {
          this.pending = {
            mesh,
            projection: Float32Array.from(WORLD_MODE ? viewProjection : projection),
            worldMode: WORLD_MODE,
            color: Float32Array.from(color2),
            clip: CLIP,
            stencilRef,
            depthStateKey: DEPTH_STATE_KEY,
            indexVariant,
            firstIndex: FIRST_INDEX,
            indexCount: INDEX_COUNT,
            strokeSize,
            inverseStrokeProjection,
            inverseViewProjection,
            depthState: {
              test: depthTest,
              write: depthWrite,
              func: depthFunc
            },
            parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0)
          };
        }
        const OFFSET = i * 6;
        let m0 = matrices[OFFSET];
        let m1 = matrices[OFFSET + 1];
        let m2 = matrices[OFFSET + 2];
        let m3 = matrices[OFFSET + 3];
        let m4 = matrices[OFFSET + 4];
        let m5 = matrices[OFFSET + 5];
        let weight0 = morph[0];
        let weight1 = morph[1];
        let instanceAlpha = alpha;
        if (SINGLE_PART2) {
          const A_LOCAL = m0, B_LOCAL = m1, C_LOCAL = m2, D_LOCAL = m3;
          m0 = A_LOCAL * PART2[0] + C_LOCAL * PART2[4];
          m1 = B_LOCAL * PART2[0] + D_LOCAL * PART2[4];
          m2 = A_LOCAL * PART2[1] + C_LOCAL * PART2[5];
          m3 = B_LOCAL * PART2[1] + D_LOCAL * PART2[5];
          m4 = A_LOCAL * PART2[2] + C_LOCAL * PART2[6] + m4;
          m5 = B_LOCAL * PART2[2] + D_LOCAL * PART2[6] + m5;
          instanceAlpha *= PART2[10];
          weight0 += PART2[8];
          weight1 += PART2[9];
        }
        const INSTANCE_COLOR = i < prefixCount ? prefixColor : color2;
        const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor, AT = this.count++ * 16, DATA = this.instances;
        const INSTANCE_DEPTH = depth + (SINGLE_PART2 ? PART2[11] : 0);
        if (WORLD_MODE) {
          DATA[AT] = worldMatrix[0] * m0 + worldMatrix[4] * m1;
          DATA[AT + 1] = worldMatrix[0] * m2 + worldMatrix[4] * m3;
          DATA[AT + 2] = worldMatrix[0] * m4 + worldMatrix[4] * m5 + worldMatrix[12];
          DATA[AT + 3] = instanceAlpha;
          DATA[AT + 4] = worldMatrix[1] * m0 + worldMatrix[5] * m1;
          DATA[AT + 5] = worldMatrix[1] * m2 + worldMatrix[5] * m3;
          DATA[AT + 6] = worldMatrix[1] * m4 + worldMatrix[5] * m5 + worldMatrix[13];
          DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
          DATA[AT + 8] = worldMatrix[2] * m0 + worldMatrix[6] * m1;
          DATA[AT + 9] = worldMatrix[2] * m2 + worldMatrix[6] * m3;
          DATA[AT + 10] = worldMatrix[2] * m4 + worldMatrix[6] * m5 + worldMatrix[14];
          DATA[AT + 11] = whiteFlash ? 1 : 0;
          DATA[AT + 12] = weight0;
          DATA[AT + 13] = weight1;
          DATA[AT + 14] = 0;
          DATA[AT + 15] = INSTANCE_DEPTH;
        } else {
          DATA[AT] = m0;
          DATA[AT + 1] = m2;
          DATA[AT + 2] = m4;
          DATA[AT + 3] = instanceAlpha;
          DATA[AT + 4] = m1;
          DATA[AT + 5] = m3;
          DATA[AT + 6] = m5;
          DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
          DATA[AT + 8] = INSTANCE_COLOR[0];
          DATA[AT + 9] = INSTANCE_COLOR[1];
          DATA[AT + 10] = INSTANCE_COLOR[2];
          DATA[AT + 11] = INSTANCE_COLOR[3];
          DATA[AT + 12] = weight0;
          DATA[AT + 13] = weight1;
          DATA[AT + 14] = whiteFlash ? 1 : 0;
          DATA[AT + 15] = INSTANCE_DEPTH;
        }
      }
      return;
    }
    if (VARIANT?.count === 0) {
      return;
    }
    const INDICES = VARIANT?.indices ?? mesh.indices;
    const TRIANGLE_COUNT = (VARIANT?.count ?? mesh.count) / 3;
    const PART = this.partScratch, SINGLE_PART = mesh.partCount === 1;
    const WRITE_ALPHA_INSTANCE = (i, slot) => {
      const OFFSET = i * 6;
      let m0 = matrices[OFFSET];
      let m1 = matrices[OFFSET + 1];
      let m2 = matrices[OFFSET + 2];
      let m3 = matrices[OFFSET + 3];
      let m4 = matrices[OFFSET + 4];
      let m5 = matrices[OFFSET + 5];
      let weight0 = morph[0];
      let weight1 = morph[1];
      let instanceAlpha = alpha;
      if (SINGLE_PART) {
        const A_LOCAL = m0, B_LOCAL = m1, C_LOCAL = m2, D_LOCAL = m3;
        m0 = A_LOCAL * PART[0] + C_LOCAL * PART[4];
        m1 = B_LOCAL * PART[0] + D_LOCAL * PART[4];
        m2 = A_LOCAL * PART[1] + C_LOCAL * PART[5];
        m3 = B_LOCAL * PART[1] + D_LOCAL * PART[5];
        m4 = A_LOCAL * PART[2] + C_LOCAL * PART[6] + m4;
        m5 = B_LOCAL * PART[2] + D_LOCAL * PART[6] + m5;
        instanceAlpha *= PART[10];
        weight0 += PART[8];
        weight1 += PART[9];
      }
      const INSTANCE_COLOR = i < prefixCount ? prefixColor : color2;
      const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor, AT = slot * 16, DATA = this.instances;
      DATA[AT] = m0;
      DATA[AT + 1] = m2;
      DATA[AT + 2] = m4;
      DATA[AT + 3] = instanceAlpha;
      DATA[AT + 4] = m1;
      DATA[AT + 5] = m3;
      DATA[AT + 6] = m5;
      DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
      DATA[AT + 8] = INSTANCE_COLOR[0];
      DATA[AT + 9] = INSTANCE_COLOR[1];
      DATA[AT + 10] = INSTANCE_COLOR[2];
      DATA[AT + 11] = INSTANCE_COLOR[3];
      DATA[AT + 12] = weight0;
      DATA[AT + 13] = weight1;
      DATA[AT + 14] = whiteFlash ? 1 : 0;
      DATA[AT + 15] = depth + (SINGLE_PART ? PART[11] : 0);
    };
    for (let i = 0; i < count; i++) {
      const INSTANCE_COLOR = i < prefixCount ? prefixColor : color2;
      const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor;
      const RUNS = this._collectAlphaDepthRuns(
        mesh,
        INDICES,
        TRIANGLE_COUNT,
        depthWriteAlphaThreshold,
        alpha * INSTANCE_COLOR[3],
        INSTANCE_FORCE_COLOR,
        indexVariant
      );
      const TOTAL_VERTICES = TRIANGLE_COUNT * 3;
      const ONE_RUN = RUNS.length === 3 && RUNS[0] === 0 && RUNS[1] === TOTAL_VERTICES;
      if (!ONE_RUN) {
        const BOUNDS = this.safeAlphaRunBatching && this.instanced ? this._screenBounds(mesh, matrices, i, projection, morph) : null;
        if (BOUNDS) {
          if (this.count) {
            this.flush("alphaDepthBoundary");
          }
          if (this.alphaQueueCount && !this._alphaQueueMatches(
            mesh,
            projection,
            CLIP,
            stencilRef,
            depthTest,
            depthFunc,
            indexVariant,
            RUNS
          )) {
            this.metrics.alphaRunSignatureBoundaries++;
            this._flushAlphaQueue("alphaSignature");
          }
          if (this.alphaQueueCount && this._boundsOverlap(BOUNDS, this.alphaQueueBounds)) {
            this.metrics.alphaRunOverlapBoundaries++;
            this._flushAlphaQueue("alphaOverlap");
          }
          if (this.alphaQueueCount === this.maxInstances) {
            this._flushAlphaQueue("capacity");
          }
          if (!this.alphaQueueCount) {
            this._startAlphaQueue(
              mesh,
              projection,
              CLIP,
              stencilRef,
              depthTest,
              depthFunc,
              indexVariant,
              RUNS
            );
          }
          this._extendAlphaQueueBounds(BOUNDS);
          const SLOT = this.alphaQueueCount;
          WRITE_ALPHA_INSTANCE(i, SLOT);
          this.alphaQueueCount++;
          continue;
        }
        if (this.safeAlphaRunBatching) {
          this.metrics.alphaRunUnbatchableBounds++;
        }
        if (this.alphaQueueCount) {
          this._flushAlphaQueue("alphaUnsupportedBoundary");
        }
        if (this.count) {
          this.flush("alphaImmediateBoundary");
        }
        WRITE_ALPHA_INSTANCE(i, 0);
        this._drawAlphaDepthRuns(
          mesh,
          VARIANT,
          projection,
          CLIP,
          PART.subarray(0, mesh.partCount * 12),
          RUNS,
          depthTest,
          depthFunc,
          strokeSize,
          inverseStrokeProjection,
          stencilRef
        );
        this.metrics.alphaRunImmediateInstances++;
        this.metrics.alphaRunImmediateRunDraws += RUNS.length / 3;
        continue;
      }
      if (this.alphaQueueCount) {
        this._flushAlphaQueue("singleRunBoundary");
      }
      const WRITE = RUNS[2], STATE_KEY = Number(depthTest) + ":" + Number(WRITE) + ":" + depthFunc;
      if (this.pending) {
        const CURRENT = this.pending, REASON = CURRENT.mesh !== mesh ? "mesh" : CURRENT.worldMode ? "transformMode" : CURRENT.indexVariant !== indexVariant ? "indexVariant" : CURRENT.firstIndex !== FIRST_INDEX || CURRENT.indexCount !== INDEX_COUNT ? "indexRange" : CURRENT.clip.key !== CLIP.key ? "clip" : CURRENT.stencilRef !== stencilRef ? "stencil" : CURRENT.depthStateKey !== STATE_KEY ? "depthState" : projection.some((n, j) => Math.fround(n) !== CURRENT.projection[j]) ? "projection" : strokeSize && strokeSize.some((n, j) => n !== CURRENT.strokeSize?.[j]) ? "strokeViewport" : mesh.partCount > 1 && CURRENT.parts.some((n, j) => n !== this.partScratch[j]) ? "parts" : this.count === this.maxInstances ? "capacity" : null;
        if (REASON) {
          this.flush(REASON);
        }
      }
      if (!this.pending) {
        this.pending = {
          mesh,
          projection: Float32Array.from(projection),
          worldMode: false,
          clip: CLIP,
          stencilRef,
          depthStateKey: STATE_KEY,
          indexVariant,
          firstIndex: FIRST_INDEX,
          indexCount: INDEX_COUNT,
          strokeSize,
          inverseStrokeProjection,
          inverseViewProjection,
          depthState: {
            test: depthTest,
            write: WRITE,
            func: depthFunc
          },
          parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0)
        };
      }
      const OFFSET = i * 6;
      let m0 = matrices[OFFSET];
      let m1 = matrices[OFFSET + 1];
      let m2 = matrices[OFFSET + 2];
      let m3 = matrices[OFFSET + 3];
      let m4 = matrices[OFFSET + 4];
      let m5 = matrices[OFFSET + 5];
      let weight0 = morph[0];
      let weight1 = morph[1];
      let instanceAlpha = alpha;
      if (SINGLE_PART) {
        const A_LOCAL = m0, B_LOCAL = m1, C_LOCAL = m2, D_LOCAL = m3;
        m0 = A_LOCAL * PART[0] + C_LOCAL * PART[4];
        m1 = B_LOCAL * PART[0] + D_LOCAL * PART[4];
        m2 = A_LOCAL * PART[1] + C_LOCAL * PART[5];
        m3 = B_LOCAL * PART[1] + D_LOCAL * PART[5];
        m4 = A_LOCAL * PART[2] + C_LOCAL * PART[6] + m4;
        m5 = B_LOCAL * PART[2] + D_LOCAL * PART[6] + m5;
        instanceAlpha *= PART[10];
        weight0 += PART[8];
        weight1 += PART[9];
      }
      const AT = this.count++ * 16, DATA = this.instances;
      DATA[AT] = m0;
      DATA[AT + 1] = m2;
      DATA[AT + 2] = m4;
      DATA[AT + 3] = instanceAlpha;
      DATA[AT + 4] = m1;
      DATA[AT + 5] = m3;
      DATA[AT + 6] = m5;
      DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
      DATA[AT + 8] = INSTANCE_COLOR[0];
      DATA[AT + 9] = INSTANCE_COLOR[1];
      DATA[AT + 10] = INSTANCE_COLOR[2];
      DATA[AT + 11] = INSTANCE_COLOR[3];
      DATA[AT + 12] = weight0;
      DATA[AT + 13] = weight1;
      DATA[AT + 14] = whiteFlash ? 1 : 0;
      DATA[AT + 15] = depth + (SINGLE_PART ? PART[11] : 0);
    }
  }
  _collectAlphaDepthRuns(mesh, indices, triangleCount, threshold, opacity, forceColor, indexVariant) {
    let cache = this.alphaRunCache.get(mesh);
    if (!cache) {
      cache = /* @__PURE__ */ new Map();
      this.alphaRunCache.set(mesh, cache);
    }
    const PART_OPACITIES = [];
    for (let i = 0; i < mesh.partCount; i++) {
      PART_OPACITIES.push(this.partScratch[i * 12 + 10]);
    }
    const KEY = JSON.stringify([indexVariant, threshold, opacity, forceColor, PART_OPACITIES]);
    const CACHED = cache.get(KEY);
    if (CACHED) {
      cache.delete(KEY);
      cache.set(KEY, CACHED);
      this.metrics.alphaRunCacheHits++;
      return CACHED;
    }
    this.metrics.alphaRunCacheMisses++;
    const RUNS = this.alphaRunScratch;
    RUNS.length = 0;
    if (opacity < threshold) {
      RUNS.push(0, triangleCount * 3, false);
    } else {
      let runStart = 0;
      let runWrite = null;
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        let write = true;
        for (let corner = 0; corner < 3; corner++) {
          const INDEX_OFFSET = triangle * 3 + corner, VERTEX_OFFSET = (indices ? indices[INDEX_OFFSET] : INDEX_OFFSET) * mesh.strideFloats;
          const PART_INDEX = mesh.vertices[VERTEX_OFFSET + 10];
          const VERTEX_ALPHA = forceColor ? 1 : mesh.vertices[VERTEX_OFFSET + 5];
          const EFFECTIVE_ALPHA = opacity * VERTEX_ALPHA * this.partScratch[PART_INDEX * 12 + 10];
          if (EFFECTIVE_ALPHA <= 0 || EFFECTIVE_ALPHA < threshold) {
            write = false;
            break;
          }
        }
        if (runWrite === null) {
          runStart = triangle;
          runWrite = write;
        } else if (write !== runWrite) {
          RUNS.push(runStart * 3, (triangle - runStart) * 3, runWrite);
          runStart = triangle;
          runWrite = write;
        }
      }
      if (runWrite !== null) {
        RUNS.push(runStart * 3, (triangleCount - runStart) * 3, runWrite);
      }
    }
    if (RUNS.length <= 64) {
      const STABLE_RUNS = RUNS.slice();
      if (cache.size >= 16) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(KEY, STABLE_RUNS);
      return STABLE_RUNS;
    }
    this.alphaRunScratch = [];
    return RUNS;
  }
  _drawAlphaDepthRuns(mesh, variant, projection, clip, parts, runs, depthTest, depthFunc, strokeSize, inverseStrokeProjection, stencilRef) {
    this.planes.fill(0);
    if (clip.values) {
      this.planes.set(clip.values);
    }
    const PIPELINE = this._pipeline(mesh, clip.count > 0), UNIFORMS2 = {
      u_projection: projection
    };
    if (clip.count) {
      Object.assign(UNIFORMS2, {
        "u_planes[0]": this.planes,
        u_planeCount: clip.count
      });
    }
    if (mesh.hasNonScalingStroke) {
      Object.assign(UNIFORMS2, {
        u_strokeViewportSize: strokeSize,
        ...clip.count ? {
          u_inverseProjection: inverseStrokeProjection
        } : {}
      });
    }
    if (mesh.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = parts;
    }
    if (!this.instanced) {
      for (let j = 0; j < 4; j++) {
        UNIFORMS2[["i_row0", "i_row1", "i_color", "i_params"][j]] = this.instances.subarray(j * 4, j * 4 + 4);
      }
    } else {
      const INSTANCE = this.instances.subarray(0, 16);
      this.device.uploadVertices(this.instanceBuffer, INSTANCE);
      this.metrics.instanceBytesUploaded += INSTANCE.byteLength;
    }
    const INDEX_BUFFER = variant?.indexBuffer ?? mesh.indexBuffer;
    for (let run = 0; run < runs.length; run += 3) {
      this.device.draw({
        pipeline: PIPELINE,
        buffer: mesh.buffer,
        indexBuffer: INDEX_BUFFER,
        first: runs[run],
        count: runs[run + 1],
        instanceBuffer: this.instanceBuffer,
        instances: 1,
        uniforms: UNIFORMS2,
        depth: {
          test: depthTest,
          write: runs[run + 2],
          func: depthFunc
        },
        stencil: stencilRef === null ? false : {
          func: "equal",
          ref: stencilRef,
          mask: 255,
          writeMask: 0,
          pass: "keep"
        }
      });
      this.metrics.draws++;
      this.metrics.drawDispatchReasons.alphaImmediateRun = (this.metrics.drawDispatchReasons.alphaImmediateRun ?? 0) + 1;
      if (mesh.partCount > 1) {
        this.metrics.partUniformBytesSubmitted += parts.byteLength;
      }
    }
    this.metrics.instances++;
  }
  flush(reason = "explicit") {
    if (this.alphaQueueCount) {
      this._flushAlphaQueue(reason);
    }
    if (!this.count) {
      return;
    }
    this._ready();
    const {
      mesh: MESH,
      projection: PROJECTION,
      worldMode: WORLD_MODE,
      color: COLOR,
      clip: CLIP,
      parts: PARTS,
      depthState: DEPTH_STATE,
      indexVariant: INDEX_VARIANT,
      firstIndex: FIRST_INDEX,
      indexCount: INDEX_COUNT,
      strokeSize: STROKE_SIZE,
      inverseStrokeProjection: INVERSE_STROKE_PROJECTION,
      inverseViewProjection: INVERSE_VIEW_PROJECTION,
      stencilRef: STENCIL_REF
    } = this.pending;
    const VARIANT = INDEX_VARIANT === null ? null : MESH.indexVariants.get(INDEX_VARIANT) ?? MESH.expressionIndices.get(INDEX_VARIANT);
    this.planes.fill(0);
    if (CLIP.values) {
      this.planes.set(CLIP.values);
    }
    const PIPELINE = this._pipeline(MESH, CLIP.count > 0, WORLD_MODE), UNIFORMS2 = WORLD_MODE ? {
      u_viewProjection: PROJECTION,
      u_color: COLOR
    } : {
      u_projection: PROJECTION
    };
    if (CLIP.count) {
      Object.assign(UNIFORMS2, {
        "u_planes[0]": this.planes,
        u_planeCount: CLIP.count
      });
    }
    if (MESH.hasNonScalingStroke) {
      Object.assign(UNIFORMS2, {
        u_strokeViewportSize: STROKE_SIZE,
        ...CLIP.count ? WORLD_MODE ? {
          u_inverseViewProjection: INVERSE_VIEW_PROJECTION
        } : {
          u_inverseProjection: INVERSE_STROKE_PROJECTION
        } : {}
      });
    }
    if (MESH.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = PARTS;
    }
    const INSTANCE_UNIFORMS = WORLD_MODE ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"];
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, this.count * 16));
      this.device.draw({
        pipeline: PIPELINE,
        buffer: MESH.buffer,
        indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
        first: FIRST_INDEX,
        count: INDEX_COUNT,
        instanceBuffer: this.instanceBuffer,
        instances: this.count,
        uniforms: UNIFORMS2,
        depth: DEPTH_STATE,
        stencil: STENCIL_REF === null ? false : {
          func: "equal",
          ref: STENCIL_REF,
          mask: 255,
          writeMask: 0,
          pass: "keep"
        }
      });
      this.metrics.instanceBytesUploaded += this.count * 64;
      this.metrics.draws++;
      this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
      if (MESH.partCount > 1) {
        this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < 4; j++) {
          UNIFORMS2[INSTANCE_UNIFORMS[j]] = this.instances.subarray(i * 16 + j * 4, i * 16 + j * 4 + 4);
        }
        this.device.draw({
          pipeline: PIPELINE,
          buffer: MESH.buffer,
          indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
          first: FIRST_INDEX,
          count: INDEX_COUNT,
          uniforms: UNIFORMS2,
          depth: DEPTH_STATE,
          stencil: STENCIL_REF === null ? false : {
            func: "equal",
            ref: STENCIL_REF,
            mask: 255,
            writeMask: 0,
            pass: "keep"
          }
        });
        this.metrics.draws++;
        this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
        if (MESH.partCount > 1) {
          this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
        }
      }
    }
    this.metrics.instances += this.count;
    this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
    this.discard();
  }
  discard() {
    this.count = 0;
    this.pending = null;
    this.alphaQueueCount = 0;
    this.alphaQueueState = null;
  }
  _ready() {
    if (this.state !== "ready" || this.disposed) {
      throw new Error(`MeshRenderer is ${this.state}${this.failure ? ": " + this.failure : ""}`);
    }
  }
  beginFrame() {
    this.discard();
    for (const KEY of Object.keys(this.metrics)) {
      if (KEY !== "flushReasons" && KEY !== "drawDispatchReasons") {
        this.metrics[KEY] = 0;
      }
    }
    this.metrics.flushReasons = /* @__PURE__ */ Object.create(null);
    this.metrics.drawDispatchReasons = /* @__PURE__ */ Object.create(null);
  }
  stats() {
    return {
      ...this.metrics,
      flushReasons: {
        ...this.metrics.flushReasons
      },
      drawDispatchReasons: {
        ...this.metrics.drawDispatchReasons
      },
      pendingAlphaRunInstances: this.alphaQueueCount,
      safeAlphaRunBatching: this.safeAlphaRunBatching,
      state: this.state,
      failure: this.failure,
      pipelineCount: this.pipelines.size,
      meshCount: this.meshes.size,
      retainedBytes: this.bytes,
      stagingBytes: this.instances.byteLength + this.planes.byteLength + this.partScratch.byteLength,
      instanced: this.instanced,
      maxClipPlanes: this.maxPlanes
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.discard();
    this.device.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const MESH of this.meshes) {
      this.device.deleteVertexBuffer(MESH.buffer);
      if (MESH.indexBuffer) {
        this.device.deleteIndexBuffer(MESH.indexBuffer);
      }
      for (const VARIANT of MESH.expressionIndices.values()) {
        if (VARIANT.indexBuffer) {
          this.device.deleteIndexBuffer(VARIANT.indexBuffer);
        }
      }
      for (const VARIANT of MESH.indexVariants.values()) {
        if (VARIANT.indexBuffer) {
          this.device.deleteIndexBuffer(VARIANT.indexBuffer);
        }
      }
    }
    this.meshes.clear();
    this.bytes = 0;
    this.alphaRunCache = /* @__PURE__ */ new WeakMap();
    this.alphaRunScratch.length = 0;
    if (this.instanceBuffer) {
      this.device.deleteVertexBuffer(this.instanceBuffer);
    }
    for (const PIPELINE of this.pipelines.values()) {
      this.device.deletePipeline(PIPELINE);
    }
    this.pipelines.clear();
    this.disposed = true;
    this.state = "disposed";
  }
};

// modules/rendering/primitive-renderer.js
var MAX_INSTANCES = 2048;
var MAX_CLIP_PLANES = 32;
var INSTANCE_STRIDE_FLOATS = 16;
var INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
var QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
var INSTANCE_VERTEX = "attribute vec2 a_position;attribute vec4 i_row0;attribute vec4 i_row1;attribute vec4 i_color;attribute vec4 i_params;uniform mat3 u_projection;varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;varying vec4 v_color;varying vec4 v_params;void main(){vec2 p=vec2(i_row0.x*a_position.x+i_row0.y*a_position.y+i_row0.z,i_row1.x*a_position.x+i_row1.y*a_position.y+i_row1.z);vec3 q=u_projection*vec3(p,1.0);gl_Position=vec4(q.xy,0.0,1.0);v_local=a_position;v_world=p;v_row0=i_row0;v_row1=i_row1;v_color=i_color;v_params=i_params;}";
var UNIFORM_VERTEX = "attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;uniform vec4 u_color;uniform vec4 u_params;varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;varying vec4 v_color;varying vec4 v_params;void main(){vec3 p=u_transform*vec3(a_position,1.0);vec3 q=u_projection*p;gl_Position=vec4(q.xy,0.0,1.0);v_local=a_position;v_world=p.xy;v_row0=vec4(u_transform[0][0],u_transform[1][0],u_transform[2][0],0.0);v_row1=vec4(u_transform[0][1],u_transform[1][1],u_transform[2][1],0.0);v_color=u_color;v_params=u_params;}";
var FRAGMENT_SHADER = "precision mediump float;varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;varying vec4 v_color;varying vec4 v_params;uniform vec3 u_planes[32];uniform int u_planeCount;void main(){for(int i=0;i<32;i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_world,1.0))<0.0)discard;}float kind=v_params.x;float stroke=v_params.y;float width=v_params.z;float option=v_params.w;float d=1.0;if(kind<0.5){if(stroke<0.5){if(length(v_local)>1.0)discard;}else{float ql=length(v_local);vec2 n=ql>0.000001?v_local/ql:vec2(1.0,0.0);float det=v_row0.x*v_row1.y-v_row0.y*v_row1.x;vec2 g=vec2(v_row1.y*n.x-v_row1.x*n.y,-v_row0.y*n.x+v_row0.x*n.y)/max(abs(det),0.000001);d=(ql-1.0)/max(length(g),0.000001);if(abs(d)>width*0.5)discard;}}else if(kind<1.5){if(stroke<0.5){if(max(abs(v_local.x),abs(v_local.y))>1.0)discard;}else{float sx=length(vec2(v_row0.x,v_row1.x));float sy=length(vec2(v_row0.y,v_row1.y));if(option>0.5){float ox=1.0+width/(2.0*max(sx,0.000001));float oy=1.0+width/(2.0*max(sy,0.000001));float ix=max(0.0,1.0-width/(2.0*max(sx,0.000001)));float iy=max(0.0,1.0-width/(2.0*max(sy,0.000001)));if(max(abs(v_local.x)/ox,abs(v_local.y)/oy)>1.0||max(abs(v_local.x)/max(ix,0.000001),abs(v_local.y)/max(iy,0.000001))<1.0)discard;}else{vec2 q=(abs(v_local)-vec2(1.0))*vec2(sx,sy);float sd=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0);if(abs(sd)>width*0.5)discard;}}}else{float halfLength=length(vec2(v_row0.x,v_row1.x));float halfWidth=length(vec2(v_row0.y,v_row1.y));float x=v_local.x*halfLength;float y=v_local.y*halfWidth;float center=halfLength-(option>0.5?halfWidth:0.0);if(option<0.5){d=max(abs(x)-center,abs(y)-halfWidth);}else if(option<1.5){d=max(abs(x)-center-halfWidth,abs(y)-halfWidth);}else{d=length(vec2(max(abs(x)-center,0.0),y))-halfWidth;}if(d>0.0)discard;}gl_FragColor=vec4(v_color.rgb*v_color.a,v_color.a);}";
function createClipState(clips) {
  const VALUES = [];
  const KEY = [];
  for (const POLYGON of clips) {
    let area = 0;
    for (let i = 0; i < POLYGON.length; i++) {
      const P = POLYGON[i];
      const Q = POLYGON[(i + 1) % POLYGON.length];
      area += P.x * Q.y - Q.x * P.y;
    }
    if (Math.abs(area) < 1e-12) {
      VALUES.push(0, 0, -1);
      KEY.push("empty");
      continue;
    }
    const SIGN = area >= 0 ? 1 : -1;
    for (let i = 0; i < POLYGON.length; i++) {
      const P = POLYGON[i];
      const Q = POLYGON[(i + 1) % POLYGON.length];
      const DX = Q.x - P.x;
      const DY = Q.y - P.y;
      const LENGTH = Math.hypot(DX, DY);
      if (!LENGTH) {
        continue;
      }
      const A = -DY / LENGTH * SIGN;
      const B = DX / LENGTH * SIGN;
      const C = -(A * P.x + B * P.y);
      VALUES.push(A, B, C);
      KEY.push(A, B, C);
    }
  }
  if (VALUES.length / 3 > MAX_CLIP_PLANES) {
    return null;
  }
  return {
    key: KEY.join(","),
    values: Float32Array.from(VALUES),
    count: VALUES.length / 3
  };
}
function stencilState(stencilRef) {
  return stencilRef === null ? false : {
    func: "equal",
    ref: stencilRef,
    mask: 255,
    writeMask: 0,
    pass: "keep"
  };
}
function transformUniform(matrix) {
  return new Float32Array([matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]);
}
var PrimitiveRenderer = class {
  constructor(device) {
    if (!device?.createVertexBuffer || !device?.createPipeline || !device?.draw) {
      throw new TypeError("WebGLDevice is required");
    }
    this.device = device;
    this.instanced = device.instancingSupported === true;
    this.vertexBuffer = device.createVertexBuffer({
      capacityBytes: QUAD_VERTICES.byteLength
    });
    device.uploadVertices(this.vertexBuffer, QUAD_VERTICES);
    this.instanceBuffer = this.instanced ? device.createVertexBuffer({
      capacityBytes: MAX_INSTANCES * INSTANCE_STRIDE_BYTES
    }) : null;
    this.instances = this.instanced ? new Float32Array(MAX_INSTANCES * INSTANCE_STRIDE_FLOATS) : null;
    this.pipeline = device.createPipeline({
      vertex: this.instanced ? INSTANCE_VERTEX : UNIFORM_VERTEX,
      fragment: FRAGMENT_SHADER,
      stride: 8,
      instanceStride: this.instanced ? INSTANCE_STRIDE_BYTES : 0,
      attributes: [
        {
          name: "a_position",
          size: 2,
          offset: 0
        },
        ...this.instanced ? [
          {
            name: "i_row0",
            size: 4,
            offset: 0,
            source: "instance"
          },
          {
            name: "i_row1",
            size: 4,
            offset: 16,
            source: "instance"
          },
          {
            name: "i_color",
            size: 4,
            offset: 32,
            source: "instance"
          },
          {
            name: "i_params",
            size: 4,
            offset: 48,
            source: "instance"
          }
        ] : []
      ],
      uniforms: {
        u_projection: "matrix3fv",
        "u_planes[0]": "3fv",
        u_planeCount: "1i",
        ...this.instanced ? {} : {
          u_transform: "matrix3fv",
          u_color: "4f",
          u_params: "4f"
        }
      }
    });
    this.pendingCount = 0;
    this.pendingState = null;
    this.frameStats = this._emptyStats();
    this.total = this._emptyStats();
    this.disposed = false;
    this.onLost = () => {
      this.pendingCount = 0;
      this.pendingState = null;
    };
    this.onRestored = () => {
      if (this.disposed) {
        return;
      }
      try {
        this.device.uploadVertices(this.vertexBuffer, QUAD_VERTICES);
      } catch {
        this.pendingCount = 0;
        this.pendingState = null;
      }
    };
    device.canvas.addEventListener("webglcontextlost", this.onLost);
    device.canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _emptyStats() {
    return {
      instances: 0,
      instanceUploads: 0,
      instanceBytesUploaded: 0,
      draws: 0,
      instancedDraws: 0,
      flushes: 0
    };
  }
  beginFrame() {
    this.frameStats = this._emptyStats();
  }
  _sameState(state, next) {
    if (state.clip.key !== next.clip.key || state.stencilRef !== next.stencilRef || state.projection.length !== next.projection.length) {
      return false;
    }
    for (let i = 0; i < state.projection.length; i++) {
      if (state.projection[i] !== next.projection[i]) {
        return false;
      }
    }
    return true;
  }
  draw({ matrix, color: color2, params, projection, clips, stencilRef = null }) {
    if (this.disposed) {
      throw new Error("PrimitiveRenderer is disposed");
    }
    const CLIP = createClipState(clips);
    if (!CLIP) {
      return false;
    }
    const NEXT_STATE = {
      clip: CLIP,
      projection,
      stencilRef
    };
    if (this.pendingCount && !this._sameState(this.pendingState, NEXT_STATE)) {
      this.flush("stateChange");
    }
    if (!this.instanced) {
      this.pendingState = NEXT_STATE;
      this._drawUniform(matrix, color2, params, NEXT_STATE);
      this.frameStats.instances++;
      this.frameStats.draws++;
      this.total.instances++;
      this.total.draws++;
      return true;
    }
    if (this.pendingCount === MAX_INSTANCES) {
      this.flush("capacity");
    }
    if (!this.pendingCount) {
      this.pendingState = NEXT_STATE;
    }
    const AT = this.pendingCount++ * INSTANCE_STRIDE_FLOATS;
    this.instances.set([matrix[0], matrix[2], matrix[4], 0], AT);
    this.instances.set([matrix[1], matrix[3], matrix[5], 0], AT + 4);
    this.instances.set(color2, AT + 8);
    this.instances.set(params, AT + 12);
    this.frameStats.instances++;
    this.total.instances++;
    return true;
  }
  _drawUniform(matrix, color2, params, state) {
    const UNIFORMS2 = {
      u_projection: state.projection,
      u_transform: transformUniform(matrix),
      u_color: color2,
      u_params: params,
      u_planeCount: state.clip.count
    };
    if (state.clip.count) {
      UNIFORMS2["u_planes[0]"] = state.clip.values;
    }
    this.device.draw({
      pipeline: this.pipeline,
      buffer: this.vertexBuffer,
      count: QUAD_VERTICES.length / 2,
      uniforms: UNIFORMS2,
      blend: "source-over",
      stencil: stencilState(state.stencilRef)
    });
  }
  flush(reason = "explicit") {
    if (!this.pendingCount) {
      return;
    }
    const STATE = this.pendingState;
    const BYTES = this.pendingCount * INSTANCE_STRIDE_BYTES;
    const UNIFORMS2 = {
      u_projection: STATE.projection,
      u_planeCount: STATE.clip.count
    };
    if (STATE.clip.count) {
      UNIFORMS2["u_planes[0]"] = STATE.clip.values;
    }
    this.device.uploadVertices(
      this.instanceBuffer,
      this.instances.subarray(0, this.pendingCount * INSTANCE_STRIDE_FLOATS)
    );
    this.frameStats.instanceUploads++;
    this.total.instanceUploads++;
    this.frameStats.instanceBytesUploaded += BYTES;
    this.total.instanceBytesUploaded += BYTES;
    this.device.draw({
      pipeline: this.pipeline,
      buffer: this.vertexBuffer,
      instanceBuffer: this.instanceBuffer,
      instances: this.pendingCount,
      count: QUAD_VERTICES.length / 2,
      uniforms: UNIFORMS2,
      blend: "source-over",
      stencil: stencilState(STATE.stencilRef)
    });
    this.frameStats.draws++;
    this.frameStats.instancedDraws++;
    this.frameStats.flushes++;
    this.total.draws++;
    this.total.instancedDraws++;
    this.total.flushes++;
    this.pendingCount = 0;
    this.pendingState = null;
    this.frameStats.lastFlushReason = reason;
  }
  stats() {
    return {
      instanced: this.instanced,
      pendingInstances: this.pendingCount,
      frame: {
        ...this.frameStats
      },
      total: {
        ...this.total
      }
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.device.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.device.deleteVertexBuffer(this.vertexBuffer);
    if (this.instanceBuffer) {
      this.device.deleteVertexBuffer(this.instanceBuffer);
    }
    this.device.deletePipeline(this.pipeline);
    this.pendingCount = 0;
    this.pendingState = null;
    this.disposed = true;
  }
};

// modules/rendering/vector-context.js
var TAU = Math.PI * 2;
var MAX_LINEAR_GRADIENT_STOPS = 32;
var LINEAR_GRADIENT_SIZE = 1024;
var MAX_GRADIENT_TEXTURES = 64;
var SILHOUETTE_OFFSETS = Object.freeze(
  Array.from(
    {
      length: 8
    },
    (_, i) => Object.freeze([Math.cos(i * TAU / 8), Math.sin(i * TAU / 8)])
  )
);
var IDENTITY3 = Object.freeze([1, 0, 0, 1, 0, 0]);
var WHITE2 = Object.freeze([1, 1, 1, 1]);
function composeTransform(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
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
var NAMED = Object.freeze({
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  rebeccapurple: "#663399",
  transparent: "#00000000"
});
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}
function finite(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}
function normalizeColor(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== 4) {
      throw new TypeError("RGBA paint must have four channels");
    }
    const OUT = Array.from(value);
    if (OUT.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new RangeError("RGBA channels must be in [0,1]");
    }
    return OUT;
  }
  let text = String(value ?? "black").trim().toLowerCase();
  text = NAMED[text] ?? text;
  if (text === "currentcolor" && typeof getComputedStyle === "function") {
    text = getComputedStyle(document.documentElement).color;
  }
  if (text[0] === "#") {
    let hex = text.slice(1);
    if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) {
      throw new TypeError(`Invalid CSS color: ${value}`);
    }
    if (hex.length < 5) {
      hex = [...hex].map((c) => c + c).join("");
    }
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    ];
  }
  const RGB = text.match(/^rgba?\((.*)\)$/);
  if (RGB) {
    const FIELDS = RGB[1].trim().replace(/\s*\/\s*/, " ").split(/[\s,]+/).filter(Boolean);
    if (FIELDS.length < 3 || FIELDS.length > 4) {
      throw new TypeError(`Invalid CSS color: ${value}`);
    }
    const CHANNEL = (s) => clamp(s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const ALPHA = FIELDS[3] === void 0 ? 1 : clamp(FIELDS[3].endsWith("%") ? parseFloat(FIELDS[3]) / 100 : parseFloat(FIELDS[3]));
    const OUT = [...FIELDS.slice(0, 3).map(CHANNEL), ALPHA];
    if (OUT.some(Number.isNaN)) {
      throw new TypeError(`Invalid CSS color: ${value}`);
    }
    return OUT;
  }
  const HSL = text.match(/^hsla?\((.*)\)$/);
  if (HSL) {
    const FIELDS = HSL[1].trim().replace(/\s*\/\s*/, " ").split(/[\s,]+/).filter(Boolean);
    if (FIELDS.length < 3 || FIELDS.length > 4) {
      throw new TypeError(`Invalid CSS color: ${value}`);
    }
    const H = (parseFloat(FIELDS[0]) % 360 + 360) % 360 / 360, S = clamp(parseFloat(FIELDS[1]) / 100), L = clamp(parseFloat(FIELDS[2]) / 100), A = FIELDS[3] === void 0 ? 1 : clamp(FIELDS[3].endsWith("%") ? parseFloat(FIELDS[3]) / 100 : parseFloat(FIELDS[3]));
    const F = (n) => {
      const K = (n + H * 12) % 12;
      return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(K - 3, 9 - K, 1));
    };
    return [F(0), F(8), F(4), A];
  }
  if (typeof document !== "undefined" && document.createElement && document.body) {
    const PROBE = document.createElement("span");
    PROBE.style.color = "";
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
    y: matrix[1] * x + matrix[3] * y + matrix[5]
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
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / D
  ];
}
var RadialGradient = class {
  constructor(matrix, x0, y0, r0, x1, y1, r1) {
    for (const [N, V] of Object.entries({
      x0,
      y0,
      r0,
      x1,
      y1,
      r1
    })) {
      finite(V, N);
    }
    if (r0 < 0 || r1 < 0) {
      throw new RangeError("Gradient radii must be non-negative");
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
      throw new RangeError("Invalid gradient stop");
    }
    this.stops.push({
      offset,
      color: normalizeColor(value)
    });
    this.stops.sort((a, b) => a.offset - b.offset);
    this.pixels = null;
    this.revision++;
  }
  raster() {
    if (this.pixels) {
      return this.pixels;
    }
    const DATA = new Uint8Array(256 * 4), STOPS = this.stops.length ? this.stops : [
      {
        offset: 0,
        color: [0, 0, 0, 0]
      }
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
      const Q = clamp((T - lo.offset) / (hi.offset - lo.offset || 1)), ALPHA = lo.color[3] + (hi.color[3] - lo.color[3]) * Q;
      for (let k = 0; k < 3; k++) {
        DATA[i * 4 + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * Q) * ALPHA * 255);
      }
      DATA[i * 4 + 3] = Math.round(ALPHA * 255);
    }
    this.pixels = DATA;
    return DATA;
  }
};
var LinearGradient = class {
  constructor(matrix, x0, y0, x1, y1) {
    for (const [NAME, VALUE] of Object.entries({
      x0,
      y0,
      x1,
      y1
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
      throw new RangeError("Invalid gradient stop");
    }
    if (this.stops.length >= MAX_LINEAR_GRADIENT_STOPS) {
      throw new RangeError(`Linear gradients support at most ${MAX_LINEAR_GRADIENT_STOPS} color stops`);
    }
    const STOP = {
      offset,
      color: normalizeColor(value),
      order: this.stops.length
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
    const DATA = new Uint8Array(LINEAR_GRADIENT_SIZE * 4), STOPS = this.stops;
    for (let i = 0; i < LINEAR_GRADIENT_SIZE; i++) {
      const T = i / (LINEAR_GRADIENT_SIZE - 1);
      let lo;
      let hi;
      let q;
      if (!STOPS.length) {
        lo = hi = {
          color: [0, 0, 0, 0]
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
      const ALPHA = lo.color[3] + (hi.color[3] - lo.color[3]) * q, AT = i * 4;
      for (let k = 0; k < 3; k++) {
        DATA[AT + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * q) * ALPHA * 255);
      }
      DATA[AT + 3] = Math.round(ALPHA * 255);
    }
    this.pixels = DATA;
    return DATA;
  }
};
var VectorContext = class {
  constructor(device, {
    vectorRenderer = null,
    glyphAtlas = vectorRenderer?.glyphAtlas ?? null,
    initialVertices = 4096,
    maxVertices = 262144,
    onError = null,
    safeAlphaRunBatching = true
  } = {}) {
    if (!device?.beginFrame || !device?.endFrame || !device?.createVertexBuffer) {
      throw new TypeError("WebGLDevice is required");
    }
    if (vectorRenderer && vectorRenderer.device !== device) {
      throw new TypeError("vectorRenderer must use the supplied WebGLDevice");
    }
    this.device = device;
    this.canvas = device.canvas;
    this.vector = vectorRenderer ?? new VectorRenderer(device, {
      initialVertices,
      maxVertices,
      glyphAtlas
    });
    this.ownsVector = !vectorRenderer;
    this.glyphAtlas = glyphAtlas ?? this.vector.glyphAtlas;
    this.onError = typeof onError === "function" ? onError : null;
    if (typeof safeAlphaRunBatching !== "boolean") {
      throw new TypeError("safeAlphaRunBatching must be a boolean");
    }
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    this.meshRenderer = null;
    this.primitiveRenderer = null;
    this.primitivePath = {
      type: "empty"
    };
    this.active = false;
    this.state = "ready";
    this.frame = 0;
    this.pathCount = 0;
    this.staticMeshes = /* @__PURE__ */ new Set();
    this.deferredMeshes = [];
    this.gradientTextures = /* @__PURE__ */ new Map();
    this._silhouetteMatrices = new Float32Array(60);
    this._scaledSilhouetteMatrices = new Float32Array(12);
    this._silhouetteColorCache = /* @__PURE__ */ new Map();
    this.onLost = (event) => {
      event.preventDefault();
      this.active = false;
      this.state = "lost";
      this.meshRenderer?.discard();
    };
    this.onRestored = () => {
      if (this.state === "disposed") {
        return;
      }
      try {
        for (const MESH of this.staticMeshes) {
          this.device.uploadVertices(MESH.buffer, MESH.vertices);
        }
        this.state = "ready";
      } catch (error) {
        this.state = "failed";
        this.onError?.(error, {
          phase: "restore"
        });
      }
    };
    this.canvas.addEventListener("webglcontextlost", this.onLost);
    this.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this._fillStyle = "#000";
    this._strokeStyle = "#000";
    this._globalAlpha = 1;
    this._lineWidth = 1;
    this._lineCap = "butt";
    this._lineJoin = "round";
    this._miterLimit = 10;
    this._lineDash = [];
    this._lineDashOffset = 0;
    this._font = "10px sans-serif";
    this._textAlign = "start";
    this._textBaseline = "alphabetic";
    this._direction = "inherit";
    this._filter = "none";
    this.forceColor = null;
    this.stack = [];
    this.frameStats = {};
    this.total = {
      frames: 0,
      drawCalls: 0,
      vertices: 0,
      uploadedBytes: 0
    };
  }
  get globalAlpha() {
    return this._globalAlpha;
  }
  set globalAlpha(v) {
    finite(v, "globalAlpha");
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
    finite(v, "lineWidth");
    if (v >= 0) {
      this._lineWidth = v;
    }
  }
  get lineCap() {
    return this._lineCap;
  }
  set lineCap(v) {
    if (["butt", "round", "square"].includes(v)) {
      this._lineCap = v;
    }
  }
  get lineJoin() {
    return this._lineJoin;
  }
  set lineJoin(v) {
    if (["round", "bevel", "miter"].includes(v)) {
      this._lineJoin = v;
    }
  }
  get miterLimit() {
    return this._miterLimit;
  }
  set miterLimit(v) {
    finite(v, "miterLimit");
    if (v > 0) {
      this._miterLimit = v;
    }
  }
  get lineDashOffset() {
    return this._lineDashOffset;
  }
  set lineDashOffset(v) {
    finite(v, "lineDashOffset");
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
    if (["start", "end", "left", "right", "center"].includes(v)) {
      this._textAlign = v;
    }
  }
  get textBaseline() {
    return this._textBaseline;
  }
  set textBaseline(v) {
    if (["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"].includes(v)) {
      this._textBaseline = v;
    }
  }
  get direction() {
    return this._direction;
  }
  set direction(v) {
    if (["ltr", "rtl", "inherit"].includes(v)) {
      this._direction = v;
    }
  }
  get filter() {
    return this._filter;
  }
  set filter(v) {
    if (v !== "none" && v !== "brightness(0) invert(1)") {
      throw new RangeError("VectorContext supports only none and brightness(0) invert(1) filters");
    }
    this._filter = v;
  }
  get stencilRef() {
    return this.vector.stencilDepth || null;
  }
  _frame() {
    if (!this.active || this.device.state !== "ready") {
      throw new Error("VectorContext frame is unavailable");
    }
  }
  _paint(style) {
    if (style instanceof RadialGradient || style instanceof LinearGradient) {
      throw new TypeError("Gradient paint must be submitted through a vector fill or stroke");
    }
    const COLOR = normalizeColor(this.forceColor ?? style);
    COLOR[3] *= this._globalAlpha;
    if (this._filter === "brightness(0) invert(1)") {
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
            `VectorContext supports at most ${MAX_GRADIENT_TEXTURES} distinct gradients in one frame`
          );
        }
        this.device.deleteTexture(EXPIRED[1].texture);
        this.gradientTextures.delete(EXPIRED[0]);
      }
      const LINEAR = gradient instanceof LinearGradient, WIDTH = LINEAR ? LINEAR_GRADIENT_SIZE : 256, HEIGHT = 1, DATA = gradient.raster();
      cached = {
        texture: this.device.createTexture(
          {
            width: WIDTH,
            height: HEIGHT,
            data: DATA
          },
          {
            format: "rgba",
            premultiplied: true,
            filter: "linear"
          }
        ),
        revision: gradient.revision,
        lastFrame: this.frame,
        linear: LINEAR
      };
      this.gradientTextures.set(gradient, cached);
    } else if (cached.revision !== gradient.revision) {
      this.vector.flush();
      const LINEAR = gradient instanceof LinearGradient, WIDTH = LINEAR ? LINEAR_GRADIENT_SIZE : 256;
      this.device.updateTexture(cached.texture, {
        width: WIDTH,
        height: 1,
        data: gradient.raster()
      });
      cached.revision = gradient.revision;
      cached.linear = LINEAR;
    }
    cached.lastFrame = this.frame;
    const MATRIX_INVERSE = invert(gradient.matrix);
    if (!MATRIX_INVERSE) {
      throw new RangeError("Gradient transform is singular");
    }
    const COLOR = normalizeColor(this.forceColor ?? [1, 1, 1, 1]);
    COLOR[3] *= this._globalAlpha;
    if (gradient instanceof LinearGradient) {
      return {
        texture: cached.texture,
        kind: "linear",
        gradient,
        x0: gradient.x0,
        y0: gradient.y0,
        x1: gradient.x1,
        y1: gradient.y1,
        matrixInverse: MATRIX_INVERSE,
        color: COLOR,
        whiteFlash: this._filter === "brightness(0) invert(1)"
      };
    }
    const DX = gradient.x1 - gradient.x0, DY = gradient.y1 - gradient.y0, DR = gradient.r1 - gradient.r0, SCALE = Math.max(1, Math.hypot(DX, DY), Math.abs(gradient.r0), Math.abs(gradient.r1));
    return {
      texture: cached.texture,
      kind: "radial",
      gradient,
      x0: gradient.x0,
      y0: gradient.y0,
      radialScale: SCALE,
      radialParams: [DX / SCALE, DY / SCALE, gradient.r0 / SCALE, DR / SCALE],
      radialEmpty: DX === 0 && DY === 0 && DR === 0,
      matrixInverse: MATRIX_INVERSE,
      color: COLOR,
      whiteFlash: this._filter === "brightness(0) invert(1)"
    };
  }
  _releaseGradientTextures() {
    for (const [GRADIENT, CACHED] of this.gradientTextures) {
      try {
        this.device.deleteTexture(CACHED.texture);
      } catch (error) {
        try {
          this.onError?.(error, {
            phase: "gradient-release"
          });
        } catch {
        }
      } finally {
        GRADIENT.pixels = null;
      }
    }
    this.gradientTextures.clear();
  }
  beginFrame({ width = this.canvas.width, height = this.canvas.height, clearColor = [0, 0, 0, 0] } = {}) {
    if (this.active) {
      throw new Error("endFrame is required before beginFrame");
    }
    if (this.state === "lost" || this.device.state === "lost") {
      return false;
    }
    if (this.state !== "ready") {
      throw new Error(`VectorContext is ${this.state}`);
    }
    try {
      const READY = this.device.beginFrame({
        width,
        height,
        clearColor
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
        type: "empty"
      };
      return true;
    } catch (error) {
      this.onError?.(error, {
        phase: "beginFrame"
      });
      throw error;
    }
  }
  endFrame() {
    this._frame();
    try {
      this.flush("frameEnd");
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
        primitives: this.primitiveRenderer?.stats().frame ?? null
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
        phase: "endFrame"
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
      forceColor: this.forceColor
    });
    this.vector.save();
  }
  restore() {
    this._frame();
    const S = this.stack.pop();
    if (!S) {
      return;
    }
    this.primitiveRenderer?.flush("stateRestore");
    this.meshRenderer?.flush("stateRestore");
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
      forceColor: S.forceColor
    });
  }
  setTransform(a, b, c, d, e, f) {
    this.vector.setTransform(a, b, c, d, e, f);
  }
  resetTransform() {
    this.vector.setTransform(...IDENTITY3);
  }
  getTransform() {
    const M = this.vector.matrix;
    return {
      a: M[0],
      b: M[1],
      c: M[2],
      d: M[3],
      e: M[4],
      f: M[5]
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
      type: "empty"
    };
  }
  _materializePrimitivePath() {
    const PATH = this.primitivePath;
    if (PATH?.type !== "ellipse") {
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
        PATH.ccw
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
    this.primitivePath = this.primitivePath?.type === "empty" ? {
      type: "line",
      start: POINT,
      end: null
    } : null;
    this.vector.moveTo(x, y);
  }
  lineTo(x, y) {
    this._materializePrimitivePath();
    if (!this.vector.cursor && this.primitivePath?.type === "empty") {
      this.primitivePath = {
        type: "line",
        start: transformedPoint(this.vector.matrix, x, y),
        end: null
      };
    } else if (this.primitivePath?.type === "line" && !this.primitivePath.end) {
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
      throw new RangeError("ellipse radii must be non-negative");
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
    const M = this.vector.matrix, R = Math.max(rx, ry) * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3])), STEP = R > 0.2 ? 2 * Math.acos(clamp(1 - 0.2 / R, -1, 1)) : Math.PI / 2, N = Math.max(1, Math.min(256, Math.ceil(Math.abs(sweep) / Math.max(0.01, STEP)))), C = Math.cos(rotation), S = Math.sin(rotation), OUT = [];
    for (let i = 0; i <= N; i++) {
      const A = start + sweep * i / N;
      OUT.push([
        x + Math.cos(A) * rx * C - Math.sin(A) * ry * S,
        y + Math.cos(A) * rx * S + Math.sin(A) * ry * C
      ]);
    }
    return OUT;
  }
  arc(x, y, r, start, end, ccw = false) {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }
  ellipse(x, y, rx, ry, rotation = 0, start = 0, end = TAU, ccw = false) {
    if (rx < 0 || ry < 0) {
      throw new RangeError("ellipse radii must be non-negative");
    }
    this._frame();
    this._materializePrimitivePath();
    const MATRIX = this.vector.matrix.slice();
    const FULL = isFullArc(start, end, ccw);
    const FAST = this.primitivePath?.type === "empty" && !this.vector.cursor && FULL && [x, y, rx, ry, rotation, start, end].every(Number.isFinite);
    this.primitivePath = FAST ? {
      type: "ellipse",
      x,
      y,
      rx,
      ry,
      rotation,
      start,
      end,
      ccw,
      matrix: MATRIX
    } : null;
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
    this.primitivePath = this.primitivePath?.type === "empty" && !this.vector.cursor ? {
      type: "rect",
      x,
      y,
      w,
      h,
      matrix: MATRIX
    } : null;
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
    const V = this.vector, SAVED = {
      path: V.path,
      cursor: V.cursor,
      subpath: V.subpath,
      primitivePath: this.primitivePath
    };
    try {
      this.primitivePath = {
        type: "empty"
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
    if (path.type === "ellipse") {
      const COS = Math.cos(path.rotation);
      const SIN = Math.sin(path.rotation);
      local = [path.rx * COS, path.rx * SIN, -path.ry * SIN, path.ry * COS, path.x, path.y];
    } else {
      local = [path.w / 2, 0, 0, path.h / 2, path.x + path.w / 2, path.y + path.h / 2];
    }
    return composeTransform(path.matrix, local);
  }
  _submitPrimitive(matrix, color2, params) {
    this.meshRenderer?.flush("primitiveBoundary");
    this.vector.flush();
    this.primitiveRenderer ??= new PrimitiveRenderer(this.device);
    return this.primitiveRenderer.draw({
      matrix,
      color: color2,
      params,
      projection: this.vector.projection,
      clips: this.vector.clips,
      stencilRef: this.vector.stencilDepth || null
    });
  }
  _tryPrimitiveFill() {
    const PATH = this.primitivePath;
    if (!PATH || PATH.type !== "ellipse" && PATH.type !== "rect") {
      return false;
    }
    if (this._fillStyle instanceof RadialGradient || this._fillStyle instanceof LinearGradient) {
      return false;
    }
    if (PATH.type === "ellipse" && (!PATH.rx || !PATH.ry)) {
      return true;
    }
    if (PATH.type === "rect" && (!PATH.w || !PATH.h)) {
      return true;
    }
    const TYPE = PATH.type === "ellipse" ? 0 : 1;
    return this._submitPrimitive(this._primitiveTransform(PATH), this._paint(this._fillStyle), [TYPE, 0, 0, 0]);
  }
  _tryPrimitiveStroke(width) {
    const PATH = this.primitivePath;
    if (!PATH || this._strokeStyle instanceof RadialGradient || this._strokeStyle instanceof LinearGradient) {
      return false;
    }
    if (PATH.type === "ellipse") {
      if (!PATH.rx || !PATH.ry) {
        return false;
      }
      return this._submitPrimitive(this._primitiveTransform(PATH), this._paint(this._strokeStyle), [
        0,
        1,
        width,
        0
      ]);
    }
    if (PATH.type === "rect") {
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
      if (this._lineJoin === "miter") {
        if (this._miterLimit < Math.SQRT2) {
          return false;
        }
      } else if (this._lineJoin !== "round") {
        return false;
      }
      return this._submitPrimitive(MATRIX, this._paint(this._strokeStyle), [
        1,
        1,
        width,
        this._lineJoin === "miter" ? 1 : 0
      ]);
    }
    if (PATH.type === "line" && PATH.end) {
      const DX = PATH.end[0] - PATH.start[0];
      const DY = PATH.end[1] - PATH.start[1];
      const LENGTH = Math.hypot(DX, DY);
      if (!LENGTH) {
        return false;
      }
      const CAP = this._lineCap === "butt" ? 0 : this._lineCap === "square" ? 1 : 2;
      const UNIT_X = DX / LENGTH;
      const UNIT_Y = DY / LENGTH;
      const PAD = CAP === 0 ? 0 : width / 2;
      const HALF_LENGTH = LENGTH / 2 + PAD;
      const MATRIX = [
        UNIT_X * HALF_LENGTH,
        UNIT_Y * HALF_LENGTH,
        -UNIT_Y * width / 2,
        UNIT_X * width / 2,
        (PATH.start[0] + PATH.end[0]) / 2,
        (PATH.start[1] + PATH.end[1]) / 2
      ];
      return this._submitPrimitive(MATRIX, this._paint(this._strokeStyle), [2, 1, width, CAP]);
    }
    return false;
  }
  fill(rule = "nonzero") {
    this._frame();
    if ((rule === "nonzero" || rule === "evenodd") && this._tryPrimitiveFill()) {
      return;
    }
    this._materializePrimitivePath();
    this.primitiveRenderer?.flush("vectorBoundary");
    this.meshRenderer?.flush("vectorBoundary");
    if (this._fillStyle instanceof RadialGradient) {
      this.vector.fillRadialGradient({
        ...this._gradientPaint(this._fillStyle),
        rule
      });
    } else if (this._fillStyle instanceof LinearGradient) {
      this.vector.fillLinearGradient({
        ...this._gradientPaint(this._fillStyle),
        rule
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
    const M = this.vector.matrix, WIDTH = this._lineWidth * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3])), GRADIENT = this._strokeStyle instanceof RadialGradient || this._strokeStyle instanceof LinearGradient ? this._gradientPaint(this._strokeStyle) : null, PAINT = GRADIENT ? GRADIENT.color : this._paint(this._strokeStyle), STYLE = {
      lineCap: this._lineCap,
      lineJoin: this._lineJoin,
      miterLimit: this._miterLimit
    }, DASH = this._lineDash, PERIOD = DASH.reduce((a, b) => a + b, 0);
    if ((!DASH.length || !PERIOD) && !GRADIENT && this._tryPrimitiveStroke(WIDTH)) {
      return;
    }
    this._materializePrimitivePath();
    this.primitiveRenderer?.flush("vectorBoundary");
    this.meshRenderer?.flush("vectorBoundary");
    if (!DASH.length || !PERIOD) {
      this.vector.stroke(PAINT, WIDTH, STYLE, GRADIENT);
      return;
    }
    const V = this.vector, ORIGINAL = V.path, MATRIX = V.matrix.slice();
    V.beginPath();
    V.setTransform(...IDENTITY3);
    let phase = (this._lineDashOffset % PERIOD + PERIOD) % PERIOD;
    let index = 0;
    while (phase >= DASH[index] && DASH[index] > 0) {
      phase -= DASH[index];
      index = (index + 1) % DASH.length;
    }
    let remaining = DASH[index] - phase;
    for (const PATH of ORIGINAL) {
      for (let i = 1; i < PATH.length; i++) {
        const A = PATH[i - 1], B = PATH[i], LENGTH = Math.hypot(B.x - A.x, B.y - A.y);
        let at = 0;
        while (at < LENGTH - 1e-7) {
          if (remaining <= 1e-7) {
            index = (index + 1) % DASH.length;
            remaining = DASH[index];
            continue;
          }
          const STOP = Math.min(LENGTH, at + remaining);
          if (index % 2 === 0) {
            V.moveTo(A.x + (B.x - A.x) * at / LENGTH, A.y + (B.y - A.y) * at / LENGTH);
            V.lineTo(A.x + (B.x - A.x) * STOP / LENGTH, A.y + (B.y - A.y) * STOP / LENGTH);
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
      throw new TypeError("dash must contain non-negative finite values");
    }
    if (values.length % 2) {
      values = values.concat(values);
    }
    this._lineDash = values.slice();
  }
  getLineDash() {
    return this._lineDash.slice();
  }
  clip(rule = "nonzero") {
    this._frame();
    this._materializePrimitivePath();
    this.primitiveRenderer?.flush("clipBoundary");
    this.meshRenderer?.flush("clipBoundary");
    if (this.vector.path.filter((p) => p.length >= 3).length > 1) {
      throw new RangeError("clip supports one contour per clip call");
    }
    this.vector.clip(rule);
  }
  createClipPath(points, { rule = "nonzero" } = {}) {
    return this.vector.createClipPath(points, {
      rule
    });
  }
  clipPath(handle, { transform = null } = {}) {
    this._frame();
    this.primitiveRenderer?.flush("stencilChange");
    this.meshRenderer?.flush("stencilChange");
    this.vector.flush();
    this.vector.clipPath(handle, {
      transform
    });
  }
  deleteClipPath(handle) {
    return this.vector.deleteClipPath(handle);
  }
  clipRect(x, y, w, h) {
    this._frame();
    this.primitiveRenderer?.flush("clipBoundary");
    this.meshRenderer?.flush("clipBoundary");
    this.vector.clipRect(x, y, w, h);
  }
  fillTriangleFan(points, paint = this._fillStyle) {
    this._frame();
    this.primitiveRenderer?.flush("vectorBoundary");
    this.meshRenderer?.flush("vectorBoundary");
    if (points.length < 3) {
      return;
    }
    this.vector.triangleFan(points, this._paint(paint));
  }
  beginGroup(opacity = 1, bounds = null) {
    this._frame();
    this.primitiveRenderer?.flush("groupBoundary");
    if (opacity !== 1) {
      this.meshRenderer?.flush("groupBoundary");
    }
    this.vector.beginGroup(opacity, bounds);
  }
  endGroup() {
    if (!this.vector.groups.at(-1)?.direct) {
      this.primitiveRenderer?.flush("groupBoundary");
      this.meshRenderer?.flush("groupBoundary");
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
    const M = this.vector.matrix, P = transformed(M, x, y), R = radius * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3]));
    return {
      x: P.x - R,
      y: P.y - R,
      width: R * 2,
      height: R * 2
    };
  }
  withColor(color2, callback) {
    const PREVIOUS = this.forceColor;
    this.forceColor = normalizeColor(color2);
    try {
      return callback();
    } finally {
      this.forceColor = PREVIOUS;
    }
  }
  withSilhouette(color2, width, paint, radius = 128) {
    const ALPHA = this._globalAlpha, BOUNDS = this.groupBounds(0, 0, radius + width);
    return this.withGroupOpacity(
      ALPHA,
      () => {
        this.withColor(color2, () => {
          for (let i = 0; i < 8; i++) {
            this.save();
            const A = i * TAU / 8;
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
      BOUNDS
    );
  }
  _fontSize() {
    const M = this._font.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/);
    return M ? Number(M[1]) : 10;
  }
  _align() {
    if (this._textAlign === "center") {
      return "center";
    }
    if (this._textAlign === "right" || this._textAlign === "end" && this._direction !== "rtl" || this._textAlign === "start" && this._direction === "rtl") {
      return "right";
    }
    return "left";
  }
  measureText(text) {
    if (!this.glyphAtlas) {
      throw new Error("GlyphAtlas is not configured");
    }
    return this.glyphAtlas.measureText(String(text), {
      fontSize: this._fontSize(),
      align: this._align()
    });
  }
  fillText(text, x, y, maxWidth) {
    this._frame();
    this.primitiveRenderer?.flush("vectorBoundary");
    this.meshRenderer?.flush("vectorBoundary");
    if (!this.glyphAtlas) {
      throw new Error("GlyphAtlas is not configured");
    }
    const COLOR = this._paint(this._fillStyle), FONT_SIZE = this._fontSize(), ALIGN = this._align(), BASELINE = this._textBaseline, MEASURED = this.glyphAtlas.measureText(String(text), {
      fontSize: FONT_SIZE
    }).width, SCALE = maxWidth && Number.isFinite(maxWidth) ? Math.min(1, maxWidth / (MEASURED || 1)) : 1;
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
        color: COLOR
      });
    } finally {
      if (SCALE !== 1) {
        this.vector.restore();
      }
    }
  }
  strokeText(text, x, y, maxWidth) {
    this._frame();
    this.primitiveRenderer?.flush("vectorBoundary");
    this.meshRenderer?.flush("vectorBoundary");
    if (!this.glyphAtlas) {
      throw new Error("GlyphAtlas is not configured");
    }
    const SCALE = maxWidth && Number.isFinite(maxWidth) ? Math.min(
      1,
      maxWidth / (this.glyphAtlas.measureText(String(text), {
        fontSize: this._fontSize()
      }).width || 1)
    ) : 1;
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
        lineWidth: this._lineWidth
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
    if (this.state !== "ready" || this.device.state !== "ready") {
      throw new Error("VectorContext is not ready");
    }
    this.meshRenderer ??= new MeshRenderer(this.device, {
      safeAlphaRunBatching: this.safeAlphaRunBatching
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
      throw new TypeError("createMesh required");
    }
    this.primitiveRenderer?.flush("meshBoundary");
    this.vector.flush();
    let matrix = this.vector.matrix;
    if (transform) {
      if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) {
        throw new TypeError("Six finite transform values required");
      }
      const M = matrix, [A, B, C, D, E, F] = transform;
      matrix = [
        M[0] * A + M[2] * B,
        M[1] * A + M[3] * B,
        M[0] * C + M[2] * D,
        M[1] * C + M[3] * D,
        M[0] * E + M[2] * F + M[4],
        M[1] * E + M[3] * F + M[5]
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
      whiteFlash: this._filter === "brightness(0) invert(1)",
      stencilRef: this.vector.stencilDepth || null
    });
  }
  /** Draw a retained mesh silhouette and body in one ordered instance batch. */
  drawMeshSilhouette(mesh, {
    transform = null,
    morph = [0, 0],
    parts = null,
    color: color2 = "black",
    width,
    radius = 128,
    outlineScale = null
  } = {}) {
    this._frame();
    if (!this.meshRenderer) {
      throw new TypeError("createMesh required");
    }
    finite(width, "silhouette width");
    finite(radius, "silhouette radius");
    if (width < 0 || radius < 0) {
      throw new RangeError("silhouette dimensions must be non-negative");
    }
    if (outlineScale !== null) {
      finite(outlineScale, "silhouette outlineScale");
      if (outlineScale < 1) {
        throw new RangeError("silhouette outlineScale must be at least one");
      }
    }
    let outline;
    if (typeof color2 === "string" && color2[0] === "#") {
      outline = this._silhouetteColorCache.get(color2);
      if (!outline) {
        outline = normalizeColor(color2);
        if (this._silhouetteColorCache.size === 16) {
          this._silhouetteColorCache.delete(this._silhouetteColorCache.keys().next().value);
        }
        this._silhouetteColorCache.set(color2, outline);
      }
    } else {
      outline = normalizeColor(color2);
    }
    const OUTLINE_INSTANCES = outlineScale === null ? 9 : 1, COUNT = OUTLINE_INSTANCES + 1, MATRICES = outlineScale === null ? this._silhouetteMatrices : this._scaledSilhouetteMatrices;
    const BOUNDS = this.groupBounds(0, 0, Math.max(radius + width, radius * (outlineScale ?? 1)));
    return this.withGroupOpacity(
      this._globalAlpha,
      () => {
        this.vector.flush();
        const SOURCE = this.vector.matrix, A = SOURCE[0], B = SOURCE[1], C = SOURCE[2], D = SOURCE[3], E = SOURCE[4], F = SOURCE[5];
        let ta = 1;
        let tb = 0;
        let tc = 0;
        let td = 1;
        let te = 0;
        let tf = 0;
        if (transform) {
          if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) {
            throw new TypeError("Six finite transform values required");
          }
          [ta, tb, tc, td, te, tf] = transform;
        }
        for (let i = 0; i < COUNT; i++) {
          const OUTLINE_PASS = i < OUTLINE_INSTANCES, OFFSET = outlineScale === null && OUTLINE_PASS && i < 8, DIRECTION = OFFSET ? SILHOUETTE_OFFSETS[i] : null, DX = DIRECTION ? DIRECTION[0] * width : 0, DY = DIRECTION ? DIRECTION[1] * width : 0, SCALE = outlineScale !== null && i === 0 ? outlineScale : 1, AT = i * 6;
          const E_OFFSET = E + A * DX + C * DY, F_OFFSET = F + B * DX + D * DY;
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
          color: this.forceColor ?? WHITE2,
          forceColor: this.forceColor !== null,
          prefixColor: outline,
          prefixCount: OUTLINE_INSTANCES,
          forceColorPrefixCount: OUTLINE_INSTANCES,
          alpha: this._globalAlpha,
          whiteFlash: this._filter === "brightness(0) invert(1)",
          clips: this.vector.clips,
          stencilRef: this.vector.stencilDepth || null
        });
      },
      BOUNDS
    );
  }
  flush(reason = "explicit") {
    this._frame();
    this.primitiveRenderer?.flush(reason);
    this.meshRenderer?.flush(reason);
    this.vector.flush();
  }
  createStaticMesh(vertices, { strideFloats = 6 } = {}) {
    if (this.state !== "ready" || this.device.state !== "ready") {
      throw new Error("VectorContext is not ready");
    }
    if (!(vertices instanceof Float32Array) || !Number.isSafeInteger(strideFloats) || strideFloats < 2 || vertices.length % strideFloats) {
      throw new TypeError("mesh requires Float32Array and a matching strideFloats");
    }
    const BUFFER = this.device.createVertexBuffer({
      capacityBytes: vertices.byteLength
    });
    this.device.uploadVertices(BUFFER, vertices);
    const MESH = {
      context: this,
      buffer: BUFFER,
      vertices,
      count: vertices.length / strideFloats,
      strideFloats
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
  drawStaticMesh(mesh, { pipeline, projection, uniforms = {}, textures = [], blend = "source-over", depth = null } = {}) {
    this._frame();
    if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh) || !pipeline) {
      throw new TypeError("mesh owned by this context and caller pipeline are required");
    }
    this.flush("staticMeshBoundary");
    const VALUES = {
      ...uniforms
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
      stencil: this.vector.stencilDepth ? {
        func: "equal",
        ref: this.vector.stencilDepth,
        mask: 255,
        writeMask: 0,
        pass: "keep"
      } : false
    });
  }
  stats() {
    return {
      backend: "webgl1",
      available: this.device.state === "ready",
      contextLost: this.device.state === "lost",
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
        ...this.total
      }
    };
  }
  dispose() {
    if (this.state === "disposed") {
      return;
    }
    this.vector.count = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
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
    this.state = "disposed";
  }
};
var PrimitivePainter = class {
  constructor(target, { point: point2 = null, alphaMultiplier = 1 } = {}) {
    if (!target?.fillTriangleFan && !(target?.beginPath && target?.fill)) {
      throw new TypeError("VectorContext or native Canvas2D context is required");
    }
    this.context = target;
    this.pointTransform = point2;
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
    const CTX = this.context, OLD_ALPHA = CTX.globalAlpha ?? 1, MUL = typeof this.alphaMultiplier === "function" ? this.alphaMultiplier() : this.alphaMultiplier;
    CTX.globalAlpha = OLD_ALPHA * clamp(MUL);
    try {
      if (typeof CTX.fillTriangleFan === "function") {
        CTX.fillTriangleFan(
          points.map((p) => this.point(p[0], p[1])),
          paint
        );
        return;
      }
      const RGBA = normalizeColor(paint);
      CTX.fillStyle = `rgba(${Math.round(RGBA[0] * 255)},${Math.round(RGBA[1] * 255)},${Math.round(RGBA[2] * 255)},${RGBA[3]})`;
      CTX.beginPath();
      const A = this.point(points[0][0], points[0][1]);
      for (let i = 1; i < points.length - 1; i++) {
        const B = this.point(points[i][0], points[i][1]), C = this.point(points[i + 1][0], points[i + 1][1]);
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
        [x3, y3]
      ],
      paint
    );
  }
  quad(x1, y1, x2, y2, x3, y3, x4, y4, paint) {
    this.poly(
      [
        [x1, y1],
        [x2, y2],
        [x3, y3],
        [x4, y4]
      ],
      paint
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
          length: sides
        },
        (_, i) => [Math.cos(rotation + i / sides * TAU), Math.sin(rotation + i / sides * TAU)]
      );
      PRIMITIVE_DIRECTIONS.set(`${sides}|${rotation}`, unit);
    }
    this.poly(
      unit.map((p) => [x + p[0] * radius, y + p[1] * radius]),
      paint
    );
  }
  circle(x, y, radius, paint, segments = 10) {
    this.regularPolygon(x, y, radius, paint, segments, 0);
  }
  hex(x, y, radius, paint) {
    this.regularPolygon(x, y, radius, paint, 6, Math.PI / 6);
  }
  line(x0, y0, x1, y1, width, paint) {
    const DX = x1 - x0, DY = y1 - y0, LENGTH = Math.hypot(DX, DY) || 1, NX = -DY / LENGTH * width / 2, NY = DX / LENGTH * width / 2;
    this.quad(x0 + NX, y0 + NY, x1 + NX, y1 + NY, x1 - NX, y1 - NY, x0 - NX, y0 - NY, paint);
  }
  fan(points, paint) {
    this.poly(points, paint);
  }
};
var PRIMITIVE_DIRECTIONS = /* @__PURE__ */ new Map();

// modules/rendering/mesh-builder.js
var INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
var IS_INDEX_MAP = (map, vertexCount) => map !== null && typeof map === "object" && !Array.isArray(map) && Object.entries(map).every(
  ([name, indices]) => INDEX_NAME.test(name) && indices instanceof Uint16Array && indices.length % 3 === 0 && indices.every((index) => index < vertexCount)
);
var BASE_INDICES = (geometry) => geometry.indices ?? Uint16Array.from(
  {
    length: geometry.vertices.length / 11
  },
  (_, index) => index
);
var MeshBuilder = class _MeshBuilder {
  constructor({ maxVertices = 262144 } = {}) {
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) {
      throw new RangeError("maxVertices must be >= 3");
    }
    this.maxVertices = maxVertices;
    this.globalAlpha = 1;
    this.vertices = [];
  }
  fillTriangleFan(points, paint) {
    if (!points || points.length < 3) {
      return;
    }
    if (!Number.isFinite(this.globalAlpha) || this.globalAlpha < 0 || this.globalAlpha > 1) {
      throw new RangeError("globalAlpha must be in [0,1]");
    }
    const COLOR = normalizeColor(paint);
    COLOR[3] *= this.globalAlpha;
    if (this.vertices.length / 6 + (points.length - 2) * 3 > this.maxVertices) {
      throw new RangeError("MeshBuilder vertex capacity exceeded");
    }
    for (const P of points) {
      if (!P || !Number.isFinite(P[0]) || !Number.isFinite(P[1])) {
        throw new TypeError("Finite mesh points required");
      }
    }
    for (let i = 2; i < points.length; i++) {
      for (const P of [points[0], points[i - 1], points[i]]) {
        this.vertices.push(P[0], P[1], ...COLOR);
      }
    }
  }
  /** Each target is the same authored triangle/color sequence with different positions, not a sampled time cache. */
  build({ morphs = [] } = {}) {
    if (!Array.isArray(morphs) || morphs.length > 2 || morphs.some((m) => !(m instanceof _MeshBuilder))) {
      throw new TypeError("At most two MeshBuilder morph targets required");
    }
    const BASE = this.vertices, COUNT = BASE.length / 6;
    for (const TARGET of morphs) {
      if (TARGET.vertices.length !== BASE.length) {
        throw new RangeError("Morph topology differs");
      }
      for (let i = 0; i < BASE.length; i++) {
        if (i % 6 >= 2 && TARGET.vertices[i] !== BASE[i]) {
          throw new RangeError("Morph colors differ");
        }
      }
    }
    const VERTICES = new Float32Array(COUNT * 11);
    for (let i = 0; i < COUNT; i++) {
      VERTICES.set(BASE.slice(i * 6, i * 6 + 6), i * 11);
      for (let j = 0; j < morphs.length; j++) {
        VERTICES[i * 11 + 6 + j * 2] = morphs[j].vertices[i * 6] - BASE[i * 6];
        VERTICES[i * 11 + 7 + j * 2] = morphs[j].vertices[i * 6 + 1] - BASE[i * 6 + 1];
      }
    }
    return Object.freeze({
      vertices: VERTICES,
      count: COUNT,
      strideFloats: 11,
      morphCount: morphs.length,
      partCount: 1
    });
  }
  /** Packs compatible authored geometries into one painter-ordered mesh without sorting. */
  static combine(geometries) {
    if (!Array.isArray(geometries) || !geometries.length || geometries.some(
      (geometry) => !Number.isSafeInteger(geometry?.partCount) || geometry.partCount < 1 || geometry.strideFloats !== 11 || !(geometry.vertices instanceof Float32Array) || geometry.vertices.length < 33 || geometry.vertices.length % 11 || geometry.nonScalingStroke !== void 0 && typeof geometry.nonScalingStroke !== "boolean" || geometry.nonScalingStroke && geometry.morphCount !== 0 || geometry.indices !== void 0 && (!(geometry.indices instanceof Uint16Array) || geometry.indices.length < 3 || geometry.indices.length % 3 || geometry.vertices.length / 11 > 65536 || geometry.indices.some((index) => index >= geometry.vertices.length / 11)) || geometry.indices === void 0 && geometry.vertices.length % 33 || !Number.isSafeInteger(geometry.morphCount) || geometry.morphCount < 0 || geometry.morphCount > 2 || geometry.expressionIndices !== void 0 && !IS_INDEX_MAP(geometry.expressionIndices, geometry.vertices.length / 11) || geometry.indexVariants !== void 0 && (!IS_INDEX_MAP(geometry.indexVariants, geometry.vertices.length / 11) || Object.keys(geometry.indexVariants).length > 0)
    ) || geometries.reduce((count, geometry) => count + geometry.partCount, 0) > 16) {
      throw new TypeError(
        "MeshBuilder geometries must fit within 16 parts, use the 11-float schema, and cannot flatten painter-order indexVariants"
      );
    }
    const VERTEX_COUNT = geometries.reduce((count, geometry) => count + geometry.vertices.length / 11, 0);
    const INDEX_COUNT = geometries.reduce(
      (count, geometry) => count + (geometry.indices?.length ?? geometry.vertices.length / 11),
      0
    );
    if (VERTEX_COUNT > 65536) {
      throw new RangeError("Combined geometry exceeds 65,536 distinct vertices");
    }
    for (const GEOMETRY of geometries) {
      for (let i = 10; i < GEOMETRY.vertices.length; i += 11) {
        const PART = GEOMETRY.vertices[i];
        if (!Number.isSafeInteger(PART) || PART < 0 || PART >= GEOMETRY.partCount) {
          throw new RangeError("Mesh part index outside partCount");
        }
      }
    }
    const VERTICES = new Float32Array(VERTEX_COUNT * 11), INDICES = new Uint16Array(INDEX_COUNT);
    const EXPRESSION_NAMES = new Set(
      geometries.flatMap((geometry) => Object.keys(geometry.expressionIndices ?? {}))
    );
    const EXPRESSION_INDICES = /* @__PURE__ */ Object.create(null);
    const PART_COUNT = geometries.reduce((count, geometry) => count + geometry.partCount, 0);
    const MORPH_COUNT = Math.max(...geometries.map((geometry) => geometry.morphCount));
    const NON_SCALING_STROKE = geometries.some((geometry) => geometry.nonScalingStroke === true);
    if (NON_SCALING_STROKE && MORPH_COUNT) {
      throw new TypeError("Non-scaling strokes cannot be combined with vertex morph targets");
    }
    let offset = 0;
    let partOffset = 0;
    let indexOffset = 0;
    for (const GEOMETRY of geometries) {
      VERTICES.set(GEOMETRY.vertices, offset);
      const VERTEX_LENGTH = GEOMETRY.vertices.length;
      for (let i = 10; i < VERTEX_LENGTH; i += 11) {
        VERTICES[offset + i] += partOffset;
      }
      if (GEOMETRY.indices) {
        for (let i = 0; i < GEOMETRY.indices.length; i++) {
          INDICES[indexOffset + i] = GEOMETRY.indices[i] + offset / 11;
        }
        indexOffset += GEOMETRY.indices.length;
      } else {
        for (let i = 0; i < VERTEX_LENGTH / 11; i++) {
          INDICES[indexOffset + i] = i + offset / 11;
        }
        indexOffset += VERTEX_LENGTH / 11;
      }
      offset += VERTEX_LENGTH;
      partOffset += GEOMETRY.partCount;
    }
    for (const NAME of EXPRESSION_NAMES) {
      const VARIANT_LENGTH = geometries.reduce(
        (count, geometry) => count + (geometry.expressionIndices?.[NAME]?.length ?? geometry.indices?.length ?? geometry.vertices.length / 11),
        0
      );
      const VARIANT = new Uint16Array(VARIANT_LENGTH);
      let target = 0;
      let vertexOffset = 0;
      for (const GEOMETRY of geometries) {
        const SOURCE = GEOMETRY.expressionIndices?.[NAME] ?? BASE_INDICES(GEOMETRY);
        for (let i = 0; i < SOURCE.length; i++) {
          VARIANT[target + i] = SOURCE[i] + vertexOffset;
        }
        target += SOURCE.length;
        vertexOffset += GEOMETRY.vertices.length / 11;
      }
      EXPRESSION_INDICES[NAME] = VARIANT;
    }
    return Object.freeze({
      vertices: VERTICES,
      indices: INDICES,
      count: INDICES.length,
      strideFloats: 11,
      partCount: PART_COUNT,
      morphCount: MORPH_COUNT,
      ...EXPRESSION_NAMES.size ? {
        expressionIndices: EXPRESSION_INDICES
      } : {},
      ...NON_SCALING_STROKE ? {
        nonScalingStroke: true
      } : {}
    });
  }
};

// modules/rendering/yarn-shader.js
var STRIDE_FLOATS = 9;
var STRIDE_BYTES = STRIDE_FLOATS * 4;
var MAX_SURFACES = 512;
var DEFAULT_LIMIT_BYTES = 32 * 1024 * 1024;
var ATTRIBUTES2 = [
  {
    name: "a_position",
    size: 2,
    offset: 0
  },
  {
    name: "a_color",
    size: 4,
    offset: 8
  },
  {
    name: "a_surface",
    size: 3,
    offset: 24
  }
];
var IDENTITY4 = Object.freeze([1, 0, 0, 1, 0, 0]);
var WHITE3 = Object.freeze([1, 1, 1, 1]);
var VERTEX2 = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute vec3 a_surface;
uniform mat3 u_projection;
uniform mat3 u_transform;
uniform float u_depth;
varying vec2 v_position;
varying vec2 v_world;
varying vec4 v_color;
varying vec3 v_surface;
void main() {
  vec3 world = u_transform * vec3(a_position, 1.0);
  vec3 projected = u_projection * world;
  gl_Position = vec4(projected.xy, u_depth * projected.z, projected.z);
  v_position = a_position;
  v_world = world.xy / world.z;
  v_color = a_color;
  v_surface = a_surface;
}`;
var VERTEX_WORLD = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute vec3 a_surface;
uniform mat4 u_viewProjection;
uniform mat4 u_worldMatrix;
uniform mat3 u_transform;
uniform float u_depth;
varying vec2 v_position;
varying vec2 v_world;
varying vec4 v_color;
varying vec3 v_surface;
void main() {
  vec3 plane = u_transform * vec3(a_position, 1.0);
  vec4 world = u_worldMatrix * vec4(plane.xy / plane.z, 0.0, 1.0);
  vec4 projected = u_viewProjection * world;
  projected.z += u_depth * projected.w;
  gl_Position = projected;
  v_position = a_position;
  v_world = world.xy / world.w;
  v_color = a_color;
  v_surface = a_surface;
}`;
function fragment2(kind, maxClipPlanes) {
  const CLIPS = maxClipPlanes ? `
uniform vec3 u_planes[${maxClipPlanes}];
void clipWorld() {
  for (int i = 0; i < ${maxClipPlanes}; i++) {
    vec3 plane = u_planes[i];
    if (dot(plane.xy, plane.xy) > 0.0000001 && dot(plane, vec3(v_world, 1.0)) < 0.0) discard;
  }
}` : "void clipWorld() {}";
  const BODY = kind === "yarn" ? YARN_FRAGMENT_BODY : SKETCH_FRAGMENT_BODY;
  return `precision mediump float;
varying vec2 v_position; varying vec2 v_world; varying vec4 v_color; varying vec3 v_surface;
uniform vec4 u_bounds; uniform vec4 u_effect0; uniform vec4 u_effect1; uniform vec4 u_effect2; uniform vec4 u_effect3;
uniform vec4 u_tint; uniform float u_flash; uniform float u_forceColor;
${kind === "sketch" ? "uniform float u_timeMs;" : ""}
${CLIPS}
float hashCell(vec2 cell, float salt) {
  return fract(sin(dot(cell, vec2(127.1, 311.7)) + u_effect0.x * 74.7 + salt * 19.19) * 43758.5453);
}
float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 delta = b - a;
  float denom = max(dot(delta, delta), 0.000001);
  float t = clamp(dot(p - a, delta) / denom, 0.0, 1.0);
  return length(p - (a + delta * t));
}
vec2 cubicPoint(float t, vec2 a, vec2 b, vec2 c, vec2 d) {
  float s = 1.0 - t;
  return s*s*s*a + 3.0*s*s*t*b + 3.0*s*t*t*c + t*t*t*d;
}
float cubicDistance(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  float result = 100000.0;
  vec2 previous = a;
  for (int i = 1; i <= 5; i++) {
    vec2 next = cubicPoint(float(i) * 0.2, a, b, c, d);
    result = min(result, segmentDistance(p, previous, next));
    previous = next;
  }
  return result;
}
float lineMask(float distanceToLine, float width) {
  float aa = max(width * 0.16, 0.025);
  return 1.0 - smoothstep(max(0.0, width * 0.5 - aa), width * 0.5 + aa, distanceToLine);
}
vec3 tintTo(vec3 base, float amount) {
  return amount < 0.0 ? mix(base, vec3(0.0), -amount) : mix(base, vec3(1.0), amount);
}
${BODY}
void main() {
  clipWorld();
  float alpha = mix(v_color.a, 1.0, u_forceColor) * u_tint.a;
  if (alpha <= 0.0001) discard;
  vec3 base = mix(mix(v_color.rgb * u_tint.rgb, u_tint.rgb, u_forceColor), vec3(1.0), clamp(u_flash, 0.0, 1.0));
  vec3 rgb = base;
  float effect = v_surface.x;
  if (effect < 0.5) {
    ${kind === "yarn" ? "rgb = shadeYarnFill(rgb);" : "rgb = shadeSketchFill(rgb);"}
    gl_FragColor = vec4(rgb * alpha, alpha);
    return;
  }
  ${kind === "yarn" ? "shadeYarnEdge(rgb, alpha);" : "shadeSketchEdge(rgb, alpha);"}
}`;
}
var YARN_FRAGMENT_BODY = `
vec3 shadeYarnFill(vec3 base) {
  float stitchWidth = abs(u_effect0.y), stitchHeight = u_effect0.z;
  if (u_effect0.w < 0.0 || stitchWidth <= 0.0 || stitchHeight <= 0.0) return base;
  float cols = max(2.0, ceil(u_bounds.z / stitchWidth));
  float rows = max(2.0, ceil(u_bounds.w / stitchHeight));
  float sx = u_bounds.z / cols, sy = u_bounds.w / rows;
  vec2 local = v_position;
  if (u_effect3.z > 0.5) {
    float rx = max(u_bounds.z * 0.5, 0.0001), ry = max(u_bounds.w * 0.5, 0.0001);
    float nx = clamp((local.x - (u_bounds.x + rx)) / rx, -1.35, 1.35);
    float ny = (local.y - (u_bounds.y + ry)) / ry;
    local.x += (sin(nx * 1.1) / 0.89120736 - nx) * rx;
    local.y += ry * 0.13 * nx * nx * (1.0 - ny * 0.24);
  }
  vec2 cell = (local - u_bounds.xy) / vec2(sx, sy);
  vec2 index = floor(cell);
  float jitterX = (hashCell(index, 71.0) - 0.5) * u_effect1.x;
  float jitterY = (hashCell(index, 39.0) - 0.5) * u_effect1.x;
  float scaleX = 1.0 + (hashCell(index, 57.0) - 0.5) * u_effect1.x;
  float scaleY = 1.0 + (hashCell(index, 91.0) - 0.5) * u_effect1.x;
  vec2 p = (fract(cell) - vec2(0.5 + jitterX, 0.5 + jitterY)) / vec2(scaleX, scaleY);
  p *= vec2(sx, sy);
  float stroke = min(sx, sy) * (abs(u_effect0.w) / stitchHeight);
  float underDistance = cubicDistance(p-vec2(0.0,stroke*0.06), vec2(-0.48,-0.46)*vec2(sx,sy), vec2(-0.22,-0.57)*vec2(sx,sy), vec2(0.22,-0.57)*vec2(sx,sy), vec2(0.48,-0.46)*vec2(sx,sy));
  vec2 leftA=vec2(-0.34,-0.36)*vec2(sx,sy), leftB=vec2(-0.32,-0.06)*vec2(sx,sy), leftC=vec2(-0.18,0.17)*vec2(sx,sy), leftD=vec2(-0.025,0.34)*vec2(sx,sy);
  vec2 rightA=vec2(0.34,-0.36)*vec2(sx,sy), rightB=vec2(0.32,-0.06)*vec2(sx,sy), rightC=vec2(0.18,0.17)*vec2(sx,sy), rightD=vec2(0.025,0.34)*vec2(sx,sy);
  float leftDistance = cubicDistance(p,leftA,leftB,leftC,leftD);
  float rightDistance = cubicDistance(p,rightA,rightB,rightC,rightD);
  float under = lineMask(underDistance, stroke*0.5) * 0.5;
  float grooveLeft = cubicDistance(p-vec2(0.0,stroke*0.06),leftA,leftB,leftC,leftD);
  float grooveRight = cubicDistance(p-vec2(0.0,stroke*0.06),rightA,rightB,rightC,rightD);
  float groove = max(lineMask(grooveLeft,stroke*1.08),lineMask(grooveRight,stroke*1.08))*0.85;
  float yarn = max(lineMask(leftDistance,stroke*0.89),lineMask(rightDistance,stroke*0.89));
  float lightLeft = cubicDistance(p+vec2(stroke*0.14,stroke*0.13),leftA,leftB,leftC,leftD);
  float lightRight = cubicDistance(p+vec2(stroke*0.14,stroke*0.13),rightA,rightB,rightC,rightD);
  float light = max(lineMask(lightLeft,stroke*0.34),lineMask(lightRight,stroke*0.34))*0.57;
  float twist = 0.0;
  if (mod(index.x + index.y, 2.0) < 1.0) {
    float a = segmentDistance(p,vec2(-0.32,-0.12)*vec2(sx,sy),vec2(-0.16,-0.13)*vec2(sx,sy));
    float b = segmentDistance(p,vec2(0.22,0.18)*vec2(sx,sy),vec2(0.37,0.08)*vec2(sx,sy));
    twist = max(lineMask(a,stroke*0.075),lineMask(b,stroke*0.075))*0.5;
  }
  vec3 dark = tintTo(base,-0.28), grooveColor = tintTo(base,-u_effect1.y);
  vec3 yarnColor = tintTo(base,0.10), highlight = tintTo(base,0.38);
  vec3 color = mix(base,dark,under);
  color = mix(color,grooveColor,groove);
  color = mix(color,yarnColor,yarn);
  color = mix(color,highlight,max(light*0.57,twist));
  return color;
}
void shadeYarnEdge(inout vec3 rgb, float alpha) {
  float radial = v_surface.z;
  float along = v_surface.y * u_effect3.y;
  float edgeWidth = u_effect1.w;
  float lobe = fract(along / max(u_effect1.z, 0.001));
  float relief = min(u_effect3.w, edgeWidth * 0.75);
  float wave = sin(lobe * 6.2831853) * relief * 0.35;
  float seam = lineMask(abs(radial - wave),edgeWidth*0.56);
  float seamDark = lineMask(abs(radial - wave - edgeWidth*0.06),edgeWidth*0.8)*0.7;
  float seamLight = lineMask(abs(radial - wave + edgeWidth*0.09),edgeWidth*0.17)*0.55;
  float spacing = max(u_effect2.x,0.001);
  float fiberIndex = floor(along / spacing);
  float jitter = hashCell(vec2(fiberIndex,0.0),22.0);
  float start = spacing * (fiberIndex + 0.22 + jitter * 0.48);
  float randomLength = 0.45 + hashCell(vec2(fiberIndex,0.0),5.0) * 0.95;
  float lengthLimit = min(u_effect2.y,max(u_bounds.z,u_bounds.w)*0.12)*randomLength;
  float lean = (hashCell(vec2(fiberIndex,0.0),14.0)-0.5)*lengthLimit*1.5;
  float alongDistance = abs(along - start - lean * clamp(radial/max(lengthLimit,0.001),0.0,1.0));
  float fiber = 0.0;
  if (u_effect3.x > 0.0 && fiberIndex < u_effect3.x && radial >= 0.0 && radial <= lengthLimit) {
    fiber = lineMask(alongDistance,u_effect2.z);
  }
  float coverage = max(max(seam,seamDark*0.6),max(seamLight,fiber*u_effect2.w));
  if (coverage < 0.012) discard;
  vec3 dark=tintTo(rgb,-0.28), yarn=tintTo(rgb,0.10), light=tintTo(rgb,0.38);
  rgb=mix(rgb,dark,seamDark*0.7);
  rgb=mix(rgb,yarn,seam);
  rgb=mix(rgb,light,max(seamLight,fiber*0.7));
  float outAlpha=alpha*coverage;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
var SKETCH_FRAGMENT_BODY = `
vec3 shadeSketchFill(vec3 base) {
  float angle=u_effect1.z, spacing=max(u_effect1.w,0.001);
  vec2 direction=vec2(cos(angle),sin(angle));
  float phase=dot(v_position,direction)/spacing + hashCell(vec2(u_effect0.x,0.0),31.0);
  float distanceToHatch=abs(fract(phase)-0.5)*spacing;
  float hatch=lineMask(distanceToHatch,u_effect2.x)*u_effect2.y;
  return mix(base,tintTo(base,-0.48),hatch);
}
void shadeSketchEdge(inout vec3 rgb, float alpha) {
  float phase=mod(u_timeMs,max(u_effect0.y,16.0))/max(u_effect0.y,16.0)*6.2831853;
  float wobble=sin(v_surface.y*u_effect0.z*6.2831853+phase+u_effect0.x)*u_effect1.x;
  float offset=(u_effect1.y+wobble);
  float echo=lineMask(abs(v_surface.z-offset),u_effect1.z)*u_effect1.w;
  if(echo<0.012)discard;
  rgb=mix(rgb,tintTo(rgb,-0.52),echo);
  float outAlpha=alpha*echo;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
function finiteArray3(value, count, name) {
  if (!value || value.length !== count || Array.from(value).some((number) => !Number.isFinite(number))) {
    throw new TypeError(`${name} needs ${count} finite numbers`);
  }
}
function validateStyle(style) {
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    throw new TypeError("A complete SVG-authored yarn or sketch style is required");
  }
  const YARN_REQUIRED = [
    "seed",
    "stitchWidth",
    "stitchHeight",
    "thickness",
    "irregularity",
    "contrast",
    "edgeSpacing",
    "edgeRelief",
    "edgeWidth",
    "fiberLength",
    "fiberWidth",
    "fiberOpacity",
    "fiberMax"
  ];
  const SKETCH_REQUIRED = [
    "seed",
    "periodMs",
    "amplitude",
    "frequency",
    "echoX",
    "echoY",
    "echoWidth",
    "echoOpacity",
    "hatchAngle",
    "hatchSpacing",
    "hatchWidth",
    "hatchOpacity"
  ];
  const FIELDS = style.kind === "yarn" ? YARN_REQUIRED : style.kind === "sketch" ? SKETCH_REQUIRED : null;
  if (!FIELDS || FIELDS.some((key) => !Number.isFinite(style[key]))) {
    throw new TypeError("Unsupported or incomplete SVG surface style");
  }
  if (style.seed < 0 || style.seed > 2147483647 || !Number.isSafeInteger(style.seed)) {
    throw new RangeError("Surface seed must be a nonnegative 31-bit integer");
  }
  if (style.kind === "yarn") {
    for (const KEY of [
      "stitchWidth",
      "stitchHeight",
      "thickness",
      "edgeSpacing",
      "edgeRelief",
      "edgeWidth",
      "fiberLength",
      "fiberWidth"
    ]) {
      if (style[KEY] <= 0) {
        throw new RangeError(`Yarn ${KEY} must be positive`);
      }
    }
    for (const KEY of ["irregularity", "contrast", "fiberOpacity"]) {
      if (style[KEY] < 0 || style[KEY] > 1) {
        throw new RangeError(`Yarn ${KEY} must be in [0,1]`);
      }
    }
    if (!Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) {
      throw new RangeError("Yarn fiberMax must be an integer from 0 to 512");
    }
    for (const KEY of ["fiberSpacing", "curved", "pattern", "detail", "fiber"]) {
      if (style[KEY] !== void 0 && (KEY === "fiberSpacing" ? !Number.isFinite(style[KEY]) || style[KEY] <= 0 : typeof style[KEY] !== "boolean")) {
        throw new TypeError(`Invalid Yarn ${KEY}`);
      }
    }
  } else {
    if (!Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 1e4) {
      throw new RangeError("Sketch periodMs must be 16..10000");
    }
    for (const KEY of ["amplitude", "frequency", "echoWidth", "hatchSpacing", "hatchWidth"]) {
      if (style[KEY] <= 0) {
        throw new RangeError(`Sketch ${KEY} must be positive`);
      }
    }
    for (const KEY of ["echoOpacity", "hatchOpacity"]) {
      if (style[KEY] < 0 || style[KEY] > 1) {
        throw new RangeError(`Sketch ${KEY} must be in [0,1]`);
      }
    }
  }
}
function normalizeOutline(outline, sourceIndices) {
  if (!(outline instanceof Float32Array || Array.isArray(outline)) || outline.length < 8 || outline.length % 2) {
    throw new TypeError("Closed SVG contour must contain at least four x/y points");
  }
  const POINTS = [];
  for (let i = 0; i < outline.length; i += 2) {
    const X = outline[i], Y = outline[i + 1];
    if (!Number.isFinite(X) || !Number.isFinite(Y)) {
      throw new TypeError("SVG contour points must be finite");
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
    throw new TypeError("SVG contour requires at least three distinct points");
  }
  return POINTS;
}
function surfaceGeometry(fillVertices, outline, edgeColors, style) {
  if (!(fillVertices instanceof Float32Array) || fillVertices.length < 18 || fillVertices.length % 18) {
    throw new TypeError("Filled surface requires complete triangles in a six-float position/color layout");
  }
  const SOURCE_INDICES = [], POINTS = normalizeOutline(outline, SOURCE_INDICES);
  if (edgeColors !== void 0 && (!(edgeColors instanceof Float32Array) || edgeColors.length !== POINTS.length * 4 && edgeColors.length !== outline.length * 2)) {
    throw new TypeError("edgeColors must contain one RGBA color per contour point");
  }
  if (edgeColors && edgeColors.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError("edgeColors must contain finite RGBA values in [0,1]");
  }
  if (edgeColors && edgeColors.length !== POINTS.length * 4) {
    const ORIGINAL_COLORS = edgeColors;
    edgeColors = Float32Array.from(
      SOURCE_INDICES.flatMap((index) => Array.from(ORIGINAL_COLORS.subarray(index * 4, index * 4 + 4)))
    );
  }
  for (let i = 0; i < fillVertices.length; i++) {
    if (!Number.isFinite(fillVertices[i])) {
      throw new TypeError("Filled surface vertices must be finite");
    }
    const FIELD = i % 6;
    if (FIELD >= 2 && (fillVertices[i] < 0 || fillVertices[i] > 1)) {
      throw new RangeError("Surface colors must be in [0,1]");
    }
  }
  const LENGTHS = [], NORMALS = [];
  let total = 0;
  let signedArea = 0;
  for (let i = 0; i < POINTS.length; i++) {
    const A = POINTS[i], B = POINTS[(i + 1) % POINTS.length], DX = B[0] - A[0], DY = B[1] - A[1], LENGTH = Math.hypot(DX, DY);
    if (!LENGTH) {
      throw new TypeError("SVG contour cannot contain zero-length edges");
    }
    LENGTHS.push(LENGTH);
    total += LENGTH;
    signedArea += A[0] * B[1] - B[0] * A[1];
    NORMALS.push([DY / LENGTH, -DX / LENGTH]);
  }
  if (Math.abs(signedArea) < 1e-6) {
    throw new TypeError("SVG contour cannot have zero area");
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
    throw new TypeError("Filled surface bounds must have positive area");
  }
  const RGBA = edgeColors ? edgeColors : (() => {
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
  const EDGE_WIDTH = style.kind === "yarn" ? style.edgeWidth : Math.max(style.echoWidth, Math.hypot(style.echoX, style.echoY) + style.amplitude + style.echoWidth);
  const FIBER_LENGTH = style.kind === "yarn" && style.fiber !== false ? style.fiberLength : EDGE_WIDTH;
  const FILL_RECORDS = new Float32Array(fillVertices.length / 6 * STRIDE_FLOATS);
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
    const PREVIOUS = NORMALS[(i + POINTS.length - 1) % POINTS.length], CURRENT = NORMALS[i];
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
  const EDGE_RECORDS = [];
  const COLOR_AT = (index) => RGBA.subarray(index * 4, index * 4 + 4);
  for (let i = 0; i < POINTS.length; i++) {
    const J = (i + 1) % POINTS.length;
    const EMIT = (pointIndex, distance) => {
      const POINT = POINTS[pointIndex], NORMAL = RING[pointIndex], X = POINT[0] + NORMAL[0] * distance, Y = POINT[1] + NORMAL[1] * distance;
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
    contourLength: total
  });
}
function clipPlanes(clips, maxPlanes) {
  const PACKED = new Float32Array(maxPlanes * 3);
  if (!clips?.length) {
    return PACKED;
  }
  if (!Array.isArray(clips)) {
    throw new TypeError("clips must be an array of convex polygons");
  }
  let cursor = 0;
  for (const POLYGON of clips) {
    if (!Array.isArray(POLYGON) || POLYGON.length < 3 || POLYGON.some((point2) => !Number.isFinite(point2?.x) || !Number.isFinite(point2?.y))) {
      throw new TypeError("Finite convex clip polygons required");
    }
    let area = 0;
    for (let i = 0; i < POLYGON.length; i++) {
      const A = POLYGON[i], B = POLYGON[(i + 1) % POLYGON.length];
      area += A.x * B.y - B.x * A.y;
    }
    if (Math.abs(area) < 1e-8) {
      throw new RangeError("A clip polygon must have nonzero area");
    }
    const SIGN = area >= 0 ? 1 : -1;
    for (let i = 0; i < POLYGON.length; i++) {
      const A = POLYGON[i], B = POLYGON[(i + 1) % POLYGON.length], DX = B.x - A.x, DY = B.y - A.y, LENGTH = Math.hypot(DX, DY);
      if (!LENGTH) {
        continue;
      }
      if (cursor >= maxPlanes) {
        throw new RangeError(`Shader surface clipping exceeds the device limit of ${maxPlanes} edge planes`);
      }
      const AT = cursor++ * 3, NX = -DY / LENGTH * SIGN, NY = DX / LENGTH * SIGN;
      PACKED[AT] = NX;
      PACKED[AT + 1] = NY;
      PACKED[AT + 2] = -(NX * A.x + NY * A.y);
    }
  }
  return PACKED;
}
function toMatrix3(matrix) {
  finiteArray3(matrix, 6, "transform");
  return Float32Array.of(matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1);
}
function affineMatrix42(matrix, name) {
  finiteArray3(matrix, 16, name);
  if (Math.abs(matrix[3]) > 1e-7 || Math.abs(matrix[7]) > 1e-7 || Math.abs(matrix[11]) > 1e-7 || Math.abs(matrix[15] - 1) > 1e-7) {
    throw new TypeError(`${name} must be an affine column-major 4x4 matrix`);
  }
}
var YarnSurfaceRenderer = class {
  constructor(device, { maxSurfaces = MAX_SURFACES, maxSurfaceBytes = DEFAULT_LIMIT_BYTES } = {}) {
    if (!device?.createPipeline || !device?.uploadVertices || !device?.draw) {
      throw new TypeError("A ready GameKit WebGLDevice is required");
    }
    if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1 || maxSurfaces > MAX_SURFACES) {
      throw new RangeError(`maxSurfaces must be 1..${MAX_SURFACES}`);
    }
    if (!Number.isSafeInteger(maxSurfaceBytes) || maxSurfaceBytes < STRIDE_BYTES * 3 || maxSurfaceBytes > device.maxBufferBytes) {
      throw new RangeError("maxSurfaceBytes must fit the device buffer limit");
    }
    this.device = device;
    this.maxSurfaces = maxSurfaces;
    this.maxSurfaceBytes = maxSurfaceBytes;
    this.maxClipPlanes = Math.max(
      1,
      Math.min(8, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 8)
    );
    this.surfaces = /* @__PURE__ */ new Set();
    this.bytes = 0;
    this.pipelines = /* @__PURE__ */ new Map();
    this.state = "ready";
    this.failure = null;
    this.disposed = false;
    this.onLost = () => {
      this.state = "lost";
    };
    this.onRestored = () => {
      try {
        for (const SURFACE of this.surfaces) {
          device.uploadVertices(SURFACE.buffer, SURFACE.vertices);
        }
        this.state = "ready";
        this.failure = null;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
      }
    };
    device.canvas.addEventListener("webglcontextlost", this.onLost);
    device.canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _pipeline(kind, worldMode = false) {
    const KEY = kind + ":" + Number(worldMode);
    let pipeline = this.pipelines.get(KEY);
    if (pipeline) {
      return pipeline;
    }
    const UNIFORMS2 = {
      ...worldMode ? {
        u_viewProjection: "matrix4fv",
        u_worldMatrix: "matrix4fv"
      } : {
        u_projection: "matrix3fv"
      },
      u_transform: "matrix3fv",
      u_depth: "1f",
      u_bounds: "4f",
      u_effect0: "4f",
      u_effect1: "4f",
      u_effect2: "4f",
      u_effect3: "4f",
      u_tint: "4f",
      u_flash: "1f",
      u_forceColor: "1f",
      "u_planes[0]": "3fv",
      ...kind === "sketch" ? {
        u_timeMs: "1f"
      } : {}
    };
    pipeline = this.device.createPipeline({
      vertex: worldMode ? VERTEX_WORLD : VERTEX2,
      fragment: fragment2(kind, this.maxClipPlanes),
      stride: STRIDE_BYTES,
      attributes: ATTRIBUTES2,
      uniforms: UNIFORMS2
    });
    this.pipelines.set(KEY, pipeline);
    return pipeline;
  }
  createSurface({ fillVertices, outline, edgeColors, style }) {
    if (this.disposed || this.state !== "ready") {
      throw new Error(`YarnSurfaceRenderer is ${this.state}`);
    }
    validateStyle(style);
    if (this.surfaces.size >= this.maxSurfaces) {
      throw new RangeError("Retained yarn surface count limit exceeded");
    }
    const GEOMETRY = surfaceGeometry(fillVertices, outline, edgeColors, style);
    const VERTICES = GEOMETRY.vertices.slice();
    if (this.bytes + VERTICES.byteLength > this.maxSurfaceBytes) {
      throw new RangeError("Retained yarn surface byte budget exceeded");
    }
    const PIPELINE = this._pipeline(style.kind);
    const BUFFER = this.device.createVertexBuffer({
      capacityBytes: VERTICES.byteLength
    });
    try {
      this.device.uploadVertices(BUFFER, VERTICES);
    } catch (error) {
      this.device.deleteVertexBuffer(BUFFER);
      throw error;
    }
    const SURFACE = Object.freeze({
      renderer: this,
      buffer: BUFFER,
      vertices: VERTICES,
      byteLength: VERTICES.byteLength,
      style: Object.freeze({
        ...style
      }),
      kind: style.kind,
      fillFirst: GEOMETRY.fillFirst,
      fillCount: GEOMETRY.fillCount,
      edgeFirst: GEOMETRY.edgeFirst,
      edgeCount: GEOMETRY.edgeCount,
      edgeByteOffset: GEOMETRY.edgeByteOffset,
      bounds: GEOMETRY.bounds,
      contourLength: GEOMETRY.contourLength,
      pipeline: PIPELINE
    });
    this.surfaces.add(SURFACE);
    this.bytes += SURFACE.byteLength;
    return SURFACE;
  }
  drawSurface(surface, {
    projection,
    viewProjection,
    worldMatrix,
    transform = IDENTITY4,
    color: color2 = WHITE3,
    alpha = 1,
    forceColor = false,
    whiteFlash = 0,
    timeMs = 0,
    clips = [],
    stencilRef = null,
    z = 0,
    depth = false,
    blend = "source-over"
  } = {}) {
    if (this.disposed || this.state !== "ready") {
      throw new Error(`YarnSurfaceRenderer is ${this.state}${this.failure ? ": " + this.failure : ""}`);
    }
    if (!this.surfaces.has(surface)) {
      throw new TypeError("Surface must belong to this YarnSurfaceRenderer");
    }
    const WORLD_MODE = viewProjection !== void 0 || worldMatrix !== void 0;
    if (WORLD_MODE) {
      if (projection !== void 0 || viewProjection === void 0 || worldMatrix === void 0) {
        throw new TypeError(
          "3D surface draws require viewProjection and worldMatrix and cannot include projection"
        );
      }
      finiteArray3(viewProjection, 16, "viewProjection");
      affineMatrix42(worldMatrix, "worldMatrix");
    } else {
      finiteArray3(projection, 9, "projection");
    }
    finiteArray3(color2, 4, "color");
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color2.some((value) => value < 0 || value > 1)) {
      throw new RangeError("Surface tint/alpha must be in [0,1]");
    }
    if (typeof forceColor !== "boolean") {
      throw new TypeError("forceColor must be boolean");
    }
    if (!Number.isFinite(whiteFlash) || whiteFlash < 0 || whiteFlash > 1) {
      throw new RangeError("whiteFlash must be in [0,1]");
    }
    if (!Number.isFinite(timeMs)) {
      throw new TypeError("timeMs must be finite");
    }
    if (!Number.isFinite(z) || z < -1 || z > 1) {
      throw new RangeError("z must be in [-1,1]");
    }
    if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) {
      throw new RangeError("stencilRef must be null or in [0,255]");
    }
    if (stencilRef !== null && !this.device.activeStencilAvailable) {
      throw new Error("A stencil-tested yarn surface requires an active stencil attachment");
    }
    const PLANES = clipPlanes(clips, this.maxClipPlanes), STYLE = surface.style;
    const YARN = surface.kind === "yarn";
    const STITCH_PATTERN = STYLE.pattern !== false;
    const EFFECT0 = YARN ? [STYLE.seed, STYLE.stitchWidth, STYLE.stitchHeight, (STITCH_PATTERN ? 1 : -1) * STYLE.thickness] : [STYLE.seed, STYLE.periodMs, STYLE.frequency, 0];
    const EFFECT1 = YARN ? [STYLE.irregularity, STYLE.contrast, STYLE.edgeSpacing, STYLE.edgeWidth] : [STYLE.amplitude, STYLE.echoX, STYLE.echoWidth, STYLE.echoOpacity];
    const EFFECT2 = YARN ? [STYLE.fiberSpacing ?? 4, STYLE.fiberLength, STYLE.fiberWidth, STYLE.fiberOpacity] : [STYLE.hatchWidth, STYLE.hatchOpacity, STYLE.hatchAngle, STYLE.hatchSpacing];
    const EFFECT3 = YARN ? [
      STYLE.fiber === false ? 0 : STYLE.fiberMax,
      surface.contourLength,
      STYLE.curved === false ? 0 : 1,
      STYLE.edgeRelief * (STYLE.detail ? 0.3 : 1)
    ] : [0, STYLE.echoY, 0, 0];
    const UNIFORMS2 = {
      ...WORLD_MODE ? {
        u_viewProjection: viewProjection,
        u_worldMatrix: worldMatrix
      } : {
        u_projection: projection
      },
      u_transform: toMatrix3(transform),
      u_depth: z,
      u_bounds: surface.bounds,
      u_effect0: EFFECT0,
      u_effect1: EFFECT1,
      u_effect2: EFFECT2,
      u_effect3: EFFECT3,
      u_tint: [color2[0], color2[1], color2[2], color2[3] * alpha],
      u_flash: whiteFlash,
      u_forceColor: forceColor ? 1 : 0,
      "u_planes[0]": PLANES,
      ...YARN ? {} : {
        u_timeMs: (timeMs % STYLE.periodMs + STYLE.periodMs) % STYLE.periodMs
      }
    };
    const COMMON = {
      pipeline: this._pipeline(surface.kind, WORLD_MODE),
      buffer: surface.buffer,
      uniforms: UNIFORMS2,
      blend,
      depth,
      stencil: stencilRef === null ? false : {
        func: "equal",
        ref: stencilRef,
        mask: 255,
        writeMask: 0,
        pass: "keep"
      }
    };
    this.device.draw({
      ...COMMON,
      first: surface.fillFirst,
      count: surface.fillCount
    });
    if (surface.edgeCount) {
      const EDGE_DEPTH = depth === true ? {
        test: true,
        write: false
      } : depth && typeof depth === "object" ? {
        ...depth,
        write: false
      } : depth;
      this.device.draw({
        ...COMMON,
        first: surface.edgeFirst,
        count: surface.edgeCount,
        depth: EDGE_DEPTH
      });
    }
  }
  deleteSurface(surface) {
    if (!this.surfaces.has(surface)) {
      return false;
    }
    this.device.deleteVertexBuffer(surface.buffer);
    this.surfaces.delete(surface);
    this.bytes -= surface.byteLength;
    return true;
  }
  stats() {
    return Object.freeze({
      state: this.state,
      surfaceCount: this.surfaces.size,
      retainedBytes: this.bytes,
      pipelineCount: this.pipelines.size,
      maxClipPlanes: this.maxClipPlanes
    });
  }
  dispose() {
    if (this.disposed) {
      return false;
    }
    this.device.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const SURFACE of this.surfaces) {
      this.device.deleteVertexBuffer(SURFACE.buffer);
    }
    for (const PIPELINE of this.pipelines.values()) {
      this.device.deletePipeline(PIPELINE);
    }
    this.surfaces.clear();
    this.pipelines.clear();
    this.bytes = 0;
    this.disposed = true;
    this.state = "disposed";
    return true;
  }
};
function buildYarnSurfaceGeometry(options) {
  validateStyle(options?.style);
  return surfaceGeometry(options.fillVertices, options.outline, options.edgeColors, options.style);
}

// modules/rendering/glyph-atlas.js
var GlyphAtlas = class {
  constructor(device, {
    width,
    height,
    data,
    glyphs,
    unitsPerEm = 1,
    ascent = 0.8,
    descent = 0.2,
    filter = "linear",
    missingGlyph = "error",
    replacement = "�"
  } = {}) {
    if (!device || typeof device.createTexture !== "function" || typeof device.deleteTexture !== "function") {
      throw new TypeError("device must provide WebGLDevice createTexture/deleteTexture");
    }
    positiveInteger(width, "width");
    positiveInteger(height, "height");
    positive(unitsPerEm, "unitsPerEm");
    nonNegative(ascent, "ascent");
    nonNegative(descent, "descent");
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
      throw new TypeError("data must contain width*height*4 RGBA bytes");
    }
    if (!glyphs || typeof glyphs !== "object") {
      throw new TypeError("glyphs must be a code-point keyed metric object");
    }
    if (!["error", "skip", "replacement"].includes(missingGlyph)) {
      throw new RangeError("missingGlyph must be error, skip, or replacement");
    }
    if (typeof replacement !== "string" || [...replacement].length !== 1) {
      throw new TypeError("replacement must be one Unicode code point");
    }
    this.device = device;
    this.width = width;
    this.height = height;
    this.unitsPerEm = unitsPerEm;
    this.ascent = ascent;
    this.descent = descent;
    this.missingGlyph = missingGlyph;
    this.replacement = replacement;
    this.glyphs = /* @__PURE__ */ new Map();
    for (const [KEY, VALUE] of Object.entries(glyphs)) {
      const CODE_POINT = normalizeCodePoint(KEY);
      this.glyphs.set(CODE_POINT, validateGlyph(VALUE, width, height, CODE_POINT));
    }
    if (filter !== "nearest" && filter !== "linear") {
      throw new RangeError("filter must be nearest or linear");
    }
    this.texture = device.createTexture(
      {
        width,
        height,
        data
      },
      {
        format: "rgba",
        filter
      }
    );
    this.disposed = false;
  }
  /** Returns the metrics in the same units as the requested fontSize. */
  measureText(text, { fontSize = this.unitsPerEm, align = "left" } = {}) {
    this._live();
    validateText(text);
    positive(fontSize, "fontSize");
    validateAlign(align);
    const GLYPHS = this._resolve(text);
    const WIDTH = GLYPHS.reduce((sum, glyph) => sum + glyph.advance, 0) * fontSize / this.unitsPerEm;
    return {
      width: WIDTH,
      ascent: this.ascent * fontSize / this.unitsPerEm,
      descent: this.descent * fontSize / this.unitsPerEm,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: WIDTH
    };
  }
  /**
   * Emits one callback per visible glyph. The callback receives texture, atlas
   * UVs, destination rectangle, RGBA color, and operation='fill'.
   * Also accepts `(renderer, text, x, y, options)` when renderer provides
   * `drawGlyphQuad(texture, x, y, width, height, uv, color)`.
   */
  fillText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const ARGS = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    return this._draw("fill", ARGS.text, ARGS.x, ARGS.y, ARGS.options, ARGS.drawGlyph);
  }
  /**
   * Emits an outline as eight offset glyph passes. This is a
   * geometric atlas outline; it does not modify or rasterize atlas pixels.
   * `lineWidth` is in destination units.
   */
  strokeText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const ARGS = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    const { text: TEXT, x: X, y: Y, options: OPTIONS, drawGlyph: DRAW_GLYPH } = ARGS;
    const { lineWidth: LINE_WIDTH = 1, strokeColor: STROKE_COLOR = OPTIONS.color ?? [0, 0, 0, 1] } = OPTIONS;
    positive(LINE_WIDTH, "lineWidth");
    validateColor(STROKE_COLOR, "strokeColor");
    return this._draw(
      "stroke",
      TEXT,
      X,
      Y,
      {
        ...OPTIONS,
        color: STROKE_COLOR
      },
      DRAW_GLYPH,
      LINE_WIDTH
    );
  }
  _draw(operation, text, x, y, options, drawGlyph, lineWidth = 0) {
    this._live();
    validateText(text);
    finite2(x, "x");
    finite2(y, "y");
    if (typeof drawGlyph !== "function") {
      throw new TypeError("drawGlyph callback is required");
    }
    const {
      fontSize: FONT_SIZE = this.unitsPerEm,
      align: ALIGN = "left",
      baseline: BASELINE = "alphabetic",
      color: COLOR = [1, 1, 1, 1]
    } = options;
    positive(FONT_SIZE, "fontSize");
    validateAlign(ALIGN);
    validateColor(COLOR, "color");
    const RESOLVED = this._resolve(text);
    const SCALE = FONT_SIZE / this.unitsPerEm;
    const ADVANCE = RESOLVED.reduce((sum, glyph) => sum + glyph.advance, 0) * SCALE;
    let penX = x - (ALIGN === "center" ? ADVANCE / 2 : ALIGN === "right" ? ADVANCE : 0);
    const BASELINE_Y = baselineOffset(BASELINE, FONT_SIZE, this.unitsPerEm, this.ascent, this.descent, y);
    const OFFSETS = lineWidth ? [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1]
    ] : [[0, 0]];
    for (const GLYPH of RESOLVED) {
      if (GLYPH.width > 0 && GLYPH.height > 0) {
        const LEFT = penX + GLYPH.bearingX * SCALE;
        const TOP = BASELINE_Y - GLYPH.bearingY * SCALE;
        for (const [OX, OY] of OFFSETS) {
          drawGlyph({
            texture: this.texture,
            glyph: GLYPH,
            codePoint: GLYPH.codePoint,
            x: LEFT + OX * lineWidth,
            y: TOP + OY * lineWidth,
            width: GLYPH.width * SCALE,
            height: GLYPH.height * SCALE,
            u0: GLYPH.x / this.width,
            v0: GLYPH.y / this.height,
            u1: (GLYPH.x + GLYPH.width) / this.width,
            v1: (GLYPH.y + GLYPH.height) / this.height,
            color: COLOR,
            operation: lineWidth ? "stroke" : operation
          });
        }
      }
      penX += GLYPH.advance * SCALE;
    }
    return {
      x: x - (ALIGN === "center" ? ADVANCE / 2 : ALIGN === "right" ? ADVANCE : 0),
      y: BASELINE_Y,
      width: ADVANCE,
      glyphCount: RESOLVED.length
    };
  }
  _resolve(text) {
    const RESULT = [];
    for (const CHARACTER of text) {
      let glyph = this.glyphs.get(CHARACTER.codePointAt(0));
      if (!glyph) {
        if (this.missingGlyph === "skip") {
          continue;
        }
        if (this.missingGlyph === "replacement") {
          glyph = this.glyphs.get(this.replacement.codePointAt(0));
        }
        if (!glyph) {
          throw new RangeError(`missing glyph U+${CHARACTER.codePointAt(0).toString(16).toUpperCase()}`);
        }
      }
      RESULT.push(glyph);
    }
    return RESULT;
  }
  _live() {
    if (this.disposed) {
      throw new Error("GlyphAtlas is disposed");
    }
  }
  /** Idempotently releases the atlas texture through its owning device. */
  dispose() {
    if (this.disposed) {
      return false;
    }
    this.disposed = true;
    this.device.deleteTexture(this.texture);
    this.texture = null;
    return true;
  }
};
function normalizeCodePoint(key) {
  if (/^U\+[0-9a-f]{1,6}$/i.test(key)) {
    return Number.parseInt(key.slice(2), 16);
  }
  const CHARS = [...key];
  if (CHARS.length === 1) {
    return CHARS[0].codePointAt(0);
  }
  if (/^0x[0-9a-f]+$/i.test(key)) {
    return Number.parseInt(key.slice(2), 16);
  }
  throw new TypeError(`invalid glyph key: ${key}`);
}
function normalizeDrawArguments(first, second, third, fourth, fifth) {
  if (first && typeof first.drawGlyphQuad === "function") {
    const RENDERER = first, TEXT2 = second, X2 = third, Y2 = fourth, OPTIONS2 = fifth ?? {};
    return {
      text: TEXT2,
      x: X2,
      y: Y2,
      options: OPTIONS2,
      drawGlyph: (glyph) => RENDERER.drawGlyphQuad(
        glyph.texture,
        glyph.x,
        glyph.y,
        glyph.width,
        glyph.height,
        {
          u0: glyph.u0,
          v0: glyph.v0,
          u1: glyph.u1,
          v1: glyph.v1
        },
        glyph.color
      )
    };
  }
  const TEXT = first, X = second, Y = third, OPTIONS = fourth ?? {};
  return {
    text: TEXT,
    x: X,
    y: Y,
    options: OPTIONS,
    drawGlyph: fifth ?? OPTIONS.drawGlyph
  };
}
function validateGlyph(value, atlasWidth, atlasHeight, codePoint) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`glyph U+${codePoint.toString(16)} must be a metric object`);
  }
  const {
    x: X,
    y: Y,
    width: WIDTH,
    height: HEIGHT,
    advance: ADVANCE,
    bearingX: BEARING_X = 0,
    bearingY: BEARING_Y = 0
  } = value;
  for (const [NAME, NUMBER] of Object.entries({
    x: X,
    y: Y,
    width: WIDTH,
    height: HEIGHT,
    advance: ADVANCE,
    bearingX: BEARING_X,
    bearingY: BEARING_Y
  })) {
    finite2(NUMBER, `glyph.${NAME}`);
  }
  if (X < 0 || Y < 0 || WIDTH < 0 || HEIGHT < 0 || X + WIDTH > atlasWidth || Y + HEIGHT > atlasHeight || ADVANCE < 0) {
    throw new RangeError(`glyph U+${codePoint.toString(16)} has invalid atlas bounds or advance`);
  }
  return Object.freeze({
    codePoint,
    x: X,
    y: Y,
    width: WIDTH,
    height: HEIGHT,
    advance: ADVANCE,
    bearingX: BEARING_X,
    bearingY: BEARING_Y
  });
}
function baselineOffset(baseline, fontSize, units, ascent, descent, y) {
  const SCALE = fontSize / units;
  switch (baseline) {
    case "alphabetic":
      return y;
    case "top":
    case "hanging":
      return y + ascent * SCALE;
    case "middle":
      return y + (ascent - descent) * SCALE / 2;
    case "bottom":
    case "ideographic":
      return y - descent * SCALE;
    default:
      throw new RangeError("baseline must be top, hanging, middle, alphabetic, ideographic, or bottom");
  }
}
function validateAlign(value) {
  if (!["left", "center", "right"].includes(value)) {
    throw new RangeError("align must be left, center, or right");
  }
}
function validateColor(value, name) {
  if (!value || value.length !== 4) {
    throw new TypeError(`${name} must be [r,g,b,a]`);
  }
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) {
      throw new RangeError(`${name} channels must be in [0,1]`);
    }
  }
}
function validateText(text) {
  if (typeof text !== "string") {
    throw new TypeError("text must be a string");
  }
}
function finite2(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}
function positive(value, name) {
  finite2(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}
function nonNegative(value, name) {
  finite2(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

// modules/rendering/font-assets.js
var ASSET_FORMAT = "budmori-glyph-atlas-v2-r8-packbits";
var SHA256 = /^[a-f0-9]{64}$/;
var ASSET_LOADS = /* @__PURE__ */ new Map();
var DEVICE_ATLASES = /* @__PURE__ */ new WeakMap();
function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} has an unsupported schema`);
  }
}
function safeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("font source is required");
  }
  exactKeys(source, ["url", "version", "sha256", "bytes"], "font source");
  const URL_LOCAL = new URL(source.url);
  if (!["https:", "http:"].includes(URL_LOCAL.protocol) || URL_LOCAL.username || URL_LOCAL.password || URL_LOCAL.hash) {
    throw new TypeError("font URL must be an absolute HTTP(S) URL without credentials or fragment");
  }
  if (typeof source.version !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(source.version)) {
    throw new TypeError("font version must be an explicit immutable identifier");
  }
  if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) {
    throw new TypeError("font SHA-256 is invalid");
  }
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 8 * 1024 * 1024) {
    throw new RangeError("font asset byte length must be 1..8388608");
  }
  return Object.freeze({
    url: URL_LOCAL.href,
    version: source.version,
    sha256: source.sha256,
    bytes: source.bytes
  });
}
async function digest(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is required to load font assets");
  }
  const HASH = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(HASH)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(value) {
  if (typeof value !== "string" || value.length > 8 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("font packed mask is invalid base64");
  }
  const BINARY = atob(value);
  const BYTES = new Uint8Array(BINARY.length);
  for (let index = 0; index < BINARY.length; index++) {
    BYTES[index] = BINARY.charCodeAt(index);
  }
  return BYTES;
}
function unpackMask(packed, expectedBytes) {
  const MASK = new Uint8Array(expectedBytes);
  let input = 0;
  let output = 0;
  while (input < packed.length) {
    const TOKEN = packed[input++];
    if (TOKEN < 128) {
      const LENGTH = TOKEN + 1;
      if (input + LENGTH > packed.length || output + LENGTH > MASK.length) {
        throw new Error("font PackBits literal exceeds declared bounds");
      }
      MASK.set(packed.subarray(input, input + LENGTH), output);
      input += LENGTH;
      output += LENGTH;
    } else {
      const LENGTH = (TOKEN & 127) + 3;
      if (input >= packed.length || output + LENGTH > MASK.length) {
        throw new Error("font PackBits run exceeds declared bounds");
      }
      MASK.fill(packed[input++], output, output + LENGTH);
      output += LENGTH;
    }
  }
  if (output !== MASK.length) {
    throw new Error("font PackBits decoded length does not match its declaration");
  }
  return MASK;
}
async function decodeAsset(bytes) {
  let asset;
  try {
    asset = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true
      }).decode(bytes)
    );
  } catch {
    throw new Error("font asset is not valid UTF-8 JSON");
  }
  exactKeys(
    asset,
    ["format", "generatedBy", "provenance", "atlas", "glyphs", "missingCodePoints", "packedMaskBase64"],
    "font asset"
  );
  if (asset.format !== ASSET_FORMAT || asset.generatedBy !== "modules/rendering/scripts/generate-font-atlas.mjs") {
    throw new Error("font asset format or generator version is unsupported");
  }
  exactKeys(
    asset.atlas,
    [
      "width",
      "height",
      "packing",
      "unitsPerEm",
      "ascent",
      "descent",
      "colorFormat",
      "maskDecodedBytes",
      "maskSHA256",
      "codec",
      "packedMaskBytes",
      "packedMaskSHA256",
      "base64EncodedBytes",
      "base64Characters",
      "runtimeRgbaBytes",
      "encodedJsonBytes"
    ],
    "font atlas"
  );
  const {
    width: WIDTH,
    height: HEIGHT,
    maskDecodedBytes: MASK_DECODED_BYTES,
    packedMaskBytes: PACKED_MASK_BYTES,
    runtimeRgbaBytes: RUNTIME_RGBA_BYTES
  } = asset.atlas;
  if (!Number.isSafeInteger(WIDTH) || !Number.isSafeInteger(HEIGHT) || WIDTH < 1 || HEIGHT < 1 || WIDTH * HEIGHT > 16777216 || MASK_DECODED_BYTES !== WIDTH * HEIGHT || RUNTIME_RGBA_BYTES !== WIDTH * HEIGHT * 4 || !Number.isSafeInteger(PACKED_MASK_BYTES) || PACKED_MASK_BYTES < 1 || asset.atlas.colorFormat !== "R8 glyph coverage mask; renderer expands to white RGBA bytes at startup" || asset.atlas.codec !== "PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times" || !SHA256.test(asset.atlas.maskSHA256) || !SHA256.test(asset.atlas.packedMaskSHA256)) {
    throw new Error("font atlas dimensions or encoding are invalid");
  }
  if (!asset.provenance || asset.provenance.font?.licenseSource !== "https://github.com/notofonts/noto-cjk" || !asset.provenance.font.license.includes("SIL Open Font License 1.1")) {
    throw new Error("font provenance or license is missing");
  }
  if (!Array.isArray(asset.missingCodePoints) || asset.missingCodePoints.length !== 0) {
    throw new Error("font asset contains missing glyphs");
  }
  if (!asset.glyphs || typeof asset.glyphs !== "object" || Array.isArray(asset.glyphs)) {
    throw new Error("font glyph inventory is invalid");
  }
  const GLYPH_KEYS = Object.keys(asset.glyphs);
  if (GLYPH_KEYS.length !== asset.provenance.uniqueCodePointCount || GLYPH_KEYS.length !== 750) {
    throw new Error("font glyph inventory differs from the published 750-codepoint version");
  }
  const PACKED = decodeBase64(asset.packedMaskBase64);
  if (PACKED.length !== PACKED_MASK_BYTES || await digest(PACKED) !== asset.atlas.packedMaskSHA256) {
    throw new Error("font packed mask hash or length is invalid");
  }
  const MASK = unpackMask(PACKED, MASK_DECODED_BYTES);
  if (await digest(MASK) !== asset.atlas.maskSHA256) {
    throw new Error("font decoded mask hash is invalid");
  }
  const DATA = new Uint8Array(RUNTIME_RGBA_BYTES);
  for (let index = 0, pixel = 0; index < MASK.length; index++, pixel += 4) {
    DATA[pixel] = 255;
    DATA[pixel + 1] = 255;
    DATA[pixel + 2] = 255;
    DATA[pixel + 3] = MASK[index];
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    data: DATA,
    glyphs: asset.glyphs,
    unitsPerEm: asset.atlas.unitsPerEm,
    ascent: asset.atlas.ascent,
    descent: asset.atlas.descent
  };
}
function loadDecoded(source, onProgress) {
  const KEY = `${source.version}:${source.sha256}`;
  let entry = ASSET_LOADS.get(KEY);
  if (!entry) {
    entry = {
      listeners: /* @__PURE__ */ new Set(),
      progress: null,
      promise: null
    };
    const EMIT = (progress) => {
      entry.progress = progress;
      for (const LISTENER of entry.listeners) {
        LISTENER(progress);
      }
    };
    entry.promise = (async () => {
      const RESPONSE = await fetch(source.url, {
        mode: "cors",
        credentials: "omit",
        cache: "force-cache"
      });
      if (!RESPONSE.ok || RESPONSE.type === "opaque") {
        throw new Error(`font request failed (${RESPONSE.status || RESPONSE.type})`);
      }
      const DECLARED_LENGTH = Number(RESPONSE.headers.get("content-length"));
      const TOTAL = Number.isSafeInteger(DECLARED_LENGTH) && DECLARED_LENGTH > 0 ? DECLARED_LENGTH : source.bytes;
      const READER = RESPONSE.body?.getReader();
      let bytes;
      if (READER) {
        const CHUNKS = [];
        let received = 0;
        while (true) {
          const { done: DONE, value: VALUE } = await READER.read();
          if (DONE) {
            break;
          }
          received += VALUE.byteLength;
          if (received > source.bytes) {
            await READER.cancel();
            throw new Error("font response exceeds its pinned byte length");
          }
          CHUNKS.push(VALUE);
          EMIT({
            phase: "download",
            loaded: received,
            total: TOTAL
          });
        }
        bytes = new Uint8Array(received);
        let offset = 0;
        for (const CHUNK of CHUNKS) {
          bytes.set(CHUNK, offset);
          offset += CHUNK.byteLength;
        }
      } else {
        bytes = new Uint8Array(await RESPONSE.arrayBuffer());
        EMIT({
          phase: "download",
          loaded: bytes.byteLength,
          total: TOTAL
        });
      }
      if (bytes.byteLength !== source.bytes) {
        throw new Error(`font byte length mismatch: expected ${source.bytes}, received ${bytes.byteLength}`);
      }
      EMIT({
        phase: "verify",
        loaded: bytes.byteLength,
        total: source.bytes
      });
      if (await digest(bytes) !== source.sha256) {
        throw new Error("font asset SHA-256 mismatch");
      }
      EMIT({
        phase: "decode",
        loaded: 0,
        total: 1
      });
      const DECODED = await decodeAsset(bytes);
      EMIT({
        phase: "decode",
        loaded: 1,
        total: 1
      });
      return DECODED;
    })();
    ASSET_LOADS.set(KEY, entry);
    entry.promise.catch(() => {
      if (ASSET_LOADS.get(KEY) === entry) {
        ASSET_LOADS.delete(KEY);
      }
    });
  }
  if (onProgress) {
    entry.listeners.add(onProgress);
    if (entry.progress) {
      onProgress(entry.progress);
    }
  }
  return {
    promise: entry.promise,
    unsubscribe: () => entry.listeners.delete(onProgress)
  };
}
function acquireAtlas(device, source, decoded) {
  let entries = DEVICE_ATLASES.get(device);
  if (!entries) {
    entries = /* @__PURE__ */ new Map();
    DEVICE_ATLASES.set(device, entries);
  }
  const KEY = `${source.version}:${source.sha256}`;
  let entry = entries.get(KEY);
  if (!entry) {
    entry = {
      references: 0,
      atlas: null
    };
    entry.atlas = new GlyphAtlas(device, {
      ...decoded,
      missingGlyph: "error"
    });
    entries.set(KEY, entry);
  }
  entry.references++;
  let released = false;
  return {
    atlas: entry.atlas,
    release() {
      if (released) {
        return false;
      }
      released = true;
      if (--entry.references === 0 && entries.get(KEY) === entry) {
        entry.atlas.dispose();
        entries.delete(KEY);
      }
      return true;
    }
  };
}
var FontAssetLoader = class {
  constructor(device, source, { signal, onProgress } = {}) {
    if (!device || typeof device.createTexture !== "function") {
      throw new TypeError("a live WebGLDevice is required");
    }
    if (onProgress !== void 0 && typeof onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    this.device = device;
    this.source = safeSource(source);
    this.state = "loading";
    this.error = null;
    this.atlas = null;
    this.progress = {
      phase: "download",
      loaded: 0,
      total: this.source.bytes
    };
    this._onProgress = onProgress;
    this._signal = signal;
    this._cancelled = false;
    this._lease = null;
    this.ready = this._start();
  }
  _emit(progress) {
    this.progress = progress;
    try {
      this._onProgress?.(progress);
    } catch {
    }
  }
  async _start() {
    let unsubscribe = null;
    let abortListener = null;
    try {
      if (this._signal?.aborted) {
        throw new DOMException("Font loading aborted", "AbortError");
      }
      const LOADED = loadDecoded(this.source, (progress) => this._emit(progress));
      unsubscribe = LOADED.unsubscribe;
      const CANCELLATION = new Promise((_, reject) => {
        this._rejectCancel = reject;
        if (this._signal) {
          abortListener = () => reject(new DOMException("Font loading aborted", "AbortError"));
          this._signal.addEventListener("abort", abortListener, {
            once: true
          });
        }
      });
      const DECODED = await Promise.race([LOADED.promise, CANCELLATION]);
      if (this._cancelled || this.state === "disposed") {
        throw new DOMException("Font loading aborted", "AbortError");
      }
      this._lease = acquireAtlas(this.device, this.source, DECODED);
      this.atlas = this._lease.atlas;
      this.state = "ready";
      this._emit({
        phase: "ready",
        loaded: this.source.bytes,
        total: this.source.bytes
      });
      return this.atlas;
    } catch (error) {
      if (this._cancelled || error?.name === "AbortError") {
        this.state = this.state === "disposed" ? "disposed" : "cancelled";
      } else {
        this.state = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
      }
      this._emit({
        phase: this.state,
        loaded: this.progress.loaded,
        total: this.progress.total,
        ...this.error ? {
          error: this.error.message
        } : {}
      });
      throw error;
    } finally {
      unsubscribe?.();
      if (abortListener) {
        this._signal.removeEventListener("abort", abortListener);
      }
      this._rejectCancel = null;
    }
  }
  cancel() {
    if (this.state !== "loading") {
      return false;
    }
    this._cancelled = true;
    this._rejectCancel?.(new DOMException("Font loading aborted", "AbortError"));
    return true;
  }
  dispose() {
    if (this.state === "disposed") {
      return false;
    }
    if (this.state === "loading") {
      this.cancel();
    }
    this._lease?.release();
    this._lease = null;
    this.atlas = null;
    this.state = "disposed";
    this._emit({
      phase: "disposed",
      loaded: this.progress.loaded,
      total: this.progress.total
    });
    return true;
  }
};

// modules/rendering/index.js
var WHITE4 = Object.freeze([1, 1, 1, 1]);
var CLEAR = Object.freeze([0, 0, 0, 0]);
var VERTEX3 = `
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
var FRAGMENT2 = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec4 t = texture2D(u_texture, v_uv);
  float alpha = t.a * v_color.a;
  gl_FragColor = vec4(t.rgb * v_color.rgb * v_color.a, alpha);
}`;
function finite3(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
}
function positive2(value, name) {
  finite3(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
}
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
    throw new TypeError("color must be [r,g,b,a]");
  }
  for (let i = 0; i < 4; i++) {
    if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) {
      throw new RangeError("color channels must be in [0,1]");
    }
  }
}
function compile2(gl, type, source) {
  const SHADER = gl.createShader(type);
  if (!SHADER) {
    throw new Error("WebGL shader allocation failed");
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
var Renderer2D = class {
  constructor(canvas, { batchVertices = 6144, antialias = true, depth = false, preserveDrawingBuffer = false } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) {
      throw new TypeError("canvas is required");
    }
    if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1048576) {
      throw new RangeError("batchVertices must be 6..1048576");
    }
    if (typeof depth !== "boolean") {
      throw new TypeError("depth must be boolean");
    }
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias,
      depth,
      stencil: false,
      preserveDrawingBuffer
    });
    if (!this.gl) {
      throw new Error("WebGL 1 is required; no Canvas2D fallback");
    }
    this.state = "ready";
    this.failure = null;
    this.active = false;
    this.vertices = new Float32Array(batchVertices * 8);
    this.vertexCount = 0;
    this.projection = new Float32Array(9);
    this.textures = /* @__PURE__ */ new Map();
    this.width = canvas.width || 1;
    this.height = canvas.height || 1;
    this.dpr = 1;
    this.camera = {
      x: this.width / 2,
      y: this.height / 2,
      zoom: 1,
      rotation: 0
    };
    this.stats = {
      backend: "webgl1",
      frame: 0,
      drawCalls: 0,
      vertices: 0,
      uploadedBytes: 0,
      bufferViews: 0,
      textureUploads: 0,
      totalTextureUploads: 0,
      textureCount: 0,
      stagingBytes: this.vertices.byteLength,
      bufferAllocations: 0
    };
    this.onLost = (event) => {
      event.preventDefault();
      this.state = "lost";
      this.active = false;
      this.vertexCount = 0;
      this.batchTexture = null;
    };
    this.onRestored = () => {
      if (this.state === "disposed") {
        return;
      }
      try {
        this._initialize();
        this.state = "ready";
        this.failure = null;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
        this._deleteGPU();
      }
    };
    try {
      this._initialize();
    } catch (error) {
      this._deleteGPU();
      this.state = "failed";
      throw error;
    }
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _ready() {
    if (this.state !== "ready") {
      throw new Error(`Renderer is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
    }
  }
  _frame() {
    this._ready();
    if (!this.active) {
      throw new Error("beginFrame is required");
    }
  }
  _initialize() {
    const GL = this.gl;
    let vertex;
    let fragment3;
    try {
      vertex = compile2(GL, GL.VERTEX_SHADER, VERTEX3);
      fragment3 = compile2(GL, GL.FRAGMENT_SHADER, FRAGMENT2);
      this.program = GL.createProgram();
      if (!this.program) {
        throw new Error("WebGL program allocation failed");
      }
      GL.attachShader(this.program, vertex);
      GL.attachShader(this.program, fragment3);
      GL.linkProgram(this.program);
      if (!GL.getProgramParameter(this.program, GL.LINK_STATUS)) {
        throw new Error(`WebGL link: ${GL.getProgramInfoLog(this.program)}`);
      }
    } finally {
      if (vertex) {
        GL.deleteShader(vertex);
      }
      if (fragment3) {
        GL.deleteShader(fragment3);
      }
    }
    this.buffer = GL.createBuffer();
    if (!this.buffer) {
      throw new Error("WebGL buffer allocation failed");
    }
    GL.bindBuffer(GL.ARRAY_BUFFER, this.buffer);
    GL.bufferData(GL.ARRAY_BUFFER, this.vertices.byteLength, GL.DYNAMIC_DRAW);
    this.stats.bufferAllocations++;
    GL.useProgram(this.program);
    this.instancingExtension = GL.getExtension("ANGLE_instanced_arrays");
    this.attributeLocations = [];
    for (const [NAME, SIZE, OFFSET] of [
      ["a_position", 2, 0],
      ["a_uv", 2, 8],
      ["a_color", 4, 16]
    ]) {
      const LOCATION = GL.getAttribLocation(this.program, NAME);
      this.attributeLocations.push([LOCATION, SIZE, OFFSET]);
      GL.enableVertexAttribArray(LOCATION);
      GL.vertexAttribPointer(LOCATION, SIZE, GL.FLOAT, false, 32, OFFSET);
    }
    this.uProjection = GL.getUniformLocation(this.program, "u_projection");
    this.uTexture = GL.getUniformLocation(this.program, "u_texture");
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
      filter: "nearest",
      texture: null
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
    const C = Math.cos(ROTATION) * ZOOM, S = Math.sin(ROTATION) * ZOOM;
    const M = this.projection, W = this.width, H = this.height;
    M[0] = 2 * C / W;
    M[1] = 2 * S / H;
    M[2] = 0;
    M[3] = 2 * S / W;
    M[4] = -2 * C / H;
    M[5] = 0;
    M[6] = -2 * (C * X + S * Y) / W;
    M[7] = 2 * (C * Y - S * X) / H;
    M[8] = 1;
    this.gl.useProgram(this.program);
    this.gl.uniformMatrix3fv(this.uProjection, false, M);
  }
  /** CSS viewport dimensions; does not change CSS style. Game controls camera separately. */
  resize(width, height, dpr = 1) {
    this._ready();
    positive2(width, "width");
    positive2(height, "height");
    positive2(dpr, "dpr");
    const PIXEL_WIDTH = Math.max(1, Math.round(width * dpr)), PIXEL_HEIGHT = Math.max(1, Math.round(height * dpr));
    const LIMIT = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    if (PIXEL_WIDTH > LIMIT[0] || PIXEL_HEIGHT > LIMIT[1]) {
      throw new RangeError("viewport exceeds WebGL limits");
    }
    if (this.active) {
      throw new Error("resize must be outside beginFrame/endFrame");
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
    finite3(x, "x");
    finite3(y, "y");
    positive2(zoom, "zoom");
    finite3(rotation, "rotation");
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
    finite3(x, "x");
    finite3(y, "y");
    const CAMERA = this.camera;
    const C = Math.cos(CAMERA.rotation), S = Math.sin(CAMERA.rotation), DX = x - CAMERA.x, DY = y - CAMERA.y;
    out.x = (C * DX + S * DY) * CAMERA.zoom + this.width / 2;
    out.y = (-S * DX + C * DY) * CAMERA.zoom + this.height / 2;
    return out;
  }
  screenToWorldInto(x, y, out) {
    finite3(x, "x");
    finite3(y, "y");
    const CAMERA = this.camera;
    const C = Math.cos(CAMERA.rotation), S = Math.sin(CAMERA.rotation), DX = (x - this.width / 2) / CAMERA.zoom, DY = (y - this.height / 2) / CAMERA.zoom;
    out.x = C * DX - S * DY + CAMERA.x;
    out.y = S * DX + C * DY + CAMERA.y;
    return out;
  }
  _source(source, filter, premultiplied = false) {
    if (filter !== "nearest" && filter !== "linear") {
      throw new RangeError("filter must be nearest or linear");
    }
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") {
      throw new TypeError("ImageBitmap alpha mode cannot be inspected; use an image/canvas or RGBA bytes");
    }
    const WIDTH = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
    const HEIGHT = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
    const MAX = this.maxTextureSize ??= this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (!Number.isSafeInteger(WIDTH) || !Number.isSafeInteger(HEIGHT) || WIDTH < 1 || HEIGHT < 1 || WIDTH > MAX || HEIGHT > MAX) {
      throw new RangeError("texture dimensions are invalid");
    }
    let retained = source;
    if (source.data !== void 0) {
      if (!(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) || source.data.length !== WIDTH * HEIGHT * 4) {
        throw new TypeError("texture data must be width*height*4 RGBA bytes");
      }
      retained = new Uint8Array(source.data);
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
      texture: null
    };
  }
  _upload(record) {
    const GL = this.gl;
    const TEXTURE = GL.createTexture();
    if (!TEXTURE) {
      throw new Error("WebGL texture allocation failed");
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
          record.source
        );
      } else {
        GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, record.source);
      }
      const FILTER = record.filter === "linear" ? GL.LINEAR : GL.NEAREST;
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
  createTexture(source, { filter = "linear", premultiplied = false } = {}) {
    this._ready();
    if (typeof premultiplied !== "boolean") {
      throw new TypeError("premultiplied must be boolean");
    }
    const RECORD = this._source(source, filter, premultiplied);
    if (this.active) {
      this.flush();
    }
    this._upload(RECORD);
    const HANDLE = Object.freeze({
      width: RECORD.width,
      height: RECORD.height
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
      throw new Error("unknown/deleted texture");
    }
    const PREMULTIPLIED = PREVIOUS.premultiplied === true;
    const WHOLE = x === 0 && y === 0 && width === handle.width && height === handle.height;
    const IN_PLACE = source?.data !== void 0 && PREVIOUS.source instanceof Uint8Array;
    if (!IN_PLACE) {
      if (!WHOLE) {
        throw new TypeError("region updates require RGBA byte data on a byte texture");
      }
      const RECORD = this._source(source, PREVIOUS.filter, PREMULTIPLIED);
      if (RECORD.width !== handle.width || RECORD.height !== handle.height) {
        throw new RangeError("texture update dimensions must match");
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
      [x, "x"],
      [y, "y"],
      [width, "width"],
      [height, "height"]
    ]) {
      if (!Number.isSafeInteger(VALUE) || VALUE < (NAME === "width" || NAME === "height" ? 1 : 0)) {
        throw new RangeError(`${NAME} must be an integer`);
      }
    }
    if (x + width > handle.width || y + height > handle.height) {
      throw new RangeError("texture region outside bounds");
    }
    const DATA = source.data;
    if (source.width !== handle.width || source.height !== handle.height || !(DATA instanceof Uint8Array || DATA instanceof Uint8ClampedArray) || DATA.length !== handle.width * handle.height * 4) {
      throw new RangeError("texture update dimensions must match");
    }
    if (this.active) {
      this.flush();
    }
    const RETAINED = PREVIOUS.source, ROW = handle.width * 4;
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
    if (this.state === "disposed") {
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
    if (this.state === "lost") {
      return false;
    }
    this._ready();
    if (this.active) {
      throw new Error("endFrame is required");
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
  triangle(x0, y0, x1, y1, x2, y2, tint = WHITE4) {
    finite3(x0, "x0");
    finite3(y0, "y0");
    finite3(x1, "x1");
    finite3(y1, "y1");
    finite3(x2, "x2");
    finite3(y2, "y2");
    color(tint);
    this._reserve(3, this.white.texture);
    this._vertex(x0, y0, 0, 0, tint);
    this._vertex(x1, y1, 0, 0, tint);
    this._vertex(x2, y2, 0, 0, tint);
  }
  _quad(texture, x, y, width, height, angle, tint, u0, v0, u1, v1) {
    finite3(x, "x");
    finite3(y, "y");
    positive2(width, "width");
    positive2(height, "height");
    finite3(angle, "angle");
    color(tint);
    this._reserve(6, texture);
    const C = Math.cos(angle), S = Math.sin(angle), HX = width / 2, HY = height / 2;
    const AX = x - C * HX + S * HY, AY = y - S * HX - C * HY;
    const BX = x + C * HX + S * HY, BY = y + S * HX - C * HY;
    const CX = x + C * HX - S * HY, CY = y + S * HX + C * HY;
    const DX = x - C * HX - S * HY, DY = y - S * HX + C * HY;
    this._vertex(AX, AY, u0, v0, tint);
    this._vertex(BX, BY, u1, v0, tint);
    this._vertex(CX, CY, u1, v1, tint);
    this._vertex(AX, AY, u0, v0, tint);
    this._vertex(CX, CY, u1, v1, tint);
    this._vertex(DX, DY, u0, v1, tint);
  }
  /** Center-anchored rectangle, positive size, clockwise rotation in y-down world. */
  rect(x, y, width, height, tint = WHITE4, angle = 0) {
    this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1);
  }
  /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
  sprite(texture, x, y, width = texture.width, height = texture.height, { angle = 0, tint = WHITE4, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {}) {
    const RECORD = this.textures.get(texture);
    if (!RECORD) {
      throw new Error("unknown/deleted texture");
    }
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1) || Math.min(u0, v0, u1, v1) < 0 || Math.max(u0, v0, u1, v1) > 1) {
      throw new RangeError("UV must be in [0,1]");
    }
    this._quad(RECORD.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
  }
  /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
  ellipse(x, y, radiusX, radiusY, tint = WHITE4, segments = 24) {
    finite3(x, "x");
    finite3(y, "y");
    positive2(radiusX, "radiusX");
    positive2(radiusY, "radiusY");
    color(tint);
    if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) {
      throw new RangeError("segments must be 3..256");
    }
    for (let i = 0; i < segments; i++) {
      const A = i / segments * Math.PI * 2, B = (i + 1) / segments * Math.PI * 2;
      this._reserve(3, this.white.texture);
      this._vertex(x, y, 0, 0, tint);
      this._vertex(x + Math.cos(A) * radiusX, y + Math.sin(A) * radiusY, 0, 0, tint);
      this._vertex(x + Math.cos(B) * radiusX, y + Math.sin(B) * radiusY, 0, 0, tint);
    }
  }
  line(x0, y0, x1, y1, width, tint = WHITE4) {
    finite3(x0, "x0");
    finite3(y0, "y0");
    finite3(x1, "x1");
    finite3(y1, "y1");
    positive2(width, "width");
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
    const GL = this.gl, VIEW = this.vertices.subarray(0, this.vertexCount * 8);
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
    if (this.state === "disposed") {
      return;
    }
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this._deleteGPU();
    this.textures.clear();
    this.white = null;
    this.buffer = this.program = null;
    this.stats.textureCount = 0;
    this.active = false;
    this.vertexCount = 0;
    this.state = "disposed";
  }
};
export {
  FontAssetLoader,
  GlyphAtlas,
  MeshBuilder,
  MeshRenderer,
  PrimitivePainter,
  Renderer2D,
  VectorContext,
  VectorRenderer,
  WebGLDevice,
  YarnSurfaceRenderer,
  buildYarnSurfaceGeometry
};

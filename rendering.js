// modules/rendering/device.js
var FUNCTIONS = Object.freeze({ never: "NEVER", less: "LESS", equal: "EQUAL", lequal: "LEQUAL", greater: "GREATER", notequal: "NOTEQUAL", gequal: "GEQUAL", always: "ALWAYS" });
var OPERATIONS = Object.freeze({ keep: "KEEP", zero: "ZERO", replace: "REPLACE", increment: "INCR", decrement: "DECR", invert: "INVERT", "increment-wrap": "INCR_WRAP", "decrement-wrap": "DECR_WRAP" });
var UNIFORMS = /* @__PURE__ */ new Set(["1f", "2f", "3f", "4f", "1i", "2i", "3i", "4i", "1iv", "1fv", "2fv", "3fv", "4fv", "matrix3fv", "matrix4fv"]);
var BLENDS = /* @__PURE__ */ new Set(["source-over", "straight-alpha", "copy", "lighter", "source-in", "destination-in"]);
var ALL_COLOR = Object.freeze([true, true, true, true]);
function integer(n, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name}: ${min}..${max}`);
}
function finiteArray(value, count, name) {
  if (!value || value.length !== count || !Array.from(value).every(Number.isFinite)) throw new TypeError(`${name} needs ${count} finite numbers`);
}
function compile(gl, type, source) {
  const shader2 = gl.createShader(type);
  if (!shader2) throw new Error("Shader allocation failed");
  gl.shaderSource(shader2, source);
  gl.compileShader(shader2);
  if (!gl.getShaderParameter(shader2, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader2);
    gl.deleteShader(shader2);
    throw new Error(`Shader compilation failed: ${message}`);
  }
  return shader2;
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
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError("canvas required");
    if (!["default", "low-power", "high-performance"].includes(powerPreference)) throw new TypeError("Invalid WebGL powerPreference");
    if (typeof failIfMajorPerformanceCaveat !== "boolean") throw new TypeError("failIfMajorPerformanceCaveat must be boolean");
    if (typeof checkGLErrors !== "boolean") throw new TypeError("checkGLErrors must be boolean");
    this.checkGLErrors = checkGLErrors;
    integer(maxTextures, "maxTextures", 1, 32);
    integer(maxBufferBytes, "maxBufferBytes", 4);
    this.canvas = canvas;
    this.maxBufferBytes = maxBufferBytes;
    this.gl = canvas.getContext("webgl", { alpha, antialias, depth, stencil, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference, failIfMajorPerformanceCaveat });
    if (!this.gl) throw new Error("WebGL 1 required");
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
      if (this.state === "disposed") return;
      try {
        this.enabledAttributes.clear();
        this.boundTextureCount = 0;
        this._instancingExtension = this.gl.getExtension("ANGLE_instanced_arrays");
        this.instancingSupported = !!this._instancingExtension;
        for (const record of this.pipelines.values()) this._pipeline(record);
        for (const record of this.buffers.values()) {
          record.gpu = this.gl.createBuffer();
          if (!record.gpu) throw new Error("Buffer allocation failed");
          this.gl.bindBuffer(record.target, record.gpu);
          this.gl.bufferData(record.target, record.capacity, this.gl.DYNAMIC_DRAW);
          record.used = 0;
          this.stats.bufferAllocations++;
        }
        for (const record of this.textures.values()) {
          record.gpu = null;
          this._texture(record);
        }
        for (const record of this.renderTargets.values()) this._renderTarget(record);
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
    if (this.state !== "ready") throw new Error(`WebGLDevice is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
  }
  get activeStencilAvailable() {
    if (!this.stencilAvailable) return false;
    if (!this.activeRenderTarget) return true;
    return this.renderTargets.get(this.activeRenderTarget)?.stencil === true;
  }
  _handle(map, handle, name) {
    const record = map.get(handle);
    if (!record) throw new Error(`Unknown/deleted ${name}`);
    return record;
  }
  _pipeline(record) {
    const gl = this.gl;
    let vertex, fragment3, program;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, record.vertex);
      fragment3 = compile(gl, gl.FRAGMENT_SHADER, record.fragment);
      program = gl.createProgram();
      if (!program) throw new Error("Program allocation failed");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment3);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
      record.locations = record.attributes.map((attribute) => ({ ...attribute, location: gl.getAttribLocation(program, attribute.name) }));
      record.uniformLocations = /* @__PURE__ */ new Map();
      for (const name of Object.keys(record.uniforms)) record.uniformLocations.set(name, gl.getUniformLocation(program, name));
      record.gpu = program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment3) gl.deleteShader(fragment3);
    }
  }
  /** Attributes use interleaved FLOAT components and byte offsets in their vertex/instance source. */
  createPipeline({ vertex, fragment: fragment3, stride, instanceStride = 0, attributes, uniforms = {} }) {
    this._ready();
    if (typeof vertex !== "string" || typeof fragment3 !== "string") throw new TypeError("Shader sources required");
    integer(stride, "stride", 4, 255);
    if (stride % 4) throw new RangeError("stride must align to FLOAT");
    integer(instanceStride, "instanceStride", 0, 255);
    if (instanceStride % 4) throw new RangeError("instanceStride must align to FLOAT");
    if (!Array.isArray(attributes) || !attributes.length) throw new TypeError("attributes required");
    const names = /* @__PURE__ */ new Set();
    for (const a of attributes) {
      if (!a || typeof a.name !== "string" || !a.name || names.has(a.name)) throw new TypeError("Unique attribute names required");
      names.add(a.name);
      integer(a.size, "attribute size", 1, 4);
      const source = a.source ?? "vertex";
      if (source !== "vertex" && source !== "instance") throw new TypeError("attribute source must be vertex or instance");
      const sourceStride = source === "instance" ? instanceStride : stride;
      if (!sourceStride) throw new RangeError("instance attributes require instanceStride");
      integer(a.offset, "attribute offset", 0, sourceStride - 4);
      if (a.offset % 4 || a.offset + a.size * 4 > sourceStride) throw new RangeError("attribute outside source stride");
    }
    if (!uniforms || typeof uniforms !== "object") throw new TypeError("uniform descriptors required");
    for (const type of Object.values(uniforms)) if (!UNIFORMS.has(type)) throw new TypeError(`Unsupported uniform ${type}`);
    const record = { vertex, fragment: fragment3, stride, instanceStride, instanced: attributes.some((a) => a.source === "instance"), attributes: attributes.map((a) => ({ ...a, source: a.source ?? "vertex" })), uniforms: { ...uniforms }, gpu: null };
    this._pipeline(record);
    const handle = Object.freeze({ stride, instanceStride });
    this.pipelines.set(handle, record);
    this.stats.pipelineCount = this.pipelines.size;
    return handle;
  }
  deletePipeline(handle) {
    const r = this.pipelines.get(handle);
    if (!r) return false;
    this.gl.useProgram(null);
    this.gl.deleteProgram(r.gpu);
    this.pipelines.delete(handle);
    this.stats.pipelineCount = this.pipelines.size;
    return true;
  }
  createVertexBuffer({ capacityBytes = 0 } = {}) {
    this._ready();
    integer(capacityBytes, "capacityBytes", 0, this.maxBufferBytes);
    if (capacityBytes % 4) throw new RangeError("capacityBytes must align to FLOAT");
    const gl = this.gl, gpu = gl.createBuffer();
    if (!gpu) throw new Error("Buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu);
    gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.DYNAMIC_DRAW);
    const handle = Object.freeze({});
    this.buffers.set(handle, { gpu, target: gl.ARRAY_BUFFER, capacity: capacityBytes, used: 0 });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return handle;
  }
  createIndexBuffer({ capacityBytes = 0 } = {}) {
    this._ready();
    integer(capacityBytes, "capacityBytes", 0, this.maxBufferBytes);
    if (capacityBytes % 2) throw new RangeError("Index buffer capacity must align to UNSIGNED_SHORT");
    const gl = this.gl, gpu = gl.createBuffer();
    if (!gpu) throw new Error("Index buffer allocation failed");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, capacityBytes, gl.DYNAMIC_DRAW);
    const handle = Object.freeze({});
    this.buffers.set(handle, { gpu, target: gl.ELEMENT_ARRAY_BUFFER, capacity: capacityBytes, used: 0 });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return handle;
  }
  /** View is uploaded synchronously, never copied into another CPU arena or retained. */
  uploadVertices(handle, data) {
    this._ready();
    const r = this._handle(this.buffers, handle, "buffer");
    if (r.target !== this.gl.ARRAY_BUFFER || !(data instanceof Float32Array)) throw new TypeError("An ARRAY_BUFFER and Float32Array are required");
    if (data.byteLength > this.maxBufferBytes) throw new RangeError("Stream exceeds maxBufferBytes");
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, r.gpu);
    if (data.byteLength > r.capacity) {
      let capacity = Math.max(4, r.capacity);
      while (capacity < data.byteLength) capacity = Math.min(this.maxBufferBytes, capacity * 2);
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      this.stats.gpuBufferBytes += capacity - r.capacity;
      r.capacity = capacity;
      this.stats.bufferAllocations++;
    }
    if (data.byteLength) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      this.stats.bufferUploads++;
      this.stats.bufferBytes += data.byteLength;
    }
    r.used = data.byteLength;
  }
  uploadIndices(handle, data) {
    this._ready();
    const r = this._handle(this.buffers, handle, "index buffer");
    if (r.target !== this.gl.ELEMENT_ARRAY_BUFFER || !(data instanceof Uint16Array)) throw new TypeError("An ELEMENT_ARRAY_BUFFER and Uint16Array are required");
    if (data.byteLength > this.maxBufferBytes) throw new RangeError("Index stream exceeds maxBufferBytes");
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.gpu);
    if (data.byteLength > r.capacity) {
      let capacity = Math.max(2, r.capacity);
      while (capacity < data.byteLength) capacity = Math.min(this.maxBufferBytes, this.maxBufferBytes % 2 ? this.maxBufferBytes - 1 : this.maxBufferBytes, capacity * 2);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      this.stats.gpuBufferBytes += capacity - r.capacity;
      r.capacity = capacity;
      this.stats.bufferAllocations++;
    }
    if (data.byteLength) {
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, data);
      this.stats.bufferUploads++;
      this.stats.bufferBytes += data.byteLength;
    }
    r.used = data.byteLength;
  }
  deleteVertexBuffer(handle) {
    return this._deleteBuffer(handle, this.gl.ARRAY_BUFFER);
  }
  deleteIndexBuffer(handle) {
    return this._deleteBuffer(handle, this.gl.ELEMENT_ARRAY_BUFFER);
  }
  _deleteBuffer(handle, target) {
    const r = this.buffers.get(handle);
    if (!r) return false;
    if (r.target !== target) throw new TypeError("Buffer target does not match delete operation");
    this.gl.deleteBuffer(r.gpu);
    this.buffers.delete(handle);
    this.stats.gpuBufferBytes -= r.capacity;
    this.stats.bufferCount = this.buffers.size;
    return true;
  }
  _source(source, format, premultiplied) {
    if (source === this.canvas) throw new TypeError("Use copyFrameToTexture for GPU frame composition, not canvas upload");
    if (typeof premultiplied !== "boolean") throw new TypeError("premultiplied must be boolean");
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") throw new TypeError("ImageBitmap alpha mode is not inspectable");
    const width = source?.naturalWidth ?? source?.width, height = source?.naturalHeight ?? source?.height;
    integer(width, "texture width", 1, this.maxTextureSize);
    integer(height, "texture height", 1, this.maxTextureSize);
    if (format !== "rgba" && format !== "luminance") throw new TypeError("texture format must be rgba or luminance");
    let retained = source;
    if (source.data !== void 0) {
      const data = source.data, components = format === "rgba" ? 4 : 1;
      if (data !== null && (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * components)) throw new TypeError("Texture byte count does not match dimensions/format");
      retained = data === null ? null : new Uint8Array(data);
      if (retained && format === "rgba" && !premultiplied) for (let i = 0; i < retained.length; i += 4) {
        const alpha = retained[i + 3] / 255;
        retained[i] = Math.round(retained[i] * alpha);
        retained[i + 1] = Math.round(retained[i + 1] * alpha);
        retained[i + 2] = Math.round(retained[i + 2] * alpha);
      }
    } else if (format !== "rgba" || premultiplied) throw new TypeError("DOM sources require rgba and premultiplied:false");
    return { source: retained, width, height, format, premultiplied };
  }
  _texture(record) {
    const gl = this.gl;
    record.gpu = gl.createTexture();
    if (!record.gpu) throw new Error("Texture allocation failed");
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, record.gpu);
      this.boundTextureCount = Math.max(1, this.boundTextureCount);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      const pixels = record.source === null || record.source instanceof Uint8Array, format = record.copyFormat === "rgb" ? gl.RGB : record.format === "rgba" ? gl.RGBA : gl.LUMINANCE;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !pixels);
      if (pixels) gl.texImage2D(gl.TEXTURE_2D, 0, format, record.width, record.height, 0, format, gl.UNSIGNED_BYTE, record.source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, record.source);
      this._filter(record.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Texture upload error ${error}`);
      this.stats.textureUploads++;
      this.stats.textureBytes += record.width * record.height * (record.format === "rgba" ? 4 : 1);
    } catch (error) {
      gl.deleteTexture(record.gpu);
      record.gpu = null;
      throw error;
    }
  }
  _filter(filter) {
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("filter must be nearest or linear");
    const gl = this.gl, value = filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, value);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, value);
  }
  _renderTarget(record) {
    const gl = this.gl, previous = gl.getParameter(gl.FRAMEBUFFER_BINDING), previousRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING), framebuffer = gl.createFramebuffer();
    let stencilBuffer = null;
    if (!framebuffer) throw new Error("Render target framebuffer allocation failed");
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, record.gpu, 0);
      if (record.stencil) {
        stencilBuffer = gl.createRenderbuffer();
        if (!stencilBuffer) throw new Error("Render target stencil allocation failed");
        gl.bindRenderbuffer(gl.RENDERBUFFER, stencilBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, record.width, record.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencilBuffer);
      }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Render target framebuffer incomplete: ${status}`);
      record.framebuffer = framebuffer;
      record.stencilBuffer = stencilBuffer;
    } catch (error) {
      gl.deleteFramebuffer(framebuffer);
      if (stencilBuffer) gl.deleteRenderbuffer(stencilBuffer);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
      gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderbuffer);
    }
  }
  /** Creates a reusable, premultiplied RGBA texture/FBO pair; the handle is also a draw texture. */
  createRenderTarget(width, height, { filter = "linear", stencil = false } = {}) {
    this._ready();
    integer(width, "render target width", 1, this.maxTextureSize);
    integer(height, "render target height", 1, this.maxTextureSize);
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("filter must be nearest or linear");
    if (typeof stencil !== "boolean") throw new TypeError("stencil must be boolean");
    if (stencil && !this.stencilAvailable) throw new Error("Context has no stencil buffer");
    const record = { width, height, format: "rgba", premultiplied: true, source: null, filter, stencil, gpu: null, framebuffer: null, stencilBuffer: null };
    this._texture(record);
    try {
      this._renderTarget(record);
    } catch (error) {
      this.gl.deleteTexture(record.gpu);
      record.gpu = null;
      throw error;
    }
    const handle = Object.freeze({ width, height, stencil });
    this.textures.set(handle, record);
    this.renderTargets.set(handle, record);
    this.stats.textureCount = this.textures.size;
    this.stats.renderTargetCount = this.renderTargets.size;
    this.stats.gpuRenderTargetBytes += width * height * (4 + (stencil ? 1 : 0));
    return handle;
  }
  /** Binds a target inside an active frame. Bindings may nest and must unwind in LIFO order. */
  bindRenderTarget(handle) {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    const record = this._handle(this.renderTargets, handle, "render target");
    if (this.activeRenderTarget === handle || this.renderTargetStack.some((entry) => entry.handle === handle)) throw new Error("Render target is already bound");
    const gl = this.gl;
    this.renderTargetStack.push({ handle: this.activeRenderTarget, framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING), viewport: gl.getParameter(gl.VIEWPORT) });
    gl.bindFramebuffer(gl.FRAMEBUFFER, record.framebuffer);
    gl.viewport(0, 0, record.width, record.height);
    this.activeRenderTarget = handle;
    return handle;
  }
  /** Completes the target pass and restores the previous framebuffer and viewport. */
  unbindRenderTarget(handle) {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    if (!this.renderTargetStack.length) throw new Error("No render target is bound");
    if (handle !== void 0 && handle !== this.activeRenderTarget) throw new Error("Render targets must be unbound in LIFO order");
    const previous = this.renderTargetStack.pop(), gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous.framebuffer);
    gl.viewport(...previous.viewport);
    this.activeRenderTarget = previous.handle;
    return this.activeRenderTarget;
  }
  deleteRenderTarget(handle) {
    const record = this.renderTargets.get(handle);
    if (!record) return false;
    if (this.renderTargetStack.some((entry) => entry.handle === handle) || this.activeRenderTarget === handle) throw new Error("Cannot delete a bound render target");
    this.gl.deleteFramebuffer(record.framebuffer);
    if (record.stencilBuffer) this.gl.deleteRenderbuffer(record.stencilBuffer);
    this.gl.deleteTexture(record.gpu);
    this.renderTargets.delete(handle);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    this.stats.renderTargetCount = this.renderTargets.size;
    this.stats.gpuRenderTargetBytes -= record.width * record.height * (4 + (record.stencil ? 1 : 0));
    return true;
  }
  createTexture(source, { format = "rgba", premultiplied = false, filter = "linear" } = {}) {
    this._ready();
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("Invalid filter");
    const record = { ...this._source(source, format, premultiplied), filter, gpu: null };
    this._texture(record);
    const handle = Object.freeze({ width: record.width, height: record.height });
    this.textures.set(handle, record);
    this.stats.textureCount = this.textures.size;
    return handle;
  }
  /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
  updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
    this._ready();
    const r = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) throw new Error("Render targets cannot be updated from CPU pixels");
    integer(x, "x");
    integer(y, "y");
    integer(width, "width", 1);
    integer(height, "height", 1);
    if (x + width > r.width || y + height > r.height) throw new RangeError("Texture region outside bounds");
    const next = this._source(source, r.format, r.premultiplied);
    if (next.width !== r.width || next.height !== r.height || next.source === null) throw new RangeError("Update requires matching full source");
    if (r.copyFormat) {
      const replacement = { ...next, filter: r.filter, gpu: null };
      this._texture(replacement);
      this.gl.deleteTexture(r.gpu);
      Object.assign(r, replacement);
      delete r.copyFormat;
      return;
    }
    const gl = this.gl, format = r.format === "rgba" ? gl.RGBA : gl.LUMINANCE;
    let pixels = next.source;
    if (pixels instanceof Uint8Array) {
      const components = r.format === "rgba" ? 4 : 1;
      if (x || y || width !== r.width || height !== r.height) {
        const needed = width * height * components;
        if (!this.regionBytes || this.regionBytes.length !== needed) this.regionBytes = new Uint8Array(needed);
        for (let row = 0; row < height; row++) {
          const start = ((y + row) * r.width + x) * components;
          this.regionBytes.set(pixels.subarray(start, start + width * components), row * width * components);
        }
        pixels = this.regionBytes;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    } else {
      if (x || y || width !== r.width || height !== r.height) {
        if (!this.regionCanvas) {
          const doc = this.canvas.ownerDocument;
          if (!doc?.createElement) throw new Error("DOM region uploads require canvas.ownerDocument");
          this.regionCanvas = doc.createElement("canvas");
          this.regionContext = this.regionCanvas.getContext("2d");
          if (!this.regionContext) throw new Error("Asset-region Canvas2D unavailable");
        }
        const c = this.regionCanvas, q = this.regionContext;
        if (c.width !== width || c.height !== height) {
          c.width = width;
          c.height = height;
        } else q.clearRect(0, 0, width, height);
        q.drawImage(next.source, x, y, width, height, 0, 0, width, height);
        pixels = c;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.gpu);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (pixels instanceof Uint8Array) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, gl.UNSIGNED_BYTE, pixels);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, format, gl.UNSIGNED_BYTE, pixels);
    if (this.checkGLErrors) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Texture update error ${error}`);
    }
    r.source = next.source;
    this.stats.textureUploads++;
    this.stats.textureBytes += width * height * (r.format === "rgba" ? 4 : 1);
  }
  /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
  copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
    this._ready();
    const r = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) throw new Error("Render targets cannot be copied from the default framebuffer");
    integer(x, "x");
    integer(y, "y");
    if (r.format !== "rgba" || x + r.width > this.canvas.width || y + r.height > this.canvas.height) throw new RangeError("Framebuffer copy outside bounds");
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.gpu);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    let allocated = false;
    if (!gl.getContextAttributes().alpha && r.copyFormat !== "rgb") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, r.width, r.height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      r.copyFormat = "rgb";
      allocated = true;
      this.stats.textureUploads++;
      this.stats.textureBytes += r.width * r.height * 3;
    }
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x, y, r.width, r.height);
    if (allocated || this.checkGLErrors) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Framebuffer copy error ${error}`);
    }
    r.source = null;
    this.stats.frameCopies++;
  }
  deleteTexture(handle) {
    const r = this.textures.get(handle);
    if (!r) return false;
    if (this.renderTargets.has(handle)) throw new Error("Use deleteRenderTarget for render targets");
    this.gl.deleteTexture(r.gpu);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    return true;
  }
  beginFrame({ width = this.canvas.width, height = this.canvas.height, clearColor = [0, 0, 0, 0], clearDepth = 1, clearStencil = 0 } = {}) {
    if (this.state === "lost") return false;
    this._ready();
    if (this.active) throw new Error("endFrame required");
    integer(width, "width", 1);
    integer(height, "height", 1);
    const gl = this.gl, limit = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    if (width > limit[0] || height > limit[1]) throw new RangeError("Viewport exceeds WebGL limit");
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    this.renderTargetStack.length = 0;
    this.activeRenderTarget = null;
    this.stats.frame++;
    for (const name of ["drawCalls", "instancedDrawCalls", "vertices", "bufferUploads", "bufferBytes", "textureUploads", "textureBytes", "frameCopies"]) this.stats[name] = 0;
    this.active = true;
    this.clear({ color: clearColor, depth: clearDepth, stencil: clearStencil });
    return true;
  }
  clear({ color: color2, depth, stencil } = {}) {
    this._ready();
    const gl = this.gl;
    let flags = 0;
    if (color2 !== void 0) {
      finiteArray(color2, 4, "clear color");
      gl.colorMask(true, true, true, true);
      gl.clearColor(...color2);
      flags |= gl.COLOR_BUFFER_BIT;
    }
    if (depth !== void 0) {
      if (!Number.isFinite(depth) || depth < 0 || depth > 1) throw new RangeError("clear depth 0..1");
      gl.depthMask(true);
      gl.clearDepth(depth);
      flags |= gl.DEPTH_BUFFER_BIT;
    }
    if (stencil !== void 0) {
      integer(stencil, "clear stencil", 0, 255);
      gl.stencilMask(255);
      gl.clearStencil(stencil);
      flags |= gl.STENCIL_BUFFER_BIT;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(flags);
  }
  /** Full pass state is explicit per draw; no state leakage between game materials. */
  draw({ pipeline, buffer, indexBuffer, instanceBuffer, instances = 1, first = 0, count, uniforms = {}, textures = [], blend = "source-over", depth = false, stencil = false, colorMask = ALL_COLOR, filter } = {}) {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    const p = this._handle(this.pipelines, pipeline, "pipeline"), b = this._handle(this.buffers, buffer, "buffer");
    if (b.target !== this.gl.ARRAY_BUFFER) throw new TypeError("A vertex buffer is required");
    integer(first, "first");
    integer(count, "count");
    const elements = indexBuffer === void 0 || indexBuffer === null ? null : this._handle(this.buffers, indexBuffer, "index buffer");
    if (elements) {
      if (elements.target !== this.gl.ELEMENT_ARRAY_BUFFER || elements.used % 2 || first + count > elements.used / 2) throw new RangeError("draw exceeds uploaded indices");
    } else if (first + count > b.used / p.stride) throw new RangeError("draw exceeds uploaded vertices");
    integer(instances, "instances", 1);
    let instanceRecord;
    if (p.instanced) {
      if (!this._instancingExtension) throw new Error("ANGLE_instanced_arrays required for instance attributes");
      instanceRecord = this._handle(this.buffers, instanceBuffer, "instance buffer");
      if (instanceRecord.target !== this.gl.ARRAY_BUFFER) throw new TypeError("An instance vertex buffer is required");
      if (instances > instanceRecord.used / p.instanceStride) throw new RangeError("draw exceeds uploaded instances");
    } else if (instances !== 1) throw new RangeError("Multiple instances require instance attributes");
    if (!Number.isSafeInteger(count * instances)) throw new RangeError("draw vertex count exceeds safe integer range");
    const depthState = depth === false || depth == null ? null : depth === true ? { test: true, write: true, func: "lequal" } : typeof depth === "object" && !Array.isArray(depth) ? { test: depth.test ?? true, write: depth.write ?? true, func: depth.func ?? "lequal" } : (() => {
      throw new TypeError("depth must be false or a depth policy object");
    })();
    if (depthState && (typeof depthState.test !== "boolean" || typeof depthState.write !== "boolean")) throw new TypeError("depth.test and depth.write must be booleans");
    if ((depthState?.test || depthState?.write) && !this.depthAvailable) throw new Error("Context has no depth buffer");
    if (stencil && !this.activeStencilAvailable) throw new Error("The active framebuffer has no stencil attachment");
    if (blend !== false && !BLENDS.has(blend)) throw new TypeError("Unsupported blend");
    if (depthState && !FUNCTIONS[depthState.func]) throw new TypeError("Unsupported depth function");
    if (stencil) {
      if (!FUNCTIONS[stencil.func ?? "always"]) throw new TypeError("Unsupported stencil function");
      for (const key of ["fail", "zfail", "pass"]) if (!OPERATIONS[stencil[key] ?? "keep"]) throw new TypeError("Unsupported stencil operation");
      for (const key of ["ref", "mask", "writeMask"]) integer(stencil[key] ?? (key === "ref" ? 0 : 255), key, 0, 255);
    }
    if (!colorMask || colorMask.length !== 4 || !Array.from(colorMask).every((v) => typeof v === "boolean")) throw new TypeError("colorMask must contain booleans");
    if (!Array.isArray(textures) || textures.length > this.maxTextures) throw new RangeError("Too many textures");
    for (const handle of textures) {
      this._handle(this.textures, handle, "texture");
      if (handle === this.activeRenderTarget) throw new Error("Cannot sample the active render target");
    }
    if (filter !== void 0 && filter !== "nearest" && filter !== "linear") throw new TypeError("Unsupported filter");
    const gl = this.gl, instancing = this._instancingExtension;
    gl.useProgram(p.gpu);
    for (const index of this.enabledAttributes) {
      if (instancing) instancing.vertexAttribDivisorANGLE(index, 0);
      gl.disableVertexAttribArray(index);
    }
    this.enabledAttributes.clear();
    let boundBuffer = null;
    for (const a of p.locations) if (a.location >= 0) {
      const isInstance = a.source === "instance", sourceBuffer = isInstance ? instanceRecord : b;
      if (boundBuffer !== sourceBuffer.gpu) {
        gl.bindBuffer(gl.ARRAY_BUFFER, sourceBuffer.gpu);
        boundBuffer = sourceBuffer.gpu;
      }
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribPointer(a.location, a.size, gl.FLOAT, false, isInstance ? p.instanceStride : p.stride, a.offset);
      if (instancing) instancing.vertexAttribDivisorANGLE(a.location, isInstance ? 1 : 0);
      this.enabledAttributes.add(a.location);
    }
    for (const [name, value] of Object.entries(uniforms)) {
      const type = p.uniforms[name];
      if (!type) throw new TypeError(`Undeclared uniform ${name}`);
      const location = p.uniformLocations.get(name);
      if (location === null) continue;
      if (type.startsWith("matrix")) gl[`uniformMatrix${type[6]}fv`](location, false, value);
      else if (type.endsWith("v")) gl[`uniform${type}`](location, value);
      else if (type[0] === "1") gl[`uniform${type}`](location, value);
      else gl[`uniform${type}`](location, ...value);
    }
    const textureUnits = Math.max(this.boundTextureCount, textures.length);
    for (let i = 0; i < textureUnits; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const r = i < textures.length ? this.textures.get(textures[i]) : null;
      gl.bindTexture(gl.TEXTURE_2D, r?.gpu ?? null);
      if (r) this._filter(filter ?? r.filter);
    }
    if (textureUnits) gl.activeTexture(gl.TEXTURE0);
    this.boundTextureCount = textures.length;
    if (blend === false) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      const factors = blend === "source-over" ? [gl.ONE, gl.ONE_MINUS_SRC_ALPHA] : blend === "straight-alpha" ? [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA] : blend === "copy" ? [gl.ONE, gl.ZERO] : blend === "lighter" ? [gl.ONE, gl.ONE] : blend === "source-in" ? [gl.DST_ALPHA, gl.ZERO] : [gl.ZERO, gl.SRC_ALPHA];
      gl.blendFunc(...factors);
    }
    if (depthState?.test) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl[FUNCTIONS[depthState.func]]);
    } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(depthState?.write ?? false);
    if (stencil) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl[FUNCTIONS[stencil.func ?? "always"]], stencil.ref ?? 0, stencil.mask ?? 255);
      gl.stencilMask(stencil.writeMask ?? 255);
      gl.stencilOp(gl[OPERATIONS[stencil.fail ?? "keep"]], gl[OPERATIONS[stencil.zfail ?? "keep"]], gl[OPERATIONS[stencil.pass ?? "keep"]]);
    } else gl.disable(gl.STENCIL_TEST);
    gl.colorMask(...colorMask);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.disable(gl.SCISSOR_TEST);
    if (elements) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements.gpu);
    if (p.instanced) {
      if (elements) instancing.drawElementsInstancedANGLE(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2, instances);
      else instancing.drawArraysInstancedANGLE(gl.TRIANGLES, first, count, instances);
      this.stats.instancedDrawCalls++;
    } else if (elements) gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
    else gl.drawArrays(gl.TRIANGLES, first, count);
    this.stats.drawCalls++;
    this.stats.vertices += count * instances;
  }
  endFrame() {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    if (this.renderTargetStack.length) throw new Error("Unbind render targets before endFrame");
    this.active = false;
    return this.stats;
  }
  _deleteGPU() {
    const gl = this.gl;
    gl.useProgram(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    for (let i = 0; i < this.maxTextures; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    for (const r of this.pipelines.values()) gl.deleteProgram(r.gpu);
    for (const r of this.buffers.values()) gl.deleteBuffer(r.gpu);
    for (const r of this.renderTargets.values()) {
      gl.deleteFramebuffer(r.framebuffer);
      if (r.stencilBuffer) gl.deleteRenderbuffer(r.stencilBuffer);
    }
    for (const r of this.textures.values()) gl.deleteTexture(r.gpu);
  }
  dispose() {
    if (this.state === "disposed") return;
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
var WHITE = Object.freeze([1, 1, 1, 1]);
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
var finite = (n, label) => {
  if (!Number.isFinite(n)) throw new TypeError(`${label} must be finite`);
};
function rgba(value) {
  if (!value || value.length !== 4 || Array.from(value).some((n) => !Number.isFinite(n) || n < 0 || n > 1)) throw new TypeError("RGBA channels must be in [0,1]");
  return value;
}
function point(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}
function compose(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function tessellate(contours, rule) {
  const edges = [], ys = [];
  for (const contour of contours) {
    if (contour.length < 3) continue;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length];
      if (Math.abs(a.y - b.y) < 1e-9) continue;
      const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      edges.push({ a, b, sign: b.y > a.y ? 1 : -1, minY, maxY });
      ys.push(a.y, b.y);
    }
  }
  ys.sort((a, b) => a - b);
  const levels = [];
  for (const y of ys) if (!levels.length || y - levels.at(-1) > 1e-8) levels.push(y);
  const starts = edges.slice().sort((a, b) => a.minY - b.minY), active = [], triangles = [];
  let nextStart = 0;
  for (let band = 0; band + 1 < levels.length; band++) {
    const y0 = levels[band], y1 = levels[band + 1], ym = (y0 + y1) / 2;
    if (y1 - y0 < 1e-8) continue;
    while (nextStart < starts.length && starts[nextStart].minY < ym) active.push(starts[nextStart++]);
    for (let i = active.length - 1; i >= 0; i--) if (active[i].maxY <= ym) {
      active[i] = active[active.length - 1];
      active.pop();
    }
    active.sort((a, b) => xAt(a, ym) - xAt(b, ym));
    let winding = 0, inside = false, left = null;
    for (const edge of active) {
      const before = rule === "evenodd" ? inside : winding !== 0;
      if (rule === "evenodd") inside = !inside;
      else winding += edge.sign;
      const after = rule === "evenodd" ? inside : winding !== 0;
      if (!before && after) left = edge;
      else if (before && !after && left) {
        const a = { x: xAt(left, y0), y: y0 }, b = { x: xAt(edge, y0), y: y0 }, c = { x: xAt(edge, y1), y: y1 }, d = { x: xAt(left, y1), y: y1 };
        triangles.push(a, b, c, a, c, d);
        left = null;
      }
    }
  }
  return triangles;
}
function xAt(edge, y) {
  const { a, b } = edge;
  return a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
}
function clipContour(points, rule) {
  if (rule !== "nonzero" && rule !== "evenodd") throw new TypeError("clip rule must be nonzero or evenodd");
  if (!(points instanceof Float32Array) && !(points instanceof Float64Array) && !Array.isArray(points)) throw new TypeError("Clip contour must be a flat numeric array of x/y pairs");
  if (points.length % 2) throw new RangeError("Clip contour needs x/y pairs");
  const flat = Float32Array.from(points);
  if (flat.some((value) => !Number.isFinite(value))) throw new TypeError("Clip contour coordinates must be finite");
  const count = flat.length / 2;
  if (count > 256) throw new RangeError("Retained clip contours support at most 256 authored points");
  let end = count;
  if (count > 3 && flat[0] === flat[(count - 1) * 2] && flat[1] === flat[(count - 1) * 2 + 1]) end--;
  if (end < 3) throw new RangeError("Clip contour requires at least three distinct points");
  const contour = Array.from({ length: end }, (_, i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] }));
  for (let i = 0; i < end; i++) {
    const a = contour[i], b = contour[(i + 1) % end];
    if (a.x === b.x && a.y === b.y) throw new RangeError("Clip contour cannot contain consecutive duplicate points");
  }
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), on = (a, b, p) => Math.abs(orient(a, b, p)) < 1e-9 && p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
  for (let i = 0; i < end; i++) for (let j = i + 1; j < end; j++) {
    if (j === i + 1 || i === 0 && j === end - 1) continue;
    const a = contour[i], b = contour[(i + 1) % end], c = contour[j], d = contour[(j + 1) % end], o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 * o2 < 0 && o3 * o4 < 0 || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) throw new RangeError("Retained clip contours must be simple and non-self-intersecting");
  }
  let area = 0;
  for (let i = 0; i < end; i++) {
    const a = contour[i], b = contour[(i + 1) % end];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area) < 1e-9) throw new RangeError("Clip contour area must be nonzero");
  const triangles = tessellate([contour], rule);
  if (!triangles.length) throw new RangeError("Clip contour could not be tessellated");
  if (triangles.length / 3 > 16384) throw new RangeError("Retained clip tessellation exceeds 16384 triangles");
  return { flat, triangles: Float32Array.from(triangles.flatMap((p) => [p.x, p.y])) };
}
function convexContour(contour) {
  let sign = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length], c = contour[(i + 2) % contour.length], cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-8) continue;
    const next = Math.sign(cross);
    if (sign && next !== sign) return false;
    sign = next;
  }
  return sign !== 0;
}
var VectorRenderer = class {
  constructor(device, { initialVertices = 4096, maxVertices = 262144, glyphAtlas = null } = {}) {
    if (!device?.createPipeline || !device?.draw) throw new TypeError("A WebGLDevice is required");
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(initialVertices) || initialVertices < 3 || initialVertices > maxVertices) throw new RangeError("3 <= initialVertices <= maxVertices is required");
    if (initialVertices * 32 > device.maxBufferBytes) throw new RangeError("initial vector buffer exceeds the device byte limit");
    this.device = device;
    this.gl = device.gl;
    this.canvas = device.canvas;
    this.glyphAtlas = glyphAtlas;
    this.maxVertices = Math.min(maxVertices, Math.floor(device.maxBufferBytes / 32));
    this.maxClipPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
    this.pipeline = device.createPipeline({ vertex: VERTEX, fragment: FRAGMENT, stride: 32, attributes: [{ name: "a_position", size: 2, offset: 0 }, { name: "a_uv", size: 2, offset: 8 }, { name: "a_color", size: 4, offset: 16 }], uniforms: { u_projection: "matrix3fv", u_texture: "1i", u_textured: "1f", u_radial: "1f", u_radial_params: "4f", u_whiteFlash: "1f" } });
    this.clipPipeline = device.createPipeline({ vertex: CLIP_VERTEX, fragment: CLIP_FRAGMENT, stride: 8, attributes: [{ name: "a_position", size: 2, offset: 0 }], uniforms: { u_projection: "matrix3fv", u_transform: "matrix3fv" } });
    this.buffer = device.createVertexBuffer({ capacityBytes: initialVertices * 32 });
    this.dynamicClipBuffer = device.createVertexBuffer({ capacityBytes: 0 });
    this.white = device.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, { format: "rgba", premultiplied: true, filter: "nearest" });
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
      if (this.state === "disposed") return;
      try {
        for (const record of this.clipPaths.values()) this.device.uploadVertices(record.buffer, record.triangles);
      } catch {
        this.state = "failed";
      }
    };
    this.canvas.addEventListener("webglcontextlost", this.onLost);
    this.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.projection = new Float32Array([2 / this.canvas.width, 0, 0, 0, -2 / this.canvas.height, 0, -1, 1, 1]);
  }
  _frame() {
    if (this.state !== "ready") throw new Error(`VectorRenderer is ${this.state}`);
    if (!this.device.active) throw new Error("WebGLDevice.beginFrame is required");
    const g = [...this.groups].reverse().find((group) => !group.direct);
    if (g) this._setProjection(g.bounds, g.target);
    else this._setProjection(null);
    if (this.stencilNeedsRebuild) {
      this._rebuildStencil();
      this.stencilNeedsRebuild = false;
    }
  }
  _setProjection(bounds, target = null) {
    const w = target?.width ?? this.canvas.width, h = target?.height ?? this.canvas.height, x = bounds?.x ?? 0, y = bounds?.y ?? 0;
    this.projection[0] = 2 / w;
    this.projection[1] = 0;
    this.projection[2] = 0;
    this.projection[3] = 0;
    this.projection[4] = -2 / h;
    this.projection[5] = 0;
    this.projection[6] = -1 - 2 * x / w;
    this.projection[7] = 1 + 2 * y / h;
    this.projection[8] = 1;
  }
  beginPath() {
    this._frame();
    this.path = [];
    this.cursor = this.subpath = null;
  }
  moveTo(x, y) {
    this._frame();
    finite(x, "x");
    finite(y, "y");
    const p = point(this.matrix, x, y);
    this.path.push([p]);
    this.cursor = this.subpath = p;
  }
  lineTo(x, y) {
    this._frame();
    finite(x, "x");
    finite(y, "y");
    if (!this.cursor) return this.moveTo(x, y);
    const p = point(this.matrix, x, y);
    this.path.at(-1).push(p);
    this.cursor = p;
  }
  quadraticCurveTo(cx, cy, x, y, segments = 12) {
    this._curve([cx, cy, x, y], segments, false);
  }
  bezierCurveTo(a, b, c, d, x, y, segments = 16) {
    this._curve([a, b, c, d, x, y], segments, true);
  }
  _curve(v, n, cubic) {
    this._frame();
    if (!Number.isSafeInteger(n) || n < 2 || n > 256) throw new RangeError("curve segments must be 2..256");
    if (!this.cursor) return this.moveTo(v[0], v[1]);
    const start = this.cursor, p = cubic ? [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3]), point(this.matrix, v[4], v[5])] : [point(this.matrix, v[0], v[1]), point(this.matrix, v[2], v[3])];
    for (let i = 1; i <= n; i++) {
      const t = i / n, q = 1 - t;
      let x, y;
      if (cubic) {
        x = q * q * q * start.x + 3 * q * q * t * p[0].x + 3 * q * t * t * p[1].x + t * t * t * p[2].x;
        y = q * q * q * start.y + 3 * q * q * t * p[0].y + 3 * q * t * t * p[1].y + t * t * t * p[2].y;
      } else {
        x = q * q * start.x + 2 * q * t * p[0].x + t * t * p[1].x;
        y = q * q * start.y + 2 * q * t * p[0].y + t * t * p[1].y;
      }
      this.path.at(-1).push({ x, y });
    }
    this.cursor = this.path.at(-1).at(-1);
  }
  closePath() {
    if (this.cursor && this.subpath) {
      const p = this.path.at(-1);
      if (p.at(-1) !== this.subpath) p.push(this.subpath);
      this.cursor = this.subpath;
    }
  }
  save() {
    this._frame();
    this.stack.push({ matrix: this.matrix.slice(), clips: this.clips.map((polygon) => polygon.map((p) => ({ ...p }))), stencilClips: this.stencilClips.slice() });
  }
  restore() {
    this._frame();
    const s = this.stack.pop();
    if (!s) throw new Error("restore without save");
    this._submit();
    this.matrix = s.matrix;
    this.clips = s.clips;
    if (s.stencilClips.length !== this.stencilClips.length || s.stencilClips.some((clip, i) => clip !== this.stencilClips[i])) {
      this.stencilClips = s.stencilClips;
      this._rebuildStencil();
    }
  }
  setTransform(a, b, c, d, e, f) {
    this._frame();
    [a, b, c, d, e, f].forEach((n, i) => finite(n, `transform[${i}]`));
    this.matrix = [a, b, c, d, e, f];
  }
  transform(a, b, c, d, e, f) {
    const m = this.matrix;
    this.setTransform(m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]);
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
    if (width < 0 || height < 0) throw new RangeError("clip size must be non-negative");
    const contour = [point(this.matrix, x, y), point(this.matrix, x + width, y), point(this.matrix, x + width, y + height), point(this.matrix, x, y + height)];
    if (width === 0 || height === 0) this.clips.push(contour);
    else this._addConvexClip(contour);
  }
  /** Add the current transformed path contours to the clip stack. */
  _addConvexClip(contour) {
    if (contour.length > 1024) throw new RangeError("Dynamic convex clips support at most 1024 authored points");
    if (!convexContour(contour)) throw new RangeError("clip() accepts convex contours; create a retained ClipPath for concave contours");
    const area = contour.reduce((sum, p, i) => sum + p.x * contour[(i + 1) % contour.length].y - contour[(i + 1) % contour.length].x * p.y, 0);
    if (Math.abs(area) < 1e-9) {
      this.clips.push(contour);
      return;
    }
    const planeCount = this.clips.reduce((sum, polygon) => sum + polygon.length, 0);
    if (planeCount + contour.length > this.maxClipPlanes) {
      this._pushDynamicStencilClip(contour);
      return;
    }
    this.clips.push(contour);
  }
  _pushDynamicStencilClip(contour) {
    if (!this.device.activeStencilAvailable) throw new Error("Clip contours exceeding the mesh edge-plane limit require stencil; no fallback is available");
    if (this.stencilClips.length >= 255) throw new RangeError("At most 255 nested stencil clips are supported");
    const triangles = new Float32Array((contour.length - 2) * 6);
    let at = 0;
    for (let i = 1; i + 1 < contour.length; i++) for (const p of [contour[0], contour[i], contour[i + 1]]) {
      triangles[at++] = p.x;
      triangles[at++] = p.y;
    }
    this._submit();
    if (!this.stencilDepth) this.device.clear({ stencil: 0 });
    const entry = { dynamic: true, triangles };
    this._drawStencilClip(entry, this.stencilDepth);
    this.stencilClips = [...this.stencilClips, entry];
    this.stencilDepth++;
  }
  clip(rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") throw new TypeError("rule must be nonzero or evenodd");
    const contours = this.path.filter((path) => path.length >= 3).map((path) => path.map((p) => ({ ...p })));
    if (!contours.length) return;
    if (contours.length !== 1) throw new RangeError("clip() accepts one contour; use a retained ClipPath for multi-contour geometry");
    const contour = contours[0];
    if (contour.length > 3 && contour[0].x === contour.at(-1).x && contour[0].y === contour.at(-1).y) contour.pop();
    this._addConvexClip(contour);
  }
  createClipPath(points, { rule = "nonzero" } = {}) {
    if (this.state !== "ready" || this.device.state !== "ready") throw new Error("VectorRenderer is not ready");
    if (this.device.active) throw new Error("Create retained ClipPaths outside an active frame");
    if (this.clipPaths.size >= 64) throw new RangeError("At most 64 retained ClipPaths may be live");
    const geometry = clipContour(points, rule);
    if (this.clipPathBytes + geometry.triangles.byteLength > 16 * 1024 * 1024) throw new RangeError("Retained ClipPaths exceed the 16 MiB budget");
    const buffer = this.device.createVertexBuffer({ capacityBytes: geometry.triangles.byteLength });
    try {
      this.device.uploadVertices(buffer, geometry.triangles);
    } catch (error) {
      this.device.deleteVertexBuffer(buffer);
      throw error;
    }
    const handle = Object.freeze({ renderer: this, buffer });
    this.clipPaths.set(handle, { buffer, triangles: geometry.triangles, count: geometry.triangles.length / 2, byteLength: geometry.triangles.byteLength, contour: geometry.flat, rule });
    this.clipPathBytes += geometry.triangles.byteLength;
    return handle;
  }
  deleteClipPath(handle) {
    const record = this.clipPaths.get(handle);
    if (!record) return false;
    const referenced = this.stencilClips.some((entry) => entry.handle === handle) || this.stack.some((state) => state.stencilClips.some((entry) => entry.handle === handle)) || this.groups.some((group) => group.stencilClips?.some((entry) => entry.handle === handle));
    if (referenced) throw new Error("Remove a ClipPath from every saved clip stack before deleting it");
    this.device.deleteVertexBuffer(record.buffer);
    this.clipPaths.delete(handle);
    this.clipPathBytes -= record.byteLength;
    return true;
  }
  clipPath(handle, { transform = null } = {}) {
    this._frame();
    const record = this.clipPaths.get(handle);
    if (!record) throw new TypeError("ClipPath owned by this VectorRenderer is required");
    if (!this.device.activeStencilAvailable) throw new Error("Concave ClipPath requires an active stencil attachment; no fallback is available");
    if (this.stencilClips.length >= 255) throw new RangeError("At most 255 nested stencil ClipPaths are supported");
    const local = transform ?? IDENTITY;
    if (local.length !== 6 || Array.from(local).some((value) => !Number.isFinite(value))) throw new TypeError("ClipPath transform needs six finite values");
    const matrix = compose(this.matrix, local);
    if (Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-12) throw new RangeError("ClipPath transform must be invertible");
    this._submit();
    if (!this.stencilDepth) this.device.clear({ stencil: 0 });
    const entry = { handle, matrix: Float32Array.from(matrix) };
    this._drawStencilClip(entry, this.stencilDepth);
    this.stencilClips = [...this.stencilClips, entry];
    this.stencilDepth++;
  }
  _drawStencilClip(entry, ref) {
    let buffer, count, transform;
    if (entry.dynamic) {
      buffer = this.dynamicClipBuffer;
      this.device.uploadVertices(buffer, entry.triangles);
      count = entry.triangles.length / 2;
      transform = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    } else {
      const record = this.clipPaths.get(entry.handle);
      if (!record) throw new Error("A ClipPath in the active stack was deleted");
      buffer = record.buffer;
      count = record.count;
      const m = entry.matrix;
      transform = Float32Array.from([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
    }
    this.device.draw({ pipeline: this.clipPipeline, buffer, count, uniforms: { u_projection: this.projection, u_transform: transform }, blend: false, colorMask: [false, false, false, false], stencil: { func: "equal", ref, mask: 255, writeMask: 255, pass: "increment" } });
  }
  _rebuildStencil() {
    if (!this.stencilClips.length) {
      this.stencilDepth = 0;
      this.stencilNeedsRebuild = false;
      return;
    }
    if (!this.device.activeStencilAvailable) throw new Error("Saved concave ClipPath requires a stencil attachment");
    this.device.clear({ stencil: 0 });
    this.stencilDepth = 0;
    for (const entry of this.stencilClips) {
      this._drawStencilClip(entry, this.stencilDepth);
      this.stencilDepth++;
    }
    this.stencilNeedsRebuild = false;
  }
  _clipTriangle(a, b, c, uv) {
    let poly = [a, b, c].map((p, i) => uv ? { ...p, u: uv[i][0], v: uv[i][1] } : p);
    for (const clip of this.clips) {
      let orientation = 0;
      for (let i = 0; i < clip.length; i++) orientation += clip[i].x * clip[(i + 1) % clip.length].y - clip[(i + 1) % clip.length].x * clip[i].y;
      const direction = orientation >= 0 ? 1 : -1;
      for (let i = 0; i < clip.length; i++) {
        const p = clip[i], q = clip[(i + 1) % clip.length], side = (v) => direction * ((q.x - p.x) * (v.y - p.y) - (q.y - p.y) * (v.x - p.x)), out = [];
        let prev = poly.at(-1), pv = side(prev);
        for (const cur of poly) {
          const cv = side(cur);
          if (pv < -1e-8 !== cv < -1e-8) {
            const t = pv / (pv - cv), vertex = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
            if (uv) {
              vertex.u = prev.u + (cur.u - prev.u) * t;
              vertex.v = prev.v + (cur.v - prev.v) * t;
            }
            out.push(vertex);
          }
          if (cv >= -1e-8) out.push(cur);
          prev = cur;
          pv = cv;
        }
        poly = out;
        if (!poly.length) return poly;
      }
    }
    return poly;
  }
  _emitTriangle(a, b, c, color2, uv = null) {
    rgba(color2);
    if (this.activeGradient && !uv) uv = [this._gradientUV(a), this._gradientUV(b), this._gradientUV(c)];
    if (!this.clips.length && !uv) {
      if (this.count + 3 > this.maxVertices) this._submit();
      if (this.count + 3 > this.vertices.length / 8) {
        const size = Math.min(this.maxVertices, Math.max(this.count + 3, this.vertices.length / 4));
        const next = new Float32Array(size * 8);
        next.set(this.vertices);
        this.vertices = next;
      }
      const data = this.vertices;
      for (let i = 0; i < 3; i++) {
        const point2 = i === 0 ? a : i === 1 ? b : c, k = this.count++ * 8;
        data[k] = point2.x;
        data[k + 1] = point2.y;
        data[k + 2] = data[k + 3] = 0;
        data.set(color2, k + 4);
      }
      return;
    }
    const poly = this.clips.length ? this._clipTriangle(a, b, c, uv) : uv ? [a, b, c].map((point2, i) => ({ ...point2, u: uv[i][0], v: uv[i][1] })) : [a, b, c];
    for (let i = 1; i + 1 < poly.length; i++) {
      if (this.count + 3 > this.maxVertices) this._submit();
      if (this.count + 3 > this.vertices.length / 8) {
        const size = Math.min(this.maxVertices, Math.max(this.count + 3, this.vertices.length / 4));
        const next = new Float32Array(size * 8);
        next.set(this.vertices);
        this.vertices = next;
      }
      for (const point2 of [poly[0], poly[i], poly[i + 1]]) {
        const k = this.count++ * 8;
        this.vertices[k] = point2.x;
        this.vertices[k + 1] = point2.y;
        this.vertices[k + 2] = point2.u ?? 0;
        this.vertices[k + 3] = point2.v ?? 0;
        this.vertices.set(color2, k + 4);
      }
    }
  }
  _submit() {
    if (!this.count) return;
    const texture = this.activeTexture ?? this.white, gradient = this.activeGradient;
    this.device.uploadVertices(this.buffer, this.vertices.subarray(0, this.count * 8));
    this.device.draw({ pipeline: this.pipeline, buffer: this.buffer, count: this.count, uniforms: { u_projection: this.projection, u_texture: 0, u_textured: texture === this.white ? 0 : 1, u_radial: this.activeRadial ? gradient?.radialEmpty ? 2 : 1 : 0, u_radial_params: gradient?.radialParams ?? [0, 0, 0, 0], u_whiteFlash: this.activeWhiteFlash ? 1 : 0 }, textures: [texture], blend: "source-over", stencil: this.stencilDepth ? { func: "equal", ref: this.stencilDepth, mask: 255, writeMask: 0, pass: "keep" } : false });
    this.count = 0;
  }
  _useTexture(texture, { radial = false, whiteFlash = false, gradient = null } = {}) {
    if (this.activeTexture !== texture || this.activeRadial !== radial || this.activeWhiteFlash !== whiteFlash || this.activeGradient?.gradient !== gradient?.gradient) this._submit();
    this.activeTexture = texture;
    this.activeRadial = radial;
    this.activeWhiteFlash = whiteFlash;
    this.activeGradient = gradient;
  }
  fill(colorValue = [0, 0, 0, 1], rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") throw new TypeError("rule must be nonzero or evenodd");
    this._useTexture(this.white);
    const col = rgba(colorValue), vertices = tessellate(this.path, rule);
    for (let i = 0; i + 2 < vertices.length; i += 3) this._emitTriangle(vertices[i], vertices[i + 1], vertices[i + 2], col);
  }
  fillRadialGradient(gradient) {
    this._frame();
    if (!gradient?.texture || !gradient.matrixInverse || !Number.isFinite(gradient.radialScale) || gradient.radialScale <= 0 || !Array.isArray(gradient.radialParams) || gradient.radialParams.length !== 4 || gradient.radialParams.some((value) => !Number.isFinite(value))) throw new TypeError("valid two-circle radial gradient texture and transform are required");
    this._useTexture(gradient.texture, { radial: true, whiteFlash: gradient.whiteFlash, gradient });
    const vertices = tessellate(this.path, gradient.rule ?? "nonzero");
    for (let i = 0; i + 2 < vertices.length; i += 3) this._emitTriangle(vertices[i], vertices[i + 1], vertices[i + 2], gradient.color);
  }
  fillLinearGradient(gradient) {
    this._frame();
    if (!gradient?.texture || !gradient.matrixInverse || ![gradient.x0, gradient.y0, gradient.x1, gradient.y1].every(Number.isFinite)) throw new TypeError("valid linear gradient texture and transform are required");
    this._useTexture(gradient.texture, { whiteFlash: gradient.whiteFlash, gradient });
    const vertices = tessellate(this.path, gradient.rule ?? "nonzero");
    for (let i = 0; i + 2 < vertices.length; i += 3) this._emitTriangle(vertices[i], vertices[i + 1], vertices[i + 2], gradient.color);
  }
  _gradientUV(p) {
    const g = this.activeGradient, m = g.matrixInverse, x = m[0] * p.x + m[2] * p.y + m[4], y = m[1] * p.x + m[3] * p.y + m[5];
    if (this.activeRadial) return [(x - g.x0) / g.radialScale, (y - g.y0) / g.radialScale];
    const dx = g.x1 - g.x0, dy = g.y1 - g.y0, denom = dx * dx + dy * dy;
    return [denom ? ((x - g.x0) * dx + (y - g.y0) * dy) / denom : 1, 0.5];
  }
  stroke(colorValue = [0, 0, 0, 1], width = 1, { lineCap = "butt", lineJoin = "miter", miterLimit = 10 } = {}, gradient = null) {
    this._frame();
    this._useTexture(gradient?.texture ?? this.white, { radial: gradient?.kind === "radial", whiteFlash: gradient?.whiteFlash ?? false, gradient });
    rgba(colorValue);
    if (!Number.isFinite(width) || width <= 0) throw new RangeError("line width must be positive");
    if (!["butt", "round", "square"].includes(lineCap) || !["miter", "round", "bevel"].includes(lineJoin) || !Number.isFinite(miterLimit) || miterLimit <= 0) throw new TypeError("invalid stroke style");
    const half = width / 2, fan = (center, points) => {
      for (let i = 1; i < points.length; i++) this._emitTriangle(center, points[i - 1], points[i], colorValue);
    };
    for (const source of this.path) {
      const contour = source.filter((p, i) => !i || p.x !== source[i - 1].x || p.y !== source[i - 1].y);
      if (contour.length < 2) continue;
      const closed = contour.length > 2 && contour[0].x === contour.at(-1).x && contour[0].y === contour.at(-1).y;
      if (closed) contour.pop();
      const count = closed ? contour.length : contour.length - 1, dirs = [], normals = [];
      for (let i = 0; i < count; i++) {
        const a = contour[i], b = contour[(i + 1) % contour.length], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
        if (!l) {
          dirs.push({ x: 0, y: 0 });
          normals.push({ x: 0, y: 0 });
          continue;
        }
        dirs.push({ x: dx / l, y: dy / l });
        normals.push({ x: -dy / l * half, y: dx / l * half });
      }
      for (let i = 0; i < count; i++) {
        const a = contour[i], b = contour[(i + 1) % contour.length], d = dirs[i], n = normals[i];
        if (!d.x && !d.y) continue;
        const extend = !closed && lineCap === "square" && (i === 0 || i === count - 1) ? half : 0, ax = a.x - d.x * extend, ay = a.y - d.y * extend, bx = b.x + d.x * extend, by = b.y + d.y * extend, p = { x: ax + n.x, y: ay + n.y }, q = { x: bx + n.x, y: by + n.y }, r = { x: bx - n.x, y: by - n.y }, s = { x: ax - n.x, y: ay - n.y };
        this._emitTriangle(p, q, r, colorValue);
        this._emitTriangle(p, r, s, colorValue);
      }
      const joinStart = closed ? 0 : 1, joinEnd = closed ? contour.length : contour.length - 1;
      for (let i = joinStart; i < joinEnd; i++) {
        const prev = (i - 1 + count) % count, next = i % count, v = contour[i % contour.length], d0 = dirs[prev], d1 = dirs[next], n0 = normals[prev], n1 = normals[next], cross = d0.x * d1.y - d0.y * d1.x;
        if (Math.abs(cross) < 1e-8) continue;
        const sign = cross > 0 ? -1 : 1, a = { x: v.x + n0.x * sign, y: v.y + n0.y * sign }, b = { x: v.x + n1.x * sign, y: v.y + n1.y * sign };
        if (lineJoin === "round") {
          let start = Math.atan2(a.y - v.y, a.x - v.x), end = Math.atan2(b.y - v.y, b.x - v.x), sweep = end - start;
          if (cross > 0) {
            while (sweep > 0) sweep -= Math.PI * 2;
          } else while (sweep < 0) sweep += Math.PI * 2;
          const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 8))), arc = [a];
          for (let j = 1; j <= steps; j++) {
            const t = start + sweep * j / steps;
            arc.push({ x: v.x + Math.cos(t) * half, y: v.y + Math.sin(t) * half });
          }
          fan(v, arc);
        } else if (lineJoin === "miter") {
          const mx = n0.x * sign + n1.x * sign, my = n0.y * sign + n1.y * sign, ml = Math.hypot(mx, my), denom = ml ? mx / ml * (n1.x * sign) + my / ml * (n1.y * sign) : 0, miter = denom ? half / denom : Infinity;
          if (Number.isFinite(miter) && Math.abs(miter) <= half * miterLimit) {
            const tip = { x: v.x + mx / ml * miter, y: v.y + my / ml * miter };
            this._emitTriangle(a, tip, b, colorValue);
          } else this._emitTriangle(v, a, b, colorValue);
        } else this._emitTriangle(v, a, b, colorValue);
      }
      if (!closed && lineCap === "round") {
        for (const [index, angle] of [[0, Math.atan2(dirs[0].y, dirs[0].x) + Math.PI], [count - 1, Math.atan2(dirs[count - 1].y, dirs[count - 1].x)]]) {
          const v = contour[index === 0 ? 0 : contour.length - 1], start = angle - Math.PI / 2, arc = [];
          for (let j = 0; j <= 8; j++) {
            const t = start + Math.PI * j / 8;
            arc.push({ x: v.x + Math.cos(t) * half, y: v.y + Math.sin(t) * half });
          }
          fan(v, arc);
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
    if (!points || points.length < 3) return;
    this._useTexture(this.white);
    const m = this.matrix, anchor = point(m, points[0][0], points[0][1]);
    let previous = point(m, points[1][0], points[1][1]);
    for (let i = 2; i < points.length; i++) {
      const current = point(m, points[i][0], points[i][1]);
      this._emitTriangle(anchor, previous, current, colorValue);
      previous = current;
    }
  }
  fillText(text, x, y, options = {}) {
    this._frame();
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    return this.glyphAtlas.fillText(this, text, x, y, options);
  }
  strokeText(text, x, y, options = {}) {
    this._frame();
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    return this.glyphAtlas.strokeText(this, text, x, y, options);
  }
  measureText(text, options = {}) {
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    return this.glyphAtlas.measureText(text, options);
  }
  drawGlyphQuad(texture, x, y, width, height, uv, colorValue) {
    this._frame();
    this._useTexture(texture);
    const a = { ...point(this.matrix, x, y) }, b = { ...point(this.matrix, x + width, y) }, c = { ...point(this.matrix, x + width, y + height) }, d = { ...point(this.matrix, x, y + height) };
    this._emitTriangle(a, b, c, colorValue, [[uv.u0, uv.v0], [uv.u1, uv.v0], [uv.u1, uv.v1]]);
    this._emitTriangle(a, c, d, colorValue, [[uv.u0, uv.v0], [uv.u1, uv.v1], [uv.u0, uv.v1]]);
  }
  flush() {
    this._frame();
    this._submit();
  }
  beginGroup(opacity = 1, bounds = null) {
    this._frame();
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError("group opacity must be in [0,1]");
    this._submit();
    if (opacity === 1) {
      this.groups.push({ direct: true });
      return;
    }
    const requested = bounds ?? { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height };
    for (const key of ["x", "y", "width", "height"]) if (!Number.isFinite(requested[key])) throw new TypeError(`group bounds.${key} must be finite`);
    if (requested.width <= 0 || requested.height <= 0) throw new RangeError("group bounds must have positive size");
    const x = Math.max(0, Math.floor(requested.x)), y = Math.max(0, Math.floor(requested.y)), right = Math.min(this.canvas.width, Math.ceil(requested.x + requested.width)), bottom = Math.min(this.canvas.height, Math.ceil(requested.y + requested.height)), width = right - x, height = bottom - y;
    if (width <= 0 || height <= 0) {
      this.groups.push({ direct: true, empty: true });
      return;
    }
    const depth = this.groups.filter((g) => !g.direct).length;
    let target = this.groupTargets[depth];
    const allocation = (n) => Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(n))), needW = allocation(width), needH = allocation(height), needStencil = this.device.stencilAvailable;
    if (!target || target.width < width || target.height < height || Boolean(this.device.renderTargets.get(target)?.stencil) !== needStencil) {
      if (target) this.device.deleteRenderTarget(target);
      target = this.groupTargets[depth] = this.device.createRenderTarget(needW, needH, { filter: "nearest", stencil: needStencil });
    }
    const group = { target, opacity, bounds: { x, y, width, height }, matrix: this.matrix.slice(), clips: this.clips, stencilClips: this.stencilClips.slice(), projection: this.projection.slice() };
    this.device.bindRenderTarget(target);
    this.groups.push(group);
    this._setProjection(group.bounds, target);
    this.device.clear({ color: [0, 0, 0, 0], ...this.device.activeStencilAvailable ? { stencil: 0 } : {} });
    this.stencilDepth = 0;
    if (this.stencilClips.length) this._rebuildStencil();
    this.clips = [...this.clips, [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }]];
  }
  endGroup() {
    this._frame();
    const group = this.groups.pop();
    if (!group) throw new Error("endGroup without beginGroup");
    this._submit();
    if (group.direct) return;
    this.device.unbindRenderTarget(group.target);
    this.matrix = group.matrix;
    this.clips = group.clips;
    this.stencilClips = group.stencilClips;
    this.stencilDepth = this.stencilClips.length;
    this.projection.set(group.projection);
    this._useTexture(group.target);
    const { x, y, width, height } = group.bounds, u = width / group.target.width, v = height / group.target.height, a = { x, y }, b = { x: x + width, y }, c = { x: x + width, y: y + height }, d = { x, y: y + height }, alpha = [1, 1, 1, group.opacity];
    this._emitTriangle(a, b, c, alpha, [[0, 1], [u, 1], [u, 1 - v]]);
    this._emitTriangle(a, c, d, alpha, [[0, 1], [u, 1 - v], [0, 1 - v]]);
    this._submit();
    this._useTexture(this.white);
  }
  dispose() {
    if (this.state === "disposed") return;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.count = 0;
    for (const target of this.groupTargets) this.device.deleteRenderTarget(target);
    for (const record of this.clipPaths.values()) this.device.deleteVertexBuffer(record.buffer);
    this.clipPaths.clear();
    this.clipPathBytes = 0;
    this.device.deleteVertexBuffer(this.dynamicClipBuffer);
    this.device.deleteVertexBuffer(this.buffer);
    this.device.deletePipeline(this.clipPipeline);
    this.device.deletePipeline(this.pipeline);
    this.device.deleteTexture(this.white);
    this.buffer = this.dynamicClipBuffer = this.clipPipeline = this.pipeline = this.white = null;
    this.state = "disposed";
  }
};

// modules/rendering/mesh-renderer.js
var IDENTITY2 = Object.freeze([1, 0, 0, 1, 0, 0]);
var ZERO_MORPH = Object.freeze([0, 0]);
var EMPTY_CLIP = Object.freeze({ key: "", values: null, count: 0 });
var WHITE2 = Object.freeze([1, 1, 1, 1]);
var ATTRIBUTES = [
  { name: "a_position", size: 2, offset: 0 },
  { name: "a_color", size: 4, offset: 8 },
  { name: "a_morph", size: 4, offset: 24 },
  { name: "a_part", size: 1, offset: 40 }
];
var INSTANCE_ATTRIBUTES = ["i_row0", "i_row1", "i_color", "i_params"].map((name, i) => ({ name, size: 4, offset: i * 16, source: "instance" }));
var WORLD_INSTANCE_ATTRIBUTES = ["i_row0", "i_row1", "i_row2", "i_params"].map((name, i) => ({ name, size: 4, offset: i * 16, source: "instance" }));
function shader(instanced, partCount, morphCount, clipped, nonScalingStroke, worldMode = false) {
  const inputs = ["i_row0", "i_row1", "i_color", "i_params"].map((name) => `${instanced ? "attribute" : "uniform"} vec4 ${name};`).join("\n");
  const local = morphCount ? "a_position+a_morph.xy*(i_params.x" + (partCount > 1 ? "+pose.x" : "") + ")" + (morphCount > 1 ? "+a_morph.zw*(i_params.y" + (partCount > 1 ? "+pose.y" : "") + ")" : "") : "a_position";
  const strokeInputs = nonScalingStroke ? "attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;" : "";
  const strokeVarying = clipped && nonScalingStroke ? "uniform mat3 u_inverseProjection;" : "";
  const strokePosition = nonScalingStroke ? `
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
    const worldInputs = ["i_row0", "i_row1", "i_row2", "i_params"].map((name) => `${instanced ? "attribute" : "uniform"} vec4 ${name};`).join("\n");
    const worldStrokeInputs = nonScalingStroke ? "attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;" + (clipped ? "uniform mat4 u_inverseViewProjection;" : "") : "";
    const worldStroke = nonScalingStroke ? `
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
${worldInputs}${worldStrokeInputs}
uniform mat4 u_viewProjection; uniform vec4 u_color; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}
void main(){${partCount > 1 ? "int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];" : ""}
vec2 local=${local};vec2 plane=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec3 world=vec3(dot(i_row0.xyz,vec3(plane,1.0)),dot(i_row1.xyz,vec3(plane,1.0)),dot(i_row2.xyz,vec3(plane,1.0)));
vec4 projected=u_viewProjection*vec4(world,1.0);${clipped ? "v_position=world.xy;" : ""}${worldStroke}
projected.z+=(i_params.w+${partCount > 1 ? "pose.w" : "0.0"})*projected.w;gl_Position=projected;
vec4 color=mix(a_color*u_color,u_color,i_row1.w);color.a*=i_row0.w${partCount > 1 ? "*pose.z" : ""};color.rgb=mix(color.rgb,vec3(1.0),i_row2.w);v_color=vec4(color.rgb*color.a,color.a);
}`;
  }
  return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? "attribute vec4 a_morph;" : ""} ${partCount > 1 ? "attribute float a_part;uniform vec4 u_parts[" + partCount * 3 + "];" : ""}
${inputs}${strokeInputs}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}${strokeVarying}
void main(){${partCount > 1 ? "int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];" : ""}
vec2 local=${local};vec2 p=${partCount > 1 ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? "v_position=world;" : ""}${strokePosition}
gl_Position=vec4(projected.xy,(i_params.w+${partCount > 1 ? "pose.w" : "0.0"})*projected.z,projected.z);
vec4 color=mix(a_color*i_color,i_color,i_row1.w);color.a*=i_row0.w${partCount > 1 ? "*pose.z" : ""};
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);}`;
}
function fragment(maxPlanes, clipped) {
  if (!clipped) return "precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}";
  return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}gl_FragColor=v_color;}`;
}
function finiteArray2(value, size, name) {
  if (!value || value.length !== size) throw new TypeError(`${name}: ${size} finite numbers required`);
  for (let i = 0; i < size; i++) if (!Number.isFinite(value[i])) throw new TypeError(`${name}: ${size} finite numbers required`);
}
function affineMatrix4(value, name) {
  finiteArray2(value, 16, name);
  if (Math.abs(value[3]) > 1e-7 || Math.abs(value[7]) > 1e-7 || Math.abs(value[11]) > 1e-7 || Math.abs(value[15] - 1) > 1e-7) {
    throw new TypeError(`${name} must be an affine column-major 4x4 matrix`);
  }
}
function invertMatrix4(matrix) {
  const rows = Array.from({ length: 4 }, (_, row) => [
    matrix[row],
    matrix[4 + row],
    matrix[8 + row],
    matrix[12 + row],
    ...row === 0 ? [1, 0, 0, 0] : row === 1 ? [0, 1, 0, 0] : row === 2 ? [0, 0, 1, 0] : [0, 0, 0, 1]
  ]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (!Number.isFinite(rows[pivot][column]) || Math.abs(rows[pivot][column]) < 1e-12) throw new RangeError("Clipped non-scaling strokes require an invertible viewProjection");
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let j = 0; j < 8; j++) rows[column][j] /= divisor;
    for (let row = 0; row < 4; row++) if (row !== column) {
      const scale = rows[row][column];
      for (let j = 0; j < 8; j++) rows[row][j] -= scale * rows[column][j];
    }
  }
  const inverse = new Float32Array(16);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) inverse[column * 4 + row] = rows[row][column + 4];
  return inverse;
}
function invertProjection(projection) {
  const [a, d, g, b, e, h, c, f, i] = projection;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, D = c * h - b * i, E = a * i - c * g, F = b * g - a * h, G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  const determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new RangeError("Non-scaling strokes require an invertible projection");
  return Float32Array.from([A, B, C, D, E, F, G, H, I], (value) => value / determinant);
}
function packParts(parts, count, output) {
  if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) throw new TypeError("One pose per authored mesh part required");
  for (let i = 0; i < count; i++) {
    const part = parts?.[i], m = part?.transform ?? IDENTITY2, morph = part?.morph ?? ZERO_MORPH;
    finiteArray2(m, 6, "part transform");
    finiteArray2(morph, 2, "part morph");
    const opacity = part?.opacity ?? 1;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError("part opacity must be in [0,1]");
    const at = i * 12;
    output[at] = m[0];
    output[at + 1] = m[2];
    output[at + 2] = m[4];
    output[at + 3] = 0;
    output[at + 4] = m[1];
    output[at + 5] = m[3];
    output[at + 6] = m[5];
    output[at + 7] = 0;
    const depth = part?.depth ?? 0;
    if (!Number.isFinite(depth) || depth < -1 || depth > 1) throw new RangeError("part depth must be in [-1,1]");
    output[at + 8] = morph[0];
    output[at + 9] = morph[1];
    output[at + 10] = part?.visible === false ? 0 : opacity;
    output[at + 11] = depth;
  }
}
function clipState(clips, maxPlanes) {
  if (!clips?.length) return EMPTY_CLIP;
  const values = [], key = [];
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) throw new TypeError("Finite convex clip polygons required");
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      area += p.x * q.y - q.x * p.y;
    }
    if (Math.abs(area) < 1e-12) return { key: "empty", values: [0, 0, -1], count: 1 };
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length], dx = q.x - p.x, dy = q.y - p.y, length = Math.hypot(dx, dy);
      if (!length) continue;
      const a = -dy / length * sign, b = dx / length * sign, c = -(a * p.x + b * p.y);
      values.push(a, b, c);
      key.push(a, b, c);
    }
  }
  if (values.length / 3 > maxPlanes) throw new RangeError(`Mesh clipping exceeds ${maxPlanes} edge planes`);
  return { key: key.join(","), values, count: values.length / 3 };
}
function meshPartBounds(vertices, partCount, morphCount) {
  const bounds = Array.from({ length: partCount }, () => ({
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
  }));
  for (let at = 0; at < vertices.length; at += 11) {
    const bound = bounds[vertices[at + 10]], x = vertices[at], y = vertices[at + 1];
    bound.minX = Math.min(bound.minX, x);
    bound.maxX = Math.max(bound.maxX, x);
    bound.minY = Math.min(bound.minY, y);
    bound.maxY = Math.max(bound.maxY, y);
    const dx0 = morphCount > 0 ? vertices[at + 6] : 0, dy0 = morphCount > 0 ? vertices[at + 7] : 0;
    const dx1 = morphCount > 1 ? vertices[at + 8] : 0, dy1 = morphCount > 1 ? vertices[at + 9] : 0;
    bound.minDx0 = Math.min(bound.minDx0, dx0);
    bound.maxDx0 = Math.max(bound.maxDx0, dx0);
    bound.minDy0 = Math.min(bound.minDy0, dy0);
    bound.maxDy0 = Math.max(bound.maxDy0, dy0);
    bound.minDx1 = Math.min(bound.minDx1, dx1);
    bound.maxDx1 = Math.max(bound.maxDx1, dx1);
    bound.minDy1 = Math.min(bound.minDy1, dy1);
    bound.maxDy1 = Math.max(bound.maxDy1, dy1);
  }
  for (const bound of bounds) {
    if (!Number.isFinite(bound.minX)) {
      bound.minX = bound.minY = bound.maxX = bound.maxY = 0;
    }
    for (const key of ["minDx0", "minDy0", "maxDx0", "maxDy0", "minDx1", "minDy1", "maxDx1", "maxDy1"]) if (!Number.isFinite(bound[key])) bound[key] = 0;
  }
  return bounds;
}
var MeshRenderer = class {
  constructor(device, { maxMeshes = 512, maxMeshBytes = 32 * 1024 * 1024, maxInstances = 2048, safeAlphaRunBatching = true } = {}) {
    for (const [key, value] of Object.entries({ maxMeshes, maxMeshBytes, maxInstances })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key} must be positive`);
    if (typeof safeAlphaRunBatching !== "boolean") throw new TypeError("safeAlphaRunBatching must be a boolean");
    this.device = device;
    this.maxMeshes = maxMeshes;
    this.maxMeshBytes = maxMeshBytes;
    this.maxInstances = maxInstances;
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    if (maxInstances * 64 > device.maxBufferBytes) throw new RangeError("Mesh instance buffer exceeds device byte limit");
    this.maxPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
    this.instanced = device.instancingSupported === true;
    this.instances = new Float32Array(maxInstances * 16);
    this.instanceBuffer = this.instanced ? device.createVertexBuffer({ capacityBytes: this.instances.byteLength }) : null;
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
    this.alphaQueueBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this.alphaBoundsScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
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
        if (this.instanced && !device.instancingSupported) throw new Error("Restored context no longer supports mesh instancing");
        for (const mesh of this.meshes) {
          device.uploadVertices(mesh.buffer, mesh.vertices);
          if (mesh.indices) device.uploadIndices(mesh.indexBuffer, mesh.indices);
          for (const variant of mesh.expressionIndices.values()) if (variant.indices.length) device.uploadIndices(variant.indexBuffer, variant.indices);
          for (const variant of mesh.indexVariants.values()) if (variant.indices.length) device.uploadIndices(variant.indexBuffer, variant.indices);
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
    const key = mesh.partCount + ":" + mesh.morphCount + ":" + Number(clipped) + ":" + Number(mesh.hasNonScalingStroke) + ":" + Number(worldMode);
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const uniforms = worldMode ? { u_viewProjection: "matrix4fv", u_color: "4f" } : { u_projection: "matrix3fv" };
    if (clipped) Object.assign(uniforms, { "u_planes[0]": "3fv", u_planeCount: "1i" });
    if (clipped && worldMode && mesh.hasNonScalingStroke) uniforms.u_inverseViewProjection = "matrix4fv";
    if (mesh.hasNonScalingStroke) {
      uniforms.u_strokeViewportSize = "2f";
      if (clipped && !worldMode) uniforms.u_inverseProjection = "matrix3fv";
    }
    if (mesh.partCount > 1) uniforms["u_parts[0]"] = "4fv";
    if (!this.instanced) for (const name of worldMode ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"]) uniforms[name] = "4f";
    pipeline = this.device.createPipeline({
      vertex: shader(this.instanced, mesh.partCount, mesh.morphCount, clipped, mesh.hasNonScalingStroke, worldMode),
      fragment: fragment(this.maxPlanes, clipped),
      stride: mesh.strideFloats * 4,
      ...this.instanced ? { instanceStride: 64 } : {},
      attributes: [...mesh.hasNonScalingStroke ? ATTRIBUTES.filter((attribute) => attribute.name !== "a_morph") : ATTRIBUTES, ...mesh.hasNonScalingStroke ? [
        { name: "a_stroke", size: 4, offset: 24 }
      ] : [], ...this.instanced ? worldMode ? WORLD_INSTANCE_ATTRIBUTES : INSTANCE_ATTRIBUTES : []],
      uniforms
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  createMesh(data) {
    this._ready();
    const indices = data?.indices;
    const expressionIndices = data?.expressionIndices === void 0 ? {} : data.expressionIndices;
    const indexVariants = data?.indexVariants === void 0 ? {} : data.indexVariants;
    const nonScalingStroke = data?.nonScalingStroke ?? false;
    if (!(data?.vertices instanceof Float32Array) || data.vertices.length < 33 || data.vertices.length % 11 || data.strideFloats !== 11 || typeof nonScalingStroke !== "boolean" || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > 16 || !Number.isSafeInteger(data.morphCount) || data.morphCount < 0 || data.morphCount > 2 || indices !== void 0 && (!(indices instanceof Uint16Array) || indices.length < 3 || indices.length % 3 || data.vertices.length / 11 > 65536 || indices.some((index) => index >= data.vertices.length / 11)) || indices === void 0 && data.vertices.length % 33 || !expressionIndices || typeof expressionIndices !== "object" || Array.isArray(expressionIndices) || !indexVariants || typeof indexVariants !== "object" || Array.isArray(indexVariants)) throw new TypeError("Mesh geometry with complete triangles and 1..16 parts required");
    const expressionEntries = Object.entries(expressionIndices), indexVariantEntries = Object.entries(indexVariants);
    const variantNames = new Set(expressionEntries.map(([name]) => name));
    if (expressionEntries.some(([name, variant]) => !name || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= data.vertices.length / 11)) || indexVariantEntries.some(([name, variant]) => !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || variantNames.has(name) || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= data.vertices.length / 11))) {
      throw new TypeError("Invalid named mesh index variants or expression index variants");
    }
    if (data.vertices.some((n) => !Number.isFinite(n))) throw new TypeError("Mesh values must be finite");
    for (let i = 0; i < data.vertices.length; i++) {
      if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) throw new RangeError("Mesh RGBA channels must be in [0,1]");
      if (i % 11 === 10 && (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)) throw new RangeError("Mesh part index outside partCount");
      if (i % 11 >= 6 + data.morphCount * 2 && i % 11 < 10 && data.vertices[i] !== 0 && !nonScalingStroke) throw new RangeError("Mesh deltas exceed declared morphCount");
    }
    if (nonScalingStroke && data.morphCount) throw new TypeError("Non-scaling stroke meshes cannot use vertex morph targets");
    const variantByteLength = [...expressionEntries, ...indexVariantEntries].reduce((total, [, variant]) => total + variant.byteLength, 0);
    const byteLength = data.vertices.byteLength + (indices?.byteLength ?? 0) + variantByteLength;
    if (this.meshes.size >= this.maxMeshes || this.bytes + byteLength > this.maxMeshBytes) throw new RangeError("Retained mesh budget exceeded");
    const vertices = data.vertices.slice(), ownedIndices = indices?.slice(), buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    let indexBuffer;
    const ownedExpressions = /* @__PURE__ */ new Map(), ownedVariants = /* @__PURE__ */ new Map();
    try {
      this.device.uploadVertices(buffer, vertices);
      if (ownedIndices) {
        indexBuffer = this.device.createIndexBuffer({ capacityBytes: ownedIndices.byteLength });
        this.device.uploadIndices(indexBuffer, ownedIndices);
      }
      for (const [name, source] of expressionEntries) {
        const variantIndices = source.slice();
        const variantBuffer = variantIndices.length ? this.device.createIndexBuffer({ capacityBytes: variantIndices.byteLength }) : null;
        const variant = { indices: variantIndices, indexBuffer: variantBuffer, count: variantIndices.length };
        ownedExpressions.set(name, variant);
        if (variantBuffer) this.device.uploadIndices(variantBuffer, variantIndices);
      }
      for (const [name, source] of indexVariantEntries) {
        const variantIndices = source.slice();
        const variantBuffer = variantIndices.length ? this.device.createIndexBuffer({ capacityBytes: variantIndices.byteLength }) : null;
        const variant = { indices: variantIndices, indexBuffer: variantBuffer, count: variantIndices.length };
        ownedVariants.set(name, variant);
        if (variantBuffer) this.device.uploadIndices(variantBuffer, variantIndices);
      }
    } catch (error) {
      for (const variant of ownedExpressions.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
      for (const variant of ownedVariants.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
      if (indexBuffer) this.device.deleteIndexBuffer(indexBuffer);
      this.device.deleteVertexBuffer(buffer);
      throw error;
    }
    const mesh = Object.freeze({
      renderer: this,
      buffer,
      indexBuffer,
      vertices,
      indices: ownedIndices,
      expressionIndices: ownedExpressions,
      indexVariants: ownedVariants,
      count: ownedIndices?.length ?? vertices.length / 11,
      byteLength,
      partCount: data.partCount,
      morphCount: data.morphCount,
      strideFloats: 11,
      hasNonScalingStroke: nonScalingStroke,
      partBounds: meshPartBounds(vertices, data.partCount, data.morphCount)
    });
    this.meshes.add(mesh);
    this.bytes += byteLength;
    this.metrics.geometryUploads++;
    this.metrics.geometryBytesUploaded += byteLength;
    return mesh;
  }
  deleteMesh(mesh) {
    if (!this.meshes.has(mesh)) return false;
    if (this.pending?.mesh === mesh || this.alphaQueueCount && this.alphaQueueState.mesh === mesh) this.flush("deleteMesh");
    this.alphaRunCache.delete(mesh);
    this.device.deleteVertexBuffer(mesh.buffer);
    if (mesh.indexBuffer) this.device.deleteIndexBuffer(mesh.indexBuffer);
    for (const variant of mesh.expressionIndices.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    for (const variant of mesh.indexVariants.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    this.meshes.delete(mesh);
    this.bytes -= mesh.byteLength;
    return true;
  }
  /** Captures state by value; subsequent transform/paint changes do not alter queued instances. */
  drawMesh(mesh, options = {}) {
    const {
      matrix = IDENTITY2,
      projection,
      morph = [0, 0],
      parts = null,
      color: color2 = WHITE2,
      forceColor = false,
      alpha = 1,
      whiteFlash = false,
      clips = [],
      depth = 0,
      depthTest = false,
      depthWrite = false,
      depthWriteAlphaThreshold = null,
      depthFunc = "lequal",
      indexVariant = null,
      indexRange = null,
      strokeViewport = null,
      stencilRef = null,
      viewProjection,
      worldMatrix
    } = options;
    this._drawMeshInstances(mesh, {
      matrices: matrix,
      count: 1,
      projection,
      viewProjection,
      worldMatrix,
      morph,
      parts,
      color: color2,
      forceColor,
      alpha,
      whiteFlash,
      clips,
      indexVariant,
      indexRange,
      depth,
      depthTest,
      depthWrite,
      depthWriteAlphaThreshold,
      depthFunc,
      strokeViewport,
      stencilRef
    });
  }
  _screenBounds(mesh, matrices, instanceIndex, projection, morph) {
    if (mesh.hasNonScalingStroke || projection[2] !== 0 || projection[5] !== 0 || Math.abs(projection[8]) < 1e-12) return null;
    const width = this.device.activeRenderTarget?.width ?? this.device.canvas.width;
    const height = this.device.activeRenderTarget?.height ?? this.device.canvas.height;
    const matrixAt = instanceIndex * 6, m0 = matrices[matrixAt], m1 = matrices[matrixAt + 1], m2 = matrices[matrixAt + 2], m3 = matrices[matrixAt + 3], m4 = matrices[matrixAt + 4], m5 = matrices[matrixAt + 5];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let partIndex = 0; partIndex < mesh.partCount; partIndex++) {
      const bound = mesh.partBounds[partIndex], at = partIndex * 12, poseMorph0 = morph[0] + this.partScratch[at + 8], poseMorph1 = morph[1] + this.partScratch[at + 9];
      const x0 = bound.minX + (poseMorph0 < 0 ? bound.maxDx0 : bound.minDx0) * poseMorph0 + (poseMorph1 < 0 ? bound.maxDx1 : bound.minDx1) * poseMorph1;
      const x1 = bound.maxX + (poseMorph0 < 0 ? bound.minDx0 : bound.maxDx0) * poseMorph0 + (poseMorph1 < 0 ? bound.minDx1 : bound.maxDx1) * poseMorph1;
      const y0 = bound.minY + (poseMorph0 < 0 ? bound.maxDy0 : bound.minDy0) * poseMorph0 + (poseMorph1 < 0 ? bound.maxDy1 : bound.minDy1) * poseMorph1;
      const y1 = bound.maxY + (poseMorph0 < 0 ? bound.minDy0 : bound.maxDy0) * poseMorph0 + (poseMorph1 < 0 ? bound.minDy1 : bound.maxDy1) * poseMorph1;
      const pa = this.partScratch[at], pc = this.partScratch[at + 1], pe = this.partScratch[at + 2];
      const pb = this.partScratch[at + 4], pd = this.partScratch[at + 5], pf = this.partScratch[at + 6];
      for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) {
        const x = xi ? x1 : x0, y = yi ? y1 : y0, partX = pa * x + pc * y + pe, partY = pb * x + pd * y + pf;
        const worldX = m0 * partX + m2 * partY + m4, worldY = m1 * partX + m3 * partY + m5;
        const clipX = projection[0] * worldX + projection[3] * worldY + projection[6], clipY = projection[1] * worldX + projection[4] * worldY + projection[7];
        const px = (clipX / projection[8] + 1) * width / 2, py = (1 - clipY / projection[8]) * height / 2;
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const bounds = this.alphaBoundsScratch;
    bounds.minX = minX - 1.5;
    bounds.minY = minY - 1.5;
    bounds.maxX = maxX + 1.5;
    bounds.maxY = maxY + 1.5;
    return bounds;
  }
  _boundsOverlap(a, b) {
    return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
  }
  _extendAlphaQueueBounds(bounds) {
    const group = this.alphaQueueBounds;
    if (!this.alphaQueueCount) Object.assign(group, bounds);
    else {
      group.minX = Math.min(group.minX, bounds.minX);
      group.minY = Math.min(group.minY, bounds.minY);
      group.maxX = Math.max(group.maxX, bounds.maxX);
      group.maxY = Math.max(group.maxY, bounds.maxY);
    }
  }
  _alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    const state = this.alphaQueueState;
    if (!state) return true;
    if (state.mesh !== mesh || state.indexVariant !== indexVariant || state.clip.key !== clip.key || state.stencilRef !== stencilRef || state.depthTest !== depthTest || state.depthFunc !== depthFunc || state.runKey !== runs.join(",") || projection.some((n, i) => Math.fround(n) !== state.projection[i])) return false;
    for (let i = 0; i < mesh.partCount * 12; i++) if (this.partScratch[i] !== this.alphaQueueParts[i]) return false;
    return true;
  }
  _startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    this.alphaQueueParts.set(this.partScratch.subarray(0, mesh.partCount * 12));
    this.alphaQueueState = { mesh, projection: Float32Array.from(projection), clip, stencilRef, depthTest, depthFunc, indexVariant, runs: runs.slice(), runKey: runs.join(",") };
  }
  _flushAlphaQueue(reason) {
    if (!this.alphaQueueCount) return;
    const state = this.alphaQueueState, mesh = state.mesh, parts = this.alphaQueueParts.subarray(0, mesh.partCount * 12);
    const indexBufferVariant = state.indexVariant === null ? null : mesh.indexVariants.get(state.indexVariant) ?? mesh.expressionIndices.get(state.indexVariant);
    const projection = state.projection, clip = state.clip, pipeline = this._pipeline(mesh, clip.count > 0), uniforms = { u_projection: projection };
    this.planes.fill(0);
    if (clip.values) this.planes.set(clip.values);
    if (clip.count) Object.assign(uniforms, { "u_planes[0]": this.planes, u_planeCount: clip.count });
    if (mesh.partCount > 1) uniforms["u_parts[0]"] = parts;
    const instances = this.alphaQueueCount;
    this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, instances * 16));
    this.metrics.instanceBytesUploaded += instances * 64;
    for (let run = 0; run < state.runs.length; run += 3) {
      this.device.draw({
        pipeline,
        buffer: mesh.buffer,
        indexBuffer: indexBufferVariant?.indexBuffer ?? mesh.indexBuffer,
        first: state.runs[run],
        count: state.runs[run + 1],
        instanceBuffer: this.instanceBuffer,
        instances,
        uniforms,
        depth: { test: state.depthTest, write: state.runs[run + 2], func: state.depthFunc },
        stencil: state.stencilRef === null ? false : { func: "equal", ref: state.stencilRef, mask: 255, writeMask: 0, pass: "keep" }
      });
      this.metrics.draws++;
      this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
      this.metrics.alphaRunSafeRunDraws++;
      if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
    }
    this.metrics.instances += instances;
    if (instances > 1) {
      this.metrics.alphaRunSafeBatches++;
      this.metrics.alphaRunBatchedInstances += instances;
      this.metrics.alphaRunDrawsSaved += (instances - 1) * (state.runs.length / 3);
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
    color: color2 = WHITE2,
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
    if (!this.meshes.has(mesh)) throw new TypeError("Mesh owned by this renderer required");
    if (indexVariant !== null && (typeof indexVariant !== "string" || !mesh.expressionIndices.has(indexVariant) && !mesh.indexVariants.has(indexVariant))) {
      throw new TypeError("Known mesh index variant required");
    }
    if (!this.device.active) throw new Error("beginFrame required");
    if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) throw new RangeError("stencilRef must be null or in [0,255]");
    if (stencilRef !== null && !this.device.activeStencilAvailable) throw new Error("A stencil-tested mesh requires an active stencil attachment");
    if (!Number.isSafeInteger(count) || count < 1 || !matrices || matrices.length !== count * 6) throw new TypeError("Packed mesh instance matrices required");
    for (let i = 0; i < matrices.length; i++) if (!Number.isFinite(matrices[i])) throw new TypeError("Mesh matrix values must be finite");
    const worldMode = viewProjection !== void 0 || worldMatrix !== void 0;
    if (worldMode) {
      if (projection !== void 0 || viewProjection === void 0 || worldMatrix === void 0) throw new TypeError("3D mesh draws require viewProjection and worldMatrix and cannot include projection");
      finiteArray2(viewProjection, 16, "viewProjection");
      affineMatrix4(worldMatrix, "worldMatrix");
    } else finiteArray2(projection, 9, "projection");
    finiteArray2(morph, 2, "morph");
    finiteArray2(color2, 4, "color");
    let strokeSize = null, inverseStrokeProjection = null, inverseViewProjection = null;
    if (mesh.hasNonScalingStroke) {
      if (strokeViewport === null) {
        if (this.device.activeRenderTarget) throw new Error("A strokeViewport is required for non-scaling strokes rendered to a render target");
        strokeSize = [this.device.canvas.clientWidth, this.device.canvas.clientHeight];
      } else {
        finiteArray2(strokeViewport, 2, "strokeViewport");
        strokeSize = [strokeViewport[0], strokeViewport[1]];
      }
      if (strokeSize.some((value) => !Number.isFinite(value) || value <= 0)) throw new RangeError("Non-scaling strokes require a positive CSS-pixel viewport size");
      if (!worldMode) inverseStrokeProjection = invertProjection(projection);
      else if (clipState(clips, this.maxPlanes).count) inverseViewProjection = invertMatrix4(viewProjection);
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color2.some((n) => n < 0 || n > 1)) throw new RangeError("RGBA/alpha in [0,1] required");
    if (!Number.isFinite(depth) || depth < -1 || depth > 1) throw new RangeError("depth must be in [-1,1]");
    if (typeof depthTest !== "boolean" || typeof depthWrite !== "boolean") throw new TypeError("depthTest and depthWrite must be booleans");
    if (depthWriteAlphaThreshold !== null && (!Number.isFinite(depthWriteAlphaThreshold) || depthWriteAlphaThreshold < 0 || depthWriteAlphaThreshold > 1)) {
      throw new RangeError("depthWriteAlphaThreshold must be in [0,1]");
    }
    if (worldMode && depthWriteAlphaThreshold !== null) throw new TypeError("depthWriteAlphaThreshold is currently supported only for 2D mesh draws");
    if (!["never", "less", "equal", "lequal", "greater", "notequal", "gequal", "always"].includes(depthFunc)) throw new TypeError("Unsupported depthFunc");
    if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > count || !Number.isSafeInteger(forceColorPrefixCount) || forceColorPrefixCount < 0 || forceColorPrefixCount > count) throw new RangeError("Instance color prefix count is invalid");
    if (prefixCount && !prefixColor) throw new TypeError("A prefix color is required for colored mesh instances");
    if (prefixColor !== null) {
      finiteArray2(prefixColor, 4, "prefix color");
      if (prefixColor.some((n) => n < 0 || n > 1)) throw new RangeError("RGBA channels must be in [0,1]");
    }
    if (worldMode && (prefixCount || forceColorPrefixCount)) throw new TypeError("Per-instance color prefixes are not supported for 3D mesh draws");
    if (indexRange !== null && (indexVariant !== null || !Array.isArray(indexRange) || indexRange.length !== 2 || !Number.isSafeInteger(indexRange[0]) || !Number.isSafeInteger(indexRange[1]) || indexRange[0] < 0 || indexRange[1] < 0 || indexRange[0] % 3 || indexRange[1] % 3)) {
      throw new TypeError("indexRange must be [firstIndex, triangleAlignedCount] and cannot be combined with indexVariant");
    }
    if (indexRange !== null && depthWriteAlphaThreshold !== null) throw new TypeError("indexRange is currently supported only for ordinary ordered mesh draws");
    const clip = clipState(clips, this.maxPlanes), pending = this.pending;
    const variant = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    const firstIndex = indexRange?.[0] ?? 0, indexCount = indexRange?.[1] ?? variant?.count ?? mesh.count;
    if (firstIndex + indexCount > (variant?.count ?? mesh.count)) throw new RangeError("indexRange exceeds the selected mesh index data");
    packParts(parts, mesh.partCount, this.partScratch);
    for (let i = 0; i < mesh.partCount; i++) if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) throw new RangeError("combined mesh and part depth must be in [-1,1]");
    const depthStateKey = Number(depthTest) + ":" + Number(depthWrite) + ":" + depthFunc;
    const alphaDepthWrite = depthWrite && depthWriteAlphaThreshold !== null;
    if (!alphaDepthWrite) {
      if (this.alphaQueueCount) this._flushAlphaQueue("alphaBoundary");
      if (pending) {
        const matrix = worldMode ? viewProjection : projection;
        const previousColor = pending.color;
        const reason = pending.mesh !== mesh ? "mesh" : pending.worldMode !== worldMode ? "transformMode" : pending.indexVariant !== indexVariant ? "indexVariant" : pending.firstIndex !== firstIndex || pending.indexCount !== indexCount ? "indexRange" : pending.clip.key !== clip.key ? "clip" : pending.stencilRef !== stencilRef ? "stencil" : pending.depthStateKey !== depthStateKey ? "depthState" : matrix.some((n, i) => Math.fround(n) !== pending.projection[i]) ? "projection" : strokeSize && strokeSize.some((n, i) => n !== pending.strokeSize?.[i]) ? "strokeViewport" : worldMode && color2.some((n, i) => n !== previousColor[i]) ? "color" : mesh.partCount > 1 && pending.parts.some((n, i) => n !== this.partScratch[i]) ? "parts" : this.count === this.maxInstances ? "capacity" : null;
        if (reason) this.flush(reason);
      }
      if (variant?.count === 0) return;
      const part2 = this.partScratch, singlePart2 = mesh.partCount === 1;
      for (let i = 0; i < count; i++) {
        if (this.count === this.maxInstances) this.flush("capacity");
        if (!this.pending) this.pending = {
          mesh,
          projection: Float32Array.from(worldMode ? viewProjection : projection),
          worldMode,
          color: Float32Array.from(color2),
          clip,
          stencilRef,
          depthStateKey,
          indexVariant,
          firstIndex,
          indexCount,
          strokeSize,
          inverseStrokeProjection,
          inverseViewProjection,
          depthState: { test: depthTest, write: depthWrite, func: depthFunc },
          parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0)
        };
        const offset = i * 6;
        let m0 = matrices[offset], m1 = matrices[offset + 1], m2 = matrices[offset + 2], m3 = matrices[offset + 3], m4 = matrices[offset + 4], m5 = matrices[offset + 5];
        let weight0 = morph[0], weight1 = morph[1], instanceAlpha = alpha;
        if (singlePart2) {
          const a = m0, b = m1, c = m2, d = m3;
          m0 = a * part2[0] + c * part2[4];
          m1 = b * part2[0] + d * part2[4];
          m2 = a * part2[1] + c * part2[5];
          m3 = b * part2[1] + d * part2[5];
          m4 = a * part2[2] + c * part2[6] + m4;
          m5 = b * part2[2] + d * part2[6] + m5;
          instanceAlpha *= part2[10];
          weight0 += part2[8];
          weight1 += part2[9];
        }
        const instanceColor = i < prefixCount ? prefixColor : color2;
        const instanceForceColor = i < forceColorPrefixCount ? true : forceColor, at = this.count++ * 16, data = this.instances;
        const instanceDepth = depth + (singlePart2 ? part2[11] : 0);
        if (worldMode) {
          data[at] = worldMatrix[0] * m0 + worldMatrix[4] * m1;
          data[at + 1] = worldMatrix[0] * m2 + worldMatrix[4] * m3;
          data[at + 2] = worldMatrix[0] * m4 + worldMatrix[4] * m5 + worldMatrix[12];
          data[at + 3] = instanceAlpha;
          data[at + 4] = worldMatrix[1] * m0 + worldMatrix[5] * m1;
          data[at + 5] = worldMatrix[1] * m2 + worldMatrix[5] * m3;
          data[at + 6] = worldMatrix[1] * m4 + worldMatrix[5] * m5 + worldMatrix[13];
          data[at + 7] = instanceForceColor ? 1 : 0;
          data[at + 8] = worldMatrix[2] * m0 + worldMatrix[6] * m1;
          data[at + 9] = worldMatrix[2] * m2 + worldMatrix[6] * m3;
          data[at + 10] = worldMatrix[2] * m4 + worldMatrix[6] * m5 + worldMatrix[14];
          data[at + 11] = whiteFlash ? 1 : 0;
          data[at + 12] = weight0;
          data[at + 13] = weight1;
          data[at + 14] = 0;
          data[at + 15] = instanceDepth;
        } else {
          data[at] = m0;
          data[at + 1] = m2;
          data[at + 2] = m4;
          data[at + 3] = instanceAlpha;
          data[at + 4] = m1;
          data[at + 5] = m3;
          data[at + 6] = m5;
          data[at + 7] = instanceForceColor ? 1 : 0;
          data[at + 8] = instanceColor[0];
          data[at + 9] = instanceColor[1];
          data[at + 10] = instanceColor[2];
          data[at + 11] = instanceColor[3];
          data[at + 12] = weight0;
          data[at + 13] = weight1;
          data[at + 14] = whiteFlash ? 1 : 0;
          data[at + 15] = instanceDepth;
        }
      }
      return;
    }
    if (variant?.count === 0) return;
    const indices = variant?.indices ?? mesh.indices;
    const triangleCount = (variant?.count ?? mesh.count) / 3;
    const part = this.partScratch, singlePart = mesh.partCount === 1;
    const writeAlphaInstance = (i, slot) => {
      const offset = i * 6;
      let m0 = matrices[offset], m1 = matrices[offset + 1], m2 = matrices[offset + 2], m3 = matrices[offset + 3], m4 = matrices[offset + 4], m5 = matrices[offset + 5];
      let weight0 = morph[0], weight1 = morph[1], instanceAlpha = alpha;
      if (singlePart) {
        const a = m0, b = m1, c = m2, d = m3;
        m0 = a * part[0] + c * part[4];
        m1 = b * part[0] + d * part[4];
        m2 = a * part[1] + c * part[5];
        m3 = b * part[1] + d * part[5];
        m4 = a * part[2] + c * part[6] + m4;
        m5 = b * part[2] + d * part[6] + m5;
        instanceAlpha *= part[10];
        weight0 += part[8];
        weight1 += part[9];
      }
      const instanceColor = i < prefixCount ? prefixColor : color2;
      const instanceForceColor = i < forceColorPrefixCount ? true : forceColor, at = slot * 16, data = this.instances;
      data[at] = m0;
      data[at + 1] = m2;
      data[at + 2] = m4;
      data[at + 3] = instanceAlpha;
      data[at + 4] = m1;
      data[at + 5] = m3;
      data[at + 6] = m5;
      data[at + 7] = instanceForceColor ? 1 : 0;
      data[at + 8] = instanceColor[0];
      data[at + 9] = instanceColor[1];
      data[at + 10] = instanceColor[2];
      data[at + 11] = instanceColor[3];
      data[at + 12] = weight0;
      data[at + 13] = weight1;
      data[at + 14] = whiteFlash ? 1 : 0;
      data[at + 15] = depth + (singlePart ? part[11] : 0);
    };
    for (let i = 0; i < count; i++) {
      const instanceColor = i < prefixCount ? prefixColor : color2;
      const instanceForceColor = i < forceColorPrefixCount ? true : forceColor;
      const runs = this._collectAlphaDepthRuns(
        mesh,
        indices,
        triangleCount,
        depthWriteAlphaThreshold,
        alpha * instanceColor[3],
        instanceForceColor,
        indexVariant
      );
      const totalVertices = triangleCount * 3;
      const oneRun = runs.length === 3 && runs[0] === 0 && runs[1] === totalVertices;
      if (!oneRun) {
        const bounds = this.safeAlphaRunBatching && this.instanced ? this._screenBounds(mesh, matrices, i, projection, morph) : null;
        if (bounds) {
          if (this.count) this.flush("alphaDepthBoundary");
          if (this.alphaQueueCount && !this._alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs)) {
            this.metrics.alphaRunSignatureBoundaries++;
            this._flushAlphaQueue("alphaSignature");
          }
          if (this.alphaQueueCount && this._boundsOverlap(bounds, this.alphaQueueBounds)) {
            this.metrics.alphaRunOverlapBoundaries++;
            this._flushAlphaQueue("alphaOverlap");
          }
          if (this.alphaQueueCount === this.maxInstances) this._flushAlphaQueue("capacity");
          if (!this.alphaQueueCount) this._startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs);
          this._extendAlphaQueueBounds(bounds);
          const slot = this.alphaQueueCount;
          writeAlphaInstance(i, slot);
          this.alphaQueueCount++;
          continue;
        }
        if (this.safeAlphaRunBatching) this.metrics.alphaRunUnbatchableBounds++;
        if (this.alphaQueueCount) this._flushAlphaQueue("alphaUnsupportedBoundary");
        if (this.count) this.flush("alphaImmediateBoundary");
        writeAlphaInstance(i, 0);
        this._drawAlphaDepthRuns(mesh, variant, projection, clip, part.subarray(0, mesh.partCount * 12), runs, depthTest, depthFunc, strokeSize, inverseStrokeProjection, stencilRef);
        this.metrics.alphaRunImmediateInstances++;
        this.metrics.alphaRunImmediateRunDraws += runs.length / 3;
        continue;
      }
      if (this.alphaQueueCount) this._flushAlphaQueue("singleRunBoundary");
      const write = runs[2], stateKey = Number(depthTest) + ":" + Number(write) + ":" + depthFunc;
      if (this.pending) {
        const current = this.pending, reason = current.mesh !== mesh ? "mesh" : current.worldMode ? "transformMode" : current.indexVariant !== indexVariant ? "indexVariant" : current.firstIndex !== firstIndex || current.indexCount !== indexCount ? "indexRange" : current.clip.key !== clip.key ? "clip" : current.stencilRef !== stencilRef ? "stencil" : current.depthStateKey !== stateKey ? "depthState" : projection.some((n, j) => Math.fround(n) !== current.projection[j]) ? "projection" : strokeSize && strokeSize.some((n, j) => n !== current.strokeSize?.[j]) ? "strokeViewport" : mesh.partCount > 1 && current.parts.some((n, j) => n !== this.partScratch[j]) ? "parts" : this.count === this.maxInstances ? "capacity" : null;
        if (reason) this.flush(reason);
      }
      if (!this.pending) this.pending = {
        mesh,
        projection: Float32Array.from(projection),
        worldMode: false,
        clip,
        stencilRef,
        depthStateKey: stateKey,
        indexVariant,
        firstIndex,
        indexCount,
        strokeSize,
        inverseStrokeProjection,
        inverseViewProjection,
        depthState: { test: depthTest, write, func: depthFunc },
        parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0)
      };
      const offset = i * 6;
      let m0 = matrices[offset], m1 = matrices[offset + 1], m2 = matrices[offset + 2], m3 = matrices[offset + 3], m4 = matrices[offset + 4], m5 = matrices[offset + 5];
      let weight0 = morph[0], weight1 = morph[1], instanceAlpha = alpha;
      if (singlePart) {
        const a = m0, b = m1, c = m2, d = m3;
        m0 = a * part[0] + c * part[4];
        m1 = b * part[0] + d * part[4];
        m2 = a * part[1] + c * part[5];
        m3 = b * part[1] + d * part[5];
        m4 = a * part[2] + c * part[6] + m4;
        m5 = b * part[2] + d * part[6] + m5;
        instanceAlpha *= part[10];
        weight0 += part[8];
        weight1 += part[9];
      }
      const at = this.count++ * 16, data = this.instances;
      data[at] = m0;
      data[at + 1] = m2;
      data[at + 2] = m4;
      data[at + 3] = instanceAlpha;
      data[at + 4] = m1;
      data[at + 5] = m3;
      data[at + 6] = m5;
      data[at + 7] = instanceForceColor ? 1 : 0;
      data[at + 8] = instanceColor[0];
      data[at + 9] = instanceColor[1];
      data[at + 10] = instanceColor[2];
      data[at + 11] = instanceColor[3];
      data[at + 12] = weight0;
      data[at + 13] = weight1;
      data[at + 14] = whiteFlash ? 1 : 0;
      data[at + 15] = depth + (singlePart ? part[11] : 0);
    }
  }
  _collectAlphaDepthRuns(mesh, indices, triangleCount, threshold, opacity, forceColor, indexVariant) {
    let cache = this.alphaRunCache.get(mesh);
    if (!cache) {
      cache = /* @__PURE__ */ new Map();
      this.alphaRunCache.set(mesh, cache);
    }
    const partOpacities = [];
    for (let i = 0; i < mesh.partCount; i++) partOpacities.push(this.partScratch[i * 12 + 10]);
    const key = JSON.stringify([indexVariant, threshold, opacity, forceColor, partOpacities]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      this.metrics.alphaRunCacheHits++;
      return cached;
    }
    this.metrics.alphaRunCacheMisses++;
    const runs = this.alphaRunScratch;
    runs.length = 0;
    if (opacity < threshold) {
      runs.push(0, triangleCount * 3, false);
    } else {
      let runStart = 0, runWrite = null;
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        let write = true;
        for (let corner = 0; corner < 3; corner++) {
          const indexOffset = triangle * 3 + corner, vertexOffset = (indices ? indices[indexOffset] : indexOffset) * mesh.strideFloats;
          const partIndex = mesh.vertices[vertexOffset + 10];
          const vertexAlpha = forceColor ? 1 : mesh.vertices[vertexOffset + 5];
          const effectiveAlpha = opacity * vertexAlpha * this.partScratch[partIndex * 12 + 10];
          if (effectiveAlpha <= 0 || effectiveAlpha < threshold) {
            write = false;
            break;
          }
        }
        if (runWrite === null) {
          runStart = triangle;
          runWrite = write;
        } else if (write !== runWrite) {
          runs.push(runStart * 3, (triangle - runStart) * 3, runWrite);
          runStart = triangle;
          runWrite = write;
        }
      }
      if (runWrite !== null) runs.push(runStart * 3, (triangleCount - runStart) * 3, runWrite);
    }
    if (runs.length <= 64) {
      const stableRuns = runs.slice();
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, stableRuns);
      return stableRuns;
    }
    this.alphaRunScratch = [];
    return runs;
  }
  _drawAlphaDepthRuns(mesh, variant, projection, clip, parts, runs, depthTest, depthFunc, strokeSize, inverseStrokeProjection, stencilRef) {
    this.planes.fill(0);
    if (clip.values) this.planes.set(clip.values);
    const pipeline = this._pipeline(mesh, clip.count > 0), uniforms = { u_projection: projection };
    if (clip.count) Object.assign(uniforms, { "u_planes[0]": this.planes, u_planeCount: clip.count });
    if (mesh.hasNonScalingStroke) Object.assign(uniforms, { u_strokeViewportSize: strokeSize, ...clip.count ? { u_inverseProjection: inverseStrokeProjection } : {} });
    if (mesh.partCount > 1) uniforms["u_parts[0]"] = parts;
    if (!this.instanced) {
      for (let j = 0; j < 4; j++) uniforms[["i_row0", "i_row1", "i_color", "i_params"][j]] = this.instances.subarray(j * 4, j * 4 + 4);
    } else {
      const instance = this.instances.subarray(0, 16);
      this.device.uploadVertices(this.instanceBuffer, instance);
      this.metrics.instanceBytesUploaded += instance.byteLength;
    }
    const indexBuffer = variant?.indexBuffer ?? mesh.indexBuffer;
    for (let run = 0; run < runs.length; run += 3) {
      this.device.draw({
        pipeline,
        buffer: mesh.buffer,
        indexBuffer,
        first: runs[run],
        count: runs[run + 1],
        instanceBuffer: this.instanceBuffer,
        instances: 1,
        uniforms,
        depth: { test: depthTest, write: runs[run + 2], func: depthFunc },
        stencil: stencilRef === null ? false : { func: "equal", ref: stencilRef, mask: 255, writeMask: 0, pass: "keep" }
      });
      this.metrics.draws++;
      this.metrics.drawDispatchReasons.alphaImmediateRun = (this.metrics.drawDispatchReasons.alphaImmediateRun ?? 0) + 1;
      if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
    }
    this.metrics.instances++;
  }
  flush(reason = "explicit") {
    if (this.alphaQueueCount) this._flushAlphaQueue(reason);
    if (!this.count) return;
    this._ready();
    const { mesh, projection, worldMode, color: color2, clip, parts, depthState, indexVariant, firstIndex, indexCount, strokeSize, inverseStrokeProjection, inverseViewProjection, stencilRef } = this.pending;
    const variant = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    this.planes.fill(0);
    if (clip.values) this.planes.set(clip.values);
    const pipeline = this._pipeline(mesh, clip.count > 0, worldMode), uniforms = worldMode ? { u_viewProjection: projection, u_color: color2 } : { u_projection: projection };
    if (clip.count) Object.assign(uniforms, { "u_planes[0]": this.planes, u_planeCount: clip.count });
    if (mesh.hasNonScalingStroke) Object.assign(uniforms, { u_strokeViewportSize: strokeSize, ...clip.count ? worldMode ? { u_inverseViewProjection: inverseViewProjection } : { u_inverseProjection: inverseStrokeProjection } : {} });
    if (mesh.partCount > 1) uniforms["u_parts[0]"] = parts;
    const instanceUniforms = worldMode ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"];
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, this.count * 16));
      this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer: variant?.indexBuffer ?? mesh.indexBuffer, first: firstIndex, count: indexCount, instanceBuffer: this.instanceBuffer, instances: this.count, uniforms, depth: depthState, stencil: stencilRef === null ? false : { func: "equal", ref: stencilRef, mask: 255, writeMask: 0, pass: "keep" } });
      this.metrics.instanceBytesUploaded += this.count * 64;
      this.metrics.draws++;
      this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
      if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < 4; j++) uniforms[instanceUniforms[j]] = this.instances.subarray(i * 16 + j * 4, i * 16 + j * 4 + 4);
        this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer: variant?.indexBuffer ?? mesh.indexBuffer, first: firstIndex, count: indexCount, uniforms, depth: depthState, stencil: stencilRef === null ? false : { func: "equal", ref: stencilRef, mask: 255, writeMask: 0, pass: "keep" } });
        this.metrics.draws++;
        this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
        if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
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
    if (this.state !== "ready" || this.disposed) throw new Error(`MeshRenderer is ${this.state}${this.failure ? ": " + this.failure : ""}`);
  }
  beginFrame() {
    this.discard();
    for (const key of Object.keys(this.metrics)) if (key !== "flushReasons" && key !== "drawDispatchReasons") this.metrics[key] = 0;
    this.metrics.flushReasons = /* @__PURE__ */ Object.create(null);
    this.metrics.drawDispatchReasons = /* @__PURE__ */ Object.create(null);
  }
  stats() {
    return { ...this.metrics, flushReasons: { ...this.metrics.flushReasons }, drawDispatchReasons: { ...this.metrics.drawDispatchReasons }, pendingAlphaRunInstances: this.alphaQueueCount, safeAlphaRunBatching: this.safeAlphaRunBatching, state: this.state, failure: this.failure, pipelineCount: this.pipelines.size, meshCount: this.meshes.size, retainedBytes: this.bytes, stagingBytes: this.instances.byteLength + this.planes.byteLength + this.partScratch.byteLength, instanced: this.instanced, maxClipPlanes: this.maxPlanes };
  }
  dispose() {
    if (this.disposed) return;
    this.discard();
    this.device.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const mesh of this.meshes) {
      this.device.deleteVertexBuffer(mesh.buffer);
      if (mesh.indexBuffer) this.device.deleteIndexBuffer(mesh.indexBuffer);
      for (const variant of mesh.expressionIndices.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
      for (const variant of mesh.indexVariants.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    }
    this.meshes.clear();
    this.bytes = 0;
    this.alphaRunCache = /* @__PURE__ */ new WeakMap();
    this.alphaRunScratch.length = 0;
    if (this.instanceBuffer) this.device.deleteVertexBuffer(this.instanceBuffer);
    for (const pipeline of this.pipelines.values()) this.device.deletePipeline(pipeline);
    this.pipelines.clear();
    this.disposed = true;
    this.state = "disposed";
  }
};

// modules/rendering/vector-context.js
var TAU = Math.PI * 2;
var MAX_LINEAR_GRADIENT_STOPS = 32;
var LINEAR_GRADIENT_SIZE = 1024;
var MAX_GRADIENT_TEXTURES = 64;
var SILHOUETTE_OFFSETS = Object.freeze(Array.from({ length: 8 }, (_, i) => Object.freeze([Math.cos(i * TAU / 8), Math.sin(i * TAU / 8)])));
var IDENTITY3 = Object.freeze([1, 0, 0, 1, 0, 0]);
var WHITE3 = Object.freeze([1, 1, 1, 1]);
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
function finite2(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function normalizeColor(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== 4) throw new TypeError("RGBA paint must have four channels");
    const out = Array.from(value);
    if (out.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError("RGBA channels must be in [0,1]");
    return out;
  }
  let text = String(value ?? "black").trim().toLowerCase();
  text = NAMED[text] ?? text;
  if (text === "currentcolor" && typeof getComputedStyle === "function") text = getComputedStyle(document.documentElement).color;
  if (text[0] === "#") {
    let hex = text.slice(1);
    if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) throw new TypeError(`Invalid CSS color: ${value}`);
    if (hex.length < 5) hex = [...hex].map((c) => c + c).join("");
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
  }
  const rgb = text.match(/^rgba?\((.*)\)$/);
  if (rgb) {
    const fields = rgb[1].trim().replace(/\s*\/\s*/, " ").split(/[\s,]+/).filter(Boolean);
    if (fields.length < 3 || fields.length > 4) throw new TypeError(`Invalid CSS color: ${value}`);
    const channel = (s) => clamp(s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s) / 255);
    const alpha = fields[3] === void 0 ? 1 : clamp(fields[3].endsWith("%") ? parseFloat(fields[3]) / 100 : parseFloat(fields[3]));
    const out = [...fields.slice(0, 3).map(channel), alpha];
    if (out.some(Number.isNaN)) throw new TypeError(`Invalid CSS color: ${value}`);
    return out;
  }
  const hsl = text.match(/^hsla?\((.*)\)$/);
  if (hsl) {
    const fields = hsl[1].trim().replace(/\s*\/\s*/, " ").split(/[\s,]+/).filter(Boolean);
    if (fields.length < 3 || fields.length > 4) throw new TypeError(`Invalid CSS color: ${value}`);
    const h = (parseFloat(fields[0]) % 360 + 360) % 360 / 360, s = clamp(parseFloat(fields[1]) / 100), l = clamp(parseFloat(fields[2]) / 100), a = fields[3] === void 0 ? 1 : clamp(fields[3].endsWith("%") ? parseFloat(fields[3]) / 100 : parseFloat(fields[3]));
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4), a];
  }
  if (typeof document !== "undefined" && document.createElement && document.body) {
    const probe = document.createElement("span");
    probe.style.color = "";
    probe.style.color = text;
    if (probe.style.color) {
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      if (resolved !== text) return normalizeColor(resolved);
    }
  }
  throw new TypeError(`Unsupported CSS color: ${value}`);
}
function transformed(matrix, x, y) {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}
function invert(matrix) {
  const d = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(d) < 1e-15) return null;
  return [matrix[3] / d, -matrix[1] / d, -matrix[2] / d, matrix[0] / d, (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / d, (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / d];
}
var RadialGradient = class {
  constructor(matrix, x0, y0, r0, x1, y1, r1) {
    for (const [n, v] of Object.entries({ x0, y0, r0, x1, y1, r1 })) finite2(v, n);
    if (r0 < 0 || r1 < 0) throw new RangeError("Gradient radii must be non-negative");
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
    if (!Number.isFinite(offset) || offset < 0 || offset > 1) throw new RangeError("Invalid gradient stop");
    this.stops.push({ offset, color: normalizeColor(value) });
    this.stops.sort((a, b) => a.offset - b.offset);
    this.pixels = null;
    this.revision++;
  }
  raster() {
    if (this.pixels) return this.pixels;
    const data = new Uint8Array(256 * 4), stops = this.stops.length ? this.stops : [{ offset: 0, color: [0, 0, 0, 0] }];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = stops[0], hi = stops.at(-1);
      for (let j = 1; j < stops.length; j++) if (t < stops[j].offset) {
        lo = stops[j - 1];
        hi = stops[j];
        break;
      }
      const q = clamp((t - lo.offset) / (hi.offset - lo.offset || 1)), alpha = lo.color[3] + (hi.color[3] - lo.color[3]) * q;
      for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * q) * alpha * 255);
      data[i * 4 + 3] = Math.round(alpha * 255);
    }
    this.pixels = data;
    return data;
  }
};
var LinearGradient = class {
  constructor(matrix, x0, y0, x1, y1) {
    for (const [name, value] of Object.entries({ x0, y0, x1, y1 })) finite2(value, name);
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
    if (!Number.isFinite(offset) || offset < 0 || offset > 1) throw new RangeError("Invalid gradient stop");
    if (this.stops.length >= MAX_LINEAR_GRADIENT_STOPS) throw new RangeError(`Linear gradients support at most ${MAX_LINEAR_GRADIENT_STOPS} color stops`);
    const stop = { offset, color: normalizeColor(value), order: this.stops.length };
    this.stops.push(stop);
    this.stops.sort((a, b) => a.offset - b.offset || a.order - b.order);
    this.pixels = null;
    this.revision++;
  }
  raster() {
    if (this.pixels) return this.pixels;
    const data = new Uint8Array(LINEAR_GRADIENT_SIZE * 4), stops = this.stops;
    for (let i = 0; i < LINEAR_GRADIENT_SIZE; i++) {
      const t = i / (LINEAR_GRADIENT_SIZE - 1);
      let lo, hi, q;
      if (!stops.length) {
        lo = hi = { color: [0, 0, 0, 0] };
        q = 0;
      } else if (stops.length === 1 || t < stops[0].offset) {
        lo = hi = stops[0];
        q = 0;
      } else {
        let next = 0;
        while (next < stops.length && t >= stops[next].offset) next++;
        if (next === stops.length) {
          lo = hi = stops.at(-1);
          q = 0;
        } else {
          lo = stops[next - 1];
          hi = stops[next];
          q = (t - lo.offset) / (hi.offset - lo.offset);
        }
      }
      const alpha = lo.color[3] + (hi.color[3] - lo.color[3]) * q, at = i * 4;
      for (let k = 0; k < 3; k++) data[at + k] = Math.round((lo.color[k] + (hi.color[k] - lo.color[k]) * q) * alpha * 255);
      data[at + 3] = Math.round(alpha * 255);
    }
    this.pixels = data;
    return data;
  }
};
var VectorContext = class {
  constructor(device, { vectorRenderer = null, glyphAtlas = vectorRenderer?.glyphAtlas ?? null, initialVertices = 4096, maxVertices = 262144, onError = null, safeAlphaRunBatching = true } = {}) {
    if (!device?.beginFrame || !device?.endFrame || !device?.createVertexBuffer) throw new TypeError("WebGLDevice is required");
    if (vectorRenderer && vectorRenderer.device !== device) throw new TypeError("vectorRenderer must use the supplied WebGLDevice");
    this.device = device;
    this.canvas = device.canvas;
    this.vector = vectorRenderer ?? new VectorRenderer(device, { initialVertices, maxVertices, glyphAtlas });
    this.ownsVector = !vectorRenderer;
    this.glyphAtlas = glyphAtlas ?? this.vector.glyphAtlas;
    this.onError = typeof onError === "function" ? onError : null;
    if (typeof safeAlphaRunBatching !== "boolean") throw new TypeError("safeAlphaRunBatching must be a boolean");
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    this.meshRenderer = null;
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
      if (this.state === "disposed") return;
      try {
        for (const mesh of this.staticMeshes) this.device.uploadVertices(mesh.buffer, mesh.vertices);
        this.state = "ready";
      } catch (error) {
        this.state = "failed";
        this.onError?.(error, { phase: "restore" });
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
    this.total = { frames: 0, drawCalls: 0, vertices: 0, uploadedBytes: 0 };
  }
  get globalAlpha() {
    return this._globalAlpha;
  }
  set globalAlpha(v) {
    finite2(v, "globalAlpha");
    this._globalAlpha = clamp(v);
  }
  get fillStyle() {
    return this._fillStyle;
  }
  set fillStyle(v) {
    if (!(v instanceof RadialGradient) && !(v instanceof LinearGradient)) normalizeColor(v);
    this._fillStyle = v;
  }
  get strokeStyle() {
    return this._strokeStyle;
  }
  set strokeStyle(v) {
    if (!(v instanceof RadialGradient) && !(v instanceof LinearGradient)) normalizeColor(v);
    this._strokeStyle = v;
  }
  get lineWidth() {
    return this._lineWidth;
  }
  set lineWidth(v) {
    finite2(v, "lineWidth");
    if (v >= 0) this._lineWidth = v;
  }
  get lineCap() {
    return this._lineCap;
  }
  set lineCap(v) {
    if (["butt", "round", "square"].includes(v)) this._lineCap = v;
  }
  get lineJoin() {
    return this._lineJoin;
  }
  set lineJoin(v) {
    if (["round", "bevel", "miter"].includes(v)) this._lineJoin = v;
  }
  get miterLimit() {
    return this._miterLimit;
  }
  set miterLimit(v) {
    finite2(v, "miterLimit");
    if (v > 0) this._miterLimit = v;
  }
  get lineDashOffset() {
    return this._lineDashOffset;
  }
  set lineDashOffset(v) {
    finite2(v, "lineDashOffset");
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
    if (["start", "end", "left", "right", "center"].includes(v)) this._textAlign = v;
  }
  get textBaseline() {
    return this._textBaseline;
  }
  set textBaseline(v) {
    if (["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"].includes(v)) this._textBaseline = v;
  }
  get direction() {
    return this._direction;
  }
  set direction(v) {
    if (["ltr", "rtl", "inherit"].includes(v)) this._direction = v;
  }
  get filter() {
    return this._filter;
  }
  set filter(v) {
    if (v !== "none" && v !== "brightness(0) invert(1)") throw new RangeError("VectorContext supports only none and brightness(0) invert(1) filters");
    this._filter = v;
  }
  get stencilRef() {
    return this.vector.stencilDepth || null;
  }
  _frame() {
    if (!this.active || this.device.state !== "ready") throw new Error("VectorContext frame is unavailable");
  }
  _paint(style) {
    if (style instanceof RadialGradient || style instanceof LinearGradient) throw new TypeError("Gradient paint must be submitted through a vector fill or stroke");
    const color2 = normalizeColor(this.forceColor ?? style);
    color2[3] *= this._globalAlpha;
    if (this._filter === "brightness(0) invert(1)") color2[0] = color2[1] = color2[2] = 1;
    return color2;
  }
  _gradientPaint(gradient) {
    let cached = this.gradientTextures.get(gradient);
    if (!cached) {
      if (this.gradientTextures.size >= MAX_GRADIENT_TEXTURES) {
        const expired = [...this.gradientTextures].find(([, entry]) => entry.lastFrame < this.frame);
        if (!expired) throw new RangeError(`VectorContext supports at most ${MAX_GRADIENT_TEXTURES} distinct gradients in one frame`);
        this.device.deleteTexture(expired[1].texture);
        this.gradientTextures.delete(expired[0]);
      }
      const linear = gradient instanceof LinearGradient, width = linear ? LINEAR_GRADIENT_SIZE : 256, height = 1, data = gradient.raster();
      cached = { texture: this.device.createTexture({ width, height, data }, { format: "rgba", premultiplied: true, filter: "linear" }), revision: gradient.revision, lastFrame: this.frame, linear };
      this.gradientTextures.set(gradient, cached);
    } else if (cached.revision !== gradient.revision) {
      this.vector.flush();
      const linear = gradient instanceof LinearGradient, width = linear ? LINEAR_GRADIENT_SIZE : 256;
      this.device.updateTexture(cached.texture, { width, height: 1, data: gradient.raster() });
      cached.revision = gradient.revision;
      cached.linear = linear;
    }
    cached.lastFrame = this.frame;
    const matrixInverse = invert(gradient.matrix);
    if (!matrixInverse) throw new RangeError("Gradient transform is singular");
    const color2 = normalizeColor(this.forceColor ?? [1, 1, 1, 1]);
    color2[3] *= this._globalAlpha;
    if (gradient instanceof LinearGradient) return { texture: cached.texture, kind: "linear", gradient, x0: gradient.x0, y0: gradient.y0, x1: gradient.x1, y1: gradient.y1, matrixInverse, color: color2, whiteFlash: this._filter === "brightness(0) invert(1)" };
    const dx = gradient.x1 - gradient.x0, dy = gradient.y1 - gradient.y0, dr = gradient.r1 - gradient.r0, scale = Math.max(1, Math.hypot(dx, dy), Math.abs(gradient.r0), Math.abs(gradient.r1));
    return { texture: cached.texture, kind: "radial", gradient, x0: gradient.x0, y0: gradient.y0, radialScale: scale, radialParams: [dx / scale, dy / scale, gradient.r0 / scale, dr / scale], radialEmpty: dx === 0 && dy === 0 && dr === 0, matrixInverse, color: color2, whiteFlash: this._filter === "brightness(0) invert(1)" };
  }
  _releaseGradientTextures() {
    for (const [gradient, cached] of this.gradientTextures) {
      try {
        this.device.deleteTexture(cached.texture);
      } catch (error) {
        try {
          this.onError?.(error, { phase: "gradient-release" });
        } catch {
        }
      } finally {
        gradient.pixels = null;
      }
    }
    this.gradientTextures.clear();
  }
  beginFrame({ width = this.canvas.width, height = this.canvas.height, clearColor = [0, 0, 0, 0] } = {}) {
    if (this.active) throw new Error("endFrame is required before beginFrame");
    if (this.state === "lost" || this.device.state === "lost") return false;
    if (this.state !== "ready") throw new Error(`VectorContext is ${this.state}`);
    try {
      const ready = this.device.beginFrame({ width, height, clearColor });
      if (!ready) return false;
      this.active = true;
      this.meshRenderer?.beginFrame();
      this.frame++;
      this.pathCount = 0;
      this.vector.beginPath();
      return true;
    } catch (error) {
      this.onError?.(error, { phase: "beginFrame" });
      throw error;
    }
  }
  endFrame() {
    this._frame();
    try {
      this.flush("frameEnd");
      const stats = this.device.endFrame();
      this.active = false;
      for (const mesh of this.deferredMeshes.splice(0)) this.deleteStaticMesh(mesh);
      this.frameStats = { drawCalls: stats.drawCalls, vertices: stats.vertices, uploadedBytes: stats.bufferBytes ?? stats.uploadedBytes ?? 0, textureUploads: stats.textureUploads ?? 0, textureBytes: stats.textureBytes ?? 0, gpuRenderTargetBytes: stats.gpuRenderTargetBytes ?? 0, paths: this.pathCount };
      this.total.frames++;
      this.total.drawCalls += this.frameStats.drawCalls;
      this.total.vertices += this.frameStats.vertices;
      this.total.uploadedBytes += this.frameStats.uploadedBytes;
      return this.stats();
    } catch (error) {
      this.active = false;
      this.vector.count = 0;
      this.onError?.(error, { phase: "endFrame" });
      throw error;
    }
  }
  save() {
    this._frame();
    this.stack.push({ fillStyle: this._fillStyle, strokeStyle: this._strokeStyle, globalAlpha: this._globalAlpha, lineWidth: this._lineWidth, lineCap: this._lineCap, lineJoin: this._lineJoin, miterLimit: this._miterLimit, lineDash: this._lineDash.slice(), lineDashOffset: this._lineDashOffset, font: this._font, textAlign: this._textAlign, textBaseline: this._textBaseline, direction: this._direction, filter: this._filter, forceColor: this.forceColor });
    this.vector.save();
  }
  restore() {
    this._frame();
    const s = this.stack.pop();
    if (!s) return;
    this.meshRenderer?.flush("stateRestore");
    this.vector.restore();
    Object.assign(this, { _fillStyle: s.fillStyle, _strokeStyle: s.strokeStyle, _globalAlpha: s.globalAlpha, _lineWidth: s.lineWidth, _lineCap: s.lineCap, _lineJoin: s.lineJoin, _miterLimit: s.miterLimit, _lineDash: s.lineDash, _lineDashOffset: s.lineDashOffset, _font: s.font, _textAlign: s.textAlign, _textBaseline: s.textBaseline, _direction: s.direction, _filter: s.filter, forceColor: s.forceColor });
  }
  setTransform(a, b, c, d, e, f) {
    this.vector.setTransform(a, b, c, d, e, f);
  }
  resetTransform() {
    this.vector.setTransform(...IDENTITY3);
  }
  getTransform() {
    const m = this.vector.matrix;
    return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
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
  }
  moveTo(x, y) {
    this.vector.moveTo(x, y);
  }
  lineTo(x, y) {
    this.vector.lineTo(x, y);
  }
  closePath() {
    this.vector.closePath();
  }
  quadraticCurveTo(cx, cy, x, y) {
    this.vector.quadraticCurveTo(cx, cy, x, y);
  }
  bezierCurveTo(x1, y1, x2, y2, x, y) {
    this.vector.bezierCurveTo(x1, y1, x2, y2, x, y);
  }
  _arcPoints(x, y, rx, ry, rotation, start, end, ccw) {
    if (rx < 0 || ry < 0) throw new RangeError("ellipse radii must be non-negative");
    let sweep = end - start;
    if (!ccw) {
      if (sweep >= TAU) sweep = TAU;
      else while (sweep < 0) sweep += TAU;
    } else if (sweep <= -TAU) sweep = -TAU;
    else while (sweep > 0) sweep -= TAU;
    const m = this.vector.matrix, r = Math.max(rx, ry) * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])), step = r > 0.2 ? 2 * Math.acos(clamp(1 - 0.2 / r, -1, 1)) : Math.PI / 2, n = Math.max(1, Math.min(256, Math.ceil(Math.abs(sweep) / Math.max(0.01, step)))), c = Math.cos(rotation), s = Math.sin(rotation), out = [];
    for (let i = 0; i <= n; i++) {
      const a = start + sweep * i / n;
      out.push([x + Math.cos(a) * rx * c - Math.sin(a) * ry * s, y + Math.cos(a) * rx * s + Math.sin(a) * ry * c]);
    }
    return out;
  }
  arc(x, y, r, start, end, ccw = false) {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }
  ellipse(x, y, rx, ry, rotation = 0, start = 0, end = TAU, ccw = false) {
    const points = this._arcPoints(x, y, rx, ry, rotation, start, end, ccw);
    if (!this.vector.cursor) this.vector.moveTo(...points[0]);
    else this.vector.lineTo(...points[0]);
    for (let i = 1; i < points.length; i++) this.vector.lineTo(...points[i]);
  }
  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  roundRect(x, y, w, h, r = 0) {
    const radii = Array.isArray(r) ? r : [r, r, r, r];
    const max = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
    const q = radii.map((v) => clamp(Number(v) || 0, 0, max));
    this.moveTo(x + q[0], y);
    this.lineTo(x + w - q[1], y);
    this.arc(x + w - q[1], y + q[1], q[1], -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - q[2]);
    this.arc(x + w - q[2], y + h - q[2], q[2], 0, Math.PI / 2);
    this.lineTo(x + q[3], y + h);
    this.arc(x + q[3], y + h - q[3], q[3], Math.PI / 2, Math.PI);
    this.lineTo(x, y + q[0]);
    this.arc(x + q[0], y + q[0], q[0], Math.PI, Math.PI * 1.5);
    this.closePath();
  }
  _temporaryPath(callback) {
    const v = this.vector, saved = { path: v.path, cursor: v.cursor, subpath: v.subpath };
    try {
      callback();
    } finally {
      v.path = saved.path;
      v.cursor = saved.cursor;
      v.subpath = saved.subpath;
    }
  }
  fill(rule = "nonzero") {
    this._frame();
    this.meshRenderer?.flush("vectorBoundary");
    if (this._fillStyle instanceof RadialGradient) this.vector.fillRadialGradient({ ...this._gradientPaint(this._fillStyle), rule });
    else if (this._fillStyle instanceof LinearGradient) this.vector.fillLinearGradient({ ...this._gradientPaint(this._fillStyle), rule });
    else this.vector.fill(this._paint(this._fillStyle), rule);
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
    this.meshRenderer?.flush("vectorBoundary");
    if (!(this._lineWidth > 0)) return;
    const m = this.vector.matrix, width = this._lineWidth * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])), gradient = this._strokeStyle instanceof RadialGradient || this._strokeStyle instanceof LinearGradient ? this._gradientPaint(this._strokeStyle) : null, paint = gradient ? gradient.color : this._paint(this._strokeStyle), style = { lineCap: this._lineCap, lineJoin: this._lineJoin, miterLimit: this._miterLimit }, dash = this._lineDash, period = dash.reduce((a, b) => a + b, 0);
    if (!dash.length || !period) {
      this.vector.stroke(paint, width, style, gradient);
      return;
    }
    const v = this.vector, original = v.path, matrix = v.matrix.slice();
    v.beginPath();
    v.setTransform(...IDENTITY3);
    let phase = (this._lineDashOffset % period + period) % period, index = 0;
    while (phase >= dash[index] && dash[index] > 0) {
      phase -= dash[index];
      index = (index + 1) % dash.length;
    }
    let remaining = dash[index] - phase;
    for (const path of original) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      let at = 0;
      while (at < length - 1e-7) {
        if (remaining <= 1e-7) {
          index = (index + 1) % dash.length;
          remaining = dash[index];
          continue;
        }
        const stop = Math.min(length, at + remaining);
        if (index % 2 === 0) {
          v.moveTo(a.x + (b.x - a.x) * at / length, a.y + (b.y - a.y) * at / length);
          v.lineTo(a.x + (b.x - a.x) * stop / length, a.y + (b.y - a.y) * stop / length);
        }
        remaining -= stop - at;
        at = stop;
      }
    }
    v.stroke(paint, width, style, gradient);
    v.matrix = matrix;
    v.path = original;
    v.cursor = original.at(-1)?.at(-1) ?? null;
    v.subpath = original[0]?.[0] ?? null;
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
    if (!Array.isArray(values) || values.some((v) => !Number.isFinite(v) || v < 0)) throw new TypeError("dash must contain non-negative finite values");
    if (values.length % 2) values = values.concat(values);
    this._lineDash = values.slice();
  }
  getLineDash() {
    return this._lineDash.slice();
  }
  clip(rule = "nonzero") {
    this._frame();
    if (this.vector.path.filter((p) => p.length >= 3).length > 1) throw new RangeError("clip supports one contour per clip call");
    this.vector.clip(rule);
  }
  createClipPath(points, { rule = "nonzero" } = {}) {
    return this.vector.createClipPath(points, { rule });
  }
  clipPath(handle, { transform = null } = {}) {
    this._frame();
    this.meshRenderer?.flush("stencilChange");
    this.vector.flush();
    this.vector.clipPath(handle, { transform });
  }
  deleteClipPath(handle) {
    return this.vector.deleteClipPath(handle);
  }
  clipRect(x, y, w, h) {
    this._frame();
    this.vector.clipRect(x, y, w, h);
  }
  fillTriangleFan(points, paint = this._fillStyle) {
    this._frame();
    this.meshRenderer?.flush("vectorBoundary");
    if (points.length < 3) return;
    this.vector.triangleFan(points, this._paint(paint));
  }
  beginGroup(opacity = 1, bounds = null) {
    this._frame();
    if (opacity !== 1) this.meshRenderer?.flush("groupBoundary");
    this.vector.beginGroup(opacity, bounds);
  }
  endGroup() {
    if (!this.vector.groups.at(-1)?.direct) this.meshRenderer?.flush("groupBoundary");
    this.vector.endGroup();
  }
  withGroupOpacity(opacity, callback, bounds = null) {
    this._frame();
    const previous = this._globalAlpha;
    this.beginGroup(opacity, bounds);
    this._globalAlpha = 1;
    try {
      return callback();
    } finally {
      try {
        this.endGroup();
      } finally {
        this._globalAlpha = previous;
      }
    }
  }
  groupBounds(x, y, radius) {
    const m = this.vector.matrix, p = transformed(m, x, y), r = radius * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
    return { x: p.x - r, y: p.y - r, width: r * 2, height: r * 2 };
  }
  withColor(color2, callback) {
    const previous = this.forceColor;
    this.forceColor = normalizeColor(color2);
    try {
      return callback();
    } finally {
      this.forceColor = previous;
    }
  }
  withSilhouette(color2, width, paint, radius = 128) {
    const alpha = this._globalAlpha, bounds = this.groupBounds(0, 0, radius + width);
    return this.withGroupOpacity(alpha, () => {
      this.withColor(color2, () => {
        for (let i = 0; i < 8; i++) {
          this.save();
          const a = i * TAU / 8;
          this.translate(Math.cos(a) * width, Math.sin(a) * width);
          try {
            paint();
          } finally {
            this.restore();
          }
        }
        paint();
      });
      paint();
    }, bounds);
  }
  _fontSize() {
    const m = this._font.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/);
    return m ? Number(m[1]) : 10;
  }
  _align() {
    if (this._textAlign === "center") return "center";
    if (this._textAlign === "right" || this._textAlign === "end" && this._direction !== "rtl" || this._textAlign === "start" && this._direction === "rtl") return "right";
    return "left";
  }
  measureText(text) {
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    return this.glyphAtlas.measureText(String(text), { fontSize: this._fontSize(), align: this._align() });
  }
  fillText(text, x, y, maxWidth) {
    this._frame();
    this.meshRenderer?.flush("vectorBoundary");
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    const color2 = this._paint(this._fillStyle), fontSize = this._fontSize(), align = this._align(), baseline = this._textBaseline, measured = this.glyphAtlas.measureText(String(text), { fontSize }).width, scale = maxWidth && Number.isFinite(maxWidth) ? Math.min(1, maxWidth / (measured || 1)) : 1;
    if (scale !== 1) {
      this.vector.save();
      this.vector.translate(x, y);
      this.vector.scale(scale, 1);
      this.vector.translate(-x, -y);
    }
    try {
      return this.vector.fillText(String(text), x, y, { fontSize, align, baseline, color: color2 });
    } finally {
      if (scale !== 1) this.vector.restore();
    }
  }
  strokeText(text, x, y, maxWidth) {
    this._frame();
    this.meshRenderer?.flush("vectorBoundary");
    if (!this.glyphAtlas) throw new Error("GlyphAtlas is not configured");
    const scale = maxWidth && Number.isFinite(maxWidth) ? Math.min(1, maxWidth / (this.glyphAtlas.measureText(String(text), { fontSize: this._fontSize() }).width || 1)) : 1;
    this.vector.save();
    try {
      if (scale !== 1) {
        this.vector.translate(x, y);
        this.vector.scale(scale, 1);
        this.vector.translate(-x, -y);
      }
      return this.vector.strokeText(String(text), x, y, { fontSize: this._fontSize(), align: this._align(), baseline: this._textBaseline, color: this._paint(this._strokeStyle), lineWidth: this._lineWidth });
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
    if (this.state !== "ready" || this.device.state !== "ready") throw new Error("VectorContext is not ready");
    this.meshRenderer ??= new MeshRenderer(this.device, { safeAlphaRunBatching: this.safeAlphaRunBatching });
    return this.meshRenderer.createMesh(data);
  }
  deleteMesh(mesh) {
    return this.meshRenderer?.deleteMesh(mesh) ?? false;
  }
  /** Local transform composes with current Canvas-style transform; all paint state is captured by value. */
  drawMesh(mesh, { transform = null, morph = [0, 0], parts = null } = {}) {
    this._frame();
    if (!this.meshRenderer) throw new TypeError("createMesh required");
    this.vector.flush();
    let matrix = this.vector.matrix;
    if (transform) {
      if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) throw new TypeError("Six finite transform values required");
      const m = matrix, [a, b, c, d, e, f] = transform;
      matrix = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    }
    this.meshRenderer.drawMesh(mesh, { matrix, projection: this.vector.projection, clips: this.vector.clips, morph, parts, color: this.forceColor ?? [1, 1, 1, 1], forceColor: this.forceColor !== null, alpha: this._globalAlpha, whiteFlash: this._filter === "brightness(0) invert(1)", stencilRef: this.vector.stencilDepth || null });
  }
  /** Draw a retained mesh silhouette and body in one ordered instance batch. */
  drawMeshSilhouette(mesh, { transform = null, morph = [0, 0], parts = null, color: color2 = "black", width, radius = 128, outlineScale = null } = {}) {
    this._frame();
    if (!this.meshRenderer) throw new TypeError("createMesh required");
    finite2(width, "silhouette width");
    finite2(radius, "silhouette radius");
    if (width < 0 || radius < 0) throw new RangeError("silhouette dimensions must be non-negative");
    if (outlineScale !== null) {
      finite2(outlineScale, "silhouette outlineScale");
      if (outlineScale < 1) throw new RangeError("silhouette outlineScale must be at least one");
    }
    let outline;
    if (typeof color2 === "string" && color2[0] === "#") {
      outline = this._silhouetteColorCache.get(color2);
      if (!outline) {
        outline = normalizeColor(color2);
        if (this._silhouetteColorCache.size === 16) this._silhouetteColorCache.delete(this._silhouetteColorCache.keys().next().value);
        this._silhouetteColorCache.set(color2, outline);
      }
    } else outline = normalizeColor(color2);
    const outlineInstances = outlineScale === null ? 9 : 1, count = outlineInstances + 1, matrices = outlineScale === null ? this._silhouetteMatrices : this._scaledSilhouetteMatrices;
    const bounds = this.groupBounds(0, 0, Math.max(radius + width, radius * (outlineScale ?? 1)));
    return this.withGroupOpacity(this._globalAlpha, () => {
      this.vector.flush();
      const source = this.vector.matrix, a = source[0], b = source[1], c = source[2], d = source[3], e = source[4], f = source[5];
      let ta = 1, tb = 0, tc = 0, td = 1, te = 0, tf = 0;
      if (transform) {
        if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) throw new TypeError("Six finite transform values required");
        [ta, tb, tc, td, te, tf] = transform;
      }
      for (let i = 0; i < count; i++) {
        const outlinePass = i < outlineInstances, offset = outlineScale === null && outlinePass && i < 8, direction = offset ? SILHOUETTE_OFFSETS[i] : null, dx = direction ? direction[0] * width : 0, dy = direction ? direction[1] * width : 0, scale = outlineScale !== null && i === 0 ? outlineScale : 1, at = i * 6;
        const eOffset = e + a * dx + c * dy, fOffset = f + b * dx + d * dy;
        matrices[at] = (a * ta + c * tb) * scale;
        matrices[at + 1] = (b * ta + d * tb) * scale;
        matrices[at + 2] = (a * tc + c * td) * scale;
        matrices[at + 3] = (b * tc + d * td) * scale;
        matrices[at + 4] = a * te + c * tf + eOffset;
        matrices[at + 5] = b * te + d * tf + fOffset;
      }
      this.meshRenderer._drawMeshInstances(mesh, { matrices, count, projection: this.vector.projection, morph, parts, color: this.forceColor ?? WHITE3, forceColor: this.forceColor !== null, prefixColor: outline, prefixCount: outlineInstances, forceColorPrefixCount: outlineInstances, alpha: this._globalAlpha, whiteFlash: this._filter === "brightness(0) invert(1)", clips: this.vector.clips, stencilRef: this.vector.stencilDepth || null });
    }, bounds);
  }
  flush(reason = "explicit") {
    this._frame();
    this.meshRenderer?.flush(reason);
    this.vector.flush();
  }
  createStaticMesh(vertices, { strideFloats = 6 } = {}) {
    if (this.state !== "ready" || this.device.state !== "ready") throw new Error("VectorContext is not ready");
    if (!(vertices instanceof Float32Array) || !Number.isSafeInteger(strideFloats) || strideFloats < 2 || vertices.length % strideFloats) throw new TypeError("mesh requires Float32Array and a matching strideFloats");
    const buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    this.device.uploadVertices(buffer, vertices);
    const mesh = { context: this, buffer, vertices, count: vertices.length / strideFloats, strideFloats };
    this.staticMeshes.add(mesh);
    return mesh;
  }
  deleteStaticMesh(mesh) {
    if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh)) return false;
    this.device.deleteVertexBuffer(mesh.buffer);
    this.staticMeshes.delete(mesh);
    return true;
  }
  deferDeleteStaticMesh(mesh) {
    if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh) || this.deferredMeshes.includes(mesh)) return false;
    this.deferredMeshes.push(mesh);
    return true;
  }
  drawStaticMesh(mesh, { pipeline, projection, uniforms = {}, textures = [], blend = "source-over", depth = null } = {}) {
    this._frame();
    if (!mesh || mesh.context !== this || !this.staticMeshes.has(mesh) || !pipeline) throw new TypeError("mesh owned by this context and caller pipeline are required");
    this.flush("staticMeshBoundary");
    const values = { ...uniforms };
    if (projection) values.u_projection = projection;
    this.device.draw({ pipeline, buffer: mesh.buffer, count: mesh.count, uniforms: values, textures, blend, depth, stencil: this.vector.stencilDepth ? { func: "equal", ref: this.vector.stencilDepth, mask: 255, writeMask: 0, pass: "keep" } : false });
  }
  stats() {
    return { backend: "webgl1", available: this.device.state === "ready", contextLost: this.device.state === "lost", failure: this.device.failure ?? null, frame: this.frame, ...this.frameStats, mesh: this.meshRenderer?.stats() ?? null, stagingBytes: this.vector.vertices.byteLength, gpuBufferBytes: this.device.stats.gpuBufferBytes ?? 0, gpuRenderTargetBytes: this.device.stats.gpuRenderTargetBytes ?? 0, textureCount: this.device.stats.textureCount ?? 0, activeGradientTextureCount: this.gradientTextures.size, renderTargetCount: this.device.stats.renderTargetCount ?? 0, bufferAllocations: this.device.stats.bufferAllocations ?? 0, totals: { ...this.total } };
  }
  dispose() {
    if (this.state === "disposed") return;
    this.vector.count = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.meshRenderer?.dispose();
    for (const mesh of this.staticMeshes) this.device.deleteVertexBuffer(mesh.buffer);
    this._releaseGradientTextures();
    this.staticMeshes.clear();
    this.deferredMeshes.length = 0;
    if (this.ownsVector) this.vector.dispose();
    this.active = false;
    this.state = "disposed";
  }
};
var PrimitivePainter = class {
  constructor(target, { point: point2 = null, alphaMultiplier = 1 } = {}) {
    if (!target?.fillTriangleFan && !(target?.beginPath && target?.fill)) throw new TypeError("VectorContext or native Canvas2D context is required");
    this.context = target;
    this.pointTransform = point2;
    this.alphaMultiplier = alphaMultiplier;
  }
  point(x, y) {
    const result = this.pointTransform ? this.pointTransform(x, y) : [x, y];
    return Array.isArray(result) ? result : [result.x, result.y];
  }
  _paint(points, paint) {
    if (points.length < 3) return;
    const ctx = this.context, oldAlpha = ctx.globalAlpha ?? 1, mul = typeof this.alphaMultiplier === "function" ? this.alphaMultiplier() : this.alphaMultiplier;
    ctx.globalAlpha = oldAlpha * clamp(mul);
    try {
      if (typeof ctx.fillTriangleFan === "function") {
        ctx.fillTriangleFan(points.map((p) => this.point(p[0], p[1])), paint);
        return;
      }
      const rgba2 = normalizeColor(paint);
      ctx.fillStyle = `rgba(${Math.round(rgba2[0] * 255)},${Math.round(rgba2[1] * 255)},${Math.round(rgba2[2] * 255)},${rgba2[3]})`;
      ctx.beginPath();
      const a = this.point(points[0][0], points[0][1]);
      for (let i = 1; i < points.length - 1; i++) {
        const b = this.point(points[i][0], points[i][1]), c = this.point(points[i + 1][0], points[i + 1][1]);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.closePath();
      }
      ctx.fill();
    } finally {
      ctx.globalAlpha = oldAlpha;
    }
  }
  poly(points, paint) {
    this._paint(points, paint);
  }
  tri(x1, y1, x2, y2, x3, y3, paint) {
    this.poly([[x1, y1], [x2, y2], [x3, y3]], paint);
  }
  quad(x1, y1, x2, y2, x3, y3, x4, y4, paint) {
    this.poly([[x1, y1], [x2, y2], [x3, y3], [x4, y4]], paint);
  }
  regularPolygon(x, y, radius, paint, sides = 10, rotation = 0) {
    if (sides < 3 || radius <= 0) return;
    let unit = PRIMITIVE_DIRECTIONS.get(`${sides}|${rotation}`);
    if (!unit) {
      unit = Array.from({ length: sides }, (_, i) => [Math.cos(rotation + i / sides * TAU), Math.sin(rotation + i / sides * TAU)]);
      PRIMITIVE_DIRECTIONS.set(`${sides}|${rotation}`, unit);
    }
    this.poly(unit.map((p) => [x + p[0] * radius, y + p[1] * radius]), paint);
  }
  circle(x, y, radius, paint, segments = 10) {
    this.regularPolygon(x, y, radius, paint, segments, 0);
  }
  hex(x, y, radius, paint) {
    this.regularPolygon(x, y, radius, paint, 6, Math.PI / 6);
  }
  line(x0, y0, x1, y1, width, paint) {
    const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy) || 1, nx = -dy / length * width / 2, ny = dx / length * width / 2;
    this.quad(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, paint);
  }
  fan(points, paint) {
    this.poly(points, paint);
  }
};
var PRIMITIVE_DIRECTIONS = /* @__PURE__ */ new Map();

// modules/rendering/mesh-builder.js
var INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
var isIndexMap = (map, vertexCount) => map !== null && typeof map === "object" && !Array.isArray(map) && Object.entries(map).every(([name, indices]) => INDEX_NAME.test(name) && indices instanceof Uint16Array && indices.length % 3 === 0 && indices.every((index) => index < vertexCount));
var baseIndices = (geometry) => geometry.indices ?? Uint16Array.from({ length: geometry.vertices.length / 11 }, (_, index) => index);
var MeshBuilder = class _MeshBuilder {
  constructor({ maxVertices = 262144 } = {}) {
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) throw new RangeError("maxVertices must be >= 3");
    this.maxVertices = maxVertices;
    this.globalAlpha = 1;
    this.vertices = [];
  }
  fillTriangleFan(points, paint) {
    if (!points || points.length < 3) return;
    if (!Number.isFinite(this.globalAlpha) || this.globalAlpha < 0 || this.globalAlpha > 1) throw new RangeError("globalAlpha must be in [0,1]");
    const color2 = normalizeColor(paint);
    color2[3] *= this.globalAlpha;
    if (this.vertices.length / 6 + (points.length - 2) * 3 > this.maxVertices) throw new RangeError("MeshBuilder vertex capacity exceeded");
    for (const p of points) if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new TypeError("Finite mesh points required");
    for (let i = 2; i < points.length; i++) {
      for (const p of [points[0], points[i - 1], points[i]]) this.vertices.push(p[0], p[1], ...color2);
    }
  }
  /** Each target is the same authored triangle/color sequence with different positions, not a sampled time cache. */
  build({ morphs = [] } = {}) {
    if (!Array.isArray(morphs) || morphs.length > 2 || morphs.some((m) => !(m instanceof _MeshBuilder))) throw new TypeError("At most two MeshBuilder morph targets required");
    const base = this.vertices, count = base.length / 6;
    for (const target of morphs) {
      if (target.vertices.length !== base.length) throw new RangeError("Morph topology differs");
      for (let i = 0; i < base.length; i++) if (i % 6 >= 2 && target.vertices[i] !== base[i]) throw new RangeError("Morph colors differ");
    }
    const vertices = new Float32Array(count * 11);
    for (let i = 0; i < count; i++) {
      vertices.set(base.slice(i * 6, i * 6 + 6), i * 11);
      for (let j = 0; j < morphs.length; j++) {
        vertices[i * 11 + 6 + j * 2] = morphs[j].vertices[i * 6] - base[i * 6];
        vertices[i * 11 + 7 + j * 2] = morphs[j].vertices[i * 6 + 1] - base[i * 6 + 1];
      }
    }
    return Object.freeze({ vertices, count, strideFloats: 11, morphCount: morphs.length, partCount: 1 });
  }
  /** Packs compatible authored geometries into one painter-ordered mesh without sorting. */
  static combine(geometries) {
    if (!Array.isArray(geometries) || !geometries.length || geometries.some((geometry) => !Number.isSafeInteger(geometry?.partCount) || geometry.partCount < 1 || geometry.strideFloats !== 11 || !(geometry.vertices instanceof Float32Array) || geometry.vertices.length < 33 || geometry.vertices.length % 11 || geometry.nonScalingStroke !== void 0 && typeof geometry.nonScalingStroke !== "boolean" || geometry.nonScalingStroke && geometry.morphCount !== 0 || geometry.indices !== void 0 && (!(geometry.indices instanceof Uint16Array) || geometry.indices.length < 3 || geometry.indices.length % 3 || geometry.vertices.length / 11 > 65536 || geometry.indices.some((index) => index >= geometry.vertices.length / 11)) || geometry.indices === void 0 && geometry.vertices.length % 33 || !Number.isSafeInteger(geometry.morphCount) || geometry.morphCount < 0 || geometry.morphCount > 2 || geometry.expressionIndices !== void 0 && !isIndexMap(geometry.expressionIndices, geometry.vertices.length / 11) || geometry.indexVariants !== void 0 && (!isIndexMap(geometry.indexVariants, geometry.vertices.length / 11) || Object.keys(geometry.indexVariants).length > 0)) || geometries.reduce((count, geometry) => count + geometry.partCount, 0) > 16) {
      throw new TypeError("MeshBuilder geometries must fit within 16 parts, use the 11-float schema, and cannot flatten painter-order indexVariants");
    }
    const vertexCount = geometries.reduce((count, geometry) => count + geometry.vertices.length / 11, 0);
    const indexCount = geometries.reduce((count, geometry) => count + (geometry.indices?.length ?? geometry.vertices.length / 11), 0);
    if (vertexCount > 65536) throw new RangeError("Combined geometry exceeds 65,536 distinct vertices");
    for (const geometry of geometries) for (let i = 10; i < geometry.vertices.length; i += 11) {
      const part = geometry.vertices[i];
      if (!Number.isSafeInteger(part) || part < 0 || part >= geometry.partCount) throw new RangeError("Mesh part index outside partCount");
    }
    const vertices = new Float32Array(vertexCount * 11), indices = new Uint16Array(indexCount);
    const expressionNames = new Set(geometries.flatMap((geometry) => Object.keys(geometry.expressionIndices ?? {})));
    const expressionIndices = /* @__PURE__ */ Object.create(null);
    const partCount = geometries.reduce((count, geometry) => count + geometry.partCount, 0);
    const morphCount = Math.max(...geometries.map((geometry) => geometry.morphCount));
    const nonScalingStroke = geometries.some((geometry) => geometry.nonScalingStroke === true);
    if (nonScalingStroke && morphCount) throw new TypeError("Non-scaling strokes cannot be combined with vertex morph targets");
    let offset = 0;
    let partOffset = 0;
    let indexOffset = 0;
    for (const geometry of geometries) {
      vertices.set(geometry.vertices, offset);
      const vertexLength = geometry.vertices.length;
      for (let i = 10; i < vertexLength; i += 11) vertices[offset + i] += partOffset;
      if (geometry.indices) {
        for (let i = 0; i < geometry.indices.length; i++) indices[indexOffset + i] = geometry.indices[i] + offset / 11;
        indexOffset += geometry.indices.length;
      } else {
        for (let i = 0; i < vertexLength / 11; i++) indices[indexOffset + i] = i + offset / 11;
        indexOffset += vertexLength / 11;
      }
      offset += vertexLength;
      partOffset += geometry.partCount;
    }
    for (const name of expressionNames) {
      const variantLength = geometries.reduce((count, geometry) => count + (geometry.expressionIndices?.[name]?.length ?? (geometry.indices?.length ?? geometry.vertices.length / 11)), 0);
      const variant = new Uint16Array(variantLength);
      let target = 0, vertexOffset = 0;
      for (const geometry of geometries) {
        const source = geometry.expressionIndices?.[name] ?? baseIndices(geometry);
        for (let i = 0; i < source.length; i++) variant[target + i] = source[i] + vertexOffset;
        target += source.length;
        vertexOffset += geometry.vertices.length / 11;
      }
      expressionIndices[name] = variant;
    }
    return Object.freeze({
      vertices,
      indices,
      count: indices.length,
      strideFloats: 11,
      partCount,
      morphCount,
      ...expressionNames.size ? { expressionIndices } : {},
      ...nonScalingStroke ? { nonScalingStroke: true } : {}
    });
  }
};

// modules/rendering/yarn-shader.js
var STRIDE_FLOATS = 9;
var STRIDE_BYTES = STRIDE_FLOATS * 4;
var MAX_SURFACES = 512;
var DEFAULT_LIMIT_BYTES = 32 * 1024 * 1024;
var ATTRIBUTES2 = [
  { name: "a_position", size: 2, offset: 0 },
  { name: "a_color", size: 4, offset: 8 },
  { name: "a_surface", size: 3, offset: 24 }
];
var IDENTITY4 = Object.freeze([1, 0, 0, 1, 0, 0]);
var WHITE4 = Object.freeze([1, 1, 1, 1]);
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
  const clips = maxClipPlanes ? `
uniform vec3 u_planes[${maxClipPlanes}];
void clipWorld() {
  for (int i = 0; i < ${maxClipPlanes}; i++) {
    vec3 plane = u_planes[i];
    if (dot(plane.xy, plane.xy) > 0.0000001 && dot(plane, vec3(v_world, 1.0)) < 0.0) discard;
  }
}` : "void clipWorld() {}";
  const body = kind === "yarn" ? yarnFragmentBody : sketchFragmentBody;
  return `precision mediump float;
varying vec2 v_position; varying vec2 v_world; varying vec4 v_color; varying vec3 v_surface;
uniform vec4 u_bounds; uniform vec4 u_effect0; uniform vec4 u_effect1; uniform vec4 u_effect2; uniform vec4 u_effect3;
uniform vec4 u_tint; uniform float u_flash; uniform float u_forceColor;
${kind === "sketch" ? "uniform float u_timeMs;" : ""}
${clips}
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
${body}
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
var yarnFragmentBody = `
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
var sketchFragmentBody = `
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
  if (!value || value.length !== count || Array.from(value).some((number) => !Number.isFinite(number))) throw new TypeError(`${name} needs ${count} finite numbers`);
}
function validateStyle(style) {
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new TypeError("A complete SVG-authored yarn or sketch style is required");
  const yarnRequired = ["seed", "stitchWidth", "stitchHeight", "thickness", "irregularity", "contrast", "edgeSpacing", "edgeRelief", "edgeWidth", "fiberLength", "fiberWidth", "fiberOpacity", "fiberMax"];
  const sketchRequired = ["seed", "periodMs", "amplitude", "frequency", "echoX", "echoY", "echoWidth", "echoOpacity", "hatchAngle", "hatchSpacing", "hatchWidth", "hatchOpacity"];
  const fields = style.kind === "yarn" ? yarnRequired : style.kind === "sketch" ? sketchRequired : null;
  if (!fields || fields.some((key) => !Number.isFinite(style[key]))) throw new TypeError("Unsupported or incomplete SVG surface style");
  if (style.seed < 0 || style.seed > 2147483647 || !Number.isSafeInteger(style.seed)) throw new RangeError("Surface seed must be a nonnegative 31-bit integer");
  if (style.kind === "yarn") {
    for (const key of ["stitchWidth", "stitchHeight", "thickness", "edgeSpacing", "edgeRelief", "edgeWidth", "fiberLength", "fiberWidth"]) if (style[key] <= 0) throw new RangeError(`Yarn ${key} must be positive`);
    for (const key of ["irregularity", "contrast", "fiberOpacity"]) if (style[key] < 0 || style[key] > 1) throw new RangeError(`Yarn ${key} must be in [0,1]`);
    if (!Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) throw new RangeError("Yarn fiberMax must be an integer from 0 to 512");
    for (const key of ["fiberSpacing", "curved", "pattern", "detail", "fiber"]) if (style[key] !== void 0 && (key === "fiberSpacing" ? !Number.isFinite(style[key]) || style[key] <= 0 : typeof style[key] !== "boolean")) throw new TypeError(`Invalid Yarn ${key}`);
  } else {
    if (!Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 1e4) throw new RangeError("Sketch periodMs must be 16..10000");
    for (const key of ["amplitude", "frequency", "echoWidth", "hatchSpacing", "hatchWidth"]) if (style[key] <= 0) throw new RangeError(`Sketch ${key} must be positive`);
    for (const key of ["echoOpacity", "hatchOpacity"]) if (style[key] < 0 || style[key] > 1) throw new RangeError(`Sketch ${key} must be in [0,1]`);
  }
}
function normalizeOutline(outline, sourceIndices) {
  if (!(outline instanceof Float32Array || Array.isArray(outline)) || outline.length < 8 || outline.length % 2) throw new TypeError("Closed SVG contour must contain at least four x/y points");
  const points = [];
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i], y = outline[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError("SVG contour points must be finite");
    if (!points.length || Math.hypot(x - points.at(-1)[0], y - points.at(-1)[1]) > 1e-6) {
      points.push([x, y]);
      sourceIndices?.push(i / 2);
    }
  }
  if (points.length > 4 && Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]) < 1e-6) {
    points.pop();
    sourceIndices?.pop();
  }
  if (points.length < 3) throw new TypeError("SVG contour requires at least three distinct points");
  return points;
}
function surfaceGeometry(fillVertices, outline, edgeColors, style) {
  if (!(fillVertices instanceof Float32Array) || fillVertices.length < 18 || fillVertices.length % 18) throw new TypeError("Filled surface requires complete triangles in a six-float position/color layout");
  const sourceIndices = [], points = normalizeOutline(outline, sourceIndices);
  if (edgeColors !== void 0 && (!(edgeColors instanceof Float32Array) || edgeColors.length !== points.length * 4 && edgeColors.length !== outline.length * 2)) throw new TypeError("edgeColors must contain one RGBA color per contour point");
  if (edgeColors && edgeColors.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new RangeError("edgeColors must contain finite RGBA values in [0,1]");
  if (edgeColors && edgeColors.length !== points.length * 4) {
    const originalColors = edgeColors;
    edgeColors = Float32Array.from(sourceIndices.flatMap((index) => Array.from(originalColors.subarray(index * 4, index * 4 + 4))));
  }
  for (let i = 0; i < fillVertices.length; i++) {
    if (!Number.isFinite(fillVertices[i])) throw new TypeError("Filled surface vertices must be finite");
    const field = i % 6;
    if (field >= 2 && (fillVertices[i] < 0 || fillVertices[i] > 1)) throw new RangeError("Surface colors must be in [0,1]");
  }
  const lengths = [], normals = [];
  let total = 0, signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) throw new TypeError("SVG contour cannot contain zero-length edges");
    lengths.push(length);
    total += length;
    signedArea += a[0] * b[1] - b[0] * a[1];
    normals.push([dy / length, -dx / length]);
  }
  if (Math.abs(signedArea) < 1e-6) throw new TypeError("SVG contour cannot have zero area");
  const winding = signedArea >= 0 ? 1 : -1;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < fillVertices.length; i += 6) {
    bounds[0] = Math.min(bounds[0], fillVertices[i]);
    bounds[1] = Math.min(bounds[1], fillVertices[i + 1]);
    bounds[2] = Math.max(bounds[2], fillVertices[i]);
    bounds[3] = Math.max(bounds[3], fillVertices[i + 1]);
  }
  if (!(bounds[2] > bounds[0] && bounds[3] > bounds[1])) throw new TypeError("Filled surface bounds must have positive area");
  const rgba2 = edgeColors ? edgeColors : (() => {
    const color2 = [0, 0, 0, 0];
    for (let i = 0; i < fillVertices.length; i += 6) for (let c = 0; c < 4; c++) color2[c] += fillVertices[i + 2 + c];
    for (let c = 0; c < 4; c++) color2[c] /= fillVertices.length / 6;
    return Float32Array.from(points.flatMap(() => color2));
  })();
  const edgeWidth = style.kind === "yarn" ? style.edgeWidth : Math.max(style.echoWidth, Math.hypot(style.echoX, style.echoY) + style.amplitude + style.echoWidth);
  const fiberLength = style.kind === "yarn" && style.fiber !== false ? style.fiberLength : edgeWidth;
  const fillRecords = new Float32Array(fillVertices.length / 6 * STRIDE_FLOATS);
  let write = 0;
  for (let i = 0; i < fillVertices.length; i += 6) {
    fillRecords.set(fillVertices.subarray(i, i + 6), write);
    fillRecords[write + 6] = 0;
    write += STRIDE_FLOATS;
  }
  const cumulative = [0];
  for (const length of lengths) cumulative.push(cumulative.at(-1) + length);
  const ring = [];
  for (let i = 0; i < points.length; i++) {
    const previous = normals[(i + points.length - 1) % points.length], current = normals[i];
    let mx = (previous[0] + current[0]) * winding, my = (previous[1] + current[1]) * winding;
    const miterLength = Math.hypot(mx, my);
    if (miterLength < 1e-5) {
      mx = current[0] * winding;
      my = current[1] * winding;
    } else {
      mx /= miterLength;
      my /= miterLength;
    }
    const denominator = Math.max(0.25, Math.abs(mx * current[0] * winding + my * current[1] * winding));
    const scale = Math.min(4, 1 / denominator);
    ring.push([mx * scale, my * scale]);
  }
  const edgeFirst = fillVertices.length / 6;
  const edgeRecords = [];
  const colorAt = (index) => rgba2.subarray(index * 4, index * 4 + 4);
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const emit = (pointIndex, distance) => {
      const point2 = points[pointIndex], normal = ring[pointIndex], x = point2[0] + normal[0] * distance, y = point2[1] + normal[1] * distance;
      edgeRecords.push(x, y, ...colorAt(pointIndex), 1, cumulative[pointIndex] / total, distance);
    };
    emit(i, -edgeWidth);
    emit(i, fiberLength);
    emit(j, fiberLength);
    emit(i, -edgeWidth);
    emit(j, fiberLength);
    emit(j, -edgeWidth);
  }
  const edgeRecordArray = Float32Array.from(edgeRecords);
  const vertices = new Float32Array(fillRecords.length + edgeRecordArray.length);
  vertices.set(fillRecords);
  vertices.set(edgeRecordArray, fillRecords.length);
  return Object.freeze({
    vertices,
    fillFirst: 0,
    fillCount: fillVertices.length / 6,
    edgeFirst: fillVertices.length / 6,
    edgeCount: edgeRecordArray.length / STRIDE_FLOATS,
    edgeByteOffset: fillRecords.length * 4,
    bounds: Float32Array.of(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]),
    contourLength: total
  });
}
function clipPlanes(clips, maxPlanes) {
  const packed = new Float32Array(maxPlanes * 3);
  if (!clips?.length) return packed;
  if (!Array.isArray(clips)) throw new TypeError("clips must be an array of convex polygons");
  let cursor = 0;
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point2) => !Number.isFinite(point2?.x) || !Number.isFinite(point2?.y))) throw new TypeError("Finite convex clip polygons required");
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      area += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area) < 1e-8) throw new RangeError("A clip polygon must have nonzero area");
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (!length) continue;
      if (cursor >= maxPlanes) throw new RangeError(`Shader surface clipping exceeds the device limit of ${maxPlanes} edge planes`);
      const at = cursor++ * 3, nx = -dy / length * sign, ny = dx / length * sign;
      packed[at] = nx;
      packed[at + 1] = ny;
      packed[at + 2] = -(nx * a.x + ny * a.y);
    }
  }
  return packed;
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
    if (!device?.createPipeline || !device?.uploadVertices || !device?.draw) throw new TypeError("A ready GameKit WebGLDevice is required");
    if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1 || maxSurfaces > MAX_SURFACES) throw new RangeError(`maxSurfaces must be 1..${MAX_SURFACES}`);
    if (!Number.isSafeInteger(maxSurfaceBytes) || maxSurfaceBytes < STRIDE_BYTES * 3 || maxSurfaceBytes > device.maxBufferBytes) throw new RangeError("maxSurfaceBytes must fit the device buffer limit");
    this.device = device;
    this.maxSurfaces = maxSurfaces;
    this.maxSurfaceBytes = maxSurfaceBytes;
    this.maxClipPlanes = Math.max(1, Math.min(8, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 8));
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
        for (const surface of this.surfaces) device.uploadVertices(surface.buffer, surface.vertices);
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
    const key = kind + ":" + Number(worldMode);
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const uniforms = {
      ...worldMode ? { u_viewProjection: "matrix4fv", u_worldMatrix: "matrix4fv" } : { u_projection: "matrix3fv" },
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
      ...kind === "sketch" ? { u_timeMs: "1f" } : {}
    };
    pipeline = this.device.createPipeline({
      vertex: worldMode ? VERTEX_WORLD : VERTEX2,
      fragment: fragment2(kind, this.maxClipPlanes),
      stride: STRIDE_BYTES,
      attributes: ATTRIBUTES2,
      uniforms
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  createSurface({ fillVertices, outline, edgeColors, style }) {
    if (this.disposed || this.state !== "ready") throw new Error(`YarnSurfaceRenderer is ${this.state}`);
    validateStyle(style);
    if (this.surfaces.size >= this.maxSurfaces) throw new RangeError("Retained yarn surface count limit exceeded");
    const geometry = surfaceGeometry(fillVertices, outline, edgeColors, style);
    const vertices = geometry.vertices.slice();
    if (this.bytes + vertices.byteLength > this.maxSurfaceBytes) throw new RangeError("Retained yarn surface byte budget exceeded");
    const pipeline = this._pipeline(style.kind);
    const buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    try {
      this.device.uploadVertices(buffer, vertices);
    } catch (error) {
      this.device.deleteVertexBuffer(buffer);
      throw error;
    }
    const surface = Object.freeze({
      renderer: this,
      buffer,
      vertices,
      byteLength: vertices.byteLength,
      style: Object.freeze({ ...style }),
      kind: style.kind,
      fillFirst: geometry.fillFirst,
      fillCount: geometry.fillCount,
      edgeFirst: geometry.edgeFirst,
      edgeCount: geometry.edgeCount,
      edgeByteOffset: geometry.edgeByteOffset,
      bounds: geometry.bounds,
      contourLength: geometry.contourLength,
      pipeline
    });
    this.surfaces.add(surface);
    this.bytes += surface.byteLength;
    return surface;
  }
  drawSurface(surface, {
    projection,
    viewProjection,
    worldMatrix,
    transform = IDENTITY4,
    color: color2 = WHITE4,
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
    if (this.disposed || this.state !== "ready") throw new Error(`YarnSurfaceRenderer is ${this.state}${this.failure ? ": " + this.failure : ""}`);
    if (!this.surfaces.has(surface)) throw new TypeError("Surface must belong to this YarnSurfaceRenderer");
    const worldMode = viewProjection !== void 0 || worldMatrix !== void 0;
    if (worldMode) {
      if (projection !== void 0 || viewProjection === void 0 || worldMatrix === void 0) throw new TypeError("3D surface draws require viewProjection and worldMatrix and cannot include projection");
      finiteArray3(viewProjection, 16, "viewProjection");
      affineMatrix42(worldMatrix, "worldMatrix");
    } else finiteArray3(projection, 9, "projection");
    finiteArray3(color2, 4, "color");
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color2.some((value) => value < 0 || value > 1)) throw new RangeError("Surface tint/alpha must be in [0,1]");
    if (typeof forceColor !== "boolean") throw new TypeError("forceColor must be boolean");
    if (!Number.isFinite(whiteFlash) || whiteFlash < 0 || whiteFlash > 1) throw new RangeError("whiteFlash must be in [0,1]");
    if (!Number.isFinite(timeMs)) throw new TypeError("timeMs must be finite");
    if (!Number.isFinite(z) || z < -1 || z > 1) throw new RangeError("z must be in [-1,1]");
    if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) throw new RangeError("stencilRef must be null or in [0,255]");
    if (stencilRef !== null && !this.device.activeStencilAvailable) throw new Error("A stencil-tested yarn surface requires an active stencil attachment");
    const planes = clipPlanes(clips, this.maxClipPlanes), style = surface.style;
    const yarn = surface.kind === "yarn";
    const stitchPattern = style.pattern !== false;
    const effect0 = yarn ? [style.seed, style.stitchWidth, style.stitchHeight, (stitchPattern ? 1 : -1) * style.thickness] : [style.seed, style.periodMs, style.frequency, 0];
    const effect1 = yarn ? [style.irregularity, style.contrast, style.edgeSpacing, style.edgeWidth] : [style.amplitude, style.echoX, style.echoWidth, style.echoOpacity];
    const effect2 = yarn ? [style.fiberSpacing ?? 4, style.fiberLength, style.fiberWidth, style.fiberOpacity] : [style.hatchWidth, style.hatchOpacity, style.hatchAngle, style.hatchSpacing];
    const effect3 = yarn ? [
      style.fiber === false ? 0 : style.fiberMax,
      surface.contourLength,
      style.curved === false ? 0 : 1,
      style.edgeRelief * (style.detail ? 0.3 : 1)
    ] : [0, style.echoY, 0, 0];
    const uniforms = {
      ...worldMode ? { u_viewProjection: viewProjection, u_worldMatrix: worldMatrix } : { u_projection: projection },
      u_transform: toMatrix3(transform),
      u_depth: z,
      u_bounds: surface.bounds,
      u_effect0: effect0,
      u_effect1: effect1,
      u_effect2: effect2,
      u_effect3: effect3,
      u_tint: [color2[0], color2[1], color2[2], color2[3] * alpha],
      u_flash: whiteFlash,
      u_forceColor: forceColor ? 1 : 0,
      "u_planes[0]": planes,
      ...yarn ? {} : { u_timeMs: (timeMs % style.periodMs + style.periodMs) % style.periodMs }
    };
    const common = {
      pipeline: this._pipeline(surface.kind, worldMode),
      buffer: surface.buffer,
      uniforms,
      blend,
      depth,
      stencil: stencilRef === null ? false : { func: "equal", ref: stencilRef, mask: 255, writeMask: 0, pass: "keep" }
    };
    this.device.draw({ ...common, first: surface.fillFirst, count: surface.fillCount });
    if (surface.edgeCount) {
      const edgeDepth = depth === true ? { test: true, write: false } : depth && typeof depth === "object" ? { ...depth, write: false } : depth;
      this.device.draw({ ...common, first: surface.edgeFirst, count: surface.edgeCount, depth: edgeDepth });
    }
  }
  deleteSurface(surface) {
    if (!this.surfaces.has(surface)) return false;
    this.device.deleteVertexBuffer(surface.buffer);
    this.surfaces.delete(surface);
    this.bytes -= surface.byteLength;
    return true;
  }
  stats() {
    return Object.freeze({ state: this.state, surfaceCount: this.surfaces.size, retainedBytes: this.bytes, pipelineCount: this.pipelines.size, maxClipPlanes: this.maxClipPlanes });
  }
  dispose() {
    if (this.disposed) return false;
    this.device.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    for (const surface of this.surfaces) this.device.deleteVertexBuffer(surface.buffer);
    for (const pipeline of this.pipelines.values()) this.device.deletePipeline(pipeline);
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
    if (!glyphs || typeof glyphs !== "object") throw new TypeError("glyphs must be a code-point keyed metric object");
    if (!["error", "skip", "replacement"].includes(missingGlyph)) throw new RangeError("missingGlyph must be error, skip, or replacement");
    if (typeof replacement !== "string" || [...replacement].length !== 1) throw new TypeError("replacement must be one Unicode code point");
    this.device = device;
    this.width = width;
    this.height = height;
    this.unitsPerEm = unitsPerEm;
    this.ascent = ascent;
    this.descent = descent;
    this.missingGlyph = missingGlyph;
    this.replacement = replacement;
    this.glyphs = /* @__PURE__ */ new Map();
    for (const [key, value] of Object.entries(glyphs)) {
      const codePoint = normalizeCodePoint(key);
      this.glyphs.set(codePoint, validateGlyph(value, width, height, codePoint));
    }
    if (filter !== "nearest" && filter !== "linear") throw new RangeError("filter must be nearest or linear");
    this.texture = device.createTexture({ width, height, data }, { format: "rgba", filter });
    this.disposed = false;
  }
  /** Returns the metrics in the same units as the requested fontSize. */
  measureText(text, { fontSize = this.unitsPerEm, align = "left" } = {}) {
    this._live();
    validateText(text);
    positive(fontSize, "fontSize");
    validateAlign(align);
    const glyphs = this._resolve(text);
    const width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) * fontSize / this.unitsPerEm;
    return {
      width,
      ascent: this.ascent * fontSize / this.unitsPerEm,
      descent: this.descent * fontSize / this.unitsPerEm,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width
    };
  }
  /**
   * Emits one callback per visible glyph. The callback receives texture, atlas
   * UVs, destination rectangle, RGBA color, and operation='fill'.
   * Also accepts `(renderer, text, x, y, options)` when renderer provides
   * `drawGlyphQuad(texture, x, y, width, height, uv, color)`.
   */
  fillText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const args = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    return this._draw("fill", args.text, args.x, args.y, args.options, args.drawGlyph);
  }
  /**
   * Emits an outline as eight offset glyph passes. This is a
   * geometric atlas outline; it does not modify or rasterize atlas pixels.
   * `lineWidth` is in destination units.
   */
  strokeText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const args = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    const { text, x, y, options, drawGlyph } = args;
    const { lineWidth = 1, strokeColor = options.color ?? [0, 0, 0, 1] } = options;
    positive(lineWidth, "lineWidth");
    validateColor(strokeColor, "strokeColor");
    return this._draw("stroke", text, x, y, { ...options, color: strokeColor }, drawGlyph, lineWidth);
  }
  _draw(operation, text, x, y, options, drawGlyph, lineWidth = 0) {
    this._live();
    validateText(text);
    finite3(x, "x");
    finite3(y, "y");
    if (typeof drawGlyph !== "function") throw new TypeError("drawGlyph callback is required");
    const { fontSize = this.unitsPerEm, align = "left", baseline = "alphabetic", color: color2 = [1, 1, 1, 1] } = options;
    positive(fontSize, "fontSize");
    validateAlign(align);
    validateColor(color2, "color");
    const resolved = this._resolve(text);
    const scale = fontSize / this.unitsPerEm;
    const advance = resolved.reduce((sum, glyph) => sum + glyph.advance, 0) * scale;
    let penX = x - (align === "center" ? advance / 2 : align === "right" ? advance : 0);
    const baselineY = baselineOffset(baseline, fontSize, this.unitsPerEm, this.ascent, this.descent, y);
    const offsets = lineWidth ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, 0]];
    for (const glyph of resolved) {
      if (glyph.width > 0 && glyph.height > 0) {
        const left = penX + glyph.bearingX * scale;
        const top = baselineY - glyph.bearingY * scale;
        for (const [ox, oy] of offsets) drawGlyph({
          texture: this.texture,
          glyph,
          codePoint: glyph.codePoint,
          x: left + ox * lineWidth,
          y: top + oy * lineWidth,
          width: glyph.width * scale,
          height: glyph.height * scale,
          u0: glyph.x / this.width,
          v0: glyph.y / this.height,
          u1: (glyph.x + glyph.width) / this.width,
          v1: (glyph.y + glyph.height) / this.height,
          color: color2,
          operation: lineWidth ? "stroke" : operation
        });
      }
      penX += glyph.advance * scale;
    }
    return {
      x: x - (align === "center" ? advance / 2 : align === "right" ? advance : 0),
      y: baselineY,
      width: advance,
      glyphCount: resolved.length
    };
  }
  _resolve(text) {
    const result = [];
    for (const character of text) {
      let glyph = this.glyphs.get(character.codePointAt(0));
      if (!glyph) {
        if (this.missingGlyph === "skip") continue;
        if (this.missingGlyph === "replacement") glyph = this.glyphs.get(this.replacement.codePointAt(0));
        if (!glyph) throw new RangeError(`missing glyph U+${character.codePointAt(0).toString(16).toUpperCase()}`);
      }
      result.push(glyph);
    }
    return result;
  }
  _live() {
    if (this.disposed) throw new Error("GlyphAtlas is disposed");
  }
  /** Idempotently releases the atlas texture through its owning device. */
  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.device.deleteTexture(this.texture);
    this.texture = null;
    return true;
  }
};
function normalizeCodePoint(key) {
  if (/^U\+[0-9a-f]{1,6}$/i.test(key)) return Number.parseInt(key.slice(2), 16);
  const chars = [...key];
  if (chars.length === 1) return chars[0].codePointAt(0);
  if (/^0x[0-9a-f]+$/i.test(key)) return Number.parseInt(key.slice(2), 16);
  throw new TypeError(`invalid glyph key: ${key}`);
}
function normalizeDrawArguments(first, second, third, fourth, fifth) {
  if (first && typeof first.drawGlyphQuad === "function") {
    const renderer = first, text2 = second, x2 = third, y2 = fourth, options2 = fifth ?? {};
    return { text: text2, x: x2, y: y2, options: options2, drawGlyph: (glyph) => renderer.drawGlyphQuad(
      glyph.texture,
      glyph.x,
      glyph.y,
      glyph.width,
      glyph.height,
      { u0: glyph.u0, v0: glyph.v0, u1: glyph.u1, v1: glyph.v1 },
      glyph.color
    ) };
  }
  const text = first, x = second, y = third, options = fourth ?? {};
  return { text, x, y, options, drawGlyph: fifth ?? options.drawGlyph };
}
function validateGlyph(value, atlasWidth, atlasHeight, codePoint) {
  if (!value || typeof value !== "object") throw new TypeError(`glyph U+${codePoint.toString(16)} must be a metric object`);
  const { x, y, width, height, advance, bearingX = 0, bearingY = 0 } = value;
  for (const [name, number] of Object.entries({ x, y, width, height, advance, bearingX, bearingY })) finite3(number, `glyph.${name}`);
  if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > atlasWidth || y + height > atlasHeight || advance < 0) {
    throw new RangeError(`glyph U+${codePoint.toString(16)} has invalid atlas bounds or advance`);
  }
  return Object.freeze({ codePoint, x, y, width, height, advance, bearingX, bearingY });
}
function baselineOffset(baseline, fontSize, units, ascent, descent, y) {
  const scale = fontSize / units;
  switch (baseline) {
    case "alphabetic":
      return y;
    case "top":
    case "hanging":
      return y + ascent * scale;
    case "middle":
      return y + (ascent - descent) * scale / 2;
    case "bottom":
    case "ideographic":
      return y - descent * scale;
    default:
      throw new RangeError("baseline must be top, hanging, middle, alphabetic, ideographic, or bottom");
  }
}
function validateAlign(value) {
  if (!["left", "center", "right"].includes(value)) throw new RangeError("align must be left, center, or right");
}
function validateColor(value, name) {
  if (!value || value.length !== 4) throw new TypeError(`${name} must be [r,g,b,a]`);
  for (let i = 0; i < 4; i++) if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) throw new RangeError(`${name} channels must be in [0,1]`);
}
function validateText(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
}
function finite3(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function positive(value, name) {
  finite3(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}
function nonNegative(value, name) {
  finite3(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

// modules/rendering/font-assets.js
var ASSET_FORMAT = "budmori-glyph-atlas-v2-r8-packbits";
var SHA256 = /^[a-f0-9]{64}$/;
var assetLoads = /* @__PURE__ */ new Map();
var deviceAtlases = /* @__PURE__ */ new WeakMap();
function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} has an unsupported schema`);
  }
}
function safeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("font source is required");
  exactKeys(source, ["url", "version", "sha256", "bytes"], "font source");
  const url = new URL(source.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError("font URL must be an absolute HTTP(S) URL without credentials or fragment");
  if (typeof source.version !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(source.version)) throw new TypeError("font version must be an explicit immutable identifier");
  if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) throw new TypeError("font SHA-256 is invalid");
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 8 * 1024 * 1024) throw new RangeError("font asset byte length must be 1..8388608");
  return Object.freeze({ url: url.href, version: source.version, sha256: source.sha256, bytes: source.bytes });
}
async function digest(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is required to load font assets");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(value) {
  if (typeof value !== "string" || value.length > 8 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("font packed mask is invalid base64");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function unpackMask(packed, expectedBytes) {
  const mask = new Uint8Array(expectedBytes);
  let input = 0, output = 0;
  while (input < packed.length) {
    const token = packed[input++];
    if (token < 128) {
      const length = token + 1;
      if (input + length > packed.length || output + length > mask.length) throw new Error("font PackBits literal exceeds declared bounds");
      mask.set(packed.subarray(input, input + length), output);
      input += length;
      output += length;
    } else {
      const length = (token & 127) + 3;
      if (input >= packed.length || output + length > mask.length) throw new Error("font PackBits run exceeds declared bounds");
      mask.fill(packed[input++], output, output + length);
      output += length;
    }
  }
  if (output !== mask.length) throw new Error("font PackBits decoded length does not match its declaration");
  return mask;
}
async function decodeAsset(bytes) {
  let asset;
  try {
    asset = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("font asset is not valid UTF-8 JSON");
  }
  exactKeys(asset, ["format", "generatedBy", "provenance", "atlas", "glyphs", "missingCodePoints", "packedMaskBase64"], "font asset");
  if (asset.format !== ASSET_FORMAT || asset.generatedBy !== "modules/rendering/scripts/generate-font-atlas.mjs") throw new Error("font asset format or generator version is unsupported");
  exactKeys(asset.atlas, ["width", "height", "packing", "unitsPerEm", "ascent", "descent", "colorFormat", "maskDecodedBytes", "maskSHA256", "codec", "packedMaskBytes", "packedMaskSHA256", "base64EncodedBytes", "base64Characters", "runtimeRgbaBytes", "encodedJsonBytes"], "font atlas");
  const { width, height, maskDecodedBytes, packedMaskBytes, runtimeRgbaBytes } = asset.atlas;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16777216 || maskDecodedBytes !== width * height || runtimeRgbaBytes !== width * height * 4 || !Number.isSafeInteger(packedMaskBytes) || packedMaskBytes < 1 || asset.atlas.colorFormat !== "R8 glyph coverage mask; renderer expands to white RGBA bytes at startup" || asset.atlas.codec !== "PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times" || !SHA256.test(asset.atlas.maskSHA256) || !SHA256.test(asset.atlas.packedMaskSHA256)) throw new Error("font atlas dimensions or encoding are invalid");
  if (!asset.provenance || asset.provenance.font?.licenseSource !== "https://github.com/notofonts/noto-cjk" || !asset.provenance.font.license.includes("SIL Open Font License 1.1")) throw new Error("font provenance or license is missing");
  if (!Array.isArray(asset.missingCodePoints) || asset.missingCodePoints.length !== 0) throw new Error("font asset contains missing glyphs");
  if (!asset.glyphs || typeof asset.glyphs !== "object" || Array.isArray(asset.glyphs)) throw new Error("font glyph inventory is invalid");
  const glyphKeys = Object.keys(asset.glyphs);
  if (glyphKeys.length !== asset.provenance.uniqueCodePointCount || glyphKeys.length !== 750) throw new Error("font glyph inventory differs from the published 750-codepoint version");
  const packed = decodeBase64(asset.packedMaskBase64);
  if (packed.length !== packedMaskBytes || await digest(packed) !== asset.atlas.packedMaskSHA256) throw new Error("font packed mask hash or length is invalid");
  const mask = unpackMask(packed, maskDecodedBytes);
  if (await digest(mask) !== asset.atlas.maskSHA256) throw new Error("font decoded mask hash is invalid");
  const data = new Uint8Array(runtimeRgbaBytes);
  for (let index = 0, pixel = 0; index < mask.length; index++, pixel += 4) {
    data[pixel] = 255;
    data[pixel + 1] = 255;
    data[pixel + 2] = 255;
    data[pixel + 3] = mask[index];
  }
  return {
    width,
    height,
    data,
    glyphs: asset.glyphs,
    unitsPerEm: asset.atlas.unitsPerEm,
    ascent: asset.atlas.ascent,
    descent: asset.atlas.descent
  };
}
function loadDecoded(source, onProgress) {
  const key = `${source.version}:${source.sha256}`;
  let entry = assetLoads.get(key);
  if (!entry) {
    entry = { listeners: /* @__PURE__ */ new Set(), progress: null, promise: null };
    const emit = (progress) => {
      entry.progress = progress;
      for (const listener of entry.listeners) listener(progress);
    };
    entry.promise = (async () => {
      const response = await fetch(source.url, { mode: "cors", credentials: "omit", cache: "force-cache" });
      if (!response.ok || response.type === "opaque") throw new Error(`font request failed (${response.status || response.type})`);
      const declaredLength = Number(response.headers.get("content-length"));
      const total = Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : source.bytes;
      const reader = response.body?.getReader();
      let bytes;
      if (reader) {
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > source.bytes) {
            await reader.cancel();
            throw new Error("font response exceeds its pinned byte length");
          }
          chunks.push(value);
          emit({ phase: "download", loaded: received, total });
        }
        bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
        emit({ phase: "download", loaded: bytes.byteLength, total });
      }
      if (bytes.byteLength !== source.bytes) throw new Error(`font byte length mismatch: expected ${source.bytes}, received ${bytes.byteLength}`);
      emit({ phase: "verify", loaded: bytes.byteLength, total: source.bytes });
      if (await digest(bytes) !== source.sha256) throw new Error("font asset SHA-256 mismatch");
      emit({ phase: "decode", loaded: 0, total: 1 });
      const decoded = await decodeAsset(bytes);
      emit({ phase: "decode", loaded: 1, total: 1 });
      return decoded;
    })();
    assetLoads.set(key, entry);
    entry.promise.catch(() => {
      if (assetLoads.get(key) === entry) assetLoads.delete(key);
    });
  }
  if (onProgress) {
    entry.listeners.add(onProgress);
    if (entry.progress) onProgress(entry.progress);
  }
  return { promise: entry.promise, unsubscribe: () => entry.listeners.delete(onProgress) };
}
function acquireAtlas(device, source, decoded) {
  let entries = deviceAtlases.get(device);
  if (!entries) {
    entries = /* @__PURE__ */ new Map();
    deviceAtlases.set(device, entries);
  }
  const key = `${source.version}:${source.sha256}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { references: 0, atlas: null };
    entry.atlas = new GlyphAtlas(device, { ...decoded, missingGlyph: "error" });
    entries.set(key, entry);
  }
  entry.references++;
  let released = false;
  return {
    atlas: entry.atlas,
    release() {
      if (released) return false;
      released = true;
      if (--entry.references === 0 && entries.get(key) === entry) {
        entry.atlas.dispose();
        entries.delete(key);
      }
      return true;
    }
  };
}
var FontAssetLoader = class {
  constructor(device, source, { signal, onProgress } = {}) {
    if (!device || typeof device.createTexture !== "function") throw new TypeError("a live WebGLDevice is required");
    if (onProgress !== void 0 && typeof onProgress !== "function") throw new TypeError("onProgress must be a function");
    this.device = device;
    this.source = safeSource(source);
    this.state = "loading";
    this.error = null;
    this.atlas = null;
    this.progress = { phase: "download", loaded: 0, total: this.source.bytes };
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
    let unsubscribe = null, abortListener = null;
    try {
      if (this._signal?.aborted) throw new DOMException("Font loading aborted", "AbortError");
      const loaded = loadDecoded(this.source, (progress) => this._emit(progress));
      unsubscribe = loaded.unsubscribe;
      const cancellation = new Promise((_, reject) => {
        this._rejectCancel = reject;
        if (this._signal) {
          abortListener = () => reject(new DOMException("Font loading aborted", "AbortError"));
          this._signal.addEventListener("abort", abortListener, { once: true });
        }
      });
      const decoded = await Promise.race([
        loaded.promise,
        cancellation
      ]);
      if (this._cancelled || this.state === "disposed") throw new DOMException("Font loading aborted", "AbortError");
      this._lease = acquireAtlas(this.device, this.source, decoded);
      this.atlas = this._lease.atlas;
      this.state = "ready";
      this._emit({ phase: "ready", loaded: this.source.bytes, total: this.source.bytes });
      return this.atlas;
    } catch (error) {
      if (this._cancelled || error?.name === "AbortError") this.state = this.state === "disposed" ? "disposed" : "cancelled";
      else {
        this.state = "error";
        this.error = error instanceof Error ? error : new Error(String(error));
      }
      this._emit({
        phase: this.state,
        loaded: this.progress.loaded,
        total: this.progress.total,
        ...this.error ? { error: this.error.message } : {}
      });
      throw error;
    } finally {
      unsubscribe?.();
      if (abortListener) this._signal.removeEventListener("abort", abortListener);
      this._rejectCancel = null;
    }
  }
  cancel() {
    if (this.state !== "loading") return false;
    this._cancelled = true;
    this._rejectCancel?.(new DOMException("Font loading aborted", "AbortError"));
    return true;
  }
  dispose() {
    if (this.state === "disposed") return false;
    if (this.state === "loading") this.cancel();
    this._lease?.release();
    this._lease = null;
    this.atlas = null;
    this.state = "disposed";
    this._emit({ phase: "disposed", loaded: this.progress.loaded, total: this.progress.total });
    return true;
  }
};

// modules/rendering/index.js
var WHITE5 = Object.freeze([1, 1, 1, 1]);
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
function finite4(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function positive2(value, name) {
  finite4(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}
function color(value) {
  if (!value || value.length !== 4) throw new TypeError("color must be [r,g,b,a]");
  for (let i = 0; i < 4; i++) if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) throw new RangeError("color channels must be in [0,1]");
}
function compile2(gl, type, source) {
  const shader2 = gl.createShader(type);
  if (!shader2) throw new Error("WebGL shader allocation failed");
  gl.shaderSource(shader2, source);
  gl.compileShader(shader2);
  if (!gl.getShaderParameter(shader2, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader2);
    gl.deleteShader(shader2);
    throw new Error(`WebGL shader: ${message}`);
  }
  return shader2;
}
var Renderer2D = class {
  constructor(canvas, { batchVertices = 6144, antialias = true, depth = false, preserveDrawingBuffer = false } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError("canvas is required");
    if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1048576) throw new RangeError("batchVertices must be 6..1048576");
    if (typeof depth !== "boolean") throw new TypeError("depth must be boolean");
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias, depth, stencil: false, preserveDrawingBuffer });
    if (!this.gl) throw new Error("WebGL 1 is required; no Canvas2D fallback");
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
    this.camera = { x: this.width / 2, y: this.height / 2, zoom: 1, rotation: 0 };
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
      if (this.state === "disposed") return;
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
    if (this.state !== "ready") throw new Error(`Renderer is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
  }
  _frame() {
    this._ready();
    if (!this.active) throw new Error("beginFrame is required");
  }
  _initialize() {
    const gl = this.gl;
    let vertex, fragment3;
    try {
      vertex = compile2(gl, gl.VERTEX_SHADER, VERTEX3);
      fragment3 = compile2(gl, gl.FRAGMENT_SHADER, FRAGMENT2);
      this.program = gl.createProgram();
      if (!this.program) throw new Error("WebGL program allocation failed");
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment3);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`WebGL link: ${gl.getProgramInfoLog(this.program)}`);
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment3) gl.deleteShader(fragment3);
    }
    this.buffer = gl.createBuffer();
    if (!this.buffer) throw new Error("WebGL buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    this.stats.bufferAllocations++;
    gl.useProgram(this.program);
    this.instancingExtension = gl.getExtension("ANGLE_instanced_arrays");
    this.attributeLocations = [];
    for (const [name, size, offset] of [["a_position", 2, 0], ["a_uv", 2, 8], ["a_color", 4, 16]]) {
      const location = gl.getAttribLocation(this.program, name);
      this.attributeLocations.push([location, size, offset]);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    this.uProjection = gl.getUniformLocation(this.program, "u_projection");
    this.uTexture = gl.getUniformLocation(this.program, "u_texture");
    gl.uniform1i(this.uTexture, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.white = { width: 1, height: 1, source: new Uint8Array([255, 255, 255, 255]), filter: "nearest", texture: null };
    this._upload(this.white);
    for (const record of this.textures.values()) {
      record.texture = null;
      this._upload(record);
    }
    this.batchTexture = null;
    this.vertexCount = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._projection();
  }
  _projection() {
    const { x, y, zoom, rotation } = this.camera;
    const c = Math.cos(rotation) * zoom, s = Math.sin(rotation) * zoom;
    const m = this.projection, w = this.width, h = this.height;
    m[0] = 2 * c / w;
    m[1] = 2 * s / h;
    m[2] = 0;
    m[3] = 2 * s / w;
    m[4] = -2 * c / h;
    m[5] = 0;
    m[6] = -2 * (c * x + s * y) / w;
    m[7] = 2 * (c * y - s * x) / h;
    m[8] = 1;
    this.gl.useProgram(this.program);
    this.gl.uniformMatrix3fv(this.uProjection, false, m);
  }
  /** CSS viewport dimensions; does not change CSS style. Game controls camera separately. */
  resize(width, height, dpr = 1) {
    this._ready();
    positive2(width, "width");
    positive2(height, "height");
    positive2(dpr, "dpr");
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    const limit = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    if (pixelWidth > limit[0] || pixelHeight > limit[1]) throw new RangeError("viewport exceeds WebGL limits");
    if (this.active) throw new Error("resize must be outside beginFrame/endFrame");
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    this._projection();
  }
  /** Camera center in world units; zoom is CSS pixels per world unit. */
  setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
    this._ready();
    finite4(x, "x");
    finite4(y, "y");
    positive2(zoom, "zoom");
    finite4(rotation, "rotation");
    if (this.active) this.flush();
    this.camera.x = x;
    this.camera.y = y;
    this.camera.zoom = zoom;
    this.camera.rotation = rotation;
    this._projection();
  }
  /** Caller-owned output; no world/simulation state is read or changed. */
  worldToScreenInto(x, y, out) {
    finite4(x, "x");
    finite4(y, "y");
    const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = x - camera.x, dy = y - camera.y;
    out.x = (c * dx + s * dy) * camera.zoom + this.width / 2;
    out.y = (-s * dx + c * dy) * camera.zoom + this.height / 2;
    return out;
  }
  screenToWorldInto(x, y, out) {
    finite4(x, "x");
    finite4(y, "y");
    const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = (x - this.width / 2) / camera.zoom, dy = (y - this.height / 2) / camera.zoom;
    out.x = c * dx - s * dy + camera.x;
    out.y = s * dx + c * dy + camera.y;
    return out;
  }
  _source(source, filter) {
    if (filter !== "nearest" && filter !== "linear") throw new RangeError("filter must be nearest or linear");
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") throw new TypeError("ImageBitmap alpha mode cannot be inspected; use an image/canvas or RGBA bytes");
    const width = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
    const height = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > max || height > max) throw new RangeError("texture dimensions are invalid");
    let retained = source;
    if (source.data !== void 0) {
      if (!(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) || source.data.length !== width * height * 4) throw new TypeError("texture data must be width*height*4 RGBA bytes");
      retained = new Uint8Array(source.data);
      for (let i = 0; i < retained.length; i += 4) {
        const a = retained[i + 3] / 255;
        retained[i] = Math.round(retained[i] * a);
        retained[i + 1] = Math.round(retained[i + 1] * a);
        retained[i + 2] = Math.round(retained[i + 2] * a);
      }
    }
    return { width, height, source: retained, filter, texture: null };
  }
  _upload(record) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL texture allocation failed");
    record.texture = texture;
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(record.source instanceof Uint8Array));
      if (record.source instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, record.width, record.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      const filter = record.filter === "linear" ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL texture upload error ${error}`);
      this.stats.textureUploads++;
      this.stats.totalTextureUploads++;
    } catch (error) {
      gl.deleteTexture(texture);
      record.texture = null;
      throw error;
    }
  }
  /** Loaded origin-clean image/canvas, or {width,height,data: RGBA bytes}. */
  createTexture(source, { filter = "linear" } = {}) {
    this._ready();
    const record = this._source(source, filter);
    if (this.active) this.flush();
    this._upload(record);
    const handle = Object.freeze({ width: record.width, height: record.height });
    this.textures.set(handle, record);
    this.stats.textureCount = this.textures.size;
    return handle;
  }
  /** Replacement dimensions must match the handle. Upload is explicit, never per sprite. */
  updateTexture(handle, source) {
    this._ready();
    const previous = this.textures.get(handle);
    if (!previous) throw new Error("unknown/deleted texture");
    const record = this._source(source, previous.filter);
    if (record.width !== handle.width || record.height !== handle.height) throw new RangeError("texture update dimensions must match");
    if (this.active) this.flush();
    this._upload(record);
    this.gl.deleteTexture(previous.texture);
    this.textures.set(handle, record);
  }
  deleteTexture(handle) {
    if (this.state === "disposed") return false;
    const record = this.textures.get(handle);
    if (!record) return false;
    if (this.active) this.flush();
    this.gl.deleteTexture(record.texture);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    return true;
  }
  /** Returns false while context is lost. Caller skips that frame; restore is automatic. */
  beginFrame(clear = CLEAR) {
    if (this.state === "lost") return false;
    this._ready();
    if (this.active) throw new Error("endFrame is required");
    color(clear);
    this.active = true;
    this.vertexCount = 0;
    this.batchTexture = null;
    const stats = this.stats;
    stats.frame++;
    stats.drawCalls = stats.vertices = stats.uploadedBytes = stats.bufferViews = stats.textureUploads = 0;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }
  _reserve(count, texture) {
    this._frame();
    if (this.batchTexture !== texture || this.vertexCount + count > this.vertices.length / 8) this.flush();
    this.batchTexture = texture;
  }
  _vertex(x, y, u, v, tint) {
    const data = this.vertices;
    let i = this.vertexCount++ * 8;
    data[i++] = x;
    data[i++] = y;
    data[i++] = u;
    data[i++] = v;
    data[i++] = tint[0];
    data[i++] = tint[1];
    data[i++] = tint[2];
    data[i] = tint[3];
  }
  triangle(x0, y0, x1, y1, x2, y2, tint = WHITE5) {
    finite4(x0, "x0");
    finite4(y0, "y0");
    finite4(x1, "x1");
    finite4(y1, "y1");
    finite4(x2, "x2");
    finite4(y2, "y2");
    color(tint);
    this._reserve(3, this.white.texture);
    this._vertex(x0, y0, 0, 0, tint);
    this._vertex(x1, y1, 0, 0, tint);
    this._vertex(x2, y2, 0, 0, tint);
  }
  _quad(texture, x, y, width, height, angle, tint, u0, v0, u1, v1) {
    finite4(x, "x");
    finite4(y, "y");
    positive2(width, "width");
    positive2(height, "height");
    finite4(angle, "angle");
    color(tint);
    this._reserve(6, texture);
    const c = Math.cos(angle), s = Math.sin(angle), hx = width / 2, hy = height / 2;
    const ax = x - c * hx + s * hy, ay = y - s * hx - c * hy;
    const bx = x + c * hx + s * hy, by = y + s * hx - c * hy;
    const cx = x + c * hx - s * hy, cy = y + s * hx + c * hy;
    const dx = x - c * hx - s * hy, dy = y - s * hx + c * hy;
    this._vertex(ax, ay, u0, v0, tint);
    this._vertex(bx, by, u1, v0, tint);
    this._vertex(cx, cy, u1, v1, tint);
    this._vertex(ax, ay, u0, v0, tint);
    this._vertex(cx, cy, u1, v1, tint);
    this._vertex(dx, dy, u0, v1, tint);
  }
  /** Center-anchored rectangle, positive size, clockwise rotation in y-down world. */
  rect(x, y, width, height, tint = WHITE5, angle = 0) {
    this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1);
  }
  /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
  sprite(texture, x, y, width = texture.width, height = texture.height, { angle = 0, tint = WHITE5, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {}) {
    const record = this.textures.get(texture);
    if (!record) throw new Error("unknown/deleted texture");
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1) || Math.min(u0, v0, u1, v1) < 0 || Math.max(u0, v0, u1, v1) > 1) throw new RangeError("UV must be in [0,1]");
    this._quad(record.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
  }
  /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
  ellipse(x, y, radiusX, radiusY, tint = WHITE5, segments = 24) {
    finite4(x, "x");
    finite4(y, "y");
    positive2(radiusX, "radiusX");
    positive2(radiusY, "radiusY");
    color(tint);
    if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) throw new RangeError("segments must be 3..256");
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
      this._reserve(3, this.white.texture);
      this._vertex(x, y, 0, 0, tint);
      this._vertex(x + Math.cos(a) * radiusX, y + Math.sin(a) * radiusY, 0, 0, tint);
      this._vertex(x + Math.cos(b) * radiusX, y + Math.sin(b) * radiusY, 0, 0, tint);
    }
  }
  line(x0, y0, x1, y1, width, tint = WHITE5) {
    finite4(x0, "x0");
    finite4(y0, "y0");
    finite4(x1, "x1");
    finite4(y1, "y1");
    positive2(width, "width");
    color(tint);
    this._frame();
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (!length) return;
    this.rect((x0 + x1) / 2, (y0 + y1) / 2, length, width, tint, Math.atan2(y1 - y0, x1 - x0));
  }
  flush() {
    this._frame();
    if (!this.vertexCount) return;
    const gl = this.gl, view = this.vertices.subarray(0, this.vertexCount * 8);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [location, size, offset] of this.attributeLocations) {
      gl.enableVertexAttribArray(location);
      this.instancingExtension?.vertexAttribDivisorANGLE(location, 0);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.batchTexture);
    gl.uniform1i(this.uTexture, 0);
    gl.uniformMatrix3fv(this.uProjection, false, this.projection);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    this.stats.drawCalls++;
    this.stats.vertices += this.vertexCount;
    this.stats.uploadedBytes += view.byteLength;
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
    const gl = this.gl;
    gl.useProgram(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const record of this.textures.values()) if (record.texture) gl.deleteTexture(record.texture);
    if (this.white?.texture) gl.deleteTexture(this.white.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
  }
  /** Idempotent. Removes context listeners and releases retained sources/GPU resources. */
  dispose() {
    if (this.state === "disposed") return;
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

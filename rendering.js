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
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${message}`);
  }
  return shader;
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
        for (const record of this.pipelines.values()) this._pipeline(record);
        for (const record of this.buffers.values()) {
          record.gpu = this.gl.createBuffer();
          if (!record.gpu) throw new Error("Buffer allocation failed");
          this.gl.bindBuffer(this.gl.ARRAY_BUFFER, record.gpu);
          this.gl.bufferData(this.gl.ARRAY_BUFFER, record.capacity, this.gl.DYNAMIC_DRAW);
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
  _handle(map, handle, name) {
    const record = map.get(handle);
    if (!record) throw new Error(`Unknown/deleted ${name}`);
    return record;
  }
  _pipeline(record) {
    const gl = this.gl;
    let vertex, fragment, program;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, record.vertex);
      fragment = compile(gl, gl.FRAGMENT_SHADER, record.fragment);
      program = gl.createProgram();
      if (!program) throw new Error("Program allocation failed");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
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
      if (fragment) gl.deleteShader(fragment);
    }
  }
  /** Attributes use interleaved FLOAT components, byte offsets and byte stride. */
  createPipeline({ vertex, fragment, stride, attributes, uniforms = {} }) {
    this._ready();
    if (typeof vertex !== "string" || typeof fragment !== "string") throw new TypeError("Shader sources required");
    integer(stride, "stride", 4, 255);
    if (stride % 4) throw new RangeError("stride must align to FLOAT");
    if (!Array.isArray(attributes) || !attributes.length) throw new TypeError("attributes required");
    const names = /* @__PURE__ */ new Set();
    for (const a of attributes) {
      if (typeof a.name !== "string" || !a.name || names.has(a.name)) throw new TypeError("Unique attribute names required");
      names.add(a.name);
      integer(a.size, "attribute size", 1, 4);
      integer(a.offset, "attribute offset", 0, stride - 4);
      if (a.offset % 4 || a.offset + a.size * 4 > stride) throw new RangeError("attribute outside stride");
    }
    if (!uniforms || typeof uniforms !== "object") throw new TypeError("uniform descriptors required");
    for (const type of Object.values(uniforms)) if (!UNIFORMS.has(type)) throw new TypeError(`Unsupported uniform ${type}`);
    const record = { vertex, fragment, stride, attributes: attributes.map((a) => ({ ...a })), uniforms: { ...uniforms }, gpu: null };
    this._pipeline(record);
    const handle = Object.freeze({ stride });
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
    this.buffers.set(handle, { gpu, capacity: capacityBytes, used: 0 });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return handle;
  }
  /** View is uploaded synchronously, never copied into another CPU arena or retained. */
  uploadVertices(handle, data) {
    this._ready();
    const r = this._handle(this.buffers, handle, "buffer");
    if (!(data instanceof Float32Array)) throw new TypeError("Float32Array required");
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
  deleteVertexBuffer(handle) {
    const r = this.buffers.get(handle);
    if (!r) return false;
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
    const gl = this.gl, previous = gl.getParameter(gl.FRAMEBUFFER_BINDING), framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error("Render target framebuffer allocation failed");
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, record.gpu, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Render target framebuffer incomplete: ${status}`);
      record.framebuffer = framebuffer;
    } catch (error) {
      gl.deleteFramebuffer(framebuffer);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    }
  }
  /** Creates a reusable, premultiplied RGBA texture/FBO pair; the handle is also a draw texture. */
  createRenderTarget(width, height, { filter = "linear" } = {}) {
    this._ready();
    integer(width, "render target width", 1, this.maxTextureSize);
    integer(height, "render target height", 1, this.maxTextureSize);
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("filter must be nearest or linear");
    const record = { width, height, format: "rgba", premultiplied: true, source: null, filter, gpu: null, framebuffer: null };
    this._texture(record);
    try {
      this._renderTarget(record);
    } catch (error) {
      this.gl.deleteTexture(record.gpu);
      record.gpu = null;
      throw error;
    }
    const handle = Object.freeze({ width, height });
    this.textures.set(handle, record);
    this.renderTargets.set(handle, record);
    this.stats.textureCount = this.textures.size;
    this.stats.renderTargetCount = this.renderTargets.size;
    this.stats.gpuRenderTargetBytes += width * height * 4;
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
    this.gl.deleteTexture(record.gpu);
    this.renderTargets.delete(handle);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    this.stats.renderTargetCount = this.renderTargets.size;
    this.stats.gpuRenderTargetBytes -= record.width * record.height * 4;
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
    for (const name of ["drawCalls", "vertices", "bufferUploads", "bufferBytes", "textureUploads", "textureBytes", "frameCopies"]) this.stats[name] = 0;
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
  draw({ pipeline, buffer, first = 0, count, uniforms = {}, textures = [], blend = "source-over", depth = false, stencil = false, colorMask = ALL_COLOR, filter } = {}) {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    const p = this._handle(this.pipelines, pipeline, "pipeline"), b = this._handle(this.buffers, buffer, "buffer");
    integer(first, "first");
    integer(count, "count");
    if (first + count > b.used / p.stride) throw new RangeError("draw exceeds uploaded vertices");
    if (depth && !this.depthAvailable) throw new Error("Context has no depth buffer");
    if (stencil && !this.stencilAvailable) throw new Error("Context has no stencil buffer");
    if (blend !== false && !BLENDS.has(blend)) throw new TypeError("Unsupported blend");
    if (depth && !FUNCTIONS[depth.func ?? "lequal"]) throw new TypeError("Unsupported depth function");
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
    const gl = this.gl;
    gl.useProgram(p.gpu);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.gpu);
    for (const index of this.enabledAttributes) gl.disableVertexAttribArray(index);
    this.enabledAttributes.clear();
    for (const a of p.locations) if (a.location >= 0) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribPointer(a.location, a.size, gl.FLOAT, false, p.stride, a.offset);
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
    if (depth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl[FUNCTIONS[depth.func ?? "lequal"]]);
      gl.depthMask(depth.write ?? true);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
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
    gl.drawArrays(gl.TRIANGLES, first, count);
    this.stats.drawCalls++;
    this.stats.vertices += count;
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
    for (let i = 0; i < this.maxTextures; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    for (const r of this.pipelines.values()) gl.deleteProgram(r.gpu);
    for (const r of this.buffers.values()) gl.deleteBuffer(r.gpu);
    for (const r of this.renderTargets.values()) gl.deleteFramebuffer(r.framebuffer);
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
var FRAGMENT = `precision mediump float; uniform sampler2D u_texture; uniform float u_textured; uniform float u_radial; uniform float u_whiteFlash;
varying vec2 v_uv; varying vec4 v_color; void main(){vec2 uv=u_radial>0.5?vec2(clamp(length(v_uv),0.0,1.0),0.5):v_uv;vec4 t=mix(vec4(1.0),texture2D(u_texture,uv),u_textured);float a=t.a*v_color.a;vec3 rgb=mix(t.rgb*v_color.rgb*v_color.a,vec3(a),u_whiteFlash);gl_FragColor=vec4(rgb,a);}`;
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
function tessellate(contours, rule) {
  const edges = [], ys = [];
  for (const contour of contours) {
    if (contour.length < 3) continue;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length];
      if (Math.abs(a.y - b.y) < 1e-9) continue;
      edges.push({ a, b, sign: b.y > a.y ? 1 : -1 });
      ys.push(a.y, b.y);
    }
  }
  ys.sort((a, b) => a - b);
  const levels = ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1e-8), triangles = [];
  for (let band = 0; band + 1 < levels.length; band++) {
    const y0 = levels[band], y1 = levels[band + 1], ym = (y0 + y1) / 2;
    if (y1 - y0 < 1e-8) continue;
    const active = edges.filter((e) => ym > Math.min(e.a.y, e.b.y) && ym < Math.max(e.a.y, e.b.y)).map((e) => ({ edge: e, x: xAt(e, ym) })).sort((a, b) => a.x - b.x);
    let winding = 0, inside = false, left = null;
    for (const item of active) {
      const before = rule === "evenodd" ? inside : winding !== 0;
      if (rule === "evenodd") inside = !inside;
      else winding += item.edge.sign;
      const after = rule === "evenodd" ? inside : winding !== 0;
      if (!before && after) left = item.edge;
      else if (before && !after && left) {
        const a = { x: xAt(left, y0), y: y0 }, b = { x: xAt(item.edge, y0), y: y0 }, c = { x: xAt(item.edge, y1), y: y1 }, d = { x: xAt(left, y1), y: y1 };
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
var VectorRenderer = class {
  constructor(device, { initialVertices = 4096, maxVertices = 262144, glyphAtlas = null } = {}) {
    if (!device?.createPipeline || !device?.draw) throw new TypeError("A WebGLDevice is required");
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3 || !Number.isSafeInteger(initialVertices) || initialVertices < 3 || initialVertices > maxVertices) throw new RangeError("3 <= initialVertices <= maxVertices is required");
    if (initialVertices * 32 > device.maxBufferBytes) throw new RangeError("initial vector buffer exceeds the device byte limit");
    this.device = device;
    this.gl = device.gl;
    this.canvas = device.canvas;
    this.glyphAtlas = glyphAtlas;
    this.maxVertices = maxVertices;
    this.pipeline = device.createPipeline({ vertex: VERTEX, fragment: FRAGMENT, stride: 32, attributes: [{ name: "a_position", size: 2, offset: 0 }, { name: "a_uv", size: 2, offset: 8 }, { name: "a_color", size: 4, offset: 16 }], uniforms: { u_projection: "matrix3fv", u_texture: "1i", u_textured: "1f", u_radial: "1f", u_whiteFlash: "1f" } });
    this.buffer = device.createVertexBuffer({ capacityBytes: initialVertices * 32 });
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
    this.state = "ready";
    this.projection = new Float32Array([2 / this.canvas.width, 0, 0, 0, -2 / this.canvas.height, 0, -1, 1, 1]);
  }
  _frame() {
    if (this.state !== "ready") throw new Error(`VectorRenderer is ${this.state}`);
    if (!this.device.active) throw new Error("WebGLDevice.beginFrame is required");
    const g = [...this.groups].reverse().find((group) => !group.direct);
    if (g) this._setProjection(g.bounds, g.target);
    else this._setProjection(null);
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
    this.stack.push({ matrix: this.matrix.slice(), clips: this.clips.map((polygon) => polygon.map((p) => ({ ...p }))) });
  }
  restore() {
    this._frame();
    const s = this.stack.pop();
    if (!s) throw new Error("restore without save");
    this.matrix = s.matrix;
    this.clips = s.clips;
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
    this.clips.push([point(this.matrix, x, y), point(this.matrix, x + width, y), point(this.matrix, x + width, y + height), point(this.matrix, x, y + height)]);
  }
  /** Add the current transformed path contours to the clip stack. */
  clip(rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") throw new TypeError("rule must be nonzero or evenodd");
    const contours = this.path.filter((path) => path.length >= 3).map((path) => path.map((p) => ({ ...p })));
    if (!contours.length) return;
    this.clips.push(...contours);
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
    const poly = this.clips.length ? this._clipTriangle(a, b, c, uv) : uv ? [a, b, c].map((p, i) => ({ ...p, u: uv[i][0], v: uv[i][1] })) : [a, b, c];
    for (let i = 1; i + 1 < poly.length; i++) {
      if (this.count + 3 > this.maxVertices) throw new RangeError("VectorRenderer vertex capacity exceeded");
      if (this.count + 3 > this.vertices.length / 8) {
        const size = Math.min(this.maxVertices, Math.max(this.count + 3, this.vertices.length / 4));
        const next = new Float32Array(size * 8);
        next.set(this.vertices);
        this.vertices = next;
      }
      for (const p of [poly[0], poly[i], poly[i + 1]]) {
        const k = this.count++ * 8;
        this.vertices[k] = p.x;
        this.vertices[k + 1] = p.y;
        this.vertices[k + 2] = p.u ?? 0;
        this.vertices[k + 3] = p.v ?? 0;
        this.vertices.set(color2, k + 4);
      }
    }
  }
  _submit() {
    if (!this.count) return;
    const texture = this.activeTexture ?? this.white;
    this.device.uploadVertices(this.buffer, this.vertices.subarray(0, this.count * 8));
    this.device.draw({ pipeline: this.pipeline, buffer: this.buffer, count: this.count, uniforms: { u_projection: this.projection, u_texture: 0, u_textured: texture === this.white ? 0 : 1, u_radial: this.activeRadial ? 1 : 0, u_whiteFlash: this.activeWhiteFlash ? 1 : 0 }, textures: [texture], blend: "source-over" });
    this.count = 0;
  }
  _useTexture(texture, { radial = false, whiteFlash = false } = {}) {
    if (this.activeTexture !== texture || this.activeRadial !== radial || this.activeWhiteFlash !== whiteFlash) this._submit();
    this.activeTexture = texture;
    this.activeRadial = radial;
    this.activeWhiteFlash = whiteFlash;
  }
  fill(colorValue = [0, 0, 0, 1], rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") throw new TypeError("rule must be nonzero or evenodd");
    this._useTexture(this.white);
    const col = rgba(colorValue), vertices = tessellate(this.path, rule);
    for (let i = 0; i + 2 < vertices.length; i += 3) this._emitTriangle(vertices[i], vertices[i + 1], vertices[i + 2], col);
    this._submit();
  }
  fillRadialGradient({ texture, centerX, centerY, radius, matrixInverse, color: color2 = [1, 1, 1, 1], whiteFlash = false, rule = "nonzero" } = {}) {
    this._frame();
    if (!texture || !Number.isFinite(radius) || radius < 0 || !matrixInverse) throw new TypeError("valid radial gradient texture and transform are required");
    this._useTexture(texture, { radial: true, whiteFlash });
    const vertices = tessellate(this.path, rule), uv = (p) => {
      const m = matrixInverse, x = m[0] * p.x + m[2] * p.y + m[4], y = m[1] * p.x + m[3] * p.y + m[5], r = Math.max(1e-8, radius);
      return [(x - centerX) / r, (y - centerY) / r];
    };
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      const a = vertices[i], b = vertices[i + 1], c = vertices[i + 2];
      this._emitTriangle(a, b, c, color2, [uv(a), uv(b), uv(c)]);
    }
    this._submit();
  }
  stroke(colorValue = [0, 0, 0, 1], width = 1, { lineCap = "butt", lineJoin = "miter", miterLimit = 10 } = {}) {
    this._frame();
    this._useTexture(this.white);
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
    this._submit();
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
    const allocation = (n) => Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(n)));
    const needW = allocation(width), needH = allocation(height);
    if (!target || target.width < width || target.height < height) {
      if (target) this.device.deleteRenderTarget(target);
      target = this.groupTargets[depth] = this.device.createRenderTarget(needW, needH, { filter: "nearest" });
    }
    const group = { target, opacity, bounds: { x, y, width, height }, matrix: this.matrix.slice(), clips: this.clips, projection: this.projection.slice() };
    this.device.bindRenderTarget(target);
    this.device.clear({ color: [0, 0, 0, 0] });
    this.groups.push(group);
    this.clips = [...this.clips, [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }]];
    this._setProjection(group.bounds, target);
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
    for (const target of this.groupTargets) this.device.deleteRenderTarget(target);
    this.device.deleteVertexBuffer(this.buffer);
    this.device.deletePipeline(this.pipeline);
    this.device.deleteTexture(this.white);
    this.buffer = this.pipeline = this.white = null;
    this.state = "disposed";
  }
};

// modules/rendering/vector-context.js
var TAU = Math.PI * 2;
var IDENTITY2 = Object.freeze([1, 0, 0, 1, 0, 0]);
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
    if (Math.hypot(x1 - x0, y1 - y0) > 1e-8) throw new Error("Radial gradients require concentric circles");
    for (const [n, v] of Object.entries({ x0, y0, r0, x1, y1, r1 })) finite2(v, n);
    if (r0 < 0 || r1 < 0) throw new RangeError("Gradient radii must be non-negative");
    this.matrix = matrix.slice();
    this.x = x1;
    this.y = y1;
    this.r0 = r0;
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
      const t = (i / 255 * this.r1 - this.r0) / Math.max(1e-8, this.r1 - this.r0);
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
var VectorContext = class {
  constructor(device, { vectorRenderer = null, glyphAtlas = vectorRenderer?.glyphAtlas ?? null, initialVertices = 4096, maxVertices = 262144, onError = null } = {}) {
    if (!device?.beginFrame || !device?.endFrame || !device?.createVertexBuffer) throw new TypeError("WebGLDevice is required");
    if (vectorRenderer && vectorRenderer.device !== device) throw new TypeError("vectorRenderer must use the supplied WebGLDevice");
    this.device = device;
    this.canvas = device.canvas;
    this.vector = vectorRenderer ?? new VectorRenderer(device, { initialVertices, maxVertices, glyphAtlas });
    this.ownsVector = !vectorRenderer;
    this.glyphAtlas = glyphAtlas ?? this.vector.glyphAtlas;
    this.onError = typeof onError === "function" ? onError : null;
    this.active = false;
    this.state = "ready";
    this.frame = 0;
    this.pathCount = 0;
    this.staticMeshes = /* @__PURE__ */ new Set();
    this.deferredMeshes = [];
    this.gradientTextures = /* @__PURE__ */ new Map();
    this.onLost = (event) => {
      event.preventDefault();
      this.active = false;
      this.state = "lost";
      this._releaseGradientTextures();
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
    if (!(v instanceof RadialGradient)) normalizeColor(v);
    this._fillStyle = v;
  }
  get strokeStyle() {
    return this._strokeStyle;
  }
  set strokeStyle(v) {
    normalizeColor(v);
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
  _frame() {
    if (!this.active || this.device.state !== "ready") throw new Error("VectorContext frame is unavailable");
  }
  _paint(style) {
    if (style instanceof RadialGradient) throw new TypeError("RadialGradient paint must be submitted through fill()");
    const color2 = normalizeColor(this.forceColor ?? style);
    color2[3] *= this._globalAlpha;
    if (this._filter === "brightness(0) invert(1)") color2[0] = color2[1] = color2[2] = 1;
    return color2;
  }
  _gradientPaint(gradient) {
    let cached = this.gradientTextures.get(gradient);
    if (!cached) {
      cached = { texture: this.device.createTexture({ width: 256, height: 1, data: gradient.raster() }, { format: "rgba", premultiplied: true, filter: "linear" }), revision: gradient.revision };
      this.gradientTextures.set(gradient, cached);
    } else if (cached.revision !== gradient.revision) {
      this.device.updateTexture(cached.texture, { width: 256, height: 1, data: gradient.raster() });
      cached.revision = gradient.revision;
    }
    const matrixInverse = invert(gradient.matrix);
    if (!matrixInverse) throw new RangeError("Radial gradient transform is singular");
    const color2 = normalizeColor(this.forceColor ?? [1, 1, 1, 1]);
    color2[3] *= this._globalAlpha;
    return { texture: cached.texture, centerX: gradient.x, centerY: gradient.y, radius: gradient.r1, matrixInverse, color: color2, whiteFlash: this._filter === "brightness(0) invert(1)" };
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
      this.vector.flush();
      const stats = this.device.endFrame();
      this.active = false;
      for (const mesh of this.deferredMeshes.splice(0)) this.deleteStaticMesh(mesh);
      this.frameStats = { drawCalls: stats.drawCalls, vertices: stats.vertices, uploadedBytes: stats.bufferBytes ?? stats.uploadedBytes ?? 0, textureUploads: stats.textureUploads ?? 0, textureBytes: stats.textureBytes ?? 0, gpuRenderTargetBytes: stats.gpuRenderTargetBytes ?? 0, paths: this.pathCount };
      this.total.frames++;
      this.total.drawCalls += this.frameStats.drawCalls;
      this.total.vertices += this.frameStats.vertices;
      this.total.uploadedBytes += this.frameStats.uploadedBytes;
      this._releaseGradientTextures();
      return this.stats();
    } catch (error) {
      this.active = false;
      this._releaseGradientTextures();
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
    this.vector.restore();
    Object.assign(this, { _fillStyle: s.fillStyle, _strokeStyle: s.strokeStyle, _globalAlpha: s.globalAlpha, _lineWidth: s.lineWidth, _lineCap: s.lineCap, _lineJoin: s.lineJoin, _miterLimit: s.miterLimit, _lineDash: s.lineDash, _lineDashOffset: s.lineDashOffset, _font: s.font, _textAlign: s.textAlign, _textBaseline: s.textBaseline, _direction: s.direction, _filter: s.filter, forceColor: s.forceColor });
  }
  setTransform(a, b, c, d, e, f) {
    this.vector.setTransform(a, b, c, d, e, f);
  }
  resetTransform() {
    this.vector.setTransform(...IDENTITY2);
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
    if (this._fillStyle instanceof RadialGradient) this.vector.fillRadialGradient({ ...this._gradientPaint(this._fillStyle), rule });
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
    if (!(this._lineWidth > 0)) return;
    const m = this.vector.matrix, width = this._lineWidth * Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])), paint = this._paint(this._strokeStyle), style = { lineCap: this._lineCap, lineJoin: this._lineJoin, miterLimit: this._miterLimit }, dash = this._lineDash, period = dash.reduce((a, b) => a + b, 0);
    if (!dash.length || !period) {
      this.vector.stroke(paint, width, style);
      return;
    }
    const v = this.vector, original = v.path, matrix = v.matrix.slice();
    v.beginPath();
    v.setTransform(...IDENTITY2);
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
    v.stroke(paint, width, style);
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
  clipRect(x, y, w, h) {
    this._frame();
    this.vector.clipRect(x, y, w, h);
  }
  fillTriangleFan(points, paint = this._fillStyle) {
    this._frame();
    if (points.length < 3) return;
    this.vector.triangleFan(points, this._paint(paint));
  }
  beginGroup(opacity = 1, bounds = null) {
    this._frame();
    this.vector.beginGroup(opacity, bounds);
  }
  endGroup() {
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
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return new RadialGradient(this.vector.matrix, x0, y0, r0, x1, y1, r1);
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
    this.vector.flush();
    const values = { ...uniforms };
    if (projection) values.u_projection = projection;
    this.device.draw({ pipeline, buffer: mesh.buffer, count: mesh.count, uniforms: values, textures, blend, depth });
  }
  stats() {
    return { backend: "webgl1", available: this.device.state === "ready", contextLost: this.device.state === "lost", failure: this.device.failure ?? null, frame: this.frame, ...this.frameStats, stagingBytes: this.vector.vertices.byteLength, gpuBufferBytes: this.device.stats.gpuBufferBytes ?? 0, gpuRenderTargetBytes: this.device.stats.gpuRenderTargetBytes ?? 0, textureCount: this.device.stats.textureCount ?? 0, activeGradientTextureCount: this.gradientTextures.size, renderTargetCount: this.device.stats.renderTargetCount ?? 0, bufferAllocations: this.device.stats.bufferAllocations ?? 0, totals: { ...this.total } };
  }
  dispose() {
    if (this.state === "disposed") return;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
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
var WHITE2 = Object.freeze([1, 1, 1, 1]);
var CLEAR = Object.freeze([0, 0, 0, 0]);
var VERTEX2 = `
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
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader: ${message}`);
  }
  return shader;
}
var Renderer2D = class {
  constructor(canvas, { batchVertices = 6144, antialias = true, preserveDrawingBuffer = false } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError("canvas is required");
    if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1048576) throw new RangeError("batchVertices must be 6..1048576");
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias, depth: false, stencil: false, preserveDrawingBuffer });
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
    let vertex, fragment;
    try {
      vertex = compile2(gl, gl.VERTEX_SHADER, VERTEX2);
      fragment = compile2(gl, gl.FRAGMENT_SHADER, FRAGMENT2);
      this.program = gl.createProgram();
      if (!this.program) throw new Error("WebGL program allocation failed");
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`WebGL link: ${gl.getProgramInfoLog(this.program)}`);
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
    this.buffer = gl.createBuffer();
    if (!this.buffer) throw new Error("WebGL buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    this.stats.bufferAllocations++;
    gl.useProgram(this.program);
    for (const [name, size, offset] of [["a_position", 2, 0], ["a_uv", 2, 8], ["a_color", 4, 16]]) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    this.uProjection = gl.getUniformLocation(this.program, "u_projection");
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
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
  triangle(x0, y0, x1, y1, x2, y2, tint = WHITE2) {
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
  rect(x, y, width, height, tint = WHITE2, angle = 0) {
    this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1);
  }
  /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
  sprite(texture, x, y, width = texture.width, height = texture.height, { angle = 0, tint = WHITE2, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {}) {
    const record = this.textures.get(texture);
    if (!record) throw new Error("unknown/deleted texture");
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1) || Math.min(u0, v0, u1, v1) < 0 || Math.max(u0, v0, u1, v1) > 1) throw new RangeError("UV must be in [0,1]");
    this._quad(record.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
  }
  /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
  ellipse(x, y, radiusX, radiusY, tint = WHITE2, segments = 24) {
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
  line(x0, y0, x1, y1, width, tint = WHITE2) {
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
    gl.bindTexture(gl.TEXTURE_2D, this.batchTexture);
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
  PrimitivePainter,
  Renderer2D,
  VectorContext,
  VectorRenderer,
  WebGLDevice
};

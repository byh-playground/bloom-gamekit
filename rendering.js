// modules/rendering/texture-atlas.js
var TextureAtlasArray = class {
  constructor(device, { width = 2048, height = 1024, layers = 2, gutter = 1, filter = "linear" } = {}) {
    if (!device?.createTextureArray || !device.updateTextureRegion) {
      throw new TypeError("A WebGLDevice with texture arrays is required");
    }
    if (!Number.isSafeInteger(gutter) || gutter < 0) {
      throw new RangeError("gutter must be a non-negative integer");
    }
    this.device = device;
    this.gutter = gutter;
    this.width = width;
    this.height = height;
    this.texture = device.createTextureArray(width, height, layers, { filter });
    this.layerShelves = Array.from({ length: layers }, () => ({ shelves: [], usedHeight: 0 }));
    this.free = /* @__PURE__ */ new Map();
    this.regions = /* @__PURE__ */ new Set();
    this.written = /* @__PURE__ */ new WeakSet();
    this.disposed = false;
  }
  /** Reserves width x height content pixels. Returns the content rectangle, its normalized `uvRect` and its sampling `filter`
   * (`nearest` snaps the lookup to texel centers in the shader, since the array has one hardware filter). */
  allocate(width, height, { filter = "linear" } = {}) {
    this._live();
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("filter must be nearest or linear");
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new RangeError("Region size must be positive integers");
    }
    const G = this.gutter, PW = width + G * 2, PH = height + G * 2, KEY = `${PW}x${PH}`, REUSED = this.free.get(KEY)?.pop();
    if (REUSED) {
      return this._region(REUSED.layer, REUSED.x, REUSED.y, width, height, filter);
    }
    for (let layer = 0; layer < this.layerShelves.length; layer++) {
      const STATE = this.layerShelves[layer];
      for (const SHELF of STATE.shelves) {
        if (SHELF.height >= PH && SHELF.x + PW <= this.width) {
          const X = SHELF.x;
          SHELF.x += PW;
          return this._region(layer, X, SHELF.y, width, height, filter);
        }
      }
      if (PW <= this.width && STATE.usedHeight + PH <= this.height) {
        const SHELF = { y: STATE.usedHeight, height: PH, x: PW };
        STATE.shelves.push(SHELF);
        STATE.usedHeight += PH;
        return this._region(layer, 0, SHELF.y, width, height, filter);
      }
    }
    throw new RangeError("Texture atlas array is full");
  }
  _region(layer, paddedX, paddedY, width, height, filter) {
    const G = this.gutter, REGION = Object.freeze({
      layer,
      x: paddedX + G,
      y: paddedY + G,
      width,
      height,
      filter,
      atlas: this,
      paddedX,
      paddedY,
      uvRect: Object.freeze([
        (paddedX + G) / this.width,
        (paddedY + G) / this.height,
        width / this.width,
        height / this.height
      ])
    });
    this.regions.add(REGION);
    return REGION;
  }
  /**
   * Writes the region's pixels. `source` is a DOM image/canvas or `{ width, height, data }` RGBA bytes. A source
   * of the region size fills it; a smaller source at content offset `x`, `y` updates only that rectangle.
   * With `extendEdges`, a whole-region byte source also fills the gutter with its edge pixels (clamp-to-edge look).
   */
  upload(region, source, { premultiplied = false, extendEdges = false, x = 0, y = 0 } = {}) {
    this._live();
    if (!this.regions.has(region)) {
      throw new TypeError("A live region from this atlas is required");
    }
    if (this.written.has(region) && this.device.active) {
      this.device.flushBatchers("atlasRegionUpdate");
    }
    this.written.add(region);
    const G = this.gutter, WIDTH = source?.naturalWidth ?? source?.width, HEIGHT = source?.naturalHeight ?? source?.height;
    if (x !== 0 || y !== 0 || WIDTH !== region.width || HEIGHT !== region.height) {
      if (extendEdges) {
        throw new TypeError("extendEdges requires a whole-region upload");
      }
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || !(x + WIDTH <= region.width) || !(y + HEIGHT <= region.height)) {
        throw new RangeError("Upload rectangle must lie inside the region");
      }
      this.device.updateTextureRegion(this.texture, region.layer, region.x + x, region.y + y, source, {
        premultiplied
      });
      return;
    }
    if (source.data === void 0) {
      if (extendEdges) {
        throw new TypeError("extendEdges requires RGBA byte data");
      }
      this.device.updateTextureRegion(this.texture, region.layer, region.x, region.y, source, { premultiplied });
      return;
    }
    if (!G) {
      this.device.updateTextureRegion(this.texture, region.layer, region.x, region.y, source, { premultiplied });
      return;
    }
    const PW = region.width + G * 2, PH = region.height + G * 2, PADDED = new Uint8Array(PW * PH * 4);
    for (let y2 = 0; y2 < PH; y2++) {
      for (let x2 = 0; x2 < PW; x2++) {
        const SX = x2 - G, SY = y2 - G;
        const INSIDE = SX >= 0 && SY >= 0 && SX < region.width && SY < region.height;
        if (!INSIDE && !extendEdges) {
          continue;
        }
        const FROM = (Math.min(region.height - 1, Math.max(0, SY)) * region.width + Math.min(region.width - 1, Math.max(0, SX))) * 4;
        PADDED.set(source.data.subarray(FROM, FROM + 4), (y2 * PW + x2) * 4);
      }
    }
    this.device.updateTextureRegion(
      this.texture,
      region.layer,
      region.paddedX,
      region.paddedY,
      { width: PW, height: PH, data: PADDED },
      { premultiplied }
    );
  }
  /**
   * Frees the region. Its pixels are cleared and the rectangle is reused for the next same-size allocation; when
   * the last region goes, the array itself is deleted and the device creates a fresh one on next use.
   */
  release(region) {
    if (this.disposed || !this.regions.delete(region)) {
      return false;
    }
    if (!this.regions.size) {
      this.dispose();
      return true;
    }
    if (this.device.active) {
      this.device.flushBatchers("atlasRegionRelease");
    }
    const G = this.gutter, PW = region.width + G * 2, PH = region.height + G * 2;
    this.device.clearTextureRegion(this.texture, region.layer, region.paddedX, region.paddedY, PW, PH);
    const KEY = `${PW}x${PH}`;
    if (!this.free.has(KEY)) {
      this.free.set(KEY, []);
    }
    this.free.get(KEY).push({ layer: region.layer, x: region.paddedX, y: region.paddedY });
    return true;
  }
  get stats() {
    return {
      layers: this.layerShelves.length,
      liveRegions: this.regions.size,
      bytes: this.width * this.height * 4 * this.layerShelves.length
    };
  }
  _live() {
    if (this.disposed) {
      throw new Error("TextureAtlasArray is disposed");
    }
  }
  dispose() {
    if (this.disposed) {
      return false;
    }
    this.disposed = true;
    this.regions.clear();
    this.device.textureAtlasDisposed(this);
    return true;
  }
};

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
function normalizeShader(source, fragment2) {
  if (/^\s*#version\s+300\s+es\b/.test(source)) {
    return source.trimStart();
  }
  if (/^\s*#version\s+100\b/.test(source)) {
    source = source.replace(/^\s*#version\s+100[^\r\n]*(?:\r?\n|$)/, "");
  } else if (/^\s*#version\b/.test(source)) {
    throw new Error("Only GLSL ES 100 and 300 shaders are supported");
  }
  let converted = source.replace(/^\s*#extension\s+GL_OES_standard_derivatives\s*:\s*enable\s*$/gm, "").replace(/\battribute\b/g, "in").replace(/\bvarying\b/g, fragment2 ? "in" : "out").replace(/\btexture2D\b/g, "texture").replace(/\btextureCube\b/g, "texture");
  if (fragment2) {
    converted = converted.replace(/\bgl_FragColor\b/g, "_deviceFragColor");
    return `#version 300 es
precision mediump float;
out vec4 _deviceFragColor;
${converted}`;
  }
  return `#version 300 es
${converted}`;
}
function compile(gl, type, source) {
  const SHADER = gl.createShader(type);
  if (!SHADER) {
    throw new Error("Shader allocation failed");
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
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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
    maxBufferBytes = 128 * 1024 * 1024,
    textureAtlas = {}
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
    this.textureAtlasOptions = { ...textureAtlas };
    this._textureAtlas = null;
    this.batchers = /* @__PURE__ */ new Set();
    integer(maxTextures, "maxTextures", 1, 32);
    integer(maxBufferBytes, "maxBufferBytes", 4);
    this.canvas = canvas;
    this.maxBufferBytes = maxBufferBytes;
    this.requestedMaxTextures = maxTextures;
    this.gl = canvas.getContext("webgl2", {
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
      throw new Error("WebGL 2 required");
    }
    this.instancingSupported = true;
    this.floatRenderTargetsSupported = !!this.gl.getExtension("EXT_color_buffer_float");
    this.vertexArray = this.gl.createVertexArray();
    if (!this.vertexArray) {
      throw new Error("Vertex array allocation failed");
    }
    this.maxVertexAttributes = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
    this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.maxArrayTextureLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.depthAvailable = !!this.gl.getContextAttributes().depth;
    this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
    this.state = "ready";
    this.failure = null;
    this.active = false;
    this.boundTextureCount = 0;
    this.arrayTextureUnits = /* @__PURE__ */ new Set();
    this.pipelines = /* @__PURE__ */ new Map();
    this.buffers = /* @__PURE__ */ new Map();
    this.textures = /* @__PURE__ */ new Map();
    this.renderTargets = /* @__PURE__ */ new Map();
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
        this.boundTextureCount = 0;
        this.arrayTextureUnits.clear();
        this.floatRenderTargetsSupported = !!this.gl.getExtension("EXT_color_buffer_float");
        this.maxTextures = Math.min(
          this.requestedMaxTextures,
          this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS)
        );
        this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
        this.maxArrayTextureLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS);
        this.maxVertexAttributes = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
        this.depthAvailable = !!this.gl.getContextAttributes().depth;
        this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
        this.vertexArray = this.gl.createVertexArray();
        if (!this.vertexArray) {
          throw new Error("Vertex array allocation failed");
        }
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
          RECORD.framebuffer = null;
          RECORD.stencilBuffer = null;
          if (RECORD.format === "rgba32f" && !this.floatRenderTargetsSupported) {
            RECORD.available = false;
            continue;
          }
          try {
            this._renderTarget(RECORD);
            RECORD.available = true;
          } catch (error) {
            if (RECORD.format !== "rgba32f") {
              throw error;
            }
            RECORD.available = false;
          }
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
    let fragment2;
    let program;
    try {
      vertex = compile(GL, GL.VERTEX_SHADER, record.vertex);
      fragment2 = compile(GL, GL.FRAGMENT_SHADER, record.fragment);
      program = GL.createProgram();
      if (!program) {
        throw new Error("Program allocation failed");
      }
      GL.attachShader(program, vertex);
      GL.attachShader(program, fragment2);
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
      if (fragment2) {
        GL.deleteShader(fragment2);
      }
    }
  }
  /** Attributes use interleaved FLOAT components and byte offsets in their vertex/instance source. */
  createPipeline({ vertex, fragment: fragment2, stride, instanceStride = 0, attributes, uniforms = {} }) {
    this._ready();
    if (typeof vertex !== "string" || typeof fragment2 !== "string") {
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
      fragment: fragment2,
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
    GL.bindVertexArray(null);
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
    GL.bindVertexArray(null);
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
    const GL = this.gl;
    if (target === GL.ARRAY_BUFFER && this.state === "ready" && this.vertexArray && !GL.isContextLost()) {
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
      this._bindTexture(0, record);
      this.boundTextureCount = Math.max(1, this.boundTextureCount);
      this._resetUnpackState();
      if (record.target === "array") {
        GL.texStorage3D(GL.TEXTURE_2D_ARRAY, 1, GL.RGBA8, record.width, record.height, record.layers);
        for (let layer = 0; layer < record.layers; layer++) {
          this._uploadLayer(record, layer);
        }
      } else {
        const PIXELS = record.source === null || record.source instanceof Uint8Array || record.source instanceof Float32Array, FORMAT = record.copyFormat === "rgb" ? GL.RGB : record.format === "rgba" || record.format === "rgba32f" ? GL.RGBA : GL.LUMINANCE, INTERNAL = record.copyFormat === "rgb" ? GL.RGB8 : record.format === "rgba32f" ? GL.RGBA32F : record.format === "rgba" ? GL.RGBA8 : GL.LUMINANCE, TYPE = record.format === "rgba32f" ? GL.FLOAT : GL.UNSIGNED_BYTE;
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
            record.source
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
      if (record.kind === "image" && record.source !== null) {
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
    return record.target === "array" ? this.gl.TEXTURE_2D_ARRAY : this.gl.TEXTURE_2D;
  }
  /** Binds a record to a texture unit; leaves that unit active. */
  _bindTexture(unit, record) {
    const GL = this.gl;
    GL.activeTexture(GL.TEXTURE0 + unit);
    GL.bindTexture(this._glTarget(record), record.gpu);
    if (record.target === "array") {
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
    const GL = this.gl, LAYER = record.layerSources[layer];
    if (LAYER === null) {
      return;
    }
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
      LAYER.source
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
      region.source
    );
    this.stats.textureUploads++;
    this.stats.textureBytes += region.width * region.height * 4;
    this.stats.imageTexUploadCount++;
    this.stats.imageTexUploadBytes += region.width * region.height * 4;
  }
  _textureBytes(record) {
    return record.width * record.height * (record.layers ?? 1) * (record.copyFormat === "rgb" ? 3 : record.format === "rgba32f" ? 16 : record.format === "rgba" ? 4 : 1);
  }
  _filter(filter, record) {
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("filter must be nearest or linear");
    }
    const GL = this.gl, TARGET = this._glTarget(record), VALUE = filter === "nearest" ? GL.NEAREST : GL.LINEAR;
    GL.texParameteri(TARGET, GL.TEXTURE_MIN_FILTER, VALUE);
    GL.texParameteri(TARGET, GL.TEXTURE_MAG_FILTER, VALUE);
  }
  _renderTarget(record) {
    const GL = this.gl, PREVIOUS = GL.getParameter(GL.FRAMEBUFFER_BINDING), PREVIOUS_RENDERBUFFER = GL.getParameter(GL.RENDERBUFFER_BINDING), FRAMEBUFFER_LOCAL = GL.createFramebuffer();
    let stencilBuffer = null;
    if (!FRAMEBUFFER_LOCAL) {
      throw new Error("Render target framebuffer allocation failed");
    }
    try {
      GL.bindFramebuffer(GL.FRAMEBUFFER, FRAMEBUFFER_LOCAL);
      if (record.arrayRecord) {
        GL.framebufferTextureLayer(
          GL.FRAMEBUFFER,
          GL.COLOR_ATTACHMENT0,
          record.arrayRecord.gpu,
          0,
          record.layer
        );
      } else {
        GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, record.gpu, 0);
      }
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
  /** Creates a reusable RGBA texture/FBO pair; the handle is also a draw texture. */
  createRenderTarget(width, height, { format = "rgba", filter, stencil = false } = {}) {
    this._ready();
    integer(width, "render target width", 1, this.maxTextureSize);
    integer(height, "render target height", 1, this.maxTextureSize);
    filter = filter ?? (format === "rgba32f" ? "nearest" : "linear");
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("filter must be nearest or linear");
    }
    if (typeof stencil !== "boolean") {
      throw new TypeError("stencil must be boolean");
    }
    if (stencil && !this.stencilAvailable) {
      throw new Error("Context has no stencil buffer");
    }
    if (format !== "rgba" && format !== "rgba32f") {
      throw new TypeError("render target format must be rgba or rgba32f");
    }
    if (format === "rgba32f" && !this.floatRenderTargetsSupported) {
      throw new Error("EXT_color_buffer_float required for RGBA32F render targets");
    }
    const RECORD = {
      kind: "renderTarget",
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
      available: true
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
    this.stats.gpuTextureBytes += this._textureBytes(RECORD);
    this.stats.gpuRenderTargetBytes += width * height * (format === "rgba32f" ? 16 : 4) + width * height * (stencil ? 1 : 0);
    return HANDLE;
  }
  /**
   * Renders into one layer of a texture array. The handle works with bind/unbindRenderTarget but is not a draw
   * texture: draw the array and select the layer. Contents are empty after context restoration, so the producer
   * repaints them. The array stays owned by the caller and must outlive the target.
   */
  createTextureLayerTarget(array, layer) {
    this._ready();
    const ARRAY = this._handle(this.textures, array, "texture array");
    if (ARRAY.target !== "array") {
      throw new TypeError("A texture array is required");
    }
    integer(layer, "layer", 0, ARRAY.layers - 1);
    const RECORD = {
      kind: "renderTarget",
      arrayRecord: ARRAY,
      layer,
      width: ARRAY.width,
      height: ARRAY.height,
      format: "rgba",
      premultiplied: true,
      stencil: false,
      framebuffer: null,
      stencilBuffer: null,
      available: true
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
      throw new Error("beginFrame required");
    }
    const FROM = this._handle(this.renderTargets, source, "render target"), TO = this._handle(this.renderTargets, target, "render target");
    integer(x, "blit x", 0, TO.width - 1);
    integer(y, "blit y", 0, TO.height - 1);
    integer(width, "blit width", 1, TO.width - x);
    integer(height, "blit height", 1, TO.height - y);
    if (!FROM.available || !TO.available || FROM === TO) {
      throw new Error("Blit needs two distinct available render targets");
    }
    const GL = this.gl, PREVIOUS = GL.getParameter(GL.FRAMEBUFFER_BINDING);
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
      width === FROM.width && height === FROM.height ? GL.NEAREST : GL.LINEAR
    );
    GL.bindFramebuffer(GL.FRAMEBUFFER, PREVIOUS);
  }
  /** Float targets can become unavailable after restore while ordinary rendering stays ready. */
  isRenderTargetAvailable(handle) {
    const R = this._handle(this.renderTargets, handle, "render target");
    return this.state === "ready" && R.available === true;
  }
  /** Binds a target inside an active frame. Bindings may nest and must unwind in LIFO order. */
  bindRenderTarget(handle) {
    this._ready();
    if (!this.active) {
      throw new Error("beginFrame required");
    }
    const RECORD = this._handle(this.renderTargets, handle, "render target");
    if (!RECORD.available) {
      throw new Error("Render target is unavailable after context restoration");
    }
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
    if (RECORD.arrayRecord) {
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
    this.stats.gpuRenderTargetBytes -= RECORD.width * RECORD.height * (RECORD.format === "rgba32f" ? 16 : 4) + RECORD.width * RECORD.height * (RECORD.stencil ? 1 : 0);
    return true;
  }
  createTexture(source, { format = "rgba", premultiplied = false, filter = "linear" } = {}) {
    this._ready();
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("Invalid filter");
    }
    const RECORD = {
      ...this._source(source, format, premultiplied),
      kind: "image",
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
    this.stats.gpuTextureBytes += this._textureBytes(RECORD);
    return HANDLE;
  }
  /**
   * One TEXTURE_2D_ARRAY of equally sized RGBA layers, bound as a single sampler2DArray. Every layer is allocated
   * up front, so memory is width * height * 4 * layers regardless of how much of each layer an atlas fills;
   * unused layers and unused layer area stay transparent.
   */
  createTextureArray(width, height, layers, { filter = "linear" } = {}) {
    this._ready();
    integer(width, "texture array width", 1, this.maxTextureSize);
    integer(height, "texture array height", 1, this.maxTextureSize);
    integer(layers, "texture array layers", 1, this.maxArrayTextureLayers);
    if (filter !== "nearest" && filter !== "linear") {
      throw new TypeError("Invalid filter");
    }
    const RECORD = {
      kind: "imageArray",
      target: "array",
      width,
      height,
      layers,
      layerSources: new Array(layers).fill(null),
      layerRegions: Array.from({ length: layers }, () => []),
      format: "rgba",
      premultiplied: true,
      source: null,
      filter,
      gpu: null
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
    const R = this._handle(this.textures, handle, "texture array");
    if (R.target !== "array") {
      throw new TypeError("A texture array is required");
    }
    integer(layer, "layer", 0, R.layers - 1);
    const NEXT = this._source(source, "rgba", premultiplied);
    if (NEXT.width !== R.width || NEXT.height !== R.height || NEXT.source === null) {
      throw new RangeError("Layer source must supply every pixel at the array width and height");
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
    const R = this._handle(this.textures, handle, "texture array");
    if (R.target !== "array") {
      throw new TypeError("A texture array is required");
    }
    integer(layer, "layer", 0, R.layers - 1);
    integer(x, "region x", 0, R.width - 1);
    integer(y, "region y", 0, R.height - 1);
    const NEXT = this._source(source, "rgba", premultiplied);
    if (NEXT.source === null || x + NEXT.width > R.width || y + NEXT.height > R.height) {
      throw new RangeError("Region must be fully supplied and inside the layer");
    }
    const REGION = { x, y, width: NEXT.width, height: NEXT.height, source: NEXT.source }, PREVIOUS = R.layerRegions[layer];
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
    const R = this._handle(this.textures, handle, "texture array");
    if (R.target !== "array") {
      throw new TypeError("A texture array is required");
    }
    integer(layer, "layer", 0, R.layers - 1);
    integer(width, "region width", 1, R.width);
    integer(height, "region height", 1, R.height);
    const IMAGE_UPLOADS = this.stats.imageTexUploadCount, IMAGE_BYTES = this.stats.imageTexUploadBytes;
    this.updateTextureRegion(
      handle,
      layer,
      x,
      y,
      { width, height, data: new Uint8Array(width * height * 4) },
      { premultiplied: true }
    );
    this.stats.imageTexUploadCount = IMAGE_UPLOADS;
    this.stats.imageTexUploadBytes = IMAGE_BYTES;
    this.stats.regionClears++;
    R.layerRegions[layer] = R.layerRegions[layer].filter(
      (r) => !(r.x === x && r.y === y && r.width === width && r.height === height)
    );
  }
  /**
   * A renderer that queues draws registers its flush here, so a shared GPU resource that is about to change
   * (pose rows, data textures) first submits everything already queued against its old contents.
   * Returns the function that unregisters it.
   */
  registerBatcher(flush) {
    if (typeof flush !== "function") {
      throw new TypeError("A flush function is required");
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
    if (this.state === "ready" && this.textures.has(atlas.texture)) {
      this.deleteTexture(atlas.texture);
    }
  }
  isTextureArray(handle) {
    return this._handle(this.textures, handle, "texture").target === "array";
  }
  /** Retained RGBA32F pixels; usable for sampling without float render-target support. */
  createDataTexture(width, height, { data = null } = {}) {
    this._ready();
    integer(width, "data texture width", 1, this.maxTextureSize);
    integer(height, "data texture height", 1, this.maxTextureSize);
    if (data !== null && (!(data instanceof Float32Array) || data.length !== width * height * 4)) {
      throw new TypeError("RGBA32F data must match the texture dimensions");
    }
    const RECORD = {
      kind: "numeric",
      width,
      height,
      format: "rgba32f",
      premultiplied: false,
      source: data === null ? new Float32Array(width * height * 4) : new Float32Array(data),
      filter: "nearest",
      gpu: null
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
    const R = this._handle(this.textures, handle, "data texture");
    if (R.format !== "rgba32f" || this.renderTargets.has(handle)) {
      throw new TypeError("A CPU-owned RGBA32F data texture is required");
    }
    integer(x, "x");
    integer(y, "y");
    integer(width, "width", 1);
    integer(height, "height", 1);
    if (x + width > R.width || y + height > R.height) {
      throw new RangeError("Data texture region outside bounds");
    }
    if (!(data instanceof Float32Array) || data.length !== width * height * 4) {
      throw new TypeError("RGBA32F region data must match dimensions");
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
    const ERROR = GL.getError();
    if (ERROR !== GL.NO_ERROR) {
      throw new Error(`Data texture update error ${ERROR}`);
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
    const R = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) {
      throw new Error("Render targets cannot be updated from CPU pixels");
    }
    if (R.format === "rgba32f") {
      throw new TypeError("Use updateDataTexture for RGBA32F pixels");
    }
    if (R.target === "array") {
      throw new TypeError("Use updateTextureLayer for texture arrays");
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
      const REPLACEMENT = { ...NEXT, kind: R.kind, filter: R.filter, gpu: null };
      this._texture(REPLACEMENT);
      this.gl.deleteTexture(R.gpu);
      this.stats.gpuTextureBytes += this._textureBytes(REPLACEMENT) - this._textureBytes(R);
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
    this.stats.textureBytes += width * height * (R.format === "rgba" ? 4 : 1);
    if (R.kind === "image") {
      this.stats.imageTexUploadCount++;
      this.stats.imageTexUploadBytes += width * height * (R.format === "rgba" ? 4 : 1);
    }
  }
  /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
  copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
    this._ready();
    const R = this._handle(this.textures, handle, "texture");
    if (this.renderTargets.has(handle)) {
      throw new Error("Render targets cannot be copied from the default framebuffer");
    }
    if (R.target === "array") {
      throw new TypeError("Texture arrays cannot receive a framebuffer copy");
    }
    integer(x, "x");
    integer(y, "y");
    if (R.format !== "rgba" || x + R.width > this.canvas.width || y + R.height > this.canvas.height) {
      throw new RangeError("Framebuffer copy outside bounds");
    }
    const GL = this.gl;
    this._bindTexture(0, R);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    let allocated = false;
    if (!GL.getContextAttributes().alpha && R.copyFormat !== "rgb") {
      GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGB8, R.width, R.height, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
      R.copyFormat = "rgb";
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
      throw new Error("Use deleteRenderTarget for render targets");
    }
    if (R.target === "array" && [...this.renderTargets.values()].some((target) => target.arrayRecord === R)) {
      throw new Error("Delete the texture array layer targets first");
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
      "spriteRuns",
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
  clear({ color, depth, stencil } = {}) {
    this._ready();
    const GL = this.gl;
    let flags = 0;
    if (color !== void 0) {
      finiteArray(color, 4, "clear color");
      GL.colorMask(true, true, true, true);
      GL.clearColor(...color);
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
    if (this.state === "disposed") {
      return;
    }
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
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
    this.stats.pipelineCount = this.stats.bufferCount = this.stats.textureCount = this.stats.renderTargetCount = this.stats.gpuBufferBytes = this.stats.gpuRenderTargetBytes = this.stats.gpuTextureBytes = 0;
    this.active = false;
    this.state = "disposed";
  }
};

// modules/rendering/clip-planes.js
var EMPTY_CLIP = Object.freeze({
  key: "",
  values: null,
  count: 0
});
function clipPlanes(clips, maxPlanes) {
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
    throw new RangeError(`Clipping exceeds ${maxPlanes} edge planes`);
  }
  return {
    key: KEY.join(","),
    values: VALUES,
    count: VALUES.length / 3
  };
}

// modules/rendering/pose-renderer.js
var MAX_PARTS = 16;
var POSE_WIDTH = MAX_PARTS * 3;
var OVERRIDE_WIDTH = MAX_PARTS * 2;
var PROGRAM_WIDTH = 256;
var OWNERS = /* @__PURE__ */ new WeakMap();
function poseRendererOf(handle) {
  return OWNERS.get(handle) ?? null;
}
var PoseRenderer = class {
  constructor(device, { backend = "auto", onBoundary = () => {
  } } = {}) {
    if (!["auto", "cpu", "uniform"].includes(backend)) {
      throw new TypeError("poseBackend must be auto, cpu or uniform");
    }
    this.device = device;
    this.backend = backend;
    this.onBoundary = onBoundary;
    this.sources = /* @__PURE__ */ new Map();
    this.instances = /* @__PURE__ */ new Map();
    this.rows = [];
    this.freeRows = [];
    this.capacity = 0;
    this.programTexture = null;
    this.stateTexture = null;
    this.overrideTexture = null;
    this.cpuTexture = null;
    this.frameMetrics = {};
    this.pendingUpdates = false;
    this.disposed = false;
    this.gpuUnavailableReason = backend !== "auto" ? "cpuRequested" : null;
    this.onRestored = () => {
      for (const RECORD of this.instances.values()) {
        RECORD.stateDirty = true;
        RECORD.overrideDirty = true;
        RECORD.cpuDirty = RECORD.mode === "cpu";
        RECORD.usedFrame = -1;
      }
      this.pendingUpdates = true;
    };
    device.canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.beginFrame();
  }
  _ready() {
    if (this.disposed) {
      throw new Error("Pose renderer is disposed");
    }
  }
  beginFrame() {
    this.frameMetrics = {
      gpuDrawInstances: 0,
      cpuDrawInstances: 0,
      uniformDrawInstances: 0,
      cpuPoseUploadBytes: 0,
      stateUploadBytes: 0,
      overrideUploadBytes: 0,
      fallbackReasons: /* @__PURE__ */ Object.create(null),
      flushCalls: 0,
      flushRecordVisits: 0,
      cleanFlushSkips: 0
    };
  }
  _boundary() {
    if (this.device.active) {
      this.onBoundary();
    }
  }
  createSource(program) {
    this._ready();
    if (this.backend === "uniform") {
      return null;
    }
    if (!program || !(program.data instanceof Float32Array) || !Number.isSafeInteger(program.partCount) || program.partCount < 1 || program.partCount > MAX_PARTS || program.data.length % 4) {
      throw new TypeError("A compiled pose channel program with 1..16 parts is required");
    }
    this._boundary();
    const HANDLE = Object.freeze({});
    this.sources.set(HANDLE, { program, offset: 0 });
    try {
      this._rebuildPrograms();
    } catch (error) {
      this.sources.delete(HANDLE);
      throw error;
    }
    return HANDLE;
  }
  _rebuildPrograms() {
    let length = 0;
    const OFFSETS = /* @__PURE__ */ new Map();
    for (const SOURCE of this.sources.values()) {
      OFFSETS.set(SOURCE, length / 4);
      length += SOURCE.program.data.length;
    }
    if (!length) {
      if (this.programTexture) {
        this.device.deleteTexture(this.programTexture);
        this.programTexture = null;
      }
      return;
    }
    const WIDTH = Math.min(PROGRAM_WIDTH, this.device.maxTextureSize);
    const HEIGHT = Math.ceil(length / (WIDTH * 4));
    if (HEIGHT > this.device.maxTextureSize) {
      throw new RangeError("Pose programs exceed data texture capacity");
    }
    const DATA = new Float32Array(WIDTH * HEIGHT * 4);
    for (const SOURCE of this.sources.values()) {
      DATA.set(SOURCE.program.data, OFFSETS.get(SOURCE) * 4);
    }
    const TEXTURE = this.device.createDataTexture(WIDTH, HEIGHT, { data: DATA });
    for (const [SOURCE, OFFSET] of OFFSETS) {
      SOURCE.offset = OFFSET;
    }
    if (this.programTexture) {
      this.device.deleteTexture(this.programTexture);
    }
    this.programTexture = TEXTURE;
    for (const RECORD of this.instances.values()) {
      if (this.stateData) {
        this.stateData[RECORD.row * 8 + 7] = this.sources.get(RECORD.source).offset;
      }
      RECORD.stateDirty = true;
    }
    this.pendingUpdates = true;
  }
  deleteSource(handle) {
    if (!this.sources.has(handle)) {
      return false;
    }
    if ([...this.instances.values()].some((record) => record.source === handle)) {
      throw new Error("Dispose pose instances before their source");
    }
    this._boundary();
    this.sources.delete(handle);
    if (!this.sources.size && this.programTexture) {
      this.device.deleteTexture(this.programTexture);
      this.programTexture = null;
    }
    return true;
  }
  _releaseAtlas() {
    for (const KEY of ["stateTexture", "overrideTexture", "cpuTexture"]) {
      if (this[KEY]) {
        this.device.deleteTexture(this[KEY]);
        this[KEY] = null;
      }
    }
    this.stateData = null;
    this.overrideData = null;
    this.cpuData = null;
  }
  _ensureCapacity(required) {
    if (required <= this.capacity) {
      return;
    }
    if (required > this.device.maxTextureSize) {
      throw new RangeError("Pose instance rows exceed GPU texture capacity");
    }
    this._boundary();
    const CAPACITY = Math.min(this.device.maxTextureSize, Math.max(32, this.capacity * 2, required));
    const STATE = new Float32Array(CAPACITY * 8);
    const OVERRIDES = new Float32Array(CAPACITY * OVERRIDE_WIDTH * 4);
    const CPU = new Float32Array(CAPACITY * POSE_WIDTH * 4);
    if (this.capacity) {
      STATE.set(this.stateData);
      OVERRIDES.set(this.overrideData);
      CPU.set(this.cpuData);
    }
    let stateTexture = null;
    let overrideTexture = null;
    try {
      stateTexture = this.device.createDataTexture(2, CAPACITY, { data: STATE });
      overrideTexture = this.device.createDataTexture(OVERRIDE_WIDTH, CAPACITY, { data: OVERRIDES });
    } catch (error) {
      for (const TEXTURE of [stateTexture, overrideTexture]) {
        if (TEXTURE) {
          this.device.deleteTexture(TEXTURE);
        }
      }
      throw error;
    }
    this._releaseAtlas();
    this.capacity = CAPACITY;
    this.stateData = STATE;
    this.overrideData = OVERRIDES;
    this.cpuData = CPU;
    this.stateTexture = stateTexture;
    this.overrideTexture = overrideTexture;
    for (const RECORD of this.instances.values()) {
      RECORD.stateDirty = true;
      RECORD.overrideDirty = true;
      RECORD.cpuDirty = RECORD.mode === "cpu";
    }
    this.pendingUpdates = true;
  }
  createInstance(source) {
    this._ready();
    const SOURCE = this.sources.get(source);
    if (!SOURCE) {
      throw new TypeError("A pose source owned by this renderer is required");
    }
    const ROW = this.freeRows.length ? this.freeRows.pop() : this.rows.length;
    this._ensureCapacity(ROW + 1);
    const HANDLE = Object.freeze({});
    const RECORD = {
      source,
      row: ROW,
      mode: null,
      stateDirty: true,
      overrideDirty: true,
      cpuDirty: false,
      usedFrame: -1,
      reason: null,
      baseScratch: new Float32Array(OVERRIDE_WIDTH * 4)
    };
    this.instances.set(HANDLE, RECORD);
    OWNERS.set(HANDLE, this);
    this.rows[ROW] = RECORD;
    this.pendingUpdates = true;
    return HANDLE;
  }
  deleteInstance(handle) {
    const RECORD = this.instances.get(handle);
    if (!RECORD) {
      return false;
    }
    this._boundary();
    this.instances.delete(handle);
    this.rows[RECORD.row] = null;
    this.freeRows.push(RECORD.row);
    if (!this.instances.size) {
      this._releaseAtlas();
      this.capacity = 0;
      this.rows = [];
      this.freeRows = [];
    }
    return true;
  }
  _instance(handle) {
    this._ready();
    const RECORD = this.instances.get(handle);
    if (!RECORD) {
      throw new TypeError("A live pose instance owned by this renderer is required");
    }
    return RECORD;
  }
  prepare(handle, { clipName, elapsedMs, basePoses, visible, excluded = [], morph }) {
    const RECORD = this._instance(handle);
    const SOURCE = this.sources.get(RECORD.source);
    const CLIP = SOURCE.program.clips[clipName];
    if (this.gpuUnavailableReason || !CLIP?.supported) {
      return null;
    }
    if (!Number.isFinite(elapsedMs) || basePoses.length !== SOURCE.program.partCount || visible.length !== basePoses.length || !morph || morph.length !== 2 || !morph.every(Number.isFinite)) {
      throw new TypeError("Finite pose time, matching part overrides and two morph values required");
    }
    const CYCLE = CLIP.durationMs * (CLIP.loop === "alternate" ? 2 : 1);
    const LOCAL_TIME = CLIP.loop === "once" ? Math.min(CLIP.durationMs, Math.max(0, elapsedMs)) : (elapsedMs % CYCLE + CYCLE) % CYCLE;
    const EXCLUDED = excluded.reduce((mask, value, index) => value ? mask | 1 << index : mask, 0);
    const STATE = [
      CLIP.headerBase,
      LOCAL_TIME,
      CLIP.loop === "once" ? 0 : CLIP.loop === "repeat" ? 1 : 2,
      CLIP.durationMs,
      morph[0],
      morph[1],
      EXCLUDED,
      // Slot 7: where this source's keyframes start in the shared program texture.
      SOURCE.offset
    ];
    const BASE = RECORD.baseScratch;
    for (let i = 0; i < basePoses.length; i++) {
      const POSE = basePoses[i];
      const OFFSET_LOCAL = i * 8;
      BASE[OFFSET_LOCAL] = POSE.x;
      BASE[OFFSET_LOCAL + 1] = POSE.y;
      BASE[OFFSET_LOCAL + 2] = POSE.rotation;
      BASE[OFFSET_LOCAL + 3] = POSE.scaleX;
      BASE[OFFSET_LOCAL + 4] = POSE.scaleY;
      BASE[OFFSET_LOCAL + 5] = POSE.opacity;
      BASE[OFFSET_LOCAL + 6] = visible[i] ? 1 : 0;
      BASE[OFFSET_LOCAL + 7] = 0;
    }
    const OFFSET = RECORD.row * 8;
    const BASE_OFFSET = RECORD.row * OVERRIDE_WIDTH * 4;
    const STATE_CHANGED = STATE.some((value, index) => Math.fround(value) !== this.stateData[OFFSET + index]);
    const BASE_CHANGED = BASE.some((value, index) => value !== this.overrideData[BASE_OFFSET + index]);
    if ((STATE_CHANGED || BASE_CHANGED || RECORD.mode !== "gpu") && RECORD.usedFrame === this.device.stats.frame) {
      this._boundary();
    }
    if (STATE_CHANGED) {
      this.stateData.set(STATE, OFFSET);
      RECORD.stateDirty = true;
    }
    if (BASE_CHANGED) {
      this.overrideData.set(BASE, BASE_OFFSET);
      RECORD.overrideDirty = true;
    }
    this.pendingUpdates ||= STATE_CHANGED || BASE_CHANGED;
    RECORD.mode = "gpu";
    RECORD.reason = null;
    return handle;
  }
  prepareCpu(handle, parts, morph, reason) {
    const RECORD = this._instance(handle);
    const PART_COUNT = this.sources.get(RECORD.source).program.partCount;
    if (!Array.isArray(parts) || parts.length !== PART_COUNT || !morph || morph.length !== 2) {
      throw new TypeError("Matching CPU part poses and morph weights required");
    }
    if (RECORD.usedFrame === this.device.stats.frame) {
      this._boundary();
    }
    const OFFSET = RECORD.row * POSE_WIDTH * 4;
    for (let i = 0; i < PART_COUNT; i++) {
      const POSE = parts[i];
      const MATRIX = POSE.transform;
      this.cpuData.set(
        [
          MATRIX[0],
          MATRIX[2],
          MATRIX[4],
          0,
          MATRIX[1],
          MATRIX[3],
          MATRIX[5],
          0,
          morph[0] + (POSE.morph?.[0] ?? 0),
          morph[1] + (POSE.morph?.[1] ?? 0),
          POSE.visible === false ? 0 : POSE.opacity ?? 1,
          POSE.depth ?? 0
        ],
        OFFSET + i * 12
      );
    }
    RECORD.mode = "cpu";
    RECORD.reason = reason;
    RECORD.cpuDirty = true;
    this.pendingUpdates = true;
    return handle;
  }
  resolve(handle) {
    const RECORD = this._instance(handle);
    if (!RECORD.mode) {
      throw new Error("Prepare a player pose before drawing");
    }
    if (RECORD.mode === "cpu" && !this.cpuTexture) {
      this.cpuTexture = this.device.createDataTexture(POSE_WIDTH, this.capacity, { data: this.cpuData });
      for (const ROW of this.instances.values()) {
        ROW.cpuDirty = false;
      }
    }
    const PART_COUNT = this.sources.get(RECORD.source).program.partCount;
    if (RECORD.mode === "gpu") {
      return {
        row: RECORD.row,
        kind: "program",
        texture: this.programTexture,
        textures: [this.programTexture, this.stateTexture, this.overrideTexture],
        programWidth: this.programTexture.width,
        partCount: PART_COUNT
      };
    }
    return {
      row: RECORD.row,
      kind: "matrix",
      texture: this.cpuTexture,
      textures: [this.cpuTexture],
      programWidth: 0,
      partCount: PART_COUNT
    };
  }
  noteDraw(handle) {
    const RECORD = this._instance(handle);
    RECORD.usedFrame = this.device.stats.frame;
    if (RECORD.mode === "gpu") {
      this.frameMetrics.gpuDrawInstances++;
    } else {
      this.frameMetrics.cpuDrawInstances++;
      this._fallback(RECORD.reason ?? "cpuPose");
    }
  }
  _fallback(reason) {
    this.frameMetrics.fallbackReasons[reason] = (this.frameMetrics.fallbackReasons[reason] ?? 0) + 1;
  }
  recordFallback(reason) {
    this.frameMetrics.uniformDrawInstances++;
    this._fallback(reason);
  }
  _uploadRows(key, dirtyKey, texture, width, metric) {
    let first = Infinity;
    let last = -1;
    const UPLOADING = [];
    for (const RECORD of this.instances.values()) {
      this.frameMetrics.flushRecordVisits++;
      if (RECORD[dirtyKey]) {
        first = Math.min(first, RECORD.row);
        last = Math.max(last, RECORD.row);
        UPLOADING.push(RECORD);
      }
    }
    if (last < 0) {
      return;
    }
    const DATA = this[key].subarray(first * width * 4, (last + 1) * width * 4);
    this.device.updateDataTexture(texture, DATA, { y: first, width, height: last - first + 1 });
    for (const RECORD of UPLOADING) {
      RECORD[dirtyKey] = false;
    }
    this.frameMetrics[metric] += DATA.byteLength;
  }
  flushUpdates() {
    this._ready();
    this.frameMetrics.flushCalls++;
    if (!this.instances.size) {
      this.pendingUpdates = false;
      return;
    }
    if (!this.pendingUpdates) {
      this.frameMetrics.cleanFlushSkips++;
      return;
    }
    if (this.cpuTexture) {
      this._uploadRows("cpuData", "cpuDirty", this.cpuTexture, POSE_WIDTH, "cpuPoseUploadBytes");
    }
    this._uploadRows("stateData", "stateDirty", this.stateTexture, 2, "stateUploadBytes");
    this._uploadRows("overrideData", "overrideDirty", this.overrideTexture, OVERRIDE_WIDTH, "overrideUploadBytes");
    this.pendingUpdates = false;
  }
  stats() {
    const TOTAL = this.frameMetrics.gpuDrawInstances + this.frameMetrics.cpuDrawInstances + this.frameMetrics.uniformDrawInstances;
    return {
      ...this.frameMetrics,
      fallbackReasons: { ...this.frameMetrics.fallbackReasons },
      totalDrawInstances: TOTAL,
      cpuFallbackRatio: TOTAL ? (this.frameMetrics.cpuDrawInstances + this.frameMetrics.uniformDrawInstances) / TOTAL : 0,
      liveInstances: this.instances.size,
      sources: this.sources.size,
      capacity: this.capacity,
      gpuUnavailableReason: this.gpuUnavailableReason,
      stateBytes: this.capacity * (8 + OVERRIDE_WIDTH * 4) * 4,
      cpuPoseBytes: this.cpuTexture ? POSE_WIDTH * this.capacity * 16 : 0,
      programBytes: this.programTexture ? this.programTexture.width * this.programTexture.height * 16 : 0
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this._boundary();
    this._releaseAtlas();
    if (this.programTexture) {
      this.device.deleteTexture(this.programTexture);
    }
    this.instances.clear();
    this.sources.clear();
    this.device.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.disposed = true;
  }
};

// modules/rendering/pose-shader.js
var POSE_PROGRAM_FUNCTIONS = `uniform sampler2D u_program;uniform sampler2D u_state;uniform sampler2D u_overrides;uniform int u_programWidth;
vec4 poseData(int base,int at){int i=at+base;return texelFetch(u_program,ivec2(i%u_programWidth,i/u_programWidth),0);}
float poseChannel(int base,int header,float time){vec4 h=poseData(base,header);float value=h.z;
 for(int i=0;i<64;i++){if(i>=int(h.y))break;vec4 s=poseData(base,int(h.x)+i*2);if(time<s.z)break;
 if(time>=s.w){value=s.y;continue;}float t=clamp((time-s.z)/(s.w-s.z),0.0,1.0);float ease=poseData(base,int(h.x)+i*2+1).x;
 if(ease>1.5)t=1.0-(1.0-t)*(1.0-t);else if(ease>0.5)t=0.5-0.5*cos(3.141592653589793*t);
 value=mix(s.x,s.y,t);break;}return value;}
mat3 poseLocal(int base,int part,int header,float time,int row,out float opacity){
 vec4 b0=texelFetch(u_overrides,ivec2(part*2,row),0);vec4 b1=texelFetch(u_overrides,ivec2(part*2+1,row),0);
 int at=header+part*6;vec2 translation=b0.xy+vec2(poseChannel(base,at,time),poseChannel(base,at+1,time));
 float rotation=b0.z+poseChannel(base,at+2,time);float sx=b0.w*poseChannel(base,at+3,time);float sy=b1.x*poseChannel(base,at+4,time);
 float c=cos(rotation);float s=sin(rotation);vec2 x=vec2(c,s)*sx;vec2 y=vec2(-s,c)*sy;vec2 pivot=poseData(base,part).xy;
 opacity=b1.y*b1.z*poseChannel(base,at+5,time);return mat3(vec3(x,0.0),vec3(y,0.0),vec3(pivot+translation-x*pivot.x-y*pivot.y,1.0));}
void poseEval(int part,int row,out vec4 row0,out vec4 row1,out vec4 pose){
 vec4 playback=texelFetch(u_state,ivec2(0,row),0);vec4 morph=texelFetch(u_state,ivec2(1,row),0);
 int base=int(morph.w);float time;
 if(playback.z<0.5)time=clamp(playback.y,0.0,playback.w);
 else if(playback.z<1.5)time=mod(playback.y,playback.w);
 else{float point=mod(playback.y,playback.w*2.0);time=point<=playback.w?point:playback.w*2.0-point;}
 mat3 matrix=mat3(1.0);float alpha=1.0;int current=part;
 for(int depth=0;depth<16;depth++){if(current<0)break;float opacity;mat3 m=poseLocal(base,current,int(playback.x),time,row,opacity);matrix=m*matrix;alpha*=opacity;current=int(poseData(base,current).z);}
 if((int(morph.z)&(1<<part))!=0)alpha=0.0;
 row0=vec4(matrix[0][0],matrix[1][0],matrix[2][0],0.0);row1=vec4(matrix[0][1],matrix[1][1],matrix[2][1],0.0);pose=vec4(morph.xy,alpha,0.0);}
`;

// modules/rendering/vector-renderer.js
var IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
var VERTEX_FLOATS = 20;
var VERTEX_BYTES = VERTEX_FLOATS * 4;
var MODE_POSED = 4;
var ARC_TOLERANCE = 0.125;
var MODE_PRIMITIVE = 5;
var POSED_CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1]
];
var VERTEX_ATTRIBUTES = [
  { name: "a_position", size: 2, offset: 0 },
  { name: "a_uv", size: 2, offset: 8 },
  { name: "a_color", size: 4, offset: 16 },
  { name: "a_paint", size: 4, offset: 32 },
  { name: "a_radial", size: 4, offset: 48 },
  { name: "a_rect", size: 4, offset: 64 }
];
var FRAGMENT_VARYINGS = "varying highp vec2 v_uv; varying vec4 v_color; varying highp vec4 v_paint; varying highp vec4 v_radial; varying highp vec4 v_rect;";
var POSED_CORNER = `if(a_paint.z>3.5&&a_paint.z<4.5){vec4 row0;vec4 row1;vec4 pose;
poseEval(int(a_rect.w+0.5),int(a_rect.z+0.5),row0,row1,pose);
vec2 q=vec2(dot(row0.xy,a_position)+row0.z,dot(row1.xy,a_position)+row1.z);
position=vec2(a_radial.x*q.x+a_radial.z*q.y+a_rect.x,a_radial.y*q.x+a_radial.w*q.y+a_rect.y);
color.a*=pose.z;paint.z=0.0;radial=vec4(0.0);rect=vec4(0.0);}`;
function vertexShader(posed) {
  return `attribute vec2 a_position; attribute vec2 a_uv; attribute vec4 a_color; attribute vec4 a_paint; attribute vec4 a_radial; attribute vec4 a_rect;
uniform mat3 u_projection; ${FRAGMENT_VARYINGS}${posed ? " varying highp vec2 v_position;" : ""}
${posed ? POSE_PROGRAM_FUNCTIONS : ""}
void main(){vec2 position=a_position;vec4 color=a_color;vec4 paint=a_paint;vec4 radial=a_radial;vec4 rect=a_rect;
${posed ? POSED_CORNER : ""}
vec3 p=u_projection*vec3(position,1.0);gl_Position=vec4(p.xy,0.0,1.0);${posed ? "v_position=position;" : ""}v_uv=a_uv;v_color=color;v_paint=paint;v_radial=radial;v_rect=rect;}`;
}
var VERTEX = vertexShader(false);
var CLIP_VERTEX = `attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;void main(){vec3 p=u_projection*u_transform*vec3(a_position,1.0);gl_Position=vec4(p.xy,0.0,1.0);}`;
var CLIP_FRAGMENT = "precision mediump float;void main(){gl_FragColor=vec4(1.0);}";
var FINISH = "float a=texel.a*v_color.a;vec3 rgb=v_paint.y>1.5?v_color.rgb*a:mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),v_paint.y);gl_FragColor=vec4(rgb,a);";
var PRIMITIVE_OUTSIDE = `bool primitiveOutside(vec2 l,vec4 p,vec4 m){
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
function fragmentShader(planes) {
  const PLANES = planes ? `varying highp vec2 v_position; uniform vec3 u_planes[${planes}]; uniform int u_planeCount;` : "";
  const CLIP = planes ? `for(int i=0;i<${planes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}` : "";
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
var FRAGMENT = fragmentShader(0);
var GROUP_FRAGMENT = `precision mediump float; uniform sampler2D u_texture;
${FRAGMENT_VARYINGS}
void main(){vec4 texel=texture2D(u_texture,v_uv);${FINISH}}`;
var FINITE = (n, label) => {
  if (!Number.isFinite(n)) {
    throw new TypeError(`${label} must be finite`);
  }
};
function rgba(value) {
  if (!value || value.length !== 4) {
    throw new TypeError("RGBA channels must be in [0,1]");
  }
  for (let i = 0; i < 4; i++) {
    const N = value[i];
    if (!Number.isFinite(N) || N < 0 || N > 1) {
      throw new TypeError("RGBA channels must be in [0,1]");
    }
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
    if (initialVertices * VERTEX_BYTES > device.maxBufferBytes) {
      throw new RangeError("initial vector buffer exceeds the device byte limit");
    }
    this.device = device;
    this.gl = device.gl;
    this.canvas = device.canvas;
    this.glyphAtlas = glyphAtlas;
    this.maxVertices = Math.min(maxVertices, Math.floor(device.maxBufferBytes / VERTEX_BYTES));
    this.maxClipPlanes = Math.max(
      1,
      Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2)
    );
    this.pipeline = device.createPipeline({
      vertex: VERTEX,
      fragment: FRAGMENT,
      stride: VERTEX_BYTES,
      attributes: VERTEX_ATTRIBUTES,
      uniforms: {
        u_projection: "matrix3fv",
        u_texture: "1i"
      }
    });
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
      capacityBytes: initialVertices * VERTEX_BYTES
    });
    this.dynamicClipBuffer = device.createVertexBuffer({
      capacityBytes: 0
    });
    this.atlas = device.textureAtlas;
    this.whiteRegion = this.atlas.allocate(1, 1);
    this.atlas.upload(
      this.whiteRegion,
      { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) },
      { premultiplied: true, extendEdges: true }
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
    this.blend = "source-over";
    this.stencilClips = [];
    this.clipPaths = /* @__PURE__ */ new Map();
    this.clipPathBytes = 0;
    this.stencilDepth = 0;
    this.stencilNeedsRebuild = false;
    this.state = "ready";
    this.unregisterBatcher = device.registerBatcher(() => {
      if (this.state === "ready" && this.device.active) {
        this._submit();
      }
    });
    this.onLost = () => {
      this.count = 0;
      this.poseBatch = null;
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
    this.groupPipeline = null;
    try {
      this.groupPipeline = device.createPipeline({
        vertex: VERTEX,
        fragment: GROUP_FRAGMENT,
        stride: VERTEX_BYTES,
        attributes: VERTEX_ATTRIBUTES,
        uniforms: {
          u_projection: "matrix3fv",
          u_texture: "1i"
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
    this.matrix = S.matrix;
    this.clips = S.clips;
    if (S.stencilClips.length !== this.stencilClips.length || S.stencilClips.some((clip, i) => clip !== this.stencilClips[i])) {
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
      this._pushClip(CONTOUR);
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
      const U = this.flatUV[0], V = this.flatUV[1];
      this._writeVertex(a.x, a.y, a.u ?? U, a.v ?? V, color);
      this._writeVertex(b.x, b.y, b.u ?? U, b.v ?? V, color);
      this._writeVertex(c.x, c.y, c.u ?? U, c.v ?? V, color);
      return;
    }
    if (this.activeGradient && !uv) {
      uv = [this._gradientUV(a), this._gradientUV(b), this._gradientUV(c)];
    }
    const POLY = this.clips.length ? this._clipTriangle(a, b, c, uv) : uv ? [a, b, c].map((point2, i) => ({
      ...point2,
      u: uv[i][0],
      v: uv[i][1]
    })) : [a, b, c];
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
    const K = this.count++ * VERTEX_FLOATS, DATA = this.vertices;
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
      uniforms: POSED ? {
        u_projection: this.projection,
        u_program: 0,
        u_state: 1,
        u_overrides: 2,
        u_texture: 3,
        u_programWidth: POSED.programWidth,
        "u_planes[0]": this.planeScratch,
        u_planeCount: POSED.planeCount
      } : {
        u_projection: this.projection,
        u_texture: 0
      },
      textures: POSED ? [...POSED.textures, this.atlas.texture] : [this.activeTarget ?? this.atlas.texture],
      blend: this.blend,
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
  _createPosePipeline() {
    return this.device.createPipeline({
      vertex: vertexShader(true),
      fragment: fragmentShader(this.maxClipPlanes),
      stride: VERTEX_BYTES,
      attributes: VERTEX_ATTRIBUTES,
      uniforms: {
        u_projection: "matrix3fv",
        u_program: "1i",
        u_state: "1i",
        u_overrides: "1i",
        u_texture: "1i",
        u_programWidth: "1i",
        "u_planes[0]": "3fv",
        u_planeCount: "1i"
      }
    });
  }
  // Only source-over and the additive 'lighter' are offered; a change submits what the other operation queued.
  setBlend(blend) {
    if (blend !== "source-over" && blend !== "lighter") {
      throw new RangeError("VectorRenderer supports only source-over and lighter blending");
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
    const [U, V, W, H] = region.uvRect, MODE = radial ? gradient?.radialEmpty ? 2 : 1 : gradient ? 3 : 0, PARAMS = radial ? gradient?.radialParams ?? [0, 0, 0, 0] : [0, 0, 0, 0];
    this.activeRadial = radial;
    this.activeWhiteFlash = whiteFlash;
    this.activeGradient = gradient;
    this.activeRegion = region;
    this.flatUV = [U + W / 2, V + H / 2];
    this.paintTemplate.set([
      region.layer,
      whiteFlash ? 1 : 0,
      MODE,
      region.filter === "nearest" ? 1 : 0,
      ...PARAMS,
      U,
      V,
      W,
      H
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
      throw new TypeError("drawPrimitive requires a 6-value matrix and 4 parameters");
    }
    for (const VALUE of [...matrix, ...params]) {
      FINITE(VALUE, "drawPrimitive value");
    }
    const M = matrix;
    this._useVertexPaint([0, 0, MODE_PRIMITIVE, 0, ...params, M[0], M[2], M[1], M[3]]);
    const CORNERS = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1]
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
    filter = "linear"
  } = {}) {
    this._frame();
    const COUNT = uvRects?.length / 4;
    if (!Number.isSafeInteger(layer) || layer < 0 || !Number.isInteger(COUNT) || COUNT < 1 || localRects?.length !== COUNT * 4 || matrix.length !== 6 || filter !== "linear" && filter !== "nearest") {
      throw new TypeError("drawQuads requires a layer and matching uvRects and localRects");
    }
    for (const LIST of [uvRects, localRects, matrix]) {
      for (let i = 0; i < LIST.length; i++) {
        FINITE(LIST[i], "drawQuads value");
      }
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new RangeError("alpha must be in [0,1]");
    }
    rgba(color);
    const TINT = [color[0], color[1], color[2], color[3] * alpha], M = compose(this.matrix, matrix);
    this._useVertexPaint(
      [layer, whiteFlash ? 1 : forceColor ? 2 : 0, 0, filter === "nearest" ? 1 : 0, 0, 0, 0, 0, 0, 0, 1, 1],
      whiteFlash
    );
    if (pose === null) {
      if (parts !== null) {
        throw new TypeError("parts require a pose");
      }
      this.device.stats.spriteRuns += COUNT;
      for (let i = 0; i < COUNT; i++) {
        const [LX, LY, LW, LH] = localRects.subarray(i * 4, i * 4 + 4), [U, V, UW, VH] = uvRects.subarray(i * 4, i * 4 + 4), CORNERS = [
          [point(M, LX, LY), [U, V]],
          [point(M, LX + LW, LY), [U + UW, V]],
          [point(M, LX + LW, LY + LH), [U + UW, V + VH]],
          [point(M, LX, LY + LH), [U, V + VH]]
        ];
        this._emitTriangle(CORNERS[0][0], CORNERS[1][0], CORNERS[2][0], TINT, [
          CORNERS[0][1],
          CORNERS[1][1],
          CORNERS[2][1]
        ]);
        this._emitTriangle(CORNERS[0][0], CORNERS[2][0], CORNERS[3][0], TINT, [
          CORNERS[0][1],
          CORNERS[2][1],
          CORNERS[3][1]
        ]);
      }
      return;
    }
    const OWNER = poseRendererOf(pose);
    if (!OWNER || parts?.length !== COUNT) {
      throw new TypeError("A live pose handle and one part per run are required");
    }
    const DRAW = OWNER.resolve(pose);
    if (DRAW.kind !== "program") {
      throw new TypeError("Posed sprites require a keyframe program pose");
    }
    for (let i = 0; i < COUNT; i++) {
      if (!Number.isInteger(parts[i]) || parts[i] < 0 || parts[i] >= DRAW.partCount) {
        throw new RangeError("parts must be pose part indices");
      }
    }
    this._beginPosed(OWNER, DRAW);
    OWNER.noteDraw(pose);
    this.device.stats.spriteRuns += COUNT;
    for (let i = 0; i < COUNT; i++) {
      const [LX, LY, LW, LH] = localRects.subarray(i * 4, i * 4 + 4), [U, V, UW, VH] = uvRects.subarray(i * 4, i * 4 + 4);
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
    const PLANES = clipPlanes(this.clips, this.maxClipPlanes), BATCH = this.poseBatch;
    if (BATCH && (BATCH.owner !== owner || BATCH.textures.some((texture, i) => texture !== draw.textures[i]) || BATCH.planeKey !== PLANES.key && BATCH.planeCount + PLANES.count > 0)) {
      this._submit();
    } else if (!BATCH && this.count && PLANES.count > 0 && this.batchSerial !== this.clipSerial) {
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
        serial: this.clipSerial
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
  fill(colorValue = [0, 0, 0, 1], rule = "nonzero") {
    this._frame();
    if (rule !== "nonzero" && rule !== "evenodd") {
      throw new TypeError("rule must be nonzero or evenodd");
    }
    this._setPaint(this.whiteRegion);
    this.device.stats.pathTessellations++;
    const COL = rgba(colorValue), VERTICES = tessellate(this.path, rule);
    for (let i = 0; i + 2 < VERTICES.length; i += 3) {
      this._emit(VERTICES[i], VERTICES[i + 1], VERTICES[i + 2], COL);
    }
  }
  fillRadialGradient(gradient) {
    this._frame();
    if (!gradient?.region || !gradient.matrixInverse || !Number.isFinite(gradient.radialScale) || gradient.radialScale <= 0 || !Array.isArray(gradient.radialParams) || gradient.radialParams.length !== 4 || gradient.radialParams.some((value) => !Number.isFinite(value))) {
      throw new TypeError("valid two-circle radial gradient texture and transform are required");
    }
    this._setPaint(gradient.region, {
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
    if (!gradient?.region || !gradient.matrixInverse || ![gradient.x0, gradient.y0, gradient.x1, gradient.y1].every(Number.isFinite)) {
      throw new TypeError("valid linear gradient texture and transform are required");
    }
    this._setPaint(gradient.region, {
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
    this._setPaint(gradient?.region ?? this.whiteRegion, {
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
    const HALF = width / 2, ARC_STEP = HALF > ARC_TOLERANCE ? Math.min(Math.PI / 2, 2 * Math.acos(1 - ARC_TOLERANCE / HALF)) : Math.PI / 2, FAN = (center, points) => {
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
        this._emit(P, Q, R, colorValue);
        this._emit(P, R, S, colorValue);
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
          let sweep = Math.atan2(B.y - V.y, B.x - V.x) - START;
          while (sweep > Math.PI) {
            sweep -= Math.PI * 2;
          }
          while (sweep < -Math.PI) {
            sweep += Math.PI * 2;
          }
          const STEPS = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP)), ARC = [A];
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
            this._emit(A, TIP, B, colorValue);
          } else {
            this._emit(V, A, B, colorValue);
          }
        } else {
          this._emit(V, A, B, colorValue);
        }
      }
      if (!CLOSED && lineCap === "round") {
        for (const [INDEX, ANGLE] of [
          [0, Math.atan2(DIRS[0].y, DIRS[0].x) + Math.PI],
          [COUNT - 1, Math.atan2(DIRS[COUNT - 1].y, DIRS[COUNT - 1].x)]
        ]) {
          const V = CONTOUR[INDEX === 0 ? 0 : CONTOUR.length - 1], START = ANGLE - Math.PI / 2, ARC = [];
          const CAP_STEPS = Math.max(2, Math.ceil(Math.PI / ARC_STEP));
          for (let j = 0; j <= CAP_STEPS; j++) {
            const T = START + Math.PI * j / CAP_STEPS;
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
    this._setPaint(this.whiteRegion);
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
  /** `region` is the glyph atlas region (its layer selects the page); `uv` is already in array coordinates. */
  drawGlyphQuad(region, x, y, width, height, uv, colorValue) {
    this._frame();
    this._setPaint(region);
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
    this._useTarget(GROUP.target);
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
    this._setPaint(this.whiteRegion);
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
    this.device.deletePipeline(this.groupPipeline);
    this.device.deletePipeline(this.pipeline);
    if (this.posePipeline) {
      this.device.deletePipeline(this.posePipeline);
    }
    this.unregisterBatcher();
    if (this.whiteRegion && this.device.state === "ready") {
      this.atlas.release(this.whiteRegion);
    }
    this.buffer = this.dynamicClipBuffer = this.clipPipeline = this.groupPipeline = this.posePipeline = this.pipeline = this.whiteRegion = null;
    this.state = "disposed";
  }
};

// modules/rendering/paint-regions.js
var MAX_PAINT_REGIONS = 8;
function validatePaintRegionName(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
    throw new TypeError("A paint region requires a stable name");
  }
  return name;
}
function validatePaintRegionData(data, vertexCount, indices) {
  if (data === void 0) {
    return;
  }
  if (!data || Object.keys(data).length !== 2 || !Array.isArray(data.names) || !data.names.length || data.names.length > MAX_PAINT_REGIONS || new Set(data.names).size !== data.names.length || !(data.indices instanceof Uint16Array) || data.indices.length !== vertexCount) {
    throw new TypeError("Named paint regions require 1..8 unique names and one Uint16 index per vertex");
  }
  data.names.forEach(validatePaintRegionName);
  if (data.indices.some((index) => index > data.names.length)) {
    throw new RangeError("Vertex paint region index exceeds its names");
  }
  for (let offset = 0; offset < (indices?.length ?? vertexCount); offset += 3) {
    const A = data.indices[indices?.[offset] ?? offset], B = data.indices[indices?.[offset + 1] ?? offset + 1], C = data.indices[indices?.[offset + 2] ?? offset + 2];
    if (A !== B || A !== C) {
      throw new TypeError("A painted triangle must belong to one region");
    }
  }
}
function packPaintRegions(names, overrides, output) {
  output.fill(0);
  if (overrides === null || overrides === void 0) {
    return output;
  }
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("paintRegions must be a name-to-RGB object or null");
  }
  for (const NAME in overrides) {
    if (!Object.hasOwn(overrides, NAME)) {
      continue;
    }
    const RGB = overrides[NAME];
    const INDEX = names.indexOf(NAME);
    if (INDEX < 0) {
      throw new TypeError("Unknown paint region: " + NAME);
    }
    if (!(Array.isArray(RGB) || RGB instanceof Float32Array) || RGB.length !== 3 || !Number.isFinite(RGB[0]) || RGB[0] < 0 || RGB[0] > 1 || !Number.isFinite(RGB[1]) || RGB[1] < 0 || RGB[1] > 1 || !Number.isFinite(RGB[2]) || RGB[2] < 0 || RGB[2] > 1) {
      throw new RangeError("Paint region RGB must contain three finite channels in [0,1]");
    }
    const AT = (INDEX + 1) * 4;
    output.set(RGB, AT);
    output[AT + 3] = 1;
  }
  return output;
}

// modules/rendering/yarn-material-record.js
var MATERIAL_KIND = Object.freeze({ none: 0, yarnFill: 1, yarnEdge: 2, sketchFill: 3, sketchEdge: 4 });
var MATERIAL_RECORD_FLOATS = 20;
var MAX_MATERIAL_SURFACES = 16;
function materialRecord(style, bounds, contourLength) {
  const YARN = style.kind === "yarn";
  const STITCH_PATTERN = style.pattern !== false;
  const EFFECT0 = YARN ? [style.seed, style.stitchWidth, style.stitchHeight, (STITCH_PATTERN ? 1 : -1) * style.thickness] : [style.seed, style.periodMs, style.frequency, 0];
  const EFFECT1 = YARN ? [style.irregularity, style.contrast, style.edgeSpacing, style.edgeWidth] : [style.amplitude, style.echoX, style.echoWidth, style.echoOpacity];
  const EFFECT2 = YARN ? [style.fiberSpacing ?? 4, style.fiberLength, style.fiberWidth, style.fiberOpacity] : [style.hatchWidth, style.hatchOpacity, style.hatchAngle, style.hatchSpacing];
  const EFFECT3 = YARN ? [
    style.fiber === false ? 0 : style.fiberMax,
    contourLength,
    style.curved === false ? 0 : 1,
    style.edgeRelief * (style.detail ? 0.3 : 1)
  ] : [0, style.echoY, 0, 0];
  return Float32Array.from([...bounds, ...EFFECT0, ...EFFECT1, ...EFFECT2, ...EFFECT3]);
}

// modules/rendering/yarn-material.js
var STITCH_FIELD_SIZE = 256;
var STITCH_FIELD_EXTENT = 0.8;
var STITCH_FIELD_MAX_DISTANCE = 0.25;
var STITCH_STRANDS = {
  left: [
    [-0.34, -0.36],
    [-0.32, -0.06],
    [-0.18, 0.17],
    [-0.025, 0.34]
  ],
  right: [
    [0.34, -0.36],
    [0.32, -0.06],
    [0.18, 0.17],
    [0.025, 0.34]
  ],
  under: [
    [-0.48, -0.46],
    [-0.22, -0.57],
    [0.22, -0.57],
    [0.48, -0.46]
  ]
};
var STITCH_TWISTS = [
  [
    [-0.32, -0.12],
    [-0.16, -0.13]
  ],
  [
    [0.22, 0.18],
    [0.37, 0.08]
  ]
];
var stitchFieldCache = null;
function stitchSegmentDistance(px, py, a, b) {
  const DX = b[0] - a[0], DY = b[1] - a[1];
  const T = Math.max(0, Math.min(1, ((px - a[0]) * DX + (py - a[1]) * DY) / Math.max(DX * DX + DY * DY, 1e-6)));
  return Math.hypot(px - (a[0] + DX * T), py - (a[1] + DY * T));
}
function stitchPolyline([a, b, c, d]) {
  const POINTS = [a];
  for (let i = 1; i <= 5; i++) {
    const T = i * 0.2, S = 1 - T;
    POINTS.push([
      S * S * S * a[0] + 3 * S * S * T * b[0] + 3 * S * T * T * c[0] + T * T * T * d[0],
      S * S * S * a[1] + 3 * S * S * T * b[1] + 3 * S * T * T * c[1] + T * T * T * d[1]
    ]);
  }
  return POINTS;
}
function stitchPolylineDistance(points, px, py) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, stitchSegmentDistance(px, py, points[i - 1], points[i]));
  }
  return best;
}
function stitchFieldPixels() {
  if (stitchFieldCache) {
    return stitchFieldCache;
  }
  const N = STITCH_FIELD_SIZE;
  const LEFT = stitchPolyline(STITCH_STRANDS.left), RIGHT = stitchPolyline(STITCH_STRANDS.right), UNDER = stitchPolyline(STITCH_STRANDS.under);
  const PACK = (distance) => Math.round(Math.min(1, distance / STITCH_FIELD_MAX_DISTANCE) * 255);
  const DATA = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const QX = -STITCH_FIELD_EXTENT + (i + 0.5) / N * STITCH_FIELD_EXTENT * 2, QY = -STITCH_FIELD_EXTENT + (j + 0.5) / N * STITCH_FIELD_EXTENT * 2;
      const AT = (j * N + i) * 4;
      DATA[AT] = PACK(Math.min(stitchPolylineDistance(LEFT, QX, QY), stitchPolylineDistance(RIGHT, QX, QY)));
      DATA[AT + 1] = PACK(stitchPolylineDistance(UNDER, QX, QY));
      DATA[AT + 2] = PACK(
        Math.min(
          stitchSegmentDistance(QX, QY, STITCH_TWISTS[0][0], STITCH_TWISTS[0][1]),
          stitchSegmentDistance(QX, QY, STITCH_TWISTS[1][0], STITCH_TWISTS[1][1])
        )
      );
      DATA[AT + 3] = 255;
    }
  }
  stitchFieldCache = DATA;
  return DATA;
}
var HELPERS = `float hashCell(vec2 cell, float salt) {
  return fract(sin(dot(cell, vec2(127.1, 311.7)) + u_effect0.x * 74.7 + salt * 19.19) * 43758.5453);
}
float lineMask(float distanceToLine, float width) {
  float aa = max(width * 0.16, 0.025);
  return 1.0 - smoothstep(max(0.0, width * 0.5 - aa), width * 0.5 + aa, distanceToLine);
}
vec3 tintTo(vec3 base, float amount) {
  return amount < 0.0 ? mix(base, vec3(0.0), -amount) : mix(base, vec3(1.0), amount);
}`;
var YARN_FRAGMENT_BODY = `
vec3 shadeYarnFill(vec3 base) {
  float stitchWidth = abs(u_effect0.y), stitchHeight = u_effect0.z;
  if (u_effect0.w < 0.0 || stitchWidth <= 0.0 || stitchHeight <= 0.0) return base;
  float cols = max(2.0, ceil(u_bounds.z / stitchWidth));
  float rows = max(2.0, ceil(u_bounds.w / stitchHeight));
  float sx = u_bounds.z / cols, sy = u_bounds.w / rows;
  vec2 local = v_local;
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
  vec2 cellSize = vec2(sx, sy);
  float fieldScale = ${STITCH_FIELD_MAX_DISTANCE.toFixed(4)} * sqrt(sx * sy);
  vec2 qBase = p / cellSize;
  vec2 grooveShift = vec2(0.0, stroke * 0.06) / cellSize;
  vec2 lightShift = vec2(stroke * 0.14, stroke * 0.13) / cellSize;
  vec4 fieldMain = texture2D(u_stitchField, (qBase + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  vec4 fieldGroove = texture2D(u_stitchField, (qBase - grooveShift + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  vec4 fieldLight = texture2D(u_stitchField, (qBase + lightShift + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  float under = lineMask(fieldGroove.g * fieldScale, stroke*0.5) * 0.5;
  float groove = lineMask(fieldGroove.r * fieldScale, stroke*1.08) * 0.85;
  float yarn = lineMask(fieldMain.r * fieldScale, stroke*0.89);
  float light = lineMask(fieldLight.r * fieldScale, stroke*0.34) * 0.57;
  float twist = 0.0;
  if (mod(index.x + index.y, 2.0) < 1.0) {
    twist = lineMask(fieldMain.b * fieldScale, stroke*0.075) * 0.5;
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
  float radial = v_material.w;
  float along = v_material.z * u_effect3.y;
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
  float angle=u_effect2.z, spacing=max(u_effect2.w,0.001);
  vec2 direction=vec2(cos(angle),sin(angle));
  float phase=dot(v_local,direction)/spacing + hashCell(vec2(u_effect0.x,0.0),31.0);
  float distanceToHatch=abs(fract(phase)-0.5)*spacing;
  float hatch=lineMask(distanceToHatch,u_effect2.x)*u_effect2.y;
  return mix(base,tintTo(base,-0.48),hatch);
}
void shadeSketchEdge(inout vec3 rgb, float alpha) {
  float phase=mod(v_time,max(u_effect0.y,16.0))/max(u_effect0.y,16.0)*6.2831853;
  float wobble=sin(v_material.z*u_effect0.z*6.2831853+phase+u_effect0.x)*u_effect1.x;
  float offset=(u_effect1.y+wobble);
  float echo=lineMask(abs(v_material.w-offset),u_effect1.z)*u_effect1.w;
  if(echo<0.012)discard;
  rgb=mix(rgb,tintTo(rgb,-0.52),echo);
  float outAlpha=alpha*echo;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
function materialFragment(maxPlanes, clipped, surfaceCount) {
  const PLANES = clipped ? `varying vec2 v_position; uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;` : "";
  const CLIP = clipped ? `for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}` : "";
  return `precision mediump float;
varying vec4 v_color; varying vec2 v_local; varying vec4 v_material; varying highp float v_time;
uniform vec4 u_materials[${surfaceCount * 5}]; uniform sampler2D u_stitchField;
${PLANES}
vec4 surfaceBounds; vec4 surfaceEffect0; vec4 surfaceEffect1; vec4 surfaceEffect2; vec4 surfaceEffect3;
#define u_bounds surfaceBounds
#define u_effect0 surfaceEffect0
#define u_effect1 surfaceEffect1
#define u_effect2 surfaceEffect2
#define u_effect3 surfaceEffect3
${HELPERS}
${YARN_FRAGMENT_BODY}
${SKETCH_FRAGMENT_BODY}
void main() {
  ${CLIP}
  int kind = int(v_material.x + 0.5);
  if (kind == 0) {
    gl_FragColor = v_color;
    return;
  }
  float alpha = v_color.a;
  if (alpha <= 0.0001) discard;
  // The surface constants are read once; the shading code below uses them dozens of times.
  int base = int(v_material.y + 0.5) * 5;
  surfaceBounds = u_materials[base];
  surfaceEffect0 = u_materials[base + 1];
  surfaceEffect1 = u_materials[base + 2];
  surfaceEffect2 = u_materials[base + 3];
  surfaceEffect3 = u_materials[base + 4];
  vec3 rgb = v_color.rgb / alpha;
  if (kind == 1) {
    rgb = shadeYarnFill(rgb);
    gl_FragColor = vec4(rgb * alpha, alpha);
  } else if (kind == 2) {
    shadeYarnEdge(rgb, alpha);
  } else if (kind == 3) {
    rgb = shadeSketchFill(rgb);
    gl_FragColor = vec4(rgb * alpha, alpha);
  } else {
    shadeSketchEdge(rgb, alpha);
  }
}`;
}

// modules/rendering/mesh-renderer.js
var IDENTITY2 = Object.freeze([1, 0, 0, 1, 0, 0]);
var ZERO_MORPH = Object.freeze([0, 0]);
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
var PLAIN_INSTANCE_FLOATS = 16;
var MATERIAL_INSTANCE_FLOATS = 20;
var MATERIAL_INSTANCE_ATTRIBUTE = { name: "i_extra", size: 4, offset: 64, source: "instance" };
var MATERIAL_VERTEX_FLOATS = 4;
var NO_TEXTURES = Object.freeze([]);
function shader(instanced, partCount, morphCount, clipped, nonScalingStroke, worldMode = false, poseTexture = false, paintRegionCount = 0, materials = false) {
  const MATERIAL_INPUT = materials ? `attribute vec4 a_material; ${instanced ? "attribute" : "uniform"} vec4 i_extra;
varying vec2 v_local; varying vec4 v_material; varying highp float v_time;` : "", MATERIAL_OUTPUT = materials ? "v_local=local;v_material=a_material;v_time=i_extra.x;" : "";
  const PAINT_INPUT = paintRegionCount ? `attribute float a_paintRegion;uniform vec4 u_paintRegions[${paintRegionCount + 1}];` : "", PAINT_COLOR = paintRegionCount ? "vec4 authored=a_color;vec4 paint=u_paintRegions[int(a_paintRegion)];authored.rgb=mix(authored.rgb,paint.rgb,paint.a);" : "", BASE_COLOR = paintRegionCount ? "authored" : "a_color";
  const PART_POSE = partCount > 1 || poseTexture;
  const PART_INPUTS = PART_POSE ? `${partCount > 1 ? "attribute float a_part;" : ""}uniform vec4 u_parts[${partCount * 3}];` : "";
  const PART_SETUP = PART_POSE ? `int index=${partCount > 1 ? "int(a_part)*3" : "0"};vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];` : "";
  const INPUTS = ["i_row0", "i_row1", "i_color", "i_params"].map((name) => `${instanced ? "attribute" : "uniform"} vec4 ${name};`).join("\n");
  const LOCAL = morphCount ? "a_position+a_morph.xy*(i_params.x" + (PART_POSE ? "+pose.x" : "") + ")" + (morphCount > 1 ? "+a_morph.zw*(i_params.y" + (PART_POSE ? "+pose.y" : "") + ")" : "") : "a_position";
  const STROKE_INPUTS = nonScalingStroke ? "attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;" : "";
  const STROKE_VARYING = clipped && nonScalingStroke ? "uniform mat3 u_inverseProjection;" : "";
  const STROKE_POSITION = nonScalingStroke ? `
vec2 tangentLocal=local+a_stroke.xy;
vec2 tangentPart=${PART_POSE ? "vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))" : "tangentLocal"};
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
    return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? "attribute vec4 a_morph;" : ""} ${PART_INPUTS}
${WORLD_INPUTS}${WORLD_STROKE_INPUTS}${PAINT_INPUT}${MATERIAL_INPUT}
uniform mat4 u_viewProjection; uniform vec4 u_color; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${MATERIAL_OUTPUT}vec2 plane=${PART_POSE ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec3 world=vec3(dot(i_row0.xyz,vec3(plane,1.0)),dot(i_row1.xyz,vec3(plane,1.0)),dot(i_row2.xyz,vec3(plane,1.0)));
vec4 projected=u_viewProjection*vec4(world,1.0);${clipped ? "v_position=world.xy;" : ""}${WORLD_STROKE}
projected.z+=(i_params.w+${PART_POSE ? "pose.w" : "0.0"})*projected.w;gl_Position=projected;
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*u_color,u_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? "*pose.z" : ""};color.rgb=mix(color.rgb,vec3(1.0),i_row2.w);v_color=vec4(color.rgb*color.a,color.a);
}`;
  }
  return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? "attribute vec4 a_morph;" : ""} ${PART_INPUTS}
${INPUTS}${STROKE_INPUTS}${PAINT_INPUT}${MATERIAL_INPUT}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? "varying vec2 v_position;" : ""}${STROKE_VARYING}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${MATERIAL_OUTPUT}vec2 p=${PART_POSE ? "vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))" : "local"};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? "v_position=world;" : ""}${STROKE_POSITION}
gl_Position=vec4(projected.xy,(i_params.w+${PART_POSE ? "pose.w" : "0.0"})*projected.z,projected.z);
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*i_color,i_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? "*pose.z" : ""};
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
function poseTextureShader(source) {
  return source.replace(/uniform vec4 u_parts\[\d+\];/, "uniform sampler2D u_poseTexture;").replace(
    /(int index=(?:int\(a_part\)\*3|0);)vec4 row0=u_parts\[index\];vec4 row1=u_parts\[index\+1\];vec4 pose=u_parts\[index\+2\];/,
    "$1int poseRow=int(-i_params.x-1.0);vec4 row0=texelFetch(u_poseTexture,ivec2(index,poseRow),0);vec4 row1=texelFetch(u_poseTexture,ivec2(index+1,poseRow),0);vec4 pose=texelFetch(u_poseTexture,ivec2(index+2,poseRow),0);"
  ).replaceAll("(i_params.x+pose.x)", "(pose.x)").replaceAll("(i_params.y+pose.y)", "(pose.y)");
}
function poseProgramShader(source) {
  return source.replace(/uniform vec4 u_parts\[\d+\];/, POSE_PROGRAM_FUNCTIONS).replace(
    /int index=(int\(a_part\)\*3|0);vec4 row0=u_parts\[index\];vec4 row1=u_parts\[index\+1\];vec4 pose=u_parts\[index\+2\];/,
    (_match, expression) => `int poseRow=int(-i_params.x-1.0);vec4 row0;vec4 row1;vec4 pose;poseEval(${expression === "0" ? "0" : expression.slice(0, -2)},poseRow,row0,row1,pose);`
  ).replaceAll("(i_params.x+pose.x)", "(pose.x)").replaceAll("(i_params.y+pose.y)", "(pose.y)");
}
function gpuVertexStream(vertices, regions, materials) {
  if (!regions && !materials) {
    return vertices;
  }
  const COUNT = vertices.length / 11, STRIDE = 11 + (regions ? 1 : 0) + (materials ? MATERIAL_VERTEX_FLOATS : 0);
  const PACKED = new Float32Array(COUNT * STRIDE);
  for (let index = 0; index < COUNT; index++) {
    const AT = index * STRIDE;
    PACKED.set(vertices.subarray(index * 11, index * 11 + 11), AT);
    let next = AT + 11;
    if (regions) {
      PACKED[next++] = regions[index];
    }
    if (materials) {
      PACKED.set(materials.subarray(index * MATERIAL_VERTEX_FLOATS, (index + 1) * MATERIAL_VERTEX_FLOATS), next);
    }
  }
  return PACKED;
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
  constructor(device, {
    maxMeshes = 512,
    maxMeshBytes = 32 * 1024 * 1024,
    maxInstances = 2048,
    safeAlphaRunBatching = true,
    poseBackend = "auto"
  } = {}) {
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
    if (!["auto", "cpu", "uniform"].includes(poseBackend)) {
      throw new TypeError("poseBackend must be auto, cpu or uniform");
    }
    this.poseBackend = poseBackend;
    this.poseRenderer = null;
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
    this.materialInstances = null;
    this.materialRunCache = /* @__PURE__ */ new WeakMap();
    this.stitchField = null;
    this.materialTextureSets = /* @__PURE__ */ new WeakMap();
    this.meshes = /* @__PURE__ */ new Set();
    this.bytes = 0;
    this.count = 0;
    this.pending = null;
    this.planes = new Float32Array(this.maxPlanes * 3);
    this.partScratch = new Float32Array(16 * 12);
    this.paintScratch = null;
    this.paintState = null;
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
          device.uploadVertices(MESH.buffer, MESH.gpuVertices);
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
    this.unregisterBatcher = device.registerBatcher((reason) => this.flush(reason));
    this.disposed = false;
  }
  _poses() {
    if (!this.poseRenderer) {
      this.poseRenderer = new PoseRenderer(this.device, {
        backend: this.poseBackend,
        onBoundary: () => this.device.flushBatchers("poseResourceBoundary")
      });
    }
    return this.poseRenderer;
  }
  createPoseSource(program) {
    return this._poses().createSource(program);
  }
  deletePoseSource(source) {
    return this.poseRenderer?.deleteSource(source) ?? false;
  }
  createPoseInstance(source) {
    return this._poses().createInstance(source);
  }
  deletePoseInstance(instance) {
    return this.poseRenderer?.deleteInstance(instance) ?? false;
  }
  preparePose(instance, options) {
    return this._poses().prepare(instance, options);
  }
  prepareCpuPose(instance, parts, morph, reason) {
    return this._poses().prepareCpu(instance, parts, morph, reason);
  }
  recordPoseFallback(reason) {
    this._poses().recordFallback(reason);
  }
  /** Updates all prepared numeric poses without changing visible submission order. */
  preparePoses() {
    this.poseRenderer?.flushUpdates();
  }
  poseStats() {
    return this.poseRenderer?.stats() ?? null;
  }
  _pipeline(mesh, clipped, worldMode = false, poseMode = 0) {
    const KEY = mesh.partCount + ":" + mesh.morphCount + ":" + Number(clipped) + ":" + Number(mesh.hasNonScalingStroke) + ":" + Number(worldMode) + ":" + poseMode + ":" + (mesh.paintRegionNames?.length ?? 0) + ":" + (mesh.materials?.count ?? 0);
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
    if (poseMode === 1) {
      UNIFORMS2.u_poseTexture = "1i";
    } else if (poseMode === 2) {
      Object.assign(UNIFORMS2, { u_program: "1i", u_state: "1i", u_overrides: "1i", u_programWidth: "1i" });
    } else if (mesh.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = "4fv";
    }
    if (mesh.paintRegionNames) {
      UNIFORMS2["u_paintRegions[0]"] = "4fv";
    }
    if (mesh.materials) {
      UNIFORMS2["u_materials[0]"] = "4fv";
      UNIFORMS2.u_stitchField = "1i";
    }
    if (!this.instanced) {
      for (const NAME of worldMode ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"]) {
        UNIFORMS2[NAME] = "4f";
      }
      if (mesh.materials) {
        UNIFORMS2.i_extra = "4f";
      }
    }
    pipeline = this.device.createPipeline({
      vertex: [(source) => source, poseTextureShader, poseProgramShader][poseMode](
        shader(
          this.instanced,
          poseMode ? Math.max(2, mesh.partCount) : mesh.partCount,
          mesh.morphCount,
          clipped,
          mesh.hasNonScalingStroke,
          worldMode,
          poseMode,
          mesh.paintRegionNames?.length ?? 0,
          Boolean(mesh.materials)
        )
      ),
      fragment: mesh.materials ? materialFragment(this.maxPlanes, clipped, mesh.materials.count) : fragment(this.maxPlanes, clipped),
      stride: mesh.bufferStrideFloats * 4,
      ...this.instanced ? { instanceStride: mesh.instanceFloats * 4 } : {},
      attributes: [
        ...mesh.paintRegionNames ? [{ name: "a_paintRegion", size: 1, offset: 44 }] : [],
        ...mesh.materials ? [{ name: "a_material", size: 4, offset: 44 + (mesh.paintRegionNames ? 4 : 0) }] : [],
        ...mesh.hasNonScalingStroke ? ATTRIBUTES.filter((attribute) => attribute.name !== "a_morph") : ATTRIBUTES,
        ...mesh.hasNonScalingStroke ? [
          {
            name: "a_stroke",
            size: 4,
            offset: 24
          }
        ] : [],
        ...this.instanced ? worldMode ? WORLD_INSTANCE_ATTRIBUTES : INSTANCE_ATTRIBUTES : [],
        ...this.instanced && mesh.materials ? [MATERIAL_INSTANCE_ATTRIBUTE] : []
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
    validatePaintRegionData(data.paintRegions, data.vertices.length / 11, INDICES);
    if (data.paintRegions) {
      for (const [, VARIANT] of [...EXPRESSION_ENTRIES, ...INDEX_VARIANT_ENTRIES]) {
        validatePaintRegionData(data.paintRegions, data.vertices.length / 11, VARIANT);
      }
    }
    const MATERIALS = data.materials;
    let ownedMaterials = null;
    if (MATERIALS !== void 0) {
      const SURFACES = MATERIALS?.table?.length / MATERIAL_RECORD_FLOATS;
      if (!(MATERIALS?.vertices instanceof Float32Array) || !(MATERIALS.table instanceof Float32Array) || MATERIALS.vertices.length !== data.vertices.length / 11 * MATERIAL_VERTEX_FLOATS || !Number.isSafeInteger(SURFACES) || SURFACES < 1 || SURFACES > MAX_MATERIAL_SURFACES || MATERIALS.table.some((n) => !Number.isFinite(n))) {
        throw new TypeError("Mesh materials need a per-vertex stream and a table of 1..16 surfaces");
      }
      for (let at = 0; at < MATERIALS.vertices.length; at += MATERIAL_VERTEX_FLOATS) {
        const KIND = MATERIALS.vertices[at], SURFACE = MATERIALS.vertices[at + 1];
        if (!Number.isInteger(KIND) || KIND < MATERIAL_KIND.none || KIND > MATERIAL_KIND.sketchEdge || !Number.isInteger(SURFACE) || SURFACE < 0 || SURFACE >= SURFACES || !Number.isFinite(MATERIALS.vertices[at + 2]) || !Number.isFinite(MATERIALS.vertices[at + 3])) {
          throw new RangeError("Mesh material kind or surface index is invalid");
        }
      }
      ownedMaterials = Object.freeze({
        vertices: MATERIALS.vertices.slice(),
        table: MATERIALS.table.slice(),
        count: SURFACES
      });
    }
    const PAINT_INDICES = data.paintRegions?.indices, BUFFER_STRIDE = 11 + (PAINT_INDICES ? 1 : 0) + (ownedMaterials ? MATERIAL_VERTEX_FLOATS : 0);
    const GPU_VERTEX_BYTES = data.vertices.length / 11 * BUFFER_STRIDE * 4;
    const UPLOAD_BYTE_LENGTH = GPU_VERTEX_BYTES + (INDICES?.byteLength ?? 0) + VARIANT_BYTE_LENGTH;
    const BYTE_LENGTH = UPLOAD_BYTE_LENGTH + (PAINT_INDICES || ownedMaterials ? data.vertices.byteLength : 0) + (ownedMaterials ? ownedMaterials.vertices.byteLength + ownedMaterials.table.byteLength : 0);
    if (this.meshes.size >= this.maxMeshes || this.bytes + BYTE_LENGTH > this.maxMeshBytes) {
      throw new RangeError("Retained mesh budget exceeded");
    }
    const VERTICES = data.vertices.slice(), GPU_VERTICES = gpuVertexStream(VERTICES, PAINT_INDICES, ownedMaterials?.vertices), OWNED_INDICES = INDICES?.slice(), BUFFER = this.device.createVertexBuffer({
      capacityBytes: GPU_VERTICES.byteLength
    });
    let indexBuffer;
    const OWNED_EXPRESSIONS = /* @__PURE__ */ new Map(), OWNED_VARIANTS = /* @__PURE__ */ new Map();
    try {
      this.device.uploadVertices(BUFFER, GPU_VERTICES);
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
      gpuVertices: GPU_VERTICES,
      indices: OWNED_INDICES,
      expressionIndices: OWNED_EXPRESSIONS,
      indexVariants: OWNED_VARIANTS,
      count: OWNED_INDICES?.length ?? VERTICES.length / 11,
      byteLength: BYTE_LENGTH,
      partCount: data.partCount,
      morphCount: data.morphCount,
      strideFloats: 11,
      bufferStrideFloats: BUFFER_STRIDE,
      paintRegionNames: data.paintRegions ? Object.freeze(data.paintRegions.names.slice()) : null,
      materials: ownedMaterials,
      instanceFloats: ownedMaterials ? MATERIAL_INSTANCE_FLOATS : PLAIN_INSTANCE_FLOATS,
      hasNonScalingStroke: NON_SCALING_STROKE,
      partBounds: meshPartBounds(VERTICES, data.partCount, data.morphCount)
    });
    this.meshes.add(MESH);
    this.bytes += BYTE_LENGTH;
    if (ownedMaterials) {
      this._materialTextures(null);
    }
    this.device.stats.meshCreates++;
    this.metrics.geometryUploads++;
    this.metrics.geometryBytesUploaded += UPLOAD_BYTE_LENGTH;
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
    this._drawPublic(mesh, options, options.matrix ?? IDENTITY2, 1);
  }
  _drawPublic(mesh, options, matrices, count) {
    const {
      projection: PROJECTION,
      morph: MORPH = [0, 0],
      parts: PARTS = null,
      pose: POSE = null,
      color: COLOR = WHITE,
      paintRegions: PAINT_REGIONS = null,
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
      timeMs: TIME_MS = 0,
      viewProjection: VIEW_PROJECTION,
      worldMatrix: WORLD_MATRIX
    } = options;
    this.drawMeshInstances(mesh, {
      matrices,
      count,
      projection: PROJECTION,
      viewProjection: VIEW_PROJECTION,
      worldMatrix: WORLD_MATRIX,
      morph: MORPH,
      parts: PARTS,
      pose: POSE,
      color: COLOR,
      paintRegions: PAINT_REGIONS,
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
      stencilRef: STENCIL_REF,
      timeMs: TIME_MS
    });
  }
  _setPaintRegions(mesh, overrides) {
    const NAMES = mesh.paintRegionNames ?? [], SIZE = NAMES.length ? (NAMES.length + 1) * 4 : 0;
    this.paintScratch ??= new Float32Array((MAX_PAINT_REGIONS + 1) * 4);
    packPaintRegions(NAMES, overrides, this.paintScratch);
    let same = (this.paintState?.length ?? 0) === SIZE;
    for (let index = 0; same && index < SIZE; index++) {
      same = this.paintState[index] === this.paintScratch[index];
    }
    if (same) {
      return;
    }
    this.flush("paintRegions");
    this.paintState = SIZE ? this.paintScratch.slice(0, SIZE) : null;
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
    if (MESH.paintRegionNames) {
      UNIFORMS2["u_paintRegions[0]"] = this.paintState;
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
  /**
   * Ordered instance append used when one retained pose has several transforms (silhouettes). `matrices` holds
   * six floats per instance and the first `prefixCount` instances use `prefixColor`. A mesh with materials that
   * writes depth is drawn in runs so a yarn or sketch edge, whose pixels are only partly covered, never writes depth;
   * the runs keep the triangle order, so painter order is unchanged.
   */
  drawMeshInstances(mesh, options = {}) {
    if (mesh?.materials && options.depthWrite === true && (options.depthWriteAlphaThreshold ?? null) === null && (options.indexRange ?? null) === null && this.meshes.has(mesh)) {
      const RUNS = this._materialRuns(mesh, options.indexVariant ?? null);
      if (RUNS.length > 1) {
        for (const RUN of RUNS) {
          this._drawMeshRange(mesh, {
            ...options,
            indexRange: [RUN.first, RUN.count],
            depthWrite: !RUN.edge
          });
        }
        return;
      }
    }
    this._drawMeshRange(mesh, options);
  }
  /** Contiguous runs of fill and edge triangles of one index list, cached per mesh. */
  _materialRuns(mesh, indexVariant) {
    let cache = this.materialRunCache.get(mesh);
    if (!cache) {
      cache = /* @__PURE__ */ new Map();
      this.materialRunCache.set(mesh, cache);
    }
    const KEY = indexVariant ?? "";
    let runs = cache.get(KEY);
    if (!runs) {
      const VARIANT = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
      const INDICES = VARIANT ? VARIANT.indices : mesh.indices, COUNT = VARIANT ? VARIANT.count : mesh.count;
      runs = [];
      for (let at = 0; at < COUNT; at += 3) {
        const VERTEX2 = INDICES ? INDICES[at] : at, KIND = mesh.materials.vertices[VERTEX2 * MATERIAL_VERTEX_FLOATS], EDGE = KIND === MATERIAL_KIND.yarnEdge || KIND === MATERIAL_KIND.sketchEdge, LAST = runs.at(-1);
        if (LAST && LAST.edge === EDGE) {
          LAST.count += 3;
        } else {
          runs.push({ first: at, count: 3, edge: EDGE });
        }
      }
      cache.set(KEY, runs);
    }
    return runs;
  }
  _drawMeshRange(mesh, {
    matrices,
    count,
    projection,
    viewProjection,
    worldMatrix,
    morph = [0, 0],
    parts = null,
    pose = null,
    color = WHITE,
    paintRegions = null,
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
    stencilRef = null,
    timeMs = 0
  } = {}) {
    this._ready();
    if (!this.meshes.has(mesh)) {
      throw new TypeError("Mesh owned by this renderer required");
    }
    if (!Number.isFinite(timeMs)) {
      throw new TypeError("timeMs must be finite");
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
    finiteArray2(color, 4, "color");
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
      } else if (clipPlanes(clips, this.maxPlanes).count) {
        inverseViewProjection = invertMatrix4(viewProjection);
      }
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some((n) => n < 0 || n > 1)) {
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
    if (mesh.materials && depthWriteAlphaThreshold !== null) {
      throw new TypeError("Meshes with materials do not support depthWriteAlphaThreshold");
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
    if (indexRange !== null && (!Array.isArray(indexRange) || indexRange.length !== 2 || !Number.isSafeInteger(indexRange[0]) || !Number.isSafeInteger(indexRange[1]) || indexRange[0] < 0 || indexRange[1] < 0 || indexRange[0] % 3 || indexRange[1] % 3)) {
      throw new TypeError("indexRange must be [firstIndex, triangleAlignedCount]");
    }
    if (indexRange !== null && depthWriteAlphaThreshold !== null) {
      throw new TypeError("indexRange is currently supported only for ordinary ordered mesh draws");
    }
    const CLIP = clipPlanes(clips, this.maxPlanes);
    const VARIANT = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    const FIRST_INDEX = indexRange?.[0] ?? 0, INDEX_COUNT = indexRange?.[1] ?? VARIANT?.count ?? mesh.count;
    if (FIRST_INDEX + INDEX_COUNT > (VARIANT?.count ?? mesh.count)) {
      throw new RangeError("indexRange exceeds the selected mesh index data");
    }
    const POSE_DRAW = pose === null ? null : this._poses().resolve(pose);
    if (POSE_DRAW && POSE_DRAW.partCount !== mesh.partCount) {
      throw new TypeError("Pose and mesh part counts must match");
    }
    if (POSE_DRAW && depthWriteAlphaThreshold !== null) {
      throw new TypeError("Alpha depth classification requires ordinary CPU part poses");
    }
    packParts(parts, mesh.partCount, this.partScratch);
    for (let i = 0; i < mesh.partCount; i++) {
      if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) {
        throw new RangeError("combined mesh and part depth must be in [-1,1]");
      }
    }
    if (mesh.paintRegionNames || paintRegions !== null || this.paintState) {
      this._setPaintRegions(mesh, paintRegions);
    }
    const PENDING = this.pending;
    const DEPTH_STATE_KEY = Number(depthTest) + ":" + Number(depthWrite) + ":" + depthFunc;
    const ALPHA_DEPTH_WRITE = depthWrite && depthWriteAlphaThreshold !== null;
    if (!ALPHA_DEPTH_WRITE) {
      const INSTANCE_LIMIT = this.maxInstances;
      const INSTANCE_FLOATS = mesh.instanceFloats;
      const DATA = this._instanceData(mesh);
      if (this.alphaQueueCount) {
        this._flushAlphaQueue("alphaBoundary");
      }
      if (PENDING) {
        const MATRIX = WORLD_MODE ? viewProjection : projection;
        const PREVIOUS_COLOR = PENDING.color;
        const REASON = (PENDING.poseTexture ?? null) !== (POSE_DRAW?.texture ?? null) ? "poseBackend" : PENDING.mesh !== mesh ? "mesh" : PENDING.worldMode !== WORLD_MODE ? "transformMode" : PENDING.indexVariant !== indexVariant ? "indexVariant" : PENDING.firstIndex !== FIRST_INDEX || PENDING.indexCount !== INDEX_COUNT ? "indexRange" : PENDING.clip.key !== CLIP.key ? "clip" : PENDING.stencilRef !== stencilRef ? "stencil" : PENDING.depthStateKey !== DEPTH_STATE_KEY ? "depthState" : MATRIX.some((n, i) => Math.fround(n) !== PENDING.projection[i]) ? "projection" : strokeSize && strokeSize.some((n, i) => n !== PENDING.strokeSize?.[i]) ? "strokeViewport" : WORLD_MODE && color.some((n, i) => n !== PREVIOUS_COLOR[i]) ? "color" : !POSE_DRAW && mesh.partCount > 1 && PENDING.parts.some((n, i) => n !== this.partScratch[i]) ? "parts" : this.count === INSTANCE_LIMIT ? "capacity" : null;
        if (REASON) {
          this.flush(REASON);
        }
      }
      if (VARIANT?.count === 0) {
        return;
      }
      const PART2 = this.partScratch, SINGLE_PART2 = mesh.partCount === 1 && !POSE_DRAW;
      for (let i = 0; i < count; i++) {
        if (this.count === INSTANCE_LIMIT) {
          this.flush("capacity");
        }
        if (!this.pending) {
          this.pending = {
            mesh,
            poseTexture: POSE_DRAW?.texture ?? null,
            poseTextures: POSE_DRAW?.textures ?? null,
            poseKind: POSE_DRAW?.kind ?? null,
            poseProgramWidth: POSE_DRAW?.programWidth ?? 0,
            projection: Float32Array.from(WORLD_MODE ? viewProjection : projection),
            worldMode: WORLD_MODE,
            color: Float32Array.from(color),
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
        let weight0 = POSE_DRAW ? -1 - POSE_DRAW.row : morph[0];
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
        const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
        const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor, AT = this.count++ * INSTANCE_FLOATS;
        const INSTANCE_DEPTH = depth + (SINGLE_PART2 ? PART2[11] : 0);
        if (POSE_DRAW) {
          this.poseRenderer.noteDraw(pose);
        }
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
        if (mesh.materials) {
          DATA[AT + 16] = timeMs;
          DATA[AT + 17] = 0;
          DATA[AT + 18] = 0;
          DATA[AT + 19] = 0;
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
      const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
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
      const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
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
    if (mesh.paintRegionNames) {
      UNIFORMS2["u_paintRegions[0]"] = this.paintState;
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
      stencilRef: STENCIL_REF,
      poseTexture: POSE_TEXTURE,
      poseTextures: POSE_TEXTURES,
      poseKind: POSE_KIND,
      poseProgramWidth: POSE_PROGRAM_WIDTH
    } = this.pending;
    const VARIANT = INDEX_VARIANT === null ? null : MESH.indexVariants.get(INDEX_VARIANT) ?? MESH.expressionIndices.get(INDEX_VARIANT);
    this.planes.fill(0);
    if (CLIP.values) {
      this.planes.set(CLIP.values);
    }
    if (POSE_TEXTURE) {
      this.poseRenderer.flushUpdates();
    }
    const PIPELINE = this._pipeline(
      MESH,
      CLIP.count > 0,
      WORLD_MODE,
      POSE_KIND === "program" ? 2 : POSE_KIND === "matrix" ? 1 : 0
    ), UNIFORMS2 = WORLD_MODE ? {
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
    if (MESH.paintRegionNames) {
      UNIFORMS2["u_paintRegions[0]"] = this.paintState;
    }
    if (POSE_KIND === "program") {
      Object.assign(UNIFORMS2, { u_program: 0, u_state: 1, u_overrides: 2, u_programWidth: POSE_PROGRAM_WIDTH });
    } else if (POSE_KIND === "matrix") {
      UNIFORMS2.u_poseTexture = 0;
    } else if (MESH.partCount > 1) {
      UNIFORMS2["u_parts[0]"] = PARTS;
    }
    const TEXTURES = MESH.materials ? this._materialTextures(POSE_TEXTURES) : POSE_TEXTURES ?? NO_TEXTURES;
    if (MESH.materials) {
      UNIFORMS2["u_materials[0]"] = MESH.materials.table;
      UNIFORMS2.u_stitchField = TEXTURES.length - 1;
    }
    const INSTANCE_UNIFORMS = [
      ...WORLD_MODE ? ["i_row0", "i_row1", "i_row2", "i_params"] : ["i_row0", "i_row1", "i_color", "i_params"],
      ...MESH.materials ? ["i_extra"] : []
    ];
    const INSTANCE_FLOATS = MESH.instanceFloats;
    const INSTANCE_DATA = this._instanceData(MESH);
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, INSTANCE_DATA.subarray(0, this.count * INSTANCE_FLOATS));
      this.device.draw({
        pipeline: PIPELINE,
        buffer: MESH.buffer,
        indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
        first: FIRST_INDEX,
        count: INDEX_COUNT,
        instanceBuffer: this.instanceBuffer,
        instances: this.count,
        uniforms: UNIFORMS2,
        textures: TEXTURES,
        depth: DEPTH_STATE,
        stencil: STENCIL_REF === null ? false : {
          func: "equal",
          ref: STENCIL_REF,
          mask: 255,
          writeMask: 0,
          pass: "keep"
        }
      });
      this.metrics.instanceBytesUploaded += this.count * INSTANCE_FLOATS * 4;
      this.metrics.draws++;
      this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
      if (MESH.partCount > 1 && !POSE_TEXTURE) {
        this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < INSTANCE_UNIFORMS.length; j++) {
          UNIFORMS2[INSTANCE_UNIFORMS[j]] = INSTANCE_DATA.subarray(
            i * INSTANCE_FLOATS + j * 4,
            i * INSTANCE_FLOATS + j * 4 + 4
          );
        }
        this.device.draw({
          pipeline: PIPELINE,
          buffer: MESH.buffer,
          indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
          first: FIRST_INDEX,
          count: INDEX_COUNT,
          uniforms: UNIFORMS2,
          textures: TEXTURES,
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
  /** The staging array holding this mesh's instance records. */
  _instanceData(mesh) {
    if (mesh.instanceFloats === PLAIN_INSTANCE_FLOATS) {
      return this.instances;
    }
    this.materialInstances ??= new Float32Array(this.maxInstances * MATERIAL_INSTANCE_FLOATS);
    return this.materialInstances;
  }
  /** Pose textures followed by the shared stitch distance field; the field's unit is the last one. */
  _materialTextures(poseTextures) {
    this.stitchField ??= this.device.createTexture(
      { width: STITCH_FIELD_SIZE, height: STITCH_FIELD_SIZE, data: stitchFieldPixels() },
      { premultiplied: true, filter: "linear" }
    );
    const KEY = poseTextures ?? NO_TEXTURES;
    let set = this.materialTextureSets.get(KEY);
    if (!set) {
      set = Object.freeze([...KEY, this.stitchField]);
      this.materialTextureSets.set(KEY, set);
    }
    return set;
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
    this.poseRenderer?.beginFrame();
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
      stagingBytes: this.instances.byteLength + (this.materialInstances?.byteLength ?? 0) + this.planes.byteLength + this.partScratch.byteLength,
      instanced: this.instanced,
      maxClipPlanes: this.maxPlanes,
      poses: this.poseStats()
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.discard();
    this.poseRenderer?.dispose();
    this.unregisterBatcher();
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
    if (this.stitchField) {
      this.device.deleteTexture(this.stitchField);
      this.stitchField = null;
    }
    for (const PIPELINE of this.pipelines.values()) {
      this.device.deletePipeline(PIPELINE);
    }
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
var COLOR_CACHE = /* @__PURE__ */ new Map();
function cacheColor(key, rgbaValue) {
  if (typeof key === "string") {
    if (COLOR_CACHE.size >= 512) {
      COLOR_CACHE.clear();
    }
    COLOR_CACHE.set(key, rgbaValue);
  }
  return rgbaValue.slice();
}
function normalizeColor(value) {
  if (typeof value === "string") {
    const HIT = COLOR_CACHE.get(value);
    if (HIT) {
      return HIT.slice();
    }
  }
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
    return cacheColor(value, [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    ]);
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
    return cacheColor(value, OUT);
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
    return cacheColor(value, [F(0), F(8), F(4), A]);
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
var RAMP_KEY = (gradient) => (gradient instanceof LinearGradient ? "L" : "R") + gradient.stops.map((stop) => `${stop.offset}:${stop.color.join(",")}`).join(";");
var COMPOSE_AFFINE = (outer, inner) => {
  const [A, B, C, D, E, F] = inner;
  return [
    outer[0] * A + outer[2] * B,
    outer[1] * A + outer[3] * B,
    outer[0] * C + outer[2] * D,
    outer[1] * C + outer[3] * D,
    outer[0] * E + outer[2] * F + outer[4],
    outer[1] * E + outer[3] * F + outer[5]
  ];
};
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
    glyphAtlas = null,
    initialVertices = 4096,
    maxVertices = 262144,
    onError = null,
    safeAlphaRunBatching = true,
    mesh = {}
  } = {}) {
    if (!device?.beginFrame || !device?.endFrame || !device?.createVertexBuffer) {
      throw new TypeError("WebGLDevice is required");
    }
    if (mesh === null || typeof mesh !== "object") {
      throw new TypeError("mesh must be an option object");
    }
    this.device = device;
    this.canvas = device.canvas;
    this.vector = new VectorRenderer(device, {
      initialVertices,
      maxVertices,
      glyphAtlas
    });
    this.glyphAtlas = glyphAtlas ?? this.vector.glyphAtlas;
    this.meshOptions = mesh;
    this.disposers = [];
    this.onError = typeof onError === "function" ? onError : null;
    if (typeof safeAlphaRunBatching !== "boolean") {
      throw new TypeError("safeAlphaRunBatching must be a boolean");
    }
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    this.meshRenderer = null;
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
    this.rampCache = /* @__PURE__ */ new Map();
    this.lostGradientRegions = [];
    this._silhouetteMatrices = new Float32Array(60);
    this._scaledSilhouetteMatrices = new Float32Array(12);
    this._silhouetteColorCache = /* @__PURE__ */ new Map();
    this.onLost = (event) => {
      event.preventDefault();
      this.active = false;
      this.state = "lost";
      this.meshRenderer?.discard();
      for (const RAMP of this.rampCache.values()) {
        this.lostGradientRegions.push(RAMP.region);
      }
      this.rampCache.clear();
      this.gradientTextures.clear();
    };
    this.onRestored = () => {
      if (this.state === "disposed") {
        return;
      }
      try {
        for (const MESH of this.staticMeshes) {
          this.device.uploadVertices(MESH.buffer, MESH.vertices);
        }
        for (const REGION of this.lostGradientRegions.splice(0)) {
          REGION.atlas.release(REGION);
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
    this._composite = "source-over";
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
  get globalCompositeOperation() {
    return this._composite;
  }
  set globalCompositeOperation(v) {
    this._frame();
    if (v !== "source-over" && v !== "lighter") {
      throw new RangeError("VectorContext supports only source-over and lighter composite operations");
    }
    this.vector.setBlend(v);
    this._composite = v;
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
    if (!cached || cached.revision !== gradient.revision) {
      cached = {
        ramp: this._ramp(gradient),
        revision: gradient.revision
      };
      this.gradientTextures.set(gradient, cached);
    }
    cached.ramp.lastFrame = this.frame;
    const MATRIX_INVERSE = invert(gradient.matrix);
    if (!MATRIX_INVERSE) {
      throw new RangeError("Gradient transform is singular");
    }
    const COLOR = normalizeColor(this.forceColor ?? [1, 1, 1, 1]);
    COLOR[3] *= this._globalAlpha;
    if (gradient instanceof LinearGradient) {
      return {
        region: cached.ramp.region,
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
      region: cached.ramp.region,
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
  /** Returns the retained ramp texture for the gradient's stops, rasterizing and uploading it on first use. */
  _ramp(gradient) {
    const KEY = RAMP_KEY(gradient);
    let ramp = this.rampCache.get(KEY);
    if (ramp) {
      return ramp;
    }
    if (this.rampCache.size >= MAX_GRADIENT_TEXTURES) {
      const EXPIRED = [...this.rampCache].find(([, entry]) => entry.lastFrame < this.frame);
      if (!EXPIRED) {
        throw new RangeError(
          `VectorContext supports at most ${MAX_GRADIENT_TEXTURES} distinct gradients in one frame`
        );
      }
      EXPIRED[1].region.atlas.release(EXPIRED[1].region);
      this.rampCache.delete(EXPIRED[0]);
    }
    const WIDTH = gradient instanceof LinearGradient ? LINEAR_GRADIENT_SIZE : 256, REGION = this.device.textureAtlas.allocate(WIDTH, 1);
    this.device.textureAtlas.upload(
      REGION,
      { width: WIDTH, height: 1, data: gradient.raster() },
      { premultiplied: true, extendEdges: true }
    );
    gradient.pixels = null;
    ramp = { region: REGION, lastFrame: this.frame };
    this.rampCache.set(KEY, ramp);
    return ramp;
  }
  _releaseGradientTextures() {
    for (const CACHED of this.rampCache.values()) {
      try {
        CACHED.region.atlas.release(CACHED.region);
      } catch (error) {
        try {
          this.onError?.(error, {
            phase: "gradient-release"
          });
        } catch {
        }
      }
    }
    this.rampCache.clear();
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
      this.gradientTextures.clear();
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
        paths: this.pathCount
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
      composite: this._composite,
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
      _composite: S.composite,
      forceColor: S.forceColor
    });
    this.vector.setBlend(S.composite);
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
  _submitPrimitive(matrix, color, params) {
    this.meshRenderer?.flush("primitiveBoundary");
    this.vector.drawPrimitive({ matrix, color, params });
    return true;
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
    this.meshRenderer?.flush("clipBoundary");
    this.vector.clipRect(x, y, w, h);
  }
  fillTriangleFan(points, paint = this._fillStyle) {
    this._frame();
    this.meshRenderer?.flush("vectorBoundary");
    if (points.length < 3) {
      return;
    }
    this.vector.triangleFan(points, this._paint(paint));
  }
  beginGroup(opacity = 1, bounds = null) {
    this._frame();
    if (opacity !== 1) {
      this.meshRenderer?.flush("groupBoundary");
    }
    this.vector.beginGroup(opacity, bounds);
  }
  endGroup() {
    if (!this.vector.groups.at(-1)?.direct) {
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
    const ALPHA = this._globalAlpha, BOUNDS = this.groupBounds(0, 0, radius + width);
    return this.withGroupOpacity(
      ALPHA,
      () => {
        this.withColor(color, () => {
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
    return this.acquireMeshRenderer().createMesh(data);
  }
  /** The retained-mesh renderer this context shares with the vector assets and atlases built on it. */
  acquireMeshRenderer() {
    if (this.state !== "ready" || this.device.state !== "ready") {
      throw new Error("VectorContext is not ready");
    }
    this.meshRenderer ??= new MeshRenderer(this.device, {
      ...this.meshOptions,
      safeAlphaRunBatching: this.safeAlphaRunBatching
    });
    return this.meshRenderer;
  }
  /** Registers cleanup that `dispose()` runs, newest first, before it disposes the renderers it owns. */
  onDispose(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onDispose requires a function");
    }
    this.disposers.push(callback);
  }
  /**
   * Atlas rectangles (sprites, baked vector runs, posed parts) on the current transform and clip; they join the
   * vector stream, so they share a draw with the shapes and text around them. See VectorRenderer.drawQuads.
   */
  drawQuads(options) {
    this._frame();
    this.meshRenderer?.flush("quadBoundary");
    this.vector.drawQuads(options);
  }
  /**
   * Draws a texture atlas region like Canvas `drawImage(image, x, y, width, height)`: top-left anchored on the
   * current transform, in the same stream draw as the surrounding paint. `source` (`[x, y, width, height]` region
   * pixels) selects part of the region. Uses `globalAlpha`, white flash and `forceColor` like other paint.
   */
  drawRegion(region, x, y, width = region?.width, height = region?.height, { source = null } = {}) {
    if (!region?.atlas?.regions?.has(region) || region.atlas !== this.device.textureAtlas) {
      throw new TypeError("A live region of the device texture atlas is required");
    }
    const [SX, SY, SW, SH] = source ?? [0, 0, region.width, region.height];
    for (const VALUE of [x, y, width, height, SX, SY, SW, SH]) {
      finite(VALUE, "drawRegion value");
    }
    if (SX < 0 || SY < 0 || SW <= 0 || SH <= 0 || SX + SW > region.width || SY + SH > region.height) {
      throw new RangeError("source must lie inside the region");
    }
    const ATLAS = region.atlas;
    this.drawQuads({
      layer: region.layer,
      filter: region.filter,
      uvRects: Float32Array.of(
        (region.x + SX) / ATLAS.width,
        (region.y + SY) / ATLAS.height,
        SW / ATLAS.width,
        SH / ATLAS.height
      ),
      localRects: Float32Array.of(x, y, width, height),
      color: normalizeColor(this.forceColor ?? [1, 1, 1, 1]),
      forceColor: this.forceColor !== null,
      alpha: this._globalAlpha,
      whiteFlash: this._filter === "brightness(0) invert(1)"
    });
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
    this.vector.flush();
    let matrix = this.vector.matrix;
    if (transform) {
      if (transform.length !== 6 || Array.from(transform).some((n) => !Number.isFinite(n))) {
        throw new TypeError("Six finite transform values required");
      }
      matrix = COMPOSE_AFFINE(matrix, transform);
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
    color = "black",
    width,
    radius = 128,
    outlineScale = null
  } = {}) {
    this._frame();
    if (!this.meshRenderer) {
      throw new TypeError("createMesh required");
    }
    return this._silhouette(
      { transform, color, width, radius, outlineScale },
      (instances) => this.meshRenderer.drawMeshInstances(mesh, {
        ...instances,
        morph,
        parts,
        color: this.forceColor ?? WHITE2,
        forceColor: this.forceColor !== null,
        alpha: this._globalAlpha,
        whiteFlash: this._filter === "brightness(0) invert(1)",
        clips: this.vector.clips,
        stencilRef: this.vector.stencilDepth || null
      })
    );
  }
  /**
   * Draw a vector actor's silhouette and body in one ordered instance batch, like drawMeshSilhouette. `matrix` is
   * the actor's local matrix; the other options are drawVectorActor's (no world mode).
   */
  drawVectorActorSilhouette(actor, { matrix = null, color = "black", width, radius = 128, outlineScale = null, ...options } = {}) {
    this._frame();
    if (typeof actor?.draw !== "function") {
      throw new TypeError("A vector actor is required");
    }
    if (options.viewProjection !== void 0 || options.worldMatrix !== void 0) {
      throw new TypeError("Actor silhouettes are 2D only");
    }
    return this._silhouette(
      { transform: matrix, color, width, radius, outlineScale },
      (instances) => actor.draw({ ...this._actorParams(options), projection: instances.projection, instances })
    );
  }
  /** Silhouette instance transforms for the current context transform; `submit` appends them as one draw. */
  _silhouette({ transform, color, width, radius, outlineScale }, submit) {
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
    if (typeof color === "string" && color[0] === "#") {
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
        submit({
          matrices: MATRICES,
          count: COUNT,
          projection: this.vector.projection,
          prefixColor: outline,
          prefixCount: OUTLINE_INSTANCES,
          forceColorPrefixCount: OUTLINE_INSTANCES
        });
      },
      BOUNDS
    );
  }
  /** Actor draw parameters from the context state: paint state applies and the caller's alpha multiplies. */
  _actorParams(options) {
    const FORCED = options.forceColor ?? this.forceColor !== null;
    return {
      clips: this.vector.clips,
      stencilRef: this.vector.stencilDepth || null,
      ...options,
      alpha: (options.alpha ?? 1) * this._globalAlpha,
      forceColor: FORCED,
      color: options.color ?? (this.forceColor && FORCED ? this.forceColor : [1, 1, 1, 1]),
      whiteFlash: options.whiteFlash ?? this._filter === "brightness(0) invert(1)"
    };
  }
  /** Submit a vector actor after earlier paint, without flushing a compatible mesh run. */
  drawVectorActor(actor, options = {}) {
    this._frame();
    if (typeof actor?.draw !== "function") {
      throw new TypeError("A vector actor is required");
    }
    this.vector.flush();
    const WORLD_MODE = options.viewProjection !== void 0 || options.worldMatrix !== void 0, PARAMS = this._actorParams(options);
    if (!WORLD_MODE) {
      PARAMS.projection = this.vector.projection;
      if (options.matrix) {
        if (options.matrix.length !== 6 || Array.from(options.matrix).some((n) => !Number.isFinite(n))) {
          throw new TypeError("Six finite matrix values required");
        }
        PARAMS.matrix = COMPOSE_AFFINE(this.vector.matrix, options.matrix);
      } else {
        PARAMS.matrix = this.vector.matrix.slice();
      }
    }
    actor.draw(PARAMS);
  }
  /** Evaluates every prepared actor pose now, before the actors are submitted. */
  preparePoses() {
    this.meshRenderer?.preparePoses();
  }
  flush(reason = "explicit") {
    this._frame();
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
      backend: "webgl2",
      available: this.device.state === "ready",
      contextLost: this.device.state === "lost",
      failure: this.device.failure ?? null,
      frame: this.frame,
      ...this.frameStats,
      mesh: this.meshRenderer?.stats() ?? null,
      stagingBytes: this.vector.vertices.byteLength,
      gpuBufferBytes: this.device.stats.gpuBufferBytes ?? 0,
      gpuRenderTargetBytes: this.device.stats.gpuRenderTargetBytes ?? 0,
      textureCount: this.device.stats.textureCount ?? 0,
      activeGradientTextureCount: this.gradientTextures.size,
      retainedGradientRampCount: this.rampCache.size,
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
    for (const CALLBACK of this.disposers.splice(0).reverse()) {
      CALLBACK();
    }
    this.meshRenderer?.dispose();
    for (const MESH of this.staticMeshes) {
      this.device.deleteVertexBuffer(MESH.buffer);
    }
    this._releaseGradientTextures();
    this.staticMeshes.clear();
    this.deferredMeshes.length = 0;
    this.vector.dispose();
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
    this.poly(
      unitDirections(sides, rotation).map((p) => [x + p[0] * radius, y + p[1] * radius]),
      paint
    );
  }
  ellipse(x, y, radiusX, radiusY, paint, segments = 24, rotation = 0) {
    if (segments < 3 || radiusX <= 0 || radiusY <= 0) {
      return;
    }
    const COS = Math.cos(rotation), SIN = Math.sin(rotation);
    this.poly(
      unitDirections(segments, 0).map((p) => {
        const PX = p[0] * radiusX, PY = p[1] * radiusY;
        return [x + PX * COS - PY * SIN, y + PX * SIN + PY * COS];
      }),
      paint
    );
  }
  box(centerX, centerY, width, height, paint, angle = 0) {
    const HALF_W = width / 2, HALF_H = height / 2, COS = Math.cos(angle), SIN = Math.sin(angle), CORNER = (dx, dy) => [centerX + dx * COS - dy * SIN, centerY + dx * SIN + dy * COS];
    this.poly(
      [CORNER(-HALF_W, -HALF_H), CORNER(HALF_W, -HALF_H), CORNER(HALF_W, HALF_H), CORNER(-HALF_W, HALF_H)],
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
function unitDirections(sides, rotation) {
  const KEY = `${sides}|${rotation}`;
  let unit = PRIMITIVE_DIRECTIONS.get(KEY);
  if (!unit) {
    unit = Array.from(
      {
        length: sides
      },
      (_, i) => [Math.cos(rotation + i / sides * TAU), Math.sin(rotation + i / sides * TAU)]
    );
    PRIMITIVE_DIRECTIONS.set(KEY, unit);
  }
  return unit;
}

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

// modules/rendering/sprite-animation.js
function createSpriteAnimation(context, region, definition) {
  if (!context?.drawQuads || !context?.device?.textureAtlas) {
    throw new TypeError("A VectorContext is required");
  }
  if (!region?.atlas?.regions?.has(region) || region.atlas !== context.device.textureAtlas) {
    throw new TypeError("A live region of the device texture atlas is required");
  }
  const ATLAS_WIDTH = region.atlas.width;
  const ATLAS_HEIGHT = region.atlas.height;
  const REGION_WIDTH = region.width;
  const REGION_HEIGHT = region.height;
  const INPUT_FRAMES = definition?.frames;
  const INPUT_CLIPS = definition?.clips;
  const TEXTURE_ORIGIN = definition?.textureOrigin ?? "top-left";
  if (TEXTURE_ORIGIN !== "top-left" && TEXTURE_ORIGIN !== "bottom-left") {
    throw new TypeError("textureOrigin must be top-left or bottom-left");
  }
  if (!Array.isArray(INPUT_FRAMES) || INPUT_FRAMES.length < 1 || INPUT_FRAMES.length > 4096) {
    throw new RangeError("Sprite animation requires 1..4096 atlas frames");
  }
  if (!INPUT_CLIPS || typeof INPUT_CLIPS !== "object" || Array.isArray(INPUT_CLIPS)) {
    throw new TypeError("Named sprite clips are required");
  }
  const FRAMES = [];
  const FRAME_RECTS = [];
  const INTEGER = (value, name, minimum = 0) => {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`${name} must be an integer >= ${minimum}`);
    }
  };
  for (let index = 0; index < INPUT_FRAMES.length; index++) {
    const FRAME = INPUT_FRAMES[index];
    const X = FRAME?.x;
    const Y = FRAME?.y;
    const WIDTH = FRAME?.width;
    const HEIGHT = FRAME?.height;
    const GUTTER = FRAME?.gutter ?? definition.gutter ?? 0;
    const SOURCE_WIDTH = FRAME?.sourceWidth ?? definition.sourceWidth ?? WIDTH;
    const SOURCE_HEIGHT = FRAME?.sourceHeight ?? definition.sourceHeight ?? HEIGHT;
    const SOURCE_X = FRAME?.sourceX ?? 0;
    const SOURCE_Y = FRAME?.sourceY ?? 0;
    const PIVOT_X = FRAME?.pivotX ?? definition.pivotX ?? 0;
    const PIVOT_Y = FRAME?.pivotY ?? definition.pivotY ?? 0;
    const DURATION_MS = FRAME?.durationMs;
    for (const [NAME, VALUE, MINIMUM] of [
      ["frame x", X, 0],
      ["frame y", Y, 0],
      ["frame width", WIDTH, 1],
      ["frame height", HEIGHT, 1],
      ["frame gutter", GUTTER, 0],
      ["source width", SOURCE_WIDTH, 1],
      ["source height", SOURCE_HEIGHT, 1],
      ["source x", SOURCE_X, 0],
      ["source y", SOURCE_Y, 0]
    ]) {
      INTEGER(VALUE, NAME, MINIMUM);
    }
    if (X - GUTTER < 0 || Y - GUTTER < 0 || X + WIDTH + GUTTER > REGION_WIDTH || Y + HEIGHT + GUTTER > REGION_HEIGHT || SOURCE_X + WIDTH > SOURCE_WIDTH || SOURCE_Y + HEIGHT > SOURCE_HEIGHT) {
      throw new RangeError("Sprite frame, its gutter, or its trim exceeds its region/source viewport");
    }
    if (!Number.isFinite(PIVOT_X) || !Number.isFinite(PIVOT_Y)) {
      throw new TypeError("Sprite pivot coordinates must be finite");
    }
    if (!Number.isFinite(DURATION_MS) || DURATION_MS <= 0 || DURATION_MS > 1e9) {
      throw new RangeError("Sprite frame durationMs must be positive and at most 1,000,000,000");
    }
    const LEFT = SOURCE_X - PIVOT_X;
    const TOP = SOURCE_Y - PIVOT_Y;
    const BOTTOM_UP = TEXTURE_ORIGIN === "bottom-left";
    const U0 = (region.x + X) / ATLAS_WIDTH;
    const V0 = BOTTOM_UP ? (region.y + REGION_HEIGHT - Y) / ATLAS_HEIGHT : (region.y + Y) / ATLAS_HEIGHT;
    const V_HEIGHT = (BOTTOM_UP ? -HEIGHT : HEIGHT) / ATLAS_HEIGHT;
    FRAME_RECTS.push(
      Object.freeze({
        localRect: Float32Array.of(LEFT, TOP, WIDTH, HEIGHT),
        uvRect: Float32Array.of(U0, V0, WIDTH / ATLAS_WIDTH, V_HEIGHT)
      })
    );
    FRAMES.push(
      Object.freeze({
        index,
        x: X,
        y: Y,
        width: WIDTH,
        height: HEIGHT,
        sourceX: SOURCE_X,
        sourceY: SOURCE_Y,
        sourceWidth: SOURCE_WIDTH,
        sourceHeight: SOURCE_HEIGHT,
        pivotX: PIVOT_X,
        pivotY: PIVOT_Y,
        gutter: GUTTER,
        durationMs: DURATION_MS
      })
    );
  }
  const CLIPS = /* @__PURE__ */ new Map();
  for (const [NAME, INPUT] of Object.entries(INPUT_CLIPS)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(NAME) || !INPUT || typeof INPUT !== "object") {
      throw new TypeError("Valid named sprite clips are required");
    }
    if (!Array.isArray(INPUT.frames) || !INPUT.frames.length || INPUT.frames.length > 4096) {
      throw new RangeError("A sprite clip must reference 1..4096 frames");
    }
    const LOOP = INPUT.loop ?? "loop";
    if (LOOP !== "loop" && LOOP !== "once") {
      throw new TypeError("Sprite clip loop must be loop or once");
    }
    let durationMs = 0;
    const ENDS = [];
    for (const INDEX of INPUT.frames) {
      INTEGER(INDEX, "clip frame index");
      if (INDEX >= FRAMES.length) {
        throw new RangeError("Clip frame index exceeds atlas frame count");
      }
      durationMs += FRAMES[INDEX].durationMs;
      if (!Number.isFinite(durationMs) || durationMs > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Sprite clip duration exceeds safe milliseconds");
      }
      ENDS.push(durationMs);
    }
    CLIPS.set(
      NAME,
      Object.freeze({
        name: NAME,
        frames: Object.freeze([...INPUT.frames]),
        ends: Object.freeze(ENDS),
        loop: LOOP,
        durationMs
      })
    );
  }
  if (!CLIPS.size) {
    throw new TypeError("At least one sprite clip is required");
  }
  const PLAYERS = /* @__PURE__ */ new Set();
  let disposed = false;
  const READY = () => {
    if (disposed) {
      throw new Error("Sprite animation disposed");
    }
  };
  const GET_CLIP = (name) => {
    const CLIP = CLIPS.get(name);
    if (!CLIP) {
      throw new TypeError("Known sprite clip required");
    }
    return CLIP;
  };
  const CLOCK = (value) => {
    if (!Number.isFinite(value)) {
      throw new TypeError("Finite absolute timeMs required");
    }
  };
  return Object.freeze({
    createPlayer({ clip = CLIPS.keys().next().value, startedAtMs = 0, rate = 1 } = {}) {
      READY();
      CLOCK(startedAtMs);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1e3) {
        throw new RangeError("Sprite playback rate must be in (0,1000]");
      }
      let selectedClip = GET_CLIP(clip);
      let anchorMs = startedAtMs;
      let offsetMs = 0;
      let playbackRate = rate;
      let paused = false;
      let playerDisposed = false;
      const PLAYER_READY = () => {
        READY();
        if (playerDisposed) {
          throw new Error("Sprite player disposed");
        }
      };
      const ELAPSED = (timeMs) => {
        PLAYER_READY();
        CLOCK(timeMs);
        const VALUE = Math.max(0, offsetMs + (paused ? 0 : (timeMs - anchorMs) * playbackRate));
        if (!Number.isFinite(VALUE)) {
          throw new RangeError("Sprite elapsed time exceeds finite milliseconds");
        }
        return VALUE;
      };
      const PLAYER = Object.freeze({
        sample(timeMs) {
          const ELAPSED_MS = ELAPSED(timeMs);
          const TIME = selectedClip.loop === "loop" ? ELAPSED_MS % selectedClip.durationMs : Math.min(ELAPSED_MS, selectedClip.durationMs);
          let slot = 0;
          while (slot < selectedClip.ends.length - 1 && TIME >= selectedClip.ends[slot]) {
            slot++;
          }
          const FRAME_INDEX = selectedClip.frames[slot];
          return Object.freeze({
            clip: selectedClip.name,
            frameIndex: FRAME_INDEX,
            frame: FRAMES[FRAME_INDEX],
            elapsedMs: ELAPSED_MS,
            finished: selectedClip.loop === "once" && ELAPSED_MS >= selectedClip.durationMs
          });
        },
        /** options: matrix (composed with the context transform), color, alpha, whiteFlash, forceColor. */
        draw({ timeMs, ...options } = {}) {
          const SAMPLE = this.sample(timeMs);
          PLAYER_READY();
          context.drawQuads({
            ...options,
            uvRects: FRAME_RECTS[SAMPLE.frameIndex].uvRect,
            localRects: FRAME_RECTS[SAMPLE.frameIndex].localRect,
            layer: region.layer,
            filter: region.filter
          });
          return SAMPLE;
        },
        seek(elapsedMs, timeMs) {
          PLAYER_READY();
          CLOCK(elapsedMs);
          CLOCK(timeMs);
          if (elapsedMs < 0) {
            throw new RangeError("Sprite seek elapsedMs must be nonnegative");
          }
          offsetMs = elapsedMs;
          anchorMs = timeMs;
          return this;
        },
        setPaused(value, timeMs) {
          PLAYER_READY();
          if (typeof value !== "boolean") {
            throw new TypeError("Sprite paused state must be boolean");
          }
          const CURRENT = ELAPSED(timeMs);
          offsetMs = CURRENT;
          anchorMs = timeMs;
          paused = value;
          return this;
        },
        setRate(value, timeMs) {
          PLAYER_READY();
          if (!Number.isFinite(value) || value <= 0 || value > 1e3) {
            throw new RangeError("Sprite playback rate must be in (0,1000]");
          }
          const CURRENT = ELAPSED(timeMs);
          offsetMs = CURRENT;
          anchorMs = timeMs;
          playbackRate = value;
          return this;
        },
        setClip(name, timeMs) {
          PLAYER_READY();
          CLOCK(timeMs);
          selectedClip = GET_CLIP(name);
          offsetMs = 0;
          anchorMs = timeMs;
          return this;
        },
        dispose() {
          if (playerDisposed) {
            return false;
          }
          playerDisposed = true;
          PLAYERS.delete(PLAYER);
          return true;
        }
      });
      PLAYERS.add(PLAYER);
      return PLAYER;
    },
    stats() {
      return Object.freeze({
        frameCount: FRAMES.length,
        clipCount: CLIPS.size,
        playerCount: PLAYERS.size,
        retainedBytes: 0,
        textureOwned: false
      });
    },
    dispose() {
      if (disposed) {
        return false;
      }
      disposed = true;
      PLAYERS.clear();
      return true;
    }
  });
}

// modules/rendering/yarn-geometry.js
var STRIDE_FLOATS = 9;
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
function appendSurfaceVertices(vertices, materials, surface, surfaceIndex, style, partIndex) {
  const YARN = style.kind === "yarn";
  for (let record = 0; record < surface.fillCount + surface.edgeCount; record++) {
    const AT = record * STRIDE_FLOATS, EDGE = record >= surface.edgeFirst;
    vertices.push(
      surface.vertices[AT],
      surface.vertices[AT + 1],
      surface.vertices[AT + 2],
      surface.vertices[AT + 3],
      surface.vertices[AT + 4],
      surface.vertices[AT + 5],
      0,
      0,
      0,
      0,
      partIndex
    );
    materials.push(
      EDGE ? YARN ? MATERIAL_KIND.yarnEdge : MATERIAL_KIND.sketchEdge : YARN ? MATERIAL_KIND.yarnFill : MATERIAL_KIND.sketchFill,
      surfaceIndex,
      EDGE ? surface.vertices[AT + 7] : 0,
      EDGE ? surface.vertices[AT + 8] : 0
    );
  }
}
function buildYarnSurfaceMesh(surfaces) {
  const LIST = Array.isArray(surfaces) ? surfaces : [surfaces];
  if (!LIST.length || LIST.length > MAX_MATERIAL_SURFACES) {
    throw new RangeError("A mesh holds 1.." + MAX_MATERIAL_SURFACES + " surfaces");
  }
  const VERTICES = [], MATERIALS = [], TABLE = [];
  let partCount = 1;
  LIST.forEach(({ fillVertices, outline, edgeColors, style, partIndex = 0 }, index) => {
    validateStyle(style);
    const SURFACE = surfaceGeometry(fillVertices, outline, edgeColors, style);
    TABLE.push(...materialRecord(style, SURFACE.bounds, SURFACE.contourLength));
    appendSurfaceVertices(VERTICES, MATERIALS, SURFACE, index, style, partIndex);
    partCount = Math.max(partCount, partIndex + 1);
  });
  return {
    vertices: Float32Array.from(VERTICES),
    strideFloats: 11,
    partCount,
    morphCount: 0,
    materials: {
      vertices: Float32Array.from(MATERIALS),
      table: Float32Array.from(TABLE)
    }
  };
}
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
    if (!device?.textureAtlas) {
      throw new TypeError("device must provide a WebGLDevice texture atlas");
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
    this.region = device.textureAtlas.allocate(width, height, { filter });
    try {
      device.textureAtlas.upload(this.region, { width, height, data }, { extendEdges: true });
    } catch (error) {
      device.textureAtlas.release(this.region);
      throw error;
    }
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
   * Emits one callback per visible glyph. The callback receives region (atlas array layer), atlas
   * UVs, destination rectangle, RGBA color, and operation='fill'.
   * Also accepts `(renderer, text, x, y, options)` when renderer provides
   * `drawGlyphQuad(region, x, y, width, height, uv, color)`.
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
    const [RU, RV, RW, RH] = this.region.uvRect;
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
            region: this.region,
            glyph: GLYPH,
            codePoint: GLYPH.codePoint,
            x: LEFT + OX * lineWidth,
            y: TOP + OY * lineWidth,
            width: GLYPH.width * SCALE,
            height: GLYPH.height * SCALE,
            u0: RU + GLYPH.x / this.width * RW,
            v0: RV + GLYPH.y / this.height * RH,
            u1: RU + (GLYPH.x + GLYPH.width) / this.width * RW,
            v1: RV + (GLYPH.y + GLYPH.height) / this.height * RH,
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
    if (this.device.state === "ready") {
      this.region.atlas.release(this.region);
    }
    this.region = null;
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
        glyph.region,
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
export {
  FontAssetLoader,
  GlyphAtlas,
  MeshBuilder,
  MeshRenderer,
  PrimitivePainter,
  TextureAtlasArray,
  VectorContext,
  VectorRenderer,
  WebGLDevice,
  buildYarnSurfaceGeometry,
  buildYarnSurfaceMesh,
  createSpriteAnimation
};

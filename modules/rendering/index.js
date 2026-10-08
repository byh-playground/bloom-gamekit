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
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function positive(value, name) {
  finite(value, name); if (value <= 0) throw new RangeError(`${name} must be positive`);
}
function color(value) {
  if (!value || value.length !== 4) throw new TypeError('color must be [r,g,b,a]');
  for (let i = 0; i < 4; i++) if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) throw new RangeError('color channels must be in [0,1]');
}
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`WebGL shader: ${message}`);
  }
  return shader;
}

/**
 * Painter-order quads/triangles, one reusable vertex buffer. No implicit loop/sorting.
 * Owns the canvas WebGL context exclusively. All public numbers use CSS/world units,
 * angles use radians, RGBA colors are straight-alpha normalized numbers.
 */
export class Renderer2D {
  constructor(canvas, { batchVertices = 6144, antialias = true, preserveDrawingBuffer = false } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError('canvas is required');
    if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1_048_576) throw new RangeError('batchVertices must be 6..1048576');
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias, depth: false, stencil: false, preserveDrawingBuffer });
    if (!this.gl) throw new Error('WebGL 1 is required; no Canvas2D fallback');
    this.state = 'ready'; this.failure = null; this.active = false;
    this.vertices = new Float32Array(batchVertices * 8); this.vertexCount = 0;
    this.projection = new Float32Array(9); this.textures = new Map();
    this.width = canvas.width || 1; this.height = canvas.height || 1; this.dpr = 1;
    this.camera = { x: this.width / 2, y: this.height / 2, zoom: 1, rotation: 0 };
    this.stats = { backend: 'webgl1', frame: 0, drawCalls: 0, vertices: 0, uploadedBytes: 0, bufferViews: 0,
      textureUploads: 0, totalTextureUploads: 0, textureCount: 0, stagingBytes: this.vertices.byteLength, bufferAllocations: 0 };
    this.onLost = event => { event.preventDefault(); this.state = 'lost'; this.active = false; this.vertexCount = 0; this.batchTexture = null; };
    this.onRestored = () => {
      if (this.state === 'disposed') return;
      try { this._initialize(); this.state = 'ready'; this.failure = null; }
      catch (error) { this.state = 'failed'; this.failure = error.message; this._deleteGPU(); }
    };
    try { this._initialize(); }
    catch (error) { this._deleteGPU(); this.state = 'failed'; throw error; }
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }
  _ready() { if (this.state !== 'ready') throw new Error(`Renderer is ${this.state}${this.failure ? `: ${this.failure}` : ''}`); }
  _frame() { this._ready(); if (!this.active) throw new Error('beginFrame is required'); }
  _initialize() {
    const gl = this.gl;
    let vertex, fragment;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, VERTEX); fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      this.program = gl.createProgram(); if (!this.program) throw new Error('WebGL program allocation failed');
      gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`WebGL link: ${gl.getProgramInfoLog(this.program)}`);
    } finally { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
    this.buffer = gl.createBuffer(); if (!this.buffer) throw new Error('WebGL buffer allocation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    this.stats.bufferAllocations++;
    gl.useProgram(this.program);
    for (const [name, size, offset] of [['a_position', 2, 0], ['a_uv', 2, 8], ['a_color', 4, 16]]) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    this.uProjection = gl.getUniformLocation(this.program, 'u_projection');
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_texture'), 0);
    gl.activeTexture(gl.TEXTURE0); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.DITHER);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.white = { width: 1, height: 1, source: new Uint8Array([255, 255, 255, 255]), filter: 'nearest', texture: null };
    this._upload(this.white);
    for (const record of this.textures.values()) { record.texture = null; this._upload(record); }
    this.batchTexture = null; this.vertexCount = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); this._projection();
  }
  _projection() {
    const { x, y, zoom, rotation } = this.camera;
    const c = Math.cos(rotation) * zoom, s = Math.sin(rotation) * zoom;
    const m = this.projection, w = this.width, h = this.height;
    m[0] = 2 * c / w; m[1] = 2 * s / h; m[2] = 0;
    m[3] = 2 * s / w; m[4] = -2 * c / h; m[5] = 0;
    m[6] = -2 * (c * x + s * y) / w; m[7] = 2 * (c * y - s * x) / h; m[8] = 1;
    this.gl.uniformMatrix3fv(this.uProjection, false, m);
  }
  /** CSS viewport dimensions; does not change CSS style. Game controls camera separately. */
  resize(width, height, dpr = 1) {
    this._ready(); positive(width, 'width'); positive(height, 'height'); positive(dpr, 'dpr');
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    const limit = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    if (pixelWidth > limit[0] || pixelHeight > limit[1]) throw new RangeError('viewport exceeds WebGL limits');
    if (this.active) throw new Error('resize must be outside beginFrame/endFrame');
    this.width = width; this.height = height; this.dpr = dpr;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight); this._projection();
  }
  /** Camera center in world units; zoom is CSS pixels per world unit. */
  setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
    this._ready(); finite(x, 'x'); finite(y, 'y'); positive(zoom, 'zoom'); finite(rotation, 'rotation');
    if (this.active) this.flush();
    this.camera.x = x; this.camera.y = y; this.camera.zoom = zoom; this.camera.rotation = rotation; this._projection();
  }
  /** Caller-owned output; no world/simulation state is read or changed. */
  worldToScreenInto(x, y, out) {
    finite(x, 'x'); finite(y, 'y'); const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = x - camera.x, dy = y - camera.y;
    out.x = (c * dx + s * dy) * camera.zoom + this.width / 2;
    out.y = (-s * dx + c * dy) * camera.zoom + this.height / 2; return out;
  }
  screenToWorldInto(x, y, out) {
    finite(x, 'x'); finite(y, 'y'); const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = (x - this.width / 2) / camera.zoom, dy = (y - this.height / 2) / camera.zoom;
    out.x = c * dx - s * dy + camera.x; out.y = s * dx + c * dy + camera.y; return out;
  }
  _source(source, filter) {
    if (filter !== 'nearest' && filter !== 'linear') throw new RangeError('filter must be nearest or linear');
    if (Object.prototype.toString.call(source) === '[object ImageBitmap]') throw new TypeError('ImageBitmap alpha mode cannot be inspected; use an image/canvas or RGBA bytes');
    const width = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
    const height = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > max || height > max) throw new RangeError('texture dimensions are invalid');
    let retained = source;
    if (source.data !== undefined) {
      if (!(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) || source.data.length !== width * height * 4) throw new TypeError('texture data must be width*height*4 RGBA bytes');
      retained = new Uint8Array(source.data); // owns premultiplied restoration pixels
      for (let i = 0; i < retained.length; i += 4) {
        const a = retained[i + 3] / 255;
        retained[i] = Math.round(retained[i] * a); retained[i + 1] = Math.round(retained[i + 1] * a); retained[i + 2] = Math.round(retained[i + 2] * a);
      }
    }
    return { width, height, source: retained, filter, texture: null };
  }
  _upload(record) {
    const gl = this.gl; const texture = gl.createTexture(); if (!texture) throw new Error('WebGL texture allocation failed');
    record.texture = texture;
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(record.source instanceof Uint8Array));
      if (record.source instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, record.width, record.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      const filter = record.filter === 'linear' ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error(`WebGL texture upload error ${error}`);
      this.stats.textureUploads++; this.stats.totalTextureUploads++;
    } catch (error) { gl.deleteTexture(texture); record.texture = null; throw error; }
  }
  /** Loaded origin-clean image/canvas, or {width,height,data: RGBA bytes}. */
  createTexture(source, { filter = 'linear' } = {}) {
    this._ready(); const record = this._source(source, filter); if (this.active) this.flush(); this._upload(record);
    const handle = Object.freeze({ width: record.width, height: record.height });
    this.textures.set(handle, record); this.stats.textureCount = this.textures.size; return handle;
  }
  /** Replacement dimensions must match the handle. Upload is explicit, never per sprite. */
  updateTexture(handle, source) {
    this._ready(); const previous = this.textures.get(handle); if (!previous) throw new Error('unknown/deleted texture');
    const record = this._source(source, previous.filter);
    if (record.width !== handle.width || record.height !== handle.height) throw new RangeError('texture update dimensions must match');
    if (this.active) this.flush(); this._upload(record); this.gl.deleteTexture(previous.texture); this.textures.set(handle, record);
  }
  deleteTexture(handle) {
    if (this.state === 'disposed') return false;
    const record = this.textures.get(handle); if (!record) return false;
    if (this.active) this.flush(); this.gl.deleteTexture(record.texture); this.textures.delete(handle); this.stats.textureCount = this.textures.size; return true;
  }
  /** Returns false while context is lost. Caller skips that frame; restore is automatic. */
  beginFrame(clear = CLEAR) {
    if (this.state === 'lost') return false;
    this._ready(); if (this.active) throw new Error('endFrame is required'); color(clear);
    this.active = true; this.vertexCount = 0; this.batchTexture = null;
    const stats = this.stats; stats.frame++; stats.drawCalls = stats.vertices = stats.uploadedBytes = stats.bufferViews = stats.textureUploads = 0;
    const gl = this.gl; gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]); gl.clear(gl.COLOR_BUFFER_BIT); return true;
  }
  _reserve(count, texture) {
    this._frame();
    if (this.batchTexture !== texture || this.vertexCount + count > this.vertices.length / 8) this.flush();
    this.batchTexture = texture;
  }
  _vertex(x, y, u, v, tint) {
    const data = this.vertices; let i = this.vertexCount++ * 8;
    data[i++] = x; data[i++] = y; data[i++] = u; data[i++] = v;
    data[i++] = tint[0]; data[i++] = tint[1]; data[i++] = tint[2]; data[i] = tint[3];
  }
  triangle(x0, y0, x1, y1, x2, y2, tint = WHITE) {
    finite(x0, 'x0'); finite(y0, 'y0'); finite(x1, 'x1'); finite(y1, 'y1'); finite(x2, 'x2'); finite(y2, 'y2'); color(tint);
    this._reserve(3, this.white.texture); this._vertex(x0, y0, 0, 0, tint); this._vertex(x1, y1, 0, 0, tint); this._vertex(x2, y2, 0, 0, tint);
  }
  _quad(texture, x, y, width, height, angle, tint, u0, v0, u1, v1) {
    finite(x, 'x'); finite(y, 'y'); positive(width, 'width'); positive(height, 'height'); finite(angle, 'angle'); color(tint);
    this._reserve(6, texture);
    const c = Math.cos(angle), s = Math.sin(angle), hx = width / 2, hy = height / 2;
    const ax = x - c * hx + s * hy, ay = y - s * hx - c * hy;
    const bx = x + c * hx + s * hy, by = y + s * hx - c * hy;
    const cx = x + c * hx - s * hy, cy = y + s * hx + c * hy;
    const dx = x - c * hx - s * hy, dy = y - s * hx + c * hy;
    this._vertex(ax, ay, u0, v0, tint); this._vertex(bx, by, u1, v0, tint); this._vertex(cx, cy, u1, v1, tint);
    this._vertex(ax, ay, u0, v0, tint); this._vertex(cx, cy, u1, v1, tint); this._vertex(dx, dy, u0, v1, tint);
  }
  /** Center-anchored rectangle, positive size, clockwise rotation in y-down world. */
  rect(x, y, width, height, tint = WHITE, angle = 0) { this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1); }
  /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
  sprite(texture, x, y, width = texture.width, height = texture.height, { angle = 0, tint = WHITE, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {}) {
    const record = this.textures.get(texture); if (!record) throw new Error('unknown/deleted texture');
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1) || Math.min(u0, v0, u1, v1) < 0 || Math.max(u0, v0, u1, v1) > 1) throw new RangeError('UV must be in [0,1]');
    this._quad(record.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
  }
  /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
  ellipse(x, y, radiusX, radiusY, tint = WHITE, segments = 24) {
    finite(x, 'x'); finite(y, 'y'); positive(radiusX, 'radiusX'); positive(radiusY, 'radiusY'); color(tint);
    if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) throw new RangeError('segments must be 3..256');
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
      this._reserve(3, this.white.texture); this._vertex(x, y, 0, 0, tint);
      this._vertex(x + Math.cos(a) * radiusX, y + Math.sin(a) * radiusY, 0, 0, tint);
      this._vertex(x + Math.cos(b) * radiusX, y + Math.sin(b) * radiusY, 0, 0, tint);
    }
  }
  line(x0, y0, x1, y1, width, tint = WHITE) {
    finite(x0, 'x0'); finite(y0, 'y0'); finite(x1, 'x1'); finite(y1, 'y1'); positive(width, 'width'); color(tint); this._frame();
    const length = Math.hypot(x1 - x0, y1 - y0); if (!length) return;
    this.rect((x0 + x1) / 2, (y0 + y1) / 2, length, width, tint, Math.atan2(y1 - y0, x1 - x0));
  }
  flush() {
    this._frame(); if (!this.vertexCount) return;
    const gl = this.gl, view = this.vertices.subarray(0, this.vertexCount * 8);
    gl.bindTexture(gl.TEXTURE_2D, this.batchTexture); gl.bufferSubData(gl.ARRAY_BUFFER, 0, view); gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    this.stats.drawCalls++; this.stats.vertices += this.vertexCount; this.stats.uploadedBytes += view.byteLength; this.stats.bufferViews++; this.vertexCount = 0;
  }
  /** Stats is a reused object, valid until next frame; CPU submission, not GPU timing. */
  endFrame() { this.flush(); this.active = false; this.batchTexture = null; return this.stats; }
  _deleteGPU() {
    const gl = this.gl;
    // Bound programs otherwise remain delete-pending until another program is used.
    gl.useProgram(null); gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null);
    for (const record of this.textures.values()) if (record.texture) gl.deleteTexture(record.texture);
    if (this.white?.texture) gl.deleteTexture(this.white.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer); if (this.program) gl.deleteProgram(this.program);
  }
  /** Idempotent. Removes context listeners and releases retained sources/GPU resources. */
  dispose() {
    if (this.state === 'disposed') return;
    this.canvas.removeEventListener('webglcontextlost', this.onLost); this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this._deleteGPU(); this.textures.clear(); this.white = null; this.buffer = this.program = null; this.stats.textureCount = 0;
    this.active = false; this.vertexCount = 0; this.state = 'disposed';
  }
}

export { WebGLDevice } from "./device.js";
export { VectorRenderer } from "./vector-renderer.js";
export { GlyphAtlas } from "./glyph-atlas.js";
export { FontAssetLoader } from "./font-assets.js";

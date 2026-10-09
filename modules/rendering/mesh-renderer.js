const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const WHITE = Object.freeze([1, 1, 1, 1]);
const ATTRIBUTES = [
  { name: 'a_position', size: 2, offset: 0 }, { name: 'a_color', size: 4, offset: 8 },
  { name: 'a_morph', size: 4, offset: 24 }, { name: 'a_part', size: 1, offset: 40 }
];
const INSTANCE_ATTRIBUTES = ['i_row0', 'i_row1', 'i_color', 'i_params'].map((name, i) => ({ name, size: 4, offset: i * 16, source: 'instance' }));
function shader(instanced) {
  const inputs = ['i_row0', 'i_row1', 'i_color', 'i_params'].map(name => `${instanced ? 'attribute' : 'uniform'} vec4 ${name};`).join('\n');
  return `attribute vec2 a_position; attribute vec4 a_color; attribute vec4 a_morph; attribute float a_part;
${inputs}
uniform mat3 u_projection; uniform vec4 u_parts[48]; varying vec4 v_color; varying vec2 v_position;
void main(){int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];
vec2 local=a_position+a_morph.xy*(i_params.x+pose.x)+a_morph.zw*(i_params.y+pose.y);
vec2 p=vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)));
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);gl_Position=vec4(projected.xy,0.0,1.0);v_position=world;
vec4 color=mix(a_color*i_color,i_color,i_row1.w);color.a*=i_row0.w*pose.z;
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);}`;
}
function fragment(maxPlanes) {
  return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i<u_planeCount&&dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}gl_FragColor=v_color;}`;
}
function finiteArray(value, size, name) {
  if (!value || value.length !== size || Array.from(value).some(n => !Number.isFinite(n))) throw new TypeError(`${name}: ${size} finite numbers required`);
}
function packParts(parts, count, output) {
  if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) throw new TypeError('One pose per authored mesh part required');
  for (let i = 0; i < count; i++) {
    const part = parts?.[i], m = part?.transform ?? IDENTITY, morph = part?.morph ?? [0, 0];
    finiteArray(m, 6, 'part transform'); finiteArray(morph, 2, 'part morph');
    const at = i * 12;
    output[at] = m[0]; output[at+1] = m[2]; output[at+2] = m[4]; output[at+3] = 0;
    output[at+4] = m[1]; output[at+5] = m[3]; output[at+6] = m[5]; output[at+7] = 0;
    output[at+8] = morph[0]; output[at+9] = morph[1]; output[at+10] = part?.visible === false ? 0 : 1; output[at+11] = 0;
  }
}
function clipState(clips, maxPlanes) {
  if (!clips?.length) return { key: '', values: null, count: 0 };
  const values = [], key = [];
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) throw new TypeError('Finite convex clip polygons required');
    let area = 0;
    for (let i = 0; i < polygon.length; i++) { const p = polygon[i], q = polygon[(i + 1) % polygon.length]; area += p.x * q.y - q.x * p.y; }
    if (Math.abs(area) < 1e-12) return { key: 'empty', values: [0, 0, -1], count: 1 };
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length], dx = q.x - p.x, dy = q.y - p.y, length = Math.hypot(dx, dy);
      if (!length) continue;
      const a = -dy / length * sign, b = dx / length * sign, c = -(a * p.x + b * p.y);
      values.push(a, b, c); key.push(a, b, c);
    }
  }
  if (values.length / 3 > maxPlanes) throw new RangeError(`Mesh clipping exceeds ${maxPlanes} edge planes`);
  return { key: key.join(','), values, count: values.length / 3 };
}

/** Retained GPU meshes; batches only adjacent equal meshes. No game sorting or animation clock. */
export class MeshRenderer {
  constructor(device, { maxMeshes = 512, maxMeshBytes = 32 * 1024 * 1024, maxInstances = 2048 } = {}) {
    for (const [key, value] of Object.entries({ maxMeshes, maxMeshBytes, maxInstances })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key} must be positive`);
    this.device = device;
    this.maxMeshes = maxMeshes; this.maxMeshBytes = maxMeshBytes; this.maxInstances = maxInstances;
    if (maxInstances * 64 > device.maxBufferBytes) throw new RangeError('Mesh instance buffer exceeds device byte limit');
    this.maxPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
    this.instanced = device.instancingSupported === true;
    const uniforms = { u_projection: 'matrix3fv', 'u_planes[0]': '3fv', u_planeCount: '1i', 'u_parts[0]': '4fv' };
    if (!this.instanced) for (const name of ['i_row0', 'i_row1', 'i_color', 'i_params']) uniforms[name] = '4f';
    this.instances = new Float32Array(maxInstances * 16);
    this.pipeline = device.createPipeline({ vertex: shader(this.instanced), fragment: fragment(this.maxPlanes), stride: 44,
      ...(this.instanced ? { instanceStride: 64 } : {}), attributes: [...ATTRIBUTES, ...(this.instanced ? INSTANCE_ATTRIBUTES : [])], uniforms });
    try { this.instanceBuffer = this.instanced ? device.createVertexBuffer({ capacityBytes: this.instances.byteLength }) : null; }
    catch (error) { device.deletePipeline(this.pipeline); throw error; }
    this.meshes = new Set(); this.bytes = 0; this.count = 0; this.pending = null;
    this.planes = new Float32Array(this.maxPlanes * 3);
    this.partScratch = new Float32Array(16 * 12);
    this.metrics = { draws: 0, instances: 0, geometryUploads: 0, geometryBytesUploaded: 0, instanceBytesUploaded: 0 };
    this.state = 'ready'; this.failure = null;
    this.onLost = () => { this.discard(); this.state = 'lost'; };
    this.onRestored = () => {
      try {
        if (this.instanced && !device.instancingSupported) throw new Error('Restored context no longer supports mesh instancing');
        for (const mesh of this.meshes) device.uploadVertices(mesh.buffer, mesh.vertices);
        this.state = 'ready'; this.failure = null;
      } catch (error) { this.state = 'failed'; this.failure = error.message; }
    };
    device.canvas.addEventListener('webglcontextlost', this.onLost);
    device.canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.disposed = false;
  }
  createMesh(data) {
    this._ready();
    if (!(data?.vertices instanceof Float32Array) || data.vertices.length % 33 || data.strideFloats !== 11 || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > 16) throw new TypeError('MeshBuilder geometry with 1..16 parts required');
    if (data.vertices.some(n => !Number.isFinite(n))) throw new TypeError('Mesh values must be finite');
    for (let i = 0; i < data.vertices.length; i++) {
      if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) throw new RangeError('Mesh RGBA channels must be in [0,1]');
      if (i % 11 === 10 && (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)) throw new RangeError('Mesh part index outside partCount');
    }
    if (this.meshes.size >= this.maxMeshes || this.bytes + data.vertices.byteLength > this.maxMeshBytes) throw new RangeError('Retained mesh budget exceeded');
    const vertices = data.vertices.slice(), buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    try { this.device.uploadVertices(buffer, vertices); } catch (error) { this.device.deleteVertexBuffer(buffer); throw error; }
    const mesh = Object.freeze({ renderer: this, buffer, vertices, count: vertices.length / 11, byteLength: vertices.byteLength, partCount: data.partCount });
    this.meshes.add(mesh); this.bytes += vertices.byteLength;
    this.metrics.geometryUploads++; this.metrics.geometryBytesUploaded += vertices.byteLength;
    return mesh;
  }
  deleteMesh(mesh) {
    if (!this.meshes.has(mesh)) return false;
    if (this.pending?.mesh === mesh) this.flush();
    this.device.deleteVertexBuffer(mesh.buffer); this.meshes.delete(mesh); this.bytes -= mesh.byteLength;
    return true;
  }
  /** Captures state by value; subsequent transform/paint changes do not alter queued instances. */
  drawMesh(mesh, { matrix = IDENTITY, projection, morph = [0, 0], parts = null, color = WHITE, forceColor = false, alpha = 1, whiteFlash = false, clips = [] } = {}) {
    this._ready();
    if (!this.meshes.has(mesh)) throw new TypeError('Mesh owned by this renderer required');
    if (!this.device.active) throw new Error('beginFrame required');
    finiteArray(matrix, 6, 'matrix'); finiteArray(projection, 9, 'projection'); finiteArray(morph, 2, 'morph'); finiteArray(color, 4, 'color');
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some(n => n < 0 || n > 1)) throw new RangeError('RGBA/alpha in [0,1] required');
    const clip = clipState(clips, this.maxPlanes), pending = this.pending;
    packParts(parts, mesh.partCount, this.partScratch);
    if (pending && (pending.mesh !== mesh || pending.clip.key !== clip.key || projection.some((n, i) => n !== pending.projection[i]) || pending.parts.some((n, i) => n !== this.partScratch[i]) || this.count === this.maxInstances)) this.flush();
    if (!this.pending) this.pending = { mesh, projection: Float32Array.from(projection), clip, parts: this.partScratch.slice(0, mesh.partCount * 12) };
    const at = this.count++ * 16;
    this.instances.set([matrix[0], matrix[2], matrix[4], alpha, matrix[1], matrix[3], matrix[5], forceColor ? 1 : 0,
      ...color, morph[0], morph[1], whiteFlash ? 1 : 0, 0], at);
  }
  flush() {
    if (!this.count) return;
    this._ready();
    const { mesh, projection, clip, parts } = this.pending;
    this.planes.fill(0); if (clip.values) this.planes.set(clip.values);
    const uniforms = { u_projection: projection, 'u_planes[0]': this.planes, u_planeCount: clip.count, 'u_parts[0]': parts };
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, this.count * 16));
      this.device.draw({ pipeline: this.pipeline, buffer: mesh.buffer, count: mesh.count, instanceBuffer: this.instanceBuffer, instances: this.count, uniforms });
      this.metrics.instanceBytesUploaded += this.count * 64; this.metrics.draws++;
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < 4; j++) uniforms[['i_row0', 'i_row1', 'i_color', 'i_params'][j]] = this.instances.subarray(i * 16 + j * 4, i * 16 + j * 4 + 4);
        this.device.draw({ pipeline: this.pipeline, buffer: mesh.buffer, count: mesh.count, uniforms }); this.metrics.draws++;
      }
    }
    this.metrics.instances += this.count; this.discard();
  }
  discard() { this.count = 0; this.pending = null; }
  _ready() { if (this.state !== 'ready' || this.disposed) throw new Error(`MeshRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`); }
  beginFrame() { this.discard(); for (const key of Object.keys(this.metrics)) this.metrics[key] = 0; }
  stats() { return { ...this.metrics, state: this.state, failure: this.failure, meshCount: this.meshes.size, retainedBytes: this.bytes, stagingBytes: this.instances.byteLength, instanced: this.instanced, maxClipPlanes: this.maxPlanes }; }
  dispose() {
    if (this.disposed) return;
    this.discard(); this.device.canvas.removeEventListener('webglcontextlost', this.onLost); this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const mesh of this.meshes) this.device.deleteVertexBuffer(mesh.buffer);
    this.meshes.clear(); this.bytes = 0;
    if (this.instanceBuffer) this.device.deleteVertexBuffer(this.instanceBuffer);
    this.device.deletePipeline(this.pipeline); this.disposed = true; this.state = 'disposed';
  }
}

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const ZERO_MORPH = Object.freeze([0, 0]);
const EMPTY_CLIP = Object.freeze({ key: '', values: null, count: 0 });
const WHITE = Object.freeze([1, 1, 1, 1]);
const ATTRIBUTES = [
  { name: 'a_position', size: 2, offset: 0 }, { name: 'a_color', size: 4, offset: 8 },
  { name: 'a_morph', size: 4, offset: 24 }, { name: 'a_part', size: 1, offset: 40 }
];
const INSTANCE_ATTRIBUTES = ['i_row0', 'i_row1', 'i_color', 'i_params'].map((name, i) => ({ name, size: 4, offset: i * 16, source: 'instance' }));
function shader(instanced, partCount, morphCount, clipped) {
  const inputs = ['i_row0', 'i_row1', 'i_color', 'i_params'].map(name => `${instanced ? 'attribute' : 'uniform'} vec4 ${name};`).join('\n');
  const local = morphCount ? 'a_position+a_morph.xy*(i_params.x'+(partCount > 1 ? '+pose.x' : '')+')'+(morphCount > 1 ? '+a_morph.zw*(i_params.y'+(partCount > 1 ? '+pose.y' : '')+')' : '') : 'a_position';
  return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? 'attribute vec4 a_morph;' : ''} ${partCount > 1 ? 'attribute float a_part;uniform vec4 u_parts[' + partCount*3 + '];' : ''}
${inputs}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}
void main(){${partCount > 1 ? 'int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];' : ''}
vec2 local=${local};vec2 p=${partCount > 1 ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);gl_Position=vec4(projected.xy,0.0,1.0);${clipped ? 'v_position=world;' : ''}
vec4 color=mix(a_color*i_color,i_color,i_row1.w);color.a*=i_row0.w${partCount > 1 ? '*pose.z' : ''};
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);}`;
}
function fragment(maxPlanes, clipped) {
  if (!clipped) return 'precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}';
  return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}gl_FragColor=v_color;}`;
}
function finiteArray(value, size, name) {
  if (!value || value.length !== size) throw new TypeError(`${name}: ${size} finite numbers required`);
  for (let i = 0; i < size; i++) if (!Number.isFinite(value[i])) throw new TypeError(`${name}: ${size} finite numbers required`);
}
function packParts(parts, count, output) {
  if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) throw new TypeError('One pose per authored mesh part required');
  for (let i = 0; i < count; i++) {
    const part = parts?.[i], m = part?.transform ?? IDENTITY, morph = part?.morph ?? ZERO_MORPH;
    finiteArray(m, 6, 'part transform'); finiteArray(morph, 2, 'part morph');
    const at = i * 12;
    output[at] = m[0]; output[at+1] = m[2]; output[at+2] = m[4]; output[at+3] = 0;
    output[at+4] = m[1]; output[at+5] = m[3]; output[at+6] = m[5]; output[at+7] = 0;
    output[at+8] = morph[0]; output[at+9] = morph[1]; output[at+10] = part?.visible === false ? 0 : 1; output[at+11] = 0;
  }
}
function clipState(clips, maxPlanes) {
  if (!clips?.length) return EMPTY_CLIP;
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
    this.instances = new Float32Array(maxInstances * 16);
    this.instanceBuffer = this.instanced ? device.createVertexBuffer({ capacityBytes: this.instances.byteLength }) : null;
    this.pipelines = new Map();
    this.meshes = new Set(); this.bytes = 0; this.count = 0; this.pending = null;
    this.planes = new Float32Array(this.maxPlanes * 3);
    this.partScratch = new Float32Array(16 * 12);
    this.metrics = { draws: 0, instances: 0, geometryUploads: 0, geometryBytesUploaded: 0, instanceBytesUploaded: 0, partUniformBytesSubmitted: 0 };
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
  _pipeline(mesh, clipped) {
    const key = mesh.partCount + ':' + mesh.morphCount + ':' + Number(clipped);
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const uniforms = { u_projection: 'matrix3fv' };
    if (clipped) Object.assign(uniforms, { 'u_planes[0]': '3fv', u_planeCount: '1i' });
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = '4fv';
    if (!this.instanced) for (const name of ['i_row0', 'i_row1', 'i_color', 'i_params']) uniforms[name] = '4f';
    pipeline = this.device.createPipeline({ vertex: shader(this.instanced, mesh.partCount, mesh.morphCount, clipped),
      fragment: fragment(this.maxPlanes, clipped), stride: 44,
      ...(this.instanced ? { instanceStride: 64 } : {}),
      attributes: [...ATTRIBUTES, ...(this.instanced ? INSTANCE_ATTRIBUTES : [])], uniforms });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  createMesh(data) {
    this._ready();
    if (!(data?.vertices instanceof Float32Array) || data.vertices.length % 33 || data.strideFloats !== 11 || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > 16 || !Number.isSafeInteger(data.morphCount) || data.morphCount < 0 || data.morphCount > 2) throw new TypeError('MeshBuilder geometry with 1..16 parts required');
    if (data.vertices.some(n => !Number.isFinite(n))) throw new TypeError('Mesh values must be finite');
    for (let i = 0; i < data.vertices.length; i++) {
      if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) throw new RangeError('Mesh RGBA channels must be in [0,1]');
      if (i % 11 === 10 && (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)) throw new RangeError('Mesh part index outside partCount');
      if (i % 11 >= 6 + data.morphCount * 2 && i % 11 < 10 && data.vertices[i] !== 0) throw new RangeError('Mesh deltas exceed declared morphCount');
    }
    if (this.meshes.size >= this.maxMeshes || this.bytes + data.vertices.byteLength > this.maxMeshBytes) throw new RangeError('Retained mesh budget exceeded');
    const vertices = data.vertices.slice(), buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    try { this.device.uploadVertices(buffer, vertices); } catch (error) { this.device.deleteVertexBuffer(buffer); throw error; }
    const mesh = Object.freeze({ renderer: this, buffer, vertices, count: vertices.length / 11, byteLength: vertices.byteLength, partCount: data.partCount, morphCount: data.morphCount });
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
  drawMesh(mesh, options = {}) {
    const { matrix = IDENTITY, projection, morph = [0, 0], parts = null, color = WHITE,
      forceColor = false, alpha = 1, whiteFlash = false, clips = [] } = options;
    this._drawMeshInstances(mesh, { matrices: matrix, count: 1, projection, morph, parts, color, forceColor, alpha, whiteFlash, clips });
  }
  /** Internal ordered instance append used when one retained pose has several transforms. */
  _drawMeshInstances(mesh, { matrices, count, projection, morph = [0, 0], parts = null, color = WHITE,
    forceColor = false, alpha = 1, whiteFlash = false, clips = [], prefixColor = null,
    prefixCount = 0, forceColorPrefixCount = 0 } = {}) {
    this._ready();
    if (!this.meshes.has(mesh)) throw new TypeError('Mesh owned by this renderer required');
    if (!this.device.active) throw new Error('beginFrame required');
    if (!Number.isSafeInteger(count) || count < 1 || !matrices || matrices.length !== count * 6) throw new TypeError('Packed mesh instance matrices required');
    for (let i = 0; i < matrices.length; i++) if (!Number.isFinite(matrices[i])) throw new TypeError('Mesh matrix values must be finite');
    finiteArray(projection, 9, 'projection'); finiteArray(morph, 2, 'morph'); finiteArray(color, 4, 'color');
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some(n => n < 0 || n > 1)) throw new RangeError('RGBA/alpha in [0,1] required');
    if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > count ||
      !Number.isSafeInteger(forceColorPrefixCount) || forceColorPrefixCount < 0 || forceColorPrefixCount > count) throw new RangeError('Instance color prefix count is invalid');
    if (prefixCount && !prefixColor) throw new TypeError('A prefix color is required for colored mesh instances');
    if (prefixColor !== null) {
      finiteArray(prefixColor, 4, 'prefix color');
      if (prefixColor.some(n => n < 0 || n > 1)) throw new RangeError('RGBA channels must be in [0,1]');
    }
    const clip = clipState(clips, this.maxPlanes), pending = this.pending;
    packParts(parts, mesh.partCount, this.partScratch);
    if (pending && (pending.mesh !== mesh || pending.clip.key !== clip.key || projection.some((n, i) => n !== pending.projection[i]) || (mesh.partCount > 1 && pending.parts.some((n, i) => n !== this.partScratch[i])) || this.count === this.maxInstances)) this.flush();
    const part = this.partScratch, singlePart = mesh.partCount === 1;
    for (let i = 0; i < count; i++) {
      if (this.count === this.maxInstances) this.flush();
      if (!this.pending) this.pending = { mesh, projection: Float32Array.from(projection), clip, parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0) };
      const offset = i * 6;
      let m0 = matrices[offset], m1 = matrices[offset + 1], m2 = matrices[offset + 2], m3 = matrices[offset + 3], m4 = matrices[offset + 4], m5 = matrices[offset + 5];
      let weight0 = morph[0], weight1 = morph[1], instanceAlpha = alpha;
      if (singlePart) {
        const a = m0, b = m1, c = m2, d = m3;
        m0 = a * part[0] + c * part[4]; m1 = b * part[0] + d * part[4];
        m2 = a * part[1] + c * part[5]; m3 = b * part[1] + d * part[5];
        m4 = a * part[2] + c * part[6] + m4; m5 = b * part[2] + d * part[6] + m5;
        instanceAlpha *= part[10]; weight0 += part[8]; weight1 += part[9];
      }
      const instanceColor = i < prefixCount ? prefixColor : color;
      const instanceForceColor = i < forceColorPrefixCount ? true : forceColor, at = this.count++ * 16, data = this.instances;
      data[at] = m0; data[at + 1] = m2; data[at + 2] = m4; data[at + 3] = instanceAlpha;
      data[at + 4] = m1; data[at + 5] = m3; data[at + 6] = m5; data[at + 7] = instanceForceColor ? 1 : 0;
      data[at + 8] = instanceColor[0]; data[at + 9] = instanceColor[1];
      data[at + 10] = instanceColor[2]; data[at + 11] = instanceColor[3];
      data[at + 12] = weight0; data[at + 13] = weight1; data[at + 14] = whiteFlash ? 1 : 0; data[at + 15] = 0;
    }
  }
  flush() {
    if (!this.count) return;
    this._ready();
    const { mesh, projection, clip, parts } = this.pending;
    this.planes.fill(0); if (clip.values) this.planes.set(clip.values);
    const pipeline = this._pipeline(mesh, clip.count > 0), uniforms = { u_projection: projection };
    if (clip.count) Object.assign(uniforms, { 'u_planes[0]': this.planes, u_planeCount: clip.count });
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = parts;
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, this.count * 16));
      this.device.draw({ pipeline, buffer: mesh.buffer, count: mesh.count, instanceBuffer: this.instanceBuffer, instances: this.count, uniforms });
      this.metrics.instanceBytesUploaded += this.count * 64; this.metrics.draws++;
      this.metrics.partUniformBytesSubmitted += parts.byteLength;
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < 4; j++) uniforms[['i_row0', 'i_row1', 'i_color', 'i_params'][j]] = this.instances.subarray(i * 16 + j * 4, i * 16 + j * 4 + 4);
        this.device.draw({ pipeline, buffer: mesh.buffer, count: mesh.count, uniforms }); this.metrics.draws++;
        this.metrics.partUniformBytesSubmitted += parts.byteLength;
      }
    }
    this.metrics.instances += this.count; this.discard();
  }
  discard() { this.count = 0; this.pending = null; }
  _ready() { if (this.state !== 'ready' || this.disposed) throw new Error(`MeshRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`); }
  beginFrame() { this.discard(); for (const key of Object.keys(this.metrics)) this.metrics[key] = 0; }
  stats() { return { ...this.metrics, state: this.state, failure: this.failure, pipelineCount: this.pipelines.size, meshCount: this.meshes.size, retainedBytes: this.bytes, stagingBytes: this.instances.byteLength + this.planes.byteLength + this.partScratch.byteLength, instanced: this.instanced, maxClipPlanes: this.maxPlanes }; }
  dispose() {
    if (this.disposed) return;
    this.discard(); this.device.canvas.removeEventListener('webglcontextlost', this.onLost); this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const mesh of this.meshes) this.device.deleteVertexBuffer(mesh.buffer);
    this.meshes.clear(); this.bytes = 0;
    if (this.instanceBuffer) this.device.deleteVertexBuffer(this.instanceBuffer);
    for (const pipeline of this.pipelines.values()) this.device.deletePipeline(pipeline);
    this.pipelines.clear(); this.disposed = true; this.state = 'disposed';
  }
}

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const ZERO_MORPH = Object.freeze([0, 0]);
const EMPTY_CLIP = Object.freeze({ key: '', values: null, count: 0 });
const WHITE = Object.freeze([1, 1, 1, 1]);
const ATTRIBUTES = [
  { name: 'a_position', size: 2, offset: 0 }, { name: 'a_color', size: 4, offset: 8 },
  { name: 'a_morph', size: 4, offset: 24 }, { name: 'a_part', size: 1, offset: 40 }
];
const INSTANCE_ATTRIBUTES = ['i_row0', 'i_row1', 'i_color', 'i_params'].map((name, i) => ({ name, size: 4, offset: i * 16, source: 'instance' }));
function shader(instanced, partCount, morphCount, clipped, nonScalingStroke) {
  const inputs = ['i_row0', 'i_row1', 'i_color', 'i_params'].map(name => `${instanced ? 'attribute' : 'uniform'} vec4 ${name};`).join('\n');
  const local = morphCount ? 'a_position+a_morph.xy*(i_params.x'+(partCount > 1 ? '+pose.x' : '')+')'+(morphCount > 1 ? '+a_morph.zw*(i_params.y'+(partCount > 1 ? '+pose.y' : '')+')' : '') : 'a_position';
  const strokeInputs = nonScalingStroke ? 'attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;' : '';
  const strokeVarying = clipped && nonScalingStroke ? 'uniform mat3 u_inverseProjection;' : '';
  const strokePosition = nonScalingStroke ? `
vec2 tangentLocal=local+a_stroke.xy;
vec2 tangentPart=${partCount > 1 ? 'vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))' : 'tangentLocal'};
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
    ${clipped ? 'vec3 clippedWorld=u_inverseProjection*vec3(projected.xy,projected.z);v_position=clippedWorld.xy/clippedWorld.z;' : ''}
  }
}` : '';
  return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? 'attribute vec4 a_morph;' : ''} ${partCount > 1 ? 'attribute float a_part;uniform vec4 u_parts[' + partCount*3 + '];' : ''}
${inputs}${strokeInputs}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}${strokeVarying}
void main(){${partCount > 1 ? 'int index=int(a_part)*3;vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];' : ''}
vec2 local=${local};vec2 p=${partCount > 1 ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? 'v_position=world;' : ''}${strokePosition}
gl_Position=vec4(projected.xy,(i_params.w+${partCount > 1 ? 'pose.w' : '0.0'})*projected.z,projected.z);
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
function invertProjection(projection) {
  const [a, d, g, b, e, h, c, f, i] = projection;
  const A=e*i-f*h, B=f*g-d*i, C=d*h-e*g, D=c*h-b*i, E=a*i-c*g, F=b*g-a*h, G=b*f-c*e, H=c*d-a*f, I=a*e-b*d;
  const determinant=a*A+b*B+c*C;
  if (!Number.isFinite(determinant) || Math.abs(determinant)<1e-12) throw new RangeError('Non-scaling strokes require an invertible projection');
  return Float32Array.from([A, B, C, D, E, F, G, H, I], value => value / determinant);
}
function packParts(parts, count, output) {
  if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) throw new TypeError('One pose per authored mesh part required');
  for (let i = 0; i < count; i++) {
    const part = parts?.[i], m = part?.transform ?? IDENTITY, morph = part?.morph ?? ZERO_MORPH;
    finiteArray(m, 6, 'part transform'); finiteArray(morph, 2, 'part morph');
    const opacity = part?.opacity ?? 1;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('part opacity must be in [0,1]');
    const at = i * 12;
    output[at] = m[0]; output[at+1] = m[2]; output[at+2] = m[4]; output[at+3] = 0;
    output[at+4] = m[1]; output[at+5] = m[3]; output[at+6] = m[5]; output[at+7] = 0;
    const depth = part?.depth ?? 0;
    if (!Number.isFinite(depth) || depth < -1 || depth > 1) throw new RangeError('part depth must be in [-1,1]');
    output[at+8] = morph[0]; output[at+9] = morph[1]; output[at+10] = part?.visible === false ? 0 : opacity; output[at+11] = depth;
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

function meshPartBounds(vertices, partCount, morphCount) {
  const bounds = Array.from({ length: partCount }, () => ({
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    minDx0: Infinity, minDy0: Infinity, maxDx0: -Infinity, maxDy0: -Infinity,
    minDx1: Infinity, minDy1: Infinity, maxDx1: -Infinity, maxDy1: -Infinity,
  }));
  for (let at = 0; at < vertices.length; at += 11) {
    const bound = bounds[vertices[at + 10]], x = vertices[at], y = vertices[at + 1];
    bound.minX = Math.min(bound.minX, x); bound.maxX = Math.max(bound.maxX, x);
    bound.minY = Math.min(bound.minY, y); bound.maxY = Math.max(bound.maxY, y);
    const dx0 = morphCount > 0 ? vertices[at + 6] : 0, dy0 = morphCount > 0 ? vertices[at + 7] : 0;
    const dx1 = morphCount > 1 ? vertices[at + 8] : 0, dy1 = morphCount > 1 ? vertices[at + 9] : 0;
    bound.minDx0 = Math.min(bound.minDx0, dx0); bound.maxDx0 = Math.max(bound.maxDx0, dx0);
    bound.minDy0 = Math.min(bound.minDy0, dy0); bound.maxDy0 = Math.max(bound.maxDy0, dy0);
    bound.minDx1 = Math.min(bound.minDx1, dx1); bound.maxDx1 = Math.max(bound.maxDx1, dx1);
    bound.minDy1 = Math.min(bound.minDy1, dy1); bound.maxDy1 = Math.max(bound.maxDy1, dy1);
  }
  for (const bound of bounds) {
    if (!Number.isFinite(bound.minX)) { bound.minX = bound.minY = bound.maxX = bound.maxY = 0; }
    for (const key of ['minDx0', 'minDy0', 'maxDx0', 'maxDy0', 'minDx1', 'minDy1', 'maxDx1', 'maxDy1']) if (!Number.isFinite(bound[key])) bound[key] = 0;
  }
  return bounds;
}

/** Retained GPU meshes; batches only adjacent equal meshes. No game sorting or animation clock. */
export class MeshRenderer {
  constructor(device, { maxMeshes = 512, maxMeshBytes = 32 * 1024 * 1024, maxInstances = 2048, safeAlphaRunBatching = true } = {}) {
    for (const [key, value] of Object.entries({ maxMeshes, maxMeshBytes, maxInstances })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key} must be positive`);
    if (typeof safeAlphaRunBatching !== 'boolean') throw new TypeError('safeAlphaRunBatching must be a boolean');
    this.device = device;
    this.maxMeshes = maxMeshes; this.maxMeshBytes = maxMeshBytes; this.maxInstances = maxInstances;
    this.safeAlphaRunBatching = safeAlphaRunBatching;
    if (maxInstances * 64 > device.maxBufferBytes) throw new RangeError('Mesh instance buffer exceeds device byte limit');
    this.maxPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
    this.instanced = device.instancingSupported === true;
    this.instances = new Float32Array(maxInstances * 16);
    this.instanceBuffer = this.instanced ? device.createVertexBuffer({ capacityBytes: this.instances.byteLength }) : null;
    this.pipelines = new Map();
    this.meshes = new Set(); this.bytes = 0; this.count = 0; this.pending = null;
    this.planes = new Float32Array(this.maxPlanes * 3);
    this.partScratch = new Float32Array(16 * 12);
    this.alphaRunScratch = [];
    this.alphaRunCache = new WeakMap();
    this.alphaQueue = new Array(maxInstances); this.alphaBounds = Array.from({ length: maxInstances }, () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 })); this.alphaBoundsScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this.alphaQueueParts = new Float32Array(16 * 12); this.alphaQueueCount = 0; this.alphaQueueState = null;
    this.metrics = { draws: 0, instances: 0, geometryUploads: 0, geometryBytesUploaded: 0, instanceBytesUploaded: 0, partUniformBytesSubmitted: 0,
      alphaRunCacheHits: 0, alphaRunCacheMisses: 0, alphaRunSafeBatches: 0, alphaRunBatchedInstances: 0, alphaRunDrawsSaved: 0,
      alphaRunSafeRunDraws: 0, alphaRunImmediateRunDraws: 0, alphaRunOverlapBoundaries: 0, alphaRunSignatureBoundaries: 0,
      alphaRunUnbatchableBounds: 0, alphaRunImmediateInstances: 0,
      flushReasons: Object.create(null), drawDispatchReasons: Object.create(null) };
    this.state = 'ready'; this.failure = null;
    this.onLost = () => { this.discard(); this.state = 'lost'; };
    this.onRestored = () => {
      try {
        if (this.instanced && !device.instancingSupported) throw new Error('Restored context no longer supports mesh instancing');
        for (const mesh of this.meshes) {
          device.uploadVertices(mesh.buffer, mesh.vertices);
          if (mesh.indices) device.uploadIndices(mesh.indexBuffer, mesh.indices);
          for (const variant of mesh.expressionIndices.values()) if (variant.indices.length) device.uploadIndices(variant.indexBuffer, variant.indices);
          for (const variant of mesh.indexVariants.values()) if (variant.indices.length) device.uploadIndices(variant.indexBuffer, variant.indices);
        }
        this.state = 'ready'; this.failure = null;
      } catch (error) { this.state = 'failed'; this.failure = error.message; }
    };
    device.canvas.addEventListener('webglcontextlost', this.onLost);
    device.canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.disposed = false;
  }
  _pipeline(mesh, clipped) {
    const key = mesh.partCount + ':' + mesh.morphCount + ':' + Number(clipped) + ':' + Number(mesh.hasNonScalingStroke);
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;
    const uniforms = { u_projection: 'matrix3fv' };
    if (clipped) Object.assign(uniforms, { 'u_planes[0]': '3fv', u_planeCount: '1i' });
    if (mesh.hasNonScalingStroke) {
      uniforms.u_strokeViewportSize='2f';
      if (clipped) uniforms.u_inverseProjection='matrix3fv';
    }
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = '4fv';
    if (!this.instanced) for (const name of ['i_row0', 'i_row1', 'i_color', 'i_params']) uniforms[name] = '4f';
    pipeline = this.device.createPipeline({ vertex: shader(this.instanced, mesh.partCount, mesh.morphCount, clipped, mesh.hasNonScalingStroke),
      fragment: fragment(this.maxPlanes, clipped), stride: mesh.strideFloats * 4,
      ...(this.instanced ? { instanceStride: 64 } : {}),
      attributes: [...(mesh.hasNonScalingStroke ? ATTRIBUTES.filter(attribute => attribute.name !== 'a_morph') : ATTRIBUTES), ...(mesh.hasNonScalingStroke ? [
        { name: 'a_stroke', size: 4, offset: 24 }
      ] : []), ...(this.instanced ? INSTANCE_ATTRIBUTES : [])], uniforms });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
  createMesh(data) {
    this._ready();
    const indices = data?.indices;
    const expressionIndices = data?.expressionIndices === undefined ? {} : data.expressionIndices;
    const indexVariants = data?.indexVariants === undefined ? {} : data.indexVariants;
    const nonScalingStroke = data?.nonScalingStroke ?? false;
    if (!(data?.vertices instanceof Float32Array) || data.vertices.length < 33 || data.vertices.length % 11 || data.strideFloats !== 11 || typeof nonScalingStroke !== 'boolean' || !Number.isSafeInteger(data.partCount) || data.partCount < 1 || data.partCount > 16 || !Number.isSafeInteger(data.morphCount) || data.morphCount < 0 || data.morphCount > 2
        || (indices !== undefined && (!(indices instanceof Uint16Array) || indices.length < 3 || indices.length % 3 || data.vertices.length / 11 > 0x10000 || indices.some(index => index >= data.vertices.length / 11)))
        || (indices === undefined && data.vertices.length % 33)
        || !expressionIndices || typeof expressionIndices !== 'object' || Array.isArray(expressionIndices)
        || !indexVariants || typeof indexVariants !== 'object' || Array.isArray(indexVariants)) throw new TypeError('Mesh geometry with complete triangles and 1..16 parts required');
    const expressionEntries = Object.entries(expressionIndices), indexVariantEntries = Object.entries(indexVariants);
    const variantNames = new Set(expressionEntries.map(([name]) => name));
    if (expressionEntries.some(([name, variant]) => !name || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some(index => index >= data.vertices.length / 11))
        || indexVariantEntries.some(([name, variant]) => !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || variantNames.has(name) || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some(index => index >= data.vertices.length / 11))) {
      throw new TypeError('Invalid named mesh index variants or expression index variants');
    }
    if (data.vertices.some(n => !Number.isFinite(n))) throw new TypeError('Mesh values must be finite');
    for (let i = 0; i < data.vertices.length; i++) {
      if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) throw new RangeError('Mesh RGBA channels must be in [0,1]');
      if (i % 11 === 10 && (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)) throw new RangeError('Mesh part index outside partCount');
      if (i % 11 >= 6 + data.morphCount * 2 && i % 11 < 10 && data.vertices[i] !== 0 && !nonScalingStroke) throw new RangeError('Mesh deltas exceed declared morphCount');
    }
    if (nonScalingStroke && data.morphCount) throw new TypeError('Non-scaling stroke meshes cannot use vertex morph targets');
    const variantByteLength = [...expressionEntries, ...indexVariantEntries].reduce((total, [, variant]) => total + variant.byteLength, 0);
    const byteLength = data.vertices.byteLength + (indices?.byteLength ?? 0) + variantByteLength;
    if (this.meshes.size >= this.maxMeshes || this.bytes + byteLength > this.maxMeshBytes) throw new RangeError('Retained mesh budget exceeded');
    const vertices = data.vertices.slice(), ownedIndices = indices?.slice(), buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    let indexBuffer; const ownedExpressions = new Map(), ownedVariants = new Map();
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
    const mesh = Object.freeze({ renderer: this, buffer, indexBuffer, vertices, indices: ownedIndices,
      expressionIndices: ownedExpressions, indexVariants: ownedVariants,
      count: ownedIndices?.length ?? vertices.length / 11, byteLength, partCount: data.partCount, morphCount: data.morphCount, strideFloats: 11,
      hasNonScalingStroke: nonScalingStroke, partBounds: meshPartBounds(vertices, data.partCount, data.morphCount) });
    this.meshes.add(mesh); this.bytes += byteLength;
    this.metrics.geometryUploads++; this.metrics.geometryBytesUploaded += byteLength;
    return mesh;
  }
  deleteMesh(mesh) {
    if (!this.meshes.has(mesh)) return false;
    if (this.pending?.mesh === mesh || (this.alphaQueueCount && this.alphaQueueState.mesh === mesh)) this.flush('deleteMesh');
    this.alphaRunCache.delete(mesh);
    this.device.deleteVertexBuffer(mesh.buffer);
    if (mesh.indexBuffer) this.device.deleteIndexBuffer(mesh.indexBuffer);
    for (const variant of mesh.expressionIndices.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    for (const variant of mesh.indexVariants.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    this.meshes.delete(mesh); this.bytes -= mesh.byteLength;
    return true;
  }
  /** Captures state by value; subsequent transform/paint changes do not alter queued instances. */
  drawMesh(mesh, options = {}) {
    const { matrix = IDENTITY, projection, morph = [0, 0], parts = null, color = WHITE,
      forceColor = false, alpha = 1, whiteFlash = false, clips = [], depth = 0,
      depthTest = false, depthWrite = false, depthWriteAlphaThreshold = null, depthFunc = 'lequal', indexVariant = null,
      strokeViewport = null, stencilRef = null } = options;
    this._drawMeshInstances(mesh, { matrices: matrix, count: 1, projection, morph, parts, color, forceColor, alpha, whiteFlash, clips, indexVariant,
      depth, depthTest, depthWrite, depthWriteAlphaThreshold, depthFunc, strokeViewport, stencilRef });
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
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const bounds = this.alphaBoundsScratch;
    bounds.minX = minX - 1.5; bounds.minY = minY - 1.5; bounds.maxX = maxX + 1.5; bounds.maxY = maxY + 1.5;
    return bounds;
  }
  _boundsOverlap(a, b) { return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY); }
  _alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    const state = this.alphaQueueState;
    if (!state) return true;
    if (state.mesh !== mesh || state.indexVariant !== indexVariant || state.clip.key !== clip.key || state.stencilRef !== stencilRef
      || state.depthTest !== depthTest || state.depthFunc !== depthFunc || state.runKey !== runs.join(',')
      || projection.some((n, i) => Math.fround(n) !== state.projection[i])) return false;
    for (let i = 0; i < mesh.partCount * 12; i++) if (this.partScratch[i] !== this.alphaQueueParts[i]) return false;
    return true;
  }
  _startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
    this.alphaQueueParts.set(this.partScratch.subarray(0, mesh.partCount * 12));
    this.alphaQueueState = { mesh, projection: Float32Array.from(projection), clip, stencilRef, depthTest, depthFunc, indexVariant, runs: runs.slice(), runKey: runs.join(',') };
  }
  _flushAlphaQueue(reason) {
    if (!this.alphaQueueCount) return;
    const state = this.alphaQueueState, mesh = state.mesh, parts = this.alphaQueueParts.subarray(0, mesh.partCount * 12);
    const indexBufferVariant = state.indexVariant === null ? null : mesh.indexVariants.get(state.indexVariant) ?? mesh.expressionIndices.get(state.indexVariant);
    const projection = state.projection, clip = state.clip, pipeline = this._pipeline(mesh, clip.count > 0), uniforms = { u_projection: projection };
    this.planes.fill(0); if (clip.values) this.planes.set(clip.values);
    if (clip.count) Object.assign(uniforms, { 'u_planes[0]': this.planes, u_planeCount: clip.count });
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = parts;
    const instances = this.alphaQueueCount;
    this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, instances * 16));
    this.metrics.instanceBytesUploaded += instances * 64;
    for (let run = 0; run < state.runs.length; run += 3) {
      this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer: indexBufferVariant?.indexBuffer ?? mesh.indexBuffer,
        first: state.runs[run], count: state.runs[run + 1], instanceBuffer: this.instanceBuffer, instances, uniforms,
        depth: { test: state.depthTest, write: state.runs[run + 2], func: state.depthFunc },
        stencil: state.stencilRef === null ? false : { func: 'equal', ref: state.stencilRef, mask: 255, writeMask: 0, pass: 'keep' } });
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
    this.alphaQueueCount = 0; this.alphaQueueState = null;
  }
  /** Internal ordered instance append used when one retained pose has several transforms. */
  _drawMeshInstances(mesh, { matrices, count, projection, morph = [0, 0], parts = null, color = WHITE,
    forceColor = false, alpha = 1, whiteFlash = false, clips = [], prefixColor = null,
    prefixCount = 0, forceColorPrefixCount = 0, depth = 0, depthTest = false, depthWrite = false,
    depthWriteAlphaThreshold = null, depthFunc = 'lequal', indexVariant = null, strokeViewport = null, stencilRef = null } = {}) {
    this._ready();
    if (!this.meshes.has(mesh)) throw new TypeError('Mesh owned by this renderer required');
    if (indexVariant !== null && (typeof indexVariant !== 'string' || (!mesh.expressionIndices.has(indexVariant) && !mesh.indexVariants.has(indexVariant)))) {
      throw new TypeError('Known mesh index variant required');
    }
    if (!this.device.active) throw new Error('beginFrame required');
    if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) throw new RangeError('stencilRef must be null or in [0,255]');
    if (stencilRef !== null && !this.device.activeStencilAvailable) throw new Error('A stencil-tested mesh requires an active stencil attachment');
    if (!Number.isSafeInteger(count) || count < 1 || !matrices || matrices.length !== count * 6) throw new TypeError('Packed mesh instance matrices required');
    for (let i = 0; i < matrices.length; i++) if (!Number.isFinite(matrices[i])) throw new TypeError('Mesh matrix values must be finite');
    finiteArray(projection, 9, 'projection'); finiteArray(morph, 2, 'morph'); finiteArray(color, 4, 'color');
    let strokeSize = null, inverseStrokeProjection = null;
    if (mesh.hasNonScalingStroke) {
      if (strokeViewport === null) {
        if (this.device.activeRenderTarget) throw new Error('A strokeViewport is required for non-scaling strokes rendered to a render target');
        strokeSize = [this.device.canvas.clientWidth, this.device.canvas.clientHeight];
      } else {
        finiteArray(strokeViewport, 2, 'strokeViewport');
        strokeSize = [strokeViewport[0], strokeViewport[1]];
      }
      if (strokeSize.some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError('Non-scaling strokes require a positive CSS-pixel viewport size');
      inverseStrokeProjection = invertProjection(projection);
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some(n => n < 0 || n > 1)) throw new RangeError('RGBA/alpha in [0,1] required');
    if (!Number.isFinite(depth) || depth < -1 || depth > 1) throw new RangeError('depth must be in [-1,1]');
    if (typeof depthTest !== 'boolean' || typeof depthWrite !== 'boolean') throw new TypeError('depthTest and depthWrite must be booleans');
    if (depthWriteAlphaThreshold !== null && (!Number.isFinite(depthWriteAlphaThreshold) || depthWriteAlphaThreshold < 0 || depthWriteAlphaThreshold > 1)) {
      throw new RangeError('depthWriteAlphaThreshold must be in [0,1]');
    }
    if (!['never', 'less', 'equal', 'lequal', 'greater', 'notequal', 'gequal', 'always'].includes(depthFunc)) throw new TypeError('Unsupported depthFunc');
    if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > count ||
      !Number.isSafeInteger(forceColorPrefixCount) || forceColorPrefixCount < 0 || forceColorPrefixCount > count) throw new RangeError('Instance color prefix count is invalid');
    if (prefixCount && !prefixColor) throw new TypeError('A prefix color is required for colored mesh instances');
    if (prefixColor !== null) {
      finiteArray(prefixColor, 4, 'prefix color');
      if (prefixColor.some(n => n < 0 || n > 1)) throw new RangeError('RGBA channels must be in [0,1]');
    }
    const clip = clipState(clips, this.maxPlanes), pending = this.pending;
    const variant = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    packParts(parts, mesh.partCount, this.partScratch);
    for (let i = 0; i < mesh.partCount; i++) if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) throw new RangeError('combined mesh and part depth must be in [-1,1]');
    const depthStateKey = Number(depthTest) + ':' + Number(depthWrite) + ':' + depthFunc;
    const alphaDepthWrite = depthWrite && depthWriteAlphaThreshold !== null;
    if (!alphaDepthWrite) {
      if (this.alphaQueueCount) this._flushAlphaQueue('alphaBoundary');
      if (pending) {
        const reason = pending.mesh !== mesh ? 'mesh' : pending.indexVariant !== indexVariant ? 'indexVariant' : pending.clip.key !== clip.key ? 'clip'
          : pending.stencilRef !== stencilRef ? 'stencil' : pending.depthStateKey !== depthStateKey ? 'depthState'
            : projection.some((n, i) => Math.fround(n) !== pending.projection[i]) ? 'projection'
              : mesh.partCount > 1 && pending.parts.some((n, i) => n !== this.partScratch[i]) ? 'parts' : this.count === this.maxInstances ? 'capacity' : null;
        if (reason) this.flush(reason);
      }
      if (variant?.count === 0) return;
      const part = this.partScratch, singlePart = mesh.partCount === 1;
      for (let i = 0; i < count; i++) {
        if (this.count === this.maxInstances) this.flush('capacity');
        if (!this.pending) this.pending = { mesh, projection: Float32Array.from(projection), clip, stencilRef, depthStateKey,
          indexVariant, strokeSize, inverseStrokeProjection, depthState: { test: depthTest, write: depthWrite, func: depthFunc }, parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0) };
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
        const instanceDepth = depth + (singlePart ? part[11] : 0);
        data[at + 12] = weight0; data[at + 13] = weight1; data[at + 14] = whiteFlash ? 1 : 0; data[at + 15] = instanceDepth;
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
        m0 = a * part[0] + c * part[4]; m1 = b * part[0] + d * part[4];
        m2 = a * part[1] + c * part[5]; m3 = b * part[1] + d * part[5];
        m4 = a * part[2] + c * part[6] + m4; m5 = b * part[2] + d * part[6] + m5;
        instanceAlpha *= part[10]; weight0 += part[8]; weight1 += part[9];
      }
      const instanceColor = i < prefixCount ? prefixColor : color;
      const instanceForceColor = i < forceColorPrefixCount ? true : forceColor, at = slot * 16, data = this.instances;
      data[at] = m0; data[at + 1] = m2; data[at + 2] = m4; data[at + 3] = instanceAlpha;
      data[at + 4] = m1; data[at + 5] = m3; data[at + 6] = m5; data[at + 7] = instanceForceColor ? 1 : 0;
      data[at + 8] = instanceColor[0]; data[at + 9] = instanceColor[1]; data[at + 10] = instanceColor[2]; data[at + 11] = instanceColor[3];
      data[at + 12] = weight0; data[at + 13] = weight1; data[at + 14] = whiteFlash ? 1 : 0;
      data[at + 15] = depth + (singlePart ? part[11] : 0);
    };
    for (let i = 0; i < count; i++) {
      const instanceColor = i < prefixCount ? prefixColor : color;
      const instanceForceColor = i < forceColorPrefixCount ? true : forceColor;
      const runs = this._collectAlphaDepthRuns(mesh, indices, triangleCount, depthWriteAlphaThreshold,
        alpha * instanceColor[3], instanceForceColor, indexVariant);
      const totalVertices = triangleCount * 3;
      const oneRun = runs.length === 3 && runs[0] === 0 && runs[1] === totalVertices;
      if (!oneRun) {
        const bounds = this.safeAlphaRunBatching && this.instanced ? this._screenBounds(mesh, matrices, i, projection, morph) : null;
        if (bounds) {
          if (this.count) this.flush('alphaDepthBoundary');
          if (this.alphaQueueCount && !this._alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs)) {
            this.metrics.alphaRunSignatureBoundaries++;
            this._flushAlphaQueue('alphaSignature');
          }
          let overlapsQueuedBounds = false;
          for (let queued = 0; queued < this.alphaQueueCount; queued++) {
            if (this._boundsOverlap(bounds, this.alphaBounds[queued])) { overlapsQueuedBounds = true; break; }
          }
          if (overlapsQueuedBounds) {
            this.metrics.alphaRunOverlapBoundaries++;
            this._flushAlphaQueue('alphaOverlap');
          }
          if (this.alphaQueueCount === this.maxInstances) this._flushAlphaQueue('capacity');
          if (!this.alphaQueueCount) this._startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs);
          const slot = this.alphaQueueCount;
          Object.assign(this.alphaBounds[slot], bounds);
          writeAlphaInstance(i, slot); this.alphaQueueCount++;
          continue;
        }
        if (this.safeAlphaRunBatching) this.metrics.alphaRunUnbatchableBounds++;
        if (this.alphaQueueCount) this._flushAlphaQueue('alphaUnsupportedBoundary');
        if (this.count) this.flush('alphaImmediateBoundary');
        writeAlphaInstance(i, 0);
        this._drawAlphaDepthRuns(mesh, variant, projection, clip, part.subarray(0, mesh.partCount * 12), runs, depthTest, depthFunc, strokeSize, inverseStrokeProjection, stencilRef);
        this.metrics.alphaRunImmediateInstances++; this.metrics.alphaRunImmediateRunDraws += runs.length / 3;
        continue;
      }
      if (this.alphaQueueCount) this._flushAlphaQueue('singleRunBoundary');
      const write = runs[2], stateKey = Number(depthTest) + ':' + Number(write) + ':' + depthFunc;
      if (this.pending) {
        const current = this.pending, reason = current.mesh !== mesh ? 'mesh' : current.indexVariant !== indexVariant ? 'indexVariant' : current.clip.key !== clip.key ? 'clip'
          : current.stencilRef !== stencilRef ? 'stencil' : current.depthStateKey !== stateKey ? 'depthState'
            : projection.some((n, j) => Math.fround(n) !== current.projection[j]) ? 'projection'
              : strokeSize && strokeSize.some((n, j) => n !== current.strokeSize?.[j]) ? 'strokeViewport'
                : mesh.partCount > 1 && current.parts.some((n, j) => n !== this.partScratch[j]) ? 'parts' : this.count === this.maxInstances ? 'capacity' : null;
        if (reason) this.flush(reason);
      }
      if (!this.pending) this.pending = { mesh, projection: Float32Array.from(projection), clip, stencilRef, depthStateKey: stateKey,
        indexVariant, strokeSize, inverseStrokeProjection, depthState: { test: depthTest, write, func: depthFunc }, parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0) };
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
      const at = this.count++ * 16, data = this.instances;
      data[at] = m0; data[at + 1] = m2; data[at + 2] = m4; data[at + 3] = instanceAlpha;
      data[at + 4] = m1; data[at + 5] = m3; data[at + 6] = m5; data[at + 7] = instanceForceColor ? 1 : 0;
      data[at + 8] = instanceColor[0]; data[at + 9] = instanceColor[1];
      data[at + 10] = instanceColor[2]; data[at + 11] = instanceColor[3];
      data[at + 12] = weight0; data[at + 13] = weight1; data[at + 14] = whiteFlash ? 1 : 0;
      data[at + 15] = depth + (singlePart ? part[11] : 0);
    }
  }
  _collectAlphaDepthRuns(mesh, indices, triangleCount, threshold, opacity, forceColor, indexVariant) {
    let cache = this.alphaRunCache.get(mesh);
    if (!cache) { cache = new Map(); this.alphaRunCache.set(mesh, cache); }
    const partOpacities = [];
    for (let i = 0; i < mesh.partCount; i++) partOpacities.push(this.partScratch[i * 12 + 10]);
    const key = JSON.stringify([indexVariant, threshold, opacity, forceColor, partOpacities]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key); cache.set(key, cached);
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
          if (effectiveAlpha <= 0 || effectiveAlpha < threshold) { write = false; break; }
        }
        if (runWrite === null) { runStart = triangle; runWrite = write; }
        else if (write !== runWrite) {
          runs.push(runStart * 3, (triangle - runStart) * 3, runWrite);
          runStart = triangle; runWrite = write;
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
    if (clip.count) Object.assign(uniforms, { 'u_planes[0]': this.planes, u_planeCount: clip.count });
    if (mesh.hasNonScalingStroke) Object.assign(uniforms, { u_strokeViewportSize: strokeSize, ...(clip.count ? { u_inverseProjection: inverseStrokeProjection } : {}) });
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = parts;
    if (!this.instanced) {
      for (let j = 0; j < 4; j++) uniforms[['i_row0', 'i_row1', 'i_color', 'i_params'][j]] =
        this.instances.subarray(j * 4, j * 4 + 4);
    } else {
      const instance = this.instances.subarray(0, 16);
      this.device.uploadVertices(this.instanceBuffer, instance);
      this.metrics.instanceBytesUploaded += instance.byteLength;
    }
    const indexBuffer = variant?.indexBuffer ?? mesh.indexBuffer;
    for (let run = 0; run < runs.length; run += 3) {
      this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer, first: runs[run], count: runs[run + 1],
        instanceBuffer: this.instanceBuffer, instances: 1, uniforms,
        depth: { test: depthTest, write: runs[run + 2], func: depthFunc }, stencil: stencilRef===null?false:{func:'equal',ref:stencilRef,mask:255,writeMask:0,pass:'keep'} });
      this.metrics.draws++;
      this.metrics.drawDispatchReasons.alphaImmediateRun = (this.metrics.drawDispatchReasons.alphaImmediateRun ?? 0) + 1;
      if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
    }
    this.metrics.instances++;
  }
  flush(reason = 'explicit') {
    if (this.alphaQueueCount) this._flushAlphaQueue(reason);
    if (!this.count) return;
    this._ready();
    const { mesh, projection, clip, parts, depthState, indexVariant, strokeSize, inverseStrokeProjection, stencilRef } = this.pending;
    const variant = indexVariant === null ? null : mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant);
    this.planes.fill(0); if (clip.values) this.planes.set(clip.values);
    const pipeline = this._pipeline(mesh, clip.count > 0), uniforms = { u_projection: projection };
    if (clip.count) Object.assign(uniforms, { 'u_planes[0]': this.planes, u_planeCount: clip.count });
    if (mesh.hasNonScalingStroke) Object.assign(uniforms, { u_strokeViewportSize: strokeSize, ...(clip.count ? { u_inverseProjection: inverseStrokeProjection } : {}) });
    if (mesh.partCount > 1) uniforms['u_parts[0]'] = parts;
    if (this.instanced) {
      this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, this.count * 16));
      this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer: variant?.indexBuffer ?? mesh.indexBuffer, count: variant?.count ?? mesh.count, instanceBuffer: this.instanceBuffer, instances: this.count, uniforms, depth: depthState, stencil: stencilRef===null?false:{func:'equal',ref:stencilRef,mask:255,writeMask:0,pass:'keep'} });
       this.metrics.instanceBytesUploaded += this.count * 64; this.metrics.draws++;
       this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
       if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
    } else {
      for (let i = 0; i < this.count; i++) {
        for (let j = 0; j < 4; j++) uniforms[['i_row0', 'i_row1', 'i_color', 'i_params'][j]] = this.instances.subarray(i * 16 + j * 4, i * 16 + j * 4 + 4);
        this.device.draw({ pipeline, buffer: mesh.buffer, indexBuffer: variant?.indexBuffer ?? mesh.indexBuffer, count: variant?.count ?? mesh.count, uniforms, depth: depthState, stencil: stencilRef===null?false:{func:'equal',ref:stencilRef,mask:255,writeMask:0,pass:'keep'} }); this.metrics.draws++;
        this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
         if (mesh.partCount > 1) this.metrics.partUniformBytesSubmitted += parts.byteLength;
      }
    }
    this.metrics.instances += this.count;
    this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
    this.discard();
  }
  discard() { this.count = 0; this.pending = null; this.alphaQueueCount = 0; this.alphaQueueState = null; }
  _ready() { if (this.state !== 'ready' || this.disposed) throw new Error(`MeshRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`); }
  beginFrame() { this.discard(); for (const key of Object.keys(this.metrics)) if (key !== 'flushReasons' && key !== 'drawDispatchReasons') this.metrics[key] = 0; this.metrics.flushReasons = Object.create(null); this.metrics.drawDispatchReasons = Object.create(null); }
  stats() { return { ...this.metrics, flushReasons: { ...this.metrics.flushReasons }, drawDispatchReasons: { ...this.metrics.drawDispatchReasons }, pendingAlphaRunInstances: this.alphaQueueCount, safeAlphaRunBatching: this.safeAlphaRunBatching, state: this.state, failure: this.failure, pipelineCount: this.pipelines.size, meshCount: this.meshes.size, retainedBytes: this.bytes, stagingBytes: this.instances.byteLength + this.planes.byteLength + this.partScratch.byteLength, instanced: this.instanced, maxClipPlanes: this.maxPlanes }; }
  dispose() {
    if (this.disposed) return;
    this.discard(); this.device.canvas.removeEventListener('webglcontextlost', this.onLost); this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const mesh of this.meshes) {
      this.device.deleteVertexBuffer(mesh.buffer);
      if (mesh.indexBuffer) this.device.deleteIndexBuffer(mesh.indexBuffer);
      for (const variant of mesh.expressionIndices.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
      for (const variant of mesh.indexVariants.values()) if (variant.indexBuffer) this.device.deleteIndexBuffer(variant.indexBuffer);
    }
    this.meshes.clear(); this.bytes = 0; this.alphaRunCache = new WeakMap(); this.alphaRunScratch.length = 0;
    if (this.instanceBuffer) this.device.deleteVertexBuffer(this.instanceBuffer);
    for (const pipeline of this.pipelines.values()) this.device.deletePipeline(pipeline);
    this.pipelines.clear(); this.disposed = true; this.state = 'disposed';
  }
}

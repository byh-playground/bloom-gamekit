import { normalizeColor } from './vector-context.js';

/** Cold-path, local-space authored triangles. PrimitivePainter can paint directly into this target. */
export class MeshBuilder {
  constructor({ maxVertices = 262144 } = {}) {
    if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) throw new RangeError('maxVertices must be >= 3');
    this.maxVertices = maxVertices;
    this.globalAlpha = 1;
    this.vertices = [];
  }
  fillTriangleFan(points, paint) {
    if (!points || points.length < 3) return;
    if (!Number.isFinite(this.globalAlpha) || this.globalAlpha < 0 || this.globalAlpha > 1) throw new RangeError('globalAlpha must be in [0,1]');
    const color = normalizeColor(paint);
    color[3] *= this.globalAlpha;
    if (this.vertices.length / 6 + (points.length - 2) * 3 > this.maxVertices) throw new RangeError('MeshBuilder vertex capacity exceeded');
    for (const p of points) if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new TypeError('Finite mesh points required');
    for (let i = 2; i < points.length; i++) {
      for (const p of [points[0], points[i - 1], points[i]]) this.vertices.push(p[0], p[1], ...color);
    }
  }
  /** Each target is the same authored triangle/color sequence with different positions, not a sampled time cache. */
  build({ morphs = [] } = {}) {
    if (!Array.isArray(morphs) || morphs.length > 2 || morphs.some(m => !(m instanceof MeshBuilder))) throw new TypeError('At most two MeshBuilder morph targets required');
    const base = this.vertices, count = base.length / 6;
    for (const target of morphs) {
      if (target.vertices.length !== base.length) throw new RangeError('Morph topology differs');
      for (let i = 0; i < base.length; i++) if (i % 6 >= 2 && target.vertices[i] !== base[i]) throw new RangeError('Morph colors differ');
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
    if (!Array.isArray(geometries) || !geometries.length ||
      geometries.some(geometry => !Number.isSafeInteger(geometry?.partCount) || geometry.partCount < 1 ||
        geometry.strideFloats !== 11 || !(geometry.vertices instanceof Float32Array) || geometry.vertices.length < 33 || geometry.vertices.length % 11 ||
        (geometry.indices !== undefined && (!(geometry.indices instanceof Uint16Array) || geometry.indices.length < 3 || geometry.indices.length % 3 ||
          geometry.vertices.length / 11 > 0x10000 || geometry.indices.some(index => index >= geometry.vertices.length / 11))) ||
        (geometry.indices === undefined && geometry.vertices.length % 33) ||
        !Number.isSafeInteger(geometry.morphCount) || geometry.morphCount < 0 || geometry.morphCount > 2) ||
      geometries.reduce((count, geometry) => count + geometry.partCount, 0) > 16) {
      throw new TypeError('MeshBuilder geometries must fit within 16 parts and use the 11-float schema');
    }
    const vertexCount = geometries.reduce((count, geometry) => count + geometry.vertices.length / 11, 0);
    const indexCount = geometries.reduce((count, geometry) => count + (geometry.indices?.length ?? geometry.vertices.length / 11), 0);
    if (vertexCount > 0x10000) throw new RangeError('Combined geometry exceeds 65,536 distinct vertices');
    for (const geometry of geometries) for (let i = 10; i < geometry.vertices.length; i += 11) {
      const part = geometry.vertices[i];
      if (!Number.isSafeInteger(part) || part < 0 || part >= geometry.partCount) throw new RangeError('Mesh part index outside partCount');
    }
    const vertices = new Float32Array(vertexCount * 11), indices = new Uint16Array(indexCount);
    const partCount = geometries.reduce((count, geometry) => count + geometry.partCount, 0);
    const morphCount = Math.max(...geometries.map(geometry => geometry.morphCount));
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
    return Object.freeze({ vertices, indices, count: indices.length, strideFloats: 11, partCount, morphCount });
  }
}

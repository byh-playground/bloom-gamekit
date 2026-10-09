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
  /** Packs authored parts in their original painter order, never one GPU buffer per animated part. */
  static combine(parts) {
    if (!Array.isArray(parts) || !parts.length || parts.length > 16 || parts.some(p => p?.partCount !== 1 || p.strideFloats !== 11 || !(p.vertices instanceof Float32Array) || p.vertices.length % 33)) throw new TypeError('1..16 single-part MeshBuilder geometries required');
    const vertices = new Float32Array(parts.reduce((n, part) => n + part.vertices.length, 0));
    let offset = 0;
    for (let part = 0; part < parts.length; part++) {
      vertices.set(parts[part].vertices, offset);
      for (let i = 10; i < parts[part].vertices.length; i += 11) vertices[offset + i] = part;
      offset += parts[part].vertices.length;
    }
    return Object.freeze({ vertices, count: vertices.length / 11, strideFloats: 11, partCount: parts.length, morphCount: Math.max(...parts.map(p => p.morphCount)) });
  }
}

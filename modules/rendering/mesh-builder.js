import { normalizeColor } from './vector-context.js';
const INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const IS_INDEX_MAP = (map, vertexCount) =>
    map !== null &&
    typeof map === 'object' &&
    !Array.isArray(map) &&
    Object.entries(map).every(
        ([name, indices]) =>
            INDEX_NAME.test(name) &&
            indices instanceof Uint16Array &&
            indices.length % 3 === 0 &&
            indices.every((index) => index < vertexCount),
    );
const BASE_INDICES = (geometry) =>
    geometry.indices ??
    Uint16Array.from(
        {
            length: geometry.vertices.length / 11,
        },
        (_, index) => index,
    );

/** Cold-path, local-space authored triangles. PrimitivePainter can paint directly into this target. */
export class MeshBuilder {
    constructor({ maxVertices = 262144 } = {}) {
        if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) {
            throw new RangeError('maxVertices must be >= 3');
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
            throw new RangeError('globalAlpha must be in [0,1]');
        }
        const COLOR = normalizeColor(paint);
        COLOR[3] *= this.globalAlpha;
        if (this.vertices.length / 6 + (points.length - 2) * 3 > this.maxVertices) {
            throw new RangeError('MeshBuilder vertex capacity exceeded');
        }
        for (const P of points) {
            if (!P || !Number.isFinite(P[0]) || !Number.isFinite(P[1])) {
                throw new TypeError('Finite mesh points required');
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
        if (!Array.isArray(morphs) || morphs.length > 2 || morphs.some((m) => !(m instanceof MeshBuilder))) {
            throw new TypeError('At most two MeshBuilder morph targets required');
        }
        const BASE = this.vertices,
            COUNT = BASE.length / 6;
        for (const TARGET of morphs) {
            if (TARGET.vertices.length !== BASE.length) {
                throw new RangeError('Morph topology differs');
            }
            for (let i = 0; i < BASE.length; i++) {
                if (i % 6 >= 2 && TARGET.vertices[i] !== BASE[i]) {
                    throw new RangeError('Morph colors differ');
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
            partCount: 1,
        });
    }
    /** Packs compatible authored geometries into one painter-ordered mesh without sorting. */
    static combine(geometries) {
        if (
            !Array.isArray(geometries) ||
            !geometries.length ||
            geometries.some(
                (geometry) =>
                    !Number.isSafeInteger(geometry?.partCount) ||
                    geometry.partCount < 1 ||
                    geometry.strideFloats !== 11 ||
                    !(geometry.vertices instanceof Float32Array) ||
                    geometry.vertices.length < 33 ||
                    geometry.vertices.length % 11 ||
                    (geometry.nonScalingStroke !== undefined && typeof geometry.nonScalingStroke !== 'boolean') ||
                    (geometry.nonScalingStroke && geometry.morphCount !== 0) ||
                    (geometry.indices !== undefined &&
                        (!(geometry.indices instanceof Uint16Array) ||
                            geometry.indices.length < 3 ||
                            geometry.indices.length % 3 ||
                            geometry.vertices.length / 11 > 0x10000 ||
                            geometry.indices.some((index) => index >= geometry.vertices.length / 11))) ||
                    (geometry.indices === undefined && geometry.vertices.length % 33) ||
                    !Number.isSafeInteger(geometry.morphCount) ||
                    geometry.morphCount < 0 ||
                    geometry.morphCount > 2 ||
                    (geometry.expressionIndices !== undefined &&
                        !IS_INDEX_MAP(geometry.expressionIndices, geometry.vertices.length / 11)) ||
                    (geometry.indexVariants !== undefined &&
                        (!IS_INDEX_MAP(geometry.indexVariants, geometry.vertices.length / 11) ||
                            Object.keys(geometry.indexVariants).length > 0)),
            ) ||
            geometries.reduce((count, geometry) => count + geometry.partCount, 0) > 16
        ) {
            throw new TypeError(
                'MeshBuilder geometries must fit within 16 parts, use the 11-float schema, and cannot flatten painter-order indexVariants',
            );
        }
        const VERTEX_COUNT = geometries.reduce((count, geometry) => count + geometry.vertices.length / 11, 0);
        const INDEX_COUNT = geometries.reduce(
            (count, geometry) => count + (geometry.indices?.length ?? geometry.vertices.length / 11),
            0,
        );
        if (VERTEX_COUNT > 0x10000) {
            throw new RangeError('Combined geometry exceeds 65,536 distinct vertices');
        }
        for (const GEOMETRY of geometries) {
            for (let i = 10; i < GEOMETRY.vertices.length; i += 11) {
                const PART = GEOMETRY.vertices[i];
                if (!Number.isSafeInteger(PART) || PART < 0 || PART >= GEOMETRY.partCount) {
                    throw new RangeError('Mesh part index outside partCount');
                }
            }
        }
        const VERTICES = new Float32Array(VERTEX_COUNT * 11),
            INDICES = new Uint16Array(INDEX_COUNT);
        const EXPRESSION_NAMES = new Set(
            geometries.flatMap((geometry) => Object.keys(geometry.expressionIndices ?? {})),
        );
        const EXPRESSION_INDICES = Object.create(null);
        const PART_COUNT = geometries.reduce((count, geometry) => count + geometry.partCount, 0);
        const MORPH_COUNT = Math.max(...geometries.map((geometry) => geometry.morphCount));
        const NON_SCALING_STROKE = geometries.some((geometry) => geometry.nonScalingStroke === true);
        if (NON_SCALING_STROKE && MORPH_COUNT) {
            throw new TypeError('Non-scaling strokes cannot be combined with vertex morph targets');
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
                (count, geometry) =>
                    count +
                    (geometry.expressionIndices?.[NAME]?.length ??
                        geometry.indices?.length ??
                        geometry.vertices.length / 11),
                0,
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
            ...(EXPRESSION_NAMES.size
                ? {
                      expressionIndices: EXPRESSION_INDICES,
                  }
                : {}),
            ...(NON_SCALING_STROKE
                ? {
                      nonScalingStroke: true,
                  }
                : {}),
        });
    }
}

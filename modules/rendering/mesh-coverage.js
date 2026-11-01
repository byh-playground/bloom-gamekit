// Cold-path proof of an opaque composite. Only the same part may cover a translucent triangle: different parts
// can move, fade or become invisible independently. Exceeding the bounded proof work is an unknown, never a pass.
const MAX_EDGE_TESTS = 2000000;
const MAX_PIECES = 8192;

/**
 * Whether every visible triangle is covered by fully opaque triangles of its own part. Accepts the authored
 * 11-float mesh geometry, before GPU upload. Select the actual expression/index variant used for the draw.
 * This proves local-space coverage only; callers must also keep the draw and part opacity fully opaque.
 * Morphs, shader materials, non-scaling strokes and exhausted proof budgets conservatively return false.
 * Call outside a frame and cache the result for immutable geometry/variant pairs.
 */
export function hasOpaqueCoverage(geometry, { indexVariant = null } = {}) {
    if (
        !(geometry?.vertices instanceof Float32Array) ||
        geometry.vertices.length % 11 ||
        geometry.strideFloats !== 11
    ) {
        throw new TypeError('Authored 11-float mesh geometry is required');
    }
    let indices = geometry.indices;
    if (indexVariant !== null) {
        indices = geometry.expressionIndices?.[indexVariant] ?? geometry.indexVariants?.[indexVariant];
        if (!(indices instanceof Uint16Array)) {
            throw new TypeError('A known mesh expression or index variant is required');
        }
    }
    if (geometry.morphCount || geometry.nonScalingStroke || geometry.materials) {
        return false;
    }
    const VERTICES = geometry.vertices,
        COUNT = indices?.length ?? VERTICES.length / 11,
        POINTS = exactPoints(VERTICES),
        PARTS = new Map();
    if (!POINTS) {
        return false;
    }
    let opaqueCount = 0;
    let edgeTests = 0;
    for (let offset = 0; offset < COUNT; offset += 3) {
        const TRIANGLE = [];
        let part = null;
        let opaque = true;
        let visible = false;
        for (let corner = 0; corner < 3; corner++) {
            const AT = (indices?.[offset + corner] ?? offset + corner) * 11,
                ALPHA = VERTICES[AT + 5],
                PART = VERTICES[AT + 10];
            if (part !== null && part !== PART) {
                return false;
            }
            part = PART;
            opaque &&= ALPHA === 1;
            visible ||= ALPHA > 0;
            TRIANGLE.push(POINTS[AT / 11]);
        }
        const AREA = turn(...TRIANGLE);
        if (!visible || AREA === 0n) {
            continue;
        }
        if (AREA < 0n) {
            TRIANGLE.reverse();
        }
        let group = PARTS.get(part);
        if (!group) {
            group = { opaque: [], partial: [] };
            PARTS.set(part, group);
        }
        const ENTRY = { polygon: TRIANGLE, bounds: bounds(TRIANGLE), area: Math.abs(Number(AREA)) };
        if (opaque) {
            group.opaque.push(ENTRY);
            opaqueCount++;
        } else {
            group.partial.push(ENTRY);
        }
    }
    if (!opaqueCount) {
        return false;
    }
    for (const GROUP of PARTS.values()) {
        // Large underlying fills usually discharge the proof before narrow outline triangles are visited.
        GROUP.opaque.sort((a, b) => b.area - a.area);
        for (const PARTIAL of GROUP.partial) {
            let pieces = [PARTIAL];
            for (const OPAQUE of GROUP.opaque) {
                if (++edgeTests > MAX_EDGE_TESTS) {
                    return false;
                }
                if (!overlaps(PARTIAL.bounds, OPAQUE.bounds)) {
                    continue;
                }
                const NEXT = [];
                for (const PIECE of pieces) {
                    if (!overlaps(PIECE.bounds, OPAQUE.bounds)) {
                        NEXT.push(PIECE);
                        continue;
                    }
                    let inside = PIECE.polygon;
                    for (let edge = 0; edge < 3 && inside.length; edge++) {
                        edgeTests += inside.length;
                        if (edgeTests > MAX_EDGE_TESTS) {
                            return false;
                        }
                        const [REMAINDER, OUTSIDE] = split(
                            inside,
                            OPAQUE.polygon[edge],
                            OPAQUE.polygon[(edge + 1) % 3],
                        );
                        if (hasArea(OUTSIDE)) {
                            NEXT.push({ polygon: OUTSIDE, bounds: bounds(OUTSIDE) });
                        }
                        inside = REMAINDER;
                    }
                    if (NEXT.length > MAX_PIECES) {
                        return false;
                    }
                }
                pieces = NEXT;
                if (!pieces.length) {
                    break;
                }
            }
            if (pieces.length) {
                return false;
            }
        }
    }
    return true;
}

function bounds(polygon) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [NX, NY, DENOMINATOR] of polygon) {
        const X = Number(NX) / Number(DENOMINATOR),
            Y = Number(NY) / Number(DENOMINATOR);
        minX = Math.min(minX, X);
        minY = Math.min(minY, Y);
        maxX = Math.max(maxX, X);
        maxY = Math.max(maxY, Y);
    }
    return [minX, minY, maxX, maxY];
}

function overlaps(a, b) {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Float32 authored coordinates are dyadic rationals. A common power-of-two scale makes them integers, and
// homogeneous rational points keep every later line intersection exact. No area epsilon can erase a real hole.
function exactPoints(vertices) {
    const WORDS = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
    let minExponent = Infinity;
    let maxExponent = -Infinity;
    for (let index = 0; index < WORDS.length; index += 11) {
        for (let axis = 0; axis < 2; axis++) {
            const WORD = WORDS[index + axis],
                BIASED = (WORD >>> 23) & 255;
            if (BIASED === 255) {
                throw new TypeError('Mesh coordinates must be finite');
            }
            if (!(WORD & 0x7fffffff)) {
                continue;
            }
            const EXPONENT = BIASED ? BIASED - 150 : -149;
            minExponent = Math.min(minExponent, EXPONENT);
            maxExponent = Math.max(maxExponent, EXPONENT);
        }
    }
    if (maxExponent - minExponent > 80) {
        return null;
    }
    const INTEGER = (word) => {
        if (!(word & 0x7fffffff)) {
            return 0n;
        }
        const BIASED = (word >>> 23) & 255,
            EXPONENT = BIASED ? BIASED - 150 : -149,
            MANTISSA = (word & 0x7fffff) | (BIASED ? 0x800000 : 0),
            VALUE = BigInt(MANTISSA) << BigInt(EXPONENT - minExponent);
        return word >>> 31 ? -VALUE : VALUE;
    };
    const POINTS = [];
    for (let index = 0; index < WORDS.length; index += 11) {
        POINTS.push([INTEGER(WORDS[index]), INTEGER(WORDS[index + 1]), 1n]);
    }
    return POINTS;
}

function turn(a, b, c) {
    return (
        (b[0] * a[2] - a[0] * b[2]) * (c[1] * a[2] - a[1] * c[2]) -
        (b[1] * a[2] - a[1] * b[2]) * (c[0] * a[2] - a[0] * c[2])
    );
}

function hasArea(polygon) {
    for (let index = 1; index + 1 < polygon.length; index++) {
        if (turn(polygon[0], polygon[index], polygon[index + 1]) !== 0n) {
            return true;
        }
    }
    return false;
}

function gcd(a, b) {
    let x = a < 0n ? -a : a;
    let y = b < 0n ? -b : b;
    while (y) {
        const REMAINDER = x % y;
        x = y;
        y = REMAINDER;
    }
    return x;
}

function intersection(a, b, da, db) {
    const X = da * b[0] - db * a[0],
        Y = da * b[1] - db * a[1],
        W = da * b[2] - db * a[2],
        DIVISOR = gcd(gcd(X, Y), W) * (W < 0n ? -1n : 1n);
    return [X / DIVISOR, Y / DIVISOR, W / DIVISOR];
}

function split(polygon, a, b) {
    const INSIDE = [],
        OUTSIDE = [],
        DX = b[0] - a[0],
        DY = b[1] - a[1],
        DISTANCE = (point) => DX * (point[1] - a[1] * point[2]) - DY * (point[0] - a[0] * point[2]);
    let previous = polygon[polygon.length - 1];
    let previousDistance = DISTANCE(previous);
    for (const CURRENT of polygon) {
        const DISTANCE_NOW = DISTANCE(CURRENT);
        if ((previousDistance < 0n && DISTANCE_NOW > 0n) || (previousDistance > 0n && DISTANCE_NOW < 0n)) {
            const INTERSECTION = intersection(previous, CURRENT, previousDistance, DISTANCE_NOW);
            INSIDE.push(INTERSECTION);
            OUTSIDE.push(INTERSECTION);
        }
        if (DISTANCE_NOW >= 0n) {
            INSIDE.push(CURRENT);
        }
        if (DISTANCE_NOW <= 0n) {
            OUTSIDE.push(CURRENT);
        }
        previous = CURRENT;
        previousDistance = DISTANCE_NOW;
    }
    return [INSIDE, OUTSIDE];
}

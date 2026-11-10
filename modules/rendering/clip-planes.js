/** Convex clip polygons as inward edge planes (a,b,c): inside when a*x+b*y+c >= 0. One definition for every renderer. */
// `key` is an integer id of the plane values: equal values always get the same id, so batches compare one number.
// Ids count up from 2 (0 is no clip, 1 a zero-area clip) and stay far below 2^53.
export const EMPTY_CLIP = Object.freeze({
    key: 0,
    values: null,
    count: 0,
});
const ZERO_AREA_CLIP = Object.freeze({
    key: 1,
    values: Object.freeze([0, 0, -1]),
    count: 1,
});
// Plane sets seen so far, bucketed by a 32-bit hash of their values; each entry owns a frozen copy of the values.
// Animated clips make new sets every frame, so the table is dropped when it grows past MAX_INTERNED; ids never repeat,
// so a batch still holding an old id only flushes once more.
const INTERNED = new Map();
const MAX_INTERNED = 4096;
let internedCount = 0;
const HASH_VIEW = new Float64Array(1);
const HASH_WORDS = new Uint32Array(HASH_VIEW.buffer);
let nextKey = 2;
let scratch = new Float64Array(96);

function hashValues(values, length) {
    // FNV-1a over the two 32-bit words of each double; Math.imul keeps the product in 32 bits.
    let hash = 0x811c9dc5;
    for (let i = 0; i < length; i++) {
        // +0 folds -0 into 0, which compares equal below.
        HASH_VIEW[0] = values[i] + 0;
        hash = Math.imul(hash ^ HASH_WORDS[0], 0x01000193);
        hash = Math.imul(hash ^ HASH_WORDS[1], 0x01000193);
    }
    return hash >>> 0;
}

function intern(values, length) {
    const HASH = hashValues(values, length);
    let bucket = INTERNED.get(HASH);
    if (bucket) {
        for (let b = 0; b < bucket.length; b++) {
            const ENTRY = bucket[b],
                SAVED = ENTRY.values;
            if (SAVED.length !== length) {
                continue;
            }
            let same = true;
            for (let i = 0; same && i < length; i++) {
                same = SAVED[i] === values[i];
            }
            if (same) {
                return ENTRY;
            }
        }
    } else {
        if (internedCount >= MAX_INTERNED) {
            INTERNED.clear();
            internedCount = 0;
        }
        bucket = [];
        INTERNED.set(HASH, bucket);
    }
    const ENTRY = Object.freeze({
        key: nextKey++,
        values: Object.freeze(Array.from(values.subarray(0, length))),
        count: length / 3,
    });
    bucket.push(ENTRY);
    internedCount++;
    return ENTRY;
}

export function clipPlanes(clips, maxPlanes) {
    if (!clips?.length) {
        return EMPTY_CLIP;
    }
    let length = 0;
    for (let c = 0; c < clips.length; c++) {
        const POLYGON = clips[c];
        if (!Array.isArray(POLYGON) || POLYGON.length < 3) {
            throw new TypeError('Finite convex clip polygons required');
        }
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i];
            if (!Number.isFinite(P?.x) || !Number.isFinite(P?.y)) {
                throw new TypeError('Finite convex clip polygons required');
            }
        }
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i],
                Q = POLYGON[(i + 1) % POLYGON.length];
            area += P.x * Q.y - Q.x * P.y;
        }
        if (Math.abs(area) < 1e-12) {
            return ZERO_AREA_CLIP;
        }
        const SIGN = area >= 0 ? 1 : -1;
        if (scratch.length < length + POLYGON.length * 3) {
            const NEXT = new Float64Array(Math.max(scratch.length * 2, length + POLYGON.length * 3));
            NEXT.set(scratch.subarray(0, length));
            scratch = NEXT;
        }
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i],
                Q = POLYGON[(i + 1) % POLYGON.length],
                DX = Q.x - P.x,
                DY = Q.y - P.y,
                LENGTH = Math.hypot(DX, DY);
            if (!LENGTH) {
                continue;
            }
            const A_LOCAL = (-DY / LENGTH) * SIGN,
                B_LOCAL = (DX / LENGTH) * SIGN,
                C_LOCAL = -(A_LOCAL * P.x + B_LOCAL * P.y);
            scratch[length++] = A_LOCAL;
            scratch[length++] = B_LOCAL;
            scratch[length++] = C_LOCAL;
        }
    }
    if (length / 3 > maxPlanes) {
        throw new RangeError(`Clipping exceeds ${maxPlanes} edge planes`);
    }
    return intern(scratch, length);
}

/** Convex clip polygons as inward edge planes (a,b,c): inside when a*x+b*y+c >= 0. One definition for every renderer. */
export const EMPTY_CLIP = Object.freeze({
    key: '',
    values: null,
    count: 0,
});

export function clipPlanes(clips, maxPlanes) {
    if (!clips?.length) {
        return EMPTY_CLIP;
    }
    const VALUES = [],
        KEY = [];
    for (const POLYGON of clips) {
        if (
            !Array.isArray(POLYGON) ||
            POLYGON.length < 3 ||
            POLYGON.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))
        ) {
            throw new TypeError('Finite convex clip polygons required');
        }
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i],
                Q = POLYGON[(i + 1) % POLYGON.length];
            area += P.x * Q.y - Q.x * P.y;
        }
        if (Math.abs(area) < 1e-12) {
            return {
                key: 'empty',
                values: [0, 0, -1],
                count: 1,
            };
        }
        const SIGN = area >= 0 ? 1 : -1;
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
            VALUES.push(A_LOCAL, B_LOCAL, C_LOCAL);
            KEY.push(A_LOCAL, B_LOCAL, C_LOCAL);
        }
    }
    if (VALUES.length / 3 > maxPlanes) {
        throw new RangeError(`Clipping exceeds ${maxPlanes} edge planes`);
    }
    return {
        key: KEY.join(','),
        values: VALUES,
        count: VALUES.length / 3,
    };
}

/** Shared validation for the two native atlas-quad submission layouts. */
export function validateQuads({
    layer,
    uvRects,
    localRects,
    matrix = [1, 0, 0, 1, 0, 0],
    color = [1, 1, 1, 1],
    alpha = 1,
    filter = 'linear',
    parts = null,
    pose = null,
} = {}) {
    const COUNT = uvRects?.length / 4;
    if (
        !Number.isSafeInteger(layer) ||
        layer < 0 ||
        !Number.isInteger(COUNT) ||
        COUNT < 1 ||
        localRects?.length !== COUNT * 4 ||
        matrix.length !== 6 ||
        (filter !== 'linear' && filter !== 'nearest')
    ) {
        throw new TypeError('drawQuads requires a layer and matching uvRects and localRects');
    }
    for (const LIST of [uvRects, localRects, matrix]) {
        for (let i = 0; i < LIST.length; i++) {
            if (!Number.isFinite(LIST[i])) {
                throw new TypeError('drawQuads value must be finite');
            }
        }
    }
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError('alpha must be in [0,1]');
    }
    if (!color || color.length !== 4 || Array.from(color).some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new TypeError('RGBA channels must be in [0,1]');
    }
    if (parts !== null && pose === null) {
        throw new TypeError('parts require a pose');
    }
}

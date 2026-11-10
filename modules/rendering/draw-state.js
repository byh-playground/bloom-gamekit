/** Numeric draw-state codes and shared policy objects, so batches compare integers and draws reuse frozen policies. */
const DEPTH_FUNCTION_NAMES = Object.freeze([
    'never',
    'less',
    'equal',
    'lequal',
    'greater',
    'notequal',
    'gequal',
    'always',
]);
export const DEPTH_FUNCTION_CODES = new Map(DEPTH_FUNCTION_NAMES.map((name, code) => [name, code]));
const BLEND_NAMES = Object.freeze(['source-over', 'lighter', 'straight-alpha', 'copy', 'source-in', 'destination-in']);
const BLEND_CODES = new Map(BLEND_NAMES.map((name, code) => [name, code]));
/**
 * Depth state as one integer below 32: bit 0 depth test, bit 1 depth write, bits 2..4 the depth function code (0..7).
 * An unknown function name has no code; callers validate names before asking for a code.
 */
export function depthStateCode(test, write, func) {
    return (test ? 1 : 0) + (write ? 2 : 0) + DEPTH_FUNCTION_CODES.get(func) * 4;
}
/** Depth state code plus the blend code (0..5) times 32: below 192, so it fits in 8 bits. */
export function blendDepthStateCode(test, write, func, blend) {
    return depthStateCode(test, write, func) + BLEND_CODES.get(blend) * 32;
}
/** The device depth policy of each depth state code, one frozen object per code. */
export const DEPTH_POLICIES = Object.freeze(
    Array.from({ length: 32 }, (_, code) =>
        Object.freeze({ test: (code & 1) === 1, write: (code & 2) === 2, func: DEPTH_FUNCTION_NAMES[code >> 2] }),
    ),
);
// Stencil-equal policies by reference value (0..255), created when first used.
const STENCIL_EQUAL = new Array(256).fill(null);
export function stencilEqual(ref) {
    return (STENCIL_EQUAL[ref] ??= Object.freeze({ func: 'equal', ref, mask: 255, writeMask: 0, pass: 'keep' }));
}
/** Whether every value of `values` equals the same index of `other`. */
export function sameValues(values, other) {
    for (let i = 0; i < values.length; i++) {
        if (values[i] !== other[i]) {
            return false;
        }
    }
    return true;
}
/** Whether every value of `values` equals the stored Float32 copy after rounding to Float32. */
export function sameFloat32(values, stored) {
    for (let i = 0; i < values.length; i++) {
        if (Math.fround(values[i]) !== stored[i]) {
            return false;
        }
    }
    return true;
}

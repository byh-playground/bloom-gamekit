// Shared defaults for callers that want a named subdivision preset.
export const VECTOR_ASSET_QUALITY_PRESETS = Object.freeze({
    standard: Object.freeze({
        curveSegments: 4,
        strokeArcDivisions: 2,
    }),
    smallAsset: Object.freeze({
        curveSegments: 2,
        strokeArcDivisions: 2,
    }),
});

// The data contract of mesh materials, shared by the vector-assets compiler (which writes it) and the mesh renderer
// (which uploads it). No GL and no shader source.
/** Per-vertex material kind (first material float). 0 is an ordinary mesh vertex. */
export const MATERIAL_KIND = Object.freeze({ none: 0, yarnFill: 1, yarnEdge: 2, sketchFill: 3, sketchEdge: 4 });
/** One surface of the material table is five vec4: bounds, then the four effect vectors. */
export const MATERIAL_RECORD_FLOATS = 20;
export const MAX_MATERIAL_SURFACES = 16;

/** The five vec4 the fragment shader reads for one surface: bounds, effect0..effect3. */
export function materialRecord(style, bounds, contourLength) {
    const YARN = style.kind === 'yarn';
    const STITCH_PATTERN = style.pattern !== false;
    const EFFECT0 = YARN
        ? [style.seed, style.stitchWidth, style.stitchHeight, (STITCH_PATTERN ? 1 : -1) * style.thickness]
        : [style.seed, style.periodMs, style.frequency, 0];
    const EFFECT1 = YARN
        ? [style.irregularity, style.contrast, style.edgeSpacing, style.edgeWidth]
        : [style.amplitude, 0, style.echoWidth, style.echoOpacity];
    const EFFECT2 = YARN
        ? [style.fiberSpacing ?? 4, style.fiberLength, style.fiberWidth, style.fiberOpacity]
        : [style.hatchWidth, style.hatchOpacity, style.hatchAngle, style.hatchSpacing];
    const EFFECT3 = YARN
        ? [
              style.fiber === false ? 0 : style.fiberMax,
              contourLength,
              style.curved === false ? 0 : 1,
              style.edgeRelief * (style.detail ? 0.3 : 1),
          ]
        : [0, 0, 0, 0];
    return Float32Array.from([...bounds, ...EFFECT0, ...EFFECT1, ...EFFECT2, ...EFFECT3]);
}

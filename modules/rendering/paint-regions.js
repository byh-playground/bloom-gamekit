export const MAX_PAINT_REGIONS = 8;

export function validatePaintRegionName(name) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
        throw new TypeError('A paint region requires a stable name');
    }
    return name;
}

export function validatePaintRegionData(data, vertexCount, indices) {
    if (data === undefined) {
        return;
    }
    if (
        !data ||
        Object.keys(data).length !== 2 ||
        !Array.isArray(data.names) ||
        !data.names.length ||
        data.names.length > MAX_PAINT_REGIONS ||
        new Set(data.names).size !== data.names.length ||
        !(data.indices instanceof Uint16Array) ||
        data.indices.length !== vertexCount
    ) {
        throw new TypeError('Named paint regions require 1..8 unique names and one Uint16 index per vertex');
    }
    data.names.forEach(validatePaintRegionName);
    if (data.indices.some((index) => index > data.names.length)) {
        throw new RangeError('Vertex paint region index exceeds its names');
    }
    // Interpolating between material ids across a triangle would recolour unrelated pixels.
    for (let offset = 0; offset < (indices?.length ?? vertexCount); offset += 3) {
        const A = data.indices[indices?.[offset] ?? offset],
            B = data.indices[indices?.[offset + 1] ?? offset + 1],
            C = data.indices[indices?.[offset + 2] ?? offset + 2];
        if (A !== B || A !== C) {
            throw new TypeError('A painted triangle must belong to one region');
        }
    }
}

// RGB replacement only: original vertex alpha and all later tint/opacity/flash stages survive.
export function packPaintRegions(names, overrides, output) {
    output.fill(0);
    if (overrides === null || overrides === undefined) {
        return output;
    }
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new TypeError('paintRegions must be a name-to-RGB object or null');
    }
    for (const NAME in overrides) {
        if (!Object.hasOwn(overrides, NAME)) {
            continue;
        }
        const RGB = overrides[NAME];
        const INDEX = names.indexOf(NAME);
        if (INDEX < 0) {
            throw new TypeError('Unknown paint region: ' + NAME);
        }
        if (
            !(Array.isArray(RGB) || RGB instanceof Float32Array) ||
            RGB.length !== 3 ||
            !Number.isFinite(RGB[0]) ||
            RGB[0] < 0 ||
            RGB[0] > 1 ||
            !Number.isFinite(RGB[1]) ||
            RGB[1] < 0 ||
            RGB[1] > 1 ||
            !Number.isFinite(RGB[2]) ||
            RGB[2] < 0 ||
            RGB[2] > 1
        ) {
            throw new RangeError('Paint region RGB must contain three finite channels in [0,1]');
        }
        const AT = (INDEX + 1) * 4;
        output.set(RGB, AT);
        output[AT + 3] = 1;
    }
    return output;
}

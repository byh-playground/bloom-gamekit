/** @typedef {'number'|'angle'|'discrete'} FieldKind */
/** @typedef {Record<string, FieldKind>} Schema */
/** Validate and privately copy the small declaration, never an entity snapshot. */
export function compileSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new TypeError('schema must be an object');
    }
    const FIELDS = Object.entries(schema);
    if (!FIELDS.length) {
        throw new TypeError('schema must declare at least one field');
    }
    for (const [NAME, KIND] of FIELDS) {
        if (['__proto__', 'prototype', 'constructor'].includes(NAME)) {
            throw new TypeError('unsafe field name');
        }
        if (!['number', 'angle', 'discrete'].includes(KIND)) {
            throw new TypeError(`unknown kind: ${KIND}`);
        }
    }
    return FIELDS;
}
export function finite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be finite`);
    }
    return value;
}
/**
 * 표시 시계는 되돌아가지 않습니다. 과거 시각은 크기와 상관없이 지금 표시 시계(current)로 읽습니다.
 * 틱 예정 시각은 표시 시계보다 얼마든지 과거일 수 있어(밀린 틱을 오래된 것부터 처리) 거리로 시계 오용을 가리지 않습니다.
 */
export function displayClock(current, nowMs) {
    return Math.max(current, finite(nowMs, 'nowMs'));
}
export function ordinal(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a nonnegative safe integer`);
    }
    return value;
}
export function readValues(fields, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new TypeError('values must be an object');
    }
    return fields.map(([name, kind]) => {
        if (!Object.hasOwn(values, name)) {
            throw new TypeError(`missing field: ${name}; sparse patches are not supported`);
        }
        const VALUE = values[name];
        if (kind !== 'discrete') {
            return finite(VALUE, name);
        }
        if (VALUE !== null && !['string', 'boolean', 'number'].includes(typeof VALUE)) {
            throw new TypeError(`${name} must be a scalar`);
        }
        if (typeof VALUE === 'number') {
            finite(VALUE, name);
        }
        return VALUE;
    });
}

/** Validate the optional field reset mask without retaining caller-owned arrays. */
export function readResetFields(indices, names) {
    if (names === undefined) {
        return null;
    }
    if (!Array.isArray(names)) {
        throw new TypeError('resetFields must be an array');
    }
    const RESET = new Set();
    for (const NAME of names) {
        if (typeof NAME !== 'string' || !indices.has(NAME)) {
            throw new TypeError('resetFields must name declared fields');
        }
        const INDEX = indices.get(NAME);
        if (RESET.has(INDEX)) {
            throw new TypeError('duplicate resetFields field');
        }
        RESET.add(INDEX);
    }
    return RESET;
}

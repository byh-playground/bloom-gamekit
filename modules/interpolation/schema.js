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
// 받은 시각이 표시 시계보다 이만큼 넘게 과거면 다른 시계(단위 착오, Date.now 등)를 섞은 것으로 보고 던집니다.
// RAF timestamp가 직전 호출보다 과거인 정상 차이는 주 스레드가 막힌 시간 이내입니다.
export const CLOCK_REGRESSION_LIMIT_MS = 10000;
/** 표시 시계는 되돌아가지 않습니다. 과거 시각은 지금 표시 시계(current)로 읽습니다. */
export function displayClock(current, nowMs) {
    if (finite(nowMs, 'nowMs') < current - CLOCK_REGRESSION_LIMIT_MS) {
        throw new RangeError('presentation clock went backwards by more than ' + CLOCK_REGRESSION_LIMIT_MS + ' ms');
    }
    return Math.max(current, nowMs);
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

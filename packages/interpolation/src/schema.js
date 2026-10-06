/** @typedef {'number'|'angle'|'discrete'} FieldKind */
/** @typedef {Record<string, FieldKind>} Schema */
/** Validate and privately copy the small declaration, never an entity snapshot. */
export function compileSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('schema must be an object');
  const fields = Object.entries(schema);
  if (!fields.length) throw new TypeError('schema must declare at least one field');
  for (const [name, kind] of fields) {
    if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('unsafe field name');
    if (!['number', 'angle', 'discrete'].includes(kind)) throw new TypeError(`unknown kind: ${kind}`);
  }
  return fields;
}
export function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}
export function ordinal(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}
export function readValues(fields, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('values must be an object');
  return fields.map(([name, kind]) => {
    if (!Object.hasOwn(values, name)) throw new TypeError(`missing field: ${name}; sparse patches are not supported`);
    const value = values[name];
    if (kind !== 'discrete') return finite(value, name);
    if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw new TypeError(`${name} must be a scalar`);
    if (typeof value === 'number') finite(value, name);
    return value;
  });
}

/** Validate the optional field reset mask without retaining caller-owned arrays. */
export function readResetFields(indices, names) {
  if (names === undefined) return null;
  if (!Array.isArray(names)) throw new TypeError('resetFields must be an array');
  const reset = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !indices.has(name)) throw new TypeError('resetFields must name declared fields');
    const index = indices.get(name);
    if (reset.has(index)) throw new TypeError('duplicate resetFields field');
    reset.add(index);
  }
  return reset;
}

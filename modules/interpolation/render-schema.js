import { RenderObject } from './render-object.js';
import { fieldKind, compileFieldPolicies } from './render-policies.js';

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const cache = new WeakMap();
const arrayKey = /^(0|[1-9][0-9]*)$/;

/** STEP는 원본 참조가 아닌 분리된 plain-data 표본입니다. getter와 순환 그래프는 거부합니다. */
export function copyRenderData(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Render STEP requires finite scalar or plain data');
  }
  if (seen.has(value)) throw new TypeError('Render STEP cannot contain cycles; use an entity ID');
  seen.add(value);
  const result = Array.isArray(value) ? new Array(value.length) : {};
  for (const key of Object.keys(value)) {
    if (unsafe.has(key)) throw new TypeError('Unsafe render data key: ' + key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Render data accessors are not supported');
    result[key] = copyRenderData(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}

function dataAt(source, key) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Render fields must be data properties: ' + key);
  return descriptor.value;
}

/** 타입당 한 번 점 경로를 트리로 해석합니다. 상속 스키마는 같은 경로에서 하위 타입이 우선합니다. */
export function compileRenderSchema(type) {
  if (typeof type !== 'function' || (type !== RenderObject && !(type.prototype instanceof RenderObject))) {
    throw new TypeError('Render type must extend RenderObject');
  }
  if (cache.has(type)) return cache.get(type);
  const merged = {};
  const chain = [];
  for (let current = type; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) chain.unshift(current);
  for (const current of chain) {
    if (!Object.hasOwn(current, 'renderSchema')) continue;
    const declaration = Object.getOwnPropertyDescriptor(current, 'renderSchema');
    if (!Object.hasOwn(declaration, 'value')) throw new TypeError('renderSchema cannot be an accessor');
    const schema = declaration.value;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('renderSchema must be a field-path map');
    for (const name of Object.keys(schema)) {
      const descriptor = Object.getOwnPropertyDescriptor(schema, name);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('renderSchema cannot contain accessors');
      Object.defineProperty(merged, name, { value: descriptor.value, enumerable: true, configurable: true });
    }
  }
  const fields = [], nodes = [], indices = new Map(), root = { children: new Map() };
  for (const [name, code] of Object.entries(merged)) {
    const path = name.split('.');
    if (path.some(key => !key || unsafe.has(key))) throw new TypeError('Unsafe or empty render path: ' + name);
    if (!Number.isInteger(code) || !fieldKind(code)) throw new TypeError('Unknown render interpolation: ' + name);
    let node = root;
    for (const key of path) {
      if (node.field !== undefined) throw new TypeError('Overlapping render paths: ' + name);
      if (!node.children.has(key)) {
        const child = { key, children: new Map(), index: nodes.length, parent: node };
        node.children.set(key, child); nodes.push(child);
      }
      node = node.children.get(key);
    }
    if (node.children.size) throw new TypeError('Overlapping render paths: ' + name);
    node.field = fields.length;
    indices.set(name, fields.length);
    fields.push(Object.freeze({ name, code, kind: fieldKind(code), path: Object.freeze(path), owner: node.parent }));
  }
  if (!fields.length) throw new TypeError('renderSchema must declare at least one field');
  const policies = compileFieldPolicies(root, fields);
  const plan = { fields: Object.freeze(fields), indices, root, nodes, policies };
  cache.set(type, plan);
  return plan;
}

/** 누락·null 부모와 배열 구조를 기록합니다. 없는 숫자를 0으로 바꾸지 않습니다. */
export function captureRenderData(plan, source) {
  if (!source || typeof source !== 'object') throw new TypeError('Render source must be an object');
  const values = new Array(plan.fields.length), shapes = new Array(plan.nodes.length);
  function visit(node, value) {
    if (node.field !== undefined) {
      const field = plan.fields[node.field];
      if (value == null) values[node.field] = value;
      else if (field.kind === 'discrete') {
        if (field.code === RenderObject.STATE_KEY && !['number', 'boolean', 'string'].includes(typeof value)) throw new TypeError('STATE_KEY requires a scalar: ' + field.name);
        values[node.field] = copyRenderData(value);
      }
      else {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Render field must be finite: ' + field.name);
        if (field.code === RenderObject.CYCLE && (value < 0 || value > 1)) throw new RangeError('Render CYCLE requires 0..1: ' + field.name);
        if ((field.code === RenderObject.COUNTDOWN_MS || field.code === RenderObject.COUNTDOWN_SECONDS) && value < 0) throw new RangeError('Render countdown must be nonnegative: ' + field.name);
        values[node.field] = value;
      }
      return;
    }
    if (value == null) {
      shapes[node.index] = value;
      return;
    }
    if (typeof value !== 'object') throw new TypeError('Render parent must be an object: ' + node.key);
    shapes[node.index] = Array.isArray(value) ? value.length : -1;
    for (const child of node.children.values()) {
      if (Array.isArray(value) && child.key === 'length') throw new TypeError('Array length belongs to render structure, not a field');
      visit(child, dataAt(value, child.key));
    }
  }
  for (const node of plan.root.children.values()) visit(node, dataAt(source, node.key));
  return { values, shapes };
}

/** 명시적인 고정 이벤트 anchor용 표본입니다. 생존 객체의 보간 fallback으로 사용하지 않습니다. */
export function snapshotRenderModel(type, source) {
  const plan = compileRenderSchema(type), data = captureRenderData(plan, source);
  return writeRenderModel(plan, {}, data.values, data.shapes);
}

/** 모델에만 씁니다. 원본 prototype/메서드/숨은 필드를 렌더에 전달하지 않습니다. */
export function writeRenderModel(plan, model, values, shapes) {
  function visit(parent, node) {
    const { key } = node;
    if (node.field !== undefined) {
      const value = values[node.field];
      if (value === undefined) delete parent[key];
      else parent[key] = plan.fields[node.field].kind === 'discrete' ? reuseData(parent[key], value) : value;
      return;
    }
    const shape = shapes[node.index];
    if (shape === undefined) { delete parent[key]; return; }
    if (shape === null) { parent[key] = null; return; }
    const array = shape >= 0;
    let target = parent[key];
    if (!target || typeof target !== 'object' || Array.isArray(target) !== array) target = parent[key] = array ? [] : {};
    if (array) target.length = shape;
    for (const child of node.children.values()) {
      if (!array || !arrayKey.test(child.key) || Number(child.key) < shape) visit(target, child);
    }
  }
  for (const node of plan.root.children.values()) visit(model, node);
  return model;
}

function reuseData(out, value) {
  if (value === null || typeof value !== 'object') return value;
  const array = Array.isArray(value);
  if (!out || typeof out !== 'object' || Array.isArray(out) !== array) out = array ? [] : {};
  for (const key of Object.keys(out)) if (!Object.hasOwn(value, key)) delete out[key];
  if (array) out.length = value.length;
  for (const key of Object.keys(value)) out[key] = reuseData(out[key], value[key]);
  return out;
}

import { pathPlan } from './path.js';
import { RenderObject } from './render-object.js';
import { fieldKind, compileFieldPolicies } from './render-policies.js';
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const CACHE = new WeakMap();
// What writeRenderModel last wrote into each reused model: {plan, values, shapes}. Callers never edit models (README),
// so a model still holds exactly these values and a later write only needs the fields that changed.
const WRITTEN = new WeakMap();
const ARRAY_KEY = /^(0|[1-9][0-9]*)$/;

/** STEP는 원본 참조가 아닌 분리된 plain-data 표본입니다. getter와 순환 그래프는 거부합니다. */
export function copyRenderData(value, seen) {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (
        typeof value !== 'object' ||
        (!Array.isArray(value) &&
            Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null)
    ) {
        throw new TypeError('Render STEP requires finite scalar or plain data');
    }
    // Scalars need no cycle graph. Allocate it only for the first compound value.
    if (seen === undefined) {
        seen = new Set();
    }
    if (seen.has(value)) {
        throw new TypeError('Render STEP cannot contain cycles; use an entity ID');
    }
    seen.add(value);
    const RESULT = Array.isArray(value) ? new Array(value.length) : {};
    for (const KEY of Object.keys(value)) {
        if (UNSAFE.has(KEY)) {
            throw new TypeError('Unsafe render data key: ' + KEY);
        }
        const DESCRIPTOR = Object.getOwnPropertyDescriptor(value, KEY);
        if (!Object.hasOwn(DESCRIPTOR, 'value')) {
            throw new TypeError('Render data accessors are not supported');
        }
        RESULT[KEY] = copyRenderData(DESCRIPTOR.value, seen);
    }
    seen.delete(value);
    return RESULT;
}
// Which declared children of each source parent have been seen as own data properties: {node, checked: Uint8Array}.
// A descriptor allocation per field per capture dominated crowd captures, so each field of each source object is
// checked once, when it first exists; later reads are an own-property test and a plain read.
const CHECKED = new WeakMap();
function checkedFields(object, node) {
    let entry = CHECKED.get(object);
    if (entry?.node !== node) {
        entry = { node, checked: new Uint8Array(node.list.length) };
        CHECKED.set(object, entry);
    }
    return entry.checked;
}
// Same result as dataAt: undefined when not an own property, an accessor rejected the first time the field exists.
function fieldAt(object, key, checked, index) {
    if (!Object.hasOwn(object, key)) {
        return undefined;
    }
    if (!checked[index]) {
        dataAt(object, key);
        checked[index] = 1;
    }
    return object[key];
}
function dataAt(source, key) {
    const DESCRIPTOR = Object.getOwnPropertyDescriptor(source, key);
    if (!DESCRIPTOR) {
        return undefined;
    }
    if (!Object.hasOwn(DESCRIPTOR, 'value')) {
        throw new TypeError('Render fields must be data properties: ' + key);
    }
    return DESCRIPTOR.value;
}

/** 타입당 한 번 점 경로를 트리로 해석합니다. 상속 스키마는 같은 경로에서 하위 타입이 우선합니다. */
export function compileRenderSchema(type) {
    if (typeof type !== 'function' || (type !== RenderObject && !(type.prototype instanceof RenderObject))) {
        throw new TypeError('Render type must extend RenderObject');
    }
    if (CACHE.has(type)) {
        return CACHE.get(type);
    }
    const MERGED = {};
    const CHAIN = [];
    for (let current = type; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
        CHAIN.unshift(current);
    }
    for (const CURRENT of CHAIN) {
        if (!Object.hasOwn(CURRENT, 'renderSchema')) {
            continue;
        }
        const DECLARATION = Object.getOwnPropertyDescriptor(CURRENT, 'renderSchema');
        if (!Object.hasOwn(DECLARATION, 'value')) {
            throw new TypeError('renderSchema cannot be an accessor');
        }
        const SCHEMA = DECLARATION.value;
        if (!SCHEMA || typeof SCHEMA !== 'object' || Array.isArray(SCHEMA)) {
            throw new TypeError('renderSchema must be a field-path map');
        }
        for (const NAME of Object.keys(SCHEMA)) {
            const DESCRIPTOR = Object.getOwnPropertyDescriptor(SCHEMA, NAME);
            if (!Object.hasOwn(DESCRIPTOR, 'value')) {
                throw new TypeError('renderSchema cannot contain accessors');
            }
            Object.defineProperty(MERGED, NAME, {
                value: DESCRIPTOR.value,
                enumerable: true,
                configurable: true,
            });
        }
    }
    const FIELDS = [],
        NODES = [],
        INDICES = new Map(),
        ROOT = {
            children: new Map(),
        };
    for (const [NAME, CODE] of Object.entries(MERGED)) {
        const PATH = NAME.split('.');
        if (PATH.some((key) => !key || UNSAFE.has(key))) {
            throw new TypeError('Unsafe or empty render path: ' + NAME);
        }
        if (!Number.isInteger(CODE) || !fieldKind(CODE)) {
            throw new TypeError('Unknown render interpolation: ' + NAME);
        }
        let node = ROOT;
        for (const KEY of PATH) {
            if (node.field !== undefined) {
                throw new TypeError('Overlapping render paths: ' + NAME);
            }
            if (!node.children.has(KEY)) {
                const CHILD = {
                    key: KEY,
                    children: new Map(),
                    index: NODES.length,
                    parent: node,
                };
                node.children.set(KEY, CHILD);
                NODES.push(CHILD);
            }
            node = node.children.get(KEY);
        }
        if (node.children.size) {
            throw new TypeError('Overlapping render paths: ' + NAME);
        }
        node.field = FIELDS.length;
        INDICES.set(NAME, FIELDS.length);
        FIELDS.push(
            Object.freeze({
                name: NAME,
                code: CODE,
                kind: fieldKind(CODE),
                path: Object.freeze(PATH),
                owner: node.parent,
            }),
        );
    }
    if (!FIELDS.length) {
        throw new TypeError('renderSchema must declare at least one field');
    }
    // Per-capture walks read these plain arrays and precomputed flags instead of iterating Maps and testing keys.
    for (const NODE of [ROOT, ...NODES]) {
        NODE.list = [...NODE.children.values()];
        NODE.arrayIndex = ARRAY_KEY.test(NODE.key ?? '') ? Number(NODE.key) : -1;
        NODE.discrete = NODE.field !== undefined && FIELDS[NODE.field].kind === 'discrete';
        if (NODE !== ROOT && NODE.children.size && NODE.list.every((child) => child.field !== undefined)) {
            NODE.scalarCache = new WeakMap();
        }
    }
    const POLICIES = compileFieldPolicies(ROOT, FIELDS);
    const PATH = pathPlan(type.renderPath, INDICES);
    const PLAN = {
        path: PATH,
        fields: Object.freeze(FIELDS),
        indices: INDICES,
        root: ROOT,
        nodes: NODES,
        policies: POLICIES,
    };
    CACHE.set(type, PLAN);
    return PLAN;
}

/** 누락·null 부모와 배열 구조를 기록합니다. 없는 숫자를 0으로 바꾸지 않습니다. */
export function captureRenderData(plan, source) {
    if (!source || typeof source !== 'object') {
        throw new TypeError('Render source must be an object');
    }
    const VALUES = new Array(plan.fields.length),
        SHAPES = new Array(plan.nodes.length);
    function visit(node, value) {
        if (node.field !== undefined) {
            const FIELD = plan.fields[node.field];
            if (value == null) {
                VALUES[node.field] = value;
            } else if (node.discrete) {
                if (
                    FIELD.code === RenderObject.STATE_KEY &&
                    typeof value !== 'number' &&
                    typeof value !== 'boolean' &&
                    typeof value !== 'string'
                ) {
                    throw new TypeError('STATE_KEY requires a scalar: ' + FIELD.name);
                }
                VALUES[node.field] = copyRenderData(value);
            } else {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    throw new TypeError('Render field must be finite: ' + FIELD.name);
                }
                if (FIELD.code === RenderObject.CYCLE && (value < 0 || value > 1)) {
                    throw new RangeError('Render CYCLE requires 0..1: ' + FIELD.name);
                }
                if (
                    (FIELD.code === RenderObject.COUNTDOWN_MS || FIELD.code === RenderObject.COUNTDOWN_SECONDS) &&
                    value < 0
                ) {
                    throw new RangeError('Render countdown must be nonnegative: ' + FIELD.name);
                }
                VALUES[node.field] = value;
            }
            return;
        }
        if (value == null) {
            SHAPES[node.index] = value;
            return;
        }
        if (typeof value !== 'object') {
            throw new TypeError('Render parent must be an object: ' + node.key);
        }
        const ARRAY = Array.isArray(value),
            SCALAR_CACHE = node.scalarCache && !ARRAY && Object.isFrozen(value) ? node.scalarCache : null,
            CACHED = SCALAR_CACHE?.get(value);
        SHAPES[node.index] = ARRAY ? value.length : -1;
        const LIST = node.list;
        if (CACHED) {
            for (let index = 0; index < LIST.length; index++) {
                VALUES[LIST[index].field] = CACHED[index];
            }
            return;
        }
        const CHECKED_FIELDS = checkedFields(value, node);
        for (let index = 0; index < LIST.length; index++) {
            const CHILD = LIST[index];
            if (ARRAY && CHILD.key === 'length') {
                throw new TypeError('Array length belongs to render structure, not a field');
            }
            visit(CHILD, fieldAt(value, CHILD.key, CHECKED_FIELDS, index));
        }
        if (SCALAR_CACHE) {
            const SCALARS = LIST.map((child) => VALUES[child.field]);
            // A shallow freeze cannot protect a nested STEP object or array.
            // Only detached scalar leaves are immutable and safe to retain.
            if (SCALARS.every((item) => item === null || typeof item !== 'object')) {
                SCALAR_CACHE.set(value, SCALARS);
            }
        }
    }
    const ROOT_LIST = plan.root.list,
        ROOT_CHECKED = checkedFields(source, plan.root);
    for (let index = 0; index < ROOT_LIST.length; index++) {
        visit(ROOT_LIST[index], fieldAt(source, ROOT_LIST[index].key, ROOT_CHECKED, index));
    }
    return {
        values: VALUES,
        shapes: SHAPES,
    };
}

/** 명시적인 고정 이벤트 anchor용 표본입니다. 생존 객체의 보간 fallback으로 사용하지 않습니다. */
export function snapshotRenderModel(type, source) {
    const PLAN = compileRenderSchema(type),
        DATA = captureRenderData(PLAN, source);
    return writeRenderModel(PLAN, {}, DATA.values, DATA.shapes);
}

/** 모델에만 씁니다. 원본 prototype/메서드/숨은 필드를 렌더에 전달하지 않습니다. */
export function writeRenderModel(plan, model, values, shapes) {
    const LAST = WRITTEN.get(model);
    if (LAST?.plan === plan && sameShapes(LAST.shapes, shapes)) {
        // Same structure as the last write: every parent object exists as written, so only changed leaves are set.
        const PRIOR = LAST.values;
        for (let index = 0; index < values.length; index++) {
            const VALUE = values[index];
            if (Object.is(VALUE, PRIOR[index])) {
                continue;
            }
            PRIOR[index] = VALUE;
            const FIELD = plan.fields[index],
                PATH = FIELD.path;
            let parent = model;
            for (let depth = 0; depth < PATH.length - 1; depth++) {
                parent = parent[PATH[depth]];
            }
            const KEY = PATH[PATH.length - 1];
            if (VALUE === undefined) {
                delete parent[KEY];
            } else {
                parent[KEY] = FIELD.kind === 'discrete' ? reuseData(parent[KEY], VALUE) : VALUE;
            }
        }
        return model;
    }
    writeWholeModel(plan, model, values, shapes);
    WRITTEN.set(model, { plan, values: values.slice(), shapes: shapes.slice() });
    return model;
}
/** Rewrites only the listed numeric fields of a model whose last write had the same plan and shapes; false otherwise. */
export function writeRenderFields(plan, model, values, indices) {
    const LAST = WRITTEN.get(model);
    if (LAST?.plan !== plan) {
        return false;
    }
    const PRIOR = LAST.values;
    for (let at = 0; at < indices.length; at++) {
        const INDEX = indices[at],
            VALUE = values[INDEX];
        if (Object.is(VALUE, PRIOR[INDEX])) {
            continue;
        }
        PRIOR[INDEX] = VALUE;
        const PATH = plan.fields[INDEX].path;
        let parent = model;
        for (let depth = 0; depth < PATH.length - 1; depth++) {
            parent = parent[PATH[depth]];
        }
        parent[PATH[PATH.length - 1]] = VALUE;
    }
    return true;
}
function sameShapes(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let index = 0; index < a.length; index++) {
        if (!Object.is(a[index], b[index])) {
            return false;
        }
    }
    return true;
}
function writeWholeModel(plan, model, values, shapes) {
    function visit(parent, node) {
        const { key: KEY } = node;
        if (node.field !== undefined) {
            const VALUE = values[node.field];
            if (VALUE === undefined) {
                delete parent[KEY];
            } else {
                parent[KEY] = node.discrete ? reuseData(parent[KEY], VALUE) : VALUE;
            }
            return;
        }
        const SHAPE = shapes[node.index];
        if (SHAPE === undefined) {
            delete parent[KEY];
            return;
        }
        if (SHAPE === null) {
            parent[KEY] = null;
            return;
        }
        const ARRAY = SHAPE >= 0;
        let target = parent[KEY];
        if (!target || typeof target !== 'object' || Array.isArray(target) !== ARRAY) {
            target = parent[KEY] = ARRAY ? [] : {};
        }
        if (ARRAY) {
            target.length = SHAPE;
        }
        const LIST = node.list;
        for (let index = 0; index < LIST.length; index++) {
            // A non-index key (arrayIndex -1) is always below the shape; an index key only inside the length.
            if (!ARRAY || LIST[index].arrayIndex < SHAPE) {
                visit(target, LIST[index]);
            }
        }
    }
    const ROOT_LIST = plan.root.list;
    for (let index = 0; index < ROOT_LIST.length; index++) {
        visit(model, ROOT_LIST[index]);
    }
}
function reuseData(out, value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    const ARRAY = Array.isArray(value);
    if (!out || typeof out !== 'object' || Array.isArray(out) !== ARRAY) {
        out = ARRAY ? [] : {};
    }
    for (const KEY of Object.keys(out)) {
        if (!Object.hasOwn(value, KEY)) {
            delete out[KEY];
        }
    }
    if (ARRAY) {
        out.length = value.length;
    }
    for (const KEY of Object.keys(value)) {
        out[KEY] = reuseData(out[KEY], value[KEY]);
    }
    return out;
}

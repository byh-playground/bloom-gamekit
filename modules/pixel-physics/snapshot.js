// PixelWorld snapshot을 rollback·deterministic이 요구하는 바이트로 바꾸는 경계입니다.
// 객체 참조(엔티티·강체 핸들·조인트)는 식별자로 치환하고, 불러올 때 살아 있는 객체에 다시 연결합니다.
// 가변 시뮬레이션 상태만 저장합니다. 엔티티의 형상·콜백은 게임 소유라서 createBody로 다시 만듭니다.
import { createValueCodec } from '../deterministic/value-codec.js';
import { Body } from './core.js';

const CODEC = createValueCodec({ format: 'binary', maxBytes: 64 << 20, maxEntries: 1 << 22, maxDepth: 64 });
const TYPED = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };
const GRID_KEYS = ['g', 'life', 'u', 'awake', 'reac'];

function ref(o) {
    if (o === null || o === undefined) {
        return null;
    }
    if (o instanceof Body) {
        if (o.eid === undefined) {
            throw new Error('eid가 없는 엔티티입니다. world.bodies.push 대신 world.addEntity를 사용하세요.');
        }
        return 'e' + o.eid;
    }
    if (o.body && o.desc && typeof o.id === 'number') {
        return 'h' + o.id;
    }
    if (typeof o.id === 'number' && 'stiff' in o) {
        return 'j' + o.id;
    }
    throw new Error('snapshot이 알 수 없는 객체를 참조합니다.');
}

function packCells(cells) {
    // [{x,y,t}] → 평평한 Int32Array. 셀이 많은 강체도 값 코덱의 항목 수를 늘리지 않습니다.
    const OUT = new Int32Array(cells.length * 3);
    cells.forEach((c, i) => {
        OUT[i * 3] = c.x;
        OUT[i * 3 + 1] = c.y;
        OUT[i * 3 + 2] = c.t;
    });
    return OUT;
}

function unpackCells(flat) {
    const OUT = [];
    for (let i = 0; i < flat.length; i += 3) {
        OUT.push({ x: flat[i], y: flat[i + 1], t: flat[i + 2] });
    }
    return OUT;
}

function pack(v) {
    // undefined는 키를 생략하고 typed array는 {$, b}로 바꿔 deterministic 값 코덱이 받는 형태로 만듭니다.
    if (v === null || typeof v !== 'object') {
        return v;
    }
    if (ArrayBuffer.isView(v)) {
        const BYTES = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        return { $: v.constructor.name, b: BYTES.slice() };
    }
    if (Array.isArray(v)) {
        return v.map(pack);
    }
    const OUT = {};
    for (const KEY of Object.keys(v)) {
        if (v[KEY] !== undefined) {
            OUT[KEY] = pack(v[KEY]);
        }
    }
    return OUT;
}

function unpack(v) {
    if (v === null || typeof v !== 'object') {
        return v;
    }
    if (Array.isArray(v)) {
        return v.map(unpack);
    }
    if (typeof v.$ === 'string') {
        const TYPE = TYPED[v.$];
        if (!TYPE) {
            throw new TypeError('알 수 없는 typed array: ' + v.$);
        }
        return new TYPE(v.b.slice().buffer);
    }
    const OUT = {};
    for (const KEY of Object.keys(v)) {
        OUT[KEY] = unpack(v[KEY]);
    }
    return OUT;
}

/** 월드 전체 상태를 바이트로 만듭니다. 엔티티는 world.addEntity로 등록돼 있어야 합니다. */
export function savePixelWorld(world) {
    const S = world.snapshot();
    const OUT = { ...S, entRefs: S.entRefs.map(ref), proj: S.proj.map((p) => ({ ...p, src: ref(p.src) })) };
    OUT.ents = S.ents.map((e) => ({ ...e, _ride: ref(e._ride) }));
    if (S.bridge) {
        OUT.bridge = {
            ...S.bridge,
            bs: S.bridge.bs.map((r) => ({ ...r, h: ref(r.h), cells: r.cells && packCells(r.cells) })),
            js: S.bridge.js.map((r) => ({ ...r, j: ref(r.j), a: ref(r.a), b: ref(r.b) })),
        };
    }
    return CODEC.encode(pack(OUT));
}

function decode(world, bytes) {
    const V = unpack(CODEC.decode(bytes));
    for (const KEY of GRID_KEYS) {
        if (!(V[KEY] instanceof Uint8Array) || V[KEY].length !== world[KEY].length) {
            throw new RangeError('월드 크기나 형식이 다른 snapshot입니다: ' + KEY);
        }
    }
    if (Boolean(V.bridge) !== Boolean(world.bridge)) {
        throw new RangeError('강체 브리지 유무가 다른 snapshot입니다.');
    }
    return V;
}

/** 현재 월드를 바꾸지 않고 바이트가 이 월드에 불러올 수 있는 형태인지 확인합니다. */
export function validatePixelWorld(world, bytes) {
    try {
        decode(world, bytes);
        return true;
    } catch {
        return false;
    }
}

/**
 * 바이트에서 월드 상태를 복원합니다. 살아 있는 엔티티·핸들·조인트는 식별자로 찾아 그대로 재사용하고,
 * 없는 엔티티는 createBody(eid, state)가 만든 Body를 씁니다(형상·콜백은 게임이 소유).
 */
export function loadPixelWorld(world, bytes, { createBody } = {}) {
    const V = decode(world, bytes);
    const ENTITIES = new Map(world.bodies.map((b) => [b.eid, b]));
    const ENTITY = (id, state) => {
        let b = ENTITIES.get(id);
        if (!b) {
            if (typeof createBody !== 'function') {
                throw new Error(`엔티티 e${id}가 없습니다. createBody(eid, state)를 전달하세요.`);
            }
            b = createBody(id, state);
            if (!(b instanceof Body)) {
                throw new TypeError('createBody는 Body를 반환해야 합니다.');
            }
            b.eid = id;
            ENTITIES.set(id, b);
        }
        return b;
    };
    const HANDLES = new Map((world.bridge?.bodies ?? []).map((h) => [h.id, h]));
    const JOINTS = new Map((world.bridge?.joints ?? []).map((j) => [j.id, j]));
    const HANDLE = (id, rec) => {
        let h = HANDLES.get(id);
        if (!h) {
            h = {
                id,
                desc: rec?.desc,
                x: 0,
                y: 0,
                angle: 0,
                w: 0,
                h: 0,
                mass: 0,
                area: 0,
                vx: 0,
                vy: 0,
                av: 0,
                data: {},
                pins: [],
                _cons: [],
            };
            HANDLES.set(id, h);
        }
        return h;
    };
    const RESOLVE = (r) => {
        if (r === null || r === undefined) {
            return null;
        }
        const ID = Number(r.slice(1));
        if (r[0] === 'e') {
            return ENTITIES.get(ID) ?? ENTITY(ID, V.ents[V.entRefs.indexOf(r)]);
        }
        if (r[0] === 'h') {
            return HANDLES.get(ID) ?? HANDLE(ID);
        }
        return JOINTS.get(ID);
    };
    const S = { ...V };
    // 엔티티를 먼저 모두 만든 뒤 상호 참조를 연결합니다.
    S.entRefs = V.entRefs.map((r, i) => ENTITY(Number(r.slice(1)), V.ents[i]));
    if (V.bridge) {
        const BRIDGE = V.bridge;
        BRIDGE.bs.forEach((r) => HANDLE(Number(r.h.slice(1)), r));
        BRIDGE.js.forEach((r) => {
            const ID = Number(r.j.slice(1));
            if (!JOINTS.has(ID)) {
                JOINTS.set(ID, { id: ID, a: null, b: null, c: null });
            }
        });
        S.bridge = {
            ...BRIDGE,
            bs: BRIDGE.bs.map((r) => ({ ...r, h: RESOLVE(r.h), cells: r.cells && unpackCells(r.cells) })),
            js: BRIDGE.js.map((r) => ({ ...r, j: RESOLVE(r.j), a: RESOLVE(r.a), b: RESOLVE(r.b) })),
        };
    }
    S.proj = V.proj.map((p) => ({ ...p, src: p.src ? RESOLVE(p.src) : undefined }));
    S.ents = V.ents.map((e) => ({ ...e, _ride: RESOLVE(e._ride) }));
    world.restore(S);
}

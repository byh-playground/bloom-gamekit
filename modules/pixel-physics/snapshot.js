// PixelWorld snapshot을 rollback·deterministic이 요구하는 바이트로 바꾸는 경계입니다.
// 객체 참조(엔티티·강체 핸들·조인트)는 식별자로 치환하고, 불러올 때 살아 있는 객체에 다시 연결합니다.
// 가변 시뮬레이션 상태만 저장합니다. 엔티티의 형상·콜백은 게임 소유라서 createBody로 다시 만듭니다.
import { createValueCodec } from '../deterministic/value-codec.js';
import { Body } from './core.js';

// 격자 배열은 같은 값 구간으로 줄인 Uint8Array 한 덩어리로, 셀 집합은 Int32Array 한 덩어리로 싣습니다. undefined 키는 생략합니다.
const CODEC = createValueCodec({
    format: 'binary',
    maxBytes: 64 << 20,
    maxEntries: 1 << 22,
    maxDepth: 64,
    omitUndefined: true,
});
const GRID_KEYS = ['g', 'life', 'u', 'awake', 'reac'];
const RAW = 0,
    RUNS = 1;

/**
 * 격자 바이트를 같은 값의 연속 구간(run)으로 줄입니다: 첫 바이트가 방식(0 원본, 1 run)이고, run은
 * `[값][길이-1 (LEB128)]`의 반복입니다. 정지한 월드는 대부분 같은 값이 이어져 20~50배 줄고, 줄지 않으면 원본을 씁니다.
 * 같은 입력은 항상 같은 바이트를 냅니다(탐욕적 최대 구간).
 */
function encodeGrid(array) {
    const LIMIT = array.length;
    const OUT = new Uint8Array(LIMIT + 1);
    OUT[0] = RUNS;
    let used = 1;
    for (let i = 0; i < LIMIT;) {
        const VALUE = array[i];
        let end = i + 1;
        while (end < LIMIT && array[end] === VALUE) {
            end++;
        }
        let rest = end - i - 1;
        if (used + 2 > LIMIT) {
            used = LIMIT + 1;
            break;
        }
        OUT[used++] = VALUE;
        while (rest >= 128) {
            if (used + 1 > LIMIT) {
                used = LIMIT + 1;
                break;
            }
            OUT[used++] = (rest % 128) + 128;
            rest = Math.floor(rest / 128);
        }
        if (used > LIMIT) {
            break;
        }
        OUT[used++] = rest;
        i = end;
    }
    if (used <= LIMIT) {
        return OUT.slice(0, used);
    }
    const RAW_OUT = new Uint8Array(LIMIT + 1);
    RAW_OUT[0] = RAW;
    RAW_OUT.set(array, 1);
    return RAW_OUT;
}

/** encodeGrid의 역변환. 길이·구간·정규성(인접 구간의 값이 달라야 함)을 모두 검사합니다. */
function decodeGrid(data, length) {
    if (!(data instanceof Uint8Array) || data.length < 1) {
        throw new RangeError('격자 형식이 잘못됐습니다.');
    }
    if (data[0] === RAW) {
        if (data.length !== length + 1) {
            throw new RangeError('격자 길이가 다릅니다.');
        }
        return data.slice(1);
    }
    if (data[0] !== RUNS) {
        throw new RangeError('알 수 없는 격자 방식입니다.');
    }
    const OUT = new Uint8Array(length);
    let at = 0,
        previous = -1;
    for (let i = 1; i < data.length;) {
        const VALUE = data[i++];
        let run = 0,
            scale = 1,
            part;
        do {
            if (i >= data.length || scale > 2 ** 28) {
                throw new RangeError('격자 구간이 잘렸습니다.');
            }
            part = data[i++];
            run += (part & 127) * scale;
            scale *= 128;
        } while (part >= 128);
        if (VALUE === previous || (part === 0 && scale > 128) || at + run + 1 > length) {
            throw new RangeError('격자 구간이 비정규이거나 범위를 넘습니다.');
        }
        OUT.fill(VALUE, at, at + run + 1);
        at += run + 1;
        previous = VALUE;
    }
    if (at !== length) {
        throw new RangeError('격자 길이가 다릅니다.');
    }
    return OUT;
}

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

/** 월드 전체 상태를 바이트로 만듭니다. 엔티티는 world.addEntity로 등록돼 있어야 합니다. */
export function savePixelWorld(world) {
    const S = world.snapshot(false); // 인코더가 바로 복사하므로 격자 배열을 한 번 덜 복사합니다.
    const OUT = { ...S, entRefs: S.entRefs.map(ref), proj: S.proj.map((p) => ({ ...p, src: ref(p.src) })) };
    for (const KEY of GRID_KEYS) {
        OUT[KEY] = encodeGrid(S[KEY]);
    }
    OUT.ents = S.ents.map((e) => ({ ...e, _ride: ref(e._ride) }));
    if (S.bridge) {
        OUT.bridge = {
            ...S.bridge,
            bs: S.bridge.bs.map((r) => ({ ...r, h: ref(r.h), cells: r.cells && packCells(r.cells) })),
            js: S.bridge.js.map((r) => ({ ...r, j: ref(r.j), a: ref(r.a), b: ref(r.b) })),
        };
    }
    return CODEC.encode(OUT);
}

function decode(world, bytes) {
    const V = CODEC.decode(bytes);
    for (const KEY of GRID_KEYS) {
        V[KEY] = decodeGrid(V[KEY], world[KEY].length);
    }
    if (!Number.isFinite(V.originX) || !Number.isFinite(V.originY)) {
        throw new RangeError(
            '창 원점(originX, originY)이 없는 snapshot입니다. v0.15.0 이전 SDK에서 만든 바이트입니다.',
        );
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

// 한 틱 안의 원형 몸 접촉 풀이입니다. 몸마다 이번 틱 궤적의 가장 이른 접촉을 시간순 큐에 두고, 가장 이른 접촉의 몸만
// 그 시각까지 옮겨 응답한 뒤 그 몸과 그 몸에 접촉을 걸어 둔 몸만 다시 cast합니다. 지형(주입받은 SurfaceMotion)은 항상
// 풀고, 몸끼리의 접촉은 스텝 예산(pairBudget) 안에서만 풉니다. 예산을 넘은 쌍은 겹친 채 지나가고 separate()가 위치로
// 정리합니다. 게임 규칙(병종·피해·넉백 종류)은 모르고, 몸은 한 스텝짜리 숫자 열(SoA)입니다. 스텝 사이에 남는 상태가 없습니다.
import {
    CONTACT_USER,
    ContactHit,
    ContactList,
    SurfaceContactGeometry,
    SweptCircleContact,
    contactKey,
} from '../geometry/contact.js';
import { MotionResult } from '../geometry/surface-motion.js';
import { UniformGrid } from '../spatial/index.js';

/** 몸 열 `flags` 비트: 이번 스텝에 움직이고 지형과 닿습니다(죽었지만 궤적을 마치는 몸 포함). 스텝 안에서 바꾸지 않습니다. */
export const ACTIVE = 1;
/** 충격 속도(`ivx`·`ivy`)와 정수 잔여 변위(`rx`·`ry`)를 가진 몸. 아니면 조향 몸(속도 = 이번 틱 조향 변위 / dt). */
export const DYNAMIC = 2;
/** 몸-몸 접촉에 참여합니다. 바꾸면 그 몸의 다음 cast부터 적용됩니다. */
export const PAIRS = 4;
/** 높이로 쌍이 갈릴 수 있음: 쌍의 한쪽이라도 켜 있으면 `z`(바닥 높이)를 비교합니다. */
export const VERTICAL = 8;
/** 겹침 풀기(`separate`)에 참여합니다. */
export const SEPARATE = 16;

/** 관계 표 값: 서로 지나갑니다. */
export const PASS = 0;
/** 접촉 큐에는 넣지 않고 겹침 풀기에서 질량비로 일부만 밀어냅니다(아군). */
export const SOFT = 1;
/** 접촉 큐에 넣고 겹침 풀기에서 침투한 쪽을 완전히 밀어냅니다(적). */
export const SOLID = 2;

/** `ContactEvent.response`: 아직 응답 없음, 또는 응답했지만 바뀐 것이 없음(이미 멀어지는 쌍). */
export const RESPONSE_NONE = 0;
/** 동적 몸이 표면에서 반사(`reflect`). */
export const RESPONSE_REFLECT = 1;
/** 조향 몸이 표면이나 조향 몸을 따라 미끄러짐. */
export const RESPONSE_SLIDE = 2;
/** 쌍이 운동량을 교환(`exchange`). */
export const RESPONSE_EXCHANGE = 3;
/** 0초 반복 한도에 걸린 표면 접촉: 멈춤. */
export const RESPONSE_STOP = 4;
/** 0초 반복 한도에 걸린 쌍: 공통 속도로 붙음. */
export const RESPONSE_STICK = 5;
/** 0초 반복 한도에 걸린 쌍에서 표시한 쪽만 튕김(`bounce`). */
export const RESPONSE_BOUNCE = 6;

const OPTIONS = [
    'surface',
    'fixedPoint',
    'remainderScale',
    'pairBudget',
    'maxZeroTimeRepeats',
    'restitution',
    'cellSize',
    'softFraction',
    'softPasses',
    'hardPasses',
];
// 같은 시각으로 치는 창(초)과 cast 길이 하한. 원본(쌀콩팡 ImpulseContacts·UnitMotion)의 값 그대로입니다.
const SAME_TIME = 1e-9;
const INWARD = -1e-7;
// 대체 법선: 정수 8방향(4096 = 단위, 2896 ≈ 4096 / √2). 두 key의 FNV-1a 하위 3비트가 방향입니다.
const NORMAL_SCALE = 4096;
const NORMAL_X = Int32Array.of(4096, 2896, 0, -2896, -4096, -2896, 0, 2896);
const NORMAL_Y = Int32Array.of(0, 2896, 4096, 2896, 0, -2896, -4096, -2896);
const TWO_32 = 4294967296;
// 스텝 진행 상태.
const IDLE = 0;
const FILLING = 1;
const RUNNING = 2;
const DONE = 3;

function finitePositive(value, name) {
    if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) {
        throw new RangeError(`ContactSolver ${name} must be a positive finite number.`);
    }
    return value;
}
function integerOption(value, name, min) {
    if (!Number.isSafeInteger(value) || value < min) {
        throw new RangeError(`ContactSolver ${name} must be an integer >= ${min}.`);
    }
    return value;
}

/** 0 이상 안전 정수 두 개의 32비트 낱말 FNV-1a. 대체 법선의 방향을 고릅니다. */
export function pairHash(a, b) {
    let h = Math.imul(0x811c9dc5 ^ (a % TWO_32), 0x01000193);
    h = Math.imul(h ^ Math.floor(a / TWO_32), 0x01000193);
    h = Math.imul(h ^ (b % TWO_32), 0x01000193);
    h = Math.imul(h ^ Math.floor(b / TWO_32), 0x01000193);
    return h >>> 0;
}

/**
 * 한 스텝 동안만 쓰는 몸 열입니다. 모듈이 가지고 게임이 `begin` 뒤에 `[0, count)`를 채웁니다. 용량은 모자랄 때만
 * 두 배로 늘고 늘 때 열 객체가 바뀌므로 `begin`이 돌려준 것을 그 스텝에서 씁니다.
 */
export class ContactBodies {
    count = 0;
    capacity = 0;
    constructor() {
        this.grow(64);
    }
    grow(capacity) {
        const OLD = this.capacity;
        if (capacity <= OLD) {
            return;
        }
        const COLUMNS = [
            ['x', Int32Array],
            ['y', Int32Array],
            ['steerX', Int32Array],
            ['steerY', Int32Array],
            ['vx', Float64Array],
            ['vy', Float64Array],
            ['ivx', Float64Array],
            ['ivy', Float64Array],
            ['rx', Int32Array],
            ['ry', Int32Array],
            ['radius', Float64Array],
            ['mass', Float64Array],
            ['key', Float64Array],
            ['group', Uint8Array],
            ['z', Float64Array],
            ['softCap', Int32Array],
            ['flags', Uint8Array],
        ];
        for (const [NAME, TYPE] of COLUMNS) {
            const NEXT = new TYPE(capacity);
            if (this[NAME]) {
                NEXT.set(this[NAME]);
            }
            this[NAME] = NEXT;
        }
        this.capacity = capacity;
    }
}

/** 접촉 하나. `next`가 덮어쓰는 재사용 객체이고 게임이 하나 만들어 둡니다. */
export class ContactEvent {
    /** 접촉한 몸. */
    i = -1;
    /** 상대 몸, 표면이면 -1. 쌍은 동적 몸이 `i`(둘 다 같으면 작은 번호)입니다. */
    j = -1;
    /** j → i 방향 단위 법선(표면이면 표면 바깥쪽). */
    nx = 0;
    ny = 0;
    /** 스텝 안 시각(초). 두 몸은 이미 이 시각 위치에 있습니다. */
    t = 0;
    /** 표면 접촉의 geometry 정수 접촉 키(쌍은 0). */
    key = 0;
    /** 표면 접촉의 장애물(원 장애물 레코드, 아니면 null). */
    obstacle = null;
    /** 시간이 흐르지 않고 연속으로 같은 접촉을 만난 횟수(이 접촉 포함). 시간이 흐른 뒤 첫 접촉은 0입니다. */
    repeats = 0;
    /** `repeats >= maxZeroTimeRepeats`. 기본 응답이 멈춤(표면)·붙기(쌍)가 됩니다. */
    stuck = false;
    /** 마지막 응답(`RESPONSE_*`). `next`가 RESPONSE_NONE으로 비웁니다. */
    response = RESPONSE_NONE;
    /** `exchange`가 주고받은 충격량 J(아니면 0). */
    impulse = 0;
    /** 응답했는지(모듈 내부, 응답 없이 다음 `next`를 부르면 기본 응답을 적용). */
    handled = true;
}

/**
 * 한 스텝의 접촉 풀이입니다. 흐름: `begin(count, dt)` → 몸 열 채우기 → `while (next(ev)) { 응답 또는 resolve(ev) }` →
 * `end()` → `separate()` → 결과 읽기. 자세한 계약은 README.md.
 */
export class ContactSolver {
    /** 한 스텝에 푸는 몸-몸 접촉 수. 다음 스텝의 첫 `next`부터 적용됩니다. Infinity면 무제한. */
    pairBudget;
    /** 같은 0초 접촉 반복 한도. */
    maxZeroTimeRepeats;
    /** 기본 응답의 반발 계수(표면 반사·쌍 교환·조향 미끄러짐의 안쪽 속도 제거). */
    restitution;
    /** 지난 스텝의 계수. `begin`이 비웁니다. */
    stats = { surfaceContacts: 0, pairContacts: 0, skippedPairs: 0, casts: 0, groups: 0, softMoves: 0, hardMoves: 0 };

    #surface;
    #fp;
    #remainderScale;
    #width;
    #height;
    #cellSize;
    #softFraction;
    #softPasses;
    #hardPasses;
    #groups = 1;
    #relations = Uint8Array.of(PASS);
    #bodies = new ContactBodies();
    #state = IDLE;
    #dt = 0;
    #grid = null;
    // 격자가 지금 위치의 SEPARATE 몸을 담고 있는지. 위치가 바뀐 pass 뒤에만 다시 만듭니다.
    #separationGridFresh = false;
    // 격자 후보(몸 번호)와 개수. 몸 용량만큼 잡아 두므로 모자라지 않습니다.
    #candidates = new Int32Array(0);
    #hit = new ContactHit();
    #pairHit = new ContactHit();
    #slideList = new ContactList();
    #slideOut = { x: 0, y: 0 };
    #motion = new MotionResult();
    // 몸별 스텝 상태.
    #capacity = 0;
    #base = new Float64Array(0);
    #fracX = new Float64Array(0);
    #fracY = new Float64Array(0);
    #involved = new Int32Array(0);
    #recast = new Int32Array(0);
    #startX = new Int32Array(0);
    #startY = new Int32Array(0);
    #segX = new Int32Array(0);
    #segY = new Int32Array(0);
    #stageX = new Int32Array(0);
    #stageY = new Int32Array(0);
    #radiusFP = new Int32Array(0);
    #sumX = new Int32Array(0);
    #sumY = new Int32Array(0);
    #counts = new Int32Array(0);
    #stamp = 0;
    #speedBound = 0;
    #maxRadius = 0;
    #pairsLeft = 0;
    #now = 0;
    #elapsed = 0;
    // 접촉 기록 풀: 몸마다 가장 이른 시각(1e-9 창)의 접촉 연결 리스트.
    #poolCapacity = 0;
    #free = -1;
    #head = new Int32Array(0);
    #earliest = new Float64Array(0);
    #cT = new Float64Array(0);
    #cI = new Int32Array(0);
    #cJ = new Int32Array(0);
    #cNx = new Float64Array(0);
    #cNy = new Float64Array(0);
    #cKey = new Float64Array(0);
    #cSortA = new Float64Array(0);
    #cSortB = new Float64Array(0);
    #cNext = new Int32Array(0);
    #cObstacle = [];
    // 같은 시각 묶음(안정 병합 정렬).
    #order = new Int32Array(0);
    #orderScratch = new Int32Array(0);
    #orderLength = 0;
    #cursor = 0;
    #lastI = -1;
    #lastJ = -1;
    #pending = null;
    // 0초 반복 횟수: (몸 또는 작은 번호, 접촉 키 또는 -(큰 번호 + 1)) → 횟수. 열린 주소 해시, 세대 표식으로 비움.
    #repeatA = new Int32Array(0);
    #repeatB = new Float64Array(0);
    #repeatCount = new Int32Array(0);
    #repeatEpoch = new Uint32Array(0);
    #repeatEpochNow = 1;
    #repeatUsed = 0;
    // 겹침 풀기의 쌍 목록(정렬한 정수 키)과 병합 정렬 버퍼.
    #pairs = new Float64Array(0);
    #pairsScratch = new Float64Array(0);

    /**
     * @param {object} options
     * @param {import('../geometry/surface-motion.js').SurfaceMotion} options.surface 지형·건물·맵 경계(게임이 가진 것).
     *   `cast`·`solve`와 `field.width/height`만 씁니다. 체크포인트(`remember`/`constrain`)는 건드리지 않습니다.
     * @param {number} options.fixedPoint 위치 격자 배율(1/fixedPoint). 위치 열은 이 단위의 정수입니다.
     * @param {number} options.remainderScale 동적 몸 잔여 변위의 정수 배율(1/remainderScale 격자 칸).
     * @param {number} options.pairBudget 한 스텝에 푸는 몸-몸 접촉 수(0 이상 정수 또는 Infinity).
     * @param {number} options.maxZeroTimeRepeats 같은 0초 접촉 반복 한도(1 이상).
     * @param {number} [options.restitution] 기본 응답의 반발 계수(기본 0).
     * @param {number} options.cellSize 후보 격자 칸 한 변(월드 단위). 결과에는 영향이 없고 비용만 바뀝니다.
     * @param {number} [options.softFraction] SOFT 겹침 풀기에서 한 pass에 푸는 침투 비율(기본 0.8).
     * @param {number} [options.softPasses] SOFT 겹침 풀기 최대 pass(기본 4, 움직임이 없으면 멈춤).
     * @param {number} [options.hardPasses] SOLID 겹침 풀기 최대 pass(기본 4, 움직임이 없으면 멈춤).
     */
    constructor(options) {
        if (options === null || typeof options !== 'object') {
            throw new TypeError('ContactSolver options must be an object.');
        }
        for (const KEY of Object.keys(options)) {
            if (!OPTIONS.includes(KEY)) {
                throw new TypeError(`ContactSolver has an unknown option: ${KEY}`);
            }
        }
        const SURFACE = options.surface;
        if (!SURFACE || typeof SURFACE.cast !== 'function' || typeof SURFACE.solve !== 'function' || !SURFACE.field) {
            throw new TypeError('ContactSolver surface must be a geometry SurfaceMotion.');
        }
        this.#surface = SURFACE;
        this.#fp = integerOption(options.fixedPoint, 'fixedPoint', 1);
        this.#remainderScale = integerOption(options.remainderScale, 'remainderScale', 1);
        this.#width = SURFACE.field.width;
        this.#height = SURFACE.field.height;
        this.#cellSize = finitePositive(options.cellSize, 'cellSize');
        this.pairBudget = options.pairBudget;
        this.#checkBudget();
        this.maxZeroTimeRepeats = integerOption(options.maxZeroTimeRepeats, 'maxZeroTimeRepeats', 1);
        this.restitution = options.restitution ?? 0;
        if (!(this.restitution >= 0) || !Number.isFinite(this.restitution)) {
            throw new RangeError('ContactSolver restitution must be a finite number >= 0.');
        }
        this.#softFraction = options.softFraction ?? 0.8;
        if (!(this.#softFraction > 0 && this.#softFraction <= 1)) {
            throw new RangeError('ContactSolver softFraction must be in (0, 1].');
        }
        this.#softPasses = integerOption(options.softPasses ?? 4, 'softPasses', 0);
        this.#hardPasses = integerOption(options.hardPasses ?? 4, 'hardPasses', 0);
        // 후보 격자는 위치 열과 같은 정수 격자 단위입니다(넣기·질의 좌표가 정수라 부동소수 인자를 만들지 않습니다).
        this.#grid = new UniformGrid({
            cellSize: this.#cellSize * this.#fp,
            width: this.#width * this.#fp,
            height: this.#height * this.#fp,
            outside: 'clamp',
        });
        this.#growPool(256);
        this.#growRepeats(256);
    }

    /**
     * 몸 `group` 사이의 관계 표(`groups × groups`, 행 = i의 group, 열 = j의 group)를 정합니다. 값은 PASS·SOFT·SOLID이고
     * 대칭이어야 합니다. 표는 복사합니다.
     */
    setRelations(groups, table) {
        integerOption(groups, 'relation groups', 1);
        if (groups > 256 || !table || table.length !== groups * groups) {
            throw new RangeError('ContactSolver relations need groups <= 256 and a groups × groups table.');
        }
        const COPY = new Uint8Array(groups * groups);
        for (let a = 0; a < groups; a++) {
            for (let b = 0; b < groups; b++) {
                const VALUE = table[a * groups + b];
                if (VALUE !== PASS && VALUE !== SOFT && VALUE !== SOLID) {
                    throw new RangeError('ContactSolver relation values are PASS, SOFT or SOLID.');
                }
                if (VALUE !== table[b * groups + a]) {
                    throw new RangeError('ContactSolver relations must be symmetric.');
                }
                COPY[a * groups + b] = VALUE;
            }
        }
        this.#groups = groups;
        this.#relations = COPY;
    }

    /**
     * 새 스텝을 시작하고 몸 열을 돌려줍니다. 게임은 `[0, count)`의 열을 모두 채웁니다(이전 스텝 값이 남아 있습니다).
     * @returns {ContactBodies}
     */
    begin(count, dt) {
        integerOption(count, 'count', 0);
        finitePositive(dt, 'dt');
        const BODIES = this.#bodies;
        if (BODIES.capacity < count) {
            let capacity = BODIES.capacity;
            while (capacity < count) {
                capacity *= 2;
            }
            BODIES.grow(capacity);
        }
        BODIES.count = count;
        this.#growBodies(count);
        this.#dt = dt;
        this.#state = FILLING;
        this.#pending = null;
        const STATS = this.stats;
        STATS.surfaceContacts = 0;
        STATS.pairContacts = 0;
        STATS.skippedPairs = 0;
        STATS.casts = 0;
        STATS.groups = 0;
        STATS.softMoves = 0;
        STATS.hardMoves = 0;
        return BODIES;
    }

    /** 지금 스텝의 몸 열(`begin`이 돌려준 것). */
    get bodies() {
        return this.#bodies;
    }

    /**
     * 다음 접촉을 `ev`에 쓰고 true, 더 없으면 false. 앞 접촉에 응답하지 않았으면 먼저 기본 응답(`resolve`)을 적용합니다.
     * 예산을 넘은 몸-몸 접촉은 건너뜁니다(`stats.skippedPairs`). 표면 접촉은 예산과 무관합니다.
     * @param {ContactEvent} ev
     */
    next(ev) {
        if (this.#state === FILLING) {
            this.#prepare();
        } else if (this.#state !== RUNNING) {
            if (this.#state === DONE) {
                return false;
            }
            throw new Error('ContactSolver.next needs begin() first.');
        }
        const PENDING = this.#pending;
        if (PENDING !== null && !PENDING.handled) {
            this.resolve(PENDING);
        }
        this.#pending = null;
        for (;;) {
            while (this.#cursor < this.#orderLength) {
                const C = this.#order[this.#cursor++],
                    I = this.#cI[C],
                    J = this.#cJ[C];
                if (J >= 0) {
                    // 두 몸이 모두 기록한 쌍: 한 번만 풉니다.
                    if (I === this.#lastI && J === this.#lastJ) {
                        continue;
                    }
                    this.#lastI = I;
                    this.#lastJ = J;
                    if (!(this.#pairsLeft > 0)) {
                        this.stats.skippedPairs++;
                        continue;
                    }
                    this.#pairsLeft--;
                    this.stats.pairContacts++;
                } else {
                    this.stats.surfaceContacts++;
                }
                const REPEATS = this.#elapsed <= SAME_TIME ? this.#repeat(C) : 0;
                ev.i = I;
                ev.j = J;
                ev.nx = this.#cNx[C];
                ev.ny = this.#cNy[C];
                ev.t = this.#now;
                ev.key = this.#cKey[C];
                ev.obstacle = this.#cObstacle[C];
                ev.repeats = REPEATS;
                ev.stuck = REPEATS >= this.maxZeroTimeRepeats;
                ev.response = RESPONSE_NONE;
                ev.impulse = 0;
                ev.handled = false;
                this.#pending = ev;
                return true;
            }
            if (this.#orderLength > 0) {
                this.#finishGroup();
            }
            if (!this.#startGroup()) {
                this.#state = DONE;
                return false;
            }
        }
    }

    /** 기본 응답: 표면 = 동적 몸 반사(`restitution`)·조향 몸 미끄러짐, 쌍 = 교환(조향끼리는 둘 다 미끄러짐), 한도 = 멈춤·붙기. */
    resolve(ev) {
        const FLAGS = this.#bodies.flags,
            I = ev.i,
            J = ev.j;
        if (J < 0) {
            if (ev.stuck) {
                this.#stop(ev);
            } else if (FLAGS[I] & DYNAMIC) {
                this.reflect(ev, this.restitution);
            } else {
                this.#slide(I, ev.nx, ev.ny, ev.key);
                ev.response = RESPONSE_SLIDE;
            }
        } else if (ev.stuck) {
            this.#stick(ev);
        } else if ((FLAGS[I] | FLAGS[J]) & DYNAMIC) {
            this.exchange(ev, this.restitution, 1, 1);
        } else {
            this.#slide(I, ev.nx, ev.ny, contactKey(CONTACT_USER, J));
            this.#slide(J, -ev.nx, -ev.ny, contactKey(CONTACT_USER, I));
            ev.response = RESPONSE_SLIDE;
        }
        ev.handled = true;
    }

    /** 접근 속도(양수면 다가옴): 표면은 -(v_i · n), 쌍은 -((v_i - v_j) · n). 응답 전에 읽습니다. */
    closing(ev) {
        const B = this.#bodies,
            I = ev.i,
            J = ev.j;
        return J < 0
            ? -(B.vx[I] * ev.nx + B.vy[I] * ev.ny)
            : -((B.vx[I] - B.vx[J]) * ev.nx + (B.vy[I] - B.vy[J]) * ev.ny);
    }

    /**
     * 쌍의 반발 `restitution` 운동량 교환. 조향 몸은 그 자리에서 동적 몸으로 바뀝니다(지금 속도를 충격 속도로 잡고 잔여
     * 변위를 넘김). 맞은 쪽 충격량에 `gainI`·`gainJ`를 곱합니다. 주고받은 충격량 J를 돌려주고, 이미 멀어지는 쌍이면
     * 아무것도 바꾸지 않고 0입니다.
     */
    exchange(ev, restitution, gainI = 1, gainJ = 1) {
        const B = this.#bodies,
            I = ev.i,
            J = ev.j,
            NX = ev.nx,
            NY = ev.ny;
        ev.handled = true;
        const VIX = B.vx[I],
            VIY = B.vy[I],
            VJX = B.vx[J],
            VJY = B.vy[J],
            RELATIVE = (VIX - VJX) * NX + (VIY - VJY) * NY;
        if (RELATIVE >= 0) {
            ev.response = RESPONSE_NONE;
            ev.impulse = 0;
            return 0;
        }
        const HAD_I = (B.flags[I] & DYNAMIC) !== 0,
            HAD_J = (B.flags[J] & DYNAMIC) !== 0;
        this.#setImpact(I, VIX, VIY);
        this.#setImpact(J, VJX, VJY);
        const IMPULSE = (-(1 + restitution) * RELATIVE) / (1 / B.mass[I] + 1 / B.mass[J]);
        this.#push(I, IMPULSE * NX * gainI, IMPULSE * NY * gainI);
        this.#push(J, -IMPULSE * NX * gainJ, -IMPULSE * NY * gainJ);
        if (!HAD_I) {
            this.#takeRemainder(I);
        }
        if (!HAD_J) {
            this.#takeRemainder(J);
        }
        B.vx[I] = B.ivx[I] / this.#fp;
        B.vy[I] = B.ivy[I] / this.#fp;
        B.vx[J] = B.ivx[J] / this.#fp;
        B.vy[J] = B.ivy[J] / this.#fp;
        ev.response = RESPONSE_EXCHANGE;
        ev.impulse = IMPULSE;
        return IMPULSE;
    }

    /** 동적 몸 `i`의 표면 반사: 충격 속도를 지금 속도로 맞춘 뒤 안쪽 성분을 `restitution`으로 되돌립니다(잔여 변위도). */
    reflect(ev, restitution) {
        const B = this.#bodies,
            I = ev.i;
        if (ev.j >= 0 || !(B.flags[I] & DYNAMIC)) {
            throw new TypeError('ContactSolver.reflect needs a surface contact of a DYNAMIC body.');
        }
        ev.handled = true;
        this.#setImpact(I, B.vx[I], B.vy[I]);
        this.#removeInward(I, ev.nx, ev.ny, restitution);
        B.vx[I] = B.ivx[I] / this.#fp;
        B.vy[I] = B.ivy[I] / this.#fp;
        ev.response = RESPONSE_REFLECT;
    }

    /**
     * 0초 반복에 걸린 쌍에서 `moveI`·`moveJ`로 표시한 동적 몸만 상대 접근 속도를 각자의 반발 계수로 되돌려 튕깁니다(둘 다면
     * 반씩). 붙지 않습니다. 이미 멀어지면 아무것도 바꾸지 않습니다. 궤적 속도는 반올림하지 않습니다(다음 cast가 떨어짐을 봄).
     */
    bounce(ev, moveI, moveJ, restitutionI, restitutionJ = restitutionI) {
        const B = this.#bodies,
            I = ev.i,
            J = ev.j,
            NX = ev.nx,
            NY = ev.ny;
        if (J < 0 || (moveI && !(B.flags[I] & DYNAMIC)) || (moveJ && !(B.flags[J] & DYNAMIC))) {
            throw new TypeError('ContactSolver.bounce needs a pair whose moving bodies are DYNAMIC.');
        }
        ev.handled = true;
        const CLOSING = (B.vx[I] - B.vx[J]) * NX + (B.vy[I] - B.vy[J]) * NY;
        if (CLOSING >= 0) {
            ev.response = RESPONSE_NONE;
            return;
        }
        const SHARE = moveI && moveJ ? 0.5 : 1;
        for (let side = 0; side < 2; side++) {
            if (!(side === 0 ? moveI : moveJ)) {
                continue;
            }
            const K = side === 0 ? I : J,
                CHANGE = -(1 + (side === 0 ? restitutionI : restitutionJ)) * CLOSING * SHARE * (side === 0 ? 1 : -1);
            B.vx[K] += CHANGE * NX;
            B.vy[K] += CHANGE * NY;
            this.#setImpact(K, B.vx[K], B.vy[K]);
        }
        ev.response = RESPONSE_BOUNCE;
    }

    /** 게임이 스텝 중 `vx`·`vy`·`flags`를 직접 고친 몸을 지금 묶음이 끝날 때 다시 cast하게 합니다. */
    touched(i) {
        this.#involved[i] = this.#stamp;
    }

    /**
     * 남은 접촉을 기본 응답으로 마저 풀고(응답하지 않은 접촉 포함) 모든 몸을 dt까지 옮기고(조향 몸은 소수 잔여를 반올림으로
     * 정산해 막히지 않았으면 조향 끝점에 섬), 움직인 몸을 지형 밖으로 복구합니다. 결과: `x`·`y`(격자 정수), `vx`·`vy`, 동적 몸의 `ivx`·`ivy`·`rx`·`ry`, 새로 동적이 된 몸의 `flags`.
     */
    end() {
        if (this.#state === FILLING) {
            this.#prepare();
        }
        if (this.#state === RUNNING) {
            const EV = this.#drain;
            while (this.next(EV)) {
                this.resolve(EV);
            }
        }
        if (this.#state !== DONE) {
            throw new Error('ContactSolver.end needs begin() first.');
        }
        const B = this.#bodies,
            N = B.count,
            FP = this.#fp,
            RESULT = this.#motion;
        this.#now = this.#dt;
        for (let i = 0; i < N; i++) {
            this.#advance(i);
            // 조향 몸은 잔여 변위를 다음 틱에 넘기지 않으므로 틱 끝에 반올림으로 정산합니다. 그래서 막히지 않은 조향 몸은
            // 부동소수 오차(예: 32.9999…)와 무관하게 조향 끝점에 정확히 서고, 접촉한 몸도 내림 손실이 틱마다 쌓이지 않습니다.
            if (!(B.flags[i] & DYNAMIC)) {
                B.x[i] += Math.round(this.#fracX[i]);
                B.y[i] += Math.round(this.#fracY[i]);
                this.#fracX[i] = 0;
                this.#fracY[i] = 0;
            }
        }
        // 마지막 안전망: 궤적이 지형 cast를 피해 간 몸(반올림 등)도 제자리에서 복구합니다(원본 UnitMotion.constrain과 같은 식).
        for (let i = 0; i < N; i++) {
            if (!(B.flags[i] & ACTIVE)) {
                continue;
            }
            const X = B.x[i] / FP,
                Y = B.y[i] / FP;
            this.#surface.solve(X, Y, X, Y, B.radius[i], null, 'project', B.key[i], RESULT);
            B.x[i] = Math.round(RESULT.x * FP);
            B.y[i] = Math.round(RESULT.y * FP);
        }
        this.#state = IDLE;
    }
    #drain = new ContactEvent();

    /**
     * 위치 겹침 풀기(`end` 뒤). SOFT 쌍은 질량비로 침투의 `softFraction`만큼 모아 몸별 `softCap`으로 자른 뒤 함께 옮기고(Jacobi),
     * SOLID 쌍은 침투한 쪽(틱 시작부터 상대 쪽으로 더 움직인 쪽)을 완전히 밀어냅니다(쌍 키 순서로 차례로). 각 단계가 끝나면
     * 옮긴 몸을 단계 시작 자리에서 지형을 따라 다시 풀어 벽 안으로 들어가지 않게 합니다. 옮긴 몸 수를 돌려줍니다.
     */
    separate() {
        const B = this.#bodies,
            N = B.count;
        if (N === 0) {
            return 0;
        }
        let maxRadius = 0;
        for (let i = 0; i < N; i++) {
            this.#radiusFP[i] = Math.round(B.radius[i] * this.#fp);
            if (B.flags[i] & SEPARATE && this.#radiusFP[i] > maxRadius) {
                maxRadius = this.#radiusFP[i];
            }
        }
        this.#separationGridFresh = false;
        this.#copyPositions();
        let soft = 0;
        for (let pass = 0; pass < this.#softPasses; pass++) {
            const MOVED = this.#softPass(maxRadius);
            soft += MOVED;
            if (!MOVED) {
                break;
            }
        }
        if (soft) {
            this.#constrainMoved();
        }
        this.#copyPositions();
        let hard = 0;
        for (let pass = 0; pass < this.#hardPasses; pass++) {
            const MOVED = this.#hardPass(maxRadius);
            hard += MOVED;
            if (!MOVED) {
                break;
            }
        }
        if (hard) {
            this.#constrainMoved();
        }
        this.stats.softMoves = soft;
        this.stats.hardMoves = hard;
        return soft + hard;
    }

    #checkBudget() {
        const BUDGET = this.pairBudget;
        if (!(BUDGET === Infinity || (Number.isSafeInteger(BUDGET) && BUDGET >= 0))) {
            throw new RangeError('ContactSolver pairBudget must be an integer >= 0 or Infinity.');
        }
    }

    #growBodies(count) {
        if (this.#capacity >= count) {
            return;
        }
        const CAPACITY = Math.max(count, this.#capacity * 2, 64);
        this.#base = new Float64Array(CAPACITY);
        this.#fracX = new Float64Array(CAPACITY);
        this.#fracY = new Float64Array(CAPACITY);
        this.#involved = new Int32Array(CAPACITY);
        this.#recast = new Int32Array(CAPACITY);
        this.#startX = new Int32Array(CAPACITY);
        this.#startY = new Int32Array(CAPACITY);
        this.#segX = new Int32Array(CAPACITY);
        this.#segY = new Int32Array(CAPACITY);
        this.#stageX = new Int32Array(CAPACITY);
        this.#stageY = new Int32Array(CAPACITY);
        this.#radiusFP = new Int32Array(CAPACITY);
        this.#sumX = new Int32Array(CAPACITY);
        this.#sumY = new Int32Array(CAPACITY);
        this.#counts = new Int32Array(CAPACITY);
        this.#candidates = new Int32Array(CAPACITY);
        this.#head = new Int32Array(CAPACITY);
        this.#earliest = new Float64Array(CAPACITY);
        this.#capacity = CAPACITY;
        this.#stamp = 0;
    }

    #growPool(capacity) {
        const OLD = this.#poolCapacity;
        const GROW = (array, type) => {
            const NEXT = new type(capacity);
            NEXT.set(array);
            return NEXT;
        };
        this.#cT = GROW(this.#cT, Float64Array);
        this.#cI = GROW(this.#cI, Int32Array);
        this.#cJ = GROW(this.#cJ, Int32Array);
        this.#cNx = GROW(this.#cNx, Float64Array);
        this.#cNy = GROW(this.#cNy, Float64Array);
        this.#cKey = GROW(this.#cKey, Float64Array);
        this.#cSortA = GROW(this.#cSortA, Float64Array);
        this.#cSortB = GROW(this.#cSortB, Float64Array);
        this.#cNext = GROW(this.#cNext, Int32Array);
        this.#order = GROW(this.#order, Int32Array);
        this.#orderScratch = new Int32Array(capacity);
        for (let c = capacity - 1; c >= OLD; c--) {
            this.#cNext[c] = this.#free;
            this.#free = c;
            this.#cObstacle[c] = null;
        }
        this.#poolCapacity = capacity;
    }

    // 표면 접촉 키(< 2^52)와 쌍 키 -(큰 번호 + 1)을 Float64로, 몸·작은 번호를 Int32로 둡니다. 비교는 두 값의 정확한 일치입니다.
    #growRepeats(capacity) {
        const OLD_A = this.#repeatA,
            OLD_B = this.#repeatB,
            OLD_COUNT = this.#repeatCount,
            OLD_EPOCH = this.#repeatEpoch,
            OLD_NOW = this.#repeatEpochNow;
        this.#repeatA = new Int32Array(capacity);
        this.#repeatB = new Float64Array(capacity);
        this.#repeatCount = new Int32Array(capacity);
        this.#repeatEpoch = new Uint32Array(capacity);
        this.#repeatEpochNow = 1;
        this.#repeatUsed = 0;
        for (let s = 0; s < OLD_A.length; s++) {
            if (OLD_EPOCH[s] === OLD_NOW) {
                this.#repeatSlot(OLD_A[s], OLD_B[s]);
                this.#repeatCount[this.#lastSlot] = OLD_COUNT[s];
            }
        }
    }
    #lastSlot = 0;
    // (a, b)의 칸을 찾거나 만들고 `#lastSlot`에 둡니다(새 칸은 횟수 0).
    #repeatSlot(a, b) {
        const MASK = this.#repeatA.length - 1,
            POSITIVE = b < 0 ? -b : b;
        let h = Math.imul(a ^ 0x27d4eb2f, 0x9e3779b1) ^ (POSITIVE % TWO_32);
        h = Math.imul(h ^ Math.floor(POSITIVE / TWO_32) ^ (b < 0 ? 0x5bd1e995 : 0), 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        let s = h & MASK;
        const EPOCH = this.#repeatEpochNow;
        while (this.#repeatEpoch[s] === EPOCH) {
            if (this.#repeatA[s] === a && this.#repeatB[s] === b) {
                this.#lastSlot = s;
                return;
            }
            s = (s + 1) & MASK;
        }
        this.#repeatEpoch[s] = EPOCH;
        this.#repeatA[s] = a;
        this.#repeatB[s] = b;
        this.#repeatCount[s] = 0;
        this.#repeatUsed++;
        this.#lastSlot = s;
    }
    #clearRepeats() {
        this.#repeatUsed = 0;
        if (++this.#repeatEpochNow > 0xfffffff0) {
            this.#repeatEpoch.fill(0);
            this.#repeatEpochNow = 1;
        }
    }
    #repeat(c) {
        if (this.#repeatUsed * 2 >= this.#repeatA.length) {
            this.#growRepeats(this.#repeatA.length * 2);
        }
        if (this.#cJ[c] >= 0) {
            this.#repeatSlot(this.#cSortA[c], -(this.#cSortB[c] + 1));
        } else {
            this.#repeatSlot(this.#cI[c], this.#cKey[c]);
        }
        return ++this.#repeatCount[this.#lastSlot];
    }

    // 몸 b의 접촉 기록을 모두 잊습니다.
    #release(b) {
        for (let c = this.#head[b]; c >= 0;) {
            const NEXT = this.#cNext[c];
            this.#cObstacle[c] = null;
            this.#cNext[c] = this.#free;
            this.#free = c;
            c = NEXT;
        }
        this.#head[b] = -1;
        this.#earliest[b] = Infinity;
    }
    // 몸 b의 가장 이른 접촉(1e-9 창)이면 기록하고, 더 이르면 그전 기록을 버립니다. 시각은 cast 시작 시각(`#castNow`) +
    // clamp(hit.t) · 남은 길이(`#castSpan`), 쌍(j ≥ 0)은 접촉 키 0·장애물 null입니다. 부동소수 값을 인자로 넘기지 않습니다(상자 할당).
    #keep(b, i, j, hit) {
        const TIME = this.#castNow + Math.max(0, Math.min(1, hit.t)) * this.#castSpan,
            PAIR = j >= 0;
        if (TIME < this.#earliest[b] - SAME_TIME) {
            this.#release(b);
            this.#earliest[b] = TIME;
        } else if (Math.abs(TIME - this.#earliest[b]) > SAME_TIME) {
            return;
        }
        if (this.#free < 0) {
            this.#growPool(this.#poolCapacity * 2);
        }
        const C = this.#free;
        this.#free = this.#cNext[C];
        this.#cT[C] = TIME;
        this.#cI[C] = i;
        this.#cJ[C] = j;
        this.#cNx[C] = hit.nx;
        this.#cNy[C] = hit.ny;
        this.#cKey[C] = PAIR ? 0 : hit.key;
        this.#cObstacle[C] = PAIR ? null : hit.obstacle;
        this.#cSortA[C] = PAIR ? Math.min(i, j) : i;
        this.#cSortB[C] = PAIR ? Math.max(i, j) : hit.key;
        this.#cNext[C] = this.#head[b];
        this.#head[b] = C;
    }
    // 같은 시각 접촉의 순서: 표면 먼저(몸, 접촉 키), 다음 쌍(작은 번호, 큰 번호), 마지막으로 i. 같으면 모은 순서(안정).
    #compare(a, b) {
        return (
            (this.#cJ[a] < 0 ? 0 : 1) - (this.#cJ[b] < 0 ? 0 : 1) ||
            this.#cSortA[a] - this.#cSortA[b] ||
            this.#cSortB[a] - this.#cSortB[b] ||
            this.#cI[a] - this.#cI[b]
        );
    }
    #sortOrder(length) {
        let from = this.#order,
            to = this.#orderScratch;
        for (let width = 1; width < length; width *= 2) {
            for (let lo = 0; lo < length; lo += width * 2) {
                const MID = Math.min(lo + width, length),
                    HI = Math.min(lo + width * 2, length);
                let a = lo,
                    b = MID,
                    k = lo;
                while (a < MID && b < HI) {
                    to[k++] = this.#compare(from[a], from[b]) <= 0 ? from[a++] : from[b++];
                }
                while (a < MID) {
                    to[k++] = from[a++];
                }
                while (b < HI) {
                    to[k++] = from[b++];
                }
            }
            const SWAP = from;
            from = to;
            to = SWAP;
        }
        if (from !== this.#order) {
            for (let k = 0; k < length; k++) {
                this.#order[k] = from[k];
            }
        }
    }

    #prepare() {
        this.#checkBudget();
        const B = this.#bodies,
            N = B.count,
            FP = this.#fp,
            DT = this.#dt,
            GRID = this.#grid;
        GRID.clear();
        this.#separationGridFresh = false;
        this.#maxRadius = 0;
        this.#speedBound = 0;
        for (let i = 0; i < N; i++) {
            const FLAGS = B.flags[i];
            if (!(FLAGS & DYNAMIC)) {
                B.ivx[i] = 0;
                B.ivy[i] = 0;
                B.rx[i] = 0;
                B.ry[i] = 0;
            }
            B.vx[i] = (B.steerX[i] - B.x[i]) / FP / DT + B.ivx[i] / FP;
            B.vy[i] = (B.steerY[i] - B.y[i]) / FP / DT + B.ivy[i] / FP;
            this.#startX[i] = B.x[i];
            this.#startY[i] = B.y[i];
            this.#fracX[i] = 0;
            this.#fracY[i] = 0;
            this.#base[i] = 0;
            this.#head[i] = -1;
            this.#earliest[i] = Infinity;
            if (FLAGS & ACTIVE) {
                GRID.insert(i, B.x[i], B.y[i]);
                if (B.radius[i] > this.#maxRadius) {
                    this.#maxRadius = B.radius[i];
                }
                this.#speedBound = Math.max(this.#speedBound, Math.sqrt(B.vx[i] * B.vx[i] + B.vy[i] * B.vy[i]));
            }
        }
        // 기록 풀 전체를 빈 목록으로.
        this.#free = -1;
        for (let c = this.#poolCapacity - 1; c >= 0; c--) {
            this.#cNext[c] = this.#free;
            this.#cObstacle[c] = null;
            this.#free = c;
        }
        this.#clearRepeats();
        this.#pairsLeft = this.pairBudget;
        this.#now = 0;
        this.#elapsed = 0;
        this.#orderLength = 0;
        this.#cursor = 0;
        this.#state = RUNNING;
        for (let i = 0; i < N; i++) {
            this.#castBody(i);
        }
    }

    // 가장 이른 접촉 시각의 묶음을 모으고 그 몸들을 그 시각까지 옮깁니다. 접촉이 없으면 false.
    #startGroup() {
        const N = this.#bodies.count;
        let first = Infinity;
        for (let b = 0; b < N; b++) {
            if (this.#head[b] >= 0 && this.#earliest[b] < first) {
                first = this.#earliest[b];
            }
        }
        this.#orderLength = 0;
        this.#cursor = 0;
        if (first === Infinity) {
            return false;
        }
        this.#elapsed = first - this.#now;
        this.#now = first;
        if (this.#elapsed > SAME_TIME) {
            this.#clearRepeats();
        }
        this.stats.groups++;
        const STAMP = ++this.#stamp;
        let length = 0;
        for (let b = 0; b < N; b++) {
            if (this.#head[b] >= 0 && this.#earliest[b] <= first + SAME_TIME) {
                for (let c = this.#head[b]; c >= 0; c = this.#cNext[c]) {
                    this.#order[length++] = c;
                }
            }
        }
        this.#sortOrder(length);
        this.#orderLength = length;
        for (let q = 0; q < length; q++) {
            const C = this.#order[q],
                I = this.#cI[C],
                J = this.#cJ[C];
            this.#involved[I] = STAMP;
            this.#advance(I);
            if (J >= 0) {
                this.#involved[J] = STAMP;
                this.#advance(J);
            }
        }
        this.#lastI = -1;
        this.#lastJ = -1;
        return true;
    }

    // 묶음에 응답한 몸과 그 몸에 접촉을 걸어 둔 몸만 다시 cast합니다.
    #finishGroup() {
        const N = this.#bodies.count,
            STAMP = this.#stamp,
            INVOLVED = this.#involved,
            RECAST = this.#recast;
        for (let b = 0; b < N; b++) {
            let mark = INVOLVED[b] === STAMP;
            for (let c = this.#head[b]; !mark && c >= 0; c = this.#cNext[c]) {
                mark = INVOLVED[this.#cI[c]] === STAMP || (this.#cJ[c] >= 0 && INVOLVED[this.#cJ[c]] === STAMP);
            }
            RECAST[b] = mark ? STAMP : 0;
        }
        for (let b = 0; b < N; b++) {
            if (RECAST[b] === STAMP) {
                this.#advance(b);
                this.#castBody(b);
            }
        }
        this.#orderLength = 0;
        this.#cursor = 0;
    }

    // 몸 i를 자기 시간 기준점에서 지금 시각(`#now`)까지 직선으로 옮깁니다. 격자 정수 위치 + 잔여 변위(동적 몸은 정수, 조향
    // 몸은 소수). 시각을 인자로 넘기지 않는 것은 인라인되지 않은 호출의 부동소수 인자가 틱마다 상자(HeapNumber)를 만들기 때문입니다.
    #advance(i) {
        const B = this.#bodies,
            TIME = this.#now,
            ELAPSED = TIME - this.#base[i];
        this.#base[i] = TIME;
        if (!(ELAPSED > 0) || !(B.flags[i] & ACTIVE)) {
            return;
        }
        const FP = this.#fp,
            SCALE = this.#remainderScale,
            DYNAMIC_BODY = (B.flags[i] & DYNAMIC) !== 0,
            RX = DYNAMIC_BODY ? B.rx[i] / SCALE : this.#fracX[i],
            RY = DYNAMIC_BODY ? B.ry[i] / SCALE : this.#fracY[i],
            DX = B.vx[i] * FP * ELAPSED + RX,
            DY = B.vy[i] * FP * ELAPSED + RY,
            SX = Math.trunc(DX),
            SY = Math.trunc(DY);
        if (DYNAMIC_BODY) {
            B.rx[i] = Math.round((DX - SX) * SCALE);
            B.ry[i] = Math.round((DY - SY) * SCALE);
        } else {
            this.#fracX[i] = DX - SX;
            this.#fracY[i] = DY - SY;
        }
        B.x[i] += SX;
        B.y[i] += SY;
    }

    // 높이로 갈린 쌍인지(한쪽이 VERTICAL일 때만): 한쪽 바닥이 다른 쪽 바닥 + 그쪽 지름 이상.
    #separated(a, b) {
        const B = this.#bodies;
        if (!((B.flags[a] | B.flags[b]) & VERTICAL)) {
            return false;
        }
        return B.z[a] >= B.z[b] + 2 * B.radius[b] || B.z[b] >= B.z[a] + 2 * B.radius[a];
    }

    // 두 key의 정수 8방향(NORMAL_SCALE 배율), 작은 key → 큰 key. 결과는 #normalX/#normalY.
    #fallback(a, b) {
        const B = this.#bodies,
            NA = B.key[a],
            NB = B.key[b],
            LO = Math.min(NA, NB),
            HI = Math.max(NA, NB),
            D = pairHash(LO, HI) & 7,
            SIGN = NA === LO ? 1 : -1;
        this.#normalX = SIGN * NORMAL_X[D];
        this.#normalY = SIGN * NORMAL_Y[D];
    }
    #normalX = 0;
    #normalY = 0;
    // 지금 cast의 시작 시각과 남은 길이(초). #keep이 접촉 시각을 계산합니다.
    #castNow = 0;
    #castSpan = 0;

    // 지금 시각(`#now`, 자기 시간 기준점)에 있는 몸 i를 남은 틱 동안 cast해 가장 이른 접촉을 기록합니다: 표면, 그다음 SOLID 관계의 몸.
    // 쌍은 (동적 몸, 상대)로 cast하고 둘 다 같은 종류면 작은 번호가 먼저입니다(어느 쪽이 cast하든 같은 식).
    #castBody(i) {
        const NOW = this.#now,
            B = this.#bodies,
            FP = this.#fp,
            END = this.#dt;
        this.#release(i);
        const SPAN = END - NOW,
            FLAGS = B.flags[i];
        if (!(FLAGS & ACTIVE) || SPAN <= SAME_TIME) {
            return;
        }
        this.stats.casts++;
        this.#castNow = NOW;
        this.#castSpan = SPAN;
        const VX = B.vx,
            VY = B.vy,
            // 속력은 후보 도달 거리의 상한에만 씁니다(Math.hypot은 인자·결과 상자를 만들어 sqrt로 둡니다. 결과 무관).
            SPEED = Math.sqrt(VX[i] * VX[i] + VY[i] * VY[i]);
        if (SPEED > this.#speedBound) {
            this.#speedBound = SPEED;
        }
        const DX = VX[i] * SPAN,
            DY = VY[i] * SPAN,
            X = B.x[i] / FP,
            Y = B.y[i] / FP,
            HIT = this.#hit;
        if (
            Math.abs(DX) + Math.abs(DY) > SAME_TIME &&
            this.#surface.cast(X, Y, DX, DY, B.radius[i], null, HIT) &&
            VX[i] * HIT.nx + VY[i] * HIT.ny < INWARD
        ) {
            this.#keep(i, i, -1, HIT);
        }
        if (!(this.#pairsLeft > 0) || !(FLAGS & PAIRS)) {
            return;
        }
        // 다른 몸은 격자에 틱 시작 자리로 있고 그 뒤 최대 speedBound · END만큼 움직였습니다(격자 한 칸 반올림 여유 2/FP).
        // 도달 거리를 정수 격자로 올림해 질의합니다(후보가 늘 수만 있고 결과는 후보 순서·여분과 무관).
        const REACH = Math.ceil((SPEED * SPAN + this.#speedBound * END + B.radius[i] + this.#maxRadius) * FP + 2),
            CANDIDATES = this.#candidates,
            COUNT = this.#grid.queryRectInto(
                B.x[i] - REACH,
                B.y[i] - REACH,
                B.x[i] + REACH,
                B.y[i] + REACH,
                CANDIDATES,
            );
        // 후보를 번호 순으로: 결과가 격자 칸 크기·칸 순서와 무관합니다.
        for (let k = 1; k < COUNT; k++) {
            const VALUE = CANDIDATES[k];
            let m = k - 1;
            while (m >= 0 && CANDIDATES[m] > VALUE) {
                CANDIDATES[m + 1] = CANDIDATES[m];
                m--;
            }
            CANDIDATES[m + 1] = VALUE;
        }
        const RELATIONS = this.#relations,
            GROUPS = this.#groups,
            ROW = B.group[i] * GROUPS,
            BASE = this.#base,
            PAIR_HIT = this.#pairHit,
            DYNAMIC_I = FLAGS & DYNAMIC;
        for (let k = 0; k < COUNT; k++) {
            const J = CANDIDATES[k];
            if (J === i || !(B.flags[J] & PAIRS) || RELATIONS[ROW + B.group[J]] !== SOLID || this.#separated(i, J)) {
                continue;
            }
            const DYNAMIC_J = B.flags[J] & DYNAMIC,
                A = (DYNAMIC_I ? 1 : 0) === (DYNAMIC_J ? 1 : 0) ? Math.min(i, J) : DYNAMIC_I ? i : J,
                O = A === i ? J : i,
                AX = B.x[A] / FP + VX[A] * (NOW - BASE[A]),
                AY = B.y[A] / FP + VY[A] * (NOW - BASE[A]),
                OX = B.x[O] / FP + VX[O] * (NOW - BASE[O]),
                OY = B.y[O] / FP + VY[O] * (NOW - BASE[O]);
            if (
                !SweptCircleContact.cast(
                    AX - OX,
                    AY - OY,
                    (VX[A] - VX[O]) * SPAN,
                    (VY[A] - VY[O]) * SPAN,
                    B.radius[A] + B.radius[O],
                    SweptCircleContact.policies.relative,
                    PAIR_HIT,
                )
            ) {
                continue;
            }
            if (PAIR_HIT.degenerate) {
                this.#fallback(A, O);
                PAIR_HIT.nx = this.#normalX / NORMAL_SCALE;
                PAIR_HIT.ny = this.#normalY / NORMAL_SCALE;
            }
            if ((VX[A] - VX[O]) * PAIR_HIT.nx + (VY[A] - VY[O]) * PAIR_HIT.ny < INWARD) {
                this.#keep(i, A, O, PAIR_HIT);
            }
        }
    }

    // 몸 i의 충격 속도를 궤적 속도 (vx, vy)로 맞춥니다(조향 몸은 동적으로 바뀜). 쌀콩팡 applyImpulse의 Δv = J / m 반올림 식.
    #setImpact(i, vx, vy) {
        const B = this.#bodies,
            FP = this.#fp,
            MASS = B.mass[i];
        B.ivx[i] += Math.round((((vx - B.ivx[i] / FP) * MASS) / MASS) * FP);
        B.ivy[i] += Math.round((((vy - B.ivy[i] / FP) * MASS) / MASS) * FP);
        B.flags[i] |= DYNAMIC;
    }
    // 충격량 (jx, jy)를 충격 속도에 더합니다(1/FP 반올림).
    #push(i, jx, jy) {
        const B = this.#bodies,
            FP = this.#fp,
            MASS = B.mass[i];
        B.ivx[i] += Math.round((jx / MASS) * FP);
        B.ivy[i] += Math.round((jy / MASS) * FP);
    }
    // 동적이 된 조향 몸의 소수 잔여 변위를 정수 잔여로 넘깁니다.
    #takeRemainder(i) {
        const B = this.#bodies,
            SCALE = this.#remainderScale;
        B.rx[i] = Math.round(this.#fracX[i] * SCALE);
        B.ry[i] = Math.round(this.#fracY[i] * SCALE);
    }
    // 충격 속도의 안쪽 성분을 (1 + e)배로 되돌리고, 반올림이 남긴 안쪽 성분과 안쪽 잔여 변위를 지웁니다.
    #removeInward(i, nx, ny, restitution) {
        const B = this.#bodies,
            INWARD_SPEED = B.ivx[i] * nx + B.ivy[i] * ny;
        if (INWARD_SPEED >= 0) {
            return;
        }
        const FACTOR = 1 + restitution;
        B.ivx[i] = Math.round(B.ivx[i] - FACTOR * INWARD_SPEED * nx);
        B.ivy[i] = Math.round(B.ivy[i] - FACTOR * INWARD_SPEED * ny);
        const RESIDUAL = B.ivx[i] * nx + B.ivy[i] * ny;
        if (RESIDUAL < 0) {
            if (Math.abs(nx) >= Math.abs(ny)) {
                B.ivx[i] += Math.sign(nx) * Math.ceil(-RESIDUAL / Math.abs(nx));
            } else {
                B.ivy[i] += Math.sign(ny) * Math.ceil(-RESIDUAL / Math.abs(ny));
            }
        }
        const REMAINDER = B.rx[i] * nx + B.ry[i] * ny;
        if (REMAINDER < 0) {
            B.rx[i] = Math.round(B.rx[i] - REMAINDER * nx);
            B.ry[i] = Math.round(B.ry[i] - REMAINDER * ny);
        }
    }
    // 조향 몸 i가 법선 (nx, ny) 접촉을 따라 미끄러집니다(목표 = 지금 방향, 길이 유지). 1/FP 격자로 반올림한 뒤 안쪽 성분 제거.
    #slide(i, nx, ny, key) {
        const B = this.#bodies,
            FP = this.#fp,
            VX = B.vx[i],
            VY = B.vy[i],
            LIST = this.#slideList.clear(),
            OUT = this.#slideOut;
        LIST.add(nx, ny, 0, key);
        SurfaceContactGeometry.slide(VX, VY, LIST, Math.hypot(VX, VY), true, VX, VY, B.key[i], null, OUT);
        let sx = Math.round(OUT.x * FP),
            sy = Math.round(OUT.y * FP);
        const INWARD_SPEED = sx * nx + sy * ny;
        if (INWARD_SPEED < 0) {
            const FACTOR = 1 + this.restitution;
            sx = Math.round(sx - FACTOR * INWARD_SPEED * nx);
            sy = Math.round(sy - FACTOR * INWARD_SPEED * ny);
            const RESIDUAL = sx * nx + sy * ny;
            if (RESIDUAL < 0) {
                if (Math.abs(nx) >= Math.abs(ny)) {
                    sx += Math.sign(nx) * Math.ceil(-RESIDUAL / Math.abs(nx));
                } else {
                    sy += Math.sign(ny) * Math.ceil(-RESIDUAL / Math.abs(ny));
                }
            }
        }
        B.vx[i] = sx / FP;
        B.vy[i] = sy / FP;
    }
    // 0초 반복 한도의 표면 접촉: 동적 몸은 충격 속도를 0으로(같은 반올림 식), 궤적 속도도 0.
    #stop(ev) {
        const B = this.#bodies,
            I = ev.i;
        if (B.flags[I] & DYNAMIC) {
            const FP = this.#fp,
                MASS = B.mass[I];
            B.ivx[I] += Math.round((((-B.ivx[I] / FP) * MASS) / MASS) * FP);
            B.ivy[I] += Math.round((((-B.ivy[I] / FP) * MASS) / MASS) * FP);
        }
        B.vx[I] = 0;
        B.vy[I] = 0;
        ev.response = RESPONSE_STOP;
    }
    // 0초 반복 한도의 쌍: 질량 가중 공통 속도로 붙습니다. 동적 몸이 끼면 조향 몸도 동적으로(잔여 변위는 넘기지 않음).
    #stick(ev) {
        const B = this.#bodies,
            I = ev.i,
            J = ev.j,
            MA = B.mass[I],
            MB = B.mass[J],
            COMMON_X = (B.vx[I] * MA + B.vx[J] * MB) / (MA + MB),
            COMMON_Y = (B.vy[I] * MA + B.vy[J] * MB) / (MA + MB),
            PROMOTE = ((B.flags[I] | B.flags[J]) & DYNAMIC) !== 0;
        for (let side = 0; side < 2; side++) {
            const K = side === 0 ? I : J;
            if (PROMOTE) {
                if (!(B.flags[K] & DYNAMIC)) {
                    B.rx[K] = 0;
                    B.ry[K] = 0;
                }
                this.#setImpact(K, COMMON_X, COMMON_Y);
            }
            B.vx[K] = COMMON_X;
            B.vy[K] = COMMON_Y;
        }
        ev.response = RESPONSE_STICK;
    }

    // 단계(SOFT 전체, SOLID 전체) 시작 자리. 단계가 끝나면 여기서부터 지형을 따라 다시 풉니다.
    #copyPositions() {
        const B = this.#bodies;
        for (let i = 0; i < B.count; i++) {
            this.#stageX[i] = B.x[i];
            this.#stageY[i] = B.y[i];
        }
    }

    // 단계 시작 자리(#stageX/#stageY)에서 옮겨진 몸을 지형을 따라 다시 풉니다('project', 원본 constrain과 같은 식).
    #constrainMoved() {
        const B = this.#bodies,
            FP = this.#fp,
            RESULT = this.#motion;
        this.#separationGridFresh = false;
        for (let i = 0; i < B.count; i++) {
            if (!(B.flags[i] & SEPARATE) || (B.x[i] === this.#stageX[i] && B.y[i] === this.#stageY[i])) {
                continue;
            }
            this.#surface.solve(
                this.#stageX[i] / FP,
                this.#stageY[i] / FP,
                B.x[i] / FP,
                B.y[i] / FP,
                B.radius[i],
                null,
                'project',
                B.key[i],
                RESULT,
            );
            B.x[i] = Math.round(RESULT.x * FP);
            B.y[i] = Math.round(RESULT.y * FP);
        }
    }

    #rebuildSeparationGrid() {
        if (this.#separationGridFresh) {
            return;
        }
        this.#separationGridFresh = true;
        const B = this.#bodies,
            GRID = this.#grid;
        GRID.clear();
        for (let i = 0; i < B.count; i++) {
            if (B.flags[i] & SEPARATE) {
                GRID.insert(i, B.x[i], B.y[i]);
            }
        }
    }

    // SOFT 한 pass(Jacobi): 모든 쌍의 보정을 pass 시작 위치로 모은 뒤 함께 옮깁니다. 보정은 정수 합이라 순서와 무관합니다.
    #softPass(maxRadius) {
        const B = this.#bodies,
            N = B.count,
            FP = this.#fp,
            R = this.#radiusFP,
            SUM_X = this.#sumX,
            SUM_Y = this.#sumY,
            COUNTS = this.#counts,
            RELATIONS = this.#relations,
            GROUPS = this.#groups,
            FRACTION = this.#softFraction,
            CANDIDATES = this.#candidates;
        this.#rebuildSeparationGrid();
        SUM_X.fill(0, 0, N);
        SUM_Y.fill(0, 0, N);
        COUNTS.fill(0, 0, N);
        for (let i = 0; i < N; i++) {
            if (!(B.flags[i] & SEPARATE)) {
                continue;
            }
            const REACH = R[i] + maxRadius,
                COUNT = this.#grid.queryRectInto(
                    B.x[i] - REACH,
                    B.y[i] - REACH,
                    B.x[i] + REACH,
                    B.y[i] + REACH,
                    CANDIDATES,
                ),
                ROW = B.group[i] * GROUPS;
            for (let k = 0; k < COUNT; k++) {
                const J = CANDIDATES[k];
                if (J <= i || RELATIONS[ROW + B.group[J]] !== SOFT) {
                    continue;
                }
                const MIN = R[i] + R[J],
                    DX = B.x[J] - B.x[i],
                    DY = B.y[J] - B.y[i],
                    D2 = DX * DX + DY * DY;
                if (D2 >= MIN * MIN) {
                    continue;
                }
                let nx, ny, distance;
                if (D2 === 0) {
                    this.#fallback(i, J);
                    nx = this.#normalX;
                    ny = this.#normalY;
                    distance = 0;
                } else {
                    distance = Math.max(1, Math.floor(Math.sqrt(D2)));
                    nx = Math.trunc((DX * NORMAL_SCALE) / distance);
                    ny = Math.trunc((DY * NORMAL_SCALE) / distance);
                }
                const PEN = MIN - distance;
                if (PEN <= 0) {
                    continue;
                }
                const SOFT_PEN = Math.max(1, Math.trunc(PEN * FRACTION)),
                    MA = B.mass[i],
                    MB = B.mass[J],
                    TOTAL = Math.max(1, MA + MB),
                    PA = Math.trunc((SOFT_PEN * MB) / TOTAL),
                    PB = SOFT_PEN - PA;
                SUM_X[i] -= Math.trunc((nx * PA) / NORMAL_SCALE);
                SUM_Y[i] -= Math.trunc((ny * PA) / NORMAL_SCALE);
                SUM_X[J] += Math.trunc((nx * PB) / NORMAL_SCALE);
                SUM_Y[J] += Math.trunc((ny * PB) / NORMAL_SCALE);
                COUNTS[i]++;
                COUNTS[J]++;
            }
        }
        const WIDTH = this.#width * FP,
            HEIGHT = this.#height * FP;
        let moved = 0;
        for (let i = 0; i < N; i++) {
            if (!COUNTS[i]) {
                continue;
            }
            let cx = Math.trunc(SUM_X[i] / COUNTS[i]),
                cy = Math.trunc(SUM_Y[i] / COUNTS[i]);
            const CAP = Math.max(1, B.softCap[i]),
                LENGTH2 = cx * cx + cy * cy;
            if (LENGTH2 > CAP * CAP) {
                const SCALE = CAP / Math.max(1, Math.sqrt(LENGTH2));
                cx = Math.trunc(cx * SCALE);
                cy = Math.trunc(cy * SCALE);
            }
            if (cx === 0 && cy === 0) {
                continue;
            }
            const OLD_X = B.x[i],
                OLD_Y = B.y[i];
            B.x[i] = Math.min(Math.max(OLD_X + cx, R[i]), WIDTH - R[i]);
            B.y[i] = Math.min(Math.max(OLD_Y + cy, R[i]), HEIGHT - R[i]);
            if (B.x[i] !== OLD_X || B.y[i] !== OLD_Y) {
                moved++;
            }
        }
        if (moved) {
            this.#separationGridFresh = false;
        }
        return moved;
    }

    // 침투한 쪽: 틱 시작 자리에서 상대 쪽으로 더 다가간 몸, 같으면 더 많이 움직인 몸, 같으면 key가 작은 몸.
    #owner(a, b) {
        const B = this.#bodies,
            ASX = this.#startX[a],
            ASY = this.#startY[a],
            BSX = this.#startX[b],
            BSY = this.#startY[b];
        let dx = BSX - ASX,
            dy = BSY - ASY;
        if (dx === 0 && dy === 0) {
            this.#fallback(a, b);
            dx = this.#normalX;
            dy = this.#normalY;
        }
        const AVX = B.x[a] - ASX,
            AVY = B.y[a] - ASY,
            BVX = B.x[b] - BSX,
            BVY = B.y[b] - BSY,
            APPROACH_A = AVX * dx + AVY * dy,
            APPROACH_B = -(BVX * dx + BVY * dy);
        if (APPROACH_A > APPROACH_B) {
            return a;
        }
        if (APPROACH_B > APPROACH_A) {
            return b;
        }
        const MOVE_A = AVX * AVX + AVY * AVY,
            MOVE_B = BVX * BVX + BVY * BVY;
        if (MOVE_A > MOVE_B) {
            return a;
        }
        if (MOVE_B > MOVE_A) {
            return b;
        }
        return B.key[a] <= B.key[b] ? a : b;
    }

    // SOLID 한 pass: pass 시작 위치로 축 상자(|dx|, |dy| ≤ 반경 합)가 겹치는 쌍을 모아 (침투한 쪽 · (n + 1) + 상대) 오름차순으로
    // 차례로 완전히 밀어냅니다. 상대 위치는 pass 시작 자리, 자기 위치는 앞 쌍이 옮긴 자리입니다.
    #hardPass(maxRadius) {
        const B = this.#bodies,
            N = B.count,
            FP = this.#fp,
            R = this.#radiusFP,
            RELATIONS = this.#relations,
            GROUPS = this.#groups,
            SEG_X = this.#segX,
            SEG_Y = this.#segY,
            CANDIDATES = this.#candidates;
        for (let i = 0; i < N; i++) {
            SEG_X[i] = B.x[i];
            SEG_Y[i] = B.y[i];
        }
        this.#rebuildSeparationGrid();
        // 쌍 키 = 침투한 쪽 · (n + 1) + 상대 < (n + 1)^2. n < 2^24(격자 상한)이라 2^48 < 2^53, Float64에 정확합니다.
        const PAIR_BASE = N + 1;
        let count = 0;
        for (let i = 0; i < N; i++) {
            if (!(B.flags[i] & SEPARATE)) {
                continue;
            }
            const REACH = R[i] + maxRadius,
                COUNT = this.#grid.queryRectInto(
                    B.x[i] - REACH,
                    B.y[i] - REACH,
                    B.x[i] + REACH,
                    B.y[i] + REACH,
                    CANDIDATES,
                ),
                ROW = B.group[i] * GROUPS;
            for (let k = 0; k < COUNT; k++) {
                const J = CANDIDATES[k];
                if (J <= i || RELATIONS[ROW + B.group[J]] !== SOLID) {
                    continue;
                }
                const MIN = R[i] + R[J];
                if (Math.abs(B.x[i] - B.x[J]) > MIN || Math.abs(B.y[i] - B.y[J]) > MIN || this.#separated(i, J)) {
                    continue;
                }
                const OWNER = this.#owner(i, J);
                if (count >= this.#pairs.length) {
                    this.#growPairs(count * 2 + 64);
                }
                this.#pairs[count++] = OWNER * PAIR_BASE + (OWNER === i ? J : i);
            }
        }
        this.#sortPairs(count);
        const WIDTH = this.#width * FP,
            HEIGHT = this.#height * FP;
        let changed = 0;
        for (let q = 0; q < count; q++) {
            const PACKED = this.#pairs[q],
                I = Math.floor(PACKED / PAIR_BASE),
                J = PACKED - I * PAIR_BASE,
                MIN = R[I] + R[J],
                DX = B.x[I] - SEG_X[J],
                DY = B.y[I] - SEG_Y[J],
                D2 = DX * DX + DY * DY;
            if (D2 >= MIN * MIN) {
                continue;
            }
            let nx, ny, distance;
            if (D2 === 0) {
                this.#fallback(I, J);
                nx = this.#normalX;
                ny = this.#normalY;
                distance = 0;
            } else {
                distance = Math.max(1, Math.floor(Math.sqrt(D2)));
                nx = Math.trunc((DX * NORMAL_SCALE) / distance);
                ny = Math.trunc((DY * NORMAL_SCALE) / distance);
            }
            const PEN = MIN - distance + 1;
            B.x[I] = Math.min(Math.max(B.x[I] + Math.trunc((nx * PEN) / NORMAL_SCALE), R[I]), WIDTH - R[I]);
            B.y[I] = Math.min(Math.max(B.y[I] + Math.trunc((ny * PEN) / NORMAL_SCALE), R[I]), HEIGHT - R[I]);
            changed++;
        }
        if (changed) {
            this.#separationGridFresh = false;
        }
        return changed;
    }

    #growPairs(capacity) {
        const NEXT = new Float64Array(capacity);
        NEXT.set(this.#pairs);
        this.#pairs = NEXT;
        this.#pairsScratch = new Float64Array(capacity);
    }
    #sortPairs(length) {
        let from = this.#pairs,
            to = this.#pairsScratch;
        for (let width = 1; width < length; width *= 2) {
            for (let lo = 0; lo < length; lo += width * 2) {
                const MID = Math.min(lo + width, length),
                    HI = Math.min(lo + width * 2, length);
                let a = lo,
                    b = MID,
                    k = lo;
                while (a < MID && b < HI) {
                    to[k++] = from[a] <= from[b] ? from[a++] : from[b++];
                }
                while (a < MID) {
                    to[k++] = from[a++];
                }
                while (b < HI) {
                    to[k++] = from[b++];
                }
            }
            const SWAP = from;
            from = to;
            to = SWAP;
        }
        if (from !== this.#pairs) {
            for (let k = 0; k < length; k++) {
                this.#pairs[k] = from[k];
            }
        }
    }
}

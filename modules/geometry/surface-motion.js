// 장애물 장(ObstacleField) 위에서 원형 이동체를 목표로 옮기는 조정 이동입니다.
// 직선이 비어 있으면 그대로 가고, 막히면 가장 이른 접촉까지 가서 접촉면을 따라 미끄러집니다. 어디로 갈지는 정하지 않습니다.
// 틱마다 부르는 함수는 새 객체를 만들지 않습니다. 결과는 호출자가 준 `out`에 쓰고, 접촉 목록·체크포인트는 재사용합니다.
import {
    CONTACT_CIRCLE,
    CONTACT_POLYGON,
    CONTACT_WALL,
    ContactHit,
    ContactList,
    SurfaceContactGeometry,
    castEdgeInto,
    contactKey,
    offerContact,
    offerHit,
} from './contact.js';
import { clamp } from './math.js';

// 월드 경계의 접촉 키. 변 번호 0 왼쪽, 1 오른쪽, 2 위, 3 아래이고 이 순서가 같은 시각 동률·접촉 목록의 순서입니다.
const WALL_LEFT = contactKey(CONTACT_WALL, 0, 0),
    WALL_RIGHT = contactKey(CONTACT_WALL, 0, 1),
    WALL_TOP = contactKey(CONTACT_WALL, 0, 2),
    WALL_BOTTOM = contactKey(CONTACT_WALL, 0, 3);

function pushWall(list, distance, nx, ny, key, epsilon) {
    if (distance <= epsilon) {
        list.add(nx, ny, -distance, key, 0, null);
    }
}

function castWall(best, distance, velocity, nx, ny, key) {
    if (velocity >= -1e-8) {
        return;
    }
    const T = Math.max(0, -distance / velocity);
    if (T <= 1) {
        offerContact(best, T, nx, ny, key, null, false);
    }
}

// 접촉 목록을 키 오름차순으로 안정 정렬합니다(삽입 정렬: 목록은 몇 개뿐이고 새 배열·비교 함수가 없습니다).
function sortByKey(list) {
    const ITEMS = list.items;
    for (let i = 1; i < list.count; i++) {
        const C = ITEMS[i],
            KEY = C.key;
        let j = i - 1;
        while (j >= 0 && ITEMS[j].key > KEY) {
            ITEMS[j + 1] = ITEMS[j];
            j--;
        }
        ITEMS[j + 1] = C;
    }
}

// keep[i]가 1인 접촉만 앞으로 모읍니다(객체를 맞바꿔 목록이 가진 객체를 잃지 않습니다).
function compact(list, keep) {
    const ITEMS = list.items;
    let write = 0;
    for (let i = 0; i < list.count; i++) {
        if (keep[i] === 1) {
            if (write !== i) {
                const C = ITEMS[write];
                ITEMS[write] = ITEMS[i];
                ITEMS[i] = C;
            }
            write++;
        }
    }
    list.count = write;
}

/** {@link SurfaceMotion#solve}의 결과. 한 번 만들어 재사용합니다. */
export class MotionResult {
    x = 0;
    y = 0;
    /** 시작 자리가 막혀 있어 풀지 못했으면 false. */
    valid = true;
    /** 이동 중 장애물에 닿았는지. 닿았으면 `contact`가 처음 닿은 접촉입니다. */
    hit = false;
    contact = new ContactHit();
}

class Checkpoint {
    x = 0;
    y = 0;
    verified = false;
    ignoreId = null;
    signature = 0;
    epoch = 0;
}

export class SurfaceMotion {
    #epoch = 1;
    #list = new ContactList();
    #recoverList = new ContactList();
    #keep = new Uint8Array(16);
    #best = new ContactHit();
    #edge = new ContactHit();
    #scratch = new ContactHit();
    #point = { x: 0, y: 0 };
    #exterior = { x: 0, y: 0 };
    #slide = { x: 0, y: 0 };
    #deltaX = 0;
    #deltaY = 0;
    #deltaBest = Infinity;

    /**
     * @param {import('./obstacle-field.js').ObstacleField} field 장애물 장. 좌표 격자(`fixedPoint`)도 여기서 읽습니다.
     * @param {object} [options]
     * @param {(tieKey: number, contactKey: number, sign: number) => number} [options.tieRank]
     *   방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선, 부호 없는 32비트 정수). 순수 함수여야 합니다.
     *   기본은 {@link defaultTieRank}(정수 조합의 FNV-1a + fmix32)입니다.
     * @param {() => void} [options.sync] `solve`·`constrain`이 시작할 때 부르는 갱신 자리(장애물 지연 갱신 등).
     */
    constructor(field, { tieRank = null, sync = null } = {}) {
        this.field = field;
        this.tieRank = tieRank;
        this.sync = sync;
        this.checkpoints = new WeakMap();
    }

    round(value) {
        return Math.round(value * this.field.fixedPoint) / this.field.fixedPoint;
    }

    /** (x, y)에서 (tx, ty)로 가는 직선이 비어 있는지(제자리면 `departure` 없이, 움직이면 `departure`로 봅니다). */
    clear(x, y, tx, ty, r, ignoreId = null) {
        return this.field.segmentClear(x, y, tx, ty, r, ignoreId, x !== tx || y !== ty, 0);
    }

    /**
     * 지금 (x, y) 반지름 r 원이 닿았거나 `epsilon`(기본 고정소수 두 칸) 안으로 가까운 접촉 모두를 키 순서로 `list`에 채웁니다
     * (먼저 비움). 접촉마다 법선·깊이·키(+ 다각형이면 `distance`, 원 장애물이면 `obstacle`)이고 같은 접평면의 접촉은 가장
     * 깊은 하나만 남깁니다. 키는 다각형 < 원 장애물 < 월드 경계 순입니다.
     * @param {ContactList} list
     */
    contacts(x, y, r, ignoreId, list, epsilon = 2 / this.field.fixedPoint) {
        const FIELD = this.field;
        list.clear();
        const POLYGONS = FIELD.polygons.query(x, y, x, y, r + epsilon),
            POLYGON_INDEX = FIELD.polygons.found;
        for (let k = 0; k < POLYGONS.length; k++) {
            SurfaceContactGeometry.polygonContacts(x, y, r, POLYGONS[k].points, POLYGON_INDEX[k], epsilon, list);
        }
        const CIRCLES = FIELD.obstacles(x, y, x, y, r + epsilon, ignoreId);
        for (let k = 0; k < CIRCLES.length; k++) {
            const B = CIRCLES[k];
            if (B.id === ignoreId) {
                continue;
            }
            const DX = x - B.x,
                DY = y - B.y,
                D = Math.hypot(DX, DY),
                NEEDED = r + B.r;
            if (D <= NEEDED + epsilon) {
                list.add(
                    D > 1e-9 ? DX / D : 1,
                    D > 1e-9 ? DY / D : 0,
                    NEEDED - D,
                    contactKey(CONTACT_CIRCLE, B.id),
                    0,
                    B,
                );
            }
        }
        pushWall(list, x - r, 1, 0, WALL_LEFT, epsilon);
        pushWall(list, FIELD.width - r - x, -1, 0, WALL_RIGHT, epsilon);
        pushWall(list, y - r, 0, 1, WALL_TOP, epsilon);
        pushWall(list, FIELD.height - r - y, 0, -1, WALL_BOTTOM, epsilon);
        sortByKey(list);
        // 이웃한 절벽 조각은 같은 바깥 접평면을 설명하는 일이 많습니다. 앞선(지워진 것 포함) 접촉과 비교합니다.
        const ITEMS = list.items,
            KEEP = this.#keepFor(list.count);
        for (let i = 0; i < list.count; i++) {
            const C = ITEMS[i];
            KEEP[i] = 1;
            for (let j = 0; j < i; j++) {
                const N = ITEMS[j];
                if (Math.abs(C.nx - N.nx) + Math.abs(C.ny - N.ny) < 1e-7 && N.depth >= C.depth) {
                    KEEP[i] = 0;
                    break;
                }
            }
        }
        compact(list, KEEP);
        return list;
    }

    /** 원 장애물만 본 가장 이른 접촉을 `best`(비어 있으면 t = Infinity)에 제안합니다. */
    #offerCircles(best, x, y, vx, vy, r, ignoreId) {
        const CIRCLES = this.field.obstacles(x, y, x + vx, y + vy, r, ignoreId),
            SCRATCH = this.#scratch;
        for (let k = 0; k < CIRCLES.length; k++) {
            const B = CIRCLES[k];
            if (B.id === ignoreId) {
                continue;
            }
            if (
                SurfaceContactGeometry.circleCast(
                    x,
                    y,
                    vx,
                    vy,
                    B.x,
                    B.y,
                    r + B.r,
                    contactKey(CONTACT_CIRCLE, B.id),
                    B,
                    SCRATCH,
                )
            ) {
                offerHit(best, SCRATCH);
            }
        }
    }

    /**
     * 다각형·원 장애물·월드 경계 중 (vx, vy) 이동이 가장 먼저 닿는 접촉. 닿으면 true이고 `out`(ContactHit)에 씁니다.
     * 다각형 꼭짓점은 한 번만 봅니다(변 i의 끝 = 변 i + 1의 시작이고, 같은 시각이면 키가 작은 앞 변의 끝으로 기록).
     * @param {ContactHit} out
     */
    cast(x, y, vx, vy, r, ignoreId, out) {
        const FIELD = this.field,
            SLACK = FIELD.quantum,
            EDGE = this.#edge,
            SCRATCH = this.#scratch;
        out.t = Infinity;
        out.key = 0;
        const POLYGONS = FIELD.polygons.query(x, y, x + vx, y + vy, r),
            POLYGON_INDEX = FIELD.polygons.found;
        for (let k = 0; k < POLYGONS.length; k++) {
            const POINTS = POLYGONS[k].points,
                COUNT = POINTS.length,
                BASE = contactKey(CONTACT_POLYGON, POLYGON_INDEX[k]);
            // 길이가 0인 변은 시작 꼭짓점만 보므로 다음 변이 자기 시작 꼭짓점을 봅니다.
            let startSeen = false;
            for (let i = 0; i < COUNT; i++) {
                const A = POINTS[i],
                    B = POINTS[(i + 1) % COUNT],
                    DEGENERATE = Math.hypot(B.x - A.x, B.y - A.y) < 1e-9;
                EDGE.t = Infinity;
                EDGE.key = 0;
                castEdgeInto(
                    EDGE,
                    x,
                    y,
                    vx,
                    vy,
                    A.x,
                    A.y,
                    B.x,
                    B.y,
                    r,
                    BASE + i * 4,
                    SLACK,
                    !startSeen,
                    i !== COUNT - 1,
                    SCRATCH,
                );
                startSeen = !DEGENERATE;
                offerHit(out, EDGE);
            }
        }
        EDGE.t = Infinity;
        EDGE.key = 0;
        this.#offerCircles(EDGE, x, y, vx, vy, r, ignoreId);
        offerHit(out, EDGE);
        castWall(out, x - r, vx, 1, 0, WALL_LEFT);
        castWall(out, FIELD.width - r - x, -vx, -1, 0, WALL_RIGHT);
        castWall(out, y - r, vy, 0, 1, WALL_TOP);
        castWall(out, FIELD.height - r - y, -vy, 0, -1, WALL_BOTTOM);
        return out.t !== Infinity;
    }

    #keepFor(count) {
        if (this.#keep.length < count) {
            this.#keep = new Uint8Array(Math.max(count, this.#keep.length * 2));
        }
        return this.#keep;
    }

    // recover의 후보 이동 (px, py)가 모든 접촉을 풀면 가장 짧은 것으로 기억합니다.
    #consider(list, quantum, px, py) {
        const ITEMS = list.items;
        for (let i = 0; i < list.count; i++) {
            const C = ITEMS[i];
            if (px * C.nx + py * C.ny < C.depth + quantum - 1e-7) {
                return;
            }
        }
        const D = px * px + py * py;
        if (D < this.#deltaBest) {
            this.#deltaBest = D;
            this.#deltaX = px;
            this.#deltaY = py;
        }
    }

    /**
     * 이미 겹쳐 버린 원을 가장 가까운 빈 자리로 옮겨 `out`에 씁니다. 겹침이 없거나 옮길 수 없으면 제자리입니다.
     * 지형이나 다른 장애물을 가로질러 건너가는 일은 없습니다.
     * @param {{x: number, y: number}} out
     */
    recover(x, y, r, ignoreId, out) {
        const FIELD = this.field,
            QUANTUM = FIELD.quantum;
        out.x = x;
        out.y = y;
        if (this.clear(x, y, x, y, r, ignoreId)) {
            return out;
        }
        if (FIELD.polygonCircleClear(x, y, r)) {
            // 새로 놓인 고체가 멈춘 원을 덮었을 수 있습니다. 가장 가까운 빈 자리로 한 걸음 옮기되, 지형이나
            // 다른 장애물을 가로지르지 않도록 단조로운 이탈 이동만 받아들입니다.
            const P = this.#exterior;
            if (FIELD.nearestExterior(x, y, r, ignoreId, P)) {
                const END_X = this.round(P.x),
                    END_Y = this.round(P.y);
                if (
                    this.clear(END_X, END_Y, END_X, END_Y, r, ignoreId) &&
                    FIELD.departureClear(x, y, END_X, END_Y, r, ignoreId)
                ) {
                    out.x = END_X;
                    out.y = END_Y;
                }
            }
            return out;
        }
        const LIST = this.#recoverList;
        let remaining = r,
            px = x,
            py = y;
        for (let pass = 0; pass < 4; pass++) {
            this.contacts(px, py, r, ignoreId, LIST, 0);
            const KEEP = this.#keepFor(LIST.count);
            for (let i = 0; i < LIST.count; i++) {
                KEEP[i] = LIST.items[i].depth > QUANTUM ? 1 : 0;
            }
            compact(LIST, KEEP);
            if (!LIST.count) {
                break;
            }
            this.#deltaBest = Infinity;
            const ITEMS = LIST.items;
            for (let i = 0; i < LIST.count; i++) {
                const C = ITEMS[i];
                this.#consider(LIST, QUANTUM, C.nx * (C.depth + QUANTUM), C.ny * (C.depth + QUANTUM));
            }
            for (let i = 0; i < LIST.count; i++) {
                for (let j = i + 1; j < LIST.count; j++) {
                    const A = ITEMS[i],
                        B = ITEMS[j],
                        DEN = A.nx * B.ny - A.ny * B.nx;
                    if (Math.abs(DEN) < 1e-8) {
                        continue;
                    }
                    const AD = A.depth + QUANTUM,
                        BD = B.depth + QUANTUM;
                    this.#consider(LIST, QUANTUM, (AD * B.ny - A.ny * BD) / DEN, (A.nx * BD - AD * B.nx) / DEN);
                }
            }
            if (this.#deltaBest === Infinity || Math.sqrt(this.#deltaBest) > remaining + 1e-7) {
                return out;
            }
            const D = Math.sqrt(this.#deltaBest);
            px += this.#deltaX;
            py += this.#deltaY;
            remaining -= D;
            if (remaining <= 0) {
                break;
            }
        }
        if (this.clear(px, py, px, py, r, ignoreId)) {
            out.x = px;
            out.y = py;
        }
        return out;
    }

    /**
     * (x, y)에서 (tx, ty)까지 이동하되 끝점을 고정소수 격자에 반올림해 비어 있는 곳까지만 가서 `out`에 씁니다.
     * `whole`이 true면 끝까지 갈 수 있을 때만 끝점을 쓰고 true, 아니면 `out`을 건드리지 않고 false를 돌려줍니다.
     * false면 갈 수 있는 끝까지 이분 탐색(18회)하고 true입니다.
     * @param {{x: number, y: number}} out
     */
    advance(x, y, tx, ty, r, ignoreId, whole, out) {
        const END_X = this.round(tx),
            END_Y = this.round(ty);
        if (this.field.segmentClear(x, y, END_X, END_Y, r, ignoreId, !whole && (x !== END_X || y !== END_Y), 0)) {
            out.x = END_X;
            out.y = END_Y;
            return true;
        }
        if (whole) {
            return false;
        }
        // 반올림 뒤에도 이 구간 안에서만 물러납니다.
        let lo = 0,
            hi = 1,
            safeX = this.round(x),
            safeY = this.round(y);
        for (let i = 0; i < 18; i++) {
            const T = (lo + hi) / 2,
                PX = this.round(x + (tx - x) * T),
                PY = this.round(y + (ty - y) * T);
            if (this.clear(x, y, PX, PY, r, ignoreId)) {
                lo = T;
                safeX = PX;
                safeY = PY;
            } else {
                hi = T;
            }
        }
        out.x = safeX;
        out.y = safeY;
        return true;
    }

    /**
     * 반지름 r인 원을 (x, y)에서 (tx, ty)로 옮긴 결과를 `out`({@link MotionResult})에 씁니다. `out.hit`이면 `out.contact`가
     * 처음 닿은 접촉입니다. 시작 자리가 막혀 있어 풀 수 없으면 `out.valid`가 false입니다.
     * `mode`: `'steer'`는 닿은 뒤 접촉면을 따라 목표 쪽으로 미끄러지고(속도는 유지), `'stop'`은 닿는 자리에서 멈추고,
     * 그 밖의 값(`'project'`)은 접촉면에 사영한 만큼만 미끄러집니다. `tieKey`(0 이상 안전 정수)는 동률 순위의 입력입니다.
     * @param {MotionResult} out
     */
    solve(x, y, tx, ty, r, ignoreId, mode, tieKey, out) {
        this.sync?.();
        out.valid = true;
        out.hit = false;
        if (this.advance(x, y, tx, ty, r, ignoreId, true, out)) {
            return out;
        }
        const POINT = this.#point;
        this.recover(x, y, r, ignoreId, POINT);
        let px = POINT.x,
            py = POINT.y;
        if (!this.clear(px, py, px, py, r, ignoreId)) {
            out.x = px;
            out.y = py;
            out.valid = false;
            return out;
        }
        const CONTACT = this.#best,
            LIST = this.#list,
            SLIDE = this.#slide;
        let rx = tx - x,
            ry = ty - y,
            remaining = Math.hypot(rx, ry);
        for (let pass = 0; pass < 8 && remaining > 1e-7; pass++) {
            if (!this.cast(px, py, rx, ry, r, ignoreId, CONTACT)) {
                this.advance(px, py, px + rx, py + ry, r, ignoreId, false, POINT);
                px = POINT.x;
                py = POINT.y;
                break;
            }
            if (!out.hit) {
                out.hit = true;
                const FIRST = out.contact;
                FIRST.t = CONTACT.t;
                FIRST.nx = CONTACT.nx;
                FIRST.ny = CONTACT.ny;
                FIRST.key = CONTACT.key;
                FIRST.obstacle = CONTACT.obstacle;
                FIRST.degenerate = CONTACT.degenerate;
            }
            const T = clamp(CONTACT.t, 0, 1);
            this.advance(px, py, px + rx * T, py + ry * T, r, ignoreId, false, POINT);
            const SPENT = Math.hypot(POINT.x - px, POINT.y - py);
            px = POINT.x;
            py = POINT.y;
            remaining = Math.max(0, remaining - SPENT);
            if (mode === 'stop' || remaining < 1e-7) {
                break;
            }
            this.contacts(px, py, r, ignoreId, LIST);
            let same = false;
            for (let i = 0; i < LIST.count; i++) {
                const N = LIST.items[i];
                if (Math.abs(N.nx - CONTACT.nx) + Math.abs(N.ny - CONTACT.ny) < 1e-7) {
                    same = true;
                    break;
                }
            }
            if (!same) {
                LIST.add(CONTACT.nx, CONTACT.ny, 0, CONTACT.key, 0, CONTACT.obstacle);
            }
            SurfaceContactGeometry.slide(
                rx * (1 - T),
                ry * (1 - T),
                LIST,
                remaining,
                mode === 'steer',
                tx - px,
                ty - py,
                tieKey,
                this.tieRank,
                SLIDE,
            );
            const LEN = Math.hypot(SLIDE.x, SLIDE.y);
            if (LEN < 1e-7) {
                break;
            }
            if (SPENT < 1e-7 && Math.abs(SLIDE.x - rx) + Math.abs(SLIDE.y - ry) < 1e-8) {
                break;
            }
            rx = SLIDE.x;
            ry = SLIDE.y;
            remaining = Math.min(remaining, LEN);
        }
        out.x = px;
        out.y = py;
        return out;
    }

    /**
     * 마지막으로 위치를 확인한 체크포인트를 기록합니다(`verified`가 true면 그 자리는 장애물과 겹치지 않음이 확인된 것).
     * 체크포인트는 `ignoreId`와 이 시점의 {@link ObstacleField#version}도 함께 기억합니다. 몸체마다 기록 객체 하나를 재사용합니다.
     */
    remember(body, x, y, verified = true, ignoreId = null) {
        let checkpoint = this.checkpoints.get(body);
        if (checkpoint === undefined) {
            checkpoint = new Checkpoint();
            this.checkpoints.set(body, checkpoint);
        }
        checkpoint.x = x;
        checkpoint.y = y;
        checkpoint.verified = verified;
        checkpoint.ignoreId = ignoreId;
        checkpoint.signature = this.field.version;
        checkpoint.epoch = this.#epoch;
    }

    /** 모든 체크포인트를 잊습니다(한 이동 단계가 시작될 때). 세대 번호만 올리고 기록 객체는 다음 `remember`가 재사용합니다. */
    forgetAll() {
        this.#epoch++;
    }

    /**
     * 몸체가 다른 힘으로 (x, y)까지 옮겨진 뒤, 마지막 체크포인트에서 그 자리까지를 `'project'`로 다시 풀어 장애물 안으로
     * 들어가지 않게 합니다. 체크포인트가 확인된 자리·같은 `ignoreId`·같은 장애물 버전이고 몸체가 안 움직였으면 false,
     * 아니면 `solve` 결과를 `out`에 쓰고 true를 돌려줍니다. 결과를 몸체에 쓰고 `remember`하는 일은 호출자가 합니다.
     * @param {MotionResult} out
     */
    constrain(body, x, y, r, ignoreId, tieKey, out) {
        this.sync?.();
        const S = this.checkpoints.get(body);
        if (S === undefined || S.epoch !== this.#epoch) {
            this.solve(x, y, x, y, r, ignoreId, 'project', tieKey, out);
            return true;
        }
        if (S.verified && S.ignoreId === ignoreId && S.signature === this.field.version && S.x === x && S.y === y) {
            return false;
        }
        this.solve(S.x, S.y, x, y, r, ignoreId, 'project', tieKey, out);
        return true;
    }
}

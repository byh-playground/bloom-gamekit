// 움직이는 원과 정적 장애물의 접촉입니다. 어디로 갈지(길찾기)는 정하지 않고, 이미 정해진 이동 벡터가
// 장애물에 닿는 시각·법선과 닿은 뒤 미끄러질 방향만 계산합니다. 시간·난수를 읽지 않습니다.
// 틱마다 부르는 함수는 새 객체를 만들지 않습니다: 결과는 호출자가 준 `out`에 쓰고, 접촉 목록은 `ContactList`가 객체를 재사용합니다.
import { clamp, pointInSimplePolygon } from './math.js';

// 접촉 키는 (종류, 장애물 번호, 변 번호, 부위) 정수 조합 하나입니다.
// 키 = 종류 · 2^50 + 장애물 · 2^22 + 변 · 4 + 부위. 종류 < 4, 장애물 < 2^28, 변 < 2^20, 부위 < 4라 키 < 2^52(안전 정수)입니다.
const KIND_SCALE = 2 ** 50;
const OBSTACLE_SCALE = 2 ** 22;
const WORD = 2 ** 32;
/** 접촉 키의 장애물 번호 상한(포함). */
export const CONTACT_MAX_OBSTACLE = 2 ** 28 - 1;
/** 접촉 키의 변 번호 상한(포함). */
export const CONTACT_MAX_EDGE = 2 ** 20 - 1;
/** 접촉 키 종류: 다각형 장애물(장애물 번호 = 다각형 색인의 항목 번호). */
export const CONTACT_POLYGON = 0;
/** 접촉 키 종류: 원 장애물(장애물 번호 = 원의 정수 `id`). */
export const CONTACT_CIRCLE = 1;
/** 접촉 키 종류: 월드 경계(변 번호 0 왼쪽, 1 오른쪽, 2 위, 3 아래). */
export const CONTACT_WALL = 2;
/** 접촉 키 종류: 게임이 직접 만드는 접촉(예: 유닛 쌍). */
export const CONTACT_USER = 3;
/** 접촉 키 부위: 변(선분) 자체. */
export const CONTACT_EDGE = 0;
/** 접촉 키 부위: 변의 시작 꼭짓점. */
export const CONTACT_START = 1;
/** 접촉 키 부위: 변의 끝 꼭짓점. */
export const CONTACT_END = 2;

/**
 * 접촉 키 하나를 만듭니다. 키가 작을수록 같은 시각 동률에서 앞서고 접촉 목록에서 먼저 옵니다.
 * @param {number} kind `CONTACT_POLYGON`·`CONTACT_CIRCLE`·`CONTACT_WALL`·`CONTACT_USER`(0..3)
 * @param {number} obstacle 0..`CONTACT_MAX_OBSTACLE` 정수
 * @param {number} [edge] 0..`CONTACT_MAX_EDGE` 정수
 * @param {number} [part] `CONTACT_EDGE`·`CONTACT_START`·`CONTACT_END`(0..3)
 */
export function contactKey(kind, obstacle, edge = 0, part = 0) {
    return kind * KIND_SCALE + obstacle * OBSTACLE_SCALE + edge * 4 + part;
}

// FNV-1a 32비트 곱셈 한 단계를 32비트 낱말 하나에 적용합니다.
function mixWord(h, word) {
    return Math.imul(h ^ word, 16777619);
}

// 동률을 가르는 기본 순위: (tieKey, contactKey, sign)을 32비트 낱말 다섯 개(tieKey 하위·상위, contactKey 하위·상위,
// sign 양수면 1)로 나눠 FNV-1a로 섞고 murmur3 fmix32로 마무리한 부호 없는 32비트 정수입니다. 정수 연산만 쓰므로
// 플랫폼과 무관합니다. 바꾸면 결과가 달라지는 계약입니다.
export function defaultTieRank(tieKey, contactKeyValue, sign) {
    if (!Number.isSafeInteger(tieKey) || tieKey < 0 || !Number.isSafeInteger(contactKeyValue) || contactKeyValue < 0) {
        throw new TypeError(
            `tieRank needs non-negative safe integers (tieKey ${tieKey}, contactKey ${contactKeyValue}).`,
        );
    }
    const TIE_LOW = tieKey % WORD,
        KEY_LOW = contactKeyValue % WORD;
    let h = 2166136261;
    h = mixWord(h, TIE_LOW);
    h = mixWord(h, (tieKey - TIE_LOW) / WORD);
    h = mixWord(h, KEY_LOW);
    h = mixWord(h, (contactKeyValue - KEY_LOW) / WORD);
    h = mixWord(h, sign > 0 ? 1 : 0);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** 이동이 처음 닿은 접촉. `cast` 계열 함수가 채웁니다. */
export class ContactHit {
    /** 닿는 시각(0..1). 닿지 않았으면 Infinity로 둡니다. */
    t = Infinity;
    nx = 0;
    ny = 0;
    /** 접촉 키(정수, {@link contactKey}). */
    key = 0;
    /** 원 장애물에 닿았으면 그 원, 아니면 null. */
    obstacle = null;
    /** 법선이 0에 가까워 기본 법선 (1, 0)을 쓴 경우 true. 호출자가 대체 법선을 채웁니다. */
    degenerate = false;
}

/** 더 이른(같은 시각이면 키가 작은) 접촉을 고릅니다. 시각 동률은 1e-10 안쪽입니다. */
export function earlierContact(best, hit) {
    return hit && (!best || hit.t < best.t - 1e-10 || (Math.abs(hit.t - best.t) <= 1e-10 && hit.key < best.key))
        ? hit
        : best;
}

// `best`(t가 Infinity면 비어 있음)보다 이르면 덮어씁니다. earlierContact와 같은 비교입니다.
export function offerContact(best, t, nx, ny, key, obstacle, degenerate) {
    if (t < best.t - 1e-10 || (Math.abs(t - best.t) <= 1e-10 && key < best.key)) {
        best.t = t;
        best.nx = nx;
        best.ny = ny;
        best.key = key;
        best.obstacle = obstacle;
        best.degenerate = degenerate;
    }
}

// 다른 ContactHit의 값을 `best`에 제안합니다.
export function offerHit(best, hit) {
    if (hit.t !== Infinity) {
        offerContact(best, hit.t, hit.nx, hit.ny, hit.key, hit.obstacle, hit.degenerate);
    }
}

/** 접촉 하나: 법선(원이 밀려날 방향)·깊이·키(+ 다각형이면 거리, 원 장애물이면 그 원). */
export class SurfaceContact {
    nx = 0;
    ny = 0;
    depth = 0;
    key = 0;
    distance = 0;
    obstacle = null;
}

/**
 * 재사용하는 접촉 목록입니다. `items[0..count)`가 유효하고, `clear()` 뒤 `add()`는 이전 객체를 덮어씁니다.
 * 담긴 객체를 보관하려면 복사하세요.
 */
export class ContactList {
    /** @type {SurfaceContact[]} */
    items = [];
    count = 0;

    clear() {
        this.count = 0;
        return this;
    }

    /** 접촉 하나를 끝에 넣고 그 객체를 돌려줍니다. */
    add(nx, ny, depth = 0, key = 0, distance = 0, obstacle = null) {
        let contact = this.items[this.count];
        if (contact === undefined) {
            contact = this.items[this.count] = new SurfaceContact();
        }
        contact.nx = nx;
        contact.ny = ny;
        contact.depth = depth;
        contact.key = key;
        contact.distance = distance;
        contact.obstacle = obstacle;
        this.count++;
        return contact;
    }
}

const POLICIES = Object.freeze({
    // 정적 표면(다각형·원 장애물·월드 경계)에 대한 이동. 표면에 이미 닿아 있으면 안쪽으로 들어갈 때만 접촉입니다.
    surface: Object.freeze({
        minSpeed2: 1e-16,
        contactDistanceEpsilon: 1e-8,
        normalEpsilon: 1e-10,
        inwardEpsilon: 1e-8,
        discriminantEpsilon: 1e-12,
        includeTangent: false,
        retreat: 0,
    }),
    // 움직이는 두 원의 상대 이동. 닿는 순간보다 `retreat`만큼 일찍 멈추고 접선도 접촉으로 칩니다.
    relative: Object.freeze({
        minSpeed2: 1e-9,
        contactSquaredEpsilon: 1e-7,
        normalEpsilon: 1e-6,
        inwardEpsilon: 0,
        discriminantEpsilon: 0,
        includeTangent: true,
        retreat: 0.0005,
    }),
});

export class SweptCircleContact {
    /** `cast`에 넘기는 정책. 사용자 정책 객체도 같은 필드를 갖추면 됩니다. */
    static policies = POLICIES;

    /**
     * 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy) 한 틱(t: 0~1) 동안 반지름 r인 원 안에 처음 들어가는지.
     * 닿으면 true이고 `out.t`·`out.nx`·`out.ny`·`out.degenerate`를 씁니다. 닿지 않으면 false이고 `out`을 건드리지 않습니다.
     * 법선이 0에 가까우면 `out.degenerate = true`, 법선 (1, 0)을 씁니다. 대체 법선이 필요하면 호출자가 그때만 채웁니다.
     * @param {{t: number, nx: number, ny: number, degenerate: boolean}} out
     */
    static cast(rx, ry, vx, vy, r, policy, out) {
        const AA = vx * vx + vy * vy,
            RADIAL = rx * vx + ry * vy,
            C = rx * rx + ry * ry - r * r;
        const DISTANCE_POLICY = policy.contactDistanceEpsilon != null,
            LENGTH = DISTANCE_POLICY ? Math.hypot(rx, ry) : 0;
        if (DISTANCE_POLICY && AA < policy.minSpeed2) {
            return false;
        }
        const CONTACT = DISTANCE_POLICY
            ? LENGTH <= r + policy.contactDistanceEpsilon
            : C <= policy.contactSquaredEpsilon;
        let t = 0;
        if (CONTACT) {
            const INWARD = DISTANCE_POLICY
                ? vx * (LENGTH > policy.normalEpsilon ? rx / LENGTH : 1) +
                  vy * (LENGTH > policy.normalEpsilon ? ry / LENGTH : 0)
                : RADIAL;
            if (INWARD >= -policy.inwardEpsilon) {
                return false;
            }
        } else {
            if (DISTANCE_POLICY ? AA < policy.minSpeed2 : AA <= policy.minSpeed2) {
                return false;
            }
            const DISC = RADIAL * RADIAL - AA * C;
            if (policy.includeTangent ? DISC < policy.discriminantEpsilon : DISC <= policy.discriminantEpsilon) {
                return false;
            }
            if (DISTANCE_POLICY && RADIAL >= 0) {
                return false;
            }
            const ENTER = (-RADIAL - Math.sqrt(DISC)) / AA;
            if (ENTER < 0 || ENTER > 1) {
                return false;
            }
            t = Math.max(0, ENTER - policy.retreat);
        }
        const QX = rx + vx * t,
            QY = ry + vy * t,
            L = Math.hypot(QX, QY);
        out.t = t;
        if (L > policy.normalEpsilon) {
            out.nx = QX / L;
            out.ny = QY / L;
            out.degenerate = false;
        } else {
            out.nx = 1;
            out.ny = 0;
            out.degenerate = true;
        }
        return true;
    }
}

// 정적 원 (cx, cy, r)에 대한 접촉을 `best`에 제안합니다.
function offerCircle(best, x, y, vx, vy, cx, cy, r, key, obstacle, scratch) {
    if (SweptCircleContact.cast(x - cx, y - cy, vx, vy, r, POLICIES.surface, scratch)) {
        offerContact(best, scratch.t, scratch.nx, scratch.ny, key, obstacle, scratch.degenerate);
    }
}

// 선분 a-b(양 끝 원 포함)의 접촉을 비어 있는 `best`에 채웁니다. `testStart`·`testEnd`가 false인 끝 원은 건너뜁니다
// (다각형에서 이웃 변이 같은 꼭짓점을 이미 본 경우). 키: 변 = key, 시작 = key + 1, 끝 = key + 2. 길이가 0인 변은 시작 원 하나를 key로.
export function castEdgeInto(best, x, y, vx, vy, ax, ay, bx, by, r, key, slack, testStart, testEnd, scratch) {
    const DX = bx - ax,
        DY = by - ay,
        LEN = Math.hypot(DX, DY);
    if (LEN < 1e-9) {
        offerCircle(best, x, y, vx, vy, ax, ay, r, key, null, scratch);
        return;
    }
    const EX = DX / LEN,
        EY = DY / LEN,
        NX = -EY,
        NY = EX;
    const SIGNED = (x - ax) * NX + (y - ay) * NY,
        VN = vx * NX + vy * NY;
    for (let k = 0; k < 2; k++) {
        const SIDE = k === 0 ? -1 : 1;
        if (SIDE * VN >= -1e-8) {
            continue;
        }
        let t = (r - SIDE * SIGNED) / (SIDE * VN);
        if (t < 0 && SIDE * SIGNED >= r - slack) {
            t = 0;
        }
        if (t < 0 || t > 1) {
            continue;
        }
        const ALONG = (x + vx * t - ax) * EX + (y + vy * t - ay) * EY;
        if (ALONG >= -1e-8 && ALONG <= LEN + 1e-8) {
            offerContact(best, t, NX * SIDE, NY * SIDE, key + CONTACT_EDGE, null, false);
        }
    }
    if (testStart) {
        offerCircle(best, x, y, vx, vy, ax, ay, r, key + CONTACT_START, null, scratch);
    }
    if (testEnd) {
        offerCircle(best, x, y, vx, vy, bx, by, r, key + CONTACT_END, null, scratch);
    }
}

const SCRATCH = new ContactHit();

export class SurfaceContactGeometry {
    /** 선분 AB 위에서 (x, y)에 가장 가까운 점을 `out`에 씁니다. */
    static closest(ax, ay, bx, by, x, y, out) {
        const DX = bx - ax,
            DY = by - ay,
            L2 = DX * DX + DY * DY,
            T = L2 ? clamp(((x - ax) * DX + (y - ay) * DY) / L2, 0, 1) : 0;
        out.x = ax + DX * T;
        out.y = ay + DY * T;
        return out;
    }

    /**
     * 원 (x, y)가 속도 (vx, vy)로 움직일 때 고정된 원 (cx, cy, 반지름 r)에 닿으면 true이고 `out`(ContactHit 모양)에
     * t·법선·`key`·`obstacle`을 씁니다. 닿지 않으면 false입니다.
     */
    static circleCast(x, y, vx, vy, cx, cy, r, key, obstacle, out) {
        out.t = Infinity;
        offerCircle(out, x, y, vx, vy, cx, cy, r, key, obstacle, SCRATCH);
        return out.t !== Infinity;
    }

    /**
     * 원 (x, y, 반지름 r)이 속도 (vx, vy)로 움직일 때 선분 (ax, ay)-(bx, by)(양 끝 원 포함)에 닿는 가장 이른 접촉.
     * 닿으면 true이고 `out`에 씁니다. 키는 변이면 `key`, 시작 꼭짓점이면 `key + 1`, 끝 꼭짓점이면 `key + 2`이므로 `key`는
     * 4의 배수(보통 {@link contactKey}의 부위 0)로 줍니다. `slack`은 이미 선분에서 그만큼(보통 고정소수 한 칸) 안쪽에
     * 들어와 있어도 t = 0 접촉으로 치는 허용 거리입니다.
     */
    static edgeCast(x, y, vx, vy, ax, ay, bx, by, r, key, slack, out) {
        out.t = Infinity;
        castEdgeInto(out, x, y, vx, vy, ax, ay, bx, by, r, key, slack, true, true, SCRATCH);
        return out.t !== Infinity;
    }

    /**
     * 원 (x, y, 반지름 r)이 다각형 `points`(꼭짓점 배열)와 이미 닿았거나 `epsilon` 안으로 가까운 접촉을 `list` 뒤에 넣습니다.
     * 접촉 키는 `contactKey(CONTACT_POLYGON, polygon, 변 번호)`이고 법선은 원이 밀려날 방향입니다. 원 중심이 다각형 안에
     * 있으면 가장 가까운 가장자리 하나만 넣습니다. `list`를 돌려줍니다.
     * @param {ContactList} list
     */
    static polygonContacts(x, y, r, points, polygon, epsilon, list) {
        const INSIDE = pointInSimplePolygon(x, y, points),
            COUNT = points.length;
        let nearestD = -1,
            nearestNx = 0,
            nearestNy = 0,
            nearestEdge = 0;
        for (let i = 0; i < COUNT; i++) {
            const A = points[i],
                B = points[(i + 1) % COUNT];
            const EX = B.x - A.x,
                EY = B.y - A.y,
                L2 = EX * EX + EY * EY,
                T = L2 ? clamp(((x - A.x) * EX + (y - A.y) * EY) / L2, 0, 1) : 0;
            const DX = x - (A.x + EX * T),
                DY = y - (A.y + EY * T),
                D = Math.hypot(DX, DY);
            if (INSIDE ? nearestD >= 0 && !(D < nearestD) : !(D <= r + epsilon)) {
                continue;
            }
            let nx, ny;
            if (D > 1e-9) {
                const SIGN = INSIDE ? -1 : 1;
                nx = (SIGN * DX) / D;
                ny = (SIGN * DY) / D;
            } else {
                // 중심이 가장자리 위에 있으면 다각형 감김 방향으로 바깥쪽을 정합니다.
                let area = 0;
                for (let j = 0; j < COUNT; j++) {
                    const V = points[j],
                        W = points[(j + 1) % COUNT];
                    area = area + V.x * W.y - W.x * V.y;
                }
                const LEN = Math.hypot(B.x - A.x, B.y - A.y) || 1,
                    SIGN = area >= 0 ? 1 : -1;
                nx = ((B.y - A.y) / LEN) * SIGN;
                ny = (-(B.x - A.x) / LEN) * SIGN;
            }
            if (INSIDE) {
                nearestD = D;
                nearestNx = nx;
                nearestNy = ny;
                nearestEdge = i;
            } else {
                list.add(nx, ny, r - D, contactKey(CONTACT_POLYGON, polygon, i), D, null);
            }
        }
        if (INSIDE && nearestD >= 0) {
            list.add(
                nearestNx,
                nearestNy,
                r + nearestD,
                contactKey(CONTACT_POLYGON, polygon, nearestEdge),
                nearestD,
                null,
            );
        }
        return list;
    }

    /** 속도 (x, y)가 `list`의 모든 접촉 법선에서 밀려나는 쪽이거나 평행(허용 -1e-7)인지. */
    static feasible(x, y, list) {
        return feasibleAt(x, y, list);
    }

    /**
     * 원하는 이동 (vx, vy)를 모든 접촉에 위배되지 않는 가장 가까운 이동으로 바꿔 `out`에 씁니다.
     * 이미 가능하면 그대로, 접촉 하나의 접평면에 사영해 가능한 것 중 가장 덜 바뀐 것, 없으면 정지 (0, 0)입니다.
     * @param {ContactList} list
     * @param {{x: number, y: number}} out
     */
    static project(vx, vy, list, out) {
        if (feasibleAt(vx, vy, list)) {
            out.x = vx;
            out.y = vy;
            return out;
        }
        const ITEMS = list.items,
            COUNT = list.count;
        let bestX = 0,
            bestY = 0,
            cost = vx * vx + vy * vy;
        for (let i = 0; i < COUNT; i++) {
            const N = ITEMS[i],
                DOT = vx * N.nx + vy * N.ny,
                PX = vx - N.nx * DOT,
                PY = vy - N.ny * DOT;
            if (!feasibleAt(PX, PY, list)) {
                continue;
            }
            const D = (PX - vx) ** 2 + (PY - vy) ** 2;
            if (D < cost - 1e-12) {
                bestX = PX;
                bestY = PY;
                cost = D;
            }
        }
        out.x = bestX;
        out.y = bestY;
        return out;
    }

    /**
     * 접촉에 막힌 이동 (vx, vy)를 `budget` 길이 안에서 미끄러뜨린 이동을 `out`에 씁니다.
     * `steer`가 false면 사영 결과 그대로(바깥 힘은 새 옆 방향 충격을 얻지 않습니다), true면 사영 결과가 거의 0일 때
     * (`goalX`, `goalY`)에 가장 맞는 접선 방향을 골라 `budget` 길이로 늘립니다. 방향 점수가 같으면 `tieRank(tieKey,
     * 접촉 키, 부호)`가 낮은 쪽이 이깁니다(`tieRank`가 null이면 {@link defaultTieRank}). `tieKey`는 0 이상 안전 정수입니다.
     * @param {number} vx
     * @param {number} vy
     * @param {ContactList} list
     * @param {number} budget
     * @param {boolean} steer
     * @param {number} goalX
     * @param {number} goalY
     * @param {number} tieKey
     * @param {((tieKey: number, contactKey: number, sign: number) => number) | null} tieRank
     * @param {{x: number, y: number}} out
     */
    static slide(vx, vy, list, budget, steer, goalX, goalY, tieKey, tieRank, out) {
        if (budget < 1e-8) {
            out.x = 0;
            out.y = 0;
            return out;
        }
        this.project(vx, vy, list, out);
        if (!steer) {
            return out; // 바깥 힘은 새 옆 방향 충격을 얻지 않습니다.
        }
        let px = out.x,
            py = out.y,
            len = Math.hypot(px, py);
        if (len < budget * 0.035) {
            const RANK = tieRank ?? defaultTieRank,
                ITEMS = list.items,
                COUNT = list.count;
            let bestX = 0,
                bestY = 0,
                found = false,
                score = -Infinity,
                tie = Infinity;
            for (let i = 0; i < COUNT; i++) {
                const C = ITEMS[i];
                for (let k = 0; k < 2; k++) {
                    const SIGN = k === 0 ? -1 : 1;
                    const QX = -C.ny * SIGN,
                        QY = C.nx * SIGN;
                    if (!feasibleAt(QX, QY, list)) {
                        continue;
                    }
                    const VALUE = QX * goalX + QY * goalY;
                    if (VALUE < -1e-7) {
                        continue;
                    }
                    // 순위는 방향 점수가 앞서거나 동률일 때만 필요합니다.
                    if (VALUE > score + 1e-7) {
                        bestX = QX;
                        bestY = QY;
                        found = true;
                        score = VALUE;
                        tie = RANK(tieKey, C.key, SIGN) >>> 0;
                    } else if (Math.abs(VALUE - score) <= 1e-7) {
                        const VALUE_RANK = RANK(tieKey, C.key, SIGN) >>> 0;
                        if (VALUE_RANK < tie) {
                            bestX = QX;
                            bestY = QY;
                            found = true;
                            score = VALUE;
                            tie = VALUE_RANK;
                        }
                    }
                }
            }
            if (!found) {
                out.x = 0;
                out.y = 0;
                return out;
            }
            px = bestX;
            py = bestY;
            len = 1;
        }
        if (len > 1e-8) {
            out.x = (px / len) * budget;
            out.y = (py / len) * budget;
        } else {
            out.x = 0;
            out.y = 0;
        }
        return out;
    }
}

function feasibleAt(x, y, list) {
    const ITEMS = list.items,
        COUNT = list.count;
    for (let i = 0; i < COUNT; i++) {
        if (!(x * ITEMS[i].nx + y * ITEMS[i].ny >= -1e-7)) {
            return false;
        }
    }
    return true;
}

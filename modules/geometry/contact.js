// 움직이는 원과 정적 장애물의 접촉입니다. 어디로 갈지(길찾기)는 정하지 않고, 이미 정해진 이동 벡터가
// 장애물에 닿는 시각·법선과 닿은 뒤 미끄러질 방향만 계산합니다. 시간·난수를 읽지 않습니다.
import { clamp, pointInSimplePolygon } from './math.js';

// 동률을 가르는 기본 순위: tieKey|contactKey|sign 문자열의 FNV-1a 32비트 해시. 바꾸면 결과가 달라지는 계약입니다.
function defaultTieRank(tieKey, contactKey, sign) {
    const TEXT = tieKey + '|' + contactKey + '|' + sign;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < TEXT.length; i++) {
        h ^= TEXT.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// 더 이른(같은 시각이면 키가 작은) 접촉을 고릅니다. 시각 동률은 1e-10 안쪽입니다.
export function earlierContact(best, hit) {
    return hit && (!best || hit.t < best.t - 1e-10 || (Math.abs(hit.t - best.t) <= 1e-10 && hit.key < best.key))
        ? hit
        : best;
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
     * 원점의 점이 상대 위치 (rx, ry)에서 속도 (vx, vy) 한 틱(t: 0~1) 동안 반지름 r인 원 안에 처음 들어가는 시각과 법선.
     * 닿지 않으면 null입니다. 법선이 0에 가까우면 `fallback()`이 돌려주는 `{x, y}`(없으면 `{x: 1, y: 0}`)를 씁니다.
     * @returns {{t: number, nx: number, ny: number} | null}
     */
    static cast(rx, ry, vx, vy, r, policy, fallback = null) {
        const AA = vx * vx + vy * vy,
            RADIAL = rx * vx + ry * vy,
            C = rx * rx + ry * ry - r * r;
        const DISTANCE_POLICY = policy.contactDistanceEpsilon != null,
            LENGTH = DISTANCE_POLICY ? Math.hypot(rx, ry) : 0;
        if (DISTANCE_POLICY && AA < policy.minSpeed2) {
            return null;
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
                return null;
            }
        } else {
            if (DISTANCE_POLICY ? AA < policy.minSpeed2 : AA <= policy.minSpeed2) {
                return null;
            }
            const DISC = RADIAL * RADIAL - AA * C;
            if (policy.includeTangent ? DISC < policy.discriminantEpsilon : DISC <= policy.discriminantEpsilon) {
                return null;
            }
            if (DISTANCE_POLICY && RADIAL >= 0) {
                return null;
            }
            const ENTER = (-RADIAL - Math.sqrt(DISC)) / AA;
            if (ENTER < 0 || ENTER > 1) {
                return null;
            }
            t = Math.max(0, ENTER - policy.retreat);
        }
        const QX = rx + vx * t,
            QY = ry + vy * t,
            L = Math.hypot(QX, QY);
        let nx, ny;
        if (L > policy.normalEpsilon) {
            nx = QX / L;
            ny = QY / L;
        } else {
            const NORMAL = fallback ? fallback() : { x: 1, y: 0 };
            nx = NORMAL.x;
            ny = NORMAL.y;
        }
        return { t, nx, ny };
    }
}

export class SurfaceContactGeometry {
    /** 선분 AB 위에서 (x, y)에 가장 가까운 점. */
    static closest(ax, ay, bx, by, x, y) {
        const DX = bx - ax,
            DY = by - ay,
            L2 = DX * DX + DY * DY,
            T = L2 ? clamp(((x - ax) * DX + (y - ay) * DY) / L2, 0, 1) : 0;
        return { x: ax + DX * T, y: ay + DY * T };
    }

    /** 원 (x, y)가 속도 (vx, vy)로 움직일 때 고정된 원 (cx, cy, 반지름 r)에 닿는 접촉. 닿지 않으면 null. */
    static circleCast(x, y, vx, vy, cx, cy, r, key, obstacle = null) {
        const HIT = SweptCircleContact.cast(x - cx, y - cy, vx, vy, r, POLICIES.surface);
        if (!HIT) {
            return null;
        }
        HIT.key = key;
        HIT.obstacle = obstacle;
        return HIT;
    }

    /**
     * 원 (x, y, 반지름 r)이 속도 (vx, vy)로 움직일 때 선분 a-b(양 끝 원 포함)에 닿는 가장 이른 접촉.
     * `slack`은 이미 선분에서 그만큼(보통 고정소수 한 칸) 안쪽에 들어와 있어도 t = 0 접촉으로 치는 허용 거리입니다.
     */
    static edgeCast(x, y, vx, vy, a, b, r, key, slack = 0) {
        const DX = b.x - a.x,
            DY = b.y - a.y,
            LEN = Math.hypot(DX, DY);
        if (LEN < 1e-9) {
            return this.circleCast(x, y, vx, vy, a.x, a.y, r, key);
        }
        const EX = DX / LEN,
            EY = DY / LEN,
            NX = -EY,
            NY = EX;
        let best = null;
        const SIGNED = (x - a.x) * NX + (y - a.y) * NY,
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
            const ALONG = (x + vx * t - a.x) * EX + (y + vy * t - a.y) * EY;
            if (ALONG >= -1e-8 && ALONG <= LEN + 1e-8) {
                best = earlierContact(best, { t, nx: NX * SIDE, ny: NY * SIDE, key: key + ':edge' });
            }
        }
        best = earlierContact(best, this.circleCast(x, y, vx, vy, a.x, a.y, r, key + ':a'));
        best = earlierContact(best, this.circleCast(x, y, vx, vy, b.x, b.y, r, key + ':b'));
        return best;
    }

    /**
     * 원 (x, y, 반지름 r)이 다각형 `block`(`{id, points}`)과 이미 닿았거나 `epsilon` 안으로 가까운 접촉 목록.
     * 접촉마다 `{nx, ny, depth, key, distance}`이고 법선은 원이 밀려날 방향입니다. 원 중심이 다각형 안에 있으면
     * 가장 가까운 가장자리 하나만 돌려줍니다. 접촉은 `out`(기본: 새 배열) 뒤에 덧붙이고 `out`을 돌려줍니다.
     */
    static polygonContacts(x, y, r, block, epsilon, out = []) {
        const POINTS = block.points,
            INSIDE = pointInSimplePolygon(x, y, POINTS);
        let nearest = null;
        for (let i = 0; i < POINTS.length; i++) {
            const A = POINTS[i],
                B = POINTS[(i + 1) % POINTS.length];
            const EX = B.x - A.x,
                EY = B.y - A.y,
                L2 = EX * EX + EY * EY,
                T = L2 ? clamp(((x - A.x) * EX + (y - A.y) * EY) / L2, 0, 1) : 0;
            const DX = x - (A.x + EX * T),
                DY = y - (A.y + EY * T),
                D = Math.hypot(DX, DY);
            if (INSIDE ? nearest && !(D < nearest.distance) : !(D <= r + epsilon)) {
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
                for (let j = 0; j < POINTS.length; j++) {
                    const V = POINTS[j],
                        W = POINTS[(j + 1) % POINTS.length];
                    area = area + V.x * W.y - W.x * V.y;
                }
                const LEN = Math.hypot(B.x - A.x, B.y - A.y) || 1,
                    SIGN = area >= 0 ? 1 : -1;
                nx = ((B.y - A.y) / LEN) * SIGN;
                ny = (-(B.x - A.x) / LEN) * SIGN;
            }
            const CONTACT = {
                nx,
                ny,
                depth: INSIDE ? r + D : r - D,
                key: String(block.id) + ':' + i,
                distance: D,
            };
            if (INSIDE) {
                nearest = CONTACT;
            } else {
                out.push(CONTACT);
            }
        }
        if (INSIDE && nearest) {
            out.push(nearest);
        }
        return out;
    }

    /** 속도 v = (x, y)가 모든 접촉 법선에서 밀려나는 쪽이거나 평행(허용 -1e-7)인지. */
    static feasible(v, contacts) {
        return feasibleAt(v.x, v.y, contacts);
    }

    /**
     * 원하는 이동 (vx, vy)를 모든 접촉에 위배되지 않는 가장 가까운 이동으로 돌려줍니다.
     * 이미 가능하면 그대로, 접촉 하나의 접평면에 사영해 가능한 것 중 가장 덜 바뀐 것, 없으면 정지 {0, 0}입니다.
     */
    static project(vx, vy, contacts) {
        if (feasibleAt(vx, vy, contacts)) {
            return { x: vx, y: vy };
        }
        let best = null,
            cost = vx * vx + vy * vy;
        for (const N of contacts) {
            const DOT = vx * N.nx + vy * N.ny,
                PX = vx - N.nx * DOT,
                PY = vy - N.ny * DOT;
            if (!feasibleAt(PX, PY, contacts)) {
                continue;
            }
            const D = (PX - vx) ** 2 + (PY - vy) ** 2;
            if (D < cost - 1e-12) {
                best = { x: PX, y: PY };
                cost = D;
            }
        }
        return best || { x: 0, y: 0 };
    }

    /**
     * 접촉에 막힌 이동 (vx, vy)를 `budget` 길이 안에서 미끄러뜨린 이동 `{x, y}`.
     * `steer`가 false면 사영 결과 그대로(바깥 힘은 새 옆 방향 충격을 얻지 않습니다), true면 사영 결과가 거의 0일 때
     * `goalX`·`goalY`에 가장 맞는 접선 방향을 골라 `budget` 길이로 늘립니다. 방향 점수가 같으면 낮은 `tieRank`가 이깁니다.
     * @param {number} vx
     * @param {number} vy
     * @param {Array<{nx: number, ny: number, key: string}>} contacts
     * @param {number} budget
     * @param {{steer?: boolean, goalX?: number, goalY?: number, tieKey?: string,
     *   tieRank?: (tieKey: string, contactKey: string, sign: number) => number}} [options]
     */
    static slide(vx, vy, contacts, budget, options = {}) {
        const {
            steer: STEER = false,
            goalX: GOAL_X = vx,
            goalY: GOAL_Y = vy,
            tieKey: TIE_KEY = '',
            tieRank: TIE_RANK = defaultTieRank,
        } = options;
        if (budget < 1e-8) {
            return { x: 0, y: 0 };
        }
        let p = this.project(vx, vy, contacts),
            len = Math.hypot(p.x, p.y);
        if (!STEER) {
            return p; // 바깥 힘은 새 옆 방향 충격을 얻지 않습니다.
        }
        if (len < budget * 0.035) {
            let bestX = 0,
                bestY = 0,
                found = false,
                score = -Infinity,
                tie = Infinity;
            for (const C of contacts) {
                for (let k = 0; k < 2; k++) {
                    const SIGN = k === 0 ? -1 : 1;
                    const QX = -C.ny * SIGN,
                        QY = C.nx * SIGN;
                    if (!feasibleAt(QX, QY, contacts)) {
                        continue;
                    }
                    const VALUE = QX * GOAL_X + QY * GOAL_Y;
                    if (VALUE < -1e-7) {
                        continue;
                    }
                    // 순위는 방향 점수가 앞서거나 동률일 때만 필요합니다.
                    if (VALUE > score + 1e-7) {
                        bestX = QX;
                        bestY = QY;
                        found = true;
                        score = VALUE;
                        tie = TIE_RANK(TIE_KEY, C.key, SIGN) >>> 0;
                    } else if (Math.abs(VALUE - score) <= 1e-7) {
                        const RANK = TIE_RANK(TIE_KEY, C.key, SIGN) >>> 0;
                        if (RANK < tie) {
                            bestX = QX;
                            bestY = QY;
                            found = true;
                            score = VALUE;
                            tie = RANK;
                        }
                    }
                }
            }
            if (!found) {
                return { x: 0, y: 0 };
            }
            p = { x: bestX, y: bestY };
            len = 1;
        }
        return len > 1e-8 ? { x: (p.x / len) * budget, y: (p.y / len) * budget } : { x: 0, y: 0 };
    }
}

function feasibleAt(x, y, contacts) {
    for (let i = 0; i < contacts.length; i++) {
        if (!(x * contacts[i].nx + y * contacts[i].ny >= -1e-7)) {
            return false;
        }
    }
    return true;
}

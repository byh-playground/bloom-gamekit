// 장애물 장(ObstacleField) 위에서 원형 이동체를 목표로 옮기는 조정 이동입니다.
// 직선이 비어 있으면 그대로 가고, 막히면 가장 이른 접촉까지 가서 접촉면을 따라 미끄러집니다. 어디로 갈지는 정하지 않습니다.
import { SurfaceContactGeometry, earlierContact } from './contact.js';
import { clamp } from './math.js';

// 월드 경계를 접촉 목록에 넣는 법선·이름. 순서가 접촉 정렬 전의 삽입 순서입니다.
const WALL_LEFT = 'world:left',
    WALL_RIGHT = 'world:right',
    WALL_TOP = 'world:top',
    WALL_BOTTOM = 'world:bottom';

function pushWall(out, distance, nx, ny, key, epsilon) {
    if (distance <= epsilon) {
        out.push({ nx, ny, depth: -distance, key });
    }
}

function castWall(best, distance, velocity, nx, ny, key) {
    if (velocity >= -1e-8) {
        return best;
    }
    const T = Math.max(0, -distance / velocity);
    return T <= 1 ? earlierContact(best, { t: T, nx, ny, key }) : best;
}

export class SurfaceMotion {
    /**
     * @param {import('./obstacle-field.js').ObstacleField} field 장애물 장. 좌표 격자(`fixedPoint`)도 여기서 읽습니다.
     * @param {object} [options]
     * @param {(tieKey: string, contactKey: string, sign: number) => number} [options.tieRank]
     *   방향 점수가 같은 접선 중 하나를 고르는 순위(작을수록 우선, 부호 없는 32비트 정수). 순수 함수여야 합니다.
     *   기본은 `tieKey|contactKey|sign` 문자열의 FNV-1a 32비트 해시입니다.
     * @param {() => void} [options.sync] `solve`·`constrain`이 시작할 때 부르는 갱신 자리(장애물 지연 갱신 등).
     */
    constructor(field, { tieRank, sync } = {}) {
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
     * 지금 (x, y) 반지름 r 원이 닿았거나 `epsilon`(기본 고정소수 두 칸) 안으로 가까운 접촉 모두를 키 순서로.
     * 접촉마다 `{nx, ny, depth, key}`(+ 다각형이면 `distance`, 원 장애물이면 `obstacle`). 같은 접평면의 접촉은 가장 깊은 하나만 남깁니다.
     */
    contacts(x, y, r, ignoreId = null, epsilon = 2 / this.field.fixedPoint) {
        const FIELD = this.field,
            OUT = [];
        for (const B of FIELD.polygons.query(x, y, x, y, r + epsilon)) {
            SurfaceContactGeometry.polygonContacts(x, y, r, B, epsilon, OUT);
        }
        for (const B of FIELD.obstacles(x, y, x, y, r + epsilon, ignoreId)) {
            if (B.id === ignoreId) {
                continue;
            }
            const DX = x - B.x,
                DY = y - B.y,
                D = Math.hypot(DX, DY),
                NEEDED = r + B.r;
            if (D <= NEEDED + epsilon) {
                OUT.push({
                    nx: D > 1e-9 ? DX / D : 1,
                    ny: D > 1e-9 ? DY / D : 0,
                    depth: NEEDED - D,
                    key: 'building:' + B.id,
                    obstacle: B,
                });
            }
        }
        pushWall(OUT, x - r, 1, 0, WALL_LEFT, epsilon);
        pushWall(OUT, FIELD.width - r - x, -1, 0, WALL_RIGHT, epsilon);
        pushWall(OUT, y - r, 0, 1, WALL_TOP, epsilon);
        pushWall(OUT, FIELD.height - r - y, 0, -1, WALL_BOTTOM, epsilon);
        OUT.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        // 이웃한 절벽 조각은 같은 바깥 접평면을 설명하는 일이 많습니다.
        return OUT.filter((c, i) => {
            for (let j = 0; j < i; j++) {
                const N = OUT[j];
                if (Math.abs(c.nx - N.nx) + Math.abs(c.ny - N.ny) < 1e-7 && N.depth >= c.depth) {
                    return false;
                }
            }
            return true;
        });
    }

    /** 원 장애물만 본 가장 이른 접촉. */
    circleObstacleCast(x, y, vx, vy, r, ignoreId = null) {
        let best = null;
        for (const B of this.field.obstacles(x, y, x + vx, y + vy, r, ignoreId)) {
            if (B.id === ignoreId) {
                continue;
            }
            best = earlierContact(
                best,
                SurfaceContactGeometry.circleCast(x, y, vx, vy, B.x, B.y, r + B.r, 'building:' + B.id, B),
            );
        }
        return best;
    }

    /** 다각형·원 장애물·월드 경계 중 (vx, vy) 이동이 가장 먼저 닿는 접촉 `{t, nx, ny, key}`. 없으면 null. */
    cast(x, y, vx, vy, r, ignoreId = null) {
        const FIELD = this.field;
        const SLACK = FIELD.quantum;
        let best = null;
        for (const B of FIELD.polygons.query(x, y, x + vx, y + vy, r)) {
            for (let i = 0; i < B.points.length; i++) {
                best = earlierContact(
                    best,
                    SurfaceContactGeometry.edgeCast(
                        x,
                        y,
                        vx,
                        vy,
                        B.points[i],
                        B.points[(i + 1) % B.points.length],
                        r,
                        String(B.id) + ':' + i,
                        SLACK,
                    ),
                );
            }
        }
        best = earlierContact(best, this.circleObstacleCast(x, y, vx, vy, r, ignoreId));
        best = castWall(best, x - r, vx, 1, 0, WALL_LEFT);
        best = castWall(best, FIELD.width - r - x, -vx, -1, 0, WALL_RIGHT);
        best = castWall(best, y - r, vy, 0, 1, WALL_TOP);
        best = castWall(best, FIELD.height - r - y, -vy, 0, -1, WALL_BOTTOM);
        return best;
    }

    /**
     * 이미 겹쳐 버린 원을 가장 가까운 빈 자리로 옮깁니다. 겹침이 없으면 제자리, 옮길 수 없으면 제자리를 돌려줍니다.
     * 지형이나 다른 장애물을 가로질러 건너가는 일은 없습니다.
     */
    recover(x, y, r, ignoreId) {
        const FIELD = this.field,
            QUANTUM = FIELD.quantum,
            START = { x, y };
        if (this.clear(x, y, x, y, r, ignoreId)) {
            return START;
        }
        if (FIELD.polygonCircleClear(x, y, r)) {
            // 새로 놓인 고체가 멈춘 원을 덮었을 수 있습니다. 가장 가까운 빈 자리로 한 걸음 옮기되, 지형이나
            // 다른 장애물을 가로지르지 않도록 단조로운 이탈 이동만 받아들입니다.
            const P = FIELD.nearestExterior(x, y, r, ignoreId);
            if (P) {
                const END = { x: this.round(P.x), y: this.round(P.y) };
                if (
                    this.clear(END.x, END.y, END.x, END.y, r, ignoreId) &&
                    FIELD.departureClear(x, y, END.x, END.y, r, ignoreId)
                ) {
                    return END;
                }
            }
            return START;
        }
        let remaining = r;
        for (let pass = 0; pass < 4; pass++) {
            const CONTACTS = this.contacts(x, y, r, ignoreId, 0).filter((c) => c.depth > QUANTUM);
            if (!CONTACTS.length) {
                break;
            }
            let delta = null,
                best = Infinity;
            const CONSIDER = (px, py) => {
                for (const C of CONTACTS) {
                    if (px * C.nx + py * C.ny < C.depth + QUANTUM - 1e-7) {
                        return;
                    }
                }
                const D = px * px + py * py;
                if (D < best) {
                    best = D;
                    delta = { x: px, y: py };
                }
            };
            for (const C of CONTACTS) {
                CONSIDER(C.nx * (C.depth + QUANTUM), C.ny * (C.depth + QUANTUM));
            }
            for (let i = 0; i < CONTACTS.length; i++) {
                for (let j = i + 1; j < CONTACTS.length; j++) {
                    const A = CONTACTS[i],
                        B = CONTACTS[j],
                        DEN = A.nx * B.ny - A.ny * B.nx;
                    if (Math.abs(DEN) < 1e-8) {
                        continue;
                    }
                    const AD = A.depth + QUANTUM,
                        BD = B.depth + QUANTUM;
                    CONSIDER((AD * B.ny - A.ny * BD) / DEN, (A.nx * BD - AD * B.nx) / DEN);
                }
            }
            if (!delta || Math.sqrt(best) > remaining + 1e-7) {
                return START;
            }
            const D = Math.sqrt(best);
            x += delta.x;
            y += delta.y;
            remaining -= D;
            if (remaining <= 0) {
                break;
            }
        }
        return this.clear(x, y, x, y, r, ignoreId) ? { x, y } : START;
    }

    /**
     * (x, y)에서 (tx, ty)까지 이동하되 끝점을 고정소수 격자에 반올림해 비어 있는 곳까지만 갑니다.
     * `whole`이 true면 끝까지 갈 수 있을 때만 끝점을, 아니면 null을 돌려줍니다. false면 갈 수 있는 끝까지 이분 탐색(18회)합니다.
     */
    advance(x, y, tx, ty, r, ignoreId, whole = false) {
        const END = { x: this.round(tx), y: this.round(ty) };
        if (this.field.segmentClear(x, y, END.x, END.y, r, ignoreId, !whole && (x !== END.x || y !== END.y), 0)) {
            return END;
        }
        if (whole) {
            return null;
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
        return { x: safeX, y: safeY };
    }

    /**
     * 반지름 r인 원을 (x, y)에서 (tx, ty)로 옮긴 결과 `{x, y, hit}`. `hit`은 처음 닿은 접촉이고 없으면 null입니다.
     * 시작 자리가 막혀 있어 풀 수 없으면 `valid: false`도 담깁니다.
     * `mode`: `'steer'`는 닿은 뒤 접촉면을 따라 목표 쪽으로 미끄러지고(속도는 유지), `'stop'`은 닿는 자리에서 멈추고,
     * 그 밖의 값(`'project'`)은 접촉면에 사영한 만큼만 미끄러집니다. `tieKey`는 동률 순위의 입력입니다.
     */
    solve(x, y, tx, ty, r, ignoreId = null, mode = 'steer', tieKey = '') {
        this.sync?.();
        const STRAIGHT = this.advance(x, y, tx, ty, r, ignoreId, true);
        if (STRAIGHT) {
            STRAIGHT.hit = null;
            return STRAIGHT;
        }
        let px = x,
            py = y,
            hit = null;
        const START = this.recover(px, py, r, ignoreId);
        px = START.x;
        py = START.y;
        if (!this.clear(px, py, px, py, r, ignoreId)) {
            return { x: px, y: py, hit, valid: false };
        }
        let rx = tx - x,
            ry = ty - y,
            remaining = Math.hypot(rx, ry);
        for (let pass = 0; pass < 8 && remaining > 1e-7; pass++) {
            const CONTACT = this.cast(px, py, rx, ry, r, ignoreId);
            if (!CONTACT) {
                const FREE = this.advance(px, py, px + rx, py + ry, r, ignoreId);
                px = FREE.x;
                py = FREE.y;
                break;
            }
            hit = hit || CONTACT;
            const T = clamp(CONTACT.t, 0, 1),
                Q = this.advance(px, py, px + rx * T, py + ry * T, r, ignoreId),
                SPENT = Math.hypot(Q.x - px, Q.y - py);
            px = Q.x;
            py = Q.y;
            remaining = Math.max(0, remaining - SPENT);
            if (mode === 'stop' || remaining < 1e-7) {
                break;
            }
            const CONTACTS = this.contacts(px, py, r, ignoreId);
            if (!CONTACTS.some((n) => Math.abs(n.nx - CONTACT.nx) + Math.abs(n.ny - CONTACT.ny) < 1e-7)) {
                CONTACTS.push(CONTACT);
            }
            const P = SurfaceContactGeometry.slide(rx * (1 - T), ry * (1 - T), CONTACTS, remaining, {
                steer: mode === 'steer',
                goalX: tx - px,
                goalY: ty - py,
                tieKey,
                tieRank: this.tieRank,
            });
            const LEN = Math.hypot(P.x, P.y);
            if (LEN < 1e-7) {
                break;
            }
            if (SPENT < 1e-7 && Math.abs(P.x - rx) + Math.abs(P.y - ry) < 1e-8) {
                break;
            }
            rx = P.x;
            ry = P.y;
            remaining = Math.min(remaining, LEN);
        }
        return { x: px, y: py, hit };
    }

    /**
     * 마지막으로 위치를 확인한 체크포인트를 기록합니다(`verified`가 true면 그 자리는 장애물과 겹치지 않음이 확인된 것).
     * 체크포인트는 `ignoreId`와 이 시점의 {@link ObstacleField#version}도 함께 기억합니다.
     */
    remember(body, x, y, verified = true, ignoreId = null) {
        this.checkpoints.set(body, { x, y, verified, ignoreId, signature: this.field.version });
    }

    /** 모든 체크포인트를 잊습니다(한 이동 단계가 시작될 때). */
    forgetAll() {
        this.checkpoints = new WeakMap();
    }

    /**
     * 몸체가 다른 힘으로 (x, y)까지 옮겨진 뒤, 마지막 체크포인트에서 그 자리까지를 `'project'`로 다시 풀어 장애물 안으로
     * 들어가지 않게 합니다. 체크포인트가 확인된 자리·같은 `ignoreId`·같은 장애물 버전이고 몸체가 안 움직였으면 null,
     * 아니면 `solve` 결과를 돌려줍니다. 결과를 몸체에 쓰고 `remember`하는 일은 호출자가 합니다.
     */
    constrain(body, x, y, r, ignoreId = null, tieKey = '') {
        this.sync?.();
        const S = this.checkpoints.get(body) || { x, y, verified: false };
        if (S.verified && S.ignoreId === ignoreId && S.signature === this.field.version && S.x === x && S.y === y) {
            return null;
        }
        return this.solve(S.x, S.y, x, y, r, ignoreId, 'project', tieKey);
    }
}

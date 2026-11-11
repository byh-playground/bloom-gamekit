// contact-solver 고정 시나리오: (1) 손으로 계산한 질량비 교환, (2) 같은 시각 접촉의 처리 순서와 격자 칸 크기 무관,
// (3) 예산을 넘은 쌍은 겹친 채 지나가고 separate()가 풀며, (4) 벽 틈이 있는 공간에서 두 무리가 빠르게 부딪치는 30틱을
// 예산 0·16·무제한으로 돌려 지형 관통이 0이고 같은 입력 두 번이 같은 해시인지 봅니다. SurfaceMotion은 geometry 번들에서
// 만들어 주입합니다(게임과 같은 두 번들 조합).
import assert from 'node:assert/strict';
import { ObstacleField, SurfaceMotion } from '../../../dist/geometry.js';
import {
    ACTIVE,
    DYNAMIC,
    PAIRS,
    SEPARATE,
    SOFT,
    SOLID,
    RESPONSE_EXCHANGE,
    ContactEvent,
    ContactSolver,
} from '../../../dist/contact-solver.js';

const FP = 100;
const DT = 1 / 20;

function solverFor(field, options = {}) {
    const SOLVER = new ContactSolver({
        surface: new SurfaceMotion(field),
        fixedPoint: FP,
        remainderScale: 10000,
        pairBudget: Infinity,
        maxZeroTimeRepeats: 32,
        cellSize: 64,
        ...options,
    });
    // 진영 0·1: 같은 진영은 SOFT, 다른 진영은 SOLID
    SOLVER.setRelations(2, Uint8Array.of(SOFT, SOLID, SOLID, SOFT));
    return SOLVER;
}

// 몸 하나 채우기. v는 월드/초, dynamic이면 충격 속도, 아니면 조향 변위로 넣습니다.
function put(bodies, i, { x, y, vx = 0, vy = 0, r = 10, m = 100, side = 0, dynamic = true, key = i }) {
    bodies.x[i] = Math.round(x * FP);
    bodies.y[i] = Math.round(y * FP);
    bodies.steerX[i] = bodies.x[i] + (dynamic ? 0 : Math.round(vx * DT * FP));
    bodies.steerY[i] = bodies.y[i] + (dynamic ? 0 : Math.round(vy * DT * FP));
    bodies.ivx[i] = dynamic ? Math.round(vx * FP) : 0;
    bodies.ivy[i] = dynamic ? Math.round(vy * FP) : 0;
    bodies.rx[i] = 0;
    bodies.ry[i] = 0;
    bodies.radius[i] = r;
    bodies.mass[i] = m;
    bodies.key[i] = key;
    bodies.group[i] = side;
    bodies.z[i] = 0;
    bodies.softCap[i] = Math.round(r * FP * 0.25);
    bodies.flags[i] = ACTIVE | PAIRS | SEPARATE | (dynamic ? DYNAMIC : 0);
}

const OPEN = new ObstacleField({ width: 1000, height: 600, fixedPoint: FP, polygons: [], circles: [] });

// ---------- 1. 질량비 교환: 무거운 몸(900)이 서 있는 가벼운 조향 몸(100)을 정면으로 ----------
{
    for (const [E, GAIN, HEAVY, LIGHT] of [
        // e = 0: 공통 속도 300 · 900 / 1000 = 270. J = 300 / (1/900 + 1/100) = 27000
        [0, 1, 27000, 27000],
        // e = 1: J = 54000 → 무거운 몸 300 - 60 = 240, 가벼운 몸 540
        [1, 1, 24000, 54000],
        // e = 0, 맞은 쪽 배율 3: 가벼운 몸만 3배(810), 무거운 몸은 그대로 270
        [0, 3, 27000, 81000],
    ]) {
        const SOLVER = solverFor(OPEN),
            B = SOLVER.begin(2, DT),
            EV = new ContactEvent();
        put(B, 0, { x: 100, y: 100, vx: 300, r: 20, m: 900, side: 0 });
        put(B, 1, { x: 140, y: 100, r: 10, m: 100, side: 1, dynamic: false });
        let impulse = 0;
        while (SOLVER.next(EV)) {
            assert.deepEqual([EV.i, EV.j], [0, 1], '동적 몸이 i');
            impulse = SOLVER.exchange(EV, E, 1, GAIN);
            assert.equal(EV.response, RESPONSE_EXCHANGE);
        }
        SOLVER.end();
        assert.equal(impulse, (300 * (1 + E)) / (1 / 900 + 1 / 100));
        assert.equal(B.ivx[0], HEAVY, `e=${E} gain=${GAIN} 무거운 몸 충격 속도(FP/초)`);
        assert.equal(B.ivx[1], LIGHT, `e=${E} gain=${GAIN} 가벼운 몸`);
        assert.ok(B.flags[1] & DYNAMIC, '맞은 조향 몸은 동적 몸이 됨');
    }
}

// ---------- 2. 같은 시각 접촉의 순서: 표면(몸 번호) → 쌍(작은 번호, 큰 번호). 격자 칸 크기와 무관 ----------
{
    // 모두 틱 시작에 이미 닿은 채 다가가는 접촉이라 한 묶음(t = 0)입니다: 쌍 (0, 1)·(4, 5)는 반지름 합 20보다 가깝고,
    // 몸 2·3은 왼쪽 맵 끝에 붙어 있습니다. 모은 순서는 몸 번호 순(0, 1, 2, …)이지만 표면이 먼저 풀립니다.
    const SCENE = [
        { x: 400, y: 100, vx: 200, side: 0 },
        { x: 419, y: 100, vx: -200, side: 1 },
        { x: 10, y: 300, vx: -200, side: 0 },
        { x: 10, y: 500, vx: -200, side: 1 },
        { x: 600, y: 300, vx: 200, side: 0 },
        { x: 619, y: 300, vx: -200, side: 1 },
    ];
    const RESULTS = [];
    for (const CELL of [8, 64, 1000]) {
        const SOLVER = solverFor(OPEN, { cellSize: CELL }),
            B = SOLVER.begin(SCENE.length, DT),
            EV = new ContactEvent(),
            ORDER = [];
        SCENE.forEach((s, i) => put(B, i, s));
        while (SOLVER.next(EV)) {
            ORDER.push(`${EV.i},${EV.j}@${EV.t.toFixed(4)}`);
            SOLVER.resolve(EV);
        }
        SOLVER.end();
        RESULTS.push({ order: ORDER.join(' '), x: Array.from(B.x.subarray(0, 6)) });
    }
    assert.equal(RESULTS[0].order.split(' ').slice(0, 4).join(' '), '2,-1@0.0000 3,-1@0.0000 0,1@0.0000 4,5@0.0000');
    assert.deepEqual(RESULTS[1], RESULTS[0], '칸 크기 64');
    assert.deepEqual(RESULTS[2], RESULTS[0], '칸 크기 1000');
}

// ---------- 3. 예산을 넘은 쌍은 겹친 채 지나가고 separate()가 풉니다 ----------
{
    const DISTANCE = (bodies) => Math.hypot(bodies.x[1] - bodies.x[0], bodies.y[1] - bodies.y[0]) / FP;
    for (const BUDGET of [0, 1]) {
        const SOLVER = solverFor(OPEN, { pairBudget: BUDGET }),
            B = SOLVER.begin(2, DT),
            EV = new ContactEvent();
        // 각자 틱에 10씩 다가가 중심 거리 10으로 끝나려는 두 적(반지름 합 20). key는 1번이 작음.
        put(B, 0, { x: 100, y: 100, vx: 200, side: 0, key: 7 });
        put(B, 1, { x: 130, y: 100, vx: -200, side: 1, key: 3 });
        while (SOLVER.next(EV)) {
            SOLVER.resolve(EV);
        }
        SOLVER.end();
        if (BUDGET === 0) {
            // 예산 0이면 쌍 cast부터 건너뜁니다(건너뛴 쌍 수도 세지 않음).
            assert.deepEqual([SOLVER.stats.pairContacts, SOLVER.stats.skippedPairs], [0, 0]);
            assert.equal(DISTANCE(B), 10, '예산 0: 겹친 채 끝까지 지나감');
            assert.equal(B.ivx[0], 20000, '속도도 그대로');
            const BEFORE_0 = B.x[0];
            assert.ok(SOLVER.separate() > 0);
            assert.ok(DISTANCE(B) >= 20, `separate 뒤 겹침 없음: ${DISTANCE(B)}`);
            // 둘 다 같은 만큼 다가갔으므로 key가 작은 1번이 침투한 쪽으로 밀려남, 0번은 그대로
            assert.equal(B.x[0], BEFORE_0);
        } else {
            assert.equal(SOLVER.stats.pairContacts, 1);
            assert.ok(DISTANCE(B) >= 19.99, `예산 1: 닿는 자리에서 멈춤 ${DISTANCE(B)}`);
            assert.deepEqual([B.ivx[0], B.ivx[1]], [0, 0], '같은 질량·e = 0 정면: 둘 다 멈춤');
        }
    }
}

// ---------- 4. 벽 틈 난전 30틱: 예산과 무관하게 지형 관통 0, 같은 입력 두 번은 같은 해시 ----------
{
    // 가운데 두께 20 벽에 틈(y 160~240) 하나, 오른쪽 아래에 원 건물 하나.
    const FIELD = new ObstacleField({
        width: 600,
        height: 400,
        fixedPoint: FP,
        polygons: [
            {
                points: [
                    { x: 290, y: 0 },
                    { x: 310, y: 0 },
                    { x: 310, y: 160 },
                    { x: 290, y: 160 },
                ],
            },
            {
                points: [
                    { x: 290, y: 240 },
                    { x: 310, y: 240 },
                    { x: 310, y: 400 },
                    { x: 290, y: 400 },
                ],
            },
        ],
        circles: [{ id: 1, x: 470, y: 320, r: 30 }],
    });
    // 진영 0은 왼쪽에서 오른쪽으로, 진영 1은 반대로. 한 틱에 최대 30 움직여 두께 20 벽을 cast 없이는 건너뜁니다.
    function crowd() {
        const LIST = [];
        let seed = 12345;
        const RANDOM = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
        for (let k = 0; LIST.length < 120; k++) {
            const SIDE = k % 2,
                HEAVY = k % 17 === 0,
                X = Math.round((SIDE === 0 ? 20 + RANDOM() * 240 : 340 + RANDOM() * 240) * FP) / FP,
                Y = Math.round((20 + RANDOM() * 360) * FP) / FP;
            // 건물 안에서 시작하지 않게
            if (!FIELD.pointClear(X, Y, HEAVY ? 14 : 6, null)) {
                continue;
            }
            LIST.push({
                x: X,
                y: Y,
                vx: (SIDE === 0 ? 1 : -1) * (300 + RANDOM() * 300),
                vy: (RANDOM() - 0.5) * 200,
                r: HEAVY ? 14 : 6,
                m: HEAVY ? 1600 : 100,
                side: SIDE,
                dynamic: HEAVY || k % 3 !== 0,
                key: 1000 + k,
            });
        }
        return LIST;
    }
    function run(budget) {
        const SOLVER = solverFor(FIELD, { pairBudget: budget }),
            EV = new ContactEvent(),
            BODIES = crowd(),
            STATE = BODIES.map((b) => ({
                ...b,
                fx: Math.round(b.x * FP),
                fy: Math.round(b.y * FP),
                ivx: 0,
                ivy: 0,
                rx: 0,
                ry: 0,
            }));
        for (const S of STATE) {
            S.ivx = S.dynamic ? Math.round(S.vx * FP) : 0;
            S.ivy = S.dynamic ? Math.round(S.vy * FP) : 0;
        }
        let hash = 2166136261,
            tunnels = 0,
            inside = 0,
            pairs = 0,
            skipped = 0;
        for (let tick = 0; tick < 30; tick++) {
            const B = SOLVER.begin(STATE.length, DT);
            STATE.forEach((s, i) => {
                put(B, i, { ...s, x: s.fx / FP, y: s.fy / FP, vx: s.vx, vy: s.vy, dynamic: s.dynamic });
                B.x[i] = s.fx;
                B.y[i] = s.fy;
                B.steerX[i] = s.dynamic ? s.fx : s.fx + Math.round(s.vx * DT * FP);
                B.steerY[i] = s.dynamic ? s.fy : s.fy + Math.round(s.vy * DT * FP);
                B.ivx[i] = s.ivx;
                B.ivy[i] = s.ivy;
                B.rx[i] = s.rx;
                B.ry[i] = s.ry;
            });
            while (SOLVER.next(EV)) {
                SOLVER.resolve(EV);
            }
            SOLVER.end();
            SOLVER.separate();
            pairs += SOLVER.stats.pairContacts;
            skipped += SOLVER.stats.skippedPairs;
            assert.ok(SOLVER.stats.pairContacts <= budget, '스텝마다 푼 쌍 ≤ 예산');
            STATE.forEach((s, i) => {
                const X0 = s.fx / FP,
                    Y0 = s.fy / FP,
                    X1 = B.x[i] / FP,
                    Y1 = B.y[i] / FP;
                // 틱 사이 이동 선분이 벽을 가로지르면 관통, 끝 자리가 벽·맵 밖·건물 안이면 박힘(반올림 두 칸 허용)
                if (!FIELD.polygonSegmentClear(X0, Y0, X1, Y1, 0)) {
                    tunnels++;
                }
                if (
                    !FIELD.polygonCircleClear(X1, Y1, s.r - 2 / FP) ||
                    Math.hypot(X1 - 470, Y1 - 320) < 30 + s.r - 2 / FP
                ) {
                    inside++;
                }
                s.fx = B.x[i];
                s.fy = B.y[i];
                s.dynamic = (B.flags[i] & DYNAMIC) !== 0;
                s.ivx = B.ivx[i];
                s.ivy = B.ivy[i];
                s.rx = B.rx[i];
                s.ry = B.ry[i];
                for (const V of [s.fx, s.fy, s.ivx, s.ivy, s.rx, s.ry]) {
                    hash = Math.imul(hash ^ (V | 0), 16777619) >>> 0;
                }
            });
        }
        return { hash, tunnels, inside, pairs, skipped };
    }
    const RUNS = {};
    for (const BUDGET of [0, 16, Infinity]) {
        const FIRST = run(BUDGET),
            SECOND = run(BUDGET);
        assert.equal(FIRST.tunnels, 0, `예산 ${BUDGET}: 벽 관통 0`);
        assert.equal(FIRST.inside, 0, `예산 ${BUDGET}: 벽·건물 안에 박힌 몸 0`);
        assert.deepEqual(SECOND, FIRST, `예산 ${BUDGET}: 같은 입력 두 번 같은 결과`);
        RUNS[BUDGET] = FIRST;
    }
    assert.equal(RUNS[0].pairs, 0, '예산 0: 몸끼리는 하나도 풀지 않음');
    assert.ok(RUNS[16].skipped > 0 && RUNS[Infinity].skipped === 0, '예산 16은 넘친 쌍을 건너뜀, 무제한은 없음');
    assert.ok(RUNS[Infinity].pairs > RUNS[16].pairs, '무제한이 더 많이 풂');
    assert.notEqual(RUNS[0].hash, RUNS[Infinity].hash, '예산이 결과를 바꿈');
    console.log(
        `contact-solver: 30틱 해시 예산 0 ${RUNS[0].hash.toString(16)}, 16 ${RUNS[16].hash.toString(16)}, 무제한 ${RUNS[Infinity].hash.toString(16)}` +
            ` (푼 쌍 ${RUNS[0].pairs}/${RUNS[16].pairs}/${RUNS[Infinity].pairs}, 건너뛴 쌍 ${RUNS[16].skipped})`,
    );
}

console.log('contact-solver 고정 시나리오 통과');

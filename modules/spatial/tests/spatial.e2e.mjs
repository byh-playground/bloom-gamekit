// spatial 고정 시나리오: 작은 고정 예로 순서 계약을 못 박고, 두 게임이 쓰던 호출 흐름(전선 충돌·농장)을 한 판 돌려
// 질의 결과와 순서의 해시가 원본 격자 구현(rally-frontier spatial-grids.js, budmori-io spatial-grid.js)으로 돌린
// 같은 흐름의 해시와 같은지 확인합니다. 이 파일의 어댑터가 곧 게임이 격자를 옮길 때의 호출 모양입니다.
import assert from 'node:assert/strict';
import { BoundsGrid, UniformGrid } from '../../../dist/spatial.js';

// ---------- 1. 작은 고정 예: 순서 계약 ----------
{
    // 칸 크기 10, 4열 3행. 칸 번호 = 행 * 4 + 열.
    const GRID = new UniformGrid({ cellSize: 10, width: 40, height: 30, outside: 'clamp' });
    const OUT = [];
    // 0:(15,5) 칸1, 1:(5,15) 칸4, 2:(35,25) 칸11, 3:(12,6) 칸1, 4:(-5,-5) 세계 밖이라 칸0, 5:(100,100) 칸11
    [
        [0, 15, 5],
        [1, 5, 15],
        [2, 35, 25],
        [3, 12, 6],
        [4, -5, -5],
        [5, 100, 100],
    ].forEach(([item, x, y]) => GRID.insert(item, x, y));
    assert.deepEqual(GRID.queryRect(0, 0, 40, 30, OUT), [4, 0, 3, 1, 2, 5], '칸 번호 순서, 칸 안은 삽입 순서');
    assert.deepEqual(GRID.queryRect(10, 0, 19, 9, OUT), [0, 3]);
    assert.deepEqual(GRID.queryCircle(35, 25, 1, OUT), [2, 5], '원은 외접 사각형이 덮는 칸의 후보');
    assert.deepEqual([GRID.cellX(-1e9), GRID.cellX(1e9), GRID.cellY(15)], [0, 3, 1], 'clamp는 가장자리 칸');
    assert.deepEqual([...GRID.usedCells], [1, 4, 11, 0], '사용한 칸은 첫 사용 순');
    GRID.clear();
    assert.deepEqual(GRID.queryRect(0, 0, 40, 30, OUT), []);
    assert.throws(() => GRID.move(0, 1, 1), TypeError, 'track 없는 격자는 move를 거부');
    assert.throws(() => GRID.insert(0, NaN, 1), RangeError, 'clamp는 NaN을 거부');
}
{
    // 추적하는 격자: 뺄 때 마지막 항목이 그 자리로 옮겨 오고, 옮겨진 항목은 새 칸 끝에 붙는다.
    const GRID = new UniformGrid({ cellSize: 10, width: 40, height: 30, outside: 'clamp', track: 'index' });
    const OUT = [];
    [0, 1, 2, 3].forEach((item) => GRID.insert(item, 1, 1));
    GRID.remove(0);
    assert.deepEqual(GRID.cellItems(0), [3, 1, 2], 'swap-remove: 0 자리에 마지막 3');
    GRID.move(1, 15, 1);
    assert.deepEqual(GRID.cellItems(0), [3, 2]);
    assert.deepEqual(GRID.cellItems(1), [1]);
    GRID.move(3, 2, 2);
    assert.deepEqual(GRID.cellItems(0), [3, 2], '같은 칸이면 순서를 바꾸지 않음');
    GRID.move(3, 25, 25);
    assert.deepEqual(GRID.queryRect(0, 0, 40, 30, OUT), [2, 1, 3]);
    GRID.insert(2, 35, 25);
    assert.deepEqual(GRID.queryRect(0, 0, 40, 30, OUT), [1, 3, 2], '있는 항목 insert는 빼고 끝에 다시 넣음');
    assert.deepEqual(
        [GRID.has(0), GRID.has(2), GRID.keyOf(2), GRID.keyAt(35, 25), GRID.keyOf(99)],
        [false, true, 11, 11, -1],
    );
    GRID.clear();
    assert.equal(GRID.has(2), false);
}
{
    // 구분(group): 구분별 버킷도 같은 규칙으로 따라간다.
    const GRID = new UniformGrid({ cellSize: 10, width: 40, height: 30, outside: 'clamp', groups: 2, track: 'index' });
    const OUT = [];
    [0, 1, 2, 3, 4].forEach((item) => GRID.insert(item, 1, 1, item % 2));
    assert.deepEqual(GRID.queryRect(0, 0, 9, 9, OUT, 1), [1, 3]);
    assert.deepEqual(GRID.queryRect(0, 0, 9, 9, OUT, 0), [0, 2, 4]);
    GRID.remove(0);
    assert.deepEqual(GRID.queryRect(0, 0, 9, 9, OUT), [4, 1, 2, 3]);
    assert.deepEqual(GRID.queryRect(0, 0, 9, 9, OUT, 0), [4, 2], '구분 버킷도 swap-remove');
    GRID.move(1, 1, 1, 0);
    assert.deepEqual(GRID.queryRect(0, 0, 9, 9, OUT, 0), [4, 2, 1], 'group을 주면 구분을 바꿈');
    assert.throws(() => GRID.insert(9, 1, 1, 2), RangeError);
}
{
    // 세계 밖('overflow'): 사각형 안에 있을 때만, 칸 항목 뒤에 보관 순서로 따라온다. 식별(identity) 추적.
    const GRID = new UniformGrid({
        cellSize: 10,
        width: 40,
        height: 30,
        originX: -20,
        originY: -10,
        outside: 'overflow',
        track: 'identity',
    });
    const ITEMS = ['a', 'b', 'c', 'd'].map((name) => ({ name }));
    const OUT = [];
    GRID.insert(ITEMS[0], -15, -5); // 칸 0
    GRID.insert(ITEMS[1], 100, 100); // 세계 밖
    GRID.insert(ITEMS[2], 5, 5);
    GRID.insert(ITEMS[3], NaN, 0); // 유한하지 않으면 세계 밖
    const NAMES = (list) => list.map((item) => item.name).join('');
    assert.equal(NAMES(GRID.queryRect(-20, -10, 20, 20, OUT)), 'ac', '세계 밖 항목은 사각형 밖');
    assert.equal(NAMES(GRID.queryRect(90, 90, 110, 110, OUT)), 'b');
    assert.equal(NAMES(GRID.queryRect(-1e9, -1e9, 1e9, 1e9, OUT)), 'ac' + 'b', '유한한 사각형 안의 세계 밖 항목');
    assert.deepEqual(GRID.queryRect(NaN, 0, 1, 1, OUT), [], '유한하지 않은 사각형은 빈 결과');
    assert.equal(GRID.keyAt(100, 100), GRID.cellTotal);
    assert.equal(GRID.keyOf(ITEMS[1]), GRID.cellTotal);
    ITEMS[1].moved = true;
    GRID.move(ITEMS[1], 0, 0);
    assert.equal(NAMES(GRID.queryRect(-1, -1, 1, 1, OUT)), 'cb', '세계 안으로 돌아오면 칸으로(같은 칸의 c도 후보)');
    assert.equal(GRID.cellX(-1000) < 0 && GRID.cellX(1000) >= GRID.cols, true, 'overflow는 칸 번호를 자르지 않음');
    assert.equal(GRID.remove(ITEMS[3]), true);
    assert.equal(GRID.remove(ITEMS[3]), false);
}
{
    // 고리 순서: 첫 행·마지막 행을 열마다 (첫 행, 마지막 행)으로, 이어서 첫 열·마지막 열을 행마다 (첫 열, 마지막 열)로.
    const GRID = new UniformGrid({ cellSize: 1, width: 5, height: 5, outside: 'overflow', track: 'index' });
    const OUT = [];
    for (let key = 0; key < 25; key++) {
        GRID.insert(key, (key % 5) + 0.5, Math.floor(key / 5) + 0.5);
    }
    assert.deepEqual(GRID.queryCellRing(2, 2, 0, OUT), [12]);
    assert.deepEqual(GRID.queryCellRing(2, 2, 1, OUT), [6, 16, 7, 17, 8, 18, 11, 13]);
    assert.deepEqual(GRID.queryCellRing(0, 0, 1, OUT), [5, 6, 1], '격자 밖 칸은 건너뜀');
    const VIA_CELLS = [];
    for (let i = 0; i < GRID.ringCellCount(1); i++) {
        const KEY = GRID.ringCell(2, 2, 1, i);
        VIA_CELLS.push(...GRID.cellItems(KEY));
    }
    assert.deepEqual(VIA_CELLS, [6, 16, 7, 17, 8, 18, 11, 13], 'ringCell은 queryCellRing과 같은 순서');
    assert.deepEqual([GRID.ringCellCount(0), GRID.ringCellCount(3), GRID.ringCell(0, 0, 1, 0)], [1, 24, -1]);
    // 고리 바깥 거리: 1칸 고리 밖은 네 방향 모두 1.5, 2칸 고리는 격자를 다 덮어 바깥이 없다.
    assert.equal(GRID.distanceToOutsideRing(2.5, 2.5, 2, 2, 1), 1.5);
    assert.equal(GRID.distanceToOutsideRing(2.5, 2.5, 2, 2, 2), Infinity);
}
{
    // 최근접 우선 순회: 가까운 고리에서 최근접을 찾으면 먼 고리의 항목은 보지 않는다.
    const GRID = new UniformGrid({ cellSize: 1, width: 20, height: 20, outside: 'overflow', track: 'identity' });
    const POINTS = [
        { id: 1, x: 10.5, y: 10.5 }, // 기준 칸 안
        { id: 2, x: 11.2, y: 10.5 }, // 이웃 칸
        { id: 3, x: 15.5, y: 10.5 }, // 5칸 밖
        { id: 4, x: 3.5, y: 3.5 }, // 멀리
    ];
    POINTS.forEach((point) => GRID.insert(point, point.x, point.y));
    const VISITED = [];
    let nearest = Infinity;
    GRID.visitNearestFirst(10.9, 10.5, 0, 0, 20, 20, (point) => {
        VISITED.push(point.id);
        nearest = Math.min(nearest, Math.hypot(point.x - 10.9, point.y - 10.5));
        return nearest;
    });
    assert.deepEqual(VISITED, [1, 2], '두 번째 고리에서 최근접(0.4)이 확정되어 멈춤');
    const OUTSIDE_BOX = [];
    GRID.visitNearestFirst(10.9, 10.5, 12, 0, 20, 20, (point) => OUTSIDE_BOX.push(point.id));
    assert.deepEqual(OUTSIDE_BOX, [3], '기준 칸이 사각형 밖이면 사각형만 한 번 훑음');
}
{
    // BoundsGrid: 삽입 순서, 중복 없음, afterId, 부분 목록, 칸을 많이 덮는 큰 항목.
    const GRID = new BoundsGrid({ cellSize: 10, width: 100, height: 100, maxCells: 4, views: 2 });
    const OUT = [];
    GRID.insert(5, 0, 0, 25, 5, 0b01); // 칸 3개에 걸침
    GRID.insert(2, 12, 0, 14, 4, 0b10);
    GRID.insert(9, 40, 40, 90, 90, 0b11); // 칸이 많아 큰 항목
    GRID.insert(7, 8, 3, 12, 12, 0b00);
    assert.deepEqual(GRID.queryBounds(0, 0, 30, 30, OUT), [5, 2, 7], '삽입 순서(id 순서가 아님), 겹침만');
    assert.deepEqual(GRID.queryBounds(0, 0, 100, 100, OUT), [5, 2, 9, 7], '큰 질의도 같은 순서');
    assert.deepEqual(GRID.queryBounds(45, 45, 46, 46, OUT), [9], '큰 항목은 어느 칸에서든 찾음');
    assert.deepEqual(GRID.queryOverlaps(5, OUT), [5, 2, 7]);
    assert.deepEqual(GRID.queryOverlaps(5, OUT, -1, 5), [7], 'afterId는 큰 id만');
    assert.deepEqual(GRID.queryBounds(0, 0, 100, 100, OUT, 0), [5, 9], '부분 목록 0');
    assert.deepEqual(GRID.queryBounds(0, 0, 100, 100, OUT, 1), [2, 9], '부분 목록 1');
    assert.deepEqual(GRID.queryBounds(25, 5, 40, 40, OUT), [5, 9], '맞닿으면 겹침');
    assert.equal(GRID.size, 4);
    GRID.clear();
    assert.deepEqual(GRID.queryBounds(0, 0, 100, 100, OUT), []);
    assert.throws(() => new BoundsGrid({ cellSize: 10, width: 100, height: 100, cell: 1 }), TypeError, '모르는 옵션');
    assert.throws(() => new UniformGrid({ cellSize: 10, width: 100, height: 100 }), TypeError, 'outside 필수');
}

// ---------- 2. 두 게임의 호출 흐름 ----------
const FP = 100;
const WORLD = { width: 1280, height: 720 };
const COLLISION_CELL = 64;
const UNIT_CELL = 256;

// 어댑터 시작: 게임이 원본 격자 대신 이 모듈을 부르는 모양입니다(대응표는 README).
const GROUP_OF = (side) => (side === 0 ? 0 : side === 1 ? 1 : 2);
function createRallyGrids() {
    const COLLISION = new UniformGrid({
        cellSize: COLLISION_CELL * FP,
        width: WORLD.width * FP,
        height: WORLD.height * FP,
        outside: 'clamp',
    });
    const COARSE = new UniformGrid({
        cellSize: COLLISION_CELL * FP,
        width: WORLD.width * FP,
        height: WORLD.height * FP,
        outside: 'clamp',
    });
    const SWEPT = new BoundsGrid({
        cellSize: COLLISION_CELL * FP,
        width: WORLD.width * FP,
        height: WORLD.height * FP,
        maxCells: 16,
        views: 2,
    });
    const UNITS = new UniformGrid({
        cellSize: UNIT_CELL,
        width: WORLD.width,
        height: WORLD.height,
        outside: 'clamp',
        groups: 3,
        track: 'index',
    });
    const BUILDINGS = new UniformGrid({
        cellSize: UNIT_CELL,
        width: WORLD.width,
        height: WORLD.height,
        outside: 'clamp',
    });
    let maxRadius = 0;
    const END_CELL = new Int32Array(4096);
    return {
        collisionReset(units, maxIndexedRadius) {
            maxRadius = maxIndexedRadius;
            COLLISION.clear();
            for (let i = 0; i < units.length; i++) {
                if (units[i].alive) {
                    COLLISION.insert(i, units[i].fx, units[i].fy);
                }
            }
        },
        collisionCandidates(fx, fy, radius, out) {
            return COLLISION.queryCircle(fx, fy, radius + maxRadius, out);
        },
        sweptReset(units, radii, segX, segY) {
            COARSE.clear();
            for (let i = 0; i < units.length; i++) {
                if (units[i].alive) {
                    COARSE.insert(i, units[i].fx, units[i].fy);
                }
            }
            SWEPT.clear();
            for (let key = 0; key < COARSE.cellTotal; key++) {
                for (const I of COARSE.cellItems(key)) {
                    const U = units[I];
                    if (!U.alive || radii[I] <= 0) {
                        continue;
                    }
                    END_CELL[I] = key;
                    SWEPT.insert(
                        I,
                        Math.min(segX[I], U.fx) - radii[I] - 1,
                        Math.min(segY[I], U.fy) - radii[I] - 1,
                        Math.max(segX[I], U.fx) + radii[I] + 1,
                        Math.max(segY[I], U.fy) + radii[I] + 1,
                        (U.side !== 0 ? 1 : 0) | (U.side !== 1 ? 2 : 0),
                    );
                }
            }
        },
        sweptQuery(i, units, segX, segY, reach, attackerSide, out) {
            const A = units[i];
            const MIN_CX = COARSE.cellX(Math.min(segX[i], A.fx) - reach),
                MAX_CX = COARSE.cellX(Math.max(segX[i], A.fx) + reach),
                MIN_CY = COARSE.cellY(Math.min(segY[i], A.fy) - reach),
                MAX_CY = COARSE.cellY(Math.max(segY[i], A.fy) + reach);
            SWEPT.queryOverlaps(i, out, attackerSide === 0 || attackerSide === 1 ? attackerSide : -1, i);
            let write = 0;
            for (let k = 0; k < out.length; k++) {
                const J = out[k],
                    X = END_CELL[J] % COARSE.cols,
                    Y = Math.floor(END_CELL[J] / COARSE.cols);
                if (X >= MIN_CX && X <= MAX_CX && Y >= MIN_CY && Y <= MAX_CY) {
                    out[write++] = J;
                }
            }
            out.length = write;
            return out;
        },
        unitReset(units) {
            UNITS.clear();
            for (let i = 0; i < units.length; i++) {
                if (units[i].alive) {
                    UNITS.insert(i, units[i].x, units[i].y, GROUP_OF(units[i].side));
                }
            }
        },
        unitAdd(unit, index) {
            if (unit.alive) {
                UNITS.insert(index, unit.x, unit.y, GROUP_OF(unit.side));
            }
        },
        unitSync(unit, index) {
            if (unit.alive) {
                UNITS.move(index, unit.x, unit.y);
            } else if (UNITS.keyOf(index) !== UNITS.keyAt(unit.x, unit.y)) {
                UNITS.remove(index);
            }
        },
        unitQuery(x, y, radius, out, side) {
            return UNITS.queryCircle(x, y, radius, out, side == null ? -1 : GROUP_OF(side));
        },
        buildingReset(buildings) {
            BUILDINGS.clear();
            for (let i = 0; i < buildings.length; i++) {
                if (buildings[i].alive !== false) {
                    BUILDINGS.insert(i, buildings[i].x, buildings[i].y);
                }
            }
        },
        buildingQuery(x, y, radius, out) {
            return BUILDINGS.queryCircle(x, y, radius, out);
        },
    };
}
const FARM = { cellSize: 1.5, size: 128, origin: -64 };
function createFarmGrid() {
    const GRID = new UniformGrid({
        cellSize: FARM.cellSize,
        width: FARM.size,
        height: FARM.size,
        originX: FARM.origin,
        originY: FARM.origin,
        outside: 'overflow',
        track: 'identity',
    });
    return {
        cols: GRID.cols,
        clear: () => GRID.clear(),
        insert: (item) => GRID.insert(item, item.x, item.y),
        update: (item) => GRID.move(item, item.x, item.y),
        remove: (item) => GRID.remove(item),
        has: (item) => GRID.has(item),
        queryAABB: (minX, minY, maxX, maxY, out) => GRID.queryRect(minX, minY, maxX, maxY, out),
        visitNearestFirst: (x, y, minX, minY, maxX, maxY, visit) =>
            GRID.visitNearestFirst(x, y, minX, minY, maxX, maxY, visit),
        queryCellRing: (cx, cy, ring, out) => GRID.queryCellRing(cx, cy, ring, out),
        distanceToOutsideRing: (x, y, cx, cy, ring) => GRID.distanceToOutsideRing(x, y, cx, cy, ring),
        cellX: (x) => GRID.cellX(x),
        cellY: (y) => GRID.cellY(y),
    };
}
// 어댑터 끝

function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class Digest {
    value = 0x811c9dc5;
    count = 0;
    add(number) {
        this.value = Math.imul(this.value ^ (number | 0), 0x01000193) >>> 0;
        this.count++;
    }
    list(list, tag) {
        this.add(tag);
        this.add(list.length);
        for (let i = 0; i < list.length; i++) {
            this.add(list[i]);
        }
    }
}

// 전선 충돌 12틱: 두 군대가 마주 걷고 중립 유닛이 흩어져 있다. 칸 경계·세계 밖·같은 자리 유닛을 일부러 섞는다.
function rallyFlow(grids, digest) {
    const RANDOM = createRandom(20261104);
    const COORD = (size, cell) => {
        const R = RANDOM();
        if (R < 0.03) {
            return -RANDOM() * 40;
        }
        if (R < 0.06) {
            return size + RANDOM() * 40;
        }
        if (R < 0.14) {
            return Math.floor(RANDOM() * (size / cell + 1)) * cell;
        }
        if (R < 0.17) {
            return 300;
        }
        return RANDOM() * size;
    };
    const UNITS = [];
    const MAKE = (id, side) => {
        const U = {
            id,
            side,
            alive: RANDOM() > 0.04,
            radius: Math.round((8 + RANDOM() * 22) * FP),
            x: side === 0 ? 100 + RANDOM() * 400 : side === 1 ? 700 + RANDOM() * 400 : COORD(WORLD.width, UNIT_CELL),
            y: side === 2 ? COORD(WORLD.height, UNIT_CELL) : 100 + RANDOM() * 520,
        };
        U.fx = Math.round(U.x * FP);
        U.fy = Math.round(U.y * FP);
        U.x = U.fx / FP;
        U.y = U.fy / FP;
        return U;
    };
    for (let i = 0; i < 260; i++) {
        UNITS.push(MAKE(i + 1, i % 3 === 2 ? 2 : i % 2));
    }
    const BUILDINGS = [];
    for (let i = 0; i < 24; i++) {
        BUILDINGS.push({
            x: COORD(WORLD.width, UNIT_CELL),
            y: COORD(WORLD.height, UNIT_CELL),
            alive: i % 5 === 4 ? false : undefined,
        });
    }
    const OUT = [];
    const SEG_X = new Int32Array(4096),
        SEG_Y = new Int32Array(4096),
        RADII = new Int32Array(4096);
    grids.unitReset(UNITS);
    grids.buildingReset(BUILDINGS);
    for (let tick = 0; tick < 12; tick++) {
        for (let i = 0; i < UNITS.length; i++) {
            const U = UNITS[i];
            SEG_X[i] = U.fx;
            SEG_Y[i] = U.fy;
            if (!U.alive) {
                continue;
            }
            const STEP = U.side === 0 ? 1 : U.side === 1 ? -1 : 0;
            U.fx += Math.round((STEP * (20 + RANDOM() * 30) + (RANDOM() - 0.5) * 20) * FP);
            U.fy += Math.round((RANDOM() - 0.5) * 30 * FP);
            if (tick % 4 === 3 && RANDOM() < 0.1) {
                U.fx = Math.round(COORD(WORLD.width, UNIT_CELL) * FP);
            }
            U.x = U.fx / FP;
            U.y = U.fy / FP;
            RADII[i] = U.radius;
            grids.unitSync(U, i);
        }
        // 죽는 유닛은 한 번 sync한 뒤 더는 움직이지 않는다.
        if (tick === 5 || tick === 8) {
            for (let i = tick; i < UNITS.length; i += 7) {
                UNITS[i].alive = false;
                grids.unitSync(UNITS[i], i);
            }
        }
        if (tick === 4) {
            for (let k = 0; k < 6; k++) {
                const U = MAKE(UNITS.length + 1, k % 2);
                UNITS.push(U);
                grids.unitAdd(U, UNITS.length - 1);
            }
        }
        if (tick === 6) {
            grids.buildingReset(BUILDINGS);
        }
        let maxRadius = FP;
        for (let i = 0; i < UNITS.length; i++) {
            RADII[i] = UNITS[i].alive ? UNITS[i].radius : 0;
            maxRadius = Math.max(maxRadius, RADII[i]);
        }
        // 아군 부드러운 분리: 매 패스 격자를 다시 만들고 유닛마다 후보를 읽는다.
        for (let pass = 0; pass < 2; pass++) {
            grids.collisionReset(UNITS, maxRadius);
            for (let i = 0; i < UNITS.length; i++) {
                if (UNITS[i].alive && RADII[i] > 0) {
                    digest.list(grids.collisionCandidates(UNITS[i].fx, UNITS[i].fy, RADII[i], OUT), 1);
                }
            }
        }
        // 적대 스윕: 움직임 상자가 겹치는 쌍 후보(자기보다 큰 인덱스만).
        grids.sweptReset(UNITS, RADII, SEG_X, SEG_Y);
        let travelMax = 0;
        for (let i = 0; i < UNITS.length; i++) {
            if (RADII[i] > 0) {
                travelMax = Math.max(travelMax, Math.ceil(Math.hypot(UNITS[i].fx - SEG_X[i], UNITS[i].fy - SEG_Y[i])));
            }
        }
        for (let i = 0; i < UNITS.length; i++) {
            if (UNITS[i].alive && RADII[i] > 0) {
                digest.list(
                    grids.sweptQuery(i, UNITS, SEG_X, SEG_Y, RADII[i] + maxRadius + travelMax, UNITS[i].side, OUT),
                    2,
                );
            }
        }
        // 표적 탐색: 진영별 후보와 전체 후보, 건물.
        for (let i = 0; i < UNITS.length; i += 3) {
            const U = UNITS[i];
            if (!U.alive) {
                continue;
            }
            const HOSTILE = U.side === 0 || U.side === 1 ? 1 - U.side : null;
            digest.list(grids.unitQuery(U.x, U.y, 180, OUT, HOSTILE), 3);
            digest.list(grids.unitQuery(U.x, U.y, 60, OUT, null), 4);
            digest.list(grids.buildingQuery(U.x, U.y, 300, OUT), 5);
        }
        // 일부 유닛이 갑자기 한꺼번에 재구축된다(회복).
        if (tick === 9) {
            grids.unitReset(UNITS);
        }
    }
}

// 농장 10틱: 생물이 돌아다니고(세계 밖으로 나가기도 함) 먹이를 찾는다.
function farmFlow(grid, digest) {
    const RANDOM = createRandom(777);
    const ITEMS = [];
    for (let i = 0; i < 160; i++) {
        const R = RANDOM();
        ITEMS.push({
            id: i + 1,
            x: R < 0.05 ? (RANDOM() < 0.5 ? -90 : 90) : R < 0.08 ? NaN : (RANDOM() - 0.5) * 36,
            y: R < 0.05 ? (RANDOM() < 0.5 ? -80 : 80) : (RANDOM() - 0.5) * 24,
        });
    }
    const OUT = [];
    grid.clear();
    for (const ITEM of ITEMS) {
        grid.insert(ITEM);
    }
    let visitedItems = 0,
        fullBoxItems = 0;
    for (let tick = 0; tick < 10; tick++) {
        for (let i = 0; i < ITEMS.length; i++) {
            const ITEM = ITEMS[i];
            if (RANDOM() < 0.7) {
                ITEM.x += (RANDOM() - 0.5) * 3;
                ITEM.y += (RANDOM() - 0.5) * 3;
            }
            if (tick === 6 && i % 11 === 0) {
                ITEM.x = (RANDOM() - 0.5) * 300;
            }
            grid.update(ITEM);
        }
        for (let i = tick; i < ITEMS.length; i += 13) {
            grid.remove(ITEMS[i]);
        }
        for (let i = tick + 5; i < ITEMS.length; i += 17) {
            grid.insert(ITEMS[i]);
        }
        digest.add(ITEMS.filter((item) => grid.has(item)).length);
        // 겹침 후보
        for (let i = 0; i < ITEMS.length; i += 2) {
            const ITEM = ITEMS[i];
            grid.queryAABB(ITEM.x - 2, ITEM.y - 2, ITEM.x + 2, ITEM.y + 2, OUT);
            digest.list(
                OUT.map((item) => item.id),
                6,
            );
        }
        // 가장 가까운 적(id가 다른 생물): 최근접 우선 순회
        for (let i = 1; i < ITEMS.length; i += 4) {
            const ME = ITEMS[i];
            let nearest = null,
                nearestDistance = Infinity;
            fullBoxItems += grid.queryAABB(ME.x - 10, ME.y - 10, ME.x + 10, ME.y + 10, OUT).length;
            grid.visitNearestFirst(ME.x, ME.y, ME.x - 10, ME.y - 10, ME.x + 10, ME.y + 10, (candidate) => {
                visitedItems++;
                if (candidate !== ME && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
                    const DISTANCE = Math.hypot(candidate.x - ME.x, candidate.y - ME.y);
                    if (DISTANCE < nearestDistance || (DISTANCE === nearestDistance && candidate.id < nearest.id)) {
                        nearest = candidate;
                        nearestDistance = DISTANCE;
                    }
                }
                return nearestDistance;
            });
            digest.add(nearest ? nearest.id : 0);
        }
        // 먹이 탐색: 고리를 하나씩 넓히며 최근접이 다음 고리 바깥 거리보다 가까우면 멈춘다.
        for (let i = 2; i < ITEMS.length; i += 9) {
            const ME = ITEMS[i];
            const CX = grid.cellX(ME.x),
                CY = grid.cellY(ME.y);
            if (!(CX >= 0 && CY >= 0 && CX < grid.cols && CY < grid.cols)) {
                continue;
            }
            let nearest = null,
                nearestDistance = Infinity;
            for (let ring = 0; ring < grid.cols; ring++) {
                for (const FOOD of grid.queryCellRing(CX, CY, ring, OUT)) {
                    const DISTANCE = Math.hypot(FOOD.x - ME.x, FOOD.y - ME.y);
                    if (
                        FOOD !== ME &&
                        (DISTANCE < nearestDistance || (DISTANCE === nearestDistance && FOOD.id < nearest.id))
                    ) {
                        nearest = FOOD;
                        nearestDistance = DISTANCE;
                    }
                }
                if (nearest && nearestDistance < grid.distanceToOutsideRing(ME.x, ME.y, CX, CY, ring)) {
                    break;
                }
            }
            digest.add(nearest ? nearest.id : 0);
        }
    }
    return { visitedItems, fullBoxItems };
}

// 원본 격자 구현(rally-frontier·budmori-io)으로 같은 흐름을 돌려 얻은 값입니다. 모듈을 바꿔 이 값이 달라지면
// 두 게임의 질의 결과나 순서가 달라진다는 뜻입니다.
const EXPECTED = { rally: { value: 1601672843, count: 156627 }, farm: { value: 2900572170, count: 5594 } };

const RALLY = new Digest();
rallyFlow(createRallyGrids(), RALLY);
const FARM_DIGEST = new Digest();
const FARM_STATS = farmFlow(createFarmGrid(), FARM_DIGEST);
assert.ok(FARM_STATS.visitedItems < FARM_STATS.fullBoxItems / 2, '최근접 순회가 사각형 전체의 절반도 읽지 않음');
assert.deepEqual(
    { rally: { value: RALLY.value, count: RALLY.count }, farm: { value: FARM_DIGEST.value, count: FARM_DIGEST.count } },
    EXPECTED,
);
console.log('spatial scenario ok', RALLY.value.toString(16), FARM_DIGEST.value.toString(16));

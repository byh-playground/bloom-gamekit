// vision 고정 시나리오: 작은 지형 그림으로 시야 규칙(반경·막힌 칸·높이 층·xray)을 못 박고, 갱신 계약(다시 칠하는 조건,
// revision, 같은 id)과 오류를 확인한 뒤, 무작위 지형 위에서 관찰자가 움직이고 사라지고 생기는 한 판을 돌려 시야 마스크의
// 해시가 원본 구현(rally-frontier의 VisionField)으로 같은 판을 돌린 해시와 같은지 확인합니다.
import assert from 'node:assert/strict';
import { VisionField, VisionMap } from '../../../dist/vision.js';

// 그림 한 줄이 칸 한 행입니다: '.' 높이 0, '1'..'9' 그 높이 층, '#' 막힌 칸. 칸 크기 10이라 칸 (c, r)의 중심은 (c*10+5, r*10+5)입니다.
function mapFrom(rows) {
    const COLS = rows[0].length,
        LEVEL = new Int8Array(COLS * rows.length),
        BLOCKED = new Uint8Array(COLS * rows.length);
    rows.forEach((row, r) => {
        [...row].forEach((ch, c) => {
            if (ch === '#') {
                BLOCKED[r * COLS + c] = 1;
            } else if (ch !== '.') {
                LEVEL[r * COLS + c] = Number(ch);
            }
        });
    });
    return new VisionMap({ width: COLS * 10, height: rows.length * 10, cellSize: 10, level: LEVEL, blocked: BLOCKED });
}

// 보이는 칸은 'o', 막힌 칸은 '#'(막혔는데 보이면 '@'), 보이지 않는 높은 칸은 '^', 보이지 않는 나머지는 '.'입니다.
function picture(map, field, targetLevel) {
    const OUT = [];
    for (let r = 0; r < map.rows; r++) {
        let line = '';
        for (let c = 0; c < map.cols; c++) {
            const AT = r * map.cols + c;
            const SEEN = field.visibleAt(c * 10 + 5, r * 10 + 5, targetLevel);
            line += map.blocked[AT] ? (SEEN ? '@' : '#') : SEEN ? 'o' : map.level[AT] > 0 ? '^' : '.';
        }
        OUT.push(line);
    }
    return OUT;
}

// ---------- 1. 규칙: 반경은 칸 중심 사이의 거리, 막힌 칸과 높은 칸은 그 너머까지 가립니다 ----------
{
    const OPEN = mapFrom(Array.from({ length: 9 }, () => '.........'));
    const FIELD = new VisionField(OPEN).update([{ id: 'a', x: 45, y: 45, radius: 25, level: 0 }]);
    assert.deepEqual(
        picture(OPEN, FIELD, 0),
        [
            '.........',
            '.........',
            '...ooo...',
            '..ooooo..',
            '..ooooo..',
            '..ooooo..',
            '...ooo...',
            '.........',
            '.........',
        ],
        '반경 2.5칸: 중심 사이 거리 2.5 이하인 21칸',
    );
    assert.equal(FIELD.visibleAt(-500, -500, 0), false, '월드 밖은 가장자리 칸을 읽는다');
    FIELD.update([{ id: 'a', x: 45, y: 45, radius: 0, level: 0 }]);
    assert.deepEqual(picture(OPEN, FIELD, 0).join(''), '.'.repeat(81), '반경 0은 자기 칸도 비추지 않는다');
}
{
    const WALL = mapFrom([
        '............',
        '............',
        '.....#......',
        '.....#......',
        '.....#......',
        '............',
        '............',
    ]);
    const FIELD = new VisionField(WALL).update([{ id: 'a', x: 25, y: 35, radius: 100, level: 0 }]);
    assert.deepEqual(picture(WALL, FIELD, 0), [
        'oooooooooooo',
        'oooooooooooo',
        'ooooo#......',
        'ooooo#......',
        'ooooo#......',
        'oooooooooooo',
        'oooooooooooo',
    ]);
}
{
    const HILL = mapFrom([
        '.............',
        '.............',
        '.....111.....',
        '.....111.....',
        '.....111.....',
        '.............',
        '.............',
    ]);
    // 땅의 관찰자는 언덕 칸도 그 너머도 보지 못하지만, 언덕 위의 관찰자는 땅을 내려다봅니다.
    const GROUND = new VisionField(HILL).update([{ id: 'g', x: 25, y: 35, radius: 110, level: 0 }]);
    assert.deepEqual(picture(HILL, GROUND, 0), [
        'ooooooooooooo',
        'ooooooooooooo',
        'ooooo^^^.....',
        'ooooo^^^.....',
        'ooooo^^^.....',
        'ooooooooooooo',
        'ooooooooooooo',
    ]);
    const TOP = new VisionField(HILL).update([{ id: 'p', x: 65, y: 35, radius: 60, level: 1 }]);
    assert.deepEqual(picture(HILL, TOP, 0), [
        '.ooooooooooo.',
        '.ooooooooooo.',
        '.ooooooooooo.',
        'ooooooooooooo',
        '.ooooooooooo.',
        '.ooooooooooo.',
        '.ooooooooooo.',
    ]);
    // 대상의 높이: 땅(상한 0) 관찰자에게 높이 1 대상은 같은 칸에서도 보이지 않습니다.
    assert.equal(GROUND.visibleAt(15, 5, 0), true);
    assert.equal(GROUND.visibleAt(15, 5, 1), false, '상한 0은 높이 1 대상을 못 본다');
    assert.equal(TOP.visibleAt(15, 5, 1), true, '언덕 위 관찰자는 높이 1 대상을 본다');
    assert.equal(GROUND.ceilingAt(15, 5), 0);
    assert.equal(TOP.ceilingAt(15, 5), 1);
    assert.equal(GROUND.ceilingAt(125, 35), -Infinity, '언덕 뒤의 가려진 칸은 비추는 관찰자가 없다');
    // 막힌 칸에 선 관찰자는 아무것도 비추지 않습니다(xray는 예외).
    const WALLED = mapFrom(['.....', '..#..', '.....']);
    const IN_WALL = new VisionField(WALLED).update([{ id: 'w', x: 25, y: 15, radius: 100, level: 0 }]);
    assert.deepEqual(picture(WALLED, IN_WALL, 0).join(''), '.....' + '..#..' + '.....');
}
{
    // xray는 막힌 칸과 높이를 무시하고 반경 안의 모든 칸을 모든 높이에서 봅니다.
    const HILL = mapFrom(['.....111.....', '.....111.....', '..#..111.....']);
    const FIELD = new VisionField(HILL).update([{ id: 'x', x: 25, y: 15, radius: 60, level: 9, xray: true }]);
    assert.deepEqual(picture(HILL, FIELD, 100), ['oooooooo.....', 'ooooooooo....', 'oo@ooooo.....']);
    assert.equal(FIELD.ceilingAt(75, 15), Infinity);
    assert.equal(FIELD.visibleAt(75, 15, 1000), true);
    assert.equal(FIELD.ceilingAt(115, 15), -Infinity, '반경 밖');
}

// ---------- 2. 갱신 계약: 바뀐 관찰자만 다시 칠하고, 사라진 관찰자는 지웁니다 ----------
{
    const MAP = mapFrom(Array.from({ length: 9 }, () => '.........'));
    const FIELD = new VisionField(MAP);
    const A = { id: 'a', x: 25, y: 25, radius: 25, level: 0 },
        B = { id: 'b', x: 65, y: 65, radius: 25, level: 0 };
    FIELD.update([A, B]);
    const REVISION = FIELD.revision;
    assert.ok(REVISION > 0);
    FIELD.update([{ ...A }, { ...B }]);
    assert.equal(FIELD.revision, REVISION, '같은 관찰자는 다시 칠하지 않는다');
    FIELD.update([{ ...A, x: 28, y: 22 }, B]);
    assert.equal(FIELD.revision, REVISION, '같은 칸 안에서 움직이면 다시 칠하지 않는다');
    FIELD.update([{ ...A, x: 35 }, B]);
    assert.equal(FIELD.revision, REVISION + 1, '칸을 넘으면 다시 칠한다');
    FIELD.update([{ ...A, x: 35, radius: 35 }, B]);
    assert.equal(FIELD.revision, REVISION + 2, '반경이 바뀌면 다시 칠한다');
    FIELD.update([{ ...A, x: 35, radius: 35, level: 1 }, B]);
    assert.equal(FIELD.revision, REVISION + 3, '높이 층이 바뀌면 다시 칠한다');
    FIELD.update([{ ...A, x: 35, radius: 35, level: 1 }]);
    assert.equal(FIELD.revision, REVISION + 4, '사라진 관찰자의 칸을 지운다');
    assert.equal(FIELD.visibleAt(65, 65, 0), false);
    FIELD.update([]);
    assert.equal(FIELD.ceilingAt(35, 25), -Infinity);
    assert.equal(FIELD.revision, REVISION + 5);
    FIELD.update([]);
    assert.equal(FIELD.revision, REVISION + 5, '빈 목록을 또 넘겨도 그대로');
    // xray는 높이 층이 결과에 쓰이지 않으므로 층만 바뀌어서는 다시 칠하지 않는다.
    FIELD.update([{ id: 'x', x: 45, y: 45, radius: 30, level: 0, xray: true }]);
    const XRAY_REVISION = FIELD.revision;
    FIELD.update([{ id: 'x', x: 45, y: 45, radius: 30, level: 3, xray: true }]);
    assert.equal(FIELD.revision, XRAY_REVISION);
    // 칸을 지우고 다시 세는 관찰자 수: 두 관찰자가 겹친 칸은 하나가 사라져도 남는다.
    FIELD.update([
        { id: 'p', x: 45, y: 45, radius: 20, level: 0 },
        { id: 'q', x: 45, y: 45, radius: 20, level: 0 },
    ]);
    FIELD.update([{ id: 'q', x: 45, y: 45, radius: 20, level: 0 }]);
    assert.equal(FIELD.visibleAt(45, 45, 0), true);
    // 같은 id를 한 목록에 두 번 넘겨도 각각 센다.
    FIELD.update([
        { id: 'd', x: 15, y: 15, radius: 5, level: 0 },
        { id: 'd', x: 75, y: 75, radius: 5, level: 0 },
    ]);
    assert.deepEqual(
        [FIELD.visibleAt(15, 15, 0), FIELD.visibleAt(75, 75, 0), FIELD.visibleAt(45, 45, 0)],
        [true, true, false],
    );
    const DUPLICATE_REVISION = FIELD.revision;
    FIELD.update([
        { id: 'd', x: 15, y: 15, radius: 5, level: 0 },
        { id: 'd', x: 75, y: 75, radius: 5, level: 0 },
    ]);
    assert.equal(FIELD.revision, DUPLICATE_REVISION, '같은 순서면 다음 갱신에도 같은 짝');
    // 팀마다 격자가 따로입니다: 같은 지형을 공유해도 한 팀의 관찰자는 다른 팀 격자에 영향이 없다.
    const OTHER = new VisionField(MAP);
    assert.equal(OTHER.visibleAt(15, 15, 0), false);
    assert.equal(OTHER.map, FIELD.map);
}

// ---------- 3. VisionMap.sample: 칸 중심을 표집하고, 월드 밖에 걸친 마지막 칸은 가장자리 좌표를 씁니다 ----------
{
    const CALLS = [];
    const MAP = VisionMap.sample({
        width: 21,
        height: 12,
        cellSize: 10,
        levelAt: (x, y) => {
            CALLS.push([x, y]);
            return x > 20 ? 2 : 0;
        },
        blockedAt: (_x, y) => y > 10,
    });
    assert.deepEqual([MAP.cols, MAP.rows], [3, 2]);
    assert.deepEqual(
        CALLS,
        [
            [5, 5],
            [15, 5],
            [21, 5],
            [5, 12],
            [15, 12],
            [21, 12],
        ],
        '칸 중심은 행 우선으로, 월드 밖에 걸친 마지막 열·행의 중심(25·15)은 너비 21·높이 12로 잘라 표집한다',
    );
    assert.deepEqual([...MAP.level], [0, 0, 2, 0, 0, 2]);
    assert.deepEqual([...MAP.blocked], [0, 0, 0, 1, 1, 1]);
    assert.equal(MAP.cellAt(1e9, -1e9), 2, '월드 밖은 가장자리 칸');
    assert.ok(Number.isNaN(MAP.cellAt(NaN, 0)));
}

// ---------- 4. 오류는 조용히 넘기지 않습니다 ----------
{
    const MAP = mapFrom(['...', '...']);
    const FIELD = new VisionField(MAP);
    assert.throws(() => new VisionField({}), TypeError);
    assert.throws(
        () => new VisionMap({ width: 30, height: 20, cellSize: 10, level: new Int8Array(5) }),
        TypeError,
        '래스터 길이',
    );
    assert.throws(() => new VisionMap({ width: 30, height: 20, cellSize: 10, level: new Float32Array(6) }), TypeError);
    assert.throws(() => new VisionMap({ width: 30, height: 20, cellSize: 0, level: new Int8Array(6) }), RangeError);
    assert.throws(
        () => new VisionMap({ width: 30, height: 20, cellSize: 10, level: new Int8Array(6), extra: 1 }),
        TypeError,
    );
    assert.throws(() => VisionMap.sample({ width: 30, height: 20, cellSize: 10, levelAt: () => 1.5 }), RangeError);
    assert.throws(() => VisionMap.sample({ width: 30, height: 20, cellSize: 10, levelAt: () => 200 }), RangeError);
    assert.throws(() => FIELD.update([{ id: 'a', x: NaN, y: 0, radius: 5, level: 0 }]), RangeError);
    assert.throws(() => FIELD.update([{ id: 'a', x: 0, y: 0, radius: -1, level: 0 }]), RangeError);
    assert.throws(() => FIELD.update([{ id: 'a', x: 0, y: 0, radius: Infinity, level: 0 }]), RangeError);
    assert.throws(() => FIELD.update([{ id: 'a', x: 0, y: 0, radius: 5 }]), TypeError, '높이 층 없음');
    assert.throws(() => FIELD.update([{ x: 0, y: 0, radius: 5, level: 0 }]), TypeError, 'id 없음');
    assert.throws(() => FIELD.visibleAt(0, 0), TypeError, '대상 높이 층을 생략할 수 없다');
    assert.doesNotThrow(
        () => FIELD.update([{ id: 'x', x: 0, y: 0, radius: 5, xray: true }]),
        'xray는 level이 필요 없다',
    );
    assert.throws(() => FIELD.update(new Set()), TypeError, '관찰자 목록은 배열');
    // 잘못된 관찰자가 하나라도 있으면 격자는 그대로입니다(앞의 관찰자도 반영하지 않는다).
    FIELD.update([{ id: 'a', x: 5, y: 5, radius: 15, level: 0 }]);
    const BEFORE = [FIELD.revision, FIELD.visibleAt(5, 5, 0), FIELD.visibleAt(25, 15, 0)];
    assert.throws(
        () =>
            FIELD.update([
                { id: 'a', x: 25, y: 15, radius: 15, level: 0 },
                { id: 'b', x: NaN, y: 0, radius: 5, level: 0 },
            ]),
        RangeError,
    );
    assert.deepEqual([FIELD.revision, FIELD.visibleAt(5, 5, 0), FIELD.visibleAt(25, 15, 0)], BEFORE);
}

// ---------- 5. 원본 구현과 같은 판 ----------
// BEGIN scene
// 48 × 36칸(칸 크기 16)의 무작위 지형 위에서 관찰자 24명이 40틱 동안 움직이고 사라지고 생깁니다. 원본(rally-frontier의
// VisionField)을 같은 지형 래스터로 돌린 판의 마스크 해시가 SCENE_HASH입니다.
function runScene(createField) {
    let seed = 20261104;
    function rand() {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 4294967296;
    }
    const COLS = 48,
        ROWS = 36,
        CELL = 16,
        LEVEL = new Int8Array(COLS * ROWS),
        BLOCKED = new Uint8Array(COLS * ROWS);
    // 둥근 높은 땅 몇 개와 흩어진 막힌 덩어리
    for (let patch = 0; patch < 9; patch++) {
        const PX = rand() * COLS,
            PY = rand() * ROWS,
            PR = 2 + rand() * 5,
            PL = 1 + Math.floor(rand() * 2);
        for (let i = 0; i < LEVEL.length; i++) {
            const X = i % COLS,
                Y = (i - X) / COLS;
            if ((X - PX) ** 2 + (Y - PY) ** 2 < PR * PR) {
                LEVEL[i] = Math.max(LEVEL[i], PL);
            }
        }
    }
    for (let blob = 0; blob < 14; blob++) {
        const BX = Math.floor(rand() * COLS),
            BY = Math.floor(rand() * ROWS),
            BW = 1 + Math.floor(rand() * 4),
            BH = 1 + Math.floor(rand() * 3);
        for (let y = BY; y < Math.min(ROWS, BY + BH); y++) {
            for (let x = BX; x < Math.min(COLS, BX + BW); x++) {
                BLOCKED[y * COLS + x] = 1;
            }
        }
    }
    const FIELD = createField({ cols: COLS, rows: ROWS, cellSize: CELL, level: LEVEL, blocked: BLOCKED });
    function levelOf(x, y) {
        const COL = Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL))),
            ROW = Math.min(ROWS - 1, Math.max(0, Math.floor(y / CELL)));
        return LEVEL[ROW * COLS + COL];
    }
    const RADII = [0, 16, 48, 80, 160, 300];
    let nextId = 1;
    const OBSERVERS = [];
    function spawn() {
        OBSERVERS.push({
            id: nextId++,
            x: rand() * COLS * CELL * 1.1 - COLS * CELL * 0.05,
            y: rand() * ROWS * CELL * 1.1 - ROWS * CELL * 0.05,
            radius: RADII[Math.floor(rand() * RADII.length)],
            xray: rand() < 0.06,
        });
    }
    for (let i = 0; i < 24; i++) {
        spawn();
    }
    let hash = 2166136261;
    function fold(value) {
        hash = Math.imul(hash ^ value, 16777619) >>> 0;
    }
    for (let tick = 0; tick < 40; tick++) {
        for (const O of OBSERVERS) {
            const MOVE = rand();
            if (MOVE < 0.3) {
                O.x += (rand() - 0.5) * 24;
                O.y += (rand() - 0.5) * 24;
            } else if (MOVE < 0.34) {
                O.x += (rand() - 0.5) * 300;
                O.y += (rand() - 0.5) * 300;
            } else if (MOVE < 0.38) {
                O.radius = RADII[Math.floor(rand() * RADII.length)];
            }
        }
        if (rand() < 0.4) {
            OBSERVERS.splice(Math.floor(rand() * OBSERVERS.length), 1);
        }
        if (rand() < 0.5) {
            spawn();
        }
        FIELD.update(
            OBSERVERS.map((o) => ({
                id: o.id,
                x: o.x,
                y: o.y,
                radius: o.radius,
                level: levelOf(o.x, o.y),
                xray: o.xray,
            })),
        );
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                const PX = (x + 0.5) * CELL,
                    PY = (y + 0.5) * CELL,
                    CEILING = FIELD.ceilingAt(PX, PY);
                fold(CEILING === -Infinity ? 255 : CEILING === Infinity ? 254 : CEILING);
                for (let level = 0; level <= 2; level++) {
                    fold(FIELD.visibleAt(PX, PY, level) ? 1 : 0);
                }
            }
        }
    }
    return hash.toString(16).padStart(8, '0');
}
// END scene
const SCENE_HASH = '33b8c2f5';
const MODULE_HASH = runScene(
    ({ cols, rows, cellSize, level, blocked }) =>
        new VisionField(new VisionMap({ width: cols * cellSize, height: rows * cellSize, cellSize, level, blocked })),
);
assert.equal(MODULE_HASH, SCENE_HASH, `scene hash ${MODULE_HASH}`);
console.log('vision e2e ok');

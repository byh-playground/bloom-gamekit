// geometry 고정 시나리오: 손으로 계산할 수 있는 기하 값과, 벽·건물·월드 경계 사이에서 원이 움직이는 한 장면의 기대 위치.
// 접촉 해소의 기대값(stop/project/steer, 복구)은 Rally 원본 구현이 같은 입력에서 낸 값과 비트 단위로 같습니다.
// 동률 기대값은 정수 tieKey·정수 접촉 키의 기본 순위(FNV-1a + fmix32)가 정한 값입니다.
import assert from 'node:assert/strict';
import {
    BoundsIndex,
    CONTACT_CIRCLE,
    CONTACT_END,
    CONTACT_MAX_EDGE,
    CONTACT_MAX_OBSTACLE,
    CONTACT_POLYGON,
    CONTACT_USER,
    CONTACT_WALL,
    ContactHit,
    ContactList,
    MotionResult,
    ObstacleField,
    SurfaceContactGeometry,
    SurfaceMotion,
    SweptCircleContact,
    contactKey,
    defaultTieRank,
    pointInSimplePolygon,
    pointSegmentDistance,
    polygonsOverlap,
    roundedPointOnPolyline,
    segmentDistance,
    segmentsIntersect,
    triangulatePolygon,
} from '../../../dist/geometry.js';

// ---------- 수학: 알려진 값 ----------
const L_SHAPE = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 20 },
    { x: 0, y: 20 },
];
assert.equal(pointInSimplePolygon(5, 5, L_SHAPE), true);
assert.equal(pointInSimplePolygon(15, 15, L_SHAPE), false, 'L자의 오목한 안쪽은 밖입니다.');
assert.equal(pointInSimplePolygon(5, 15, L_SHAPE), true);
assert.equal(pointInSimplePolygon(1, 1, L_SHAPE.slice(0, 2)), false, '꼭짓점 3개 미만은 항상 false입니다.');
assert.equal(pointSegmentDistance(5, 5, 0, 0, 10, 0), 5);
assert.equal(pointSegmentDistance(13, 4, 0, 0, 10, 0), 5, '선분 끝 너머의 점은 끝점과의 거리입니다.');
assert.equal(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0), true);
assert.equal(segmentsIntersect(0, 0, 10, 0, 0, 3, 10, 3), false, '평행한 선분은 교차가 아닙니다.');
assert.equal(segmentDistance(0, 0, 10, 0, 0, 3, 10, 3), 3);
assert.equal(segmentDistance(0, 0, 10, 10, 0, 10, 10, 0), 0);
assert.equal(
    polygonsOverlap(L_SHAPE, [
        { x: 15, y: 5 },
        { x: 25, y: 5 },
        { x: 25, y: 15 },
        { x: 15, y: 15 },
    ]),
    true,
);
assert.equal(
    polygonsOverlap(L_SHAPE, [
        { x: 30, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 10 },
    ]),
    false,
);
const PATH = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
];
assert.deepEqual(roundedPointOnPolyline(PATH, 0.25), { x: 5, y: 0 });
assert.deepEqual(roundedPointOnPolyline(PATH, 0.5), { x: 10, y: 0 });
assert.deepEqual(roundedPointOnPolyline(PATH, 0.75), { x: 10, y: 5 });
assert.deepEqual(roundedPointOnPolyline(PATH, 2), { x: 10, y: 10 }, 't는 0~1로 잘립니다.');

// 삼각분할: 삼각형 넓이의 합이 다각형 넓이(300)와 같고, 같은 배열은 같은 결과 객체입니다.
const MESH = triangulatePolygon(L_SHAPE);
const AREA = MESH.triangles.reduce((sum, [a, b, c]) => {
    const A = L_SHAPE[a],
        B = L_SHAPE[b],
        C = L_SHAPE[c];
    return sum + Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
}, 0);
assert.equal(MESH.convex, false);
assert.equal(MESH.triangles.length, 4);
assert.equal(AREA, 300);
assert.equal(triangulatePolygon(L_SHAPE), MESH);
const SQUARE = triangulatePolygon([
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
]);
assert.deepEqual([SQUARE.convex, SQUARE.triangles.length], [true, 2]);

// 색인: 여러 칸에 걸친 항목은 한 번만, 먼 항목은 나오지 않습니다. `found`는 같은 순서의 항목 번호입니다.
const INDEX = new BoundsIndex(
    [
        { id: 'near', minX: 0, maxX: 10, minY: 0, maxY: 10 },
        { id: 'far', minX: 500, maxX: 510, minY: 500, maxY: 510 },
        { id: 'wide', minX: 0, maxX: 600, minY: 0, maxY: 5 },
    ],
    64,
);
assert.deepEqual(
    INDEX.query(5, 5)
        .map((item) => item.id)
        .sort(),
    ['near', 'wide'],
);
const ALL = INDEX.query(0, 0, 600, 600);
assert.deepEqual(ALL.map((item) => item.id).sort(), ['far', 'near', 'wide']);
assert.deepEqual(
    ALL.map((item, i) => INDEX.items[INDEX.found[i]] === item),
    [true, true, true],
);
assert.deepEqual(INDEX.query(300, 300, 301, 301, 1), []);

// ---------- 접촉 키: 정수 조합 ----------
// 키 = 종류·2^50 + 장애물·2^22 + 변·4 + 부위. 작은 키가 같은 시각 동률에서 앞섭니다.
assert.equal(contactKey(CONTACT_POLYGON, 0, 3), 12);
assert.equal(contactKey(CONTACT_POLYGON, 2, 5, CONTACT_END), 2 * 2 ** 22 + 5 * 4 + 2);
assert.equal(contactKey(CONTACT_CIRCLE, 1), 2 ** 50 + 2 ** 22);
assert.equal(contactKey(CONTACT_WALL, 0, 0), 2 * 2 ** 50);
assert.ok(contactKey(CONTACT_USER, CONTACT_MAX_OBSTACLE, CONTACT_MAX_EDGE, 3) < 2 ** 53);
// 기본 순위는 정수 입력만 받습니다.
assert.equal(defaultTieRank(1, 12, 1), defaultTieRank(1, 12, 1));
assert.throws(() => defaultTieRank('u1', 12, 1), TypeError);

// ---------- 접촉 해소: 벽 + 건물 + 월드 경계 ----------
// 400×300 월드, 위에서 매달린 벽(x 200~240, y 0~200, 다각형 0번), 오두막 원(id 1: 100,250,r20), 망루 원(id 2: 330,60,r25, 방벽).
const HUT_ID = 1,
    TOWER_ID = 2,
    ANY = -1;
const FIELD = new ObstacleField({
    width: 400,
    height: 300,
    fixedPoint: 100,
    polygons: [
        {
            points: [
                { x: 200, y: 0 },
                { x: 240, y: 0 },
                { x: 240, y: 200 },
                { x: 200, y: 200 },
            ],
        },
    ],
    circles: [
        { id: HUT_ID, x: 100, y: 250, r: 20, barrier: false },
        { id: TOWER_ID, x: 330, y: 60, r: 25, barrier: true },
    ],
    // 이동체가 ignoreId -1을 내면 방벽만 막는 원으로 봅니다.
    ignoreAll: { id: ANY, keep: (circle) => circle.barrier },
});
const MOTION = new SurfaceMotion(FIELD);
const OUT = new MotionResult();
// 한 번의 두 반경 검사는 각각의 기존 점유 검사와 같은 결과를 냅니다.
for (const [X, Y, INNER, OUTER, IGNORE] of [
    [180, 100, 5, 22, null],
    [100, 250, 1, 8, null],
    [100, 250, 1, 8, HUT_ID],
    [50, 50, 5, 22, null],
    [5, 5, 1, 8, null],
]) {
    const SMALL = FIELD.pointClear(X, Y, INNER, IGNORE),
        LARGE = FIELD.pointClear(X, Y, OUTER, IGNORE);
    assert.equal(FIELD.pointClearanceBand(X, Y, INNER, OUTER, IGNORE), SMALL ? (LARGE ? 2 : 1) : 0);
}
// 벽 왼쪽 면(변 3)의 접촉 키.
const WALL_FACE = contactKey(CONTACT_POLYGON, 0, 3);
const T_WALL = 0.36363636363636365;
const MOVED = (out) => [
    out.x,
    out.y,
    out.valid,
    out.hit,
    out.hit ? out.contact.key : null,
    out.hit ? out.contact.t : null,
];

// 반지름 10인 원이 (150,100)에서 벽 너머 (260,120)으로 갑니다. 벽 왼쪽 면에서 반지름만큼 떨어진 x=190에서 닿습니다.
assert.deepEqual(MOVED(MOTION.solve(150, 100, 260, 120, 10, null, 'stop', 0, OUT)), [
    190,
    107.27,
    true,
    true,
    WALL_FACE,
    T_WALL,
]);
assert.deepEqual([OUT.contact.nx + 0, OUT.contact.ny + 0], [-1, 0]);
// project: 접촉면 방향 성분만 남겨 목표의 y(120)까지 미끄러집니다.
assert.deepEqual(MOVED(MOTION.solve(150, 100, 260, 120, 10, null, 'project', 0, OUT)), [
    190,
    120,
    true,
    true,
    WALL_FACE,
    T_WALL,
]);
// steer: 남은 거리(≈71.15)를 속도 그대로 벽을 따라 미끄러집니다.
assert.deepEqual(MOVED(MOTION.solve(150, 100, 260, 120, 10, null, 'steer', 1, OUT)), [
    190,
    178.42,
    true,
    true,
    WALL_FACE,
    T_WALL,
]);
// 막히지 않으면 직선 그대로(hit 없음).
assert.deepEqual(MOVED(MOTION.solve(150, 100, 180, 120, 10, null, 'steer', 0, OUT)), [
    180,
    120,
    true,
    false,
    null,
    null,
]);
// 월드 경계: 왼쪽 경계에서 반지름만큼 안쪽에서 멈춥니다.
MOTION.solve(30, 100, -50, 100, 10, null, 'stop', 0, OUT);
assert.deepEqual([OUT.x, OUT.y, OUT.contact.key], [10, 100, contactKey(CONTACT_WALL, 0, 0)]);
// 건물(원 장애물): 오두막 중심에서 r + 20 = 30 위에서 멈춥니다.
MOTION.solve(100, 150, 100, 300, 10, null, 'stop', 0, OUT);
assert.deepEqual(
    [OUT.x, OUT.y, OUT.contact.key, OUT.contact.obstacle.id],
    [100, 220, contactKey(CONTACT_CIRCLE, HUT_ID), HUT_ID],
);
// 와일드카드: -1은 방벽이 아닌 오두막을 무시하고 방벽(망루)은 계속 막습니다. 특정 id는 그 건물만 무시합니다.
assert.deepEqual(MOVED(MOTION.solve(100, 190, 100, 240, 10, ANY, 'stop', 0, OUT)), [100, 240, true, false, null, null]);
assert.deepEqual(MOVED(MOTION.solve(100, 190, 100, 240, 10, HUT_ID, 'stop', 0, OUT)), [
    100,
    240,
    true,
    false,
    null,
    null,
]);
assert.equal(MOTION.solve(330, 20, 330, 90, 10, ANY, 'stop', 0, OUT).y, 25);
// 접촉 목록(재사용 객체)과 첫 접촉.
const LIST = new ContactList();
MOTION.contacts(190, 100, 10, null, LIST);
assert.equal(LIST.count, 1);
assert.deepEqual(
    [LIST.items[0].nx + 0, LIST.items[0].ny + 0, LIST.items[0].depth, LIST.items[0].key, LIST.items[0].distance],
    [-1, 0, 0, WALL_FACE, 10],
);
const HIT = new ContactHit();
assert.equal(MOTION.cast(150, 100, 110, 20, 10, null, HIT), true);
assert.deepEqual([HIT.t, HIT.nx + 0, HIT.ny + 0, HIT.key], [T_WALL, -1, 0, WALL_FACE]);
assert.equal(MOTION.cast(150, 100, 10, 0, 10, null, HIT), false);

// 이미 겹친 원: 한 칸 여유(0.01)를 두고 가장 가까운 빈 자리로 나옵니다. 막혀 풀 수 없으면 valid: false입니다.
const POINT = { x: 0, y: 0 };
assert.deepEqual(MOTION.recover(195, 100, 10, null, POINT), { x: 189.99, y: 100 });
assert.deepEqual(
    MOTION.recover(205, 100, 10, null, POINT),
    { x: 205, y: 100 },
    '벽 안쪽 깊이는 한 걸음에 못 나옵니다.',
);
assert.deepEqual(MOVED(MOTION.solve(205, 100, 150, 100, 10, null, 'project', 0, OUT)), [
    205,
    100,
    false,
    false,
    null,
    null,
]);

// 동률: 벽에 정면으로 부딪히면 위·아래 접선의 점수가 같아 tieRank가 정합니다. 기본(정수 FNV-1a + fmix32)은 tieKey마다 갈립니다.
assert.deepEqual(MOVED(MOTION.solve(150, 100, 260, 100, 10, null, 'steer', 1, OUT)), [
    190,
    170,
    true,
    true,
    WALL_FACE,
    T_WALL,
]);
assert.deepEqual(MOVED(MOTION.solve(150, 100, 260, 100, 10, null, 'steer', 2, OUT)), [
    190,
    30,
    true,
    true,
    WALL_FACE,
    T_WALL,
]);
for (const [PREFER, Y] of [
    [1, 30],
    [-1, 170],
]) {
    const BY_RANK = new SurfaceMotion(FIELD, { tieRank: (_tieKey, _contactKey, sign) => (sign === PREFER ? 0 : 1) });
    assert.equal(BY_RANK.solve(150, 100, 260, 100, 10, null, 'steer', 1, OUT).y, Y, `sign ${PREFER} 우선`);
}
// 같은 입력은 항상 같은 출력.
const AGAIN = new MotionResult();
assert.deepEqual(
    MOVED(MOTION.solve(150, 100, 260, 190, 10, null, 'steer', 9, OUT)),
    MOVED(MOTION.solve(150, 100, 260, 190, 10, null, 'steer', 9, AGAIN)),
);

// 체크포인트: 확인된 자리에서 외부 힘이 벽 안으로 밀면 마지막 확인 자리부터 다시 풀어 벽 앞에 세웁니다.
const BODY = {};
MOTION.remember(BODY, 150, 100, true);
assert.equal(MOTION.constrain(BODY, 150, 100, 10, null, 0, OUT), false, '움직이지 않았으면 다시 풀지 않습니다.');
assert.equal(MOTION.constrain(BODY, 215, 100, 10, null, 3, OUT), true);
assert.deepEqual(MOVED(OUT), [190, 100, true, true, WALL_FACE, 0.6153846153846154]);
MOTION.remember(BODY, 190, 100, true);
assert.equal(MOTION.constrain(BODY, 190, 100, 10, null, 0, OUT), false);
FIELD.setCircles(FIELD.circles.slice());
assert.equal(MOTION.constrain(BODY, 190, 100, 10, null, 0, OUT), true, '장애물이 바뀌면 같은 자리도 다시 확인합니다.');
// 이동 단계가 바뀌면(forgetAll) 기록이 있어도 처음부터 다시 풉니다.
MOTION.remember(BODY, 190, 100, true);
MOTION.forgetAll();
assert.equal(MOTION.constrain(BODY, 190, 100, 10, null, 0, OUT), true);

// 접촉 단위 함수: 정면 접촉과 상대 이동.
const SWEPT = new ContactHit();
assert.equal(SweptCircleContact.cast(-5, 0, 10, 0, 1, SweptCircleContact.policies.surface, SWEPT), true);
assert.deepEqual([SWEPT.t, SWEPT.nx + 0, SWEPT.ny + 0, SWEPT.degenerate], [0.4, -1, 0, false]);
assert.equal(
    SweptCircleContact.cast(-5, 0, -10, 0, 1, SweptCircleContact.policies.surface, SWEPT),
    false,
    '멀어지는 이동은 접촉이 아닙니다.',
);
// 겹친 채 중심이 거의 같으면 법선을 정할 수 없어 degenerate로 알립니다(대체 법선은 호출자 몫).
assert.equal(SweptCircleContact.cast(1e-7, 0, -1, 0, 1, SweptCircleContact.policies.relative, SWEPT), true);
assert.deepEqual([SWEPT.t, SWEPT.nx + 0, SWEPT.ny + 0, SWEPT.degenerate], [0, 1, 0, true]);
const VEC = { x: 0, y: 0 };
LIST.clear().add(0, 1);
assert.deepEqual(SurfaceContactGeometry.project(3, -4, LIST, VEC), { x: 3, y: 0 });
// 쌍 접촉 하나로 미끄러지기: 게임이 만든 정수 키(CONTACT_USER)와 정수 tieKey.
LIST.clear().add(-1, 0, 0, contactKey(CONTACT_USER, 7));
SurfaceContactGeometry.slide(5, 0, LIST, 4, true, 5, 3, 42, null, VEC);
assert.deepEqual([VEC.x + 0, VEC.y + 0], [0, 4]);

// 잘못된 설정은 만들 때 거부합니다.
assert.throws(() => new ObstacleField({ width: 10, height: 10, fixedPoint: 0 }), RangeError);
assert.throws(() => new ObstacleField({ width: 0, height: 10, fixedPoint: 100 }), RangeError);
assert.throws(
    () => new ObstacleField({ width: 10, height: 10, fixedPoint: 100, circles: [{ id: 'hut', x: 5, y: 5, r: 1 }] }),
    RangeError,
);
assert.throws(
    () => new ObstacleField({ width: 10, height: 10, fixedPoint: 100, ignoreAll: { id: '*', keep: () => true } }),
    TypeError,
);
console.log('geometry ok');

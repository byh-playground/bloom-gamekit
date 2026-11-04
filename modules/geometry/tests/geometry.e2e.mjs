// geometry 고정 시나리오: 손으로 계산할 수 있는 기하 값과, 벽·건물·월드 경계 사이에서 원이 움직이는 한 장면의 기대 위치.
// 접촉 해소의 기대값(stop/project/steer, 복구, 동률)은 Rally 원본 구현이 같은 입력에서 낸 값과 비트 단위로 같습니다.
import assert from 'node:assert/strict';
import {
    BoundsIndex,
    ObstacleField,
    SurfaceContactGeometry,
    SurfaceMotion,
    SweptCircleContact,
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

// 색인: 여러 칸에 걸친 항목은 한 번만, 먼 항목은 나오지 않습니다.
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
assert.deepEqual(
    INDEX.query(0, 0, 600, 600)
        .map((item) => item.id)
        .sort(),
    ['far', 'near', 'wide'],
);
assert.deepEqual(INDEX.query(300, 300, 301, 301, 1), []);

// ---------- 접촉 해소: 벽 + 건물 + 월드 경계 ----------
// 400×300 월드, 위에서 매달린 벽(x 200~240, y 0~200), 오두막 원(100,250,r20), 망루 원(330,60,r25, 방벽).
const FIELD = new ObstacleField({
    width: 400,
    height: 300,
    fixedPoint: 100,
    polygons: [
        {
            id: 'wall',
            points: [
                { x: 200, y: 0 },
                { x: 240, y: 0 },
                { x: 240, y: 200 },
                { x: 200, y: 200 },
            ],
        },
    ],
    circles: [
        { id: 'hut', x: 100, y: 250, r: 20, barrier: false },
        { id: 'tower', x: 330, y: 60, r: 25, barrier: true },
    ],
    // 이동체가 ignoreId '*'를 내면 방벽만 막는 원으로 봅니다.
    ignoreAll: { id: '*', keep: (circle) => circle.barrier },
});
const MOTION = new SurfaceMotion(FIELD);
// 법선 성분이 -0이어도 같은 값으로 비교합니다.
const PLAIN = (value) => JSON.parse(JSON.stringify(value));
const WALL_EDGE = { t: 0.36363636363636365, nx: -1, ny: 0, key: 'wall:3:edge' };

// 반지름 10인 원이 (150,100)에서 벽 너머 (260,120)으로 갑니다. 벽 왼쪽 면에서 반지름만큼 떨어진 x=190에서 닿습니다.
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 260, 120, 10, null, 'stop')), { x: 190, y: 107.27, hit: WALL_EDGE });
// project: 접촉면 방향 성분만 남겨 목표의 y(120)까지 미끄러집니다.
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 260, 120, 10, null, 'project')), { x: 190, y: 120, hit: WALL_EDGE });
// steer: 남은 거리(≈71.15)를 속도 그대로 벽을 따라 미끄러집니다.
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 260, 120, 10, null, 'steer', 'u1')), {
    x: 190,
    y: 178.42,
    hit: WALL_EDGE,
});
// 막히지 않으면 직선 그대로(hit 없음).
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 180, 120, 10)), { x: 180, y: 120, hit: null });
// 월드 경계: 왼쪽 경계에서 반지름만큼 안쪽에서 멈춥니다.
const LEFT = MOTION.solve(30, 100, -50, 100, 10, null, 'stop');
assert.deepEqual([LEFT.x, LEFT.y, LEFT.hit.key], [10, 100, 'world:left']);
// 건물(원 장애물): 오두막 중심에서 r + 20 = 30 위에서 멈춥니다.
const HUT = MOTION.solve(100, 150, 100, 300, 10, null, 'stop');
assert.deepEqual([HUT.x, HUT.y, HUT.hit.key, HUT.hit.obstacle.id], [100, 220, 'building:hut', 'hut']);
// 와일드카드: '*'는 방벽이 아닌 오두막을 무시하고 방벽(망루)은 계속 막습니다. 특정 id는 그 건물만 무시합니다.
assert.deepEqual(PLAIN(MOTION.solve(100, 190, 100, 240, 10, '*', 'stop')), { x: 100, y: 240, hit: null });
assert.deepEqual(PLAIN(MOTION.solve(100, 190, 100, 240, 10, 'hut', 'stop')), { x: 100, y: 240, hit: null });
assert.equal(MOTION.solve(330, 20, 330, 90, 10, '*', 'stop').y, 25);
// 접촉 목록과 첫 접촉.
assert.deepEqual(PLAIN(MOTION.contacts(190, 100, 10)), [{ nx: -1, ny: 0, depth: 0, key: 'wall:3', distance: 10 }]);
assert.deepEqual(PLAIN(MOTION.cast(150, 100, 110, 20, 10)), WALL_EDGE);

// 이미 겹친 원: 한 칸 여유(0.01)를 두고 가장 가까운 빈 자리로 나옵니다. 막혀 풀 수 없으면 valid: false입니다.
assert.deepEqual(PLAIN(MOTION.recover(195, 100, 10, null)), { x: 189.99, y: 100 });
assert.deepEqual(
    PLAIN(MOTION.recover(205, 100, 10, null)),
    { x: 205, y: 100 },
    '벽 안쪽 깊이는 한 걸음에 못 나옵니다.',
);
assert.deepEqual(PLAIN(MOTION.solve(205, 100, 150, 100, 10, null, 'project')), {
    x: 205,
    y: 100,
    hit: null,
    valid: false,
});

// 동률: 벽에 정면으로 부딪히면 위·아래 접선의 점수가 같아 tieRank가 정합니다. 기본(FNV-1a)은 tieKey마다 갈립니다.
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 260, 100, 10, null, 'steer', 'u1')), { x: 190, y: 170, hit: WALL_EDGE });
assert.deepEqual(PLAIN(MOTION.solve(150, 100, 260, 100, 10, null, 'steer', 'u2')), { x: 190, y: 30, hit: WALL_EDGE });
for (const [PREFER, Y] of [
    [1, 30],
    [-1, 170],
]) {
    const BY_RANK = new SurfaceMotion(FIELD, { tieRank: (_tieKey, _contactKey, sign) => (sign === PREFER ? 0 : 1) });
    assert.equal(BY_RANK.solve(150, 100, 260, 100, 10, null, 'steer', 'u1').y, Y, `sign ${PREFER} 우선`);
}
// 같은 입력은 항상 같은 출력.
assert.deepEqual(
    MOTION.solve(150, 100, 260, 190, 10, null, 'steer', 'u9'),
    MOTION.solve(150, 100, 260, 190, 10, null, 'steer', 'u9'),
);

// 체크포인트: 확인된 자리에서 외부 힘이 벽 안으로 밀면 마지막 확인 자리부터 다시 풀어 벽 앞에 세웁니다.
const BODY = {};
MOTION.remember(BODY, 150, 100, true);
assert.equal(MOTION.constrain(BODY, 150, 100, 10), null, '움직이지 않았으면 다시 풀지 않습니다.');
assert.deepEqual(PLAIN(MOTION.constrain(BODY, 215, 100, 10, null, 'b1')), {
    x: 190,
    y: 100,
    hit: { ...WALL_EDGE, t: 0.6153846153846154 },
});
MOTION.remember(BODY, 190, 100, true);
assert.equal(MOTION.constrain(BODY, 190, 100, 10), null);
FIELD.setCircles(FIELD.circles.slice());
assert.notEqual(MOTION.constrain(BODY, 190, 100, 10), null, '장애물이 바뀌면 같은 자리도 다시 확인합니다.');

// 접촉 단위 함수: 정면 접촉과 상대 이동.
assert.deepEqual(PLAIN(SweptCircleContact.cast(-5, 0, 10, 0, 1, SweptCircleContact.policies.surface)), {
    t: 0.4,
    nx: -1,
    ny: 0,
});
assert.equal(
    SweptCircleContact.cast(-5, 0, -10, 0, 1, SweptCircleContact.policies.surface),
    null,
    '멀어지는 이동은 접촉이 아닙니다.',
);
assert.deepEqual(SurfaceContactGeometry.project(3, -4, [{ nx: 0, ny: 1 }]), { x: 3, y: 0 });

// 잘못된 설정은 만들 때 거부합니다.
assert.throws(() => new ObstacleField({ width: 10, height: 10, fixedPoint: 0 }), RangeError);
assert.throws(() => new ObstacleField({ width: 0, height: 10, fixedPoint: 100 }), RangeError);
console.log('geometry ok');

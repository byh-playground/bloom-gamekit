# geometry

2D 기하 수학과 **원형 이동체가 정적 장애물에 닿았을 때의 접촉 해소**를 모은 순수 ESM 모듈입니다. 시간·난수·DOM을 읽지 않고 같은 입력이면 같은 부동소수 연산 순서로 같은 값을 돌려주므로 결정론 시뮬레이션 안에서 그대로 씁니다. 외부 import가 없는 단일 번들(`dist/geometry.js`)입니다.

이 모듈은 **기하만** 계산합니다. 다음은 담지 않습니다.

- 어디로 갈지(길찾기·거리장·목표 선택), 누가 무엇을 무시하는지, 장애물이 지형·건물·절벽 중 무엇인지는 게임이 정합니다. 모듈은 `{id, points}` 다각형과 `{id, x, y, r}` 원, 월드 크기만 압니다.
- 전투·지형 높이·fog·투영 같은 게임별 geometry. [저장소 README](../../README.md)의 "게임별로 서로 다른 공간 탐색 정책을 하나로 강제하지 않는다"는 경계를 그대로 지킵니다.
- 이동체 레코드(위치 필드, 고정소수 정수, 공간 색인 동기화). 체크포인트를 기억하는 `remember`/`constrain`은 몸체 객체를 키로만 쓰고 위치는 호출자가 넘깁니다.

## 수학 함수

모두 순수 함수이고 `{x, y}` 점 배열을 받습니다. 결과는 새 객체/값입니다.

| 함수                                                                                                     | 뜻                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pointInSimplePolygon(x, y, points)`                                                                     | 단순 다각형 안인가(짝수-홀수). 3점 미만이면 false. 경계 위는 정해지지 않음                    |
| `pointSegmentDistance(px, py, ax, ay, bx, by)`                                                           | 점-선분 최단 거리                                                                             |
| `pointPolylineDistance(px, py, points)`                                                                  | 점-폴리라인 최단 거리(선분이 없으면 1e9)                                                      |
| `segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)`                                                      | 선분 교차(끝점 접촉 포함, 평행이면 false)                                                     |
| `segmentDistance(ax, ay, bx, by, cx, cy, dx, dy)`                                                        | 선분-선분 최단 거리(교차하면 0)                                                               |
| `segmentTouchesRect(ax, ay, bx, by, x0, y0, x1, y1)` / `polygonTouchesRect(points, …)`                   | 닫힌 직사각형과 접촉(분리축, 거의 닿음 포함)                                                  |
| `polygonsOverlap(a, b)` / `boundariesCross(a, b)`                                                        | 다각형 겹침 / 가장자리끼리 0.001 안으로 접근                                                  |
| `assignBounds(item)`                                                                                     | `item.points`로 `minX`·`maxX`·`minY`·`maxY`를 붙여 돌려줌                                     |
| `roundedPointOnPolyline(points, t)`                                                                      | 폴리라인 길이 비율 t(0~1)의 점, **좌표를 정수로 반올림**                                      |
| `polylineTangentAt(points, t, delta = 0.015)`                                                            | t 앞뒤 `delta` 두 반올림 점을 잇는 단위 접선                                                  |
| `closestPolylineProgress(points, x, y)`                                                                  | 점에 가장 가까운 폴리라인 위치(길이 비율)                                                     |
| `catmullRomPoint(p0, p1, p2, p3, t)` / `smoothPolylineCatmull(points, steps = 5)`                        | Catmull-Rom 점 / 폴리라인 평활화                                                              |
| `insetPolygonTowardCenter(points, factor)`                                                               | 꼭짓점을 평균 중심 쪽으로 당김                                                                |
| `polylineToRibbonPolygon(points, halfWidth, clampFn = null)`                                             | 폴리라인을 띠 다각형으로(양 끝은 halfWidth의 0.72배 연장)                                     |
| `pointDistance(a, b)` / `nearestPointDistance(point, items)` / `minPairDistance(items, none = Infinity)` | 좌표 없음·NaN은 0으로 치는 거리 / 최근접 거리 / 최근접 쌍 거리(짝이 없으면 `none`)            |
| `triangulatePolygon(points)`                                                                             | 귀 자르기 삼각분할 → `{convex, triangles}`. `points` 객체별 캐시(고치지 않음), 못 나누면 오류 |

`roundedPointOnPolyline`처럼 이름에 "반올림"이 들어간 함수만 좌표를 바꿉니다. 나머지는 입력 좌표를 그대로 계산합니다.

## BoundsIndex: 경계 상자 색인

```js
import { BoundsIndex, assignBounds } from './geometry.js';
const WALLS = polygons.map((p) => assignBounds({ id: p.id, points: p.points }));
const INDEX = new BoundsIndex(WALLS, 256); // 칸 한 변 256
for (const WALL of INDEX.query(x, y, x + vx, y + vy, radius)) {
    /* 후보만 정밀 검사 */
}
```

항목은 `minX`·`maxX`·`minY`·`maxY`를 가져야 합니다(없으면 칸에 들어가지 않아 조회에 나오지 않습니다). 만든 뒤 항목을 옮기거나 지우는 API는 없고 바뀌면 새로 만듭니다. `query`는 **색인이 재사용하는 배열**을 돌려주므로 다음 `query` 호출 전에 쓰고 보관하지 않습니다. 여러 칸에 걸친 항목도 한 번만 나옵니다(세대 표식).

## 접촉: SweptCircleContact · SurfaceContactGeometry

- `SweptCircleContact.cast(rx, ry, vx, vy, r, policy, fallback)`: 상대 위치 `(rx, ry)`의 점이 속도 `(vx, vy)`로 한 틱(t: 0~1) 움직일 때 반지름 `r` 원 안에 처음 들어가는 `{t, nx, ny}`. 정책은 `SweptCircleContact.policies.surface`(정적 표면: 이미 닿았으면 안쪽으로 들어갈 때만 접촉)와 `.relative`(움직이는 두 원의 상대 이동: `retreat` 0.0005만큼 일찍 멈추고 접선도 접촉)입니다. 법선이 0에 가까우면 `fallback()`의 `{x, y}`를 씁니다.
- `SurfaceContactGeometry`: `closest`, `circleCast`, `edgeCast(…, slack)`, `polygonContacts(x, y, r, block, epsilon, out = [])`, `feasible`, `project`, `slide`.
    - `edgeCast`의 `slack`은 선분에서 그만큼 안쪽에 이미 들어와 있어도 `t = 0` 접촉으로 치는 허용 거리입니다(보통 고정소수 한 칸 `1 / fixedPoint`).
    - `polygonContacts`는 접촉을 `out` 뒤에 덧붙입니다(여러 다각형을 한 배열에 모을 때 중간 배열이 없습니다). 원 중심이 다각형 안이면 가장 가까운 가장자리 하나만 돌려줍니다.
    - `slide(vx, vy, contacts, budget, {steer, goalX, goalY, tieKey, tieRank})`: 접촉에 막힌 이동을 미끄러뜨립니다. `steer`가 false(기본)면 접촉 평면에 사영한 값 그대로이고(바깥 힘은 새 옆 방향 충격을 얻지 않음), true면 사영 결과가 `budget`의 3.5% 미만일 때 `goalX/goalY`에 가장 맞는 접선을 골라 `budget` 길이로 늘립니다.

방향 점수가 같은 접선 사이의 동률은 `tieRank(tieKey, contactKey, sign)`(작을수록 우선, 부호 없는 32비트)가 가립니다. 기본값은 `tieKey|contactKey|sign` 문자열의 FNV-1a 32비트 해시이며 **이 기본값을 바꾸면 결과가 달라지는 계약**입니다. 순수 함수여야 하고, 필요할 때만 불립니다(방향 점수가 앞서거나 같을 때).

## ObstacleField와 SurfaceMotion: 조정 이동

```js
import { ObstacleField, SurfaceMotion } from './geometry.js';

const FIELD = new ObstacleField({
    width: 3600,
    height: 4200,
    fixedPoint: 100, // 게임이 좌표를 1/100 격자에 반올림해 저장
    polygons: [{ id: 'cliff-0', points: [/* {x, y} … */] }], // minX 등이 없으면 만들어 붙임
    circles: [{ id: 'hut', x: 100, y: 250, r: 20 }], // 건물 같은 원 장애물
    ignoreAll: { id: '*', keep: (circle) => circle.barrier }, // 선택: "모두 무시" 와일드카드
});
const MOTION = new SurfaceMotion(FIELD, { tieRank, sync });

// 반지름 10인 원을 (150,100)에서 (260,120)으로. 막히면 접촉면을 따라 미끄러집니다.
const RESULT = MOTION.solve(150, 100, 260, 120, 10, null, 'steer', 'unit-7');
// RESULT = { x, y, hit } — 좌표는 1/fixedPoint 격자 위, hit은 처음 닿은 접촉(없으면 null)
```

**ObstacleField**는 정적 장애물의 "여기 들어가도 되는가"를 답합니다.

- 월드 경계 `[0, width] × [0, height]`, 다각형(`polygons`: 배열 또는 만들어 둔 `BoundsIndex`), 원(`circles`)을 가집니다. 원이 바뀐 틱에만 `setCircles(circles)`를 부릅니다(색인을 다시 만들고 `version`을 올림). 다각형은 만든 뒤 바뀌지 않는다고 봅니다.
- `fixedPoint`는 게임이 좌표를 `1 / fixedPoint` 격자에 반올림해 저장하는 배율입니다(Rally는 100). 접촉 허용 거리의 단위(`quantum = 1 / fixedPoint`)와 이동 결과의 반올림이 이 값에서 나옵니다. 모든 좌표 반올림은 `Math.round(v * fixedPoint) / fixedPoint`입니다.
- 질의: `polygonCircleClear(x, y, r)`, `polygonSegmentClear(x0, y0, x1, y1, r)`(다각형·월드 경계만), `segmentClear(x, y, tx, ty, r, ignoreId, departure, margin = 0.25)`, `pointClear`, `departureClear`(원 장애물까지), `nearestOpen(x, y, r, maxDistance, accept)`(16 간격 32방향 고리), `nearestExterior(x, y, r, ignoreId)`(다각형·원 모두 비어 있는 가장 가까운 자리, 최대 `exteriorSearchDistance` 256).
- 반지름 `r` 원이 다각형 가장자리와 `r - quantum`보다 가까우면 닿은 것입니다(`r`이 0이면 0.001). **다각형이 하나도 없으면 `polygon*Clear`는 월드 경계를 보지 않고 항상 true**입니다(원본 동작).
- `ignoreId`: 같은 `id`의 원은 무시합니다. `ignoreAll: {id, keep}`을 주면 `ignoreId`가 그 `id`일 때 `keep(circle)`이 참인 원(항상 막는 방벽)만 남기고 나머지는 모두 무시합니다. **`nearestExterior`는 특정 id를 무시하지 않고 와일드카드일 때만 원 장애물을 무시합니다**(Rally 원본 동작을 그대로 보존. 바꾸면 결과가 달라집니다).
- `obstacles(...)`, `BoundsIndex.query`의 결과 배열은 재사용 배열입니다.

**SurfaceMotion**은 필드 위에서 원 하나를 옮깁니다. 위치·반지름·`ignoreId`를 호출마다 받고 이동체 레코드를 모릅니다.

| 메서드                                                      | 뜻                                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solve(x, y, tx, ty, r, ignoreId, mode, tieKey)`            | 목표까지 이동한 `{x, y, hit}`(+시작 자리가 막혀 풀 수 없으면 `valid: false`). 직선이 비어 있으면 그대로, 아니면 최대 8번 접촉→미끄러짐을 반복       |
| `cast(x, y, vx, vy, r, ignoreId)` / `circleObstacleCast(…)` | 다각형·원·월드 경계 중 가장 이른 접촉 `{t, nx, ny, key}` / 원 장애물만                                                                              |
| `contacts(x, y, r, ignoreId, epsilon = 2 / fixedPoint)`     | 지금 닿았거나 `epsilon` 안으로 가까운 접촉을 키 순서로(같은 접평면은 가장 깊은 하나)                                                                |
| `recover(x, y, r, ignoreId)`                                | 이미 겹친 원을 가장 가까운 빈 자리로. 겹침이 없거나 못 옮기면 제자리                                                                                |
| `advance(x, y, tx, ty, r, ignoreId, whole)`                 | 끝점을 격자에 반올림해 비어 있는 곳까지(`whole`이면 끝까지 갈 수 있을 때만, 아니면 null / 아니면 18회 이분 탐색)                                    |
| `remember(body, x, y, verified, ignoreId)` · `forgetAll()`  | 몸체별 체크포인트 기록·전체 삭제(`WeakMap`)                                                                                                         |
| `constrain(body, x, y, r, ignoreId, tieKey)`                | 외부 힘이 몸체를 `(x, y)`로 옮긴 뒤 마지막 확인 자리부터 `'project'`로 다시 풀기. 확인된 자리·같은 `ignoreId`·같은 `version`에서 안 움직였으면 null |

`mode`: `'steer'`는 닿은 뒤 접촉면을 따라 목표 쪽으로 속도를 유지하며 미끄러지고, `'stop'`은 닿는 자리에서 멈추고, 그 밖의 값(`'project'`)은 접촉면에 사영한 만큼만 미끄러집니다.

`constrain`은 결과를 몸체에 쓰지 않습니다. 호출자가 결과를 몸체(고정소수 정수 필드 등)에 쓰고 `remember`로 다시 확정합니다. `sync` 옵션은 `solve`·`constrain`이 시작할 때 부르는 자리로, 장애물을 틱마다 지연 갱신하는 게임이 `setCircles`를 거기서 부릅니다. 한 이동 단계가 시작될 때 `forgetAll()` 후 모든 몸체를 `remember(body, x, y, false)`로 다시 기억하는 흐름을 의도했습니다.

## 결정론 계약

- 시간·난수·전역 상태를 읽지 않습니다. 호출 사이에 남는 상태는 `BoundsIndex`의 조회 표식과 `triangulatePolygon`의 결과 캐시(둘 다 결과를 바꾸지 않음), `SurfaceMotion`의 체크포인트(`constrain`의 입력이므로 같은 순서로 `remember`/`constrain`을 부르면 같은 결과)뿐입니다.
- 부동소수 연산 순서·반올림·동률 처리·허용치(1e-7, 1e-8, 1e-10, 0.001, 1e-12 등)가 Rally 원본과 같습니다. 이관할 때 이 값들을 바꾸지 않습니다.
- `Math.hypot`·`Math.cos`·`Math.sin`은 ECMAScript가 정밀도를 보장하지 않으므로 같은 엔진·버전끼리만 비트 동일이 보장됩니다(Rally 원본과 같은 조건). `Math.sqrt`·`Math.round`는 정확합니다.
- 접촉 순서는 키 문자열 정렬(UTF-16 코드 단위)과 동률 시 `tieRank`로만 정해집니다.

## 비용과 제한

- `BoundsIndex` 구축은 항목이 걸친 칸 수에 비례하고, 조회는 겹친 칸의 항목 수에 비례합니다. 항목 하나가 월드 전체에 걸치면 칸을 모두 차지하니 칸 크기와 항목 크기를 맞춥니다.
- `solve` 한 번은 최대 8번의 `cast`/`contacts`/`slide`를 돌립니다. 호출당 할당은 결과 객체·접촉 목록·접촉 키 문자열입니다. 접촉이 없는 직선 이동은 `advance` 한 번(결과 객체 하나)입니다. 필드 질의(`segmentClear` 등)는 후보 배열을 재사용하고 할당하지 않습니다(`ignoreAll` 와일드카드 질의는 걸러낸 배열 하나).
- 전제: 다각형은 자기 교차가 없는 단순 다각형이고, 이동체는 원 하나이며 회전하지 않습니다. 다각형 장애물끼리 겹쳐도 되지만(절벽 조각) 같은 접평면 접촉은 `contacts`가 하나로 줄입니다. 원-원(이동체끼리) 접촉은 `SweptCircleContact.cast`의 `relative` 정책으로 직접 호출합니다(필드는 정적 장애물만 압니다).
- 최대 8번 반복·18회 이분 탐색·`nearestOpen`의 16/32 탐색은 고정 상수입니다. 좁은 틈을 여러 번 오가는 경우는 8번째 이후를 포기하고 그 자리에 둡니다.
- `ObstacleField`는 `polygons`를 받을 때 `minX` 등이 없는 항목에 경계를 만들어 붙입니다(입력 객체를 고칩니다). `setCircles`의 원도 마찬가지입니다.

## 출처와 Rally 대응

[rally-frontier](https://github.com/byh-playground/rally-frontier) `e679806`의 `src/sim/map-geometry.js`·`terrain.js`·`navigation.js`에서 게임 규칙 의존(`LANE_CONTROL_POINTS`, 다리·강·점령지 의미, `TerrainNavigation`의 건물 topology와 유닛 레코드)을 걷어내 올렸습니다. 이관 때 다음처럼 대응합니다.

| Rally                                                                                                            | geometry                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MapGeometry.pointInSimplePolygon` · `pointSegDist` · `pointPolylineDist`                                        | `pointInSimplePolygon` · `pointSegmentDistance` · `pointPolylineDistance`                                          |
| `MapGeometry.pointOnPolyline` · `laneTangentAt` · `closestPolylineProgress`                                      | `roundedPointOnPolyline` · `polylineTangentAt` · `closestPolylineProgress`                                         |
| `MapGeometry.catmullRomPoint` · `smoothPolylineCatmull` · `insetPolygonTowardCenter` · `polylineToRibbonPolygon` | 같은 이름                                                                                                          |
| `MapGeometry.mapPointDistance` · `nearestMapDistance` · `minMapPairDistance(items)`                              | `pointDistance` · `nearestPointDistance` · `minPairDistance(items, 99999)`                                         |
| `MapGeometry.lanePoint(lane, t)`                                                                                 | `roundedPointOnPolyline(LANE_CONTROL_POINTS[lane], t)` (점 2개 이상일 때 같음)                                     |
| `TerrainGeometry.segmentsIntersect` · `segmentEdgeDistance`                                                      | `segmentsIntersect` · `segmentDistance`                                                                            |
| `TerrainSurfaceAtlas.segmentTouchesRect` · `polygonTouchesRect` · `polygonsOverlap` · `boundariesCross`          | 같은 이름                                                                                                          |
| `TerrainSurfaceAtlas.bounds(item)`                                                                               | `assignBounds(item)`                                                                                               |
| `NavigationObstacleIndex`                                                                                        | `BoundsIndex`                                                                                                      |
| `PolygonTriangulation.mesh(points)`                                                                              | `triangulatePolygon(points)`                                                                                       |
| `SweptCircleContact` · `SurfaceContactGeometry`                                                                  | 같은 이름. `edgeCast`에 `slack = 1 / FP`, `slide` 옵션에 `tieRank`(생략하면 `HashUtil.hash`와 같은 값)             |
| `TerrainGeometry.circleClear` · `segmentClear` · `nearestOpen` · `segmentBlockedBy`                              | `ObstacleField#polygonCircleClear` · `polygonSegmentClear` · `nearestOpen` · `segmentBlockedBy(index, …, quantum)` |
| `TerrainNavigation#obstacles` · `segmentClear` · `pointClear` · `departureClear` · `nearestExterior`             | `ObstacleField#obstacles` · `segmentClear` · `pointClear` · `departureClear` · `nearestExterior`                   |
| `SurfaceMotion#contacts` · `buildingCast` · `cast` · `recover` · `advance` · `solve`                             | `SurfaceMotion#contacts` · `circleObstacleCast` · `cast` · `recover` · `advance` · `solve`                         |
| `SurfaceMotion#remember` · `beginStep` · `constrain` · `commit` · `move`                                         | `remember(body, x, y, verified, ignoreId)` · `forgetAll` · `constrain`(결과 반환) · 나머지는 호출자                |

옮기지 않은 것(게임에 남습니다): `lanePoint` 데이터와 `pointInBridgeZone`·`riverDistanceAt`·`laneRiverCrossings`·`CapturePointDefinition`(Rally 지형 의미), `TerrainGeometry`의 지형 atlas 생성과 vision/projectile 색인, `TerrainSurfaceAtlas`의 램프·절벽·메시 생성(`flatMesh`·`smoothClosedContour`·`segmentCuts` 등), `NavigationGoal`(목표 영역)·`NavigationGrid`·`TerrainNavigation`의 건물 topology, 유닛 레코드(`fx`/`fy`)에 쓰는 `commit`/`move`.

## 검증

고정 시나리오는 [`tests/geometry.e2e.mjs`](./tests/geometry.e2e.mjs)(`npm test`의 core 목록)입니다. 손으로 계산한 기하 값과, 벽·건물·월드 경계 사이에서 `stop`/`project`/`steer`로 움직인 기대 위치, 복구, 동률의 `tieRank` 주입, 체크포인트 `constrain`을 확인합니다. 접촉 해소의 기대값은 Rally 원본이 같은 입력에서 낸 값입니다.

이관 시점에 Rally 원본 소스를 그대로 옮겨 무작위 입력으로 비트 단위 비교한 임시 검증(저장소에 남기지 않음)의 규모와 결과는 [릴리스 노트](../../project/docs/releases.md)의 해당 버전 항목에 있습니다.

## 실행 예제

[work-scheduler 예제의 "기하" 탭](../work-scheduler/examples/index.html#tab=geometry)에서 캔버스를 눌러(터치·마우스) 목표를 정하면 `stop`/`project`/`steer` 세 방식의 결과와 닿은 접촉을 같은 장면에 그려 봅니다.

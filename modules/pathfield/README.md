# pathfield

정수 비용 격자 위의 **거리장**입니다. 목표(여러 칸일 수 있음)에서 각 칸까지의 걸음 비용을 구해 두고, 유닛은 자기 칸에서 비용이 줄어드는 쪽으로 걸어 내려갑니다. 유닛마다 경로를 만들거나 들고 있지 않으므로, 같은 목표로 가는 유닛이 많을수록 거리장 하나를 나눠 쓰는 쪽이 싸집니다. 시간·난수·DOM을 읽지 않고 같은 호출 순서는 같은 결과를 냅니다. 외부 import가 없는 단일 번들(`dist/pathfield.js`)입니다.

이 모듈은 **격자 위의 메커니즘만** 줍니다. 다음은 담지 않습니다.

- 어디로 갈지, 언제 거리장을 쓰고 언제 직선으로 갈지(가까우면 광선 등), 거리장을 얼마나 오래 둘지(고정 목표는 오래, 추격 목표는 틱마다 등), 내려가는 칸 중 무엇을 목표점으로 고를지는 게임이 정합니다. [저장소 README](../../README.md)의 "게임별로 서로 다른 공간 탐색 정책을 하나로 강제하지 않는다"는 경계를 그대로 지킵니다.
- 칸이 지나갈 수 있는지(지형·건물·이동체 반지름)는 호출자가 준 `passable(x, y, cell)` 함수가 답합니다. 모듈은 장애물이 무엇인지 모릅니다. 번들이 독립이라 다른 모듈을 import하지 않으며, [geometry](../geometry/README.md)의 `ObstacleField`를 그 함수에 연결하는 방법은 아래에 있습니다.
- 필요한 경우 `passableEdge(x, y, nextX, nextY, cell, nextCell)`로 열린 두 칸 중심 사이의 실제 연결도 검사합니다. 양방향 결과가 같고 순수해야 하며 같은 엣지는 두 방향을 합쳐 한 번만 검사합니다. 장애물이 바뀌면 `sync`/`invalidate`가 칸과 엣지 캐시를 함께 비웁니다. 이 옵션을 생략하면 기존 격자 동작을 유지합니다.
- 지형 이동 배율(칸마다 다른 비용)은 없습니다. 비용은 직선 10, 대각 14로 고정입니다.

## 쓰는 모양

```js
import { DistanceField, FieldCache, PathGrid, UNREACHED } from './pathfield.js';

const GRID = new PathGrid({
    width: 4200,
    height: 4800,
    cellSize: 24,
    passable: (x, y) => OBSTACLES.pointClear(x, y, UNIT_RADIUS), // 칸 중심에 반지름 원이 설 수 있는가
    passableEdge: (x, y, nextX, nextY) => OBSTACLES.segmentClear(x, y, nextX, nextY, UNIT_RADIUS, null, true, 0),
});
const FIXED = new FieldCache(GRID, { capacity: 24 }); // 기지·깃발 같은 고정 목표: 오래 둠
const CHASE = new FieldCache(GRID); // 추격 목표: 틱마다 비움

// 장애물이 바뀌었을 때(건물이 생기고 사라질 때): 게임의 배치 세대 번호를 알립니다.
GRID.sync(obstacleVersion);

// 목표 해석은 게임의 것입니다: 목표를 만족하는 칸들(출발 칸)을 정해 거리장을 만듭니다.
CHASE.sync(tick);
const FIELD =
    CHASE.get(goal.key) ??
    CHASE.set(goal.key, new DistanceField(GRID, GRID.openCellsWithin(goal.x, goal.y, goal.radius + MARGIN)));

// 내 칸에서 비용이 줄어드는 쪽으로 최대 8칸. 내 칸까지만 퍼뜨립니다(지도 전체를 계산하지 않음).
const START = GRID.nearestOpen(GRID.cellAt(unit.x, unit.y));
if (FIELD.distance(START) === UNREACHED) {
    return null; // 닿을 수 없는 목표
}
const PATH = FIELD.descend(START, 8, SCRATCH);
// PATH 중 눈에 보이는 가장 먼 칸으로 향합니다(어느 칸을 고를지는 게임의 정책).
```

## PathGrid

| 멤버                                                                      | 뜻                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new PathGrid({ width, height, cellSize, passable, originX?, originY? })` | 칸 수는 `ceil(크기 / cellSize)`이고 총 칸 수는 2^22 이하여야 합니다(`RangeError`). 알 수 없는 옵션은 `TypeError`. 칸 번호는 행 우선 `row * cols + col`입니다.                                                                                        |
| `passable(x, y, cell)`                                                    | 칸 중심 좌표와 칸 번호로 "이동체가 설 수 있는가". 칸마다 **한 번만** 불리고 `invalidate()`까지 기억됩니다. 같은 입력에 같은 값을 돌려주는 순수 함수여야 합니다. 호출 순서에 기대지 마세요(거리장이 필요한 칸만, 필요할 때 부릅니다).                 |
| `cellAt(x, y)`·`colOf`·`rowOf`·`centerX`·`centerY`                        | 좌표 ↔ 칸. `cellAt`은 격자 밖을 가장자리 칸으로 자릅니다(NaN 좌표는 안 됩니다).                                                                                                                                                                      |
| `isOpen(cell)`                                                            | 통과 가능한지. 격자 밖 번호는 false.                                                                                                                                                                                                                 |
| `stepCell(col, row, direction)`                                           | 방향 0..7(동·남·서·북·남동·남서·북서·북동)으로 한 걸음 갈 수 있으면 이웃 칸 번호, 아니면 -1. **모서리 가로지르기 금지**: 대각 걸음은 두 직교 이웃이 모두 열려 있어야 합니다.                                                                         |
| `invalidate()`·`sync(version)`                                            | 통과 판정의 기억을 비우고 `revision`을 올립니다. `sync`는 게임이 가진 장애물 배치의 세대 번호가 지난번과 다를 때만 `invalidate()`하고 true를 돌려줍니다.                                                                                             |
| `nearestOpen(cell, maxRing = 12)`                                         | 자기 칸이 열려 있으면 그 칸, 아니면 정사각 고리를 넓혀 가며 가장 가까운(칸 거리 제곱) 열린 칸. 같은 고리의 동률은 훑는 순서(행 오름차순, 행 안에서 열 오름차순)가 먼저인 칸입니다. 없으면 -1.                                                        |
| `openCellsWithin(x, y, outer, inner = 0, accept = null, out = [])`        | 중심까지의 거리가 `inner` 이상 `outer` 이하인 열린 칸을 행 우선으로 `out`에 채웁니다. `accept(centerX, centerY, cell)`을 주면 그것도 통과한 칸만. 목표 영역의 여유(칸 대각선의 절반 등)를 더하는 것은 호출자의 몫이고 모듈은 반지름을 그대로 씁니다. |
| `reachableFrom(start, out?)`                                              | `start`에서 8방향으로 걸어 닿는 칸을 1로 표시한 `Uint8Array(size)`. 거리장보다 싸게 "이어져 있는가"만 알고 싶을 때(지도 연결 검증 등). `start`가 열려 있지 않으면 모두 0.                                                                            |

## DistanceField

`new DistanceField(grid, sources)`: `sources`는 출발 칸 번호 배열(열린 칸, 겹쳐도 됨, 격자 밖 번호는 `RangeError`)입니다. 출발 칸의 비용은 0이고, 닿지 못한 칸은 `UNREACHED`(0x7fffffff)입니다. 비용은 직선 `STRAIGHT_COST` 10, 대각 `DIAGONAL_COST` 14의 정수 합이라 부동소수 오차가 없습니다.

| 멤버                                 | 뜻                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settle(target = -1)`                | 비용 순서로 칸을 확정해 갑니다. `target`이 확정되면(힙에 그보다 싼 칸이 없으면) 멈추고, 주지 않으면 닿을 수 있는 모든 칸을 확정합니다. `target`이 확정되면 비용이 그 이하인 칸은 모두 확정입니다.                        |
| `distance(cell)`                     | `settle(cell)` 뒤 `dist[cell]`. 그 칸까지만 퍼뜨립니다.                                                                                                                                                                  |
| `dist`                               | `Int32Array`. **확정한 칸만 믿을 수 있습니다**(확정하지 않은 칸의 값은 임시: 실제보다 크거나 `UNREACHED`).                                                                                                               |
| `done`                               | 모든 칸이 확정됐는지.                                                                                                                                                                                                    |
| `lowestNeighbor(cell)`               | `cell`보다 싼 이웃 중 가장 싼 칸, 없으면 -1. 동률은 **방향 순서**(동·남·서·북·남동·남서·북서·북동)에서 먼저인 쪽입니다. `cell`이 확정되어 있어야 합니다.                                                                 |
| `descend(start, maxSteps, out = [])` | `start`까지 확정한 뒤 `lowestNeighbor`를 최대 `maxSteps`번 따라간 칸 번호를 `out`(먼저 비움)에 채워 돌려줍니다. `start`는 넣지 않고, 출발 칸이나 더 싼 이웃이 없는 칸에서 멈춥니다. 닿지 못하는 `start`면 빈 결과입니다. |

게으르게 확정하므로 가까운 질의 하나는 지도 전체를 계산하지 않습니다. 같은 거리장에 다른 칸을 물으면 이어서 퍼뜨립니다. 이미 확정된 칸은 다시 계산하지 않고, 확정되는 순서와 상관없이 값은 같습니다(최단 비용은 하나입니다).

## FieldCache

`new FieldCache(grid, { capacity = Infinity })`: 키로 거리장을 보관합니다. 무엇을 키로 삼을지, 언제 새로 만들지는 호출자가 정하고 이 클래스는 세 가지만 맡습니다.

- 용량을 넘기려 하면 **먼저 넣은 것부터** 버립니다(FIFO. `get`으로 꺼내도 순서가 바뀌지 않습니다. 있는 키를 `set`으로 덮어써도 그대로입니다).
- 격자가 `invalidate()`되면(`revision`이 바뀌면) 담긴 거리장을 모두 버립니다. 낡은 통과 판정으로 만든 거리장을 쓰지 않게 합니다.
- `sync(epoch)`: 세대(틱 등)가 지난번과 다르면 비웁니다. 한 틱 안에서만 나눠 쓸 거리장(추격 목표)에 씁니다.

`get(key)`·`set(key, field)`·`has(key)`·`size`·`clear()`. 캐시는 선택입니다. 거리장을 직접 `Map`에 두어도 됩니다.

## geometry의 ObstacleField와 연결

```js
import { ObstacleField } from './geometry.js';
const OBSTACLES = new ObstacleField({ width, height, fixedPoint: 100, polygons, circles });
const GRID = new PathGrid({ width, height, cellSize: 16, passable: (x, y) => OBSTACLES.pointClear(x, y, RADIUS) });
// 장애물이 바뀌면: OBSTACLES.setCircles(...) 뒤 GRID.invalidate()
```

반지름이 다른 이동체는 격자를 따로 둡니다(통과 판정이 반지름마다 다릅니다). 보이는가(직선이 막히는가)는 `OBSTACLES.segmentClear`가 답하고, 어느 칸을 목표점으로 고를지는 호출자가 `descend` 결과에서 정합니다.

## 비용과 제한

- `settle`은 칸당 8방향 검사와 이진 힙 한 번이라 O(칸 수 · log 칸 수)이지만, 게으르게 멈추므로 보통 **유닛 칸의 비용 이하인 칸만** 봅니다. 거리장 하나의 메모리는 `Int32Array(칸 수)`와 힙 배열입니다.
- 통과 판정은 거리장이 닿는 칸에서만, 칸마다 한 번 불립니다. 장애물이 많이 바뀌면 `invalidate()`가 잦아 판정을 다시 부르므로, 바뀐 틱에만 부르세요.
- `descend`·`openCellsWithin`·`reachableFrom`은 호출자의 `out`을 채우므로 틱마다 쓰는 경로에서 배열을 새로 만들지 않습니다(`descend`의 `out`을 생략하면 새 배열).
- 칸 수 상한은 2^22(힙 키가 `비용 * 2^k + 칸 번호`로 정확히 표현되는 범위)입니다. 목표가 하나이고 지도가 크면 `cellSize`를 키우세요.
- 비용은 직선 10, 대각 14, 모서리 가로지르기 금지로 **고정**입니다. 방향 순서와 동률 규칙은 계약이라 바꾸면 거리장을 읽는 게임의 결과가 달라집니다(비호환 변경).

## 결정론

시간·난수·DOM·`Map` 순회가 없습니다. 비용은 정수이고, 힙은 `(비용, 칸 번호)`를 한 수로 묶어 비용이 같으면 칸 번호가 작은 쪽을 먼저 꺼냅니다. 내려가기의 동률은 방향 순서, `nearestOpen`의 동률은 훑는 순서가 정합니다. 같은 격자·통과 판정·출발 칸이면 같은 거리장이고, 어느 칸을 먼저 물었는지와 상관없이 확정된 칸의 값은 같습니다.

## 라이브러리 대신 쓰는 이유

| 비교                       | [PathFinding.js](https://github.com/qiao/PathFinding.js)   | [EasyStar.js](https://github.com/prettymuchbryce/easystarjs)                            | pathfield                                                                     |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 구하는 것                  | 시작점 하나에서 끝점 하나까지의 경로(좌표 배열)            | 시작·끝 한 쌍마다 `findPath` 요청, 경로를 콜백으로(README에 여러 출발·목표 탐색은 없음) | 목표(여러 칸 가능)에서 모든 칸까지의 비용. 유닛이 비용을 읽고 내려감          |
| 같은 목표로 가는 유닛 여럿 | 유닛마다 `findPath`(격자는 탐색마다 `clone()` 해야 재사용) | 유닛마다 요청                                                                           | 거리장 하나를 나눠 읽음. 유닛마다 탐색도 경로 보관도 없음                     |
| 모서리                     | `dontCrossCorners` 옵션                                    | `enableCornerCutting`                                                                   | 항상 금지(고정)                                                               |
| 동점·순서                  | README에 계약이 없음                                       | README에 계약이 없음                                                                    | 방향 순서·칸 번호 순서가 계약, 정수 비용이라 시뮬레이션 체크섬에 넣을 수 있음 |
| 할당                       | 경로 배열을 새로 만듦                                      | 경로 배열을 새로 만듦                                                                   | 호출자의 `out` 배열을 채움                                                    |

결정론 시뮬레이션에서 수백 마리가 같은 목표로 매 틱 걸어야 하고(경로를 만들면 탐색이 마릿수에 비례합니다), 길 위의 동점이 모든 피어에서 같게 풀려야 해서 직접 둡니다. 한 쌍의 경로가 필요한 게임은 이 라이브러리들이 맞습니다.

## 게임에서 옮길 때

[rally-frontier](https://github.com/byh-playground/rally-frontier)의 `src/sim/navigation-field.js`(`NavigationGrid`·`DistanceField`·`CellHeap`)에서 목표 해석·캐시 정책·직선 광선을 걷어내 올렸습니다. 고정 시나리오 `modules/pathfield/tests/pathfield.e2e.mjs`의 `createPlanner`가 Rally가 이 모듈을 쓰는 모양이며, 원본 `NavigationGrid`로 같은 질의를 돌린 결과(목표점 좌표의 해시)와 한 비트도 다르지 않은 것을 확인했습니다.

| 원본                                                       | 모듈                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new NavigationGrid(nav, radius)`의 `cols`·`rows`·`cellAt` | `new PathGrid({ width, height, cellSize: CELL, passable: (x, y) => field.pointClear(x, y, radius) })`                                                                                                    |
| `isOpen(cell)`(`open` 캐시)·`reset()`                      | `isOpen(cell)`·`invalidate()`(`grid.sync(topology.version)`이 `version` 비교와 `reset`을 대신함)                                                                                                         |
| `nearestOpen(cell, maxRing)`·`centerX`·`centerY`           | 같음                                                                                                                                                                                                     |
| `goalSources(goal)`의 칸 훑기                              | `openCellsWithin(goal.x, goal.y, goal.radius + MARGIN, max(0, goal.innerRadius - MARGIN), accept)`. 목표 영역의 여유 `MARGIN`·`terrainLine` 판정(`accept`)·"출발 칸이 없으면 목표 칸 근처"는 게임에 남음 |
| `new DistanceField(grid, sources)`·`settle(target)`        | 같음(`done`·`dist` 유지, 출발 칸 `Set`은 없어지고 중복은 무시)                                                                                                                                           |
| `next()`의 내려가기 루프                                   | `field.descend(start, LOOKAHEAD, out)`. "가장 먼 보이는 칸"을 고르는 루프는 게임에 남음                                                                                                                  |
| `fields`(최대 24, 먼저 넣은 것 제거)·`local`(틱마다)       | `new FieldCache(grid, { capacity: 24 })`·`new FieldCache(grid)` + `sync(tick)`                                                                                                                           |
| `reachableFrom(x, y)`                                      | `reachableFrom(nearestOpen(cellAt(x, y), 4))`                                                                                                                                                            |
| `RAY_RANGE`(가까우면 직선)·`LOOKAHEAD`·`MAX_FIELDS`        | 게임의 정책이라 모듈에 없음                                                                                                                                                                              |

달라지는 점: 힙 키의 곱수가 65536 고정에서 칸 수 이상의 2의 거듭제곱으로 바뀌어 칸이 65,536개를 넘어도 됩니다(키 순서는 같습니다). 원본의 `settled(cell)`은 쓰는 곳이 없어 옮기지 않았습니다. `descend`는 이웃 8칸의 열림을 모두 확인하지만(원본은 더 싼 이웃만), 통과 판정은 순수하므로 결과는 같습니다.

## 실행 예제

work-scheduler 예제의 "거리장" 탭([바로 보기](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=pathfield))에서 캔버스를 누르거나 끌어 목표를 정하면, 곧장 가는 선이 벽에 막힌 유닛이 어느 칸으로 내려가는지(밝기 = 비용)와 "유닛 칸까지만 퍼뜨림 / 전부 계산"의 차이를 봅니다. 장애물은 geometry의 `ObstacleField`입니다. 고정 시나리오: `node modules/pathfield/tests/pathfield.e2e.mjs`(core 목록), `project/tests/previews.mjs`의 거리장 탭(마우스·화살표 키·걸음·터치 에뮬레이션).

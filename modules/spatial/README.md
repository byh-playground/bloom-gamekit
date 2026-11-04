# spatial

결정론 시뮬레이션이 "가까운 것만 보려고" 쓰는 균일 격자(고정 칸 격자) 두 가지입니다. 시간·난수·DOM을 읽지 않고, 칸 색인은 숫자 인덱스 배열이며(질의 경로에 Map·문자열 키·정렬 없음), 질의는 호출자가 준 `out` 배열을 채워서 할당하지 않습니다.

- `UniformGrid`: 점 항목(유닛 중심 등)을 중심 칸 하나에 넣고, 사각형·원 후보와 최근접 고리 탐색을 돌려줍니다.
- `BoundsGrid`: 사각형 항목(한 틱 움직임을 감싼 상자 등)을 겹치는 모든 칸에 넣고, 겹치는 항목을 삽입 순서로 중복 없이 돌려줍니다.

예외:

- 질의는 칸 단위 **후보**입니다. 정확한 거리·겹침 판정은 호출자가 합니다(`BoundsGrid`의 경계 상자 겹침만 정확합니다).
- 결과의 **순서가 계약**입니다(아래 "순서 계약"). 시뮬레이션이 순서에 기대면 그대로 믿어도 되고, 모듈은 정렬하지 않습니다.
- 항목은 정수 번호(배열 인덱스) 또는 객체이고, 좌표는 `insert`가 받습니다. 항목에 `x`·`y` 속성이 있을 필요는 없습니다.

## UniformGrid

    import { UniformGrid } from '../../../dist/spatial.js';

    const GRID = new UniformGrid({ cellSize: 64, width: 1280, height: 720, outside: 'clamp' });
    const NEAR = []; // 호출자가 하나 만들어 재사용합니다

    // 틱마다 다시 만들기
    GRID.clear();
    for (let i = 0; i < units.length; i++) {
        GRID.insert(i, units[i].x, units[i].y);
    }

    // 반지름 r 원 주변 후보 → 정확한 거리는 직접 검사합니다
    GRID.queryCircle(unit.x, unit.y, r + MAX_UNIT_RADIUS, NEAR);
    for (let k = 0; k < NEAR.length; k++) {
        const OTHER = units[NEAR[k]];
        // ...
    }

| 옵션                          | 뜻                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cellSize`, `width`, `height` | 칸 한 변과 격자가 덮는 크기(좌표와 같은 단위). 칸 수는 `ceil(크기 / cellSize)`입니다. 칸이 2^24개를 넘으면 `RangeError`입니다.                                                              |
| `originX`, `originY`          | 칸 (0, 0)의 좌표(기본 0). 칸 번호는 `floor((좌표 - 원점) / cellSize)`입니다.                                                                                                                |
| `outside` (필수)              | 세계 밖 좌표 규약. `'clamp'`: 가장자리 칸에 넣습니다. `'overflow'`: 따로 보관하고 질의마다 사각형 안에 있는지 정확히 검사합니다. 두 규칙의 결과가 달라서 고르게 합니다.                     |
| `groups`                      | 항목 구분 수(기본 0). 구분(예: 진영)마다 칸별 버킷을 더 가져 한쪽만 읽는 질의가 나머지를 훑지 않습니다. `'clamp'`와 `track` `false`/`'index'`에서만 됩니다.                                 |
| `track`                       | 항목을 다시 찾는 방법. `false`(기본): 다시 만들기 전용, 항목은 아무 값. `'index'`: 항목이 0 이상의 정수이고 typed array로 추적(이동·제거 O(1)). `'identity'`: 항목이 객체이고 Map으로 추적. |

### 틱마다 다시 만들기, 움직인 것만 옮기기

- `track: false`면 `clear()` + `insert()`만 있고(가장 가벼운 경로) `move`·`remove`·`has`·`keyOf`는 `TypeError`입니다. 같은 항목을 두 번 넣으면 두 번 들어갑니다.
- `track: 'index'`면 `move(item, x, y)`가 칸이 바뀐 항목만 옮깁니다(같은 칸이면 무작업). 없던 항목이면 `insert`와 같습니다. `remove(item)`·`has(item)`·`keyOf(item)`이 O(1)입니다. 항목 번호가 큰 값이면 번호 크기만큼 typed array가 커집니다(0부터 촘촘한 번호가 맞습니다).
- `track: 'identity'`면 같은 일을 객체 항목에 합니다. 위치는 Map으로 찾고, 칸이 바뀌는 이동과 제거는 그 칸의 버킷을 선형 탐색합니다(칸이 작아 버킷이 짧다는 전제).
- 추적하는 격자에서 `insert`는 이미 있는 항목을 먼저 빼고 끝에 다시 넣습니다.

### 구분(group)

항목은 `insert(item, x, y, group)`의 `group`(0 이상 정수) 하나에 속합니다. 모든 항목은 전체 버킷에도 들어가므로 `group`을 생략한 질의는 전부 읽습니다. `queryRect(..., out, group)`처럼 `group`을 주면 그 구분만 읽고, 순서는 전체 버킷과 같은 규칙입니다. `move`에서 `group`을 생략하면 지금 구분을 유지합니다.

### 세계 밖

| `outside`    | 항목 좌표가 세계 밖일 때                                                  | 질의 사각형이 세계 밖일 때                                                                          | `cellX`·`cellY`                        |
| ------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `'clamp'`    | 가장자리 칸에 넣습니다. ±Infinity도 가장자리, NaN은 `RangeError`입니다.   | 가장자리 칸으로 자릅니다. NaN이면 빈 결과입니다.                                                    | `0..cols-1`로 자름                     |
| `'overflow'` | 보관 칸(번호 `cellTotal`)에 넣습니다. 유한하지 않은 좌표도 여기로 갑니다. | 안에 걸친 칸만 읽고, 보관 항목은 사각형 안일 때만 돌려줍니다. 유한하지 않은 사각형은 빈 결과입니다. | 자르지 않음(밖이면 음수나 `cols` 이상) |

보관 항목의 사각형 판정은 `insert`/`move`가 마지막으로 받은 좌표를 씁니다.

### 순서 계약

모든 질의는 `out.length = 0`으로 시작해 `out`에 채우고 `out`을 돌려줍니다.

| 호출                       | 결과 순서                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 버킷 안                    | `insert` 순서. `remove`·`move`는 빼는 자리에 **마지막 항목이 옮겨 오고**(swap-remove), 옮긴 항목은 새 칸 버킷의 끝에 붙습니다. 칸이 그대로면 순서도 그대로입니다.                                      |
| `queryRect`·`queryCircle`  | 덮는 칸을 **행 우선**(y 바깥·x 안쪽, 칸 번호 오름차순)으로, 칸 안은 버킷 순서. `'overflow'`는 그 뒤에 보관 순서(swap-remove 포함)로 사각형 안의 보관 항목.                                             |
| `queryCircle(x, y, r)`     | `queryRect(x - r, y - r, x + r, y + r)`와 같은 부동소수 계산입니다. 원 안의 항목이 아니라 외접 사각형이 덮는 칸의 후보입니다.                                                                          |
| `cellItems(key)`           | 그 칸의 버킷 자체(읽기 전용, 다음 변경 전까지). 칸 번호 오름차순으로 훑으면 `queryRect` 전체 칸 순서와 같습니다.                                                                                       |
| `queryCellRing`·`ringCell` | 고리의 첫 행·마지막 행 칸을 열마다 (첫 행, 마지막 행)으로, 이어서 첫 열·마지막 열 칸을 행마다 (첫 열, 마지막 열)로. 격자 밖 칸은 건너뜁니다.                                                           |
| `visitNearestFirst`        | 고리 0부터 바깥으로, 고리 안은 행 번호 오름차순(고리의 첫·마지막 행은 열 오름차순 전부, 가운데 행은 왼쪽 열 다음 오른쪽 열). 중심이 사각형 밖이면 사각형 전체를 행 우선으로 한 번. 보관 항목이 마지막. |
| `BoundsGrid.queryBounds`   | **삽입 순서**(id 순서가 아님)로 중복 없이.                                                                                                                                                             |

같은 호출 순서는 같은 결과를 냅니다. 정렬이 필요한 규칙(거리, id 등)은 게임이 후보를 받아 직접 정합니다.

### 최근접 고리 탐색

[알고리즘 레퍼런스 A001](https://github.com/byh-playground/bloom-reference/blob/main/algorithms/index.html)의 Budmori 0.67.37 방식입니다. 자기 칸에서 고리 순으로 보고, k번째 고리는 (k - 1) · `cellSize`보다 멀어 현재 최근접을 이길 수 없으면 멈춥니다. 항목이 중심 칸에 정확히 들어 있어야 성립하므로 `'overflow'` 격자(세계 밖은 따로)를 권합니다. `'clamp'` 격자에서는 세계 안에 있는 항목에만 맞습니다.

    // 콜백 하나로: visit이 지금까지의 최근접 거리를 돌려줍니다. 함수와 상태는 호출자가 만들어 재사용합니다.
    GRID.visitNearestFirst(me.x, me.y, me.x - R, me.y - R, me.x + R, me.y + R, CONSIDER);

    // 고리를 직접 넓히기: 먹이 탐색처럼 최근접 확정 전에는 계속 넓힙니다.
    for (let ring = 0; ring < GRID.cols; ring++) {
        for (const FOOD of GRID.queryCellRing(CX, CY, ring, OUT)) {
            // 최근접 갱신
        }
        if (nearest && nearestDistance < GRID.distanceToOutsideRing(me.x, me.y, CX, CY, ring)) {
            break;
        }
    }

    // 예산을 나눠 칸 단위로 이어서: ringCellCount·ringCell이 queryCellRing과 같은 칸 순서입니다.
    const KEY = GRID.ringCell(CX, CY, ring, index); // 격자 밖이면 -1
    const BUCKET = GRID.cellItems(KEY);

- `visitNearestFirst`는 훑는 동안 격자를 바꾸면 안 됩니다. 사각형 안의 보관 항목은 마지막에 visit하며 반환값을 쓰지 않습니다.
- `distanceToOutsideRing`은 격자 가장자리에 닿은 쪽을 제외한 최소 거리이고, 바깥 칸이 없으면 `Infinity`입니다.

## BoundsGrid

    const SWEPT = new BoundsGrid({ cellSize: 6400, width: 128000, height: 72000, maxCells: 16, views: 2 });
    SWEPT.clear();
    for (const I of ORDER) {
        SWEPT.insert(I, minX, minY, maxX, maxY, (side !== 0 ? 1 : 0) | (side !== 1 ? 2 : 0));
    }
    // 자기보다 늦게 넣은 id만, 쌍을 한 번씩
    SWEPT.queryOverlaps(i, PAIRS, attackerSide, i);

- 항목(`id`는 0 이상 정수, `clear` 안에서 한 번)은 경계 상자가 겹치는 모든 칸에 들어가고, 질의는 경계 상자가 겹치거나 **맞닿는** 항목을 돌려줍니다. 칸 후보가 아니라 상자 겹침이 정확합니다.
- 넣은 순서가 곧 결과 순서(rank)입니다. 질의는 칸 버킷들을 rank 머리끼리 병합해 같은 항목을 한 번만 내므로 정렬이 없습니다. 원하는 순서가 있으면 그 순서로 `insert`하세요.
- `maxCells`보다 많은 칸을 덮는 항목은 큰 항목 목록에 들어가 모든 질의가 봅니다. `maxCells`보다 많은 칸을 덮는 질의는 병합 대신 보이는 항목 전체를 한 번씩 봅니다. 결과는 같습니다.
- `views`(0..30)는 일부 항목만 보는 부분 목록입니다. `insert`의 `viewMask`에서 켠 비트 `v`에 속하고, `queryBounds(..., view)`는 그 목록만 읽습니다. 전체는 `view` -1입니다.
- 상자 계산(여유, 움직임 범위)은 게임이 합니다. 같은 `clear` 안에서 한 id를 두 번 넣지 않습니다.
- [geometry](../geometry/README.md)의 `BoundsIndex`는 지형 다각형처럼 만든 뒤 바뀌지 않는 항목을 세계 경계 없이 Map 칸에 두는 정적 색인으로, 용도가 다릅니다. 번들이 독립이라 서로 import하지 않습니다.

## 비용과 제한

- `clear`는 사용한 칸의 버킷만 비웁니다(버킷 배열은 재사용). 칸 수가 아니라 쓴 칸 수에 비례합니다.
- `insert`는 칸 하나에 `push`하는 O(1)입니다. `track: false`는 칸 번호 계산과 `push`뿐이라 가장 가볍습니다.
- 질의는 덮는 칸 수 + 후보 수에 비례하고 할당하지 않습니다. 후보가 많은 질의는 `out`에 `push`하는 비용이 지배적입니다.
- 메모리: 칸 배열 `cellTotal + 1`개 슬롯(쓴 칸만 버킷 배열), `touched` 바이트 배열 하나, `track: 'index'`면 항목 번호 최댓값 크기의 Int32Array 2개(`groups`가 있으면 2개 더). `BoundsGrid`는 id 최댓값 크기의 Float64Array 4개와 Int32Array 1개입니다.
- `out` 배열은 호출마다 덮어씁니다. 중첩 질의에는 서로 다른 `out`을 쓰고, 결과를 오래 들고 있으려면 복사하세요. `cellItems`·`usedCells`는 살아 있는 내부 배열이라 수정하지 않습니다.
- 숫자 좌표만 받습니다. `track: 'index'` 항목과 `BoundsGrid`의 `id`는 0..2^24-1 정수여야 합니다(아니면 `RangeError`). 번호 크기만큼 typed array가 커지므로 0부터 촘촘한 번호가 맞습니다.
- 알 수 없는 옵션·잘못된 값은 만들 때 던집니다.

## 결정론

시간·난수·DOM을 읽지 않고 같은 호출 순서는 같은 결과를 냅니다. `Map`(`track: 'identity'`)은 항목을 다시 찾는 데만 쓰고 순회하지 않으며, 질의 순서는 칸 번호와 버킷 순서로만 정해집니다. 칸 번호는 `Math.floor((좌표 - 원점) / cellSize)`라 좌표를 소수로 넘겨도 플랫폼 간 같은 IEEE 754 결과입니다.

## 라이브러리 대신 쓰는 이유

| 비교      | [rbush](https://github.com/mourner/rbush) | [flatbush](https://github.com/mourner/flatbush) | spatial                                                        |
| --------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| 구조      | 동적 R-tree                               | 정적 packed Hilbert R-tree                      | 고정 칸 균일 격자                                              |
| 질의 결과 | 질의마다 새 배열을 만듦                   | 질의마다 새 배열(인덱스)                        | 호출자의 `out` 배열을 채움, 할당 없음                          |
| 결과 순서 | 트리 순회 순서(삽입 순서 아님)            | 트리 순서                                       | 칸 행 우선 + 삽입 순서(계약), 결정론 시뮬레이션이 기댈 수 있음 |
| 갱신      | 삽입·제거(이동은 제거 후 삽입)            | 불가(정적)                                      | 같은 칸이면 무작업, 칸이 바뀌면 swap-remove 후 끝에 붙임       |
| 최근접    | 별도 패키지(rbush-knn)                    | `neighbors`(거리순 k개)                         | 칸 고리 + 안전 중단, 후보를 게임 규칙으로 직접 고름            |

게임이 이미 정해 둔 칸 크기·세계 좌표 규약·질의 순서를 그대로 재현해야 하고(시뮬레이션 결과가 순서에 달려 있음), 매 틱 수천 번 `out` 재사용 질의를 해야 해서 직접 둡니다.

## 게임에서 옮길 때

두 게임의 격자 구현을 이 모듈로 옮기는 대응입니다(고정 시나리오 `modules/spatial/tests/spatial.e2e.mjs`의 어댑터가 같은 모양이며, 원본 구현으로 돌린 같은 흐름과 질의 결과·순서가 한 비트도 다르지 않은 것을 확인했습니다). 순서 정책을 켜는 옵션은 없고, 위 순서 계약이 두 게임의 기존 순서입니다.

### rally-frontier (`src/sim/spatial-grids.js`, `strategy-sim.js`)

| 원본                                                            | 모듈                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new DeterministicCollisionGrid(COLLISION_SPATIAL_CELL, world)` | `new UniformGrid({ cellSize: COLLISION_SPATIAL_CELL * FP, width: world.width * FP, height: world.height * FP, outside: 'clamp' })`                                                                                                                                         |
| `grid.reset(units, maxRadius)`                                  | `grid.clear(); for (...) { if (u.alive) grid.insert(i, u.fx, u.fy); }` (`maxRadius`는 호출자가 보관)                                                                                                                                                                       |
| `grid.queryCandidatesFP(fx, fy, radius, out)`                   | `grid.queryCircle(fx, fy, radius + maxRadius, out)`                                                                                                                                                                                                                        |
| `cellXFP(v)`·`cellYFP(v)`·`grid.cols`                           | `cellX(v)`·`cellY(v)`·`cols`                                                                                                                                                                                                                                               |
| `grid.buckets[key]`·`grid.buckets.length`                       | `cellItems(key)`·`cellTotal`                                                                                                                                                                                                                                               |
| `new DeterministicSweptCollisionGrid(world)`                    | `new BoundsGrid({ cellSize: COLLISION_SPATIAL_CELL * FP, width: world.width * FP, height: world.height * FP, maxCells: 16, views: 2 })`                                                                                                                                    |
| `swept.reset(units, motion, radii, segX, segY, coarse)`         | `swept.clear()` 뒤 `for (key < coarse.cellTotal) for (i of coarse.cellItems(key))`로 살아 있고 `radii[i] > 0`인 유닛마다 `endCell[i] = key; swept.insert(i, minX, minY, maxX, maxY, (u.side !== 0 ? 1 : 0) \| (u.side !== 1 ? 2 : 0))` (`endCell`·상자 계산은 게임에 남음) |
| `swept.query(i, coarse, minCx, maxCx, minCy, maxCy, side)`      | `swept.queryOverlaps(i, out, side === 0 \|\| side === 1 ? side : -1, i)` 뒤에 `endCell[j]`의 칸이 범위 안인 것만 남김                                                                                                                                                      |
| `new DeterministicUnitSpatialGrid(SIM_SPATIAL_CELL, world)`     | `new UniformGrid({ cellSize: SIM_SPATIAL_CELL, width: world.width, height: world.height, outside: 'clamp', groups: 3, track: 'index' })`, `group = side === 0 ? 0 : side === 1 ? 1 : 2`(옛 `sideIndex`)                                                                    |
| `unitSpatial.reset(units, unitIndexById)`                       | `clear(); for (...) { if (u.alive) insert(i, u.x, u.y, group) }` (`unitIndexById`는 sim이 계속 보관)                                                                                                                                                                       |
| `unitSpatial.add(u, index)`                                     | `if (u.alive) insert(index, u.x, u.y, group)`                                                                                                                                                                                                                              |
| `unitSpatial.sync(u)`                                           | `if (u.alive) move(index, u.x, u.y); else if (keyOf(index) !== keyAt(u.x, u.y)) remove(index);` (`index = unitIndexById.get(u.id)`)                                                                                                                                        |
| `unitSpatial.query(x, y, r, out, side)`                         | `queryCircle(x, y, r, out, side == null ? -1 : group)`                                                                                                                                                                                                                     |
| `new DeterministicBuildingSpatialGrid(SIM_SPATIAL_CELL, world)` | `new UniformGrid({ cellSize: SIM_SPATIAL_CELL, width: world.width, height: world.height, outside: 'clamp' })`; `reset(buildings)`는 `clear()` 뒤 `b && b.alive !== false`인 것만 `insert(i, b.x, b.y)`; `query`는 `queryCircle`                                            |

원본 `sync`는 이미 색인에서 뺀 죽은 유닛을 칸이 바뀌게 한 번 더 sync하면 낡은 슬롯으로 다른 유닛을 색인에서 뺐습니다. 모듈의 `remove`·`keyOf`는 이를 재현하지 않으므로 이 경우에만 결과가 다릅니다(확인한 호출은 살아 있는 유닛만 sync합니다).

`strategy-sim.js`의 호출은 구조를 바꾸지 않고 격자 호출만 바뀝니다: `nearbyUnits`·`withNearbyUnits`·`forEachNearbyHostileUnit`은 `unitSpatial.queryCircle`, `nearbyBuildingIndices`는 `buildingSpatial.queryCircle`, `rebuildRuntimeIndexes`·`ensureBuildingSpatial`은 `clear` + `insert`, `syncUnitSpatial`·`addRuntimeUnit`은 위 `sync`·`add`, `resolveAlliedSoftSeparation`과 `resolveNonAlliedSurfaceMotion`은 충돌·스윕 격자입니다. 호출 쪽 버퍼 회전(`spatialQueryBuffers`, 범위 스택)과 `isAlliedCollisionUnit`·표적 규칙은 게임에 남습니다.

### budmori-io (`src/core/spatial-grid.js`의 `FixedSpatialGrid`)

생성: `new UniformGrid({ cellSize: 1.5, width: 128, height: 128, originX: -64, originY: -64, outside: 'overflow', track: 'identity' })`

| 원본                                                            | 모듈                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `clear()`                                                       | `clear()`                                                                     |
| `insert(item)`                                                  | `insert(item, item.x, item.y)`                                                |
| `update(item)`                                                  | `move(item, item.x, item.y)`                                                  |
| `remove(item)`                                                  | `remove(item)`                                                                |
| `itemCells.has(item)`                                           | `has(item)`                                                                   |
| `queryAABB(minX, minY, maxX, maxY, out)`                        | `queryRect(minX, minY, maxX, maxY, out)`                                      |
| `visitNearestFirst(x, y, minX, minY, maxX, maxY, visit)`        | 같음                                                                          |
| `queryCellRing(cx, cy, ring, out)`·`distanceToOutsideRing(...)` | 같음                                                                          |
| `cellX(x)`·`cellY(y)`                                           | 같음(`'overflow'`라 자르지 않음)                                              |
| `cellCount`(한 축의 칸 수)                                      | `cols`(`rows`). **모듈의 `cellTotal`은 총 칸 수라 이름이 같은 뜻이 아닙니다** |
| `usedCells`·`cells[KEY]`                                        | `usedCells`·`cellItems(KEY)`                                                  |
| `_stepFoodTargetSearch`의 고리 칸 계산 코드                     | `ringCell(centerX, centerY, ring, index)`·`ringCellCount(ring)`               |
| `checkpoint.js`의 `new FixedSpatialGrid().cellCount`            | 격자 옵션 상수에서 `cols`                                                     |

달라지는 점은 하나입니다. 원본은 세계 밖 항목의 사각형 판정에 질의 시점의 `item.x`·`item.y`를 읽고, 모듈은 `insert`/`move`가 마지막으로 받은 좌표를 씁니다. 항목이 움직인 뒤 `update`를 부르는 현재 호출 방식에서는 같고, 세계 밖 항목이 `move` 없이 좌표만 바뀌면 달라집니다.

## 실행 예제

실행 예제는 두지 않았습니다. 이 모듈은 시간·화면·입력이 없는 계산이라 보여 줄 동작이 없고, 칸 순서·후보·최근접 중단의 계약은 고정 시나리오 `modules/spatial/tests/spatial.e2e.mjs`가 값으로 확인합니다. 칸을 그리는 화면은 모바일·데스크톱 조작과 미리보기 시험을 새로 유지해야 하는데 확인할 계약이 늘지 않습니다.

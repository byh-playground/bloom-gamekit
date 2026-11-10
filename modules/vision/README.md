# vision

칸 격자 위에서 "관찰자들이 비추는 칸"을 세고 "이 자리의 대상이 보이는가"를 묻는 시야 판정입니다. 시간·난수·DOM을 읽지 않고, 선분 검사 없이 칸을 한 번씩 걸어 비춥니다. 진영·유닛 종류·정찰 효과 같은 게임 뜻은 모르고, 관찰자 목록을 게임이 만들어 넘깁니다.

- `VisionMap`: 지형을 칸마다 **높이 층(level)** 과 **막힌 칸(blocked)** 으로 담은 불변 래스터입니다. 같은 지형을 보는 모든 팀이 하나를 공유합니다.
- `VisionField`: 한 팀의 시야 격자입니다. `begin()` → 관찰자마다 `observe(id, x, y, radius, level, xray)` → `end()`로 관찰자 목록 전체를 받아 **칸·반경·높이 층이 바뀐 관찰자만** 다시 칠하고, `visibleAt`·`ceilingAt`이 칸 하나를 읽어 답합니다.

예외:

- 칸 단위 판정입니다. 대상이 칸 안 어디에 있든 그 칸의 답이 같고, 관찰자의 시야는 자기 칸에서 칸 중심 사이 거리로 잰 원입니다.
- 팀 합산은 하지 않습니다. 팀마다 `VisionField`를 하나씩 만들고, 여러 팀을 묶어 묻는 일(관전·공유 시야)은 게임이 `visibleAt`을 나눠 부릅니다.
- 건물 같은 움직이는 가림막, 비행·탐지 같은 층, "공격하면 잠깐 드러남" 같은 규칙은 없습니다. 게임이 관찰자 목록에 반영합니다(아래 "게임이 하는 일").

## 사용

    import { VisionField, VisionMap } from '../../../dist/vision.js';

    // 1. 지형은 한 번 만들어 모든 팀이 공유합니다. 연속 좌표 지형이면 칸 중심을 표집합니다.
    const MAP = VisionMap.sample({
        width: 3600,
        height: 4200,
        cellSize: 32,
        levelAt: (x, y) => terrain.levelAt(x, y), // 정수 -128..127, 클수록 높음
        blockedAt: (x, y) => terrain.blocksSight(x, y), // 생략하면 막힌 곳 없음
    });
    // 타일 게임처럼 래스터가 이미 있으면 그대로 받습니다(복사하지 않음).
    // new VisionMap({ width, height, cellSize, level: Int8Array, blocked: Uint8Array });

    // 2. 팀마다 한 장. 틱마다 그 팀의 관찰자 전체를 넘깁니다(객체·배열을 만들지 않음).
    const FIELDS = [new VisionField(MAP), new VisionField(MAP)];
    const FIELD = FIELDS[team].begin();
    for (const U of units) {
        if (isMine(U)) {
            FIELD.observe(U.number, U.x, U.y, U.sight, terrain.levelAt(U.x, U.y)); // id는 정수
        }
    }
    FIELD.end();

    // 3. 질의: 대상의 자리와 높이 층
    if (FIELDS[team].visibleAt(enemy.x, enemy.y, terrain.levelAt(enemy.x, enemy.y))) {
        // 공격할 수 있음
    }

| 호출                                                   | 뜻                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VisionMap.sample(options)`                            | `width`·`height`·`cellSize`·`levelAt(x, y)`·`blockedAt(x, y)`로 만듭니다. 칸 중심을 행 우선으로 한 번씩 표집하고, 월드 밖에 걸친 마지막 칸의 중심은 월드 가장자리 좌표로 자릅니다.              |
| `new VisionMap(options)`                               | `width`·`height`·`cellSize`·`level`(정수 typed array)·`blocked`(Uint8Array, 생략 가능)를 그대로 받습니다. 길이는 `cols * rows`(`ceil(크기 / cellSize)`)이고 칸 번호는 `row * cols + col`입니다. |
| `new VisionField(map)`                                 | 한 팀의 빈 시야 격자.                                                                                                                                                                           |
| `field.begin()`                                        | 관찰자 목록 갱신을 시작합니다. `this`를 돌려줍니다.                                                                                                                                             |
| `field.observe(id, x, y, radius, level, xray = false)` | 이번 목록에 관찰자 하나를 넣습니다(아래 표). 지난 목록에 같은 id가 같은 칸·반경·높이 층·xray로 있었으면 다시 칠하지 않습니다.                                                                   |
| `field.end()`                                          | 이번에 `observe`되지 않은 관찰자의 칸을 지우고, 바뀐 것이 있으면 `revision`을 올립니다.                                                                                                         |
| `field.visibleAt(x, y, level)`                         | 높이 층 `level`의 대상이 (x, y)에서 보이는가. `level`은 생략할 수 없습니다.                                                                                                                     |
| `field.ceilingAt(x, y)`                                | (x, y)를 비추는 관찰자 중 가장 높은 높이 상한. 없으면 `-Infinity`, xray가 비추면 `Infinity`. 층 L을 보는 마스크는 `ceilingAt(x, y) >= L`입니다.                                                 |
| `field.revision`                                       | 칸이 비춰지거나 지워진 갱신마다 1 늘어납니다. 안개 텍스처 같은 파생 결과를 다시 만들지 정하는 키입니다.                                                                                         |
| `map.cellAt(x, y)`                                     | 좌표의 칸 번호. 월드 밖은 가장자리 칸을 읽습니다.                                                                                                                                               |

`observe`의 인자는 다음과 같습니다.

| 필드     | 뜻                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | 갱신 사이에서 같은 관찰자를 알아보는 안전 정수. 한 갱신 안에서 겹치면 RangeError입니다. 종류가 다른 개체(유닛·건물·드러냄)는 `번호 · 8 + 종류`처럼 숫자 조합으로 겹치지 않게 만듭니다. |
| `x`, `y` | 유한한 좌표. 비추는 출발 칸은 `cellAt(x, y)`입니다.                                                                                                                                    |
| `radius` | 비추는 거리(좌표 단위). 0이면 아무것도 비추지 않고(자기 칸도), 상한은 `256 * cellSize`입니다.                                                                                          |
| `level`  | 관찰자 자신의 높이 층. 이것이 곧 시야 상한(ceiling)입니다. `xray`면 무시합니다.                                                                                                        |
| `xray`   | `true`면 막힌 칸과 높이를 모두 무시하고 반경 안의 모든 칸을 모든 높이에서 봅니다(상한 `Infinity`).                                                                                     |

## 시야 규칙

관찰자는 출발 칸에서 바깥으로 가까운 칸부터 한 칸씩 걸어 나갑니다. 각 칸은 자기보다 한 걸음 안쪽의 이웃 칸(부모) 하나만 보고 판정합니다.

1. 반경 안: 칸 중심 사이의 거리가 `radius` 이하인 칸만 후보입니다. 격자 밖은 건너뜁니다.
2. 길이 끊김: 부모 칸이 보이지 않으면 그 칸도 보이지 않습니다.
3. 보임: **막힌 칸이 아니고**, 출발 칸이 아니라면 **관찰자의 `level`보다 높지 않은** 칸. `xray`는 모든 칸이 보입니다.
4. 대상: 칸이 보이면 그 칸의 대상은 비추는 관찰자 중 한 명이라도 상한(`level`, `xray`는 `Infinity`)이 대상의 높이 층 이상일 때 보입니다.

그래서 땅의 관찰자는 언덕 칸도 그 너머도 못 보고, 언덕 위의 관찰자는 땅을 내려다봅니다. 막힌 칸은 그 자체도 너머도 안 보입니다. 막힌 칸 위에 선 관찰자는 아무것도 비추지 못합니다(`xray` 제외).

```text
땅(.) 위 언덕(1)    땅의 관찰자 radius 11칸          언덕 위 관찰자 radius 6칸
.............        ooooooooooooo                   .ooooooooooo.
.............        ooooooooooooo                   .ooooooooooo.
.....111.....        ooooo^^^.....   ^ 언덕은 안 보임  .ooooooooooo.
.....111.....        ooooo^^^.....   뒤는 가려짐       ooooooooooooo
.....111.....        ooooo^^^.....                   .ooooooooooo.
.............        ooooooooooooo                   .ooooooooooo.
.............        ooooooooooooo                   .ooooooooooo.
```

칸 걷기는 선분 검사의 근사입니다. 부모 칸은 출발 칸에서 그 칸으로 가는 직선에 가장 가까운 안쪽 이웃이라, 가는 길이 칸 단위로 반올림됩니다. 막힌 줄 바로 뒤 칸이 가려지고 옆 줄 너머는 보일 수 있습니다(`tests/vision.e2e.mjs`의 벽 그림). 정확한 선분 판정이 필요하면 후보를 이 격자로 줄인 뒤 게임이 검사합니다.

## 갱신과 비용

- 비용은 "바뀐 관찰자 수 × 그 반경 안 칸 수"입니다. 멈춘 관찰자는 id 조회와 숫자 네 개 비교(칸·반경·높이 층·xray)만 합니다. 질의는 칸 하나와 높이 상한별 개수 몇 개를 읽습니다.
- 칸마다 "비추는 관찰자 수"를 높이 상한(ceiling)별로 세므로, 한 관찰자를 지울 때 겹친 다른 관찰자의 칸은 남습니다.
- 반경 표(반경 안 칸 오프셋과 부모 번호)는 모듈 안에서 모든 격자가 하나를 공유하고 필요할 때 커집니다. 반경 상한이 256칸인 이유입니다.
- 갱신은 관찰자 목록 전체를 한 번 훑으므로 멈춘 관찰자가 많아도 틱마다 부르는 비용은 관찰자 수에 비례합니다. `observe`가 값을 인자로 받으므로 관찰자 객체·배열을 만들 필요가 없고, 관찰자 기록과 칸 버퍼는 격자가 재사용합니다(사라진 관찰자의 기록은 다음 새 관찰자가 씀).
- `VisionMap`의 `level`·`blocked` 배열을 만든 뒤 바꾸면 이미 칠한 격자가 따라 바뀌지 않습니다. 지형이 바뀌면 새 `VisionMap`과 `VisionField`를 만듭니다.

## 결정론 계약

같은 지형과 같은 관찰자 목록 순서는 어느 엔진에서도 같은 칸을 비춥니다.

- 칸 번호는 `floor(좌표 / cellSize)`, 반경 비교는 `칸 중심 사이 제곱거리(정수) <= (radius / cellSize)^2`입니다. 사칙연산·`floor`·`ceil`·`round`뿐이고 `Math.hypot`·삼각함수·시간·난수는 쓰지 않습니다.
- 반경 표는 (제곱거리, 행, 열) 오름차순이고 부모는 `round`로 정해, 어떤 R로 만든 표든 같은 반경에는 같은 결과를 줍니다.
- 질의는 읽기만 하고 격자를 바꾸지 않습니다. `begin`·`observe`·`end`만 상태를 바꿉니다. 칸 수는 더하고 빼는 순서와 무관하므로 관찰자 기록의 저장 순서(지울 때 맞바꿈)는 결과에 영향이 없습니다.
- 입력이 잘못되면 조용히 넘기지 않고 던집니다: 안전 정수가 아닌 id, 한 갱신 안에서 겹친 id(RangeError), 유한하지 않은 좌표, 범위 밖 반경, `level`이 없는 관찰자(`xray` 제외), `begin` 없는 `observe`·`end`, 높이 층을 생략한 `visibleAt`. `observe`가 던지면 그 앞에 넣은 관찰자는 이미 반영돼 있고, 다음 `begin()`부터 다시 하면 됩니다(끝나지 못한 갱신의 변화도 `revision`에 남습니다).

## 게임이 하는 일

모듈은 "어디서 얼마나 멀리 어느 높이로 보는가"만 압니다. 아래는 게임이 정합니다.

| 게임 몫                                        | 모듈에 넘기는 모양                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| 누가 관찰자인가(유닛·건물·진영)                | 팀마다 관찰자를 그 팀 격자의 `observe`로 넘김                                         |
| 시야 거리(유닛 정의의 `sight`)                 | `radius`                                                                              |
| 관찰자와 대상의 높이 층                        | `level`(관찰자), `visibleAt`의 `level`(대상). 같은 지형 질의로 구하면 됩니다          |
| "공격하면 상대에게 잠깐 드러남" 같은 일시 공개 | 만료 시각을 게임이 보고 살아 있는 동안만 `xray: true` 관찰자(작은 반경)를 목록에 넣음 |
| 벽·절벽 같은 막힌 곳의 정의                    | `blockedAt` 또는 `blocked` 래스터                                                     |
| 여러 팀을 묶은 시야(관전, 동맹 공유)           | 팀 격자들의 `visibleAt`을 게임이 합침. 안개 마스크는 `ceilingAt`의 최댓값             |

## 이관 대응표 (rally-frontier)

| rally-frontier (`src/sim/entities.js`)                            | vision                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `VisionField.raster(terrain)` (지형 층·시야 막힘 표집)            | `VisionMap.sample({ levelAt, blockedAt })`                              |
| `VisionField.offsets`·`paint`·`apply`·`update`                    | `VisionField.begin`·`observe`·`end` 안으로                              |
| `VisionField.of(owner, side, state)` (진영별 장 캐시·소스 만들기) | 게임 몫: 진영마다 `new VisionField(map)`을 두고 `begin`/`observe`/`end` |
| `{ x, y, r, level, ignoresTerrainVision, sourceId }`              | `observe(정수 id, x, y, radius, level, xray)`                           |
| `field.visibleAt(x, y, targetLevel)`, `ceilingAt`, `revision`     | 같은 이름·같은 뜻                                                       |
| `OPEN_CEILING = 127` 표지                                         | `xray` 관찰자의 상한 `Infinity`                                         |
| 소스·건물 가림막(`syncBlockers`)                                  | 올리지 않음(Rally는 `blocksVision` 건물이 없어 쓰이지 않음)             |
| `visibleAt(x, y)`의 지형 높이 기본값                              | 없음. 대상의 높이 층을 항상 넘깁니다                                    |

원본과의 동등성은 `tests/vision.e2e.mjs`의 마지막 판이 확인합니다. 무작위 지형 위에서 관찰자 24명이 40틱 동안 움직이고 사라지고 생기며 칸마다 `ceilingAt`·`visibleAt`을 접은 해시가, 같은 판을 rally-frontier의 원본 `VisionField`로 돌린 해시와 같습니다.

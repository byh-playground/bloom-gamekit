# contact-solver

## 언제 쓰나

- 한 틱 안에서 **원형 유닛끼리, 그리고 벽·건물·맵 경계와의 충돌**을 닿는 순서대로 풀고 싶을 때. 지형은 항상 풀고, 몸끼리는 스텝 예산(`pairBudget`)만큼만 풀며 넘친 쌍은 `separate()`가 위치로 정리합니다.
- 걷는(조향) 몸과 날아가는(동적) 몸을 같은 큐에서 풀고, 닿았을 때 응답(반사·멈춤·교환·붙기)을 게임이 고르고 싶을 때. 결정론이라 롤백 시뮬 안에서 씁니다.

## 쓰는 모양

```js
// rally-frontier/src/sim/navigation.js (줄임)
this.contacts = new ContactSolver({
    surface: this.surface, // geometry SurfaceMotion: 이동·길찾기가 쓰는 같은 지형
    fixedPoint: FP,
    pairBudget: LaunchImpactRules.unitContactBudget,
    cellSize: LaunchImpactRules.contactCellSize,
});
this.contacts.setRelations(3, LaunchImpactRules.contactRelations);
this.contactEvent = new ContactEvent();

// 틱마다
const bodies = solver.begin(n, 1 / sim.tps);
for (let i = 0; i < n; i++) this.fillBody(bodies, i, units[i], startX[i], startY[i], vertical); // x·y·steerX·radius·mass…
while (solver.next(ev)) {
    if (!RollingBody.respond(this, ev)) solver.resolve(ev); // 게임 규칙 응답이 먼저
}
solver.end();
solver.separate();
for (let i = 0; i < n; i++) this.commitBody(bodies, i, units[i]);
```

## 쓰지 말아야 할 때

| 이런 일                                        | 대신                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 회전·관절·마찰이 있는 범용 강체 물리, z축 중력 | 범용 물리 엔진이 아닙니다. 픽셀 재료 + 강체는 [pixel-physics](../pixel-physics/README.md) |
| 원 하나를 벽에 미끄러지게 움직이기만           | [geometry](../geometry/README.md) `SurfaceMotion`                                         |
| 피해·넉백·재타격 같은 게임 규칙                | 게임의 응답 쪽(`next(ev)` 뒤)에 둡니다                                                    |
| 가까운 유닛 후보 찾기                          | [spatial](../spatial/README.md)                                                           |

## 상세

한 틱 안에서 **원형 몸이 지형과 서로에 닿는 순서대로** 접촉을 풀고, 남은 겹침을 위치로 정리하는 순수 ESM 모듈입니다(`dist/contact-solver.js`). 시간·난수·DOM을 읽지 않고 같은 입력이면 같은 부동소수 연산 순서로 같은 결과를 냅니다.

메인 규칙은 하나입니다. **틀렸을 때 티가 나는 접촉부터 풉니다.**

- 지형·건물·맵 경계 접촉은 예산과 무관하게 항상 풉니다. 벽을 통과하는 몸은 없습니다.
- 몸끼리의 접촉은 스텝 예산(`pairBudget`) 하나 안에서만 시간순으로 풉니다. 예산을 넘은 쌍은 겹친 채 지나가고 `separate()`가 위치로 정리합니다.

예외:

- 등급은 이 둘뿐입니다. 몸 종류별 예산 같은 세부 등급은 없습니다.
- 걷는(조향) 몸과 날아가는(동적) 몸은 같은 큐에 들어갑니다. 닿았을 때의 응답만 다릅니다(아래 "응답").
- 예산이 0이면 몸끼리는 cast부터 하지 않습니다(그래서 `stats.skippedPairs`도 0). 스텝 중에 예산이 바닥나면 그 뒤에 만난 쌍을 건너뛰고 셉니다.

이 모듈은 다음을 담지 않습니다. 병종·피해·넉백 종류·회복 시간·영웅 기술 같은 게임 규칙, z축(높이 적분·중력), 항력, 투사체 판정, 엔티티 레코드와 저장. 게임은 엔티티를 원본으로 두고 스텝마다 숫자 열을 채웠다가 결과를 되씁니다.

## 쓰는 법

```js
import { ObstacleField, SurfaceMotion } from './geometry.js';
import { ACTIVE, DYNAMIC, PAIRS, SEPARATE, SOFT, SOLID, ContactEvent, ContactSolver } from './contact-solver.js';

const SURFACE = new SurfaceMotion(new ObstacleField({ width, height, fixedPoint: 100, polygons, circles }));
const SOLVER = new ContactSolver({
    surface: SURFACE, // 게임이 이동·길찾기에 이미 쓰는 지형을 그대로 주입
    fixedPoint: 100,
    remainderScale: 10000,
    pairBudget: 64,
    maxZeroTimeRepeats: 32,
    cellSize: 64,
});
SOLVER.setRelations(2, Uint8Array.of(SOFT, SOLID, SOLID, SOFT)); // 같은 진영 SOFT, 다른 진영 SOLID
const EV = new ContactEvent(); // 한 번 만들어 재사용

// 틱마다
const B = SOLVER.begin(units.length, 1 / tps);
for (let i = 0; i < units.length; i++) {
    const U = units[i];
    B.x[i] = U.startFx; // 틱 시작 위치(정수 격자)
    B.y[i] = U.startFy;
    B.steerX[i] = U.fx; // 조향이 옮긴 자리. 안 움직였으면 시작과 같게
    B.steerY[i] = U.fy;
    B.ivx[i] = U.impact?.vxFP ?? 0; // 동적 몸의 충격 속도(FP/초 정수)와 정수 잔여 변위
    B.ivy[i] = U.impact?.vyFP ?? 0;
    B.rx[i] = U.impact?.remainderX ?? 0;
    B.ry[i] = U.impact?.remainderY ?? 0;
    B.radius[i] = U.radius;
    B.mass[i] = U.mass;
    B.key[i] = U.number; // 엔티티 번호(안전 정수)
    B.group[i] = U.side;
    B.softCap[i] = U.softCapFP;
    B.flags[i] = ACTIVE | PAIRS | SEPARATE | (U.impact ? DYNAMIC : 0);
}
while (SOLVER.next(EV)) {
    if (!myResponse(SOLVER, EV)) {
        SOLVER.resolve(EV); // 기본 응답
    }
}
SOLVER.end(); // 남은 몸을 dt까지 옮기고 지형 밖으로 복구
SOLVER.separate(); // 겹침 풀기
// B.x/B.y, 동적 몸의 B.ivx/ivy/rx/ry, 새로 켜진 DYNAMIC을 엔티티에 되씀
```

`next`는 당기기 루프입니다. 콜백이 없고, 게임이 그 자리에서 표준 응답을 고르거나 `resolve`를 부릅니다. 응답 없이 다음 `next`를 부르면 앞 접촉에 기본 응답이 적용됩니다. `end`도 남은 접촉을 기본 응답으로 마저 풉니다.

## 몸 열

`begin(count, dt)`가 돌려주는 `ContactBodies`의 타입 배열 `[0, count)`를 게임이 모두 채웁니다(앞 스텝 값이 남아 있으므로 빠짐없이).

| 열                 | 형식           | 뜻                                                                                                                     |
| ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `x`, `y`           | `Int32Array`   | 입력: 틱 시작 위치(1/fixedPoint 정수). 스텝 중: 몸의 시간 기준점 위치. `end()` 뒤: 결과                                |
| `steerX`, `steerY` | `Int32Array`   | 입력: 이번 틱 조향이 옮긴 자리. 조향 속도 = (steer − x) / fixedPoint / dt. 막히지 않은 조향 몸은 `end()` 뒤 이 자리    |
| `vx`, `vy`         | `Float64Array` | 모듈이 계산하는 궤적 속도(월드/초) = 조향 속도 + 충격 속도 / fixedPoint. 응답 중 읽기·고치기 가능(고치면 `touched`)    |
| `ivx`, `ivy`       | `Float64Array` | `DYNAMIC` 몸의 충격 속도(fixedPoint/초 정수). 입력이자 결과. 아니면 모듈이 0으로 둠                                    |
| `rx`, `ry`         | `Int32Array`   | `DYNAMIC` 몸의 잔여 변위(1/remainderScale 격자 칸 정수). 입력이자 결과                                                 |
| `radius`, `mass`   | `Float64Array` | 반지름(월드), 질량(양수)                                                                                               |
| `key`              | `Float64Array` | 엔티티 번호(0 이상 안전 정수). 대체 법선·미끄러짐 순위·침투 동률. 한 스텝 안에서 겹치지 않게                           |
| `group`            | `Uint8Array`   | 관계 표의 행·열                                                                                                        |
| `z`                | `Float64Array` | `VERTICAL` 몸의 바닥 높이(월드)                                                                                        |
| `softCap`          | `Int32Array`   | SOFT 겹침 풀기에서 한 pass에 움직일 수 있는 최대 거리(정수 격자, 1 미만은 1)                                           |
| `flags`            | `Uint8Array`   | `ACTIVE` 1 · `DYNAMIC` 2 · `PAIRS` 4 · `VERTICAL` 8 · `SEPARATE` 16. `end()` 뒤 새로 켜진 `DYNAMIC` = 맞아서 동적이 됨 |

- `ACTIVE`: 이번 스텝에 움직이고 지형과 닿습니다. 죽었지만 날아가던 궤적을 마치는 몸도 켭니다. 스텝 안에서 바꾸지 않습니다.
- `PAIRS`: 몸-몸 접촉에 참여합니다. 응답 중에 바꾸면 그 몸의 다음 cast부터 적용됩니다(그 몸이 지금 묶음에 없으면 `touched(i)`).
- `VERTICAL`: 쌍의 한쪽이라도 켜 있으면 높이를 봅니다. 한쪽 바닥이 다른 쪽 바닥 + 그쪽 지름 이상이면 서로 지나갑니다(몸은 높이로도 지름만큼인 구).
- `SEPARATE`: `separate()`에 참여합니다(접촉 큐와 별개).

관계 표 `setRelations(groups, table)`은 `groups × groups` 대칭 표이고 값은 `PASS`(서로 지나감), `SOFT`(큐에 넣지 않고 겹침 풀기에서 질량비 일부 분리: 아군), `SOLID`(큐에 넣고 겹침 풀기에서 침투한 쪽 완전 분리: 적)입니다.

## 응답

| 접촉                | 기본 응답(`resolve`)                                                                                                        | 직접 고르는 표준 응답                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 동적 몸 ↔ 표면      | `reflect(ev, restitution)`: 충격 속도를 지금 속도로 맞추고 안쪽 성분을 (1 + e)배로 되돌림, 안쪽 잔여 변위 제거              | `reflect(ev, e)`(몸마다 다른 반발)                                                           |
| 조향 몸 ↔ 표면      | 미끄러짐: 접촉면에 사영해 지금 방향 쪽 접선으로 길이 유지, 격자 반올림 뒤 안쪽 성분 제거                                    |                                                                                              |
| 동적 몸이 낀 쌍     | `exchange(ev, restitution, 1, 1)`: 반발 e 운동량 교환. 조향 몸은 지금 속도를 충격 속도로 잡고 잔여 변위를 넘겨 동적 몸이 됨 | `exchange(ev, e, gainI, gainJ)`: 맞은 쪽 충격량 배율, 주고받은 J를 돌려줌(멀어지는 쌍이면 0) |
| 조향 몸끼리(적)     | 두 몸이 각자 상대를 따라 미끄러짐(승격 없음)                                                                                |                                                                                              |
| 0초 반복 한도(표면) | 멈춤: 충격 속도·궤적 속도 0                                                                                                 |                                                                                              |
| 0초 반복 한도(쌍)   | 붙기: 질량 가중 공통 속도. 동적 몸이 끼면 조향 몸도 동적이 됨(잔여 변위는 넘기지 않음)                                      | `bounce(ev, moveI, moveJ, eI, eJ)`: 표시한 동적 몸만 접근 속도를 반사, 붙지 않음             |

- `ev.repeats`는 시간이 흐르지 않고 연속으로 같은 접촉을 만난 횟수(이 접촉 포함)이고, 시간이 흐른 뒤 첫 접촉은 0입니다. `ev.stuck`은 `repeats >= maxZeroTimeRepeats`입니다. "한도에 처음 닿았을 때 한 번만 튕기고 그 뒤로는 붙기"는 `ev.repeats === solver.maxZeroTimeRepeats`로 고릅니다.
- `closing(ev)`는 접근 속도(양수면 다가옴)입니다. 응답 전에 읽습니다(벽 충돌 피해처럼 진입 속도가 필요한 게임 규칙용).
- `ev.response`(`RESPONSE_*`)와 `ev.impulse`로 게임이 응답 뒤 기록(넉백 출처·회복 시각 등)을 남깁니다.
- 동적 몸의 충격 속도는 응답마다 1/fixedPoint 격자 정수로 반올림합니다(Δv = round(J / m · fixedPoint)).

## 겹침 풀기

`separate()`는 `end()` 뒤에 부릅니다. 두 단계이고, 각 단계가 끝나면 옮긴 몸을 단계 시작 자리에서 지형을 따라 다시 풀어(`SurfaceMotion.solve`의 `'project'`) 벽 안으로 들어가지 않게 합니다.

1. **SOFT(아군)**: 최대 `softPasses`번, 움직임이 없으면 멈춤. pass마다 pass 시작 위치로 모든 겹친 쌍의 보정(침투 × `softFraction`, 질량비로 나눔)을 정수로 모아 몸별 평균을 `softCap`으로 자른 뒤 함께 옮깁니다(Jacobi). 보정이 정수 합이라 쌍을 보는 순서와 무관합니다.
2. **SOLID(적)**: 최대 `hardPasses`번. pass 시작 위치로 축 상자(|dx|, |dy| ≤ 반경 합)가 겹치는 쌍을 모아 정수 키 `침투한 쪽 · (n + 1) + 상대` 오름차순으로, 침투한 쪽만 `반경 합 − 거리 + 1`만큼 밀어냅니다(상대 위치는 pass 시작 자리). 침투한 쪽은 틱 시작 자리에서 상대 쪽으로 더 다가간 몸, 같으면 더 많이 움직인 몸, 같으면 `key`가 작은 몸입니다.

후보는 균일 격자로 찾습니다([A001](https://github.com/byh-playground/bloom-reference/blob/main/algorithms/index.html)). 격자는 위치 열과 같은 정수 격자 단위이고(넣기·질의 좌표가 정수), 질의 결과는 spatial `queryRectInto`로 몸 용량만큼 잡아 둔 `Int32Array`에 개수와 함께 받습니다([A075](https://github.com/byh-playground/bloom-reference/blob/main/algorithms/index.html)). 겹침 풀기의 격자는 위치가 바뀐 pass 뒤에만 다시 채웁니다. 원본 쌀콩팡은 분산이 큰 축을 고르는 SAP([A005](https://github.com/byh-playground/bloom-reference/blob/main/algorithms/index.html))였지만 쌍 목록을 정렬해 쓰므로 결과는 축과 무관하고(경계 한 경우 제외, 아래), 축 기억(틱 사이 상태)이 필요 없는 격자로 바꿨습니다. 넓은 2D 군집에 고정 축 SAP를 쓰지 않는다는 A004 경고와도 맞습니다.

## 결정론 계약

- 처리 순서: 몸마다 이번 틱 궤적의 가장 이른 접촉(1e-9초 안은 같은 시각)을 둡니다. 모든 몸 중 가장 이른 시각의 묶음을 **표면 먼저(몸 번호, 접촉 키 오름차순) → 쌍(작은 번호, 큰 번호 오름차순) → i 오름차순**으로 정렬하고(같으면 모은 순서: 몸 번호 순, 몸 안은 나중에 기록한 것 먼저, 안정 정렬), 두 몸이 모두 기록한 쌍은 앞의 하나만 풉니다. 묶음에 응답한 몸과 그 몸에 접촉을 걸어 둔 몸만 그 시각에서 다시 cast합니다.
- 쌍의 후보는 격자로 찾은 뒤 **몸 번호 순**으로 봅니다. 그래서 결과가 `cellSize`와 무관합니다(고정 시나리오가 칸 8·64·1000으로 확인).
- 쌍은 (동적 몸, 상대)로 cast하고 둘 다 동적이거나 둘 다 조향이면 작은 번호가 `i`입니다. 법선은 j → i입니다.
- 0초 반복 횟수의 키: 쌍은 (작은 번호, −(큰 번호 + 1)), 표면은 (몸, 접촉 키)입니다. 접촉 키는 geometry `contactKey`(< 2^52)이고 몸 번호 < 2^24이므로 두 값 모두 Float64·Int32에 정확합니다. 시간이 1e-9초보다 흐르면 모두 지웁니다.
- 겹침 풀기 쌍 키 `침투한 쪽 · (n + 1) + 상대` < (n + 1)^2이고 n < 2^24라 2^48 < 2^53입니다.
- 대체 법선(두 몸이 같은 자리): 두 `key`의 32비트 낱말 FNV-1a(`pairHash(작은 key, 큰 key)`) 하위 3비트로 정수 8방향(4096 / 2896 배율) 중 하나를 고르고 작은 key → 큰 key를 향합니다. 정수 연산만 씁니다.
- 위치는 정수 격자, 스텝 안 속도·시각은 Float64, 잔여 변위는 정수(동적 몸)와 소수(조향 몸)입니다. 이동은 `trunc(v · fixedPoint · 경과 + 잔여)`이고 나머지가 잔여로 남습니다.
- 조향 몸의 소수 잔여는 다음 틱으로 넘기지 않으므로 `end()`가 dt까지 옮긴 뒤 축마다 `round(잔여)`를 더해 정산합니다(동적 몸의 정수 잔여·반올림은 그대로). 그래서 그 스텝에 속도가 바뀌지 않은(막히지 않은) 조향 몸은 부동소수 오차(예: 32.9999… → 32)와 무관하게 `steerX`·`steerY`에 정확히 서고, 접촉해 미끄러진 몸도 틱마다 내림 손실(축마다 최대 1)이 쌓이지 않습니다(오차는 틱마다 ±0.5 이하).
- `Math.hypot`·`Math.sqrt`를 쓰고 geometry를 그대로 쓰므로 같은 엔진·버전끼리 비트 동일입니다(geometry와 같은 조건).
- 상태: 스텝 사이에 결과를 바꾸는 상태가 없습니다. `begin`이 모든 큐·버퍼·반복 횟수를 비우고, 몸의 물리 상태(위치, 충격 속도, 잔여 변위)는 모두 게임이 채우는 열에서 옵니다. 그래서 snapshot·체크섬에 모듈 값을 넣지 않습니다. 주입한 `SurfaceMotion`의 체크포인트(`remember`/`constrain`)는 읽지도 쓰지도 않습니다.
- 처리 순서·허용치(1e-9 같은 시각, −1e-7 안쪽 판정, cast 길이 1e-9)·반올림 식을 바꾸면 결과가 달라집니다(비호환 변경).

## 비용과 제한

- 틱 경로(`begin`·`next`·응답·`end`·`separate`)는 객체·배열·문자열·클로저를 만들지 않습니다. 타입 배열 버퍼와 접촉 기록 풀은 모자랄 때만 두 배로 늘립니다. 후보 목록도 JS 배열이 아니라 타입 배열 + 개수입니다(JS 배열을 `length = 0`으로 비웠다 다시 채우면 V8이 저장 공간을 놓아 질의마다 다시 할당합니다).
- 남는 할당은 V8이 인라인하지 않은 함수에 부동소수 인자를 넘길 때 만드는 상자(HeapNumber)입니다. 주입한 geometry(`SurfaceMotion.cast`·`solve`)를 부르는 곳이 대부분이고 JIT 결정에 따라 달라집니다. 측정값은 [릴리스 노트](../../project/docs/releases.md)의 v0.55.0 항목에 있습니다.
- 묶음마다 몸 수만큼 훑습니다(가장 이른 시각 찾기·모으기·다시 cast 표시). 묶음 수 × 몸 수가 비용의 바닥이고, 묶음 수는 접촉 수에 비례합니다. 예산은 몸-몸 응답 수를 묶지만 지형 cast와 쌍 cast 비용은 남습니다.
- 몸 번호는 `count` 안의 위치이고 2^24 미만입니다(격자 상한). 관계 그룹은 256개까지입니다.
- 지형 접촉은 몸이 직선으로 움직인다고 보고 cast합니다. 조향 몸이 이번 틱에 벽을 따라 꺾여 온 경로도 시작 → 조향 끝 직선으로 다시 보므로, 그 직선이 모서리를 스치면 미끄러짐이 한 번 더 생깁니다.

## 라이브러리 대신 이 모듈을 쓰는 이유

비교: Box2D v3, planck.js, Rapier(`@dimforge/rapier2d`, 결정론 빌드 포함), matter.js(GameKit `pixel-physics`가 사용).

| 이유                  | 이 모듈                                                                                                           | 라이브러리                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 지형 원본 하나        | 길찾기·건설·이동이 쓰는 geometry `ObstacleField`(다각형·원·무시 규칙)를 `SurfaceMotion`으로 그대로 주입           | 같은 지형을 엔진 collider로 한 벌 더 만들고 건물이 바뀔 때마다 동기화                                                                             |
| 저장 상태 중복 없음   | 스텝 사이 상태 0. 물리 상태는 게임 엔티티의 정수 몇 필드뿐이고 게임의 snapshot이 그대로 저장                      | 엔진이 위치·속도·접촉 캐시를 소유하므로 rollback 복원 때 엔진 월드도 복원해야 함(공식 snapshot은 Rapier `takeSnapshot` 정도이고 월드 전체 바이트) |
| 예산·겹침 허용 의미론 | 시간순 큐에서 몸-몸 접촉을 예산만큼만 풀고 나머지는 겹친 채 지나간 뒤 관계별(SOFT/SOLID)로 위치 정리. 지형은 항상 | 모든 접촉을 매 스텝 반복 해소하고 강체는 겹침을 허용하지 않음. 접촉 필터 훅으로 개수를 세어 끊을 수는 있지만 시간순이 아니라 broadphase 순서      |

결정론은 이유로 들지 않습니다(Rapier 결정론 빌드·Box2D v3가 플랫폼 간 결정론을 내세우고, 이 모듈은 같은 엔진 조건입니다).

## 출처와 Rally 대응

[rally-frontier](https://github.com/byh-playground/rally-frontier) `52984f3`(v0.99.0)의 `src/sim/navigation.js` `ImpulseContacts`·`UnitMotion.solveImpulseStep`/`castImpulseBody`/`advanceImpulseBody`/`solveImpulseContact`/`removeInwardVelocity`(동적 몸 시간순 큐)와 `src/sim/strategy-sim.js` `resolveAlliedSoftSeparation`·`enforceNonAlliedNoOverlap`·`nonAlliedPenetrationOwner`·`fallbackNormal`(겹침 풀기)에서 게임 규칙을 걷어내 연산 순서 그대로 옮겼습니다.

| Rally                                                                                      | contact-solver                                      |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `UnitMotion.solveImpulseStep(startX, startY)`                                              | `begin` + 열 채우기 + `next`/`resolve` 루프 + `end` |
| `u.impactMotion` 유무 / `vxFP·vyFP·remainderX·remainderY`                                  | `DYNAMIC` / `ivx·ivy·rx·ry`                         |
| `u.alive \|\| u.impactMotion` / `u.alive && !heroRoll && !blocksMovement`                  | `ACTIVE` / `PAIRS`                                  |
| `isAlliedCollisionUnit`·`nearbyUnits(…, 1 - side)`                                         | 관계 표(같은 진영 SOFT, 다른 진영 SOLID)            |
| `UnitLeapAttack.separated`                                                                 | `VERTICAL` + `z`                                    |
| `solveImpulseContact` / `RollingBody.collide`의 승격·교환                                  | `exchange(ev, e, gainI, gainJ)`                     |
| 표면 분기의 `applyImpulse` + `removeInwardVelocity(m, n, e)`                               | `reflect(ev, e)`                                    |
| `RollingBody.bounceStuck`                                                                  | `bounce(ev, moveI, moveJ, eI, eJ)`                  |
| `unitContactBudget`·`rollingContactBudget`·`skippedUnitContacts`                           | `pairBudget`·`stats.skippedPairs`(예산 하나)        |
| `resolveAlliedSoftSeparation` × `ALLY_SOFT_ITERATIONS` / `enforceNonAlliedNoOverlap(…, 4)` | `separate()`(`softPasses`·`hardPasses`)             |

원본과 다른 점(의도한 것):

- **예산이 하나**입니다. 원본은 구르는 몸이 낀 쌍에 별도 예산(`rollingContactBudget`)이 있었습니다. 쌍 접촉이 예산 안이면 결과가 같고, 넘치면 달라집니다.
- **조향 몸끼리의 적 접촉도 같은 큐**에 들어갑니다. 원본은 동적 몸이 낀 쌍만 큐에 넣고 조향 쌍은 `resolveNonAlliedSurfaceMotion`(pass마다 몸별 가장 이른 상대, 최대 4 pass, 목표는 `collisionIntent`)이 따로 풀었습니다. 모듈의 조향 쌍 응답은 각자 미끄러짐이고 목표는 지금 방향입니다. 동적 몸이 하나도 없는 틱에 원본은 큐를 돌리지 않았지만 모듈은 조향 몸도 cast합니다.
- 쌍 후보를 몸 번호 순으로 봅니다(원본은 게임 격자의 칸·버킷 순서). 1e-9초 동률 창 안의 두 접촉이 기록 순서에 따라 달라질 수 있는 경우에만 결과가 다를 수 있고, 임시 비교의 모든 장면에서 같았습니다.
- 침투한 쪽의 마지막 동률은 `String(id)` 비교 대신 `key` 숫자 비교입니다.
- SOLID 겹침 풀기 후보가 축 상자 `|dx|, |dy| ≤ 반경 합`(닫힘)입니다. 원본은 고른 축은 닫힘·다른 축은 열림이라, pass 시작에 한 축 거리가 정확히 반경 합인 쌍이 같은 pass 안에서 겹치게 된 경우에만 다릅니다.
- `VERTICAL`의 높이는 스텝 시작의 값 하나입니다. 원본 `separated`는 그 순간 위치의 지형 높이를 다시 읽었습니다.

## 검증

고정 시나리오 [`tests/contact-solver.e2e.mjs`](./tests/contact-solver.e2e.mjs)(`npm test`의 core 목록): 손으로 계산한 질량비 교환(e 0·1, 맞은 쪽 배율), 같은 시각 접촉의 처리 순서와 격자 칸 크기 무관, 예산을 넘은 쌍이 겹친 채 지나가고 `separate()`로 풀림, 벽 틈 난전 30틱을 예산 0·16·무제한으로 돌려 지형 관통 0과 같은 입력 두 번의 해시 일치, 막히지 않은 걷는 몸이 조향 끝점에 서는 것을 확인합니다. 원본과의 비트 비교(임시, 저장소에 남기지 않음)의 규모와 결과는 [릴리스 노트](../../project/docs/releases.md)의 해당 버전 항목에 있습니다.

## 실행 예제

[work-scheduler 예제의 "접촉" 탭](../work-scheduler/examples/index.html#tab=contacts)([바로 보기](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/work-scheduler.html#tab=contacts)): 벽이 있는 공간에서 두 무리가 부딪치고 무거운 구르는 몸이 지나갑니다. 예산(0·16·64·무제한)을 바꾸며 예산에 걸려 겹친 쌍, 벽 관통 수(항상 0), 틱 시간을 봅니다.

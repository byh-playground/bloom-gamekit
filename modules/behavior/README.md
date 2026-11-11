# behavior

## 언제 쓰나

- AI 행위자가 비어 있을 때 **지금 무엇을 시작할지** 우선순위대로 하나 고르고 싶을 때(`BehaviorTree`의 `selector`·`guard`·`action`).
- 시작한 동작의 단계(예열 → 발동 → 회복 등)를 정해진 전이로만 진행하고 싶을 때(`StateMachine`). 둘 다 시간·난수·DOM을 읽지 않아 결정론 tick 안에서 씁니다.

## 쓰는 모양

```js
// budmori-io/src/model/unit-turn.js (줄임)
const { BehaviorTree, action, guard, selector } = globalThis.BloomGamekitBehavior;
export const UNIT_INTENT = new BehaviorTree(
    selector('unit intent', [
        guard(
            'marching',
            ({ world }) => world.farmBossEvent.phase === 'marching',
            action('march', ({ world, unit }) => {
                world._marchUnit(unit);
                return true;
            }),
        ),
        guard('merge material', ({ world, unit }) => world.isMergeTaskMaterial(unit), action('wait for merge', HOLD)),
    ]),
);

// budmori-io/src/model/farm-model.js: 틱마다 재사용 context로 결정
UNIT_INTENT.decide(this._unitIntentTurn.begin(this, unit, dt, enemy, scene));
```

상태 기계 예: `budmori-io/src/boss/boss-turn.js`.

## 쓰지 말아야 할 때

| 이런 일                                              | 대신                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| 여러 tick에 걸친 진행 중(RUNNING) 상태를 트리에 두기 | 트리에는 RUNNING이 없습니다. 단계는 `StateMachine`이나 게임 동작 객체가 갖습니다 |
| 무거운 탐색을 여러 tick에 나눠 처리                  | [work-scheduler](../work-scheduler/README.md)                                    |
| 길찾기                                               | [pathfield](../pathfield/README.md)                                              |

## 상세

행위자의 행동을 **행동트리는 결정, 상태 기계는 실행**으로 나눠 짜는 순수 ESM 모듈입니다. 시간·난수·DOM을 읽지 않으며 호출 게임의 고정 논리 tick 안에서 동기로 돕니다.

- 행동트리(`BehaviorTree`)는 행위자가 비어 있을 때 "지금 무엇을 시작할지"를 우선순위 순서로 하나 고릅니다.
- 상태 기계(`StateMachine`)는 시작한 일의 단계(예열 → 발동 → 회복, 쓰러짐 → 일어남 등)를 정해진 전이로만 진행합니다.

예외:

- 행동트리에는 진행 중(RUNNING) 상태가 없습니다. 여러 tick에 걸치는 일은 행동이 시작만 하고, 그 단계는 상태 기계나 게임의 동작 객체가 들고 갑니다. 그래서 트리 하나를 모든 행위자가 공유하고 트리에 저장할 상태가 없습니다.
- 상태 기계의 현재 상태는 행위자 레코드의 문자열 필드 하나(`field`)입니다. 게임의 기존 저장·스냅샷이 그 필드를 그대로 담습니다.
- 난수가 필요한 행동은 게임의 시드 난수를 context로 받아 씁니다.

## 행동트리

    import { BehaviorTree, action, guard, selector } from '../../../dist/behavior.js';

    const BOSS_TURN = new BehaviorTree(
        selector('boss', [
            guard('stunned', (c) => c.boss.stun > 0, action('wait', () => true)),
            action('summon', (c) => c.castFirstReady(c.summons)),
            guard('slam in reach', (c) => c.slamInReach, selector('close', [
                action('rhythm special', (c) => c.castRhythmSpecial()),
                action('slam', (c) => c.cast('slam')),
            ])),
            action('gap closer', (c) => c.castRandomReady(c.gapClosers)),
            action('walk', (c) => c.walkToNearest()),
        ]),
    );

    // 행위자가 비었을 때, 기존 고정 tick마다:
    CONTEXT.reset(boss, dt);
    const DECIDED = BOSS_TURN.decide(CONTEXT); // 'slam' 같은 행동 이름, 없으면 null

| 노드                       | 뜻                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `action(name, run)`        | 잎. `run(context)`가 true면 이 행동이 차례를 가져가고, false면 다음 형제로 넘어갑니다. |
| `guard(name, test, child)` | `test(context)`가 참일 때만 `child`를 봅니다. `test`는 읽기만 합니다(CQS).             |
| `selector(name, children)` | 자식을 순서대로 보고 처음 차례를 가져간 자식에서 멈춥니다.                             |

`decide`는 차례를 가져간 행동의 이름을 돌려줍니다. 디버그 표시·장면 캡처 단계 이름으로 쓸 수 있습니다. `describe()`는 이름만 담은 트리 모양을 읽을 때만 만듭니다. 노드는 만들 때 검사하고 얼리며, `decide`는 할당하지 않습니다. context 객체는 호출자가 하나 만들어 재사용합니다.

## 상태 기계

    import { StateMachine } from '../../../dist/behavior.js';

    const PHASES = new StateMachine({
        field: 'phase',
        initial: 'windup',
        states: {
            windup: { to: ['active'], update: (a, c) => (a.elapsed >= c.windup ? 'active' : null) },
            active: { to: ['recover'], enter: (a, c) => c.launch(a) },
            recover: { to: [], enter: (a) => (a.elapsed = 0) },
        },
    });

    PHASES.update(attack, CONTEXT); // 현재 상태의 update, 상태 이름을 돌려주면 전이
    PHASES.transition(attack, 'recover'); // 발동이 끝났을 때처럼 밖에서 옮길 때

- `to`에 없는 전이와 정의되지 않은 상태는 `RangeError`로 막습니다. 갈 데가 없는 끝 상태는 `to: []`입니다.
- 전이 순서는 `exit` → 필드 변경 → `enter`입니다. `enter` 안에서 다시 전이할 수 있습니다(즉발 공격의 발동 → 회복).
- `update`가 전이하면 같은 호출에서 새 상태의 `update`는 실행하지 않습니다.
- `start(host)`는 필드를 `initial`로 두고 그 `enter`를 실행합니다. 레코드를 직접 만들 때는 `field`에 `machine.initial`을 넣어도 됩니다.

## 라이브러리 대신 쓰는 이유

| 비교      | XState              | mistreevous                      | behavior                                        |
| --------- | ------------------- | -------------------------------- | ----------------------------------------------- |
| 실행 방식 | 이벤트·액터(비동기) | tick, RUNNING 노드를 트리가 보관 | 게임 고정 tick 안의 동기 호출                   |
| 상태 위치 | 액터 내부           | 트리 인스턴스 내부               | 행위자 레코드의 필드(저장·되감기에 그대로 포함) |
| 시간·난수 | 타이머              | `Date` 기본값, `random` 옵션     | 읽지 않음, context로 받음                       |
| 크기      | 큰 런타임           | 파서(MDSL) 포함                  | 노드 3종 + 상태 기계 하나                       |

## 실행 예제

[work-scheduler 예제의 "행동" 탭](../work-scheduler/examples/index.html#tab=behavior)에서 버튼 한 번이 논리 tick 한 번입니다. 보스가 거리·쿨다운에 따라 내려찍기·돌진·걷기 중 하나를 고르고, 고른 공격의 예열 → 발동 → 회복 단계가 상태 기계로 진행되는 것을 보여줍니다.

# input

키보드·마우스·터치·펜 이벤트를 게임 액션으로 정리하는 독립 JavaScript ESM 모듈입니다. `ActionState`는 DOM 없이 Node에서도 사용하며 `createDOMInput`만 DOM을 사용합니다. 다른 gamekit 모듈 초기화는 필요 없습니다.

게임의 명령 큐·sequence·simulation tick·월드 좌표·권위 상태·pause 정책을 소유하지 않습니다. 장치 이벤트에서 바로 시뮬레이션을 실행하지 마세요. 게임 또는 rollback SDK가 정한 입력 제출 경계로 넘깁니다.

## 시작하기

```js
import { ActionState, createDOMInput } from './input.js';

const actions = new ActionState();
const pendingPoints = [];
const input = createDOMInput({
  target: canvas,
  state: actions,
  keys: { KeyW: 'up', ArrowUp: 'up', Space: 'roll' },
  pointerButtons: { 0: 'aim' },
  touchAction: 'none',
  gestures: {
    tap: 'move', doubleTap: 'roll',
    tapMs: 400, doubleTapMs: 300, dragSlop: 12, doubleTapSlop: 32,
  },
  onGesture(event) {
    // 이벤트 수집만 합니다. 좌표가 필요한 이산 입력은 액션 bool과 별도로 보관합니다.
    pendingPoints.push(event);
  },
});

const up = {}, roll = {};
function collectAtSimulationTick() {
  actions.sampleInto('up', up);
  actions.sampleInto('roll', roll);
  for (const event of pendingPoints) {
    const world = game.screenToWorld(event.x, event.y); // 게임 소유의 투영
    game.queuePointCommand(world, event.type === 'doubleTap');
  }
  pendingPoints.length = 0;
  game.queueDirectionalInput(up.held);
  // roll.pressed를 일반 구르기에 사용할 때는 위 point command와 중복 실행하지 않도록
  // 게임이 키보드/포인터 명령의 우선순위와 경로를 정합니다.
  actions.consume(); // 이 tick의 수집/제출이 끝난 뒤에만 edge를 지웁니다.
}

function render() {
  // sample/sampleInto는 consume하지 않습니다. 렌더 FPS와 논리 TPS는 독립입니다.
  actions.sampleInto('roll', roll);
}

// 화면/게임 종료 시 listener·capture·이 어댑터가 가진 hold를 모두 정리합니다.
input.dispose();
```

`./input.js`는 빌드 결과의 배포 파일을 게임과 함께 호스팅한 경로입니다. 소스 직접 사용 시 `packages/input/src/index.js`를 import합니다.

## ActionState 계약

- `new ActionState()`는 빈 상태를 만듭니다. 액션은 비어 있지 않은 문자열이고 처음 `set` 또는 `pulse`할 때 등록됩니다. 액션 이름에 계속 바뀌는 ID를 넣지 말고 게임의 유한한 액션 집합을 사용합니다.
- `set(action, source, down)`: `source`는 비어 있지 않은 문자열 또는 Symbol, `down`은 boolean입니다. 같은 source의 반복 down/up은 무시합니다. source 하나가 여러 액션을 누를 수도 있습니다.
- 여러 source는 OR로 합칩니다. W와 ArrowUp이 모두 `up`을 누른 상태에서 W만 해제해도 `held`는 유지됩니다. source 수가 0→1일 때 `pressed`, 1→0일 때 `released`가 생깁니다.
- `pulse(action)`은 tap 같은 이산 행동의 `pressed`와 `released`를 함께 표시하며 기존 `held`는 바꾸지 않습니다. 키보드 hold 중의 같은 액션 tap도 edge로 전달됩니다.
- `sampleInto(action, out)`은 재사용 객체에 `{held, pressed, released}`를 쓰고 out을 반환합니다. `sample(action)`은 같은 값의 새 객체를 반환합니다. 등록되지 않은 액션은 모두 false입니다.
- 샘플링은 edge를 소비하지 않습니다. `consume()`만 모든 액션의 `pressed/released`를 지우며 `held`는 유지합니다. 렌더마다 호출하지 말고 게임의 입력 제출/논리 tick 경계에서 호출합니다.
- tick 사이의 빠른 down→up은 `{held:false, pressed:true, released:true}`로 남습니다. up→down이나 pulse가 겹치면 세 값이 모두 true일 수 있습니다. 60 FPS 샘플링이 10 TPS에서 이 edge를 지우지 않습니다.
- edge는 횟수·순서를 기록하는 큐가 아닙니다. 한 consume 구간의 여러 번 클릭/pulse는 boolean으로 합쳐집니다. 각각의 명령·좌표·발생 순서가 필요하면 `onGesture` 결과를 게임 큐에 저장합니다.
- `releaseSource(source)`는 해당 source의 hold만 해제합니다. `releaseAll()`은 모든 source의 hold를 해제합니다. 해제 edge와 이미 모인 edge는 consume 전까지 남습니다.

## DOM 어댑터 옵션

`createDOMInput(options)`는 `{state, disposed, samplePointerInto, sampleLatestPointerInto, releaseAll, dispose}`를 반환합니다.

- `target` 필수: `ownerDocument`가 있는 입력 표면. `state` 생략 시 새로운 ActionState를 만듭니다.
- `keys` 기본 `{}`: `KeyboardEvent.code → action`. 예: `{KeyA:'left',ArrowLeft:'left'}`. locale별 `key` 문자열 대신 물리 code를 사용합니다.
- `keyboardTarget` 기본 `target.ownerDocument`: keydown을 수집할 범위. 요소로 지정하면 해당 요소에 키보드 포커스를 주는 일은 호출자가 담당합니다. keyup은 ownerDocument capture 단계에서 읽어 UI로 포커스가 옮겨진 뒤에도 기존 hold를 해제합니다.
- `pointerButtons` 기본 `{}`: 숫자 button 0~4 → action. 0은 주 버튼/터치, 1은 중간, 2는 보조 버튼입니다. 수집 중인 포인터의 chord는 `buttons` 비트로 동기화합니다. 처음부터 바인딩되지 않은 버튼만 누른 포인터는 등록하지 않습니다.
- `excludeTarget` 기본 selector: input, textarea, select, button, 링크, contenteditable, `[data-gamekit-ui]`. composed path와 조상 요소를 확인합니다. selector 문자열, `(target,event) => boolean`, 또는 `false`로 바꿀 수 있습니다. predicate는 기본 정책을 대체합니다. 단축키 modifier를 제외하려면 predicate에서 판단하세요.
- `preventDefault` 기본 `true`: 바인딩되고 제외되지 않은 keydown, 어댑터가 잡은 포인터의 down/move/up에만 적용합니다. unbound 키·UI·다른 포인터는 그대로 둡니다. keyup은 기존 hold를 해제하되 UI에서는 기본 동작을 막지 않습니다. 보조 버튼을 바인딩한 표면에서만 contextmenu를 막습니다. 전체 document의 기본 동작을 일괄 차단하지 않습니다.
- `touchAction` 기본 생략: CSS를 변경하지 않습니다. 게임 표면이 브라우저 스크롤/확대를 소유하지 않아야 한다면 명시적으로 `'none'`을 지정하거나 CSS에서 설정하세요. 브라우저가 터치를 스크롤로 전환하면 pointercancel로 해제됩니다. dispose 때 해당 어댑터가 지정한 값이 그대로일 경우에만 이전 값을 복원합니다.
- `gestures` 기본 생략: 아래 tap 정책을 활성화합니다.
- `onGesture` 선택 callback: 완성된 `{type,action,pointerId,pointerType,x,y,u,v,timeMs}`를 새 객체로 전달합니다. 액션 등록이 없는 단일 tap에서는 action이 null일 수 있습니다. 콜백은 DOM 이벤트 수집 시점에 호출되며 게임 입력 제출 시점이 아닙니다.

## 포인터·좌표·생명주기

- `samplePointerInto(pointerId, out)`은 **현재 눌린** 해당 포인터를, `sampleLatestPointerInto(out)`은 마지막 hover/down/move/up 좌표를 씁니다. 없으면 false이며 out은 보존합니다. 있으면 true이며 `{pointerId,pointerType,x,y,u,v,buttons,timeMs,active}`를 씁니다. `active`는 현재 어댑터가 수집 중인지 나타냅니다.
- `pointerPositionInto(event, target, out)`은 CSS bounding rect를 읽어 `{x,y,u,v}`를 씁니다. `x=clientX-left`, `y=clientY-top`, `u=x/rect.width`, `v=y/rect.height`입니다. 0 크기 rect 또는 비정상 수치는 false이며 out을 보존합니다.
- x/y는 화면에 표시된 rect 기준 CSS 픽셀입니다. u/v는 clamp하지 않아 드래그가 표면 밖에 있으면 0~1을 벗어날 수 있습니다. canvas drawing buffer, DPR, 카메라·3D·게임 월드 투영을 입력 모듈이 추측하지 않습니다. border/padding 0, 회전·기울임 없는 표면을 권장합니다. CSS transform으로 표시 크기를 바꿨다면 u/v에 게임의 논리 viewport 크기를 곱해 대응시킵니다.
- mouse/touch/pen은 PointerEvents로 처리합니다. pointerId마다 source와 capture를 별도로 관리합니다. 포인터 capture가 실패해도 ownerDocument의 move/up/cancel이 수집 중인 포인터를 마무리합니다.
- pointercancel·눌린 도중 lostpointercapture는 해당 포인터의 hold를 해제하고 tap을 취소합니다. 정상 up 후 자동으로 발생하는 lostpointercapture는 완료된 tap 후보를 지우지 않습니다.
- window blur, pagehide, document hidden, `input.releaseAll()`은 어댑터가 소유한 모든 hold·포인터·gesture 후보·마지막 좌표를 정리합니다. 같은 ActionState를 사용하는 다른 어댑터/게임 source는 건드리지 않습니다. 해제 edge는 다음 consume까지 유지됩니다. blur 후 fresh keydown 없이 도착하는 orphan OS repeat는 무시합니다.
- `dispose()`는 모든 listener/capture와 소유한 hold를 정리합니다. 여러 번 호출해도 안전합니다. `disposed`는 읽기 전용입니다. listener 제거 이후의 DOM 이벤트는 상태를 바꾸지 않습니다.
- 액션 bool에 모인 edge와 호출자의 gesture 큐는 별도입니다. pause/장면 교체 때 이미 모인 명령도 폐기하려면 게임이 자신의 큐를 비우고 필요에 따라 `consume()`합니다. blur가 게임의 pause를 자동 결정하지 않습니다.

## 선택적 tap/doubleTap

`gestures`에는 `tap`, `doubleTap` 중 최소 하나의 액션 이름을 지정합니다.

- `button` 기본 0
- `tapMs` 기본 400 ms: down→up 최대 시간
- `doubleTapMs` 기본 300 ms: 이전 up→현재 up 최대 간격
- `dragSlop` 기본 12 CSS px: down 위치로부터 허용하는 최대 이동 거리
- `doubleTapSlop` 기본 32 CSS px: 두 up 위치 사이 최대 거리

시간·거리는 모두 유한한 0 이상 수치입니다. 시간 단위는 ms이며 PointerEvent.timeStamp를 사용합니다. 게임 tick/권위 시간으로 사용하지 않습니다.

첫 tap은 즉시 전달하고 두 번째 조건을 만족한 tap은 `doubleTap`만 전달합니다. 첫 tap을 뒤늦게 철회하거나 숨은 timer로 단일 tap을 지연하지 않습니다. 게임은 이 정책에 맞춰 첫 이동→두 번째 구르기 같은 행동을 정의합니다. 같은 pointerType끼리만 짝지으며 두 손가락 동시 입력, drag 후 원위치 복귀, long press, 표면 밖 해제, 취소, UI/다른 표면 입력은 doubleTap 후보를 끊습니다. gesture는 일반 pointer button hold를 대체하지 않습니다.

## 검증·비용·경계

`node --test tests/input.test.mjs`는 DOM 없는 상태, 다중 source, 짧은 클릭 보존, CSS 좌표, gesture 취소, focus/visibility/pagehide, listener/capture 정리를 검사합니다. 테스트의 fake DOM은 실제 브라우저 event 전파·capture 또는 물리 터치 기기 검증을 대신하지 않습니다. 실제 브라우저 범위는 루트 연속 E2E 결과와 함께 확인합니다.

입력 시 source Set/Map을 바꾸며 매 렌더에 큐를 지우거나 객체를 만들 필요가 없습니다. `sampleInto`는 out을 재사용합니다. 포인터 시작·gesture callback·`sample()`에는 객체 생성이 있습니다. `consume()`은 등록된 액션 수에 비례합니다. pointermove의 rect 읽기 비용도 남으므로 게임이 레이아웃 쓰기와 입력 수집을 불필요하게 교차시키지 않아야 합니다.

게임패드·wheel·핀치·가상 조이스틱·월드 선택·navmesh·전투 규칙은 포함하지 않습니다. RALLY FRONTIER의 pointer capture/drag 경계와 Budmori.io의 순수 tap 판정/게임 투영 분리 사례를 참고했으며 기존 게임 코드를 복사하거나 그 게임에 적용했다고 주장하지 않습니다.

### 선택적 포인터 정책 콜백

`onPointer({type,originalEvent,reason,...position})`는 어댑터가 소유한 down/move/up/cancel 및 표면 hover move를 전달합니다. position은 samplePointerInto와 동일한 CSS 좌표 계약이며, originalEvent는 원래 DOM 이벤트입니다. up/cancel은 hold·capture 해제 후 전달됩니다. document fallback과 lost capture도 같은 경로입니다. 게임은 드래그·롱프레스·다중 선택 등 정책만 구현하며 별도 capture/listener를 중복 설치하지 않습니다.

`onRelease({reason,originalEvent})`는 blur/pagehide/visibilitychange/명시 releaseAll/dispose 정리 후 호출합니다. 모든 포인터의 cancel도 전달되며 callback이 실패해도 나머지 hold/capture와 listener 정리는 완료합니다. dispose 이유의 originalEvent는 null입니다. 이 콜백은 tick마다 입력 edge를 소비하거나 게임 명령을 자동 제출하지 않습니다. 원래 UI 제외 정책을 적용하며 UI 입력을 가로채지 않습니다.

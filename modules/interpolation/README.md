# interpolation

## RenderObject와 점 경로 표시 모델

`RenderObject`는 그려지는 객체의 좁은 슈퍼클래스입니다. 타이머·입력·게임 규칙을 소유하지 않습니다. 하위 타입은 `static renderSchema`와 `render(context, model)`만 작성합니다. 스키마는 중첩 트리가 아니라 **필드 경로 → 상속된 보간 상수**의 1:1 맵입니다.

```js
import { RenderObject, PresentationRuntime } from './interpolation.js';
class Unit extends RenderObject {
  x = 0; y = 0; angle = 0; hp = 100; roll = { progress: 0 }; kind = 'unit';
  static renderSchema = {
    x: this.LINEAR, y: this.LINEAR, angle: this.ANGLE,
    hp: this.LINEAR, 'roll.progress': this.LINEAR, kind: this.STEP,
  };
  render(renderer, model) {
    renderer.rect(model.x, model.y, 20, 20, [0, 1, 0, 1], model.angle);
  }
}
const unit = new Unit();
const presentation = new PresentationRuntime({ stepMs: 100 });
// 기존 시뮬 틱 이후 한 번. 전체 생존 목록입니다.
presentation.capture({ revision: 0, sequence: 0, timeMs: 0,
  entities: [{ id: 'u', generation: 0, source: unit }],
}, performance.now());
// 프레임 시각을 한 번 읽고 몸체/그림자/HUD에 같은 모델을 공유합니다.
presentation.render(unit, renderer, performance.now());
```

- `LINEAR=0`, `ANGLE=1`, `STEP=2`, `DECAY=3`, `CYCLE=4`는 코드 상수입니다. DECAY는 값 상승을 새 flash/반동의 시작으로 간주해 해당 필드만 즉시 맞춥니다. CYCLE은 0..1 정규화 진행률이 감소하면 1을 지나 앞으로 순환합니다(0.75→0의 중간은 0.875). 일반 LINEAR 감소를 초기화로 추측하지 않습니다. 타이머와 상태 전환도 아래 스키마 정책으로 선언하며, 소비자가 동작별 조건과 reset 필드 목록을 따로 관리하지 않습니다.
- 경로는 타입당 한 번 컴파일하며 부모 스키마와 같은 경로는 하위 타입이 우선합니다. 부모 전체 경로와 자식 경로를 동시에 선언하는 충돌(`roll`과 `roll.progress`), 빈 구간, prototype 관련 키, getter는 거부합니다. 첫 사용 후 스키마 변경은 지원하지 않습니다. 새 스키마는 새 타입으로 명시적으로 전환합니다.
- `roll.progress`는 원본과 모델에서 동일한 중첩 위치를 뜻합니다. null 부모는 null, 없는 필드는 부재로 유지하며 0으로 대체하지 않습니다. 생성된 모델은 일반 객체이고 원본 prototype·메서드·미등록 필드는 없습니다. Proxy와 this 교체는 사용하지 않습니다.
- `STEP` scalar 외에 명시적으로 선언한 plain-data 배열/객체도 지원하지만 표본을 복사하며 렌더 모델과도 참조를 공유하지 않습니다. 순환/네이티브 객체/함수/accessor는 거부합니다. 객체 참조는 별도 렌더 identity의 ID로 전달하세요. 배열 전체 STEP은 불연속 교체이며 수치 보간이 아닙니다. `points.0.x`는 고정 슬롯입니다. 재정렬 가능한 배열을 인덱스 기반으로 보간하지 말고 항목별 안정적인 entity ID로 등록합니다. 동적 키 wildcard는 없습니다.
- `capture`의 revision/sequence/timeMs/mode, generation, teleport, resetFields는 아래 timeline과 같은 계약입니다. `initialSource`는 새 identity의 명시적 전체 시작 source이며 불연속 reset/teleport가 우선합니다. 입력 검증은 전체 packet을 준비한 뒤 원자적으로 반영합니다.
- `sample(id, generation, nowMs)`는 재사용하는 중첩 모델 또는 null을 반환합니다. null이면 그리지 않습니다. `modelFor(source, nowMs)`는 등록한 객체/현재 유효 모델만 받으며 복사한 원본이나 삭제된 모델을 원본 fallback으로 그리지 않습니다. 명시적인 `entity.type`으로 기존 plain-data 시뮬을 RenderObject 하위 타입의 스키마에 연결할 수도 있습니다. 모델 쓰기는 권위 상태를 바꾸지 않지만 호출자는 표시 모델을 영구 상태로 저장하지 않습니다.
- `snapshotRenderModel(type, source)`는 죽은 객체의 고정 이펙트 anchor처럼 명시적으로 순간 표본이 필요한 곳에만 사용합니다. 선언된 필드만 분리하고 보간 이력이나 source 참조를 보관하지 않습니다. 생존 객체의 누락 track을 원본 값으로 대신 그리는 fallback이 아닙니다.
- `render(source, context, nowMs)`는 **정상적인 source.render(context, model) 호출**입니다. private 필드와 arrow 메서드의 this를 바꾸지 않습니다. 임의의 JS 렌더 함수가 외부 원본을 직접 읽는 것까지 모듈이 차단하지는 못합니다. 소비자 렌더 함수는 모델만 읽도록 코드 검증해야 합니다.

### 필드 정책으로 전환과 시작 표본 선언

```js
static renderSchema = {
  x: this.POSITION_X, y: this.POSITION_Y,
  'clip.key': this.STATE_KEY,
  'clip.leftMs': this.COUNTDOWN_MS,
  'clip.progress': this.CYCLE,
};
```

`COUNTDOWN_MS=5`와 `COUNTDOWN_SECONDS=6`은 비음수 countdown을 표현합니다. 연속 표본에서 `max(0, 이전 값 − 시뮬 timeMs 차이 × 단위 비율)`과 일치하면 기존 곡선을 연결합니다. 예상 감소와 다른 값이면 새 timer 구간으로 간주해 **해당 필드 부모 경로 범위**의 표본을 새 값으로 맞춥니다. 고정 세계 시각에 대해 1ms/ms 또는 .001seconds/ms로 감소하는 필드만 선택하세요. 가변 로컬 시간 배율의 임의 수치를 countdown으로 추측하지 않습니다. float roundoff에는 단위별 1μs와 표현 정밀도 허용 오차를 사용합니다.

`STATE_KEY=7`은 STEP과 같은 scalar 출력이지만 변경되면 같은 부모 범위의 표시 구간을 새로 시작합니다. `clip.key`는 `clip.*`만 새로 연결하고 root x/y는 계속 보간합니다. `clip.timer.leftMs`의 countdown은 `clip.timer.*`만 구분합니다. 상위 구간을 구분하려면 그 구간에 실제로 있는 키 필드를 STATE_KEY로 선언합니다. 경로 prefix는 문자열 부분 일치가 아니라 segment 경계로 컴파일합니다. 키는 finite number/string/boolean/null/undefined만 허용하며 순환 객체나 사용자 함수를 실행하지 않습니다. 모듈은 키 값의 이름이나 게임 동작을 해석하지 않습니다.

`POSITION_X/Y/Z=8/9/10`, `ORIGIN_X/Y/Z=11/12/13`은 LINEAR과 같은 수치 보간에 축 역할을 부여합니다. 타입당 각 역할 축은 한 필드만 선언하며 duplicate는 거부합니다. 필드 경로 자체는 어떤 이름도 가능합니다. 새 continuous identity에서 대응 origin 값이 있으면 해당 position을 origin부터 이어 그립니다. `SPAWN_LINEAR=14`는 새 continuous identity의 해당 수치를 0부터 연결합니다. 기존 identity에는 다시 적용하지 않으며 명시 `initialSource`가 자동 seed보다 우선합니다. 초기 reset/load/rollback 또는 teleport는 모든 seed보다 우선하여 실제 표본으로 맞춥니다.

`new PresentationRuntime({stepMs: 100, snapDistance: 160})`은 선언된 position 축의 이전/현재 차이가 임계치를 넘으면 그 identity를 snap합니다. position 역할이 없으면 적용하지 않고 미등록 x/y 속성을 읽지 않습니다. 이 옵션은 위치 불연속을 표현하는 정책이며 실제 이동/충돌을 판정하지 않습니다. 게임 어댑터는 source/type/identity와 세계 생명주기만 전달하고 timer/phase/발사 이름을 검사하거나 필드별 reset 목록을 만들 필요가 없습니다.

### 선택적 제한적 외삽

입력 preview의 `snapshotPreview(entities)`는 선언 필드의 detached 시작 model을 만듭니다. `capturePreview({revision,sequence,timeMs,phaseStartMs,stepMs,entities},nowMs)`는 실제 fork의 다음 표본을 저장하며 `sample/modelFor/render`가 같은 시간 곡선을 읽습니다. 고정 미래 pose를 RAF마다 그대로 반환하지 않습니다. 방향/상태 교체도 Unit 조건문 없이 같은 schema 정책을 따르고 authority capture에서 그 시각 preview pose로 correction을 연결합니다.

`new PresentationRuntime({ stepMs: 100, extrapolation: { fields: ['x', 'y'], maxMs: 100 } })`는 지정한 LINEAR 계열 필드(LINEAR/POSITION/ORIGIN/SPAWN_LINEAR)만 최근 두 시뮬 표본의 속도로 예측합니다. 기본값은 꺼짐입니다. 수신 순간의 기존 표시와 새 예측의 차이는 stepMs 동안 줄이며, maxMs를 넘으면 마지막 예측 위치를 유지합니다. 보정이 한도 뒤에도 진행하지 않도록 `maxMs >= stepMs`를 요구합니다. HP·경험치를 자동 외삽하지 않고 ANGLE/STEP/DECAY/CYCLE/countdown/key 외삽은 거부합니다. 필드 구간·teleport·세계 reset은 해당 속도와 보정 이력을 초기화합니다.

이 기능은 충돌/급정지/최신 사용자 입력을 예측하지 않습니다. fresh local input response는 [simloop LocalInputPreview](../simloop/README.md#선택적-로컬-입력-미리보기)의 별도 opt-in capability입니다. 이 PresentationRuntime는 그 capability가 전달한 선택 local schema model을 즉시 읽고, confirmed capture에서 이전 preview pose를 reconciliation 시작점으로 사용합니다. remote tracks는 덮어쓰지 않습니다.

### 비용

표본 수집과 새로운 시각의 sample은 선언 필드 수와 경로 구조에 비례합니다. authority와 preview 모두 같은 identity·nowMs의 반복 sample/modelFor는 이미 계산한 모델을 재사용합니다. 몸체·그림자·HUD는 한 프레임 시각을 공유하며 모델을 수정하지 마세요. 같은 시각의 새 capture/capturePreview나 preview 해제는 해당 캐시를 무효화합니다. 모델과 중첩 객체·STEP 출력은 재사용하지만 capture는 원자적 검증을 위해 Map/배열/STEP 표본을 할당합니다. 전체 원본 세계를 복사하지 않으나 큰 subtree를 STEP으로 선언하면 그 비용은 발생합니다. 함수/상수 선언 방식 자체의 속도 우위나 zero-allocation을 주장하지 않습니다. 개발 중 임시 단위 검증 후 코드는 제거하고, 실제 Chromium 입력→중첩 모델→WebGL 픽셀의 고정 시나리오를 로컬에서 실행합니다.

렌더러·DOM·Worker·넷코드와 독립적인 presentation timeline입니다. 시뮬레이션이나 자체 타이머를 실행하지 않습니다.

## 최소 사용

```js
import { InterpolationTimeline } from './interpolation.js'; // dist 브랜치에서 받은 단일 파일
const view = new InterpolationTimeline({
  stepMs: 100,
  schema: { x: 'number', y: 'number', z: 'number', health: 'number', angle: 'angle', state: 'discrete' },
});
const pose = {};
view.accept({ revision: 0, sequence: 0, timeMs: 0, entities: [
  { id: 'player', generation: 0, values: { x: 10, y: 20, z: 0, health: 100, angle: 0, state: 'idle' } },
] }, performance.now());
// 기존 게임 rAF 안에서 호출. 반환 false이면 해당 identity를 그리지 않습니다.
const now = performance.now();
if (view.sampleInto('player', 0, now, pose)) {
  // camera, body root, shadow는 같은 pose를 사용합니다.
}
```

실제 번들을 읽는 [실행 예제](../../examples/interpolation/index.html)와 [고정 브라우저 E2E](../../tests/browser.e2e.mjs)를 사용합니다. 프로젝트 루트에서 `npm ci`, `npm test` 후 정적 서버를 열어 예제를 확인하세요. 별도 CPU·할당 측정은 `npm run benchmark:interpolation`입니다.

## 공개 계약

- `new InterpolationTimeline({schema, stepMs})`: stepMs는 양의 유한 ms이며 생성 후 고정됩니다. TPS 변경은 새 timeline과 초기 snapshot으로 명시적으로 전환합니다. schema는 평평한 필드 선언입니다. `number`는 선형 보간, `angle`은 radians 최단 회전(반 바퀴의 부동소수점 동률은 음의 방향, 허용 오차 `Number.EPSILON * 2π`), `discrete`는 수신 즉시 전환입니다. 각도 출력은 `[0, 2π)` 범위이므로 경계의 숫자 표기는 감깁니다.
- `accept(packet, nowMs) → boolean`: packet은 `{revision, sequence, timeMs, entities, mode?}`입니다. revision·sequence·generation은 음이 아닌 safe integer, id는 비어 있지 않은 문자열입니다. timeMs는 유한 시뮬레이션 시각이며 음수도 허용됩니다. 서로 다른 revision 사이에서는 되감을 수 있습니다.
- `entities`는 **전체 현재 생존 목록**입니다. 누락한 id는 즉시 despawn됩니다. 모든 선언 필드는 각 `values`에 반드시 있어야 합니다. sparse patch·deep path·object-valued discrete는 지원하지 않습니다. 게임의 기존 mirror에 delta를 반영한 후 이 계약으로 어댑트하세요. 추가 게임 필드는 무시하며 전체 엔티티를 clone하지 않습니다. discrete는 string/boolean/null/유한 number만 허용합니다.
- `sampleInto(id, generation, nowMs, out) → boolean`: caller가 소유한 쓰기 가능한 일반 객체에 선언 필드만 기록합니다. 유효 identity가 없으면 false이며 out은 그대로입니다. 이전 out을 그리지 않도록 반드시 반환값을 확인하세요. frozen 객체·setter·Proxy·packet accessor 등의 사용자 코드 부작용은 지원 계약 밖입니다.
- `size`는 현재 생존 track 수입니다. 원본 packet·schema·게임 객체를 수정하지 않습니다. 선언 필드의 scalar만 복사합니다.

### 시간과 순서

수신과 sample에는 **같은 main-realm 단조 시계**의 ms를 넘깁니다. 이전 성공 호출보다 작은 시각은 throw합니다. 같은 시각에 여러 entity를 평가하거나 여러 packet을 받아도 됩니다. rAF timestamp와 event handler의 performance.now()를 섞을 때 이미 처리한 수신 시각보다 오래된 rAF timestamp를 전달하지 말고, 프레임 진입에서 performance.now()를 한 번 읽어 모든 consumer에 공유하세요. Worker performance.now()를 main clock에서 빼지 않습니다. timeMs는 순서 검증에만 쓰며 receipt와 차감하지 않습니다.

낮은 revision, 같은 revision의 중복/낮은 sequence, 뒤로 간 timeMs는 false로 거부합니다. sequence가 커도 timeMs가 같으면 허용합니다. 거부된 packet은 clock도 진행시키지 않습니다. malformed 신규 packet은 throw하며 전체 snapshot과 clock을 원자적으로 유지합니다. 정상 입력은 plain-data 객체여야 합니다.

첫 표본은 기본적으로 snap합니다. 새 identity의 명시적 `initialValues`가 있으면 아래 생명주기 계약대로 시작 pose를 연결합니다. 이후 수신 순간 기존 곡선을 평가한 위치부터 최신 목표까지 stepMs 동안 연결합니다. 마지막 rAF pose를 시작점으로 재사용하지 않습니다. 같은 시각의 coalesced packet들은 같은 출발점에서 최신 목표로 향합니다. 완료 후에는 대기하며 외삽하지 않습니다.

이는 buffer 없는 chase 정책입니다. 130/70ms 지터나 누락 틱은 속도 변화·대기·빠른 따라잡기를 만들 수 있습니다. 목표가 멀리 도약해도 자동 teleport threshold는 없습니다. 숨은 500ms 지연, 등속 보장, 네트워크 지터 해결을 주장하지 않습니다.

### 생명주기와 게임 표현

- 기존 id의 generation이 바뀌면 기본적으로 snap합니다. 생성 세대는 게임이 관리합니다. 삭제된 identity를 요청하면 false이고, 재등장에는 새 generation을 쓰세요.
- `entity.resetFields: ['fieldA', 'fieldB']`는 그 필드만 수신 즉시 목표값으로 맞춥니다. 나머지 필드는 수신 시각의 기존 곡선에서 계속 연결합니다. 예를 들어 게임이 판단한 타이머 재시작·표현 세기 상승을 resetFields로 전달하면 위치 필드를 함께 순간이동시킬 필요가 없습니다. 알려진 schema key만 허용하며 중복·잘못된 형식·unknown key는 전체 packet을 원자적으로 거부합니다. 빈 배열은 아무 필드도 reset하지 않습니다.
- `entity.initialValues`는 schema 전체 scalar 필드를 갖는 선택적 시작 pose입니다. track이 없거나 generation이 달라진 **새 identity**에만 적용하며, continuous packet 수신 시각부터 stepMs 동안 initialValues→values를 연결합니다. 게임이 정한 발사 시작점 등에서 첫 공개 표본까지 연결할 때 사용할 수 있습니다. 같은 generation의 기존 track에 전달하면 검증만 하고 무시하므로 진행 중 곡선을 되돌리지 않습니다. 삭제 후 재등장에도 사용할 수 있지만 새 generation 관리는 게임 책임입니다. sparse initialValues는 지원하지 않으며 값을 복사하므로 caller 변경이 진행 중 곡선을 바꾸지 않습니다.
- 특정 entity의 `teleport: true`는 그 수신 순간 snap합니다. teleport와 전체 reset/load/rollback은 initialValues보다 우선해 목표 pose로 snap합니다. 이 경우에도 제공된 initialValues/resetFields는 검증합니다. initialValues와 resetFields를 함께 쓰면 선택된 필드는 처음부터 목표값이며 나머지는 seed에서 연결합니다. discrete 필드는 언제나 수신 시점의 목표값입니다.
- 전체 load/reset/rollback은 **더 큰 revision**과 `mode: 'load' | 'reset' | 'rollback'`을 함께 전달합니다. 모든 track을 새 snapshot으로 교체하고 snap합니다. 이전 revision의 늦은 packet은 거부합니다. 초기 packet은 어느 mode든 가능합니다. 이후 revision 변경을 continuous로 처리하지 않습니다.
- hitstop·공격 애니메이션·사망 표현은 게임 소유입니다. 몸체 애니메이션만 정지한다면 root pose는 계속 공유하고 애니메이션 phase만 멈추세요. 전체 presentation 시간을 멈출 때는 receipt와 sample 둘 모두에 동일하게 변환한 논리 presentation clock을 적용해야 합니다. raw authority XYZ로 바꿨다가 이전 보간으로 되돌리는 방식은 사용하지 않습니다.

## 비용과 확인 범위

생존 entity 수 N, 선언 필드 수 F일 때 accept는 O(NF)이며 Map과 entity별 track·두 field 배열을 새로 만듭니다. 생성자에서 필드 인덱스 Map을 한 번 만들며, resetFields를 제공한 accept는 O(R) 검증/적용과 작은 Set을 추가합니다(R은 reset 필드 수). initialValues는 O(F) 검증과 복사 비용이 있고, 새 identity에서 그 배열을 시작 pose로 재사용합니다. 기존 identity나 강제 snap에서 제공한 불필요한 initialValues도 계약 검증을 위해 복사하므로 필요할 때만 전달하세요. 원자적 갱신을 위해 accept 중 이전/새 track이 잠시 함께 존재합니다. sample은 O(F)이고 caller out을 재사용하며 snapshot/pose 객체를 새로 만들지 않습니다. 성능이 필요한 게임은 전체 snapshot 어댑터 비용도 따로 측정해야 합니다. 이 첫 구현에 delta cache·history buffer·pool을 숨기지 않습니다.

E2E는 실제 Worker 이동에서 추출한 표본, 10/20/30 TPS·60Hz 위상, 지터·coalescing·순서 거부·rollback·load·teleport·identity 재사용·원본 불변·유한 값·각도·discrete를 검사합니다. fixture의 출처와 범위는 JSON에 있습니다. 20/30 TPS는 표본의 시각을 재구성한 보간 검증이며 해당 게임을 그 TPS로 실행했다는 의미가 아닙니다.

`npm run benchmark:interpolation`의 별도 Node benchmark는 256 entity의 sample/accept batch CPU p50/p95와 heap 변화, 재사용 output 수를 로그로 출력합니다. heap 변화는 GC가 포함된 관찰값이지 총 할당량이나 0-allocation 증명이 아닙니다. 별도 V8 통계 프로파일은 accept/sampleInto 호출 스택의 추정 할당 바이트를 기록하며 수집된 객체도 포함합니다. 샘플 간격은 1024 bytes이고 0 추정도 실제 0 할당을 증명하지 않습니다. Chromium 통합 검사는 실제 독립 ESM 3개와 DOM 입력·고정 틱·rAF·WebGL 픽셀·texture/alpha/order·생명주기를 확인합니다. 모바일·기기 FPS·GPU 성능·전체 게임 통합은 별도 검증 대상입니다.

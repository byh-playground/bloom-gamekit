# interpolation

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

실제 번들을 읽는 [실행 예제](../../examples/interpolation/index.html)와 [연속 E2E](../../tests/interpolation.e2e.mjs)가 같은 어댑터를 사용합니다. 프로젝트 루트에서 `npm ci`, `npm test` 후 정적 서버를 열어 예제를 확인하세요.

## 공개 계약

- `new InterpolationTimeline({schema, stepMs})`: stepMs는 양의 유한 ms이며 생성 후 고정됩니다. TPS 변경은 새 timeline과 초기 snapshot으로 명시적으로 전환합니다. schema는 평평한 필드 선언입니다. `number`는 선형 보간, `angle`은 radians 최단 회전(정확히 반 바퀴면 음의 방향), `discrete`는 수신 즉시 전환입니다. 각도 출력은 `[0, 2π)` 범위이므로 경계의 숫자 표기는 감깁니다.
- `accept(packet, nowMs) → boolean`: packet은 `{revision, sequence, timeMs, entities, mode?}`입니다. revision·sequence·generation은 음이 아닌 safe integer, id는 비어 있지 않은 문자열입니다. timeMs는 유한 시뮬레이션 시각이며 음수도 허용됩니다. 서로 다른 revision 사이에서는 되감을 수 있습니다.
- `entities`는 **전체 현재 생존 목록**입니다. 누락한 id는 즉시 despawn됩니다. 모든 선언 필드는 각 `values`에 반드시 있어야 합니다. sparse patch·deep path·object-valued discrete는 지원하지 않습니다. 게임의 기존 mirror에 delta를 반영한 후 이 계약으로 어댑트하세요. 추가 게임 필드는 무시하며 전체 엔티티를 clone하지 않습니다. discrete는 string/boolean/null/유한 number만 허용합니다.
- `sampleInto(id, generation, nowMs, out) → boolean`: caller가 소유한 쓰기 가능한 일반 객체에 선언 필드만 기록합니다. 유효 identity가 없으면 false이며 out은 그대로입니다. 이전 out을 그리지 않도록 반드시 반환값을 확인하세요. frozen 객체·setter·Proxy·packet accessor 등의 사용자 코드 부작용은 지원 계약 밖입니다.
- `size`는 현재 생존 track 수입니다. 원본 packet·schema·게임 객체를 수정하지 않습니다. 선언 필드의 scalar만 복사합니다.

### 시간과 순서

수신과 sample에는 **같은 main-realm 단조 시계**의 ms를 넘깁니다. 이전 성공 호출보다 작은 시각은 throw합니다. 같은 시각에 여러 entity를 평가하거나 여러 packet을 받아도 됩니다. rAF timestamp와 event handler의 performance.now()를 섞을 때 이미 처리한 수신 시각보다 오래된 rAF timestamp를 전달하지 말고, 프레임 진입에서 performance.now()를 한 번 읽어 모든 consumer에 공유하세요. Worker performance.now()를 main clock에서 빼지 않습니다. timeMs는 순서 검증에만 쓰며 receipt와 차감하지 않습니다.

낮은 revision, 같은 revision의 중복/낮은 sequence, 뒤로 간 timeMs는 false로 거부합니다. sequence가 커도 timeMs가 같으면 허용합니다. 거부된 packet은 clock도 진행시키지 않습니다. malformed 신규 packet은 throw하며 전체 snapshot과 clock을 원자적으로 유지합니다. 정상 입력은 plain-data 객체여야 합니다.

첫 표본은 snap합니다. 이후 수신 순간 기존 곡선을 평가한 위치부터 최신 목표까지 stepMs 동안 연결합니다. 마지막 rAF pose를 시작점으로 재사용하지 않습니다. 같은 시각의 coalesced packet들은 같은 출발점에서 최신 목표로 향합니다. 완료 후에는 대기하며 외삽하지 않습니다.

이는 buffer 없는 chase 정책입니다. 130/70ms 지터나 누락 틱은 속도 변화·대기·빠른 따라잡기를 만들 수 있습니다. 목표가 멀리 도약해도 자동 teleport threshold는 없습니다. 숨은 500ms 지연, 등속 보장, 네트워크 지터 해결을 주장하지 않습니다.

### 생명주기와 게임 표현

- 기존 id의 generation이 바뀌면 snap합니다. 생성 세대는 게임이 관리합니다. 삭제된 identity를 요청하면 false이고, 재등장에는 새 generation을 쓰세요.
- 특정 entity의 `teleport: true`는 그 수신 순간 snap합니다.
- 전체 load/reset/rollback은 **더 큰 revision**과 `mode: 'load' | 'reset' | 'rollback'`을 함께 전달합니다. 모든 track을 새 snapshot으로 교체하고 snap합니다. 이전 revision의 늦은 packet은 거부합니다. 초기 packet은 어느 mode든 가능합니다. 이후 revision 변경을 continuous로 처리하지 않습니다.
- hitstop·공격 애니메이션·사망 표현은 게임 소유입니다. 몸체 애니메이션만 정지한다면 root pose는 계속 공유하고 애니메이션 phase만 멈추세요. 전체 presentation 시간을 멈출 때는 receipt와 sample 둘 모두에 동일하게 변환한 논리 presentation clock을 적용해야 합니다. raw authority XYZ로 바꿨다가 이전 보간으로 되돌리는 방식은 사용하지 않습니다.

## 비용과 확인 범위

생존 entity 수 N, 선언 필드 수 F일 때 accept는 O(NF)이며 Map과 entity별 track·두 field 배열을 새로 만듭니다. 원자적 갱신을 위해 accept 중 이전/새 track이 잠시 함께 존재합니다. sample은 O(F)이고 caller out을 재사용하며 snapshot/pose 객체를 새로 만들지 않습니다. 성능이 필요한 게임은 전체 snapshot 어댑터 비용도 따로 측정해야 합니다. 이 첫 구현에 delta cache·history buffer·pool을 숨기지 않습니다.

E2E는 실제 Worker 이동에서 추출한 표본, 10/20/30 TPS·60Hz 위상, 지터·coalescing·순서 거부·rollback·load·teleport·identity 재사용·원본 불변·유한 값·각도·discrete를 검사합니다. fixture의 출처와 범위는 JSON에 있습니다. 20/30 TPS는 표본의 시각을 재구성한 보간 검증이며 해당 게임을 그 TPS로 실행했다는 의미가 아닙니다.

Node benchmark는 256 entity의 sample/accept batch CPU p50/p95와 heap 변화, 재사용 output 수를 로그로 출력합니다. heap 변화는 GC가 포함된 관찰값이지 총 할당량이나 0-allocation 증명이 아닙니다. 별도 V8 통계 프로파일은 accept/sampleInto 호출 스택의 추정 할당 바이트를 기록하며 수집된 객체도 포함합니다. 샘플 간격은 1024 bytes이고 0 추정도 실제 0 할당을 증명하지 않습니다. Chromium 검사는 실제 ESM 로딩·rAF·canvas 픽셀만 확인합니다. 모바일·기기 FPS·GPU 성능·전체 게임 통합은 별도 검증 대상입니다.

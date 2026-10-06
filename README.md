# bloom-gamekit

브라우저 게임에서 공통으로 쓰는 보간·렌더링·입력·실행·결정론·전송·리플레이·롤백 기능을 독립 패키지로 개발하는 모노레포입니다. 필요한 기능만 골라 조합하며, 게임 전체를 소유하는 범용 엔진 클래스는 만들지 않습니다.

**모든 공개 기능은 독립적인 plain JavaScript ESM입니다.** 소비자는 필요한 파일만 가져가며 외부 import나 공유 chunk를 요구하지 않습니다. 보간은 pose, WebGL renderer/device는 GPU 제출·자원, input은 장치 이벤트/action, simloop는 실행 스케줄, camera는 투영, presentation-events는 표현 자원, hud는 화면 anchor, debug-tools는 진단을 소유합니다. 결정론·전송·리플레이·rollback은 기존 SDK 구현을 책임별로 분리했으며, 이전 후 수정 이력은 SDK 출처 문서에 구분해 기록합니다.

## 시작하기

- [보간 API·시간·생명주기 계약](packages/interpolation/README.md)
- [WebGL 1 렌더링 API·texture·생명주기](packages/rendering/README.md)
- [입력 action·DOM·tick 소비 계약](packages/input/README.md)
- [카메라·표현 이벤트](packages/presentation-events/README.md) · [HUD](packages/hud/README.md) · [진단](packages/debug-tools/README.md) · [카메라](packages/camera/README.md)
- [동적 방·공개 입장·새로고침 복구](packages/rollback/README.md) · [Nostr 디렉터리·전송](packages/transport/README.md)
- [SDK 전체/분리 API와 이전](packages/rollback-netcode/README.md)
- [실제 독립 번들을 연결하는 사용 예제](examples/interpolation/index.html)
- [연속 E2E와 CPU 측정](tests/interpolation.e2e.mjs)

```text
packages/interpolation/src/   schema.js · timeline.js · tracks.js · index.js
packages/rendering/src/      index.js (WebGL 1 kernel)
packages/input/src/          actions.js · dom.js · index.js
packages/*/README.md         모듈별 API·비용·제한 계약
examples/interpolation/      입력 → 고정 틱 → 보간 → WebGL 통합 예제
scripts/                     빌드·배포 도구
tests/                      연속 E2E·Worker 표본·Chromium 실행 검사
.github/workflows/ci.yml      PR 검사 / main→dist 자동 생성
```

개발 명령은 `npm ci`, `npm test`, `npm run test:browser`입니다. 브라우저 첫 설치는 `npx playwright install chromium`입니다. 루트 package.json은 개발 도구만 관리하며 모듈별 버전·workspace·npm 발행은 아직 도입하지 않았습니다.

## GitHub 파일 배포

PR에서는 빌드·Node E2E·Chromium 예제만 읽기 권한으로 검사합니다. main에 승인된 변경이 들어오면 GitHub Actions가 빌드·검사한 결과와 같은 번들을 확인한 후 `dist` 브랜치의 `interpolation.js`, `rendering.js`, `input.js`, `manifest.json`을 자동 갱신합니다. 모듈의 정확한 목록은 scripts/distribution.mjs와 생성 manifest가 소유합니다. 생성 JS는 소스 커밋에 넣지 않습니다. 표준 `ubuntu-latest`만 사용하며 유료 runner·artifact 저장·Release·npm·Pages는 쓰지 않습니다. 공개 저장소의 무료 표준 runner 정책 범위에서 동작합니다.

main 실행이 성공하면 [interpolation.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/interpolation.js), [rendering.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/rendering.js), [input.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/input.js), [hash manifest](https://github.com/byh-playground/bloom-gamekit/blob/dist/manifest.json)에서 파일을 공유할 수 있습니다. GitHub Raw URL은 JS MIME/CORS를 보장하는 웹 호스팅 계약이 아니므로 브라우저의 직접 import 주소로 가정하지 마세요. 파일을 받아 게임과 함께 호스팅하고, 재현이 필요하면 dist 커밋 SHA를 고정하세요. dist 커밋 메시지에 source commit과 manifest/각 번들의 SHA-256이 기록됩니다. 검사 job의 manifest hash와 배포 직전 모든 재빌드 파일을 대조합니다. 기존 dist의 다른 파일은 보존하고, stale main 실행은 건너뛰며 경합 시 non-fast-forward로 중단합니다. 브랜치 게시의 실제 성공은 main 머지 후 별도로 확인해야 합니다.

## 공통 설계 원칙

- **최적화가 먼저, 재미가 그다음입니다.** 계산량·호출 빈도·할당·메모리·초기 로딩·틱·렌더 비용을 함께 판단합니다. 비용을 다른 구간으로 옮긴 것을 제거했다고 계산하지 않습니다. 예상과 실측을 구분하고 성능 회귀를 숨기지 않습니다.
- **Is-a:** 각 객체가 무엇이며 어떤 책임을 갖는지 좁고 구체적으로 정의합니다.
- **Has-a:** 필요한 capability와 정책을 조합합니다. 기능 추가를 위해 거대한 공통 클래스나 장르별 상속 체계를 만들지 않습니다.
- **Can-be:** 실행·대기·예측·복구 등은 해당 소유자의 상태와 정책으로 다룹니다. 같은 기능의 엔진을 상황별로 복제하지 않습니다.
- 밸런스·지속시간·표현 한도·동작 정책은 Definition 또는 명시적 설정을 기준으로 삼습니다. 같은 규칙을 여러 함수의 조건문과 상수로 복제하지 않습니다.
- 지속시간과 시각의 공통 단위는 **밀리초(ms)**입니다. 시뮬레이션 tick과 입력 sequence는 시간과 별개입니다. 외부 API의 단위가 다르면 경계에서 명시적으로 변환하며, TPS를 바꿔도 게임 지속시간이 달라지지 않아야 합니다.
- 입력 → 결정론적 시뮬레이션 → 표현의 소유권을 분리합니다. 렌더 pose·보간 캐시·카메라·이펙트로 권위 상태를 재구성하거나 덮어쓰지 않습니다.
- 패키지는 다른 패키지의 내부 상태를 읽지 않습니다. 필요한 데이터와 동작을 공개 계약으로 전달하며, 기능 하나를 사용하려고 나머지 패키지를 초기화하게 만들지 않습니다.

## rollback SDK 이전과 게임 경계

기존 [rollback-netcode](https://github.com/byh-playground/rollback-netcode)의 검증된 소스를 이 저장소로 책임별 이전했습니다. [호환 API·출처·이전 방법](packages/rollback-netcode/README.md)을 참조하세요. 기존 저장소는 보존하며 입력 순서·명령 sequence·tick·예측·롤백·복구는 새로 구현하지 않습니다. `deterministic.js`, `simloop.js`, `transport.js`, `replay.js`, `rollback.js` 또는 전체 API 호환 `rollback-netcode.js`를 선택할 수 있습니다. 분리 모듈도 외부 runtime import가 없으며 dist commit SHA와 manifest hash로 고정합니다.

게임은 자신의 Definition·규칙·권위 상태·완전한 snapshot과 결정론적 어댑터를 소유합니다. UI와 AI가 제출한 행동은 같은 명령 경로를 거쳐 SDK가 정한 tick에서 실행됩니다. input 패키지는 기기 이벤트를 정리할 뿐, 자체 타이머로 명령을 실행하거나 권위 상태를 직접 수정하지 않습니다. 포커스 상실과 입력 해제도 같은 입력 계약에 연결합니다.

보간·렌더링은 완료된 시뮬레이션 결과를 표현합니다. 표현의 실제 시간과 SDK의 고정 논리 시간을 혼동하지 않으며, 프레임 지연을 보정하려고 시뮬레이션 dt를 바꾸지 않습니다. 재실행 중 소리·알림·이펙트를 중복 발생시키지 않도록 게임의 표현 이벤트 경계에 맞춥니다.

## 첫 보간 구현의 기준

첫 대상은 새 snapshot 수신과 렌더 프레임 사이의 retarget 연속성입니다. 마지막 rAF에서 그렸던 pose를 그대로 새 시작점으로 쓰면 수신 순간까지 진행한 기존 곡선의 위치와 어긋날 수 있습니다.

- 새 목표가 도착한 **그 시각의 기존 보간 곡선을 평가한 pose**에서 출발해 최신 목표까지 이어갑니다. 수신과 렌더 평가에는 같은 단조 시간 기준을 사용합니다.
- 초기 기본 정책은 새 목표까지 **시뮬레이션 한 틱의 시간(`1000 / TPS` ms)** 동안 연결하는 continuous retarget입니다. 별도의 숨은 500ms 버퍼나 미래 위치 외삽을 기본값으로 넣지 않습니다.
- 이 정책에도 목표를 따라가는 표현 지연이 있습니다. 새 표본이 늦어 목표에 먼저 도착하면 그 위치에서 대기하므로 모든 지터와 멈춤을 없앤다고 주장하지 않습니다. 지연·버퍼·대기 정책의 변경은 설정과 비용을 드러냅니다.
- hitstop은 권위 XYZ로 순간 이동했다가 이전 보간으로 돌아가는 방식으로 처리하지 않습니다. 표현 정지와 재개가 같은 pose·시간 정책을 따르게 하며, 순간이동·spawn/despawn·롤백 보정처럼 불연속이 필요한 경우는 명시적으로 구분합니다.
- 기존 게임의 NavMesh·전투·성장·캠페인 규칙은 공통 패키지로 복사하지 않습니다. 게임별로 서로 다른 공간 탐색 정책을 하나로 강제하지 않습니다.

이 계약은 독립 모듈과 재현 fixture로 검사합니다. 기존 게임 자체에 적용하거나 그 게임의 지터를 해결했다는 보고는 아닙니다.

## 검증과 성능

큰 조합별 테스트 목록보다 **실제 패키지와 게임 경로를 연결하는 하나의 연속 E2E**를 중심으로 검증합니다. 첫 보간 구현에는 재현 가능한 snapshot 수신 시각·rAF 시각·목표 pose fixture를 연결해 규칙적 수신, 지터·지연, retarget, hitstop과 재개를 같은 흐름에서 확인합니다. 브라우저 E2E는 같은 실행 예제에서 실제 DOM 입력 → 100ms 고정 시뮬레이션 → 보간 → WebGL 픽셀을 연결합니다. 키/터치 edge·UI 제외·blur·DPR·texture/alpha/order·camera·batch 재사용·context loss/restore·dispose를 한 실행에서 이어 검사합니다. 발견한 실패에는 필요한 집중 회귀 검사만 추가합니다.

같은 입력·seed·규모에서 변경 전후를 비교하고, 보간 계산·할당·메모리와 실제 화면 갱신 간격을 구분해 기록합니다. CPU 렌더 제출 시간을 GPU 완료시간으로 부르지 않습니다. 개발 기기·브라우저·장면·측정 구간을 남기고 짧은 구간이나 한 기기의 결과를 전체 성능으로 일반화하지 않습니다.

정적 검사나 모의 실행을 실제 브라우저·WebGL·기기 검증으로 대신하지 않습니다. 통과·실패·미실행 범위를 구별하고, 확인하지 않은 결과를 Stable 또는 VALIDATED라고 표시하지 않습니다. CI 로그에 해당 커밋의 실제 실행 결과를 남깁니다.

## 모듈을 조합하는 범위

예제의 게임이 100ms 시뮬레이션 규칙·명령 소비·y-sort·UI 내용을 소유합니다. simloop의 createLoop가 누적/프레임 실행을 맡고 camera·presentation-events·hud·debug-tools를 조합합니다. input의 sample은 edge를 지우지 않으며 게임/SDK가 명령을 수집한 뒤 consume합니다. rendering에는 interpolation import가 없고, 완성된 pose를 받은 게임이 body/shadow/health를 제출합니다. context 복구 시 texture handle은 유지되며 현재 프레임은 버립니다.

이 범위는 최소 core를 완성한 것입니다. terrain/fog·게임 아트·전투·sprite animation·scenegraph·게임별 투영/geometry·asset loading은 공통 게임 규칙으로 구현하지 않았습니다. WebGLDevice는 기존 게임이 제공하는 shader·geometry를 받아 자원·buffer·draw 호출을 관리합니다. 기존 Budmori/Rally 게임에는 아직 적용하지 않았습니다. 브라우저 CI는 실제 WebGL 1 shader와 픽셀을 SwiftShader로 검사하므로 Canvas2D 모의 검증이 아니지만, 모바일·기기 GPU FPS 검증도 아닙니다. 화면 metrics는 실제 draw/vertex/upload count와 관찰 interval/CPU 제출 시간이며 GPU 완료 시간으로 해석하지 않습니다.

## 작업과 리뷰

이 README와 모듈 문서가 저장소의 개발 기준입니다. 관련 열린 PR과 기존 변경을 먼저 확인하고 다른 작업을 보존합니다. 최초 저장소 등록 이후의 변경은 `codex/` 작업 브랜치에서 진행하고 `main` 대상 PR로 리뷰합니다. 병렬 수정은 파일뿐 아니라 함수·상태 소유자·공통 계약·호출 관계의 겹침도 확인합니다.

개별 작업의 의도·담당·상태는 PR 본문에 관리하며 같은 계획을 여러 파일에 복제하지 않습니다. 변경 이유와 중요한 회귀 위험, 실제 검증 결과와 미검증 범위를 남깁니다. 코드 구현 완료와 패키지 공개 배포를 구분하고, 명시적인 사용자 지시 없이 머지하거나 배포 설정을 변경하지 않습니다.

문서와 커밋 메시지는 한국어를 기본으로 합니다. 식별자·API 이름·널리 쓰는 기술 용어는 원래 표기를 유지합니다.

```text
[타입] 변경 내용 요약

- 필요한 변경 이유와 검증 내용
```

기본 타입은 `[feature]`, `[bug-fix]`, `[refactor]`, `[performance]`, `[docs]`, `[test]`, `[chore]`이며 최초 등록은 `[init]`을 사용합니다.

## 참고

- [RALLY FRONTIER](https://github.com/byh-playground/rally-frontier): 게임·SDK·표현의 경계와 공통 작업 운영
- [Budmori.io](https://github.com/byh-playground/budmori-io): 최적화 우선, Definition, ms 시간, 실제 게임 E2E 기준
- [rollback-netcode 개발 계약](https://github.com/byh-playground/rollback-netcode/blob/main/CONTRACT.md): 결정론·명령·틱·snapshot·복구의 기준

게임별 README의 실행물 구성·길찾기·전투 규칙은 각 게임에 남깁니다. 이 저장소에는 함께 사용할 수 있는 공통 경계만 가져옵니다.

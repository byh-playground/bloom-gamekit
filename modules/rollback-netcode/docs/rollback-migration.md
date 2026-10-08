# 기존 rollback SDK 이전 검증

원본은 byh-playground/rollback-netcode commit `c3173914519a78834360430071e7a125736d86d5`입니다. 구현은 책임별 소스로 이동하고 import 경로를 바꿨으며 core의 StateHistory와 playReplay를 단일 공유 구현으로 분리했습니다. 새 알고리즘·history 전략·게임 규칙은 추가하지 않았습니다.

현재 장기 검증은 `npm test`의 실제 브라우저 시나리오와 `npm run test:network`의 RTC·방 수명주기 시나리오로 수행합니다. 이 절의 과거 단위 검증 코드는 개발 완료 시 제거했으며 결과·소스 해시는 Git 이력과 provenance 기록으로 확인합니다. 로컬 RTC 시나리오를 공용 relay/NAT·모바일 기기 검증으로 확대 해석하지 않습니다.

기존 core/runtime/mesh/mesh-reliability/room/group-room/star-transport/Nostr/synctest/utilities/value-codec/loop 회귀 테스트를 보존했습니다. 입력 지연·손실·중복·순서 변경, rollback 재실행, snapshot 거부·정규 왕복·복구 예산, replay 최종 hash·용량 제한, 타입 codec과 PRNG 상태, command 보존, 방/전송 cleanup이 대상입니다. 원본의 staged versions hash 검사 대신 이 저장소의 manifest·publisher 검사를 사용합니다.

브라우저는 원본 2-context 실제 RTCPeerConnection/DataChannel harness를 `modules/rollback-netcode/scripts/rollback-browser.mjs`로 옮겨 같은 240tick 입력·command·late input·replay hash 흐름을 검사합니다. 기존 gamekit DOM→interpolation→실제 WebGL 검사 뒤 연속 실행하며 CI에서 빌드된 번들을 사용합니다. 공개 relay 통신·다른 엔진/모바일·기기 GPU FPS·기존 게임 자체 검증은 이 검사로 대체하지 않습니다.

2026-10-06 로컬 npm ci 완료. SDK 출처/API 검사와 소비자 입력 확장을 포함한 Node 163건 및 보간·표현 연속 E2E 통과. 로컬 Chromium 실행은 socket() Operation not permitted로 시작이 차단되었고 sandbox escalation에서도 동일했습니다. 브라우저 통과로 기록하지 않습니다. Draft PR CI의 해당 source commit 검사 결과를 별도로 확인해야 합니다. 기존 타입 fixture는 TypeScript 5.9.3의 strict/noEmit/ES2022/NodeNext로 로컬 검사하여 통과했습니다. 이후 추가된 출처/독립 모듈 검사는 최종 PR 결과에 기록합니다.

개발 검사: `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run test:browser`. 필요한 경우 공식 Playwright Chromium을 설치합니다. 로컬에서 시스템 Chromium을 쓸 때 `CHROMIUM_EXECUTABLE_PATH`를 지정할 수 있습니다.


## 이전 후 리뷰 수정

core의 transport detach를 idempotent/identity-guarded cleanup으로 고치고 공개 scalar pace를 추가했습니다. loop는 callback 중 stop/start의 세대 취소, 할당 없는 pacing 읽기, 명시적 backlogPolicy:'retain'을 지원합니다. 기존 기본 backlog drop과 프로토콜·snapshot·replay 형식은 유지합니다. 이는 위 원본 이후의 동작 수정이며 원본 저장소에 역으로 적용한 변경이 아닙니다.


## 2026-10-07 모듈 중심 배치

runtime 파일은 `modules/<module>/*.js`에 두고 모듈별 문서·검사·예제·도구를 같은 디렉터리에서 관리합니다. 루트에는 공통 빌드·배포와 여러 모듈의 연속 E2E만 남깁니다. build 검사는 모듈의 tests/examples/legacy 아래 파일이 runtime 배포에 섞이는 것도 거부합니다.

이동 전 빌드와 비교한 공개 13개 번들의 실행 코드 bytes는 같습니다. esbuild의 소스 경로 주석만 바뀌므로 번들/manifest SHA-256은 달라집니다. 파일명·export·VERSION·PROTOCOL_VERSION과 외부 import 없는 배포 계약은 유지합니다. 두 번 연속 재빌드한 manifest SHA-256도 같습니다.

모듈 경로의 `npm test`에서 Node 290건과 보간·표현 연속 E2E가 통과했습니다. `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser`는 네 browser suite 모두 sandbox의 `socket() failed: Operation not permitted`에서 시작이 막혔습니다. 실제 WebGL·RTC·데모 검증은 통과로 기록하지 않으며 해당 소스의 GitHub CI 결과를 따로 확인해야 합니다. 이번 이동의 TypeScript 검사는 로컬 compiler가 없어 실행하지 않았습니다. CI의 읽기 전용 validation job에 TypeScript 5.9.3 strict/noEmit/ES2022·DOM/NodeNext 검사를 추가했으며 해당 실행 결과를 별도로 확인합니다.

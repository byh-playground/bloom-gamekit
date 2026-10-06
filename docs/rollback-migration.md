# 기존 rollback SDK 이전 검증

원본은 byh-playground/rollback-netcode commit `c3173914519a78834360430071e7a125736d86d5`입니다. 구현은 책임별 소스로 이동하고 import 경로를 바꿨으며 core의 StateHistory와 playReplay를 단일 공유 구현으로 분리했습니다. 새 알고리즘·history 전략·게임 규칙은 추가하지 않았습니다.

`tests/rollback/build.test.mjs`는 이동을 역변환한 각 구현 파일의 SHA-256이 고정 upstream 파일과 같은지 검사합니다. 공개 27개 export/기존 타입·버전 계약과 분리 번들의 무외부 import·불필요한 transport/session 코드 제외도 검사합니다.

기존 core/runtime/mesh/mesh-reliability/room/group-room/star-transport/Nostr/synctest/utilities/value-codec/loop 회귀 테스트를 보존했습니다. 입력 지연·손실·중복·순서 변경, rollback 재실행, snapshot 거부·정규 왕복·복구 예산, replay 최종 hash·용량 제한, 타입 codec과 PRNG 상태, command 보존, 방/전송 cleanup이 대상입니다. 원본의 staged versions hash 검사 대신 이 저장소의 manifest·publisher 검사를 사용합니다.

브라우저는 원본 2-context 실제 RTCPeerConnection/DataChannel harness를 `scripts/rollback-browser.mjs`로 옮겨 같은 240tick 입력·command·late input·replay hash 흐름을 검사합니다. 기존 gamekit DOM→interpolation→실제 WebGL 검사 뒤 연속 실행하며 CI에서 빌드된 번들을 사용합니다. 공개 relay 통신·다른 엔진/모바일·기기 GPU FPS·기존 게임 자체 검증은 이 검사로 대체하지 않습니다.

2026-10-06 로컬 npm ci 완료. SDK 출처/API 검사와 소비자 입력 확장을 포함한 Node 163건 및 보간·표현 연속 E2E 통과. 로컬 Chromium 실행은 socket() Operation not permitted로 시작이 차단되었고 sandbox escalation에서도 동일했습니다. 브라우저 통과로 기록하지 않습니다. Draft PR CI의 해당 source commit 검사 결과를 별도로 확인해야 합니다. 기존 타입 fixture는 TypeScript 5.9.3의 strict/noEmit/ES2022/NodeNext로 로컬 검사하여 통과했습니다. 이후 추가된 출처/독립 모듈 검사는 최종 PR 결과에 기록합니다.

개발 검사: `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run test:browser`. 필요한 경우 공식 Playwright Chromium을 설치합니다. 로컬에서 시스템 Chromium을 쓸 때 `CHROMIUM_EXECUTABLE_PATH`를 지정할 수 있습니다.

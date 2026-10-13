# 작은 롤백 연결 기준 예제

루트에서 `npm ci`, `npm run build`, `npm run serve:rollback-demo`를 실행한 뒤
<http://127.0.0.1:8771/modules/rollback-netcode/examples/index.html>을 엽니다.
브라우저는 빌드된 세 개의 독립 ESM만 가져옵니다. 소비 게임에 Node/bundler는 필요 없습니다.

- [main.js](./main.js): 공식 방·루프·preview·표시·연출의 기본 연결 순서.
- [game.js](./game.js): snapshot, 이동·대시·발사·반사 규칙, 선언적 표시 데이터.
- [index.html](./index.html): 조작과 진단. 기본은 한 화면의 두 독립 세계가 실제 WebRTC로 통신합니다.

## 먼저 직접 확인하기

1. 10 TPS로 새 방 시작. A/B를 서로 다른 방향으로 움직이고 각자 대시·발사합니다.
   버튼에서 손을 떼도 대시가 끝날 때까지 preview가 유지됩니다. 명령은 다른 소유자에 적용되지 않습니다.
2. RTC 지연을 켜고 방향을 바꿉니다. rollback 횟수, 명령의 고정 실행 T, 원형 예측 연출을 봅니다.
   소리 옵션은 확정 후 한 번만 재생합니다. `같은 확정 tick에서 hash 비교`로 두 세계를 비교합니다.
3. 발사체의 높이·회전·그림자·지면 잔상·표적 점선을 봅니다. 벽 반사 좌표는 게임이 공급합니다.
   발사체가 사라진 후 다시 발사하면 같은 ID의 다음 generation입니다. 순간이동은 이동 보간을 건너뜁니다.
4. 한 tick 섬광은 snapshot 사이에 태어나 사라집니다. 게임이 명시한 고정 anchor 이벤트만으로 보입니다.
5. 중지 후 15/20/30 TPS로 새 방을 시작합니다. baseHz 120, 입력 60Hz, 표시 RAF는 분리됩니다.
   실행 중 TPS UI는 잠깁니다. 온라인에서는 두 참가자 모두 종료하고 같은 TPS로 새 방에 들어갑니다.
   namespace와 handshake에도 TPS가 포함되므로 혼합 TPS로 기존 방에 합류하지 않습니다.

## 복사할 기본 연결 순서

1. 게임의 `save/load/validateSnapshot/step/applyMembership`를 만들고 `RoomSession`에 전달합니다.
   snapshot에 tick, roster, actor ID/generation, 진행 중 action, 명령 결과, 발사체 generation을 포함합니다.
2. `PresentationRuntime`를 만들고 초기 authority를 capture합니다. local actor의 같은 ID/generation으로
   `LocalInputPreview`를 연결합니다. fork는 snapshot을 복제하고 **동일한 게임 update**를 실행하며
   외부 연출·오디오·통신을 호출하지 않습니다. 이 예제는 소유 actor만 preview하고 발사체는 authority에서 표시합니다.
3. `createLoop({session,inputPreview,getInput,onAdvance,...})`를 만듭니다. held input은 byte로,
   대시·발사는 one-shot `commands`로 반환합니다. DOM edge에서 `loop.observeInput(now)`를 호출하면
   공식 `submitInput`이 즉시 예약·송신합니다. `queueCommand`로 다시 넣거나 T를 게임이 변경하지 않습니다.
4. deadline scheduler에서 `pollInput`과 `pulse({render:false,input:false})`를 호출합니다.
   시뮬레이션은 loop만 진행시킵니다. RAF에서는 `loop.render()`만 호출합니다.
   수신 지터나 디스플레이 주파수로 dt를 바꾸지 않습니다.
5. 완료된 authority 경계에서 full entity list를 capture한 뒤 preview checkpoint를 reconcile합니다.
   초기 명령 sequence가 `null`이면 optional 인자를 생략합니다. 이 작은 예제는 매 경계 snapshot을 사용하며
   remote continuation key를 추측해 fork 재사용 최적화를 하지 않습니다.
6. RAF에서 `frame(now)`를 **한 번** 열고 `frame.forEach`, `modelFor`, `pathInto`만 읽습니다.
   SDK 표시 목록을 순회해야 authority에서 이미 제거된 발사체도 지연된 수명 끝까지 보입니다.
   raw authority가 없다고 그 객체를 그리거나, raw pose로 fallback하지 않습니다.
7. SDK `rollback`→journal `beginRollback`, `reconciled`→`endRollback`을 같은 callback 경계에 연결합니다.
   authority 재표시는 새 revision으로 reset하고 preview도 rollback 모드로 reconcile합니다.
   `confirmThrough(min(confirmedTick,tick-1))`는 확정된 연출만 시작합니다.
8. membership/recovery는 journal epoch와 표시 revision의 reset 경계입니다. 후보 recovery/replay 중
   side effect는 생략합니다. 중지는 scheduler → loop → preview → journal → session/room 순서로 정리합니다.
   blur/hidden에서는 held 입력을 release하고 재개 시 clock backlog를 reset합니다.

## 게임이 반드시 제공하는 의미

| 데이터 | 이 예제 | 모듈이 추측하지 않는 이유 |
|---|---|---|
| 소유자·one-shot 실행 T | frame.playerId, command.executeTick | 다른 actor로 재적용하거나 T를 바꾸면 판정이 달라짐 |
| action lifetime | nullable `action`, kind/sequence/total STATE_KEY, left COUNTDOWN_MS | 손을 뗀 뒤에도 진행되는 대시를 입력 버튼 상태만으로 알 수 없음 |
| 생성·재사용 | origin XYZ, bornMs/initialSource, slot ID와 generation | 첫 표본만으로 출발점·출생 시각·다른 incarnation을 구별할 수 없음 |
| 반사·표적 | 정확한 tick 내부 pathPoints, target ID | endpoint 두 개만으로 반사 궤적·추적 의미를 복원할 수 없음 |
| 순간이동·rollback | teleportSerial→teleport, 새 revision | 큰 이동이 걸음인지 이동 불연속인지 게임이 정의 |
| 즉시 섬광 | tick/sequence/entity/generation + fixed anchor | 두 snapshot에 모두 없는 객체는 보간으로 생성할 수 없음 |
| 연출 정책 | reversible particle / confirmed sound | 들린 소리는 취소할 수 없으며 particle은 stop/reconcile 가능 |

`action`의 object→null, 새 action의 키 전환, preview 종료는 SDK의 원자적 구조/필드 계약을
그대로 사용합니다. 게임 측 NaN 가드나 혼합 pose로 숨기지 않습니다. 예제 draw에는 부분 action,
동일 frame 참조, 잔상 head/body 불일치를 즉시 드러내는 검사도 있습니다.

## 검증과 범위

`npm run test:rollback-demo`는 기존 180초 상한 안에서 한 대표 흐름을 실행합니다.
실제 native WebRTC 두 peer, 10→중지→30 TPS, held 이동, 소유별 대시·발사, 늦은 입력 rollback,
명령/연출 dedup, 선택적 상태, ID 재사용·순간이동, 같은 확정 tick의 hash, 재시작 정리를 확인합니다.
15/20은 정수 분주상 유효한 선택이며 전 조합 성능 매트릭스를 만들지 않습니다.

온라인 방 만들기/참가는 공식 Nostr dynamic room을 사용합니다. 외부 relay/NAT smoke는
`RUN_LIVE_ROOM_CHECK=1 npm run test:rollback-live`의 별도 선택 검사입니다.
로컬 두 peer 검증을 서로 다른 네트워크·모바일 GPU·대규모 세션 검증이라고 부르지 않습니다.
SDK dist는 기존 JS/manifest/font 배포만 유지합니다. 이 HTML 예제는 소스에 있으며 새 Pages 배포는 만들지 않습니다.

로컬 지연 버튼은 A → B 실제 RTC 송신만 240ms 늦춥니다. 예제는 `pacingPolicy: none`으로
늦은 입력의 rollback을 관찰하며, 이를 모든 게임의 권장 pacing 설정으로 제시하지 않습니다.

검증 기록: Edge 155에서 대표 RTC 흐름 15.7초 PASS, core 브라우저 흐름 10.0초 PASS.
대표 흐름은 양쪽 반사 표본과 지연 제거를 관찰했고 SFX/particle 중복은 0이었습니다.
외부 relay/NAT, 15/20 TPS 실행, 모바일·하드웨어 GPU는 이 기록의 검증 범위 밖입니다.

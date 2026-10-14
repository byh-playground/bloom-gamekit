# 입력 제출 지연과 고정 TPS

simulation TPS, 장치 수집·네트워크 정비 주기, render FPS는 서로 다른 설정입니다. 이벤트 입력은 observeInput → session.submitInput → RTC send로 즉시 제출합니다. 주기적인 pollInput은 gamepad 등 이벤트가 없는 장치를 수집하고 재전송을 정비합니다. pulse는 원래 고정 dt와 pacing으로 advance하며 render는 이 경로를 실행하지 않습니다. 기존 LocalInputPreview와 PresentationRuntime을 그대로 연결합니다.

## 바뀌는 지연과 남는 지연

- 제거하는 것은 다음 장치 수집/시뮬레이션 tick까지 기다리는 전송 지연입니다. 초안은 확정 입력이나 simulation step이 아닙니다.
- 15 TPS의 tick 간격은 약 66.7ms입니다. 2 tick input delay는 약 133.3ms이며 이번 변경에서 제거하지 않습니다. 15 TPS는 검증 조건일 뿐 기본값이 아닙니다.
- 낮은 TPS의 충돌·판정 시간 해상도는 보간이나 즉시 송신으로 높아지지 않습니다. 더 세밀한 판정에는 게임이 더 높은 TPS, 연속 충돌 처리 등의 별도 선택을 해야 합니다.
- LocalInputPreview는 원래 ACK를 기다리지 않습니다. 현재 표시 pose에서 예측 목표로 추종하며, PresentationRuntime은 선택된 preview를 다시 권위 보간 지연에 넣지 않습니다. 최초 픽셀 변화와 목표 도달은 다른 측정량입니다.
- poll의 rollback replay는 기존 동기 실행입니다. createLoop.maxCatchupSteps가 이 replay 전체를 나누지 않습니다. 같은 main thread의 긴 step/save/load/replay는 RAF를 지연시킬 수 있습니다.

## 기존 RTC 시나리오에서 재현

`modules/rollback-netcode/scripts/availability-browser.mjs`의 INPUT_LATENCY 분기를 사용합니다. 기존 두 실제 RTC 클라이언트와 같은 simulation step, LocalInputPreview, 실제 WebGL renderer를 사용하며 새 테스트 엔진을 만들지 않습니다.

PowerShell:

```powershell
$env:CHROMIUM_EXECUTABLE_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
$env:INPUT_LATENCY='after'
node project/test-scenarios.mjs availability
```

이전 소스에서 같은 `buildDistribution(root)`로 만든 dist 디렉터리를 INPUT_BASELINE_DIST로 지정하면 같은 fixture가 이전 번들을 사용합니다. 테스트·빌드 전체 상한은 기존 180초입니다. 이전 소스 SHA는 `55c6345fa2f2c1d506f3002eb3e14e1f4c6d06df`입니다.

## 측정 정의

워밍업 뒤 DOM click handler의 performance.now를 시작으로 RTC send, 로컬 fork의 해당 명령 실행, 실제 WebGL framebuffer 행의 최초 변경, 첫 forecast 목표까지 90% 이동, 권위 명령 실행을 기록합니다. 화면 측정은 GPU framebuffer를 readPixels로 확인한 결과이며 디스플레이 scanout/광자 지연은 아닙니다. 매 프레임 readback 자체 비용도 포함합니다. 작은 이동은 픽셀 경계를 넘기 전에 다음 입력이 오므로 표본이 누락될 수 있습니다. 다음 입력 이전에 관측되지 않은 표본을 0ms로 계산하지 않습니다. 화면 변화는 진행 중인 이동도 포함하므로 새 명령만의 인과적 반응 시간으로 해석하지 않습니다.

상대 수신 시각은 상대 clock으로 별도 기록하고 같은 RTC 채널로 receipt를 돌려보냅니다. 송신 클라이언트 clock에서 event→send와 event→receipt 사이가 원격 수신의 시간 범위입니다. 두 클라이언트 performance.now를 직접 빼거나 RTT/2를 실제 편도 지연으로 보고하지 않습니다.

같은 tick의 revision 3개를 역순·중복 전달, 확정 뒤 지연 초안 전달, 550ms 입력 지연 및 중복 재전송을 같은 시나리오에서 검증합니다. 최종 29개 명령의 sequence/order/exactly-once와 동일 확정 경계의 상태 hash, 이벤트 전후 tick/save 횟수 불변을 확인합니다. 기존 room 시나리오가 재연결·epoch 변경·bootstrap·rollback 경계를 검증합니다.

CPU는 adapter step/save/load/replay, preview clone/fork/replay를 구분합니다. GPU 실행 시간은 측정하지 않으며 CPU 또는 readPixels 경과를 GPU 시간이라고 부르지 않습니다. 이 작은 fixture 결과로 실제 게임의 CPU 절감률이나 인터넷·모바일 체감을 보장하지 않습니다. 실제 게임 consumer 업데이트는 이번 범위에 포함하지 않습니다.

## 2026-10-13 검증 결과

Windows Edge 155.0.4283.45, 같은 머신·fixture, 워밍업 후 각 조건 24개 DOM 이벤트. 전후 실행은 순차 실행했고 다른 회귀 검사와 겹치지 않았습니다. 5/30/60 및 15/40/30은 simulation TPS/장치 Hz/목표 render FPS입니다. 값은 ms 중앙값 / p95, 괄호는 관측 수입니다.

| 조건 | 버전 | 이벤트→송신 | 이벤트→RTC receipt | 이벤트→preview 계산 | 이벤트→framebuffer 변화 | 이벤트→권위 실행 |
|---|---|---|---|---|---|---|
| 5/30/60 | before | 100.9 / 182.3 (24) | 101.6 / 183 (24) | 0.3 / 0.5 (24) | 58.6 / 108.7 (14) | 500 / 581.4 (24) |
| 15/40/30 | before | 38.4 / 68.6 (24) | 38.8 / 69.2 (24) | 0.3 / 0.4 (24) | 23.4 / 104.3 (17) | 170.2 / 199 (24) |
| 5/30/60 | after | 0.2 / 0.3 (24) | 1.1 / 2.2 (24) | 0.4 / 0.6 (24) | 53.1 / 94.1 (13) | 519.2 / 597.1 (24) |
| 15/40/30 | after | 0.2 / 0.3 (24) | 1 / 1.5 (24) | 0.4 / 0.6 (24) | 28.3 / 53.3 (21) | 171.8 / 198.8 (24) |

송신 대기는 감소했지만 로컬 preview는 이전부터 즉시 계산됐으며, 권위 실행 지연은 유지됐습니다. framebuffer 표본은 다음 이벤트가 오기 전에 픽셀이 변한 경우만 포함하므로 전후 관측 수가 다릅니다. 화면 체감 개선율로 환산하지 않습니다. 목표 90% 도달도 별도이며 아래에 기록합니다.

| 조건 | 버전 | 실제 tick / 초 (TPS) | render 횟수 / 최대 간격 ms | adapter step / save 합계 ms | preview clone / fork / replay 합계 ms | 목표 90% 도달 ms |
|---|---|---|---|---|---|---|
| 5/30/60 | before | 15 / 3.032 (4.95) | 182 / 17.50 | 0.30 / 0.40 | 0.5 / 1.8 / 1.8 | 63.4 / 175.2 (12) |
| 15/40/30 | before | 38 / 2.592 (14.66) | 55 / 33.70 | 0.20 / 2.40 | 1.3 / 2.8 / 2.1 | 44.9 / 104.3 (17) |
| 5/30/60 | after | 15 / 3.031 (4.95) | 180 / 39.70 | 0.10 / 0.70 | 0.4 / 1.5 / 2 | 71.7 / 186.4 (11) |
| 15/40/30 | after | 39 / 2.617 (14.9) | 79 / 33.80 | 0.30 / 2.00 | 0.7 / 3.4 / 2.3 | 59.7 / 83.6 (23) |

매 authority advance마다 한 번의 preview snapshot을 사용한 fixture입니다. 이벤트 자체는 authority save/step을 추가하지 않았습니다. 타이머 해상도가 약 0.1ms인 작은 작업의 CPU 차이는 잡음 수준이며 비용 절감률을 주장하지 않습니다. 목표 FPS와 실제 프레임 수는 같지 않을 수 있습니다. 위 최대 RAF 간격과 전체 횟수를 함께 공개하며 이 실행에서 15 TPS baseline의 실제 프레임 수가 더 적었습니다. 새 전송은 24개 revision에 5 TPS 조건 866bytes, 15 TPS 조건 768bytes의 송신 초안 패킷을 추가했습니다(반대 방향 ACK 별도). 이벤트 핸들러 전체 중앙값은 전후 0.3→0.4ms였습니다.

550ms 지연 분기에서 15 TPS baseline은 rollback 1회/6 tick, 변경본은 1회/7 tick을 재실행했습니다. 양쪽 모두 command 29개의 순서·중복 없음과 같은 확정 경계 hash가 일치했습니다. 변경본 상대의 adapter load는 1회/약 0.1ms, replay step 합계는 타이머 해상도 미만, 최대 한 번의 save는 약 0.2ms였습니다. 이는 큰 실제 게임 snapshot이나 긴 replay의 비용 검증이 아닙니다. 5 TPS 분기는 변경본에서 rollback 없이 수렴했습니다. 입력 phase에 따라 tick과 최종 held-state 값은 전후 실행 사이에 다르므로 전후 hash의 동일성을 주장하지 않습니다. 각 실행의 두 peer가 동일 canonical 경계에서 일치하는지를 검사합니다.

- 최종 latency 시나리오: before 19.415초 / after 19.402초 PASS. 같은 tick revision 역순/중복, 확정 후 처음 수신된 초안, heartbeat 재전송, 이벤트 tick/save 불변, 29 command exactly-once, protocol 1 패킷 거절 PASS.
- 기존 전체 all: 109.663초 PASS (DOM/WebGL, Scenario, audio, rollback/network, dynamic room, availability, demo).
- 기존 room: 94.362초 PASS (2→5명, 미확정 명령 handoff, 재연결, guest/coordinator 새로고침, coordinator 이탈, inactive 복귀, rollback).
- 브라우저 숨김은 headless 실행에서 실제 visibility를 보장하지 않아 별도 미검증으로 남깁니다. 실제 freeze/resume과 명시적 RAF 중단 분기는 기존 시나리오로 검증했습니다.

원시 측정은 실행 시 test-results/rollback/input-latency-before.json 및 input-latency-after.json에 생성됩니다. 설정 TPS/defaults, 저장/리플레이 포맷은 그대로이며 protocol 2 배포끼리 연결해야 합니다.

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
node scripts/test-scenarios.mjs availability
```

이전 소스에서 같은 `buildDistribution(root)`로 만든 dist 디렉터리를 INPUT_BASELINE_DIST로 지정하면 같은 fixture가 이전 번들을 사용합니다. 테스트·빌드 전체 상한은 기존 180초입니다. 이전 소스 SHA는 `55c6345fa2f2c1d506f3002eb3e14e1f4c6d06df`입니다.

## 측정 정의

워밍업 뒤 DOM click handler의 performance.now를 시작으로 RTC send, 로컬 fork의 해당 명령 실행, 실제 WebGL framebuffer 행의 최초 변경, 첫 forecast 목표까지 90% 이동, 권위 명령 실행을 기록합니다. 화면 측정은 GPU framebuffer를 readPixels로 확인한 결과이며 디스플레이 scanout/광자 지연은 아닙니다. 매 프레임 readback 자체 비용도 포함합니다. 작은 이동은 픽셀 경계를 넘기 전에 다음 입력이 오므로 표본이 누락될 수 있습니다. 다음 입력 이전에 관측되지 않은 표본을 0ms로 계산하지 않습니다. 화면 변화는 진행 중인 이동도 포함하므로 새 명령만의 인과적 반응 시간으로 해석하지 않습니다.

상대 수신 시각은 상대 clock으로 별도 기록하고 같은 RTC 채널로 receipt를 돌려보냅니다. 송신 클라이언트 clock에서 event→send와 event→receipt 사이가 원격 수신의 시간 범위입니다. 두 클라이언트 performance.now를 직접 빼거나 RTT/2를 실제 편도 지연으로 보고하지 않습니다.

같은 tick의 revision 3개를 역순·중복 전달, 확정 뒤 지연 초안 전달, 550ms 입력 지연 및 중복 재전송을 같은 시나리오에서 검증합니다. 최종 29개 명령의 sequence/order/exactly-once와 동일 확정 경계의 상태 hash, 이벤트 전후 tick/save 횟수 불변을 확인합니다. 기존 room 시나리오가 재연결·epoch 변경·bootstrap·rollback 경계를 검증합니다.

CPU는 adapter step/save/load/replay, preview clone/fork/replay를 구분합니다. GPU 실행 시간은 측정하지 않으며 CPU 또는 readPixels 경과를 GPU 시간이라고 부르지 않습니다. 이 작은 fixture 결과로 실제 게임의 CPU 절감률이나 인터넷·모바일 체감을 보장하지 않습니다. 실제 게임 consumer 업데이트는 이번 범위에 포함하지 않습니다.

# RoomSession 생성 모드 검증

2026-10-12, Windows / Node 25.9.0 / Edge 155.0.4283.45. 비교 기준은 main `a9f481604eba4f7328e8e55a6a1a20df7ac7fbde`입니다.

## 구조와 경계

기존 RoomSession은 lockstep만 허용했고 현재 tick에서 bootstrap과 명령 순번을 내보냈습니다. 이제 생성 시 `profile.mode`를 선택하고 `min(tick, confirmedTick + 1)`의 실제 확정 경계에서 membership을 준비합니다. 네트워크 local/online과 가용성 strict/available은 별개입니다. 실행 중 모드 변경은 제공하지 않습니다.

rollback snapshot에는 그 경계의 명령 순번 map을 연결합니다. 명령이 없는 tick은 같은 map을 공유하고, rollback/recovery는 상태와 순번을 함께 복원합니다. 확정 경계 뒤에 이미 예측 실행된 로컬 명령도 새 epoch에 이월하며 donor가 실행한 sequence는 제외합니다. 비활성 roster의 마지막 순번은 선택된 분기와 함께 보존합니다. losing branch의 진행/명령 폐기는 available의 기존 정책입니다.

lockstep snapshot 빈도는 유지합니다. 테스트 중 sparse checkpoint 사이로 복귀할 때 순번 조회가 실패하는 경우를 발견해, 그 경우에만 checkpoint와 보관된 입력에서 순번을 복원했습니다. 새로운 simulation, transport, presentation queue를 만들지 않았습니다. 기존 Core/RoomSession/Availability와 presentation-events를 연결합니다.

## 실제 브라우저 검증

- `npm run test:room`: 80.4초 PASS. 실제 RTC의 1→5인 참가, 2인 미확정 예측 명령 재연결 이월, guest/coordinator refresh, coordinator 이탈, available 복귀. 모든 checkpoint의 hash 일치와 명령 중복/누락 검사를 통과했습니다.
- 같은 suite의 별도 2/4 페이지 RTC: 350ms 입력 지연, CDP 실행 중단, 타이머 간격 변경, transport 단절/재연결, 2/2 partition 후 분기 선택, coordinator 이관, 동일 tick 상태 불일치 복구, strict 대기/복귀를 검증했습니다.
- 지연 사례에서 두 peer 모두 `A:1:7`을 한 번 실행했고 hash가 일치했습니다. 수신 peer가 실제 rollback 1회/2 tick 재실행했으며 snapshot save 38회, 누적 4,531바이트였습니다. 송신 peer는 36회/4,297바이트였습니다. 이는 작은 codec fixture의 관측값입니다.
- inactive guest와 coordinator가 돌아온 뒤 각각 `B:1→2`, `A:1→2` 순번이 이어지고 이미 실행한 명령이 중복되지 않았습니다.
- dynamic fixture는 실제 `PresentationEventQueue`를 사용합니다. global rollback 경계, epoch commit의 journal 교체, bootstrap 외부 효과 억제, 확정 command 효과 중복 방지를 검사합니다.
- `npm test`: 8.7초 PASS. 실제 DOM과 WebGL1/SwiftShader 픽셀, 독립 ESM 소비 경로를 검사합니다.
- `npm run test:network`: 80.8초 PASS. 기본 lockstep 5인 합류/refresh/이탈, legacy/cooperative snapshot 경로와 paced directory, available 복귀, fixed Core 두 모드의 실제 RTC 회귀입니다.
- Bounko consumer: 9.6초 PASS. 390px/1280px에서 직접 URL·F5·뒤/앞 이동, 스킬 프리뷰 일시정지/재시작/종료, 소개 재생, 전투 설정 복귀, 저장/구매 상태 불변을 확인했습니다. Bounko `4719e0d`를 사용했고 기존 배포 핀을 변경하지 않았습니다.

suite 전체 상한은 각각 180초입니다. 실행 결과는 `test-results/rollback/room-modes-report.json`, `availability-rollback-report.json`, `availability-lockstep-report.json`, `dynamic-room-report.json`에 생성됩니다. 별도 Node 집중 검사는 sparse checkpoint 사이의 command baseline/이월을 확인한 후 저장소에 남기지 않았습니다.

## 동일 조건 성능

128 KiB canonical snapshot, 20,000 tick, lockstep local RoomSession, checksum 간격 20, history 64, 명령/네트워크/렌더링 없음. 같은 프로세스에서 전후 각각 10회 워밍업 후 순서를 교대로 바꾸어 각각 9회 측정했습니다. CPU 경과 시간의 중앙값입니다.

| 항목 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| tick CPU | 5.591 µs | 5.551 µs |
| 초기화 CPU | 1.150 ms | 1.439 ms |
| snapshot save | 1,001 | 1,001 |
| 누적 직렬화 | 131,203,072 B | 131,203,072 B |
| 보관 snapshot | 655,360 B | 655,360 B |

tick 범위는 전 5.374–7.670 µs, 후 5.267–9.368 µs로 겹칩니다. 성능 향상으로 주장하지 않습니다. 초기화 중앙값은 약 0.289ms 증가했습니다. sparse snapshot 비용 증가나 매 tick 전체 순번 map 복사는 없습니다. rollback은 원래 Core처럼 매 tick snapshot을 저장하므로 lockstep과 동일 비용이라고 해석하면 안 됩니다.

## 범위 한계

공개 relay/NAT, 실제 모바일 기기, OS suspend는 검증하지 않았습니다. RTC는 실제 브라우저 채널이지만 directory는 서명된 로컬 Nostr relay fixture이며 availability RoomTransport는 프로세스 내 fixture입니다. headless에서는 실제 hidden-tab 상태가 관측되지 않아 그 항목은 PASS로 표시하지 않습니다. 렌더 정지와 스크립트 중단은 별도 명시적 주입입니다. GPU 시간은 측정하지 않았고 CPU/SwiftShader 결과를 하드웨어 GPU 또는 모바일 FPS로 대체하지 않습니다.

# lockstep 설정과 직렬화 비용 측정

실행: `node --expose-gc modules/rollback/scripts/benchmark-lockstep.mjs`.

동일 canonical JSON 어댑터·고정 입력·300 tick·64 tick input/history window·20 tick checksum·replay 켬으로 rollback과 lockstep을 번갈아 5회 측정했습니다. 각 모드 warm-up 1회 후 표본 중앙값입니다. 병렬 작업이 존재하는 cloud Node 환경의 CPU fixture이며 실제 게임 render/main-loop·GPU·휴대폰 FPS 측정이 아닙니다. 실제 Rally/Budmori 어댑터 측정은 해당 소비자 저장소가 소유합니다.

| entities | rollback 전체 advance ms | lockstep 전체 advance ms | rollback tick 중앙값 ms | lockstep tick 중앙값 ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 8.873 | 5.120 | 0.01450 | 0.01152 |
| 155 | 26.093 | 7.981 | 0.06303 | 0.01445 |
| 1000 | 115.700 | 18.681 | 0.29941 | 0.02371 |

모든 경우 save 횟수는 **301 → 16** (최초 1회 + 20 tick마다 1회), 입력·최종 상태 hash는 동일합니다. 정상 tick의 adapter.load와 rollback/예측은 없었습니다. 체크포인트를 매 tick 검사하도록 설정하거나 게임이 매 tick getStateHash/save를 호출하면 이 이득을 다시 지불합니다.

1,000 entities: adapter.save 직렬화 누적 중앙값 93.188 → 5.267ms, 직렬화 바이트 21,256,946 → 1,128,132, 보관 snapshot 바이트 4,519,141 → 352,771입니다. SDK는 호출 시 안전한 bytes 복사를 유지합니다. 같은 입력 로그/replay/초기 snapshot 메모리는 계속 존재합니다. Post-GC JS heap delta는 309,008 → 292,440 bytes였지만 TypedArray의 external memory와 전체 할당량을 뜻하지 않으며 잡음이 커서 총 메모리 절감률로 사용하지 않습니다.

검증은 단순 비용 수치 외에 1,000 entities save-call 회귀, 0/양수 지연, 모든 roster/no-op receipt, loss/duplicate/out-of-order, backpressure, stalled 명령 재개, mode/delay/checksum HELLO 거절, 늦은 확정 입력 충돌, sparse checksum recovery, 임의 requested tick의 이전 checkpoint 복구, replay cap·복구 후 hash, failed step/byte-budget 복원과 기존 rollback 테스트를 함께 사용합니다. 실제 RTC harness는 동일 경로를 rollback과 lockstep 두 번 실행합니다. 실행별 실제 통과/환경 제약은 PR에 기록합니다.

시간 경계: 전체 advance/tick 시간은 생성 후 300 tick 루프만 측정합니다. save 누적 시간·횟수·바이트는 세션 생성의 최초 save도 포함합니다. 최종 상태 동등성용 직접 JSON/hash 계산은 측정 구간 밖에서 양쪽 동일하게 실행합니다. 진단 hash/export를 매 tick 호출하는 부하는 이 측정에 없습니다.

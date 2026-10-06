# 리뷰 수정 전후 재현 측정

기준 소스: `b822ec6463ab7c018d440ba87c16c0d87fccecb2`. 비교 대상은 이 문서와 함께 제출된 소스입니다. 2026-10-06 Linux x64, Intel Xeon Platinum 8573C, Node v24.19.0에서 각 버전 2회 warmup 후 순서를 교대로 바꾼 7회 측정의 중앙값입니다. CPU 측정은 process.cpuUsage, elapsed는 performance.now입니다. 공유 실행 환경의 부하와 GC 때문에 수치는 변동합니다.

## 재현

```sh
git worktree add --detach /tmp/gamekit-before b822ec6463ab7c018d440ba87c16c0d87fccecb2
node --expose-gc scripts/benchmark-reviewed.mjs /tmp/gamekit-before > benchmark.json
```

외부 서비스나 게임 상태를 바꾸지 않는 Node fixture입니다. 렌더러·GPU·브라우저·실기기 FPS나 전체 게임의 향상률을 의미하지 않습니다. 정확한 객체 교체/metrics getter 횟수는 timing과 분리한 동등 fixture에서 계수합니다. post-GC retained heap은 총 할당량이 아닙니다.

## 표현 이벤트

매 tick 200개 instant event를 120tick 동안 생성하여 24,000개 tombstone을 보관합니다. 동일 tick 확정을 60회 반복한 뒤 확정 tick을 60회 진행합니다. payload 해제, 시작 횟수, 남은 12,000개 identity와 수집 횟수를 확인합니다.

| 구간 | 이전 CPU ms | 이후 CPU ms | 이전 elapsed ms | 이후 elapsed ms |
|---|---:|---:|---:|---:|
| 24,000개 준비·최초 확정 | 168.643 | 123.946 | 115.588 | 90.188 |
| 같은 tick 60회 확정 | 79.735 | 0.021 | 76.395 | 0.012 |
| 60tick 진행·수집 | 83.718 | 53.939 | 67.748 | 39.394 |

- 같은 tick: tombstone 교체 객체 1,440,000 → 0, journal iterator 시작 120 → 0
- 진행 tick: tombstone 교체 객체 1,086,000 → 0; 전체 순회는 유지
- 준비 구간: tombstone 교체 객체 1,452,000 → 24,000. 비용을 초기 구간으로 넘긴 결과가 아님
- post-GC retained heap: 6,115,904 → 6,312,992 bytes (+197,088 bytes, 약 3.2%). record별 compaction flag 추가의 비용을 포함함
- 실패한 start/중단된 confirm pass는 같은 watermark에서 재시도하므로 이 오류 경로는 O(1) fast path가 아님

## 실행 루프 pacing

20,000 pulse × 5step = 100,000 step 결정을 동일하게 수행합니다. 실제 RollbackSession.metrics getter를 사용하며 poll/advance는 양쪽 모두 같은 무작업 stub으로 대체하여 scheduling 비용만 분리합니다. 반환 input/result도 재사용합니다.

- 전체 metrics snapshot: 220,000 → 0
- CPU 중앙값: 54.150 → 1.358 ms
- elapsed 중앙값: 54.041 → 1.355 ms
- 기존 metrics snapshot API는 유지. 새 scalar pace가 없는 외부 session은 step 결정당 한 번의 metrics.pace fallback을 사용

## 정확성 검증 범위

기준 코드에서 새 회귀 검사가 실패하고 수정 후 통과함을 확인했습니다: tombstone 재할당, stop/start 중복 rAF, stop 이후 catchup 지속, callback 경계 취소, metrics snapshot 할당, stale transport disposer, unsubscribe 오류, scalar API. retain backlog는 명시적 추가 옵션으로 기본 drop 동작·고정 dt를 보존하며 bounded catchup, held debt, pause reset, pace 변경을 검사합니다.

`npm ci --ignore-scripts --no-audit --no-fund --offline`, `npm test`: Node 177건 및 보간·표현 연속 E2E 통과. TypeScript 5.9.3 strict/noEmit/ES2022/NodeNext 타입 fixture 통과. 로컬 Chromium은 socket() Operation not permitted로 실행이 차단되었으므로 실제 WebGL/RTC 통과로 기록하지 않습니다. 기존 CI의 해당 PR commit 실제 Chromium 검사와 main→dist 검증은 별도로 확인합니다.

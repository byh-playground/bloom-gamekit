# 표현 이벤트 비용 측정

2026-10-10, dot cloud Linux, Node v24.19.0. 기준은 `812a6e`의 소스이며 같은 프로세스별 fixture를 전후 각각 7회 실행한 중앙값이다. 실제 WebGL 제출·GPU 시간·브라우저 FPS·모바일 성능 측정이 아니다.

## 유지한 변경

- 미확정 또는 실패 재시도 record의 Set만 확정/rollback에서 방문한다. 이미 확정된 장기 자원은 active Set이 update하고, GC 대상 tombstone은 별도로 관리한다.
- confirmed 종료 record를 최초 compact할 때 tick별 배열에 참조 하나만 넣는다. collect는 tick bucket을 확인하고 cutoff 이하 기록만 삭제한다. 정렬 heap이나 타이머를 추가하지 않았다.
- late emit의 start 실패도 재시도 Set에 넣는다. 확인 watermark를 다시 호출하는 retry와 cancelled speculative identity의 재개를 보존한다.
- 실패로 중단된 확정 중 이미 보관한 tombstone GC는 성공한 retry/명시적 collect까지 지연될 수 있다. 실패 도중 정확히 어떤 tombstone까지 삭제했는지는 계약으로 고정하지 않는다.

## 실측

`steady-benchmark.mjs`는 1,000 tick 동안 tick 확정 → 즉시 종료 hit 발행 → update를 반복한다. retentionTicks는 120이며 payload·renderer는 없다. 시간은 할당/GC 영향을 포함하는 CPU 경과시간이다. heap은 `--expose-gc`의 명시 GC 후 살아 있는 journal의 heap delta 중앙값이며 peak allocation이나 byte-정확한 객체 크기가 아니다.

| 매 tick hit | 총 hit | 기준 CPU ms | 변경 CPU ms | 기준 보유 heap bytes | 변경 보유 heap bytes |
|---:|---:|---:|---:|---:|---:|
| 1 | 1,000 | 6.325 | 2.642 | 37,864 | 69,608 |
| 200 | 200,000 | 551.360 | 111.637 | 7,223,992 | 7,462,120 |

희소 workload는 bucket 관리로 보유 heap이 약 31 KiB 증가한다. 조밀 workload는 CPU가 약 80% 감소하고 retained 24,000 identity에서 heap은 약 233 KiB(3.3%) 증가했다. 첫 별도 실행에서도 조밀 CPU 465→142 ms의 개선을 확인했으며 JIT/GC와 공유 실행 환경 때문에 절대값은 반복에 따라 달라진다. 메모리 공짜 최적화로 부르지 않는다.

기존 dense fixture도 20,000 hit를 누락 없이 재생하고, 600 idle update는 active Set만 방문하며 최종 확정으로 모든 tombstone을 수거한다. 변경 후 이 fixture는 emit/confirm 28.82 ms, idle update 0.31 ms였다.

## 재현

```sh
git show 812a6e:modules/presentation-events/index.js > /tmp/presentation-before.mjs
node --expose-gc modules/presentation-events/scripts/steady-benchmark.mjs /tmp/presentation-before.mjs
node --expose-gc modules/presentation-events/scripts/steady-benchmark.mjs
npm run benchmark:presentation
```

개발 중 임시 검증에서 기준/변경에 같은 50,000개 연산을 실행했다. late/duplicate emit, speculative 취소·재개, rollback, 시간 만료, 긴 자원, adapter start/stop/confirm/update/reconcile 실패를 포함하며 callback 순서·결과·retry 상태·명시적 collect 이후 journal을 대조했다. 내부 상태 단위 검증 파일은 남기지 않는다. 실제 DOM/WebGL 연속 통합 검증은 저장소의 고정 E2E가 담당한다.

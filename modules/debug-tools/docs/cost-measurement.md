# 로컬 profiler 비용 측정

2026-10-10, dot cloud Linux, Node v24.19.0. 기준 소스는 `812a6e`다. 실제 WebGL·GPU·브라우저 FPS 측정이 아니라 profiler 자체의 CPU/보유 heap fixture다. 프레임 duration과 stage duration은 fixture 값이며 이를 실제 게임 측정치로 해석하지 않는다.

## 변경과 계약

- capacity 초과마다 배열 앞부분을 splice하는 대신 고정 ring에 덮어쓴다. snapshot에서만 시간순 배열을 만든다.
- summary용 임시 값 배열을 한 번 정렬하여 min/max/p50/p95를 구한다. 기존 floor 방식의 percentile과 total 합산 순서는 보존한다.
- snapshot limit 0은 `slice(-0)`가 전체 배열을 반환하던 오류를 수정하여 frames를 비운다. summary는 기존대로 전체 retained 표본을 요약한다.
- counter도 stage와 별도로 maxStages개 이름까지 허용한다. 한도 이후 새 이름은 false, 기존 이름 누적은 계속된다. capacity만 작아도 한 프레임에 무제한 counter 이름을 넣을 수 있던 보유 비용을 제한한다.

## 측정 및 재현

아래 명령은 7회 중앙값을 출력한다. 100,000개의 빈 frame 기록과, 16개 stage가 있는 retained frame의 snapshot 500회를 capacity 30/1000 각각 측정한다. snapshot은 최근 30 sample만 복사해도 summary 때문에 전체 retained frame을 읽는다. `--expose-gc`가 없으면 heap 결과는 null이다. GC 후 heap delta는 peak allocation 측정이 아니며 작은 차이는 실행 잡음이다.

```sh
git show 812a6e:modules/debug-tools/index.js > /tmp/debug-before.mjs
node --expose-gc modules/debug-tools/scripts/benchmark.mjs /tmp/debug-before.mjs
node --expose-gc modules/debug-tools/scripts/benchmark.mjs
```

| 작업 | capacity | 기준 중앙 CPU ms | 변경 중앙 CPU ms |
|---|---:|---:|---:|
| frame 100,000개 | 30 | 37.746 | 24.106 |
| frame 100,000개 | 1000 | 399.986 | 19.910 |
| snapshot 500회 × 16 stages | 30 | 71.315 | 72.909 |
| snapshot 500회 × 16 stages | 1000 | 2295.704 | 1608.177 |

작은 snapshot은 이 실행에서 약 2% 느렸고 절대 차이는 500회에 1.6 ms다. 큰 snapshot은 약 30% 개선했다. 단독 초기 fixture의 frame 기록은 capacity 30에서 21.55→20.75 ms, capacity 1000에서 32.74→21.57 ms였다. 즉 JIT/fixture 순서/GC에 따른 절대 편차가 크므로 ring의 이득을 항상 20배라고 주장하지 않는다. 이득이 작은 기본 workload와 큰 workload를 함께 제시한다.

frame 기록 이후 live-heap delta는 capacity 30에서 8,080→7,576 bytes, capacity 1000에서 242,328→232,008 bytes였다. snapshot 호출 뒤 보유 heap 증가는 거의 0이지만 실행 중 임시 배열/객체 할당은 여전히 있다. zero-allocation API가 아니다.

개발 중 임시 검증으로 ring wrap의 시간순 sequence, clear 후 참조 해제, limit 0의 빈 sample/전체 summary, percentile 결과, counter 한도와 기존 이름 누적을 확인했다. 완료 후 해당 단위 검증 파일은 제거하며 실제 앱 연속 검증은 공용 고정 E2E가 담당한다.

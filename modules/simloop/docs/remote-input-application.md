# 원격 입력 적용: protocol 3

2026-10-13 Windows / Edge 실제 RTC·WebGL 검사. 사용자 요청에 따라 검증을 핵심 정합성으로 동결했다. 추가 정책 탐색·전체 조합 재실행은 하지 않았으며 최종 튜닝은 소비 게임에서 결정한다.

## 변경

protocol 2는 이벤트에서 후보 slot을 보내고 다음 capture에서 명령 실행 tick을 정했다. protocol 3은 이벤트에서 명령별 불변 T를 예약한다. capture·inputDelay 변경·재연결은 T를 바꾸지 않는다. 미래 T는 기다리고 지난 T는 수신 callback에서 기존 rollback 엔진으로 재실행한다. 게임은 reconciled 완료 이벤트에서 기존 PresentationRuntime과 PresentationEventQueue를 갱신한다. 새 시뮬레이터나 표현 엔진을 추가하지 않았다.

기본 configured 지연 정책과 고정 지연은 유지한다. inputScheduling:network는 선택 기능이다. safetyMargin 8ms / jitterMultiplier 2는 초기 값이며 실게임 권장값으로 확정하지 않았다. RTT/2 및 RTT 지터/2를 사용하고, 보고서 전송 시간과 앞으로 보낼 명령의 전송 시간을 구분한다. 수식 항·열린 slot·최종 T는 input-submitted.schedule에서 확인한다.

## 실제 검증

- room suite 94.682초 / 상한180초: 실제 RTC 2→5인 입장, 미확정 명령 handoff, 재연결, 게스트·코디네이터 새로고침, coordinator 교체, available 복구, 최종 hash 일치. 공유 예약 기록으로 최초 sequence:T와 모든 실행/재실행 tick이 같음을 검사했다.
- 대표 원격 suite 18.708초 / 상한180초: 5TPS/입력30Hz/렌더60Hz 및 15TPS/입력40Hz/렌더30Hz, 각8명령. 순서·중복 없음·최종 hash 일치. 별도9번째 명령에서 이벤트 직후 inputDelay를6으로 늘려도 최초 T 유지. 확정 패킷 재전송의 추가 rollback 0회와 hash 불변.
- 각 명령만 움직이는 독립 정지 표식의 WebGL readPixels 변화를 확인했다. held 이동은0이며 무변화 표본을 제외하지 않았다.
- 별도 browser context·focus emulation으로 두 클라이언트 visible/focused를 확인했다. 최대 RAF 간격23.7/36.5ms. 이전 단일 context 측정의 약1초 RAF 지연은 최종 수치에 사용하지 않았다.
- RTC clock 교환7회 중 가장 좁은 offset 구간을 전후 기록했다. 구간 폭0.7ms(중점오차±0.35ms), 전후 중점 차이 최대0.1ms. 수신→적용과 적용→픽셀은 수신자 시계만 사용한다.

| 조건 | 정상 수신→T 적용(각4개) | 늦은 수신→적용(각4개) | 늦은 적용→최초 픽셀 | rollback / replay tick |
|---|---:|---:|---:|---:|
| 5TPS, 고정 delay2 | 373.3–578.1ms | 0.2–0.5ms | 5.3–14.9ms | 4 / 6 |
| 15TPS, 고정 delay2 | 154.6–173.2ms | 0.1–0.6ms | 16.3–28.8ms | 4 / 5 |

정상 도착의 대기는 공유 T까지 기다리는 의도한 지연이다. 늦은 표본에는 각각700ms/233.3ms를 주입했으므로 4/8은 실제 rollback 빈도 추정치가 아니다. 작은 순수 함수 시뮬레이션의 receiver load+replay CPU 합계는 각각0.1/0.3ms이며 timer 해상도 한계가 있다. GPU 시간은 측정하지 않았다. readPixels나 RAF를 GPU 비용으로 해석하지 않는다.

## 이전 탐색과 한계

수식 수정 전 aggressive(0ms/0배), balanced(8ms/2배), conservative(40ms/3배)를 각8명령으로 탐색했을 때 late/rollback은1/0/0이었다. 당시 balanced에는 약994ms RAF 간격이 끼었고 지터·tick 반올림 수식도 이후 수정됐으므로 최종 성능 비교나 정책 추천의 근거로 쓰지 않는다. 이전55c6345/PR42 초기 측정도 RAF 영향을 받아 공정한 전후 개선율을 주장하지 않는다. 사용자 우선순위에 따라 최종3정책 재측정은 생략했다.

실게임 상태 크기의 replay CPU, 비대칭 WAN·장기 jitter, 모바일 background, 정책별 장기 분포와 체감은 미검증이다. 이전 전체 suite 결과를 이번 전체 통과로 주장하지 않는다. 대표 RTC·재연결 계약과 CI 독립 빌드/manifest를 배포 기준으로 사용한다.

## 최소 연결

```js
const profile = {
  ...profiles.action,
  inputScheduling: 'network', // 생략하면 기존 configured 정책
  inputSafetyMarginMs: 8,
  inputJitterMultiplier: 2,
};
const receipt = session.submitInput(heldBytes, { commands: [commandBytes] });
// receipt.commands의 sequence/executeTick은 예약 후 불변.
// rollback에서 journal.beginRollback(from), reconciled에서 endRollback()
// 및 기존 PresentationRuntime의 rollback publish를 연결한다.
```

프로토콜3 peer끼리 같은 dist SHA를 사용한다. 고정 지연은 기존 baseInputDelayTicks와 adaptiveInputDelay:false를 두고 inputScheduling을 생략한다.

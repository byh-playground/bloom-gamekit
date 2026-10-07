# 동적 방 세션 비용과 검증

2026-10-06 cloud Linux / Node v24.19.0에서 `node modules/rollback/scripts/benchmark-room-session.mjs`를 실행했습니다. 128 KiB canonical snapshot, 20 tick checkpoint, 64 tick 보관 창, 20,000 tick 단일 로컬 플레이, 입력 1바이트입니다. 워밍업 후 fixed Core와 RoomSession/local을 교대로 5회 측정했습니다. 네트워크·렌더·모바일·GPU 측정이 아닙니다.

- fixed Core 중앙값 6.65 μs/tick, 범위 6.25–9.17 μs/tick
- RoomSession/local 중앙값 8.52 μs/tick, 범위 6.79–9.11 μs/tick
- 이 짧은 CPU fixture의 중앙값 차이는 약 1.88 μs/tick입니다. 다른 게임이나 기기에 일반화하지 않습니다.
- 양쪽 모두 snapshot save 1,001회, 직렬화 131,203,072바이트, 보관 snapshot 655,360바이트로 동일합니다. 동적 wrapper 때문에 매 tick snapshot 복사를 다시 도입하지 않았습니다.

이는 정상 실행 비용만 비교합니다. membership 준비는 기존/후보 snapshot과 hash, 새 Core 초기 snapshot을 추가로 만들고, 신규 참가자가 sparse checkpoint 이후 확정 suffix를 catch-up합니다. refresh 복구에서는 가장 앞선 확정 peer가 donor이고 멈춘 참가자 모두가 같은 suffix로 복원합니다. 이 일회성 비용과 실제 RTC 전송량은 browser report의 별도 metrics로 측정합니다. Core의 snapshot metrics가 wrapper의 staging/codec/게임 자체 저장을 모두 포함한다고 해석하면 안 됩니다.

Node 연속 fixture는 1→2→5 입장, 65 tick 이후 늦은 합류, 명령 보존, RTC capability 교체, guest/coordinator reload의 같은 actor 유지, graceful coordinator 퇴장, partition fail-closed를 검사합니다. synthetic transport 결과를 실제 RTC 결과로 부르지 않습니다.

실제 RTC harness는 `node modules/rollback-netcode/scripts/dynamic-room-browser.mjs`이고 기존 `npm run test:browser`에 포함됩니다. signed local Nostr relay fixture와 Chromium의 실제 RTCPeerConnection을 사용합니다. 현재 cloud executor의 Chromium은 `socket() failed: Operation not permitted`로 시작되지 않았습니다. 로컬 실제 RTC는 미실행이며 GitHub CI의 해당 source commit 실행 결과를 별도로 확인해야 합니다. 공용 Nostr relay 또는 서로 다른 NAT/모바일 기기는 이 harness 범위가 아닙니다.

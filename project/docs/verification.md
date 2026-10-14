# 현재 검사 범위

모든 suite는 build를 먼저 실행하고 전체 180초 상한을 적용합니다. 브라우저는 실제 Chromium/Edge와 WebGL을 사용합니다. headless SwiftShader 결과는 모바일·하드웨어 GPU 성능 보증이 아닙니다.

| 명령 | 실제 범위 |
| --- | --- |
| npm test / test:browser | DOM 입력·보간·표시 frame·WebGL·HUD·context 복구·local preview 통합 |
| test:network | 실제 RTC·동적 방 |
| test:availability | 비활성·복귀·분할·coordinator 이관 |
| test:room | 방 실행 모드 + availability |
| test:execution | navigation·scenario 브라우저 |
| test:audio | 실제 Web Audio 재생·confirmed adapter |
| test:previews | 단일 HTML 9개 초기화·조작·오디오·WebGL·로컬 RTC |
| test:consumer | 별도 consumer 시나리오 |
| test:rollback-demo | 공식 예제 두 RoomSession·native RTC·10/30 TPS·rollback·명령·표시·연출 |
| test:rollback-live | 명시적으로 RUN_LIVE_ROOM_CHECK=1을 설정한 공용 relay 검사 |
| test:scenarios | core, execution, audio, network, availability, demo; 최대 2개 병렬 |

`test:scenarios`는 room·consumer·live 전체를 포함한다는 의미가 아닙니다. CI는 소스 전용 checkout, 독립 번들, manifest/bytes, 기존 버전 태그 충돌, HTML 프리뷰 build를 검사하고 main에서 dist/tag/previews를 게시합니다. 브라우저 E2E·TypeScript 전체 검사를 자동으로 실행한다고 주장하지 않습니다.

렌더링의 vector-context.browser.mjs와 vector-game-coverage.browser.mjs는 현재 runner가 호출하지 않는 보존 helper입니다. 전자는 VectorContext group/clip/dash/정적 mesh/context 복구, 후자는 게임 표현 계약의 silhouette/filter/radial-gradient/native painter 비교를 담습니다. 현재 device/mesh 시나리오와 겹치는 부분이 있으나 이 고유 범위를 확인했으므로 삭제하지 않았습니다. 존재만으로 해당 검증이 실행됐다고 보고하지 않습니다.

interpolation/tests/fixtures/worker-motion.json은 현재 runner가 읽지 않는 역사적 표본입니다. transport의 BIP-340 fixture와 provenance zip/manifest/source.json도 출처 보존 자료입니다. 과거 결과 문서의 명령·해시는 당시 실행 기록으로 보존하며 현재 검사 결과로 재사용하지 않습니다.

rollback은 공개 session 실행 API와 종합 예제, _rollback-shared는 실제 protocol/history 내부 공유 구현입니다. 호환 집계 진입점은 제거했으며 기능 소유 모듈에서 직접 import합니다.

# bloom-gamekit 작업 지침

- 공통 경계·설계·리뷰 기준은 [README](./README.md)를 먼저 읽습니다.
- 보간 변경은 [모듈 계약](./modules/interpolation/README.md), 공개 JSDoc, [고정 브라우저 시나리오](./tests/browser.e2e.mjs)를 함께 확인합니다. 시간·세대·순서·reset 계약을 임의로 바꾸지 않습니다.
- rendering/input 변경은 해당 modules/*/README.md와 tests/browser.e2e.mjs의 실제 WebGL·DOM 검증을 함께 확인합니다. 입력 edge는 명시적 tick 소비 전까지 유지하며 rendering에 게임 정렬·시간선·권위 상태를 넣지 않습니다.
- 새 기능은 실제 필요가 생긴 모듈에만 구현합니다. rendering/input placeholder나 범용 게임 엔진을 만들지 않습니다.
- `codex/` 작업 브랜치와 main 대상 Draft PR을 사용합니다. 다른 작업과 미커밋 변경을 보존하며 독립 병렬 수정은 별도 worktree를 사용합니다. 커밋·문서는 한국어를 기본으로 합니다.
- PR 본문에 의도·담당·상태·실제 검증과 미검증 범위를 문장으로 남깁니다. 별도 작업 계획 파일을 중복 관리하지 않습니다. 명시적 승인 없이 merge하지 않습니다.
- `npm ci && npm test`, `npm run test:browser`를 변경에 맞게 실행합니다. 실행하지 못한 환경은 명시하며 Node 통과를 실제 브라우저나 기기 검증으로 부르지 않습니다.
- 검증 정책 원본은 [공통 프로젝트 관리 규칙](https://github.com/byh-playground/bloom-reference/blob/main/rules/project-management.html#verification)입니다. 개발 중 단위 검증은 임시로만 수행하고 완료 시 실행 코드와 목록에서 제거합니다. 저장소에는 고정 사용자 시나리오 E2E만 남깁니다. `scripts/test-scenarios.mjs`는 한 실행 전체 180초 상한을 적용하며 벤치마크는 별도 명령입니다. 시간 초과·미실행 범위를 성공으로 보고하지 않습니다.
- dist는 생성물입니다. 소스 브랜치에 직접 커밋하지 않습니다. `.github/workflows/ci.yml`의 승인된 main→dist 배포 경계를 보존하고, PR에는 쓰기 권한을 주지 않습니다. 외부 fork를 신뢰하는 배포나 paid runner를 추가하지 않습니다.

# 기존 rollback-netcode 보존 자료

현재 구현·사용법은 [호환 모듈 README](../README.md), 실행 예제는 [examples](../examples/)를 따릅니다. 이 디렉터리는 최신 런타임을 복제하거나 과거 검사 결과를 현재 검증으로 제시하지 않습니다.

## 원본 스냅샷

[rollback-netcode-c317391-source.zip](rollback-netcode-c317391-source.zip)은 원본 저장소 `byh-playground/rollback-netcode`의 `c3173914519a78834360430071e7a125736d86d5` 시점 전체 54개 파일을 원래 바이트로 보존합니다. 소스·타입·README·CONTRACT·검증 기록·한국어 데모·검사/벤치마크 스크립트·CI와 기존 단일/해시 버전 배포 파일이 포함됩니다. 원본에 LICENSE가 없으므로 새 라이선스를 부여하지 않습니다.

[manifest.json](manifest.json)에 압축 파일 SHA-256, 개별 파일 SHA-256과 Git blob SHA를 기록했습니다. 압축 해제 후에도 해시로 출처를 확인할 수 있습니다. 압축 파일 내부 문서의 URL·경로·후보 상태·검사 수치는 그 시점의 역사적 기록이며, 오늘의 사용 안내나 온라인 서비스 가용성을 보장하지 않습니다.

- `README.md`: 원본 사용 예제와 개발 안내
- `docs/verification.md`: 당시 환경·실측·미검증 범위
- `index.html`, `scripts/`, `tests/`: 당시 데모·도구·회귀 fixture
- `rollback-netcode.js`: 해당 소스의 전체 배포 모듈
- `versions/e577f63fc8f5e88e55202afbb354aa3f50e95f8847d04987a77d0211488ff77a/rollback-netcode.js`: 기존 콘텐츠 해시 배포본

현재 예제·도구는 같은 모듈의 `examples/`, `scripts/`, `tests/`에 있으며 gamekit의 빌드 결과를 사용합니다. 옛 결과를 새 코드의 성능이나 동작 보증으로 재사용하지 마세요.

## 삭제 전 남는 경계

이 스냅샷은 Git 전체 이력이나 GitHub PR·이슈·리뷰·댓글·설정의 백업이 아닙니다. 저장소 제거 전에 그 보존 범위를 따로 확인해야 합니다. 기존 GitHub commit/raw/Pages URL과 `versions/` URL은 파일을 여기로 옮겨도 자동으로 새 위치에 연결되지 않습니다. 외부 사용자의 북마크·고정 import·다운로드 경로까지 모두 찾았다고 보장할 수 없습니다.

현재 gamekit 배포는 기존대로 `dist` 브랜치 루트의 JS 파일들과 `manifest.json`만 사용합니다. 이 역사 자료를 배포 브랜치에 추가하거나 옛 호스팅 설정을 옮기지 않습니다.

## 읽기 쉬운 역사 문서

- [기존 SDK 사용법](usage.md): 원본 README의 API 사용 예제·옵션·개발 안내
- [당시 검증 기록](verification.md): 원본 docs/verification.md의 환경·측정·미검증 범위

두 문서는 c317391 시점의 읽기용 사본이며 현재 계약이나 새 검증 결과가 아닙니다. 제목·역사 안내·문서 링크만 조정했으며 원본 바이트는 위 zip과 manifest에 보존합니다. 현재 사용법과 실행은 [모듈 README](../README.md)와 [실행 예제](../examples/index.html)를 따릅니다.

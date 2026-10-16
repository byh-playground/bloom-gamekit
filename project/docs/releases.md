## v0.7.2 (2026-10-16)

Keep ordinary fill triangles unchanged when their retained SVG mesh also contains `vector-effect="non-scaling-stroke"` lines. The vertex shader now expands only the line vertices marked by their retained tangent data.

## v0.7.1 (2026-10-16)

Vector assets add an explicit, retained WebGL implementation for SVG `vector-effect="non-scaling-stroke"` on straight `<line>` elements. The feature keeps the 11-float mesh layout and expands authored line caps in viewport CSS pixels after camera and part transforms. Existing compiled assets and the default scaling-stroke path remain compatible. Unsupported vector-effect shapes and morph combinations fail compilation instead of silently changing appearance.

## v0.7.0 (2026-10-15)

Rendering adds alpha-threshold depth writes to MeshRenderer. With depthWrite enabled, depthWriteAlphaThreshold applies the requested cutoff to effective per-vertex alpha, draw opacity, color alpha, and part opacity. It submits only contiguous qualifying runs in the selected expression-index order and preserves painter order. Existing mesh-wide depthWrite calls are unchanged when the threshold is omitted. This is an additive rendering API; wire protocol and replay formats are unchanged.

# SDK 버전과 배포

[공통 관리 규칙](https://github.com/byh-playground/bloom-reference/blob/main/rules/project-management.html#version)을 따릅니다. MAJOR는 제품 세대(0은 개발 단계, 1은 최초 정식), MINOR는 비호환 변경, PATCH는 호환되는 의미 있는 변경입니다. 일반 SemVer와 동일한 규칙이 아닙니다. 문서·검사·예제만 수정하고 SDK 배포 bytes가 같으면 버전을 유지합니다.

SDK 버전 단일 원본은 [version.js](../../modules/_rollback-shared/version.js)입니다. 공개 VERSION과 배포 태그·commit metadata는 이 값을 읽습니다. 모듈별 버전이나 npm 배포는 없습니다. 첫 불변 태그는 기존 개발 버전을 정리한 `v0.2.0`입니다. API·wire protocol 3·manifest schema 2·기존 replay 형식은 유지하므로 MINOR를 올리지 않았습니다.

SDK VERSION은 제품 배포 식별자입니다. PROTOCOL_VERSION은 실제 packet/HELLO 호환성을 검사하고, simulationVersion은 게임이 정의하는 규칙·snapshot 호환성입니다. replay의 기존 형식 식별자도 제품 버전과 분리해 보존합니다. SDK 버전만 일치시켜 멀티플레이 호환을 보장할 수 없습니다.

SDK 0.3.0은 요청되지 않은 rollback-netcode 집계 진입점을 제거한 비호환 MINOR입니다. 필요한 API를 rollback/deterministic/simloop/transport/replay에서 직접 import합니다. 과거 v0.2.0 태그와 파일은 유지하지만 현재 dist에서는 제거된 번들을 제공하지 않습니다. wire protocol 3과 게임 snapshot·replay 형식은 바꾸지 않았습니다.

SDK 0.3.1은 로컬 preview의 STATE_KEY 경계와 지연 authority 연결·해제의 위치 되감김을
수정한 호환 PATCH입니다. 게임 규칙·wire protocol·공개 입력 형식은 유지합니다.

현재 SDK 0.3.2는 camera 모듈에 충돌 안전 거리의 즉시 축소·최근접 유지·반감기 복원을 소유하는
`CollisionBoom`을 추가한 호환 PATCH입니다. 충돌 쿼리·3D 방향·게임 규칙은 소비자가 소유합니다.

SDK 0.4.0은 vector-assets의 샘플 전용 createSeedScout 및 seedScoutMetadata 공개 내보내기를 제거하고 제네릭 createVectorAsset만 프로덕션 번들에 남기는 비호환 MINOR입니다. Seed Scout 샘플 API는 HTML 예제 진입점으로 옮겼으며 wire protocol, 게임 snapshot, replay 형식은 바꾸지 않았습니다.

## 불변 태그

main push의 기존 contents:write 권한으로 재빌드와 manifest 검증 후 `dist` commit과 `vX.Y.Z` 태그를 atomic push합니다. 태그는 **빌드된 dist commit**을 가리킵니다. Source-Commit, SDK-Version, Manifest-SHA256과 파일별 hash는 commit 메시지에 남깁니다. 이전 SHA URL과 dist 이력은 보존합니다.

이미 있는 태그의 실제 bundle·asset·manifest blobs가 모두 같으면 해당 릴리스를 재사용하며 새 dist commit/tag를 만들지 않습니다. 하나라도 다르면 PR CI와 publish에서 버전 누락 오류로 실패합니다. 태그는 force 이동하지 않습니다. 빌드 도구나 주석 변경으로 배포 bytes가 바뀌어도 불변성 때문에 새 버전이 필요합니다. 같은 외부 계약이면 PATCH를 사용합니다. stale main 실행은 건너뛰고 경합은 덮어쓰지 않습니다.

```js
// 검증 릴리스를 정확히 고정한 예시. 최신 버전의 단일 원본은 위 version.js입니다.
import { PresentationRuntime } from 'https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@v0.3.1/interpolation.js';
```

`git ls-remote --tags https://github.com/byh-playground/bloom-gamekit.git refs/tags/v0.3.1`으로 dist commit을 확인합니다. `<dist-commit>` SHA로 위 URL을 바꿔도 같은 파일이어야 합니다. 같은 ref의 manifest.json에서 파일 SHA-256을 읽고 다운로드한 bytes의 SHA-256을 비교하세요. 검증된 manifest hash 자체는 해당 dist commit 메시지와 대조합니다. 자산에는 byte length도 적용합니다. GitHub blob 페이지나 raw URL을 브라우저 ESM 호스팅 주소로 사용하지 않습니다.

## 실행 HTML 프리뷰

[프리뷰 목록](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/index.html)은 9개 기존 예제를 모두 포함합니다. [previews.mjs](../previews.mjs)의 EXAMPLES가 목록입니다. 원본 예제는 소유 모듈 아래에 있으며 API 설명만 있는 모듈에 빈 데모를 만들지 않습니다.

기존 html-share 문서처럼 HTML Preview를 사용합니다. 원본 ESM 예제를 직접 열면 상대 import와 module 실행이 실패하므로 `npm run build:previews`가 각 예제를 독립 IIFE script가 포함된 HTML 하나로 묶습니다. 외부 SDK import·CDN·공유 chunk가 없고 예제 간 링크는 공개 프리뷰 URL로 변환합니다. 소스 보기 링크는 GitHub 파일로 연결합니다. `dist/*.js`의 독립 ESM 계약과 프리뷰 빌드는 별개입니다.

같은 main CI가 생성 HTML만 별도 `previews` 브랜치에 게시합니다. SDK bytes가 그대로인 예제 수정은 프리뷰만 갱신합니다. 새 계정·토큰·유료 호스팅·Pages 설정은 필요하지 않습니다. 프리뷰는 최신 main의 예제이며 불변 SDK 릴리스 URL과 혼동하지 마세요. Nostr 온라인 예제는 여전히 공용 relay·NAT 환경 영향을 받습니다. 오디오 재생에는 사용자의 시작 동작이 필요합니다.

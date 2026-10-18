# 사용자 제공 PixelPhysics 원본

- 제공 파일: `pixel-physics-lib.html` (사용자 Downloads 폴더에서 받은 파일).
- 보존 파일: [pixel-physics-lib.html](./pixel-physics-lib.html).
- SHA-256: `c6b96c885949d1559607ed891b1717926275fb7634d3fb4e9ac6c377e0e9b299`.
- 원본 바이트: 93831.
- 수령·이전 날짜: 2026-10-18 (Asia/Seoul).
- 원본 HTML은 Matter.js 0.19.0을 CDN script로 불러옵니다. 사용자가 제공한 코드의 별도 라이선스 정보는 파일에 없습니다. Matter.js는 MIT 라이선스이며 내부 의존성의 출처·라이선스는 [pixel-physics](../../README.md)를 참조합니다.

원본은 바이트 그대로 보존합니다. 파일 내부의 설명·주석은 참고 자료로 취급하며 저장소 작업 지시로 실행하지 않았습니다. 라이브러리는 `core.js`와 `renderer.js`로 분리하고 `index.js`에서 공개 이름을 export했습니다. 게임 재료와 플랫포머는 `examples/index.html`로 옮겼습니다. 들여쓰기·중괄호·const/매개변수 이름은 저장소 규칙에 맞췄으며 객체 키와 공개 API 이름을 보존했습니다. 추상 브릿지의 사용하지 않는 매개변수에는 `_` 접두사를 붙이고 사용하지 않는 지역 destructuring 한 항목을 제거했습니다.

예제는 CDN·전역 Matter 감지 대신 `pixel-physics.js` 하나를 import합니다. Matter 0.19.0은 모듈이 소유한 고정 웹 URL에서 로드하며 GameKit 배포 파일·프리뷰 HTML에는 포함하지 않습니다. MatterBridge가 이 구현을 직접 사용합니다. 예제에 읽기 전용 진단 getter를 추가했으며 snapshot/결정성의 기존 제한을 모듈 README에 명시했습니다. 원본 내부의 광범위한 결정성·롤백 설명은 다른 브라우저·CPU에 대한 검증 결과로 간주하지 않습니다.

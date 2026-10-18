# 코드 규칙

[공통 개발 규칙](https://github.com/byh-playground/bloom-reference/blob/main/rules/development.html)과 이 저장소의 모듈 경계·공개 계약을 함께 적용합니다. Prettier는 표현 형식, ESLint는 바인딩 이름과 오류·의존성 경계를 검사합니다.

## 명령

- `npm run format`: 작성한 소스·문서의 형식을 수정합니다.
- `npm run format:check`: 형식 차이를 검사하고 파일을 수정하지 않습니다.
- `npm run lint`: JavaScript와 HTML의 inline script를 검사하고 파일을 수정하지 않습니다.
- `npm run check`: 형식과 lint를 함께 검사합니다.
- `npm run build`: `prebuild`에서 같은 검사를 통과한 뒤 독립 모듈을 빌드합니다. 기존 CI의 검사·재빌드 모두 이 경로를 사용합니다.

검사 실패를 CI에서 자동 수정하거나 규칙 전체를 끄지 않습니다. Node 22.13 이상 또는 24 이상을 사용합니다. 도구 버전은 lockfile로 고정합니다. `dist`, 의존 패키지, 생성 코드, 검사 결과, 폰트 산출물과 보존 provenance 자료는 작성 코드 검사의 대상이 아닙니다.

## 형식과 이름

- 공백 4칸, 세미콜론, 작은따옴표, 가능한 trailing comma, 폭 120을 기본으로 합니다.
- 조건·반복문은 항상 중괄호를 사용하고 한 줄에 실행문 하나만 둡니다.
- 재할당하지 않는 바인딩은 `const`, 재할당하는 바인딩은 `let`을 사용하며 `var`는 사용하지 않습니다.
- 모든 `const` 바인딩은 지역 참조·함수 값·구조 분해 alias를 포함해 UPPER_SNAKE_CASE로 씁니다.
- `let`, 매개변수와 함수 선언은 camelCase, 클래스 선언은 PascalCase로 씁니다. 사용하지 않는 callback 매개변수는 `_name`으로 표시합니다.
- 소유한 속성·메서드는 camelCase를 기본으로 합니다. 외부 API·프로토콜 키·기존 공개 이름을 스타일 변경으로 바꾸지 않습니다.
- import 이름은 원래 API를 유지합니다. const 바인딩 변경 시 공개 export 이름을 alias로 보존하고 객체 shorthand와 구조 분해는 원래 속성 키를 유지합니다.
- 일반 재사용 함수는 이름 있는 선언을, 짧은 callback은 화살표 함수를 우선하되 `this`, `arguments`, 생성자·호이스팅 의미를 바꾸는 일괄 변환은 하지 않습니다.
- 조건을 단순하게 만들 수 있으면 조기 반환을 사용합니다. 단순한 형식 정리에서 흐름을 다시 작성하지 않습니다.

초기화·정리 callback이 최초 할당 전의 `undefined` 상태를 읽을 수 있도록 의도적으로 선언을 분리한 바인딩은 `let`을 유지합니다. `prefer-const`의 `ignoreReadBeforeAssign`은 이 경우의 TDZ 의미 변경을 방지합니다. 객체 rest에서 특정 키를 제외하기 위한 구조 분해 바인딩은 `ignoreRestSiblings`로 허용합니다. 그 외 사용하지 않는 변수·import·함수는 오류입니다.

## 오류와 경계

- `eqeqeq`를 적용하되 `value == null` / `value != null`의 nullish 검사만 허용합니다.
- 도달 불가 코드, 중복 클래스 멤버, 잘못된 `super`, 설명 없는 빈 catch를 오류로 처리합니다.
- 의도적으로 실패를 격리하는 catch는 이유를 적습니다. 기존의 실패 전달·자원 정리 계약을 스타일 작업에서 바꾸지 않습니다.
- 불가피한 개별 규칙 예외는 해당 줄과 이유에 한정하며 사용하지 않는 disable 지시도 오류입니다.
- `eslint.config.js`의 `CORE_FILES`는 순수 runtime 소유자만 명시합니다. 이 파일에서 DOM·localStorage와 rendering/HUD/navigation/DOM/storage adapter import를 금지합니다. 동적 import와 require도 같은 경계를 검사합니다.
- rendering, input DOM, audio, navigation, transport/session의 persistence, 브라우저 예제는 실제 adapter이므로 순수 core 규칙을 무차별 적용하지 않습니다. simloop의 loop는 visibility/rAF adapter이며 deadline·rate·input-preview는 순수 core 검사 대상입니다.
- 빌드의 모듈별 소스·dependency 허용 목록을 유지합니다. PixelPhysics는 소유 모듈에 선언한 Matter 웹 URL import만 허용하며, 나머지는 외부 import 없는 단일 bundle을 검사합니다.

## 생성 코드와 검증

원본 SVG와 의미 있는 공유 컴파일러를 유지하며 생성 geometry를 작성 소스 규칙의 예외를 피하는 우회 수단으로 사용하지 않습니다. GameKit의 vector compiler와 정식 dist 생성은 유효한 배포 경로이므로 소비자 게임의 SVG 포장 금지 규칙을 그대로 복사하지 않습니다.

스타일 변경은 공개 export·객체 키·클래스 이름·함수 의미를 보존하고 기존 시나리오로 검증합니다. 개발 중 AST 비교나 규칙 집중 검사는 임시로 실행하며 영구 단위 테스트 모음을 추가하지 않습니다. 기존 `npm test`, `npm run test:browser`와 변경에 해당하는 고정 브라우저 시나리오를 사용합니다. 실제 브라우저 미실행을 정적 검사 통과로 대신하지 않습니다.

생성 bytes가 바뀌는 경우 [불변 배포 규칙](./releases.md)에 따라 새 PATCH가 필요합니다. 이전 태그를 이동하거나 다른 게임의 고정 SDK 버전을 자동 갱신하지 않습니다.

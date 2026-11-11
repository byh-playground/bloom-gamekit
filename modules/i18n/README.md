# i18n

## 언제 쓰나

- 페이지 언어를 읽을 때 한 번 정하고(`?lang=` → 저장한 선택 → 브라우저 언어 → `fallback`), 화면 문구를 여러 언어로 내고 싶을 때. 문구는 키 사전 대신 모든 언어를 한 객체에 나란히 둔 TextPair입니다.

## 쓰는 모양

```js
// bloom-takraw/src/i18n/locale.js
import { createLocale } from '@bloom-gamekit/i18n';
const query = new URLSearchParams(location.search);
const LOCALE = createLocale({
    locales: ['ko', 'en'],
    fallback: 'en',
    storageKey: 'bloom-takraw-locale',
    isolated: query.get('showcaseDemo') === '1' || query.has('debug'), // 시연·디버그는 저장값을 읽거나 쓰지 않음
});
```

## 쓰지 말아야 할 때

| 이런 일                       | 대신                                    |
| ----------------------------- | --------------------------------------- |
| 실행 중 언어를 바꿔 다시 번역 | 경로가 없습니다. 저장 후 새로고침합니다 |
| 번역 키 사전 파일             | 쓰지 않습니다. 문구는 TextPair로 둡니다 |

## 상세

페이지 언어 결정과 화면 문구를 맡는 순수 ESM 모듈입니다. 문구 원본은 TextPair로, 모든 지원 언어를 한 객체에 나란히 둡니다. 번역 사전 파일과 키 문자열이 따로 없습니다. 언어는 페이지를 읽을 때 한 번 정합니다. 바꾸면 저장한 뒤 새로고침하므로 실행 중 다시 번역하는 경로가 없습니다.

```js
import { createLocale } from '@bloom-gamekit/i18n';

// 게임에 한 곳(src/i18n.js)
export const LOCALE = createLocale({
    locales: ['ko', 'en'],
    fallback: 'en',
    storageKey: 'bloom-takraw:locale',
    isolated: new URLSearchParams(location.search).has('debug'), // 디버그 장면·소개영상 iframe·시험
});

// 화면 문구: 정의할 때 모든 짝을 검사합니다.
export const CLUB = LOCALE.messages({
    title: { ko: '팀 관리', en: 'Team' },
    drawJoined: { ko: ({ name }) => `${name} 선수가 팀에 합류했어요.`, en: ({ name }) => `${name} joined the team.` },
});
CLUB.drawJoined({ name: card.name });

// 모델·설정 데이터는 TextPair를 그대로 두고 화면에서 풉니다(데이터 파일은 이 모듈을 import하지 않아도 됩니다).
const CHAPTER = { id: 'serve', title: { ko: '서브', en: 'Serve' } };
LOCALE.text(CHAPTER.title);

// index.html 정적 문구: <b data-i18n="start"></b>, <button data-i18n-aria-label="close">
LOCALE.applyPage(document, PAGE);

LOCALE.number(1234); // '1,234'
LOCALE.plural(count, { one: 'sprout', other: 'sprouts' });
LOCALE.choose('en'); // 저장 → ?lang=en으로 새로고침
```

## 계약

- **언어 결정**: `?lang=`(`param`) → 저장한 선택(`localStorage[storageKey]`) → 브라우저 언어 중 처음 맞는 것(`ko-KR` → `ko`) → `fallback` 순서입니다. 순수 함수 `resolveLocale`로도 씁니다.
- **동기**: 첫 문구를 그리기 전에 언어가 정해져야 하므로 저장은 동기 `localStorage`입니다. gamekit `save`(비동기·schema·revision)를 거치지 않습니다. 읽기나 쓰기가 거부되면 저장한 선택이 없는 것으로 보고, `choose`는 `?lang=` 주소만으로 이번 방문을 바꿉니다.
- **격리**: `isolated: true`이면 저장한 선택을 읽지도 쓰지도 않습니다. `?lang=`과 브라우저 언어만 봅니다.
- **TextPair**: 키 집합이 지원 언어와 정확히 같고 값이 문자열이나 함수여야 합니다. 함수는 이름 있는 값 객체 하나를 받습니다. 언어마다 어순·조사·복수형을 직접 씁니다.
- **오류는 바로 냅니다**: 짝이 하나라도 빠졌거나 언어가 남으면 `messages()`가 정의하는 순간 던집니다. 표에 없는 키를 읽으면 호출 전에 던집니다. `applyPage`도 표에 없는 `data-i18n` 키에서 던집니다. 다른 언어 문구나 키 이름으로 조용히 대체하지 않습니다.
- `applyPage`는 textContent를 통째로 바꿉니다. 자식 요소가 없는 말단 요소에만 붙입니다(아이콘·숫자와 섞이면 `<span>`으로 감쌉니다).
- 숫자·복수형은 `Intl.NumberFormat`·`Intl.PluralRules`(페이지 언어)를 씁니다.

## 잘 알려진 라이브러리 대신 쓰는 이유

i18next와 비교했습니다. 플러그인·별도 도구로 되는 것(브라우저 언어 감지, 하드코딩 문자열 lint, 복수형)은 이유로 세지 않습니다.

- **키 오타·번역 누락이 조용히 새지 않습니다.** i18next는 없는 키를 키 문자열 그대로 보여 주고, 빠진 번역은 fallback 언어 문구로 바꿔 보여 줍니다. 이 모듈은 정의 시점(짝 누락)이나 읽는 시점(키 오타)에 던집니다. 소비 게임은 TypeScript 없는 번들러 없는 JS라 타입으로 잡을 수도 없습니다.
- **문장 전체를 언어별 함수가 가집니다.** `{{name}}` 보간 대신 언어마다 함수가 문장을 만듭니다. 그래서 이름에 따라 조사(이/가, 을/를)를 고르거나 어순을 바꾸는 데 포매터 등록이 필요 없습니다.
- **외부 의존성이 없습니다.** import map에 CDN 핀을 하나 더 두지 않고 gamekit manifest·dist commit 고정을 그대로 씁니다.

## 범위

언어 2개(ko·en) 기준입니다. 번역 관리 도구용 내보내기(JSON 등)와 실행 중 언어 전환은 없습니다. 언어가 크게 늘고 외부 번역 도구가 필요해지면 다시 판단합니다. 한글 리터럴 검사는 각 게임의 검사(eslint·check 스크립트)가 맡습니다.

[고정 브라우저 시나리오](./tests/i18n.e2e.mjs)는 실제 Chromium에서 언어 결정 순서, 격리 장면의 저장 미사용, `choose`의 저장과 새로고침, 짝 누락·키 오타 오류, 정적 문구 적용, 숫자·복수형을 확인합니다.

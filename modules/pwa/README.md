# pwa

게임을 설치 가능한 PWA로 만들고, 첫 방문 뒤에는 오프라인으로 시작하게 합니다. 두 부분입니다.

- `dist/pwa-build.mjs` (Node ESM): 게임 저장소에서 로컬로 실행하는 생성기입니다. SVG 원본과 설정 하나에서 `manifest.webmanifest`, 아이콘(192·512·maskable·apple-touch-icon), 공유 이미지(1200×630), `sw.js`, `<head>` 태그를 만듭니다. 대부분의 게임은 빌드 단계 없이 GitHub Pages로 저장소를 그대로 서비스하므로 **생성 결과를 게임 저장소에 커밋합니다.**
- `dist/pwa.js` (브라우저): `registerPwa`가 sw.js를 등록하고 설치·업데이트 알림을 게임에 넘깁니다.

sw.js와 manifest는 게임 origin에서 서비스되어야 하므로 CDN에서 가져올 수 없습니다. 생성기가 게임 폴더에 씁니다.

## 게임 코드

```js
// scripts/pwa.mjs — `node scripts/pwa.mjs`로 생성, `node scripts/pwa.mjs --check`로 커밋된 결과 확인
import { chromium } from 'playwright';
import { buildPwa } from './vendor/gamekit/pwa-build.mjs'; // dist commit에 고정해 내려받은 파일

await buildPwa({
    chromium,
    name: 'Yarn Mayhem',
    shortName: '털실',
    description: '털실 뭉치를 굴려 길을 여는 퍼즐',
    lang: 'ko',
    icon: 'assets/icon.svg',
    maskableIcon: 'assets/icon-maskable.svg', // 생략하면 icon을 안전 영역(80%)에 넣고 backgroundColor로 채웁니다
    share: 'assets/share.svg',
    themeColor: '#16303a',
    backgroundColor: '#16303a',
    startUrl: './',
    scope: './',
    siteUrl: 'https://byh-playground.github.io/yarn-mayhem/',
    html: 'index.html',
    precache: ['index.html', 'src/**', 'assets/**'],
    out: '.',
    check: process.argv.includes('--check'),
});
```

```html
<head>
    <meta charset="utf-8" />
    <!-- bloom-pwa:start -->
    <!-- bloom-pwa:end -->
</head>
```

```js
// 게임 runtime
import { registerPwa } from 'https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<distCommit>/pwa.js';

const PWA = registerPwa({
    serviceWorker: './sw.js',
    onUpdate: () => showReloadNotice(() => PWA.update()), // 새 버전이 기다림. update()가 활성화하고 다시 읽음
    onError: (error) => showNotice(error.message),
    onInstallable: () => showInstallButton(() => PWA.install()), // 선택
});
```

생성기는 `npx playwright`가 이미 있는 게임의 `chromium`을 받아 SVG를 그립니다. 이 모듈은 게임의 node_modules를 스스로 찾지 않고, sharp·resvg 같은 새 의존성도 없습니다. `pwa-build.mjs`는 브라우저 번들과 같은 dist commit에 고정해 `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<distCommit>/pwa-build.mjs`에서 내려받습니다(manifest.json에 SHA-256이 있습니다).

## 생성기 계약

- **실패를 숨기지 않습니다.** 모르는 옵션, 빠진 필수값, `#rrggbb`가 아닌 색, viewBox가 없거나 비율이 틀린 SVG(icon·maskableIcon은 정사각형, share는 1200:630), 외부 파일을 참조하는 SVG, 아무 파일도 고르지 못한 precache 패턴, out 밖의 파일, 마커가 없거나 둘 이상인 html은 모두 던집니다. 기본값으로 바꿔 진행하지 않습니다.
- 경로는 모두 현재 작업 폴더(게임 루트) 기준입니다. `out`은 서비스되는 루트이며 sw.js·manifest·`pwa/*.png`가 여기에 생깁니다. html과 precache 파일은 out 안에 있어야 합니다.
- `<head>` 태그는 `<!-- bloom-pwa:start -->`와 `<!-- bloom-pwa:end -->` 사이에만 씁니다. 마커 줄의 들여쓰기와 파일의 줄바꿈을 따릅니다. 마커 밖에 manifest·icon·apple-touch-icon 링크나 theme-color·description·og:\*·twitter:\* 메타가 있으면 어느 쪽이 쓰일지 모르므로 지우라고 던집니다(기존 `theme-color`는 옮겨야 합니다).
- 쓰는 태그: manifest, theme-color, description, 192 PNG 아이콘, apple-touch-icon, apple-mobile-web-app-title, og:type·url·title·description·image(+크기), twitter:card. og:image·og:url은 공유 서비스가 상대 주소를 읽지 않으므로 `siteUrl` 기준 절대 주소입니다.
- manifest의 `display`는 `standalone`, `id`는 `startUrl`입니다.
- **결정론:** 같은 입력과 같은 Playwright Chromium(게임의 `playwright` 1.63.0)이면 같은 bytes를 씁니다. 바뀐 파일만 쓰므로 다시 실행해도 diff가 없습니다. 텍스트 파일은 줄바꿈(CRLF/LF) 차이를 같은 내용으로 봅니다. PNG는 Chromium 빌드·OS의 그리기 차이에 따라 다를 수 있습니다.
- `check: true`는 아무것도 쓰지 않고, 바뀔 파일이 있으면 그 목록과 함께 던집니다. 반환값은 `{ files, changed }`(out 기준 경로)입니다.
- precache 패턴은 `*`(한 폴더 안)와 `**`(여러 폴더)만 지원합니다. `node_modules`와 점(.)으로 시작하는 폴더는 걷지 않습니다. html과 startUrl이 가리키는 파일은 반드시 precache에 들어가야 하며, sw.js는 넣을 수 없습니다. 생성한 manifest와 아이콘은 자동으로 들어갑니다(공유 이미지는 넣지 않습니다).
- precache한 텍스트 파일에 있는 커밋 고정 gamekit 주소(`https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<40자 commit>/…`)도 precache합니다. 코드에서 문자열을 이어 붙여 만든 주소는 찾지 못하며, 그런 주소는 처음 받을 때 runtime cache에 들어갑니다.

## service worker 계약

- 설치 때 precache 목록을 받아 둡니다(같은 origin 파일은 HTTP cache를 거치지 않음). 첫 방문 뒤에는 오프라인으로 시작합니다.
- 캐시 이름은 `bloom-pwa:<scope 경로>:<precache 내용 hash>`입니다. 배포가 precache 파일 하나라도 바꾸면 sw.js가 달라져 새 worker가 설치되고, 게임이 `PWA.update()`를 부를 때까지 기다립니다. 새 worker가 활성화되면 같은 scope의 이전 캐시를 지웁니다. 같은 origin의 다른 게임(GitHub Pages의 다른 경로)의 캐시는 건드리지 않습니다.
- 같은 origin 요청은 precache에서 먼저 찾고 없으면 네트워크로 보냅니다. 페이지 이동은 주소의 query를 무시하고(`?debug=1`도 같은 html), `/`로 끝나는 주소는 그 폴더의 `index.html`로 찾습니다.
- 커밋에 고정된 gamekit 주소는 바뀌지 않으므로 cache-first입니다(`…:gamekit` runtime cache). 그 밖의 cross-origin 요청(relay·광고·`pixel-physics`의 Matter 주소 등)은 캐시하지 않습니다. 따라서 그런 주소가 시작에 필요한 게임은 오프라인으로 시작하지 못합니다.
- localStorage·IndexedDB는 다루지 않습니다. 저장은 게임과 [save](../save/README.md)의 일입니다.

## runtime 계약

- `registerPwa`는 `serviceWorker`·`onUpdate`·`onError`를 반드시 받습니다. 등록·설치 실패와 service worker를 쓸 수 없는 페이지(http 주소, 일부 사생활 보호 모드, service worker를 막은 자동화 브라우저)는 `onError`로 알립니다. 게임이 알릴지 정합니다.
- `onUpdate`는 이미 페이지를 제어하는 worker가 있을 때 새 worker가 설치되어 기다리면 한 번 부릅니다. 첫 설치에는 부르지 않습니다.
- `update()`는 기다리는 worker에 활성화 메시지를 보내고, 그 worker가 페이지를 넘겨받으면 `location.reload()`합니다. 기다리는 worker가 없으면 던집니다.
- `installable`은 `beforeinstallprompt`를 받은 뒤에만 true입니다. 브라우저 기본 배너는 막고, 게임이 `install()`로 설치 창을 띄웁니다. 결과는 `'accepted'` 또는 `'dismissed'`이고 설치 창은 한 번만 쓸 수 있습니다.
- `dispose()`는 구독만 끊고 등록된 worker는 그대로 둡니다.

## 격리 장면

`?debug` 디버그 장면이나 소개 데모처럼 격리된 장면에서 `registerPwa`를 부를지는 게임이 정합니다. 모듈은 주소를 보고 예외를 두지 않습니다. 이미 등록된 worker는 같은 scope의 모든 페이지 요청을 precache로 처리하므로, 격리 장면도 precache된 파일로 열립니다.

## 범위

예제 탭은 두지 않았습니다. service worker는 페이지와 같은 origin의 파일이어야 해서 htmlpreview 프리뷰에서 실행할 수 없습니다. 실제 동작은 [고정 브라우저 시나리오](./tests/pwa.e2e.mjs)가 확인합니다: 샘플 SVG로 임시 폴더에 생성 → manifest 필드·PNG 크기 → 두 번째 실행 무변경·check 통과 → 원본 변경 시 check 실패 → 실제 Chromium에서 설치·오프라인 시작(`context.setOffline`) → precache 파일 변경 후 재생성 → 기다리는 worker·`onUpdate` → `update()`로 새 버전 다시 읽기·이전 캐시 삭제. 실기기·iOS Safari·실제 설치 창은 확인하지 못했습니다.

# pwa

게임을 설치 가능한 PWA로 만듭니다. **페이지를 읽을 때(새로고침 포함)마다 항상 최신 버전이 열리고**, 오프라인이면 마지막으로 읽은 버전이 열립니다. 백그라운드 다운로드·대기 worker·업데이트 알림은 없습니다. 두 부분입니다.

- `dist/pwa-build.mjs` (Node ESM): 게임 저장소에서 로컬로 실행하는 생성기입니다. SVG 원본과 설정 하나에서 `manifest.webmanifest`, 아이콘(192·512·maskable·apple-touch-icon), 공유 이미지(1200×630), `sw.js`, `<head>` 태그를 만듭니다. 대부분의 게임은 빌드 단계 없이 GitHub Pages로 저장소를 그대로 서비스하므로 **생성 결과를 게임 저장소에 커밋합니다.**
- `dist/pwa.js` (브라우저): `registerPwa`가 sw.js를 등록하고 설치 창을 게임에 넘깁니다.

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
    onError: (error) => showNotice(error.message),
    onInstallable: () => showInstallButton(() => PWA.install()), // 선택
});

// "업데이트 확인" 버튼 = 저장한 뒤 다시 읽기. 다시 읽은 페이지가 최신 배포본입니다.
async function checkForUpdate() {
    await saveGame(); // 실패하면 다시 읽지 않습니다
    location.reload();
}
```

생성기는 `npx playwright`가 이미 있는 게임의 `chromium`을 받아 SVG를 그립니다. 이 모듈은 게임의 node_modules를 스스로 찾지 않고, sharp·resvg 같은 새 의존성도 없습니다. `pwa-build.mjs`는 브라우저 번들과 같은 dist commit에 고정해 `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<distCommit>/pwa-build.mjs`에서 내려받습니다(manifest.json에 SHA-256이 있습니다).

## 생성기 계약

- **실패를 숨기지 않습니다.** 모르는 옵션(예전 `precache` 포함), 빠진 필수값, `#rrggbb`가 아닌 색, viewBox가 없거나 비율이 틀린 SVG(icon·maskableIcon은 정사각형, share는 1200:630), 외부 파일을 참조하는 SVG, out 밖의 html, 마커가 없거나 둘 이상인 html은 모두 던집니다. 기본값으로 바꿔 진행하지 않습니다.
- 경로는 모두 현재 작업 폴더(게임 루트) 기준입니다. `out`은 서비스되는 루트이며 sw.js·manifest·`pwa/*.png`가 여기에 생깁니다. html은 out 안에 있어야 합니다.
- `<head>` 태그는 `<!-- bloom-pwa:start -->`와 `<!-- bloom-pwa:end -->` 사이에만 씁니다. 마커 줄의 들여쓰기와 파일의 줄바꿈을 따릅니다. 마커 밖에 manifest·icon·apple-touch-icon 링크나 theme-color·description·og:\*·twitter:\* 메타가 있으면 어느 쪽이 쓰일지 모르므로 지우라고 던집니다(기존 `theme-color`는 옮겨야 합니다).
- 쓰는 태그: manifest, theme-color, description, 192 PNG 아이콘, apple-touch-icon, apple-mobile-web-app-title, og:type·url·title·description·image(+크기), twitter:card. og:image·og:url은 공유 서비스가 상대 주소를 읽지 않으므로 `siteUrl` 기준 절대 주소입니다.
- manifest의 `display`는 `standalone`, `id`는 `startUrl`입니다.
- **결정론:** 같은 입력과 같은 Playwright Chromium(게임의 `playwright` 1.63.0)이면 같은 bytes를 씁니다. 바뀐 파일만 쓰므로 다시 실행해도 diff가 없습니다. 텍스트 파일은 줄바꿈(CRLF/LF) 차이를 같은 내용으로 봅니다. PNG는 Chromium 빌드·OS의 그리기 차이에 따라 다를 수 있습니다.
- `check: true`는 아무것도 쓰지 않고, 바뀔 파일이 있으면 그 목록과 함께 던집니다. 반환값은 `{ files, changed }`(out 기준 경로)입니다.
- sw.js는 게임 파일의 목록·내용과 무관한 고정 코드입니다. 게임 파일만 바꾼 배포는 생성기를 다시 실행할 필요가 없고 `check`도 통과합니다. sw.js는 생성기(gamekit pin)를 올릴 때만 바뀝니다.

## service worker 계약

```
install:  아무것도 받지 않음 → skipWaiting()
activate: clients.claim(); 같은 scope의 이전 캐시 삭제(이전 precache 캐시 포함)
fetch(같은 origin GET):
  온라인 → fetch(request, { cache: 'no-cache' })   // 매번 서버에 재확인(GitHub Pages max-age=600 동안 이전 파일이 섞이지 않게)
           → 200이면 runtime 캐시 하나에 저장(오프라인 전용 사본)
  네트워크 오류 → 캐시 사본. 페이지 이동은 query를 무시하고, `/`로 끝나면 그 폴더의 index.html 사본
fetch(커밋 고정 gamekit 주소) → cache-first(…:gamekit 캐시)
그 밖의 cross-origin → 손대지 않음
```

- 캐시 이름은 `bloom-pwa:<scope 경로>:runtime`과 `…:gamekit` 두 개입니다. 같은 origin의 다른 게임(GitHub Pages의 다른 경로) 캐시는 건드리지 않습니다.
- 서버 응답이 오류(404·5xx)여도 그대로 돌려주며 캐시로 바꾸지 않습니다. 캐시는 네트워크 오류일 때만 씁니다. 206(Range)·redirect 응답은 저장하지 않습니다.
- 오프라인에 열리는 것은 worker가 페이지를 제어한 상태에서 한 번 읽은 파일뿐입니다. 첫 방문의 파일은 worker가 제어하기 전에 받으므로 사본이 없을 수 있어, **오프라인 시작은 두 번째 방문부터**입니다. 아직 읽지 않은 지연 자산은 오프라인에 없습니다.
- 커밋 고정 gamekit 주소 외의 cross-origin(relay·광고·`pixel-physics`의 Matter 주소 등)은 캐시하지 않으므로, 그런 주소가 시작에 필요한 게임은 오프라인으로 시작하지 못합니다.
- localStorage·IndexedDB는 다루지 않습니다. 저장은 게임과 [save](../save/README.md)의 일입니다.

## runtime 계약

```js
const PWA = registerPwa({ serviceWorker, onError, onInstallable? }); // 그 밖의 옵션은 TypeError
PWA.installable; // beforeinstallprompt를 받은 뒤에만 true
await PWA.install(); // 'accepted' | 'dismissed', 설치 창은 한 번만. 설치 불가·dispose 후에는 던짐
PWA.dispose(); // 구독 해제. 등록된 worker는 그대로
```

- 등록 실패와 service worker를 쓸 수 없는 페이지(http 주소, 일부 사생활 보호 모드, service worker를 막은 자동화 브라우저)는 `onError`로 알립니다. 게임이 알릴지 정합니다.
- 등록은 `updateViaCache: 'none'`으로 sw.js의 새 bytes를 HTTP 캐시 없이 확인합니다. 새 sw.js는 기다리지 않고 바로 이어받습니다.
- 업데이트 확인·알림·활성화 API는 없습니다. **"업데이트 확인"은 게임이 저장한 뒤 `location.reload()`하는 것**입니다. 저장 성공을 확인하는 책임은 게임에 있습니다.

## 격리 장면

`?debug` 디버그 장면이나 소개 데모처럼 격리된 장면에서 `registerPwa`를 부를지는 게임이 정합니다. 모듈은 주소를 보고 예외를 두지 않습니다. 이미 등록된 worker는 같은 scope의 모든 요청을 위 규칙으로 처리합니다.

## 범위

예제 탭은 두지 않았습니다. service worker는 페이지와 같은 origin의 파일이어야 해서 htmlpreview 프리뷰에서 실행할 수 없습니다. 실제 동작은 [고정 브라우저 시나리오](./tests/pwa.e2e.mjs)가 확인합니다: 샘플 SVG로 임시 폴더에 생성 → manifest 필드·PNG 크기 → 두 번째 실행 무변경·check 통과 → 원본 변경 시 check 실패 → 실제 Chromium 첫 방문에 worker 제어·설치 때 받은 파일 없음·이전 precache 캐시 삭제 → `max-age=600` 서버에서 파일 배포 후 새로고침 한 번에 새 버전 → 오프라인 새로고침에 마지막 버전과 고정 gamekit 주소. 실기기·iOS Safari·실제 설치 창은 확인하지 못했습니다.

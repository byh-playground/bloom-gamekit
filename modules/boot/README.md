# boot

게임 시작 로딩의 진행률을 맡습니다. 게임은 단계와 가중치만 정하고, 각 단계의 실제 개수를 보고합니다. 전체 진행률 계산·모듈 그래프 병렬 preload·`<progress>` 표시는 이 모듈이 합니다. 두 부분입니다.

- `dist/boot-build.mjs` (Node ESM): `listModuleGraph`가 진입 모듈이 불러오는 로컬 모듈 목록을 만듭니다. 게임은 결과를 runtime manifest에 **커밋**합니다.
- `dist/boot.js` (브라우저): `createBoot`·`bindBootProgress`·`yieldFrame`.

## 왜 필요한가

native ES module의 `await import('./app.js')`는 진행 상황을 알려주지 않고, 브라우저는 파일을 받아야 그 파일의 import를 압니다. 그래프 깊이가 d이면 요청이 d번 왕복으로 줄을 섭니다(waterfall). 서비스 워커가 매 요청을 `no-cache`로 재검증하면 캐시가 있어도 같습니다. 빌드 시점에 그래프 전체 목록을 만들어 두면 시작할 때 모든 파일을 한 번에 `<link rel=modulepreload>`로 요청할 수 있고, 완료한 파일 수가 실제 n/N 진행률이 됩니다.

## 계약

```js
// build time (node) — root 기준 POSIX 경로, 진입점이 첫 항목, 이후 너비 우선·import 순서
listModuleGraph({ root, entry }) → ['src/app.js', 'src/a.js', ...]

// runtime (browser)
const BOOT = createBoot({
    stages: [{ id: 'modules', weight: 3 }, { id: 'atlas', weight: 6 }], // weight = 전체 막대에서의 몫, 게임이 정함
    onChange(state) {}, // { stage, completed, total, overall /*0..1*/, failed? }
});
await BOOT.preloadModules(urls, { stage: 'modules' }); // begin(stage, N) + 파일마다 advance, 실패가 있으면 모두 끝난 뒤 던짐
const SDK = await BOOT.importPinnedModules({ base, modules: { rendering: { file, sha256 } } }, { stage: 'sdk' }); // 받기 → SHA-256 검증 → import, 파일마다 advance → { rendering: namespace }
BOOT.begin('atlas', total); // total = 실제 개수, 모르면 null
BOOT.advance('atlas'); // 완료 1개 더하기(advance(id, n)은 n개)
BOOT.finish('game'); // 개수를 모르는 단계 끝내기(아는 단계는 total 도달 시 자동)
BOOT.complete(); // overall = 1
BOOT.fail(error); // state.failed, 재시도는 게임 UI의 location.reload()
BOOT.subscribe(listener); // → unsubscribe
bindBootProgress(BOOT, { progress, label, text }); // → unbind
await yieldFrame(); // 다음 화면 갱신 기회(rAF가 멈춘 탭은 80ms)
```

| 규칙                            | 내용                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| overall                         | Σ weight × completed/total ÷ Σ weight. 개수를 모르는 단계는 끝날 때까지 0, total 0은 begin 즉시 끝. 개수는 줄지 않으므로 단조 증가합니다.                                                                                                                                                                               |
| 시간 추정 없음                  | ETA·남은 시간·가짜 진행을 만들지 않습니다.                                                                                                                                                                                                                                                                              |
| 명시 실패                       | 모르는 단계, 두 번 begin, begin 전 advance, total 초과, 덜 된 finish, 모르는 옵션은 던집니다.                                                                                                                                                                                                                           |
| 끝난 뒤                         | `complete`·`fail` 뒤 호출은 무시합니다. 실패 뒤 늦게 도착한 작업이 화면을 바꾸지 않습니다. 같은 BOOT로 재시도하지 않습니다.                                                                                                                                                                                             |
| 같은 URL                        | `preloadModules`는 `document.baseURI` 기준 절대 URL로 바꾸어 중복을 뺍니다. 나중 `import()`·정적 import가 같은 URL이어야 module map을 재사용합니다(query 포함).                                                                                                                                                         |
| 파일 하나의 완료                | modulepreload `load` = 그 파일의 수신·파싱 완료입니다. 실행은 `import()` 때 합니다. 실행 중 오류는 import가 던집니다.                                                                                                                                                                                                   |
| `importPinnedModules`           | `base + file`을 받아 SHA-256이 고정값과 같을 때만 그 bytes를 blob URL로 import합니다. 파일은 상대 import가 없는 단일 파일이어야 합니다(GameKit dist 파일). DOM을 쓰지 않아 Worker에서도 됩니다. HTTP 오류·해시 불일치·실행 오류는 모두 끝난 뒤 한 번에 던집니다. `base`·`modules` 밖의 필드, 해시 없는 항목은 던집니다. |
| modulepreload 미지원            | `fetch`로 받아 HTTP 캐시만 데웁니다. 이 경우 `import()`가 다시 요청할 수 있습니다.                                                                                                                                                                                                                                      |
| `listModuleGraph`가 따라가는 것 | 정적 `import`·`export … from`, 문자열 리터럴 `import('./x.js')`. 계산된 `import(expr)`은 목록에 없습니다(그 파일은 import 시점에 요청됨).                                                                                                                                                                               |
| `listModuleGraph`가 던지는 것   | 없는 파일, root 밖 경로, `./`·`../`가 아닌 지정자(bare·`/` 시작). `https:` 같은 절대 URL은 목록에서 빼고 따라가지 않습니다.                                                                                                                                                                                             |

## 게임 코드

```js
// scripts/update-runtime-manifest.mjs — 게임 소스가 바뀔 때 목록을 다시 쓰고, --check는 다르면 실패
import { listModuleGraph } from '../vendor/gamekit/boot-build.mjs'; // dist commit에 고정해 내려받은 파일
const GAME_MODULES = listModuleGraph({ root: '.', entry: 'src/app.js' });
// runtime manifest(JSON)에 gameModules: GAME_MODULES 로 저장
```

```html
<section id="loading">
    <p id="loading-label" role="status" aria-live="polite"></p>
    <progress id="loading-progress"></progress>
    <a id="loading-retry" href="" hidden>다시 불러오기</a>
</section>
```

```js
// src/bootstrap.js
import { createBoot, bindBootProgress, yieldFrame } from './vendor/boot.js';

const MANIFEST = JSON.parse(document.getElementById('runtime-manifest').textContent);
const BOOT = createBoot({
    stages: [
        { id: 'modules', weight: 3 },
        { id: 'game', weight: 1 },
        { id: 'atlas', weight: 6 },
    ],
});
const LABELS = { modules: '게임 파일', game: '게임 준비', atlas: '그림 굽기' };
bindBootProgress(BOOT, {
    progress: document.getElementById('loading-progress'),
    label: document.getElementById('loading-label'),
    text: (state) =>
        state.failed ? '시작하지 못했습니다' : `${LABELS[state.stage] ?? ''} ${Math.round(state.overall * 100)}%`,
});
try {
    // manifest 경로는 페이지 기준이므로 import도 같은 페이지 기준 URL을 씁니다.
    await BOOT.preloadModules(MANIFEST.gameModules, { stage: 'modules' });
    BOOT.begin('game');
    const { start } = await import(new URL('src/app.js', document.baseURI).href);
    BOOT.finish('game');
    await start({ boot: BOOT, yieldFrame }); // 게임이 begin('atlas', n) / advance('atlas') 를 직접 보고
    BOOT.complete();
    document.getElementById('loading').remove();
} catch (error) {
    BOOT.fail(error);
    document.getElementById('loading-retry').hidden = false; // href=""는 전체 페이지 다시 읽기
}
```

### 커밋에 고정한 GameKit을 CDN에서 검증해 받기

`boot.js` 자신은 먼저 받아야 하므로 게임이 한 파일만 직접 검증해 import하고, 나머지는 `importPinnedModules`에 맡깁니다.

```js
// lock = { distCommit, modules: { rendering: { file: 'rendering.js', sha256 }, ... } } — 게임이 커밋한 고정 목록
const BASE = `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@${lock.distCommit}/`;
const { boot: BOOT_ENTRY, ...REST } = lock.modules;
const { createBoot, bindBootProgress } = await importOneVerified(BASE + BOOT_ENTRY.file, BOOT_ENTRY.sha256); // 게임 코드
const BOOT = createBoot({
    stages: [
        { id: 'sdk', weight: 3 },
        { id: 'art', weight: 5 },
    ],
});
bindBootProgress(BOOT, { progress, label, text: (state) => `게임 모듈 ${state.completed}/${state.total}` });
const SDK = await BOOT.importPinnedModules({ base: BASE, modules: REST }, { stage: 'sdk' }); // SDK.rendering.WebGLDevice …
```

동기 작업 묶음(예: atlas bake) 사이에는 `await yieldFrame()`을 넣어야 막대가 실제로 그려집니다.

## 비용

- `preloadModules`: URL마다 `<link>` 하나를 만들고 load/error 뒤 지웁니다. 상태 객체는 보고마다 하나 만듭니다(시작 구간 한정).
- `listModuleGraph`: 주석·문자열·template·정규식을 건너뛰는 최소 토큰화로 import 지정자만 찾습니다. 전체 parser가 아니므로 `)` 뒤의 정규식처럼 나눗셈과 구별되지 않는 드문 문법에서는 틀릴 수 있습니다. 목록이 실제와 다르면 빠진 파일은 import 때 요청되고(진행률에 안 잡힘), 없는 파일은 던집니다.

## 시험

`modules/boot/tests/boot.e2e.mjs`(core 목록). 함정 문법을 섞은 약 20개 fixture 그래프에서 `listModuleGraph`의 순서·제외·없는 파일/bare 지정자 오류를 확인하고, 요청마다 40ms 지연을 둔 서버와 헤드리스 Chromium에서 n/N이 1씩 N/N까지, overall 단조 증가 후 1, `<progress>`·label 표시, preload 뒤 `import()`의 추가 모듈 요청 0, 없는 파일이 섞인 실패 경로를 확인합니다. 시간 성능은 측정하지 않습니다.

## v0.39.2 (2026-10-31)

수정. `pwa`의 `registerPwa`가 등록 결과가 비어 있을 때 던지지 않고 `onError`로 알립니다. Playwright처럼 자동화 브라우저가 service worker를 막으면(`serviceWorkers: 'block'`) `register()`가 오류 없이 빈 값으로 끝나는데, 이전에는 `addEventListener`를 부르다 페이지 오류가 났습니다.

- 이전 화면과 다른 점: 없습니다. 실제 브라우저에서 등록이 성공하는 경로는 같습니다.
- 시험: pwa 고정 시나리오에 service worker를 막은 컨텍스트를 더해 `onError` 한 번과 페이지 오류 0건을 확인했습니다. 수정 전 코드로는 이 단계가 시간 초과로 실패합니다.

## v0.39.1 (2026-10-31)

호환 추가. 새 `pwa` 모듈을 더합니다. 브라우저 runtime `dist/pwa.js`와, dist에서 처음으로 Node ESM 도구 `dist/pwa-build.mjs`를 함께 배포합니다. `buildPwa`는 SVG 원본과 설정 하나에서 `manifest.webmanifest`·아이콘(192·512·maskable·180 apple-touch)·공유 이미지(1200×630)·`sw.js`·`<head>` 태그를 만들고, 게임은 결과를 커밋합니다. `check: true`는 커밋된 결과가 원본과 다르면 던집니다. `registerPwa`는 sw.js 등록과 설치(`install`)·업데이트(`onUpdate` → `update()`) 알림을 맡습니다.

- 배포 구조: `project/distribution.mjs`의 `NODE_TOOLS`가 Node 도구를 선언하고, `manifest.json`의 `modules`에 `pwa-build.mjs`가 `{file, sha256}`로 들어갑니다(schema 2 그대로). dist의 생성 파일 이름 규칙은 `.js`에서 `.js`/`.mjs`로 넓혔습니다. manifest의 모듈 목록을 고정 검사하는 게임(budmori `gamekit-provenance.cjs`)은 다음 pin 갱신 때 `pwa.js`·`pwa-build.mjs`를 목록에 더해야 합니다.
- 실패를 숨기지 않습니다: 모르는 옵션·빠진 값·잘못된 색·viewBox 없는/비율이 틀린 SVG·빈 precache 패턴·마커 오류·마커 밖의 중복 태그는 모두 던집니다.
- 이전 화면과 다른 점: 새 모듈이라 기존 게임은 그대로입니다.
- 시험: `modules/pwa/tests/pwa.e2e.mjs`(core 목록). 헤드리스 Chromium에서 샘플 SVG로 생성, manifest 필드, PNG 크기, 두 번째 실행 무변경과 check 통과, 원본 변경 시 check 실패, 설치 후 `setOffline(true)` 새로고침으로 오프라인 시작(고정 gamekit 주소 포함, relay는 캐시하지 않음), precache 파일 변경 → 기다리는 worker → `onUpdate` → `update()`로 새 버전·이전 캐시 삭제를 확인했습니다. 실기기·iOS Safari·실제 설치 창은 확인하지 못했습니다.

## v0.39.0 (2026-10-31)

Breaking. `transport`의 방 resume(재접속 identity·세션 metadata·공개 방 pointer)이 주입한 `Storage`에 직접 쓰지 않고 `save` 모듈을 거칩니다. `resume.storage`를 없애고 `resume.adapter`(save 어댑터)를 받습니다. 디버그·리플레이·소개 같은 격리 장면은 `memoryAdapter()`를 넘기면 실제 resume 저장을 덮어쓰지 않습니다. `createNostrDynamicRoom`·`createNostrPublicRoom` 둘 다 같습니다.

```js
// 이전
createNostrPublicRoom({ ...options, resume: { storage: sessionStorage, key, lifetimeMs } });
// 이후
import { localStorageAdapter, memoryAdapter } from './save.js';
createNostrPublicRoom({
    ...options,
    resume: { adapter: localStorageAdapter({ storage: sessionStorage, prefix: 'my-game:' }), key, lifetimeMs },
});
// 격리 장면
createNostrPublicRoom({ ...options, resume: { adapter: memoryAdapter() } });
```

- key 하나가 save 레코드 하나입니다: 방 identity(`{ identity }`)와 공개 방 pointer(`{ pointer }`). 없는 상태는 `null`로 둡니다. 기본 key는 `bloom-gamekit:dynamic-v2:…`, `bloom-gamekit:public-v2:…:pointer`이며 예전 `dynamic-v1`·`public-v1` 저장은 읽지도 바꾸지도 않습니다(이전 저장 호환 없음).
- 읽지 못한 record는 이전과 같은 `invalid resume record; explicitly reset for a fresh room`(만료는 `…expired…`)으로 실패하고 원본을 보존합니다. `reset: true`는 save의 `reset()`으로 버리고 새로 시작합니다.
- 방이 열린 뒤의 쓰기(roster 갱신·`forgetResume()`·pointer)는 호출 순서대로 대기열에 넣고, 실패는 `onStatus`/`subscribe`에 `{ type: 'resume-save-failed', record, reason, error }`로 알립니다. 이전에는 쓰던 handler에서 바로 던졌습니다. identity 쓰기 실패 뒤 identity를 닫는 것은 그대로입니다. 단, 호스트가 방을 연 직후의 첫 roster 쓰기 실패는 이전처럼 방을 닫지 않고 이벤트와 identity 종료로 끝납니다.
- `dist/transport.js`가 save를 함께 묶으므로 이벤트의 `error`는 `dist/save.js`의 `SaveError`와 `instanceof`가 맞지 않습니다. `error.kind`로 판단합니다.
- 이전 화면과 다른 점: 없습니다. 새 key라 이전 탭 저장으로는 복귀하지 않습니다.
- 시험: `npm run test:network`의 동적 방 시나리오(헤드리스 Chromium, 실제 RTC)에서 새로고침 복귀가 `localStorageAdapter({ storage: sessionStorage })`로 그대로 통과하고, `memoryAdapter`로 연 방이 sessionStorage를 바꾸지 않는 것, 깨진 record가 위 오류로 실패하고 보존되는 것, `reset: true`가 새 identity를 저장하는 것, 실패하는 쓰기가 `resume-save-failed`로 오는 것을 확인했습니다. 공개 방 pointer의 깨진 record·쓰기 실패 경로는 시험하지 않았습니다.

## v0.38.1 (2026-10-31)

호환 추가. `save`에 `reset()`을 더합니다. 읽지 못해 잠긴 저장에서 게임이 사용자 확인을 받은 뒤 "기록을 지우고 새로 시작"할 수 있게 합니다. 저장된 레코드를 버리고 `create()`로 새로 저장하며 잠금을 풉니다. 잠금 자체(모듈이 스스로 덮어쓰지 않음)는 그대로입니다.

- 어댑터 계약: 저장된 값을 해석하지 못하면 던지는 대신 `SaveError('unreadable')`을 `body`에 넘깁니다. `load`·`update`는 이전처럼 unreadable로 실패하고, `reset`만 덮어씁니다. 직접 만든 어댑터가 던지는 경우 `reset`도 그 오류로 실패합니다.
- 이전 화면과 다른 점: 없습니다. 게임이 `reset`을 부르는 버튼을 둘 때만 달라집니다.
- 시험: 헤드리스 Chromium에서 깨진 JSON 레코드를 `reset`하면 새 데이터·잠금 해제·revision 0이 되고 이어서 `update`가 저장되는 것, 읽을 수 있는 레코드의 `reset`은 revision을 이어 올리는 것을 확인했습니다.

## v0.38.0 (2026-10-31)

Breaking. `audio`가 localStorage에 직접 쓰지 않고 `save` 모듈을 거칩니다. `storageKey` 옵션을 없애고 `settings`(불러온 save)와 `onSaveError`를 받습니다. `audioSettings(config)`가 `createSave`에 넘길 key·version·create·validate를 줍니다. 디버그·소개 같은 격리 장면은 `memoryAdapter`로 만든 settings를 넘기면 실제 소리 설정을 덮어쓰지 않습니다.

- 이전: `new AudioPlayer({ ...config, storageKey: 'my-audio' })`
- 이후: `const SETTINGS = createSave({ ...audioSettings(config), adapter: localStorageAdapter({ prefix: 'my-game:' }) }); await SETTINGS.load(); new AudioPlayer({ ...config, settings: SETTINGS, onSaveError })`
- 예전 키의 설정은 읽지 않습니다(이전 저장 호환 없음). 깨진 설정은 기본값으로 바꾸지 않고 `load()`가 실패하며 원본을 그대로 둡니다. 저장 실패는 이제 조용히 무시되지 않고 `onSaveError`로 갑니다.
- 시험: 헤드리스 Chromium에서 예제의 음소거·음량 0.33이 새로고침 뒤 복원되고 save 레코드에 남는 것, 깨진 설정 레코드가 상태 줄에 실패로 표시되고 원본이 그대로인 것을 확인했습니다. `npm run test:audio`는 이 PC의 헤드리스 실시간 출력 검사("Live graph stayed silent")에서 main과 같이 실패해 그 뒤 단계(mute/save/reload)는 이 시험으로 확인하지 못했고 위 임시 점검으로 대신했습니다.

## v0.37.6 (2026-10-31)

호환 추가. 새 `save` 모듈(`dist/save.js`)을 더합니다. 게임마다 따로 짜던 저장 코드(IndexedDB·localStorage 직접 접근, 리비전, 탭 간 충돌, 이관)를 한 계약으로 모읍니다. `createSave({adapter, key, version, create, validate, migrate})`로 레코드 하나를 다루고, 저장소는 `indexedDbAdapter`·`localStorageAdapter`·`memoryAdapter`로 바꿔 끼웁니다. 메모리 어댑터로 디버그 장면·시험의 저장 상태를 격리할 수 있습니다.

- 읽지 못한 저장(형식 없음·깨진 JSON·미래 schema·이관 단계 없음·검증 실패)은 기본값으로 바꾸지 않고 `SaveError('unreadable')`로 알리며 원본을 덮어쓰지 않도록 잠급니다.
- 이전 화면과 다른 점: 새 모듈이라 기존 게임은 그대로입니다.
- 시험: 헤드리스 Chromium의 실제 IndexedDB·localStorage·BroadcastChannel에서 생성, 쓰기 생략, 규칙 오류 전달, 두 save 사이 충돌과 알림, 다시 읽은 뒤 저장, 깨진 JSON 보존, 미래 schema, schema 1→2 이관을 확인했습니다. 실제 두 탭(별도 페이지)은 이 시험 밖입니다.

## v0.37.5 (2026-10-31)

호환 추가. `debug-tools`에 `installDebugHost`를 더합니다. 주소의 `?debug=1&scene=이름&tick=N&…`로 게임이 등록한 장면을 그 틱에서 열어 멈추고, `window.__bloomDebug`로 `ready`·`state()`·`step(n)`을 노출합니다. AI가 같은 주소로 같은 장면을 열어 캡처할 수 있게 하는 것이 목적입니다.

- 호스트는 `debug`, `scene`, `tick`만 읽습니다. 나머지 파라미터는 해석하지 않고 문자열 그대로 장면 함수에 넘깁니다. 타입·범위 선언도 기본값도 없고, 잘못된 값은 장면 안에서 그대로 실패합니다. 실패하면 `ready`는 false이고 `error`와 콘솔에 남습니다.
- 이전 화면과 다른 점: `debug`가 없으면 아무것도 설치하지 않으므로 기존 게임은 그대로입니다.
- 시험: 헤드리스 Chromium에서 장면을 틱 5에서 열어 사각형이 그 틱의 위치에 그려지는지, 추가 `step`, 없는 장면·던지는 장면·틱 형식 오류의 실패 보고, 잘못된 숫자가 기본값으로 바뀌지 않고 장면에 도달하는 것을 확인했습니다. 실제 게임 연결은 이 릴리스 밖입니다.

## v0.37.4 (2026-10-30)

호환 개선. `bm-ima` 광고 오버레이에 항상 보이는 닫기 버튼(`closeLabel`, 기본 '광고 닫기', 56px)을 둡니다. 스킵할 수 없는 광고나 로딩 중에는 사용자가 광고를 중간에 그만볼 방법이 없었습니다. 누르면 광고를 정리하고 결과는 `dismissed`입니다. 보상형은 보상이 없고, 호출한 게임은 `dismissed`를 스킵과 같이 처리하면 됩니다.

- 이전 화면과 다른 점: 모든 광고 오버레이에 닫기 버튼이 생깁니다. 광고를 끝까지 보면 결과는 그대로 `rewarded`·`viewed`입니다.
- 시험: 실제 IMA 샘플 태그를 헤드리스 Chromium에서 재생해 보상형은 닫으면 `dismissed`로 보상 없이 끝나고, 전면은 닫으면 `dismissed`로 끝나 다음 화면으로 넘어가는 것을 확인했습니다. 모바일 실기기는 확인하지 못했습니다.

## v0.37.3 (2026-10-30)

호환 수정. `bm-ima`에서 광고를 눌러 광고가 멈추면 다시 재생할 방법이 없던 것을 고칩니다. 광고를 누르면 IMA가 랜딩 페이지를 열고 광고를 일시정지하는데, 되돌아와도 스스로 재개하지 않아 광고 화면에 갇혔습니다. 이제 일시정지되면 오버레이에 재생 버튼(`resumeLabel`, 기본 '광고 계속 보기', 높이 56px)을 보여 주고, 랜딩 페이지에서 돌아와 창이 다시 보이거나 포커스를 받으면 자동으로 재개합니다. 재개되면 버튼은 사라집니다.

- 이전 화면과 다른 점: 일시정지된 광고에만 버튼이 생깁니다. 광고 결과(`rewarded`·`viewed`·`dismissed`·`error`)와 타임아웃 동작은 그대로입니다.
- 시험: 실제 IMA 샘플 태그를 헤드리스 Chromium에서 보상형으로 재생하고 광고 영역을 눌러 재현했습니다. 수정 전에는 재생이 멈춘 채 끝나지 않았고, 수정 후에는 버튼으로도, 포커스 복귀로도 재개되어 `rewarded`로 끝났습니다. 포커스 복귀는 합성 `focus` 이벤트로 확인했고 실제 탭 전환·모바일 실기기는 확인하지 못했습니다.

## v0.37.2 (2026-10-30)

호환 개선. `bm.canShow(type)`가 마지막 `preload` 결과를 함께 알려 줍니다. 광고 SDK가 로드되지 않았거나 광고 차단으로 `preload`가 `false`였던 종류는 `{ ok: false, reason: 'not-ready' }`이고, 한 번도 `preload`하지 않았으면 준비 여부를 모르므로 `ok`입니다. 게임이 `preload` 결과를 따로 들고 있다가 버튼 표시 판정에 섞던 것을 모듈이 맡습니다.

- 이전 화면과 다른 점: `preload`가 `false`였던 종류의 `canShow`가 `ok: true`에서 `not-ready`로 바뀝니다. `showRewarded`·`showInterstitial`은 그대로 시도하며 광고가 없으면 `unavailable`로 끝납니다. 다시 `preload`해 `true`가 되면 `ok`로 돌아옵니다.
- 시험: 임시 Node 점검으로 preload 전·실패·성공·재시도의 `canShow`와, 실패 뒤에도 show가 시도되는 것을 확인했습니다(저장소에 남기지 않음).

## v0.37.1 (2026-10-30)

호환 수정. v0.37.0의 방향성 스케치 에코가 모서리에서 찌그러지던 것을 고칩니다. v0.37.0은 정점마다 스칼라 오프셋 하나를 across 좌표에 담았는데, 모서리 정점 하나는 이웃한 두 변의 서로 다른 오프셋을 동시에 만족하지 못해 네모의 에코가 기울어진 사각형으로 그려졌습니다. 이제 에코 띠의 정점을 윤곽을 `(echoX, echoY)`만큼 옮긴 위치에 놓습니다. 셰이더는 옮긴 윤곽에서의 거리를 읽으므로 모서리도 정확하고, 정점 수·포맷·uniform은 그대로입니다. 띠 폭은 `amplitude + echoWidth`로 줄었습니다.

- 이전 화면과 다른 점: v0.37.0에서 `echoY != 0`인 스케치를 이미 쓰고 있었다면 에코 모서리 모양이 바뀝니다. v0.36 이하와 달리 에코는 윤곽 전체가 평행이동한 모양입니다.
- 시험: 고정 브라우저 시나리오의 `echo (0, 8)` 검사는 그대로 쓰며, 헤드리스 Chromium 캡처로 옮긴 네모와 24각형의 모양을 직접 확인했습니다.

## v0.37.0 (2026-10-30)

비호환 변경. 셰이더로 그리는 스케치의 에코가 `echoY`를 반영합니다. 이전에는 `echoY`가 uniform에만 실리고 셰이더가 읽지 않아, `echoX`를 윤곽의 법선 방향 거리로 쓰는 사방 균일한 테두리만 나왔습니다. 컴파일러의 CPU 경로와 문서는 처음부터 "윤곽을 `(echoX, echoY)`만큼 옮긴 선"이었으므로, 셰이더도 그 정의로 맞춥니다. 오른쪽 아래로만 벌어지는 그림자 같은 방향성 에코를 쓸 수 있습니다.

- 윤곽 띠의 across 좌표에 `dot((echoX, echoY), 바깥 방향)`을 미리 빼서 담고, 셰이더는 0 근처의 선만 찾습니다. 정점 수·정점 포맷·uniform 배치는 그대로입니다. 재질 레코드의 `echoX`·`echoY` 칸은 더 이상 쓰이지 않아 0으로 남습니다.
- 이전 화면과 다른 점: `echoX`가 이제 법선 거리가 아니라 x 성분입니다. `echoY`가 0이 아닌 에셋은 에코가 저작한 방향으로 옮겨 그려집니다. 윤곽 위쪽·왼쪽에서 에코가 몸체 안쪽으로 들어가는 것도 정상입니다.

```js
// 이전: echoY는 GPU에서 버려지고 echoX가 사방 균일한 법선 거리였다
{ echoX: 6, echoY: 6 } // 사방 6만큼 벌어진 테두리
// 이후: 오른쪽 아래로 (6, 6) 옮긴 그림자
{ echoX: 6, echoY: 6 }
```

- 시험: 고정 브라우저 시나리오(`yarn-shader`)에 `echo (0, 8)`이 도형 아래쪽에만 그려지고 위·왼쪽·오른쪽에는 그려지지 않는 검사를 추가했습니다. 수정 전 코드는 네 방향 모두 0으로 이 검사에 실패하는 것을 확인했습니다.
- 확인하지 못한 것: 코너에서 미터 길이(최대 4배)로 벌어진 정점의 에코 모양, 3D 월드 변환 아래의 모양, 실제 하드웨어 GPU. 이 PC의 SwiftShader에서만 확인했습니다.

## v0.36.0 (2026-10-30)

비호환 변경. 스프라이트 애니메이션의 재생 인스턴스 이름을 `createVectorActor`·`asset.createActor`와 맞춥니다. 같은 개념(하나의 그려지는 인스턴스)을 모듈마다 player와 actor로 다르게 부르던 것을 actor 하나로 통일하기 위해서입니다. 동작은 바뀌지 않습니다.

- `sprite.createPlayer(options)` → `sprite.createActor(options)`, `sprite.stats().playerCount` → `actorCount`. 오류 메시지는 `Sprite actor disposed`입니다. 별칭은 두지 않습니다.

```js
// 이전
const PLAYER = SPRITES.createPlayer({ clip: 'walk', startedAtMs: 0 });
// 이후
const ACTOR = SPRITES.createActor({ clip: 'walk', startedAtMs: 0 });
```

## v0.35.0 (2026-10-30)

호환 추가. `bm`에 Google IMA 영상 광고 어댑터(`bm-ima.js`)를 추가합니다. AdSense 승인 없이도 Google의 공개 샘플 광고 태그로 실제 영상 광고를 재생해 `bm`의 광고 흐름을 확인하기 위해서입니다. 번들 1개가 늘어 공개 번들은 26개입니다.

- 광고마다 전체 화면 오버레이를 만들고 끝나면 지웁니다. 끝까지 재생하면 보상형은 `rewarded`, 전면은 `viewed`이고, 건너뛰거나 닫으면 `dismissed`, 시작 전 오류나 광고 없음은 `unavailable`, 재생 중 오류는 `error`입니다. 시작과 종료에 각각 시간 제한이 있어 오버레이가 남지 않습니다.
- 공개 샘플 태그를 `IMA_SAMPLE_TAGS`로 내보냅니다(테스트 전용). 예제 하네스는 광고 소스를 고를 수 있게 되어, IMA 샘플은 승인 없이 바로 나옵니다.

```js
const BM = createBm({ adapter: createImaAdapter({ adTagUrl: IMA_SAMPLE_TAGS.linear }) });
await BM.preload('entry');
const RESULT = await BM.showRewarded('entry'); // 클릭 핸들러 안에서
```

- 시험: 고정 프리뷰 시나리오가 가짜 `google.ima`로 완료(rewarded)·건너뜀(dismissed)·광고 없음(unavailable)·오버레이 정리·correlator 채움을 데스크톱과 터치 에뮬레이션에서 확인합니다. 별도로 이 PC의 헤드리스 Chromium에서 실제 샘플 태그를 호출해 `linear`는 약 13초 재생 후 `rewarded`, 오류 태그는 약 2초 만에 `unavailable`로 끝나는 것을 확인했습니다.
- 확인하지 못한 것: 건너뛰기 버튼을 눌렀을 때의 실제 결과, 광고 차단 상태, 모바일 실기기, 운영용 광고 수요처(샘플 태그는 테스트 전용). `AdDisplayContainer.initialize()`의 사용자 입력 요건은 문서에서 확인하지 못했습니다.

## v0.34.0 (2026-10-30)

호환 추가. 상품 구매를 감싸는 `store` 모듈을 추가하고, `bm`에 `suppress` 옵션을 더합니다. 광고 제거 같은 구매를 광고 모듈과 서로 import하지 않고 한 줄로 연결하기 위해서입니다. 이번에는 한 번 사면 계속 갖는 상품만 다루며 실제 결제사 어댑터와 서버는 포함하지 않습니다.

- 번들 2개가 늘어납니다: `store.js`(코어), `store-mock.js`(테스트용). 어댑터는 코어를 import하지 않는 별도 번들입니다.
- `owns(id)`는 어댑터의 구매 성공 콜백이 아니라 서버가 인정한 보유 상품(`entitlements()`)만 true로 칩니다. 구매 직후 서버가 인정하지 않으면 `pending`/`not-confirmed`입니다. 시간 초과도 `refresh()`로 확인하게 합니다.
- `bm`의 새 옵션 `suppress(type)`가 true를 돌려주면 그 광고 종류는 `blocked`/`suppressed`입니다. 기존 호출은 바뀌지 않습니다.

```js
// 이전: 구매자 판정을 게임이 광고 호출마다 직접 했다
if (!STORE.owns('no_ads')) {
    await BM.showInterstitial('next');
}
// 이후: 한 번 연결하면 canShow와 showInterstitial이 함께 막힌다
const BM = createBm({ adapter, suppress: (type) => type === 'interstitial' && STORE.owns('no_ads') });
```

- 시험: 임시 Node 점검으로 서버 확인 후에만 보유 처리, 미확인 시 pending, 취소·계약 밖 결과·어댑터 예외, 시간 초과 후 잠금 해제와 refresh 복구, 중복 구매·동시 구매 차단, 다른 기기 구매 복원, 변경 이벤트, `suppress`의 막기·예외 처리를 확인하고 제거했습니다. 예제 페이지와 고정 E2E는 추가하지 않았습니다.
- 하지 않은 것: 실제 결제사 연동, 소비성 상품, 구독, 환불 처리, 영수증 검증 서버.

## v0.33.1 (2026-10-30)

호환 수정. `bm-google-ads`의 `show`가 SDK 준비를 기다리지 않고 바로 `adBreak`를 부릅니다. 이전에는 `onReady`가 오지 않으면 첫 광고 요청이 최대 5초 늦어졌고, 그동안 클릭의 user activation이 끝나 광고가 막힐 수 있었습니다. 준비 전 호출은 `adsbygoogle` 큐가 받아 둡니다.

- 예제 페이지가 모의 광고에서 실제 Google 테스트 광고 확인용 하네스로 바뀝니다. 게시자 ID를 넣고 승인된 도메인에서 열어야 광고가 나옵니다. 승인 뒤 확인할 항목은 `adapters/google-ads/README.md`의 체크리스트에 있습니다.
- 시험: 광고 스크립트를 막고 `adBreak`를 가짜로 둔 고정 시나리오(데스크톱 클릭, 터치 에뮬레이션)로 잘못된 ID 거절, 연결, 보상형 보상, 전면 광고, 테스트 모드 속성, 가로 스크롤 없음을 확인합니다.
- 확인하지 못한 것: 실제 Google 광고 호출(승인 전), 실기기. `preloadAdBreaks`·`onReady` 옵션 이름은 여전히 Google 문서로 대조하지 못했습니다.

## v0.33.0 (2026-10-30)

호환 추가. 광고 SDK를 하나의 인터페이스로 감싸는 `bm` 모듈을 추가합니다. 광고사마다 코드가 달라 게임이 SDK에 묶이던 문제를 줄이려는 것입니다. 이번에는 광고만 다루며 결제·상품·서버 정산은 포함하지 않습니다.

- 번들 3개가 늘어납니다: `bm.js`(코어), `bm-mock.js`(테스트용), `bm-google-ads.js`(Google H5 Games Ads). 어댑터는 코어를 import하지 않는 별도 번들이라 필요한 것만 가져옵니다. 소스는 `modules/bm/adapters/<광고사>/`에 두고 신청 절차는 각 폴더의 README에 적습니다.
- 코어는 `showRewarded`·`showInterstitial`·`preload`·`canShow`·`on('adstart'|'adend')`을 제공합니다. 결과는 `rewarded`·`viewed`·`dismissed`·`unavailable`·`blocked`·`error` 중 하나이며 던지지 않습니다.
- 정책: 전면 쿨다운(기본 60초), 세션당 상한, 동시 광고 하나, 응답 없는 어댑터의 시간 초과, 사용자 입력 직후가 아닌 호출 차단.

```js
const BM = createBm({ adapter: createGoogleAdsAdapter({ clientId: 'ca-pub-123456789', testMode: true }) });
const RESULT = await BM.showRewarded('entry'); // 클릭 핸들러 안에서
if (RESULT.status === 'rewarded') {
    startRun();
}
```

- 시험: 임시 Node 점검으로 이벤트 순서, busy, 쿨다운, 세션 상한, 계약 밖 결과, 입력 직후 판정, 시간 초과 후 잠금 해제, 어댑터 예외, dispose, Google 어댑터의 가짜 `adBreak` 매핑을 확인하고 완료 후 제거했습니다. 고정 E2E 시나리오는 추가하지 않았습니다.
- 하지 않은 것: 실제 Google 테스트 광고 호출, 브라우저·모바일 실기기 검증, 결제·상품 어댑터. `adConfig`의 `preloadAdBreaks`·`onReady`는 문서 전문을 확인하지 못한 옵션입니다.

## v0.32.0 (2026-10-30)

호환 추가. 베드 레이어에 이퀄라이저 `eq`를 추가합니다. 발배구 BGM에 컴프레서·로우패스를 얹을수록 거칠다는 피드백이 이어져 곡 원본을 존중하고 필요한 대역만 조금 다듬는 쪽으로 방향을 바꿨는데, 지금까지 레이어 필터는 로우패스·밴드패스·하이패스뿐이라 쉘프나 피킹으로 특정 대역만 덜어 낼 수 없었습니다.

- `eq: [{ type, hz, gainDb, q? }]`(최대 8밴드). type은 `lowshelf`·`highshelf`·`peaking`·`notch`입니다. `lowCutHz` 뒤, 레이어 필터 앞에 순서대로 걸립니다. noise·buffer 레이어 모두 가능하고 범위를 벗어난 값은 RangeError입니다.

```js
// 이전: 특정 대역만 덜어 낼 방법이 없다
{ kind: 'buffer', bufferId: 'bgm', gain: 1, lowCutHz: 80 }
// 이후: 노이즈 퍼커션의 중고음만 3dB씩 덜어 낸다
{ kind: 'buffer', bufferId: 'bgm', gain: 1, lowCutHz: 80, eq: [{ type: 'peaking', hz: 1200, gainDb: -3, q: 0.8 }, { type: 'highshelf', hz: 3000, gainDb: -3 }] }
```

- 시험: `test:audio`가 피킹 -12dB(중심 25%, 150Hz는 그대로), 하이쉘프 -6dB(8kHz 절반, 300Hz 그대로), 로우쉘프 +6dB(40Hz 두 배, 2kHz 그대로)를 사인파로 확인하고 잘못된 밴드 6가지(종류, 게인 범위, 주파수 범위, 게인 누락, notch의 게인, 9밴드)를 거부하는지 OfflineAudioContext로 확인합니다.
- 이번에 하지 않은 것: 밴드별 on/off, 실시간 변경, 그래픽 EQ UI. 실제 청취는 검증하지 못했습니다.

## v0.31.0 (2026-10-30)

호환 추가. 베드 레이어에 `lowCutHz`를 추가합니다. 발배구 BGM이 "도입부가 아직 거칠다"는 피드백을 받았는데, 곡의 도입부와 중간 브레이크는 에너지의 25~27%가 40Hz 아래 초저음이었습니다(본체는 6%). 노트북·휴대폰 스피커는 이 대역을 못 내고 오히려 찌그러지며, 마스터 컴프레서도 이 저음에 눌려 효과음이 출렁입니다. 고음을 덜어 내는 로우패스와 이 저음을 걷어 내는 로우컷을 같이 써야 하는데, 레이어 필터는 하나뿐이었습니다.

- `lowCutHz`(10..400): 2차 하이패스(Q 0.7071)로 필터·컴프레서 앞에 붙습니다. noise·buffer 레이어 모두에 줄 수 있습니다. 범위 밖 값은 RangeError.

```js
// 이전: 필터가 하나뿐이라 고음(로우패스)과 초저음(로우컷)을 같이 못 다룬다
{ kind: 'buffer', bufferId: 'bgm', gain: 0.55, type: 'lowpass', hz: 1600, q: 0.7, compressor: { threshold: -50, ratio: 10 } }
// 이후
{ kind: 'buffer', bufferId: 'bgm', gain: 0.55, lowCutHz: 80, type: 'lowpass', hz: 1600, q: 0.7, compressor: { threshold: -50, ratio: 10 } }
```

- 시험: `test:audio`가 100Hz 로우컷에서 40Hz 사인은 30% 아래로 줄고 400Hz 사인은 90% 넘게 남는지, 범위 밖 값 세 가지의 거부를 OfflineAudioContext로 확인합니다.
- 이번에 하지 않은 것: 임의 개수의 필터 체인(`filters: []`), 로우컷 기울기 선택. 실제 청취는 검증하지 못했습니다.

## v0.30.0 (2026-10-30)

호환 추가. 베드 레이어에 `compressor`를 추가합니다. 음악처럼 곡 안에서 크기가 크게 변하는 buffer 레이어를 고르게 만드는 레벨러입니다. 발배구가 배경 음악을 깔아 보니 도입부는 묻히고 하이라이트는 튀었고(곡의 3초 구간 음량 편차 10.8dB), 마스터 컴프레서는 곡이 임계값 아래라 걸리지 않았습니다.

- `compressor: { threshold(-100..0 dB), ratio(1..20), knee?(기본 10), attackMs?(20), releaseMs?(250) }`. 필터 뒤, gain 앞에 붙고 noise·buffer 레이어 모두에 줄 수 있습니다. 범위를 벗어난 값은 RangeError입니다.
- WebAudio 컴프레서의 자동 보정 gain 때문에 전체가 커집니다(실측 약 +5dB). 적용 뒤 레이어 `gain`을 다시 맞춥니다.

```js
// 이전: 곡의 도입부가 묻히고 하이라이트가 튄다(3초 구간 편차 10.8dB)
{ kind: 'buffer', bufferId: 'bgm', gain: 1 }
// 이후: 편차 2.5dB, 전체 약 +5dB 커지므로 gain을 낮춘다
{ kind: 'buffer', bufferId: 'bgm', gain: 0.65, compressor: { threshold: -50, ratio: 10, attackMs: 100, releaseMs: 900 } }
```

- 시험: `test:audio`가 28dB 크기 차이의 두 구간이 컴프레서로 8dB 넘게 좁혀지는지와 범위 밖 설정 네 가지의 거부를 OfflineAudioContext로 확인합니다.
- 이번에 하지 않은 것: 룩어헤드, 사이드체인(다른 소리가 날 때 음악을 자동으로 낮추기). 덕킹은 게임이 `setLevel`로 합니다. 실제 청취는 검증하지 못했습니다.

## v0.29.0 (2026-10-30)

호환 추가. 환경음 베드 레이어에 `kind: 'buffer'`를 추가합니다. 게임이 읽어 디코드한 AudioBuffer(음악 루프, 긴 환경 소리)를 베드로 깔고 `setLevel`·`swell`·`stop`으로 다룰 수 있습니다. 발배구가 배경 음악을 깔려는 데서 나온 공통 필요입니다.

- buffer 레이어: `{ kind: 'buffer', bufferId, gain, type?, hz?, q?, pan?, offsetMs?, lfos? }`. 필터는 `type`을 줄 때만 붙습니다(예: 음악의 낮은 대역을 덜어 효과음과 겹치지 않게).
- `startBed`는 `setBuffer`로 등록한 버퍼를 씁니다. 등록하지 않은 `bufferId`는 오류입니다. 파일 fetch/decode와 곡 선택은 여전히 모듈 밖입니다.

```js
player.setBuffer('bgm', await context.decodeAudioData(await (await fetch(url)).arrayBuffer()));
config.beds = {
    bgm: { category: 'music', layers: [{ kind: 'buffer', bufferId: 'bgm', gain: 0.8, type: 'highpass', hz: 250 }] },
};
const bgm = player.startBed('bgm', { level: 1, fadeMs: 1500 });
bgm.setLevel(0.5, 300); // 일시정지에서 낮춤
```

- 시험: `test:audio`가 1초 버퍼의 3초 루프(세 번째 초가 첫 초와 같은 크기), highpass가 낮은 소리는 거르고(5% 미만 남음) 높은 소리는 남기는지(70% 이상), 등록하지 않은 버퍼 거부, 실제 재생에서 루프 시작·정지를 확인합니다.
- 이번에 하지 않은 것: 루프 지점(loopStart/loopEnd) 지정, 곡 이어 붙이기·크로스페이드, 파일 로딩. 실제 청취는 검증하지 못했습니다.

## v0.28.0 (2026-10-30)

**Breaking.** `audio` 환경음 베드가 바람 소리처럼 들리던 문제에서 나온 공통 필요입니다. 군중 웅성거림은 필터 있는 여러 겹이 서로 닮지 않게 겹치고 음절 속도로 불규칙하게 떨려야 하는데, v0.27.0은 저역통과 노이즈 한 종류와 느린 흔들림 하나만 줄 수 있었습니다.

- 베드 noise 레이어에 `type`(lowpass|bandpass|highpass)·`q`·`pan`·`offsetMs`·`lfos`를 추가합니다. `offsetMs`로 같은 노이즈 버퍼를 서로 다른 지점에서 읽어 레이어가 닮지 않고, `pan`으로 좌우에 펼칩니다.
- `lfoHz`/`lfoDepth`는 `lfos: [{ hz, depth }]`(최대 4개, depth 합 1 이하)로 바뀝니다. 남아 있으면 TypeError입니다(별칭 없음).

```js
// 이전: 저역통과 + 느린 흔들림 하나
{ kind: 'noise', hz: 500, gain: 0.22, lfoHz: 0.25, lfoDepth: 0.35 }
// 이후: 대역 + 위치 + 닮지 않게 + 느린 흔들림과 음절 흔들림
{ kind: 'noise', type: 'bandpass', hz: 480, q: 0.9, gain: 0.5, pan: -0.6, offsetMs: 0,
  lfos: [{ hz: 0.22, depth: 0.25 }, { hz: 4.3, depth: 0.3 }] }
```

- 시험: `test:audio`가 밴드패스 중심 주파수(교차 횟수), `offsetMs` 유무에 따른 좌우 상관(1 대 약 0), 음절 LFO의 음량 출렁임(깊이 0 대 0.9), 옛 `lfoHz` 거부를 OfflineAudioContext로 확인합니다.
- 이번에 하지 않은 것: 목소리 같은 음정 있는 베드 레이어(formant 합성), 파일 기반 군중 소리. 실제 청취 판단은 검증하지 못했습니다.

## v0.27.0 (2026-10-30)

**Breaking.** `audio`에 재생마다 달라지는 소리(패닝·피치 변주)와 합성 환경음(베드)을 추가합니다. 발배구의 타격감과 관중 분위기 개선에서 나온 공통 필요입니다.

- `start(id, strength, options)`: 세 번째 인자가 함수에서 `{ pan, detune, onEnded }` 객체로 바뀝니다. 함수를 넘기면 TypeError입니다(별칭 없음). `createAdapter`는 payload의 `pan`·`detune`을 그대로 전달합니다.
- `startBed(id)`: 노이즈 루프 환경음입니다. `setLevel`로 크기를 바꾸고 `swell`로 순간적으로 키우며 `stop(fadeMs)`로 끝냅니다. `stopAll()`과 mute로는 끝나지 않고 `dispose()`가 끝냅니다.
- `beds` 설정, `renderBed`(OfflineAudioContext 시험용 export), `snapshot().beds`.

```js
// 이전
player.start('kick', strength, () => journal.finish(event));
// 이후
player.start('kick', strength, {
    pan: event.position.z / halfWidth, // -1..1, 0이면 패너 노드 없음
    detune: (Math.random() - 0.5) * 70, // cent, 난수는 호출자 몫
    onEnded: () => journal.finish(event),
});

config.beds = {
    crowd: { category: 'ambience', layers: [{ kind: 'noise', hz: 900, gain: 0.1, lfoHz: 0.35, lfoDepth: 0.4 }] },
};
await player.unlock();
const crowd = player.startBed('crowd', { level: 0.6, fadeMs: 600 });
crowd.swell(1, 120, 900); // 득점 환호
crowd.stop(600);
```

- 시험: `test:audio`가 패닝(한쪽 채널 에너지), 디튠(옥타브 교차 횟수 2배·1/2배), 베드 level·stop·swell·노드 정리를 OfflineAudioContext로, 실제 Chromium에서 베드 재생·같은 핸들 반환·stopAll 생존·category 음량 0 무음·dispose 정리를 확인합니다.
- 이번에 하지 않은 것: 베드 덕킹(다른 소리가 날 때 자동으로 낮추기), 음악, 샘플 파일 로딩, 거리 감쇠. 실제 스피커·기기에서의 청취와 모바일 CPU 부하는 검증하지 못했습니다.

## v0.26.6 (2026-10-30)

GPU 포즈(`poseBackend: 'auto'`, 기본값)가 실제 NVIDIA에서 `'uniform'`보다 최대 9배 느리던 문제를 고칩니다. API 변경은 없습니다. 같은 장면에서 `auto`가 `uniform` 수준이 됩니다.

원인은 정점 셰이더의 키프레임 계산이 아니었습니다. 서로 다른 메시의 액터가 번갈아 그려져 draw가 액터 수만큼 쪼개지면, `PoseRenderer`가 draw마다 호출되는 `flushUpdates`에서 두 가지 일을 했습니다.

- `updateDataTexture`가 호출마다 동기식 `gl.getError()`를 불렀습니다. rendering README가 반복 `updateTexture`/`copyFrameToTexture`에는 `checkGLErrors`일 때만 부른다고 적은 규칙을, 이 함수만 지키지 않았습니다. Chrome에서 `getError`는 GPU 프로세스와 왕복 동기화라 호출당 약 0.1~0.2ms가 들었습니다(CPU 프로파일에서 `updateDataTexture`가 프레임의 75%). 이제 `checkGLErrors`일 때만 부릅니다.
- `_uploadRows`가 flush마다 살아 있는 인스턴스 전부를 훑어 dirty 여부를 찾았습니다. draw가 N번이면 N×N번 방문하고 프레임당 `flushRecordVisits`가 인스턴스 수의 제곱으로 늘었습니다. 이제 state/override/CPU별 dirty 집합을 두고 바뀐 행만 방문합니다.

측정(실제 Chrome, ANGLE D3D11, GTX 1660 Ti, 1280x720, sketch-town 적 3종을 번갈아 그린 액터 수별 프레임, 60프레임 중앙값을 3회 반복한 중앙값, 단위 ms):

| 액터 수 | auto 이전 (GPU/CPU) | auto 이후   | uniform     |
| ------- | ------------------- | ----------- | ----------- |
| 40      | 9.8 / 9.8           | 1.1 / 1.1   | 1.4 / 1.3   |
| 200     | 43.5 / 43.8         | 5.8 / 6.1   | 6.3 / 6.5   |
| 1000    | 251 / 253           | 27.6 / 27.7 | 26.8 / 26.8 |

bloom-bounko 에셋 5종으로도 같습니다(200개: 이전 43.0 → 이후 4.8, uniform 4.5). 메시별로 묶어 그리면 `auto`는 원래도 빨랐습니다(200개, 이전 코드 1.7ms 대 uniform 4.5ms). 이전 README의 "정점마다 같은 파트 계산을 반복하는 비용은 GPU ALU 시간으로 옮겨진다"는 우려는 이 GPU에서 병목이 아니었고, 그 문장을 측정 사실로 바꿨습니다. 측정은 project/docs/rendering-benchmark.json의 `gpu-pose-flush-cost`에 있습니다.

- 시험: `test:vector-assets:gpu-poses`는 실제 Chrome에서 통과하고 auto와 uniform의 픽셀 차이가 0입니다. 이 시험이 내부 `stateDirty`/`overrideDirty` 플래그를 읽던 곳은 새 dirty 집합을 읽도록 바꿨습니다. SwiftShader에서는 이 변경 전후 모두 같은 픽셀 임계(`changedFraction` 0.00102 대 0.001)에서 실패하는 기존 문제가 그대로입니다.
- 이번에 하지 않은 것: 포즈를 파트당 한 번 별도 패스로 계산해 행렬 텍스처에 쓰는 방식은 시도했다가 버렸습니다. 원인이 정점 계산이 아니라서 이득이 없었고(40개 번갈아 그리기 9.1ms로 uniform 1.2ms보다 느림), 이 변경만으로 `uniform`과 같아졌습니다.

## v0.26.5 (2026-10-30)

**Breaking.** budmori-io와 bloom-bounko 이관에서 나온 모듈 빈틈 네 가지를 메웁니다.

- `holdVectorAsset(context, compiled)`(vector-assets): 액터 없이 GPU 메시·포즈 원본·표면을 붙잡는 핸들입니다. 마지막 액터가 사라질 때 메시가 해제되고 다음 액터가 다시 올리던 반복(budmori 측정: 열 종을 지웠다 다시 만드는 한 번에 생성·해제 각 9회)을 없앱니다. 게임이 자주 쓰는 종을 `hold.release()` 전까지 붙잡아 두면 됩니다. `context.dispose()`는 남은 것을 해제합니다.
- `VectorContext.preparePoses()`: 준비된 액터 포즈를 한 번에 평가합니다. 게임이 `acquireMeshRenderer().preparePoses()`를 부르지 않아도 됩니다. 포즈 통계는 `stats().mesh.poses`이며 메시 렌더러가 아직 없으면 `mesh`는 null입니다.
- `drawVectorActorSilhouette`의 `outlineExpression`: 외곽선 복사본만 그 표정으로 그리고 본체는 액터의 현재 표정으로 그립니다. SVG에 외곽선 전용 표정을 둔 에셋(bounko)은 8방향 반복 draw 대신 이걸 쓸 수 있습니다. 순서 있는 draw 두 번(외곽선, 본체)이고, `setPartVisible`을 덮어쓴 액터와는 함께 쓰지 못해 오류입니다. 액터에 `expression` 읽기 속성이 생겼습니다.
- `createVectorSpriteAtlas`, `createVectorRasterAtlas`가 알 수 없는 옵션을 오류로 거부합니다. 옛 `maxAtlasBytes`처럼 사라진 옵션이 조용히 무시되던 문제입니다.
- 이번에 하지 않은 것: GPU 없는 `readSocket(compiled, clip, timeMs)`. 액터 생성이 메시와 포즈 원본을 만드는 구조라 GPU 없이 읽으려면 액터 내부를 나눠야 하고, `holdVectorAsset`으로 임시 액터(소켓 읽기용)의 메시 올리고 내리기는 이미 사라집니다. 그래도 필요하면 별도 변경으로 합니다. atlas 용량은 장치 옵션 `textureAtlas` 그대로입니다.
- 시험: `test:vector-assets:paint-regions`가 hold의 한 번 해제, `preparePoses`, 표정 외곽선(본체 픽셀 불변, 표정 복구, 외곽선이 별도 draw), 알 수 없는 옵션 거부를 확인합니다.

## v0.26.4 (2026-10-30)

액터 외곽선을 지원합니다. v0.26.3에서 하지 않았던 부분이고, 게임이 외곽선을 위해 액터를 오프셋마다 따로 그리던 방식을 한 번의 인스턴스 draw로 바꿉니다.

```js
// 이전: 외곽선 8방향을 게임이 직접 반복 (각 호출이 포즈 준비와 draw 제출)
for (const [dx, dy] of OFFSETS)
    ctx.drawVectorActor(actor, { matrix: translate(dx * w, dy * w, local), color: black, forceColor: true });
ctx.drawVectorActor(actor, { matrix: local });

// 이후
ctx.drawVectorActorSilhouette(actor, { matrix: local, color: '#000', width: 3, radius: 100 });
```

- `VectorContext.drawVectorActorSilhouette(actor, { matrix, color, width, radius, outlineScale, ...drawVectorActor 옵션 })`: `drawMeshSilhouette`와 같은 규칙입니다. 아래 외곽선 9개(8방향+가운데)와 본체를 한 번의 순서 있는 인스턴스 draw로 제출하고, 그룹 opacity는 한 번만 합성합니다. `outlineScale`을 주면 외곽선 1개를 확대해 그립니다. 월드 모드는 지원하지 않아 오류입니다.
- 액터 `draw`가 `instances` 옵션(`matrices`, `count`, `prefixColor`, `prefixCount`, `forceColorPrefixCount`)을 받습니다. 한 포즈를 변환 여러 개로 그리는 경로라서 GPU 포즈에서도 포즈 준비는 한 번입니다.
- `MeshRenderer.drawMeshInstances`: 내부 이름이던 `_drawMeshInstances`를 공개 이름으로 바꿨습니다(`VectorContext`와 액터가 함께 씁니다).
- 시험: `test:vector-assets:paint-regions`가 세 포즈 백엔드(uniform, auto, cpu)에서 본체 불투명 픽셀이 평범한 draw와 같음, 외곽선이 본체 바깥에 검은색으로 생김을 확인합니다. `world-rendering`, `alpha-run-batching`, `yarn-shader`, 브라우저 e2e도 통과했습니다. 성능 수치(외곽선 8회 draw 대비)는 이번에 측정하지 않았고, 게임 화면은 확인하지 않았습니다.

## v0.26.3 (2026-10-30)

**Breaking.** `VectorContext.drawVectorActor`가 `drawMesh`와 같은 규칙으로 context 상태를 따릅니다. 게임 이관(yarn-mayhem, bloom-bounko, squish-born, rally-frontier)에서 같은 곳이 반복해서 막혔기 때문입니다. 게임은 이제 카메라 행렬을 액터마다 손으로 곱하지 않습니다.

```js
// 이전: 카메라를 액터 호출마다 직접 곱함
camera.applyToContext(ctx);
ctx.drawVectorActor(actor, { matrix: multiply(cameraMatrix, local), alpha: ctx.globalAlpha, color, forceColor });

// 이후
camera.applyToContext(ctx);
ctx.drawVectorActor(actor, { matrix: local });
```

- `matrix`는 현재 context 변환과 합성됩니다. 변환이 항등이면 이전과 같고, `viewProjection`/`worldMatrix`(월드 모드)에서는 합성하지 않습니다. `matrix`가 없으면 context 변환 자체를 씁니다.
- `alpha`는 context `globalAlpha`와 곱해집니다. `forceColor`와 `whiteFlash`를 지정하지 않으면 context의 `forceColor`와 `filter`를 따릅니다. 이미 `alpha`/`color`/`forceColor`를 명시해 넘기던 코드는 context가 기본값(`globalAlpha` 1, `forceColor` 없음)일 때 그대로 동작합니다.
- 새 옵션 `depthWriteAlphaThreshold`: 반투명 삼각형이 깊이를 쓰지 않게 하는 `MeshRenderer` 옵션을 액터도 받습니다. 지정하면 액터는 GPU 포즈 대신 CPU 포즈로 그립니다(포즈 통계의 fallback 사유는 `alphaDepthClassification`). 재질이 있는 에셋(털실·스케치)과 월드 모드는 `MeshRenderer`가 이 옵션을 지원하지 않아 오류입니다.
- 이번에 하지 않은 것: 액터의 외곽선(silhouette) 그리기. 이미 `drawMeshSilhouette`가 있는 메시와 달리 액터에는 아직 없습니다. 외곽선 8방향 draw는 이제 카메라 합성이 되어 게임이 `matrix`만 오프셋하면 됩니다.
- 시험: `test:vector-assets:paint-regions`에 카메라 변환이 `matrix` 평행이동과 같은 픽셀임, context `globalAlpha`가 `alpha`와 같은 픽셀임, `depthWriteAlphaThreshold`가 GL 오류 없이 그려짐을 추가했습니다. `world-rendering`, `vector-gradient-clip`, `alpha-run-batching`, 브라우저 e2e도 통과했습니다. 모바일과 게임 화면은 확인하지 않았습니다.

## v0.26.2 (2026-10-30)

2D 프레임 비용 벤치마크(v0.26.1 기록)에서 CPU가 컸던 세 장면(경로, 곡선, 그라디언트)의 원인을 프로파일로 확인해 고칩니다. 경로·곡선은 구조가 아니라 **둥근 접합 버그와 정점 하나마다 임시 배열을 만드는 비효율**, 그라디언트는 **객체마다 램프를 매 프레임 다시 만드는 비효율**이었습니다. 공개 API는 그대로입니다.

- 버그 수정(`lineJoin: 'round'`): 접합부 호가 두 바깥 점 사이의 짧은 쪽이 아니라 긴 쪽으로 그려졌습니다. 정점이 4~5배 늘고, 반투명 선에서는 접합마다 두 번 덧칠되어 구슬처럼 밝은 점이 보였으며 바깥 쐐기가 비는 경우가 있었습니다. 이제 짧은 호를 그립니다(선 안쪽 불투명도가 어디서나 같음을 GTX 1660 Ti에서 확인).
- 호 분할을 선 굵기에 맞춥니다(`ARC_TOLERANCE` 0.125px). 가는 선은 몇 조각만, 굵은 선은 둥글게 유지될 만큼 쪼갭니다. 둥근 끝(cap)도 같습니다.
- 클립·그라디언트·uv가 없는 흔한 경우 삼각형 정점을 임시 배열 없이 정점 버퍼에 바로 씁니다.
- 그라디언트 램프를 stop 내용으로 보관합니다. 같은 stop이면 객체가 달라도 램프 텍스처 하나를 공유하고, 매 프레임 같은 stop으로 새 gradient를 만들어도 다시 raster·업로드하지 않습니다(최대 64개, 오래 안 쓴 것부터 제거). stop 수정 시 대기열 flush가 필요 없어졌습니다. `stats()`에 `retainedGradientRampCount`가 추가됩니다.
- 측정(GTX 1660 Ti, 1280x720, 60프레임 중앙값, CPU ms / 정점): 경로 13.7→4.4 / 121,284→35,355, 곡선 15.2→2.6 / 153,600→27,600, 그라디언트 14.9→0.4. GPU 시간도 경로 0.81→0.24, 곡선 3.76→0.19ms입니다. 기록은 `project/docs/rendering-benchmark.json`의 `round-join-fix`, `gradient-ramp-cache`입니다.
- 시험: `npm run check`, `vector-gradient-clip`, `alpha-run-batching`, `yarn-shader`, `texture-atlas`, 브라우저 e2e(컨텍스트 손실 후 램프 재업로드 포함)를 통과했습니다. `run-raster-comparison`은 main에서도 같은 곳(cpu-pose-atlas)에서 멈춥니다. 모바일과 게임 화면은 확인하지 않았습니다.
- 알아둘 점: 기본 `lineJoin`은 `'round'`로 Canvas2D의 `'miter'`와 다릅니다. 이번에 바꾸지 않았습니다.

## v0.26.1 (2026-10-30)

rendering 예제를 한 페이지의 탭으로 합칩니다. 모듈 SDK의 동작은 그대로이고 `buildYarnSurfaceMesh`만 여러 표면을 받습니다.

- 예제: `modules/rendering/examples/index.html` 한 페이지에 탭 4개(벡터, 아틀라스, 재질, 그라디언트)가 있고, 탭은 처음 열 때만 WebGL 장면을 시작합니다. 주소는 `#vector`, `#atlas`, `#materials`, `#paint`입니다. 옛 `examples/vector/`, `examples/texture-array/`와 미리보기 이름 `rendering-vector`, `rendering-texture-array`는 삭제했습니다. README의 "바로 보기"는 `previews/rendering.html` 하나입니다.
- 벡터 탭: `VectorRenderer`를 직접 만들어 쓰던 옛 방식을 `VectorContext`로 다시 썼습니다. README가 말하는 단일 진입점과 같은 길을 보여 줍니다. 장면은 같습니다.
- 재질 탭(새로움): 털실·스케치 표면 두 개가 든 메시를 개체 12·60·240개 그리고, 개체마다 다른 시간으로 스케치 테두리를 움직이면서 그리기 호출이 한 번임을 보여 줍니다. 동작 줄이기 설정이면 한 장면만 그립니다.
- 그라디언트 탭(새로움): 선형·방사 그라디언트와 장면 밖에서 한 번 만든 오목한 클립 경로를 켜고 끌 수 있습니다.
- `buildYarnSurfaceMesh(surfaces)`: 표면 하나 또는 목록(최대 16개)을 받아 한 메시로 만듭니다.
- 시험: `project/tests/browser.e2e.mjs`가 새 페이지의 네 탭을 데스크톱과 터치 에뮬레이션에서 확인합니다(그리기 호출 수, 픽셀, 클립 안팎, 가로 스크롤 없음, 첫 화면 안의 캔버스, 56px 이상 버튼). 실제 모바일 기기는 확인하지 않았습니다.

## v0.26.0 (2026-10-30)

**Breaking.** 털실·스케치 표면을 별도 렌더러가 아니라 `MeshRenderer` 메시의 재질로 옮깁니다. `YarnSurfaceRenderer`와 표면별 draw가 사라지고, 털실 에셋도 다른 에셋과 같은 경로(인스턴싱, GPU 포즈, 클립, 스텐실, 깊이)를 탑니다. 게임 코드는 v0.25.0의 `createVectorActor`에서 바뀌지 않습니다.

- 컴파일러(0.12.0)가 `backend:"shader"` 표면을 메시 삼각형(채움, 그다음 윤곽 띠)으로 내보냅니다. 정점마다 재질 4 float(종류, 표면 번호, 윤곽 따라 거리, 윤곽 가로 거리)가 붙고 표면 상수는 메시의 작은 표(표면당 vec4 5개, 최대 16개)에 둡니다. `geometry.shaderSurfaces`와 `geometry.drawOrder`는 없어지고 `geometry.materials`가 생깁니다. 이전 컴파일러로 만든 에셋은 다시 컴파일하라는 오류로 거부합니다(게임이 시작할 때 SVG에서 컴파일하면 영향이 없습니다).
- `createVectorActor`: 표면이 있어도 에셋이 CPU 포즈와 메시 조각 draw + flush 경로로 떨어지지 않습니다. 액터 하나는 인스턴스 draw 하나이고 같은 메시의 액터들은 한 draw로 묶입니다.
- `MeshRenderer`: 재질이 있는 메시만 재질 정점 스트림, 재질 표, 인스턴스별 표시 시간(인스턴스 레코드 +4 float), 더 큰 프래그먼트 셰이더를 씁니다. 다른 메시의 셰이더와 인스턴스 크기는 그대로입니다. `drawMesh({ timeMs })`가 추가되고, `indexRange`를 `indexVariant`와 함께 쓸 수 있습니다. `depthWrite: true`이면 채움·테두리 삼각형을 원래 순서 그대로 구간으로 나눠 그려 테두리는 깊이를 쓰지 않습니다. 재질이 있는 메시는 `depthWriteAlphaThreshold`를 지원하지 않습니다.
- `VectorContext`: `acquireSurfaceRenderer()`, `surfaces` 옵션, `context.surfaceRenderer`를 제거합니다. 이 버전 v0.25.0에서 막 들어갔던 이름들입니다.
- rendering: `YarnSurfaceRenderer`를 삭제합니다. `buildYarnSurfaceGeometry`는 유지하고 `buildYarnSurfaceMesh({ fillVertices, outline, edgeColors, style })`를 추가해 컴파일된 SVG 밖의 표면을 메시로 만듭니다. 빌드는 vector-assets가 읽는 데이터 파일(`yarn-geometry.js`, `yarn-material-record.js`)을 허용 목록에 추가했습니다. 셰이더 소스는 vector-assets 번들에 들어가지 않습니다.
- 화질: 옛 `YarnSurfaceRenderer`와 같은 표면을 같은 크기·시간으로 그려 비교한 결과 채널 차이는 최대 0~1단계(털실 1배·2.5배, 스케치 시간 0·400·123456.7ms)입니다.
- 성능(같은 표면 N개를 한 프레임에 그림, `EXT_disjoint_timer_query`, 옛 방식 대비): draw 수 2N → 1. CPU 시간 -50~-99%. GPU 시간은 GTX 1660 Ti에서 16개 -17%, 256개 -46%, 256개 2배 확대 0%, 1024개 -82%이고, UHD 630에서 +1~+9%(256개 +6%, 256개 2배 +9%, 1024개 +1%)입니다. Intel처럼 GPU가 병목인 장면에서는 프레임 시간이 소폭 늘 수 있습니다. 재질 표를 프래그먼트당 한 번만 읽도록 한 뒤의 값입니다(그 전에는 Intel +8~+38%).
- 시험: 이 PC의 Chromium(SwiftShader)에서 `npm run check`, `test:vector-assets`(컴파일러, 브라우저), `world-rendering`(깊이 쓰기 분할이 단일 draw와 같은 픽셀임을 포함), `paint-regions`, `yarn-shader`(해칭 비율 12.86%), `vector-gradient-clip`, `alpha-run-batching`, `texture-atlas`, `sprite-animation`를 통과했습니다. `run-gpu-poses`와 `run-raster-comparison`은 main에서도 같은 수치로 멈춥니다(v0.25.0 노트 참고). 모바일 실기기와 게임 화면은 검증하지 않았습니다.
- 삭제: `benchmark:yarn-stream` 벤치 페이지와 스크립트(옛 렌더러를 측정하던 도구). 측정 기록 `project/docs/yarn-stream-*.json`은 그대로 둡니다.

## v0.25.0 (2026-10-30)

**Breaking.** SVG 에셋을 쓰는 게임이 렌더러를 직접 만들고 이어 붙이던 구조를 없앱니다. `VectorContext` 하나가 `VectorRenderer`, `MeshRenderer`, `YarnSurfaceRenderer`를 모두 소유하고, 게임은 `WebGLDevice`와 `VectorContext`만 만듭니다. 에셋과 플레이어라는 두 단계도 액터 하나로 합칩니다.

```js
// 이전
const meshes = new MeshRenderer(device);
const surfaces = new YarnSurfaceRenderer(device);
const vector = new VectorRenderer(device);
const context = new VectorContext(device, { vectorRenderer: vector });
context.meshRenderer = meshes;
const asset = createVectorAsset(meshes, compiled, { surfaceRenderer: surfaces });
const player = asset.createPlayer({ clip: 'walk' });
player.draw({
    projection: context.vector.projection,
    clips: context.vector.clips,
    stencilRef: context.vector.stencilDepth || null,
    matrix,
});
player.dispose();
asset.dispose();
surfaces.dispose();
context.dispose();
vector.dispose();

// 이후
const context = new VectorContext(device);
const actor = createVectorActor(context, compiled, { clip: 'walk' });
context.drawVectorActor(actor, { matrix });
actor.dispose();
context.dispose();
```

- `createVectorAsset(meshRenderer, compiled, { surfaceRenderer })`와 `asset.createPlayer()`를 `createVectorActor(context, compiled, options)`로 바꿉니다. `ownsPlayer`, `playerCount`, `asset.mesh`, `asset.surfaces`, `asset.dispose()`는 없어집니다. 같은 `compiled` 객체의 액터들은 그 context의 GPU 메시, 포즈 소스, 털실·스케치 표면을 공유하고, 첫 액터가 만들고 마지막 액터가 해제됩니다. 공유 기준은 `compiled` 객체이므로 로더가 돌려준 객체를 보관했다가 액터마다 다시 넘깁니다.
- `VectorContext`의 `vectorRenderer` 주입 옵션과 `context.meshRenderer` 대입을 제거합니다. 한도는 `new VectorContext(device, { mesh: { maxMeshes, maxMeshBytes, maxInstances, poseBackend }, surfaces: { maxSurfaces, maxSurfaceBytes } })`로 넘깁니다. `context.dispose()`가 액터가 남긴 자원과 세 렌더러를 해제합니다.
- `context.drawVectorAsset(player, options)`는 `context.drawVectorActor(actor, options)`가 됩니다. `projection`, `clips`, `stencilRef`는 context가 채웁니다.
- `createVectorRasterAtlas(context, asset, compiled, options)`와 `createVectorSpriteAtlas(context, asset, compiled, options)`는 `asset` 인자 없이 `(context, compiled, options)`가 됩니다. 아틀라스가 자원에 자기 참조를 하나 잡으므로 모든 액터를 해제해도 원본이 사라지지 않습니다.
- `VectorContext`에 `acquireSurfaceRenderer()`와 `onDispose(callback)`가 추가됩니다. 애드온 모듈이 정리 콜백을 등록하는 용도입니다.
- 게임 저장소는 아직 옮기지 않았습니다. 소비처 이관은 모듈이 정리된 뒤에 따로 진행합니다.

검증: `npm run check`, `test:vector-assets`, `world-rendering`, `paint-regions`, `yarn-shader`, `vector-gradient-clip`, `alpha-run-batching`, `texture-atlas`, `sprite-animation`, `project/tests/browser.e2e.mjs`를 이 PC의 Chromium(SwiftShader)에서 통과했습니다. `run-gpu-poses`는 main에서도 나던 같은 픽셀 차이(변경 0.1%, 최대 오차 58)에서 멈추고, `run-raster-comparison`은 main과 같은 수치(평균 오차 3.86)로 미리보기 단계에서 멈춥니다. 후자의 직접 실행 블록은 이전부터 현재 구현과 맞지 않았습니다(MeshRenderer를 context로 넘기고, 기존 구현에 없는 `sampledCpuDraws`를 기대함). 새 API로 옮겼고 `cpu-pose-atlas` 단계까지 실행을 확인했습니다. 모바일 실기기와 게임 화면은 검증하지 않았습니다.

## v0.24.3 (2026-10-29)

털실 채움 셰이더가 스티치 곡선 거리를 픽셀마다 계산하지 않고 공통 거리장 텍스처에서 읽습니다. 털실 비용의 약 75%를 차지하던 채움의 곡선 거리 계산(`cubicDistance` 7회, 35개 선분 거리)이 텍스처 샘플 3회로 바뀝니다.

- 거리장은 에셋·시드와 무관한 256x256 RGBA8 텍스처 하나입니다(R = 두 가닥 중 가까운 거리, G = 밑줄, B = 꼬임). 첫 털실 표면을 만들 때 `YarnSurfaceRenderer`가 만들고 `dispose`가 해제하며, 컨텍스트 손실 뒤에는 장치가 다른 텍스처처럼 복원합니다. `device.stats.textureCount`가 털실을 쓰는 동안 1 늘어납니다. 스케치는 이 텍스처를 쓰지 않습니다.
- API와 uniform 배치는 그대로입니다. 샘플러는 기본 유닛 0을 쓰므로 호출마다 uniform을 설정하지 않고, 텍스처 목록은 렌더러가 한 번만 만들어 재사용합니다(그렇지 않으면 호출 수가 많은 장면에서 NVIDIA CPU가 늘었습니다).
- GPU 시간(털실 표면 `drawSurface`, GTX 1660 Ti / UHD 630): 256개 2배 확대 -54% / -60%, 1024개 1배 -4% / -58%, 256개 1배 -34% / -56%. 호출 오버헤드가 지배하는 구간(NVIDIA 1배)은 CPU 시간이 그대로입니다(수정 전 3.4ms, 후 3.4ms).
- 화질: 수정 전과의 평균 차이가 스티치 무늬 신호의 5~8%이고 최대 차이는 34/255, 차이가 8을 넘는 픽셀은 활성 픽셀의 0.02% 이하입니다(선 두께 0.41~3, 1~2.5배 확대). 셀 가로세로 비가 1이 아니면(출하 에셋은 약 0.92) 거리를 근사하고, 선 마스크 반경이 0.25 셀을 넘는 아주 굵은 선은 잘립니다.

## v0.24.2 (2026-10-29)

스케치 채움의 해칭이 작성한 각도·간격을 따르도록 고칩니다. `shadeSketchFill`이 `hatchAngle`·`hatchSpacing`을 `u_effect2.z/w`가 아니라 `u_effect1.z/w`(echoWidth·echoOpacity)에서 읽어, 간격이 `echoOpacity`(1 이하)가 되면서 선이 서로 겹쳐 채움 전체가 해칭 없이 균일하게 어두운 한 색으로 그려졌습니다. v0.7.3에서 `YarnSurfaceRenderer`가 들어온 뒤로 있던 결함입니다.

- 읽는 슬롯만 바꾸며 uniform 배치와 API는 그대로입니다. 스케치를 쓰는 게임은 채움 모양이 달라지므로(해칭 줄무늬가 나타남) 원하는 해칭 설정(`hatchWidth`, `hatchOpacity`)을 확인하세요.
- 고정 브라우저 시나리오(`yarn-shader`)에 스케치 채움이 한 색으로 평평하지 않고 사선 해칭을 그리는지 검사를 추가했습니다.
- 알려진 남은 항목: `echoY`는 uniform에 실리지만 셰이더가 읽지 않아 에코 오프셋은 `echoX` 방향 하나만 반영됩니다. 이번에는 바꾸지 않았습니다.

## v0.24.1 (2026-10-28)

어떤 러너도 부르지 않던 렌더링 시나리오 2개(`vector-context`, `vector-game-coverage`)를 고정 브라우저 시나리오에 연결하고, 그 과정에서 드러난 결함 2개를 고칩니다.

- gradient ramp 영역을 `endFrame`에서 해제합니다. README와 시나리오는 "각 endFrame에서 `activeGradientTextureCount`가 0으로 돌아온다"고 적었지만 코드는 `dispose`에서만 해제해, 이전 프레임의 ramp가 최대 64개까지 atlas에 남았습니다. 같은 gradient 객체를 다음 프레임에 다시 쓰면 그 프레임에서 ramp를 다시 올립니다.
- context 손실 시 gradient 캐시와 CPU ramp를 비우고, atlas 영역 해제는 복원 후로 미룹니다. 손실 중에는 GPU 영역을 지울 수 없어 이전에는 캐시 항목이 남았습니다.
- 낡은 시나리오 기대값을 현재 구조에 맞췄습니다: 프레임당 draw 1개 검증의 `maxVertices`(4096 → 16384, 사각형 1000개가 정점 6000개를 쓰므로), gradient 생성이 GPU 텍스처를 늘린다는 기대(ramp는 atlas 영역이라 텍스처 수 고정), 복원 후 업로드 수를 누적값 대신 증가분으로 검증.
- 이 시나리오들은 점선(`setLineDash`), `drawStaticMesh`, gradient 수명, context 손실 복원을 고정 검증하는 유일한 곳입니다.

## v0.24.0 (2026-10-28)

`PrimitivePainter`가 `Renderer2D`의 도형 호출을 이어받습니다. v0.23.0 안내의 "path로 옮깁니다"를 대체합니다. `line` 한 번이 `beginPath`·`moveTo`·`lineTo`·`lineWidth`·`strokeStyle`·`stroke` 6줄이 되는 이관은 코드량만 늘기 때문입니다.

- `ellipse(x, y, radiusX, radiusY, paint, segments = 24, rotation = 0)`와 `box(centerX, centerY, width, height, paint, angle = 0)`를 추가했습니다. 둘 다 기존 `circle`·`line`처럼 fan 삼각형을 스트림에 바로 제출합니다.
- `box`는 **중심 기준**입니다. Canvas의 `fillRect`(왼쪽 위 기준)와 다르고, 회전 사각형이 자연스럽게 표현돼 `rect` 대신 다른 이름을 썼습니다.
- 이관 대응: `renderer.line`→`painter.line`, `renderer.triangle`→`painter.tri`, `renderer.ellipse`→`painter.ellipse`, `renderer.rect`→`painter.box`(`angle` 인자 동일).
- 고정 브라우저 시나리오에 두 도형의 픽셀(반지름 안/밖, 90도 회전)과 draw call 1개를 추가했습니다.

## v0.23.0 (2026-10-28)

**Breaking.** `Renderer2D`를 삭제합니다(호환 코드 없음). 자체 셰이더·버퍼·텍스처로 그려 VectorContext 스트림과 draw를 합칠 수 없었고, 같은 일을 하는 공개 API가 둘이었습니다. 게임의 렌더 진입점은 `VectorContext` 하나입니다.

- 이미지: `createTexture`/`updateTexture`/`sprite` 대신 `device.textureAtlas.allocate`/`upload`와 새 `VectorContext.drawRegion(region, x, y, width, height, { source })`를 씁니다. `TextureAtlasArray.upload`에 영역 안 오프셋 `{ x, y }` 부분 갱신이 추가됐습니다.
- 카메라: `CameraViewport.rendererCameraInto`/`applyToRenderer`를 `transformInto(out)`/`applyToContext(context)`/`resizeCanvas(canvas)`로 바꿨습니다. 변환은 zoom·회전·shake·DPR을 포함한 6개 affine 값입니다.
- 도형: `rect`/`triangle`/`ellipse`/`line`은 `fillRect`·path·`ellipse`·`stroke`로 옮깁니다. 색은 `fillStyle = [r, g, b, a]`로 그대로 넘길 수 있습니다.
- 프레임 중 이미 올린 아틀라스 영역을 다시 올리거나 해제하면 그 전에 쌓인 draw를 먼저 제출해, 앞선 그림이 이전 픽셀을 유지합니다. 새 영역의 첫 업로드(gradient ramp, 글리프 페이지)는 draw를 나누지 않습니다.
- 보간 데모 2개, 입력 preview 데모, pixel-physics·rollback·presentation·interop·mesh-depth 시나리오를 VectorContext로 옮겼습니다. 보간 통합 예제의 한 프레임은 draw call 1개입니다.

## v0.22.0 (2026-10-28)

**Breaking.** 우리 모듈로 그리는 모든 것(캐릭터·UI·벡터 path·gradient·글리프·효과)이 한 프레임에 같은 blend·clip 상태에서 draw call 1개로 제출됩니다. 정점은 `VectorRenderer`의 동적 정점 스트림(정점당 80바이트)에 쓰이고, 텍스처는 `device.textureAtlas`의 `TEXTURE_2D_ARRAY` region입니다. 스프라이트·baked 벡터 부위(GPU pose는 같은 정점 셰이더에서 평가)·analytic primitive(원·타원·사각형·선)가 이 스트림에 들어옵니다. 유지되는 배치 경계는 blend 전환, stencil clip 변경, 반투명 group, `MeshRenderer` 직접 메시(morph·opacityChannel·shaderSurfaces·forceColor), YarnSurfaceRenderer입니다.

제거(호환 코드 없음): `PrimitiveRenderer`와 `primitives` 통계, `MeshRenderer`의 텍스처·`uvs`·`acquireQuadMesh`/`releaseQuadMesh`/`drawQuadRuns`와 `VectorContext.drawMesh`의 `texture/layer/uvRect/localRect`, `layer-claims`. `createSpriteAnimation(context, region, definition)`, `createVectorRasterAtlas(context, asset, compiled, options)`, `createVectorSpriteAtlas(context, asset, compiled, options)`는 `VectorContext`와 공유 아틀라스 region을 받고 `textureArray`/`layer` 옵션이 없어졌으며 스프라이트 atlas는 `texture` 대신 `region`을 돌려줍니다. 새 `VectorContext.drawQuads`/`VectorRenderer.drawQuads`, `WebGLDevice.registerBatcher/flushBatchers/blitRenderTarget`, 통계 `spriteRuns`·`regionClears`가 추가되고, 해제된 region 비우기는 이미지 업로드 통계에서 제외됩니다.

벤치마크(`project/docs/draw-batching-benchmark.json`, SwiftShader이므로 시간은 장치 성능이 아님): 500 draw → pose를 정점 셰이더에서 평가 250 → 공유 사각형 인스턴싱 1 → 정점 스트림 1. 정점 스트림은 250 캐릭터 프레임당 648,000 B(인스턴싱 파생값 140,400 B)를 올립니다. 사각형당 정점 6개(비인덱스)라서 업로드가 약 4.6배이며, 인덱스 사각형이나 더 작은 정점이 후속 최적화 후보입니다.

## v0.21.0 (2026-10-28)

`WebGLDevice.textureAtlas`(`TextureAtlasArray`)와 `updateTextureRegion`/`clearTextureRegion`을 추가하고 VectorRenderer의 흰 texel, VectorContext의 gradient ramp, GlyphAtlas 페이지를 이 공유 `TEXTURE_2D_ARRAY`의 region으로 옮깁니다. 정점이 layer·gradient 모드·white flash·nearest·radial 파라미터를 담으므로 fill, 선형/radial gradient, 글리프가 한 draw로 묶이고 blend 전환·stencil clip 변경·반투명 group만 배치를 끊습니다(같은 gradient 장면 draw 7→1, 기존 radial 프래그먼트와 Canvas2D 비교 오차 최대 1). 공개 계약 변경: gradient 객체 `texture` → `region`, `GlyphAtlas` callback `texture` → `region`과 배열 좌표 uv, `drawGlyphQuad`의 첫 인자는 region, VectorRenderer의 `white`/`nonRadialPipeline`은 제거(별도 `groupPipeline` 추가). 이미지 캐시·Renderer2D·group target은 기존 텍스처를 씁니다. 측정은 SwiftShader이며 GPU 시간·모바일 메모리는 검증하지 않았습니다.

## v0.20.0 (2026-10-28)

벡터 raster atlas와 스프라이트 atlas가 호출자 소유 `TEXTURE_2D_ARRAY`의 레이어 하나에 구워지고(`textureArray`, `layer`), raster atlas는 공통 단위 사각 메시를 `MeshRenderer.drawQuadRuns`로 부위마다 인스턴스로 그립니다. 포즈는 같은 draw의 정점 셰이더가 키프레임 텍스처에서 계산하므로 별도 pose pass가 없습니다. 같은 장면(액터 250, 종 5)의 draw call이 500 → 250 → 1이고 texture·mesh 끊김이 249 → 0입니다(`project/docs/draw-batching-benchmark.json`, `npm run benchmark:draw-batching -- <label>`). `maxAtlasSize`/`maxAtlasBytes` 옵션은 제거되고 크기는 배열이 정하며, `Device.createTextureLayerTarget`, `MeshRenderer.acquireQuadMesh/releaseQuadMesh/drawQuadRuns`가 추가됩니다. 모핑·opacityChannel·셰이더 표면 에셋은 기존처럼 벡터 경로로 그립니다. VectorRenderer, 글리프 아틀라스, Renderer2D는 아직 기존 텍스처를 씁니다. 벤치마크는 SwiftShader 소프트웨어 렌더러에서 측정했으므로 GPU 시간·모바일 메모리는 검증하지 않았습니다.

## v0.19.9 (2026-10-28)

`WebGLDevice.createTextureArray`/`updateTextureLayer`/`isTextureArray`로 같은 크기의 아틀라스 페이지를 `TEXTURE_2D_ARRAY` 하나에 담습니다. 텍스처 인스턴스에 `layer`가 추가되어(100바이트) 같은 어레이·mesh·상태이면 페이지가 달라도 한 번에 그립니다. 스프라이트 프레임은 `layer`(기본 0)를 받고 `VectorContext.drawMesh`가 전달합니다. 어레이는 레이어 전체 메모리를 처음에 할당하고 컨텍스트 복구 때 올린 레이어를 다시 올립니다. 이번 변경은 mesh·스프라이트 경로뿐이며 vector-assets 렌더 타깃 아틀라스, VectorRenderer, 글리프 아틀라스, Renderer2D는 아직 기존 텍스처를 씁니다. 게임 적용과 실기기 성능은 포함하지 않습니다.

## v0.19.8 (2026-10-27)

SVG 전체 스프라이트의 초기 bake에 `supersample: 1 | 2 | 4` 옵션을 추가합니다(기본 1 유지). 높은 해상도의 RGBA 표본을 준비 때만 그린 뒤 기존 shared sprite quad의 2:1 linear 축소를 반복해 최종 이미지에 저장합니다. 최종 해상도·프레임 정의·재생 경로는 바꾸지 않으며, 큰 초기 target과 임시 target을 해제합니다. MAX_TEXTURE_SIZE와 `maxAtlasBytes`는 임시 준비 peak까지 검사하며 `stats.bakeWorkingBytes`로 최종 보유량과 구분합니다. 색상 캡처·premultiplied alpha·복구와 실패 자원 회수를 검증합니다. 앨리어싱을 줄이는 옵션이며 native MSAA와의 픽셀 동일성이나 게임 품질 기준 통과를 보장하지 않습니다. 게임 적용은 별도 검증 중입니다.

## v0.19.7 (2026-10-27)

`createVectorSpriteAtlas`의 `paintRegions` 옵션으로 원본 SVG의 명시적 RGB 영역을 전체 프레임에 함께 굽습니다. 기존 runtime과 같은 검증을 사용하고 값으로 캡처하며, 이름 순서와 무관한 캐시 키로 같은 팔레트를 공유합니다. 다른 팔레트와 분리하고 복구 시에도 처음 캡처한 색상을 유지합니다. geometry 재컴파일이나 공통 렌더러 변경은 없습니다. 게임 적용과 성능 결과는 이 SDK 변경에 포함하지 않습니다.

## v0.19.6 (2026-10-27)

SVG 예제의 기본 비교를 벡터/전체 스프라이트로 단순화합니다. 부위 텍스처는 고급 옵션에서 켤 때만 준비·렌더·카드·비용표·순차/누적 측정에 포함되며 끄면 자원을 해제합니다. 선택 경로를 조건 key에 포함해 두/세 경로의 누적 기록을 분리하고 이전 기록은 보존합니다. 옵션 변경은 명시적 재준비이며 동일 설정 재선택/정상 재생에서는 compile·bake·이미지 업로드 0 계약을 유지합니다. 모듈 API/공통 렌더러는 변경하지 않습니다.

## v0.19.5 (2026-10-27)

SVG 비교 예제에 시작·정지·재개·초기화 가능한 누적 순차 측정을 추가합니다. 동일 전체 뷰포트의 세 경로에 준비·워밍업을 제외한 균형 라운드를 누적하고 CPU 전체·제출, 비동기 GPU, 실제 RAF 간격의 평균/p50/p95/p99/max와 표본수·시간·16.7ms 초과수를 구분합니다. 조건별 최근 5개 결과, 경로당 최대 6,000개의 정확한 표본을 보관하며 설정·화면 변경/숨김/취소는 미완료 라운드를 버립니다. GPU 누락은 0으로 채우지 않고 coverage와 disjoint 제외를 공개합니다. 공통 렌더러와 렌더 순서는 변경하지 않습니다.

## v0.19.4 (2026-10-27)

SVG 비교 예제의 분할 화면에서 잘못 귀속될 수 있는 경로별 live CPU 시간을 제거합니다. 다음 경로 호출이 이전 mesh batch를 제출하고 최종 flush는 호출 구간 밖에 있으므로, 분할 화면은 공통 RAF FPS와 공통 프레임 수치만 표시하며 경로별 비용은 순차 비교로 안내합니다. 단일 전체 화면의 live 제출 시간은 최종 flush를 포함하고, 기존 순차 CPU 전체·제출·GPU·FPS 표는 유지합니다. 렌더 순서와 배칭·품질은 변경하지 않습니다.

## v0.19.3 (2026-10-27)

SVG 비교 예제에 메시 곡선 정밀도 선택과 세 렌더 경로의 비용 비교를 추가합니다. 곡선 분할 2/4/16과 고정 stroke arc 분할 2를 텍스처 해상도와 구분하며, 기존 브라우저 loader로 설정 변경 때만 컴파일하고 동일 설정을 재사용합니다. 실제 정점·삼각형 수, CPU geometry 보유량과 이미지 texture 할당, 준비 비용, FPS·CPU/GPU 측정의 범위를 구분해 표시합니다. 별도 성능 임계값 연구나 게임 적용 없이 사용자가 예제에서 조건을 바꾸고 측정하도록 합니다.

## v0.19.2 (2026-10-27)

SVG 비교 예제를 단건 품질 확인과 N마리 비교 탭으로 나눕니다. 군집의 마릿수, CSS 픽셀 크기, 배치 영역을 독립 조절하고 동일 seed의 위치와 개체별 위상을 유지합니다. 큰 카드에 공통 RAF FPS와 순차 측정 결과를 구분하며, 순차 측정은 같은 전체 화면에서 CPU 제출·전체 렌더·GPU 시간과 프레임 간격 p50/p95를 보여 줍니다. 미지원·disjoint·부족한 GPU 표본은 0ms로 표시하지 않습니다. 기존 준비 캐시·이미지 업로드 0 계약과 v0.19.1 팔레트·가산 합성은 유지하며 게임 적용은 포함하지 않습니다.

## v0.19.1 (2026-10-27)

원본 SVG의 solid fill에 `data-paint-region` 이름을 지정하고 `player.draw({ paintRegions })`로 해당 RGB만 바꿀 수 있습니다. 원본 선·alpha·표정·소켓과 geometry를 유지하며 UI도 원본을 보존하는 `applySvgPaintRegions` helper로 같은 계약을 사용합니다. 서로 다른 개체의 팔레트는 제출 시 값으로 캡처하고 mesh와 표정 index를 공유합니다. 팔레트 변경 시 geometry 재컴파일·업로드를 하지 않습니다. UV texture/shared quad와 sampled sprite, additive blend 경로는 유지합니다. 이 팔레트는 원본 untextured fill 전용이며 baked texture의 색 영역을 추정하지 않습니다.

## v0.19.0 (2026-10-27)

UV가 있는 retained mesh에 이미지 texture material을 추가하고 SVG와 독립적인 `createSpriteAnimation`을 제공합니다. 프레임 rect·기간·clip·loop, trim·pivot·gutter, 절대 표시 시각·속도·pause·scrub을 처리하며 texture는 호출자에게 빌립니다. 기존 기본 벡터 렌더 경로는 그대로입니다.

`createVectorRasterAtlas`는 원본 SVG의 연속 부위 paint run을 한 번 구워 같은 GPU pose로 움직입니다. `createVectorSpriteAtlas`는 성긴 clip 시각을 완성 이미지로 구워 범용 sprite 정의로 전달합니다. 반복 재생은 texture를 재사용하고 context restore에서는 잃은 픽셀을 다시 굽습니다. once의 마지막 이미지는 원본 종료 자세이며, 모프·시간 효과·opacity·특수 paint 등 각 경로가 동등하게 처리할 수 없는 조합은 사유가 있는 벡터 fallback입니다. 자동 sketch 시간 모프는 sampled sprite 반복과 같지 않아 지원으로 표시하지 않습니다.

비교 예제 `vector-raster-comparison`에서 같은 SVG의 벡터·부위 atlas·sampled sprite를 전환하고 시간·표정·수량·해상도·확대·샘플 간격과 초기 bake/용량 및 CPU/GPU 비용을 비교합니다. Sprite의 시간 양자화와 확대 흐림은 별도 비용입니다. 여러 MeshRenderer가 공유하는 Device VAO에 남은 instance 속성 참조를 삭제 시 정리해, 보조 renderer 해제 후 새 index buffer를 그릴 때의 실제 GPU 오류도 수정했습니다. 물리 모바일은 미검증이며 게임 pin은 변경하지 않습니다.

## v0.18.0 (2026-10-27)

- `VectorContext.globalCompositeOperation`을 추가합니다. `source-over`(기본)와 가산 `lighter`를 지원하며 단순 도형 painter와 vector path/stroke/text에 적용되고 save/restore에 포함됩니다. `PrimitiveRenderer.draw`는 batch 상태에 `blend`를 포함합니다. 불·전기·폭발처럼 겹치면 밝아지는 효과를 게임이 반투명 원 겹침으로 흉내 내지 않아도 됩니다.
- 검증: 실제 Chromium/WebGL에서 단순 도형·path의 가산 포화, save/restore 복원, 잘못된 값 예외를 임시 pixel 검사로 확인했습니다(저장소에는 남기지 않음).

## v0.17.1 (2026-10-27)

Prepared vector poses are reused within the same frame and pose revision, including mutable exclusion contents and context restoration. Drawing a previously prepared CPU pose no longer uploads its row again. Clean pose atlases return without scanning all actors on each visible mesh flush. `poseStats()` exposes `flushCalls`, `flushRecordVisits`, and `cleanFlushSkips`; player metrics expose `preparedPoseCacheHits`. Animation, paint order, geometry and image quality are unchanged. This fixes measured preparation overhead; it does not claim that every consumer scene is faster than its earlier renderer.

## v0.17.0 (2026-10-27)

공통 렌더러의 기본 backend를 WebGL 2로 전환합니다. Core instancing과 VAO를 사용하며 기존 analytic 도형과 공유 캔버스 순서를 유지합니다. 숫자 애니메이션 데이터 텍스처와 공유 pose atlas를 추가해 원본 SVG의 transform 채널·pivot·부모 계층을 GPU에서 평가합니다. CPU 소켓/부위 조회는 같은 채널의 Float64 데이터로 필요한 조상만 평가하고, 진행 중 중첩 전환·미지원 easing 등은 시계를 바꾸지 않고 명시적 CPU pose 경로를 사용합니다. Float render target 미지원/복구 실패도 CPU 숫자 텍스처로 처리합니다. 사용 비율·업로드·할당은 `MeshRenderer.poseStats()`로 구분합니다.

`player.preparePose()`, `MeshRenderer.preparePoses()`, `VectorContext.drawVectorAsset()`는 포즈 준비와 순서 보존 제출을 연결합니다. 종별 재정렬이나 메시 제거, 새 래스터 이미지 텍스처 시스템은 추가하지 않습니다. 독립 고정 브라우저 시나리오가 전환·표정/base pose·소켓/모프·반투명 paint·행 재사용/용량 증가·resize·context 복구·dispose를 CPU 참조와 비교합니다. 물리 모바일과 소비자 게임 전체 성능은 별도 검증 범위입니다.

**호환:** WebGL 2가 없는 환경에서는 생성이 실패합니다. 공개 시계/포즈/소켓 계약과 CPU 판정용 정밀도를 유지하며, GLSL ES 100의 기존 shader 입력은 device에서 ES 300으로 정규화합니다. WebGL 1/ANGLE 전용 backend 및 확장 객체에 의존한 직접 GL 호출은 core API로 이관해야 합니다.

## v0.16.0 (2026-10-27)

`vector-assets`가 소스 SVG 파일 자체가 기본 표정을 그리도록 강제합니다. `defaultExpression`의 `hide`에 있는 파트의 SVG 노드에는 `display="none"`이 있어야 하고, 그 밖의 노드에는 있으면 안 됩니다. 어느 쪽이든 어기면 컴파일 오류가 파트 id를 알려 줍니다. 컴파일러는 이 속성을 메모리 입력에서만 지우므로 모든 표정 변형은 이전과 같은 지오메트리로 컴파일되고, 런타임이 보임 여부를 정합니다. 표정이 여럿 들어 있는 SVG를 `<img>`나 미리보기로 열면 전부 겹쳐 보이던 문제가 없어져, 게임 UI가 아이콘·초상화·도감에서 원본 파일을 그대로 참조할 수 있습니다. 허용하는 `display` 값은 `none` 하나뿐입니다.

**호환:** 소스 바이트가 바뀌므로 숨겨야 할 표정이 있는 기존 SVG는 `display="none"`을 추가해야 하고 SHA-256도 달라집니다(`seed-scout.svg`는 컴파일된 지오메트리가 같고 해시만 바뀌는 것을 확인했습니다). 표정이 하나뿐이거나 `hide`가 빈 SVG는 그대로 컴파일됩니다. 검증 범위는 PR 기록을 따릅니다.

## v0.15.3 (2026-10-19)

`rendering`의 색 처리 비용을 줄였습니다. `normalizeColor`가 같은 CSS 색 문자열(hex·rgb()·hsl()·이름 색)을 매번 다시 파싱하던 것을 작은 캐시(512개 상한)로 재사용하고, `VectorRenderer`의 RGBA 검증은 draw마다 `Array.from`으로 배열을 만들던 것을 인덱스 루프로 바꿨습니다. `currentcolor`와 브라우저가 해석하는 이름은 문서 상태에 따라 달라져 캐시하지 않고, 반환 배열은 호출마다 새 사본이라 호출 쪽이 바꿔도 안전합니다. 파싱 결과와 오류 조건은 그대로입니다. 7가지 색을 40만 번 정규화하는 마이크로벤치가 207ms에서 28ms로 줄었고(Node 22 한 대), budmori-io 85마리 프로파일에서 두 함수가 렌더 CPU 상위였습니다. 브라우저 E2E와 실기기는 검증하지 않았습니다.

## v0.15.2 (2026-10-19)

`interpolation`의 지연 버퍼(`delayMs > 0`)가 캡처마다 엔티티별로 이력 항목을 구조분해로 복사하던 것을 없앴습니다. 교체되는 트랙은 다시 바뀌지 않으므로 이력 링에 그대로 넣고 자체 history만 떼어냅니다. 샘플 결과·시간·세대·reset 계약은 그대로입니다. 이전/이후 구현의 `sampleInto` 출력을 delay 0/50/100/200ms, reset·teleport·generation·revision 변경·소멸이 섞인 40개 무작위 시나리오로 비교해 불일치가 없었고, 100 엔티티 × 41 필드 · delay 50ms · 3000 캡처 마이크로벤치는 840ms에서 625ms로 줄었습니다(Node 22 한 대). 게임(budmori-io) 85마리 헤드리스 프로파일에서는 이 함수와 GC가 CPU 바쁜 시간의 약 절반이었습니다. 브라우저 E2E와 실기기는 검증하지 않았습니다.

## v0.15.1 (2026-10-18)

`rendering`의 `VectorRenderer`가 일반 solid/linear gradient 드로우에서 radial gradient 계산을 사용하지 않는 fragment shader pipeline을 선택합니다. radial shader와 픽셀, painter order, texture, clipping 동작은 기존 계약을 유지합니다. 기존 Chromium/WebGL E2E에서 pipeline 전환, radial 결과, clipping, context 복원과 자원 정리를 확인했습니다. SwiftShader 합성 측정은 mixed alternating에서 프레임 중앙값 40.32ms에서 20.77ms로 줄었고, radial-only는 127.60ms에서 128.04ms였습니다. 실물 GPU와 모바일 기기 성능은 검증하지 않았습니다.

## v0.15.0 (2026-10-18)

`pixel-physics`에 열린 월드(창 이동)와 뷰포트 렌더를 추가합니다. 격자는 고정 크기 창이고 큰 맵은 게임의 맵 데이터입니다. `shiftWindow(dx, dy, {load, evict})`가 셀·청크 플래그·발사체·엔티티·강체·핀·고정 조인트·정적 충돌체를 16의 배수 칸만큼 함께 옮기고, `scrollTo(focusX, focusY, hooks)`가 `stream: {margin, step}` 설정(미리 불러올 거리와 한 번에 옮기는 단위)에 따라 필요할 때만 옮깁니다. `readRegion`/`writeRegion`으로 맵 데이터를 일괄 읽고 쓰며, `hashCell(seed, x, y)`는 절대 좌표 기반 해시입니다. `writeGridPixels`와 `PixelRenderer`는 `view` 사각형만 쓰고 올리며(격자 밖은 배경), 음영은 절대 좌표 기준이라 창이 움직여도 같은 셀은 같은 색입니다. `enableCollapse`에 `anchorTop` 옵션을 추가했습니다(기본 꺼짐).

**호환:** `PixelWorld`의 snapshot과 `hash()`에 `originX`/`originY`가 들어가므로 이전 SDK가 만든 바이트는 `validatePixelWorld`가 거부하고, 같은 장면의 해시 값도 이전 버전과 다릅니다(origin이 0이어도). 버전이 섞인 방에서는 쓰지 마세요. 새 예제 `pixel-physics-open-world`(로켓)가 프리뷰 목록에 추가됩니다. 검증 범위는 PR 기록을 따릅니다.

## v0.14.3 (2026-10-18)

`RoomSession`이 퇴장 commit으로 로컬 피어를 roster에서 제거한 poll에서 join deadline 검사로 들어가지 않게 합니다. 커밋된 퇴장 ACK를 reliable queue에 flush하고 기존 retire 확인·연결 정리 순서를 이어갑니다. 고정 RTC E2E가 중복 leave 호출과 committed ACK, 5인 방 손님 퇴장 후 4→5 재입장, 기존 재연결과 호스트 퇴장을 확인합니다. wire protocol, snapshot/replay, 게임 규칙 계약은 바꾸지 않습니다.

## v0.14.2 (2026-10-18)

`deterministic`의 값 codec에 바이너리 형식 전용 typed array 태그(`Int8Array`·`Int16Array`·`Uint16Array`·`Int32Array`·`Uint32Array`·`Float32Array`·`Float64Array`, 요소는 little-endian, 실수는 유한 값만, `-0`은 `0`)와 `omitUndefined` 옵션을 추가합니다. 이전 SDK의 디코더는 새 태그가 든 payload를 읽지 못하므로 SDK 버전이 섞인 방에서는 쓰지 마세요. 기존 payload는 바이트 그대로 읽히고 같은 값의 인코딩 결과도 바이트가 같습니다. encode는 작업 버퍼를 재사용해 반복 호출에서 확장 복사를 없앱니다(격자 상태 인코딩 0.51~1.0ms → 0.15~0.27ms). `pixel-physics`의 `savePixelWorld`는 래퍼의 복사를 없애고(`snapshot(false)`) 새 태그를 직접 쓰며, 격자 배열을 같은 값 구간으로 줄여 저장합니다. 정지한 1280×720 월드의 스냅샷이 2.77MB에서 약 24KB로 줄어 히스토리 예산과 합류·복구 전송량이 크게 줄고, 구간이 줄지 않으면 원본으로 저장합니다. 이전 `savePixelWorld` 바이트는 새 `loadPixelWorld`로 읽을 수 없으므로 두 버전의 피어를 섞지 마세요. 수치는 Node 22 한 대에서 잰 값입니다.

## v0.14.1 (2026-10-18)

성능 개선 세 가지입니다. `deterministic`의 `hashBytes`가 이터레이터 대신 인덱스 루프를 써서 같은 FNV-1a 값을 약 20배 빠르게 계산합니다(695KB 17.9ms → 0.88ms, 체크섬 불변). `pixel-physics`는 첫 틱에 청크 sleep 판정을 한 번에 확정해, 큰 월드(1280×720)가 정지 상태에서도 약 3600틱 동안 전 청크를 돌리던 비용(틱 5.5ms → 0.15ms)을 없앱니다. 이 변경으로 첫 틱 이후 청크 스캔 집합이 달라지므로 같은 입력의 셀 시뮬레이션 결과가 이전 버전과 다를 수 있습니다. `rendering`의 `Renderer2D`는 RGBA 바이트 텍스처에서 알파가 모두 255이면 premultiply를 건너뛰고, `createTexture`의 `premultiplied:true` 선언과 `updateTexture`의 제자리 갱신·`{x,y,width,height}` 영역 갱신을 지원합니다. 수치는 Node 22와 소프트웨어 GL 헤드리스 Chromium 한 대에서 잰 값입니다.

## v0.14.0 (2026-10-18)

`pixel-physics`가 rollback·deterministic·rendering과 맞물립니다. `savePixelWorld`/`loadPixelWorld`/`validatePixelWorld`가 월드를 deterministic 값 코덱 바이트로 저장·복원하고, `writeGridPixels`가 격자를 rendering 텍스처로 올릴 RGBA로 씁니다. 엔티티는 `world.addEntity(body)`로 등록해야 하며 `world.bodies.push`로 넣은 엔티티는 바이트 저장에서 오류입니다. 스냅샷에 마스크 강체 셀·강체 크기·조인트 파라미터를 추가했습니다. rollback 모드는 `MatterBridge({checkpoint:1})`과 60Hz가 필요합니다. 검증은 Node syncTest와 헤드리스 Chromium 한 대이며 다른 기기 결정성과 큰 월드는 검증하지 않았습니다.

## v0.13.0 (2026-10-18)

픽셀·강체 물리는 `pixel-physics.js` 하나로 제공하고 Matter.js 0.19.0은 고정 웹 URL에서 가져옵니다. URL의 단일 원본은 소유 모듈의 dependencies.js이며 빌드·프리뷰·E2E가 공유합니다. Matter 엔진 소스는 GameKit 번들·예제 HTML에 포함하지 않습니다. 생성자는 `new MatterBridge(options)`이며 소비자는 별도 Matter import와 기존 첫 생성자 인자를 제거합니다. 별도 `pixel-physics-matter` 공개 모듈·npm 패키지 의존성·구 생성자 호환 경로를 제거합니다. 물리 계산·60Hz·체크포인트 계약은 유지하며 초기 실행에는 Matter 웹 URL 접근이 필요합니다.

## v0.12.3 (2026-10-18)

사용자가 제공한 PixelPhysics HTML에서 픽셀 재료·엔티티·강체 연동·Canvas 렌더링을 독립 `pixel-physics` ESM으로 이전합니다. Matter.js 0.19.0은 선택형 `pixel-physics-matter` 번들로 고정하며 플랫포머 예제와 단일 HTML 프리뷰를 함께 제공합니다. 원본 파일과 SHA-256은 모듈 출처 문서에 보존합니다. 물리의 시간 단위는 원본의 60Hz 고정 틱이며, Matter 스냅샷은 체크포인트 제약을 유지합니다. 서로 다른 브라우저·CPU 사이의 결정성이나 기존 rollback Adapter와의 통합을 보장하지 않습니다.

## v0.12.2 (2026-10-18)

`deterministic` 모듈에 count-only `createRollJob()` / `restoreRollJob()`을 추가해 PRD 대량 배치를 고정 성공 간격 예산으로 나누고 재개할 수 있습니다. job snapshot은 PRD·`SeededPRNG` state와 전체/처리/잔여 추첨 수, 누적 성공 수만 보존합니다. 기존 `roll()`·`rollMany()` 경로와 확률 분포는 유지하며, 고정 브라우저 시나리오는 작은 chunk의 중단·복원·chunk 크기 불변성과 0/1 경계를 확인합니다. Stage 61 규모에서는 yield가 동기 블로킹을 나눌 뿐 전체 처리 시간은 여전히 매우 깁니다.

## v0.12.1 (2026-10-18)

`deterministic` 모듈에 호출자가 소유한 결정론적 uint32 스트림용 `PseudoRandomDistribution`을 추가합니다. 선형 hazard `min(1, n * C)`의 계수를 설정 확률의 장기 평균에 맞춰 계산하고, 성공 후 실패 횟수를 초기화하며, 성공 횟수만 필요한 배치에서는 실패 간격을 건너뜁니다. 저장 상태에는 설정 확률·실패 횟수·대기 시도가 들어가며 PRNG 상태는 게임이 별도로 저장합니다. 고정 브라우저 시나리오는 평균과 분산, 연속 실패, seed 재현, 상태 복원, 확률 경계와 입력 검증을 확인합니다. 낮은 확률에서도 배치 비용은 실제 표본 성공 수만큼 처리됩니다.

## v0.12.0 (2026-10-18)

Adds a fixed-work-unit scheduler for resumable non-urgent tasks. It supports bounded per-task quanta, deterministic 4:2:1 priority rotation, duplicate-key coalescing, owner cancellation, and opt-in numeric diagnostics. Wall-clock timing never affects scheduling. The fixed browser scenario covers budget limits, resumption, fairness, cancellation, waiting-age counters, and FrameMetrics integration.

## v0.11.8 (2026-10-17)

Vector asset players accept a caller-owned `Set` of excluded part IDs on each `draw()` call.
Exclusions affect that draw only and preserve the player's expression, visibility state, and resolved pose cache.
Ordered mesh ranges and shader surfaces keep their painter order, alpha, clipping, and batch behavior.
The integrated browser checks cover face-only outline passes, unchanged body pixels, invalid exclusions, and shader-surface clip preflight.

## v0.11.7 (2026-10-17)

Interpolation reuses steady-state capture buffers and track records while keeping captured target snapshots detached.
Vector asset players cache resolved poses until playback or pose inputs change; public pose results remain detached copies.
Simloop drop notifications add exact dropped duration and reasons for clock gaps, input-dt clamps, backlog caps, and drop-policy trimming.
These additive telemetry fields do not change simulation timing or backlog policy behavior.
Core browser checks cover snapshot isolation, pose isolation, and drop telemetry. Allocation samples are CPU-only; GPU completion and physical mobile performance remain unmeasured.

## v0.11.6 (2026-10-17)

VectorContext adds a module-owned unit-quad renderer for full circles, ellipses, rectangles, and single-segment strokes.
It captures each shape's transform, color, alpha, stroke width, and cap or join style.
Full-ellipse fast paths defer arc point sampling unless the path later needs the existing vector fallback.
ANGLE devices batch compatible instances while preserving painter order and clipping.
Unsupported shapes keep the existing path fallback.
The fixed browser E2E checks real WebGL pixels, warm-frame tessellation, and instance-upload counters.
GPU completion time and physical mobile performance remain unmeasured.

## v0.11.4 (2026-10-17)

공통 코드 규칙을 Prettier와 ESLint로 검사합니다. 내부 const 바인딩을 UPPER_SNAKE_CASE로 정리하되 공개 export·import 이름, 객체 키, 클래스 이름, 함수 인자 수와 runtime 계약은 유지합니다. 소스·예제의 형식 정리로 비압축 배포 bytes가 바뀌므로 기존 불변 태그를 보존하기 위해 호환 PATCH를 발행합니다. API·wire protocol·게임 snapshot·replay 형식과 소비자 게임의 고정 버전은 바꾸지 않습니다.

## v0.11.3 (2026-10-17)

Rally에서 사용하던 범용 객체 풀을 독립 `object-pool.js`의 `ObjectPool`로 추출합니다. factory/reset/유휴 보관 상한과 LIFO acquire/release, 유휴 참조만 비우는 clear를 제공하며 게임별 상태와 buffer 수명은 포함하지 않습니다. 생성 설정만 검사하고 중복 반납·타입·외부 참조 해제는 소비자 계약으로 둡니다.

## v0.11.2 (2026-10-16)

Vector clip sampling skips a transition's source tree before its start and after it completes, avoiding repeat sampling and pose blending for settled historical transitions. Active transitions still blend from the prior tree to the target clip. Playback history remains retained for deterministic backward seeks, so this patch does not bound transition-history memory.

## v0.11.1 (2026-10-16)

`createRoomSession` adds an opt-in single-player local lockstep fast path. It preserves deterministic input/command execution and app-owned explicit saves while skipping SDK snapshot serialization/copies, checkpoint history, and state/input hashes when no peer can consume them. Existing local and online behavior is unchanged unless selected.

## v0.11.0 (2026-10-16)

The SVG compiler default changes to 4 curve segments and 2 round-stroke arc divisions. The exported frozen `VECTOR_ASSET_QUALITY_PRESETS` provides the `standard` 4/2 preset for most assets and the `smallAsset` 2/2 preset. Explicit 16/12 options retain the previous geometry; the supported range remains 1–64. Node compilation, the browser loader, the CLI, and the three-view example share these defaults.

## v0.10.7 (2026-10-16)

The SVG compiler accepts curve and round-stroke subdivisions from 1 through 64. The three-view quality example accepts direct integer input and offers quick presets. The existing defaults remain unchanged.

## v0.10.6 (2026-10-16)

Vector asset rendering no longer creates per-part morph arrays on the private draw path when those values are discarded; public `partPoses()` still returns independent mutable morph weights. The compiler adds `strokeArcDivisions` (4–64, default 12) for scaling and non-scaling round stroke tessellation, exposed through Node/browser compilation, browser loader caching, and the CLI. The default preserves prior stroke geometry.

## v0.10.5 (2026-10-16)

The vector asset compiler and browser startup loader add opt-in `normalizeCenteredViewBox` support for centered-local-coordinate SVG sources with legacy viewport dimensions and empty no-op clip poses. The compiler verifies the original source hash first, normalizes only its in-memory compiler input, drops only empty no-op poses from compiled metadata, and preserves the authored viewBox, paths, part pivots, sockets, and nonempty clip transforms. Source SVG files and the original-byte hash are unchanged.

## v0.10.4 (2026-10-16)

Vector assets add a standalone browser startup loader that verifies original SVG bytes, compiles them with the shared Node/browser core, deduplicates concurrent requests, and retains successful compiled geometry in a bounded cache. The production render bundle remains separate; the loader bundle includes no authored sample SVGs or precompiled sample geometry. Hash mismatches fail before compilation and caching.

## v0.10.2 (2026-10-16)

`createLoop` adds opt-in `backlogPolicy: 'defer'` for bounded real-time catch-up. It preserves unprocessed wall-clock debt up to `maxBacklogTicks`, keeps the existing per-pulse `maxCatchupSteps` limit, and reports dropped debt with explicit `clock-gap` or `backlog-overflow` diagnostics. It never skips authoritative simulation ticks. Existing `drop` default and unbounded opt-in `retain` behavior remain unchanged. Pause/resume and hidden-document reset behavior are documented and regression-tested.

## v0.10.0 (2026-10-16)

Rendering adds Canvas-compatible two-circle radial gradients to `VectorContext.createRadialGradient()` while retaining the creation transform and existing gradient texture lifecycle. `YarnSurfaceRenderer.drawSurface()` accepts an explicit `stencilRef` so retained Yarn fill and edge passes respect the active concave `VectorContext` stencil clip. Missing stencil attachments and invalid refs fail explicitly. Existing meshes and `MeshRenderer` batching semantics are unchanged. Focused browser pixel checks cover the Squish radial-gradient descriptor at 47 CSS px/DPR 1 and 74 CSS px/DPR 2, plus concave Yarn clipping and context restoration.

## v0.9.0 (2026-10-16)

Rendering adds endpoint-preserving linear gradient paints, retained single-contour stencil clips for full-detail concave paths, and safe mixed-alpha run instancing for disjoint bounds. `MeshRenderer.stats()` reports flush-boundary and actual draw-dispatch reasons. Unsupported clip shapes or unsafe batch bounds keep their explicit error or ordered fallback behavior.

## v0.8.0 (2026-10-16)

Rendering adds a generic `indexVariants` map for host-selected named triangle ranges. Vector asset `expressionIndices` remain semantic and are validated against authored expression names; the two maps are retained and rendered independently with explicit collision checks. `MeshBuilder.combine()` preserves semantic expression lists and rejects painter-order range maps that cannot be flattened without changing host paint order.

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

[프리뷰 목록](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/index.html)은 모든 예제를 포함합니다. [previews.mjs](../previews.mjs)의 EXAMPLES가 목록입니다. 원본 예제는 소유 모듈 아래에 있으며 API 설명만 있는 모듈에 빈 데모를 만들지 않습니다.

기존 html-share 문서처럼 HTML Preview를 사용합니다. 원본 ESM 예제를 직접 열면 상대 import와 module 실행이 실패하므로 `npm run build:previews`가 각 예제를 독립 IIFE script가 포함된 HTML 하나로 묶습니다. 예제 간 링크는 공개 프리뷰 URL로 변환합니다. PixelPhysics는 HTML Preview가 `type="module"`을 지우고 classic script로 다시 만들어 정적 import가 실패하므로 IIFE 안에서 정의된 Matter 웹 URL을 실행 직전에 동적 `import()`로 받으며 엔진 코드를 HTML에 넣지 않습니다. 나머지 예제는 외부 SDK import·CDN·공유 chunk가 없습니다. 소스 보기 링크는 GitHub 파일로 연결합니다. `dist/*.js`의 독립 ESM 계약과 프리뷰 빌드는 별개입니다.

같은 main CI가 생성 HTML만 별도 `previews` 브랜치에 게시합니다. SDK bytes가 그대로인 예제 수정은 프리뷰만 갱신합니다. 새 계정·토큰·유료 호스팅·Pages 설정은 필요하지 않습니다. 프리뷰는 최신 main의 예제이며 불변 SDK 릴리스 URL과 혼동하지 마세요. Nostr 온라인 예제는 여전히 공용 relay·NAT 환경 영향을 받습니다. 오디오 재생에는 사용자의 시작 동작이 필요합니다.

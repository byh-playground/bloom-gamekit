# debug-tools

## 언제 쓰나

- **같은 장면을 주소 한 줄로 열어** 확인·캡처하고, 작업 전후 수치(체크섬·틱 시간)를 비교하고 싶을 때: `installDebugHost`. `?debug=1&scene=<이름>&tick=<N>&…`이면 장면을 N틱 진행해 그린 뒤 `window.__bloomDebug`에 `ready`·`state(options)`·`step(n)`을 엽니다. 검증용 장면을 임시 스크립트로 새로 짜기 전에 이것부터 씁니다.
- 같은 주소가 **같은 그림**을 그려야 할 때: 장면이 두 번째 인자의 `freezeClock()`을 부르면 호스트가 `performance.now`를 고정 시작 시각의 가상 시계로 바꾸고 장면을 닫을 때 되돌립니다. 틱 시간은 `realTime(fn)` 안에서 실제 시계로 잽니다.
- 그 주소를 **명령줄에서** 열어 상태 JSON·캡처·두 체크아웃(또는 두 주소) 비교·틱당 할당을 뽑을 때: Node 도구 `dist/debug-scene.mjs`의 `runDebugScene`. 게임은 Playwright `chromium`과 체크아웃을 띄우는 `serve` 하나만 넘깁니다.
- 프레임·단계별 CPU 시간을 재고 싶을 때(`FrameMetrics`, `PerformanceProfiler`), 오류를 모아 복사 가능한 진단으로 보여 주고 싶을 때(`DiagnosticRing`·`copyDiagnostic`).
- 리플레이 탐색 조작(`ReplayTimeline`), 두 상태에서 고른 필드만 비교(`compareStateFields`).

## 쓰는 모양

```js
// rally-frontier/src/main.js (줄임): 주소에 debug가 있을 때만 장면 모듈을 불러온다
const { createDebugScenes } = await import('./debug-scenes.js');
const debug = RallyGamekit.installDebugHost({
    scenes: createDebugScenes({ createRenderer, createScenario: RallyGamekit.createScenario, createPresentationView }),
});
await debug.done;

// rally-frontier/src/debug-scenes.js (줄임): 장면 하나. 두 번째 인자에서 가상 시계를 받는다
'walnut-melee'(params, { freezeClock }) {
    const clock = freezeClock(); // 이 장면이 닫힐 때까지 performance.now가 가상 시계
    return {
        step() {
            clock.advance(1000 / run.sim.tps); // 가상 시계를 한 틱만큼
            clock.realTime(() => run.step()); // 틱 시간은 실제 시계로 잰다
        },
        render: () => run.render(),
        state: (options) => ({ simTick: run.sim.tick, checksum: run.sim.checksum(), ...log.state(options?.times) }),
        hash: () => run.sim.checksum(),
        dispose: () => run.dispose(), // 시계는 호스트가 되돌린다
    };
},
```

```js
// rally-frontier/scripts/debug-scene.cjs (to-be, 줄임): 게임 쪽 실행기는 설정만 넘기는 얇은 파일
const { runDebugScene } = await import(pathToFileURL(path.join(cacheDirectory(root), 'debug-scene.mjs')).href);
await runDebugScene({
    chromium, // 게임의 Playwright. 모듈은 번들하지 않는다
    argv: process.argv.slice(2),
    root,
    async serve(checkout) {
        const qa = require(path.join(checkout, 'scripts', 'netcode-qa-module.cjs'));
        const server = await qa.serveSource(path.join(checkout, 'index.html'));
        return { url: server.url, route: (page) => qa.routePinnedSDK(page), close: server.close };
    },
    ready: () => !document.body.classList.contains('boot-loading'),
    viewport: { width: 540, height: 900 },
    fields: ['checksum', 'tickMs.mean', 'tickMs.p95', 'stageMs.mean.collision', 'overlap.pairs'],
});
```

```text
?debug=1&scene=walnut-melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&walnuts=5&tick=300
node scripts/debug-scene.cjs "scene=walnut-melee&…&tick=300" --state '{"times":true}' --compare ../rally-base --repeat 3
```

- 이 모듈 자신의 실행 예: [통합 예제의 "접촉" 탭](../work-scheduler/examples/index.html)이 장면 `contacts`로 등록돼 있습니다(`?debug=1&scene=contacts&budget=1&tick=100`). 명령줄은 [scripts/debug-scene.mjs](./scripts/debug-scene.mjs)(`npm run build` 뒤 `node modules/debug-tools/scripts/debug-scene.mjs "scene=contacts&budget=1&tick=100" --capture out.png`).
- 발배구 예: `bloom-takraw/src/debug-scenes.js`의 `watch`(가상 시계로 AI 경기 틱 진행)·`spike`(고정 카메라 캡처)·`club`(메모리 저장 클럽 화면) 장면. `match`는 실제 시간으로 돌므로 `freezeClock`을 부르지 않습니다.

## 쓰지 말아야 할 때

| 이런 일                                          | 대신                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 원격 수집(telemetry)·서버 전송                   | [metrics](../metrics/README.md). 이 모듈은 네트워크를 쓰지 않습니다                                |
| 게임 안 격리 실행 자체(재생·반복·정확한 한 tick) | [scenario](../scenario/README.md) (장면 안에서 씁니다)                                             |
| 전체 상태 hash로 결정론 확인                     | [deterministic](../deterministic/README.md) `runSyncTestAsync`, [replay](../replay/README.md)      |
| 장면이 쓰는 저장소·네트워크 격리                 | 게임 책임입니다. 호스트는 저장소를 건드리지 않습니다                                               |
| 통과·실패를 판정하는 영구 시험                   | 게임의 고정 시나리오 E2E. 실행기는 수치만 내고 판정하지 않습니다                                   |
| `Date`·`requestAnimationFrame`까지 고정          | 게임이 직접 멈춥니다(예: 발배구 `watch`가 rAF 루프를 끔). 가상 시계는 `performance.now`만 바꿉니다 |

## 상세

로컬 진단과 SDK replay adapter만 제공합니다. 네트워크·telemetry·storage·자동 저장파일 수집·시뮬레이션 history를 만들지 않습니다.

TypeScript 공개 선언은 [index.d.ts](./index.d.ts)에 있습니다.

- `DiagnosticRing({capacity=20,now=()=>performance.now(),release=''})`: 고정 배열 진단 ring입니다. `report(error,{kind,visibility,fatal,origin,...})`, `snapshot()`, `format()`, `installGlobal(...)`, `clear()`, `dispose()` 메서드를 제공합니다. 기본 문자열·stack만 기록하며 arbitrary object는 직렬화하지 않습니다.
    - `visibility`는 `log | notice | blocking | fatal` 중 하나입니다. 생략하면 기존 report 호출과의 호환을 위해 `blocking`이며, `fatal: true`는 항상 `fatal`로 분류합니다. `visibility: 'fatal'`도 기존 소비자가 보는 `record.fatal: true`를 설정합니다.
    - 네 분류는 모두 ring에 기록됩니다. snapshot v2의 `counts.total`은 수락된 report 수(밀려난 record 포함), `counts.retained`와 `counts.log/notice/blocking/fatal`은 ring에 남은 report 수(동일 진단의 `count` 포함)입니다. `blockerCount`는 retained `blocking + fatal` 수로, `log`와 `notice`는 포함하지 않습니다. 기존 `total`, `dropped`, `errors` 키와 각 record의 `fatal`은 유지됩니다. `dropped`는 용량 초과로 밀려난 record와 재진입으로 기록을 버린 수입니다.
    - 분류와 카운트는 진단 데이터만 제공합니다. badge·패널 표시와 gameplay 중단은 소비자가 결정하며 `log`/`notice`를 자동으로 숨기거나 `fatal`에서 자동 정지하지 않습니다.
- `ring.installGlobal(eventTarget,{onReport?}) → cleanup`(`DiagnosticRing`의 메서드이며 따로 내보내는 함수가 아닙니다): 받은 오류를 그 ring에 `report`하는 error/unhandledrejection listener만 추가합니다. 기존 onerror를 덮어쓰거나 preventDefault 하지 않습니다. fatal 상태에서 게임을 정지할지는 게임이 결정합니다. cleanup/dispose가 listener를 제거합니다.
- `redactDiagnostic(text,limit=1600)`: URL/로컬 경로/email/token/password 키를 best-effort 마스킹합니다. 완전한 개인정보 제거 보증이 아니므로 공유 전 사용자가 내용을 확인해야 합니다. 외부 전송은 하지 않습니다.
- `await copyDiagnostic(text,{clipboard,textarea})`: clipboard 성공은 copied:true. 거절되면 supplied textarea 선택 또는 portable text를 반환하며 copied:false입니다. DOM을 숨기거나 자동 다운로드하지 않습니다. UI 경합/패널의 focus 정책은 caller가 소유합니다.
- `ReplayTimeline({read,seek,setPlaying})`: read는 `{tick,firstTick,lastTick,playing}`을 반환합니다. readInto(out), seek(tick), step(delta=1), setPlaying(boolean)이 실제 SDK replay adapter에 위임합니다. bounds clamp만 하고 snapshot/history를 저장하지 않습니다.
- `compareStateFields(left,right,[{name,read,equal?}],{maxDifferences=100})`: 선택한 primitive 필드만 비교·마스킹합니다. 기본 Object.is, 구조화 값은 명시적 comparator가 필요합니다. 반환은 equal/mismatches/truncated/differences입니다. 완전한 state hash는 SDK 결정론 도구를 쓰세요.
- `PerformanceProfiler({capacity=120,now,maxStages=64})`: **opt-in** 로컬 프레임 프로파일러입니다. `setEnabled(true)` 뒤 `beginFrame(meta)`, `stage(name,durationMs,metadata)`, `count(name,value)`, `measure(name,fn,metadata)`, `endFrame(meta)`를 사용합니다. `snapshot({limit=30})`은 최근 bounded samples와 frame/stage p50·p95·max 요약을 반환합니다. 고정 ring으로 최근 capacity 프레임을 시간순 반환하며, limit는 반환 sample 수만 제한합니다. `limit:0`은 빈 frames와 전체 retained 요약을 반환합니다. maxStages는 한 프레임의 stage 이름과 counter 이름을 각각 제한하며, 한도에 도달하면 새 이름은 false를 반환하고 기존 이름 누적은 계속합니다. 요약은 값 배열을 한 번 정렬하여 p50/p95를 함께 구합니다. metadata는 redacted primitive 최대 8개만 허용하며 게임 상태·snapshot·DOM·네트워크 payload를 보관하지 않습니다. 꺼져 있을 때 `measure`는 clock을 읽지 않고 operation만 실행합니다. 게임은 실제 구간 이름을 소유하고, renderer는 필요할 때 이 plain hook을 선택적으로 연결합니다.

Budmori의 local diagnostic bootstrap에서 입증된 오류 redaction/ring/copy-fallback 동작과 Rally replay-control 경계를 참고해 새로 작성했습니다. 기존 게임의 저장 정책·fatal UI를 가져오지 않습니다. 원본에 없는 라이선스를 새로 부여하지 않습니다.

report context의 source/line/column/workerTimeMs/cause도 제한된 generic metadata로 지원합니다. source/cause는 redaction, 위치는 비음수 safe integer, worker 시간은 유한 비음수로만 저장합니다.

CPU·보유 heap의 전후 비교와 재현 명령은 [비용 측정](./docs/cost-measurement.md)에 있습니다.

## 숫자 전용 프레임 계측

`FrameMetrics({capacity=240, stages=[], counters=[], now})`는 이름을 생성 시 등록하고 두 Float64Array를 재사용합니다.
`beginFrame(rafTimestampMs)` → `stage(name, durationMs)`/`count(name, amount=1)` → `endFrame()` 순서입니다.
프레임 경로에 객체 샘플·Map 생성·로그·JSON을 만들지 않습니다. 기존 metadata 기반 PerformanceProfiler는 그대로 유지합니다.
CPU stage는 호출자가 실제 구간과 포함 관계를 소유합니다. 자식과 부모 시간을 합산하지 않습니다. GPU 완료 시간은 측정하지 않습니다.

명시적으로 `snapshot({limit=0})`을 부를 때만 프레임과 mean/p95/max/total, 보관한 히치(`hitches`·`hitchTotal`)를 구성합니다.
intervalMs는 실제 RAF 간격, cpuMs는 begin/end 사이 CPU wall 시간이며 둘을 더하지 않습니다. windowMs는 보유한 양의 RAF 간격 합계입니다.
히치는 같은 프레임의 stage/count를 보존합니다. 0 stage는 측정하지 않았다는 뜻이 아니므로 상세 측정 활성 여부는 소비자가 함께 표시해야 합니다.
필수 카운터와 상세 계측의 활성 정책·진단 UI·저장은 게임이 소유합니다. clear()는 새 진단 세션을 시작합니다.

RAF 간격은 다음 beginFrame에서 직전 샘플에 확정하므로 느린 구간과 그 구간을 시작한 콜백의 stage/count가 일치합니다. 최신 샘플은 intervalMs=0인 미완료 간격입니다. 콜백 밖의 stage/count는 직전 RAF 구간에 기록하되 cpuMs(콜백 내부)에는 합산하지 않습니다.

## 튄 프레임(히치) 보관

사용자가 "가끔 멈칫한다"고 느낀 뒤 몇십 초 지나 진단을 복사해도 그 프레임이 남아 있게, 간격이 기준을 넘은 프레임만 링과 따로 보관합니다. 소비자는 아무것도 더 부르지 않습니다(위 begin/stage/count/end 그대로).

```js
// 발배구가 붙일 모양(to-be, 줄임). RenderStats는 three-kit의 FrameMetrics 감싸개입니다.
this.renderStats = new RenderStats(this.renderer, { stages: ['sim', 'render'], counters: ['jump', 'kick'] });
// 프레임 루프
stats.begin();
stats.metrics.stage('sim', simMs);
if (jumpedThisFrame) stats.metrics.count('jump');
stats.metrics.stage('render', renderMs);
stats.end();
// 탭이 숨겨졌다 돌아올 때
document.addEventListener('visibilitychange', () => document.hidden || stats.metrics.skipInterval());
// 진단 복사
lines.push(view.renderStats.line(), view.renderStats.metrics.hitchText());
```

```text
hitches 2 (kept 2/24) rule >=100ms or >=2.5x median, <1000ms; now t=78.4s
#2210 t=41.2s 136.7ms (median 16.7) cpu=120 sim=1.1 render=118.4 drawCalls=28 triangles=51234 programs=15 textures=9
  before #2207 16.7ms sim=1 render=2 drawCalls=28 … | #2208 … | #2209 16.6ms sim=1.2 render=2.1 jump=1 drawCalls=28 …
```

- 기준(`hitch` 옵션): 간격 ≥ `ms`(기본 100) **또는** 간격 ≥ 최근 15간격 중앙값 × `medianFactor`(기본 2.5), 단 간격 < `maxMs`(기본 1000). 중앙값은 15간격이 모인 뒤부터 씁니다.
    - 2.5배: 프레임 하나가 빠지면 간격이 2배(60Hz 33ms, 120Hz 16.7ms), 둘이 빠지면 3배(50ms, 25ms)입니다. 그 사이에 두어 화면 주사율과 상관없이 "연속 두 프레임 이상 빠짐"부터 잡고, 흔한 한 프레임 빠짐은 보관함을 채우지 않게 했습니다.
    - 100ms: 기기 전체가 느려 중앙값이 커진 경우(30fps면 2.5배가 83ms)에도 0.1초 넘는 멈춤은 늘 잡습니다. 절대 기준을 50ms로 두면 30fps 기기의 한 프레임 빠짐(66ms)이 모두 히치가 됩니다.
    - 1000ms 이상은 탭 숨김·일시 정지로 보고 히치로도, 중앙값에도 넣지 않습니다. 1초보다 짧은 숨김이나 멈춤 화면은 호출 쪽이 `skipInterval()`로 다음 간격을 끊습니다.
- 간격은 다음 `beginFrame`에서 확정되므로 히치 행은 "그 간격을 시작한 콜백"의 stage/count입니다. cpu가 간격과 비슷하면 콜백 안(게임 코드)이 오래 걸린 것이고, cpu가 작은데 간격만 크면 콜백 밖(GC·합성·GPU 대기·브라우저)입니다.
- 히치 한 건마다 그 프레임과 직전 `before`(기본 3)프레임의 전체 행을 복사합니다. 입력이 든 프레임과 튄 프레임이 한두 프레임 어긋나도 `before`에서 보입니다. 보관함은 최근 `capacity`(기본 24)건이고 `hitchTotal`은 밀려난 것까지 셉니다. `capacity: 0`이면 보관하지 않습니다.
- 기록 경로는 할당이 없습니다. 판정은 15칸 Float64Array 삽입 정렬, 보관은 생성 때 잡은 Float64Array에 숫자 복사입니다. `hitches()`(객체 배열)와 `hitchText({limit})`(첫 줄 기준·건수, 한 건 두 줄, 0인 stage·counter 생략)는 부를 때만 할당합니다. `clear()`가 보관함도 비웁니다.
- 브라우저별로 갈리는 GPU 완료 시간·`PerformanceObserver`(longtask)는 넣지 않았습니다.

## 주소로 장면 열기 (디버그 호스트)

`installDebugHost({scenes})`는 주소에 `debug`가 있을 때만 `window.__bloomDebug`를 설치하고, 없으면 `null`을 반환해 아무것도 하지 않습니다. AI나 사람이 같은 주소로 같은 장면을 열어 캡처하려는 용도입니다.

```js
installDebugHost({
    scenes: {
        battle({ units, enemy }) {
            // units, enemy는 주소에 적힌 문자열 그대로입니다.
            const GAME = startMatch({ seed: 42, units: Number(units), enemy });
            return { step: () => GAME.step(), render: () => draw(GAME), state: () => ({ score: GAME.score }) };
        },
    },
});
```

```
?debug=1&scene=battle&units=12&enemy=boss&tick=300
```

- 호스트가 읽는 파라미터는 `debug`, `scene`, `tick`뿐입니다. `tick`이 있으면 장면의 `step()`을 그 횟수만큼 부른 뒤 `render()`하고 `ready`를 올립니다. 나머지 파라미터는 `params`로 장면 함수에 문자열 그대로 갑니다. 시드·개수·적 종류처럼 무엇을 받을지는 장면이 정합니다.
- 타입·범위 선언이나 기본값은 없습니다. 잘못된 값은 장면 안에서 그대로 실패하거나(예: 없는 값이 `undefined`로 터짐) 그대로 쓰입니다(`Number('abc')`는 `NaN`). 호스트가 대신 바로잡지 않습니다.
- 호스트 자신의 실패(없는 장면, 장면 함수가 던짐, `tick`이 음이 아닌 정수가 아님)는 `ready`를 올리지 않고 `error`에 담고 콘솔에도 냅니다. 기다리는 쪽은 `ready || error`를 조건으로 삼으세요.
- `state(options)`는 `scene`, `params`, `tick`에 장면의 `state(options)` 필드를 합쳐 돌려줍니다. `options`는 호출한 쪽이 준 값 그대로 장면에 가고 호스트는 읽지 않습니다(예: 틱별 시간 배열을 `state({ times: true })`일 때만 냄). 화면에 보이는 것과 일치하는 간결한 필드만 담으세요. `step(n)`은 장면을 n틱 더 진행한 뒤 한 번 그리고, `dispose()`는 장면을 정리하고 전역을 지웁니다.
- 장면이 쓰는 저장소·네트워크의 격리는 게임 책임입니다. 호스트는 저장소를 건드리지 않습니다.

### 가상 시계 (`freezeClock`)

장면 함수는 `(params, { freezeClock })`를 받습니다. `freezeClock()`을 부르면 그때부터 `performance.now()`가 가상 시계를 읽습니다.

- 가상 시계는 매번 같은 값(10,000,000ms)에서 시작하고 `advance(ms)`로만 갑니다. 절대 시각으로 움직이는 연출(깜박임·흔들림)도 같은 주소면 같은 그림이 됩니다. 시작 값이 페이지가 이미 읽은 실제 시각보다 크므로 시간이 거꾸로 가지 않습니다. 페이지가 열린 지 그보다 오래 지났으면 던집니다.
- `realTime(fn)`은 `fn`을 실제 `performance.now`로 실행하고 결과를 돌려줍니다. 틱 시간처럼 실제로 재야 하는 것만 그 안에서 잽니다(동기 함수만).
- 장면의 `dispose()`가 끝나거나 장면 열기가 실패하면 호스트가 `performance.now`를 원래대로(자기 속성이 없던 상태면 지워서) 되돌립니다. 그 뒤의 `advance`·`realTime`은 던집니다. 한 페이지에서 한 장면만 시계를 가질 수 있습니다.
- 바꾸는 것은 `performance.now`뿐입니다. `Date.now`·`requestAnimationFrame`·rAF 타임스탬프는 그대로이므로, 자기 rAF 루프로 시뮬을 돌리는 게임은 장면을 열 때 그 루프를 멈춥니다(발배구 `watch`). 실제 시간으로 돌아야 하는 장면(발배구 `match`)은 부르지 않습니다.
- 주소에 `debug`가 없으면 호스트가 설치되지 않으므로 아무것도 바뀌지 않습니다.

## 명령줄 실행기 (`dist/debug-scene.mjs`)

`runDebugScene({ chromium, argv, root, serve, ready?, fields?, viewport? })`가 주소 하나를 헤드리스 Chromium으로 열고 `__bloomDebug.ready || error`를 기다린 뒤 결과를 출력하고, 실행 기록 배열로 resolve합니다. 시험이 아닙니다(판정·종료 코드 규칙 없음, 오류만 reject). 형식은 [scene-runner.d.ts](./scene-runner.d.ts)에 있습니다. 브라우저 번들과 같은 dist commit에 고정해 내려받습니다(`https://raw.githubusercontent.com/byh-playground/bloom-gamekit/<distCommit>/debug-scene.mjs`, manifest.json에 SHA-256).

- 게임이 넘기는 것: Playwright `chromium`(모듈은 Playwright를 번들하거나 찾지 않습니다), `serve(checkout) → { url, route?(page), close() }`(체크아웃 하나의 로컬 서버와 고정 GameKit 파일을 로컬로 돌리는 route), 선택 `ready`(로딩 화면이 걷혔는지 같은 페이지 조건), `fields`(비교 표에 넣을 state 경로, 점 구분), `viewport`.
- 명령줄: `"<주소의 ?debug=1& 뒤>" [--ticks N] [--state <json>] [--capture out.png] [--compare <체크아웃>] [--compare-query "<주소>"] [--repeat N] [--heap] [--gpu] [--json]`.
    - `--ticks N`: 준비 뒤 `step(N)`을 더 부릅니다. `--state <json>`: `state(JSON)`으로 읽습니다.
    - `--capture`: PNG. 비교 때 B 쪽은 `<이름>-compare.png`(첫 라운드만).
    - `--compare <체크아웃>`·`--compare-query "<주소>"`: 다른 체크아웃(같은 주소) 또는 같은 체크아웃의 다른 주소를 B로 돌립니다. 둘 다 줄 수도 있습니다. `--repeat N`번 라운드를 돌며 라운드마다 먼저 도는 쪽을 바꿉니다. 각 쪽의 경로·커밋·미커밋 변경 여부를 먼저 찍고 `hash()`와 `fields`의 요약 표를 냅니다. 원시 기록 JSON은 `--json`일 때만 냅니다.
    - `--heap`: `step(N)`과 같은 상태를 한 번 더 그리는 `step(0)`의 할당을 Chrome 표본 힙 프로파일러(수거된 객체 포함, 1KB 간격)로 각각 재어 `perTickBytes = (step − render) / N`을 냅니다. 게임 훅 없이 렌더 몫을 빼는 방법이며 표본 추정이라 실행마다 조금 다릅니다. `--ticks N`(N > 0)이 필요합니다.
    - `--gpu`: ANGLE D3D11(실제 GPU, 타이밍·체감용). 기본은 SwiftShader라 같은 주소의 캡처가 픽셀까지 같습니다.
- 한 번 실행이면 state JSON(+ `heap`, `pageErrors`)을 출력합니다.

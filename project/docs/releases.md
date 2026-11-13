## v0.60.0 (2026-11-13)

호환되지 않는 변경(MINOR). metrics의 경기 시작과 경기 기록을 한 번호(matchId)로 잇고, 수집 서버의 보내기·조회를 막습니다. 게임 미배포라 호환 래퍼 없이 API를 바로 바꿉니다. 배치 봉투는 schema 3 그대로(필드 추가 없음, 시작 이벤트의 `props.matchId`·`record`는 이벤트 props)라 공개 중인 발배구 빌드의 배치도 그대로 받습니다.

- 클라이언트: `metrics.beginMatch(options, Recorder = MatchRecorder)`가 시작 이벤트 `match:<mode>:start`(props `{ matchId }`)를 보내고 recorder를 돌려줍니다. `recordMatch`는 `beginMatch`가 돌려준 recorder만 경기마다 한 번 받습니다(직접 `new`한 recorder는 `TypeError`). 끝을 기록하지 않는 모드는 `beginMatch({ mode, record: false })`. 게임이 보내던 `track('match', mode, 'start')`와 `new …Recorder()`의 두 갈래가 없어집니다.
- 크기 상한(`protocol.js` 한 곳, 서버도 같은 값): props 2000·summary 8000·players 4000·replay 900000바이트. `track`은 자동 플러시에서 던지지 않습니다(배치 상한을 넘으면 버리고 `droppedBatches`에 셈). seq는 보관함에 넣을 때만 늘어 버린 배치 때문에 구멍이 나지 않습니다.
- 서버 완주율: 시작을 서로 다른 matchId 수로 셉니다(온라인 두 참가자 같은 경기 1, 재경기 따로, `record: false` 제외, matchId 없는 옛 시작은 하나씩).
- 서버 보내기 방어: 허용 출처(`ALLOWED_ORIGINS`, Origin 없는 요청 거절, 로컬 개발 출처는 늘 허용)·등록된 게임(`ALLOWED_GAMES`)·회선당 횟수 제한(Workers Rate Limiting, 60초 60배치)·같은 sessionId의 다른 게임 배치 거절(409)·값 크기(400 `size`).
- 서버 조회: `/stats`·`/daily`는 `Authorization: Bearer <STATS_KEY>`(Worker 비밀값, 일정 시간 비교)가 있어야 하고 비밀값이 없으면 500입니다. `/stats`도 `days`(1~90, 기본 30) 기간만 읽습니다(전에는 전체 기간). 집계 칸에 `bot`(user_agent 로봇 표시, 또는 한 번도 보인 적 없는 세션)을 더했습니다. 우선순위 owner → dev → bot → users.
- D1 0003: `matches.client_ended_at`(받고도 버리던 `match.t` 원본)과 `matches(session_id)` 인덱스.
- 문서: README "쓰는 모양"·사용·게임에 붙이는 순서를 새 API로, `index.d.ts`의 `locale` 누락, 저장 열·오류 이름 예시·heartbeat·읽기 행 설명을 바로잡고 "보내기 방어"·"조회 키" 절을 더했습니다.
- 예제: 지표 탭이 첫 랠리에서 경기를 시작해(전에는 연결 때와 경기 끝마다 시작 이벤트를 보내 시작이 경기의 두 배로 셌음) 조회 키 칸으로 서버 집계를 읽습니다.
- 시험: 고정 시나리오를 바뀐 흐름(Origin·게임·조회 키·bot·409·`client_ended_at`·`beginMatch` 온라인 시작 1)에 맞췄습니다. 횟수 제한(429)은 시나리오에 넣지 않았습니다.
- 배포 순서(서버가 게임보다 먼저): `wrangler secret put STATS_KEY` → `d1 migrations apply --remote`(0003) → `wrangler deploy`. 무료 요금제에서 Rate Limiting binding이 배포되는지는 공식 문서에 요금제 제한이 적혀 있지 않아 배포 때 확인합니다.

## v0.59.1 (2026-11-13)

three-kit `warmUp`이 셰이더 컴파일뿐 아니라 버퍼·텍스처 업로드까지 로딩 때 끝냅니다(PATCH, 공개 API 모양 그대로). 첫 소비자인 발배구를 모듈로 옮기다 드러났습니다(DEV-032): v0.59.0의 `warmUp`은 숨긴 객체를 켜고 `renderer.compile`만 불러, 숨겨 둔 메시(입자·표시 레이어)의 geometry·인스턴스 버퍼와 텍스처가 경기 중 처음 그려질 때 GPU에 올라갔습니다. 발배구의 옛 구현은 숨긴 객체를 켠 채 한 번 실제로 그려 이 업로드까지 끝냈습니다.

- three.js 소스(GitHub 태그 r180, r170도 같은 구조)로 확인: `renderer.compile`은 프로그램만 만듭니다. 버퍼는 `render`의 `projectObject` → `WebGLObjects.update` → `WebGLAttributes.update`(처음이면 `createBuffer`가 배열 전체를 `bufferData`), 텍스처는 `setProgram`의 uniform 올리기 → `WebGLTextures.setTexture2D`에서 올라갑니다. `InstancedMesh`는 `count`가 0이어도 이 업로드를 하고 마지막 `drawArraysInstanced`만 건너뜁니다(`primcount === 0`). 프로그램 키는 렌더 타깃이 `null`일 때만 `outputColorSpace`·`toneMapping`을 씁니다.
- `warmUp(renderer, scene, camera)`: 숨긴 객체를 켜고(`frustumCulled`도 잠깐 끔) 렌더 타깃을 화면으로 두고 scissor 1픽셀로 줄여 `compile` 뒤 `render`·`clear` 한 번. `finally`로 숨김·`frustumCulled`·렌더 타깃·scissor·`shadowMap.needsUpdate`·`info.render`의 그리기·삼각형·점·선 수를 되돌려 `RenderStats` 프레임 합계에 섞이지 않습니다. 숨긴 객체가 보이는 프레임은 없고 왼쪽 아래 1픽셀만 지운 색이 됩니다. 인스턴스 수 0인 `InstanceLayer`도 버퍼 전체가 올라가서 레이어 쪽 준비 호출은 없습니다. 옵션·갈래는 늘리지 않았습니다. 소비자 고유 준비(예: 화면 복사 패스)는 `warmUp` 뒤에 자기 코드로 부릅니다.
- README: `warmUp`이 하는 일·하지 않는 일을 소스 근거와 함께 고치고, 같은 `extend.key`를 쓰는 `InstanceLayer`끼리는 프로그램이 공유되고 재질 객체만 레이어마다 생긴다는 한 줄을 더했습니다(동작 변경 없음).
- 예제·시험: three.js 탭이 GPU 할당(`createBuffer`·`bufferData`·`createTexture`·`texStorage2D`·`texImage2D`) 수를 보여 주고, 미리보기 시나리오가 `warmUp` 뒤 숨겨 둔 바닥 표시를 처음 그려도(표시 수를 늘려도) 할당이 늘지 않는지 봅니다. 고정 시나리오에 `warmUp`의 상태 복구(오류가 나도)를 더했습니다.

## v0.59.0 (2026-11-13)

새 모듈(MINOR). three.js로 3D를 그리는 게임(발배구 r180, 와르르냥 r170, 디그모리)이 함께 쓸 코드를 `three-kit`으로 올립니다. 발배구 v0.19.3(`6896477`)의 `render-stats.js`·`view.js`의 `warmUp` 일반 부분·`instanced-effects.js`의 일반 부분·`rigid-batch.js`·`merge-geometry.js`가 출처이고, 기존 모듈의 결과는 바뀌지 않습니다. 발배구 적용은 다음 단계입니다.

- `RenderStats`(렌더 제출량, debug-tools `FrameMetrics` 소스 포함)·`warmUp`(숨긴 객체 포함 미리 컴파일)·`InstanceLayer`·`mergeShapes`(인스턴스 투명도·모양 고르기)·`RigidBatch`(`SkinnedMesh` 뼈 하나 = 물체 하나)·`PartList`·`mergeColored`·`replaceShaderChunk`.
- three.js는 import하지 않고 필요한 API의 첫 인자로 받습니다. `dist/three-kit.js`에 three가 없습니다.
- 셰이더 주입은 `replaceShaderChunk` 하나를 거치고 대상이 없으면 오류입니다. 대상 문자열을 r170·r180(GitHub 태그 소스)·r186(devDependency)에서 확인했습니다.
- 발배구 원본과 다른 점: `InstanceLayer`가 재질을 만들어 소유(옵션 객체, `createInstanceMaterial` 없음, 모양 합본은 geometry의 `aShape`로 판별), 공 가림 주입은 게임이 `extend: { key, inject }`로 끼움, 레이어 `warm()` 없음(`warmUp`의 `renderer.compile`이 숨긴 메시도 컴파일), `PartList.cylinder`의 x·y·z 기본값 0, 이름의 `Takraw` 접두어 제거.
- 예제: 렌더링 예제에 "three.js" 탭(three r180을 CDN에서 받아 넘김). 물체 16개 + 바닥 표시 48·480개가 2 draw입니다.
- 시험: 고정 시나리오 `modules/three-kit/tests/three-kit.e2e.mjs`(core, Node·three r186)와 미리보기 시나리오의 three.js 탭(2 draw, 미리 컴파일 뒤 새 프로그램 0).

## v0.58.0 (2026-11-12)

공개 API 추가(MINOR). pathfield에 칸 비용을 넣습니다. 쌀콩팡 둑길 평원에서 드러난 한계입니다(AI-009): 길찾기 비용에 물이 없어 유닛이 둑길로 가지 않고 물(이동 배율 0.5)을 직선으로 건넜습니다. 칸 비용을 주지 않는 기존 소비자의 결과는 그대로입니다.

- `PathGrid`의 `cellCost(x, y, cell)`·`maxCellCost`(1..254): 열린 칸의 비용(그 칸을 지나는 데 걸리는 시간의 배수, 이동 배율 0.5면 2). 통과 판정과 같은 기억(칸마다 한 번)에 들어가고 `invalidate`·`invalidateRect`가 함께 비웁니다. `costOf(cell)`(막힌 칸 0)을 더했습니다.
- 걸음 비용 `stepCost(direction, fromCost, toCost)` = 기본 비용(직선 10·대각 14) × 두 칸 비용의 평균. 항상 정수이고 대칭이며, 포털 건너기·청크 안 비용 행렬·청크 장(F0·F1)·A\*가 모두 이 식 하나를 씁니다. 비용이 걸리는 시간이라 "더 빨리 도착하는 길"을 고르므로, 가까운 다리는 쓰고 멀리 돌아가는 쪽이 늦으면 물을 건넙니다.
- 범위: `PortalGraph`가 청크 안 비용 행렬(Uint16)에 맞는지(S² × 가장 비싼 걸음 < 2^16, S 16이면 `maxCellCost` ≤ 18)와 추상 거리 상한을 `maxCellCost`로 확인합니다. `RouteFinder`의 힙 키 배율은 격자 크기에서 정하고(키 순서 (f, h)는 그대로) 상한을 확인합니다. 포털 건너는 비용은 `Uint16Array`입니다.
- 칸 비용이 모두 1(`maxCellCost` 1)이면 청크 안 Dijkstra·A\*·F1 경계가 칸 비용을 읽지 않습니다(값이 같음).
- 직선 판정(`waypoints`·`advance`의 `lineClear`, 게임의 직선 광선)은 비용을 모릅니다. README "칸 비용"에 적었습니다.
- 예제: work-scheduler "포털" 탭에 "강" 버튼(오른쪽 물 띠 + 다리, 칸 비용 2). 미리보기 시나리오에 강을 켠 뒤 유동장 ÷ A\* ≤ 1.15를 더했습니다.
- 시험: 고정 시나리오에 손계산 걸음 비용(15·21·20), 가까운 다리는 쓰고 먼 다리로는 돌아가지 않음, 칸 비용이 있는 유동장의 값 ≥ A\* = 시험 안 다익스트라·엄격한 내려가기·비율 ≤ 1.15(1.0545), 비용 변경의 국소 무효화 = 처음부터, 잘못된 옵션을 더했습니다.

같은 결과 확인과 측정(Node 25.9, 판정 아님, 임시 스크립트, 저장소에 남기지 않음): 쌀콩팡 크기 격자(4200×4800, 칸 24, 원 장애물 90개)에서 목표 24개의 유동장 전 칸 값·내려가기, A\* 150쌍, 원 30번 바꾸며 국소 무효화를 main(v0.57.0)과 한 프로세스에서 교대로 14회 돌렸습니다. 결과 해시는 같았고(`-1708961481`), 최솟값(ms)은 유동장 262 → 275, A\* 70.7 → 62.8, 무효화 275.8 → 273.9, 준비 17.6 → 18.3입니다. 같은 PC에 다른 작업이 돌아 회차 사이 편차가 ±10%를 넘었으므로 이 차이는 잡음 안입니다. 칸 비용을 그대로 읽던 첫 구현은 유동장·무효화가 약 20% 느려서 칸 비용 1 격자의 읽기를 없앴습니다.

## v0.57.0 (2026-11-12)

호환되지 않는 동작 변경(MINOR). navigation이 주소를 언제나 지금 route의 정규 주소로 둡니다. 발배구가 자체 해시 라우팅을 navigation으로 바꾸며 드러난 한계입니다(AI-009): 경기 중(`#/play`) 주소창에 `#/nope`를 넣으면 normalize 결과가 지금 화면과 같아 알림이 없었고 주소도 `#/nope`로 남았습니다. 공개 API·옵션은 그대로이고, README가 약속하던 "초기화·이력 복원은 URL을 쓰지 않는다"가 바뀝니다.

- 이력 복원(뒤로·앞으로·주소창 입력): 들어온 주소가 정규 주소가 아니면 구독자에게 알리기 전에 `replaceState`로 고칩니다(이력 항목 수 그대로). 알림 규칙은 그대로라 정규 route가 지금과 같으면 알리지 않습니다. 구독자 안에서 다시 `navigate`·`replace`하면 그 주소가 최종 주소입니다.
- 생성: 시작 주소가 정규 주소가 아니면 같은 방식으로 `replaceState`합니다. 알림은 없습니다. 생성 직후와 이력 복원이 같은 규칙이라 같은 주소를 새로고침으로 열든 주소창에 넣든 결과가 같습니다.
- 해시만 고치므로 바깥 검색 옵션(`?preview=`, `?debug=1&scene=`)은 그대로입니다. normalize가 허용하는 다른 주체의 주소(`installShowcase`의 `#/showcase`)는 정규 주소라 건드리지 않습니다.
- 소비자 영향: 발배구·와르르냥·Bounko는 normalize가 `showcase`를 허용해 소개 주소가 그대로입니다. 쌀콩팡은 `#/showcase`를 쓰지 않습니다. 모르는 주소가 남던 경우(예: 쌀콩팡 시작 주소 `#/zzz`)는 정규 주소로 바뀝니다. Bounko·와르르냥의 시작 시 `replace(snapshot(), { force: true })`는 강제 알림 용도로 계속 유효합니다.
- 예제·시험: navigation 예제에 normalize(모르는 화면은 메인)를 넣고, 고정 시나리오 `navigationFlow`에 "주소창에 `#/nope` → 해시 없는 주소로 교정, 이력 항목은 입력 1개만" 단계를 더했습니다.

## v0.56.0 (2026-11-11)

공개 API 추가(MINOR). 게임마다 따로 만들던 디버그 장면 보조 셋을 debug-tools로 올립니다(쌀콩팡 PR #333·발배구 `watch`·budmori `farm-bench`의 공통 부분, AI-021·AI-009). 기존 소비자의 현재 코드는 그대로 돕니다(장면 함수 두 번째 인자·`state` 인자 추가만). 쌀콩팡·발배구 적용은 다음 단계입니다.

- 가상 시계: 장면 함수가 `(params, { freezeClock })`를 받습니다. `freezeClock()`은 장면이 닫히거나 열기에 실패할 때까지 `performance.now`를 고정 시작 시각(10,000,000ms)의 가상 시계로 바꾸고 `{ now, advance(ms), realTime(fn) }`를 돌려줍니다. 틱 시간은 `realTime` 안에서 실제 시계로 잽니다. 부르지 않는 장면과 `?debug`가 없는 주소는 아무것도 바뀌지 않습니다. `Date.now`·rAF는 바꾸지 않습니다.
- `state(options)`: 호스트가 인자를 해석하지 않고 장면의 `state`로 그대로 넘깁니다(쌀콩팡의 `times=1` 주소 우회 대신 `state({ times: true })`).
- 실행기 `dist/debug-scene.mjs` `runDebugScene`(새 Node 도구): 주소를 헤드리스 Chromium으로 열어 `step(N)`·`state(JSON)` 출력, 캡처, 두 체크아웃 또는 두 주소의 교대 비교(경로·커밋·미커밋 여부와 요약 표, 원시 JSON은 `--json`), `--heap`(표본 힙 프로파일러로 `step(N)`에서 같은 상태 `step(0)` 렌더 몫을 뺀 틱당 할당), `--gpu`(D3D11)를 합니다. Playwright `chromium`과 체크아웃을 띄우는 `serve`는 게임이 넘깁니다. 시험이 아닙니다.
- 통합 예제의 "접촉" 탭이 장면 `contacts`로 열립니다(`?debug=1&scene=contacts&budget=1&tick=100`). 겹친 쌍 표시가 표시 시계로 깜박여 가상 시계가 그림을 고정하는지 볼 수 있습니다. 명령줄 예: `modules/debug-tools/scripts/debug-scene.mjs`.
- 문서: debug-tools README를 새 API로, `installGlobal`이 `DiagnosticRing` 메서드임을 바로잡고, 루트 README의 낡은 문장(게임 미적용·`codex/` 브랜치만·머지 승인)과 scenario·vector-assets·rendering README의 영어 문단을 한국어로 고쳤습니다.

## v0.55.0 (2026-11-11)

호환되지 않는 변경(MINOR). contact-solver의 조향(걷는) 몸 이동 손실을 고치고, 틱 경로의 할당을 없앱니다. 쌀콩팡 적용(rally-frontier PR #330, v0.101.0)에서 드러난 두 문제입니다. 조향 몸의 결과가 바뀌므로 같은 입력의 체크섬이 달라집니다. 동적 몸의 반올림 규칙과 geometry·pathfield의 결과는 그대로입니다.

- 조향 몸 이동 손실: 조향 몸은 속도 `(steer − x) / FP / dt`로 바꿨다가 다시 적분하면서 `trunc`해 아무것에도 막히지 않아도 틱당 최대 1 FP 덜 갔습니다(예: 28.999… → 28). 이제 `end()`가 dt까지 옮긴 뒤 조향 몸의 소수 잔여를 축마다 `round`로 정산합니다. 막히지 않은 조향 몸은 `steerX`·`steerY`에 정확히 서고, 접촉해 미끄러진 몸도 틱마다 내림 손실이 쌓이지 않습니다. 접촉 시각까지의 이동은 지금과 같은 `trunc(v · FP · 경과 + 잔여)`입니다.
- 할당: 격자 질의 결과를 JS 배열에 `length = 0` 후 `push`로 받던 것이 원인이었습니다(V8이 길이 0인 배열의 저장 공간을 놓아 질의마다 다시 할당). spatial `UniformGrid`에 정수 배열을 채우고 개수를 돌려주는 `queryRectInto`·`queryCircleInto`를 더하고, contact-solver는 몸 용량만큼 잡아 둔 `Int32Array` 후보 버퍼를 씁니다. 후보 격자를 위치 열과 같은 정수 단위로 바꿔 질의 인자가 정수이고, 겹침 풀기 격자는 위치가 바뀐 pass 뒤에만 다시 채웁니다. spatial `clear`도 사용한 칸 목록을 `length = 0`으로 비우지 않고 개수만 되돌립니다. 내부 호출(`#advance`·`#castBody`·`#keep`)은 부동소수 값을 인자로 넘기지 않습니다(인라인되지 않은 호출의 HeapNumber 상자).
- 결과: 할당 수정만 적용한 상태(조향 정산을 끈 임시 빌드)에서 contact-solver·geometry·spatial·pathfield 고정 시나리오 출력과 측정 장면 200틱 해시가 main과 같았습니다. contact-solver 고정 시나리오의 30틱 해시는 조향 정산 때문에 예산 0 `b60cd0ee` → `ea61871`, 16 `d70e977e` → `24f5923`, 무제한 `2dfbc97e` → `47598691`로 바뀝니다(1~3틱은 푼 쌍 수가 같고 4틱부터 갈림).
- 시험: 고정 시나리오에 "막히지 않은 걷는 몸은 조향 끝점에 선다"를 더했습니다(수정 전에는 x가 1 모자람).

측정(Node 25.9, 판정 아님, 임시 장면: 몸 300 = 아군 SOFT 밀집 행군 220 + 적 SOLID 전선 80, 동적 9, 예산 64, 같은 장면 6회로 JIT 워밍업 뒤 61~160틱, 7회 교대 실행 중앙값). 할당은 틱마다 `gc()` 뒤 단계 전후 `heapUsed` 차이이고 측정 호출 몫 약 0.4KB가 들어 있습니다.

| 틱당                | main(v0.54.0) | 할당 수정만 | 최종 |
| ------------------- | ------------- | ----------- | ---- |
| `next` 루프 할당 KB | 1383          | 127         | 128  |
| `end` 할당 KB       | 18.8          | 18.8        | 18.8 |
| `separate` 할당 KB  | 3170          | 37          | 37   |
| `next` 루프 ms      | 2.39          | 2.43        | 2.11 |
| `separate` ms       | 2.06          | 1.67        | 1.63 |
| 합계 ms             | 4.53          | 4.18        | 3.82 |

최종 열은 조향 정산으로 장면 전개가 달라(cast 793 → 847) 시간을 직접 비교하지 않습니다. 남은 할당은 geometry 호출입니다: 지형 호출을 아무 일도 않는 가짜로 바꾸면(이 장면은 지형 접촉이 없어 결과가 같음) `end` 0.24KB, `separate` 0.52KB, `next` 64KB입니다. 그 차이(`next` 약 64KB, `end` 18.6KB, `separate` 36KB)는 `SurfaceMotion.cast`·`solve`에 부동소수 인자를 넘길 때와 그 안의 인라인되지 않은 호출이 만드는 상자이고, 인라인 한도를 키우면 줄고 0으로 하면 커지는 것으로 확인했습니다. `next`의 나머지 64KB는 인라인된 `SweptCircleContact.cast` 쪽으로 보이지만(틱당 `Math.hypot` 1236회) 출처를 확정하지 못했습니다.

## v0.54.0 (2026-11-11)

새 모듈(MINOR). 쌀콩팡의 예산 기반 접촉 풀이를 GameKit `contact-solver`로 올립니다. 기존 모듈의 결과는 바뀌지 않습니다(geometry·spatial·pathfield 소스 변경 없음). 쌀콩팡은 이번에 바꾸지 않았고 적용은 다음 단계입니다.

- `ContactSolver`: 지형·건물·맵 경계 접촉은 예산과 무관하게 항상 풀고, 몸-몸 접촉은 스텝당 `pairBudget`만큼만 풉니다. 넘친 쌍은 겹친 채 지나가고 `separate()`(SOFT 질량비 Jacobi, SOLID 침투한 쪽 완전 분리, 단계마다 지형 복구)가 위치로 정리합니다. 지형은 게임이 이미 가진 geometry `SurfaceMotion`을 주입합니다.
- 소비 방식: `begin(count, dt)`이 돌려준 타입 배열 열(`ContactBodies`)을 채우고, `next(ev)`로 시간순 접촉을 하나씩 받아 `resolve`(기본)·`exchange`·`reflect`·`bounce`로 응답하고(응답이 없으면 다음 `next`가 기본 응답), `end()`·`separate()`로 마칩니다. 콜백·스텝 사이 상태가 없고 몸 열은 게임 엔티티에서 매 스텝 채웁니다. 관계는 그룹 표(PASS·SOFT·SOLID), 몸 성질은 `flags`(ACTIVE·DYNAMIC·PAIRS·VERTICAL·SEPARATE)입니다.
- 결정론: 묶음 정렬(표면(몸, 접촉 키) → 쌍(작은 번호, 큰 번호) → i), 후보를 몸 번호 순으로 보아 `cellSize`와 무관, 0초 반복 키·겹침 풀기 쌍 키는 숫자 조합 정수(< 2^53), 대체 법선은 `pairHash` 8방향 정수입니다. 틱 경로에서 객체·배열·문자열·클로저를 만들지 않습니다.
- 원본과 다른 점(의도): 구르는 몸 별도 예산이 없고 예산은 하나(D6), 조향 몸끼리의 적 접촉도 같은 큐에 넣고 각자 미끄러짐(D7), 침투한 쪽 마지막 동률이 `String(id)` 대신 숫자 `key`, SOLID 후보 상자가 두 축 모두 닫힘.
- 예제: work-scheduler 예제에 "접촉" 탭을 더했습니다. 벽 틈에서 두 무리가 부딪치고 무거운 구르는 몸 셋이 지나가며, 예산 슬라이더(0·16·64·무제한), 예산에 걸려 겹친 적 쌍 강조, 벽 관통 수, 틱 시간을 보여 줍니다. 캔버스를 누르면(마우스·터치) 가장 가까운 구르는 몸을 그쪽으로 굴리고, 화살표 키로도 굴립니다.
- 배포: `dist/contact-solver.js`가 생겨 SDK 매니페스트 모듈 목록이 하나 늘었습니다(번들 의존 geometry·spatial).
- 시험: 고정 시나리오 `modules/contact-solver/tests/contact-solver.e2e.mjs`(질량비 교환 손계산, 같은 시각 순서·칸 크기 무관, 예산 초과 겹침과 `separate()`, 벽 틈 난전 30틱의 지형 관통 0·같은 입력 같은 해시)를 core 목록에 더했습니다. 미리보기 시나리오에 접촉 탭(예산별 관통 0·예산 0 겹침·무제한 건너뜀 0, 키보드 슬라이더, 터치 에뮬레이션)을 더했습니다.

원본 대비 비트 비교(임시 하네스, 저장소에 남기지 않음; 쌀콩팡 `52984f3`의 `solveImpulseStep` 계열 원문을 잘라 같은 장면을 한 스텝 돌려 위치·충격 속도·잔여 변위를 비교, 장면마다 시드 40개):

| 장면                                                                                                               | 같음     | 차이의 원인                                            |
| ------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------ |
| 동적 몸만 / 동적 + 정지 조향 / 한쪽 진영만 조향 이동 / 공중 도약·죽은 동적 몸 / 밀집 난전(예산 초과) / 30 TPS 밀집 | 각 40/40 | 없음                                                   |
| 구르는 몸 4·예산 여유                                                                                              | 38/40    | D6: 구르는 몸 쌍이 같은 예산을 써서 모듈만 예산에 걸림 |
| 구르는 몸 6·밀집 예산 초과                                                                                         | 25/40    | D6                                                     |
| 양쪽에 조향 몸, 한쪽만 이동                                                                                        | 4/40     | D7: 조향-조향 적 쌍이 생긴 시드만 다름                 |
| 양쪽 진영 조향 이동(밀집)                                                                                          | 0/40     | D7                                                     |
| 겹침 풀기(`separate()` 대 원본 SOFT×4 → 복구 → SOLID(4) → 복구, 밀집 5종)                                          | 각 40/40 | 없음(시작 겹침 쌍 2.7만~5.4만)                         |

원본의 후보 순서를 게임 격자 순서로 바꿔도 모든 장면에서 번호 순서와 같았습니다(40/40). 예산 무제한에서 조향 쌍 응답이 없었는데 다른 경우는 양쪽 조향 장면의 한 시드뿐이고 조향 몸 하나의 x가 위치 정수 1(0.01) 다릅니다. 조향 쌍 접촉이 기록됐다가 풀리기 전에 다시 cast되면서 생긴 반올림 차이로 추정하며(D7 부산물), 원인은 확인하지 않았습니다.

참고 측정(Node, 판정 아님, 300몸·동적 약 120·밀집 난전 한 스텝, 7회 중앙값, ms): 원본과 결과가 같은 장면에서 접촉 스텝 원본 → 모듈은 예산 0 0.33 → 0.15, 16 2.24 → 1.27, 64 3.76 → 2.04, 무제한 11.2 → 5.7(푼 쌍 0·16·64·387 같음). 겹침 풀기는 1.6 → 1.6. 양쪽 조향 장면(D7)은 무제한에서 모듈이 조향 쌍까지 풀어 470쌍 대 316쌍, 9.1 → 8.2입니다.

## v0.53.0 (2026-11-11)

호환되지 않는 변경(MINOR). pathfield에서 옛 거리장 구현을 삭제합니다. 청크 + 포털 계층 길찾기 5단계(정리)입니다. 유일한 소비자 쌀콩팡이 `PortalGraph`·`FlowField`·`RouteFinder`로 모두 옮겼습니다.

- 삭제: `DistanceField`, `FieldCache`, `PathGrid.sync(version)`, `PathGrid.reachableFrom(start, out)`과 그것만 쓰던 내부 코드(`field.js`·`cache.js`, 힙, 탐색 스택, 버전 기억). 대체: 목표까지의 비용은 `PortalGraph#setGoal`·`goal`이 돌려주는 `FlowField`, 한 유닛의 길은 `RouteFinder`, 장애물 변경은 `invalidate()`·`invalidateRect()`, 연결 여부는 `PortalGraph#component`입니다.
- `UNREACHED`는 `grid.js`로 옮겼고 공개 이름은 그대로입니다. 비용(직선 10·대각 14)·방향 순서·동률 규칙은 바뀌지 않았습니다.
- 고정 시나리오: 삭제된 API의 시나리오(게으른 확정·캐시·`reachableFrom`·원본 `NavigationGrid` 해시 대조)를 지우고, 비교 기준이 필요한 시나리오는 시험 안의 작은 다익스트라·flood fill로 바꿨습니다.
- 통합 예제의 "거리장" 탭을 지웠습니다. 목표로 내려가는 유닛은 "포털" 탭이 같은 `descend`·`lowestNeighbor`로 보여 줍니다.

## v0.52.3 (2026-11-11)

호환되는 추가(PATCH). pathfield `PortalGraph`에 목표 보관소와 계층 유동장 `FlowField`를 더합니다. 기존 `PathGrid`·`DistanceField`·`FieldCache`·`RouteFinder`·`PortalGraph` 구조의 결과는 같습니다(고정 시나리오의 원본 대비 해시 그대로). 계층 길찾기 3단계입니다.

- `goal(keyA, keyB)`·`setGoal(keyA, keyB, cells)`·`goalCount`: 안전 정수 두 개를 키로 목표 칸을 보관하고 `FlowField`를 돌려줍니다. 용량 `goalCapacity`(기본 64)를 넘으면 가장 오래 안 쓴 목표를 버리고, `prepare()`가 구조를 다시 만들면 모두 비웁니다. 키 해시는 숫자 섞기 + 선형 탐사이고 문자열·`Map`이 없습니다.
- `FlowField.distance`·`lowestNeighbor`·`descend`(`DistanceField`와 같은 이름·인자): 목표마다 포털 노드의 추상 거리를 A\*(청크 사각형까지 옥타일 휴리스틱)로 질의한 청크까지만 확정하고 다음 질의는 이어서 뻗습니다. 질의가 온 청크만 청크 장 F0(노드 씨앗)·F1(이웃 F0 경계 값 이어받기)을 만듭니다. 값은 실제로 걸을 수 있는 길의 정수 비용(최단 이상)이고 (목표 칸 집합, 격자 상태)만의 함수라 질의 순서·캐시 폐기와 무관합니다. 닿는 칸이면 항상 엄격히 더 싼 이웃이 있어 내려가기가 목표 칸에 닿습니다. 관찰용 `chunkStage`·`nodeState`·`nodeDistance`.
- `PortalGraph` 생성자가 정수 거리 범위(Int32·키 2^53)를 확인하고 넘으면 `RangeError`입니다(청크 16칸이면 칸 약 160만 개까지). `stats`에 `goalsBuilt`·`fieldsBuilt`·`nodesSettled`를 더했습니다.
- 예제: work-scheduler 예제의 "포털" 탭을 넓혔습니다. 유닛 24기가 유동장으로 목표까지 내려가고, 실제로 계산한 청크(F1 밝기·F0 빗금)와 추상 거리를 확정한 포털이 보입니다. "목표 정하기", "정확한 길"(A\* 최단 경로와 겹쳐 그리기), "유닛 보내기"를 더했습니다.
- 시험: 고정 시나리오에 유동장 다섯 가지(유한 ⇔ 같은 성분, 엄격한 내려가기, 값 ≥ A\* 최단·비율 ≤ 1.15, 질의 순서·용량 1 밀어내기·새 그래프와 무관, 원 추가·제거의 국소 무효화 = 처음부터)와 잘못된 키·칸을 더했습니다. 미리보기 시나리오에 유닛 도착·계산 범위·목표 정하기(마우스·터치 에뮬레이션)를 더했습니다.

참고 측정(Node, 판정 아님, 쌀콩팡 규모 4200×4800·칸 24·143청크, 다각형 40·원 30, `passableEdge` 사용, 7회 중앙값): 목표 하나 첫 질의 0.4~0.6ms(지금 방식 `DistanceField`는 가까운 유닛 0.3ms·맵 반대편 11ms), 같은 목표 이어지는 질의 0.07ms, 유닛 300·목표 8 첫 틱 40ms(지금 방식 78ms)·다음 틱 0.65ms(0.73ms), 건물 하나 변경 뒤 먼 유닛 첫 질의 1.7ms(전체 무효화 63ms). 무작위 4,792쌍의 값 ÷ 최단 비용은 중앙값 1.004·95% 1.026·최대 1.106, 실제로 걷는 길 ÷ 최단은 중앙값 1.000·95% 1.010·최대 1.043.

## v0.52.2 (2026-11-11)

호환되는 추가(PATCH). pathfield에 청크 + 포털 계층 길찾기의 구조 부분인 `PortalGraph`를 더합니다. 기존 `PathGrid`·`DistanceField`·`FieldCache`·`RouteFinder`의 결과는 같습니다(고정 시나리오의 원본 대비 해시 그대로). 계층 길찾기 2단계입니다.

- `new PortalGraph(grid, { chunkSize = 16, portalSpan = 4, goalCapacity = 64 })`: 격자를 정사각 청크로 나누고 청크 안 연결 성분, 청크 경계 포털 노드(직선 구간을 `portalSpan`칸씩 쪼갠 조각의 중앙 칸, 직선으로 이어지지 않는 성분 쌍만 대각 단칸 포털, 모서리 대각 포털), 청크 안 노드 사이 비용 행렬(처음 물을 때 만듦), 전역 연결 성분을 둡니다. 판정은 모두 `grid.stepCell` 하나로 합니다.
- `prepare()`: 격자의 `takeChangedRects`를 소비해 바뀐 칸 사각형을 한 칸 넓힌 범위와 겹치는 청크만 다시 만듭니다. 이웃 청크는 노드 목록만 다시 모으고, 칸 목록이 같으면 비용 행렬을 그대로 둡니다. 질의가 필요할 때 스스로 부릅니다.
- `component(cell)`·`componentCount`: 전역 연결 성분(`reachableFrom`과 같은 답을 O(1)로). 노드 조회 `chunkNodeCount`·`chunkNode`·`nodeCell`·`nodeChunk`·`nodePeer`·`nodeCrossCost`·`edgeCost`, 다시 만든 청크 표시 `chunkChange`, `revision`·`stats`.
- 번호·순서는 격자 상태만의 함수라 국소 무효화로 따라간 구조와 처음부터 만든 구조가 같습니다. 키는 숫자 조합 정수(성분 열쇠 `청크 · S² + 성분`, 노드 `포털 · 2 + 쪽`, 지역 힙 `비용 · 2^12 + 청크 안 칸`)이고 문자열·Map이 없습니다. 목표 보관(`goal`·`setGoal`)과 `FlowField`는 다음 단계입니다.
- 예제: work-scheduler 예제에 "포털" 탭을 더했습니다(건물을 놓고 지우면 다시 만든 청크를 칠함, 마우스·터치·화살표 키 + Enter). 탭 여섯 개가 좁은 화면에서도 한 줄에 들어가도록 탭 버튼의 너비 하한과 옆 여백을 줄였습니다(높이 56px 유지).
- 시험: 고정 시나리오에 건물을 놓고 지우는 동안 국소 무효화 = 처음부터, 다시 만든 청크 = 겹치는 청크, 성분 = `reachableFrom`(변 통과 판정 포함), 잘못된 옵션을 더했습니다. 미리보기 시나리오에 포털 탭(마우스·키보드·터치 에뮬레이션)을 더했습니다.

참고 측정(Node, 쌀콩팡 규모 4200×4800·칸 24 = 175×200칸·143청크, 다각형 40·원 30, 중앙값): 처음 구축 17ms(통과 판정 포함, `passableEdge`까지 쓰면 50ms)·구조만 6~8ms, 모든 청크 비용 행렬 41ms, 건물(원 반지름 60) 하나 변경 때 `prepare` 0.34ms(변 판정 포함 0.61ms) + 닿은 청크 행렬 1.5~1.7ms. 노드 2,398개(포털 1,199개)·청크 안 간선 19,774개·청크당 노드 최대 21개, 메모리 약 1MB.

## v0.52.1 (2026-11-11)

호환되는 추가(PATCH). pathfield `PathGrid`에 사각형 단위 무효화와 바뀐 사각형 기록을 더합니다. 기존 `invalidate()`·`sync`·`reachableFrom`·`DistanceField`·`FieldCache`의 결과는 같습니다. 청크 + 포털 계층 길찾기 1단계입니다.

- `invalidateRect(minX, minY, maxX, maxY)`: 월드 좌표 사각형에 걸친 칸의 통과 판정 기억과 맞닿은 한 겹의 변(`passableEdge`) 기억만 비우고 `revision`을 올립니다. 격자 밖은 자르고 전혀 안 겹치면 아무 일도 없습니다.
- `takeChangedRects(out)`·`changedRectCount`·`MAX_CHANGED_RECTS`(16): 마지막으로 가져간 뒤 바뀐 칸 사각형을 `Int32Array`에 네 정수씩 기록 순서대로 넘겨주고 비웁니다. 포함되는 사각형은 버리고, 가득 차면 바운딩 사각형 하나로 합칩니다. 기록은 호출 순서에만 의존하고 객체·배열을 만들지 않습니다. `invalidate()`·`sync`는 격자 전체 한 개로 기록합니다.
- 시험: 고정 시나리오에 사각형 무효화·기록·가져가기·오류 입력을 더했습니다.

## v0.52.0 (2026-11-11)

공개 API 변경(MINOR, 소비자 수정 필요). geometry·vision·spatial·pathfield의 틱 경로 가비지와 맞지 않는 자료구조를 걷어내고, 문자열 키를 숫자 조합 정수 키로 바꿉니다. 별칭·래퍼 없이 시그니처를 바로 바꿨습니다. **쌀콩팡 체크섬이 달라짐**: 동률 순위(정수 FNV-1a + fmix32), 접촉 목록의 키 순서, 원 장애물·관찰자 id의 정수화 때문입니다(아래 "결과가 바뀌는 것").

- geometry 접촉 키: `'wall:3:edge'` 같은 문자열 대신 `contactKey(kind, obstacle, edge, part) = kind·2^50 + obstacle·2^22 + edge·4 + part`(< 2^52)입니다. 종류는 `CONTACT_POLYGON`(다각형, 장애물 번호 = 색인 항목 번호)·`CONTACT_CIRCLE`(원 id)·`CONTACT_WALL`(월드 경계 변 0~3)·`CONTACT_USER`(게임이 만드는 접촉), 부위는 `CONTACT_EDGE`·`CONTACT_START`·`CONTACT_END`입니다. 원 장애물 `id`는 0..2^28-1 정수, `ignoreAll.id`는 정수(보통 -1)여야 합니다.
- geometry 동률 순위: `tieKey`는 0 이상 안전 정수이고, 기본 `defaultTieRank`는 (tieKey 하위·상위 32비트, contactKey 하위·상위 32비트, sign > 0 ? 1 : 0)의 FNV-1a를 murmur3 fmix32로 마무리합니다. 문자열을 만들지 않습니다.
- geometry 함수 모양: 결과를 호출자의 `out`에 씁니다. `SweptCircleContact.cast(…, policy, out)`은 boolean을 돌려주고 법선을 정할 수 없으면 `out.degenerate`를 켭니다(대체 법선 콜백 제거, 필요할 때만 호출자가 계산). `SurfaceContactGeometry.closest/circleCast/edgeCast(스칼라 좌표, 정수 key, slack, out)/polygonContacts(…, points, polygon, epsilon, list)/feasible(x, y, list)/project(…, out)/slide(vx, vy, list, budget, steer, goalX, goalY, tieKey, tieRank, out)`. `SurfaceMotion.contacts(…, list)`, `cast(…, out)`, `recover(…, out)`, `advance(…, whole, out)`, `solve(…, tieKey, out: MotionResult)`, `constrain(…, tieKey, out)`(다시 풀었으면 true). 새 `ContactHit`·`ContactList`(객체 재사용)·`MotionResult`를 내보냅니다. `circleObstacleCast`는 내부로 들어갔습니다.
- geometry 내부: `remember`가 몸체마다 기록 객체 하나를 재사용하고 `forgetAll`은 세대 번호만 올립니다(WeakMap 재생성 없음). 다각형 꼭짓점은 이웃 변이 공유하므로 한 번만 검사합니다. `BoundsIndex`는 칸별 배열 대신 CSR(칸별 시작 + 항목 번호 `Int32Array`)이고 `found`(결과의 항목 번호)와 `rebuild(items)`를 둡니다. `ObstacleField.setCircles`는 색인 버퍼를 재사용하고, `nearestOpen(…, accept, out)`·`nearestExterior(…, out)`는 boolean을 돌려주며 클로저를 만들지 않습니다. 고리 탐색의 `cos`·`sin`은 표로 한 번 계산합니다(같은 식이라 값이 같음).
- vision: `update(observers)`를 `begin()` / `observe(id, x, y, radius, level, xray)` / `end()`로 바꿨습니다. `id`는 안전 정수이고 한 갱신 안에서 겹치면 RangeError입니다(종류가 다르면 `번호 · 8 + 종류`처럼 조합). 관찰자 기록·칸 버퍼를 재사용합니다. 잘못된 관찰자에서 던지면 그 앞의 관찰자는 이미 반영돼 있습니다(이전의 "목록 전체를 먼저 검사" 원자성은 없어짐).
- spatial: plain 격자(`'clamp'`, track·groups 없음)는 CSR(칸 순서 배열)로 담습니다. 순서 계약은 같습니다. `itemsInCellOrder(out)`(모든 칸을 칸 순서로 한 번에)과 `cellRange(minX, minY, maxX, maxY, out)`를 추가합니다. plain 격자의 `cellItems`는 공유 배열에 복사해 돌려주므로 다음 `cellItems` 전까지만 유효합니다.
- pathfield: `PathGrid.reachableFrom(start, out)`의 `out`(길이 `size` 이상의 `Uint8Array`)이 필수가 되고 탐색 스택을 격자가 재사용합니다. `DistanceField`·`FieldCache`·`RouteFinder`는 바꾸지 않았습니다(길찾기 기본 구조를 청크 + 포털 그래프 유동장으로 다시 설계하므로 그때 정함).
- 예제: work-scheduler 예제의 기하 탭(`MotionResult` 재사용, 정수 tieKey·원 id)과 시야 탭(`begin/observe/end`)을 새 API로 옮겼습니다. 화면 결과는 같습니다.
- 시험: geometry·vision·spatial·pathfield의 고정 시나리오를 새 API로 바꾸고 정수 키 식·`found`·`degenerate`·중복 id 오류·`itemsInCellOrder`·`cellRange`·`reachableFrom`의 `out` 필수를 더했습니다. 동률 기대값은 새 기본 순위로 다시 정했습니다(tieKey 1 → 아래로, 2 → 위로). vision·spatial의 원본 대비 해시는 그대로 같습니다.

결과가 바뀌는 것(옛 코드 사본과 같은 fixture로 비교, 임시 검증):

| 항목                                                                      | 비교 수 | 같음  | 동률 선택만 다름                             | 순서만 다름                 | 다름 |
| ------------------------------------------------------------------------- | ------- | ----- | -------------------------------------------- | --------------------------- | ---- |
| `SurfaceMotion.solve`(steer·stop·project, 옛 순위를 흉내 낸 tieRank 주입) | 12000   | 12000 | 0                                            | 0                           | 0    |
| `SurfaceMotion.cast`                                                      | 12000   | 12000 | 0                                            | 0                           | 0    |
| `SurfaceMotion.contacts`                                                  | 12000   | 11978 | 0                                            | 22(같은 집합, 정수 키 순서) | 0    |
| `SweptCircleContact.cast`                                                 | 24000   | 24000 | 0                                            | 0                           | 0    |
| `SurfaceContactGeometry.slide`(기본 순위)                                 | 12000   | 11535 | 465(옛 FNV 문자열 순위를 주입하면 모두 같음) | 0                           | 0    |
| `reachableFrom`                                                           | 60      | 60    | 0                                            | 0                           | 0    |
| vision 전체 칸 ceiling·revision(60회 갱신)                                | 60      | 60    | 0                                            | 0                           | 0    |
| spatial plain 격자 질의 전체                                              | 24060   | 24060 | 0                                            | 0                           | 0    |

측정(Node, 쌀콩팡 규모 4200×4800, 다각형 40·원 30, 전후 교대 14회 중앙값, ms/틱 300 → 600유닛): (a) 유닛마다 solve + contacts 2.41→1.66 / 4.43→3.30, (b) 쌍 cast + slide 0.79→0.32 / 1.77→0.87, (d) 시야 갱신 0.41→0.25 / 0.48→0.29, (e) 충돌 격자 비우기·넣기·질의 4패스 0.54→0.41 / 1.31→0.92. 할당(GC 없이 잰 틱당 증가, 300유닛): solve 5.1→2.6KB, contacts 4.8→0.2KB, 모든 칸 훑기를 포함한 충돌 격자 18.5→4~11KB.

## v0.51.0 (2026-11-11)

비호환 MINOR. 렌더·표시 프레임 경로에서 프레임마다 생기던 임시 객체·배열·문자열 키를 없앴습니다. 화면 출력은 바뀌지 않습니다(SwiftShader에서 기준 v0.49.0과 픽셀 차이 0: 벡터 액터 1000개 기본·ordered, 벡터 경로 1000개, 아틀라스 스프라이트 1000개 기본·ordered, 각 3프레임). 컴파일 자산 형식은 바뀌지 않아 게임이 커밋한 컴파일 산출물은 다시 만들 필요가 없습니다.

공개 API 변경:

- 스프라이트 액터 `sample(timeMs)`를 `sampleInto(timeMs, out)`로 바꿨습니다. 호출자가 준 기록에 `clip`·`frameIndex`·`frame`·`elapsedMs`·`finished`를 쓰고 그 기록을 돌려줍니다. `sample`은 남기지 않습니다. `draw()`가 돌려주는 표본은 액터마다 하나를 재사용하므로 다음 `draw()`에서 다시 쓰입니다(이전에는 동결된 새 객체).
- `MeshRenderer.preparePose(instance, options)`의 `excluded`(파트별 boolean 배열)를 정수 비트 마스크 `excludedMask`(파트 i가 비트 i, `[0, 2^16)`)로 바꿨습니다. 벡터 액터 `preparePose({ excludeParts })`는 그대로입니다.
- `PoseRenderer.resolve()`가 돌려주는 객체와 텍스처 목록은 기록마다 재사용됩니다. 보관하려면 값을 복사합니다.
- `VectorRenderer.setTransform`은 현재 행렬 배열을 제자리에서 고칩니다. `vector.matrix`를 보관하던 코드는 복사해야 합니다(그 자리에서 읽는 코드는 영향 없음).

문자열 키를 숫자로 바꾼 곳: 클립 평면 집합(내부 번호 id, 빈 집합 0·면적 0은 1), 메시 파이프라인 키(혼합 기수), 깊이 상태 코드(32 미만)와 ordered 상태 코드(혼합 모드 × 32 + 깊이, 192 미만), 파트 제외 마스크(16비트), 재질 실행 캐시 키(변형 이름 그대로). 알파 대기열의 실행 비교는 문자열 대신 값 비교입니다.

d3d11(GTX 1660 Ti), 기준 v0.49.0(렌더·벡터 자산 코드는 v0.50.0과 같음)과 번갈아 3회 측정한 중앙값(다른 작업이 돌던 PC라 절대값은 흔들림):

| 장면                                | 프레임당 할당     | 120프레임 GC | CPU 중앙값     |
| ----------------------------------- | ----------------- | ------------ | -------------- |
| 벡터 액터 1000                      | 4.77 MB → 0.35 MB | 368 → 47     | 38.3 → 23.4 ms |
| 벡터 액터 1000 ordered              | 3.94 MB → 0.28 MB | 431 → 51     | 20.7 → 14.5 ms |
| 벡터 경로 1000(채움·선·사각형)      | 25.8 MB → 2.39 MB | 3447 → 846   | 47.2 → 34.3 ms |
| 아틀라스 스프라이트 1000(절반 clip) | 1.51 MB → 0.98 MB | 354 → 180    | 2.4 → 1.9 ms   |

고정 벤치(번갈아 2회): `benchmark:draw-batching` 제출 p50 2.9·2.8 → 1.9·1.8 ms, `benchmark:rendering`의 sprites 2.4·2.5 → 1.3·1.5 ms, meshes 2.8·3.9 → 1.6·1.6 ms(draw call·정점·업로드 바이트 동일). 보간 runtime·presentation-events Node 벤치는 잡음 범위 안에서 차이가 없었습니다.

`rendering-benchmark.json`·`draw-batching-benchmark.json`에 `v0.49.0-before-hotpath`·`v0.51.0-hotpath-garbage` 쌍을 기록했습니다.

## v0.50.0 (2026-11-10)

공개 API 변경(MINOR, 소비자 수정 필요). 틱·네트워크 경로의 가비지와 맞지 않는 자료구조를 걷어냅니다. 패킷·리플레이·저장 형식과 상태 hash, peer 판정은 바뀌지 않았습니다(이전 코드와 바이트 동일 확인). 형식 버전 상수도 그대로입니다.

- rollback 어댑터: `save(): Bytes`를 `saveInto(out: ByteBuffer)`로 바꿉니다. SDK가 버퍼를 재사용하고 보관할 때만 정확한 크기로 한 번 복사하며, hash·비교에는 복사하지 않습니다. value codec 상태는 `saveInto: (out) => codec.encodeInto(state, out)`, bytes 상태는 `out.write(bytes)`로 옮깁니다. `createSession`·`createRoomSession`·`createSyncTestSession`·`runSyncTest`·`playReplay`·bootstrap이 모두 `saveInto`를 요구합니다.
- deterministic: `ByteBuffer`(재사용 버퍼)와 `codec.encodeInto(value, out)`를 추가합니다. `encode`는 보관용 새 bytes로 남습니다. 숫자 typed array는 little-endian 호스트에서 메모리 그대로 복사하고, 키 정렬은 이미 정렬된 경우 생략합니다. `fixedPoint.div`는 BigInt 대신 부동소수 나눗셈(|a·1024| ≤ 2^41이라 정확)으로 같은 값을 냅니다.
- rollback 세션: `localCaptureSequence`(정수)와 `readLocalCaptures(afterSequence, out)`를 추가합니다. `createLoop`는 매 틱 `localInputState` 전체 복사 대신 이 둘을 씁니다. `localInputState`는 진단용으로 남습니다.
- pixel-physics: `savePixelWorldInto(world, out)`를 추가합니다. 어댑터는 `saveInto: (out) => savePixelWorldInto(world, out)`로 연결합니다.
- 내부: 패킷은 공유 Writer 하나로 만들고, 방 세대 태그를 core가 헤더에 직접 써서 전송·수신마다의 복사를 없앴습니다. 플레이어 ID는 roster 번호로 바꿔 입력 표를 배열로 찾고, 확정 입력 리플레이는 확정 시점에 바로 변화분 bytes로 기록합니다(링 버퍼·델타 기록). `Math.min(...)` 펼침·JSON 문자열 비교·`tick:hash` 문자열 키를 루프·원소 비교·2단 Map으로 바꿨습니다.
- 버그 수정: RoomSession이 세대를 닫을 때, 경계(target)를 지나 확정까지 간 peer의 리플레이 구간이 경계 뒤 틱을 포함해 다음 구간과 1틱 겹칠 수 있었습니다. 이제 구간은 경계에서 잘립니다(`room-modes-browser`의 구간 겹침 검사가 타이밍에 따라 실패하던 원인).
- 측정(Node, 2 peer, 256바이트 상태, 20000틱, 전후 교대 5회 중앙값): 틱당 할당 lockstep 27.8→7.9KB, rollback 29.3→8.7KB, createLoop 포함 37.8→10.9KB·39.3→11.6KB. 틱당 시간은 rollback 104→24µs, createLoop 포함 110→39µs·115→29µs. 값 codec 500개체×20필드 encode 중앙값 3.2→2.8ms. 큰 raw 상태(1~4MiB)의 `benchmark:rollback`은 이전과 비슷합니다.

## v0.49.0 (2026-11-10)

호환 기능 추가(공개 API 추가). `pathfield`에 유닛 하나가 한 번 가는 길을 찾는 A\* `RouteFinder`를 추가합니다. 기존 `PathGrid`·`DistanceField`·`FieldCache`의 동작은 그대로입니다. 상세 계약은 [pathfield](../../modules/pathfield/README.md#routefinder-a)에 있습니다.

- `find(start, goals, { maxExpanded }, out)`: 시작 칸에서 목표 칸들(고리 같은 목표 영역) 중 가장 싼 칸까지의 경로(칸 번호). 거리장과 같은 `stepCell` 규칙(직선 10·대각 14, 칸·변 통과 판정, 모서리 가로지르기 금지)이라 같은 격자에서 최단 비용이 `DistanceField`와 같습니다. 닿을 수 없거나 확장 한도를 넘으면 null이고 `status`(`'unreachable'`·`'limit'`)로 구분합니다.
- `waypoints(cells, lineClear, out)`: 꺾이는 칸만 남기고, 직선 판정 콜백을 주면 보이는 웨이포인트로 건너뛰어 줄입니다.
- `advance(waypoints, index, x, y, reach, lineClear)`·`remainingClear(waypoints, index, x, y, segmentClear)`: 저장된 웨이포인트와 인덱스 하나로 따라가기와 "배치가 바뀌었을 때 남은 길이 막혔는가" 재검증.
- 결정론: 정수 비용, 힙 순서는 f → h → 칸 번호. 탐색 버퍼는 격자 칸 수의 타입드 배열을 세대 번호로 재사용합니다.
- 예제: work-scheduler 예제 "거리장" 탭에 "A\* 경로" 버튼(저장된 웨이포인트를 "한 걸음"으로 따라감)을 추가했습니다.
- 시험: `modules/pathfield/tests/pathfield.e2e.mjs`에 고정 시나리오(거리장 비용과 A\* 비용 일치, 막힌 목표·닫힌 방·막힌 시작, 모서리 대각 금지, 여러 목표 중 가장 가까운 칸, 확장 한도, 웨이포인트, 따라가기, 재검증, 결정론)를 더했고, `project/tests/previews.mjs`가 A\* 버튼으로 거리장과 같은 비용·웨이포인트를 따라 도착하는지 확인합니다.

## v0.48.2 (2026-11-10)

호환 기능 추가. `boot.bindBootProgress`의 기본 문구가 `이름 n/N · P%`가 되고, 단계 이름 표 `labels`와 완료 문구 `done`을 받습니다. 첫 단계 전에는 글자 요소를 건드리지 않습니다. `text`를 주는 소비자는 그대로이며, `text`가 null을 반환하면 글자를 그대로 둡니다. 상세 계약은 [boot](../../modules/boot/README.md)에 있습니다.

## v0.48.1 (2026-11-10)

호환 기능 추가. `boot.importPinnedModules`가 고정 목록(`base`·파일·SHA-256)의 모듈을 받아 검증한 bytes만 import하고 파일마다 진행을 보고합니다. 게임이 직접 갖고 있던 CDN 검증 로딩을 대체할 수 있으며 Worker에서도 동작합니다. 기존 `boot` API는 그대로입니다. 상세 계약은 [boot](../../modules/boot/README.md)에 있습니다.

## v0.48.0 (2026-11-09)

같은 문서에서 재사용하는 시나리오 표면은 모든 장면에서 첫 유효 프레임을 기다립니다. `waitForFirstFrame` 옵션을 제거했습니다. 이전에 준비와 동시에 표면을 표시하던 소비자는 첫 프레임을 그린 뒤 `present()`를 호출해야 하므로 비호환 MINOR입니다.

## v0.47.10 (2026-11-09)

같은 문서에서 재사용하는 시나리오 표면에 첫 프레임 대기를 추가합니다. 게임이 첫 유효 프레임 제출을 알리면 호스트가 표면을 표시합니다. 준비 완료와 첫 화면 표시를 각각 기다릴 수 있으며, 취소된 실행의 늦은 표시 신호는 무시합니다. 기본 표면 표시 방식과 기존 준비 계약을 유지하는 호환 PATCH입니다.

## v0.47.9 (2026-11-08)

호환 수정. 닫힌 쇼케이스 핸들이 이전 실행과 렌더링 표면을 참조하지 않도록 정리합니다. 취소 콜백에서 다른 장면을 열면 가장 최근 요청만 실행됩니다. [scenario 수명주기](../../modules/scenario/README.md#같은-문서에서-준비된-표면-재사용)를 따릅니다.

## v0.47.8 (2026-11-08)

호환 기능 추가. `scenario.createScenarioSurface`로 같은 문서의 소개 장면들이 이미 준비한 렌더링 표면과 자원을 재사용할 수 있습니다. 장면 교체·취소는 각 실행을 정리하며 표면은 호스트가 닫힐 때 해제합니다. 기존 iframe 경계와 고정 틱 실행은 그대로입니다. 상세 계약은 [scenario](../../modules/scenario/README.md)에 있습니다.

## v0.47.7 (2026-11-08)

호환 기능 추가. bounded 표시 시계에 마지막 권위 표본 이후 유한한 효과 재생 시간을 제공하여 시뮬레이션 틱을 추가하지 않고 마지막 화면과 효과를 같은 시계로 표시합니다. 일시정지와 재생 속도를 유지하며 완료 시 기존 이벤트 큐의 표시 자원을 정리할 수 있습니다. 상세 계약은 [interpolation](../../modules/interpolation/README.md)에 있습니다.

## v0.47.6 (2026-11-07)

호환 기능 추가. 보간 표시 시계에 최신 표본 기준의 선택적 bounded 모드와 재생 속도·일시정지를 제공하며, 표시 이벤트 journal은 같은 프레임의 시뮬레이션 시각에 맞춰 확정 효과를 전달할 수 있습니다. 기존 fixed 시계와 즉시 이벤트 전달은 기본값 그대로입니다. 상세 계약과 지연·복귀 정책은 [interpolation](../../modules/interpolation/README.md)과 [presentation-events](../../modules/presentation-events/README.md)에 있습니다.

## v0.47.5 (2026-11-07)

호환 기능 추가. `scenario`에서 소개와 임베드 화면이 같은 iframe 준비·취소·정리 경계를 사용하고, 비동기 작업이 준비되지 않았을 때 고정 틱을 보류할 수 있습니다. 기존 소개 화면과 기본 틱 동작은 유지합니다. 상세 계약은 [scenario](../../modules/scenario/README.md)에 있습니다.

## v0.47.4 (2026-11-06)

호환 기능 추가. `PathGrid`에 양방향 셀 간 통과 검사를 선택적으로 연결하고 지형 세대별로 결과를 캐시합니다. `ObstacleField.pointClearanceBand`는 두 반경의 점유 여부를 한 번의 기하 조회로 계산합니다. 기존 호출자는 기본 동작이 바뀌지 않습니다.

## v0.47.3 (2026-11-06)

호환 기능 추가. VectorRenderer 생성 시 아틀라스에 선점하는 영역을 `VECTOR_RENDERER_ATLAS_REGIONS`로 공개해 시작 전 레이어 산정에 같은 크기를 사용합니다. 생성 중 release와 재사용이 끼는 경우 사전 산정은 실제보다 보수적일 수 있습니다.

## v0.47.2 (2026-11-06)

호환 기능 추가. `estimateTextureAtlasLayers`는 시작 전에 실제 영역 할당 순서와 동일한 shelf 배치로 초기 아틀라스 레이어 수를 계산합니다. 실행 중 GPU 복사나 자동 증설은 하지 않으며, 계획에 포함하지 않은 동적 자원 공간과 기기 한도는 호출자가 고려합니다.

Edge WebGL2에서 계산된 장수와 실제 할당, 기존 아틀라스와 스프라이트 렌더링·컨텍스트 복구를 확인했습니다. 500개 영역 계획은 이 PC에서 평균 0.066ms였습니다. 실제 모바일 기기는 검증하지 않았습니다.

## v0.47.1 (2026-11-06)

쌀콩팡의 PNG 부위 캐릭터가 SVG를 숨은 뼈대로 쓰거나 GPU 포즈 프로그램 형식을 게임에서 복제하지 않도록 `rendering`에 `compilePoseChannels`를 공개합니다. 기존 벡터 액터도 같은 공통 컴파일러를 사용합니다. `drawQuads`에는 depth-write 시 낮은 알파의 색과 깊이를 함께 버리는 선택적 `depthWriteAlphaThreshold`를 추가합니다. 기본값은 0으로 유지하며 임계값은 부위마다 정점 데이터에 들어가므로 값이 다르다는 이유로 배치를 나누지 않습니다. 색도 버리므로 높은 값은 안티앨리어싱 경계를 잘라낼 수 있습니다.

포즈 프로그램과 부위별 정점 정보는 GPU texture와 스트림 버퍼에 올라갑니다. GPU 포즈여도 쿼드 하나에 프레임당 6×84바이트의 CPU 정점 staging이 필요하며, 초기 pose 생성·texture 메모리와 crowd의 실제 프레임 비용은 별도로 측정해야 합니다. 이 변경은 쌀콩팡 적용이나 성능 우위를 보증하지 않습니다.

Edge·NVIDIA GTX 1660 Ti의 실제 WebGL2에서 PNG 포즈 부위의 독립 시각·배치·컨텍스트 복원, 낮은 알파의 겹침과 기본값·depth-write 비활성 결과를 픽셀로 확인했습니다. 단순 불투명 400개체 × 3부위 장면의 A→B→B→A(40 warmup·60 measured)는 모두 1 draw, 정점 버퍼 604,800B/frame이었고 CPU median A 2.3/2.5ms, B 2.4/2.2ms, GPU median A 0.162/0.358ms, B 0.085/0.076ms였습니다. 같은 결과 픽셀 해시였지만 GPU 값의 분산이 커 해당 장면에서 성능 차이는 단정하지 않습니다. 실제 쌀 아트·지형·병종 혼합은 소비 게임에서 따로 측정해야 합니다.

## v0.47.0 (2026-11-05)

비호환 UI 계약 변경. 성장 트리의 조작 버튼을 없애 지도를 가리지 않고, 분류·상세·구매는 지도 아래에 분리합니다.

- `tech-tree`: 지도 크기와 관계없이 휠·핀치 줌과 마우스·터치 패닝을 지원합니다. 지도 포커스의 `+`·`−`·방향키·`Home`으로도 같은 조작을 합니다. 조작 버튼과 사용하지 않는 `text.zoomIn`·`text.zoomOut`·`text.fit` 계약을 제거했습니다. 소비자는 이 문구 콜백을 지웁니다.
- `rootPosition`: `auto`(기본), 중앙·상하좌우·네 모서리의 9개 위치를 지원합니다. 깊이 0인 루트 그룹을 지정 위치에 맞추며 가장자리에는 16px 여백을 둡니다. 카메라의 시작 위치만 정하고 선행 층 방향은 화면 비율을 따릅니다. 조작 전 크기 변화에는 시작 위치를 맞추고 조작 뒤에는 이동·배율을 지킵니다. 깊은 노드의 직접 주소·포커스는 보이는 곳으로 이동합니다.
- 예제 상단의 도구줄은 제거했습니다. 트리 종류·루트 위치·포인트·초기화는 하단의 접이식 예제 설정에 있고, 분류·상세·투자도 지도 아래에 있습니다. 상태·조건 칩·구매·주소 계약은 유지합니다.
- 고정 브라우저 시나리오는 모바일·PC의 실제 루트 좌표 9종, 작은 트리 줌, 터치 패닝·핀치, 키보드, 상세 분리와 기존 조회·구매·URL 사례를 확인합니다.

## v0.46.10 (2026-11-05)

호환 수정. 최근 pathfield·vision PR에서 남긴 core 검증 실패 세 가지를 처리합니다. 픽셀 허용치와 180초 상한은 바꾸지 않습니다.

- metrics 고정 시나리오가 POSIX에서 Wrangler의 CLI wrapper만 종료해 Workers와 출력 파이프가 남던 문제를 프로세스 그룹 종료로 고칩니다. 수집 클라이언트·서버·D1은 변경하지 않습니다.
- standalone 렌더링 runner 6개가 Windows 설치 경로만 찾던 문제를 고칩니다. 기본값은 Playwright가 설치한 Chromium이고 `CHROMIUM_EXECUTABLE_PATH` 명시 지정은 유지합니다.
- GPU 포즈의 내장 삼각함수 오차가 SVG pivot에서 커지던 문제를 범위 축소와 sine/cosine 다항식으로 고칩니다. 직접 평가와 행렬 캐시가 같은 함수를 쓰며 CPU Float64 조회·시계는 그대로입니다. 기존 고정 장면에 GPU 행렬 캐시와 CPU 부품 행렬의 0.001 단위 비교를 연결합니다.
- 부품 raster atlas를 2배 해상도에서 굽고 2:1 blit으로 축소해 삼각형 경계의 coverage를 보존합니다. 최종 이미지 크기·재생 경로는 같고, 굽는 동안만 최종 아틀라스 바이트의 4배인 작업 텍스처를 추가로 사용합니다. 작업 버퍼는 성공·실패 시 해제하고 장치 한도 안에 배치할 수 없으면 기존 `atlasLimit`을 보고합니다.
- 성능 개선을 주장하지 않습니다. 다항식의 GPU 연산과 첫 굽기 비용이 추가되며 실제 기기 성능은 별도 검증입니다.

## v0.46.9 (2026-11-05)

호환 기능 추가. rally-frontier가 만든 진영별 시야 칸 격자(`VisionField`)를 `vision` 모듈(`dist/vision.js`)로 올립니다. 기존 번들의 동작은 같고, 게임은 아직 옮기지 않았습니다(rally-frontier 이관은 이 모듈 머지 뒤 별도 PR).

- `VisionMap`: 지형을 칸마다 높이 층(`level`)과 막힌 칸(`blocked`)으로 담은 불변 래스터. `VisionMap.sample({ levelAt, blockedAt })`가 칸 중심을 표집하고, `new VisionMap({ level, blocked })`는 이미 가진 래스터를 복사 없이 받습니다. 같은 지형을 보는 모든 팀이 하나를 공유합니다.
- `VisionField`: 한 팀의 시야 격자. `update(observers)`가 `{ id, x, y, radius, level, xray }` 목록을 받아 칸·반경·높이 층이 바뀐 관찰자만 다시 칠하고 사라진 관찰자는 지웁니다. 칸마다 비추는 관찰자 수를 높이 상한별로 세므로 `visibleAt(x, y, targetLevel)`·`ceilingAt(x, y)`는 칸 하나를 읽고, `revision`은 칸이 바뀐 갱신마다 늘어납니다.
- 규칙: 관찰자는 출발 칸에서 안쪽 부모 칸 하나만 보며 바깥으로 걸어 비춥니다(선분 검사 없음). 막힌 칸과 자기보다 높은 칸은 그 칸도 그 너머도 안 보이고, 대상은 비추는 관찰자의 높이 상한이 대상의 높이 층 이상일 때 보입니다. `xray` 관찰자는 막힘·높이를 무시합니다. 진영·정찰 효과 같은 게임 뜻은 담지 않고 팀 합산도 게임이 합니다.
- 원본(rally-frontier `VisionField`)과 다른 점: 건물 가림막(`syncBlockers`)은 올리지 않았습니다(Rally에 `blocksVision` 건물이 없어 쓰이지 않음). 가림막에서만 쓰던 `Math.hypot`이 모듈에 없어 거리 비교가 정수 제곱거리입니다. 관찰자마다 `String` 키 문자열을 만들던 변경 판정을 숫자 비교로 바꿨고, xray는 높이 층만 바뀌어서는 다시 칠하지 않습니다(칠하는 결과가 같음). 잘못된 입력(유한하지 않은 좌표, 범위 밖 반경, 높이 층 없음)은 조용히 넘기지 않고 던지며, `visibleAt`은 대상 높이 층을 항상 받습니다.
- 원본과의 동등성(임시 검증, 저장소에 남기지 않음): 원본 `VisionField`를 그대로 떼어 와 같은 지형·관찰자 이동·생성·소멸·xray·같은 id를 섞은 무작위 판 8개(판마다 60틱, 칸 중심과 무작위 점 4,768곳 × 높이 6가지 질의로 판마다 약 172만 건)에서 `visibleAt`·`ceilingAt`이 모두 같았고, 마스크가 바뀐 틱마다 `revision`도 바뀌었습니다.
- 시험: `modules/vision/tests/vision.e2e.mjs`(core 목록). 작은 지형 그림으로 반경·막힌 칸·높이 층·xray 규칙을 못 박고, 다시 칠하는 조건과 `revision`, 같은 id, 오류를 확인한 뒤, 무작위 지형 위에서 관찰자 24명이 40틱 동안 움직이고 사라지고 생기는 판의 마스크 해시가 원본 구현으로 같은 판을 돌린 해시와 같은지 확인합니다.
- 예제: work-scheduler 예제에 "시야" 탭(`#tab=vision`)을 추가했습니다. 관찰자를 누르거나 끌어 언덕·벽·정찰 효과를 보고, `project/tests/previews.mjs`가 마우스·키보드·터치 에뮬레이션(실제 기기 검증이 아님)으로 확인합니다.
- 배포 구조: `MODULES`에 `vision`을 더해 manifest 모듈 목록이 `vision.js`만큼 늘어납니다. manifest 목록을 고정 검사하는 게임은 다음 pin 갱신 때 목록에 더해야 합니다.

## v0.46.8 (2026-11-05)

호환 기능 추가. rally-frontier가 격자 거리장으로 이동 목표를 정하던 코드(`NavigationGrid`·`DistanceField`·`CellHeap`)에서 정책을 걷어내고 격자·거리장·내려가기만 올린 `pathfield` 모듈(`dist/pathfield.js`)을 추가합니다. 기존 번들의 동작은 같고, 게임은 아직 옮기지 않았습니다(Rally 이관은 별도 작업).

- `PathGrid`: 정수 비용 격자. 호출자가 준 `passable(x, y, cell)`을 칸마다 한 번만 부르고 기억하며(`invalidate()`·`sync(version)`으로 비움), 8방향 이동(직선 10·대각 14, 대각은 두 직교 이웃이 열려 있어야 함)·`nearestOpen`(정사각 고리, 훑는 순서가 동률 규칙)·`openCellsWithin`(거리 고리 안의 열린 칸, `accept` 판정 선택)·`reachableFrom`(이어짐 표시)을 줍니다.
- `DistanceField`: 여러 출발 칸에서 퍼지는 정수 비용 거리장. 필요한 칸까지만 확정하는 게으른 `settle(target)`·`distance(cell)`, 내려가기 `lowestNeighbor(cell)`·`descend(start, maxSteps, out)`(동률은 방향 순서). 힙 키는 `비용 * 2^k + 칸 번호`라 칸 수 상한은 2^22입니다.
- `FieldCache`(선택): 키로 거리장 보관. 용량을 넘으면 먼저 넣은 것부터 버리고(FIFO), 격자가 비워지면 낡은 거리장을 버리고, `sync(epoch)`로 세대(틱)마다 비웁니다.
- 정책은 모듈에 없습니다: 목표 해석, 가까우면 직선·멀면 거리장, 캐시 수명, 내려가는 칸 중 무엇으로 향할지는 게임이 정합니다. 통과 판정은 호출자 함수이고, geometry의 `ObstacleField.pointClear`를 연결하는 모양을 README에 적었습니다.
- 원본과의 동등성(임시 검증, 저장소에 남기지 않음): Rally 원본 `NavigationGrid`를 그대로 떼어 무작위 장애물 지도(4200×4800, 칸 24)에서 같은 질의 흐름과 비교했습니다. 고정·추격 목표, 목표가 닫힌 방 안인 경우(닿지 못함), 장애물 배치 변경 뒤 재계산, 고정 캐시 24개 초과 제거를 섞은 질의 2,500건씩 4개 시드(1만 건)의 반환 좌표가 `Object.is`까지 모두 같았고, 연결 검사(`reachableFrom`)의 칸 표시도 같았습니다.
- 예제: work-scheduler 예제에 "거리장" 탭(`#tab=pathfield`)을 추가했습니다. 장애물은 geometry의 `ObstacleField`입니다.
- 시험: `modules/pathfield/tests/pathfield.e2e.mjs`(core 목록)가 작은 격자의 비용·모서리 규칙·게으른 확정·내려가기·동률·캐시·검증 오류를 값으로 못 박고, `ObstacleField` 연결을 벽의 틈으로 도는 길로 확인하고, 원본 `NavigationGrid`로 돌린 같은 질의 흐름(700건)의 해시와 일치하는지 확인합니다(순수 Node, 약 1초). `project/tests/previews.mjs`가 거리장 탭(마우스·화살표 키·걸음·터치 에뮬레이션)을 확인합니다.
- 배포 구조: `MODULES`에 `pathfield`를 더해 manifest 모듈 목록이 `pathfield.js`만큼 늘어납니다. manifest 목록을 고정 검사하는 게임은 다음 pin 갱신 때 목록에 더해야 합니다.

## v0.46.7 (2026-11-05)

호환 수정·예제 추가(`tech-tree`). 예제 페이지를 더하고, v0.46.6의 약점 세 가지를 고칩니다.

- 예제: `modules/tech-tree/examples/index.html`(미리보기 `tech-tree`). 스탯 트리(분류 3개, 다른 분류의 선행 조건 포함)와 큰 트리(넘쳐서 줌/팬이 되는 크기)를 탭으로 보고 직접 투자해 볼 수 있습니다. 모바일·데스크톱 모두 동작합니다.
- 건너뛰는 선: 두 층 이상 건너뛰는 선이 중간 노드 뒤로 지나가던 것을, 중간 층마다 노드 사이의 빈 길을 따라 곧게 지나가게 바꿨습니다(레퍼런스 P6의 "카드 관통 금지"). 세로·가로 배치 모두 적용됩니다.
- 처음 보기: 선택한 노드를 가운데에 놓고 시작합니다(이전에는 보이기만 하면 그대로 둬 한쪽으로 치우쳤습니다). 분류가 하나뿐이면 탭을 숨깁니다.
- 시험 불안정 두 가지: ① 끌기·핀치 직후 50ms 안의 클릭을 모두 삼켜 `+`/`−`/맞춤 버튼 탭이 사라질 수 있었습니다(노드 클릭만 막도록 제한). ② ResizeObserver의 첫 알림이 끌어 둔 보기를 되돌릴 수 있었습니다(크기가 그대로면 무시하고, 계속 넘치는 크기 변화는 이동·배율을 지킴). 10번 중 2번 실패하던 시험이 14번 연속 통과합니다.
- 시험: 건너뛰는 노드(3층)를 더하고 모든 연결선의 120개 표본점이 다른 노드 안에 들지 않는지(폰 세로·데스크톱 가로), 처음 보기에서 뿌리가 보이는지, 끌기 뒤 늦은 크기 알림이 보기를 되돌리지 않는지, 단일 분류에서 탭이 숨는지를 확인합니다. 새 코드로 확인했고 옛 코드로는 처음 보기 단계에서 실패했습니다(연결선 관통 단계는 옛 코드로 따로 확인하지 못했습니다). 실기기·Safari·Firefox는 확인하지 않았습니다.

## v0.46.6 (2026-11-04)

호환 기능 추가. 새 `tech-tree` 모듈(`dist/tech-tree.js`)을 더합니다. yarn-mayhem·바운코류 게임이 각자 100줄 안팎으로 직접 쓰던 성장 트리 화면(분류 탭·노드 버튼·상태 계산·상세·선행 조건 칩·주소 동기화)을 공용으로 올린 것입니다. 모바일 업그레이드 화면 느낌(분류 탭, 노드 지도, 상세·구매 버튼)이며, 게임은 `requires`만 적고 좌표는 적지 않습니다.

- `createTechTree({ root, navigation, screen, nodes, level, canBuy, onBuy, renderNode, renderDetail, text })`: 필수 옵션·노드가 잘못이면 기본값 없이 던집니다(중복 id·모르는 선행·순환 포함).
- 상태 4종(`owned`·`locked`·`available`·`waiting`)과 선행 조건 AND, 구매는 `onBuy`로만 알리고 모듈은 레벨을 바꾸지 않습니다. 규칙·비용·문구(`text.*`)·그림(`renderNode`·`renderDetail`)은 게임 소유입니다.
- 자동 배치: 분류마다 선행 깊이로 층을 나누고 부모 평균으로 정렬. 세로 화면은 위→아래, 가로 화면은 왼쪽→오른쪽. 노드 72px(손가락 영역 56px 이상).
- 한 화면에 들어가면 그대로, 넘치면 소프트웨어 줌/팬 패널(휠·끌기·핀치·`+`/`−`/맞춤, 줄어든 노드를 누르면 56px까지 키움, 포커스 이동). 브라우저 스크롤은 생기지 않습니다(`overflow: clip`).
- 주소는 `#/<screen>/<id>`: 선택은 `navigation.replace`, 뒤로/앞으로·직접 진입은 구독으로 복원, 시작 때 이력을 쓰지 않습니다.
- 레퍼런스 P6(선행 조건 n칩·충족 선·상태 구별·조회와 구매 분리)를 따릅니다. 선은 색만이 아니라 실선/점선으로 구별합니다.
- 이전 화면과 다른 점: 새 모듈이라 기존 게임은 그대로입니다. 첫 소비자(yarn-mayhem)는 다음 작업에서 옮깁니다.
- 시험: `modules/tech-tree/tests/tech-tree.e2e.mjs`(core 목록). 폰 390×844 터치·데스크톱 1280×800에서 상태 계산·조건 칩·주소·줌/팬·핀치·스크롤 없음·잘못된 입력 오류를 확인했고, 캡처로 폰·데스크톱의 한 화면 맞춤과 넘침 패널을 직접 보았습니다. 실기기·Safari·Firefox, 노드 수백 개 규모 성능, 두 층 이상 건너뛰는 선이 노드 뒤로 지나가는 모양의 개선은 하지 않았습니다.

## v0.46.5 (2026-11-04)

호환 수정(metrics 클라이언트). 페이지를 숨길 때 `sendBeacon`으로 보낸 배치가 유실되면 다시 보낼 사본이 없던 문제를 고칩니다. 봉투·서버·D1은 그대로입니다.

- `metrics`: beacon으로 보낸 배치를 fetch 200을 받을 때까지 메모리에 남기고, 페이지가 다시 보이거나 bfcache에서 돌아오면 같은 seq로 fetch합니다. 숨긴 동안은 주기 전송을 쉽니다. 브라우저 저장소는 쓰지 않으므로 숨긴 채 탭이 사라지면 도착하지 못한 배치는 잃습니다.
- 배경: 운영 세션 하나(Android Chrome)가 첫 fetch와 첫 숨김의 beacon이 모두 도착하지 못해 seq 0·1을 잃었습니다. 이 수정이면 다음 복귀 때 다시 보냅니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`가 숨김 beacon을 막은 뒤 다시 보일 때 같은 seq가 한 행으로 도착하는지 확인합니다.

## v0.46.4 (2026-11-04)

호환 기능 추가. 두 게임(budmori-io, rally-frontier)에 같은 파일로 복제돼 있던 얼굴 표정 코드를 `face` 모듈(`dist/face.js`)로 올립니다. 기존 번들의 동작은 같습니다.

- 표정 정의: `FACE_IDS` 13가지(상태 8 + 성격 5)와 `faceParts`·`buildFace`·`faceSvg`·`cheekEllipses`·`ellipsePath`. 원본 `face-layer.js`와 모든 표정·여러 앵커·볼 색에서 출력이 같습니다(깊은 비교).
- 몸 연결: `FACE_SOCKETS`(`face-eye-left`·`face-eye-right`·`face-mouth`), `faceAnchor(compiled)`, `posedFace(actor, rest, out)`.
- 그리기: `FaceOverlay`(표정 부품을 아틀라스에 한 번 굽고 자세에 맞춰 얹음, 확대되면 경로), `OperationImages`(그리기 명령을 굽는 일반형), `drawFacePaths`·`drawOperations`.
- 예제: 렌더링 예제에 "표정" 탭을 추가했습니다(`#face`).
- 시험: `modules/face/tests/face.e2e.mjs`(core 목록)가 진짜 SVG 몸과 vector actor 위에서 굽기·그리기·확대·컨텍스트 소실 복구·정리를 확인하고, `project/tests/previews.mjs`가 표정 탭을 확인합니다.

## v0.46.3 (2026-11-04)

호환 기능 추가. `createNostrRoom`에 host의 방 코드 충돌 확인 시간을 정하는 `collisionCheckMs`(기본 1200, 0..10000)를 더합니다. 넘기지 않으면 동작이 같습니다.

- `transport`: `collisionCheckMs: 0`이면 host가 같은 코드의 다른 host를 기다려 듣지 않고 신호가 준비되자마자 돌아옵니다. 같은 페이지에서 `createLocalSignaler`로 host·guest 쌍을 직접 만드는 경우(Rally 싱글 AI 상대)에는 충돌할 상대가 없는데 1.2초를 기다리던 것을 없앱니다. 한계: 끄면 `room-in-use` 감지가 사라져 같은 코드의 두 host를 거르지 못합니다. join은 이 옵션을 무시합니다.
- 시험: `modules/transport/tests/room-browser.mjs`가 `collisionCheckMs: 0`인 host가 확인 대기 없이 돌아와 guest와 바로 연결되는 것을 확인합니다.

## v0.46.2 (2026-11-04)

호환 기능 추가(metrics). 세션 시작에 언어·화면 크기 구간·터치 여부를 남기고, 수집 서버 `/daily`가 조회 때 이를 셉니다. 배치 봉투(schema 3)는 그대로이고 운영 서버는 머지 전에 다시 배포합니다.

- `metrics`: `createMetrics({ locale })` 옵션이 생겼습니다. `session_start`(bfcache 복귀 포함)의 `props`에 `locale`·`viewport`(`VIEWPORT_STEPS` 구간으로 내린 `'WxH'`)·`touch`(`pointer: coarse`)가 들어갑니다. 정확한 크기·저장소 ID는 보내지 않습니다.
- 서버: `GET /daily`에 칸별 `contexts`(`locale`·`viewport`·`touch`별 세션 수, 없으면 `unknown`)를 더했습니다. 새 열·표는 없습니다.
- 문서: 놀이를 멈추는 실패를 `track('error', <kind>, 'fail', { mode })`로 보내는 관례(메시지·스택 미전송)를 README에 적었습니다.
- 예제: '지표' 탭이 `locale: 'ko'`를 넘깁니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`가 데스크톱·터치 에뮬레이션의 `session_start` props와 `/daily` `contexts`를 확인합니다.

## v0.46.1 (2026-11-04)

호환 기능 추가. 두 게임(RALLY FRONTIER·Budmori)이 따로 짜던 균일 격자를 하나로 합친 `spatial` 모듈(`dist/spatial.js`)을 추가합니다. 기존 번들의 동작은 같고, 게임은 아직 옮기지 않았습니다(게임 쪽 이관은 별도 작업).

- `UniformGrid`: 점 항목을 중심 칸 하나에 넣는 고정 칸 격자. 숫자 인덱스 버킷(Map·문자열 키 없음), 사용한 칸만 비우는 재구축, 호출자 `out` 배열을 채우는 사각형·원 후보 질의(할당 없음), 칸 고리 최근접 탐색(A001의 Budmori 0.67.37 방식 일반화), 움직인 항목만 옮기는 `move`/`remove`(정수 인덱스는 typed array, 객체는 Map), 진영 같은 구분(group)별 버킷. 세계 밖 규약(`clamp`/`overflow`)과 원점·칸 크기는 만들 때 받습니다.
- `BoundsGrid`: 사각형 항목을 겹치는 모든 칸에 넣고 경계 상자가 겹치는 항목을 삽입 순서로 중복 없이 돌려줍니다(정렬 없이 칸 버킷 병합). 큰 항목 목록, 부분 목록(view), `afterId`로 쌍을 한 번씩.
- 순서 계약: 칸은 행 우선, 버킷 안은 삽입 순서, 빼면 마지막 항목이 그 자리로(swap-remove). README에 호출별 순서를 표로 적었고 두 게임의 기존 순서가 이 계약입니다. 순서 옵션은 필요하지 않았습니다.
- 원본과의 동등성(임시 검증, 저장소에 남기지 않음): rally-frontier `spatial-grids.js` 4종과 budmori-io `FixedSpatialGrid`를 복사해 같은 입력으로 비교했습니다. 칸 경계·세계 밖·같은 자리·NaN/Infinity·죽은 유닛·대형 스윕을 섞은 무작위 입력에서 Rally 약 114만 건(스윕 질의 85만 개), Budmori 약 576만 건의 질의 결과와 순서가 모두 같았습니다.
- 원본에서 찾은 잠재 버그: Rally `DeterministicUnitSpatialGrid.sync`는 이미 색인에서 뺀 죽은 유닛을 칸이 바뀌게 다시 sync하면 낡은 슬롯으로 다른 유닛을 색인에서 뺍니다(다음 재구축까지). 확인한 호출(`constrain` 두 곳·`resolveSolidEmergence`·하드 보정 뒤 루프)은 살아 있는 유닛만 sync하고 이동 경로(`motion.move`)는 확인하지 못했습니다. 모듈은 이 동작을 재현하지 않습니다.
- 측정(3,000개 규모·농장 500개, 원본과 교대 10회, 부하 있는 PC라 경향만): 질의는 같은 수준(0.91~1.05배), `move` 같은 sync는 약 -20%, 재구축은 +12~36%(충돌 격자 3,000개 0.063 → 0.081ms, 유닛 격자 0.091 → 0.120ms), 농장 `move`는 500마리 한 틱 +0.007~0.02ms. 스윕 질의는 질의마다 만들던 클로저가 없어졌습니다.
- 시험: `modules/spatial/tests/spatial.e2e.mjs`(core 목록). 작은 고정 예로 순서 계약(칸 순서·swap-remove·구분·세계 밖·고리·최근접 중단·BoundsGrid 병합)을 값으로 못 박고, 두 게임의 호출 흐름(전선 충돌 12틱·농장 10틱)을 돌린 질의 결과·순서의 해시가 원본 구현으로 같은 흐름을 돌린 해시와 같은 것을 확인합니다. 순수 Node 값 검증이고 약 0.4초입니다.
- 실행 예제는 두지 않았습니다: 시간·화면·입력이 없는 계산이라 보여 줄 동작이 없고, 계약은 위 시나리오가 값으로 확인합니다.
- 배포 구조: `MODULES`에 `spatial`을 더해 manifest 모듈 목록이 `spatial.js`만큼 늘어납니다. manifest 목록을 고정 검사하는 게임(budmori `gamekit-provenance.cjs`)은 다음 pin 갱신 때 목록에 더해야 합니다.

## v0.46.0 (2026-11-04)

비호환 변경(`createNostrRoom` 계약). 한 번 이어지면 끝나던 `createNostrRoom`을, 끊기면 같은 방에서 스스로 다시 잇는 1:1 방 연결로 교체합니다. 다른 번들의 동작은 같습니다. 이 저장소와 소비 게임 모두 이전 `createNostrRoom`을 쓰지 않았으므로(게임은 고정된 dist를 씁니다) 호환 래퍼는 남기지 않았습니다.

- `transport`: `createNostrRoom({ role, room, namespace, version, … })`가 신호가 준비되면(host는 방 코드 충돌 확인까지) `Room`을 돌려줍니다. 이전에는 연결 완료 뒤 `{ transport, peerConnection, close, … }`였습니다. `opened`(처음 열릴 때까지)·`state`(`connecting`/`open`/`interrupted`/`failed`/`closed`)·`subscribe`·`subscribeStatus`·`reconnect({ reason, newPeer })`·`close()`.
- 채널 셋: `room.transport`(netcode 입력 unordered·제어 ordered, rollback `Transport`)는 재연결해도 같은 객체로 구독이 유지되고 방이 소유합니다. `room.app`은 앱이 자기 프로토콜을 얹는 ordered 채널이며 512/128 KiB 수위의 송신 큐 흐름 제어를 모듈이 맡습니다.
- 재연결: 채널 닫힘·연결 실패·`disconnected` 유예·시도 시간 초과를 감지해 새 연결을 맺습니다. 협상마다 host가 올리는 serial로 늦게 온 옛 offer·answer·ICE·`discover`를 버리고, 처음 맺은 상대의 신호 id를 고정하며(`newPeer`로 해제), 시간 예산(`timeoutMs`·`reconnectTimeoutMs`)을 넘기면 `failed`로 멈춥니다(`reconnect()`로 다시 시작). 신호 전송이 연달아 실패하면 같은 서명 키로 전달자를 다시 만듭니다. `close()`는 재연결을 일으키지 않습니다.
- 버전 불일치: 필수 `version` 문자열과 rollback 프로토콜 번호를 연결 전에 비교해 `version-mismatch` 이벤트로 알리고 연결을 만들지 않습니다(guest는 `failed`, host는 맞는 상대를 계속 기다림).
- 바뀐 계약: 반환 시점, `version` 필수, `peerFactory` 제거(`signalerFactory`로 주입), 신호 네임스페이스 `:room-v2`, `WebRTCTransport`가 방 안에서 연결마다 만들어지고 밖으로는 `room.transport`만 보입니다. Rally `NostrRtcTransport` 대응표는 transport README에 있습니다.
- `createLocalSignaler`: 같은 페이지의 방 연결끼리만 신호를 주고받는 `signalerFactory`용 전달자(시험·싱글 AI 상대용). `iceServers: []`와 함께 씁니다.
- 시험: `modules/transport/tests/room-browser.mjs`(network 목록)가 같은 페이지의 두 방으로 연결, 앱·netcode 채널 양방향, 송신 큐, 양쪽에서 PeerConnection 끊기와 `reconnect()`, 옛 신호 재전송, offer보다 먼저 도착한 ICE 후보의 보관, 신호 장애 중 연결 손실과 복구, 버전 불일치, 시간 초과와 되살리기, 방 코드 충돌, `close()` 뒤 무동작을 한 흐름으로 확인합니다. 실제 relay(`nos.lol`·`relay.snort.social`)로 같은 PC의 두 브라우저 컨텍스트가 연결·재연결되는 것을 임시 스크립트로 3회 확인했습니다(저장소에는 넣지 않음). 공용망의 서로 다른 NAT·모바일 기기는 미검증입니다.

## v0.45.3 (2026-11-04)

호환 기능 추가. 2D 기하 수학과 원형 이동체의 접촉 해소를 모은 `geometry` 모듈(`dist/geometry.js`)을 추가합니다. 기존 번들의 동작은 같습니다.

- 수학 함수: 점-다각형 포함, 점-선분·선분-선분 거리, 선분 교차, 다각형 겹침, 직사각형 접촉, 폴리라인 점·접선·진행 비율, Catmull-Rom, 띠 다각형, 점 거리. `BoundsIndex`(AABB 버킷 색인)와 `triangulatePolygon`(귀 자르기)을 포함합니다.
- 접촉: `SweptCircleContact`(원 대 원 이동 접촉), `SurfaceContactGeometry`(원-다각형 접촉 생성, 원·모서리 cast, 슬라이드). 동률은 `tieRank` 주입 함수가 가르며 기본값은 `tieKey|contactKey|sign`의 FNV-1a입니다.
- `ObstacleField`(다각형 + 원 장애물 + 월드 경계의 통과 검사)와 `SurfaceMotion`(`solve`·`cast`·`contacts`·`recover`·`advance`·`constrain`). 좌표 반올림과 접촉 허용치는 `fixedPoint` 옵션(Rally는 100)으로 받습니다.
- 게임 규칙·길찾기·지형 의미는 담지 않습니다(README의 경계 참고). Rally `e679806`의 `map-geometry.js`·`terrain.js`·`navigation.js`에서 범용 부분만 올렸고, Rally 대응표는 모듈 README에 있습니다.
- 예제: work-scheduler 예제의 "기하" 탭(`#tab=geometry`)에서 터치·마우스로 목표를 정하면 멈춤·사영·조정의 끝 자리를 그려 봅니다. 탭 전환 코드는 탭 버튼에서 이름을 읽도록 바꿨습니다.
- 시험: `modules/geometry/tests/geometry.e2e.mjs`(core 목록), `project/tests/previews.mjs`의 기하 탭(마우스·화살표 키·터치 에뮬레이션).
- 비트 동일 확인(임시 검증, 저장소에 남기지 않음): Rally 원본 클래스 소스를 그대로 잘라 무작위 입력과 비교했습니다. 4,800개 월드(다각형·원·월드 크기·반지름·좌표 격자를 무작위로, 모서리 정확 충돌과 허용치 경계 포함)에서 약 4,870만 번의 출력 비교가 `Object.is`·키 순서까지 모두 같았습니다.

## v0.45.2 (2026-11-04)

호환 기능 추가(metrics 수집 서버). D1에 받은 원본만 저장하고 지표는 조회 때 계산합니다. 배치 봉투(schema 3)와 클라이언트 번들은 그대로이고, 운영 서버는 D1 migration 0002 적용과 함께 다시 배포합니다.

- 서버: `sessions`는 첫 배치의 사실만 한 번 쓰고(누적 열 `last_seen_at`·`play_ms` 제거), 모든 배치를 `play_ms`와 함께 한 행씩 저장합니다(이벤트가 없어도). `batches`·`matches`의 중복 열 `game`·`build`·`schema_version`을 없앴습니다. migration 0002가 기존 세션의 `play_ms`를 마지막 배치로 옮깁니다.
- 서버: `GET /stats`에 `lines`·`returningLines`·`note`를 더했고, `avgWallMs`는 이벤트의 클라이언트 시각 차입니다. `GET /daily`(KST, 1~90일)가 날짜별 세션·회선·새 회선·평균/중앙 플레이 시간·체류 시간·경기 수와 기간의 국가·이벤트 횟수·경기 완주율을 돌려줍니다.
- 예제: '지표' 탭이 경기마다 `match:solo:start`를 보냅니다.
- 문서: README "수집 서버"와 AGENTS.md에 "D1에는 원본 사실만, 계산값은 조회 때" 규칙을 적었습니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`가 배치의 `play_ms`, 조회 계산 체류 시간·회선, `/daily`의 날짜 행·이벤트 횟수·완주율·국가를 확인합니다.

## v0.45.1 (2026-11-04)

호환 기능 추가. 행위자의 행동을 행동트리(결정)와 상태 기계(실행 단계)로 나눠 짜는 `behavior` 모듈(`dist/behavior.js`)을 추가합니다. 기존 번들의 동작은 같습니다.

- `BehaviorTree`와 `action`·`guard`·`selector`: 결정 전용이라 진행 중(RUNNING) 노드가 없고 트리에 행위자 상태를 두지 않습니다. `decide(context)`는 차례를 가져간 행동 이름을 돌려줍니다.
- `StateMachine`: 현재 상태는 행위자 레코드의 문자열 필드 하나이고, 상태마다 적은 `to` 밖의 전이는 오류입니다.
- 예제: work-scheduler 예제를 탭 페이지로 바꾸고 "행동" 탭을 추가했습니다(`#tab=behavior`).
- 시험: `project/tests/previews.mjs`가 행동 탭의 결정·단계 진행을 확인하고, 빠져 있던 pixel-physics-side-battle 예제의 준비 확인(`sideBattle`)을 넣었습니다.
- `.prettierignore`에 `.claude/`(저장소 안 worktree)를 넣어 빌드 전 포맷 검사가 다른 작업 사본을 읽지 않습니다.

## v0.45.0 (2026-11-04)

비호환 변경(replay 형식 `0.3.0-dev`). 확정 입력을 매 tick 객체 대신 바뀐 tick만 담은 바이트로 내보내고, 방 세션도 경기 기록을 남깁니다. 0.2.0 기록은 읽지 않습니다(저장된 기록 없음).

- `replay`: `frames` 대신 `inputChanges`(tick 차이·참가자 순번·입력 바이트)와 `commands`를 읽습니다. `baseTick`·`membershipEpoch`가 있으면 adapter에 전역 tick·세대를 넘깁니다.
- `rollback`: `createRoomSession({ recordReplay: true })`와 `RoomSession.exportReplay()`를 추가했습니다. roster 세대마다 구간 하나입니다. `localFastPath`도 이 옵션으로 기록합니다. 기본값은 기록 없음으로 그대로입니다.
- `metrics`: `SessionReplayRecorder`가 `RoomSession`도 받습니다.
- 시험: `local-fastpath-browser.mjs`가 기록 재생 hash·입력 바이트 수를, `dynamic-browser.mjs`가 입퇴장 4가지 모드에서 살아 있는 참가자의 구간별 재생 hash를 확인합니다.

## v0.44.0 (2026-11-04)

비호환 변경(metrics 전송 계약). 개발자 본인 플레이를 보낼 때 표시하지 않고 서버에서 나중에 거릅니다. 배치가 `schemaVersion: 3`이 되고 `tester`가 빠지며, 수집 서버는 schema 2 배치를 400으로 거절합니다. 운영 서버는 이 버전과 함께 다시 배포했습니다. 다른 모듈의 동작은 같습니다.

- `metrics`: `?metrics-tester` 주소 옵션, `setTester`·`tester`, localStorage 기억을 제거했습니다. 게임 쪽에 할 일이 없습니다.
- 서버: 세션마다 접속 키(회선 HMAC, 원본 IP 아님)·국가·도시·ASN·통신사·User-Agent·Origin을 저장하고, `owners` 표에 넣은 회선의 세션·경기를 `GET /stats`에서 소급해 `owner`(+`keys`)로 뺍니다. `GET /whoami`로 지금 회선의 키를 봅니다. 비밀값 `IP_KEY_SECRET`이 필요합니다.
- 예제: '지표' 탭의 개발자 표시 스위치를 "내 접속 키 보기"로 바꿨습니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`가 접속 키·IPv6 /64 묶음·다른 회선 유저·소급 owner 분리를 확인합니다.

## v0.43.0 (2026-11-04)

비호환 변경(metrics 전송 계약). 집계에서 개발자 본인 플레이를 가릅니다. 배치가 `schemaVersion: 2`와 `tester`를 담고, 수집 서버는 schema 1 배치를 400으로 거절합니다. 운영 서버는 이 버전과 함께 다시 배포했습니다. 다른 모듈의 동작은 같습니다.

- `metrics`: 주소의 `?metrics-tester=<기기 이름>`을 이 기기에 기억하고(`off`로 해제), `setTester(name | null)`·`tester`를 추가했습니다. iframe embed 게임은 설정 화면에서 `setTester`를 부릅니다.
- 서버: 세션·경기에 `tester`와 요청 Origin을 저장하고, `GET /stats`를 `users`·`tester`(+`devices`)·`dev`(localhost 등) 세 칸으로 돌려줍니다. 원본 IP는 저장하지 않습니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`에 이름표 기억·해제 뒤 유지·세 칸 집계를 추가했습니다.

## v0.42.6 (2026-11-04)

호환 기능 추가. 게임 지표를 자체 수집하는 `metrics` 모듈(`dist/metrics.js`)과 Cloudflare Workers + D1 수집 서버(`modules/metrics/server/`)를 추가합니다. 기존 번들의 동작은 같습니다.

- `createMetrics({ game, version, adapter })`: `track(category, target, action, props)`, 세션 시작·끝, 보이는 동안만 세는 플레이 시간과 heartbeat, 배치 전송, 숨김·닫힘 때 `sendBeacon`.
- 범용 클래스와 구현체: `MetricsAdapter` → `HttpAdapter`·`MemoryAdapter`, `MatchRecorder` → `InputLogRecorder`(싱글)·`SessionReplayRecorder`(rollback Session). 멀티플레이는 같은 `matchId`로 한 행만 남깁니다.
- 서버: `POST /batch`(크기·스키마 검증, 배치당 2행 안팎), `GET /stats`(세션 수·평균 플레이 시간·경기 수), CORS.
- 개발 도구에 `wrangler` 4.152.0을 추가합니다(로컬 `wrangler dev`와 고정 시나리오용). 배포 경로와 CI 단계는 바뀌지 않습니다.
- 시험: `modules/metrics/tests/metrics.e2e.mjs`(core 목록).

## v0.42.5 (2026-11-04)

호환 성능 개선. 군중 규모에서 `drawRegion`·정렬(depth) quad 제출의 호출당 할당을 없앱니다. 그리는 결과와 공개 API는 같습니다.

- `drawRegion`: 원본 영역 배열·검사용 배열·`Float32Array` 두 개·흰색 배열을 만들지 않습니다. 두 quad 경로 모두 사각형을 자기 버퍼로 복사한 뒤 돌아오므로 컨텍스트당 scratch 한 쌍을 씁니다.
- `validateQuads`: 목록·색 검사를 배열 생성 없이 반복문으로 합니다.
- 정렬 경로 명령 기록: 명령마다 만들던 20칸 배열 리터럴 대신 칸별로 쓰고, quad 색·morph 기본값과 index 6개도 할당 없이 씁니다.
- 측정: budmori 1,000마리 frame 벤치(교대 5회, 실제 GPU): render 50.3 → 48.9ms(-3%).
- 시험: `paint-regions`, `run-texture-atlas`, `run-vector-gradient-clip`, `run-sprite-animation`, `project/tests/browser.e2e.mjs` 통과.

## v0.42.4 (2026-11-03)

호환 성능 수정. v0.42.3의 "같은 구간은 움직이는 필드만" sample이 구간마다 필드 목록을 미리 만들어, 화면 갱신이 틱보다 느린 경우(구간을 한 번만 sample) 비용만 늘던 회귀를 고칩니다. 목록은 같은 구간을 두 번째로 sample할 때 만듭니다.

- budmori 1,000마리(9fps, 틱 20Hz)에서 0.42.3의 CPU 보간 5.8 → 8.8ms 회귀를 확인했습니다(교대 5회).
- 측정: `runtime-benchmark.mjs --frames 1`(신규 옵션, 프레임/틱 1) sample 0.42.2 5.5~6.0 / 0.42.3 7.2~7.5 / 0.42.4 5.6~6.4ms, `--frames 3` 0.42.3 4.86~4.88 / 0.42.4 4.98~5.13ms(교대 2회, 부하 있는 PC).

## v0.42.3 (2026-11-03)

호환 성능 개선. 군중 규모 `PresentationRuntime`의 capture·sample 비용을 더 줄입니다. 공개 API·시간·세대·reset 계약은 같습니다.

- capture가 필드마다 `Object.getOwnPropertyDescriptor`로 객체를 만들던 것을 없앴습니다. 원본 객체·스키마별로 필드가 처음 생길 때 한 번만 accessor를 검사하고, 이후에는 own 속성 확인과 일반 읽기만 합니다(같은 객체의 필드를 나중에 getter로 바꾸는 것은 지원 계약 밖, README).
- 같은 구간·같은 보류 상태 안의 다음 sample은 양 끝이 수치인 보간 필드와 경로 머리만 계산해 씁니다. discrete·보류·빈 필드는 이미 쓴 값 그대로입니다.
- 측정: `node modules/interpolation/scripts/runtime-benchmark.mjs`(1,000개체·87필드, v0.42.2 빌드와 교대 3회, 부하 있는 PC): capture 10.0~10.1 → 8.3~8.9ms/틱(약 -15%), sample 5.34~5.41 → 4.85~5.13ms/프레임(약 -7%).

## v0.42.2 (2026-11-03)

호환 성능 개선. 군중 규모(1,000개체 × 선언 필드 약 90개)에서 `PresentationRuntime`의 capture와 sample 비용을 줄입니다. 공개 API·시간·세대·reset 계약은 같습니다.

- 스키마 컴파일 때 자식 배열·배열 인덱스·discrete 여부를 미리 계산해 capture·모델 쓰기가 Map 순회와 정규식 검사를 하지 않습니다.
- 지연(`delayMs`) 권위 capture의 필드별 규칙은 증가한 DECAY만 새 값에서 시작하는 것뿐이므로 DECAY 필드만 봅니다(나머지는 이전 목표값).
- sample은 트랙마다 시계 비율·보류 여부를 한 번 계산합니다.
- 재사용 모델에 마지막으로 쓴 값을 기억해, 구조(shape)가 같으면 바뀐 필드만 씁니다. 모델을 수정하지 않는 기존 계약(README)에 기댑니다.
- 측정: `node modules/interpolation/scripts/runtime-benchmark.mjs`(1,000개체·87필드·delay 50ms, 교대 5회, 부하 있는 PC): capture 20.7~24.4 → 16.8~18.9ms/틱(약 -25%), sample 10.9~12.6 → 8.7~9.9ms/프레임(약 -22%).
- 시험: `project/tests/browser.e2e.mjs`의 보간 시나리오(birth·tickBoundary·strictPath·pathCorner·lifetime·rollback·teleport·preview·frameGuard·atomicAttackState) 통과.

## v0.42.1 (2026-11-03)

호환 수정. rollback 코어가 아직 한 번도 유효한 패킷을 보내지 않은 상대(`connecting`)의 침묵을 `peer-interrupted`로 알리지 않습니다. 게임 시작 때 상대가 시뮬레이션을 만드는 데 `peerInterruptMs`(기본 1초)보다 오래 걸리면 "통신 중단 → 재개"가 뜨던 문제를 고칩니다(RALLY FRONTIER 싱글 시작에서 확인).

- 연결된 적이 있는 상대의 침묵은 그대로 interruption이고, 연결 전 상대도 `peerTimeoutMs`가 지나면 `peer-timeout`으로 알립니다.
- 시험: `modules/rollback/scripts/rollback-browser.mjs`(network 목록)에 연결 전 2초 침묵에서는 interruption이 없고, 연결 뒤 같은 침묵에서는 있는 것을 더했습니다. 이전 코어로는 이 시험이 실패함을 확인했습니다.

## v0.42.0 (2026-11-03)

비호환 API 변경. `installShowcase`가 필수 `locale`(`'ko'`|`'en'`)을 받습니다. 소개영상 호스트의 조작 문구가 한국어로 고정되어 영어 화면의 게임에서도 "일시정지·닫기·직접 플레이"가 보이던 문제를 고칩니다.

- 모듈이 일시정지·이어 보기·닫기·직접 플레이·다시 보기·시간·준비/끝/실패 문구·오류 문구를 ko·en 두 벌로 가집니다. `title`과 `timeline`의 장 제목은 게임이 이미 푼 문자열을 넘깁니다.
- 격리 iframe 주소에 `?lang=<locale>`을 붙입니다. 격리 장면은 저장한 언어 선택을 읽지 않으므로(i18n `isolated`) 호스트 언어를 주소로 알려 줍니다.
- `locale`이 없거나 두 언어가 아니면 `TypeError('showcase configuration')`입니다. 이 모듈을 쓰는 게임은 pin을 올릴 때 `locale: LOCALE.locale`을 넘겨야 합니다.
- 시험: `modules/scenario/tests/browser.mjs`에서 `locale: 'en'`일 때 닫기·직접 플레이 문구와 iframe의 `lang`, 지원하지 않는 언어의 거부를 확인합니다.

## v0.41.3 (2026-11-03)

호환 수정. `buildPwa`가 쓰는 `<head>` 태그가 게임의 Prettier와 부딪히지 않습니다. 게임은 `index.html`을 `.prettierignore`에 넣지 않아도 됩니다.

- 태그를 Prettier(html) 모양으로 씁니다: void 태그 ` />`, 값에 `"`가 더 많으면 작은따옴표(`content='… "따옴표"'`). 짧은 태그는 Prettier가 바꾸지 않습니다.
- 바뀐 파일 판단에서 마커 사이는 따옴표 밖 공백과 `/>` 차이를 무시합니다. Prettier가 printWidth에 맞춰 속성을 줄바꿈한 `index.html`도 `check`가 통과하고 생성기가 다시 쓰지 않습니다. 이전 생성기가 쓴 `>` 태그도 같은 것으로 보므로 pin만 올린 게임의 `check`는 그대로 통과합니다.
- 버전 고정 외부 라이브러리(npm CDN)를 sw.js가 캐시하는 기능은 넣지 않았습니다. 게임이 파일 목록을 관리하지 않는다는 v0.41.0 방향을 지키고, 그 라이브러리의 오프라인 시작은 브라우저 HTTP 캐시에 맡깁니다.
- 배포: 이전 dist manifest의 파일 이름 검사가 숫자를 허용하지 않아 v0.41.2의 `i18n.js` 다음 배포가 "Invalid previous bundle path"로 멈췄습니다. 이름 규칙을 `^[a-z][a-z0-9-]*\.m?js$`로 넓힙니다(경로 구분자·`..`는 여전히 거부).
- 시험: `modules/pwa/tests/pwa.e2e.mjs`에 생성 결과를 Prettier로 넓은 printWidth에서 다시 써도 마커 사이가 그대로인 것, printWidth 60으로 줄바꿈한 파일에서 `check` 통과·다시 쓰지 않음·태그 이름을 바꾸면 `index.html`이 바뀐 것으로 잡힘을 더했습니다. 이전 build.js로는 이 시험이 실패함을 확인했습니다.

## v0.41.2 (2026-11-02)

호환 추가. 새 `i18n` 모듈(`dist/i18n.js`)을 더합니다. budmori의 게임 안 다국어 층(TextPair)을 공용으로 옮긴 것이며, 발 배구가 첫 소비자입니다.

- `createLocale({ locales, fallback, storageKey, param, isolated })`: `?lang=` → 저장한 선택(동기 localStorage) → 브라우저 언어 → fallback으로 페이지를 읽을 때 한 번 정합니다. `isolated`이면 저장을 읽지도 쓰지도 않습니다. `choose(code)`는 저장하고 `?lang=`으로 새로고침합니다(실행 중 재번역 없음).
- `messages(table)`는 정의할 때 모든 TextPair 짝을 검사하고, 없는 키를 읽으면 던집니다. `text(pair, values)`는 모델 데이터의 TextPair를 풉니다. `applyPage(root, table)`는 `data-i18n`·`data-i18n-<속성>`과 `<html lang>`을 채웁니다. `number`·`plural`은 `Intl`을 씁니다.
- i18next 대신 직접 둔 이유(README): 키 오타·번역 누락이 조용히 대체되지 않고 오류가 됩니다. 문장 전체를 언어별 함수가 가져 조사·어순에 포매터가 필요 없습니다. 외부 의존성이 없습니다.
- 배포 구조: `MODULES`에 `i18n`을 더해 manifest 모듈 목록이 `i18n.js`만큼 늘어납니다. manifest 목록을 고정 검사하는 게임(budmori `gamekit-provenance.cjs`)은 다음 pin 갱신 때 목록에 더해야 합니다.
- 시험: `modules/i18n/tests/i18n.e2e.mjs`(core 목록). 헤드리스 Chromium에서 브라우저 언어·`?lang=`·저장 순서, `choose`의 저장과 새로고침, 격리 장면의 저장 미사용, 짝 누락·남는 언어·키 오타·정적 키 오타 오류, 숫자·복수형을 확인합니다. 실기기·Safari·Firefox는 미검증입니다.

## v0.41.1 (2026-11-02)

호환 추가. 새 `boot` 모듈을 더합니다. 브라우저 runtime `dist/boot.js`와 Node ESM 도구 `dist/boot-build.mjs`입니다. 게임은 시작 단계와 가중치만 정하고 실제 개수를 보고하며, 전체 진행률·모듈 preload·`<progress>` 표시는 모듈이 맡습니다.

- `listModuleGraph({ root, entry })`: 진입 모듈의 정적 import·`export … from`·문자열 리터럴 `import()`를 따라 로컬 모듈 전체를 root 기준 경로로 반환합니다(진입점 첫 항목, 너비 우선). 없는 파일·root 밖·`./`/`../`가 아닌 지정자는 던지고 `https:` 절대 URL은 뺍니다. 게임은 결과를 runtime manifest에 커밋합니다.
- `createBoot({ stages, onChange })`: `begin(id, total)`·`advance(id, n)`·`finish(id)`·`complete()`·`fail(error)`·`subscribe`. overall = Σ weight × completed/total ÷ Σ weight이며 개수를 모르는 단계는 끝날 때까지 0입니다. ETA·시간 추정은 없습니다. 끝난 뒤의 늦은 보고는 무시하고 재시도는 전체 페이지 다시 읽기입니다.
- `preloadModules(urls, { stage })`: 모든 URL을 한 번에 `<link rel=modulepreload>`로 요청하고 파일마다 1씩 셉니다. 나중 `import()`가 같은 URL이면 module map을 재사용하므로 그래프 깊이만큼의 요청 waterfall이 없어집니다. modulepreload 미지원 브라우저는 `fetch`로 HTTP 캐시만 데웁니다.
- `bindBootProgress(boot, { progress, label, text })`·`yieldFrame()`: 게임이 표시 코드를 따로 쓰지 않게 합니다.
- 배포 구조: `NODE_TOOLS`에 `boot-build`를, `MODULES`에 `boot`를 더해 manifest 모듈 목록이 `boot.js`·`boot-build.mjs`만큼 늘어납니다. manifest 목록을 고정 검사하는 게임(budmori `gamekit-provenance.cjs`)은 다음 pin 갱신 때 두 파일을 목록에 더해야 합니다.
- 이전 화면과 다른 점: 새 모듈이라 기존 게임은 그대로입니다.
- 시험: `modules/boot/tests/boot.e2e.mjs`(core 목록). 약 20개 fixture 그래프의 목록 순서·함정 문법 제외·없는 파일/bare 지정자 오류, 요청마다 40ms 지연 서버의 헤드리스 Chromium에서 n/N 1씩 N/N까지·overall 단조 증가 후 1·preload 뒤 `import()`의 추가 모듈 요청 0·실패 경로를 확인했습니다. budmori `src/farm-app.js` 그래프(284개)에서 목록이 espree 기준 목록과 같은 것을 임시로 대조했습니다. 실기기·Safari·Firefox와 로딩 시간 개선 폭은 측정하지 않았습니다.

## v0.41.0 (2026-11-02)

비호환 API 변경. `pwa`는 "페이지를 읽으면(새로고침 포함) 항상 최신 버전" 하나만 보장합니다. 백그라운드 다운로드·대기 worker·업데이트 알림을 없앱니다. 게임의 "업데이트 확인"은 저장 후 `location.reload()`입니다.

- 생성 sw.js: 설치 때 아무것도 받지 않고 바로 이어받습니다(`skipWaiting`·`clients.claim`). 같은 origin GET은 매번 `cache: 'no-cache'`로 서버에 재확인하고(GitHub Pages `max-age=600` 동안 이전 파일이 섞이지 않게), 200 응답을 scope별 runtime 캐시 하나에 오프라인 사본으로 둡니다. 네트워크 오류일 때만 사본을 씁니다. activate가 같은 scope의 이전 precache 캐시를 지웁니다. 커밋 고정 gamekit 주소의 cache-first는 그대로입니다.
- `buildPwa`: `precache` 옵션을 제거합니다(넘기면 unknown option으로 던짐). sw.js는 게임 파일과 무관한 고정 코드라 게임 파일만 바뀐 배포는 재생성이 필요 없습니다.
- `registerPwa`: `onUpdate` 옵션과 `checkForUpdate()`·`update()`를 제거합니다. 모르는 옵션은 TypeError입니다. `serviceWorker`·`onError`·`onInstallable`, `installable`·`install()`·`dispose()`는 그대로입니다.
- 오프라인 시작은 worker가 제어한 상태로 한 번 읽은 뒤(두 번째 방문)부터입니다. 첫 방문에 전체를 받아 두던 precache 동작은 없습니다.
- 시험: `modules/pwa/tests/pwa.e2e.mjs`를 새 계약으로 바꿨습니다. 실제 Chromium에서 첫 방문 worker 제어·설치 때 받은 파일 없음·이전 precache 캐시 삭제, `max-age=600`+ETag 서버에서 파일 배포 후 새로고침 한 번에 새 버전, 오프라인 새로고침에 마지막 버전과 고정 gamekit 주소를 확인합니다. `no-cache`를 뺀 sw.js로는 배포 단계가 실패함을 확인했습니다. 실기기·iOS Safari·실제 설치 창은 미검증입니다.

## v0.40.4 (2026-11-02)

호환 성능 개선. 보간 표본의 scalar STEP 복사는 순환 그래프 검사 Set을 만들지 않고, 배열/객체를 처음 복사할 때만 검사 그래프를 만듭니다. 중첩 복사에는 같은 그래프를 전달합니다. 동결된 plain 부모의 직계 schema 필드가 모두 scalar일 때만 검증된 표본을 약한 캐시로 재사용합니다. 가변 부모·배열·객체 STEP 잎은 매번 복사합니다. 원본과 표본 분리, finite 숫자·plain data·accessor·순환 거부, 필드별 시계/전환/preview 계약은 유지합니다.

버드몰이1,000마리 상태 캡처에서 반복되던 컨테이너 생성 경로를 줄입니다. 고정 모델/브라우저 시나리오와 게임의 같은 seed·tick 비교로 검증하며, scalar 복사 비용을 앱 FPS나 실제 GPU 성능으로 환산하지 않습니다.

## v0.40.3 (2026-11-02)

호환 추가. SVG keyframe·pose channel·actor base pose에서 유한한 `scaleX: 0` / `scaleY: 0`을 허용합니다. 일반 retained mesh의 부위와 자식은 면적0으로 접혀 그려지지 않고, 크기를 복구하면 같은 geometry가 다시 보입니다. 불투명 병력의 부품을 alpha 대신 크기로 접고 펼칠 수 있습니다. 기존 양수·음수 scale, opacity 범위, 재생 시계와 GPU/CPU 계산은 바꾸지 않습니다.

공통 입력 검사가 막던0만 허용하며 별도 visibility API·게임 판정·종별 분기를 추가하지 않습니다. 기존 실제 WebGL 사용자 시나리오에서 두 축·한 축 접힘/복구, socket 유한성, GPU/CPU 및 GPU 행렬 캐시를 검증합니다. 실기기는 미검증 범위입니다.

## v0.40.2 (2026-11-01)

호환 성능 개선. `VectorContext`의 opt-in `mesh.orderedMeshQuads`가 반투명 retained body mesh와 뒤따르는 atlas quad·호환되는 일반 벡터 paint를 요청 순서대로 같은 indexed batch에 담습니다. 다른 병종·표정·색 때문에 게임의 painter 순서를 바꾸지 않고, 불투명 depth-write 몸통은 기존 instancing을 유지합니다.

- 원본 정점은 숫자 texture에 한 번 보관하고 작은 정점 참조·index와 command만 제출합니다. indexed vertex reuse를 유지하며 GPU keyframe pose 계산도 계속 사용합니다. 정점마다 pose를 다시 계산하던 초기 triangle-instancing 설계는 측정된 GPU 회귀로 채택하지 않았습니다.
- 같은 opt-in에서 float target이 지원되면 GPU keyframe을 부위별 숫자 행렬로 한 번 계산해 정점들이 공유합니다. 기본 경로는 유지하고, target 미지원·복구 불가 시 기존 GPU program을 사용합니다. CPU 평가나 몸통 raster 이미지를 추가하지 않습니다.
- 일반 paint는 같은 스타일의 삼각형들을 좌표·UV(정점당16byte)와 공유 스타일 명령으로 나누며, SDF·gradient·atlas fragment 구현을 native stream과 공유합니다. posed/offscreen paint·정점별 스타일은 원래 경로에 남습니다.
- chunk별 topology·command 자원을 bounded LRU로 보관해 불변 참조/index 재업로드와 chunk 간 덮어쓰기를 피합니다. 버퍼와 숫자 texture는 실제 사용 길이보다 넓은 용량을 재사용하고 실제 할당 용량으로 예산을 계산합니다. 추가 캐시 메모리와 변경된 topology 업로드는 진단 수치에 노출합니다.
- 기존 mesh/quad의 premultiply 순서, palette, transform, depth, index variant/range, clip/stencil/blend 및 context 복구를 보존합니다. transform-only restore는 batch를 유지하고 stencil 재구축·atlas·pose 변경은 먼저 제출합니다. 미지원 기능은 자신의 native 경로에서 순서대로 그립니다.
- 검증: 기존 WebGL interop 사용자 시나리오에 전체 픽셀 비교, A/B/A 순서·palette·RGBA gradient·atlas 변경·작은 capacity·중첩 stencil·context 복구를 포함합니다. 버드모리의 동일 고정 장면과 대규모 CPU·draw·업로드 측정은 소비 게임의 검증 기록에서 구분합니다. 실제 PC/모바일 GPU 성능은 별도 범위입니다.

## v0.40.1 (2026-11-01)

호환 API 추가. PWA `checkForUpdate(): Promise<void>`가 등록 완료를 기다린 뒤 브라우저에 업데이트 재확인을 요청합니다. 등록은 `updateViaCache: 'none'`을 사용하며, 온라인·가시성 복귀도 같은 재확인을 요청합니다. 동시 확인은 한 요청을 공유하고 dispose는 페이지·worker 상태 구독을 정리합니다. 확인 중 발견한 worker의 설치 성공·실패까지 기다리고, 업데이트 유무나 최신 버전 여부를 반환하지 않습니다. 설치되어 기다리는 새 버전은 기존 `onUpdate`로만 알립니다.

자동 활성화하지 않습니다. 게임이 저장 성공을 확인한 뒤 기존 `update()`를 호출해야 새 worker를 활성화하고 다시 읽습니다. 오프라인·등록 실패·폐기 후 호출은 명시적으로 거부하며 저장소 자체는 변경하지 않습니다.

## v0.40.0 (2026-11-01)

비호환 오류 계약 수정. `save.load()` 중 `migrate[n]`이 던진 오류를 `SaveError('unreadable')`로 감싸고 원래 오류는 `cause`에 남깁니다. 이전에는 이관 오류가 그대로 전달되어 `locked`가 false로 남았지만, 이제 검증 실패와 같이 저장 원본을 보존하고 이후 `update`를 거부합니다. 정상 이관의 데이터·schema·revision과 게임 실행 중 `update` 오류 전달은 유지합니다.

고정 저장 브라우저 시나리오에 손상된 구 schema의 이관 실패 → 원본 bytes 유지 → 쓰기 잠금 → 자동 저장 거부 흐름을 포함합니다. 문서에 보장했던 이관 예외 타입이 바뀌므로 MINOR를 올립니다.

## v0.39.5 (2026-11-01)

호환 성능 개선. `VectorRenderer.drawQuads`의 clip 없는 일반 이미지 사각형을 정점 버퍼에 직접 기록합니다. 사각형마다 만들던 임시 corner·UV 배열, point 객체와 삼각형별 객체 복사를 없앱니다. 정점 좌표의 연산 순서·색·UV·깊이·그리는 순서·clip·배치 용량·posed sprite 계약은 그대로입니다. clip이 있으면 기존의 실제 삼각형 clip 연산을 사용합니다.

- 버드노리 얼굴 부품의 CPU 프로파일에서 반복 할당 비용을 확인해 적용합니다. 이미지·조합을 새로 굽거나 GPU 자산 수를 늘리지 않습니다.
- 검증은 기존 texture atlas·sprite animation·gradient/clip·device/vector 사용자 시나리오와 버드노리의 같은 장면 픽셀 비교로 수행합니다. GPU 호출 최적화와 실제 CPU 시간은 별도로 측정합니다.

## v0.39.4 (2026-11-01)

호환 추가. `rendering`의 `VectorContext`에 `depth`·`depthTest`·`depthWrite`·`depthFunc`를 더합니다. 메시와 이미지/도형 스트림이 같은 깊이 버퍼를 사용하므로, 소비자는 불투명 몸통을 메시별로 모으고 얼굴·장면 도형은 원래 순서의 스트림으로 제출할 수 있습니다. 정렬·레이어 정책은 게임이 소유합니다.

- 기본값은 깊이 0·검사/기록 꺼짐·`lequal`로 기존 동작을 유지합니다. 깊이는 정점별 값이므로 깊이값만 바뀌면 배치를 끊지 않습니다. 검사·기록·비교 함수가 바뀌면 제출합니다. `save/restore`와 프레임 초기화, 일반/posed 이미지·글자·경로·도형 및 actor 기본값에 적용합니다.
- 깊이를 기록하는 메시/이미지는 alpha 0 fragment를 버려 숨긴 부위와 투명 이미지 여백이 다른 물체를 가리지 않게 합니다. 실제 반투명 색 합성은 여전히 painter order를 지켜야 합니다. 깊이 attachment가 없는 framebuffer·반투명 group에서 깊이 사용은 명시 오류입니다.
- `hasOpaqueCoverage(geometry,{indexVariant})`는 초기 준비 때 같은 part의 불투명 삼각형이 반투명 삼각형을 모두 덮는지 판정합니다. 보장할 수 없는 메시·외곽 반투명 조각은 false여서 소비자가 순서를 유지할 수 있습니다. SVG·메시 원본이나 캐시를 다시 굽지 않습니다.
- 비용: 벡터 스트림 정점은 80→84 bytes입니다. 정점별 깊이가 추가되며, 이 변경 자체를 FPS 개선으로 환산하지 않습니다.
- 고정 브라우저 검증: 서로 다른 깊이의 도형/아틀라스 이미지가 한 draw에 묶이고 앞뒤를 올바르게 가림, alpha 0 여백·메시 숨김, 상태 복원·새 프레임·그래픽 복구, 기존 gradient/clip·texture atlas·sprite animation을 확인합니다. 실제 기기 GPU·모바일 성능은 별도 범위입니다.

## v0.39.3 (2026-11-01)

수정. `rendering`의 `WebGLDevice.updateDataTexture`가 RGBA32F 숫자 데이터를 올리기 전에 pixel-unpack 상태와 `UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`를 명시합니다. DOM 이미지를 atlas에 올린 직후 GPU 애니메이션 pose를 갱신하면, 이전 이미지 업로드의 premultiply 설정이 숫자 채널에 적용되어 몸통·팔·잎이 사라질 수 있었습니다.

- 이전 화면과 다른 점: 원본 GPU vector actor를 prewarm한 뒤 얼굴·아이콘 이미지를 올려도 몸통이 유지됩니다. CPU pose나 sprite로 전환하지 않습니다.
- 계약: DOM 이미지의 premultiplied alpha 처리, Float32Array 원본 보존·부분 갱신·context 복구, 표시 순서와 게임 시계는 그대로입니다.
- 고정 검증: device 브라우저 시나리오에 DOM/바이트 이미지와 숫자 RGBA(네 번째 채널 0·0.5)의 교차 업로드 픽셀 검사를 추가하고, 기존 native GPU pose 시나리오에서 prewarm 이후 DOM 아이콘 업로드를 이어 검사합니다. 실제 기기 GPU·모바일 검증은 별도 범위입니다.

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
- 화질: 수정 전과의 평균 차이가 스티치 무늬 신호의 5~~8%이고 최대 차이는 34/255, 차이가 8을 넘는 픽셀은 활성 픽셀의 0.02% 이하입니다(선 두께 0.41~~3, 1~2.5배 확대). 셀 가로세로 비가 1이 아니면(출하 에셋은 약 0.92) 거리를 근사하고, 선 마스크 반경이 0.25 셀을 넘는 아주 굵은 선은 잘립니다.

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

`deterministic`의 값 codec에 바이너리 형식 전용 typed array 태그(`Int8Array`·`Int16Array`·`Uint16Array`·`Int32Array`·`Uint32Array`·`Float32Array`·`Float64Array`, 요소는 little-endian, 실수는 유한 값만, `-0`은 `0`)와 `omitUndefined` 옵션을 추가합니다. 이전 SDK의 디코더는 새 태그가 든 payload를 읽지 못하므로 SDK 버전이 섞인 방에서는 쓰지 마세요. 기존 payload는 바이트 그대로 읽히고 같은 값의 인코딩 결과도 바이트가 같습니다. encode는 작업 버퍼를 재사용해 반복 호출에서 확장 복사를 없앱니다(격자 상태 인코딩 0.51~~1.0ms → 0.15~~0.27ms). `pixel-physics`의 `savePixelWorld`는 래퍼의 복사를 없애고(`snapshot(false)`) 새 태그를 직접 쓰며, 격자 배열을 같은 값 구간으로 줄여 저장합니다. 정지한 1280×720 월드의 스냅샷이 2.77MB에서 약 24KB로 줄어 히스토리 예산과 합류·복구 전송량이 크게 줄고, 구간이 줄지 않으면 원본으로 저장합니다. 이전 `savePixelWorld` 바이트는 새 `loadPixelWorld`로 읽을 수 없으므로 두 버전의 피어를 섞지 마세요. 수치는 Node 22 한 대에서 잰 값입니다.

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

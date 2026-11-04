# metrics

**HTML 실행 프리뷰:** [bm 예제의 '지표' 탭](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=metrics) — 랠리·경기 끝을 누르면 운영 수집 서버(`gamekit-example` 게임 이름)에 저장되고 서버 집계(세션 수·평균 플레이 시간·경기 수)를 다시 읽어 보여 줍니다. 주소 칸을 로컬 `wrangler dev`(`http://127.0.0.1:8787`)로 바꾸면 로컬 D1에 씁니다.

게임 지표를 자체 수집하는 순수 ESM 모듈과 Cloudflare Workers + D1 수집 서버입니다. 이벤트 이름·요약 값의 의미는 게임이 소유합니다. 고빈도 값은 보내지 않고, 경기마다 결정론 기록(시드 + 입력)을 남겨 나중에 어떤 지표든 다시 계산합니다.

## 구성

    modules/metrics/index.js          클라이언트 (dist/metrics.js)
    modules/metrics/protocol.js       클라이언트·서버가 함께 쓰는 배치 계약 (schemaVersion, 상한, 바이트 인코딩)
    modules/metrics/server/           Worker(worker.js)·D1 스키마(schema.sql)·wrangler.toml

## 사용

범용 코어 하나에 경우별 구현체 클래스를 끼웁니다. 어댑터는 `MetricsAdapter`, 경기 기록은 `MatchRecorder`를 상속해 필요한 메서드만 오버라이드합니다.

```js
import { createMetrics, HttpAdapter, InputLogRecorder, SessionReplayRecorder } from './dist/metrics.js';

const METRICS = createMetrics({
    game: 'bloom-takraw',
    version: '0.3.0',
    adapter: new HttpAdapter('https://bloom-metrics.<계정>.workers.dev'),
});
METRICS.track('menu', 'start', 'click');

// 싱글(rollback 없이 고정 tick): 확정 입력을 직접 남깁니다.
const SOLO = new InputLogRecorder({ mode: 'solo', seed });
SOLO.input(tick, input); // 확정 tick마다
METRICS.recordMatch(SOLO, { score: 15, rallies: 42 });

// rollback Session(로컬·온라인): SDK의 exportReplay()를 그대로 남깁니다. 참가자 모두 같은 matchId를 넘깁니다.
const ONLINE = new SessionReplayRecorder({ session: SESSION, mode: 'online', matchId: `${roomId}:${epoch}` });
METRICS.recordMatch(ONLINE, { winner: 'a' });
```

개발·디버그 장면은 `adapter: new MemoryAdapter()`로 바꿉니다. `batches`에 보낸 배치가 남습니다.

## 게임에 붙이는 순서

새 세션에서 게임에 지표를 붙일 때 이 순서를 따릅니다. 배경 결정은 D-203(자체 수집 + 결정론 경기 기록, 백엔드는 어댑터), D-204(Cloudflare Workers + D1), D-205(범용 코어 + 경우별 구현체 클래스)입니다.

1. **세션 종류를 확인합니다.** 게임이 쓰는 실행 경로에 맞는 기록 클래스를 고릅니다(아래 "경기 기록" 표). `createRoomSession`을 쓰는 게임(bloom-takraw 등)은 `RoomSession`에 replay가 없어 `SessionReplayRecorder`를 쓸 수 없습니다. 게임에서 입력을 모으는 우회 대신 먼저 rollback 모듈에 replay를 추가하고 그에 맞는 구현체를 이 모듈에 둡니다(작업 흐름 "모듈 개선 → 게임 반영"). 그 전까지는 확정 입력만 `InputLogRecorder`에 넣습니다.
2. **import map에 고정 주소를 넣습니다.** `@bloom-gamekit/metrics` → `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/metrics.js`. 게임의 `gamekit.lock.json`에 URL·SHA-256을 다른 모듈과 같은 dist commit으로 적습니다. branch 주소는 쓰지 않습니다.
3. **부팅 때 한 번 만들고 내 기기 표시를 준비합니다.** iframe embed(itch.io)로 낼 게임은 설정 화면에 `setTester` 스위치를 둡니다("개발자 본인 플레이 분리"). `game`은 저장소 이름, `version`은 게임 빌드 버전입니다. 서버 주소는 아래 "운영"의 배포 주소입니다. 시험·격리 장면(주소 옵션의 디버그 장면 등)은 `MemoryAdapter`로 바꿔 실제 집계에 섞이지 않게 합니다.
4. **이벤트는 사람이 한 행동과 화면 전환만 보냅니다.** category는 화면·기능(`menu`, `match`, `shop`, `ad`), target은 대상(`start`, `rally`, `no_ads`), action은 동사(`click`, `start`, `end`, `buy`)입니다. 매 tick·매 프레임 값은 보내지 않습니다. 경기 중 수치는 경기 끝 summary에 넣고, 나머지는 결정론 기록에서 다시 계산합니다.
5. **경기마다 기록합니다.** 경기 시작에 recorder를 만들고, 확정 tick마다 `input`을 넣습니다(예측·재시뮬레이션 입력 제외). 경기 끝에 `recordMatch(recorder, summary)`를 부릅니다. 멀티플레이는 모든 참가자가 계산할 수 있는 같은 `matchId`(예: 방 sessionId + epoch)를 넘깁니다.
6. **검증합니다.** 로컬 `wrangler dev`에 게임을 연결하고, 게임의 고정 E2E에서 실제 입력으로 한 경기를 끝낸 뒤 `GET /stats`나 D1 행으로 확인합니다. 실제 서버로 보내는 시험을 영구 시험에 넣지 않습니다(집계가 오염됩니다).

## 계약

- 배치 하나가 요청 하나입니다. 배치에는 `schemaVersion`(2), `game`, `build`(= `version`), `sessionId`, `seq`, `playMs`, `tester`, `events`, `matches`가 들어가고 서버의 모든 행에 sessionId·build·schemaVersion이 저장됩니다.
- `track(category, target, action, props?)`: 이름은 1~64자 문자열, props는 JSON 객체입니다. 형식이 틀리면 던집니다.
- 세션: 생성 때 `session_start`, `pagehide` 때 `session_end`를 남깁니다. bfcache에서 돌아오면 같은 세션에 `session_start`를 다시 남깁니다. `dispose()`는 `session_end`를 보내고 타이머·리스너를 해제합니다.
- **플레이 시간은 페이지가 보이는 동안만 셉니다.** `playMs`는 누적값이고 서버는 세션마다 가장 큰 값을 남깁니다. 숨긴 시간은 서버의 `last_seen_at - started_at`(벽시계, 서버 시각)으로 따로 볼 수 있습니다.
- heartbeat(기본 30000ms)는 보이는 동안만 남기며, 페이지가 비정상 종료돼 `pagehide`가 오지 않을 때 잃는 플레이 시간의 상한입니다.
- 이벤트는 50개가 쌓이거나 10000ms마다 보냅니다. 경기 기록은 `recordMatch` 즉시 보냅니다.
- 탭 숨김·닫힘: `sendOnHide`(HttpAdapter는 `navigator.sendBeacon`)로 남은 배치를 올립니다. 60000바이트를 넘는 배치(긴 경기 기록)는 beacon 상한 때문에 정상 경로로 남겨 둡니다.
- 실패: 보내지 못한 배치는 같은 `seq` 그대로 다시 보냅니다. 서버는 같은 배치를 두 번 받아도 결과가 같습니다. 20개를 넘게 쌓이면 오래된 것부터 버리고 `droppedBatches`에 셉니다.
- 배치 하나는 1,000,000바이트까지입니다(D1 한 행 2MB의 절반). 넘는 경기 기록은 `recordMatch`가 `RangeError`로 던집니다.

## 개발자 본인 플레이 분리

집계에서 "나인지 아닌지"는 IP가 아니라 기기 이름표와 요청 출처로 가릅니다. IP는 집 인터넷에서 바뀌고 휴대폰 데이터에서는 여러 사람이 같이 써서 맞지 않고, 원본을 저장하면 개인정보가 됩니다.

| 집계 칸  | 기준                                                                     |
| -------- | ------------------------------------------------------------------------ |
| `tester` | 배치에 이름표(`tester`)가 한 번이라도 있었던 세션. 기기별 수는 `devices` |
| `dev`    | 이름표가 없고 Origin이 없거나 `null`·localhost·127.0.0.1·[::1]           |
| `users`  | 나머지(itch.io 등 게임 페이지)                                           |

- 내 기기는 한 번만 표시합니다. 게임 주소에 `?metrics-tester=<기기 이름>`(예: `pc`, `phone`)을 붙여 열면 그 기기(origin)의 localStorage에 기억되고, `?metrics-tester=off`로 지웁니다. 게임 코드는 바꾸지 않습니다.
- itch.io처럼 iframe 안에서 도는 게임은 브라우저가 저장소를 상위 사이트별로 나눠, iframe 주소를 따로 열어 붙인 이름표가 embed 안에 보이지 않습니다. 그런 게임은 설정 화면 같은 곳에 "개발자 기기" 스위치를 두고 `METRICS.setTester('phone')` / `setTester(null)`을 부릅니다. `METRICS.tester`로 지금 표시를 화면에 보여 줄 수 있습니다.
- 브라우저 데이터를 지우거나 새 기기·새 브라우저를 쓰면 다시 표시합니다. 표시 전에 남은 세션은 `users`에 들어가므로 `devices`와 세션 시각으로 확인합니다.
- 한 번 표시된 세션은 중간에 해제해도 끝까지 `tester`입니다.

## 경기 기록

| 구현체                  | 쓰는 경우                    | `capture()`의 replay                  |
| ----------------------- | ---------------------------- | ------------------------------------- |
| `MatchRecorder`         | 결정론 기록이 없는 게임      | `null` (시드·참가자·summary만)        |
| `InputLogRecorder`      | rollback 없는 고정 tick 게임 | `{ seed, frames: [{ tick, input }] }` |
| `SessionReplayRecorder` | rollback `Session`           | `session.exportReplay()` 그대로       |

- 다른 기록이 필요하면 `MatchRecorder`를 상속해 `capture()`만 오버라이드합니다. `{ seed, players, replay }`를 돌려줍니다.
- `matchId`를 생략하면 새 UUID입니다. 멀티플레이는 참가자 모두 같은 값을 넘기고, 서버는 먼저 도착한 하나만 남깁니다.
- `Uint8Array`는 JSON에서 `{"$bytes": base64}`입니다. 다시 계산할 때 `JSON.parse(text, reviveBytes)`로 되돌려 `playReplay`에 넘깁니다.
- `RoomSession`에는 아직 `exportReplay()`가 없습니다. 방 세션 게임은 `InputLogRecorder`에 확정 입력을 넣거나, rollback에 replay가 생긴 뒤 같은 방식의 구현체를 추가합니다.

## 수집 서버

`POST /batch`는 검증 뒤 D1에 쓰고, `GET /stats?game=<game>[&build=<build>]`는 `{ users, tester, dev }` 칸마다 `{ sessions, avgPlayMs, avgWallMs, matches }`를 돌려줍니다(`tester.devices`는 기기 이름별 세션 수). 실제 유저 지표는 `users`만 봅니다. 응답은 `Access-Control-Allow-Origin: *`이며 클라이언트는 preflight가 없는 `text/plain` 요청을 씁니다.

- 계약 밖 배치는 저장하지 않고 400(`schema-version`·`identity`·`counter`·`tester`·`shape`·`empty`·`too-many`·`event`·`match`)이나 413(`too-large`)으로 거절합니다.
- 쓰기 행: 배치마다 세션 요약 1행 + 이벤트 원본 1행(이벤트가 있을 때) + 경기마다 1행. 무료 한도(쓰기 10만 행/일)를 아끼려고 인덱스는 두지 않습니다.
- 무료 플랜 한도(요청 10만/일, D1 쓰기 10만 행/일, 저장 5GB)를 넘으면 요청이 실패합니다(하드 캡, 과금 없음). 클라이언트는 실패한 배치를 보관 상한까지 들고 있다가 다시 보냅니다.
- `playMs`·이벤트 시각·`tester`는 클라이언트 값을 그대로 믿습니다. 세션 시작·마지막 수신 시각과 Origin(브라우저가 붙임)만 서버가 정합니다. 원본 IP는 저장하지 않습니다.

### 운영

| 항목            | 값                                                                          |
| --------------- | --------------------------------------------------------------------------- |
| 배포 주소       | `https://bloom-metrics.byh-playground.workers.dev`                          |
| Cloudflare 계정 | byh020907@naver.com (account `deaa8cb49d25379de875c00c445503fd`, 무료 플랜) |
| D1              | `bloom-metrics` (`0f0db294-6c6e-44f0-b39a-d6e297f48e0d`, APAC)              |
| workers.dev     | 하위 도메인 `byh-playground`                                                |

계정 가입·이메일 인증·`wrangler login` 승인은 사용자가 합니다. 로그인이 된 PC에서는 아래 명령을 에이전트가 실행합니다. 모든 명령은 `modules/metrics/server`에서 `-c wrangler.toml`로 실행합니다.

- 서버 코드·protocol.js를 바꾼 PR: 머지 뒤 `npx wrangler deploy -c wrangler.toml`. 배치 모양을 바꿔 `SCHEMA_VERSION`을 올렸다면 클라이언트를 쓰는 게임보다 서버를 먼저 배포합니다(서버는 다른 버전을 거절합니다).
- 스키마를 바꾼 PR: 기존 행을 지우지 않는 SQL(`ALTER TABLE … ADD COLUMN` 등)만 `npx wrangler d1 execute bloom-metrics --remote --file <파일> -c wrangler.toml`로 적용합니다. `DROP`·`DELETE`는 사용자 확인 뒤에만 합니다.
- 원본 확인: `npx wrangler d1 execute bloom-metrics --remote -c wrangler.toml --json --command "SELECT game, COUNT(*) AS sessions, AVG(play_ms) FROM sessions GROUP BY game"`. 사용량은 Cloudflare 대시보드의 Workers·D1 화면에서 봅니다.
- 배포 확인은 `gamekit-deploy-check` 같은 검사 전용 game 이름으로 보내고 확인한 뒤 그 행을 지웁니다. 게임 이름으로 시험 데이터를 보내지 않습니다.

### 로컬 실행

    npx wrangler d1 execute bloom-metrics --local --file modules/metrics/server/schema.sql -c modules/metrics/server/wrangler.toml
    npx wrangler dev -c modules/metrics/server/wrangler.toml

`http://127.0.0.1:8787`에서 실제 Workers 런타임(workerd)과 로컬 D1(SQLite)로 돕니다. Windows에서 `--persist-to`를 쓸 때는 짧은 경로를 줍니다(D1 파일 경로가 길면 내부 오류가 납니다).

## 범위

대시보드·퍼널·리텐션 화면, 경기 기록 재계산 도구, 오프라인 보관(localStorage), 서버 인증·속도 제한은 아직 없습니다. 실제로 필요한 게임을 붙일 때 추가합니다.

[고정 시나리오](./tests/metrics.e2e.mjs)(`npm test` core 목록)는 `wrangler dev`(로컬 D1)를 띄우고 bm 예제 '지표' 탭을 데스크톱(마우스)과 터치 에뮬레이션에서 누릅니다: 잘못된 배치 400·413과 CORS → 세션 시작·랠리 3번·경기 끝 → 서버 집계 → 탭 숨김(에뮬레이션: headless Chromium은 숨김을 바꾸지 못해 `visibilityState`만 바꿈) 중 플레이 시간 정지와 beacon → 실제 페이지 이동의 `session_end` beacon → D1 행을 직접 읽어 플레이 시간·경기 기록 확인 → rollback `Session` 두 참가자의 같은 matchId가 한 행 → 저장된 replay로 같은 hash 재계산. 실기기·실제 탭 전환·배포된 Cloudflare는 확인하지 않습니다.

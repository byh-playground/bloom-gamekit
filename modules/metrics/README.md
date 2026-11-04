# metrics

**HTML 실행 프리뷰:** [bm 예제의 '지표' 탭](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=metrics) — 수집 서버 주소를 넣고 랠리·경기 끝을 누르면 실제 서버에 저장되고 서버 집계(세션 수·평균 플레이 시간·경기 수)를 다시 읽어 보여 줍니다. 로컬 `wrangler dev` 주소(`http://127.0.0.1:8787`)나 배포한 workers.dev 주소를 씁니다.

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

## 계약

- 배치 하나가 요청 하나입니다. 배치에는 `schemaVersion`, `game`, `build`(= `version`), `sessionId`, `seq`, `playMs`, `events`, `matches`가 들어가고 서버의 모든 행에 sessionId·build·schemaVersion이 저장됩니다.
- `track(category, target, action, props?)`: 이름은 1~64자 문자열, props는 JSON 객체입니다. 형식이 틀리면 던집니다.
- 세션: 생성 때 `session_start`, `pagehide` 때 `session_end`를 남깁니다. bfcache에서 돌아오면 같은 세션에 `session_start`를 다시 남깁니다. `dispose()`는 `session_end`를 보내고 타이머·리스너를 해제합니다.
- **플레이 시간은 페이지가 보이는 동안만 셉니다.** `playMs`는 누적값이고 서버는 세션마다 가장 큰 값을 남깁니다. 숨긴 시간은 서버의 `last_seen_at - started_at`(벽시계, 서버 시각)으로 따로 볼 수 있습니다.
- heartbeat(기본 30000ms)는 보이는 동안만 남기며, 페이지가 비정상 종료돼 `pagehide`가 오지 않을 때 잃는 플레이 시간의 상한입니다.
- 이벤트는 50개가 쌓이거나 10000ms마다 보냅니다. 경기 기록은 `recordMatch` 즉시 보냅니다.
- 탭 숨김·닫힘: `sendOnHide`(HttpAdapter는 `navigator.sendBeacon`)로 남은 배치를 올립니다. 60000바이트를 넘는 배치(긴 경기 기록)는 beacon 상한 때문에 정상 경로로 남겨 둡니다.
- 실패: 보내지 못한 배치는 같은 `seq` 그대로 다시 보냅니다. 서버는 같은 배치를 두 번 받아도 결과가 같습니다. 20개를 넘게 쌓이면 오래된 것부터 버리고 `droppedBatches`에 셉니다.
- 배치 하나는 1,000,000바이트까지입니다(D1 한 행 2MB의 절반). 넘는 경기 기록은 `recordMatch`가 `RangeError`로 던집니다.

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

`POST /batch`는 검증 뒤 D1에 쓰고, `GET /stats?game=<game>[&build=<build>]`는 `{ sessions, avgPlayMs, avgWallMs, matches }`를 돌려줍니다. 응답은 `Access-Control-Allow-Origin: *`이며 클라이언트는 preflight가 없는 `text/plain` 요청을 씁니다.

- 계약 밖 배치는 저장하지 않고 400(`schema-version`·`identity`·`counter`·`shape`·`empty`·`too-many`·`event`·`match`)이나 413(`too-large`)으로 거절합니다.
- 쓰기 행: 배치마다 세션 요약 1행 + 이벤트 원본 1행(이벤트가 있을 때) + 경기마다 1행. 무료 한도(쓰기 10만 행/일)를 아끼려고 인덱스는 두지 않습니다.
- 무료 플랜 한도(요청 10만/일, D1 쓰기 10만 행/일, 저장 5GB)를 넘으면 요청이 실패합니다(하드 캡, 과금 없음). 클라이언트는 실패한 배치를 보관 상한까지 들고 있다가 다시 보냅니다.
- `playMs`와 이벤트 시각은 클라이언트 값을 그대로 믿습니다. 세션 시작·마지막 수신 시각만 서버 시각입니다.

### 배포 (사용자 절차)

1. [dash.cloudflare.com](https://dash.cloudflare.com)에 무료 가입합니다(카드 불필요).
2. 저장소 루트에서 `npx wrangler login`.
3. `npx wrangler d1 create bloom-metrics` → 출력된 `database_id`를 `modules/metrics/server/wrangler.toml`에 넣습니다.
4. `npx wrangler d1 execute bloom-metrics --remote --file modules/metrics/server/schema.sql -c modules/metrics/server/wrangler.toml`
5. `npx wrangler deploy -c modules/metrics/server/wrangler.toml` → 출력된 `https://bloom-metrics.<계정>.workers.dev`를 `HttpAdapter`에 씁니다.

### 로컬 실행

    npx wrangler d1 execute bloom-metrics --local --file modules/metrics/server/schema.sql -c modules/metrics/server/wrangler.toml
    npx wrangler dev -c modules/metrics/server/wrangler.toml

`http://127.0.0.1:8787`에서 실제 Workers 런타임(workerd)과 로컬 D1(SQLite)로 돕니다. Windows에서 `--persist-to`를 쓸 때는 짧은 경로를 줍니다(D1 파일 경로가 길면 내부 오류가 납니다).

## 범위

대시보드·퍼널·리텐션 화면, 경기 기록 재계산 도구, 오프라인 보관(localStorage), 서버 인증·속도 제한은 아직 없습니다. 실제로 필요한 게임을 붙일 때 추가합니다.

[고정 시나리오](./tests/metrics.e2e.mjs)(`npm test` core 목록)는 `wrangler dev`(로컬 D1)를 띄우고 bm 예제 '지표' 탭을 데스크톱(마우스)과 터치 에뮬레이션에서 누릅니다: 잘못된 배치 400·413과 CORS → 세션 시작·랠리 3번·경기 끝 → 서버 집계 → 탭 숨김(에뮬레이션: headless Chromium은 숨김을 바꾸지 못해 `visibilityState`만 바꿈) 중 플레이 시간 정지와 beacon → 실제 페이지 이동의 `session_end` beacon → D1 행을 직접 읽어 플레이 시간·경기 기록 확인 → rollback `Session` 두 참가자의 같은 matchId가 한 행 → 저장된 replay로 같은 hash 재계산. 실기기·실제 탭 전환·배포된 Cloudflare는 확인하지 않습니다.

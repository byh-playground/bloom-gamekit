# metrics

**HTML 실행 프리뷰:** [bm 예제의 '지표' 탭](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=metrics) — 랠리·경기 끝을 누르면 운영 수집 서버(`gamekit-example` 게임 이름)에 저장되고 서버 집계(세션 수·평균 플레이 시간·경기 수)를 다시 읽어 보여 줍니다. 주소 칸을 로컬 `wrangler dev`(`http://127.0.0.1:8787`)로 바꾸면 로컬 D1에 씁니다.

게임 지표를 자체 수집하는 순수 ESM 모듈과 Cloudflare Workers + D1 수집 서버입니다. 이벤트 이름·요약 값의 의미는 게임이 소유합니다. 고빈도 값은 보내지 않고, 경기마다 결정론 기록(시드 + 입력)을 남겨 나중에 어떤 지표든 다시 계산합니다.

## 구성

    modules/metrics/index.js          클라이언트 (dist/metrics.js)
    modules/metrics/protocol.js       클라이언트·서버가 함께 쓰는 배치 계약 (schemaVersion, 상한, 바이트 인코딩)
    modules/metrics/server/           Worker(worker.js)·D1 표 변경(migrations/0001_*.sql …)·wrangler.toml

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
3. **부팅 때 한 번 만듭니다.** 내 플레이는 서버가 접속 키로 나중에 거르므로 게임 쪽 표시는 없습니다("개발자 본인 플레이 분리"). `game`은 저장소 이름, `version`은 게임 빌드 버전입니다. 서버 주소는 아래 "운영"의 배포 주소입니다. 시험·격리 장면(주소 옵션의 디버그 장면 등)은 `MemoryAdapter`로 바꿔 실제 집계에 섞이지 않게 합니다.
4. **이벤트는 사람이 한 행동과 화면 전환만 보냅니다.** category는 화면·기능(`menu`, `match`, `shop`, `ad`), target은 대상(`start`, `rally`, `no_ads`), action은 동사(`click`, `start`, `end`, `buy`)입니다. 매 tick·매 프레임 값은 보내지 않습니다. 경기 중 수치는 경기 끝 summary에 넣고, 나머지는 결정론 기록에서 다시 계산합니다.
5. **경기마다 기록합니다.** 경기 시작에 recorder를 만들고, 확정 tick마다 `input`을 넣습니다(예측·재시뮬레이션 입력 제외). 경기 끝에 `recordMatch(recorder, summary)`를 부릅니다. 멀티플레이는 모든 참가자가 계산할 수 있는 같은 `matchId`(예: 방 sessionId + epoch)를 넘깁니다.
6. **검증합니다.** 로컬 `wrangler dev`에 게임을 연결하고, 게임의 고정 E2E에서 실제 입력으로 한 경기를 끝낸 뒤 `GET /stats`나 D1 행으로 확인합니다. 실제 서버로 보내는 시험을 영구 시험에 넣지 않습니다(집계가 오염됩니다).

## 계약

- 배치 하나가 요청 하나입니다. 배치에는 `schemaVersion`(3), `game`, `build`(= `version`), `sessionId`, `seq`, `playMs`, `events`, `matches`가 들어가고 서버의 모든 행에 sessionId·build·schemaVersion이 저장됩니다.
- `track(category, target, action, props?)`: 이름은 1~64자 문자열, props는 JSON 객체입니다. 형식이 틀리면 던집니다.
- 세션: 생성 때 `session_start`, `pagehide` 때 `session_end`를 남깁니다. bfcache에서 돌아오면 같은 세션에 `session_start`를 다시 남깁니다. `dispose()`는 `session_end`를 보내고 타이머·리스너를 해제합니다.
- **플레이 시간은 페이지가 보이는 동안만 셉니다.** `playMs`는 누적값이고 서버는 세션마다 가장 큰 값을 남깁니다. 숨긴 시간은 서버의 `last_seen_at - started_at`(벽시계, 서버 시각)으로 따로 볼 수 있습니다.
- heartbeat(기본 30000ms)는 보이는 동안만 남기며, 페이지가 비정상 종료돼 `pagehide`가 오지 않을 때 잃는 플레이 시간의 상한입니다.
- 이벤트는 50개가 쌓이거나 10000ms마다 보냅니다. 경기 기록은 `recordMatch` 즉시 보냅니다.
- 탭 숨김·닫힘: `sendOnHide`(HttpAdapter는 `navigator.sendBeacon`)로 남은 배치를 올립니다. 60000바이트를 넘는 배치(긴 경기 기록)는 beacon 상한 때문에 정상 경로로 남겨 둡니다.
- 실패: 보내지 못한 배치는 같은 `seq` 그대로 다시 보냅니다. 서버는 같은 배치를 두 번 받아도 결과가 같습니다. 20개를 넘게 쌓이면 오래된 것부터 버리고 `droppedBatches`에 셉니다.
- 배치 하나는 1,000,000바이트까지입니다(D1 한 행 2MB의 절반). 넘는 경기 기록은 `recordMatch`가 `RangeError`로 던집니다.

## 버전 관리

출시된 게임 빌드는 플레이어 브라우저·itch.io 캐시에 남아 고칠 수 없으므로, 그 빌드가 보내는 배치가 계속 받아지도록 관리합니다(D-217). 별도 버전은 런타임 판정에 필요한 `SCHEMA_VERSION` 하나만 둡니다(PM-002).

| 대상                      | 버전                                    | 바꾸는 방법                                                                                               |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 배치 봉투(protocol.js)    | `SCHEMA_VERSION` = 3 고정               | 필드 **추가만**. 새 필드는 없어도 되는 값이고 서버를 먼저 배포합니다. 버전을 올리지 않습니다.             |
| D1 표                     | `server/migrations/NNNN_*.sql` 순번     | 새 번호 파일 추가 → `wrangler d1 migrations apply`. 적용된 파일은 고치지 않습니다.                        |
| 게임 props·summary·replay | 따로 없음, 행의 `build`(게임 메인 버전) | 게임이 PM-001대로 버전을 올리며 바꿉니다. 집계·재계산은 `build`로 나눕니다. 게임 README에 키 표를 둡니다. |

봉투를 깨야만 하는 변경(필드 뜻·모양 변경, 제거)은 PM-004의 명시적 예외로만 합니다.

1. `SCHEMA_VERSION`을 4로 올리고 클라이언트·서버 검증을 4 모양으로 바꿉니다.
2. protocol.js에 3 → 4 변환 하나를 둡니다. 서버는 받은 배치를 변환한 뒤 4로 검증·저장합니다. 3보다 오래된 버전과 4보다 새 버전은 그대로 400입니다.

       /**
        * 호환 예외(PM-004): 대상 schema 3 배치 / Consumer: v0.44.x metrics를 쓰는 출시 게임 빌드 /
        * 사유: 배포된 빌드는 고칠 수 없음 / 제거 조건: 운영 D1에서 schema_version = 3 세션이 30일 동안 0
        */
       export const UPGRADES = Object.freeze({ 3: (batch) => ({ ...batch, schemaVersion: 4 /* 바뀐 필드 */ }) });

3. 저장된 옛 행이 새 모양이어야 하면 같은 PR에 D1 migration(`UPDATE …`)을 넣습니다. 행마다 `schema_version`이 남아 있어 대상만 고칩니다.
4. 같은 PR에서 서버를 배포하고, 고정 시나리오에 schema 3 배치가 변환돼 저장되는 확인을 넣습니다.
5. 제거 조건 확인 쿼리: `SELECT MAX(last_seen_at) FROM sessions WHERE schema_version = 3`. 조건을 채우면 변환과 그 확인을 지웁니다.

지금은 변환이 없습니다. 출시 뒤 처음 깨는 변경이 생길 때 위 순서로 추가합니다(사용처 없는 변환 표를 미리 두지 않습니다, PM-013).

## 개발자 본인 플레이 분리

내 플레이는 보낼 때 표시하지 않고 **받은 뒤 걸러 냅니다(후 필터).** 서버가 세션마다 접속 정보를 저장하고, 소유자 회선 목록(`owners`)은 조회 때 붙이므로 회선을 나중에 등록해도 지난 세션까지 함께 빠집니다. 게임 코드·주소 옵션·설정 스위치는 필요 없습니다(D-215).

| 집계 칸 | 기준                                                             |
| ------- | ---------------------------------------------------------------- |
| `owner` | 세션의 접속 키가 `owners`에 있음. 회선 이름별 세션 수는 `keys`   |
| `dev`   | 소유자가 아니고 Origin이 없거나 `null`·localhost·127.0.0.1·[::1] |
| `users` | 나머지(itch.io 등 게임 페이지)                                   |

- 접속 키(`ip_key`): 회선(IPv4 주소, IPv6는 앞 64비트)을 서버 비밀값 `IP_KEY_SECRET`으로 HMAC-SHA256한 앞 16바이트(hex 32자)입니다. 원본 IP는 저장하지 않고, 비밀값 없이는 키에서 IP를 되돌릴 수 없습니다. 비밀값을 바꾸면 모든 키가 바뀌어 `owners`를 다시 등록해야 하므로 바꾸지 않습니다.
- 함께 저장하는 것: Cloudflare가 붙인 `country`·`city`·`asn`·`as_org`, 요청의 `user_agent`·`origin`. 세션의 첫 배치 것을 남깁니다.
- 내 회선 등록: 내 기기에서 `GET <배포 주소>/whoami`를 열어(bm 예제 '지표' 탭의 "내 접속 키 보기"도 같음) `ipKey`를 확인하고, 아래를 실행합니다. `label`은 회선 이름(`home-wifi`, `phone-lte` 등)입니다.

      npx wrangler d1 execute bloom-metrics --remote -c wrangler.toml --command "INSERT OR IGNORE INTO owners (ip_key, label, added_at) VALUES ('<ipKey>', 'home-wifi', unixepoch() * 1000)"

- 같은 회선의 모든 기기(PC·휴대폰 Wi-Fi)가 한 키입니다. 휴대폰 데이터는 접속마다 주소가 바뀌어 키도 바뀌므로 그때그때 `/whoami`로 등록하거나, 등록 전 세션은 `asn`·`city`·`user_agent`·시각으로 찾아 그 `ip_key`를 넣습니다. 같은 집 회선의 다른 사람(가족 등)도 `owner`로 빠집니다.
- `/whoami`의 `owner`는 지금 회선이 등록된 이름이거나 `null`입니다.

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

`POST /batch`는 검증 뒤 D1에 쓰고, `GET /stats?game=<game>[&build=<build>]`는 `{ users, owner, dev }` 칸마다 `{ sessions, avgPlayMs, avgWallMs, matches }`를 돌려줍니다(`owner.keys`는 회선 이름별 세션 수, 경기는 처음 보낸 세션의 칸). `GET /whoami`는 요청 회선의 `{ ipKey, country, city, asn, asOrg, owner }`입니다. 실제 유저 지표는 `users`만 봅니다. 응답은 `Access-Control-Allow-Origin: *`이며 클라이언트는 preflight가 없는 `text/plain` 요청을 씁니다.

- 계약 밖 배치는 저장하지 않고 400(`schema-version`·`identity`·`counter`·`shape`·`empty`·`too-many`·`event`·`match`)이나 413(`too-large`)으로 거절합니다.
- 쓰기 행: 배치마다 세션 요약 1행 + 이벤트 원본 1행(이벤트가 있을 때) + 경기마다 1행. 무료 한도(쓰기 10만 행/일)를 아끼려고 인덱스는 두지 않습니다.
- 무료 플랜 한도(요청 10만/일, D1 쓰기 10만 행/일, 저장 5GB)를 넘으면 요청이 실패합니다(하드 캡, 과금 없음). 클라이언트는 실패한 배치를 보관 상한까지 들고 있다가 다시 보냅니다.
- `playMs`·이벤트 시각은 클라이언트 값을 그대로 믿습니다. 세션 시작·마지막 수신 시각과 접속 정보(접속 키·Cloudflare 위치·헤더)는 서버가 정합니다. 원본 IP는 저장하지 않습니다.
- 비밀값 `IP_KEY_SECRET`이 없으면 `/batch`·`/stats`·`/whoami`가 500(`ip-key-secret`)입니다(배포 설정 누락).

### 운영

| 항목            | 값                                                                          |
| --------------- | --------------------------------------------------------------------------- |
| 배포 주소       | `https://bloom-metrics.byh-playground.workers.dev`                          |
| Cloudflare 계정 | byh020907@naver.com (account `deaa8cb49d25379de875c00c445503fd`, 무료 플랜) |
| D1              | `bloom-metrics` (`0f0db294-6c6e-44f0-b39a-d6e297f48e0d`, APAC)              |
| workers.dev     | 하위 도메인 `byh-playground`                                                |
| 비밀값          | `IP_KEY_SECRET` (Worker secret, 값은 어디에도 적지 않음. 바꾸지 않음)       |

계정 가입·이메일 인증·`wrangler login` 승인은 사용자가 합니다. 로그인이 된 PC에서는 아래 명령을 에이전트가 실행합니다. 모든 명령은 `modules/metrics/server`에서 `-c wrangler.toml`로 실행합니다.

- 서버 코드·protocol.js를 바꾼 PR: 머지 전에 `npx wrangler deploy -c wrangler.toml`. 새 필드를 쓰는 게임 빌드보다 서버가 먼저 나갑니다("버전 관리").
- D1 표를 바꾼 PR: `npx wrangler d1 migrations create bloom-metrics <이름> -c wrangler.toml`로 다음 번호 파일을 만들고, 로컬 고정 시나리오를 통과한 뒤 `npx wrangler d1 migrations apply bloom-metrics --remote -c wrangler.toml`. 남은 파일은 `npx wrangler d1 migrations list bloom-metrics --remote -c wrangler.toml`로 봅니다. `DROP`·`DELETE`가 든 파일은 사용자 확인 뒤에만 적용합니다.
- 비밀값은 처음 한 번만 `npx wrangler secret put IP_KEY_SECRET -c wrangler.toml`(표준 입력으로 임의 값)로 넣었습니다. 다시 넣으면 접속 키가 모두 바뀝니다.
- 원본 확인: `npx wrangler d1 execute bloom-metrics --remote -c wrangler.toml --json --command "SELECT game, COUNT(*) AS sessions, AVG(play_ms) FROM sessions GROUP BY game"`. 사용량은 Cloudflare 대시보드의 Workers·D1 화면에서 봅니다.
- 배포 확인은 `gamekit-deploy-check` 같은 검사 전용 game 이름으로 보내고 확인한 뒤 그 행을 지웁니다. 게임 이름으로 시험 데이터를 보내지 않습니다.

### 로컬 실행

    npx wrangler d1 migrations apply bloom-metrics --local -c modules/metrics/server/wrangler.toml
    npx wrangler dev -c modules/metrics/server/wrangler.toml --var IP_KEY_SECRET:local

`http://127.0.0.1:8787`에서 실제 Workers 런타임(workerd)과 로컬 D1(SQLite)로 돕니다. 로컬에서는 요청의 `CF-Connecting-IP` 헤더가 그대로 들어가 다른 회선을 흉내 낼 수 있습니다(운영은 Cloudflare가 덮어씀). Windows에서 `--persist-to`를 쓸 때는 짧은 경로를 줍니다(D1 파일 경로가 길면 내부 오류가 납니다).

## 범위

대시보드·퍼널·리텐션 화면, 경기 기록 재계산 도구, 오프라인 보관(localStorage), 서버 인증·속도 제한은 아직 없습니다. 실제로 필요한 게임을 붙일 때 추가합니다.

[고정 시나리오](./tests/metrics.e2e.mjs)(`npm test` core 목록)는 운영과 같은 migrations를 로컬 D1에 적용해 기록을 확인하고 `wrangler dev`를 띄운 뒤 bm 예제 '지표' 탭을 데스크톱(마우스)과 터치 에뮬레이션에서 누릅니다: 잘못된 배치 400·413과 CORS → 세션 시작·랠리 3번·경기 끝 → 서버 집계 → 탭 숨김(에뮬레이션: headless Chromium은 숨김을 바꾸지 못해 `visibilityState`만 바꿈) 중 플레이 시간 정지와 beacon → 실제 페이지 이동의 `session_end` beacon → "내 접속 키 보기" → D1 행을 직접 읽어 플레이 시간·경기 기록·접속 키 확인 → 다른 회선의 itch.io 배치만 `users` → rollback `Session` 두 참가자의 같은 matchId가 한 행 → 저장된 replay로 같은 hash 재계산 → 접속 키를 `owners`에 넣으면 지난 세션·경기가 `owner`로 소급. IPv6 같은 /64 한 키도 봅니다. 실기기·실제 탭 전환·배포된 Cloudflare는 확인하지 않습니다.

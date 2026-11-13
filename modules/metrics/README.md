# metrics

**HTML 실행 프리뷰:** [bm 예제의 '지표' 탭](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/bm.html#tab=metrics) — 랠리·경기 끝을 누르면 운영 수집 서버(`gamekit-example` 게임 이름)에 저장되고, 조회 키를 넣으면 서버 집계(세션 수·평균 플레이 시간·경기 수)를 다시 읽어 보여 줍니다. 주소 칸을 로컬 `wrangler dev`(`http://127.0.0.1:8787`)로 바꾸면 로컬 D1에 씁니다.

## 언제 쓰나

- 세션·플레이 시간·이벤트와 경기마다의 결정론 기록(시드 + 입력)을 **자체 수집 서버**(Cloudflare Workers + D1)로 모으고 싶을 때.
- 시험·시연·디버그에서는 서버로 보내지 않고 메모리에만 두고 싶을 때(`MemoryAdapter`).

## 쓰는 모양

```js
// bloom-takraw/src/runtime.js (줄임)
import { createMetrics, HttpAdapter, MemoryAdapter, SessionReplayRecorder } from '@bloom-gamekit/metrics';
const metrics = createMetrics({
    game: 'bloom-takraw',
    version: TAKRAW_VERSION,
    locale: LOCALE.locale,
    adapter: isolated ? new MemoryAdapter() : new HttpAdapter(TAKRAW_RUNTIME.metrics.endpoint),
});
metrics.track(category, target, action, { mode: mode || 'menu', ...props });

// 경기 시작: 시작 이벤트와 같은 matchId의 recorder가 한 번에 나옵니다. 온라인은 두 사람이 같은 matchId를 넘깁니다.
const recorder = metrics.beginMatch({ session, mode, matchId }, SessionReplayRecorder);
// 경기 끝
metrics.recordMatch(recorder, { winner: state.matchWinner, ticks: state.tick, seed: state.seed });
```

## 쓰지 말아야 할 때

| 이런 일                          | 대신                                                |
| -------------------------------- | --------------------------------------------------- |
| 프레임마다 바뀌는 고빈도 값 전송 | 보내지 않습니다. 경기 기록을 나중에 다시 계산합니다 |
| 로컬 오류 진단·프레임 계측       | [debug-tools](../debug-tools/README.md)             |
| 누적·최댓값 같은 계산 열 저장    | 서버는 원본 사실만 저장하고 조회 때 계산합니다      |

## 상세

게임 지표를 자체 수집하는 순수 ESM 모듈과 Cloudflare Workers + D1 수집 서버입니다. 이벤트 이름·요약 값의 의미는 게임이 소유합니다. 고빈도 값은 보내지 않고, 경기마다 결정론 기록(시드 + 입력)을 남겨 나중에 어떤 지표든 다시 계산합니다.

## 구성

    modules/metrics/index.js          클라이언트 (dist/metrics.js)
    modules/metrics/protocol.js       클라이언트·서버가 함께 쓰는 배치 계약 (schemaVersion, 상한, 바이트 인코딩)
    modules/metrics/server/           Worker(worker.js)·D1 표 변경(migrations/0001_*.sql …)·wrangler.toml

## 사용

범용 코어 하나에 경우별 구현체 클래스를 끼웁니다. 어댑터는 `MetricsAdapter`, 경기 기록은 `MatchRecorder`를 상속해 필요한 메서드만 오버라이드합니다. 경기는 늘 `beginMatch` → `recordMatch` 한 경로이고, 기록 방식은 `beginMatch`의 두 번째 인자(클래스)로 고릅니다. recorder를 `new`로 직접 만들지 않습니다(`recordMatch`가 받지 않음).

```js
import { createMetrics, HttpAdapter, InputLogRecorder, SessionReplayRecorder } from './dist/metrics.js';

const METRICS = createMetrics({
    game: 'bloom-takraw',
    version: '0.3.0',
    locale: LOCALE.locale, // 게임이 고른 화면 언어
    adapter: new HttpAdapter('https://bloom-metrics.<계정>.workers.dev'),
});
METRICS.track('menu', 'start', 'click');

// 결정론 기록 없음: 시드·참가자·summary만 남깁니다.
const PLAIN = METRICS.beginMatch({ mode: 'solo', seed });
METRICS.recordMatch(PLAIN, { score: 15 });

// 싱글(rollback 없이 고정 tick): 확정 입력을 직접 남깁니다.
const SOLO = METRICS.beginMatch({ mode: 'solo', seed }, InputLogRecorder);
SOLO.input(tick, input); // 확정 tick마다
METRICS.recordMatch(SOLO, { score: 15, rallies: 42 });

// rollback Session·RoomSession(recordReplay: true): SDK의 exportReplay()를 그대로 남깁니다. 참가자 모두 같은 matchId를 넘깁니다.
const ONLINE = METRICS.beginMatch(
    { session: SESSION, mode: 'online', matchId: `${roomId}:${epoch}:${ordinal}` },
    SessionReplayRecorder,
);
METRICS.recordMatch(ONLINE, { winner: 'a' });

// 끝을 기록하지 않는 모드(관전·연습): 시작은 events에 남고 완주율에서 빠집니다. recordMatch하지 않습니다.
METRICS.beginMatch({ mode: 'watch', record: false });
```

개발·디버그 장면은 `adapter: new MemoryAdapter()`로 바꿉니다. `batches`에 보낸 배치가 남습니다.

## 게임에 붙이는 순서

새 세션에서 게임에 지표를 붙일 때 이 순서를 따릅니다. 배경 결정은 D-203(자체 수집 + 결정론 경기 기록, 백엔드는 어댑터), D-204(Cloudflare Workers + D1), D-205(범용 코어 + 경우별 구현체 클래스)입니다.

1. **세션 종류를 확인합니다.** 게임이 쓰는 실행 경로에 맞는 기록 클래스를 고릅니다(아래 "경기 기록" 표). `createRoomSession`을 쓰는 게임(bloom-takraw 등)은 `recordReplay: true`로 만들고 `SessionReplayRecorder`를 씁니다(혼자 하기 `localFastPath`도 같음). 게임에서 입력을 따로 모으지 않습니다. 기록이 없는 실행 경로가 생기면 게임 우회 대신 rollback 모듈부터 고칩니다(작업 흐름 "모듈 개선 → 게임 반영").
2. **import map에 고정 주소를 넣습니다.** `@bloom-gamekit/metrics` → `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/metrics.js`. 게임의 `gamekit.lock.json`에 URL·SHA-256을 다른 모듈과 같은 dist commit으로 적습니다. branch 주소는 쓰지 않습니다.
3. **부팅 때 한 번 만듭니다.** 내 플레이는 서버가 접속 키로 나중에 거르므로 게임 쪽 표시는 없습니다("개발자 본인 플레이 분리"). `game`은 저장소 이름, `version`은 게임 빌드 버전입니다. 서버 주소는 아래 "운영"의 배포 주소입니다. 시험·격리 장면(주소 옵션의 디버그 장면 등)은 `MemoryAdapter`로 바꿔 실제 집계에 섞이지 않게 합니다. `locale`에는 게임이 고른 화면 언어 코드를 넘깁니다(브라우저 언어 목록이 아님).
4. **이벤트는 사람이 한 행동과 화면 전환만 보냅니다.** 경기 시작은 `track`으로 보내지 않고 `beginMatch`가 `match:<mode>:start`(props `{ matchId }`)를 보냅니다(`/daily` 완주율의 분모). category는 화면·기능(`menu`, `match`, `shop`, `ad`), target은 대상(`start`, `rally`, `no_ads`), action은 동사(`click`, `start`, `end`, `buy`)입니다. 매 tick·매 프레임 값은 보내지 않습니다. 경기 중 수치는 경기 끝 summary에 넣고, 나머지는 결정론 기록에서 다시 계산합니다.
5. **경기마다 기록합니다.** 경기가 시작될 때(재경기 포함, 경기마다 한 번) `beginMatch(options, Recorder)`로 recorder를 받고, `InputLogRecorder`는 확정 tick마다 `input`을 넣습니다(예측·재시뮬레이션 입력 제외). 경기 끝에 `recordMatch(recorder, summary)`를 부릅니다. 멀티플레이는 모든 참가자가 시작할 때 계산할 수 있는 같은 `matchId`(예: 방 sessionId + epoch + 그 세대의 경기 순번)를 넘깁니다. 끝을 기록하지 않는 모드는 `record: false`로 시작합니다.
6. **검증합니다.** 로컬 `wrangler dev`에 게임을 연결하고, 게임의 고정 E2E에서 실제 입력으로 한 경기를 끝낸 뒤 `GET /stats`·`GET /daily`나 D1 행으로 확인합니다. 실제 서버로 보내는 시험을 영구 시험에 넣지 않습니다(집계가 오염됩니다).

## 계약

- 배치 하나가 요청 하나입니다. 배치에는 `schemaVersion`(3), `game`, `build`(= `version`), `sessionId`, `seq`, `playMs`, `events`, `matches`가 들어갑니다. 서버는 game·build·schemaVersion을 세션 행(첫 배치)에만 두고, 배치·경기 행은 `session_id`로 세션을 따라갑니다.
- `track(category, target, action, props?)`: 이름은 1~64자 문자열, props는 JSON 객체(`MAX_PROPS_BYTES` 2000바이트 이하)입니다. 형식·크기가 틀리면 그 자리에서 던집니다. 자동 플러시는 던지지 않습니다.
- `beginMatch(options?, Recorder = MatchRecorder)`: `new Recorder(options)`를 만들고 `match:<mode>:start` 이벤트(props `{ matchId }`, `record: false`면 `{ matchId, record: false }`)를 남긴 뒤 recorder를 돌려줍니다. `recordMatch(recorder, summary?)`는 이 recorder를 경기마다 한 번만 받습니다(두 번째·직접 만든 recorder·`record: false`는 `TypeError`). summary 8000·players 4000·replay 900000바이트(`MAX_SUMMARY_BYTES`·`MAX_PLAYERS_BYTES`·`MAX_REPLAY_BYTES`, JSON·base64 뒤)나 배치 1,000,000바이트를 넘으면 아무것도 보내지 않고 `RangeError`를 던집니다. 상한은 `protocol.js` 한 곳에 있고 서버도 같은 값으로 거절합니다.
- 세션: 생성 때 `session_start`, `pagehide` 때 `session_end`를 남깁니다. bfcache에서 돌아오면 같은 세션에 `session_start`를 다시 남깁니다. `dispose()`는 `session_end`를 보내고 타이머·리스너를 해제합니다.
- `session_start`의 `props`: `{ locale?, viewport, touch }`. `viewport`는 `innerWidth`·`innerHeight`를 각각 `VIEWPORT_STEPS`(0·360·480·600·768·1024·1280·1600·1920) 중 아래쪽 경계로 내린 `'WxH'`이고, `touch`는 주 입력이 손가락인지(`pointer: coarse`)입니다. 정확한 크기·브라우저 저장소 ID는 보내지 않습니다. 봉투(schema 3)는 그대로이고 옛 서버도 이 필드를 원본 그대로 저장합니다.
- 놀이를 멈추는 실패는 성격별 category로 보냅니다(발배구: `track('fault', <simulation·desync·sync>, 'fail', { mode })`, `track('network', <relay·peer·secure·other·timeout>, 'fail', …)`, `track('unsupported', <browser·version>, 'block', …)`). 오류 메시지·스택은 보내지 않습니다. `/daily`의 `events`에 `fault:desync:fail`처럼 셉니다.
- **플레이 시간은 페이지가 보이는 동안만 셉니다.** `playMs`는 누적값이고 서버는 배치마다 받은 값을 그대로 남기며, 집계는 세션의 최댓값입니다. 숨긴 시간을 포함한 체류 시간(`avgWallMs`)은 세션의 첫 이벤트와 마지막 이벤트의 시각 차(클라이언트 시계)입니다.
- heartbeat(기본 30000ms)는 보이는 동안에만 남기는 빈 이벤트입니다. 다음 플러시(10000ms 간격)에 실려 가므로 보이는 세션은 늦어도 약 40초마다 `playMs`가 든 배치를 보냅니다. 페이지가 비정상 종료돼 `pagehide`가 오지 않을 때 잃는 플레이 시간은 그 간격 안팎입니다. 숨길 때와 닫힐 때도 heartbeat·`session_end`를 바로 보냅니다.
- 이벤트는 50개가 쌓이거나 10000ms마다 보냅니다. 경기 기록은 `recordMatch` 즉시 보냅니다.
- 탭 숨김·닫힘: `sendOnHide`(HttpAdapter는 `navigator.sendBeacon`)로 남은 배치를 올립니다. 60000바이트를 넘는 배치(긴 경기 기록)는 beacon 상한 때문에 정상 경로로 남겨 둡니다.
- 실패: 보내지 못한 배치는 같은 `seq` 그대로 다시 보냅니다. 서버는 같은 배치를 두 번 받아도 결과가 같습니다(`INSERT OR IGNORE`). 20개를 넘게 쌓이면 오래된 것부터 버리고 `droppedBatches`에 셉니다. seq는 보관함에 넣을 때만 늘어서, 직렬화 뒤 상한을 넘겨 버린 배치는 seq를 쓰지 않습니다(보관 상한으로 버린 배치만 서버에서 seq 구멍으로 보입니다).
- beacon으로 보낸 배치도 fetch 200을 받을 때까지 메모리에 남습니다. 페이지가 다시 보이거나(visibilitychange) bfcache에서 돌아오면(pageshow) 같은 `seq`로 다시 보내고, 숨긴 동안은 주기 전송을 쉽니다. 브라우저 저장소에는 두지 않으므로(D-237) 숨긴 채 탭이 닫히거나 회수되면 도착하지 못한 beacon 배치는 잃습니다. 정상 망에서도 숨김→복귀마다 beacon으로 보낸 배치를 한 번 더 보냅니다(쓰기 행은 늘지 않음).
- 배치 하나는 1,000,000바이트까지입니다(D1 한 행 2MB의 절반). 넘는 경기 기록은 `recordMatch`가 `RangeError`로 던집니다. 이벤트 배치는 props 상한 × 이벤트 수 상한이라 넘지 않고, 그래도 넘으면 던지지 않고 버려 `droppedBatches`에 셉니다.

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

3. 저장된 옛 행이 새 모양이어야 하면 같은 PR에 D1 migration(`UPDATE …`)을 넣습니다. 세션마다 `schema_version`이 남아 있어 대상만 고칩니다(배치·경기는 `session_id`로 따라감).
4. 같은 PR에서 서버를 배포하고, 고정 시나리오에 schema 3 배치가 변환돼 저장되는 확인을 넣습니다.
5. 제거 조건 확인 쿼리: `SELECT MAX(b.received_at) FROM batches b JOIN sessions s USING (session_id) WHERE s.schema_version = 3`. 조건을 채우면 변환과 그 확인을 지웁니다.

지금은 변환이 없습니다. 출시 뒤 처음 깨는 변경이 생길 때 위 순서로 추가합니다(사용처 없는 변환 표를 미리 두지 않습니다, PM-013).

## 개발자 본인 플레이 분리

내 플레이는 보낼 때 표시하지 않고 **받은 뒤 걸러 냅니다(후 필터).** 서버가 세션마다 접속 정보를 저장하고, 소유자 회선 목록(`owners`)은 조회 때 붙이므로 회선을 나중에 등록해도 지난 세션까지 함께 빠집니다. 게임 코드·주소 옵션·설정 스위치는 필요 없습니다(D-215).

위 칸부터 먼저 맞는 칸 하나로 셉니다. 내 회선의 헤드리스 시험은 `owner`, 로컬 개발 빌드의 헤드리스 시험은 `dev`이고, 로봇 판정은 그 밖의 세션에만 걸립니다.

| 집계 칸 | 기준                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner` | 세션의 접속 키가 `owners`에 있음. 회선 이름별 세션 수는 `keys`                                                                                                                              |
| `dev`   | Origin이 `null`·localhost·127.0.0.1·[::1](0003 이전에 Origin 없이 저장된 세션 포함)                                                                                                         |
| `bot`   | user_agent가 없거나 로봇 표시(`bot/`·`bot-`·`bot)`·crawler·spider·facebookexternalhit·HeadlessChrome·Lighthouse·PhantomJS·curl·python·Go-http-client), 또는 `playMs`가 0보다 큰 배치가 없음 |
| `users` | 나머지(GitHub Pages·itch.io 등 게임 페이지)                                                                                                                                                 |

- 로봇의 "한 번도 보인 적 없는 세션": `playMs`는 페이지가 보이는 동안만 늘고 heartbeat도 보일 때만 남으므로, 사람이 본 세션은 늦어도 숨김·닫힘 배치에서 `playMs`가 0보다 큽니다. 보이지 않은 채 열렸다 닫힌 페이지(미리 렌더링 등)는 모든 배치가 0입니다. 저장 때 버리지 않고 조회 때 가르므로 기준을 고치면 지난 세션도 바뀝니다.

- 접속 키(`ip_key`): 회선(IPv4 주소, IPv6는 앞 64비트)을 서버 비밀값 `IP_KEY_SECRET`으로 HMAC-SHA256한 앞 16바이트(hex 32자)입니다. 원본 IP는 저장하지 않고, 비밀값 없이는 키에서 IP를 되돌릴 수 없습니다. 비밀값을 바꾸면 모든 키가 바뀌어 `owners`를 다시 등록해야 하므로 바꾸지 않습니다.
- 함께 저장하는 것: Cloudflare가 붙인 `country`·`city`·`asn`·`as_org`, 요청의 `user_agent`·`origin`. 세션의 첫 배치 것을 남깁니다.
- 내 회선 등록: 내 기기에서 `GET <배포 주소>/whoami`를 열어(bm 예제 '지표' 탭의 "내 접속 키 보기"도 같음) `ipKey`를 확인하고, 아래를 실행합니다. `label`은 회선 이름(`home-wifi`, `phone-lte` 등)입니다.

      npx wrangler d1 execute bloom-metrics --remote -c wrangler.toml --command "INSERT OR IGNORE INTO owners (ip_key, label, added_at) VALUES ('<ipKey>', 'home-wifi', unixepoch() * 1000)"

- 같은 회선의 모든 기기(PC·휴대폰 Wi-Fi)가 한 키입니다. 휴대폰 데이터는 접속마다 주소가 바뀌어 키도 바뀌므로 그때그때 `/whoami`로 등록하거나, 등록 전 세션은 `asn`·`city`·`user_agent`·시각으로 찾아 그 `ip_key`를 넣습니다. 같은 집 회선의 다른 사람(가족 등)도 `owner`로 빠집니다.
- `/whoami`의 `owner`는 지금 회선이 등록된 이름이거나 `null`입니다.

## 경기 기록

| 구현체                  | 쓰는 경우                        | `capture()`의 replay                  |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `MatchRecorder`         | 결정론 기록이 없는 게임          | `null` (시드·참가자·summary만)        |
| `InputLogRecorder`      | rollback 없는 고정 tick 게임     | `{ seed, frames: [{ tick, input }] }` |
| `SessionReplayRecorder` | rollback `Session`·`RoomSession` | `session.exportReplay()` 그대로       |

- 다른 기록이 필요하면 `MatchRecorder`를 상속해 `capture()`만 오버라이드합니다. `{ seed, players, replay }`를 돌려줍니다.
- `matchId`를 생략하면 새 UUID입니다. 멀티플레이는 참가자 모두 같은 값을 넘기고, 서버는 먼저 도착한 경기 하나만 남기며 시작도 하나로 셉니다.
- 기록 클래스는 `beginMatch`의 두 번째 인자로 넘깁니다. 옵션 객체는 `record`를 뺀 그대로 그 클래스의 생성자로 갑니다.
- `Uint8Array`는 JSON에서 `{"$bytes": base64}`입니다. 다시 계산할 때 `JSON.parse(text, reviveBytes)`로 되돌려 `playReplay`에 넘깁니다.
- rollback replay는 입력이 바뀐 tick만 바이트로 담습니다(`inputChanges`). 60Hz 2인 경기도 키보드 입력이면 대부분 수 KB이고, 매 tick 바뀌는 최악도 tick당 참가자마다 약 8바이트(base64 전)입니다. 배치 한도는 1MB입니다.
- `RoomSession` replay는 `{ seed, players, segments }`입니다. 방이 시작된 뒤 roster 세대(epoch)마다 구간 하나이고, 구간마다 `playReplay`로 따로 재생해 그 `hash`와 비교합니다.

## 수집 서버

**D1에는 받은 원본 사실(배치·이벤트·수신 시각·세션의 첫 접속 정보·경기 기록)만 저장합니다.** 다른 열·행에서 계산되는 값(누적·최댓값·첫 등장일·일별 요약·중앙값)은 열이나 요약 표로 두지 않고 조회 때 계산합니다. 조회 비용이 무료 한도를 넘을 때는 계산값 저장보다 조회 범위·인덱스로 먼저 풉니다.

| 표         | 한 행       | 저장하는 값                                                                          |
| ---------- | ----------- | ------------------------------------------------------------------------------------ |
| `sessions` | 세션        | 첫 배치의 game·build·schema_version·수신 시각(`started_at`)·접속 정보. 바꾸지 않음   |
| `batches`  | 받은 배치   | 수신 시각·`play_ms`(보낸 누적값)·이벤트 배열 원본. 이벤트가 없어도 한 행             |
| `matches`  | 경기        | mode·seed·players·summary·replay·수신 시각·클라이언트가 끝낸 시각(`client_ended_at`) |
| `owners`   | 소유자 회선 | 접속 키·이름                                                                         |

`POST /batch`는 아래 "보내기 방어"와 검증 뒤 D1에 씁니다. 조회 `GET /stats`·`GET /daily`는 아래 "조회 키"가 있어야 합니다. `GET /stats?game=<game>[&build=<build>][&days=30]`(1~90일, 오늘 포함)은 그 기간에 시작한 세션의 `{ users, owner, dev, bot }` 칸마다 `{ sessions, lines, returningLines, avgPlayMs, avgWallMs, matches }`를 돌려줍니다(`owner.keys`는 회선 이름별 세션 수, 경기는 처음 보낸 세션의 칸). `lines`는 접속 키(회선) 수, `returningLines`는 기간 안 서로 다른 날 2일 이상 온 회선 수이고, 응답의 `note`대로 사람 수가 아닙니다(휴대폰 데이터는 한 사람이 여러 회선, 집·학교 NAT은 여러 사람이 한 회선).

`GET /daily?game=<game>[&build=<build>][&days=30]`(1~90일, 오늘 포함)은 날짜(KST, 세션의 첫 배치를 받은 날)·칸마다 `{ day, audience, sessions, lines, newLines, avgPlayMs, medianPlayMs, avgWallMs, matches }`를, 기간 합계로 칸마다 `countries`(국가별 세션 수), `contexts`(`locale`·`viewport`·`touch`별 세션 수, 세션 첫 배치의 `session_start`에서 읽고 없으면 `unknown`), `events`(`category:target:action`별 횟수), `completion`(mode별 `{ starts, matches, rate }`)을 돌려줍니다. 완주율의 `starts`는 `match:<mode>:start`의 서로 다른 `props.matchId` 수입니다(온라인 두 참가자의 같은 경기는 1, 재경기는 새 matchId라 따로). `record: false` 시작은 빼고, 그런 시작만 있는 모드는 표에 없습니다. matchId가 없는 옛 빌드의 시작은 하나씩 셉니다. 기록된 경기만 있고 시작이 없으면 `rate`는 `null`입니다. `events`의 횟수는 이와 별개로 모든 시작 이벤트를 셉니다. `newLines`는 그 회선을 이 게임에서 처음 본 날로 셉니다. `GET /whoami`는 요청 회선의 `{ ipKey, country, city, asn, asOrg, owner }`입니다. 실제 유저 지표는 `users`만 봅니다. 응답은 `Access-Control-Allow-Origin: *`이며 클라이언트는 preflight가 없는 `text/plain` 요청을 씁니다(조회의 `Authorization` 헤더는 preflight를 거칩니다).

- 계약 밖 배치는 저장하지 않고 400(`schema-version`·`identity`·`counter`·`shape`·`empty`·`too-many`·`event`·`match`·`size`)이나 413(`too-large`)으로 거절합니다. 보내기 방어는 403(`origin`·`game`)·429(`rate`), 같은 sessionId의 다른 게임 배치는 409(`session-game`)입니다.
- 쓰기 행: 세션의 첫 배치에 세션 1행, 배치마다 1행, 경기마다 1행 + 인덱스(`matches_session_id`) 1행.
- 읽기 행(무료 한도 500만 행/일): 칸을 가를 때 세션마다 로봇 판정이 그 세션의 배치를 `playMs`가 0보다 큰 첫 배치까지 읽습니다. `/stats`는 기간 안 세션 행 × 4 + 배치 행 + 경기 행 안팎이고 경기는 `session_id` 인덱스로 세션마다 찾습니다. `/daily`는 여기에 이벤트 횟수·완주율 조회가 배치 행 + **이벤트 수**를 더 읽고(D1은 `json_each`로 펼친 원소도 읽기 행으로 셉니다. 2026-11-04 운영 측정: 배치 16행·이벤트 28개 → 44행), 새 회선(`newLines`)은 기간 밖 세션까지 봅니다. 한도에 가까워지면 `days`를 줄입니다.
- 무료 플랜 한도(요청 10만/일, D1 쓰기 10만 행/일, 저장 5GB)를 넘으면 요청이 실패합니다(하드 캡, 과금 없음). 클라이언트는 실패한 배치를 보관 상한까지 들고 있다가 다시 보냅니다.
- `playMs`·이벤트 시각은 클라이언트 값을 그대로 믿습니다. 세션 시작·배치 수신 시각과 접속 정보(접속 키·Cloudflare 위치·헤더)는 서버가 정합니다. 원본 IP는 저장하지 않습니다.
- 비밀값 `IP_KEY_SECRET`이 없으면 `/batch`·`/stats`·`/daily`·`/whoami`가 500(`ip-key-secret`)입니다(배포 설정 누락).

### 보내기 방어

보내기(`POST /batch`)는 게임 페이지가 키 없이 보내므로 인증할 수 없습니다. 다른 사이트·스크립트가 쉽게 섞지 못하게 하고 피해를 줄입니다.

| 검사        | 기준                                                                                                                                                        | 거절               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 출처        | `Origin`이 `wrangler.toml`의 `ALLOWED_ORIGINS`(쉼표 목록, 정확한 출처)에 있거나 개발 빌드(http의 localhost·127.0.0.1·[::1], `null`). `Origin`이 없으면 거절 | 403 `origin`       |
| 회선 횟수   | 접속 키마다 60초에 60배치(`[[ratelimits]]` `BATCH_LIMIT`, Cloudflare Workers Rate Limiting). 정상 게임은 분당 약 2배치                                      | 429 `rate`         |
| 게임 이름   | `ALLOWED_GAMES`(쉼표 목록)에 있음                                                                                                                           | 403 `game`         |
| 세션의 게임 | 세션은 첫 배치의 game에 속하고, 같은 sessionId로 다른 game의 배치·경기는 넣지 않음(한 트랜잭션 안의 조건부 INSERT)                                          | 409 `session-game` |
| 값 크기     | props 2000·summary 8000·players 4000·replay 900000바이트(`protocol.js`, 클라이언트와 같은 상수)                                                             | 400 `size`         |

- Origin이 없는 요청을 거절하는 이유: 브라우저는 POST에 늘 `Origin`을 붙입니다(Fetch 표준 "append a request `Origin` header": 메서드가 GET·HEAD가 아니면 붙임). `fetch`(keepalive 포함)와 `sendBeacon` 모두 POST라 붙고, 고정 시나리오의 `session_end` beacon이 이 검사를 지나 저장되는 것으로 확인합니다. Origin이 없는 POST는 브라우저 밖(스크립트·로봇)입니다. 브라우저 밖에서는 Origin을 흉내 낼 수 있으므로 인증이 아닙니다.
- 개발 출처는 목록 없이 받습니다. 집계에서 `dev`로 갈라지므로 유저 칸을 오염시키지 않습니다.
- 횟수 제한은 Cloudflare 위치마다 따로 세는 근사치입니다. 학교·회사 NAT처럼 여러 사람이 한 회선이면 함께 셉니다. 429를 받은 배치는 클라이언트가 같은 seq로 다시 보냅니다.
- 출처·게임을 더하려면 `wrangler.toml`의 `[vars]`를 고치고 deploy합니다.

### 조회 키

`/stats`·`/daily`는 `Authorization: Bearer <STATS_KEY>` 헤더가 있어야 합니다. `STATS_KEY`는 Worker 비밀값이고(값은 어디에도 적지 않음), 서버는 두 값의 SHA-256을 일정 시간 비교(`crypto.subtle.timingSafeEqual`)합니다. 키를 주소에 싣지 않습니다(주소는 브라우저 기록·서버 로그에 남음). 비밀값이 없는 배포는 조회를 열어 두지 않고 500(`stats-key`), 헤더가 없거나 틀리면 401(`unauthorized`)입니다. `/whoami`는 키 없이 열려 있습니다.

    curl -H "Authorization: Bearer $STATS_KEY" "https://bloom-metrics.byh-playground.workers.dev/daily?game=bloom-takraw&days=7"

### 운영

| 항목            | 값                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| 배포 주소       | `https://bloom-metrics.byh-playground.workers.dev`                                                                    |
| Cloudflare 계정 | byh020907@naver.com (account `deaa8cb49d25379de875c00c445503fd`, 무료 플랜)                                           |
| D1              | `bloom-metrics` (`0f0db294-6c6e-44f0-b39a-d6e297f48e0d`, APAC)                                                        |
| workers.dev     | 하위 도메인 `byh-playground`                                                                                          |
| 비밀값          | `IP_KEY_SECRET` (Worker secret, 값은 어디에도 적지 않음. 바꾸지 않음), `STATS_KEY` (조회 키, 값은 어디에도 적지 않음) |

계정 가입·이메일 인증·`wrangler login` 승인은 사용자가 합니다. 로그인이 된 PC에서는 아래 명령을 에이전트가 실행합니다. 모든 명령은 `modules/metrics/server`에서 `-c wrangler.toml`로 실행합니다.

- 서버 코드·protocol.js를 바꾼 PR: 머지 전에 `npx wrangler deploy -c wrangler.toml`. 새 필드를 쓰는 게임 빌드보다 서버가 먼저 나갑니다("버전 관리").
- D1 표를 바꾼 PR: `npx wrangler d1 migrations create bloom-metrics <이름> -c wrangler.toml`로 다음 번호 파일을 만들고, 로컬 고정 시나리오를 통과한 뒤 `npx wrangler d1 migrations apply bloom-metrics --remote -c wrangler.toml`. 남은 파일은 `npx wrangler d1 migrations list bloom-metrics --remote -c wrangler.toml`로 봅니다. `DROP`·`DELETE`가 든 파일은 사용자 확인 뒤에만 적용합니다.
- 비밀값은 처음 한 번만 `npx wrangler secret put IP_KEY_SECRET -c wrangler.toml`(표준 입력으로 임의 값)로 넣었습니다. 다시 넣으면 접속 키가 모두 바뀝니다.
- 조회 키는 `npx wrangler secret put STATS_KEY -c wrangler.toml`로 넣습니다(값은 사용자가 정함). 바꿔도 저장된 원본에는 영향이 없고 조회하는 쪽의 키만 바꾸면 됩니다.
- 원본 확인: `npx wrangler d1 execute bloom-metrics --remote -c wrangler.toml --json --command "SELECT game, COUNT(*) AS sessions FROM sessions GROUP BY game"`. 사용량은 Cloudflare 대시보드의 Workers·D1 화면에서 봅니다.
- 배포 확인은 `gamekit-deploy-check` 같은 검사 전용 game 이름으로 보내고 확인한 뒤 그 행을 지웁니다. 게임 이름으로 시험 데이터를 보내지 않습니다.

### 로컬 실행

    npx wrangler d1 migrations apply bloom-metrics --local -c modules/metrics/server/wrangler.toml
    npx wrangler dev -c modules/metrics/server/wrangler.toml --var IP_KEY_SECRET:local --var STATS_KEY:local

`http://127.0.0.1:8787`에서 실제 Workers 런타임(workerd)과 로컬 D1(SQLite)로 돕니다. 로컬에서는 요청의 `CF-Connecting-IP` 헤더가 그대로 들어가 다른 회선을 흉내 낼 수 있습니다(운영은 Cloudflare가 덮어씀). Windows에서 `--persist-to`를 쓸 때는 짧은 경로를 줍니다(D1 파일 경로가 길면 내부 오류가 납니다).

## 범위

대시보드·퍼널 화면, 날짜별 재방문(코호트) 표, 경기 기록 재계산 도구, 오프라인 보관(localStorage)는 없습니다. 실제로 필요한 게임을 붙일 때 추가합니다. 보내기 인증은 게임 페이지에 비밀을 둘 수 없어 하지 않고 "보내기 방어"로 피해를 줄입니다.

[고정 시나리오](./tests/metrics.e2e.mjs)(`npm test` core 목록)는 운영과 같은 migrations를 로컬 D1에 적용해 기록을 확인하고 `wrangler dev`를 띄운 뒤 bm 예제 '지표' 탭을 데스크톱(마우스)과 터치 에뮬레이션에서 누릅니다: 잘못된 배치 400·413과 CORS, Origin 없음·목록 밖 출처·등록 안 된 게임 403, 조회 키 없음·틀림 401 → 조회 키 입력·세션 시작·랠리 3번(첫 랠리에서 경기 시작)·경기 끝 → 서버 집계 → 탭 숨김(에뮬레이션: headless Chromium은 숨김을 바꾸지 못해 `visibilityState`만 바꿈) 중 플레이 시간 정지와 beacon → 실제 페이지 이동의 `session_end` beacon → "내 접속 키 보기" → D1 행을 직접 읽어 플레이 시간·경기 기록·접속 키 확인 → 다른 회선의 itch.io 배치만 `users`, 같은 sessionId의 다른 게임 배치 409, 로봇 user_agent·보인 적 없는 세션은 `bot` → rollback `Session` 두 참가자가 같은 matchId로 `beginMatch`·`recordMatch`하면 경기 한 행·완주율 시작 1 → 저장된 replay로 같은 hash 재계산 → 접속 키를 `owners`에 넣으면 지난 세션·경기가 `owner`로 소급. IPv6 같은 /64 한 키도 봅니다. 횟수 제한(429)은 시나리오에 넣지 않았습니다. 실기기·실제 탭 전환·배포된 Cloudflare는 확인하지 않습니다.

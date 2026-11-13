import {
    SCHEMA_VERSION,
    MAX_BATCH_BYTES,
    MAX_UNLOAD_BYTES,
    MAX_PROPS_BYTES,
    MAX_SUMMARY_BYTES,
    MAX_PLAYERS_BYTES,
    MAX_REPLAY_BYTES,
    VIEWPORT_STEPS,
    jsonBytes,
    encodeBytes,
    reviveBytes,
    isName,
    isRecord,
} from './protocol.js';

export { SCHEMA_VERSION, MAX_PROPS_BYTES, MAX_SUMMARY_BYTES, MAX_PLAYERS_BYTES, MAX_REPLAY_BYTES, reviveBytes };

const ENCODER = new TextEncoder();
const BODY_TYPE = 'text/plain;charset=UTF-8';
// 서버가 내려가 있을 때 보내지 못한 배치를 붙잡아 두는 상한. 넘치면 오래된 것부터 버리고 droppedBatches에 셉니다.
const MAX_QUEUED_BATCHES = 20;

function checkName(value, name) {
    if (!isName(value)) {
        throw new TypeError(`metrics ${name} must be a non-empty string of at most 64 characters.`);
    }
}

function checkBytes(value, limit, name) {
    const BYTES = jsonBytes(value);
    if (BYTES > limit) {
        throw new RangeError(`metrics ${name} is ${BYTES} bytes as JSON; the server accepts at most ${limit}.`);
    }
}

function checkInterval(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`metrics ${name} must be a positive integer (ms).`);
    }
}

/**
 * 수집 백엔드의 범용 계약. 구현체가 `send`(필수)와 `sendOnHide`(선택)를 오버라이드합니다.
 * 두 메서드는 직렬화가 끝난 배치 JSON 문자열 하나를 받습니다.
 */
export class MetricsAdapter {
    /**
     * 페이지가 보이는 동안의 전송. 실패하면 던지고, createMetrics가 같은 배치를 다음 플러시에 다시 보냅니다.
     * @param {string} _body
     * @returns {Promise<void>}
     */
    async send(_body) {
        throw new Error('MetricsAdapter.send must be overridden.');
    }

    /**
     * 페이지가 숨거나 닫힐 때의 전송. 응답을 기다릴 수 없으므로 "보낼 차례에 올렸는지"만 돌려줍니다.
     * false면 createMetrics가 배치를 버리지 않고 다음 플러시에 다시 보냅니다. 기본은 send를 기다리지 않고 부릅니다.
     * @param {string} body
     * @returns {boolean}
     */
    sendOnHide(body) {
        this.send(body).catch(() => {
            // 닫히는 페이지에서는 실패를 받을 곳이 없습니다. 숨김에서 돌아오면 다음 배치부터 정상 경로로 갑니다.
        });
        return true;
    }
}

/** 수집 서버(`server/worker.js`)의 `POST /batch`에 배치 하나를 요청 하나로 보냅니다. */
export class HttpAdapter extends MetricsAdapter {
    /** @param {string} url 서버 주소. 예: `https://bloom-metrics.<계정>.workers.dev` */
    constructor(url) {
        super();
        this.url = new URL('batch', String(url).endsWith('/') ? url : url + '/').href;
    }

    async send(body) {
        // text/plain은 CORS preflight 없이 가는 단순 요청입니다. 작은 배치는 keepalive로 페이지 이동에도 끝까지 보냅니다.
        const RESPONSE = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': BODY_TYPE },
            body,
            keepalive: ENCODER.encode(body).byteLength <= MAX_UNLOAD_BYTES,
        });
        if (!RESPONSE.ok) {
            throw new Error(`metrics server answered ${RESPONSE.status}.`);
        }
    }

    sendOnHide(body) {
        return navigator.sendBeacon(this.url, new Blob([body], { type: BODY_TYPE }));
    }
}

/** 개발·디버그 장면용. 보낸 배치를 `batches`에 파싱해 둡니다(Uint8Array 복원 포함). */
export class MemoryAdapter extends MetricsAdapter {
    constructor() {
        super();
        this.batches = [];
    }

    async send(body) {
        this.batches.push(JSON.parse(body, reviveBytes));
    }

    sendOnHide(body) {
        this.batches.push(JSON.parse(body, reviveBytes));
        return true;
    }
}

/**
 * 경기 하나의 범용 기록. 경기 식별·모드·시드·참가자만 남기고 결정론 기록(replay)은 없습니다.
 * 결정론 기록이 있는 게임은 `capture()`를 오버라이드한 구현체를 씁니다.
 * 게임이 직접 만들지 않고 `metrics.beginMatch(options, Recorder)`가 시작 이벤트와 함께 만들어 돌려줍니다.
 */
export class MatchRecorder {
    /**
     * @param {object} [options]
     * @param {string} [options.matchId] 멀티플레이는 모든 참가자가 같은 값을 넘깁니다. 서버는 경기당 한 행만 남기고 시작도 하나로 셉니다.
     * @param {string} [options.mode='solo'] 예: 'solo' | 'local' | 'online'
     * @param {unknown} [options.seed=null]
     * @param {unknown[]} [options.players=[]]
     */
    constructor({ matchId = crypto.randomUUID(), mode = 'solo', seed = null, players = [] } = {}) {
        checkName(matchId, 'matchId');
        checkName(mode, 'mode');
        if (!Array.isArray(players)) {
            throw new TypeError('metrics players must be an array.');
        }
        this.matchId = matchId;
        this.mode = mode;
        this.seed = seed;
        this.players = players;
    }

    /**
     * 경기가 끝난 순간의 기록. 오버라이드 지점입니다.
     * @returns {{ seed: unknown, players: unknown[], replay: unknown }}
     */
    capture() {
        return { seed: this.seed, players: this.players, replay: null };
    }
}

/**
 * rollback 세션 없이 고정 tick으로 도는 게임(싱글 등): 확정된 tick 입력을 직접 남깁니다.
 * 같은 시드와 frames로 시뮬레이션을 다시 돌려 어떤 지표든 다시 계산할 수 있습니다.
 */
export class InputLogRecorder extends MatchRecorder {
    constructor(options) {
        super(options);
        this.frames = [];
    }

    /**
     * 확정 입력 하나. 예측·재시뮬레이션 입력은 넣지 않습니다. Uint8Array는 복사하고, 그 밖의 JSON 값은 넘긴 뒤 고치지 않습니다.
     * @param {number} tick
     * @param {unknown} input
     */
    input(tick, input) {
        this.frames.push({ tick, input: input instanceof Uint8Array ? input.slice() : input });
    }

    capture() {
        return { seed: this.seed, players: this.players, replay: { seed: this.seed, frames: this.frames } };
    }
}

/** rollback `Session`·`RoomSession`(`recordReplay: true`): SDK가 소유한 `exportReplay()`를 그대로 남깁니다. 입력을 따로 모으지 않습니다. */
export class SessionReplayRecorder extends MatchRecorder {
    /** @param {{ session: { exportReplay(): { seed: unknown, players: unknown[] } } } & object} options */
    constructor({ session, ...options }) {
        super(options);
        this.session = session;
    }

    capture() {
        const REPLAY = this.session.exportReplay();
        return { seed: REPLAY.seed, players: REPLAY.players, replay: REPLAY };
    }
}

/**
 * 게임 세션 하나의 지표를 모아 배치로 보냅니다. 플레이 시간은 페이지가 보이는 동안만 셉니다.
 * @param {object} options
 * @param {string} options.game 게임 식별자. 예: 'bloom-takraw'
 * @param {string} options.version 게임 빌드 버전. 모든 배치에 build로 들어갑니다.
 * @param {MetricsAdapter} options.adapter
 * @param {string} [options.locale] 게임이 고른 화면 언어 코드(예: 'ko'). session_start props에 들어갑니다.
 * @param {number} [options.heartbeatMs=30000] 보이는 동안 플레이 시간을 남기는 간격. 비정상 종료 때 잃는 양의 상한입니다.
 * @param {number} [options.flushMs=10000] 쌓인 이벤트를 보내는 간격
 * @param {number} [options.maxBatchEvents=50] 이만큼 쌓이면 간격을 기다리지 않고 보냅니다(서버 상한 100).
 * @param {() => number} [options.now] 이벤트 시각(ms)과 플레이 시간 시계
 */
export function createMetrics({
    game,
    version,
    adapter,
    locale,
    heartbeatMs = 30000,
    flushMs = 10000,
    maxBatchEvents = 50,
    now = () => Date.now(),
} = {}) {
    checkName(game, 'game');
    checkName(version, 'version');
    if (!(adapter instanceof MetricsAdapter)) {
        throw new TypeError('metrics adapter must extend MetricsAdapter.');
    }
    if (locale !== undefined) {
        checkName(locale, 'locale');
    }
    checkInterval(heartbeatMs, 'heartbeatMs');
    checkInterval(flushMs, 'flushMs');
    if (!Number.isSafeInteger(maxBatchEvents) || maxBatchEvents < 1 || maxBatchEvents > 100) {
        throw new RangeError('metrics maxBatchEvents must be an integer from 1 to 100.');
    }
    const SESSION_ID = crypto.randomUUID();
    const EVENTS = [];
    // beginMatch가 만든 recorder → record 여부. recordMatch는 여기 있는 recorder만 한 번 받습니다.
    const BEGUN = new WeakMap();
    // 직렬화를 마친 배치 { body, bytes }. 보낸 순서대로 하나씩 보내고, 실패하면 같은 seq 그대로 다시 보냅니다.
    const OUTBOX = [];
    let seq = 0;
    let playedMs = 0;
    let visibleSince = document.visibilityState === 'visible' ? now() : null;
    let sending = null;
    let droppedBatches = 0;
    let disposed = false;

    // 세션을 시작할 때마다 그 순간의 언어·화면 구간·주 입력을 원본으로 남깁니다. 브라우저 저장소 ID는 쓰지 않습니다.
    function startSession() {
        const BUCKET = (size) => VIEWPORT_STEPS.findLast((step) => step <= size);
        push('session_start', {
            props: {
                ...(locale === undefined ? {} : { locale }),
                viewport: `${BUCKET(innerWidth)}x${BUCKET(innerHeight)}`,
                touch: matchMedia('(pointer: coarse)').matches,
            },
        });
    }

    function playMs() {
        return playedMs + (visibleSince == null ? 0 : now() - visibleSince);
    }

    // 다음 seq로 배치 하나를 직렬화합니다. seq는 보관함에 넣을 때만 늘려, 버린 배치 때문에 서버가 받는 seq에 구멍이 나지 않습니다.
    function serialize(events, matches) {
        const BODY = JSON.stringify(
            {
                schemaVersion: SCHEMA_VERSION,
                game,
                build: version,
                sessionId: SESSION_ID,
                seq,
                playMs: playMs(),
                events,
                matches,
            },
            encodeBytes,
        );
        return { body: BODY, bytes: ENCODER.encode(BODY).byteLength };
    }

    function enqueue(batch) {
        seq++;
        OUTBOX.push(batch);
        if (OUTBOX.length > MAX_QUEUED_BATCHES) {
            OUTBOX.shift();
            droppedBatches++;
        }
    }

    // 이벤트 배치는 props 상한(MAX_PROPS_BYTES) × maxBatchEvents(≤100)라 배치 상한을 넘지 않습니다. 그래도 넘으면 던지지 않고
    // 그 이벤트들을 버려 droppedBatches에 셉니다. track·heartbeat의 자동 플러시가 게임 코드로 예외를 올리지 않습니다.
    function packEvents() {
        if (!EVENTS.length) {
            return;
        }
        const BATCH = serialize(EVENTS.splice(0), []);
        if (BATCH.bytes > MAX_BATCH_BYTES) {
            droppedBatches++;
            return;
        }
        enqueue(BATCH);
    }

    function push(type, fields) {
        if (disposed) {
            throw new Error('metrics is disposed.');
        }
        EVENTS.push({ type, t: now(), ...fields });
        if (EVENTS.length >= maxBatchEvents) {
            flush();
        }
    }

    async function drain() {
        while (OUTBOX.length) {
            const BATCH = OUTBOX[0];
            try {
                await adapter.send(BATCH.body);
            } catch {
                // 서버·네트워크 실패: 배치를 남겨 다음 플러시나 숨김 전송에서 같은 seq로 다시 보냅니다.
                return;
            }
            if (OUTBOX[0] === BATCH) {
                OUTBOX.shift();
            }
        }
    }

    /** 쌓인 이벤트를 지금 보냅니다. 보내는 중이면 그 전송이 끝난 뒤 이어서 보냅니다. */
    function flush() {
        packEvents();
        if (!sending) {
            sending = drain().finally(() => {
                sending = null;
            });
            return sending;
        }
        return sending.then(() => flush());
    }

    // 숨김·닫힘: 응답을 기다리지 않는 경로로 남은 배치를 모두 올립니다. 너무 큰 경기 배치는 정상 경로에 맡깁니다.
    // beacon은 도착을 알려 주지 않으므로 보낸 배치도 메모리에 남겨 두고, 다시 보일 때 fetch로 같은 seq를 보내
    // 200을 받은 뒤 지웁니다(서버는 같은 seq를 한 번만 저장). 숨긴 채 페이지가 사라지면 남은 배치는 잃습니다.
    function flushOnHide() {
        packEvents();
        let unsent = false;
        for (const BATCH of OUTBOX) {
            unsent ||= !(BATCH.bytes <= MAX_UNLOAD_BYTES && adapter.sendOnHide(BATCH.body));
        }
        if (unsent) {
            flush();
        }
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            if (visibleSince != null) {
                playedMs += now() - visibleSince;
                visibleSince = null;
            }
            push('heartbeat', {});
            flushOnHide();
        } else if (visibleSince == null) {
            visibleSince = now();
            flush();
        }
    }

    // 닫힘·이동은 세션 끝으로 보냅니다. bfcache에서 돌아오면 같은 세션을 다시 시작합니다.
    function onPageHide() {
        push('session_end', {});
        flushOnHide();
    }

    function onPageShow(event) {
        if (event.persisted) {
            startSession();
            flush();
        }
    }

    const HEARTBEAT = setInterval(() => {
        if (visibleSince != null) {
            push('heartbeat', {});
        }
    }, heartbeatMs);
    // 숨긴 동안은 주기 전송을 쉽니다. 남은 배치는 숨길 때 beacon으로 올렸고 다시 보일 때 fetch로 확인합니다.
    const FLUSH = setInterval(() => {
        if (document.visibilityState === 'visible' && (EVENTS.length || OUTBOX.length)) {
            flush();
        }
    }, flushMs);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    startSession();
    flush();

    return {
        sessionId: SESSION_ID,
        /** 지금까지 페이지가 보였던 시간(ms) */
        get playMs() {
            return playMs();
        },
        /** 보내지 못하고 버린 배치 수: 서버가 계속 실패해 보관 상한을 넘긴 것과 배치 상한을 넘긴 것 */
        get droppedBatches() {
            return droppedBatches;
        },
        /**
         * 게임 이벤트 하나. category → target → action 세 단계로 묶습니다. 예: track('match', 'rally', 'end', { score: 15 })
         * 고빈도 값(매 tick 위치 등)은 보내지 말고 경기 끝 summary나 recordMatch의 결정론 기록에 담습니다.
         */
        track(category, target, action, props = {}) {
            checkName(category, 'category');
            checkName(target, 'target');
            checkName(action, 'action');
            if (!isRecord(props)) {
                throw new TypeError('metrics props must be a JSON object.');
            }
            checkBytes(props, MAX_PROPS_BYTES, 'props');
            push('event', { category, target, action, props });
        },
        /**
         * 경기 하나를 시작합니다. 시작 이벤트 `match:<mode>:start`(props `{ matchId }`)를 남기고, 같은 matchId로 끝을 남길
         * recorder를 돌려줍니다. 서버 완주율은 시작을 서로 다른 matchId로 세므로 온라인 참가자 모두 같은 matchId로 부르면
         * 시작 하나이고, 재경기는 다시 불러 새 matchId입니다.
         * @param {object} [options] Recorder 생성 옵션(matchId·mode·seed·players, SessionReplayRecorder는 session)
         * @param {boolean} [options.record=true] false: 끝을 기록하지 않는 모드(관전·연습). 시작은 events에 남지만 완주율에서 빠지고 recordMatch할 수 없습니다.
         * @param {typeof MatchRecorder} [recorderClass=MatchRecorder] 경기 기록 방식(InputLogRecorder·SessionReplayRecorder 등)
         * @returns {MatchRecorder}
         */
        beginMatch(options = {}, recorderClass = MatchRecorder) {
            if (disposed) {
                throw new Error('metrics is disposed.');
            }
            if (recorderClass !== MatchRecorder && !(recorderClass?.prototype instanceof MatchRecorder)) {
                throw new TypeError('metrics beginMatch needs a MatchRecorder class.');
            }
            const { record: RECORD = true, ...RECORDER_OPTIONS } = options;
            if (typeof RECORD !== 'boolean') {
                throw new TypeError('metrics record must be a boolean.');
            }
            const RECORDER = new recorderClass(RECORDER_OPTIONS);
            BEGUN.set(RECORDER, RECORD);
            push('event', {
                category: 'match',
                target: RECORDER.mode,
                action: 'start',
                props: RECORD ? { matchId: RECORDER.matchId } : { matchId: RECORDER.matchId, record: false },
            });
            return RECORDER;
        },
        /**
         * `beginMatch`로 시작한 경기의 끝을 바로 보냅니다. `recorder.capture()`의 결정론 기록과 게임이 요약한 summary가
         * 시작과 같은 matchId로 한 행이 됩니다. 경기 하나에 한 번만 부릅니다. 상한을 넘으면 아무것도 보내지 않고 던집니다.
         * @param {MatchRecorder} recorder `beginMatch`가 돌려준 것
         * @param {object} [summary]
         */
        recordMatch(recorder, summary = {}) {
            if (disposed) {
                throw new Error('metrics is disposed.');
            }
            const RECORD = BEGUN.get(recorder);
            if (RECORD === undefined) {
                throw new TypeError('metrics recordMatch needs a recorder from beginMatch, once per match.');
            }
            if (!RECORD) {
                throw new TypeError('metrics recordMatch: this match began with record: false.');
            }
            if (!isRecord(summary)) {
                throw new TypeError('metrics summary must be a JSON object.');
            }
            const { seed: SEED, players: PLAYERS, replay: REPLAY } = recorder.capture();
            checkBytes(summary, MAX_SUMMARY_BYTES, 'summary');
            checkBytes(PLAYERS, MAX_PLAYERS_BYTES, 'players');
            checkBytes(REPLAY, MAX_REPLAY_BYTES, 'replay');
            packEvents();
            const BATCH = serialize(
                [],
                [
                    {
                        matchId: recorder.matchId,
                        mode: recorder.mode,
                        t: now(),
                        seed: SEED,
                        players: PLAYERS,
                        summary,
                        replay: REPLAY,
                    },
                ],
            );
            if (BATCH.bytes > MAX_BATCH_BYTES) {
                throw new RangeError(
                    `metrics match batch is ${BATCH.bytes} bytes; the server accepts at most ${MAX_BATCH_BYTES}.`,
                );
            }
            BEGUN.delete(recorder);
            enqueue(BATCH);
            return flush();
        },
        flush,
        /** 세션을 끝냅니다(게임 종료 화면 등). 남은 배치를 보내고 타이머·리스너를 해제합니다. */
        dispose() {
            if (disposed) {
                return Promise.resolve();
            }
            push('session_end', {});
            disposed = true;
            clearInterval(HEARTBEAT);
            clearInterval(FLUSH);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('pageshow', onPageShow);
            return flush();
        },
    };
}

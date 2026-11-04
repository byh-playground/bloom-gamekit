// modules/metrics/protocol.js
var SCHEMA_VERSION = 2;
var EVENT_TYPES = Object.freeze(["session_start", "heartbeat", "event", "session_end"]);
var MAX_BATCH_BYTES = 1e6;
var MAX_NAME_LENGTH = 64;
var MAX_UNLOAD_BYTES = 6e4;
function isName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var BYTES_KEY = "$bytes";
function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(text);
}
function encodeBytes(_key, value) {
  return value instanceof Uint8Array ? { [BYTES_KEY]: toBase64(value) } : value;
}
function reviveBytes(_key, value) {
  if (value && typeof value === "object" && typeof value[BYTES_KEY] === "string" && Object.keys(value).length === 1) {
    return Uint8Array.from(atob(value[BYTES_KEY]), (char) => char.charCodeAt(0));
  }
  return value;
}

// modules/metrics/index.js
var ENCODER = new TextEncoder();
var BODY_TYPE = "text/plain;charset=UTF-8";
var TESTER_PARAM = "metrics-tester";
var TESTER_KEY = "bloom-metrics-tester";
var MAX_QUEUED_BATCHES = 20;
function checkName(value, name) {
  if (!isName(value)) {
    throw new TypeError(`metrics ${name} must be a non-empty string of at most 64 characters.`);
  }
}
function storeTester(name) {
  try {
    if (name == null) {
      localStorage.removeItem(TESTER_KEY);
    } else {
      localStorage.setItem(TESTER_KEY, name);
    }
  } catch {
  }
}
function readTester() {
  const PARAM = new URLSearchParams(location.search).get(TESTER_PARAM);
  if (PARAM === "off") {
    storeTester(null);
    return null;
  }
  if (isName(PARAM)) {
    storeTester(PARAM);
    return PARAM;
  }
  try {
    const STORED = localStorage.getItem(TESTER_KEY);
    return isName(STORED) ? STORED : null;
  } catch {
    return null;
  }
}
function checkInterval(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`metrics ${name} must be a positive integer (ms).`);
  }
}
var MetricsAdapter = class {
  /**
   * 페이지가 보이는 동안의 전송. 실패하면 던지고, createMetrics가 같은 배치를 다음 플러시에 다시 보냅니다.
   * @param {string} _body
   * @returns {Promise<void>}
   */
  async send(_body) {
    throw new Error("MetricsAdapter.send must be overridden.");
  }
  /**
   * 페이지가 숨거나 닫힐 때의 전송. 응답을 기다릴 수 없으므로 "보낼 차례에 올렸는지"만 돌려줍니다.
   * false면 createMetrics가 배치를 버리지 않고 다음 플러시에 다시 보냅니다. 기본은 send를 기다리지 않고 부릅니다.
   * @param {string} body
   * @returns {boolean}
   */
  sendOnHide(body) {
    this.send(body).catch(() => {
    });
    return true;
  }
};
var HttpAdapter = class extends MetricsAdapter {
  /** @param {string} url 서버 주소. 예: `https://bloom-metrics.<계정>.workers.dev` */
  constructor(url) {
    super();
    this.url = new URL("batch", String(url).endsWith("/") ? url : url + "/").href;
  }
  async send(body) {
    const RESPONSE = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": BODY_TYPE },
      body,
      keepalive: ENCODER.encode(body).byteLength <= MAX_UNLOAD_BYTES
    });
    if (!RESPONSE.ok) {
      throw new Error(`metrics server answered ${RESPONSE.status}.`);
    }
  }
  sendOnHide(body) {
    return navigator.sendBeacon(this.url, new Blob([body], { type: BODY_TYPE }));
  }
};
var MemoryAdapter = class extends MetricsAdapter {
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
};
var MatchRecorder = class {
  /**
   * @param {object} [options]
   * @param {string} [options.matchId] 멀티플레이는 모든 참가자가 같은 값을 넘깁니다. 서버는 경기당 한 행만 남깁니다.
   * @param {string} [options.mode='solo'] 예: 'solo' | 'local' | 'online'
   * @param {unknown} [options.seed=null]
   * @param {unknown[]} [options.players=[]]
   */
  constructor({ matchId = crypto.randomUUID(), mode = "solo", seed = null, players = [] } = {}) {
    checkName(matchId, "matchId");
    checkName(mode, "mode");
    if (!Array.isArray(players)) {
      throw new TypeError("metrics players must be an array.");
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
};
var InputLogRecorder = class extends MatchRecorder {
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
};
var SessionReplayRecorder = class extends MatchRecorder {
  /** @param {{ session: { exportReplay(): { seed: unknown, players: unknown[] } } } & object} options */
  constructor({ session, ...options }) {
    super(options);
    this.session = session;
  }
  capture() {
    const REPLAY = this.session.exportReplay();
    return { seed: REPLAY.seed, players: REPLAY.players, replay: REPLAY };
  }
};
function createMetrics({
  game,
  version,
  adapter,
  heartbeatMs = 3e4,
  flushMs = 1e4,
  maxBatchEvents = 50,
  now = () => Date.now()
} = {}) {
  checkName(game, "game");
  checkName(version, "version");
  if (!(adapter instanceof MetricsAdapter)) {
    throw new TypeError("metrics adapter must extend MetricsAdapter.");
  }
  checkInterval(heartbeatMs, "heartbeatMs");
  checkInterval(flushMs, "flushMs");
  if (!Number.isSafeInteger(maxBatchEvents) || maxBatchEvents < 1 || maxBatchEvents > 100) {
    throw new RangeError("metrics maxBatchEvents must be an integer from 1 to 100.");
  }
  const SESSION_ID = crypto.randomUUID();
  let tester = readTester();
  const EVENTS = [];
  const OUTBOX = [];
  let seq = 0;
  let playedMs = 0;
  let visibleSince = document.visibilityState === "visible" ? now() : null;
  let sending = null;
  let droppedBatches = 0;
  let disposed = false;
  function playMs() {
    return playedMs + (visibleSince == null ? 0 : now() - visibleSince);
  }
  function enqueue(events, matches) {
    const BODY = JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        game,
        build: version,
        sessionId: SESSION_ID,
        seq: seq++,
        playMs: playMs(),
        tester,
        events,
        matches
      },
      encodeBytes
    );
    const BYTES = ENCODER.encode(BODY).byteLength;
    if (BYTES > MAX_BATCH_BYTES) {
      throw new RangeError(`metrics batch is ${BYTES} bytes; the server accepts at most ${MAX_BATCH_BYTES}.`);
    }
    OUTBOX.push({ body: BODY, bytes: BYTES });
    if (OUTBOX.length > MAX_QUEUED_BATCHES) {
      OUTBOX.shift();
      droppedBatches++;
    }
  }
  function packEvents() {
    if (EVENTS.length) {
      enqueue(EVENTS.splice(0), []);
    }
  }
  function push(type, fields) {
    if (disposed) {
      throw new Error("metrics is disposed.");
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
        return;
      }
      if (OUTBOX[0] === BATCH) {
        OUTBOX.shift();
      }
    }
  }
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
  function flushOnHide() {
    packEvents();
    for (let i = 0; i < OUTBOX.length; ) {
      if (OUTBOX[i].bytes <= MAX_UNLOAD_BYTES && adapter.sendOnHide(OUTBOX[i].body)) {
        OUTBOX.splice(i, 1);
      } else {
        i++;
      }
    }
    if (OUTBOX.length) {
      flush();
    }
  }
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      if (visibleSince != null) {
        playedMs += now() - visibleSince;
        visibleSince = null;
      }
      push("heartbeat", {});
      flushOnHide();
    } else if (visibleSince == null) {
      visibleSince = now();
    }
  }
  function onPageHide() {
    push("session_end", {});
    flushOnHide();
  }
  function onPageShow(event) {
    if (event.persisted) {
      push("session_start", {});
    }
  }
  const HEARTBEAT = setInterval(() => {
    if (visibleSince != null) {
      push("heartbeat", {});
    }
  }, heartbeatMs);
  const FLUSH = setInterval(() => {
    if (EVENTS.length || OUTBOX.length) {
      flush();
    }
  }, flushMs);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  push("session_start", {});
  flush();
  return {
    sessionId: SESSION_ID,
    /** 지금까지 페이지가 보였던 시간(ms) */
    get playMs() {
      return playMs();
    },
    /** 이 기기에 붙인 개발자 이름표. null이면 일반 유저로 집계됩니다. */
    get tester() {
      return tester;
    },
    /**
     * 이 기기를 개발자 본인으로 표시(이름) 또는 해제(null)하고 기억합니다. 다음 배치부터 적용되며, 한 번 표시된 세션은
     * 서버에서 계속 개발자 세션입니다. itch.io처럼 iframe에 들어간 게임은 브라우저가 저장소를 상위 사이트별로 나누므로,
     * 그 페이지 안에서 게임 설정 화면 등으로 부릅니다.
     * @param {string | null} name 예: 'pc', 'phone'
     */
    setTester(name) {
      if (name !== null) {
        checkName(name, "tester");
      }
      tester = name;
      storeTester(name);
    },
    /** 서버가 계속 실패해 보관 상한을 넘겨 버린 배치 수 */
    get droppedBatches() {
      return droppedBatches;
    },
    /**
     * 게임 이벤트 하나. category → target → action 세 단계로 묶습니다. 예: track('match', 'rally', 'end', { score: 15 })
     * 고빈도 값(매 tick 위치 등)은 보내지 말고 경기 끝 summary나 recordMatch의 결정론 기록에 담습니다.
     */
    track(category, target, action, props = {}) {
      checkName(category, "category");
      checkName(target, "target");
      checkName(action, "action");
      if (!isRecord(props)) {
        throw new TypeError("metrics props must be a JSON object.");
      }
      push("event", { category, target, action, props });
    },
    /**
     * 끝난 경기 하나를 바로 보냅니다. `recorder.capture()`의 결정론 기록과 게임이 요약한 summary가 한 행으로 저장됩니다.
     * @param {MatchRecorder} recorder
     * @param {object} [summary]
     */
    recordMatch(recorder, summary = {}) {
      if (disposed) {
        throw new Error("metrics is disposed.");
      }
      if (!(recorder instanceof MatchRecorder)) {
        throw new TypeError("metrics recordMatch needs a MatchRecorder.");
      }
      if (!isRecord(summary)) {
        throw new TypeError("metrics summary must be a JSON object.");
      }
      const { seed: SEED, players: PLAYERS, replay: REPLAY } = recorder.capture();
      packEvents();
      enqueue(
        [],
        [
          {
            matchId: recorder.matchId,
            mode: recorder.mode,
            t: now(),
            seed: SEED,
            players: PLAYERS,
            summary,
            replay: REPLAY
          }
        ]
      );
      return flush();
    },
    flush,
    /** 세션을 끝냅니다(게임 종료 화면 등). 남은 배치를 보내고 타이머·리스너를 해제합니다. */
    dispose() {
      if (disposed) {
        return Promise.resolve();
      }
      push("session_end", {});
      disposed = true;
      clearInterval(HEARTBEAT);
      clearInterval(FLUSH);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      return flush();
    }
  };
}
export {
  HttpAdapter,
  InputLogRecorder,
  MatchRecorder,
  MemoryAdapter,
  MetricsAdapter,
  SCHEMA_VERSION,
  SessionReplayRecorder,
  createMetrics,
  reviveBytes
};

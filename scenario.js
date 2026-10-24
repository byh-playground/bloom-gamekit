// modules/simloop/rates.js
function clockRates({ baseHz, tickRate, inputHz, renderHz } = {}) {
  for (const [NAME, VALUE] of Object.entries({
    baseHz,
    tickRate,
    inputHz,
    renderHz
  })) {
    if (!Number.isSafeInteger(VALUE) || VALUE <= 0) {
      throw new RangeError(`${NAME} must be a positive integer frequency`);
    }
    if (NAME !== "baseHz" && baseHz % VALUE !== 0) {
      throw new RangeError(`${NAME} (${VALUE}) must divide baseHz (${baseHz}) exactly`);
    }
  }
  return Object.freeze({
    baseHz,
    tickRate,
    inputHz,
    renderHz,
    simulationDivisor: baseHz / tickRate,
    inputDivisor: baseHz / inputHz,
    renderDivisor: baseHz / renderHz
  });
}

// modules/simloop/loop.js
function createLoop({
  session,
  getInput = () => new Uint8Array(session.inputSize),
  render = () => {
  },
  inputPreview,
  rates,
  backlogPolicy = "drop",
  beforeFrame = () => {
  },
  canAdvance = () => true,
  canObserveInput = () => true,
  onAdvance = () => {
  },
  onPreviewError = () => {
  },
  onError = (error) => {
    throw error;
  },
  onInputRelease = () => {
  },
  onBacklogDrop = () => {
  },
  maxBacklogTicks = 8,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
} = {}) {
  if (!session || typeof session.poll !== "function" || typeof session.advance !== "function") {
    throw new TypeError("session capability");
  }
  for (const CALLBACK of [
    getInput,
    render,
    beforeFrame,
    canAdvance,
    canObserveInput,
    onAdvance,
    onPreviewError,
    onError,
    onInputRelease,
    onBacklogDrop
  ]) {
    if (typeof CALLBACK !== "function") {
      throw new TypeError("loop callback");
    }
  }
  if (backlogPolicy !== "drop" && backlogPolicy !== "retain" && backlogPolicy !== "defer") {
    throw new RangeError("backlogPolicy");
  }
  if (!Number.isInteger(maxBacklogTicks) || maxBacklogTicks < 1 || maxBacklogTicks > 8192) {
    throw new RangeError("maxBacklogTicks");
  }
  const HAS_SUBMISSION = typeof session.submitInput === "function";
  const CONFIGURED_RATES = rates === void 0 ? null : clockRates({
    ...rates,
    tickRate: session.profile.tickRate
  });
  const QUANTUM = 1e3 / session.profile.tickRate;
  const MAX_BACKLOG_MS = QUANTUM * maxBacklogTicks;
  const REPORT_BACKLOG_DROP = (elapsedMs, droppedMs, timestamp, reason) => {
    if (droppedMs <= 0) {
      return;
    }
    onBacklogDrop({
      elapsedMs,
      droppedMs,
      droppedTicks: Math.floor(droppedMs / QUANTUM),
      timestamp,
      reason
    });
  };
  let running = false;
  let handle;
  let last;
  let accumulator = 0;
  let generation = 0;
  let timingGeneration = 0;
  if (inputPreview && typeof inputPreview.observe !== "function") {
    throw new TypeError("inputPreview observation capability");
  }
  let inputSequence = 0;
  let commandObservation = 0;
  let observedAt = -Infinity;
  let cached = null;
  let captureEpoch = "";
  let captureSequence = -1;
  const OBSERVED_COMMANDS = [];
  const OBSERVE_INPUT = (timestamp) => {
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("input observation timestamp");
    }
    if (!canObserveInput()) {
      cached = null;
      inputPreview?.clear?.();
      return null;
    }
    const SAMPLED = getInput(), PACKET = SAMPLED && typeof SAMPLED === "object" && !ArrayBuffer.isView(SAMPLED) && Object.hasOwn(SAMPLED, "input");
    const INPUT = PACKET ? SAMPLED.input : SAMPLED, COMMANDS = PACKET ? SAMPLED.commands ?? [] : [];
    if (!Array.isArray(COMMANDS)) {
      throw new TypeError("input packet commands");
    }
    const HELD = OBSERVED_COMMANDS;
    if (HELD.length + COMMANDS.length > 64) {
      throw new RangeError("unsubmitted input command capacity");
    }
    for (const COMMAND of COMMANDS) {
      if (!COMMAND || COMMAND.payload === void 0) {
        throw new TypeError("command payload required");
      }
      HELD.push({
        observationId: ++commandObservation,
        sequence: null,
        payload: COMMAND.payload.slice?.() ?? structuredClone(COMMAND.payload)
      });
    }
    cached = {
      input: INPUT.slice?.() ?? structuredClone(INPUT),
      commands: HELD,
      predict: !PACKET || SAMPLED.predict !== false || HELD.length > 0 || inputPreview?.active === true,
      continuationKey: PACKET ? SAMPLED.continuationKey : void 0,
      sequence: ++inputSequence
    };
    observedAt = timestamp;
    if (HAS_SUBMISSION) {
      const PENDING = HELD.filter((command) => command.sequence === null);
      const SUBMISSION = session.submitInput(cached.input, {
        commands: PENDING.map((command) => command.payload)
      });
      if (SUBMISSION.commandSequences.length !== PENDING.length) {
        throw new Error("input submission command receipt");
      }
      for (let i = 0; i < PENDING.length; i++) {
        PENDING[i].sequence = SUBMISSION.commandSequences[i];
      }
    }
    if (inputPreview && PACKET && SAMPLED.predict === false && !HELD.length && !inputPreview.active) {
      inputPreview.cancelObservation?.(Math.max(timestamp, performance.now()));
    } else if (inputPreview?.enabled !== false && inputPreview) {
      try {
        inputPreview.observe(cached.input, {
          sequence: cached.sequence,
          tick: session.tick,
          epoch: session.epoch ?? 0,
          continuationKey: cached.continuationKey,
          timeMs: Math.max(timestamp, globalThis.performance?.now?.() ?? timestamp),
          commands: cached.commands
        });
      } catch (error) {
        inputPreview.clear?.();
        onPreviewError(error);
      }
    }
    return cached;
  };
  const RESET_TIMING = (clearPreview = true) => {
    timingGeneration++;
    last = void 0;
    accumulator = 0;
    if (clearPreview) {
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    }
  };
  const RELEASE = () => {
    try {
      onInputRelease();
      session.releaseInput();
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    } catch (error) {
      STOP();
      onError(error);
    }
  };
  const HIDDEN = () => {
    if (globalThis.document?.hidden) {
      RELEASE();
      RESET_TIMING();
    }
  };
  const STOP = () => {
    generation++;
    running = false;
    if (handle !== void 0) {
      cancelFrame?.(handle);
    }
    handle = void 0;
    inputPreview?.clear?.();
    globalThis.removeEventListener?.("blur", RELEASE);
    globalThis.document?.removeEventListener("visibilitychange", HIDDEN);
  };
  const RENDER_FRAME = () => render({
    session,
    alpha: Math.min(1, accumulator / QUANTUM),
    resimulating: session.resimulating
  });
  const PULSE = (timestamp, { render: shouldRender = true, input: shouldSampleInput = true } = {}) => {
    const CURRENT = generation;
    try {
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("frame timestamp");
      }
      if (backlogPolicy === "retain" && last !== void 0 && timestamp < last) {
        throw new RangeError("retained loop timestamp cannot regress");
      }
      if (backlogPolicy === "defer" && last !== void 0 && timestamp < last) {
        throw new RangeError("deferred loop timestamp cannot regress");
      }
      beforeFrame(timestamp);
      if (CURRENT !== generation) {
        return;
      }
      const TIMING = timingGeneration;
      if (last === void 0) {
        last = timestamp;
      }
      const ELAPSED = Math.max(0, timestamp - last);
      if (backlogPolicy === "drop" && ELAPSED > MAX_BACKLOG_MS) {
        const DROPPED_MS = accumulator + ELAPSED;
        accumulator = 0;
        last = timestamp;
        if (typeof inputPreview?.clockGap === "function") {
          inputPreview.clockGap();
        } else {
          inputPreview?.clear?.();
        }
        REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, "clock-gap");
      } else if (backlogPolicy === "defer" && ELAPSED > MAX_BACKLOG_MS) {
        const DROPPED_MS = accumulator + ELAPSED;
        accumulator = 0;
        last = timestamp;
        if (typeof inputPreview?.clockGap === "function") {
          inputPreview.clockGap();
        } else {
          inputPreview?.clear?.();
        }
        REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, "clock-gap");
      } else {
        if (backlogPolicy === "retain") {
          accumulator += ELAPSED;
        } else if (backlogPolicy === "defer") {
          const ACCUMULATED_MS = accumulator + ELAPSED;
          if (ACCUMULATED_MS > MAX_BACKLOG_MS) {
            const DROPPED_MS = ACCUMULATED_MS - MAX_BACKLOG_MS;
            accumulator = MAX_BACKLOG_MS;
            if (typeof inputPreview?.clockGap === "function") {
              inputPreview.clockGap();
            } else {
              inputPreview?.clear?.();
            }
            REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, "backlog-overflow");
          } else {
            accumulator = ACCUMULATED_MS;
          }
        } else {
          const CLAMPED_ELAPSED = Math.min(250, ELAPSED), ACCUMULATED_MS = accumulator + CLAMPED_ELAPSED, MAX_CATCHUP_MS = QUANTUM * session.profile.maxCatchupSteps, INPUT_DROPPED_MS = ELAPSED - CLAMPED_ELAPSED, BACKLOG_DROPPED_MS = Math.max(0, ACCUMULATED_MS - MAX_CATCHUP_MS);
          accumulator = Math.min(ACCUMULATED_MS, MAX_CATCHUP_MS);
          REPORT_BACKLOG_DROP(ELAPSED, INPUT_DROPPED_MS, timestamp, "input-dt-clamp");
          REPORT_BACKLOG_DROP(ELAPSED, BACKLOG_DROPPED_MS, timestamp, "backlog-overflow");
        }
        last = timestamp;
      }
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("loop backlog exceeds safe milliseconds");
      }
      session.poll();
      if (CURRENT !== generation || TIMING !== timingGeneration) {
        return;
      }
      if (shouldSampleInput && (inputPreview || HAS_SUBMISSION) && (!cached || timestamp - observedAt >= QUANTUM)) {
        OBSERVE_INPUT(timestamp);
      }
      let work = 0;
      while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
        const PACE = session.pace ?? session.metrics.pace;
        if (accumulator + 1e-7 < QUANTUM * PACE) {
          break;
        }
        const ALLOWED = canAdvance();
        if (CURRENT !== generation || TIMING !== timingGeneration) {
          return;
        }
        if (!ALLOWED) {
          if (backlogPolicy === "drop") {
            const DROPPED_MS = Math.max(0, accumulator - QUANTUM);
            accumulator = Math.min(accumulator, QUANTUM);
            REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, "drop-policy");
          }
          break;
        }
        const SAMPLED = inputPreview || HAS_SUBMISSION || !shouldSampleInput ? cached ?? (shouldSampleInput ? OBSERVE_INPUT(timestamp) : null) : getInput();
        if (!SAMPLED) {
          break;
        }
        if (CURRENT !== generation || TIMING !== timingGeneration) {
          return;
        }
        const PACKET = SAMPLED && typeof SAMPLED === "object" && !ArrayBuffer.isView(SAMPLED) && !(SAMPLED instanceof ArrayBuffer) && Object.hasOwn(SAMPLED, "input");
        const INPUT_VALUE = PACKET ? SAMPLED.input : SAMPLED;
        const INPUT = inputPreview && inputPreview.enabled !== false && ArrayBuffer.isView(INPUT_VALUE) ? new INPUT_VALUE.constructor(INPUT_VALUE) : INPUT_VALUE;
        if (PACKET) {
          const COMMANDS = SAMPLED.commands ?? [];
          if (!Array.isArray(COMMANDS)) {
            throw new TypeError("input packet commands must be an array");
          }
          if (COMMANDS.length && typeof session.queueCommand !== "function") {
            throw new TypeError("session does not support queued input commands");
          }
          for (const COMMAND of COMMANDS) {
            if (!COMMAND || COMMAND.payload === void 0) {
              throw new TypeError("input command payload required");
            }
            const PAYLOAD = ArrayBuffer.isView(COMMAND.payload) ? new COMMAND.payload.constructor(COMMAND.payload) : COMMAND.payload;
            if ((inputPreview || HAS_SUBMISSION || !shouldSampleInput) && COMMAND.sequence !== null && COMMAND.sequence !== void 0) {
              continue;
            }
            const SEQUENCE = session.queueCommand(PAYLOAD);
            if (!Number.isSafeInteger(SEQUENCE) || SEQUENCE < 0) {
              throw new TypeError("session command sequence");
            }
            if (inputPreview || HAS_SUBMISSION || !shouldSampleInput) {
              COMMAND.sequence = SEQUENCE;
            }
          }
        }
        if (!inputPreview && !HAS_SUBMISSION && !shouldSampleInput) {
          OBSERVED_COMMANDS.length = 0;
        }
        const RESULT = session.advance(INPUT);
        work++;
        let submission;
        if (inputPreview || HAS_SUBMISSION) {
          const METADATA = session.localInputState;
          const EPOCH = METADATA ? METADATA.epoch + ":" + METADATA.baseTick : "";
          if (EPOCH !== captureEpoch) {
            captureEpoch = EPOCH;
            captureSequence = -1;
          }
          for (const CAPTURE of METADATA?.captures ?? (METADATA?.capture ? [METADATA.capture] : [])) {
            if (CAPTURE.sequence <= captureSequence) {
              continue;
            }
            captureSequence = CAPTURE.sequence;
            submission = {
              ...CAPTURE,
              predict: cached?.predict !== false,
              boundaryTick: METADATA.tick,
              epoch: METADATA.epoch,
              timeMs: Math.max(timestamp, performance.now())
            };
            submission.commands = CAPTURE.commands.map((command) => ({
              ...command,
              observationId: cached?.commands.find((c) => c.sequence === command.sequence)?.observationId
            }));
            try {
              inputPreview?.commit(submission, submission.timeMs);
            } catch (error) {
              inputPreview.clear?.();
              onPreviewError(error);
            }
            const ASSIGNED = new Set(CAPTURE.commands.map((c) => c.sequence));
            for (let i = OBSERVED_COMMANDS.length - 1; i >= 0; i--) {
              if (ASSIGNED.has(OBSERVED_COMMANDS[i].sequence)) {
                OBSERVED_COMMANDS.splice(i, 1);
              }
            }
          }
        }
        if (TIMING !== timingGeneration) {
          return;
        }
        if (RESULT.status === "advanced") {
          accumulator = Math.max(0, accumulator - QUANTUM * PACE);
        } else if (backlogPolicy === "drop") {
          const DROPPED_MS = Math.max(0, accumulator - QUANTUM);
          accumulator = Math.min(accumulator, QUANTUM);
          REPORT_BACKLOG_DROP(ELAPSED, DROPPED_MS, timestamp, "drop-policy");
        }
        if (CURRENT !== generation) {
          return;
        }
        onAdvance(RESULT, submission);
        if (CURRENT !== generation || TIMING !== timingGeneration) {
          return;
        }
        if (RESULT.status !== "advanced") {
          break;
        }
      }
      if (shouldRender) {
        RENDER_FRAME();
      }
    } catch (error) {
      if (CURRENT === generation) {
        STOP();
      }
      onError(error);
    }
  };
  const START = () => {
    if (running) {
      return;
    }
    if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") {
      throw new TypeError("frame scheduler");
    }
    running = true;
    RESET_TIMING(false);
    const CURRENT = ++generation;
    const FRAME = (timestamp) => {
      if (!running || CURRENT !== generation) {
        return;
      }
      if (inputPreview || HAS_SUBMISSION) {
        OBSERVE_INPUT(timestamp);
      }
      PULSE(timestamp);
      if (running && CURRENT === generation) {
        handle = requestFrame(FRAME);
      }
    };
    globalThis.addEventListener?.("blur", RELEASE);
    globalThis.document?.addEventListener("visibilitychange", HIDDEN);
    handle = requestFrame(FRAME);
  };
  const FLUSH_INPUT = (timestamp) => OBSERVE_INPUT(timestamp);
  const POLL_INPUT = (timestamp) => {
    const SAMPLE = OBSERVE_INPUT(timestamp);
    session.poll();
    return SAMPLE;
  };
  return {
    get simulationTimeMs() {
      return last === void 0 ? null : last - accumulator;
    },
    get rates() {
      return CONFIGURED_RATES;
    },
    get nextDeadlineMs() {
      return last === void 0 ? null : last + Math.max(0, QUANTUM * (session.pace ?? session.metrics.pace) - accumulator);
    },
    start: START,
    stop: STOP,
    pulse: PULSE,
    render: RENDER_FRAME,
    observeInput: OBSERVE_INPUT,
    flushInput: FLUSH_INPUT,
    pollInput: POLL_INPUT,
    releaseInput: RELEASE,
    resetTiming: RESET_TIMING,
    get running() {
      return running;
    }
  };
}

// modules/scenario/scenario.js
function createScenario({ definition, createRun, requestFrame, cancelFrame, onEnd = () => {
} } = {}) {
  if (!definition || typeof createRun !== "function" || typeof onEnd !== "function") {
    throw new TypeError("scenario definition/factory");
  }
  definition = structuredClone(definition);
  const { tickRate: TICK_RATE, endTick: END_TICK, loop: REPEAT = false } = definition;
  if (!Number.isFinite(TICK_RATE) || TICK_RATE <= 0 || !Number.isSafeInteger(END_TICK) || END_TICK < 1) {
    throw new RangeError("tickRate/endTick");
  }
  const DT_MS = 1e3 / TICK_RATE;
  const TIMELINE = (definition.timeline ?? []).map((event, order) => {
    if (event.tick === void 0 === (event.atMs === void 0)) {
      throw new TypeError("exactly one of tick/atMs");
    }
    const TICK = event.tick ?? Math.ceil(event.atMs / DT_MS);
    if (!Number.isSafeInteger(TICK) || TICK < 0 || TICK > END_TICK || event.atMs !== void 0 && (!Number.isFinite(event.atMs) || event.atMs < 0)) {
      throw new RangeError("event time");
    }
    return {
      tick: TICK,
      order,
      event: structuredClone(event)
    };
  }).sort((a, b) => a.tick - b.tick || a.order - b.order);
  let state = "idle";
  let tick = 0;
  let cursor = 0;
  let iteration = 0;
  let scope = null;
  let controller = null;
  let generation = 0;
  let driving = false;
  const EMPTY = Object.freeze([]);
  function frame(at, alpha = 0) {
    const EVENTS = [];
    while (cursor < TIMELINE.length && TIMELINE[cursor].tick <= at) {
      EVENTS.push(structuredClone(TIMELINE[cursor++].event));
    }
    return {
      tick: at,
      timeMs: at * DT_MS,
      dtMs: at === 0 ? 0 : DT_MS,
      alpha,
      iteration,
      events: EVENTS.length ? EVENTS : EMPTY
    };
  }
  function release() {
    generation++;
    SCHEDULER.stop();
    controller?.abort();
    controller = null;
    const OLD = scope;
    scope = null;
    OLD?.dispose();
  }
  function initialize() {
    tick = 0;
    cursor = 0;
    controller = new AbortController();
    scope = createRun({
      seed: definition.seed,
      initialState: structuredClone(definition.initialState),
      scene: structuredClone(definition.scene),
      signal: controller.signal,
      iteration
    });
    if (!scope || typeof scope.step !== "function" || typeof scope.dispose !== "function") {
      throw new TypeError("isolated run step/dispose");
    }
    const INITIAL = frame(0);
    if (INITIAL.events.length && typeof scope.initialize !== "function") {
      throw new TypeError("tick zero events require initialize");
    }
    scope.initialize?.(INITIAL);
  }
  function advance() {
    if (state !== "playing") {
      return {
        status: "held",
        tick
      };
    }
    const TOKEN = generation;
    scope.step(frame(++tick));
    if (TOKEN !== generation) {
      return {
        status: "advanced",
        tick
      };
    }
    if (tick === END_TICK || scope.isComplete?.()) {
      state = "ended";
      SCHEDULER.stop();
      scope.pause?.();
      onEnd(snapshot());
      if (TOKEN === generation && scope) {
        scope.render?.({
          tick,
          timeMs: tick * DT_MS,
          alpha: 0,
          iteration
        });
      }
      if (TOKEN === generation && state === "ended" && REPEAT) {
        const AUTOMATIC = driving;
        release();
        iteration++;
        initialize();
        state = "playing";
        if (AUTOMATIC) {
          SCHEDULER.start();
        }
      }
    }
    return {
      status: "advanced",
      tick
    };
  }
  const SCHEDULER = createLoop({
    session: {
      inputSize: 0,
      profile: {
        tickRate: TICK_RATE,
        maxCatchupSteps: 5
      },
      pace: 1,
      poll() {
      },
      releaseInput() {
      },
      get closed() {
        return state !== "playing";
      },
      advance
    },
    getInput: () => EMPTY,
    canObserveInput: () => false,
    render({ alpha }) {
      if (scope && state !== "disposed") {
        scope.render?.({
          tick,
          timeMs: tick * DT_MS,
          alpha,
          iteration
        });
      }
    },
    requestFrame,
    cancelFrame,
    onError(error) {
      state = "stopped";
      release();
      throw error;
    }
  });
  function snapshot() {
    return {
      state,
      tick,
      timeMs: tick * DT_MS,
      iteration
    };
  }
  return {
    play({ automatic = true } = {}) {
      if (state === "disposed" || state === "playing" || state === "ended") {
        return;
      }
      try {
        if (!scope) {
          initialize();
        }
        state = "playing";
        driving = automatic;
        SCHEDULER.resetTiming();
        if (automatic) {
          SCHEDULER.start();
        }
      } catch (error) {
        state = "stopped";
        release();
        throw error;
      }
    },
    pause() {
      if (state !== "playing") {
        return;
      }
      state = "paused";
      SCHEDULER.stop();
      SCHEDULER.resetTiming();
      scope?.pause?.();
    },
    restart({ automatic = true } = {}) {
      if (state === "disposed") {
        return;
      }
      state = "stopped";
      release();
      iteration = 0;
      this.play({
        automatic
      });
    },
    stop() {
      if (state === "disposed") {
        return;
      }
      state = "stopped";
      release();
    },
    // Manual QA/export driver: exactly one fixed tick, no wall-clock accumulator.
    step() {
      if (driving && SCHEDULER.running) {
        throw new Error("pause automatic scheduling before manual stepping");
      }
      try {
        return advance();
      } catch (error) {
        state = "stopped";
        release();
        throw error;
      }
    },
    pulse(timestamp, options) {
      if (state === "playing" && !driving) {
        SCHEDULER.pulse(timestamp, options);
      }
    },
    render() {
      if (scope) {
        SCHEDULER.render();
      }
    },
    snapshot,
    get state() {
      return state;
    },
    dispose() {
      if (state === "disposed") {
        return;
      }
      state = "disposed";
      release();
    }
  };
}

// modules/scenario/showcase-host.js
var DEMO_PARAMETER = "showcaseDemo";
var ROUTE = "#/showcase";
function element(name, className = "", label = "") {
  const NODE = document.createElement(name);
  if (className) {
    NODE.className = className;
  }
  if (label) {
    NODE.textContent = label;
  }
  return NODE;
}
function sendKey(win, code, down) {
  const KEY = code === "Space" ? " " : code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code;
  const EVENT = new win.KeyboardEvent(down ? "keydown" : "keyup", {
    bubbles: true,
    cancelable: true,
    code,
    key: KEY,
    repeat: false
  });
  win.document.dispatchEvent(EVENT);
}
function point(win, selector, phase, u = 0.5, v = 0.5) {
  const TARGET = win.document.querySelector(selector);
  if (!TARGET) {
    return false;
  }
  const BOUNDS = TARGET.getBoundingClientRect();
  if (!BOUNDS.width || !BOUNDS.height) {
    return false;
  }
  const X = BOUNDS.left + BOUNDS.width * u;
  const Y = BOUNDS.top + BOUNDS.height * v;
  const EVENT = new win.PointerEvent(phase, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 71,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: phase === "pointerup" ? 0 : 1,
    clientX: X,
    clientY: Y
  });
  TARGET.dispatchEvent(EVENT);
  return true;
}
function execute(win, event, custom) {
  if (event.action === "chapter") {
    return true;
  }
  if (event.action === "custom") {
    return custom ? custom(event.name, win) !== false : true;
  }
  if (event.action === "click") {
    const TARGET = win.document.querySelector(event.selector);
    if (!TARGET || TARGET.disabled) {
      return false;
    }
    TARGET.click();
    return true;
  }
  if (event.action === "select") {
    const TARGET = win.document.querySelector(event.selector);
    if (!TARGET) {
      return false;
    }
    TARGET.value = event.value;
    TARGET.dispatchEvent(new win.Event("input", { bubbles: true }));
    TARGET.dispatchEvent(new win.Event("change", { bubbles: true }));
    return true;
  }
  if (event.action === "key") {
    sendKey(win, event.code, event.down);
    return true;
  }
  if (event.action === "pointer") {
    return point(win, event.selector, event.phase, event.u, event.v);
  }
  if (event.action === "draw") {
    const TARGET = win.document.querySelector(event.selector);
    if (!TARGET) {
      return false;
    }
    const SHAPE = event.shape || "circle";
    const TOTAL = SHAPE === "line" ? 18 : 48;
    for (let index = 0; index <= TOTAL; index++) {
      const T = index / TOTAL;
      const U = SHAPE === "line" ? 0.24 + T * 0.5 : 0.51 + Math.cos(T * Math.PI * 2) * 0.1;
      const V = SHAPE === "line" ? 0.6 - T * 0.26 : 0.47 + Math.sin(T * Math.PI * 2) * 0.14;
      const PHASE = index === 0 ? "pointerdown" : index === TOTAL ? "pointerup" : "pointermove";
      if (!point(win, event.selector, PHASE, U, V)) {
        return false;
      }
    }
    return true;
  }
  return true;
}
function style() {
  const TAG = document.createElement("style");
  TAG.textContent = `
    /* Match the Bounko film-like introduction: gameplay is the entire scene, not a boxed preview. */
    .bloom-showcase-link{min-height:44px;min-width:44px;touch-action:manipulation;cursor:pointer;border:1px solid currentColor;border-radius:10px;background:transparent;color:inherit;padding:10px 18px;font:inherit;font-weight:700;opacity:.95}
    .bloom-showcase-link:hover{opacity:1;filter:brightness(1.15)}
    #bloom-showcase{position:fixed;z-index:2147483000;inset:0;display:block;overflow:hidden;background:#071920;color:#e9fff9;font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif;isolation:isolate}
    #bloom-showcase[hidden]{display:none!important}
    #bloom-showcase *{box-sizing:border-box}
    .bloom-showcase-shell{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}
    .bloom-showcase-stage{position:absolute;inset:0;overflow:hidden;background:#091b20}
    .bloom-showcase-stage iframe{display:block;width:100%;height:100%;border:0;pointer-events:none}
    .bloom-showcase-stage::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,#071920d9 0%,#0719206c 13%,transparent 34%,transparent 53%,#07192070 78%,#071920dd 100%)}
    .bloom-showcase-head{position:absolute;z-index:2;top:0;left:0;right:0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:calc(16px + env(safe-area-inset-top,0px)) 20px 14px;pointer-events:none}
    .bloom-showcase-name{padding-top:8px;font-size:clamp(11px,1.4vw,14px);font-weight:800;letter-spacing:.12em;color:#a0e8db;text-shadow:0 2px 12px #061922}
    .bloom-showcase-controls{display:flex;gap:8px;align-items:center;pointer-events:auto}
    .bloom-showcase-controls button,.bloom-showcase-actions button{min-height:44px;min-width:44px;padding:9px 14px;border:1px solid #99ddd94d;border-radius:10px;background:#0d2834dc;color:#e2fff8;font:inherit;font-size:12px;font-weight:700;cursor:pointer;touch-action:manipulation;backdrop-filter:blur(8px)}
    .bloom-showcase-controls button:hover,.bloom-showcase-actions button:hover{filter:brightness(1.16)}
    .bloom-showcase-foot{position:absolute;z-index:2;right:0;bottom:0;left:0;display:grid;justify-items:center;gap:10px;padding:56px clamp(18px,4vw,56px) calc(15px + env(safe-area-inset-bottom,0px));background:linear-gradient(transparent,#071920d9 48%,#071920ec);text-align:center;pointer-events:none}
    .bloom-showcase-caption{max-width:min(980px,100%)}
    .bloom-showcase-caption h2{margin:0 0 8px;font-size:clamp(27px,4.7vw,52px);font-weight:900;letter-spacing:-.045em;line-height:1.13;text-shadow:0 2px 20px #061922}
    .bloom-showcase-caption p{margin:0;font-size:clamp(12px,1.5vw,15px);color:#b2ddd3;line-height:1.5;text-shadow:0 1px 12px #061922}
    .bloom-showcase-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;pointer-events:auto}
    .bloom-showcase-actions .bloom-showcase-play{min-width:160px;border-color:#a5f3bc;background:#a5f3bc;color:#102d30;font-size:15px;font-weight:850;backdrop-filter:none}
    .bloom-showcase-track{width:100%;height:3px;margin-top:7px;overflow:hidden;border-radius:3px;background:#244b53}
    .bloom-showcase-track span{display:block;width:0;height:100%;background:#99fbd6;transition:width .08s linear}
    .bloom-showcase-time{font-size:10px;font-weight:600;color:#a5c8be;font-variant-numeric:tabular-nums}
    #bloom-showcase[data-chapter=final] .bloom-showcase-caption h2{font-size:clamp(45px,10vw,86px);letter-spacing:-.065em}
    #bloom-showcase button:focus-visible{outline:3px solid #a5f3bc;outline-offset:3px}
    @media(max-width:450px){.bloom-showcase-head{padding-left:14px;padding-right:14px}.bloom-showcase-name{max-width:44%;font-size:10px;letter-spacing:.04em}.bloom-showcase-controls{gap:5px}.bloom-showcase-controls button{padding:8px 10px;font-size:11px}.bloom-showcase-foot{padding-left:17px;padding-right:17px}}
    @media(max-height:540px){.bloom-showcase-head{padding-top:calc(5px + env(safe-area-inset-top,0px));padding-bottom:4px}.bloom-showcase-foot{gap:4px;padding-top:18px;padding-bottom:calc(5px + env(safe-area-inset-bottom,0px))}.bloom-showcase-caption h2{margin-bottom:2px;font-size:clamp(20px,3.5vw,33px)}.bloom-showcase-caption p{font-size:11px}.bloom-showcase-actions button{min-height:40px;padding:7px 12px}.bloom-showcase-track{margin-top:2px}}
    @media(prefers-reduced-motion:reduce){.bloom-showcase-track span{transition:none}}
    `;
  document.head.append(TAG);
  return TAG;
}
function installShowcase({
  title,
  launcher,
  timeline,
  durationMs = 27e3,
  readyTimeoutMs = 15e3,
  playSelector,
  custom,
  ready = () => true
} = {}) {
  if (new URLSearchParams(location.search).get(DEMO_PARAMETER) === "1") {
    return null;
  }
  if (!title || !launcher || !Array.isArray(timeline) || durationMs < 1e3) {
    throw new TypeError("showcase configuration");
  }
  const CSS = style();
  const ROOT = element("section");
  ROOT.id = "bloom-showcase";
  ROOT.hidden = true;
  ROOT.setAttribute("role", "dialog");
  ROOT.setAttribute("aria-modal", "true");
  ROOT.setAttribute("aria-label", title + " 소개");
  ROOT.innerHTML = `
       <div class="bloom-showcase-shell">
         <div class="bloom-showcase-stage" data-viewport></div>
         <header class="bloom-showcase-head"><strong class="bloom-showcase-name"></strong>
           <nav class="bloom-showcase-controls" aria-label="소개 재생 제어">
             <button type="button" data-action="pause">일시정지</button>
             <button type="button" data-action="close">닫기</button>
           </nav>
         </header>
         <footer class="bloom-showcase-foot">
           <div class="bloom-showcase-caption"><h2 data-copy>실제 플레이 소개</h2><p data-sub role="status" aria-live="polite">게임을 준비하는 중입니다.</p></div>
           <div class="bloom-showcase-actions">
             <button class="bloom-showcase-play" type="button" data-action="play">직접 플레이</button>
             <button type="button" data-action="replay">다시 보기</button>
           </div>
           <div class="bloom-showcase-track" aria-hidden="true"><span data-progress></span></div>
           <small class="bloom-showcase-time" data-time>0초</small>
         </footer>
       </div>`;
  document.body.append(ROOT);
  const PICK = (s) => ROOT.querySelector(s);
  const VIEWPORT = PICK("[data-viewport]");
  const NAME = PICK(".bloom-showcase-name");
  const HEADING = PICK("[data-copy]");
  const SUBTITLE = PICK("[data-sub]");
  const PROGRESS = PICK("[data-progress]");
  const TIME = PICK("[data-time]");
  const PAUSE_BUTTON = PICK("[data-action=pause]");
  NAME.textContent = title + " · 플레이 소개";
  const LAUNCH_BUTTON = element("button", "bloom-showcase-link", "▶ 소개 보기");
  LAUNCH_BUTTON.type = "button";
  LAUNCH_BUTTON.setAttribute("aria-label", title + " 플레이 소개 보기");
  let frame = null, runner = null, focus = null, previousUrl = null;
  let held = /* @__PURE__ */ new Set(), restored = [];
  const IS_OPEN = () => !ROOT.hidden;
  const CONTENT_WINDOW = () => frame?.contentWindow || null;
  function restoreBackground() {
    for (const [NODE, VALUE] of restored) {
      NODE.inert = VALUE;
    }
    restored = [];
  }
  function destroy() {
    runner?.dispose();
    runner = null;
    const WIN = CONTENT_WINDOW();
    if (WIN && WIN.document) {
      for (const CODE of held) {
        sendKey(WIN, CODE, false);
      }
    }
    held = /* @__PURE__ */ new Set();
    frame?.remove();
    frame = null;
    VIEWPORT.replaceChildren();
  }
  function stop(clearRoute = true) {
    if (!IS_OPEN()) {
      return;
    }
    destroy();
    ROOT.hidden = true;
    restoreBackground();
    if (clearRoute && location.hash === ROUTE) {
      history.replaceState(null, "", previousUrl || location.pathname + location.search);
    }
    focus?.focus?.({ preventScroll: true });
    focus = null;
    window.dispatchEvent(new Event("bloom-showcase-closed"));
  }
  async function mount() {
    destroy();
    ROOT.dataset.chapter = "opening";
    HEADING.textContent = "실제 플레이 소개";
    SUBTITLE.textContent = "게임을 준비하는 중입니다.";
    TIME.textContent = "0 / " + Math.ceil(durationMs / 1e3) + "초";
    PROGRESS.style.width = "0%";
    PAUSE_BUTTON.textContent = "일시정지";
    const INTRO_URL = new URL(location.href);
    INTRO_URL.searchParams.set(DEMO_PARAMETER, "1");
    INTRO_URL.hash = "";
    const NEXT = document.createElement("iframe");
    NEXT.title = title + " 격리된 실제 플레이";
    NEXT.tabIndex = -1;
    NEXT.allow = "autoplay";
    NEXT.src = INTRO_URL.href;
    frame = NEXT;
    VIEWPORT.replaceChildren(frame);
    await new Promise((resolve, reject) => {
      NEXT.addEventListener("load", resolve, { once: true });
      NEXT.addEventListener("error", () => reject(new Error("소개 게임을 불러오지 못했습니다")), { once: true });
    });
    if (!IS_OPEN() || NEXT !== frame) {
      return;
    }
    const WIN = CONTENT_WINDOW();
    const LOADED_AT = performance.now();
    await new Promise((resolve, reject) => {
      const CHECK = () => {
        if (!IS_OPEN() || NEXT !== frame) {
          resolve();
          return;
        }
        try {
          if (ready(WIN)) {
            resolve();
            return;
          }
        } catch {
        }
        if (performance.now() - LOADED_AT > readyTimeoutMs) {
          reject(new Error("실제 게임 준비 시간이 초과되었습니다"));
          return;
        }
        requestAnimationFrame(CHECK);
      };
      CHECK();
    });
    if (!IS_OPEN() || NEXT !== frame) {
      return;
    }
    const QUEUE = [];
    runner = createScenario({
      definition: {
        seed: 28101,
        tickRate: 30,
        endTick: Math.ceil(durationMs * 30 / 1e3),
        timeline
      },
      createRun() {
        return {
          initialize({ events }) {
            QUEUE.push(...events);
          },
          step({ events, timeMs }) {
            QUEUE.push(...events);
            for (let i = 0; i < QUEUE.length; ) {
              const EVENT = QUEUE[i];
              if (EVENT.action === "chapter") {
                ROOT.dataset.chapter = String(EVENT.index ?? "scene");
                HEADING.textContent = EVENT.title || title;
                SUBTITLE.textContent = EVENT.caption || "";
                QUEUE.splice(i, 1);
                continue;
              }
              if (execute(WIN, EVENT, custom)) {
                if (EVENT.action === "key") {
                  if (EVENT.down) {
                    held.add(EVENT.code);
                  } else {
                    held.delete(EVENT.code);
                  }
                }
                QUEUE.splice(i, 1);
                continue;
              }
              if (timeMs - (EVENT.atMs || 0) > 6e3) {
                QUEUE.splice(i, 1);
                continue;
              }
              break;
            }
          },
          render({ timeMs }) {
            const ELAPSED = Math.min(durationMs, timeMs);
            TIME.textContent = Math.floor(ELAPSED / 1e3) + " / " + Math.ceil(durationMs / 1e3) + "초";
            PROGRESS.style.width = Math.min(100, ELAPSED / durationMs * 100) + "%";
          },
          pause() {
            PAUSE_BUTTON.textContent = "이어 보기";
          },
          dispose() {
            QUEUE.length = 0;
          }
        };
      },
      onEnd() {
        if (!IS_OPEN()) {
          return;
        }
        ROOT.dataset.chapter = "final";
        HEADING.textContent = title;
        SUBTITLE.textContent = "소개가 끝났습니다. 바로 플레이하거나 다시 볼 수 있습니다.";
        PAUSE_BUTTON.disabled = true;
      }
    });
    PAUSE_BUTTON.disabled = false;
    runner.play();
  }
  function open(viaButton) {
    if (IS_OPEN()) {
      return;
    }
    previousUrl = viaButton ? location.href : location.pathname + location.search;
    focus = viaButton ? LAUNCH_BUTTON : document.activeElement;
    if (viaButton) {
      history.pushState(null, "", location.pathname + location.search + ROUTE);
    }
    ROOT.hidden = false;
    restored = [...document.body.children].filter((n) => n !== ROOT && n.tagName !== "SCRIPT").map((n) => [n, n.inert]);
    for (const [NODE] of restored) {
      NODE.inert = true;
    }
    PICK("[data-action=close]").focus({ preventScroll: true });
    window.dispatchEvent(new Event("bloom-showcase-opened"));
    void mount().catch((error) => {
      if (!IS_OPEN()) {
        return;
      }
      ROOT.dataset.chapter = "error";
      HEADING.textContent = "소개를 실행하지 못했습니다";
      SUBTITLE.textContent = String(error.message || error);
      console.warn("[BLOOM showcase]", error);
    });
  }
  function syncRoute() {
    if (location.hash === ROUTE) {
      if (!IS_OPEN()) {
        open(false);
      }
    } else if (IS_OPEN()) {
      stop(false);
    }
  }
  LAUNCH_BUTTON.onclick = () => open(true);
  PICK("[data-action=close]").onclick = () => stop();
  PICK("[data-action=replay]").onclick = () => {
    if (IS_OPEN()) {
      void mount().catch((error) => {
        SUBTITLE.textContent = String(error.message || error);
      });
    }
  };
  PAUSE_BUTTON.onclick = () => {
    if (!runner) {
      return;
    }
    if (runner.state === "playing") {
      runner.pause();
    } else if (runner.state === "paused") {
      runner.play();
    }
    PAUSE_BUTTON.textContent = runner.state === "playing" ? "일시정지" : "이어 보기";
  };
  PICK("[data-action=play]").onclick = () => {
    stop();
    const TARGET = playSelector && document.querySelector(playSelector);
    if (TARGET && !TARGET.disabled) {
      TARGET.click();
    } else {
      LAUNCH_BUTTON.focus({ preventScroll: true });
    }
  };
  const ON_KEY = (event) => {
    if (!IS_OPEN()) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const BUTTONS = [...ROOT.querySelectorAll("button:not(:disabled)")];
    const FIRST = BUTTONS[0], LAST = BUTTONS.at(-1);
    if (event.shiftKey && document.activeElement === FIRST) {
      event.preventDefault();
      LAST.focus();
    } else if (!event.shiftKey && document.activeElement === LAST) {
      event.preventDefault();
      FIRST.focus();
    }
  };
  document.addEventListener("keydown", ON_KEY, true);
  window.addEventListener("popstate", syncRoute);
  window.addEventListener("hashchange", syncRoute);
  const OBSERVER = new MutationObserver(() => attach());
  function attach() {
    if (LAUNCH_BUTTON.isConnected) {
      return;
    }
    const ANCHOR = document.querySelector(launcher);
    if (ANCHOR && !ANCHOR.closest("#bloom-showcase")) {
      ANCHOR.insertAdjacentElement("afterend", LAUNCH_BUTTON);
    }
  }
  OBSERVER.observe(document.body, { subtree: true, childList: true });
  attach();
  queueMicrotask(syncRoute);
  return {
    open: () => open(true),
    close: stop,
    dispose() {
      stop();
      OBSERVER.disconnect();
      document.removeEventListener("keydown", ON_KEY, true);
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
      LAUNCH_BUTTON.remove();
      ROOT.remove();
      CSS.remove();
    },
    get active() {
      return IS_OPEN();
    }
  };
}
export {
  createScenario,
  installShowcase
};

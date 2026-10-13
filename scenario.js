// modules/simloop/loop.js
function createLoop({
  session,
  getInput = () => new Uint8Array(session.inputSize),
  render = () => {
  },
  inputPreview,
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
  if (!session || typeof session.poll !== "function" || typeof session.advance !== "function") throw new TypeError("session capability");
  for (const callback of [getInput, render, beforeFrame, canAdvance, canObserveInput, onAdvance, onPreviewError, onError, onInputRelease, onBacklogDrop]) {
    if (typeof callback !== "function") throw new TypeError("loop callback");
  }
  if (backlogPolicy !== "drop" && backlogPolicy !== "retain") throw new RangeError("backlogPolicy");
  if (!Number.isInteger(maxBacklogTicks) || maxBacklogTicks < 1 || maxBacklogTicks > 8192) throw new RangeError("maxBacklogTicks");
  const hasSubmission = typeof session.submitInput === "function";
  const quantum = 1e3 / session.profile.tickRate;
  const maxBacklogMs = quantum * maxBacklogTicks;
  let running = false, handle, last, accumulator = 0, generation = 0, timingGeneration = 0;
  if (inputPreview && typeof inputPreview.observe !== "function") throw new TypeError("inputPreview observation capability");
  let inputSequence = 0, commandObservation = 0, observedAt = -Infinity, cached = null, captureEpoch = "", captureSequence = -1;
  const observedCommands = [];
  const observeInput = (timestamp) => {
    if (!Number.isFinite(timestamp)) throw new TypeError("input observation timestamp");
    if (!canObserveInput()) {
      cached = null;
      inputPreview?.clear?.();
      return null;
    }
    const sampled = getInput(), packet = sampled && typeof sampled === "object" && !ArrayBuffer.isView(sampled) && Object.hasOwn(sampled, "input");
    const input = packet ? sampled.input : sampled, commands = packet ? sampled.commands ?? [] : [];
    if (!Array.isArray(commands)) throw new TypeError("input packet commands");
    const held = observedCommands;
    if (held.length + commands.length > 64) throw new RangeError("unsubmitted input command capacity");
    for (const command of commands) {
      if (!command || command.payload === void 0) throw new TypeError("command payload required");
      held.push({ observationId: ++commandObservation, sequence: null, payload: command.payload.slice?.() ?? structuredClone(command.payload) });
    }
    cached = { input: input.slice?.() ?? structuredClone(input), commands: held, predict: !packet || sampled.predict !== false || held.length > 0 || inputPreview?.active === true, continuationKey: packet ? sampled.continuationKey : void 0, sequence: ++inputSequence };
    observedAt = timestamp;
    if (hasSubmission) {
      const pending = held.filter((command) => command.sequence === null);
      const submission = session.submitInput(cached.input, { commands: pending.map((command) => command.payload) });
      if (submission.commandSequences.length !== pending.length) throw new Error("input submission command receipt");
      for (let i = 0; i < pending.length; i++) pending[i].sequence = submission.commandSequences[i];
    }
    if (inputPreview && packet && sampled.predict === false && !held.length && !inputPreview.active) inputPreview.cancelObservation?.(Math.max(timestamp, performance.now()));
    else if (inputPreview?.enabled !== false && inputPreview) try {
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
    return cached;
  };
  const resetTiming = (clearPreview = true) => {
    timingGeneration++;
    last = void 0;
    accumulator = 0;
    if (clearPreview) {
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    }
  };
  const release = () => {
    try {
      onInputRelease();
      session.releaseInput();
      cached = null;
      observedAt = -Infinity;
      inputPreview?.clear?.();
    } catch (error) {
      stop();
      onError(error);
    }
  };
  const hidden = () => {
    if (globalThis.document?.hidden) {
      release();
      resetTiming();
    }
  };
  const stop = () => {
    generation++;
    running = false;
    if (handle !== void 0) cancelFrame?.(handle);
    handle = void 0;
    inputPreview?.clear?.();
    globalThis.removeEventListener?.("blur", release);
    globalThis.document?.removeEventListener("visibilitychange", hidden);
  };
  const renderFrame = () => render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
  const pulse = (timestamp, { render: shouldRender = true, input: shouldSampleInput = true } = {}) => {
    const current = generation;
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError("frame timestamp");
      if (backlogPolicy === "retain" && last !== void 0 && timestamp < last) throw new RangeError("retained loop timestamp cannot regress");
      beforeFrame(timestamp);
      if (current !== generation) return;
      const timing = timingGeneration;
      if (last === void 0) last = timestamp;
      const elapsed = Math.max(0, timestamp - last);
      if (elapsed > maxBacklogMs) {
        accumulator = 0;
        last = timestamp;
        if (typeof inputPreview?.clockGap === "function") inputPreview.clockGap();
        else inputPreview?.clear?.();
        onBacklogDrop({ elapsedMs: elapsed, droppedTicks: Math.floor(elapsed / quantum), timestamp });
      } else {
        accumulator = backlogPolicy === "retain" ? accumulator + elapsed : Math.min(accumulator + Math.min(250, elapsed), quantum * session.profile.maxCatchupSteps);
        last = timestamp;
      }
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) throw new RangeError("loop backlog exceeds safe milliseconds");
      session.poll();
      if (current !== generation || timing !== timingGeneration) return;
      if (shouldSampleInput && (inputPreview || hasSubmission) && (!cached || timestamp - observedAt >= quantum)) observeInput(timestamp);
      let work = 0;
      while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
        const pace = session.pace ?? session.metrics.pace;
        if (accumulator < quantum * pace) break;
        const allowed = canAdvance();
        if (current !== generation || timing !== timingGeneration) return;
        if (!allowed) {
          if (backlogPolicy === "drop") accumulator = Math.min(accumulator, quantum);
          break;
        }
        const sampled = inputPreview || hasSubmission || !shouldSampleInput ? cached ?? (shouldSampleInput ? observeInput(timestamp) : null) : getInput();
        if (!sampled) break;
        if (current !== generation || timing !== timingGeneration) return;
        const packet = sampled && typeof sampled === "object" && !ArrayBuffer.isView(sampled) && !(sampled instanceof ArrayBuffer) && Object.hasOwn(sampled, "input");
        const inputValue = packet ? sampled.input : sampled;
        const input = inputPreview && inputPreview.enabled !== false && ArrayBuffer.isView(inputValue) ? new inputValue.constructor(inputValue) : inputValue;
        if (packet) {
          const commands = sampled.commands ?? [];
          if (!Array.isArray(commands)) throw new TypeError("input packet commands must be an array");
          if (commands.length && typeof session.queueCommand !== "function") throw new TypeError("session does not support queued input commands");
          for (const command of commands) {
            if (!command || command.payload === void 0) throw new TypeError("input command payload required");
            const payload = ArrayBuffer.isView(command.payload) ? new command.payload.constructor(command.payload) : command.payload;
            if ((inputPreview || hasSubmission || !shouldSampleInput) && command.sequence !== null && command.sequence !== void 0) continue;
            const sequence = session.queueCommand(payload);
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("session command sequence");
            if (inputPreview || hasSubmission || !shouldSampleInput) command.sequence = sequence;
          }
        }
        if (!inputPreview && !hasSubmission && !shouldSampleInput) observedCommands.length = 0;
        const result = session.advance(input);
        work++;
        let submission;
        if (inputPreview || hasSubmission) {
          const metadata = session.localInputState;
          const epoch = metadata ? metadata.epoch + ":" + metadata.baseTick : "";
          if (epoch !== captureEpoch) {
            captureEpoch = epoch;
            captureSequence = -1;
          }
          for (const capture of metadata?.captures ?? (metadata?.capture ? [metadata.capture] : [])) {
            if (capture.sequence <= captureSequence) continue;
            captureSequence = capture.sequence;
            submission = { ...capture, predict: cached?.predict !== false, boundaryTick: metadata.tick, epoch: metadata.epoch, timeMs: Math.max(timestamp, performance.now()) };
            submission.commands = capture.commands.map((command) => ({ ...command, observationId: cached?.commands.find((c) => c.sequence === command.sequence)?.observationId }));
            try {
              inputPreview?.commit(submission, submission.timeMs);
            } catch (error) {
              inputPreview.clear?.();
              onPreviewError(error);
            }
            const assigned = new Set(capture.commands.map((c) => c.sequence));
            for (let i = observedCommands.length - 1; i >= 0; i--) if (assigned.has(observedCommands[i].sequence)) observedCommands.splice(i, 1);
          }
        }
        if (timing !== timingGeneration) return;
        if (result.status === "advanced") accumulator = Math.max(0, accumulator - quantum * pace);
        else if (backlogPolicy === "drop") accumulator = Math.min(accumulator, quantum);
        if (current !== generation) return;
        onAdvance(result, submission);
        if (current !== generation || timing !== timingGeneration) return;
        if (result.status !== "advanced") break;
      }
      if (shouldRender) renderFrame();
    } catch (error) {
      if (current === generation) stop();
      onError(error);
    }
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") throw new TypeError("frame scheduler");
    running = true;
    resetTiming(false);
    const current = ++generation;
    const frame = (timestamp) => {
      if (!running || current !== generation) return;
      if (inputPreview || hasSubmission) observeInput(timestamp);
      pulse(timestamp);
      if (running && current === generation) handle = requestFrame(frame);
    };
    globalThis.addEventListener?.("blur", release);
    globalThis.document?.addEventListener("visibilitychange", hidden);
    handle = requestFrame(frame);
  };
  const flushInput = (timestamp) => observeInput(timestamp);
  const pollInput = (timestamp) => {
    const sample = observeInput(timestamp);
    session.poll();
    return sample;
  };
  return { start, stop, pulse, render: renderFrame, observeInput, flushInput, pollInput, releaseInput: release, resetTiming, get running() {
    return running;
  } };
}

// modules/scenario/scenario.js
function createScenario({ definition, createRun, requestFrame, cancelFrame, onEnd = () => {
} } = {}) {
  if (!definition || typeof createRun !== "function" || typeof onEnd !== "function") throw new TypeError("scenario definition/factory");
  definition = structuredClone(definition);
  const { tickRate, endTick, loop: repeat = false } = definition;
  if (!Number.isFinite(tickRate) || tickRate <= 0 || !Number.isSafeInteger(endTick) || endTick < 1) throw new RangeError("tickRate/endTick");
  const dtMs = 1e3 / tickRate;
  const timeline = (definition.timeline ?? []).map((event, order) => {
    if (event.tick === void 0 === (event.atMs === void 0)) throw new TypeError("exactly one of tick/atMs");
    const tick2 = event.tick ?? Math.ceil(event.atMs / dtMs);
    if (!Number.isSafeInteger(tick2) || tick2 < 0 || tick2 > endTick || event.atMs !== void 0 && (!Number.isFinite(event.atMs) || event.atMs < 0)) throw new RangeError("event time");
    return { tick: tick2, order, event: structuredClone(event) };
  }).sort((a, b) => a.tick - b.tick || a.order - b.order);
  let state = "idle", tick = 0, cursor = 0, iteration = 0, scope = null, controller = null, generation = 0, driving = false;
  const empty = Object.freeze([]);
  function frame(at, alpha = 0) {
    const events = [];
    while (cursor < timeline.length && timeline[cursor].tick <= at) events.push(structuredClone(timeline[cursor++].event));
    return { tick: at, timeMs: at * dtMs, dtMs: at === 0 ? 0 : dtMs, alpha, iteration, events: events.length ? events : empty };
  }
  function release() {
    generation++;
    scheduler.stop();
    controller?.abort();
    controller = null;
    const old = scope;
    scope = null;
    old?.dispose();
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
    if (!scope || typeof scope.step !== "function" || typeof scope.dispose !== "function") throw new TypeError("isolated run step/dispose");
    const initial = frame(0);
    if (initial.events.length && typeof scope.initialize !== "function") throw new TypeError("tick zero events require initialize");
    scope.initialize?.(initial);
  }
  function advance() {
    if (state !== "playing") return { status: "held", tick };
    const token = generation;
    scope.step(frame(++tick));
    if (token !== generation) return { status: "advanced", tick };
    if (tick === endTick || scope.isComplete?.()) {
      state = "ended";
      scheduler.stop();
      scope.pause?.();
      onEnd(snapshot());
      if (token === generation && scope) scope.render?.({ tick, timeMs: tick * dtMs, alpha: 0, iteration });
      if (token === generation && state === "ended" && repeat) {
        const automatic = driving;
        release();
        iteration++;
        initialize();
        state = "playing";
        if (automatic) scheduler.start();
      }
    }
    return { status: "advanced", tick };
  }
  const scheduler = createLoop({
    session: {
      inputSize: 0,
      profile: { tickRate, maxCatchupSteps: 5 },
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
    getInput: () => empty,
    canObserveInput: () => false,
    render({ alpha }) {
      if (scope && state !== "disposed") scope.render?.({ tick, timeMs: tick * dtMs, alpha, iteration });
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
    return { state, tick, timeMs: tick * dtMs, iteration };
  }
  return {
    play({ automatic = true } = {}) {
      if (state === "disposed" || state === "playing" || state === "ended") return;
      try {
        if (!scope) initialize();
        state = "playing";
        driving = automatic;
        scheduler.resetTiming();
        if (automatic) scheduler.start();
      } catch (error) {
        state = "stopped";
        release();
        throw error;
      }
    },
    pause() {
      if (state !== "playing") return;
      state = "paused";
      scheduler.stop();
      scheduler.resetTiming();
      scope?.pause?.();
    },
    restart({ automatic = true } = {}) {
      if (state === "disposed") return;
      state = "stopped";
      release();
      iteration = 0;
      this.play({ automatic });
    },
    stop() {
      if (state === "disposed") return;
      state = "stopped";
      release();
    },
    // Manual QA/export driver: exactly one fixed tick, no wall-clock accumulator.
    step() {
      if (driving && scheduler.running) throw new Error("pause automatic scheduling before manual stepping");
      try {
        return advance();
      } catch (error) {
        state = "stopped";
        release();
        throw error;
      }
    },
    pulse(timestamp, options) {
      if (state === "playing" && !driving) scheduler.pulse(timestamp, options);
    },
    render() {
      if (scope) scheduler.render();
    },
    snapshot,
    get state() {
      return state;
    },
    dispose() {
      if (state === "disposed") return;
      state = "disposed";
      release();
    }
  };
}
export {
  createScenario
};

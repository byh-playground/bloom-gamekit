import { createLoop } from '../simloop/loop.js';

/** Deterministic timeline/lifetime; the factory owns isolated simulation and rendering. */
export function createScenario({ definition, createRun, requestFrame, cancelFrame, onEnd = () => {} } = {}) {
  if (!definition || typeof createRun !== 'function' || typeof onEnd !== 'function') throw new TypeError('scenario definition/factory');
  definition = structuredClone(definition);
  const { tickRate, endTick, loop: repeat = false } = definition;
  if (!Number.isFinite(tickRate) || tickRate <= 0 || !Number.isSafeInteger(endTick) || endTick < 1) throw new RangeError('tickRate/endTick');
  const dtMs = 1000 / tickRate;
  const timeline = (definition.timeline ?? []).map((event, order) => {
    if ((event.tick === undefined) === (event.atMs === undefined)) throw new TypeError('exactly one of tick/atMs');
    const tick = event.tick ?? Math.ceil(event.atMs / dtMs);
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > endTick || (event.atMs !== undefined && (!Number.isFinite(event.atMs) || event.atMs < 0))) throw new RangeError('event time');
    return { tick, order, event: structuredClone(event) };
  }).sort((a, b) => a.tick - b.tick || a.order - b.order);
  let state = 'idle', tick = 0, cursor = 0, iteration = 0, scope = null, controller = null, generation = 0, driving = false;
  const empty = Object.freeze([]);
  function frame(at, alpha = 0) {
    const events = []; while (cursor < timeline.length && timeline[cursor].tick <= at) events.push(structuredClone(timeline[cursor++].event));
    return { tick: at, timeMs: at * dtMs, dtMs: at === 0 ? 0 : dtMs, alpha, iteration, events: events.length ? events : empty };
  }
  function release() {
    generation++; scheduler.stop(); controller?.abort(); controller = null;
    const old = scope; scope = null; old?.dispose();
  }
  function initialize() {
    tick = 0; cursor = 0; controller = new AbortController();
    scope = createRun({ seed: definition.seed, initialState: structuredClone(definition.initialState),
      scene: structuredClone(definition.scene), signal: controller.signal, iteration });
    if (!scope || typeof scope.step !== 'function' || typeof scope.dispose !== 'function') throw new TypeError('isolated run step/dispose');
    const initial = frame(0);
    if (initial.events.length && typeof scope.initialize !== 'function') throw new TypeError('tick zero events require initialize');
    scope.initialize?.(initial);
  }
  function advance() {
    if (state !== 'playing') return { status: 'held', tick };
    const token = generation;
    scope.step(frame(++tick));
    if (token !== generation) return { status: 'advanced', tick };
    if (tick === endTick || scope.isComplete?.()) {
      state = 'ended'; scheduler.stop();
      scope.pause?.(); onEnd(snapshot());
      if (token === generation && scope) scope.render?.({ tick, timeMs: tick * dtMs, alpha: 0, iteration });
      if (token === generation && state === 'ended' && repeat) {
        const automatic = driving; release(); iteration++; initialize(); state = 'playing';
        if (automatic) scheduler.start();
      }
    }
    return { status: 'advanced', tick };
  }
  const scheduler = createLoop({
    session: { inputSize: 0, profile: { tickRate, maxCatchupSteps: 5 }, pace: 1, poll() {}, releaseInput() {},
      get closed() { return state !== 'playing'; }, advance },
    getInput: () => empty, canObserveInput: () => false,
    render({ alpha }) { if (scope && state !== 'disposed') scope.render?.({ tick, timeMs: tick * dtMs, alpha, iteration }); },
    requestFrame, cancelFrame,
    onError(error) { state = 'stopped'; release(); throw error; },
  });
  function snapshot() { return { state, tick, timeMs: tick * dtMs, iteration }; }
  return {
    play({ automatic = true } = {}) {
      if (state === 'disposed' || state === 'playing' || state === 'ended') return;
      try { if (!scope) initialize(); state = 'playing'; driving = automatic; scheduler.resetTiming(); if (automatic) scheduler.start(); }
      catch (error) { state = 'stopped'; release(); throw error; }
    },
    pause() { if (state !== 'playing') return; state = 'paused'; scheduler.stop(); scheduler.resetTiming(); scope?.pause?.(); },
    restart({ automatic = true } = {}) { if (state === 'disposed') return; state = 'stopped'; release(); iteration = 0; this.play({ automatic }); },
    stop() { if (state === 'disposed') return; state = 'stopped'; release(); },
    // Manual QA/export driver: exactly one fixed tick, no wall-clock accumulator.
    step() {
      if (driving && scheduler.running) throw new Error('pause automatic scheduling before manual stepping');
      try { return advance(); } catch (error) { state = 'stopped'; release(); throw error; }
    },
    pulse(timestamp, options) { if (state === 'playing' && !driving) scheduler.pulse(timestamp, options); },
    render() { if (scope) scheduler.render(); },
    snapshot,
    get state() { return state; },
    dispose() { if (state === 'disposed') return; state = 'disposed'; release(); },
  };
}

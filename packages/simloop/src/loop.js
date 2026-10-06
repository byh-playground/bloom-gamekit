/** Fixed Simulation dt, separately adjustable real-time scheduling. No import side effects. */
export function createLoop({ session, getInput = () => new Uint8Array(session.inputSize), render = () => {},
  backlogPolicy = 'drop', beforeFrame = () => {}, canAdvance = () => true, onAdvance = () => {},
  onError = error => { throw error; }, onInputRelease = () => {}, requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) } = {}) {
  if (!session || typeof session.poll !== 'function' || typeof session.advance !== 'function') throw new TypeError('session capability');
  for (const callback of [getInput, render, beforeFrame, canAdvance, onAdvance, onError, onInputRelease]) {
    if (typeof callback !== 'function') throw new TypeError('loop callback');
  }
  if (backlogPolicy !== 'drop' && backlogPolicy !== 'retain') throw new RangeError('backlogPolicy');
  const quantum = 1000 / session.profile.tickRate;
  let running = false, handle, last, accumulator = 0, generation = 0;
  const resetTiming = () => { last = undefined; accumulator = 0; };
  const release = () => {
    try { onInputRelease(); session.releaseInput(); }
    catch (error) { stop(); onError(error); }
  };
  const hidden = () => { if (globalThis.document?.hidden) { release(); resetTiming(); } };
  const stop = () => {
    generation++; running = false; if (handle !== undefined) cancelFrame?.(handle); handle = undefined;
    globalThis.removeEventListener?.('blur', release);
    globalThis.document?.removeEventListener('visibilitychange', hidden);
  };
  const pulse = timestamp => {
    const current = generation;
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError('frame timestamp');
      beforeFrame(timestamp);
      if (current !== generation) return;
      if (last === undefined) last = timestamp;
      const elapsed = Math.max(0, timestamp - last);
      accumulator = backlogPolicy === 'retain' ? accumulator + elapsed :
        Math.min(accumulator + Math.min(250, elapsed), quantum * session.profile.maxCatchupSteps);
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) throw new RangeError('loop backlog exceeds safe milliseconds');
      last = timestamp; session.poll();
      if (current !== generation) return;
      let work = 0;
      while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
        // Scalar capability avoids allocating a complete metrics snapshot per pacing read.
        const pace = session.pace ?? session.metrics.pace;
        if (accumulator < quantum * pace) break;
        const allowed = canAdvance();
        if (current !== generation) return;
        if (!allowed) { if (backlogPolicy === 'drop') accumulator = Math.min(accumulator, quantum); break; }
        const input = getInput();
        if (current !== generation) return;
        const result = session.advance(input); work++;
        if (current !== generation) return;
        if (result.status === 'advanced') accumulator = Math.max(0, accumulator - quantum * pace);
        else if (backlogPolicy === 'drop') accumulator = Math.min(accumulator, quantum);
        onAdvance(result);
        if (current !== generation) return;
        if (result.status !== 'advanced') break;
      }
      // Rendering continues when the session is waiting for input or connection recovery.
      render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
    } catch (error) { if (current === generation) stop(); onError(error); }
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') throw new TypeError('frame scheduler');
    running = true; resetTiming();
    const current = ++generation;
    const frame = timestamp => {
      if (!running || current !== generation) return;
      pulse(timestamp);
      if (running && current === generation) handle = requestFrame(frame);
    };
    globalThis.addEventListener?.('blur', release);
    globalThis.document?.addEventListener('visibilitychange', hidden);
    handle = requestFrame(frame);
  };
  return { start, stop, pulse, resetTiming, get running() { return running; } };
}

/** Fixed Simulation dt, separately adjustable real-time scheduling. No import side effects. */
export function createLoop({ session, getInput = () => new Uint8Array(session.inputSize), render = () => {}, inputPreview,
  backlogPolicy = 'drop', beforeFrame = () => {}, canAdvance = () => true, canObserveInput = () => true, onAdvance = () => {}, onPreviewError = () => {},
  onError = error => { throw error; }, onInputRelease = () => {}, onBacklogDrop = () => {}, maxBacklogTicks = 8,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) } = {}) {
  if (!session || typeof session.poll !== 'function' || typeof session.advance !== 'function') throw new TypeError('session capability');
  for (const callback of [getInput, render, beforeFrame, canAdvance, canObserveInput, onAdvance, onPreviewError, onError, onInputRelease, onBacklogDrop]) {
    if (typeof callback !== 'function') throw new TypeError('loop callback');
  }
  if (backlogPolicy !== 'drop' && backlogPolicy !== 'retain') throw new RangeError('backlogPolicy');
  if (!Number.isInteger(maxBacklogTicks) || maxBacklogTicks < 1 || maxBacklogTicks > 8192) throw new RangeError('maxBacklogTicks');
  const quantum = 1000 / session.profile.tickRate;
  const maxBacklogMs = quantum * maxBacklogTicks;
  let running = false, handle, last, accumulator = 0, generation = 0, timingGeneration = 0;
  if (inputPreview && typeof inputPreview.observe !== 'function') throw new TypeError('inputPreview observation capability');
  let inputSequence = 0, commandObservation=0, observedAt=-Infinity, cached=null, captureKey=''; const observedCommands=[];
  const observeInput = timestamp => {
    if (!Number.isFinite(timestamp)) throw new TypeError('input observation timestamp');
    if (!canObserveInput()) { cached=null;inputPreview?.clear?.();return null; }
    if(timestamp===observedAt && cached)return cached;
    const sampled=getInput(),packet=sampled&&typeof sampled==='object'&&!ArrayBuffer.isView(sampled)&&Object.hasOwn(sampled,'input');
    const input=packet?sampled.input:sampled,commands=packet?(sampled.commands??[]):[];
    if(!Array.isArray(commands))throw new TypeError('input packet commands');
    const held=observedCommands;
    if(held.length+commands.length>64)throw new RangeError('unsubmitted input command capacity');
    for(const command of commands){if(!command||command.payload===undefined)throw new TypeError('command payload required');held.push({observationId:++commandObservation,sequence:null,payload:command.payload.slice?.()??structuredClone(command.payload)});}
    cached={input:input.slice?.()??structuredClone(input),commands:held,predict:!packet||sampled.predict!==false||held.length>0,sequence:++inputSequence};observedAt=timestamp;
    if(inputPreview&&packet&&sampled.predict===false&&!held.length)inputPreview.cancelObservation?.(Math.max(timestamp,performance.now()));
    else if(inputPreview?.enabled!==false && inputPreview)try{inputPreview.observe(cached.input,{sequence:cached.sequence,tick:session.tick,epoch:session.epoch??0,
      timeMs:Math.max(timestamp,globalThis.performance?.now?.()??timestamp),commands:cached.commands});}catch(error){inputPreview.clear?.();onPreviewError(error);}
    return cached;
  };
  const resetTiming = (clearPreview = true) => { timingGeneration++; last = undefined; accumulator = 0; if (clearPreview) {cached=null;observedAt=-Infinity;inputPreview?.clear?.();} };
  const release = () => {
    try { onInputRelease(); session.releaseInput(); cached=null;observedAt=-Infinity;inputPreview?.clear?.(); }
    catch (error) { stop(); onError(error); }
  };
  const hidden = () => { if (globalThis.document?.hidden) { release(); resetTiming(); } };
  const stop = () => {
    generation++; running = false; if (handle !== undefined) cancelFrame?.(handle); handle = undefined;
    inputPreview?.clear?.();
    globalThis.removeEventListener?.('blur', release);
    globalThis.document?.removeEventListener('visibilitychange', hidden);
  };
  const pulse = timestamp => {
    const current = generation;
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError('frame timestamp');
      if (backlogPolicy === 'retain' && last !== undefined && timestamp < last) throw new RangeError('retained loop timestamp cannot regress');
      beforeFrame(timestamp);
      if (current !== generation) return;
      const timing = timingGeneration;
      if (last === undefined) last = timestamp;
      const elapsed = Math.max(0, timestamp - last);
      if (elapsed > maxBacklogMs) {
        accumulator = 0;
        last = timestamp;
        inputPreview?.clear?.();
        onBacklogDrop({ elapsedMs: elapsed, droppedTicks: Math.floor(elapsed / quantum), timestamp });
      } else {
        accumulator = backlogPolicy === 'retain' ? accumulator + elapsed :
          Math.min(accumulator + Math.min(250, elapsed), quantum * session.profile.maxCatchupSteps);
        last = timestamp;
      }
      if (!Number.isFinite(accumulator) || accumulator > Number.MAX_SAFE_INTEGER) throw new RangeError('loop backlog exceeds safe milliseconds');
      session.poll();
      if (current !== generation || timing !== timingGeneration) return;
      if(inputPreview&&!cached)observeInput(timestamp);
      let work = 0;
      while (!session.closed && !session.resimulating && work < session.profile.maxCatchupSteps) {
        // Scalar capability avoids allocating a complete metrics snapshot per pacing read.
        const pace = session.pace ?? session.metrics.pace;
        if (accumulator < quantum * pace) break;
        const allowed = canAdvance();
        if (current !== generation || timing !== timingGeneration) return;
        if (!allowed) { if (backlogPolicy === 'drop') accumulator = Math.min(accumulator, quantum); break; }
        const sampled = inputPreview ? (cached??observeInput(timestamp)) : getInput();
        if(!sampled)break;
        if (current !== generation || timing !== timingGeneration) return;
        const packet = sampled && typeof sampled === 'object' && !ArrayBuffer.isView(sampled) && !(sampled instanceof ArrayBuffer) && Object.hasOwn(sampled, 'input');
        const inputValue = packet ? sampled.input : sampled;
        const input = inputPreview && inputPreview.enabled !== false && ArrayBuffer.isView(inputValue) ? new inputValue.constructor(inputValue) : inputValue;
        if (packet) {
          const commands = sampled.commands ?? [];
          if (!Array.isArray(commands)) throw new TypeError('input packet commands must be an array');
          if (commands.length && typeof session.queueCommand !== 'function') throw new TypeError('session does not support queued input commands');
          for (const command of commands) {
            if (!command || command.payload === undefined) throw new TypeError('input command payload required');
            const payload = ArrayBuffer.isView(command.payload) ? new command.payload.constructor(command.payload) : command.payload;
            if(inputPreview&&command.sequence!==null&&command.sequence!==undefined)continue;
            const sequence = session.queueCommand(payload);
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('session command sequence');
            if(inputPreview)command.sequence=sequence;
          }
        }
        const previousTick = session.tick;
        const result = session.advance(input); work++;
        let submission;
        if(inputPreview){
          const metadata=session.localInputState,capture=metadata?.capture;
          const key=capture?`${metadata.epoch}:${metadata.baseTick}:${capture.sequence}`:'';
          if(capture && key!==captureKey){captureKey=key;submission={...capture,predict:cached?.predict!==false,boundaryTick:metadata.tick,epoch:metadata.epoch,timeMs:Math.max(timestamp,performance.now())};
            submission.commands=capture.commands.map(command=>({...command,observationId:cached?.commands.find(c=>c.sequence===command.sequence)?.observationId}));
            try{inputPreview.commit(submission,submission.timeMs)}catch(error){inputPreview.clear?.();onPreviewError(error)}
            const assigned=new Set(capture.commands.map(c=>c.sequence));for(let i=observedCommands.length-1;i>=0;i--)if(assigned.has(observedCommands[i].sequence))observedCommands.splice(i,1);
          }
        }
        // A completed tick still consumes debt after stop(), but never touches a reset/new run.
        if (timing !== timingGeneration) return;
        if (result.status === 'advanced') accumulator = Math.max(0, accumulator - quantum * pace);
        else if (backlogPolicy === 'drop') accumulator = Math.min(accumulator, quantum);
        if (current !== generation) return;
        onAdvance(result, submission);
        if (current !== generation || timing !== timingGeneration) return;
        if (result.status !== 'advanced') break;
      }
      // Rendering continues when the session is waiting for input or connection recovery.
      render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
    } catch (error) { if (current === generation) stop(); onError(error); }
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') throw new TypeError('frame scheduler');
    running = true; resetTiming(false);
    const current = ++generation;
    const frame = timestamp => {
      if (!running || current !== generation) return;
      if(inputPreview)observeInput(timestamp);
      pulse(timestamp);
      if (running && current === generation) handle = requestFrame(frame);
    };
    globalThis.addEventListener?.('blur', release);
    globalThis.document?.addEventListener('visibilitychange', hidden);
    handle = requestFrame(frame);
  };
  const flushInput = timestamp => { accumulator=Math.max(accumulator,quantum*(session.pace??1));pulse(timestamp); };
  return { start, stop, pulse, observeInput, flushInput, resetTiming, get running() { return running; } };
}

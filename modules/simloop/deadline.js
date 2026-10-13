/**
 * Owns a single timer for a monotonic, fixed-interval pulse cadence.
 * `due` is the number of regular deadlines represented by a pulse; wake pulses
 * use `due: 0` and do not move the regular deadline. Large gaps discard overdue
 * deadlines and resume with one pulse. Call `rebase()` after pause/resume or a
 * rate change; changing the interval callback alone does not move a deadline.
 *
 * @param {object} options
 * @param {() => number} options.getIntervalMs Positive finite interval; read on
 *   start/rebase. Rebase after changing its effective value.
 * @param {(timestampMs: number, info: {due: number, scheduledAtMs: number|null}) => void} options.pulse
 * @param {number} [options.maxBacklogTicks=8] Maximum regular ticks represented
 *   during a delayed pulse before overdue time is dropped.
 * @param {() => number} [options.now=performance.now] Monotonic millisecond clock.
 * @param {(callback: () => void, delayMs: number) => unknown} [options.setTimer=setTimeout]
 * @param {(handle: unknown) => void} [options.clearTimer=clearTimeout]
 * @param {(gap: {elapsedMs: number, droppedTicks: number, timestamp: number, scheduledAtMs: number}) => void} [options.onGap]
 * @returns {{start: () => void, stop: () => void, wake: () => void, rebase: (nowMs?: number) => void, readonly running: boolean, readonly deadlineMs: number|null}}
 *
 * This is a timer cadence helper, not a simulation accumulator or clock. Timer
 * delivery can be late; it provides no frame-rate or real-time guarantee.
 */
export function createDeadlineScheduler({
  getIntervalMs, getDeadlineMs,
  pulse,
  maxBacklogTicks = 8,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onGap,
} = {}) {
  if (getDeadlineMs !== undefined) {
    if(getIntervalMs!==undefined)throw new TypeError('choose getDeadlineMs or getIntervalMs');
    return ownedDeadline({getDeadlineMs,pulse,now,setTimer,clearTimer});
  }
  if (typeof getIntervalMs !== 'function') throw new TypeError('getIntervalMs must be a function');
  if (typeof pulse !== 'function') throw new TypeError('pulse must be a function');
  if (!Number.isSafeInteger(maxBacklogTicks) || maxBacklogTicks < 1) {
    throw new RangeError('maxBacklogTicks must be a positive safe integer');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof setTimer !== 'function') throw new TypeError('setTimer must be a function');
  if (typeof clearTimer !== 'function') throw new TypeError('clearTimer must be a function');
  if (onGap !== undefined && typeof onGap !== 'function') throw new TypeError('onGap must be a function');

  let active = false;
  let timerPending = false;
  let timerHandle;
  let generation = 0;
  let intervalMs;
  let deadline = null;
  let lastPulseAt = null;
  let lastNow = null;
  let dispatchingWake = false;

  const readNow = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new RangeError('now() must return a finite timestamp');
    if (lastNow !== null && value < lastNow) throw new RangeError('now() must be monotonic');
    lastNow = value;
    return value;
  };

  const readInterval = () => {
    const value = getIntervalMs();
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('getIntervalMs() must return a positive finite interval');
    }
    return value;
  };

  const clearPendingTimer = () => {
    if (!timerPending) return;
    timerPending = false;
    clearTimer(timerHandle);
    timerHandle = undefined;
  };

  let arm;
  const dispatchRegular = (token) => {
    if (!active || token !== generation) return;
    timerPending = false;
    timerHandle = undefined;

    const timestamp = readNow();
    if (timestamp < deadline) {
      arm(token);
      return;
    }
    const interval = intervalMs;
    const lateness = timestamp - deadline;
    if (!Number.isFinite(lateness)) throw new RangeError('clock gap is outside the supported range');
    const due = Math.floor(lateness / interval) + 1;
    const elapsedMs = lastPulseAt === null ? interval : timestamp - lastPulseAt;
    const maxGapMs = interval * maxBacklogTicks;

    if (elapsedMs > maxGapMs) {
      const droppedTicks = Math.max(0, due - 1);
      deadline = timestamp + interval;
      if (!Number.isFinite(deadline)) throw new RangeError('next deadline is outside the supported range');
      lastPulseAt = timestamp;
      onGap?.({ elapsedMs, droppedTicks, timestamp, scheduledAtMs: timestamp });
      if (!active || token !== generation) return;
      pulse(timestamp, { due: 1, scheduledAtMs: timestamp });
    } else {
      const scheduledAtMs = deadline;
      deadline += due * interval;
      if (!Number.isFinite(deadline)) throw new RangeError('next deadline is outside the supported range');
      lastPulseAt = timestamp;
      pulse(timestamp, { due, scheduledAtMs });
    }

    if (active && token === generation) arm(token);
  };

  arm = (token) => {
    if (!active || token !== generation || timerPending) return;
    const timestamp = readNow();
    const delay = Math.max(0, deadline - timestamp);
    timerPending = true;
    timerHandle = setTimer(() => dispatchRegular(token), delay);
  };

  const rebase = (timestampMs) => {
    const timestamp = timestampMs === undefined ? readNow() : timestampMs;
    if (!Number.isFinite(timestamp)) throw new RangeError('rebase timestamp must be finite');
    if (lastNow !== null && timestamp < lastNow) throw new RangeError('rebase timestamp must be monotonic');
    lastNow = timestamp;
    intervalMs = readInterval();
    deadline = timestamp + intervalMs;
    if (!Number.isFinite(deadline)) throw new RangeError('next deadline is outside the supported range');
    lastPulseAt = timestamp;
    generation += 1;
    clearPendingTimer();
    if (active) arm(generation);
  };

  const stop = () => {
    generation += 1;
    active = false;
    deadline = null;
    lastPulseAt = null;
    clearPendingTimer();
  };

  const start = () => {
    if (active) return;
    const timestamp = readNow();
    intervalMs = readInterval();
    deadline = timestamp + intervalMs;
    if (!Number.isFinite(deadline)) throw new RangeError('next deadline is outside the supported range');
    lastPulseAt = timestamp;
    active = true;
    generation += 1;
    arm(generation);
  };

  const wake = () => {
    if (!active || dispatchingWake) return;
    const timestamp = readNow();
    lastPulseAt = timestamp;
    dispatchingWake = true;
    try {
      pulse(timestamp, { due: 0, scheduledAtMs: null });
    } finally {
      dispatchingWake = false;
    }
  };

  return {
    start,
    stop,
    wake,
    rebase,
    get running() { return active; },
    get deadlineMs() { return deadline; },
  };
}

/** The loop owns elapsed time and backlog. This timer only wakes at its next deadline. */
function ownedDeadline({getDeadlineMs,pulse,now,setTimer,clearTimer}) {
  for(const callback of [getDeadlineMs,pulse,now,setTimer,clearTimer])if(typeof callback!=='function')throw new TypeError('deadline callback');
  let active=false,handle,generation=0,deadline=null,last=-Infinity,dispatching=false;
  const readNow=()=>{const t=now();if(!Number.isFinite(t)||t<last)throw new RangeError('now must be finite and monotonic');last=t;return t;};
  const clear=()=>{if(handle!==undefined)clearTimer(handle);handle=undefined;};
  const arm=()=>{if(!active)return;clear();const t=readNow(),next=getDeadlineMs();
    if(next!==null&&!Number.isFinite(next))throw new RangeError('deadline must be finite or null');
    deadline=next??t;const token=generation;
    handle=setTimer(()=>{if(!active||token!==generation)return;handle=undefined;const at=readNow();
      if(at<deadline){arm();return;}dispatching=true;
      try{pulse(at,{due:0,scheduledAtMs:deadline});}finally{dispatching=false;if(active&&token===generation)arm();}
    },Math.max(1,deadline-t));
  };
  return {start(){if(active)return;active=true;generation++;arm();},stop(){active=false;generation++;clear();deadline=null;},
    rebase(){generation++;if(active)arm();},wake(){if(!active||dispatching)return;dispatching=true;try{pulse(readNow(),{due:0,scheduledAtMs:null});}finally{dispatching=false;arm();}},
    get running(){return active;},get deadlineMs(){return deadline;}};
}

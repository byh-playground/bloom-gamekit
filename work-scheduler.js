// modules/work-scheduler/index.js
var PRIORITY_SLOTS = Object.freeze([2, 1, 2, 0, 2, 1, 2]);
function createBudgetedScheduler(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const {
    unitsPerTick: UNITS_PER_TICK = 24,
    quantumUnits: QUANTUM_UNITS = 1,
    now: NOW = () => performance.now()
  } = options;
  if (!Number.isSafeInteger(UNITS_PER_TICK) || UNITS_PER_TICK < 1) {
    throw new RangeError("unitsPerTick must be a positive safe integer");
  }
  if (!Number.isSafeInteger(QUANTUM_UNITS) || QUANTUM_UNITS < 1 || QUANTUM_UNITS > UNITS_PER_TICK) {
    throw new RangeError("quantumUnits must be a positive safe integer no greater than unitsPerTick");
  }
  if (typeof NOW !== "function") {
    throw new TypeError("now must be a function");
  }
  const QUEUES = Array.from({ length: 3 }, () => ({ head: null, tail: null, count: 0 })), BY_KEY = /* @__PURE__ */ new Map(), BY_OWNER = /* @__PURE__ */ new Map(), DEFERRED_PROMOTIONS = /* @__PURE__ */ new Set(), STEP_CONTEXT = { tickId: 0, key: null, maxUnits: 0 }, STATS = {
    ticks: 0,
    jobsQueued: 0,
    jobsMerged: 0,
    jobsCompleted: 0,
    jobsCancelled: 0,
    unitsProcessed: 0,
    waitedJobs: 0,
    waitingTicksTotal: 0,
    maxWaitTicks: 0,
    budgetExhaustions: 0,
    totalTickMs: 0,
    maxTickMs: 0,
    lastTickId: null,
    lastTickUnits: 0,
    lastTickCompleted: 0,
    lastTickWaitedJobs: 0,
    lastTickWaitingTicks: 0,
    lastTickMaxWaitTicks: 0,
    lastTickBudgetExhausted: false,
    lastTickMs: 0
  };
  let pendingHead = null;
  let pendingTail = null;
  let pendingCount = 0;
  let activeCount = 0;
  let queueCount = 0;
  let nextSequence = 1;
  let priorityCursor = 0;
  let lastTickId = null;
  let lastClock = null;
  let sequenceCutoff = 0;
  let eligibleRemaining = 0;
  let ticking = false;
  let disposed = false;
  function assertUsable() {
    if (disposed) {
      throw new Error("budgeted scheduler disposed");
    }
  }
  function readClock() {
    const VALUE = NOW();
    if (!Number.isFinite(VALUE) || lastClock !== null && VALUE < lastClock) {
      throw new RangeError("now() must return a finite monotonic timestamp");
    }
    lastClock = VALUE;
    return VALUE;
  }
  function appendActive(job) {
    const QUEUE = QUEUES[job.priority];
    job.pending = false;
    job.previous = QUEUE.tail;
    job.next = null;
    if (QUEUE.tail) {
      QUEUE.tail.next = job;
    } else {
      QUEUE.head = job;
    }
    QUEUE.tail = job;
    QUEUE.count++;
    activeCount++;
  }
  function removeActive(job) {
    const QUEUE = QUEUES[job.priority];
    if (job.previous) {
      job.previous.next = job.next;
    } else {
      QUEUE.head = job.next;
    }
    if (job.next) {
      job.next.previous = job.previous;
    } else {
      QUEUE.tail = job.previous;
    }
    job.previous = null;
    job.next = null;
    QUEUE.count--;
    activeCount--;
  }
  function appendPending(job) {
    job.pending = true;
    job.previous = pendingTail;
    job.next = null;
    if (pendingTail) {
      pendingTail.next = job;
    } else {
      pendingHead = job;
    }
    pendingTail = job;
    pendingCount++;
  }
  function removePending(job) {
    if (job.previous) {
      job.previous.next = job.next;
    } else {
      pendingHead = job.next;
    }
    if (job.next) {
      job.next.previous = job.previous;
    } else {
      pendingTail = job.previous;
    }
    job.previous = null;
    job.next = null;
    pendingCount--;
  }
  function addOwner(job) {
    if (job.owner === void 0) {
      return;
    }
    let ownerJobs = BY_OWNER.get(job.owner);
    if (!ownerJobs) {
      ownerJobs = /* @__PURE__ */ new Set();
      BY_OWNER.set(job.owner, ownerJobs);
    }
    ownerJobs.add(job);
  }
  function removeOwner(job) {
    if (job.owner === void 0) {
      return;
    }
    const OWNER_JOBS = BY_OWNER.get(job.owner);
    if (!OWNER_JOBS) {
      return;
    }
    OWNER_JOBS.delete(job);
    if (OWNER_JOBS.size === 0) {
      BY_OWNER.delete(job.owner);
    }
  }
  function retire(job, reason) {
    if (!job.active) {
      return false;
    }
    if (job.pending) {
      removePending(job);
    } else {
      removeActive(job);
      if (ticking && job.sequence <= sequenceCutoff) {
        eligibleRemaining--;
      }
    }
    job.active = false;
    queueCount--;
    BY_KEY.delete(job.key);
    removeOwner(job);
    DEFERRED_PROMOTIONS.delete(job);
    if (reason === "completed") {
      STATS.jobsCompleted++;
      STATS.lastTickCompleted++;
    } else {
      STATS.jobsCancelled++;
    }
    return true;
  }
  function promote(job, priority) {
    if (priority <= (job.pendingPriority ?? job.priority)) {
      return;
    }
    if (job.pending) {
      job.priority = priority;
      return;
    }
    if (ticking) {
      job.pendingPriority = Math.max(job.pendingPriority ?? job.priority, priority);
      DEFERRED_PROMOTIONS.add(job);
      return;
    }
    removeActive(job);
    job.priority = priority;
    appendActive(job);
  }
  function flushPending() {
    while (pendingHead) {
      const JOB = pendingHead;
      removePending(JOB);
      if (!JOB.active) {
        continue;
      }
      appendActive(JOB);
    }
  }
  function applyDeferredPromotions() {
    for (const JOB of DEFERRED_PROMOTIONS) {
      const PRIORITY = JOB.pendingPriority;
      JOB.pendingPriority = null;
      if (!JOB.active || PRIORITY === null || PRIORITY <= JOB.priority) {
        continue;
      }
      removeActive(JOB);
      JOB.priority = PRIORITY;
      appendActive(JOB);
    }
    DEFERRED_PROMOTIONS.clear();
  }
  function nextJob() {
    for (let attempt = 0; attempt < PRIORITY_SLOTS.length; attempt++) {
      const PRIORITY = PRIORITY_SLOTS[priorityCursor];
      priorityCursor = (priorityCursor + 1) % PRIORITY_SLOTS.length;
      const QUEUE = QUEUES[PRIORITY];
      if (!QUEUE.head) {
        continue;
      }
      const JOB = QUEUE.head;
      if (QUEUE.head !== QUEUE.tail) {
        QUEUE.head = JOB.next;
        QUEUE.head.previous = null;
        JOB.previous = QUEUE.tail;
        JOB.next = null;
        QUEUE.tail.next = JOB;
        QUEUE.tail = JOB;
      }
      return JOB;
    }
    return null;
  }
  function recordFirstService(job, tickId) {
    if (job.firstServed) {
      return;
    }
    const WAIT_TICKS = job.enqueuedAtTick === null ? 0 : Math.max(0, tickId - job.enqueuedAtTick);
    job.firstServed = true;
    STATS.waitedJobs++;
    STATS.waitingTicksTotal += WAIT_TICKS;
    STATS.maxWaitTicks = Math.max(STATS.maxWaitTicks, WAIT_TICKS);
    STATS.lastTickWaitedJobs++;
    STATS.lastTickWaitingTicks += WAIT_TICKS;
    STATS.lastTickMaxWaitTicks = Math.max(STATS.lastTickMaxWaitTicks, WAIT_TICKS);
  }
  function validateStepResult(job, value, maxUnits) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.done !== "boolean" || !Number.isSafeInteger(value.unitsUsed) || value.unitsUsed < 1 || value.unitsUsed > maxUnits) {
      retire(job, "cancelled");
      throw new TypeError("step() must return {done, unitsUsed} within its supplied maxUnits");
    }
    return value;
  }
  function isValid(job) {
    if (!job.isValid) {
      return true;
    }
    try {
      return job.isValid();
    } catch (error) {
      retire(job, "cancelled");
      throw error;
    }
  }
  function enqueue(request) {
    assertUsable();
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("request must be an object");
    }
    const {
      key: KEY,
      owner: OWNER,
      priority: PRIORITY = 1,
      step: STEP,
      isValid: IS_VALID,
      onComplete: ON_COMPLETE
    } = request;
    if (!(typeof KEY === "string" || typeof KEY === "number" && Number.isSafeInteger(KEY)) || typeof STEP !== "function") {
      throw new TypeError("key must be a string or safe integer and step must be a function");
    }
    if (!Number.isSafeInteger(PRIORITY) || PRIORITY < 0 || PRIORITY > 2) {
      throw new RangeError("priority must be 0, 1 or 2");
    }
    if (IS_VALID !== void 0 && typeof IS_VALID !== "function") {
      throw new TypeError("isValid must be a function");
    }
    if (ON_COMPLETE !== void 0 && typeof ON_COMPLETE !== "function") {
      throw new TypeError("onComplete must be a function");
    }
    const EXISTING = BY_KEY.get(KEY);
    if (EXISTING) {
      if (EXISTING.owner !== OWNER) {
        throw new Error("duplicate key must use the same owner");
      }
      STATS.jobsMerged++;
      promote(EXISTING, PRIORITY);
      return false;
    }
    const JOB = {
      key: KEY,
      owner: OWNER,
      priority: PRIORITY,
      step: STEP,
      isValid: IS_VALID,
      onComplete: ON_COMPLETE,
      sequence: nextSequence++,
      enqueuedAtTick: lastTickId,
      firstServed: false,
      active: true,
      pending: false,
      pendingPriority: null,
      previous: null,
      next: null
    };
    BY_KEY.set(KEY, JOB);
    addOwner(JOB);
    queueCount++;
    STATS.jobsQueued++;
    if (ticking) {
      appendPending(JOB);
    } else {
      appendActive(JOB);
    }
    return true;
  }
  function cancel(key) {
    if (disposed) {
      return false;
    }
    const JOB = BY_KEY.get(key);
    return JOB ? retire(JOB, "cancelled") : false;
  }
  function cancelOwner(owner) {
    if (disposed) {
      return 0;
    }
    const OWNER_JOBS = BY_OWNER.get(owner);
    if (!OWNER_JOBS) {
      return 0;
    }
    let cancelled = 0;
    for (const JOB of OWNER_JOBS) {
      if (retire(JOB, "cancelled")) {
        cancelled++;
      }
    }
    return cancelled;
  }
  function tick(tickId) {
    assertUsable();
    if (!Number.isSafeInteger(tickId) || tickId < 0 || lastTickId !== null && tickId <= lastTickId) {
      throw new RangeError("tickId must be a strictly increasing non-negative safe integer");
    }
    if (ticking) {
      throw new Error("tick() is not reentrant");
    }
    const STARTED_AT = readClock();
    ticking = true;
    lastTickId = tickId;
    sequenceCutoff = nextSequence - 1;
    eligibleRemaining = activeCount;
    STATS.ticks++;
    STATS.lastTickId = tickId;
    STATS.lastTickUnits = 0;
    STATS.lastTickCompleted = 0;
    STATS.lastTickWaitedJobs = 0;
    STATS.lastTickWaitingTicks = 0;
    STATS.lastTickMaxWaitTicks = 0;
    STATS.lastTickBudgetExhausted = false;
    try {
      while (STATS.lastTickUnits < UNITS_PER_TICK && eligibleRemaining > 0) {
        const JOB = nextJob();
        if (!JOB) {
          break;
        }
        const VALID = isValid(JOB);
        if (!JOB.active) {
          continue;
        }
        if (!VALID) {
          retire(JOB, "cancelled");
          continue;
        }
        const MAX_UNITS = Math.min(QUANTUM_UNITS, UNITS_PER_TICK - STATS.lastTickUnits);
        STEP_CONTEXT.tickId = tickId;
        STEP_CONTEXT.key = JOB.key;
        STEP_CONTEXT.maxUnits = MAX_UNITS;
        recordFirstService(JOB, tickId);
        let result;
        try {
          result = validateStepResult(JOB, JOB.step(STEP_CONTEXT), MAX_UNITS);
        } catch (error) {
          if (JOB.active) {
            retire(JOB, "cancelled");
          }
          throw error;
        }
        STATS.lastTickUnits += result.unitsUsed;
        STATS.unitsProcessed += result.unitsUsed;
        if (!JOB.active || !result.done) {
          continue;
        }
        const STILL_VALID = isValid(JOB);
        if (!JOB.active) {
          continue;
        }
        if (!STILL_VALID) {
          retire(JOB, "cancelled");
          continue;
        }
        retire(JOB, "completed");
        if (JOB.onComplete) {
          JOB.onComplete({ key: JOB.key, owner: JOB.owner, result: result.result });
        }
      }
      STATS.lastTickBudgetExhausted = STATS.lastTickUnits === UNITS_PER_TICK && eligibleRemaining > 0;
      if (STATS.lastTickBudgetExhausted) {
        STATS.budgetExhaustions++;
      }
      return STATS.lastTickUnits;
    } finally {
      try {
        const ELAPSED_MS = readClock() - STARTED_AT;
        STATS.lastTickMs = ELAPSED_MS;
        STATS.totalTickMs += ELAPSED_MS;
        STATS.maxTickMs = Math.max(STATS.maxTickMs, ELAPSED_MS);
      } finally {
        if (!disposed) {
          applyDeferredPromotions();
          flushPending();
        } else {
          DEFERRED_PROMOTIONS.clear();
        }
        STEP_CONTEXT.key = null;
        STEP_CONTEXT.maxUnits = 0;
        ticking = false;
      }
    }
  }
  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const JOB of BY_KEY.values()) {
      retire(JOB, "cancelled");
    }
    BY_OWNER.clear();
    DEFERRED_PROMOTIONS.clear();
    pendingHead = null;
    pendingTail = null;
    pendingCount = 0;
    activeCount = 0;
    queueCount = 0;
    for (const QUEUE of QUEUES) {
      QUEUE.head = null;
      QUEUE.tail = null;
      QUEUE.count = 0;
    }
    STEP_CONTEXT.key = null;
    STEP_CONTEXT.maxUnits = 0;
  }
  return {
    enqueue,
    cancel,
    cancelOwner,
    tick,
    dispose,
    get metrics() {
      const ACTIVE_BY_PRIORITY = QUEUES.map((queue) => queue.count);
      return Object.freeze({
        ticks: STATS.ticks,
        jobsQueued: STATS.jobsQueued,
        jobsMerged: STATS.jobsMerged,
        jobsCompleted: STATS.jobsCompleted,
        jobsCancelled: STATS.jobsCancelled,
        queueDepth: queueCount,
        activeJobs: activeCount,
        pendingJobs: pendingCount,
        activeByPriority: Object.freeze(ACTIVE_BY_PRIORITY),
        unitsProcessed: STATS.unitsProcessed,
        throughputUnitsPerTick: STATS.ticks ? STATS.unitsProcessed / STATS.ticks : 0,
        throughputUnitsPerSecond: STATS.totalTickMs > 0 ? STATS.unitsProcessed * 1e3 / STATS.totalTickMs : 0,
        waitedJobs: STATS.waitedJobs,
        waitingTicksTotal: STATS.waitingTicksTotal,
        averageWaitTicks: STATS.waitedJobs ? STATS.waitingTicksTotal / STATS.waitedJobs : 0,
        maxWaitTicks: STATS.maxWaitTicks,
        budgetExhaustions: STATS.budgetExhaustions,
        lastTickId: STATS.lastTickId,
        lastTickUnits: STATS.lastTickUnits,
        lastTickCompleted: STATS.lastTickCompleted,
        lastTickWaitedJobs: STATS.lastTickWaitedJobs,
        lastTickWaitingTicks: STATS.lastTickWaitingTicks,
        lastTickMaxWaitTicks: STATS.lastTickMaxWaitTicks,
        lastTickBudgetExhausted: STATS.lastTickBudgetExhausted,
        lastTickMs: STATS.lastTickMs,
        totalTickMs: STATS.totalTickMs,
        maxTickMs: STATS.maxTickMs
      });
    }
  };
}
export {
  createBudgetedScheduler
};

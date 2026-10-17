// modules/presentation-events/index.js
var INTEGER = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
};
var TIME = (value, name) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be nonnegative milliseconds`);
  }
  return value;
};
function presentationEventKey(event) {
  INTEGER(event.tick, "tick");
  INTEGER(event.sequence, "sequence");
  INTEGER(event.generation, "generation");
  if (typeof event.entityId !== "string" && typeof event.entityId !== "number" || typeof event.entityId === "number" && !Number.isSafeInteger(event.entityId)) {
    throw new TypeError("entityId must be string or safe integer");
  }
  if (typeof event.kind !== "string" || !event.kind) {
    throw new TypeError("kind required");
  }
  return JSON.stringify([event.tick, event.sequence, event.entityId, event.generation, event.kind]);
}
var PresentationEventQueue = class {
  constructor({ adapters, retentionTicks = 120, maxPending = 1e5, nowMs = 0 } = {}) {
    if (!adapters || typeof adapters !== "object") {
      throw new TypeError("adapters required");
    }
    INTEGER(retentionTicks, "retentionTicks");
    if (!retentionTicks) {
      throw new RangeError("retentionTicks must be positive");
    }
    INTEGER(maxPending, "maxPending");
    if (!maxPending) {
      throw new RangeError("maxPending must be positive");
    }
    this.adapters = new Map(Object.entries(adapters));
    for (const [KIND, ADAPTER] of this.adapters) {
      if (!KIND || typeof ADAPTER?.start !== "function") {
        throw new TypeError("adapter.start required");
      }
      if (ADAPTER.reversible === true && typeof ADAPTER.stop !== "function") {
        throw new TypeError("reversible adapter.stop required");
      }
      for (const KEY of ["stop", "update", "reconcile", "confirm"]) {
        if (ADAPTER[KEY] !== void 0 && typeof ADAPTER[KEY] !== "function") {
          throw new TypeError(`adapter.${KEY} must be function`);
        }
      }
    }
    this.retentionTicks = retentionTicks;
    this.maxPending = maxPending;
    this.nowMs = TIME(nowMs, "nowMs");
    this.confirmedTick = -1;
    this.records = /* @__PURE__ */ new Map();
    this.active = /* @__PURE__ */ new Set();
    this.awaitingConfirmation = /* @__PURE__ */ new Set();
    this.collectibleTicks = /* @__PURE__ */ new Map();
    this.rollbackFrom = null;
    this.disposed = false;
    this.confirmationDirty = false;
    this.stats = {
      started: 0,
      duplicates: 0,
      cancelled: 0,
      expired: 0,
      collected: 0,
      rejectedOld: 0
    };
  }
  _ready() {
    if (this.disposed) {
      throw new Error("event queue disposed");
    }
  }
  _start(record) {
    try {
      record.handle = record.adapter.start(record.event, this.nowMs);
    } catch (error) {
      if (record.confirmed) {
        this.confirmationDirty = true;
        this.awaitingConfirmation.add(record);
      }
      throw error;
    }
    record.startedMs = this.nowMs;
    record.state = "active";
    this.active.add(record);
    this.stats.started++;
    if (record.durationMs === 0) {
      this._stop(record, "expired");
      this.stats.expired++;
    }
  }
  _release(record) {
    if (!record.confirmed || record.state === "active" || record.state === "pending") {
      return;
    }
    const { tick: TICK } = record.event;
    if (!record.compacted) {
      const {
        sequence: SEQUENCE,
        entityId: ENTITY_ID,
        generation: GENERATION,
        kind: KIND,
        policy: POLICY
      } = record.event;
      record.event = {
        tick: TICK,
        sequence: SEQUENCE,
        entityId: ENTITY_ID,
        generation: GENERATION,
        kind: KIND,
        policy: POLICY
      };
      record.handle = void 0;
      record.compacted = true;
      if (TICK > this.confirmedTick - this.retentionTicks) {
        let bucket = this.collectibleTicks.get(TICK);
        if (!bucket) {
          this.collectibleTicks.set(TICK, bucket = []);
        }
        bucket.push(record);
      }
    }
    if (TICK <= this.confirmedTick - this.retentionTicks && this.records.delete(record.key)) {
      this.stats.collected++;
    }
  }
  _stop(record, reason) {
    if (record.state === "active") {
      record.state = reason;
      this.active.delete(record);
      try {
        record.adapter.stop?.(record.handle, reason, record.event);
      } finally {
        record.handle = void 0;
        this._release(record);
      }
    } else {
      record.state = reason;
      this._release(record);
    }
  }
  emit(event) {
    this._ready();
    const KEY = presentationEventKey(event), ADAPTER = this.adapters.get(event.kind);
    if (!ADAPTER) {
      throw new RangeError(`unknown presentation kind: ${event.kind}`);
    }
    const POLICY = event.policy ?? "confirmed";
    if (POLICY !== "confirmed" && POLICY !== "speculative") {
      throw new RangeError("policy must be confirmed or speculative");
    }
    if (POLICY === "speculative" && ADAPTER.reversible !== true) {
      throw new Error("speculation requires reversible resources; played one-shot sounds cannot be unplayed");
    }
    const DURATION_MS = event.durationMs === void 0 ? Infinity : TIME(event.durationMs, "durationMs");
    if (this.rollbackFrom !== null && event.tick < this.rollbackFrom) {
      throw new RangeError("resimulation event precedes rollback range");
    }
    if (event.tick <= this.confirmedTick - this.retentionTicks) {
      this.stats.rejectedOld++;
      return false;
    }
    let record = this.records.get(KEY);
    if (record) {
      if (record.policy !== POLICY) {
        throw new Error("event policy cannot change for a stable identity");
      }
      record.seen = true;
      this.stats.duplicates++;
      if (!record.confirmed) {
        const PREVIOUS = record.event;
        record.event = {
          ...event,
          policy: POLICY
        };
        record.durationMs = DURATION_MS;
        if (record.state === "cancelled") {
          record.state = "pending";
          if (POLICY === "speculative") {
            this._start(record);
          }
        } else if (record.state === "active") {
          ADAPTER.reconcile?.(record.handle, record.event, PREVIOUS, this.nowMs);
        } else if (record.state === "pending" && POLICY === "speculative") {
          this._start(record);
        }
      }
      if (record.confirmed && record.state === "pending") {
        this._start(record);
      }
      return false;
    }
    if (this.records.size >= this.maxPending) {
      throw new RangeError(
        "presentation journal capacity exceeded; confirm/collect or increase capacity explicitly"
      );
    }
    record = {
      key: KEY,
      event: {
        ...event,
        policy: POLICY
      },
      adapter: ADAPTER,
      policy: POLICY,
      durationMs: DURATION_MS,
      confirmed: event.tick <= this.confirmedTick,
      state: "pending",
      handle: void 0,
      startedMs: 0,
      seen: true,
      compacted: false
    };
    this.records.set(KEY, record);
    if (!record.confirmed) {
      this.awaitingConfirmation.add(record);
    }
    if (POLICY === "speculative" || record.confirmed) {
      this._start(record);
    }
    return true;
  }
  beginRollback(fromTick) {
    this._ready();
    INTEGER(fromTick, "fromTick");
    if (this.rollbackFrom !== null) {
      throw new Error("rollback already active");
    }
    if (fromTick <= this.confirmedTick) {
      throw new RangeError("cannot rollback confirmed presentation");
    }
    this.rollbackFrom = fromTick;
    for (const RECORD of this.awaitingConfirmation) {
      if (RECORD.event.tick >= fromTick && !RECORD.confirmed) {
        RECORD.seen = false;
      }
    }
  }
  endRollback() {
    this._ready();
    if (this.rollbackFrom === null) {
      throw new Error("no rollback active");
    }
    this.rollbackFrom = null;
    const ERRORS = [];
    for (const RECORD of this.awaitingConfirmation) {
      if (!RECORD.seen && !RECORD.confirmed && RECORD.state !== "cancelled") {
        try {
          this._stop(RECORD, "cancelled");
        } catch (error) {
          ERRORS.push(error);
        }
        this.stats.cancelled++;
      }
    }
    if (ERRORS.length) {
      throw new AggregateError(ERRORS, "rollback resource cleanup failed");
    }
  }
  confirmThrough(tick) {
    this._ready();
    INTEGER(tick, "tick");
    if (this.rollbackFrom !== null) {
      throw new Error("finish rollback before confirmation");
    }
    if (tick < this.confirmedTick) {
      throw new RangeError("confirmed tick cannot regress");
    }
    if (tick === this.confirmedTick && !this.confirmationDirty) {
      return;
    }
    this.confirmedTick = tick;
    this.confirmationDirty = true;
    for (const RECORD of this.awaitingConfirmation) {
      if (RECORD.event.tick <= tick) {
        const WAS_CONFIRMED = RECORD.confirmed;
        RECORD.confirmed = true;
        if (RECORD.state === "pending") {
          this._start(RECORD);
        }
        if (!WAS_CONFIRMED && RECORD.state === "active") {
          RECORD.adapter.confirm?.(RECORD.handle, RECORD.event);
        }
        this._release(RECORD);
        this.awaitingConfirmation.delete(RECORD);
      }
    }
    this.collect();
    this.confirmationDirty = false;
  }
  update(nowMs) {
    this._ready();
    TIME(nowMs, "nowMs");
    if (nowMs < this.nowMs) {
      throw new RangeError("presentation clock must be monotonic");
    }
    this.nowMs = nowMs;
    for (const RECORD of this.active) {
      const AGE_MS = nowMs - RECORD.startedMs;
      if (AGE_MS >= RECORD.durationMs) {
        this._stop(RECORD, "expired");
        this.stats.expired++;
      } else {
        RECORD.adapter.update?.(RECORD.handle, AGE_MS, RECORD.event);
      }
    }
  }
  /** Adapter reports a naturally completed audio/particle resource without discarding its dedup identity. */
  finish(event) {
    this._ready();
    const RECORD = this.records.get(presentationEventKey(event));
    if (!RECORD || RECORD.state !== "active") {
      return false;
    }
    this._stop(RECORD, "expired");
    this.stats.expired++;
    return true;
  }
  collect() {
    this._ready();
    const CUTOFF = this.confirmedTick - this.retentionTicks;
    for (const [TICK, BUCKET] of this.collectibleTicks) {
      if (TICK <= CUTOFF) {
        for (const RECORD of BUCKET) {
          if (this.records.delete(RECORD.key)) {
            this.stats.collected++;
          }
        }
        this.collectibleTicks.delete(TICK);
      }
    }
  }
  get size() {
    return this.records.size;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const ERRORS = [];
    for (const RECORD of this.records.values()) {
      try {
        this._stop(RECORD, "disposed");
      } catch (error) {
        ERRORS.push(error);
      }
    }
    this.records.clear();
    this.active.clear();
    this.awaitingConfirmation.clear();
    this.collectibleTicks.clear();
    this.rollbackFrom = null;
    if (ERRORS.length) {
      throw new AggregateError(ERRORS, "presentation cleanup failed");
    }
  }
};
export {
  PresentationEventQueue,
  presentationEventKey
};

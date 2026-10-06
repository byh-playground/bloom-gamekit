export class StateHistory {
  constructor(size, maxBytes = 64 * 1024 * 1024) { this.slots = new Array(size); this.size = size; this.maxBytes = maxBytes; this.byteLength = 0; }
  get(tick) { const s = this.slots[tick % this.size]; return s?.tick === tick ? s : undefined; }
  put(state) {
    const i = state.tick % this.size, next = this.byteLength - (this.slots[i]?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError('state history byte budget'),{code:'history-capacity',requiredBytes:next,maxHistoryBytes:this.maxBytes,snapshotBytes:state.bytes.length});
    this.slots[i] = state; this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (let i = 0; i < this.size; i++) if (this.slots[i]?.tick > tick) { this.byteLength -= this.slots[i].bytes.length; this.slots[i] = undefined; }
  }
}

// Lockstep retains only confirmed checksum boundaries, independently of the input
// receipt/ACK window. Keep the checkpoint at/before the window's oldest input so
// every retained recovery base still has a complete replay suffix.
export class CheckpointHistory {
  constructor(size, maxBytes) { this.size = size; this.maxBytes = maxBytes; this.records = new Map(); this.byteLength = 0; }
  get slots() { return this.records.values(); }
  get(tick) { return this.records.get(tick); }
  atOrBefore(tick) {
    let result;
    for (const state of this.records.values()) if (state.tick <= tick && (!result || state.tick > result.tick)) result = state;
    return result;
  }
  get oldestTick() { return Math.min(...this.records.keys()); }
  put(state) {
    const oldest = Math.max(0, state.tick - this.size + 1);
    const base = this.atOrBefore(oldest);
    const expired = [...this.records.values()].filter(s => base && s.tick < base.tick);
    const next = this.byteLength - expired.reduce((n, s) => n + s.bytes.length, 0)
      - (this.records.get(state.tick)?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError('checkpoint history byte budget'), { code: 'history-capacity', requiredBytes: next, maxHistoryBytes: this.maxBytes, snapshotBytes: state.bytes.length });
    for (const s of expired) this.records.delete(s.tick);
    this.records.set(state.tick, state); this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (const [t, state] of this.records) if (t > tick) { this.records.delete(t); this.byteLength -= state.bytes.length; }
  }
}

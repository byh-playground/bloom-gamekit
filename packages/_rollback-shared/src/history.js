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


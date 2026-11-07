// One simulation-time playhead for delayed presentation APIs. The caller validates
// packet order and the monotonic receipt clock; a plan is committed only after the
// complete incoming snapshot has passed validation.
export class BoundedPlayhead {
    constructor(stepMs, delayMs) {
        this.stepMs = stepMs;
        this.delayMs = delayMs;
        this.latest = -Infinity;
        this.time = 0;
        this.wall = 0;
        this.rate = 1;
        this.terminalEnd = null;
    }
    sample(nowMs) {
        if (!Number.isFinite(this.latest)) {
            return null;
        }
        if (this.rate === 0) {
            return this.time;
        }
        return Math.min(this.terminalEnd ?? this.latest, this.time + (nowMs - this.wall) * this.rate);
    }
    prepare(timeMs, nowMs, newEpoch, snap) {
        if (this.terminalEnd !== null && !newEpoch) {
            throw new Error('terminal presentation requires a new revision before capture');
        }
        let time = newEpoch ? (snap ? timeMs : timeMs - this.delayMs) : this.sample(nowMs);
        if (!newEpoch && this.rate > 0) {
            // Drop only display debt beyond the existing interpolation buffer and one tick.
            time = Math.max(time, timeMs - this.delayMs - this.stepMs);
        }
        return { latest: timeMs, time: Math.min(timeMs, time), wall: nowMs };
    }
    commit(plan) {
        this.latest = plan.latest;
        this.time = plan.time;
        this.wall = plan.wall;
        this.terminalEnd = null;
    }
    finish(tailMs, nowMs) {
        if (!Number.isFinite(this.latest)) {
            throw new Error('terminal presentation requires an authoritative snapshot');
        }
        if (this.terminalEnd !== null) {
            return false;
        }
        const END = this.latest + tailMs,
            DISPLAYED = this.sample(nowMs);
        if (!Number.isFinite(END)) {
            throw new RangeError('terminal presentation clock overflow');
        }
        this.time = DISPLAYED;
        this.wall = nowMs;
        this.terminalEnd = END;
        return true;
    }
    setRate(rate, nowMs) {
        const DISPLAYED = this.sample(nowMs);
        if (DISPLAYED !== null) {
            this.time = rate > 0 ? Math.max(DISPLAYED, this.latest - this.delayMs - this.stepMs) : DISPLAYED;
            this.wall = nowMs;
        }
        this.rate = rate;
    }
}

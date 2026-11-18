// One simulation-time playhead for delayed presentation APIs. The caller validates
// packet order and the monotonic receipt clock; a plan is committed only after the
// complete incoming snapshot has passed validation.
//
// 계약: 표시 시계는 프레임 읽기가 흘립니다. capture는 표본만 넣고 표시 시계를 밀지 않습니다.
// 표시가 최신 표본에 닿아 멈춰 있을 때(또는 첫 표본) 온 표본만 그 표본이 나온 시각에 붙입니다.
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
    // 표본을 넣을 시각. displayMs는 지금 표시 시계(마지막으로 읽은 프레임 시각), nowMs는 표본이 나온 시각
    // (틱 예정 시각·수신 시각, displayMs보다 과거가 아닌 값)입니다.
    //   - 표시가 최신 표본을 향해 흐르는 중: 표시 시계에 넣습니다. 표시 시각·자세·개체 이력이 모두 같은 시각을
    //     쓰고, 표본이 나온 시각이 다음 프레임 시각보다 뒤여도 표시는 프레임 시각이 늘어난 만큼만 흐릅니다.
    //   - 표시가 최신 표본에 닿아 멈춰 있거나 첫 표본: 표본이 나온 시각에 넣습니다(표시 시계도 그 시각으로 갑니다).
    //     이전 프레임 시각에 넣으면 표시가 표본 예정보다 최대 한 프레임 앞서 나중에 한 번 더 멈춥니다.
    captureAt(displayMs, nowMs) {
        if (!Number.isFinite(displayMs) || !Number.isFinite(this.latest)) {
            return nowMs;
        }
        return this.sample(displayMs) >= this.latest ? nowMs : displayMs;
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

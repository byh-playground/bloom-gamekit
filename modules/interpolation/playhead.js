// One simulation-time playhead for delayed presentation APIs. The caller validates
// packet order; a plan is committed only after the complete incoming snapshot has passed validation.
//
// 시각은 둘입니다. 둘 다 호출자가 넘긴 값이고, 뒤로 가지 않게 보정된 뒤 들어옵니다.
//   - 표시 시계(displayMs): 마지막으로 읽은 프레임 시각. 표시 시각은 이 시계가 늘어난 만큼만 흐릅니다.
//   - 표본이 나온 시각(nowMs): 틱 예정 시각·수신 시각. 프레임 사이에 나온 표본은 표시 시계보다 뒤입니다.
// 표본은 자기가 나온 시각부터 유효합니다. 표시 시계가 아직 그 시각에 닿지 않았으면 표본을 대기열에 두고,
// 그 전 시각을 읽는 프레임에는 이전 표본까지만 보여 줍니다. 표시가 이전 표본에 닿아 멈춰 있었다면 새 표본이
// 나온 시각부터 다시 흐르고(표본 예정보다 앞서지 않습니다), 닿지 않았다면 흐르던 그대로 이어집니다.
// 표본 시각을 표시 시계에 섞지 않으므로, 표본보다 오래된 프레임 시각(RAF timestamp)이 와도 표시가 튀지 않습니다.

// 대기열 칸 수. 프레임이 한 번 읽히면 비워지므로 프레임 없이 표본만 이어질 때(숨은 탭)만 찹니다.
// 차면 가장 오래된 표본을 바로 적용합니다(그보다 오래된 프레임 시각은 더 오지 않습니다).
const PENDING_CAPACITY = 32;

export class BoundedPlayhead {
    constructor(stepMs, delayMs) {
        this.stepMs = stepMs;
        this.delayMs = delayMs;
        this.latest = -Infinity;
        this.time = 0;
        this.wall = 0;
        this.rate = 1;
        this.terminalEnd = null;
        this.pendingAt = new Float64Array(PENDING_CAPACITY);
        this.pendingLatest = new Float64Array(PENDING_CAPACITY);
        this.pendingHead = 0;
        this.pendingCount = 0;
    }
    // 새 표본(latest)이 유효해지는 순간의 표시 시각: 그때까지 흐른 값(displayed)에서 표시 부채 하한만 적용합니다.
    #arrive(displayed, latest) {
        if (this.rate > 0) {
            // Drop only display debt beyond the existing interpolation buffer and one tick.
            displayed = Math.max(displayed, latest - this.delayMs - this.stepMs);
        }
        return Math.min(latest, displayed);
    }
    #flow(time, wall, latest, nowMs) {
        return this.rate === 0 ? time : Math.min(latest, time + (nowMs - wall) * this.rate);
    }
    sample(nowMs) {
        if (!Number.isFinite(this.latest)) {
            return null;
        }
        let time = this.time,
            wall = this.wall,
            latest = this.latest;
        for (let i = 0; i < this.pendingCount; i++) {
            const INDEX = (this.pendingHead + i) % PENDING_CAPACITY,
                AT = this.pendingAt[INDEX];
            if (AT > nowMs) {
                break;
            }
            time = this.#arrive(this.#flow(time, wall, latest, AT), this.pendingLatest[INDEX]);
            wall = AT;
            latest = this.pendingLatest[INDEX];
        }
        return this.#flow(time, wall, this.terminalEnd ?? latest, nowMs);
    }
    // 대기 중인 표본 가운데 nowMs까지 유효해진 것을 적용합니다. nowMs 이전 시각은 더 읽지 않을 때만 부릅니다.
    // limitMs를 주면 그보다 뒤에 나올 표본도 limitMs에 나온 것으로 적용합니다(대기열 비우기).
    #settle(nowMs, limitMs = Infinity) {
        while (this.pendingCount) {
            const AT = Math.min(limitMs, this.pendingAt[this.pendingHead]);
            if (AT > nowMs) {
                return;
            }
            const LATEST = this.pendingLatest[this.pendingHead];
            this.time = this.#arrive(this.#flow(this.time, this.wall, this.latest, AT), LATEST);
            this.wall = AT;
            this.latest = LATEST;
            this.pendingHead = (this.pendingHead + 1) % PENDING_CAPACITY;
            this.pendingCount--;
        }
    }
    // 돌려주는 time은 이 표본이 유효해지는 순간(wall)의 표시 시각, clock은 이 표본을 받은 뒤의 표시 시계입니다.
    // 새 epoch(reset·load·rollback·첫 표본)는 화면을 바로 바꾸므로 표시 시계를 표본이 나온 시각으로 옮깁니다.
    prepare(timeMs, nowMs, newEpoch, snap, displayMs = nowMs) {
        if (this.terminalEnd !== null && !newEpoch) {
            throw new Error('terminal presentation requires a new revision before capture');
        }
        if (newEpoch) {
            return {
                epoch: true,
                latest: timeMs,
                time: snap ? timeMs : timeMs - this.delayMs,
                wall: nowMs,
                clock: nowMs,
            };
        }
        // 대기열은 나온 순서대로 유효해집니다.
        const WALL = this.pendingCount
            ? Math.max(nowMs, this.pendingAt[(this.pendingHead + this.pendingCount - 1) % PENDING_CAPACITY])
            : nowMs;
        return {
            epoch: false,
            latest: timeMs,
            time: this.#arrive(this.sample(WALL), timeMs),
            wall: WALL,
            clock: displayMs,
        };
    }
    commit(plan) {
        this.terminalEnd = null;
        if (plan.epoch) {
            this.pendingCount = 0;
            this.latest = plan.latest;
            this.time = plan.time;
            this.wall = plan.wall;
            return;
        }
        this.#settle(plan.clock);
        if (!this.pendingCount && plan.wall <= plan.clock) {
            this.latest = plan.latest;
            this.time = plan.time;
            this.wall = plan.wall;
            return;
        }
        if (this.pendingCount === PENDING_CAPACITY) {
            this.#settle(this.pendingAt[this.pendingHead]);
        }
        const INDEX = (this.pendingHead + this.pendingCount) % PENDING_CAPACITY;
        this.pendingAt[INDEX] = plan.wall;
        this.pendingLatest[INDEX] = plan.latest;
        this.pendingCount++;
    }
    finish(tailMs, nowMs) {
        if (!Number.isFinite(this.latest)) {
            throw new Error('terminal presentation requires an authoritative snapshot');
        }
        if (this.terminalEnd !== null) {
            return false;
        }
        // 권위가 끝났으므로 대기 중인 표본도 지금 유효한 것으로 봅니다.
        this.#settle(nowMs, nowMs);
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
        // 이전 rate로 nowMs까지 유효해진 표본을 먼저 적용합니다.
        this.#settle(nowMs);
        const DISPLAYED = this.sample(nowMs);
        if (DISPLAYED !== null) {
            this.time = rate > 0 ? Math.max(DISPLAYED, this.latest - this.delayMs - this.stepMs) : DISPLAYED;
            this.wall = nowMs;
        }
        this.rate = rate;
    }
}

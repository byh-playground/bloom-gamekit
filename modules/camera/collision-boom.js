const NONNEGATIVE = (value, name) => {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be finite`);
    }
    if (value < 0) {
        throw new RangeError(`${name} must be nonnegative`);
    }
    return value;
};

/**
 * 충돌 probe가 제공한 거리 안에서만 카메라 boom을 복원하는 표현 컨트롤러.
 * 방향·pivot·충돌 쿼리·카메라 반경과 여유 거리는 호출자가 소유합니다.
 * 거리 단위는 호출자 좌표계, 시간 단위는 ms입니다.
 */
export class CollisionBoom {
    constructor({ distance = 0, holdMs = 120, releaseHalfLifeMs = 180 } = {}) {
        this._holdMs = NONNEGATIVE(holdMs, 'holdMs');
        this._releaseHalfLifeMs = NONNEGATIVE(releaseHalfLifeMs, 'releaseHalfLifeMs');
        this.reset(distance);
    }
    get distance() {
        return this._distance;
    }

    /** 순간이동·재시작 시 과거 hold를 버립니다. 다음 update 전 안전성은 호출자 책임입니다. */
    reset(distance = 0) {
        this._distance = NONNEGATIVE(distance, 'distance');
        this._holdRemainingMs = 0;
        return this;
    }

    /**
     * @param {number} desiredDistance 장애물이 없을 때 원하는 유한한 비음수 거리.
     * @param {number} clearDistance 현재 pivot/방향의 probe로 확인한 최대 안전 거리.
     *   충돌이 없으면 desiredDistance를 전달합니다. 반경·여유 거리는 이미 반영해야 합니다.
     * @param {number} elapsedMs 이전 update 이후 경과한 유한한 비음수 표현 시간.
     * @returns {number} min(desiredDistance, clearDistance)를 넘지 않는 현재 거리.
     * 축소는 elapsedMs=0이어도 즉시 적용합니다. 최근접 장애물의 재관측은 hold를
     * 갱신하며, hold를 지난 나머지 시간만 반감기 복원에 사용합니다. 0ms에는 늘어나지
     * 않습니다. releaseHalfLifeMs=0은 hold 후 양수 시간이 흐르면 즉시 복원합니다.
     * 반환 거리를 적용한 뒤 별도 위치 보간으로 안전 한계를 넘기지 마세요.
     */
    update(desiredDistance, clearDistance, elapsedMs) {
        NONNEGATIVE(desiredDistance, 'desiredDistance');
        NONNEGATIVE(clearDistance, 'clearDistance');
        NONNEGATIVE(elapsedMs, 'elapsedMs');
        const TARGET = Math.min(desiredDistance, clearDistance);
        if (TARGET < this._distance || (TARGET === this._distance && clearDistance < desiredDistance)) {
            this._distance = TARGET;
            this._holdRemainingMs = this._holdMs;
            return this._distance;
        }
        const RELEASE_MS = Math.max(0, elapsedMs - this._holdRemainingMs);
        this._holdRemainingMs = Math.max(0, this._holdRemainingMs - elapsedMs);
        if (RELEASE_MS > 0) {
            const ALPHA =
                this._releaseHalfLifeMs === 0 ? 1 : -Math.expm1((-Math.LN2 * RELEASE_MS) / this._releaseHalfLifeMs);
            this._distance = Math.min(TARGET, this._distance + (TARGET - this._distance) * ALPHA);
        }
        return this._distance;
    }
}

import { integer } from './utilities.js';

const UINT32_RANGE = 0x100000000;
const MIN_POSITIVE_PROBABILITY = 0.0001;
const TAIL_CUTOFF = 1e-16;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const COEFFICIENT_CACHE = new Map([
    [0, 0],
    [1, 1],
]);

function validateProbability(probability) {
    if (
        typeof probability !== 'number' ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1 ||
        (probability > 0 && probability < MIN_POSITIVE_PROBABILITY)
    ) {
        throw new RangeError('probability must be 0 or between 0.0001 and 1');
    }
    return probability;
}

function meanWait(coefficient) {
    let survival = 1;
    let mean = 1;
    for (let failures = 1; survival > TAIL_CUTOFF; failures++) {
        const HAZARD = Math.min(1, failures * coefficient);
        if (HAZARD === 1) {
            break;
        }
        survival *= 1 - HAZARD;
        mean += survival;
    }
    return mean;
}

function coefficientFor(probability) {
    if (COEFFICIENT_CACHE.has(probability)) {
        return COEFFICIENT_CACHE.get(probability);
    }

    const TARGET_MEAN = 1 / probability;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 64; iteration++) {
        const MID = (low + high) / 2;
        if (meanWait(MID) > TARGET_MEAN) {
            low = MID;
        } else {
            high = MID;
        }
    }
    const COEFFICIENT = (low + high) / 2;
    COEFFICIENT_CACHE.set(probability, COEFFICIENT);
    return COEFFICIENT;
}

function createWaitDistribution(coefficient, failures) {
    const MAX_WAIT = Math.max(1, Math.ceil(1 / coefficient) - failures);
    const THRESHOLDS = [];
    const WAITS = [];
    let survival = 1;
    let cumulative = 0;
    let previousThreshold = 0;
    let terminalWait = 0;

    for (let wait = 1; wait <= MAX_WAIT; wait++) {
        const HAZARD = Math.min(1, (failures + wait) * coefficient);
        cumulative += survival * HAZARD;
        survival *= 1 - HAZARD;
        const THRESHOLD = Math.ceil(cumulative * UINT32_RANGE);
        if (THRESHOLD > previousThreshold && THRESHOLD < UINT32_RANGE) {
            THRESHOLDS.push(THRESHOLD);
            WAITS.push(wait);
        }
        if (THRESHOLD >= UINT32_RANGE || HAZARD === 1) {
            terminalWait = wait;
            break;
        }
        previousThreshold = THRESHOLD;
    }

    if (terminalWait === 0) {
        throw new RangeError('probability distribution exceeds the supported counter range');
    }
    return {
        thresholds: new Uint32Array(THRESHOLDS),
        waits: new Uint32Array(WAITS),
        terminalWait,
    };
}

function sampleWait(distribution, rng) {
    const RANDOM = integer(rng.nextUint32(), 'rng.nextUint32', 0, 0xffffffff);
    let low = 0;
    let high = distribution.thresholds.length;
    while (low < high) {
        const MID = Math.floor((low + high) / 2);
        if (RANDOM < distribution.thresholds[MID]) {
            high = MID;
        } else {
            low = MID + 1;
        }
    }
    return low < distribution.waits.length ? distribution.waits[low] : distribution.terminalWait;
}

/**
 * 호출자가 소유한 결정론적 uint32 난수 스트림에 연결하는 상태형 PRD입니다.
 * 설정 확률은 장기 평균 성공률입니다. 새 인스턴스는 실패 이력 0으로 시작하므로
 * 첫 시도의 확률은 C입니다.
 */
export class PseudoRandomDistribution {
    #coefficient = 0;
    #distribution = null;
    #failures = 0;
    #pendingTrials = 0;
    #probability = 0;
    #rng;
    #closed = false;

    /**
     * @param {{ probability: number; rng: { nextUint32(): number } }} options 확률은 0 또는 0.0001~1이어야 합니다.
     */
    constructor(options) {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('options must be an object');
        }
        const RNG = options.rng;
        if (!RNG || typeof RNG.nextUint32 !== 'function') {
            throw new TypeError('rng.nextUint32 must be a function');
        }
        this.#rng = RNG;
        this.#configureProbability(options.probability);
    }

    get probability() {
        this.#assertOpen();
        return this.#probability;
    }

    get consecutiveFailures() {
        this.#assertOpen();
        return this.#failures;
    }

    /** 성공하면 true를 반환합니다. */
    roll() {
        return this.rollMany(1) === 1;
    }

    /**
     * 성공 사이의 실패 간격을 건너뛰며 배치의 성공 횟수를 계산합니다.
     * 처리량은 실제 표본 성공 횟수와 누적분포 조회 비용에 비례합니다.
     */
    rollMany(draws) {
        this.#assertOpen();
        integer(draws, 'draws', 0, MAX_SAFE_INTEGER);
        if (draws === 0) {
            return 0;
        }
        if (this.#probability === 0) {
            this.#addFailures(draws);
            return 0;
        }
        if (this.#probability === 1) {
            this.#failures = 0;
            this.#pendingTrials = 0;
            return draws;
        }

        let remaining = draws;
        let successes = 0;
        while (remaining > 0) {
            if (this.#pendingTrials === 0) {
                this.#pendingTrials = this.#sampleNextSuccessWait();
            }
            if (this.#pendingTrials > remaining) {
                this.#pendingTrials -= remaining;
                this.#addFailures(remaining);
                break;
            }
            remaining -= this.#pendingTrials;
            this.#pendingTrials = 0;
            this.#failures = 0;
            successes++;
        }
        return successes;
    }

    /**
     * 실패 이력을 지우지 않고 장기 평균 확률을 변경합니다.
     * 이전 확률에서 뽑아 둔 대기는 버리고 다음 추첨 때 보존된 실패 횟수에
     * 조건부인 새 대기를 표본화합니다.
     */
    setProbability(probability) {
        this.#assertOpen();
        const NEXT_PROBABILITY = validateProbability(probability);
        if (NEXT_PROBABILITY === this.#probability) {
            return;
        }
        this.#configureProbability(NEXT_PROBABILITY);
        this.#pendingTrials = 0;
    }

    /** PRD 상태를 저장합니다. 호출자가 소유한 RNG 상태는 별도로 저장해야 합니다. */
    capture() {
        this.#assertOpen();
        return Object.freeze({
            version: 1,
            probability: this.#probability,
            consecutiveFailures: this.#failures,
            pendingTrials: this.#pendingTrials,
        });
    }

    /** 저장한 PRD 상태를 복원합니다. RNG 스트림은 호출자가 별도로 복원해야 합니다. */
    restore(state) {
        this.#assertOpen();
        const STATE_KEYS = ['version', 'probability', 'consecutiveFailures', 'pendingTrials'];
        if (
            !state ||
            typeof state !== 'object' ||
            Array.isArray(state) ||
            Object.keys(state).length !== STATE_KEYS.length ||
            !STATE_KEYS.every((key) => Object.hasOwn(state, key))
        ) {
            throw new TypeError('state must be a captured pseudo-random distribution state');
        }
        if (state.version !== 1) {
            throw new RangeError('unsupported pseudo-random distribution state version');
        }
        const PROBABILITY = validateProbability(state.probability);
        const FAILURES = integer(state.consecutiveFailures, 'consecutiveFailures', 0, MAX_SAFE_INTEGER);
        const PENDING_TRIALS = integer(state.pendingTrials, 'pendingTrials', 0, MAX_SAFE_INTEGER);
        const COEFFICIENT = coefficientFor(PROBABILITY);
        if (
            ((PROBABILITY === 0 || PROBABILITY === 1) && PENDING_TRIALS !== 0) ||
            (PENDING_TRIALS > 0 && FAILURES === 0) ||
            (PROBABILITY > 0 && PROBABILITY < 1 && PENDING_TRIALS > Math.max(1, Math.ceil(1 / COEFFICIENT) - FAILURES))
        ) {
            throw new RangeError('state contains an invalid pending wait');
        }
        const DISTRIBUTION = PROBABILITY > 0 && PROBABILITY < 1 ? createWaitDistribution(COEFFICIENT, 0) : null;
        this.#probability = PROBABILITY;
        this.#coefficient = COEFFICIENT;
        this.#distribution = DISTRIBUTION;
        this.#failures = FAILURES;
        this.#pendingTrials = PENDING_TRIALS;
    }

    /** 난수 스트림을 되감지 않고 실패 이력과 표본 대기를 지웁니다. */
    reset() {
        this.#assertOpen();
        this.#failures = 0;
        this.#pendingTrials = 0;
    }

    /** 인스턴스가 보유한 참조를 해제합니다. 여러 번 호출해도 안전합니다. */
    dispose() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#rng = null;
        this.#distribution = null;
        this.#pendingTrials = 0;
        this.#failures = 0;
    }

    #configureProbability(probability) {
        const NEXT_PROBABILITY = validateProbability(probability);
        const COEFFICIENT = coefficientFor(NEXT_PROBABILITY);
        const DISTRIBUTION =
            NEXT_PROBABILITY > 0 && NEXT_PROBABILITY < 1 ? createWaitDistribution(COEFFICIENT, 0) : null;
        this.#probability = NEXT_PROBABILITY;
        this.#coefficient = COEFFICIENT;
        this.#distribution = DISTRIBUTION;
    }

    #sampleNextSuccessWait() {
        if (this.#failures * this.#coefficient >= 1) {
            return 1;
        }
        const DISTRIBUTION =
            this.#failures === 0 ? this.#distribution : createWaitDistribution(this.#coefficient, this.#failures);
        return sampleWait(DISTRIBUTION, this.#rng);
    }

    #addFailures(count) {
        if (count > MAX_SAFE_INTEGER - this.#failures) {
            throw new RangeError('consecutiveFailures exceeds the safe integer range');
        }
        this.#failures += count;
    }

    #assertOpen() {
        if (this.#closed) {
            throw new Error('PseudoRandomDistribution is disposed');
        }
    }
}

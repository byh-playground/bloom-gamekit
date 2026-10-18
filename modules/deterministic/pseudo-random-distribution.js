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

function captureRandomState(rng) {
    const STATE_DESCRIPTOR = Object.getOwnPropertyDescriptor(rng, 'state');
    if (!STATE_DESCRIPTOR || !Object.hasOwn(STATE_DESCRIPTOR, 'value') || !STATE_DESCRIPTOR.writable) {
        throw new TypeError('resumable jobs require rng.state to be a writable own property');
    }
    return integer(STATE_DESCRIPTOR.value, 'rng.state', 0, 0xffffffff);
}

function parseDistributionState(state) {
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
    const CONDITIONED_DISTRIBUTION =
        PROBABILITY > 0 && PROBABILITY < 1 && FAILURES > 0 && PENDING_TRIALS === 0
            ? createWaitDistribution(COEFFICIENT, FAILURES)
            : null;
    return {
        probability: PROBABILITY,
        coefficient: COEFFICIENT,
        distribution: DISTRIBUTION,
        conditionedDistribution: CONDITIONED_DISTRIBUTION,
        failures: FAILURES,
        pendingTrials: PENDING_TRIALS,
    };
}

/**
 * 호출자가 소유한 결정론적 uint32 난수 스트림에 연결하는 상태형 PRD입니다.
 * 설정 확률은 장기 평균 성공률입니다. 새 인스턴스는 실패 이력 0으로 시작하므로
 * 첫 시도의 확률은 C입니다.
 */
export class PseudoRandomDistribution {
    #coefficient = 0;
    #distribution = null;
    #conditionedDistribution = null;
    #failures = 0;
    #pendingTrials = 0;
    #probability = 0;
    #rng;
    #closed = false;
    #activeJob = null;

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
        this.#assertNoActiveJob();
        integer(draws, 'draws', 0, MAX_SAFE_INTEGER);
        return this.#consumeTrials(draws, MAX_SAFE_INTEGER);
    }

    /** 성공 건수만 집계하고 고정 작업 단위로 진행할 수 있는 batch job을 만듭니다. */
    createRollJob(draws) {
        this.#assertOpen();
        this.#assertNoActiveJob();
        integer(draws, 'draws', 0, MAX_SAFE_INTEGER);
        captureRandomState(this.#rng);
        return this.#createRollJobCursor({
            totalTrials: draws,
            processedTrials: 0,
            remainingTrials: draws,
            successes: 0,
        });
    }

    /** snapshot의 PRD 상태, 난수 진행, 추첨 cursor와 성공 누계를 함께 복원합니다. */
    restoreRollJob(state) {
        this.#assertOpen();
        this.#assertNoActiveJob();
        const STATE_KEYS = [
            'version',
            'totalTrials',
            'processedTrials',
            'remainingTrials',
            'successes',
            'distributionState',
            'rngState',
        ];
        if (
            !state ||
            typeof state !== 'object' ||
            Array.isArray(state) ||
            Object.keys(state).length !== STATE_KEYS.length ||
            !STATE_KEYS.every((key) => Object.hasOwn(state, key))
        ) {
            throw new TypeError('state must be a captured pseudo-random distribution job state');
        }
        if (state.version !== 1) {
            throw new RangeError('unsupported pseudo-random distribution job state version');
        }
        const TOTAL_TRIALS = integer(state.totalTrials, 'totalTrials', 0, MAX_SAFE_INTEGER);
        const PROCESSED_TRIALS = integer(state.processedTrials, 'processedTrials', 0, TOTAL_TRIALS);
        const REMAINING_TRIALS = integer(state.remainingTrials, 'remainingTrials', 0, TOTAL_TRIALS);
        const SUCCESSES = integer(state.successes, 'successes', 0, PROCESSED_TRIALS);
        if (REMAINING_TRIALS !== TOTAL_TRIALS - PROCESSED_TRIALS) {
            throw new RangeError('job state has inconsistent trial counters');
        }
        const DISTRIBUTION_STATE = parseDistributionState(state.distributionState);
        const RNG_STATE = integer(state.rngState, 'rngState', 0, 0xffffffff);
        captureRandomState(this.#rng);

        this.#rng.state = RNG_STATE;
        this.#applyDistributionState(DISTRIBUTION_STATE);
        return this.#createRollJobCursor({
            totalTrials: TOTAL_TRIALS,
            processedTrials: PROCESSED_TRIALS,
            remainingTrials: REMAINING_TRIALS,
            successes: SUCCESSES,
        });
    }

    /**
     * 실패 이력을 지우지 않고 장기 평균 확률을 변경합니다.
     * 이전 확률에서 뽑아 둔 대기는 버리고 다음 추첨 때 보존된 실패 횟수에
     * 조건부인 새 대기를 표본화합니다.
     */
    setProbability(probability) {
        this.#assertOpen();
        this.#assertNoActiveJob();
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
        this.#assertNoActiveJob();
        return this.#captureState();
    }

    /** 저장한 PRD 상태를 복원합니다. RNG 스트림은 호출자가 별도로 복원해야 합니다. */
    restore(state) {
        this.#assertOpen();
        this.#assertNoActiveJob();
        this.#applyDistributionState(parseDistributionState(state));
    }

    /** 난수 스트림을 되감지 않고 실패 이력과 표본 대기를 지웁니다. */
    reset() {
        this.#assertOpen();
        this.#assertNoActiveJob();
        this.#failures = 0;
        this.#pendingTrials = 0;
        this.#conditionedDistribution = null;
    }

    /** 인스턴스가 보유한 참조를 해제합니다. 여러 번 호출해도 안전합니다. */
    dispose() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#activeJob = null;
        this.#rng = null;
        this.#distribution = null;
        this.#conditionedDistribution = null;
        this.#pendingTrials = 0;
        this.#failures = 0;
    }

    #configureProbability(probability) {
        const NEXT_PROBABILITY = validateProbability(probability);
        const COEFFICIENT = coefficientFor(NEXT_PROBABILITY);
        const DISTRIBUTION =
            NEXT_PROBABILITY > 0 && NEXT_PROBABILITY < 1 ? createWaitDistribution(COEFFICIENT, 0) : null;
        const CONDITIONED_DISTRIBUTION =
            NEXT_PROBABILITY > 0 && NEXT_PROBABILITY < 1 && this.#failures > 0
                ? createWaitDistribution(COEFFICIENT, this.#failures)
                : null;
        this.#probability = NEXT_PROBABILITY;
        this.#coefficient = COEFFICIENT;
        this.#distribution = DISTRIBUTION;
        this.#conditionedDistribution = CONDITIONED_DISTRIBUTION;
    }

    #sampleNextSuccessWait() {
        if (this.#failures * this.#coefficient >= 1) {
            return 1;
        }
        const DISTRIBUTION = this.#failures === 0 ? this.#distribution : this.#conditionedDistribution;
        if (!DISTRIBUTION) {
            throw new Error('conditioned wait distribution is unavailable');
        }
        const WAIT = sampleWait(DISTRIBUTION, this.#rng);
        if (this.#failures > 0) {
            this.#conditionedDistribution = null;
        }
        return WAIT;
    }

    #consumeTrials(draws, maxIntervals, includeProgress = false) {
        if (draws === 0) {
            return includeProgress ? { trialsConsumed: 0, successes: 0, unitsUsed: 0 } : 0;
        }
        if (this.#probability === 0) {
            this.#addFailures(draws);
            return includeProgress ? { trialsConsumed: draws, successes: 0, unitsUsed: 1 } : 0;
        }
        if (this.#probability === 1) {
            this.#failures = 0;
            this.#pendingTrials = 0;
            this.#conditionedDistribution = null;
            return includeProgress ? { trialsConsumed: draws, successes: draws, unitsUsed: 1 } : draws;
        }

        let remaining = draws;
        let successes = 0;
        let unitsUsed = 0;
        while (remaining > 0 && unitsUsed < maxIntervals) {
            unitsUsed++;
            if (this.#pendingTrials === 0) {
                this.#pendingTrials = this.#sampleNextSuccessWait();
            }
            if (this.#pendingTrials > remaining) {
                this.#pendingTrials -= remaining;
                this.#addFailures(remaining);
                remaining = 0;
                break;
            }
            remaining -= this.#pendingTrials;
            this.#pendingTrials = 0;
            this.#failures = 0;
            this.#conditionedDistribution = null;
            successes++;
        }
        return includeProgress ? { trialsConsumed: draws - remaining, successes, unitsUsed } : successes;
    }

    #createRollJobCursor(progress) {
        const TOKEN = {};
        this.#activeJob = TOKEN;
        const TOTAL_TRIALS = progress.totalTrials;
        let processedTrials = progress.processedTrials;
        let remainingTrials = progress.remainingTrials;
        let successes = progress.successes;
        let closed = false;
        let terminalStepPending = remainingTrials === 0;
        let finalState = null;

        const MAKE_STATE = () =>
            Object.freeze({
                version: 1,
                totalTrials: TOTAL_TRIALS,
                processedTrials,
                remainingTrials,
                successes,
                distributionState: this.#captureState(),
                rngState: captureRandomState(this.#rng),
            });
        const ASSERT_ACTIVE = () => {
            this.#assertOpen();
            if (closed || this.#activeJob !== TOKEN) {
                throw new Error('PseudoRandomDistribution job is no longer active');
            }
        };
        const RELEASE = () => {
            if (this.#activeJob === TOKEN) {
                this.#activeJob = null;
            }
        };
        const FINISH = () => {
            RELEASE();
            finalState = MAKE_STATE();
        };
        if (remainingTrials === 0) {
            FINISH();
        }

        return Object.freeze({
            step: (maxUnits) => {
                if (closed) {
                    throw new Error('PseudoRandomDistribution job is disposed');
                }
                integer(maxUnits, 'maxUnits', 1, MAX_SAFE_INTEGER);
                if (remainingTrials === 0) {
                    const UNITS_USED = terminalStepPending ? 1 : 0;
                    terminalStepPending = false;
                    return Object.freeze({
                        done: true,
                        unitsUsed: UNITS_USED,
                        processedTrials,
                        remainingTrials,
                        successes,
                    });
                }
                ASSERT_ACTIVE();
                const RESULT = this.#consumeTrials(remainingTrials, maxUnits, true);
                if (RESULT.trialsConsumed < 1 || RESULT.unitsUsed < 1) {
                    throw new Error('PseudoRandomDistribution job step made no progress');
                }
                processedTrials += RESULT.trialsConsumed;
                remainingTrials -= RESULT.trialsConsumed;
                successes += RESULT.successes;
                const DONE = remainingTrials === 0;
                if (DONE) {
                    terminalStepPending = false;
                    FINISH();
                }
                return Object.freeze({
                    done: DONE,
                    unitsUsed: RESULT.unitsUsed,
                    processedTrials,
                    remainingTrials,
                    successes,
                });
            },
            capture: () => {
                if (closed) {
                    throw new Error('PseudoRandomDistribution job is disposed');
                }
                if (finalState) {
                    return finalState;
                }
                ASSERT_ACTIVE();
                return MAKE_STATE();
            },
            dispose: () => {
                if (closed) {
                    return;
                }
                RELEASE();
                closed = true;
                finalState = null;
            },
            get done() {
                return remainingTrials === 0;
            },
            get processedTrials() {
                return processedTrials;
            },
            get remainingTrials() {
                return remainingTrials;
            },
            get successes() {
                return successes;
            },
        });
    }

    #captureState() {
        return Object.freeze({
            version: 1,
            probability: this.#probability,
            consecutiveFailures: this.#failures,
            pendingTrials: this.#pendingTrials,
        });
    }

    #applyDistributionState(state) {
        this.#probability = state.probability;
        this.#coefficient = state.coefficient;
        this.#distribution = state.distribution;
        this.#conditionedDistribution = state.conditionedDistribution;
        this.#failures = state.failures;
        this.#pendingTrials = state.pendingTrials;
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

    #assertNoActiveJob() {
        if (this.#activeJob !== null) {
            throw new Error('dispose or finish the resumable job before using the PRD directly');
        }
    }
}

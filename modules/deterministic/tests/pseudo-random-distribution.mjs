import assert from 'node:assert/strict';
import { PseudoRandomDistribution, SeededPRNG } from '../../../dist/deterministic.js';

const RATES = [0.02, 0.04];
const REPLICATES = 96;
const WINDOW_DRAWS = 100000;
function sampleVariance(values, mean) {
    let sumSquares = 0;
    for (const VALUE of values) {
        sumSquares += (VALUE - mean) ** 2;
    }
    return sumSquares / (values.length - 1);
}

export function exercisePseudoRandomDistribution() {
    const CALIBRATION = [];
    for (const PROBABILITY of RATES) {
        const COUNTS = [];
        for (let replicate = 0; replicate < REPLICATES; replicate++) {
            const RNG = new SeededPRNG(0x51f15e + replicate);
            const PRD = new PseudoRandomDistribution({ probability: PROBABILITY, rng: RNG });
            COUNTS.push(PRD.rollMany(WINDOW_DRAWS));
            PRD.dispose();
        }
        const MEAN = COUNTS.reduce((sum, value) => sum + value, 0) / REPLICATES;
        const RATE = MEAN / WINDOW_DRAWS;
        const VARIANCE = sampleVariance(COUNTS, MEAN);
        const BINOMIAL_VARIANCE = WINDOW_DRAWS * PROBABILITY * (1 - PROBABILITY);
        assert.ok(Math.abs(RATE - PROBABILITY) < 0.0003, `${PROBABILITY} long-run rate ${RATE}`);
        assert.ok(
            VARIANCE > BINOMIAL_VARIANCE * 0.15 && VARIANCE < BINOMIAL_VARIANCE * 0.45,
            `${PROBABILITY} renewal variance ${VARIANCE}`,
        );
        CALIBRATION.push({ probability: PROBABILITY, measuredRate: RATE, variance: VARIANCE });
    }

    const MAX_RNG = { nextUint32: () => 0xffffffff };
    const STREAK = new PseudoRandomDistribution({ probability: 0.02, rng: MAX_RNG });
    assert.equal(STREAK.rollMany(259), 0);
    assert.equal(STREAK.consecutiveFailures, 259);
    assert.equal(STREAK.roll(), true);
    assert.equal(STREAK.consecutiveFailures, 0);
    STREAK.reset();
    STREAK.rollMany(10);
    STREAK.setProbability(0.04);
    assert.equal(STREAK.consecutiveFailures, 10);
    assert.equal(STREAK.capture().pendingTrials, 0);
    STREAK.dispose();

    let zeroRngCalls = 0;
    const ZERO = new PseudoRandomDistribution({
        probability: 0,
        rng: { nextUint32: () => (zeroRngCalls++, 0) },
    });
    assert.equal(ZERO.rollMany(2000), 0);
    assert.equal(ZERO.consecutiveFailures, 2000);
    ZERO.setProbability(0.02);
    assert.equal(ZERO.roll(), true);
    assert.equal(ZERO.consecutiveFailures, 0);
    assert.equal(zeroRngCalls, 0);
    ZERO.dispose();

    let oneRngCalls = 0;
    const ONE = new PseudoRandomDistribution({
        probability: 1,
        rng: { nextUint32: () => (oneRngCalls++, 0) },
    });
    assert.equal(ONE.rollMany(1000), 1000);
    assert.equal(ONE.consecutiveFailures, 0);
    assert.equal(oneRngCalls, 0);
    ONE.dispose();

    const ORIGINAL_RNG = new SeededPRNG(0x13579bdf);
    const ORIGINAL = new PseudoRandomDistribution({ probability: 0.02, rng: ORIGINAL_RNG });
    ORIGINAL.rollMany(12345);
    const CHECKPOINT = ORIGINAL.capture();
    const RANDOM_CHECKPOINT = ORIGINAL_RNG.state;
    const EXPECTED_COUNT = ORIGINAL.rollMany(250000);
    const EXPECTED_STATE = ORIGINAL.capture();
    const EXPECTED_RNG_STATE = ORIGINAL_RNG.state;
    const RESTORED_RNG = new SeededPRNG(1);
    RESTORED_RNG.state = RANDOM_CHECKPOINT;
    const RESTORED = new PseudoRandomDistribution({ probability: 0.04, rng: RESTORED_RNG });
    RESTORED.restore(CHECKPOINT);
    assert.equal(RESTORED.rollMany(250000), EXPECTED_COUNT);
    assert.deepEqual(RESTORED.capture(), EXPECTED_STATE);
    assert.equal(RESTORED_RNG.state, EXPECTED_RNG_STATE);
    assert.throws(() => RESTORED.restore({ ...CHECKPOINT, version: 2 }), RangeError);
    ORIGINAL.dispose();
    RESTORED.dispose();

    const REPLAY_A_RNG = new SeededPRNG(0x2468ace0);
    const REPLAY_B_RNG = new SeededPRNG(0x2468ace0);
    const REPLAY_A = new PseudoRandomDistribution({ probability: 0.04, rng: REPLAY_A_RNG });
    const REPLAY_B = new PseudoRandomDistribution({ probability: 0.04, rng: REPLAY_B_RNG });
    assert.equal(REPLAY_A.rollMany(1000000), REPLAY_B.rollMany(1000000));
    assert.deepEqual(REPLAY_A.capture(), REPLAY_B.capture());
    assert.equal(REPLAY_A_RNG.state, REPLAY_B_RNG.state);
    REPLAY_A.dispose();
    REPLAY_B.dispose();

    const SEQUENTIAL_RNG = new SeededPRNG(0x10203040);
    const BATCH_RNG = new SeededPRNG(0x10203040);
    const SEQUENTIAL = new PseudoRandomDistribution({ probability: 0.02, rng: SEQUENTIAL_RNG });
    const BATCH = new PseudoRandomDistribution({ probability: 0.02, rng: BATCH_RNG });
    let sequentialCount = 0;
    for (let draw = 0; draw < 10000; draw++) {
        sequentialCount += Number(SEQUENTIAL.roll());
    }
    assert.equal(BATCH.rollMany(10000), sequentialCount);
    assert.deepEqual(BATCH.capture(), SEQUENTIAL.capture());
    assert.equal(BATCH_RNG.state, SEQUENTIAL_RNG.state);
    SEQUENTIAL.dispose();
    BATCH.dispose();

    assert.throws(() => new PseudoRandomDistribution({ probability: -0.1, rng: new SeededPRNG(1) }), RangeError);
    assert.throws(() => new PseudoRandomDistribution({ probability: 1.1, rng: new SeededPRNG(1) }), RangeError);
    assert.throws(() => new PseudoRandomDistribution({ probability: 0.00001, rng: new SeededPRNG(1) }), RangeError);
    const MINIMUM = new PseudoRandomDistribution({ probability: 0.0001, rng: new SeededPRNG(1) });
    assert.equal(MINIMUM.probability, 0.0001);
    MINIMUM.dispose();
    assert.throws(() => new PseudoRandomDistribution({ probability: 0.02, rng: {} }), TypeError);
    const INVALID_COUNT = new PseudoRandomDistribution({ probability: 0.02, rng: new SeededPRNG(1) });
    assert.throws(() => INVALID_COUNT.rollMany(1.5), RangeError);
    INVALID_COUNT.dispose();
    const INVALID_RANDOM = new PseudoRandomDistribution({
        probability: 0.02,
        rng: { nextUint32: () => 0.5 },
    });
    assert.throws(() => INVALID_RANDOM.roll(), RangeError);
    INVALID_RANDOM.dispose();

    return { replicates: REPLICATES, drawsPerReplicate: WINDOW_DRAWS, calibration: CALIBRATION };
}

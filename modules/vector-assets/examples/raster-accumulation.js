import { summarizeSamples } from './raster-benchmark.js';

export const ACCUMULATION_LIMIT = 6000;
const HISTORY_LIMIT = 5;

/** Bounded exact samples: completed, balanced rounds only; no reservoir or zero-filled GPU gaps. */
export function createAccumulation() {
    const CONDITIONS = new Map();
    return {
        reset() {
            CONDITIONS.clear();
        },
        append(key, label, result) {
            const MODES = result.methods.map((method) => method.mode);
            let condition = CONDITIONS.get(key);
            if (condition && JSON.stringify(condition.methods.map((method) => method.mode)) !== JSON.stringify(MODES)) {
                // Reverse sampling order is allowed; changing enabled paths under
                // one condition key is not.
                if (
                    condition.methods.length !== MODES.length ||
                    condition.methods.some((method) => !MODES.includes(method.mode))
                ) {
                    throw new Error('Enabled paths differ under the same accumulation key');
                }
            }
            if (!condition) {
                condition = {
                    key,
                    label,
                    rounds: 0,
                    setup: result.setup,
                    methods: MODES.map((mode) => ({
                        mode,
                        cpu: [],
                        submit: [],
                        intervals: [],
                        gpu: [],
                        draws: [],
                        expected: 0,
                        invalidGpuRounds: 0,
                        gpuStatuses: [],
                    })),
                };
            }
            for (const MODE of MODES) {
                const METHOD = result.methods.find((method) => method.mode === MODE);
                const STORED = condition.methods.find((method) => method.mode === MODE);
                if (!METHOD || STORED.cpu.length + METHOD.raw.cpuTotalMs.length > ACCUMULATION_LIMIT) {
                    throw new RangeError('Accumulation limit reached; reset or choose another condition');
                }
            }
            for (const METHOD of result.methods) {
                const STORED = condition.methods.find((method) => method.mode === METHOD.mode);
                STORED.cpu.push(...METHOD.raw.cpuTotalMs);
                STORED.submit.push(...METHOD.raw.submitMs);
                STORED.intervals.push(...METHOD.raw.frameIntervalsMs);
                STORED.draws.push(...METHOD.raw.frames.map((frame) => frame.drawCalls));
                STORED.expected += METHOD.measuredFrames;
                // A disjoint period invalidates this round's GPU results. Partial valid
                // results remain useful with explicit coverage; missing values are absent.
                if (METHOD.gpuMs.status === 'disjoint') {
                    STORED.invalidGpuRounds++;
                } else {
                    STORED.gpu.push(...METHOD.raw.gpuSamples.map((sample) => sample.ms));
                }
                if (!STORED.gpuStatuses.includes(METHOD.gpuMs.status)) {
                    STORED.gpuStatuses.push(METHOD.gpuMs.status);
                }
            }
            condition.rounds++;
            CONDITIONS.delete(key);
            CONDITIONS.set(key, condition);
            if (CONDITIONS.size > HISTORY_LIMIT) {
                CONDITIONS.delete(CONDITIONS.keys().next().value);
            }
            return this.snapshot();
        },
        snapshot() {
            return [...CONDITIONS.values()].map((condition) => ({
                key: condition.key,
                label: condition.label,
                rounds: condition.rounds,
                setupWallMs: condition.setup.wallMs,
                initialPreparationCpuMs: condition.setup.snapshot.preparation.cpuMs,
                atlasAllocatedBytes: condition.setup.atlasAllocatedBytes,
                methods: condition.methods.map((method) => ({
                    mode: method.mode,
                    measuredFrames: method.cpu.length,
                    measuredDurationMs: method.intervals.reduce((sum, value) => sum + value, 0),
                    cpuTotalMs: summarizeSamples(method.cpu),
                    submitMs: summarizeSamples(method.submit),
                    frameIntervalMs: summarizeSamples(method.intervals),
                    drawCalls: summarizeSamples(method.draws),
                    gpuMs: {
                        ...summarizeSamples(method.gpu),
                        expectedCount: method.expected,
                        coverage: method.expected ? method.gpu.length / method.expected : null,
                        status:
                            method.gpu.length === method.expected
                                ? 'available'
                                : method.gpu.length
                                  ? 'partial'
                                  : method.gpuStatuses.join(', '),
                        observedStatuses: method.gpuStatuses.join(', '),
                        invalidRounds: method.invalidGpuRounds,
                    },
                    fps: method.intervals.length ? 1000 / summarizeSamples(method.intervals).mean : null,
                })),
            }));
        },
    };
}

export async function exerciseBudgetedScheduler(page) {
    return page.evaluate(async () => {
        const { createBudgetedScheduler: CREATE_SCHEDULER } = await import('/dist/work-scheduler.js'),
            { FrameMetrics: FRAME_METRICS_TYPE } = await import('/dist/debug-tools.js');
        function check(condition, message) {
            if (!condition) {
                throw new Error(message);
            }
        }

        const FAIR = CREATE_SCHEDULER({
                unitsPerTick: 7,
                now: () => 0,
            }),
            EVENTS = [],
            OWNERS = {
                low: {},
                standard: {},
                urgent: {},
            },
            COUNTS = {
                low: 0,
                standard: 0,
                urgent: 0,
            };
        function enqueuePersistent(key, priority) {
            FAIR.enqueue({
                key,
                owner: OWNERS[key],
                priority,
                step({ maxUnits }) {
                    EVENTS.push(key);
                    COUNTS[key] += maxUnits;
                    return { done: false, unitsUsed: maxUnits };
                },
            });
        }
        enqueuePersistent('low', 0);
        enqueuePersistent('standard', 1);
        enqueuePersistent('urgent', 2);
        check(FAIR.tick(0) === 7, 'tick did not consume its fixed seven-unit budget');
        check(
            EVENTS.join(',') === 'urgent,standard,urgent,low,urgent,standard,urgent',
            'priority wheel lost its stable 4:2:1 service order',
        );
        check(COUNTS.low === 1 && COUNTS.standard === 2 && COUNTS.urgent === 4, 'priority share was incorrect');
        check(FAIR.metrics.lastTickBudgetExhausted, 'budget exhaustion was not reported');

        const MERGED = FAIR.enqueue({
            key: 'urgent',
            owner: OWNERS.urgent,
            priority: 2,
            step() {
                throw new Error('duplicate replaced the active closure');
            },
        });
        check(MERGED === false && FAIR.metrics.jobsMerged === 1, 'duplicate key was not coalesced');
        check(FAIR.cancelOwner(OWNERS.low) === 1, 'owner cancellation did not remove its job');
        check(FAIR.cancel('urgent') && FAIR.cancel('standard'), 'key cancellation did not remove active jobs');
        check(FAIR.metrics.queueDepth === 0, 'cancelled jobs remain queued');
        FAIR.dispose();

        let cursor = 0;
        let originalCompletions = 0;
        let mergedCompletions = 0;
        const OWNER = { alive: true },
            RESUME = CREATE_SCHEDULER({
                unitsPerTick: 2,
                now: (() => {
                    let clock = 0;
                    return () => ++clock;
                })(),
            });
        RESUME.enqueue({
            key: 'scan',
            owner: OWNER,
            priority: 0,
            isValid: () => OWNER.alive,
            step({ maxUnits }) {
                cursor += maxUnits;
                return { done: cursor === 4, unitsUsed: maxUnits, result: cursor };
            },
            onComplete({ result }) {
                originalCompletions = result;
            },
        });
        check(
            !RESUME.enqueue({
                key: 'scan',
                owner: OWNER,
                priority: 2,
                step() {
                    throw new Error('merged request replaced the resumable scan');
                },
                onComplete() {
                    mergedCompletions++;
                },
            }),
            'same key did not merge',
        );
        check(RESUME.tick(10) === 2 && cursor === 2, 'scan did not pause at the tick budget');
        check(RESUME.tick(11) === 2 && cursor === 4, 'scan did not resume at its saved cursor');
        check(originalCompletions === 4 && mergedCompletions === 0, 'merged completion ownership changed');
        check(RESUME.metrics.jobsCompleted === 1, 'completed job counter was incorrect');
        RESUME.dispose();

        let lateRuns = 0;
        const LATE = CREATE_SCHEDULER({ unitsPerTick: 3, now: () => 0 }),
            FRAME_METRICS = new FRAME_METRICS_TYPE({
                capacity: 2,
                counters: ['search.units', 'search.waitTicks', 'search.budgetExhausted'],
            });
        LATE.enqueue({
            key: 'producer',
            step() {
                LATE.enqueue({
                    key: 'late',
                    step({ maxUnits }) {
                        lateRuns++;
                        return { done: true, unitsUsed: maxUnits };
                    },
                });
                return { done: true, unitsUsed: 1 };
            },
        });
        FRAME_METRICS.beginFrame(0);
        LATE.tick(20);
        const FIRST = LATE.metrics;
        FRAME_METRICS.count('search.units', FIRST.lastTickUnits);
        FRAME_METRICS.count('search.waitTicks', FIRST.lastTickWaitingTicks);
        FRAME_METRICS.count('search.budgetExhausted', Number(FIRST.lastTickBudgetExhausted));
        FRAME_METRICS.endFrame();
        check(lateRuns === 0, 'work enqueued from a callback ran in the same tick');
        check(FIRST.queueDepth === 1 && FIRST.pendingJobs === 0, 'pending work was not carried to the next tick');
        FRAME_METRICS.beginFrame(16);
        LATE.tick(21);
        const SECOND = LATE.metrics;
        FRAME_METRICS.count('search.units', SECOND.lastTickUnits);
        FRAME_METRICS.count('search.waitTicks', SECOND.lastTickWaitingTicks);
        FRAME_METRICS.count('search.budgetExhausted', Number(SECOND.lastTickBudgetExhausted));
        FRAME_METRICS.endFrame();
        const FRAME = FRAME_METRICS.snapshot({ limit: 2, slowLimit: 2 });
        check(lateRuns === 1 && SECOND.lastTickWaitingTicks === 1, 'next-tick work or waiting age was incorrect');
        check(
            FRAME.counts['search.units'].total === 2 &&
                FRAME.counts['search.waitTicks'].total === 1 &&
                FRAME.counts['search.budgetExhausted'].total === 0,
            'scheduler counters did not connect to FrameMetrics',
        );
        LATE.dispose();
        check(LATE.metrics.queueDepth === 0, 'dispose retained queued owner references');

        function deterministicTrace(clockStep) {
            let clock = 0;
            const TRACE = [],
                SCHEDULER = CREATE_SCHEDULER({
                    unitsPerTick: 7,
                    now: () => (clock += clockStep),
                });
            for (const [KEY, PRIORITY] of [
                ['a', 0],
                ['b', 1],
                ['c', 2],
            ]) {
                let count = 0;
                SCHEDULER.enqueue({
                    key: KEY,
                    priority: PRIORITY,
                    step({ maxUnits }) {
                        TRACE.push(KEY);
                        count += maxUnits;
                        return { done: count === 35, unitsUsed: maxUnits };
                    },
                });
            }
            for (let tickId = 0; tickId < 5; tickId++) {
                SCHEDULER.tick(tickId);
            }
            SCHEDULER.dispose();
            return TRACE.join(',');
        }
        check(
            deterministicTrace(0.01) === deterministicTrace(80),
            'wall-clock duration changed scheduler output order',
        );
        return {
            fixedBudgetUnits: 7,
            firstPrioritySlice: COUNTS,
            resumedCandidates: cursor,
            maxWaitTicks: SECOND.maxWaitTicks,
            frameMetricUnits: FRAME.counts['search.units'].total,
            timingIndependent: true,
            disposedQueueDepth: LATE.metrics.queueDepth,
        };
    });
}

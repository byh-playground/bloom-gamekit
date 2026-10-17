import { createLoop } from '../simloop/loop.js';

/** Deterministic timeline/lifetime; the factory owns isolated simulation and rendering. */
export function createScenario({ definition, createRun, requestFrame, cancelFrame, onEnd = () => {} } = {}) {
    if (!definition || typeof createRun !== 'function' || typeof onEnd !== 'function') {
        throw new TypeError('scenario definition/factory');
    }
    definition = structuredClone(definition);
    const { tickRate: TICK_RATE, endTick: END_TICK, loop: REPEAT = false } = definition;
    if (!Number.isFinite(TICK_RATE) || TICK_RATE <= 0 || !Number.isSafeInteger(END_TICK) || END_TICK < 1) {
        throw new RangeError('tickRate/endTick');
    }
    const DT_MS = 1000 / TICK_RATE;
    const TIMELINE = (definition.timeline ?? [])
        .map((event, order) => {
            if ((event.tick === undefined) === (event.atMs === undefined)) {
                throw new TypeError('exactly one of tick/atMs');
            }
            const TICK = event.tick ?? Math.ceil(event.atMs / DT_MS);
            if (
                !Number.isSafeInteger(TICK) ||
                TICK < 0 ||
                TICK > END_TICK ||
                (event.atMs !== undefined && (!Number.isFinite(event.atMs) || event.atMs < 0))
            ) {
                throw new RangeError('event time');
            }
            return {
                tick: TICK,
                order,
                event: structuredClone(event),
            };
        })
        .sort((a, b) => a.tick - b.tick || a.order - b.order);
    let state = 'idle';
    let tick = 0;
    let cursor = 0;
    let iteration = 0;
    let scope = null;
    let controller = null;
    let generation = 0;
    let driving = false;
    const EMPTY = Object.freeze([]);
    function frame(at, alpha = 0) {
        const EVENTS = [];
        while (cursor < TIMELINE.length && TIMELINE[cursor].tick <= at) {
            EVENTS.push(structuredClone(TIMELINE[cursor++].event));
        }
        return {
            tick: at,
            timeMs: at * DT_MS,
            dtMs: at === 0 ? 0 : DT_MS,
            alpha,
            iteration,
            events: EVENTS.length ? EVENTS : EMPTY,
        };
    }
    function release() {
        generation++;
        SCHEDULER.stop();
        controller?.abort();
        controller = null;
        const OLD = scope;
        scope = null;
        OLD?.dispose();
    }
    function initialize() {
        tick = 0;
        cursor = 0;
        controller = new AbortController();
        scope = createRun({
            seed: definition.seed,
            initialState: structuredClone(definition.initialState),
            scene: structuredClone(definition.scene),
            signal: controller.signal,
            iteration,
        });
        if (!scope || typeof scope.step !== 'function' || typeof scope.dispose !== 'function') {
            throw new TypeError('isolated run step/dispose');
        }
        const INITIAL = frame(0);
        if (INITIAL.events.length && typeof scope.initialize !== 'function') {
            throw new TypeError('tick zero events require initialize');
        }
        scope.initialize?.(INITIAL);
    }
    function advance() {
        if (state !== 'playing') {
            return {
                status: 'held',
                tick,
            };
        }
        const TOKEN = generation;
        scope.step(frame(++tick));
        if (TOKEN !== generation) {
            return {
                status: 'advanced',
                tick,
            };
        }
        if (tick === END_TICK || scope.isComplete?.()) {
            state = 'ended';
            SCHEDULER.stop();
            scope.pause?.();
            onEnd(snapshot());
            if (TOKEN === generation && scope) {
                scope.render?.({
                    tick,
                    timeMs: tick * DT_MS,
                    alpha: 0,
                    iteration,
                });
            }
            if (TOKEN === generation && state === 'ended' && REPEAT) {
                const AUTOMATIC = driving;
                release();
                iteration++;
                initialize();
                state = 'playing';
                if (AUTOMATIC) {
                    SCHEDULER.start();
                }
            }
        }
        return {
            status: 'advanced',
            tick,
        };
    }
    const SCHEDULER = createLoop({
        session: {
            inputSize: 0,
            profile: {
                tickRate: TICK_RATE,
                maxCatchupSteps: 5,
            },
            pace: 1,
            poll() {},
            releaseInput() {},
            get closed() {
                return state !== 'playing';
            },
            advance,
        },
        getInput: () => EMPTY,
        canObserveInput: () => false,
        render({ alpha }) {
            if (scope && state !== 'disposed') {
                scope.render?.({
                    tick,
                    timeMs: tick * DT_MS,
                    alpha,
                    iteration,
                });
            }
        },
        requestFrame,
        cancelFrame,
        onError(error) {
            state = 'stopped';
            release();
            throw error;
        },
    });
    function snapshot() {
        return {
            state,
            tick,
            timeMs: tick * DT_MS,
            iteration,
        };
    }
    return {
        play({ automatic = true } = {}) {
            if (state === 'disposed' || state === 'playing' || state === 'ended') {
                return;
            }
            try {
                if (!scope) {
                    initialize();
                }
                state = 'playing';
                driving = automatic;
                SCHEDULER.resetTiming();
                if (automatic) {
                    SCHEDULER.start();
                }
            } catch (error) {
                state = 'stopped';
                release();
                throw error;
            }
        },
        pause() {
            if (state !== 'playing') {
                return;
            }
            state = 'paused';
            SCHEDULER.stop();
            SCHEDULER.resetTiming();
            scope?.pause?.();
        },
        restart({ automatic = true } = {}) {
            if (state === 'disposed') {
                return;
            }
            state = 'stopped';
            release();
            iteration = 0;
            this.play({
                automatic,
            });
        },
        stop() {
            if (state === 'disposed') {
                return;
            }
            state = 'stopped';
            release();
        },
        // Manual QA/export driver: exactly one fixed tick, no wall-clock accumulator.
        step() {
            if (driving && SCHEDULER.running) {
                throw new Error('pause automatic scheduling before manual stepping');
            }
            try {
                return advance();
            } catch (error) {
                state = 'stopped';
                release();
                throw error;
            }
        },
        pulse(timestamp, options) {
            if (state === 'playing' && !driving) {
                SCHEDULER.pulse(timestamp, options);
            }
        },
        render() {
            if (scope) {
                SCHEDULER.render();
            }
        },
        snapshot,
        get state() {
            return state;
        },
        dispose() {
            if (state === 'disposed') {
                return;
            }
            state = 'disposed';
            release();
        },
    };
}

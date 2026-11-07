// One display-frame lifecycle scenario, exercised by the existing real-browser runner.
export async function runFrameChecks(page) {
    return page.evaluate(async () => {
        const {
            RenderObject: R,
            PresentationRuntime: PRESENTATION_RUNTIME,
            InterpolationTimeline: INTERPOLATION_TIMELINE,
        } = await import('/dist/interpolation.js');
        const CHECK = (ok, message) => {
            if (!ok) {
                throw new Error(message);
            }
        };
        class Shot extends R {
            static renderSchema = {
                x: R.POSITION_X,
                y: R.POSITION_Y,
                color: R.STEP,
            };
            static renderPath = {
                x: 'x',
                y: 'y',
                durationMs: 300,
                maxPoints: 16,
            };
        }
        const RUNTIME = new PRESENTATION_RUNTIME({
            stepMs: 100,
            delayMs: 200,
        });
        const EMPTY_CLOCK = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            EMPTY_SCALARS = new INTERPOLATION_TIMELINE({
                stepMs: 100,
                delayMs: 200,
                clock: 'bounded',
                schema: { x: 'number' },
            });
        EMPTY_CLOCK.setRate(0, 0);
        EMPTY_SCALARS.setRate(0, 0);
        CHECK(
            EMPTY_CLOCK.frame(100).revision === -1 &&
                EMPTY_CLOCK.frame(100).timeMs === null &&
                EMPTY_CLOCK.frame(200).timeMs === null &&
                EMPTY_SCALARS.displayTime(100) === null &&
                EMPTY_SCALARS.displayTime(200) === null,
            'paused uninitialized clocks do not invent simulation time',
        );
        EMPTY_CLOCK.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [] }, 200);
        EMPTY_SCALARS.accept({ revision: 0, sequence: 0, timeMs: 0, entities: [] }, 200);
        CHECK(
            EMPTY_CLOCK.frame(300).revision === 0 &&
                EMPTY_CLOCK.frame(300).timeMs === -200 &&
                EMPTY_SCALARS.displayTime(300) === -200,
            'first capture initializes a paused epoch without advancing it',
        );
        const EXTREME_CLOCK = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        EXTREME_CLOCK.capture({ revision: 0, sequence: 0, timeMs: 0, mode: 'reset', entities: [] }, -1e308);
        EXTREME_CLOCK.setRate(0, -1e308);
        CHECK(
            EXTREME_CLOCK.frame(1e308).timeMs === 0,
            'a paused finite clock never multiplies overflowing elapsed time by zero',
        );
        const FIRST_CONTINUOUS = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            FIRST_RESET = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            FIRST_PACKET = {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [{ id: 'first', generation: 0, type: Shot, source: { x: 50, y: 0, color: 'red' } }],
            };
        FIRST_CONTINUOUS.capture(FIRST_PACKET, 0);
        FIRST_RESET.capture({ ...FIRST_PACKET, mode: 'reset' }, 0);
        const RESET_FRAME = FIRST_RESET.frame(0);
        CHECK(
            FIRST_CONTINUOUS.frame(0).sample('first', 0) === null &&
                RESET_FRAME.timeMs === 0 &&
                RESET_FRAME.sample('first', 0).x === 50,
            'first continuous birth keeps buffered visibility while an explicit reset snaps',
        );
        FIRST_RESET.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [{ id: 'first', generation: 0, type: Shot, source: { x: 100, y: 0, color: 'red' } }],
            },
            100,
        );
        CHECK(
            FIRST_RESET.frame(100).timeMs === 0 &&
                FIRST_RESET.frame(100).sample('first', 0).x === 50 &&
                FIRST_RESET.frame(150).timeMs === 50 &&
                FIRST_RESET.frame(150).sample('first', 0).x === 75,
            'after a reset the latest-first clock follows the next target smoothly without moving backward',
        );
        const SHOT = (x) => ({ id: 'b', generation: 0, type: Shot, source: { x, y: 0, color: 'red' } });
        const JITTER = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        JITTER.capture({ revision: 0, sequence: 0, timeMs: 0, mode: 'reset', entities: [SHOT(0)] }, 0);
        CHECK(JITTER.frame(130).sample('b', 0).x === 0, 'no motion is invented before the first late sample');
        JITTER.capture({ revision: 0, sequence: 1, timeMs: 100, entities: [SHOT(100)] }, 130);
        CHECK(
            JITTER.frame(130).sample('b', 0).x === 0 && JITTER.frame(160).sample('b', 0).x === 30,
            '130ms arrival starts from the displayed pose and moves continuously',
        );
        const JITTER_BEFORE = JITTER.frame(200).sample('b', 0).x;
        JITTER.capture({ revision: 0, sequence: 2, timeMs: 200, entities: [SHOT(200)] }, 200);
        CHECK(
            JITTER_BEFORE === 70 && JITTER.frame(200).sample('b', 0).x === 70,
            'the following 70ms arrival retargets without a visible jump',
        );
        const FIXED_COMPARISON = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200 }),
            LATEST_COMPARISON = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        for (let i = 0; i <= 10; i++) {
            const PACKET = {
                revision: 0,
                sequence: i,
                timeMs: i * 100,
                mode: i ? 'continuous' : 'reset',
                entities: [SHOT(i * 100)],
            };
            FIXED_COMPARISON.capture(PACKET, i * 100);
            LATEST_COMPARISON.capture(PACKET, i * 100);
        }
        const FIXED_FRAME = FIXED_COMPARISON.frame(1100),
            LATEST_FRAME = LATEST_COMPARISON.frame(1000),
            FIXED_PATH = [],
            LATEST_PATH = [];
        FIXED_FRAME.pathInto('b', 0, FIXED_PATH);
        LATEST_FRAME.pathInto('b', 0, LATEST_PATH);
        CHECK(
            FIXED_FRAME.timeMs === 900 &&
                LATEST_FRAME.timeMs === 900 &&
                FIXED_FRAME.sample('b', 0).x === LATEST_FRAME.sample('b', 0).x &&
                JSON.stringify(FIXED_PATH) === JSON.stringify(LATEST_PATH),
            'fixed and latest-first policies represent identical pose and path at the same simulation time',
        );
        // A visible game may be backgrounded or receive simulation ticks more slowly than wall time.
        // Its body, path and event clock must agree while the clock waits for the next sample.
        const BOUNDED = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        const BOUNDED_PUT = (sequence, timeMs, nowMs, entities, extra = {}) =>
            BOUNDED.capture({ revision: 0, sequence, timeMs, entities, ...extra }, nowMs);
        BOUNDED_PUT(0, 0, 0, [SHOT(0)]);
        BOUNDED_PUT(1, 100, 100, [SHOT(100)]);
        BOUNDED_PUT(2, 200, 1200, [SHOT(200)]);
        let boundedFrame = BOUNDED.frame(1200);
        CHECK(
            boundedFrame.timeMs === 100 && boundedFrame.sample('b', 0).x === 100,
            'a late sample starts at the last displayed pose and clock',
        );
        boundedFrame = BOUNDED.frame(1250);
        const BOUNDED_PATH = [];
        boundedFrame.pathInto('b', 0, BOUNDED_PATH);
        CHECK(
            boundedFrame.timeMs === 150 && boundedFrame.sample('b', 0).x === 150 && BOUNDED_PATH.at(-1).x === 150,
            'the delayed arrival continues smoothly and path shares the displayed clock',
        );
        CHECK(
            BOUNDED.frame(1300).sample('b', 0).x === 200 && BOUNDED.frame(1400).timeMs === 200,
            'the display holds at the latest sample without extrapolating its clock',
        );
        BOUNDED_PUT(3, 300, 1410, [SHOT(300)]);
        CHECK(
            BOUNDED.frame(1410).sample('b', 0).x === 200 && BOUNDED.frame(1460).sample('b', 0).x === 250,
            'successive slow ticks do not snap to the new target',
        );
        BOUNDED_PUT(4, 400, 1620, []);
        CHECK(
            BOUNDED.frame(1620).sample('b', 0)?.x === 300 && BOUNDED.frame(1720).sample('b', 0) === null,
            'removal uses the same bounded display clock',
        );
        const BURST = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        BURST.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [SHOT(0)] }, 0);
        for (let i = 1; i <= 12; i++) {
            BURST.capture({ revision: 0, sequence: i, timeMs: i * 100, entities: [SHOT(i * 100)] }, 200);
        }
        const BURST_FRAME = BURST.frame(200);
        CHECK(
            BURST_FRAME.timeMs === 900 && BURST_FRAME.sample('b', 0).x === 900,
            'catch-up omits stale display debt without skipping authoritative captures',
        );
        BURST.capture({ revision: 1, sequence: 0, timeMs: 100, mode: 'rollback', entities: [SHOT(100)] }, 300);
        CHECK(BURST.frame(300).sample('b', 0).x === 100, 'rollback starts a new bounded clock epoch');
        const PAUSED = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            PAUSE_SOURCE = { x: 0, y: 0, color: 'red' },
            PAUSE_SHOT = (generation = 0) => ({ id: 'p', generation, type: Shot, source: PAUSE_SOURCE });
        for (let i = 0; i <= 2; i++) {
            PAUSE_SOURCE.x = i * 100;
            PAUSED.capture({ revision: 0, sequence: i, timeMs: i * 100, entities: [PAUSE_SHOT()] }, i * 100);
        }
        const BEFORE_PAUSE = PAUSED.frame(300),
            BEFORE_PATH = [];
        BEFORE_PAUSE.pathInto('p', 0, BEFORE_PATH);
        CHECK(
            BEFORE_PAUSE.timeMs === 100 && BEFORE_PAUSE.sample('p', 0).x === 100,
            'bounded pause starts from its actual displayed pose',
        );
        PAUSED.setRate(0, 300);
        const NEW_PAUSE_SOURCE = { x: 300, y: 0, color: 'red' };
        for (let i = 3; i <= 10; i++) {
            NEW_PAUSE_SOURCE.x = i * 100;
            PAUSED.capture(
                {
                    revision: 0,
                    sequence: i,
                    timeMs: i * 100,
                    entities: [
                        {
                            id: 'p',
                            generation: 0,
                            type: Shot,
                            source: NEW_PAUSE_SOURCE,
                        },
                    ],
                },
                i * 100,
            );
        }
        const PAUSE_FRAME = PAUSED.frame(1000),
            PAUSE_PATH = [];
        PAUSE_FRAME.pathInto('p', 0, PAUSE_PATH);
        const PAUSE_MODEL = PAUSE_FRAME.sample('p', 0);
        CHECK(
            PAUSE_FRAME.timeMs === 100 &&
                PAUSE_MODEL.x === 100 &&
                PAUSE_FRAME.modelFor(NEW_PAUSE_SOURCE) === PAUSE_MODEL &&
                PAUSE_FRAME.modelFor(PAUSE_SOURCE) === null &&
                PAUSE_FRAME.modelFor(PAUSE_MODEL) === PAUSE_MODEL &&
                PAUSED.isModel(PAUSE_MODEL) &&
                !PAUSED.isModel(undefined) &&
                JSON.stringify(PAUSE_PATH) === JSON.stringify(BEFORE_PATH),
            'paused display and path stay fixed across many live captures',
        );
        PAUSED.setRate(1, 1000);
        const RESUMED = PAUSED.frame(1000);
        CHECK(
            RESUMED.timeMs === 700 && RESUMED.sample('p', 0).x === 700,
            'resume skips stale display debt without a stale same-time model',
        );
        PAUSED.setRate(0.5, 1000);
        const HALF_FRAME = PAUSED.frame(1040),
            HALF = HALF_FRAME.timeMs,
            HALF_POSE = HALF_FRAME.sample('p', 0).x;
        PAUSED.setRate(4, 1040);
        CHECK(
            HALF === 720 &&
                HALF_POSE === 720 &&
                PAUSED.frame(1040).timeMs === 720 &&
                PAUSED.frame(1040).sample('p', 0).x === HALF_POSE &&
                PAUSED.frame(1050).timeMs === 760 &&
                PAUSED.frame(1050).sample('p', 0).x === 760,
            'rate changes integrate the previous rate and keep the same simulation-time unit',
        );
        const SPEEDS = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        for (let i = 0; i <= 10; i++) {
            SPEEDS.capture({ revision: 0, sequence: i, timeMs: i * 100, entities: [SHOT(i * 100)] }, 0);
        }
        SPEEDS.setRate(0.5, 0);
        CHECK(SPEEDS.frame(100).timeMs === 750, 'half-speed advances in canonical simulation milliseconds');
        SPEEDS.setRate(1, 100);
        CHECK(SPEEDS.frame(150).timeMs === 800, 'normal speed continues without resetting the playhead');
        SPEEDS.setRate(2, 150);
        CHECK(SPEEDS.frame(175).timeMs === 850, 'double speed advances the same simulation-time clock');
        SPEEDS.setRate(4, 175);
        CHECK(SPEEDS.frame(187.5).timeMs === 900, 'quadruple speed advances the same simulation-time clock');
        SPEEDS.setRate(0, 187.5);
        CHECK(
            SPEEDS.frame(1000).timeMs === 900 && SPEEDS.frame(1000).sample('b', 0).x === 900,
            'pause holds both time and model after playback-rate transitions',
        );
        const REBORN = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            ORIGINAL_SOURCE = { x: 1, y: 0, color: 'red' },
            REPLACEMENT_SOURCE = { x: 2, y: 0, color: 'blue' },
            NEW_EPOCH_SOURCE = { x: 3, y: 0, color: 'green' };
        REBORN.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                mode: 'reset',
                entities: [{ id: 'reborn', generation: 0, type: Shot, source: ORIGINAL_SOURCE }],
            },
            0,
        );
        REBORN.setRate(0, 1);
        REBORN.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [{ id: 'reborn', generation: 1, type: Shot, source: REPLACEMENT_SOURCE }],
            },
            100,
        );
        let held = REBORN.frame(100);
        CHECK(
            held.sample('reborn', 0).x === 1 &&
                held.modelFor(ORIGINAL_SOURCE) === null &&
                held.modelFor(REPLACEMENT_SOURCE) === null,
            'paused view keeps old visible generation without registering a new one',
        );
        REBORN.capture(
            {
                revision: 1,
                sequence: 0,
                timeMs: 50,
                mode: 'rollback',
                entities: [{ id: 'reborn', generation: 2, type: Shot, source: NEW_EPOCH_SOURCE }],
            },
            200,
        );
        held = REBORN.frame(200);
        CHECK(
            held.sample('reborn', 0) === null &&
                held.sample('reborn', 2).x === 3 &&
                held.modelFor(NEW_EPOCH_SOURCE) === held.sample('reborn', 2),
            'explicit rollback while paused changes the scene and freezes the new revision',
        );
        const CHURN = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        const CHURN_PACKET = (tick) => ({
            revision: 0,
            sequence: tick,
            timeMs: tick * 100,
            entities: Array.from({ length: 10 }, (_, index) => ({
                id: `${tick}:${index}`,
                generation: 0,
                type: Shot,
                source: { x: index, y: tick, color: 'red' },
            })),
        });
        CHURN.capture({ ...CHURN_PACKET(0), mode: 'reset' }, 0);
        CHURN.setRate(0, 0);
        for (let i = 1; i <= 10; i++) {
            CHURN.capture(CHURN_PACKET(i), i * 100);
        }
        let heldCount = 0;
        CHURN.frame(1000).forEach(() => heldCount++);
        CHECK(
            heldCount === 10 && CHURN.size <= 40,
            'paused view stays fixed while live entity churn retains only a bounded recent window',
        );
        const BOUNDED_SCALARS = new INTERPOLATION_TIMELINE({
                stepMs: 100,
                delayMs: 200,
                clock: 'bounded',
                schema: { x: 'number' },
            }),
            SCALAR_OUT = {};
        for (let i = 0; i <= 2; i++) {
            BOUNDED_SCALARS.accept(
                {
                    revision: 0,
                    sequence: i,
                    timeMs: i * 100,
                    entities: [{ id: 'x', generation: 0, values: { x: i * 100 } }],
                },
                i * 100,
            );
        }
        BOUNDED_SCALARS.setRate(0, 300);
        for (let i = 3; i <= 10; i++) {
            BOUNDED_SCALARS.accept(
                {
                    revision: 0,
                    sequence: i,
                    timeMs: i * 100,
                    entities: [{ id: 'x', generation: 0, values: { x: i * 100 } }],
                },
                i * 100,
            );
        }
        CHECK(
            BOUNDED_SCALARS.displayTime(1000) === 100 &&
                BOUNDED_SCALARS.sampleInto('x', 0, 1000, SCALAR_OUT) &&
                SCALAR_OUT.x === 100,
            'scalar API keeps the same frozen display clock under live captures',
        );
        BOUNDED_SCALARS.setRate(1, 1000);
        CHECK(
            BOUNDED_SCALARS.displayTime(1000) === 700 &&
                BOUNDED_SCALARS.sampleInto('x', 0, 1000, SCALAR_OUT) &&
                SCALAR_OUT.x === 700,
            'scalar API resumes at the same bounded time as Runtime',
        );
        const TICK_BOUNDARY = 966.666666666667,
            BOUNDARY_RUNTIME = new PRESENTATION_RUNTIME({
                stepMs: 100 / 3,
                delayMs: 100 / 3,
            });
        BOUNDARY_RUNTIME.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: TICK_BOUNDARY,
                entities: [
                    {
                        id: 'boundary',
                        generation: 0,
                        type: Shot,
                        source: {
                            x: 1,
                            y: 1,
                            color: 'red',
                        },
                    },
                ],
            },
            10000,
        );
        const BOUNDARY_PATH = [];
        BOUNDARY_RUNTIME.frame(10000 + 100 / 3).pathInto('boundary', 0, BOUNDARY_PATH);
        CHECK(
            BOUNDARY_PATH.length === 1 && BOUNDARY_PATH[0].timeMs === TICK_BOUNDARY,
            'delayed path reuses its exact computed interval start at a floating-point tick boundary',
        );
        const STRICT_PATH = new PRESENTATION_RUNTIME({
            stepMs: 100,
            delayMs: 100,
        });
        let backwardPath = false;
        try {
            STRICT_PATH.capture(
                {
                    revision: 0,
                    sequence: 0,
                    timeMs: 100,
                    entities: [
                        {
                            id: 'reverse',
                            generation: 0,
                            type: Shot,
                            source: {
                                x: 1,
                                y: 1,
                                color: 'red',
                            },
                            initialSource: {
                                x: 0,
                                y: 0,
                                color: 'red',
                            },
                            initialTimeMs: 0,
                            pathPoints: [
                                {
                                    timeMs: 75,
                                    x: 2,
                                    y: 2,
                                },
                                {
                                    timeMs: 50,
                                    x: 3,
                                    y: 3,
                                },
                            ],
                        },
                    ],
                },
                1000,
            );
        } catch (error) {
            backwardPath = /path points must be ordered/.test(error.message);
        }
        CHECK(backwardPath, 'genuinely out-of-order path points still fail strictly');
        const CAPTURE = (sequence, timeMs, entities, extra = {}) =>
            RUNTIME.capture(
                {
                    revision: 0,
                    sequence,
                    timeMs,
                    entities,
                    ...extra,
                },
                timeMs,
            );
        CAPTURE(0, 0, []);
        CAPTURE(1, 100, [
            {
                id: 'shot',
                generation: 0,
                type: Shot,
                source: {
                    x: 10,
                    y: 10,
                    color: 'red',
                    secret: 99,
                },
                initialSource: {
                    x: 0,
                    y: 0,
                    color: 'red',
                },
                initialTimeMs: 0,
                pathPoints: [
                    {
                        timeMs: 50,
                        x: 0,
                        y: 10,
                    },
                ],
            },
        ]);
        CHECK(RUNTIME.frame(150).sample('shot', 0) === null, 'birth hidden before its display time');
        CAPTURE(2, 200, [
            {
                id: 'shot',
                generation: 0,
                type: Shot,
                source: {
                    x: 20,
                    y: 10,
                    color: 'blue',
                },
            },
        ]);
        let frame = RUNTIME.frame(225);
        let model = frame.sample('shot', 0);
        const PATH = [];
        frame.pathInto('shot', 0, PATH);
        CHECK(
            model.x === 0 && model.y === 5 && model.color === 'red' && PATH.at(-1).y === 5,
            'birth first interval and path share a clock',
        );
        CHECK(!('secret' in model) && Object.getPrototypeOf(model) === Object.prototype, 'detached declared data');
        frame = RUNTIME.frame(275);
        model = frame.sample('shot', 0);
        frame.pathInto('shot', 0, PATH);
        CHECK(
            model.x === 5 && model.y === 10 && PATH.some((p) => p.timeMs === 50 && p.x === 0 && p.y === 10),
            'within-tick corner retained',
        );
        CHECK(PATH.every((p) => p.timeMs <= 75) && PATH.at(-1).x === model.x, 'no future path; exact body endpoint');
        let expired = false;
        try {
            const OLD = frame;
            RUNTIME.frame(276);
            OLD.sample('shot', 0);
        } catch {
            expired = true;
        }
        CHECK(expired, 'expired frame diagnosed');
        CAPTURE(3, 300, []);
        frame = RUNTIME.frame(350);
        let count = 0;
        frame.forEach(() => count++);
        CHECK(
            count === 1 && frame.sample('shot', 0).x === 15,
            'removed authority stays visible through delayed lifetime',
        );
        CHECK(RUNTIME.frame(500).sample('shot', 0) === null, 'removed at display time');
        RUNTIME.capture(
            {
                revision: 1,
                sequence: 0,
                timeMs: 100,
                mode: 'rollback',
                entities: [
                    {
                        id: 'shot',
                        generation: 1,
                        type: Shot,
                        source: {
                            x: 80,
                            y: 10,
                            color: 'blue',
                        },
                    },
                ],
            },
            600,
        );
        frame = RUNTIME.frame(600);
        frame.pathInto('shot', 1, PATH);
        CHECK(
            frame.sample('shot', 0) === null &&
                frame.sample('shot', 1).x === 80 &&
                PATH.length === 1 &&
                PATH[0].x === 80,
            'rollback resets path and generation immediately',
        );
        RUNTIME.capture(
            {
                revision: 1,
                sequence: 1,
                timeMs: 200,
                entities: [
                    {
                        id: 'shot',
                        generation: 1,
                        type: Shot,
                        teleport: true,
                        source: {
                            x: 150,
                            y: 10,
                            color: 'blue',
                        },
                    },
                ],
            },
            700,
        );
        CHECK(RUNTIME.frame(700).sample('shot', 1).x === 150, 'teleport does not sweep old path');
        class Actor extends R {
            static renderSchema = {
                x: R.POSITION_X,
                y: R.POSITION_Y,
            };
        }
        const REUSED_RUNTIME = new PRESENTATION_RUNTIME({
                stepMs: 100,
            }),
            REUSED_SOURCE = {
                x: 0,
                y: 0,
            };
        REUSED_RUNTIME.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [
                    {
                        id: 'reused',
                        generation: 0,
                        type: Actor,
                        source: REUSED_SOURCE,
                    },
                ],
            },
            0,
        );
        REUSED_SOURCE.x = 20;
        REUSED_RUNTIME.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [
                    {
                        id: 'reused',
                        generation: 0,
                        type: Actor,
                        source: REUSED_SOURCE,
                    },
                ],
            },
            100,
        );
        REUSED_SOURCE.x = 10000;
        CHECK(
            REUSED_RUNTIME.sample('reused', 0, 150).x === 10,
            'continuous capture keeps an immutable target snapshot while reusing its private interpolation state',
        );
        const LOCAL = new PRESENTATION_RUNTIME({
                stepMs: 100,
                delayMs: 200,
            }),
            SOURCE = {
                x: 0,
                y: 0,
            };
        LOCAL.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [
                    {
                        id: 'local',
                        generation: 0,
                        type: Actor,
                        source: SOURCE,
                    },
                ],
            },
            0,
        );
        LOCAL.selectPreview([
            {
                id: 'local',
                generation: 0,
            },
        ]);
        LOCAL.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 100,
                phaseStartMs: 0,
                stepMs: 100,
                entities: [
                    {
                        id: 'local',
                        generation: 0,
                        type: Actor,
                        source: {
                            x: 10,
                            y: 0,
                        },
                    },
                ],
            },
            0,
        );
        const SELECTED = LOCAL.frame(50).sample('local', 0);
        CHECK(SELECTED.x === 5, 'local preview is immediate despite delayed authority');
        const BOUNDED_LOCAL = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            BOUNDED_OWNER = { x: 0, y: 0 },
            BOUNDED_PREVIEW = { x: 20, y: 0 };
        BOUNDED_LOCAL.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [{ id: 'local', generation: 0, type: Actor, source: BOUNDED_OWNER }],
            },
            0,
        );
        BOUNDED_OWNER.x = 10;
        BOUNDED_LOCAL.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [{ id: 'local', generation: 0, type: Actor, source: BOUNDED_OWNER }],
            },
            100,
        );
        BOUNDED_LOCAL.selectPreview([{ id: 'local', generation: 0 }]);
        BOUNDED_LOCAL.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 110,
                phaseStartMs: 100,
                stepMs: 100,
                entities: [{ id: 'local', generation: 0, type: Actor, source: BOUNDED_PREVIEW }],
            },
            110,
        );
        BOUNDED_LOCAL.frame(120).sample('local', 0);
        BOUNDED_LOCAL.releasePreview(120);
        BOUNDED_LOCAL.setRate(0.5, 120);
        const PREVIEW_HANDOFF = BOUNDED_LOCAL.frame(300);
        CHECK(
            PREVIEW_HANDOFF.timeMs === 10 && PREVIEW_HANDOFF.sample('local', 0).x !== 10,
            'slow-rate preview handoff waits for the display clock, not a wall deadline',
        );
        const HANDOFF_DONE = BOUNDED_LOCAL.frame(480);
        CHECK(
            HANDOFF_DONE.sample('local', 0).x === 10 && HANDOFF_DONE.modelFor(BOUNDED_PREVIEW) === null,
            'preview handoff completes when the bounded display reaches authority',
        );
        const PAUSED_PREVIEW = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            PAUSED_PREVIEW_SOURCE = { x: 0, y: 0 };
        PAUSED_PREVIEW.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [{ id: 'a', generation: 0, type: Actor, source: PAUSED_PREVIEW_SOURCE }],
            },
            0,
        );
        PAUSED_PREVIEW_SOURCE.x = 10;
        PAUSED_PREVIEW.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [{ id: 'a', generation: 0, type: Actor, source: PAUSED_PREVIEW_SOURCE }],
            },
            100,
        );
        PAUSED_PREVIEW.selectPreview([{ id: 'a', generation: 0 }]);
        PAUSED_PREVIEW.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 110,
                phaseStartMs: 100,
                stepMs: 100,
                entities: [{ id: 'a', generation: 0, type: Actor, source: { x: 20, y: 0 } }],
            },
            110,
        );
        CHECK(PAUSED_PREVIEW.frame(120).sample('a', 0).x === 12, 'preview at pause boundary');
        PAUSED_PREVIEW.setRate(0, 120);
        PAUSED_PREVIEW.releasePreview(300);
        CHECK(PAUSED_PREVIEW.frame(300).sample('a', 0).x === 12, 'paused preview does not advance on wall time');
        PAUSED_PREVIEW.setRate(1, 300);
        CHECK(
            PAUSED_PREVIEW.frame(300).sample('a', 0).x === 12,
            'preview release during pause resumes from the actual frozen pose without a jump',
        );
        const CONTINUING_PREVIEW = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' }),
            CONTINUING_OWNER = { x: 0, y: 0 };
        CONTINUING_PREVIEW.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [{ id: 'a', generation: 0, type: Actor, source: CONTINUING_OWNER }],
            },
            0,
        );
        CONTINUING_OWNER.x = 10;
        CONTINUING_PREVIEW.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [{ id: 'a', generation: 0, type: Actor, source: CONTINUING_OWNER }],
            },
            100,
        );
        CONTINUING_PREVIEW.selectPreview([{ id: 'a', generation: 0 }]);
        CONTINUING_PREVIEW.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 110,
                phaseStartMs: 100,
                stepMs: 100,
                entities: [{ id: 'a', generation: 0, type: Actor, source: { x: 20, y: 0 } }],
            },
            110,
        );
        CHECK(CONTINUING_PREVIEW.frame(120).sample('a', 0).x === 12, 'preview is moving before pause');
        CONTINUING_PREVIEW.setRate(0, 120);
        CHECK(CONTINUING_PREVIEW.frame(300).sample('a', 0).x === 12, 'active preview is frozen while paused');
        CONTINUING_PREVIEW.setRate(1, 300);
        CHECK(
            CONTINUING_PREVIEW.frame(300).sample('a', 0).x === 12 &&
                CONTINUING_PREVIEW.frame(320).sample('a', 0).x === 14,
            'active preview resumes without counting paused wall time',
        );
        CONTINUING_PREVIEW.setRate(0, 320);
        CONTINUING_PREVIEW.capturePreview(
            {
                revision: 0,
                sequence: 1,
                timeMs: 400,
                phaseStartMs: 400,
                stepMs: 100,
                entities: [{ id: 'a', generation: 0, type: Actor, source: { x: 30, y: 0 } }],
            },
            400,
        );
        CHECK(CONTINUING_PREVIEW.frame(500).sample('a', 0).x === 14, 'new paused preview keeps the frozen frame');
        CONTINUING_PREVIEW.setRate(1, 500);
        CHECK(
            CONTINUING_PREVIEW.frame(500).sample('a', 0).x === 14 &&
                CONTINUING_PREVIEW.frame(550).sample('a', 0).x === 22,
            'new preview received during pause starts from the frozen pose on resume',
        );
        const SAME_TIME_PREVIEW = new PRESENTATION_RUNTIME({ stepMs: 100, delayMs: 200, clock: 'bounded' });
        const SAME_TIME_PUT = (i) =>
            SAME_TIME_PREVIEW.capture(
                {
                    revision: 0,
                    sequence: i,
                    timeMs: i * 100,
                    entities: [{ id: 'u', generation: 0, type: Actor, source: { x: i * 100, y: 0 } }],
                },
                200,
            );
        for (let i = 0; i <= 10; i++) {
            SAME_TIME_PUT(i);
        }
        SAME_TIME_PREVIEW.selectPreview([{ id: 'u', generation: 0 }]);
        SAME_TIME_PREVIEW.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 1000,
                phaseStartMs: 900,
                stepMs: 100,
                entities: [{ id: 'u', generation: 0, type: Actor, source: { x: 1500, y: 0 } }],
            },
            200,
        );
        SAME_TIME_PREVIEW.releasePreview(200);
        const PREVIEW_BEFORE_CAPTURE = SAME_TIME_PREVIEW.frame(200);
        CHECK(
            PREVIEW_BEFORE_CAPTURE.timeMs === 700 && PREVIEW_BEFORE_CAPTURE.sample('u', 0).x === 900,
            'preview is sampled on its bounded handoff clock',
        );
        SAME_TIME_PUT(11);
        const PREVIEW_AFTER_CAPTURE = SAME_TIME_PREVIEW.frame(200);
        CHECK(
            PREVIEW_AFTER_CAPTURE.timeMs === 800 &&
                Math.abs(PREVIEW_AFTER_CAPTURE.sample('u', 0).x - 933.3333333333334) < 1e-7,
            'same-wall catch-up invalidates the preview pose when display time advances',
        );
        const TIMELINE = new INTERPOLATION_TIMELINE({
            stepMs: 100,
            delayMs: 200,
            schema: {
                x: 'number',
            },
        });
        TIMELINE.accept(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [],
            },
            0,
        );
        TIMELINE.accept(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [
                    {
                        id: 's',
                        generation: 0,
                        values: {
                            x: 10,
                        },
                        initialValues: {
                            x: 0,
                        },
                    },
                ],
            },
            100,
        );
        const OUT = {};
        TIMELINE.sampleInto('s', 0, 225, OUT);
        CHECK(OUT.x === 2.5, 'low-level timeline uses same seeded interval');
        // A pending attack is one state: its shape, key and countdown must switch together.
        class Attacker extends R {
            static renderSchema = {
                x: R.POSITION_X,
                y: R.POSITION_Y,
                'pending.left': R.COUNTDOWN_SECONDS,
                'pending.total': R.STATE_KEY,
                'pending.target': R.STATE_KEY,
                'pending.tip.x': R.LINEAR,
                'optional.x': R.LINEAR,
            };
        }
        const ATTACK = new PRESENTATION_RUNTIME({
            stepMs: 100,
            delayMs: 200,
        });
        const A = {
            x: 0,
            y: 0,
            pending: {
                left: 0.1,
                total: 0.2,
                target: 2,
                tip: {
                    x: 5,
                },
            },
            optional: {
                x: 3,
            },
        };
        const PUBLISH = (sequence, timeMs) =>
            ATTACK.capture(
                {
                    revision: 0,
                    sequence,
                    timeMs,
                    entities: [
                        {
                            id: 'a',
                            generation: 0,
                            type: Attacker,
                            source: A,
                        },
                    ],
                },
                timeMs,
            );
        PUBLISH(0, 0);
        A.x = 10;
        A.pending = null;
        A.optional = null;
        PUBLISH(1, 100);
        A.x = 20;
        A.pending = {
            left: 0.3,
            total: 0.4,
            target: 3,
            tip: {
                x: 9,
            },
        };
        delete A.optional;
        PUBLISH(2, 200);
        const READ = (now) => {
            const F = ATTACK.frame(now),
                P = F.sample('a', 0);
            CHECK(F.modelFor(A) === P && F.modelFor(P) === P, 'same display time uses same attack model');
            return P;
        };
        let p = READ(250);
        CHECK(
            p.x === 5 &&
                p.pending.left === 0.1 &&
                p.pending.total === 0.2 &&
                p.pending.tip.x === 5 &&
                p.optional.x === 3,
            'object to null retains complete old state while body moves',
        );
        CHECK(Number.isFinite(1 - p.pending.left / p.pending.total), 'pending attack/muzzle charge stays finite');
        p = READ(300);
        CHECK(p.pending === null && p.optional === null, 'object to null switches exactly at display boundary');
        A.x = 30;
        A.pending = {
            left: 0.5,
            total: 0.6,
            target: 4,
            tip: null,
        };
        A.optional = {
            x: 7,
        };
        PUBLISH(3, 300);
        CHECK(READ(399).pending === null, 'null to object stays null until its display boundary');
        p = READ(400);
        CHECK(
            p.pending.left === 0.3 && p.pending.total === 0.4 && p.pending.tip.x === 9 && !('optional' in p),
            'null to object publishes complete target, missing shape preserved',
        );
        p = READ(450);
        CHECK(
            p.pending.target === 3 && p.pending.left === 0.3 && p.pending.tip.x === 9,
            'STATE_KEY holds sibling fields and nested shape atomically',
        );
        p = READ(500);
        CHECK(
            p.pending.target === 4 && p.pending.left === 0.5 && p.pending.tip === null && p.optional.x === 7,
            'new keyed state and optional structure arrive together',
        );
        const SEEDED = new PRESENTATION_RUNTIME({
            stepMs: 100,
            delayMs: 100,
        });
        SEEDED.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 100,
                entities: [
                    {
                        id: 'a',
                        generation: 0,
                        type: Attacker,
                        source: A,
                        initialTimeMs: 0,
                        initialSource: {
                            x: 0,
                            y: 0,
                            pending: null,
                        },
                    },
                ],
            },
            100,
        );
        CHECK(
            SEEDED.frame(150).sample('a', 0).pending === null,
            'explicit birth source keeps its initial optional shape',
        );
        CHECK(
            SEEDED.frame(200).sample('a', 0).pending.total === 0.6,
            'explicit birth shape reaches target at display time',
        );
        const RELEASED = new PRESENTATION_RUNTIME({
                stepMs: 100,
                delayMs: 100,
            }),
            OWNER = {
                x: 0,
                y: 0,
                pending: {
                    left: 0.1,
                    total: 0.2,
                    target: 2,
                },
            };
        RELEASED.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                mode: 'reset',
                entities: [
                    {
                        id: 'a',
                        generation: 0,
                        type: Attacker,
                        source: OWNER,
                    },
                ],
            },
            0,
        );
        OWNER.x = 10;
        OWNER.pending = null;
        RELEASED.capture(
            {
                revision: 0,
                sequence: 1,
                timeMs: 100,
                entities: [
                    {
                        id: 'a',
                        generation: 0,
                        type: Attacker,
                        source: OWNER,
                    },
                ],
            },
            100,
        );
        RELEASED.selectPreview([
            {
                id: 'a',
                generation: 0,
            },
        ]);
        RELEASED.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 110,
                phaseStartMs: 100,
                stepMs: 100,
                entities: [
                    {
                        id: 'a',
                        generation: 0,
                        type: Attacker,
                        source: {
                            ...OWNER,
                            x: 20,
                        },
                    },
                ],
            },
            110,
        );
        CHECK(
            RELEASED.frame(115).sample('a', 0).pending === null,
            'immediate preview has its complete target structure',
        );
        RELEASED.releasePreview(120);
        p = RELEASED.frame(150).sample('a', 0);
        CHECK(
            p.x > 10 && p.x < 20 && p.pending === null,
            'preview release corrects its local pose without resurrecting buffered attack state',
        );
        p = RELEASED.frame(200).sample('a', 0);
        CHECK(p.x === 10 && p.pending === null, 'released authority reaches its original display boundary');
        return {
            boundedClock: 'PASS',
            boundedPauseAndRates: 'PASS',
            boundedPreviewHandoff: 'PASS',
            birth: 'PASS',
            tickBoundary: 'PASS',
            strictPath: 'PASS',
            pathCorner: 'PASS',
            lifetime: 'PASS',
            rollback: 'PASS',
            teleport: 'PASS',
            preview: 'PASS',
            frameGuard: 'PASS',
            atomicAttackState: 'PASS',
        };
    });
}

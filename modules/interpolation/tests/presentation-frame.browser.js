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

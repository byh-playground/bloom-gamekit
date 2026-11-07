export async function runPresentationChecks(page) {
    return page.evaluate(async () => {
        const {
            CameraViewport: CAMERA_VIEWPORT,
            OrthographicProjection: ORTHOGRAPHIC_PROJECTION,
            CollisionBoom: COLLISION_BOOM,
        } = await import('/dist/camera.js');
        const { PresentationEventQueue: PRESENTATION_EVENT_QUEUE } = await import('/dist/presentation-events.js');
        const { DOMHud: DOM_HUD } = await import('/dist/hud.js');
        const {
            DiagnosticRing: DIAGNOSTIC_RING,
            PerformanceProfiler: PERFORMANCE_PROFILER,
            copyDiagnostic: COPY_DIAGNOSTIC,
        } = await import('/dist/debug-tools.js');
        const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import('/dist/rendering.js');
        const CHECK = (condition, message) => {
            if (!condition) {
                throw Error(message);
            }
        };
        const HOST = document.createElement('div');
        HOST.style.cssText = 'position:relative;width:100px;height:100px';
        document.body.append(HOST);
        const CANVAS = document.createElement('canvas');
        CANVAS.style.cssText = 'width:100px;height:100px;aspect-ratio:auto';
        HOST.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                antialias: false,
                preserveDrawingBuffer: true,
            }),
            RENDERER = new VECTOR_CONTEXT(DEVICE);
        const CAMERA = new CAMERA_VIEWPORT({
            projection: new ORTHOGRAPHIC_PROJECTION(),
            width: 100,
            height: 100,
            dpr: 2,
            x: 20,
            y: 20,
            zoom: 1.5,
            rotation: 0.2,
        });
        CAMERA.setShake(3, -2);
        CAMERA.resizeCanvas(CANVAS);
        const HUD = new DOM_HUD({
            camera: CAMERA,
            root: HOST,
        });
        const WORLD = {
            x: 23,
            y: 40,
            z: 10,
        };
        const PLANE = {},
            SCREEN = {};
        const LABEL = HUD.add('world', {
            anchor: WORLD,
            text: '42',
        });
        HUD.update();
        const WRITES = HUD.stats.writes;
        HUD.update();
        CHECK(WRITES === HUD.stats.writes, 'stationary HUD must not rewrite DOM');
        CAMERA.projection.projectInto(WORLD.x, WORLD.y, WORLD.z, PLANE);
        CAMERA.worldToScreenInto(WORLD.x, WORLD.y, WORLD.z, SCREEN);
        RENDERER.beginFrame();
        CAMERA.applyToContext(RENDERER);
        RENDERER.fillStyle = [0, 1, 0, 1];
        RENDERER.fillRect(PLANE.x - 3, PLANE.y - 3, 6, 6);
        RENDERER.endFrame();
        const PIXEL = new Uint8Array(4);
        DEVICE.gl.readPixels(
            Math.floor(SCREEN.x * 2),
            CANVAS.height - 1 - Math.floor(SCREEN.y * 2),
            1,
            1,
            DEVICE.gl.RGBA,
            DEVICE.gl.UNSIGNED_BYTE,
            PIXEL,
        );
        CHECK(
            PIXEL[0] === 0 && PIXEL[1] === 255 && PIXEL[2] === 0 && PIXEL[3] === 255,
            `shared XYZ camera GPU pixel ${[...PIXEL]} at ${SCREEN.x},${SCREEN.y}`,
        );
        const LABEL_BOUNDS = LABEL.getBoundingClientRect(),
            HOST_BOUNDS = HOST.getBoundingClientRect();
        const ANCHOR_X = LABEL_BOUNDS.left + LABEL_BOUNDS.width / 2 - HOST_BOUNDS.left,
            ANCHOR_Y = LABEL_BOUNDS.bottom - HOST_BOUNDS.top;
        CHECK(
            Math.abs(ANCHOR_X - SCREEN.x) < 0.02 && Math.abs(ANCHOR_Y - SCREEN.y) < 0.02,
            `shared XYZ HUD visible anchor ${ANCHOR_X},${ANCHOR_Y} expected ${SCREEN.x},${SCREEN.y}; CSS ${LABEL.style.transform}`,
        );
        // 같은 화면에서 벽 접근 → 모서리 통과 → 복원 → 재시작을 재생합니다.
        // 장애물 거리는 게임 fixture 소유이며, boom 거리를 viewport 배율에 적용합니다.
        // 실제 3D sphere cast와 방향 선택은 소비자 게임 E2E의 책임입니다.
        const BOOM = new COLLISION_BOOM({
            distance: 6,
            holdMs: 150,
            releaseHalfLifeMs: 180,
        });
        const BOOM_DISTANCES = [];
        const DRAW_BOOM_FRAME = async (clearDistance, elapsedMs) => {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const DISTANCE = BOOM.update(6, clearDistance, elapsedMs);
            CHECK(DISTANCE <= Math.min(6, clearDistance), 'boom never exceeds the current probe clearance');
            CAMERA.setCamera({
                zoom: 3 / DISTANCE,
            });
            HUD.update();
            CAMERA.worldToScreenInto(WORLD.x, WORLD.y, WORLD.z, SCREEN);
            RENDERER.beginFrame();
            CAMERA.applyToContext(RENDERER);
            RENDERER.fillStyle = [0, 1, 0, 1];
            RENDERER.fillRect(PLANE.x - 3, PLANE.y - 3, 6, 6);
            RENDERER.endFrame();
            const RGBA_LOCAL = new Uint8Array(4);
            DEVICE.gl.readPixels(
                Math.floor(SCREEN.x * 2),
                CANVAS.height - 1 - Math.floor(SCREEN.y * 2),
                1,
                1,
                DEVICE.gl.RGBA,
                DEVICE.gl.UNSIGNED_BYTE,
                RGBA_LOCAL,
            );
            CHECK(
                RGBA_LOCAL[1] === 255 && RGBA_LOCAL[3] === 255,
                'boom frame must draw the target at its projected GPU pixel',
            );
            const BOUNDS = LABEL.getBoundingClientRect(),
                HOST_BOX = HOST.getBoundingClientRect();
            CHECK(
                Math.abs(BOUNDS.left + BOUNDS.width / 2 - HOST_BOX.left - SCREEN.x) < 0.02 &&
                    Math.abs(BOUNDS.bottom - HOST_BOX.top - SCREEN.y) < 0.02,
                'boom frame keeps HUD on the rendered target',
            );
            BOOM_DISTANCES.push(DISTANCE);
            return DISTANCE;
        };
        CHECK((await DRAW_BOOM_FRAME(2, 0)) === 2, 'new wall retracts even while paused');
        CHECK((await DRAW_BOOM_FRAME(4, 70)) === 2, 'brief corner clearance holds the nearest point');
        CHECK((await DRAW_BOOM_FRAME(2, 70)) === 2, 'nearest corner re-observation refreshes hold');
        CHECK((await DRAW_BOOM_FRAME(6, 100)) === 2, 'camera stays held immediately after leaving the corner');
        const RECOVERED = await DRAW_BOOM_FRAME(6, 230);
        CHECK(Math.abs(RECOVERED - 4) < 1e-10, 'only time after the hold contributes to camera recovery');
        CHECK((await DRAW_BOOM_FRAME(1, 0)) === 1, 'a second wall safely interrupts recovery');
        BOOM.reset(6);
        CHECK((await DRAW_BOOM_FRAME(6, 0)) === 6, 'restart discards the old wall hold');
        CAMERA.setCamera({
            zoom: 1.5,
        });
        HUD.update();
        let starts = 0;
        let sounds = 0;
        let stops = 0;
        let failLateText = true;
        const QUEUE = new PRESENTATION_EVENT_QUEUE({
            retentionTicks: 3,
            adapters: {
                text: {
                    reversible: true,
                    start: (event) => {
                        if (event.sequence === 3 && failLateText) {
                            failLateText = false;
                            throw Error('temporary text allocation failure');
                        }
                        starts++;
                        return HUD.add(event.sequence, {
                            anchor: event.payload,
                            text: 'hit',
                        });
                    },
                    stop: (_, _reason, event) => {
                        stops++;
                        HUD.remove(event.sequence);
                    },
                },
                sound: {
                    start: () => {
                        sounds++;
                    },
                },
            },
        });
        const EVENT = {
            tick: 4,
            sequence: 1,
            entityId: 'actor',
            generation: 0,
            kind: 'text',
            policy: 'speculative',
            durationMs: 300,
            payload: WORLD,
        };
        QUEUE.emit(EVENT);
        QUEUE.emit({
            ...EVENT,
            kind: 'sound',
            policy: 'confirmed',
        });
        QUEUE.beginRollback(4);
        QUEUE.emit(EVENT);
        QUEUE.endRollback();
        CHECK(starts === 1 && sounds === 0, 'resim must dedup VFX and cancel absent pending SFX');
        QUEUE.beginRollback(4);
        QUEUE.endRollback();
        CHECK(stops === 1 && HUD.stats.nodes === 1, 'absent speculative resource cancelled');
        QUEUE.emit({
            ...EVENT,
            tick: 5,
            kind: 'sound',
            policy: 'confirmed',
        });
        QUEUE.confirmThrough(5);
        CHECK(sounds === 1, 'only valid confirmed sound starts');
        QUEUE.emit({
            ...EVENT,
            tick: 5,
            kind: 'sound',
            policy: 'confirmed',
        });
        CHECK(sounds === 1, 'confirmed sound cannot replay');
        // The same visible hit flow survives late delivery, retry, rollback and a long-lived label.
        let failedLateStart = false;
        try {
            QUEUE.emit({
                ...EVENT,
                tick: 5,
                sequence: 3,
                policy: 'confirmed',
                durationMs: 0,
            });
        } catch {
            failedLateStart = true;
        }
        QUEUE.confirmThrough(5);
        CHECK(
            failedLateStart && starts === 2 && HUD.stats.nodes === 1,
            'late confirmed start retries at same watermark and expires once',
        );
        // A confirmed hit/one-shot must wait for the same simulation-time frame as the body.
        // Delayed delivery, a pause, rollback and an epoch reset exercise the public contract.
        const DISPLAY_LOG = [],
            DISPLAY_ADAPTER = {
                reversible: true,
                start(event, timeMs, ageMs) {
                    DISPLAY_LOG.push(['start', event.sequence, timeMs, ageMs]);
                    return { sequence: event.sequence };
                },
                update(handle, ageMs, event) {
                    DISPLAY_LOG.push(['update', handle.sequence, ageMs]);
                    if (event.sequence === 1 && ageMs >= 80) {
                        DISPLAY_QUEUE.finish(event);
                    }
                },
                stop(handle, reason) {
                    DISPLAY_LOG.push(['stop', handle.sequence, reason]);
                },
            },
            DISPLAY_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 150 },
                adapters: { hit: DISPLAY_ADAPTER },
            }),
            DISPLAY_EVENT = {
                tick: 2,
                sequence: 1,
                entityId: 'visible-actor',
                generation: 0,
                kind: 'hit',
                durationMs: 300,
            };
        DISPLAY_QUEUE.present({ revision: 0, timeMs: -20 });
        DISPLAY_QUEUE.emit(DISPLAY_EVENT);
        DISPLAY_QUEUE.emit({ ...DISPLAY_EVENT, sequence: 2, durationMs: 0 });
        DISPLAY_QUEUE.confirmThrough(2);
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 195 });
        CHECK(DISPLAY_LOG.length === 0, 'confirmed effects wait for their displayed tick');
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 216.7 });
        CHECK(
            DISPLAY_LOG.filter((entry) => entry[0] === 'start')
                .map((entry) => entry[1])
                .join(',') === '1,2' &&
                Math.abs(DISPLAY_LOG[0][3] - 16.7) < 0.001 &&
                DISPLAY_LOG.some((entry) => entry[0] === 'stop' && entry[1] === 2),
            'same-tick effects start in sequence at their original age; one-shot survives fractional frames',
        );
        DISPLAY_QUEUE.emit({ ...DISPLAY_EVENT, sequence: 9, durationMs: 0 });
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 216.7 });
        CHECK(
            DISPLAY_LOG.filter((entry) => entry[0] === 'start' && entry[1] === 9).length === 1,
            'a newly confirmed event from the same tick is not mistaken for an already delivered batch',
        );
        DISPLAY_QUEUE.emit({ ...DISPLAY_EVENT, sequence: 2, durationMs: 0 });
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 280 });
        CHECK(
            DISPLAY_LOG.filter((entry) => entry[0] === 'start' && entry[1] === 2).length === 1 &&
                DISPLAY_LOG.filter((entry) => entry[0] === 'stop' && entry[1] === 1).length === 1,
            'duplicate one-shot remains deduplicated and composite resource can finish inside update',
        );
        DISPLAY_QUEUE.emit({ ...DISPLAY_EVENT, tick: 1, sequence: 3, durationMs: 0 });
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 280 });
        CHECK(
            !DISPLAY_LOG.some((entry) => entry[0] === 'start' && entry[1] === 3),
            'stale one-shot does not replay after a long display gap',
        );
        const REWOUND = { ...DISPLAY_EVENT, tick: 4, sequence: 4 };
        DISPLAY_QUEUE.emit(REWOUND);
        DISPLAY_QUEUE.confirmThrough(4);
        DISPLAY_QUEUE.present({ revision: 0, timeMs: 420 });
        DISPLAY_QUEUE.present({ revision: 1, timeMs: 200 });
        DISPLAY_QUEUE.present({ revision: 1, timeMs: 420 });
        DISPLAY_QUEUE.emit(REWOUND);
        CHECK(
            DISPLAY_LOG.filter((entry) => entry[0] === 'start' && entry[1] === 4).length === 1 &&
                DISPLAY_LOG.some((entry) => entry[0] === 'stop' && entry[1] === 4 && entry[2] === 'timeline-reset'),
            'rollback display epoch releases active visuals without replaying confirmed identity',
        );
        const SPECULATIVE = { ...DISPLAY_EVENT, tick: 5, sequence: 5, policy: 'speculative' };
        DISPLAY_QUEUE.emit(SPECULATIVE);
        DISPLAY_QUEUE.present({ revision: 1, timeMs: 500 });
        DISPLAY_QUEUE.beginRollback(5);
        DISPLAY_QUEUE.endRollback();
        DISPLAY_QUEUE.emit(SPECULATIVE);
        DISPLAY_QUEUE.present({ revision: 1, timeMs: 500 });
        CHECK(
            DISPLAY_LOG.filter((entry) => entry[0] === 'start' && entry[1] === 5).length === 2 &&
                DISPLAY_LOG.some((entry) => entry[0] === 'stop' && entry[1] === 5 && entry[2] === 'cancelled'),
            'rollback cancels and later valid speculative event restarts',
        );
        DISPLAY_QUEUE.dispose();
        // A screen may attach after a network handshake and be hidden while authority continues.
        // Rejected-input feedback remains immediate, while transient visuals never accumulate unseen.
        const HIDDEN_LOG = [],
            CLASSIFICATION_ERROR = new TypeError('presentation policy failed'),
            HIDDEN_QUEUE = new PRESENTATION_EVENT_QUEUE({
                retentionTicks: 3,
                adapters: {
                    frame: {
                        start(event, timeMs, ageMs) {
                            HIDDEN_LOG.push([event.payload, timeMs, ageMs]);
                            return { payload: event.payload };
                        },
                    },
                },
            }),
            HIDDEN_EVENT = {
                tick: 1,
                sequence: 1,
                entityId: 'peer',
                generation: 0,
                kind: 'frame',
                durationMs: 0,
                payload: 'visual',
            };
        HIDDEN_QUEUE.configureDisplay({
            stepMs: 100,
            maxLatenessMs: 250,
            classify(event) {
                if (event.payload === 'bad-classifier') {
                    throw CLASSIFICATION_ERROR;
                }
                return event.payload === 'rejected'
                    ? { delivery: 'confirmation', durationMs: 0 }
                    : { delivery: 'presentation', durationMs: Infinity };
            },
        });
        HIDDEN_QUEUE.update(100000);
        HIDDEN_QUEUE.present({ revision: -1, timeMs: null });
        HIDDEN_QUEUE.present({ revision: 0, timeMs: 0 });
        let classificationThrow = null;
        try {
            HIDDEN_QUEUE.emit({ ...HIDDEN_EVENT, payload: 'bad-classifier' });
        } catch (error) {
            classificationThrow = error;
        }
        CHECK(classificationThrow === CLASSIFICATION_ERROR && HIDDEN_QUEUE.size === 0, 'classifier error is atomic');
        HIDDEN_QUEUE.emit(HIDDEN_EVENT);
        let identityPolicyRejected = false;
        try {
            HIDDEN_QUEUE.emit({ ...HIDDEN_EVENT, payload: 'rejected' });
        } catch {
            identityPolicyRejected = true;
        }
        CHECK(identityPolicyRejected && HIDDEN_QUEUE.size === 1, 'stable event identity cannot change delivery policy');
        HIDDEN_QUEUE.confirmThrough(1);
        HIDDEN_QUEUE.setPresentationActive(false);
        for (let tick = 2; tick <= 200; tick++) {
            HIDDEN_QUEUE.emit({ ...HIDDEN_EVENT, tick });
            HIDDEN_QUEUE.confirmThrough(tick);
        }
        HIDDEN_QUEUE.emit({ ...HIDDEN_EVENT, tick: 201, payload: 'rejected' });
        HIDDEN_QUEUE.confirmThrough(201);
        CHECK(
            HIDDEN_LOG.length === 1 &&
                HIDDEN_LOG[0][0] === 'rejected' &&
                HIDDEN_LOG[0][1] === 100000 &&
                HIDDEN_QUEUE.size <= 4,
            'hidden authority keeps actionable confirmation and retires transient effects with bounded memory',
        );
        HIDDEN_QUEUE.setPresentationActive(true);
        HIDDEN_QUEUE.present({ revision: 1, timeMs: 20100 });
        HIDDEN_QUEUE.emit({ ...HIDDEN_EVENT, tick: 202 });
        HIDDEN_QUEUE.confirmThrough(202);
        HIDDEN_QUEUE.present({ revision: 1, timeMs: 20200 });
        CHECK(
            HIDDEN_LOG.length === 2 &&
                HIDDEN_LOG[1][0] === 'visual' &&
                HIDDEN_LOG[1][1] === 20200 &&
                HIDDEN_LOG[1][2] === 0,
            'resume starts new effects on simulation clock without replaying hidden events or mixing wall time',
        );
        let lateConfigRejected = false;
        try {
            HIDDEN_QUEUE.configureDisplay({ stepMs: 100, maxLatenessMs: 250 });
        } catch {
            lateConfigRejected = true;
        }
        CHECK(lateConfigRejected, 'display policy cannot change after events or confirmation');
        HIDDEN_QUEUE.dispose();
        const HANDSHAKE_QUEUE = new PRESENTATION_EVENT_QUEUE({ adapters: { frame: { start() {} } } });
        HANDSHAKE_QUEUE.emit(HIDDEN_EVENT);
        let handshakeRaceRejected = false;
        try {
            HANDSHAKE_QUEUE.configureDisplay({ stepMs: 100, maxLatenessMs: 250 });
        } catch {
            handshakeRaceRejected = true;
        }
        CHECK(
            handshakeRaceRejected && HANDSHAKE_QUEUE.size === 1,
            'late handshake cannot reinterpret an existing event',
        );
        HANDSHAKE_QUEUE.dispose();
        let failConfirmation = true;
        const ORIGINAL_FAILURE = new TypeError('confirmation adapter failure'),
            RETRIES = [],
            RETRY_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: {
                    stepMs: 100,
                    maxLatenessMs: 200,
                    classify: () => ({ delivery: 'confirmation', durationMs: 0 }),
                },
                adapters: {
                    frame: {
                        start(_event, nowMs) {
                            if (failConfirmation) {
                                failConfirmation = false;
                                throw ORIGINAL_FAILURE;
                            }
                            RETRIES.push(nowMs);
                        },
                    },
                },
            });
        RETRY_QUEUE.update(50000);
        RETRY_QUEUE.present({ revision: 0, timeMs: 100 });
        RETRY_QUEUE.emit(HIDDEN_EVENT);
        let confirmationFailure = null;
        try {
            RETRY_QUEUE.confirmThrough(1);
        } catch (error) {
            confirmationFailure = error;
        }
        RETRY_QUEUE.confirmThrough(1);
        RETRY_QUEUE.confirmThrough(1);
        CHECK(
            confirmationFailure === ORIGINAL_FAILURE && RETRIES.join(',') === '50000',
            'confirmation failure preserves its original exception and retries once on the wall clock',
        );
        RETRY_QUEUE.dispose();
        let failSpeculativeConfirm = true;
        const SPEC_CONFIRM_ERROR = new TypeError('speculative confirmation failed'),
            SPEC_CONFIRM_LOG = [],
            SPEC_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        reversible: true,
                        start: () => {
                            SPEC_CONFIRM_LOG.push('start');
                            return {};
                        },
                        confirm: () => {
                            SPEC_CONFIRM_LOG.push('confirm');
                            if (failSpeculativeConfirm) {
                                failSpeculativeConfirm = false;
                                throw SPEC_CONFIRM_ERROR;
                            }
                        },
                        stop: () => {},
                    },
                },
            }),
            SPEC_EVENT = { ...HIDDEN_EVENT, policy: 'speculative', durationMs: 1000 };
        SPEC_QUEUE.emit(SPEC_EVENT);
        SPEC_QUEUE.present({ revision: 0, timeMs: 100 });
        let specConfirmFailure = null;
        try {
            SPEC_QUEUE.confirmThrough(1);
        } catch (error) {
            specConfirmFailure = error;
        }
        SPEC_QUEUE.confirmThrough(1);
        SPEC_QUEUE.confirmThrough(1);
        CHECK(
            specConfirmFailure === SPEC_CONFIRM_ERROR && SPEC_CONFIRM_LOG.join(',') === 'start,confirm,confirm',
            'failed confirmation retries the same speculative resource without restarting it',
        );
        SPEC_QUEUE.dispose();
        const HIDDEN_SPEC_LOG = [],
            HIDDEN_SPEC_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        reversible: true,
                        start: () => HIDDEN_SPEC_LOG.push('start'),
                        stop: (_handle, reason) => HIDDEN_SPEC_LOG.push(reason),
                    },
                },
            }),
            HIDDEN_SPEC_EVENT = { ...HIDDEN_EVENT, tick: 10, policy: 'speculative', durationMs: 1000 };
        HIDDEN_SPEC_QUEUE.emit(HIDDEN_SPEC_EVENT);
        HIDDEN_SPEC_QUEUE.present({ revision: 0, timeMs: 1000 });
        HIDDEN_SPEC_QUEUE.setPresentationActive(false);
        HIDDEN_SPEC_QUEUE.beginRollback(10);
        HIDDEN_SPEC_QUEUE.emit(HIDDEN_SPEC_EVENT);
        HIDDEN_SPEC_QUEUE.endRollback();
        HIDDEN_SPEC_QUEUE.confirmThrough(10);
        HIDDEN_SPEC_QUEUE.setPresentationActive(true);
        HIDDEN_SPEC_QUEUE.present({ revision: 1, timeMs: 1000 });
        HIDDEN_SPEC_QUEUE.emit(HIDDEN_SPEC_EVENT);
        CHECK(
            HIDDEN_SPEC_LOG.join(',') === 'start,hidden',
            'hidden speculative effects release once and confirmation does not replay their identity',
        );
        HIDDEN_SPEC_QUEUE.dispose();
        const RESET_LOG = [],
            RESET_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        start(event, timeMs, ageMs) {
                            RESET_LOG.push([event.tick, timeMs, ageMs]);
                        },
                    },
                },
            });
        RESET_QUEUE.emit({ ...HIDDEN_EVENT, tick: 5 });
        RESET_QUEUE.confirmThrough(5);
        RESET_QUEUE.present({ revision: 0, timeMs: 500 });
        CHECK(
            RESET_LOG.length === 1 && RESET_LOG[0][1] === 500 && RESET_LOG[0][2] === 0,
            'an initial snapped model and its same-tick event start on the same display frame',
        );
        RESET_QUEUE.dispose();
        const BOUNDARY_STEP = 1000 / 30,
            BOUNDARY_TIME = 29 * BOUNDARY_STEP,
            BOUNDARY_AGES = [],
            BOUNDARY_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: BOUNDARY_STEP, maxLatenessMs: BOUNDARY_STEP },
                adapters: { frame: { start: (_event, _timeMs, ageMs) => BOUNDARY_AGES.push(ageMs) } },
            });
        BOUNDARY_QUEUE.emit({ ...HIDDEN_EVENT, tick: 29 });
        BOUNDARY_QUEUE.confirmThrough(29);
        BOUNDARY_QUEUE.present({ revision: 0, timeMs: BOUNDARY_TIME - BOUNDARY_STEP / 1000 });
        CHECK(BOUNDARY_AGES.length === 0, 'an event is not delivered genuinely before its tick');
        BOUNDARY_QUEUE.present({
            revision: 0,
            timeMs: BOUNDARY_TIME - Number.EPSILON * BOUNDARY_TIME,
        });
        CHECK(
            BOUNDARY_AGES.length === 1 && BOUNDARY_AGES[0] === 0,
            'fractional 30 TPS rounding at the tick boundary does not delay the event or produce negative age',
        );
        BOUNDARY_QUEUE.dispose();
        const PHASE_LOG = [],
            PHASE_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: {
                    stepMs: 100,
                    maxLatenessMs: 200,
                    classify: (event) => ({ phase: event.payload.phase }),
                },
                adapters: {
                    frame: {
                        start: (event, _timeMs, ageMs) => PHASE_LOG.push([event.sequence, ageMs]),
                    },
                },
            });
        PHASE_QUEUE.emit({ ...HIDDEN_EVENT, tick: 3, sequence: 1, payload: { phase: 0.8 } });
        PHASE_QUEUE.emit({ ...HIDDEN_EVENT, tick: 3, sequence: 2, payload: { phase: 0.2 } });
        PHASE_QUEUE.confirmThrough(3);
        PHASE_QUEUE.present({ revision: 0, timeMs: 219 });
        CHECK(PHASE_LOG.length === 0, 'subtick contact cannot play before its actual contact');
        PHASE_QUEUE.present({ revision: 0, timeMs: 281 });
        CHECK(
            PHASE_LOG.length === 2 &&
                PHASE_LOG[0][0] === 2 &&
                PHASE_LOG[1][0] === 1 &&
                Math.abs(PHASE_LOG[0][1] - 61) < 0.001 &&
                Math.abs(PHASE_LOG[1][1] - 1) < 0.001,
            'contacts in the same authority tick play in subtick order and use the original age',
        );
        let phaseRejected = false;
        try {
            PHASE_QUEUE.emit({ ...HIDDEN_EVENT, tick: 4, payload: { phase: 1.1 } });
        } catch {
            phaseRejected = true;
        }
        CHECK(phaseRejected, 'invalid subtick time is rejected before journal mutation');
        PHASE_QUEUE.dispose();
        const CORRECTION_AGES = [],
            CORRECTION_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200, classify: (event) => ({ phase: event.payload.phase }) },
                adapters: {
                    frame: {
                        reversible: true,
                        start: () => ({}),
                        reconcile: () => {},
                        update: (_handle, ageMs) => CORRECTION_AGES.push(ageMs),
                        stop: () => {},
                    },
                },
            }),
            CORRECTION_EVENT = {
                ...HIDDEN_EVENT,
                tick: 2,
                policy: 'speculative',
                durationMs: 1000,
                payload: { phase: 0.2 },
            };
        CORRECTION_QUEUE.emit(CORRECTION_EVENT);
        CORRECTION_QUEUE.present({ revision: 0, timeMs: 140 });
        CORRECTION_QUEUE.emit({ ...CORRECTION_EVENT, payload: { phase: 0.8 } });
        CORRECTION_QUEUE.present({ revision: 0, timeMs: 150 });
        CHECK(
            CORRECTION_AGES.length === 2 &&
                Math.abs(CORRECTION_AGES[0] - 20) < 0.001 &&
                Math.abs(CORRECTION_AGES[1] - 20) < 0.001,
            'corrected subtick keeps a running effect age monotonic while its new clock catches up',
        );
        CORRECTION_QUEUE.dispose();
        let failDuringStart = true;
        const START_FAILURE = new Error('start failed after synchronous completion'),
            START_LOG = [],
            START_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        start(event) {
                            CHECK(START_QUEUE.finish(event), 'finish during start must be accepted once');
                            CHECK(!START_QUEUE.finish(event), 'repeated finish during start is ignored');
                            if (failDuringStart) {
                                failDuringStart = false;
                                throw START_FAILURE;
                            }
                            return { id: event.sequence };
                        },
                        stop(handle, reason) {
                            START_LOG.push([handle.id, reason]);
                        },
                    },
                },
            }),
            START_EVENT = { ...HIDDEN_EVENT, tick: 1, durationMs: 1000 };
        START_QUEUE.emit(START_EVENT);
        START_QUEUE.confirmThrough(1);
        let startFailure = null;
        try {
            START_QUEUE.present({ revision: 0, timeMs: 100 });
        } catch (error) {
            startFailure = error;
        }
        START_QUEUE.present({ revision: 0, timeMs: 100 });
        START_QUEUE.emit(START_EVENT);
        CHECK(
            startFailure === START_FAILURE &&
                START_LOG.length === 1 &&
                START_LOG[0][1] === 'expired' &&
                START_QUEUE.active.size === 0,
            'finish during start retries after the original error, then releases one resource without replay',
        );
        START_QUEUE.dispose();
        const HIDE_DURING_START = [],
            REENTRANT_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        start(event) {
                            HIDE_DURING_START.push(['start', event.sequence]);
                            REENTRANT_QUEUE.setPresentationActive(false);
                            return { id: event.sequence };
                        },
                        stop(handle, reason) {
                            HIDE_DURING_START.push(['stop', handle.id, reason]);
                        },
                    },
                },
            });
        REENTRANT_QUEUE.emit({ ...HIDDEN_EVENT, tick: 1, sequence: 1, durationMs: 1000 });
        REENTRANT_QUEUE.emit({ ...HIDDEN_EVENT, tick: 1, sequence: 2, durationMs: 1000 });
        REENTRANT_QUEUE.confirmThrough(1);
        REENTRANT_QUEUE.present({ revision: 0, timeMs: 100 });
        CHECK(
            JSON.stringify(HIDE_DURING_START) ===
                JSON.stringify([
                    ['start', 1],
                    ['stop', 1, 'hidden'],
                ]) && REENTRANT_QUEUE.active.size === 0,
            'hiding inside start releases its newly returned resource and does not start the rest of the batch',
        );
        REENTRANT_QUEUE.dispose();
        const REENTRANT_CONFIRM_LOG = [],
            REENTRANT_CONFIRM_QUEUE = new PRESENTATION_EVENT_QUEUE({
                retentionTicks: 2,
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        reversible: true,
                        start() {
                            REENTRANT_CONFIRM_QUEUE.confirmThrough(1);
                            return {};
                        },
                        confirm: () => REENTRANT_CONFIRM_LOG.push('confirm'),
                        stop: (_handle, reason) => REENTRANT_CONFIRM_LOG.push(reason),
                    },
                },
            }),
            REENTRANT_CONFIRM_EVENT = {
                ...HIDDEN_EVENT,
                tick: 1,
                policy: 'speculative',
                durationMs: 100000,
            };
        REENTRANT_CONFIRM_QUEUE.emit(REENTRANT_CONFIRM_EVENT);
        REENTRANT_CONFIRM_QUEUE.present({ revision: 0, timeMs: 100 });
        REENTRANT_CONFIRM_QUEUE.confirmThrough(4);
        CHECK(
            REENTRANT_CONFIRM_QUEUE.size === 1 &&
                REENTRANT_CONFIRM_QUEUE.active.size === 1 &&
                REENTRANT_CONFIRM_LOG.join(',') === 'confirm' &&
                REENTRANT_CONFIRM_QUEUE.finish(REENTRANT_CONFIRM_EVENT) &&
                REENTRANT_CONFIRM_QUEUE.size === 0,
            'confirmation during start retains the live resource beyond retention and confirms it once',
        );
        REENTRANT_CONFIRM_QUEUE.dispose();
        let reentrantAttempts = 0;
        const REENTRANT_FRAME = { revision: 0, timeMs: 100 },
            REENTRANT_FRAME_QUEUE = new PRESENTATION_EVENT_QUEUE({
                display: { stepMs: 100, maxLatenessMs: 200 },
                adapters: {
                    frame: {
                        start() {
                            reentrantAttempts++;
                            if (reentrantAttempts === 1) {
                                REENTRANT_FRAME_QUEUE.present(REENTRANT_FRAME);
                            }
                            return {};
                        },
                        stop() {},
                    },
                },
            }),
            REENTRANT_FRAME_EVENT = { ...HIDDEN_EVENT, tick: 1, durationMs: 1000 };
        REENTRANT_FRAME_QUEUE.emit(REENTRANT_FRAME_EVENT);
        REENTRANT_FRAME_QUEUE.confirmThrough(1);
        let reentrantFrameRejected = false;
        try {
            REENTRANT_FRAME_QUEUE.present(REENTRANT_FRAME);
        } catch (error) {
            reentrantFrameRejected = error.message === 'presentation frame is already being processed';
        }
        REENTRANT_FRAME_QUEUE.present(REENTRANT_FRAME);
        CHECK(
            reentrantFrameRejected && reentrantAttempts === 2 && REENTRANT_FRAME_QUEUE.active.size === 1,
            'reentrant frame processing fails fast, then retries the pending effect without leaking a handle',
        );
        REENTRANT_FRAME_QUEUE.dispose();
        const LONG_HIT = {
            ...EVENT,
            tick: 6,
            sequence: 2,
            durationMs: 100000,
        };
        QUEUE.emit(LONG_HIT);
        QUEUE.beginRollback(6);
        QUEUE.endRollback();
        QUEUE.emit(LONG_HIT);
        CHECK(starts === 4 && HUD.stats.nodes === 2, 'cancelled speculative identity restarts its visible resource');
        QUEUE.confirmThrough(20);
        QUEUE.collect();
        QUEUE.update(500);
        CHECK(HUD.stats.nodes === 2, 'retention cutoff must not remove a long-running confirmed label');
        const PROFILER = new PERFORMANCE_PROFILER({
            capacity: 3,
            maxStages: 2,
        });
        PROFILER.setEnabled(true);
        for (let frame = 0; frame < 5; frame++) {
            PROFILER.beginFrame({
                frame,
            });
            PROFILER.measure('hud', () => HUD.update());
            PROFILER.measure('render', () => {
                RENDERER.beginFrame();
                CAMERA.applyToContext(RENDERER);
                RENDERER.fillStyle = [0, 1, 0, 1];
                RENDERER.fillRect(PLANE.x - 3, PLANE.y - 3, 6, 6);
                RENDERER.endFrame();
            });
            CHECK(
                PROFILER.count('frames') &&
                    PROFILER.count('labels', HUD.stats.nodes) &&
                    !PROFILER.count('overflow') &&
                    PROFILER.count('frames'),
                'counter names bounded while existing counters accumulate',
            );
            PROFILER.endFrame();
        }
        const PROFILE = PROFILER.snapshot(),
            SUMMARY_ONLY = PROFILER.snapshot({
                limit: 0,
            });
        CHECK(
            PROFILE.frames.map((frame) => frame.sequence).join(',') === '3,4,5' &&
                PROFILE.frames.every((frame) => frame.counts.frames === 2),
            'wrapped profiler keeps recent frames in chronological order',
        );
        CHECK(
            SUMMARY_ONLY.frames.length === 0 &&
                SUMMARY_ONLY.retainedFrames === 3 &&
                SUMMARY_ONLY.summary.frames.count === 3 &&
                SUMMARY_ONLY.summary.stages.render.count === 3,
            'zero sample limit retains the full measured summary',
        );
        CHECK(
            QUEUE.finish(LONG_HIT) && HUD.stats.nodes === 1,
            'natural completion releases long-running label after cutoff',
        );
        PROFILER.clear();
        CHECK(PROFILER.snapshot().retainedFrames === 0, 'cleared profiler releases samples');
        PROFILER.dispose();
        const RING = new DIAGNOSTIC_RING({
            capacity: 2,
        });
        const TARGET = new EventTarget();
        const CLEANUP = RING.installGlobal(TARGET);
        TARGET.dispatchEvent(
            new ErrorEvent('error', {
                message: 'password=private user@example.com https://private.test',
            }),
        );
        CHECK(
            RING.total === 1 && RING.snapshot().blockerCount === 1 && !RING.format().includes('private'),
            'global diagnostics redacted and remain blocking by default',
        );
        RING.report('save recovered', {
            kind: 'save.load',
            visibility: 'notice',
        });
        CHECK(
            RING.snapshot().counts.notice === 1 && RING.snapshot().blockerCount === 1,
            'notice is retained without increasing the visible blocker count',
        );
        CLEANUP();
        TARGET.dispatchEvent(
            new ErrorEvent('error', {
                message: 'ignored',
            }),
        );
        CHECK(RING.total === 2, 'diagnostic listener restored');
        const TEXTAREA = document.createElement('textarea');
        HOST.append(TEXTAREA);
        const COPY = await COPY_DIAGNOSTIC(RING.format(), {
            clipboard: {
                writeText: async () => {
                    throw Error('denied');
                },
            },
            textarea: TEXTAREA,
        });
        CHECK(
            !COPY.copied && COPY.method === 'selection' && TEXTAREA.selectionEnd === TEXTAREA.value.length,
            'manual copy remains selected and truthful',
        );
        const EXTERNAL = document.createElement('span');
        EXTERNAL.textContent = 'original';
        EXTERNAL.style.color = 'red';
        HOST.append(EXTERNAL);
        HUD.add('external', {
            element: EXTERNAL,
            anchor: {
                space: 'screen',
                x: 2,
                y: 2,
            },
            text: 'changed',
        });
        HUD.update();
        HUD.remove('external');
        CHECK(
            EXTERNAL.textContent === 'original' && EXTERNAL.style.color === 'red' && !EXTERNAL.style.position,
            'external DOM state restored',
        );
        const ORIGINAL_PARENT = document.createElement('div');
        HOST.append(ORIGINAL_PARENT);
        const A = document.createElement('span'),
            B = document.createElement('span'),
            C = document.createElement('span');
        ORIGINAL_PARENT.append(A, B, C);
        HUD.add('a', {
            element: A,
            anchor: {
                space: 'screen',
                x: 1,
                y: 1,
            },
        });
        HUD.add('b', {
            element: B,
            anchor: {
                space: 'screen',
                x: 1,
                y: 1,
            },
        });
        HUD.remove('a');
        HUD.remove('b');
        CHECK(
            ORIGINAL_PARENT.children[0] === A &&
                ORIGINAL_PARENT.children[1] === B &&
                ORIGINAL_PARENT.children[2] === C &&
                ORIGINAL_PARENT.childNodes.length === 3,
            'multiple moved siblings restore exact order without leaked markers',
        );
        QUEUE.dispose();
        HUD.dispose();
        RING.dispose();
        RENDERER.dispose();
        DEVICE.dispose();
        HOST.remove();
        return {
            cameraHudPixel: [...PIXEL],
            collisionBoomDistances: BOOM_DISTANCES,
            stationaryDomWrites: WRITES,
            speculativeStarts: starts,
            cancelledResources: stops,
            confirmedSoundStarts: sounds,
            profilerRetainedFrames: PROFILE.retainedFrames,
            lateRetryAndLongResource: true,
            globalErrors: 'redacted and detached',
            clipboardFallback: COPY.method,
        };
    });
}

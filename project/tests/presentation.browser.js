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

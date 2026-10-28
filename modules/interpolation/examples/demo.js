import { createLoop } from '../../../dist/simloop.js';
import { InterpolationTimeline } from '../../../dist/interpolation.js';
import { WebGLDevice, VectorContext } from '../../../dist/rendering.js';
import { ActionState, createDOMInput } from '../../../dist/input.js';
import { OrthographicProjection, CameraViewport } from '../../../dist/camera.js';
import { PresentationEventQueue } from '../../../dist/presentation-events.js';
import { DOMHud } from '../../../dist/hud.js';
import { DiagnosticRing } from '../../../dist/debug-tools.js';

// This adapter is owned by the game. A Worker timestamp is simulation metadata only.
export function createPresentation(stepMs = 100) {
    const TIMELINE = new InterpolationTimeline({
        stepMs,
        schema: {
            x: 'number',
            y: 'number',
            z: 'number',
            health: 'number',
            angle: 'angle',
            state: 'discrete',
        },
    });
    const POSE = {}; // Shared by camera, body and shadow. Reused every frame.
    return {
        timeline: TIMELINE,
        pose: POSE,
        receive(packet, receiptMs) {
            return TIMELINE.accept(packet, receiptMs);
        },
        frame(nowMs) {
            return TIMELINE.sampleInto('actor', 0, nowMs, POSE) ? POSE : null;
        },
    };
}

// The game owns its rules and local session capability. simloop owns scheduling;
// this offline scene does not create a network session or invent rollback behavior.
const STEP_MS = 100,
    WORLD_WIDTH = 720,
    WORLD_HEIGHT = 400;
const COLORS = Object.freeze({
    clear: [0.035, 0.065, 0.09, 1],
    grid: [0.12, 0.2, 0.23, 1],
    shadow: [0, 0, 0, 0.35],
    body: [0.24, 0.85, 0.66, 1],
    satellite: [0.3, 0.55, 0.95, 0.85],
    healthBack: [0.12, 0.18, 0.2, 1],
    health: [0.67, 0.94, 0.43, 1],
    target: [1, 0.8, 0.3, 0.6],
});

/** Returns controls/diagnostics; dispose stops its own loop and all DOM/GPU resources. */
export function startDemo(canvas, status, { autoStart = true } = {}) {
    const DEVICE = new WebGLDevice(canvas),
        RENDERER = new VectorContext(DEVICE);
    const PROJECTION = new OrthographicProjection(),
        CAMERA = new CameraViewport({
            projection: PROJECTION,
        });
    const DEBUG = new DiagnosticRing({
        release: 'composed gamekit example',
    });
    DEBUG.installGlobal(window);
    const HUD_ROOT = document.createElement('div');
    HUD_ROOT.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    const WRAPPER = document.createElement('div');
    WRAPPER.style.position = 'relative';
    canvas.before(WRAPPER);
    WRAPPER.append(canvas, HUD_ROOT);
    const HUD = new DOMHud({
        camera: CAMERA,
        root: HUD_ROOT,
    });
    HUD.add('actor', {
        anchor: {
            x: 280,
            y: 210,
            z: 8,
            offsetY: -28,
        },
        text: 'actor',
    });
    const EFFECTS = new PresentationEventQueue({
        adapters: {
            roll: {
                reversible: true,
                start(event) {
                    return HUD.add(event.sequence, {
                        anchor: {
                            ...event.payload,
                            offsetY: -55,
                        },
                        text: 'roll',
                    });
                },
                update(_handle, ageMs, event) {
                    HUD.setAnchor(event.sequence, {
                        ...event.payload,
                        offsetY: -55 - ageMs / 30,
                    });
                },
                stop(_handle, _reason, event) {
                    HUD.remove(event.sequence);
                },
            },
        },
    });
    const PROJECTED = {};
    const APP = createPresentation(STEP_MS),
        ACTIONS = new ActionState();
    const SAMPLED = {
            left: {},
            right: {},
            up: {},
            down: {},
            roll: {},
        },
        WORLD_POINT = {};
    const ACTOR = {
        x: 280,
        y: 210,
        z: 8,
        angle: 0,
        health: 100,
        state: 'idle',
    };
    // Small static RGBA asset uploaded once into the shared atlas. Never uploads a rasterized world canvas.
    const SPRITE = DEVICE.textureAtlas.allocate(2, 2, { filter: 'nearest' });
    DEVICE.textureAtlas.upload(SPRITE, {
        width: 2,
        height: 2,
        data: new Uint8Array([255, 255, 255, 255, 255, 166, 80, 255, 255, 166, 80, 255, 255, 255, 255, 255]),
    });
    /** Center-anchored rectangle rotated by `angle` radians, in the current camera transform. */
    const FILL_CENTERED = (x, y, width, height, paint, angle = 0) => {
        RENDERER.fillStyle = paint;
        RENDERER.save();
        RENDERER.translate(x, y);
        RENDERER.rotate(angle);
        RENDERER.fillRect(-width / 2, -height / 2, width, height);
        RENDERER.restore();
    };
    const POSES = Array.from(
        {
            length: 25,
        },
        () => ({}),
    );
    const RECORDS = POSES.map((_, i) => ({
        id: i === 0 ? 'actor' : `orbiter-${i}`,
        generation: 0,
        values: {},
    }));
    let target = null;
    let running = true;
    let sequence = 0;
    let tick = 0;
    let rollUntilMs = 0;
    let lastMs = performance.now();
    let frameNow = lastMs;
    let stepped = false;
    let zoom = 1;
    let paused = false;
    let lastMetricMs = lastMs;
    let metricFrames = 0;
    let fps = 0;
    let cpuMs = 0;
    const DIAGNOSTICS = {
        frames: 0,
        tick: 0,
        authorityX: ACTOR.x,
        authorityY: ACTOR.y,
        poseX: ACTOR.x,
        poseY: ACTOR.y,
        rolls: 0,
        fps: 0,
        cpuSubmitMs: 0,
        stepMs: STEP_MS,
        frameIntervals: [],
        renderer: RENDERER,
    };
    const INPUT = createDOMInput({
        target: canvas,
        state: ACTIONS,
        keys: {
            KeyA: 'left',
            ArrowLeft: 'left',
            KeyD: 'right',
            ArrowRight: 'right',
            KeyW: 'up',
            ArrowUp: 'up',
            KeyS: 'down',
            ArrowDown: 'down',
            Space: 'roll',
        },
        gestures: {
            tap: 'move',
            doubleTap: 'roll',
            doubleTapMs: 300,
            tapMs: 400,
            dragSlop: 12,
            doubleTapSlop: 32,
        },
        onGesture(event) {
            if (event.type === 'tap') {
                CAMERA.screenToGroundInto(event.x, event.y, WORLD_POINT);
                target = {
                    x: WORLD_POINT.x,
                    y: WORLD_POINT.y,
                }; // Game command, consumed by the next fixed step.
            }
        },
    });
    function resize() {
        if (RENDERER.state !== 'ready' || DEVICE.state !== 'ready') {
            return;
        }
        const RECT = canvas.getBoundingClientRect();
        CAMERA.setViewport({
            width: RECT.width,
            height: RECT.height,
            dpr: Math.min(window.devicePixelRatio || 1, 2),
            left: RECT.left,
            top: RECT.top,
        });
        CAMERA.resizeCanvas(canvas);
    }
    function authorityStep() {
        tick++;
        for (const KEY of Object.keys(SAMPLED)) {
            ACTIONS.sampleInto(KEY, SAMPLED[KEY]);
        }
        if (SAMPLED.roll.pressed) {
            rollUntilMs = tick * STEP_MS + 300;
            DIAGNOSTICS.rolls++;
            EFFECTS.emit({
                tick,
                sequence: DIAGNOSTICS.rolls,
                entityId: 'actor',
                generation: 0,
                kind: 'roll',
                policy: 'speculative',
                durationMs: 600,
                payload: {
                    x: ACTOR.x,
                    y: ACTOR.y,
                    z: ACTOR.z,
                },
            });
        }
        EFFECTS.confirmThrough(tick);
        let dx = Number(SAMPLED.right.held) - Number(SAMPLED.left.held);
        let dy = Number(SAMPLED.down.held) - Number(SAMPLED.up.held);
        if (dx || dy) {
            target = null;
        } else if (target) {
            dx = target.x - ACTOR.x;
            dy = target.y - ACTOR.y;
        }
        const LENGTH = Math.hypot(dx, dy),
            ROLLING = tick * STEP_MS < rollUntilMs;
        const DISTANCE = Math.min(LENGTH, ((ROLLING ? 220 : 90) * STEP_MS) / 1000);
        if (LENGTH) {
            // Keyboard directions have unit magnitude, but targets have world distance.
            const SCALE = target ? DISTANCE / LENGTH : ((ROLLING ? 220 : 90) * STEP_MS) / 1000 / LENGTH;
            ACTOR.x = Math.max(24, Math.min(WORLD_WIDTH - 24, ACTOR.x + dx * SCALE));
            ACTOR.y = Math.max(45, Math.min(WORLD_HEIGHT - 24, ACTOR.y + dy * SCALE));
            ACTOR.angle = Math.atan2(dy, dx);
            ACTOR.state = ROLLING ? 'rolling' : 'walking';
            if (target && LENGTH <= DISTANCE) {
                target = null;
            }
        } else {
            ACTOR.state = 'idle';
        }
        ACTOR.z = ROLLING ? 18 : 8;
        ACTIONS.consume(); // Only fixed-step command collection clears edges, never rendering.
    }
    function receive(now) {
        Object.assign(RECORDS[0].values, ACTOR);
        for (let i = 1; i < RECORDS.length; i++) {
            const PHASE = (tick * STEP_MS) / 1800 + (i * Math.PI * 2) / 24;
            Object.assign(RECORDS[i].values, {
                x: 360 + Math.cos(PHASE) * (110 + (i % 3) * 32),
                y: 210 + Math.sin(PHASE) * 105,
                z: 8 + Math.sin(PHASE * 2) * 5,
                health: 50 + i * 2,
                angle: PHASE,
                state: 'orbiting',
            });
        }
        APP.receive(
            {
                revision: 0,
                sequence: sequence++,
                timeMs: tick * STEP_MS,
                entities: RECORDS,
            },
            now,
        );
    }
    function render(now) {
        const START = performance.now();
        const POSE = APP.frame(now);
        if (!POSE || !RENDERER.beginFrame({ clearColor: COLORS.clear })) {
            return;
        }
        const SCALE = Math.min(CAMERA.width / WORLD_WIDTH, CAMERA.height / WORLD_HEIGHT) * zoom;
        CAMERA.setCamera({
            x: 360 + (POSE.x - 360) * 0.15,
            y: 200 * PROJECTION.K,
            zoom: SCALE,
        });
        CAMERA.applyToContext(RENDERER);
        RENDERER.strokeStyle = COLORS.grid;
        RENDERER.lineWidth = 1;
        RENDERER.beginPath();
        for (let x = 0; x <= WORLD_WIDTH; x += 40) {
            RENDERER.moveTo(x, 0);
            RENDERER.lineTo(x, WORLD_HEIGHT * PROJECTION.K);
        }
        for (let y = 0; y <= WORLD_HEIGHT; y += 40) {
            RENDERER.moveTo(0, y * PROJECTION.K);
            RENDERER.lineTo(WORLD_WIDTH, y * PROJECTION.K);
        }
        RENDERER.stroke();
        if (target) {
            RENDERER.fillStyle = COLORS.target;
            RENDERER.beginPath();
            RENDERER.ellipse(target.x, target.y * PROJECTION.K, 8, 4);
            RENDERER.fill();
        }
        // Game chooses explicit painter order: all shadows, then sorted body + health.
        for (let i = 0; i < RECORDS.length; i++) {
            APP.timeline.sampleInto(RECORDS[i].id, 0, now, POSES[i]);
            POSES[i].actor = i === 0;
            RENDERER.fillStyle = COLORS.shadow;
            RENDERER.beginPath();
            RENDERER.ellipse(POSES[i].x, POSES[i].y * PROJECTION.K, i ? 9 : 16, i ? 4 : 6);
            RENDERER.fill();
        }
        // Reuse sortable view; pose sampling/authority are not sorted or mutated by renderer.
        SORTED.length = 0;
        for (const ITEM of POSES) {
            SORTED.push(ITEM);
        }
        SORTED.sort((a, b) => a.y - b.y);
        for (const ITEM of SORTED) {
            PROJECTION.projectInto(ITEM.x, ITEM.y, ITEM.z, PROJECTED);
            FILL_CENTERED(
                PROJECTED.x,
                PROJECTED.y - 8,
                ITEM.actor ? 24 : 14,
                ITEM.actor ? 24 : 14,
                ITEM.actor ? COLORS.body : COLORS.satellite,
                ITEM.angle,
            );
            FILL_CENTERED(PROJECTED.x, PROJECTED.y - 28, 26, 3, COLORS.healthBack);
            FILL_CENTERED(
                PROJECTED.x - 13 + (13 * ITEM.health) / 100,
                PROJECTED.y - 28,
                (26 * ITEM.health) / 100,
                3,
                COLORS.health,
            );
        }
        RENDERER.save();
        RENDERER.translate(640, 65);
        RENDERER.rotate((tick * STEP_MS) / 1000);
        RENDERER.drawRegion(SPRITE, -17, -17, 34, 34);
        RENDERER.restore();
        const STATS = RENDERER.endFrame();
        EFFECTS.update(now);
        HUD.setAnchor('actor', {
            x: POSE.x,
            y: POSE.y,
            z: POSE.z,
        });
        HUD.update();
        cpuMs = performance.now() - START;
        DIAGNOSTICS.frames++;
        DIAGNOSTICS.tick = tick;
        DIAGNOSTICS.authorityX = ACTOR.x;
        DIAGNOSTICS.authorityY = ACTOR.y;
        DIAGNOSTICS.poseX = POSE.x;
        DIAGNOSTICS.poseY = POSE.y;
        DIAGNOSTICS.cpuSubmitMs = cpuMs;
        canvas.dataset.frames = String(DIAGNOSTICS.frames);
        canvas.dataset.x = String(POSE.x);
        metricFrames++;
        if (now - lastMetricMs >= 500) {
            fps = (metricFrames * 1000) / (now - lastMetricMs);
            metricFrames = 0;
            lastMetricMs = now;
        }
        DIAGNOSTICS.fps = fps;
        status.textContent = `${STEP_MS}ms fixed step (${1000 / STEP_MS} TPS) → ${fps.toFixed(1)} observed FPS | ${STATS.drawCalls} draws · ${STATS.vertices} vertices · ${STATS.uploadedBytes} B/frame · ${STATS.textureUploads} texture uploads/frame | CPU submit ${cpuMs.toFixed(2)}ms`;
    }
    const SORTED = [];
    resize();
    receive(lastMs);
    const LOCAL_SESSION = {
        inputSize: 1,
        profile: {
            tickRate: 1000 / STEP_MS,
            maxCatchupSteps: 3,
        },
        metrics: {
            pace: 1,
        },
        get closed() {
            return !running;
        },
        resimulating: false,
        poll() {},
        releaseInput() {
            INPUT.releaseAll();
        },
        advance() {
            authorityStep();
            return {
                status: 'advanced',
                tick,
            };
        },
    };
    const LOOP = createLoop({
        session: LOCAL_SESSION,
        canAdvance: () => !paused,
        beforeFrame() {
            // rAF timestamp may precede setup performed in the same frame. Presentation
            // receipt and sampling keep the same performance.now() clock as initial state.
            const NOW = performance.now();
            frameNow = NOW;
            stepped = false;
            if (!paused && DIAGNOSTICS.frameIntervals.length < 180) {
                DIAGNOSTICS.frameIntervals.push(Math.max(0, Math.min(250, NOW - lastMs)));
            }
            lastMs = NOW;
        },
        onAdvance() {
            stepped = true;
        },
        render() {
            if (!paused) {
                if (stepped) {
                    receive(frameNow);
                }
                render(frameNow);
            }
        },
    });
    window.addEventListener('resize', resize);
    if (autoStart) {
        LOOP.start();
    }
    return {
        actions: ACTIONS,
        input: INPUT,
        renderer: RENDERER,
        diagnostics: DIAGNOSTICS,
        camera: CAMERA,
        hud: HUD,
        effects: EFFECTS,
        debug: DEBUG,
        setZoom(value) {
            if (!Number.isFinite(value) || value < 0.5 || value > 2) {
                throw new RangeError('zoom must be 0.5..2');
            }
            zoom = value;
        },
        pause(value = true) {
            paused = value;
            lastMs = performance.now();
            LOOP.resetTiming();
        },
        dispose() {
            if (!running) {
                return;
            }
            running = false;
            LOOP.stop();
            INPUT.dispose();
            EFFECTS.dispose();
            HUD.dispose();
            DEBUG.dispose();
            HUD_ROOT.remove();
            WRAPPER.before(canvas);
            WRAPPER.remove();
            RENDERER.dispose();
            DEVICE.dispose();
            window.removeEventListener('resize', resize);
        },
    };
}

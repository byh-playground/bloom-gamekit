import { ActionState, createDOMInput } from '../../../../dist/input.js';
import { WebGLDevice, VectorContext } from '../../../../dist/rendering.js';
import { CameraViewport } from '../../../../dist/camera.js';
import { PresentationRuntime, RenderObject } from '../../../../dist/interpolation.js';
import { LocalInputPreview, createLoop } from '../../../../dist/simloop.js';
import { createSession, profiles } from '../../../../dist/rollback.js';
import { hashBytes } from '../../../../dist/deterministic.js';
const DT = 100,
    ENCODER = new TextEncoder(),
    DECODER = new TextDecoder();
class Unit extends RenderObject {
    constructor(color) {
        super();
        this.x = 80;
        this.y = 100;
        this.direction = 1;
        this.roll = {
            progress: 0,
        };
        this.flash = 0;
        this.color = color;
    }
    static renderSchema = {
        x: this.POSITION_X,
        y: this.POSITION_Y,
        direction: this.STEP,
        'roll.progress': this.CYCLE,
        flash: this.DECAY,
        color: this.STEP,
    };
    render(r, m) {
        r.fillStyle = m.flash ? [1, 0.65, 0.2, 1] : m.color;
        r.fillRect(m.x - 12, m.y - 14, 24, 28);
        r.fillStyle = [1, 1, 1, 0.85];
        r.fillRect(m.x + m.direction * 13 - 5.5, m.y - 20.5, 11, 3);
    }
}
function stepUnit(unit, input, commands = []) {
    const AXIS = input[0] === 1 ? -1 : input[0] === 2 ? 1 : 0;
    if (AXIS) {
        unit.direction = AXIS;
    }
    unit.x += AXIS * 20;
    if (commands.some((c) => c.payload[0] === 1)) {
        unit.x += unit.direction * 22;
        unit.roll.progress = 0.01;
        unit.flash = 1;
    } else {
        unit.roll.progress = (unit.roll.progress + 0.18) % 1;
        unit.flash = Math.max(0, unit.flash - 0.2);
    }
    if (unit.x < 24 || unit.x > 696) {
        unit.x = Math.max(24, Math.min(696, unit.x));
        unit.direction *= -1;
        unit.flash = 1;
    }
}
export function startInputPreviewDemo(canvas, status) {
    const DEVICE = new WebGLDevice(canvas, {
            antialias: false,
            preserveDrawingBuffer: true,
        }),
        RENDERER = new VectorContext(DEVICE),
        // World units are the canvas attribute pixels, centered in the CSS box like the authored layout.
        CAMERA = new CameraViewport({
            width: canvas.clientWidth,
            height: canvas.clientHeight,
            dpr: devicePixelRatio || 1,
            x: canvas.width / 2,
            y: canvas.height / 2,
        }).resizeCanvas(canvas);
    const ACTIONS = new ActionState(),
        INPUT = createDOMInput({
            target: canvas,
            state: ACTIONS,
            keys: {
                KeyA: 'left',
                ArrowLeft: 'left',
                KeyD: 'right',
                ArrowRight: 'right',
                Space: 'roll',
            },
        });
    let unit;
    let remote;
    let presentation;
    let preview;
    let session;
    let loop;
    let disposed = false;
    let enabled = true;
    let frames = 0;
    let pose = {};
    let captureSequence = 0;
    let worldTick = 0;
    let forkCreates = 0;
    let forkRestores = 0;
    const SNAPSHOT = () =>
        ENCODER.encode(
            JSON.stringify({
                unit,
                tick: worldTick,
            }),
        );
    const CONTINUATION_KEY = 'remote-inputs:stable';
    const CHECKPOINT = (mode) =>
        preview.reconcile({
            snapshot: SNAPSHOT(),
            input: session.localInputState.replayInput ?? session.localInputState.executedInput,
            revision: 0,
            tick: session.tick,
            epoch: 0,
            continuationKey: CONTINUATION_KEY,
            timeMs: performance.now(),
            mode,
            confirmedCommandSequence: session.localInputState.executedCommandSequence,
        });
    function start() {
        unit = new Unit([0.25, 0.55, 1, 1]);
        remote = new Unit([0.9, 0.25, 0.25, 1]);
        remote.x = 575;
        remote.y = 150;
        captureSequence = 0;
        worldTick = 0;
        presentation = new PresentationRuntime({
            stepMs: DT,
            snapDistance: 180,
        });
        const ADAPTER = {
            save: SNAPSHOT,
            validateSnapshot(bytes) {
                try {
                    const DATA = JSON.parse(DECODER.decode(bytes)),
                        U = DATA.unit;
                    return (
                        Number.isSafeInteger(DATA.tick) &&
                        DATA.tick >= 0 &&
                        [U.x, U.y, U.direction, U.roll?.progress, U.flash].every(Number.isFinite) &&
                        Array.isArray(U.color) &&
                        U.color.length === 4 &&
                        U.color.every(Number.isFinite)
                    );
                } catch {
                    return false;
                }
            },
            load(bytes) {
                const DATA = JSON.parse(DECODER.decode(bytes));
                Object.assign(unit, DATA.unit);
                worldTick = DATA.tick;
            },
            step(frame) {
                if (frame.tick !== worldTick) {
                    throw Error('Authority tick boundary');
                }
                stepUnit(unit, frame.inputs[0].input, frame.inputs[0].commands);
                worldTick++;
            },
        };
        session = createSession({
            players: ['local'],
            localPlayerId: 'local',
            sessionId: 'preview',
            simulationVersion: 'preview-v2',
            seed: 1,
            inputSize: 1,
            adapter: ADAPTER,
            recordReplay: false,
            profile: {
                ...profiles.lockstep,
                tickRate: 10,
                maxCatchupSteps: 1,
                baseInputDelayTicks: 2,
                minInputDelayTicks: 2,
                maxInputDelayTicks: 2,
                adaptiveInputDelay: false,
                pacingPolicy: 'none',
                checksumInterval: 1,
            },
        });
        const ENTITIES = () => [
            {
                id: 'local',
                generation: 0,
                source: unit,
            },
            {
                id: 'remote',
                generation: 0,
                source: remote,
            },
        ];
        presentation.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: ENTITIES(),
            },
            performance.now(),
        );
        preview = new LocalInputPreview({
            presentation,
            isActive: (fork) => fork.unit.flash > 0,
            stepMs: DT,
            maxPendingInputs: 8,
            maxFutureTicks: 8,
            maxAgeMs: 1500,
            captureSnapshot: SNAPSHOT,
            createFork: (bytes) => {
                forkCreates++;
                const FORK = new Unit([0.15, 1, 0.55, 1]);
                let forkTick;
                const RESTORE = (b) => {
                    forkRestores++;
                    const DATA = JSON.parse(DECODER.decode(b));
                    Object.assign(FORK, DATA.unit);
                    forkTick = DATA.tick;
                    FORK.color = [0.15, 1, 0.55, 1];
                };
                RESTORE(bytes);
                return {
                    unit: FORK,
                    restore: RESTORE,
                    step: (bytes, ctx) => {
                        if (ctx.tick !== forkTick) {
                            throw Error('Detached replay compressed a tick gap');
                        }
                        for (const COMMAND of ctx.commands) {
                            if (COMMAND.executeTick !== undefined && COMMAND.executeTick !== forkTick) {
                                throw Error('Canonical command executed at wrong preview tick');
                            }
                        }
                        stepUnit(FORK, bytes, ctx.commands);
                        forkTick++;
                    },
                };
            },
            readEntities: (fork) => [
                {
                    id: 'local',
                    generation: 0,
                    source: fork.unit,
                },
            ],
        });
        CHECKPOINT('reset');
        loop = createLoop({
            session,
            inputPreview: preview,
            getInput() {
                const LEFT = ACTIONS.sample('left').held,
                    RIGHT = ACTIONS.sample('right').held,
                    ROLL = ACTIONS.sample('roll').pressed;
                ACTIONS.consume();
                return {
                    input: Uint8Array.of(LEFT === RIGHT ? 0 : LEFT ? 1 : 2),
                    commands: ROLL
                        ? [
                              {
                                  payload: Uint8Array.of(1),
                              },
                          ]
                        : [],
                    predict: LEFT || RIGHT || ROLL,
                    continuationKey: CONTINUATION_KEY,
                };
            },
            onPreviewError: (error) => {
                throw error;
            },
            onAdvance(result) {
                if (result.status !== 'advanced') {
                    return;
                }
                presentation.capture(
                    {
                        revision: 0,
                        sequence: ++captureSequence,
                        timeMs: session.tick * DT,
                        entities: ENTITIES(),
                    },
                    performance.now(),
                );
                const METADATA = session.localInputState;
                const CONTINUED = preview.continueFromCheckpoint({
                    input: METADATA.replayInput ?? METADATA.executedInput,
                    revision: 0,
                    tick: session.tick,
                    epoch: METADATA.epoch,
                    continuationKey: CONTINUATION_KEY,
                    timeMs: performance.now(),
                    confirmedCommandSequence: METADATA.executedCommandSequence ?? undefined,
                });
                if (!CONTINUED) {
                    CHECKPOINT('continuous');
                }
            },
            render() {
                frames++;
                const NOW = performance.now();
                RENDERER.beginFrame({ clearColor: [0.035, 0.07, 0.09, 1] });
                CAMERA.applyToContext(RENDERER);
                RENDERER.fillStyle = [0.25, 0.36, 0.4, 1];
                RENDERER.fillRect(35, 114, 650, 2);
                presentation.render(unit, RENDERER, NOW);
                presentation.render(remote, RENDERER, NOW);
                RENDERER.endFrame();
                pose = presentation.modelFor(unit, NOW);
                status.textContent = `authority tick=${session.tick} · x=${unit.x.toFixed(1)} · displayed=${pose.x.toFixed(1)} · pending=${preview.pendingCount} · preview=${enabled}`;
            },
        });
        loop.start();
    }
    start();
    return {
        renderer: RENDERER,
        get presentation() {
            return presentation;
        },
        get preview() {
            return preview;
        },
        get session() {
            return session;
        },
        get diagnostics() {
            return {
                authorityX: unit.x,
                displayedX: pose.x,
                displayFlash: pose.flash,
                remoteX: remote.x,
                authorityTick: session.tick,
                authorityHash: hashBytes(SNAPSHOT()),
                frames,
                pending: preview.pendingCount,
                forkCreates,
                forkRestores,
                metrics: preview.metrics,
                presentationMetrics: presentation.previewMetrics,
                confirmedCommandSequence: session.localInputState.executedCommandSequence,
            };
        },
        setPreview(value) {
            enabled = !!value;
            preview.setEnabled(enabled);
            if (enabled) {
                CHECKPOINT('reset');
            }
        },
        forceCollision() {
            unit.x = 695;
            presentation.capture(
                {
                    revision: 0,
                    sequence: ++captureSequence,
                    timeMs: session.tick * DT,
                    entities: [
                        {
                            id: 'local',
                            generation: 0,
                            source: unit,
                        },
                        {
                            id: 'remote',
                            generation: 0,
                            source: remote,
                        },
                    ],
                },
                performance.now(),
            );
            CHECKPOINT('reset');
        },
        clockGap() {
            loop.resetTiming(false);
            preview.clockGap();
        },
        restart() {
            loop.stop();
            preview.dispose();
            session.close();
            start();
        },
        dispose() {
            // The owner can be disposed explicitly before pagehide calls it again.
            // Stop the loop while its preview is live; never clear a disposed preview.
            if (disposed) {
                return;
            }
            disposed = true;
            loop.stop();
            preview.dispose();
            session.close();
            INPUT.dispose();
            RENDERER.dispose();
            DEVICE.dispose();
        },
    };
}

import { LocalInputPreview } from '../../../dist/simloop.js';
import { PresentationRuntime, RenderObject } from '../../../dist/interpolation.js';
import { Renderer2D } from '../../../dist/rendering.js';
import { createRoomSession, profiles } from '../../../dist/rollback.js';
import { createValueCodec } from '../../../dist/deterministic.js';
import { createLoop, createDeadlineScheduler } from '../../../dist/simloop.js';
const CODEC = createValueCodec(),
    LINKS = new Map(),
    EVENTS = [];
let session;
let loop;
let scheduler;
let frame;
let draw;
let state;
let renderedFrames = 0;
let input = 1;
let costMs = 0;
let stopped = false;
let target = Infinity;
let corruptTick = -1;
let pauseOnProbe = false;
let probePaused = false;
let pulseIntervalMs = 0;
let latency = null;
function stepWorld(world, inputs) {
    for (const F of inputs) {
        world.value += F.input[0];
        for (const C of F.commands) {
            world.commands.push(F.playerId + ':' + C.sequence + ':' + C.payload[0]);
        }
    }
    world.tick++;
}
const ROOM = {
    localPlayerId: '',
    sessionId: 'availability-browser',
    coordinatorId: 'A',
    epoch: 0,
    players: [],
    transports: new Map(),
    subscribe() {
        return () => {};
    },
    connectMesh() {
        return Promise.resolve();
    },
    setRoster(value) {
        Object.assign(this, value);
    },
    close() {},
};
function adapter(cooperative = false) {
    const IMPLEMENTATION = {
        save: () => {
            const T = performance.now(),
                DATA = CODEC.encode(state);
            latency?.cost('save', performance.now() - T);
            return DATA;
        },
        load: (data) => {
            const T = performance.now();
            state = CODEC.decode(data);
            latency?.cost('load', performance.now() - T);
        },
        validateSnapshot: (data, context) => {
            try {
                const CANDIDATE = CODEC.decode(data);
                return CANDIDATE.tick === context.tick && CANDIDATE.players.every((id) => typeof id === 'string');
            } catch {
                return false;
            }
        },
        applyMembership(change) {
            if (state.tick !== change.tick) {
                throw new Error('membership boundary');
            }
            state.epoch = change.epoch;
            state.players = [...change.players];
            state.activePlayers = [...(change.activePlayers ?? change.players)];
        },
        step({ tick, membershipEpoch, inputs, resimulating }) {
            if (tick !== state.tick || membershipEpoch !== state.epoch) {
                throw new Error('simulation boundary');
            }
            const START = performance.now();
            while (performance.now() - START < costMs) {
                // Deliberately consume the configured CPU budget for this availability scenario.
            }
            stepWorld(state, inputs);
            latency?.cost(resimulating ? 'replay' : 'step', performance.now() - START);
            latency?.executed(inputs, tick, resimulating);
            if (tick === corruptTick) {
                state.value += 7;
            }
        },
    };
    if (cooperative) {
        const TOKENS = new WeakMap();
        IMPLEMENTATION.prepareMembershipJob = (change, context) => {
            const ORIGINAL = state;
            let pulses = 0;
            let done = false;
            let result;
            return {
                get done() {
                    return done;
                },
                get result() {
                    return result;
                },
                cancel() {
                    done = true;
                },
                pulse() {
                    if (done || ++pulses < 2) {
                        return;
                    }
                    if (state !== ORIGINAL || state.tick !== change.tick) {
                        throw new Error('membership job mutated live boundary');
                    }
                    const CANDIDATE = structuredClone(state);
                    CANDIDATE.epoch = change.epoch;
                    CANDIDATE.players = [...change.players];
                    CANDIDATE.activePlayers = [...(change.activePlayers ?? change.players)];
                    const PREPARED = {};
                    TOKENS.set(PREPARED, {
                        candidate: CANDIDATE,
                        context: structuredClone(context),
                    });
                    result = {
                        bytes: CODEC.encode(CANDIDATE),
                        prepared: PREPARED,
                    };
                    done = true;
                    membershipJobs++;
                },
            };
        };
        IMPLEMENTATION.loadPreparedSnapshot = (prepared, context) => {
            const OWNED = TOKENS.get(prepared);
            if (!OWNED || JSON.stringify(OWNED.context) !== JSON.stringify(context)) {
                throw new Error('membership token context');
            }
            TOKENS.delete(prepared);
            state = OWNED.candidate;
            membershipInstalls++;
        };
    }
    return IMPLEMENTATION;
}
let membershipJobs = 0;
let membershipInstalls = 0;
window.setup = async (
    id,
    players,
    available = true,
    autoTransfer = false,
    cooperative = false,
    simulationMode = 'lockstep',
    options = {},
) => {
    state = {
        tick: 0,
        epoch: -1,
        players: [],
        activePlayers: [],
        value: 0,
        commands: [],
    };
    ROOM.localPlayerId = id;
    ROOM.players = players;
    session = createRoomSession({
        mode: 'online',
        room: ROOM,
        simulationVersion: 'availability-v1',
        inputSize: 1,
        adapter: adapter(cooperative),
        profile: {
            ...(simulationMode === 'rollback' ? profiles.action : profiles.lockstep),
            tickRate: options.tickRate ?? 20,
            ...(options.inputScheduling
                ? {
                      inputScheduling: options.inputScheduling,
                      inputSafetyMarginMs: options.inputSafetyMarginMs,
                      inputJitterMultiplier: options.inputJitterMultiplier,
                  }
                : {}),
            adaptiveInputDelay: options.adaptiveInputDelay ?? true,
            baseInputDelayTicks: 2,
            pacingPolicy: 'none',
            checksumInterval: 10,
            heartbeatMs: 100,
            peerInterruptMs: 3000,
            peerTimeoutMs: 15000,
        },
        membership: {
            reconnectGraceMs: 15000,
        },
        availability: available
            ? {
                  mode: 'available',
                  heartbeatMs: 100,
                  silenceMs: 1600,
                  inputGraceMs: 1600,
                  resumeGapMs: 1600,
                  roundTimeoutMs: 4500,
                  retryMs: 300,
                  autoTransfer: {
                      enabled: autoTransfer,
                      intervalMs: 600,
                      minTenureMs: 1600,
                      minImprovementMs: 2,
                      minSamples: 8,
                      rttWeight: 0,
                      jitterWeight: 0,
                      stepWeight: 4,
                  },
              }
            : {},
        onEvent: (event) => {
            EVENTS.push(event);
            try {
                latency?.event?.(event);
            } catch (error) {
                window.failure = error.stack;
            }
        },
    });
    loop = createLoop({
        session,
        getInput: () => new Uint8Array([input]),
        canAdvance: () => session.tick < target,
        render: () => {
            renderedFrames++;
            document.querySelector('#state').value = `${session.tick}: ${state.value}`;
        },
        onError: (error) => {
            window.failure = error.stack;
        },
    });
    scheduler = createDeadlineScheduler({
        getIntervalMs: () => 50,
        setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, pulseIntervalMs)),
        pulse: (timestamp) =>
            loop.pulse(timestamp, {
                render: false,
            }),
        onGap: () => loop.resetTiming(),
    });
    draw = (timestamp) => {
        if (!stopped) {
            loop.observeInput(timestamp);
            loop.render();
            frame = requestAnimationFrame(draw);
        }
    };
    frame = requestAnimationFrame(draw);
    document.querySelector('#move').onclick = () => {
        input = 3;
        session.queueCommand(new Uint8Array([7]));
    };
    document.addEventListener('visibilitychange', () => {
        if (stopped) {
            return;
        }
        if (document.hidden) {
            loop.releaseInput();
        } else {
            loop.resetTiming();
            scheduler.rebase();
            scheduler.wake();
        }
    });
    window.snapshot = () => ({
        state: structuredClone(state),
        tick: session.tick,
        hash: session.getStateHash(),
        confirmedTick: session.confirmedTick,
        resimulating: session.resimulating,
        metrics: session.metrics,
        status: session.status,
        failure: session.failure ?? window.failure,
        activePlayers: session.activePlayers,
        coordinatorId: session.coordinatorId,
        epoch: session.epoch,
        membershipJobs,
        membershipInstalls,
        membershipPrepareMs: session.metrics.membershipPrepareMs,
        maxBoundaryTaskMs: session.metrics.maxBoundaryTaskMs,
        branch: session.metrics.branch,
        baseTick: session.baseTick,
        events: EVENTS.slice(-24),
        hidden: document.hidden,
        renderedFrames,
        probePaused,
        stepMs: session.metrics.simulationStepMs,
    });
    window.diagnostics = () => {
        const A = session._availability,
            R = A?.round,
            TR = session._transition,
            NOW = performance.now();
        return {
            ...window.snapshot(),
            pollIdleMs: A ? NOW - A.lastPoll : null,
            inputIdleMs: A ? NOW - A.lastAdvance : null,
            requested: A?.requested,
            recovering: A?.recovering,
            pumping: A?.summary(NOW).pumping,
            probePaused,
            round: R
                ? {
                      ageMs: NOW - R.started,
                      reason: R.reason,
                      participants: R.participants,
                      votes: [...R.votes].map(([id, v]) => ({
                          id,
                          tick: v.tick,
                          hash: v.hash,
                          epoch: v.epoch,
                          pumping: v.pumping,
                          eligible: v.eligible,
                      })),
                      staged: [...R.staged],
                      decision: R.decision,
                  }
                : null,
            checkpoint: TR
                ? {
                      target: TR.target,
                      epoch: TR.proposal.epoch,
                      applied: TR.applied,
                      postHash: TR.postHash,
                  }
                : null,
            control: {
                incoming: session._incoming.length,
                queuedBytes: session.metrics.controlQueuedBytes,
                sentBytes: session.metrics.sentControlBytes,
                receivedBytes: session.metrics.receivedControlBytes,
            },
            links: [...LINKS].map(([id, l]) => ({
                id,
                connection: l.pc.connectionState,
                channel: l.channel?.readyState,
                buffered: l.channel?.bufferedAmount,
            })),
        };
    };
};
function attach(peerId, channel, pc) {
    const LISTENERS = new Set();
    channel.binaryType = 'arraybuffer';
    const TRANSPORT = {
        get state() {
            return channel.readyState === 'open' ? 'open' : 'connecting';
        },
        send(data) {
            if (channel.readyState !== 'open') {
                return false;
            }
            const LINK = LINKS.get(peerId);
            if (LINK.blocked) {
                if (LINK.saved.length < 64) {
                    LINK.saved.push(data.slice());
                }
                return true;
            }
            if (latency?.intercept(data, channel)) {
                return true;
            }
            latency?.wire(data, 'sent');
            channel.send(data);
            return true;
        },
        subscribe(fn) {
            LISTENERS.add(fn);
            return () => LISTENERS.delete(fn);
        },
    };
    channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
            latency?.echo(JSON.parse(event.data), channel);
            return;
        }
        latency?.wire(new Uint8Array(event.data), 'received', channel);
        const DATA = new Uint8Array(event.data),
            VIEW = new DataView(DATA.buffer);
        if (
            pauseOnProbe &&
            DATA.length >= 24 &&
            VIEW.getUint32(0, true) === 0x31524d44 &&
            VIEW.getUint32(16, true) === 0 &&
            VIEW.getUint32(12, true) === DATA.length - 24 &&
            CODEC.decode(DATA.subarray(24)).op === 'availability-probe'
        ) {
            pauseOnProbe = false;
            probePaused = true;
            scheduler.stop();
        }
        if (!LINKS.get(peerId).blocked) {
            for (const FN of LISTENERS) {
                FN(DATA);
            }
        }
    };
    LINKS.set(peerId, {
        pc,
        channel,
        blocked: false,
        saved: [],
    });
    ROOM.transports.set(peerId, TRANSPORT);
    session._attach(peerId, TRANSPORT);
}
window.offer = async (peerId) => {
    const PC = new RTCPeerConnection({
        iceServers: [],
    });
    attach(
        peerId,
        PC.createDataChannel('room', {
            ordered: true,
        }),
        PC,
    );
    await PC.setLocalDescription(await PC.createOffer());
    await gathered(PC);
    return PC.localDescription.toJSON();
};
window.answer = async (peerId, offer) => {
    const PC = new RTCPeerConnection({
        iceServers: [],
    });
    PC.ondatachannel = (e) => attach(peerId, e.channel, PC);
    LINKS.set(peerId, {
        pc: PC,
    });
    await PC.setRemoteDescription(offer);
    await PC.setLocalDescription(await PC.createAnswer());
    await gathered(PC);
    return PC.localDescription.toJSON();
};
window.accept = (id, answer) => LINKS.get(id).pc.setRemoteDescription(answer);
async function gathered(pc) {
    if (pc.iceGatheringState === 'complete') {
        return;
    }
    await new Promise((resolve) =>
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            }
        }),
    );
}
window.block = (ids, blocked, replay = false) => {
    for (const ID of ids) {
        const LINK = LINKS.get(ID);
        LINK.blocked = blocked;
        if (!blocked) {
            if (replay) {
                for (const PACKET of LINK.saved) {
                    LINK.channel.send(PACKET);
                }
            }
            LINK.saved = [];
        }
    }
};
window.setTarget = (tick) => {
    target = tick;
};
window.setCost = (ms) => {
    costMs = ms;
};
window.corruptAt = (tick) => {
    corruptTick = tick;
};
window.stopPump = () => {
    scheduler.stop();
};
window.setPulseInterval = (ms) => {
    scheduler.stop();
    pulseIntervalMs = ms;
    scheduler.start();
};
window.pausePumpOnProbe = () => {
    pauseOnProbe = true;
};
window.stopRender = () => cancelAnimationFrame(frame);
window.resumeRender = () => {
    frame = requestAnimationFrame(draw);
};
window.resumePump = () => {
    scheduler.stop();
    loop.resetTiming();
    scheduler.start();
};
window.startPump = () => scheduler.start();
window.stop = () => {
    stopped = true;
    loop.stop();
    latency?.dispose();
    scheduler.stop();
    cancelAnimationFrame(frame);
    session.close();
    for (const LINK of LINKS.values()) {
        LINK.pc.close();
    }
};
window.rtcStats = async () => {
    let bytesSent = 0;
    for (const LINK of LINKS.values()) {
        (await LINK.pc.getStats()).forEach((row) => {
            if (row.type === 'data-channel') {
                bytesSent += row.bytesSent ?? 0;
            }
        });
    }
    return {
        connections: LINKS.size,
        bytesSent,
    };
};

// Extends the existing two-page RoomSession/RTC fixture, using the same game step.
window.setupLatency = async (id, players, rates) => {
    await window.setup(id, players, false, false, false, 'rollback', {
        tickRate: rates.simulationHz,
        adaptiveInputDelay: false,
        ...rates.policy,
    });
    loop.stop();
    cancelAnimationFrame(frame);
    input = 0;
    const TRACES = new Map(),
        EDGES = [],
        COUNTERS = {
            samples: 0,
            pulses: 0,
            advances: 0,
            rendered: 0,
            authoritySaves: 0,
            previewSteps: 0,
            previewMs: 0,
            maxRafGapMs: 0,
        };
    let presentationRevision = 0;
    let measurement = null;
    let row = new Uint8Array(640 * 4);
    let observation = 0;
    let capture = 0;
    let lastRender = -Infinity;
    let nextInput = 0;
    let firstPulse = null;
    let lastPulse = 0;
    let shown = 40;
    const COSTS = {},
        FAULTS = {
            hold: false,
            packets: [],
            replays: 0,
            delayMs: 0,
            jitter: [],
            packetIndex: 0,
            deliveryAt: 0,
            timers: new Set(),
        },
        RECEIPTS = [],
        REMOTE_TRACES = new Map(),
        CLOCKS = new Map();
    let clockSequence = 0;
    const DT = 1000 / rates.simulationHz,
        CANVAS = document.createElement('canvas');
    CANVAS.width = 640;
    CANVAS.height = 96;
    CANVAS.style.width = '640px';
    CANVAS.style.height = '96px';
    document.body.append(CANVAS);
    const RENDERER = new Renderer2D(CANVAS, {
        preserveDrawingBuffer: true,
        antialias: false,
    });
    RENDERER.resize(640, 96, 1);
    class Unit extends RenderObject {
        static renderSchema = {
            x: this.POSITION_X,
            y: this.POSITION_Y,
        };
        constructor(x) {
            super();
            this.x = x;
            this.y = 40;
        }
        render(r, m) {
            r.rect(m.x, m.y, 12, 16, [1, 0.2, 0.1, 1]);
        }
    }
    const UNIT = new Unit(40),
        PRESENTATION = new PresentationRuntime({
            stepMs: DT,
            snapDistance: 500,
        });
    const MARKERS = Array.from(
        {
            length: 24,
        },
        (_, n) => {
            const UNIT = new Unit(8 + (n % 8) * 78);
            UNIT.y = 8 + Math.floor(n / 8) * 36;
            return {
                id: 'command-' + (n + 1),
                marker: n + 1,
                generation: 0,
                source: UNIT,
                baseX: UNIT.x,
            };
        },
    );
    const MARKER_ROWS = new Map();
    const PUBLISHED_ENTITIES = () => (rates.remote ? [...ENTITIES(UNIT), ...MARKERS] : ENTITIES(UNIT));
    const ENTITIES = (source) => [
            {
                id,
                generation: 0,
                source,
            },
        ],
        BYTES = () => {
            COUNTERS.authoritySaves++;
            return CODEC.encode(state);
        };
    const PREVIEW = new LocalInputPreview({
        presentation: PRESENTATION,
        stepMs: DT,
        maxAgeMs: 2000,
        maxFutureTicks: 16,
        maxPendingInputs: 64,
        createFork: (snapshot) => {
            let world = CODEC.decode(snapshot);
            const SOURCE = new Unit(40 + world.value * 0.1);
            return {
                source: SOURCE,
                restore: (b) => {
                    world = CODEC.decode(b);
                    SOURCE.x = 40 + world.value * 0.1;
                },
                step: (held, ctx) => {
                    const START = performance.now();
                    stepWorld(
                        world,
                        players.map((playerId) => ({
                            playerId,
                            input: playerId === id ? held : Uint8Array.of(0),
                            commands: playerId === id ? ctx.commands : [],
                        })),
                    );
                    SOURCE.x = 40 + world.value * 0.1;
                    COUNTERS.previewSteps++;
                    COUNTERS.previewMs += performance.now() - START;
                    for (const COMMAND of ctx.commands) {
                        const TRACE = TRACES.get(COMMAND.payload[0]);
                        if (TRACE) {
                            TRACE.predicted ??= performance.now();
                        }
                    }
                },
            };
        },
        readEntities: (fork) => {
            const TRACE = TRACES.get(observation);
            if (TRACE) {
                TRACE.forecastX ??= fork.source.x;
            }
            return ENTITIES(fork.source);
        },
    });
    const RECONCILE = (mode) =>
        PREVIEW.reconcile({
            snapshot: BYTES(),
            input: session.localInputState.replayInput ?? Uint8Array.of(0),
            revision: presentationRevision,
            tick: session.tick,
            epoch: session.epoch,
            timeMs: performance.now(),
            mode,
        });
    PRESENTATION.capture(
        {
            revision: 0,
            sequence: 0,
            timeMs: 0,
            entities: PUBLISHED_ENTITIES(),
        },
        performance.now(),
    );
    RECONCILE('reset');
    const PUBLISH = (mode) => {
        if (mode === 'rollback') {
            presentationRevision++;
        }
        UNIT.x = 40 + state.value * 0.1;
        if (rates.remote) {
            for (const MARKER of MARKERS) {
                MARKER.source.x =
                    MARKER.baseX + (state.commands.some((c) => Number(c.split(':')[2]) === MARKER.marker) ? 24 : 0);
            }
        }
        PRESENTATION.capture(
            {
                revision: presentationRevision,
                sequence: ++capture,
                timeMs: session.tick * DT,
                mode,
                entities: PUBLISHED_ENTITIES(),
            },
            performance.now(),
        );
        RECONCILE(mode);
    };
    loop = createLoop({
        session,
        inputPreview: PREVIEW,
        getInput() {
            COUNTERS.samples++;
            return {
                input: Uint8Array.of(input),
                commands: EDGES.splice(0),
            };
        },
        canAdvance: () => session.tick < target,
        onPreviewError: (e) => {
            throw e;
        },
        onError: (e) => {
            window.failure = e.stack;
        },
        onAdvance(result) {
            if (result.status !== 'advanced') {
                return;
            }
            COUNTERS.advances++;
            PUBLISH('continuous');
        },
        render() {
            COUNTERS.rendered++;
            const NOW = performance.now();
            if (COUNTERS.lastRender !== undefined) {
                COUNTERS.maxRafGapMs = Math.max(COUNTERS.maxRafGapMs, NOW - COUNTERS.lastRender);
            }
            COUNTERS.lastRender = NOW;
            RENDERER.beginFrame([0, 0, 0, 1]);
            if (rates.remote) {
                for (const MARKER of MARKERS) {
                    PRESENTATION.render(MARKER.source, RENDERER, NOW);
                }
            } else {
                PRESENTATION.render(UNIT, RENDERER, NOW);
            }
            RENDERER.endFrame();
            if (rates.remote) {
                for (const MARKER of MARKERS) {
                    const MEASURED = REMOTE_TRACES.get(MARKER.marker);
                    if (MARKER_ROWS.has(MARKER.marker) && (!MEASURED || MEASURED.screen !== undefined)) {
                        continue;
                    }
                    const PIXELS = new Uint8Array(64 * 4);
                    RENDERER.gl.readPixels(
                        MARKER.baseX,
                        96 - MARKER.source.y - 8,
                        64,
                        1,
                        RENDERER.gl.RGBA,
                        RENDERER.gl.UNSIGNED_BYTE,
                        PIXELS,
                    );
                    const PRIOR = MARKER_ROWS.get(MARKER.marker);
                    if (!PRIOR) {
                        MARKER_ROWS.set(MARKER.marker, PIXELS);
                    }
                    const TRACE = REMOTE_TRACES.get(MARKER.marker);
                    if (TRACE && PRIOR && TRACE.screen === undefined && PIXELS.some((v, i) => v !== PRIOR[i])) {
                        TRACE.screen = performance.now();
                    }
                }
            }
            shown = PRESENTATION.modelFor(UNIT, NOW).x;
            const NEXT = new Uint8Array(row.length);
            RENDERER.gl.readPixels(0, 48, 640, 1, RENDERER.gl.RGBA, RENDERER.gl.UNSIGNED_BYTE, NEXT);
            const TRACE = TRACES.get(observation);
            if (TRACE) {
                if (TRACE.screen === undefined && NEXT.some((value, i) => value !== TRACE.priorPixels[i])) {
                    TRACE.screen = performance.now();
                }
                if (
                    TRACE.target90 === undefined &&
                    Number.isFinite(TRACE.forecastX) &&
                    Math.abs(TRACE.forecastX - TRACE.priorX) > 0.05 &&
                    Math.abs(shown - TRACE.priorX) >= 0.9 * Math.abs(TRACE.forecastX - TRACE.priorX)
                ) {
                    TRACE.target90 = performance.now();
                }
            }
            row = NEXT;
        },
    });
    scheduler = createDeadlineScheduler({
        getIntervalMs: () => 1000 / Math.max(rates.inputHz, rates.simulationHz),
        pulse: (time) => {
            firstPulse ??= time;
            lastPulse = time;
            COUNTERS.pulses++;
            if (time >= nextInput) {
                loop.observeInput(time);
                nextInput = Math.max(nextInput + 1000 / rates.inputHz, time);
            }
            loop.pulse(time, {
                render: false,
                input: false,
            });
        },
        onGap: () => loop.resetTiming(),
    });
    draw = (time) => {
        if (stopped) {
            return;
        }
        if (time - lastRender >= 1000 / rates.renderHz - 1) {
            lastRender = time;
            loop.render();
        }
        frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    function commandIds(data) {
        const VIEW = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (data.length < 12 || VIEW.getUint32(0, true) !== 0x314b4252) {
            return [];
        }
        const TYPE = data[5],
            IDS = [];
        let offset;
        let count = 1;
        let size;
        if (TYPE === 2) {
            count = VIEW.getUint16(16, true);
            size = VIEW.getUint16(18, true);
            offset = 28;
        } else if (TYPE === 8) {
            size = VIEW.getUint16(20, true);
            offset = 22;
        } else {
            return IDS;
        }
        for (let consumed = 0; consumed < count;) {
            const RUN = TYPE === 2 ? VIEW.getUint16(offset, true) : 1;
            if (TYPE === 2) {
                offset += 2;
            }
            offset += size;
            const N = VIEW.getUint16(offset, true);
            offset += 2;
            for (let i = 0; i < N; i++) {
                offset += 4;
                const LENGTH = VIEW.getUint16(offset, true);
                offset += 2;
                IDS.push(data[offset]);
                offset += LENGTH;
            }
            consumed += RUN;
        }
        return IDS;
    }
    latency = {
        event(event) {
            if (event.type === 'input-submitted') {
                const TRACE = TRACES.get(observation);
                if (TRACE) {
                    TRACE.assignedTick ??= event.executeTick;
                    TRACE.schedule ??= event.schedule;
                }
            }
            if (event.type === 'reconciled' && rates.remote) {
                PUBLISH('rollback');
            }
        },
        cost(kind, ms) {
            const C = (COSTS[kind] ??= {
                calls: 0,
                ms: 0,
                maxMs: 0,
            });
            C.calls++;
            C.ms += ms;
            C.maxMs = Math.max(C.maxMs, ms);
        },
        executed(inputs, tick, resimulating) {
            if (rates.remote) {
                for (const F of inputs) {
                    for (const COMMAND of F.commands) {
                        const MARKER = COMMAND.payload[0],
                            T = REMOTE_TRACES.get(MARKER) ?? {
                                id: MARKER,
                            };
                        REMOTE_TRACES.set(MARKER, T);
                        (T.applications ??= []).push({
                            at: performance.now(),
                            tick,
                            sequence: COMMAND.sequence,
                            predicted: F.predicted,
                            resimulating: !!resimulating,
                        });
                    }
                }
            }
            for (const F of inputs) {
                for (const COMMAND of F.commands) {
                    const TRACE = TRACES.get(COMMAND.payload[0]);
                    if (TRACE) {
                        TRACE.executed ??= performance.now();
                        TRACE.executeTick = tick;
                    }
                }
            }
        },
        intercept(data, channel) {
            const V = new DataView(data.buffer, data.byteOffset, data.byteLength);
            if (
                (FAULTS.delayMs || FAULTS.jitter.length) &&
                data.length >= 12 &&
                V.getUint32(0, true) === 0x314b4252 &&
                [2, 3, 8].includes(data[5])
            ) {
                const EXTRA = FAULTS.jitter.length ? FAULTS.jitter[FAULTS.packetIndex++ % FAULTS.jitter.length] : 0;
                const WAIT = Math.max(
                    0,
                    Math.max(FAULTS.deliveryAt, performance.now() + FAULTS.delayMs + EXTRA) - performance.now(),
                );
                FAULTS.deliveryAt = performance.now() + WAIT;
                const OWNED = data.slice(),
                    TIMER = setTimeout(() => {
                        FAULTS.timers.delete(TIMER);
                        if (channel.readyState === 'open') {
                            latency.wire(OWNED, 'sent');
                            channel.send(OWNED);
                        }
                    }, WAIT);
                FAULTS.timers.add(TIMER);
                return true;
            }
            if (
                FAULTS.hold &&
                data.length >= 12 &&
                V.getUint32(0, true) === 0x314b4252 &&
                (FAULTS.hold === 'drafts' ? data[5] === 8 : [2, 8].includes(data[5]))
            ) {
                FAULTS.packets.push(data.slice());
                return true;
            }
            return false;
        },
        wire(data, kind, channel) {
            for (const COMMAND_ID of commandIds(data)) {
                if (kind === 'sent') {
                    const TRACE = TRACES.get(COMMAND_ID);
                    if (TRACE) {
                        TRACE.sent ??= performance.now();
                    }
                } else {
                    if (rates.remote) {
                        const TRACE = REMOTE_TRACES.get(COMMAND_ID) ?? {
                            id: COMMAND_ID,
                        };
                        REMOTE_TRACES.set(COMMAND_ID, TRACE);
                        const AT = performance.now();
                        TRACE.received ??= AT;
                        TRACE.receivedTick ??= session.tick;
                        const KEY = data[5] === 8 ? 'draftReceived' : 'canonicalReceived';
                        TRACE[KEY] ??= AT;
                    }
                    RECEIPTS.push({
                        id: COMMAND_ID,
                        received: performance.now(),
                        type: data[5],
                    });
                    channel.send(
                        JSON.stringify({
                            kind: 'input-receipt',
                            id: COMMAND_ID,
                            remoteReceived: performance.now(),
                        }),
                    );
                }
            }
        },
        echo(message, channel) {
            if (message.kind === 'clock-ping') {
                channel.send(
                    JSON.stringify({
                        kind: 'clock-pong',
                        nonce: message.nonce,
                        sent: message.sent,
                        received: performance.now(),
                        reply: performance.now(),
                    }),
                );
                return;
            }
            if (message.kind === 'clock-pong') {
                const DONE = CLOCKS.get(message.nonce);
                CLOCKS.delete(message.nonce);
                DONE?.({
                    ...message,
                    returned: performance.now(),
                });
                return;
            }
            const TRACE = TRACES.get(message.id);
            if (TRACE && message.kind === 'input-receipt') {
                TRACE.echo ??= performance.now();
                TRACE.remoteReceived ??= message.remoteReceived;
            }
        },
        dispose() {
            for (const TIMER of FAULTS.timers) {
                clearTimeout(TIMER);
            }
            PREVIEW.dispose();
            RENDERER.dispose();
        },
    };
    const BUTTON = document.querySelector('#move');
    BUTTON.onclick = () => {
        const MARKER = Number(BUTTON.dataset.marker);
        input = rates.remote ? 0 : MARKER;
        observation = MARKER;
        EDGES.push({
            payload: Uint8Array.of(MARKER),
        });
        const TRACE = {
            id: MARKER,
            event: performance.now(),
            tickBefore: session.tick,
            priorX: shown,
            priorPixels: [...row],
            savesBefore: COSTS.save?.calls ?? 0,
        };
        TRACES.set(MARKER, TRACE);
        loop.observeInput(TRACE.event);
        TRACE.returned = performance.now();
        TRACE.tickAfter = session.tick;
        TRACE.savesAfter = COSTS.save?.calls ?? 0;
    };
    window.inputEvent = (marker) => {
        BUTTON.dataset.marker = marker;
        BUTTON.click();
    };
    window.inputFault = (mode) => {
        if (mode === 'protocol1') {
            const DATA = FAULTS.packets[0]?.slice();
            if (!DATA) {
                throw new Error('missing draft packet');
            }
            DATA[4] = 1;
            LINKS.get(players.find((p) => p !== id)).channel.send(DATA);
            return;
        }
        if (mode === 'hold' || mode === 'drafts') {
            FAULTS.hold = mode;
            FAULTS.packets = [];
            return;
        }
        FAULTS.hold = false;
        const PACKETS = [...FAULTS.packets];
        if (mode === 'reverse') {
            PACKETS.reverse();
        }
        for (const DATA of PACKETS) {
            for (let i = 0; i < 2; i++) {
                LINKS.get(players.find((p) => p !== id)).channel.send(DATA);
                FAULTS.replays++;
            }
        }
        return PACKETS.map((data) => ({
            type: data[5],
            tick: new DataView(data.buffer, data.byteOffset).getUint32(12, true),
            revision: data[5] === 8 ? new DataView(data.buffer, data.byteOffset).getUint32(16, true) : null,
        }));
    };
    window.networkDelay = (ms, jitter = []) => {
        FAULTS.delayMs = ms;
        FAULTS.jitter = jitter;
        FAULTS.packetIndex = 0;
        FAULTS.deliveryAt = 0;
    };
    window.changeInputDelay = (ticks) => session._core.setInputDelay(ticks);
    window.synchronizeClock = async () => {
        const SAMPLES = [];
        for (let i = 0; i < 7; i++) {
            const NONCE = ++clockSequence;
            const REPLY = new Promise((resolve) => CLOCKS.set(NONCE, resolve));
            LINKS.get(players.find((p) => p !== id)).channel.send(
                JSON.stringify({
                    kind: 'clock-ping',
                    nonce: NONCE,
                    sent: performance.now(),
                }),
            );
            const R = await REPLY;
            SAMPLES.push({
                low: R.reply - R.returned - 0.2,
                high: R.received - R.sent + 0.2,
            });
        }
        SAMPLES.sort((a, b) => a.high - a.low - (b.high - b.low));
        return SAMPLES[0];
    };
    window.beginMeasurement = () => {
        measurement = {
            time: performance.now(),
            tick: session.tick,
            preview: PREVIEW.metrics,
        };
        for (const KEY of Object.keys(COSTS)) {
            delete COSTS[KEY];
        }
        for (const KEY of Object.keys(COUNTERS)) {
            COUNTERS[KEY] = 0;
        }
        delete COUNTERS.lastRender;
        firstPulse = null;
    };
    window.latencyReport = () => ({
        rates,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        remoteTraces: [...REMOTE_TRACES.values()],
        measurement,
        endTime: performance.now(),
        traces: [...TRACES.values()].map(({ priorPixels, ...trace }) => trace),
        receipts: RECEIPTS,
        costs: COSTS,
        faultReplays: FAULTS.replays,
        counters: COUNTERS,
        firstPulse,
        lastPulse,
        tick: session.tick,
        previewMetrics: PREVIEW.metrics,
        profile: session.profile,
        sessionMetrics: session.metrics,
        hash: session.getStateHash(),
        commands: state.commands,
        failure: window.failure ?? session.failure,
    });
};

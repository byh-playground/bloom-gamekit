import { RoomSession, profiles } from '../../../../dist/rollback.js';
import { createNostrDynamicRoom, createWebRTCPeer } from '../../../../dist/transport.js';
import { createLoop, createDeadlineScheduler, LocalInputPreview } from '../../../../dist/simloop.js';
import { PresentationRuntime } from '../../../../dist/interpolation.js';
import { PresentationEventQueue } from '../../../../dist/presentation-events.js';
import { Actor, codec, createGame, stepWorld, entities, WIDTH, HEIGHT } from './game.js';
const DOLLAR = (id) => document.getElementById(id),
    CANVAS = DOLLAR('simulation'),
    CTX = CANVAS.getContext('2d');
let peers = [];
let rooms = [];
let abort;
let serial = 0;
let animation = 0;
let audio = null;
let stopAt = Infinity;
let lastDiagnostic = 0;
const DEVICES = new Map(),
    ERRORS = [],
    IMPAIRMENT = {
        ms: 0,
    },
    LIVE_CONNECTIONS = new Set();
const FAIL = (error) => {
    const MESSAGE = String(error.stack ?? error);
    if (!ERRORS.includes(MESSAGE) && ERRORS.length < 8) {
        ERRORS.push(MESSAGE);
    }
    DOLLAR('error-log').textContent = ERRORS.join('\n');
    DOLLAR('error-log').hidden = false;
};
const STATUS = (text) => {
    DOLLAR('connection-status').textContent = text;
};

// Local mode substitutes SDP/ICE routing only. Every game packet still crosses real WebRTC.
// Online mode uses the default Nostr signaler; neither path implements a synchronization engine.
function localSignaling() {
    const HANDLERS = new Map();
    let n = 0;
    return async () => {
        const ID = ['a', 'b'][n++];
        return {
            id: ID,
            send: async (to, message) => {
                for (const [OTHER, RECEIVE] of HANDLERS) {
                    if (OTHER !== ID && (!to || to === '*' || to === OTHER)) {
                        queueMicrotask(() =>
                            RECEIVE({
                                from: ID,
                                to,
                                message: structuredClone(message),
                            }),
                        );
                    }
                }
            },
            subscribe(fn) {
                HANDLERS.set(ID, fn);
                return () => HANDLERS.delete(ID);
            },
            close() {
                HANDLERS.delete(ID);
            },
        };
    };
}
async function delayedPeer(options) {
    const CONNECTION = await createWebRTCPeer(options);
    LIVE_CONNECTIONS.add(CONNECTION.peerConnection);
    const RAW = CONNECTION.transport;
    let queue = [];
    let timer = 0;
    let closed = false;
    const FLUSH = () => {
        timer = 0;
        while (queue.length && queue[0].due <= performance.now()) {
            if (RAW.send(queue[0].bytes) === false) {
                break;
            }
            queue.shift();
        }
        if (queue.length) {
            timer = setTimeout(FLUSH, Math.max(5, queue[0].due - performance.now()));
        }
    };
    CONNECTION.transport = {
        send(bytes) {
            const DELAY = options.signaler.id === 'a' ? IMPAIRMENT.ms : 0;
            if (closed || queue.length >= 2048) {
                return false;
            }
            if (!DELAY && !queue.length) {
                return RAW.send(bytes);
            }
            queue.push({
                bytes: bytes.slice(),
                due: Math.max(performance.now() + DELAY, queue.at(-1)?.due ?? 0),
            });
            if (!timer) {
                timer = setTimeout(FLUSH, DELAY);
            }
            return true;
        },
        subscribe: (fn) => RAW.subscribe(fn),
        subscribeStatus: (fn) => RAW.subscribeStatus(fn),
        get state() {
            return RAW.state;
        },
        close() {
            closed = true;
            clearTimeout(timer);
            queue = [];
            RAW.close();
        },
    };
    const CLOSE = CONNECTION.close;
    CONNECTION.close = () => {
        CONNECTION.transport.close();
        LIVE_CONNECTIONS.delete(CONNECTION.peerConnection);
        CLOSE();
    };
    return CONNECTION;
}
function eventKey(e) {
    return JSON.stringify([e.tick, e.sequence, e.entityId, e.generation, e.kind]);
}
function journalFor(peer) {
    const PARTICLE = {
        reversible: true,
        start(e, now) {
            const KEY = eventKey(e);
            if (peer.particles.has(KEY)) {
                peer.stats.duplicateParticles++;
            }
            peer.particles.add(KEY);
            if (peer.particles.size > 256) {
                peer.particles.delete(peer.particles.values().next().value);
            }
            peer.stats.particleStarts++;
            const H = {
                ...e.payload,
                at: now,
                kind: e.kind,
                key: eventKey(e),
            };
            peer.effects.add(H);
            return H;
        },
        reconcile(h, e, _old, _now) {
            peer.stats.particleReconciles++;
            Object.assign(h, e.payload);
        },
        stop(h) {
            peer.stats.particleStops++;
            peer.effects.delete(h);
        },
    };
    return new PresentationEventQueue({
        retentionTicks: 120,
        maxPending: 2048,
        adapters: {
            particle: PARTICLE,
            instant: PARTICLE,
            sound: {
                start(e) {
                    const KEY = eventKey(e);
                    if (peer.sounds.has(KEY)) {
                        peer.stats.duplicateSounds++;
                    }
                    peer.sounds.add(KEY);
                    if (peer.sounds.size > 256) {
                        peer.sounds.delete(peer.sounds.values().next().value);
                    }
                    peer.stats.soundStarts++;
                    // Irreversible sound is confirmed-only. Local two-peer mode sounds one perspective.
                    if (audio && DOLLAR('sound').checked && peer === peers[0]) {
                        const OSC = audio.createOscillator(),
                            GAIN = audio.createGain();
                        OSC.frequency.value = 420;
                        GAIN.gain.setValueAtTime(0.025, audio.currentTime);
                        GAIN.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.07);
                        OSC.connect(GAIN).connect(audio.destination);
                        OSC.onended = () => {
                            OSC.disconnect();
                            GAIN.disconnect();
                        };
                        OSC.start();
                        OSC.stop(audio.currentTime + 0.08);
                    }
                },
            },
        },
    });
}
function installPeer(room, tps) {
    const STEP_MS = 1000 / tps,
        ID = room.localPlayerId,
        DEVICE = {
            axis: 0,
            commands: [],
        };
    DEVICES.set(ID, DEVICE);
    const PEER = {
        id: ID,
        room,
        tps,
        stepMs: STEP_MS,
        effects: new Set(),
        sounds: new Set(),
        particles: new Set(),
        revision: 0,
        sequence: 0,
        needsReset: 'reset',
        publishedTick: -1,
        epoch: -1,
        teleports: new Map(),
        stats: {
            frames: 0,
            projectileFrames: 0,
            retainedFrames: 0,
            previewFrames: 0,
            releases: 0,
            rollbacks: 0,
            particleStarts: 0,
            particleStops: 0,
            particleReconciles: 0,
            soundStarts: 0,
            duplicateSounds: 0,
            duplicateParticles: 0,
            optionalFrames: 0,
            pathCorners: 0,
        },
        submission: [],
        display: {},
        status: 'joining',
    };
    PEER.journal = journalFor(PEER);
    PEER.game = createGame(STEP_MS, (e) => PEER.journal.emit(e));
    PEER.presentation = new PresentationRuntime({
        stepMs: STEP_MS,
        delayMs: STEP_MS,
        snapDistance: 300,
    });
    // Disable pacing holds here to demonstrate rollback on late changed input.
    PEER.session = new RoomSession({
        mode: 'online',
        room,
        inputSize: 1,
        simulationVersion: 'reference-v2-' + tps,
        seed: 42,
        adapter: PEER.game,
        profile: {
            ...profiles.action,
            mode: 'rollback',
            tickRate: tps,
            baseInputDelayTicks: 1,
            minInputDelayTicks: 1,
            maxInputDelayTicks: 1,
            adaptiveInputDelay: false,
            rollbackWindowTicks: 16,
            stateHistorySize: 128,
            checksumInterval: 10,
            pacingPolicy: 'none',
        },
        membership: {
            maxPlayers: 2,
        },
        onEvent(e) {
            try {
                if (e.type === 'rollback') {
                    PEER.stats.rollbacks++;
                    PEER.needsReset = 'rollback';
                    PEER.journal.beginRollback(Math.max(e.from, PEER.journal.confirmedTick + 1));
                    PEER.inRollback = true;
                }
                if (e.type === 'reconciled') {
                    if (PEER.inRollback) {
                        PEER.journal.endRollback();
                    }
                    PEER.inRollback = false;
                    PEER.needsReset = 'rollback';
                }
                if (e.type === 'membership-committed' || e.type === 'recovered') {
                    PEER.journal.dispose();
                    PEER.effects.clear();
                    PEER.journal = journalFor(PEER);
                    PEER.inRollback = false;
                    PEER.needsReset = 'reset';
                }
                if (e.type === 'input-submitted' && e.commands?.length) {
                    PEER.submission.push({
                        tick: e.tick,
                        T: e.executeTick,
                        commands: e.commands,
                    });
                    if (PEER.submission.length > 16) {
                        PEER.submission.shift();
                    }
                }
                if (['fatal', 'version-mismatch', 'handshake-mismatch', 'desync-unrecoverable'].includes(e.type)) {
                    throw Error(e.type);
                }
            } catch (error) {
                FAIL(error);
            }
        },
    });
    const SNAPSHOT = () => PEER.game.save();
    PEER.preview = new LocalInputPreview({
        presentation: PEER.presentation,
        stepMs: STEP_MS,
        maxAgeMs: 1600,
        maxFutureTicks: 16,
        maxPendingInputs: 16,
        captureSnapshot: SNAPSHOT,
        cloneSnapshot: (b) => b.slice(),
        isActive: (fork) => !!fork.world.actors[ID]?.action,
        createFork(bytes) {
            let world = codec.decode(bytes);
            return {
                get world() {
                    return world;
                },
                restore(b) {
                    world = codec.decode(b);
                },
                step(input, context) {
                    // Same update, detached world, this player only. No journal/audio/network from this fork.
                    stepWorld(
                        world,
                        {
                            tick: context.tick,
                            inputs: [
                                {
                                    playerId: ID,
                                    input,
                                    commands: context.commands,
                                },
                            ],
                        },
                        STEP_MS,
                    );
                },
            };
        },
        readEntities: (fork) => {
            const A = fork.world.actors[ID];
            return A
                ? [
                      {
                          id: 'actor:' + ID,
                          generation: A.generation,
                          source: A,
                          type: Actor,
                      },
                  ]
                : [];
        },
    });
    function publish() {
        const SESSION = PEER.session;
        if (!SESSION.ready || SESSION.resimulating) {
            return;
        }
        if (PEER.publishedTick === SESSION.tick && !PEER.needsReset) {
            return;
        }
        const RESET = PEER.needsReset || (PEER.epoch !== SESSION.epoch ? 'reset' : null),
            NOW = performance.now();
        if (RESET) {
            PEER.revision++;
        }
        const LIST = entities(PEER.game.world).map((e) => {
            const A = e.source;
            // Authority teleport discards buffered history immediately. The same serial
            // is a STATE_KEY in Actor, so detached local preview also cuts its pose.
            if (e.id.startsWith('actor:')) {
                e.teleport = PEER.teleports.has(e.id) && PEER.teleports.get(e.id) !== A.teleportSerial;
                PEER.teleports.set(e.id, A.teleportSerial);
            }
            if (RESET) {
                delete e.pathPoints;
                delete e.initialSource;
                delete e.initialTimeMs;
            } else {
                PEER.stats.pathCorners += e.pathPoints?.length ?? 0;
            }
            return e;
        });
        PEER.presentation.capture(
            {
                revision: PEER.revision,
                sequence: ++PEER.sequence,
                timeMs: SESSION.tick * STEP_MS,
                mode: RESET === 'rollback' ? 'rollback' : RESET ? 'reset' : 'continuous',
                entities: LIST,
            },
            NOW,
        );
        const LOCAL = SESSION.localInputState;
        // Deliberately full checkpoints: no guessed remote continuation key / stale fork optimization.
        PEER.preview.reconcile({
            snapshot: SNAPSHOT(),
            revision: PEER.revision,
            tick: SESSION.tick,
            epoch: SESSION.epoch,
            mode: RESET === 'rollback' ? 'rollback' : RESET ? 'reset' : 'continuous',
            input: LOCAL.replayInput ?? LOCAL.executedInput,
            confirmedCommandSequence: LOCAL.executedCommandSequence ?? undefined,
            timeMs: NOW,
        });
        PEER.publishedTick = SESSION.tick;
        PEER.epoch = SESSION.epoch;
        PEER.needsReset = null;
    }
    PEER.loop = createLoop({
        session: PEER.session,
        inputPreview: PEER.preview,
        rates: {
            baseHz: 120,
            inputHz: 60,
            renderHz: 60,
        },
        canAdvance: () => PEER.session.tick < stopAt,
        canObserveInput: () => PEER.session.ready && !PEER.session.resimulating && PEER.publishedTick >= 0,
        getInput: () => ({
            input: Uint8Array.of(DEVICE.axis),
            commands: DEVICE.commands.splice(0).map((n) => ({
                payload: Uint8Array.of(n),
            })),
            predict: DEVICE.axis !== 0,
        }),
        onAdvance(result) {
            PEER.status = result.status;
            publish();
        },
        onInputRelease() {
            DEVICE.axis = 0;
            DEVICE.commands = [];
        },
        onPreviewError: FAIL,
        onError: FAIL,
        onBacklogDrop() {
            PEER.needsReset = 'reset';
        },
        render() {
            publish();
            drawPeer(PEER);
        },
    });
    publish();
    // Timer owns input/poll/fixed work; RAF owns drawing. Both use the official loop.
    PEER.scheduler = createDeadlineScheduler({
        getIntervalMs: () => 1000 / 60,
        pulse: (now) => {
            PEER.loop.pollInput(now);
            PEER.loop.pulse(now, {
                render: false,
                input: false,
            });
            publish();
            if (!PEER.inRollback && PEER.session.confirmedTick >= 0) {
                PEER.journal.confirmThrough(Math.min(PEER.session.confirmedTick, PEER.session.tick - 1));
            }
        },
        onGap() {
            PEER.loop.resetTiming();
            PEER.needsReset = 'reset';
        },
        onError: FAIL,
    });
    peers.push(PEER);
    PEER.scheduler.start();
    return PEER;
}
function drawPeer(peer) {
    if (peer.publishedTick < 0 || peer.session.resimulating) {
        return;
    }
    const FRAME = peer.presentation.frame(performance.now()),
        MODELS = new Map(),
        PATH = [];
    peer.stats.frames++;
    FRAME.forEach((m, id, g) =>
        MODELS.set(id, {
            m,
            g,
        }),
    );
    const LOCAL = MODELS.get('actor:' + peer.id)?.m;
    const SELECTED = peer.preview.active || peer.preview.pendingCount > 0 || DEVICES.get(peer.id)?.axis !== 0;
    if (SELECTED) {
        peer.stats.previewFrames++;
    }
    if (peer.wasPreview && !SELECTED) {
        peer.stats.releases++;
    }
    peer.wasPreview = SELECTED;
    peer.display = {
        preview: SELECTED,
        x: LOCAL?.x,
        action: LOCAL?.action ?? null,
        timeMs: FRAME.timeMs,
    };
    const INDEX = peers.indexOf(peer);
    CTX.save();
    CTX.translate(0, INDEX * (HEIGHT + 38));
    CTX.fillStyle = '#8c9eb7';
    CTX.fillText(`참가자 ${peer.id.slice(0, 8)}가 보는 세계 · ${SELECTED ? '로컬 preview' : 'authority'}`, 16, 18);
    CTX.translate(0, 28);
    CTX.strokeStyle = '#33455d';
    CTX.strokeRect(15, 15, WIDTH - 30, HEIGHT - 30);
    for (const [ID, { m: M, g: G }] of MODELS) {
        if (![M.x, M.y, M.z, M.angle].every(Number.isFinite)) {
            throw Error('Non-finite frame pose');
        }
        if (FRAME.sample(ID, G) !== M || FRAME.modelFor(M) !== M) {
            throw Error('Mixed display frame');
        }
        const RADIUS = ID.startsWith('actor:') ? 13 : 5;
        if (ID.startsWith('shot:')) {
            peer.stats.projectileFrames++;
            if (!peer.game.world.shots.some((s) => s.id === ID && s.generation === G)) {
                peer.stats.retainedFrames++;
            }
            FRAME.pathInto(ID, G, PATH);
            CTX.strokeStyle = M.color + '66';
            CTX.beginPath();
            PATH.forEach((p, i) => (i ? CTX.lineTo(p.x, p.y) : CTX.moveTo(p.x, p.y)));
            CTX.stroke();
            const HEAD = PATH.at(-1);
            if (HEAD && (Math.abs(HEAD.x - M.x) > 1e-7 || Math.abs(HEAD.y - M.y) > 1e-7)) {
                throw Error('Trail/body time mismatch');
            }
            const TARGET = MODELS.get('actor:' + M.target)?.m;
            if (TARGET) {
                CTX.setLineDash([3, 5]);
                CTX.beginPath();
                CTX.moveTo(M.x, M.y - M.z);
                CTX.lineTo(TARGET.x, TARGET.y - TARGET.z);
                CTX.stroke();
                CTX.setLineDash([]);
            }
        } else if (M.action) {
            peer.stats.optionalFrames++;
            if (!Number.isFinite(M.action.left / M.action.total)) {
                throw Error('Partial optional action');
            }
        }
        CTX.fillStyle = '#0006';
        CTX.beginPath();
        CTX.ellipse(M.x, M.y, RADIUS, RADIUS * 0.4, 0, 0, Math.PI * 2);
        CTX.fill();
        CTX.save();
        CTX.translate(M.x, M.y - M.z);
        CTX.rotate(M.angle);
        CTX.fillStyle = M.color;
        CTX.fillRect(-RADIUS, -RADIUS, RADIUS * 2, RADIUS * 2);
        CTX.fillStyle = '#fff';
        CTX.fillRect(RADIUS, -2, 7, 4);
        CTX.restore();
        if (M.action) {
            CTX.strokeStyle = '#fff';
            CTX.beginPath();
            CTX.arc(M.x, M.y - M.z, 19, 0, (Math.PI * 2 * M.action.left) / M.action.total);
            CTX.stroke();
        }
    }
    peer.journal.update(performance.now());
    for (const E of peer.effects) {
        const AGE = (performance.now() - E.at) / 260;
        CTX.strokeStyle = E.color;
        CTX.globalAlpha = Math.max(0, 1 - AGE);
        CTX.beginPath();
        if (E.kind === 'instant') {
            CTX.moveTo(E.x, E.y);
            CTX.lineTo(E.x2, E.y2);
        } else {
            CTX.arc(E.x, E.y, 5 + AGE * 22, 0, Math.PI * 2);
        }
        CTX.stroke();
    }
    CTX.globalAlpha = 1;
    CTX.restore();
}
function diagnostic() {
    return {
        tps: peers[0]?.tps,
        connections: [...LIVE_CONNECTIONS].map((p) => p.connectionState),
        errors: [...ERRORS],
        peers: peers.map((p) => ({
            id: p.id,
            tick: p.session.tick,
            confirmedTick: p.session.confirmedTick,
            epoch: p.session.epoch,
            status: p.session.status,
            hash: p.session.getStateHash(),
            rollback: p.stats.rollbacks,
            preview: p.display.preview,
            counts: p.game.world.counts,
            commands: p.game.world.commands,
            actors: p.game.world.actors,
            display: p.display,
            stats: p.stats,
            submissions: p.submission,
        })),
    };
}
function render(now) {
    try {
        CTX.clearRect(0, 0, CANVAS.width, CANVAS.height);
        peers.forEach((p) => p.loop.render());
        if (now - lastDiagnostic > 150) {
            DOLLAR('debug-state').textContent = JSON.stringify(diagnostic(), null, 2);
            DOLLAR('summary').textContent = peers
                .map(
                    (p) =>
                        `${p.id.slice(0, 8)} tick ${p.session.tick}/${p.session.confirmedTick} · rollback ${p.stats.rollbacks} · preview ${!!p.display.preview} · SFX ${p.stats.soundStarts}`,
                )
                .join(' | ');
            lastDiagnostic = now;
        }
    } catch (e) {
        FAIL(e);
    }
    animation = requestAnimationFrame(render);
}
function controls(running) {
    for (const ID of ['mode', 'tps', 'room-input', 'start']) {
        DOLLAR(ID).disabled = running;
    }
    DOLLAR('stop').disabled = !running;
    document.querySelectorAll('[data-command], [data-axis], #compare, #delay').forEach((e) => (e.disabled = !running));
}
function release() {
    for (const P of peers) {
        P.loop.releaseInput();
    }
}
function stop() {
    serial++;
    abort?.abort();
    abort = null;
    cancelAnimationFrame(animation);
    release();
    for (const P of peers) {
        P.scheduler.stop();
        P.loop.stop();
        P.preview.dispose();
        P.journal.dispose();
        P.session.close();
    }
    rooms.forEach((r) => r.close());
    rooms = [];
    peers = [];
    DEVICES.clear();
    stopAt = Infinity;
    IMPAIRMENT.ms = 0;
    controls(false);
    STATUS('중지됨. 두 참가자가 나간 뒤 같은 TPS로 새 방을 시작하세요.');
}
async function start() {
    stop();
    const TOKEN = serial;
    DOLLAR('delay').textContent = 'A → B RTC 송신 지연: 0ms';
    ERRORS.length = 0;
    DOLLAR('error-log').hidden = true;
    DOLLAR('comparison').textContent = '';
    abort = new AbortController();
    controls(true);
    const MODE = DOLLAR('mode').value,
        TPS = Number(DOLLAR('tps').value),
        ROOM = DOLLAR('room-input').value;
    DOLLAR('delay').disabled = MODE !== 'local';
    audio ??= typeof AudioContext === 'function' ? new AudioContext() : null;
    audio?.resume();
    const OPTIONS = {
        room: ROOM,
        namespace: 'bloom-reference-v2-' + TPS,
        maxPlayers: 2,
        signal: abort.signal,
        retryMs: 200,
        advertiseIntervalMs: 500,
    };
    try {
        STATUS(`${TPS} TPS 방 준비 중…`);
        const ADD = async (role) => {
            const R = await createNostrDynamicRoom({
                ...OPTIONS,
                role,
            });
            if (serial !== TOKEN) {
                R.close();
                return;
            }
            rooms.push(R);
            installPeer(R, TPS);
        };
        if (MODE === 'local') {
            OPTIONS.signalerFactory = localSignaling();
            OPTIONS.peerFactory = delayedPeer;
            OPTIONS.rtcConfig = {
                iceServers: [],
            };
            await ADD('host');
            await ADD('join');
        } else {
            await ADD(MODE);
        }
        if (serial !== TOKEN) {
            return;
        }
        CANVAS.height = (HEIGHT + 38) * peers.length;
        document.querySelectorAll('[data-player="b"]').forEach((e) => (e.hidden = MODE !== 'local'));
        STATUS(`${TPS} TPS · 입력 60Hz / RAF 표시 · 방 ${ROOM} · 실행 중 TPS 변경 불가`);
        animation = requestAnimationFrame(render);
    } catch (e) {
        if (serial === TOKEN) {
            stop();
            FAIL(e);
        }
    }
}
function peerAt(label) {
    return peers[label === 'b' ? 1 : 0];
}
function observe(label, axis, command) {
    const P = peerAt(label);
    if (!P?.session.ready) {
        return;
    }
    const D = DEVICES.get(P.id);
    if (axis !== undefined) {
        D.axis = axis;
    }
    if (command) {
        D.commands.push(command);
    }
    P.loop.observeInput(performance.now());
}
document.querySelectorAll('[data-axis]').forEach((b) => {
    b.onpointerdown = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        observe(b.dataset.player, Number(b.dataset.axis));
    };
    for (const EVENT of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        b.addEventListener(EVENT, () => observe(b.dataset.player, 0));
    }
});
document
    .querySelectorAll('[data-command]')
    .forEach((b) => (b.onclick = () => observe(b.dataset.player, undefined, Number(b.dataset.command))));
const KEYS = {
    ArrowLeft: ['a', 1],
    ArrowRight: ['a', 2],
    KeyA: ['b', 1],
    KeyD: ['b', 2],
};
window.addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
        return;
    }
    if (KEYS[e.code]) {
        e.preventDefault();
        observe(...KEYS[e.code]);
    }
    if (!e.repeat && e.code === 'Space') {
        e.preventDefault();
        observe('a', undefined, 1);
    }
    if (!e.repeat && e.code === 'KeyF') {
        observe('a', undefined, 2);
    }
});
window.addEventListener('keyup', (e) => {
    if (KEYS[e.code]) {
        observe(KEYS[e.code][0], 0);
    }
});
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        release();
    } else {
        for (const P of peers) {
            P.loop.resetTiming();
            P.scheduler.rebase();
            P.needsReset = 'reset';
        }
    }
});
window.addEventListener('pagehide', () => {
    stop();
    audio?.close();
});
DOLLAR('start').onclick = start;
DOLLAR('stop').onclick = stop;
DOLLAR('delay').onclick = () => {
    IMPAIRMENT.ms = IMPAIRMENT.ms ? 0 : 240;
    DOLLAR('delay').textContent = `A → B RTC 송신 지연: ${IMPAIRMENT.ms}ms`;
};
DOLLAR('compare').onclick = async () => {
    if (peers.length !== 2) {
        return;
    }
    const COMPARISON_SERIAL = serial;
    DOLLAR('comparison').dataset.result = 'pending';
    release();
    stopAt = Math.max(...peers.map((p) => p.session.tick)) + Math.ceil(peers[0].tps * 0.5);
    const TARGET = stopAt,
        DEADLINE = performance.now() + 10000;
    while (
        serial === COMPARISON_SERIAL &&
        performance.now() < DEADLINE &&
        !peers.every(
            (p) => p.session.tick === TARGET && p.session.confirmedTick >= TARGET - 1 && !p.session.resimulating,
        )
    ) {
        await new Promise((r) => setTimeout(r, 20));
    }
    if (serial !== COMPARISON_SERIAL) {
        return;
    }
    const SNAPSHOT = diagnostic(),
        EQUAL =
            SNAPSHOT.peers.every((p) => p.tick === TARGET && p.confirmedTick >= TARGET - 1) &&
            new Set(SNAPSHOT.peers.map((p) => p.hash)).size === 1;
    DOLLAR('comparison').dataset.result = EQUAL ? 'matched' : 'failed';
    DOLLAR('comparison').textContent =
        `tick ${TARGET} · ${EQUAL ? '확정 hash 일치' : '아직 불일치'} · ${SNAPSHOT.peers.map((p) => p.hash).join(' / ')}`;
    window.reference.lastComparison = SNAPSHOT;
    stopAt = Infinity;
};
window.reference = {
    get diagnostics() {
        return diagnostic();
    },
    lastComparison: null,
};
controls(false);

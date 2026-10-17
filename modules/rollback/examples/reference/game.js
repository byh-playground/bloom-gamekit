import { createValueCodec } from '../../../../dist/deterministic.js';
import { RenderObject as R } from '../../../../dist/interpolation.js';

// Game-owned rules/data only. No clock, DOM, network, audio or live-world preview writes.
const CODEC = createValueCodec(),
    WIDTH = 720,
    HEIGHT = 280;
export { CODEC as codec, WIDTH, HEIGHT };
export class Actor extends R {
    static renderSchema = {
        id: R.STEP,
        generation: R.STEP,
        x: R.POSITION_X,
        y: R.POSITION_Y,
        z: R.POSITION_Z,
        angle: R.ANGLE,
        color: R.STEP,
        'action.kind': R.STATE_KEY,
        'action.sequence': R.STATE_KEY,
        'action.left': R.COUNTDOWN_MS,
        'action.total': R.STATE_KEY,
        // Ordinary XYZ/angle remain interpolated. A root STATE_KEY cuts the whole
        // actor pose in local preview too; STEP would only switch the serial itself.
        teleportSerial: R.STATE_KEY,
    };
}
export class Shot extends R {
    static renderSchema = {
        owner: R.STEP,
        target: R.STEP,
        x: R.POSITION_X,
        y: R.POSITION_Y,
        z: R.POSITION_Z,
        angle: R.ANGLE,
        originX: R.ORIGIN_X,
        originY: R.ORIGIN_Y,
        originZ: R.ORIGIN_Z,
        color: R.STEP,
    };
    static renderPath = {
        x: 'x',
        y: 'y',
        durationMs: 220,
        maxPoints: 32,
    };
}
export function newWorld() {
    return {
        version: 2,
        tick: 0,
        epoch: 0,
        players: [],
        actors: {},
        shots: [],
        commands: [],
        counts: {},
        teleports: 0,
    };
}
export function membership(world, change) {
    world.tick = change.tick;
    world.epoch = change.epoch;
    world.players = [...change.players];
    for (const ID of change.left) {
        delete world.actors[ID];
        delete world.counts[ID];
    }
    for (const ID of change.joined) {
        const INDEX = world.players.indexOf(ID);
        world.actors[ID] = {
            id: ID,
            generation: change.epoch,
            x: INDEX ? 540 : 180,
            y: INDEX ? 200 : 80,
            z: 0,
            angle: INDEX ? Math.PI : 0,
            color: INDEX ? '#92c5ff' : '#c8ef95',
            action: null,
            shotGeneration: 0,
            teleportSerial: 0,
        };
        world.counts[ID] = {
            dash: 0,
            fire: 0,
            spark: 0,
            teleport: 0,
        };
    }
    world.shots = world.shots.filter((s) => world.players.includes(s.owner));
}
export function stepWorld(world, { tick, inputs }, stepMs, emit = () => {}) {
    if (tick !== world.tick) {
        throw Error('Game snapshot/tick boundary');
    }
    const SECONDS = stepMs / 1000;
    for (const FRAME of [...inputs].sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))) {
        const A = world.actors[FRAME.playerId];
        if (!A) {
            throw Error('Unknown input owner');
        }
        const AXIS = FRAME.input[0] === 1 ? -1 : FRAME.input[0] === 2 ? 1 : 0;
        if (AXIS) {
            A.angle = AXIS < 0 ? Math.PI : 0;
        }
        for (const C of FRAME.commands) {
            // Commands keep the SDK-assigned immutable T, including resimulation and fork replay.
            if (C.executeTick !== undefined && C.executeTick !== tick) {
                throw Error('Command executed outside reserved T');
            }
            const KIND = ['', 'dash', 'fire', 'teleport', 'spark'][C.payload[0]];
            if (!KIND) {
                throw Error('Unknown command');
            }
            world.counts[A.id][KIND]++;
            world.commands.push({
                owner: A.id,
                sequence: C.sequence ?? -1,
                tick,
                kind: KIND,
            });
            if (world.commands.length > 64) {
                world.commands.shift();
            }
            const EVENT = {
                tick,
                sequence: C.sequence ?? 0,
                entityId: A.id,
                generation: A.generation,
                payload: {
                    x: A.x,
                    y: A.y,
                    z: 0,
                    color: A.color,
                },
            };
            emit({
                ...EVENT,
                kind: 'sound',
                policy: 'confirmed',
                durationMs: 0,
            });
            emit({
                ...EVENT,
                kind: 'particle',
                policy: 'speculative',
                durationMs: 260,
            });
            if (KIND === 'teleport') {
                A.x = A.x < 360 ? 590 : 130;
                A.teleportSerial++;
                world.teleports++;
                A.action = null;
            } else if (KIND === 'spark') {
                // Born AND gone inside this tick: no endpoint snapshot can infer it.
                // Supply a timed, fixed anchor explicitly; confirmed journal owns delivery.
                emit({
                    ...EVENT,
                    kind: 'instant',
                    policy: 'confirmed',
                    durationMs: 240,
                    payload: {
                        ...EVENT.payload,
                        x2: A.x + Math.cos(A.angle) * 55,
                        y2: A.y,
                    },
                });
            } else {
                A.action = {
                    kind: KIND,
                    sequence: C.sequence ?? 0,
                    left: KIND === 'dash' ? 360 : 180,
                    total: KIND === 'dash' ? 360 : 180,
                };
            }
        }
        const DASH = A.action?.kind === 'dash';
        A.x = Math.max(35, Math.min(WIDTH - 35, A.x + (DASH ? Math.cos(A.angle) * 310 : AXIS * 110) * SECONDS));
        if (A.action) {
            A.action.left = Math.max(0, A.action.left - stepMs);
            if (A.action.left === 0) {
                if (A.action.kind === 'fire') {
                    const TARGET = world.players.find((id) => id !== A.id) ?? A.id,
                        B = world.actors[TARGET];
                    const ANGLE_LOCAL = TARGET === A.id ? A.angle : Math.atan2(B.y - A.y, B.x - A.x);
                    world.shots = world.shots.filter((s) => s.owner !== A.id);
                    world.shots.push({
                        id: 'shot:' + A.id,
                        generation: ++A.shotGeneration,
                        owner: A.id,
                        target: TARGET,
                        color: A.color,
                        x: A.x,
                        y: A.y,
                        z: 0,
                        originX: A.x,
                        originY: A.y,
                        originZ: 0,
                        angle: ANGLE_LOCAL,
                        age: 0,
                        bornMs: tick * stepMs,
                        pathPoints: [],
                    });
                }
                A.action = null; // object→null is deliberately visible through delayed authority / preview release.
            }
        }
    }
    for (const S of world.shots) {
        S.pathPoints = [];
        const VX = Math.cos(S.angle) * 760,
            VY = Math.sin(S.angle) * 760,
            EDGE = VX > 0 ? WIDTH - 15 : 15;
        const UNTIL = VX ? (EDGE - S.x) / VX : Infinity;
        if (UNTIL >= 0 && UNTIL < SECONDS) {
            S.x = EDGE;
            S.y += VY * UNTIL;
            // The renderer cannot invent a within-tick bounce. This exact corner is game data.
            S.pathPoints.push({
                timeMs: tick * stepMs + UNTIL * 1000,
                x: S.x,
                y: S.y,
            });
            S.angle = Math.PI - S.angle;
            S.x -= VX * (SECONDS - UNTIL);
            S.y += VY * (SECONDS - UNTIL);
        } else {
            S.x += VX * SECONDS;
            S.y += VY * SECONDS;
        }
        S.age += stepMs;
        S.z = 45 * Math.sin(Math.PI * Math.min(1, S.age / 1000));
    }
    world.shots = world.shots.filter((s) => s.age < 1000);
    world.tick = tick + 1;
}
export function createGame(stepMs, emit = () => {}) {
    let world = newWorld();
    return {
        get world() {
            return world;
        },
        save: () => CODEC.encode(world),
        load: (bytes) => {
            world = CODEC.decode(bytes);
        },
        validateSnapshot(bytes, { tick } = {}) {
            try {
                const W = CODEC.decode(bytes);
                return (
                    W.version === 2 &&
                    Number.isSafeInteger(W.tick) &&
                    W.tick >= 0 &&
                    (tick === undefined || W.tick === tick) &&
                    W.players.every((id) => [W.actors[id].x, W.actors[id].y].every(Number.isFinite))
                );
            } catch {
                return false;
            }
        },
        applyMembership: (change) => membership(world, change),
        step: (frame) => stepWorld(world, frame, stepMs, frame.recovering || frame.replaying ? () => {} : emit),
    };
}
export function entities(world) {
    return [
        ...world.players.map((id) => ({
            id: 'actor:' + id,
            generation: world.actors[id].generation,
            type: Actor,
            source: world.actors[id],
        })),
        ...world.shots.map((s) => ({
            id: s.id,
            generation: s.generation,
            type: Shot,
            source: s,
            initialTimeMs: s.bornMs,
            initialSource: {
                ...s,
                x: s.originX,
                y: s.originY,
                z: s.originZ,
            },
            pathPoints: s.pathPoints,
        })),
    ];
}

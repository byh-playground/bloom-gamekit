import { bytes, equalBytes } from '../deterministic/utilities.js';
export { VERSION } from './version.js';
// 기존 기록의 형식 식별자입니다. SDK 표시 버전 변경으로 저장 기록을 무효화하지 않습니다.
export const REPLAY_FORMAT_VERSION = '0.3.0-dev';
export const PROTOCOL_VERSION = 3;
export const CHUNK_SIZE = 16384;
export const MAX_TICK = 0x7ffffffe; // Signed ACK fields reserve -1 for no confirmed input.

const DEFAULTS = {
    mode: 'rollback',
    inputScheduling: 'configured',
    inputSafetyMarginMs: 8,
    inputJitterMultiplier: 2,
    tickRate: 60,
    baseInputDelayTicks: 2,
    minInputDelayTicks: 0,
    maxInputDelayTicks: 8,
    rollbackWindowTicks: 12,
    stateHistorySize: 64,
    predictionPolicy: 'hold',
    stallPolicy: 'wait',
    tickDriftThreshold: 2,
    pacingPolicy: 'hold',
    checksumInterval: 30,
    maxCatchupSteps: 4,
    adaptiveInputDelay: true,
    heartbeatMs: 100,
    adaptationIntervalMs: 1000,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxHistoryBytes: 64 * 1024 * 1024,
    maxReplayBytes: 64 * 1024 * 1024,
    maxCommandBytes: 2048,
    maxPendingCommands: 256,
    maxQueuedBytes: 5 * 1024 * 1024,
    recoveryTimeoutMs: 10000,
    maxRecoveryAttempts: 3,
    peerInterruptMs: 1000,
    peerTimeoutMs: 10000,
};
export { DEFAULTS as defaults };
const PROFILES = Object.freeze({
    action: Object.freeze({
        ...DEFAULTS,
    }),
    rts: Object.freeze({
        ...DEFAULTS,
        tickRate: 20,
        baseInputDelayTicks: 4,
        maxInputDelayTicks: 12,
        rollbackWindowTicks: 6,
        stateHistorySize: 32,
        predictionPolicy: 'neutral',
        checksumInterval: 20,
    }),
    lockstep: Object.freeze({
        ...DEFAULTS,
        mode: 'lockstep',
        tickRate: 20,
        baseInputDelayTicks: 4,
        maxInputDelayTicks: 20,
        rollbackWindowTicks: 0,
        checksumInterval: 20,
        stateHistorySize: 32,
        predictionPolicy: 'neutral',
    }),
});
export { PROFILES as profiles };
const ENCODER = new TextEncoder();
export { ENCODER as encoder };
const DECODER = new TextDecoder('utf-8', {
    fatal: true,
});
// Gameplay packets use explicitly defined little-endian fields, not JS object serialization.
export { DECODER as decoder };
export const MAGIC = 0x314b4252;
export const TYPE = Object.freeze({
    HELLO: 1,
    INPUT: 2,
    CLOCK: 3,
    HASH: 4,
    REQUEST: 5,
    BEGIN: 6,
    CHUNK: 7,
    INPUT_RESERVATION: 8,
    INPUT_RESERVATION_ACK: 9,
});
export const HEADER = 12;
export const SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;
export class Writer {
    constructor(size = CHUNK_SIZE) {
        this.data = new Uint8Array(size);
        this.view = new DataView(this.data.buffer);
        this.offset = 0;
    }
    room(n) {
        if (this.offset + n > this.data.length) {
            throw new RangeError('packet capacity');
        }
    }
    u8(n) {
        this.room(1);
        this.view.setUint8(this.offset++, n);
    }
    u16(n) {
        this.room(2);
        this.view.setUint16(this.offset, n, true);
        this.offset += 2;
    }
    u32(n) {
        this.room(4);
        this.view.setUint32(this.offset, n, true);
        this.offset += 4;
    }
    i32(n) {
        this.room(4);
        this.view.setInt32(this.offset, n, true);
        this.offset += 4;
    }
    raw(b) {
        this.room(b.length);
        this.data.set(b, this.offset);
        this.offset += b.length;
    }
    finish() {
        return this.data.slice(0, this.offset);
    }
    reset() {
        this.offset = 0;
        return this;
    }
    usedBytes() {
        return this.data.subarray(0, this.offset);
    }
}
export class Reader {
    constructor(data) {
        this.data = bytes(data);
        this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
        this.offset = 0;
    }
    room(n) {
        if (this.offset + n > this.data.length) {
            throw new RangeError('truncated packet');
        }
    }
    u8() {
        this.room(1);
        return this.view.getUint8(this.offset++);
    }
    u16() {
        this.room(2);
        const N = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return N;
    }
    u32() {
        this.room(4);
        const N = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return N;
    }
    i32() {
        this.room(4);
        const N = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return N;
    }
    raw(n) {
        this.room(n);
        const B = this.data.slice(this.offset, this.offset + n);
        this.offset += n;
        return B;
    }
    /** 복사 없는 보기. 패킷 buffer를 가리키므로 보관하기 전에 복사합니다. */
    rawView(n) {
        this.room(n);
        const B = this.data.subarray(this.offset, this.offset + n);
        this.offset += n;
        return B;
    }
    end() {
        if (this.offset !== this.data.length) {
            throw new RangeError('trailing packet bytes');
        }
    }
}
// 패킷 작성은 동기적으로 끝나므로(작성 중 송신·재진입 없음) 모듈 하나의 작업 버퍼를 재사용합니다.
// finish()는 쓴 길이만큼의 새 bytes를 돌려주므로 보관·큐잉해도 다음 패킷과 겹치지 않습니다.
const PACKET_WRITER = new Writer();
/** 헤더를 쓴 공유 Writer를 돌려줍니다. 본문을 쓴 뒤 바로 finish()로 꺼냅니다. tag는 헤더의 예약 u16입니다. */
export function beginPacket(type, sequence, tag = 0) {
    const W = PACKET_WRITER.reset();
    W.u32(MAGIC);
    W.u8(PROTOCOL_VERSION);
    W.u8(type);
    W.u16(tag);
    W.u32(sequence);
    return W;
}
export function frameEqual(a, b) {
    if (!equalBytes(a.input, b.input) || a.commands.length !== b.commands.length) {
        return false;
    }
    for (let i = 0; i < a.commands.length; i++) {
        if (
            a.commands[i].sequence !== b.commands[i].sequence ||
            !equalBytes(a.commands[i].payload, b.commands[i].payload)
        ) {
            return false;
        }
    }
    return true;
}
export function copyFrame(frame) {
    return {
        input: frame.input.slice(),
        commands: frame.commands.map((c) => ({
            ...c,
            payload: c.payload.slice(),
        })),
    };
}
// Every live, recovery, replay and diagnostic execution crosses this same boundary.
// 호출자는 매번 새 context 리터럴을 넘기므로 inputs 자리에 소유 복사본을 넣어 그대로 넘깁니다.
// 어댑터가 받는 frame·command는 항상 새 복사본입니다(키 순서: input, commands, playerId, predicted).
export function runSimulationFrame(adapter, context) {
    const SOURCE = context.inputs,
        INPUTS = new Array(SOURCE.length);
    for (let i = 0; i < SOURCE.length; i++) {
        const FRAME = SOURCE[i];
        INPUTS[i] = {
            input: FRAME.input.slice(),
            commands: copyCommands(FRAME.commands),
            playerId: FRAME.playerId,
            predicted: !!FRAME.predicted,
        };
    }
    context.inputs = INPUTS;
    return adapter.step(context);
}
function copyCommands(commands) {
    const OUT = new Array(commands.length);
    for (let i = 0; i < commands.length; i++) {
        OUT[i] = {
            ...commands[i],
            payload: commands[i].payload.slice(),
        };
    }
    return OUT;
}
// Replay input log: only ticks where a player's input bytes change. Each entry is
// [unsigned LEB128 tick delta][player index][inputSize bytes]; every player has an
// entry at tick 0. Commands are rare and stay as a list with their local tick.
// 확정되는 틱마다 바로 이 형식으로 덧붙여, 틱마다 프레임 객체를 쌓아 두지 않습니다.
export class ReplayLog {
    /** `boundaryWindow`: 지난 몇 틱까지 그 틱 경계로 잘라 내보낼 수 있는지(링 버퍼 크기). */
    constructor(players, keepFrames = 0, boundaryWindow = 1) {
        this.players = players;
        this.ticks = 0;
        this.keepFrames = keepFrames;
        // 앞쪽 keepFrames개 프레임만 원본 참조로 둡니다(synctest 내보내기용, 최대 256).
        this.frames = [];
        this._last = players.map(() => null);
        this._previous = 0;
        this._bytes = new Uint8Array(1024);
        this._length = 0;
        this._commands = [];
        // 틱 t를 덧붙이기 직전의 bytes 길이·명령 수(t % 창 위치). 경계 t로 자를 때 씁니다.
        this._window = boundaryWindow;
        this._startLength = new Int32Array(boundaryWindow);
        this._startCommands = new Int32Array(boundaryWindow);
    }
    _reserve(n) {
        if (this._length + n > this._bytes.length) {
            const NEXT = new Uint8Array(Math.max(this._length + n, this._bytes.length * 2));
            NEXT.set(this._bytes.subarray(0, this._length));
            this._bytes = NEXT;
        }
    }
    /** inputs는 players 순서의 { input, commands }이며 바뀌지 않는 원본으로 다룹니다. 배열은 보관하지 않습니다. */
    push(tick, inputs) {
        if (tick !== this.ticks) {
            throw new RangeError('replay tick order');
        }
        this._startLength[tick % this._window] = this._length;
        this._startCommands[tick % this._window] = this._commands.length;
        for (let p = 0; p < inputs.length; p++) {
            const X = inputs[p];
            for (let c = 0; c < X.commands.length; c++) {
                this._commands.push({ ...X.commands[c], tick, playerId: this.players[p] });
            }
            const LAST = this._last[p];
            if (LAST && equalBytes(LAST, X.input)) {
                continue;
            }
            // LEB128 틱 차이는 MAX_TICK(2^31) 안이라 최대 5바이트, 선수 번호 1바이트.
            this._reserve(6 + X.input.length);
            for (let d = tick - this._previous; ; d >>>= 7) {
                if (d < 0x80) {
                    this._bytes[this._length++] = d;
                    break;
                }
                this._bytes[this._length++] = (d & 0x7f) | 0x80;
            }
            this._bytes[this._length++] = p;
            this._bytes.set(X.input, this._length);
            this._length += X.input.length;
            this._last[p] = X.input;
            this._previous = tick;
        }
        if (this.frames.length < this.keepFrames) {
            this.frames.push({ tick, inputs: inputs.slice() });
        }
        this.ticks++;
    }
    /** 기록한 틱 수와 `ticks` 중 작은 쪽까지 내보냅니다. 내보내는 값은 매번 새 복사본입니다. */
    export(ticks = this.ticks) {
        let length = this._length,
            commands = this._commands.length;
        if (ticks < this.ticks) {
            if (ticks < 0 || this.ticks - ticks > this._window) {
                throw new RangeError('replay boundary outside window');
            }
            length = this._startLength[ticks % this._window];
            commands = this._startCommands[ticks % this._window];
        }
        const COMMANDS = new Array(commands);
        for (let i = 0; i < commands; i++) {
            const C = this._commands[i];
            COMMANDS[i] = { ...C, payload: C.payload.slice() };
        }
        return { inputChanges: this._bytes.slice(0, length), commands: COMMANDS };
    }
}
export function decodeReplayFrames({ inputChanges, commands, players, inputSize, tick }) {
    const DATA = bytes(inputChanges),
        CURRENT = players.map(() => null),
        FRAMES = [];
    let at = 0,
        next = 0;
    const READ = () => {
        if (at >= DATA.length) {
            return null;
        }
        let delta = 0;
        for (let shift = 0; ; shift += 7) {
            const B = DATA[at++];
            delta += (B & 0x7f) * 2 ** shift;
            if (B < 0x80) {
                break;
            }
        }
        const P = DATA[at++];
        if (P >= players.length || at + inputSize > DATA.length) {
            throw new Error('replay input changes');
        }
        next += delta;
        at += inputSize;
        return { tick: next, player: P, input: DATA.slice(at - inputSize, at) };
    };
    let pending = READ();
    let c = 0;
    for (let t = 0; t < tick; t++) {
        while (pending && pending.tick === t) {
            CURRENT[pending.player] = pending.input;
            pending = READ();
        }
        if (CURRENT.some((x) => !x)) {
            throw new Error('replay input changes');
        }
        const INPUTS = players.map((playerId, i) => ({ playerId, input: CURRENT[i], commands: [], predicted: false }));
        for (; c < commands.length && commands[c].tick === t; c++) {
            const { tick: OMITTED_TICK, playerId: PLAYER_ID, ...COMMAND } = commands[c];
            COMMAND.payload = bytes(COMMAND.payload);
            INPUTS[players.indexOf(PLAYER_ID)].commands.push(COMMAND);
        }
        FRAMES.push({ tick: t, inputs: INPUTS });
    }
    if (pending || c !== commands.length) {
        throw new Error('replay input changes');
    }
    return FRAMES;
}

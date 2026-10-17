import { performance } from 'node:perf_hooks';
import { createRoomSession, createSession, profiles } from '../index.js';
const TICKS = 20000,
    BYTES = 128 * 1024,
    INPUT = new Uint8Array([1]);
const PROFILE = {
    ...profiles.lockstep,
    baseInputDelayTicks: 0,
    checksumInterval: 20,
    stateHistorySize: 64,
    pacingPolicy: 'none',
};
function adapter() {
    let state = new Uint8Array(BYTES);
    let view = new DataView(state.buffer);
    return {
        save: () => state.slice(),
        load: (b) => {
            state = b.slice();
            view = new DataView(state.buffer);
        },
        validateSnapshot: (b) => b.length === BYTES,
        applyMembership() {},
        step({ tick, inputs }) {
            view.setUint32(0, tick + 1, true);
            view.setUint32(4, view.getUint32(4, true) + inputs[0].input[0], true);
        },
    };
}
function run(dynamic) {
    const OPTIONS = {
            adapter: adapter(),
            simulationVersion: 'bench',
            seed: 1,
            inputSize: 1,
            profile: PROFILE,
            recordReplay: false,
        },
        S = dynamic
            ? createRoomSession(OPTIONS)
            : createSession({
                  ...OPTIONS,
                  players: ['local'],
                  localPlayerId: 'local',
                  sessionId: 'local',
              });
    const START = performance.now();
    for (let n = 0; n < TICKS; n++) {
        S.advance(INPUT);
    }
    const MS = performance.now() - START,
        M = S.metrics;
    S.close();
    return {
        mode: dynamic ? 'RoomSession/local' : 'fixed Core',
        ticks: TICKS,
        ms: MS,
        usPerTick: (MS / TICKS) * 1000,
        snapshotSaves: M.snapshotSaves,
        serializedSnapshotBytes: M.serializedSnapshotBytes,
        retainedSnapshotBytes: M.retainedSnapshotBytes,
    };
}
run(false);
run(true);
const RESULTS = [];
for (let n = 0; n < 5; n++) {
    RESULTS.push(run(false), run(true));
}
console.log(
    JSON.stringify(
        {
            environment: process.version,
            scope: 'Node CPU only; 128 KiB canonical snapshot, no rendering/network; includes hash checkpoint work',
            results: RESULTS,
        },
        null,
        2,
    ),
);

import { REPLAY_FORMAT_VERSION, decodeReplayFrames, runSimulationFrame } from '../_rollback-shared/protocol.js';
import { bytes, hashBytes, ByteBuffer, saveSnapshot } from '../deterministic/utilities.js';
export function playReplay({ adapter, replay, simulationVersion = replay?.simulationVersion } = {}) {
    if (
        replay?.version !== REPLAY_FORMAT_VERSION ||
        replay.simulationVersion !== simulationVersion ||
        !Array.isArray(replay.players) ||
        !Array.isArray(replay.commands)
    ) {
        throw new Error('replay compatibility');
    }
    const FRAMES = decodeReplayFrames(replay);
    // RoomSession segments carry the global tick and roster epoch their adapter saw.
    const BASE_TICK = replay.baseTick ?? 0;
    adapter.load(bytes(replay.initialState).slice());
    for (const F of FRAMES) {
        runSimulationFrame(adapter, {
            tick: BASE_TICK + F.tick,
            tickRate: replay.tickRate,
            inputs: F.inputs.map((x) => ({
                ...x,
                commands: x.commands.map((c) => ({ ...c, executeTick: c.executeTick + BASE_TICK })),
            })),
            resimulating: true,
            replaying: true,
            ...(replay.membershipEpoch === undefined ? {} : { membershipEpoch: replay.membershipEpoch }),
        });
    }
    return {
        tick: FRAMES.length,
        hash: hashBytes(saveSnapshot(adapter, new ByteBuffer())),
    };
}

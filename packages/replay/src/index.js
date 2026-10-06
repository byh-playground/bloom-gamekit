import { VERSION, runSimulationFrame } from '../../_rollback-shared/src/protocol.js';
import { bytes, hashBytes } from '../../deterministic/src/utilities.js';
export function playReplay({ adapter, replay, simulationVersion = replay?.simulationVersion } = {}) {
  if (replay?.version !== VERSION || replay.simulationVersion !== simulationVersion || !Array.isArray(replay.frames)) throw new Error('replay compatibility');
  adapter.load(bytes(replay.initialState).slice());
  let tick = 0;
  for (const f of replay.frames) {
    if (f.tick !== tick) throw new Error('non-contiguous replay');
    runSimulationFrame(adapter, { tick, tickRate: replay.tickRate, inputs: f.inputs.map(x => ({ ...x, predicted: false })), resimulating: true, replaying: true }); tick++;
  }
  return { tick, hash: hashBytes(bytes(adapter.save())) };
}

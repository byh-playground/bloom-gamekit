/** replay 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { PlayerId, PlayerInput, SimulationAdapter } from '../rollback/index.js';
export interface Replay {
  version: string; simulationVersion: string; seed: number; players: PlayerId[]; inputSize: number; tickRate: number;
  initialState: Uint8Array; frames: { tick: number; inputs: PlayerInput[] }[]; tick: number; hash: number; truncated: boolean;
}
export function playReplay(options: { adapter: SimulationAdapter; replay: Replay; simulationVersion?: string }): { tick: number; hash: number };

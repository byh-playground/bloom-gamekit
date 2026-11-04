/** replay 공개 계약. 타입 전용 참조는 런타임 의존성을 만들지 않습니다. */
import type { Command, PlayerId, SimulationAdapter } from '../rollback/index.js';
export interface Replay {
    version: string;
    simulationVersion: string;
    seed: number;
    players: PlayerId[];
    inputSize: number;
    tickRate: number;
    initialState: Uint8Array;
    /** 입력이 바뀐 tick만: [tick 차이 LEB128][players 순번][inputSize 바이트]. 모든 참가자는 tick 0에 항목이 있다. */
    inputChanges: Uint8Array;
    /** 실행된 명령. tick은 이 기록의 로컬 tick이다. */
    commands: (Command & { tick: number; playerId: PlayerId })[];
    /** 기록된 tick 수. */
    tick: number;
    /** RoomSession 구간: adapter가 받은 전역 tick의 시작(기본 0)과 roster 세대. */
    baseTick?: number;
    membershipEpoch?: number;
    hash: number;
    truncated: boolean;
}
export function playReplay(options: { adapter: SimulationAdapter; replay: Replay; simulationVersion?: string }): {
    tick: number;
    hash: number;
};

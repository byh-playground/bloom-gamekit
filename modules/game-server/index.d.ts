export interface AuthoritativeWorld<Id, Input, Snapshot> {
    join(id: Id): void;
    leave(id: Id): void;
    tick(inputs: ReadonlyMap<Id, Readonly<Input>>): void;
    snapshot(id: Id): Snapshot | null | undefined;
    dispose(): void;
}

export interface AuthoritativeSessionOptions<Id, Input, Packet, Snapshot> {
    world: AuthoritativeWorld<Id, Input, Snapshot>;
    createInput(): Input;
    mergeInput(current: Input, packet: Packet): void;
    resetInput(current: Input): void;
    consumeInput(current: Input): void;
    inputTimeoutMs?: number;
}

export interface AuthoritativeSession<Id, Packet, Snapshot> {
    readonly size: number;
    join(id: Id, nowMs: number): boolean;
    leave(id: Id): boolean;
    receive(id: Id, seq: number, packet: Packet, nowMs: number): boolean;
    lastReceivedAt(id: Id): number | undefined;
    step(nowMs: number): void;
    snapshot(id: Id): { snapshot: Snapshot; ackSeq: number } | null;
    dispose(): void;
}

export function createAuthoritativeSession<Id, Input, Packet, Snapshot>(
    options: AuthoritativeSessionOptions<Id, Input, Packet, Snapshot>,
): AuthoritativeSession<Id, Packet, Snapshot>;

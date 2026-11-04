/** A frozen behavior tree node; build it with action, guard or selector. */
export interface BehaviorNode<Context = unknown> {
    readonly name: string;
}

/** A leaf: `run` returns true when it took the actor's turn, false to let the next sibling try. */
export function action<Context>(name: string, run: (context: Context) => boolean): BehaviorNode<Context>;
/** Evaluates `child` only while `test` (a read-only query) holds. */
export function guard<Context>(
    name: string,
    test: (context: Context) => boolean,
    child: BehaviorNode<Context>,
): BehaviorNode<Context>;
/** Tries children in order and stops at the first that takes the turn. */
export function selector<Context>(name: string, children: BehaviorNode<Context>[]): BehaviorNode<Context>;

export type BehaviorShape = string | { [name: string]: BehaviorShape | BehaviorShape[] };

/** A decision-only tree shared by every actor; it keeps no per-actor state. */
export class BehaviorTree<Context = unknown> {
    constructor(root: BehaviorNode<Context>);
    /** The name of the action that took the turn, or null. */
    decide(context: Context): string | null;
    /** Node names in tree shape, for debugging and docs. Allocates on every call. */
    describe(): BehaviorShape;
}

export interface StateDefinition<Host, Context> {
    /** States this one may move to; any other transition throws. */
    to?: string[];
    enter?(host: Host, context: Context): void;
    exit?(host: Host, context: Context): void;
    /** Returns the next state's name to move there, or null/undefined to stay. */
    update?(host: Host, context: Context): string | null | void;
}

/** A state machine whose current state is one string field on each host record. */
export class StateMachine<Host extends object = Record<string, unknown>, Context = unknown> {
    constructor(definition: {
        field?: string;
        initial: string;
        states: Record<string, StateDefinition<Host, Context>>;
    });
    readonly field: string;
    readonly initial: string;
    state(host: Host): string;
    start(host: Host, context?: Context): void;
    transition(host: Host, to: string, context?: Context): string;
    update(host: Host, context?: Context): string;
}

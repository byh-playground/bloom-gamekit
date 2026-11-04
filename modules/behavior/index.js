// 행동 결정과 실행 단계를 나누는 두 도구입니다.
// - 행동트리(BehaviorTree): 행위자가 "지금 무엇을 시작할지"를 우선순위 순서로 고릅니다. 결정 전용이라
//   진행 중(RUNNING) 노드를 두지 않고, 트리 자체에 행위자 상태를 저장하지 않습니다.
// - 상태 기계(StateMachine): 시작한 일의 단계(예열·발동·회복, 경직 등)를 진행합니다. 현재 상태는 행위자
//   레코드의 문자열 필드 하나에 두므로 게임의 기존 저장·스냅샷에 그대로 들어갑니다.
// 둘 다 시간·난수를 직접 읽지 않습니다. 필요한 값은 호출자가 context로 넘깁니다(결정론 시뮬레이션).

const ACTION = 0,
    GUARD = 1,
    SELECTOR = 2;

class BehaviorNode {
    constructor(kind, name, test, run, children) {
        if (typeof name !== 'string' || !name) {
            throw new TypeError('Behavior node name must be a non-empty string.');
        }
        this.kind = kind;
        this.name = name;
        this.test = test;
        this.run = run;
        this.children = children;
        Object.freeze(this);
    }
}

function assertNode(node, where) {
    if (!(node instanceof BehaviorNode)) {
        throw new TypeError(`${where} must be a behavior node.`);
    }
}

/**
 * 잎 노드입니다. run(context)가 true를 돌려주면 이 행동이 이번 차례를 가져간 것이고, false면 다음 형제로 넘어갑니다.
 * @param {string} name
 * @param {(context: any) => boolean} run
 */
export function action(name, run) {
    if (typeof run !== 'function') {
        throw new TypeError('Behavior action run must be a function.');
    }
    return new BehaviorNode(ACTION, name, null, run, null);
}

/**
 * 조건이 참일 때만 child를 평가합니다. 조건은 값을 읽기만 하고 상태를 바꾸지 않습니다.
 * @param {string} name
 * @param {(context: any) => boolean} test
 * @param {BehaviorNode} child
 */
export function guard(name, test, child) {
    if (typeof test !== 'function') {
        throw new TypeError('Behavior guard test must be a function.');
    }
    assertNode(child, 'Behavior guard child');
    // guard의 child는 children 자리에 둡니다(노드 하나를 위한 배열을 만들지 않음).
    return new BehaviorNode(GUARD, name, test, null, child);
}

/**
 * 자식을 순서대로 평가해 처음으로 차례를 가져간 자식에서 멈춥니다(우선순위 선택).
 * @param {string} name
 * @param {BehaviorNode[]} children
 */
export function selector(name, children) {
    if (!Array.isArray(children) || !children.length) {
        throw new TypeError('Behavior selector needs at least one child.');
    }
    children.forEach((child, index) => assertNode(child, `Behavior selector child ${index}`));
    return new BehaviorNode(SELECTOR, name, null, null, Object.freeze([...children]));
}

// 차례를 가져간 잎 노드, 없으면 null.
function evaluate(node, context) {
    switch (node.kind) {
        case ACTION:
            return node.run(context) ? node : null;
        case GUARD:
            return node.test(context) ? evaluate(node.children, context) : null;
        default:
            for (const CHILD of node.children) {
                const TAKEN = evaluate(CHILD, context);
                if (TAKEN) {
                    return TAKEN;
                }
            }
            return null;
    }
}

function describe(node) {
    switch (node.kind) {
        case ACTION:
            return node.name;
        case GUARD:
            return { [node.name]: describe(node.children) };
        default:
            return { [node.name]: node.children.map(describe) };
    }
}

/** 결정 전용 행동트리입니다. 같은 트리 하나를 여러 행위자가 context만 바꿔 공유합니다. */
export class BehaviorTree {
    #root;

    /** @param {BehaviorNode} root */
    constructor(root) {
        assertNode(root, 'BehaviorTree root');
        this.#root = root;
        Object.freeze(this);
    }

    /**
     * 트리를 한 번 평가합니다. 차례를 가져간 행동의 이름, 아무 행동도 가져가지 않았으면 null입니다.
     * @param {any} context 호출자가 소유·재사용하는 행위자 문맥
     * @returns {string | null}
     */
    decide(context) {
        return evaluate(this.#root, context)?.name ?? null;
    }

    /** 디버그·문서용 트리 모양(이름만). 읽을 때만 새 객체를 만듭니다. */
    describe() {
        return describe(this.#root);
    }
}

/**
 * 문자열 필드 하나에 현재 상태를 두는 상태 기계 정의입니다. 정의 하나를 여러 행위자 레코드가 공유합니다.
 * 상태마다 갈 수 있는 상태(to)를 적고, 그 밖의 전이는 오류로 막습니다.
 *
 *     const STAGGER = new StateMachine({
 *         field: 'stagger',
 *         initial: 'standing',
 *         states: {
 *             standing: { to: ['down'], update: (rt, c) => (gaugeFull(rt, c) ? 'down' : null) },
 *             down: { to: ['rising'], enter: stun, update: (rt, c) => (c.boss.stun > 0 ? null : 'rising') },
 *             rising: { to: ['standing'], enter: swing, update: (rt) => (swingDone(rt) ? 'standing' : null) },
 *         },
 *     });
 */
export class StateMachine {
    #states;

    /**
     * @param {{
     *   field?: string,
     *   initial: string,
     *   states: Record<string, {
     *     to?: string[],
     *     enter?: (host: any, context: any) => void,
     *     exit?: (host: any, context: any) => void,
     *     update?: (host: any, context: any) => string | null | void,
     *   }>,
     * }} definition
     */
    constructor({ field = 'state', initial, states } = {}) {
        if (typeof field !== 'string' || !field) {
            throw new TypeError('StateMachine field must be a non-empty string.');
        }
        if (!states || typeof states !== 'object') {
            throw new TypeError('StateMachine states must be an object.');
        }
        const COMPILED = new Map();
        for (const [NAME, STATE] of Object.entries(states)) {
            for (const HOOK of ['enter', 'exit', 'update']) {
                if (STATE[HOOK] !== undefined && typeof STATE[HOOK] !== 'function') {
                    throw new TypeError(`StateMachine ${NAME}.${HOOK} must be a function.`);
                }
            }
            COMPILED.set(
                NAME,
                Object.freeze({
                    to: new Set(STATE.to ?? []),
                    enter: STATE.enter ?? null,
                    exit: STATE.exit ?? null,
                    update: STATE.update ?? null,
                }),
            );
        }
        if (!COMPILED.has(initial)) {
            throw new RangeError(`StateMachine initial state ${initial} is not defined.`);
        }
        for (const [NAME, STATE] of COMPILED) {
            for (const TARGET of STATE.to) {
                if (!COMPILED.has(TARGET)) {
                    throw new RangeError(`StateMachine ${NAME} leads to undefined state ${TARGET}.`);
                }
            }
        }
        this.field = field;
        this.initial = initial;
        this.#states = COMPILED;
        Object.freeze(this);
    }

    /** host의 현재 상태 이름. */
    state(host) {
        return host[this.field];
    }

    /** host를 initial 상태로 두고 그 enter를 실행합니다. */
    start(host, context) {
        host[this.field] = this.initial;
        this.#states.get(this.initial).enter?.(host, context);
    }

    /**
     * 현재 상태의 to에 있는 상태로만 옮깁니다: exit → 필드 변경 → enter. enter 안에서 다시 전이할 수 있습니다.
     * @returns {string} 옮긴 뒤 상태
     */
    transition(host, to, context) {
        const FROM = host[this.field],
            CURRENT = this.#states.get(FROM);
        if (!CURRENT) {
            throw new RangeError(`StateMachine host is in undefined state ${FROM}.`);
        }
        if (!CURRENT.to.has(to)) {
            throw new RangeError(`StateMachine cannot go from ${FROM} to ${to}.`);
        }
        CURRENT.exit?.(host, context);
        host[this.field] = to;
        this.#states.get(to).enter?.(host, context);
        return host[this.field];
    }

    /**
     * 현재 상태의 update를 한 번 실행합니다. update가 상태 이름을 돌려주면 그 상태로 전이합니다.
     * 같은 tick에 새 상태의 update는 실행하지 않습니다.
     * @returns {string} 실행 뒤 상태
     */
    update(host, context) {
        const STATE = this.#states.get(host[this.field]);
        if (!STATE) {
            throw new RangeError(`StateMachine host is in undefined state ${host[this.field]}.`);
        }
        const NEXT = STATE.update?.(host, context);
        if (typeof NEXT === 'string') {
            this.transition(host, NEXT, context);
        }
        return host[this.field];
    }
}

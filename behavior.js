// modules/behavior/index.js
var ACTION = 0;
var GUARD = 1;
var SELECTOR = 2;
var BehaviorNode = class {
  constructor(kind, name, test, run, children) {
    if (typeof name !== "string" || !name) {
      throw new TypeError("Behavior node name must be a non-empty string.");
    }
    this.kind = kind;
    this.name = name;
    this.test = test;
    this.run = run;
    this.children = children;
    Object.freeze(this);
  }
};
function assertNode(node, where) {
  if (!(node instanceof BehaviorNode)) {
    throw new TypeError(`${where} must be a behavior node.`);
  }
}
function action(name, run) {
  if (typeof run !== "function") {
    throw new TypeError("Behavior action run must be a function.");
  }
  return new BehaviorNode(ACTION, name, null, run, null);
}
function guard(name, test, child) {
  if (typeof test !== "function") {
    throw new TypeError("Behavior guard test must be a function.");
  }
  assertNode(child, "Behavior guard child");
  return new BehaviorNode(GUARD, name, test, null, child);
}
function selector(name, children) {
  if (!Array.isArray(children) || !children.length) {
    throw new TypeError("Behavior selector needs at least one child.");
  }
  children.forEach((child, index) => assertNode(child, `Behavior selector child ${index}`));
  return new BehaviorNode(SELECTOR, name, null, null, Object.freeze([...children]));
}
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
var BehaviorTree = class {
  #root;
  /** @param {BehaviorNode} root */
  constructor(root) {
    assertNode(root, "BehaviorTree root");
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
};
var StateMachine = class {
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
  constructor({ field = "state", initial, states } = {}) {
    if (typeof field !== "string" || !field) {
      throw new TypeError("StateMachine field must be a non-empty string.");
    }
    if (!states || typeof states !== "object") {
      throw new TypeError("StateMachine states must be an object.");
    }
    const COMPILED = /* @__PURE__ */ new Map();
    for (const [NAME, STATE] of Object.entries(states)) {
      for (const HOOK of ["enter", "exit", "update"]) {
        if (STATE[HOOK] !== void 0 && typeof STATE[HOOK] !== "function") {
          throw new TypeError(`StateMachine ${NAME}.${HOOK} must be a function.`);
        }
      }
      COMPILED.set(
        NAME,
        Object.freeze({
          to: new Set(STATE.to ?? []),
          enter: STATE.enter ?? null,
          exit: STATE.exit ?? null,
          update: STATE.update ?? null
        })
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
    const FROM = host[this.field], CURRENT = this.#states.get(FROM);
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
    if (typeof NEXT === "string") {
      this.transition(host, NEXT, context);
    }
    return host[this.field];
  }
};
export {
  BehaviorTree,
  StateMachine,
  action,
  guard,
  selector
};

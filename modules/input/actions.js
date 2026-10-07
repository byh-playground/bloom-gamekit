/** @typedef {{held:boolean, pressed:boolean, released:boolean}} ActionSample */

function actionName(action) {
  if (typeof action !== 'string' || !action.length) throw new TypeError('action must be a nonempty string');
}
function sourceId(source) {
  if ((typeof source !== 'string' || !source.length) && typeof source !== 'symbol') {
    throw new TypeError('source must be a nonempty string or symbol');
  }
}

/**
 * DOM·타이머·게임 tick을 소유하지 않는 입력 상태. 여러 source의 hold를 OR로 합칩니다.
 * pressed/released는 consume()까지 유지되므로 렌더 샘플링으로 짧은 입력이 사라지지 않습니다.
 * 액션 이름은 게임이 정한 유한한 이름 집합으로 사용하세요. 포인터 ID는 source에 넣습니다.
 */
export class ActionState {
  #actions = new Map();
  #sources = new Map();

  #entry(action) {
    let entry = this.#actions.get(action);
    if (!entry) {
      entry = { sources: new Set(), pressed: false, released: false };
      this.#actions.set(action, entry);
    }
    return entry;
  }

  /**
   * 실제 장치/source의 눌림을 갱신합니다. 반복 down/up은 무시합니다.
   * 첫 source가 눌리면 pressed, 마지막 source가 해제되면 released가 생깁니다.
   * @param {string} action @param {string|symbol} source @param {boolean} down
   */
  set(action, source, down) {
    actionName(action); sourceId(source);
    if (typeof down !== 'boolean') throw new TypeError('down must be boolean');
    const entry = down ? this.#entry(action) : this.#actions.get(action);
    if (!entry || entry.sources.has(source) === down) return;
    if (down) {
      if (!entry.sources.size) entry.pressed = true;
      entry.sources.add(source);
      let actions = this.#sources.get(source);
      if (!actions) this.#sources.set(source, actions = new Set());
      actions.add(action);
    } else {
      entry.sources.delete(source);
      if (!entry.sources.size) entry.released = true;
      const actions = this.#sources.get(source);
      actions.delete(action);
      if (!actions.size) this.#sources.delete(source);
    }
  }

  /**
   * tap 같은 이산 행동의 pressed/released를 함께 표시합니다. 기존 hold는 유지합니다.
   * 같은 consume 구간의 반복 pulse는 bool 하나로 합쳐집니다. 횟수/좌표는 호출자가 큐에 보관합니다.
   * @param {string} action
   */
  pulse(action) {
    actionName(action);
    const entry = this.#entry(action);
    entry.pressed = true; entry.released = true;
  }

  /** 해당 source의 hold만 해제합니다. 다른 장치/어댑터의 hold는 유지합니다. @param {string|symbol} source */
  releaseSource(source) {
    sourceId(source);
    const actions = this.#sources.get(source);
    if (!actions) return;
    for (const action of actions) {
      const entry = this.#actions.get(action);
      entry.sources.delete(source);
      if (!entry.sources.size) entry.released = true;
    }
    this.#sources.delete(source);
  }

  /** 모든 source를 해제합니다. 남아 있는 edge는 consume() 전까지 유지됩니다. */
  releaseAll() {
    for (const source of this.#sources.keys()) this.releaseSource(source);
  }

  /** 소비 없이 재사용 가능한 out을 갱신합니다. 모르는 액션은 모두 false입니다. @param {string} action @param {ActionSample} out @returns {ActionSample} */
  sampleInto(action, out) {
    actionName(action);
    if (!out || typeof out !== 'object') throw new TypeError('out must be a writable object');
    const entry = this.#actions.get(action);
    out.held = !!entry?.sources.size;
    out.pressed = entry?.pressed ?? false;
    out.released = entry?.released ?? false;
    return out;
  }

  /** 새 객체가 필요한 편의 함수. 매 프레임에는 sampleInto를 쓰세요. @param {string} action @returns {ActionSample} */
  sample(action) { return this.sampleInto(action, {}); }

  /** 게임의 입력 제출/simulation tick 경계에서만 명시적으로 호출합니다. hold는 유지합니다. */
  consume() {
    for (const entry of this.#actions.values()) {
      entry.pressed = false; entry.released = false;
    }
  }
}

// modules/object-pool/index.js
var ObjectPool = class {
  #create;
  #reset;
  #max;
  #free = [];
  /**
   * 설정은 생성할 때만 검사합니다. 객체의 소유권/타입은 호출자가 보장합니다.
   * @param {() => T} create 새 객체를 반환하는 factory
   * @param {((item: T) => void) | null} [reset=null] 반납 시 상태/외부 참조 정리
   * @param {number} [max=256] 보관할 유휴 객체 수의 상한 (활성 개수 제한 아님)
   */
  constructor(create, reset = null, max = 256) {
    if (typeof create !== "function") throw new TypeError("ObjectPool create must be a function.");
    if (reset !== null && typeof reset !== "function") throw new TypeError("ObjectPool reset must be a function or null.");
    if (!Number.isSafeInteger(max) || max < 0) throw new RangeError("ObjectPool max must be a non-negative safe integer.");
    this.#create = create;
    this.#reset = reset;
    this.#max = max;
  }
  /** @returns {T} 유휴 객체 또는 새 객체. 대여 뒤 필요한 초기화는 호출자가 수행합니다. */
  acquire() {
    return this.#free.length ? this.#free.pop() : this.#create();
  }
  /**
   * 이 풀에서 대여한 객체를 정확히 한 번 반납합니다. 이후 참조 사용은 금지합니다.
   * null/undefined는 무시합니다. reset은 상한 초과로 버리는 객체에도 실행합니다.
   * @param {T | null | undefined} item
   */
  release(item) {
    if (item == null) return;
    if (this.#reset) this.#reset(item);
    if (this.#free.length < this.#max) this.#free.push(item);
  }
  /** 유휴 참조만 비웁니다. 대여 중인 객체를 reset/회수하거나 풀을 폐기하지 않습니다. */
  clear() {
    this.#free.length = 0;
  }
};
export {
  ObjectPool
};

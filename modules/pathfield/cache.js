// 거리장을 키로 보관하는 선택적 도우미입니다. 무엇을 키로 삼을지, 언제 새로 만들지는 호출자가 정하고, 이 클래스는
// 세 가지만 맡습니다: 용량을 넘으면 먼저 넣은 것부터 버리기, 격자 통과 판정이 비워지면 낡은 거리장 버리기,
// 세대(틱 등)가 바뀌면 비우기.
import { PathGrid } from './grid.js';

export class FieldCache {
    /** 거리장을 만든 격자. 이 격자가 `invalidate()`되면 담긴 거리장은 모두 버립니다. */
    grid;
    /** 담을 수 있는 최대 개수. 넘기려 하면 먼저 넣은 것부터 버립니다(FIFO). */
    capacity;

    #fields = new Map();
    #revision;
    #epoch;

    /**
     * @param {PathGrid} grid
     * @param {{ capacity?: number }} [options] `capacity`는 1 이상의 정수 또는 `Infinity`(기본).
     */
    constructor(grid, options = {}) {
        if (!(grid instanceof PathGrid)) {
            throw new TypeError('FieldCache needs a PathGrid.');
        }
        const CAPACITY = options.capacity ?? Infinity;
        if (CAPACITY !== Infinity && !(Number.isInteger(CAPACITY) && CAPACITY >= 1)) {
            throw new RangeError('FieldCache capacity must be a positive integer or Infinity.');
        }
        this.grid = grid;
        this.capacity = CAPACITY;
        this.#revision = grid.revision;
    }

    /** 담긴 개수. */
    get size() {
        this.#dropStale();
        return this.#fields.size;
    }

    has(key) {
        this.#dropStale();
        return this.#fields.has(key);
    }

    /** 키의 거리장, 없으면 `undefined`. 꺼내도 순서는 바뀌지 않습니다(LRU가 아님). */
    get(key) {
        this.#dropStale();
        return this.#fields.get(key);
    }

    /** 거리장을 담고 돌려줍니다. 용량이 차 있으면 가장 먼저 넣은 것을 버립니다. 있는 키를 덮어써도 순서는 그대로입니다. */
    set(key, field) {
        this.#dropStale();
        if (!this.#fields.has(key) && this.#fields.size >= this.capacity) {
            this.#fields.delete(this.#fields.keys().next().value);
        }
        this.#fields.set(key, field);
        return field;
    }

    clear() {
        this.#fields.clear();
    }

    /** 세대 번호(틱 등)를 알립니다. 지난번과 다르면 비우고 true를 돌려줍니다. 한 세대 안에서만 공유할 거리장에 씁니다. */
    sync(epoch) {
        if (epoch === this.#epoch) {
            return false;
        }
        this.#epoch = epoch;
        this.#fields.clear();
        return true;
    }

    #dropStale() {
        if (this.#revision !== this.grid.revision) {
            this.#revision = this.grid.revision;
            this.#fields.clear();
        }
    }
}

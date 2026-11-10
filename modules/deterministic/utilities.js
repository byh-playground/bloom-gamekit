const NOW_MS = () => globalThis.performance?.now() ?? Date.now();
export { NOW_MS as nowMs };
const COMPARE_IDS = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export { COMPARE_IDS as compareIds };
export function integer(value, name, min = 0, max = 0xffffffff) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new RangeError(name);
    }
    return value;
}
export function bytes(value, name = 'bytes') {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
export function equalBytes(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
/** 문자열 ID 배열을 원소끼리 비교합니다(JSON 문자열을 만들지 않음). */
export function equalIds(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
/**
 * 호출마다 새 배열을 만들지 않고 bytes를 이어 쓰는 재사용 버퍼입니다.
 * `bytes`는 자랄 때 바뀌므로 보관하지 말고, 쓴 범위는 `view()`(복사 없음)나 `copy()`(보관용)로 읽습니다.
 */
export class ByteBuffer {
    constructor(capacity = 1024) {
        this.bytes = new Uint8Array(integer(capacity, 'capacity', 1, 0x7fffffff));
        this.length = 0;
    }
    reset() {
        this.length = 0;
        return this;
    }
    /** 뒤에 `size` bytes를 쓸 자리를 확보하고 쓰기 시작 위치를 돌려줍니다. 길이는 쓰는 쪽이 늘립니다. */
    reserve(size) {
        const END = this.length + size;
        if (END > this.bytes.length) {
            const NEXT = new Uint8Array(Math.max(END, this.bytes.length * 2));
            NEXT.set(this.bytes.subarray(0, this.length));
            this.bytes = NEXT;
        }
        return this.length;
    }
    write(data) {
        const DATA = bytes(data);
        // reserve가 this.bytes를 바꿀 수 있으므로 먼저 부릅니다.
        const AT = this.reserve(DATA.length);
        this.bytes.set(DATA, AT);
        this.length += DATA.length;
        return this;
    }
    /** 쓴 범위의 보기. 다음 reset·write 전까지만 유효합니다. */
    view() {
        return this.bytes.subarray(0, this.length);
    }
    /** 쓴 범위의 독립 복사본. */
    copy() {
        return this.bytes.slice(0, this.length);
    }
}
/** adapter.saveInto로 `buffer`를 다시 채우고 쓴 범위의 보기를 돌려줍니다(보관하려면 slice). */
export function saveSnapshot(adapter, buffer) {
    adapter.saveInto(buffer.reset());
    return buffer.view();
}
export function hashBytes(value, seed = 2166136261) {
    let h = seed >>> 0;
    const DATA = bytes(value);
    // 인덱스 루프: 이터레이터(for...of)보다 약 20배 빠르며 같은 FNV-1a 값을 냅니다.
    for (let i = 0; i < DATA.length; i++) {
        h = Math.imul(h ^ DATA[i], 16777619) >>> 0;
    }
    return h;
}
export function statelessRandom(seed, eventId) {
    let x = (seed ^ Math.imul(integer(eventId, 'eventId'), 0x9e3779b9)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
}
export class SeededPRNG {
    constructor(seed = 1) {
        this.state = integer(seed, 'seed') >>> 0;
    }
    nextUint32() {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    }
    nextInt(bound) {
        integer(bound, 'bound', 1, 0x100000000);
        const LIMIT = Math.floor(0x100000000 / bound) * bound;
        let x;
        do {
            x = this.nextUint32();
        } while (x >= LIMIT);
        return x % bound;
    }
}
const SIGNED = (x) => integer(x, 'fixed-point result', -2147483648, 2147483647);
const FIXED_POINT = Object.freeze({
    scale: 1024,
    fromNumber: (x) => SIGNED(Math.round(x * 1024)),
    toNumber: (x) => SIGNED(x) / 1024,
    add: (a, b) => SIGNED(SIGNED(a) + SIGNED(b)),
    sub: (a, b) => SIGNED(SIGNED(a) - SIGNED(b)),
    mul: (a, b) => {
        SIGNED(a);
        SIGNED(b);
        const PRODUCT = a * b;
        // Exact integer product: the fast path preserves truncation, including -0.
        if (Number.isSafeInteger(PRODUCT)) {
            return SIGNED(Math.trunc(PRODUCT / 1024) || 0);
        }
        return SIGNED(Number((BigInt(a) * BigInt(b)) / 1024n));
    },
    div: (a, b) => {
        if (SIGNED(b) === 0) {
            throw new RangeError('fixed-point division by zero');
        }
        // |a·1024| ≤ 2^41 < 2^53: 부동소수 나눗셈의 반올림 오차(≤ |q|·2^-53)가 다음 정수까지 거리(≥ 1/|b|)보다 작아
        // Math.trunc가 BigInt 정수 나눗셈(0 쪽 버림)과 같습니다. || 0은 -0을 0으로 맞춥니다(BigInt 결과는 -0이 없음).
        return SIGNED(Math.trunc((SIGNED(a) * 1024) / b) || 0);
    },
});
export { FIXED_POINT as fixedPoint };

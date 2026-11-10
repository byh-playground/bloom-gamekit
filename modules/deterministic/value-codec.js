/**
 * 정수·실수 typed array 태그 10의 종류 표. Uint8Array는 기존 태그 7이라 여기에 없습니다.
 * 요소는 항상 little-endian으로 쓰고 읽어 호스트 endianness와 무관합니다.
 */
const TYPED_KINDS = [
    [Int8Array, 'getInt8', 'setInt8', 1],
    [Int16Array, 'getInt16', 'setInt16', 2],
    [Uint16Array, 'getUint16', 'setUint16', 2],
    [Int32Array, 'getInt32', 'setInt32', 4],
    [Uint32Array, 'getUint32', 'setUint32', 4],
    [Float32Array, 'getFloat32', 'setFloat32', 4],
    [Float64Array, 'getFloat64', 'setFloat64', 8],
];
const FLOAT_KIND_START = 5;
/** encode가 재사용하는 작업 버퍼의 최대 크기. 이보다 크게 자라면 보관하지 않습니다. */
const SCRATCH_LIMIT = 8 * 1024 * 1024;
/** 이 호스트가 little-endian이면 정수 typed array를 요소별 쓰기 없이 bytes로 바로 복사합니다(출력 bytes 동일). */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function typedKindOf(value) {
    // 일반 객체·배열은 instanceof 연쇄 전에 거릅니다.
    if (!ArrayBuffer.isView(value)) {
        return -1;
    }
    for (let i = 0; i < TYPED_KINDS.length; i++) {
        if (value instanceof TYPED_KINDS[i][0]) {
            return i;
        }
    }
    return -1;
}
/**
 * 메모리 표현을 그대로 쓸 수 있는지 봅니다. 정수는 항상, 실수는 모두 유한하고 -0이 없을 때만(-0은 0으로 써야 함).
 * 유한하지 않은 값은 false를 돌려 요소별 경로가 같은 오류를 내게 합니다.
 */
function bulkTyped(value, kind) {
    if (kind < FLOAT_KIND_START) {
        return true;
    }
    for (let i = 0; i < value.length; i++) {
        const ELEMENT = value[i];
        if (!Number.isFinite(ELEMENT) || (ELEMENT === 0 && 1 / ELEMENT < 0)) {
            return false;
        }
    }
    return true;
}
/** 게임 구조를 가정하지 않는 값 ↔ bytes capability. Core는 이 모듈에 의존하지 않는다. */
export function createValueCodec({
    format = 'binary',
    maxBytes = 16 * 1024 * 1024,
    maxDepth = 128,
    maxEntries = 1000000,
    omitUndefined = false,
} = {}) {
    if (!['binary', 'json'].includes(format)) {
        throw new TypeError('Unknown codec format');
    }
    if (typeof omitUndefined !== 'boolean') {
        throw new TypeError('omitUndefined must be boolean');
    }
    // 키 배열은 하나만 만듭니다. undefined 생략은 제자리에서 줄이고, 이미 정렬돼 있으면 정렬하지 않습니다.
    // 문자열 `<`와 기본 sort는 같은 UTF-16 코드 단위 순서입니다.
    function keysOf(value) {
        const KEYS = Object.keys(value);
        if (omitUndefined) {
            let kept = 0;
            for (let i = 0; i < KEYS.length; i++) {
                if (value[KEYS[i]] !== undefined) {
                    KEYS[kept++] = KEYS[i];
                }
            }
            KEYS.length = kept;
        }
        for (let i = 1; i < KEYS.length; i++) {
            if (!(KEYS[i - 1] < KEYS[i])) {
                return KEYS.sort();
            }
        }
        return KEYS;
    }
    for (const LIMIT of [maxBytes, maxDepth, maxEntries]) {
        if (!Number.isSafeInteger(LIMIT) || LIMIT < 1) {
            throw new RangeError('Invalid codec limit');
        }
    }
    const ENCODER = new TextEncoder(),
        DECODER = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
        });
    function normalize(
        value,
        depth = 0,
        seen = new Set(),
        budget = {
            count: 0,
        },
    ) {
        if (depth > maxDepth || ++budget.count > maxEntries) {
            throw new RangeError('Value codec budget exceeded');
        }
        if (value === null || typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new TypeError('Finite numbers required');
            }
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value === 'string') {
            if (DECODER.decode(ENCODER.encode(value)) !== value) {
                throw new TypeError('Invalid Unicode string');
            }
            return value;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) {
            throw new TypeError('Unsupported or cyclic value');
        }
        seen.add(value);
        let result;
        if (value instanceof Uint8Array || typedKindOf(value) >= 0) {
            if (format === 'json') {
                throw new TypeError('JSON codec does not support byte values');
            }
            result = value;
        } else if (Array.isArray(value)) {
            result = Array.from(value, (item) => normalize(item, depth + 1, seen, budget));
        } else {
            if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
                throw new TypeError('Plain records required');
            }
            result = {};
            for (const KEY of keysOf(value)) {
                normalize(KEY, depth + 1, seen, budget);
                Object.defineProperty(result, KEY, {
                    value: normalize(value[KEY], depth + 1, seen, budget),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        }
        seen.delete(value);
        return result;
    }
    let scratch = null,
        encoding = false;
    const STRING_CACHE = new Map();
    let cachedStringBytes = 0;
    function stringBytes(value) {
        let data = STRING_CACHE.get(value);
        if (data) {
            return data;
        }
        for (let i = 0; i < value.length; i++) {
            const C = value.charCodeAt(i);
            if (C >= 0xd800 && C <= 0xdbff) {
                const NEXT = value.charCodeAt(++i);
                if (!(NEXT >= 0xdc00 && NEXT <= 0xdfff)) {
                    throw new TypeError('Invalid Unicode string');
                }
            } else if (C >= 0xdc00 && C <= 0xdfff) {
                throw new TypeError('Invalid Unicode string');
            }
        }
        data = ENCODER.encode(value);
        if (data.length <= 256 && STRING_CACHE.size < 1024 && cachedStringBytes + data.length <= 131072) {
            STRING_CACHE.set(value, data);
            cachedStringBytes += data.length;
        }
        return data;
    }
    /** 새 복사본을 돌려줍니다. 매번 보관할 bytes가 필요할 때 씁니다. */
    function encode(value) {
        return encodeTo(value, null);
    }
    /** `out`(ByteBuffer) 끝에 이어 쓰고 `out`을 돌려줍니다. 결과 bytes는 encode와 같고 새 배열을 만들지 않습니다. */
    function encodeInto(value, out) {
        if (!out || typeof out.reserve !== 'function') {
            throw new TypeError('encodeInto requires a ByteBuffer');
        }
        if (format === 'json') {
            return out.write(encodeTo(value, null));
        }
        return encodeTo(value, out);
    }
    function encodeTo(value, out) {
        const OUT = out;
        if (format === 'json') {
            const BYTES = ENCODER.encode(JSON.stringify(normalize(value)));
            if (BYTES.length > maxBytes) {
                throw new RangeError('Codec byte budget exceeded');
            }
            return BYTES;
        }
        // 호출마다 확장·복사하지 않도록 직전 작업 버퍼를 재사용합니다(encode 반환값은 항상 새 복사본).
        // 값의 getter가 encode를 다시 부르면(재진입) 공유 버퍼를 건드리지 않고 새 버퍼를 씁니다.
        // OUT이 있으면 그 버퍼 끝에 바로 씁니다. 예산(maxBytes)은 이번 값의 길이에만 적용합니다.
        const NESTED = OUT ? true : encoding;
        if (!OUT) {
            encoding = true;
        }
        let bytes = OUT ? OUT.bytes : !NESTED && scratch ? scratch : new Uint8Array(Math.min(1024, maxBytes));
        const START = OUT ? OUT.length : 0;
        let offset = START;
        let view = new DataView(bytes.buffer);
        let entries = 0;
        const SEEN = new Set(),
            STRINGS = new Map();
        function reserve(size) {
            if (offset - START + size > maxBytes) {
                throw new RangeError('Codec byte budget exceeded');
            }
            if (offset + size > bytes.length) {
                const GROWN = Math.max(offset + size, bytes.length * 2);
                const NEXT = new Uint8Array(OUT ? GROWN : Math.min(maxBytes, GROWN));
                NEXT.set(bytes);
                bytes = NEXT;
                view = new DataView(bytes.buffer);
            }
        }
        function byte(n) {
            reserve(1);
            bytes[offset++] = n;
        }
        function length(n) {
            reserve(4);
            view.setUint32(offset, n, true);
            offset += 4;
        }
        function raw(data) {
            length(data.length);
            reserve(data.length);
            bytes.set(data, offset);
            offset += data.length;
        }
        function variable(n) {
            while (n >= 128) {
                byte((n % 128) + 128);
                n = Math.floor(n / 128);
            }
            byte(n);
        }
        function write(v, depth = 0) {
            if (depth > maxDepth || ++entries > maxEntries) {
                throw new RangeError('Value codec budget exceeded');
            }
            if (v === null) {
                byte(0);
            } else if (v === false) {
                byte(1);
            } else if (v === true) {
                byte(2);
            } else if (typeof v === 'number') {
                if (!Number.isFinite(v)) {
                    throw new TypeError('Finite numbers required');
                }
                if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
                    byte(8);
                    variable(v < 0 ? -v * 2 - 1 : v * 2);
                } else {
                    byte(3);
                    reserve(8);
                    view.setFloat64(offset, v, true);
                    offset += 8;
                }
            } else if (typeof v === 'string') {
                const REF = STRINGS.get(v);
                if (REF !== undefined) {
                    byte(9);
                    variable(REF);
                } else {
                    STRINGS.set(v, STRINGS.size);
                    byte(4);
                    raw(stringBytes(v));
                }
            } else {
                if (!v || typeof v !== 'object' || SEEN.has(v)) {
                    throw new TypeError('Unsupported or cyclic value');
                }
                if (v instanceof Uint8Array) {
                    byte(7);
                    raw(v);
                    return;
                }
                const KIND = typedKindOf(v);
                if (KIND >= 0) {
                    const [, , SET, SIZE] = TYPED_KINDS[KIND];
                    byte(10);
                    byte(KIND);
                    length(v.length);
                    reserve(v.length * SIZE);
                    if (LITTLE_ENDIAN && bulkTyped(v, KIND)) {
                        bytes.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offset);
                        offset += v.byteLength;
                        return;
                    }
                    for (let i = 0; i < v.length; i++) {
                        let element = v[i];
                        if (KIND >= FLOAT_KIND_START) {
                            if (!Number.isFinite(element)) {
                                throw new TypeError('Finite numbers required');
                            }
                            if (element === 0) {
                                element = 0; // -0은 정규 표현이 아니므로 0으로 쓴다
                            }
                        }
                        view[SET](offset, element, true);
                        offset += SIZE;
                    }
                    return;
                }
                SEEN.add(v);
                if (Array.isArray(v)) {
                    byte(5);
                    length(v.length);
                    for (const ITEM of v) {
                        write(ITEM, depth + 1);
                    }
                } else {
                    const PROTOTYPE = Object.getPrototypeOf(v);
                    if (PROTOTYPE !== Object.prototype && PROTOTYPE !== null) {
                        throw new TypeError('Plain records required');
                    }
                    byte(6);
                    const KEYS = keysOf(v);
                    length(KEYS.length);
                    for (const KEY of KEYS) {
                        write(KEY, depth + 1);
                        write(v[KEY], depth + 1);
                    }
                }
                SEEN.delete(v);
            }
        }
        try {
            byte(82);
            byte(86);
            byte(1);
            write(value);
            if (OUT) {
                OUT.bytes = bytes;
                OUT.length = offset;
                return OUT;
            }
            return bytes.slice(0, offset);
        } finally {
            if (!OUT && !NESTED) {
                scratch = bytes.length <= SCRATCH_LIMIT ? bytes : null;
                encoding = false;
            }
        }
    }
    function decode(input) {
        const BYTES =
            input instanceof Uint8Array
                ? input
                : input instanceof ArrayBuffer
                  ? new Uint8Array(input)
                  : ArrayBuffer.isView(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : null;
        if (!BYTES || BYTES.length > maxBytes) {
            throw new RangeError('Invalid codec bytes');
        }
        let result;
        if (format === 'json') {
            result = normalize(JSON.parse(DECODER.decode(BYTES)));
        } else {
            let offset = 0;
            let entries = 0;
            const STRINGS = [],
                STRING_SET = new Set();
            const VIEW = new DataView(BYTES.buffer, BYTES.byteOffset, BYTES.byteLength);
            function need(n) {
                if (n > BYTES.length - offset) {
                    throw new RangeError('Truncated codec bytes');
                }
            }
            function byte() {
                need(1);
                return BYTES[offset++];
            }
            function length() {
                need(4);
                const N = VIEW.getUint32(offset, true);
                offset += 4;
                return N;
            }
            function raw() {
                const N = length();
                need(N);
                const DATA = BYTES.subarray(offset, offset + N);
                offset += N;
                return DATA;
            }
            function read(depth = 0) {
                if (depth > maxDepth || ++entries > maxEntries) {
                    throw new RangeError('Value codec budget exceeded');
                }
                const TAG = byte();
                if (TAG === 0) {
                    return null;
                }
                if (TAG === 1) {
                    return false;
                }
                if (TAG === 2) {
                    return true;
                }
                if (TAG === 3) {
                    need(8);
                    const N = VIEW.getFloat64(offset, true);
                    offset += 8;
                    if (
                        !Number.isFinite(N) ||
                        Object.is(N, -0) ||
                        (Number.isInteger(N) && N >= -2147483648 && N <= 2147483647)
                    ) {
                        throw new TypeError('Noncanonical number');
                    }
                    return N;
                }
                if (TAG === 8 || TAG === 9) {
                    let n = 0;
                    let scale = 1;
                    let part;
                    for (let i = 0; i < 5; i++) {
                        part = byte();
                        n += (part & 127) * scale;
                        if (n > 4294967295) {
                            throw new TypeError('Integer overflow');
                        }
                        if (part < 128) {
                            if (i && part === 0) {
                                throw new TypeError('Noncanonical integer');
                            }
                            if (TAG === 9) {
                                if (n >= STRINGS.length) {
                                    throw new TypeError('Invalid string reference');
                                }
                                return STRINGS[n];
                            }
                            return n % 2 ? -(n + 1) / 2 : n / 2;
                        }
                        scale *= 128;
                    }
                    throw new TypeError('Invalid integer');
                }
                if (TAG === 4) {
                    const VALUE = DECODER.decode(raw());
                    if (STRING_SET.has(VALUE)) {
                        throw new TypeError('Noncanonical repeated string');
                    }
                    STRING_SET.add(VALUE);
                    STRINGS.push(VALUE);
                    return VALUE;
                }
                if (TAG === 7) {
                    return raw().slice();
                }
                if (TAG === 10) {
                    const KIND = byte();
                    if (KIND >= TYPED_KINDS.length) {
                        throw new TypeError('Invalid typed array kind');
                    }
                    const [TYPE, GET, , SIZE] = TYPED_KINDS[KIND];
                    const COUNT = length();
                    need(COUNT * SIZE);
                    if (LITTLE_ENDIAN) {
                        // 정렬과 무관하게 새 buffer로 복사한 뒤 값만 검사합니다(요소별 DataView 읽기와 같은 값).
                        const START = BYTES.byteOffset + offset;
                        const ARRAY = new TYPE(BYTES.buffer.slice(START, START + COUNT * SIZE));
                        if (KIND >= FLOAT_KIND_START) {
                            for (let i = 0; i < COUNT; i++) {
                                const ELEMENT = ARRAY[i];
                                if (!Number.isFinite(ELEMENT) || (ELEMENT === 0 && 1 / ELEMENT < 0)) {
                                    throw new TypeError('Noncanonical typed array number');
                                }
                            }
                        }
                        offset += COUNT * SIZE;
                        return ARRAY;
                    }
                    const ARRAY = new TYPE(COUNT);
                    for (let i = 0; i < COUNT; i++) {
                        const ELEMENT = VIEW[GET](offset, true);
                        if (KIND >= FLOAT_KIND_START && (!Number.isFinite(ELEMENT) || Object.is(ELEMENT, -0))) {
                            throw new TypeError('Noncanonical typed array number');
                        }
                        ARRAY[i] = ELEMENT;
                        offset += SIZE;
                    }
                    return ARRAY;
                }
                if (TAG !== 5 && TAG !== 6) {
                    throw new TypeError('Invalid codec tag');
                }
                const N = length();
                if (N > maxEntries - entries) {
                    throw new RangeError('Value codec budget exceeded');
                }
                if (TAG === 5) {
                    const ARR = [];
                    for (let i = 0; i < N; i++) {
                        ARR.push(read(depth + 1));
                    }
                    return ARR;
                }
                const OBJ = {};
                let previous;
                for (let i = 0; i < N; i++) {
                    const KEY = read(depth + 1);
                    if (typeof KEY !== 'string' || (i && KEY <= previous)) {
                        throw new TypeError('Noncanonical record key');
                    }
                    if (KEY === '__proto__') {
                        Object.defineProperty(OBJ, KEY, {
                            value: read(depth + 1),
                            enumerable: true,
                            writable: true,
                            configurable: true,
                        });
                    } else {
                        OBJ[KEY] = read(depth + 1);
                    }
                    previous = KEY;
                }
                return OBJ;
            }
            if (byte() !== 82 || byte() !== 86 || byte() !== 1) {
                throw new TypeError('Invalid codec header');
            }
            result = read();
            if (offset !== BYTES.length) {
                throw new TypeError('Trailing codec bytes');
            }
        }
        if (format === 'json') {
            const CANONICAL = encode(result);
            if (CANONICAL.length !== BYTES.length || CANONICAL.some((v, i) => v !== BYTES[i])) {
                throw new TypeError('Noncanonical codec bytes');
            }
        }
        return result;
    }
    return Object.freeze({
        format,
        encode,
        encodeInto,
        decode,
    });
}
const BINARY_CODEC = createValueCodec();
export { BINARY_CODEC as binaryCodec };
const JSON_CODEC = createValueCodec({
    format: 'json',
});
export { JSON_CODEC as jsonCodec };

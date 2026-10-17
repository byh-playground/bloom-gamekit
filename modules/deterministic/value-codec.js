/** 게임 구조를 가정하지 않는 값 ↔ bytes capability. Core는 이 모듈에 의존하지 않는다. */
export function createValueCodec({
    format = 'binary',
    maxBytes = 16 * 1024 * 1024,
    maxDepth = 128,
    maxEntries = 1000000,
} = {}) {
    if (!['binary', 'json'].includes(format)) {
        throw new TypeError('Unknown codec format');
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
        if (value instanceof Uint8Array) {
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
            for (const KEY of Object.keys(value).sort()) {
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
    function encode(value) {
        if (format === 'json') {
            const BYTES = ENCODER.encode(JSON.stringify(normalize(value)));
            if (BYTES.length > maxBytes) {
                throw new RangeError('Codec byte budget exceeded');
            }
            return BYTES;
        }
        let bytes = new Uint8Array(Math.min(1024, maxBytes));
        let offset = 0;
        let view = new DataView(bytes.buffer);
        let entries = 0;
        const SEEN = new Set(),
            STRINGS = new Map();
        function reserve(size) {
            if (offset + size > maxBytes) {
                throw new RangeError('Codec byte budget exceeded');
            }
            if (offset + size > bytes.length) {
                const NEXT = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes.length * 2)));
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
                    const KEYS = Object.keys(v).sort();
                    length(KEYS.length);
                    for (const KEY of KEYS) {
                        write(KEY, depth + 1);
                        write(v[KEY], depth + 1);
                    }
                }
                SEEN.delete(v);
            }
        }
        byte(82);
        byte(86);
        byte(1);
        write(value);
        return bytes.slice(0, offset);
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
        decode,
    });
}
const BINARY_CODEC = createValueCodec();
export { BINARY_CODEC as binaryCodec };
const JSON_CODEC = createValueCodec({
    format: 'json',
});
export { JSON_CODEC as jsonCodec };

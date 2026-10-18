// 값 코덱의 typed array 태그와 omitUndefined 옵션: 왕복, 정규성(canonical), 거부 규칙, 기존 payload 호환.
import assert from 'node:assert/strict';
import { createValueCodec, binaryCodec, jsonCodec } from '../../../dist/deterministic.js';

const CODEC = createValueCodec({ maxBytes: 64 << 20 });
const SAMPLES = [
    new Int8Array([-128, 0, 127]),
    new Int16Array([-32768, 0, 32767]),
    new Uint16Array([0, 65535]),
    new Int32Array([-2147483648, 0, 2147483647]),
    new Uint32Array([0, 4294967295]),
    new Float32Array([1.5, -2.25, 3.4028234663852886e38]),
    new Float64Array([Math.PI, -1e-300, Number.MAX_VALUE]),
];
for (const SAMPLE of SAMPLES) {
    const DECODED = CODEC.decode(CODEC.encode({ a: SAMPLE }));
    assert.ok(DECODED.a instanceof SAMPLE.constructor, SAMPLE.constructor.name);
    assert.deepEqual([...DECODED.a], [...SAMPLE]);
}
// 비어 있는 배열, 중첩, 같은 입력은 같은 바이트
assert.equal(CODEC.decode(CODEC.encode(new Int32Array(0))).length, 0);
const A = CODEC.encode([new Float64Array([1.25, 2.5]), { z: new Int16Array([7]) }]);
assert.deepEqual(CODEC.encode([new Float64Array([1.25, 2.5]), { z: new Int16Array([7]) }]), A);
// subarray는 보이는 범위만 인코딩
assert.deepEqual([...CODEC.decode(CODEC.encode(new Int32Array([1, 2, 3, 4]).subarray(1, 3)))], [2, 3]);
// 정규성: -0은 0으로, 비유한 값은 인코딩 거부
const NEG_ZERO = CODEC.decode(CODEC.encode(new Float64Array([-0])));
assert.ok(Object.is(NEG_ZERO[0], 0));
for (const BAD of [NaN, Infinity, -Infinity]) {
    assert.throws(() => CODEC.encode(new Float32Array([BAD])), TypeError);
    assert.throws(() => CODEC.encode(new Float64Array([1, BAD])), TypeError);
}
// 디코더는 비정규 바이트를 거부: 직접 만든 -0 / NaN payload
const ENCODED = CODEC.encode(new Float64Array([1]));
const FLOAT_OFFSET = ENCODED.length - 8;
const NEG = ENCODED.slice();
new DataView(NEG.buffer).setFloat64(FLOAT_OFFSET, -0, true);
assert.throws(() => CODEC.decode(NEG), /Noncanonical/);
const NAN = ENCODED.slice();
new DataView(NAN.buffer).setFloat64(FLOAT_OFFSET, NaN, true);
assert.throws(() => CODEC.decode(NAN), TypeError);
// 잘린 payload와 알 수 없는 종류
assert.throws(() => CODEC.decode(ENCODED.subarray(0, ENCODED.length - 1)), RangeError);
const KIND = ENCODED.slice();
KIND[4] = 99; // 헤더 3바이트 + 태그 1바이트 뒤가 kind
assert.throws(() => CODEC.decode(KIND), /Invalid typed array kind/);
// 요소 수가 남은 바이트보다 크면 할당 전에 거부
const HUGE = ENCODED.slice();
new DataView(HUGE.buffer).setUint32(5, 0xffffffff, true);
assert.throws(() => CODEC.decode(HUGE), RangeError);
// 기존 형식 payload는 그대로 읽힙니다(Uint8Array 태그 7, 숫자, 문자열).
const LEGACY = binaryCodec.encode({ b: new Uint8Array([1, 2, 3]), n: 5, s: 'x' });
assert.deepEqual(binaryCodec.decode(LEGACY).b, new Uint8Array([1, 2, 3]));
// JSON 형식은 typed array를 계속 거부
assert.throws(() => jsonCodec.encode({ a: new Int32Array(1) }), TypeError);
// omitUndefined: 기본은 거부, 옵션이면 키를 건너뜀(배열 항목은 여전히 거부)
assert.throws(() => binaryCodec.encode({ a: undefined }), TypeError);
const OMIT = createValueCodec({ omitUndefined: true });
assert.deepEqual(OMIT.decode(OMIT.encode({ a: undefined, b: 1, c: { d: undefined } })), { b: 1, c: {} });
assert.deepEqual(OMIT.encode({ a: undefined, b: 1 }), OMIT.encode({ b: 1 }));
assert.throws(() => OMIT.encode([undefined]), TypeError);
assert.throws(() => createValueCodec({ omitUndefined: 1 }), TypeError);
// 작업 버퍼 재사용: 반복 호출·재진입(getter 안의 encode)에서도 결과 바이트가 독립적이고 변하지 않습니다.
{
    const FIRST = CODEC.encode({ a: new Uint8Array(5000).fill(7), b: 'x' });
    const SECOND = CODEC.encode({ a: 1 });
    assert.deepEqual(
        CODEC.encode({ a: new Uint8Array(5000).fill(7), b: 'x' }),
        FIRST,
        '이전 호출의 잔여 바이트가 섞였습니다.',
    );
    assert.notEqual(FIRST.buffer, SECOND.buffer);
    const INNER = { v: 1 };
    const NESTED = {
        a: 1,
        get b() {
            return [...CODEC.encode(INNER)].length;
        },
    };
    const EXPECTED = CODEC.encode({ a: 1, b: CODEC.encode(INNER).length });
    assert.deepEqual(CODEC.encode(NESTED), EXPECTED);
    assert.deepEqual(CODEC.encode({ a: 1 }), SECOND);
}
// 큰 격자 상태: 복사 한 번에 가깝고 항목 수를 늘리지 않음
const BIG = new Int32Array(1 << 20).map((_, i) => i);
const STARTED = performance.now();
const ROUND = CODEC.decode(CODEC.encode(BIG));
assert.equal(ROUND[ROUND.length - 1], BIG[BIG.length - 1]);
assert.ok(performance.now() - STARTED < 500, '1M 요소 왕복이 500ms를 넘었습니다.');
console.log('value-codec-typed ok');

// hashBytes는 FNV-1a 32비트입니다. 구현을 바꿔도 체크섬이 달라지지 않는지 공개 시험 벡터로 고정합니다.
import assert from 'node:assert/strict';
import { hashBytes } from '../../../dist/deterministic.js';

const TEXT = (value) => new TextEncoder().encode(value);
assert.equal(hashBytes(new Uint8Array(0)), 0x811c9dc5);
assert.equal(hashBytes(TEXT('a')), 0xe40c292c);
assert.equal(hashBytes(TEXT('foobar')), 0xbf9cf968);
// seed 이어 붙이기: 나눠서 해시해도 한 번에 해시한 것과 같아야 합니다.
const WHOLE = TEXT('foobar');
assert.equal(hashBytes(WHOLE.subarray(3), hashBytes(WHOLE.subarray(0, 3))), hashBytes(WHOLE));
// ArrayBuffer와 DataView 입력도 같은 바이트를 해시합니다.
assert.equal(hashBytes(WHOLE.buffer), hashBytes(WHOLE));
assert.equal(hashBytes(new DataView(WHOLE.buffer)), hashBytes(WHOLE));
// 큰 입력은 이터레이터 방식에 비해 충분히 빨라야 합니다(회귀 감지용 여유 한도).
const BIG = new Uint8Array(1 << 20).map((_, i) => i * 31);
const START = performance.now();
hashBytes(BIG);
assert.ok(performance.now() - START < 50, '1MiB 해시가 50ms를 넘었습니다.');
console.log('hash-bytes ok');

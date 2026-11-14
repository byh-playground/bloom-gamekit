// hashBytes는 FNV-1a 32비트입니다. 구현을 바꿔도 체크섬이 달라지지 않는지 공개 시험 벡터로 고정합니다.
// 아래쪽은 같은 결정론 유틸인 tickTime의 고정 사례입니다.
import assert from 'node:assert/strict';
import { hashBytes, tickTime } from '../../../dist/deterministic.js';

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

// tickTime: ms 시간 값을 틱 수와 무관하게 같은 실제 시간으로 반영하는지(DEV-035).
const T20 = tickTime({ tickRate: 20 });
let acc = 0;
let runs = 0;
const RUN = () => runs++;
for (let tick = 0; tick < 1000; tick++) {
    acc = T20.every(acc, 66, RUN);
    // 주기 누적값은 나머지만 남아 [0, 66 × 20)을 벗어나지 않습니다.
    assert.ok(acc >= 0 && acc < 66 * 20);
}
assert.ok(Math.abs(runs - 50000 / 66) <= 1, `20Hz 66ms 1000틱 실행 ${runs}회`);
// 실행 틱이 흩어집니다(1틱부터 2, 3, 4, 6번째 틱에 실행).
acc = 0;
const RUN_TICKS = [];
for (let tick = 1; tick <= 6; tick++) {
    acc = T20.every(acc, 66, (at) => RUN_TICKS.push(at), tick);
}
assert.deepEqual(RUN_TICKS, [2, 3, 4, 6]);
// 주기 < 한 틱: every는 들어간 횟수만큼, everyOnce는 한 번, fires는 횟수만.
assert.equal(T20.fires(0, 20), 2);
let many = 0;
let once = 0;
assert.equal(
    T20.every(0, 20, () => many++),
    T20.everyOnce(0, 20, () => once++),
);
assert.deepEqual([many, once], [2, 1]);
// 지속: 60·30·20Hz에서 250ms가 [250ms, 250ms + 한 틱) 안에 끝납니다.
for (const RATE of [60, 30, 20]) {
    const T = tickTime({ tickRate: RATE });
    let left = T.start(250);
    let ticks = 0;
    let ended = 0;
    while (!T.done(left)) {
        const BEFORE = left;
        left = T.advance(left, () => ended++);
        ticks++;
        assert.ok(left >= 0 && left < BEFORE);
    }
    const MS = T.tickToMs(ticks);
    assert.ok(MS >= 250 && MS < 250 + T.stepMs, `${RATE}Hz 250ms가 ${MS}ms에 끝남`);
    assert.equal(ended, 1);
    assert.equal(
        T.advance(left, () => ended++),
        0,
    );
    assert.equal(ended, 1);
    assert.equal(T.ceilTicks(250), ticks);
}
assert.equal(T20.remainingMs(T20.start(250)), 250);
assert.equal(T20.elapsedMs(T20.advance(T20.start(250)), 250), 50);
assert.equal(tickTime({ tickRate: 60 }).ceilTicks(400), 24);
assert.equal(T20.ceilTicks(0), 0);
// 잘못된 인자
for (const BAD of [0, -1, 1.5, NaN, '20', undefined]) {
    assert.throws(() => tickTime({ tickRate: BAD }), RangeError);
}
for (const BAD of [0, -66, 66.5, NaN, '66']) {
    assert.throws(() => T20.every(0, BAD), RangeError);
}
assert.throws(() => T20.every(-1, 66), RangeError);
assert.throws(() => T20.start(-1), RangeError);
assert.throws(() => T20.advance(0.5), RangeError);
assert.throws(() => T20.start(Number.MAX_SAFE_INTEGER), RangeError);
console.log('tick-time ok');

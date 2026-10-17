// 최적화 채택 전 정확한 BigInt 기준과 안전 범위의 후보를 비교한다.
import { performance } from 'node:perf_hooks';
import { fixedPoint } from '../../../dist/deterministic.js';
import { nostrCrypto } from '../../../dist/transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const RESULTS_DIRECTORY = fileURLToPath(new URL('../../../test-results/rollback/', import.meta.url));
const ITERATIONS = 100000,
    RESULTS = [];
const SIGNED = (value) => {
    if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
        throw new RangeError('fixed-point result');
    }
    return value;
};
for (const [NAME, OPERATION] of [
    ['bigint-reference', (a, b) => SIGNED(Number((BigInt(SIGNED(a)) * BigInt(SIGNED(b))) / 1024n))],
    ['current', fixedPoint.mul],
    [
        'safe-product-candidate',
        (a, b) => {
            const PRODUCT = a * b;
            assert.ok(Number.isSafeInteger(PRODUCT));
            return Math.trunc(PRODUCT / 1024);
        },
    ],
]) {
    let checksum = 0;
    const START = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        checksum = (checksum + OPERATION((i % 20001) - 10000, 12345)) | 0;
    }
    RESULTS.push({
        name: NAME,
        iterations: ITERATIONS,
        ms: performance.now() - START,
        checksum,
    });
}
assert.equal(RESULTS[0].checksum, RESULTS[1].checksum);
assert.equal(RESULTS[0].checksum, RESULTS[2].checksum);
const SECRET = new Uint8Array(32);
SECRET[31] = 3;
const MESSAGE = new Uint8Array(32),
    AUXILIARY = new Uint8Array(32),
    KEY = nostrCrypto.publicKey(SECRET);
const SIGNATURE = await nostrCrypto.sign(MESSAGE, SECRET, AUXILIARY),
    COSTS = [];
for (let i = 0; i < 32; i++) {
    const START = performance.now();
    assert.equal(await nostrCrypto.verify(SIGNATURE, MESSAGE, KEY), true);
    COSTS.push(performance.now() - START);
}
COSTS.sort((a, b) => a - b);
const CRYPTO = {
    samples: 32,
    p50Ms: COSTS[16],
    p95Ms: COSTS[30],
    maxMs: COSTS.at(-1),
};
fs.mkdirSync(RESULTS_DIRECTORY, {
    recursive: true,
});
fs.writeFileSync(
    resolve(RESULTS_DIRECTORY, 'primitives-benchmark.json'),
    JSON.stringify(
        {
            fixedPoint: RESULTS,
            nostrVerification: CRYPTO,
        },
        null,
        2,
    ),
);
console.log(
    JSON.stringify(
        {
            fixedPoint: RESULTS,
            nostrVerification: CRYPTO,
        },
        null,
        2,
    ),
);

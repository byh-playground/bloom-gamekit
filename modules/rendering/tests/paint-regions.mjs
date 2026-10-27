import assert from 'node:assert/strict';
import { packPaintRegions } from '../paint-regions.js';

const OUTPUT = new Float32Array(8);
const SPARSE = [new Array(3)];
for (let index = 0; index < 3; index++) {
    const RGB = [0, 0.5, 1];
    delete RGB[index];
    SPARSE.push(RGB);
}
for (const RGB of SPARSE) {
    assert.throws(() => packPaintRegions(['cheeks'], { cheeks: RGB }, OUTPUT), RangeError);
    assert.ok(OUTPUT.every(Number.isFinite), 'Rejected sparse RGB must not write NaN channels');
}
for (const CHANNEL of [undefined, null, NaN, Infinity, -Infinity, -0.01, 1.01, '0.5']) {
    for (let index = 0; index < 3; index++) {
        const RGB = [0, 0.5, 1];
        RGB[index] = CHANNEL;
        assert.throws(() => packPaintRegions(['cheeks'], { cheeks: RGB }, OUTPUT), RangeError);
    }
}
for (const RGB of [[0, 0.5, 1], new Float32Array([0, 0.5, 1])]) {
    assert.equal(packPaintRegions(['cheeks'], { cheeks: RGB }, OUTPUT), OUTPUT);
    assert.deepEqual([...OUTPUT], [0, 0, 0, 0, 0, 0.5, 1, 1]);
}
console.log('paint-regions RGB validation ok');

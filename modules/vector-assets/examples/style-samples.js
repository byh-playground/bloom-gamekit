import { createVectorAsset } from '../index.js';
import { styleSamples } from './styles.compiled.js';
export { styleSamples };

/** Creates one of the SVG-authored yarn/sketch comparison assets. */
export function createStyleSample(id, meshRenderer) {
    const SAMPLE = styleSamples[id];
    if (!SAMPLE) {
        throw new TypeError('Unknown vector style sample: ' + id);
    }
    return createVectorAsset(meshRenderer, SAMPLE.asset);
}

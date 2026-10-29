import { createVectorActor } from '../index.js';
import { styleSamples } from './styles.compiled.js';
export { styleSamples };

/** Creates an actor of one of the SVG-authored yarn/sketch comparison assets. */
export function createStyleSample(id, context, options) {
    const SAMPLE = styleSamples[id];
    if (!SAMPLE) {
        throw new TypeError('Unknown vector style sample: ' + id);
    }
    return createVectorActor(context, SAMPLE.asset, options);
}

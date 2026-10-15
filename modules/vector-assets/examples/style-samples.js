import { createVectorAsset } from '../index.js';
import { styleSamples } from './styles.compiled.js';

export { styleSamples };

/** Creates one of the SVG-authored yarn/sketch comparison assets. */
export function createStyleSample(id, meshRenderer) {
  const sample = styleSamples[id];
  if (!sample) throw new TypeError('Unknown vector style sample: ' + id);
  return createVectorAsset(meshRenderer, sample.asset);
}

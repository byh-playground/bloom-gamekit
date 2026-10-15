import { seedScout } from './seed-scout.compiled.js';
import { createVectorAsset } from './runtime.js';

export { createVectorAsset };
export const seedScoutMetadata = seedScout.metadata;

/** The bundled reference character compiled from assets/seed-scout.svg. */
export function createSeedScout(meshRenderer) {
  return createVectorAsset(meshRenderer, seedScout);
}

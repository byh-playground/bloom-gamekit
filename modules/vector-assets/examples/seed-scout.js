import { seedScout } from '../seed-scout.compiled.js';
import { createVectorAsset } from '../index.js';

export const seedScoutMetadata = seedScout.metadata;

/** Example-only helper for the bundled Seed Scout SVG. */
export function createSeedScout(meshRenderer) {
  return createVectorAsset(meshRenderer, seedScout);
}

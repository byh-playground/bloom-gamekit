import { seedScout } from '../seed-scout.compiled.js';
import { createVectorAsset } from '../index.js';
const SEED_SCOUT_METADATA = seedScout.metadata;

/** Example-only helper for the bundled Seed Scout SVG. */
export { SEED_SCOUT_METADATA as seedScoutMetadata };
export function createSeedScout(meshRenderer) {
    return createVectorAsset(meshRenderer, seedScout);
}

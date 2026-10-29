import { seedScout } from '../seed-scout.compiled.js';
import { createVectorActor } from '../index.js';
const SEED_SCOUT_METADATA = seedScout.metadata;

/** Example-only helper for the bundled Seed Scout SVG. */
export { SEED_SCOUT_METADATA as seedScoutMetadata };
export function createSeedScout(context, options) {
    return createVectorActor(context, seedScout, options);
}

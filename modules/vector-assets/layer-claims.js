const CLAIMS = new WeakMap();
let nextArrayId = 1;
const IDS = new WeakMap();

/** Stable small integer per texture array handle; lets cache keys name an array without holding it. */
export function textureArrayId(textureArray) {
    let id = IDS.get(textureArray);
    if (id === undefined) {
        id = nextArrayId++;
        IDS.set(textureArray, id);
    }
    return id;
}

/**
 * One baked atlas owns one whole array layer: baking clears the layer, so two owners would erase each other.
 * Returns a release function; throws when the layer already has an owner.
 */
export function claimTextureLayer(textureArray, layer) {
    let layers = CLAIMS.get(textureArray);
    if (!layers) {
        layers = new Set();
        CLAIMS.set(textureArray, layers);
    }
    if (layers.has(layer)) {
        throw new RangeError(`Texture array layer ${layer} already belongs to another atlas`);
    }
    layers.add(layer);
    let released = false;
    return () => {
        if (!released) {
            released = true;
            layers.delete(layer);
        }
    };
}

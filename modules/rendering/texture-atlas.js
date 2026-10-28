/**
 * Packs many small images into the layers of one TEXTURE_2D_ARRAY, so every textured draw samples the same
 * sampler and never breaks a batch on texture identity. Each allocation reserves a `gutter` ring around its
 * content: a byte source can replicate its edge pixels into it (gradient ramps clamp, glyph pages stay clear),
 * and a DOM source leaves it transparent. Released rectangles are cleared on the GPU and reused for the same size.
 */
export class TextureAtlasArray {
    constructor(device, { width = 2048, height = 1024, layers = 2, gutter = 1, filter = 'linear' } = {}) {
        if (!device?.createTextureArray || !device.updateTextureRegion) {
            throw new TypeError('A WebGLDevice with texture arrays is required');
        }
        if (!Number.isSafeInteger(gutter) || gutter < 0) {
            throw new RangeError('gutter must be a non-negative integer');
        }
        this.device = device;
        this.gutter = gutter;
        this.width = width;
        this.height = height;
        this.texture = device.createTextureArray(width, height, layers, { filter });
        this.layerShelves = Array.from({ length: layers }, () => ({ shelves: [], usedHeight: 0 }));
        this.free = new Map();
        this.regions = new Set();
        // Regions whose pixels may already be sampled by queued draws.
        this.written = new WeakSet();
        this.disposed = false;
    }
    /** Reserves width x height content pixels. Returns the content rectangle, its normalized `uvRect` and its sampling `filter`
     * (`nearest` snaps the lookup to texel centers in the shader, since the array has one hardware filter). */
    allocate(width, height, { filter = 'linear' } = {}) {
        this._live();
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new TypeError('filter must be nearest or linear');
        }
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
            throw new RangeError('Region size must be positive integers');
        }
        const G = this.gutter,
            PW = width + G * 2,
            PH = height + G * 2,
            KEY = `${PW}x${PH}`,
            REUSED = this.free.get(KEY)?.pop();
        if (REUSED) {
            return this._region(REUSED.layer, REUSED.x, REUSED.y, width, height, filter);
        }
        for (let layer = 0; layer < this.layerShelves.length; layer++) {
            const STATE = this.layerShelves[layer];
            for (const SHELF of STATE.shelves) {
                if (SHELF.height >= PH && SHELF.x + PW <= this.width) {
                    const X = SHELF.x;
                    SHELF.x += PW;
                    return this._region(layer, X, SHELF.y, width, height, filter);
                }
            }
            if (PW <= this.width && STATE.usedHeight + PH <= this.height) {
                const SHELF = { y: STATE.usedHeight, height: PH, x: PW };
                STATE.shelves.push(SHELF);
                STATE.usedHeight += PH;
                return this._region(layer, 0, SHELF.y, width, height, filter);
            }
        }
        throw new RangeError('Texture atlas array is full');
    }
    _region(layer, paddedX, paddedY, width, height, filter) {
        const G = this.gutter,
            REGION = Object.freeze({
                layer,
                x: paddedX + G,
                y: paddedY + G,
                width,
                height,
                filter,
                atlas: this,
                paddedX,
                paddedY,
                uvRect: Object.freeze([
                    (paddedX + G) / this.width,
                    (paddedY + G) / this.height,
                    width / this.width,
                    height / this.height,
                ]),
            });
        this.regions.add(REGION);
        return REGION;
    }
    /**
     * Writes the region's pixels. `source` is a DOM image/canvas or `{ width, height, data }` RGBA bytes. A source
     * of the region size fills it; a smaller source at content offset `x`, `y` updates only that rectangle.
     * With `extendEdges`, a whole-region byte source also fills the gutter with its edge pixels (clamp-to-edge look).
     */
    upload(region, source, { premultiplied = false, extendEdges = false, x = 0, y = 0 } = {}) {
        this._live();
        if (!this.regions.has(region)) {
            throw new TypeError('A live region from this atlas is required');
        }
        // Draws queued against the old pixels are submitted first, so painter order sees each version.
        // A region's first upload needs no flush: nothing can have sampled it yet.
        if (this.written.has(region) && this.device.active) {
            this.device.flushBatchers('atlasRegionUpdate');
        }
        this.written.add(region);
        const G = this.gutter,
            WIDTH = source?.naturalWidth ?? source?.width,
            HEIGHT = source?.naturalHeight ?? source?.height;
        if (x !== 0 || y !== 0 || WIDTH !== region.width || HEIGHT !== region.height) {
            if (extendEdges) {
                throw new TypeError('extendEdges requires a whole-region upload');
            }
            if (
                !Number.isSafeInteger(x) ||
                !Number.isSafeInteger(y) ||
                x < 0 ||
                y < 0 ||
                !(x + WIDTH <= region.width) ||
                !(y + HEIGHT <= region.height)
            ) {
                throw new RangeError('Upload rectangle must lie inside the region');
            }
            this.device.updateTextureRegion(this.texture, region.layer, region.x + x, region.y + y, source, {
                premultiplied,
            });
            return;
        }
        if (source.data === undefined) {
            if (extendEdges) {
                throw new TypeError('extendEdges requires RGBA byte data');
            }
            this.device.updateTextureRegion(this.texture, region.layer, region.x, region.y, source, { premultiplied });
            return;
        }
        if (!G) {
            this.device.updateTextureRegion(this.texture, region.layer, region.x, region.y, source, { premultiplied });
            return;
        }
        const PW = region.width + G * 2,
            PH = region.height + G * 2,
            PADDED = new Uint8Array(PW * PH * 4);
        for (let y = 0; y < PH; y++) {
            for (let x = 0; x < PW; x++) {
                const SX = x - G,
                    SY = y - G;
                const INSIDE = SX >= 0 && SY >= 0 && SX < region.width && SY < region.height;
                if (!INSIDE && !extendEdges) {
                    continue;
                }
                const FROM =
                    (Math.min(region.height - 1, Math.max(0, SY)) * region.width +
                        Math.min(region.width - 1, Math.max(0, SX))) *
                    4;
                PADDED.set(source.data.subarray(FROM, FROM + 4), (y * PW + x) * 4);
            }
        }
        this.device.updateTextureRegion(
            this.texture,
            region.layer,
            region.paddedX,
            region.paddedY,
            { width: PW, height: PH, data: PADDED },
            { premultiplied },
        );
    }
    /**
     * Frees the region. Its pixels are cleared and the rectangle is reused for the next same-size allocation; when
     * the last region goes, the array itself is deleted and the device creates a fresh one on next use.
     */
    release(region) {
        if (this.disposed || !this.regions.delete(region)) {
            return false;
        }
        if (!this.regions.size) {
            this.dispose();
            return true;
        }
        if (this.device.active) {
            this.device.flushBatchers('atlasRegionRelease');
        }
        const G = this.gutter,
            PW = region.width + G * 2,
            PH = region.height + G * 2;
        this.device.clearTextureRegion(this.texture, region.layer, region.paddedX, region.paddedY, PW, PH);
        const KEY = `${PW}x${PH}`;
        if (!this.free.has(KEY)) {
            this.free.set(KEY, []);
        }
        this.free.get(KEY).push({ layer: region.layer, x: region.paddedX, y: region.paddedY });
        return true;
    }
    get stats() {
        return {
            layers: this.layerShelves.length,
            liveRegions: this.regions.size,
            bytes: this.width * this.height * 4 * this.layerShelves.length,
        };
    }
    _live() {
        if (this.disposed) {
            throw new Error('TextureAtlasArray is disposed');
        }
    }
    dispose() {
        if (this.disposed) {
            return false;
        }
        this.disposed = true;
        this.regions.clear();
        this.device.textureAtlasDisposed(this);
        return true;
    }
}

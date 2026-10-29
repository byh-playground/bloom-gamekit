import { validateCompiledAsset } from './schema.js';
import { acquireVectorAsset } from './runtime.js';
import { packPaintRegions } from '../rendering/paint-regions.js';

const CACHE = new WeakMap();
const MAX_FRAMES = 512;
const NOW = () => globalThis.performance?.now?.() ?? null;

function sampleFrames(clip, interval) {
    const COUNT = Math.ceil(clip.durationMs / interval);
    if (!Number.isSafeInteger(COUNT) || COUNT < 1 || COUNT > MAX_FRAMES) {
        return null;
    }
    return Array.from({ length: COUNT }, (_, index) => {
        const START = index * interval,
            DURATION = Math.min(interval, clip.durationMs - START);
        return {
            timeMs: clip.loop === 'once' && index === COUNT - 1 ? clip.durationMs : START + DURATION / 2,
            durationMs: DURATION,
        };
    });
}

function sampledBounds(actor, geometry, samples) {
    const VERTICES = geometry.vertices;
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const SAMPLE of samples) {
        actor.seek(SAMPLE.timeMs);
        const POSES = actor.partPoses();
        for (let offset = 0; offset < VERTICES.length; offset += 11) {
            const POSE = POSES[VERTICES[offset + 10]];
            if (!POSE.visible || POSE.opacity <= 0) {
                continue;
            }
            const X = VERTICES[offset] + VERTICES[offset + 6] * POSE.morph[0] + VERTICES[offset + 8] * POSE.morph[1],
                Y = VERTICES[offset + 1] + VERTICES[offset + 7] * POSE.morph[0] + VERTICES[offset + 9] * POSE.morph[1],
                M = POSE.transform,
                TX = M[0] * X + M[2] * Y + M[4],
                TY = M[1] * X + M[3] * Y + M[5];
            minX = Math.min(minX, TX);
            minY = Math.min(minY, TY);
            maxX = Math.max(maxX, TX);
            maxY = Math.max(maxY, TY);
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function packFrames(count, tileWidth, tileHeight, maxWidth, maxHeight) {
    if (tileWidth > maxWidth || tileHeight > maxHeight) {
        return null;
    }
    let best = null;
    for (let columns = 1; columns <= count && columns * tileWidth <= maxWidth; columns++) {
        const ROWS = Math.ceil(count / columns),
            WIDTH = columns * tileWidth,
            HEIGHT = ROWS * tileHeight,
            BYTES = WIDTH * HEIGHT * 4;
        if (HEIGHT > maxHeight || (best && BYTES >= best.bytes)) {
            continue;
        }
        best = { columns, width: WIDTH, height: HEIGHT, bytes: BYTES };
    }
    return best;
}

function spriteDefinition(clipName, clip, samples, packed, contentWidth, contentHeight, padding, bounds, ppu) {
    const FRAMES = samples.map((sample, index) => ({
        x: (index % packed.columns) * (contentWidth + padding * 2) + padding,
        y: Math.floor(index / packed.columns) * (contentHeight + padding * 2) + padding,
        width: contentWidth,
        height: contentHeight,
        durationMs: sample.durationMs,
        sourceX: 0,
        sourceY: 0,
        sourceWidth: contentWidth,
        sourceHeight: contentHeight,
        pivotX: -bounds.minX * ppu,
        pivotY: -bounds.minY * ppu,
        gutter: padding,
    }));
    const ORDER = FRAMES.map((_, index) => index);
    if (clip.loop === 'alternate') {
        ORDER.push(...ORDER.slice().reverse());
    }
    return Object.freeze({
        textureOrigin: 'bottom-left',
        sourceWidth: contentWidth,
        sourceHeight: contentHeight,
        gutter: padding,
        frames: Object.freeze(FRAMES.map((frame) => Object.freeze(frame))),
        clips: Object.freeze({
            [clipName]: Object.freeze({
                frames: Object.freeze(ORDER),
                loop: clip.loop === 'once' ? 'once' : 'loop',
            }),
        }),
    });
}

/**
 * Samples one authored clip at bake time; shares the context's GPU resources for `compiledAsset` and owns a
 * ref-counted bake into one region of the device's shared texture atlas. Play it with
 * createSpriteAnimation(context, atlas.region, atlas.definition).
 */
export function createVectorSpriteAtlas(context, compiledAsset, options = {}) {
    const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
    try {
        return bakeSpriteAtlas(context, ASSET, RELEASE, compiledAsset, options);
    } catch (error) {
        RELEASE();
        throw error;
    }
}
function bakeSpriteAtlas(
    context,
    asset,
    release,
    compiledAsset,
    {
        clip,
        expression = compiledAsset?.metadata?.defaultExpression,
        sampleIntervalMs = 100,
        pixelsPerUnit = 1,
        padding = 2,
        paintRegions = null,
        supersample = 1,
    } = {},
) {
    validateCompiledAsset(compiledAsset);
    const DEVICE = context.device,
        MESHES = context.meshRenderer,
        GEOMETRY = compiledAsset.geometry;
    if (
        !context.drawQuads ||
        !DEVICE?.createRenderTarget ||
        !DEVICE?.blitRenderTarget ||
        !DEVICE?.createTextureLayerTarget ||
        !DEVICE?.bindRenderTarget ||
        !DEVICE?.unbindRenderTarget
    ) {
        throw new TypeError('A VectorContext is required');
    }
    if (
        !Object.hasOwn(compiledAsset.metadata.clips, clip) ||
        !Object.hasOwn(compiledAsset.metadata.expressions, expression)
    ) {
        throw new TypeError('Known authored clip and expression required');
    }
    if (
        !Number.isFinite(sampleIntervalMs) ||
        sampleIntervalMs <= 0 ||
        !Number.isFinite(pixelsPerUnit) ||
        pixelsPerUnit <= 0 ||
        !Number.isSafeInteger(padding) ||
        padding < 1
    ) {
        throw new TypeError('Finite positive sample interval, pixel scale and padding required');
    }
    if (![1, 2, 4].includes(supersample)) {
        throw new RangeError('Sprite bake supersample must be 1, 2 or 4');
    }
    // Includes the persistent image and simultaneously live preparation targets.
    const WORKING_FACTOR = supersample === 1 ? 1 : supersample === 2 ? 5 : 21;
    // Capture and validate named RGB values before caching; caller mutation must
    // never recolour a later bake or its context-restoration bake.
    const PAINT_NAMES = GEOMETRY.paintRegions?.names ?? [],
        PAINT = packPaintRegions(PAINT_NAMES, paintRegions, new Float32Array((PAINT_NAMES.length + 1) * 4)),
        CAPTURED_PAINT = Object.fromEntries(
            PAINT_NAMES.flatMap((name, index) => {
                const AT = (index + 1) * 4;
                return PAINT[AT + 3] ? [[name, Array.from(PAINT.subarray(AT, AT + 3))]] : [];
            }),
        );
    const KEY = JSON.stringify([
        clip,
        expression,
        sampleIntervalMs,
        pixelsPerUnit,
        padding,
        Array.from(PAINT),
        supersample,
    ]);
    const ATLAS = DEVICE.textureAtlas;
    let cached = CACHE.get(asset);
    if (!cached) {
        cached = new Map();
        CACHE.set(asset, cached);
    }
    let record = cached.get(KEY);
    if (!record) {
        const DEFINITION = compiledAsset.metadata.clips[clip];
        let reason = null;
        if (GEOMETRY.shaderSurfaces?.length || GEOMETRY.drawOrder?.length) {
            reason = 'shaderSurfaces';
        } else if (GEOMETRY.morphCount && compiledAsset.metadata.styles?.some((style) => style.kind === 'sketch')) {
            reason = 'timeDependentMorph';
        } else if (GEOMETRY.nonScalingStroke) {
            reason = 'nonScalingStroke';
        } else if (!asset.mesh) {
            reason = 'sourceMeshUnavailable';
        }
        const SAMPLES = reason ? null : sampleFrames(DEFINITION, sampleIntervalMs);
        if (!reason && !SAMPLES) {
            reason = 'frameLimit';
        }
        const ACTOR = reason ? null : asset.createActor({ clip, startedAtMs: 0 });
        if (ACTOR && expression !== compiledAsset.metadata.defaultExpression) {
            ACTOR.setExpression(expression);
        }
        const BOUNDS = ACTOR ? sampledBounds(ACTOR, GEOMETRY, SAMPLES) : null;
        if (!reason && !BOUNDS) {
            reason = 'emptyFrames';
        }
        const CONTENT_WIDTH = BOUNDS ? Math.max(1, Math.ceil((BOUNDS.maxX - BOUNDS.minX) * pixelsPerUnit)) : 0,
            CONTENT_HEIGHT = BOUNDS ? Math.max(1, Math.ceil((BOUNDS.maxY - BOUNDS.minY) * pixelsPerUnit)) : 0,
            TILE_WIDTH = CONTENT_WIDTH + padding * 2,
            TILE_HEIGHT = CONTENT_HEIGHT + padding * 2;
        const PACKED = reason
            ? null
            : packFrames(
                  SAMPLES.length,
                  TILE_WIDTH,
                  TILE_HEIGHT,
                  Math.min(ATLAS.width - ATLAS.gutter * 2, Math.floor(DEVICE.maxTextureSize / supersample)),
                  Math.min(ATLAS.height - ATLAS.gutter * 2, Math.floor(DEVICE.maxTextureSize / supersample)),
              );
        if (!reason && !PACKED) {
            reason = 'atlasLimit';
        }
        let region = null;
        if (!reason) {
            try {
                region = ATLAS.allocate(PACKED.width, PACKED.height);
            } catch (error) {
                if (!(error instanceof RangeError)) {
                    throw error;
                }
                reason = 'atlasLimit';
            }
        }
        if (reason) {
            ACTOR?.dispose();
        }
        record = {
            key: KEY,
            refs: 0,
            reason,
            lastError: null,
            actor: reason ? null : ACTOR,
            samples: SAMPLES,
            bounds: BOUNDS,
            packed: PACKED,
            definition: reason
                ? null
                : spriteDefinition(
                      clip,
                      DEFINITION,
                      SAMPLES,
                      PACKED,
                      CONTENT_WIDTH,
                      CONTENT_HEIGHT,
                      padding,
                      BOUNDS,
                      pixelsPerUnit,
                  ),
            region,
            target: null,
            bakedRestores: -1,
            failedFrame: -1,
            failedRestores: -1,
            bakeCount: 0,
            bakeCpuMs: 0,
        };
        cached.set(KEY, record);
    }
    record.refs++;
    let disposed = false;
    const BAKE = () => {
        if (disposed || asset.disposed) {
            throw new Error('Vector sprite atlas or source asset is disposed');
        }
        if (record.reason) {
            return { backend: 'vector', reason: record.reason };
        }
        if (!DEVICE.active || DEVICE.state !== 'ready') {
            return { backend: 'vector', reason: 'frameUnavailable' };
        }
        const RESTORES = DEVICE.stats.restores ?? 0;
        if (record.target && record.bakedRestores === RESTORES && DEVICE.isRenderTargetAvailable(record.target)) {
            return { backend: 'sprite', reason: null };
        }
        if (record.failedFrame === DEVICE.stats.frame && record.failedRestores === RESTORES) {
            return { backend: 'vector', reason: 'bakeFailed' };
        }
        const START = NOW();
        let boundTarget = null;
        const TRANSIENTS = new Set();
        try {
            DEVICE.flushBatchers('spriteAtlasBakeBoundary');
            if (record.target && !DEVICE.isRenderTargetAvailable(record.target)) {
                DEVICE.deleteRenderTarget(record.target);
                record.target = null;
            }
            const REGION = record.region;
            record.target ??= DEVICE.createTextureLayerTarget(ATLAS.texture, REGION.layer);
            let source = record.target;
            if (supersample > 1) {
                source = DEVICE.createRenderTarget(
                    record.packed.width * supersample,
                    record.packed.height * supersample,
                    {
                        format: 'rgba',
                        filter: 'linear',
                    },
                );
                TRANSIENTS.add(source);
            } else {
                DEVICE.clearTextureRegion(
                    ATLAS.texture,
                    REGION.layer,
                    REGION.paddedX,
                    REGION.paddedY,
                    REGION.width + ATLAS.gutter * 2,
                    REGION.height + ATLAS.gutter * 2,
                );
            }
            DEVICE.bindRenderTarget(source);
            boundTarget = source;
            if (supersample > 1) {
                DEVICE.clear({ color: [0, 0, 0, 0] });
            }
            const { minX: MIN_X, minY: MIN_Y } = record.bounds;
            // Without supersampling the samples land straight in the layer: the region's top edge sits `top` pixels
            // below the layer's top edge because rendered rows run bottom-up. Otherwise the source target is region-sized.
            const DIRECT = supersample === 1,
                BAKE_WIDTH = DIRECT ? ATLAS.width : record.packed.width,
                BAKE_HEIGHT = DIRECT ? ATLAS.height : record.packed.height,
                ORIGIN_X = DIRECT ? REGION.x : 0,
                ORIGIN_Y = DIRECT ? ATLAS.height - (REGION.y + REGION.height) : 0;
            for (let index = 0; index < record.samples.length; index++) {
                const SAMPLE = record.samples[index],
                    FRAME = record.definition.frames[index],
                    TX = ORIGIN_X + FRAME.x - pixelsPerUnit * MIN_X,
                    TY = ORIGIN_Y + FRAME.y - pixelsPerUnit * MIN_Y;
                record.actor.seek(SAMPLE.timeMs);
                record.actor.draw({
                    paintRegions: CAPTURED_PAINT,
                    projection: [
                        (2 * pixelsPerUnit) / BAKE_WIDTH,
                        0,
                        0,
                        0,
                        (-2 * pixelsPerUnit) / BAKE_HEIGHT,
                        0,
                        (2 * TX) / BAKE_WIDTH - 1,
                        1 - (2 * TY) / BAKE_HEIGHT,
                        1,
                    ],
                });
                // One actor reuses one pose row; dispatch before seeking the next sampled time.
                MESHES.flush('spriteAtlasSample');
            }
            DEVICE.unbindRenderTarget(source);
            boundTarget = null;
            // Each 2:1 linear blit averages exactly a 2x2 texel footprint. A single 4:1 bilinear
            // resize would skip samples and retain aliasing.
            for (let scale = supersample / 2; supersample > 1 && scale >= 1; scale /= 2) {
                if (scale === 1) {
                    DEVICE.blitRenderTarget(source, record.target, {
                        x: REGION.x,
                        y: REGION.y,
                        width: record.packed.width,
                        height: record.packed.height,
                    });
                    break;
                }
                const TARGET = DEVICE.createRenderTarget(record.packed.width * scale, record.packed.height * scale, {
                    format: 'rgba',
                    filter: 'linear',
                });
                TRANSIENTS.add(TARGET);
                DEVICE.blitRenderTarget(source, TARGET);
                DEVICE.deleteRenderTarget(source);
                TRANSIENTS.delete(source);
                source = TARGET;
            }
            record.bakedRestores = RESTORES;
            record.bakeCount++;
            if (START !== null) {
                record.bakeCpuMs += NOW() - START;
            }
            record.lastError = null;
            return { backend: 'sprite', reason: null };
        } catch (error) {
            if (boundTarget) {
                MESHES.discard();
                try {
                    DEVICE.unbindRenderTarget(boundTarget);
                } catch {
                    // Context loss can prevent restoring a framebuffer binding.
                }
            }
            try {
                if (record.target) {
                    DEVICE.deleteRenderTarget(record.target);
                    record.target = null;
                }
            } catch {
                // Keep the original bake failure as the diagnostic.
            }
            record.bakedRestores = -1;
            record.failedFrame = DEVICE.stats.frame;
            record.failedRestores = DEVICE.stats.restores ?? 0;
            record.lastError = error.message;
            return { backend: 'vector', reason: 'bakeFailed' };
        } finally {
            for (const TARGET of TRANSIENTS) {
                DEVICE.deleteRenderTarget(TARGET);
            }
        }
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        disposed = true;
        record.refs--;
        if (record.refs === 0) {
            try {
                if (DEVICE.state === 'ready' && DEVICE.active) {
                    DEVICE.flushBatchers('spriteAtlasDispose');
                }
                if (record.target) {
                    DEVICE.deleteRenderTarget(record.target);
                    record.target = null;
                }
            } finally {
                if (record.region && DEVICE.state === 'ready') {
                    ATLAS.release(record.region);
                }
                record.actor?.dispose();
                cached.delete(KEY);
                if (cached.size === 0) {
                    CACHE.delete(asset);
                }
            }
        }
        release();
        return true;
    };
    return Object.freeze({
        bake: BAKE,
        dispose: DISPOSE,
        /** The shared-atlas region holding the baked frames; pass it to createSpriteAnimation. */
        get region() {
            return disposed || !record.target ? null : record.region;
        },
        get definition() {
            return disposed ? null : record.definition;
        },
        get stats() {
            return {
                disposed,
                reason: record.reason ?? (record.lastError ? 'bakeFailed' : null),
                lastError: record.lastError,
                cacheKey: KEY,
                refCount: record.refs,
                clip,
                expression,
                pixelsPerUnit,
                supersample,
                bakeWorkingBytes: (record.packed?.bytes ?? 0) * WORKING_FACTOR,
                sampleIntervalMs,
                sampleTimesMs: record.samples?.map((sample) => sample.timeMs) ?? [],
                sampleDurationsMs: record.samples?.map((sample) => sample.durationMs) ?? [],
                sampledDurationMs: record.samples?.reduce((sum, sample) => sum + sample.durationMs, 0) ?? 0,
                frameCount: record.samples?.length ?? 0,
                atlasWidth: record.packed?.width ?? 0,
                atlasHeight: record.packed?.height ?? 0,
                // Planned RGBA capacity; allocatedBytes tracks the live shared texture.
                atlasBytes: record.packed?.bytes ?? 0,
                allocatedBytes: !disposed && record.target ? (record.packed?.bytes ?? 0) : 0,
                bakeCount: record.bakeCount,
                bakeCpuMs: record.bakeCpuMs,
                baked: Boolean(
                    !disposed &&
                    !asset.disposed &&
                    record.target &&
                    record.bakedRestores === (DEVICE.stats.restores ?? 0),
                ),
            };
        },
    });
}

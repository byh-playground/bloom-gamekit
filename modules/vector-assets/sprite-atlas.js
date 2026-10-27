import { validateCompiledAsset } from './schema.js';
import { packPaintRegions } from '../rendering/paint-regions.js';
import { createSpriteAnimation } from '../rendering/sprite-animation.js';

const CACHE = new WeakMap();
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 512;
const NOW = () => globalThis.performance?.now?.() ?? null;

function sameGeometry(mesh, geometry) {
    const VERTICES = mesh.vertices,
        INDICES = mesh.indices;
    return (
        VERTICES?.length === geometry.vertices.length &&
        VERTICES.every((value, index) => value === geometry.vertices[index]) &&
        (geometry.indices === undefined
            ? INDICES === undefined
            : INDICES instanceof Uint16Array &&
              INDICES.length === geometry.indices.length &&
              INDICES.every((value, index) => value === geometry.indices[index]))
    );
}

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

function sampledBounds(player, geometry, samples) {
    const VERTICES = geometry.vertices;
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const SAMPLE of samples) {
        player.seek(SAMPLE.timeMs);
        const POSES = player.partPoses();
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

function packFrames(count, tileWidth, tileHeight, maxSize, maxBytes) {
    if (tileWidth > maxSize || tileHeight > maxSize) {
        return null;
    }
    let best = null;
    for (let columns = 1; columns <= count && columns * tileWidth <= maxSize; columns++) {
        const ROWS = Math.ceil(count / columns),
            WIDTH = columns * tileWidth,
            HEIGHT = ROWS * tileHeight,
            BYTES = WIDTH * HEIGHT * 4;
        if (HEIGHT > maxSize || BYTES > maxBytes || (best && BYTES >= best.bytes)) {
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

/** Samples one authored clip at bake time; borrows the source asset and owns a ref-counted atlas texture. */
export function createVectorSpriteAtlas(
    meshRenderer,
    asset,
    compiledAsset,
    {
        clip,
        expression = compiledAsset?.metadata?.defaultExpression,
        sampleIntervalMs = 100,
        pixelsPerUnit = 1,
        padding = 2,
        maxAtlasSize = null,
        maxAtlasBytes = DEFAULT_MAX_BYTES,
        paintRegions = null,
        supersample = 1,
    } = {},
) {
    validateCompiledAsset(compiledAsset);
    const DEVICE = meshRenderer?.device,
        GEOMETRY = compiledAsset.geometry,
        SOURCE_MESH_MATCHES = asset?.mesh
            ? asset.mesh.renderer === meshRenderer &&
              asset.mesh.partCount === GEOMETRY.partCount &&
              sameGeometry(asset.mesh, GEOMETRY)
            : GEOMETRY.vertices.length === 0;
    if (
        !DEVICE?.createRenderTarget ||
        !DEVICE?.bindRenderTarget ||
        !DEVICE?.unbindRenderTarget ||
        !asset?.ownsPlayer ||
        asset.disposed ||
        asset.sourceSha256 !== compiledAsset.sourceSha256 ||
        !SOURCE_MESH_MATCHES
    ) {
        throw new TypeError('A matching live vector asset and MeshRenderer are required');
    }
    if (
        !Object.hasOwn(compiledAsset.metadata.clips, clip) ||
        !Object.hasOwn(compiledAsset.metadata.expressions, expression)
    ) {
        throw new TypeError('Known authored clip and expression required');
    }
    maxAtlasSize ??= DEVICE.maxTextureSize;
    if (
        !Number.isFinite(sampleIntervalMs) ||
        sampleIntervalMs <= 0 ||
        !Number.isFinite(pixelsPerUnit) ||
        pixelsPerUnit <= 0 ||
        !Number.isSafeInteger(padding) ||
        padding < 1 ||
        !Number.isSafeInteger(maxAtlasSize) ||
        maxAtlasSize < 1 ||
        maxAtlasSize > DEVICE.maxTextureSize ||
        !Number.isSafeInteger(maxAtlasBytes) ||
        maxAtlasBytes < 4
    ) {
        throw new TypeError('Finite positive sample interval, pixel scale, padding and atlas budgets required');
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
        maxAtlasSize,
        maxAtlasBytes,
        Array.from(PAINT),
        supersample,
    ]);
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
        const PLAYER = reason ? null : asset.createPlayer({ clip, startedAtMs: 0 });
        if (PLAYER && expression !== compiledAsset.metadata.defaultExpression) {
            PLAYER.setExpression(expression);
        }
        const BOUNDS = PLAYER ? sampledBounds(PLAYER, GEOMETRY, SAMPLES) : null;
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
                  Math.floor(maxAtlasSize / supersample),
                  Math.floor(maxAtlasBytes / WORKING_FACTOR),
              );
        if (!reason && !PACKED) {
            reason = 'atlasLimit';
        }
        if (reason) {
            PLAYER?.dispose();
        }
        record = {
            key: KEY,
            refs: 0,
            reason,
            lastError: null,
            player: reason ? null : PLAYER,
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
            texture: null,
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
        if (record.texture && record.bakedRestores === RESTORES && DEVICE.isRenderTargetAvailable(record.texture)) {
            return { backend: 'sprite', reason: null };
        }
        if (record.failedFrame === DEVICE.stats.frame && record.failedRestores === RESTORES) {
            return { backend: 'vector', reason: 'bakeFailed' };
        }
        const START = NOW();
        let boundTarget = null;
        let reduction = null;
        const TRANSIENTS = new Set();
        try {
            meshRenderer.flush('spriteAtlasBakeBoundary');
            if (record.texture && !DEVICE.isRenderTargetAvailable(record.texture)) {
                DEVICE.deleteRenderTarget(record.texture);
                record.texture = null;
            }
            record.texture ??= DEVICE.createRenderTarget(record.packed.width, record.packed.height, {
                format: 'rgba',
                filter: 'linear',
            });
            let source = record.texture;
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
            }
            DEVICE.bindRenderTarget(source);
            boundTarget = source;
            DEVICE.clear({ color: [0, 0, 0, 0] });
            const { minX: MIN_X, minY: MIN_Y } = record.bounds;
            for (let index = 0; index < record.samples.length; index++) {
                const SAMPLE = record.samples[index],
                    FRAME = record.definition.frames[index],
                    TX = FRAME.x - pixelsPerUnit * MIN_X,
                    TY = FRAME.y - pixelsPerUnit * MIN_Y;
                record.player.seek(SAMPLE.timeMs);
                record.player.draw({
                    paintRegions: CAPTURED_PAINT,
                    projection: [
                        (2 * pixelsPerUnit) / record.packed.width,
                        0,
                        0,
                        0,
                        (-2 * pixelsPerUnit) / record.packed.height,
                        0,
                        (2 * TX) / record.packed.width - 1,
                        1 - (2 * TY) / record.packed.height,
                        1,
                    ],
                });
                // One player reuses one pose row; dispatch before seeking the next sampled time.
                meshRenderer.flush('spriteAtlasSample');
            }
            DEVICE.unbindRenderTarget(source);
            boundTarget = null;
            // Each 2:1 linear step samples exactly a 2x2 texel footprint. A
            // single 4:1 bilinear resize would skip samples and retain aliasing.
            for (let scale = supersample / 2; scale >= 1; scale /= 2) {
                const TARGET =
                    scale === 1
                        ? record.texture
                        : DEVICE.createRenderTarget(record.packed.width * scale, record.packed.height * scale, {
                              format: 'rgba',
                              filter: 'linear',
                          });
                if (scale > 1) {
                    TRANSIENTS.add(TARGET);
                }
                reduction = createSpriteAnimation(meshRenderer, source, {
                    textureOrigin: 'bottom-left',
                    frames: [{ x: 0, y: 0, width: source.width, height: source.height, durationMs: 1 }],
                    clips: { reduction: { frames: [0], loop: 'once' } },
                });
                DEVICE.bindRenderTarget(TARGET);
                boundTarget = TARGET;
                DEVICE.clear({ color: [0, 0, 0, 0] });
                reduction.createPlayer().draw({
                    timeMs: 0,
                    projection: [2 / TARGET.width, 0, 0, 0, -2 / TARGET.height, 0, -1, 1, 1],
                    matrix: [0.5, 0, 0, 0.5, 0, 0],
                });
                meshRenderer.flush('spriteAtlasReduction');
                DEVICE.unbindRenderTarget(TARGET);
                boundTarget = null;
                reduction.dispose();
                reduction = null;
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
                meshRenderer.discard();
                try {
                    DEVICE.unbindRenderTarget(boundTarget);
                } catch {
                    // Context loss can prevent restoring a framebuffer binding.
                }
            }
            try {
                if (record.texture) {
                    DEVICE.deleteRenderTarget(record.texture);
                    record.texture = null;
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
            reduction?.dispose();
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
                    meshRenderer.flush('spriteAtlasDispose');
                }
                if (record.texture) {
                    DEVICE.deleteRenderTarget(record.texture);
                    record.texture = null;
                }
            } finally {
                record.player?.dispose();
                cached.delete(KEY);
                if (cached.size === 0) {
                    CACHE.delete(asset);
                }
            }
        }
        return true;
    };
    return Object.freeze({
        bake: BAKE,
        dispose: DISPOSE,
        get texture() {
            return disposed ? null : record.texture;
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
                allocatedBytes: !disposed && record.texture ? (record.packed?.bytes ?? 0) : 0,
                bakeCount: record.bakeCount,
                bakeCpuMs: record.bakeCpuMs,
                baked: Boolean(
                    !disposed &&
                    !asset.disposed &&
                    record.texture &&
                    record.bakedRestores === (DEVICE.stats.restores ?? 0),
                ),
            };
        },
    });
}

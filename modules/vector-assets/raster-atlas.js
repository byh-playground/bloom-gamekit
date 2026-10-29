import { acquireVectorAsset } from './runtime.js';

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);
const NOW = () => globalThis.performance?.now?.() ?? null;

function nextPowerOfTwo(value) {
    return 2 ** Math.ceil(Math.log2(value));
}

function sourceRuns(geometry) {
    const { vertices: VERTICES, indices: INDICES, partCount: PART_COUNT } = geometry;
    if (!(INDICES instanceof Uint16Array)) {
        return null;
    }
    const RUNS = [];
    for (let offset = 0; offset < INDICES.length; offset += 3) {
        const A = INDICES[offset],
            B = INDICES[offset + 1],
            C = INDICES[offset + 2],
            PART = VERTICES[A * 11 + 10];
        if (
            !Number.isSafeInteger(PART) ||
            PART < 0 ||
            PART >= PART_COUNT ||
            VERTICES[B * 11 + 10] !== PART ||
            VERTICES[C * 11 + 10] !== PART
        ) {
            return null;
        }
        let run = RUNS.at(-1);
        if (!run || run.partIndex !== PART) {
            run = {
                partIndex: PART,
                firstIndex: offset,
                indexCount: 0,
                minX: Infinity,
                minY: Infinity,
                maxX: -Infinity,
                maxY: -Infinity,
            };
            RUNS.push(run);
        }
        run.indexCount += 3;
        for (const VERTEX of [A, B, C]) {
            const X = VERTICES[VERTEX * 11],
                Y = VERTICES[VERTEX * 11 + 1];
            run.minX = Math.min(run.minX, X);
            run.minY = Math.min(run.minY, Y);
            run.maxX = Math.max(run.maxX, X);
            run.maxY = Math.max(run.maxY, Y);
        }
    }
    return RUNS;
}

function wholeRunExpressions(geometry, runs) {
    const SOURCE = geometry.indices;
    for (const VARIANT of Object.values(geometry.expressionIndices ?? {})) {
        let offset = 0;
        for (const RUN of runs) {
            if (offset + RUN.indexCount > VARIANT.length) {
                continue;
            }
            let matches = true;
            for (let index = 0; index < RUN.indexCount; index++) {
                if (VARIANT[offset + index] !== SOURCE[RUN.firstIndex + index]) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                offset += RUN.indexCount;
            }
        }
        if (offset !== VARIANT.length) {
            return false;
        }
    }
    return true;
}

function packRuns(runs, maxWidth, maxHeight) {
    const WIDEST = Math.max(...runs.map((run) => run.tileWidth));
    if (WIDEST > maxWidth || runs.some((run) => run.tileHeight > maxHeight)) {
        return null;
    }
    const WIDTHS = new Set([WIDEST, maxWidth]);
    for (let width = nextPowerOfTwo(WIDEST); width < maxWidth; width *= 2) {
        WIDTHS.add(width);
    }
    let best = null;
    for (const WIDTH of WIDTHS) {
        let x = 0,
            y = 0,
            rowHeight = 0;
        const POSITIONS = [];
        for (const RUN of runs) {
            if (x + RUN.tileWidth > WIDTH) {
                x = 0;
                y += rowHeight;
                rowHeight = 0;
            }
            POSITIONS.push([x, y]);
            x += RUN.tileWidth;
            rowHeight = Math.max(rowHeight, RUN.tileHeight);
        }
        const HEIGHT = y + rowHeight;
        const BYTES = WIDTH * HEIGHT * 4;
        if (HEIGHT > maxHeight || (best && BYTES >= best.bytes)) {
            continue;
        }
        best = { width: WIDTH, height: HEIGHT, bytes: BYTES, positions: POSITIONS };
    }
    return best;
}

/**
 * One atlas rectangle per run: the UV rectangle selects the run's tile inside the shared array (rendered content is
 * stored bottom-up, so v runs downward from the region's top texture row) and the local rectangle places it in asset space.
 */
function runTables(runs, packed, region, pixelsPerUnit, padding) {
    const ATLAS = region.atlas,
        UV_RECTS = new Float32Array(runs.length * 4),
        LOCAL_RECTS = new Float32Array(runs.length * 4),
        PARTS = new Float32Array(runs.length);
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        const RUN = runs[runIndex],
            [TILE_X, TILE_Y] = packed.positions[runIndex];
        UV_RECTS.set(
            [
                (region.x + TILE_X) / ATLAS.width,
                (region.y + region.height - TILE_Y) / ATLAS.height,
                RUN.tileWidth / ATLAS.width,
                -RUN.tileHeight / ATLAS.height,
            ],
            runIndex * 4,
        );
        LOCAL_RECTS.set(
            [
                RUN.minX - padding / pixelsPerUnit,
                RUN.minY - padding / pixelsPerUnit,
                RUN.tileWidth / pixelsPerUnit,
                RUN.tileHeight / pixelsPerUnit,
            ],
            runIndex * 4,
        );
        PARTS[runIndex] = RUN.partIndex;
    }
    return { uvRects: UV_RECTS, localRects: LOCAL_RECTS, parts: PARTS };
}

/**
 * Bakes a compiled SVG into one region of the device's shared texture atlas and draws its actors as atlas
 * rectangles in the context's vector stream, so every baked asset, shape and glyph of one state is one draw.
 * The atlas shares the context's GPU resources for `compiledAsset` and owns its region until `dispose`.
 */
export function createVectorRasterAtlas(context, compiledAsset, options = {}) {
    const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
    try {
        return bakeRasterAtlas(context, ASSET, RELEASE, compiledAsset, options);
    } catch (error) {
        RELEASE();
        throw error;
    }
}
function bakeRasterAtlas(context, asset, release, compiledAsset, { pixelsPerUnit = 1, padding = 2 } = {}) {
    const DEVICE = context.device;
    const MESHES = context.meshRenderer;
    if (
        !context.drawQuads ||
        !context.drawVectorActor ||
        !DEVICE?.createTextureLayerTarget ||
        !DEVICE?.bindRenderTarget ||
        !DEVICE?.unbindRenderTarget
    ) {
        throw new TypeError('A VectorContext is required');
    }
    if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 || !Number.isSafeInteger(padding) || padding < 1) {
        throw new TypeError('A positive pixel scale and padding are required');
    }
    const ATLAS = DEVICE.textureAtlas;
    const GEOMETRY = compiledAsset.geometry;
    let unsupportedReason = null;
    if (GEOMETRY.morphCount) {
        unsupportedReason = 'morphTargets';
    } else if (GEOMETRY.shaderSurfaces?.length || GEOMETRY.drawOrder?.length) {
        unsupportedReason = 'shaderSurfaces';
    } else if (GEOMETRY.nonScalingStroke) {
        unsupportedReason = 'nonScalingStroke';
    }
    const RUNS = unsupportedReason ? [] : sourceRuns(GEOMETRY);
    if (!unsupportedReason && (!RUNS || !RUNS.length)) {
        unsupportedReason = 'partTriangles';
    } else if (!unsupportedReason && !wholeRunExpressions(GEOMETRY, RUNS)) {
        unsupportedReason = 'expressionRunSelection';
    }
    if (!unsupportedReason) {
        for (const RUN of RUNS) {
            RUN.tileWidth = Math.max(1, Math.ceil((RUN.maxX - RUN.minX) * pixelsPerUnit)) + padding * 2;
            RUN.tileHeight = Math.max(1, Math.ceil((RUN.maxY - RUN.minY) * pixelsPerUnit)) + padding * 2;
            if (!Number.isSafeInteger(RUN.tileWidth) || !Number.isSafeInteger(RUN.tileHeight)) {
                unsupportedReason = 'atlasLimit';
                break;
            }
        }
    }
    const PACKED = unsupportedReason
        ? null
        : packRuns(RUNS, ATLAS.width - ATLAS.gutter * 2, ATLAS.height - ATLAS.gutter * 2);
    if (!unsupportedReason && !PACKED) {
        unsupportedReason = 'atlasLimit';
    }
    let region = null;
    if (!unsupportedReason) {
        try {
            region = ATLAS.allocate(PACKED.width, PACKED.height);
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }
            unsupportedReason = 'atlasLimit';
        }
    }
    const TABLES = region ? runTables(RUNS, PACKED, region, pixelsPerUnit, padding) : null;
    let target = null;
    let bakedRestores = -1;
    let failedFrame = -1;
    let failedRestores = -1;
    let lastFailure = null;
    let disposed = false;
    let bakeCount = 0;
    let bakeCpuMs = 0;
    let rasterDraws = 0;
    let vectorDraws = 0;
    const FALLBACK_REASONS = Object.create(null);
    const FALLBACK = (actor, options, reason) => {
        vectorDraws++;
        FALLBACK_REASONS[reason] = (FALLBACK_REASONS[reason] ?? 0) + 1;
        context.drawVectorActor(actor, options);
        return { backend: 'vector', reason };
    };
    const RELEASE_TARGET = () => {
        const TARGET = target;
        target = null;
        if (TARGET) {
            DEVICE.deleteRenderTarget(TARGET);
        }
    };
    const BAKE = () => {
        if (disposed || asset.disposed) {
            throw new Error('Vector raster atlas or source asset is disposed');
        }
        if (unsupportedReason) {
            return { backend: 'vector', reason: unsupportedReason };
        }
        if (!DEVICE.active || DEVICE.state !== 'ready') {
            return { backend: 'vector', reason: 'frameUnavailable' };
        }
        const RESTORES = DEVICE.stats.restores ?? 0;
        if (target && bakedRestores === RESTORES && DEVICE.isRenderTargetAvailable(target)) {
            return { backend: 'raster', reason: null };
        }
        if (failedFrame === DEVICE.stats.frame && failedRestores === RESTORES) {
            return { backend: 'vector', reason: 'bakeFailed' };
        }
        const START = NOW();
        let bound = false;
        try {
            DEVICE.flushBatchers('rasterAtlasBakeBoundary');
            if (target && !DEVICE.isRenderTargetAvailable(target)) {
                RELEASE_TARGET();
            }
            target ??= DEVICE.createTextureLayerTarget(ATLAS.texture, region.layer);
            // The region is cleared in texture space; its gutter stays transparent so linear taps never bleed.
            DEVICE.clearTextureRegion(
                ATLAS.texture,
                region.layer,
                region.paddedX,
                region.paddedY,
                region.width + ATLAS.gutter * 2,
                region.height + ATLAS.gutter * 2,
            );
            DEVICE.bindRenderTarget(target);
            bound = true;
            // Rendered rows run bottom-up: the region's top edge sits `top` pixels below the layer's top edge.
            const TOP = ATLAS.height - (region.y + region.height);
            for (let index = 0; index < RUNS.length; index++) {
                const RUN = RUNS[index],
                    [TILE_X, TILE_Y] = PACKED.positions[index],
                    TX = region.x + TILE_X + padding - pixelsPerUnit * RUN.minX,
                    TY = TOP + TILE_Y + padding - pixelsPerUnit * RUN.minY;
                MESHES.drawMesh(asset.mesh, {
                    projection: [
                        (2 * pixelsPerUnit) / ATLAS.width,
                        0,
                        0,
                        0,
                        (-2 * pixelsPerUnit) / ATLAS.height,
                        0,
                        (2 * TX) / ATLAS.width - 1,
                        1 - (2 * TY) / ATLAS.height,
                        1,
                    ],
                    indexRange: [RUN.firstIndex, RUN.indexCount],
                });
            }
            MESHES.flush('rasterAtlasBake');
            DEVICE.unbindRenderTarget(target);
            bound = false;
            bakedRestores = RESTORES;
            bakeCount++;
            if (START !== null) {
                bakeCpuMs += NOW() - START;
            }
            lastFailure = null;
            return { backend: 'raster', reason: null };
        } catch (error) {
            if (bound) {
                MESHES.discard();
                try {
                    DEVICE.unbindRenderTarget(target);
                } catch {
                    // Context loss may prevent restoring a framebuffer binding.
                }
            }
            try {
                RELEASE_TARGET();
            } catch {
                // Preserve the original bake error for diagnostics and vector fallback.
            }
            bakedRestores = -1;
            failedFrame = DEVICE.stats.frame;
            failedRestores = DEVICE.stats.restores ?? 0;
            lastFailure = error.message;
            return { backend: 'vector', reason: 'bakeFailed' };
        }
    };
    const DRAW = (actor, options = {}) => {
        if (disposed || asset.disposed) {
            throw new Error('Vector raster atlas or source asset is disposed');
        }
        if (!asset.ownsActor(actor)) {
            throw new TypeError('A live actor owned by this vector asset is required');
        }
        if (unsupportedReason) {
            return FALLBACK(actor, options, unsupportedReason);
        }
        if (options.forceColor === true) {
            return FALLBACK(actor, options, 'forceColor');
        }
        if ((options.alpha !== undefined && options.alpha < 1) || options.color?.[3] < 1) {
            return FALLBACK(actor, options, 'globalOpacity');
        }
        if (actor.hasOpacityChannel) {
            return FALLBACK(actor, options, 'opacityChannel');
        }
        if (actor.hasNonUnitBaseOpacity) {
            return FALLBACK(actor, options, 'baseOpacity');
        }
        if (options.depthWriteAlphaThreshold != null) {
            return FALLBACK(actor, options, 'depthWriteAlphaThreshold');
        }
        const RESULT = BAKE();
        if (RESULT.backend !== 'raster') {
            return FALLBACK(actor, options, RESULT.reason);
        }
        const { excludeParts: EXCLUDE_PARTS = null, matrix: MATRIX = IDENTITY_MATRIX, ...DRAW_OPTIONS } = options;
        const POSE = actor.preparePose({ excludeParts: EXCLUDE_PARTS });
        if (!POSE) {
            return FALLBACK(actor, options, 'poseUnavailable');
        }
        context.drawQuads({
            ...DRAW_OPTIONS,
            matrix: MATRIX,
            layer: region.layer,
            filter: region.filter,
            pose: POSE,
            ...TABLES,
        });
        rasterDraws++;
        return { backend: 'raster', reason: null };
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        if (DEVICE.state === 'ready' && DEVICE.active) {
            DEVICE.flushBatchers('rasterAtlasDispose');
        }
        disposed = true;
        try {
            RELEASE_TARGET();
        } finally {
            try {
                if (region && DEVICE.state === 'ready') {
                    ATLAS.release(region);
                }
            } finally {
                release();
            }
        }
        return true;
    };
    return Object.freeze({
        bake: BAKE,
        draw: DRAW,
        dispose: DISPOSE,
        get stats() {
            return {
                baked: Boolean(
                    !disposed && !asset.disposed && target && bakedRestores === (DEVICE.stats.restores ?? 0),
                ),
                disposed,
                reason: unsupportedReason ?? (lastFailure ? 'bakeFailed' : null),
                lastError: lastFailure,
                layer: region?.layer ?? null,
                runCount: RUNS?.length ?? 0,
                // The packed runs' region of the shared atlas array.
                atlasWidth: PACKED?.width ?? 0,
                atlasHeight: PACKED?.height ?? 0,
                atlasBytes: PACKED?.bytes ?? 0,
                allocatedBytes: !disposed && target ? (PACKED?.bytes ?? 0) : 0,
                bakeCount,
                bakeCpuMs,
                rasterDraws,
                vectorDraws,
                fallbackReasons: { ...FALLBACK_REASONS },
            };
        },
    });
}

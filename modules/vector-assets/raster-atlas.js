import { claimTextureLayer } from './layer-claims.js';
import { validateCompiledAsset } from './schema.js';

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
 * One shared-quad instance per run: the UV rectangle selects the run's tile inside the layer (v runs downward from
 * the top because the layer is rendered, not uploaded) and the local rectangle places it in asset space.
 */
function runTables(runs, packed, layerWidth, layerHeight, pixelsPerUnit, padding) {
    const UV_RECTS = new Float32Array(runs.length * 4),
        LOCAL_RECTS = new Float32Array(runs.length * 4),
        PARTS = new Float32Array(runs.length);
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        const RUN = runs[runIndex],
            [TILE_X, TILE_Y] = packed.positions[runIndex];
        UV_RECTS.set(
            [TILE_X / layerWidth, 1 - TILE_Y / layerHeight, RUN.tileWidth / layerWidth, -RUN.tileHeight / layerHeight],
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
 * Bakes a retained vector asset into one layer of a caller-owned texture array and draws it as shared-quad runs.
 * The caller owns the array and dedicates `layer` to this atlas; every atlas of one array batches into one draw.
 */
export function createVectorRasterAtlas(
    meshRenderer,
    asset,
    compiledAsset,
    { textureArray, layer, pixelsPerUnit = 1, padding = 2 } = {},
) {
    validateCompiledAsset(compiledAsset);
    const DEVICE = meshRenderer?.device;
    const SOURCE_MESH_MATCHES = asset?.mesh
        ? asset.mesh.renderer === meshRenderer &&
          asset.mesh.partCount === compiledAsset.geometry.partCount &&
          sameGeometry(asset.mesh, compiledAsset.geometry)
        : compiledAsset.geometry.vertices.length === 0;
    if (
        !DEVICE?.createTextureLayerTarget ||
        !DEVICE?.bindRenderTarget ||
        !DEVICE?.unbindRenderTarget ||
        !asset?.ownsPlayer ||
        asset.disposed ||
        asset.sourceSha256 !== compiledAsset.sourceSha256 ||
        !SOURCE_MESH_MATCHES
    ) {
        throw new TypeError('A matching live vector asset and MeshRenderer are required');
    }
    if (!textureArray || !DEVICE.isTextureArray(textureArray)) {
        throw new TypeError('A texture array created by the same device is required');
    }
    if (
        !Number.isSafeInteger(layer) ||
        layer < 0 ||
        layer >= textureArray.layers ||
        !Number.isFinite(pixelsPerUnit) ||
        pixelsPerUnit <= 0 ||
        !Number.isSafeInteger(padding) ||
        padding < 1
    ) {
        throw new TypeError('A layer inside the texture array, a positive pixel scale and padding are required');
    }
    const RELEASE_LAYER = claimTextureLayer(textureArray, layer);
    const LAYER_WIDTH = textureArray.width,
        LAYER_HEIGHT = textureArray.height;
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
    const PACKED = unsupportedReason ? null : packRuns(RUNS, LAYER_WIDTH, LAYER_HEIGHT);
    if (!unsupportedReason && !PACKED) {
        unsupportedReason = 'atlasLimit';
    }
    const TABLES = unsupportedReason
        ? null
        : runTables(RUNS, PACKED, LAYER_WIDTH, LAYER_HEIGHT, pixelsPerUnit, padding);
    const MATRICES = TABLES ? new Float32Array(RUNS.length * 6) : null;
    let target = null;
    let quadAcquired = false;
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
    const FALLBACK = (player, options, reason) => {
        vectorDraws++;
        FALLBACK_REASONS[reason] = (FALLBACK_REASONS[reason] ?? 0) + 1;
        player.draw(options);
        return { backend: 'vector', reason };
    };
    const RELEASE = () => {
        const TARGET = target,
            ACQUIRED = quadAcquired;
        target = null;
        quadAcquired = false;
        try {
            if (ACQUIRED) {
                meshRenderer.releaseQuadMesh();
            }
        } finally {
            if (TARGET) {
                DEVICE.deleteRenderTarget(TARGET);
            }
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
            meshRenderer.flush('rasterAtlasBakeBoundary');
            if (target && !DEVICE.isRenderTargetAvailable(target)) {
                DEVICE.deleteRenderTarget(target);
                target = null;
            }
            target ??= DEVICE.createTextureLayerTarget(textureArray, layer);
            if (!quadAcquired) {
                meshRenderer.acquireQuadMesh();
                quadAcquired = true;
            }
            DEVICE.bindRenderTarget(target);
            bound = true;
            DEVICE.clear({ color: [0, 0, 0, 0] });
            for (let index = 0; index < RUNS.length; index++) {
                const RUN = RUNS[index],
                    [TILE_X, TILE_Y] = PACKED.positions[index],
                    TX = TILE_X + padding - pixelsPerUnit * RUN.minX,
                    TY = TILE_Y + padding - pixelsPerUnit * RUN.minY;
                meshRenderer.drawMesh(asset.mesh, {
                    projection: [
                        (2 * pixelsPerUnit) / LAYER_WIDTH,
                        0,
                        0,
                        0,
                        (-2 * pixelsPerUnit) / LAYER_HEIGHT,
                        0,
                        (2 * TX) / LAYER_WIDTH - 1,
                        1 - (2 * TY) / LAYER_HEIGHT,
                        1,
                    ],
                    indexRange: [RUN.firstIndex, RUN.indexCount],
                });
            }
            meshRenderer.flush('rasterAtlasBake');
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
                meshRenderer.discard();
                try {
                    DEVICE.unbindRenderTarget(target);
                } catch {
                    // Context loss may prevent restoring a framebuffer binding.
                }
            }
            try {
                RELEASE();
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
    const DRAW = (player, options = {}) => {
        if (disposed || asset.disposed) {
            throw new Error('Vector raster atlas or source asset is disposed');
        }
        if (!asset.ownsPlayer(player)) {
            throw new TypeError('A live player owned by this vector asset is required');
        }
        if (unsupportedReason) {
            return FALLBACK(player, options, unsupportedReason);
        }
        if (options.forceColor === true) {
            return FALLBACK(player, options, 'forceColor');
        }
        if ((options.alpha !== undefined && options.alpha < 1) || options.color?.[3] < 1) {
            return FALLBACK(player, options, 'globalOpacity');
        }
        if (player.hasOpacityChannel) {
            return FALLBACK(player, options, 'opacityChannel');
        }
        if (player.hasNonUnitBaseOpacity) {
            return FALLBACK(player, options, 'baseOpacity');
        }
        if (options.depthWriteAlphaThreshold != null) {
            return FALLBACK(player, options, 'depthWriteAlphaThreshold');
        }
        const RESULT = BAKE();
        if (RESULT.backend !== 'raster') {
            return FALLBACK(player, options, RESULT.reason);
        }
        const { excludeParts: EXCLUDE_PARTS = null, matrix: MATRIX = IDENTITY_MATRIX, ...DRAW_OPTIONS } = options;
        const POSE = player.preparePose({ excludeParts: EXCLUDE_PARTS });
        if (!POSE) {
            return FALLBACK(player, options, 'poseUnavailable');
        }
        for (let run = 0; run < RUNS.length; run++) {
            MATRICES.set(MATRIX, run * 6);
        }
        meshRenderer.drawQuadRuns({
            ...DRAW_OPTIONS,
            matrices: MATRICES,
            runs: TABLES,
            texture: textureArray,
            layer,
            pose: POSE,
        });
        rasterDraws++;
        return { backend: 'raster', reason: null };
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        if (DEVICE.state === 'ready' && DEVICE.active) {
            meshRenderer.flush('rasterAtlasDispose');
        }
        try {
            RELEASE();
        } finally {
            disposed = true;
            RELEASE_LAYER();
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
                layer,
                runCount: RUNS?.length ?? 0,
                // Region of the layer the packed runs occupy; the layer itself is owned by the texture array.
                atlasWidth: PACKED?.width ?? 0,
                atlasHeight: PACKED?.height ?? 0,
                atlasBytes: PACKED?.bytes ?? 0,
                bakeCount,
                bakeCpuMs,
                rasterDraws,
                vectorDraws,
                fallbackReasons: { ...FALLBACK_REASONS },
            };
        },
    });
}

import assert from 'node:assert/strict';
export async function exerciseWorldVectorRendering(browser, renderingURL, vectorAssetsURL, compiled, screenshotPath) {
    const PAGE = await browser.newPage({
        viewport: {
            width: 360,
            height: 280,
        },
        deviceScaleFactor: 1,
    });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    try {
        await PAGE.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#111820;color:#e8edf2;font:14px/1.45 system-ui,sans-serif;padding:18px}
      h1{font-size:16px;margin:0 0 6px}p{margin:0 0 12px;color:#aab7c4}canvas{display:block;background:#071018;border:1px solid #71808a}
    </style><h1>GameKit retained SVG + shader surface / 3D world transforms</h1>
    <p>47 and 74 CSS-pixel actors · SVG order · object-space clipping · depth-tested WebGL</p><canvas width="240" height="180" style="width:240px;height:180px"></canvas>`);
        const RESULT = await PAGE.evaluate(
            async ({ renderingURL, vectorAssetsURL, compiled }) => {
                const [
                    {
                        WebGLDevice: WEB_GL_DEVICE,
                        MeshRenderer: MESH_RENDERER,
                        YarnSurfaceRenderer: YARN_SURFACE_RENDERER,
                    },
                    { createVectorAsset: CREATE_VECTOR_ASSET },
                ] = await Promise.all([import(renderingURL), import(vectorAssetsURL)]);
                const DATA = {
                    ...compiled,
                    geometry: {
                        ...compiled.geometry,
                        vertices: Float32Array.from(compiled.geometry.vertices),
                        indices: Uint16Array.from(compiled.geometry.indices),
                        expressionIndices: Object.fromEntries(
                            Object.entries(compiled.geometry.expressionIndices ?? {}).map(([key, value]) => [
                                key,
                                Uint16Array.from(value),
                            ]),
                        ),
                        indexVariants: Object.fromEntries(
                            Object.entries(compiled.geometry.indexVariants ?? {}).map(([key, value]) => [
                                key,
                                Uint16Array.from(value),
                            ]),
                        ),
                        shaderSurfaces: compiled.geometry.shaderSurfaces?.map((surface) => ({
                            ...surface,
                            fillVertices: Float32Array.from(surface.fillVertices),
                            outline: Float32Array.from(surface.outline),
                            edgeColors: Float32Array.from(surface.edgeColors),
                        })),
                    },
                };
                const CANVAS = document.querySelector('canvas');
                const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                    alpha: true,
                    antialias: true,
                    depth: true,
                    stencil: true,
                    preserveDrawingBuffer: true,
                });
                const MESHES = new MESH_RENDERER(DEVICE),
                    SURFACES = new YARN_SURFACE_RENDERER(DEVICE),
                    ASSET = CREATE_VECTOR_ASSET(MESHES, DATA, {
                        surfaceRenderer: SURFACES,
                    });
                const FALLBACK_GEOMETRY = {
                    ...DATA.geometry,
                };
                delete FALLBACK_GEOMETRY.drawOrder;
                delete FALLBACK_GEOMETRY.shaderSurfaces;
                const FALLBACK_DATA = {
                    ...DATA,
                    geometry: FALLBACK_GEOMETRY,
                };
                const FALLBACK_ASSET = CREATE_VECTOR_ASSET(MESHES, FALLBACK_DATA),
                    FALLBACK_PLAYER = FALLBACK_ASSET.createPlayer({
                        clip: 'idle',
                        startedAtMs: 0,
                    });
                const MESH_UPLOADS_AT_CREATION = MESHES.stats().geometryUploads;
                const PLAYER = ASSET.createPlayer({
                    clip: 'idle',
                    startedAtMs: 0,
                });
                PLAYER.seek(50);
                const VP = Float32Array.of(2 / 240, 0, 0, 0, 0, -2 / 180, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1);
                const MODEL = (centerX, size, angle = 0.12) => {
                    const SX = size / 100,
                        SY = (size * 0.82) / 100,
                        C = Math.cos(angle),
                        S = Math.sin(angle);
                    const A = SX * C,
                        B = SX * S,
                        D = SY * C,
                        E = -SY * S;
                    return Float32Array.of(
                        A,
                        B,
                        0,
                        0,
                        E,
                        D,
                        0,
                        0,
                        0,
                        0,
                        1,
                        0,
                        centerX - 50 * A - 50 * E,
                        90 - 50 * B - 50 * D,
                        0,
                        1,
                    );
                };
                const CLIPS = [
                    [
                        {
                            x: 0,
                            y: 0,
                        },
                        {
                            x: 190,
                            y: 0,
                        },
                        {
                            x: 190,
                            y: 180,
                        },
                        {
                            x: 0,
                            y: 180,
                        },
                    ],
                ];
                const DRAW = () => {
                    DEVICE.beginFrame({
                        width: CANVAS.width,
                        height: CANVAS.height,
                        clearColor: [0, 0, 0, 0],
                    });
                    MESHES.beginFrame();
                    for (const [CENTER, SIZE] of [
                        [59, 47],
                        [172, 74],
                    ]) {
                        PLAYER.draw({
                            viewProjection: VP,
                            worldMatrix: MODEL(CENTER, SIZE),
                            clips: CLIPS,
                            depthTest: true,
                            depthWrite: false,
                        });
                    }
                    FALLBACK_PLAYER.draw({
                        viewProjection: VP,
                        worldMatrix: MODEL(26, 24),
                        color: [1, 0.6, 0.2, 1],
                        clips: CLIPS,
                        depthTest: true,
                        depthWrite: false,
                    });
                    MESHES.flush();
                    const PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
                    DEVICE.gl.readPixels(
                        0,
                        0,
                        CANVAS.width,
                        CANVAS.height,
                        DEVICE.gl.RGBA,
                        DEVICE.gl.UNSIGNED_BYTE,
                        PIXELS,
                    );
                    DEVICE.endFrame();
                    return PIXELS;
                };
                const PIXELS = DRAW();
                const ORDERED_DRAW_EVENTS = [],
                    EMPTY_EXCLUSIONS = new Set(),
                    EXCLUDED_BODY_PARTS = new Set(['body']),
                    ORIGINAL_EXCLUSION_DRAW_MESH = MESHES.drawMesh,
                    ORIGINAL_EXCLUSION_DRAW_SURFACE = SURFACES.drawSurface,
                    POSES_BEFORE_EXCLUSION = JSON.stringify(PLAYER.partPoses()),
                    EXPRESSION_BEFORE_EXCLUSION = PLAYER.currentExpression;
                MESHES.drawMesh = function (mesh, options) {
                    ORDERED_DRAW_EVENTS.push({
                        kind: 'mesh',
                        options,
                    });
                    return ORIGINAL_EXCLUSION_DRAW_MESH.call(this, mesh, options);
                };
                SURFACES.drawSurface = function (surface, options) {
                    ORDERED_DRAW_EVENTS.push({
                        kind: 'surface',
                        options,
                    });
                    return ORIGINAL_EXCLUSION_DRAW_SURFACE.call(this, surface, options);
                };
                DEVICE.beginFrame({
                    width: CANVAS.width,
                    height: CANVAS.height,
                    clearColor: [0, 0, 0, 0],
                });
                MESHES.beginFrame();
                PLAYER.draw({
                    viewProjection: VP,
                    worldMatrix: MODEL(59, 47),
                    clips: CLIPS,
                    alpha: 0.625,
                    depthTest: true,
                    depthWrite: false,
                    excludeParts: EMPTY_EXCLUSIONS,
                });
                MESHES.flush();
                const INCLUDED_DRAW_EVENTS = ORDERED_DRAW_EVENTS.slice(),
                    INCLUDED_MESH_DRAWS = MESHES.stats().draws,
                    INCLUDED_DRAW_ERROR = DEVICE.gl.getError();
                DEVICE.endFrame();
                const EXPECTED_DRAW_KINDS = DATA.geometry.drawOrder.map((command) =>
                        command.kind === 'mesh' ? 'mesh' : 'surface',
                    ),
                    EXPECTED_MESH_RANGES = DATA.geometry.drawOrder
                        .filter((command) => command.kind === 'mesh')
                        .map((command) => [command.firstIndex, command.indexCount]),
                    INCLUDED_MESH_OPTIONS = INCLUDED_DRAW_EVENTS.filter((event) => event.kind === 'mesh').map(
                        (event) => event.options,
                    ),
                    INCLUDED_SURFACE_OPTIONS = INCLUDED_DRAW_EVENTS.filter((event) => event.kind === 'surface').map(
                        (event) => event.options,
                    );
                const ORDERED_DRAW_COMPATIBLE =
                    JSON.stringify(INCLUDED_DRAW_EVENTS.map((event) => event.kind)) ===
                        JSON.stringify(EXPECTED_DRAW_KINDS) &&
                    JSON.stringify(INCLUDED_MESH_OPTIONS.map((options) => options.indexRange)) ===
                        JSON.stringify(EXPECTED_MESH_RANGES) &&
                    INCLUDED_MESH_DRAWS === EXPECTED_MESH_RANGES.length &&
                    INCLUDED_MESH_OPTIONS.every((options) => options.alpha === 0.625 && options.clips === CLIPS) &&
                    INCLUDED_SURFACE_OPTIONS.every((options) => options.alpha === 0.625 && options.clips === CLIPS) &&
                    INCLUDED_DRAW_ERROR === 0;
                ORDERED_DRAW_EVENTS.length = 0;
                DEVICE.beginFrame({
                    width: CANVAS.width,
                    height: CANVAS.height,
                    clearColor: [0, 0, 0, 0],
                });
                MESHES.beginFrame();
                PLAYER.draw({
                    viewProjection: VP,
                    worldMatrix: MODEL(59, 47),
                    clips: CLIPS,
                    excludeParts: EXCLUDED_BODY_PARTS,
                });
                MESHES.flush();
                const EXCLUDED_BODY_DRAW_SUPPRESSED = ORDERED_DRAW_EVENTS.length === 0;
                DEVICE.endFrame();
                ORDERED_DRAW_EVENTS.length = 0;
                DEVICE.beginFrame({
                    width: CANVAS.width,
                    height: CANVAS.height,
                    clearColor: [0, 0, 0, 0],
                });
                MESHES.beginFrame();
                let invalidExcludeError = null,
                    invalidExcludeTypeError = null;
                try {
                    PLAYER.draw({
                        viewProjection: VP,
                        worldMatrix: MODEL(59, 47),
                        clips: CLIPS,
                        excludeParts: new Set(['unknown-part']),
                    });
                } catch (error) {
                    invalidExcludeError = error;
                }
                try {
                    PLAYER.draw({
                        viewProjection: VP,
                        worldMatrix: MODEL(59, 47),
                        clips: CLIPS,
                        excludeParts: ['body'],
                    });
                } catch (error) {
                    invalidExcludeTypeError = error;
                }
                MESHES.flush();
                const INVALID_EXCLUSION_PREFLIGHT =
                    invalidExcludeError instanceof TypeError &&
                    invalidExcludeTypeError instanceof TypeError &&
                    ORDERED_DRAW_EVENTS.length === 0;
                DEVICE.endFrame();
                ORDERED_DRAW_EVENTS.length = 0;
                const CLIP_TRIANGLE_COUNT = Math.ceil((SURFACES.stats().maxClipPlanes + 1) / 3);
                const OVERFLOW_CLIPS = Array.from(
                    {
                        length: CLIP_TRIANGLE_COUNT,
                    },
                    (_, index) => {
                        const X = index * 6;
                        return [
                            {
                                x: X,
                                y: 0,
                            },
                            {
                                x: X + 4,
                                y: 0,
                            },
                            {
                                x: X + 2,
                                y: 4,
                            },
                        ];
                    },
                );
                DEVICE.beginFrame({
                    width: CANVAS.width,
                    height: CANVAS.height,
                    clearColor: [0, 0, 0, 0],
                });
                MESHES.beginFrame();
                const CLIP_LIMIT_BEFORE = MESHES.stats().draws;
                let clipLimitError = '';
                try {
                    PLAYER.draw({
                        viewProjection: VP,
                        worldMatrix: MODEL(59, 47),
                        clips: OVERFLOW_CLIPS,
                        excludeParts: EMPTY_EXCLUSIONS,
                    });
                } catch (error) {
                    clipLimitError = error.message;
                }
                MESHES.flush();
                const CLIP_LIMIT_PREFLIGHT =
                    /shader surface limit/.test(clipLimitError) &&
                    MESHES.stats().draws === CLIP_LIMIT_BEFORE &&
                    ORDERED_DRAW_EVENTS.length === 0;
                DEVICE.endFrame();
                SURFACES.drawSurface = ORIGINAL_EXCLUSION_DRAW_SURFACE;
                MESHES.drawMesh = ORIGINAL_EXCLUSION_DRAW_MESH;
                const EXCLUSION_STATE_PRESERVED =
                    JSON.stringify(PLAYER.partPoses()) === POSES_BEFORE_EXCLUSION &&
                    PLAYER.currentExpression === EXPRESSION_BEFORE_EXCLUSION;
                DEVICE.beginFrame({
                    width: CANVAS.width,
                    height: CANVAS.height,
                    clearColor: [0, 0, 0, 0],
                });
                MESHES.beginFrame();
                const DEPTH_PARTS = PLAYER.partPoses().map(({ transform, morph, opacity, visible }) => ({
                    transform,
                    morph,
                    opacity,
                    visible,
                }));
                MESHES.drawMesh(ASSET.mesh, {
                    viewProjection: VP,
                    worldMatrix: MODEL(26, 24),
                    parts: DEPTH_PARTS,
                    color: [0, 0, 1, 1],
                    forceColor: true,
                    depth: -0.5,
                    depthTest: true,
                    depthWrite: true,
                });
                MESHES.drawMesh(ASSET.mesh, {
                    viewProjection: VP,
                    worldMatrix: MODEL(26, 24),
                    parts: DEPTH_PARTS,
                    color: [1, 0, 0, 1],
                    forceColor: true,
                    depth: 0.5,
                    depthTest: true,
                    depthWrite: true,
                });
                MESHES.flush();
                const DEPTH_PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
                DEVICE.gl.readPixels(
                    0,
                    0,
                    CANVAS.width,
                    CANVAS.height,
                    DEVICE.gl.RGBA,
                    DEVICE.gl.UNSIGNED_BYTE,
                    DEPTH_PIXELS,
                );
                DEVICE.endFrame();
                const DEPTH_AT = ((CANVAS.height - 1 - 90) * CANVAS.width + 26) * 4,
                    DEPTH_PIXEL = Array.from(DEPTH_PIXELS.subarray(DEPTH_AT, DEPTH_AT + 4));
                const SAMPLE = (x, y) => {
                    const AT = ((CANVAS.height - 1 - Math.floor(y)) * CANVAS.width + Math.floor(x)) * 4;
                    return Array.from(PIXELS.subarray(AT, AT + 4));
                };
                const SCREEN = (center, size, localX, localY, angle = 0.12) => {
                    const SX = size / 100,
                        SY = (size * 0.82) / 100,
                        C = Math.cos(angle),
                        S = Math.sin(angle);
                    const A = SX * C,
                        B = SX * S,
                        E = -SY * S,
                        D = SY * C;
                    const WORLD_X = A * localX + E * localY + center - 50 * A - 50 * E;
                    const WORLD_Y = B * localX + D * localY + 90 - 50 * B - 50 * D;
                    return {
                        x: WORLD_X,
                        y: WORLD_Y,
                    };
                };
                const BOUNDS = (left, right) => {
                    let minX = Infinity;
                    let minY = Infinity;
                    let maxX = -Infinity;
                    let maxY = -Infinity;
                    let count = 0;
                    for (let y = 0; y < CANVAS.height; y++) {
                        for (let x = left; x < right; x++) {
                            const ALPHA = PIXELS[(y * CANVAS.width + x) * 4 + 3];
                            if (!ALPHA) {
                                continue;
                            }
                            minX = Math.min(minX, x);
                            maxX = Math.max(maxX, x);
                            minY = Math.min(minY, y);
                            maxY = Math.max(maxY, y);
                            count++;
                        }
                    }
                    return {
                        width: maxX - minX + 1,
                        height: maxY - minY + 1,
                        count,
                    };
                };
                const SAMPLE_AT = (center, size, x, y) => {
                    const POINT = SCREEN(center, size, x, y);
                    return SAMPLE(POINT.x, POINT.y);
                };
                const SMALL_BOUNDS = BOUNDS(39, 90),
                    LARGE_BOUNDS = BOUNDS(130, 215);
                const UNDER = SAMPLE_AT(59, 47, 12, 12),
                    CLOTH = SAMPLE_AT(59, 47, 25, 25),
                    OVER = SAMPLE_AT(59, 47, 50, 50),
                    CLIPPED = SAMPLE_AT(172, 74, 90, 50),
                    FALLBACK_WORLD_DRAW = SAMPLE_AT(26, 24, 50, 50);
                const CLOTH_COLORS = new Set();
                for (let y = 0; y < CANVAS.height; y++) {
                    for (let x = 0; x < CANVAS.width; x++) {
                        const AT = (y * CANVAS.width + x) * 4,
                            ALPHA = PIXELS[AT + 3];
                        if (ALPHA && x >= 48 && x <= 70 && y >= 72 && y <= 100) {
                            CLOTH_COLORS.add(PIXELS.subarray(AT, AT + 3).join(','));
                        }
                    }
                }
                const STATE = {
                    smallBounds: SMALL_BOUNDS,
                    largeBounds: LARGE_BOUNDS,
                    under: UNDER,
                    cloth: CLOTH,
                    over: OVER,
                    clipped: CLIPPED,
                    fallbackWorldDraw: FALLBACK_WORLD_DRAW,
                    depthPixel: DEPTH_PIXEL,
                    yarnColorCount: CLOTH_COLORS.size,
                    orderedDrawCompatible: ORDERED_DRAW_COMPATIBLE,
                    excludedBodyDrawSuppressed: EXCLUDED_BODY_DRAW_SUPPRESSED,
                    invalidExclusionPreflight: INVALID_EXCLUSION_PREFLIGHT,
                    exclusionStatePreserved: EXCLUSION_STATE_PRESERVED,
                    clipLimitPreflight: CLIP_LIMIT_PREFLIGHT,
                    meshDraws: MESHES.stats().draws,
                    meshUploadsAtCreation: MESH_UPLOADS_AT_CREATION,
                    meshUploadsAfterFrame: MESHES.stats().geometryUploads,
                    surfaceCount: SURFACES.stats().surfaceCount,
                    retainedSurfaceBytes: SURFACES.stats().retainedBytes,
                    glError: DEVICE.gl.getError(),
                };
                const LOSE = DEVICE.gl.getExtension('WEBGL_lose_context');
                if (LOSE) {
                    const WAIT_FOR = (expected) =>
                        new Promise((resolve, reject) => {
                            const END = performance.now() + 8000;
                            const POLL = () => {
                                if (MESHES.stats().state === expected && SURFACES.stats().state === expected) {
                                    return resolve();
                                }
                                if (
                                    MESHES.stats().state === 'failed' ||
                                    SURFACES.stats().state === 'failed' ||
                                    performance.now() > END
                                ) {
                                    return reject(new Error('WebGL retained SVG context ' + expected + ' failed'));
                                }
                                requestAnimationFrame(POLL);
                            };
                            POLL();
                        });
                    LOSE.loseContext();
                    await WAIT_FOR('lost');
                    LOSE.restoreContext();
                    await WAIT_FOR('ready');
                    const RESTORED = DRAW();
                    STATE.restoredPixel = Array.from(
                        RESTORED.subarray(
                            ((CANVAS.height - 1 - 90) * CANVAS.width + 172) * 4,
                            ((CANVAS.height - 1 - 90) * CANVAS.width + 172) * 4 + 4,
                        ),
                    );
                }
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                window.__worldVectorTest = {
                    dispose() {
                        ASSET.dispose();
                        FALLBACK_ASSET.dispose();
                        const MESH_COUNT = MESHES.stats().meshCount,
                            RETAINED_SURFACES = SURFACES.stats().surfaceCount;
                        SURFACES.dispose();
                        MESHES.dispose();
                        DEVICE.dispose();
                        return {
                            meshCount: MESH_COUNT,
                            retainedSurfaces: RETAINED_SURFACES,
                        };
                    },
                };
                return STATE;
            },
            {
                renderingURL,
                vectorAssetsURL,
                compiled,
            },
        );
        assert.ok(
            RESULT.smallBounds.count > 200 && RESULT.largeBounds.count > 600,
            'both retained SVG actors cover real WebGL pixels',
        );
        assert.ok(
            RESULT.largeBounds.height / RESULT.smallBounds.height > 1.4 &&
                RESULT.largeBounds.height / RESULT.smallBounds.height < 1.75,
            'unclipped vertical extent scales proportionally; the large actor is deliberately clipped horizontally: ' +
                JSON.stringify({
                    small: RESULT.smallBounds,
                    large: RESULT.largeBounds,
                }),
        );
        assert.ok(
            RESULT.under[2] > RESULT.under[0] && RESULT.under[3] > 240,
            'pre-surface SVG geometry paints beneath the shader surface',
        );
        assert.ok(
            RESULT.cloth[3] > 240 && RESULT.yarnColorCount > 4,
            'the retained yarn material produces filled, non-solid shader pixels',
        );
        assert.ok(
            RESULT.orderedDrawCompatible &&
                RESULT.excludedBodyDrawSuppressed &&
                RESULT.invalidExclusionPreflight &&
                RESULT.exclusionStatePreserved,
            'call-scoped part exclusions preserve painter ranges, alpha/clips, shader surfaces, and player state',
        );
        assert.ok(
            RESULT.over[1] > RESULT.over[0] && RESULT.over[3] > 240,
            'post-surface SVG geometry paints above the shader surface',
        );
        assert.equal(RESULT.clipped[3], 0, 'one shared world-space clip follows both differently transformed actors');
        assert.ok(RESULT.fallbackWorldDraw[3] > 0, 'assets without draw-order metadata accept 3D world transforms');
        assert.ok(
            RESULT.depthPixel[2] > RESULT.depthPixel[0] * 2,
            'depth testing keeps the nearer world-space mesh when a farther draw is submitted later',
        );
        assert.equal(
            RESULT.clipLimitPreflight,
            true,
            'shared clip capacity is rejected before any painter-order geometry is submitted',
        );
        assert.equal(RESULT.glError, 0, 'WebGL reports no error after the mixed 3D painter-order draw');
        assert.equal(RESULT.surfaceCount, 1, 'the shader surface is retained once for both actors');
        assert.ok(RESULT.restoredPixel?.[3] > 0, 'the retained SVG mesh and surface redraw after context restoration');
        if (ERRORS.length) {
            throw new Error('3D vector browser page errors: ' + ERRORS.join('; '));
        }
        await PAGE.screenshot({
            path: screenshotPath,
            fullPage: true,
        });
        const DISPOSED = await PAGE.evaluate(() => window.__worldVectorTest.dispose());
        assert.deepEqual(
            DISPOSED,
            {
                meshCount: 0,
                retainedSurfaces: 0,
            },
            'asset disposal releases its mesh and shader surface',
        );
        return {
            ...RESULT,
            disposed: DISPOSED,
            evidencePath: screenshotPath,
        };
    } finally {
        await PAGE.close();
    }
}

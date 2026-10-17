/* global vectorAssetDemo */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compileVectorAssetFile } from '../compiler.js';

/** Exercises the compiled SVG through GameKit's real WebGL1 device and retained mesh renderer. */
export async function exerciseVectorAssets(page, { includePopulationTimingDiagnostics = false } = {}) {
    const COMPILE_START = performance.now();
    const REFERENCE_ASSET = await compileVectorAssetFile(
        'modules/vector-assets/assets/seed-scout.svg',
        'modules/vector-assets/assets/seed-scout.svg',
    );
    const LEGACY_REFERENCE_ASSET = await compileVectorAssetFile(
        'modules/vector-assets/assets/seed-scout.svg',
        'modules/vector-assets/assets/seed-scout.svg',
        {
            curveSegments: 16,
            strokeArcDivisions: 12,
        },
    );
    const RETAINED_BYTES = (asset) =>
        asset.geometry.vertices.byteLength +
        asset.geometry.indices.byteLength +
        [
            ...Object.values(asset.geometry.expressionIndices ?? {}),
            ...Object.values(asset.geometry.indexVariants ?? {}),
        ].reduce((total, indices) => total + indices.byteLength, 0);
    const STANDARD_MESH_BYTES = RETAINED_BYTES(REFERENCE_ASSET),
        LEGACY_MESH_BYTES = RETAINED_BYTES(LEGACY_REFERENCE_ASSET);
    assert.ok(
        STANDARD_MESH_BYTES > 0 && STANDARD_MESH_BYTES < LEGACY_MESH_BYTES,
        'the same seed-scout fixture produces valid 4/2 geometry smaller than explicit 16/12 geometry',
    );
    const THREE_COMPILE_MS = performance.now() - COMPILE_START;
    await page.setViewportSize({
        width: 844,
        height: 390,
    });
    const PANEL_STATE = await page.evaluate(async () => {
        const WAIT_FRAME = () => new Promise((resolve) => requestAnimationFrame(resolve));
        await WAIT_FRAME();
        await WAIT_FRAME();
        const DEMO = window.vectorAssetDemo;
        const FAIL = (message) => {
            throw new Error('Three-view example: ' + message);
        };
        if (!DEMO?.ready || !DEMO.asset || !DEMO.actor) {
            FAIL('SVG source and WebGL resources did not finish loading');
        }
        const SUBMITTED_VARIANTS = [];
        const DRAW_MESH = DEMO.meshes.drawMesh.bind(DEMO.meshes);
        DEMO.meshes.drawMesh = (mesh, options) => {
            SUBMITTED_VARIANTS.push(options?.indexVariant ?? null);
            return DRAW_MESH(mesh, options);
        };
        const CLIP = document.querySelector('#clip'),
            TIME = document.querySelector('#time');
        const EXPRESSION = document.querySelector('#expression'),
            ZOOM = document.querySelector('#zoom');
        CLIP.value = 'bounce';
        CLIP.dispatchEvent(
            new Event('change', {
                bubbles: true,
            }),
        );
        TIME.value = '220';
        TIME.dispatchEvent(
            new Event('input', {
                bubbles: true,
            }),
        );
        EXPRESSION.value = 'happy';
        EXPRESSION.dispatchEvent(
            new Event('change', {
                bubbles: true,
            }),
        );
        ZOOM.value = '1.50';
        ZOOM.dispatchEvent(
            new Event('input', {
                bubbles: true,
            }),
        );
        document.querySelector('#play-toggle').click();
        await WAIT_FRAME();
        await WAIT_FRAME();
        const EXPRESSION_INDEX_VARIANT_USED = SUBMITTED_VARIANTS.includes('happy');
        DEMO.actor.setPartVisible('face-happy', false);
        await WAIT_FRAME();
        const EXPLICIT_VISIBILITY_USES_FULL_GEOMETRY = SUBMITTED_VARIANTS.at(-1) === null;
        DEMO.actor.setExpression('happy');
        await WAIT_FRAME();
        const EXPRESSION_VARIANT_RESTORED_AFTER_OVERRIDE = SUBMITTED_VARIANTS.at(-1) === 'happy';
        const BODY = DEMO.actor.getPartPose('body');
        const SOURCE_BODY = DEMO.sourceSvg.querySelector('[data-vector-part="body"]').getAttribute('transform');
        const SOURCE_MATRIX = SOURCE_BODY.slice(7, -1).split(/[ ,]+/).map(Number);
        const STAGES = [...document.querySelectorAll('.stage')].map((stage) => {
            const RECT = stage.getBoundingClientRect();
            return {
                width: RECT.width,
                height: RECT.height,
            };
        });
        const RESULT = {
            ready: DEMO.ready,
            clip: DEMO.actor.currentClip,
            timeMs: DEMO.actor.currentTimeMs,
            expression: DEMO.actor.currentExpression,
            zoom: DEMO.camera.zoom,
            sourceSha256: DEMO.sourceSvg ? DEMO.asset.sourceSha256 : '',
            sourceBodyPoseMatches:
                SOURCE_MATRIX.length === 6 &&
                SOURCE_MATRIX.every((value, index) => Math.abs(value - BODY.transform[index]) <= 0.006),
            happyShown: DEMO.sourceSvg.querySelector('[data-vector-part="face-happy"]').style.display !== 'none',
            neutralHidden: DEMO.sourceSvg.querySelector('[data-vector-part="face-neutral"]').style.display === 'none',
            expressionIndexVariantUsed: EXPRESSION_INDEX_VARIANT_USED,
            explicitVisibilityUsesFullGeometry: EXPLICIT_VISIBILITY_USES_FULL_GEOMETRY,
            expressionVariantRestoredAfterOverride: EXPRESSION_VARIANT_RESTORED_AFTER_OVERRIDE,
            triangles: DEMO.topology.triangles,
            compiledTriangles: DEMO.asset.mesh.indices.length / 3,
            visibleTriangles: DEMO.lastFrame.topology.visibleTriangles,
            uniqueEdges: DEMO.topology.uniqueEdges,
            webglBackend: DEMO.device.instancingSupported
                ? 'WebGL 1 + ANGLE instancing'
                : 'WebGL 1 + per-draw uniforms',
            drawCalls: DEMO.lastFrame.gamekit.device.drawCalls,
            meshBytes: DEMO.asset.mesh.byteLength,
            sourceMetrics: document.querySelector('#source-metrics').textContent,
            topologyMetrics: document.querySelector('#topology-metrics').textContent,
            gamekitMetrics: document.querySelector('#gamekit-metrics').textContent,
            stages: STAGES,
            sourceViewBox: DEMO.sourceSvg.getAttribute('viewBox'),
            viewport: [innerWidth, innerHeight],
            bodyHeight: document.body.getBoundingClientRect().height,
            mainHeight: document.querySelector('main').getBoundingClientRect().height,
        };
        CLIP.value = 'idle';
        CLIP.dispatchEvent(
            new Event('change', {
                bubbles: true,
            }),
        );
        EXPRESSION.value = 'neutral';
        EXPRESSION.dispatchEvent(
            new Event('change', {
                bubbles: true,
            }),
        );
        ZOOM.value = '1.00';
        ZOOM.dispatchEvent(
            new Event('input', {
                bubbles: true,
            }),
        );
        document.querySelector('#center-camera').click();
        TIME.value = '0';
        TIME.dispatchEvent(
            new Event('input', {
                bubbles: true,
            }),
        );
        document.querySelector('#play-toggle').click();
        await WAIT_FRAME();
        await WAIT_FRAME();
        return RESULT;
    });
    assert.equal(PANEL_STATE.ready, true);
    assert.equal(PANEL_STATE.clip, 'bounce');
    assert.equal(PANEL_STATE.timeMs, 220, 'shared absolute time is applied to the GameKit player');
    assert.equal(PANEL_STATE.expression, 'happy');
    assert.equal(PANEL_STATE.zoom, 1.5);
    assert.match(PANEL_STATE.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(PANEL_STATE.sourceBodyPoseMatches, true, 'the source SVG view uses the same authored part pose');
    assert.equal(PANEL_STATE.happyShown, true);
    assert.equal(PANEL_STATE.neutralHidden, true);
    assert.equal(
        PANEL_STATE.expressionIndexVariantUsed,
        true,
        'authored expressions select their prefiltered retained triangle indices',
    );
    assert.equal(
        PANEL_STATE.explicitVisibilityUsesFullGeometry,
        true,
        'explicit per-part visibility keeps the unfiltered geometry path',
    );
    assert.equal(
        PANEL_STATE.expressionVariantRestoredAfterOverride,
        true,
        'selecting a new expression restores the matching index variant',
    );
    assert.equal(PANEL_STATE.triangles, PANEL_STATE.compiledTriangles);
    assert.ok(PANEL_STATE.visibleTriangles > 0 && PANEL_STATE.visibleTriangles < PANEL_STATE.triangles);
    assert.ok(PANEL_STATE.uniqueEdges > PANEL_STATE.triangles);
    assert.match(PANEL_STATE.webglBackend, /^WebGL 1/);
    assert.ok(
        PANEL_STATE.drawCalls > 0 &&
            PANEL_STATE.meshBytes === STANDARD_MESH_BYTES &&
            PANEL_STATE.meshBytes < LEGACY_MESH_BYTES,
        'the three-view example retains the same valid 4/2 geometry measured from its source',
    );
    assert.match(PANEL_STATE.sourceMetrics, /source bytes/);
    assert.match(PANEL_STATE.topologyMetrics, /visible triangles/);
    assert.match(PANEL_STATE.gamekitMetrics, /draw calls/);
    assert.ok(
        Math.min(...PANEL_STATE.stages.map((stage) => stage.width)) > 200,
        'all three panels remain readable at mobile landscape width',
    );
    assert.ok(
        Math.min(...PANEL_STATE.stages.map((stage) => stage.height)) > 100,
        'all three panels remain visible at mobile landscape height',
    );
    assert.ok(
        Math.max(...PANEL_STATE.stages.map((stage) => stage.height)) < 260,
        'three panels fit the mobile landscape viewport without vertical overflow',
    );
    assert.ok(
        Math.max(...PANEL_STATE.stages.map((stage) => stage.height)) -
            Math.min(...PANEL_STATE.stages.map((stage) => stage.height)) <
            1.5,
        'the three camera viewports have matching dimensions',
    );
    const PAN_STAGE = page.locator('#source-stage'),
        BOX = await PAN_STAGE.boundingBox();
    await page.mouse.move(BOX.x + BOX.width / 2, BOX.y + BOX.height / 2);
    await page.mouse.down();
    await page.mouse.move(BOX.x + BOX.width / 2 + 6, BOX.y + BOX.height / 2 + 4);
    await page.mouse.up();
    const MOVED_CAMERA = await page.evaluate(() => ({
        x: vectorAssetDemo.camera.x,
        y: vectorAssetDemo.camera.y,
    }));
    assert.notEqual(MOVED_CAMERA.x, 100, 'dragging one panel pans the shared camera');
    assert.notEqual(MOVED_CAMERA.y, 110, 'vertical pan is shared');
    await page.locator('#center-camera').click();
    const CENTERED_CAMERA = await page.evaluate(() => ({
        x: vectorAssetDemo.camera.x,
        y: vectorAssetDemo.camera.y,
    }));
    assert.deepEqual(
        CENTERED_CAMERA,
        {
            x: 100,
            y: 110,
        },
        'center resets the shared camera',
    );
    const REPORT = await page.evaluate(
        async ({
            sourcePaths,
            threeCompileMs,
            includePopulationTimingDiagnostics,
            standardMeshBytes,
            legacyMeshBytes,
        }) => {
            const MODULES = window.vectorAssetRuntime ?? {
                ...(await import('/dist/rendering.js')),
                ...(await import('/dist/vector-assets.js')),
            };
            const {
                WebGLDevice: WEB_GL_DEVICE,
                MeshRenderer: MESH_RENDERER,
                VectorContext: VECTOR_CONTEXT,
                createSeedScout: CREATE_SEED_SCOUT,
                seedScoutMetadata: SEED_SCOUT_METADATA,
            } = MODULES;
            const ASSERT_THAT = (condition, message) => {
                if (!condition) {
                    throw new Error(message);
                }
            };
            const NEAR = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;
            const BEGIN_GPU_QUERY = (device) => {
                const EXTENSION = device.gl.getExtension('EXT_disjoint_timer_query');
                if (!EXTENSION) {
                    return null;
                }
                const QUERY = EXTENSION.createQueryEXT();
                EXTENSION.beginQueryEXT(EXTENSION.TIME_ELAPSED_EXT, QUERY);
                return {
                    extension: EXTENSION,
                    query: QUERY,
                };
            };
            const END_GPU_QUERY = (device, record) => {
                if (!record) {
                    return {
                        elapsedNs: null,
                        status: 'unsupported',
                    };
                }
                const { extension: EXTENSION, query: QUERY } = record;
                EXTENSION.endQueryEXT(EXTENSION.TIME_ELAPSED_EXT);
                device.gl.finish();
                const READY = EXTENSION.getQueryObjectEXT(QUERY, EXTENSION.QUERY_RESULT_AVAILABLE_EXT);
                const DISJOINT = device.gl.getParameter(EXTENSION.GPU_DISJOINT_EXT);
                const ELAPSED_NS =
                    READY && !DISJOINT ? EXTENSION.getQueryObjectEXT(QUERY, EXTENSION.QUERY_RESULT_EXT) : null;
                EXTENSION.deleteQueryEXT(QUERY);
                return {
                    elapsedNs: ELAPSED_NS,
                    status: !READY ? 'unavailable' : DISJOINT ? 'disjoint' : 'measured',
                };
            };
            const CANVAS = document.createElement('canvas');
            CANVAS.width = 200;
            CANVAS.height = 220;
            CANVAS.style.cssText = 'width: 200px; height: 220px';
            document.body.append(CANVAS);
            const RENDERER_INIT_START = performance.now();
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: false,
                preserveDrawingBuffer: true,
                checkGLErrors: true,
            });
            const MESHES = new MESH_RENDERER(DEVICE, {
                maxMeshes: 4,
                maxInstances: 1024,
            });
            const RENDERER_INITIALIZATION_MS = performance.now() - RENDERER_INIT_START;
            const COLD_START = performance.now(),
                ASSET = CREATE_SEED_SCOUT(MESHES),
                INITIALIZATION_MS = performance.now() - COLD_START;
            const RESOURCE_CREATION_STATS = MESHES.stats();
            const PLAYER = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            const STATIC_PART_POSES = PLAYER.partPoses();
            ASSERT_THAT(
                STATIC_PART_POSES.every(
                    (pose) =>
                        Array.isArray(pose.morph) &&
                        pose.morph.length === 2 &&
                        pose.morph[0] === 0 &&
                        pose.morph[1] === 0,
                ),
                'styleless assets preserve the public two-weight part pose with default zero morph values',
            );
            ASSERT_THAT(
                STATIC_PART_POSES.every((pose, index) => index === 0 || pose.morph !== STATIC_PART_POSES[0].morph) &&
                    !Object.isFrozen(STATIC_PART_POSES[0].morph),
                'public styleless part poses keep independent mutable zero-morph tuples',
            );
            const DETACHED_BODY = PLAYER.getPartPose('body'),
                ORIGINAL_BODY_TRANSFORM = PLAYER.getPartPose('body').transform;
            DETACHED_BODY.transform[0] += 1000;
            const DETACHED_PART_POSES = PLAYER.partPoses();
            DETACHED_PART_POSES[0].transform[0] += 1000;
            DETACHED_PART_POSES[0].morph[0] = 1000;
            ASSERT_THAT(
                PLAYER.getPartPose('body').transform.every(
                    (value, index) => value === ORIGINAL_BODY_TRANSFORM[index],
                ) && PLAYER.partPoses()[0].morph[0] === 0,
                'mutating returned part poses cannot corrupt the player-local resolved-pose cache',
            );
            const BASE_POSE_BEFORE = PLAYER.getPartPose('body').transform;
            PLAYER.setBasePose('body', {
                x: 10,
            });
            const BASE_POSE_AFTER = PLAYER.getPartPose('body').transform;
            PLAYER.setBasePose('body', {
                x: 0,
            });
            ASSERT_THAT(
                JSON.stringify(BASE_POSE_BEFORE) !== JSON.stringify(BASE_POSE_AFTER),
                'base-pose revision invalidates cached world transforms',
            );
            const PROJECTION = [2 / 200, 0, 0, 0, -2 / 220, 0, -1, 1, 1];
            const PAINT = (actors = [PLAYER], timeMs = 0) => {
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.875, 0.91, 0.8, 1],
                    clearDepth: 1,
                    clearStencil: 0,
                });
                MESHES.beginFrame();
                for (const ACTOR of actors) {
                    ACTOR.seek(timeMs);
                    ACTOR.draw({
                        projection: PROJECTION,
                    });
                }
                MESHES.flush();
                DEVICE.endFrame();
                return {
                    mesh: MESHES.stats(),
                    device: {
                        ...DEVICE.stats,
                    },
                    glError: DEVICE.gl.getError(),
                };
            };
            const PIXEL = (x, y) => {
                const DATA = new Uint8Array(4);
                DEVICE.gl.readPixels(x, 219 - y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, DATA);
                return [...DATA];
            };
            const ORIGINAL_DRAW_MESH = MESHES.drawMesh;
            let submittedParts;
            let submittedMorph;
            MESHES.drawMesh = function (mesh, options) {
                submittedParts = options.parts;
                submittedMorph = options.morph;
                return ORIGINAL_DRAW_MESH.call(this, mesh, options);
            };
            const INITIAL_FRAME = PAINT();
            MESHES.drawMesh = ORIGINAL_DRAW_MESH;
            ASSERT_THAT(
                submittedParts?.every((pose) => !Object.hasOwn(pose, 'morph')) &&
                    Array.isArray(submittedMorph) &&
                    submittedMorph[0] === 0 &&
                    submittedMorph[1] === 0,
                'render-only part poses omit discarded per-part morph arrays and retain the draw-level morph value',
            );
            console.log('VECTOR_STAGE initial-frame');
            const BODY_PIXEL = PIXEL(100, 112),
                HOLE_PIXEL = PIXEL(80, 48),
                BACKGROUND = [223, 232, 204, 255];
            ASSERT_THAT(
                BODY_PIXEL[1] > 100 && BODY_PIXEL[0] < BACKGROUND[0] && BODY_PIXEL[0] > 60,
                `SVG body color reaches WebGL pixels: ${BODY_PIXEL}`,
            );
            const ORIGINAL_EXPRESSION = PLAYER.currentExpression;
            PLAYER.setExpression('happy');
            const EXCLUDED_FACE_PARTS = new Set(['face-neutral', 'face-happy', 'face-surprised']),
                OUTLINE_CLIPS = [
                    [
                        { x: 0, y: 0 },
                        { x: 200, y: 0 },
                        { x: 200, y: 220 },
                        { x: 0, y: 220 },
                    ],
                ],
                FULL_DRAW_OPTIONS = {
                    alpha: 0.65,
                    clips: OUTLINE_CLIPS,
                },
                OUTLINE_DRAW_OPTIONS = {
                    ...FULL_DRAW_OPTIONS,
                    excludeParts: EXCLUDED_FACE_PARTS,
                },
                SUBMITTED_EXCLUSION_OPTIONS = [],
                ORIGINAL_EXCLUSION_DRAW_MESH = MESHES.drawMesh,
                POSES_BEFORE_EXCLUSION = JSON.stringify(PLAYER.partPoses()),
                BODY_TRANSFORM_BEFORE_EXCLUSION = PLAYER.getPartPose('body').transform;
            const CAPTURE_PLAYER_DRAW = (options) => {
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.875, 0.91, 0.8, 1],
                    clearDepth: 1,
                    clearStencil: 0,
                });
                MESHES.beginFrame();
                PLAYER.seek(0);
                PLAYER.draw({
                    projection: PROJECTION,
                    ...options,
                });
                MESHES.flush();
                const PIXELS = new Uint8Array(200 * 220 * 4);
                DEVICE.gl.readPixels(0, 0, 200, 220, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                const FRAME = {
                    pixels: PIXELS,
                    mesh: MESHES.stats(),
                    glError: DEVICE.gl.getError(),
                };
                DEVICE.endFrame();
                return FRAME;
            };
            MESHES.drawMesh = function (mesh, options) {
                SUBMITTED_EXCLUSION_OPTIONS.push(options);
                return ORIGINAL_EXCLUSION_DRAW_MESH.call(this, mesh, options);
            };
            const FULL_FACE_DRAW = CAPTURE_PLAYER_DRAW(FULL_DRAW_OPTIONS),
                OUTLINE_FACE_DRAW = CAPTURE_PLAYER_DRAW(OUTLINE_DRAW_OPTIONS),
                REPEATED_OUTLINE_FACE_DRAW = CAPTURE_PLAYER_DRAW(OUTLINE_DRAW_OPTIONS);
            const BATCH_OPTIONS_START = SUBMITTED_EXCLUSION_OPTIONS.length;
            DEVICE.beginFrame({
                width: 200,
                height: 220,
                clearColor: [0.875, 0.91, 0.8, 1],
                clearDepth: 1,
                clearStencil: 0,
            });
            MESHES.beginFrame();
            PLAYER.draw({
                projection: PROJECTION,
                ...OUTLINE_DRAW_OPTIONS,
            });
            PLAYER.draw({
                projection: PROJECTION,
                ...OUTLINE_DRAW_OPTIONS,
            });
            PLAYER.draw({
                projection: PROJECTION,
                ...FULL_DRAW_OPTIONS,
            });
            MESHES.flush();
            const EXCLUSION_BATCH_STATS = MESHES.stats(),
                BATCH_EXCLUSION_OPTIONS = SUBMITTED_EXCLUSION_OPTIONS.slice(BATCH_OPTIONS_START);
            DEVICE.endFrame();
            MESHES.drawMesh = ORIGINAL_EXCLUSION_DRAW_MESH;
            const BODY_PART_INDEX = SEED_SCOUT_METADATA.parts.findIndex((part) => part.id === 'body'),
                FACE_PART_INDICES = SEED_SCOUT_METADATA.parts
                    .map((part, index) => (EXCLUDED_FACE_PARTS.has(part.id) ? index : -1))
                    .filter((index) => index >= 0),
                PIXEL_AT = (pixels, x, y) => {
                    const OFFSET = ((219 - y) * 200 + x) * 4;
                    return [...pixels.subarray(OFFSET, OFFSET + 4)];
                },
                FULL_FACE_PARTS = SUBMITTED_EXCLUSION_OPTIONS[0].parts,
                OUTLINE_FACE_PARTS = SUBMITTED_EXCLUSION_OPTIONS[1].parts,
                BATCH_FULL_FACE_PARTS = BATCH_EXCLUSION_OPTIONS[2].parts,
                FULL_BODY_PIXEL = PIXEL_AT(FULL_FACE_DRAW.pixels, 100, 112),
                OUTLINE_BODY_PIXEL = PIXEL_AT(OUTLINE_FACE_DRAW.pixels, 100, 112);
            let excludedFacePixelDifferences = 0;
            for (let pixelOffset = 0; pixelOffset < FULL_FACE_DRAW.pixels.length; pixelOffset += 4) {
                if (
                    FULL_FACE_DRAW.pixels[pixelOffset] !== OUTLINE_FACE_DRAW.pixels[pixelOffset] ||
                    FULL_FACE_DRAW.pixels[pixelOffset + 1] !== OUTLINE_FACE_DRAW.pixels[pixelOffset + 1] ||
                    FULL_FACE_DRAW.pixels[pixelOffset + 2] !== OUTLINE_FACE_DRAW.pixels[pixelOffset + 2] ||
                    FULL_FACE_DRAW.pixels[pixelOffset + 3] !== OUTLINE_FACE_DRAW.pixels[pixelOffset + 3]
                ) {
                    excludedFacePixelDifferences++;
                }
            }
            ASSERT_THAT(
                SUBMITTED_EXCLUSION_OPTIONS.length === 6 &&
                    BATCH_EXCLUSION_OPTIONS.length === 3 &&
                    FULL_FACE_DRAW.mesh.draws === 1 &&
                    OUTLINE_FACE_DRAW.mesh.draws === 1 &&
                    REPEATED_OUTLINE_FACE_DRAW.mesh.draws === 1 &&
                    EXCLUSION_BATCH_STATS.draws === (DEVICE.instancingSupported ? 2 : 3) &&
                    FULL_FACE_DRAW.glError === 0 &&
                    OUTLINE_FACE_DRAW.glError === 0 &&
                    REPEATED_OUTLINE_FACE_DRAW.glError === 0,
                'call-scoped part filtering keeps valid WebGL submissions for full and repeated outline passes',
            );
            ASSERT_THAT(
                excludedFacePixelDifferences > 0 &&
                    FULL_BODY_PIXEL.every((value, index) => value === OUTLINE_BODY_PIXEL[index]) &&
                    OUTLINE_FACE_DRAW.pixels.every(
                        (value, index) => value === REPEATED_OUTLINE_FACE_DRAW.pixels[index],
                    ),
                'excluding expression face geometry changes face pixels only while the body remains and reuses the Set',
            );
            ASSERT_THAT(
                FULL_FACE_PARTS[BODY_PART_INDEX].visible &&
                    FACE_PART_INDICES.some(
                        (index) => FULL_FACE_PARTS[index].visible && !OUTLINE_FACE_PARTS[index].visible,
                    ) &&
                    FACE_PART_INDICES.every((index) => !OUTLINE_FACE_PARTS[index].visible) &&
                    FULL_FACE_PARTS[BODY_PART_INDEX].transform.every(
                        (value, index) => value === OUTLINE_FACE_PARTS[BODY_PART_INDEX].transform[index],
                    ) &&
                    FACE_PART_INDICES.every((index) => !BATCH_EXCLUSION_OPTIONS[0].parts[index].visible) &&
                    FACE_PART_INDICES.every((index) => !BATCH_EXCLUSION_OPTIONS[1].parts[index].visible) &&
                    FACE_PART_INDICES.some((index) => BATCH_FULL_FACE_PARTS[index].visible) &&
                    BATCH_EXCLUSION_OPTIONS.every(
                        (options) =>
                            options.alpha === 0.65 &&
                            options.clips === OUTLINE_CLIPS &&
                            options.indexVariant === 'happy',
                    ) &&
                    SUBMITTED_EXCLUSION_OPTIONS.every(
                        (options) =>
                            options.alpha === 0.65 &&
                            options.clips === OUTLINE_CLIPS &&
                            options.indexVariant === 'happy' &&
                            !Object.hasOwn(options, 'indexRange'),
                    ),
                'excludeParts hides only listed faces per call and preserves pose, alpha, clipping, and variant selection',
            );
            ASSERT_THAT(
                PLAYER.currentExpression === 'happy' &&
                    PLAYER.getPartPose('face-happy').visible &&
                    JSON.stringify(PLAYER.partPoses()) === POSES_BEFORE_EXCLUSION &&
                    BODY_TRANSFORM_BEFORE_EXCLUSION.every(
                        (value, index) => value === PLAYER.getPartPose('body').transform[index],
                    ),
                'call-scoped face exclusion does not mutate player visibility or the cached interpreted pose',
            );
            PLAYER.setExpression(ORIGINAL_EXPRESSION);
            PLAYER.setPartVisible('leaf-left', false);
            PAINT();
            const UNDER_HOLE_PIXEL = PIXEL(80, 48);
            PLAYER.setPartVisible('leaf-left', true);
            ASSERT_THAT(
                HOLE_PIXEL.every((channel, index) => Math.abs(channel - UNDER_HOLE_PIXEL[index]) <= 2),
                `evenodd compound leaf hole matches its visible under-layer: ${HOLE_PIXEL}/${UNDER_HOLE_PIXEL}`,
            );
            ASSERT_THAT(
                INITIAL_FRAME.glError === 0 && INITIAL_FRAME.device.drawCalls >= 1,
                'real WebGL draw and GL error check',
            );
            ASSERT_THAT(
                INITIAL_FRAME.mesh.geometryUploads === 0 && INITIAL_FRAME.mesh.geometryBytesUploaded === 0,
                'asset geometry was uploaded only at resource creation',
            );
            ASSERT_THAT(
                ASSET.mesh.byteLength === standardMeshBytes &&
                    ASSET.mesh.byteLength > 0 &&
                    ASSET.mesh.byteLength < legacyMeshBytes &&
                    MESHES.stats().meshCount === 1,
                'the bundled fixture retains valid default geometry smaller than explicit 16/12',
            );
            ASSERT_THAT(
                NEAR(PLAYER.getSocket('mouth').x, 100) && NEAR(PLAYER.getSocket('mouth').y, 146),
                'authored socket at SVG coordinates',
            );
            const BEFORE_FAILED_CREATE = {
                bytes: DEVICE.stats.gpuBufferBytes,
                retained: MESHES.stats().retainedBytes,
                meshes: MESHES.stats().meshCount,
            };
            const UPLOAD_INDICES = DEVICE.uploadIndices;
            let indexUploads = 0;
            let failedCreate = null;
            DEVICE.uploadIndices = function (buffer, indices) {
                indexUploads++;
                if (indexUploads === 2) {
                    throw new Error('injected expression index upload failure');
                }
                return UPLOAD_INDICES.call(this, buffer, indices);
            };
            const GEOMETRY_INPUT = {
                vertices: ASSET.mesh.vertices,
                strideFloats: 11,
                partCount: ASSET.mesh.partCount,
                morphCount: ASSET.mesh.morphCount,
                indices: ASSET.mesh.indices,
                expressionIndices: Object.fromEntries(
                    [...ASSET.mesh.expressionIndices].map(([name, variant]) => [name, variant.indices]),
                ),
            };
            try {
                MESHES.createMesh(GEOMETRY_INPUT);
            } catch (error) {
                failedCreate = error;
            } finally {
                DEVICE.uploadIndices = UPLOAD_INDICES;
            }
            ASSERT_THAT(
                failedCreate?.message === 'injected expression index upload failure',
                'expression index upload failure reaches the caller',
            );
            ASSERT_THAT(
                DEVICE.stats.gpuBufferBytes === BEFORE_FAILED_CREATE.bytes &&
                    MESHES.stats().retainedBytes === BEFORE_FAILED_CREATE.retained &&
                    MESHES.stats().meshCount === BEFORE_FAILED_CREATE.meshes,
                'failed expression index upload releases every partial GPU allocation',
            );
            let nullVariantsRejected = false;
            try {
                MESHES.createMesh({
                    ...GEOMETRY_INPUT,
                    expressionIndices: null,
                });
            } catch (error) {
                nullVariantsRejected = /triangles/.test(error.message);
            }
            ASSERT_THAT(
                nullVariantsRejected,
                'an explicit null expression index map is rejected instead of silently treated as absent',
            );
            PLAYER.seek(0);
            const EXPANDED_VERTICES = new Float32Array(ASSET.mesh.indices.length * 11);
            for (let i = 0; i < ASSET.mesh.indices.length; i++) {
                EXPANDED_VERTICES.set(
                    ASSET.mesh.vertices.subarray(ASSET.mesh.indices[i] * 11, ASSET.mesh.indices[i] * 11 + 11),
                    i * 11,
                );
            }
            const EXPANDED_MESH = MESHES.createMesh({
                vertices: EXPANDED_VERTICES,
                strideFloats: 11,
                partCount: ASSET.mesh.partCount,
                morphCount: ASSET.mesh.morphCount,
            });
            const ACTOR_PARTS = PLAYER.partPoses().map(({ transform, opacity, visible }) => ({
                transform,
                opacity,
                visible,
            }));
            const CAPTURE = (mesh) => {
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.875, 0.91, 0.8, 1],
                });
                MESHES.beginFrame();
                MESHES.drawMesh(mesh, {
                    projection: PROJECTION,
                    parts: ACTOR_PARTS,
                });
                MESHES.flush();
                DEVICE.endFrame();
                const PIXELS = new Uint8Array(200 * 220 * 4);
                DEVICE.gl.readPixels(0, 0, 200, 220, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                return {
                    pixels: PIXELS,
                    glError: DEVICE.gl.getError(),
                };
            };
            const INDEXED_CAPTURE = CAPTURE(ASSET.mesh),
                EXPANDED_CAPTURE = CAPTURE(EXPANDED_MESH);
            let pixelMismatch = 0;
            for (let i = 0; i < INDEXED_CAPTURE.pixels.length; i++) {
                if (INDEXED_CAPTURE.pixels[i] !== EXPANDED_CAPTURE.pixels[i]) {
                    pixelMismatch++;
                }
            }
            ASSERT_THAT(
                INDEXED_CAPTURE.glError === 0 && EXPANDED_CAPTURE.glError === 0 && pixelMismatch === 0,
                `indexed and expanded retained geometry render the same pixels (${pixelMismatch} channel differences)`,
            );
            const INDEXED_PARITY = {
                pixelMismatch,
                indexedBytes: ASSET.mesh.byteLength,
                expandedBytes: EXPANDED_VERTICES.byteLength,
                savedBytes: EXPANDED_VERTICES.byteLength - ASSET.mesh.byteLength,
            };
            MESHES.deleteMesh(EXPANDED_MESH);
            const FIRST_POSE = PLAYER.seek(375).getPartPose('body');
            PLAYER.seek(900);
            const ROLLBACK_POSE = PLAYER.seek(375).getPartPose('body');
            ASSERT_THAT(
                JSON.stringify(FIRST_POSE) === JSON.stringify(ROLLBACK_POSE),
                'same absolute clip time reproduces exactly the same pose after rollback seek',
            );
            PLAYER.transitionTo('bounce', 1000, 200);
            const TRANSITION = PLAYER.seek(1100).getPartPose('body');
            PLAYER.seek(1400);
            const TRANSITION_ROLLBACK = PLAYER.seek(1100).getPartPose('body');
            ASSERT_THAT(
                JSON.stringify(TRANSITION) === JSON.stringify(TRANSITION_ROLLBACK),
                'clip transition is deterministic under seek rollback',
            );
            const MAP_CONSTRUCTIONS_DURING = (callback) => {
                const NATIVE_MAP = window.Map;
                let constructions = 0;
                window.Map = class CountingMap extends NATIVE_MAP {
                    constructor(...args) {
                        constructions++;
                        super(...args);
                    }
                };
                try {
                    callback();
                    return constructions;
                } finally {
                    window.Map = NATIVE_MAP;
                }
            };
            const BOUNDARY_PLAYER = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            const IDLE_BEFORE_START = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            })
                .seek(999)
                .getPartPose('body');
            const IDLE_AT_START = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            })
                .seek(1000)
                .getPartPose('body');
            const BOUNCE_AT_START = ASSET.createPlayer({
                clip: 'bounce',
                startedAtMs: 1000,
            })
                .seek(1000)
                .getPartPose('body');
            const BOUNCE_AT_END = ASSET.createPlayer({
                clip: 'bounce',
                startedAtMs: 1000,
            })
                .seek(1200)
                .getPartPose('body');
            const IDLE_PROBE = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            const BOUNCE_PROBE = ASSET.createPlayer({
                clip: 'bounce',
                startedAtMs: 1000,
            });
            BOUNDARY_PLAYER.transitionTo('bounce', 1000, 200);
            const DIRECT_SOURCE_MAPS = MAP_CONSTRUCTIONS_DURING(() => IDLE_PROBE.seek(1100));
            const DIRECT_TARGET_MAPS = MAP_CONSTRUCTIONS_DURING(() => BOUNCE_PROBE.seek(1100));
            const BEFORE_START_MAPS = MAP_CONSTRUCTIONS_DURING(() => BOUNDARY_PLAYER.seek(999));
            const AT_START_MAPS = MAP_CONSTRUCTIONS_DURING(() => BOUNDARY_PLAYER.seek(1000));
            const ACTIVE_TRANSITION_MAPS = MAP_CONSTRUCTIONS_DURING(() => BOUNDARY_PLAYER.seek(1100));
            const COMPLETED_TRANSITION_MAPS = MAP_CONSTRUCTIONS_DURING(() => BOUNDARY_PLAYER.seek(1200));
            const BEFORE_TRANSITION = BOUNDARY_PLAYER.seek(999).getPartPose('body');
            const AT_TRANSITION_START = BOUNDARY_PLAYER.seek(1000).getPartPose('body');
            const AT_TRANSITION_END = BOUNDARY_PLAYER.seek(1200).getPartPose('body');
            ASSERT_THAT(
                BEFORE_START_MAPS === DIRECT_SOURCE_MAPS,
                `a transition before its start samples only its source (${BEFORE_START_MAPS} vs ${DIRECT_SOURCE_MAPS} Map constructions)`,
            );
            ASSERT_THAT(
                AT_START_MAPS === DIRECT_SOURCE_MAPS,
                `a positive-duration transition samples only its source at the zero-progress start boundary (${AT_START_MAPS} vs ${DIRECT_SOURCE_MAPS} Map constructions)`,
            );
            ASSERT_THAT(
                ACTIVE_TRANSITION_MAPS === DIRECT_SOURCE_MAPS + DIRECT_TARGET_MAPS + 1,
                `an active transition samples both clips and allocates one blended pose map (${ACTIVE_TRANSITION_MAPS} constructions)`,
            );
            ASSERT_THAT(
                COMPLETED_TRANSITION_MAPS === DIRECT_TARGET_MAPS,
                `a completed transition samples only its target (${COMPLETED_TRANSITION_MAPS} vs ${DIRECT_TARGET_MAPS} Map constructions)`,
            );
            ASSERT_THAT(
                JSON.stringify(BEFORE_TRANSITION) === JSON.stringify(IDLE_BEFORE_START),
                'a transition samples only its source before the start time',
            );
            ASSERT_THAT(
                JSON.stringify(AT_TRANSITION_START) === JSON.stringify(IDLE_AT_START),
                'a transition begins at its source pose exactly at the start boundary',
            );
            ASSERT_THAT(
                JSON.stringify(AT_TRANSITION_END) === JSON.stringify(BOUNCE_AT_END),
                'a completed transition returns its target pose exactly at the end boundary',
            );
            const ZERO_DURATION_PLAYER = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            ZERO_DURATION_PLAYER.transitionTo('bounce', 1000, 0);
            ASSERT_THAT(
                JSON.stringify(ZERO_DURATION_PLAYER.seek(999).getPartPose('body')) ===
                    JSON.stringify(IDLE_BEFORE_START),
                'a zero-duration transition keeps its source before its start',
            );
            ASSERT_THAT(
                MAP_CONSTRUCTIONS_DURING(() => ZERO_DURATION_PLAYER.seek(1000)) === DIRECT_TARGET_MAPS,
                'a zero-duration transition samples only its target at the start boundary',
            );
            ASSERT_THAT(
                JSON.stringify(ZERO_DURATION_PLAYER.seek(1000).getPartPose('body')) === JSON.stringify(BOUNCE_AT_START),
                'a zero-duration transition selects its target at the start boundary',
            );
            const OVERLAPPING_PLAYER = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            OVERLAPPING_PLAYER.transitionTo('bounce', 1000, 200);
            OVERLAPPING_PLAYER.transitionTo('idle', 1150, 200);
            OVERLAPPING_PLAYER.transitionTo('bounce', 1250, 0);
            const OVERLAPPING_TIMES = [1125, 1175, 1249, 1250, 1275, 1350];
            const OVERLAPPING_FORWARD = OVERLAPPING_TIMES.map((time) =>
                JSON.stringify(OVERLAPPING_PLAYER.seek(time).getPartPose('body')),
            );
            OVERLAPPING_PLAYER.seek(3000);
            const OVERLAPPING_BACKWARD = OVERLAPPING_TIMES.map((time) =>
                JSON.stringify(OVERLAPPING_PLAYER.seek(time).getPartPose('body')),
            );
            ASSERT_THAT(
                JSON.stringify(OVERLAPPING_FORWARD) === JSON.stringify(OVERLAPPING_BACKWARD),
                'overlapping and completed transitions retain deterministic backward seeks across their full history',
            );
            const SIMPLE_SAMPLING_PROBE = ASSET.createPlayer({
                clip: 'bounce',
                startedAtMs: 0,
            });
            const COMPLETED_CHAIN_PROBE = ASSET.createPlayer({
                clip: 'idle',
                startedAtMs: 0,
            });
            for (let index = 0; index < 16; index++) {
                COMPLETED_CHAIN_PROBE.transitionTo(index % 2 ? 'idle' : 'bounce', 1000 + index * 300, 100);
            }
            const SETTLED_TIME = 1000 + 15 * 300 + 500;
            const SIMPLE_SEEK_MAP_CONSTRUCTIONS = MAP_CONSTRUCTIONS_DURING(() =>
                SIMPLE_SAMPLING_PROBE.seek(SETTLED_TIME),
            );
            const COMPLETED_CHAIN_MAP_CONSTRUCTIONS = MAP_CONSTRUCTIONS_DURING(() =>
                COMPLETED_CHAIN_PROBE.seek(SETTLED_TIME),
            );
            ASSERT_THAT(
                COMPLETED_CHAIN_MAP_CONSTRUCTIONS === SIMPLE_SEEK_MAP_CONSTRUCTIONS,
                `a settled 16-transition playback chain samples its target with the same Map construction count as one direct clip (${COMPLETED_CHAIN_MAP_CONSTRUCTIONS} vs ${SIMPLE_SEEK_MAP_CONSTRUCTIONS})`,
            );
            PLAYER.seek(300);
            const TRANSFORMED_SOCKET = PLAYER.getSocket('mouth');
            ASSERT_THAT(!NEAR(TRANSFORMED_SOCKET.y, 146), 'part rotation/scale/translation transforms visual socket');
            PLAYER.setExpression('happy');
            ASSERT_THAT(
                PLAYER.currentExpression === 'happy' &&
                    !PLAYER.getPartPose('face-neutral').visible &&
                    PLAYER.getPartPose('face-happy').visible,
                'expression variants toggle SVG-authored groups',
            );
            PLAYER.setExpression('neutral');
            PLAYER.setBasePose('body', {
                opacity: 1,
            });
            PAINT([PLAYER], 300);
            const OPAQUE_SHELL_PIXEL = PIXEL(100, 90);
            PLAYER.setBasePose('body', {
                opacity: 0.5,
            });
            const FADED_CHILD = PLAYER.partPoses().find(
                (part) => part.index === SEED_SCOUT_METADATA.parts.findIndex((item) => item.id === 'face-neutral'),
            );
            ASSERT_THAT(
                NEAR(FADED_CHILD.opacity, 0.5 * PLAYER.getPartPose('body').opacity),
                'parent part opacity composes into descendant parts',
            );
            PAINT([PLAYER], 300);
            const FADED_SHELL_PIXEL = PIXEL(100, 90);
            ASSERT_THAT(
                FADED_SHELL_PIXEL.some((channel, index) => Math.abs(channel - OPAQUE_SHELL_PIXEL[index]) > 2),
                `per-part opacity changes actual WebGL pixels: ${OPAQUE_SHELL_PIXEL}/${FADED_SHELL_PIXEL}`,
            );
            PLAYER.setPartVisible('body', false);
            ASSERT_THAT(!PLAYER.getPartPose('face-neutral').visible, 'parent visibility hides descendants');
            PLAYER.setPartVisible('body', true);
            PLAYER.setBasePose('body', {
                opacity: 1,
            });
            const COLD_METRICS = {
                initializationMs: INITIALIZATION_MS,
                retainedGeometryBytes: ASSET.mesh.byteLength,
                sourceSha256: ASSET.sourceSha256,
                partCount: SEED_SCOUT_METADATA.parts.length,
                instanceUploadsPerActor: INITIAL_FRAME.mesh.instanceBytesUploaded,
                geometryUploadsAtCreate: RESOURCE_CREATION_STATS.geometryUploads,
                geometryUploadBytesAtCreate: RESOURCE_CREATION_STATS.geometryBytesUploaded,
                gpuBufferBytes: DEVICE.stats.gpuBufferBytes,
                gpuDrawCalls: INITIAL_FRAME.device.drawCalls,
                rendererInitializationMs: RENDERER_INITIALIZATION_MS,
                gpuTimerExtension: Boolean(DEVICE.gl.getExtension('EXT_disjoint_timer_query')),
                backend: DEVICE.instancingSupported ? 'ANGLE_instanced_arrays' : 'uniform-per-actor',
                viewportCss: [innerWidth, innerHeight],
                socket: PLAYER.getSocket('mouth'),
            };
            const WARM_FRAME = PAINT([PLAYER], 400);
            ASSERT_THAT(
                WARM_FRAME.mesh.geometryUploads === 0 &&
                    WARM_FRAME.mesh.geometryBytesUploaded === 0 &&
                    WARM_FRAME.glError === 0,
                'warm frame does not upload geometry',
            );
            const BENCHMARK = [];
            for (const COUNT of [100, 400]) {
                const CREATE_START = includePopulationTimingDiagnostics ? performance.now() : null;
                const ACTORS = Array.from(
                    {
                        length: COUNT,
                    },
                    () =>
                        ASSET.createPlayer({
                            clip: 'idle',
                            startedAtMs: 0,
                        }),
                );
                const CREATE_MS = CREATE_START === null ? null : performance.now() - CREATE_START;
                ACTORS[0].seek(300);
                ACTORS[1].seek(300);
                const SHARED_POSE_STATE =
                    JSON.stringify(ACTORS[0].partPoses()) === JSON.stringify(ACTORS[1].partPoses());
                const MATRICES = ACTORS.map((_, i) => [
                    0.045,
                    0,
                    0,
                    0.045,
                    8 + (i % 20) * 9,
                    7 + Math.floor(i / 20) * 10,
                ]);
                let cpuStart = includePopulationTimingDiagnostics ? performance.now() : null;
                const COLD_QUERY = includePopulationTimingDiagnostics ? BEGIN_GPU_QUERY(DEVICE) : null;
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.875, 0.91, 0.8, 1],
                });
                MESHES.beginFrame();
                for (let i = 0; i < COUNT; i++) {
                    ACTORS[i].seek(300);
                    ACTORS[i].draw({
                        projection: PROJECTION,
                        matrix: MATRICES[i],
                    });
                }
                const SUBMIT_CPU_MS = cpuStart === null ? null : performance.now() - cpuStart;
                MESHES.flush();
                DEVICE.endFrame();
                const COLD_GPU_TIME_NS = includePopulationTimingDiagnostics ? END_GPU_QUERY(DEVICE, COLD_QUERY) : null;
                const FIRST_DRAW = {
                        ...MESHES.stats(),
                    },
                    FIRST_DEVICE = {
                        ...DEVICE.stats,
                    };
                cpuStart = includePopulationTimingDiagnostics ? performance.now() : null;
                const WARM_QUERY = includePopulationTimingDiagnostics ? BEGIN_GPU_QUERY(DEVICE) : null;
                DEVICE.beginFrame({
                    width: 200,
                    height: 220,
                    clearColor: [0.875, 0.91, 0.8, 1],
                });
                MESHES.beginFrame();
                for (let i = 0; i < COUNT; i++) {
                    ACTORS[i].seek(450);
                    ACTORS[i].draw({
                        projection: PROJECTION,
                        matrix: MATRICES[i],
                    });
                }
                const WARM_CPU_MS = cpuStart === null ? null : performance.now() - cpuStart;
                MESHES.flush();
                DEVICE.endFrame();
                const WARM_GPU_TIME_NS = includePopulationTimingDiagnostics ? END_GPU_QUERY(DEVICE, WARM_QUERY) : null;
                const WARM = {
                        ...MESHES.stats(),
                    },
                    WARM_DEVICE = {
                        ...DEVICE.stats,
                    };
                ASSERT_THAT(
                    WARM_DEVICE.drawCalls === (DEVICE.instancingSupported ? 1 : COUNT),
                    `retained actors should batch by shared pose (${COUNT}): ${WARM_DEVICE.drawCalls} draws`,
                );
                BENCHMARK.push({
                    actors: COUNT,
                    ...(includePopulationTimingDiagnostics
                        ? {
                              playerInitMs: CREATE_MS,
                              cpuSubmitMs: SUBMIT_CPU_MS,
                              warmCpuSubmitMs: WARM_CPU_MS,
                              gpuTimerCold: COLD_GPU_TIME_NS,
                              gpuTimerWarm: WARM_GPU_TIME_NS,
                              jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
                          }
                        : {}),
                    sharedPoseState: SHARED_POSE_STATE,
                    geometryBytes: ASSET.mesh.byteLength,
                    geometryUploadBytesCold: FIRST_DRAW.geometryBytesUploaded,
                    instanceUploadBytesCold: FIRST_DRAW.instanceBytesUploaded,
                    instanceUploadBytesWarm: WARM.instanceBytesUploaded,
                    partUniformBytesSubmitted: WARM.partUniformBytesSubmitted,
                    drawsCold: FIRST_DEVICE.drawCalls,
                    drawsWarm: WARM_DEVICE.drawCalls,
                    totalGpuBufferBytes: WARM_DEVICE.gpuBufferBytes,
                    rendererStagingBytes: WARM.stagingBytes,
                });
                for (const ACTOR of ACTORS) {
                    ACTOR.dispose();
                }
            }
            const INDEPENDENT_ANIMATION_ACTORS = [];
            for (const COUNT of [100, 400]) {
                const CLIPS = Object.keys(SEED_SCOUT_METADATA.clips),
                    EXPRESSIONS = Object.keys(SEED_SCOUT_METADATA.expressions);
                const GROUP_COUNTS = new Map(
                    CLIPS.map((clip) => [
                        clip,
                        Array.from(
                            {
                                length: COUNT,
                            },
                            (_, i) => CLIPS[i % CLIPS.length],
                        ).filter((name) => name === clip).length,
                    ]),
                );
                const GROUP_INDICES = new Map(CLIPS.map((clip) => [clip, 0]));
                const CREATE_START = includePopulationTimingDiagnostics ? performance.now() : null;
                const ACTORS = Array.from(
                    {
                        length: COUNT,
                    },
                    (_, index) => {
                        const CLIP = CLIPS[index % CLIPS.length],
                            ORDINAL = GROUP_INDICES.get(CLIP),
                            GROUP_COUNT = GROUP_COUNTS.get(CLIP);
                        GROUP_INDICES.set(CLIP, ORDINAL + 1);
                        const DURATION_MS = SEED_SCOUT_METADATA.clips[CLIP].durationMs;
                        const PHASE_SPAN_MS = Math.max(1, DURATION_MS / 3 - 32);
                        const PHASE_MS = ((ORDINAL + 0.5) * PHASE_SPAN_MS) / GROUP_COUNT;
                        const ACTOR = ASSET.createPlayer({
                            clip: CLIP,
                            startedAtMs: 1000 - PHASE_MS,
                        });
                        ACTOR.setExpression(EXPRESSIONS[index % EXPRESSIONS.length]);
                        return ACTOR;
                    },
                );
                const CREATE_MS = CREATE_START === null ? null : performance.now() - CREATE_START;
                const MATRICES = ACTORS.map((_, i) => [
                    0.045,
                    0,
                    0,
                    0.045,
                    8 + (i % 20) * 9,
                    7 + Math.floor(i / 20) * 10,
                ]);
                const FRAMES = [];
                const POSE_STATES = [];
                let distinctPoseCount = 0;
                for (const DISPLAY_TIME_MS of [1000, 1016]) {
                    for (const ACTOR of ACTORS) {
                        ACTOR.seek(DISPLAY_TIME_MS);
                    }
                    const POSE_KEYS = new Map(),
                        DUPLICATE_POSE_INDICES = [];
                    POSE_STATES.push(JSON.stringify(ACTORS.map((actor) => actor.partPoses())));
                    ACTORS.forEach((actor, index) => {
                        const SIGNATURE = JSON.stringify(actor.partPoses()),
                            EARLIER = POSE_KEYS.get(SIGNATURE);
                        if (EARLIER === undefined) {
                            POSE_KEYS.set(SIGNATURE, index);
                        } else {
                            DUPLICATE_POSE_INDICES.push([EARLIER, index]);
                        }
                    });
                    distinctPoseCount = Math.min(distinctPoseCount || COUNT, POSE_KEYS.size);
                    const CPU_START = includePopulationTimingDiagnostics ? performance.now() : null;
                    const QUERY = includePopulationTimingDiagnostics ? BEGIN_GPU_QUERY(DEVICE) : null;
                    DEVICE.beginFrame({
                        width: 200,
                        height: 220,
                        clearColor: [0.875, 0.91, 0.8, 1],
                    });
                    MESHES.beginFrame();
                    for (let i = 0; i < COUNT; i++) {
                        ACTORS[i].draw({
                            projection: PROJECTION,
                            matrix: MATRICES[i],
                        });
                    }
                    const CPU_SUBMIT_MS = CPU_START === null ? null : performance.now() - CPU_START;
                    MESHES.flush();
                    DEVICE.endFrame();
                    const GPU_TIME = includePopulationTimingDiagnostics ? END_GPU_QUERY(DEVICE, QUERY) : null;
                    const MESH_STATS = {
                            ...MESHES.stats(),
                        },
                        DEVICE_STATS = {
                            ...DEVICE.stats,
                        },
                        GL_ERROR = DEVICE.gl.getError();
                    ASSERT_THAT(
                        POSE_KEYS.size === COUNT,
                        `independent clip/phase/expression fixture must produce ${COUNT} unique part poses at ${DISPLAY_TIME_MS}: ${POSE_KEYS.size}; duplicates=${JSON.stringify(DUPLICATE_POSE_INDICES)}`,
                    );
                    ASSERT_THAT(
                        MESH_STATS.draws === COUNT &&
                            DEVICE_STATS.drawCalls === COUNT &&
                            MESH_STATS.geometryUploads === 0 &&
                            MESH_STATS.geometryBytesUploaded === 0,
                        `independent ${COUNT}-actor poses should submit one retained mesh draw each without frame geometry uploads: ${MESH_STATS.draws}`,
                    );
                    FRAMES.push({
                        displayTimeMs: DISPLAY_TIME_MS,
                        ...(includePopulationTimingDiagnostics
                            ? {
                                  cpuSubmitMs: CPU_SUBMIT_MS,
                                  gpuTimer: GPU_TIME,
                              }
                            : {}),
                        draws: MESH_STATS.draws,
                        instances: MESH_STATS.instances,
                        geometryUploads: MESH_STATS.geometryUploads,
                        geometryBytesUploaded: MESH_STATS.geometryBytesUploaded,
                        instanceBytesUploaded: MESH_STATS.instanceBytesUploaded,
                        partUniformBytesSubmitted: MESH_STATS.partUniformBytesSubmitted,
                        glError: GL_ERROR,
                    });
                    ASSERT_THAT(GL_ERROR === 0, `independent ${COUNT}-actor frame has no WebGL error`);
                }
                for (const ACTOR of ACTORS) {
                    ACTOR.seek(1000);
                }
                ASSERT_THAT(
                    JSON.stringify(ACTORS.map((actor) => actor.partPoses())) === POSE_STATES[0],
                    `independent ${COUNT}-actor clip/phase/expression poses reproduce after a rollback seek`,
                );
                INDEPENDENT_ANIMATION_ACTORS.push({
                    actors: COUNT,
                    ...(includePopulationTimingDiagnostics
                        ? {
                              playerInitMs: CREATE_MS,
                          }
                        : {}),
                    clips: CLIPS.map((name) => ({
                        name,
                        count: GROUP_COUNTS.get(name),
                    })),
                    expressionCount: EXPRESSIONS.length,
                    distinctPoseCount,
                    frames: FRAMES,
                });
                for (const ACTOR of ACTORS) {
                    ACTOR.dispose();
                }
            }
            PLAYER.setExpression('happy');
            const DRAW_MESH = MESHES.drawMesh;
            const OBSERVED_VARIANTS = [];
            MESHES.drawMesh = (mesh, options) => {
                OBSERVED_VARIANTS.push(options.indexVariant);
                return DRAW_MESH.call(MESHES, mesh, options);
            };
            const POSE_AT375 = PLAYER.seek(375).getPartPose('body').transform;
            PAINT([PLAYER], 375);
            const POSE_AT700 = PLAYER.seek(700).getPartPose('body').transform;
            PAINT([PLAYER], 700);
            ASSERT_THAT(
                JSON.stringify(POSE_AT375) !== JSON.stringify(POSE_AT700),
                'absolute seek changes the authored animated pose',
            );
            ASSERT_THAT(
                OBSERVED_VARIANTS.length === 2 && OBSERVED_VARIANTS.every((name) => name === 'happy'),
                'seek and clip animation keep selecting the same authored expression indices',
            );
            OBSERVED_VARIANTS.length = 0;
            PAINT([PLAYER], 375);
            const PIXELS_BEFORE_RESTORE = new Uint8Array(200 * 220 * 4);
            DEVICE.gl.readPixels(0, 0, 200, 220, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS_BEFORE_RESTORE);
            const LOSS = DEVICE.gl.getExtension('WEBGL_lose_context');
            ASSERT_THAT(
                Boolean(LOSS),
                'Chromium provides WEBGL_lose_context for expression index restoration coverage',
            );
            const WAIT_FOR_CONTEXT_EVENT = (name) =>
                new Promise((resolve, reject) => {
                    const TIMEOUT = setTimeout(
                        () => reject(new Error(name + ' did not arrive within 5 seconds')),
                        5000,
                    );
                    CANVAS.addEventListener(
                        name,
                        (event) => {
                            clearTimeout(TIMEOUT);
                            resolve(event);
                        },
                        {
                            once: true,
                        },
                    );
                });
            const LOST = WAIT_FOR_CONTEXT_EVENT('webglcontextlost');
            LOSS.loseContext();
            await LOST;
            ASSERT_THAT(
                DEVICE.state === 'lost' && MESHES.stats().state === 'lost',
                'device and retained renderer enter lost state together',
            );
            await new Promise((resolve) => setTimeout(resolve, 80));
            const RESTORED = WAIT_FOR_CONTEXT_EVENT('webglcontextrestored');
            LOSS.restoreContext();
            await RESTORED;
            ASSERT_THAT(
                DEVICE.state === 'ready' && MESHES.stats().state === 'ready',
                'device and expression index buffers restore together',
            );
            const AFTER_RESTORE = PAINT([PLAYER], 375);
            const PIXELS_AFTER_RESTORE = new Uint8Array(200 * 220 * 4);
            DEVICE.gl.readPixels(0, 0, 200, 220, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS_AFTER_RESTORE);
            let restorePixelMismatch = 0;
            for (let index = 0; index < PIXELS_BEFORE_RESTORE.length; index++) {
                if (PIXELS_BEFORE_RESTORE[index] !== PIXELS_AFTER_RESTORE[index]) {
                    restorePixelMismatch++;
                }
            }
            ASSERT_THAT(
                OBSERVED_VARIANTS.at(-1) === 'happy' && AFTER_RESTORE.glError === 0 && restorePixelMismatch === 0,
                `restored expression index buffer draws the same pixels (${restorePixelMismatch} channel differences)`,
            );
            MESHES.drawMesh = DRAW_MESH;
            const EXPRESSION_TARGETS = new Set(
                Object.values(SEED_SCOUT_METADATA.expressions).flatMap((item) => [...item.show, ...item.hide]),
            );
            const EXPRESSION_VISIBLE = new Set(
                SEED_SCOUT_METADATA.expressions[SEED_SCOUT_METADATA.defaultExpression].show,
            );
            const VISIBLE_SOURCE_PATHS = sourcePaths.filter(
                (path) => !EXPRESSION_TARGETS.has(path.part) || EXPRESSION_VISIBLE.has(path.part),
            );
            const PATH_PIPELINE_BENCHMARK = [];
            if (includePopulationTimingDiagnostics) {
                for (const COUNT of [100, 400]) {
                    const PATH_CANVAS = document.createElement('canvas');
                    PATH_CANVAS.width = 200;
                    PATH_CANVAS.height = 220;
                    const PATH_START = performance.now();
                    const PATH_DEVICE = new WEB_GL_DEVICE(PATH_CANVAS, {
                        alpha: false,
                        antialias: false,
                        depth: false,
                        stencil: false,
                    });
                    const CONTEXT = new VECTOR_CONTEXT(PATH_DEVICE, {
                        initialVertices: 16384,
                        maxVertices: 524288,
                    });
                    const INITIALIZE_MS = performance.now() - PATH_START;
                    const COLUMNS = 20,
                        ACTOR_SCALE = 0.045;
                    const STARTED = performance.now();
                    const PATH_QUERY = BEGIN_GPU_QUERY(PATH_DEVICE);
                    CONTEXT.beginFrame({
                        width: 200,
                        height: 220,
                        clearColor: [0.875, 0.91, 0.8, 1],
                    });
                    for (let actorIndex = 0; actorIndex < COUNT; actorIndex++) {
                        const X = 8 + (actorIndex % COLUMNS) * 9,
                            Y = 7 + Math.floor(actorIndex / COLUMNS) * 10;
                        CONTEXT.save();
                        CONTEXT.setTransform(ACTOR_SCALE, 0, 0, ACTOR_SCALE, X, Y);
                        for (const PATH of VISIBLE_SOURCE_PATHS) {
                            CONTEXT.beginPath();
                            for (const SUBPATH of PATH.subpaths) {
                                if (!SUBPATH.points.length) {
                                    continue;
                                }
                                CONTEXT.moveTo(...SUBPATH.points[0]);
                                for (let pointIndex = 1; pointIndex < SUBPATH.points.length; pointIndex++) {
                                    CONTEXT.lineTo(...SUBPATH.points[pointIndex]);
                                }
                                if (SUBPATH.closed) {
                                    CONTEXT.closePath();
                                }
                            }
                            if (PATH.fill !== 'none' && PATH.fillOpacity * PATH.opacity > 0) {
                                CONTEXT.fillStyle = PATH.fill;
                                CONTEXT.globalAlpha = PATH.fillOpacity * PATH.opacity;
                                CONTEXT.fill(PATH.fillRule);
                            }
                            if (
                                PATH.stroke !== 'none' &&
                                PATH.strokeWidth > 0 &&
                                PATH.strokeOpacity * PATH.opacity > 0
                            ) {
                                CONTEXT.strokeStyle = PATH.stroke;
                                CONTEXT.lineWidth = PATH.strokeWidth;
                                CONTEXT.lineCap = PATH.strokeLineCap;
                                CONTEXT.lineJoin = PATH.strokeLineJoin;
                                CONTEXT.miterLimit = PATH.strokeMiterLimit;
                                CONTEXT.globalAlpha = PATH.strokeOpacity * PATH.opacity;
                                CONTEXT.stroke();
                            }
                        }
                        CONTEXT.restore();
                    }
                    const PATH_STATS = CONTEXT.endFrame(),
                        PATH_CPU_MS = performance.now() - STARTED,
                        PATH_DEVICE_STATS = {
                            ...PATH_DEVICE.stats,
                        };
                    const PATH_GPU_TIMER = END_GPU_QUERY(PATH_DEVICE, PATH_QUERY);
                    const UPLOADED_BYTES = PATH_STATS.uploadedBytes,
                        DRAW_CALLS = PATH_STATS.drawCalls;
                    CONTEXT.dispose();
                    PATH_DEVICE.dispose();
                    PATH_PIPELINE_BENCHMARK.push({
                        actors: COUNT,
                        rendererInitializationMs: INITIALIZE_MS,
                        cpuSubmitAndTessellateMs: PATH_CPU_MS,
                        gpuTimer: PATH_GPU_TIMER,
                        uploadsBytes: UPLOADED_BYTES,
                        drawCalls: DRAW_CALLS,
                        vertices: PATH_STATS.vertices,
                        stagingBytes: PATH_STATS.stagingBytes,
                        gpuBufferBytes: PATH_STATS.gpuBufferBytes,
                        bufferUploads: PATH_DEVICE_STATS.bufferUploads,
                        sourcePathsPerActor: VISIBLE_SOURCE_PATHS.length,
                    });
                    PATH_CANVAS.remove();
                }
            }
            const OLD_MESH_COUNT = MESHES.stats().meshCount,
                OLD_BUFFER_BYTES = DEVICE.stats.gpuBufferBytes;
            const DISPOSED_PLAYER = PLAYER;
            ASSERT_THAT(DISPOSED_PLAYER.dispose(), 'player disposes once');
            ASSERT_THAT(ASSET.dispose() && !ASSET.dispose(), 'asset disposes idempotently');
            ASSERT_THAT(
                MESHES.stats().meshCount === OLD_MESH_COUNT - 1 && MESHES.stats().retainedBytes === 0,
                'asset disposal releases exactly its retained geometry',
            );
            ASSERT_THAT(
                OLD_BUFFER_BYTES - DEVICE.stats.gpuBufferBytes === ASSET.mesh.byteLength,
                'asset disposal releases base and expression index buffer bytes',
            );
            const REPLACEMENT = CREATE_SEED_SCOUT(MESHES),
                REPLACEMENT_PLAYER = REPLACEMENT.createPlayer();
            PAINT([REPLACEMENT_PLAYER], 0);
            ASSERT_THAT(
                MESHES.stats().meshCount === 1 && DEVICE.gl.getError() === 0,
                'dispose and recreate renders again on the same renderer/device',
            );
            REPLACEMENT_PLAYER.dispose();
            const RENDERER_BUFFERS_BEFORE_DISPOSE = DEVICE.stats.gpuBufferBytes;
            MESHES.dispose();
            ASSERT_THAT(
                MESHES.stats().retainedBytes === 0 && DEVICE.stats.gpuBufferBytes === 0,
                `renderer disposal releases every expression buffer (${RENDERER_BUFFERS_BEFORE_DISPOSE} bytes before disposal)`,
            );
            REPLACEMENT.dispose();
            DEVICE.dispose();
            CANVAS.remove();
            return {
                status: 'PASS',
                sourceSha256: ASSET.sourceSha256,
                coldMetrics: COLD_METRICS,
                indexedParity: INDEXED_PARITY,
                warm: {
                    geometryUploads: WARM_FRAME.mesh.geometryUploads,
                    geometryBytesUploaded: WARM_FRAME.mesh.geometryBytesUploaded,
                },
                benchmark: {
                    timingDiagnosticsEnabled: includePopulationTimingDiagnostics,
                    svgLoaderCompileMs: threeCompileMs,
                    retainedMeshInstances: BENCHMARK,
                    independentAnimationActors: INDEPENDENT_ANIMATION_ACTORS,
                    vectorContextPerFramePathTessellation: PATH_PIPELINE_BENCHMARK,
                    threeBasedProcessing: {
                        svgLoader: 'Three SVGLoader build-time only',
                        runtimeRenderer: 'not introduced',
                        outputGeometryBytes: ASSET.mesh.byteLength,
                        gpuPath:
                            'same retained GameKit MeshRenderer mesh; see retainedMeshInstances (compiled source mesh uploaded once)',
                    },
                },
                expressionIndexLifecycle: {
                    indexedCreateFailureCleanupBytes: BEFORE_FAILED_CREATE.bytes,
                    seekVariants: OBSERVED_VARIANTS,
                    contextRestorePixelMismatch: restorePixelMismatch,
                    retainedMeshBytesReleased: ASSET.mesh.byteLength,
                    rendererBufferBytesReleased: RENDERER_BUFFERS_BEFORE_DISPOSE,
                },
                checks: [
                    'WebGL1 real draw and zero GL error',
                    'evenodd hole and stroke/pixel color',
                    'SVG metadata pivots and sockets',
                    'part hierarchy visibility and opacity',
                    'neutral/happy expression group variants',
                    'expression variants across animated seek and context restore',
                    'failed expression index allocation cleanup',
                    'mesh/renderer disposal releases expression index buffers',
                    'clip switch and repeat seek after rollback',
                    'transition seek after rollback',
                    'dispose and recreate',
                    'mobile landscape viewport',
                ],
            };
        },
        {
            sourcePaths: REFERENCE_ASSET.sourcePaths,
            threeCompileMs: THREE_COMPILE_MS,
            includePopulationTimingDiagnostics,
            standardMeshBytes: STANDARD_MESH_BYTES,
            legacyMeshBytes: LEGACY_MESH_BYTES,
        },
    );
    assert.equal(REPORT.status, 'PASS');
    assert.equal(REPORT.benchmark.timingDiagnosticsEnabled, includePopulationTimingDiagnostics);
    assert.equal(REPORT.benchmark.retainedMeshInstances.length, 2);
    assert.equal(REPORT.benchmark.independentAnimationActors.length, 2);
    assert.equal(
        REPORT.benchmark.vectorContextPerFramePathTessellation.length,
        includePopulationTimingDiagnostics ? 2 : 0,
    );
    for (const ROW of [
        ...REPORT.benchmark.retainedMeshInstances,
        ...REPORT.benchmark.independentAnimationActors,
        ...REPORT.benchmark.vectorContextPerFramePathTessellation,
    ]) {
        assert.ok(ROW.actors === 100 || ROW.actors === 400);
    }
    for (const ROW of REPORT.benchmark.independentAnimationActors) {
        assert.equal(ROW.distinctPoseCount, ROW.actors);
    }
    REPORT.checks.push(
        '100/400 independently phased clips and expression variants remain seek-deterministic, submit one draw per distinct multipart pose, and reuse retained geometry',
    );
    REPORT.threeViewExample = PANEL_STATE;
    REPORT.checks.unshift(
        'same authored SVG source SHA and pose across original/source, compiled triangle topology, and GameKit WebGL panels; shared time/expression/zoom/pan; mobile landscape layout',
    );
    return REPORT;
}

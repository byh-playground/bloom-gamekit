import assert from 'node:assert/strict';
export async function exerciseAlphaRunBatching(browser, moduleURL, screenshotPath) {
    const PAGE = await browser.newPage({
        viewport: {
            width: 720,
            height: 380,
        },
        deviceScaleFactor: 1,
    });
    const PAGE_ERRORS = [];
    PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    try {
        await PAGE.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:18px;background:#eef2ee;color:#233c35;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:18px;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.card{padding:10px;background:white;border:1px solid #cdd8ce;border-radius:8px}
      canvas{display:block;width:256px;height:256px;image-rendering:pixelated;background:#131923}small{display:block;margin:4px 0 0}
    </style><h1>Safe mixed-alpha instance batching</h1><div class="grid">
      <div class="card"><canvas id="overlapReference"></canvas><small>Overlapping units · painter-order reference</small></div>
      <div class="card"><canvas id="overlapCandidate"></canvas><small>Overlapping units · same order retained</small></div>
      <div class="card"><canvas id="disjointReference"></canvas><small>Disjoint units · painter-order reference</small></div>
      <div class="card"><canvas id="disjointCandidate"></canvas><small>Disjoint units · two run draws shared safely</small></div>
    </div>`);
        const RESULT = await PAGE.evaluate(
            async ({ moduleURL }) => {
                const { WebGLDevice: WEB_GL_DEVICE, MeshRenderer: MESH_RENDERER } = await import(moduleURL);
                const CANVAS_MAP = Object.fromEntries(
                    [
                        'overlapReference',
                        'overlapCandidate',
                        'nonAdjacentReference',
                        'nonAdjacentCandidate',
                        'disjointReference',
                        'disjointCandidate',
                    ].map((id) => {
                        const CANVAS = document.getElementById(id) ?? document.createElement('canvas');
                        if (!CANVAS.id) {
                            CANVAS.id = id;
                            CANVAS.style.display = 'none';
                            document.body.appendChild(CANVAS);
                        }
                        return [id, CANVAS];
                    }),
                );
                const OUTPUT = {};
                const GEOMETRY = new Float32Array(9 * 11);
                const COLORS = [
                    [1, 0.15, 0.05, 1],
                    [0.1, 0.25, 1, 1],
                    [1, 0.85, 0.05, 0.5],
                ];
                const POINTS = [
                    [8, 8],
                    [28, 8],
                    [18, 28],
                ];
                for (let triangle = 0; triangle < 3; triangle++) {
                    for (let corner = 0; corner < 3; corner++) {
                        const AT = (triangle * 3 + corner) * 11;
                        GEOMETRY.set([POINTS[corner][0], POINTS[corner][1], ...COLORS[triangle], 0, 0, 0, 0, 0], AT);
                    }
                }
                for (const [ID, CANVAS] of Object.entries(CANVAS_MAP)) {
                    CANVAS.width = CANVAS.height = 64;
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: false,
                        antialias: false,
                        depth: true,
                        stencil: true,
                        preserveDrawingBuffer: true,
                        checkGLErrors: true,
                    });
                    const MESHES = new MESH_RENDERER(DEVICE, {
                        maxInstances: 8,
                        safeAlphaRunBatching: ID.endsWith('Reference') ? false : true,
                    });
                    const MESH = MESHES.createMesh({
                        vertices: GEOMETRY,
                        strideFloats: 11,
                        partCount: 1,
                        morphCount: 0,
                    });
                    const OVERLAP = ID.startsWith('overlap'),
                        NON_ADJACENT = ID.startsWith('nonAdjacent');
                    const MATRICES = NON_ADJACENT
                        ? [
                              [1, 0, 0, 1, 0, 0],
                              [1, 0, 0, 1, 35, 0],
                              [1, 0, 0, 1, 0, 0],
                          ]
                        : OVERLAP
                          ? [
                                [1, 0, 0, 1, 0, 0],
                                [1, 0, 0, 1, 0, 0],
                            ]
                          : [
                                [1, 0, 0, 1, 0, 0],
                                [1, 0, 0, 1, 32, 0],
                            ];
                    const COLORS_BY_UNIT = [
                        [1, 1, 1, 1],
                        [0.5, 0.8, 1, 1],
                        [0.7, 1, 0.5, 1],
                    ];
                    DEVICE.beginFrame({
                        width: 64,
                        height: 64,
                        clearColor: [0.04, 0.06, 0.09, 1],
                        clearDepth: 1,
                    });
                    MESHES.beginFrame();
                    for (let i = 0; i < MATRICES.length; i++) {
                        MESHES.drawMesh(MESH, {
                            matrix: MATRICES[i],
                            projection: [2 / 64, 0, 0, 0, -2 / 64, 0, -1, 1, 1],
                            color: COLORS_BY_UNIT[i],
                            depthTest: true,
                            depthWrite: true,
                            depthWriteAlphaThreshold: 0.999,
                        });
                    }
                    MESHES.flush('frameEnd');
                    DEVICE.gl.finish();
                    const PIXELS = new Uint8Array(64 * 64 * 4);
                    DEVICE.gl.readPixels(0, 0, 64, 64, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                    OUTPUT[ID] = {
                        pixels: [...PIXELS],
                        draws: MESHES.stats().draws,
                        deviceDrawCalls: DEVICE.stats.drawCalls,
                        instancedDrawCalls: DEVICE.stats.instancedDrawCalls,
                        instances: MESHES.stats().instances,
                        safeBatches: MESHES.stats().alphaRunSafeBatches,
                        batchedInstances: MESHES.stats().alphaRunBatchedInstances,
                        drawsSaved: MESHES.stats().alphaRunDrawsSaved,
                        overlapBoundaries: MESHES.stats().alphaRunOverlapBoundaries,
                        flushReasons: MESHES.stats().flushReasons,
                        drawDispatchReasons: MESHES.stats().drawDispatchReasons,
                        glError: DEVICE.gl.getError(),
                        instanced: MESHES.stats().instanced,
                    };
                    DEVICE.endFrame();
                    MESHES.dispose();
                    DEVICE.dispose();
                }
                const PIXEL_AT = (pixels, x, y) => {
                    const AT = ((63 - y) * 64 + x) * 4;
                    return pixels.slice(AT, AT + 4);
                };
                const MISMATCH = (a, b) => a.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
                return {
                    overlap: {
                        referencePixel: PIXEL_AT(OUTPUT.overlapReference.pixels, 18, 12),
                        candidatePixel: PIXEL_AT(OUTPUT.overlapCandidate.pixels, 18, 12),
                        pixelMismatch: MISMATCH(OUTPUT.overlapReference.pixels, OUTPUT.overlapCandidate.pixels),
                        referenceDraws: OUTPUT.overlapReference.draws,
                        candidateDraws: OUTPUT.overlapCandidate.draws,
                        overlapBoundaries: OUTPUT.overlapCandidate.overlapBoundaries,
                        flushReasons: OUTPUT.overlapCandidate.flushReasons,
                        drawDispatchReasons: OUTPUT.overlapCandidate.drawDispatchReasons,
                    },
                    nonAdjacent: {
                        pixelMismatch: MISMATCH(OUTPUT.nonAdjacentReference.pixels, OUTPUT.nonAdjacentCandidate.pixels),
                        referenceDraws: OUTPUT.nonAdjacentReference.draws,
                        candidateDraws: OUTPUT.nonAdjacentCandidate.draws,
                        overlapBoundaries: OUTPUT.nonAdjacentCandidate.overlapBoundaries,
                        flushReasons: OUTPUT.nonAdjacentCandidate.flushReasons,
                        drawDispatchReasons: OUTPUT.nonAdjacentCandidate.drawDispatchReasons,
                    },
                    disjoint: {
                        referenceDraws: OUTPUT.disjointReference.draws,
                        candidateDraws: OUTPUT.disjointCandidate.draws,
                        deviceDrawCalls: OUTPUT.disjointCandidate.deviceDrawCalls,
                        safeBatches: OUTPUT.disjointCandidate.safeBatches,
                        batchedInstances: OUTPUT.disjointCandidate.batchedInstances,
                        drawsSaved: OUTPUT.disjointCandidate.drawsSaved,
                        pixelMismatch: MISMATCH(OUTPUT.disjointReference.pixels, OUTPUT.disjointCandidate.pixels),
                        leftPixel: PIXEL_AT(OUTPUT.disjointCandidate.pixels, 18, 12),
                        rightPixel: PIXEL_AT(OUTPUT.disjointCandidate.pixels, 50, 12),
                        flushReasons: OUTPUT.disjointCandidate.flushReasons,
                        drawDispatchReasons: OUTPUT.disjointCandidate.drawDispatchReasons,
                    },
                    allGLClean: Object.values(OUTPUT).every((sample) => sample.glError === 0),
                    instanced: Object.values(OUTPUT).every((sample) => sample.instanced),
                    output: OUTPUT,
                };
            },
            {
                moduleURL,
            },
        );
        assert.equal(RESULT.overlap.pixelMismatch, 0, `overlap pixels differ: ${JSON.stringify(RESULT.overlap)}`);
        assert.equal(RESULT.overlap.referenceDraws, 4);
        assert.equal(
            RESULT.overlap.candidateDraws,
            4,
            'overlapping mixed-alpha units keep their original per-unit run order',
        );
        assert.ok(RESULT.overlap.overlapBoundaries >= 1, 'overlap is reported as a safe batch boundary');
        assert.equal(RESULT.overlap.flushReasons.alphaOverlap, 1, 'overlap is a reported batch boundary reason');
        assert.equal(
            Object.values(RESULT.overlap.drawDispatchReasons).reduce((sum, count) => sum + count, 0),
            RESULT.overlap.candidateDraws,
            'dispatch reasons classify every actual device.draw call',
        );
        assert.equal(
            RESULT.nonAdjacent.pixelMismatch,
            0,
            'every queued bound is checked, including earlier non-adjacent units',
        );
        assert.equal(RESULT.nonAdjacent.referenceDraws, 6);
        assert.equal(
            RESULT.nonAdjacent.candidateDraws,
            4,
            'first disjoint pair may batch, but the later unit overlapping the first must start a new ordered group',
        );
        assert.equal(RESULT.nonAdjacent.overlapBoundaries, 1);
        assert.equal(RESULT.nonAdjacent.flushReasons.alphaOverlap, 1);
        assert.equal(
            Object.values(RESULT.nonAdjacent.drawDispatchReasons).reduce((sum, count) => sum + count, 0),
            RESULT.nonAdjacent.candidateDraws,
        );
        assert.equal(RESULT.disjoint.pixelMismatch, 0, `disjoint pixels differ: ${JSON.stringify(RESULT.disjoint)}`);
        assert.equal(RESULT.disjoint.referenceDraws, 4);
        if (RESULT.instanced) {
            assert.equal(
                RESULT.disjoint.candidateDraws,
                2,
                'two authored alpha runs batch across two proven-disjoint instances',
            );
            assert.equal(RESULT.disjoint.deviceDrawCalls, 2);
            assert.equal(RESULT.disjoint.safeBatches, 1);
            assert.equal(RESULT.disjoint.batchedInstances, 2);
            assert.equal(RESULT.disjoint.drawsSaved, 2);
            assert.equal(
                Object.values(RESULT.disjoint.drawDispatchReasons).reduce((sum, count) => sum + count, 0),
                RESULT.disjoint.candidateDraws,
            );
            assert.equal(RESULT.disjoint.flushReasons.frameEnd, 1);
        } else {
            assert.equal(
                RESULT.disjoint.candidateDraws,
                RESULT.disjoint.referenceDraws,
                'non-instanced devices keep ordered fallback',
            );
        }
        assert.equal(RESULT.allGLClean, true);
        assert.equal(PAGE_ERRORS.length, 0, PAGE_ERRORS.join('\n'));
        await PAGE.screenshot({
            path: screenshotPath,
            fullPage: true,
        });
        delete RESULT.output;
        return RESULT;
    } finally {
        await PAGE.close();
    }
}

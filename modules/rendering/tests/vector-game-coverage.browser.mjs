/* global vectorGameCoverageProbe */
import assert from 'node:assert/strict';

/** Pixel proof for the actual Budmori renderer contracts, without game code or private SDK calls. */
export async function exerciseVectorGameCoverage(page) {
    const RESULT = await page.evaluate(async () => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorRenderer: VECTOR_RENDERER,
            VectorContext: VECTOR_CONTEXT,
            PrimitivePainter: PRIMITIVE_PAINTER,
        } = await import('/dist/rendering.js');
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 128;
        document.body.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
        });
        const VECTOR = new VECTOR_RENDERER(DEVICE, {
            initialVertices: 256,
            maxVertices: 8192,
        });
        const CTX = new VECTOR_CONTEXT(DEVICE, {
            vectorRenderer: VECTOR,
        });
        const GL = DEVICE.gl;
        const PIXEL = (x, y) => {
            const OUT = new Uint8Array(4);
            GL.readPixels(x, 127 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, OUT);
            return [...OUT];
        };
        const RENDER_STARTED = performance.now();
        CTX.beginFrame({
            clearColor: [0, 0, 0, 0],
        });
        CTX.save();
        CTX.translate(24, 24);
        CTX.fillStyle = '#183fce';
        CTX.withSilhouette(
            '#16e277',
            3,
            () => {
                CTX.beginPath();
                CTX.arc(0, 0, 10, 0, Math.PI * 2);
                CTX.fill();
            },
            15,
        );
        CTX.restore();
        CTX.save();
        CTX.translate(64, 24);
        CTX.globalAlpha = 0.5;
        CTX.filter = 'brightness(0) invert(1)';
        CTX.fillStyle = '#df2020';
        CTX.withSilhouette(
            '#18a04a',
            3,
            () => {
                CTX.beginPath();
                CTX.arc(0, 0, 10, 0, Math.PI * 2);
                CTX.fill();
            },
            15,
        );
        CTX.restore();
        CTX.save();
        CTX.translate(100, 24);
        const GRADIENT = CTX.createRadialGradient(0, 0, 0, 0, 0, 18);
        GRADIENT.addColorStop(0, '#ff0000');
        CTX.fillStyle = GRADIENT;
        CTX.beginPath();
        CTX.arc(0, 0, 18, 0, Math.PI * 2);
        CTX.fill();
        GRADIENT.addColorStop(0.5, '#00ff00');
        GRADIENT.addColorStop(1, '#0000ff00');
        CTX.beginPath();
        CTX.arc(0, 0, 9, 0, Math.PI * 2);
        CTX.fill();
        CTX.restore();
        CTX.save();
        CTX.translate(100, 64);
        CTX.filter = 'brightness(0) invert(1)';
        const FLASH_GRADIENT = CTX.createRadialGradient(0, 0, 0, 0, 0, 12);
        FLASH_GRADIENT.addColorStop(0, 'rgba(180,30,90,.6)');
        FLASH_GRADIENT.addColorStop(1, 'rgba(0,0,0,0)');
        CTX.fillStyle = FLASH_GRADIENT;
        CTX.beginPath();
        CTX.arc(0, 0, 12, 0, Math.PI * 2);
        CTX.fill();
        CTX.restore();
        CTX.withGroupOpacity(
            0.5,
            () => {
                CTX.fillStyle = '#ff0000';
                CTX.fillRect(8, 76, 20, 20);
            },
            {
                x: 8,
                y: 76,
                width: 20,
                height: 20,
            },
        );
        const STATS = CTX.endFrame(),
            RENDER_SUBMIT_MS = performance.now() - RENDER_STARTED;
        const PIXELS = {
            body: PIXEL(24, 24),
            outline: PIXEL(36, 24),
            flashBody: PIXEL(64, 24),
            flashOutline: PIXEL(76, 24),
            gradientCenter: PIXEL(100, 24),
            gradientMiddle: PIXEL(108, 24),
            gradientOuter: PIXEL(118, 24),
            whiteGradient: PIXEL(100, 64),
            whiteGradientAlpha: PIXEL(106, 64),
            group: PIXEL(16, 84),
        };
        const UPLOADS_BEFORE_NATIVE = DEVICE.stats.textureUploads,
            NATIVE_A = document.createElement('canvas'),
            NATIVE_B = document.createElement('canvas');
        NATIVE_A.width = NATIVE_A.height = NATIVE_B.width = NATIVE_B.height = 40;
        const TARGET = NATIVE_A.getContext('2d'),
            REFERENCE = NATIVE_B.getContext('2d');
        const TURN = (x, y) => [20 - (y - 20) * 0.8, 20 + (x - 20) * 0.8],
            COLORS = [0.18, 0.72, 0.38, 0.8],
            PAINTER = new PRIMITIVE_PAINTER(TARGET, {
                point: TURN,
                alphaMultiplier: 0.65,
            });
        const CSS = (c) =>
            `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
        const OLD_POLY = (ctx, points, color) => {
            const ALPHA = ctx.globalAlpha;
            ctx.fillStyle = CSS(color);
            ctx.globalAlpha = ALPHA * 0.65;
            ctx.beginPath();
            const A = TURN(points[0][0], points[0][1]);
            for (let i = 1; i < points.length - 1; i++) {
                const B = TURN(points[i][0], points[i][1]),
                    C = TURN(points[i + 1][0], points[i + 1][1]);
                ctx.moveTo(...A);
                ctx.lineTo(...B);
                ctx.lineTo(...C);
                ctx.closePath();
            }
            ctx.fill();
            ctx.globalAlpha = ALPHA;
        };
        const POLYGON = (x, y, r, n, rotation) =>
            Array.from(
                {
                    length: n,
                },
                (_, i) => [
                    x + Math.cos(rotation + (i / n) * Math.PI * 2) * r,
                    y + Math.sin(rotation + (i / n) * Math.PI * 2) * r,
                ],
            );
        const POLY = POLYGON(20, 20, 13, 7, 0.2),
            NATIVE_STARTED = performance.now();
        PAINTER.regularPolygon(20, 20, 13, COLORS, 7, 0.2);
        const DX = 9,
            DY = -4,
            W = 6,
            L = Math.hypot(DX, DY) || 1,
            NX = ((-DY / L) * W) / 2,
            NY = ((DX / L) * W) / 2;
        const QUAD = [
            [9 + NX, 12 + NY],
            [18 + NX, 8 + NY],
            [18 - NX, 8 - NY],
            [9 - NX, 12 - NY],
        ];
        PAINTER.line(9, 12, 18, 8, W, [0.9, 0.35, 0.12, 0.7]);
        const NATIVE_PAINTER_MS = performance.now() - NATIVE_STARTED;
        OLD_POLY(REFERENCE, POLY, COLORS);
        OLD_POLY(REFERENCE, QUAD, [0.9, 0.35, 0.12, 0.7]);
        const A = TARGET.getImageData(0, 0, 40, 40).data,
            B = REFERENCE.getImageData(0, 0, 40, 40).data;
        let canvasDiff = 0;
        for (let i = 0; i < A.length; i++) {
            if (A[i] !== B[i]) {
                canvasDiff++;
            }
        }
        const CANVAS_GPU_UPLOADS = DEVICE.stats.textureUploads - UPLOADS_BEFORE_NATIVE;
        const GL_ERROR = GL.getError(),
            RADIAL_LIFETIME = [];
        const CHECK = (ok, message) => {
            if (!ok) {
                throw new Error(message);
            }
        };
        // A revision must not recolor geometry queued before addColorStop().
        CTX.beginFrame();
        const REVISED = CTX.createRadialGradient(0, 0, 0, 0, 0, 1);
        REVISED.addColorStop(0, 'red');
        CTX.fillStyle = REVISED;
        CTX.fillRect(0, 0, 16, 16);
        REVISED.addColorStop(1, 'blue');
        CTX.fillRect(16, 0, 16, 16);
        CTX.endFrame();
        CHECK(
            PIXEL(8, 8).join() === '255,0,0,255' && PIXEL(24, 8).join() === '0,0,255,255',
            'gradient revision preserves queued painter order',
        );
        const TEXTURE_BASELINE = DEVICE.stats.textureCount;
        for (let frame = 0; frame < 4; frame++) {
            CTX.beginFrame({
                clearColor: [0, 0, 0, 0],
            });
            for (let i = 0; i < 4; i++) {
                const G = CTX.createRadialGradient(0, 0, 0, 0, 0, 5 + i),
                    X = 8 + i * 10,
                    Y = 108 + frame * 3;
                G.addColorStop(0, '#ff3010');
                G.addColorStop(1, '#2040ff00');
                CTX.fillStyle = G;
                CTX.beginPath();
                CTX.arc(X, Y, 5 + i, 0, Math.PI * 2);
                CTX.fill();
                const TEXTURE_AFTER_CREATE = DEVICE.stats.textureCount;
                G.addColorStop(0.5, '#00ff40');
                CTX.beginPath();
                CTX.arc(X, Y, 4 + i, 0, Math.PI * 2);
                CTX.fill();
                RADIAL_LIFETIME.push({
                    frame,
                    withinFrameIndex: i + 1,
                    textureBaseline: TEXTURE_BASELINE,
                    textureAfterCreate: TEXTURE_AFTER_CREATE,
                    textureAfterUpdate: DEVICE.stats.textureCount,
                    cacheAfterUpdate: CTX.stats().activeGradientTextureCount,
                });
            }
            CTX.endFrame();
            RADIAL_LIFETIME.at(-1).textureAfterEnd = DEVICE.stats.textureCount;
            RADIAL_LIFETIME.at(-1).cacheAfterEnd = CTX.stats().activeGradientTextureCount;
            RADIAL_LIFETIME.at(-1).textureBaseline = TEXTURE_BASELINE;
        }
        const DISPOSED_GRADIENT_PIXELS_CLEARED = GRADIENT.pixels === null && FLASH_GRADIENT.pixels === null;
        window.vectorGameCoverageProbe = {
            device: DEVICE,
            vector: VECTOR,
            ctx: CTX,
            canvas: CANVAS,
            gradient: GRADIENT,
        };
        return {
            pixels: PIXELS,
            stats: STATS,
            glError: GL_ERROR,
            renderSubmitMs: RENDER_SUBMIT_MS,
            nativePainterMs: NATIVE_PAINTER_MS,
            canvasDiff,
            canvasBytes: A.byteLength,
            canvasGpuUploads: CANVAS_GPU_UPLOADS,
            gradientRampBytes: 2 * 256 * 4,
            radialLifetime: RADIAL_LIFETIME,
            disposedGradientPixelsCleared: DISPOSED_GRADIENT_PIXELS_CLEARED,
        };
    });
    assert.deepEqual(RESULT.pixels.body, [24, 63, 206, 255]);
    assert.deepEqual(RESULT.pixels.outline, [22, 226, 119, 255]);
    assert.deepEqual(RESULT.pixels.flashBody, [128, 128, 128, 128]);
    assert.deepEqual(RESULT.pixels.flashOutline, [128, 128, 128, 128]);
    assert.ok(
        RESULT.pixels.gradientCenter[0] > 225 && RESULT.pixels.gradientCenter[1] < 30,
        `radial gradient center uses first stop: ${JSON.stringify(RESULT.pixels)}`,
    );
    assert.ok(
        RESULT.pixels.gradientMiddle[1] > 220 &&
            RESULT.pixels.gradientMiddle[1] > RESULT.pixels.gradientMiddle[0] &&
            RESULT.pixels.gradientMiddle[1] > RESULT.pixels.gradientMiddle[2],
        'radial gradient ramp refreshes after adding a stop',
    );
    assert.deepEqual(RESULT.pixels.gradientOuter, [0, 0, 0, 0], 'transparent gradient stop preserves zero alpha');
    assert.ok(
        RESULT.pixels.whiteGradient.every((c) => Math.abs(c - 144) <= 5),
        'white flash turns RGB white while preserving gradient alpha',
    );
    assert.ok(
        RESULT.pixels.whiteGradientAlpha[0] > RESULT.pixels.whiteGradient[0] / 2 - 8 &&
            RESULT.pixels.whiteGradientAlpha[0] < RESULT.pixels.whiteGradient[0] / 2 + 8,
        'gradient alpha ramps smoothly toward the transparent stop',
    );
    assert.deepEqual(RESULT.pixels.group, [128, 0, 0, 128]);
    assert.equal(RESULT.glError, 0);
    assert.equal(
        RESULT.canvasDiff,
        0,
        'native Canvas2D primitive target matches the authored fan reference pixel-for-pixel',
    );
    assert.equal(RESULT.canvasGpuUploads, 0, 'native UI paint target does not upload or rasterize through WebGL');
    assert.ok(
        RESULT.radialLifetime.length === 16 &&
            RESULT.radialLifetime.every(
                (x) =>
                    x.textureAfterCreate === x.textureBaseline + x.withinFrameIndex &&
                    x.textureAfterUpdate === x.textureAfterCreate &&
                    x.cacheAfterUpdate === x.withinFrameIndex,
            ) &&
            [0, 4, 8, 12].every(
                (i) =>
                    RESULT.radialLifetime[i + 3].textureAfterEnd === RESULT.radialLifetime[i].textureBaseline &&
                    RESULT.radialLifetime[i + 3].cacheAfterEnd === 0,
            ),
        `gradient handles are reused for repeated fills and released at every frame boundary: ${JSON.stringify(RESULT.radialLifetime)}`,
    );
    assert.equal(RESULT.disposedGradientPixelsCleared, true, 'frame eviction releases retained CPU ramps');
    RESULT.restored = await page.evaluate(() => {
        const P = vectorGameCoverageProbe;
        P.ctx.beginFrame();
        P.ctx.fillStyle = P.gradient;
        P.ctx.fillRect(0, 0, 16, 16);
        P.loss = P.device.gl.getExtension('WEBGL_lose_context');
        if (!P.loss) {
            P.ctx.endFrame();
            return false;
        }
        P.loss.loseContext();
        return true;
    });
    if (RESULT.restored) {
        await page.waitForFunction(() => vectorGameCoverageProbe.ctx.state === 'lost');
        assert.deepEqual(
            await page.evaluate(() => ({
                cache: vectorGameCoverageProbe.ctx.gradientTextures.size,
                queued: vectorGameCoverageProbe.vector.count,
            })),
            {
                cache: 0,
                queued: 0,
            },
        );
        await page.evaluate(() => vectorGameCoverageProbe.loss.restoreContext());
        await page.waitForFunction(() => vectorGameCoverageProbe.ctx.state === 'ready');
        assert.equal(
            await page.evaluate(() => {
                const P = vectorGameCoverageProbe;
                P.ctx.beginFrame();
                P.ctx.fillStyle = P.gradient;
                P.ctx.fillRect(0, 0, 16, 16);
                P.ctx.endFrame();
                return P.device.stats.textureUploads === 1 && P.device.gl.getError() === 0;
            }),
            true,
        );
    }
    RESULT.disposed = await page.evaluate(() => {
        const P = vectorGameCoverageProbe;
        const GRADIENTS = [...P.ctx.gradientTextures.keys()];
        P.ctx.dispose();
        if (GRADIENTS.some((g) => g.pixels !== null)) {
            throw new Error('dispose must release gradient rasters');
        }
        P.vector.dispose();
        P.device.dispose();
        P.canvas.remove();
        return (
            P.device.state === 'disposed' &&
            P.device.stats.gpuBufferBytes === 0 &&
            P.device.stats.textureCount === 0 &&
            P.device.stats.gpuRenderTargetBytes === 0
        );
    });
    assert.equal(RESULT.disposed, true);
    return RESULT;
}

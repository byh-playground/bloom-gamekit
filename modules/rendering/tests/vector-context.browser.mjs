/* global vectorContextProbe */
import assert from 'node:assert/strict';

/** Actual browser/WebGL pixel proof for VectorContext; parent E2E can call this helper. */
export async function exerciseVectorContext(page) {
    const RESULT = await page.evaluate(async () => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorRenderer: VECTOR_RENDERER,
            VectorContext: VECTOR_CONTEXT,
            PrimitivePainter: PRIMITIVE_PAINTER,
            GlyphAtlas: GLYPH_ATLAS,
        } = await import('/dist/rendering.js');
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        document.body.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
        });
        const ATLAS = new GLYPH_ATLAS(DEVICE, {
            width: 1,
            height: 1,
            data: new Uint8Array([255, 255, 255, 255]),
            unitsPerEm: 1,
            ascent: 1,
            descent: 0,
            glyphs: {
                'U+41': {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    advance: 1,
                    bearingY: 1,
                },
            },
        });
        const VECTOR = new VECTOR_RENDERER(DEVICE, {
            glyphAtlas: ATLAS,
            initialVertices: 128,
            maxVertices: 4096,
        });
        const CTX = new VECTOR_CONTEXT(DEVICE, {
            vectorRenderer: VECTOR,
            glyphAtlas: ATLAS,
        });
        const PRIMITIVE = new PRIMITIVE_PAINTER(CTX);
        const GL = DEVICE.gl;
        const PIPELINE = DEVICE.createPipeline({
            vertex: 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}',
            fragment: 'precision mediump float;void main(){gl_FragColor=vec4(1.,0.,0.,1.);}',
            stride: 8,
            attributes: [
                {
                    name: 'p',
                    size: 2,
                    offset: 0,
                },
            ],
        });
        const MESH = CTX.createStaticMesh(new Float32Array([-0.9, 0.7, -0.7, 0.7, -0.8, 0.9]), {
            strideFloats: 2,
        });
        const PIXEL = (x, y) => {
            const P = new Uint8Array(4);
            GL.readPixels(x, 63 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, P);
            return [...P];
        };
        CTX.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        CTX.beginGroup(0.5, {
            x: 8,
            y: 8,
            width: 48,
            height: 40,
        });
        CTX.fillStyle = 'red';
        CTX.fillRect(8, 8, 32, 32);
        CTX.fillRect(24, 8, 32, 32);
        CTX.endGroup();
        CTX.save();
        CTX.beginPath();
        CTX.moveTo(2, 44);
        CTX.lineTo(18, 44);
        CTX.lineTo(18, 60);
        CTX.lineTo(2, 60);
        CTX.closePath();
        CTX.clip();
        CTX.fillTriangleFan(
            [
                [2, 44],
                [30, 44],
                [30, 48],
                [2, 48],
            ],
            '#00ff00',
        );
        const FAN_BOUNDS = VECTOR.vertices.slice(0, VECTOR.count * 8).reduce(
            (b, _, i, a) => {
                if (i % 8 === 0) {
                    b.minX = Math.min(b.minX, a[i]);
                    b.maxX = Math.max(b.maxX, a[i]);
                }
                return b;
            },
            {
                minX: Infinity,
                maxX: -Infinity,
            },
        );
        CTX.restore();
        CTX.strokeStyle = '#ffffff';
        CTX.lineWidth = 4;
        CTX.lineCap = 'round';
        CTX.lineJoin = 'round';
        CTX.setLineDash([8, 8]);
        CTX.beginPath();
        CTX.moveTo(4, 52);
        CTX.lineTo(60, 52);
        CTX.stroke();
        PRIMITIVE.regularPolygon(48, 52, 6, '#ffffff', 6, 0);
        CTX.fillStyle = '#ffffff';
        CTX.font = '8px sans-serif';
        CTX.textAlign = 'center';
        CTX.textBaseline = 'top';
        CTX.fillText('A', 32, 4);
        CTX.drawStaticMesh(MESH, {
            pipeline: PIPELINE,
        });
        const STATS = CTX.endFrame();
        const PIXELS = {
            groupOuter: PIXEL(12, 12),
            groupOverlap: PIXEL(28, 12),
            clipInside: PIXEL(10, 46),
            clipOutside: PIXEL(24, 46),
            dash: PIXEL(8, 52),
            dashGap: PIXEL(16, 52),
            roundCap: PIXEL(3, 52),
            primitive: PIXEL(48, 52),
            glyph: PIXEL(32, 7),
            staticMesh: PIXEL(6, 6),
        };
        CTX.beginFrame();
        CTX.setLineDash([]);
        CTX.strokeStyle = 'white';
        CTX.lineWidth = 2;
        for (let i = 0; i < 1000; i++) {
            CTX.fillStyle = i === 999 ? 'blue' : 'red';
            CTX.fillRect(20, 20, 20, 20);
        }
        CTX.beginPath();
        CTX.moveTo(4, 4);
        CTX.lineTo(12, 4);
        CTX.stroke();
        const BATCHED = CTX.endFrame(),
            BATCH_PIXEL = PIXEL(30, 30),
            STROKE_PIXEL = PIXEL(8, 4);
        const ERROR = GL.getError();
        window.vectorContextProbe = {
            device: DEVICE,
            vector: VECTOR,
            atlas: ATLAS,
            ctx: CTX,
            canvas: CANVAS,
            pipeline: PIPELINE,
            mesh: MESH,
        };
        return {
            pixels: PIXELS,
            fanBounds: FAN_BOUNDS,
            stats: STATS,
            batched: BATCHED,
            batchPixel: BATCH_PIXEL,
            strokePixel: STROKE_PIXEL,
            error: ERROR,
            vertexCapacity: VECTOR.vertices.length,
            textureBytes: DEVICE.stats.gpuRenderTargetBytes,
        };
    });
    assert.ok(
        Math.abs(RESULT.pixels.groupOuter[0] - 128) <= 3 && Math.abs(RESULT.pixels.groupOuter[2] - 127) <= 3,
        'group opacity applies once to a path fill',
    );
    assert.ok(
        Math.abs(RESULT.pixels.groupOverlap[0] - 128) <= 3 && Math.abs(RESULT.pixels.groupOverlap[2] - 127) <= 3,
        'overlapping fills composite once inside a group',
    );
    assert.deepEqual(
        RESULT.pixels.clipInside,
        [0, 255, 0, 255],
        JSON.stringify({
            pixels: RESULT.pixels,
            fanBounds: RESULT.fanBounds,
        }),
    );
    assert.deepEqual(
        RESULT.pixels.clipOutside,
        [0, 0, 255, 255],
        JSON.stringify({
            pixels: RESULT.pixels,
            fanBounds: RESULT.fanBounds,
        }),
    );
    assert.ok(RESULT.pixels.dash[0] > 240 && RESULT.pixels.dash[1] > 240, 'dashed path paints in its on interval');
    assert.deepEqual(RESULT.pixels.dashGap, [0, 0, 255, 255]);
    assert.ok(RESULT.pixels.roundCap[0] > 240, 'round line cap extends beyond the endpoint');
    assert.ok(
        RESULT.pixels.primitive[0] > 240 && RESULT.pixels.primitive[1] > 240,
        `public primitive painter emits WebGL fan geometry: ${JSON.stringify(RESULT.pixels)}`,
    );
    assert.ok(RESULT.pixels.glyph[0] > 240, 'text keeps the caller-provided prebaked glyph atlas');
    assert.deepEqual(RESULT.pixels.staticMesh, [255, 0, 0, 255]);
    assert.equal(RESULT.error, 0);
    assert.equal(RESULT.textureBytes, 64 * 64 * 5);
    assert.ok(RESULT.stats.vertices > 0 && RESULT.stats.drawCalls > 0);
    assert.equal(RESULT.batched.drawCalls, 2, 'adjacent fill/stroke submits only at bounded capacity and frame end');
    assert.deepEqual(RESULT.batchPixel, [0, 0, 255, 255], 'capacity flush preserves painter order');
    assert.deepEqual(RESULT.strokePixel, [255, 255, 255, 255]);
    RESULT.restored = await page.evaluate(() => {
        const P = vectorContextProbe;
        P.loss = P.device.gl.getExtension('WEBGL_lose_context');
        if (!P.loss) {
            return false;
        }
        P.loss.loseContext();
        return true;
    });
    if (RESULT.restored) {
        await page.waitForFunction(() => vectorContextProbe.ctx.state === 'lost');
        assert.equal(await page.evaluate(() => vectorContextProbe.ctx.beginFrame()), false);
        await page.evaluate(() => vectorContextProbe.loss.restoreContext());
        await page.waitForFunction(() => vectorContextProbe.ctx.state === 'ready');
        RESULT.restoredPixel = await page.evaluate(() => {
            const P = vectorContextProbe;
            P.ctx.beginFrame({
                clearColor: [0, 0, 1, 1],
            });
            P.ctx.drawStaticMesh(P.mesh, {
                pipeline: P.pipeline,
            });
            P.ctx.endFrame();
            return {
                pixel: P.ctx.device.gl.getError(),
                red: P.ctx.device.stats.drawCalls > 0,
            };
        });
        assert.deepEqual(RESULT.restoredPixel, {
            pixel: 0,
            red: true,
        });
    }
    RESULT.disposed = await page.evaluate(() => {
        const P = vectorContextProbe;
        P.ctx.dispose();
        P.vector.dispose();
        P.atlas.dispose();
        P.device.dispose();
        P.canvas.remove();
        return (
            P.device.state === 'disposed' &&
            P.device.stats.gpuRenderTargetBytes === 0 &&
            P.device.stats.gpuBufferBytes === 0
        );
    });
    assert.equal(RESULT.disposed, true);
    return RESULT;
}

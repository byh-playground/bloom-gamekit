/* global deviceProbe, vectorProbe */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FULL_FRAGMENT_SHA256 = '228e33dc1542b24388634c424769f6d5c105fba4e7bb9dbdb4d3e5fef0f2ab56';

/** Continues the same browser/built-module E2E; no fake GL or retained screenshots. */
export async function exerciseWebGLDevice(page) {
    const RESULT = await page.evaluate(async () => {
        const { WebGLDevice: WEB_GL_DEVICE } = await import('/dist/rendering.js');
        const CHECK = (x, m) => {
            if (!x) {
                throw new Error(m);
            }
        };
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        document.body.append(CANVAS);
        const NATIVE_GET_CONTEXT = CANVAS.getContext.bind(CANVAS);
        let contextRequest;
        CANVAS.getContext = (kind, options) => {
            contextRequest = {
                kind,
                options,
            };
            return NATIVE_GET_CONTEXT(kind, options);
        };
        const D = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
            maxBufferBytes: 65536,
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false,
        });
        const GL = D.gl;
        CHECK(
            contextRequest.kind === 'webgl2' &&
                contextRequest.options.powerPreference === 'high-performance' &&
                contextRequest.options.failIfMajorPerformanceCaveat === false,
            'consumer GPU preference forwarded to real WebGL context',
        );
        const PIXEL = (x = 32, y = 32) => {
            const P = new Uint8Array(4);
            GL.readPixels(x, 63 - y, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, P);
            return [...P];
        };
        const NEAR = (a, b, m) =>
            CHECK(
                a.every((x, i) => Math.abs(x - b[i]) < 3),
                `${m}: ${a} expected ${b}`,
            );
        const PIPELINE = D.createPipeline({
            vertex: 'attribute vec3 p;attribute vec4 c;uniform mat3 m;varying vec4 color;void main(){vec3 q=m*vec3(p.xy,1.0);gl_Position=vec4(q.xy,p.z,1.0);color=c;}',
            fragment: 'precision mediump float;varying vec4 color;void main(){gl_FragColor=color;}',
            stride: 28,
            attributes: [
                {
                    name: 'p',
                    size: 3,
                    offset: 0,
                },
                {
                    name: 'c',
                    size: 4,
                    offset: 12,
                },
            ],
            uniforms: {
                m: 'matrix3fv',
            },
        });
        const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        const UNIFORMS = {
            m: IDENTITY,
        };
        const BUFFER = D.createVertexBuffer({
            capacityBytes: 28 * 6,
        });
        function rect(x0, y0, x1, y1, z, c) {
            const OUT = [];
            for (const [X, Y] of [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y0],
                [x1, y1],
                [x0, y1],
            ]) {
                OUT.push(X, Y, z, ...c);
            }
            return new Float32Array(OUT);
        }
        const RED = rect(-1, -1, 1, 1, -0.5, [1, 0, 0, 1]),
            BLUE = rect(-1, -1, 1, 1, 0.5, [0, 0, 1, 1]),
            GREEN = rect(-1, -1, 1, 1, 0.8, [0, 1, 0, 1]);
        D.beginFrame();
        D.uploadVertices(BUFFER, BLUE);
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            depth: {
                func: 'lequal',
            },
        });
        D.uploadVertices(BUFFER, RED);
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            depth: {
                func: 'lequal',
            },
        });
        D.uploadVertices(BUFFER, GREEN);
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            depth: {
                func: 'lequal',
            },
        });
        NEAR(PIXEL(), [255, 0, 0, 255], 'depth LEQUAL rejects farther pass');
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            depth: {
                func: 'greater',
                write: false,
            },
        });
        NEAR(PIXEL(), [0, 255, 0, 255], 'GREATER silhouette pass');
        D.endFrame();
        D.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        D.uploadVertices(BUFFER, rect(-1, -1, 0, 1, 0, [1, 1, 1, 1]));
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            colorMask: [false, false, false, false],
            stencil: {
                func: 'equal',
                ref: 0,
                pass: 'increment',
            },
        });
        D.uploadVertices(BUFFER, RED);
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            stencil: {
                func: 'equal',
                ref: 1,
                writeMask: 0,
            },
        });
        NEAR(PIXEL(16, 32), [255, 0, 0, 255], 'stencil clipped left');
        NEAR(PIXEL(48, 32), [0, 0, 255, 255], 'stencil excludes right');
        D.clear({
            stencil: 0,
        });
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            stencil: {
                func: 'equal',
                ref: 1,
                writeMask: 0,
            },
        });
        NEAR(PIXEL(48, 32), [0, 0, 255, 255], 'explicit stencil clear');
        D.endFrame();
        D.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        D.uploadVertices(BUFFER, rect(-1, -1, 1, 1, 0, [1, 0, 0, 0.5]));
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            blend: 'straight-alpha',
        });
        NEAR(PIXEL(), [128, 0, 128, 255], 'straight-alpha Rally material');
        D.endFrame();

        // Shader/material policy stays game-owned: same resource core binds FPV11 gradients/white mask.
        const BATCH = D.createPipeline({
            vertex: 'attribute vec2 p;attribute vec2 uv;attribute vec4 c;attribute float slot;attribute float mode;attribute float white;varying vec2 t;varying vec4 color;varying float s;varying float m;varying float w;void main(){gl_Position=vec4(p,0.,1.);t=uv;color=c;s=slot;m=mode;w=white;}',
            fragment:
                'precision mediump float;varying vec2 t;varying vec4 color;varying float s;varying float m;varying float w;uniform sampler2D tex[2];void main(){vec2 uv=m>1.5?vec2(clamp(length(t),0.,1.),.5):t;vec4 a=vec4(1.);if(m>.5){if(s<.5)a=texture2D(tex[0],uv);else a=texture2D(tex[1],uv);}a.rgb=mix(a.rgb,vec3(a.a),w);gl_FragColor=vec4(a.rgb*color.rgb,a.a)*color.a;}',
            stride: 44,
            attributes: [
                {
                    name: 'p',
                    size: 2,
                    offset: 0,
                },
                {
                    name: 'uv',
                    size: 2,
                    offset: 8,
                },
                {
                    name: 'c',
                    size: 4,
                    offset: 16,
                },
                {
                    name: 'slot',
                    size: 1,
                    offset: 32,
                },
                {
                    name: 'mode',
                    size: 1,
                    offset: 36,
                },
                {
                    name: 'white',
                    size: 1,
                    offset: 40,
                },
            ],
            uniforms: {
                'tex[0]': '1iv',
            },
        });
        const BYTES = {
            width: 2,
            height: 1,
            data: new Uint8Array([255, 0, 0, 128, 0, 255, 0, 255]),
        };
        const IMAGE_STATS = () => [D.stats.imageTexUploadCount, D.stats.imageTexUploadBytes];
        const IMAGE_DELTA = (before, count, bytes, label) => {
            const AFTER = IMAGE_STATS();
            CHECK(
                AFTER[0] - before[0] === count && AFTER[1] - before[1] === bytes,
                `${label}: image uploads ${AFTER}, before ${before}, expected +${count}/+${bytes}`,
            );
        };
        const BEFORE_IMAGE_CREATE = IMAGE_STATS();
        const TEXTURE = D.createTexture(BYTES, {
            filter: 'nearest',
        });
        const SECOND = D.createTexture(
            {
                width: 1,
                height: 1,
                data: new Uint8Array([0, 0, 255, 255]),
            },
            {
                filter: 'nearest',
            },
        );
        IMAGE_DELTA(BEFORE_IMAGE_CREATE, 2, 12, 'RGBA byte image creation');
        const ARENA = D.createVertexBuffer();
        function quad(slot, mode, white, u = 0.25) {
            const OUT = [];
            for (const [X, Y] of [
                [-1, -1],
                [1, -1],
                [1, 1],
                [-1, -1],
                [1, 1],
                [-1, 1],
            ]) {
                OUT.push(X, Y, u, 0.5, 1, 1, 1, 1, slot, mode, white);
            }
            return new Float32Array(OUT);
        }
        const COMMAND = {
            pipeline: BATCH,
            buffer: ARENA,
            count: 6,
            uniforms: {
                'tex[0]': new Int32Array([0, 1]),
            },
            textures: [TEXTURE, SECOND],
        };
        D.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        D.uploadVertices(ARENA, quad(0, 1, 0));
        D.draw(COMMAND);
        NEAR(PIXEL(), [128, 0, 127, 255], 'FPV11 premultiplied texel');
        D.uploadVertices(ARENA, quad(1, 1, 1));
        D.draw(COMMAND);
        NEAR(PIXEL(), [255, 255, 255, 255], 'second texture white-flash mask');
        D.uploadVertices(ARENA, quad(0, 2, 0, 0.8));
        D.draw(COMMAND);
        NEAR(PIXEL(), [0, 255, 0, 255], 'radial gradient lookup');
        D.endFrame();
        BYTES.data.set([0, 0, 255, 255], 0);
        const BEFORE_BYTE_UPDATE = IMAGE_STATS();
        D.updateTexture(TEXTURE, BYTES, {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
        IMAGE_DELTA(BEFORE_BYTE_UPDATE, 1, 4, 'one-pixel RGBA image update');
        D.beginFrame();
        D.uploadVertices(ARENA, quad(0, 1, 0));
        D.draw(COMMAND);
        NEAR(PIXEL(), [0, 0, 255, 255], 'partial byte atlas update');
        D.endFrame();
        const DOM = document.createElement('canvas');
        DOM.width = 2;
        DOM.height = 1;
        const CTX = DOM.getContext('2d');
        CTX.fillStyle = 'red';
        CTX.fillRect(0, 0, 2, 1);
        const BEFORE_DOM_UPLOAD = IMAGE_STATS();
        const DOM_TEXTURE = D.createTexture(DOM, {
            filter: 'nearest',
        });
        CTX.fillStyle = 'lime';
        CTX.fillRect(0, 0, 1, 1);
        D.updateTexture(DOM_TEXTURE, DOM, {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        });
        IMAGE_DELTA(BEFORE_DOM_UPLOAD, 2, 12, 'DOM image create and one-pixel update');
        COMMAND.textures[0] = DOM_TEXTURE;
        D.beginFrame();
        D.uploadVertices(ARENA, quad(0, 1, 0));
        D.draw(COMMAND);
        NEAR(PIXEL(), [0, 255, 0, 255], 'partial DOM atlas update');
        D.endFrame();
        const FOG = D.createPipeline({
            vertex: 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}',
            fragment:
                'precision mediump float;uniform sampler2D previous;uniform sampler2D next;uniform float transition;void main(){float v=mix(texture2D(previous,vec2(.5)).r,texture2D(next,vec2(.5)).r,transition);gl_FragColor=vec4(v,0.,0.,1.);}',
            stride: 8,
            attributes: [
                {
                    name: 'p',
                    size: 2,
                    offset: 0,
                },
            ],
            uniforms: {
                previous: '1i',
                next: '1i',
                transition: '1f',
            },
        });
        const FULL = D.createVertexBuffer();
        D.uploadVertices(FULL, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]));
        const BEFORE_LUMINANCE = IMAGE_STATS();
        const DARK = D.createTexture(
                {
                    width: 3,
                    height: 1,
                    data: new Uint8Array([0, 0, 0]),
                },
                {
                    format: 'luminance',
                },
            ),
            LIGHT = D.createTexture(
                {
                    width: 3,
                    height: 1,
                    data: new Uint8Array([255, 255, 255]),
                },
                {
                    format: 'luminance',
                },
            );
        IMAGE_DELTA(BEFORE_LUMINANCE, 2, 6, 'luminance image creation');
        D.beginFrame();
        D.draw({
            pipeline: FOG,
            buffer: FULL,
            count: 6,
            uniforms: {
                previous: 0,
                next: 1,
                transition: 0.5,
            },
            textures: [DARK, LIGHT],
        });
        NEAR(PIXEL(), [128, 0, 0, 255], 'two NPOT luminance fog masks');
        const BEFORE_GPU_ONLY = IMAGE_STATS();
        const COPIED = D.createTexture({
            width: 64,
            height: 64,
            data: null,
        });
        D.copyFrameToTexture(COPIED);
        const NUMERIC = D.createDataTexture(2, 1, { data: new Float32Array(8) });
        D.updateDataTexture(NUMERIC, new Float32Array(4), { x: 1, y: 0, width: 1, height: 1 });
        const TARGET = D.createRenderTarget(2, 1, { stencil: false });
        D.bindRenderTarget(TARGET);
        D.clear({ color: [0, 0, 0, 0] });
        D.unbindRenderTarget(TARGET);
        IMAGE_DELTA(BEFORE_GPU_ONLY, 0, 0, 'numeric data, empty render target and GPU copy excluded');
        D.deleteRenderTarget(TARGET);
        D.deleteTexture(NUMERIC);
        NEAR(PIXEL(), [128, 0, 0, 255], 'framebuffer remains after GPU copy');
        D.clear({
            color: [0, 0, 0, 1],
        });
        COMMAND.textures[0] = COPIED;
        D.uploadVertices(ARENA, quad(0, 1, 0, 0.5));
        D.draw(COMMAND);
        NEAR(PIXEL(), [128, 0, 0, 255], 'GPU-resolved frame composition copy');
        D.endFrame();
        // Texture shrink explicitly clears previous units; later solid-only draws bind none.
        const NATIVE_BIND = GL.bindTexture.bind(GL);
        let bindings = 0;
        GL.bindTexture = (...args) => {
            bindings++;
            return NATIVE_BIND(...args);
        };
        D.beginFrame();
        D.uploadVertices(BUFFER, RED);
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            blend: false,
        });
        const FIRST_SOLID_BINDINGS = bindings;
        D.draw({
            pipeline: PIPELINE,
            buffer: BUFFER,
            count: 6,
            uniforms: UNIFORMS,
            blend: false,
        });
        CHECK(
            FIRST_SOLID_BINDINGS === 2 && bindings === FIRST_SOLID_BINDINGS,
            'two old texture units cleared once, none rebound on solid draw',
        );
        NEAR(PIXEL(), [255, 0, 0, 255], 'solid draw after texture shrink');
        D.endFrame();
        GL.bindTexture = NATIVE_BIND;
        CHECK(GL.getError() === GL.NO_ERROR, 'device GL errors');
        // Production updates/copies do not synchronously poll GL errors after allocation.
        const NATIVE_GET_ERROR = GL.getError.bind(GL);
        let productionErrorPolls = 0;
        GL.getError = () => {
            productionErrorPolls++;
            return NATIVE_GET_ERROR();
        };
        try {
            for (let i = 0; i < 3; i++) {
                D.beginFrame();
                D.updateTexture(DARK, {
                    width: 3,
                    height: 1,
                    data: new Uint8Array([0, 0, 0]),
                });
                D.copyFrameToTexture(COPIED);
                D.endFrame();
            }
            CHECK(productionErrorPolls === 0, 'steady production upload/copy must not poll GL errors');
        } finally {
            GL.getError = NATIVE_GET_ERROR;
        }
        CHECK(GL.getError() === GL.NO_ERROR, 'production operations remain GL-error free');
        // Opt-in diagnostics still polls and reports a real incomplete-framebuffer error.
        const DIAGNOSTIC_CANVAS = document.createElement('canvas');
        DIAGNOSTIC_CANVAS.width = DIAGNOSTIC_CANVAS.height = 4;
        const DIAGNOSTIC = new WEB_GL_DEVICE(DIAGNOSTIC_CANVAS, {
            alpha: false,
            antialias: false,
            checkGLErrors: true,
        });
        const DG = DIAGNOSTIC.gl;
        const UPLOAD = {
                width: 4,
                height: 4,
                data: new Uint8Array(64),
            },
            DT = DIAGNOSTIC.createTexture(UPLOAD),
            DC = DIAGNOSTIC.createTexture({
                width: 4,
                height: 4,
                data: null,
            });
        DIAGNOSTIC.beginFrame();
        DIAGNOSTIC.copyFrameToTexture(DC);
        DIAGNOSTIC.endFrame();
        const DIAGNOSTIC_GET_ERROR = DG.getError.bind(DG);
        let diagnosticErrorPolls = 0;
        DG.getError = () => {
            diagnosticErrorPolls++;
            return DIAGNOSTIC_GET_ERROR();
        };
        DIAGNOSTIC.beginFrame();
        DIAGNOSTIC.updateTexture(DT, UPLOAD);
        DIAGNOSTIC.copyFrameToTexture(DC);
        DIAGNOSTIC.endFrame();
        CHECK(diagnosticErrorPolls === 2, 'opt-in diagnostics checks each upload/copy');
        const INCOMPLETE = DG.createFramebuffer();
        let diagnosed = false;
        try {
            DG.bindFramebuffer(DG.FRAMEBUFFER, INCOMPLETE);
            DIAGNOSTIC.copyFrameToTexture(DC);
        } catch (error) {
            diagnosed = /Framebuffer copy error/.test(error.message);
        } finally {
            DG.bindFramebuffer(DG.FRAMEBUFFER, null);
            DG.deleteFramebuffer(INCOMPLETE);
            DG.getError = DIAGNOSTIC_GET_ERROR;
        }
        CHECK(diagnosed, 'diagnostics must report real incomplete-framebuffer copy failure');
        CHECK(DG.getError() === DG.NO_ERROR, 'diagnostic failure drained and isolated');
        DIAGNOSTIC.dispose();
        const BEFORE = D.stats.bufferAllocations;
        D.beginFrame();
        D.uploadVertices(ARENA, quad(0, 1, 0));
        D.draw(COMMAND);
        const STATS = {
            ...D.endFrame(),
        };
        CHECK(BEFORE === D.stats.bufferAllocations, 'steady upload reuses GPU allocation');
        let invalidRejected = false;
        try {
            D.createPipeline({
                vertex: 'invalid shader',
                fragment: 'void main(){}',
                stride: 8,
                attributes: [
                    {
                        name: 'p',
                        size: 2,
                        offset: 0,
                    },
                ],
            });
        } catch {
            invalidRejected = true;
        }
        CHECK(invalidRejected, 'shader failures must be explicit');
        window.deviceProbe = {
            d: D,
            canvas: CANVAS,
            texture: TEXTURE,
            command: COMMAND,
            arena: ARENA,
            quad,
            pixel: PIXEL,
            full: FULL,
            domTexture: DOM_TEXTURE,
            imageBeforeRestore: IMAGE_STATS(),
        };
        return {
            productionErrorPolls,
            diagnosticErrorPolls,
            diagnosed,
            contextOptions: contextRequest.options,
            depth: true,
            stencil: true,
            straightAlpha: true,
            multitexture: true,
            radialWhiteMask: true,
            partialAtlas: true,
            luminanceFog: true,
            frameCopy: true,
            imageUploads: IMAGE_STATS(),
            stats: STATS,
            invalidRejected,
        };
    });
    const LOSS = await page.evaluate(() => {
        deviceProbe.loss = deviceProbe.d.gl.getExtension('WEBGL_lose_context');
        if (!deviceProbe.loss) {
            return false;
        }
        deviceProbe.loss.loseContext();
        return true;
    });
    assert.equal(LOSS, true, 'WEBGL_lose_context is required for two restoration cycles');
    {
        await page.waitForFunction(() => deviceProbe.d.state === 'lost');
        assert.equal(await page.evaluate(() => deviceProbe.d.beginFrame()), false);
        await page.evaluate(() => deviceProbe.loss.restoreContext());
        await page.waitForFunction(() => deviceProbe.d.state === 'ready');
        const RESTORED = await page.evaluate(() => {
            const P = deviceProbe;
            P.d.beginFrame();
            P.command.textures[0] = P.domTexture;
            P.d.uploadVertices(P.arena, P.quad(0, 1, 0));
            P.d.draw(P.command);
            P.d.endFrame();
            return {
                pixel: P.pixel(),
                error: P.d.gl.getError(),
                restores: P.d.stats.restores,
                imageUploadDelta: [
                    P.d.stats.imageTexUploadCount - P.imageBeforeRestore[0],
                    P.d.stats.imageTexUploadBytes - P.imageBeforeRestore[1],
                ],
            };
        });
        assert.deepEqual(RESTORED, {
            pixel: [0, 255, 0, 255],
            error: 0,
            restores: 1,
            imageUploadDelta: [5, 26],
        });
    }
    RESULT.restoration = LOSS;
    RESULT.disposed = await page.evaluate(() => {
        const D = deviceProbe.d;
        D.dispose();
        D.dispose();
        deviceProbe.canvas.remove();
        return D.state === 'disposed' && D.stats.pipelineCount === 0 && D.stats.gpuBufferBytes === 0;
    });
    assert.equal(RESULT.disposed, true);
    return RESULT;
}

/** Stable path/text/group-opacity scenario over an actual WebGL2 framebuffer. */
export async function exerciseVectorRenderer(page) {
    const SOURCE = await readFile(new URL('../vector-renderer.js', import.meta.url), 'utf8');
    const FRAGMENT = SOURCE.match(/^const FRAGMENT = `([\s\S]*?)`;/m)?.[1];
    assert.ok(FRAGMENT, 'the original two-circle radial fragment remains present');
    assert.equal(
        createHash('sha256').update(FRAGMENT.replaceAll('\r\n', '\n')).digest('hex'),
        FULL_FRAGMENT_SHA256,
        'the existing radial fragment must remain byte-identical',
    );
    const RESULT = await page.evaluate(async () => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorRenderer: VECTOR_RENDERER,
            GlyphAtlas: GLYPH_ATLAS,
        } = await import('/dist/rendering.js');
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        document.body.append(CANVAS);
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: true,
            antialias: false,
            preserveDrawingBuffer: true,
            stencil: true,
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
        const RESOURCE_KEYS = [
            'pipelineCount',
            'bufferCount',
            'textureCount',
            'renderTargetCount',
            'gpuBufferBytes',
            'gpuRenderTargetBytes',
        ];
        const RESOURCE_SNAPSHOT = () => Object.fromEntries(RESOURCE_KEYS.map((key) => [key, DEVICE.stats[key]]));
        const RESOURCE_BASELINE = RESOURCE_SNAPSHOT();
        const RENDERER = new VECTOR_RENDERER(DEVICE, {
            glyphAtlas: ATLAS,
            initialVertices: 128,
            maxVertices: 2048,
        });
        const FULL_RECORD = DEVICE.pipelines.get(RENDERER.pipeline),
            NON_RADIAL_RECORD = DEVICE.pipelines.get(RENDERER.nonRadialPipeline),
            EXPECTED_FULL_UNIFORMS = [
                'u_projection',
                'u_radial',
                'u_radial_params',
                'u_texture',
                'u_textured',
                'u_whiteFlash',
            ],
            EXPECTED_NON_RADIAL_UNIFORMS = ['u_projection', 'u_texture', 'u_textured', 'u_whiteFlash'];
        const PIPELINE_DESCRIPTORS = {
            count: DEVICE.stats.pipelineCount - RESOURCE_BASELINE.pipelineCount,
            fullUniforms: Object.keys(FULL_RECORD.uniforms).sort(),
            nonRadialUniforms: Object.keys(NON_RADIAL_RECORD.uniforms).sort(),
            sameVertex: FULL_RECORD.vertex === NON_RADIAL_RECORD.vertex,
            sameStride: FULL_RECORD.stride === NON_RADIAL_RECORD.stride && NON_RADIAL_RECORD.stride === 32,
            sameAttributes: JSON.stringify(FULL_RECORD.attributes) === JSON.stringify(NON_RADIAL_RECORD.attributes),
        };
        if (
            PIPELINE_DESCRIPTORS.count !== 3 ||
            JSON.stringify(PIPELINE_DESCRIPTORS.fullUniforms) !== JSON.stringify(EXPECTED_FULL_UNIFORMS) ||
            JSON.stringify(PIPELINE_DESCRIPTORS.nonRadialUniforms) !== JSON.stringify(EXPECTED_NON_RADIAL_UNIFORMS) ||
            !PIPELINE_DESCRIPTORS.sameVertex ||
            !PIPELINE_DESCRIPTORS.sameStride ||
            !PIPELINE_DESCRIPTORS.sameAttributes
        ) {
            throw new Error(`unexpected vector pipeline descriptors: ${JSON.stringify(PIPELINE_DESCRIPTORS)}`);
        }
        const PIXEL = (x, y) => {
            const P = new Uint8Array(4);
            DEVICE.gl.readPixels(x, 63 - y, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, P);
            return [...P];
        };
        DEVICE.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        RENDERER.beginGroup(0.5, {
            x: 12,
            y: 12,
            width: 44,
            height: 32,
        });
        RENDERER.polygon(
            [
                [12, 12],
                [44, 12],
                [44, 44],
                [12, 44],
            ],
            [1, 0, 0, 1],
        );
        RENDERER.polygon(
            [
                [24, 12],
                [56, 12],
                [56, 44],
                [24, 44],
            ],
            [1, 0, 0, 1],
        );
        RENDERER.beginGroup(0.5, {
            x: 24,
            y: 12,
            width: 8,
            height: 8,
        });
        RENDERER.polygon(
            [
                [24, 12],
                [32, 12],
                [32, 20],
                [24, 20],
            ],
            [0, 1, 0, 1],
        );
        RENDERER.flush();
        const NESTED_TARGET = new Uint8Array(4);
        DEVICE.gl.readPixels(4, 3, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, NESTED_TARGET);
        RENDERER.endGroup();
        const PARENT_TARGET = new Uint8Array(4);
        DEVICE.gl.readPixels(16, 27, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PARENT_TARGET);
        RENDERER.endGroup();
        RENDERER.save();
        RENDERER.clipRect(2, 48, 24, 12);
        RENDERER.beginPath();
        RENDERER.moveTo(2, 60);
        RENDERER.quadraticCurveTo(16, 42, 30, 60, 16);
        RENDERER.stroke([0, 1, 0, 1], 2);
        RENDERER.restore();
        RENDERER.beginPath();
        RENDERER.moveTo(2, 2);
        RENDERER.lineTo(20, 2);
        RENDERER.lineTo(20, 20);
        RENDERER.lineTo(2, 20);
        RENDERER.closePath();
        RENDERER.moveTo(6, 6);
        RENDERER.lineTo(16, 6);
        RENDERER.lineTo(16, 16);
        RENDERER.lineTo(6, 16);
        RENDERER.closePath();
        RENDERER.fill([0, 1, 0, 1], 'evenodd');
        RENDERER.fillText('A', 48, 50, {
            fontSize: 8,
            align: 'center',
            baseline: 'top',
            color: [1, 1, 1, 1],
        });
        RENDERER.flush();
        const STATS = {
                ...DEVICE.stats,
            },
            OVERLAP = PIXEL(30, 24),
            OUTER = PIXEL(16, 24),
            NESTED = PIXEL(28, 16),
            LABEL = PIXEL(48, 53),
            CLIPPED = PIXEL(28, 55),
            HOLE = PIXEL(10, 10),
            MEASURE = RENDERER.measureText('A', {
                fontSize: 8,
                align: 'center',
            }),
            ERROR = DEVICE.gl.getError();
        DEVICE.endFrame();
        const GRADIENT_TEXTURE = DEVICE.createTexture(
            {
                width: 2,
                height: 1,
                data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
            },
            {
                format: 'rgba',
                premultiplied: true,
                filter: 'nearest',
            },
        );
        const LINEAR_A = {
                texture: GRADIENT_TEXTURE,
                gradient: {},
                matrixInverse: [1, 0, 0, 1, 0, 0],
                x0: 0,
                y0: 0,
                x1: 64,
                y1: 0,
                color: [1, 1, 1, 1],
            },
            RADIAL = {
                ...LINEAR_A,
                gradient: {},
                radialScale: 64,
                radialParams: [0.25, 0.1, 0.08, 0.9],
            },
            LINEAR_B = {
                ...LINEAR_A,
                gradient: {},
                whiteFlash: true,
            },
            RADIAL_EMPTY = {
                ...RADIAL,
                gradient: {},
                radialEmpty: true,
            };
        const DRAW_TRIANGLE = (target, x, y, kind, gradient = null) => {
            target.beginPath();
            target.moveTo(x, y);
            target.lineTo(x + 14, y);
            target.lineTo(x + 7, y + 12);
            target.closePath();
            if (kind === 'solid') {
                target.fill([0.9, 0.2, 0.1, 1]);
            } else if (kind === 'radial') {
                target.fillRadialGradient(gradient);
            } else {
                target.fillLinearGradient(gradient);
            }
        };
        const FRAME_FIXTURE = (legacy = false) => {
            const DRAWS = [],
                UPLOADS = [],
                ORIGINAL_DRAW = DEVICE.draw,
                ORIGINAL_UPLOAD = DEVICE.uploadVertices;
            DEVICE.draw = function (command) {
                if (command.buffer === RENDERER.buffer) {
                    const ROLE =
                            command.pipeline === RENDERER.pipeline
                                ? 'radial'
                                : command.pipeline === RENDERER.nonRadialPipeline
                                  ? 'non-radial'
                                  : 'unexpected',
                        TEXTURE = command.textures[0];
                    DRAWS.push({
                        role: ROLE,
                        count: command.count,
                        uniformKeys: Object.keys(command.uniforms).sort(),
                        radial: command.uniforms.u_radial ?? null,
                        textured: command.uniforms.u_textured,
                        whiteFlash: command.uniforms.u_whiteFlash,
                        texture:
                            TEXTURE === RENDERER.white
                                ? 'white'
                                : TEXTURE === ATLAS.texture
                                  ? 'glyph'
                                  : TEXTURE === GRADIENT_TEXTURE
                                    ? 'gradient'
                                    : 'group-target',
                    });
                    if (legacy && ROLE === 'non-radial') {
                        return ORIGINAL_DRAW.call(this, {
                            ...command,
                            pipeline: RENDERER.pipeline,
                            uniforms: {
                                ...command.uniforms,
                                u_radial: 0,
                                u_radial_params: [0, 0, 0, 0],
                            },
                        });
                    }
                }
                return ORIGINAL_DRAW.call(this, command);
            };
            DEVICE.uploadVertices = function (buffer, data) {
                if (buffer === RENDERER.buffer) {
                    UPLOADS.push(data.length / 8);
                }
                return ORIGINAL_UPLOAD.call(this, buffer, data);
            };
            try {
                DEVICE.beginFrame({
                    clearColor: [0, 0, 1, 1],
                });
                const START = {
                    submissions: DEVICE.stats.vectorSubmissions,
                    uploads: DEVICE.stats.bufferUploads,
                };
                DRAW_TRIANGLE(RENDERER, 4, 3, 'solid');
                DRAW_TRIANGLE(RENDERER, 24, 3, 'radial', RADIAL);
                DRAW_TRIANGLE(RENDERER, 44, 3, 'solid');
                DRAW_TRIANGLE(RENDERER, 4, 24, 'linear', LINEAR_A);
                DRAW_TRIANGLE(RENDERER, 24, 24, 'radial', RADIAL);
                DRAW_TRIANGLE(RENDERER, 44, 24, 'linear', LINEAR_B);
                DRAW_TRIANGLE(RENDERER, 4, 44, 'radial', RADIAL_EMPTY);
                RENDERER.beginGroup(0.5, {
                    x: 20,
                    y: 40,
                    width: 30,
                    height: 20,
                });
                RENDERER.polygon(
                    [
                        [20, 40],
                        [40, 40],
                        [40, 58],
                        [20, 58],
                    ],
                    [1, 0, 0, 1],
                );
                RENDERER.polygon(
                    [
                        [28, 40],
                        [48, 40],
                        [48, 58],
                        [28, 58],
                    ],
                    [1, 0, 0, 1],
                );
                RENDERER.endGroup();
                RENDERER.fillText('A', 52, 48, {
                    fontSize: 8,
                    align: 'left',
                    baseline: 'top',
                    color: [1, 1, 1, 1],
                });
                RENDERER.flush();
                const PIXELS = new Uint8Array(64 * 64 * 4);
                DEVICE.gl.readPixels(0, 0, 64, 64, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
                const DELTA = {
                    submissions: DEVICE.stats.vectorSubmissions - START.submissions,
                    uploads: DEVICE.stats.bufferUploads - START.uploads,
                };
                DEVICE.endFrame();
                return {
                    pixels: Array.from(PIXELS),
                    draws: DRAWS,
                    uploads: UPLOADS,
                    delta: DELTA,
                    radialEmptyPixel: PIXEL(10, 50),
                };
            } finally {
                DEVICE.draw = ORIGINAL_DRAW;
                DEVICE.uploadVertices = ORIGINAL_UPLOAD;
            }
        };
        const LEGACY_FIXTURE = FRAME_FIXTURE(true),
            NON_RADIAL_FIXTURE = FRAME_FIXTURE(false),
            FIXTURE_MATCH =
                LEGACY_FIXTURE.pixels.length === NON_RADIAL_FIXTURE.pixels.length &&
                LEGACY_FIXTURE.pixels.every((value, index) => value === NON_RADIAL_FIXTURE.pixels[index]);
        if (!FIXTURE_MATCH) {
            throw new Error('non-radial pipeline changed whole-frame fixture pixels');
        }
        const SMALL = new VECTOR_RENDERER(DEVICE, {
            initialVertices: 3,
            maxVertices: 6,
        });
        const SMALL_DRAWS = [],
            SMALL_UPLOADS = [],
            ORIGINAL_DRAW = DEVICE.draw,
            ORIGINAL_UPLOAD = DEVICE.uploadVertices;
        DEVICE.draw = function (command) {
            if (command.buffer === SMALL.buffer) {
                SMALL_DRAWS.push({
                    role:
                        command.pipeline === SMALL.pipeline
                            ? 'radial'
                            : command.pipeline === SMALL.nonRadialPipeline
                              ? 'non-radial'
                              : 'unexpected',
                    count: command.count,
                    uniformKeys: Object.keys(command.uniforms).sort(),
                    radial: command.uniforms.u_radial ?? null,
                    textured: command.uniforms.u_textured,
                    texture: command.textures[0] === SMALL.white ? 'white' : 'gradient',
                });
            }
            return ORIGINAL_DRAW.call(this, command);
        };
        DEVICE.uploadVertices = function (buffer, data) {
            if (buffer === SMALL.buffer) {
                SMALL_UPLOADS.push(data.length / 8);
            }
            return ORIGINAL_UPLOAD.call(this, buffer, data);
        };
        DEVICE.beginFrame({
            clearColor: [0, 0, 1, 1],
        });
        const SMALL_START = {
            submissions: DEVICE.stats.vectorSubmissions,
            uploads: DEVICE.stats.bufferUploads,
        };
        DRAW_TRIANGLE(SMALL, 2, 2, 'solid');
        DRAW_TRIANGLE(SMALL, 22, 2, 'radial', RADIAL);
        DRAW_TRIANGLE(SMALL, 42, 2, 'solid');
        DRAW_TRIANGLE(SMALL, 2, 22, 'linear', LINEAR_A);
        DRAW_TRIANGLE(SMALL, 22, 22, 'radial', RADIAL);
        DRAW_TRIANGLE(SMALL, 42, 22, 'linear', LINEAR_B);
        DRAW_TRIANGLE(SMALL, 2, 42, 'radial', RADIAL_EMPTY);
        DRAW_TRIANGLE(SMALL, 22, 42, 'solid');
        DRAW_TRIANGLE(SMALL, 42, 42, 'solid');
        DRAW_TRIANGLE(SMALL, 22, 52, 'solid');
        SMALL.flush();
        const SMALL_DELTA = {
            submissions: DEVICE.stats.vectorSubmissions - SMALL_START.submissions,
            uploads: DEVICE.stats.bufferUploads - SMALL_START.uploads,
        };
        DEVICE.endFrame();
        DEVICE.draw = ORIGINAL_DRAW;
        DEVICE.uploadVertices = ORIGINAL_UPLOAD;
        const FAILURE_BASELINE = RESOURCE_SNAPSHOT(),
            EXPECTED_FAILURE = new Error('injected non-radial pipeline creation failure'),
            ORIGINAL_CREATE_PIPELINE = DEVICE.createPipeline;
        let createPipelineCalls = 0,
            constructionError = null,
            failedRenderer = null;
        const ADDED_LISTENERS = [],
            REMOVED_LISTENERS = [],
            ORIGINAL_ADD_LISTENER = CANVAS.addEventListener,
            ORIGINAL_REMOVE_LISTENER = CANVAS.removeEventListener;
        CANVAS.addEventListener = function (type, listener, options) {
            if (type.startsWith('webglcontext')) {
                ADDED_LISTENERS.push([type, listener]);
            }
            return ORIGINAL_ADD_LISTENER.call(this, type, listener, options);
        };
        CANVAS.removeEventListener = function (type, listener, options) {
            if (type.startsWith('webglcontext')) {
                REMOVED_LISTENERS.push([type, listener]);
            }
            return ORIGINAL_REMOVE_LISTENER.call(this, type, listener, options);
        };
        DEVICE.createPipeline = function (descriptor) {
            createPipelineCalls++;
            if (createPipelineCalls === 3) {
                throw EXPECTED_FAILURE;
            }
            return ORIGINAL_CREATE_PIPELINE.call(this, descriptor);
        };
        try {
            failedRenderer = new VECTOR_RENDERER(DEVICE, {
                glyphAtlas: ATLAS,
                initialVertices: 3,
                maxVertices: 6,
            });
        } catch (error) {
            constructionError = error;
        } finally {
            DEVICE.createPipeline = ORIGINAL_CREATE_PIPELINE;
            CANVAS.addEventListener = ORIGINAL_ADD_LISTENER;
            CANVAS.removeEventListener = ORIGINAL_REMOVE_LISTENER;
            failedRenderer?.dispose();
        }
        const FAILURE_CLEANUP = {
            originalError: constructionError === EXPECTED_FAILURE,
            pipelineCalls: createPipelineCalls,
            resourcesRestored: JSON.stringify(RESOURCE_SNAPSHOT()) === JSON.stringify(FAILURE_BASELINE),
            listenersAdded: ADDED_LISTENERS.length,
            listenersRemoved: REMOVED_LISTENERS.length,
            listenersMatched:
                ADDED_LISTENERS.length === 2 &&
                REMOVED_LISTENERS.length === 2 &&
                ADDED_LISTENERS.every(([type, listener]) =>
                    REMOVED_LISTENERS.some((entry) => entry[0] === type && entry[1] === listener),
                ),
            atlasRetained: !ATLAS.disposed && DEVICE.textures.has(ATLAS.texture),
            deviceReady: DEVICE.state === 'ready',
            glError: DEVICE.gl.getError(),
        };
        SMALL.dispose();
        SMALL.dispose();
        const PIPELINE_TRACE = {
            legacy: LEGACY_FIXTURE.draws,
            legacyUploads: LEGACY_FIXTURE.uploads,
            legacyDelta: LEGACY_FIXTURE.delta,
            nonRadial: NON_RADIAL_FIXTURE.draws,
            nonRadialUploads: NON_RADIAL_FIXTURE.uploads,
            nonRadialDelta: NON_RADIAL_FIXTURE.delta,
            capacity: SMALL_DRAWS,
            capacityUploads: SMALL_UPLOADS,
            capacityDelta: SMALL_DELTA,
            fixtureMatch: FIXTURE_MATCH,
            radialEmptyPixel: NON_RADIAL_FIXTURE.radialEmptyPixel,
            descriptors: PIPELINE_DESCRIPTORS,
            failureCleanup: FAILURE_CLEANUP,
        };
        const RESTORATION_RESOURCES = RESOURCE_SNAPSHOT();
        window.vectorProbe = {
            device: DEVICE,
            renderer: RENDERER,
            atlas: ATLAS,
            canvas: CANVAS,
            pixel: PIXEL,
            pipelineHandles: [RENDERER.pipeline, RENDERER.nonRadialPipeline],
            resourceBaseline: RESOURCE_BASELINE,
            resourceSnapshot: RESOURCE_SNAPSHOT,
            restorationResources: RESTORATION_RESOURCES,
            gradientTexture: GRADIENT_TEXTURE,
            fixturePixels: NON_RADIAL_FIXTURE.pixels,
            pipelineTrace: PIPELINE_TRACE,
            drawPipelineFixture: () => FRAME_FIXTURE(false),
        };
        return {
            overlap: OVERLAP,
            outer: OUTER,
            nested: NESTED,
            label: LABEL,
            clipped: CLIPPED,
            hole: HOLE,
            error: ERROR,
            stats: STATS,
            measure: MEASURE,
            nestedTarget: [...NESTED_TARGET],
            parentTarget: [...PARENT_TARGET],
            pipelineTrace: PIPELINE_TRACE,
        };
    });
    assert.ok(
        Math.abs(RESULT.overlap[0] - 128) <= 3 && RESULT.overlap[1] <= 2 && Math.abs(RESULT.overlap[2] - 127) <= 3,
        'overlapping opaque polygons must be composited once at group opacity .5',
    );
    assert.ok(
        Math.abs(RESULT.outer[0] - 128) <= 3 && Math.abs(RESULT.outer[2] - 127) <= 3,
        'group alpha applies outside overlap',
    );
    assert.ok(
        RESULT.nested[0] > 60 &&
            RESULT.nested[0] < 68 &&
            RESULT.nested[1] > 60 &&
            RESULT.nested[1] < 68 &&
            RESULT.nested[2] > 124 &&
            RESULT.nested[2] < 132,
        `nested groups apply alpha once per completed group: ${RESULT.nested}; FBOs ${RESULT.nestedTarget}/${RESULT.parentTarget}`,
    );
    assert.deepEqual(RESULT.nestedTarget, [0, 255, 0, 255]);
    assert.deepEqual(RESULT.parentTarget, [128, 128, 0, 255]);
    assert.ok(
        RESULT.label[0] > 200 && RESULT.label[1] > 200 && RESULT.label[2] > 200,
        'prebaked glyph atlas produces WebGL text pixels',
    );
    assert.deepEqual(RESULT.clipped, [0, 0, 255, 255], 'clip rectangles exclude geometry beyond their bounds');
    assert.deepEqual(RESULT.hole, [0, 0, 255, 255], 'evenodd tessellation preserves path holes');
    assert.equal(RESULT.measure.width, 8);
    assert.equal(RESULT.stats.renderTargetCount, 2);
    assert.equal(RESULT.stats.pipelineCount, 3);
    assert.equal(RESULT.error, 0);
    assert.equal(RESULT.stats.gpuRenderTargetBytes, (64 * 32 + 8 * 8) * 5);
    assert.ok(RESULT.stats.drawCalls >= 5);
    const TRACE = RESULT.pipelineTrace,
        RADIAL_UNIFORMS = ['u_projection', 'u_radial', 'u_radial_params', 'u_texture', 'u_textured', 'u_whiteFlash'],
        NON_RADIAL_UNIFORMS = ['u_projection', 'u_texture', 'u_textured', 'u_whiteFlash'];
    assert.equal(TRACE.fixtureMatch, true, 'legacy and selected-pipeline frames are pixel-identical');
    assert.deepEqual(TRACE.radialEmptyPixel, [0, 0, 255, 255]);
    assert.deepEqual(
        TRACE.legacy.map(({ role, count, texture }) => [role, count, texture]),
        TRACE.nonRadial.map(({ role, count, texture }) => [role, count, texture]),
        'pipeline selection preserves draw order, vertex count, and texture sequence',
    );
    assert.deepEqual(
        TRACE.nonRadial.slice(0, 7).map(({ role }) => role),
        ['non-radial', 'radial', 'non-radial', 'non-radial', 'radial', 'non-radial', 'radial'],
    );
    assert.ok(
        TRACE.nonRadial.some(({ radial }) => radial === 2),
        'radialEmpty selects discard mode',
    );
    assert.ok(
        ['gradient', 'glyph', 'group-target', 'white'].every((texture) =>
            TRACE.nonRadial.some((draw) => draw.texture === texture),
        ),
    );
    for (const DRAW of TRACE.nonRadial) {
        assert.deepEqual(DRAW.uniformKeys, DRAW.role === 'radial' ? RADIAL_UNIFORMS : NON_RADIAL_UNIFORMS);
    }
    assert.deepEqual(
        TRACE.legacyUploads,
        TRACE.legacy.map(({ count }) => count),
    );
    assert.deepEqual(
        TRACE.nonRadialUploads,
        TRACE.nonRadial.map(({ count }) => count),
    );
    assert.equal(TRACE.legacyDelta.submissions, TRACE.legacy.length);
    assert.equal(TRACE.nonRadialDelta.submissions, TRACE.nonRadial.length);
    assert.equal(TRACE.legacyDelta.uploads, TRACE.legacy.length);
    assert.equal(TRACE.nonRadialDelta.uploads, TRACE.nonRadial.length);
    assert.deepEqual(
        TRACE.capacity.map(({ role, count }) => [role, count]),
        [
            ['non-radial', 6],
            ['radial', 6],
            ['non-radial', 6],
            ['non-radial', 6],
            ['radial', 6],
            ['non-radial', 6],
            ['radial', 6],
            ['non-radial', 6],
            ['non-radial', 6],
            ['non-radial', 6],
        ],
        'small capacity flushes the single vertex stream without reordering',
    );
    assert.deepEqual(
        TRACE.capacityUploads,
        TRACE.capacity.map(({ count }) => count),
    );
    assert.equal(TRACE.capacityDelta.submissions, TRACE.capacity.length);
    assert.equal(TRACE.capacityDelta.uploads, TRACE.capacity.length);
    assert.equal(TRACE.capacity[6].radial, 2);
    for (const DRAW of TRACE.capacity) {
        assert.deepEqual(DRAW.uniformKeys, DRAW.role === 'radial' ? RADIAL_UNIFORMS : NON_RADIAL_UNIFORMS);
    }
    assert.equal(TRACE.failureCleanup.originalError, true);
    assert.equal(TRACE.failureCleanup.pipelineCalls, 3);
    assert.equal(TRACE.failureCleanup.resourcesRestored, true);
    assert.equal(TRACE.failureCleanup.listenersAdded, 2);
    assert.equal(TRACE.failureCleanup.listenersRemoved, 2);
    assert.equal(TRACE.failureCleanup.listenersMatched, true);
    assert.equal(TRACE.failureCleanup.atlasRetained, true);
    assert.equal(TRACE.failureCleanup.deviceReady, true);
    assert.equal(TRACE.failureCleanup.glError, 0);
    const LOSS = await page.evaluate(() => {
        const P = vectorProbe;
        P.loss = P.device.gl.getExtension('WEBGL_lose_context');
        if (!P.loss) {
            return false;
        }
        P.loss.loseContext();
        return true;
    });
    if (LOSS) {
        await page.waitForFunction(() => vectorProbe.device.state === 'lost');
        assert.equal(await page.evaluate(() => vectorProbe.device.beginFrame()), false);
        await page.evaluate(() => vectorProbe.loss.restoreContext());
        await page.waitForFunction(() => vectorProbe.device.state === 'ready');
        const RESTORED = await page.evaluate(() => {
            const P = vectorProbe;
            P.device.beginFrame({
                clearColor: [0, 0, 1, 1],
            });
            P.renderer.beginGroup(0.5, {
                x: 12,
                y: 12,
                width: 44,
                height: 32,
            });
            P.renderer.polygon(
                [
                    [12, 12],
                    [44, 12],
                    [44, 44],
                    [12, 44],
                ],
                [1, 0, 0, 1],
            );
            P.renderer.endGroup();
            P.device.endFrame();
            const GROUP_PIXEL = P.pixel(30, 24);
            const FIXTURE = P.drawPipelineFixture();
            return {
                pixel: GROUP_PIXEL,
                bytes: P.device.stats.gpuRenderTargetBytes,
                fixtureMatch:
                    FIXTURE.pixels.length === P.fixturePixels.length &&
                    FIXTURE.pixels.every((value, index) => value === P.fixturePixels[index]),
                pipelinesUsed: new Set(FIXTURE.draws.map(({ role }) => role)).size === 2,
                handlesStable:
                    P.renderer.pipeline === P.pipelineHandles[0] &&
                    P.renderer.nonRadialPipeline === P.pipelineHandles[1],
                resourcesStable: JSON.stringify(P.resourceSnapshot()) === JSON.stringify(P.restorationResources),
                restores: P.device.stats.restores,
                error: P.device.gl.getError(),
            };
        });
        assert.ok(
            Math.abs(RESTORED.pixel[0] - 128) <= 3 && Math.abs(RESTORED.pixel[2] - 127) <= 3,
            'restored target retains its identity and can composite',
        );
        assert.equal(RESTORED.bytes, (64 * 32 + 8 * 8) * 5);
        assert.equal(RESTORED.fixtureMatch, true);
        assert.equal(RESTORED.pipelinesUsed, true);
        assert.equal(RESTORED.handlesStable, true);
        assert.equal(RESTORED.resourcesStable, true);
        assert.equal(RESTORED.restores, 1);
        assert.equal(RESTORED.error, 0);
        RESULT.targetRestoration = RESTORED;
    }
    await page.evaluate(() => vectorProbe.loss.loseContext());
    await page.waitForFunction(() => vectorProbe.device.state === 'lost');
    assert.equal(await page.evaluate(() => vectorProbe.device.beginFrame()), false);
    await page.evaluate(() => vectorProbe.loss.restoreContext());
    await page.waitForFunction(() => vectorProbe.device.state === 'ready');
    RESULT.secondTargetRestoration = await page.evaluate(() => {
        const P = vectorProbe,
            FIXTURE = P.drawPipelineFixture();
        return {
            fixtureMatch:
                FIXTURE.pixels.length === P.fixturePixels.length &&
                FIXTURE.pixels.every((value, index) => value === P.fixturePixels[index]),
            pipelinesUsed: new Set(FIXTURE.draws.map(({ role }) => role)).size === 2,
            handlesStable:
                P.renderer.pipeline === P.pipelineHandles[0] && P.renderer.nonRadialPipeline === P.pipelineHandles[1],
            resourcesStable: JSON.stringify(P.resourceSnapshot()) === JSON.stringify(P.restorationResources),
            restores: P.device.stats.restores,
            error: P.device.gl.getError(),
        };
    });
    assert.equal(RESULT.secondTargetRestoration.fixtureMatch, true);
    assert.equal(RESULT.secondTargetRestoration.pipelinesUsed, true);
    assert.equal(RESULT.secondTargetRestoration.handlesStable, true);
    assert.equal(RESULT.secondTargetRestoration.resourcesStable, true);
    assert.equal(RESULT.secondTargetRestoration.restores, 2);
    assert.equal(RESULT.secondTargetRestoration.error, 0);
    RESULT.disposed = await page.evaluate(() => {
        const P = vectorProbe;
        P.device.deleteTexture(P.gradientTexture);
        P.renderer.dispose();
        P.renderer.dispose();
        const RENDERER_BASELINE_RESTORED = JSON.stringify(P.resourceSnapshot()) === JSON.stringify(P.resourceBaseline);
        const ATLAS_RETAINED = !P.atlas.disposed && P.device.textures.has(P.atlas.texture);
        P.atlas.dispose();
        const EMPTY = Object.values(P.resourceSnapshot()).every((value) => value === 0);
        P.device.dispose();
        P.canvas.remove();
        return {
            disposed: P.device.state === 'disposed' && P.device.stats.gpuRenderTargetBytes === 0,
            rendererBaselineRestored: RENDERER_BASELINE_RESTORED,
            atlasRetained: ATLAS_RETAINED,
            emptyBeforeDeviceDispose: EMPTY,
        };
    });
    assert.equal(RESULT.disposed.disposed, true);
    assert.equal(RESULT.disposed.rendererBaselineRestored, true);
    assert.equal(RESULT.disposed.atlasRetained, true);
    assert.equal(RESULT.disposed.emptyBeforeDeviceDispose, true);
    return RESULT;
}

/** Shared immutable font fetch/decode, per-device texture ownership, failure, retry, and cancel path. */
export async function exerciseFontAssetLoader(page, origin) {
    const MANIFEST = JSON.parse(await (await fetch(`${origin}/dist/manifest.json`)).text());
    const FONT_ENTRY = MANIFEST.assets.find((asset) => asset.file === 'assets/fonts/noto-sans-kr-700-v1.json');
    assert.ok(FONT_ENTRY, 'published manifest contains the fixed font asset');
    const SOURCE = {
        url: `${origin}/dist/${FONT_ENTRY.file}`,
        version: 'font-loader-browser-v1',
        sha256: FONT_ENTRY.sha256,
        bytes: FONT_ENTRY.bytes,
    };
    const RESULT = await page.evaluate(
        async ({ source, origin }) => {
            const { WebGLDevice: WEB_GL_DEVICE, FontAssetLoader: FONT_ASSET_LOADER } =
                await import('/dist/rendering.js');
            const CHECK = (condition, message) => {
                if (!condition) {
                    throw new Error(message);
                }
            };
            const CANVAS = document.createElement('canvas');
            CANVAS.width = CANVAS.height = 8;
            document.body.append(CANVAS);
            const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                antialias: false,
                preserveDrawingBuffer: true,
            });
            const PHASES_A = [],
                PHASES_B = [];
            const A = new FONT_ASSET_LOADER(DEVICE, source, {
                onProgress: (progress) => PHASES_A.push(progress.phase),
            });
            const B = new FONT_ASSET_LOADER(DEVICE, source, {
                onProgress: (progress) => PHASES_B.push(progress.phase),
            });
            const [ATLAS_A, ATLAS_B] = await Promise.all([A.ready, B.ready]);
            CHECK(ATLAS_A === ATLAS_B, 'same asset and device share one GPU atlas');
            CHECK(DEVICE.stats.textureCount === 1, 'shared device owns one atlas texture');
            CHECK(
                PHASES_A.includes('download') &&
                    PHASES_A.includes('verify') &&
                    PHASES_A.includes('decode') &&
                    PHASES_A.includes('ready'),
                'font readiness reports download, verification, decode, and ready phases',
            );
            CHECK(PHASES_B.includes('ready'), 'concurrent consumer receives shared readiness progress');
            CHECK(ATLAS_A.glyphs.size === 750, 'loaded font exposes the pinned glyph inventory');
            const CANVAS2 = document.createElement('canvas');
            CANVAS2.width = CANVAS2.height = 8;
            document.body.append(CANVAS2);
            const DEVICE2 = new WEB_GL_DEVICE(CANVAS2, {
                antialias: false,
            });
            const C = new FONT_ASSET_LOADER(DEVICE2, source);
            const ATLAS_C = await C.ready;
            CHECK(
                ATLAS_C !== ATLAS_A && DEVICE2.stats.textureCount === 1,
                'each WebGLDevice owns its own recoverable atlas texture',
            );
            A.dispose();
            CHECK(DEVICE.stats.textureCount === 1, 'first lease keeps shared texture alive');
            B.dispose();
            CHECK(DEVICE.stats.textureCount === 0, 'last lease releases shared texture');
            C.dispose();
            CHECK(DEVICE2.stats.textureCount === 0, 'second device texture is released independently');
            let mismatch;
            try {
                await new FONT_ASSET_LOADER(DEVICE, {
                    ...source,
                    version: 'font-wrong-hash-v1',
                    sha256: '0'.repeat(64),
                }).ready;
            } catch (error) {
                mismatch = error;
            }
            CHECK(mismatch?.message.includes('SHA-256 mismatch'), 'outer font hash mismatch is rejected');
            let corsError;
            const CORS_URL = new URL(source.url);
            CORS_URL.hostname = 'localhost';
            try {
                await new FONT_ASSET_LOADER(DEVICE, {
                    ...source,
                    url: CORS_URL.href,
                    version: 'font-cors-v1',
                }).ready;
            } catch (error) {
                corsError = error;
            }
            CHECK(corsError, 'a real cross-origin response without Access-Control-Allow-Origin is rejected');
            const RETRY = new FONT_ASSET_LOADER(DEVICE, {
                ...source,
                url: `${origin}/__font-retry`,
                version: 'font-retry-v1',
            });
            let firstFailure;
            try {
                await RETRY.ready;
            } catch (error) {
                firstFailure = error;
            }
            CHECK(RETRY.state === 'error' && firstFailure, 'failed HTTP request reports an error state');
            const RETRIED = new FONT_ASSET_LOADER(DEVICE, {
                ...source,
                url: `${origin}/__font-retry`,
                version: 'font-retry-v1',
            });
            await RETRIED.ready;
            CHECK(RETRIED.state === 'ready', 'a new loader retries after a failed fetch');
            RETRIED.dispose();
            const PENDING = new FONT_ASSET_LOADER(DEVICE, {
                ...source,
                url: `${origin}/__font-delay`,
                version: 'font-cancel-v1',
            });
            CHECK(PENDING.cancel(), 'loading request can be cancelled');
            let cancelled = false;
            try {
                await PENDING.ready;
            } catch (error) {
                cancelled = error.name === 'AbortError';
            }
            CHECK(cancelled && PENDING.state === 'cancelled', 'cancelled loader never becomes ready');
            PENDING.dispose();
            DEVICE.dispose();
            DEVICE2.dispose();
            CANVAS.remove();
            CANVAS2.remove();
            return {
                assetBytes: source.bytes,
                textureBytesPerDevice: 2016 * 864 * 4,
                glyphs: ATLAS_A.glyphs.size,
                progress: [...new Set([...PHASES_A, ...PHASES_B])],
                sharedTexture: true,
                deviceIsolation: true,
                hashMismatch: true,
                corsRejected: true,
                retry: true,
                cancel: true,
                disposal: true,
            };
        },
        {
            source: SOURCE,
            origin,
        },
    );
    assert.equal(RESULT.glyphs, 750);
    assert.equal(RESULT.textureBytesPerDevice, 6_967_296);
    return RESULT;
}

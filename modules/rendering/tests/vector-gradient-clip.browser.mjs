import assert from 'node:assert/strict';
export async function exerciseVectorGradientClip(browser, moduleURL, screenshotPath) {
    const PAGE = await browser.newPage({
        viewport: {
            width: 640,
            height: 360,
        },
        deviceScaleFactor: 1,
    });
    const PAGE_ERRORS = [];
    PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    PAGE.on('console', (message) => {
        if (message.type() === 'log') {
            console.log(`[browser] ${message.text()}`);
        }
    });
    try {
        await PAGE.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:16px;background:#f1f0e8;color:#293e36;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:18px;margin:0 0 10px}.row{display:flex;align-items:flex-start;gap:14px}.card{padding:9px;background:#fffdf4;border:1px solid #d5dec2;border-radius:8px}
      canvas{display:block;background:#fff;margin:auto}small{display:block;margin-top:6px;text-align:center}
    </style><h1>GameKit linear gradients and retained concave clipping</h1>
    <div class="row"><div class="card"><canvas id="mobile"></canvas><small>47 CSS px · DPR 1 / 2</small></div>
    <div class="card"><canvas id="desktop"></canvas><small>74 CSS px · DPR 1 / 2</small></div>
    <div class="card"><canvas id="clip"></canvas><small>160-point retained C clip · vector, mesh, group</small></div></div>`);
        const RESULT = await PAGE.evaluate(
            async ({ moduleURL }) => {
                const CHECKPOINT = (name) => console.log(`checkpoint: ${name}`);
                const {
                    WebGLDevice: WEB_GL_DEVICE,
                    VectorRenderer: VECTOR_RENDERER,
                    VectorContext: VECTOR_CONTEXT,
                } = await import(moduleURL);
                CHECKPOINT('module imported');
                const GRADIENT_SAMPLES = {};
                const GRADIENT_CANVASES = [];
                let gradientStopLimitRejected = false;
                const READ_PIXEL = (gl, canvas, x, y, dpr) => {
                    const PIXELS = new Uint8Array(4);
                    gl.readPixels(
                        Math.floor(x * dpr),
                        canvas.height - 1 - Math.floor(y * dpr),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        PIXELS,
                    );
                    return [...PIXELS];
                };
                for (const [ID, SIZE] of [
                    ['mobile', 47],
                    ['desktop', 74],
                ]) {
                    const CANVAS = document.getElementById(ID),
                        DPR = 1;
                    CANVAS.style.width = `${SIZE + 16}px`;
                    CANVAS.style.height = `${SIZE + 34}px`;
                    CANVAS.width = (SIZE + 16) * DPR;
                    CANVAS.height = (SIZE + 34) * DPR;
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: true,
                        antialias: false,
                        depth: false,
                        stencil: true,
                        preserveDrawingBuffer: true,
                    });
                    const VECTOR = new VECTOR_RENDERER(DEVICE, {
                        initialVertices: 128,
                        maxVertices: 8192,
                    });
                    const CTX = new VECTOR_CONTEXT(DEVICE, {
                        vectorRenderer: VECTOR,
                    });
                    CTX.beginFrame({
                        clearColor: [0, 0, 0, 0],
                    });
                    CTX.scale(DPR, DPR);
                    const GRADIENT = CTX.createLinearGradient(8, 8, 8 + SIZE, 8);
                    GRADIENT.addColorStop(0, '#ff0000');
                    GRADIENT.addColorStop(0.25, '#00ff00');
                    GRADIENT.addColorStop(0.75, '#0000ff');
                    GRADIENT.addColorStop(1, '#ffffff');
                    CTX.fillStyle = GRADIENT;
                    CTX.fillRect(8, 8, SIZE, 20);
                    const ALPHA_GRADIENT = CTX.createLinearGradient(8, 35, 8 + SIZE, 35);
                    ALPHA_GRADIENT.addColorStop(0, 'rgba(255,0,0,0)');
                    ALPHA_GRADIENT.addColorStop(1, 'rgba(0,0,255,1)');
                    CTX.fillStyle = ALPHA_GRADIENT;
                    CTX.fillRect(8, 32, SIZE, 10);
                    const STROKE_GRADIENT = CTX.createLinearGradient(8, 46, 8 + SIZE, 46);
                    STROKE_GRADIENT.addColorStop(0, '#ffcc00');
                    STROKE_GRADIENT.addColorStop(1, '#cc00ff');
                    CTX.strokeStyle = STROKE_GRADIENT;
                    CTX.lineWidth = 3;
                    CTX.lineCap = 'round';
                    CTX.lineJoin = 'round';
                    CTX.beginPath();
                    CTX.moveTo(10, 49);
                    CTX.lineTo(8 + SIZE * 0.5, 46);
                    CTX.lineTo(6 + SIZE, 49);
                    CTX.stroke();
                    CTX.save();
                    CTX.translate(10, 57);
                    CTX.rotate(0.32);
                    CTX.scale(1.5, 0.65);
                    const TRANSFORMED = CTX.createLinearGradient(0, 0, 20, 0);
                    TRANSFORMED.addColorStop(0, 'red');
                    TRANSFORMED.addColorStop(1, 'blue');
                    CTX.fillStyle = TRANSFORMED;
                    CTX.fillRect(0, 0, 20, 8);
                    CTX.restore();
                    CTX.endFrame();
                    if (ID === 'mobile') {
                        const CAPPED = CTX.createLinearGradient(0, 0, 1, 0);
                        try {
                            for (let i = 0; i < 33; i++) {
                                CAPPED.addColorStop(i / 32, '#123456');
                            }
                        } catch (error) {
                            gradientStopLimitRejected = /32 color stops/.test(error.message);
                        }
                    }
                    CHECKPOINT(`${ID} gradient frame rendered`);
                    GRADIENT_SAMPLES[ID] = {
                        cssSize: SIZE,
                        dpr: DPR,
                        stops: [
                            READ_PIXEL(DEVICE.gl, CANVAS, 8 + SIZE * 0.08, 18, DPR),
                            READ_PIXEL(DEVICE.gl, CANVAS, 8 + SIZE * 0.5, 18, DPR),
                            READ_PIXEL(DEVICE.gl, CANVAS, 8 + SIZE * 0.92, 18, DPR),
                        ],
                        alphaMid: READ_PIXEL(DEVICE.gl, CANVAS, 8 + SIZE * 0.5, 37, DPR),
                        strokeMid: READ_PIXEL(DEVICE.gl, CANVAS, 8 + SIZE * 0.5, 47, DPR),
                        transformedCoverage: READ_PIXEL(DEVICE.gl, CANVAS, 20, 62, DPR),
                        error: DEVICE.gl.getError(),
                        drawCalls: DEVICE.stats.drawCalls,
                    };
                    GRADIENT_CANVASES.push({
                        canvas: CANVAS,
                        device: DEVICE,
                        vector: VECTOR,
                        ctx: CTX,
                    });
                }
                const RADIAL_COMPARISONS = {};
                for (const [ID, SIZE, DPR] of [
                    ['radial-mobile', 47, 1],
                    ['radial-desktop', 74, 2],
                ]) {
                    const CANVAS = document.createElement('canvas'),
                        CARD = document.createElement('div'),
                        LABEL = document.createElement('small');
                    CARD.className = 'card';
                    LABEL.textContent = `Two-circle radial gradient · ${SIZE} CSS px · DPR ${DPR}`;
                    CANVAS.style.cssText = 'display:block;background:white';
                    CARD.append(CANVAS, LABEL);
                    document.querySelector('body').append(CARD);
                    CANVAS.width = (SIZE + 16) * DPR;
                    CANVAS.height = (SIZE + 16) * DPR;
                    CANVAS.style.width = `${SIZE + 16}px`;
                    CANVAS.style.height = `${SIZE + 16}px`;
                    const REFERENCE = document.createElement('canvas');
                    REFERENCE.width = CANVAS.width;
                    REFERENCE.height = CANVAS.height;
                    const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                        alpha: true,
                        antialias: false,
                        depth: false,
                        stencil: false,
                        preserveDrawingBuffer: true,
                    });
                    const VECTOR = new VECTOR_RENDERER(DEVICE, {
                            initialVertices: 128,
                            maxVertices: 8192,
                        }),
                        CTX = new VECTOR_CONTEXT(DEVICE, {
                            vectorRenderer: VECTOR,
                        });
                    CTX.beginFrame({
                        clearColor: [0, 0, 0, 0],
                    });
                    CTX.scale(DPR, DPR);
                    CTX.translate((SIZE + 16) / 2, (SIZE + 16) / 2);
                    CTX.scale(SIZE / 120, SIZE / 120);
                    CTX.fillStyle = '#304860';
                    CTX.fillRect(-80, -80, 160, 160);
                    const GRADIENT = CTX.createRadialGradient(-18, -22, 4, 0, 0, 70);
                    GRADIENT.addColorStop(0, '#fff1cf');
                    GRADIENT.addColorStop(0.58, '#d9b995');
                    GRADIENT.addColorStop(1, '#b78f75');
                    CTX.fillStyle = GRADIENT;
                    CTX.beginPath();
                    CTX.ellipse(0, 0, 50, 44, 0, 0, Math.PI * 2);
                    CTX.fill();
                    CTX.save();
                    CTX.translate(60, 0);
                    CTX.fillStyle = '#00ff00';
                    CTX.fillRect(-8, -8, 16, 16);
                    const IDENTICAL = CTX.createRadialGradient(-18, -22, 4, -18, -22, 4);
                    IDENTICAL.addColorStop(0, '#fff1cf');
                    IDENTICAL.addColorStop(1, '#b78f75');
                    CTX.fillStyle = IDENTICAL;
                    CTX.fillRect(-8, -8, 16, 16);
                    CTX.strokeStyle = GRADIENT;
                    CTX.lineWidth = 2;
                    CTX.beginPath();
                    CTX.moveTo(-6, 5);
                    CTX.lineTo(6, 5);
                    CTX.stroke();
                    CTX.restore();
                    CTX.endFrame();
                    const REF = REFERENCE.getContext('2d');
                    REF.scale(DPR, DPR);
                    REF.translate((SIZE + 16) / 2, (SIZE + 16) / 2);
                    REF.scale(SIZE / 120, SIZE / 120);
                    REF.fillStyle = '#304860';
                    REF.fillRect(-80, -80, 160, 160);
                    const NATIVE_GRADIENT = REF.createRadialGradient(-18, -22, 4, 0, 0, 70);
                    NATIVE_GRADIENT.addColorStop(0, '#fff1cf');
                    NATIVE_GRADIENT.addColorStop(0.58, '#d9b995');
                    NATIVE_GRADIENT.addColorStop(1, '#b78f75');
                    REF.fillStyle = NATIVE_GRADIENT;
                    REF.beginPath();
                    REF.ellipse(0, 0, 50, 44, 0, 0, Math.PI * 2);
                    REF.fill();
                    REF.save();
                    REF.translate(60, 0);
                    REF.fillStyle = '#00ff00';
                    REF.fillRect(-8, -8, 16, 16);
                    const NATIVE_IDENTICAL = REF.createRadialGradient(-18, -22, 4, -18, -22, 4);
                    NATIVE_IDENTICAL.addColorStop(0, '#fff1cf');
                    NATIVE_IDENTICAL.addColorStop(1, '#b78f75');
                    REF.fillStyle = NATIVE_IDENTICAL;
                    REF.fillRect(-8, -8, 16, 16);
                    REF.strokeStyle = NATIVE_GRADIENT;
                    REF.lineWidth = 2;
                    REF.beginPath();
                    REF.moveTo(-6, 5);
                    REF.lineTo(6, 5);
                    REF.stroke();
                    REF.restore();
                    const GL_PIXELS = new Uint8Array(CANVAS.width * CANVAS.height * 4);
                    DEVICE.gl.readPixels(
                        0,
                        0,
                        CANVAS.width,
                        CANVAS.height,
                        DEVICE.gl.RGBA,
                        DEVICE.gl.UNSIGNED_BYTE,
                        GL_PIXELS,
                    );
                    const NATIVE_PIXELS = REF.getImageData(0, 0, REFERENCE.width, REFERENCE.height).data;
                    let compared = 0;
                    let maxDiff = 0;
                    let totalDiff = 0;
                    let notchOrBackgroundMismatch = 0;
                    const SCALE = SIZE / 120,
                        CENTER = (SIZE + 16) / 2;
                    for (let y = 1; y < CANVAS.height - 1; y++) {
                        for (let x = 1; x < CANVAS.width - 1; x++) {
                            const CSS_X = (x + 0.5) / DPR - CENTER,
                                CSS_Y = (y + 0.5) / DPR - CENTER,
                                LOCAL_X = CSS_X / SCALE,
                                LOCAL_Y = CSS_Y / SCALE,
                                ELLIPSE_EDGE = Math.hypot(LOCAL_X / 50, LOCAL_Y / 44);
                            if (ELLIPSE_EDGE > 0.9) {
                                continue;
                            }
                            const GL_AT = ((CANVAS.height - 1 - y) * CANVAS.width + x) * 4,
                                REF_AT = (y * CANVAS.width + x) * 4;
                            for (let k = 0; k < 4; k++) {
                                const DIFF = Math.abs(GL_PIXELS[GL_AT + k] - NATIVE_PIXELS[REF_AT + k]);
                                maxDiff = Math.max(maxDiff, DIFF);
                                totalDiff += DIFF;
                                compared++;
                            }
                            if (ELLIPSE_EDGE < 0.8 && NATIVE_PIXELS[REF_AT + 3] === 255 && GL_PIXELS[GL_AT + 3] === 0) {
                                notchOrBackgroundMismatch++;
                            }
                        }
                    }
                    const IDENTICAL_X = Math.floor((CENTER + 60 * SCALE) * DPR),
                        IDENTICAL_Y = Math.floor(CENTER * DPR),
                        IDENTICAL_PIXEL = new Uint8Array(4),
                        RADIAL_STROKE_PIXEL = new Uint8Array(4);
                    DEVICE.gl.readPixels(
                        IDENTICAL_X,
                        CANVAS.height - 1 - IDENTICAL_Y,
                        1,
                        1,
                        DEVICE.gl.RGBA,
                        DEVICE.gl.UNSIGNED_BYTE,
                        IDENTICAL_PIXEL,
                    );
                    DEVICE.gl.readPixels(
                        Math.floor((CENTER + 60 * SCALE) * DPR),
                        CANVAS.height - 1 - Math.floor((CENTER + 5 * SCALE) * DPR),
                        1,
                        1,
                        DEVICE.gl.RGBA,
                        DEVICE.gl.UNSIGNED_BYTE,
                        RADIAL_STROKE_PIXEL,
                    );
                    RADIAL_COMPARISONS[ID] = {
                        size: SIZE,
                        dpr: DPR,
                        compared,
                        maxDiff,
                        meanDiff: totalDiff / compared,
                        notchOrBackgroundMismatch,
                        identicalCirclePixel: [...IDENTICAL_PIXEL],
                        radialStrokePixel: [...RADIAL_STROKE_PIXEL],
                        glError: DEVICE.gl.getError(),
                    };
                    CTX.dispose();
                    VECTOR.dispose();
                    DEVICE.dispose();
                }
                const CANVAS = document.getElementById('clip');
                CANVAS.style.width = '160px';
                CANVAS.style.height = '130px';
                CANVAS.width = 160;
                CANVAS.height = 130;
                const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                    alpha: true,
                    antialias: false,
                    depth: false,
                    stencil: true,
                    preserveDrawingBuffer: true,
                });
                const VECTOR = new VECTOR_RENDERER(DEVICE, {
                    initialVertices: 128,
                    maxVertices: 8192,
                });
                const CTX = new VECTOR_CONTEXT(DEVICE, {
                    vectorRenderer: VECTOR,
                });
                const VECTOR_DRAWS = [],
                    VECTOR_UPLOADS = [],
                    ORIGINAL_DRAW = DEVICE.draw,
                    ORIGINAL_UPLOAD = DEVICE.uploadVertices;
                DEVICE.draw = function (command) {
                    if (command.buffer === VECTOR.buffer) {
                        VECTOR_DRAWS.push({
                            role: command.pipeline === VECTOR.pipeline ? 'atlas' : 'unexpected',
                            count: command.count,
                            uniformKeys: Object.keys(command.uniforms).sort(),
                            stencil: command.stencil === false ? false : { ...command.stencil },
                        });
                    }
                    return ORIGINAL_DRAW.call(this, command);
                };
                DEVICE.uploadVertices = function (buffer, data) {
                    if (buffer === VECTOR.buffer) {
                        VECTOR_UPLOADS.push(data.length / 20);
                    }
                    return ORIGINAL_UPLOAD.call(this, buffer, data);
                };
                const CORNERS = [
                    [20, 20],
                    [100, 20],
                    [100, 100],
                    [20, 100],
                    [20, 75],
                    [75, 75],
                    [75, 45],
                    [20, 45],
                ];
                const AUTHORED = [];
                for (let i = 0; i < CORNERS.length; i++) {
                    const A = CORNERS[i],
                        B = CORNERS[(i + 1) % CORNERS.length];
                    for (let j = 0; j < 20; j++) {
                        const T = j / 20;
                        AUTHORED.push(A[0] + (B[0] - A[0]) * T, A[1] + (B[1] - A[1]) * T);
                    }
                }
                const CLIP160 = CTX.createClipPath(Float32Array.from(AUTHORED), {
                    rule: 'evenodd',
                });
                const INNER = CTX.createClipPath(new Float32Array([30, 25, 55, 25, 55, 40, 30, 40]));
                const MESH_VERTICES = [];
                for (const [X, Y] of [
                    [5, 5],
                    [115, 5],
                    [115, 115],
                    [5, 5],
                    [115, 115],
                    [5, 115],
                ]) {
                    MESH_VERTICES.push(X, Y, 1, 0, 0, 1, 0, 0, 0, 0, 0);
                }
                const MESH = CTX.createMesh({
                    vertices: Float32Array.from(MESH_VERTICES),
                    strideFloats: 11,
                    partCount: 1,
                    morphCount: 0,
                });
                const PIXEL = (x, y) => READ_PIXEL(DEVICE.gl, CANVAS, x, y, 1);
                CTX.beginFrame({
                    width: 160,
                    height: 130,
                    clearColor: [0, 0, 1, 1],
                });
                CTX.save();
                CTX.clipPath(CLIP160);
                CTX.drawMesh(MESH);
                const CLIP_TRACE_START = VECTOR_DRAWS.length,
                    CLIP_UPLOAD_START = VECTOR_UPLOADS.length,
                    CLIP_SUBMISSIONS_START = DEVICE.stats.vectorSubmissions,
                    CLIP_LINEAR = CTX.createLinearGradient(20, 80, 100, 80);
                CLIP_LINEAR.addColorStop(0, '#ff0000');
                CLIP_LINEAR.addColorStop(1, '#0000ff');
                const CLIP_RADIAL = CTX.createRadialGradient(48, 84, 2, 60, 84, 18);
                CLIP_RADIAL.addColorStop(0, '#fff000');
                CLIP_RADIAL.addColorStop(1, '#00aaff');
                CTX.fillStyle = CLIP_LINEAR;
                CTX.fillRect(22, 80, 18, 12);
                CTX.fillStyle = CLIP_RADIAL;
                CTX.fillRect(44, 80, 18, 12);
                CTX.fillStyle = CLIP_LINEAR;
                CTX.fillRect(66, 80, 18, 12);
                CTX.save();
                CTX.clipPath(INNER);
                CTX.fillStyle = '#ffffff';
                CTX.fillRect(0, 0, 130, 120);
                CTX.restore();
                CTX.beginGroup(0.5, {
                    x: 0,
                    y: 0,
                    width: 130,
                    height: 120,
                });
                CTX.fillStyle = '#00ff00';
                CTX.fillRect(0, 0, 130, 120);
                CTX.endGroup();
                CTX.endFrame();
                CHECKPOINT('retained clip, mesh and group rendered');
                const CLIP_PIPELINE_TRACE = {
                    draws: VECTOR_DRAWS.slice(CLIP_TRACE_START),
                    uploads: VECTOR_UPLOADS.slice(CLIP_UPLOAD_START),
                    submissions: DEVICE.stats.vectorSubmissions - CLIP_SUBMISSIONS_START,
                };
                const CLIP_PIXELS = {
                    innerAndGroup: PIXEL(40, 30),
                    rightArm: PIXEL(85, 60),
                    openNotch: PIXEL(40, 60),
                    outside: PIXEL(120, 60),
                    error: DEVICE.gl.getError(),
                    draws: DEVICE.stats.drawCalls,
                };
                let savedClipDeletionRejected = false;
                try {
                    CTX.deleteClipPath(CLIP160);
                } catch (error) {
                    savedClipDeletionRejected = /every saved clip stack/.test(error.message);
                }
                const BAD_SELF_CROSSING = new Float32Array([0, 0, 10, 10, 0, 10, 10, 0]);
                let selfIntersectionRejected = false;
                try {
                    CTX.createClipPath(BAD_SELF_CROSSING);
                } catch (error) {
                    selfIntersectionRejected = /simple|self-intersecting/.test(error.message);
                }
                let dynamicConcaveRejected = false;
                CTX.beginFrame({
                    width: 160,
                    height: 130,
                    clearColor: [0, 0, 1, 1],
                });
                CTX.restore();
                CTX.beginPath();
                for (let i = 0; i < CORNERS.length; i++) {
                    i ? CTX.lineTo(...CORNERS[i]) : CTX.moveTo(...CORNERS[i]);
                }
                CTX.closePath();
                try {
                    CTX.clip();
                } catch (error) {
                    dynamicConcaveRejected = /convex|retained ClipPath/.test(error.message);
                }
                const CONVEX160 = [];
                for (let i = 0; i < 160; i++) {
                    const A = (i / 160) * Math.PI * 2;
                    CONVEX160.push(80 + 30 * Math.cos(A), 65 + 30 * Math.sin(A));
                }
                CTX.save();
                CTX.beginPath();
                for (let i = 0; i < 160; i++) {
                    i ? CTX.lineTo(CONVEX160[i * 2], CONVEX160[i * 2 + 1]) : CTX.moveTo(CONVEX160[0], CONVEX160[1]);
                }
                CTX.closePath();
                CTX.clip();
                const DYNAMIC_CLIP = VECTOR.stencilClips.at(-1);
                const AUTHORED_CONVEX_COUNT = DYNAMIC_CLIP.triangles.length / 6 + 2;
                CTX.restore();
                CTX.endFrame();
                CHECKPOINT('dynamic contour limits checked');
                let clipPointLimitRejected = false;
                try {
                    CTX.createClipPath(new Float32Array(257 * 2));
                } catch (error) {
                    clipPointLimitRejected = /256 authored points/.test(error.message);
                }
                const COLOR_ONLY_TARGET = DEVICE.createRenderTarget(16, 16, {
                    stencil: false,
                });
                let missingStencilRejected = false;
                CTX.beginFrame({
                    width: 160,
                    height: 130,
                    clearColor: [0, 0, 1, 1],
                });
                DEVICE.bindRenderTarget(COLOR_ONLY_TARGET);
                try {
                    CTX.clipPath(CLIP160);
                } catch (error) {
                    missingStencilRejected = /active stencil attachment/.test(error.message);
                }
                DEVICE.unbindRenderTarget();
                CTX.endFrame();
                DEVICE.deleteRenderTarget(COLOR_ONLY_TARGET);
                CTX.beginFrame({
                    width: 160,
                    height: 130,
                    clearColor: [0, 0, 1, 1],
                });
                CTX.save();
                CTX.clipPath(CLIP160);
                CTX.endFrame();
                const LOSS = DEVICE.gl.getExtension('WEBGL_lose_context');
                let restored = false;
                let restorePixel = null;
                let restoreNotch = null;
                if (LOSS) {
                    const EVENT_WITHIN = (type, trigger) =>
                        new Promise((resolve, reject) => {
                            const TIMER = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 20000);
                            CANVAS.addEventListener(
                                type,
                                () => {
                                    clearTimeout(TIMER);
                                    resolve(true);
                                },
                                {
                                    once: true,
                                },
                            );
                            trigger();
                        });
                    await EVENT_WITHIN('webglcontextlost', () => LOSS.loseContext());
                    restored = CTX.beginFrame() === false;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    await EVENT_WITHIN('webglcontextrestored', () => LOSS.restoreContext());
                    await new Promise((resolve) => setTimeout(resolve, 80));
                    CTX.beginFrame({
                        width: 160,
                        height: 130,
                        clearColor: [0, 0, 1, 1],
                    });
                    CTX.drawMesh(MESH);
                    CTX.restore();
                    CTX.endFrame();
                    restorePixel = PIXEL(85, 60);
                    restoreNotch = PIXEL(40, 60);
                    CHECKPOINT('context restored and retained mesh rendered');
                }
                const GL_ERROR = DEVICE.gl.getError();
                CTX.deleteMesh(MESH);
                CTX.deleteClipPath(INNER);
                CTX.deleteClipPath(CLIP160);
                CTX.dispose();
                for (const SAMPLE of GRADIENT_CANVASES) {
                    SAMPLE.ctx.dispose();
                    SAMPLE.vector.dispose();
                    SAMPLE.device.dispose();
                    SAMPLE.canvas.remove();
                }
                VECTOR.dispose();
                DEVICE.dispose();
                CANVAS.remove();
                const DISPOSED =
                    DEVICE.stats.bufferCount === 0 &&
                    DEVICE.stats.pipelineCount === 0 &&
                    DEVICE.stats.textureCount === 0 &&
                    DEVICE.stats.renderTargetCount === 0 &&
                    DEVICE.stats.gpuBufferBytes === 0 &&
                    DEVICE.stats.gpuRenderTargetBytes === 0;
                return {
                    gradientSamples: GRADIENT_SAMPLES,
                    radialComparisons: RADIAL_COMPARISONS,
                    clipPixels: CLIP_PIXELS,
                    clipPipelineTrace: CLIP_PIPELINE_TRACE,
                    gradientStopLimitRejected,
                    clipPointLimitRejected,
                    missingStencilRejected,
                    selfIntersectionRejected,
                    dynamicConcaveRejected,
                    savedClipDeletionRejected,
                    authoredConvexCount: AUTHORED_CONVEX_COUNT,
                    restored,
                    restorePixel,
                    restoreNotch,
                    glError: GL_ERROR,
                    disposed: DISPOSED,
                };
            },
            {
                moduleURL,
            },
        );
        for (const [NAME, SAMPLE] of Object.entries(RESULT.gradientSamples)) {
            assert.equal(SAMPLE.cssSize, NAME === 'mobile' ? 47 : 74);
            assert.ok(
                SAMPLE.stops[0][0] > SAMPLE.stops[0][1] && SAMPLE.stops[0][3] === 255,
                `${NAME}: gradient start ${SAMPLE.stops[0]}`,
            );
            assert.ok(
                Math.abs(SAMPLE.stops[1][0]) <= 10 &&
                    Math.abs(SAMPLE.stops[1][1] - 128) <= 12 &&
                    Math.abs(SAMPLE.stops[1][2] - 128) <= 12,
                `${NAME}: gradient middle ${SAMPLE.stops[1]}`,
            );
            assert.ok(
                SAMPLE.stops[2][2] > SAMPLE.stops[2][0] && SAMPLE.stops[2][3] === 255,
                `${NAME}: gradient end ${SAMPLE.stops[2]}`,
            );
            assert.ok(
                Math.abs(SAMPLE.alphaMid[0] - 64) <= 12 &&
                    Math.abs(SAMPLE.alphaMid[2] - 64) <= 12 &&
                    Math.abs(SAMPLE.alphaMid[3] - 128) <= 12,
                `${NAME}: premultiplied alpha stop ${SAMPLE.alphaMid}`,
            );
            assert.ok(SAMPLE.strokeMid[3] > 0, `${NAME}: gradient stroke has covered pixels`);
            assert.ok(SAMPLE.transformedCoverage[3] > 0, `${NAME}: transformed fill has covered pixels`);
            assert.equal(SAMPLE.error, 0);
        }
        for (const [NAME, SAMPLE] of Object.entries(RESULT.radialComparisons)) {
            assert.equal(SAMPLE.size, NAME === 'radial-mobile' ? 47 : 74);
            assert.ok(SAMPLE.compared > 1000, `${NAME}: compare actual rendered pixels against native Canvas2D`);
            assert.ok(SAMPLE.maxDiff <= 10 && SAMPLE.meanDiff <= 2.5, `${NAME}: two-circle gradient pixel parity`);
            assert.equal(
                SAMPLE.notchOrBackgroundMismatch,
                0,
                `${NAME}: transparent area outside the radial cone leaves prior paint intact`,
            );
            assert.deepEqual(
                SAMPLE.identicalCirclePixel,
                [0, 255, 0, 255],
                `${NAME}: identical circles paint nothing per the Canvas radial-gradient algorithm`,
            );
            assert.ok(
                SAMPLE.radialStrokePixel[3] > 0 && (SAMPLE.radialStrokePixel[0] > 0 || SAMPLE.radialStrokePixel[2] > 0),
                NAME + ': transformed radial gradient stroke paints pixels ' + JSON.stringify(SAMPLE.radialStrokePixel),
            );
            assert.equal(SAMPLE.glError, 0);
        }
        assert.ok(
            RESULT.clipPixels.innerAndGroup[0] > 100 && RESULT.clipPixels.innerAndGroup[1] > 240,
            `nested clip + group ${RESULT.clipPixels.innerAndGroup}`,
        );
        assert.ok(
            RESULT.clipPixels.rightArm[0] > 100 && RESULT.clipPixels.rightArm[1] > 100,
            `retained mesh/clip and group ${RESULT.clipPixels.rightArm}`,
        );
        assert.deepEqual(RESULT.clipPixels.openNotch, [0, 0, 255, 255]);
        assert.deepEqual(RESULT.clipPixels.outside, [0, 0, 255, 255]);
        assert.equal(RESULT.clipPixels.error, 0);
        const CLIP_TRACE = RESULT.clipPipelineTrace;
        assert.ok(CLIP_TRACE.draws.length >= 1);
        // Linear, radial, linear: gradient kind is vertex data, so all three quads share one draw in painter order.
        assert.deepEqual(
            [CLIP_TRACE.draws[0].role, CLIP_TRACE.draws[0].count],
            ['atlas', 18],
            'linear/radial/linear gradient fills batch into one ordered draw inside the concave stencil clip',
        );
        assert.deepEqual(
            CLIP_TRACE.uploads,
            CLIP_TRACE.draws.map(({ count }) => count),
            'each ordered vector submission uploads its matching vertex count',
        );
        assert.equal(CLIP_TRACE.submissions, CLIP_TRACE.draws.length);
        assert.deepEqual(CLIP_TRACE.draws[0].uniformKeys, ['u_projection', 'u_texture']);
        assert.equal(CLIP_TRACE.draws[0].stencil?.func, 'equal', 'the batch keeps the active stencil test');
        assert.equal(RESULT.selfIntersectionRejected, true);
        assert.equal(RESULT.dynamicConcaveRejected, true);
        assert.equal(RESULT.savedClipDeletionRejected, true);
        assert.equal(RESULT.gradientStopLimitRejected, true);
        assert.equal(RESULT.clipPointLimitRejected, true);
        assert.equal(RESULT.missingStencilRejected, true);
        assert.equal(RESULT.authoredConvexCount, 160, 'dynamic convex clip preserves all 160 authored points');
        if (RESULT.restored) {
            assert.ok(
                RESULT.restorePixel[0] > 240 && RESULT.restorePixel[1] < 8,
                `restored retained-mesh clip ${RESULT.restorePixel}`,
            );
            assert.deepEqual(
                RESULT.restoreNotch,
                [0, 0, 255, 255],
                `restored concave clip keeps the notch clear ${RESULT.restoreNotch}`,
            );
        }
        assert.equal(RESULT.glError, 0);
        assert.equal(RESULT.disposed, true);
        assert.equal(PAGE_ERRORS.length, 0, PAGE_ERRORS.join('\n'));
        await PAGE.screenshot({
            path: screenshotPath,
            fullPage: true,
        });
        return RESULT;
    } finally {
        await PAGE.close();
    }
}

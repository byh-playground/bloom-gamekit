import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Run: npm run benchmark:rendering -- <label> [high|low]
// Frame cost of each 2D drawing path at a fixed scene size: draw calls, CPU time to submit the frame and GPU time
// (EXT_disjoint_timer_query_webgl2), median of 60 frames after warm-up. Use a real GPU browser for the GPU column:
//   CHROMIUM_EXECUTABLE_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"
// SwiftShader numbers verify function only. Mobile devices are not measured.
const ROOT = resolve('.');
const LABEL = process.argv[2] ?? 'unlabeled';
const GPU = process.argv[3] === 'low' ? 'low' : 'high';
const REPORT_PATH = resolve(ROOT, 'project/docs/rendering-benchmark.json');
const RENDERING =
    'data:text/javascript;base64,' + (await readFile(resolve(ROOT, 'dist/rendering.js'))).toString('base64');
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: [
        ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []),
        '--ignore-gpu-blocklist',
        GPU === 'low' ? '--force_low_power_gpu' : '--force_high_performance_gpu',
    ],
});
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 800, height: 600 } });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.setContent('<!doctype html><body style="margin:0"></body>');
    const RESULT = await PAGE.evaluate(
        async ({ rendering }) => {
            const MODULE = await import(rendering);
            const WIDTH = 1280,
                HEIGHT = 720;
            const MEDIAN = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];
            const RANDOM = (() => {
                let seed = 12345;
                return () => {
                    seed = (seed * 1664525 + 1013904223) >>> 0;
                    return seed / 4294967296;
                };
            })();
            const CANVAS = document.createElement('canvas');
            CANVAS.width = WIDTH;
            CANVAS.height = HEIGHT;
            document.body.append(CANVAS);
            const DEVICE = new MODULE.WebGLDevice(CANVAS, {
                alpha: false,
                antialias: false,
                depth: false,
                stencil: true,
                preserveDrawingBuffer: false,
            });
            const TIMER = DEVICE.gl.getExtension('EXT_disjoint_timer_query_webgl2');
            // 5x7 bitmap glyphs for the text scene.
            const BITMAP = {
                G: [14, 17, 16, 23, 17, 17, 14],
                F: [31, 16, 16, 30, 16, 16, 16],
                X: [17, 17, 10, 4, 10, 17, 17],
            };
            const CHARS = Object.keys(BITMAP);
            const GLYPH_DATA = new Uint8Array(CHARS.length * 6 * 7 * 4),
                GLYPHS = {};
            CHARS.forEach((char, index) => {
                for (let y = 0; y < 7; y++) {
                    for (let x = 0; x < 5; x++) {
                        if (BITMAP[char][y] & (1 << (4 - x))) {
                            GLYPH_DATA.set([255, 255, 255, 255], (y * CHARS.length * 6 + index * 6 + x) * 4);
                        }
                    }
                }
                GLYPHS[`U+${char.codePointAt(0).toString(16)}`] = {
                    x: index * 6,
                    y: 0,
                    width: 5,
                    height: 7,
                    advance: 6,
                    bearingY: 7,
                };
            });
            const ATLAS = new MODULE.GlyphAtlas(DEVICE, {
                width: CHARS.length * 6,
                height: 7,
                data: GLYPH_DATA,
                glyphs: GLYPHS,
                unitsPerEm: 7,
                ascent: 7,
                descent: 0,
                filter: 'nearest',
            });
            const CONTEXT = new MODULE.VectorContext(DEVICE, {
                glyphAtlas: ATLAS,
                initialVertices: 65536,
                maxVertices: 262144,
            });
            const SHEET = (() => {
                const SOURCE = document.createElement('canvas');
                SOURCE.width = SOURCE.height = 64;
                const PAINT = SOURCE.getContext('2d');
                PAINT.fillStyle = '#e7a23a';
                PAINT.beginPath();
                PAINT.arc(32, 32, 28, 0, Math.PI * 2);
                PAINT.fill();
                return SOURCE;
            })();
            const REGION = DEVICE.textureAtlas.allocate(64, 64, { filter: 'nearest' });
            DEVICE.textureAtlas.upload(REGION, SHEET);
            const SPRITES = MODULE.createSpriteAnimation(CONTEXT, REGION, {
                frames: [{ x: 0, y: 0, width: 64, height: 64, durationMs: 100 }],
                clips: { still: { frames: [0] } },
            });
            const SPRITE = SPRITES.createActor({ clip: 'still' });
            const PLACES = (count, size) =>
                Array.from({ length: count }, () => [RANDOM() * (WIDTH - size), RANDOM() * (HEIGHT - size)]);
            const POLYGONS = PLACES(400, 60).map(([x, y]) => ({
                x,
                y,
                sides: 5 + Math.floor(RANDOM() * 3),
                hue: Math.floor(RANDOM() * 360),
            }));
            const STRINGS = PLACES(300, 120);
            const GROUPS = PLACES(40, 160);
            const SPRITE_PLACES = PLACES(2000, 32);
            const MESH_PLACES = PLACES(2000, 40);
            const MESH_BUILDER = new MODULE.MeshBuilder();
            new MODULE.PrimitivePainter(MESH_BUILDER).circle(0, 0, 14, '#a8c991', 12);
            const MESH = CONTEXT.createMesh(MESH_BUILDER.build());
            const YARN = {
                kind: 'yarn',
                seed: 41,
                stitchWidth: 14.4,
                stitchHeight: 15.6,
                thickness: 0.41,
                irregularity: 0.13,
                contrast: 0.23,
                edgeSpacing: 10,
                edgeRelief: 3.04,
                edgeWidth: 3.92,
                fiberLength: 8.8,
                fiberWidth: 0.88,
                fiberOpacity: 0.65,
                fiberSpacing: 4,
                fiberMax: 155,
                curved: true,
                pattern: true,
                detail: false,
                fiber: true,
            };
            const SKETCH = {
                kind: 'sketch',
                seed: 7,
                periodMs: 800,
                amplitude: 1.2,
                frequency: 2,
                echoX: 2,
                echoY: 1.5,
                echoWidth: 1.4,
                echoOpacity: 0.7,
                hatchAngle: 0.7,
                hatchSpacing: 6,
                hatchWidth: 1.2,
                hatchOpacity: 0.6,
            };
            const DISC = (style, cx, color) => {
                const OUTLINE = [],
                    FILL = [],
                    EDGE = [];
                for (let i = 0; i < 72; i++) {
                    const A = (i / 72) * Math.PI * 2,
                        B = ((i + 1) / 72) * Math.PI * 2;
                    OUTLINE.push(cx + Math.cos(A) * 56, 90 + Math.sin(A) * 68);
                    FILL.push(
                        cx,
                        90,
                        ...color,
                        cx + Math.cos(A) * 56,
                        90 + Math.sin(A) * 68,
                        ...color,
                        cx + Math.cos(B) * 56,
                        90 + Math.sin(B) * 68,
                        ...color,
                    );
                    EDGE.push(...color);
                }
                return {
                    fillVertices: Float32Array.from(FILL),
                    outline: Float32Array.from(OUTLINE),
                    edgeColors: Float32Array.from(EDGE),
                    style,
                };
            };
            const MATERIAL_MESHES = CONTEXT.acquireMeshRenderer();
            const MATERIAL_MESH = MATERIAL_MESHES.createMesh(
                MODULE.buildYarnSurfaceMesh([
                    DISC(YARN, 80, [0.84, 0.49, 0.29, 1]),
                    DISC(SKETCH, 250, [0.46, 0.72, 0.58, 1]),
                ]),
            );
            const MATERIAL_PLACES = PLACES(256, 80);
            const PROJECTION = [2 / WIDTH, 0, 0, 0, -2 / HEIGHT, 0, -1, 1, 1];
            const POLYGON_PATH = (shape) => {
                CONTEXT.beginPath();
                for (let i = 0; i < shape.sides; i++) {
                    const A = (i / shape.sides) * Math.PI * 2,
                        X = shape.x + 30 + Math.cos(A) * 28,
                        Y = shape.y + 30 + Math.sin(A) * 28;
                    if (i === 0) {
                        CONTEXT.moveTo(X, Y);
                    } else {
                        CONTEXT.lineTo(X, Y);
                    }
                }
                CONTEXT.closePath();
            };
            const SCENES = {
                'paths: 400 filled+stroked polygons': () => {
                    for (const SHAPE of POLYGONS) {
                        POLYGON_PATH(SHAPE);
                        CONTEXT.fillStyle = `hsl(${SHAPE.hue}, 60%, 55%)`;
                        CONTEXT.fill();
                        CONTEXT.strokeStyle = '#102030';
                        CONTEXT.lineWidth = 2;
                        CONTEXT.stroke();
                    }
                },
                'curves: 200 bezier strokes': () => {
                    CONTEXT.strokeStyle = '#5ce3ad';
                    CONTEXT.lineWidth = 3;
                    for (const [X, Y] of PLACES(200, 80)) {
                        CONTEXT.beginPath();
                        CONTEXT.moveTo(X, Y);
                        CONTEXT.bezierCurveTo(X + 30, Y - 40, X + 50, Y + 40, X + 80, Y);
                        CONTEXT.stroke();
                    }
                },
                'text: 300 bitmap strings': () => {
                    CONTEXT.font = '28px sans-serif';
                    CONTEXT.fillStyle = '#f0e8a4';
                    for (const [X, Y] of STRINGS) {
                        CONTEXT.fillText('GFX', X, Y + 28);
                    }
                },
                'gradients: 60 linear fills': () => {
                    for (const [X, Y] of PLACES(60, 80)) {
                        const GRADIENT = CONTEXT.createLinearGradient(X, Y, X + 80, Y);
                        GRADIENT.addColorStop(0, '#ed5445');
                        GRADIENT.addColorStop(1, '#344cda');
                        CONTEXT.fillStyle = GRADIENT;
                        CONTEXT.fillRect(X, Y, 80, 40);
                    }
                },
                'groups: 40 half-opacity groups': () => {
                    for (const [X, Y] of GROUPS) {
                        CONTEXT.withGroupOpacity(
                            0.5,
                            () => {
                                CONTEXT.fillStyle = '#fa2420';
                                CONTEXT.fillRect(X, Y, 100, 100);
                                CONTEXT.fillRect(X + 40, Y + 30, 100, 100);
                            },
                            { x: X, y: Y, width: 160, height: 160 },
                        );
                    }
                },
                'sprites: 2000 atlas sprites': () => {
                    for (const [X, Y] of SPRITE_PLACES) {
                        SPRITE.draw({ timeMs: 0, matrix: [0.5, 0, 0, 0.5, X, Y] });
                    }
                },
                'meshes: 2000 retained mesh instances': () => {
                    for (const [X, Y] of MESH_PLACES) {
                        CONTEXT.drawMesh(MESH, { transform: [1, 0, 0, 1, X + 20, Y + 20] });
                    }
                },
                'materials: 256 yarn+sketch actors': () => {
                    MATERIAL_PLACES.forEach(([x, y], index) => {
                        MATERIAL_MESHES.drawMesh(MATERIAL_MESH, {
                            projection: PROJECTION,
                            matrix: [0.18, 0, 0, 0.18, x, y],
                            timeMs: index * 37,
                        });
                    });
                },
            };
            const MEASURE = async (draw) => {
                const FRAME = () => {
                    CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.06, 0.1, 0.14, 1] });
                    draw();
                    return CONTEXT.endFrame();
                };
                for (let i = 0; i < 15; i++) {
                    FRAME();
                    DEVICE.gl.finish();
                }
                const QUERIES = [],
                    CPU = [];
                let stats = null;
                for (let i = 0; i < 60; i++) {
                    const QUERY = DEVICE.gl.createQuery();
                    DEVICE.gl.beginQuery(TIMER.TIME_ELAPSED_EXT, QUERY);
                    const STARTED = performance.now();
                    stats = FRAME();
                    CPU.push(performance.now() - STARTED);
                    DEVICE.gl.endQuery(TIMER.TIME_ELAPSED_EXT);
                    QUERIES.push(QUERY);
                    DEVICE.gl.finish();
                }
                const GPU_MS = [];
                for (const QUERY of QUERIES) {
                    while (!DEVICE.gl.getQueryParameter(QUERY, DEVICE.gl.QUERY_RESULT_AVAILABLE)) {
                        await new Promise((resolveWait) => setTimeout(resolveWait, 1));
                    }
                    GPU_MS.push(DEVICE.gl.getQueryParameter(QUERY, DEVICE.gl.QUERY_RESULT) / 1e6);
                }
                return {
                    drawCalls: stats.drawCalls,
                    vertices: stats.vertices,
                    uploadedKiB: +(stats.uploadedBytes / 1024).toFixed(1),
                    cpuMs: +MEDIAN(CPU).toFixed(2),
                    gpuMs: +MEDIAN(GPU_MS).toFixed(2),
                };
            };
            const INFO = DEVICE.gl.getExtension('WEBGL_debug_renderer_info');
            const SCENE_RESULTS = {};
            for (const [NAME, DRAW] of Object.entries(SCENES)) {
                SCENE_RESULTS[NAME] = await MEASURE(DRAW);
            }
            const RENDERER = INFO
                ? DEVICE.gl.getParameter(INFO.UNMASKED_RENDERER_WEBGL)
                : DEVICE.gl.getParameter(DEVICE.gl.RENDERER);
            SPRITES.dispose();
            CONTEXT.dispose();
            ATLAS.dispose();
            DEVICE.dispose();
            return { renderer: RENDERER, canvas: [WIDTH, HEIGHT], scenes: SCENE_RESULTS };
        },
        { rendering: RENDERING },
    );
    if (ERRORS.length) {
        throw new Error(ERRORS.join('\n'));
    }
    const GIT = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    let report = {
        scope: 'Frame cost of each 2D drawing path: draw calls, CPU submit time and GPU time, median of 60 frames. Not mobile.',
        runs: [],
    };
    try {
        report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
    } catch {
        // First run creates the report.
    }
    report.runs = report.runs.filter((run) => run.label !== LABEL);
    report.runs.push({
        label: LABEL,
        gpu: GPU,
        sourceHead: GIT(['rev-parse', 'HEAD']),
        sourceDirty: GIT(['status', '--porcelain']) !== '',
        ...RESULT,
    });
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 4) + '\n');
    console.log(RESULT.renderer);
    console.table(RESULT.scenes);
} finally {
    await BROWSER.close();
}

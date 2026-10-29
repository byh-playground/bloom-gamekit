import { buildYarnSurfaceMesh, VectorContext, WebGLDevice } from '/dist/rendering.js';

const YARN_STYLE = {
    kind: 'yarn',
    seed: 41,
    stitchWidth: 14.4,
    stitchHeight: 15.6,
    thickness: 0.4102564103,
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
const SKETCH_STYLE = {
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
const COUNTS = { small: 12, medium: 60, large: 240 };
const POINTS = 72;
// One actor is a pair: a yarn disc on the left and a sketch disc on the right, both surfaces of the same mesh.
const PAIR_WIDTH = 330;
const PAIR_HEIGHT = 180;

function disc(style, centerX, centerY, color) {
    const OUTLINE = [],
        FILL = [],
        EDGE_COLORS = [];
    for (let i = 0; i < POINTS; i++) {
        const A = (i / POINTS) * Math.PI * 2,
            B = ((i + 1) / POINTS) * Math.PI * 2,
            AX = centerX + Math.cos(A) * 56,
            AY = centerY + Math.sin(A) * 68,
            BX = centerX + Math.cos(B) * 56,
            BY = centerY + Math.sin(B) * 68;
        OUTLINE.push(AX, AY);
        FILL.push(centerX, centerY, ...color, AX, AY, ...color, BX, BY, ...color);
        EDGE_COLORS.push(...color);
    }
    return {
        fillVertices: Float32Array.from(FILL),
        outline: Float32Array.from(OUTLINE),
        edgeColors: Float32Array.from(EDGE_COLORS),
        style,
    };
}

export function startMaterials(canvas, statsElement) {
    const WIDTH = canvas.width,
        HEIGHT = canvas.height,
        PROJECTION = [2 / WIDTH, 0, 0, 0, -2 / HEIGHT, 0, -1, 1, 1];
    const DEVICE = new WebGLDevice(canvas, {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
    });
    const CONTEXT = new VectorContext(DEVICE);
    const MESHES = CONTEXT.acquireMeshRenderer();
    const MESH = MESHES.createMesh(
        buildYarnSurfaceMesh([
            disc(YARN_STYLE, 80, 90, [0.84, 0.49, 0.29, 1]),
            disc(SKETCH_STYLE, 250, 90, [0.46, 0.72, 0.58, 1]),
        ]),
    );
    const BUTTONS = {
        small: document.querySelector('#materials-small'),
        medium: document.querySelector('#materials-medium'),
        large: document.querySelector('#materials-large'),
    };
    const PLAY = document.querySelector('#materials-play');
    const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
    let count = COUNTS.small,
        playing = !REDUCED_MOTION.matches,
        visible = false,
        timeMs = 0,
        frame = 0;
    const EXAMPLE = {
        device: DEVICE,
        context: CONTEXT,
        meshes: MESHES,
        mesh: MESH,
        count,
        draws: 0,
        surfaces: 0,
        // Draws every actor of the grid with its own display time and returns the draw calls the mesh renderer used.
        drawFrame(atMs = timeMs) {
            timeMs = atMs;
            const COLUMNS = Math.ceil(Math.sqrt((count * WIDTH) / HEIGHT)),
                ROWS = Math.ceil(count / COLUMNS),
                SCALE = Math.min(WIDTH / COLUMNS / PAIR_WIDTH, HEIGHT / ROWS / PAIR_HEIGHT) * 0.94;
            CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.06, 0.1, 0.14, 1] });
            for (let i = 0; i < count; i++) {
                const X = ((i % COLUMNS) + 0.5) * (WIDTH / COLUMNS) - (PAIR_WIDTH / 2) * SCALE,
                    Y = (Math.floor(i / COLUMNS) + 0.5) * (HEIGHT / ROWS) - (PAIR_HEIGHT / 2) * SCALE;
                MESHES.drawMesh(MESH, {
                    projection: PROJECTION,
                    matrix: [SCALE, 0, 0, SCALE, X, Y],
                    // Every actor has its own time, and they still share the one draw.
                    timeMs: atMs + i * 37,
                });
            }
            CONTEXT.endFrame();
            EXAMPLE.draws = MESHES.stats().draws;
            EXAMPLE.surfaces = count * 2;
            statsElement.textContent = `개체 ${count}개 · 표면 ${count * 2}개 · 그리기 호출 ${EXAMPLE.draws}회`;
            return EXAMPLE.draws;
        },
        setCount(name) {
            if (!Object.hasOwn(COUNTS, name)) {
                throw new RangeError('count must be small, medium or large');
            }
            count = COUNTS[name];
            EXAMPLE.count = count;
            for (const [KEY, BUTTON] of Object.entries(BUTTONS)) {
                BUTTON.setAttribute('aria-pressed', String(KEY === name));
            }
            return EXAMPLE.drawFrame();
        },
        setPlaying(on) {
            playing = on;
            PLAY.setAttribute('aria-pressed', String(on));
            EXAMPLE.resume();
        },
        pause() {
            visible = false;
            cancelAnimationFrame(frame);
        },
        resume() {
            visible = true;
            cancelAnimationFrame(frame);
            if (playing && visible) {
                const TICK = (now) => {
                    EXAMPLE.drawFrame(now);
                    frame = requestAnimationFrame(TICK);
                };
                frame = requestAnimationFrame(TICK);
            }
        },
        readPixels() {
            const PIXELS = new Uint8Array(WIDTH * HEIGHT * 4);
            DEVICE.gl.readPixels(0, 0, WIDTH, HEIGHT, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        },
        dispose() {
            cancelAnimationFrame(frame);
            CONTEXT.dispose();
            DEVICE.dispose();
        },
    };
    for (const [NAME, BUTTON] of Object.entries(BUTTONS)) {
        BUTTON.addEventListener('click', () => EXAMPLE.setCount(NAME));
    }
    PLAY.setAttribute('aria-pressed', String(playing));
    PLAY.addEventListener('click', () => EXAMPLE.setPlaying(!playing));
    EXAMPLE.drawFrame(0);
    return EXAMPLE;
}

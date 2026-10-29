import { GlyphAtlas, VectorContext, WebGLDevice } from '/dist/rendering.js';

// Prebaked 5x7 bitmap cells: G, F, X. No font rasterization or pixel readback.
const BITMAP = {
    G: [14, 17, 16, 23, 17, 17, 14],
    F: [31, 16, 16, 30, 16, 16, 16],
    X: [17, 17, 10, 4, 10, 17, 17],
};
const CELL_WIDTH = 6;
const CELL_HEIGHT = 7;
const RED = [0.98, 0.14, 0.12, 1];

function bitmapAtlas(device) {
    const CHARS = Object.keys(BITMAP),
        WIDTH = CHARS.length * CELL_WIDTH,
        DATA = new Uint8Array(WIDTH * CELL_HEIGHT * 4),
        GLYPHS = {};
    CHARS.forEach((char, index) => {
        for (let y = 0; y < CELL_HEIGHT; y++) {
            for (let x = 0; x < 5; x++) {
                if (BITMAP[char][y] & (1 << (4 - x))) {
                    DATA.set([255, 255, 255, 255], (y * WIDTH + index * CELL_WIDTH + x) * 4);
                }
            }
        }
        GLYPHS[`U+${char.codePointAt(0).toString(16)}`] = {
            x: index * CELL_WIDTH,
            y: 0,
            width: 5,
            height: CELL_HEIGHT,
            advance: 6,
            bearingY: 7,
        };
    });
    return new GlyphAtlas(device, {
        width: WIDTH,
        height: CELL_HEIGHT,
        data: DATA,
        glyphs: GLYPHS,
        unitsPerEm: 7,
        ascent: 7,
        descent: 0,
        filter: 'nearest',
    });
}

function polygon(context, points) {
    context.beginPath();
    context.moveTo(...points[0]);
    for (const POINT of points.slice(1)) {
        context.lineTo(...POINT);
    }
    context.closePath();
    context.fill();
}

export function startVector(canvas, statsElement) {
    const DEVICE = new WebGLDevice(canvas, {
        alpha: true,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
    });
    const ATLAS = bitmapAtlas(DEVICE);
    const CONTEXT = new VectorContext(DEVICE, { glyphAtlas: ATLAS });
    const STARTED = performance.now();
    CONTEXT.beginFrame({ clearColor: [0.035, 0.055, 0.075, 1] });
    // Two overlapping polygons composed once at half opacity: the overlap is not darker than the rest.
    CONTEXT.withGroupOpacity(
        0.5,
        () => {
            CONTEXT.fillStyle = RED;
            polygon(CONTEXT, [
                [290, 155],
                [480, 155],
                [480, 335],
                [290, 335],
            ]);
            polygon(CONTEXT, [
                [420, 155],
                [610, 155],
                [610, 335],
                [420, 335],
            ]);
        },
        { x: 200, y: 80, width: 500, height: 300 },
    );
    CONTEXT.beginPath();
    CONTEXT.moveTo(190, 380);
    CONTEXT.bezierCurveTo(280, 270, 380, 465, 485, 350);
    CONTEXT.strokeStyle = [0.36, 0.89, 0.68, 1];
    CONTEXT.lineWidth = 6;
    CONTEXT.stroke();
    CONTEXT.save();
    CONTEXT.beginPath();
    CONTEXT.rect(660, 100, 160, 250);
    CONTEXT.clip();
    CONTEXT.fillStyle = [0.31, 0.63, 0.92, 1];
    CONTEXT.beginPath();
    CONTEXT.moveTo(650, 125);
    CONTEXT.lineTo(840, 125);
    CONTEXT.lineTo(785, 305);
    CONTEXT.lineTo(685, 305);
    CONTEXT.closePath();
    CONTEXT.fill('evenodd');
    CONTEXT.restore();
    CONTEXT.font = '56px sans-serif';
    CONTEXT.textAlign = 'center';
    CONTEXT.textBaseline = 'alphabetic';
    CONTEXT.fillStyle = [0.94, 0.91, 0.64, 1];
    CONTEXT.fillText('GFX', 690, 365);
    CONTEXT.endFrame();
    const CPU_SUBMIT_MS = performance.now() - STARTED;
    statsElement.textContent =
        `${DEVICE.stats.drawCalls} draw calls · ${DEVICE.stats.vertices} vertices · ` +
        `${DEVICE.stats.bufferBytes.toLocaleString()} uploaded bytes · ` +
        `${DEVICE.stats.gpuRenderTargetBytes.toLocaleString()} render-target bytes · CPU submit ${CPU_SUBMIT_MS.toFixed(2)} ms`;
    return {
        device: DEVICE,
        context: CONTEXT,
        atlas: ATLAS,
        cpuSubmitMs: CPU_SUBMIT_MS,
        dispose() {
            CONTEXT.dispose();
            ATLAS.dispose();
            DEVICE.dispose();
        },
    };
}

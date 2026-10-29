import { createSpriteAnimation, VectorContext, WebGLDevice } from '/dist/rendering.js';

const PAGE_COUNT = 4;
const CELL = 32;
const PAGE_SIZE = CELL * 2;
const SPRITE_COUNT = 240;

// Page p is a 2x2 sheet of four shapes in one hue; the hue identifies the page on screen.
function drawPage(page) {
    const SHEET = document.createElement('canvas');
    SHEET.width = SHEET.height = PAGE_SIZE;
    const SHEET_CONTEXT = SHEET.getContext('2d');
    for (let cell = 0; cell < 4; cell++) {
        const X = (cell % 2) * CELL + CELL / 2;
        const Y = Math.floor(cell / 2) * CELL + CELL / 2;
        const R = CELL * 0.42;
        SHEET_CONTEXT.fillStyle = `hsl(${page * 90 + 20}, 80%, ${45 + cell * 6}%)`;
        SHEET_CONTEXT.beginPath();
        if (cell === 0) {
            SHEET_CONTEXT.arc(X, Y, R, 0, Math.PI * 2);
        } else if (cell === 1) {
            SHEET_CONTEXT.rect(X - R, Y - R, R * 2, R * 2);
        } else if (cell === 2) {
            SHEET_CONTEXT.moveTo(X, Y - R);
            SHEET_CONTEXT.lineTo(X + R, Y + R);
            SHEET_CONTEXT.lineTo(X - R, Y + R);
            SHEET_CONTEXT.closePath();
        } else {
            SHEET_CONTEXT.moveTo(X, Y - R);
            SHEET_CONTEXT.lineTo(X + R, Y);
            SHEET_CONTEXT.lineTo(X, Y + R);
            SHEET_CONTEXT.lineTo(X - R, Y);
            SHEET_CONTEXT.closePath();
        }
        SHEET_CONTEXT.fill();
    }
    return SHEET;
}

function cellRect(cell) {
    return { x: (cell % 2) * CELL, y: Math.floor(cell / 2) * CELL, width: CELL, height: CELL };
}

export function startAtlas(canvas, statsElement) {
    const WIDTH = canvas.width;
    const HEIGHT = canvas.height;
    const DEVICE = new WebGLDevice(canvas, {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
    });
    const CONTEXT = new VectorContext(DEVICE);
    // One atlas region per sheet; the device array holds all four.
    const REGIONS = Array.from({ length: PAGE_COUNT }, (_unused, page) => {
        const REGION = DEVICE.textureAtlas.allocate(PAGE_SIZE, PAGE_SIZE, { filter: 'nearest' });
        DEVICE.textureAtlas.upload(REGION, drawPage(page));
        return REGION;
    });
    const SPRITES = REGIONS.map((region) =>
        createSpriteAnimation(CONTEXT, region, {
            frames: [0, 1, 2, 3].map((cell) => ({ ...cellRect(cell), durationMs: 100 })),
            clips: Object.fromEntries([0, 1, 2, 3].map((cell) => [`c${cell}`, { frames: [cell] }])),
        }),
    );
    const PLAYERS = Array.from({ length: PAGE_COUNT * 4 }, (_unused, index) =>
        SPRITES[Math.floor(index / 4)].createPlayer({ clip: `c${index % 4}` }),
    );
    // Deterministic placement; sprite i uses page i % 4, so consecutive sprites never share a page.
    let seed = 12345;
    const RANDOM = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const PLACEMENTS = Array.from({ length: SPRITE_COUNT }, (_unused, index) => ({
        frame: (index % PAGE_COUNT) * 4 + (Math.floor(index / PAGE_COUNT) % 4),
        x: Math.floor(RANDOM() * (WIDTH - CELL)),
        y: Math.floor(RANDOM() * (HEIGHT - CELL)),
    }));
    const BUTTONS = {
        sprites: document.querySelector('#atlas-sprites'),
        mixed: document.querySelector('#atlas-mixed'),
    };
    const EXAMPLE = {
        device: DEVICE,
        mode: 'sprites',
        drawCalls: 0,
        spriteCount: SPRITE_COUNT,
        setMode(mode) {
            if (mode !== 'sprites' && mode !== 'mixed') {
                throw new TypeError('mode must be sprites or mixed');
            }
            EXAMPLE.mode = mode;
            CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.06, 0.1, 0.14, 1] });
            for (const PLACEMENT of PLACEMENTS) {
                if (mode === 'mixed') {
                    CONTEXT.fillStyle = 'rgba(255, 255, 255, 0.25)';
                    CONTEXT.fillRect(PLACEMENT.x - 2, PLACEMENT.y - 2, CELL + 4, CELL + 4);
                }
                PLAYERS[PLACEMENT.frame].draw({
                    timeMs: 0,
                    matrix: [1, 0, 0, 1, PLACEMENT.x, PLACEMENT.y],
                });
            }
            EXAMPLE.drawCalls = CONTEXT.endFrame().drawCalls;
            for (const [NAME, BUTTON] of Object.entries(BUTTONS)) {
                BUTTON.setAttribute('aria-pressed', String(NAME === mode));
            }
            statsElement.textContent =
                `그리기 호출 ${EXAMPLE.drawCalls}회 · 스프라이트 ${SPRITE_COUNT}개` +
                (mode === 'mixed' ? ` · 사각형 ${SPRITE_COUNT}개 끼워 그림` : '');
            return EXAMPLE.drawCalls;
        },
        readPixels() {
            const GL = DEVICE.gl;
            const PIXELS = new Uint8Array(WIDTH * HEIGHT * 4);
            GL.readPixels(0, 0, WIDTH, HEIGHT, GL.RGBA, GL.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        },
        dispose() {
            SPRITES.forEach((sprites) => sprites.dispose());
            CONTEXT.dispose();
            DEVICE.dispose();
        },
    };
    BUTTONS.sprites.addEventListener('click', () => EXAMPLE.setMode('sprites'));
    BUTTONS.mixed.addEventListener('click', () => EXAMPLE.setMode('mixed'));
    EXAMPLE.setMode('sprites');
    return EXAMPLE;
}

import { VectorContext, WebGLDevice } from '/dist/rendering.js';
import { FACE_IDS, FaceOverlay } from '/dist/face.js';

// A round blob stands in for a vector-assets body: all FaceOverlay needs from a body is its three face sockets
// (`compiled.metadata.sockets`) and from an actor the posed socket positions (`actor.getSocket`).
const SOCKETS = {
    'face-eye-left': [-22, -8],
    'face-eye-right': [22, -8],
    'face-mouth': [0, 22],
};
const BODY = {
    sourcePath: 'example blob',
    metadata: {
        sockets: Object.fromEntries(Object.entries(SOCKETS).map(([id, point]) => [id, { part: 'body', point }])),
    },
};
const BODY_RADIUS = 56;
const BODY_COLOR = [0.96, 0.84, 0.55, 1];
const RING_COLOR = [0.56, 0.82, 0.92, 1];
const CHEEK_COLORS = [null, '#4f8fe8'];
// The grid of every face (baked images) on the left, the selected face drawn large (paths) on the right.
const COLUMNS = 4;
const CELL_WIDTH = 120;
const CELL_HEIGHT = 100;
const GRID_SCALE = 0.7;
const PREVIEW = { x: 600, y: 200, scale: 1.7 };

// The pose is the squash, lean and bounce the game gives its body; the actor reports where the sockets ended up.
function createActor() {
    const POSE = [1, 0, 0, 1, 0, 0];
    return {
        pose: POSE,
        getSocket(id) {
            const [X, Y] = SOCKETS[id];
            return { x: POSE[0] * X + POSE[2] * Y + POSE[4], y: POSE[1] * X + POSE[3] * Y + POSE[5] };
        },
        set(timeMs, phase) {
            const T = timeMs / 420 + phase;
            POSE[0] = 1 + 0.07 * Math.sin(T);
            POSE[2] = 0.1 * Math.sin(T * 0.7);
            POSE[3] = 1 - 0.07 * Math.sin(T);
            POSE[5] = -5 * Math.abs(Math.sin(T * 0.5));
        },
    };
}

export function startFace(canvas, statsElement) {
    const WIDTH = canvas.width,
        HEIGHT = canvas.height;
    const DEVICE = new WebGLDevice(canvas, {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
    });
    const CONTEXT = new VectorContext(DEVICE);
    const OVERLAY = new FaceOverlay(CONTEXT);
    OVERLAY.prepare();
    const ACTOR = createActor();
    const PLAY = document.querySelector('#face-play'),
        NEXT = document.querySelector('#face-next'),
        CHEEK = document.querySelector('#face-cheek');
    const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
    let selected = 0,
        cheek = 0,
        playing = !REDUCED_MOTION.matches,
        timeMs = 0,
        frame = 0;
    // Body, then the face over it with the same screen matrix; returns whether the face used baked images.
    const DRAW_BLOB = (faceId, matrix, phase) => {
        ACTOR.set(timeMs, phase);
        CONTEXT.save();
        CONTEXT.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        CONTEXT.transform(...ACTOR.pose);
        CONTEXT.fillStyle = BODY_COLOR;
        CONTEXT.beginPath();
        CONTEXT.arc(0, 0, BODY_RADIUS, 0, Math.PI * 2);
        CONTEXT.fill();
        CONTEXT.restore();
        return OVERLAY.draw(BODY, ACTOR, faceId, matrix, 1, CHEEK_COLORS[cheek]);
    };
    const EXAMPLE = {
        device: DEVICE,
        context: CONTEXT,
        overlay: OVERLAY,
        selected: FACE_IDS[selected],
        drawn: { images: 0, paths: 0 },
        drawFrame(atMs = timeMs) {
            timeMs = atMs;
            if (!CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.06, 0.1, 0.14, 1] })) {
                return false;
            }
            let images = 0,
                paths = 0;
            const COUNT = (baked) => (baked ? images++ : paths++);
            for (const [INDEX, FACE] of FACE_IDS.entries()) {
                const X = ((INDEX % COLUMNS) + 0.5) * CELL_WIDTH,
                    Y = (Math.floor(INDEX / COLUMNS) + 0.5) * CELL_HEIGHT;
                if (INDEX === selected) {
                    CONTEXT.strokeStyle = RING_COLOR;
                    CONTEXT.lineWidth = 3;
                    CONTEXT.beginPath();
                    CONTEXT.arc(X, Y, BODY_RADIUS * GRID_SCALE + 8, 0, Math.PI * 2);
                    CONTEXT.stroke();
                }
                COUNT(DRAW_BLOB(FACE, [GRID_SCALE, 0, 0, GRID_SCALE, X, Y], INDEX));
            }
            COUNT(DRAW_BLOB(FACE_IDS[selected], [PREVIEW.scale, 0, 0, PREVIEW.scale, PREVIEW.x, PREVIEW.y], selected));
            CONTEXT.endFrame();
            EXAMPLE.drawn = { images, paths };
            statsElement.textContent = `표정 ${FACE_IDS[selected]} · 이미지로 ${images}개 · 경로로 ${paths}개 · 그리기 호출 ${DEVICE.stats.drawCalls}회`;
            return true;
        },
        select(faceId) {
            const INDEX = FACE_IDS.indexOf(faceId);
            if (INDEX < 0) {
                throw new RangeError('unknown face: ' + faceId);
            }
            selected = INDEX;
            EXAMPLE.selected = faceId;
            return EXAMPLE.drawFrame();
        },
        setPlaying(on) {
            playing = on;
            PLAY.setAttribute('aria-pressed', String(on));
            EXAMPLE.resume();
        },
        pause() {
            cancelAnimationFrame(frame);
        },
        resume() {
            cancelAnimationFrame(frame);
            if (playing) {
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
            OVERLAY.dispose();
            CONTEXT.dispose();
            DEVICE.dispose();
        },
    };
    PLAY.setAttribute('aria-pressed', String(playing));
    PLAY.addEventListener('click', () => EXAMPLE.setPlaying(!playing));
    NEXT.addEventListener('click', () => EXAMPLE.select(FACE_IDS[(selected + 1) % FACE_IDS.length]));
    CHEEK.addEventListener('click', () => {
        cheek = (cheek + 1) % CHEEK_COLORS.length;
        CHEEK.setAttribute('aria-pressed', String(cheek > 0));
        EXAMPLE.drawFrame();
    });
    // Tapping a face in the grid enlarges it on the right.
    canvas.addEventListener('pointerdown', (event) => {
        const BOX = canvas.getBoundingClientRect(),
            X = ((event.clientX - BOX.left) / BOX.width) * WIDTH,
            Y = ((event.clientY - BOX.top) / BOX.height) * HEIGHT,
            INDEX = Math.floor(Y / CELL_HEIGHT) * COLUMNS + Math.floor(X / CELL_WIDTH);
        if (X < COLUMNS * CELL_WIDTH && INDEX >= 0 && INDEX < FACE_IDS.length) {
            EXAMPLE.select(FACE_IDS[INDEX]);
        }
    });
    EXAMPLE.drawFrame(0);
    return EXAMPLE;
}

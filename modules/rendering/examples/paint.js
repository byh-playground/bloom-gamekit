import { VectorContext, WebGLDevice } from '/dist/rendering.js';

// A retained concave "L" clip: a plain convex clip cannot express the notch.
const CLIP_POINTS = new Float32Array([380, 40, 680, 40, 680, 150, 500, 150, 500, 360, 380, 360]);

export function startPaint(canvas, statsElement) {
    const WIDTH = canvas.width,
        HEIGHT = canvas.height;
    const DEVICE = new WebGLDevice(canvas, {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: true,
        preserveDrawingBuffer: true,
    });
    const CONTEXT = new VectorContext(DEVICE);
    // Retained clips are created outside a frame, once.
    const CLIP = CONTEXT.createClipPath(CLIP_POINTS);
    const BUTTON = document.querySelector('#paint-clip');
    const EXAMPLE = {
        device: DEVICE,
        context: CONTEXT,
        clipped: true,
        drawCalls: 0,
        draw(clipped = EXAMPLE.clipped) {
            EXAMPLE.clipped = clipped;
            CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.06, 0.1, 0.14, 1] });
            const LINEAR = CONTEXT.createLinearGradient(30, 0, 330, 0);
            LINEAR.addColorStop(0, '#ed5445');
            LINEAR.addColorStop(0.5, 'rgba(248, 198, 72, 0.7)');
            LINEAR.addColorStop(1, '#344cda');
            CONTEXT.fillStyle = LINEAR;
            CONTEXT.beginPath();
            CONTEXT.roundRect(30, 40, 300, 120, 14);
            CONTEXT.fill();
            const RADIAL = CONTEXT.createRadialGradient(180, 280, 4, 180, 280, 86);
            RADIAL.addColorStop(0, '#fff8d0');
            RADIAL.addColorStop(1, '#fff8d000');
            CONTEXT.fillStyle = RADIAL;
            CONTEXT.beginPath();
            CONTEXT.arc(180, 280, 86, 0, Math.PI * 2);
            CONTEXT.fill();
            // The same gradient painted through the concave clip: only the "L" shape receives color.
            CONTEXT.save();
            if (clipped) {
                CONTEXT.clipPath(CLIP);
            }
            const WIDE = CONTEXT.createLinearGradient(380, 0, 680, 0);
            WIDE.addColorStop(0, '#5ce3ad');
            WIDE.addColorStop(1, '#4fa0eb');
            CONTEXT.fillStyle = WIDE;
            CONTEXT.fillRect(360, 20, 340, 360);
            CONTEXT.restore();
            EXAMPLE.drawCalls = CONTEXT.endFrame().drawCalls;
            BUTTON.setAttribute('aria-pressed', String(clipped));
            BUTTON.textContent = clipped ? '클립 경로 끄기' : '클립 경로 켜기';
            statsElement.textContent = `그리기 호출 ${EXAMPLE.drawCalls}회 · 클립 경로 ${clipped ? '적용' : '없음'}`;
            return EXAMPLE.drawCalls;
        },
        readPixels() {
            const PIXELS = new Uint8Array(WIDTH * HEIGHT * 4);
            DEVICE.gl.readPixels(0, 0, WIDTH, HEIGHT, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXELS);
            return PIXELS;
        },
        dispose() {
            CONTEXT.deleteClipPath(CLIP);
            CONTEXT.dispose();
            DEVICE.dispose();
        },
    };
    BUTTON.addEventListener('click', () => EXAMPLE.draw(!EXAMPLE.clipped));
    EXAMPLE.draw(true);
    return EXAMPLE;
}

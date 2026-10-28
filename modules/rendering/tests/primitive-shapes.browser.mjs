/** Checks that analytic primitives share the vector stream: one draw, painter order, transforms, clipping, warm-frame uploads. */
export async function exercisePrimitiveShapes(page, moduleURL = '/dist/rendering.js') {
    return page.evaluate(async (url) => {
        const {
            WebGLDevice: WEB_GL_DEVICE,
            VectorContext: VECTOR_CONTEXT,
            PrimitivePainter: PRIMITIVE_PAINTER,
        } = await import(url);
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 128;
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
            alpha: false,
            antialias: false,
            checkGLErrors: true,
        });
        const CONTEXT = new VECTOR_CONTEXT(DEVICE);
        let arcPointBuilds = 0;
        const ORIGINAL_ARC_POINTS = CONTEXT._arcPoints.bind(CONTEXT);
        CONTEXT._arcPoints = (...args) => {
            arcPointBuilds++;
            return ORIGINAL_ARC_POINTS(...args);
        };
        const DRAW = () => {
            CONTEXT.beginFrame({
                clearColor: [0, 0, 0, 1],
            });
            CONTEXT.fillStyle = '#ff0000';
            CONTEXT.beginPath();
            CONTEXT.ellipse(26, 26, 18, 10, 0.4, 0, Math.PI * 2);
            CONTEXT.fill();
            CONTEXT.fillStyle = '#00ff00';
            CONTEXT.beginPath();
            CONTEXT.arc(70, 26, 12, 0, Math.PI * 2);
            CONTEXT.fill();
            CONTEXT.fillStyle = '#0000ff';
            CONTEXT.fillRect(104, 16, 18, 22);
            CONTEXT.save();
            CONTEXT.translate(62, 72);
            CONTEXT.rotate(0.5);
            CONTEXT.scale(1.4, 0.6);
            CONTEXT.fillStyle = '#ff00ff';
            CONTEXT.fillRect(-10, -6, 20, 12);
            CONTEXT.restore();
            CONTEXT.strokeStyle = '#ffff00';
            CONTEXT.lineWidth = 8;
            CONTEXT.lineCap = 'round';
            CONTEXT.beginPath();
            CONTEXT.moveTo(16, 78);
            CONTEXT.lineTo(46, 92);
            CONTEXT.stroke();
            CONTEXT.strokeStyle = '#00ffff';
            CONTEXT.lineWidth = 4;
            CONTEXT.strokeRect(78, 60, 24, 20);
            CONTEXT.globalAlpha = 0.5;
            CONTEXT.fillStyle = '#ff0000';
            CONTEXT.beginPath();
            CONTEXT.arc(100, 104, 12, 0, Math.PI * 2);
            CONTEXT.fill();
            CONTEXT.fillStyle = '#0000ff';
            CONTEXT.beginPath();
            CONTEXT.arc(100, 104, 12, 0, Math.PI * 2);
            CONTEXT.fill();
            CONTEXT.globalAlpha = 1;
            CONTEXT.save();
            CONTEXT.beginPath();
            CONTEXT.rect(0, 110, 30, 18);
            CONTEXT.clip();
            CONTEXT.fillStyle = '#ffffff';
            CONTEXT.fillRect(0, 110, 128, 18);
            CONTEXT.restore();
            return CONTEXT.endFrame();
        };
        DRAW();
        const WARM_CAPACITY = DEVICE.stats.bufferAllocations;
        const FRAME = DRAW();
        const GL = DEVICE.gl;
        const PIXEL = (x, y) => {
            const VALUE = new Uint8Array(4);
            GL.readPixels(x, CANVAS.height - y - 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, VALUE);
            return Array.from(VALUE);
        };
        const ERROR = GL.getError();
        const RESULT = {
            circle: PIXEL(70, 26),
            ellipse: PIXEL(26, 26),
            rect: PIXEL(110, 24),
            rotatedRect: PIXEL(62, 72),
            line: PIXEL(30, 84),
            overlap: PIXEL(100, 104),
            clippedInside: PIXEL(8, 116),
            clippedOutside: PIXEL(42, 116),
            pathTessellations: DEVICE.stats.pathTessellations,
            pathStrokeBuilds: DEVICE.stats.pathStrokeBuilds,
            arcPointBuilds,
            bufferUploads: DEVICE.stats.bufferUploads,
            bufferAllocationsAfterWarmup: DEVICE.stats.bufferAllocations - WARM_CAPACITY,
            drawCalls: FRAME.drawCalls,
            uploadedBytes: FRAME.uploadedBytes,
            vertices: FRAME.vertices,
            glError: ERROR,
        };
        const PAINTER = new PRIMITIVE_PAINTER(CONTEXT);
        CONTEXT.beginFrame({
            clearColor: [0, 0, 0, 1],
        });
        PAINTER.ellipse(30, 30, 20, 8, '#ff0000', 24);
        PAINTER.ellipse(90, 30, 20, 8, '#00ff00', 24, Math.PI / 2);
        PAINTER.box(30, 80, 30, 10, '#0000ff');
        PAINTER.box(90, 80, 30, 10, '#ffff00', Math.PI / 2);
        const PAINTER_FRAME = CONTEXT.endFrame();
        RESULT.painter = {
            ellipseWide: PIXEL(46, 30),
            ellipseFlat: PIXEL(30, 42),
            ellipseRotatedTall: PIXEL(90, 46),
            ellipseRotatedNarrow: PIXEL(106, 30),
            boxWide: PIXEL(42, 80),
            boxFlat: PIXEL(30, 90),
            boxRotatedTall: PIXEL(90, 92),
            boxRotatedNarrow: PIXEL(102, 80),
            drawCalls: PAINTER_FRAME.drawCalls,
            glError: GL.getError(),
        };
        CONTEXT.dispose();
        DEVICE.dispose();
        return RESULT;
    }, moduleURL);
}

export async function exerciseFrameMetrics(page) {
    return page.evaluate(async () => {
        const { FrameMetrics: FRAME_METRICS } = await import('/dist/debug-tools.js'),
            { WebGLDevice: DEVICE_TYPE, VectorContext: CONTEXT_TYPE } = await import('/dist/rendering.js'),
            CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 64;
        document.body.append(CANVAS);
        const DEVICE = new DEVICE_TYPE(CANVAS, { preserveDrawingBuffer: true }),
            CONTEXT = new CONTEXT_TYPE(DEVICE),
            METRICS = new FRAME_METRICS({ capacity: 4, stages: ['render'], counters: ['draws', 'fills', 'uploads'] });
        for (let index = 0; index < 8; index++) {
            const TIME = await new Promise(requestAnimationFrame);
            METRICS.beginFrame(TIME);
            const START = performance.now();
            CONTEXT.beginFrame({ clearColor: [0, 0, 0, 1] });
            CONTEXT.beginPath();
            CONTEXT.moveTo(2, 2);
            CONTEXT.lineTo(60, 2);
            CONTEXT.lineTo(60, 60);
            CONTEXT.lineTo(2, 60);
            CONTEXT.closePath();
            CONTEXT.fillStyle = '#ff0000';
            CONTEXT.fill();
            CONTEXT.flush();
            CONTEXT.endFrame();
            METRICS.stage('render', performance.now() - START);
            METRICS.count('draws', DEVICE.stats.drawCalls);
            METRICS.count('fills', DEVICE.stats.pathTessellations);
            METRICS.count('uploads', DEVICE.stats.bufferUploads);
            METRICS.endFrame();
        }
        const PIXEL = new Uint8Array(4);
        DEVICE.gl.readPixels(32, 32, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXEL);
        const REPORT = METRICS.snapshot({ limit: 1, slowFrameMs: 0, slowLimit: 2 });
        if (
            PIXEL[0] < 240 ||
            PIXEL[1] > 10 ||
            REPORT.retainedFrames !== 4 ||
            REPORT.frames.length !== 1 ||
            REPORT.slowFrames.length !== 2 ||
            REPORT.counts.draws.total < 4 ||
            REPORT.counts.fills.total !== 4 ||
            REPORT.counts.uploads.total < 4 ||
            !(REPORT.windowMs > 0) ||
            REPORT.stagesMs.render.max < 0
        ) {
            throw new Error('WebGL scene diagnostics lost pixels, bounded history or matching frame counters');
        }
        CONTEXT.dispose();
        DEVICE.dispose();
        CANVAS.remove();
        return {
            retainedFrames: REPORT.retainedFrames,
            frameWindowMs: REPORT.windowMs,
            actualRedPixel: [...PIXEL],
            fills: REPORT.counts.fills.total,
            draws: REPORT.counts.draws.total,
            sameFrameSlowSamples: REPORT.slowFrames.length,
        };
    });
}

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
        const REPORT = METRICS.snapshot({ limit: 1 });
        if (
            PIXEL[0] < 240 ||
            PIXEL[1] > 10 ||
            REPORT.retainedFrames !== 4 ||
            REPORT.frames.length !== 1 ||
            REPORT.format !== 'bloom numeric frame metrics v2' ||
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
        // 히치 보관: 60Hz 간격 사이의 튄 프레임 하나가 링(4프레임)이 여러 바퀴 돈 뒤에도 직전 3프레임과 함께 남는다.
        let clock = 0,
            time = 1000;
        const HITCH_METRICS = new FRAME_METRICS({
                capacity: 4,
                stages: ['render'],
                counters: ['jump', 'draws'],
                now: () => clock,
            }),
            FRAME = (intervalMs, { jump = 0, cpuMs = 2 } = {}) => {
                time += intervalMs;
                clock = time;
                HITCH_METRICS.beginFrame(time);
                clock += cpuMs;
                HITCH_METRICS.stage('render', cpuMs);
                HITCH_METRICS.count('draws', 28);
                HITCH_METRICS.count('jump', jump);
                HITCH_METRICS.endFrame();
            };
        for (let index = 0; index < 20; index++) {
            FRAME(16.7);
        }
        FRAME(16.7, { jump: 1 });
        FRAME(16.7, { cpuMs: 120 });
        FRAME(136.7);
        for (let index = 0; index < 10; index++) {
            FRAME(16.7);
        }
        HITCH_METRICS.skipInterval();
        FRAME(3000);
        FRAME(16.7);
        FRAME(1500);
        const HITCHES = HITCH_METRICS.hitches(),
            HITCH_TEXT = HITCH_METRICS.hitchText();
        if (
            HITCHES.length !== 1 ||
            HITCH_METRICS.hitchTotal !== 1 ||
            HITCHES[0].sequence !== 22 ||
            Math.round(HITCHES[0].intervalMs) !== 137 ||
            HITCHES[0].stagesMs.render !== 120 ||
            Math.round(HITCHES[0].medianMs * 10) !== 167 ||
            HITCHES[0].before.map((frame) => frame.counts.jump).join() !== '0,0,1' ||
            HITCHES[0].before.map((frame) => frame.sequence).join() !== '19,20,21' ||
            HITCH_TEXT.split('\n').length !== 3 ||
            !HITCH_TEXT.includes('#21 16.7ms render=2 jump=1 draws=28') ||
            HITCH_TEXT.includes('jump=0')
        ) {
            throw new Error('FrameMetrics lost the retained hitch, its preceding counters or the short text');
        }
        return {
            retainedFrames: REPORT.retainedFrames,
            frameWindowMs: REPORT.windowMs,
            actualRedPixel: [...PIXEL],
            fills: REPORT.counts.fills.total,
            draws: REPORT.counts.draws.total,
            hitchText: HITCH_TEXT,
        };
    });
}

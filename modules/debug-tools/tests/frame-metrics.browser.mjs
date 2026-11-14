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
        // 표시 추적: 기준에 못 미치는 한 프레임 빠짐도 점프 앞 2·뒤 10프레임과 함께 남고, 진행 중 kick은 새 추적이 아니며,
        // 탭 숨김(skipInterval)이 낀 추적은 버리지 않고 gap으로 표시한다.
        const TRACE_METRICS = new FRAME_METRICS({
                capacity: 4,
                stages: ['render'],
                counters: ['jump', 'kick', 'draws'],
                now: () => clock,
                trace: { counters: ['jump', 'kick'] },
            }),
            TRACE_FRAME = (intervalMs, { jump = 0, kick = 0 } = {}) => {
                time += intervalMs;
                clock = time;
                TRACE_METRICS.beginFrame(time);
                clock += 2;
                TRACE_METRICS.stage('render', 2);
                TRACE_METRICS.count('draws', 28);
                TRACE_METRICS.count('jump', jump);
                TRACE_METRICS.count('kick', kick);
                TRACE_METRICS.endFrame();
            };
        for (let index = 0; index < 20; index++) {
            TRACE_FRAME(16.7);
        }
        TRACE_FRAME(16.7, { jump: 1 });
        TRACE_FRAME(33.4);
        TRACE_FRAME(16.7, { kick: 1 });
        for (let index = 0; index < 12; index++) {
            TRACE_FRAME(16.7);
        }
        TRACE_FRAME(16.7, { jump: 1 });
        TRACE_FRAME(16.7);
        TRACE_METRICS.skipInterval();
        TRACE_FRAME(3000);
        TRACE_FRAME(16.7);
        const TRACES = TRACE_METRICS.traces(),
            TRACE_TEXT = TRACE_METRICS.traceText();
        if (
            TRACES.length !== 2 ||
            TRACE_METRICS.hitchTotal !== 0 ||
            TRACES[0].sequence !== 21 ||
            TRACES[0].marks !== 2 ||
            TRACES[0].open ||
            TRACES[0].frames.map((frame) => frame.offset).join() !== '-2,-1,0,1,2,3,4,5,6,7,8,9,10' ||
            TRACES[0].doubledIntervals !== 1 ||
            Math.round(TRACES[0].maxFactor) !== 2 ||
            !TRACES[1].open ||
            !TRACES[1].gap ||
            TRACES[1].frames.map((frame) => frame.offset).join() !== '-2,-1,0,1,2' ||
            TRACE_TEXT.split('\n').length !== 5 ||
            !TRACE_TEXT.includes('| fixed draws=28') ||
            !TRACE_TEXT.includes('| 0 33.4 cpu=2 render=2 jump=1 |') ||
            !TRACE_TEXT.includes('| +1 gap cpu=2') ||
            TRACE_TEXT.includes('draws=28 |')
        ) {
            throw new Error('FrameMetrics lost the marked frame trace, its following frames or the short text');
        }
        TRACE_METRICS.clear();
        if (TRACE_METRICS.traces().length || TRACE_METRICS.traceTotal) {
            throw new Error('FrameMetrics clear() kept traces');
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

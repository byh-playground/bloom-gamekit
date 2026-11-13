import { FrameMetrics } from '../debug-tools/frame-metrics.js';

const COUNTERS = ['drawCalls', 'triangles', 'programs', 'textures'];

/**
 * three.js `WebGLRenderer`의 프레임당 렌더 제출량(드로우콜·삼각형·셰이더 프로그램·텍스처)과 프레임 간격의 최근 분포(DEV-033).
 * 후처리처럼 한 프레임에 render()를 여러 번 불러도 프레임 합계가 되도록 `renderer.info.autoReset`을 끄고 begin()에서 직접 0으로 돌립니다.
 * 기록은 debug-tools `FrameMetrics`의 고정 크기 링에 숫자 몇 개를 쓰는 것뿐이고, 요약은 snapshot()을 부를 때만 계산합니다.
 */
export class RenderStats {
    /**
     * @param {object} renderer three.js WebGLRenderer
     * @param {{ capacity?: number }} [options] 보관할 최근 프레임 수
     */
    constructor(renderer, { capacity = 240 } = {}) {
        this.info = renderer.info;
        this.info.autoReset = false;
        /** 기록을 담는 debug-tools FrameMetrics. 카운터는 drawCalls·triangles·programs·textures입니다. */
        this.metrics = new FrameMetrics({ capacity, counters: COUNTERS });
    }

    /** 프레임 시작: 제출 카운터를 0으로 되돌리고 시간 재기를 시작합니다. 앞 프레임이 end() 없이 끝났으면 먼저 닫습니다. */
    begin() {
        if (this.metrics.active) {
            this.metrics.endFrame();
        }
        this.info.reset();
        this.metrics.beginFrame(performance.now());
    }

    /** 프레임 끝: begin() 뒤에 부른 모든 render()의 제출 합계를 기록합니다. */
    end() {
        const { metrics: METRICS, info: INFO } = this;
        METRICS.count('drawCalls', INFO.render.calls);
        METRICS.count('triangles', INFO.render.triangles);
        METRICS.count('programs', INFO.programs?.length ?? 0);
        METRICS.count('textures', INFO.memory.textures);
        METRICS.endFrame();
    }

    /** 최근 프레임 요약: intervalMs(프레임 간격), cpuMs(begin~end 구간), counts(제출량), 가장 느린 프레임 3개(50ms 이상). */
    snapshot() {
        return this.metrics.snapshot({ slowFrameMs: 50, slowLimit: 3 });
    }

    /** 진단 복사에 넣는 한 줄. */
    line() {
        const SNAPSHOT = this.snapshot();
        if (!SNAPSHOT.retainedFrames) {
            return 'render: no frames';
        }
        const ROUND = (value) => Math.round(value * 10) / 10;
        const { intervalMs: INTERVAL } = SNAPSHOT;
        const { drawCalls: DRAWS, triangles: TRIANGLES, programs: PROGRAMS, textures: TEXTURES } = SNAPSHOT.counts;
        return `render frames=${SNAPSHOT.retainedFrames} fps=${ROUND(SNAPSHOT.fps ?? 0)} intervalMs p50=${ROUND(INTERVAL.p50)} p95=${ROUND(INTERVAL.p95)} max=${ROUND(INTERVAL.max)} drawCalls mean=${Math.round(DRAWS.mean)} max=${DRAWS.max} triangles max=${TRIANGLES.max} programs=${PROGRAMS.max} textures=${TEXTURES.max}`;
    }
}

/**
 * 플레이 중 처음 보이는 순간에 셰이더 프로그램이 컴파일되지 않도록 로딩 때 한 번 미리 컴파일합니다(DEV-032).
 * 숨긴 객체(visible=false)를 모두 잠깐 보이게 한 뒤 `renderer.compile(scene, camera)`를 부르고, 끝나면(오류가 나도) 숨김을 되돌립니다.
 * 숨긴 조명도 켜져 조명 수가 플레이 때와 같은 변종으로 컴파일됩니다. 숨긴 것은 플레이 중 보일 것이라고 가정합니다.
 * 그림자 깊이 재질의 컴파일과 텍스처 업로드는 `renderer.compile`이 하지 않습니다(README "warmUp이 하지 않는 것").
 * @param {object} renderer three.js WebGLRenderer
 * @param {object} scene three.js Scene
 * @param {object} camera 플레이에 쓰는 카메라
 */
export function warmUp(renderer, scene, camera) {
    const HIDDEN = [];
    scene.traverse((object) => {
        if (!object.visible) {
            HIDDEN.push(object);
            object.visible = true;
        }
    });
    try {
        camera.updateMatrixWorld();
        renderer.compile(scene, camera);
    } finally {
        for (const OBJECT of HIDDEN) {
            OBJECT.visible = false;
        }
    }
}

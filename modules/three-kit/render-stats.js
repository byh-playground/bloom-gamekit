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
 * 플레이 중 처음 보이는 순간에 일어날 GPU 일(셰이더 프로그램 컴파일·링크, geometry·인스턴스 버퍼·뼈 텍스처·재질 텍스처 업로드)을
 * 로딩 때 미리 끝냅니다(DEV-032). 숨긴 객체(visible=false)를 모두 켜고 화면의 1픽셀만 열어 한 번 실제로 그린 뒤, 그 1픽셀을 지우고
 * 상태를 되돌립니다. 숨긴 객체가 보이는 프레임은 남지 않습니다. 끝나면(오류가 나도) 숨김·`frustumCulled`·렌더러 상태를 되돌립니다.
 *
 * - `renderer.compile`은 프로그램만 만듭니다. 버퍼·텍스처는 실제로 그릴 때 올라가므로 컴파일 뒤에 한 번 그립니다(README "warmUp").
 * - 렌더 타깃을 `null`(화면)로 두고 그립니다. 타깃에 그리면 출력 색 공간·톤 매핑이 달라 프로그램 변종이 달라집니다.
 * - 그리기 수·삼각형 수(`renderer.info.render`)는 이 호출 전 값으로 되돌려 `RenderStats` 프레임 합계에 섞이지 않습니다.
 * - 숨긴 것은 플레이 중 보일 것이라고 가정합니다. 숨긴 조명도 켜져 조명 수가 플레이 때와 같은 변종으로 컴파일됩니다.
 *   화면 밖 객체도 올립니다(`frustumCulled`를 잠깐 끕니다). 인스턴스 수 0인 `InstanceLayer`도 버퍼 전체가 이때 올라갑니다.
 * - 화면 왼쪽 아래 1픽셀은 지운 색이 됩니다. 로딩 중 이미 그려 둔 화면이 있어도 다음 프레임이 덮어씁니다.
 * @param {object} renderer three.js WebGLRenderer
 * @param {object} scene three.js Scene
 * @param {object} camera 플레이에 쓰는 카메라
 */
export function warmUp(renderer, scene, camera) {
    const UNDO = [];
    scene.traverse((object) => {
        if (!object.visible) {
            object.visible = true;
            UNDO.push(() => (object.visible = false));
        }
        if (object.frustumCulled) {
            object.frustumCulled = false;
            UNDO.push(() => (object.frustumCulled = true));
        }
    });
    const RENDER = renderer.info.render;
    const COUNTS = { calls: RENDER.calls, triangles: RENDER.triangles, points: RENDER.points, lines: RENDER.lines };
    const TARGET = renderer.getRenderTarget();
    const FACE = renderer.getActiveCubeFace();
    const LEVEL = renderer.getActiveMipmapLevel();
    // three의 Vector4를 받지 않으려고 copy()만 있는 상자를 넘깁니다(getScissor는 target.copy(scissor)만 부릅니다).
    const SCISSOR = renderer.getScissor({
        x: 0,
        y: 0,
        z: 0,
        w: 0,
        copy(box) {
            [this.x, this.y, this.z, this.w] = [box.x, box.y, box.z, box.w];
            return this;
        },
    });
    const SCISSOR_TEST = renderer.getScissorTest();
    const SHADOW_NEEDS_UPDATE = renderer.shadowMap.needsUpdate;
    try {
        camera.updateMatrixWorld();
        renderer.setRenderTarget(null);
        renderer.setScissor(0, 0, 1, 1);
        renderer.setScissorTest(true);
        renderer.compile(scene, camera);
        renderer.render(scene, camera);
        renderer.clear();
    } finally {
        renderer.setScissor(SCISSOR.x, SCISSOR.y, SCISSOR.z, SCISSOR.w);
        renderer.setScissorTest(SCISSOR_TEST);
        renderer.setRenderTarget(TARGET, FACE, LEVEL);
        renderer.shadowMap.needsUpdate = SHADOW_NEEDS_UPDATE;
        Object.assign(RENDER, COUNTS);
        for (const RESTORE of UNDO) {
            RESTORE();
        }
    }
}

// 주사 간격 추정에 쓰는 최근 RAF 간격 개수. 중앙값이라 탭 복귀·한두 프레임 지연은 추정을 움직이지 않습니다.
const REFRESH_SAMPLES = 15;
// 주사율 표기 오차(59.94 Hz 등) 여유: 비율이 정수보다 이만큼 모자라도 그 정수로 봅니다.
const STRIDE_TOLERANCE = 0.05;
// 정해진 k를 바꾸려면 비율이 경계를 이만큼 더 넘어야 합니다(약 117 Hz처럼 경계에 걸린 화면에서 k가 오가지 않게).
const STRIDE_MARGIN = 0.05;
// 판정 여유: 정수 주사 경계의 반 주기 앞, 목표 간격의 0.95배.
const STRIDE_LEAD = 0.5;
const TARGET_LEAD = 0.95;

/**
 * 화면 프레임 제한 판정. requestAnimationFrame을 소유하지 않고, 프레임 시각(RAF timestamp)을 받아 그릴지만 답합니다.
 * 그리는 빈도는 화면 주사 k번마다 한 번이고, k는 빈도가 minHz 이상으로 남는 가장 큰 정수입니다
 * (60 Hz → 60, 90 → 90, 120 → 60, 144 → 72, 165 → 82.5 fps). 주사 간격의 정수 배로만 그려야 프레임 간격이 고릅니다.
 * 판정 규칙은 하나입니다: 직전에 그린 프레임에서 min((k − 0.5) × 주사 간격, 0.95 × 1000/minHz)만큼 지났으면 그립니다.
 * 표본이 차기 전에는 주사 간격 0·k 1이라 프레임마다 그립니다. 뒤쪽 항은 추정이 틀려도 목표 간격이 지난 프레임을 버리지 않게 합니다.
 * 판정에는 콜백이 실제로 도는 시각(performance.now())이 아니라 RAF timestamp를 넘깁니다. 콜백 시각은 앞선 주 스레드 작업만큼
 * 늦어져, 늦게 돈 프레임의 다음 프레임이 간격 미달로 버려집니다.
 */
export class FramePacer {
    #targetMs;
    #gaps = new Float64Array(REFRESH_SAMPLES);
    #sorted = new Float64Array(REFRESH_SAMPLES);
    #gapCount = 0;
    #seenAt = null;
    #drawnAt = -Infinity;
    #refreshMs = 0;
    #stride = 1;

    /** @param {{minHz:number}} options 이 빈도 이상으로 그립니다(화면 주사율이 더 낮으면 주사율대로). */
    constructor({ minHz } = {}) {
        if (!Number.isFinite(minHz) || minHz <= 0) {
            throw new RangeError('minHz must be a positive frequency');
        }
        this.#targetMs = 1000 / minHz;
    }
    /** 추정한 화면 주사 간격(ms). 표본이 차기 전에는 0입니다. */
    get refreshMs() {
        return this.#refreshMs;
    }
    /** 화면 주사 몇 번마다 그리는지(k). */
    get stride() {
        return this.#stride;
    }
    /**
     * 화면 프레임 하나를 받습니다. true면 이 프레임을 그리고(그린 것으로 기록), false면 건너뜁니다.
     * RAF 콜백마다 한 번, 그 콜백의 timestamp로 부릅니다.
     */
    accept(timestampMs) {
        if (!Number.isFinite(timestampMs)) {
            throw new TypeError('frame timestamp');
        }
        this.#observe(timestampMs);
        const DUE_MS = Math.min((this.#stride - STRIDE_LEAD) * this.#refreshMs, TARGET_LEAD * this.#targetMs);
        if (timestampMs - this.#drawnAt < DUE_MS) {
            return false;
        }
        this.#drawnAt = timestampMs;
        return true;
    }
    /** RAF를 멈췄다 다시 시작할 때: 멈춘 동안의 간격을 표본에 넣지 않습니다. 추정과 k는 유지합니다. */
    rebase() {
        this.#seenAt = null;
    }
    // RAF 간격 하나를 표본에 넣고, 표본이 다 차 있으면 중앙값을 주사 간격으로 삼아 k를 맞춥니다.
    #observe(timestampMs) {
        const GAP = this.#seenAt === null ? 0 : timestampMs - this.#seenAt;
        this.#seenAt = timestampMs;
        if (GAP <= 0) {
            return;
        }
        this.#gaps[this.#gapCount % REFRESH_SAMPLES] = GAP;
        this.#gapCount++;
        if (this.#gapCount < REFRESH_SAMPLES) {
            return;
        }
        this.#sorted.set(this.#gaps);
        this.#sorted.sort();
        const DECIDED = this.#refreshMs > 0;
        this.#refreshMs = this.#sorted[REFRESH_SAMPLES >> 1];
        const RATIO = this.#targetMs / this.#refreshMs + STRIDE_TOLERANCE,
            MARGIN = DECIDED ? STRIDE_MARGIN : 0,
            UP = Math.floor(RATIO - MARGIN),
            DOWN = Math.floor(RATIO + MARGIN);
        if (UP > this.#stride) {
            this.#stride = UP;
        } else if (DOWN < this.#stride) {
            this.#stride = Math.max(1, DOWN);
        }
    }
}

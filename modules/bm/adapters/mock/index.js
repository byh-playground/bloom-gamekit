/**
 * 테스트·예제용 광고 어댑터입니다. SDK를 부르지 않고 미리 정한 결과를 돌려줍니다.
 * @param {object} [options]
 * @param {string[]} [options.outcomes=[]] show마다 순서대로 돌려줄 결과. 소진하면 보상형은 'rewarded', 전면은 'viewed'
 * @param {boolean} [options.loadable=true] load()의 결과
 * @param {number} [options.latencyMs=0] show가 끝나기까지의 시간
 */
export function createMockAdapter({ outcomes = [], loadable = true, latencyMs = 0 } = {}) {
    const CALLS = [];
    let next = 0;
    return {
        id: 'mock',
        /** 호출 기록입니다. 검증용으로 읽기만 하세요. */
        calls: CALLS,
        load(placement, type) {
            CALLS.push({ op: 'load', placement, type });
            return Promise.resolve(loadable);
        },
        show(placement, type) {
            CALLS.push({ op: 'show', placement, type });
            const OUTCOME = outcomes[next++] ?? (type === 'rewarded' ? 'rewarded' : 'viewed');
            return new Promise((resolve) => setTimeout(() => resolve(OUTCOME), latencyMs));
        },
    };
}

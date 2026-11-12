/**
 * 공개 수집의 회선별 요청 빈도를 제한합니다. 세션 ID는 요청자가 새로 만들 수 있으므로 키로 쓰지 않습니다.
 * Cloudflare가 넣는 회선 IP가 없거나 바인딩이 빠지면 제한을 우회할 수 없도록 수집을 거부합니다.
 * 판정은 Cloudflare 위치별 근사치이며 같은 NAT의 여러 사용자가 한 한도를 공유합니다.
 */
export async function checkBatchRate(request, env) {
    if (!env.BATCH_RATE_LIMITER) {
        return 'unavailable';
    }
    const IP = request.headers.get('CF-Connecting-IP');
    if (!IP) {
        return 'missing-ip';
    }
    const { success: SUCCESS } = await env.BATCH_RATE_LIMITER.limit({ key: IP });
    return SUCCESS ? null : 'limited';
}

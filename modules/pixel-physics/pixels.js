// 격자를 RGBA 바이트로 쓰는 DOM·Canvas 비의존 경계입니다. PixelRenderer(Canvas2D)와
// rendering 모듈의 WebGL 텍스처 업로드가 같은 픽셀 계산을 씁니다.
/** 빈 셀 배경색(리틀엔디언 Uint32 0xAABBGGRR). */
const GRID_BACKGROUND = (255 << 24) | (26 << 16) | (22 << 8) | 20;

/** 셀 위치별 고정 음영 인덱스(0..7). 월드 크기당 한 번 만들어 재사용합니다. */
function createGridShade(cellCount) {
    const OUT = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
        OUT[i] = ((i * 2654435761) >>> 0) % 8;
    }
    return OUT;
}

/**
 * 월드 셀을 pixels(Uint32Array, 한 칸이 RGBA 한 픽셀)에 씁니다. 엔티티·강체는 그리지 않습니다.
 * 바이트로 보려면 `new Uint8ClampedArray(pixels.buffer)`를 rendering의 `createTexture/updateTexture`에 넘기세요.
 *
 * view를 주지 않으면 전체 격자(pixels.length === w*h)를 씁니다. view = {x, y, w, h}(창 좌표, 정수)를 주면 그 사각형만
 * view.w*view.h 크기의 pixels에 행 우선으로 씁니다. view가 격자 밖에 걸치면 밖의 칸은 background로 쓰며 오류가 아닙니다
 * (월드 가장자리에서 카메라가 넘어가는 경우). view가 완전히 밖이어도 전부 background입니다. w,h가 음수거나 정수가 아니면 RangeError입니다.
 *
 * shade는 원래 길이(w*h)의 셀별 음영표입니다. 색은 절대 좌표(origin + 창 좌표)를 격자 크기로 감아 이 표를 찾으므로,
 * shiftWindow로 창이 움직여도 같은 지형 셀은 같은 음영을 유지합니다(origin이 0이면 이전과 같은 결과).
 */
function writeGridPixels(world, pixels, shade, background = GRID_BACKGROUND, view = null) {
    const { w: W, h: H } = world;
    if (shade.length !== W * H) {
        throw new RangeError('shade의 길이는 w*h여야 합니다.');
    }
    const VX = view ? view.x : 0,
        VY = view ? view.y : 0,
        VW = view ? view.w : W,
        VH = view ? view.h : H;
    if (![VX, VY, VW, VH].every(Number.isInteger) || VW < 0 || VH < 0) {
        throw new RangeError('view는 정수 {x, y, w, h}이고 w, h는 0 이상이어야 합니다.');
    }
    if (pixels.length !== VW * VH) {
        throw new RangeError(
            view ? 'pixels의 길이는 view.w*view.h여야 합니다.' : 'pixels와 shade의 길이는 w*h여야 합니다.',
        );
    }
    if (world.dirty) {
        world._compile();
    }
    const { g: G, life: LIFE, PAL, FL } = world;
    const X0 = Math.max(0, VX),
        X1 = Math.min(W, VX + VW);
    for (let r = 0; r < VH; r++) {
        const Y = VY + r,
            OUT = r * VW;
        if (Y < 0 || Y >= H || X0 >= X1) {
            pixels.fill(background, OUT, OUT + VW);
            continue;
        }
        pixels.fill(background, OUT, OUT + (X0 - VX));
        pixels.fill(background, OUT + (X1 - VX), OUT + VW);
        const SY = (((world.originY + Y) % H) + H) % H;
        let sx = (((world.originX + X0) % W) + W) % W;
        for (let x = X0, i = Y * W + X0, o = OUT + (X0 - VX); x < X1; x++, i++, o++) {
            const T = G[i],
                S = SY * W + sx;
            pixels[o] = T ? PAL[T * 8 + (FL[T] ? (LIFE[i] + S) & 7 : shade[S])] : background;
            if (++sx === W) {
                sx = 0;
            }
        }
    }
}

export { GRID_BACKGROUND, createGridShade, writeGridPixels };

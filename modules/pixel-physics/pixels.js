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
 * 월드 셀을 pixels(Uint32Array, 길이 w*h, 한 칸이 RGBA 한 픽셀)에 씁니다. 엔티티·강체는 그리지 않습니다.
 * 바이트로 보려면 `new Uint8ClampedArray(pixels.buffer)`를 rendering의 `createTexture/updateTexture`에 넘기세요.
 */
function writeGridPixels(world, pixels, shade, background = GRID_BACKGROUND) {
    if (pixels.length !== world.g.length || shade.length !== world.g.length) {
        throw new RangeError('pixels와 shade의 길이는 w*h여야 합니다.');
    }
    if (world.dirty) {
        world._compile();
    }
    const { g: G, life: LIFE, PAL, FL } = world;
    for (let i = 0; i < G.length; i++) {
        const T = G[i];
        pixels[i] = T ? PAL[T * 8 + (FL[T] ? (LIFE[i] + i) & 7 : shade[i])] : background;
    }
}

export { GRID_BACKGROUND, createGridShade, writeGridPixels };

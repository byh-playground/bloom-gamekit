import { GRID_BACKGROUND, createGridShade, writeGridPixels } from './pixels.js';

class PixelRenderer {
    constructor(canvas, world, { overlay = null } = {}) {
        this.ov = overlay;
        this.ctx = canvas.getContext('2d');
        this.world = world;
        canvas.width = world.w;
        canvas.height = world.h;
        this.img = this.ctx.createImageData(world.w, world.h);
        this.px = new Uint32Array(this.img.data.buffer);
        this.sh = createGridShade(world.w * world.h);
        this.bg = GRID_BACKGROUND;
    }
    draw(drawBody, extra) {
        const W = this.world;
        writeGridPixels(W, this.px, this.sh, this.bg);
        this.ctx.putImageData(this.img, 0, 0);
        const F = drawBody || this.drawBody;
        if (this.ov) {
            // 고해상도 오버레이: 격자와 별개로 개체를 화면 해상도로 그림
            const O = this.ov,
                R = O.getBoundingClientRect(),
                D = window.devicePixelRatio || 1,
                PW = Math.round(R.width * D),
                PH = Math.round(R.height * D);
            if (O.width !== PW || O.height !== PH) {
                O.width = PW;
                O.height = PH;
            }
            const C = O.getContext('2d');
            C.clearRect(0, 0, PW, PH);
            const S = PW / W.w;
            for (const B of W.bodies) {
                F(C, B, S);
            }
            if (extra) {
                extra(C, S);
            }
        } else {
            for (const B of W.bodies) {
                F(this.ctx, B, 1);
            }
            if (extra) {
                extra(this.ctx, 1);
            }
        }
    }
    drawBody(ctx, b, s = 1) {
        // 기본 렌더러: 박스/원을 단색으로
        ctx.fillStyle = b.status.burn ? '#ffc23a' : b.color;
        if (b.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(b.x * s, b.y * s, b.r * s, 0, 7);
            ctx.fill();
        } else {
            ctx.fillRect((b.x - b.hx) * s, (b.y - b.hy) * s, b.w * s, b.h * s);
        }
        if (b.showHp) {
            const X = (b.x - b.hx - 1) * s,
                Y = (b.y - b.hy - 3) * s,
                W_VALUE = (b.hx * 2 + 2) * s;
            ctx.fillStyle = '#c33';
            ctx.fillRect(X, Y, W_VALUE, s);
            ctx.fillStyle = '#4c4';
            ctx.fillRect(X, Y, (W_VALUE * Math.max(0, b.hp)) / b.maxHp, s);
        }
    }
}

export { PixelRenderer };

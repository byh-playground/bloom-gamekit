import { GRID_BACKGROUND, createGridShade, writeGridPixels } from './pixels.js';

class PixelRenderer {
    /** view = {x, y, w, h}(창 좌표)를 주면 그 사각형만 그립니다. 생략하면 전체 격자입니다. */
    constructor(canvas, world, { overlay = null, view = null } = {}) {
        this.ov = overlay;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.world = world;
        this.sh = createGridShade(world.w * world.h);
        this.bg = GRID_BACKGROUND;
        this.setView(view);
    }
    /**
     * 그릴 사각형을 바꿉니다(null이면 전체). 크기가 바뀔 때만 캔버스와 버퍼를 다시 만들고, 같은 크기로 위치만 옮기면 비용이 없습니다.
     * 격자 밖에 걸친 부분은 배경색입니다. 개체와 extra 훅은 창 좌표 그대로 그리면 view에 맞춰 이동됩니다.
     */
    setView(view) {
        const V = view ?? { x: 0, y: 0, w: this.world.w, h: this.world.h };
        if (![V.x, V.y, V.w, V.h].every(Number.isInteger) || V.w <= 0 || V.h <= 0) {
            throw new RangeError('view는 정수 {x, y, w, h}이고 w, h는 1 이상이어야 합니다.');
        }
        if (!this.view || this.view.w !== V.w || this.view.h !== V.h) {
            this.canvas.width = V.w;
            this.canvas.height = V.h;
            this.img = this.ctx.createImageData(V.w, V.h);
            this.px = new Uint32Array(this.img.data.buffer);
        }
        this.view = { x: V.x, y: V.y, w: V.w, h: V.h };
    }
    draw(drawBody, extra) {
        const W = this.world,
            V = this.view;
        writeGridPixels(W, this.px, this.sh, this.bg, V);
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
            const S = PW / V.w;
            C.save();
            C.translate(-V.x * S, -V.y * S);
            for (const B of W.bodies) {
                F(C, B, S);
            }
            if (extra) {
                extra(C, S);
            }
            C.restore();
        } else {
            this.ctx.save();
            this.ctx.translate(-V.x, -V.y);
            for (const B of W.bodies) {
                F(this.ctx, B, 1);
            }
            if (extra) {
                extra(this.ctx, 1);
            }
            this.ctx.restore();
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

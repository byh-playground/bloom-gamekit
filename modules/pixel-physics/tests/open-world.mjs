// 열린 월드(창 이동) 검증입니다(Node, 브라우저 아님): shiftWindow가 셀·청크·발사체·엔티티·강체·충돌체를 함께 옮기고,
// 맵 데이터 로드/반납이 절대 좌표와 일치하며, 롤백·바이트 snapshot이 창 이동을 가로질러도 같은 결과인지 봅니다.
import assert from 'node:assert/strict';
import {
    Body,
    MatterBridge,
    PixelWorld,
    hashCell,
    installDeterministicTrig,
    loadPixelWorld,
    savePixelWorld,
    validatePixelWorld,
    writeGridPixels,
    createGridShade,
} from '../index.js';

installDeterministicTrig();
const W = 64,
    H = 48,
    SEED = 11;

// 큰 맵을 흉내 낸 절대 좌표 함수: 바닥(ay >= 200)은 돌, 그 위에는 해시로 흩뿌린 모래·돌, 나머지는 빈 공간입니다.
function mapCell(ax, ay) {
    if (ay >= 200) {
        return 1;
    }
    const R = hashCell(SEED, ax, ay) % 100;
    return R < 3 ? 1 : R < 6 ? 2 : 0;
}

function createWorld(options = {}) {
    const WORLD = new PixelWorld(W, H, { seed: SEED, ...options });
    WORLD.define({ name: 'stone', kind: 'solid', color: [110, 112, 122], strength: 50 });
    WORLD.define({ name: 'sand', kind: 'powder', density: 15, color: [222, 190, 110] });
    return WORLD;
}

// 맵 데이터 저장소: 절대 좌표 키로 편집된 셀만 덮어씁니다(evict가 되쓰고 load가 읽음).
function createStore() {
    const EDITS = new Map();
    const BASE = (ax, ay) => EDITS.get(ax + ',' + ay) ?? mapCell(ax, ay);
    return {
        EDITS,
        load(rect) {
            const WIDTH = rect.x1 - rect.x0,
                CELLS = new Uint8Array(WIDTH * (rect.y1 - rect.y0));
            for (let y = rect.y0; y < rect.y1; y++) {
                for (let x = rect.x0; x < rect.x1; x++) {
                    CELLS[(y - rect.y0) * WIDTH + x - rect.x0] = BASE(rect.originX + x, rect.originY + y);
                }
            }
            rect.world.writeRegion(rect.x0, rect.y0, WIDTH, rect.y1 - rect.y0, CELLS);
        },
        evict(rect) {
            const WIDTH = rect.x1 - rect.x0,
                { g: G } = rect.world.readRegion(rect.x0, rect.y0, WIDTH, rect.y1 - rect.y0);
            for (let y = rect.y0; y < rect.y1; y++) {
                for (let x = rect.x0; x < rect.x1; x++) {
                    const AX = rect.originX + x,
                        AY = rect.originY + y;
                    if (G[(y - rect.y0) * WIDTH + x - rect.x0] !== mapCell(AX, AY)) {
                        EDITS.set(AX + ',' + AY, G[(y - rect.y0) * WIDTH + x - rect.x0]);
                    } else {
                        EDITS.delete(AX + ',' + AY);
                    }
                }
            }
        },
        fillAll(world) {
            this.load({ world, x0: 0, y0: 0, x1: W, y1: H, originX: world.originX, originY: world.originY });
        },
    };
}

function assertMatchesMap(world, store) {
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const AX = world.originX + x,
                AY = world.originY + y,
                EXPECT = store.EDITS.get(AX + ',' + AY) ?? mapCell(AX, AY);
            assert.equal(world.get(x, y), EXPECT, `절대 (${AX},${AY}) 창 (${x},${y})`);
        }
    }
}

// 1) 두 축·대각선·창보다 큰 이동까지, 창 안 내용이 항상 맵의 절대 좌표와 같다.
{
    const WORLD = createWorld({ originX: 1000, originY: 5000 }),
        STORE = createStore();
    STORE.fillAll(WORLD);
    assertMatchesMap(WORLD, STORE);
    for (const [DX, DY] of [
        [0, -16],
        [0, 32],
        [16, 0],
        [-48, 0],
        [16, -16],
        [-32, 48],
        [0, 160],
        [-128, 0],
        [64, 64],
    ]) {
        const BEFORE_X = WORLD.originX;
        WORLD.shiftWindow(DX, DY, STORE);
        assert.equal(WORLD.originX, BEFORE_X + DX);
        assertMatchesMap(WORLD, STORE);
    }
}

// 2) 지형을 바꾸고 멀리 갔다 돌아오면 evict가 맵 데이터에 되써 둔 편집이 남는다.
{
    const WORLD = createWorld({ originX: 0, originY: 180 }),
        STORE = createStore();
    STORE.fillAll(WORLD);
    WORLD.rect(10, 30, 14, 34, 'sand'); // 절대 y 210..214: 바닥(돌) 안을 모래로 바꿈
    WORLD.shiftWindow(0, -48, STORE); // 위로 3청크 밀기: 편집 영역은 아래로 밀려나 창 밖
    assert(STORE.EDITS.size > 0, 'evict가 편집을 되썼다');
    WORLD.shiftWindow(0, 48, STORE);
    assert.equal(WORLD.get(12, 32), 2);
    assertMatchesMap(WORLD, STORE);
}

// 5) 강체·엔티티·발사체·조인트·핀·정적 충돌체의 좌표가 함께 움직이고, 창 밖으로 나간 것은 돌려준다.
{
    const WORLD = createWorld({ originX: 0, originY: 0 }),
        BRIDGE = new MatterBridge({ checkpoint: 1 });
    WORLD.attachBridge(BRIDGE);
    WORLD.rect(0, 40, W - 1, H - 1, 'stone');
    const BOX = BRIDGE.addBox({ x: 20, y: 10, w: 4, h: 4, density: 1, vx: 0.3, vy: 0 }),
        ROPE = BRIDGE.addBox({ x: 40, y: 20, w: 4, h: 4, density: 1 }),
        JOINT = BRIDGE.addJoint({ a: ROPE, ax: 0, ay: -2, bx: 40, by: 5, len: 8, stiff: 0.6 }),
        PINNED = BRIDGE.addBox({ x: 50, y: 20, w: 3, h: 3, density: 1 });
    BRIDGE.addPin(PINNED, 50, 8, 0, -1.5, 6, 0.5);
    const HERO = WORLD.addEntity(new Body({ x: 10, y: 30, w: 3, h: 6 })),
        GONE = WORLD.addEntity(new Body({ x: 30, y: 3, w: 3, h: 6 }));
    WORLD.spray(5, 5, 1, 0, 'sand');
    WORLD.spray(5, 45, 0, 1, 'sand');
    WORLD.spray(40, 10, 0.3, 0.1, 'sand'); // 창 안에 남는 발사체
    for (let i = 0; i < 3; i++) {
        WORLD.tick();
    }
    const SNAP = {
        box: [BOX.x, BOX.y, BOX.vx, BOX.vy],
        jointBy: JOINT.by,
        pinAy: PINNED.pins[0].ay,
        hero: [HERO.x, HERO.y],
        statics: BRIDGE.statics.size,
        projectiles: WORLD.proj.length,
    };
    assert(SNAP.projectiles >= 1);
    const REFS = WORLD.proj.slice(),
        COPY = REFS.map((jet) => ({ x: jet.x, y: jet.y, ex: jet.ex, ey: jet.ey }));
    const RESULT = WORLD.shiftWindow(16, -16, { load: () => {} });
    let kept = 0;
    REFS.forEach((jet, i) => {
        if (WORLD.proj.includes(jet)) {
            kept++;
            assert.deepEqual(
                [jet.x, jet.y, jet.ex, jet.ey],
                [COPY[i].x - 16, COPY[i].y + 16, COPY[i].ex - 16, COPY[i].ey + 16],
            );
        }
    });
    assert(kept >= 1, '창 안에 남는 발사체가 있다');
    assert.equal(RESULT.projectiles, REFS.length - kept);
    assert.equal(WORLD.supDirty, true, '지지 상태는 다시 계산하도록 표시');
    assert.equal(BOX.x, SNAP.box[0] - 16);
    assert.equal(BOX.y, SNAP.box[1] + 16);
    assert.equal(BOX.vx, SNAP.box[2]);
    assert.equal(BOX.vy, SNAP.box[3]);
    assert.equal(BOX.body.position.x, BOX.x);
    assert.equal(JOINT.by, SNAP.jointBy + 16);
    assert.equal(JOINT.c.pointB.y, JOINT.by);
    assert.equal(PINNED.pins[0].ay, SNAP.pinAy + 16);
    assert.equal(PINNED._cons[0].pointA.y, PINNED.pins[0].ay);
    assert.equal(HERO.x, SNAP.hero[0] - 16);
    assert.equal(HERO.y, SNAP.hero[1] + 16);
    assert(RESULT.bodies.every((h) => h.x < 0 || h.x >= W || h.y < 0 || h.y >= H));
    assert(RESULT.entities.includes(GONE) === (GONE.y < 0 || GONE.y >= H || GONE.x < 0 || GONE.x >= W));
    assert(RESULT.projectiles >= 0);
    assert(BRIDGE.statics.size <= SNAP.statics);
}

// 6) 이동한 월드의 정적 충돌체는 같은 셀로 처음부터 만든 월드와 같다(청크 id·꼭짓점).
{
    const SHIFTED = createWorld({ originX: 0, originY: 0 }),
        STORE = createStore();
    SHIFTED.attachBridge(new MatterBridge({ checkpoint: 1 }));
    STORE.fillAll(SHIFTED);
    for (let i = 0; i < 2; i++) {
        SHIFTED.tick();
    }
    SHIFTED.shiftWindow(32, 16, STORE);
    SHIFTED.tick();
    const FRESH = createWorld({ originX: SHIFTED.originX, originY: SHIFTED.originY });
    FRESH.attachBridge(new MatterBridge({ checkpoint: 1 }));
    FRESH.writeRegion(0, 0, W, H, SHIFTED.readRegion(0, 0, W, H).g);
    FRESH.tick();
    const SIGN = (bridge) =>
        [...bridge.statics]
            .map(([id, bodies]) => [
                id,
                bodies
                    .map((b) =>
                        b.vertices
                            .map((v) => v.x.toFixed(6) + ',' + v.y.toFixed(6))
                            .sort()
                            .join(' '),
                    )
                    .sort(),
            ])
            .sort((a, b) => a[0] - b[0]);
    assert(SHIFTED.bridge.statics.size > 0);
    assert.deepEqual(SIGN(SHIFTED.bridge), SIGN(FRESH.bridge));
}

// 7) 떨어지는 상자의 절대 궤적은 큰 월드에서 한 번에 돌린 것과 같다(허용 오차 1e-6). 창은 중간에 두 번 움직인다.
{
    const BIG = new PixelWorld(W, H * 4, { seed: SEED }),
        WIN = createWorld({ originX: 0, originY: 0 });
    BIG.define({ name: 'stone', kind: 'solid', color: [0, 0, 0] });
    for (const WORLD of [BIG, WIN]) {
        WORLD.attachBridge(new MatterBridge({ checkpoint: 1 }));
    }
    const A = BIG.bridge.addBox({ x: 30, y: 20, w: 5, h: 5, density: 1, vx: 0.2, av: 0.01 }),
        B = WIN.bridge.addBox({ x: 30, y: 20, w: 5, h: 5, density: 1, vx: 0.2, av: 0.01 });
    for (let t = 0; t < 120; t++) {
        BIG.tick();
        WIN.tick();
        if (t === 39 || t === 79) {
            WIN.shiftWindow(0, 16, { load: () => {} });
        }
    }
    assert.equal(WIN.originY, 32);
    assert(Math.abs(A.y - (B.y + WIN.originY)) < 1e-6, `${A.y} vs ${B.y + WIN.originY}`);
    assert(Math.abs(A.x - B.x) < 1e-6);
    assert(Math.abs(A.angle - B.angle) < 1e-9);
}

// 8) 창 이동이 들어간 실행의 결정성·롤백: 같은 입력은 같은 해시, 창 이동 전 snapshot으로 되감아도 같은 해시.
function scene() {
    const WORLD = createWorld({ originX: 300, originY: 100 }),
        STORE = createStore();
    WORLD.attachBridge(new MatterBridge({ checkpoint: 1 }));
    STORE.fillAll(WORLD);
    WORLD.rect(0, 40, W - 1, H - 1, 'stone');
    WORLD.bridge.addBox({ x: 20, y: 10, w: 5, h: 5, density: 1, vx: 0.4 });
    WORLD.enableCollapse({ anchorTop: true });
    WORLD.addEntity(new Body({ x: 10, y: 30, w: 3, h: 6 }));
    return { world: WORLD, store: STORE };
}
function run(sceneObject, from, to, onTick) {
    for (let t = from; t < to; t++) {
        onTick?.(t);
        if (t === 30) {
            sceneObject.world.shiftWindow(16, -16, sceneObject.store);
        }
        if (t === 60) {
            sceneObject.world.shiftWindow(-32, 0, sceneObject.store);
        }
        sceneObject.world.spray(30, 10, 0.5, 0.2, 'sand');
        sceneObject.world.tick();
    }
}
{
    const A = scene(),
        B = scene();
    run(A, 0, 100);
    run(B, 0, 100);
    assert.equal(A.world.hash(), B.world.hash());

    // 창 이동(t=30) 이전의 시점으로 되감기: 25틱의 바이트 snapshot에서 다시 돌린 결과가 같아야 한다.
    const C = scene();
    let bytes;
    run(C, 0, 100, (t) => {
        if (t === 25) {
            bytes = savePixelWorld(C.world);
        }
    });
    const FINAL = C.world.hash();
    assert(validatePixelWorld(C.world, bytes));
    const D = scene();
    run(D, 0, 25);
    loadPixelWorld(D.world, bytes, { createBody: () => new Body({}) });
    assert.equal(D.world.originX, 300);
    assert.equal(D.world.originY, 100);
    run(D, 25, 100);
    assert.equal(D.world.hash(), FINAL);

    // 창 이동 뒤의 snapshot도 origin을 보존한다.
    const E = scene();
    run(E, 0, 70);
    const BYTES = savePixelWorld(E.world),
        F = scene();
    loadPixelWorld(F.world, BYTES, { createBody: () => new Body({}) });
    assert.equal(F.world.originX, E.world.originX);
    assert.equal(F.world.originY, E.world.originY);
    assert.equal(F.world.hash(), E.world.hash());
}

// 8b) origin이 다르면 셀이 같아도 해시가 다르다(절대 위치도 상태).
{
    const A = createWorld({ originX: 0, originY: 0 }),
        B = createWorld({ originX: 0, originY: 16 }),
        C = createWorld({ originX: 16, originY: 0 });
    assert.notEqual(A.hash(), B.hash());
    assert.notEqual(A.hash(), C.hash());
}

// 8c) scrollTo: margin 안쪽에서는 움직이지 않고, 벗어나면 step의 배수만큼 초점이 가운데 근처로 오게 옮긴다.
{
    const WORLD = new PixelWorld(160, 128, { seed: SEED, originX: 0, originY: 0, stream: { margin: 40, step: 32 } }),
        STORE = { load: () => {} };
    assert.deepEqual(WORLD.stream, { margin: 40, step: 32 });
    assert.equal(WORLD.scrollTo(80, 64, STORE), null);
    assert.equal(WORLD.scrollTo(41, 41, STORE), null, '경계 안쪽(margin 위치)은 안 움직임');
    assert.equal(WORLD.scrollTo(119, 87, STORE), null);
    assert.equal(WORLD.scrollTo(120, 64, STORE).originX % 32, 0, '오른쪽 margin을 넘으면 이동');
    assert.equal(WORLD.originX, 32); // (120-80)=40 -> 반올림 32
    assert.equal(WORLD.originY, 0);
    // 이동한 뒤 초점은 다시 여유 구간 안
    const FOCUS = [120, 64];
    assert(FOCUS[0] - WORLD.originX >= 40 && FOCUS[0] - WORLD.originX < 160 - 40);
    // 매우 멀리 가면 한 번에 따라가고, 같은 입력이면 같은 결과
    const A = new PixelWorld(160, 128, { seed: SEED, stream: { margin: 40, step: 32 } }),
        B = new PixelWorld(160, 128, { seed: SEED, stream: { margin: 40, step: 32 } });
    for (const [FX, FY] of [
        [10000, -9000],
        [20, 5],
    ]) {
        A.scrollTo(FX, FY, STORE);
        B.scrollTo(FX, FY, STORE);
        assert.deepEqual([A.originX, A.originY], [B.originX, B.originY]);
        const LOCAL = [FX - A.originX, FY - A.originY];
        assert(LOCAL[0] >= 40 && LOCAL[0] < 120 && LOCAL[1] >= 40 && LOCAL[1] < 88, `초점이 여유 구간 안 ${LOCAL}`);
    }
    // 기본값과 검증
    const DEFAULT = new PixelWorld(128, 96);
    assert.deepEqual(DEFAULT.stream, { margin: 24, step: 32 });
    assert.throws(() => new PixelWorld(128, 96, { stream: { margin: 40, step: 32 } }), RangeError); // 32 > 96-80
    assert.throws(() => new PixelWorld(128, 96, { stream: { step: 20 } }), RangeError);
    assert.throws(() => new PixelWorld(128, 96, { stream: { margin: -1 } }), RangeError);
    WORLD.setStreaming({ margin: 16, step: 64 });
    assert.deepEqual(WORLD.stream, { margin: 16, step: 64 });
}

// 9) anchorTop: 위쪽 가장자리에 걸친 구조물은 앵커로 지탱되고, 켜지 않으면 허공 덩어리로 떨어진다.
for (const ANCHOR of [true, false]) {
    const WORLD = createWorld(),
        COLLAPSES = [];
    WORLD.attachBridge(new MatterBridge({ checkpoint: 1 }));
    WORLD.enableCollapse({ anchorTop: ANCHOR, interval: 1, minCells: 4 });
    WORLD.on('collapse', (e) => COLLAPSES.push(e));
    WORLD.rect(30, 0, 33, 12, 'stone'); // 위 가장자리에서 늘어진 기둥
    WORLD.supDirty = true;
    for (let i = 0; i < 20; i++) {
        WORLD.tick();
    }
    assert.equal(COLLAPSES.length > 0, !ANCHOR);
}

// 10) 뷰포트 픽셀: 부분 영역은 전체 쓰기의 같은 사각형이고, 격자 밖은 배경이며, 창이 움직여도 같은 셀은 같은 색이다.
{
    const WORLD = createWorld({ originX: 7, originY: 9 }),
        STORE = createStore(),
        SHADE = createGridShade(W * H),
        BACKGROUND = 0x12345678;
    STORE.fillAll(WORLD);
    const FULL = new Uint32Array(W * H);
    writeGridPixels(WORLD, FULL, SHADE, BACKGROUND);
    const VIEW = { x: 5, y: 3, w: 20, h: 10 },
        PART = new Uint32Array(VIEW.w * VIEW.h);
    writeGridPixels(WORLD, PART, SHADE, BACKGROUND, VIEW);
    for (let y = 0; y < VIEW.h; y++) {
        for (let x = 0; x < VIEW.w; x++) {
            assert.equal(PART[y * VIEW.w + x], FULL[(VIEW.y + y) * W + VIEW.x + x]);
        }
    }
    const EDGE = { x: -4, y: H - 3, w: 10, h: 8 },
        OUT = new Uint32Array(EDGE.w * EDGE.h);
    writeGridPixels(WORLD, OUT, SHADE, BACKGROUND, EDGE);
    for (let y = 0; y < EDGE.h; y++) {
        for (let x = 0; x < EDGE.w; x++) {
            const GX = EDGE.x + x,
                GY = EDGE.y + y,
                INSIDE = GX >= 0 && GX < W && GY >= 0 && GY < H;
            assert.equal(OUT[y * EDGE.w + x], INSIDE ? FULL[GY * W + GX] : BACKGROUND);
        }
    }
    const NONE = new Uint32Array(6);
    writeGridPixels(WORLD, NONE, SHADE, BACKGROUND, { x: 500, y: 500, w: 3, h: 2 });
    assert(NONE.every((v) => v === BACKGROUND));
    assert.throws(() => writeGridPixels(WORLD, NONE, SHADE, BACKGROUND, { x: 0, y: 0, w: 4, h: 4 }), RangeError);
    assert.throws(() => writeGridPixels(WORLD, NONE, SHADE, BACKGROUND, { x: 0.5, y: 0, w: 3, h: 2 }), RangeError);
    // 같은 절대 셀은 창이 움직여도 같은 색
    const BEFORE = new Uint32Array(W * H),
        AFTER = new Uint32Array(W * H);
    writeGridPixels(WORLD, BEFORE, SHADE, BACKGROUND);
    WORLD.shiftWindow(16, 32, STORE);
    writeGridPixels(WORLD, AFTER, SHADE, BACKGROUND);
    for (let y = 0; y < H - 32; y++) {
        for (let x = 0; x < W - 16; x++) {
            assert.equal(AFTER[y * W + x], BEFORE[(y + 32) * W + x + 16]);
        }
    }
}

console.log('pixel-physics open-world: ok');

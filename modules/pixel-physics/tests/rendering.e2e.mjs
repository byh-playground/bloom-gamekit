// pixel-physics 격자를 rendering 공유 아틀라스 영역으로 올려 VectorContext로 그리고 실제 WebGL 픽셀을 읽어 검증합니다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MATTER_URL } from '../dependencies.js';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const SERVER = createServer(async (req, res) => {
    try {
        const FILE = resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!FILE.startsWith(ROOT + sep)) {
            res.writeHead(403).end();
            return;
        }
        res.setHeader('Content-Type', extname(FILE) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript');
        res.end(await readFile(FILE));
    } catch {
        res.writeHead(404).end();
    }
});
let browser;
try {
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    const ORIGIN = `http://127.0.0.1:${SERVER.address().port}`;
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    });
    const PAGE = await browser.newPage();
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.route('**/*', (route) =>
        route
            .request()
            .url()
            .startsWith(ORIGIN + '/') || route.request().url() === MATTER_URL
            ? route.continue()
            : route.abort(),
    );
    await PAGE.goto(ORIGIN + '/modules/pixel-physics/examples/index.html');
    const RESULT = await PAGE.evaluate(async () => {
        const RENDERING = await import('/dist/rendering.js');
        const PIXEL = await import('/dist/pixel-physics.js');
        const W = 40,
            H = 30,
            ZOOM = 4;
        const WORLD = new PIXEL.PixelWorld(W, H, { seed: 3 });
        WORLD.define({ name: 'stone', kind: 'solid', color: [110, 112, 122] });
        WORLD.define({ name: 'sand', kind: 'powder', density: 15, color: [222, 190, 110] });
        WORLD.rect(0, 25, 39, 29, 'stone');
        WORLD.set(20, 5, 'sand');
        const CANVAS = document.createElement('canvas');
        CANVAS.width = W * ZOOM;
        CANVAS.height = H * ZOOM;
        document.body.append(CANVAS);
        const DEVICE = new RENDERING.WebGLDevice(CANVAS),
            CONTEXT = new RENDERING.VectorContext(DEVICE);
        const PIXELS = new Uint32Array(W * H),
            SHADE = PIXEL.createGridShade(W * H),
            BYTES = new Uint8ClampedArray(PIXELS.buffer);
        PIXEL.writeGridPixels(WORLD, PIXELS, SHADE);
        const REGION = DEVICE.textureAtlas.allocate(W, H, { filter: 'nearest' });
        DEVICE.textureAtlas.upload(REGION, { width: W, height: H, data: BYTES });
        const GL = DEVICE.gl;
        const READ = (cellX, cellY) => {
            const OUT = new Uint8Array(4);
            GL.readPixels(cellX * ZOOM + 2, H * ZOOM - (cellY * ZOOM + 2) - 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, OUT);
            return [...OUT];
        };
        const DRAW = () => {
            assert(CONTEXT.beginFrame({ clearColor: [0, 0, 0, 1] }));
            CONTEXT.drawRegion(REGION, 0, 0, W * ZOOM, H * ZOOM);
            CONTEXT.endFrame();
        };
        const EXPECT = (x, y) => [...new Uint8Array(PIXELS.buffer, (y * W + x) * 4, 4)];
        function assert(v) {
            if (!v) {
                throw new Error('assert');
            }
        }
        const CELLS = [
            [3, 27],
            [30, 26],
            [20, 5],
            [10, 10],
        ];
        DRAW();
        const FIRST = CELLS.map(([x, y]) => ({ got: READ(x, y), want: EXPECT(x, y) }));
        // 모래가 떨어지게 몇 틱 돌리고 같은 영역을 다시 올립니다(그릴 때마다 자동 upload하지 않음).
        for (let i = 0; i < 40; i++) {
            WORLD.tick();
        }
        PIXEL.writeGridPixels(WORLD, PIXELS, SHADE);
        DEVICE.textureAtlas.upload(REGION, { width: W, height: H, data: BYTES });
        DRAW();
        const SECOND = CELLS.map(([x, y]) => ({ got: READ(x, y), want: EXPECT(x, y) }));
        return { FIRST, SECOND, state: DEVICE.state };
    });
    // 아틀라스 바이트 영역: 반투명 premultiply, premultiplied 선언, 제자리 부분 갱신.
    const TEXTURE_RESULT = await PAGE.evaluate(async () => {
        const RENDERING = await import('/dist/rendering.js');
        const CANVAS = document.createElement('canvas');
        CANVAS.width = CANVAS.height = 16;
        document.body.append(CANVAS);
        const DEVICE = new RENDERING.WebGLDevice(CANVAS),
            CONTEXT = new RENDERING.VectorContext(DEVICE),
            ATLAS = DEVICE.textureAtlas;
        const GL = DEVICE.gl;
        const REGION_OF = (data, options) => {
            const REGION = ATLAS.allocate(4, 4, { filter: 'nearest' });
            ATLAS.upload(REGION, { width: 4, height: 4, data }, options);
            return REGION;
        };
        const BYTES = (rgba) => new Uint8ClampedArray(16 * 4).map((_, i) => rgba[i % 4]);
        const PIXEL_AT = (cellX, cellY) => {
            const OUT = new Uint8Array(4);
            GL.readPixels(cellX * 4 + 2, 16 - (cellY * 4 + 2) - 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, OUT);
            return [...OUT];
        };
        const DRAW = (region) => {
            CONTEXT.beginFrame({ clearColor: [0, 0, 0, 1] });
            CONTEXT.drawRegion(region, 0, 0, 16, 16);
            CONTEXT.endFrame();
        };
        const OUT = {};
        // 직선 알파 (200,100,50,128) → 검은 배경 위 결과는 RGB*128/255
        const STRAIGHT = REGION_OF(BYTES([200, 100, 50, 128]));
        DRAW(STRAIGHT);
        OUT.straight = PIXEL_AT(1, 1);
        // 이미 premultiply한 바이트를 선언하면 CPU 곱셈 없이 같은 화면이 나옵니다.
        const PRE = REGION_OF(BYTES([100, 50, 25, 128]), { premultiplied: true });
        DRAW(PRE);
        OUT.declared = PIXEL_AT(1, 1);
        // 부분 갱신: 왼쪽 위 2x2만 바꾸고 나머지는 이전 픽셀 유지, GPU 텍스처 수는 그대로
        const BEFORE = DEVICE.stats.textureCount;
        const PATCH = new Uint8ClampedArray(2 * 2 * 4).map((_, i) => [10, 220, 30, 255][i % 4]);
        const UPLOADS = DEVICE.stats.imageTexUploadCount;
        ATLAS.upload(STRAIGHT, { width: 2, height: 2, data: PATCH }, { x: 0, y: 0 });
        DRAW(STRAIGHT);
        OUT.regionInside = PIXEL_AT(0, 0);
        OUT.regionOutside = PIXEL_AT(3, 3);
        OUT.uploads = DEVICE.stats.imageTexUploadCount - UPLOADS;
        OUT.textureCount = [BEFORE, DEVICE.stats.textureCount];
        // 전체 갱신도 같은 영역·같은 GPU 텍스처 수로 반영
        ATLAS.upload(STRAIGHT, { width: 4, height: 4, data: BYTES([0, 0, 255, 255]) });
        DRAW(STRAIGHT);
        OUT.whole = PIXEL_AT(3, 3);
        try {
            ATLAS.upload(STRAIGHT, { width: 2, height: 2, data: PATCH }, { x: 3, y: 3 });
            OUT.outOfBounds = 'no error';
        } catch (error) {
            OUT.outOfBounds = error.name;
        }
        return OUT;
    });
    const NEAR = (got, want, label) =>
        assert.ok(
            got.every((v, i) => Math.abs(v - want[i]) <= 2),
            `${label}: ${got} != ${want}`,
        );
    NEAR(TEXTURE_RESULT.straight, [100, 50, 25, 255], 'straight alpha premultiply');
    NEAR(TEXTURE_RESULT.declared, [100, 50, 25, 255], 'premultiplied declared');
    NEAR(TEXTURE_RESULT.regionInside, [10, 220, 30, 255], 'region inside');
    NEAR(TEXTURE_RESULT.regionOutside, [100, 50, 25, 255], 'region outside kept');
    assert.equal(TEXTURE_RESULT.uploads, 1);
    assert.equal(TEXTURE_RESULT.textureCount[0], TEXTURE_RESULT.textureCount[1]);
    NEAR(TEXTURE_RESULT.whole, [0, 0, 255, 255], 'whole update');
    assert.equal(TEXTURE_RESULT.outOfBounds, 'RangeError');
    const CLOSE = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    for (const ROUND of [RESULT.FIRST, RESULT.SECOND]) {
        for (const CELL of ROUND) {
            assert.ok(CLOSE(CELL.got, CELL.want), `WebGL ${CELL.got} != grid ${CELL.want}`);
        }
    }
    assert.notDeepEqual(RESULT.FIRST[2].got, RESULT.SECOND[2].got, '모래가 움직인 뒤 텍스처가 갱신돼야 합니다.');
    assert.equal(RESULT.state, 'ready');
    assert.deepEqual(ERRORS, []);
    console.log(JSON.stringify({ status: 'PASS', cells: RESULT.SECOND.length }));
} finally {
    await browser?.close();
    SERVER.close();
}

// pixel-physics 격자를 rendering(WebGL 1 Renderer2D) 텍스처로 올려 실제 WebGL 픽셀을 읽어 검증합니다.
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
        document.body.append(CANVAS);
        const RENDERER = new RENDERING.Renderer2D(CANVAS);
        RENDERER.resize(W * ZOOM, H * ZOOM, 1);
        RENDERER.setCamera({ x: W / 2, y: H / 2, zoom: ZOOM });
        const PIXELS = new Uint32Array(W * H),
            SHADE = PIXEL.createGridShade(W * H),
            BYTES = new Uint8ClampedArray(PIXELS.buffer);
        PIXEL.writeGridPixels(WORLD, PIXELS, SHADE);
        const TEXTURE = RENDERER.createTexture({ width: W, height: H, data: BYTES }, { filter: 'nearest' });
        const GL = CANVAS.getContext('webgl');
        const READ = (cellX, cellY) => {
            const OUT = new Uint8Array(4);
            GL.readPixels(cellX * ZOOM + 2, H * ZOOM - (cellY * ZOOM + 2) - 1, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, OUT);
            return [...OUT];
        };
        const DRAW = () => {
            assert(RENDERER.beginFrame([0, 0, 0, 1]));
            RENDERER.sprite(TEXTURE, W / 2, H / 2, W, H);
            RENDERER.endFrame();
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
        // 모래가 떨어지게 몇 틱 돌리고 같은 텍스처를 다시 올립니다(sprite마다 자동 upload하지 않음).
        for (let i = 0; i < 40; i++) {
            WORLD.tick();
        }
        PIXEL.writeGridPixels(WORLD, PIXELS, SHADE);
        RENDERER.updateTexture(TEXTURE, { width: W, height: H, data: BYTES });
        DRAW();
        const SECOND = CELLS.map(([x, y]) => ({ got: READ(x, y), want: EXPECT(x, y) }));
        return { FIRST, SECOND, state: RENDERER.state };
    });
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

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 게임이 쓰는 그대로 확인한다: 배포물(dist/face.js)을 실제 Chromium WebGL 페이지에서 불러와, 진짜 SVG 몸(소켓 3개)과
// vector actor 위에 표정을 굽고 → 그리고 → 확대하고 → 컨텍스트를 잃었다 되찾고 → 정리하는 흐름을 이어서 본다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BODY_SVG = 'modules/rendering/benchmarks/fixtures/pea.svg';
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><canvas id="screen" width="400" height="300"></canvas>
<script type="module">
import { WebGLDevice, VectorContext } from '/dist/rendering.js';
import { createVectorActor } from '/dist/vector-assets.js';
import { createVectorAssetLoader } from '/dist/vector-assets-loader.js';
import * as FACE from '/dist/face.js';

const WIDTH = 400, HEIGHT = 300;
const DEVICE = new WebGLDevice(document.querySelector('#screen'), {
    alpha: false, antialias: false, preserveDrawingBuffer: true,
});
const CONTEXT = new VectorContext(DEVICE);
CONTEXT.acquireMeshRenderer();
const COMPILED = await createVectorAssetLoader({ maxEntries: 0 }).load('/body.svg', { sourcePath: 'pea.svg' });
const ACTOR = createVectorActor(CONTEXT, COMPILED, { clip: Object.keys(COMPILED.metadata.clips)[0], startedAtMs: 0 });
ACTOR.seek(0);
const ANCHOR = FACE.faceAnchor(COMPILED);
const matrixOf = (scale) => [scale, 0, 0, scale, 20, 10];
const readAll = () => {
    const BYTES = new Uint8Array(WIDTH * HEIGHT * 4);
    DEVICE.gl.readPixels(0, 0, WIDTH, HEIGHT, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, BYTES);
    return BYTES;
};
// 몸을 그린 뒤 drawFace(matrix)로 얼굴을 얹은 한 프레임의 픽셀과 drawFace의 반환값.
const frame = (scale, drawFace) => {
    const MATRIX = matrixOf(scale);
    CONTEXT.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0.9, 0.92, 0.87, 1] });
    CONTEXT.drawVectorActor(ACTOR, { matrix: MATRIX, alpha: 1 });
    const RETURNED = drawFace ? drawFace(MATRIX) : null;
    CONTEXT.endFrame();
    return { pixels: readAll(), returned: RETURNED };
};
const pixelAt = (pixels, x, y) => {
    const OFFSET = ((HEIGHT - 1 - Math.round(y)) * WIDTH + Math.round(x)) * 4;
    return Array.from(pixels.subarray(OFFSET, OFFSET + 4));
};
const screenOf = (socket, scale) => {
    const POINT = ACTOR.getSocket(socket);
    return [POINT.x * scale + 20, POINT.y * scale + 10];
};
const changed = (a, b, threshold = 0) => {
    let count = 0;
    for (let i = 0; i < a.length; i += 4) {
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > threshold) {
            count++;
        }
    }
    return count;
};
const regionCount = () => DEVICE.textureAtlas.regions.size;
const THROWS = (run) => { try { run(); return null; } catch (error) { return error.constructor.name + ': ' + error.message; } };

const RESULT = { regionsBefore: regionCount() };
const SMALL = 0.35, LARGE = 1.1;

// 1. 개발자가 표정을 고른다: 13가지 모두 이 몸의 소켓으로 만들어지고, 없는 표정은 오류다.
RESULT.faceCount = FACE.FACE_IDS.length;
RESULT.built = FACE.FACE_IDS.map((id) => FACE.buildFace(id, ANCHOR).length > 0 && FACE.faceSvg(id, ANCHOR).startsWith('<path'));
RESULT.unknownFace = THROWS(() => FACE.faceParts('sleepy'));
RESULT.missingSocket = THROWS(() => FACE.faceAnchor({ metadata: { sockets: {} }, sourcePath: 'no-face.svg' }));

// 2. 굽기 전 첫 프레임은 경로로 그려진다.
const OVERLAY = new FACE.FaceOverlay(CONTEXT);
const BODY_ONLY = frame(SMALL, null).pixels;
RESULT.beforePrepare = { ready: OVERLAY.ready, returned: frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'happy', m)).returned };

// 3. 렌더러 시작에서 한 번 굽는다. 이후 같은 표정은 이미지로 그려진다.
OVERLAY.prepare();
RESULT.regionsBaked = regionCount() - RESULT.regionsBefore;
RESULT.ready = OVERLAY.ready;
const LEFT_EYE = screenOf('face-eye-left', SMALL);
const BAKED = frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'neutral', m));
RESULT.baked = {
    returned: BAKED.returned,
    changedPixels: changed(BODY_ONLY, BAKED.pixels),
    eyeBody: pixelAt(BODY_ONLY, ...LEFT_EYE),
    eye: pixelAt(BAKED.pixels, ...LEFT_EYE),
};

// 4. 같은 자세에서 이미지와 경로는 같은 얼굴이다(가장자리 안티앨리어싱 차이만).
const POSED = FACE.posedFace(ACTOR, ANCHOR, [0, 0, 0, 0, 0, 0]);
const PATHS = frame(SMALL, (m) => {
    CONTEXT.save();
    CONTEXT.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    CONTEXT.transform(POSED[0], POSED[1], POSED[2], POSED[3], POSED[4], POSED[5]);
    FACE.drawFacePaths(CONTEXT, COMPILED, 'neutral');
    CONTEXT.restore();
    return 'paths';
});
RESULT.equivalence = {
    faceChanged: changed(BODY_ONLY, BAKED.pixels, 40),
    imageVsPaths: changed(BAKED.pixels, PATHS.pixels, 40),
};

// 5. 표정과 볼 색은 그림을 바꾼다.
const HAPPY = frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'happy', m));
const BLUE = frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'neutral', m, 1, '#3366ff'));
RESULT.looks = { happyVsNeutral: changed(HAPPY.pixels, BAKED.pixels), blueVsDefaultCheeks: changed(BLUE.pixels, BAKED.pixels) };

// 6. 확대하면 이미지를 늘리지 않고 경로로 그린다.
const BIG_BODY = frame(LARGE, null).pixels;
const BIG = frame(LARGE, (m) => OVERLAY.draw(COMPILED, ACTOR, 'neutral', m));
RESULT.zoomed = { returned: BIG.returned, changedPixels: changed(BIG_BODY, BIG.pixels, 40), eye: pixelAt(BIG.pixels, ...screenOf('face-eye-left', LARGE)) };

// 7. 컨텍스트를 잃으면 그리지 않고, 되찾으면 다시 굽지 않아도 같은 그림이다.
const LOSS = DEVICE.gl.getExtension('WEBGL_lose_context');
RESULT.lossSupported = Boolean(LOSS);
window.__phase = {
    lose: () => LOSS.loseContext(),
    restore: () => LOSS.restoreContext(),
    state: () => DEVICE.state,
    lost: () => ({ state: DEVICE.state, ready: OVERLAY.ready, beginFrame: CONTEXT.beginFrame() }),
    afterRestore: () => {
        const AGAIN = frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'neutral', m));
        return { state: DEVICE.state, ready: OVERLAY.ready, returned: AGAIN.returned, sameAsBefore: changed(AGAIN.pixels, BAKED.pixels), glError: DEVICE.gl.getError() };
    },
    finish: () => {
        // 8. 일부 표정만 굽는 오버레이: 굽지 않은 표정은 경로로 그린다.
        const FEW = new FACE.FaceOverlay(CONTEXT, { faces: ['neutral', 'attack', 'hurt'] });
        const BEFORE_FEW = regionCount();
        FEW.prepare();
        const FEW_REGIONS = regionCount() - BEFORE_FEW;
        const FEW_BAKED = frame(SMALL, (m) => FEW.draw(COMPILED, ACTOR, 'attack', m)).returned;
        const FEW_PATHS = frame(SMALL, (m) => FEW.draw(COMPILED, ACTOR, 'happy', m)).returned;
        FEW.dispose();
        // 9. 정리: 올린 영역을 모두 돌려주고, 이후에도 오류 없이 경로로 그린다.
        const REGIONS_USED = regionCount();
        OVERLAY.dispose();
        const AFTER = frame(SMALL, (m) => OVERLAY.draw(COMPILED, ACTOR, 'neutral', m));
        return {
            few: { regions: FEW_REGIONS, baked: FEW_BAKED, outsideSet: FEW_PATHS },
            dispose: { regionsAfter: regionCount(), regionsBeforeDispose: REGIONS_USED, ready: OVERLAY.ready, returned: AFTER.returned, drawnWithPaths: changed(BODY_ONLY, AFTER.pixels, 40) },
            glError: DEVICE.gl.getError(),
        };
    },
};
RESULT.glError = DEVICE.gl.getError();
window.__result = RESULT;
</script></body></html>`;

const SERVER = createServer(async (request, response) => {
    const PATH = new URL(request.url, 'http://local').pathname;
    try {
        if (PATH === '/') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        } else if (PATH === '/body.svg') {
            response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(await readFile(resolve(ROOT, BODY_SVG)));
        } else if (/^\/dist\/[a-z-]+\.js$/.test(PATH)) {
            response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
            response.end(await readFile(resolve(ROOT, PATH.slice(1))));
        } else {
            response.writeHead(404).end();
        }
    } catch {
        // 없는 파일은 404로 알린다. 페이지가 불러오지 못하면 아래 대기에서 시험이 실패한다.
        response.writeHead(404).end();
    }
});
let browser;
try {
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const PAGE_NOW = await browser.newPage();
    const ERRORS = [];
    PAGE_NOW.on('pageerror', (error) => ERRORS.push(error.stack ?? error.message));
    await PAGE_NOW.goto(`http://127.0.0.1:${SERVER.address().port}/`);
    await PAGE_NOW.waitForFunction(() => window.__result, null, { timeout: 60000 });
    const R = await PAGE_NOW.evaluate(() => window.__result);

    // 1. 표정 13가지는 모두 만들어지고 없는 표정·소켓 없는 몸은 오류다.
    assert.equal(R.faceCount, 13);
    assert.deepEqual(R.built, Array(13).fill(true));
    assert.equal(R.unknownFace, 'RangeError: Unknown face: sleepy');
    assert.match(R.missingSocket, /^Error: Body is missing face socket face-eye-left \(no-face\.svg\)$/);
    // 2. 굽기 전에는 경로(false)로 그린다.
    assert.deepEqual(R.beforePrepare, { ready: false, returned: false });
    // 3. 한 번 구우면 13표정×3부위 + 볼 1장이 아틀라스 영역이고, 같은 표정은 이미지(true)로 그려진다.
    assert.equal(R.regionsBaked, 13 * 3 + 1);
    assert.equal(R.ready, true);
    assert.equal(R.baked.returned, true);
    assert.ok(R.baked.changedPixels > 150, `face pixels: ${R.baked.changedPixels}`);
    assert.ok(R.baked.eye[0] < 100 && R.baked.eye[1] < 70, `eye is dark ink: ${R.baked.eye}`);
    assert.ok(R.baked.eyeBody[0] > 120, `body under the eye is not dark: ${R.baked.eyeBody}`);
    // 4. 이미지와 경로는 같은 얼굴이다: 얼굴 픽셀 중 크게 다른 것은 극히 일부.
    assert.ok(R.equivalence.faceChanged > 150);
    assert.ok(R.equivalence.imageVsPaths < R.equivalence.faceChanged * 0.25, JSON.stringify(R.equivalence));
    // 5. 표정과 볼 색을 바꾸면 그림이 바뀐다.
    assert.ok(R.looks.happyVsNeutral > 100 && R.looks.blueVsDefaultCheeks > 50, JSON.stringify(R.looks));
    // 6. 확대하면 경로(false)로 그리고 눈은 여전히 짙은 잉크 색이다.
    assert.equal(R.zoomed.returned, false);
    assert.ok(R.zoomed.changedPixels > 1000, `zoomed face pixels: ${R.zoomed.changedPixels}`);
    assert.ok(R.zoomed.eye[0] < 100 && R.zoomed.eye[1] < 70, `zoomed eye is dark ink: ${R.zoomed.eye}`);
    assert.equal(R.glError, 0);

    // 7. 컨텍스트 소실: 소실 중에는 이미지를 그릴 수 없고(프레임도 건너뛴다), 복구 뒤에는 다시 굽지 않고도 같은 그림이다.
    assert.equal(R.lossSupported, true, 'WEBGL_lose_context is required');
    await PAGE_NOW.evaluate(() => window.__phase.lose());
    await PAGE_NOW.waitForFunction(() => window.__phase.state() === 'lost');
    assert.deepEqual(await PAGE_NOW.evaluate(() => window.__phase.lost()), {
        state: 'lost',
        ready: false,
        beginFrame: false,
    });
    await PAGE_NOW.evaluate(() => window.__phase.restore());
    await PAGE_NOW.waitForFunction(() => window.__phase.state() === 'ready');
    const RESTORED = await PAGE_NOW.evaluate(() => window.__phase.afterRestore());
    assert.deepEqual(RESTORED, { state: 'ready', ready: true, returned: true, sameAsBefore: 0, glError: 0 });

    // 8~9. 일부 표정만 굽기, 정리.
    const END = await PAGE_NOW.evaluate(() => window.__phase.finish());
    assert.deepEqual(END.few, { regions: 3 * 3 + 1, baked: true, outsideSet: false });
    assert.equal(END.dispose.regionsAfter, R.regionsBefore);
    assert.equal(END.dispose.ready, false);
    assert.equal(END.dispose.returned, false);
    assert.ok(END.dispose.drawnWithPaths > 150);
    assert.equal(END.glError, 0);
    assert.deepEqual(ERRORS, []);
    console.log(
        JSON.stringify({
            status: 'PASS',
            faces: R.faceCount,
            bakedRegions: R.regionsBaked,
            face: R.baked.changedPixels,
        }),
    );
} finally {
    await browser?.close();
    SERVER.close();
}

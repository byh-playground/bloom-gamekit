import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Reuse the public example's sequential benchmark. Never shrink actors to fit.
const RAW = [];
const ERRORS = [];
const COUNTS = process.argv.includes('--quick') ? [500] : [500, 1000];
const SPREADS = process.argv.includes('--quick') ? [100] : [100, 35];
const HASHES = {};
for (const FILE of [
    'dist/rendering.js',
    'dist/vector-assets.js',
    'dist/previews/vector-raster-comparison.html',
    'modules/vector-assets/assets/seed-scout-raster-comparison.svg',
]) {
    HASHES[FILE] = createHash('sha256')
        .update(await readFile(FILE))
        .digest('hex');
}
const SOURCE_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const SOURCE_DIRTY = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
let report;
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 1100, height: 1200 }, deviceScaleFactor: 1 });
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(pathToFileURL(resolve('dist/previews/vector-raster-comparison.html')).href);
    await PAGE.waitForFunction(() => globalThis.__rasterComparison?.ready, null, { timeout: 30000 });
    const BOOT = await PAGE.evaluate(() => globalThis.__rasterComparison.snapshot);
    assert.doesNotMatch(BOOT.renderer, /SwiftShader/i, 'Software GPU is not a hardware benchmark');
    await PAGE.evaluate(() => globalThis.__rasterComparison.setAutoRender(false));
    await PAGE.addStyleTag({
        content:
            'body{grid-template-rows:auto auto 600px auto!important;overflow:hidden!important}.stage{height:600px!important;min-height:600px!important;max-height:600px!important}',
    });
    for (const COUNT of COUNTS) {
        for (const SPREAD of SPREADS) {
            const RESULT = await PAGE.evaluate(
                async ({ count, spread }) => {
                    const D = globalThis.__rasterComparison;
                    D.setScene('crowd');
                    D.setCount(count);
                    D.setMode('vector');
                    D.setClip('transform-repeat');
                    D.setExpression('neutral');
                    D.setResolution(256);
                    D.setSampleInterval(100);
                    D.setMixed(false);
                    D.setPixelSize(64);
                    D.setSpread(spread);
                    D.setSeed(4242);
                    const INITIAL = D.renderOnce({ timeMs: 0 });
                    const BENCHMARK = await D.runBenchmark({
                        warmupFrames: 30,
                        sampleFrames: 60,
                        orders: [
                            ['vector', 'raster', 'sprite'],
                            ['sprite', 'raster', 'vector'],
                        ],
                    });
                    return { initial: INITIAL, benchmark: BENCHMARK };
                },
                { count: COUNT, spread: SPREAD },
            );
            RAW.push({ count: COUNT, spread: SPREAD, ...RESULT });
            assert.equal(RESULT.initial.canvasWidth, 1100);
            assert.equal(RESULT.initial.canvasHeight, 600);
            assert.equal(RESULT.initial.layout.pixelSize, 64);
            assert.equal(RESULT.initial.preparation.status, 'ready');
            console.log(`count=${COUNT} size=64px spread=${SPREAD}% forward/reverse complete`);
        }
    }
    assert.deepEqual(ERRORS, []);
    report = {
        status: 'PASS',
        sourceHead: SOURCE_HEAD,
        sourceDirty: SOURCE_DIRTY,
        hashes: HASHES,
        browser: BROWSER.version(),
        renderer: BOOT.renderer,
        coldBoot: BOOT,
        conditions: {
            viewport: [1100, 600],
            devicePixelRatio: 1,
            pixelSize: 64,
            seed: 4242,
            clip: 'transform-repeat',
            resolution: 256,
            sampleIntervalMs: 100,
            warmupFrames: 30,
            sampleFrames: 60,
            counts: COUNTS,
            spreads: SPREADS,
        },
        scope: 'Public example sequential full-viewport animation benchmark. RAF cadence is separate from CPU render/submit and asynchronous GPU duration. Split panels are not used. No whole-game or physical-mobile claim.',
        errors: ERRORS,
        raw: RAW,
    };
} catch (error) {
    report = {
        status: 'FAIL',
        sourceHead: SOURCE_HEAD,
        sourceDirty: SOURCE_DIRTY,
        hashes: HASHES,
        raw: RAW,
        errors: ERRORS,
        error: error.stack,
    };
    throw error;
} finally {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/raster-large-render-benchmark.json', JSON.stringify(report, null, 2));
    await BROWSER.close();
}

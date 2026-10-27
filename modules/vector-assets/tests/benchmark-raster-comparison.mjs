import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

// Steady-state microbenchmark of the public example, not whole-game FPS.
// Run after build + build:previews. A/B/C and C/B/A share the same browser,
// camera, source SVG, population, independent phases and display-time samples.
const ROOT = resolve('.');
const RAW = [];
const ERRORS = [];
const HASHES = {};
for (const FILE of [
    'dist/rendering.js',
    'dist/vector-assets.js',
    'dist/previews/vector-raster-comparison.html',
    'modules/vector-assets/assets/seed-scout.svg',
]) {
    HASHES[FILE] = createHash('sha256')
        .update(await readFile(resolve(ROOT, FILE)))
        .digest('hex');
}
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
});
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
    PAGE.on('pageerror', (error) => ERRORS.push(error.stack));
    await PAGE.goto(pathToFileURL(resolve(ROOT, 'dist/previews/vector-raster-comparison.html')).href);
    await PAGE.waitForFunction(() => globalThis.__rasterComparison?.ready, null, { timeout: 30000 });
    const BOOT = await PAGE.evaluate(() => globalThis.__rasterComparison.snapshot);
    await PAGE.evaluate(() => globalThis.__rasterComparison.setAutoRender(false));
    await PAGE.evaluate(() => document.querySelector('canvas').getContext('webgl2').finish());
    for (const COUNT of [100, 500, 1000]) {
        for (const [ROUND, ORDER] of [
            ['forward', ['vector', 'raster', 'sprite']],
            ['reverse', ['sprite', 'raster', 'vector']],
        ]) {
            for (const MODE of ORDER) {
                const RUN = await PAGE.evaluate(
                    async ({ mode, count }) => {
                        const BRIDGE = globalThis.__rasterComparison;
                        BRIDGE.setMode(mode);
                        BRIDGE.setCount(count);
                        BRIDGE.setClip('bounce');
                        BRIDGE.setResolution(256);
                        BRIDGE.setSampleInterval(100);
                        BRIDGE.setMixed(false);
                        BRIDGE.setZoom(1);
                        const SETUP_START = performance.now();
                        const INITIAL = BRIDGE.renderOnce({ timeMs: 0 });
                        document.querySelector('canvas').getContext('webgl2').finish();
                        const SETUP_COMPLETE_WALL_MS = performance.now() - SETUP_START;
                        for (let frame = 0; frame < 30; frame++) {
                            BRIDGE.renderOnce({ timeMs: (frame * 16.6667) % 500 });
                            await new Promise((resolve) => setTimeout(resolve, 16));
                        }
                        BRIDGE.drainGpuSamples();
                        const SAMPLES = [];
                        for (let frame = 0; frame < 60; frame++) {
                            SAMPLES.push(BRIDGE.renderOnce({ timeMs: (frame * 16.6667) % 500 }));
                            await new Promise((resolve) => setTimeout(resolve, 16));
                        }
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        BRIDGE.pollGpuTimers();
                        const MEASURED_FRAMES = new Set(SAMPLES.map((sample) => sample.frame));
                        return {
                            initial: INITIAL,
                            setupCompleteWallMs: SETUP_COMPLETE_WALL_MS,
                            samples: SAMPLES,
                            gpuSamples: BRIDGE.drainGpuSamples().filter((sample) => MEASURED_FRAMES.has(sample.frame)),
                        };
                    },
                    { mode: MODE, count: COUNT },
                );
                RAW.push({ count: COUNT, round: ROUND, mode: MODE, ...RUN });
                console.log(`${COUNT} ${ROUND} ${MODE} complete`);
            }
        }
    }
    const PERCENTILE = (values, fraction) => {
        const SORTED = values.filter(Number.isFinite).sort((a, b) => a - b);
        return SORTED.length ? SORTED[Math.floor((SORTED.length - 1) * fraction)] : null;
    };
    const SUMMARY = RAW.map((run) => ({
        count: run.count,
        round: run.round,
        mode: run.mode,
        cpuP50: PERCENTILE(
            run.samples.map((sample) => sample.cpuMs),
            0.5,
        ),
        cpuP95: PERCENTILE(
            run.samples.map((sample) => sample.cpuMs),
            0.95,
        ),
        animationP50: PERCENTILE(
            run.samples.map((sample) => sample.animationMs),
            0.5,
        ),
        submitP50: PERCENTILE(
            run.samples.map((sample) => sample.submitMs),
            0.5,
        ),
        gpuP50: PERCENTILE(
            run.gpuSamples.map((sample) => sample.gpuMs),
            0.5,
        ),
        gpuP95: PERCENTILE(
            run.gpuSamples.map((sample) => sample.gpuMs),
            0.95,
        ),
        gpuSamples: run.gpuSamples,
        first: run.initial,
        setupCompleteWallMs: run.setupCompleteWallMs,
        last: run.samples.at(-1),
    }));
    const REPORT = {
        sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        hashes: HASHES,
        browser: BROWSER.version(),
        boot: BOOT,
        scope: 'Local public module example; no game changes. CPU render wall time and asynchronous GPU query samples are separate. Initial construction/bake is included in first samples, excluded by steady-state warmup.',
        errors: ERRORS,
        summary: SUMMARY,
        raw: RAW,
    };
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(resolve(ROOT, 'test-results/raster-comparison-benchmark.json'), JSON.stringify(REPORT, null, 2));
    if (ERRORS.length) {
        throw new Error(ERRORS.join('\n'));
    }
} finally {
    await BROWSER.close();
}

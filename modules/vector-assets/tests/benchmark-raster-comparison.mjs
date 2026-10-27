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
const CLIPS = process.argv.includes('--loop-only')
    ? ['transform-repeat']
    : process.argv.includes('--once-only')
      ? ['bounce']
      : ['transform-repeat', 'bounce'];
const COUNTS = process.argv.includes('--full') ? [100, 500, 1000] : [500];
const CASES = CLIPS.flatMap((clip) => COUNTS.map((count) => ({ clip, count })));
const REPORT_NAME = process.argv.includes('--loop-only')
    ? 'loop'
    : process.argv.includes('--once-only')
      ? 'once'
      : 'all';
for (const FILE of [
    'dist/rendering.js',
    'dist/vector-assets.js',
    'dist/previews/vector-raster-comparison.html',
    'modules/vector-assets/assets/seed-scout.svg',
    'modules/vector-assets/assets/seed-scout-raster-comparison.svg',
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
    await PAGE.addStyleTag({
        content:
            'body{grid-template-rows:auto 360px auto!important;overflow:hidden!important}.stage{height:360px!important;min-height:360px!important;max-height:360px!important}',
    });
    await PAGE.evaluate(() => document.querySelector('canvas').getContext('webgl2').finish());
    for (const { count: COUNT, clip: CLIP } of CASES) {
        for (const [ROUND, ORDER] of [
            ['forward', ['vector', 'raster', 'sprite']],
            ['reverse', ['sprite', 'raster', 'vector']],
        ]) {
            for (const MODE of ORDER) {
                const RUN = await PAGE.evaluate(
                    async ({ mode, count, clip }) => {
                        const BRIDGE = globalThis.__rasterComparison;
                        BRIDGE.setMode(mode);
                        BRIDGE.setCount(count);
                        BRIDGE.setClip(clip);
                        BRIDGE.setResolution(256);
                        BRIDGE.setSampleInterval(100);
                        BRIDGE.setMixed(false);
                        BRIDGE.setZoom(1);
                        const SETUP_START = performance.now();
                        const INITIAL = BRIDGE.renderOnce({ timeMs: 0 });
                        document.querySelector('canvas').getContext('webgl2').finish();
                        const SETUP_COMPLETE_WALL_MS = performance.now() - SETUP_START;
                        for (let frame = 0; frame < 30; frame++) {
                            BRIDGE.renderOnce({
                                timeMs: clip === 'bounce' ? (frame * 16.6667) % 500 : frame * 16.6667,
                            });
                            await new Promise((resolve) => setTimeout(resolve, 16));
                        }
                        BRIDGE.drainGpuSamples();
                        const SAMPLES = [];
                        for (let frame = 0; frame < 60; frame++) {
                            SAMPLES.push(
                                BRIDGE.renderOnce({
                                    timeMs: clip === 'bounce' ? (frame * 16.6667) % 500 : 500 + frame * 16.6667,
                                }),
                            );
                            await new Promise((resolve) => setTimeout(resolve, 16));
                        }
                        document.querySelector('canvas').getContext('webgl2').flush();
                        for (let poll = 0; poll < 30; poll++) {
                            await new Promise((resolve) => setTimeout(resolve, 16));
                            if (!BRIDGE.pollGpuTimers().pendingCount) {
                                break;
                            }
                        }
                        const MEASURED_FRAMES = new Set(SAMPLES.map((sample) => sample.frame));
                        return {
                            initial: INITIAL,
                            setupCompleteWallMs: SETUP_COMPLETE_WALL_MS,
                            samples: SAMPLES,
                            gpuSamples: BRIDGE.drainGpuSamples().filter((sample) => MEASURED_FRAMES.has(sample.frame)),
                            glError: document.querySelector('canvas').getContext('webgl2').getError(),
                        };
                    },
                    { mode: MODE, count: COUNT, clip: CLIP },
                );
                RAW.push({ count: COUNT, clip: CLIP, round: ROUND, mode: MODE, ...RUN });
                if (RUN.glError) {
                    throw new Error(`WebGL error ${RUN.glError} in measured run`);
                }
                if (
                    RUN.initial.preparation?.status !== 'ready' ||
                    RUN.samples.some(
                        (sample) =>
                            sample.preparation?.generation !== RUN.initial.preparation.generation ||
                            sample.imageTexUploadCount !== RUN.initial.imageTexUploadCount ||
                            sample.imageTexUploadBytes !== RUN.initial.imageTexUploadBytes ||
                            sample.atlas.bakeCount !== RUN.initial.atlas.bakeCount ||
                            sample.sprite.sets.some(
                                (entry, index) =>
                                    entry.stats?.bakeCount !== RUN.initial.sprite.sets[index].stats?.bakeCount,
                            ),
                    )
                ) {
                    throw new Error('Steady playback changed a prepared atlas or uploaded image data');
                }
                if (RUN.samples.some((sample) => sample.canvasWidth !== 1100 || sample.canvasHeight !== 360)) {
                    throw new Error('Render dimensions changed across comparison paths');
                }
                if (/SwiftShader/i.test(RUN.initial.renderer)) {
                    throw new Error('Software GPU is not a hardware benchmark');
                }
                if (
                    CLIP === 'transform-repeat' &&
                    RUN.samples.some((sample) =>
                        MODE === 'raster'
                            ? sample.rasterResult.rasterDraws !== COUNT || sample.rasterResult.vectorFallbacks !== 0
                            : MODE === 'sprite'
                              ? sample.spriteResult.spriteDraws !== COUNT || sample.spriteResult.vectorFallbacks !== 0
                              : sample.poses.gpuDrawInstances !== COUNT,
                    )
                ) {
                    throw new Error('Representative comparison did not use its actual rendering backend');
                }
                console.log(`${CLIP} ${COUNT} ${ROUND} ${MODE} complete`);
            }
        }
    }
    const PERCENTILE = (values, fraction) => {
        const SORTED = values.filter(Number.isFinite).sort((a, b) => a - b);
        return SORTED.length ? SORTED[Math.floor((SORTED.length - 1) * fraction)] : null;
    };
    const SUMMARY = RAW.map((run) => ({
        count: run.count,
        clip: run.clip,
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
    await writeFile(
        resolve(ROOT, `test-results/raster-comparison-benchmark-${REPORT_NAME}.json`),
        JSON.stringify(REPORT, null, 2),
    );
    if (ERRORS.length) {
        throw new Error(ERRORS.join('\n'));
    }
} catch (error) {
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(
        resolve(ROOT, `test-results/raster-benchmark-failure-${REPORT_NAME}.json`),
        JSON.stringify({ error: error.message, hashes: HASHES, raw: RAW }, null, 2),
    );
    throw error;
} finally {
    await BROWSER.close();
}

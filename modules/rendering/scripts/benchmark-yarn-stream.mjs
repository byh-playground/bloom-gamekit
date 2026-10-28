import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

// Run: npm run benchmark:yarn-stream -- <label> [high|low|default]
// Compares today's per-surface yarn draws with two stream integrations on real GPU hardware.
// SwiftShader is rejected: the question is fragment cost and program switching, which software rendering hides.
const ROOT = resolve('.');
const LABEL = process.argv[2] ?? 'unlabeled';
const GPU_PREFERENCE = process.argv[3] ?? 'high';
const REPORT_PATH = resolve(ROOT, 'project/docs/yarn-stream-benchmark.json');
const EXECUTABLE_PATH =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
if (!EXECUTABLE_PATH) {
    throw new Error('Set CHROMIUM_EXECUTABLE_PATH to a hardware-accelerated Chromium.');
}
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
};
const SERVER = createServer(async (req, res) => {
    const PATH = new URL(req.url, 'http://localhost').pathname;
    try {
        res.setHeader('Content-Type', TYPES[extname(PATH)] ?? 'application/octet-stream');
        res.end(await readFile(resolve(ROOT, '.' + PATH)));
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
const GPU_ARGS = { high: ['--force_high_performance_gpu'], low: ['--force_low_power_gpu'], default: [] };
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: [
        '--use-angle=d3d11',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        ...(GPU_ARGS[GPU_PREFERENCE] ?? []),
    ],
});
// Scene axes: how many characters, how finely yarn and sprite parts alternate, and how large each yarn surface is.
// The 'sprinkle' set (fourth argument) is mostly sprites with a few yarn surfaces: it shows where paying the combined
// program's cost for every sprite stops being worth removing program switches.
const SPRINKLE_SCENES = [1024, 4096].flatMap((n) =>
    [4, 16, 64, 256].map((yarnCount) => ({ n, layout: 'sprinkle', yarnCount })),
);
// The 'sdf' set compares every configuration with its stitch-distance-field variant: pixel-bound yarn, interleaved
// yarn, a sparse sprinkle, and sprites only (which shows what the combined program costs plain sprites).
const SDF_SCENES = [
    { n: 1024, layout: 'layered', yarnRadius: 32 },
    { n: 1024, layout: 'layered', yarnRadius: 64 },
    { n: 256, layout: 'perChar', yarnRadius: 64 },
    { n: 1024, layout: 'fine', yarnRadius: 32 },
    { n: 4096, layout: 'sprinkle', yarnCount: 16 },
    { n: 4096, layout: 'sprinkle', yarnCount: 256 },
    { n: 4096, layout: 'spriteOnly' },
];
const SDF_OPTIONS = {
    configs: ['current', 'current_SDF', 'S', 'S_SDF', 'U', 'U_SDF'],
    frames: 60,
    warmup: 20,
    doVerify: false,
};
const PULL_OPTIONS = {
    configs: ['current_SDF', 'U', 'UP', 'U_SDF', 'UP_SDF'],
    frames: 60,
    warmup: 20,
    doVerify: false,
};
const SCENES =
    process.argv[4] === 'sdf' || process.argv[4] === 'pull'
        ? SDF_SCENES
        : process.argv[4] === 'sprinkle'
          ? SPRINKLE_SCENES
          : [
                ...[64, 256, 1024].flatMap((n) => [
                    { n, layout: 'layered' },
                    { n, layout: 'perChar' },
                    { n, layout: 'fine' },
                ]),
                { n: 256, layout: 'perChar', yarnRadius: 64 },
                { n: 256, layout: 'perChar', outlinePoints: 72 },
                { n: 1024, layout: 'spriteOnly' },
                { n: 4096, layout: 'spriteOnly' },
            ];
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 1000, height: 800 } });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    PAGE.on(
        'console',
        (message) =>
            message.type() === 'error' &&
            !message.location().url.endsWith('/favicon.ico') &&
            ERRORS.push(message.text()),
    );
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/rendering/benchmarks/yarn-stream.html`);
    await PAGE.waitForFunction(() => window.yarnStreamBenchmark?.ready || document.body.dataset.failed, null, {
        timeout: 60000,
    }).catch((error) => {
        throw new Error([error.message, ...ERRORS].join('\n'));
    });
    const RENDERER = await PAGE.evaluate(() => window.yarnStreamBenchmark.renderer);
    if (/swiftshader|software|llvmpipe/i.test(RENDERER)) {
        throw new Error(`Refusing a software renderer: ${RENDERER}`);
    }
    if (process.argv[4] === 'decompose') {
        // Per-stage GPU cost of yarn in today's per-surface path; yarn-only cost is each variant minus the 'none' frame.
        const DECOMPOSE_SCENES = [
            { n: 1024, layout: 'layered' },
            { n: 1024, layout: 'layered', yarnRadius: 64 },
        ];
        const DECOMPOSED = await PAGE.evaluate(
            (scenes) => window.yarnStreamBenchmark.decompose({ scenes }),
            DECOMPOSE_SCENES,
        );
        if (ERRORS.length) {
            throw new Error(ERRORS.join('\n'));
        }
        let decomposeReport = { runs: [] };
        const DECOMPOSE_PATH = resolve(ROOT, 'project/docs/yarn-stream-decompose.json');
        try {
            decomposeReport = JSON.parse(await readFile(DECOMPOSE_PATH, 'utf8'));
        } catch {
            // First run creates the report.
        }
        decomposeReport.runs = decomposeReport.runs.filter((run) => run.label !== LABEL);
        decomposeReport.runs.push({ label: LABEL, gpuPreference: GPU_PREFERENCE, ...DECOMPOSED });
        await writeFile(DECOMPOSE_PATH, JSON.stringify(decomposeReport, null, 4) + '\n');
        console.log(`renderer: ${DECOMPOSED.renderer}`);
        for (const SCENE of DECOMPOSED.scenes) {
            const NONE = SCENE.variants.none.gpuMs;
            console.log(
                `\n[layered n=${SCENE.definition.n}${SCENE.definition.yarnRadius ? ' r=' + SCENE.definition.yarnRadius : ''}] sprites only (no yarn) = ${NONE.toFixed(2)} ms`,
            );
            const FULL = SCENE.variants.full.gpuMs - NONE;
            for (const [NAME, VALUE] of Object.entries(SCENE.variants)) {
                if (NAME === 'none') {
                    continue;
                }
                const COST = VALUE.gpuMs - NONE;
                console.log(
                    `  ${NAME.padEnd(10)} yarn cost ${COST.toFixed(2).padStart(6)} ms  (${((COST / FULL) * 100).toFixed(0).padStart(3)}% of full)`,
                );
            }
        }
        await BROWSER.close();
        SERVER.close();
        process.exit(0);
    }
    const RESULT = await PAGE.evaluate((options) => window.yarnStreamBenchmark.run(options), {
        scenes: SCENES,
        ...(process.argv[4] === 'sdf' ? SDF_OPTIONS : process.argv[4] === 'pull' ? PULL_OPTIONS : {}),
    });
    if (ERRORS.length) {
        throw new Error(ERRORS.join('\n'));
    }
    const GIT = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    let report = {
        scope: 'Yarn surface integration candidates on real GPU hardware; one machine, desktop GPUs, 1280x720, no mobile data.',
        runs: [],
    };
    try {
        report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
    } catch {
        // First run creates the report.
    }
    report.runs = report.runs.filter((run) => run.label !== LABEL);
    report.runs.push({
        label: LABEL,
        gpuPreference: GPU_PREFERENCE,
        sourceHead: GIT(['rev-parse', 'HEAD']),
        sourceDirty: GIT(['status', '--porcelain']) !== '',
        ...RESULT,
    });
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 4) + '\n');
    console.log(`renderer: ${RESULT.renderer} | timer query: ${RESULT.timerQuery}`);
    const FIXED = (value, digits = 2) => (value === null || value === undefined ? '  n/a' : value.toFixed(digits));
    for (const SCENE of RESULT.scenes) {
        const D = SCENE.definition;
        console.log(
            `\n[${D.layout} n=${D.n}${D.yarnRadius ? ' r=' + D.yarnRadius : ''}${D.outlinePoints ? ' pts=' + D.outlinePoints : ''}] runs=${SCENE.runs} yarn=${SCENE.yarnSurfaces} verts/surface=${SCENE.vertsPerSurface}` +
                (SCENE.verify ? ` verify=${JSON.stringify(SCENE.verify)}` : ''),
        );
        for (const [CONFIG_NAME, R] of Object.entries(SCENE.results)) {
            console.log(
                `  ${CONFIG_NAME.padEnd(8)} gpu ${FIXED(R.gpuMs)} ms  cpu ${FIXED(R.cpuMs)} ms  wall ${FIXED(R.wallMs)} ms  draws ${R.draws}  switches ${R.programSwitches}  upload ${FIXED(R.uploadKB, 0)} KB`,
            );
        }
    }
} finally {
    await BROWSER.close();
    SERVER.close();
}

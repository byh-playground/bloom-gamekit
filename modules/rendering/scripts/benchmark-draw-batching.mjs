import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

// Run: npm run benchmark:draw-batching -- <label> [shapes]
// Counts draw calls and batch-break reasons for interleaved species. SwiftShader timing verifies function only.
const ROOT = resolve('.');
const LABEL = process.argv[2] ?? 'unlabeled';
const SHAPES = Number(process.argv[3] ?? 0);
const REPORT_PATH = resolve(ROOT, 'project/docs/draw-batching-benchmark.json');
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
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
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 1000, height: 700 } });
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/rendering/benchmarks/draw-batching.html`);
    await PAGE.waitForFunction(() => window.drawBatchingBenchmark?.ready, null, { timeout: 60000 });
    const RESULT = await PAGE.evaluate(({ shapes }) => window.drawBatchingBenchmark.run({ shapes }), {
        shapes: SHAPES,
    });
    if (ERRORS.length) {
        throw new Error(ERRORS.join('\n'));
    }
    const GIT = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    let report = {
        scope: 'Interleaved species drawn in one frame; counts are exact, timing is SwiftShader and not device performance.',
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
        sourceHead: GIT(['rev-parse', 'HEAD']),
        sourceDirty: GIT(['status', '--porcelain']) !== '',
        ...RESULT,
    });
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 4) + '\n');
    console.log(JSON.stringify({ label: LABEL, ...RESULT }, null, 2));
} finally {
    await BROWSER.close();
    SERVER.close();
}

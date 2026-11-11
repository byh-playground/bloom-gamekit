// 통합 예제(work-scheduler/examples/index.html)의 디버그 장면을 dist/debug-scene.mjs로 엽니다. 게임 저장소의
// `scripts/debug-scene.cjs`가 되는 모양의 예이기도 합니다. 시험이 아닙니다(판정 없음). npm run build 뒤에 씁니다.
//   node modules/debug-tools/scripts/debug-scene.mjs "scene=contacts&budget=1&tick=100" [--state '{"times":true}']
//        [--capture out.png] [--compare <다른 worktree>] [--repeat N] [--heap] [--gpu] [--json]
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
};

// 체크아웃 하나의 저장소 루트를 그대로 내보냅니다. 비교 쪽 체크아웃에서도 그 체크아웃의 dist를 씁니다.
async function serve(root) {
    const SERVER = createServer(async (request, response) => {
        const FILE = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://local').pathname));
        if (!FILE.startsWith(root + sep)) {
            response.writeHead(403).end();
            return;
        }
        try {
            const BYTES = await readFile(FILE);
            response.writeHead(200, { 'content-type': TYPES[extname(FILE)] ?? 'application/octet-stream' });
            response.end(BYTES);
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    return {
        url: `http://127.0.0.1:${SERVER.address().port}/modules/work-scheduler/examples/index.html`,
        close: () => new Promise((done) => SERVER.close(done)),
    };
}

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const { runDebugScene: RUN_DEBUG_SCENE } = await import(pathToFileURL(join(ROOT, 'dist', 'debug-scene.mjs')).href);
await RUN_DEBUG_SCENE({
    chromium,
    argv: process.argv.slice(2),
    root: ROOT,
    serve,
    viewport: { width: 900, height: 1100 },
    fields: ['exampleTick', 'pairContacts', 'skippedPairs', 'overlapsBeforeSeparate'],
}).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});

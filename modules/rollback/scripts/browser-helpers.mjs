// 이 모듈 예제/검사만 사용하는 개발 도구. 배포 SDK에는 포함하지 않는다.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export { ROOT as root };
const DEMO_PATH = '/modules/rollback/examples/reference/index.html';
export { DEMO_PATH as demoPath };
const RESULTS_DIRECTORY = resolve(ROOT, 'test-results/rollback');
export { RESULTS_DIRECTORY as resultsDirectory };
export async function launchBrowser() {
    if (process.env.CHROMIUM_EXECUTABLE_PATH) {
        return chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        });
    }
    if (process.env.BROWSER_CHANNEL) {
        return chromium.launch({
            headless: true,
            channel: process.env.BROWSER_CHANNEL,
        });
    }
    const ATTEMPTS = [];
    for (const CHANNEL of [undefined, 'chrome', 'msedge']) {
        try {
            return await chromium.launch({
                headless: true,
                ...(CHANNEL
                    ? {
                          channel: CHANNEL,
                      }
                    : {}),
            });
        } catch (error) {
            ATTEMPTS.push(error.message);
        }
    }
    throw new Error(
        `Chromium을 실행할 수 없습니다. npx playwright install chromium 또는 CHROMIUM_EXECUTABLE_PATH/BROWSER_CHANNEL을 확인하세요.\n${ATTEMPTS.join('\n')}`,
    );
}
export async function serveRepository({ indexPath = DEMO_PATH, port = 0 } = {}) {
    const SERVER = createServer(async (request, response) => {
        try {
            const PATHNAME = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
            if (PATHNAME === '/') {
                response
                    .writeHead(302, {
                        location: indexPath,
                    })
                    .end();
                return;
            }
            if (PATHNAME === '/favicon.ico') {
                response.writeHead(204).end();
                return;
            }
            if (PATHNAME.split('/').some((part) => part.startsWith('.'))) {
                response.writeHead(403).end('Forbidden');
                return;
            }
            const FILE = await realpath(resolve(ROOT, `.${PATHNAME}`));
            if (!FILE.startsWith(`${ROOT}${sep}`)) {
                response.writeHead(403).end('Forbidden');
                return;
            }
            const TYPES = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8',
                '.mjs': 'text/javascript; charset=utf-8',
                '.md': 'text/plain; charset=utf-8',
                '.json': 'application/json',
            };
            const BYTES = await readFile(FILE);
            response
                .writeHead(200, {
                    'content-type': TYPES[extname(FILE)] || 'application/octet-stream',
                    'cache-control': 'no-store',
                })
                .end(BYTES);
        } catch {
            response.writeHead(404).end('Not found');
        }
    });
    await new Promise((done, reject) => {
        SERVER.once('error', reject);
        SERVER.listen(port, '127.0.0.1', done);
    });
    return SERVER;
}

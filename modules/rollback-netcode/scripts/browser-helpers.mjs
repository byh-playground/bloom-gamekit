// 이 모듈 예제/검사만 사용하는 개발 도구. 배포 SDK에는 포함하지 않는다.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const demoPath = '/modules/rollback-netcode/examples/index.html';
export const resultsDirectory = resolve(root, 'test-results/rollback');

export async function launchBrowser() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH) return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  if (process.env.BROWSER_CHANNEL) return chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL });
  const attempts = [];
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try { return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); }
    catch (error) { attempts.push(error.message); }
  }
  throw new Error(`Chromium을 실행할 수 없습니다. npx playwright install chromium 또는 CHROMIUM_EXECUTABLE_PATH/BROWSER_CHANNEL을 확인하세요.\n${attempts.join('\n')}`);
}

export async function serveRepository({ indexPath = demoPath, port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/') { response.writeHead(302, { location: indexPath }).end(); return; }
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (pathname.split('/').some(part => part.startsWith('.'))) { response.writeHead(403).end('Forbidden'); return; }
      const file = await realpath(resolve(root, `.${pathname}`));
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server;
}

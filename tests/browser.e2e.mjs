import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/examples/interpolation/index.html`);
  await page.waitForFunction(() => Number(document.querySelector('canvas').dataset.frames) >= 30);
  const first = await page.locator('canvas').getAttribute('data-x');
  await page.waitForFunction(x => document.querySelector('canvas').dataset.x !== x, first);
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'); const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { frames: Number(canvas.dataset.frames), nontransparentPixels: pixels.filter((_, i) => i % 4 === 3 && pixels[i] > 0).length };
  });
  assert.equal(errors.length, 0, errors.join('\n')); assert.ok(result.nontransparentPixels > 100);
  console.log(JSON.stringify({ browser: await browser.version(), ...result, scope: 'Headless Chromium: actual built ESM import, application rAF updates and canvas pixels. Not device/FPS certification.' }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { EXAMPLES, buildPreviews, previewURL } from '../previews.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publicMode = process.argv.includes('--public');
const names = new Set(EXAMPLES.map(([name]) => name));
let server, browser;
const report = { mode: publicMode ? 'public-htmlpreview' : 'local-standalone-html', examples: [] };
try {
  if (!publicMode) {
    await buildPreviews(root);
    server = createServer(async (req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname.slice(1).replace(/\.html$/, '');
      if (!names.has(name)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(await readFile(resolve(root, 'dist/previews', `${name}.html`)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name] of EXAMPLES) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = publicMode ? previewURL(name) : `http://127.0.0.1:${server.address().port}/${name}.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(name => {
      const globals = { interpolation: 'demo', 'interpolation-frame': 'frameDemo', 'simloop-input-preview': 'inputPreviewDemo', audio: 'audioExample', navigation: 'navigationDemo', 'rendering-vector': 'vectorExample', 'rollback-reference': 'reference', scenario: 'scenarioDemo' };
      return name === 'rollback-availability' ? typeof document.querySelector('#host')?.onclick === 'function' : !!window[globals[name]];
    }, name, { timeout: 25000 });
    if (name === 'interpolation') await page.waitForFunction(() => demo.diagnostics.frames > 5);
    if (name === 'interpolation-frame') { await page.click('#spawn'); await page.click('#rollback'); }
    if (name === 'audio') { await page.click('#tap'); await page.click('#confirmed'); assert.equal(await page.evaluate(() => audioExample.player.snapshot().state), 'running'); }
    if (name === 'navigation') { await page.click('#wiki'); await page.waitForFunction(() => document.querySelector('#screen').textContent.startsWith('wiki/')); }
    if (name === 'scenario') { await page.click('#play'); await page.waitForFunction(() => scenarioDemo.value > 7); await page.click('#stop'); }
    if (name === 'rendering-vector') assert(await page.evaluate(() => vectorExample.device.stats.drawCalls > 0 && vectorExample.device.gl.getError() === 0));
    if (name === 'rollback-reference') {
      await page.click('#start');
      await page.waitForFunction(() => reference.diagnostics.peers.length === 2 && reference.diagnostics.peers.every(p => p.tick > 5), null, { timeout: 20000 });
      await page.click('[data-player="a"][data-command="2"]');
      await page.click('#compare');
      await page.waitForFunction(() => document.querySelector('#comparison').dataset.result === 'matched', null, { timeout: 15000 });
      assert.equal(await page.evaluate(() => reference.diagnostics.connections.filter(x => x === 'connected').length), 2);
      await page.click('#stop');
    }
    assert.deepEqual(errors, [], name);
    report.examples.push({ name, status: 'PASS', url });
    await page.close();
  }
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = error.stack; throw error; }
finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(resolve(root, `test-results/previews-${publicMode ? 'public' : 'local'}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

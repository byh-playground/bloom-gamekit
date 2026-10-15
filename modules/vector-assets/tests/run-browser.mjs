import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { exerciseVectorAssets } from './runtime.browser.mjs';

const root = resolve('.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path));
if (!executablePath) throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const fallbackPage = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, deviceScaleFactor: 1 });
  const fallbackErrors = [];
  fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
  await fallbackPage.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...options) {
      if (type === 'webgl' || type === 'experimental-webgl') return null;
      return getContext.call(this, type, ...options);
    };
  });
  await fallbackPage.goto(pathToFileURL(resolve(root, 'dist/previews/vector-assets.html')).href);
  await fallbackPage.waitForFunction(() => Boolean(window.vectorAssetDemo?.sourceLoaded || window.vectorAssetDemo?.error), null, { timeout: 15000 });
  const fallback = await fallbackPage.evaluate(() => {
    const demo = window.vectorAssetDemo, svg = document.querySelector('#source-svg');
    const sourceStage = document.querySelector('#source-stage').getBoundingClientRect();
    return {
      sourceLoaded: Boolean(demo?.sourceSvg && svg?.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon').length),
      sourceVisible: Boolean(svg && getComputedStyle(svg).display !== 'none' && sourceStage.width > 0 && sourceStage.height > 0),
      sourceMetrics: document.querySelector('#source-metrics').textContent,
      webglNotice: document.querySelector('#gamekit-metrics').textContent,
      webglNoticeVisible: document.querySelector('#gamekit-metrics').closest('.panel').id === 'gamekit-stage' || document.querySelector('#gamekit-stage').closest('.panel').contains(document.querySelector('#gamekit-metrics')),
      gamekitMetrics: document.querySelector('#gamekit-metrics').textContent,
      exampleError: demo?.error ?? null,
    };
  });
  assert.equal(fallback.sourceLoaded, true, 'the remote source SVG is loaded independently before WebGL initialization: ' + JSON.stringify(fallback));
  assert.equal(fallback.sourceVisible, true, 'the source SVG remains visible in a browser with WebGL disabled: ' + JSON.stringify(fallback));
  assert.match(fallback.sourceMetrics, /SHA [a-f0-9]{12}/, 'source metrics remain available without WebGL: ' + JSON.stringify(fallback));
  assert.match(fallback.webglNotice, /WebGL unavailable/i);
  assert.equal(fallback.webglNoticeVisible, true, 'the WebGL error appears in the GameKit panel');
  assert.match(fallback.gamekitMetrics, /did not provide a WebGL 1 context/i);
  assert.equal(fallback.exampleError, 'WebGL 1 required');
  if (fallbackErrors.length) throw new Error('WebGL-unavailable page errors: ' + fallbackErrors.join('; '));
  await fallbackPage.close();

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(resolve(root, 'dist/previews/vector-assets.html')).href);
  await page.waitForFunction(() => Boolean(window.vectorAssetDemo?.ready || window.vectorAssetDemo?.error), null, { timeout: 15000 });
  const exampleError = await page.evaluate(() => window.vectorAssetDemo?.error ?? null);
  if (exampleError) throw new Error('Example initialization failed: ' + exampleError);
  const report = await exerciseVectorAssets(page);
  if (errors.length) throw new Error('Browser page errors: ' + errors.join('; '));
  console.log(JSON.stringify({ ...report, fallback, browser: await browser.version(), execution: 'file:// standalone HTML; direct raw.githubusercontent.com SVG fetch; Chromium WebGL1 / SwiftShader and WebGL-disabled fallback' }, null, 2));
  await page.close();
} finally {
  await browser.close();
}

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { exerciseVectorAssets } from './runtime.browser.mjs';
import { exerciseRendererInterleaving } from '../../rendering/tests/interop.browser.mjs';
import { exerciseOrderedAssetBatch } from '../../rendering/tests/ordered-batch.browser.mjs';
import { exerciseMeshDepth } from '../../rendering/tests/mesh-depth.browser.mjs';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseNonScalingStroke } from './non-scaling-stroke.browser.mjs';

const root = resolve('.');
const sourceURL = 'https://raw.githubusercontent.com/byh-playground/bloom-gamekit/main/modules/vector-assets/assets/seed-scout.svg';
const sourceBytes = await readFile(resolve(root, 'modules/vector-assets/assets/seed-scout.svg'));
const renderingBundle = await readFile(resolve(root, 'dist/rendering.js'));
const renderingModuleURL = 'data:text/javascript;base64,' + renderingBundle.toString('base64');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path));
if (!executablePath) throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const fallbackPage = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, deviceScaleFactor: 1 });
  await fallbackPage.route(sourceURL, route => route.fulfill({ status: 200, contentType: 'image/svg+xml; charset=utf-8', body: sourceBytes }));
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
  await page.route(sourceURL, route => route.fulfill({ status: 200, contentType: 'image/svg+xml; charset=utf-8', body: sourceBytes }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(resolve(root, 'dist/previews/vector-assets.html')).href);
  await page.waitForFunction(() => Boolean(window.vectorAssetDemo?.ready || window.vectorAssetDemo?.error), null, { timeout: 15000 });
  const exampleError = await page.evaluate(() => window.vectorAssetDemo?.error ?? null);
  if (exampleError) throw new Error('Example initialization failed: ' + exampleError);
  const report = await exerciseVectorAssets(page);
  report.rendererInterleaving = await exerciseRendererInterleaving(page, renderingModuleURL);
  assert.deepEqual(report.rendererInterleaving.red2d, [255, 0, 0, 255]);
  assert.deepEqual(report.rendererInterleaving.blueMesh, [0, 0, 255, 255]);
  assert.deepEqual(report.rendererInterleaving.green2d, [0, 255, 0, 255]);
  assert.equal(report.rendererInterleaving.glError, 0);
  report.orderedAssetBatch = await exerciseOrderedAssetBatch(page, renderingModuleURL);
  assert.equal(report.orderedAssetBatch.pixelMismatch, 0);
  assert.equal(report.orderedAssetBatch.batched.draws, 1);
  report.meshDepth = await exerciseMeshDepth(page, renderingModuleURL);
  const nonScalingAsset = await compileVectorAssetFile(resolve(root, 'modules/vector-assets/tests/non-scaling-stroke.svg'));
  const evidenceDirectory = resolve(root, '..', 'evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  const nonScalingEvidence = resolve(evidenceDirectory, 'non-scaling-stroke-webgl.png');
  report.nonScalingStroke = await exerciseNonScalingStroke(browser, renderingModuleURL, {
    ...nonScalingAsset.geometry,
    vertices: Array.from(nonScalingAsset.geometry.vertices),
    indices: Array.from(nonScalingAsset.geometry.indices),
  }, nonScalingEvidence);
  report.nonScalingStroke.evidencePath = nonScalingEvidence;
  await page.locator('#style-comparison').click();
  await page.waitForFunction(() => window.vectorAssetDemo?.styleReady || window.vectorAssetDemo?.styleError, null, { timeout: 15000 });
  const styleError = await page.evaluate(() => window.vectorAssetDemo?.styleError ?? null);
  if (styleError) throw new Error('Style sample initialization failed: ' + styleError);
  const styles = await page.evaluate(() => {
    const demo = window.vectorAssetDemo;
    const sample = time => {
      for (const item of demo.styleInstances) item.actor.seek(time);
      return JSON.stringify(demo.styleInstances.map(item => item.actor.partPoses()));
    };
    const first = sample(987.5), middle = sample(2100), repeated = sample(987.5);
    const sketch = demo.styleInstances.find(item => item.id === 'sketch-fox');
    const morphAt = time => { sketch.actor.seek(time); return sketch.actor.partPoses().map(pose => pose.morph); };
    const morphFirst = morphAt(987.5), morphLater = morphAt(2100), morphRepeated = morphAt(987.5);
    demo.renderStyleSamples(987.5);
    const canvases = [...document.querySelectorAll('#style-dialog canvas')];
    const result = {
      opened: document.querySelector('#style-dialog').open,
      ids: demo.styleInstances.map(item => item.id),
      sameSourceBytes: demo.styleInstances.map(item => item.sourceSha),
      visibleSources: ['#style-yarn-source svg', '#style-sketch-source svg'].map(selector => Boolean(document.querySelector(selector))),
      renderedCanvases: canvases.length,
      actualWebGL: demo.styleInstances.every(item => item.device.state === 'ready' && item.meshes.stats().draws > 0),
      deterministicAbsoluteSeek: first === repeated,
      changedBetweenSamples: first !== middle,
      deterministicPartMorphSeek: JSON.stringify(morphFirst) === JSON.stringify(morphRepeated),
      partMorphChangesWithDisplayTime: JSON.stringify(morphFirst) !== JSON.stringify(morphLater),
      partMorphWeights: morphFirst,
      morphCounts: demo.styleInstances.map(item => item.asset.mesh.morphCount),
      metrics: ['#style-yarn-metrics', '#style-sketch-metrics'].map(selector => document.querySelector(selector).textContent),
    };
    return result;
  });
  assert.deepEqual(styles.ids, ['yarn-fox', 'sketch-fox']);
  assert.deepEqual(styles.visibleSources, [true, true], 'each source SVG appears beside its compiled GameKit render');
  assert.equal(styles.renderedCanvases, 2);
  assert.equal(styles.actualWebGL, true, 'both authored style samples render through GameKit WebGL');
  assert.equal(styles.deterministicAbsoluteSeek, true, 'rollback/seek recreates the exact same authored pose');
  assert.equal(styles.changedBetweenSamples, true, 'the authored clip changes as display time moves');
  assert.equal(styles.deterministicPartMorphSeek, true, 'part-level morph weights reproduce after rollback seek');
  assert.equal(styles.partMorphChangesWithDisplayTime, true, 'part-level morph weights follow absolute display time');
  assert.deepEqual(styles.morphCounts, [0, 2], 'only the sketch clip declares two fixed-topology targets');
  report.styles = styles;
  await page.locator('#style-dialog-close').click();
  const disposed = await page.evaluate(() => {
    const demo = window.vectorAssetDemo, oldDevices = demo.styleInstances.map(item => item.device);
    demo.disposeStyleSamples();
    return { states: oldDevices.map(device => device.state), liveAssets: demo.styleInstances.length };
  });
  assert.deepEqual(disposed.states, ['disposed', 'disposed']);
  assert.equal(disposed.liveAssets, 0);
  await page.locator('#style-comparison').click();
  await page.waitForFunction(() => window.vectorAssetDemo?.styleReady || window.vectorAssetDemo?.styleError, null, { timeout: 15000 });
  const recreated = await page.evaluate(() => ({
    count: window.vectorAssetDemo.styleInstances.length,
    devicesReady: window.vectorAssetDemo.styleInstances.every(item => item.device.state === 'ready'),
  }));
  assert.deepEqual(recreated, { count: 2, devicesReady: true }, 'style assets recreate after clean disposal');
  report.stylesLifecycle = { disposed, recreated };
  if (errors.length) throw new Error('Browser page errors: ' + errors.join('; '));
  console.log(JSON.stringify({ ...report, fallback, browser: await browser.version(), execution: 'file:// standalone HTML; browser fetch served the exact committed source SVG bytes for offline determinism; Chromium WebGL1 / SwiftShader and WebGL-disabled fallback' }, null, 2));
  await page.close();
} finally {
  await browser.close();
}

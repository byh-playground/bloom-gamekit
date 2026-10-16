import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseWorldVectorRendering } from './world-rendering.browser.mjs';

const root = resolve('.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path))
  ?? chromium.executablePath();
const asset = await compileVectorAssetFile(resolve(root, 'modules/vector-assets/tests/world-shader.svg'));
const geometry = asset.geometry;
const compiled = { ...asset, geometry: { ...geometry,
  vertices: Array.from(geometry.vertices), indices: Array.from(geometry.indices),
  expressionIndices: Object.fromEntries(Object.entries(geometry.expressionIndices ?? {}).map(([key, value]) => [key, Array.from(value)])),
  indexVariants: Object.fromEntries(Object.entries(geometry.indexVariants ?? {}).map(([key, value]) => [key, Array.from(value)])),
  shaderSurfaces: geometry.shaderSurfaces?.map(surface => ({ ...surface,
    fillVertices: Array.from(surface.fillVertices), outline: Array.from(surface.outline), edgeColors: Array.from(surface.edgeColors),
  })),
} };
const renderingBundle = await readFile(resolve(root, 'dist/rendering.js'));
const vectorAssetsBundle = await readFile(resolve(root, 'dist/vector-assets.js'));
const renderingURL = 'data:text/javascript;base64,' + renderingBundle.toString('base64');
const vectorAssetsURL = 'data:text/javascript;base64,' + vectorAssetsBundle.toString('base64');
const evidenceDirectory = resolve(root, '..', 'evidence');
await mkdir(evidenceDirectory, { recursive: true });
const screenshotPath = resolve(evidenceDirectory, 'digmory-world-vector.png');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const result = await exerciseWorldVectorRendering(browser, renderingURL, vectorAssetsURL, compiled, screenshotPath);
  console.log(JSON.stringify({ ...result, browser: await browser.version(), execution: 'headless Chromium WebGL 1 / SwiftShader' }, null, 2));
} finally {
  await browser.close();
}

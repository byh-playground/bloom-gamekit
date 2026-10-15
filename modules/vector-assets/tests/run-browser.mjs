import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exerciseVectorAssets } from './runtime.browser.mjs';

const root = resolve('.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => existsSync(path));
if (!executablePath) throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://raw.githubusercontent.com/byh-playground/bloom-gamekit/main/modules/vector-assets/assets/seed-scout.svg', async route => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: await readFile(resolve(root, 'modules/vector-assets/assets/seed-scout.svg')) });
  });
  await page.goto(pathToFileURL(resolve(root, 'dist/previews/vector-assets.html')).href);
  await page.waitForFunction(() => Boolean(window.vectorAssetDemo?.ready || window.vectorAssetDemo?.error), null, { timeout: 15000 });
  const exampleError = await page.evaluate(() => window.vectorAssetDemo?.error ?? null);
  if (exampleError) throw new Error('Example initialization failed: ' + exampleError);
  const report = await exerciseVectorAssets(page);
  if (errors.length) throw new Error('Browser page errors: ' + errors.join('; '));
  console.log(JSON.stringify({ ...report, browser: await browser.version(), execution: 'file:// standalone HTML with Chromium WebGL1 / SwiftShader' }, null, 2));
  await page.close();
} finally {
  await browser.close();
}

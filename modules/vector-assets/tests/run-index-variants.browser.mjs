import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compiledAsset } from './fixtures/squish-pr15-enemy-boss.js';
import { exercisePr15IndexVariants } from './index-variants.browser.mjs';

const root = resolve('.');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!executablePath) throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const renderingBundle = await readFile(resolve(root, 'dist/rendering.js'));
const moduleURL = 'data:text/javascript;base64,' + renderingBundle.toString('base64');
const { vertices, indices, partCount } = compiledAsset.geometry;
const expressionIndices = {};
for (const [name, expression] of Object.entries(compiledAsset.metadata.expressions)) {
  const visible = compiledAsset.metadata.parts.map(() => true);
  const parts = new Map(compiledAsset.metadata.parts.map((part, index) => [part.id, index]));
  for (const id of expression.show) visible[parts.get(id)] = true;
  for (const id of expression.hide) visible[parts.get(id)] = false;
  const retained = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2], part = vertices[a * 11 + 10];
    if (vertices[b * 11 + 10] !== part || vertices[c * 11 + 10] !== part) throw new Error('Fixture triangle crosses an authored part boundary.');
    if (visible[part]) retained.push(a, b, c);
  }
  expressionIndices[name] = Array.from(retained);
}
const input = {
  vertices: Array.from(vertices), indices: Array.from(indices), partCount,
  expressionIndices,
  indexVariants: Object.fromEntries(Object.entries(compiledAsset.geometry.expressionIndices).map(([name, value]) => [name, Array.from(value)])),
  paintOrder: compiledAsset.paintOrder,
};
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const report = await exercisePr15IndexVariants(page, moduleURL, input);
  console.log(JSON.stringify({ ...report, browser: executablePath }, null, 2));
  await page.close();
} finally {
  await browser.close();
}

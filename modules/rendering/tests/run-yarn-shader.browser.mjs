import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { exerciseYarnShader } from './yarn-shader.browser.mjs';
const ROOT = resolve('.');
const EXECUTABLE_PATH =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
if (!EXECUTABLE_PATH) {
    throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
}
const RENDERING_BUNDLE = await readFile(resolve(ROOT, 'dist/rendering.js'));
const MODULE_URL = 'data:text/javascript;base64,' + RENDERING_BUNDLE.toString('base64');
const EVIDENCE_DIRECTORY = resolve(ROOT, '..', 'evidence');
await mkdir(EVIDENCE_DIRECTORY, {
    recursive: true,
});
const SCREENSHOT_PATH = resolve(EVIDENCE_DIRECTORY, 'yarn-surface-shader-47-74.png');
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const RESULT = await exerciseYarnShader(BROWSER, MODULE_URL, SCREENSHOT_PATH);
    console.log(JSON.stringify(RESULT, null, 2));
} finally {
    await BROWSER.close();
}

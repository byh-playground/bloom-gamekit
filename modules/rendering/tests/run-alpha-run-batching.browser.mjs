import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { exerciseAlphaRunBatching } from './alpha-run-batching.browser.mjs';
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
const BUNDLE = await readFile(resolve(ROOT, 'dist/rendering.js'));
const MODULE_URL = 'data:text/javascript;base64,' + BUNDLE.toString('base64');
const EVIDENCE_DIRECTORY = resolve(ROOT, 'evidence');
await mkdir(EVIDENCE_DIRECTORY, {
    recursive: true,
});
const SCREENSHOT_PATH = resolve(EVIDENCE_DIRECTORY, 'alpha-run-batching-overlap-disjoint.png');
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const RESULT = await exerciseAlphaRunBatching(BROWSER, MODULE_URL, SCREENSHOT_PATH);
    console.log(
        JSON.stringify(
            {
                ...RESULT,
                screenshotPath: SCREENSHOT_PATH,
            },
            null,
            2,
        ),
    );
} finally {
    await BROWSER.close();
}

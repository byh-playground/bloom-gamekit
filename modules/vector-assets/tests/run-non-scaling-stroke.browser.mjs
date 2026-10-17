import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseNonScalingStroke } from './non-scaling-stroke.browser.mjs';
const ROOT = resolve('.');
const EXECUTABLE_PATH =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((path) => existsSync(path));
if (!EXECUTABLE_PATH) {
    throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
}
const ASSET = await compileVectorAssetFile(resolve(ROOT, 'modules/vector-assets/tests/non-scaling-stroke.svg'));
const GEOMETRY = {
    ...ASSET.geometry,
    vertices: Array.from(ASSET.geometry.vertices),
    indices: Array.from(ASSET.geometry.indices),
};
const RENDERING_BUNDLE = await readFile(resolve(ROOT, 'dist/rendering.js'));
const MODULE_URL = 'data:text/javascript;base64,' + RENDERING_BUNDLE.toString('base64');
const EVIDENCE_DIRECTORY = resolve(ROOT, '..', 'evidence');
await mkdir(EVIDENCE_DIRECTORY, {
    recursive: true,
});
const SCREENSHOT_PATH = resolve(EVIDENCE_DIRECTORY, 'non-scaling-stroke-webgl.png');
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const RESULT = await exerciseNonScalingStroke(BROWSER, MODULE_URL, GEOMETRY, SCREENSHOT_PATH);
    console.log(
        JSON.stringify(
            {
                ...RESULT,
                evidencePath: SCREENSHOT_PATH,
            },
            null,
            2,
        ),
    );
} finally {
    await BROWSER.close();
}

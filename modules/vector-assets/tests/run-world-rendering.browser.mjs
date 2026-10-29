import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseWorldVectorRendering } from './world-rendering.browser.mjs';
const ROOT = resolve('.');
const EXECUTABLE_PATH =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((path) => existsSync(path)) ??
    chromium.executablePath();
const ASSET = await compileVectorAssetFile(resolve(ROOT, 'modules/vector-assets/tests/world-shader.svg'));
const GEOMETRY = ASSET.geometry;
const COMPILED = {
    ...ASSET,
    geometry: {
        ...GEOMETRY,
        vertices: Array.from(GEOMETRY.vertices),
        indices: Array.from(GEOMETRY.indices),
        expressionIndices: Object.fromEntries(
            Object.entries(GEOMETRY.expressionIndices ?? {}).map(([key, value]) => [key, Array.from(value)]),
        ),
        indexVariants: Object.fromEntries(
            Object.entries(GEOMETRY.indexVariants ?? {}).map(([key, value]) => [key, Array.from(value)]),
        ),
        materials: GEOMETRY.materials
            ? { vertices: Array.from(GEOMETRY.materials.vertices), table: Array.from(GEOMETRY.materials.table) }
            : undefined,
    },
};
const RENDERING_BUNDLE = await readFile(resolve(ROOT, 'dist/rendering.js'));
const VECTOR_ASSETS_BUNDLE = await readFile(resolve(ROOT, 'dist/vector-assets.js'));
const RENDERING_URL = 'data:text/javascript;base64,' + RENDERING_BUNDLE.toString('base64');
const VECTOR_ASSETS_URL = 'data:text/javascript;base64,' + VECTOR_ASSETS_BUNDLE.toString('base64');
const EVIDENCE_DIRECTORY = resolve(ROOT, '..', 'evidence');
await mkdir(EVIDENCE_DIRECTORY, {
    recursive: true,
});
const SCREENSHOT_PATH = resolve(EVIDENCE_DIRECTORY, 'digmory-world-vector.png');
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const RESULT = await exerciseWorldVectorRendering(
        BROWSER,
        RENDERING_URL,
        VECTOR_ASSETS_URL,
        COMPILED,
        SCREENSHOT_PATH,
    );
    console.log(
        JSON.stringify(
            {
                ...RESULT,
                browser: await BROWSER.version(),
                execution: 'headless Chromium WebGL 1 / SwiftShader',
            },
            null,
            2,
        ),
    );
} finally {
    await BROWSER.close();
}

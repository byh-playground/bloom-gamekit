import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compiledAsset } from './fixtures/squish-pr15-enemy-boss.js';
import { exercisePr15IndexVariants } from './index-variants.browser.mjs';
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
const { vertices: VERTICES, indices: INDICES, partCount: PART_COUNT } = compiledAsset.geometry;
const EXPRESSION_INDICES = {};
for (const [NAME, EXPRESSION] of Object.entries(compiledAsset.metadata.expressions)) {
    const VISIBLE = compiledAsset.metadata.parts.map(() => true);
    const PARTS = new Map(compiledAsset.metadata.parts.map((part, index) => [part.id, index]));
    for (const ID of EXPRESSION.show) {
        VISIBLE[PARTS.get(ID)] = true;
    }
    for (const ID of EXPRESSION.hide) {
        VISIBLE[PARTS.get(ID)] = false;
    }
    const RETAINED = [];
    for (let offset = 0; offset < INDICES.length; offset += 3) {
        const A = INDICES[offset],
            B = INDICES[offset + 1],
            C = INDICES[offset + 2],
            PART = VERTICES[A * 11 + 10];
        if (VERTICES[B * 11 + 10] !== PART || VERTICES[C * 11 + 10] !== PART) {
            throw new Error('Fixture triangle crosses an authored part boundary.');
        }
        if (VISIBLE[PART]) {
            RETAINED.push(A, B, C);
        }
    }
    EXPRESSION_INDICES[NAME] = Array.from(RETAINED);
}
const INPUT = {
    vertices: Array.from(VERTICES),
    indices: Array.from(INDICES),
    partCount: PART_COUNT,
    expressionIndices: EXPRESSION_INDICES,
    indexVariants: Object.fromEntries(
        Object.entries(compiledAsset.geometry.expressionIndices).map(([name, value]) => [name, Array.from(value)]),
    ),
    paintOrder: compiledAsset.paintOrder,
};
const BROWSER = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
    const PAGE = await BROWSER.newPage();
    await PAGE.goto('about:blank');
    const REPORT = await exercisePr15IndexVariants(PAGE, MODULE_URL, INPUT);
    console.log(
        JSON.stringify(
            {
                ...REPORT,
                browser: EXECUTABLE_PATH,
            },
            null,
            2,
        ),
    );
    await PAGE.close();
} finally {
    await BROWSER.close();
}

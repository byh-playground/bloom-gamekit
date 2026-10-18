/* global audioExample, demo, reference, scenarioDemo, vectorExample */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { EXAMPLES, buildPreviews, previewURL } from '../previews.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_MODE = process.argv.includes('--public');
const NAMES = new Set(EXAMPLES.map(([name]) => name));
let server;
let browser;
const REPORT = {
    mode: PUBLIC_MODE ? 'public-htmlpreview' : 'local-standalone-html',
    examples: [],
};
try {
    if (!PUBLIC_MODE) {
        await buildPreviews(ROOT);
        server = createServer(async (req, res) => {
            const NAME = new URL(req.url, 'http://localhost').pathname.slice(1).replace(/\.html$/, '');
            if (!NAMES.has(NAME)) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await readFile(resolve(ROOT, 'dist/previews', `${NAME}.html`)));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    }
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : {}),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const [NAME] of EXAMPLES) {
        const PAGE = await browser.newPage();
        const ERRORS = [];
        PAGE.on('pageerror', (error) => ERRORS.push(error.message));
        const URL_LOCAL = PUBLIC_MODE ? previewURL(NAME) : `http://127.0.0.1:${server.address().port}/${NAME}.html`;
        await PAGE.goto(URL_LOCAL, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
        });
        await PAGE.waitForFunction(
            (name) => {
                const GLOBALS = {
                    interpolation: 'demo',
                    'interpolation-frame': 'frameDemo',
                    'simloop-input-preview': 'inputPreviewDemo',
                    audio: 'audioExample',
                    navigation: 'navigationDemo',
                    'rendering-vector': 'vectorExample',
                    'vector-assets': 'vectorAssetDemo',
                    'rollback-reference': 'reference',
                    scenario: 'scenarioDemo',
                    'pixel-physics': 'pixelPhysicsExample',
                };
                if (name === 'work-scheduler') {
                    return !!document.querySelector('#output')?.textContent;
                }
                return name === 'rollback-availability'
                    ? typeof document.querySelector('#host')?.onclick === 'function'
                    : !!window[GLOBALS[name]];
            },
            NAME,
            {
                timeout: 25000,
            },
        );
        if (NAME === 'interpolation') {
            await PAGE.waitForFunction(() => demo.diagnostics.frames > 5);
        }
        if (NAME === 'work-scheduler') {
            await PAGE.click('#tick');
            assert.equal(await PAGE.locator('#output').evaluate((output) => JSON.parse(output.textContent).tick), 1);
        }
        if (NAME === 'interpolation-frame') {
            await PAGE.click('#spawn');
            await PAGE.click('#rollback');
        }
        if (NAME === 'audio') {
            await PAGE.click('#tap');
            await PAGE.click('#confirmed');
            assert.equal(await PAGE.evaluate(() => audioExample.player.snapshot().state), 'running');
        }
        if (NAME === 'navigation') {
            await PAGE.click('#wiki');
            await PAGE.waitForFunction(() => document.querySelector('#screen').textContent.startsWith('wiki/'));
        }
        if (NAME === 'scenario') {
            await PAGE.click('#play');
            await PAGE.waitForFunction(() => scenarioDemo.value > 7);
            await PAGE.click('#stop');
        }
        if (NAME === 'rendering-vector') {
            assert(
                await PAGE.evaluate(
                    () => vectorExample.device.stats.drawCalls > 0 && vectorExample.device.gl.getError() === 0,
                ),
            );
        }
        if (NAME === 'rollback-reference') {
            await PAGE.click('#start');
            await PAGE.waitForFunction(
                () => reference.diagnostics.peers.length === 2 && reference.diagnostics.peers.every((p) => p.tick > 5),
                null,
                {
                    timeout: 20000,
                },
            );
            await PAGE.click('[data-player="a"][data-command="2"]');
            await PAGE.click('#compare');
            await PAGE.waitForFunction(() => document.querySelector('#comparison').dataset.result === 'matched', null, {
                timeout: 15000,
            });
            assert.equal(
                await PAGE.evaluate(() => reference.diagnostics.connections.filter((x) => x === 'connected').length),
                2,
            );
            await PAGE.click('#stop');
        }
        assert.deepEqual(ERRORS, [], NAME);
        REPORT.examples.push({
            name: NAME,
            status: 'PASS',
            url: URL_LOCAL,
        });
        await PAGE.close();
    }
    REPORT.status = 'PASS';
} catch (error) {
    REPORT.status = 'FAIL';
    REPORT.error = error.stack;
    throw error;
} finally {
    await browser?.close();
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await mkdir(resolve(ROOT, 'test-results'), {
        recursive: true,
    });
    await writeFile(
        resolve(ROOT, `test-results/previews-${PUBLIC_MODE ? 'public' : 'local'}.json`),
        JSON.stringify(REPORT, null, 2),
    );
    console.log(JSON.stringify(REPORT));
}

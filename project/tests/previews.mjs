/* global audioExample, demo, reference, scenarioDemo, renderingExamples */
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
    mode: PUBLIC_MODE ? 'public-htmlpreview' : 'local-html',
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
                    rendering: 'renderingExamples',
                    'vector-assets': 'vectorAssetDemo',
                    'vector-raster-comparison': '__rasterComparison',
                    'rollback-reference': 'reference',
                    scenario: 'scenarioDemo',
                    'pixel-physics': 'pixelPhysicsExample',
                    'pixel-physics-open-world': 'openWorldExample',
                    bm: 'bmExample',
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
        if (NAME === 'vector-raster-comparison') {
            await PAGE.waitForFunction(() => globalThis.__rasterComparison.ready);
            assert.equal(await PAGE.evaluate(() => globalThis.__rasterComparison.error), null);
            assert.equal(await PAGE.evaluate(() => globalThis.__rasterComparison.snapshot.count), 1);
        }
        if (NAME === 'work-scheduler') {
            await PAGE.click('#tick');
            assert.equal(await PAGE.locator('#output').evaluate((output) => JSON.parse(output.textContent).tick), 1);
        }
        if (NAME === 'bm') {
            // 실제 Google 호출 없이 계약만 확인합니다: 광고 스크립트는 막고 adBreak를 가짜로 둡니다.
            const READ = (page) => page.locator('#output').evaluate((output) => JSON.parse(output.textContent));
            const FAKE_ADS = () => {
                globalThis.adConfig = (options) => options.onReady?.();
                globalThis.adBreak = (options) => {
                    if (options.type === 'reward') {
                        options.beforeReward(() => {
                            options.beforeAd();
                            options.adViewed();
                            options.adBreakDone({ breakStatus: 'viewed' });
                        });
                    } else {
                        options.beforeAd();
                        options.adBreakDone({ breakStatus: 'viewed' });
                    }
                };
            };
            for (const TOUCH of [false, true]) {
                const CONTEXT = await browser.newContext(
                    TOUCH ? { hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } } : {},
                );
                await CONTEXT.route('https://pagead2.googlesyndication.com/**', (route) => route.fulfill({ body: '' }));
                const BM_PAGE = await CONTEXT.newPage();
                await BM_PAGE.addInitScript(FAKE_ADS);
                await BM_PAGE.goto(URL_LOCAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await BM_PAGE.waitForFunction(() => !!window.bmExample);
                const PRESS = (selector) => (TOUCH ? BM_PAGE.tap(selector) : BM_PAGE.click(selector));
                assert.equal(await BM_PAGE.locator('#rewarded').isDisabled(), true);
                await BM_PAGE.fill('#publisher', 'not-an-id');
                await PRESS('#connect');
                assert.equal(await BM_PAGE.locator('#rewarded').isDisabled(), true);
                await BM_PAGE.fill('#publisher', 'ca-pub-1234567890');
                await PRESS('#connect');
                await BM_PAGE.waitForFunction(
                    () => JSON.parse(document.querySelector('#output').textContent).sdkReady === true,
                );
                assert.equal(
                    await BM_PAGE.evaluate(() => !!document.querySelector('script[data-adbreak-test="on"]')),
                    true,
                );
                await PRESS('#rewarded');
                await BM_PAGE.waitForFunction(
                    () => JSON.parse(document.querySelector('#output').textContent).rewards === 1,
                );
                await PRESS('#interstitial');
                await BM_PAGE.waitForFunction(
                    () => JSON.parse(document.querySelector('#output').textContent).last?.type === 'interstitial',
                );
                assert.equal((await READ(BM_PAGE)).shown.interstitial, 1);
                assert.equal(
                    await BM_PAGE.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                    true,
                );
                if (TOUCH) {
                    // 터치 에뮬레이션은 실제 기기 검증이 아닙니다.
                    assert.equal(
                        await BM_PAGE.locator('#rewarded').evaluate(
                            (button) => button.getBoundingClientRect().height >= 56,
                        ),
                        true,
                    );
                }
                await CONTEXT.close();
            }
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
        if (NAME === 'rendering') {
            assert(
                await PAGE.evaluate(
                    () =>
                        renderingExamples.vector.device.stats.drawCalls > 0 &&
                        renderingExamples.vector.device.gl.getError() === 0,
                ),
            );
            await PAGE.click('#tab-atlas');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.atlas));
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.drawCalls), 1);
            await PAGE.click('#atlas-mixed');
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.drawCalls), 1);
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.device.gl.getError()), 0);
            await PAGE.click('#tab-materials');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.materials));
            assert.equal(await PAGE.evaluate(() => renderingExamples.materials.draws), 1);
            await PAGE.click('#tab-paint');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.paint));
            assert.equal(await PAGE.evaluate(() => renderingExamples.paint.device.gl.getError()), 0);
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

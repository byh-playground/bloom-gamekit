import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

/** Exercises the quality controls in the published three-view vector example. */
export async function exerciseVectorAssetQualityExample(
    page,
    previewURL,
    screenshotPath = 'test-results/vector-assets-quality-farmpea.png',
) {
    const FIXTURE_PATH = 'modules/vector-assets/assets/seed-scout.svg';
    const FIXTURE_BYTES = await readFile(FIXTURE_PATH);
    const EXPECTED_SHA256 = createHash('sha256').update(FIXTURE_BYTES).digest('hex');
    const FARMPEA_URL =
        'https://raw.githubusercontent.com/byh-playground/budmori-io/69b267960252e009e754ae1aa38b03bfa0329d4f/assets/troops/pea.svg';
    const FARMPEA_SHA256 = 'f3f3d480579373ba7fe4bb7961de59c80b81db6cf08153d75ebe842d0845ce1e';
    const BLOB_URL =
        'https://github.com/byh-playground/bloom-gamekit/blob/main/modules/vector-assets/assets/seed-scout.svg';
    const RAW_URL =
        'https://raw.githubusercontent.com/byh-playground/bloom-gamekit/main/modules/vector-assets/assets/seed-scout.svg';
    await page.route(RAW_URL, (route) =>
        route.fulfill({
            status: 200,
            headers: {
                'access-control-allow-origin': '*',
                'content-type': 'image/svg+xml',
            },
            body: FIXTURE_BYTES,
        }),
    );

    // Verify the actual public default URL, rather than substituting local test bytes.
    await page.goto(previewURL);
    await page.waitForFunction(() => window.vectorAssetDemo?.ready, null, {
        timeout: 30000,
    });
    const FARMPEA = await page.evaluate(() => ({
        sourceLoaded: window.vectorAssetDemo.sourceLoaded,
        sourceUrl: window.vectorAssetDemo.sourceUrl,
        sourceSha256: window.vectorAssetDemo.sourceSha256,
        metadataId: window.vectorAssetDemo.compiledAsset?.metadata?.id,
        curveSegments: window.vectorAssetDemo.compiledAsset?.compilerOptions?.curveSegments,
        strokeArcDivisions: window.vectorAssetDemo.compiledAsset?.compilerOptions?.strokeArcDivisions,
        triangles: window.vectorAssetDemo.topology.triangles,
        sourceSvgPresent: Boolean(document.querySelector('#source-svg')),
        sourceShapeCount: document.querySelectorAll(
            '#source-svg path, #source-svg rect, #source-svg circle, #source-svg ellipse, #source-svg line, #source-svg polyline, #source-svg polygon',
        ).length,
        error: window.vectorAssetDemo.error || document.querySelector('#status').textContent,
    }));
    assert.equal(FARMPEA.sourceLoaded, true, 'the real public Farmpea URL loads through browser CORS');
    assert.equal(FARMPEA.sourceUrl, FARMPEA_URL);
    assert.equal(FARMPEA.sourceSha256, FARMPEA_SHA256, 'the public SVG bytes match the immutable original');
    assert.equal(FARMPEA.metadataId, 'budmori-pea');
    assert.equal(FARMPEA.curveSegments, 4);
    assert.equal(FARMPEA.strokeArcDivisions, 2);
    assert.equal(FARMPEA.sourceSvgPresent, true, 'the sanitized original SVG is displayed in the source panel');
    assert.ok(FARMPEA.sourceShapeCount > 0, 'the source panel contains actual sanitized SVG shapes');
    await mkdir('test-results', {
        recursive: true,
    });
    await page.screenshot({
        path: screenshotPath,
        fullPage: true,
    });

    // Use a deterministic local fixture for the tessellation interaction comparisons.
    await page.goto(previewURL + '?fixture=seed-scout');
    await page.waitForFunction(() => window.vectorAssetDemo?.ready && window.vectorAssetDemo?.sourceLoaded, null, {
        timeout: 15000,
    });
    const INITIAL = await page.evaluate(() => ({
        sourceSha256: window.vectorAssetDemo.sourceSha256,
        triangles: window.vectorAssetDemo.topology.triangles,
        curveSegments: window.vectorAssetDemo.compiledAsset.compilerOptions.curveSegments,
        strokeArcDivisions: window.vectorAssetDemo.compiledAsset.compilerOptions.strokeArcDivisions,
    }));
    assert.equal(INITIAL.sourceSha256, EXPECTED_SHA256, 'the sample source is rendered from the exact fixture bytes');
    assert.equal(INITIAL.curveSegments, 4, 'the initial curve preset is the shared standard 4/2 setting');
    const SHARED_PRESETS = await page.evaluate(() => window.vectorAssetRuntime.VECTOR_ASSET_QUALITY_PRESETS);
    assert.deepEqual(
        SHARED_PRESETS,
        {
            standard: {
                curveSegments: 4,
                strokeArcDivisions: 2,
            },
            smallAsset: {
                curveSegments: 2,
                strokeArcDivisions: 2,
            },
        },
        'the browser example consumes the shared named quality presets',
    );
    await page.locator('[data-quality-preset="smallAsset"]').click();
    await page.waitForFunction(
        () =>
            window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 2 &&
            window.vectorAssetDemo?.compiledAsset?.compilerOptions?.strokeArcDivisions === 2,
        null,
        {
            timeout: 15000,
        },
    );
    await page.locator('[data-quality-preset="standard"]').click();
    await page.waitForFunction(
        () =>
            window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 4 &&
            window.vectorAssetDemo?.compiledAsset?.compilerOptions?.strokeArcDivisions === 2,
        null,
        {
            timeout: 15000,
        },
    );
    const PRESET_VALUES = await page
        .locator('.quality-presets')
        .evaluateAll((groups) =>
            groups.map((group) => [...group.querySelectorAll('button')].map((button) => button.dataset.qualityValue)),
        );
    assert.deepEqual(
        PRESET_VALUES,
        [
            ['1', '2', '4', '8', '16'],
            ['1', '2', '4', '8', '16'],
        ],
        'both numeric controls offer the same five quick presets',
    );
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#asset-url').fill(BLOB_URL);
    await page.locator('#load-asset').click();
    await page.waitForFunction(
        (raw) =>
            window.vectorAssetDemo?.sourceUrl === raw &&
            window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 4,
        RAW_URL,
        {
            timeout: 15000,
        },
    );
    await page.locator('#curve-segments').fill('3');
    assert.equal(
        await page.locator('#curve-segments').inputValue(),
        '3',
        'the number control accepts direct typed input',
    );
    await page.locator('#load-asset').click();
    await page.waitForFunction(
        () => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 3,
        null,
        {
            timeout: 15000,
        },
    );
    const COPY = await page.evaluate(async () => {
        document.querySelector('#copy-loader-options').click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
            status: document.querySelector('#status').textContent,
            text: await navigator.clipboard.readText(),
        };
    });
    assert.match(COPY.status, /Loader options copied/);
    const COPIED_OPTIONS = JSON.parse(COPY.text);
    assert.equal(COPIED_OPTIONS.sourcePath, RAW_URL, 'GitHub blob URL is normalized to the matching raw URL');
    assert.equal(COPIED_OPTIONS.maxBytes, 512 * 1024);
    assert.equal(COPIED_OPTIONS.curveSegments, 3, 'copy reflects the typed tessellation value');
    assert.equal(COPIED_OPTIONS.strokeArcDivisions, 2);
    const TYPED = await page.evaluate(() => ({
        triangles: window.vectorAssetDemo.topology.triangles,
        curveSegments: window.vectorAssetDemo.compiledAsset.compilerOptions.curveSegments,
    }));
    assert.equal(TYPED.curveSegments, 3);
    assert.ok(TYPED.triangles > 0, 'a low typed quality still produces inspectable geometry');
    await page.locator('[data-quality-target="curve-segments"][data-quality-value="16"]').click();
    await page.waitForFunction(
        () => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 16,
        null,
        {
            timeout: 15000,
        },
    );
    const HIGH_QUALITY_TRIANGLES = await page.evaluate(() => window.vectorAssetDemo.topology.triangles);
    await page.locator('[data-quality-target="curve-segments"][data-quality-value="8"]').click();
    await page.waitForFunction(
        () => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 8,
        null,
        {
            timeout: 15000,
        },
    );
    const COARSE = await page.evaluate(() => ({
        triangles: window.vectorAssetDemo.topology.triangles,
        uniqueVertices: window.vectorAssetDemo.topology.uniqueVertices,
        compileMs: window.vectorAssetDemo.compileMs,
        fetchMs: window.vectorAssetDemo.fetchMs,
    }));
    assert.ok(
        COARSE.triangles < HIGH_QUALITY_TRIANGLES,
        'the 8-segment preset produces fewer triangles than 16 at the same arc divisions',
    );
    assert.ok(COARSE.uniqueVertices > 0, 'the example reports stored vertex counts');
    assert.ok(
        Number.isFinite(COARSE.compileMs) && COARSE.compileMs >= 0,
        'the compile/hash measurement is reported separately from fetch',
    );
    assert.ok(Number.isFinite(COARSE.fetchMs) && COARSE.fetchMs >= 0, 'the source fetch timing is reported');
    await page.locator('[data-quality-target="stroke-arc-divisions"][data-quality-value="1"]').click();
    await page.waitForFunction(
        () => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.strokeArcDivisions === 1,
        null,
        {
            timeout: 15000,
        },
    );
    const SPLIT_OPTIONS = await page.evaluate(() => ({
        curveSegments: window.vectorAssetDemo.compiledAsset.compilerOptions.curveSegments,
        strokeArcDivisions: window.vectorAssetDemo.compiledAsset.compilerOptions.strokeArcDivisions,
        sourceSha256: window.vectorAssetDemo.sourceSha256,
        sourceSvg: document.querySelector('#source-svg') !== null,
    }));
    assert.deepEqual(
        SPLIT_OPTIONS,
        {
            curveSegments: 8,
            strokeArcDivisions: 1,
            sourceSha256: EXPECTED_SHA256,
            sourceSvg: true,
        },
        'changing stroke arcs leaves curve quality and the exact original source independent',
    );
    const ARC_TRIANGLES = await page.evaluate(() => window.vectorAssetDemo.topology.triangles);
    await page.locator('#display-size').evaluate((element) => {
        element.value = '300';
        element.dispatchEvent(
            new Event('input', {
                bubbles: true,
            }),
        );
    });
    await page.locator('#wireframe').uncheck();
    await page.waitForFunction(() =>
        document.querySelector('#topology-metrics').textContent.includes('wireframe hidden'),
    );
    const DISPLAY = await page.evaluate(() => ({
        actualSize: document.querySelector('#display-size-value').textContent,
        triangles: window.vectorAssetDemo.topology.triangles,
    }));
    assert.equal(DISPLAY.actualSize, '300 px', 'display-size control represents actual rendered CSS pixels');
    assert.equal(DISPLAY.triangles, ARC_TRIANGLES, 'display sizing changes no compiled geometry');
    const PREVIOUS_SHA = SPLIT_OPTIONS.sourceSha256;
    for (const INVALID_CURVE_SEGMENTS of ['0', '1.5', '65']) {
        await page.locator('#curve-segments').fill(INVALID_CURVE_SEGMENTS);
        await page.locator('#load-asset').click();
        await page.waitForFunction(() =>
            document.querySelector('#status').textContent.includes('whole number from 1 through 64'),
        );
        assert.equal(
            await page.evaluate(() => window.vectorAssetDemo.sourceSha256),
            PREVIOUS_SHA,
            `invalid curve input ${INVALID_CURVE_SEGMENTS} leaves the last compiled geometry intact`,
        );
    }
    await page.locator('#asset-url').fill('file:///tmp/outside.svg');
    await page.locator('#load-asset').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Only HTTP(S)'));
    assert.equal(
        await page.evaluate(() => window.vectorAssetDemo.sourceSha256),
        PREVIOUS_SHA,
        'invalid protocol input leaves the previously compiled source and view intact',
    );
    return {
        initialTriangles: INITIAL.triangles,
        eightSegmentTriangles: COARSE.triangles,
        compileMs: COARSE.compileMs,
        fetchMs: COARSE.fetchMs,
        normalizedBlobURL: RAW_URL,
        oneArcDivision: SPLIT_OPTIONS.strokeArcDivisions,
        displaySize: DISPLAY.actualSize,
        invalidProtocolRejected: true,
        farmpeaSourceSha256: FARMPEA.sourceSha256,
        farmpeaTriangles: FARMPEA.triangles,
        farmpeaScreenshot: screenshotPath,
    };
}

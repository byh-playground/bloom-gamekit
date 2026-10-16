import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

/** Exercises the quality controls in the published three-view vector example. */
export async function exerciseVectorAssetQualityExample(page, previewURL,
  screenshotPath = 'test-results/vector-assets-quality-farmpea.png') {
  const fixturePath = 'modules/vector-assets/assets/seed-scout.svg';
  const fixtureBytes = await readFile(fixturePath);
  const expectedSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const farmpeaURL = 'https://raw.githubusercontent.com/byh-playground/budmori-io/0dab58e201b5c08f5073108121eeae91acc34774/assets/troops/pea.svg';
  const farmpeaSha256 = 'c5db5b9ad6dbe4683f3eb21d53ffaee476ce06b90b4a36ced13ce7c1d758ef51';
  const blobURL = 'https://github.com/byh-playground/bloom-gamekit/blob/main/modules/vector-assets/assets/seed-scout.svg';
  const rawURL = 'https://raw.githubusercontent.com/byh-playground/bloom-gamekit/main/modules/vector-assets/assets/seed-scout.svg';
  await page.route(rawURL, route => route.fulfill({ status: 200,
    headers: { 'access-control-allow-origin': '*', 'content-type': 'image/svg+xml' }, body: fixtureBytes }));

  // Verify the actual public default URL, rather than substituting local test bytes.
  await page.goto(previewURL);
  await page.waitForFunction(() => window.vectorAssetDemo?.ready, null, { timeout: 30000 });
  const farmpea = await page.evaluate(() => ({
    sourceLoaded: window.vectorAssetDemo.sourceLoaded,
    sourceUrl: window.vectorAssetDemo.sourceUrl,
    sourceSha256: window.vectorAssetDemo.sourceSha256,
    metadataId: window.vectorAssetDemo.compiledAsset?.metadata?.id,
    curveSegments: window.vectorAssetDemo.compiledAsset?.compilerOptions?.curveSegments,
    strokeArcDivisions: window.vectorAssetDemo.compiledAsset?.compilerOptions?.strokeArcDivisions,
    triangles: window.vectorAssetDemo.topology.triangles,
    sourceSvgPresent: Boolean(document.querySelector('#source-svg')),
    sourceShapeCount: document.querySelectorAll('#source-svg path, #source-svg rect, #source-svg circle, #source-svg ellipse, #source-svg line, #source-svg polyline, #source-svg polygon').length,
    error: window.vectorAssetDemo.error || document.querySelector('#status').textContent,
  }));
  assert.equal(farmpea.sourceLoaded, true, 'the real public Farmpea URL loads through browser CORS');
  assert.equal(farmpea.sourceUrl, farmpeaURL);
  assert.equal(farmpea.sourceSha256, farmpeaSha256, 'the public SVG bytes match the immutable original');
  assert.equal(farmpea.metadataId, 'budmori-pea');
  assert.equal(farmpea.curveSegments, 16);
  assert.equal(farmpea.strokeArcDivisions, 12);
  assert.equal(farmpea.sourceSvgPresent, true, 'the sanitized original SVG is displayed in the source panel');
  assert.ok(farmpea.sourceShapeCount > 0, 'the source panel contains actual sanitized SVG shapes');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Use a deterministic local fixture for the tessellation interaction comparisons.
  await page.goto(previewURL + '?fixture=seed-scout');
  await page.waitForFunction(() => window.vectorAssetDemo?.ready && window.vectorAssetDemo?.sourceLoaded, null, { timeout: 15000 });

  const initial = await page.evaluate(() => ({
    sourceSha256: window.vectorAssetDemo.sourceSha256,
    triangles: window.vectorAssetDemo.topology.triangles,
    curveSegments: window.vectorAssetDemo.compiledAsset.compilerOptions.curveSegments,
    strokeArcDivisions: window.vectorAssetDemo.compiledAsset.compilerOptions.strokeArcDivisions,
  }));
  assert.equal(initial.sourceSha256, expectedSha256, 'the sample source is rendered from the exact fixture bytes');
  assert.equal(initial.curveSegments, 16, 'the initial curve preset is 16 segments');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#asset-url').fill(blobURL);
  await page.locator('#load-asset').click();
  await page.waitForFunction(raw => window.vectorAssetDemo?.sourceUrl === raw
    && window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 16, rawURL, { timeout: 15000 });
  const copy = await page.evaluate(async () => {
    document.querySelector('#copy-loader-options').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    return { status: document.querySelector('#status').textContent, text: await navigator.clipboard.readText() };
  });
  assert.match(copy.status, /Loader options copied/);
  const copiedOptions = JSON.parse(copy.text);
  assert.equal(copiedOptions.sourcePath, rawURL, 'GitHub blob URL is normalized to the matching raw URL');
  assert.equal(copiedOptions.maxBytes, 512 * 1024);
  assert.equal(copiedOptions.curveSegments, 16);
  assert.equal(copiedOptions.strokeArcDivisions, 12);

  await page.locator('#curve-segments').selectOption('8');
  await page.waitForFunction(() => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.curveSegments === 8, null, { timeout: 15000 });
  const coarse = await page.evaluate(() => ({
    triangles: window.vectorAssetDemo.topology.triangles,
    uniqueVertices: window.vectorAssetDemo.topology.uniqueVertices,
    compileMs: window.vectorAssetDemo.compileMs,
    fetchMs: window.vectorAssetDemo.fetchMs,
  }));
  assert.ok(coarse.triangles < initial.triangles, 'the 8-segment preset produces fewer triangles than 16');
  assert.ok(coarse.uniqueVertices > 0, 'the example reports stored vertex counts');
  assert.ok(Number.isFinite(coarse.compileMs) && coarse.compileMs >= 0, 'the compile/hash measurement is reported separately from fetch');
  assert.ok(Number.isFinite(coarse.fetchMs) && coarse.fetchMs >= 0, 'the source fetch timing is reported');

  await page.locator('#stroke-arc-divisions').selectOption('4');
  await page.waitForFunction(() => window.vectorAssetDemo?.compiledAsset?.compilerOptions?.strokeArcDivisions === 4, null, { timeout: 15000 });
  const splitOptions = await page.evaluate(() => ({
    curveSegments: window.vectorAssetDemo.compiledAsset.compilerOptions.curveSegments,
    strokeArcDivisions: window.vectorAssetDemo.compiledAsset.compilerOptions.strokeArcDivisions,
    sourceSha256: window.vectorAssetDemo.sourceSha256,
    sourceSvg: document.querySelector('#source-svg') !== null,
  }));
  assert.deepEqual(splitOptions, { curveSegments: 8, strokeArcDivisions: 4, sourceSha256: expectedSha256, sourceSvg: true },
    'changing stroke arcs leaves curve quality and the exact original source independent');
  const arcTriangles = await page.evaluate(() => window.vectorAssetDemo.topology.triangles);

  await page.locator('#display-size').evaluate(element => {
    element.value = '300'; element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#wireframe').uncheck();
  await page.waitForFunction(() => document.querySelector('#topology-metrics').textContent.includes('wireframe hidden'));
  const display = await page.evaluate(() => ({ actualSize: document.querySelector('#display-size-value').textContent,
    triangles: window.vectorAssetDemo.topology.triangles }));
  assert.equal(display.actualSize, '300 px', 'display-size control represents actual rendered CSS pixels');
  assert.equal(display.triangles, arcTriangles, 'display sizing changes no compiled geometry');

  const previousSha = splitOptions.sourceSha256;
  await page.locator('#asset-url').fill('file:///tmp/outside.svg');
  await page.locator('#load-asset').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Only HTTP(S)'));
  assert.equal(await page.evaluate(() => window.vectorAssetDemo.sourceSha256), previousSha,
    'invalid protocol input leaves the previously compiled source and view intact');
  return { initialTriangles: initial.triangles, eightSegmentTriangles: coarse.triangles,
    compileMs: coarse.compileMs, fetchMs: coarse.fetchMs, normalizedBlobURL: rawURL,
    fourArcDivisions: splitOptions.strokeArcDivisions, displaySize: display.actualSize, invalidProtocolRejected: true,
    farmpeaSourceSha256: farmpea.sourceSha256, farmpeaTriangles: farmpea.triangles,
    farmpeaScreenshot: screenshotPath };
}

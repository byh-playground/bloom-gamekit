import { exerciseWebGLDevice } from './device.browser.mjs';
import { runPresentationChecks } from './presentation.browser.js';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const report = { stages: [] };
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser runtime:', error.stack ?? error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}/examples/interpolation/index.html`);
  await page.waitForFunction(() => window.demo?.diagnostics.frames >= 30);
  assert.equal(await page.evaluate(() => demo.renderer.stats.backend), 'webgl1');
  const initialX = await page.evaluate(() => demo.diagnostics.authorityX);
  await page.keyboard.down('KeyD');
  await page.waitForFunction(x => demo.diagnostics.authorityX > x + 25, initialX);
  await page.keyboard.up('KeyD');
  await page.waitForFunction(() => Math.abs(demo.diagnostics.poseX - demo.diagnostics.authorityX) < 0.1);
  report.stages.push('real DOM keyboard → 100ms authority → interpolation → WebGL rAF movement');

  // Several render-time samples cannot erase a down/up entirely between simulation ticks.
  await page.evaluate(() => demo.pause());
  const rolls = await page.evaluate(() => demo.diagnostics.rolls);
  await page.keyboard.press('Space');
  const tap = await page.evaluate(() => {
    const out = {}; for (let i = 0; i < 8; i++) demo.actions.sampleInto('roll', out); return out;
  });
  assert.deepEqual(tap, { held: false, pressed: true, released: true });
  await page.evaluate(() => demo.pause(false));
  await page.waitForFunction(n => demo.diagnostics.rolls === n + 1, rolls);
  // UI controls never generate a held game action.
  await page.locator('#zoom').focus(); await page.keyboard.down('ArrowRight');
  assert.equal(await page.evaluate(() => demo.actions.sample('right').held), false);
  await page.keyboard.up('ArrowRight');
  report.stages.push('quick tap survives render samples until fixed-step consume; editable UI excluded');

  const bounds = await page.locator('canvas').boundingBox();
  await page.touchscreen.tap(bounds.x + bounds.width * 0.72, bounds.y + bounds.height * 0.6);
  const rollBeforeTouch = await page.evaluate(() => demo.diagnostics.rolls);
  await page.touchscreen.tap(bounds.x + bounds.width * 0.72 + 2, bounds.y + bounds.height * 0.6 + 2);
  await page.waitForFunction(n => demo.diagnostics.rolls > n, rollBeforeTouch);
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(() => demo.actions.sample('up').held), false);
  await page.keyboard.up('KeyW');
  report.stages.push('actual touch double-tap maps to game roll; blur releases held keyboard');

  await page.setViewportSize({ width: 620, height: 800 });
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas'); return c.width === Math.round(c.getBoundingClientRect().width * 2);
  });
  report.scene = await page.evaluate(() => {
    const d = demo.diagnostics, r = demo.renderer;
    const intervals = d.frameIntervals.slice().sort((a, b) => a - b);
    return { frames: d.frames, tick: d.tick, observedFps: d.fps, cpuSubmitMs: d.cpuSubmitMs,
      intervalP50Ms: intervals[Math.floor(intervals.length / 2)], intervalP95Ms: intervals[Math.floor(intervals.length * 0.95)],
      viewport: [...r.gl.getParameter(r.gl.VIEWPORT)], stats: { ...r.stats }, error: r.gl.getError() };
  });
  assert.equal(report.scene.error, 0); assert.equal(report.scene.stats.textureUploads, 0);
  assert.equal(report.scene.stats.bufferAllocations, 1);
  assert.ok(report.scene.stats.vertices > 500); assert.ok(report.scene.stats.uploadedBytes > 0);
  report.scenePixels = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const r = demo.renderer, gl = r.gl, pixels = new Uint8Array(r.canvas.width * r.canvas.height * 4);
    gl.readPixels(0, 0, r.canvas.width, r.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 100 || pixels[i + 2] > 120) colored++;
    resolve({ colored, error: gl.getError() });
  })));
  assert.ok(report.scenePixels.colored > 100, 'composed input/interpolation example must draw visible geometry');
  assert.equal(report.scenePixels.error, 0);
  await page.evaluate(() => demo.pause());

  // Continue the same built-bundle/browser flow with focused pixel/lifecycle probes.
  report.rendering = await page.evaluate(async () => {
    const { Renderer2D } = await import('/dist/rendering.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const near = (actual, expected, message) => check(actual.every((value, i) => Math.abs(value - expected[i]) <= 3), `${message}: ${actual} expected ${expected}`);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    canvas.style.cssText = 'width:64px;height:64px'; document.body.append(canvas);
    const r = new Renderer2D(canvas, { batchVertices: 12, antialias: false, preserveDrawingBuffer: true });
    r.resize(64, 64, 2); r.setCamera({ x: 32, y: 32 });
    const gl = r.gl;
    const pixel = (x, y) => { const out = new Uint8Array(4); gl.readPixels(Math.floor(x * 2), canvas.height - 1 - Math.floor(y * 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out); return [...out]; };
    const red = [1, 0, 0, 0.5], blue = [0, 0, 1, 1], green = [0, 1, 0, 1];
    const texture = r.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 128]) }, { filter: 'nearest' });
    r.beginFrame(blue); r.rect(16, 32, 20, 30, red); r.sprite(texture, 48, 32, 20, 30); r.endFrame();
    const primitiveAlpha = pixel(16, 32), textureAlpha = pixel(48, 32);
    near(primitiveAlpha, [128, 0, 127, 255], 'primitive premultiplied alpha');
    near(textureAlpha, [128, 0, 127, 255], 'byte texture must be premultiplied exactly once');
    const image = document.createElement('canvas'); image.width = image.height = 1;
    image.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([255, 0, 0, 128]), 1, 1), 0, 0);
    const domTexture = r.createTexture(image);
    r.beginFrame(blue); r.sprite(domTexture, 32, 32, 32, 32); r.endFrame();
    near(pixel(32, 32), [128, 0, 127, 255], 'DOM source alpha');
    const bitmap = await createImageBitmap(image, { premultiplyAlpha: 'none' });
    let bitmapRejected = false; try { r.createTexture(bitmap); } catch { bitmapRejected = true; } finally { bitmap.close(); }
    check(bitmapRejected, 'ambiguous bitmap alpha must be rejected');

    r.beginFrame(blue); r.sprite(texture, 32, 32, 40, 40); r.rect(32, 32, 40, 40, green); r.sprite(texture, 32, 32, 20, 20); r.endFrame();
    near(pixel(32, 32), [128, 127, 0, 255], 'texture switches preserve transparent painter order');
    near(pixel(17, 32), [0, 255, 0, 255], 'outer opaque layer');
    const atlas = r.createTexture({ width: 2, height: 2, data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]) }, { filter: 'nearest' });
    r.beginFrame(); r.sprite(atlas, 32, 32, 40, 40); r.endFrame();
    near(pixel(20, 20), [255, 0, 0, 255], 'atlas top-left'); near(pixel(44, 20), [0, 255, 0, 255], 'atlas top-right');
    near(pixel(20, 44), [0, 0, 255, 255], 'atlas bottom-left');
    // NPOT and transparent border linear filtering operate on premultiplied texels.
    const linear = r.createTexture({ width: 3, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0]) });
    r.beginFrame(blue); r.sprite(linear, 32, 32, 48, 20); r.endFrame();
    const filtered = pixel(24, 32); check(filtered[0] > 60 && filtered[0] < 200 && filtered[1] <= 2, `filtered fringe: ${filtered}`);
    // Updating a queued texture first flushes old pixels; the next draw uses the update.
    r.beginFrame(blue); r.sprite(texture, 16, 32, 20, 20);
    r.updateTexture(texture, { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) });
    r.sprite(texture, 48, 32, 20, 20); r.endFrame();
    near(pixel(16, 32), [128, 0, 127, 255], 'queued old texture'); near(pixel(48, 32), [0, 255, 0, 255], 'updated texture');

    const staging = r.vertices, buffer = r.buffer;
    r.beginFrame(); for (let i = 0; i < 25; i++) r.rect(i * 2, 32, 2, 2, green); const stats = { ...r.endFrame() };
    check(stats.drawCalls === 13 && stats.vertices === 150 && stats.uploadedBytes === 4800, `bounded batch counts ${JSON.stringify(stats)}`);
    check(r.vertices === staging && r.buffer === buffer && stats.bufferAllocations === 1 && stats.textureUploads === 0, 'steady buffers/textures reused');
    check(stats.bufferViews === stats.drawCalls, 'view allocation counter matches flush');
    r.setCamera({ x: 12, y: 24, zoom: 2, rotation: Math.PI / 2 });
    const screen = {}, world = {}; r.worldToScreenInto(15, 28, screen); r.screenToWorldInto(screen.x, screen.y, world);
    check(Math.abs(world.x - 15) < 1e-6 && Math.abs(world.y - 28) < 1e-6, 'camera inverse roundtrip');
    r.beginFrame(); r.rect(12, 24, 2, 2, green); r.rect(16, 24, 2, 2, green); r.endFrame(); near(pixel(32, 32), [0, 255, 0, 255], 'camera center at viewport center'); near(pixel(32, 24), [0, 255, 0, 255], 'camera rotation/zoom moves positive world x upward');
    r.beginFrame(); let resizeRejected = false; try { r.resize(20, 20); } catch { resizeRejected = true; } r.endFrame(); check(resizeRejected, 'active resize must not silently erase draws');
    check(gl.getError() === gl.NO_ERROR, 'actual GL error must be NO_ERROR');
    const version = gl.getParameter(gl.VERSION), shadingLanguage = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    window.renderProbe = { r, texture, pixel, canvas, buffers: { buffer, program: r.program } };
    return { primitiveAlpha, textureAlpha, filtered, version, shadingLanguage, stats, viewport: [...gl.getParameter(gl.VIEWPORT)], bitmapRejected };
  });
  assert.deepEqual(report.rendering.viewport, [0, 0, 128, 128]);
  report.stages.push('actual WebGL shader/link, readPixels alpha/order/atlas/update, NPOT, camera/DPR, bounded reused buffers');

  const supportsLoss = await page.evaluate(() => {
    const { r } = renderProbe; renderProbe.loss = r.gl.getExtension('WEBGL_lose_context');
    if (!renderProbe.loss) return false; renderProbe.loss.loseContext(); return true;
  });
  if (supportsLoss) {
    await page.waitForFunction(() => renderProbe.r.state === 'lost');
    assert.equal(await page.evaluate(() => renderProbe.r.beginFrame()), false);
    await page.evaluate(() => renderProbe.loss.restoreContext());
    await page.waitForFunction(() => renderProbe.r.state === 'ready');
    const restored = await page.evaluate(() => {
      const { r, texture, pixel } = renderProbe;
      r.setCamera({ x: 32, y: 32, zoom: 1, rotation: 0 }); r.beginFrame([0, 0, 1, 1]); r.sprite(texture, 32, 32, 24, 24); r.endFrame();
      return { pixel: pixel(32, 32), error: r.gl.getError(), allocations: r.stats.bufferAllocations };
    });
    assert.deepEqual(restored.pixel, [0, 255, 0, 255]); assert.equal(restored.error, 0); assert.equal(restored.allocations, 2);
    report.stages.push('WEBGL_lose_context → skipped lost frame → shader/buffer/texture handle restoration');
  } else report.stages.push('WEBGL_lose_context unavailable: restoration not executed');

  report.input = await page.evaluate(async () => {
    const { ActionState, createDOMInput } = await import('/dist/input.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const canvas = renderProbe.canvas, state = new ActionState(), pointerEvents = [], releases = [];
    const input = createDOMInput({ target: canvas, state, keys: { KeyQ: 'hold' }, pointerButtons: { 0: 'hold' },
      onPointer: event => pointerEvents.push(event), onRelease: event => releases.push(event.reason) });
    const rect = canvas.getBoundingClientRect();
    const dispatch = (type, id, buttons) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId: id, pointerType: 'touch', button: 0, buttons, clientX: rect.left + 16, clientY: rect.top + 32 }));
    dispatch('pointerdown', 101, 1); dispatch('pointerdown', 102, 1);
    const position = {}; check(input.samplePointerInto(101, position) && position.x === 16 && position.y === 32 && position.u === 0.25 && position.v === 0.5, 'CSS coordinates ignore backing DPR');
    state.consume(); dispatch('pointercancel', 101, 0);
    check(state.sample('hold').held && !state.sample('hold').released, 'second touch still holds action');
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
    dispatch('lostpointercapture', 102, 0); check(state.sample('hold').held, 'keyboard source survives pointer cancel');
    window.dispatchEvent(new Event('blur')); check(!state.sample('hold').held && state.sample('hold').released, 'blur releases remaining source');
    check(pointerEvents.map(event => `${event.type}:${event.pointerId}`).join(',') === 'down:101,down:102,cancel:101,cancel:102', 'callback identity and cancellation order');
    check(pointerEvents[0].originalEvent instanceof PointerEvent && pointerEvents[0].u === .25, 'callback original DOM event and CSS sample');
    check(releases.includes('blur'), 'callback blur reason');
    state.consume(); input.dispose(); input.dispose(); dispatch('pointerdown', 103, 1);
    check(pointerEvents.length === 4, 'dispose removes pointer callbacks');
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
    check(!state.sample('hold').held && !state.sample('hold').pressed, 'dispose removes listeners');
    return { coordinates: position, multisource: true, pointerCancel: true, captureLoss: true, disposal: true,
      ownedCallbacks: true, eventScope: 'Real DOM dispatch for deterministic multi-pointer cancellation; trusted touchscreen tap tested above.' };
  });
  report.stages.push('DOM multi-pointer identity/coordinates/cancel/capture loss + keyboard aggregation + listener disposal');

  report.device = await exerciseWebGLDevice(page);
  report.presentation = await runPresentationChecks(page);
  const disposal = await page.evaluate(() => {
    const { r } = renderProbe, gl = r.gl, buffer = r.buffer, program = r.program;
    r.dispose(); r.dispose(); const result = { state: r.state, bufferReleased: !gl.isBuffer(buffer), programReleased: !gl.isProgram(program), textures: r.stats.textureCount };
    demo.dispose(); return result;
  });
  assert.deepEqual(disposal, { state: 'disposed', bufferReleased: true, programReleased: true, textures: 0 });
  assert.equal(errors.length, 0, errors.join('\n'));
  report.browser = await browser.version(); report.contextLoss = supportsLoss;
  report.scope = 'Headless Chromium with actual WebGL1/SwiftShader pixels and built ESMs. CPU/interval observations are not mobile FPS or hardware-GPU certification. No screenshot/artifact retention.';
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

export async function runPresentationChecks(page) {
  return page.evaluate(async () => {
    const { CameraViewport, OrthographicProjection } = await import('/dist/camera.js');
    const { PresentationEventQueue } = await import('/dist/presentation-events.js');
    const { DOMHud } = await import('/dist/hud.js');
    const { DiagnosticRing, copyDiagnostic } = await import('/dist/debug-tools.js');
    const { Renderer2D } = await import('/dist/rendering.js');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const host = document.createElement('div'); host.style.cssText = 'position:relative;width:100px;height:100px'; document.body.append(host);
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100px;height:100px;aspect-ratio:auto'; host.append(canvas);
    const renderer = new Renderer2D(canvas, { antialias: false, preserveDrawingBuffer: true });
    const camera = new CameraViewport({ projection: new OrthographicProjection(), width: 100, height: 100, dpr: 2, x: 20, y: 20, zoom: 1.5, rotation: .2 });
    camera.setShake(3, -2); camera.applyToRenderer(renderer, true);
    const hud = new DOMHud({ camera, root: host }); const world = { x: 23, y: 40, z: 10 }; const plane = {}, screen = {};
    const label = hud.add('world', { anchor: world, text: '42' }); hud.update(); const writes = hud.stats.writes; hud.update(); check(writes === hud.stats.writes, 'stationary HUD must not rewrite DOM');
    camera.projection.projectInto(world.x, world.y, world.z, plane); camera.worldToScreenInto(world.x, world.y, world.z, screen);
    renderer.beginFrame(); renderer.rect(plane.x, plane.y, 6, 6, [0, 1, 0, 1]); renderer.endFrame();
    const pixel = new Uint8Array(4); renderer.gl.readPixels(Math.floor(screen.x * 2), canvas.height - 1 - Math.floor(screen.y * 2), 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixel);
    check(pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0 && pixel[3] === 255, `shared XYZ camera GPU pixel ${[...pixel]} at ${screen.x},${screen.y}`);
    const labelBounds = label.getBoundingClientRect(), hostBounds = host.getBoundingClientRect();
    const anchorX = labelBounds.left + labelBounds.width / 2 - hostBounds.left, anchorY = labelBounds.bottom - hostBounds.top;
    check(Math.abs(anchorX - screen.x) < .02 && Math.abs(anchorY - screen.y) < .02, `shared XYZ HUD visible anchor ${anchorX},${anchorY} expected ${screen.x},${screen.y}; CSS ${label.style.transform}`);
    let starts = 0, sounds = 0, stops = 0;
    const queue = new PresentationEventQueue({ adapters: {
      text: { reversible: true, start: event => { starts++; return hud.add(event.sequence, { anchor: event.payload, text: 'hit' }); }, stop: (_, reason, event) => { stops++; hud.remove(event.sequence); } },
      sound: { start: () => { sounds++; } },
    } });
    const event = { tick: 4, sequence: 1, entityId: 'actor', generation: 0, kind: 'text', policy: 'speculative', durationMs: 300, payload: world };
    queue.emit(event); queue.emit({ ...event, kind: 'sound', policy: 'confirmed' });
    queue.beginRollback(4); queue.emit(event); queue.endRollback(); check(starts === 1 && sounds === 0, 'resim must dedup VFX and cancel absent pending SFX');
    queue.beginRollback(4); queue.endRollback(); check(stops === 1 && hud.stats.nodes === 1, 'absent speculative resource cancelled');
    queue.emit({ ...event, tick: 5, kind: 'sound', policy: 'confirmed' }); queue.confirmThrough(5); check(sounds === 1, 'only valid confirmed sound starts');
    queue.emit({ ...event, tick: 5, kind: 'sound', policy: 'confirmed' }); check(sounds === 1, 'confirmed sound cannot replay');
    const ring = new DiagnosticRing({ capacity: 2 }); const target = new EventTarget(); const cleanup = ring.installGlobal(target);
    target.dispatchEvent(new ErrorEvent('error', { message: 'password=private user@example.com https://private.test' }));
    check(ring.total === 1 && ring.snapshot().blockerCount === 1 && !ring.format().includes('private'), 'global diagnostics redacted and remain blocking by default');
    ring.report('save recovered', { kind: 'save.load', visibility: 'notice' });
    check(ring.snapshot().counts.notice === 1 && ring.snapshot().blockerCount === 1, 'notice is retained without increasing the visible blocker count');
    cleanup(); target.dispatchEvent(new ErrorEvent('error', { message: 'ignored' })); check(ring.total === 2, 'diagnostic listener restored');
    const textarea = document.createElement('textarea'); host.append(textarea);
    const copy = await copyDiagnostic(ring.format(), { clipboard: { writeText: async () => { throw Error('denied'); } }, textarea });
    check(!copy.copied && copy.method === 'selection' && textarea.selectionEnd === textarea.value.length, 'manual copy remains selected and truthful');
    const external = document.createElement('span'); external.textContent = 'original'; external.style.color = 'red'; host.append(external);
    hud.add('external', { element: external, anchor: { space: 'screen', x: 2, y: 2 }, text: 'changed' }); hud.update(); hud.remove('external'); check(external.textContent === 'original' && external.style.color === 'red' && !external.style.position, 'external DOM state restored');
    const originalParent = document.createElement('div'); host.append(originalParent);
    const a = document.createElement('span'), b = document.createElement('span'), c = document.createElement('span'); originalParent.append(a, b, c);
    hud.add('a', { element: a, anchor: { space: 'screen', x: 1, y: 1 } }); hud.add('b', { element: b, anchor: { space: 'screen', x: 1, y: 1 } });
    hud.remove('a'); hud.remove('b'); check(originalParent.children[0] === a && originalParent.children[1] === b && originalParent.children[2] === c && originalParent.childNodes.length === 3, 'multiple moved siblings restore exact order without leaked markers');
    queue.dispose(); hud.dispose(); ring.dispose(); renderer.dispose(); host.remove();
    return { cameraHudPixel: [...pixel], stationaryDomWrites: writes, speculativeStarts: starts, cancelledResources: stops, confirmedSoundStarts: sounds, globalErrors: 'redacted and detached', clipboardFallback: copy.method };
  });
}

export async function runRenderObjectChecks(page) {
  return page.evaluate(async () => {
    const { RenderObject, PresentationRuntime } = await import('/dist/interpolation.js');
    const { Renderer2D } = await import('/dist/rendering.js');
    const { ActionState, createDOMInput } = await import('/dist/input.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    class Actor extends RenderObject {
      static renderSchema = { x: this.LINEAR, y: this.LINEAR, 'roll.progress': this.LINEAR, color: this.STEP,
        'node.state': this.STATE_KEY, 'node.clock': this.COUNTDOWN_MS, 'node.anchor': this.LINEAR };
      x = 16; y = 32; roll = { progress: 0 }; color = [0, 1, 0, 1];
      node = { state: 'ready', clock: 100, anchor: 12 };
      #renders = 0;
      update(input) { if (input.held) { this.x += 32; this.roll.progress = 1; this.node = { state: 'active', clock: 200, anchor: 60 }; } }
      render(renderer, model) { this.#renders++; renderer.rect(model.x, model.y, 8, 8, model.color); }
      get renders() { return this.#renders; }
    }
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const renderer = new Renderer2D(canvas, { preserveDrawingBuffer: true });
    renderer.resize(64, 64, 1); renderer.setCamera({ x: 32, y: 32, zoom: 1 });
    const actor = new Actor(), runtime = new PresentationRuntime({ stepMs: 100 }), state = new ActionState();
    const input = createDOMInput({ target: canvas, state, keys: { KeyQ: 'move' } });
    const packet = sequence => ({ revision: 0, sequence, timeMs: sequence * 100, entities: [{ id: 'actor', generation: 0, source: actor }] });
    runtime.capture(packet(0), 0);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
    actor.update(state.sample('move')); state.consume(); runtime.capture(packet(1), 100);
    const model = runtime.sample('actor', 0, 150);
    check(model.x === 32 && model.roll.progress === .5, 'native nested half-tick model');
    check(model.node.clock === 200 && model.node.anchor === 60, 'state/countdown parent resets do not snap root movement');
    check(model.roll !== actor.roll && model.color !== actor.color && !('update' in model), 'detached field-only model');
    renderer.beginFrame([0, 0, 0, 1]); runtime.render(actor, renderer, 150); renderer.endFrame();
    const pixel = new Uint8Array(4); renderer.gl.readPixels(32, 32, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixel);
    check(pixel[1] > 240 && pixel[0] < 10, 'real WebGL draws interpolated midpoint');
    check(actor.renders === 1 && actor.x === 48, 'normal this retains private fields and authority');
    check(runtime.modelFor({ ...actor }, 150) === null, 'copied authority cannot bypass capture');
    window.dispatchEvent(new Event('blur')); check(!state.sample('move').held, 'independent input blur release');
    const predicted = new Actor(); predicted.x = 64;
    runtime.selectPreview([{ id: 'actor', generation: 0 }]);
    runtime.capturePreview({ revision: 0, sequence: 0, timeMs: 150,
      entities: [{ id: 'actor', generation: 0, source: predicted }] }, 150);
    const previewModel = runtime.sample('actor', 0, 175);
    check(previewModel.x === 40 && runtime.modelFor(predicted, 175) === previewModel && runtime.sample('actor', 0, 175).x === 40, 'body/HUD share same-time preview value and model');
    predicted.x = 56;
    runtime.capturePreview({ revision: 0, sequence: 1, timeMs: 175,
      entities: [{ id: 'actor', generation: 0, source: predicted }] }, 175);
    check(runtime.sample('actor', 0, 175) === previewModel && previewModel.x === 40, 'same-time preview recapture starts at displayed pose');
    renderer.beginFrame([0, 0, 0, 1]); runtime.render(actor, renderer, 225); renderer.endFrame();
    const previewPixel = new Uint8Array(4); renderer.gl.readPixels(48, 32, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, previewPixel);
    check(previewModel.x === 48 && previewPixel[1] > 240 && actor.x === 48, 'recaptured preview reaches new midpoint through WebGL without changing authority');
    runtime.releasePreview(225);
    check(runtime.sample('actor', 0, 225).x === 48, 'same-time preview release preserves displayed pose');
    runtime.capture({ revision: 0, sequence: 2, timeMs: 250, entities: [] }, 250);
    check(runtime.modelFor(model, 250) === null, 'despawned model cannot render');
    class Spark extends RenderObject {
      static renderSchema = { 'point.u': this.POSITION_X, 'point.v': this.POSITION_Y,
        'launch.a': this.ORIGIN_X, 'launch.b': this.ORIGIN_Y, extent: this.SPAWN_LINEAR };
      point = { u: 48, v: 32 }; launch = { a: 16, b: 32 }; extent = 8;
      render(renderer, model) { renderer.rect(model.point.u, model.point.v, model.extent, 4, [0, 0, 1, 1]); }
    }
    const spark = new Spark(), sparks = new PresentationRuntime({ stepMs: 100 });
    sparks.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [{ id: 'spark', generation: 0, source: spark }] }, 0);
    renderer.beginFrame([0, 0, 0, 1]); sparks.render(spark, renderer, 50); renderer.endFrame();
    const spawned = new Uint8Array(4); renderer.gl.readPixels(32, 32, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, spawned);
    check(spawned[2] > 240 && spawned[0] < 10, 'generic origin roles draw newborn midpoint with foreign field names');
    const result = { pixel: [...pixel], spawnPixel: [...spawned], previewPixel: [...previewPixel], previewRecapture: true, fieldPolicies: true, nested: true, privateThis: true, detached: true, input: true, despawn: true };
    input.dispose(); renderer.dispose(); canvas.remove(); return result;
  });
}

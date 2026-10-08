export async function runRenderObjectChecks(page) {
  return page.evaluate(async () => {
    const { RenderObject, PresentationRuntime } = await import('/dist/interpolation.js');
    const { Renderer2D } = await import('/dist/rendering.js');
    const { ActionState, createDOMInput } = await import('/dist/input.js');
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    class Actor extends RenderObject {
      static renderSchema = { x: this.LINEAR, y: this.LINEAR, 'roll.progress': this.LINEAR, color: this.STEP };
      x = 16; y = 32; roll = { progress: 0 }; color = [0, 1, 0, 1];
      #renders = 0;
      update(input) { if (input.held) { this.x += 32; this.roll.progress = 1; } }
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
    check(model.roll !== actor.roll && model.color !== actor.color && !('update' in model), 'detached field-only model');
    renderer.beginFrame([0, 0, 0, 1]); runtime.render(actor, renderer, 150); renderer.endFrame();
    const pixel = new Uint8Array(4); renderer.gl.readPixels(32, 32, 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, pixel);
    check(pixel[1] > 240 && pixel[0] < 10, 'real WebGL draws interpolated midpoint');
    check(actor.renders === 1 && actor.x === 48, 'normal this retains private fields and authority');
    check(runtime.modelFor({ ...actor }, 150) === null, 'copied authority cannot bypass capture');
    window.dispatchEvent(new Event('blur')); check(!state.sample('move').held, 'independent input blur release');
    runtime.capture({ revision: 0, sequence: 2, timeMs: 200, entities: [] }, 200);
    check(runtime.modelFor(model, 200) === null, 'despawned model cannot render');
    const result = { pixel: [...pixel], nested: true, privateThis: true, detached: true, input: true, despawn: true };
    input.dispose(); renderer.dispose(); canvas.remove(); return result;
  });
}

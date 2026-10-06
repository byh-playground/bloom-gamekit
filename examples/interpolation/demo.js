import { createLoop } from '../../dist/simloop.js';
import { InterpolationTimeline } from '../../dist/interpolation.js';
import { Renderer2D } from '../../dist/rendering.js';
import { ActionState, createDOMInput } from '../../dist/input.js';
import { OrthographicProjection, CameraViewport } from '../../dist/camera.js';
import { PresentationEventQueue } from '../../dist/presentation-events.js';
import { DOMHud } from '../../dist/hud.js';
import { DiagnosticRing } from '../../dist/debug-tools.js';

// This adapter is owned by the game. A Worker timestamp is simulation metadata only.
export function createPresentation(stepMs = 100) {
  const timeline = new InterpolationTimeline({
    stepMs, schema: { x: 'number', y: 'number', z: 'number', health: 'number', angle: 'angle', state: 'discrete' },
  });
  const pose = {}; // Shared by camera, body and shadow. Reused every frame.
  return { timeline, pose, receive(packet, receiptMs) { return timeline.accept(packet, receiptMs); },
    frame(nowMs) { return timeline.sampleInto('actor', 0, nowMs, pose) ? pose : null; } };
}

// The game owns its rules and local session capability. simloop owns scheduling;
// this offline scene does not create a network session or invent rollback behavior.
const STEP_MS = 100, WORLD_WIDTH = 720, WORLD_HEIGHT = 400;
const COLORS = Object.freeze({ clear: [0.035, 0.065, 0.09, 1], grid: [0.12, 0.2, 0.23, 1],
  shadow: [0, 0, 0, 0.35], body: [0.24, 0.85, 0.66, 1], satellite: [0.3, 0.55, 0.95, 0.85],
  healthBack: [0.12, 0.18, 0.2, 1], health: [0.67, 0.94, 0.43, 1], target: [1, 0.8, 0.3, 0.6] });

/** Returns controls/diagnostics; dispose stops its own loop and all DOM/GPU resources. */
export function startDemo(canvas, status, { autoStart = true } = {}) {
  const renderer = new Renderer2D(canvas);
  const projection = new OrthographicProjection(), camera = new CameraViewport({ projection });
  const debug = new DiagnosticRing({ release: 'composed gamekit example' }); debug.installGlobal(window);
  const hudRoot = document.createElement('div'); hudRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  const wrapper = document.createElement('div'); wrapper.style.position = 'relative'; canvas.before(wrapper); wrapper.append(canvas, hudRoot);
  const hud = new DOMHud({ camera, root: hudRoot });
  hud.add('actor', { anchor: { x: 280, y: 210, z: 8, offsetY: -28 }, text: 'actor' });
  const effects = new PresentationEventQueue({ adapters: { roll: { reversible: true,
    start(event) { return hud.add(event.sequence, { anchor: { ...event.payload, offsetY: -55 }, text: 'roll' }); },
    update(handle, ageMs, event) { hud.setAnchor(event.sequence, { ...event.payload, offsetY: -55 - ageMs / 30 }); },
    stop(handle, reason, event) { hud.remove(event.sequence); },
  } } });
  const projected = {};
  const app = createPresentation(STEP_MS), actions = new ActionState();
  const sampled = { left: {}, right: {}, up: {}, down: {}, roll: {} }, worldPoint = {};
  const actor = { x: 280, y: 210, z: 8, angle: 0, health: 100, state: 'idle' };
  const spriteOptions = { angle: 0 };
  // Small static RGBA asset uploaded once. Never uploads a rasterized world canvas.
  const texture = renderer.createTexture({ width: 2, height: 2, data: new Uint8Array([
    255, 255, 255, 255, 255, 166, 80, 255, 255, 166, 80, 255, 255, 255, 255, 255,
  ]) }, { filter: 'nearest' });
  const poses = Array.from({ length: 25 }, () => ({}));
  const records = poses.map((_, i) => ({ id: i === 0 ? 'actor' : `orbiter-${i}`, generation: 0, values: {} }));
  let target = null, running = true, sequence = 0, tick = 0, rollUntilMs = 0;
  let lastMs = performance.now(), frameNow = lastMs, stepped = false, zoom = 1, paused = false;
  let lastMetricMs = lastMs, metricFrames = 0, fps = 0, cpuMs = 0;
  const diagnostics = { frames: 0, tick: 0, authorityX: actor.x, authorityY: actor.y, poseX: actor.x, poseY: actor.y,
    rolls: 0, fps: 0, cpuSubmitMs: 0, stepMs: STEP_MS, frameIntervals: [], renderer };
  const input = createDOMInput({ target: canvas, state: actions,
    keys: { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', Space: 'roll' },
    gestures: { tap: 'move', doubleTap: 'roll', doubleTapMs: 300, tapMs: 400, dragSlop: 12, doubleTapSlop: 32 },
    onGesture(event) {
      if (event.type === 'tap') {
        camera.screenToGroundInto(event.x, event.y, worldPoint);
        target = { x: worldPoint.x, y: worldPoint.y }; // Game command, consumed by the next fixed step.
      }
    },
  });
  function resize() {
    if (renderer.state !== 'ready') return;
    const rect = canvas.getBoundingClientRect(); camera.setViewport({ width: rect.width, height: rect.height, dpr: Math.min(window.devicePixelRatio || 1, 2), left: rect.left, top: rect.top }); camera.applyToRenderer(renderer, true);
  }
  function authorityStep() {
    tick++;
    for (const key of Object.keys(sampled)) actions.sampleInto(key, sampled[key]);
    if (sampled.roll.pressed) { rollUntilMs = tick * STEP_MS + 300; diagnostics.rolls++;
      effects.emit({ tick, sequence: diagnostics.rolls, entityId: 'actor', generation: 0, kind: 'roll', policy: 'speculative', durationMs: 600, payload: { x: actor.x, y: actor.y, z: actor.z } });
    }
    effects.confirmThrough(tick);
    let dx = Number(sampled.right.held) - Number(sampled.left.held), dy = Number(sampled.down.held) - Number(sampled.up.held);
    if (dx || dy) target = null;
    else if (target) { dx = target.x - actor.x; dy = target.y - actor.y; }
    const length = Math.hypot(dx, dy), rolling = tick * STEP_MS < rollUntilMs;
    const distance = Math.min(length, (rolling ? 220 : 90) * STEP_MS / 1000);
    if (length) {
      // Keyboard directions have unit magnitude, but targets have world distance.
      const scale = target ? distance / length : (rolling ? 220 : 90) * STEP_MS / 1000 / length;
      actor.x = Math.max(24, Math.min(WORLD_WIDTH - 24, actor.x + dx * scale));
      actor.y = Math.max(45, Math.min(WORLD_HEIGHT - 24, actor.y + dy * scale));
      actor.angle = Math.atan2(dy, dx); actor.state = rolling ? 'rolling' : 'walking';
      if (target && length <= distance) target = null;
    } else actor.state = 'idle';
    actor.z = rolling ? 18 : 8;
    actions.consume(); // Only fixed-step command collection clears edges, never rendering.
  }
  function receive(now) {
    Object.assign(records[0].values, actor);
    for (let i = 1; i < records.length; i++) {
      const phase = tick * STEP_MS / 1800 + i * Math.PI * 2 / 24;
      Object.assign(records[i].values, { x: 360 + Math.cos(phase) * (110 + i % 3 * 32), y: 210 + Math.sin(phase) * 105,
        z: 8 + Math.sin(phase * 2) * 5, health: 50 + i * 2, angle: phase, state: 'orbiting' });
    }
    app.receive({ revision: 0, sequence: sequence++, timeMs: tick * STEP_MS, entities: records }, now);
  }
  function render(now) {
    const start = performance.now();
    const pose = app.frame(now); if (!pose || !renderer.beginFrame(COLORS.clear)) return;
    const scale = Math.min(renderer.width / WORLD_WIDTH, renderer.height / WORLD_HEIGHT) * zoom;
    camera.setCamera({ x: 360 + (pose.x - 360) * 0.15, y: 200 * projection.K, zoom: scale }); camera.applyToRenderer(renderer);
    for (let x = 0; x <= WORLD_WIDTH; x += 40) renderer.line(x, 0, x, WORLD_HEIGHT * projection.K, 1, COLORS.grid);
    for (let y = 0; y <= WORLD_HEIGHT; y += 40) renderer.line(0, y * projection.K, WORLD_WIDTH, y * projection.K, 1, COLORS.grid);
    if (target) { renderer.ellipse(target.x, target.y * projection.K, 8, 4, COLORS.target, 12); }
    // Game chooses explicit painter order: all shadows, then sorted body + health.
    for (let i = 0; i < records.length; i++) {
      app.timeline.sampleInto(records[i].id, 0, now, poses[i]);
      poses[i].actor = i === 0;
      renderer.ellipse(poses[i].x, poses[i].y * projection.K, i ? 9 : 16, i ? 4 : 6, COLORS.shadow, 12);
    }
    // Reuse sortable view; pose sampling/authority are not sorted or mutated by renderer.
    sorted.length = 0; for (const item of poses) sorted.push(item); sorted.sort((a, b) => a.y - b.y);
    for (const item of sorted) {
      projection.projectInto(item.x, item.y, item.z, projected);
      renderer.rect(projected.x, projected.y - 8, item.actor ? 24 : 14, item.actor ? 24 : 14, item.actor ? COLORS.body : COLORS.satellite, item.angle);
      renderer.rect(projected.x, projected.y - 28, 26, 3, COLORS.healthBack);
      renderer.rect(projected.x - 13 + 13 * item.health / 100, projected.y - 28, 26 * item.health / 100, 3, COLORS.health);
    }
    spriteOptions.angle = tick * STEP_MS / 1000;
    renderer.sprite(texture, 640, 65, 34, 34, spriteOptions);
    const stats = renderer.endFrame(); effects.update(now); hud.setAnchor('actor', { x: pose.x, y: pose.y, z: pose.z }); hud.update(); cpuMs = performance.now() - start;
    diagnostics.frames++; diagnostics.tick = tick; diagnostics.authorityX = actor.x; diagnostics.authorityY = actor.y;
    diagnostics.poseX = pose.x; diagnostics.poseY = pose.y; diagnostics.cpuSubmitMs = cpuMs;
    canvas.dataset.frames = String(diagnostics.frames); canvas.dataset.x = String(pose.x);
    metricFrames++; if (now - lastMetricMs >= 500) { fps = metricFrames * 1000 / (now - lastMetricMs); metricFrames = 0; lastMetricMs = now; }
    diagnostics.fps = fps;
    status.textContent = `${STEP_MS}ms fixed step (${1000 / STEP_MS} TPS) → ${fps.toFixed(1)} observed FPS | ${stats.drawCalls} draws · ${stats.vertices} vertices · ${stats.uploadedBytes} B/frame · ${stats.textureUploads} texture uploads/frame | CPU submit ${cpuMs.toFixed(2)}ms`;
  }
  const sorted = [];
  resize(); receive(lastMs);
  const localSession = {
    inputSize: 1, profile: { tickRate: 1000 / STEP_MS, maxCatchupSteps: 3 }, metrics: { pace: 1 },
    get closed() { return !running; }, resimulating: false,
    poll() {}, releaseInput() { input.releaseAll(); },
    advance() { authorityStep(); return { status: 'advanced', tick }; },
  };
  const loop = createLoop({ session: localSession, canAdvance: () => !paused,
    beforeFrame() {
      // rAF timestamp may precede setup performed in the same frame. Presentation
      // receipt and sampling keep the same performance.now() clock as initial state.
      const now = performance.now();
      frameNow = now; stepped = false;
      if (!paused && diagnostics.frameIntervals.length < 180) diagnostics.frameIntervals.push(Math.max(0, Math.min(250, now - lastMs)));
      lastMs = now;
    },
    onAdvance() { stepped = true; },
    render() { if (!paused) { if (stepped) receive(frameNow); render(frameNow); } },
  });
  window.addEventListener('resize', resize);
  if (autoStart) loop.start();
  return { actions, input, renderer, diagnostics, camera, hud, effects, debug,
    setZoom(value) { if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new RangeError('zoom must be 0.5..2'); zoom = value; },
    pause(value = true) { paused = value; lastMs = performance.now(); loop.resetTiming(); },
    dispose() { if (!running) return; running = false; loop.stop(); input.dispose(); effects.dispose(); hud.dispose(); debug.dispose(); hudRoot.remove(); wrapper.before(canvas); wrapper.remove(); renderer.dispose(); window.removeEventListener('resize', resize); },
  };
}

import { InterpolationTimeline } from '../../dist/interpolation.js';
import { Renderer2D } from '../../dist/rendering.js';
import { ActionState, createDOMInput } from '../../dist/input.js';

// This adapter is owned by the game. A Worker timestamp is simulation metadata only.
export function createPresentation(stepMs = 100) {
  const timeline = new InterpolationTimeline({
    stepMs, schema: { x: 'number', y: 'number', z: 'number', health: 'number', angle: 'angle', state: 'discrete' },
  });
  const pose = {}; // Shared by camera, body and shadow. Reused every frame.
  return { timeline, pose, receive(packet, receiptMs) { return timeline.accept(packet, receiptMs); },
    frame(nowMs) { return timeline.sampleInto('actor', 0, nowMs, pose) ? pose : null; } };
}

// Application-owned fixed simulation step and render loop. SDK adapters would consume
// the same action state when collecting commands; these packages assign no network ticks.
const STEP_MS = 100, WORLD_WIDTH = 720, WORLD_HEIGHT = 400;
const COLORS = Object.freeze({ clear: [0.035, 0.065, 0.09, 1], grid: [0.12, 0.2, 0.23, 1],
  shadow: [0, 0, 0, 0.35], body: [0.24, 0.85, 0.66, 1], satellite: [0.3, 0.55, 0.95, 0.85],
  healthBack: [0.12, 0.18, 0.2, 1], health: [0.67, 0.94, 0.43, 1], target: [1, 0.8, 0.3, 0.6] });

/** Returns controls/diagnostics; dispose stops its own loop and all DOM/GPU resources. */
export function startDemo(canvas, status, { autoStart = true } = {}) {
  const renderer = new Renderer2D(canvas);
  const app = createPresentation(STEP_MS), actions = new ActionState();
  const sampled = { left: {}, right: {}, up: {}, down: {}, roll: {} }, pointer = {}, worldPoint = {};
  const actor = { x: 280, y: 210, z: 8, angle: 0, health: 100, state: 'idle' };
  const spriteOptions = { angle: 0 };
  // Small static RGBA asset uploaded once. Never uploads a rasterized world canvas.
  const texture = renderer.createTexture({ width: 2, height: 2, data: new Uint8Array([
    255, 255, 255, 255, 255, 166, 80, 255, 255, 166, 80, 255, 255, 255, 255, 255,
  ]) }, { filter: 'nearest' });
  const poses = Array.from({ length: 25 }, () => ({}));
  const records = poses.map((_, i) => ({ id: i === 0 ? 'actor' : `orbiter-${i}`, generation: 0, values: {} }));
  let target = null, running = true, raf = 0, sequence = 0, tick = 0, rollUntilMs = 0;
  let lastMs = performance.now(), accumulator = 0, zoom = 1, paused = false;
  let lastMetricMs = lastMs, metricFrames = 0, fps = 0, cpuMs = 0;
  const diagnostics = { frames: 0, tick: 0, authorityX: actor.x, authorityY: actor.y, poseX: actor.x, poseY: actor.y,
    rolls: 0, fps: 0, cpuSubmitMs: 0, stepMs: STEP_MS, frameIntervals: [], renderer };
  const input = createDOMInput({ target: canvas, state: actions,
    keys: { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', Space: 'roll' },
    gestures: { tap: 'move', doubleTap: 'roll', doubleTapMs: 300, tapMs: 400, dragSlop: 12, doubleTapSlop: 32 },
    onGesture(event) {
      if (event.type === 'tap') {
        renderer.screenToWorldInto(event.x, event.y, worldPoint);
        target = { x: worldPoint.x, y: worldPoint.y }; // Game command, consumed by the next fixed step.
      }
    },
  });
  function resize() {
    if (renderer.state !== 'ready') return;
    const rect = canvas.getBoundingClientRect(); renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
  }
  function authorityStep() {
    tick++;
    for (const key of Object.keys(sampled)) actions.sampleInto(key, sampled[key]);
    if (sampled.roll.pressed) { rollUntilMs = tick * STEP_MS + 300; diagnostics.rolls++; }
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
    renderer.setCamera({ x: 360 + (pose.x - 360) * 0.15, y: 200, zoom: scale });
    for (let x = 0; x <= WORLD_WIDTH; x += 40) renderer.line(x, 0, x, WORLD_HEIGHT, 1, COLORS.grid);
    for (let y = 0; y <= WORLD_HEIGHT; y += 40) renderer.line(0, y, WORLD_WIDTH, y, 1, COLORS.grid);
    if (target) { renderer.ellipse(target.x, target.y, 8, 4, COLORS.target, 12); }
    // Game chooses explicit painter order: all shadows, then sorted body + health.
    for (let i = 0; i < records.length; i++) {
      app.timeline.sampleInto(records[i].id, 0, now, poses[i]);
      poses[i].actor = i === 0;
      renderer.ellipse(poses[i].x, poses[i].y, i ? 9 : 16, i ? 4 : 6, COLORS.shadow, 12);
    }
    // Reuse sortable view; pose sampling/authority are not sorted or mutated by renderer.
    sorted.length = 0; for (const item of poses) sorted.push(item); sorted.sort((a, b) => a.y - b.y);
    for (const item of sorted) {
      renderer.rect(item.x, item.y - item.z - 8, item.actor ? 24 : 14, item.actor ? 24 : 14, item.actor ? COLORS.body : COLORS.satellite, item.angle);
      renderer.rect(item.x, item.y - item.z - 28, 26, 3, COLORS.healthBack);
      renderer.rect(item.x - 13 + 13 * item.health / 100, item.y - item.z - 28, 26 * item.health / 100, 3, COLORS.health);
    }
    spriteOptions.angle = tick * STEP_MS / 1000;
    renderer.sprite(texture, 640, 65, 34, 34, spriteOptions);
    const stats = renderer.endFrame(); cpuMs = performance.now() - start;
    diagnostics.frames++; diagnostics.tick = tick; diagnostics.authorityX = actor.x; diagnostics.authorityY = actor.y;
    diagnostics.poseX = pose.x; diagnostics.poseY = pose.y; diagnostics.cpuSubmitMs = cpuMs;
    canvas.dataset.frames = String(diagnostics.frames); canvas.dataset.x = String(pose.x);
    metricFrames++; if (now - lastMetricMs >= 500) { fps = metricFrames * 1000 / (now - lastMetricMs); metricFrames = 0; lastMetricMs = now; }
    diagnostics.fps = fps;
    status.textContent = `${STEP_MS}ms fixed step (${1000 / STEP_MS} TPS) → ${fps.toFixed(1)} observed FPS | ${stats.drawCalls} draws · ${stats.vertices} vertices · ${stats.uploadedBytes} B/frame · ${stats.textureUploads} texture uploads/frame | CPU submit ${cpuMs.toFixed(2)}ms`;
  }
  const sorted = [];
  resize(); receive(lastMs);
  function frame() {
    if (!running) return;
    const now = performance.now(), elapsed = Math.min(250, now - lastMs); lastMs = now;
    if (!paused) {
      if (diagnostics.frameIntervals.length < 180) diagnostics.frameIntervals.push(elapsed);
      accumulator += elapsed; let stepped = false;
      while (accumulator >= STEP_MS) { authorityStep(); accumulator -= STEP_MS; stepped = true; }
      if (stepped) receive(now); render(now);
    }
    raf = requestAnimationFrame(frame);
  }
  function visibility() { lastMs = performance.now(); accumulator = 0; }
  window.addEventListener('resize', resize); document.addEventListener('visibilitychange', visibility);
  if (autoStart) raf = requestAnimationFrame(frame);
  return { actions, input, renderer, diagnostics,
    setZoom(value) { if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new RangeError('zoom must be 0.5..2'); zoom = value; },
    pause(value = true) { paused = value; lastMs = performance.now(); accumulator = 0; },
    dispose() { if (!running) return; running = false; cancelAnimationFrame(raf); input.dispose(); renderer.dispose(); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); },
  };
}

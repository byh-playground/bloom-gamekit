import { InterpolationTimeline } from '../../dist/interpolation.js';

// This adapter is owned by the game. A Worker timestamp is simulation metadata only.
export function createPresentation(stepMs = 100) {
  const timeline = new InterpolationTimeline({
    stepMs, schema: { x: 'number', y: 'number', z: 'number', health: 'number', angle: 'angle', state: 'discrete' },
  });
  const pose = {}; // Shared by camera, body and shadow. Reused every frame.
  return { timeline, pose, receive(packet, receiptMs) { return timeline.accept(packet, receiptMs); },
    frame(nowMs) { return timeline.sampleInto('actor', 0, nowMs, pose) ? pose : null; } };
}

// One application-owned rAF loop, no package timer or simulation driver.
export function startDemo(canvas, status) {
  const app = createPresentation();
  const ctx = canvas.getContext('2d');
  const started = performance.now();
  let sequence = 0, previousTick = -1, frames = 0, running = true;
  function frame(now) {
    if (!running) return;
    const tick = Math.floor((now - started) / 100);
    if (tick !== previousTick) {
      // Coalesced frame gaps deliver only the newest authority, like a Worker mailbox.
      previousTick = tick;
      app.receive({ revision: 0, sequence: sequence++, timeMs: tick * 100,
        entities: [{ id: 'actor', generation: 0, values: {
          x: 60 + (tick % 30) * 14, y: 130, z: 20, health: 100 - tick % 100,
          angle: tick * 0.1, state: 'walking',
        }, teleport: tick % 30 === 0 }] }, now);
    }
    const pose = app.frame(now);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (pose) {
      // All consumers use one sampled pose. Body-only hitstop/animation offsets belong here.
      ctx.fillStyle = '#9ba7b4'; ctx.beginPath(); ctx.ellipse(pose.x, pose.y, 16, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#285cdb'; ctx.fillRect(pose.x - 10, pose.y - pose.z - 20, 20, 20);
      ctx.fillStyle = '#16a36c'; ctx.fillRect(pose.x - 20, pose.y - pose.z - 30, pose.health * 0.4, 4);
      status.textContent = `10 TPS → rAF | x=${pose.x.toFixed(2)} | ${++frames} frames`;
      canvas.dataset.frames = String(frames); canvas.dataset.x = String(pose.x);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return () => { running = false; };
}

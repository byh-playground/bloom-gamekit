const TAU = Math.PI * 2;
function wrap(angle) {
  const value = angle % TAU;
  const positive = value < 0 ? value + TAU : value;
  return positive >= TAU || positive === 0 ? 0 : positive;
}
export function evaluate(kind, from, to, alpha) {
  if (kind === 'discrete') return to;
  if (alpha === 1) return kind === 'angle' ? wrap(to) : to;
  if (alpha === 0) return kind === 'angle' ? wrap(from) : from;
  if (kind === 'angle') {
    const start = wrap(from);
    let delta = wrap(to) - start;
    if (Math.abs(Math.abs(delta) - Math.PI) <= Number.EPSILON * TAU) delta = -Math.PI;
    else if (delta > Math.PI) delta -= TAU;
    else if (delta < -Math.PI) delta += TAU;
    return wrap(start + delta * alpha);
  }
  // Avoid overflowing (to - from) for finite, opposite-sign extremes.
  return Math.sign(from) === Math.sign(to) ? from + (to - from) * alpha : from * (1 - alpha) + to * alpha;
}
export function fraction(track, now, stepMs) {
  return Math.min(1, Math.max(0, (now - track.startedAt) / stepMs));
}
export function retarget(fields, old, target, generation, now, stepMs, snap) {
  const from = target.slice();
  if (old && old.generation === generation && !snap) {
    const alpha = fraction(old, now, stepMs);
    for (let i = 0; i < fields.length; i++) from[i] = evaluate(fields[i][1], old.from[i], old.target[i], alpha);
  }
  return { generation, from, target, startedAt: now };
}

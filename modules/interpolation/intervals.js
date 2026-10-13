// Shared simulation-time intervals for both public presentation APIs.
// A revision is one clock domain. No receipt-time retargeting inside that domain.
export function bufferInterval(track, old, {origin, timeMs, previousTimeMs, stepMs, delayMs, continuous, seeded, initialTimeMs, reset}) {
  const start = continuous ? previousTimeMs : seeded ? (initialTimeMs ?? timeMs-stepMs) : timeMs;
  if (!Number.isFinite(start) || start>timeMs) throw new RangeError('initialTimeMs must be finite and <= timeMs');
  track.startedAt=track.at=origin+start;
  track.durationMs=timeMs-start;
  track.bornAt=continuous ? old.bornAt : reset ? origin+timeMs-delayMs : origin+start;
  track.removedAt=Infinity;
  track.buffered=true;
  const history=continuous ? [...(old.history??[]),old] : [];
  track.history=history.slice(-Math.ceil(delayMs/stepMs)-2).map(({history,...item})=>item);
}
export function intervalAt(track, at) {
  if (!track || at<track.bornAt || at>=track.removedAt) return null;
  if (at>=track.startedAt) return track;
  return track.history.find(item=>at<=item.startedAt+item.durationMs) ?? track.history.at(-1) ?? track;
}
export function retainRemoved(next, previous, {origin,timeMs,nowMs,delayMs}) {
  if (!delayMs) return;
  for (const [id,old] of previous) if (!next.has(id)) {
    const removedAt=Number.isFinite(old.removedAt)?old.removedAt:origin+timeMs;
    if (nowMs-delayMs<removedAt) next.set(id,{...old,removedAt});
  }
}

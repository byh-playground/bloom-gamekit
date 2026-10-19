// Shared simulation-time intervals for both public presentation APIs.
// A revision is one clock domain. No receipt-time retargeting inside that domain.
export function bufferInterval(
    track,
    old,
    { origin, timeMs, previousTimeMs, stepMs, delayMs, continuous, seeded, initialTimeMs, reset },
) {
    const START = continuous ? previousTimeMs : seeded ? (initialTimeMs ?? timeMs - stepMs) : timeMs;
    if (!Number.isFinite(START) || START > timeMs) {
        throw new RangeError('initialTimeMs must be finite and <= timeMs');
    }
    track.startedAt = track.at = origin + START;
    track.durationMs = timeMs - START;
    track.bornAt = continuous ? old.bornAt : reset ? origin + timeMs - delayMs : origin + START;
    track.removedAt = Infinity;
    track.buffered = true;
    // A buffered track is replaced, never mutated, so the retired track joins the ring as-is. Detaching its own
    // history keeps the chain flat without copying every field of every entity on every capture.
    const HISTORY = continuous ? (old.history ?? []) : [];
    if (continuous) {
        old.history = undefined;
        HISTORY.push(old);
        HISTORY.splice(0, Math.max(0, HISTORY.length - Math.ceil(delayMs / stepMs) - 2));
    }
    track.history = HISTORY;
    return START;
}
export function intervalAt(track, at) {
    if (!track || at < track.bornAt || at >= track.removedAt) {
        return null;
    }
    if (at >= track.startedAt) {
        return track;
    }
    return track.history.find((item) => at <= item.startedAt + item.durationMs) ?? track.history.at(-1) ?? track;
}
export function retainRemoved(next, previous, { origin, timeMs, nowMs, delayMs }) {
    if (!delayMs) {
        return;
    }
    for (const [ID, OLD] of previous) {
        if (!next.has(ID)) {
            const REMOVED_AT = Number.isFinite(OLD.removedAt) ? OLD.removedAt : origin + timeMs;
            if (nowMs - delayMs < REMOVED_AT) {
                next.set(ID, {
                    ...OLD,
                    removedAt: REMOVED_AT,
                });
            }
        }
    }
}

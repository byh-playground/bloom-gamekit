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
    const HISTORY = continuous ? [...(old.history ?? []), old] : [];
    track.history = HISTORY.slice(-Math.ceil(delayMs / stepMs) - 2).map(({ history, ...item }) => item);
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

const TAU = Math.PI * 2;
function wrap(angle) {
    const VALUE = angle % TAU;
    const POSITIVE = VALUE < 0 ? VALUE + TAU : VALUE;
    return POSITIVE >= TAU || POSITIVE === 0 ? 0 : POSITIVE;
}
export function evaluate(kind, from, to, alpha) {
    if (kind === 'discrete') {
        return to;
    }
    if (alpha === 1) {
        return kind === 'angle' ? wrap(to) : to;
    }
    if (alpha === 0) {
        return kind === 'angle' ? wrap(from) : from;
    }
    if (kind === 'angle') {
        const START = wrap(from);
        let delta = wrap(to) - START;
        if (Math.abs(Math.abs(delta) - Math.PI) <= Number.EPSILON * TAU) {
            delta = -Math.PI;
        } else if (delta > Math.PI) {
            delta -= TAU;
        } else if (delta < -Math.PI) {
            delta += TAU;
        }
        return wrap(START + delta * alpha);
    }
    // Avoid overflowing (to - from) for finite, opposite-sign extremes.
    return Math.sign(from) === Math.sign(to) ? from + (to - from) * alpha : from * (1 - alpha) + to * alpha;
}
export function fraction(track, now, stepMs) {
    return Math.min(1, Math.max(0, (now - track.startedAt) / stepMs));
}
export function retarget(fields, old, target, generation, now, stepMs, snap, initial, resetFields) {
    const CONTINUED = old && old.generation === generation;
    // initial is already a private validated scalar copy; never retain input values.
    const FROM = !CONTINUED && !snap && initial ? initial : target.slice();
    if (CONTINUED && !snap) {
        const ALPHA = fraction(old, now, stepMs);
        for (let i = 0; i < fields.length; i++) {
            FROM[i] = evaluate(fields[i][1], old.from[i], old.target[i], ALPHA);
        }
    }
    if (resetFields) {
        for (const INDEX of resetFields) {
            FROM[INDEX] = target[INDEX];
        }
    }
    return {
        generation,
        from: FROM,
        target,
        startedAt: now,
    };
}

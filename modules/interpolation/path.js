import { finite } from './schema.js';
// A bounded path belongs to the presentation identity, not to a renderer or effect engine.
export function pathPlan(declaration, indices) {
    if (!declaration) {
        return null;
    }
    const X = indices.get(declaration.x),
        Y = indices.get(declaration.y),
        DURATION_MS = finite(declaration.durationMs, 'renderPath.durationMs');
    const MAX_POINTS = declaration.maxPoints ?? 64;
    if (
        X === undefined ||
        Y === undefined ||
        DURATION_MS <= 0 ||
        !Number.isSafeInteger(MAX_POINTS) ||
        MAX_POINTS < 2 ||
        MAX_POINTS > 4096
    ) {
        throw new TypeError('invalid renderPath');
    }
    return {
        x: X,
        y: Y,
        durationMs: DURATION_MS,
        maxPoints: MAX_POINTS,
    };
}
export function capturePath(plan, old, from, target, startMs, timeMs, points, reset, delayMs, stepMs) {
    if (!plan) {
        return null;
    }
    const PATH = reset ? [] : (old ?? []).slice();
    const ADD = (timeMs, x, y) => {
        finite(timeMs, 'path timeMs');
        finite(x, 'path x');
        finite(y, 'path y');
        if (PATH.length && timeMs < PATH.at(-1).timeMs) {
            throw new RangeError('path points must be ordered');
        }
        if (PATH.length && timeMs === PATH.at(-1).timeMs) {
            PATH[PATH.length - 1] = {
                timeMs,
                x,
                y,
            };
        } else {
            PATH.push({
                timeMs,
                x,
                y,
            });
        }
    };
    if (!PATH.length) {
        ADD(startMs, from[plan.x], from[plan.y]);
    }
    if (points !== undefined) {
        if (!Array.isArray(points)) {
            throw new TypeError('pathPoints must be an array');
        }
        for (const POINT of points) {
            if (POINT.timeMs < startMs || POINT.timeMs > timeMs) {
                throw new RangeError('pathPoints must be inside this capture interval');
            }
            ADD(POINT.timeMs, POINT.x, POINT.y);
        }
    }
    ADD(timeMs, target[plan.x], target[plan.y]);
    const FLOOR = timeMs - plan.durationMs - delayMs - stepMs;
    while (PATH.length > 2 && PATH[1].timeMs < FLOOR) {
        PATH.shift();
    }
    return PATH.slice(-plan.maxPoints);
}
export function pointAt(path, timeMs, out) {
    if (!path?.length) {
        return false;
    }
    let a = path[0];
    let b = a;
    for (let i = 1; i < path.length; i++) {
        b = path[i];
        if (timeMs <= b.timeMs) {
            break;
        }
        a = b;
    }
    const T = b.timeMs === a.timeMs ? 1 : Math.max(0, Math.min(1, (timeMs - a.timeMs) / (b.timeMs - a.timeMs)));
    out.timeMs = Math.max(path[0].timeMs, Math.min(timeMs, path.at(-1).timeMs));
    out.x = a.x + (b.x - a.x) * T;
    out.y = a.y + (b.y - a.y) * T;
    return true;
}
export function samplePath(path, timeMs, durationMs, out) {
    let count = 0;
    const WRITE = (point) => {
        const ITEM = out[count] ?? (out[count] = {});
        Object.assign(ITEM, point);
        count++;
    };
    const HEAD = {};
    if (!pointAt(path, timeMs, HEAD)) {
        out.length = 0;
        return out;
    }
    const FLOOR = Math.max(path[0].timeMs, HEAD.timeMs - durationMs),
        TAIL = {};
    pointAt(path, FLOOR, TAIL);
    WRITE(TAIL);
    for (const POINT of path) {
        if (POINT.timeMs > FLOOR && POINT.timeMs < HEAD.timeMs) {
            WRITE(POINT);
        }
    }
    if (HEAD.timeMs > FLOOR) {
        WRITE(HEAD);
    }
    out.length = count;
    return out;
}

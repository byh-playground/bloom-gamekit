const RESERVED = new Set(['debug', 'scene', 'tick']);
// The virtual clock starts here, so absolute-time animation is the same on every open. A scene must freeze the clock
// before this much real time has passed since the page started, or a time the page already read would run backwards.
const EPOCH_MS = 10_000_000;
const TICK = (text) => {
    const VALUE = Number(text);
    if (text === '' || !Number.isSafeInteger(VALUE) || VALUE < 0) {
        throw new RangeError(`tick must be a non-negative integer: ${text}`);
    }
    return VALUE;
};

/**
 * Replaces `performance.now` with a clock that reads `EPOCH_MS` and moves only by `advance(ms)`. `realTime(fn)` runs fn
 * with the real clock (tick timing); `restore()` puts back exactly what `performance.now` was.
 */
let clockFrozen = false;
function freezePerformanceNow() {
    if (clockFrozen) {
        throw new Error('another debug scene holds the frozen clock; dispose it first');
    }
    const PERFORMANCE = globalThis.performance;
    const OWN = Object.getOwnPropertyDescriptor(PERFORMANCE, 'now');
    const REAL = PERFORMANCE.now.bind(PERFORMANCE);
    if (REAL() >= EPOCH_MS) {
        throw new Error(`the debug clock must be frozen within ${EPOCH_MS} ms of page start`);
    }
    let virtual = EPOCH_MS;
    const VIRTUAL_NOW = () => virtual;
    const SET = (now) => Object.defineProperty(PERFORMANCE, 'now', { configurable: true, writable: true, value: now });
    SET(VIRTUAL_NOW);
    clockFrozen = true;
    let restored = false;
    const LIVE = () => {
        if (restored) {
            throw new Error('the debug clock was restored with its scene');
        }
    };
    return {
        clock: {
            now: VIRTUAL_NOW,
            advance(ms) {
                LIVE();
                if (!Number.isFinite(ms) || ms < 0) {
                    throw new RangeError(`clock advance must be a finite non-negative number: ${ms}`);
                }
                virtual += ms;
            },
            realTime(operation) {
                LIVE();
                SET(REAL);
                try {
                    return operation();
                } finally {
                    SET(VIRTUAL_NOW);
                }
            },
        },
        restore() {
            if (OWN) {
                Object.defineProperty(PERFORMANCE, 'now', OWN);
            } else {
                delete PERFORMANCE.now;
            }
            clockFrozen = false;
            restored = true;
        },
    };
}

/**
 * Opens a registered scene from the URL for agent and human inspection: `?debug=1&scene=name&tick=300&...`.
 * The host reads only `debug`, `scene` and `tick`. Every other parameter reaches the scene as the raw string the URL
 * carried; the host declares no types or defaults, so a wrong value fails inside the scene instead of being replaced.
 * A scene that must draw the same picture on every open calls `freezeClock()` from its second argument; the host
 * restores `performance.now` on dispose or failure. Without `debug` nothing is installed and nothing is replaced.
 * On any failure `ready` stays false and `error` holds the message.
 */
export function installDebugHost({ scenes, search = globalThis.location?.search ?? '', target = globalThis } = {}) {
    const QUERY = new URLSearchParams(search);
    if (!QUERY.has('debug')) {
        return null;
    }
    const PARAMS = {};
    for (const [KEY, VALUE] of QUERY) {
        if (!RESERVED.has(KEY)) {
            PARAMS[KEY] = VALUE;
        }
    }
    const NAME = QUERY.get('scene');
    let handle = null,
        frozen = null;
    const RESTORE_CLOCK = () => {
        frozen?.restore();
        frozen = null;
    };
    const CONTEXT = {
        freezeClock() {
            frozen ??= freezePerformanceNow();
            return frozen.clock;
        },
    };
    const DEBUG = {
        ready: false,
        error: null,
        scene: NAME,
        params: PARAMS,
        tick: 0,
        step(count = 1) {
            if (!handle) {
                throw new Error('scene is not open');
            }
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new RangeError(`step count must be a non-negative integer: ${count}`);
            }
            if (count && typeof handle.step !== 'function') {
                throw new TypeError(`scene ${NAME} has no step`);
            }
            for (let index = 0; index < count; index++) {
                handle.step();
                DEBUG.tick++;
            }
            handle.render?.();
        },
        /** Compact text-able view of what the screen shows. `options` reaches the scene's `state` as given. */
        state(options) {
            return { scene: NAME, params: PARAMS, tick: DEBUG.tick, ...handle.state?.(options) };
        },
        hash() {
            return handle.hash?.();
        },
        dispose() {
            try {
                handle?.dispose?.();
            } finally {
                handle = null;
                DEBUG.ready = false;
                RESTORE_CLOCK();
                if (target.__bloomDebug === DEBUG) {
                    delete target.__bloomDebug;
                }
            }
        },
    };
    target.__bloomDebug = DEBUG;
    DEBUG.done = (async () => {
        if (typeof scenes?.[NAME] !== 'function') {
            throw new Error(`unknown scene: ${NAME}`);
        }
        handle = (await scenes[NAME](PARAMS, CONTEXT)) ?? {};
        if (QUERY.has('tick')) {
            DEBUG.step(TICK(QUERY.get('tick')));
        } else {
            handle.render?.();
        }
        DEBUG.ready = true;
    })().catch((error) => {
        // A scene that failed to open leaves no frozen clock behind; its handle may still need dispose.
        RESTORE_CLOCK();
        DEBUG.error = String(error?.stack || error);
        console.error(error);
    });
    return DEBUG;
}

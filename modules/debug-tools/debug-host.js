const RESERVED = new Set(['debug', 'scene', 'tick']);
const TICK = (text) => {
    const VALUE = Number(text);
    if (text === '' || !Number.isSafeInteger(VALUE) || VALUE < 0) {
        throw new RangeError(`tick must be a non-negative integer: ${text}`);
    }
    return VALUE;
};

/**
 * Opens a registered scene from the URL for agent and human inspection: `?debug=1&scene=name&tick=300&...`.
 * The host reads only `debug`, `scene` and `tick`. Every other parameter reaches the scene as the raw string the URL
 * carried; the host declares no types or defaults, so a wrong value fails inside the scene instead of being replaced.
 * Without `debug` nothing is installed. On any failure `ready` stays false and `error` holds the message.
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
    let handle = null;
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
        /** Compact text-able view of what the screen shows. The scene supplies the game fields. */
        state() {
            return { scene: NAME, params: PARAMS, tick: DEBUG.tick, ...handle.state?.() };
        },
        hash() {
            return handle.hash?.();
        },
        dispose() {
            handle?.dispose?.();
            handle = null;
            DEBUG.ready = false;
            if (target.__bloomDebug === DEBUG) {
                delete target.__bloomDebug;
            }
        },
    };
    target.__bloomDebug = DEBUG;
    DEBUG.done = (async () => {
        if (typeof scenes?.[NAME] !== 'function') {
            throw new Error(`unknown scene: ${NAME}`);
        }
        handle = (await scenes[NAME](PARAMS)) ?? {};
        if (QUERY.has('tick')) {
            DEBUG.step(TICK(QUERY.get('tick')));
        } else {
            handle.render?.();
        }
        DEBUG.ready = true;
    })().catch((error) => {
        DEBUG.error = String(error?.stack || error);
        console.error(error);
    });
    return DEBUG;
}

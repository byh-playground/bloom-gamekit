/** Mount one disposable frame. The consumer supplies its readiness protocol and isolation policy. */
export function mountScenarioFrame({
    container,
    src,
    configure = () => {},
    prepare,
    timeoutMs = 15000,
    timeoutAfterLoad = false,
    loadMessage = 'scenario frame load failed',
    timeoutMessage = 'scenario frame readiness timed out',
} = {}) {
    if (!container || typeof container.append !== 'function' || !src || typeof configure !== 'function') {
        throw new TypeError('scenario frame container/src');
    }
    if (prepare !== undefined && typeof prepare !== 'function') {
        throw new TypeError('scenario frame prepare');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof timeoutAfterLoad !== 'boolean') {
        throw new RangeError('scenario frame timeout');
    }
    const FRAME = document.createElement('iframe');
    const CONTROLLER = new AbortController();
    const SIGNAL = CONTROLLER.signal;
    let timer;
    let onLoad;
    let onError;
    let onAbort;
    const LOADED = new Promise((resolve, reject) => {
        onLoad = () => resolve(true);
        onError = () => reject(new Error(loadMessage));
        onAbort = () => resolve(false);
        FRAME.addEventListener('load', onLoad, { once: true });
        FRAME.addEventListener('error', onError, { once: true });
        SIGNAL.addEventListener('abort', onAbort, { once: true });
    });
    const CLEAN_LOAD_LISTENERS = () => {
        FRAME.removeEventListener('load', onLoad);
        FRAME.removeEventListener('error', onError);
        SIGNAL.removeEventListener('abort', onAbort);
    };
    // A consumer may report ready before the iframe's load event. Keep `loaded`
    // independently live until load, error, or disposal settles it.
    LOADED.then(CLEAN_LOAD_LISTENERS, CLEAN_LOAD_LISTENERS);
    const CANCELLED = new Promise((resolve) => SIGNAL.addEventListener('abort', () => resolve(false), { once: true }));
    let finished = false;
    const TIMEOUT = new Promise((_, reject) => {
        const START = () => {
            if (!finished && !SIGNAL.aborted) {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            }
        };
        if (timeoutAfterLoad) {
            LOADED.then(
                (loaded) => {
                    if (loaded) {
                        START();
                    }
                },
                () => {},
            );
        } else {
            START();
        }
    });
    let ready;
    function dispose() {
        CONTROLLER.abort();
        FRAME.remove();
    }
    try {
        configure(FRAME);
        // Register a message-based readiness listener before navigation can begin.
        const PREPARED = prepare ? Promise.resolve(prepare({ frame: FRAME, loaded: LOADED, signal: SIGNAL })) : LOADED;
        FRAME.src = src;
        container.append(FRAME);
        const LOAD_FAILURE = LOADED.then(() => new Promise(() => {}));
        ready = Promise.race([PREPARED.then(() => !SIGNAL.aborted), LOAD_FAILURE, CANCELLED, TIMEOUT])
            .catch((error) => {
                dispose();
                throw error;
            })
            .finally(() => {
                finished = true;
                clearTimeout(timer);
            });
    } catch (error) {
        clearTimeout(timer);
        dispose();
        throw error;
    }
    return { frame: FRAME, ready, dispose };
}

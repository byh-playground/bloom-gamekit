/** Hosts one prepared display surface and a succession of isolated scenario runs. */
export function createScenarioSurface({ createSurface, prepare } = {}) {
    if (typeof createSurface !== 'function' || typeof prepare !== 'function') {
        throw new TypeError('scenario surface createSurface/prepare');
    }

    let surface;
    let current;
    let disposed = false;

    function mount({ container, scene, active = false } = {}) {
        if (disposed) {
            throw new Error('scenario surface is disposed');
        }
        if (!container || typeof container.append !== 'function' || typeof active !== 'boolean') {
            throw new TypeError('scenario surface container/active');
        }
        current?.dispose();
        if (!surface) {
            const CREATED = createSurface();
            if (typeof CREATED?.element?.remove !== 'function') {
                throw new TypeError('scenario surface element');
            }
            surface = CREATED;
        }

        const SURFACE = surface;
        const CONTROLLER = new AbortController();
        const SIGNAL = CONTROLLER.signal;
        let run;
        let playing = false;

        function sync() {
            if (!run || SIGNAL.aborted || playing === active) {
                return;
            }
            if (active) {
                run.play();
            } else {
                run.pause();
            }
            playing = active;
        }

        function setActive(nextActive) {
            if (typeof nextActive !== 'boolean') {
                throw new TypeError('scenario surface active');
            }
            active = nextActive;
            sync();
        }

        function disposeMount() {
            if (SIGNAL.aborted) {
                return;
            }
            current = null;
            CONTROLLER.abort();
            if (!current) {
                SURFACE.element.remove();
            }
            run?.dispose();
        }

        const HANDLE = { ready: null, setActive, dispose: disposeMount };
        current = HANDLE;
        try {
            container.append(SURFACE.element);
        } catch (error) {
            disposeMount();
            throw error;
        }

        const CANCELLED = new Promise((resolve) => {
            SIGNAL.addEventListener('abort', () => resolve(false), { once: true });
        });
        const PREPARED = Promise.resolve().then(async () => {
            if (SIGNAL.aborted) {
                return false;
            }
            const PREPARED_RUN = await prepare({ surface: SURFACE, scene, signal: SIGNAL });
            if (SIGNAL.aborted) {
                PREPARED_RUN?.dispose?.();
                return false;
            }
            run = PREPARED_RUN;
            if (
                typeof run?.play !== 'function' ||
                typeof run.pause !== 'function' ||
                typeof run.dispose !== 'function'
            ) {
                throw new TypeError('scenario surface run play/pause/dispose');
            }
            sync();
            return !SIGNAL.aborted;
        });
        HANDLE.ready = Promise.race([PREPARED, CANCELLED]).catch((error) => {
            try {
                disposeMount();
            } catch {
                // Cleanup failures must not mask the original preparation error.
            }
            throw error;
        });
        return HANDLE;
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        try {
            current?.dispose();
        } finally {
            surface?.dispose?.();
            surface = null;
        }
    }

    return { mount, dispose };
}

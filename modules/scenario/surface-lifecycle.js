function createMountHandle(setActive, dispose, presented) {
    return {
        ready: null,
        presented,
        setActive(active) {
            if (typeof active !== 'boolean') {
                throw new TypeError('scenario surface active');
            }
            setActive?.(active);
        },
        dispose() {
            const CLEANUP = dispose;
            // Callers may keep a closed handle without keeping its mount scope.
            setActive = dispose = null;
            CLEANUP?.();
        },
    };
}

function createPresentationSignal(onPresent) {
    let resolve;
    const PRESENTED = new Promise((resolvePresentation) => {
        resolve = resolvePresentation;
    });
    return {
        presented: PRESENTED,
        present: () => onPresent?.(),
        finish(value) {
            onPresent = null;
            resolve(value);
        },
    };
}

/** Hosts one prepared display surface and a succession of isolated scenario runs. */
export function createScenarioSurface({ createSurface, prepare, waitForFirstFrame = false } = {}) {
    if (typeof createSurface !== 'function' || typeof prepare !== 'function') {
        throw new TypeError('scenario surface createSurface/prepare');
    }
    if (typeof waitForFirstFrame !== 'boolean') {
        throw new TypeError('scenario surface waitForFirstFrame');
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
        if (!surface) {
            const CREATED = createSurface();
            if (typeof CREATED?.element?.remove !== 'function') {
                throw new TypeError('scenario surface element');
            }
            if (waitForFirstFrame && !CREATED.element.style) {
                throw new TypeError('scenario surface element style');
            }
            surface = CREATED;
        }

        const SURFACE = surface;
        const CONTROLLER = new AbortController();
        const SIGNAL = CONTROLLER.signal;
        let run;
        let playing = false;
        let prepared = false;
        let firstFrame = false;
        let visibility;
        const PRESENTATION = createPresentationSignal(() => {
            firstFrame = true;
            reveal();
        });

        function restoreVisibility() {
            if (visibility) {
                SURFACE.element.style.setProperty('visibility', visibility.value, visibility.priority);
                visibility = null;
            }
        }

        function reveal() {
            if (!visibility || !firstFrame || !prepared || SIGNAL.aborted || current !== HANDLE) {
                return;
            }
            restoreVisibility();
            PRESENTATION.finish(true);
        }

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
            active = nextActive;
            sync();
        }

        function disposeMount() {
            const RUN = run;
            run = null;
            const WAS_CURRENT = current === HANDLE;
            if (WAS_CURRENT) {
                current = null;
            }
            restoreVisibility();
            PRESENTATION.finish(false);
            CONTROLLER.abort();
            try {
                if (WAS_CURRENT && !current) {
                    SURFACE.element.remove();
                }
            } finally {
                RUN?.dispose?.();
            }
        }

        const HANDLE = createMountHandle(setActive, disposeMount, PRESENTATION.presented);
        const CANCELLED = new Promise((resolve) => {
            SIGNAL.addEventListener('abort', () => resolve(false), { once: true });
        });
        const PREPARED = Promise.resolve().then(async () => {
            if (SIGNAL.aborted) {
                return false;
            }
            const PREPARED_RUN = await prepare({
                surface: SURFACE,
                scene,
                signal: SIGNAL,
                present: PRESENTATION.present,
            });
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
            prepared = true;
            reveal();
            return !SIGNAL.aborted;
        });
        HANDLE.ready = Promise.race([PREPARED, CANCELLED]).catch((error) => {
            try {
                HANDLE.dispose();
            } catch {
                // Cleanup failures must not mask the original preparation error.
            }
            throw error;
        });
        const PREVIOUS = current;
        // Aborting the previous mount can synchronously request another scene.
        current = HANDLE;
        try {
            PREVIOUS?.dispose();
            if (!SIGNAL.aborted) {
                if (waitForFirstFrame) {
                    const STYLE = SURFACE.element.style;
                    visibility = {
                        value: STYLE.getPropertyValue('visibility'),
                        priority: STYLE.getPropertyPriority('visibility'),
                    };
                    STYLE.setProperty('visibility', 'hidden', 'important');
                }
                container.append(SURFACE.element);
                if (!waitForFirstFrame && !SIGNAL.aborted) {
                    PRESENTATION.finish(true);
                }
            }
        } catch (error) {
            try {
                HANDLE.dispose();
            } catch {
                // Cleanup failures must not mask the original mount error.
            }
            throw error;
        }
        return HANDLE;
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        const SURFACE = surface;
        surface = createSurface = prepare = null;
        try {
            current?.dispose();
        } finally {
            SURFACE?.dispose?.();
        }
    }

    return { mount, dispose };
}

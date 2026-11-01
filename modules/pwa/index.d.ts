export interface Pwa {
    /** True only after the browser fired `beforeinstallprompt`, until `install()` uses it or the app is installed. */
    readonly installable: boolean;
    /** Shows the browser install prompt. Throws when not installable. */
    install(): Promise<'accepted' | 'dismissed'>;
    /** Waits for registration, a browser update check and any installer it discovers. Does not return whether a newer version exists; onUpdate signals an installed waiting worker. Concurrent checks share one request. Rejects offline, after disposal, or on registration/check failure. */
    checkForUpdate(): Promise<void>;
    /** Activates the waiting service worker, then reloads the page once it takes over. Throws when none is waiting. */
    update(): Promise<void>;
    /** Removes listeners. The registered service worker stays. */
    dispose(): void;
}
export function registerPwa(options: {
    /** URL of the generated sw.js on the game's own origin, e.g. './sw.js'. */
    serviceWorker: string;
    /** A new version is installed and waiting. Show a notice that calls `update()`. */
    onUpdate: () => void;
    /** Registration or install failed, or service workers are unavailable (http page, some private modes). */
    onError: (error: Error) => void;
    /** The browser allows installing now. */
    onInstallable?: () => void;
}): Pwa;

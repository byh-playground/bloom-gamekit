export interface Pwa {
    /** True only after the browser fired `beforeinstallprompt`, until `install()` uses it or the app is installed. */
    readonly installable: boolean;
    /** Shows the browser install prompt. Throws when not installable or disposed. */
    install(): Promise<'accepted' | 'dismissed'>;
    /** Removes listeners. The registered service worker stays. */
    dispose(): void;
}
/** Every page load (reload) runs the latest deployed files. To "check for an update", the game saves and calls `location.reload()`. */
export function registerPwa(options: {
    /** URL of the generated sw.js on the game's own origin, e.g. './sw.js'. */
    serviceWorker: string;
    /** Registration failed, or service workers are unavailable (http page, some private modes, blocked by automation). */
    onError: (error: Error) => void;
    /** The browser allows installing now. */
    onInstallable?: () => void;
}): Pwa;

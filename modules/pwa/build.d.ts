import type { BrowserType } from 'playwright';

/** Types for `dist/pwa-build.mjs`. Every path is relative to the current working directory (the game root). */
export function buildPwa(options: {
    /** Playwright `chromium`, passed in so this module never resolves the game's node_modules. */
    chromium: BrowserType;
    name: string;
    shortName: string;
    description: string;
    lang: string;
    /** Square SVG with a viewBox. */
    icon: string;
    /** Square full-bleed SVG for maskable and apple-touch icons. Without it, `icon` is placed in the 80% safe zone on `backgroundColor`. */
    maskableIcon?: string;
    /** 1200:630 SVG with a viewBox for the OG/Twitter share image. */
    share: string;
    /** `#rrggbb` */
    themeColor: string;
    /** `#rrggbb` */
    backgroundColor: string;
    /** Relative to the manifest (the out folder), e.g. './'. */
    startUrl: string;
    /** Relative folder that contains startUrl, e.g. './'. */
    scope: string;
    /** Published https URL of the out folder, ending with '/'. Used for absolute og:image and og:url. */
    siteUrl: string;
    /** HTML file inside out whose `<!-- bloom-pwa:start -->` … `<!-- bloom-pwa:end -->` block is rewritten. */
    html: string;
    /** Files to precache: relative POSIX paths with `*` and `**`. Each pattern must match at least one file. */
    precache: string[];
    /** Served root folder. sw.js and manifest.webmanifest are written here. */
    out: string;
    /** true: write nothing and throw if any output would change. */
    check: boolean;
}): Promise<{ files: string[]; changed: string[] }>;

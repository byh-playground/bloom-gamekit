/** One text in every supported locale, side by side. A function member owns its locale's word order and particles. */
export type TextPair = Record<string, string | ((values: any) => string)>;
/** A validated message table. Reading a key that is not in the table throws. */
export type Messages<T extends Record<string, TextPair>> = { readonly [K in keyof T]: (values?: object) => string };
export interface Locale {
    /** The page locale, decided once when created. */
    readonly locale: string;
    readonly locales: readonly string[];
    /** Resolves a TextPair in the page locale. Throws unless it defines exactly every supported locale. */
    text(pair: TextPair, values?: object): string;
    /** Validates every pair once, now. Unknown keys throw when read. */
    messages<T extends Record<string, TextPair>>(table: T): Messages<T>;
    /** Sets `<html lang>` and fills `data-i18n="key"` (textContent) and `data-i18n-<attribute>="key"` under `root`. */
    applyPage(root: ParentNode, table: Messages<any>): void;
    /** Saves the choice (not in an isolated scene) and reloads the page with `?<param>=code`. */
    choose(code: string): void;
    /** Grouped number in the page locale. */
    number(value: number): string;
    /** Picks `forms[Intl.PluralRules(locale).select(count)]`, falling back to `forms.other`. */
    plural(count: number, forms: { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>): string;
}
/** `?<param>=` → saved choice → first matching browser language (primary subtag) → `fallback`. */
export function resolveLocale(options: {
    locales: readonly string[];
    fallback: string;
    requested?: string | null;
    saved?: string | null;
    languages?: readonly string[];
}): string;
export function createLocale(options: {
    locales: string[];
    fallback: string;
    /** localStorage key for the player's choice. */
    storageKey: string;
    /** URL parameter that requests a locale. Default `lang`. */
    param?: string;
    /** Debug scenes, showcase iframes and tests: never read or write the saved choice. */
    isolated?: boolean;
    location?: Location;
    navigator?: Navigator;
    storage?: Storage | null;
    document?: Document;
}): Locale;

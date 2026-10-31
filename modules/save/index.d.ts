export type SaveErrorKind = 'conflict' | 'unreadable' | 'storage' | 'closed';
export class SaveError extends Error {
    readonly kind: SaveErrorKind;
}
export interface SaveAdapter {
    /** BroadcastChannel name for cross-tab notices, or null to stay silent. */
    readonly channelName: string | null;
    /** Reads the stored value, lets `body` decide, and writes `value` when `write` is true, as one step. */
    transact(key: string, body: (stored: unknown) => { value: object; write: boolean }): Promise<object>;
    close?(): void;
}
export interface Save<T extends object> {
    /** Last loaded or saved data, without schema and revision. Change it only through update. */
    readonly data: T | null;
    readonly revision: number | null;
    /** True after an unreadable record: the original is preserved and update is refused. */
    readonly locked: boolean;
    load(): Promise<T>;
    /** Saves a mutated copy. Returning false skips the write. Throws a conflict when another tab saved first. */
    update(mutate: (draft: T) => void | boolean): Promise<T>;
    onExternalChange(listener: (event: { revision: number }) => void): () => void;
    dispose(): void;
}
export function createSave<T extends object>(options: {
    adapter: SaveAdapter;
    key: string;
    version: number;
    create: () => T;
    validate: (data: T) => void;
    /** `migrate[n]` turns schema n data into schema n + 1. */
    migrate?: Record<number, (data: any) => any>;
}): Save<T>;
export function indexedDbAdapter(options: { database: string; store?: string; indexedDB?: IDBFactory }): SaveAdapter;
export function localStorageAdapter(options?: { prefix?: string; storage?: Storage }): SaveAdapter;
/** Records are stored shapes: game data plus `schema` and `revision`. */
export function memoryAdapter(records?: Record<string, object>): SaveAdapter;

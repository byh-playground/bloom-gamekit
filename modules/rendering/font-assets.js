import { GlyphAtlas } from './glyph-atlas.js';
const ASSET_FORMAT = 'budmori-glyph-atlas-v2-r8-packbits';
const SHA256 = /^[a-f0-9]{64}$/;
const ASSET_LOADS = new Map();
const DEVICE_ATLASES = new WeakMap();
function exactKeys(value, keys, name) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
    ) {
        throw new TypeError(`${name} has an unsupported schema`);
    }
}
function safeSource(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new TypeError('font source is required');
    }
    exactKeys(source, ['url', 'version', 'sha256', 'bytes'], 'font source');
    const URL_LOCAL = new URL(source.url);
    if (
        !['https:', 'http:'].includes(URL_LOCAL.protocol) ||
        URL_LOCAL.username ||
        URL_LOCAL.password ||
        URL_LOCAL.hash
    ) {
        throw new TypeError('font URL must be an absolute HTTP(S) URL without credentials or fragment');
    }
    if (typeof source.version !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(source.version)) {
        throw new TypeError('font version must be an explicit immutable identifier');
    }
    if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) {
        throw new TypeError('font SHA-256 is invalid');
    }
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 8 * 1024 * 1024) {
        throw new RangeError('font asset byte length must be 1..8388608');
    }
    return Object.freeze({
        url: URL_LOCAL.href,
        version: source.version,
        sha256: source.sha256,
        bytes: source.bytes,
    });
}
async function digest(bytes) {
    if (!globalThis.crypto?.subtle) {
        throw new Error('Web Crypto SHA-256 is required to load font assets');
    }
    const HASH = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(HASH)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function decodeBase64(value) {
    if (
        typeof value !== 'string' ||
        value.length > 8 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        throw new TypeError('font packed mask is invalid base64');
    }
    const BINARY = atob(value);
    const BYTES = new Uint8Array(BINARY.length);
    for (let index = 0; index < BINARY.length; index++) {
        BYTES[index] = BINARY.charCodeAt(index);
    }
    return BYTES;
}
function unpackMask(packed, expectedBytes) {
    const MASK = new Uint8Array(expectedBytes);
    let input = 0;
    let output = 0;
    while (input < packed.length) {
        const TOKEN = packed[input++];
        if (TOKEN < 128) {
            const LENGTH = TOKEN + 1;
            if (input + LENGTH > packed.length || output + LENGTH > MASK.length) {
                throw new Error('font PackBits literal exceeds declared bounds');
            }
            MASK.set(packed.subarray(input, input + LENGTH), output);
            input += LENGTH;
            output += LENGTH;
        } else {
            const LENGTH = (TOKEN & 127) + 3;
            if (input >= packed.length || output + LENGTH > MASK.length) {
                throw new Error('font PackBits run exceeds declared bounds');
            }
            MASK.fill(packed[input++], output, output + LENGTH);
            output += LENGTH;
        }
    }
    if (output !== MASK.length) {
        throw new Error('font PackBits decoded length does not match its declaration');
    }
    return MASK;
}
async function decodeAsset(bytes) {
    let asset;
    try {
        asset = JSON.parse(
            new TextDecoder('utf-8', {
                fatal: true,
            }).decode(bytes),
        );
    } catch {
        throw new Error('font asset is not valid UTF-8 JSON');
    }
    exactKeys(
        asset,
        ['format', 'generatedBy', 'provenance', 'atlas', 'glyphs', 'missingCodePoints', 'packedMaskBase64'],
        'font asset',
    );
    if (asset.format !== ASSET_FORMAT || asset.generatedBy !== 'modules/rendering/scripts/generate-font-atlas.mjs') {
        throw new Error('font asset format or generator version is unsupported');
    }
    exactKeys(
        asset.atlas,
        [
            'width',
            'height',
            'packing',
            'unitsPerEm',
            'ascent',
            'descent',
            'colorFormat',
            'maskDecodedBytes',
            'maskSHA256',
            'codec',
            'packedMaskBytes',
            'packedMaskSHA256',
            'base64EncodedBytes',
            'base64Characters',
            'runtimeRgbaBytes',
            'encodedJsonBytes',
        ],
        'font atlas',
    );
    const {
        width: WIDTH,
        height: HEIGHT,
        maskDecodedBytes: MASK_DECODED_BYTES,
        packedMaskBytes: PACKED_MASK_BYTES,
        runtimeRgbaBytes: RUNTIME_RGBA_BYTES,
    } = asset.atlas;
    if (
        !Number.isSafeInteger(WIDTH) ||
        !Number.isSafeInteger(HEIGHT) ||
        WIDTH < 1 ||
        HEIGHT < 1 ||
        WIDTH * HEIGHT > 16_777_216 ||
        MASK_DECODED_BYTES !== WIDTH * HEIGHT ||
        RUNTIME_RGBA_BYTES !== WIDTH * HEIGHT * 4 ||
        !Number.isSafeInteger(PACKED_MASK_BYTES) ||
        PACKED_MASK_BYTES < 1 ||
        asset.atlas.colorFormat !== 'R8 glyph coverage mask; renderer expands to white RGBA bytes at startup' ||
        asset.atlas.codec !==
            'PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times' ||
        !SHA256.test(asset.atlas.maskSHA256) ||
        !SHA256.test(asset.atlas.packedMaskSHA256)
    ) {
        throw new Error('font atlas dimensions or encoding are invalid');
    }
    if (
        !asset.provenance ||
        asset.provenance.font?.licenseSource !== 'https://github.com/notofonts/noto-cjk' ||
        !asset.provenance.font.license.includes('SIL Open Font License 1.1')
    ) {
        throw new Error('font provenance or license is missing');
    }
    if (!Array.isArray(asset.missingCodePoints) || asset.missingCodePoints.length !== 0) {
        throw new Error('font asset contains missing glyphs');
    }
    if (!asset.glyphs || typeof asset.glyphs !== 'object' || Array.isArray(asset.glyphs)) {
        throw new Error('font glyph inventory is invalid');
    }
    const GLYPH_KEYS = Object.keys(asset.glyphs);
    if (GLYPH_KEYS.length !== asset.provenance.uniqueCodePointCount || GLYPH_KEYS.length !== 750) {
        throw new Error('font glyph inventory differs from the published 750-codepoint version');
    }
    const PACKED = decodeBase64(asset.packedMaskBase64);
    if (PACKED.length !== PACKED_MASK_BYTES || (await digest(PACKED)) !== asset.atlas.packedMaskSHA256) {
        throw new Error('font packed mask hash or length is invalid');
    }
    const MASK = unpackMask(PACKED, MASK_DECODED_BYTES);
    if ((await digest(MASK)) !== asset.atlas.maskSHA256) {
        throw new Error('font decoded mask hash is invalid');
    }
    const DATA = new Uint8Array(RUNTIME_RGBA_BYTES);
    for (let index = 0, pixel = 0; index < MASK.length; index++, pixel += 4) {
        DATA[pixel] = 255;
        DATA[pixel + 1] = 255;
        DATA[pixel + 2] = 255;
        DATA[pixel + 3] = MASK[index];
    }
    return {
        width: WIDTH,
        height: HEIGHT,
        data: DATA,
        glyphs: asset.glyphs,
        unitsPerEm: asset.atlas.unitsPerEm,
        ascent: asset.atlas.ascent,
        descent: asset.atlas.descent,
    };
}
function loadDecoded(source, onProgress) {
    const KEY = `${source.version}:${source.sha256}`;
    let entry = ASSET_LOADS.get(KEY);
    if (!entry) {
        entry = {
            listeners: new Set(),
            progress: null,
            promise: null,
        };
        const EMIT = (progress) => {
            entry.progress = progress;
            for (const LISTENER of entry.listeners) {
                LISTENER(progress);
            }
        };
        entry.promise = (async () => {
            const RESPONSE = await fetch(source.url, {
                mode: 'cors',
                credentials: 'omit',
                cache: 'force-cache',
            });
            if (!RESPONSE.ok || RESPONSE.type === 'opaque') {
                throw new Error(`font request failed (${RESPONSE.status || RESPONSE.type})`);
            }
            const DECLARED_LENGTH = Number(RESPONSE.headers.get('content-length'));
            const TOTAL = Number.isSafeInteger(DECLARED_LENGTH) && DECLARED_LENGTH > 0 ? DECLARED_LENGTH : source.bytes;
            const READER = RESPONSE.body?.getReader();
            let bytes;
            if (READER) {
                const CHUNKS = [];
                let received = 0;
                while (true) {
                    const { done: DONE, value: VALUE } = await READER.read();
                    if (DONE) {
                        break;
                    }
                    received += VALUE.byteLength;
                    if (received > source.bytes) {
                        await READER.cancel();
                        throw new Error('font response exceeds its pinned byte length');
                    }
                    CHUNKS.push(VALUE);
                    EMIT({
                        phase: 'download',
                        loaded: received,
                        total: TOTAL,
                    });
                }
                bytes = new Uint8Array(received);
                let offset = 0;
                for (const CHUNK of CHUNKS) {
                    bytes.set(CHUNK, offset);
                    offset += CHUNK.byteLength;
                }
            } else {
                bytes = new Uint8Array(await RESPONSE.arrayBuffer());
                EMIT({
                    phase: 'download',
                    loaded: bytes.byteLength,
                    total: TOTAL,
                });
            }
            if (bytes.byteLength !== source.bytes) {
                throw new Error(`font byte length mismatch: expected ${source.bytes}, received ${bytes.byteLength}`);
            }
            EMIT({
                phase: 'verify',
                loaded: bytes.byteLength,
                total: source.bytes,
            });
            if ((await digest(bytes)) !== source.sha256) {
                throw new Error('font asset SHA-256 mismatch');
            }
            EMIT({
                phase: 'decode',
                loaded: 0,
                total: 1,
            });
            const DECODED = await decodeAsset(bytes);
            EMIT({
                phase: 'decode',
                loaded: 1,
                total: 1,
            });
            return DECODED;
        })();
        ASSET_LOADS.set(KEY, entry);
        entry.promise.catch(() => {
            if (ASSET_LOADS.get(KEY) === entry) {
                ASSET_LOADS.delete(KEY);
            }
        });
    }
    if (onProgress) {
        entry.listeners.add(onProgress);
        if (entry.progress) {
            onProgress(entry.progress);
        }
    }
    return {
        promise: entry.promise,
        unsubscribe: () => entry.listeners.delete(onProgress),
    };
}
function acquireAtlas(device, source, decoded) {
    let entries = DEVICE_ATLASES.get(device);
    if (!entries) {
        entries = new Map();
        DEVICE_ATLASES.set(device, entries);
    }
    const KEY = `${source.version}:${source.sha256}`;
    let entry = entries.get(KEY);
    if (!entry) {
        entry = {
            references: 0,
            atlas: null,
        };
        entry.atlas = new GlyphAtlas(device, {
            ...decoded,
            missingGlyph: 'error',
        });
        entries.set(KEY, entry);
    }
    entry.references++;
    let released = false;
    return {
        atlas: entry.atlas,
        release() {
            if (released) {
                return false;
            }
            released = true;
            if (--entry.references === 0 && entries.get(KEY) === entry) {
                entry.atlas.dispose();
                entries.delete(KEY);
            }
            return true;
        },
    };
}

/**
 * Loads a caller-selected immutable, integrity-pinned prebaked font asset.
 * The returned loader exposes `ready`, phase progress, cancellation, and lease disposal.
 */
export class FontAssetLoader {
    constructor(device, source, { signal, onProgress } = {}) {
        if (!device || typeof device.createTexture !== 'function') {
            throw new TypeError('a live WebGLDevice is required');
        }
        if (onProgress !== undefined && typeof onProgress !== 'function') {
            throw new TypeError('onProgress must be a function');
        }
        this.device = device;
        this.source = safeSource(source);
        this.state = 'loading';
        this.error = null;
        this.atlas = null;
        this.progress = {
            phase: 'download',
            loaded: 0,
            total: this.source.bytes,
        };
        this._onProgress = onProgress;
        this._signal = signal;
        this._cancelled = false;
        this._lease = null;
        this.ready = this._start();
    }
    _emit(progress) {
        this.progress = progress;
        try {
            this._onProgress?.(progress);
        } catch {
            /* Observer errors do not fail asset loading. */
        }
    }
    async _start() {
        let unsubscribe = null;
        let abortListener = null;
        try {
            if (this._signal?.aborted) {
                throw new DOMException('Font loading aborted', 'AbortError');
            }
            const LOADED = loadDecoded(this.source, (progress) => this._emit(progress));
            unsubscribe = LOADED.unsubscribe;
            const CANCELLATION = new Promise((_, reject) => {
                this._rejectCancel = reject;
                if (this._signal) {
                    abortListener = () => reject(new DOMException('Font loading aborted', 'AbortError'));
                    this._signal.addEventListener('abort', abortListener, {
                        once: true,
                    });
                }
            });
            const DECODED = await Promise.race([LOADED.promise, CANCELLATION]);
            if (this._cancelled || this.state === 'disposed') {
                throw new DOMException('Font loading aborted', 'AbortError');
            }
            this._lease = acquireAtlas(this.device, this.source, DECODED);
            this.atlas = this._lease.atlas;
            this.state = 'ready';
            this._emit({
                phase: 'ready',
                loaded: this.source.bytes,
                total: this.source.bytes,
            });
            return this.atlas;
        } catch (error) {
            if (this._cancelled || error?.name === 'AbortError') {
                this.state = this.state === 'disposed' ? 'disposed' : 'cancelled';
            } else {
                this.state = 'error';
                this.error = error instanceof Error ? error : new Error(String(error));
            }
            this._emit({
                phase: this.state,
                loaded: this.progress.loaded,
                total: this.progress.total,
                ...(this.error
                    ? {
                          error: this.error.message,
                      }
                    : {}),
            });
            throw error;
        } finally {
            unsubscribe?.();
            if (abortListener) {
                this._signal.removeEventListener('abort', abortListener);
            }
            this._rejectCancel = null;
        }
    }
    cancel() {
        if (this.state !== 'loading') {
            return false;
        }
        this._cancelled = true;
        this._rejectCancel?.(new DOMException('Font loading aborted', 'AbortError'));
        return true;
    }
    dispose() {
        if (this.state === 'disposed') {
            return false;
        }
        if (this.state === 'loading') {
            this.cancel();
        }
        this._lease?.release();
        this._lease = null;
        this.atlas = null;
        this.state = 'disposed';
        this._emit({
            phase: 'disposed',
            loaded: this.progress.loaded,
            total: this.progress.total,
        });
        return true;
    }
}

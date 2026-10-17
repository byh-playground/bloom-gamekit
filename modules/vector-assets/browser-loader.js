import { compileVectorAssetCore } from './compiler-core.js';
import { VECTOR_ASSET_QUALITY_PRESETS } from './quality-presets.js';
const MAX_SOURCE_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
async function readBoundedResponse(response, limit) {
    const ADVERTISED = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(ADVERTISED) && ADVERTISED > limit) {
        throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
    }
    if (!response.body?.getReader) {
        const BYTES = new Uint8Array(await response.arrayBuffer());
        if (BYTES.byteLength > limit) {
            throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
        }
        return BYTES;
    }
    const READER = response.body.getReader();
    const CHUNKS = [];
    let length = 0;
    try {
        while (true) {
            const { done: DONE, value: VALUE } = await READER.read();
            if (DONE) {
                break;
            }
            length += VALUE.byteLength;
            if (length > limit) {
                await READER.cancel();
                throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
            }
            CHUNKS.push(VALUE);
        }
    } finally {
        READER.releaseLock?.();
    }
    if (!length) {
        throw new RangeError('SVG response must contain 1 or more bytes');
    }
    const BYTES = new Uint8Array(length);
    let offset = 0;
    for (const CHUNK of CHUNKS) {
        BYTES.set(CHUNK, offset);
        offset += CHUNK.byteLength;
    }
    return BYTES;
}
function validateLoadOptions(url, options) {
    if (
        options === null ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some(
            (key) =>
                ![
                    'sourcePath',
                    'expectedSha256',
                    'maxBytes',
                    'curveSegments',
                    'strokeArcDivisions',
                    'includeSourcePaths',
                    'normalizeCenteredViewBox',
                ].includes(key),
        )
    ) {
        throw new TypeError(
            'load options may contain only sourcePath, expectedSha256, maxBytes, curveSegments, strokeArcDivisions, includeSourcePaths, and normalizeCenteredViewBox',
        );
    }
    const SOURCE_PATH = options.sourcePath ?? url;
    const EXPECTED_SHA256 = options.expectedSha256;
    const MAX_BYTES = options.maxBytes ?? MAX_SOURCE_BYTES;
    const CURVE_SEGMENTS =
        options.curveSegments === undefined
            ? VECTOR_ASSET_QUALITY_PRESETS.standard.curveSegments
            : options.curveSegments;
    const STROKE_ARC_DIVISIONS =
        options.strokeArcDivisions === undefined
            ? VECTOR_ASSET_QUALITY_PRESETS.standard.strokeArcDivisions
            : options.strokeArcDivisions;
    const INCLUDE_SOURCE_PATHS = options.includeSourcePaths ?? false;
    const NORMALIZE_CENTERED_VIEW_BOX = options.normalizeCenteredViewBox ?? false;
    if (typeof SOURCE_PATH !== 'string' || SOURCE_PATH.length < 1 || SOURCE_PATH.length > 2048) {
        throw new TypeError('sourcePath must be a nonempty string of at most 2048 characters');
    }
    if (EXPECTED_SHA256 !== undefined && (typeof EXPECTED_SHA256 !== 'string' || !SHA256.test(EXPECTED_SHA256))) {
        throw new TypeError('expectedSha256 must be a lowercase SHA-256 digest');
    }
    if (!Number.isSafeInteger(MAX_BYTES) || MAX_BYTES < 1 || MAX_BYTES > MAX_SOURCE_BYTES) {
        throw new RangeError('maxBytes must be an integer from 1 through 524288');
    }
    if (!Number.isSafeInteger(CURVE_SEGMENTS) || CURVE_SEGMENTS < 1 || CURVE_SEGMENTS > 64) {
        throw new RangeError('curveSegments must be an integer from 1 to 64');
    }
    if (!Number.isSafeInteger(STROKE_ARC_DIVISIONS) || STROKE_ARC_DIVISIONS < 1 || STROKE_ARC_DIVISIONS > 64) {
        throw new RangeError('strokeArcDivisions must be an integer from 1 to 64');
    }
    if (typeof INCLUDE_SOURCE_PATHS !== 'boolean') {
        throw new TypeError('includeSourcePaths must be a boolean');
    }
    if (typeof NORMALIZE_CENTERED_VIEW_BOX !== 'boolean') {
        throw new TypeError('normalizeCenteredViewBox must be a boolean');
    }
    return {
        sourcePath: SOURCE_PATH,
        expectedSha256: EXPECTED_SHA256,
        maxBytes: MAX_BYTES,
        curveSegments: CURVE_SEGMENTS,
        strokeArcDivisions: STROKE_ARC_DIVISIONS,
        includeSourcePaths: INCLUDE_SOURCE_PATHS,
        normalizeCenteredViewBox: NORMALIZE_CENTERED_VIEW_BOX,
    };
}

/**
 * Creates a startup loader for original SVG assets. Successful compilations are
 * shared by key and retained in a bounded LRU cache; no per-frame work occurs.
 */
export function createVectorAssetLoader({ fetch: fetcher = globalThis.fetch, maxEntries = 64 } = {}) {
    if (typeof fetcher !== 'function') {
        throw new TypeError('A browser fetch function is required');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 1024) {
        throw new RangeError('maxEntries must be an integer from 0 through 1024');
    }
    const CACHE = new Map();
    const IN_FLIGHT = new Map();
    let disposed = false;
    const LOAD = async (input, options = {}) => {
        if (disposed) {
            throw new Error('Vector asset loader is disposed');
        }
        if (!(typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL))) {
            throw new TypeError('load expects an SVG URL string or URL');
        }
        const URL_LOCAL = String(input);
        const SETTINGS = validateLoadOptions(URL_LOCAL, options);
        const KEY = JSON.stringify([
            URL_LOCAL,
            SETTINGS.sourcePath,
            SETTINGS.expectedSha256 ?? null,
            SETTINGS.maxBytes,
            SETTINGS.curveSegments,
            SETTINGS.strokeArcDivisions,
            SETTINGS.normalizeCenteredViewBox,
            SETTINGS.includeSourcePaths,
        ]);
        if (CACHE.has(KEY)) {
            const ASSET = CACHE.get(KEY);
            CACHE.delete(KEY);
            CACHE.set(KEY, ASSET);
            return ASSET;
        }
        if (IN_FLIGHT.has(KEY)) {
            return IN_FLIGHT.get(KEY);
        }
        const PENDING = (async () => {
            const RESPONSE = await fetcher(input);
            if (!RESPONSE?.ok) {
                throw new Error(`Unable to load SVG ${URL_LOCAL}: HTTP ${RESPONSE?.status ?? 'unknown'}`);
            }
            if (disposed) {
                throw new Error('Vector asset loader is disposed');
            }
            const BYTES = await readBoundedResponse(RESPONSE, SETTINGS.maxBytes);
            const CRYPTO_PROVIDER = globalThis.crypto;
            if (!CRYPTO_PROVIDER?.subtle?.digest) {
                throw new Error('Web Crypto SHA-256 is required to compile browser SVG assets');
            }
            const DIGEST = new Uint8Array(await CRYPTO_PROVIDER.subtle.digest('SHA-256', BYTES));
            const SOURCE_SHA256 = [...DIGEST].map((value) => value.toString(16).padStart(2, '0')).join('');
            if (SETTINGS.expectedSha256 && SOURCE_SHA256 !== SETTINGS.expectedSha256) {
                throw new Error(
                    `SVG SHA-256 mismatch for ${URL_LOCAL}: expected ${SETTINGS.expectedSha256}, received ${SOURCE_SHA256}`,
                );
            }
            if (disposed) {
                throw new Error('Vector asset loader is disposed');
            }
            const ASSET = compileVectorAssetCore(
                BYTES,
                SETTINGS.sourcePath,
                {
                    curveSegments: SETTINGS.curveSegments,
                    strokeArcDivisions: SETTINGS.strokeArcDivisions,
                    normalizeCenteredViewBox: SETTINGS.normalizeCenteredViewBox,
                },
                SOURCE_SHA256,
            );
            if (!SETTINGS.includeSourcePaths) {
                delete ASSET.sourcePaths;
            }
            if (maxEntries > 0 && !disposed) {
                CACHE.set(KEY, ASSET);
                while (CACHE.size > maxEntries) {
                    CACHE.delete(CACHE.keys().next().value);
                }
            }
            return ASSET;
        })();
        IN_FLIGHT.set(KEY, PENDING);
        try {
            return await PENDING;
        } finally {
            if (IN_FLIGHT.get(KEY) === PENDING) {
                IN_FLIGHT.delete(KEY);
            }
        }
    };
    const CLEAR = () => {
        const COUNT = CACHE.size;
        CACHE.clear();
        return COUNT;
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        disposed = true;
        CACHE.clear();
        IN_FLIGHT.clear();
        return true;
    };
    return Object.freeze({
        load: LOAD,
        clear: CLEAR,
        dispose: DISPOSE,
        get size() {
            return CACHE.size;
        },
        get pendingCount() {
            return IN_FLIGHT.size;
        },
        get disposed() {
            return disposed;
        },
    });
}

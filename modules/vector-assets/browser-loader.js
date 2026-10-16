import { compileVectorAssetCore } from './compiler-core.js';
import { VECTOR_ASSET_QUALITY_PRESETS } from './quality-presets.js';

const MAX_SOURCE_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

async function readBoundedResponse(response, limit) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new RangeError(`SVG response exceeds the ${limit}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!length) throw new RangeError('SVG response must contain 1 or more bytes');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validateLoadOptions(url, options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['sourcePath', 'expectedSha256', 'maxBytes', 'curveSegments', 'strokeArcDivisions', 'includeSourcePaths', 'normalizeCenteredViewBox'].includes(key))) {
    throw new TypeError('load options may contain only sourcePath, expectedSha256, maxBytes, curveSegments, strokeArcDivisions, includeSourcePaths, and normalizeCenteredViewBox');
  }
  const sourcePath = options.sourcePath ?? url;
  const expectedSha256 = options.expectedSha256;
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  const curveSegments = options.curveSegments === undefined ? VECTOR_ASSET_QUALITY_PRESETS.standard.curveSegments : options.curveSegments;
  const strokeArcDivisions = options.strokeArcDivisions === undefined ? VECTOR_ASSET_QUALITY_PRESETS.standard.strokeArcDivisions : options.strokeArcDivisions;
  const includeSourcePaths = options.includeSourcePaths ?? false;
  const normalizeCenteredViewBox = options.normalizeCenteredViewBox ?? false;
  if (typeof sourcePath !== 'string' || sourcePath.length < 1 || sourcePath.length > 2048) throw new TypeError('sourcePath must be a nonempty string of at most 2048 characters');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256))) throw new TypeError('expectedSha256 must be a lowercase SHA-256 digest');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_BYTES) throw new RangeError('maxBytes must be an integer from 1 through 524288');
  if (!Number.isSafeInteger(curveSegments) || curveSegments < 1 || curveSegments > 64) throw new RangeError('curveSegments must be an integer from 1 to 64');
  if (!Number.isSafeInteger(strokeArcDivisions) || strokeArcDivisions < 1 || strokeArcDivisions > 64) throw new RangeError('strokeArcDivisions must be an integer from 1 to 64');
  if (typeof includeSourcePaths !== 'boolean') throw new TypeError('includeSourcePaths must be a boolean');
  if (typeof normalizeCenteredViewBox !== 'boolean') throw new TypeError('normalizeCenteredViewBox must be a boolean');
  return { sourcePath, expectedSha256, maxBytes, curveSegments, strokeArcDivisions, includeSourcePaths, normalizeCenteredViewBox };
}

/**
 * Creates a startup loader for original SVG assets. Successful compilations are
 * shared by key and retained in a bounded LRU cache; no per-frame work occurs.
 */
export function createVectorAssetLoader({ fetch: fetcher = globalThis.fetch, maxEntries = 64 } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('A browser fetch function is required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 1024) throw new RangeError('maxEntries must be an integer from 0 through 1024');
  const cache = new Map();
  const inFlight = new Map();
  let disposed = false;

  const load = async (input, options = {}) => {
    if (disposed) throw new Error('Vector asset loader is disposed');
    if (!(typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL))) throw new TypeError('load expects an SVG URL string or URL');
    const url = String(input);
    const settings = validateLoadOptions(url, options);
    const key = JSON.stringify([url, settings.sourcePath, settings.expectedSha256 ?? null, settings.maxBytes, settings.curveSegments,
      settings.strokeArcDivisions, settings.normalizeCenteredViewBox, settings.includeSourcePaths]);
    if (cache.has(key)) {
      const asset = cache.get(key);
      cache.delete(key); cache.set(key, asset);
      return asset;
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      const response = await fetcher(input);
      if (!response?.ok) throw new Error(`Unable to load SVG ${url}: HTTP ${response?.status ?? 'unknown'}`);
      if (disposed) throw new Error('Vector asset loader is disposed');
      const bytes = await readBoundedResponse(response, settings.maxBytes);
      const cryptoProvider = globalThis.crypto;
      if (!cryptoProvider?.subtle?.digest) throw new Error('Web Crypto SHA-256 is required to compile browser SVG assets');
      const digest = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', bytes));
      const sourceSha256 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
      if (settings.expectedSha256 && sourceSha256 !== settings.expectedSha256) {
        throw new Error(`SVG SHA-256 mismatch for ${url}: expected ${settings.expectedSha256}, received ${sourceSha256}`);
      }
      if (disposed) throw new Error('Vector asset loader is disposed');
      const asset = compileVectorAssetCore(bytes, settings.sourcePath, {
        curveSegments: settings.curveSegments,
        strokeArcDivisions: settings.strokeArcDivisions,
        normalizeCenteredViewBox: settings.normalizeCenteredViewBox,
      }, sourceSha256);
      if (!settings.includeSourcePaths) delete asset.sourcePaths;
      if (maxEntries > 0 && !disposed) {
        cache.set(key, asset);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return asset;
    })();
    inFlight.set(key, pending);
    try { return await pending; }
    finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
  };

  const clear = () => { const count = cache.size; cache.clear(); return count; };
  const dispose = () => {
    if (disposed) return false;
    disposed = true;
    cache.clear();
    inFlight.clear();
    return true;
  };
  return Object.freeze({ load, clear, dispose, get size() { return cache.size; }, get pendingCount() { return inFlight.size; }, get disposed() { return disposed; } });
}

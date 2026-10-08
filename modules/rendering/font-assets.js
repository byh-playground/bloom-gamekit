import { GlyphAtlas } from './glyph-atlas.js';

const ASSET_FORMAT = 'budmori-glyph-atlas-v2-r8-packbits';
const SHA256 = /^[a-f0-9]{64}$/;
const assetLoads = new Map();
const deviceAtlases = new WeakMap();

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} has an unsupported schema`);
  }
}
function safeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('font source is required');
  exactKeys(source, ['url', 'version', 'sha256', 'bytes'], 'font source');
  const url = new URL(source.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError('font URL must be an absolute HTTP(S) URL without credentials or fragment');
  if (typeof source.version !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(source.version)) throw new TypeError('font version must be an explicit immutable identifier');
  if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) throw new TypeError('font SHA-256 is invalid');
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 8 * 1024 * 1024) throw new RangeError('font asset byte length must be 1..8388608');
  return Object.freeze({ url: url.href, version: source.version, sha256: source.sha256, bytes: source.bytes });
}

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required to load font assets');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > 8 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('font packed mask is invalid base64');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function unpackMask(packed, expectedBytes) {
  const mask = new Uint8Array(expectedBytes);
  let input = 0, output = 0;
  while (input < packed.length) {
    const token = packed[input++];
    if (token < 128) {
      const length = token + 1;
      if (input + length > packed.length || output + length > mask.length) throw new Error('font PackBits literal exceeds declared bounds');
      mask.set(packed.subarray(input, input + length), output); input += length; output += length;
    } else {
      const length = (token & 127) + 3;
      if (input >= packed.length || output + length > mask.length) throw new Error('font PackBits run exceeds declared bounds');
      mask.fill(packed[input++], output, output + length); output += length;
    }
  }
  if (output !== mask.length) throw new Error('font PackBits decoded length does not match its declaration');
  return mask;
}

async function decodeAsset(bytes) {
  let asset;
  try { asset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('font asset is not valid UTF-8 JSON'); }
  exactKeys(asset, ['format', 'generatedBy', 'provenance', 'atlas', 'glyphs', 'missingCodePoints', 'packedMaskBase64'], 'font asset');
  if (asset.format !== ASSET_FORMAT || asset.generatedBy !== 'modules/rendering/scripts/generate-font-atlas.mjs') throw new Error('font asset format or generator version is unsupported');
  exactKeys(asset.atlas, ['width', 'height', 'packing', 'unitsPerEm', 'ascent', 'descent', 'colorFormat', 'maskDecodedBytes', 'maskSHA256', 'codec', 'packedMaskBytes', 'packedMaskSHA256', 'base64EncodedBytes', 'base64Characters', 'runtimeRgbaBytes', 'encodedJsonBytes'], 'font atlas');
  const { width, height, maskDecodedBytes, packedMaskBytes, runtimeRgbaBytes } = asset.atlas;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16_777_216
      || maskDecodedBytes !== width * height || runtimeRgbaBytes !== width * height * 4
      || !Number.isSafeInteger(packedMaskBytes) || packedMaskBytes < 1
      || asset.atlas.colorFormat !== 'R8 glyph coverage mask; renderer expands to white RGBA bytes at startup'
      || asset.atlas.codec !== 'PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times'
      || !SHA256.test(asset.atlas.maskSHA256) || !SHA256.test(asset.atlas.packedMaskSHA256)) throw new Error('font atlas dimensions or encoding are invalid');
  if (!asset.provenance || asset.provenance.font?.licenseSource !== 'https://github.com/notofonts/noto-cjk'
      || !asset.provenance.font.license.includes('SIL Open Font License 1.1')) throw new Error('font provenance or license is missing');
  if (!Array.isArray(asset.missingCodePoints) || asset.missingCodePoints.length !== 0) throw new Error('font asset contains missing glyphs');
  if (!asset.glyphs || typeof asset.glyphs !== 'object' || Array.isArray(asset.glyphs)) throw new Error('font glyph inventory is invalid');
  const glyphKeys = Object.keys(asset.glyphs);
  if (glyphKeys.length !== asset.provenance.uniqueCodePointCount || glyphKeys.length !== 750) throw new Error('font glyph inventory differs from the published 750-codepoint version');
  const packed = decodeBase64(asset.packedMaskBase64);
  if (packed.length !== packedMaskBytes || await digest(packed) !== asset.atlas.packedMaskSHA256) throw new Error('font packed mask hash or length is invalid');
  const mask = unpackMask(packed, maskDecodedBytes);
  if (await digest(mask) !== asset.atlas.maskSHA256) throw new Error('font decoded mask hash is invalid');
  const data = new Uint8Array(runtimeRgbaBytes);
  for (let index = 0, pixel = 0; index < mask.length; index++, pixel += 4) {
    data[pixel] = 255; data[pixel + 1] = 255; data[pixel + 2] = 255; data[pixel + 3] = mask[index];
  }
  return {
    width, height, data, glyphs: asset.glyphs,
    unitsPerEm: asset.atlas.unitsPerEm, ascent: asset.atlas.ascent, descent: asset.atlas.descent,
  };
}

function loadDecoded(source, onProgress) {
  const key = `${source.version}:${source.sha256}`;
  let entry = assetLoads.get(key);
  if (!entry) {
    entry = { listeners: new Set(), progress: null, promise: null };
    const emit = progress => {
      entry.progress = progress;
      for (const listener of entry.listeners) listener(progress);
    };
    entry.promise = (async () => {
      const response = await fetch(source.url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!response.ok || response.type === 'opaque') throw new Error(`font request failed (${response.status || response.type})`);
      const declaredLength = Number(response.headers.get('content-length'));
      const total = Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : source.bytes;
      const reader = response.body?.getReader();
      let bytes;
      if (reader) {
        const chunks = []; let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > source.bytes) { await reader.cancel(); throw new Error('font response exceeds its pinned byte length'); }
          chunks.push(value); emit({ phase: 'download', loaded: received, total });
        }
        bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
        emit({ phase: 'download', loaded: bytes.byteLength, total });
      }
      if (bytes.byteLength !== source.bytes) throw new Error(`font byte length mismatch: expected ${source.bytes}, received ${bytes.byteLength}`);
      emit({ phase: 'verify', loaded: bytes.byteLength, total: source.bytes });
      if (await digest(bytes) !== source.sha256) throw new Error('font asset SHA-256 mismatch');
      emit({ phase: 'decode', loaded: 0, total: 1 });
      const decoded = await decodeAsset(bytes);
      emit({ phase: 'decode', loaded: 1, total: 1 });
      return decoded;
    })();
    assetLoads.set(key, entry);
    entry.promise.catch(() => { if (assetLoads.get(key) === entry) assetLoads.delete(key); });
  }
  if (onProgress) {
    entry.listeners.add(onProgress);
    if (entry.progress) onProgress(entry.progress);
  }
  return { promise: entry.promise, unsubscribe: () => entry.listeners.delete(onProgress) };
}

function acquireAtlas(device, source, decoded) {
  let entries = deviceAtlases.get(device);
  if (!entries) { entries = new Map(); deviceAtlases.set(device, entries); }
  const key = `${source.version}:${source.sha256}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { references: 0, atlas: null };
    entry.atlas = new GlyphAtlas(device, { ...decoded, missingGlyph: 'error' });
    entries.set(key, entry);
  }
  entry.references++;
  let released = false;
  return {
    atlas: entry.atlas,
    release() {
      if (released) return false;
      released = true;
      if (--entry.references === 0 && entries.get(key) === entry) {
        entry.atlas.dispose(); entries.delete(key);
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
    if (!device || typeof device.createTexture !== 'function') throw new TypeError('a live WebGLDevice is required');
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
    this.device = device;
    this.source = safeSource(source);
    this.state = 'loading'; this.error = null; this.atlas = null;
    this.progress = { phase: 'download', loaded: 0, total: this.source.bytes };
    this._onProgress = onProgress; this._signal = signal; this._cancelled = false; this._lease = null;
    this.ready = this._start();
  }

  _emit(progress) {
    this.progress = progress;
    try { this._onProgress?.(progress); } catch { /* Observer errors do not fail asset loading. */ }
  }

  async _start() {
    let unsubscribe = null, abortListener = null;
    try {
      if (this._signal?.aborted) throw new DOMException('Font loading aborted', 'AbortError');
      const loaded = loadDecoded(this.source, progress => this._emit(progress));
      unsubscribe = loaded.unsubscribe;
      const cancellation = new Promise((_, reject) => {
        this._rejectCancel = reject;
        if (this._signal) {
          abortListener = () => reject(new DOMException('Font loading aborted', 'AbortError'));
          this._signal.addEventListener('abort', abortListener, { once: true });
        }
      });
      const decoded = await Promise.race([
        loaded.promise,
        cancellation,
      ]);
      if (this._cancelled || this.state === 'disposed') throw new DOMException('Font loading aborted', 'AbortError');
      this._lease = acquireAtlas(this.device, this.source, decoded);
      this.atlas = this._lease.atlas; this.state = 'ready';
      this._emit({ phase: 'ready', loaded: this.source.bytes, total: this.source.bytes });
      return this.atlas;
    } catch (error) {
      if (this._cancelled || error?.name === 'AbortError') this.state = this.state === 'disposed' ? 'disposed' : 'cancelled';
      else { this.state = 'error'; this.error = error instanceof Error ? error : new Error(String(error)); }
      this._emit({ phase: this.state, loaded: this.progress.loaded, total: this.progress.total,
        ...(this.error ? { error: this.error.message } : {}) });
      throw error;
    } finally {
      unsubscribe?.();
      if (abortListener) this._signal.removeEventListener('abort', abortListener);
      this._rejectCancel = null;
    }
  }

  cancel() {
    if (this.state !== 'loading') return false;
    this._cancelled = true;
    this._rejectCancel?.(new DOMException('Font loading aborted', 'AbortError'));
    return true;
  }

  dispose() {
    if (this.state === 'disposed') return false;
    if (this.state === 'loading') this.cancel();
    this._lease?.release(); this._lease = null; this.atlas = null; this.state = 'disposed';
    this._emit({ phase: 'disposed', loaded: this.progress.loaded, total: this.progress.total });
    return true;
  }
}

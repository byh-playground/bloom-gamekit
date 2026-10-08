/**
 * Prebaked, single-channel-font-style glyph metrics over an RGBA WebGL atlas.
 * Glyph drawing is delegated to a renderer callback so VectorRenderer can apply
 * its current transform, clipping, painter order, and color pipeline.
 *
 * Atlas bytes are top-left-origin RGBA and are uploaded once through WebGLDevice.
 * No DOM canvas, runtime rasterizer, or pixel readback is used here.
 *
 * Metric records are keyed by Unicode code point and have this shape:
 * `{ x, y, width, height, advance, bearingX=0, bearingY=ascent }`, where atlas
 * coordinates are pixels and all other values are units at `unitsPerEm`.
 * `bearingY` is the distance from the alphabetic baseline to the glyph top.
 */
export class GlyphAtlas {
  constructor(device, { width, height, data, glyphs, unitsPerEm = 1, ascent = 0.8, descent = 0.2,
    filter = 'linear', missingGlyph = 'error', replacement = '\uFFFD' } = {}) {
    if (!device || typeof device.createTexture !== 'function' || typeof device.deleteTexture !== 'function') {
      throw new TypeError('device must provide WebGLDevice createTexture/deleteTexture');
    }
    positiveInteger(width, 'width'); positiveInteger(height, 'height'); positive(unitsPerEm, 'unitsPerEm');
    nonNegative(ascent, 'ascent'); nonNegative(descent, 'descent');
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
      throw new TypeError('data must contain width*height*4 RGBA bytes');
    }
    if (!glyphs || typeof glyphs !== 'object') throw new TypeError('glyphs must be a code-point keyed metric object');
    if (!['error', 'skip', 'replacement'].includes(missingGlyph)) throw new RangeError('missingGlyph must be error, skip, or replacement');
    if (typeof replacement !== 'string' || [...replacement].length !== 1) throw new TypeError('replacement must be one Unicode code point');
    this.device = device;
    this.width = width; this.height = height;
    this.unitsPerEm = unitsPerEm; this.ascent = ascent; this.descent = descent;
    this.missingGlyph = missingGlyph; this.replacement = replacement;
    this.glyphs = new Map();
    for (const [key, value] of Object.entries(glyphs)) {
      const codePoint = normalizeCodePoint(key);
      this.glyphs.set(codePoint, validateGlyph(value, width, height, codePoint));
    }
    if (filter !== 'nearest' && filter !== 'linear') throw new RangeError('filter must be nearest or linear');
    this.texture = device.createTexture({ width, height, data }, { format: 'rgba', filter });
    this.disposed = false;
  }

  /** Returns the metrics in the same units as the requested fontSize. */
  measureText(text, { fontSize = this.unitsPerEm, align = 'left' } = {}) {
    this._live(); validateText(text); positive(fontSize, 'fontSize'); validateAlign(align);
    const glyphs = this._resolve(text);
    const width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) * fontSize / this.unitsPerEm;
    return { width, ascent: this.ascent * fontSize / this.unitsPerEm,
      descent: this.descent * fontSize / this.unitsPerEm,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: width };
  }

  /**
   * Emits one callback per visible glyph. The callback receives texture, atlas
   * UVs, destination rectangle, RGBA color, and operation='fill'.
   * Also accepts `(renderer, text, x, y, options)` when renderer provides
   * `drawGlyphQuad(texture, x, y, width, height, uv, color)`.
   */
  fillText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const args = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    return this._draw('fill', args.text, args.x, args.y, args.options, args.drawGlyph);
  }

  /**
   * Emits an outline as eight offset glyph passes. This is a
   * geometric atlas outline; it does not modify or rasterize atlas pixels.
   * `lineWidth` is in destination units.
   */
  strokeText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
    const args = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
    const { text, x, y, options, drawGlyph } = args;
    const { lineWidth = 1, strokeColor = options.color ?? [0, 0, 0, 1] } = options;
    positive(lineWidth, 'lineWidth'); validateColor(strokeColor, 'strokeColor');
    return this._draw('stroke', text, x, y, { ...options, color: strokeColor }, drawGlyph, lineWidth);
  }

  _draw(operation, text, x, y, options, drawGlyph, lineWidth = 0) {
    this._live(); validateText(text); finite(x, 'x'); finite(y, 'y');
    if (typeof drawGlyph !== 'function') throw new TypeError('drawGlyph callback is required');
    const { fontSize = this.unitsPerEm, align = 'left', baseline = 'alphabetic', color = [1, 1, 1, 1] } = options;
    positive(fontSize, 'fontSize'); validateAlign(align); validateColor(color, 'color');
    const resolved = this._resolve(text);
    const scale = fontSize / this.unitsPerEm;
    const advance = resolved.reduce((sum, glyph) => sum + glyph.advance, 0) * scale;
    let penX = x - (align === 'center' ? advance / 2 : align === 'right' ? advance : 0);
    const baselineY = baselineOffset(baseline, fontSize, this.unitsPerEm, this.ascent, this.descent, y);
    const offsets = lineWidth ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, 0]];
    for (const glyph of resolved) {
      if (glyph.width > 0 && glyph.height > 0) {
        const left = penX + glyph.bearingX * scale;
        const top = baselineY - glyph.bearingY * scale;
        for (const [ox, oy] of offsets) drawGlyph({
          texture: this.texture, glyph, codePoint: glyph.codePoint,
          x: left + ox * lineWidth, y: top + oy * lineWidth,
          width: glyph.width * scale, height: glyph.height * scale,
          u0: glyph.x / this.width, v0: glyph.y / this.height,
          u1: (glyph.x + glyph.width) / this.width, v1: (glyph.y + glyph.height) / this.height,
          color, operation: lineWidth ? 'stroke' : operation,
        });
      }
      penX += glyph.advance * scale;
    }
    return { x: x - (align === 'center' ? advance / 2 : align === 'right' ? advance : 0),
      y: baselineY, width: advance, glyphCount: resolved.length };
  }

  _resolve(text) {
    const result = [];
    for (const character of text) {
      let glyph = this.glyphs.get(character.codePointAt(0));
      if (!glyph) {
        if (this.missingGlyph === 'skip') continue;
        if (this.missingGlyph === 'replacement') glyph = this.glyphs.get(this.replacement.codePointAt(0));
        if (!glyph) throw new RangeError(`missing glyph U+${character.codePointAt(0).toString(16).toUpperCase()}`);
      }
      result.push(glyph);
    }
    return result;
  }

  _live() { if (this.disposed) throw new Error('GlyphAtlas is disposed'); }

  /** Idempotently releases the atlas texture through its owning device. */
  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.device.deleteTexture(this.texture);
    this.texture = null;
    return true;
  }
}

function normalizeCodePoint(key) {
  if (/^U\+[0-9a-f]{1,6}$/i.test(key)) return Number.parseInt(key.slice(2), 16);
  const chars = [...key];
  if (chars.length === 1) return chars[0].codePointAt(0);
  if (/^0x[0-9a-f]+$/i.test(key)) return Number.parseInt(key.slice(2), 16);
  throw new TypeError(`invalid glyph key: ${key}`);
}
function normalizeDrawArguments(first, second, third, fourth, fifth) {
  if (first && typeof first.drawGlyphQuad === 'function') {
    const renderer = first, text = second, x = third, y = fourth, options = fifth ?? {};
    return { text, x, y, options, drawGlyph: glyph => renderer.drawGlyphQuad(
      glyph.texture, glyph.x, glyph.y, glyph.width, glyph.height,
      { u0: glyph.u0, v0: glyph.v0, u1: glyph.u1, v1: glyph.v1 }, glyph.color) };
  }
  const text = first, x = second, y = third, options = fourth ?? {};
  return { text, x, y, options, drawGlyph: fifth ?? options.drawGlyph };
}
function validateGlyph(value, atlasWidth, atlasHeight, codePoint) {
  if (!value || typeof value !== 'object') throw new TypeError(`glyph U+${codePoint.toString(16)} must be a metric object`);
  const { x, y, width, height, advance, bearingX = 0, bearingY = 0 } = value;
  for (const [name, number] of Object.entries({ x, y, width, height, advance, bearingX, bearingY })) finite(number, `glyph.${name}`);
  if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > atlasWidth || y + height > atlasHeight || advance < 0) {
    throw new RangeError(`glyph U+${codePoint.toString(16)} has invalid atlas bounds or advance`);
  }
  return Object.freeze({ codePoint, x, y, width, height, advance, bearingX, bearingY });
}
function baselineOffset(baseline, fontSize, units, ascent, descent, y) {
  const scale = fontSize / units;
  switch (baseline) {
    case 'alphabetic': return y;
    case 'top': case 'hanging': return y + ascent * scale;
    case 'middle': return y + (ascent - descent) * scale / 2;
    case 'bottom': case 'ideographic': return y - descent * scale;
    default: throw new RangeError('baseline must be top, hanging, middle, alphabetic, ideographic, or bottom');
  }
}
function validateAlign(value) {
  if (!['left', 'center', 'right'].includes(value)) throw new RangeError('align must be left, center, or right');
}
function validateColor(value, name) {
  if (!value || value.length !== 4) throw new TypeError(`${name} must be [r,g,b,a]`);
  for (let i = 0; i < 4; i++) if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) throw new RangeError(`${name} channels must be in [0,1]`);
}
function validateText(text) { if (typeof text !== 'string') throw new TypeError('text must be a string'); }
function finite(value, name) { if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`); }
function positive(value, name) { finite(value, name); if (value <= 0) throw new RangeError(`${name} must be positive`); }
function nonNegative(value, name) { finite(value, name); if (value < 0) throw new RangeError(`${name} must be non-negative`); }
function positiveInteger(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`); }

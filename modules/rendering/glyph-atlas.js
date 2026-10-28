/**
 * Prebaked, single-channel-font-style glyph metrics over an RGBA WebGL atlas.
 * Glyph drawing is delegated to a renderer callback so VectorRenderer can apply
 * its current transform, clipping, painter order, and color pipeline.
 *
 * Atlas bytes are top-left-origin RGBA and are uploaded once into a region of the device texture atlas array.
 * No DOM canvas, runtime rasterizer, or pixel readback is used here.
 *
 * Metric records are keyed by Unicode code point and have this shape:
 * `{ x, y, width, height, advance, bearingX=0, bearingY=ascent }`, where atlas
 * coordinates are pixels and all other values are units at `unitsPerEm`.
 * `bearingY` is the distance from the alphabetic baseline to the glyph top.
 */
export class GlyphAtlas {
    constructor(
        device,
        {
            width,
            height,
            data,
            glyphs,
            unitsPerEm = 1,
            ascent = 0.8,
            descent = 0.2,
            filter = 'linear',
            missingGlyph = 'error',
            replacement = '\uFFFD',
        } = {},
    ) {
        if (!device?.textureAtlas) {
            throw new TypeError('device must provide a WebGLDevice texture atlas');
        }
        positiveInteger(width, 'width');
        positiveInteger(height, 'height');
        positive(unitsPerEm, 'unitsPerEm');
        nonNegative(ascent, 'ascent');
        nonNegative(descent, 'descent');
        if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
            throw new TypeError('data must contain width*height*4 RGBA bytes');
        }
        if (!glyphs || typeof glyphs !== 'object') {
            throw new TypeError('glyphs must be a code-point keyed metric object');
        }
        if (!['error', 'skip', 'replacement'].includes(missingGlyph)) {
            throw new RangeError('missingGlyph must be error, skip, or replacement');
        }
        if (typeof replacement !== 'string' || [...replacement].length !== 1) {
            throw new TypeError('replacement must be one Unicode code point');
        }
        this.device = device;
        this.width = width;
        this.height = height;
        this.unitsPerEm = unitsPerEm;
        this.ascent = ascent;
        this.descent = descent;
        this.missingGlyph = missingGlyph;
        this.replacement = replacement;
        this.glyphs = new Map();
        for (const [KEY, VALUE] of Object.entries(glyphs)) {
            const CODE_POINT = normalizeCodePoint(KEY);
            this.glyphs.set(CODE_POINT, validateGlyph(VALUE, width, height, CODE_POINT));
        }
        if (filter !== 'nearest' && filter !== 'linear') {
            throw new RangeError('filter must be nearest or linear');
        }
        // The glyph page is one region of the device's shared atlas array; edges extend like CLAMP_TO_EDGE.
        this.region = device.textureAtlas.allocate(width, height, { filter });
        try {
            device.textureAtlas.upload(this.region, { width, height, data }, { extendEdges: true });
        } catch (error) {
            device.textureAtlas.release(this.region);
            throw error;
        }
        this.disposed = false;
    }

    /** Returns the metrics in the same units as the requested fontSize. */
    measureText(text, { fontSize = this.unitsPerEm, align = 'left' } = {}) {
        this._live();
        validateText(text);
        positive(fontSize, 'fontSize');
        validateAlign(align);
        const GLYPHS = this._resolve(text);
        const WIDTH = (GLYPHS.reduce((sum, glyph) => sum + glyph.advance, 0) * fontSize) / this.unitsPerEm;
        return {
            width: WIDTH,
            ascent: (this.ascent * fontSize) / this.unitsPerEm,
            descent: (this.descent * fontSize) / this.unitsPerEm,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: WIDTH,
        };
    }

    /**
     * Emits one callback per visible glyph. The callback receives region (atlas array layer), atlas
     * UVs, destination rectangle, RGBA color, and operation='fill'.
     * Also accepts `(renderer, text, x, y, options)` when renderer provides
     * `drawGlyphQuad(region, x, y, width, height, uv, color)`.
     */
    fillText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
        const ARGS = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
        return this._draw('fill', ARGS.text, ARGS.x, ARGS.y, ARGS.options, ARGS.drawGlyph);
    }

    /**
     * Emits an outline as eight offset glyph passes. This is a
     * geometric atlas outline; it does not modify or rasterize atlas pixels.
     * `lineWidth` is in destination units.
     */
    strokeText(textOrRenderer, xOrText, yOrX, optionsOrY = {}, drawGlyphOrOptions = {}) {
        const ARGS = normalizeDrawArguments(textOrRenderer, xOrText, yOrX, optionsOrY, drawGlyphOrOptions);
        const { text: TEXT, x: X, y: Y, options: OPTIONS, drawGlyph: DRAW_GLYPH } = ARGS;
        const { lineWidth: LINE_WIDTH = 1, strokeColor: STROKE_COLOR = OPTIONS.color ?? [0, 0, 0, 1] } = OPTIONS;
        positive(LINE_WIDTH, 'lineWidth');
        validateColor(STROKE_COLOR, 'strokeColor');
        return this._draw(
            'stroke',
            TEXT,
            X,
            Y,
            {
                ...OPTIONS,
                color: STROKE_COLOR,
            },
            DRAW_GLYPH,
            LINE_WIDTH,
        );
    }
    _draw(operation, text, x, y, options, drawGlyph, lineWidth = 0) {
        this._live();
        validateText(text);
        finite(x, 'x');
        finite(y, 'y');
        if (typeof drawGlyph !== 'function') {
            throw new TypeError('drawGlyph callback is required');
        }
        const {
            fontSize: FONT_SIZE = this.unitsPerEm,
            align: ALIGN = 'left',
            baseline: BASELINE = 'alphabetic',
            color: COLOR = [1, 1, 1, 1],
        } = options;
        positive(FONT_SIZE, 'fontSize');
        validateAlign(ALIGN);
        validateColor(COLOR, 'color');
        const [RU, RV, RW, RH] = this.region.uvRect;
        const RESOLVED = this._resolve(text);
        const SCALE = FONT_SIZE / this.unitsPerEm;
        const ADVANCE = RESOLVED.reduce((sum, glyph) => sum + glyph.advance, 0) * SCALE;
        let penX = x - (ALIGN === 'center' ? ADVANCE / 2 : ALIGN === 'right' ? ADVANCE : 0);
        const BASELINE_Y = baselineOffset(BASELINE, FONT_SIZE, this.unitsPerEm, this.ascent, this.descent, y);
        const OFFSETS = lineWidth
            ? [
                  [-1, -1],
                  [0, -1],
                  [1, -1],
                  [-1, 0],
                  [1, 0],
                  [-1, 1],
                  [0, 1],
                  [1, 1],
              ]
            : [[0, 0]];
        for (const GLYPH of RESOLVED) {
            if (GLYPH.width > 0 && GLYPH.height > 0) {
                const LEFT = penX + GLYPH.bearingX * SCALE;
                const TOP = BASELINE_Y - GLYPH.bearingY * SCALE;
                for (const [OX, OY] of OFFSETS) {
                    drawGlyph({
                        region: this.region,
                        glyph: GLYPH,
                        codePoint: GLYPH.codePoint,
                        x: LEFT + OX * lineWidth,
                        y: TOP + OY * lineWidth,
                        width: GLYPH.width * SCALE,
                        height: GLYPH.height * SCALE,
                        u0: RU + (GLYPH.x / this.width) * RW,
                        v0: RV + (GLYPH.y / this.height) * RH,
                        u1: RU + ((GLYPH.x + GLYPH.width) / this.width) * RW,
                        v1: RV + ((GLYPH.y + GLYPH.height) / this.height) * RH,
                        color: COLOR,
                        operation: lineWidth ? 'stroke' : operation,
                    });
                }
            }
            penX += GLYPH.advance * SCALE;
        }
        return {
            x: x - (ALIGN === 'center' ? ADVANCE / 2 : ALIGN === 'right' ? ADVANCE : 0),
            y: BASELINE_Y,
            width: ADVANCE,
            glyphCount: RESOLVED.length,
        };
    }
    _resolve(text) {
        const RESULT = [];
        for (const CHARACTER of text) {
            let glyph = this.glyphs.get(CHARACTER.codePointAt(0));
            if (!glyph) {
                if (this.missingGlyph === 'skip') {
                    continue;
                }
                if (this.missingGlyph === 'replacement') {
                    glyph = this.glyphs.get(this.replacement.codePointAt(0));
                }
                if (!glyph) {
                    throw new RangeError(`missing glyph U+${CHARACTER.codePointAt(0).toString(16).toUpperCase()}`);
                }
            }
            RESULT.push(glyph);
        }
        return RESULT;
    }
    _live() {
        if (this.disposed) {
            throw new Error('GlyphAtlas is disposed');
        }
    }

    /** Idempotently releases the atlas texture through its owning device. */
    dispose() {
        if (this.disposed) {
            return false;
        }
        this.disposed = true;
        if (this.device.state === 'ready') {
            this.region.atlas.release(this.region);
        }
        this.region = null;
        return true;
    }
}
function normalizeCodePoint(key) {
    if (/^U\+[0-9a-f]{1,6}$/i.test(key)) {
        return Number.parseInt(key.slice(2), 16);
    }
    const CHARS = [...key];
    if (CHARS.length === 1) {
        return CHARS[0].codePointAt(0);
    }
    if (/^0x[0-9a-f]+$/i.test(key)) {
        return Number.parseInt(key.slice(2), 16);
    }
    throw new TypeError(`invalid glyph key: ${key}`);
}
function normalizeDrawArguments(first, second, third, fourth, fifth) {
    if (first && typeof first.drawGlyphQuad === 'function') {
        const RENDERER = first,
            TEXT = second,
            X = third,
            Y = fourth,
            OPTIONS = fifth ?? {};
        return {
            text: TEXT,
            x: X,
            y: Y,
            options: OPTIONS,
            drawGlyph: (glyph) =>
                RENDERER.drawGlyphQuad(
                    glyph.region,
                    glyph.x,
                    glyph.y,
                    glyph.width,
                    glyph.height,
                    {
                        u0: glyph.u0,
                        v0: glyph.v0,
                        u1: glyph.u1,
                        v1: glyph.v1,
                    },
                    glyph.color,
                ),
        };
    }
    const TEXT = first,
        X = second,
        Y = third,
        OPTIONS = fourth ?? {};
    return {
        text: TEXT,
        x: X,
        y: Y,
        options: OPTIONS,
        drawGlyph: fifth ?? OPTIONS.drawGlyph,
    };
}
function validateGlyph(value, atlasWidth, atlasHeight, codePoint) {
    if (!value || typeof value !== 'object') {
        throw new TypeError(`glyph U+${codePoint.toString(16)} must be a metric object`);
    }
    const {
        x: X,
        y: Y,
        width: WIDTH,
        height: HEIGHT,
        advance: ADVANCE,
        bearingX: BEARING_X = 0,
        bearingY: BEARING_Y = 0,
    } = value;
    for (const [NAME, NUMBER] of Object.entries({
        x: X,
        y: Y,
        width: WIDTH,
        height: HEIGHT,
        advance: ADVANCE,
        bearingX: BEARING_X,
        bearingY: BEARING_Y,
    })) {
        finite(NUMBER, `glyph.${NAME}`);
    }
    if (
        X < 0 ||
        Y < 0 ||
        WIDTH < 0 ||
        HEIGHT < 0 ||
        X + WIDTH > atlasWidth ||
        Y + HEIGHT > atlasHeight ||
        ADVANCE < 0
    ) {
        throw new RangeError(`glyph U+${codePoint.toString(16)} has invalid atlas bounds or advance`);
    }
    return Object.freeze({
        codePoint,
        x: X,
        y: Y,
        width: WIDTH,
        height: HEIGHT,
        advance: ADVANCE,
        bearingX: BEARING_X,
        bearingY: BEARING_Y,
    });
}
function baselineOffset(baseline, fontSize, units, ascent, descent, y) {
    const SCALE = fontSize / units;
    switch (baseline) {
        case 'alphabetic':
            return y;
        case 'top':
        case 'hanging':
            return y + ascent * SCALE;
        case 'middle':
            return y + ((ascent - descent) * SCALE) / 2;
        case 'bottom':
        case 'ideographic':
            return y - descent * SCALE;
        default:
            throw new RangeError('baseline must be top, hanging, middle, alphabetic, ideographic, or bottom');
    }
}
function validateAlign(value) {
    if (!['left', 'center', 'right'].includes(value)) {
        throw new RangeError('align must be left, center, or right');
    }
}
function validateColor(value, name) {
    if (!value || value.length !== 4) {
        throw new TypeError(`${name} must be [r,g,b,a]`);
    }
    for (let i = 0; i < 4; i++) {
        if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) {
            throw new RangeError(`${name} channels must be in [0,1]`);
        }
    }
}
function validateText(text) {
    if (typeof text !== 'string') {
        throw new TypeError('text must be a string');
    }
}
function finite(value, name) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be finite`);
    }
}
function positive(value, name) {
    finite(value, name);
    if (value <= 0) {
        throw new RangeError(`${name} must be positive`);
    }
}
function nonNegative(value, name) {
    finite(value, name);
    if (value < 0) {
        throw new RangeError(`${name} must be non-negative`);
    }
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
    }
}

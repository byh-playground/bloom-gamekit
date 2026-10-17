#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ASSET_PATH = path.join(ROOT, 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.json');
const INVENTORY_PATH = path.join(ROOT, 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.inventory.json');
const FONT_FAMILY = 'Noto Sans KR',
    FONT_SIZE = 32,
    CELL = 48,
    WIDTH = 2016,
    PADDING = 6;
const COLUMNS = WIDTH / CELL,
    FONT = `700 ${FONT_SIZE}px "${FONT_FAMILY}"`;
const SHA256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function packMask(mask) {
    const PACKED = [];
    for (let i = 0; i < mask.length;) {
        let run = 1;
        while (run < 130 && i + run < mask.length && mask[i + run] === mask[i]) {
            run++;
        }
        if (run >= 4) {
            PACKED.push(0x80 | (run - 3), mask[i]);
            i += run;
            continue;
        }
        const START = i;
        i += run;
        while (i < mask.length && i - START < 128) {
            let nextRun = 1;
            while (nextRun < 4 && i + nextRun < mask.length && mask[i + nextRun] === mask[i]) {
                nextRun++;
            }
            if (nextRun >= 4) {
                break;
            }
            i += nextRun;
        }
        PACKED.push(i - START - 1, ...mask.subarray(START, i));
    }
    return Uint8Array.from(PACKED);
}
const INVENTORY_BYTES = await readFile(INVENTORY_PATH);
const CANONICAL_INVENTORY_BYTES = Buffer.from(INVENTORY_BYTES.toString('utf8').replace(/\r\n/g, '\n'));
const INVENTORY = JSON.parse(INVENTORY_BYTES.toString('utf8'));
if (
    INVENTORY.schemaVersion !== 1 ||
    INVENTORY.assetVersion !== 'noto-sans-kr-700-v1' ||
    !Array.isArray(INVENTORY.codePoints) ||
    INVENTORY.codePoints.length !== 750 ||
    new Set(INVENTORY.codePoints).size !== 750 ||
    INVENTORY.codePoints.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 0x10ffff)
) {
    throw new Error('The pinned font inventory must contain its exact 750 unique Unicode code points.');
}
const CHARS = INVENTORY.codePoints.map((value) => String.fromCodePoint(value));
const BROWSER = await chromium.launch({
    headless: true,
});
try {
    const PAGE = await BROWSER.newPage();
    const RASTER = await PAGE.evaluate(
        async ({ chars, font, fontFamily, fontSize, cell, columns, padding }) => {
            await document.fonts.load(font, '가나다ABC123');
            if (!document.fonts.check(font, '가나다ABC123')) {
                throw new Error(`Required local font is unavailable: ${fontFamily}`);
            }
            const ROWS = Math.ceil(chars.length / columns),
                CANVAS = document.createElement('canvas');
            CANVAS.width = columns * cell;
            CANVAS.height = ROWS * cell;
            const CONTEXT = CANVAS.getContext('2d', {
                willReadFrequently: true,
            });
            if (!CONTEXT) {
                throw new Error('Canvas2D is unavailable in the local asset generator');
            }
            CONTEXT.font = font;
            CONTEXT.textAlign = 'left';
            CONTEXT.textBaseline = 'alphabetic';
            CONTEXT.fillStyle = '#fff';
            CONTEXT.clearRect(0, 0, CANVAS.width, CANVAS.height);
            const FONT_METRICS = CONTEXT.measureText('한Ag'),
                ASCENT = FONT_METRICS.actualBoundingBoxAscent || fontSize * 0.8;
            const DESCENT = FONT_METRICS.actualBoundingBoxDescent || fontSize * 0.2,
                GLYPHS = Object.create(null),
                MISSING = [];
            for (let index = 0; index < chars.length; index++) {
                const CHAR = chars[index],
                    X = (index % columns) * cell,
                    Y = Math.floor(index / columns) * cell;
                const METRICS = CONTEXT.measureText(CHAR),
                    LEFT = METRICS.actualBoundingBoxLeft || 0;
                const GLYPH_ASCENT = METRICS.actualBoundingBoxAscent || 0;
                const BASELINE_X = X + padding + Math.max(0, LEFT),
                    BASELINE_Y = Y + padding + Math.max(ASCENT, GLYPH_ASCENT);
                CONTEXT.fillText(CHAR, BASELINE_X, BASELINE_Y);
                const SAMPLE = CONTEXT.getImageData(X, Y, cell, cell).data;
                let minX = cell;
                let minY = cell;
                let maxX = -1;
                let maxY = -1;
                for (let py = 0; py < cell; py++) {
                    for (let px = 0; px < cell; px++) {
                        if (SAMPLE[(py * cell + px) * 4 + 3] === 0) {
                            continue;
                        }
                        minX = Math.min(minX, px);
                        minY = Math.min(minY, py);
                        maxX = Math.max(maxX, px);
                        maxY = Math.max(maxY, py);
                    }
                }
                if (!/^\s$/u.test(CHAR) && maxX < 0) {
                    MISSING.push(CHAR.codePointAt(0));
                }
                GLYPHS[`U+${CHAR.codePointAt(0).toString(16).toUpperCase()}`] = {
                    x: maxX < 0 ? 0 : X + minX,
                    y: maxY < 0 ? 0 : Y + minY,
                    width: maxX < 0 ? 0 : maxX - minX + 1,
                    height: maxY < 0 ? 0 : maxY - minY + 1,
                    advance: Math.round(METRICS.width * 1000) / 1000,
                    bearingX: maxX < 0 ? 0 : minX - padding,
                    bearingY: maxY < 0 ? 0 : BASELINE_Y - (Y + minY),
                };
            }
            const RGBA = CONTEXT.getImageData(0, 0, CANVAS.width, CANVAS.height).data,
                MASK = new Uint8Array(CANVAS.width * CANVAS.height);
            for (let i = 0; i < MASK.length; i++) {
                MASK[i] = RGBA[i * 4 + 3];
            }
            let binary = '';
            for (let offset = 0; offset < MASK.length; offset += 0x8000) {
                binary += String.fromCharCode(...MASK.subarray(offset, Math.min(MASK.length, offset + 0x8000)));
            }
            return {
                width: CANVAS.width,
                height: CANVAS.height,
                maskBase64: btoa(binary),
                glyphs: GLYPHS,
                missing: MISSING,
                ascent: Math.round(ASCENT * 1000) / 1000,
                descent: Math.round(DESCENT * 1000) / 1000,
                browser: navigator.userAgent,
                fontMetrics: {
                    ascent: FONT_METRICS.actualBoundingBoxAscent,
                    descent: FONT_METRICS.actualBoundingBoxDescent,
                },
            };
        },
        {
            chars: CHARS,
            font: FONT,
            fontFamily: FONT_FAMILY,
            fontSize: FONT_SIZE,
            cell: CELL,
            columns: COLUMNS,
            padding: PADDING,
        },
    );
    const MASK = Buffer.from(RASTER.maskBase64, 'base64'),
        PACKED_MASK = packMask(MASK);
    const ASSET = {
        format: 'budmori-glyph-atlas-v2-r8-packbits',
        generatedBy: 'modules/rendering/scripts/generate-font-atlas.mjs',
        provenance: {
            source: 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.inventory.json',
            sourceSHA256: SHA256(CANONICAL_INVENTORY_BYTES),
            corpusPolicy:
                'Explicit, versioned Unicode code-point inventory. It is selected by the asset consumer and does not encode game phrases or claim full Unicode coverage.',
            uniqueCodePointCount: CHARS.length,
            uniqueHangulSyllableCount: CHARS.filter((char) => /[\uac00-\ud7a3]/u.test(char)).length,
            uniquePrintableAsciiCount: CHARS.filter(
                (char) => char.codePointAt(0) >= 0x20 && char.codePointAt(0) <= 0x7e,
            ).length,
            font: {
                family: FONT_FAMILY,
                style: '700 normal; white fill mask; geometric outline is generated by GlyphAtlas at runtime',
                sizePixels: FONT_SIZE,
                localOnly: true,
                license:
                    'Noto Sans KR is distributed under the SIL Open Font License 1.1; this prebaked glyph asset was generated from a locally installed font without network access.',
                licenseSource: 'https://github.com/notofonts/noto-cjk',
                browserFontMetrics: RASTER.fontMetrics,
            },
            generatorRuntime: {
                playwrightVersion: '1.63.0',
                browser: RASTER.browser,
            },
            originalBudmoriCorpusSourceSHA256: 'fb0eeb2d0c8529f090bc13d9e0f8f55801764abcfea71a1e77397181cd666bde',
        },
        atlas: {
            width: RASTER.width,
            height: RASTER.height,
            packing: {
                cellPixels: CELL,
                columns: COLUMNS,
                fontPixels: FONT_SIZE,
                paddingPixels: PADDING,
                order: 'ascending Unicode code point',
            },
            unitsPerEm: FONT_SIZE,
            ascent: RASTER.ascent,
            descent: RASTER.descent,
            colorFormat: 'R8 glyph coverage mask; renderer expands to white RGBA bytes at startup',
            maskDecodedBytes: MASK.byteLength,
            maskSHA256: SHA256(MASK),
            codec: 'PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times',
            packedMaskBytes: PACKED_MASK.byteLength,
            packedMaskSHA256: SHA256(PACKED_MASK),
            base64EncodedBytes: PACKED_MASK.byteLength,
            base64Characters: Math.ceil(PACKED_MASK.byteLength / 3) * 4,
            runtimeRgbaBytes: MASK.byteLength * 4,
        },
        glyphs: RASTER.glyphs,
        missingCodePoints: RASTER.missing.map((value) => `U+${value.toString(16).toUpperCase().padStart(4, '0')}`),
        packedMaskBase64: Buffer.from(PACKED_MASK).toString('base64'),
    };
    let output;
    for (let attempt = 0; attempt < 4; attempt++) {
        output = Buffer.from(`${JSON.stringify(ASSET)}\n`);
        if (ASSET.atlas.encodedJsonBytes === output.length) {
            break;
        }
        ASSET.atlas.encodedJsonBytes = output.length;
    }
    output = Buffer.from(`${JSON.stringify(ASSET)}\n`);
    await writeFile(ASSET_PATH, output);
    console.log(
        JSON.stringify(
            {
                output: path.relative(ROOT, ASSET_PATH),
                bytes: output.length,
                glyphs: CHARS.length,
                missing: ASSET.missingCodePoints.length,
                dimensions: `${RASTER.width}x${RASTER.height}`,
                packedMaskBytes: PACKED_MASK.length,
                runtimeRgbaBytes: MASK.length * 4,
                sha256: SHA256(output),
            },
            null,
            2,
        ),
    );
} finally {
    await BROWSER.close();
}

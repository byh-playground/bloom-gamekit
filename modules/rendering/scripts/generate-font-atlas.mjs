#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const assetPath = path.join(root, 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.json');
const inventoryPath = path.join(root, 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.inventory.json');
const FONT_FAMILY = 'Noto Sans KR', FONT_SIZE = 32, CELL = 48, WIDTH = 2016, PADDING = 6;
const COLUMNS = WIDTH / CELL, FONT = `700 ${FONT_SIZE}px "${FONT_FAMILY}"`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function packMask(mask) {
  const packed = [];
  for (let i = 0; i < mask.length;) {
    let run = 1;
    while (run < 130 && i + run < mask.length && mask[i + run] === mask[i]) run++;
    if (run >= 4) { packed.push(0x80 | (run - 3), mask[i]); i += run; continue; }
    const start = i; i += run;
    while (i < mask.length && i - start < 128) {
      let nextRun = 1;
      while (nextRun < 4 && i + nextRun < mask.length && mask[i + nextRun] === mask[i]) nextRun++;
      if (nextRun >= 4) break;
      i += nextRun;
    }
    packed.push(i - start - 1, ...mask.subarray(start, i));
  }
  return Uint8Array.from(packed);
}

const inventoryBytes = await readFile(inventoryPath);
const canonicalInventoryBytes = Buffer.from(inventoryBytes.toString('utf8').replace(/\r\n/g, '\n'));
const inventory = JSON.parse(inventoryBytes.toString('utf8'));
if (inventory.schemaVersion !== 1 || inventory.assetVersion !== 'noto-sans-kr-700-v1'
    || !Array.isArray(inventory.codePoints) || inventory.codePoints.length !== 750
    || new Set(inventory.codePoints).size !== 750
    || inventory.codePoints.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0x10ffff)) {
  throw new Error('The pinned font inventory must contain its exact 750 unique Unicode code points.');
}
const chars = inventory.codePoints.map(value => String.fromCodePoint(value));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const raster = await page.evaluate(async ({ chars, font, fontFamily, fontSize, cell, columns, padding }) => {
    await document.fonts.load(font, '가나다ABC123');
    if (!document.fonts.check(font, '가나다ABC123')) throw new Error(`Required local font is unavailable: ${fontFamily}`);
    const rows = Math.ceil(chars.length / columns), canvas = document.createElement('canvas');
    canvas.width = columns * cell; canvas.height = rows * cell;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas2D is unavailable in the local asset generator');
    context.font = font; context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.fillStyle = '#fff';
    context.clearRect(0, 0, canvas.width, canvas.height);
    const fontMetrics = context.measureText('한Ag'), ascent = fontMetrics.actualBoundingBoxAscent || fontSize * .8;
    const descent = fontMetrics.actualBoundingBoxDescent || fontSize * .2, glyphs = Object.create(null), missing = [];
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index], x = index % columns * cell, y = Math.floor(index / columns) * cell;
      const metrics = context.measureText(char), left = metrics.actualBoundingBoxLeft || 0;
      const glyphAscent = metrics.actualBoundingBoxAscent || 0, glyphDescent = metrics.actualBoundingBoxDescent || 0;
      const baselineX = x + padding + Math.max(0, left), baselineY = y + padding + Math.max(ascent, glyphAscent);
      context.fillText(char, baselineX, baselineY);
      const sample = context.getImageData(x, y, cell, cell).data;
      let minX = cell, minY = cell, maxX = -1, maxY = -1;
      for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) {
        if (sample[(py * cell + px) * 4 + 3] === 0) continue;
        minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
      if (!/^\s$/u.test(char) && maxX < 0) missing.push(char.codePointAt(0));
      glyphs[`U+${char.codePointAt(0).toString(16).toUpperCase()}`] = {
        x: maxX < 0 ? 0 : x + minX, y: maxY < 0 ? 0 : y + minY,
        width: maxX < 0 ? 0 : maxX - minX + 1, height: maxY < 0 ? 0 : maxY - minY + 1,
        advance: Math.round(metrics.width * 1000) / 1000,
        bearingX: maxX < 0 ? 0 : minX - padding, bearingY: maxY < 0 ? 0 : baselineY - (y + minY),
      };
    }
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data, mask = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
    let binary = '';
    for (let offset = 0; offset < mask.length; offset += 0x8000) binary += String.fromCharCode(...mask.subarray(offset, Math.min(mask.length, offset + 0x8000)));
    return { width: canvas.width, height: canvas.height, maskBase64: btoa(binary), glyphs, missing,
      ascent: Math.round(ascent * 1000) / 1000, descent: Math.round(descent * 1000) / 1000,
      browser: navigator.userAgent, fontMetrics: { ascent: fontMetrics.actualBoundingBoxAscent, descent: fontMetrics.actualBoundingBoxDescent } };
  }, { chars, font: FONT, fontFamily: FONT_FAMILY, fontSize: FONT_SIZE, cell: CELL, columns: COLUMNS, padding: PADDING });

  const mask = Buffer.from(raster.maskBase64, 'base64'), packedMask = packMask(mask);
  const asset = {
    format: 'budmori-glyph-atlas-v2-r8-packbits',
    generatedBy: 'modules/rendering/scripts/generate-font-atlas.mjs',
    provenance: {
      source: 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.inventory.json',
      sourceSHA256: sha256(canonicalInventoryBytes),
      corpusPolicy: 'Explicit, versioned Unicode code-point inventory. It is selected by the asset consumer and does not encode game phrases or claim full Unicode coverage.',
      uniqueCodePointCount: chars.length,
      uniqueHangulSyllableCount: chars.filter(char => /[\uac00-\ud7a3]/u.test(char)).length,
      uniquePrintableAsciiCount: chars.filter(char => char.codePointAt(0) >= 0x20 && char.codePointAt(0) <= 0x7e).length,
      font: { family: FONT_FAMILY, style: '700 normal; white fill mask; geometric outline is generated by GlyphAtlas at runtime',
        sizePixels: FONT_SIZE, localOnly: true,
        license: 'Noto Sans KR is distributed under the SIL Open Font License 1.1; this prebaked glyph asset was generated from a locally installed font without network access.',
        licenseSource: 'https://github.com/notofonts/noto-cjk', browserFontMetrics: raster.fontMetrics },
      generatorRuntime: { playwrightVersion: '1.63.0', browser: raster.browser },
      originalBudmoriCorpusSourceSHA256: 'fb0eeb2d0c8529f090bc13d9e0f8f55801764abcfea71a1e77397181cd666bde',
    },
    atlas: { width: raster.width, height: raster.height,
      packing: { cellPixels: CELL, columns: COLUMNS, fontPixels: FONT_SIZE, paddingPixels: PADDING, order: 'ascending Unicode code point' },
      unitsPerEm: FONT_SIZE, ascent: raster.ascent, descent: raster.descent,
      colorFormat: 'R8 glyph coverage mask; renderer expands to white RGBA bytes at startup',
      maskDecodedBytes: mask.byteLength, maskSHA256: sha256(mask),
      codec: 'PackBits RLE: literal token 0..127 is token+1 bytes; run token 128..255 repeats next byte (token&127)+3 times',
      packedMaskBytes: packedMask.byteLength, packedMaskSHA256: sha256(packedMask), base64EncodedBytes: packedMask.byteLength,
      base64Characters: Math.ceil(packedMask.byteLength / 3) * 4, runtimeRgbaBytes: mask.byteLength * 4 },
    glyphs: raster.glyphs, missingCodePoints: raster.missing.map(value => `U+${value.toString(16).toUpperCase().padStart(4, '0')}`),
    packedMaskBase64: Buffer.from(packedMask).toString('base64'),
  };
  let output;
  for (let attempt = 0; attempt < 4; attempt++) {
    output = Buffer.from(`${JSON.stringify(asset)}\n`);
    if (asset.atlas.encodedJsonBytes === output.length) break;
    asset.atlas.encodedJsonBytes = output.length;
  }
  output = Buffer.from(`${JSON.stringify(asset)}\n`);
  await writeFile(assetPath, output);
  console.log(JSON.stringify({ output: path.relative(root, assetPath), bytes: output.length,
    glyphs: chars.length, missing: asset.missingCodePoints.length, dimensions: `${raster.width}x${raster.height}`,
    packedMaskBytes: packedMask.length, runtimeRgbaBytes: mask.length * 4, sha256: sha256(output) }, null, 2));
} finally { await browser.close(); }

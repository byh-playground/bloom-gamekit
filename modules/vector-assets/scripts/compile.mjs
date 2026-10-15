import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const positional = [];
let output = null, curveSegments = 16;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--output' || argument === '--curve-segments') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(argument + ' requires a value');
    if (argument === '--output') output = resolve(root, value);
    else curveSegments = Number(value);
  } else if (argument.startsWith('--')) throw new TypeError('Unsupported compiler option: ' + argument);
  else positional.push(argument);
}
if (positional.length > 1) throw new TypeError('Only one SVG source path may be supplied');
const input = resolve(root, positional[0] ?? 'modules/vector-assets/assets/seed-scout.svg');
const asset = await compileVectorAssetFile(input, input.startsWith(root) ? input.slice(root.length + 1).replaceAll('\\', '/') : input, { curveSegments });
if (output) await writeFile(output, await compiledAssetModuleSource(asset));
const sourceSha256 = createHash('sha256').update(await readFile(input)).digest('hex');
console.log(JSON.stringify({ source: input, sourceSha256, compilerVersion: asset.compilerVersion, compilerOptions: asset.compilerOptions, parts: asset.geometry.partCount,
  vertices: asset.geometry.vertices.length / asset.geometry.strideFloats, triangles: asset.geometry.indices.length / 3,
  expressionVariantBytes: Object.values(asset.geometry.expressionIndices).reduce((total, indices) => total + indices.byteLength, 0),
  geometryBytes: asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength
    + Object.values(asset.geometry.expressionIndices).reduce((total, indices) => total + indices.byteLength, 0),
  expandedGeometryBytes: asset.geometry.indices.length * asset.geometry.strideFloats * 4, output }, null, 2));

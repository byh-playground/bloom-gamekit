import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const input = resolve(root, args.find(argument => !argument.startsWith('--')) ?? 'modules/vector-assets/assets/seed-scout.svg');
const outputAt = args.indexOf('--output');
const output = outputAt < 0 ? null : resolve(root, args[outputAt + 1] ?? '');
if (outputAt >= 0 && (!args[outputAt + 1] || args[outputAt + 1].startsWith('--'))) throw new TypeError('--output requires an output path');
const asset = await compileVectorAssetFile(input, input.startsWith(root) ? input.slice(root.length + 1).replaceAll('\\', '/') : input);
if (output) await writeFile(output, await compiledAssetModuleSource(asset));
const sourceSha256 = createHash('sha256').update(await readFile(input)).digest('hex');
console.log(JSON.stringify({ source: input, sourceSha256, compilerVersion: asset.compilerVersion, parts: asset.geometry.partCount,
  vertices: asset.geometry.vertices.length / asset.geometry.strideFloats, triangles: asset.geometry.indices.length / 3,
  geometryBytes: asset.geometry.vertices.byteLength + asset.geometry.indices.byteLength,
  expandedGeometryBytes: asset.geometry.indices.length * asset.geometry.strideFloats * 4, output }, null, 2));

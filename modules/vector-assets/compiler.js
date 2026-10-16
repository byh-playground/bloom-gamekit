import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetCore } from './compiler-core.js';
export { compileVectorAssetCore } from './compiler-core.js';

export function compileVectorAsset(svgBytes, sourcePath = 'asset.svg', options = {}) {
  const source = Buffer.isBuffer(svgBytes) ? svgBytes : Buffer.from(String(svgBytes), 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  return compileVectorAssetCore(new Uint8Array(source), sourcePath, options, hash);
}

export async function compileVectorAssetFile(svgPath, sourcePath = 'asset.svg', options = {}) {
  const bytes = await readFile(svgPath);
  return compileVectorAsset(bytes, sourcePath, options);
}

function javascriptValue(value) {
  if (value instanceof Float32Array || value instanceof Uint16Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    const constructor = value instanceof Float32Array ? 'Float32Array' : 'Uint16Array';
    return '(()=>{const b=atob(' + JSON.stringify(bytes) + '),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new ' + constructor + '(u.buffer)})()';
  }
  if (Array.isArray(value)) return '[' + value.map(javascriptValue).join(',') + ']';
  if (value && typeof value === 'object') return 'Object.freeze({' + Object.entries(value).map(([key, child]) => JSON.stringify(key) + ':' + javascriptValue(child)).join(',') + '})';
  return JSON.stringify(value) ?? 'null';
}

export function compiledAssetModuleSource(asset, exportName = 'compiledAsset') {
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new TypeError('A JavaScript export identifier is required');
  return `export const ${exportName} = ${javascriptValue(asset)};\n`;
}

export async function bundledAssetSource(root) {
  const asset = await compileVectorAssetFile(resolve(root, 'modules/vector-assets/assets/seed-scout.svg'), 'modules/vector-assets/assets/seed-scout.svg');
  const { sourcePaths, ...runtimeAsset } = asset;
  return compiledAssetModuleSource(runtimeAsset, 'seedScout');
}

export async function bundledStyleExamplesSource(root) {
  const samples = [];
  for (const id of ['yarn-fox', 'sketch-fox']) {
    const sourcePath = `modules/vector-assets/assets/${id}.svg`;
    const bytes = await readFile(resolve(root, sourcePath));
    const asset = await compileVectorAssetFile(resolve(root, sourcePath), sourcePath);
    const { sourcePaths, ...runtimeAsset } = asset;
    samples.push(JSON.stringify(id) + ':Object.freeze({source:' + JSON.stringify(bytes.toString('utf8')) + ',asset:' + javascriptValue(runtimeAsset) + '})');
  }
  return `export const styleSamples=Object.freeze({${samples.join(',')}});\n`;
}

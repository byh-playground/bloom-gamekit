import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetCore } from './compiler-core.js';
export { compileVectorAssetCore } from './compiler-core.js';
export { VECTOR_ASSET_QUALITY_PRESETS } from './quality-presets.js';
export function compileVectorAsset(svgBytes, sourcePath = 'asset.svg', options = {}) {
    const SOURCE = Buffer.isBuffer(svgBytes) ? svgBytes : Buffer.from(String(svgBytes), 'utf8');
    const HASH = createHash('sha256').update(SOURCE).digest('hex');
    return compileVectorAssetCore(new Uint8Array(SOURCE), sourcePath, options, HASH);
}
export async function compileVectorAssetFile(svgPath, sourcePath = 'asset.svg', options = {}) {
    const BYTES = await readFile(svgPath);
    return compileVectorAsset(BYTES, sourcePath, options);
}
function javascriptValue(value) {
    if (value instanceof Float32Array || value instanceof Uint16Array) {
        const BYTES = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
        const CONSTRUCTOR = value instanceof Float32Array ? 'Float32Array' : 'Uint16Array';
        return (
            '(()=>{const b=atob(' +
            JSON.stringify(BYTES) +
            '),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new ' +
            CONSTRUCTOR +
            '(u.buffer)})()'
        );
    }
    if (Array.isArray(value)) {
        return '[' + value.map(javascriptValue).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        return (
            'Object.freeze({' +
            Object.entries(value)
                .map(([key, child]) => JSON.stringify(key) + ':' + javascriptValue(child))
                .join(',') +
            '})'
        );
    }
    return JSON.stringify(value) ?? 'null';
}
export function compiledAssetModuleSource(asset, exportName = 'compiledAsset') {
    if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) {
        throw new TypeError('A JavaScript export identifier is required');
    }
    return `export const ${exportName} = ${javascriptValue(asset)};\n`;
}
export async function bundledAssetSource(root) {
    const ASSET = await compileVectorAssetFile(
        resolve(root, 'modules/vector-assets/assets/seed-scout.svg'),
        'modules/vector-assets/assets/seed-scout.svg',
    );
    const { sourcePaths: SOURCE_PATHS, ...RUNTIME_ASSET } = ASSET;
    return compiledAssetModuleSource(RUNTIME_ASSET, 'seedScout');
}
export async function bundledStyleExamplesSource(root) {
    const SAMPLES = [];
    for (const ID of ['yarn-fox', 'sketch-fox']) {
        const SOURCE_PATH = `modules/vector-assets/assets/${ID}.svg`;
        const BYTES = await readFile(resolve(root, SOURCE_PATH));
        const ASSET = await compileVectorAssetFile(resolve(root, SOURCE_PATH), SOURCE_PATH);
        const { sourcePaths: SOURCE_PATHS, ...RUNTIME_ASSET } = ASSET;
        SAMPLES.push(
            JSON.stringify(ID) +
                ':Object.freeze({source:' +
                JSON.stringify(BYTES.toString('utf8')) +
                ',asset:' +
                javascriptValue(RUNTIME_ASSET) +
                '})',
        );
    }
    return `export const styleSamples=Object.freeze({${SAMPLES.join(',')}});\n`;
}

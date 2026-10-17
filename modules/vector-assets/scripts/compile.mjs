import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileVectorAssetFile, compiledAssetModuleSource } from '../compiler.js';
import { VECTOR_ASSET_QUALITY_PRESETS } from '../quality-presets.js';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ARGS = process.argv.slice(2);
const POSITIONAL = [];
let output = null;
let curveSegments = VECTOR_ASSET_QUALITY_PRESETS.standard.curveSegments;
let strokeArcDivisions = VECTOR_ASSET_QUALITY_PRESETS.standard.strokeArcDivisions;
let outputSeen = false;
let curveSegmentsSeen = false;
let strokeArcDivisionsSeen = false;
for (let index = 0; index < ARGS.length; index++) {
    const ARGUMENT = ARGS[index];
    if (ARGUMENT === '--output' || ARGUMENT === '--curve-segments' || ARGUMENT === '--stroke-arc-divisions') {
        const VALUE = ARGS[++index];
        if (!VALUE || VALUE.startsWith('--')) {
            throw new TypeError(ARGUMENT + ' requires a value');
        }
        if (ARGUMENT === '--output') {
            if (outputSeen) {
                throw new TypeError('--output may be supplied once');
            }
            outputSeen = true;
            output = resolve(ROOT, VALUE);
        } else if (ARGUMENT === '--curve-segments') {
            if (curveSegmentsSeen) {
                throw new TypeError('--curve-segments may be supplied once');
            }
            if (!/^\d+$/.test(VALUE)) {
                throw new TypeError('--curve-segments must be a decimal integer from 1 to 64');
            }
            curveSegmentsSeen = true;
            curveSegments = Number(VALUE);
        } else {
            if (strokeArcDivisionsSeen) {
                throw new TypeError('--stroke-arc-divisions may be supplied once');
            }
            if (!/^\d+$/.test(VALUE)) {
                throw new TypeError('--stroke-arc-divisions must be a decimal integer from 1 to 64');
            }
            strokeArcDivisionsSeen = true;
            strokeArcDivisions = Number(VALUE);
        }
    } else if (ARGUMENT.startsWith('--')) {
        throw new TypeError('Unsupported compiler option: ' + ARGUMENT);
    } else {
        POSITIONAL.push(ARGUMENT);
    }
}
if (POSITIONAL.length > 1) {
    throw new TypeError('Only one SVG source path may be supplied');
}
const INPUT = resolve(ROOT, POSITIONAL[0] ?? 'modules/vector-assets/assets/seed-scout.svg');
const ASSET = await compileVectorAssetFile(
    INPUT,
    INPUT.startsWith(ROOT) ? INPUT.slice(ROOT.length + 1).replaceAll('\\', '/') : INPUT,
    {
        curveSegments,
        strokeArcDivisions,
    },
);
if (output) {
    await writeFile(output, await compiledAssetModuleSource(ASSET));
}
const SOURCE_SHA256 = createHash('sha256')
    .update(await readFile(INPUT))
    .digest('hex');
console.log(
    JSON.stringify(
        {
            source: INPUT,
            sourceSha256: SOURCE_SHA256,
            compilerVersion: ASSET.compilerVersion,
            compilerOptions: ASSET.compilerOptions,
            parts: ASSET.geometry.partCount,
            vertices: ASSET.geometry.vertices.length / ASSET.geometry.strideFloats,
            triangles: ASSET.geometry.indices.length / 3,
            expressionVariantBytes: Object.values(ASSET.geometry.expressionIndices).reduce(
                (total, indices) => total + indices.byteLength,
                0,
            ),
            geometryBytes:
                ASSET.geometry.vertices.byteLength +
                ASSET.geometry.indices.byteLength +
                Object.values(ASSET.geometry.expressionIndices).reduce(
                    (total, indices) => total + indices.byteLength,
                    0,
                ),
            expandedGeometryBytes: ASSET.geometry.indices.length * ASSET.geometry.strideFloats * 4,
            output,
        },
        null,
        2,
    ),
);

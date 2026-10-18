import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 빌드·검증·배포가 공유하는 고정 목록입니다. manifest의 경로를 실행 경로로 신뢰하지 않습니다.
export const MODULES = Object.freeze([
    'interpolation',
    'rendering',
    'vector-assets',
    'vector-assets-loader',
    'input',
    'deterministic',
    'simloop',
    'work-scheduler',
    'transport',
    'replay',
    'rollback',
    'camera',
    'presentation-events',
    'hud',
    'debug-tools',
    'audio',
    'navigation',
    'scenario',
    'object-pool',
]);
export const BUNDLE_FILES = Object.freeze(MODULES.map((name) => `${name}.js`));
export const FONT_ASSETS = Object.freeze([
    Object.freeze({
        source: 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.json',
        file: 'assets/fonts/noto-sans-kr-700-v1.json',
        version: 'noto-sans-kr-700-v1',
    }),
]);
export const MANIFEST_FILE = 'manifest.json';
export const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_LOCAL = (bytes) => createHash('sha256').update(bytes).digest('hex');
export { SHA256_LOCAL as sha256 };
export function createManifest(bundles, assets) {
    return {
        schemaVersion: 2,
        modules: BUNDLE_FILES.map((file) => ({
            file,
            sha256: SHA256_LOCAL(bundles.get(file)),
        })),
        assets: FONT_ASSETS.map(({ file, version }) => {
            const BYTES = assets.get(file);
            if (!BYTES) {
                throw new Error(`Required font asset is missing: ${file}`);
            }
            return {
                file,
                version,
                bytes: BYTES.byteLength,
                sha256: SHA256_LOCAL(BYTES),
            };
        }),
    };
}
const SERIALIZE_MANIFEST = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
export { SERIALIZE_MANIFEST as serializeManifest };
function exactKeys(value, keys) {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key))
    );
}
export function parseManifest(bytes) {
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('유효한 배포 manifest JSON이 필요합니다.');
    }
    if (
        !exactKeys(manifest, ['schemaVersion', 'modules', 'assets']) ||
        manifest.schemaVersion !== 2 ||
        !Array.isArray(manifest.modules) ||
        manifest.modules.length !== BUNDLE_FILES.length ||
        manifest.modules.some(
            (entry, index) =>
                !exactKeys(entry, ['file', 'sha256']) ||
                entry.file !== BUNDLE_FILES[index] ||
                typeof entry.sha256 !== 'string' ||
                !SHA256.test(entry.sha256),
        ) ||
        !Array.isArray(manifest.assets) ||
        manifest.assets.length !== FONT_ASSETS.length ||
        manifest.assets.some(
            (entry, index) =>
                !exactKeys(entry, ['file', 'version', 'bytes', 'sha256']) ||
                entry.file !== FONT_ASSETS[index].file ||
                entry.version !== FONT_ASSETS[index].version ||
                !Number.isSafeInteger(entry.bytes) ||
                entry.bytes < 1 ||
                typeof entry.sha256 !== 'string' ||
                !SHA256.test(entry.sha256),
        )
    ) {
        throw new Error('manifest는 고정된 모듈·font asset 목록과 크기·SHA-256을 정확한 순서로 포함해야 합니다.');
    }
    // 중복 JSON key·비표준 인코딩·불필요한 메타데이터도 canonical bytes 비교로 거부합니다.
    if (!Buffer.from(SERIALIZE_MANIFEST(manifest)).equals(Buffer.from(bytes))) {
        throw new Error('manifest는 결정론적인 canonical JSON이어야 합니다.');
    }
    return manifest;
}
async function readRegularFile(path) {
    if (!(await lstat(path)).isFile()) {
        throw new Error(`배포물은 일반 파일이어야 합니다: ${path}`);
    }
    return readFile(path);
}

// 검증한 bytes를 반환하여 publisher가 검증 후 파일을 다시 읽지 않게 합니다.
export async function readVerifiedDistribution(root, expectedManifestHash) {
    if (
        expectedManifestHash !== undefined &&
        (typeof expectedManifestHash !== 'string' || !SHA256.test(expectedManifestHash))
    ) {
        throw new Error('유효한 manifest SHA-256이 필요합니다.');
    }
    const MANIFEST_BYTES = await readRegularFile(resolve(root, 'dist', MANIFEST_FILE));
    const MANIFEST_HASH = SHA256_LOCAL(MANIFEST_BYTES);
    if (expectedManifestHash !== undefined && MANIFEST_HASH !== expectedManifestHash) {
        throw new Error('검사를 통과한 manifest의 SHA-256과 재빌드 결과가 다릅니다.');
    }
    const MANIFEST = parseManifest(MANIFEST_BYTES);
    const BUNDLES = new Map(),
        ASSETS = new Map();
    for (const { file: FILE, sha256: EXPECTED_HASH } of MANIFEST.modules) {
        const BYTES = await readRegularFile(resolve(root, 'dist', FILE));
        if (SHA256_LOCAL(BYTES) !== EXPECTED_HASH) {
            throw new Error(`${FILE}의 SHA-256이 manifest와 다릅니다.`);
        }
        BUNDLES.set(FILE, BYTES);
    }
    for (const ENTRY of MANIFEST.assets) {
        const SPEC = FONT_ASSETS.find((asset) => asset.file === ENTRY.file);
        if (!SPEC || ENTRY.version !== SPEC.version) {
            throw new Error(`지원하지 않는 font asset 경로/버전입니다: ${ENTRY.file}`);
        }
        const BYTES = await readRegularFile(resolve(root, 'dist', ...ENTRY.file.split('/')));
        if (BYTES.byteLength !== ENTRY.bytes || SHA256_LOCAL(BYTES) !== ENTRY.sha256) {
            throw new Error(`${ENTRY.file}의 길이 또는 SHA-256이 manifest와 다릅니다.`);
        }
        ASSETS.set(ENTRY.file, BYTES);
    }
    return {
        manifest: MANIFEST,
        manifestBytes: MANIFEST_BYTES,
        manifestHash: MANIFEST_HASH,
        bundles: BUNDLES,
        assets: ASSETS,
    };
}

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 빌드·검증·배포가 공유하는 고정 목록입니다. manifest의 경로를 실행 경로로 신뢰하지 않습니다.
export const MODULES = Object.freeze(['interpolation', 'rendering', 'input', 'deterministic', 'simloop', 'transport', 'replay', 'rollback', 'rollback-netcode', 'camera', 'presentation-events', 'hud', 'debug-tools']);
export const BUNDLE_FILES = Object.freeze(MODULES.map((name) => `${name}.js`));
export const MANIFEST_FILE = 'manifest.json';
export const SHA256 = /^[a-f0-9]{64}$/;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createManifest(bundles) {
  return {
    schemaVersion: 1,
    modules: BUNDLE_FILES.map((file) => ({ file, sha256: sha256(bundles.get(file)) })),
  };
}

export const serializeManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('유효한 배포 manifest JSON이 필요합니다.'); }
  if (!exactKeys(manifest, ['schemaVersion', 'modules']) || manifest.schemaVersion !== 1
      || !Array.isArray(manifest.modules) || manifest.modules.length !== BUNDLE_FILES.length
      || manifest.modules.some((entry, index) => !exactKeys(entry, ['file', 'sha256'])
        || entry.file !== BUNDLE_FILES[index] || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))) {
    throw new Error('manifest는 고정된 모듈 목록과 SHA-256만 정확한 순서로 포함해야 합니다.');
  }
  // 중복 JSON key·비표준 인코딩·불필요한 메타데이터도 canonical bytes 비교로 거부합니다.
  if (!Buffer.from(serializeManifest(manifest)).equals(Buffer.from(bytes))) {
    throw new Error('manifest는 결정론적인 canonical JSON이어야 합니다.');
  }
  return manifest;
}

async function readRegularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`배포물은 일반 파일이어야 합니다: ${path}`);
  return readFile(path);
}

// 검증한 bytes를 반환하여 publisher가 검증 후 파일을 다시 읽지 않게 합니다.
export async function readVerifiedDistribution(root, expectedManifestHash) {
  if (expectedManifestHash !== undefined
      && (typeof expectedManifestHash !== 'string' || !SHA256.test(expectedManifestHash))) {
    throw new Error('유효한 manifest SHA-256이 필요합니다.');
  }
  const manifestBytes = await readRegularFile(resolve(root, 'dist', MANIFEST_FILE));
  const manifestHash = sha256(manifestBytes);
  if (expectedManifestHash !== undefined && manifestHash !== expectedManifestHash) {
    throw new Error('검사를 통과한 manifest의 SHA-256과 재빌드 결과가 다릅니다.');
  }
  const manifest = parseManifest(manifestBytes);
  const bundles = new Map();
  for (const { file, sha256: expectedHash } of manifest.modules) {
    const bytes = await readRegularFile(resolve(root, 'dist', file));
    if (sha256(bytes) !== expectedHash) throw new Error(`${file}의 SHA-256이 manifest와 다릅니다.`);
    bundles.set(file, bytes);
  }
  return { manifest, manifestBytes, manifestHash, bundles };
}

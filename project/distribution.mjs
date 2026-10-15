import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ���塤������������ �����ϴ� ���� ����Դϴ�. manifest�� ��θ� ���� ��η� �ŷ����� �ʽ��ϴ�.
export const MODULES = Object.freeze(['interpolation', 'rendering', 'vector-assets', 'input', 'deterministic', 'simloop', 'transport', 'replay', 'rollback', 'camera', 'presentation-events', 'hud', 'debug-tools', 'audio', 'navigation', 'scenario']);
export const BUNDLE_FILES = Object.freeze(MODULES.map((name) => `${name}.js`));
export const FONT_ASSETS = Object.freeze([Object.freeze({
  source: 'modules/rendering/assets/fonts/noto-sans-kr-700-v1.json',
  file: 'assets/fonts/noto-sans-kr-700-v1.json',
  version: 'noto-sans-kr-700-v1',
})]);
export const MANIFEST_FILE = 'manifest.json';
export const SHA256 = /^[a-f0-9]{64}$/;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createManifest(bundles, assets) {
  return {
    schemaVersion: 2,
    modules: BUNDLE_FILES.map((file) => ({ file, sha256: sha256(bundles.get(file)) })),
    assets: FONT_ASSETS.map(({ file, version }) => {
      const bytes = assets.get(file);
      if (!bytes) throw new Error(`Required font asset is missing: ${file}`);
      return { file, version, bytes: bytes.byteLength, sha256: sha256(bytes) };
    }),
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
  catch { throw new Error('��ȿ�� ���� manifest JSON�� �ʿ��մϴ�.'); }
  if (!exactKeys(manifest, ['schemaVersion', 'modules', 'assets']) || manifest.schemaVersion !== 2
      || !Array.isArray(manifest.modules) || manifest.modules.length !== BUNDLE_FILES.length
      || manifest.modules.some((entry, index) => !exactKeys(entry, ['file', 'sha256'])
        || entry.file !== BUNDLE_FILES[index] || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))
      || !Array.isArray(manifest.assets) || manifest.assets.length !== FONT_ASSETS.length
      || manifest.assets.some((entry, index) => !exactKeys(entry, ['file', 'version', 'bytes', 'sha256'])
        || entry.file !== FONT_ASSETS[index].file || entry.version !== FONT_ASSETS[index].version
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256))) {
    throw new Error('manifest�� ������ ��⡤font asset ��ϰ� ũ�⡤SHA-256�� ��Ȯ�� ������ �����ؾ� �մϴ�.');
  }
  // �ߺ� JSON key����ǥ�� ���ڵ������ʿ��� ��Ÿ�����͵� canonical bytes �񱳷� �ź��մϴ�.
  if (!Buffer.from(serializeManifest(manifest)).equals(Buffer.from(bytes))) {
    throw new Error('manifest�� ���������� canonical JSON�̾�� �մϴ�.');
  }
  return manifest;
}

async function readRegularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`�������� �Ϲ� �����̾�� �մϴ�: ${path}`);
  return readFile(path);
}

// ������ bytes�� ��ȯ�Ͽ� publisher�� ���� �� ������ �ٽ� ���� �ʰ� �մϴ�.
export async function readVerifiedDistribution(root, expectedManifestHash) {
  if (expectedManifestHash !== undefined
      && (typeof expectedManifestHash !== 'string' || !SHA256.test(expectedManifestHash))) {
    throw new Error('��ȿ�� manifest SHA-256�� �ʿ��մϴ�.');
  }
  const manifestBytes = await readRegularFile(resolve(root, 'dist', MANIFEST_FILE));
  const manifestHash = sha256(manifestBytes);
  if (expectedManifestHash !== undefined && manifestHash !== expectedManifestHash) {
    throw new Error('�˻縦 ����� manifest�� SHA-256�� ����� ����� �ٸ��ϴ�.');
  }
  const manifest = parseManifest(manifestBytes);
  const bundles = new Map(), assets = new Map();
  for (const { file, sha256: expectedHash } of manifest.modules) {
    const bytes = await readRegularFile(resolve(root, 'dist', file));
    if (sha256(bytes) !== expectedHash) throw new Error(`${file}�� SHA-256�� manifest�� �ٸ��ϴ�.`);
    bundles.set(file, bytes);
  }
  for (const entry of manifest.assets) {
    const spec = FONT_ASSETS.find(asset => asset.file === entry.file);
    if (!spec || entry.version !== spec.version) throw new Error(`�������� �ʴ� font asset ���/�����Դϴ�: ${entry.file}`);
    const bytes = await readRegularFile(resolve(root, 'dist', ...entry.file.split('/')));
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`${entry.file}�� ���� �Ǵ� SHA-256�� manifest�� �ٸ��ϴ�.`);
    assets.set(entry.file, bytes);
  }
  return { manifest, manifestBytes, manifestHash, bundles, assets };
}

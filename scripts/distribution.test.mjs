import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildDistribution } from './build.mjs';
import { BUNDLE_FILES, MODULES, createManifest, parseManifest, readVerifiedDistribution,
  serializeManifest, sha256 } from './distribution.mjs';

const fixtures = () => new Map(BUNDLE_FILES.map((file, index) => [file, Buffer.from(`export const value = ${index};\n`)]));

async function withRoot(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'gamekit-build-test-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function writeDistribution(root, bundles = fixtures()) {
  await mkdir(resolve(root, 'dist'), { recursive: true });
  for (const [file, bytes] of bundles) await writeFile(resolve(root, 'dist', file), bytes);
  const manifestBytes = serializeManifest(createManifest(bundles));
  await writeFile(resolve(root, 'dist/manifest.json'), manifestBytes);
  return sha256(manifestBytes);
}

test('manifest는 정확한 모듈 목록·순서·키·SHA-256과 canonical JSON만 허용한다', () => {
  const valid = createManifest(fixtures());
  assert.deepEqual(parseManifest(Buffer.from(serializeManifest(valid))), valid);
  const invalid = [
    null, [], {}, { ...valid, schemaVersion: 2 }, { ...valid, timestamp: 0 },
    { ...valid, modules: valid.modules.slice(0, 2) },
    { ...valid, modules: [...valid.modules, valid.modules[0]] },
    { ...valid, modules: [valid.modules[0], valid.modules[0], valid.modules[2]] },
    { ...valid, modules: [...valid.modules].reverse() },
    { ...valid, modules: valid.modules.map((item, i) => i === 0 ? { ...item, file: '../interpolation.js' } : item) },
    { ...valid, modules: valid.modules.map((item, i) => i === 0 ? { ...item, sha256: 'bad' } : item) },
    { ...valid, modules: valid.modules.map((item, i) => i === 0 ? { ...item, bytes: 1 } : item) },
  ];
  for (const manifest of invalid) assert.throws(() => parseManifest(Buffer.from(serializeManifest(manifest))), /manifest/);
  assert.throws(() => parseManifest(Buffer.from('{')), /JSON/);
  assert.throws(() => parseManifest(Buffer.from(JSON.stringify(valid))), /canonical/);
  const duplicateKey = serializeManifest(valid).replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,');
  assert.throws(() => parseManifest(Buffer.from(duplicateKey)), /canonical/);
});

test('manifest hash와 모든 실제 번들의 bytes를 검증하고 symlink를 거부한다', async () => withRoot(async (root) => {
  const expected = await writeDistribution(root);
  const verified = await readVerifiedDistribution(root, expected);
  assert.equal(verified.manifestHash, expected);
  assert.deepEqual(verified.bundles, fixtures());
  await assert.rejects(readVerifiedDistribution(root, '0'.repeat(64)), /SHA-256/);
  await assert.rejects(readVerifiedDistribution(root, ''), /SHA-256/);
  for (const file of BUNDLE_FILES) {
    await writeFile(resolve(root, 'dist', file), 'tampered');
    await assert.rejects(readVerifiedDistribution(root, expected), /SHA-256/);
    await writeDistribution(root);
  }
  await rm(resolve(root, 'dist/rendering.js'));
  await assert.rejects(readVerifiedDistribution(root, expected), /ENOENT/);
  await symlink('interpolation.js', resolve(root, 'dist/rendering.js'));
  await assert.rejects(readVerifiedDistribution(root, expected), /일반 파일/);
  await rm(resolve(root, 'dist/rendering.js'));
  await writeDistribution(root);
  await rm(resolve(root, 'dist/manifest.json'));
  await symlink('interpolation.js', resolve(root, 'dist/manifest.json'));
  await assert.rejects(readVerifiedDistribution(root), /일반 파일/);
}));

test('세 모듈은 독립 ESM 하나씩 빌드되며 재빌드 manifest와 bytes가 같다', async () => withRoot(async (root) => {
  for (const [index, name] of MODULES.entries()) {
    const directory = resolve(root, 'packages', name, 'src');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'value.js'), `export const value = ${index};\n`);
    await writeFile(resolve(directory, 'index.js'), "export { value } from './value.js';\n");
  }
  await buildDistribution(root);
  const first = await readVerifiedDistribution(root);
  await buildDistribution(root);
  const second = await readVerifiedDistribution(root, first.manifestHash);
  assert.deepEqual(second.bundles, first.bundles);
  for (const [index, file] of BUNDLE_FILES.entries()) {
    const code = await readFile(resolve(root, 'dist', file), 'utf8');
    assert.doesNotMatch(code, /(?:^|\n)import /);
    const imported = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    assert.equal(imported.value, index);
  }
  // 다른 package 소스나 외부 URL import를 bundle 하나에 숨길 수 없습니다.
  await writeFile(resolve(root, 'packages/interpolation/src/index.js'), "export { value } from '../../input/src/value.js';\n");
  await assert.rejects(buildDistribution(root), /소스 밖/);
  await writeFile(resolve(root, 'packages/interpolation/src/index.js'), "export { value } from 'https://example.invalid/value.js';\n");
  await assert.rejects(buildDistribution(root), /외부 import/);
  await writeFile(resolve(root, 'packages/interpolation/src/index.js'), 'export const load = (name) => import(name);\n');
  await assert.rejects(buildDistribution(root), /not a string literal/);
  await writeFile(resolve(root, 'packages/interpolation/src/index.js'), 'export const load = (name) => require(name);\n');
  await assert.rejects(buildDistribution(root), /not a string literal/);
  // 실패한 재빌드가 직전의 검증된 배포물을 일부만 교체하지 않습니다.
  assert.deepEqual((await readVerifiedDistribution(root, first.manifestHash)).bundles, first.bundles);
}));

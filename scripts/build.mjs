import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODULES, MANIFEST_FILE, createManifest, serializeManifest } from './distribution.mjs';

const SDK_DEPENDENCIES = {
  deterministic: ['_rollback-shared'], simloop: [], transport: ['_rollback-shared', 'deterministic'],
  replay: ['_rollback-shared', 'deterministic'], rollback: ['_rollback-shared', 'deterministic'],
  'rollback-netcode': ['_rollback-shared', 'deterministic', 'simloop', 'transport', 'replay', 'rollback'],
};

export async function buildDistribution(root) {
  const bundles = new Map();
  for (const name of MODULES) {
    // 모듈마다 따로 빌드하여 공유 chunk와 외부 런타임 의존성을 만들지 않습니다.
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`packages/${name}/src/index.js`],
      outfile: `dist/${name}.js`,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      charset: 'utf8',
      legalComments: 'inline',
      sourcemap: false,
      minify: false,
      metafile: true,
      write: false,
      logLevel: 'warning',
      logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
    });
    const outputs = Object.values(result.metafile.outputs);
    if (result.outputFiles.length !== 1 || outputs.length !== 1 || outputs[0].imports.length !== 0) {
      throw new Error(`배포물은 외부 import가 없는 ${name}.js 하나여야 합니다.`);
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      if (![name, ...(SDK_DEPENDENCIES[name] ?? [])].some(owner => input.startsWith(`packages/${owner}/src/`))) {
        throw new Error(`${name} 소스 밖의 런타임 의존성은 허용하지 않습니다: ${input}`);
      }
    }
    bundles.set(`${name}.js`, Buffer.from(result.outputFiles[0].contents));
  }
  // 모든 모듈의 검사가 끝난 뒤에만 배포물을 갱신합니다.
  await mkdir(resolve(root, 'dist'), { recursive: true });
  for (const [file, bytes] of bundles) {
    await writeFile(resolve(root, 'dist', file), bytes);
    console.log(`Built dist/${file} (${bytes.length} bytes)`);
  }
  const manifest = createManifest(bundles);
  await writeFile(resolve(root, 'dist', MANIFEST_FILE), serializeManifest(manifest));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildDistribution(fileURLToPath(new URL('../', import.meta.url)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

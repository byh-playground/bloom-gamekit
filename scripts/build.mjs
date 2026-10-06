import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist/interpolation.js');

// 빌드 시각·절대 경로·외부 런타임 의존성이 없는 단일 브라우저 ESM입니다.
const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/interpolation/src/index.js'],
  outfile: 'dist/interpolation.js',
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
});

const outputs = Object.values(result.metafile.outputs);
if (result.outputFiles.length !== 1 || outputs.length !== 1 || outputs[0].imports.length !== 0) {
  throw new Error('배포물은 외부 import가 없는 interpolation.js 하나여야 합니다.');
}
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith('packages/interpolation/src/')) {
    throw new Error(`interpolation 소스 밖의 런타임 의존성은 허용하지 않습니다: ${input}`);
  }
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, result.outputFiles[0].contents);
console.log(`Built dist/interpolation.js (${result.outputFiles[0].contents.length} bytes)`);

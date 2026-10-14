import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every maintained example HTML entry. Test harnesses and provenance archives are not demos.
export const EXAMPLES = [
  ['interpolation', 'modules/interpolation/examples/index.html'],
  ['interpolation-frame', 'modules/interpolation/examples/frame.html'],
  ['simloop-input-preview', 'modules/simloop/examples/input-preview/index.html'],
  ['audio', 'modules/audio/examples/index.html'],
  ['navigation', 'modules/navigation/examples/index.html'],
  ['rendering-vector', 'modules/rendering/examples/vector/index.html'],
  ['rollback-availability', 'modules/rollback/examples/availability/index.html'],
  ['rollback-netcode', 'modules/rollback-netcode/examples/index.html'],
  ['scenario', 'modules/scenario/examples/index.html'],
];
export const previewURL = name => `https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/${name}.html`;

export async function buildPreviews(root) {
  const output = resolve(root, 'dist/previews');
  await mkdir(output, { recursive: true });
  for (const [name, source] of EXAMPLES) {
    let html = await readFile(resolve(root, source), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [whole, attributes, body] of scripts) {
      if (!/type=["']module["']/.test(attributes)) throw new Error(`Unclassified script: ${source}`);
      const src = attributes.match(/src=["']([^"']+)["']/)?.[1];
      const result = await build({
        absWorkingDir: root, stdin: { contents: src ? `import ${JSON.stringify(src)};` : body, resolveDir: resolve(root, dirname(source)), sourcefile: source },
        bundle: true, format: 'iife', platform: 'browser', target: 'es2022', charset: 'utf8', write: false, metafile: true,
        plugins: [{ name: 'root-dist', setup(b) { b.onResolve({ filter: /^\/dist\// }, args => ({ path: resolve(root, '.' + args.path) })); } }],
      });
      if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(o => o.imports.length)) throw new Error(`Preview has external imports: ${source}`);
      html = html.replace(whole, () => `<script>\n${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}\n</script>`);
    }
    html = html.replace(/href=["'](\.[^"']*)["']/g, (whole, target) => {
      const destination = resolve(root, dirname(source), target);
      const example = EXAMPLES.find(([, file]) => resolve(root, file) === destination);
      const url = example ? previewURL(example[0]) : `https://github.com/byh-playground/bloom-gamekit/blob/main/${destination.slice(root.length + 1).replaceAll('\\', '/')}`;
      return `href="${url}"`;
    });
    await writeFile(resolve(output, `${name}.html`), html);
  }
  await writeFile(resolve(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>GameKit examples</title><h1>GameKit HTML previews</h1><ul>' + EXAMPLES.map(([name]) => `<li><a href="${previewURL(name)}">${name}</a></li>`).join('') + '</ul>');
  console.log(`Built ${EXAMPLES.length} standalone HTML previews`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildPreviews(fileURLToPath(new URL('../', import.meta.url))).catch(error => { console.error(error); process.exitCode = 1; });

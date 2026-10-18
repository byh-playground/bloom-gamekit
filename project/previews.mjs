import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledAssetSource, bundledStyleExamplesSource } from '../modules/vector-assets/compiler.js';

// Every maintained example HTML entry. Test harnesses and provenance archives are not demos.
export const EXAMPLES = [
    ['pixel-physics', 'modules/pixel-physics/examples/index.html'],
    ['interpolation', 'modules/interpolation/examples/index.html'],
    ['interpolation-frame', 'modules/interpolation/examples/frame.html'],
    ['simloop-input-preview', 'modules/simloop/examples/input-preview/index.html'],
    ['work-scheduler', 'modules/work-scheduler/examples/index.html'],
    ['audio', 'modules/audio/examples/index.html'],
    ['navigation', 'modules/navigation/examples/index.html'],
    ['rendering-vector', 'modules/rendering/examples/vector/index.html'],
    ['vector-assets', 'modules/vector-assets/examples/index.html'],
    ['rollback-availability', 'modules/rollback/examples/availability/index.html'],
    ['rollback-reference', 'modules/rollback/examples/reference/index.html'],
    ['scenario', 'modules/scenario/examples/index.html'],
];
const PREVIEW_URL = (name) =>
    `https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/${name}.html`;
export { PREVIEW_URL as previewURL };
export async function buildPreviews(root) {
    const OUTPUT = resolve(root, 'dist/previews');
    await mkdir(OUTPUT, {
        recursive: true,
    });
    for (const [NAME, SOURCE] of EXAMPLES) {
        let html = await readFile(resolve(root, SOURCE), 'utf8');
        const SCRIPTS = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        for (const [WHOLE, ATTRIBUTES, BODY] of SCRIPTS) {
            if (!/type=["']module["']/.test(ATTRIBUTES)) {
                throw new Error(`Unclassified script: ${SOURCE}`);
            }
            const SRC = ATTRIBUTES.match(/src=["']([^"']+)["']/)?.[1];
            const RESULT = await build({
                absWorkingDir: root,
                stdin: {
                    contents: SRC ? `import ${JSON.stringify(SRC)};` : BODY,
                    resolveDir: resolve(root, dirname(SOURCE)),
                    sourcefile: SOURCE,
                },
                bundle: true,
                format: 'iife',
                platform: 'browser',
                target: 'es2022',
                charset: 'utf8',
                write: false,
                metafile: true,
                plugins: [
                    {
                        name: 'root-dist',
                        setup(b) {
                            b.onResolve(
                                {
                                    filter: /^\/dist\//,
                                },
                                (args) => ({
                                    path: resolve(root, '.' + args.path),
                                }),
                            );
                        },
                    },
                    {
                        name: 'vector-asset-example',
                        setup(b) {
                            b.onResolve(
                                {
                                    filter: /^\.\.\/seed-scout\.compiled\.js$/,
                                },
                                (args) =>
                                    /(?:^|[\\/])modules[\\/]vector-assets[\\/]examples[\\/]seed-scout\.js$/.test(
                                        args.importer,
                                    )
                                        ? {
                                              path: 'seed-scout',
                                              namespace: 'vector-asset-example',
                                          }
                                        : null,
                            );
                            b.onResolve(
                                {
                                    filter: /^\.\/styles\.compiled\.js$/,
                                },
                                (args) =>
                                    /(?:^|[\\/])modules[\\/]vector-assets[\\/]examples[\\/]style-samples\.js$/.test(
                                        args.importer,
                                    )
                                        ? {
                                              path: 'style-samples',
                                              namespace: 'vector-asset-example',
                                          }
                                        : null,
                            );
                            b.onLoad(
                                {
                                    filter: /.*/,
                                    namespace: 'vector-asset-example',
                                },
                                async (args) => ({
                                    contents:
                                        args.path === 'seed-scout'
                                            ? await bundledAssetSource(root)
                                            : await bundledStyleExamplesSource(root),
                                    loader: 'js',
                                }),
                            );
                        },
                    },
                ],
            });
            if (
                RESULT.outputFiles.length !== 1 ||
                Object.values(RESULT.metafile.outputs).some((o) => o.imports.length)
            ) {
                throw new Error(`Preview has external imports: ${SOURCE}`);
            }
            html = html.replace(
                WHOLE,
                () => `<script>\n${RESULT.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}\n</script>`,
            );
        }
        html = html.replace(/href=["'](\.[^"']*)["']/g, (_whole, target) => {
            const DESTINATION = resolve(root, dirname(SOURCE), target);
            const EXAMPLE = EXAMPLES.find(([, file]) => resolve(root, file) === DESTINATION);
            const URL_LOCAL = EXAMPLE
                ? PREVIEW_URL(EXAMPLE[0])
                : `https://github.com/byh-playground/bloom-gamekit/blob/main/${DESTINATION.slice(root.length + 1).replaceAll('\\', '/')}`;
            return `href="${URL_LOCAL}"`;
        });
        await writeFile(resolve(OUTPUT, `${NAME}.html`), html);
    }
    await writeFile(
        resolve(OUTPUT, 'index.html'),
        '<!doctype html><meta charset="utf-8"><title>GameKit examples</title><h1>GameKit HTML previews</h1><ul>' +
            EXAMPLES.map(([name]) => `<li><a href="${PREVIEW_URL(name)}">${name}</a></li>`).join('') +
            '</ul>',
    );
    console.log(`Built ${EXAMPLES.length} standalone HTML previews`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    buildPreviews(fileURLToPath(new URL('../', import.meta.url))).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

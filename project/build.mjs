import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODULES, FONT_ASSETS, MANIFEST_FILE, createManifest, serializeManifest } from './distribution.mjs';
import { MATTER_URL } from '../modules/pixel-physics/dependencies.js';
const SDK_DEPENDENCIES = {
    scenario: ['simloop'],
    'vector-assets-loader': ['vector-assets'],
    deterministic: ['_rollback-shared'],
    simloop: [],
    'pixel-physics': ['deterministic'],
    transport: ['_rollback-shared', 'deterministic'],
    replay: ['_rollback-shared', 'deterministic'],
    rollback: ['_rollback-shared', 'deterministic'],
};
const BUNDLED_PACKAGES = {
    'vector-assets': ['node_modules/animejs/'],
    'vector-assets-loader': ['node_modules/@xmldom/xmldom/', 'node_modules/three/'],
};
export async function buildDistribution(root) {
    const BUNDLES = new Map();
    for (const NAME of MODULES) {
        // PixelPhysics의 명시적 웹 의존성만 허용하며 나머지는 외부 import가 없습니다.
        const EXTERNAL_IMPORTS = NAME === 'pixel-physics' ? [MATTER_URL] : [];
        const RESULT = await build({
            absWorkingDir: root,
            entryPoints: [`modules/${NAME}/index.js`],
            outfile: `dist/${NAME}.js`,
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
            plugins:
                NAME === 'pixel-physics'
                    ? [
                          {
                              name: 'matter-web-runtime',
                              setup(b) {
                                  b.onResolve({ filter: /^matter-js$/ }, () => ({ path: MATTER_URL, external: true }));
                              },
                          },
                      ]
                    : [],
            logOverride: {
                'unsupported-dynamic-import': 'error',
                'unsupported-require-call': 'error',
            },
        });
        const OUTPUTS = Object.values(RESULT.metafile.outputs);
        if (
            RESULT.outputFiles.length !== 1 ||
            OUTPUTS.length !== 1 ||
            OUTPUTS[0].imports.length !== EXTERNAL_IMPORTS.length ||
            OUTPUTS[0].imports.some(
                (entry) => entry.kind !== 'import-statement' || !EXTERNAL_IMPORTS.includes(entry.path),
            )
        ) {
            throw new Error(`배포물은 선언한 웹 의존성만 가진 ${NAME}.js 하나여야 합니다.`);
        }
        for (const INPUT of Object.keys(RESULT.metafile.inputs)) {
            const OWNED = [NAME, ...(SDK_DEPENDENCIES[NAME] ?? [])].some(
                (owner) =>
                    INPUT.startsWith(`modules/${owner}/`) && !INPUT.slice(`modules/${owner}/`.length).includes('/'),
            );
            // esbuild reports a package's real path when node_modules is symlinked
            // into an isolated worktree (for example ../node_modules/animejs/...).
            // Keep the allowlist package-specific while accepting that canonical path.
            const PACKAGE_OWNED = (BUNDLED_PACKAGES[NAME] ?? []).some((prefix) => {
                const PACKAGE_PATH = prefix.startsWith('./') ? prefix.slice(2) : prefix;
                return INPUT.startsWith(PACKAGE_PATH) || INPUT.includes('/' + PACKAGE_PATH);
            });
            const GENERATED_ASSET = NAME === 'vector-assets' && INPUT.startsWith('vector-asset:');
            if (!OWNED && !PACKAGE_OWNED && !GENERATED_ASSET) {
                throw new Error(`${NAME} 소스 밖의 런타임 의존성은 허용하지 않습니다: ${INPUT}`);
            }
        }
        BUNDLES.set(`${NAME}.js`, Buffer.from(RESULT.outputFiles[0].contents));
    }
    // 모든 모듈의 검사가 끝난 뒤에만 배포물을 갱신합니다.
    await mkdir(resolve(root, 'dist'), {
        recursive: true,
    });
    for (const FILE of await readdir(resolve(root, 'dist'))) {
        if (/^[a-z][a-z-]*\.js$/.test(FILE) && !BUNDLES.has(FILE)) {
            await unlink(resolve(root, 'dist', FILE));
        }
    }
    for (const [FILE, BYTES] of BUNDLES) {
        await writeFile(resolve(root, 'dist', FILE), BYTES);
        console.log(`Built dist/${FILE} (${BYTES.length} bytes)`);
    }
    const ASSETS = new Map();
    for (const ASSET of FONT_ASSETS) {
        const BYTES = await readFile(resolve(root, ASSET.source));
        ASSETS.set(ASSET.file, BYTES);
        const OUTPUT = resolve(root, 'dist', ...ASSET.file.split('/'));
        await mkdir(dirname(OUTPUT), {
            recursive: true,
        });
        await writeFile(OUTPUT, BYTES);
        console.log(`Copied dist/${ASSET.file} (${BYTES.length} bytes)`);
    }
    const MANIFEST = createManifest(BUNDLES, ASSETS);
    await writeFile(resolve(root, 'dist', MANIFEST_FILE), serializeManifest(MANIFEST));
    return MANIFEST;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    buildDistribution(fileURLToPath(new URL('../', import.meta.url))).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODULES, FONT_ASSETS, MANIFEST_FILE, createManifest, serializeManifest } from './distribution.mjs';
const SDK_DEPENDENCIES = {
    scenario: ['simloop'],
    'vector-assets-loader': ['vector-assets'],
    deterministic: ['_rollback-shared'],
    simloop: [],
    transport: ['_rollback-shared', 'deterministic'],
    replay: ['_rollback-shared', 'deterministic'],
    rollback: ['_rollback-shared', 'deterministic'],
};
const BUNDLED_PACKAGES = {
    'pixel-physics-matter': ['node_modules/matter-js/'],
    'vector-assets': ['node_modules/animejs/'],
    'vector-assets-loader': ['node_modules/@xmldom/xmldom/', 'node_modules/three/'],
};
export async function buildDistribution(root) {
    const BUNDLES = new Map();
    for (const NAME of MODULES) {
        // 모듈마다 따로 빌드하여 공유 chunk와 외부 런타임 의존성을 만들지 않습니다.
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
            logOverride: {
                'unsupported-dynamic-import': 'error',
                'unsupported-require-call': 'error',
            },
        });
        const OUTPUTS = Object.values(RESULT.metafile.outputs);
        if (RESULT.outputFiles.length !== 1 || OUTPUTS.length !== 1 || OUTPUTS[0].imports.length !== 0) {
            throw new Error(`배포물은 외부 import가 없는 ${NAME}.js 하나여야 합니다.`);
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

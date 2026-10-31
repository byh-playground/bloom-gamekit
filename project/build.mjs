import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    MODULES,
    NODE_TOOLS,
    FONT_ASSETS,
    MANIFEST_FILE,
    BUNDLE_FILE_NAME,
    createManifest,
    serializeManifest,
} from './distribution.mjs';
import { MATTER_URL } from '../modules/pixel-physics/dependencies.js';
const SDK_DEPENDENCIES = {
    scenario: ['simloop'],
    'vector-assets-loader': ['vector-assets'],
    deterministic: ['_rollback-shared'],
    simloop: [],
    'pixel-physics': ['deterministic'],
    transport: ['_rollback-shared', 'deterministic', 'save'],
    replay: ['_rollback-shared', 'deterministic'],
    rollback: ['_rollback-shared', 'deterministic'],
};
const BUNDLED_PACKAGES = {
    'vector-assets': ['node_modules/animejs/'],
    'vector-assets-loader': ['node_modules/@xmldom/xmldom/', 'node_modules/three/'],
};
// The SVG compiler/runtime and mesh renderer share only the named RGB contract, not renderer initialization.
const SHARED_PAINT_SOURCE = new Set(['vector-assets', 'vector-assets-loader']);
// The compiler also writes the yarn/sketch surface geometry and the material record the mesh renderer reads. Both files
// are plain data code: no shader source and no renderer initialization.
const SHARED_SURFACE_SOURCE = new Set([
    'modules/rendering/yarn-geometry.js',
    'modules/rendering/yarn-material-record.js',
]);
// bm·store 어댑터는 코어와 별도 번들이지만 소스는 각 모듈의 adapters 아래에 둡니다. 어댑터는 코어를 import하지 않으며,
// 코어 번들은 하위 폴더를 허용하지 않으므로 어댑터 소스를 가져올 수 없습니다.
const SOURCE_DIRS = {
    'bm-mock': 'bm/adapters/mock',
    'bm-google-ads': 'bm/adapters/google-ads',
    'bm-ima': 'bm/adapters/ima',
    'store-mock': 'store/adapters/mock',
};
// 브라우저 번들은 modules/<dir>/index.js 하나에서, Node 도구는 선언한 소스 파일 하나에서 만듭니다.
const TARGETS = [
    ...MODULES.map((name) => ({
        name,
        file: `${name}.js`,
        entry: `modules/${SOURCE_DIRS[name] ?? name}/index.js`,
        owners: [SOURCE_DIRS[name] ?? name, ...(SDK_DEPENDENCIES[name] ?? [])],
        node: false,
    })),
    ...NODE_TOOLS.map(({ name, source }) => ({
        name,
        file: `${name}.mjs`,
        entry: source,
        owners: [dirname(source).slice('modules/'.length)],
        node: true,
    })),
];
export async function buildDistribution(root) {
    const BUNDLES = new Map();
    for (const { name: NAME, file: FILE_NAME, entry: ENTRY, owners: OWNERS, node: NODE } of TARGETS) {
        // PixelPhysics의 명시적 웹 의존성만 허용하며 나머지는 외부 import가 없습니다.
        // Node 도구는 node: 내장 모듈만 import합니다.
        const EXTERNAL_IMPORTS = NAME === 'pixel-physics' ? [MATTER_URL] : [];
        const ALLOWED_IMPORT = (path) => EXTERNAL_IMPORTS.includes(path) || (NODE && path.startsWith('node:'));
        const RESULT = await build({
            absWorkingDir: root,
            entryPoints: [ENTRY],
            outfile: `dist/${FILE_NAME}`,
            bundle: true,
            format: 'esm',
            platform: NODE ? 'node' : 'browser',
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
            (!NODE && OUTPUTS[0].imports.length !== EXTERNAL_IMPORTS.length) ||
            OUTPUTS[0].imports.some((entry) => entry.kind !== 'import-statement' || !ALLOWED_IMPORT(entry.path))
        ) {
            throw new Error(`배포물은 선언한 의존성만 가진 ${FILE_NAME} 하나여야 합니다.`);
        }
        for (const INPUT of Object.keys(RESULT.metafile.inputs)) {
            const OWNED = OWNERS.some(
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
            const PAINT_CONTRACT = SHARED_PAINT_SOURCE.has(NAME) && INPUT === 'modules/rendering/paint-regions.js';
            const SURFACE_CONTRACT = SHARED_PAINT_SOURCE.has(NAME) && SHARED_SURFACE_SOURCE.has(INPUT);
            // Reuse the retained textured quad for offline atlas reduction;
            // never bundle Device/renderer initialization into vector-assets.
            const SPRITE_PREPARATION = NAME === 'vector-assets' && INPUT === 'modules/rendering/sprite-animation.js';
            if (
                !OWNED &&
                !PACKAGE_OWNED &&
                !GENERATED_ASSET &&
                !PAINT_CONTRACT &&
                !SURFACE_CONTRACT &&
                !SPRITE_PREPARATION
            ) {
                throw new Error(`${NAME} 소스 밖의 런타임 의존성은 허용하지 않습니다: ${INPUT}`);
            }
        }
        BUNDLES.set(FILE_NAME, Buffer.from(RESULT.outputFiles[0].contents));
    }
    // 모든 모듈의 검사가 끝난 뒤에만 배포물을 갱신합니다.
    await mkdir(resolve(root, 'dist'), {
        recursive: true,
    });
    for (const FILE of await readdir(resolve(root, 'dist'))) {
        if (BUNDLE_FILE_NAME.test(FILE) && !BUNDLES.has(FILE)) {
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

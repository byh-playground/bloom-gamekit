import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../modules/_rollback-shared/version.js';
import { MANIFEST_FILE, readVerifiedDistribution } from './distribution.mjs';
export function inspectRelease({ git, remote, version = VERSION, files }) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error('SDK VERSION must be MAJOR.MINOR.PATCH');
    }
    const TAG = `v${version}`,
        REF = `refs/tags/${TAG}`;
    const EXISTING = git(['ls-remote', '--refs', remote, REF]);
    if (!EXISTING) {
        return {
            tag: TAG,
            commit: null,
        };
    }
    const [OBJECT, ACTUAL_REF] = EXISTING.split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(OBJECT) || ACTUAL_REF !== REF) {
        throw new Error('Invalid release tag ref');
    }
    git(['fetch', '--no-tags', remote, REF]);
    const COMMIT = git(['rev-parse', 'FETCH_HEAD^{commit}']);
    // Tags are immutable: compare the actual blobs, not just a claimed manifest digest.
    for (const [FILE, BYTES] of files) {
        const EXPECTED = git(['hash-object', '--stdin'], BYTES);
        let actual;
        try {
            actual = git(['rev-parse', `${COMMIT}:${FILE}`]);
        } catch {
            actual = null;
        }
        if (actual !== EXPECTED) {
            throw new Error(
                `${TAG} already exists with different ${FILE}; bump SDK VERSION. The tag will not be moved.`,
            );
        }
    }
    return {
        tag: TAG,
        commit: COMMIT,
    };
}
async function main() {
    const ROOT = fileURLToPath(new URL('../', import.meta.url));
    const { bundles: BUNDLES, assets: ASSETS, manifestBytes: MANIFEST_BYTES } = await readVerifiedDistribution(ROOT);
    const GIT = (args, input) => {
        const RESULT = spawnSync('git', args, {
            cwd: ROOT,
            input,
            encoding: 'utf8',
            timeout: 60000,
        });
        if (RESULT.error || RESULT.status !== 0) {
            throw RESULT.error ?? new Error(RESULT.stderr);
        }
        return RESULT.stdout.trim();
    };
    const RELEASE = inspectRelease({
        git: GIT,
        remote: 'https://github.com/byh-playground/bloom-gamekit.git',
        files: [...BUNDLES, ...ASSETS, [MANIFEST_FILE, MANIFEST_BYTES]],
    });
    console.log(`${RELEASE.tag}: ${RELEASE.commit ? `existing bytes verified (${RELEASE.commit})` : 'new release'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

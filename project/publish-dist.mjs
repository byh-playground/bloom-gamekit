import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUNDLE_FILE_NAME, MANIFEST_FILE, SHA256, readVerifiedDistribution } from './distribution.mjs';
import { VERSION } from '../modules/_rollback-shared/version.js';
import { inspectRelease } from './release.mjs';
import { publishPreviews } from './publish-previews.mjs';
const SHA = /^[a-f0-9]{40}$/;

// export는 파일 시스템 안의 bare 저장소로 배포 절차를 회귀 검사하기 위한 경계입니다.
export async function publishDist({
    root,
    remote,
    sourceSha,
    expectedManifestHash,
    version = VERSION,
    env = process.env,
}) {
    if (
        typeof sourceSha !== 'string' ||
        !SHA.test(sourceSha) ||
        typeof expectedManifestHash !== 'string' ||
        !SHA256.test(expectedManifestHash)
    ) {
        throw new Error('유효한 source SHA와 manifest SHA-256이 필요합니다.');
    }
    const {
        manifest: MANIFEST,
        manifestBytes: MANIFEST_BYTES,
        manifestHash: MANIFEST_HASH,
        bundles: BUNDLES,
        assets: ASSETS,
    } = await readVerifiedDistribution(root, expectedManifestHash);
    const TEMPORARY = await mkdtemp(resolve(tmpdir(), 'gamekit-publish-'));
    const GIT_ENV = {
        ...env,
        GIT_INDEX_FILE: resolve(TEMPORARY, 'index'),
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    };
    const GIT = (args, input) => {
        const RESULT = spawnSync('git', args, {
            cwd: root,
            env: GIT_ENV,
            input,
            encoding: 'utf8',
            timeout: 60_000,
        });
        if (RESULT.error) {
            throw RESULT.error;
        }
        if (RESULT.status !== 0) {
            throw new Error(`git ${args[0]} 실패: ${RESULT.stderr.trim()}`);
        }
        return RESULT.stdout.trim();
    };
    const REMOTE_HEAD = (branch) => {
        const LINE = GIT(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
        if (LINE === '') {
            return null;
        }
        const [SHA_LOCAL, REF] = LINE.split(/\s+/);
        if (!SHA.test(SHA_LOCAL) || REF !== `refs/heads/${branch}`) {
            throw new Error('예상과 다른 원격 branch 응답입니다.');
        }
        return SHA_LOCAL;
    };
    try {
        if (GIT(['rev-parse', 'HEAD']) !== sourceSha) {
            throw new Error('checkout과 source SHA가 다릅니다.');
        }
        // 오래된 실행을 다시 실행해도 최신 main의 배포물을 되돌리지 않습니다.
        if (REMOTE_HEAD('main') !== sourceSha) {
            return {
                status: 'stale',
            };
        }
        const FILES = [...BUNDLES, ...ASSETS, [MANIFEST_FILE, MANIFEST_BYTES]];
        const RELEASE = inspectRelease({
            git: GIT,
            remote,
            version,
            files: FILES,
        });
        if (RELEASE.commit) {
            return {
                status: 'unchanged',
                commit: RELEASE.commit,
                tag: RELEASE.tag,
            };
        }
        let parent = REMOTE_HEAD('dist');
        if (parent !== null) {
            GIT(['fetch', '--no-tags', remote, 'refs/heads/dist']);
            parent = GIT(['rev-parse', 'FETCH_HEAD']);
            GIT(['read-tree', parent]);
            const PREVIOUS = JSON.parse(GIT(['show', `${parent}:${MANIFEST_FILE}`]));
            for (const { file: FILE } of PREVIOUS.modules ?? []) {
                if (!BUNDLE_FILE_NAME.test(FILE)) {
                    throw new Error('Invalid previous bundle path');
                }
                if (!BUNDLES.has(FILE)) {
                    GIT(['update-index', '--force-remove', FILE]);
                }
            }
        } else {
            GIT(['read-tree', '--empty']);
        }

        // 고정 목록의 모듈과 manifest만 교체합니다. 관련 없는 기존 파일과 이력은 보존합니다.
        for (const [FILE, BYTES] of FILES) {
            const BLOB = GIT(['hash-object', '-w', '--stdin'], BYTES);
            GIT(['update-index', '--add', '--cacheinfo', `100644,${BLOB},${FILE}`]);
        }
        const TREE = GIT(['write-tree']);
        const UNCHANGED = parent !== null && TREE === GIT(['rev-parse', `${parent}^{tree}`]);
        const ARGS = ['commit-tree', TREE];
        if (parent !== null) {
            ARGS.push('-p', parent);
        }
        const HASHES = MANIFEST.modules.map(({ file, sha256 }) => `Bundle-SHA256: ${file} ${sha256}`).join('\n');
        const ASSET_METADATA = MANIFEST.assets
            .map(({ file, bytes, sha256 }) => `Asset-SHA256: ${file} ${sha256}\nAsset-Bytes: ${file} ${bytes}`)
            .join('\n');
        const COMMIT = UNCHANGED
            ? parent
            : GIT(
                  ARGS,
                  `[chore] 독립 모듈 배포물 갱신\n\nSDK-Version: ${version}\nSource-Commit: ${sourceSha}\nManifest-SHA256: ${MANIFEST_HASH}\n${HASHES}\n${ASSET_METADATA}\n`,
              );
        if (REMOTE_HEAD('main') !== sourceSha) {
            return {
                status: 'stale',
            };
        }
        if (REMOTE_HEAD('dist') !== parent) {
            throw new Error('dist가 다른 실행에서 변경되었습니다. 덮어쓰지 않고 중단합니다.');
        }
        // force/force-with-lease를 사용하지 않습니다. 경합은 non-fast-forward로 실패합니다.
        GIT(['push', '--atomic', remote, `${COMMIT}:refs/heads/dist`, `${COMMIT}:refs/tags/${RELEASE.tag}`]);
        if (REMOTE_HEAD('dist') !== COMMIT) {
            throw new Error('원격 dist의 commit을 확인할 수 없습니다.');
        }
        if (GIT(['ls-remote', '--refs', remote, `refs/tags/${RELEASE.tag}`]).split(/\s+/)[0] !== COMMIT) {
            throw new Error('Release tag verification failed');
        }
        return {
            status: 'published',
            commit: COMMIT,
            tag: RELEASE.tag,
        };
    } finally {
        await rm(TEMPORARY, {
            recursive: true,
            force: true,
        });
    }
}
async function main() {
    const {
        GITHUB_ACTIONS,
        GITHUB_EVENT_NAME,
        GITHUB_REF,
        GITHUB_REPOSITORY,
        GITHUB_SHA,
        GITHUB_SERVER_URL,
        GITHUB_TOKEN,
        EXPECTED_MANIFEST_SHA256,
    } = process.env;
    if (
        GITHUB_ACTIONS !== 'true' ||
        GITHUB_EVENT_NAME !== 'push' ||
        GITHUB_REF !== 'refs/heads/main' ||
        GITHUB_REPOSITORY !== 'byh-playground/bloom-gamekit' ||
        GITHUB_SERVER_URL !== 'https://github.com'
    ) {
        throw new Error('공식 저장소 main push의 GitHub Actions에서만 배포할 수 있습니다.');
    }
    if (!GITHUB_TOKEN) {
        throw new Error('배포 step의 GITHUB_TOKEN이 필요합니다.');
    }
    // 인증 헤더는 이 프로세스의 git 자식에만 전달하고 파일이나 URL에 저장하지 않습니다.
    const AUTH = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64');
    const ENV = {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${AUTH}`,
    };
    delete ENV.GITHUB_TOKEN;
    const RESULT = await publishDist({
        root: fileURLToPath(new URL('../', import.meta.url)),
        remote: `https://github.com/${GITHUB_REPOSITORY}.git`,
        sourceSha: GITHUB_SHA,
        expectedManifestHash: EXPECTED_MANIFEST_SHA256,
        env: ENV,
    });
    console.log(`dist: ${RESULT.status}${RESULT.commit ? ` (${RESULT.commit})` : ''}`);
    if (RESULT.status !== 'stale') {
        const PREVIEWS = await publishPreviews({
            root: fileURLToPath(new URL('../', import.meta.url)),
            remote: `https://github.com/${GITHUB_REPOSITORY}.git`,
            sourceSha: GITHUB_SHA,
            env: ENV,
        });
        console.log(`previews: ${PREVIEWS.status}${PREVIEWS.commit ? ` (${PREVIEWS.commit})` : ''}`);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

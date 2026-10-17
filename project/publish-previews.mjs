import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXAMPLES } from './previews.mjs';

// Same main-push credential and CI job as dist. No hosting account or additional token.
export async function publishPreviews({ root, remote, sourceSha, env = process.env }) {
    const TEMPORARY = await mkdtemp(resolve(tmpdir(), 'gamekit-preview-'));
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
            timeout: 60000,
        });
        if (RESULT.error || RESULT.status !== 0) {
            throw RESULT.error ?? new Error(RESULT.stderr);
        }
        return RESULT.stdout.trim();
    };
    const HEAD = (branch) => GIT(['ls-remote', '--heads', remote, `refs/heads/${branch}`]).split(/\s+/)[0] || null;
    try {
        if (GIT(['rev-parse', 'HEAD']) !== sourceSha) {
            throw new Error('Preview source SHA mismatch');
        }
        if (HEAD('main') !== sourceSha) {
            return {
                status: 'stale',
            };
        }
        let parent = HEAD('previews');
        if (parent) {
            GIT(['fetch', '--no-tags', remote, 'refs/heads/previews']);
            parent = GIT(['rev-parse', 'FETCH_HEAD']);
        }
        GIT(['read-tree', '--empty']);
        for (const FILE of [...EXAMPLES.map(([name]) => `${name}.html`), 'index.html']) {
            const BLOB = GIT(['hash-object', '-w', '--stdin'], await readFile(resolve(root, 'dist/previews', FILE)));
            GIT(['update-index', '--add', '--cacheinfo', `100644,${BLOB},${FILE}`]);
        }
        const TREE = GIT(['write-tree']);
        if (parent && TREE === GIT(['rev-parse', `${parent}^{tree}`])) {
            return {
                status: 'unchanged',
                commit: parent,
            };
        }
        const COMMIT = GIT(
            ['commit-tree', TREE, ...(parent ? ['-p', parent] : [])],
            `[chore] 실행 HTML 프리뷰 갱신\n\nSource-Commit: ${sourceSha}\n`,
        );
        if (HEAD('main') !== sourceSha) {
            return {
                status: 'stale',
            };
        }
        if (HEAD('previews') !== parent) {
            throw new Error('Preview branch changed concurrently');
        }
        GIT(['push', remote, `${COMMIT}:refs/heads/previews`]);
        if (HEAD('previews') !== COMMIT) {
            throw new Error('Preview publish verification failed');
        }
        return {
            status: 'published',
            commit: COMMIT,
        };
    } finally {
        await rm(TEMPORARY, {
            recursive: true,
            force: true,
        });
    }
}

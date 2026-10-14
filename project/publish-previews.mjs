import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXAMPLES } from './previews.mjs';

// Same main-push credential and CI job as dist. No hosting account or additional token.
export async function publishPreviews({ root, remote, sourceSha, env = process.env }) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'gamekit-preview-'));
  const gitEnv = { ...env, GIT_INDEX_FILE: resolve(temporary, 'index'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: root, env: gitEnv, input, encoding: 'utf8', timeout: 60000 });
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return result.stdout.trim();
  };
  const head = branch => git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]).split(/\s+/)[0] || null;
  try {
    if (git(['rev-parse', 'HEAD']) !== sourceSha) throw new Error('Preview source SHA mismatch');
    if (head('main') !== sourceSha) return { status: 'stale' };
    let parent = head('previews');
    if (parent) { git(['fetch', '--no-tags', remote, 'refs/heads/previews']); parent = git(['rev-parse', 'FETCH_HEAD']); }
    git(['read-tree', '--empty']);
    for (const file of [...EXAMPLES.map(([name]) => `${name}.html`), 'index.html']) {
      const blob = git(['hash-object', '-w', '--stdin'], await readFile(resolve(root, 'dist/previews', file)));
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
    }
    const tree = git(['write-tree']);
    if (parent && tree === git(['rev-parse', `${parent}^{tree}`])) return { status: 'unchanged', commit: parent };
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], `[chore] 실행 HTML 프리뷰 갱신\n\nSource-Commit: ${sourceSha}\n`);
    if (head('main') !== sourceSha) return { status: 'stale' };
    if (head('previews') !== parent) throw new Error('Preview branch changed concurrently');
    git(['push', remote, `${commit}:refs/heads/previews`]);
    if (head('previews') !== commit) throw new Error('Preview publish verification failed');
    return { status: 'published', commit };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

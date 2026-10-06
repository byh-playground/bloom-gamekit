import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishDist } from './publish-dist.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = (text) => createHash('sha256').update(text).digest('hex');

test('dist는 최초 파일 하나만 생성하고, 이후에는 관련 없는 파일과 이력을 보존한다', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'gamekit-publish-test-'));
  try {
    const root = resolve(temporary, 'source');
    const remote = resolve(temporary, 'remote.git');
    await mkdir(root);
    git(temporary, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'init', '--initial-branch=main');
    await writeFile(resolve(root, 'README.md'), 'Source only\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'Source');
    git(root, 'push', remote, 'HEAD:refs/heads/main');
    let sourceSha = git(root, 'rev-parse', 'HEAD');
    const initialMain = sourceSha;
    await mkdir(resolve(root, 'dist'));
    let bundle = 'export const value = 1;\n';
    await writeFile(resolve(root, 'dist/interpolation.js'), bundle);
    const run = (overrides = {}) => publishDist({ root, remote, sourceSha, expectedHash: hash(bundle), env, ...overrides });

    const first = await run();
    assert.equal(first.status, 'published');
    assert.equal(git(temporary, '--git-dir', remote, 'ls-tree', '--name-only', 'dist'), 'interpolation.js');
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:interpolation.js'), bundle.trim());
    assert.equal(git(temporary, '--git-dir', remote, 'rev-list', '--count', 'dist'), '1');
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'main'), initialMain);
    const unchanged = await run();
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(unchanged.commit, first.commit);

    // 다른 모듈의 배포물이 이미 있는 branch를 흉내 냅니다.
    const other = resolve(temporary, 'other');
    git(temporary, 'clone', '--branch', 'dist', remote, other);
    await writeFile(resolve(other, 'keep.txt'), 'Do not change\n');
    await mkdir(resolve(other, 'nested'));
    await writeFile(resolve(other, 'nested/another.js'), 'export const preserved = true;\n');
    // 기존 배포 경로가 symlink여도 대상을 따라가서 다른 파일을 덮어쓰면 안 됩니다.
    await rm(resolve(other, 'interpolation.js'));
    await symlink('keep.txt', resolve(other, 'interpolation.js'));
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'Other package');
    git(other, 'push', 'origin', 'dist');
    const preservedParent = git(other, 'rev-parse', 'HEAD');

    await writeFile(resolve(root, 'README.md'), 'New source\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'New source');
    sourceSha = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', remote, 'HEAD:refs/heads/main');
    bundle = 'export const value = 2;\n';
    await writeFile(resolve(root, 'dist/interpolation.js'), bundle);
    const next = await run();
    assert.equal(next.status, 'published');
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist^'), preservedParent);
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:keep.txt'), 'Do not change');
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:nested/another.js'), 'export const preserved = true;');
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:interpolation.js'), bundle.trim());
    assert.match(git(temporary, '--git-dir', remote, 'ls-tree', 'dist', 'interpolation.js'), /^100644 blob /);
    assert.deepEqual(git(temporary, '--git-dir', remote, 'diff', '--name-only', preservedParent, next.commit), 'interpolation.js');
    assert.match(git(temporary, '--git-dir', remote, 'show', '-s', '--format=%B', 'dist'), new RegExp(`Source-Commit: ${sourceSha}`));

    await assert.rejects(run({ expectedHash: '0'.repeat(64) }), /SHA-256/);
    await assert.rejects(run({ sourceSha: initialMain }), /checkout/);
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist'), next.commit);

    // 신규 main이 존재하면 예전 실행은 dist를 되돌리지 않습니다.
    const testedSha = sourceSha;
    await writeFile(resolve(root, 'README.md'), 'Even newer source\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'Advance main');
    git(root, 'push', remote, 'HEAD:refs/heads/main');
    git(root, 'checkout', '--detach', testedSha);
    const stale = await run();
    assert.equal(stale.status, 'stale');
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist'), next.commit);
    assert.equal(await readFile(resolve(root, 'dist/interpolation.js'), 'utf8'), bundle);
    // 배포 절차는 source checkout/index를 바꾸지 않습니다.
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(root, 'rev-parse', 'HEAD'), testedSha);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI는 pull request와 로컬 실행에서 발행을 거부한다', () => {
  const script = fileURLToPath(new URL('./publish-dist.mjs', import.meta.url));
  for (const overrides of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'fork/bloom-gamekit' },
  ]) {
    const result = spawnSync(process.execPath, [script], { env: { ...env, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /공식 저장소 main push/);
  }
});

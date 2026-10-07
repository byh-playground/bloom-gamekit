import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishDist } from './publish-dist.mjs';
import { BUNDLE_FILES, createManifest, serializeManifest, sha256 } from './distribution.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const bundleFiles = [...BUNDLE_FILES, 'manifest.json'].sort();
const distribution = (version) => new Map(BUNDLE_FILES.map((file) => [file, Buffer.from(`export const value = '${file}:${version}';\n`)]));
async function writeDistribution(root, bundles) {
  for (const [file, bytes] of bundles) await writeFile(resolve(root, 'dist', file), bytes);
  const manifest = serializeManifest(createManifest(bundles));
  await writeFile(resolve(root, 'dist/manifest.json'), manifest);
  return sha256(manifest);
}

test('dist는 최초 공개 모듈과 manifest만 생성하고, 이후에는 관련 없는 파일과 이력을 보존한다', async () => {
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
    let bundles = distribution(1);
    let expectedManifestHash = await writeDistribution(root, bundles);
    const run = (overrides = {}) => publishDist({ root, remote, sourceSha, expectedManifestHash, env, ...overrides });

    await writeFile(resolve(root, 'dist/not-a-module.txt'), 'Never publish this local file');
    const first = await run();
    assert.equal(first.status, 'published');
    assert.deepEqual(git(temporary, '--git-dir', remote, 'ls-tree', '--name-only', 'dist').split('\n'), bundleFiles);
    for (const [file, bytes] of bundles) assert.equal(git(temporary, '--git-dir', remote, 'show', `dist:${file}`), bytes.toString().trim());
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:manifest.json'), serializeManifest(createManifest(bundles)).trim());
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
    bundles = distribution(2);
    expectedManifestHash = await writeDistribution(root, bundles);
    const next = await run();
    assert.equal(next.status, 'published');
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist^'), preservedParent);
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:keep.txt'), 'Do not change');
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:nested/another.js'), 'export const preserved = true;');
    for (const [file, bytes] of bundles) assert.equal(git(temporary, '--git-dir', remote, 'show', `dist:${file}`), bytes.toString().trim());
    assert.match(git(temporary, '--git-dir', remote, 'ls-tree', 'dist', 'interpolation.js'), /^100644 blob /);
    assert.deepEqual(git(temporary, '--git-dir', remote, 'diff', '--name-only', preservedParent, next.commit).split('\n'), bundleFiles);
    assert.match(git(temporary, '--git-dir', remote, 'show', '-s', '--format=%B', 'dist'), new RegExp(`Source-Commit: ${sourceSha}`));

    const message = git(temporary, '--git-dir', remote, 'show', '-s', '--format=%B', 'dist');
    assert.ok(message.includes(`Manifest-SHA256: ${expectedManifestHash}`));
    for (const [file, bytes] of bundles) assert.ok(message.includes(`Bundle-SHA256: ${file} ${sha256(bytes)}`));
    await assert.rejects(run({ expectedManifestHash: '0'.repeat(64) }), /SHA-256/);
    await assert.rejects(run({ expectedManifestHash: undefined }), /SHA-256/);
    for (const file of BUNDLE_FILES) {
      await writeFile(resolve(root, 'dist', file), 'tampered');
      await assert.rejects(run(), /SHA-256/);
      await writeDistribution(root, bundles);
    }
    const malformed = createManifest(bundles);
    malformed.modules.pop();
    const malformedBytes = serializeManifest(malformed);
    await writeFile(resolve(root, 'dist/manifest.json'), malformedBytes);
    await assert.rejects(run({ expectedManifestHash: sha256(malformedBytes) }), /모듈 목록/);
    await writeDistribution(root, bundles);
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
    for (const [file, bytes] of bundles) assert.deepEqual(await readFile(resolve(root, 'dist', file)), bytes);
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


test('commit 생성 뒤 main 변경과 마지막 push 경합에서도 과거 배포물이 덮어쓰지 않는다', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'gamekit-publish-race-test-'));
  try {
    const root = resolve(temporary, 'source');
    const remote = resolve(temporary, 'remote.git');
    await mkdir(root);
    git(temporary, 'init', '--bare', '--initial-branch=main', remote);
    git(root, 'init', '--initial-branch=main');
    await writeFile(resolve(root, 'README.md'), 'Source\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'Source');
    git(root, 'push', remote, 'HEAD:refs/heads/main');
    const sourceSha = git(root, 'rev-parse', 'HEAD');
    await mkdir(resolve(root, 'dist'));
    let expectedManifestHash = await writeDistribution(root, distribution(1));
    const first = await publishDist({ root, remote, sourceSha, expectedManifestHash, env });
    assert.equal(first.status, 'published');

    await writeFile(resolve(root, 'README.md'), 'Future source\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'Future source');
    const futureSource = git(root, 'rev-parse', 'HEAD');
    git(root, 'push', remote, 'HEAD:refs/heads/future-source');
    git(root, 'checkout', '--detach', sourceSha);

    const other = resolve(temporary, 'other');
    git(temporary, 'clone', '--branch', 'dist', remote, other);
    await writeFile(resolve(other, 'concurrent.txt'), 'Preserve concurrent work\n');
    git(other, 'add', 'concurrent.txt');
    git(other, 'commit', '-m', 'Concurrent distribution');
    const futureDist = git(other, 'rev-parse', 'HEAD');
    git(other, 'push', remote, 'HEAD:refs/heads/future-dist');

    const executable = resolve(temporary, 'bin');
    await mkdir(executable);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = resolve(executable, 'git');
    await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "$GAMEKIT_RACE_COMMAND" ]; then
  if [ "$1" = "commit-tree" ]; then
    result=$("$GAMEKIT_REAL_GIT" "$@") || exit "$?"
  fi
  "$GAMEKIT_REAL_GIT" --git-dir "$GAMEKIT_REMOTE" update-ref "refs/heads/$GAMEKIT_RACE_BRANCH" "$GAMEKIT_RACE_SHA" "$GAMEKIT_RACE_OLD" || exit "$?"
  if [ "$1" = "commit-tree" ]; then
    printf '%s\\n' "$result"
    exit 0
  fi
fi
exec "$GAMEKIT_REAL_GIT" "$@"
`);
    await chmod(wrapper, 0o755);
    expectedManifestHash = await writeDistribution(root, distribution(2));
    const raceEnv = {
      ...env, PATH: `${executable}:${env.PATH}`, GAMEKIT_REAL_GIT: realGit, GAMEKIT_REMOTE: remote,
      GAMEKIT_RACE_COMMAND: 'commit-tree', GAMEKIT_RACE_BRANCH: 'main',
      GAMEKIT_RACE_SHA: futureSource, GAMEKIT_RACE_OLD: sourceSha,
    };
    const stale = await publishDist({ root, remote, sourceSha, expectedManifestHash, env: raceEnv });
    assert.equal(stale.status, 'stale');
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist'), first.commit);
    git(temporary, '--git-dir', remote, 'update-ref', 'refs/heads/main', sourceSha, futureSource);

    // 첫 guard 뒤 dist가 바뀌면 마지막 guard에서 중단합니다.
    Object.assign(raceEnv, { GAMEKIT_RACE_BRANCH: 'dist', GAMEKIT_RACE_SHA: futureDist, GAMEKIT_RACE_OLD: first.commit });
    await assert.rejects(publishDist({ root, remote, sourceSha, expectedManifestHash, env: raceEnv }), /다른 실행/);
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist'), futureDist);
    git(temporary, '--git-dir', remote, 'update-ref', 'refs/heads/dist', first.commit, futureDist);

    // 마지막 guard 직후의 경합도 force 없는 push가 non-fast-forward로 거부합니다.
    raceEnv.GAMEKIT_RACE_COMMAND = 'push';
    await assert.rejects(publishDist({ root, remote, sourceSha, expectedManifestHash, env: raceEnv }), /git push 실패/);
    assert.equal(git(temporary, '--git-dir', remote, 'rev-parse', 'dist'), futureDist);
    assert.equal(git(temporary, '--git-dir', remote, 'show', 'dist:concurrent.txt'), 'Preserve concurrent work');
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(root, 'rev-parse', 'HEAD'), sourceSha);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

// export는 파일 시스템 안의 bare 저장소로 배포 절차를 회귀 검사하기 위한 경계입니다.
export async function publishDist({ root, remote, sourceSha, expectedHash, env = process.env }) {
  if (!SHA.test(sourceSha) || !HASH.test(expectedHash)) throw new Error('유효한 source SHA와 bundle hash가 필요합니다.');
  const bundle = await readFile(resolve(root, 'dist/interpolation.js'));
  if (createHash('sha256').update(bundle).digest('hex') !== expectedHash) {
    throw new Error('검사를 통과한 배포물의 SHA-256과 재빌드 결과가 다릅니다.');
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'gamekit-publish-'));
  const gitEnv = {
    ...env,
    GIT_INDEX_FILE: resolve(temporary, 'index'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  };
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: root, env: gitEnv, input, encoding: 'utf8', timeout: 60_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} 실패: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const remoteHead = (branch) => {
    const line = git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    if (line === '') return null;
    const [sha, ref] = line.split(/\s+/);
    if (!SHA.test(sha) || ref !== `refs/heads/${branch}`) throw new Error('예상과 다른 원격 branch 응답입니다.');
    return sha;
  };

  try {
    if (git(['rev-parse', 'HEAD']) !== sourceSha) throw new Error('checkout과 source SHA가 다릅니다.');
    // 오래된 실행을 다시 실행해도 최신 main의 배포물을 되돌리지 않습니다.
    if (remoteHead('main') !== sourceSha) return { status: 'stale' };

    let parent = remoteHead('dist');
    if (parent !== null) {
      git(['fetch', '--no-tags', remote, 'refs/heads/dist']);
      parent = git(['rev-parse', 'FETCH_HEAD']);
      git(['read-tree', parent]);
    } else {
      git(['read-tree', '--empty']);
    }

    const blob = git(['hash-object', '-w', '--stdin'], bundle);
    // 기존 tree에서 이 파일만 교체합니다. 다른 패키지·문서·기존 파일은 보존합니다.
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},interpolation.js`]);
    const tree = git(['write-tree']);
    if (parent !== null && tree === git(['rev-parse', `${parent}^{tree}`])) return { status: 'unchanged', commit: parent };

    const args = ['commit-tree', tree];
    if (parent !== null) args.push('-p', parent);
    const commit = git(args, `[chore] interpolation 배포물 갱신\n\nSource-Commit: ${sourceSha}\nBundle-SHA256: ${expectedHash}\n`);

    if (remoteHead('main') !== sourceSha) return { status: 'stale' };
    if (remoteHead('dist') !== parent) throw new Error('dist가 다른 실행에서 변경되었습니다. 덮어쓰지 않고 중단합니다.');
    // force/force-with-lease를 사용하지 않습니다. 경합은 non-fast-forward로 실패합니다.
    git(['push', remote, `${commit}:refs/heads/dist`]);
    if (remoteHead('dist') !== commit) throw new Error('원격 dist의 commit을 확인할 수 없습니다.');
    return { status: 'published', commit };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_SHA,
    GITHUB_SERVER_URL, GITHUB_TOKEN, EXPECTED_BUNDLE_SHA256 } = process.env;
  if (GITHUB_ACTIONS !== 'true' || GITHUB_EVENT_NAME !== 'push' || GITHUB_REF !== 'refs/heads/main'
      || GITHUB_REPOSITORY !== 'byh-playground/bloom-gamekit' || GITHUB_SERVER_URL !== 'https://github.com') {
    throw new Error('공식 저장소 main push의 GitHub Actions에서만 배포할 수 있습니다.');
  }
  if (!GITHUB_TOKEN) throw new Error('배포 step의 GITHUB_TOKEN이 필요합니다.');
  // 인증 헤더는 이 프로세스의 git 자식에만 전달하고 파일이나 URL에 저장하지 않습니다.
  const auth = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };
  delete env.GITHUB_TOKEN;
  const result = await publishDist({
    root: fileURLToPath(new URL('../', import.meta.url)),
    remote: `https://github.com/${GITHUB_REPOSITORY}.git`,
    sourceSha: GITHUB_SHA,
    expectedHash: EXPECTED_BUNDLE_SHA256,
    env,
  });
  console.log(`dist: ${result.status}${result.commit ? ` (${result.commit})` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

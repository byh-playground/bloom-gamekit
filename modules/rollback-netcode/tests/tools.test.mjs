import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { demoPath, root, serveRepository } from '../scripts/browser-helpers.mjs';

test('한국어 예제는 현재 독립 번들과 모듈 문서를 참조한다', async () => {
  const html = await readFile(resolve(root, `.${demoPath}`), 'utf8');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /from '\.\.\/\.\.\/\.\.\/dist\/rollback-netcode\.js'/);
  assert.match(html, /href="\.\.\/README\.md"/);
  assert.doesNotMatch(html, /github\.com\/byh-playground\/rollback-netcode|github\.io\/rollback-netcode/);
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(code, 'demo contains an ES module');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('검사 서버는 실제 예제 경로로 이동하고 현재 번들/기존 그룹 화면을 제공한다', async () => {
  const server = await serveRepository();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const redirect = await fetch(base, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), demoPath);
    const example = await fetch(base + demoPath);
    assert.equal(example.status, 200);
    assert.match(example.headers.get('content-type'), /text\/html/);
    const bundle = await fetch(new URL('../../../dist/rollback-netcode.js', base + demoPath));
    assert.equal(bundle.status, 200, 'npm run build must produce the demo bundle');
    assert.match(bundle.headers.get('content-type'), /text\/javascript/);
    const group = await fetch(base + '/modules/rollback-netcode/tests/group-browser.html');
    assert.equal(group.status, 200);
    const scriptPath = (await group.text()).match(/<script[^>]*src="([^"]+)"/)?.[1];
    assert.ok(scriptPath);
    assert.equal((await fetch(new URL(scriptPath, group.url))).status, 200);
    assert.equal((await fetch(base + '/.git/config')).status, 403);
    assert.equal((await fetch(base + '/not-present')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});

test('공개 릴레이 검사는 명시적 opt-in 없이는 실행하지 않는다', () => {
  const env = { ...process.env };
  delete env.RUN_LIVE_ROOM_CHECK;
  const result = spawnSync(process.execPath, ['modules/rollback-netcode/scripts/live-room-check.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_LIVE_ROOM_CHECK=1/);
});

test('게임 벤치는 사용자가 지정한 로컬 Rally fixture가 필요하다', () => {
  const env = { ...process.env };
  delete env.RALLY_HTML;
  const result = spawnSync(process.execPath, ['modules/rollback-netcode/scripts/rally-benchmark.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RALLY_HTML/);
});

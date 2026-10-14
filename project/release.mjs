import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION } from '../modules/_rollback-shared/version.js';
import { MANIFEST_FILE, readVerifiedDistribution } from './distribution.mjs';

export function inspectRelease({ git, remote, version = VERSION, files }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('SDK VERSION must be MAJOR.MINOR.PATCH');
  const tag = `v${version}`, ref = `refs/tags/${tag}`;
  const existing = git(['ls-remote', '--refs', remote, ref]);
  if (!existing) return { tag, commit: null };
  const [object, actualRef] = existing.split(/\s+/);
  if (!/^[a-f0-9]{40}$/.test(object) || actualRef !== ref) throw new Error('Invalid release tag ref');
  git(['fetch', '--no-tags', remote, ref]);
  const commit = git(['rev-parse', 'FETCH_HEAD^{commit}']);
  // Tags are immutable: compare the actual blobs, not just a claimed manifest digest.
  for (const [file, bytes] of files) {
    const expected = git(['hash-object', '--stdin'], bytes);
    let actual;
    try { actual = git(['rev-parse', `${commit}:${file}`]); } catch { actual = null; }
    if (actual !== expected) throw new Error(`${tag} already exists with different ${file}; bump SDK VERSION. The tag will not be moved.`);
  }
  return { tag, commit };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { bundles, assets, manifestBytes } = await readVerifiedDistribution(root);
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 60000 });
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    return result.stdout.trim();
  };
  const release = inspectRelease({ git, remote: 'https://github.com/byh-playground/bloom-gamekit.git', files: [...bundles, ...assets, [MANIFEST_FILE, manifestBytes]] });
  console.log(`${release.tag}: ${release.commit ? `existing bytes verified (${release.commit})` : 'new release'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

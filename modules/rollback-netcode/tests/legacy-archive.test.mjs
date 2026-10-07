import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
const root = new URL('../legacy/', import.meta.url);
const digest = (b, algorithm = 'sha256') => createHash(algorithm).update(b).digest('hex');
test('historical rollback snapshot preserves every pinned source byte and staged content hash', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const zip = readFileSync(new URL(manifest.archive, root));
  assert.equal(digest(zip), manifest.archiveSha256);
  assert.equal(manifest.commit, 'c3173914519a78834360430071e7a125736d86d5');
  const entries = new Map();
  for (let pos = 0; zip.readUInt32LE(pos) === 0x04034b50;) {
    const flags = zip.readUInt16LE(pos + 6), method = zip.readUInt16LE(pos + 8);
    assert.equal(flags & 8, 0, 'snapshot has explicit compressed sizes');
    const size = zip.readUInt32LE(pos + 18), nameSize = zip.readUInt16LE(pos + 26), extraSize = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 30, pos + 30 + nameSize).toString('utf8');
    const start = pos + 30 + nameSize + extraSize, compressed = zip.subarray(start, start + size);
    assert.ok(!entries.has(name));
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    pos = start + size;
  }
  assert.equal(entries.size, 54);
  assert.equal(entries.size, manifest.files.length);
  for (const file of manifest.files) {
    const bytes = entries.get(file.path);
    assert.ok(bytes, file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(digest(bytes), file.sha256, file.path);
    assert.equal(digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1'), file.gitBlobSha, file.path);
  }
  const stagedHash = 'e577f63fc8f5e88e55202afbb354aa3f50e95f8847d04987a77d0211488ff77a';
  assert.equal(digest(entries.get(`versions/${stagedHash}/rollback-netcode.js`)), stagedHash);
});

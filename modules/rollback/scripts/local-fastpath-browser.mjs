import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/modules/rollback/tests/browser.html`);
  const result = await page.evaluate(async () => {
    const { createRoomSession, profiles } = await import('/dist/rollback.js');
    const createWorld = () => ({ position: 0, tick: 0, commands: 0, memberships: 0 });
    const makeAdapter = world => {
      let saveCalls = 0, loadCalls = 0;
      return {
        get saveCalls() { return saveCalls; }, get loadCalls() { return loadCalls; },
        save() { saveCalls++; return Uint8Array.of(world.position, world.tick, world.commands, world.memberships); },
        load(bytes) { loadCalls++; [world.position, world.tick, world.commands, world.memberships] = bytes; },
        validateSnapshot(bytes) { return bytes.length === 4; },
        applyMembership() { world.memberships++; },
        step(frame) {
          const input = frame.inputs[0];
          world.position += input.input[0];
          for (const command of input.commands) world.commands += command.payload[0];
          world.tick++;
        },
      };
    };
    const profile = { ...profiles.lockstep, baseInputDelayTicks: 0, minInputDelayTicks: 0, maxInputDelayTicks: 0,
      adaptiveInputDelay: false, pacingPolicy: 'none', checksumInterval: 2, stateHistorySize: 16, maxCatchupSteps: 1 };
    const fastWorld = createWorld(), regularWorld = createWorld();
    const fastAdapter = makeAdapter(fastWorld), regularAdapter = makeAdapter(regularWorld);
    const create = (adapter, localFastPath = false) => createRoomSession({ mode: 'local', localFastPath, simulationVersion: 'fastpath-test-v1', inputSize: 1, profile, adapter });
    const fast = create(fastAdapter, true), regular = create(regularAdapter);
    const statuses = [];
    for (let tick = 0; tick < 8; tick++) {
      fast.queueCommand(Uint8Array.of(tick + 1)); regular.queueCommand(Uint8Array.of(tick + 1));
      statuses.push([fast.advance(Uint8Array.of(tick + 2)).status, regular.advance(Uint8Array.of(tick + 2)).status]);
    }
    const beforeExplicitSave = {
      fastSaveCalls: fastAdapter.saveCalls, fastLoadCalls: fastAdapter.loadCalls,
      regularSaveCalls: regularAdapter.saveCalls, fastMetrics: fast.metrics, regularMetrics: regular.metrics,
      fastHash: fast.getStateHash(), regularHash: regular.getStateHash(),
      fastCommandSequence: fast.localInputState.executedCommandSequence,
      regularCommandSequence: regular.localInputState.executedCommandSequence,
    };
    const fastSave = fastAdapter.save(), regularSave = regularAdapter.save();
    fastWorld.position = 0; fastAdapter.load(fastSave);
    const explicitLoadStillWorks = fastAdapter.save().every((byte, index) => byte === fastSave[index]);
    let rollbackRejected = false, onlineRejected = false;
    try { createRoomSession({ mode: 'local', localFastPath: true, simulationVersion: 'invalid-v1', inputSize: 1,
      profile: { ...profiles.action, mode: 'rollback' }, adapter: makeAdapter(createWorld()) }); }
    catch { rollbackRejected = true; }
    const room = { players: ['local'], localPlayerId: 'local', epoch: 0, coordinatorId: 'local', transports: new Map(),
      subscribe() { return () => {}; }, connectMesh() {}, setRoster() {} };
    try { createRoomSession({ mode: 'online', room, localPlayerId: 'local', localFastPath: true, simulationVersion: 'invalid-v1', inputSize: 1,
      profile, adapter: { ...makeAdapter(createWorld()), applyMembership() {} } }); }
    catch { onlineRejected = true; }
    const brokenWorld = createWorld(), brokenAdapter = makeAdapter(brokenWorld);
    brokenAdapter.step = () => { brokenWorld.position++; throw new Error('expected simulation failure'); };
    const broken = create(brokenAdapter, true);
    try { broken.advance(Uint8Array.of(1)); } catch {}
    const failedWithoutRestore = broken.failure?.type === 'fatal' && broken.failure.restoreUnavailable === true &&
      brokenAdapter.saveCalls === 0 && brokenAdapter.loadCalls === 0;
    fast.close(); regular.close(); broken.close();
    return { statuses, beforeExplicitSave, worldsEqual: JSON.stringify(fastWorld) === JSON.stringify(regularWorld),
      explicitSaveEqual: fastSave.every((byte, index) => byte === regularSave[index]), explicitLoadStillWorks, rollbackRejected, onlineRejected, failedWithoutRestore };
  });
  assert.deepEqual(errors, [], 'browser runtime errors');
  assert.ok(result.statuses.every(([fast, regular]) => fast === 'advanced' && regular === 'advanced'), 'both sessions advance every tick');
  assert.equal(result.worldsEqual, true, 'same input and commands produce the same world in the shared simulation path');
  assert.equal(result.explicitSaveEqual, true, 'explicit save bytes agree');
  assert.equal(result.explicitLoadStillWorks, true, 'app-owned explicit save/load remains available');
  assert.equal(result.beforeExplicitSave.fastSaveCalls, 0, 'fast path never calls adapter.save internally');
  assert.equal(result.beforeExplicitSave.fastLoadCalls, 0, 'fast path never calls adapter.load internally');
  assert.equal(result.beforeExplicitSave.fastHash, undefined, 'fast path exposes no state hash');
  for (const key of ['snapshotSaves', 'serializedSnapshotBytes', 'retainedSnapshotBytes', 'stateHashComputations', 'hashedStateBytes']) {
    assert.equal(result.beforeExplicitSave.fastMetrics[key], 0, `fast path ${key} stays zero`);
  }
  assert.equal(result.beforeExplicitSave.regularSaveCalls, 5, 'default local lockstep retains initial and four periodic snapshots');
  assert.equal(result.beforeExplicitSave.regularMetrics.snapshotSaves, 5, 'default metrics preserve existing snapshot behavior');
  assert.equal(result.beforeExplicitSave.regularHash !== undefined, true, 'default local session still provides a state hash');
  assert.equal(result.beforeExplicitSave.fastCommandSequence, 8, 'fast path executes all commands');
  assert.equal(result.beforeExplicitSave.regularCommandSequence, 8, 'default path executes all commands');
  assert.equal(result.rollbackRejected, true, 'fast path rejects rollback profiles');
  assert.equal(result.onlineRejected, true, 'fast path rejects online rooms');
  assert.equal(result.failedWithoutRestore, true, 'a failed fast-path step becomes fatal without hidden save/load calls');
  console.log(JSON.stringify({ status: 'PASS', ticks: result.statuses.length, internalSaveCalls: result.beforeExplicitSave.fastSaveCalls,
    defaultSaveCalls: result.beforeExplicitSave.regularSaveCalls, hashes: result.beforeExplicitSave.fastMetrics.stateHashComputations,
    sameWorld: result.worldsEqual, explicitSaveLoad: result.explicitLoadStillWorks }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

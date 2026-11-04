import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const SERVER = createServer(async (req, res) => {
    try {
        const PATH = resolve(ROOT, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
        if (!PATH.startsWith(ROOT + sep)) {
            res.writeHead(403).end();
            return;
        }
        res.setHeader(
            'Content-Type',
            {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.json': 'application/json',
            }[extname(PATH)] ?? 'application/octet-stream',
        );
        res.end(await readFile(PATH));
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve, reject) => {
    SERVER.once('error', reject);
    SERVER.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : {}),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const PAGE = await browser.newPage();
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/rollback/tests/browser.html`);
    const RESULT = await PAGE.evaluate(async () => {
        const { createRoomSession: CREATE_ROOM_SESSION, profiles: PROFILES } = await import('/dist/rollback.js');
        const { playReplay: PLAY_REPLAY } = await import('/dist/replay.js');
        const CREATE_WORLD = () => ({
            position: 0,
            tick: 0,
            commands: 0,
            memberships: 0,
        });
        const MAKE_ADAPTER = (world) => {
            let saveCalls = 0;
            let loadCalls = 0;
            return {
                get saveCalls() {
                    return saveCalls;
                },
                get loadCalls() {
                    return loadCalls;
                },
                save() {
                    saveCalls++;
                    return Uint8Array.of(world.position, world.tick, world.commands, world.memberships);
                },
                load(bytes) {
                    loadCalls++;
                    [world.position, world.tick, world.commands, world.memberships] = bytes;
                },
                validateSnapshot(bytes) {
                    return bytes.length === 4;
                },
                applyMembership() {
                    world.memberships++;
                },
                step(frame) {
                    const INPUT = frame.inputs[0];
                    world.position += INPUT.input[0];
                    for (const COMMAND of INPUT.commands) {
                        world.commands += COMMAND.payload[0];
                    }
                    world.tick++;
                },
            };
        };
        const PROFILE = {
            ...PROFILES.lockstep,
            baseInputDelayTicks: 0,
            minInputDelayTicks: 0,
            maxInputDelayTicks: 0,
            adaptiveInputDelay: false,
            pacingPolicy: 'none',
            checksumInterval: 2,
            stateHistorySize: 16,
            maxCatchupSteps: 1,
        };
        const FAST_WORLD = CREATE_WORLD(),
            REGULAR_WORLD = CREATE_WORLD();
        const FAST_ADAPTER = MAKE_ADAPTER(FAST_WORLD),
            REGULAR_ADAPTER = MAKE_ADAPTER(REGULAR_WORLD);
        const CREATE = (adapter, localFastPath = false, recordReplay = false) =>
            CREATE_ROOM_SESSION({
                mode: 'local',
                localFastPath,
                recordReplay,
                simulationVersion: 'fastpath-test-v1',
                inputSize: 1,
                profile: PROFILE,
                adapter,
            });
        const FAST = CREATE(FAST_ADAPTER, true),
            REGULAR = CREATE(REGULAR_ADAPTER);
        const STATUSES = [];
        for (let tick = 0; tick < 8; tick++) {
            FAST.queueCommand(Uint8Array.of(tick + 1));
            REGULAR.queueCommand(Uint8Array.of(tick + 1));
            STATUSES.push([
                FAST.advance(Uint8Array.of(tick + 2)).status,
                REGULAR.advance(Uint8Array.of(tick + 2)).status,
            ]);
        }
        const BEFORE_EXPLICIT_SAVE = {
            fastSaveCalls: FAST_ADAPTER.saveCalls,
            fastLoadCalls: FAST_ADAPTER.loadCalls,
            regularSaveCalls: REGULAR_ADAPTER.saveCalls,
            fastMetrics: FAST.metrics,
            regularMetrics: REGULAR.metrics,
            fastHash: FAST.getStateHash(),
            regularHash: REGULAR.getStateHash(),
            fastCommandSequence: FAST.localInputState.executedCommandSequence,
            regularCommandSequence: REGULAR.localInputState.executedCommandSequence,
        };
        // Opted-in replay: one initial save, inputs kept only where they change.
        const RECORDED_WORLD = CREATE_WORLD(),
            RECORDED_ADAPTER = MAKE_ADAPTER(RECORDED_WORLD),
            RECORDED = CREATE(RECORDED_ADAPTER, true, true);
        for (let tick = 0; tick < 12; tick++) {
            if (tick === 2 || tick === 7) {
                RECORDED.queueCommand(Uint8Array.of(tick));
            }
            RECORDED.advance(Uint8Array.of(Math.floor(tick / 3) + 1));
        }
        const RECORDED_SAVES_BEFORE_EXPORT = RECORDED_ADAPTER.saveCalls;
        const ROOM_REPLAY = RECORDED.exportReplay();
        const PLAYED_WORLD = CREATE_WORLD();
        const PLAYED = PLAY_REPLAY({ adapter: MAKE_ADAPTER(PLAYED_WORLD), replay: ROOM_REPLAY.segments[0] });
        RECORDED.close();
        let replayWithoutOptInRejected = false;
        try {
            FAST.exportReplay();
        } catch {
            replayWithoutOptInRejected = true;
        }
        const FAST_SAVE = FAST_ADAPTER.save(),
            REGULAR_SAVE = REGULAR_ADAPTER.save();
        FAST_WORLD.position = 0;
        FAST_ADAPTER.load(FAST_SAVE);
        const EXPLICIT_LOAD_STILL_WORKS = FAST_ADAPTER.save().every((byte, index) => byte === FAST_SAVE[index]);
        let rollbackRejected = false;
        let onlineRejected = false;
        try {
            CREATE_ROOM_SESSION({
                mode: 'local',
                localFastPath: true,
                simulationVersion: 'invalid-v1',
                inputSize: 1,
                profile: {
                    ...PROFILES.action,
                    mode: 'rollback',
                },
                adapter: MAKE_ADAPTER(CREATE_WORLD()),
            });
        } catch {
            rollbackRejected = true;
        }
        const ROOM = {
            players: ['local'],
            localPlayerId: 'local',
            epoch: 0,
            coordinatorId: 'local',
            transports: new Map(),
            subscribe() {
                return () => {};
            },
            connectMesh() {},
            setRoster() {},
        };
        try {
            CREATE_ROOM_SESSION({
                mode: 'online',
                room: ROOM,
                localPlayerId: 'local',
                localFastPath: true,
                simulationVersion: 'invalid-v1',
                inputSize: 1,
                profile: PROFILE,
                adapter: {
                    ...MAKE_ADAPTER(CREATE_WORLD()),
                    applyMembership() {},
                },
            });
        } catch {
            onlineRejected = true;
        }
        const BROKEN_WORLD = CREATE_WORLD(),
            BROKEN_ADAPTER = MAKE_ADAPTER(BROKEN_WORLD);
        BROKEN_ADAPTER.step = () => {
            BROKEN_WORLD.position++;
            throw new Error('expected simulation failure');
        };
        const BROKEN = CREATE(BROKEN_ADAPTER, true);
        try {
            BROKEN.advance(Uint8Array.of(1));
        } catch {
            // The deliberate adapter failure is checked through the public failure state below.
        }
        const FAILED_WITHOUT_RESTORE =
            BROKEN.failure?.type === 'fatal' &&
            BROKEN.failure.restoreUnavailable === true &&
            BROKEN_ADAPTER.saveCalls === 0 &&
            BROKEN_ADAPTER.loadCalls === 0;
        FAST.close();
        REGULAR.close();
        BROKEN.close();
        return {
            statuses: STATUSES,
            beforeExplicitSave: BEFORE_EXPLICIT_SAVE,
            worldsEqual: JSON.stringify(FAST_WORLD) === JSON.stringify(REGULAR_WORLD),
            explicitSaveEqual: FAST_SAVE.every((byte, index) => byte === REGULAR_SAVE[index]),
            explicitLoadStillWorks: EXPLICIT_LOAD_STILL_WORKS,
            rollbackRejected,
            onlineRejected,
            failedWithoutRestore: FAILED_WITHOUT_RESTORE,
            replay: {
                savesBeforeExport: RECORDED_SAVES_BEFORE_EXPORT,
                segments: ROOM_REPLAY.segments.length,
                tick: ROOM_REPLAY.segments[0].tick,
                truncated: ROOM_REPLAY.segments[0].truncated,
                inputChangeBytes: ROOM_REPLAY.segments[0].inputChanges.length,
                commands: ROOM_REPLAY.segments[0].commands.map((c) => [c.tick, c.payload[0]]),
                played: PLAYED,
                hash: ROOM_REPLAY.segments[0].hash,
                sameWorld: JSON.stringify(PLAYED_WORLD) === JSON.stringify(RECORDED_WORLD),
                withoutOptInRejected: replayWithoutOptInRejected,
            },
        };
    });
    assert.deepEqual(ERRORS, [], 'browser runtime errors');
    assert.ok(
        RESULT.statuses.every(([fast, regular]) => fast === 'advanced' && regular === 'advanced'),
        'both sessions advance every tick',
    );
    assert.equal(
        RESULT.worldsEqual,
        true,
        'same input and commands produce the same world in the shared simulation path',
    );
    assert.equal(RESULT.explicitSaveEqual, true, 'explicit save bytes agree');
    assert.equal(RESULT.explicitLoadStillWorks, true, 'app-owned explicit save/load remains available');
    assert.equal(RESULT.beforeExplicitSave.fastSaveCalls, 0, 'fast path never calls adapter.save internally');
    assert.equal(RESULT.beforeExplicitSave.fastLoadCalls, 0, 'fast path never calls adapter.load internally');
    assert.equal(RESULT.beforeExplicitSave.fastHash, undefined, 'fast path exposes no state hash');
    for (const KEY of [
        'snapshotSaves',
        'serializedSnapshotBytes',
        'retainedSnapshotBytes',
        'stateHashComputations',
        'hashedStateBytes',
    ]) {
        assert.equal(RESULT.beforeExplicitSave.fastMetrics[KEY], 0, `fast path ${KEY} stays zero`);
    }
    assert.equal(
        RESULT.beforeExplicitSave.regularSaveCalls,
        5,
        'default local lockstep retains initial and four periodic snapshots',
    );
    assert.equal(
        RESULT.beforeExplicitSave.regularMetrics.snapshotSaves,
        5,
        'default metrics preserve existing snapshot behavior',
    );
    assert.equal(
        RESULT.beforeExplicitSave.regularHash !== undefined,
        true,
        'default local session still provides a state hash',
    );
    assert.equal(RESULT.beforeExplicitSave.fastCommandSequence, 8, 'fast path executes all commands');
    assert.equal(RESULT.beforeExplicitSave.regularCommandSequence, 8, 'default path executes all commands');
    assert.equal(RESULT.rollbackRejected, true, 'fast path rejects rollback profiles');
    assert.equal(RESULT.onlineRejected, true, 'fast path rejects online rooms');
    assert.equal(
        RESULT.failedWithoutRestore,
        true,
        'a failed fast-path step becomes fatal without hidden save/load calls',
    );
    assert.equal(RESULT.replay.savesBeforeExport, 1, 'recorded fast path saves only the initial state');
    assert.equal(RESULT.replay.segments, 1, 'local room has one replay segment');
    assert.equal(RESULT.replay.tick, 12, 'recorded fast path keeps every executed tick');
    assert.equal(RESULT.replay.truncated, false, 'recorded fast path replay is complete');
    assert.equal(RESULT.replay.inputChangeBytes, 12, 'four input changes of one byte each are stored');
    assert.deepEqual(
        RESULT.replay.commands,
        [
            [2, 2],
            [7, 7],
        ],
        'commands keep their execute tick',
    );
    assert.deepEqual(RESULT.replay.played, { tick: 12, hash: RESULT.replay.hash }, 'replay reproduces the hash');
    assert.equal(RESULT.replay.sameWorld, true, 'replay reproduces the world');
    assert.equal(RESULT.replay.withoutOptInRejected, true, 'fast path without recordReplay has no replay');
    console.log(
        JSON.stringify({
            status: 'PASS',
            replayInputBytes: RESULT.replay.inputChangeBytes,
            ticks: RESULT.statuses.length,
            internalSaveCalls: RESULT.beforeExplicitSave.fastSaveCalls,
            defaultSaveCalls: RESULT.beforeExplicitSave.regularSaveCalls,
            hashes: RESULT.beforeExplicitSave.fastMetrics.stateHashComputations,
            sameWorld: RESULT.worldsEqual,
            explicitSaveLoad: RESULT.explicitLoadStillWorks,
        }),
    );
} finally {
    await browser?.close();
    await new Promise((resolve) => SERVER.close(resolve));
}

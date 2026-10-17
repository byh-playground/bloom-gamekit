import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const SIMULATION_MODE = process.env.ROOM_SIMULATION_MODE ?? 'lockstep';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    ERRORS = [],
    RESULTS = [];
const SERVER = createServer(async (req, res) => {
    try {
        const URL_LOCAL = new URL(req.url, 'http://localhost').pathname;
        const BASE =
            process.env.INPUT_BASELINE_DIST && URL_LOCAL.startsWith('/dist/')
                ? resolve(process.env.INPUT_BASELINE_DIST)
                : ROOT;
        const PATH = resolve(BASE, '.' + (BASE === ROOT ? URL_LOCAL : URL_LOCAL.slice(5)));
        if (!PATH.startsWith(BASE + sep)) {
            res.writeHead(403).end();
            return;
        }
        const DATA = await readFile(PATH);
        res.writeHead(200, {
            'content-type': extname(PATH) === '.html' ? 'text/html' : 'text/javascript',
            'cache-control': 'no-store',
        }).end(DATA);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok) => SERVER.listen(0, '127.0.0.1', ok));
let browser;
const SLEEP = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function snapshots(pages) {
    return Promise.all(pages.map((p) => p.evaluate(() => window.snapshot())));
}
async function until(pages, predicate, label, timeout = 18000) {
    const END = Date.now() + timeout;
    while (Date.now() < END) {
        const VALUES = await snapshots(pages);
        if (VALUES.some((s) => s.failure)) {
            throw new Error(label + ': ' + JSON.stringify(VALUES));
        }
        if (predicate(VALUES)) {
            return VALUES;
        }
        await SLEEP(80);
    }
    throw new Error(
        label +
            ' timeout: ' +
            JSON.stringify(await Promise.all(pages.map((p) => p.evaluate(() => window.diagnostics())))),
    );
}
async function room(count, available = true, transfer = false, cooperative = false, rates = null) {
    const CONTEXT = await browser.newContext(),
        CONTEXTS = [CONTEXT],
        PAGES = [],
        PLAYERS = ['A', 'B', 'C', 'D'].slice(0, count);
    for (const ID of PLAYERS) {
        const OWNER = rates?.remote && PAGES.length ? await browser.newContext() : CONTEXT;
        if (OWNER !== CONTEXT) {
            CONTEXTS.push(OWNER);
        }
        const PAGE = await OWNER.newPage();
        PAGE.on('pageerror', (e) => ERRORS.push(e.message));
        await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/rollback/tests/availability-browser.html`);
        await PAGE.waitForFunction(() => typeof window.setup === 'function');
        if (rates?.remote) {
            const CDP = await OWNER.newCDPSession(PAGE);
            await CDP.send('Emulation.setFocusEmulationEnabled', {
                enabled: true,
            });
        }
        await PAGE.evaluate(
            ({ id, players, available, transfer, cooperative, simulationMode, rates }) =>
                rates
                    ? window.setupLatency(id, players, rates)
                    : window.setup(id, players, available, transfer, cooperative, simulationMode),
            {
                id: ID,
                players: PLAYERS,
                available,
                transfer,
                cooperative,
                simulationMode: SIMULATION_MODE,
                rates,
            },
        );
        PAGES.push(PAGE);
    }
    for (let a = 0; a < count; a++) {
        for (let b = a + 1; b < count; b++) {
            const OFFER = await PAGES[a].evaluate((id) => window.offer(id), PLAYERS[b]);
            const ANSWER = await PAGES[b].evaluate(({ id, offer }) => window.answer(id, offer), {
                id: PLAYERS[a],
                offer: OFFER,
            });
            await PAGES[a].evaluate(({ id, answer }) => window.accept(id, answer), {
                id: PLAYERS[b],
                answer: ANSWER,
            });
        }
    }
    await Promise.all(PAGES.map((p) => p.evaluate(() => window.startPump())));
    await until(
        PAGES,
        (values) =>
            values.every((s) => s.tick >= 15 && s.status === 'running' && s.activePlayers.length === count) &&
            new Set(values.map((s) => s.branch)).size === 1,
        'initial play',
    );
    return {
        pages: PAGES,
        context: CONTEXT,
        contexts: CONTEXTS,
        players: PLAYERS,
    };
}
async function checkpoint(pages, label, resume = true) {
    await until(
        pages,
        (values) =>
            values.every((s) => s.status === 'running' && s.activePlayers.length === pages.length) &&
            new Set(values.map((s) => s.branch)).size === 1,
        label + ' reconnect ready',
    );
    const VALUES = await snapshots(pages),
        TICK = Math.max(...VALUES.map((s) => s.tick)) + 4;
    await Promise.all(pages.map((p) => p.evaluate((t) => window.setTarget(t), TICK)));
    const SAME = await until(
        pages,
        (values) =>
            values.every(
                (s) => s.tick === TICK && s.confirmedTick + 1 >= TICK && !s.resimulating && s.status === 'running',
            ),
        label,
    );
    assert.equal(new Set(SAME.map((s) => s.hash)).size, 1, label + ' same state');
    RESULTS.push({
        label,
        tick: TICK,
        hash: SAME[0].hash,
        coordinatorId: SAME[0].coordinatorId,
    });
    if (resume) {
        await Promise.all(pages.map((p) => p.evaluate(() => window.setTarget(Infinity))));
    }
}
async function closeRoom(value) {
    await Promise.all(value.pages.map((p) => p.evaluate(() => window.stop()).catch(() => {})));
    await Promise.all((value.contexts ?? [value.context]).map((c) => c.close()));
}
try {
    browser = await chromium.launch({
        headless: process.env.AVAILABILITY_HEADED !== '1',
        ignoreDefaultArgs: process.env.REMOTE_INPUT_LATENCY
            ? []
            : [
                  '--disable-background-timer-throttling',
                  '--disable-renderer-backgrounding',
                  '--disable-backgrounding-occluded-windows',
              ],
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : process.env.BROWSER_CHANNEL
              ? {
                    channel: process.env.BROWSER_CHANNEL,
                }
              : {}),
    });
    if (process.env.INPUT_LATENCY) {
        const SAMPLES = [];
        const CONFIGURATIONS = process.env.INPUT_POLICY_EXPERIMENT
            ? [
                  {
                      label: 'aggressive',
                      inputSafetyMarginMs: 0,
                      inputJitterMultiplier: 0,
                  },
                  {
                      label: 'balanced',
                      inputSafetyMarginMs: 8,
                      inputJitterMultiplier: 2,
                  },
                  {
                      label: 'conservative',
                      inputSafetyMarginMs: 40,
                      inputJitterMultiplier: 3,
                  },
              ].map(({ label, ...policy }) => ({
                  simulationHz: 15,
                  inputHz: 60,
                  renderHz: 60,
                  label,
                  policy: {
                      inputScheduling: 'network',
                      ...policy,
                  },
              }))
            : [
                  {
                      simulationHz: 5,
                      inputHz: 30,
                      renderHz: 60,
                  },
                  {
                      simulationHz: 15,
                      inputHz: 40,
                      renderHz: 30,
                  },
              ];
        for (const RATES of CONFIGURATIONS) {
            RATES.remote = process.env.REMOTE_INPUT_LATENCY === '1';
            const PAIR = await room(2, false, false, false, RATES),
                HOST = PAIR.pages[0];
            if (RATES.policy) {
                await Promise.all(
                    PAIR.pages.map((p) =>
                        p.evaluate(() => window.networkDelay(35, [0, 0, 3, 0, 0, 12, 0, 0, 0, 80, 0, 0])),
                    ),
                );
                const WARM = await snapshots(PAIR.pages);
                await until(
                    PAIR.pages,
                    (v) => v.every((s, i) => s.tick >= WARM[i].tick + 20 && s.metrics.smoothedRTT > 40),
                    'network estimate warmup',
                );
            }
            await HOST.bringToFront();
            await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.beginMeasurement())));
            if (RATES.remote) {
                const CLOCK_BEFORE = await HOST.evaluate(() => window.synchronizeClock());
                const COMMAND_COUNT = RATES.policy ? 24 : 8;
                for (let id = 1; id <= COMMAND_COUNT; id++) {
                    const DELAY_MS = id <= 4 ? 10 : 3500 / RATES.simulationHz;
                    await HOST.evaluate(
                        ({ id, delayMs, network }) => {
                            if (!network) {
                                window.networkDelay(delayMs);
                            }
                            window.inputEvent(id);
                        },
                        {
                            id,
                            delayMs: DELAY_MS,
                            network: !!RATES.policy,
                        },
                    );
                    await PAIR.pages[1].waitForFunction(
                        (id) => window.latencyReport().remoteTraces.some((t) => t.id === id && t.screen !== undefined),
                        id,
                        {
                            timeout: 6000,
                        },
                    );
                }
                await checkpoint(PAIR.pages, 'remote application ' + RATES.simulationHz, false);
                const CLOCK_AFTER = await HOST.evaluate(() => window.synchronizeClock());
                const PEERS = await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.latencyReport())));
                assert.ok(PEERS.every((p) => !p.failure));
                assert.ok(
                    PEERS.every((p) => p.visibility === 'visible' && p.focused),
                    'remote measurement active pages',
                );
                assert.equal(PEERS[0].hash, PEERS[1].hash);
                assert.deepEqual(
                    PEERS[0].commands,
                    Array.from(
                        {
                            length: COMMAND_COUNT,
                        },
                        (_, i) => 'A:' + (i + 1) + ':' + (i + 1),
                    ),
                );
                for (let id = 1; id <= COMMAND_COUNT; id++) {
                    const A = PEERS[0].remoteTraces.find((t) => t.id === id),
                        B = PEERS[1].remoteTraces.find((t) => t.id === id);
                    assert.ok(B.screen !== undefined);
                    assert.ok(
                        B.applications.every((x) => x.tick === A.applications[0].tick),
                        'shared execution tick',
                    );
                    const SUBMITTED = PEERS[0].traces.find((t) => t.id === id);
                    if (SUBMITTED.assignedTick !== undefined) {
                        assert.ok(
                            A.applications.every((x) => x.tick === SUBMITTED.assignedTick),
                            'immutable submitted execution tick',
                        );
                    }
                }
                let invariants;
                if (!RATES.policy && !process.env.INPUT_BASELINE_DIST) {
                    await Promise.all(
                        PAIR.pages.map((p) =>
                            p.evaluate(() => {
                                window.networkDelay(0);
                                window.setTarget(Infinity);
                            }),
                        ),
                    );
                    await HOST.evaluate(() => {
                        window.inputFault('hold');
                        window.inputEvent(9);
                        window.changeInputDelay(6);
                    });
                    await HOST.evaluate(() => window.inputFault('reverse'));
                    await checkpoint(PAIR.pages, 'reserved T after delay growth', false);
                    const BEFORE = await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.latencyReport())));
                    const SUBMITTED = BEFORE[0].traces.find((t) => t.id === 9);
                    assert.ok(
                        BEFORE.every((p) =>
                            p.remoteTraces
                                .find((t) => t.id === 9)
                                .applications.every((a) => a.tick === SUBMITTED.assignedTick),
                        ),
                        'delay growth preserves initial T',
                    );
                    await HOST.evaluate(() => window.inputFault('reverse'));
                    await SLEEP(250);
                    const AFTER = await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.latencyReport())));
                    assert.deepEqual(
                        AFTER.map((p) => p.sessionMetrics.rollbacks),
                        BEFORE.map((p) => p.sessionMetrics.rollbacks),
                        'duplicate packets cannot replay',
                    );
                    assert.deepEqual(
                        AFTER.map((p) => p.hash),
                        BEFORE.map((p) => p.hash),
                    );
                    invariants = {
                        assignedTick: SUBMITTED.assignedTick,
                        delayGrowth: true,
                        duplicateRollbacks: 0,
                    };
                }
                SAMPLES.push({
                    rates: RATES,
                    clockBefore: CLOCK_BEFORE,
                    clockAfter: CLOCK_AFTER,
                    peers: PEERS,
                    invariants,
                });
                await closeRoom(PAIR);
                continue;
            }
            for (let id = 1; id <= 24; id++) {
                await HOST.evaluate((id) => window.inputEvent(id), id);
                await SLEEP(73 + ((id * 17) % 51));
            }
            await checkpoint(PAIR.pages, 'latency final ' + RATES.simulationHz, false);
            const PEERS = await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.latencyReport())));
            assert.ok(PEERS.every((p) => !p.failure));
            assert.equal(PEERS[0].hash, PEERS[1].hash);
            assert.equal(PEERS[0].commands.length, 24);
            assert.equal(new Set(PEERS[0].commands).size, 24);
            assert.ok(
                PEERS[0].traces.every((t) => t.tickBefore === t.tickAfter),
                'event must not advance simulation',
            );
            assert.ok(
                PEERS[0].traces.every((t) => t.savesBefore === t.savesAfter),
                'event must not save authority',
            );
            await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.setTarget(Infinity))));
            await HOST.evaluate(() => {
                window.inputFault('hold');
                for (const ID of [25, 26, 27]) {
                    window.inputEvent(ID);
                }
            });
            const REVISIONS = await HOST.evaluate(() => window.inputFault('reverse'));
            if (!process.env.INPUT_BASELINE_DIST) {
                assert.equal(PEERS[0].sessionMetrics.inputReservations, 24);
                assert.equal(REVISIONS.length, 3);
                assert.equal(new Set(REVISIONS.map((p) => p.tick)).size, 1);
                assert.ok(REVISIONS.every((p) => p.type === 8));
            }
            await checkpoint(PAIR.pages, 'same tick revisions ' + RATES.simulationHz);
            await HOST.evaluate(() => window.inputFault('reverse')); // duplicates arriving after canonical confirmation
            await HOST.evaluate(() => {
                window.inputFault('hold');
                window.inputEvent(28);
            });
            await SLEEP(550);
            await HOST.evaluate(() => window.inputFault('reverse'));
            await checkpoint(PAIR.pages, 'delayed duplicate commands ' + RATES.simulationHz);
            await HOST.evaluate(() => {
                window.inputFault('drafts');
                window.inputEvent(29);
            });
            await SLEEP(4000 / RATES.simulationHz);
            const LATE_REVISIONS = await HOST.evaluate(() => window.inputFault('reverse'));
            await checkpoint(PAIR.pages, 'draft after canonical ' + RATES.simulationHz, false);
            if (!process.env.INPUT_BASELINE_DIST) {
                await HOST.evaluate(() => window.inputFault('protocol1'));
                await PAIR.pages[1].waitForFunction(() =>
                    window.snapshot().events.some((e) => e.type === 'version-mismatch' && e.field === 'protocol'),
                );
            }
            const FAULT_PEERS = await Promise.all(PAIR.pages.map((p) => p.evaluate(() => window.latencyReport())));
            assert.equal(FAULT_PEERS[0].hash, FAULT_PEERS[1].hash);
            assert.deepEqual(
                FAULT_PEERS[0].commands,
                Array.from(
                    {
                        length: 29,
                    },
                    (_, i) => `A:${i + 1}:${i + 1}`,
                ),
            );
            assert.ok(FAULT_PEERS.every((p) => !p.failure));
            SAMPLES.push({
                rates: RATES,
                peers: PEERS,
                revisions: REVISIONS,
                lateRevisions: LATE_REVISIONS,
                faultPeers: FAULT_PEERS,
            });
            await closeRoom(PAIR);
        }
        assert.deepEqual(ERRORS, []);
        const REPORT = {
            passed: true,
            browser: browser.version(),
            backgroundThrottlingDisabled: !!process.env.REMOTE_INPUT_LATENCY,
            label: process.env.INPUT_LATENCY,
            samples: SAMPLES,
        };
        await mkdir(resolve(ROOT, 'test-results/rollback'), {
            recursive: true,
        });
        await writeFile(
            resolve(ROOT, 'test-results/rollback/input-latency-' + process.env.INPUT_LATENCY + '.json'),
            JSON.stringify(REPORT, null, 2),
        );
        console.log(
            JSON.stringify({
                passed: true,
                label: REPORT.label,
                samples: SAMPLES.map((s) => ({
                    rates: s.rates,
                    traces: s.peers[0].traces,
                })),
            }),
        );
    } else {
        const DELAYED = await room(2, false);
        await DELAYED.pages[0].evaluate(() => window.block(['B'], true));
        await DELAYED.pages[0].locator('#move').click();
        await SLEEP(350);
        await DELAYED.pages[0].evaluate(() => window.block(['B'], false, true));
        await checkpoint(DELAYED.pages, 'delayed input and command converge');
        const DELAYED_STATE = await snapshots(DELAYED.pages);
        assert.ok(
            DELAYED_STATE.every((s) => s.state.commands.filter((c) => c === 'A:1:7').length === 1),
            'delayed command exactly once',
        );
        if (SIMULATION_MODE === 'rollback') {
            assert.ok(
                DELAYED_STATE.some((s) => s.metrics.rollbacks > 0),
                'delayed real RTC input exercised rollback',
            );
        }
        RESULTS.push({
            label: 'delayed input',
            simulationMode: SIMULATION_MODE,
            peers: DELAYED_STATE.map((s) => ({
                metrics: s.metrics,
                commands: s.state.commands,
            })),
        });
        await closeRoom(DELAYED);
        const TWO = await room(2, true, false, true),
            [HOST, GUEST] = TWO.pages;
        await Promise.all(TWO.pages.map((p) => p.evaluate(() => window.stopRender())));
        const BEFORE_RENDER_STOP = await snapshots(TWO.pages);
        await SLEEP(700);
        const AFTER_RENDER_STOP = await snapshots(TWO.pages);
        AFTER_RENDER_STOP.forEach((s, i) => {
            assert.ok(s.tick >= BEFORE_RENDER_STOP[i].tick + 6, 'timer/RTC progress with rendering stopped');
            assert.equal(s.renderedFrames, BEFORE_RENDER_STOP[i].renderedFrames);
        });
        RESULTS.push({
            label: 'render stopped; independent timer and RTC continue',
            ticks: AFTER_RENDER_STOP.map((s) => s.tick),
            fault: 'explicit rAF cancellation, not browser visibility',
        });
        await Promise.all(TWO.pages.map((p) => p.evaluate(() => window.resumeRender())));
        const BEFORE_BACKGROUND = (await HOST.evaluate(() => window.snapshot())).tick;
        if (process.env.AVAILABILITY_HEADED === '1') {
            const VISIBILITY = await TWO.context.newCDPSession(GUEST);
            // Playwright normally forces every page focused/visible, including headed.
            await VISIBILITY.send('Emulation.setFocusEmulationEnabled', {
                enabled: false,
            });
            const { windowId: WINDOW_ID } = await VISIBILITY.send('Browser.getWindowForTarget');
            await VISIBILITY.send('Browser.setWindowBounds', {
                windowId: WINDOW_ID,
                bounds: {
                    windowState: 'minimized',
                },
            });
        }
        await HOST.bringToFront();
        await SLEEP(2100);
        const HIDDEN = await GUEST.evaluate(() => document.hidden);
        const AFTER_BACKGROUND = (await HOST.evaluate(() => window.snapshot())).tick;
        assert.ok(AFTER_BACKGROUND > BEFORE_BACKGROUND + 10, 'foreground ticks progress while other tab is background');
        RESULTS.push({
            label: 'background tab',
            visibilityStatus: HIDDEN ? 'PASS' : 'environment-blocked',
            observedHidden: HIDDEN,
            beforeTick: BEFORE_BACKGROUND,
            afterTick: AFTER_BACKGROUND,
            claim: HIDDEN
                ? 'actual document.hidden; Playwright focus emulation disabled'
                : 'visibility not observed; hidden-tab coverage is NOT PASS',
        });
        if (process.env.AVAILABILITY_HEADED === '1') {
            const VISIBILITY = await TWO.context.newCDPSession(GUEST);
            const { windowId: WINDOW_ID } = await VISIBILITY.send('Browser.getWindowForTarget');
            await VISIBILITY.send('Browser.setWindowBounds', {
                windowId: WINDOW_ID,
                bounds: {
                    windowState: 'normal',
                },
            });
            await VISIBILITY.send('Emulation.setFocusEmulationEnabled', {
                enabled: true,
            });
        }
        await GUEST.locator('#move').click();
        await checkpoint(TWO.pages, 'guest command before suspension');
        const BEFORE_GUEST_FREEZE = (await HOST.evaluate(() => window.snapshot())).tick;
        const GUEST_CDP = await TWO.context.newCDPSession(GUEST);
        await GUEST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: true,
        });
        await until(
            [HOST],
            (v) => v[0].tick >= BEFORE_GUEST_FREEZE + 10 && v[0].activePlayers.length === 1,
            'inactive guest',
        );
        await HOST.locator('#move').click();
        await until([HOST], (v) => v[0].state.commands.includes('A:1:7'), 'active input while guest frozen');
        await GUEST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: false,
        });
        await GUEST.evaluate(() => window.resumePump());
        await checkpoint(TWO.pages, 'guest resume state');
        await GUEST.locator('#move').click();
        await checkpoint(TWO.pages, 'guest sequence after suspension');
        assert.ok(
            (await snapshots(TWO.pages)).every(
                (s) =>
                    s.state.commands.includes('B:1:7') &&
                    s.state.commands.includes('B:2:7') &&
                    new Set(s.state.commands).size === s.state.commands.length,
            ),
            'suspended guest command sequence retained',
        );
        const BEFORE_HOST_FREEZE = (await GUEST.evaluate(() => window.snapshot())).tick;
        const HOST_CDP = await TWO.context.newCDPSession(HOST);
        await HOST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: true,
        });
        await until(
            [GUEST],
            (v) => v[0].tick >= BEFORE_HOST_FREEZE + 10 && v[0].coordinatorId === 'B',
            'inactive coordinator',
        );
        await HOST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: false,
        });
        await HOST.evaluate(() => window.resumePump());
        await checkpoint(TWO.pages, 'coordinator resume follows active guest');
        await HOST.locator('#move').click();
        await checkpoint(TWO.pages, 'coordinator sequence after suspension');
        assert.ok(
            (await snapshots(TWO.pages)).every(
                (s) =>
                    s.state.commands.includes('A:1:7') &&
                    s.state.commands.includes('A:2:7') &&
                    new Set(s.state.commands).size === s.state.commands.length,
            ),
            'suspended coordinator command sequence retained',
        );
        const HELD_TICK = Math.max(...(await snapshots(TWO.pages)).map((s) => s.tick)) + 4;
        await Promise.all(TWO.pages.map((p) => p.evaluate((t) => window.setTarget(t), HELD_TICK)));
        await until(
            TWO.pages,
            (v) => v.every((s) => s.tick === HELD_TICK && s.status === 'running'),
            'common boundary before room-wide pause',
        );
        await Promise.all(TWO.pages.map((p) => p.evaluate(() => window.stopPump())));
        await SLEEP(1900);
        console.log(
            JSON.stringify({
                label: 'room-wide pause before resume',
                peers: await Promise.all(TWO.pages.map((p) => p.evaluate(() => window.diagnostics()))),
            }),
        );
        await HOST.evaluate(() => {
            window.setTarget(Infinity);
            window.resumePump();
        });
        await GUEST.evaluate(() => {
            window.setTarget(Infinity);
            window.setPulseInterval(1000);
        });
        await until(
            [HOST],
            (v) => v[0].tick >= HELD_TICK + 10 && v[0].status === 'running' && v[0].activePlayers.length === 1,
            'foreground resume with slow retained voter',
        );
        RESULTS.push({
            label: 'room-wide gap; slow voter confirms checkpoint without input',
            fault: 'fixture timer interval 1000ms, not natural browser throttling',
            diagnostics: await Promise.all(TWO.pages.map((p) => p.evaluate(() => window.diagnostics()))),
        });
        await GUEST.evaluate(() => {
            window.setPulseInterval(50);
            window.resumePump();
        });
        await checkpoint(TWO.pages, 'room-wide resume state');
        const COOPERATIVE = await snapshots(TWO.pages);
        for (const PEER of COOPERATIVE) {
            assert.ok(PEER.membershipInstalls > 0, 'cooperative availability prepared state committed');
            assert.ok(
                PEER.membershipInstalls <= PEER.membershipJobs,
                'only completed recovery jobs install; canceled rounds may leave unused tokens',
            );
            assert.ok(
                PEER.membershipPrepareMs > 0 && PEER.maxBoundaryTaskMs >= PEER.membershipPrepareMs,
                'cooperative availability boundary costs measured: ' +
                    JSON.stringify({
                        prepare: PEER.membershipPrepareMs,
                        max: PEER.maxBoundaryTaskMs,
                        jobs: PEER.membershipJobs,
                        installs: PEER.membershipInstalls,
                    }),
            );
        }
        RESULTS.push({
            label: 'cooperative membership through guest/coordinator/room-wide resume',
            peers: COOPERATIVE.map(
                ({ membershipJobs, membershipInstalls, membershipPrepareMs, maxBoundaryTaskMs }) => ({
                    membershipJobs,
                    membershipInstalls,
                    membershipPrepareMs,
                    maxBoundaryTaskMs,
                }),
            ),
        });
        RESULTS.push({
            label: 'RTC two player',
            ...(await GUEST.evaluate(() => window.rtcStats())),
        });
        await closeRoom(TWO);
        const FOUR = await room(4);
        await Promise.all(
            FOUR.pages.map((p, i) => p.evaluate((ids) => window.block(ids, true), i === 3 ? ['A', 'B', 'C'] : ['D'])),
        );
        const CRASH_AT = Math.max(...(await snapshots(FOUR.pages.slice(0, 3))).map((s) => s.tick));
        await until(
            FOUR.pages.slice(0, 3),
            (v) => v.every((s) => s.tick > CRASH_AT + 8 && s.activePlayers.length === 3),
            'one peer transport interruption',
        );
        await Promise.all(
            FOUR.pages.map((p, i) =>
                p.evaluate((ids) => window.block(ids, false, true), i === 3 ? ['A', 'B', 'C'] : ['D']),
            ),
        );
        await checkpoint(FOUR.pages, 'one peer transport reconnect');
        await Promise.all(
            FOUR.pages.map((p, i) =>
                p.evaluate(({ ids, blocked }) => window.block(ids, blocked), {
                    ids: i < 2 ? ['C', 'D'] : ['A', 'B'],
                    blocked: true,
                }),
            ),
        );
        const SPLIT_AT = Math.max(...(await snapshots(FOUR.pages)).map((s) => s.tick));
        await until(
            FOUR.pages,
            (v) => v.every((s) => s.tick > SPLIT_AT + 10 && s.activePlayers.length === 2),
            '2/2 partition availability',
        );
        await Promise.all(
            FOUR.pages.map((p, i) =>
                p.evaluate((ids) => window.block(ids, false, true), i < 2 ? ['C', 'D'] : ['A', 'B']),
            ),
        );
        await checkpoint(FOUR.pages, 'partition rejoin discards losing branch and stale traffic');
        RESULTS.push({
            label: 'RTC four player',
            ...(await FOUR.pages[0].evaluate(() => window.rtcStats())),
        });
        await closeRoom(FOUR);
        const AUTO = await room(2, true, true);
        await AUTO.pages[1].evaluate(() => window.pausePumpOnProbe());
        await AUTO.pages[0].evaluate(() => window.setCost(3));
        await until([AUTO.pages[1]], (v) => v[0].probePaused, 'transfer probe received');
        await until(
            [AUTO.pages[0]],
            (v) => v[0].events.some((e) => e.type === 'availability-retry'),
            'transfer timeout retry',
        );
        const TIMEOUT_TICK = (await snapshots([AUTO.pages[0]]))[0].tick;
        await until(
            [AUTO.pages[0]],
            (v) => v[0].tick >= TIMEOUT_TICK + 10 && v[0].activePlayers.length === 1,
            'active pump continues after interrupted transfer',
        );
        RESULTS.push({
            label: 'interrupted transfer checkpoint retry',
            diagnostic: await AUTO.pages[0].evaluate(() => window.diagnostics()),
        });
        await AUTO.pages[1].evaluate(() => window.resumePump());
        await until(AUTO.pages, (v) => v.every((s) => s.coordinatorId === 'B'), 'quality coordinator transfer');
        await checkpoint(AUTO.pages, 'automatic transfer checkpoint');
        RESULTS.push({
            label: 'automatic transfer',
            observations: (await snapshots(AUTO.pages)).map((s) => ({
                coordinatorId: s.coordinatorId,
                stepMs: s.stepMs,
            })),
        });
        await closeRoom(AUTO);
        for (const COUNT of [3, 2]) {
            const MISMATCH = await room(COUNT),
                INITIAL = (await snapshots(MISMATCH.pages))[1],
                BOUNDARY = INITIAL.baseTick + 40;
            await Promise.all(MISMATCH.pages.map((p) => p.evaluate((t) => window.setTarget(t), BOUNDARY)));
            await MISMATCH.pages[0].evaluate((t) => window.corruptAt(t - 1), BOUNDARY);
            const EXPECTED_BASIS = COUNT === 3 ? 'roster-majority' : 'responsive-coordinator';
            const RESOLVED = await until(
                MISMATCH.pages,
                (v) =>
                    v.every(
                        (s) =>
                            s.tick === BOUNDARY &&
                            s.status === 'running' &&
                            s.events.some((e) => e.type === 'branch-selected' && e.basis === EXPECTED_BASIS),
                    ) &&
                    new Set(v.map((s) => s.branch)).size === 1 &&
                    new Set(v.map((s) => s.hash)).size === 1,
                'same tick snapshot ' + EXPECTED_BASIS,
            );
            assert.equal(
                RESOLVED[0].state.value,
                INITIAL.state.value + (BOUNDARY - INITIAL.tick) * COUNT + (COUNT === 2 ? 7 : 0),
                'majority overrides coordinator, tie follows coordinator',
            );
            RESULTS.push({
                label: 'same tick snapshot ' + EXPECTED_BASIS,
                tick: BOUNDARY,
                value: RESOLVED[0].state.value,
                hash: RESOLVED[0].hash,
            });
            await closeRoom(MISMATCH);
        }
        const STRICT = await room(2, false);
        const STRICT_GUEST_CDP = await STRICT.context.newCDPSession(STRICT.pages[1]);
        await STRICT_GUEST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: true,
        });
        await SLEEP(1000);
        const HELD = (await snapshots([STRICT.pages[0]]))[0].tick;
        await SLEEP(2100);
        assert.equal((await snapshots([STRICT.pages[0]]))[0].tick, HELD, 'strict holds absent input');
        await STRICT_GUEST_CDP.send('Emulation.setScriptExecutionDisabled', {
            value: false,
        });
        await STRICT.pages[1].evaluate(() => window.resumePump());
        await checkpoint(STRICT.pages, 'strict resume regression');
        await closeRoom(STRICT);
        assert.deepEqual(ERRORS, []);
        const REPORT = {
            passed: true,
            browser: browser.version(),
            transport:
                'actual Chromium RTCPeerConnection data channels across 2/4 pages; in-process RoomTransport fixture, no public relay/NAT',
            faults: 'CDP script-execution suspension; explicit timer gap/1000ms interval; pump stops during transfer probe; partition injected at transport send/receive, retained stale packets replayed; not OS suspend',
            results: RESULTS,
        };
        await mkdir(resolve(ROOT, 'test-results/rollback'), {
            recursive: true,
        });
        await writeFile(
            resolve(ROOT, 'test-results/rollback/availability-' + SIMULATION_MODE + '-report.json'),
            JSON.stringify(REPORT, null, 2),
        );
        console.log(JSON.stringify(REPORT, null, 2));
    }
} finally {
    await browser?.close();
    await new Promise((ok) => SERVER.close(ok));
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RESULTS_DIRECTORY = resolve(ROOT, 'test-results/rollback');
const TIMEOUT = 45_000;
const TARGET_TICK = 240;
async function launchBrowser(chromium) {
    if (process.env.CHROMIUM_EXECUTABLE_PATH) {
        return chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        });
    }
    if (process.env.BROWSER_CHANNEL) {
        return chromium.launch({
            headless: true,
            channel: process.env.BROWSER_CHANNEL,
        });
    }
    const ATTEMPTS = [];
    for (const CHANNEL of [undefined, 'chrome', 'msedge']) {
        try {
            return await chromium.launch({
                headless: true,
                ...(CHANNEL
                    ? {
                          channel: CHANNEL,
                      }
                    : {}),
            });
        } catch (error) {
            ATTEMPTS.push(error.message);
        }
    }
    throw new Error(
        `No Chromium browser is available. Set BROWSER_CHANNEL or install a Playwright browser. ${ATTEMPTS.join('\n')}`,
    );
}
const SERVER = createServer(async (request, response) => {
    try {
        const PATHNAME = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const PATH = resolve(ROOT, `.${PATHNAME === '/' ? '/modules/rollback/tests/browser.html' : PATHNAME}`);
        if (PATH !== ROOT && !PATH.startsWith(`${ROOT}${sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const TYPES = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.mjs': 'text/javascript; charset=utf-8',
            '.json': 'application/json',
        };
        const BYTES = await readFile(PATH);
        response.writeHead(200, {
            'content-type': TYPES[extname(PATH)] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        response.end(BYTES);
    } catch {
        response.writeHead(404).end('Not found');
    }
});
await new Promise((resolveListening, reject) => {
    SERVER.once('error', reject);
    SERVER.listen(0, '127.0.0.1', resolveListening);
});
let browser;
let pages = [];
let report;
const BROWSER_ERRORS = [];
try {
    browser = await launchBrowser(chromium);
    const CONTEXTS = await Promise.all([browser.newContext(), browser.newContext()]);
    pages = await Promise.all(CONTEXTS.map((context) => context.newPage()));
    for (let index = 0; index < pages.length; index++) {
        pages[index].on('pageerror', (error) =>
            BROWSER_ERRORS.push({
                player: index ? 'b' : 'a',
                message: error.message,
            }),
        );
        await pages[index].setViewportSize({
            width: 1100,
            height: 1050,
        });
    }
    const ADDRESS = SERVER.address();
    const URL_LOCAL = `http://127.0.0.1:${ADDRESS.port}/modules/rollback/tests/browser.html`;
    await Promise.all(pages.map((page) => page.goto(URL_LOCAL)));
    assert.deepEqual(BROWSER_ERRORS, [], 'both browser pages must load the ES module without errors');
    await Promise.all(
        pages.map((page) =>
            page.waitForFunction(() => Boolean(window.harness), null, {
                timeout: TIMEOUT,
            }),
        ),
    );
    const CAPABILITIES = await pages[0].evaluate(async () => {
        const { createLoop: CREATE_LOOP } = await import('/dist/simloop.js');
        const { createSession: CREATE_SESSION } = await import('/dist/rollback.js');
        const { runSyncTest: RUN_SYNC_TEST, runSyncTestAsync: RUN_SYNC_TEST_ASYNC } =
            await import('/dist/deterministic.js');
        let tick = 0;
        let clock = 0;
        let allowed = true;
        let polls = 0;
        let renders = 0;
        const SESSION = {
            inputSize: 1,
            profile: {
                tickRate: 20,
                maxCatchupSteps: 5,
            },
            metrics: {
                pace: 1,
            },
            closed: false,
            resimulating: false,
            poll() {
                polls++;
                if (this.resimulating) {
                    this.resimulating = false;
                }
            },
            advance() {
                if (clock !== 250) {
                    throw Error('frame clock');
                }
                return {
                    status: 'advanced',
                    tick: ++tick,
                };
            },
        };
        const LOOP = CREATE_LOOP({
            session: SESSION,
            beforeFrame: (t) => {
                clock = t;
            },
            canAdvance: () => allowed,
            onAdvance: () => {
                allowed = false;
            },
            render: () => renders++,
        });
        LOOP.pulse(0);
        LOOP.pulse(250);
        SESSION.resimulating = true;
        LOOP.pulse(500);
        const LOOP_PASSED = tick === 1 && polls === 3 && renders === 3 && !SESSION.resimulating;
        let value = 0;
        const ADAPTER = {
            save: () => new Uint8Array([value]),
            load: (b) => {
                value = b[0];
            },
            validateSnapshot: (b) => b.length === 1,
            step: (ctx) => {
                value = (value + ctx.inputs[0].input[0]) % 256;
            },
        };
        const RESULT = RUN_SYNC_TEST({
            adapter: ADAPTER,
            players: ['a'],
            inputSize: 1,
            checkDistance: 2,
            frames: Array.from(
                {
                    length: 4,
                },
                (_, tick) => ({
                    tick,
                    inputs: [
                        {
                            playerId: 'a',
                            input: new Uint8Array([1]),
                        },
                    ],
                }),
            ),
        });
        let heartbeats = 0;
        const HEARTBEAT = setInterval(() => heartbeats++, 0);
        let asyncResult;
        try {
            asyncResult = await RUN_SYNC_TEST_ASYNC({
                adapter: ADAPTER,
                players: ['a'],
                inputSize: 1,
                checkDistance: 2,
                frames: Array.from(
                    {
                        length: 4,
                    },
                    (_, tick) => ({
                        tick,
                        inputs: [
                            {
                                playerId: 'a',
                                input: new Uint8Array([1]),
                            },
                        ],
                    }),
                ),
            });
        } finally {
            clearInterval(HEARTBEAT);
        }
        const DIAGNOSTICS_RESTORED = value === 0;
        const CORE = CREATE_SESSION({
            adapter: ADAPTER,
            players: ['a'],
            localPlayerId: 'a',
            sessionId: 'bounded-browser',
            simulationVersion: '1',
            inputSize: 1,
            profile: {
                baseInputDelayTicks: 0,
                minInputDelayTicks: 0,
                maxInputDelayTicks: 0,
                adaptiveInputDelay: false,
                pacingPolicy: 'none',
            },
        });
        for (let i = 0; i < 6; i++) {
            CORE.advance(new Uint8Array([1]));
        }
        const PREFIX = CORE.exportSyncTestFrames({
            maxFrames: 2,
        });
        PREFIX.frames[0].inputs[0].input[0] = 99;
        const BOUNDED_PASSED =
            PREFIX.frames.length === 2 &&
            PREFIX.initialTick === 0 &&
            CORE.exportSyncTestFrames({
                maxFrames: 2,
            }).frames[0].inputs[0].input[0] === 1;
        CORE.close();
        return {
            loopPassed: LOOP_PASSED,
            boundedPassed: BOUNDED_PASSED,
            asyncPassed: heartbeats > 0 && asyncResult.hash === RESULT.hash && DIAGNOSTICS_RESTORED,
            heartbeats,
            metricsPassed:
                Object.isFrozen(RESULT.metrics) &&
                RESULT.metrics.checkedTicks === 4 &&
                RESULT.metrics.resimulatedTicks === 7 &&
                DIAGNOSTICS_RESTORED,
            metrics: RESULT.metrics,
        };
    });
    assert.ok(
        CAPABILITIES.loopPassed && CAPABILITIES.metricsPassed && CAPABILITIES.asyncPassed && CAPABILITIES.boundedPassed,
        `browser capability verification: ${JSON.stringify(CAPABILITIES)}`,
    );
    const MODES = [];
    for (const MODE of ['rollback', 'lockstep']) {
        if (MODE === 'lockstep') {
            await Promise.all(pages.map((page) => page.evaluate(() => window.harness.close())));
            await Promise.all(pages.map((page) => page.reload()));
            await Promise.all(
                pages.map((page) =>
                    page.waitForFunction(() => Boolean(window.harness), null, {
                        timeout: TIMEOUT,
                    }),
                ),
            );
        }
        await Promise.all(
            pages.map((page, index) =>
                page.evaluate(({ id, initiator }) => window.harness.createPeer(id, initiator), {
                    id: index ? 'b' : 'a',
                    initiator: index === 0,
                }),
            ),
        );

        // Node relays SDP and ICE candidates; all game traffic travels through WebRTC.
        const OFFER = await pages[0].evaluate(() => window.harness.offer());
        const ANSWER = await pages[1].evaluate((offer) => window.harness.answer(offer), OFFER);
        await pages[0].evaluate((answer) => window.harness.acceptAnswer(answer), ANSWER);
        const CONNECT_DEADLINE = Date.now() + TIMEOUT;
        let relayedCandidates = 0;
        while (true) {
            const CANDIDATES = await Promise.all(
                pages.map((page) => page.evaluate(() => window.harness.takeCandidates())),
            );
            relayedCandidates += CANDIDATES[0].length + CANDIDATES[1].length;
            await Promise.all(
                pages.map((page, index) =>
                    page.evaluate((values) => window.harness.addCandidates(values), CANDIDATES[1 - index]),
                ),
            );
            if (
                (await Promise.all(pages.map((page) => page.evaluate(() => window.harness.channelsOpen())))).every(
                    Boolean,
                )
            ) {
                break;
            }
            assert.ok(Date.now() < CONNECT_DEADLINE, 'real WebRTC DataChannels did not open');
            await new Promise((resolveWaiting) => setTimeout(resolveWaiting, 25));
        }
        await Promise.all(pages.map((page) => page.evaluate((mode) => window.harness.start(mode), MODE)));
        // The command is queued once before frame commitment, then transported with inputs.
        await pages[0].evaluate(() => window.harness.command([17]));
        const PLAY_DEADLINE = Date.now() + TIMEOUT;
        let snapshots = [];
        for (let round = 0; ; round++) {
            // Uneven small bursts create late remote input while retaining a bounded lead.
            snapshots = await Promise.all(
                pages.map((page, index) =>
                    page.evaluate(({ target, count }) => window.harness.step(target, count), {
                        target: TARGET_TICK,
                        count: index === 0 ? (round % 5 === 0 ? 3 : 1) : round % 5 === 0 ? 1 : 2,
                    }),
                ),
            );
            if (
                snapshots.every(
                    (snapshot) =>
                        snapshot.tick === TARGET_TICK &&
                        snapshot.confirmedTick >= TARGET_TICK - 1 &&
                        !snapshot.resimulating,
                )
            ) {
                break;
            }
            assert.ok(Date.now() < PLAY_DEADLINE, `sessions did not settle: ${JSON.stringify(snapshots)}`);
            if (round % 8 === 0) {
                await new Promise((resolveWaiting) => setTimeout(resolveWaiting, 5));
            }
        }
        // Let the final ACK and checksum messages reach both independent pages.
        for (let round = 0; round < 12; round++) {
            await Promise.all(pages.map((page) => page.evaluate(() => window.harness.poll())));
            await new Promise((resolveWaiting) => setTimeout(resolveWaiting, 5));
        }
        const PEERS = await Promise.all(
            pages.map((page) => page.evaluate((target) => window.harness.report(target), TARGET_TICK)),
        );
        const MODE_REPORT = {
            mode: MODE,
            passed:
                PEERS.every((peer) => peer.passed) && PEERS[0].hash === PEERS[1].hash && BROWSER_ERRORS.length === 0,
            transport: 'two real RTCPeerConnections in separate browser contexts',
            relayedCandidates,
            peers: PEERS,
        };
        MODES.push(MODE_REPORT);
        report = {
            passed: MODES.length === 2 && MODES.every((result) => result.passed),
            browserErrors: BROWSER_ERRORS,
            capabilities: CAPABILITIES,
            modes: MODES,
        };
        await mkdir(RESULTS_DIRECTORY, {
            recursive: true,
        });
        await writeFile(resolve(RESULTS_DIRECTORY, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
        await Promise.all(
            pages.map((page, index) =>
                page.screenshot({
                    path: resolve(RESULTS_DIRECTORY, `browser-${MODE}-peer-${index ? 'b' : 'a'}.png`),
                    fullPage: true,
                }),
            ),
        );
        assert.ok(relayedCandidates > 0, 'ICE candidates were relayed through the Node harness');
        assert.ok(MODE_REPORT.passed, `real ${MODE} WebRTC verification failed: ${JSON.stringify(report)}`);
        console.log(
            JSON.stringify(
                {
                    passed: true,
                    mode: MODE,
                    ticks: TARGET_TICK,
                    hash: PEERS[0].hash,
                    relayedCandidates,
                    metrics: PEERS.map((peer) => ({
                        player: peer.player,
                        ...peer.metrics,
                    })),
                    report: 'test-results/rollback/browser-report.json',
                },
                null,
                2,
            ),
        );
    }
} catch (error) {
    await mkdir(RESULTS_DIRECTORY, {
        recursive: true,
    });
    await writeFile(
        resolve(RESULTS_DIRECTORY, 'browser-failure.json'),
        `${JSON.stringify(
            {
                message: error.message,
                browserErrors: BROWSER_ERRORS,
                report,
            },
            null,
            2,
        )}\n`,
    );
    await Promise.allSettled(
        pages.map((page, index) =>
            page.screenshot({
                path: resolve(RESULTS_DIRECTORY, `browser-failure-${index}.png`),
                fullPage: true,
            }),
        ),
    );
    console.error(error);
    process.exitCode = 1;
} finally {
    await Promise.allSettled(pages.map((page) => page.evaluate(() => window.harness?.close())));
    await browser?.close();
    await new Promise((resolveClosed) => SERVER.close(resolveClosed));
}

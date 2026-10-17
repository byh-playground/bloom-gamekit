/* global audioExample */
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url)),
    STARTED = Date.now(),
    REPORT = {
        startedAt: new Date().toISOString(),
        scenario: 'unlock → live waveform → confirmed journal → dense budget → mute/save → reload/resume → disposal',
        errors: [],
        checks: [],
    };
let server;
let browser;
const ASSERT = (b, m) => {
    if (!b) {
        throw Error(m);
    }
};
async function verifySkipped(page, label) {
    const RESULT = await page.evaluate(async (label) => {
        const { PresentationEventQueue: PRESENTATION_EVENT_QUEUE } = await import('/dist/presentation-events.js'),
            PLAYER = audioExample.player;
        const BEFORE = PLAYER.snapshot().played;
        const JOURNAL = new PRESENTATION_EVENT_QUEUE({
            retentionTicks: 1,
            maxPending: 8,
            adapters: {
                sfx: PLAYER.createAdapter({
                    onEnded: (event) => JOURNAL.finish(event),
                }),
            },
        });
        for (let tick = 0; tick < 5; tick++) {
            JOURNAL.emit({
                tick,
                sequence: 0,
                entityId: 'skip-' + label,
                generation: 0,
                kind: 'sfx',
                payload: {
                    soundId: 'hit',
                },
                policy: 'confirmed',
            });
            JOURNAL.confirmThrough(tick);
            await Promise.resolve();
        }
        JOURNAL.confirmThrough(8);
        JOURNAL.collect();
        const RESULT = {
            label,
            size: JOURNAL.size,
            active: JOURNAL.active.size,
            processed: JOURNAL.stats.started,
            actualPlayed: PLAYER.snapshot().played - BEFORE,
        };
        JOURNAL.dispose();
        return RESULT;
    }, label);
    ASSERT(
        RESULT.size === 0 && RESULT.active === 0 && RESULT.actualPlayed === 0,
        'Skipped confirmed retained: ' + label,
    );
    return RESULT;
}
try {
    server = http.createServer(async (req, res) => {
        try {
            const PATHNAME = new URL(req.url, 'http://localhost').pathname;
            if (PATHNAME === '/favicon.ico') {
                res.writeHead(204).end();
                return;
            }
            const FILE = path.resolve(ROOT, '.' + PATHNAME);
            if (!FILE.startsWith(path.resolve(ROOT) + path.sep)) {
                throw Error('path');
            }
            res.setHeader('Content-Type', FILE.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
            res.end(await fs.readFile(FILE));
        } catch {
            res.writeHead(404).end();
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({
        headless: true,
        ...(process.platform === 'win32'
            ? {
                  channel: 'msedge',
              }
            : {}),
    });
    REPORT.browser = await browser.version();
    const PAGE = await browser.newPage();
    PAGE.on('pageerror', (e) => REPORT.errors.push(String(e)));
    await PAGE.goto('http://127.0.0.1:' + server.address().port + '/modules/audio/examples/index.html');
    await PAGE.waitForFunction(() => window.audioExample);
    ASSERT(
        (await PAGE.evaluate(() => audioExample.player.snapshot())).state === 'locked',
        'Context allocated before gesture',
    );
    REPORT.skippedLocked = await verifySkipped(PAGE, 'locked');
    REPORT.offline = await PAGE.evaluate(async () => {
        const {
            makeNoise: MAKE_NOISE,
            createMix: CREATE_MIX,
            renderSound: RENDER_SOUND,
        } = await import('/dist/audio.js');
        const ROWS = [];
        for (const DENSE of [false, true]) {
            const CONTEXT = new OfflineAudioContext(1, 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination),
                BUFFER = MAKE_NOISE(CONTEXT),
                CLIP = CONTEXT.createBuffer(1, 4800, 48000);
            for (let i = 0; i < 4800; i++) {
                CLIP.getChannelData(0)[i] = Math.sin((i * 2 * Math.PI * 440) / 48000) * 0.2;
            }
            const TONE = {
                    category: 'sfx',
                    layers: [
                        {
                            kind: 'tone',
                            hz: 180,
                            end: 50,
                            ms: 220,
                            gain: 0.22,
                            type: 'sine',
                        },
                        {
                            kind: 'noise',
                            hz: 2200,
                            ms: 90,
                            gain: 0.14,
                        },
                    ],
                },
                SAMPLE = {
                    category: 'sfx',
                    layers: [
                        {
                            kind: 'buffer',
                            bufferId: 'clip',
                            ms: 100,
                            gain: 0.2,
                        },
                    ],
                };
            let ended = 0;
            for (let i = 0; i < (DENSE ? 12 : 1); i++) {
                RENDER_SOUND(CONTEXT, MIX.input, TONE, BUFFER, {
                    at: i * 0.003,
                    scale: 0.8,
                    onEnded: () => ended++,
                });
            }
            RENDER_SOUND(CONTEXT, MIX.input, SAMPLE, BUFFER, {
                at: 0.3,
                buffers: new Map([['clip', CLIP]]),
                onEnded: () => ended++,
            });
            const RENDERED = await CONTEXT.startRendering();
            await new Promise((r) => setTimeout(r, 20));
            const VALUES = RENDERED.getChannelData(0);
            let peak = 0;
            let sum = 0;
            let finite = true;
            for (const V of VALUES) {
                finite &&= Number.isFinite(V);
                peak = Math.max(peak, Math.abs(V));
                sum += V * V;
            }
            ROWS.push({
                dense: DENSE,
                peak,
                rms: Math.sqrt(sum / VALUES.length),
                finite,
                ended,
                expectedEnded: DENSE ? 13 : 2,
            });
        }
        return ROWS;
    });
    for (const R of REPORT.offline) {
        ASSERT(
            R.finite && R.peak > 0 && R.peak < 0.9 && R.rms > 0 && R.ended === R.expectedEnded,
            'Offline output/end cleanup',
        );
    }
    REPORT.checks.push('Offline real tone/noise/registered AudioBuffer, finite samples and dense peak');
    await PAGE.locator('#tap').click();
    await PAGE.waitForTimeout(30);
    REPORT.live = await PAGE.evaluate(async () => {
        let peak = 0;
        let rms = 0;
        for (let i = 0; i < 120; i++) {
            const M = audioExample.player.meter();
            peak = Math.max(peak, M.peak);
            rms = Math.max(rms, M.rms);
            await new Promise((r) => setTimeout(r, 5));
        }
        return {
            peak,
            rms,
            currentTime: audioExample.player.context.currentTime,
            baseLatency: audioExample.player.context.baseLatency,
            outputLatency: audioExample.player.context.outputLatency,
            state: audioExample.player.snapshot(),
        };
    });
    ASSERT(REPORT.live.state.state === 'running' && REPORT.live.peak > 1e-5, 'Live graph stayed silent');
    await PAGE.waitForTimeout(300);
    ASSERT((await PAGE.evaluate(() => audioExample.player.snapshot())).voices === 0, 'Natural ended leaked voice');
    REPORT.checks.push('Actual gesture unlock and nonzero live analyser; natural ended cleanup');
    const BEFORE = await PAGE.evaluate(() => audioExample.player.snapshot().played);
    await PAGE.locator('#confirmed').click();
    await PAGE.waitForTimeout(400);
    REPORT.journal = await PAGE.evaluate(() => ({
        audio: audioExample.player.snapshot(),
        stats: audioExample.journal.stats,
        active: audioExample.journal.active.size,
    }));
    ASSERT(
        REPORT.journal.audio.played === BEFORE + 1 &&
            REPORT.journal.stats.duplicates === 1 &&
            REPORT.journal.active === 0,
        'Confirmed SFX replayed/retained',
    );
    REPORT.checks.push('Existing confirmed journal adapter: duplicate one-shot not replayed; natural finish');
    await PAGE.locator('#dense').click();
    REPORT.dense = await PAGE.evaluate(() => audioExample.player.snapshot());
    REPORT.skippedBudget = await verifySkipped(PAGE, 'budget');
    ASSERT(
        REPORT.dense.voices <= 4 &&
            REPORT.dense.maxObserved <= 4 &&
            REPORT.dense.dropped > 0 &&
            REPORT.dense.bySound.warning >= 1,
        'Budget/priority failed',
    );
    await PAGE.waitForTimeout(450);
    ASSERT((await PAGE.evaluate(() => audioExample.player.snapshot())).voices === 0, 'Dense voices retained');
    REPORT.checks.push('Category/global voice budget, drops and higher-priority admission');
    await PAGE.locator('#mute').click();
    await PAGE.locator('#tap').click();
    await PAGE.waitForTimeout(100);
    REPORT.muted = await PAGE.evaluate(() => ({
        state: audioExample.player.snapshot(),
        meter: audioExample.player.meter(),
    }));
    REPORT.skippedMuted = await verifySkipped(PAGE, 'muted');
    ASSERT(REPORT.muted.state.muted && REPORT.muted.meter.peak < 1e-7, 'Mute output not silent');
    await PAGE.locator('#volume').focus();
    await PAGE.keyboard.press('Home');
    for (let i = 0; i < 33; i++) {
        await PAGE.keyboard.press('ArrowRight');
    }
    await PAGE.reload();
    await PAGE.waitForFunction(() => window.audioExample);
    REPORT.restored = await PAGE.evaluate(() => audioExample.player.snapshot());
    ASSERT(
        REPORT.restored.muted && Math.abs(REPORT.restored.volume - 0.33) < 1e-9 && REPORT.restored.state === 'locked',
        'Volume/mute not restored or context created on reload',
    );
    REPORT.checks.push('Mute is measured silent; master controls persist; reload stays locked');
    await PAGE.locator('#mute').click();
    await PAGE.locator('#tap').click();
    await PAGE.waitForTimeout(50);
    await PAGE.evaluate(() => audioExample.player.context.suspend());
    await PAGE.waitForTimeout(30);
    REPORT.suspended = await PAGE.evaluate(() => audioExample.player.snapshot());
    ASSERT(REPORT.suspended.state === 'suspended' && REPORT.suspended.voices === 0, 'Suspension retained voices');
    await PAGE.locator('#tap').click();
    await PAGE.waitForFunction(
        () => audioExample.player.snapshot().state === 'running' && audioExample.player.snapshot().played >= 2,
        null,
        {
            timeout: 5000,
        },
    );
    REPORT.resumed = await PAGE.evaluate(async () => {
        let peak = 0;
        let rms = 0;
        for (let i = 0; i < 120; i++) {
            const M = audioExample.player.meter();
            peak = Math.max(peak, M.peak);
            rms = Math.max(rms, M.rms);
            await new Promise((r) => setTimeout(r, 5));
        }
        return {
            state: audioExample.player.snapshot(),
            meter: {
                peak,
                rms,
            },
        };
    });
    ASSERT(REPORT.resumed.state.state === 'running' && REPORT.resumed.meter.peak > 1e-5, 'Gesture resume silent');
    REPORT.checks.push(
        'Actual AudioContext suspend clears voices; next gesture resumes same context without stale playback',
    );
    await PAGE.locator('#confirmed').click();
    await PAGE.evaluate(async () => {
        audioExample.journal.dispose();
        await audioExample.player.dispose();
        await audioExample.player.dispose();
    });
    REPORT.disposed = await PAGE.evaluate(() => audioExample.player.snapshot());
    ASSERT(REPORT.disposed.state === 'disposed' && REPORT.disposed.voices === 0, 'Dispose failed');
    ASSERT(!REPORT.errors.length, 'JS exceptions');
    REPORT.result = 'PASS';
    REPORT.limits = [
        'Waveform/analyser results verify generated graph output, not speakers or subjective punch.',
        'Suspend was an actual AudioContext API lifecycle exercise; iOS/Android hardware interruption and document-background behavior were not repeated.',
        'No CPU benchmark or long listening test.',
    ];
} catch (error) {
    REPORT.result = 'FAIL';
    REPORT.failure = String(error.stack || error);
} finally {
    if (browser) {
        await browser.close();
    }
    if (server) {
        await new Promise((r) => server.close(r));
    }
    REPORT.elapsedMs = Date.now() - STARTED;
    const OUTPUT = process.env.AUDIO_REPORT_PATH || path.join(os.tmpdir(), 'gamekit-audio-' + STARTED + '.json');
    await fs.writeFile(OUTPUT, JSON.stringify(REPORT, null, 2) + '\n');
    console.log(
        JSON.stringify({
            ...REPORT,
            reportPath: OUTPUT,
        }),
    );
    process.exitCode = REPORT.result === 'PASS' ? 0 : 1;
}

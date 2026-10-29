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
        scenario:
            'unlock → live waveform → pan/detune → ambience bed → confirmed journal → dense budget → mute/save → reload/resume → disposal',
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
    REPORT.offlineVariation = await PAGE.evaluate(async () => {
        const {
            makeNoise: MAKE_NOISE,
            createMix: CREATE_MIX,
            renderSound: RENDER_SOUND,
            renderBed: RENDER_BED,
        } = await import('/dist/audio.js');
        const RMS = (data, from, to, rate = 48000) => {
            let sum = 0;
            for (let i = Math.floor(from * rate); i < Math.floor(to * rate); i++) {
                sum += data[i] * data[i];
            }
            return Math.sqrt(sum / Math.max(1, Math.floor((to - from) * rate)));
        };
        const CROSSINGS = (data, from, to, rate = 48000) => {
            let n = 0;
            for (let i = Math.floor(from * rate) + 1; i < Math.floor(to * rate); i++) {
                n += data[i - 1] < 0 !== data[i] < 0 ? 1 : 0;
            }
            return n;
        };
        const TONE = {
            category: 'sfx',
            layers: [{ kind: 'tone', hz: 500, end: 500, ms: 300, gain: 0.3, type: 'sine' }],
        };
        const PAN = {};
        for (const PAN_VALUE of [-1, 0, 1]) {
            const CONTEXT = new OfflineAudioContext(2, 24000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            let ended = false;
            RENDER_SOUND(CONTEXT, MIX.input, TONE, MAKE_NOISE(CONTEXT), {
                pan: PAN_VALUE,
                onEnded: () => (ended = true),
            });
            const OUT = await CONTEXT.startRendering();
            await new Promise((r) => setTimeout(r, 20));
            PAN[PAN_VALUE] = {
                left: RMS(OUT.getChannelData(0), 0.05, 0.25),
                right: RMS(OUT.getChannelData(1), 0.05, 0.25),
                ended,
            };
        }
        const CENTS = {};
        for (const DETUNE of [0, 1200, -1200]) {
            const CONTEXT = new OfflineAudioContext(1, 24000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            RENDER_SOUND(CONTEXT, MIX.input, TONE, MAKE_NOISE(CONTEXT), { detune: DETUNE });
            const OUT = await CONTEXT.startRendering();
            CENTS[DETUNE] = CROSSINGS(OUT.getChannelData(0), 0.05, 0.25);
        }
        const BED_RECIPE = {
            category: 'ambience',
            layers: [{ kind: 'noise', hz: 900, gain: 0.3, lfos: [{ hz: 2, depth: 0.5 }] }],
        };
        const BED = {};
        {
            const CONTEXT = new OfflineAudioContext(1, 96000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            let ended = false;
            const HANDLE = RENDER_BED(CONTEXT, MIX.input, BED_RECIPE, MAKE_NOISE(CONTEXT, 2000), {
                fadeMs: 1,
                onEnded: () => (ended = true),
            });
            CONTEXT.suspend(0.5).then(() => {
                HANDLE.setLevel(0.25, 0);
                CONTEXT.resume();
            });
            CONTEXT.suspend(1).then(() => {
                HANDLE.stop(50);
                HANDLE.stop(50);
                HANDLE.setLevel(1, 0);
                CONTEXT.resume();
            });
            const OUT = await CONTEXT.startRendering(),
                DATA = OUT.getChannelData(0);
            await new Promise((r) => setTimeout(r, 20));
            BED.full = RMS(DATA, 0.1, 0.5);
            BED.quarter = RMS(DATA, 0.6, 1);
            BED.afterStop = RMS(DATA, 1.2, 2);
            BED.ended = ended;
        }
        for (const SWELL of [false, true]) {
            const CONTEXT = new OfflineAudioContext(1, 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination),
                HANDLE = RENDER_BED(
                    CONTEXT,
                    MIX.input,
                    { category: 'ambience', layers: [{ kind: 'noise', hz: 900, gain: 0.2 }] },
                    MAKE_NOISE(CONTEXT, 2000),
                    { fadeMs: 1 },
                );
            if (SWELL) {
                HANDLE.swell(1, 10, 2000);
            }
            const OUT = await CONTEXT.startRendering();
            BED[SWELL ? 'swelled' : 'plain'] = RMS(OUT.getChannelData(0), 0.1, 0.5);
        }
        const TEXTURE = {};
        const NOISE_BED = (layers) => ({ category: 'ambience', layers });
        // 중심이 4배 높은 밴드패스는 교차 횟수도 대략 4배다(절대값은 필터 응답에 따라 달라 비율로 확인한다).
        for (const CENTER of [500, 2000]) {
            const CONTEXT = new OfflineAudioContext(1, 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            RENDER_BED(
                CONTEXT,
                MIX.input,
                NOISE_BED([{ kind: 'noise', type: 'bandpass', hz: CENTER, q: 8, gain: 0.5 }]),
                MAKE_NOISE(CONTEXT, 2000),
                { fadeMs: 1 },
            );
            const OUT = await CONTEXT.startRendering();
            TEXTURE['bandpassCrossings' + CENTER] = CROSSINGS(OUT.getChannelData(0), 0.2, 0.8) / 0.6;
        }
        for (const OFFSET of [0, 700]) {
            const CONTEXT = new OfflineAudioContext(2, 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            RENDER_BED(
                CONTEXT,
                MIX.input,
                NOISE_BED([
                    { kind: 'noise', hz: 1500, gain: 0.4, pan: -1 },
                    { kind: 'noise', hz: 1500, gain: 0.4, pan: 1, offsetMs: OFFSET },
                ]),
                MAKE_NOISE(CONTEXT, 2000),
                { fadeMs: 1 },
            );
            const OUT = await CONTEXT.startRendering(),
                LEFT = OUT.getChannelData(0),
                RIGHT = OUT.getChannelData(1);
            let sl = 0,
                sr = 0,
                sx = 0;
            for (let i = 9600; i < 38400; i++) {
                sl += LEFT[i] * LEFT[i];
                sr += RIGHT[i] * RIGHT[i];
                sx += LEFT[i] * RIGHT[i];
            }
            TEXTURE['correlation' + OFFSET] = sx / Math.sqrt(sl * sr);
        }
        for (const DEPTH of [0, 0.9]) {
            const CONTEXT = new OfflineAudioContext(1, 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
            RENDER_BED(
                CONTEXT,
                MIX.input,
                NOISE_BED([{ kind: 'noise', hz: 1500, gain: 0.4, lfos: DEPTH ? [{ hz: 5, depth: DEPTH }] : [] }]),
                MAKE_NOISE(CONTEXT, 2000),
                { fadeMs: 1 },
            );
            const DATA = (await CONTEXT.startRendering()).getChannelData(0);
            let lo = Infinity,
                hi = 0;
            for (let t = 0.2; t < 0.95; t += 0.04) {
                const R = RMS(DATA, t, t + 0.04);
                lo = Math.min(lo, R);
                hi = Math.max(hi, R);
            }
            TEXTURE['swingDb' + DEPTH] = 20 * Math.log10(hi / lo);
        }
        try {
            const CONTEXT = new OfflineAudioContext(1, 4800, 48000);
            RENDER_BED(
                CONTEXT,
                CREATE_MIX(CONTEXT, CONTEXT.destination).input,
                NOISE_BED([{ kind: 'noise', hz: 500, gain: 0.1, lfoHz: 1, lfoDepth: 0.2 }]),
                MAKE_NOISE(CONTEXT),
            );
        } catch (error) {
            TEXTURE.legacyLfoRejected = error instanceof TypeError;
        }
        const BUFFERED = {};
        {
            const SINE = (context, hz, seconds) => {
                const BUFFER = context.createBuffer(1, Math.round(48000 * seconds), 48000),
                    DATA = BUFFER.getChannelData(0);
                for (let i = 0; i < DATA.length; i++) {
                    DATA[i] = Math.sin((2 * Math.PI * hz * i) / 48000) * 0.5;
                }
                return BUFFER;
            };
            const RUN = async (layer, hz, seconds = 1) => {
                const CONTEXT = new OfflineAudioContext(1, 3 * 48000, 48000),
                    MIX = CREATE_MIX(CONTEXT, CONTEXT.destination);
                RENDER_BED(
                    CONTEXT,
                    MIX.input,
                    NOISE_BED([{ kind: 'buffer', bufferId: 'clip', gain: 0.5, ...layer }]),
                    MAKE_NOISE(CONTEXT),
                    {
                        buffers: new Map([['clip', SINE(CONTEXT, hz, seconds)]]),
                        fadeMs: 1,
                    },
                );
                return (await CONTEXT.startRendering()).getChannelData(0);
            };
            const PLAIN = await RUN({}, 440);
            // 1초 버퍼가 3초 동안 이어서 반복된다(루프 이음매 이후에도 같은 크기).
            BUFFERED.firstSecond = RMS(PLAIN, 0.2, 0.9);
            BUFFERED.thirdSecond = RMS(PLAIN, 2.1, 2.8);
            const LOW = await RUN({ type: 'highpass', hz: 2000, q: 0.7 }, 200),
                HIGH = await RUN({ type: 'highpass', hz: 2000, q: 0.7 }, 4000),
                LOW_PLAIN = await RUN({}, 200),
                HIGH_PLAIN = await RUN({}, 4000);
            BUFFERED.lowKept = RMS(LOW, 0.2, 0.9) / RMS(LOW_PLAIN, 0.2, 0.9);
            BUFFERED.highKept = RMS(HIGH, 0.2, 0.9) / RMS(HIGH_PLAIN, 0.2, 0.9);
            try {
                const CONTEXT = new OfflineAudioContext(1, 4800, 48000);
                RENDER_BED(
                    CONTEXT,
                    CREATE_MIX(CONTEXT, CONTEXT.destination).input,
                    NOISE_BED([{ kind: 'buffer', bufferId: 'missing', gain: 0.5 }]),
                    MAKE_NOISE(CONTEXT),
                );
            } catch (error) {
                BUFFERED.missingRejected = error.message.includes('not registered');
            }
        }
        // 레이어 컴프레서: 28dB 크기 차이가 나는 두 구간(0.02 -> 0.5 진폭)의 차이를 줄인다.
        const LEVELED = {};
        for (const WITH of [false, true]) {
            const CONTEXT = new OfflineAudioContext(1, 2 * 48000, 48000),
                MIX = CREATE_MIX(CONTEXT, CONTEXT.destination),
                STEP = CONTEXT.createBuffer(1, 2 * 48000, 48000),
                DATA = STEP.getChannelData(0);
            for (let i = 0; i < DATA.length; i++) {
                DATA[i] = Math.sin((2 * Math.PI * 300 * i) / 48000) * (i < 48000 ? 0.02 : 0.5);
            }
            RENDER_BED(
                CONTEXT,
                MIX.input,
                NOISE_BED([
                    {
                        kind: 'buffer',
                        bufferId: 'step',
                        gain: 0.5,
                        ...(WITH ? { compressor: { threshold: -35, ratio: 8, attackMs: 5, releaseMs: 100 } } : {}),
                    },
                ]),
                MAKE_NOISE(CONTEXT),
                { buffers: new Map([['step', STEP]]), fadeMs: 1 },
            );
            const OUT = (await CONTEXT.startRendering()).getChannelData(0);
            LEVELED[WITH ? 'withDb' : 'withoutDb'] = 20 * Math.log10(RMS(OUT, 1.3, 1.9) / RMS(OUT, 0.3, 0.9));
        }
        for (const BAD of [
            { threshold: 5, ratio: 4 },
            { threshold: -30, ratio: 0 },
            { threshold: -30, ratio: 4, attackMs: -1 },
            'x',
        ]) {
            try {
                const CONTEXT = new OfflineAudioContext(1, 4800, 48000);
                RENDER_BED(
                    CONTEXT,
                    CREATE_MIX(CONTEXT, CONTEXT.destination).input,
                    NOISE_BED([{ kind: 'noise', hz: 500, gain: 0.1, compressor: BAD }]),
                    MAKE_NOISE(CONTEXT),
                );
                LEVELED.badAccepted = true;
            } catch (error) {
                LEVELED.badRejected = (LEVELED.badRejected ?? 0) + (error instanceof RangeError ? 1 : 0);
            }
        }
        return { pan: PAN, crossings: CENTS, bed: BED, texture: TEXTURE, buffered: BUFFERED, leveled: LEVELED };
    });
    {
        const V = REPORT.offlineVariation;
        ASSERT(
            V.pan[-1].left > V.pan[-1].right * 20 &&
                V.pan[1].right > V.pan[1].left * 20 &&
                Math.abs(V.pan[0].left - V.pan[0].right) < V.pan[0].left * 0.05 &&
                V.pan[-1].ended &&
                V.pan[1].ended,
            'Pan did not move energy to the requested side or leaked the panner',
        );
        const UP = V.crossings[1200] / V.crossings[0],
            DOWN = V.crossings[-1200] / V.crossings[0];
        ASSERT(UP > 1.8 && UP < 2.2 && DOWN > 0.45 && DOWN < 0.55, 'Detune did not shift pitch by the requested cents');
        const T = V.texture;
        ASSERT(
            T.bandpassCrossings2000 / T.bandpassCrossings500 > 2.5 &&
                T.bandpassCrossings2000 / T.bandpassCrossings500 < 5 &&
                Math.abs(T.correlation0) > 0.99 &&
                Math.abs(T.correlation700) < 0.15 &&
                T.swingDb0 < 4 &&
                T['swingDb0.9'] > 10 &&
                T.legacyLfoRejected,
            'Bed bandpass/offset decorrelation/lfos or legacy lfo rejection failed',
        );
        const LV = V.leveled;
        ASSERT(
            LV.withoutDb > 24 && LV.withDb < LV.withoutDb - 8 && LV.badRejected === 4 && !LV.badAccepted,
            'Layer compressor did not even out the level or accepted a bad setting',
        );
        const U = V.buffered;
        ASSERT(
            U.firstSecond > 1e-4 &&
                U.thirdSecond / U.firstSecond > 0.9 &&
                U.thirdSecond / U.firstSecond < 1.1 &&
                U.lowKept < 0.05 &&
                U.highKept > 0.7 &&
                U.missingRejected,
            'Buffer bed loop/filter/missing-buffer guard failed',
        );
        const B = V.bed;
        ASSERT(
            B.full > 1e-4 &&
                B.quarter / B.full > 0.15 &&
                B.quarter / B.full < 0.4 &&
                B.afterStop < B.full * 0.01 &&
                B.ended &&
                B.swelled > B.plain * 1.5,
            'Bed level/stop/swell or cleanup failed',
        );
    }
    REPORT.checks.push(
        'Offline pan moves energy to one channel; detune shifts pitch by octave; bed setLevel/stop/swell and node cleanup',
    );
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
    REPORT.liveBed = await PAGE.evaluate(async () => {
        const P = audioExample.player;
        let rejected = false;
        try {
            P.start('hit', 1, () => {});
        } catch (error) {
            rejected = error instanceof TypeError;
        }
        await new Promise((r) => setTimeout(r, 450));
        const BEFORE = P.meter().rms,
            HANDLE = P.startBed('crowd', { level: 1, fadeMs: 100 }),
            SAME = P.startBed('crowd') === HANDLE;
        await new Promise((r) => setTimeout(r, 400));
        let rms = 0;
        for (let i = 0; i < 60; i++) {
            rms = Math.max(rms, P.meter().rms);
            await new Promise((r) => setTimeout(r, 5));
        }
        P.stopAll();
        const KEPT = P.snapshot().beds.length;
        P.setCategoryVolume('ambience', 0);
        await new Promise((r) => setTimeout(r, 200));
        const SILENT = P.meter().rms;
        P.setCategoryVolume('ambience', 0.8);
        HANDLE.stop(50);
        await new Promise((r) => setTimeout(r, 300));
        return {
            rejected,
            started: !!HANDLE,
            same: SAME,
            before: BEFORE,
            rms,
            keptAfterStopAll: KEPT,
            silentWhenCategoryZero: SILENT,
            afterStop: P.snapshot().beds.length,
            panPlayed: !!P.start('hit', 1, { pan: -0.5, detune: 40 }),
            voices: P.snapshot().voices,
        };
    });
    ASSERT(
        REPORT.liveBed.rejected &&
            REPORT.liveBed.started &&
            REPORT.liveBed.same &&
            REPORT.liveBed.rms > REPORT.liveBed.before + 1e-4 &&
            REPORT.liveBed.keptAfterStopAll === 1 &&
            REPORT.liveBed.silentWhenCategoryZero < 1e-5 &&
            REPORT.liveBed.afterStop === 0 &&
            REPORT.liveBed.panPlayed,
        'Live bed start/idempotence/stopAll survival/category volume/stop or start option guard failed',
    );
    await PAGE.waitForTimeout(450);
    REPORT.checks.push(
        'Live bed: nonzero loop, same handle on repeat, survives stopAll, category volume silences, stop removes; function third argument rejected; pan/detune play',
    );
    REPORT.liveLoop = await PAGE.evaluate(async () => {
        const P = audioExample.player,
            BUFFER = P.context.createBuffer(1, P.context.sampleRate, P.context.sampleRate),
            DATA = BUFFER.getChannelData(0);
        for (let i = 0; i < DATA.length; i++) {
            DATA[i] = Math.sin((2 * Math.PI * 330 * i) / P.context.sampleRate) * 0.5;
        }
        P.setBuffer('demo-loop', BUFFER);
        const HANDLE = P.startBed('loop', { level: 1, fadeMs: 50 });
        await new Promise((r) => setTimeout(r, 400));
        let rms = 0;
        for (let i = 0; i < 40; i++) {
            rms = Math.max(rms, P.meter().rms);
            await new Promise((r) => setTimeout(r, 5));
        }
        const RUNNING = P.snapshot().beds.includes('loop');
        HANDLE.stop(50);
        await new Promise((r) => setTimeout(r, 250));
        return { started: !!HANDLE, running: RUNNING, rms, afterStop: P.snapshot().beds.length };
    });
    ASSERT(
        REPORT.liveLoop.started &&
            REPORT.liveLoop.running &&
            REPORT.liveLoop.rms > 1e-4 &&
            REPORT.liveLoop.afterStop === 0,
        'Live buffer bed (registered AudioBuffer loop) failed',
    );
    REPORT.checks.push('Live buffer bed: registered AudioBuffer loops audibly and stop removes it');
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
    REPORT.bedAtDispose = await PAGE.evaluate(() => !!audioExample.player.startBed('crowd'));
    await PAGE.evaluate(async () => {
        audioExample.journal.dispose();
        await audioExample.player.dispose();
        await audioExample.player.dispose();
    });
    REPORT.disposed = await PAGE.evaluate(() => audioExample.player.snapshot());
    ASSERT(
        REPORT.disposed.state === 'disposed' &&
            REPORT.disposed.voices === 0 &&
            REPORT.bedAtDispose &&
            REPORT.disposed.beds.length === 0,
        'Dispose failed or left a bed',
    );
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

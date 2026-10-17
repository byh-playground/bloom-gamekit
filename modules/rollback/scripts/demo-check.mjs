/* global bodyFrames: writable, reference */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoPath, resultsDirectory, launchBrowser, serveRepository } from './browser-helpers.mjs';
const SERVER = await serveRepository();
let browser;
let page;
const REPORT = {
        checks: [],
    },
    STARTED = performance.now();
try {
    browser = await launchBrowser();
    page = await browser.newPage({
        viewport: {
            width: 1000,
            height: 1100,
        },
    });
    const ERRORS = [];
    // Observe the actual Canvas body in both views, rather than an authority endpoint.
    await page.addInitScript(() => {
        window.bodyFrames = [];
        window.recordBodies = false;
        const FILL = CanvasRenderingContext2D.prototype.fillRect;
        CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
            if (
                window.recordBodies &&
                this.canvas.id === 'simulation' &&
                x === -13 &&
                w === 26 &&
                this.fillStyle === '#c8ef95'
            ) {
                const M = this.getTransform();
                bodyFrames.push({
                    view: M.f < 318 ? 'local' : 'remote',
                    x: M.e,
                });
            }
            return FILL.call(this, x, y, w, h);
        };
    });
    page.on('pageerror', (e) => ERRORS.push(e.message));
    await page.goto(process.env.REFERENCE_URL ?? `http://127.0.0.1:${SERVER.address().port}${demoPath}`);
    const READ = () => page.evaluate(() => reference.diagnostics);
    const HEALTHY = async () => {
        const D = await READ();
        assert.deepEqual(D.errors, []);
        assert.deepEqual(ERRORS, []);
        return D;
    };
    const START = async (tps) => {
        await page.selectOption('#tps', String(tps));
        await page.click('#start');
        await page.waitForFunction(
            () => reference.diagnostics.peers.length === 2 && reference.diagnostics.peers.every((p) => p.tick > 5),
            null,
            {
                timeout: 20000,
            },
        );
        assert.equal(await page.locator('#tps').isDisabled(), true);
        const D = await HEALTHY();
        assert.equal(D.tps, tps);
        assert.equal(D.connections.filter((x) => x === 'connected').length, 2);
    };
    const COMPARE = async () => {
        await page.click('#compare');
        await page.waitForFunction(() => document.querySelector('#comparison').dataset.result === 'matched', null, {
            timeout: 15000,
        });
        const D = await page.evaluate(() => reference.lastComparison);
        assert.equal(D.peers[0].hash, D.peers[1].hash);
        await HEALTHY();
        return D;
    };
    const TELEPORT_FLOW = async (tps) => {
        const MOVEMENT_BEFORE = await READ(),
            MOVEMENT_VIEWS = {};
        await page.evaluate(() => {
            bodyFrames = [];
            window.recordBodies = true;
        });
        await page.keyboard.down('ArrowRight');
        await page.waitForTimeout(350);
        await page.keyboard.up('ArrowRight');
        await page.waitForTimeout(450);
        const MOVEMENT = await page.evaluate(() => {
            window.recordBodies = false;
            return bodyFrames;
        });
        for (const VIEW of ['local', 'remote']) {
            const XS = MOVEMENT.filter((f) => f.view === VIEW).map((f) => f.x);
            assert(
                XS.some((x, i) => i && Math.abs(x - XS[i - 1]) > 0.01 && Math.abs(x - XS[i - 1]) < 110 / tps - 0.01),
                `${tps} ${VIEW}: ordinary movement remains interpolated`,
            );
            assert(
                XS.every((x, i) => !i || x >= XS[i - 1] - 1e-4),
                `${tps} ${VIEW}: held movement and release never rewind`,
            );
            MOVEMENT_VIEWS[VIEW] = {
                frames: XS.length,
                rewinds: 0,
                interpolated: true,
            };
        }
        const BEFORE = await READ(),
            FROM = BEFORE.peers[0].actors.a.x,
            TO = FROM < 360 ? 590 : 130;
        assert.equal(
            BEFORE.peers[0].rollback,
            MOVEMENT_BEFORE.peers[0].rollback,
            'local movement is not a simulation rollback',
        );
        await page.click('#delay');
        await page.evaluate(() => {
            bodyFrames = [];
            window.recordBodies = true;
        });
        await page.click('[data-player="a"][data-command="3"]');
        await page.waitForTimeout(1100);
        const FRAMES = await page.evaluate(() => {
            window.recordBodies = false;
            return bodyFrames;
        });
        const RESULTS = {
            tps,
            from: FROM,
            to: TO,
            movement: MOVEMENT_VIEWS,
            localMovementRollbacks: BEFORE.peers[0].rollback - MOVEMENT_BEFORE.peers[0].rollback,
            views: {},
        };
        for (const VIEW of ['local', 'remote']) {
            const XS = FRAMES.filter((f) => f.view === VIEW).map((f) => f.x);
            // Canvas transforms use float precision; tolerate subpixel representation only.
            const MIDDLE = XS.filter((x) => Math.abs(x - FROM) > 1e-4 && Math.abs(x - TO) > 1e-4);
            const ARRIVAL = XS.findIndex((x) => Math.abs(x - TO) < 1e-4);
            assert(ARRIVAL >= 0, `${VIEW}: destination displayed`);
            assert.deepEqual(MIDDLE, [], `${tps} ${VIEW}: no intermediate teleport body, including reconcile/release`);
            assert(
                XS.slice(ARRIVAL).every((x) => Math.abs(x - TO) < 1e-4),
                `${VIEW}: old display history never returns after arrival`,
            );
            RESULTS.views[VIEW] = {
                frames: XS.length,
                intermediate: MIDDLE.length,
            };
        }
        await page.click('#delay');
        const AFTER = await COMPARE();
        if (tps === 30) {
            assert(
                AFTER.peers[1].rollback > BEFORE.peers[1].rollback,
                'late teleport exercises remote rollback/history reset',
            );
        }
        RESULTS.rollbacks = AFTER.peers.map((p, i) => p.rollback - BEFORE.peers[i].rollback);
        (REPORT.teleports ??= []).push(RESULTS);
    };
    await START(10);
    REPORT.checks.push('10 TPS: two RoomSessions, actual native WebRTC, TPS locked');
    const BEFORE = await READ();
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(350);
    await page.keyboard.up('KeyA');
    await page.click('[data-player="a"][data-command="1"]');
    await page.waitForTimeout(90);
    await page.click('[data-player="b"][data-command="2"]');
    await page.waitForTimeout(450);
    await mkdir(resultsDirectory, {
        recursive: true,
    });
    await page.screenshot({
        path: resolve(resultsDirectory, 'reference-active.png'),
        fullPage: true,
    });
    await page.waitForTimeout(950);
    let d = await COMPARE();
    for (const P of d.peers) {
        assert.equal(P.counts.a.dash, 1);
        assert.equal(P.counts.b.fire, 1);
        assert.equal(P.counts.b.dash, 0);
        assert.equal(P.counts.a.fire, 0);
        assert(P.actors.a.x > BEFORE.peers[0].actors.a.x);
        assert(P.actors.b.x < BEFORE.peers[0].actors.b.x);
        assert(P.stats.projectileFrames > 0);
        assert(P.stats.previewFrames > 0);
        assert(P.stats.optionalFrames > 0);
        assert.equal(P.stats.duplicateSounds, 0);
        assert.equal(P.stats.duplicateParticles, 0);
    }
    REPORT.checks.push(
        'held movement, owned one-shot dash/fire, preview lifetime, optional state, seeded XYZ projectile',
    );
    await page.click('#delay');
    const ROLLBACK = d.peers.reduce((n, p) => n + p.rollback, 0);
    await page.keyboard.down('ArrowLeft');
    await page.click('[data-player="a"][data-command="2"]');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.click('[data-player="a"][data-command="4"]');
    await page.waitForTimeout(1300);
    await page.click('#delay');
    await page.waitForTimeout(400);
    d = await COMPARE();
    assert(d.peers.reduce((n, p) => n + p.rollback, 0) > ROLLBACK);
    for (const P of d.peers) {
        assert.equal(P.counts.a.fire, 1);
        assert.equal(P.counts.a.spark, 1);
        assert.equal(P.stats.duplicateSounds, 0);
        assert.equal(P.stats.duplicateParticles, 0);
        assert.equal(P.stats.soundStarts, 4);
        assert.equal(new Set(P.commands.map((c) => c.owner + ':' + c.sequence)).size, P.commands.length);
        for (const C of P.commands) {
            const SUBMIT = P.submissions
                .flatMap((s) => s.commands)
                .find((s) => s.sequence === C.sequence && C.owner === P.id);
            if (SUBMIT) {
                assert.equal(C.tick, SUBMIT.executeTick);
            }
        }
    }
    REPORT.checks.push(
        'late RTC input rolls back/replays; immutable command T; confirmed sound and speculative particles do not duplicate',
    );
    await TELEPORT_FLOW(10);
    await page.click('[data-player="b"][data-command="2"]');
    await page.waitForTimeout(1400);
    REPORT.first = await COMPARE();
    assert(
        REPORT.first.peers.every(
            (p) =>
                p.stats.pathCorners > 0 &&
                p.stats.retainedFrames > 0 &&
                p.stats.releases > 0 &&
                p.actors.a.action === null &&
                p.actors.b.action === null,
        ),
    );
    assert(REPORT.first.peers.every((p) => p.actors.b.shotGeneration === 2 && p.actors.a.teleportSerial === 1));
    REPORT.checks.push('teleport, expired shot ID reused with new generation, same-frame path/target assertions');
    await page.click('#stop');
    assert.equal((await READ()).peers.length, 0);
    await START(30);
    await TELEPORT_FLOW(30);
    await page.click('[data-player="a"][data-command="1"]');
    await page.click('[data-player="b"][data-command="2"]');
    await page.waitForTimeout(1200);
    REPORT.restarted = await COMPARE();
    assert(
        REPORT.restarted.peers.every(
            (p) => p.counts.a.dash === 1 && p.counts.b.fire === 1 && p.stats.duplicateSounds === 0,
        ),
    );
    REPORT.checks.push('whole-room stop, 30 TPS restart, fresh ownership/events/hash agreement');
    await mkdir(resultsDirectory, {
        recursive: true,
    });
    await page.screenshot({
        path: resolve(resultsDirectory, 'reference-example.png'),
        fullPage: true,
    });
    await page.click('#stop');
    await page.waitForTimeout(80);
    d = await HEALTHY();
    assert.equal(d.peers.length, 0);
    assert.equal(d.connections.length, 0);
    REPORT.checks.push('loop, preview, journal, timers and native connections disposed');
    REPORT.status = 'PASS';
    REPORT.browser = browser.version();
} catch (error) {
    REPORT.status = 'FAIL';
    REPORT.error = error.stack;
    REPORT.diagnostics = await page
        ?.evaluate(() => ({
            state: window.reference?.diagnostics,
            error: document.querySelector('#error-log')?.textContent,
        }))
        .catch(() => null);
    throw error;
} finally {
    REPORT.elapsedMs = Math.round(performance.now() - STARTED);
    await mkdir(resultsDirectory, {
        recursive: true,
    });
    await writeFile(resolve(resultsDirectory, 'reference-example-report.json'), JSON.stringify(REPORT, null, 2));
    console.log(JSON.stringify(REPORT));
    await browser?.close();
    await new Promise((r) => SERVER.close(r));
}

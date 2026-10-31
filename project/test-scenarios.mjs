import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITES = {
    'pixel-physics': [
        'project/previews.mjs',
        'modules/pixel-physics/tests/rollback.mjs',
        'modules/pixel-physics/tests/open-world.mjs',
        'modules/pixel-physics/tests/browser.e2e.mjs',
        'modules/pixel-physics/tests/rendering.e2e.mjs',
    ],
    previews: ['project/tests/previews.mjs'],
    core: [
        'modules/vector-assets/tests/compiler.mjs',
        'modules/rendering/tests/paint-regions.mjs',
        'modules/deterministic/tests/hash-bytes.mjs',
        'modules/deterministic/tests/value-codec-typed.mjs',
        'project/previews.mjs',
        'modules/rollback/scripts/local-fastpath-browser.mjs',
        'project/tests/browser.e2e.mjs',
        'modules/pwa/tests/pwa.e2e.mjs',
        'modules/vector-assets/tests/run-gpu-poses.browser.mjs',
        'modules/vector-assets/tests/run-paint-regions.browser.mjs',
        'modules/rendering/tests/run-texture-atlas.browser.mjs',
        'modules/rendering/tests/run-vector-gradient-clip.browser.mjs',
        'modules/rendering/tests/run-sprite-animation.browser.mjs',
        'modules/vector-assets/tests/run-raster-comparison.browser.mjs',
    ],
    consumer: ['modules/scenario/tests/bounko.mjs'],
    execution: ['modules/scenario/tests/browser.mjs'],
    audio: ['modules/audio/scripts/check.mjs'],
    network: ['modules/rollback/scripts/rollback-browser.mjs', 'modules/transport/scripts/dynamic-room-browser.mjs'],
    room: ['modules/rollback/scripts/room-modes-browser.mjs', 'modules/rollback/scripts/availability-browser.mjs'],
    availability: ['modules/rollback/scripts/availability-browser.mjs'],
    demo: ['modules/rollback/scripts/demo-check.mjs'],
    live: ['modules/rollback/scripts/live-room-check.mjs'],
};
const SUITE = process.argv[2] ?? 'core';
const SCENARIOS =
    SUITE === 'all'
        ? [
              ...SUITES.core,
              ...SUITES.execution,
              ...SUITES.audio,
              ...SUITES['pixel-physics'].filter((file) => !SUITES.core.includes(file)),
              ...SUITES.network,
              ...SUITES.availability,
              ...SUITES.demo,
          ]
        : SUITES[SUITE];
if (!SCENARIOS) {
    throw new Error('Unknown scenario suite: ' + SUITE);
}
const BUDGET_MS = 180000,
    STARTED = performance.now();
const ACTIVE = new Set();
function stopChild(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });
    } else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            child.kill('SIGKILL');
        }
    }
}
const STOP_ACTIVE = () => {
    for (const CHILD of ACTIVE) {
        stopChild(CHILD);
    }
};
for (const SIGNAL of ['SIGINT', 'SIGTERM']) {
    process.once(SIGNAL, () => {
        STOP_ACTIVE();
        process.exit(130);
    });
}
async function run(file) {
    const REMAINING = BUDGET_MS - (performance.now() - STARTED);
    if (REMAINING <= 0) {
        throw new Error('Scenario verification exceeded 180 seconds; unfinished coverage is NOT PASS');
    }
    console.log('Scenario:', file);
    await new Promise((resolve, reject) => {
        const CHILD = spawn(process.execPath, [file], {
            cwd: ROOT,
            env: {
                ...process.env,
                ...(SUITE === 'room'
                    ? {
                          ROOM_SIMULATION_MODE: 'rollback',
                      }
                    : {}),
            },
            stdio: 'inherit',
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        ACTIVE.add(CHILD);
        let timedOut = false;
        const TIMER = setTimeout(() => {
            timedOut = true;
            stopChild(CHILD);
        }, REMAINING);
        CHILD.once('error', (error) => {
            clearTimeout(TIMER);
            ACTIVE.delete(CHILD);
            reject(error);
        });
        CHILD.once('exit', (code) => {
            clearTimeout(TIMER);
            ACTIVE.delete(CHILD);
            if (timedOut) {
                reject(new Error('Scenario verification exceeded 180 seconds: ' + file));
            } else if (code !== 0) {
                reject(new Error('Scenario failed: ' + file + ' (exit ' + code + ')'));
            } else {
                resolve();
            }
        });
    });
}
try {
    await run('project/build.mjs');
    if (SUITE === 'all') {
        // Independent servers/browser profiles/report files; bounded concurrency,
        // with one shared whole-run deadline and fail-fast child cleanup.
        let cursor = 0;
        let failure;
        const WORKER = async () => {
            while (!failure && cursor < SCENARIOS.length) {
                try {
                    await run(SCENARIOS[cursor++]);
                } catch (error) {
                    failure ??= error;
                    STOP_ACTIVE();
                }
            }
        };
        await Promise.all([WORKER(), WORKER()]);
        if (failure) {
            throw failure;
        }
    } else {
        for (const FILE of SCENARIOS) {
            await run(FILE);
        }
    }
    console.log(
        JSON.stringify({
            status: 'PASS',
            suite: SUITE,
            elapsedMs: Math.round(performance.now() - STARTED),
            budgetMs: BUDGET_MS,
            scenarios: SCENARIOS,
        }),
    );
} catch (error) {
    STOP_ACTIVE();
    console.error(error.message);
    process.exitCode = 1;
}

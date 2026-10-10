import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = {
  core: ['tests/browser.e2e.mjs'],
  network: ['modules/rollback-netcode/scripts/rollback-browser.mjs', 'modules/rollback-netcode/scripts/dynamic-room-browser.mjs'],
  availability: ['modules/rollback-netcode/scripts/availability-browser.mjs'],
  demo: ['modules/rollback-netcode/scripts/demo-check.mjs'],
  live: ['modules/rollback-netcode/scripts/live-room-check.mjs'],
};
const suite = process.argv[2] ?? 'core';
const scenarios = suite === 'all' ? [...suites.core, ...suites.network, ...suites.availability, ...suites.demo] : suites[suite];
if (!scenarios) throw new Error('Unknown scenario suite: ' + suite);
const budgetMs = 180000, started = performance.now();
const active = new Set();
function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
const stopActive = () => { for (const child of active) stopChild(child); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopActive(); process.exit(130); });
async function run(file) {
  const remaining = budgetMs - (performance.now() - started);
  if (remaining <= 0) throw new Error('Scenario verification exceeded 180 seconds; unfinished coverage is NOT PASS');
  console.log('Scenario:', file);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    active.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopChild(child); }, remaining);
    child.once('error', error => { clearTimeout(timer); active.delete(child); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer); active.delete(child);
      if (timedOut) reject(new Error('Scenario verification exceeded 180 seconds: ' + file));
      else if (code !== 0) reject(new Error('Scenario failed: ' + file + ' (exit ' + code + ')'));
      else resolve();
    });
  });
}
try {
  await run('scripts/build.mjs');
  if (suite === 'all') {
    // Independent servers/browser profiles/report files; bounded concurrency,
    // with one shared whole-run deadline and fail-fast child cleanup.
    let cursor = 0, failure;
    const worker = async () => {
      while (!failure && cursor < scenarios.length) {
        try { await run(scenarios[cursor++]); }
        catch (error) { failure ??= error; stopActive(); }
      }
    };
    await Promise.all([worker(), worker()]);
    if (failure) throw failure;
  } else for (const file of scenarios) await run(file);
  console.log(JSON.stringify({ status: 'PASS', suite, elapsedMs: Math.round(performance.now() - started), budgetMs, scenarios }));
} catch (error) {
  stopActive(); console.error(error.message); process.exitCode = 1;
}

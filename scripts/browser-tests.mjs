import { spawnSync } from 'node:child_process';
// Independent browser paths both run so a rendering failure cannot hide RTC evidence.
let failed = false;
for (const file of ['tests/browser.e2e.mjs', 'scripts/rollback-browser.mjs']) {
  console.log(`Browser suite: ${file}`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env });
  if (result.error) console.error(result.error);
  if (result.error || result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;

#!/usr/bin/env node
// Run from the project's execution directory. No server, install or mutation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

let browser;
const checks = [];
let reported = false;
const emit = () => { if (!reported) { reported = true; process.stdout.write(JSON.stringify(report) + '\n'); } };
const deadline = setTimeout(() => {
  report.status = "unverifiable"; report.error = "browser probe exceeded 30 seconds";
  emit();
  void browser?.close().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000);
}, 30000);
const report = { schema: 'genehub.game-playability.v1', status: 'unverifiable', checks };
try {
  const contract = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const entry = resolve(contract.entry);
  report.artifact = { entry, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') };
  if (contract.sha256 !== report.artifact.sha256) throw new Error('Artifact digest differs from the accepted behavior contract');
  const { chromium } = createRequire(resolve('package.json'))('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(pathToFileURL(entry).href, { timeout: 10000 });
  const snapshot = async () => page.evaluate(() => {
    if (typeof window.gameTestSnapshot !== 'function') throw new Error('read-only gameTestSnapshot contract unavailable');
    return window.gameTestSnapshot();
  });
  await snapshot();
  const check = async (name, action, predicate) => {
    const before = await snapshot();
    await action();
    // Wait for observable animation frames, not a guessed multi-second sleep.
    await page.evaluate(() => new Promise(resolve => {
      let frames = 12;
      const frame = () => --frames ? requestAnimationFrame(frame) : resolve();
      requestAnimationFrame(frame);
    }));
    const after = await snapshot();
    const passed = predicate(before, after);
    checks.push({ name, passed, before, after });
    if (!passed) throw new Error(`${name} failed`);
  };
  const field = (value, key) => key.split('.').reduce((current, part) => current?.[part], value);
  report.status = 'failed';
  await check('start', () => page.locator(contract.startSelector).click(), (_, after) => field(after, contract.stateField ?? 'state') === 'playing');
  await check('move', () => page.keyboard.down(contract.moveKey ?? 'ArrowRight'), (before, after) => {
    const first = field(before, contract.positionField ?? 'player.x');
    const second = field(after, contract.positionField ?? 'player.x');
    return typeof first === 'number' && typeof second === 'number' && first !== second;
  });
  await page.keyboard.up(contract.moveKey ?? 'ArrowRight');
  await check('fire', () => page.keyboard.press(contract.fireKey ?? 'Space'), (before, after) => {
    const first = field(before, contract.shotsField ?? 'shotsFired');
    const second = field(after, contract.shotsField ?? 'shotsFired');
    return typeof first === 'number' && typeof second === 'number' && second > first;
  });
  report.status = 'passed';
  report.coverage = 'start, movement and firing only; level/Boss/item progression needs separate behavioral evidence';
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  clearTimeout(deadline);
  emit();
}

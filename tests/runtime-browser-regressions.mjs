import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const directory = await mkdtemp(join(tmpdir(), '4running-runtime-browser-'));
const base = 'http://localhost:4184';
const app = await startServer({ port: 4184, directory, testMail: true, migrate: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
const errors = [];
let accountNumber = 0;
const password = 'Runtime-browser-test-12345';

async function fixture({ speed = '7', ability = '1min', assessment = 'later', workers = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: workers ? 'allow' : 'block' });
  await context.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], cancel() {},
      speak(utterance) { window.__spoken.push(utterance.text); queueMicrotask(() => utterance.onend?.()); }
    } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#authGate').waitFor({ state: 'visible' });
  await page.locator('#authEmail').fill(`runtime-${++accountNumber}@example.com`);
  await page.locator('#authPassword').fill(password);
  const registration = () => Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/auth/sign-up/email')),
    page.locator('button[value=register]').click()
  ]).then(([response]) => response);
  let registered = await registration();
  if (registered.status() === 429) {
    const retrySeconds = Math.max(1, Math.min(60, Number(registered.headers()['retry-after']) || 10));
    await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
    registered = await registration();
  }
  if (!registered.ok()) assert.fail(`register failed (${registered.status()}): ${await registered.text().catch(() => 'response navigated away')}`);
  if (workers) {
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.waitForLoadState('networkidle');
  }
  await page.locator('#legalDialog').waitFor({ state: 'visible' });
  await page.locator('#legalPrivacyCheck').check();
  await page.locator('#legalMedicalCheck').check();
  await page.locator('#legalAcceptBtn').click();
  await page.locator('#onboardingDialog').waitFor({ state: 'visible' });
  await page.locator('#onboardNext').click();
  await page.locator('#onboardActivity').selectOption('walk');
  await page.locator('#onboardWalk').selectOption('30');
  await page.locator(`input[name=onboardAbility][value="${ability}"]`).check();
  await page.locator('#onboardNext').click();
  if (speed) await page.locator('#onboardRunSpeed').fill(speed);
  await page.locator('#onboardNext').click();
  await page.locator('#onboardAssessment').selectOption(assessment);
  await page.locator('#onboardFinish').click();
  await page.locator('#onboardingDialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => PaceCloud.flush());
  const origin = new Date('2026-11-12T12:00:00Z');
  await page.clock.install({ time: origin });
  await page.clock.pauseAt(new Date(origin.getTime() + 1000));
  return { page, context };
}

async function start(page, environment = 'treadmill', { voice = false } = {}) {
  await page.locator('#startWorkoutHome').click();
  await page.locator(`[data-env=${environment}]`).click();
  if (!voice && await page.locator('#prepVoiceState').innerText() !== 'Apagada') await page.locator('#prepVoice').click();
  await page.locator('#beginWorkout').click();
  await page.locator('#activeStage').waitFor({ state: 'visible' });
}

async function active(page) {
  return page.evaluate(() => {
    const key = `4running.activeWorkout.${PaceCloud.userId()}`;
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (!saved) return null;
    const runtime = WorkoutRuntime.restore(saved.runtime, { catchUp: false });
    return { saved, state: runtime.state(saved.savedAt), summary: runtime.summary(saved.savedAt) };
  });
}

async function move(page, direction, { confirm = true } = {}) {
  const previous = await active(page);
  if (await page.locator('#morePanel').isHidden()) await page.locator('#moreToggle').click();
  await page.locator(direction > 0 ? '#nextBlockButton' : '#prevBlock').click();
  await page.locator('#confirmDialog').waitFor({ state: 'visible' });
  if (confirm) {
    await page.locator('#confirmOk').click();
    await page.waitForFunction(expected => {
      const saved = JSON.parse(localStorage.getItem(`4running.activeWorkout.${PaceCloud.userId()}`) || 'null');
      return saved?.runtime.index === expected && saved.runtime.running === true;
    }, previous.state.index + direction);
  }
}

async function save(page, { done = 'yes', rpe = '4' } = {}) {
  await page.locator('#sessionDialog').waitFor({ state: 'visible' });
  await page.locator(`input[name=prescriptionDone][value=${done}]`).check();
  await page.locator(`input[name=sessionRpe][value="${rpe}"]`).check();
  await page.locator('input[name=sessionPain][value=no]').check();
  await page.locator('#closeNext').click();
  await page.locator('#sessionTalk').selectOption('yes');
  await page.locator('#saveSession').click();
  await page.locator('#adaptDialog').waitFor({ state: 'visible' });
  const record = await page.evaluate(() => PaceCoach.loadLogs().at(-1));
  await page.locator('#adaptDone').click();
  await page.evaluate(() => PaceCloud.flush());
  return record;
}

async function scenario(name, run, options) {
  let context;
  try {
    const fixtureResult = await fixture(options); context = fixtureResult.context;
    await run(fixtureResult.page, context);
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.stack || error}`);
  } finally { await context?.close(); }
}

try {
  await scenario('paused reload, resume and complete preserve attempt ID and actual ledger', async page => {
    await start(page);
    await page.clock.fastForward(320000);
    await page.locator('#mainTimerButton').click();
    const before = await active(page);
    assert.equal(before.summary.runSeconds, 20);
    await page.clock.fastForward(90000);
    await page.reload();
    await page.locator('#workoutRecoveryDialog').waitFor({ state: 'visible' });
    const recovered = await active(page);
    assert.equal(recovered.saved.attemptId, before.saved.attemptId);
    assert.equal(recovered.summary.runSeconds, 20);
    assert.equal(recovered.state.elapsedMs, 320000);
    assert.equal(recovered.state.running, false);
    await page.locator('#resumeRecovered').click();
    const duration = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem(`4running.activeWorkout.${PaceCloud.userId()}`));
      return saved.runtime.blocks.reduce((sum, block) => sum + (block.prescribedSeconds + block.extraSeconds) * 1000, 0);
    });
    await page.clock.fastForward(duration - 320000);
    await page.clock.runFor(500);
    const log = await save(page);
    assert.equal(log.id, before.saved.attemptId);
    assert.equal(log.execution, 'completed');
    assert.equal(log.runSeconds, 360);
    assert.equal(log.walkSeconds, 1320);
    assert.equal(log.maxRunBlockSec, 60);
    assert.ok(log.ledger.some(visit => visit.prescribedType === 'run' && visit.segments.length === 2), 'paused run has distinct segments');
    assert.deepEqual(log.prescriptionSnapshot, before.saved.prescription.structure);
    assert.equal(await active(page), null);
  });

  await scenario('running reload can close recovered work without creating another attempt', async page => {
    await start(page); await page.clock.fastForward(330000);
    // A pagehide forces persistence and preserves the actual running timestamp.
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const before = await active(page);
    await page.reload();
    await page.locator('#workoutRecoveryDialog').waitFor({ state: 'visible' });
    await page.locator('#saveRecovered').click();
    const log = await save(page, { done: 'no' });
    assert.equal(log.id, before.saved.attemptId);
    assert.equal(log.execution, 'aborted'); assert.equal(log.progression, 'repeat');
    assert.equal(log.runSeconds, 30);
    assert.equal(log.walkSeconds, 300);
    assert.equal(log.ledger.length, 2);
  });

  await scenario('previous/next keep repeated block visits: 40 plus 30 seconds, longest 40', async page => {
    await start(page); await page.clock.fastForward(340000);
    await move(page, 1); await move(page, -1);
    await page.clock.fastForward(30000); await page.locator('#stopNow').click();
    const log = await save(page, { done: 'no' });
    console.log('repeated-block measurement', JSON.stringify({ runSeconds: log.runSeconds, maxRunBlockSec: log.maxRunBlockSec, visits: log.ledger.length }));
    assert.equal(log.runSeconds, 70); assert.equal(log.maxRunBlockSec, 40);
    assert.equal(log.blocks[1].actualSeconds, 70);
    assert.equal(log.blocks[1].longestRunSeconds, 40);
    assert.equal(log.ledger.filter(visit => visit.blockIndex === 1).length, 2);
    assert.equal(log.execution, 'aborted'); assert.equal(log.progression, 'repeat');
  });

  await scenario('next-block confirmation pauses the old block and never skips two phases', async page => {
    await start(page); await page.clock.fastForward(358000);
    await move(page, 1, { confirm: false });
    const before = await active(page);
    assert.equal(before.state.index, 1); assert.equal(before.state.running, false);
    assert.equal(before.state.remainingMs, 2000);
    await page.clock.fastForward(15000);
    const waiting = await active(page);
    assert.equal(waiting.state.index, 1); assert.equal(waiting.state.remainingMs, 2000);
    assert.equal(await page.locator('#timerPhase').innerText(), 'CORRER');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem(`4running.activeWorkout.${PaceCloud.userId()}`) || 'null');
      return saved?.runtime.index === 2 && saved.runtime.running === true;
    });
    const after = await active(page);
    assert.equal(after.state.index, 2); assert.equal(after.state.type, 'walk');
    assert.equal(after.state.elapsedMs, before.state.elapsedMs);
  });

  await scenario('real service worker installs and controller change does not reload active workout', async page => {
    assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
    await start(page); await page.clock.fastForward(310000);
    await page.evaluate(() => { window.__runtimeSentinel = 'preserved'; navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); });
    await page.clock.runFor(500);
    assert.equal(await page.evaluate(() => window.__runtimeSentinel), 'preserved');
    const saved = await active(page);
    assert.ok(saved.saved.attemptId); assert.ok(saved.state.elapsedMs >= 310000);
    assert.equal(await page.locator('#activeStage').isVisible(), true);
    const cached = await page.evaluate(async () => {
      const names = await caches.keys(); const urls = [];
      for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
      return urls;
    });
    assert.ok(cached.some(url => url.endsWith('/workout-runtime.js')));
    assert.ok(cached.every(url => !new URL(url).pathname.startsWith('/api/')));
  }, { workers: true });

  await scenario('treadmill without speed basis avoids numeric cues; background voice reports remaining time', async page => {
    await start(page, 'treadmill', { voice: true });
    assert.equal(await page.locator('#timerSpeed').isVisible(), false);
    assert.doesNotMatch(await page.locator('#nextBlock').innerText(), /km\/h/);
    assert.ok((await page.evaluate(() => window.__spoken)).every(text => !/kilómetros por hora|km\/h/.test(text)));
    await page.evaluate(() => window.__spoken = []);
    await page.clock.fastForward(350000);
    await page.clock.runFor(100);
    assert.equal(await page.locator('#timerPhase').innerText(), 'CORRER');
    const speech = await page.evaluate(() => window.__spoken.filter(text => /^Correr/.test(text)));
    assert.ok(speech.some(text => /10 segundos/.test(text)), `expected remaining-time cue, got ${JSON.stringify(speech)}`);
    assert.ok(speech.every(text => !/1 minuto|60 segundos|kilómetros por hora/.test(text)));
    assert.doesNotMatch(await page.locator('#nextBlock').innerText(), /km\/h/);
  }, { speed: '' });

  assert.deepEqual(errors, [], 'no uncaught browser errors in regression cases');
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}

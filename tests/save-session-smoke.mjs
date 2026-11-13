/**
 * Smoke: cierre de sesión (manual + desde timer) debe persistir en localStorage.
 * node tests/save-session-smoke.mjs
 */
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
const port = 8771;
const directory = await mkdtemp(join(tmpdir(), '4running-smoke-'));
const app = await startServer({port, directory, testMail: true, migrate: true});
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { Origin: `http://127.0.0.1:${port}` } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const results = [];

async function toastText() {
  return page.locator('#toast').innerText().catch(() => '');
}

async function fillCloseAndSave({ time = '38:00' } = {}) {
  await page.locator('input[name="prescriptionDone"][value="yes"]').check();
  await page.locator('input[name="sessionRpe"][value="5"]').check();
  await page.locator('input[name="sessionPain"][value="no"]').check();
  await page.locator('#closeNext').click();
  await page.locator('#sessionTime').fill(time);
  await page.locator('#sessionDistance').fill('3.5');
  // Ensure Guardar is visible (sticky footer bug check)
  const save = page.locator('#saveSession');
  await save.waitFor({ state: 'visible' });
  const box = await save.boundingBox();
  const inViewport = Boolean(box && box.y >= 0 && box.y + box.height <= 844);
  results.push({ step: 'save-visible', box, inViewport });
  if (!inViewport) throw new Error(`Guardar fuera de viewport: y=${box?.y}`);
  await save.click();
  await page.waitForTimeout(800);
}

async function acceptLegalIfNeeded() {
  const legal = page.locator('#legalDialog');
  const visible = await legal.evaluate(el => el.open).catch(() => false);
  if (!visible) return;
  await page.locator('#legalPrivacyCheck').check();
  await page.locator('#legalMedicalCheck').check();
  await page.locator('#legalAcceptBtn').click();
  await page.waitForTimeout(300);
}

async function completeOnboarding() {
  await page.request.post(`http://127.0.0.1:${port}/api/auth/sign-out`, {data: {}});
  const registered = await page.request.post(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {data: {email: `smoke-${Date.now()}@example.com`, password: 'Smoke-running-12345', name: 'Smoke'}});
  if (!registered.ok()) throw new Error(await registered.text());
  await page.reload();
  await page.locator('#legalDialog').waitFor({state: 'visible'});
  await acceptLegalIfNeeded();
  const dialog = page.locator('#onboardingDialog');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  // Step 1 goal already defaulted
  await page.locator('#onboardNext').click();
  await page.waitForTimeout(150);
  // Step 2 ability
  await page.locator('input[name="onboardAbility"][value="1min"]').check();
  await page.locator('#onboardNext').click();
  await page.waitForTimeout(150);
  // Step 3 days/env
  await page.locator('#onboardNext').click();
  await page.waitForTimeout(150);
  // Step 4 pain no + finish
  await page.locator('input[name="onboardPain"][value="no"]').check();
  await page.locator('#onboardFinish').click();
  await page.waitForTimeout(500);
  await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await completeOnboarding();

  // Case A: Registrar sesión hecha (manual del plan)
  const logBtn = page.locator('#logPlanSession');
  await logBtn.waitFor({ state: 'visible', timeout: 5000 });
  await logBtn.click();
  await page.locator('#sessionDialog').waitFor({ state: 'visible' });
  await fillCloseAndSave({ time: '36:10' });

  const logsA = await page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const logKey = keys.find(k => /log/i.test(k)) || keys.find(k => k.includes('pace'));
    return {
      keys,
      raw: logKey ? localStorage.getItem(logKey) : null
    };
  });
  results.push({ case: 'A-manual', toast: await toastText(), logsA, dialogOpen: await page.locator('#sessionDialog').evaluate(d => d.open) });

  // Case B: nested confirm while dialog open (time mismatch path)
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await completeOnboarding();

  await page.locator('#startWorkoutHome').click();
  await page.locator('[data-env="treadmill"]').click();
  await page.locator('#beginWorkout').click();
  await page.locator('#activeStage').waitFor({state: 'visible'});
  await page.waitForTimeout(400);

  // Use finishAndSave from more panel
  const more = page.locator('#moreToggle, #toggleMore, button[aria-label="Más opciones"]').first();
  if (await more.isVisible().catch(() => false)) await more.click();
  const finish = page.locator('#finishAndSave');
  if (await finish.isVisible().catch(() => false)) {
    await finish.click();
    await page.locator('#sessionDialog').waitFor({ state: 'visible' });
    // Force time mismatch vs measured to trigger askConfirm
    await page.locator('input[name="prescriptionDone"][value="yes"]').check();
    await page.locator('input[name="sessionRpe"][value="4"]').check();
    await page.locator('input[name="sessionPain"][value="no"]').check();
    await page.locator('#closeNext').click();
    await page.locator('#sessionTime').fill('99:00');
    await page.locator('#saveSession').click();
    await page.waitForTimeout(600);
    const confirmOpen = await page.locator('#confirmDialog').evaluate(d => d.open).catch(() => false);
    const toast = await toastText();
    const pageErr = errors.slice();
    results.push({ case: 'B-nested-confirm', confirmOpen, toast, pageErr });
    if (confirmOpen) {
      await page.locator('#confirmOk').click();
      await page.waitForTimeout(800);
      results.push({ case: 'B-after-confirm', toast: await toastText(), dialogOpen: await page.locator('#sessionDialog').evaluate(d => d.open) });
    }
  } else {
    throw new Error('finishAndSave not visible: timer branch must execute');
  }

  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (e) {
  console.error('SMOKE_FAIL', e);
  console.log(JSON.stringify({ results, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await rm(directory,{recursive:true,force:true});
}

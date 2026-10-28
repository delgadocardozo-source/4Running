/**
 * Smoke: cierre de sesión (manual + desde timer) debe persistir en localStorage.
 * node tests/save-session-smoke.mjs
 */
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const port = 8771;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

const server = createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = join(root, url.replace(/^\//, ''));
  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHash?.(404);
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'text/plain' });
  res.end(readFileSync(file));
});

await new Promise(r => server.listen(port, r));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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

async function completeOnboarding() {
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

  // Start workout briefly to get fromTimer path
  const startHome = page.locator('#startWorkoutHome');
  if (await startHome.isVisible()) {
    await startHome.click();
    await page.waitForTimeout(300);
    // environment chooser?
    const envTread = page.locator('#envTreadmill, [data-env="treadmill"], button:has-text("Cinta")').first();
    if (await envTread.isVisible().catch(() => false)) {
      await envTread.click();
      await page.waitForTimeout(200);
    }
    const begin = page.locator('#beginWorkout, #startTimer, button:has-text("Empezar"), button:has-text("Comenzar")').first();
    if (await begin.isVisible().catch(() => false)) await begin.click();
    await page.waitForTimeout(400);
  }

  // Use finishAndSave from more panel
  const more = page.locator('#moreToggle, #toggleMore, button:has-text("Más")').first();
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
    results.push({ case: 'B-skipped', reason: 'finishAndSave not visible', html: await page.content().then(c => c.slice(0, 500)) });
  }

  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (e) {
  console.error('SMOKE_FAIL', e);
  console.log(JSON.stringify({ results, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
const directory=await mkdtemp(join(tmpdir(),'4running-browser-'));
const app=await startServer({port:4181,directory,testMail:true,migrate:true});
const base='http://localhost:4181', password='Running-browser-12345';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const results=[], errors=[];
await mkdir('work/screenshots',{recursive:true});
async function pageIn(context) { const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return page; }
async function register(page,email) {
  await page.goto(base);await page.locator('#authGate').waitFor({state:'visible'});
  await page.locator('#authEmail').fill(email);await page.locator('#authPassword').fill(password);await page.locator('button[value=register]').click();
  await page.locator('#legalDialog').waitFor({state:'visible'});
  await page.locator('#legalPrivacyCheck').check();await page.locator('#legalMedicalCheck').check();await page.locator('#legalAcceptBtn').click();
  await page.locator('#onboardingDialog').waitFor({state:'visible'});
}
async function onboard(page,{ability='none',assessment='jog',minutes='30',speed='7.0'}={}) {
  await page.locator('#onboardNext').click();
  await page.locator('#onboardActivity').selectOption(ability==='30min'?'run':'walk');
  await page.locator('#onboardWalk').selectOption('30');
  await page.locator(`input[name=onboardAbility][value="${ability}"]`).check();
  await page.locator('#onboardNext').click();
  await page.locator('#onboardMinutes').selectOption(minutes);
  if(speed)await page.locator('#onboardRunSpeed').fill(speed);
  await page.locator('#onboardNext').click();
  await page.locator('#onboardAssessment').selectOption(assessment);
  await page.screenshot({path:`work/screenshots/onboarding-${ability}.png`});
  const preview=await page.locator('#onboardPreview').innerText();
  await page.locator('#onboardFinish').click();await page.locator('#onboardingDialog').waitFor({state:'hidden'});
  return preview;
}
async function start(page,env) {
  await page.locator('#startWorkoutHome').click();await page.locator(`[data-env=${env}]`).click();
  await page.locator('#beginWorkout').click();await page.locator('#activeStage').waitFor({state:'visible'});
}
async function closeAndSave(page,{rpe='4',done='yes'}={}) {
  await page.locator('#sessionDialog').waitFor({state:'visible'});
  await page.locator(`input[name=prescriptionDone][value=${done}]`).check();
  await page.locator(`input[name=sessionRpe][value="${rpe}"]`).check();
  await page.locator('input[name=sessionPain][value=no]').check();
  await page.locator('#closeNext').click();await page.locator('#sessionTalk').selectOption('yes');
  const box=await page.locator('#saveSession').boundingBox();assert.ok(box.y+box.height<=844,'save control in mobile viewport');
  await page.locator('#saveSession').click();await page.locator('#adaptDialog').waitFor({state:'visible'});
  const copy=await page.locator('#adaptDialog').innerText();await page.screenshot({path:`work/screenshots/result-${rpe}-${done}.png`});
  await page.locator('#adaptDone').click();await page.evaluate(()=>PaceCloud.flush());return copy;
}
try {
  const ca=await browser.newContext({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});const a=await pageIn(ca);
  await register(a,'newbie@example.com');const preview=await onboard(a);
  assert.match(preview,/0:30|30/);assert.match(preview,/18 min/);
  assert.ok(!/Logrado:/.test(await a.locator('#milestoneLines').innerText()),'no unobserved achieved milestone');
  await a.evaluate(()=>PaceCloud.flush());await a.screenshot({path:'work/screenshots/today.png',fullPage:true});
  await a.clock.install();
  await a.evaluate(()=>{window.cues=[];window.addEventListener('4running:timer-cue',e=>cues.push({...e.detail,at:Date.now()}));});
  await start(a,'treadmill');
  await a.clock.fastForward(294000);await a.clock.runFor(6000);
  const cues=await a.evaluate(()=>cues);const countdown=cues.filter(e=>e.type==='countdown').map(e=>e.seconds);
  assert.deepEqual(countdown,[5,4,3,2,1],'countdown exact order, no late burst');
  assert.equal(await a.locator('#timerPhase').innerText(),'CORRER');
  const transitionDelta = cues.find(c=>c.type==='block'&&c.phase==='run').at-cues.find(c=>c.type==='block').at;
  console.log('timer cues', JSON.stringify(cues), 'delta', transitionDelta);
  assert.ok(transitionDelta>=300000 && transitionDelta<=300100,'voice does not delay transition beyond timer polling resolution');
  assert.match(await a.locator('#timerSpeed').innerText(),/7,0/);
  await a.locator('#mainTimerButton').click();const paused=await a.locator('#timerValue').innerText();await a.clock.fastForward(9000);
  assert.equal(await a.locator('#timerValue').innerText(),paused);await a.locator('#mainTimerButton').click();
  await a.clock.fastForward(780000);await a.clock.runFor(500);
  const copy=await closeAndSave(a);
  let logs=await a.evaluate(()=>JSON.parse(localStorage.getItem('pace01.logs.v3')));
  assert.equal(logs.length,1);assert.equal(logs[0].execution,'completed');assert.equal(logs[0].isAssessment,true);
  assert.equal(logs[0].runSeconds,120);assert.equal(logs[0].walkSeconds,960);assert.equal(logs[0].maxRunBlockSec,30);
  assert.equal(logs[0].distanceEstimated,true);assert.equal(logs[0].progression,'advance');
  results.push({case:'newbie guided jog',preview,observed:{run:logs[0].runSeconds,walk:logs[0].walkSeconds,continuous:30},recommendation:copy});
  await a.locator('[data-nav=settings]').first().click();
  await a.locator('#voiceToggle').uncheck(); await a.locator('#soundToggle').uncheck();
  await a.locator('#settingsForm button[type=submit]').click();
  await a.evaluate(()=>PaceCloud.whenDurable()); await a.evaluate(()=>PaceCloud.flush());
  // Fresh browser/device restores complete account state, including real in-memory preferences.
  const device=await browser.newContext({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});const d=await pageIn(device);
  await d.goto(base);await d.locator('#authEmail').fill('newbie@example.com');await d.locator('#authPassword').fill(password);await d.locator('button[value=login]').click();
  await d.waitForFunction(()=>window.PaceCoach&&JSON.parse(localStorage.getItem('pace01.logs.v3')||'[]').length===1);
  assert.equal((await d.evaluate(()=>PaceCoach.loadLogs()))[0].id,logs[0].id);
  await d.locator('[data-nav=settings]').first().click();
  assert.equal(await d.locator('#runSpeed').inputValue(),'7');
  assert.equal(await d.locator('#voiceToggle').isChecked(),false);assert.equal(await d.locator('#soundToggle').isChecked(),false);
  await d.locator('#logout').click();await d.locator('#authGate').waitFor({state:'visible'});
  assert.equal(await d.evaluate(()=>localStorage.getItem('pace01.logs.v3')),null);
  results.push({case:'second device and logout',passed:true});
  // Experienced independent account; real training, background catch-up, walk conversion, incomplete save.
  const cb=await browser.newContext({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});const b=await pageIn(cb);
  await register(b,'experienced@example.com');const previewB=await onboard(b,{ability:'30min',assessment:'run',minutes:'45',speed:'9.0'});
  assert.equal(await b.evaluate(()=>PaceCoach.loadLogs().length),0);
  await b.evaluate(()=>PaceCloud.flush());await b.clock.install();await start(b,'outdoor');
  await b.clock.fastForward(360000);await b.clock.runFor(100);
  assert.equal(await b.locator('#timerPhase').innerText(),'CORRER');
  assert.ok(await b.locator('#timerEffort').isVisible());
  assert.match(await b.locator('#timerValue').innerText(),/23:5|24:0/,'catch-up includes minute spent in run after warmup');
  await b.screenshot({path:'work/screenshots/outdoor-timer.png'});
  await b.locator('#walkNow').click();await b.clock.fastForward(10000);await b.clock.runFor(100);await b.locator('#stopNow').click();
  const incompleteCopy=await closeAndSave(b,{rpe:'8',done:'yes'}); // reported complete may not overrule measured blocks
  assert.match(incompleteCopy,/Intento incompleto guardado/i);
  assert.match(incompleteCopy,/estimados/);
  const bl=await b.evaluate(()=>PaceCoach.loadLogs());assert.equal(bl.length,1);assert.equal(bl[0].execution,'aborted');assert.equal(bl[0].progression,'repeat');
  assert.ok(bl[0].maxRunBlockSec>=60&&bl[0].maxRunBlockSec<62);assert.ok(bl[0].blocks.some(b=>b.convertedToWalk));
  results.push({case:'experienced, outdoor, background catch-up, convert to walk',preview:previewB,recommendation:incompleteCopy,observed:bl[0].maxRunBlockSec});
  // Correct onboarding after an attempt, preserving historical prescription and attempt.
  await b.locator('[data-nav=settings]').first().click();await b.locator('#redoOnboarding').click();await b.locator('#confirmOk').click();
  await onboard(b,{ability:'15min',assessment:'later',minutes:'30'});
  assert.equal(await b.evaluate(()=>PaceCoach.loadLogs().length),1);
  assert.ok(await b.evaluate(()=>PaceCoach.loadPlan().sessions.some(s=>s.status==='archived'&&s.attempts.length===1)));
  // Reprogram same prescription and stable ID through the actual UI.
  const before=await b.evaluate(()=>{const s=PaceCoach.getFocusSession(PaceCoach.loadPlan());return {id:s.id,structure:s.structure};});
  await b.locator('#rescheduleSession').click();await b.locator('#rescheduleDate').fill('2026-11-20');await b.locator('#rescheduleForm button[type=submit]').click();await b.locator('#confirmOk').click();
  const after=await b.evaluate(()=>{const s=PaceCoach.getFocusSession(PaceCoach.loadPlan());return {id:s.id,structure:s.structure};});assert.deepEqual(after,before);
  // Offline write queues locally, online retry stores a single session.
  await b.evaluate(()=>PaceCloud.flush());await cb.setOffline(true);
  await b.evaluate(()=>PaceCoach.saveLogs(PaceCoach.loadLogs().map(l=>({...l,notes:'Saved while offline'}))));await b.evaluate(()=>PaceCloud.flush());
  assert.ok(await b.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('4running.pending.'))));
  await cb.setOffline(false);await b.evaluate(()=>PaceCloud.flush());await b.evaluate(()=>PaceCloud.flush());
  const state=await (await cb.request.get(base+'/api/state')).json();assert.equal(state.data.logs.length,1);assert.equal(state.data.logs[0].notes,'Saved while offline');
  assert.equal((await (await ca.request.get(base+'/api/state')).json()).data.logs.length,1,'account A unaffected by B');
  results.push({case:'correct answers, reschedule, offline save retry, isolation',passed:true});
  // Legacy cache is offered, never imported before explicit account confirmation.
  const legacyContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});const legacy=await pageIn(legacyContext);
  await legacy.goto(base);
  await legacy.evaluate(()=>localStorage.setItem('pace01.logs.v3',JSON.stringify([{id:'legacy-stable',date:'2026-11-01',type:'Exterior',rpe:5,pain:false}])));
  await legacy.locator('#authEmail').fill('experienced@example.com');await legacy.locator('#authPassword').fill(password);await legacy.locator('button[value=login]').click();
  await legacy.locator('[data-nav=settings]').first().click();assert.equal(await legacy.evaluate(()=>PaceCoach.loadLogs().length),1);
  await legacy.locator('#importLegacy').click();assert.match(await legacy.locator('#importDialog').innerText(),/experienced@example.com/);await Promise.all([legacy.waitForNavigation({waitUntil:'load'}), legacy.locator('#confirmImport').click()]);
  await legacy.locator('[data-nav=settings]').first().click();await legacy.locator('#importLegacy').click();await Promise.all([legacy.waitForNavigation({waitUntil:'load'}), legacy.locator('#confirmImport').click()]);
  await legacy.waitForFunction(()=>window.PaceCoach&&PaceCoach.loadLogs().length===2);await legacy.evaluate(()=>PaceCloud.flush());
  const imported=await (await legacyContext.request.get(base+'/api/state')).json();assert.equal(imported.data.logs.length,2);
  results.push({case:'explicit legacy import twice',records:imported.data.logs.length,passed:true});
  // Conflicting device changes require a local export before selecting remote state.
  await legacy.evaluate(()=>{const p=PaceCoach.loadPlan();p.goal.label='Plan actualizado en otro dispositivo';PaceCoach.savePlan(p);});
  await legacy.evaluate(()=>PaceCloud.whenDurable()); await legacy.evaluate(()=>PaceCloud.flush());
  await b.evaluate(()=>{const p=PaceCoach.loadPlan();p.goal.label='Plan divergente local';PaceCoach.savePlan(p);});
  await b.evaluate(()=>PaceCloud.whenDurable());
  await b.evaluate(()=>PaceCloud.flush());
  await b.locator('[data-nav=settings]').first().click();
  await b.locator('#resolveSync').waitFor({state:'visible'});await b.locator('#resolveSync').click();
  assert.equal(await b.locator('#useRemote').isDisabled(),true);
  const downloadPromise=b.waitForEvent('download');await b.locator('#downloadPending').click();const download=await downloadPromise;
  await download.saveAs('work/conflict-backup.json');await Promise.all([b.waitForNavigation({waitUntil:'load'}), b.locator('#useRemote').click()]);
  await b.waitForFunction(()=>window.PaceCoach&&PaceCoach.loadLogs().length===2);
  results.push({case:'concurrent device conflict and required backup',passed:true});
  // Optional evaluation skipped: unknown tolerance starts with a conservative walk.
  const cz=await browser.newContext({viewport:{width:390,height:844},isMobile:true,serviceWorkers:'block'});const z=await pageIn(cz);
  await register(z,'walking@example.com');const walkingPreview=await onboard(z,{ability:'unknown',assessment:'later',speed:''});
  assert.match(walkingPreview,/caminata cómoda/);await z.clock.install();await start(z,'outdoor');
  await z.clock.fastForward(900000);await z.clock.runFor(500);const walkingCopy=await closeAndSave(z);
  const walkingLog=await z.evaluate(()=>PaceCoach.loadLogs()[0]);assert.equal(walkingLog.runSeconds,0);assert.equal(walkingLog.walkSeconds,900);assert.equal(walkingLog.progression,'repeat');
  results.push({case:'unknown tolerance, skip assessment, guided walk',next:walkingCopy,passed:true});
  await z.locator('#walkToJogCard').waitFor({state:'visible'});
  const walkingPlanId=await z.evaluate(()=>PaceCoach.getFocusSession(PaceCoach.loadPlan()).id);
  await z.locator('#tryJogAssessment').click();await z.locator('#confirmDialog').waitFor({state:'visible'});
  assert.equal(await z.evaluate(()=>PaceCoach.getFocusSession(PaceCoach.loadPlan()).id),walkingPlanId,'preview never changes plan');
  await z.locator('#confirmOk').click();
  await z.waitForFunction(()=>PaceCoach.getFocusSession(PaceCoach.loadPlan()).structure.runSeconds===30);
  assert.equal(await z.evaluate(()=>PaceCoach.loadLogs().length),1);
  assert.ok(await z.evaluate(()=>PaceCoach.loadPlan().sessions.some(s=>s.status==='archived'&&s.attempts.length>0)));
  results.push({case:'walking to optional jog from Today, explicit acceptance and retained walking history',passed:true});
  // Password recovery through the browser and local test mail link.
  await d.locator('#authEmail').fill('newbie@example.com');await d.locator('button[value=recover]').click();
  await d.waitForFunction(()=>document.querySelector('#authError').textContent.includes('buzón local'));
  const mail=JSON.parse((await readFile(join(directory,'mail-outbox.jsonl'),'utf8')).trim().split('\n').at(-1));
  await d.goto(mail.url);await d.locator('#resetFields').waitFor({state:'visible'});
  await d.locator('#newPassword').fill('Browser-new-pass-12345');await d.locator('button[value=reset]').click();
  await d.locator('#authFields').waitFor({state:'visible'});await d.locator('#authEmail').fill('newbie@example.com');await d.locator('#authPassword').fill('Browser-new-pass-12345');await d.locator('button[value=login]').click();
  try { await d.waitForFunction(()=>window.PaceCoach&&PaceCoach.loadLogs().length===1); } catch (error) { console.log('RECOVERY_DEBUG', await d.evaluate(()=>({url:location.href,authError:document.querySelector('#authError')?.textContent,gate:!document.querySelector('#authGate')?.hidden,logs:localStorage.getItem('pace01.logs.v3'),owner:localStorage.getItem('4running.cacheOwner')})));console.log('RECOVERY_SESSION_HTTP',await d.evaluate(async()=>{const r=await fetch('/api/auth/get-session');return {status:r.status,retry:r.headers.get('x-retry-after')};}));throw error; }
  results.push({case:'browser recovery via test-mail link, new password and history retained',passed:true});
  // A recovery gate cannot be bypassed by opening the training view directly.
  await z.evaluate(()=>{const p=PaceCoach.loadPlan();const s=PaceCoach.getFocusSession(p);s.blockedUntilRest=true;PaceCoach.savePlan(p);});
  await z.reload();await z.locator('#todayRest').waitFor({state:'visible'});
  await z.goto(base+'/#train');
  // Invoke hidden controls too: a direct event must not bypass the safety guard.
  await z.evaluate(()=>document.querySelector('[data-env=outdoor]').click());
  await z.evaluate(()=>document.querySelector('#beginWorkout').click());
  assert.equal(await z.locator('#activeStage').isVisible(),false);assert.ok(await z.locator('#todayRest').isVisible());
  results.push({case:'direct training route respects recovery gate',passed:true});
  // Horizontal overflow and primary control sizes on 390px mobile.
  assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  await writeFile('work/browser-results.json',JSON.stringify({results,errors},null,2));
  console.log(JSON.stringify({results,errors},null,2));
} finally { await browser.close();await app.close();await rm(directory,{recursive:true,force:true}); }

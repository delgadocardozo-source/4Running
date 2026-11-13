import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { startServer, migrateDatabase } from '../server.mjs';
const directory = await mkdtemp(join(tmpdir(), '4running-sync-'));
const port = 4185, base = `http://localhost:${port}`, password = 'Sync-regression-12345';
const missing = join(directory, 'missing');
await assert.rejects(startServer({ port, directory: missing }), /migrate/);
await assert.rejects(access(join(missing, '4running.sqlite')));
await migrateDatabase({ port, directory, testMail: true });
const app = await startServer({ port, directory, testMail: true }); // Startup must not migrate.
const schema = () => app.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
const initialSchema = schema();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const sandbox = { window: {}, localStorage: {getItem:()=>null,setItem(){}}, structuredClone, crypto: {randomUUID}, console, Date, Math, JSON };
vm.createContext(sandbox); vm.runInContext(await readFile(new URL('../adaptive-engine.js', import.meta.url), 'utf8'), sandbox);
const settings = {runSpeed:9,walkSpeed:5,coolSpeed:4.5,voice:false,sound:false,countdown:true,lastEnvironment:'treadmill'};
const initialPlan = sandbox.window.PaceAdaptive.buildPlanFromIntake({continuousAbility:'1min',assessment:'later',walkTolerance:'30',availableMinutes:30}, settings);
const jsonPlan = JSON.parse(JSON.stringify(initialPlan));
const originHeaders = {Origin:base};
async function register(context,email,seed=true) {
  const response=await context.request.post(base+'/api/auth/sign-up/email',{headers:originHeaders,data:{email,password,name:email}});assert.ok(response.ok(),await response.text());
  if(seed) { const saved=await context.request.put(base+'/api/state',{headers:originHeaders,data:{revision:0,data:{settings,plan:jsonPlan,logs:[],account:{privacyAcceptedAt:'2026-11-12',medicalDisclaimerAcceptedAt:'2026-11-12'}}}});assert.ok(saved.ok(),await saved.text()); }
}
async function pageIn(context) {
  const page=await context.newPage();await page.goto(base);
  await page.waitForFunction(()=>window.PaceCloud?.userId() && window.PaceCoach && !document.querySelector('.app-shell').hidden);
  await page.evaluate(()=>PaceCloud.whenDurable());await page.evaluate(()=>PaceCloud.flush());return page;
}
async function stores(page,name) { return await page.evaluate(name=>new Promise((resolve,reject)=>{const request=indexedDB.open('4running-account-sync',1);request.onsuccess=()=>{const db=request.result;const get=db.transaction(name).objectStore(name).getAll();get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(get.error)}}),name); }
async function settle(page) { await page.evaluate(()=>PaceCloud.whenDurable());await page.evaluate(()=>PaceCloud.flush()); }
const errors=[];
try {
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await register(context,'same-tabs@example.com');
  const a=await pageIn(context), b=await pageIn(context);
  // A new browser must hydrate settings before using or re-saving them.
  assert.equal(await a.locator('#runSpeed').inputValue(),'9');
  assert.equal(await a.locator('#voiceToggle').isChecked(),false);
  await settle(a);await settle(b);
  const baseState=(await (await context.request.get(base+'/api/state')).json()).data;
  await Promise.all([a,b].map(page=>page.evaluate(state=>window.__baseState=structuredClone(state),baseState)));
  await context.setOffline(true);
  const saveAttempt=(page,id)=>page.evaluate(async id=>{
    const data=structuredClone(window.__baseState);const session=data.plan.sessions.find(session=>session.kind==='run');
    const log={id,date:'2026-11-12',type:'Exterior',rpe:4,pain:false,planSessionId:session.id,execution:'completed',prescriptionCompleted:true,maxRunBlockSec:60,updatedAt:new Date().toISOString()};
    session.attempts.push({id:'att-'+id,logId:id,date:log.date,execution:'completed',progression:'repeat'});
    PaceCoach.savePlan(data.plan);PaceCoach.saveLogs([...data.logs,log]);await PaceCloud.whenDurable();
  },id);
  await Promise.all([saveAttempt(a,'offline-tab-a'),saveAttempt(b,'offline-tab-b')]);
  const queued=await stores(a,'outbox');
  assert.ok(queued.some(op=>op.changes?.logs?.some(log=>log.id==='offline-tab-a')));
  assert.ok(queued.some(op=>op.changes?.logs?.some(log=>log.id==='offline-tab-b')));
  // Reload a tab while offline writes still await delivery: the journal is independent of the cache.
  await context.setOffline(false);await Promise.all([settle(a),settle(b)]);
  const after=(await (await context.request.get(base+'/api/state')).json()).data;
  assert.ok(after.logs.some(log=>log.id==='offline-tab-a'));assert.ok(after.logs.some(log=>log.id==='offline-tab-b'));
  const attempts=after.plan.sessions.flatMap(session=>session.attempts||[]);
  assert.ok(attempts.length>=1);assert.ok((await stores(a,'conflicts')).length>=1,'divergent plan preserved as a conflict instead of overwriting attempts');
  assert.equal((await stores(a,'outbox')).length,0);
  const pack=await a.evaluate(()=>PaceCloud.backupPack());assert.ok(pack.logs.some(log=>log.id==='offline-tab-a')&&pack.logs.some(log=>log.id==='offline-tab-b'));
  // A stale candidate cannot drop attempts even when a tab was refreshed onto the latest base.
  const current=(await (await context.request.get(base+'/api/state')).json()).data;
  const lossy=await context.request.post(base+'/api/sync',{headers:originHeaders,data:{mutationId:'lossy-plan',basePlan:current.plan,changes:{plan:baseState.plan,logs:[{id:'preserved-despite-lossy-plan'}]}}});
  assert.equal((await lossy.json()).planConflict,true);
  assert.ok((await (await context.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='preserved-despite-lossy-plan'));
  console.log('PASS: two same-origin offline tabs retain both sessions; divergent plans and their attempts are preserved.');
  // Isolated account: fake a response lost after the server committed, then reload.
  const ackContext=await browser.newContext({serviceWorkers:'block'});await register(ackContext,'lost-ack@example.com');const ack=await pageIn(ackContext);await settle(ack);
  let abortOnce=true,lostId,replayed=0;
  await ack.route('**/api/sync',async route=>{
    const body=route.request().postDataJSON();
    if(abortOnce) { abortOnce=false;lostId=body.mutationId;const result=await route.fetch();assert.ok(result.ok());await route.abort('failed');return; }
    if(body.mutationId===lostId)replayed++;
    await route.continue();
  });
  await ack.evaluate(async()=>{const settings=JSON.parse(localStorage.getItem('pace01.settings.v1'));settings.walkSpeed=5.7;localStorage.setItem('pace01.settings.v1',JSON.stringify(settings));await PaceCloud.whenDurable();await PaceCloud.flush();});
  assert.ok(lostId);assert.ok((await stores(ack,'outbox')).some(op=>op.id===lostId));
  await ack.reload();await ack.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);await settle(ack);
  assert.ok(replayed>=1,'reload retries the original operation before treating it as a conflict');
  assert.equal((await stores(ack,'outbox')).length,0);assert.equal((await stores(ack,'conflicts')).length,0);
  assert.equal((await (await ackContext.request.get(base+'/api/state')).json()).data.settings.walkSpeed,5.7);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sync_operations WHERE operation_id=?').get(lostId).n,1);
  console.log('PASS: lost acknowledgement survives reload, replays one operation and creates no false conflict.');
  const offlineOwner=await ack.evaluate(()=>PaceCloud.userId());
  await ack.route('**/api/**',route=>route.abort('internetdisconnected'));
  await ack.reload();await ack.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);
  assert.equal(await ack.evaluate(()=>PaceCloud.userId()),offlineOwner);
  assert.match(await ack.locator('#syncStatus').innerText(),/Sin conexión/);
  await ack.unroute('**/api/**');await settle(ack);
  console.log('PASS: offline boot restores only the last verified account; reconnect revalidates its session.');
  // Explicit offline logout leaves pending writes in the owner-scoped journal and hides the account.
  await ackContext.setOffline(true);
  await ack.evaluate(async()=>{const logs=JSON.parse(localStorage.getItem('pace01.logs.v3'));logs.push({id:'retained-after-offline-logout',date:'2026-11-12'});localStorage.setItem('pace01.logs.v3',JSON.stringify(logs));await PaceCloud.whenDurable();});
  const owner=await ack.evaluate(()=>PaceCloud.userId());
  await ack.evaluate(()=>{PaceCloud.signOut({keepPending:true});}).catch(()=>{});
  await ack.waitForTimeout(250);await ackContext.setOffline(false);await ack.goto(base);await ack.locator('#authGate').waitFor({state:'visible'});
  assert.equal(await ack.evaluate(()=>localStorage.getItem('pace01.logs.v3')),null);
  await register(ackContext,'other-owner@example.com');await ack.goto(base);await ack.waitForFunction(()=>PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);await settle(ack);
  assert.equal((await (await ackContext.request.get(base+'/api/state')).json()).data.logs.length,0,'another account must not send or display the prior owner queue');
  assert.ok((await stores(ack,'outbox')).some(op=>op.owner===owner&&op.changes.logs?.some(log=>log.id==='retained-after-offline-logout')));
  await ackContext.request.post(base+'/api/auth/sign-out',{headers:originHeaders,data:{}});
  await ackContext.request.post(base+'/api/auth/sign-in/email',{headers:originHeaders,data:{email:'lost-ack@example.com',password}});
  await ack.goto(base);await ack.waitForFunction(()=>PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);await settle(ack);
  assert.ok((await (await ackContext.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='retained-after-offline-logout'));
  console.log('PASS: explicit offline logout preserves owner-scoped writes; other account is isolated; original account restores them.');
  // Migration of a v1 localStorage pending snapshot whose revision is already stale.
  const legacyContext=await browser.newContext({serviceWorkers:'block'});
  // Reuse the independent account fixture; avoid exhausting the real sign-up limiter.
  const legacyLogin=await legacyContext.request.post(base+'/api/auth/sign-in/email',{headers:originHeaders,data:{email:'other-owner@example.com',password}});assert.ok(legacyLogin.ok(),await legacyLogin.text());
  const legacy=await pageIn(legacyContext);await settle(legacy);
  const legacyBase=await (await legacyContext.request.get(base+'/api/state')).json();
  await legacyContext.request.post(base+'/api/sync',{headers:originHeaders,data:{mutationId:'other-device-before-upgrade',changes:{settings:{coolSpeed:4.8}}}});
  let blockLegacyDelivery=true;
  await legacy.route('**/api/sync',async route=>{
    if(blockLegacyDelivery&&route.request().postDataJSON().mutationId.startsWith('legacy-logs-'))return route.abort('internetdisconnected');
    await route.continue();
  });
  await legacy.evaluate(state=>{
    const candidate=structuredClone(state.data);candidate.logs.push({id:'legacy-unseen-at-upgrade',date:'2026-11-13',type:'Exterior',rpe:4});
    localStorage.setItem(`4running.pending.${PaceCloud.userId()}`,JSON.stringify({revision:state.revision,mutationId:'legacy-v1-pending',data:candidate}));
  },legacyBase);
  await legacy.reload();await legacy.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);
  assert.ok((await stores(legacy,'outbox')).some(operation=>operation.legacy&&operation.id==='legacy-v1-pending'),'failed legacy log delivery must stay in the durable outbox');
  assert.equal((await stores(legacy,'conflicts')).length,0,'do not archive a legacy candidate before acknowledging its logs');
  assert.ok(!(await (await legacyContext.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='legacy-unseen-at-upgrade'));
  blockLegacyDelivery=false;await settle(legacy);
  assert.ok((await (await legacyContext.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='legacy-unseen-at-upgrade'));
  assert.ok((await stores(legacy,'conflicts')).some(operation=>operation.id==='legacy-v1-pending'));
  await legacy.locator('[data-nav=settings]').first().click();await legacy.locator('#resolveSync').click();
  const firstBackup=legacy.waitForEvent('download');await legacy.locator('#downloadPending').click();await firstBackup;
  await Promise.all([legacy.waitForNavigation(),legacy.locator('#useRemote').click()]);
  await legacy.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);await settle(legacy);
  assert.ok((await (await legacyContext.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='legacy-unseen-at-upgrade'),'choosing the remote plan keeps migrated attempts on the server without relying on the backup file');
  assert.equal((await stores(legacy,'conflicts')).length,0);
  // Repair a legacy conflict that had already been archived by an older client.
  await legacy.evaluate(async()=>{
    const data={settings:{},account:{},plan:null,logs:[{id:'legacy-previously-archived',date:'2026-11-13',type:'Exterior'}]};
    await new Promise((resolve,reject)=>{const open=indexedDB.open('4running-account-sync',1);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('conflicts','readwrite');tx.objectStore('conflicts').put({id:'legacy-already-archived',owner:PaceCloud.userId(),createdAt:Date.now(),sequence:1,legacy:true,revision:0,data});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)};});
  });
  await legacy.reload();await legacy.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);
  await legacy.locator('[data-nav=settings]').first().click();await legacy.locator('#resolveSync').click();
  const secondBackup=legacy.waitForEvent('download');await legacy.locator('#downloadPending').click();await secondBackup;
  blockLegacyDelivery=true;await legacy.locator('#useRemote').click();
  await legacy.waitForFunction(()=>document.querySelector('#syncStatus').textContent.includes('Conservamos los conflictos'));
  assert.ok((await stores(legacy,'conflicts')).some(operation=>operation.id==='legacy-already-archived'),'delivery failure must not delete already-archived legacy data');
  assert.ok(!(await (await legacyContext.request.get(base+'/api/state')).json()).data.logs.some(log=>log.id==='legacy-previously-archived'));
  blockLegacyDelivery=false;
  await Promise.all([legacy.waitForNavigation(),legacy.locator('#useRemote').click()]);
  await legacy.waitForFunction(()=>window.PaceCloud?.userId()&&!document.querySelector('.app-shell').hidden);await settle(legacy);
  const repaired=(await (await legacyContext.request.get(base+'/api/state')).json()).data.logs;
  assert.equal(repaired.filter(log=>log.id==='legacy-unseen-at-upgrade').length,1);
  assert.equal(repaired.filter(log=>log.id==='legacy-previously-archived').length,1);
  assert.equal((await stores(legacy,'conflicts')).length,0);
  console.log('PASS: legacy stale snapshots and previously archived conflicts deliver every log before retiring a plan; failure keeps durable recovery data.');
  assert.deepEqual(schema(),initialSchema,'normal runtime did not mutate the database schema');
  assert.deepEqual(errors,[]);
} finally {await browser.close();await app.close();await rm(directory,{recursive:true,force:true});}

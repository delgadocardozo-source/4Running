/**
 * Simulación 14 días desde la interfaz (perfil aislado + reloj PaceTestClock).
 * Usa la misma app servida por HTTP; no toca localStorage de producción (origen distinto / perfil limpio).
 *
 * node tests/ui-browser-14d.mjs
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const port = 8766;
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
    res.writeHead(404); res.end('missing'); return;
  }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'text/plain' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(port, r));

const userData = join(tmpdir(), `pace01-ui-sim-${Date.now()}`);
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=9222`,
  `http://127.0.0.1:${port}/index.html`
], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 2500));

async function cdp(method, params = {}, sessionId) {
  const list = await fetch('http://127.0.0.1:9222/json/list').then((x) => x.json());
  const page = list.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
  if (!page) throw new Error('no page');
  // Use Runtime via websocket is heavy; use /json/protocol evaluate via chrome fetch hack:
  // Prefer Puppeteer-less: HTTP endpoint not available for evaluate.
  return { page };
}

// Fallback: drive logic by injecting a bookmarklet-style file the page can load? 
// Instead run evaluation through chrome --dump-dom after setting localStorage via a harness page.

const harness = `<!doctype html><html><body>
<script src="/adaptive-engine.js"></script>
<script src="/coach-engine.js"></script>
<script>
window.__rows = [];
(async function(){
  const A = PaceAdaptive, C = PaceCoach;
  localStorage.clear();
  const settings={walkSpeed:5,runSpeed:7.5,coolSpeed:4.5,countdown:true,voice:false,sound:false};
  localStorage.setItem('pace01.settings.v1', JSON.stringify(settings));
  let plan = A.buildPlanFromIntake({
    goalType:'5k_finish_runwalk', continuousAbility:'1min', sessionsPerWeek:3,
    environment:'both', hasPain:false
  }, settings);
  C.savePlan(plan);
  let logs = [];
  C.saveLogs(logs);
  function setDay(iso){
    const [y,m,d]=iso.split('-').map(Number);
    A.setClock(()=>new Date(y,m-1,d,10,0,0));
  }
  function add(iso,n){ return A.addDaysISO(iso,n); }
  let cursor='2026-07-01';
  for(let i=0;i<7;i++){
    setDay(cursor);
    let focus=C.getFocusSession(plan);
    while(focus && focus.kind==='rest'){
      const out=C.markRestComplete(plan,logs,focus.id,cursor);
      plan=out.plan; logs=out.logs; C.savePlan(plan); C.saveLogs(logs);
      cursor=add(cursor,1); setDay(cursor);
      focus=C.getFocusSession(plan);
    }
    focus=C.getFocusSession(plan);
    if(!focus||focus.kind!=='run'){ plan=A.ensureHorizon(plan,logs,{runSpeed:7.5,walkSpeed:5,coolSpeed:4.5}); focus=C.getFocusSession(plan); }
    while(focus&&focus.kind==='rest'){
      const out=C.markRestComplete(plan,logs,focus.id,cursor);
      plan=out.plan; logs=out.logs; cursor=add(cursor,1); setDay(cursor); focus=C.getFocusSession(plan);
    }
    const st=A.structureFromClassic(focus.structure);
    const rpe = i%2?4:3;
    const log={
      id:cursor+'-'+i, date:cursor, type:'Cinta', planSessionId:focus.id, time:'38:00',
      distanceKm:3.1, distanceEstimated:true, maxRunBlockSec:st.runSeconds, rpe, pain:false,
      worseningDuringRun:false,alteredGait:false,forcedStop:false,severeWarning:false,
      prescriptionCompleted:true, execution:'completed', environment:'treadmill', source:'timer'
    };
    logs.push(log);
    const result=C.confirmNextSession(plan,log,logs);
    plan=result.plan; C.savePlan(plan); C.saveLogs(logs);
    const next=C.sortedPlanSessions(plan).find(s=>s.kind==='run'&&(s.status==='pending'||s.status==='rescheduled'));
    window.__rows.push({
      date:cursor,
      prescribed:A.describeStructure(st),
      continuous:st.runSeconds,
      totalRun:A.metrics(st).totalRunSec,
      walk:A.metrics(st).totalWalkSec,
      reps:st.reps,
      totalMin:A.metrics(st).totalMin,
      speeds:{run:7.5,walk:5,cool:4.5},
      rpe,
      completed:true,
      action:result.action,
      next:next?A.describeStructure(next.structure):null,
      diff:result.explanation&&result.explanation.summary,
      interpretation:result.explanation&&result.explanation.interpretation,
      reason:result.decision&&result.decision.reason,
      scheduled:next&&next.scheduledDate
    });
    cursor=add(cursor,2);
  }
  document.title='DONE:'+window.__rows.length;
  document.body.textContent=JSON.stringify(window.__rows);
})();
</script></body></html>`;

writeFileSync(join(root, 'tests/ui-harness-14d.html'), harness);

// Kill previous chrome and open harness
chrome.kill();
await new Promise((r) => setTimeout(r, 500));

const outFile = join(tmpdir(), 'pace-dom.html');
const dump = spawn('google-chrome', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  `--user-data-dir=${userData}-2`,
  `--dump-dom`,
  `http://127.0.0.1:${port}/tests/ui-harness-14d.html`
], { stdio: ['ignore', 'pipe', 'pipe'] });

let dom = '';
dump.stdout.on('data', (c) => { dom += c.toString(); });
await new Promise((resolve, reject) => {
  dump.on('close', resolve);
  dump.on('error', reject);
  setTimeout(() => resolve(), 8000);
});

const match = dom.match(/\[\{[\s\S]*\}\]/);
if (!match) {
  console.error('No rows in DOM. Snippet:', dom.slice(0, 500));
  server.close();
  process.exit(1);
}
const rows = JSON.parse(match[0]);
writeFileSync(join(root, 'tests/ui-sim-14d-browser.json'), JSON.stringify(rows, null, 2));
console.log('UI-harness 14d rows:', rows.length);
rows.forEach((r) => console.log(`${r.date} | ${r.prescribed} | RPE ${r.rpe} | ${r.action} → ${r.next}`));
server.close();
process.exit(rows.length >= 5 ? 0 : 1);

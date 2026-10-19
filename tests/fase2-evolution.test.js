/**
 * Fase 2 — evolución 8–12 semanas + perfiles A–H + 14d UI-flow (PaceCoach).
 * node tests/fase2-evolution.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

const sandbox = {
  window: { localStorage },
  document: {},
  navigator: {},
  localStorage,
  console,
  structuredClone: global.structuredClone || ((v) => JSON.parse(JSON.stringify(v))),
  JSON, Date, Math, Number, String, Boolean, Array, Object, parseInt, parseFloat, isNaN, undefined
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'adaptive-engine.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'coach-engine.js'), 'utf8'), sandbox);

const A = sandbox.window.PaceAdaptive;
const C = sandbox.window.PaceCoach;

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else console.log('ok  ', msg);
}

function setDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  A.setClock(() => new Date(y, m - 1, d, 10, 0, 0));
}

function addDays(iso, n) {
  return A.addDaysISO(iso, n);
}

const START = { warmSeconds: 300, coolSeconds: 300, runSeconds: 120, walkSeconds: 120, reps: 7 };

function freshPlan(structure = START, goalType = '5k_finish_runwalk') {
  return {
    version: 4,
    engineVersion: A.ENGINE_VERSION,
    params: { ...A.DEFAULT_PARAMS },
    goal: { type: goalType, label: goalType },
    raceDate: '2026-12-01',
    checkpointDate: '2026-11-15',
    sessions: [{
      id: 'seed',
      order: 1,
      weekGroup: 1,
      kind: 'run',
      title: 'Inicio',
      status: 'pending',
      scheduledDate: null,
      blockedUntilRest: false,
      structure: A.structureFromClassic(structure),
      attempts: []
    }]
  };
}

function trainOnce(plan, logs, cursor, opts = {}) {
  setDay(cursor);
  let focus = C.getFocusSession(plan);
  let guard = 0;
  while (focus && focus.kind === 'rest' && guard < 6) {
    guard += 1;
    const out = C.markRestComplete(plan, logs, focus.id, cursor);
    plan = out.plan;
    logs = out.logs;
    if (/no avanzó/i.test(out.message || '')) {
      assert(false, 'mensaje recuperación no debe decir "no avanzó": ' + out.message);
    }
    cursor = addDays(cursor, 1);
    setDay(cursor);
    focus = C.getFocusSession(plan);
  }
  if (!focus || focus.kind !== 'run') {
    plan = A.ensureHorizon(plan, logs, { runSpeed: 7.5, walkSpeed: 5, coolSpeed: 4.5 });
    focus = C.getFocusSession(plan);
  }
  while (focus && focus.kind === 'rest') {
    const out = C.markRestComplete(plan, logs, focus.id, cursor);
    plan = out.plan;
    logs = out.logs;
    cursor = addDays(cursor, 1);
    setDay(cursor);
    focus = C.getFocusSession(plan);
  }
  if (!focus || focus.kind !== 'run') return { plan, logs, cursor, row: null };

  const st = A.structureFromClassic(focus.structure);
  const {
    rpe = 3, incomplete = false, safety = false, pain = false, maxRunBlockSec = null
  } = opts;
  const log = {
    id: `${cursor}-${Math.random().toString(16).slice(2, 7)}`,
    date: cursor,
    type: 'Cinta',
    planSessionId: focus.id,
    time: '40:00',
    distanceKm: opts.distanceKm != null ? opts.distanceKm : 3.2,
    distanceEstimated: opts.distanceEstimated !== false,
    elapsedSec: opts.elapsedSec || null,
    maxRunBlockSec: maxRunBlockSec != null ? maxRunBlockSec : st.runSeconds,
    couldContinue: '2-5',
    rpe,
    pain,
    painLocation: pain ? 'rodilla' : '',
    painIntensity: pain ? 4 : null,
    worseningDuringRun: safety,
    alteredGait: false,
    forcedStop: safety,
    severeWarning: false,
    prescriptionCompleted: !incomplete,
    execution: incomplete ? 'aborted' : 'completed',
    environment: 'treadmill',
    source: 'test'
  };
  logs.push(log);
  const result = C.confirmNextSession(plan, log, logs);
  plan = result.plan;
  const nextRun = C.sortedPlanSessions(plan).find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
  const row = {
    date: log.date,
    prescribed: A.describeStructure(st),
    continuous: st.runSeconds,
    totalRun: A.metrics(st).totalRunSec,
    walk: A.metrics(st).totalWalkSec,
    reps: st.reps,
    walkSec: st.walkSeconds,
    totalMin: A.metrics(st).totalMin,
    rpe,
    completed: !incomplete,
    action: result.action || result.decision?.adaptiveAction,
    next: nextRun ? A.describeStructure(nextRun.structure) : null,
    nextContinuous: nextRun ? A.structureFromClassic(nextRun.structure).runSeconds : null,
    interpretation: result.explanation?.interpretation || null,
    diff: result.explanation?.summary || null,
    scheduledNext: nextRun?.scheduledDate || null,
    speedAction: result.speedSuggestion?.action || null,
    mathOk: A.validateStructureMath(st).ok
  };
  cursor = addDays(log.date, 2);
  setDay(cursor);
  return { plan, logs, cursor, row, result };
}

console.log('\n=== WalkSeconds 0 preservado ===');
assert(A.structureFromClassic({ runSeconds: 1800, walkSeconds: 0, reps: 1 }).walkSeconds === 0, 'walkSeconds 0 no se convierte en default');

console.log('\n=== Escenario A: 10 semanas buena evolución → continuo largo ===');
{
  let plan = freshPlan();
  let logs = [];
  let cursor = '2026-01-05';
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const out = trainOnce(plan, logs, cursor, { rpe: i % 3 === 0 ? 3 : 4 });
    plan = out.plan; logs = out.logs; cursor = out.cursor;
    if (out.row) rows.push(out.row);
  }
  const maxCont = Math.max(...rows.map(r => r.continuous));
  assert(rows.every(r => r.mathOk), 'A: sumas de bloques coherentes');
  assert(maxCont >= 10 * 60, `A: alcanza al menos 10 min continuo (obtuvo ${maxCont}s)`);
  assert(rows.some(r => r.action === 'progress_continuous' || r.nextContinuous > START.runSeconds), 'A: progresión de continuo');
  assert(rows.filter(r => r.interpretation && /continuo|volumen/i.test(r.interpretation || '')).length >= 1, 'A: interpreta continuo vs volumen');
  console.log('  max continuo A:', A.formatBlockSec(maxCont), 'sesiones', rows.length);
  fs.writeFileSync(path.join(root, 'tests/fase2-scenario-a.json'), JSON.stringify(rows, null, 2));
}

console.log('\n=== Escenario B: dificultades ===');
{
  let plan = freshPlan();
  let logs = [];
  let cursor = '2026-01-05';
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const out = trainOnce(plan, logs, cursor, {
      rpe: 8,
      incomplete: i % 3 === 1
    });
    plan = out.plan; logs = out.logs; cursor = out.cursor;
    if (out.row) rows.push(out.row);
  }
  const progresses = rows.filter(r => String(r.action).startsWith('progress'));
  assert(progresses.length === 0, 'B: no progresa con RPE alto');
  assert(rows.some(r => r.action === 'repeat' || r.action === 'reduce'), 'B: repeat/reduce');
}

console.log('\n=== Escenario C: estancamiento (RPE 6) ===');
{
  let plan = freshPlan();
  let logs = [];
  let cursor = '2026-01-05';
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const out = trainOnce(plan, logs, cursor, { rpe: 6 });
    plan = out.plan; logs = out.logs; cursor = out.cursor;
    if (out.row) rows.push(out.row);
  }
  assert(rows.some(r => r.action === 'consolidate' || r.action === 'repeat'), 'C: consolida o repite');
}

console.log('\n=== Escenario D: seguridad ===');
{
  let plan = freshPlan();
  let logs = [];
  let cursor = '2026-01-05';
  trainOnce(plan, logs, cursor, { rpe: 3 });
  const out = trainOnce(plan, logs, addDays(cursor, 4), { rpe: 3, safety: true });
  assert(out.row?.action === 'recovery' || out.result?.progression === 'recovery', 'D: recovery ante seguridad');
}

console.log('\n=== Escenario E: ausencia 14 días ===');
{
  let plan = freshPlan();
  let logs = [];
  let cursor = '2026-01-05';
  let out = trainOnce(plan, logs, cursor, { rpe: 3 });
  plan = out.plan; logs = out.logs;
  cursor = addDays(out.row.date, 14);
  setDay(cursor);
  out = trainOnce(plan, logs, cursor, { rpe: 4 });
  assert(out.row?.action === 'reassess' || out.result?.decision?.reasonCode?.includes('PAUSE_REASSESS') || out.row?.action === 'consolidate', 'E: reevalúa o consolida tras pausa');
  assert(logs.length >= 2, 'E: conserva historial');
}

console.log('\n=== Escenario F: ya corre 30 min ===');
{
  const cont = { warmSeconds: 300, coolSeconds: 300, runSeconds: 30 * 60, walkSeconds: 0, reps: 1 };
  let plan = freshPlan(cont, 'maintenance');
  plan.sessions[0].status = 'completed';
  const seedLogs = [1, 3, 5].map(d => ({
    id: `e${d}`, date: `2026-01-0${d}`, type: 'Cinta', rpe: 3, maxRunBlockSec: 30 * 60,
    prescriptionCompleted: true, execution: 'completed', distanceKm: 5.1, distanceEstimated: false,
    source: 'test'
  }));
  plan = A.ensureHorizon(plan, seedLogs, { runSpeed: 7.5 }, { action: 'progress_volume', reason: 'test' });
  const open = A.pendingRuns(plan)[0];
  assert(open, 'F: genera horizonte');
  const st = A.structureFromClassic(open.structure);
  assert(!(st.runSeconds === 120 && st.walkSeconds === 120 && st.reps === 7), 'F: no vuelve a 2/2×7');
  assert(st.walkSeconds === 0 || st.runSeconds >= 20 * 60, 'F: mantiene orientación continua/volumen');
}

console.log('\n=== Escenario G: mejora marca 5K ===');
{
  const cont = { warmSeconds: 300, coolSeconds: 300, runSeconds: 30 * 60, walkSeconds: 0, reps: 1 };
  let plan = freshPlan(cont, '5k_pb');
  const logs = [1, 3, 5, 7].map(d => ({
    id: `g${d}`, date: `2026-02-0${d}`, type: 'Cinta', rpe: 3, maxRunBlockSec: 30 * 60,
    prescriptionCompleted: true, execution: 'completed', distanceKm: 5.0, distanceEstimated: false,
    elapsedSec: 1800, source: 'test'
  }));
  const profile = A.deriveProfile(logs, plan, { runSpeed: 8 });
  assert(profile.priorityDimension === 'performance' || profile.stage >= 5, 'G: dimensión rendimiento o etapa alta');
  const cands = A.generateCandidates(cont, 'progress_performance', profile, plan);
  assert(cands.some(c => c.primaryVar === 'performance' || c.primaryVar === 'continuous'), 'G: candidatos de rendimiento');
  assert(!cands.every(c => c.structure.runSeconds === 120 && c.structure.walkSeconds === 120), 'G: no solo plan inicial');
}

console.log('\n=== Escenario H: velocidades ===');
{
  const keep = A.suggestSpeed([], { runSpeed: 7.5 }, freshPlan());
  assert(keep.action === 'keep', 'H: sin evidencia → keep');
  assert(!keep.suggestedKmh, 'H: no sugiere número sin evidencia');
  const logs = [];
  for (let i = 0; i < 4; i++) {
    logs.push({
      id: `h${i}`, date: `2026-03-0${i + 1}`, type: 'Cinta', rpe: 3, maxRunBlockSec: 20 * 60,
      prescriptionCompleted: true, execution: 'completed', distanceKm: 4.2, distanceEstimated: false,
      elapsedSec: 20 * 60, source: 'test', pain: false
    });
  }
  const plan = freshPlan({ warmSeconds: 300, coolSeconds: 300, runSeconds: 20 * 60, walkSeconds: 0, reps: 1 }, '5k_pb');
  const sug = A.suggestSpeed(logs, { runSpeed: 7.5 }, plan);
  assert(sug.acceptRequired === true, 'H: aceptación requerida');
  // Con datos de segmentos en continuo puede sugerir o pedir más evidencia de segmentos
  assert(['keep', 'suggest_up'].includes(sug.action), 'H: acción válida');
}

console.log('\n=== Confianza vs precaución ===');
{
  const logs = [
    { id: '1', date: '2026-04-01', type: 'Cinta', rpe: 8, prescriptionCompleted: true, execution: 'completed', maxRunBlockSec: 120, source: 'test' },
    { id: '2', date: '2026-04-03', type: 'Cinta', rpe: 4, prescriptionCompleted: true, execution: 'completed', maxRunBlockSec: 120, source: 'test' },
    { id: '3', date: '2026-04-05', type: 'Cinta', rpe: 3, prescriptionCompleted: true, execution: 'completed', maxRunBlockSec: 150, source: 'test' },
    { id: '4', date: '2026-04-07', type: 'Cinta', rpe: 3, prescriptionCompleted: true, execution: 'completed', maxRunBlockSec: 150, source: 'test' }
  ];
  setDay('2026-04-07');
  const profile = A.deriveProfile(logs, freshPlan(), {});
  assert(profile.confidence === 'alta' || profile.confidence === 'media', 'confianza calculada');
  assert(profile.caution && profile.caution.reasons, 'precaución tiene razones');
  assert(typeof profile.confidenceNote === 'string', 'nota de confianza');
}

console.log('\n=== Calendario: fechas y sin duplicar mismo día ===');
{
  let plan = freshPlan();
  plan = A.ensureHorizon(plan, [], { runSpeed: 7.5 }, { action: 'consolidate' });
  const runs = A.pendingRuns(plan);
  assert(runs.every(r => r.scheduledDate), 'sesiones pendientes con fecha');
  const dates = runs.map(r => r.scheduledDate);
  assert(new Set(dates).size === dates.length, 'no dos corridas el mismo día');
}

console.log('\n=== Simulación 14 días A vs B (UI-flow PaceCoach) ===');
{
  function sim14(label, rpeFn, incompleteAt = []) {
    let plan = freshPlan();
    let logs = [];
    let cursor = '2026-05-01';
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const out = trainOnce(plan, logs, cursor, {
        rpe: rpeFn(i),
        incomplete: incompleteAt.includes(i)
      });
      plan = out.plan; logs = out.logs; cursor = out.cursor;
      if (out.row) rows.push(out.row);
    }
    return rows;
  }
  const aRows = sim14('A', (i) => (i % 2 ? 4 : 3));
  const bRows = sim14('B', () => 8, [1, 3]);
  assert(aRows[0].prescribed === bRows[0].prescribed, '14d misma semilla');
  assert(JSON.stringify(aRows.map(r => r.action)) !== JSON.stringify(bRows.map(r => r.action)), '14d acciones distintas');
  fs.writeFileSync(path.join(root, 'tests/fase2-sim-14d.json'), JSON.stringify({ A: aRows, B: bRows }, null, 2));
  console.log('A sample:', aRows.map(r => `${r.date} ${r.action} → ${r.next}`).join('\n  '));
  console.log('B sample:', bRows.map(r => `${r.date} ${r.action} → ${r.next}`).join('\n  '));
}

console.log('\n=== Regresión Fase 1: RPE 9 reduce, incompleta no progresa ===');
{
  let plan = freshPlan();
  let logs = [];
  let out = trainOnce(plan, logs, '2026-06-01', { rpe: 3 });
  plan = out.plan; logs = out.logs;
  out = trainOnce(plan, logs, out.cursor, { rpe: 9 });
  assert(out.row.action === 'reduce', 'RPE 9 → reduce');
  out = trainOnce(out.plan, out.logs, out.cursor, { rpe: 2, incomplete: true });
  assert(out.row.action === 'repeat', 'incompleta RPE 2 → repeat');
}

if (failed) {
  console.error(`\n${failed} fallos Fase 2`);
  process.exit(1);
}
console.log('\nFase 2: todas las pruebas pasaron.');

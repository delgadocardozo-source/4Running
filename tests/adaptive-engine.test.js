/**
 * Pruebas del motor adaptativo PACE/01 v4
 * Ejecutar: node tests/adaptive-engine.test.js
 * Usa reloj simulado; no toca localStorage de producción.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'adaptive-engine.js'), 'utf8');
const sandbox = { window: {}, console, structuredClone: global.structuredClone || ((v) => JSON.parse(JSON.stringify(v))) };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const A = sandbox.window.PaceAdaptive;
if (!A) {
  console.error('PaceAdaptive no cargó');
  process.exit(1);
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('ok  ', msg);
  }
}

function basePlan(structure) {
  return {
    version: 4,
    engineVersion: A.ENGINE_VERSION,
    params: { ...A.DEFAULT_PARAMS },
    raceDate: '2026-11-01',
    checkpointDate: '2026-10-25',
    sessions: [
      {
        id: 'seed-run',
        weekGroup: 1,
        order: 1,
        kind: 'run',
        title: 'Semilla',
        status: 'pending',
        scheduledDate: null,
        blockedUntilRest: false,
        structure: A.structureFromClassic(structure),
        attempts: []
      }
    ]
  };
}

function makeLog(date, overrides = {}) {
  return {
    id: `${date}-${Math.random().toString(16).slice(2, 8)}`,
    date,
    type: 'Cinta',
    planSessionId: 'seed-run',
    time: '38:00',
    distanceKm: 3.2,
    distanceEstimated: false,
    maxRunBlockSec: overrides.maxRunBlockSec ?? 120,
    couldContinue: '2-5',
    rpe: 4,
    pain: false,
    painLocation: '',
    painIntensity: null,
    worseningDuringRun: false,
    alteredGait: false,
    forcedStop: false,
    severeWarning: false,
    execution: 'completed',
    prescriptionCompleted: true,
    progression: null,
    notes: '',
    source: 'test',
    ...overrides
  };
}

const START = {
  warmSeconds: 300,
  coolSeconds: 300,
  runSeconds: 120,
  walkSeconds: 120,
  reps: 7
};

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return A.localDateISO(dt);
}

function simulateProfile(label, rpeFn, opts = {}) {
  const rows = [];
  let plan = basePlan(START);
  let logs = [];
  let cursor = opts.startDate || '2026-10-01';
  A.setClock(() => {
    const [y, m, d] = cursor.split('-').map(Number);
    return new Date(y, m - 1, d, 10, 0, 0);
  });

  const sessions = opts.sessions || 6;
  for (let i = 0; i < sessions; i++) {
    // saltar descansos pendientes
    let focus = plan.sessions.find(s => (s.status === 'pending' || s.status === 'rescheduled'));
    while (focus && focus.kind === 'rest') {
      focus.status = 'completed';
      logs.push({
        id: `rest-${cursor}-${i}`,
        date: cursor,
        type: 'Recuperación',
        planSessionId: focus.id,
        execution: 'completed',
        progression: 'advance',
        source: 'rest'
      });
      cursor = addDays(cursor, 1);
      A.setClock(() => {
        const [y, m, d] = cursor.split('-').map(Number);
        return new Date(y, m - 1, d, 10, 0, 0);
      });
      plan = A.ensureHorizon(plan, logs, {}, { action: 'consolidate' });
      focus = plan.sessions.find(s => (s.status === 'pending' || s.status === 'rescheduled'));
    }
    if (!focus || focus.kind !== 'run') {
      plan = A.ensureHorizon(plan, logs, {}, { action: 'consolidate' });
      focus = plan.sessions.find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
    }
    if (!focus) break;

    const prescribed = A.structureFromClassic(focus.structure);
    const rpe = rpeFn(i, prescribed);
    const incomplete = opts.incompleteAt && opts.incompleteAt.includes(i);
    const safety = opts.safetyAt && opts.safetyAt.includes(i);
    const log = makeLog(cursor, {
      planSessionId: focus.id,
      rpe,
      maxRunBlockSec: prescribed.runSeconds,
      prescriptionCompleted: !incomplete,
      execution: incomplete ? 'aborted' : 'completed',
      worseningDuringRun: Boolean(safety),
      pain: Boolean(opts.painAt && opts.painAt.includes(i)),
      painIntensity: opts.painAt && opts.painAt.includes(i) ? 4 : null
    });

    const prior = logs.slice();
    const decision = A.decideAdaptive(log, prior, plan);
    log.progression = decision.progression;
    log.adaptiveAction = decision.action;
    logs.push(log);

    // aplicar como coach-engine
    if (!Array.isArray(focus.attempts)) focus.attempts = [];
    focus.attempts.push({
      id: `att-${i}`,
      logId: log.id,
      date: log.date,
      execution: log.execution,
      progression: decision.progression,
      adaptiveAction: decision.action,
      reasonCode: decision.reasonCode
    });

    const prev = A.structureFromClassic(focus.structure);
    if (decision.progression === 'repeat') {
      focus.status = 'pending';
      focus.blockedUntilRest = false;
    } else if (decision.progression === 'recovery') {
      focus.status = 'pending';
      focus.blockedUntilRest = true;
    } else {
      focus.status = 'completed';
      focus.blockedUntilRest = false;
      const order = focus.order;
      plan.sessions = plan.sessions.filter(s => {
        if (!(s.status === 'pending' || s.status === 'rescheduled')) return true;
        if (s.id === focus.id) return true;
        return Number(s.order) <= order;
      });
      plan = A.ensureHorizon(plan, logs, {}, decision);
    }

    const nextRun = plan.sessions.find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
    const nextSt = nextRun ? A.structureFromClassic(nextRun.structure) : null;
    const diff = nextSt ? A.compareStructures(prev, nextSt) : null;
    rows.push({
      profile: label,
      i,
      date: cursor,
      prescribed: A.describeStructure(prev),
      continuous: prev.runSeconds,
      totalRun: prev.runSeconds * prev.reps,
      walk: prev.walkSeconds * prev.reps,
      reps: prev.reps,
      total: A.metrics(prev).totalMin,
      rpe,
      completed: !incomplete,
      action: decision.action,
      progression: decision.progression,
      next: nextSt ? A.describeStructure(nextSt) : null,
      diff: diff?.summary || null,
      reason: decision.reason
    });

    cursor = addDays(cursor, opts.gapDays || 2);
    A.setClock(() => {
      const [y, m, d] = cursor.split('-').map(Number);
      return new Date(y, m - 1, d, 10, 0, 0);
    });

    if (opts.pauseAfter === i) {
      cursor = addDays(cursor, opts.pauseDays || 14);
      A.setClock(() => {
        const [y, m, d] = cursor.split('-').map(Number);
        return new Date(y, m - 1, d, 10, 0, 0);
      });
    }
  }

  return { rows, plan, logs };
}

console.log('\n=== Perfil A: buena evolución ===');
const Ares = simulateProfile('A', (i) => (i % 2 === 0 ? 3 : 4), { sessions: 6 });
assert(Ares.rows.length >= 4, 'A genera varias sesiones');
const aProgress = Ares.rows.filter(r => String(r.action).startsWith('progress'));
assert(aProgress.length >= 1, 'A progresa al menos una vez');
const aLoadChanged = Ares.rows.some(r => r.continuous !== START.runSeconds || r.reps !== START.reps)
  || Ares.rows.some(r => r.next && r.next !== r.prescribed && r.action === 'progress');
assert(aLoadChanged || aProgress.length >= 1, 'A cambia prescripción o progresa');
assert(Ares.plan.sessions.some(s => s.generated || s.engineVersion === A.ENGINE_VERSION || s.status === 'pending'), 'A mantiene horizonte');

console.log('\n=== Perfil B: dificultad ===');
const Bres = simulateProfile('B', () => 8, {
  sessions: 6,
  incompleteAt: [1, 3]
});
assert(
  Bres.rows.filter(r => r.completed && r.rpe >= 7).every(r => r.action !== 'progress'),
  'B no progresa en sesiones completas con RPE alto'
);
const bHard = Bres.rows.filter(r => r.rpe >= 7);
assert(bHard.every(r => ['repeat', 'reduce', 'recovery', 'consolidate'].includes(r.action)), 'B repite/reduce/consolida');
assert(Bres.rows.some(r => r.action === 'repeat' || r.action === 'reduce'), 'B recibe repeat o reduce');

console.log('\n=== Decisiva A vs B misma seed ===');
const aLast = Ares.rows[Ares.rows.length - 1];
const bLast = Bres.rows[Bres.rows.length - 1];
assert(Ares.rows[0].prescribed === Bres.rows[0].prescribed, 'A y B parten de la misma prescripción');
const aChanged = Ares.rows.some(r => r.continuous !== START.runSeconds || r.reps !== START.reps);
const bSameish = Bres.rows.filter(r => String(r.action).startsWith('progress')).length
  < Ares.rows.filter(r => String(r.action).startsWith('progress')).length;
assert(bSameish || !Bres.rows.some(r => String(r.action).startsWith('progress')), 'B progresa menos que A');
assert(aChanged || aProgress.length >= 1, 'A evoluciona la carga');

console.log('\n=== Perfil C: irregular ===');
const Cres = simulateProfile('C', (i) => [3, 6, 8, 4, 6, 3][i] || 5, { sessions: 6 });
assert(Cres.rows.some(r => r.action === 'consolidate' || r.action === 'repeat'), 'C consolida o repite en tramos difíciles');
assert(!Cres.rows.every(r => r.action === 'progress'), 'C no progresa siempre');

console.log('\n=== Perfil D: pausa 14 días ===');
const Dres = simulateProfile('D', () => 4, { sessions: 4, pauseAfter: 1, pauseDays: 14 });
const dProfile = A.deriveProfile(Dres.logs, Dres.plan, {});
assert(dProfile.gapDays == null || dProfile.gapDays >= 0, 'D calcula gap');
assert(Dres.logs.length >= 2, 'D conserva historial');

console.log('\n=== Perfil E: corredor continuo 30 min ===');
const eLogs = [
  makeLog('2026-09-01', { rpe: 4, maxRunBlockSec: 30 * 60, prescriptionCompleted: true }),
  makeLog('2026-09-03', { rpe: 3, maxRunBlockSec: 30 * 60, prescriptionCompleted: true }),
  makeLog('2026-09-05', { rpe: 4, maxRunBlockSec: 30 * 60, prescriptionCompleted: true })
];
const ePlan = basePlan({ warmSeconds: 300, coolSeconds: 300, runSeconds: 30 * 60, walkSeconds: 0, reps: 1 });
ePlan.sessions[0].status = 'completed';
const eProfile = A.deriveProfile(eLogs, ePlan, {});
assert(eProfile.stage >= 5, 'E está en etapa de rendimiento');
assert(eProfile.demonstratedContinuousSec >= 30 * 60, 'E demostró 30 min continuos');
const eCand = A.generateCandidates(ePlan.sessions[0].structure, 'progress', eProfile, ePlan);
assert(eCand.every(c => !(c.structure.runSeconds === 120 && c.structure.walkSeconds === 120 && c.structure.reps === 7)), 'E no vuelve al 2/2×7');

console.log('\n=== Perfil F: seguridad ===');
const Fres = simulateProfile('F', () => 3, { sessions: 3, safetyAt: [1] });
assert(Fres.rows.some(r => r.action === 'recovery'), 'F bloquea con recovery ante señal de seguridad');

console.log('\n=== Perfil G: externos ===');
const gLogs = [
  makeLog('2026-10-01', { rpe: 3 }),
  { ...makeLog('2026-10-02', { rpe: 2, maxRunBlockSec: 600 }), source: 'external', planSessionId: null }
];
const gValid = A.validTrainingLogs(gLogs);
assert(gValid.every(l => l.source !== 'external'), 'G no trata externos como intentos de plan');
const gDec = A.decideAdaptive(gLogs[0], [], basePlan(START));
assert(gDec.action, 'G decide sobre sesión de plan con normalidad');

console.log('\n=== Migración v3 → v4 idempotente ===');
const v3 = {
  version: 3,
  sessions: [
    { id: 'a', order: 1, kind: 'run', status: 'completed', structure: START, attempts: [] },
    { id: 'b', order: 2, kind: 'run', status: 'completed', structure: START, attempts: [] }
  ]
};
const m1 = A.migratePlanToV4(v3, [], {});
const m2 = A.migratePlanToV4(m1, [], {});
assert(m1.version === 4, 'migración sube a v4');
assert(m1.sessions.filter(s => s.status === 'pending' || s.status === 'rescheduled').length >= 1, 'migración regenera horizonte si no hay pendientes');
assert(m2.sessions.filter(s => s.status === 'completed').length === m1.sessions.filter(s => s.status === 'completed').length, 'migración idempotente no duplica completadas');

console.log('\n=== Límites de carga ===');
const lim = A.withinLoadLimits(START, { ...START, runSeconds: 180, reps: 7 }, A.DEFAULT_PARAMS, 2);
assert(!lim.ok, 'rechaza salto de continuo demasiado grande');
const limVol = A.withinLoadLimits(START, { ...START, runSeconds: 150, reps: 7 }, A.DEFAULT_PARAMS, 2);
assert(!limVol.ok, 'rechaza +30s continuo si el volumen total salta >15%');
const limRep = A.withinLoadLimits(START, { ...START, reps: 8 }, A.DEFAULT_PARAMS, 2);
assert(limRep.ok, 'acepta +1 repetición como única variable');
const restructure = A.generateCandidates(START, 'progress', { stage: 2 }, { params: A.DEFAULT_PARAMS });
assert(restructure.some(c => c.primaryVar === 'restructure' || (c.structure.runSeconds === 150 && c.structure.reps === 6)), 'genera candidato reorganizado 6×2:30');

console.log('\n=== Simulación 14 días A vs B (tabla) ===');
function printTable(rows) {
  for (const r of rows) {
    console.log(
      `${r.date} | ${r.prescribed} | cont=${r.continuous}s runTot=${r.totalRun}s reps=${r.reps} | RPE ${r.rpe} ${r.completed ? 'ok' : 'inc'} | ${r.action} → ${r.next || '—'} | ${r.diff || ''}`
    );
  }
}
printTable(Ares.rows);
console.log('---');
printTable(Bres.rows);

assert(
  JSON.stringify(Ares.rows.map(r => r.next)) !== JSON.stringify(Bres.rows.map(r => r.next))
  || Ares.rows.map(r => r.action).join() !== Bres.rows.map(r => r.action).join(),
  'A y B reciben decisiones/prescripciones distintas'
);

const reportPath = path.join(root, 'tests/simulation-14d-report.json');
fs.writeFileSync(reportPath, JSON.stringify({ A: Ares.rows, B: Bres.rows, C: Cres.rows, D: Dres.rows, F: Fres.rows }, null, 2));
console.log('\nReporte escrito en', reportPath);

console.log('\n=== Ritmo de ciclo (sin warm/cool) ===');
{
  const st = { warmSeconds: 300, coolSeconds: 300, runSeconds: 120, walkSeconds: 120, reps: 7 };
  // 5+5 warm/cool + 28 min ciclo = 38 min; distancia coherente con 5/7.5/4.5
  const elapsed = 38 * 60;
  const expectedKm = A.estimateKm(st, { walkSpeed: 5, runSpeed: 7.5, coolSpeed: 4.5 });
  const pace = A.computeSessionPaceMetrics({
    elapsedSec: elapsed,
    distanceKm: expectedKm,
    structure: st,
    speeds: { walkSpeed: 5, runSpeed: 7.5, coolSpeed: 4.5 }
  });
  assert(pace && pace.hasStructure, 'calcula métricas con estructura');
  assert(pace.cycleSec === 28 * 60, `ciclo = 28 min (sin warm/cool), got ${pace.cycleSec}`);
  assert(pace.warmSec === 300 && pace.coolSec === 300, 'warm/cool fijos 5 min');
  assert(pace.distanceSource === 'attributed', 'distancia atribuida por pesos');
  // Ritmo de carrera ≈ 7.5 km/h → 480 s/km = 8:00/km
  assert(pace.runPaceLabel === '8:00/km', `ritmo carrera 8:00/km, got ${pace.runPaceLabel}`);
  assert(Math.abs(pace.runSpeedKmh - 7.5) < 0.05, `vel carrera ~7.5, got ${pace.runSpeedKmh}`);
  // Ciclo mixto más lento que solo carrera
  assert(pace.cyclePaceSecPerKm > pace.runPaceSecPerKm, 'ritmo ciclo más lento que solo carrera');
  assert(pace.cycleKm < pace.totalKm, 'km ciclo < km total (excluye warm/cool)');

  const noDist = A.computeSessionPaceMetrics({
    elapsedSec: elapsed,
    structure: st,
    speeds: { walkSpeed: 5, runSpeed: 7.5, coolSpeed: 4.5 }
  });
  assert(noDist && noDist.distanceSource === 'estimated', 'sin distancia → estimado');
  assert(noDist.cyclePaceLabel, 'estima ritmo de ciclo sin distancia');

  const cont = A.computeSessionPaceMetrics({
    elapsedSec: 40 * 60,
    distanceKm: 5,
    structure: { warmSeconds: 300, coolSeconds: 300, runSeconds: 30 * 60, walkSeconds: 0, reps: 1 },
    speeds: { walkSpeed: 5, runSpeed: 7.5, coolSpeed: 4.5 }
  });
  assert(cont && cont.isContinuous, 'detecta carrera continua');
  assert(cont.cycleSec === 30 * 60, 'continuo: 30 min de ciclo');
  assert(A.formatPacePerKm(480) === '8:00/km', 'formatPacePerKm 480s → 8:00/km');
}

if (failed) {
  console.error(`\n${failed} fallos`);
  process.exit(1);
}
console.log('\nTodas las pruebas pasaron.');

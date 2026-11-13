(() => {
  const PLAN_KEY = 'pace01.plan.v3';
  const LOGS_KEY = 'pace01.logs.v3';
  const LEGACY_PLAN_V2 = 'pace01.plan.v2';
  const LEGACY_LOGS_V2 = 'pace01.logs.v2';
  const LEGACY_SESSIONS = 'pace01.sessions.v1';

  function clone(value) {
    return structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function emptyAttempts() {
    return [];
  }

  /** Plan vacío para usuario nuevo (requiere onboarding). */
  function buildDefaultPlan() {
    return {
      version: 4,
      onboardingCompleted: false,
      raceDate: null,
      checkpointDate: null,
      goal: null,
      intake: null,
      loadPolicy: 'Una variable de carga principal por progresión: duración/volumen primero, velocidad después.',
      fiveKDefinition: 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).',
      sessions: []
    };
  }

  /** Datos de demostración (opcional desde Ajustes). No se cargan solos. */
  function buildDemoLogs() {
    return [
      {
        id: '2026-10-12-outdoor', date: '2026-10-12', type: 'Exterior', planSessionId: 'w1-s1',
        time: null, distanceKm: null, distanceEstimated: false, maxRunBlockSec: 60,
        couldContinue: null, rpe: null, pain: false, painLocation: '', painIntensity: null,
        worseningDuringRun: false, alteredGait: false, forcedStop: false, severeWarning: false,
        execution: 'completed', progression: 'advance',
        notes: 'Semana 1 · Sesión 1. Datos parciales.', source: 'seed'
      },
      {
        id: '2026-10-13-outdoor', date: '2026-10-13', type: 'Exterior', planSessionId: 'w1-s2',
        time: null, distanceKm: null, distanceEstimated: false, maxRunBlockSec: 60,
        couldContinue: null, rpe: null, pain: false, painLocation: '', painIntensity: null,
        worseningDuringRun: false, alteredGait: false, forcedStop: false, severeWarning: false,
        execution: 'completed', progression: 'advance',
        notes: 'Semana 1 · Sesión 2. Datos parciales.', source: 'seed'
      },
      {
        id: '2026-10-14-treadmill', date: '2026-10-14', type: 'Cinta', planSessionId: 'w1-s3',
        time: '32:58', distanceKm: 2.99, distanceEstimated: false, maxRunBlockSec: 60,
        couldContinue: '2-5', rpe: 4, pain: true,
        painLocation: 'Lumbar leve al inicio; desapareció al entrar en calor',
        painIntensity: 2,
        worseningDuringRun: false, alteredGait: false, forcedStop: false, severeWarning: false,
        execution: 'completed', progression: 'advance',
        notes: 'Caminata 5,0 km/h. Carrera progresiva: 7,0 → 7,5 → 8,5 km/h.',
        source: 'seed'
      },
      {
        id: '2026-10-15-rest', date: '2026-10-15', type: 'Recuperación', planSessionId: 'w1-rest',
        time: null, distanceKm: null, distanceEstimated: false, maxRunBlockSec: null,
        couldContinue: null, rpe: null, pain: false, painLocation: '', painIntensity: null,
        worseningDuringRun: false, alteredGait: false, forcedStop: false, severeWarning: false,
        execution: 'completed', progression: 'advance',
        notes: 'Recuperación registrada.', source: 'seed'
      }
    ];
  }

  function buildDemoPlan() {
    return {
      version: 3,
      onboardingCompleted: true,
      raceDate: '2026-11-01',
      checkpointDate: '2026-10-25',
      goal: {
        type: '5k_finish_runwalk',
        label: 'Completar 5K (run/walk)',
        raceDate: '2026-11-01',
        checkpointDate: '2026-10-25'
      },
      intake: {
        goalType: '5k_finish_runwalk',
        continuousAbility: '1min',
        sessionsPerWeek: 3,
        environment: 'both',
        hasPain: false,
        intakeStage: 2,
        declaredContinuousSec: 90,
        completedAt: '2026-10-12'
      },
      loadPolicy: 'Una variable de carga principal por progresión: duración/volumen primero, velocidad después.',
      fiveKDefinition: 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).',
      sessions: [
        {
          id: 'w1-s1', weekGroup: 1, order: 1, kind: 'run',
          title: 'Semana 1 · Sesión 1', status: 'completed', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 60, walkSeconds: 120, coolSeconds: 300, reps: 6 },
          attempts: [{ id: 'att-w1s1', logId: '2026-10-12-outdoor', date: '2026-10-12', execution: 'completed', progression: 'advance', rpe: null, pain: false }]
        },
        {
          id: 'w1-s2', weekGroup: 1, order: 2, kind: 'run',
          title: 'Semana 1 · Sesión 2', status: 'completed', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 90, walkSeconds: 120, coolSeconds: 300, reps: 6 },
          attempts: [{ id: 'att-w1s2', logId: '2026-10-13-outdoor', date: '2026-10-13', execution: 'completed', progression: 'advance', rpe: null, pain: false }]
        },
        {
          id: 'w1-s3', weekGroup: 1, order: 3, kind: 'run',
          title: 'Semana 1 · Sesión 3', status: 'completed', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 5 },
          attempts: [{ id: 'att-w1s3', logId: '2026-10-14-treadmill', date: '2026-10-14', execution: 'completed', progression: 'advance', rpe: 4, pain: true }]
        },
        {
          id: 'w1-rest', weekGroup: 1, order: 4, kind: 'rest',
          title: 'Recuperación', status: 'completed', scheduledDate: null, blockedUntilRest: false,
          structure: { rest: true, note: 'Descanso activo o quietud. Cuenta como sesión válida.' },
          attempts: [{ id: 'att-w1rest', logId: '2026-10-15-rest', date: '2026-10-15', execution: 'completed', progression: 'advance', rpe: null, pain: false }]
        },
        {
          id: 'w2-s1', weekGroup: 2, order: 5, kind: 'run',
          title: 'Semana 2 · Sesión 1', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 7 },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-rest-a', weekGroup: 2, order: 6, kind: 'rest',
          title: 'Recuperación', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { rest: true, note: 'Priorizá dormir y movilidad suave. No es un hueco del plan.' },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-s2', weekGroup: 2, order: 7, kind: 'run',
          title: 'Semana 2 · Sesión 2', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 7 },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-rest-b', weekGroup: 2, order: 8, kind: 'rest',
          title: 'Recuperación', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { rest: true, note: 'Recuperación entre estímulos. La progresión espera.' },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-s3', weekGroup: 2, order: 9, kind: 'run',
          title: 'Semana 2 · Sesión 3', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 8 },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-rest-c', weekGroup: 2, order: 10, kind: 'rest',
          title: 'Recuperación', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { rest: true, note: 'Antes del checkpoint: llegar fresco, no forzado.' },
          attempts: emptyAttempts()
        }
      ]
    };
  }

  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.sessions)) return buildDefaultPlan();
    if (!plan.version) plan.version = 3;
    plan.fiveKDefinition = plan.fiveKDefinition
      || 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).';
    if (plan.onboardingCompleted == null) {
      plan.onboardingCompleted = plan.sessions.some(s => s.kind === 'run');
    }
    plan.sessions = plan.sessions.map(s => ({
      scheduledDate: null,
      blockedUntilRest: false,
      attempts: [],
      ...s,
      attempts: Array.isArray(s.attempts) ? s.attempts : []
    }));
    return plan;
  }

  function needsOnboarding(plan) {
    if (!plan) return true;
    if (plan.onboardingCompleted === false) return true;
    const hasRun = (plan.sessions || []).some(s => s.kind === 'run');
    return !hasRun;
  }

  function applyIntake(intake, settings = {}) {
    if (!window.PaceAdaptive?.buildPlanFromIntake) {
      throw new Error('Motor adaptativo no disponible para onboarding');
    }
    const previous = loadPlan();
    const plan = window.PaceAdaptive.buildPlanFromIntake(intake, settings);
    const kept = (previous.sessions || []).filter(s => (s.attempts || []).length || s.status === 'completed').map(s => ({ ...s, status: ['pending', 'rescheduled'].includes(s.status) ? 'archived' : s.status }));
    const maxOrder = Math.max(0, ...kept.map(s => Number(s.order) || 0));
    if ((previous.sessions || []).some(s => s.blockedUntilRest)) plan.sessions[0].blockedUntilRest = true;
    plan.sessions = [...kept, ...plan.sessions.map((s, i) => ({ ...s, id: `${s.id}-intake-${Date.now()}-${i}`, order: maxOrder + i + 1 }))];
    savePlan(plan);
    if (!localStorage.getItem(LOGS_KEY)) saveLogs([]);
    return plan;
  }

  function updatePlanPreferences(plan, prefs = {}, logs = [], settings = {}) {
    const next = clone(plan || buildDefaultPlan());
    const A = window.PaceAdaptive;
    if (prefs.goalType && A?.GOAL_CATALOG?.[prefs.goalType]) {
      const g = A.GOAL_CATALOG[prefs.goalType];
      next.goal = {
        ...(next.goal || {}),
        type: g.type,
        label: g.label,
        raceDate: prefs.raceDate || next.goal?.raceDate || next.raceDate || null,
        checkpointDate: next.goal?.checkpointDate || next.checkpointDate || null
      };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(prefs.raceDate || ''))) {
      next.raceDate = prefs.raceDate;
      if (next.goal) next.goal.raceDate = prefs.raceDate;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(prefs.checkpointDate || ''))) {
      next.checkpointDate = prefs.checkpointDate;
      if (next.goal) next.goal.checkpointDate = prefs.checkpointDate;
    }
    const spw = Number(prefs.sessionsPerWeek);
    if (Number.isFinite(spw) && spw >= 2 && spw <= 4) {
      next.params = { ...(next.params || {}), sessionsPerWeek: spw, beginnerSessionsPerWeek: spw };
    }
    if (next.intake && prefs.goalType) next.intake.goalType = prefs.goalType;
    next.athleteProfile = A ? A.deriveProfile(logs, next, settings) : next.athleteProfile;
    if (A && next.onboardingCompleted) {
      return A.ensureHorizon(next, logs, settings, null);
    }
    return next;
  }

  function recalibrateFocus(plan, logs, settings, direction) {
    if (!window.PaceAdaptive?.recalibrateLoad) {
      return { plan, changed: false, message: 'Recalibración no disponible.' };
    }
    const out = window.PaceAdaptive.recalibrateLoad(plan, logs, settings, direction);
    if (out.plan) savePlan(out.plan);
    return out;
  }

  function undoRecalibrateFocus(plan, settings = {}) {
    if (!window.PaceAdaptive?.undoRecalibration) {
      return { plan, changed: false, message: 'Deshacer no disponible.' };
    }
    const out = window.PaceAdaptive.undoRecalibration(plan, settings);
    if (out.plan) savePlan(out.plan);
    return out;
  }

  function canUndoRecalibration(plan) {
    const snap = plan?.lastRecalibration;
    return Boolean(snap && !snap.undone && snap.previousStructure && snap.sessionId);
  }

  function restoreFocusFromProfile(plan, logs, settings) {
    if (!window.PaceAdaptive?.restoreFocusSession) {
      return { plan, changed: false, message: 'Restablecer no disponible.' };
    }
    const out = window.PaceAdaptive.restoreFocusSession(plan, logs, settings);
    if (out.plan) savePlan(out.plan);
    return out;
  }

  function refreshStaleFocusDates(plan) {
    if (!window.PaceAdaptive || !plan) return plan;
    const before = JSON.stringify((plan.sessions || []).map(s => s.scheduledDate));
    window.PaceAdaptive.allocateScheduleDates(plan, window.PaceAdaptive.paramsOf(plan));
    if (before !== JSON.stringify((plan.sessions || []).map(s => s.scheduledDate))) savePlan(plan);
    return plan;
  }

  function loadDemoData(settings = {}) {
    let plan = normalizePlan(buildDemoPlan());
    const logs = buildDemoLogs();
    plan = upgradePlanAdaptive(plan, logs);
    savePlan(plan);
    saveLogs(logs);
    return { plan, logs };
  }

  function resetToOnboarding() {
    const plan = buildDefaultPlan();
    savePlan(plan);
    saveLogs([]);
    return { plan, logs: [] };
  }

  function loadSettingsSoft() {
    try {
      return JSON.parse(localStorage.getItem('pace01.settings.v1') || '{}') || {};
    } catch {
      return {};
    }
  }

  function upgradePlanAdaptive(plan, logs) {
    if (!window.PaceAdaptive) return plan;
    return window.PaceAdaptive.migratePlanToV4(plan, logs || [], loadSettingsSoft());
  }

  /** Tras completar un estímulo, regenera el horizonte pendiente (no reescribe historial). */
  function regenerateHorizonAfterAdvance(plan, completedItem, decision, allLogs) {
    if (!window.PaceAdaptive) return plan;
    const A = window.PaceAdaptive;
    const order = Number(completedItem?.order) || 0;
    plan.sessions = (plan.sessions || []).filter(s => {
      if (!isOpenStatus(s.status)) return true;
      if (s.id === completedItem?.id) return true;
      return Number(s.order) <= order;
    });
    // El ítem avanzado ya está completed; no debe quedar abierto
    const done = plan.sessions.find(s => s.id === completedItem?.id);
    if (done) {
      done.status = 'completed';
      done.blockedUntilRest = false;
    }
    return A.ensureHorizon(plan, allLogs || [], loadSettingsSoft(), decision);
  }

  function migrateLegacyLogs() {
    const tryKeys = [LEGACY_LOGS_V2, LEGACY_SESSIONS];
    for (const key of tryKeys) {
      try {
        const legacy = JSON.parse(localStorage.getItem(key) || 'null');
        if (!Array.isArray(legacy) || !legacy.length) continue;
        if (key === LEGACY_SESSIONS) {
          return legacy.map((s, i) => ({
            id: s.id || `legacy-${i}`,
            date: s.date,
            type: s.type || 'Exterior',
            planSessionId: null,
            time: s.time || null,
            distanceKm: typeof s.distance === 'number' ? s.distance : null,
            distanceEstimated: false,
            maxRunBlockSec: s.continuous != null ? Number(s.continuous) * 60 : null,
            couldContinue: null,
            rpe: s.rpe == null ? null : Number(s.rpe),
            pain: Boolean(s.pain && String(s.pain).trim()),
            painLocation: s.pain && String(s.pain).trim() ? String(s.pain).trim() : '',
            painIntensity: null,
            worseningDuringRun: false,
            alteredGait: false,
            forcedStop: false,
            severeWarning: false,
            execution: 'completed',
            progression: null,
            notes: s.notes || '',
            source: 'legacy'
          }));
        }
        return legacy.map(s => ({
          worseningDuringRun: false,
          alteredGait: false,
          forcedStop: false,
          severeWarning: false,
          execution: s.execution || 'completed',
          progression: s.progression || null,
          ...s
        }));
      } catch { /* next */ }
    }
    return null;
  }

  function loadLogs() {
    try {
      const stored = JSON.parse(localStorage.getItem(LOGS_KEY) || 'null');
      if (Array.isArray(stored)) return stored;
    } catch { /* ignore */ }
    const migrated = migrateLegacyLogs();
    if (migrated) {
      localStorage.setItem(LOGS_KEY, JSON.stringify(migrated));
      return migrated;
    }
    // Usuario nuevo: historial vacío (sin seed de demo).
    localStorage.setItem(LOGS_KEY, '[]');
    return [];
  }

  function saveLogs(logs) {
    let cached = [];
    try { cached = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]'); } catch { /* keep the supplied records */ }
    const byId = new Map([...(Array.isArray(cached) ? cached : []), ...(logs || [])].filter(log => log && log.id).map(log => [log.id, log]));
    localStorage.setItem(LOGS_KEY, JSON.stringify([...byId.values()]));
  }

  /** Corrige un log ya guardado (no reescribe la progresión del plan). */
  function reviewFutureAfterCorrection(plan, logs, corrected, settings = {}) {
    const next = clone(plan);
    const A = window.PaceAdaptive;
    const valid = A.validTrainingLogs(logs);
    const latest = valid[0];
    if (!latest) return { plan: next, changed: false, message: 'Registro corregido; no hay entrenamiento del plan para revisar.' };
    const prior = valid.filter(log => log.id !== latest.id);
    let decision = A.decideAdaptive(latest, prior, next);
    if (A.evidenceForLog(corrected).errors.length && decision.progression !== 'recovery') decision = { ...decision, action: 'repeat', progression: 'repeat', reason: 'Un dato corregido requiere confirmación. Mantenemos provisionalmente la próxima carga.' };
    if ((corrected.worseningDuringRun || corrected.alteredGait || corrected.forcedStop || corrected.severeWarning || corrected.pain && Number(corrected.painIntensity) >= 3) && decision.progression !== 'recovery') decision = { ...decision, action: 'recovery', progression: 'recovery', reason: 'La corrección registra una señal de seguridad: revisá la molestia antes de volver a correr.' };
    const baseItem = next.sessions.find(s => s.id === latest.planSessionId);
    const baseline = latest.prescriptionSnapshot?.structure || latest.prescriptionSnapshot || baseItem?.structure;
    const pending = sortedPlanSessions(next).filter(s => s.kind === 'run' && ['pending', 'rescheduled'].includes(s.status));
    let changed = false;
    for (const item of pending) {
      if ((item.attempts || []).length) {
        if (decision.progression === 'recovery') item.blockedUntilRest = true;
        if (decision.progression !== 'advance') continue;
        item.status = 'archived';
        const replacement = A.makeRunItem(next, item.structure, { title: 'Próxima sesión revisada', justification: decision.reason });
        replacement.id += '-correction'; next.sessions.push(replacement); pending.push(replacement);
        continue; // Preserve every prescription already attempted.
      }
      const before = clone(item.structure);
      let chosen = baseline || before;
      if (decision.progression === 'advance') chosen = A.pickCandidate(A.generateCandidates(chosen, decision.action, A.deriveProfile(logs, next, settings), next), decision.action)?.structure || chosen;
      chosen = A.constrainPrescription(chosen, next, before);
      item.structure = clone(chosen);
      item.blockedUntilRest = item.blockedUntilRest || decision.progression === 'recovery';
      item.justification = decision.reason;
      item.decisionAction = decision.action;
      item.changeSummary = A.compareStructures(before, chosen);
      const metrics = A.metrics(chosen);
      item.prescribedContinuousSec = metrics.continuousSec;
      item.prescribedTotalRunSec = metrics.totalRunSec;
      item.estimatedDurationMin = metrics.totalMin;
      item.estimatedKm = A.estimateKm(chosen, settings);
      changed = true;
    }
    if (!pending.length) A.ensureHorizon(next, logs, settings, decision);
    next.futureReview = { at: new Date().toISOString(), correctedLogId: corrected.id, action: decision.action, reason: decision.reason };
    A.allocateScheduleDates(next, A.paramsOf(next));
    return { plan: next, changed, action: decision.action, message: decision.reason };
  }

  function updateStoredLog(logs, logId, patch = {}, context = {}) {
    const next = clone(logs || []);
    const idx = next.findIndex(log => log.id === logId);
    if (idx < 0) return { logs: next, updated: null, ok: false, error: 'No se encontró el registro.' };
    const prev = next[idx];
    const allowed = ['time', 'elapsedSec', 'distanceKm', 'distanceEstimated', 'rpe', 'pain', 'painLocation', 'painIntensity', 'notes', 'couldContinue', 'maxRunBlockSec', 'type', 'environment', 'paceMetrics', 'worseningDuringRun', 'alteredGait', 'forcedStop', 'severeWarning', 'talkTest'];
    const cleaned = Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(patch, key)).map(key => [key, patch[key]]));
    for (const [key, min, max] of [['rpe', 0, 10], ['maxRunBlockSec', 0, 14400], ['distanceKm', 0, 1000], ['elapsedSec', 1, 86400]]) {
      const value = cleaned[key];
      if (value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)) return { logs: next, updated: null, ok: false, error: 'El valor corregido está fuera de rango.' };
    }
    const now = new Date().toISOString();
    const originalDecision = prev.originalDecision || { action: prev.action, adaptiveAction: prev.adaptiveAction, progression: prev.progression, reason: prev.decisionReason, reasonCode: clone(prev.reasonCode || []), at: prev.createdAt || null };
    next[idx] = { ...prev, ...cleaned, id: prev.id, date: prev.date, planSessionId: prev.planSessionId, createdAt: prev.createdAt, originalDecision, editHistory: [...(prev.editHistory || []), { at: now, before: Object.fromEntries(Object.keys(cleaned).map(key => [key, prev[key]])), after: clone(cleaned) }], editedAt: now, updatedAt: now };
    const plan = context.plan || loadPlan();
    const review = reviewFutureAfterCorrection(plan, next, next[idx], context.settings || loadSettingsSoft());
    saveLogs(next);
    savePlan(review.plan);
    return { logs: next, updated: next[idx], plan: review.plan, review, ok: true };
  }

  function requestWalkToJog(plan, logs = [], settings = {}, { confirmed = false } = {}) {
    const next = clone(plan);
    const focus = getFocusSession(next);
    const run = getUnderlyingPlanItem(next, focus);
    const latest = window.PaceAdaptive.validTrainingLogs(logs)[0];
    const A = window.PaceAdaptive;
    const eligible = focus?.kind === 'run' && run?.structure?.runSeconds === 0 && !run.blockedUntilRest && latest && A.observedCompletion(latest) && A.evidenceForLog(latest).sufficient && Number(latest.maxRunBlockSec) === 0 && Number(latest.rpe) <= 5 && latest.talkTest === 'yes' && !latest.pain && !latest.worseningDuringRun && !latest.alteredGait && !latest.forcedStop && !latest.severeWarning && (A.metrics(run.structure).totalSec <= 0 || (latest.walkSeconds || A.durationOfLog?.(latest) || 0) >= 600);
    if (!eligible) return { plan: next, eligible: false, changed: false, message: 'Primero completá una caminata cómoda, sin molestias y pudiendo conversar. Si hay síntomas, mantené la pausa.' };
    const base = run.structure;
    const preview = A.structureFromClassic({ warmSeconds: 300, coolSeconds: 300, runSeconds: 30, walkSeconds: 90, reps: 4 });
    const budget = (Number(next.intake?.availableMinutes) || 30) * 60;
    preview.reps = Math.max(1, Math.min(preview.reps, Math.floor(Math.max(0, budget - 600) / 120)));
    if (A.metrics(preview).totalSec > budget) return { plan: next, eligible: false, changed: false, message: 'Necesitamos al menos tiempo suficiente para una prueba corta con calentamiento y calma.' };
    if (!confirmed) return { plan: next, eligible: true, changed: false, preview, message: `Podés probar ${A.describeStructure(preview)}. Elegirlo es opcional; tu caminata y sus intentos se conservan.` };
    const at = new Date().toISOString();
    if ((run.attempts || []).length) run.status = 'archived';
    else run.status = 'superseded';
    for (const item of next.sessions) if (['pending', 'rescheduled'].includes(item.status) && !(item.attempts || []).length) item.status = 'superseded';
    const candidate = A.makeRunItem(next, preview, { title: 'Evaluación opcional · primer trote corto', justification: 'Elegiste probar un trote corto después de una caminata cómoda, sin molestias y pudiendo conversar.', scheduledDate: A.addDaysISO(latest.date, 2) });
    candidate.id += '-walk-to-jog'; candidate.isAssessment = true;
    next.sessions.push(candidate);
    next.walkToJogAcceptedAt = at;
    next.intake = { ...(next.intake || {}), assessment: 'jog', continuousAbility: 'none', walkTolerance: '15', hasPain: false };
    A.ensureHorizon(next, logs, settings, { action: 'consolidate', reason: 'Primera prueba de trote elegida por vos; no se presupone capacidad de carrera.' });
    savePlan(next);
    return { plan: next, eligible: true, changed: true, next: candidate, preview, message: 'Prueba corta elegida. Conservamos tus caminatas y la próxima se adapta a lo que observes.' };
  }

  function loadPlan() {
    let plan = null;
    try {
      const stored = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
      if (stored && Array.isArray(stored.sessions) && stored.sessions.length) {
        plan = normalizePlan(stored);
      }
    } catch { /* ignore */ }
    if (!plan) {
      try {
        const v2 = JSON.parse(localStorage.getItem(LEGACY_PLAN_V2) || 'null');
        if (v2 && Array.isArray(v2.sessions)) {
          plan = normalizePlan(v2);
        }
      } catch { /* ignore */ }
    }
    if (!plan) plan = buildDefaultPlan();
    let logs = [];
    try {
      logs = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]') || [];
    } catch { logs = []; }
    plan = upgradePlanAdaptive(plan, logs);
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    return plan;
  }

  function savePlan(plan) {
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  }

  function sortedPlanSessions(plan) {
    return [...plan.sessions].sort((a, b) => a.order - b.order);
  }

  function isOpenStatus(status) {
    return status === 'pending' || status === 'rescheduled';
  }

  function getFocusSession(plan) {
    const open = sortedPlanSessions(plan).find(s => isOpenStatus(s.status));
    if (!open) return null;
    if (open.blockedUntilRest) {
      return {
        id: `rest-gate:${open.id}`,
        planItemId: open.id,
        weekGroup: open.weekGroup,
        order: open.order,
        kind: 'rest',
        title: 'Recuperación (antes de volver a la misma sesión)',
        status: 'pending',
        gateForId: open.id,
        structure: {
          rest: true,
          note: (open.attempts || []).length ? 'Guardamos el intento. Mantené la pausa hasta que la molestia deje de limitarte; no alcanza con marcar un día de descanso.' : 'Evaluación pospuesta por molestia limitante. Mantené la pausa y consultá a un profesional si persiste o empeora. Podrás revisar tu situación antes de retomar.'
        }
      };
    }
    return open;
  }

  function getUnderlyingPlanItem(plan, focus) {
    if (!focus) return null;
    if (focus.gateForId) return plan.sessions.find(s => s.id === focus.gateForId) || null;
    return plan.sessions.find(s => s.id === focus.id) || focus;
  }

  function formatBlock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  /**
   * Días de calendario en hora local. No usa la hora del día:
   * del 16 oct al 1 nov son 16, aunque falten horas para la medianoche.
   */
  function calendarDaysUntil(isoDate, from = new Date()) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) return null;
    const [y, m, d] = String(isoDate).split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    if (Number.isNaN(target.getTime()) || Number.isNaN(start.getTime())) return null;
    return Math.round((target.getTime() - start.getTime()) / 86400000);
  }

  function describeStructure(structure) {
    if (!structure || structure.rest) return 'Recuperación';
    if (window.PaceAdaptive) return window.PaceAdaptive.describeStructure(structure);
    if (!Number(structure.walkSeconds)) {
      return `${formatBlock(structure.runSeconds)} carrera continua`;
    }
    return `${formatBlock(structure.runSeconds)} correr / ${formatBlock(structure.walkSeconds)} caminar ×${structure.reps}`;
  }

  function runLogs(logs) {
    return logs.filter(l => l.type !== 'Recuperación' && l.source !== 'rest');
  }

  /** Intentos válidos de entrenamiento (incluyen repeats). Excluye recovery. */
  function validTrainingAttempts(logs = [], plan = null) {
    const fromLogs = window.PaceAdaptive.validTrainingLogs(logs);
    const seen = new Set(fromLogs.map(log => log.id));
    const fromPlan = [];
    for (const session of plan?.sessions || []) {
      if (session.kind !== 'run') continue;
      for (const attempt of session.attempts || []) {
        const key = attempt.logId || attempt.id;
        if (seen.has(key) || attempt.kind === 'recovery-gate' || attempt.execution === 'skipped') continue;
        fromPlan.push({ ...attempt, id: key, planSessionId: session.id, type: 'Plan', source: 'plan-attempt' });
      }
    }
    return window.PaceAdaptive.validTrainingLogs([...fromPlan, ...fromLogs]);
  }

  function recentRunLogs(logs, n = 3) {
    return validTrainingAttempts(logs).slice(0, n);
  }

  function maxContinuousSec(logs) {
    return logs.reduce((m, l) => Math.max(m, Number(l.maxRunBlockSec) || 0), 0);
  }

  function hasSafetyAlert(entry) {
    return Boolean(
      entry.pain
      || entry.worseningDuringRun
      || entry.alteredGait
      || entry.forcedStop
      || entry.severeWarning
    );
  }

  /**
   * Deterioro sostenido (heurística auditable, no clínica):
   * en la ventana, el último completado empeora vs el primero
   * (RPE +2 o continuo medido −20%).
   */
  function recentTrendFavorable(priorLogs = [], plan = null) {
    return window.PaceAdaptive.trendFavorable(validTrainingAttempts(priorLogs, plan), plan);
  }

  /** @deprecated usar recentTrendFavorable */
  function recentTrendOk(priorLogs, plan = null) {
    return recentTrendFavorable(priorLogs, plan).ok;
  }

  /**
   * Lectura de tendencia para la persona, sin la fórmula del motor.
   * Favorable solo si recentTrendFavorable.ok. Si no, precaución o estable.
   */
  function summarizeTrend(logs = [], plan = null) {
    try {
      const valid = validTrainingAttempts(logs, plan).slice(0, 3);
      const trend = recentTrendFavorable(logs, plan);
      const completed = valid.filter(a => a.prescriptionCompleted && a.execution === 'completed');
      const pain = valid.filter(a => a.pain || a.worseningDuringRun || a.alteredGait || a.forcedStop || a.severeWarning).length;
      const rpes = completed.map(a => Number(a.rpe)).filter(n => Number.isFinite(n));
      const highRpe = rpes.some(r => r >= 7);
      const compliance = `${completed.length}/${valid.length || 0}`;

      if (valid.length < 2) {
        return {
          tone: 'estable',
          glyph: '→',
          headline: 'Estable',
          detail: 'Todavía hay pocas sesiones para leer una tendencia.'
        };
      }

      if (trend.ok) {
        return {
          tone: 'favorable',
          glyph: '↗',
          headline: 'Favorable',
          detail: `Últimas ${valid.length} sesiones: RPE estable · sin dolor relevante · cumplimiento ${compliance}`
        };
      }

      const caution = pain > 0 || highRpe || /deterioro|alerta|empeora/i.test(trend.reason || '');
      if (caution) {
        const signal = pain > 0 ? 'hay molestia' : highRpe ? 'RPE alto' : 'conviene no apurar';
        return {
          tone: 'precaucion',
          glyph: '↘',
          headline: 'Precaución',
          detail: `Últimas ${valid.length} sesiones: ${signal} · cumplimiento ${compliance}`
        };
      }

      return {
        tone: 'estable',
        glyph: '→',
        headline: 'Estable',
        detail: `Últimas ${valid.length} sesiones: RPE en rango · cumplimiento ${compliance}`
      };
    } catch (error) {
      console.error('[pace01] summarizeTrend', error);
      return {
        tone: 'estable',
        glyph: '→',
        headline: 'Estable',
        detail: 'No se pudo leer la tendencia de las últimas sesiones.'
      };
    }
  }

  function readinessConfidence(logs, plan = null) {
    return window.PaceAdaptive.trainingConfidence(validTrainingAttempts(logs, plan), plan);
  }

  function confidenceSufficient(conf) {
    return conf.confidence === 'media' || conf.confidence === 'alta';
  }

  function assessRaceReadiness(logs, plan) {
    const recent = recentRunLogs(logs, 3);
    const allRuns = runLogs(logs).filter(l => l.execution === 'completed');
    const bestCont = maxContinuousSec(allRuns);
    const recentBest = maxContinuousSec(recent);
    const recentWithRpe = recent.filter(l => l.rpe != null);
    const avgRpe = recentWithRpe.length
      ? recentWithRpe.reduce((s, l) => s + Number(l.rpe), 0) / recentWithRpe.length
      : null;
    const painCount = recent.filter(l => l.pain).length;
    const consistency = recent.length;
    const volumeSessions = allRuns.filter(l => {
      const d = new Date(`${l.date}T12:00:00`);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 10);
      return d >= cutoff;
    }).length;
    const conf = readinessConfidence(logs);

    const reasons = [];
    let level2k = 'aun_no';
    let level5k = 'aun_no';

    // 2K: continuo cómodo como base.
    if (bestCont >= 16 * 60 && painCount === 0 && (avgRpe == null || avgRpe <= 5) && consistency >= 2) {
      level2k = 'listo';
      reasons.push(`2K: ${formatBlock(bestCont)} continuos y últimas sesiones sin dolor.`);
    } else if (bestCont >= 10 * 60 || (recentBest >= 8 * 60 && consistency >= 2)) {
      level2k = 'cerca';
      reasons.push(`2K: vas hacia 16 min continuos (hoy máx. ${formatBlock(bestCont)}).`);
    } else {
      reasons.push(`2K: aún construyendo continuo (máx. ${formatBlock(bestCont)}). Meta base: 16:00.`);
    }

    // 5K = intentar terminar con run/walk, NO 5K continuo sin caminar.
    if (
      bestCont >= 16 * 60 &&
      painCount === 0 &&
      (avgRpe == null || avgRpe <= 5) &&
      consistency >= 3 &&
      volumeSessions >= 3
    ) {
      level5k = 'listo';
      reasons.push('5K: listo para intentar terminar con estrategia run/walk (no implica 5K sin caminar).');
    } else if (bestCont >= 12 * 60 && painCount === 0 && consistency >= 2) {
      level5k = 'cerca';
      reasons.push('5K (run/walk): cerca. Falta consistencia sin dolor y volumen reciente.');
    } else {
      reasons.push('5K: no listo para intentar terminar con run/walk. Prioridad: continuo cómodo + consistencia.');
    }

    if (painCount > 0) {
      reasons.unshift('Hay molestia en sesiones recientes: no forzar salto de distancia.');
      if (level5k === 'listo') level5k = 'cerca';
      if (level2k === 'listo' && painCount >= 2) level2k = 'cerca';
    }

    if (avgRpe != null && avgRpe >= 7) {
      reasons.push(`RPE reciente alto (prom. ${avgRpe.toFixed(1)}): no forzar carrera.`);
      if (level5k === 'listo') level5k = 'cerca';
    }

    if (conf.confidence === 'baja') {
      if (level5k === 'listo') level5k = 'cerca';
      if (level2k === 'listo') level2k = 'cerca';
      reasons.unshift(conf.note);
    } else {
      reasons.push(conf.note);
    }

    const targetLevel = level5k === 'listo' ? 'listo' : level2k === 'listo' ? 'listo' : (level5k === 'cerca' || level2k === 'cerca') ? 'cerca' : 'aun_no';
    const focusTarget = level5k === 'listo' || level5k === 'cerca' ? '5K' : '2K';
    const daysToCheckpoint = calendarDaysUntil(plan.checkpointDate, new Date());

    return {
      level: targetLevel,
      focusTarget,
      level2k,
      level5k,
      bestContinuousSec: bestCont,
      avgRpe,
      painCount,
      consistency,
      volumeSessions,
      reasons,
      checkpointDate: plan.checkpointDate,
      daysToCheckpoint,
      label: targetLevel === 'listo' ? 'Listo' : targetLevel === 'cerca' ? 'Cerca' : 'Aún no',
      confidence: conf.confidence,
      confidenceLabel: conf.confidenceLabel,
      fiveKDefinition: plan.fiveKDefinition
    };
  }

  /**
   * Decide progresión (no borra la ejecución).
   * Motor v4: PaceAdaptive.decideAdaptive (progress/consolidate/reduce/repeat/recovery/reassess).
   * Compat: progression advance|repeat|recovery para attempts e UI.
   */
  function decideProgression(log, priorLogs = [], plan = null) {
    if (window.PaceAdaptive) {
      const d = window.PaceAdaptive.decideAdaptive(log, priorLogs, plan);
      return {
        progression: d.progression,
        action: d.action,
        adaptiveAction: d.action,
        reason: d.reason,
        medicalNotice: Boolean(d.medicalNotice),
        override: d.action === 'recovery' && (d.reasonCode || []).includes('SAFETY_OVERRIDE'),
        reasonCode: d.reasonCode || [],
        profile: d.profile,
        trend: d.trend,
        caution: d.caution || null,
        priorityDimension: d.priorityDimension || null
      };
    }

    throw new Error('Motor de entrenamiento no disponible. Recargá antes de guardar.');
  }

  function decideSafety(log, priorLogs = [], plan = null) {
    const d = decideProgression(log, priorLogs, plan);
    return {
      action: d.progression === 'advance' ? 'advance' : d.progression === 'repeat' ? 'hold' : 'rest',
      progression: d.progression,
      reason: d.reason,
      medicalNotice: d.medicalNotice,
      caution: d.caution,
      reasonCode: d.reasonCode
    };
  }

  function buildDayCoaching(focus, settings, readiness, plan = null) {
    if (!focus && plan && window.PaceAdaptive) {
      window.PaceAdaptive.ensureHorizon(plan, loadLogs(), settings || loadSettingsSoft(), {
        action: 'consolidate',
        reason: 'Continuidad del plan adaptativo.'
      });
      focus = getFocusSession(plan);
      savePlan(plan);
    }
    if (!focus) {
      return {
        eyebrow: 'PLAN',
        title: 'Generando próxima sesión',
        body: 'El motor adaptativo prepara el siguiente estímulo. Si esto persiste, revisá el historial.',
        cta: 'Ver historial',
        mode: 'done'
      };
    }

    if (focus.kind === 'rest') {
      return {
        eyebrow: 'HOY · RECUPERACIÓN',
        title: focus.title,
        body: `${focus.structure.note || 'Descanso válido del plan.'} No es un día perdido: la progresión se apoya en esto.`,
        cta: 'Registrar recuperación',
        mode: 'rest',
        focus
      };
    }

    const st = focus.structure;
    const prescription = describeStructure(st);
    const attempts = Array.isArray(focus.attempts) ? focus.attempts.length : 0;
    const attemptNote = attempts
      ? ` Intentos previos en este ítem: ${attempts} (el historial no se borra si hay que repetir).`
      : '';
    const paceHint = focus.structure && !focus.structure.rest
      ? `Guía cinta ${Number(settings.runSpeed).toFixed(1).replace('.', ',')} km/h; en exterior: ritmo cómodo/conversacional.`
      : '';

    return {
      eyebrow: 'HOY · SESIÓN',
      title: focus.title,
      body: `Hoy: ${prescription}. Objetivo: terminar cómodo, no correr más rápido. ${paceHint} Sin dolor y RPE ≤5 confirma una buena tolerancia al entrenamiento. Con RPE 6 miramos la tendencia reciente antes de avanzar.${attemptNote}`,
      detail: readiness.reasons[0] || '',
      cta: 'Iniciar entrenamiento',
      mode: 'run',
      focus,
      prescription
    };
  }

  /**
   * Guarda attempt (ejecución) + aplica progresión.
   * El historial/attempt permanece aunque progression sea repeat/recovery.
   */
  function confirmNextSession(plan, log, allLogs = []) {
    const existing = plan.sessions.flatMap(s => s.attempts || []).find(a => a.logId === log.id);
    if (existing) return { plan, attempt: existing, progression: existing.progression, action: existing.action, advanced: false, message: 'Este intento ya estaba guardado.', next: getFocusSession(plan) };
    const focusView = getFocusSession(plan);
    const item = log.planSessionId ? plan.sessions.find(s => s.id === log.planSessionId) : null;
    log.createdAt = log.createdAt || new Date().toISOString();
    log.attemptSequence = log.attemptSequence || Math.max(0, ...(allLogs || []).filter(l => l.id !== log.id && l.date === log.date).map(l => Number(l.attemptSequence) || 0)) + 1;
    if (!item || item.kind !== 'run' || !['pending', 'rescheduled'].includes(item.status)) {
      log.progression = null; log.action = log.adaptiveAction = 'record_only';
      log.decisionReason = 'Guardamos lo realizado con su prescripción original. El plan actual cambió; este intento no modifica otra sesión.';
      return { plan, advanced: false, action: 'record_only', progression: null, message: log.decisionReason, next: focusView, decision: { action: 'record_only', progression: null, reason: log.decisionReason } };
    }
    log.prescriptionSnapshot = log.prescriptionSnapshot || clone(item.structure);
    const messages = [];

    if (!item || item.kind === 'rest') {
      return { plan, message: 'Registro guardado.', advanced: false };
    }

    if (!Array.isArray(item.attempts)) item.attempts = [];

    if (Array.isArray(log.blocks) && log.blocks.length) {
      log.prescriptionCompleted = window.PaceAdaptive.observedCompletion(log);
      log.execution = log.prescriptionCompleted ? 'completed' : 'aborted';
    }
    const priorLogs = (allLogs || []).filter(l => l.id !== log.id);
    const decision = decideProgression(log, priorLogs, plan);
    const execution = log.execution || 'completed';
    const prescriptionCompleted = log.prescriptionCompleted !== false && execution !== 'aborted';

    let adaptiveAction = decision.adaptiveAction || decision.action || decision.progression;
    const speedSuggestion = window.PaceAdaptive
      ? window.PaceAdaptive.suggestSpeed([...(priorLogs || []), log], loadSettingsSoft(), plan)
      : null;
    if (speedSuggestion) plan.pendingSpeedSuggestion = speedSuggestion;
    const attempt = {
      id: `att-${log.id}`,
      logId: log.id,
      date: log.date,
      createdAt: log.createdAt,
      attemptSequence: log.attemptSequence,
      blocks: log.blocks || null,
      elapsedSec: log.elapsedSec ?? null,
      execution,
      prescriptionCompleted,
      progression: decision.progression,
      adaptiveAction,
      action: adaptiveAction,
      priorityDimension: decision.priorityDimension || null,
      caution: decision.caution || null,
      rpe: log.rpe,
      pain: Boolean(log.pain),
      painIntensity: log.painIntensity,
      maxRunBlockSec: log.maxRunBlockSec,
      worseningDuringRun: Boolean(log.worseningDuringRun),
      alteredGait: Boolean(log.alteredGait),
      forcedStop: Boolean(log.forcedStop),
      severeWarning: Boolean(log.severeWarning),
      environment: log.environment === 'treadmill' || log.environment === 'outdoor'
        ? log.environment
        : (log.type === 'Cinta' ? 'treadmill' : log.type === 'Exterior' ? 'outdoor' : null),
      reasonCode: decision.reasonCode || []
    };
    item.attempts.push(attempt);
    item.lastAttemptLogId = log.id;
    log.execution = execution;
    log.prescriptionCompleted = prescriptionCompleted;
    log.progression = decision.progression;
    log.adaptiveAction = adaptiveAction;
    log.action = adaptiveAction;
    log.reasonCode = decision.reasonCode || [];
    log.decisionReason = decision.reason;
    attempt.reason = decision.reason;

    messages.push(`Intento #${item.attempts.length}: ${execution}${prescriptionCompleted ? '' : ' · incompleto'} · ${adaptiveAction} (${decision.progression}).`);
    messages.push(decision.reason);

    if (decision.progression === 'repeat') {
      item.status = item.status === 'rescheduled' ? 'rescheduled' : 'pending';
      item.blockedUntilRest = false;
      messages.push(`Misma prescripción sigue abierta: ${item.title}.`);
      return {
        plan,
        message: messages.join(' '),
        advanced: false,
        action: 'repeat',
        progression: 'repeat',
        next: item,
        decision,
        attempt
      };
    }

    if (decision.progression === 'recovery') {
      item.status = item.status === 'rescheduled' ? 'rescheduled' : 'pending';
      item.blockedUntilRest = true;
      messages.push('Recuperación antes de volver a la misma sesión del plan.');
      return {
        plan,
        message: messages.join(' '),
        advanced: false,
        action: 'recovery',
        progression: 'recovery',
        next: getFocusSession(plan),
        decision,
        attempt,
        medicalNotice: decision.medicalNotice
      };
    }

    // advance (progress | consolidate | reduce | reassess)
    item.status = 'completed';
    item.blockedUntilRest = false;
    item.completedLogId = log.id;
    const prevStructure = clone(item.structure);
    regenerateHorizonAfterAdvance(plan, item, decision, [...priorLogs, log]);
    const next = getFocusSession(plan);
    let explanation = null;
    if (window.PaceAdaptive && next) {
      const nextRun = next.kind === 'run'
        ? next
        : sortedPlanSessions(plan).find(s => isOpenStatus(s.status) && s.kind === 'run');
      if (nextRun?.structure) {
        explanation = window.PaceAdaptive.buildDiffMessage(prevStructure, nextRun.structure, decision);
        if (explanation.sameLoad && adaptiveAction.startsWith('progress')) {
          adaptiveAction = 'consolidate'; decision.action = 'consolidate'; decision.adaptiveAction = 'consolidate';
          decision.reason = 'Completaste la sesión con buena tolerancia. Mantenemos la carga dentro de tu tiempo disponible y los límites de progresión. Podés revisar tus minutos disponibles en Ajustes.';
          log.action = log.adaptiveAction = attempt.action = attempt.adaptiveAction = 'consolidate';
          log.decisionReason = attempt.reason = decision.reason;
          explanation.actionLabel = 'Consolidar'; nextRun.decisionAction = 'consolidate';
          messages[1] = decision.reason;
        }
        explanation.speedSuggestion = speedSuggestion;
        nextRun.changeSummary = explanation;
        nextRun.justification = decision.reason;
        nextRun.primaryDimension = decision.priorityDimension || explanation.dimension;
      }
    }
    if (next) {
      if (next.kind === 'rest') {
        messages.push(`Siguiente: ${next.title} (recuperación válida).`);
      } else {
        messages.push(`Siguiente: ${next.title} · ${describeStructure(next.structure)}.`);
      }
    } else {
      messages.push('Continuidad del plan: se regenerará el horizonte en la próxima carga.');
    }
    return {
      plan,
      message: messages.join(' '),
      advanced: true,
      action: adaptiveAction,
      progression: 'advance',
      next,
      decision,
      attempt,
      explanation,
      previousStructure: prevStructure,
      speedSuggestion,
      caution: decision.caution || null
    };
  }

  function markRestComplete(plan, logs, focusId, localDate = null) {
    const focusView = getFocusSession(plan);
    const log = {
      id: `rest-${Date.now()}`,
      date: localDate,
      type: 'Recuperación',
      planSessionId: null,
      time: null,
      distanceKm: null,
      distanceEstimated: false,
      maxRunBlockSec: null,
      couldContinue: null,
      rpe: null,
      pain: false,
      painLocation: '',
      painIntensity: null,
      worseningDuringRun: false,
      alteredGait: false,
      forcedStop: false,
      severeWarning: false,
      execution: 'completed',
      progression: 'advance',
      notes: 'Recuperación marcada desde Home.',
      source: 'rest'
    };

    if (focusView?.gateForId || (focusId && String(focusId).startsWith('rest-gate:'))) {
      const runId = focusView?.gateForId || String(focusId).replace('rest-gate:', '');
      const runItem = plan.sessions.find(s => s.id === runId);
      if (!runItem) return { plan, logs, message: 'No hay sesión bloqueada.' };
      runItem.blockedUntilRest = false;
      log.planSessionId = runId;
      log.progression = 'advance';
      log.notes = 'Recuperación tras progression=recovery; misma prescripción sigue abierta.';
      if (!Array.isArray(runItem.attempts)) runItem.attempts = [];
      runItem.attempts.push({
        id: `att-rest-${Date.now()}`,
        logId: log.id,
        date: log.date,
        execution: 'completed',
        progression: 'advance',
        rpe: null,
        pain: false,
        kind: 'recovery-gate'
      });
      logs.push(log);
      if (window.PaceAdaptive) {
        window.PaceAdaptive.ensureHorizon(plan, logs, loadSettingsSoft(), {
          action: 'consolidate',
          reason: 'Tras recuperación de seguridad.'
        });
      }
      const next = getFocusSession(plan);
      const nextMsg = next?.scheduledDate
        ? `Recuperación completada. Tu próximo entrenamiento quedó habilitado para ${next.scheduledDate}.`
        : next
          ? 'Recuperación completada. Tu próximo entrenamiento quedó habilitado.'
          : 'Recuperación registrada.';
      return {
        plan,
        logs,
        log,
        message: nextMsg,
        next,
        recoveryEnabledNext: Boolean(next)
      };
    }

    const focus = plan.sessions.find(s => s.id === focusId) || getUnderlyingPlanItem(plan, focusView);
    if (!focus || focus.kind !== 'rest') return { plan, logs, message: 'No hay recuperación pendiente.' };
    log.planSessionId = focus.id;
    focus.status = 'completed';
    focus.completedLogId = log.id;
    focus.completedDate = log.date || localDate;
    if (!Array.isArray(focus.attempts)) focus.attempts = [];
    focus.attempts.push({
      id: `att-${Date.now()}`,
      logId: log.id,
      date: log.date,
      execution: 'completed',
      progression: 'advance',
      adaptiveAction: 'recovery_complete',
      rpe: null,
      pain: false
    });
    logs.push(log);
    if (window.PaceAdaptive) {
      window.PaceAdaptive.ensureHorizon(plan, logs, loadSettingsSoft(), {
        action: 'consolidate',
        reason: 'Tras descanso programado.'
      });
    }
    const next = getFocusSession(plan);
    const nextMsg = next?.scheduledDate
      ? `Recuperación completada. Tu próximo entrenamiento quedó habilitado para ${next.scheduledDate}.`
      : next
        ? 'Recuperación completada. Tu próximo entrenamiento quedó habilitado.'
        : 'Recuperación registrada.';
    return {
      plan,
      logs,
      log,
      message: nextMsg,
      next,
      recoveryEnabledNext: Boolean(next)
    };
  }

  function skipFocus(plan) {
    const focusView = getFocusSession(plan);
    const focus = getUnderlyingPlanItem(plan, focusView);
    if (!focus) return { plan, message: 'Nada para omitir.' };
    if (focus.blockedUntilRest) return { plan, message: 'Mantenemos la pausa: omitir no puede quitar la recuperación por síntomas.' };
    focus.status = 'skipped';
    focus.blockedUntilRest = false;
    if (!Array.isArray(focus.attempts)) focus.attempts = [];
    focus.attempts.push({
      id: `att-skip-${Date.now()}`,
      logId: null,
      date: null,
      execution: 'skipped',
      progression: null,
      rpe: null,
      pain: false
    });
    if (window.PaceAdaptive) {
      window.PaceAdaptive.ensureHorizon(plan, loadLogs(), loadSettingsSoft(), {
        action: 'consolidate',
        reason: 'Tras omitir: continuidad del horizonte.'
      });
    }
    const next = getFocusSession(plan);
    return {
      plan,
      message: next
        ? `Sesión omitida. Siguiente: ${next.title}.`
        : 'Sesión omitida.',
      next
    };
  }

  function rescheduleFocus(plan, scheduledDate) {
    const focusView = getFocusSession(plan);
    const focus = getUnderlyingPlanItem(plan, focusView);
    if (!focus) return { plan, message: 'Nada para reprogramar.' };
    const previousDate = focus.scheduledDate || null;
    focus.scheduledDate = scheduledDate;
    focus.status = 'rescheduled';
    // Rescheduling changes only dates; prescription, attempts and safety gate remain.
    window.PaceAdaptive.allocateScheduleDates(plan, window.PaceAdaptive.paramsOf(plan));
    console.info('[pace01] reschedule', { id: focus.id, previousDate, scheduledDate });
    return {
      plan,
      previousDate,
      scheduledDate,
      title: focus.title,
      message: `Misma sesión reprogramada al ${scheduledDate}. La dificultad no cambió; solo la fecha.`,
      next: focus
    };
  }

  function isRecoveryLog(log) {
    return Boolean(
      log &&
      (log.voluntary ||
        log.type === 'Recuperación' ||
        log.source === 'rest' ||
        log.kind === 'recovery-gate')
    );
  }

  /** Entrenamiento real ese día (intervalos u actividad). No incluye recuperación ni omisiones. */
  function hasTrainingOnDate(logs = [], date) {
    if (!date) return false;
    return (logs || []).some(l =>
      l.date === date &&
      !isRecoveryLog(l) &&
      l.execution !== 'skipped'
    );
  }

  function hasRecoveryOnDate(logs = [], date) {
    if (!date) return false;
    return (logs || []).some(l => l.date === date && isRecoveryLog(l));
  }

  /**
   * Limpia recuperaciones voluntarias registradas el mismo día que un entrenamiento.
   * Caso típico: se entrenó y después se tocó “Recuperación” por error.
   */
  function purgeInvalidSameDayRecoveries(logs = []) {
    const list = Array.isArray(logs) ? logs.slice() : [];
    const trainingDates = new Set(
      list
        .filter(l => l && l.date && !isRecoveryLog(l) && l.execution !== 'skipped')
        .map(l => l.date)
    );
    const kept = [];
    const removed = [];
    for (const log of list) {
      const accidental =
        log &&
        trainingDates.has(log.date) &&
        log.kind !== 'recovery-gate' &&
        (log.voluntary === true || (log.source === 'rest' && log.type === 'Recuperación'));
      if (accidental) removed.push(log);
      else kept.push(log);
    }
    return { logs: kept, removed };
  }

  /**
   * Día sin correr elegido por la persona, con una sesión de intervalos todavía abierta.
   * Registra recuperación y no cierra el PlanItem ni avanza la secuencia.
   * No permite registrar recuperación el mismo día en que ya hay un entrenamiento.
   */
  function registerVoluntaryRecovery(plan, logs, localDate) {
    try {
      if (hasTrainingOnDate(logs, localDate)) {
        return {
          plan,
          logs,
          blocked: true,
          message: 'Hoy ya registraste un entrenamiento. No hace falta marcar recuperación el mismo día.'
        };
      }
      if (hasRecoveryOnDate(logs, localDate)) {
        return {
          plan,
          logs,
          blocked: true,
          message: 'Hoy ya figurás en recuperación. No se crea otro registro.'
        };
      }
      const focusView = getFocusSession(plan);
      const item = getUnderlyingPlanItem(plan, focusView);
      const log = {
        id: `rest-vol-${Date.now()}`,
        date: localDate,
        type: 'Recuperación',
        planSessionId: item && item.kind === 'run' ? item.id : null,
        time: null,
        distanceKm: null,
        distanceEstimated: false,
        maxRunBlockSec: null,
        couldContinue: null,
        rpe: null,
        pain: false,
        painLocation: '',
        painIntensity: null,
        worseningDuringRun: false,
        alteredGait: false,
        forcedStop: false,
        severeWarning: false,
        execution: 'completed',
        progression: null,
        notes: 'Día de recuperación voluntario. La sesión del plan sigue pendiente.',
        source: 'rest',
        voluntary: true
      };
      logs.push(log);
      console.info('[pace01] voluntary-recovery', { planSessionId: log.planSessionId, date: localDate });
      return {
        plan,
        logs,
        log,
        message: 'Recuperación registrada. Tu sesión de entrenamiento sigue pendiente; no se completó ni se duplicó.'
      };
    } catch (error) {
      console.error('[pace01] voluntary-recovery', error);
      return { plan, logs, message: 'No se pudo registrar la recuperación.' };
    }
  }

  function planStats(plan) {
    const all = sortedPlanSessions(plan);
    const attempts = all.reduce((n, s) => n + (Array.isArray(s.attempts) ? s.attempts.filter(a => a.execution === 'completed').length : 0), 0);
    return {
      done: all.filter(s => s.status === 'completed').length,
      pending: all.filter(s => isOpenStatus(s.status)).length,
      skipped: all.filter(s => s.status === 'skipped').length,
      rescheduled: all.filter(s => s.status === 'rescheduled').length,
      completedAttempts: attempts,
      total: all.length
    };
  }

  window.PaceCoach = {
    PLAN_KEY,
    LOGS_KEY,
    loadPlan,
    savePlan,
    loadLogs,
    saveLogs,
    updateStoredLog,
    reviewFutureAfterCorrection,
    requestWalkToJog,
    getFocusSession,
    getUnderlyingPlanItem,
    sortedPlanSessions,
    describeStructure,
    formatBlock,
    calendarDaysUntil,
    assessRaceReadiness,
    recentTrendOk,
    recentTrendFavorable,
    summarizeTrend,
    validTrainingAttempts,
    decideProgression,
    decideSafety,
    buildDayCoaching,
    acceptSpeedSuggestion(plan, settings) {
      const sug = plan?.pendingSpeedSuggestion;
      if (!sug || sug.suggestedKmh == null) {
        return { plan, settings, applied: false, message: 'No hay sugerencia de velocidad pendiente.' };
      }
      settings.runSpeed = sug.suggestedKmh;
      plan.pendingSpeedSuggestion = {
        ...sug,
        action: 'accepted',
        acceptedAt: window.PaceAdaptive ? window.PaceAdaptive.localDateISO() : null
      };
      return {
        plan,
        settings,
        applied: true,
        message: `Velocidad actualizada a ${String(sug.suggestedKmh).replace('.', ',')} km/h (aceptada por vos).`
      };
    },
    rejectSpeedSuggestion(plan) {
      if (!plan) return { plan, rejected: false };
      const sug = plan.pendingSpeedSuggestion;
      plan.pendingSpeedSuggestion = sug
        ? { ...sug, action: 'rejected', rejectedAt: window.PaceAdaptive ? window.PaceAdaptive.localDateISO() : null }
        : null;
      return { plan, rejected: true, message: 'Mantenemos tu velocidad configurada.' };
    },
    confirmNextSession,
    markRestComplete,
    registerVoluntaryRecovery,
    hasTrainingOnDate,
    hasRecoveryOnDate,
    isRecoveryLog,
    purgeInvalidSameDayRecoveries,
    skipFocus,
    rescheduleFocus,
    planStats,
    buildDefaultPlan,
    buildDemoPlan,
    buildDemoLogs,
    needsOnboarding,
    applyIntake,
    updatePlanPreferences,
    recalibrateFocus,
    undoRecalibrateFocus,
    canUndoRecalibration,
    restoreFocusFromProfile,
    refreshStaleFocusDates,
    loadDemoData,
    resetToOnboarding,
    upgradePlanAdaptive,
    regenerateHorizonAfterAdvance,
    ENGINE_VERSION: () => (window.PaceAdaptive && window.PaceAdaptive.ENGINE_VERSION) || '3.0.0'
  };
})();

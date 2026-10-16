(() => {
  const PLAN_KEY = 'pace01.plan.v3';
  const LOGS_KEY = 'pace01.logs.v3';
  const LEGACY_PLAN_V2 = 'pace01.plan.v2';
  const LEGACY_LOGS_V2 = 'pace01.logs.v2';
  const LEGACY_SESSIONS = 'pace01.sessions.v1';

  const RACE_DATE = '2026-11-01';
  const CHECKPOINT_DATE = '2026-10-25';

  function clone(value) {
    return structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function emptyAttempts() {
    return [];
  }

  function buildDefaultPlan() {
    return {
      version: 3,
      raceDate: RACE_DATE,
      checkpointDate: CHECKPOINT_DATE,
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
          // Misma duración de bloque; volumen vía reps en w2-s3 (una variable de carga).
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
          // Solo cambia volumen (reps); no ritmo.
          structure: { warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 8 },
          attempts: emptyAttempts()
        },
        {
          id: 'w2-rest-c', weekGroup: 2, order: 10, kind: 'rest',
          title: 'Recuperación', status: 'pending', scheduledDate: null, blockedUntilRest: false,
          structure: { rest: true, note: 'Antes del checkpoint del 25 oct: llegar fresco, no forzado.' },
          attempts: emptyAttempts()
        }
      ]
    };
  }

  function normalizePlan(plan) {
    if (!plan || !Array.isArray(plan.sessions)) return buildDefaultPlan();
    plan.version = 3;
    plan.fiveKDefinition = plan.fiveKDefinition
      || 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).';
    plan.sessions = plan.sessions.map(s => ({
      scheduledDate: null,
      blockedUntilRest: false,
      attempts: [],
      ...s,
      attempts: Array.isArray(s.attempts) ? s.attempts : []
    }));
    return plan;
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
    const seed = [
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
    localStorage.setItem(LOGS_KEY, JSON.stringify(seed));
    return clone(seed);
  }

  function saveLogs(logs) {
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
  }

  function loadPlan() {
    try {
      const stored = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
      if (stored && Array.isArray(stored.sessions) && stored.sessions.length) {
        const normalized = normalizePlan(stored);
        localStorage.setItem(PLAN_KEY, JSON.stringify(normalized));
        return normalized;
      }
    } catch { /* ignore */ }
    try {
      const v2 = JSON.parse(localStorage.getItem(LEGACY_PLAN_V2) || 'null');
      if (v2 && Array.isArray(v2.sessions)) {
        const normalized = normalizePlan(v2);
        localStorage.setItem(PLAN_KEY, JSON.stringify(normalized));
        return normalized;
      }
    } catch { /* ignore */ }
    const plan = buildDefaultPlan();
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
          note: 'Ya registramos el intento de entrenamiento. Ahora toca recuperación; la prescripción del plan no se duplicó.'
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
    return `${formatBlock(structure.runSeconds)} correr / ${formatBlock(structure.walkSeconds)} caminar ×${structure.reps}`;
  }

  function runLogs(logs) {
    return logs.filter(l => l.type !== 'Recuperación' && l.source !== 'rest');
  }

  /** Intentos válidos de entrenamiento (incluyen repeats). Excluye recovery. */
  function validTrainingAttempts(logs = [], plan = null) {
    const fromLogs = (logs || [])
      .filter(l => l.type !== 'Recuperación' && l.source !== 'rest')
      .filter(l => l.source !== 'external')
      .filter(l => l.execution !== 'skipped')
      .filter(l => l.kind !== 'recovery-gate')
      .map(l => ({
        id: l.id,
        date: l.date,
        planSessionId: l.planSessionId,
        execution: l.execution || 'completed',
        prescriptionCompleted: l.prescriptionCompleted !== false && l.execution !== 'aborted',
        rpe: l.rpe,
        pain: Boolean(l.pain),
        maxRunBlockSec: l.maxRunBlockSec,
        worseningDuringRun: Boolean(l.worseningDuringRun),
        alteredGait: Boolean(l.alteredGait),
        forcedStop: Boolean(l.forcedStop),
        severeWarning: Boolean(l.severeWarning),
        progression: l.progression
      }));

    // Completar con attempts del plan que aún no estén en logs (p. ej. skips internos).
    const seen = new Set(fromLogs.map(a => a.id));
    const fromPlan = [];
    if (plan?.sessions) {
      for (const s of plan.sessions) {
        if (s.kind !== 'run') continue;
        for (const a of s.attempts || []) {
          if (a.kind === 'recovery-gate' || a.execution === 'skipped') continue;
          const key = a.logId || a.id;
          if (seen.has(key)) continue;
          fromPlan.push({
            id: key,
            date: a.date,
            planSessionId: s.id,
            execution: a.execution || 'completed',
            prescriptionCompleted: a.prescriptionCompleted !== false && a.execution !== 'aborted',
            rpe: a.rpe,
            pain: Boolean(a.pain),
            maxRunBlockSec: a.maxRunBlockSec,
            worseningDuringRun: Boolean(a.worseningDuringRun),
            alteredGait: Boolean(a.alteredGait),
            forcedStop: Boolean(a.forcedStop),
            severeWarning: Boolean(a.severeWarning),
            progression: a.progression
          });
        }
      }
    }

    return [...fromLogs, ...fromPlan]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
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
  function hasSustainedDeterioration(windowAttempts) {
    const completed = windowAttempts
      .filter(a => a.prescriptionCompleted && a.execution === 'completed')
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    if (completed.length < 2) return false;
    const first = completed[0];
    const last = completed[completed.length - 1];
    const rpeUp = first.rpe != null && last.rpe != null && Number(last.rpe) - Number(first.rpe) >= 2;
    const contFirst = Number(first.maxRunBlockSec) || 0;
    const contLast = Number(last.maxRunBlockSec) || 0;
    const contDown = contFirst > 0 && contLast > 0 && contLast < contFirst * 0.8;
    return rpeUp || contDown;
  }

  /**
   * Tendencia reciente favorable — últimos 3 intentos válidos
   * (incluye repeticiones del mismo PlanItem; excluye recovery).
   */
  function recentTrendFavorable(priorLogs = [], plan = null) {
    const valid = validTrainingAttempts(priorLogs, plan).slice(0, 3);
    if (valid.length < 3) {
      return {
        ok: false,
        reason: 'Menos de 3 intentos válidos: RPE 6 → repeat por defecto.',
        sampleSize: valid.length
      };
    }

    const completed = valid.filter(a => a.prescriptionCompleted && a.execution === 'completed');
    if (completed.length < 2) {
      return { ok: false, reason: 'Menos de 2/3 intentos completados en la ventana.', sampleSize: valid.length };
    }

    if (completed.some(a => a.rpe != null && Number(a.rpe) > 6)) {
      return { ok: false, reason: 'Algún intento completado reciente con RPE > 6.', sampleSize: valid.length };
    }

    if (valid.some(a => a.worseningDuringRun || a.alteredGait || a.forcedStop || a.severeWarning)) {
      return { ok: false, reason: 'Alertas de seguridad en la ventana (empeora / marcha / freno).', sampleSize: valid.length };
    }

    if (hasSustainedDeterioration(valid)) {
      return { ok: false, reason: 'Deterioro sostenido de rendimiento o tolerancia al esfuerzo.', sampleSize: valid.length };
    }

    const conf = readinessConfidence(priorLogs);
    if (conf.confidence === 'baja') {
      return { ok: false, reason: 'Confianza baja: la tendencia no habilita advance.', sampleSize: valid.length };
    }

    return { ok: true, reason: 'Tendencia reciente favorable (2/3+ completados, RPE≤6, sin alertas, confianza ≥ media).', sampleSize: valid.length };
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

  function readinessConfidence(logs) {
    const runs = validTrainingAttempts(logs);
    const completed = runs.filter(a => a.prescriptionCompleted && a.execution === 'completed');
    const withRpe = completed.filter(l => l.rpe != null).length;
    const withCompliance = completed.length;
    const withCont = completed.filter(l => l.maxRunBlockSec != null).length;
    const recent = runs.slice(0, 3).length;

    // Baja: faltan esenciales o muy pocos datos.
    if (withRpe < 2 || withCompliance < 2 || recent < 2) {
      return { confidence: 'baja', confidenceLabel: 'Confianza baja', note: 'Datos esenciales incompletos: no se confirma advance ni Listo.' };
    }
    if (withRpe >= 4 && withCont >= 3 && recent >= 3) {
      return { confidence: 'alta', confidenceLabel: 'Confianza alta', note: 'Registro completo y coherente para evaluar avance.' };
    }
    return { confidence: 'media', confidenceLabel: 'Confianza media', note: 'Datos esenciales completos; evaluar con cautela.' };
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
   * Prioridad: overrides → cumplimiento → confianza → RPE → tendencia (si RPE=6).
   */
  function decideProgression(log, priorLogs = [], plan = null) {
    const rpe = Number(log.rpe);
    const override = Boolean(log.worseningDuringRun || log.alteredGait || log.forcedStop || log.severeWarning);
    const prescriptionCompleted = log.prescriptionCompleted !== false && log.execution !== 'aborted';
    const conf = readinessConfidence([...(priorLogs || []), log]);
    const reasonCode = [];

    // 1) Overrides de seguridad (prioridad máxima)
    if (override) {
      reasonCode.push('SAFETY_OVERRIDE');
      return {
        progression: 'recovery',
        reason: log.severeWarning
          ? 'Alerta severa: recovery obligatorio. Considerá atención médica si es urgente; la app no diagnostica.'
          : 'Override de seguridad (empeora / marcha / freno): recovery, independientemente del RPE.',
        medicalNotice: Boolean(log.severeWarning),
        override: true,
        reasonCode
      };
    }

    if (log.pain && Number(log.painIntensity || 0) >= 3) {
      reasonCode.push('PAIN_MODERATE');
      return {
        progression: 'recovery',
        reason: 'Molestia moderada o más: recovery. El intento queda registrado.',
        medicalNotice: false,
        override: false,
        reasonCode
      };
    }

    // 2) Cumplimiento de prescripción (bloques), no distancia GPS
    if (!prescriptionCompleted) {
      reasonCode.push('PRESCRIPTION_INCOMPLETE');
      return {
        progression: 'repeat',
        reason: 'No se completó la prescripción (bloques): repeat. Un RPE bajo no compensa un entrenamiento incompleto.',
        medicalNotice: false,
        override: false,
        reasonCode
      };
    }

    // 3) Confianza insuficiente → no advance automático
    if (!confidenceSufficient(conf)) {
      reasonCode.push('LOW_CONFIDENCE');
      return {
        progression: 'repeat',
        reason: 'Confianza baja o datos esenciales incompletos: no advance automático (repeat provisional).',
        medicalNotice: false,
        override: false,
        reasonCode,
        confidence: conf.confidence
      };
    }

    // 4) Alertas no override (p. ej. dolor leve) → no “sin alertas”
    if (hasSafetyAlert(log)) {
      reasonCode.push('ALERT_PRESENT');
      return {
        progression: 'repeat',
        reason: 'Hay alerta (p. ej. molestia) sin override: el intento cuenta, progresión = repeat.',
        medicalNotice: false,
        override: false,
        reasonCode
      };
    }

    // 5–7) RPE + tendencia
    if (rpe <= 5) {
      reasonCode.push('RPE_LE_5');
      return {
        progression: 'advance',
        reason: 'Cumplido + RPE ≤5 + sin alertas + confianza suficiente: advance.',
        medicalNotice: false,
        override: false,
        reasonCode,
        confidence: conf.confidence
      };
    }

    if (rpe === 6) {
      const trend = recentTrendFavorable(priorLogs, plan);
      if (trend.ok) {
        reasonCode.push('RPE_6_TREND_OK');
        return {
          progression: 'advance',
          reason: `Cumplido + RPE 6 + tendencia favorable: advance. ${trend.reason}`,
          medicalNotice: false,
          override: false,
          caution: true,
          reasonCode,
          trend,
          confidence: conf.confidence
        };
      }
      reasonCode.push('RPE_6_TREND_BAD');
      return {
        progression: 'repeat',
        reason: `Cumplido + RPE 6 + tendencia no favorable: repeat. ${trend.reason}`,
        medicalNotice: false,
        override: false,
        reasonCode,
        trend,
        confidence: conf.confidence
      };
    }

    reasonCode.push('RPE_GE_7');
    return {
      progression: 'repeat',
      reason: 'Cumplido + RPE ≥7: repeat. El entrenamiento queda registrado.',
      medicalNotice: false,
      override: false,
      reasonCode,
      confidence: conf.confidence
    };
  }

  /** @deprecated alias */
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

  function buildDayCoaching(focus, settings, readiness) {
    if (!focus) {
      return {
        eyebrow: 'PLAN',
        title: 'Secuencia completa por ahora',
        body: 'No hay sesión pendiente. Revisá historial o exportá datos antes de ampliar el plan.',
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
    const focusView = getFocusSession(plan);
    const item = plan.sessions.find(s => s.id === log.planSessionId)
      || getUnderlyingPlanItem(plan, focusView);
    const messages = [];

    if (!item || item.kind === 'rest') {
      return { plan, message: 'Registro guardado.', advanced: false };
    }

    if (!Array.isArray(item.attempts)) item.attempts = [];

    const priorLogs = (allLogs || []).filter(l => l.id !== log.id);
    const decision = decideProgression(log, priorLogs, plan);
    const execution = log.execution || 'completed';
    const prescriptionCompleted = log.prescriptionCompleted !== false && execution !== 'aborted';

    const attempt = {
      id: `att-${Date.now()}`,
      logId: log.id,
      date: log.date,
      execution,
      prescriptionCompleted,
      progression: decision.progression,
      rpe: log.rpe,
      pain: Boolean(log.pain),
      painIntensity: log.painIntensity,
      maxRunBlockSec: log.maxRunBlockSec,
      worseningDuringRun: Boolean(log.worseningDuringRun),
      alteredGait: Boolean(log.alteredGait),
      forcedStop: Boolean(log.forcedStop),
      severeWarning: Boolean(log.severeWarning),
      reasonCode: decision.reasonCode || []
    };
    item.attempts.push(attempt);
    item.lastAttemptLogId = log.id;
    log.execution = execution;
    log.prescriptionCompleted = prescriptionCompleted;
    log.progression = decision.progression;
    log.reasonCode = decision.reasonCode || [];

    messages.push(`Intento #${item.attempts.length}: ${execution}${prescriptionCompleted ? '' : ' · incompleto'} · progresión ${decision.progression}.`);
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

    // advance
    item.status = 'completed';
    item.blockedUntilRest = false;
    item.completedLogId = log.id;
    const next = getFocusSession(plan);
    if (next) {
      if (next.kind === 'rest') {
        messages.push(`Siguiente prescripción: ${next.title} (recuperación válida).`);
      } else {
        messages.push(`Siguiente prescripción: ${next.title} · ${describeStructure(next.structure)}.`);
      }
    } else {
      messages.push('Secuencia al día. Buen trabajo.');
    }
    return {
      plan,
      message: messages.join(' '),
      advanced: true,
      action: 'advance',
      progression: 'advance',
      next,
      decision,
      attempt
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
      const next = getFocusSession(plan);
      return {
        plan,
        logs,
        log,
        message: next
          ? `Recuperación registrada. Volvés a: ${next.title}.`
          : 'Recuperación registrada.',
        next
      };
    }

    const focus = plan.sessions.find(s => s.id === focusId) || getUnderlyingPlanItem(plan, focusView);
    if (!focus || focus.kind !== 'rest') return { plan, logs, message: 'No hay recuperación pendiente.' };
    log.planSessionId = focus.id;
    focus.status = 'completed';
    focus.completedLogId = log.id;
    if (!Array.isArray(focus.attempts)) focus.attempts = [];
    focus.attempts.push({
      id: `att-${Date.now()}`,
      logId: log.id,
      date: log.date,
      execution: 'completed',
      progression: 'advance',
      rpe: null,
      pain: false
    });
    logs.push(log);
    const next = getFocusSession(plan);
    return {
      plan,
      logs,
      log,
      message: next
        ? `Recuperación registrada. Siguiente: ${next.title}.`
        : 'Recuperación registrada.',
      next
    };
  }

  function skipFocus(plan) {
    const focusView = getFocusSession(plan);
    const focus = getUnderlyingPlanItem(plan, focusView);
    if (!focus) return { plan, message: 'Nada para omitir.' };
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
    focus.blockedUntilRest = false;
    console.info('[pace01] reschedule', { id: focus.id, previousDate, scheduledDate });
    return {
      plan,
      previousDate,
      scheduledDate,
      title: focus.title,
      message: `Misma sesión reprogramada al ${scheduledDate}. El plan no avanzó.`,
      next: focus
    };
  }

  /**
   * Día sin correr elegido por la persona, con una sesión de intervalos todavía abierta.
   * Registra recuperación y no cierra el PlanItem ni avanza la secuencia.
   */
  function registerVoluntaryRecovery(plan, logs, localDate) {
    try {
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
        message: 'Día de recuperación registrado. Es la misma sesión: tu progreso no avanzó.'
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
    confirmNextSession,
    markRestComplete,
    registerVoluntaryRecovery,
    skipFocus,
    rescheduleFocus,
    planStats,
    buildDefaultPlan
  };
})();

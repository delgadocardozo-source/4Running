/**
 * PACE/01 Adaptive Engine v4
 * Generador de prescripciones + perfil + límites de carga.
 * Reglas externas documentadas en PRODUCT.md (NHS C25K, Galloway, CDC RPE, Runna-like UX, BJSM load).
 * Parámetros numéricos propios de 4Running: DEFAULT_PARAMS (configurables).
 */
(() => {
  const ENGINE_VERSION = '4.0.0';

  /** Parámetros de diseño 4Running (no leyes científicas). */
  const DEFAULT_PARAMS = {
    beginnerSessionsPerWeek: 3,
    continuousStepSec: 30,
    continuousStepSecMin: 15,
    maxRunVolumeIncreasePct: 15,
    trendWindow: 3,
    minGoodSessionsForProgress: 2,
    pauseDaysForReassess: 10,
    horizonPendingRuns: 2,
    warmSeconds: 300,
    coolSeconds: 300,
    defaultWalkSeconds: 120,
    maxReps: 12,
    minReps: 4,
    maxContinuousSec: 30 * 60,
    minContinuousSec: 30
  };

  let clock = () => new Date();
  function setClock(fn) {
    clock = typeof fn === 'function' ? fn : () => new Date();
  }
  function now() {
    return clock();
  }
  function localDateISO(date = now()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function clone(v) {
    return structuredClone ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }

  function paramsOf(plan) {
    return { ...DEFAULT_PARAMS, ...(plan?.params || {}) };
  }

  function isRunLog(l) {
    return l && l.type !== 'Recuperación' && l.source !== 'rest' && l.kind !== 'recovery-gate' && l.execution !== 'skipped';
  }

  function isExternal(l) {
    return l && l.source === 'external';
  }

  function structureFromClassic(st) {
    return {
      mode: 'classic',
      warmSeconds: Number(st.warmSeconds) || DEFAULT_PARAMS.warmSeconds,
      coolSeconds: Number(st.coolSeconds) || DEFAULT_PARAMS.coolSeconds,
      runSeconds: Number(st.runSeconds) || 120,
      walkSeconds: Number(st.walkSeconds) || DEFAULT_PARAMS.defaultWalkSeconds,
      reps: Number(st.reps) || 7
    };
  }

  function metrics(st) {
    const s = structureFromClassic(st);
    const totalRun = s.runSeconds * s.reps;
    const totalWalk = s.walkSeconds * s.reps;
    const total = s.warmSeconds + s.coolSeconds + totalRun + totalWalk;
    return {
      ...s,
      totalRunSec: totalRun,
      totalWalkSec: totalWalk,
      totalSec: total,
      continuousSec: s.runSeconds,
      totalMin: Math.round(total / 60)
    };
  }

  function estimateKm(st, speeds = {}) {
    const s = structureFromClassic(st);
    const walk = Number(speeds.walkSpeed) || 5;
    const run = Number(speeds.runSpeed) || 7.5;
    const cool = Number(speeds.coolSpeed) || 4.5;
    return (walk * s.warmSeconds + cool * s.coolSeconds + (run * s.runSeconds + walk * s.walkSeconds) * s.reps) / 3600;
  }

  function describeStructure(st) {
    if (!st || st.rest) return 'Recuperación';
    const s = structureFromClassic(st);
    const fmt = (sec) => {
      const m = Math.floor(sec / 60);
      const r = sec % 60;
      if (r === 0) return `${m} min`;
      return `${m}:${String(r).padStart(2, '0')}`;
    };
    return `${fmt(s.runSeconds)} correr / ${fmt(s.walkSeconds)} caminar ×${s.reps}`;
  }

  function compareStructures(prev, next) {
    if (!prev || prev.rest || !next || next.rest) {
      return { lines: [], summary: next?.rest ? 'Sesión de recuperación' : 'Cambio de tipo' };
    }
    const a = metrics(prev);
    const b = metrics(next);
    const lines = [];
    if (a.continuousSec !== b.continuousSec) {
      const d = b.continuousSec - a.continuousSec;
      lines.push({
        key: 'continuous',
        label: 'Bloque continuo',
        from: a.continuousSec,
        to: b.continuousSec,
        deltaSec: d,
        text: `Bloque continuo: ${d >= 0 ? '+' : ''}${d} s`
      });
    }
    if (a.reps !== b.reps) {
      lines.push({
        key: 'reps',
        label: 'Repeticiones',
        from: a.reps,
        to: b.reps,
        delta: b.reps - a.reps,
        text: `Repeticiones: ${a.reps} → ${b.reps}`
      });
    }
    if (a.walkSeconds !== b.walkSeconds) {
      lines.push({
        key: 'walk',
        label: 'Caminata',
        from: a.walkSeconds,
        to: b.walkSeconds,
        deltaSec: b.walkSeconds - a.walkSeconds,
        text: `Caminata: ${a.walkSeconds}s → ${b.walkSeconds}s`
      });
    }
    if (a.totalRunSec !== b.totalRunSec) {
      lines.push({
        key: 'totalRun',
        label: 'Tiempo total corriendo',
        from: a.totalRunSec,
        to: b.totalRunSec,
        deltaSec: b.totalRunSec - a.totalRunSec,
        text: `Tiempo total corriendo: ${Math.round(a.totalRunSec / 60)} → ${Math.round(b.totalRunSec / 60)} min`
      });
    }
    if (a.totalMin !== b.totalMin) {
      lines.push({
        key: 'total',
        label: 'Duración total',
        from: a.totalMin,
        to: b.totalMin,
        delta: b.totalMin - a.totalMin,
        text: `Tiempo total: ${a.totalMin} → ${b.totalMin} min`
      });
    }
    const primary = lines.find(l => l.key === 'continuous')
      || lines.find(l => l.key === 'reps')
      || lines.find(l => l.key === 'walk')
      || null;
    return {
      lines,
      primary,
      sameLoad: lines.length === 0,
      summary: lines.length ? lines.map(l => l.text).join(' · ') : 'Misma carga (consolidación)'
    };
  }

  function validTrainingLogs(logs = []) {
    return (logs || [])
      .filter(isRunLog)
      .filter(l => !isExternal(l))
      .slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
  }

  function daysBetween(isoA, isoB) {
    if (!isoA || !isoB) return null;
    const [y1, m1, d1] = isoA.split('-').map(Number);
    const [y2, m2, d2] = isoB.split('-').map(Number);
    const a = new Date(y1, m1 - 1, d1);
    const b = new Date(y2, m2 - 1, d2);
    return Math.round((b - a) / 86400000);
  }

  /**
   * Perfil funcional derivado (no inventa datos faltantes).
   */
  function deriveProfile(logs = [], plan = null, settings = {}) {
    const p = paramsOf(plan);
    const valid = validTrainingLogs(logs);
    const completed = valid.filter(l => l.prescriptionCompleted !== false && l.execution !== 'aborted');
    const withRpe = completed.filter(l => l.rpe != null);
    const continuous = completed
      .map(l => Number(l.maxRunBlockSec) || 0)
      .filter(n => n > 0);
    const demonstratedContinuousSec = continuous.length ? Math.max(...continuous) : null;
    const last = valid[0] || null;
    const lastDate = last?.date || null;
    const gapDays = lastDate ? daysBetween(lastDate, localDateISO()) : null;

    let stage = 2;
    if (demonstratedContinuousSec == null && completed.length === 0) stage = 2;
    else if (demonstratedContinuousSec != null && demonstratedContinuousSec >= 30 * 60) stage = 5;
    else if (demonstratedContinuousSec != null && demonstratedContinuousSec >= 15 * 60) stage = 4;
    else if (demonstratedContinuousSec != null && demonstratedContinuousSec >= 5 * 60) stage = 3;
    else stage = 2;

    const recent = valid.slice(0, p.trendWindow);
    const recentGood = recent.filter(l =>
      l.prescriptionCompleted !== false &&
      l.execution !== 'aborted' &&
      Number(l.rpe) <= 5 &&
      !l.worseningDuringRun &&
      !l.alteredGait &&
      !l.forcedStop &&
      !l.severeWarning &&
      !(l.pain && Number(l.painIntensity || 0) >= 3)
    ).length;

    const recentHard = recent.filter(l =>
      Number(l.rpe) >= 7 ||
      l.prescriptionCompleted === false ||
      l.execution === 'aborted'
    ).length;

    let confidence = 'baja';
    if (withRpe.length >= 4 && continuous.length >= 3 && recent.length >= 3) confidence = 'alta';
    else if (withRpe.length >= 2 && completed.length >= 2) confidence = 'media';

    const lastRunItem = (plan?.sessions || [])
      .filter(s => s.kind === 'run' && s.status === 'completed')
      .sort((a, b) => (b.order || 0) - (a.order || 0))[0];
    const openRun = (plan?.sessions || []).find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
    const baselineStructure = structureFromClassic(
      openRun?.structure || lastRunItem?.structure || {
        warmSeconds: p.warmSeconds,
        coolSeconds: p.coolSeconds,
        runSeconds: 120,
        walkSeconds: p.defaultWalkSeconds,
        reps: 7
      }
    );

    return {
      engineVersion: ENGINE_VERSION,
      stage,
      stageLabel: ({
        1: 'Caminar',
        2: 'Caminar y trotar',
        3: 'Desarrollo continuo',
        4: 'Completar 5K',
        5: 'Mejorar rendimiento',
        6: 'Objetivos posteriores'
      })[stage] || 'Caminar y trotar',
      demonstratedContinuousSec,
      sessionsCompleted: completed.length,
      recentGood,
      recentHard,
      recentCount: recent.length,
      confidence,
      gapDays,
      needsReassess: gapDays != null && gapDays >= p.pauseDaysForReassess,
      baselineStructure,
      goalType: plan?.goal?.type || '5k_finish_runwalk',
      walkSpeed: settings.walkSpeed,
      runSpeed: settings.runSpeed,
      coolSpeed: settings.coolSpeed,
      updatedAt: localDateISO()
    };
  }

  function hasSafetyOverride(log) {
    return Boolean(log?.worseningDuringRun || log?.alteredGait || log?.forcedStop || log?.severeWarning);
  }

  function hasModeratePain(log) {
    return Boolean(log?.pain && Number(log.painIntensity || 0) >= 3);
  }

  function trendFavorable(logs, plan) {
    const p = paramsOf(plan);
    const valid = validTrainingLogs(logs).slice(0, p.trendWindow);
    if (valid.length < p.trendWindow) {
      return { ok: false, reason: `Menos de ${p.trendWindow} entrenamientos válidos para tendencia.`, sampleSize: valid.length };
    }
    const completed = valid.filter(l => l.prescriptionCompleted !== false && l.execution !== 'aborted');
    if (completed.length < p.minGoodSessionsForProgress) {
      return { ok: false, reason: 'Pocas sesiones completas en la ventana.', sampleSize: valid.length };
    }
    if (completed.some(l => Number(l.rpe) > 6)) {
      return { ok: false, reason: 'RPE > 6 en la ventana reciente.', sampleSize: valid.length };
    }
    if (valid.some(l => hasSafetyOverride(l) || hasModeratePain(l))) {
      return { ok: false, reason: 'Alertas de seguridad o molestia relevante en la ventana.', sampleSize: valid.length };
    }
    return { ok: true, reason: 'Tendencia favorable en la ventana reciente.', sampleSize: valid.length };
  }

  /**
   * Decisión adaptativa: progress | consolidate | repeat | reduce | recovery | reassess
   * Compat: progress/consolidate/reduce → progression advance; repeat; recovery
   */
  function decideAdaptive(log, priorLogs = [], plan = null) {
    const profile = deriveProfile([log, ...(priorLogs || [])], plan, {});
    const reasonCode = [];
    const completed = log.prescriptionCompleted !== false && log.execution !== 'aborted';
    const rpe = Number(log.rpe);

    if (hasSafetyOverride(log)) {
      reasonCode.push('SAFETY_OVERRIDE');
      return {
        action: 'recovery',
        progression: 'recovery',
        reason: 'Señal de seguridad: priorizamos recuperación antes de subir carga.',
        medicalNotice: Boolean(log.severeWarning),
        reasonCode,
        profile
      };
    }
    if (hasModeratePain(log)) {
      reasonCode.push('PAIN_MODERATE');
      return {
        action: 'recovery',
        progression: 'recovery',
        reason: 'Molestia relevante: recuperación antes de volver a la misma carga.',
        medicalNotice: false,
        reasonCode,
        profile
      };
    }
    if (!completed) {
      reasonCode.push('PRESCRIPTION_INCOMPLETE');
      const action = rpe >= 8 ? 'reduce' : 'repeat';
      return {
        action: action === 'reduce' ? 'reduce' : 'repeat',
        progression: action === 'reduce' ? 'advance' : 'repeat',
        adaptiveOnly: action,
        reason: action === 'reduce'
          ? 'Sesión incompleta y muy exigente: bajamos la carga en la próxima.'
          : 'No se completó la prescripción: repetimos este estímulo. Un RPE bajo no compensa un entrenamiento incompleto.',
        reasonCode,
        profile
      };
    }

    if (log.pain) {
      reasonCode.push('ALERT_PRESENT');
      return {
        action: 'repeat',
        progression: 'repeat',
        reason: 'Hubo molestia leve: mantenemos este nivel.',
        reasonCode,
        profile
      };
    }

    if (rpe >= 9) {
      reasonCode.push('RPE_VERY_HIGH');
      return {
        action: 'reduce',
        progression: 'advance',
        reason: 'Esfuerzo muy alto: bajamos la carga para recuperar tolerancia.',
        reasonCode,
        profile
      };
    }
    if (rpe >= 7) {
      reasonCode.push('RPE_HIGH');
      return {
        action: 'repeat',
        progression: 'repeat',
        reason: 'Esfuerzo alto: repetimos este estímulo sin aumentar.',
        reasonCode,
        profile
      };
    }

    // Poca evidencia: consolidar solo si el estímulo fue tolerable (RPE ya filtrado arriba).
    if (profile.confidence === 'baja' && validTrainingLogs([log, ...priorLogs]).length < 2) {
      reasonCode.push('LOW_EVIDENCE');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: 'Todavía hay poca evidencia: consolidamos este nivel antes de subir.',
        reasonCode,
        profile
      };
    }

    if (rpe === 6) {
      const trend = trendFavorable(priorLogs, plan);
      if (trend.ok && profile.recentGood >= 1) {
        reasonCode.push('RPE_6_TREND_OK');
        return {
          action: 'progress',
          progression: 'advance',
          reason: `Esfuerzo moderado-alto con tendencia aceptable: progresamos con cuidado. ${trend.reason}`,
          reasonCode,
          profile,
          trend
        };
      }
      reasonCode.push('RPE_6_HOLD');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: `Esfuerzo 6: consolidamos. ${trend.reason}`,
        reasonCode,
        profile,
        trend
      };
    }

    // RPE 1–5
    const trend = trendFavorable([log, ...priorLogs], plan);
    if (rpe <= 3 && (trend.ok || profile.recentGood >= 1 || profile.sessionsCompleted >= 1)) {
      reasonCode.push('RPE_LOW_PROGRESS');
      return {
        action: 'progress',
        progression: 'advance',
        reason: 'Buena tolerancia: aumentamos una variable de carga con límite conservador.',
        reasonCode,
        profile,
        trend
      };
    }
    if (rpe <= 5) {
      if (trend.ok && profile.recentGood >= paramsOf(plan).minGoodSessionsForProgress) {
        reasonCode.push('RPE_MID_PROGRESS');
        return {
          action: 'progress',
          progression: 'advance',
          reason: 'Tolerancia adecuada y tendencia favorable: progresamos.',
          reasonCode,
          profile,
          trend
        };
      }
      reasonCode.push('RPE_MID_CONSOLIDATE');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: 'Sesión bien tolerada: consolidamos este nivel (una sola sesión buena no basta para un salto grande).',
        reasonCode,
        profile,
        trend
      };
    }

    reasonCode.push('FALLBACK_REPEAT');
    return {
      action: 'repeat',
      progression: 'repeat',
      reason: 'Mantenemos este estímulo.',
      reasonCode,
      profile
    };
  }

  function withinLoadLimits(base, candidate, params, stage) {
    const a = metrics(base);
    const b = metrics(candidate);
    const runDeltaPct = a.totalRunSec > 0 ? ((b.totalRunSec - a.totalRunSec) / a.totalRunSec) * 100 : 0;
    const contDelta = b.continuousSec - a.continuousSec;
    const stepCap = stage <= 3 ? params.continuousStepSec : params.continuousStepSec * 2;

    if (contDelta > stepCap) {
      return { ok: false, reason: `Continuo +${contDelta}s supera el paso máximo (${stepCap}s).` };
    }
    if (runDeltaPct > params.maxRunVolumeIncreasePct + 0.01) {
      return { ok: false, reason: `Volumen de carrera +${runDeltaPct.toFixed(1)}% supera ${params.maxRunVolumeIncreasePct}%.` };
    }
    const changed = [];
    if (a.continuousSec !== b.continuousSec) changed.push('continuous');
    if (a.reps !== b.reps) changed.push('reps');
    if (a.walkSeconds !== b.walkSeconds) changed.push('walk');
    if (changed.length > 1) {
      return { ok: false, reason: 'Más de una variable principal de dificultad cambió a la vez.' };
    }
    if (b.reps > params.maxReps || b.reps < params.minReps) {
      return { ok: false, reason: 'Repeticiones fuera de rango.' };
    }
    if (b.continuousSec > params.maxContinuousSec || b.continuousSec < params.minContinuousSec) {
      return { ok: false, reason: 'Continuo fuera de rango.' };
    }
    return { ok: true, runDeltaPct, contDelta, changed: changed[0] || null };
  }

  function candidate(base, patch, label, primaryVar) {
    const st = structureFromClassic({ ...structureFromClassic(base), ...patch });
    return { structure: st, label, primaryVar, metrics: metrics(st) };
  }

  /** Estructura base según etapa (no inventa capacidades no demostradas). */
  function structureForProfile(profile, fallback) {
    const params = DEFAULT_PARAMS;
    if (profile?.stage >= 5 && profile.demonstratedContinuousSec >= 20 * 60) {
      const cont = Math.min(
        Math.max(profile.demonstratedContinuousSec, 20 * 60),
        params.maxContinuousSec
      );
      return structureFromClassic({
        warmSeconds: params.warmSeconds,
        coolSeconds: params.coolSeconds,
        runSeconds: cont,
        walkSeconds: 0,
        reps: 1
      });
    }
    if (profile?.needsReassess && profile.demonstratedContinuousSec) {
      const soft = Math.max(
        params.minContinuousSec,
        Math.round(profile.demonstratedContinuousSec * 0.7 / 15) * 15
      );
      return structureFromClassic({
        warmSeconds: params.warmSeconds,
        coolSeconds: params.coolSeconds,
        runSeconds: Math.min(soft, 5 * 60),
        walkSeconds: profile.demonstratedContinuousSec >= 5 * 60 ? 60 : params.defaultWalkSeconds,
        reps: profile.demonstratedContinuousSec >= 5 * 60 ? 1 : 6
      });
    }
    return structureFromClassic(fallback || profile?.baselineStructure);
  }

  function generateCandidates(baseStructure, action, profile, plan) {
    const params = paramsOf(plan);
    let base = structureFromClassic(baseStructure);
    if (profile?.stage >= 5 && base.walkSeconds > 0 && profile.demonstratedContinuousSec >= 20 * 60) {
      base = structureForProfile(profile, base);
    }
    if (action === 'reassess') {
      base = structureForProfile({ ...profile, needsReassess: true }, base);
    }
    const list = [];

    if (action === 'repeat' || action === 'consolidate') {
      list.push(candidate(base, {}, 'Misma carga', null));
    }
    if (action === 'reduce') {
      if (base.reps > params.minReps) {
        list.push(candidate(base, { reps: base.reps - 1 }, 'Una repetición menos', 'reps'));
      }
      if (base.runSeconds - params.continuousStepSecMin >= params.minContinuousSec) {
        list.push(candidate(base, { runSeconds: base.runSeconds - params.continuousStepSecMin }, 'Continuo un poco más corto', 'continuous'));
      }
      if (base.walkSeconds > 0 && base.walkSeconds < 180) {
        list.push(candidate(base, { walkSeconds: base.walkSeconds + 30 }, 'Más caminata de recuperación', 'walk'));
      }
      list.push(candidate(base, {}, 'Misma carga (si no hay reducción viable)', null));
    }
    if (action === 'progress' || action === 'reassess') {
      const step = profile.stage >= 5 && base.walkSeconds === 0
        ? Math.max(params.continuousStepSec, 60)
        : params.continuousStepSec;
      list.push(candidate(base, { runSeconds: base.runSeconds + step }, `Continuo +${step}s`, 'continuous'));
      if (base.reps < params.maxReps && base.walkSeconds > 0) {
        list.push(candidate(base, { reps: base.reps + 1 }, 'Una repetición más', 'reps'));
      }
      // Variante: menos reps pero más continuo (reorganizar) — si el volumen cabe
      if (base.reps > params.minReps && base.walkSeconds > 0) {
        list.push(candidate(base, {
          reps: base.reps - 1,
          runSeconds: base.runSeconds + step
        }, `Reorganizar: −1 rep y continuo +${step}s`, 'continuous'));
      }
      if (base.walkSeconds >= 90) {
        list.push(candidate(base, { walkSeconds: base.walkSeconds - 30 }, 'Caminata un poco más corta', 'walk'));
      }
    }

    const filtered = [];
    for (const c of list) {
      if (action === 'repeat' || (action === 'consolidate' && c.primaryVar == null)) {
        filtered.push({ ...c, limit: { ok: true } });
        continue;
      }
      if (c.primaryVar == null && action === 'reduce') {
        filtered.push({ ...c, limit: { ok: true } });
        continue;
      }
      // reorganizar cambia continuo+reps → withinLoadLimits rechaza multi-var; skip or special-case
      if (c.label.startsWith('Reorganizar')) {
        const a = metrics(base);
        const b = c.metrics;
        const runDeltaPct = a.totalRunSec > 0 ? ((b.totalRunSec - a.totalRunSec) / a.totalRunSec) * 100 : 0;
        const contDelta = b.continuousSec - a.continuousSec;
        const stepCap = profile.stage <= 3 ? params.continuousStepSec : params.continuousStepSec * 2;
        if (contDelta <= stepCap && runDeltaPct <= params.maxRunVolumeIncreasePct) {
          filtered.push({
            ...c,
            limit: { ok: true, runDeltaPct, contDelta, changed: 'restructure' },
            primaryVar: 'restructure'
          });
        }
        continue;
      }
      const limit = withinLoadLimits(base, c.structure, params, profile.stage);
      if (limit.ok) filtered.push({ ...c, limit });
    }

    if (!filtered.length) {
      filtered.push({ ...candidate(base, {}, 'Consolidación forzada (sin candidato seguro)', null), limit: { ok: true } });
    }
    return filtered;
  }

  function pickCandidate(candidates, action) {
    if (!candidates.length) return null;
    if (action === 'progress') {
      return candidates.find(c => c.primaryVar === 'continuous')
        || candidates.find(c => c.primaryVar === 'restructure')
        || candidates.find(c => c.primaryVar === 'reps')
        || candidates[0];
    }
    if (action === 'reduce') {
      return candidates.find(c => c.primaryVar === 'reps')
        || candidates.find(c => c.primaryVar === 'continuous')
        || candidates[0];
    }
    return candidates[0];
  }

  function nextOrder(plan) {
    const max = (plan.sessions || []).reduce((m, s) => Math.max(m, Number(s.order) || 0), 0);
    return max + 1;
  }

  function makeRestItem(plan, note) {
    const order = nextOrder(plan);
    return {
      id: `rest-${Date.now()}-${order}`,
      weekGroup: Math.ceil(order / 4),
      order,
      kind: 'rest',
      title: 'Recuperación',
      status: 'pending',
      scheduledDate: null,
      blockedUntilRest: false,
      structure: { rest: true, note: note || 'Descanso entre estímulos. La progresión se apoya en esto.' },
      attempts: [],
      engineVersion: ENGINE_VERSION,
      generated: true
    };
  }

  function makeRunItem(plan, structure, meta = {}) {
    const order = nextOrder(plan);
    const st = structureFromClassic(structure);
    const m = metrics(st);
    return {
      id: `run-${Date.now()}-${order}`,
      weekGroup: Math.ceil(order / 4),
      order,
      kind: 'run',
      title: meta.title || `Sesión adaptativa · ${describeStructure(st)}`,
      status: 'pending',
      scheduledDate: meta.scheduledDate || null,
      blockedUntilRest: false,
      structure: st,
      attempts: [],
      engineVersion: ENGINE_VERSION,
      generated: true,
      sessionGoal: meta.sessionGoal || 'Desarrollar tolerancia run/walk',
      justification: meta.justification || '',
      decisionAction: meta.action || null,
      changeSummary: meta.changeSummary || null,
      prescribedContinuousSec: m.continuousSec,
      prescribedTotalRunSec: m.totalRunSec,
      estimatedDurationMin: m.totalMin
    };
  }

  function lastCompletedRunStructure(plan) {
    const runs = (plan.sessions || [])
      .filter(s => s.kind === 'run' && s.status === 'completed')
      .sort((a, b) => (b.order || 0) - (a.order || 0));
    return runs[0]?.structure || null;
  }

  function pendingRuns(plan) {
    return (plan.sessions || []).filter(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
  }

  function openItems(plan) {
    return (plan.sessions || []).filter(s => s.status === 'pending' || s.status === 'rescheduled');
  }

  /**
   * Tras una decisión, asegura horizonte de sesiones pendientes.
   */
  function ensureHorizon(plan, logs, settings, decision = null) {
    const profile = deriveProfile(logs, plan, settings || {});
    const params = paramsOf(plan);
    plan.athleteProfile = profile;
    plan.engineVersion = ENGINE_VERSION;
    plan.version = 4;

    // Si hay gate de recovery, no generar corridas encima
    const blocked = (plan.sessions || []).find(s => s.kind === 'run' && s.blockedUntilRest && (s.status === 'pending' || s.status === 'rescheduled'));
    if (blocked) return plan;

    let guard = 0;
    while (pendingRuns(plan).length < params.horizonPendingRuns && guard < 6) {
      guard += 1;
      const base = lastCompletedRunStructure(plan)
        || pendingRuns(plan)[0]?.structure
        || profile.baselineStructure;
      const action = decision?.action
        || (profile.needsReassess ? 'reassess' : 'consolidate');
      const effectiveAction = action === 'repeat' ? 'consolidate' : action;
      const candidates = generateCandidates(base, effectiveAction === 'recovery' ? 'consolidate' : effectiveAction, profile, plan);
      const picked = pickCandidate(candidates, effectiveAction === 'recovery' ? 'consolidate' : effectiveAction);
      const diff = compareStructures(base, picked.structure);

      // Descanso entre corridas para etapas tempranas si el último ítem abierto/cerrado fue un run
      const sorted = [...(plan.sessions || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
      const lastAny = sorted[sorted.length - 1];
      if (profile.stage <= 4 && lastAny?.kind === 'run') {
        plan.sessions.push(makeRestItem(plan, 'Recuperación entre estímulos (principio NHS C25K / Galloway).'));
      }

      plan.sessions.push(makeRunItem(plan, picked.structure, {
        action: effectiveAction,
        justification: decision?.reason || `Generado por motor ${ENGINE_VERSION} · acción ${effectiveAction}.`,
        changeSummary: diff,
        sessionGoal: profile.stage <= 2
          ? 'Construir tolerancia caminar/trotar'
          : profile.stage <= 4
            ? 'Desarrollar carrera continua hacia 5K'
            : 'Mejorar rendimiento'
      }));
    }
    return plan;
  }

  function migratePlanToV4(plan, logs = [], settings = {}) {
    const next = clone(plan || { sessions: [] });
    if (!Array.isArray(next.sessions)) next.sessions = [];
    if (next.version >= 4 && next.engineVersion) {
      next.params = { ...DEFAULT_PARAMS, ...(next.params || {}) };
      return ensureHorizon(next, logs, settings);
    }
    next.version = 4;
    next.engineVersion = ENGINE_VERSION;
    next.params = { ...DEFAULT_PARAMS, ...(next.params || {}) };
    next.goal = next.goal || {
      type: '5k_finish_runwalk',
      label: 'Completar 5K con estrategia run/walk',
      raceDate: next.raceDate || null,
      checkpointDate: next.checkpointDate || null
    };
    next.fiveKDefinition = next.fiveKDefinition
      || 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).';
    next.migratedFrom = plan?.version || 3;
    next.migratedAt = localDateISO();
    next.athleteProfile = deriveProfile(logs, next, settings);
    // Si el plan v3 quedó sin pendientes, generar horizonte (corrige PLAN AL DÍA)
    return ensureHorizon(next, logs, settings, { action: 'consolidate', reason: 'Migración v4: continuidad del plan.' });
  }

  function buildDiffMessage(prevStructure, nextStructure, decision) {
    const diff = compareStructures(prevStructure, nextStructure);
    return {
      action: decision?.action || 'consolidate',
      actionLabel: ({
        progress: 'Progresar',
        consolidate: 'Consolidar',
        repeat: 'Repetir',
        reduce: 'Reducir carga',
        recovery: 'Recuperación',
        reassess: 'Reevaluar'
      })[decision?.action] || 'Consolidar',
      previous: describeStructure(prevStructure),
      next: describeStructure(nextStructure),
      lines: diff.lines,
      summary: diff.summary,
      reason: decision?.reason || '',
      sameLoad: diff.sameLoad
    };
  }

  window.PaceAdaptive = {
    ENGINE_VERSION,
    DEFAULT_PARAMS,
    setClock,
    now,
    localDateISO,
    paramsOf,
    structureFromClassic,
    metrics,
    estimateKm,
    describeStructure,
    compareStructures,
    deriveProfile,
    trendFavorable,
    decideAdaptive,
    generateCandidates,
    pickCandidate,
    withinLoadLimits,
    ensureHorizon,
    migratePlanToV4,
    buildDiffMessage,
    makeRunItem,
    makeRestItem,
    structureForProfile,
    validTrainingLogs,
    pendingRuns,
    openItems
  };
})();

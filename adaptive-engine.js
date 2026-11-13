/**
 * PACE/01 Adaptive Engine v4.1 (Fase 2)
 * Evolución multidimensional, carrera continua, velocidades sugeridas, calendario.
 * Referencias y parámetros propios: PRODUCT.md
 */
(() => {
  const ENGINE_VERSION = '4.4.0';

  /** Catálogo de objetivos de producto (intake + ajustes). */
  const GOAL_CATALOG = {
    habit: { type: 'habit', label: 'Crear el hábito de correr', horizonDays: 84 },
    '5k_finish_runwalk': { type: '5k_finish_runwalk', label: 'Completar 5K (run/walk)', horizonDays: 56 },
    '5k_pb': { type: '5k_pb', label: 'Mejorar mi 5K', horizonDays: 70 },
    '10k': { type: '10k', label: 'Preparar 10K', horizonDays: 84 },
    maintenance: { type: 'maintenance', label: 'Mantener forma', horizonDays: 90 }
  };

  /**
   * Capacidad continua declarada en onboarding → stage + segundos de referencia.
   * No sustituye evidencia real: los logs ganan cuando existen.
   */
  const CONTINUOUS_ABILITY = {
    unknown: { key: 'unknown', stage: 1, demonstratedSec: 0, label: 'Tolerancia por observar' },
    none: { key: 'none', stage: 1, demonstratedSec: 0, label: 'Casi no corro / solo camino' },
    '1min': { key: '1min', stage: 2, demonstratedSec: 90, label: 'Hasta 1–2 min seguidos' },
    '5min': { key: '5min', stage: 3, demonstratedSec: 5 * 60, label: 'Hasta ~5 min seguidos' },
    '15min': { key: '15min', stage: 4, demonstratedSec: 15 * 60, label: 'Hasta ~15 min seguidos' },
    '30min': { key: '30min', stage: 5, demonstratedSec: 28 * 60, label: 'Hasta ~30 min seguidos' },
    '30plus': { key: '30plus', stage: 5, demonstratedSec: 35 * 60, label: 'Más de 30 min seguidos' }
  };

  /** Parámetros de diseño 4Running (configurables; no leyes científicas). */
  const DEFAULT_PARAMS = {
    beginnerSessionsPerWeek: 3,
    sessionsPerWeek: 3,
    minRestDaysBetweenRuns: 1,
    continuousStepSec: 30,
    continuousStepSecMin: 15,
    continuousStepLongSec: 60,
    continuousStepEasySec: 120,
    maxRunVolumeIncreasePct: 15,
    maxRunVolumeDecreaseExplainPct: 20,
    trendWindow: 3,
    minGoodSessionsForProgress: 2,
    pauseDaysForReassess: 10,
    horizonPendingRuns: 2,
    controlTestEveryCompletedRuns: 6,
    controlTestSec: 12 * 60,
    paceSuggestMinSamples: 2,
    warmSeconds: 300,
    coolSeconds: 300,
    defaultWalkSeconds: 120,
    maxReps: 12,
    minReps: 3,
    maxContinuousSec: 45 * 60,
    minContinuousSec: 30,
    continuousMergeThresholdSec: 8 * 60,
    speedSuggestMinComparable: 3,
    speedSuggestMaxDeltaKmh: 0.5,
    speedSuggestMaxRpe: 4,
    /** Hitos orientativos (no secuencia fija). */
    continuousMilestonesSec: [120, 150, 180, 240, 300, 480, 600, 900, 1200, 1500, 1800]
  };

  const ACTION_LABELS = {
    progress: 'Progresar',
    progress_continuous: 'Progresión de continuo',
    progress_volume: 'Progresión de volumen',
    progress_performance: 'Progresión de rendimiento',
    consolidate: 'Consolidar',
    repeat: 'Repetir',
    reduce: 'Reducir carga',
    recovery: 'Recuperación',
    reassess: 'Reevaluar'
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
  function addDaysISO(iso, n) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return localDateISO(dt);
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
    if (!st || st.rest) return st;
    const walkRaw = st.walkSeconds;
    const walkSeconds = walkRaw == null || walkRaw === ''
      ? DEFAULT_PARAMS.defaultWalkSeconds
      : Number(walkRaw);
    return {
      mode: st.mode || 'classic',
      warmSeconds: Number(st.warmSeconds) || DEFAULT_PARAMS.warmSeconds,
      coolSeconds: Number(st.coolSeconds) || DEFAULT_PARAMS.coolSeconds,
      runSeconds: st.runSeconds == null ? 120 : Math.max(0, Number(st.runSeconds) || 0),
      walkSeconds: Number.isFinite(walkSeconds) ? walkSeconds : DEFAULT_PARAMS.defaultWalkSeconds,
      reps: Number(st.reps) || 7,
      blocks: Array.isArray(st.blocks) ? st.blocks : null
    };
  }

  function metrics(st) {
    const s = structureFromClassic(st);
    if (s.blocks && s.blocks.length) {
      let totalRun = 0;
      let totalWalk = 0;
      let continuousSec = 0;
      for (const b of s.blocks) {
        if (b.type === 'run') {
          totalRun += Number(b.seconds) || 0;
          continuousSec = Math.max(continuousSec, Number(b.seconds) || 0);
        } else if (b.type === 'walk') {
          totalWalk += Number(b.seconds) || 0;
        }
      }
      const total = s.warmSeconds + s.coolSeconds + totalRun + totalWalk;
      return {
        ...s,
        totalRunSec: totalRun,
        totalWalkSec: totalWalk,
        totalSec: total,
        continuousSec,
        totalMin: Math.round(total / 60),
        isContinuous: totalWalk === 0 && continuousSec > 0
      };
    }
    const totalRun = s.runSeconds * s.reps;
    const totalWalk = s.walkSeconds * s.reps;
    const total = s.warmSeconds + s.coolSeconds + totalRun + totalWalk;
    return {
      ...s,
      totalRunSec: totalRun,
      totalWalkSec: totalWalk,
      totalSec: total,
      continuousSec: s.runSeconds,
      totalMin: Math.round(total / 60),
      isContinuous: s.walkSeconds === 0 && s.reps === 1
    };
  }

  function estimateKm(st, speeds = {}) {
    const s = structureFromClassic(st);
    const walk = Number(speeds.walkSpeed) || 5;
    const run = Number(speeds.runSpeed) || 7.5;
    const cool = Number(speeds.coolSpeed) || 4.5;
    const m = metrics(s);
    return (walk * s.warmSeconds + cool * s.coolSeconds + run * m.totalRunSec + walk * m.totalWalkSec) / 3600;
  }

  function formatBlockSec(sec) {
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    if (r === 0) return `${m} min`;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function describeStructure(st) {
    if (!st || st.rest) return 'Recuperación';
    const s = structureFromClassic(st);
    if (s.blocks && s.blocks.length) {
      return s.blocks.map(b => `${formatBlockSec(b.seconds)} ${b.type === 'run' ? 'correr' : 'caminar'}`).join(' · ');
    }
    if (s.runSeconds === 0) return `${formatBlockSec(s.walkSeconds * s.reps)} caminata cómoda + calentamiento y vuelta a la calma`;
    if (!s.walkSeconds) {
      return s.reps === 1
        ? `${formatBlockSec(s.runSeconds)} carrera continua`
        : `${formatBlockSec(s.runSeconds)} carrera ×${s.reps} (sin caminata)`;
    }
    return `${formatBlockSec(s.runSeconds)} correr / ${formatBlockSec(s.walkSeconds)} caminar ×${s.reps}`;
  }

  function compareStructures(prev, next) {
    if (!prev || prev.rest || !next || next.rest) {
      return { lines: [], summary: next?.rest ? 'Sesión de recuperación' : 'Cambio de tipo', interpretation: null };
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
        text: `Bloque continuo: ${d >= 0 ? '+' : ''}${d} s (${formatBlockSec(a.continuousSec)} → ${formatBlockSec(b.continuousSec)})`
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
        text: `Caminata: ${formatBlockSec(a.walkSeconds)} → ${formatBlockSec(b.walkSeconds)}`
      });
    }
    if (a.totalRunSec !== b.totalRunSec) {
      lines.push({
        key: 'totalRun',
        label: 'Carrera acumulada',
        from: a.totalRunSec,
        to: b.totalRunSec,
        deltaSec: b.totalRunSec - a.totalRunSec,
        text: `Carrera acumulada: ${formatBlockSec(a.totalRunSec)} → ${formatBlockSec(b.totalRunSec)}`
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

    const contUp = b.continuousSec > a.continuousSec;
    const volDown = b.totalRunSec < a.totalRunSec;
    const volUp = b.totalRunSec > a.totalRunSec;
    let dimension = 'maintain';
    let interpretation = 'Misma carga (consolidación).';
    if (contUp && volDown) {
      dimension = 'continuous';
      interpretation = 'Aumentamos el tiempo de carrera continua y reducimos ligeramente el volumen acumulado para equilibrar la exigencia. No es una pérdida de rendimiento.';
    } else if (contUp && !volUp) {
      dimension = 'continuous';
      interpretation = 'Priorizamos resistencia continua; el volumen acumulado se mantiene estable.';
    } else if (contUp && volUp) {
      dimension = 'continuous';
      interpretation = 'Subimos el bloque continuo y el volumen de carrera dentro del tope de carga.';
    } else if (volUp && !contUp) {
      dimension = 'volume';
      interpretation = 'Priorizamos volumen (más carrera acumulada) manteniendo el bloque continuo.';
    } else if (a.walkSeconds > b.walkSeconds) {
      dimension = 'continuous';
      interpretation = 'Acortamos la caminata para acercarnos a carrera más sostenida, sin subir velocidad.';
    } else if (b.isContinuous && !a.isContinuous) {
      dimension = 'continuous';
      interpretation = 'Pasamos a un bloque de carrera continua (sin caminata intercalada).';
    } else if (lines.length === 0) {
      dimension = 'maintain';
      interpretation = 'Misma estructura: consolidamos la adaptación.';
    } else if (volDown && !contUp) {
      dimension = 'recovery_load';
      interpretation = 'Reducimos la carga acumulada para recuperar tolerancia.';
    }

    const primary = lines.find(l => l.key === 'continuous')
      || lines.find(l => l.key === 'reps')
      || lines.find(l => l.key === 'walk')
      || null;

    return {
      lines,
      primary,
      dimension,
      interpretation,
      previousMetrics: a,
      nextMetrics: b,
      sameLoad: lines.length === 0,
      summary: lines.length ? lines.map(l => l.text).join(' · ') : 'Misma carga (consolidación)'
    };
  }

  function compareAttemptRecency(a, b) {
    const day = String(b.date || '').localeCompare(String(a.date || ''));
    if (day) return day;
    const timeA = Date.parse(a.createdAt || a.startedAt || '') || 0;
    const timeB = Date.parse(b.createdAt || b.startedAt || '') || 0;
    return timeB - timeA || (Number(b.attemptSequence) || 0) - (Number(a.attemptSequence) || 0);
  }

  function validTrainingLogs(logs = []) {
    return (logs || []).map((log, index) => ({ log, index }))
      .filter(({ log }) => isRunLog(log) && !isExternal(log))
      .sort((a, b) => compareAttemptRecency(a.log, b.log) || b.index - a.index)
      .map(({ log }) => log);
  }

  function durationOfLog(log) {
    if (log.elapsedSec != null && log.elapsedSec !== '') return Number(log.elapsedSec);
    if (!log.time) return null;
    const parts = String(log.time).split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
    return parts.reduce((sum, n) => sum * 60 + n, 0);
  }

  function evidenceForLog(log) {
    const errors = [];
    const rpe = log.rpe == null || log.rpe === '' ? NaN : Number(log.rpe);
    const continuous = log.maxRunBlockSec == null || log.maxRunBlockSec === '' ? NaN : Number(log.maxRunBlockSec);
    const elapsed = durationOfLog(log);
    if (!Number.isFinite(rpe) || rpe < 0 || rpe > 10) errors.push('Esfuerzo sin confirmar o fuera de 0–10.');
    if (typeof log.pain !== 'boolean') errors.push('Molestias sin confirmar.');
    if (!Number.isFinite(continuous) || continuous < 0 || continuous > 14400) errors.push('Tiempo continuo sin confirmar o fuera de rango.');
    if (elapsed != null && (!Number.isFinite(elapsed) || elapsed <= 0 || continuous > elapsed + 1)) errors.push('El continuo no es coherente con la duración registrada.');
    const blocks = Array.isArray(log.blocks) ? log.blocks : [];
    if (log.source === 'timer' && !blocks.length) errors.push('Faltan los bloques observados del cronómetro.');
    let observedMax = 0;
    let observedTotal = 0;
    for (const block of blocks) {
      const actual = Number(block.actualSeconds);
      const prescribed = Number(block.prescribedSeconds);
      const run = block.runSeconds != null ? Number(block.runSeconds) : block.type === 'run' ? actual : 0;
      const longest = block.longestRunSeconds != null ? Number(block.longestRunSeconds) : run;
      if (![actual, prescribed, run, longest].every(Number.isFinite) || actual < 0 || prescribed <= 0 || run < 0 || run > actual + 1 || longest < 0 || longest > run + 1) errors.push('Bloques observados incoherentes.');
      observedTotal += Number.isFinite(actual) ? actual : 0;
      observedMax = Math.max(observedMax, Number.isFinite(longest) ? longest : 0);
    }
    if (blocks.length && continuous > observedMax + 1) errors.push('El continuo supera los tramos corridos observados.');
    if (blocks.length && elapsed != null && Math.abs(observedTotal - elapsed) > Math.max(2, blocks.length * 0.25)) errors.push('La duración no coincide con los bloques observados.');
    if (log.confidence === 'low' || log.confidence === 'baja') errors.push('El registro sigue siendo provisional.');
    return { sufficient: errors.length === 0, errors, rpe, continuous, elapsed, observedMax };
  }

  function trainingConfidence(logs = [], plan = null) {
    const valid = validTrainingLogs(logs);
    const complete = valid.filter(log => observedCompletion(log) && evidenceForLog(log).sufficient);
    const latest = valid[0];
    if (!latest || !evidenceForLog(latest).sufficient || !complete.length) return { confidence: 'baja', confidenceLabel: 'Confianza baja', note: 'Datos esenciales incompletos o incoherentes: la propuesta sigue siendo provisional.' };
    if (complete.length >= 4 && valid.slice(0, 3).every(log => evidenceForLog(log).sufficient)) return { confidence: 'alta', confidenceLabel: 'Confianza alta', note: 'Registros completos, coherentes y suficientes para evaluar la evolución reciente.' };
    return { confidence: 'media', confidenceLabel: 'Confianza media', note: 'Una sesión con esfuerzo, cumplimiento y continuo observado permite un ajuste gradual; la tendencia aún es provisional.' };
  }

  function daysBetween(isoA, isoB) {
    if (!isoA || !isoB) return null;
    const [y1, m1, d1] = isoA.split('-').map(Number);
    const [y2, m2, d2] = isoB.split('-').map(Number);
    const a = new Date(y1, m1 - 1, d1);
    const b = new Date(y2, m2 - 1, d2);
    return Math.round((b - a) / 86400000);
  }

  function assessCaution(logs = [], plan = null) {
    const p = paramsOf(plan);
    const valid = validTrainingLogs(logs);
    const last = valid[0];
    const reasons = [];
    if (!last) {
      return { level: 'none', label: null, reasons: ['Sin entrenamientos recientes para evaluar precaución.'] };
    }
    if (Number(last.rpe) >= 7) reasons.push(`Último RPE ${last.rpe}/10: esfuerzo alto.`);
    if (last.pain) reasons.push('Molestia reportada en la última sesión.');
    if (last.prescriptionCompleted === false || last.execution === 'aborted') {
      reasons.push('La última prescripción no se completó.');
    }
    if (hasSafetyOverride(last)) reasons.push('Señal de seguridad en la última sesión.');
    const gap = last.date ? daysBetween(last.date, localDateISO()) : null;
    if (gap != null && gap >= p.pauseDaysForReassess) {
      reasons.push(`Pausa de ${gap} días: conviene reevaluar antes de subir carga.`);
    }
    const hardRecent = valid.slice(0, p.trendWindow).filter(l => Number(l.rpe) >= 7).length;
    if (hardRecent >= 2) reasons.push('Varias sesiones recientes con RPE alto.');

    if (!reasons.length) {
      return { level: 'none', label: null, reasons: ['Sin factores de precaución activos.'] };
    }
    return {
      level: hasSafetyOverride(last) || Number(last.rpe) >= 9 ? 'alta' : 'moderada',
      label: 'Precaución',
      reasons
    };
  }

  function priorityDimensionFor(profile, plan) {
    const goal = plan?.goal?.type || profile?.goalType || '5k_finish_runwalk';
    const cont = profile?.demonstratedContinuousSec || 0;
    if (profile?.needsReassess) return 'recovery';
    if (goal === '5k_pb' || goal === 'performance' || goal === '10k') {
      if (cont >= 20 * 60) return 'performance';
      return 'continuous';
    }
    if (goal === 'maintenance' && cont >= 20 * 60) return 'consistency';
    if (cont >= 30 * 60) return 'volume';
    if (cont >= 20 * 60) return 'volume';
    if (profile?.stage <= 4) return 'continuous';
    return 'volume';
  }

  function stageFromContinuousSec(sec) {
    if (sec == null) return null;
    if (sec <= 0) return 1;
    if (sec >= 30 * 60) return 5;
    if (sec >= 15 * 60) return 4;
    if (sec >= 5 * 60) return 3;
    return 2;
  }

  function deriveProfile(logs = [], plan = null, settings = {}) {
    const p = paramsOf(plan);
    const valid = validTrainingLogs(logs);
    const completed = valid.filter(l => l.prescriptionCompleted !== false && l.execution !== 'aborted');
    const withRpe = completed.filter(l => l.rpe != null);
    const continuous = valid.filter(l => evidenceForLog(l).sufficient)
      .map(l => Number(l.maxRunBlockSec) || 0)
      .filter(n => n > 0);
    const fromLogs = continuous.length ? Math.max(...continuous) : null;
    const declaredSec = plan?.intake?.declaredContinuousSec;
    // Logs reales mandan; el intake solo arranca el perfil.
    const demonstratedContinuousSec = fromLogs;
    const confirmedDistances = completed
      .filter(l => typeof l.distanceKm === 'number' && l.distanceEstimated === false)
      .map(l => l.distanceKm);
    const last = valid[0] || null;
    const lastDate = last?.date || null;
    const gapDays = lastDate ? daysBetween(lastDate, localDateISO()) : null;

    let stage = stageFromContinuousSec(demonstratedContinuousSec);
    if (stage == null) {
      stage = Number(plan?.intake?.intakeStage) || 2;
    }
    if (completed.length === 0 && Number(plan?.intake?.intakeStage)) {
      stage = Number(plan.intake.intakeStage);
    }

    if ((plan?.goal?.type === '10k' || plan?.goal?.type === '5k_pb') && stage >= 5) stage = 6;

    const recent = valid.slice(0, p.trendWindow);
    const recentGood = recent.filter(l =>
      evidenceForLog(l).sufficient &&
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

    const confidenceResult = trainingConfidence(logs, plan);
    const confidence = confidenceResult.confidence;
    const confidenceNote = confidenceResult.note;

    const caution = assessCaution(logs, plan);

    const lastRunItem = (plan?.sessions || [])
      .filter(s => s.kind === 'run' && s.status === 'completed')
      .sort((a, b) => (b.order || 0) - (a.order || 0))[0];
    const openRun = (plan?.sessions || []).find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled'));
    const intakeAbility = plan?.intake?.continuousAbility || null;
    const intakeFallback = startingStructureForAbility(intakeAbility || '1min', {
      conservative: Boolean(plan?.intake?.hasPain)
    });
    const baselineStructure = structureFromClassic(
      openRun?.structure || lastRunItem?.structure || intakeFallback
    );

    const profile = {
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
      declaredContinuousSec: declaredSec != null ? Number(declaredSec) : null,
      maxConfirmedDistanceKm: confirmedDistances.length ? Math.max(...confirmedDistances) : null,
      sessionsCompleted: completed.length,
      recentGood,
      recentHard,
      recentCount: recent.length,
      confidence,
      confidenceNote,
      caution: plan?.intake?.hasPain && completed.length === 0
        ? {
            ...(assessCaution(logs, plan) || {}),
            level: 'moderate',
            reasons: [
              ...((assessCaution(logs, plan) || {}).reasons || []),
              'Indicaste molestia en el onboarding: arrancamos más conservador.'
            ].filter(Boolean)
          }
        : caution,
      gapDays,
      needsReassess: gapDays != null && gapDays >= p.pauseDaysForReassess,
      baselineStructure,
      goalType: plan?.goal?.type || '5k_finish_runwalk',
      intakeAbility,
      walkSpeed: settings.walkSpeed,
      runSpeed: settings.runSpeed,
      coolSpeed: settings.coolSpeed,
      updatedAt: localDateISO()
    };
    profile.priorityDimension = priorityDimensionFor(profile, plan);
    return profile;
  }

  function startingStructureForAbility(abilityKey, opts = {}) {
    const params = DEFAULT_PARAMS;
    const soft = Boolean(opts.conservative);
    const key = CONTINUOUS_ABILITY[abilityKey] ? abilityKey : '1min';
    const map = {
      unknown: { runSeconds: 0, walkSeconds: 300, reps: 1 },
      none: {
        runSeconds: 30,
        walkSeconds: soft ? 120 : 90,
        reps: soft ? 5 : 6
      },
      '1min': {
        runSeconds: soft ? 45 : 60,
        walkSeconds: 120,
        reps: soft ? 5 : 6
      },
      '5min': {
        runSeconds: soft ? 3 * 60 : 4 * 60,
        walkSeconds: soft ? 120 : 90,
        reps: soft ? 4 : 5
      },
      '15min': {
        runSeconds: soft ? 10 * 60 : 12 * 60,
        walkSeconds: 0,
        reps: 1
      },
      '30min': {
        runSeconds: soft ? 22 * 60 : 25 * 60,
        walkSeconds: 0,
        reps: 1
      },
      '30plus': {
        runSeconds: soft ? 28 * 60 : 32 * 60,
        walkSeconds: 0,
        reps: 1
      }
    };
    const patch = map[key] || map['1min'];
    return structureFromClassic({
      warmSeconds: params.warmSeconds,
      coolSeconds: params.coolSeconds,
      ...patch
    });
  }

  function normalizeIntake(raw = {}) {
    const abilityKey = CONTINUOUS_ABILITY[raw.continuousAbility] ? raw.continuousAbility : '1min';
    const ability = CONTINUOUS_ABILITY[abilityKey];
    const goalKey = GOAL_CATALOG[raw.goalType] ? raw.goalType : '5k_finish_runwalk';
    const goal = GOAL_CATALOG[goalKey];
    const sessionsPerWeek = Math.min(4, Math.max(2, Number(raw.sessionsPerWeek) || 3));
    const requestedSessionsPerWeek = Math.min(4, Math.max(sessionsPerWeek, Number(raw.requestedSessionsPerWeek) || sessionsPerWeek));
    const environment = ['outdoor', 'treadmill', 'both'].includes(raw.environment)
      ? raw.environment
      : 'both';
    const hasPain = Boolean(raw.hasPain);
    let intakeStage = ability.stage;
    if ((goal.type === '10k' || goal.type === '5k_pb') && ability.stage >= 5) intakeStage = 6;
    if (hasPain && intakeStage > 1) intakeStage = Math.max(1, intakeStage - 1);
    const runSpeed = Number(raw.runSpeed);
    let assessment = ['walk', 'jog', 'run', 'history'].includes(raw.assessment) ? raw.assessment : 'later';
    if (assessment === 'run' && ['none', 'unknown'].includes(abilityKey)) assessment = 'walk';
    if (assessment === 'jog' && !['15', '30'].includes(raw.walkTolerance)) assessment = 'walk';
    return {
      recentActivity: ['none', 'walk', 'run', 'unknown'].includes(raw.recentActivity) ? raw.recentActivity : 'unknown',
      walkTolerance: raw.walkTolerance || 'unknown',
      availableMinutes: Math.max(15, Math.min(60, Number(raw.availableMinutes) || 30)),
      assessment,
      goalType: goal.type,
      continuousAbility: abilityKey,
      sessionsPerWeek,
      requestedSessionsPerWeek,
      frequencyConfirmed: Boolean(raw.frequencyConfirmed),
      environment,
      hasPain,
      painNote: hasPain ? String(raw.painNote || '').trim() : '',
      runSpeed: Number.isFinite(runSpeed) && runSpeed >= 5 && runSpeed <= 16 ? runSpeed : null,
      raceDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.raceDate || '')) ? raw.raceDate : null,
      intakeStage,
      declaredContinuousSec: hasPain
        ? Math.max(0, Math.round(ability.demonstratedSec * 0.75))
        : ability.demonstratedSec,
      completedAt: null
    };
  }

  function initialPrescription(intake) {
    let st = startingStructureForAbility(intake.continuousAbility, { conservative: intake.hasPain });
    if (intake.assessment === 'walk' || intake.hasPain || ['unknown', 'none'].includes(intake.continuousAbility) && intake.assessment !== 'jog') {
      st = structureFromClassic({ warmSeconds: 300, coolSeconds: 300, runSeconds: 0, walkSeconds: 300, reps: 1 });
    } else if (intake.assessment === 'jog') {
      st = structureFromClassic({ warmSeconds: 300, coolSeconds: 300, runSeconds: intake.continuousAbility === 'none' ? 30 : 60, walkSeconds: 90, reps: 4 });
    }
    if (intake.recentActivity === 'none' && st.runSeconds > 60) { st.runSeconds = Math.round(st.runSeconds * 0.75 / 15) * 15; }
    const budget = intake.availableMinutes * 60 - st.warmSeconds - st.coolSeconds;
    if (st.reps === 1) st.runSeconds = Math.min(st.runSeconds, Math.max(0, budget - st.walkSeconds));
    else st.reps = Math.max(1, Math.min(st.reps, Math.floor(budget / (st.runSeconds + st.walkSeconds))));
    return st;
  }

  function buildPlanFromIntake(rawIntake = {}, settings = {}) {
    const intake = normalizeIntake(rawIntake);
    intake.completedAt = localDateISO();
    const goal = GOAL_CATALOG[intake.goalType] || GOAL_CATALOG['5k_finish_runwalk'];
    const raceDate = intake.raceDate;
    const checkpointDate = addDaysISO(localDateISO(), 21);
    const structure = initialPrescription(intake);
    const plan = {
      version: 4,
      engineVersion: ENGINE_VERSION,
      onboardingCompleted: true,
      intake,
      goal: {
        type: goal.type,
        label: goal.label,
        raceDate,
        checkpointDate
      },
      raceDate,
      checkpointDate,
      loadPolicy: 'Una variable de carga principal por progresión: duración/volumen primero, velocidad después.',
      fiveKDefinition: 'Listo = intentar terminar 5K con estrategia run/walk (no 5K continuo sin caminar).',
      params: {
        ...DEFAULT_PARAMS,
        sessionsPerWeek: intake.sessionsPerWeek,
        beginnerSessionsPerWeek: intake.sessionsPerWeek
      },
      scheduleAnchorDate: localDateISO(),
      requestedSessionsPerWeek: intake.requestedSessionsPerWeek,
      frequencyConfirmed: intake.frequencyConfirmed,
      sessions: [],
      pendingSpeedSuggestion: null
    };
    plan.athleteProfile = deriveProfile([], plan, settings);
    plan.sessions.push(makeRunItem(plan, structure, {
      title: intake.hasPain ? 'Pausar y revisar la molestia' : intake.assessment === 'later' ? 'Sesión 1 · Propuesta provisional' : 'Evaluación cómoda',
      isAssessment: !intake.hasPain && ['walk', 'jog', 'run'].includes(intake.assessment),
      action: 'consolidate',
      sessionGoal: 'Confirmar tu nivel de entrada',
      justification: `Elegimos esta sesión porque declaraste: ${CONTINUOUS_ABILITY[intake.continuousAbility].label}, actividad reciente ${({'none':'escasa','walk':'de caminatas','run':'de carrera','unknown':'por confirmar'})[intake.recentActivity]} y ${intake.availableMinutes} minutos disponibles. ${intake.assessment === 'later' ? 'Propuesta provisional: la ajustaremos al observarte.' : 'Evaluación cómoda, sin buscar tu máximo.'}`,
      primaryDimension: plan.athleteProfile.priorityDimension,
      estimatedKm: estimateKm(structure, settings)
    }));
    plan.sessions[0].isAssessment = !intake.hasPain && ['walk', 'jog', 'run'].includes(intake.assessment);
    plan.sessions[0].blockedUntilRest = intake.hasPain;
    return ensureHorizon(plan, [], settings, {
      action: 'consolidate',
      reason: 'Plan inicial personalizado desde onboarding.'
    });
  }

  /**
   * Recalibración explícita del usuario sobre la próxima sesión pendiente.
   * direction: 'easier' | 'harder'
   */
  function constrainPrescription(structure, plan, fallback = structure) {
    let st = structureFromClassic(structure);
    const intake = plan?.intake;
    const fallbackSt = structureFromClassic(fallback);
    if (intake && fallbackSt.runSeconds === 0 && !plan.walkToJogAcceptedAt) return fallbackSt;
    const budget = Math.max(0, (Number(intake?.availableMinutes) || 180) * 60 - st.warmSeconds - st.coolSeconds);
    if (st.reps === 1) {
      if (st.runSeconds > 0) st.runSeconds = Math.max(0, Math.min(st.runSeconds, budget - st.walkSeconds));
      else st.walkSeconds = Math.min(st.walkSeconds, budget);
    } else st.reps = Math.max(1, Math.min(st.reps, Math.floor(budget / Math.max(1, st.runSeconds + st.walkSeconds))));
    if (metrics(st).totalSec > (Number(intake?.availableMinutes) || 180) * 60) return fallbackSt;
    return st;
  }

  function applyStructureToRun(openRun, structure, settings, prev, direction) {
    openRun.structure = structureFromClassic(structure);
    openRun.changeSummary = compareStructures(prev, openRun.structure);
    openRun.justification = direction === 'harder'
      ? 'Recalibración pedida por vos: un poco más exigente.'
      : 'Recalibración pedida por vos: un poco más suave.';
    openRun.decisionAction = direction === 'harder' ? 'progress_continuous' : 'reduce';
    openRun.title = `Sesión · ${describeStructure(openRun.structure)}`;
    const m = metrics(openRun.structure);
    openRun.prescribedContinuousSec = m.continuousSec;
    openRun.prescribedTotalRunSec = m.totalRunSec;
    openRun.estimatedDurationMin = m.totalMin;
    openRun.estimatedKm = estimateKm(openRun.structure, settings);
  }

  /** Carga comparable: prioriza continuo, luego volumen de carrera, luego reps. */
  function loadRank(st) {
    const m = metrics(st);
    return (m.continuousSec * 1000) + (m.totalRunSec * 10) + (Number(st.reps) || 0);
  }

  /**
   * Piso seguro: no bajar de la estructura de onboarding (ni de la última sesión
   * completa razonable). Evita aplastar a 4×30s por muchos “me queda difícil”.
   */
  function sessionFloorStructure(plan, logs = [], settings = {}) {
    const profile = deriveProfile(logs, plan, settings);
    const intakeKey = plan?.intake?.continuousAbility || profile.intakeAbility || '1min';
    const conservative = Boolean(plan?.intake?.hasPain || profile.caution);
    let floor = plan?.intake ? initialPrescription(plan.intake) : startingStructureForAbility(intakeKey, { conservative });
    const completed = validTrainingLogs(logs)
      .filter(l => evidenceForLog(l).sufficient && l.prescriptionCompleted !== false && l.execution !== 'aborted' && Number(l.rpe) <= 7)
      .slice(0, 3);
    for (const log of completed) {
      const sid = log.planSessionId;
      const sess = sid ? (plan?.sessions || []).find(s => s.id === sid) : null;
      const st = sess?.structure || log.structure || null;
      if (!st || st.rest) continue;
      const classic = structureFromClassic(st);
      if (loadRank(classic) > loadRank(floor)) floor = classic;
    }
    // Intervalos: caminata mínima 60s (0:30 no es recuperación útil).
    if (floor.walkSeconds > 0 && floor.walkSeconds < 60) {
      floor = structureFromClassic({ ...floor, walkSeconds: 60 });
    }
    return constrainPrescription(floor, plan, plan?.intake ? initialPrescription(plan.intake) : floor);
  }

  function isAtOrBelowFloor(structure, floor) {
    return loadRank(structureFromClassic(structure)) <= loadRank(structureFromClassic(floor));
  }

  function filterCandidatesAboveFloor(candidates, floor, action) {
    if (normalizeProgressAction(action) !== 'reduce') return candidates;
    const kept = (candidates || []).filter(c => {
      if (!c?.structure) return false;
      if (c.primaryVar == null) return true;
      return loadRank(c.structure) >= loadRank(floor);
    });
    return kept.length ? kept : candidates;
  }

  function refreshStaleSchedule(session, today = localDateISO()) {
    if (!session) return session;
    const d = session.scheduledDate;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
      session.scheduledDate = today;
      return session;
    }
    if (String(d) < today) {
      session.scheduledDate = today;
      if (session.status === 'rescheduled') session.status = 'pending';
    }
    return session;
  }

  /**
   * Ajusta SOLO la próxima sesión pendiente.
   * No borra ni regenera el resto del horizonte (evita desconfigurar el plan entero).
   */
  function recalibrateLoad(plan, logs = [], settings = {}, direction = 'easier') {
    const next = clone(plan || { sessions: [] });
    const openRun = (next.sessions || []).find(s =>
      s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled')
    );
    if (!openRun) {
      return { plan: next, changed: false, message: 'No hay una sesión pendiente para recalibrar.' };
    }
    if (openRun.blockedUntilRest) return { plan: next, changed: false, message: 'Mantenemos la pausa por síntomas antes de ajustar la carga.' };
    refreshStaleSchedule(openRun);
    const profile = deriveProfile(logs, next, settings);
    const floor = sessionFloorStructure(next, logs, settings);
    if (direction === 'easier' && isAtOrBelowFloor(openRun.structure, floor)) {
      return {
        plan: next,
        changed: false,
        message: `Ya estás en el piso seguro (${describeStructure(floor)}). Si duele, registrá recuperación; si quedó mal el plan, restablecé la sesión desde Ajustes.`
      };
    }
    const action = direction === 'harder' ? 'progress_continuous' : 'reduce';
    let candidates = generateCandidates(openRun.structure, action, profile, next);
    candidates = filterCandidatesAboveFloor(candidates, floor, action);
    const picked = pickCandidate(candidates, action);
    if (!picked?.structure) {
      return { plan: next, changed: false, message: 'No encontramos un ajuste viable ahora.' };
    }
    const prev = structureFromClassic(openRun.structure);
    let neo = structureFromClassic(picked.structure);
    if (direction === 'easier' && loadRank(neo) < loadRank(floor)) {
      neo = structureFromClassic(floor);
    }
    const same = describeStructure(prev) === describeStructure(neo);
    let chosen = neo;
    if (same && direction === 'harder') {
      const vol = generateCandidates(openRun.structure, 'progress_volume', profile, next);
      const pickVol = pickCandidate(vol, 'progress_volume');
      if (pickVol?.structure && describeStructure(pickVol.structure) !== describeStructure(prev)) {
        chosen = structureFromClassic(pickVol.structure);
      } else {
        return {
          plan: next,
          changed: false,
          message: 'Ya estás en un estímulo alto para tu nivel actual. Completá una sesión y reevaluamos.'
        };
      }
    } else if (same) {
      return {
        plan: next,
        changed: false,
        message: 'No se pudo suavizar más sin salir del rango seguro. Si duele, registrá recuperación.'
      };
    }
    chosen = constrainPrescription(chosen, next, prev);
    if (describeStructure(prev) === describeStructure(chosen)) return { plan: next, changed: false, message: 'El ajuste no cabe en tu tiempo disponible o requiere confirmar antes una prueba de trote.' };
    applyStructureToRun(openRun, chosen, settings, prev, direction);
    next.lastRecalibration = {
      at: localDateISO(),
      direction,
      sessionId: openRun.id,
      previousStructure: clone(prev),
      from: describeStructure(prev),
      to: describeStructure(openRun.structure),
      undone: false
    };
    return {
      plan: next,
      changed: true,
      previous: describeStructure(prev),
      next: describeStructure(openRun.structure),
      sessionId: openRun.id,
      message: direction === 'harder'
        ? `Subimos un poco la próxima sesión: ${describeStructure(openRun.structure)}.`
        : `Bajamos un poco la próxima sesión: ${describeStructure(openRun.structure)}.`
    };
  }

  function undoRecalibration(plan, settings = {}) {
    const next = clone(plan || { sessions: [] });
    const snap = next.lastRecalibration;
    if (!snap || snap.undone || !snap.previousStructure || !snap.sessionId) {
      return { plan: next, changed: false, message: 'No hay un ajuste reciente para deshacer.' };
    }
    const openRun = (next.sessions || []).find(s => s.id === snap.sessionId);
    if (!openRun || openRun.kind !== 'run') {
      return { plan: next, changed: false, message: 'No encontramos la sesión ajustada.' };
    }
    if (!(openRun.status === 'pending' || openRun.status === 'rescheduled')) {
      return { plan: next, changed: false, message: 'Esa sesión ya no está pendiente; no se puede deshacer.' };
    }
    const current = structureFromClassic(openRun.structure);
    const restored = structureFromClassic(snap.previousStructure);
    openRun.structure = restored;
    openRun.changeSummary = compareStructures(current, restored);
    openRun.justification = 'Deshiciste el ajuste manual; volviste a la sesión anterior.';
    openRun.decisionAction = 'undo_recalibration';
    openRun.title = `Sesión · ${describeStructure(restored)}`;
    const m = metrics(restored);
    openRun.prescribedContinuousSec = m.continuousSec;
    openRun.prescribedTotalRunSec = m.totalRunSec;
    openRun.estimatedDurationMin = m.totalMin;
    openRun.estimatedKm = estimateKm(restored, settings);
    refreshStaleSchedule(openRun);
    next.lastRecalibration = {
      ...snap,
      undone: true,
      undoneAt: localDateISO()
    };
    return {
      plan: next,
      changed: true,
      previous: describeStructure(current),
      next: describeStructure(restored),
      message: `Volvimos a: ${describeStructure(restored)}.`
    };
  }

  /**
   * Reconstruye la próxima sesión pendiente desde el nivel de onboarding/perfil.
   * Para planes aplastados (p. ej. 4×30s) donde deshacer ya no alcanza.
   */
  function restoreFocusSession(plan, logs = [], settings = {}) {
    const next = clone(plan || { sessions: [] });
    const openRun = (next.sessions || []).find(s =>
      s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled')
    );
    if (!openRun) {
      return { plan: next, changed: false, message: 'No hay una sesión pendiente para restablecer.' };
    }
    const prev = structureFromClassic(openRun.structure);
    if (openRun.blockedUntilRest) return { plan: next, changed: false, message: 'Mantenemos la pausa por síntomas antes de restablecer la sesión.' };
    const profile = deriveProfile(logs, next, settings);
    const floor = sessionFloorStructure(next, logs, settings);
    // null fallback → usa intakeAbility / stage del perfil (nivel de onboarding).
    const initial = next.intake ? initialPrescription(next.intake) : floor;
    const fromProfile = profile.demonstratedContinuousSec > 0 && prev.runSeconds > 0 ? structureFromClassic(structureForProfile(profile, null) || floor) : initial;
    const strongerReference = loadRank(fromProfile) >= loadRank(floor) ? fromProfile : floor;
    const chosen = constrainPrescription(strongerReference, next, prev);
    const beforeDate = openRun.scheduledDate;
    refreshStaleSchedule(openRun);
    if (describeStructure(prev) === describeStructure(chosen)) {
      const dateFixed = beforeDate !== openRun.scheduledDate;
      return {
        plan: next,
        changed: dateFixed,
        previous: describeStructure(prev),
        next: describeStructure(chosen),
        message: dateFixed
          ? `La estructura ya era razonable; actualizamos la fecha a hoy.`
          : `La próxima ya está en un nivel razonable: ${describeStructure(chosen)}.`
      };
    }
    openRun.structure = chosen;
    openRun.changeSummary = compareStructures(prev, chosen);
    openRun.justification = 'Restableciste la sesión al nivel de tu perfil / onboarding.';
    openRun.decisionAction = 'restore_profile';
    openRun.title = `Sesión · ${describeStructure(chosen)}`;
    const m = metrics(chosen);
    openRun.prescribedContinuousSec = m.continuousSec;
    openRun.prescribedTotalRunSec = m.totalRunSec;
    openRun.estimatedDurationMin = m.totalMin;
    openRun.estimatedKm = estimateKm(chosen, settings);
    refreshStaleSchedule(openRun);
    next.lastRecalibration = {
      at: localDateISO(),
      direction: 'restore',
      sessionId: openRun.id,
      previousStructure: clone(prev),
      from: describeStructure(prev),
      to: describeStructure(chosen),
      undone: false
    };
    return {
      plan: next,
      changed: true,
      previous: describeStructure(prev),
      next: describeStructure(chosen),
      message: `Restablecimos la próxima sesión: ${describeStructure(chosen)}.`
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
    const fail = reason => ({ ok: false, reason, sampleSize: valid.length });
    if (valid.length < p.trendWindow) return fail(`Menos de ${p.trendWindow} intentos válidos para tendencia.`);
    if (valid.some(log => !evidenceForLog(log).sufficient)) return fail('Datos esenciales incompletos o incoherentes en la ventana reciente.');
    const completed = valid.filter(observedCompletion);
    if (completed.length < p.minGoodSessionsForProgress) return fail('Menos de dos intentos completos en la ventana reciente.');
    if (completed.some(log => Number(log.rpe) > 6)) return fail('Algún intento completo reciente tuvo esfuerzo superior a 6/10.');
    if (valid.some(log => log.pain || hasSafetyOverride(log) || hasModeratePain(log))) return fail('Hay molestias o alertas en los últimos intentos.');
    const chronological = completed.slice().reverse();
    const first = chronological[0], last = chronological.at(-1);
    const effortWorse = Number(last.rpe) - Number(first.rpe) >= 2;
    const continuousWorse = Number(first.maxRunBlockSec) > 0 && Number(last.maxRunBlockSec) < Number(first.maxRunBlockSec) * 0.8;
    const previous = completed[1];
    const recentWorse = previous && Number(last.rpe) > Number(previous.rpe) && Number(last.maxRunBlockSec) < Number(previous.maxRunBlockSec);
    if (effortWorse || continuousWorse || recentWorse) return fail('Deterioro sostenido de esfuerzo o tiempo continuo observado.');
    if (trainingConfidence(valid, plan).confidence === 'baja') return fail('Confianza baja: mantenemos una propuesta provisional.');
    return { ok: true, reason: 'Últimos tres intentos: al menos dos completos, esfuerzo hasta 6/10, sin deterioro ni alertas y con evidencia suficiente.', sampleSize: valid.length };
  }

  function mapProgressAction(profile, plan) {
    const dim = priorityDimensionFor(profile, plan);
    if (dim === 'performance') return 'progress_performance';
    if (dim === 'volume') return 'progress_volume';
    return 'progress_continuous';
  }

  /**
   * Decisión adaptativa (conserva comportamiento Fase 1 validado).
   */
  function observedCompletion(log) {
    if (Array.isArray(log.blocks) && log.blocks.length) return log.blocks.every(b => Number(b.actualSeconds) + 0.25 >= Number(b.prescribedSeconds) && !b.convertedToWalk);
    return log.prescriptionCompleted === true || log.execution === 'completed' && log.prescriptionCompleted !== false;
  }

  function decideAdaptive(log, priorLogs = [], plan = null) {
    const profile = deriveProfile([log, ...priorLogs], plan, {});
    const caution = assessCaution([log, ...priorLogs], plan);
    const result = (action, progression, reason, code, extra = {}) => ({ action, progression, reason, reasonCode: [code], profile, caution, priorityDimension: progression === 'recovery' ? 'recovery' : 'continuous', ...extra });
    if (hasSafetyOverride(log) || hasModeratePain(log)) return result('recovery', 'recovery', 'Suspendemos la progresión. No vuelvas a correr con síntomas que empeoran o alteran tu marcha; revisá la molestia antes de retomar.', 'SAFETY_OVERRIDE', { medicalNotice: Boolean(log.severeWarning) });
    const complete = observedCompletion(log);
    if (!complete) return result('repeat', 'repeat', 'Guardamos lo realizado. La próxima mantiene los mismos intervalos porque quedaron bloques incompletos.', 'PRESCRIPTION_INCOMPLETE');
    const rpe = log.rpe == null || log.rpe === '' ? NaN : Number(log.rpe);
    const evidence = evidenceForLog(log);
    if (!evidence.sufficient || profile.confidence === 'baja') return result('repeat', 'repeat', 'Propuesta provisional: confirmá esfuerzo, molestias y tramo continuo observado antes de aumentar.', 'LOW_EVIDENCE');
    if (log.pain) return result('repeat', 'repeat', 'Completaste la sesión con molestia. Mantenemos los intervalos y revisamos cómo evoluciona.', 'ALERT_PRESENT');
    if (rpe >= 7) return result('repeat', 'repeat', 'Completaste la sesión. La próxima mantiene los mismos intervalos por el esfuerzo registrado (7/10 o más).', 'RPE_HIGH');
    const interruptedDose = log.source === 'timer' && Array.isArray(log.blocks) && log.blocks.some(block => (block.type === 'run' || block.prescribedType === 'run') && block.longestRunSeconds != null && Number(block.longestRunSeconds) + 1 < Number(block.prescribedSeconds));
    if (interruptedDose) return result('repeat', 'repeat', 'Completaste el tiempo acumulado de carrera. Antes de ampliar el bloque, confirmemos el tramo prescrito sin interrupción; la próxima mantiene los mismos intervalos.', 'CONTINUOUS_NOT_CONFIRMED');
    if (Number(log.maxRunBlockSec) === 0) return result('repeat', 'repeat', 'Completaste la caminata cómoda. Si caminar ya es cómodo y podías conversar, podés elegir una prueba corta de trote sin rehacer tus respuestas.', 'WALK_OBSERVED');
    const last = validTrainingLogs(priorLogs)[0];
    if (last && daysBetween(last.date, log.date) >= paramsOf(plan).pauseDaysForReassess) return result('repeat', 'repeat', 'Tras una pausa larga, repetimos esta sesión cómoda para confirmar tolerancia antes de aumentar.', 'PAUSE_REASSESS');
    if (rpe === 6) {
      const trend = trendFavorable([log, ...priorLogs], plan);
      if (!trend.ok) return result('repeat', 'repeat', `Mantenemos los intervalos con esfuerzo 6/10. ${trend.reason}`, 'RPE_6_HOLD', { trend });
      return result('progress_continuous', 'advance', 'Los últimos tres intentos muestran buena tolerancia: ampliamos gradualmente el tramo de trote.', 'RPE_6_TREND_OK', { trend });
    }
    return result(mapProgressAction(profile, plan), 'advance', 'Completaste todos los bloques con esfuerzo cómodo. Aumentamos gradualmente el tiempo de carrera.', 'RPE_LOW_PROGRESS');
  }

  function continuousStepFor(baseSec, params, profile) {
    if (baseSec >= 15 * 60) return params.continuousStepEasySec;
    if (baseSec >= 8 * 60 || (profile?.stage >= 4 && baseSec >= 5 * 60)) return params.continuousStepLongSec;
    if (baseSec < 120) return params.continuousStepSecMin;
    return params.continuousStepSec;
  }

  function nextMilestone(currentSec, milestones) {
    return milestones.find(m => m > currentSec) || null;
  }

  function withinLoadLimits(base, candidate, params, stage, opts = {}) {
    const a = metrics(base);
    const b = metrics(candidate);
    const runDeltaPct = a.totalRunSec > 0 ? ((b.totalRunSec - a.totalRunSec) / a.totalRunSec) * 100 : 0;
    const contDelta = b.continuousSec - a.continuousSec;
    const stepCap = opts.stepCap != null
      ? opts.stepCap
      : (stage <= 3 ? params.continuousStepSec : Math.max(params.continuousStepSec, params.continuousStepLongSec));

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
    if (!opts.allowMulti && changed.length > 1) {
      return { ok: false, reason: 'Más de una variable principal de dificultad cambió a la vez.' };
    }
    const minReps = b.walkSeconds === 0 ? 1 : params.minReps;
    if (b.reps > params.maxReps || b.reps < minReps) {
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
      const asContinuous = soft >= 8 * 60;
      return structureFromClassic({
        warmSeconds: params.warmSeconds,
        coolSeconds: params.coolSeconds,
        runSeconds: Math.min(soft, asContinuous ? soft : 5 * 60),
        walkSeconds: asContinuous ? 0 : (profile.demonstratedContinuousSec >= 5 * 60 ? 60 : params.defaultWalkSeconds),
        reps: asContinuous ? 1 : (profile.demonstratedContinuousSec >= 5 * 60 ? 1 : 6)
      });
    }
    if (profile?.stage === 1 && !fallback) {
      return startingStructureForAbility('none', { conservative: true });
    }
    if (profile?.intakeAbility && !fallback) {
      return startingStructureForAbility(profile.intakeAbility, { conservative: false });
    }
    return structureFromClassic(fallback || profile?.baselineStructure);
  }

  function normalizeProgressAction(action) {
    if (action === 'progress') return 'progress_continuous';
    return action;
  }

  function generateCandidates(baseStructure, action, profile, plan) {
    const params = paramsOf(plan);
    let base = structureFromClassic(baseStructure);
    const rawAction = normalizeProgressAction(action);
    if (profile?.stage >= 5 && base.walkSeconds > 0 && profile.demonstratedContinuousSec >= 20 * 60) {
      base = structureForProfile(profile, base);
    }
    if (rawAction === 'reassess') {
      base = structureForProfile({ ...profile, needsReassess: true }, base);
    }
    const list = [];
    const step = continuousStepFor(base.runSeconds, params, profile);
    if (['progress_continuous', 'progress'].includes(rawAction) && base.runSeconds > 0 && base.runSeconds < 120) {
      const safeStep = Math.max(1, Math.floor(base.runSeconds * params.maxRunVolumeIncreasePct / 100));
      list.push(candidate(base, { runSeconds: base.runSeconds + Math.min(step, safeStep) }, `Trote cómodo +${Math.min(step, safeStep)}s`, 'continuous'));
    }

    if (rawAction === 'repeat' || rawAction === 'consolidate') {
      list.push(candidate(base, {}, 'Misma carga', null));
    }
    if (rawAction === 'reduce') {
      if (base.reps > (base.walkSeconds === 0 ? 1 : params.minReps)) {
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

    const wantContinuous = rawAction === 'progress_continuous' || rawAction === 'progress' || rawAction === 'reassess';
    const wantVolume = rawAction === 'progress_volume';
    const wantPerf = rawAction === 'progress_performance';

    if (wantContinuous || wantVolume || wantPerf || rawAction === 'progress') {
      // Continuo + reorganización (prioridad principiantes / C25K)
      if (wantContinuous || wantPerf || rawAction === 'progress') {
        const milestone = nextMilestone(base.runSeconds, params.continuousMilestonesSec);
        const targetCont = milestone && (milestone - base.runSeconds) <= step * 2
          ? Math.min(base.runSeconds + step, milestone)
          : base.runSeconds + step;

        if (base.walkSeconds === 0) {
          list.push(candidate(base, { runSeconds: Math.min(targetCont, params.maxContinuousSec) }, `Continuo +${step}s`, 'continuous'));
        } else {
          list.push(candidate(base, { runSeconds: targetCont }, `Continuo +${targetCont - base.runSeconds}s`, 'continuous'));
          if (base.reps > params.minReps) {
            list.push(candidate(base, {
              reps: base.reps - 1,
              runSeconds: targetCont
            }, `Reorganizar: −1 rep y continuo más largo`, 'restructure'));
          }
          // Fusionar a carrera continua cuando el bloque es largo
          if (base.runSeconds >= params.continuousMergeThresholdSec || (base.reps <= 3 && base.runSeconds >= 5 * 60)) {
            const mergeSec = Math.min(
              Math.max(base.runSeconds, Math.round(base.runSeconds * base.reps * 0.55)),
              Math.round(base.runSeconds * base.reps * 1.0),
              params.maxContinuousSec
            );
            const capped = Math.min(mergeSec, Math.round(metrics(base).totalRunSec * (1 + params.maxRunVolumeIncreasePct / 100)));
            list.push(candidate(base, {
              runSeconds: Math.max(base.runSeconds, capped),
              walkSeconds: 0,
              reps: 1
            }, 'Pasar a carrera continua', 'restructure'));
          }
          if (base.walkSeconds >= 60) {
            list.push(candidate(base, { walkSeconds: Math.max(0, base.walkSeconds - 30) }, 'Caminata más corta', 'walk'));
          }
        }
      }

      if (wantVolume || (!wantContinuous && rawAction === 'progress')) {
        if (base.walkSeconds === 0) {
          list.push(candidate(base, {
            runSeconds: Math.min(base.runSeconds + params.continuousStepEasySec, params.maxContinuousSec)
          }, 'Más duración fácil', 'continuous'));
        } else if (base.reps < params.maxReps) {
          list.push(candidate(base, { reps: base.reps + 1 }, 'Una repetición más', 'reps'));
        }
      }

      if (wantPerf && base.walkSeconds === 0) {
        // Intervalos de rendimiento ligeros: no cambiar velocidad aquí (solo estructura)
        const work = Math.min(3 * 60, Math.max(60, Math.round(base.runSeconds / 6)));
        const easy = Math.min(2 * 60, work);
        const reps = 4;
        list.push({
          structure: structureFromClassic({
            warmSeconds: params.warmSeconds,
            coolSeconds: params.coolSeconds,
            runSeconds: work,
            walkSeconds: easy,
            reps
          }),
          label: `Intervalos rendimiento ${formatBlockSec(work)}/${formatBlockSec(easy)} ×${reps}`,
          primaryVar: 'performance',
          metrics: metrics({
            warmSeconds: params.warmSeconds,
            coolSeconds: params.coolSeconds,
            runSeconds: work,
            walkSeconds: easy,
            reps
          })
        });
        list.push(candidate(base, {
          runSeconds: Math.min(base.runSeconds + params.continuousStepEasySec, params.maxContinuousSec)
        }, 'Fácil más largo (base aeróbica)', 'continuous'));
      }
    }

    const filtered = [];
    for (const c of list) {
      if (plan?.intake?.availableMinutes && c.metrics.totalSec > Math.max(metrics(base).totalSec, plan.intake.availableMinutes * 60)) continue;
      if (rawAction === 'repeat' || (rawAction === 'consolidate' && c.primaryVar == null)) {
        filtered.push({ ...c, limit: { ok: true } });
        continue;
      }
      if (c.primaryVar == null && rawAction === 'reduce') {
        filtered.push({ ...c, limit: { ok: true } });
        continue;
      }
      if (c.primaryVar === 'restructure' || c.primaryVar === 'performance' || String(c.label).startsWith('Reorganizar') || String(c.label).startsWith('Pasar')) {
        const a = metrics(base);
        const b = c.metrics;
        const runDeltaPct = a.totalRunSec > 0 ? ((b.totalRunSec - a.totalRunSec) / a.totalRunSec) * 100 : 0;
        const contDelta = b.continuousSec - a.continuousSec;
        const stepCap = continuousStepFor(a.continuousSec, params, profile) * (c.primaryVar === 'performance' ? 3 : 2);
        if (runDeltaPct <= params.maxRunVolumeIncreasePct + 0.5 && contDelta <= Math.max(stepCap, params.continuousStepEasySec)) {
          filtered.push({
            ...c,
            limit: { ok: true, runDeltaPct, contDelta, changed: c.primaryVar || 'restructure' },
            primaryVar: c.primaryVar || 'restructure'
          });
        }
        continue;
      }
      const limit = withinLoadLimits(base, c.structure, params, profile.stage || 2, {
        stepCap: continuousStepFor(base.runSeconds, params, profile)
      });
      if (limit.ok) filtered.push({ ...c, limit });
    }

    if (!filtered.length) {
      filtered.push({ ...candidate(base, {}, 'Consolidación forzada (sin candidato seguro)', null), limit: { ok: true } });
    }
    return filtered;
  }

  function pickCandidate(candidates, action) {
    if (!candidates.length) return null;
    const a = normalizeProgressAction(action);
    if (a === 'progress_continuous' || a === 'progress') {
      return candidates.find(c => c.primaryVar === 'restructure' && String(c.label).includes('continua'))
        || candidates.find(c => c.primaryVar === 'continuous')
        || candidates.find(c => c.primaryVar === 'restructure')
        || candidates.find(c => c.primaryVar === 'walk')
        || candidates[0];
    }
    if (a === 'progress_volume') {
      return candidates.find(c => c.primaryVar === 'reps')
        || candidates.find(c => c.primaryVar === 'continuous')
        || candidates[0];
    }
    if (a === 'progress_performance') {
      return candidates.find(c => c.primaryVar === 'performance')
        || candidates.find(c => c.primaryVar === 'continuous')
        || candidates[0];
    }
    if (a === 'reduce') {
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

  function lastScheduledDate(plan) {
    const dates = (plan.sessions || [])
      .map(s => s.scheduledDate || s.completedDate || null)
      .filter(Boolean)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  function allocateScheduleDates(plan, params) {
    const restDays = Math.max(1, Number(params.minRestDaysBetweenRuns) || 1);
    const requested = Math.max(1, Math.min(4, Number(plan.intake?.requestedSessionsPerWeek || plan.requestedSessionsPerWeek || params.sessionsPerWeek) || 3));
    const chosen = Math.max(1, Math.min(4, Number(params.sessionsPerWeek) || 3));
    const effective = Math.min(chosen, Math.max(1, Math.floor(7 / (restDays + 1))));
    plan.requestedSessionsPerWeek = requested;
    plan.effectiveSessionsPerWeek = effective;
    plan.scheduleRequiresConfirmation = requested > effective && !(plan.intake?.frequencyConfirmed || plan.frequencyConfirmed);
    plan.scheduleNotice = requested > effective ? `Pediste ${requested} días por semana. Con ${restDays} día de descanso entre carreras, programamos ${effective} días; confirmá esta alternativa o revisá tu disponibilidad.` : null;
    plan.scheduleAnchorDate = plan.scheduleAnchorDate || localDateISO();
    const offsets = Array.from({ length: effective }, (_, i) => Math.floor(i * 7 / effective));
    const onCadence = date => offsets.includes(((daysBetween(plan.scheduleAnchorDate, date) % 7) + 7) % 7);
    const firstCadenceDate = minimum => { let date = minimum; for (let i = 0; i < 7 && !onCadence(date); i++) date = addDaysISO(date, 1); return date; };
    let minimumRunDate = localDateISO();
    let previousRunDate = null;
    const sorted = [...(plan.sessions || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const item of sorted) {
      if (!['pending', 'rescheduled'].includes(item.status)) {
        if (item.kind === 'run' && item.status === 'completed') {
          previousRunDate = item.completedDate || item.attempts?.filter(a => a.date).at(-1)?.date || item.scheduledDate;
          if (previousRunDate) minimumRunDate = [minimumRunDate, addDaysISO(previousRunDate, restDays + 1)].sort().at(-1);
        }
        continue;
      }
      if (item.kind === 'rest') {
        item.scheduledDate = item.scheduledDate || (previousRunDate ? addDaysISO(previousRunDate, 1) : localDateISO());
        continue;
      }
      const explicitDate = item.status === 'rescheduled' && item.scheduledDate && item.scheduledDate >= minimumRunDate;
      const keptDate = item.scheduledDate && item.scheduledDate >= minimumRunDate && onCadence(item.scheduledDate);
      item.scheduledDate = explicitDate || keptDate ? item.scheduledDate : firstCadenceDate(minimumRunDate);
      previousRunDate = item.scheduledDate;
      minimumRunDate = addDaysISO(previousRunDate, restDays + 1);
    }
    return plan;
  }

  function makeRestItem(plan, note, scheduledDate = null) {
    const order = nextOrder(plan);
    return {
      id: `rest-${Date.now()}-${order}`,
      weekGroup: Math.ceil(order / 4),
      order,
      kind: 'rest',
      title: 'Recuperación',
      status: 'pending',
      scheduledDate,
      blockedUntilRest: false,
      structure: {
        rest: true,
        note: note || 'Descanso entre estímulos. Completarlo habilita el próximo entrenamiento.'
      },
      attempts: [],
      engineVersion: ENGINE_VERSION,
      generated: true,
      sessionGoal: 'Recuperación',
      primaryDimension: 'recovery'
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
      title: meta.title || `Sesión · ${describeStructure(st)}`,
      status: 'pending',
      scheduledDate: meta.scheduledDate || null,
      blockedUntilRest: false,
      structure: st,
      attempts: [],
      engineVersion: ENGINE_VERSION,
      generated: true,
      isControlTest: Boolean(meta.isControlTest),
      sessionGoal: meta.sessionGoal || 'Desarrollar tolerancia',
      secondaryGoals: meta.secondaryGoals || [],
      justification: meta.justification || '',
      decisionAction: meta.action || null,
      changeSummary: meta.changeSummary || null,
      primaryDimension: meta.primaryDimension || 'continuous',
      prescribedContinuousSec: m.continuousSec,
      prescribedTotalRunSec: m.totalRunSec,
      estimatedDurationMin: m.totalMin,
      estimatedKm: meta.estimatedKm != null ? meta.estimatedKm : null
    };
  }

  function makeControlTestItem(plan, settings = {}) {
    const params = paramsOf(plan);
    const observed = Math.max(30, Number(plan.athleteProfile?.demonstratedContinuousSec) || 30);
    const sec = Math.min(Number(params.controlTestSec) || 12 * 60, observed);
    const st = structureFromClassic({
      warmSeconds: params.warmSeconds,
      coolSeconds: params.coolSeconds,
      runSeconds: sec,
      walkSeconds: 0,
      reps: 1
    });
    return makeRunItem(plan, st, {
      title: `Test de control · ${formatBlockSec(sec)} continuo`,
      isControlTest: true,
      action: 'consolidate',
      sessionGoal: 'Medir progreso objetivo (test de control)',
      justification: 'Cada varias sesiones hacemos un test corto para ver evolución real, no solo sensación.',
      primaryDimension: 'performance',
      estimatedKm: estimateKm(st, settings)
    });
  }

  function shouldScheduleControlTest(plan, logs) {
    const params = paramsOf(plan);
    const every = Number(params.controlTestEveryCompletedRuns) || 6;
    const completedRuns = (plan.sessions || []).filter(s => s.kind === 'run' && s.status === 'completed');
    if (completedRuns.length < every) return false;
    const sinceLastTest = completedRuns
      .slice()
      .reverse()
      .findIndex(s => s.isControlTest);
    const gap = sinceLastTest === -1 ? completedRuns.length : sinceLastTest;
    if (gap < every) return false;
    const pendingTest = (plan.sessions || []).some(s =>
      s.isControlTest && (s.status === 'pending' || s.status === 'rescheduled')
    );
    return !pendingTest;
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

  function sessionGoalFor(profile, action) {
    const dim = profile.priorityDimension;
    if (action === 'reassess') return 'Recalibrar tras pausa';
    if (action === 'reduce' || action === 'recovery') return 'Recuperar tolerancia';
    if (action === 'consolidate' || action === 'repeat') return 'Consolidar el estímulo actual';
    if (dim === 'performance') return 'Mejorar rendimiento específico';
    if (dim === 'volume') return 'Aumentar resistencia/volumen de forma sostenible';
    if (profile.stage <= 2) return 'Construir tolerancia caminar/trotar';
    if (profile.stage <= 4) return 'Desarrollar carrera continua';
    return 'Mantener y mejorar condición';
  }

  function ensureHorizon(plan, logs, settings, decision = null) {
    const profile = deriveProfile(logs, plan, settings || {});
    const params = paramsOf(plan);
    plan.athleteProfile = profile;
    plan.engineVersion = ENGINE_VERSION;
    plan.version = Math.max(4, Number(plan.version) || 4);
    plan.params = { ...params, ...(plan.params || {}) };

    const blocked = (plan.sessions || []).find(s => s.kind === 'run' && s.blockedUntilRest && (s.status === 'pending' || s.status === 'rescheduled'));
    if (blocked) {
      allocateScheduleDates(plan, params);
      return plan;
    }

    let guard = 0;
    while (pendingRuns(plan).length < params.horizonPendingRuns && guard < 8) {
      guard += 1;
      const speeds = {
        walkSpeed: settings?.walkSpeed,
        runSpeed: settings?.runSpeed,
        coolSpeed: settings?.coolSpeed
      };

      const sorted = [...(plan.sessions || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
      const lastAny = sorted[sorted.length - 1];
      if (profile.stage <= 5 && lastAny?.kind === 'run') {
        plan.sessions.push(makeRestItem(plan, 'Recuperación entre estímulos (NHS C25K / Galloway).'));
      }

      if (shouldScheduleControlTest(plan, logs) && profile.stage >= 3) {
        plan.sessions.push(makeControlTestItem(plan, speeds));
        decision = { action: 'consolidate', reason: 'Tras test de control, consolidamos.' };
        continue;
      }

      const base = lastCompletedRunStructure(plan)
        || pendingRuns(plan)[0]?.structure
        || profile.baselineStructure;
      const action = decision?.action
        || (profile.needsReassess ? 'reassess' : 'consolidate');
      const effectiveAction = action === 'repeat' ? 'consolidate' : action;
      const genAction = effectiveAction === 'recovery' ? 'consolidate' : effectiveAction;
      let candidates = generateCandidates(base, genAction, profile, plan);
      if (genAction === 'reduce') {
        const floor = sessionFloorStructure(plan, logs, settings);
        candidates = filterCandidatesAboveFloor(candidates, floor, genAction);
      }
      const picked = pickCandidate(candidates, genAction);
      let nextStructure = picked?.structure || base;
      if (genAction === 'reduce') {
        const floor = sessionFloorStructure(plan, logs, settings);
        if (loadRank(nextStructure) < loadRank(floor)) nextStructure = floor;
      }
      const diff = compareStructures(base, nextStructure);

      plan.sessions.push(makeRunItem(plan, nextStructure, {
        action: effectiveAction,
        justification: decision?.reason || `Motor ${ENGINE_VERSION} · ${ACTION_LABELS[effectiveAction] || effectiveAction}.`,
        changeSummary: diff,
        sessionGoal: sessionGoalFor(profile, effectiveAction),
        primaryDimension: decision?.priorityDimension || profile.priorityDimension,
        estimatedKm: estimateKm(nextStructure, speeds)
      }));

      // Solo la primera generación tras una decisión usa esa decisión; el resto consolida
      decision = { action: 'consolidate', reason: 'Horizonte: estímulo siguiente en consolidación.' };
    }

    allocateScheduleDates(plan, params);
    plan.pendingSpeedSuggestion = plan.pendingSpeedSuggestion || null;
    return plan;
  }

  /**
   * Sugerencia de velocidad: nunca aplica sola.
   * Prefiere ritmo de carrera / ciclo persistido en logs (paceMetrics).
   */
  function suggestSpeed(logs, settings = {}, plan = null) {
    const params = paramsOf(plan);
    const profile = deriveProfile(logs, plan, settings);
    const current = Number(settings.runSpeed) || 7.5;
    const base = {
      currentKmh: current,
      suggestedKmh: null,
      action: 'keep',
      acceptRequired: true,
      message: `Mantenemos tu velocidad de ${String(current).replace('.', ',')} km/h.`,
      reasonCode: ['SPEED_KEEP']
    };

    if (profile.priorityDimension === 'continuous' && profile.stage <= 4) {
      return {
        ...base,
        message: `Mantenemos tu velocidad de ${String(current).replace('.', ',')} km/h. Tu próxima mejora está enfocada en correr durante más tiempo sin caminar.`,
        reasonCode: ['SPEED_KEEP_PRIORITIZE_CONTINUOUS']
      };
    }

    const valid = validTrainingLogs(logs).slice(0, 6);
    const comparable = valid.filter(l =>
      evidenceForLog(l).sufficient &&
      l.prescriptionCompleted !== false &&
      l.execution !== 'aborted' &&
      Number(l.rpe) <= params.speedSuggestMaxRpe &&
      !l.pain &&
      !hasSafetyOverride(l)
    );

    if (comparable.length < params.speedSuggestMinComparable) {
      return {
        ...base,
        message: `Todavía no hay evidencia suficiente para modificar tu velocidad de ${String(current).replace('.', ',')} km/h.`,
        reasonCode: ['SPEED_INSUFFICIENT_EVIDENCE']
      };
    }

    const continuousSessions = comparable.filter(l => Number(l.maxRunBlockSec) >= 15 * 60);
    if (continuousSessions.length < 2) {
      return {
        ...base,
        message: `Mantenemos ${String(current).replace('.', ',')} km/h. Priorizamos consolidar carrera continua antes de tocar el ritmo.`,
        reasonCode: ['SPEED_KEEP_NEED_CONTINUOUS_BASE']
      };
    }

    // Evidencia objetiva: ritmo de carrera del ciclo (sin warm/cool) cuando está persistido.
    const withPace = continuousSessions.filter(l => {
      const kmh = Number(l.paceMetrics?.runSpeedKmh || l.paceMetrics?.cycleSpeedKmh);
      return Number.isFinite(kmh) && kmh > 0 && l.runDistanceConfirmed === true && Number(l.runDistanceKm) > 0;
    });
    const minPaceSamples = Number(params.paceSuggestMinSamples) || 2;
    if (withPace.length >= minPaceSamples) {
      const avg = withPace.reduce((s, l) => s + Number(l.paceMetrics.runSpeedKmh || l.paceMetrics.cycleSpeedKmh), 0) / withPace.length;
      const deltaCap = Number(params.speedSuggestMaxDeltaKmh) || 0.5;
      if (avg >= current + 0.25) {
        const suggested = Math.round(Math.min(avg, current + deltaCap) * 10) / 10;
        if (suggested > current) {
          return {
            currentKmh: current,
            suggestedKmh: suggested,
            action: 'suggest_up',
            acceptRequired: true,
            message: `Tu ritmo de carrera en las últimas sesiones (~${String(avg.toFixed(1)).replace('.', ',')} km/h) sugiere probar ${String(suggested).replace('.', ',')} km/h. ¿Querés intentarlo?`,
            reasonCode: ['SPEED_SUGGEST_FROM_CYCLE_PACE'],
            evidenceSessions: withPace.length,
            evidenceAvgKmh: Math.round(avg * 10) / 10
          };
        }
      }
      return {
        ...base,
        message: `Tu ritmo de ciclo/carrera está alineado con ${String(current).replace('.', ',')} km/h. Lo mantenemos.`,
        reasonCode: ['SPEED_KEEP_PACE_ALIGNED'],
        evidenceSessions: withPace.length
      };
    }

    const confirmed = continuousSessions.filter(l =>
      l.runDistanceConfirmed === true && Number(l.runDistanceKm) > 0 &&
      typeof l.distanceKm === 'number' &&
      l.distanceEstimated === false &&
      typeof l.elapsedSec === 'number' && l.elapsedSec > 0
    );
    if (confirmed.length < 2) {
      return {
        ...base,
        message: `Tus últimas sesiones fueron cómodas, pero aún no hay ritmos de ciclo confirmados para ajustar. ¿Querés mantener ${String(current).replace('.', ',')} km/h?`,
        reasonCode: ['SPEED_NO_SEGMENT_DATA']
      };
    }

    const suggested = Math.round((current + params.speedSuggestMaxDeltaKmh) * 10) / 10;
    return {
      currentKmh: current,
      suggestedKmh: suggested,
      action: 'suggest_up',
      acceptRequired: true,
      message: `Tus últimas sesiones continuas fueron cómodas y consistentes. Podemos evaluar un pequeño ajuste a ${String(suggested).replace('.', ',')} km/h. ¿Querés probarlo?`,
      reasonCode: ['SPEED_SUGGEST_UP'],
      evidenceSessions: confirmed.length
    };
  }

  function migratePlanToV4(plan, logs = [], settings = {}) {
    const next = clone(plan || { sessions: [] });
    if (!Array.isArray(next.sessions)) next.sessions = [];
    const already = next.version >= 4 && next.engineVersion;
    next.version = Math.max(4, Number(next.version) || 4);
    next.engineVersion = ENGINE_VERSION;
    next.params = { ...DEFAULT_PARAMS, ...(next.params || {}) };
    if (next.onboardingCompleted == null) {
      // Planes previos con sesiones se consideran onboarded; vacíos nuevos no.
      next.onboardingCompleted = next.sessions.some(s => s.kind === 'run');
    }
    if (!already) {
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
    }
    // Normalizar walkSeconds 0 preservados
    next.sessions = next.sessions.map(s => {
      if (s?.structure && !s.structure.rest) {
        s.structure = structureFromClassic(s.structure);
      }
      return s;
    });
    next.athleteProfile = deriveProfile(logs, next, settings);
    if (!next.onboardingCompleted && next.sessions.length === 0) {
      return next;
    }
    return ensureHorizon(next, logs, settings, already
      ? null
      : { action: 'consolidate', reason: 'Migración adaptativa: continuidad del plan.' });
  }

  function buildDiffMessage(prevStructure, nextStructure, decision) {
    const diff = compareStructures(prevStructure, nextStructure);
    const action = decision?.action || 'consolidate';
    return {
      action,
      actionLabel: ACTION_LABELS[action] || ACTION_LABELS.consolidate,
      previous: describeStructure(prevStructure),
      next: describeStructure(nextStructure),
      previousRunAccum: diff.previousMetrics ? formatBlockSec(diff.previousMetrics.totalRunSec) : null,
      nextRunAccum: diff.nextMetrics ? formatBlockSec(diff.nextMetrics.totalRunSec) : null,
      lines: diff.lines,
      summary: diff.summary,
      interpretation: diff.interpretation,
      dimension: diff.dimension,
      reason: decision?.reason || '',
      sameLoad: diff.sameLoad,
      priorityDimension: decision?.priorityDimension || diff.dimension,
      caution: decision?.caution || null,
      speedSuggestion: null
    };
  }

  function validateStructureMath(st) {
    const m = metrics(st);
    const sum = m.warmSeconds + m.coolSeconds + m.totalRunSec + m.totalWalkSec;
    return {
      ok: sum === m.totalSec,
      sum,
      totalSec: m.totalSec,
      metrics: m
    };
  }

  /**
   * Ritmos objetivos a partir de tiempo + distancia + estructura.
   * Excluye calentamiento/enfriamiento del ritmo de ciclo.
   * Si hay distancia total, reparte km por pesos velocidad×tiempo (no inventa GPS).
   */
  function formatPacePerKm(secPerKm) {
    if (!Number.isFinite(secPerKm) || secPerKm <= 0) return null;
    let total = Math.round(secPerKm);
    let m = Math.floor(total / 60);
    let s = total % 60;
    if (s === 60) {
      m += 1;
      s = 0;
    }
    return `${m}:${String(s).padStart(2, '0')}/km`;
  }

  function computeSessionPaceMetrics({ elapsedSec, distanceKm, structure, speeds = {} } = {}) {
    const totalSec = Number(elapsedSec) || 0;
    if (totalSec <= 0) return null;

    const st = structureFromClassic(structure || {});
    const m = metrics(st);
    const warm = Number(st.warmSeconds) || 0;
    const cool = Number(st.coolSeconds) || 0;
    const runSecPrescribed = Number(m.totalRunSec) || 0;
    const walkSecPrescribed = Number(m.totalWalkSec) || 0;
    const cycleSecPrescribed = runSecPrescribed + walkSecPrescribed;
    const hasStructure = warm + cool + cycleSecPrescribed > 0;

    const walkSp = Number(speeds.walkSpeed) || 5;
    const runSp = Number(speeds.runSpeed) || 7.5;
    const coolSp = Number(speeds.coolSpeed) || 4.5;

    let warmSecActual;
    let coolSecActual;
    let cycleSec;
    if (hasStructure && totalSec > warm + cool && cycleSecPrescribed > 0) {
      warmSecActual = warm;
      coolSecActual = cool;
      cycleSec = totalSec - warm - cool;
    } else if (hasStructure) {
      const structTotal = warm + cool + cycleSecPrescribed;
      const scale = structTotal > 0 ? totalSec / structTotal : 1;
      warmSecActual = warm * scale;
      coolSecActual = cool * scale;
      cycleSec = cycleSecPrescribed * scale;
    } else {
      warmSecActual = 0;
      coolSecActual = 0;
      cycleSec = totalSec;
    }

    let runSec;
    let walkSec;
    if (cycleSecPrescribed > 0) {
      runSec = cycleSec * (runSecPrescribed / cycleSecPrescribed);
      walkSec = cycleSec * (walkSecPrescribed / cycleSecPrescribed);
    } else {
      runSec = cycleSec;
      walkSec = 0;
    }

    const wWarm = walkSp * warmSecActual;
    const wCool = coolSp * coolSecActual;
    const wRun = runSp * runSec;
    const wWalk = walkSp * walkSec;
    const wTotal = wWarm + wCool + wRun + wWalk;

    const confirmed = typeof distanceKm === 'number' && Number.isFinite(distanceKm) && distanceKm > 0;
    let runKm;
    let cycleKm;
    let totalKm;
    let distanceSource;
    if (confirmed && wTotal > 0) {
      totalKm = distanceKm;
      runKm = distanceKm * (wRun / wTotal);
      cycleKm = distanceKm * ((wRun + wWalk) / wTotal);
      distanceSource = 'attributed';
    } else if (wTotal > 0) {
      runKm = wRun / 3600;
      cycleKm = (wRun + wWalk) / 3600;
      totalKm = wTotal / 3600;
      distanceSource = 'estimated';
    } else if (confirmed) {
      totalKm = distanceKm;
      runKm = distanceKm;
      cycleKm = distanceKm;
      distanceSource = 'total';
    } else {
      return null;
    }

    const runPace = runKm > 0.01 ? runSec / runKm : null;
    const cyclePace = cycleKm > 0.01 ? cycleSec / cycleKm : null;
    const overallPace = totalKm > 0.01 ? totalSec / totalKm : null;
    const round2 = (n) => Math.round(n * 100) / 100;

    return {
      elapsedSec: Math.round(totalSec),
      warmSec: Math.round(warmSecActual),
      coolSec: Math.round(coolSecActual),
      cycleSec: Math.round(cycleSec),
      runSec: Math.round(runSec),
      walkSec: Math.round(walkSec),
      runKm: round2(runKm),
      cycleKm: round2(cycleKm),
      totalKm: round2(totalKm),
      runPaceSecPerKm: runPace,
      cyclePaceSecPerKm: cyclePace,
      overallPaceSecPerKm: overallPace,
      runPaceLabel: formatPacePerKm(runPace),
      cyclePaceLabel: formatPacePerKm(cyclePace),
      overallPaceLabel: formatPacePerKm(overallPace),
      runSpeedKmh: runPace > 0 ? Math.round((3600 / runPace) * 10) / 10 : null,
      cycleSpeedKmh: cyclePace > 0 ? Math.round((3600 / cyclePace) * 10) / 10 : null,
      overallSpeedKmh: overallPace > 0 ? Math.round((3600 / overallPace) * 10) / 10 : null,
      isContinuous: walkSecPrescribed === 0,
      hasStructure,
      distanceSource
    };
  }

  window.PaceAdaptive = {
    ENGINE_VERSION,
    DEFAULT_PARAMS,
    ACTION_LABELS,
    GOAL_CATALOG,
    CONTINUOUS_ABILITY,
    setClock,
    now,
    localDateISO,
    addDaysISO,
    paramsOf,
    structureFromClassic,
    metrics,
    estimateKm,
    describeStructure,
    compareStructures,
    compareAttemptRecency,
    evidenceForLog,
    durationOfLog,
    trainingConfidence,
    constrainPrescription,
    deriveProfile,
    assessCaution,
    trendFavorable,
    observedCompletion,
    decideAdaptive,
    generateCandidates,
    pickCandidate,
    withinLoadLimits,
    ensureHorizon,
    allocateScheduleDates,
    migratePlanToV4,
    buildDiffMessage,
    suggestSpeed,
    makeRunItem,
    makeRestItem,
    makeControlTestItem,
    shouldScheduleControlTest,
    structureForProfile,
    startingStructureForAbility,
    initialPrescription,
    normalizeIntake,
    buildPlanFromIntake,
    recalibrateLoad,
    undoRecalibration,
    restoreFocusSession,
    sessionFloorStructure,
    refreshStaleSchedule,
    stageFromContinuousSec,
    validTrainingLogs,
    pendingRuns,
    openItems,
    validateStructureMath,
    priorityDimensionFor,
    formatBlockSec,
    formatPacePerKm,
    computeSessionPaceMetrics
  };
})();

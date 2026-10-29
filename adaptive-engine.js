/**
 * PACE/01 Adaptive Engine v4.1 (Fase 2)
 * Evolución multidimensional, carrera continua, velocidades sugeridas, calendario.
 * Referencias y parámetros propios: PRODUCT.md
 */
(() => {
  const ENGINE_VERSION = '4.3.1';

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
      runSeconds: Number(st.runSeconds) || 120,
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
    const continuous = completed
      .map(l => Number(l.maxRunBlockSec) || 0)
      .filter(n => n > 0);
    const fromLogs = continuous.length ? Math.max(...continuous) : null;
    const declaredSec = plan?.intake?.declaredContinuousSec;
    // Logs reales mandan; el intake solo arranca el perfil.
    const demonstratedContinuousSec = fromLogs != null
      ? fromLogs
      : (declaredSec != null && Number.isFinite(Number(declaredSec)) ? Number(declaredSec) : null);
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
    let confidenceNote = 'Información insuficiente o inconsistente para decidir con firmeza.';
    if (withRpe.length >= 4 && continuous.length >= 3 && recent.length >= 3) {
      confidence = 'alta';
      confidenceNote = 'Tenemos suficiente información reciente y consistente para evaluar tu evolución.';
    } else if (withRpe.length >= 2 && completed.length >= 2) {
      confidence = 'media';
      confidenceNote = 'Datos suficientes, con ciertas limitaciones.';
    }

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
    const environment = ['outdoor', 'treadmill', 'both'].includes(raw.environment)
      ? raw.environment
      : 'both';
    const hasPain = Boolean(raw.hasPain);
    let intakeStage = ability.stage;
    if ((goal.type === '10k' || goal.type === '5k_pb') && ability.stage >= 5) intakeStage = 6;
    if (hasPain && intakeStage > 1) intakeStage = Math.max(1, intakeStage - 1);
    const runSpeed = Number(raw.runSpeed);
    return {
      goalType: goal.type,
      continuousAbility: abilityKey,
      sessionsPerWeek,
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

  function buildPlanFromIntake(rawIntake = {}, settings = {}) {
    const intake = normalizeIntake(rawIntake);
    intake.completedAt = localDateISO();
    const goal = GOAL_CATALOG[intake.goalType] || GOAL_CATALOG['5k_finish_runwalk'];
    const raceDate = intake.raceDate || addDaysISO(localDateISO(), goal.horizonDays);
    const checkpointDate = addDaysISO(localDateISO(), 21);
    const structure = startingStructureForAbility(intake.continuousAbility, {
      conservative: intake.hasPain
    });
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
      sessions: [],
      pendingSpeedSuggestion: null
    };
    plan.athleteProfile = deriveProfile([], plan, settings);
    plan.sessions.push(makeRunItem(plan, structure, {
      title: 'Sesión 1 · Tu punto de partida',
      action: 'consolidate',
      sessionGoal: 'Confirmar tu nivel de entrada',
      justification: `Onboarding: ${CONTINUOUS_ABILITY[intake.continuousAbility].label}. Objetivo: ${goal.label}.`,
      primaryDimension: plan.athleteProfile.priorityDimension,
      estimatedKm: estimateKm(structure, settings)
    }));
    return ensureHorizon(plan, [], settings, {
      action: 'consolidate',
      reason: 'Plan inicial personalizado desde onboarding.'
    });
  }

  /**
   * Recalibración explícita del usuario sobre la próxima sesión pendiente.
   * direction: 'easier' | 'harder'
   */
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
    const profile = deriveProfile(logs, next, settings);
    const action = direction === 'harder' ? 'progress_continuous' : 'reduce';
    const candidates = generateCandidates(openRun.structure, action, profile, next);
    const picked = pickCandidate(candidates, action);
    if (!picked?.structure) {
      return { plan: next, changed: false, message: 'No encontramos un ajuste viable ahora.' };
    }
    const prev = structureFromClassic(openRun.structure);
    const neo = structureFromClassic(picked.structure);
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

  function mapProgressAction(profile, plan) {
    const dim = priorityDimensionFor(profile, plan);
    if (dim === 'performance') return 'progress_performance';
    if (dim === 'volume') return 'progress_volume';
    return 'progress_continuous';
  }

  /**
   * Decisión adaptativa (conserva comportamiento Fase 1 validado).
   */
  function decideAdaptive(log, priorLogs = [], plan = null) {
    const profile = deriveProfile([log, ...(priorLogs || [])], plan, {});
    const reasonCode = [];
    const completed = log.prescriptionCompleted !== false && log.execution !== 'aborted';
    const rpe = Number(log.rpe);
    const caution = assessCaution([log, ...(priorLogs || [])], plan);

    if (hasSafetyOverride(log)) {
      reasonCode.push('SAFETY_OVERRIDE');
      return {
        action: 'recovery',
        progression: 'recovery',
        reason: 'Señal de seguridad: priorizamos recuperación antes de subir carga.',
        medicalNotice: Boolean(log.severeWarning),
        reasonCode,
        profile,
        caution,
        priorityDimension: 'recovery'
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
        profile,
        caution,
        priorityDimension: 'recovery'
      };
    }
    if (!completed) {
      reasonCode.push('PRESCRIPTION_INCOMPLETE');
      const action = rpe >= 8 ? 'reduce' : 'repeat';
      return {
        action,
        progression: action === 'reduce' ? 'advance' : 'repeat',
        reason: action === 'reduce'
          ? 'Sesión incompleta y muy exigente: bajamos la carga en la próxima.'
          : 'No se completó la prescripción: repetimos este estímulo. Un RPE bajo no compensa un entrenamiento incompleto.',
        reasonCode,
        profile,
        caution,
        priorityDimension: 'recovery'
      };
    }

    if (log.pain) {
      reasonCode.push('ALERT_PRESENT');
      return {
        action: 'repeat',
        progression: 'repeat',
        reason: 'Hubo molestia leve: mantenemos este nivel.',
        reasonCode,
        profile,
        caution,
        priorityDimension: 'recovery'
      };
    }

    if (rpe >= 9) {
      reasonCode.push('RPE_VERY_HIGH');
      return {
        action: 'reduce',
        progression: 'advance',
        reason: 'Esfuerzo muy alto: bajamos la carga para recuperar tolerancia.',
        reasonCode,
        profile,
        caution,
        priorityDimension: 'recovery'
      };
    }
    if (rpe >= 7) {
      reasonCode.push('RPE_HIGH');
      return {
        action: 'repeat',
        progression: 'repeat',
        reason: 'Esfuerzo alto: repetimos este estímulo sin aumentar.',
        reasonCode,
        profile,
        caution,
        priorityDimension: 'recovery'
      };
    }

    // Pausas: medir hueco respecto al entrenamiento ANTERIOR (no el actual).
    {
      const priorValid = validTrainingLogs(priorLogs);
      const lastPrior = priorValid[0];
      const gapPrior = lastPrior?.date
        ? daysBetween(lastPrior.date, log.date || localDateISO())
        : null;
      if (gapPrior != null && gapPrior >= paramsOf(plan).pauseDaysForReassess) {
        reasonCode.push('PAUSE_REASSESS');
        return {
          action: 'reassess',
          progression: 'advance',
          reason: `Tras ${gapPrior} días sin entrenar, recalibramos sin borrar el historial.`,
          reasonCode,
          profile: { ...profile, gapDays: gapPrior, needsReassess: true },
          caution,
          priorityDimension: 'recovery'
        };
      }
    }

    if (profile.confidence === 'baja' && validTrainingLogs([log, ...priorLogs]).length < 2) {
      reasonCode.push('LOW_EVIDENCE');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: 'Todavía hay poca evidencia: consolidamos este nivel antes de subir.',
        reasonCode,
        profile,
        caution,
        priorityDimension: 'consistency'
      };
    }

    if (rpe === 6) {
      const trend = trendFavorable(priorLogs, plan);
      if (trend.ok && profile.recentGood >= 1) {
        const action = mapProgressAction(profile, plan);
        reasonCode.push('RPE_6_TREND_OK');
        return {
          action,
          progression: 'advance',
          reason: `Esfuerzo moderado-alto con tendencia aceptable: progresamos con cuidado. ${trend.reason}`,
          reasonCode,
          profile,
          trend,
          caution,
          priorityDimension: profile.priorityDimension
        };
      }
      reasonCode.push('RPE_6_HOLD');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: `Esfuerzo 6: consolidamos. ${trend.reason}`,
        reasonCode,
        profile,
        trend,
        caution,
        priorityDimension: 'consistency'
      };
    }

    // RPE 1–5
    const trend = trendFavorable([log, ...priorLogs], plan);
    if (rpe <= 3 && (trend.ok || profile.recentGood >= 1 || profile.sessionsCompleted >= 1)) {
      const action = mapProgressAction(profile, plan);
      reasonCode.push('RPE_LOW_PROGRESS');
      return {
        action,
        progression: 'advance',
        reason: 'Buena tolerancia: aumentamos una dimensión de carga con límite conservador.',
        reasonCode,
        profile,
        trend,
        caution,
        priorityDimension: profile.priorityDimension
      };
    }
    if (rpe <= 5) {
      if (trend.ok && profile.recentGood >= paramsOf(plan).minGoodSessionsForProgress) {
        const action = mapProgressAction(profile, plan);
        reasonCode.push('RPE_MID_PROGRESS');
        return {
          action,
          progression: 'advance',
          reason: 'Tolerancia adecuada y tendencia favorable: progresamos.',
          reasonCode,
          profile,
          trend,
          caution,
          priorityDimension: profile.priorityDimension
        };
      }
      reasonCode.push('RPE_MID_CONSOLIDATE');
      return {
        action: 'consolidate',
        progression: 'advance',
        reason: 'Sesión bien tolerada: consolidamos este nivel (una sola sesión buena no basta para un salto grande).',
        reasonCode,
        profile,
        trend,
        caution,
        priorityDimension: 'consistency'
      };
    }

    reasonCode.push('FALLBACK_REPEAT');
    return {
      action: 'repeat',
      progression: 'repeat',
      reason: 'Mantenemos este estímulo.',
      reasonCode,
      profile,
      caution,
      priorityDimension: 'consistency'
    };
  }

  function continuousStepFor(baseSec, params, profile) {
    if (baseSec >= 15 * 60) return params.continuousStepEasySec;
    if (baseSec >= 8 * 60 || (profile?.stage >= 4 && baseSec >= 5 * 60)) return params.continuousStepLongSec;
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
    const gap = Math.max(1, Number(params.minRestDaysBetweenRuns) || 1);
    let cursor = localDateISO();
    const last = lastScheduledDate(plan);
    if (last && last >= cursor) cursor = addDaysISO(last, gap);
    else if (last) {
      const since = daysBetween(last, cursor);
      if (since != null && since < gap) cursor = addDaysISO(last, gap);
    }

    const open = [...(plan.sessions || [])]
      .filter(s => s.status === 'pending' || s.status === 'rescheduled')
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    for (const item of open) {
      if (item.kind === 'rest') {
        if (!item.scheduledDate) {
          item.scheduledDate = cursor;
          cursor = addDaysISO(cursor, 1);
        } else {
          cursor = addDaysISO(item.scheduledDate, 1);
        }
        continue;
      }
      // run
      if (!item.scheduledDate || item.status === 'pending') {
        // No apilar varias corridas el mismo día
        const used = new Set(
          (plan.sessions || [])
            .filter(s => s.id !== item.id && s.kind === 'run' && s.scheduledDate)
            .map(s => s.scheduledDate)
        );
        while (used.has(cursor)) cursor = addDaysISO(cursor, 1);
        item.scheduledDate = cursor;
        cursor = addDaysISO(cursor, gap + 1);
      } else {
        cursor = addDaysISO(item.scheduledDate, gap + 1);
      }
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
    const sec = Number(params.controlTestSec) || 12 * 60;
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
      const candidates = generateCandidates(base, genAction, profile, plan);
      const picked = pickCandidate(candidates, genAction);
      const diff = compareStructures(base, picked.structure);

      plan.sessions.push(makeRunItem(plan, picked.structure, {
        action: effectiveAction,
        justification: decision?.reason || `Motor ${ENGINE_VERSION} · ${ACTION_LABELS[effectiveAction] || effectiveAction}.`,
        changeSummary: diff,
        sessionGoal: sessionGoalFor(profile, effectiveAction),
        primaryDimension: decision?.priorityDimension || profile.priorityDimension,
        estimatedKm: estimateKm(picked.structure, speeds)
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
      return Number.isFinite(kmh) && kmh > 0 && l.paceMetrics?.distanceSource === 'attributed';
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
    deriveProfile,
    assessCaution,
    trendFavorable,
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
    normalizeIntake,
    buildPlanFromIntake,
    recalibrateLoad,
    undoRecalibration,
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

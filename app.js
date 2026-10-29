(() => {
  const Coach = () => window.PaceCoach;

  const STORAGE_KEYS = {
    settings: 'pace01.settings.v1'
  };

  const defaultSettings = {
    walkSpeed: 5.0,
    runSpeed: 7.5,
    coolSpeed: 4.5,
    countdown: true,
    voice: true,
    sound: true,
    lastEnvironment: null
  };

  let settings = loadSettings();
  let plan = null;
  let logs = null;
  let activePlanSessionId = null;
  let workout = [];
  let currentBlockIndex = 0;
  let remainingMs = 0;
  let originalBlockMs = 0;
  let running = false;
  let timerId = null;
  let elapsedMs = 0;
  let blockDeadline = null;
  let runStartedAt = null;
  let deferredInstallPrompt = null;
  let wakeLock = null;
  let audioContext = null;
  let audioUnlocked = false;
  let countdownBeepsFired = new Set();
  let finishedAnnounced = false;
  let hasStarted = false;
  let maxCompletedRunBlockSec = 0;
  let currentRunCompletedSec = 0;
  /** @type {'treadmill'|'outdoor'|null} */
  let sessionEnvironment = null;
  /** Evita contar el bloque nuevo durante preTransition → transition → blockStart. */
  let transitionLock = false;
  let speakGeneration = 0;
  let lastSaveResult = null;
  /** Tiempo del cronómetro al abrir el cierre (para no comparar contra un elapsed vivo). */
  let closeMeasuredTime = null;
  let onboardStep = 1;
  let account = window.PaceProduct ? window.PaceProduct.loadAccount() : null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function loadSettings() {
    try {
      return { ...defaultSettings, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}') };
    } catch {
      return { ...defaultSettings };
    }
  }

  function persistSettings() {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }

  function localDateISO(date) {
    if (window.PaceAdaptive) {
      return window.PaceAdaptive.localDateISO(date || window.PaceAdaptive.now());
    }
    const dt = date || new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Reloj de pruebas aislado (no altera producción salvo que se invoque). */
  window.PaceTestClock = {
    setISO(iso) {
      if (!window.PaceAdaptive) return;
      const [y, m, d] = String(iso).split('-').map(Number);
      window.PaceAdaptive.setClock(() => new Date(y, m - 1, d, 10, 0, 0));
    },
    clear() {
      if (window.PaceAdaptive) window.PaceAdaptive.setClock(() => new Date());
    },
    today() {
      return localDateISO();
    }
  };

  function speedForType(type) {
    if (type === 'run') return settings.runSpeed;
    if (type === 'cool') return settings.coolSpeed;
    return settings.walkSpeed;
  }

  function focusStructure() {
    const focus = Coach().getFocusSession(plan);
    if (focus && focus.kind === 'run') return focus.structure;
    // fallback: next run in plan or default w2s1
    const nextRun = Coach().sortedPlanSessions(plan).find(s => s.kind === 'run' && s.status === 'pending')
      || Coach().sortedPlanSessions(plan).find(s => s.kind === 'run');
    return nextRun?.structure || {
      warmSeconds: 300, runSeconds: 120, walkSeconds: 120, coolSeconds: 300, reps: 7
    };
  }

  function activeRunSession() {
    const focus = Coach().getFocusSession(plan);
    if (focus?.kind === 'run') return focus;
    if (focus?.gateForId) {
      return plan.sessions.find(s => s.id === focus.gateForId) || null;
    }
    return Coach().sortedPlanSessions(plan).find(s => s.kind === 'run' && (s.status === 'pending' || s.status === 'rescheduled')) || null;
  }

  function buildWorkout() {
    const st = focusStructure();
    const blocks = [
      { type: 'warm', label: 'Calentar', seconds: st.warmSeconds, cue: 'Calentar' }
    ];
    for (let i = 1; i <= st.reps; i++) {
      blocks.push({ type: 'run', label: 'Correr', seconds: st.runSeconds, rep: i, cue: 'Correr' });
      if (Number(st.walkSeconds) > 0) {
        blocks.push({ type: 'walk', label: 'Caminar', seconds: st.walkSeconds, rep: i, cue: 'Caminar' });
      }
    }
    blocks.push({ type: 'cool', label: 'Enfriar', seconds: st.coolSeconds, cue: 'Enfriar' });
    return blocks.map(block => ({
      ...block,
      prescribedSeconds: block.seconds,
      extraSeconds: 0,
      speed: speedForType(block.type)
    }));
  }

  function prescribedSeconds(block) {
    return block?.prescribedSeconds || block?.seconds || 0;
  }

  function blockBudgetMs(block) {
    return (prescribedSeconds(block) + (block?.extraSeconds || 0)) * 1000;
  }

  function formatKm(km) {
    return `${Number(km).toFixed(2).replace('.', ',')} km`;
  }

  function formatMinutesLabel(seconds) {
    const whole = Number(seconds) || 0;
    if (whole % 60 === 0) return `${whole / 60} min`;
    return formatTime(whole);
  }

  function estimateStructureKm(st) {
    const walkSec = Number(st.walkSeconds) || 0;
    const km = (settings.walkSpeed * st.warmSeconds
      + settings.coolSpeed * st.coolSeconds
      + (settings.runSpeed * st.runSeconds + settings.walkSpeed * walkSec) * st.reps) / 3600;
    return km;
  }

  function structureDurationMin(st) {
    const seconds = st.warmSeconds + st.coolSeconds + (st.runSeconds + st.walkSeconds) * st.reps;
    return Math.round(seconds / 60);
  }

  function totalExtraSeconds() {
    return workout.reduce((sum, block) => sum + (block.extraSeconds || 0), 0);
  }

  const SPEED_LIMITS = {
    walk: { min: 3, max: 8, label: 'Caminar' },
    run: { min: 5, max: 16, label: 'Correr' },
    cool: { min: 3, max: 8, label: 'Enfriar' }
  };

  function validateSpeeds(walk, run, cool) {
    const values = [
      ['walk', walk],
      ['run', run],
      ['cool', cool]
    ];
    for (const [key, value] of values) {
      const rule = SPEED_LIMITS[key];
      if (!Number.isFinite(value) || value < rule.min || value > rule.max) {
        return `${rule.label}: entre ${rule.min} y ${rule.max} km/h.`;
      }
    }
    if (run <= walk) return 'Correr tiene que ser más rápido que caminar.';
    return '';
  }

  function formatShortDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-PY', { day: 'numeric', month: 'short' }).replace('.', '');
  }

  function formatFriendlyDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const label = dt.toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'short' }).replace(/[.,]/g, '');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function evidenceCopy(readiness) {
    if (readiness.level5k === 'listo') {
      return 'La evidencia alcanza para intentar un 5K con run/walk. Seguimos mirando RPE, dolor y tiempo continuo.';
    }
    return 'Para evaluar 5K necesitamos: 2–3 sesiones consistentes · RPE controlado · sin dolor relevante · mejorar tiempo continuo.';
  }

  function audit(event, detail) {
    try {
      console.info('[pace01]', event, detail || '');
    } catch { /* log */ }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function speedLabel(speed) {
    return `${Number(speed).toFixed(1).replace('.', ',')} km/h`;
  }

  function getLiveElapsedMs() {
    if (!running || runStartedAt == null) return elapsedMs;
    return elapsedMs + (performance.now() - runStartedAt);
  }

  function getLiveRemainingMs() {
    if (!running || blockDeadline == null) return remainingMs;
    return Math.max(0, blockDeadline - performance.now());
  }

  function getRemainingPlanSeconds() {
    const rem = getLiveRemainingMs() / 1000;
    const future = workout.slice(currentBlockIndex + 1).reduce((sum, b) => sum + b.seconds, 0);
    return Math.max(0, rem + future);
  }

  function getEstimatedDistance() {
    const km = workout.reduce((sum, b) => sum + (b.speed * prescribedSeconds(b) / 3600), 0);
    return formatKm(km);
  }

  function getCompletedDistanceKm() {
    let km = 0;
    for (let i = 0; i < currentBlockIndex; i++) {
      km += workout[i].speed * workout[i].seconds / 3600;
    }
    const block = workout[currentBlockIndex];
    if (block) {
      const doneMs = Math.max(0, originalBlockMs - getLiveRemainingMs());
      km += block.speed * (doneMs / 1000) / 3600;
    }
    return km;
  }

  function noteRunProgressOnLeave() {
    const block = workout[currentBlockIndex];
    if (!block || block.type !== 'run') return;
    const doneSec = Math.max(0, (originalBlockMs - getLiveRemainingMs()) / 1000);
    currentRunCompletedSec = doneSec;
    maxCompletedRunBlockSec = Math.max(maxCompletedRunBlockSec, doneSec);
  }

  function refreshWorkoutSpeeds() {
    workout = workout.map(block => ({ ...block, speed: speedForType(block.type) }));
    renderBlockList();
    updateTimerUI();
  }

  function renderBlockList() {
    const st = focusStructure();
    const list = $('#blockList');
    list.innerHTML = workout.map((b, i) => `
      <div class="block-row ${b.type} ${i === currentBlockIndex ? 'is-current' : ''}" data-block="${i}">
        <span class="block-index">${String(i + 1).padStart(2, '0')}</span>
        <div class="block-title">
          <strong>${b.label}${b.rep ? ` · ${b.rep}/${st.reps}` : ''}</strong>
          <small>${b.type === 'run' ? 'Trabajo' : b.type === 'walk' ? 'Recuperación' : 'Transición'}</small>
        </div>
        <span class="block-duration">${formatTime(b.seconds)}</span>
        <span class="block-speed">${speedLabel(b.speed)}</span>
      </div>
    `).join('');
  }

  function renderWorkout() {
    renderBlockList();
    updateTrainHeader();
    $('#estimatedDistance').textContent = getEstimatedDistance();
    $('#totalRemaining').textContent = formatTime(getRemainingPlanSeconds());
  }

  function updateTrainHeader() {
    $('#trainEyebrow').textContent = 'Hoy';
    $('#trainTitle').textContent = 'Listo para entrenar';
    $('#trainMeta').textContent = 'Verificá que todo esté funcionando antes de empezar.';
  }

  function armBlock(index) {
    currentBlockIndex = Math.min(Math.max(index, 0), Math.max(workout.length - 1, 0));
    const block = workout[currentBlockIndex];
    if (!block) return;
    const budget = blockBudgetMs(block);
    remainingMs = budget;
    originalBlockMs = budget;
    countdownBeepsFired.clear();
    finishedAnnounced = false;
    if (running) blockDeadline = performance.now() + remainingMs;
    else blockDeadline = null;
  }

  function updateTimerUI() {
    const block = workout[currentBlockIndex];
    if (!block) return;

    const remMs = getLiveRemainingMs();
    const remainingSec = remMs / 1000;
    const elapsedSec = getLiveElapsedMs() / 1000;
    const floorSec = Math.ceil(remainingSec);
    const inPreTransition = running && !transitionLock && settings.countdown && floorSec <= 5 && floorSec > 0 && remMs > 0;

    $('#timerPhase').textContent = block.label.toUpperCase();
    $('#timerValue').textContent = formatTime(remainingSec);
    $('#timerValue')?.classList.toggle('is-countdown', inPreTransition);
    $('#view-train')?.classList.toggle('is-pre-transition', inPreTransition);
    $('#view-train')?.classList.toggle('is-transition-lock', transitionLock);
    renderIntensityUi(block);
    $('#phasePill').textContent = running ? block.label.toUpperCase() : (hasStarted ? 'Pausa' : 'Listo');
    $('#blockCounter').textContent = `${currentBlockIndex + 1} / ${workout.length}`;
    $('#mainTimerButton').textContent = running ? 'Pausa' : 'Continuar';
    $('#totalElapsed').textContent = formatTime(elapsedSec);
    $('#totalRemaining').textContent = formatTime(getRemainingPlanSeconds());
    $('#estimatedDistance').textContent = getEstimatedDistance();

    const within = originalBlockMs ? (1 - remMs / originalBlockMs) : 0;
    const sessionFrac = workout.length ? (currentBlockIndex + Math.max(0, Math.min(1, within))) / workout.length : 0;
    $('#timerRing').style.setProperty('--progress', String(sessionFrac));
    $('#view-train').dataset.phase = block.type;

    const next = workout[currentBlockIndex + 1];
    const cueTime = (sec) => formatTime(sec).replace(/^0/, '');
    if (next) {
      const nextBits = sessionEnvironment === 'treadmill'
        ? `<em>${escapeHtml(speedLabel(next.speed))}</em>`
        : next.type === 'run'
          ? `<em>Ritmo cómodo · RPE 3–5</em>`
          : `<em>Recuperá el aliento</em>`;
      $('#nextBlock').innerHTML = `<span>Siguiente</span><strong>${escapeHtml(next.label.toUpperCase())} · ${cueTime(prescribedSeconds(next))}</strong>${nextBits}`;
    } else {
      $('#nextBlock').innerHTML = `<span>Siguiente</span><strong>Sesión completa</strong>`;
    }

    const extra = block.extraSeconds || 0;
    const extraNote = $('#blockExtraNote');
    if (extra > 0) {
      extraNote.hidden = false;
      extraNote.textContent = `Prescrito ${formatTime(prescribedSeconds(block))} · +${extra} s extra en este bloque`;
    } else {
      extraNote.hidden = true;
      extraNote.textContent = '';
    }
    const prep = $('#prepPanel');
    const active = $('#activeStage');
    if (prep) prep.hidden = hasStarted;
    if (active) active.hidden = !hasStarted;
    const onTrain = $('#view-train')?.classList.contains('is-active');
    document.body.classList.toggle('is-running', Boolean(running && onTrain));
    if (running) {
      const more = $('#morePanel');
      if (more && !more.hidden) {
        more.hidden = true;
        $('#moreToggle')?.setAttribute('aria-expanded', 'false');
      }
    }

    const live = $('#timerLive');
    if (live) {
      live.textContent = `${running ? 'En curso' : 'Pausado'}: ${block.label}, ${formatTime(remainingSec)} restantes`;
    }

    $$('.block-row').forEach((el, i) => el.classList.toggle('is-current', i === currentBlockIndex));
  }

  function renderIntensityUi(block) {
    const speedEl = $('#timerSpeed');
    const effortEl = $('#timerEffort');
    if (!speedEl) return;
    const outdoor = sessionEnvironment === 'outdoor';
    if (outdoor && (block.type === 'run' || block.type === 'walk')) {
      speedEl.hidden = true;
      if (effortEl) {
        effortEl.hidden = false;
        effortEl.innerHTML = block.type === 'run'
          ? `<strong>Ritmo cómodo</strong><span>RPE objetivo 3–5 · frases cortas</span>`
          : `<strong>Recuperá el aliento</strong><span>Caminá sin forzar</span>`;
      }
      return;
    }
    speedEl.hidden = false;
    speedEl.textContent = speedLabel(block.speed);
    if (effortEl) effortEl.hidden = true;
  }

  function startTimer({ announceFirst = false } = {}) {
    if (running) return pauseTimer();
    if (!sessionEnvironment) {
      showToast('Elegí si entrenás en cinta o al aire libre');
      return;
    }
    if (finishedAnnounced) resetTimer({ quiet: true });
    const freshStart = !hasStarted;
    hasStarted = true;
    if (freshStart) {
      maxCompletedRunBlockSec = 0;
      currentRunCompletedSec = 0;
      const run = activeRunSession();
      activePlanSessionId = run?.id || null;
    }
    running = true;
    ensureAudio();
    warmSpeech();
    requestWakeLock();
    clearInterval(timerId);
    timerId = setInterval(syncTimer, 100);
    updateTimerUI();
    if (announceFirst || freshStart) {
      blockStart(workout[currentBlockIndex], { announce: true });
    } else {
      const now = performance.now();
      runStartedAt = now;
      blockDeadline = now + remainingMs;
      transitionLock = false;
      updateTimerUI();
    }
    syncTimer();
  }

  function pauseTimer() {
    if (transitionLock) {
      speakGeneration += 1;
      if ('speechSynthesis' in window) {
        try { speechSynthesis.cancel(); } catch { /* */ }
      }
      remainingMs = blockBudgetMs(workout[currentBlockIndex] || { seconds: remainingMs / 1000 });
      originalBlockMs = remainingMs;
      transitionLock = false;
    } else if (running) {
      remainingMs = getLiveRemainingMs();
      elapsedMs = getLiveElapsedMs();
    }
    running = false;
    runStartedAt = null;
    blockDeadline = null;
    clearInterval(timerId);
    timerId = null;
    updateTimerUI();
  }

  /** preTransition: últimos 5 s del bloque actual. */
  function fireCountdownBeeps(remainingSecFloor) {
    if (!settings.countdown || transitionLock) return;
    for (let s = 5; s >= 1; s--) {
      if (remainingSecFloor <= s && remainingSecFloor > 0 && !countdownBeepsFired.has(s)) {
        countdownBeepsFired.add(s);
        beep(s === 1 ? 880 : 640, 85);
      }
    }
  }

  function syncTimer() {
    if (!running || transitionLock) {
      updateTimerUI();
      return;
    }
    const remMs = getLiveRemainingMs();
    fireCountdownBeeps(Math.ceil(remMs / 1000));
    if (remMs <= 0) transition();
    else updateTimerUI();
  }

  /**
   * transition: el bloque previo llegó a 0.
   * No arranca el reloj del nuevo bloque hasta blockStart.
   */
  function transition() {
    if (transitionLock) return;
    noteRunProgressOnLeave();
    if (currentBlockIndex >= workout.length - 1) {
      finishWorkout();
      return;
    }
    transitionLock = true;
    if (running) {
      elapsedMs = getLiveElapsedMs();
      runStartedAt = performance.now();
    }
    armBlock(currentBlockIndex + 1);
    blockDeadline = null;
    updateTimerUI();
    blockStart(workout[currentBlockIndex], { announce: true });
  }

  /**
   * blockStart: UI ya muestra el bloque nuevo a duración completa.
   * Sonido de cambio → voz del bloque → recién ahí corre el deadline.
   */
  function blockStart(block, { announce = true } = {}) {
    if (!block) {
      transitionLock = false;
      return;
    }
    countdownBeepsFired.clear();
    const beginClock = () => {
      if (!running) {
        transitionLock = false;
        updateTimerUI();
        return;
      }
      const now = performance.now();
      runStartedAt = now;
      remainingMs = blockBudgetMs(block);
      originalBlockMs = remainingMs;
      blockDeadline = now + remainingMs;
      transitionLock = false;
      updateTimerUI();
    };

    if (!announce) {
      beginClock();
      return;
    }

    playChangeTone(block);
    const gen = ++speakGeneration;
    window.setTimeout(() => {
      if (gen !== speakGeneration) return;
      speakBlock(block, () => {
        if (gen !== speakGeneration) return;
        beginClock();
      });
    }, settings.sound ? 200 : 40);
  }

  async function nextBlock() {
    if (transitionLock) return;
    if (currentBlockIndex >= workout.length - 1) return finishWorkout();
    if (hasStarted) {
      const ok = await askConfirm({
        title: '¿Pasar al bloque siguiente?',
        body: 'El cronómetro de este bloque se corta.',
        ok: 'Siguiente bloque',
        cancel: 'Volver'
      });
      if (!ok) return;
    }
    noteRunProgressOnLeave();
    const wasRunning = running;
    if (wasRunning) {
      elapsedMs = getLiveElapsedMs();
      runStartedAt = performance.now();
    }
    transitionLock = true;
    armBlock(currentBlockIndex + 1);
    blockDeadline = null;
    updateTimerUI();
    if (wasRunning) blockStart(workout[currentBlockIndex], { announce: true });
    else {
      transitionLock = false;
      updateTimerUI();
    }
  }

  async function prevBlock() {
    if (transitionLock) return;
    if (currentBlockIndex <= 0) return;
    if (hasStarted) {
      const ok = await askConfirm({
        title: '¿Volver al bloque anterior?',
        body: 'El cronómetro de este bloque se corta.',
        ok: 'Bloque anterior',
        cancel: 'Volver'
      });
      if (!ok) return;
    }
    noteRunProgressOnLeave();
    const wasRunning = running;
    if (wasRunning) {
      elapsedMs = getLiveElapsedMs();
      runStartedAt = performance.now();
    }
    armBlock(currentBlockIndex - 1);
    if (wasRunning) {
      transitionLock = true;
      blockDeadline = null;
      updateTimerUI();
      blockStart(workout[currentBlockIndex], { announce: true });
    } else updateTimerUI();
  }

  function addThirty() {
    const block = workout[currentBlockIndex];
    if (!block) return;
    block.extraSeconds = (block.extraSeconds || 0) + 30;
    remainingMs = getLiveRemainingMs() + 30000;
    originalBlockMs = blockBudgetMs(block);
    if (running) blockDeadline = performance.now() + remainingMs;
    const kind = block.type === 'run' ? 'correr' : block.type === 'walk' ? 'caminar' : block.label.toLowerCase();
    showToast(`+30 s extra en ${kind}. Prescrito ${formatTime(prescribedSeconds(block))}. El plan no cambió.`);
    audit('extra-30', { type: block.type, extraSeconds: block.extraSeconds, prescribed: prescribedSeconds(block) });
    updateTimerUI();
  }

  function subtractThirty() {
    const block = workout[currentBlockIndex];
    if (!block) return;
    const live = getLiveRemainingMs();
    const cut = Math.min(30000, live - 5000);
    if (cut < 1000) {
      showToast('Este bloque ya está por terminar');
      return;
    }
    remainingMs = live - cut;
    originalBlockMs = Math.max(1000, originalBlockMs - cut);
    block.extraSeconds = Math.max(0, (block.extraSeconds || 0) - 30);
    if (running) blockDeadline = performance.now() + remainingMs;
    showToast(`−30 s en este bloque. Prescrito ${formatTime(prescribedSeconds(block))}.`);
    audit('minus-30', { type: block.type, extraSeconds: block.extraSeconds, prescribed: prescribedSeconds(block) });
    updateTimerUI();
  }

  function prepareCloseForm({ external = false, fromTimer = false } = {}) {
    $('#sessionForm').reset();
    $('#sessionExternal').value = external ? '1' : '0';
    $('#sessionFromTimer').value = fromTimer ? '1' : '0';
    $('#closeContext').hidden = !external;
    $('#resultQuestion').textContent = external
      ? '¿Registramos esta actividad?'
      : '¿Completaste la prescripción?';
    if ($('#finishHero')) $('#finishHero').hidden = true;
    $('#sessionPlanId').value = external ? '' : (activePlanSessionId || activeRunSession()?.id || '');
    $('#sessionDate').value = localDateISO();
    if (fromTimer && sessionEnvironment) {
      $('#sessionType').value = sessionEnvironment === 'treadmill' ? 'Cinta' : 'Exterior';
    } else if (!fromTimer) {
      $('#sessionType').value = settings.lastEnvironment === 'treadmill' ? 'Cinta' : 'Exterior';
    }
    clearChoice('prescriptionDone');
    clearChoice('sessionRpe');
    clearChoice('sessionPain');
    clearChoice('couldContinue');
    $('#painDetails').hidden = true;
    $('#sessionPainLocation').value = '';
    $('#sessionPainLocation').required = false;
    $('#sessionPainIntensity').value = '';
    $('#flagWorsening').checked = false;
    $('#flagAlteredGait').checked = false;
    $('#flagForcedStop').checked = false;
    $('#flagSevere').checked = false;
    $('#severeHint').hidden = true;
    $('#sessionNotes').value = '';
    $('#sessionExtraLabel').hidden = true;
    showCloseStep(1);
  }

  function openCloseDialogFromTimer() {
    const distance = getCompletedDistanceKm();
    const maxSec = Math.max(maxCompletedRunBlockSec, currentRunCompletedSec);
    const extra = totalExtraSeconds();
    prepareCloseForm({ fromTimer: true });
    const run = activeRunSession();
    $('#sessionPlanId').value = activePlanSessionId || run?.id || '';
    closeMeasuredTime = formatTime(elapsedMs / 1000);
    $('#sessionTime').value = closeMeasuredTime;
    $('#sessionDistance').value = distance ? distance.toFixed(2) : '';
    $('#sessionDistanceEstimated').checked = true;
    syncDistanceEstimateUi();
    $('#sessionMaxRunBlockSec').value = String(Math.round(maxSec));
    $('#sessionMaxRunBlockLabel').textContent = maxSec ? Coach().formatBlock(maxSec) : '—';
    $('#sessionExtraSec').value = String(extra);
    if (extra > 0) {
      $('#sessionExtraLabel').hidden = false;
      $('#sessionExtraLabel').textContent = `Incluye ${extra} s extra marcados en la sesión. La prescripción del plan no cambió.`;
    }
    const doneAll = finishedAnnounced && currentBlockIndex >= workout.length - 1;
    const yes = document.querySelector('input[name="prescriptionDone"][value="yes"]');
    if (doneAll && yes) yes.checked = true;
    if ($('#finishHero')) {
      $('#finishHero').hidden = false;
      $('#finishTime').textContent = $('#sessionTime').value || '—';
      $('#finishDistance').textContent = distance ? `${formatKm(distance)} estimados` : '—';
      $('#finishContinuous').textContent = maxSec ? Coach().formatBlock(maxSec).replace(/^0/, '') : '—';
    }
    if (!$('#sessionDialog').open) $('#sessionDialog').showModal();
  }

  function showCloseStep(step) {
    const titles = { 1: 'Cómo salió', 2: 'Guardar' };
    $$('[data-close-step]').forEach(el => {
      el.hidden = Number(el.dataset.closeStep) !== step;
    });
    $$('[data-step-dot]').forEach(el => {
      const n = Number(el.dataset.stepDot);
      el.classList.toggle('is-current', n === step);
      el.classList.toggle('is-done', n < step);
    });
    $('#closeTitle').textContent = titles[step] || 'Cierre';
    $('#closeBack').hidden = step === 1;
    $('#closeNext').hidden = step === 2;
    $('#saveSession').hidden = step !== 2;
    $('#sessionDialog').dataset.step = String(step);
    if (step === 2) renderSessionMetricsPreview();
    const scroller = $('#sessionForm')?.querySelector('.modal-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  function validateCloseStep(step) {
    if (step === 1 && !selectedValue('prescriptionDone')) {
      showToast($('#sessionExternal').value === '1' ? 'Confirmá si registramos la actividad' : 'Indicá si completaste la prescripción');
      return false;
    }
    if (step === 1 && !selectedValue('sessionRpe')) {
      showToast('Elegí un RPE del 1 al 10');
      return false;
    }
    if (step === 1 && !selectedValue('sessionPain')) {
      showToast('Indicá si hubo dolor o molestia');
      return false;
    }
    if (step === 1 && $('#painYes')?.checked && !$('#sessionPainLocation').value.trim()) {
      showToast('Indicá la ubicación de la molestia');
      return false;
    }
    return true;
  }

  function finishWorkout() {
    if (finishedAnnounced) return;
    finishedAnnounced = true;
    noteRunProgressOnLeave();
    elapsedMs = getLiveElapsedMs();
    remainingMs = 0;
    pauseTimer();
    beep(920, 140);
    setTimeout(() => beep(1120, 180), 170);
    speak('Entrenamiento completado');
    showToast('Sesión completada. Dos pasos y listo.');
    setTimeout(openCloseDialogFromTimer, 450);
  }

  function resetTimer({ quiet = false } = {}) {
    speakGeneration += 1;
    transitionLock = false;
    if (running) {
      remainingMs = getLiveRemainingMs();
      elapsedMs = getLiveElapsedMs();
    }
    running = false;
    runStartedAt = null;
    blockDeadline = null;
    clearInterval(timerId);
    timerId = null;
    currentBlockIndex = 0;
    elapsedMs = 0;
    hasStarted = false;
    finishedAnnounced = false;
    maxCompletedRunBlockSec = 0;
    currentRunCompletedSec = 0;
    workout = buildWorkout();
    remainingMs = workout[0].seconds * 1000;
    originalBlockMs = remainingMs;
    countdownBeepsFired.clear();
    renderWorkout();
    updateTimerUI();
    if (!quiet) showToast('Temporizador reiniciado');
  }

  async function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        console.error('[pace01] ensure-audio', 'AudioContext no disponible');
        return null;
      }
      if (!audioContext) audioContext = new AC();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      if (audioContext.state !== 'running') {
        console.error('[pace01] ensure-audio', `estado=${audioContext.state}`);
        return null;
      }
      return audioContext;
    } catch (error) {
      console.error('[pace01] ensure-audio', error);
      return null;
    }
  }

  /** Desbloquea WebAudio en el gesto del usuario (crítico en iOS/PWA). */
  async function unlockAudio() {
    const ctx = await ensureAudio();
    if (!ctx) return false;
    if (audioUnlocked) return true;
    try {
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
      audioUnlocked = true;
      return true;
    } catch (error) {
      console.error('[pace01] unlock-audio', error);
      return false;
    }
  }

  function createBeepBuffer(ctx, freq, durationSec, peak = 0.45) {
    const rate = ctx.sampleRate || 22050;
    const length = Math.max(1, Math.floor(rate * durationSec));
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    const attack = Math.min(0.02, durationSec / 4);
    const release = Math.min(0.05, durationSec / 3);
    for (let i = 0; i < length; i += 1) {
      const t = i / rate;
      const envAttack = Math.min(1, t / attack);
      const envRelease = Math.min(1, Math.max(0, (durationSec - t) / release));
      // Dos parciales: más audible en parlantes chicos que un seno puro.
      const sample = Math.sin(2 * Math.PI * freq * t) * 0.7
        + Math.sin(2 * Math.PI * freq * 2 * t) * 0.3;
      data[i] = sample * peak * envAttack * envRelease;
    }
    return buffer;
  }

  function buildBeepWavDataUri(freq = 880, durationMs = 180, peak = 0.55) {
    const sampleRate = 22050;
    const samples = Math.max(1, Math.floor(sampleRate * durationMs / 1000));
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    const durationSec = durationMs / 1000;
    const attack = Math.min(0.02, durationSec / 4);
    const release = Math.min(0.05, durationSec / 3);
    for (let i = 0; i < samples; i += 1) {
      const t = i / sampleRate;
      const envAttack = Math.min(1, t / attack);
      const envRelease = Math.min(1, Math.max(0, (durationSec - t) / release));
      const sample = Math.sin(2 * Math.PI * freq * t) * 0.7
        + Math.sin(2 * Math.PI * freq * 2 * t) * 0.3;
      const value = Math.max(-1, Math.min(1, sample * peak * envAttack * envRelease));
      view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  async function beepHtml(freq = 700, duration = 90) {
    const uri = buildBeepWavDataUri(freq, Math.max(duration, 120), 0.6);
    const audio = new Audio(uri);
    audio.volume = 1;
    await audio.play();
    return true;
  }

  async function beepWeb(freq = 700, duration = 90) {
    const ctx = await ensureAudio();
    if (!ctx) return false;
    await unlockAudio();
    const hold = Math.max(duration / 1000, 0.08);
    const src = ctx.createBufferSource();
    src.buffer = createBeepBuffer(ctx, freq, hold, 0.5);
    src.connect(ctx.destination);
    src.start();
    return true;
  }

  function pulseHaptic() {
    try {
      if (navigator.vibrate) navigator.vibrate([35, 40, 35]);
    } catch { /* vibrate */ }
  }

  function warmSpeech() {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.getVoices();
      if (settings.voice) {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        warm.rate = 2;
        speechSynthesis.speak(warm);
        speechSynthesis.cancel();
      }
    } catch { /* speech warm */ }
  }

  async function beep(freq = 700, duration = 90) {
    if (!settings.sound) return false;
    let ok = false;
    try {
      ok = await beepWeb(freq, duration);
    } catch (error) {
      console.error('[pace01] beep-web', error);
    }
    // Fallback HTMLAudio: varios móviles (sobre todo PWA iOS) silencian osciladores.
    try {
      await beepHtml(freq, duration);
      ok = true;
    } catch (error) {
      console.error('[pace01] beep-html', error);
    }
    if (ok) pulseHaptic();
    return ok;
  }

  function playChangeTone(block) {
    const tones = { warm: 520, run: 980, walk: 640, cool: 470 };
    beep(tones[block?.type] || 760, 160);
  }

  function speak(text, onEnd) {
    if (!settings.voice || !('speechSynthesis' in window) || !text) {
      onEnd?.();
      return;
    }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      u.rate = 1.02;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onEnd?.();
      };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      window.setTimeout(finish, Math.min(8000, 1200 + String(text).length * 60));
    } catch {
      onEnd?.();
    }
  }

  function formatSpokenDuration(seconds) {
    const wholeMinutes = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    if (wholeMinutes === 0) return `${rem} segundos`;
    if (rem === 0) return wholeMinutes === 1 ? '1 minuto' : `${wholeMinutes} minutos`;
    return `${wholeMinutes === 1 ? '1 minuto' : `${wholeMinutes} minutos`} ${rem} segundos`;
  }

  function speakBlock(block, onEnd) {
    const dur = formatSpokenDuration(prescribedSeconds(block));
    const verb = block.type === 'run' ? 'Correr'
      : block.type === 'walk' ? 'Caminar'
      : block.type === 'cool' ? 'Enfriar'
      : 'Calentar';
    let line = `${verb} durante ${dur}.`;
    if (sessionEnvironment === 'treadmill') {
      line = `${verb} durante ${dur} a ${String(block.speed).replace('.', ',')} kilómetros por hora.`;
    } else if (sessionEnvironment === 'outdoor' && block.type === 'run') {
      line = `${verb} durante ${dur}. Ritmo cómodo.`;
    }
    speak(line, onEnd);
  }

  /** @deprecated usar blockStart / speakBlock */
  function cueBlock(block) {
    playChangeTone(block);
    speakBlock(block);
  }

  function applyBlock(index, announce = false) {
    armBlock(index);
    updateTimerUI();
    if (announce) blockStart(workout[currentBlockIndex], { announce: true });
  }

  function environmentLabel(env) {
    if (env === 'treadmill') return 'Cinta';
    if (env === 'outdoor') return 'Aire libre';
    return 'No registrado';
  }

  function setSessionEnvironment(env) {
    if (env !== 'treadmill' && env !== 'outdoor') return;
    sessionEnvironment = env;
    settings.lastEnvironment = env;
    persistSettings();
    $$('[data-env]').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.env === env);
    });
    const typeEl = $('#sessionType');
    if (typeEl) typeEl.value = env === 'treadmill' ? 'Cinta' : 'Exterior';
    updateTimerUI();
  }

  function decisionUserCopy(entry) {
    const progression = entry?.progression;
    const action = entry?.adaptiveAction || entry?.action;
    const codes = entry?.reasonCode || [];
    const rpe = entry?.rpe;
    const human = window.PaceProduct?.humanDecisionCopy?.(action || progression, { rpe }) || null;
    if (entry?.source === 'external') {
      return {
        cls: '',
        title: 'Fuera del plan',
        summary: 'Actividad externa. No movió el plan.',
        chips: []
      };
    }
    if (entry?.voluntary || entry?.type === 'Recuperación' || entry?.source === 'rest') {
      return {
        cls: 'recovery',
        title: 'Recuperación completada',
        summary: entry?.voluntary
          ? 'Recuperación registrada. Tu sesión de entrenamiento sigue pendiente; no se completó ni se duplicó.'
          : 'Recuperación completada. Tu próximo entrenamiento quedó habilitado.',
        chips: ['Recuperación']
      };
    }
    if (progression === 'recovery' || action === 'recovery' || codes.includes('SAFETY_OVERRIDE') || codes.includes('PAIN_MODERATE')) {
      return {
        cls: 'recovery',
        title: 'Recuperación',
        summary: 'Priorizamos recuperar antes de subir la carga. La misma sesión de carrera sigue pendiente hasta completar la recuperación.',
        chips: codes.includes('SAFETY_OVERRIDE') ? ['Señal de alerta'] : ['Molestia']
      };
    }
    if (entry?.execution === 'skipped') {
      return {
        cls: 'skip',
        title: 'Omitido',
        summary: 'Esta sesión se omitió. El plan continuó con la siguiente.',
        chips: []
      };
    }
    if (action === 'progress_continuous') {
      return {
        cls: 'advance',
        title: human?.headline || 'Progresión de continuo',
        summary: human?.body || 'Priorizamos bloques de carrera más largos. El volumen acumulado puede bajar un poco para equilibrar.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`, 'Continuo'] : ['Continuo']
      };
    }
    if (action === 'progress_volume') {
      return {
        cls: 'advance',
        title: human?.headline || 'Progresión de volumen',
        summary: human?.body || 'Priorizamos más minutos de carrera acumulada manteniendo el bloque continuo.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`, 'Volumen'] : ['Volumen']
      };
    }
    if (action === 'progress_performance') {
      return {
        cls: 'advance',
        title: human?.headline || 'Progresión de rendimiento',
        summary: human?.body || 'Con base suficiente, orientamos el estímulo a rendimiento (sin tocar tu velocidad sin tu OK).',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`, 'Rendimiento'] : ['Rendimiento']
      };
    }
    if (action === 'consolidate' || codes.includes('RPE_MID_CONSOLIDATE') || codes.includes('LOW_EVIDENCE') || codes.includes('RPE_6_HOLD')) {
      return {
        cls: 'advance',
        title: human?.headline || 'Consolidar',
        summary: human?.body || 'Mantenemos tu entrenamiento actual para consolidar la adaptación. No es un aumento.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`, 'Consolidar'] : ['Consolidar']
      };
    }
    if (action === 'reduce' || codes.includes('RPE_VERY_HIGH')) {
      return {
        cls: 'repeat',
        title: 'Reducir carga',
        summary: 'Bajamos una variable de dificultad para recuperar tolerancia.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`, 'Reducir'] : ['Reducir']
      };
    }
    if (action === 'reassess') {
      return {
        cls: 'repeat',
        title: 'Reevaluar',
        summary: 'Tras una pausa, recalibramos el punto de partida sin borrar tu historial.',
        chips: ['Reevaluar']
      };
    }
    if (progression === 'advance' || action === 'progress') {
      return {
        cls: 'advance',
        title: 'Progresar',
        summary: 'Completaste la sesión con buena tolerancia. El próximo estímulo ajusta una variable de carga con límite conservador.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`] : []
      };
    }
    if (progression === 'repeat' || action === 'repeat') {
      const high = Number(rpe) >= 7 || codes.includes('RPE_GE_7') || codes.includes('RPE_HIGH');
      const incomplete = codes.includes('PRESCRIPTION_INCOMPLETE');
      const lowConf = codes.includes('LOW_CONFIDENCE') || codes.includes('LOW_EVIDENCE');
      let summary = 'Mantendremos este nivel antes de aumentar la carga.';
      if (incomplete) summary = 'La prescripción no se completó. Un esfuerzo bajo no alcanza para avanzar.';
      else if (high) summary = 'El entrenamiento resultó más exigente de lo esperado. Mantendremos este nivel antes de aumentar la carga.';
      else if (lowConf) summary = 'Todavía necesitamos más información antes de subir la carga. Repetimos este nivel.';
      else if (codes.includes('ALERT_PRESENT')) summary = 'Hubo una señal de molestia. Por ahora mantenemos este nivel.';
      const chips = [];
      if (high && rpe != null) chips.push(`RPE alto · ${rpe}/10`);
      else if (rpe != null) chips.push(`Esfuerzo ${rpe}/10`);
      if (incomplete) chips.push('Incompleto');
      return {
        cls: 'repeat',
        title: 'Repetir',
        summary,
        chips
      };
    }
    return { cls: '', title: '', summary: '', chips: [] };
  }

  function trendUserCopy(trend) {
    const tone = trend?.tone || 'estable';
    const profile = window.PaceAdaptive
      ? window.PaceAdaptive.deriveProfile(logs, plan, settings)
      : null;
    const caution = profile?.caution || window.PaceAdaptive?.assessCaution?.(logs, plan);
    const confidenceLine = profile
      ? `Confianza ${profile.confidence}: ${profile.confidenceNote}`
      : null;
    const cautionLine = caution?.level && caution.level !== 'none'
      ? `Precaución: ${(caution.reasons || []).join(' ')}`
      : 'Sin precaución activa: no hay factores recientes que obliguen a bajar la carga.';

    if (tone === 'favorable') {
      return {
        tone,
        title: 'Buena progresión',
        detail: 'Tus sesiones recientes muestran buena tolerancia al entrenamiento.',
        confidenceLine,
        cautionLine
      };
    }
    if (tone === 'precaucion' || (caution && caution.level !== 'none')) {
      return {
        tone: 'precaucion',
        title: 'Precaución',
        detail: (caution?.reasons && caution.reasons[0]) || 'Algún factor aconseja moderar la próxima carga.',
        confidenceLine,
        cautionLine
      };
    }
    const valid = Coach().validTrainingAttempts(logs, plan);
    if (valid.length < 2) {
      return {
        tone: 'estable',
        title: 'Construyendo tendencia',
        detail: 'Necesitamos más entrenamientos para evaluar tu evolución.',
        confidenceLine,
        cautionLine
      };
    }
    return {
      tone: 'estable',
      title: 'Estable',
      detail: 'Tus sesiones recientes se mantienen en un rango similar.',
      confidenceLine,
      cautionLine
    };
  }

  function lastFocusDecision() {
    const focus = Coach().getFocusSession(plan);
    const underlying = Coach().getUnderlyingPlanItem(plan, focus);
    const attempts = underlying?.attempts || [];
    if (!attempts.length) return null;
    const last = attempts[attempts.length - 1];
    const log = logs.find(l => l.id === last.logId) || null;
    return { attempt: last, log, underlying, focus };
  }

  function adaptationCopy(result, log) {
    const decision = result?.decision || {
      progression: log?.progression,
      reasonCode: log?.reasonCode || [],
      action: result?.action,
      adaptiveAction: result?.action
    };
    const copy = decisionUserCopy({
      ...log,
      progression: decision.progression,
      reasonCode: decision.reasonCode || log?.reasonCode,
      action: decision.adaptiveAction || decision.action || result?.action,
      adaptiveAction: decision.adaptiveAction || decision.action || result?.action
    });
    const next = result?.next || Coach().getFocusSession(plan);
    const nextRun = next?.kind === 'run'
      ? next
      : Coach().sortedPlanSessions(plan).find(s => (s.status === 'pending' || s.status === 'rescheduled') && s.kind === 'run');
    let nextLine = '';
    if (nextRun?.structure) {
      const st = nextRun.structure;
      if (!st.walkSeconds) {
        nextLine = `Carrera continua · ${formatMinutesLabel(st.runSeconds)}`;
      } else {
        nextLine = `${formatMinutesLabel(st.runSeconds)} correr / ${formatMinutesLabel(st.walkSeconds)} caminar ×${st.reps}`;
      }
    } else if (next?.kind === 'rest') {
      nextLine = 'Recuperación en el plan';
    } else {
      nextLine = 'Sin sesión pendiente';
    }
    const expl = result?.explanation;
    let headline = copy.title;
    let body = decision.reason || copy.summary;
    if (expl?.actionLabel) headline = expl.actionLabel;
    if (expl?.sameLoad && (decision.adaptiveAction === 'consolidate' || decision.action === 'consolidate')) {
      headline = 'Consolidar';
      body = decision.reason || 'Misma carga: consolidamos tolerancia.';
    }
    const changeLines = (expl?.lines || []).map(l => l.text);
    const previousLine = expl?.previous || (result?.previousStructure
      ? Coach().describeStructure(result.previousStructure)
      : '');
    return {
      headline,
      body,
      nextLine,
      previousLine,
      previousRunAccum: expl?.previousRunAccum || null,
      nextRunAccum: expl?.nextRunAccum || null,
      changeLines,
      interpretation: expl?.interpretation || '',
      speedSuggestion: result?.speedSuggestion || expl?.speedSuggestion || plan?.pendingSpeedSuggestion || null,
      cls: copy.cls,
      chips: copy.chips,
      action: decision.adaptiveAction || decision.action || result?.action
    };
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || $('#keepAwake').getAttribute('aria-pressed') !== 'true') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        if (document.visibilityState === 'visible' && $('#keepAwake').getAttribute('aria-pressed') === 'true' && running) {
          requestWakeLock();
        }
      });
    } catch { /* deny */ }
  }

  async function toggleWakeLock() {
    const button = $('#keepAwake');
    const active = button.getAttribute('aria-pressed') === 'true';
    if (active) {
      button.setAttribute('aria-pressed', 'false');
      button.textContent = 'Pantalla activa';
      syncToggleButtons();
      if (wakeLock) {
        try { await wakeLock.release(); } catch { /* */ }
        wakeLock = null;
      }
      return;
    }
    if (!('wakeLock' in navigator)) {
      showToast('Tu navegador no permite mantener la pantalla activa automáticamente.');
      return;
    }
    button.setAttribute('aria-pressed', 'true');
    button.textContent = 'Mantener activa';
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      syncToggleButtons();
      showToast('Pantalla activa durante la sesión');
    } catch {
      button.setAttribute('aria-pressed', 'false');
      syncToggleButtons();
      showToast('No se pudo activar el bloqueo de pantalla');
    }
  }

  function syncToggleButtons() {
    $('#toggleVoice').setAttribute('aria-pressed', String(settings.voice));
    $('#toggleAudio').setAttribute('aria-pressed', String(settings.sound));
    $('#countdownToggle').checked = settings.countdown;
    $('#voiceToggle').checked = settings.voice;
    $('#soundToggle').checked = settings.sound;
    const sound = $('#prepSound');
    const voice = $('#prepVoice');
    const wakeOn = $('#keepAwake').getAttribute('aria-pressed') === 'true';
    if (sound) {
      sound.classList.toggle('is-on', settings.sound);
      sound.classList.toggle('is-off', !settings.sound);
      $('#prepSoundState').textContent = settings.sound ? 'Listo' : 'Apagado';
    }
    if (voice) {
      voice.classList.toggle('is-on', settings.voice);
      voice.classList.toggle('is-off', !settings.voice);
      $('#prepVoiceState').textContent = settings.voice ? 'Lista' : 'Apagada';
    }
    const wake = $('#prepWake');
    if (wake) {
      wake.classList.toggle('is-on', wakeOn);
      wake.classList.toggle('is-off', !wakeOn);
      $('#prepWakeState').textContent = wakeOn ? 'Lista' : 'Apagada';
    }
  }

  async function testAlerts() {
    try {
      if (!settings.sound && !settings.voice) {
        showToast('Activá sonido o voz para probar.');
        return;
      }
      await unlockAudio();
      warmSpeech();
      if (settings.sound) {
        const ok = await beep(880, 260);
        if (!ok) {
          showToast('No se pudo activar el audio. Tocá de nuevo. En iPhone, desactivá el silencio lateral.');
          return;
        }
      }
      if (settings.voice) speak('Alertas listas.');
      showToast(settings.sound
        ? 'Sonido enviado. Si no lo oís: volumen medio y desactivá el silencio del teléfono.'
        : 'Voz de prueba enviada.');
    } catch (error) {
      console.error('[pace01] test-alerts', error);
      showToast('No se pudieron probar las alertas');
    }
  }

  function navTo(view) {
    $$('.view').forEach(v => v.classList.toggle('is-active', v.dataset.view === view));
    $$('.nav-item').forEach(n => n.classList.toggle('is-active', n.dataset.nav === view));
    document.body.classList.toggle('is-running', view === 'train' && running);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    history.replaceState(null, '', `#${view}`);
    setTimeout(() => $('#app').focus({ preventScroll: true }), 50);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>'"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
  }

  function clearChoice(name) {
    $$(`input[name="${name}"]`).forEach(el => { el.checked = false; });
  }

  function selectedValue(name) {
    const el = $(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  }

  function togglePainDetails() {
    const yes = $('#painYes')?.checked;
    if ($('#painDetails')) $('#painDetails').hidden = !yes;
    // No usar required nativo: campos en pasos ocultos bloquean el submit sin mensaje visible.
    if ($('#sessionPainLocation')) $('#sessionPainLocation').required = false;
  }

  function sortedLogs() {
    return [...logs].sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
  }

  function historyKind(entry) {
    if (entry.source === 'external') return 'Actividad externa';
    if (entry.type === 'Recuperación' || entry.source === 'rest') return 'Recuperación';
    if (entry.isControlTest) return 'Test de control';
    return 'Intervalos';
  }

  function isOutdoorUi() {
    return Boolean(window.PaceProduct?.outdoorCopyPreferred?.(account || window.PaceProduct.loadAccount()));
  }

  function homeSpeedText(kind, kmh) {
    if (!window.PaceProduct) return speedLabel(kmh);
    return window.PaceProduct.speedOrEffortLabel(kmh, { outdoor: isOutdoorUi(), kind });
  }

  function renderWeekCalendar() {
    const box = $('#weekCalendar');
    const grid = $('#weekGrid');
    if (!box || !grid || !window.PaceProduct || Coach().needsOnboarding(plan)) {
      if (box) box.hidden = true;
      return;
    }
    const days = window.PaceProduct.weekCalendar(plan, localDateISO());
    box.hidden = false;
    grid.innerHTML = days.map(d => {
      const item = d.items[0];
      const cls = item
        ? (item.kind === 'rest' ? 'dot-rest' : (String(item.title).includes('Test') ? 'dot-test' : 'dot-run'))
        : '';
      const label = item
        ? (item.kind === 'rest' ? 'Descanso' : (String(item.title).includes('Test') ? 'Test' : 'Correr'))
        : '—';
      return `<div class="week-day ${d.isToday ? 'is-today' : ''}">
        <strong>${escapeHtml(d.label)}</strong>
        <span class="${cls}">${escapeHtml(label)}</span>
      </div>`;
    }).join('');
  }

  function renderMilestones() {
    const box = $('#milestoneBox');
    const lines = $('#milestoneLines');
    if (!box || !lines || !window.PaceProduct || Coach().needsOnboarding(plan)) {
      if (box) box.hidden = true;
      return;
    }
    const m = window.PaceProduct.computeMilestones(logs, plan);
    box.hidden = false;
    lines.innerHTML = m.lines.map(t => escapeHtml(t)).join('<br>');
  }

  function renderGuideCard() {
    const card = $('#guideCard');
    if (!card || !window.PaceProduct || Coach().needsOnboarding(plan)) {
      if (card) card.hidden = true;
      return;
    }
    const completed = (logs || []).filter(l =>
      l.source !== 'external' && l.type !== 'Recuperación' && l.execution === 'completed'
    ).length;
    const tip = window.PaceProduct.nextGuidedTip(completed);
    if (!tip) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('#guideTitle').textContent = tip.title;
    $('#guideBody').textContent = tip.body;
    card.dataset.tipId = tip.id;
  }

  function renderHistory() {
    const sorted = sortedLogs();
    $('#historyCount').textContent = sorted.length;
    const bestDist = sorted.filter(s => typeof s.distanceKm === 'number' && s.source !== 'external').reduce((m, s) => Math.max(m, s.distanceKm), 0);
    $('#bestDistance').innerHTML = bestDist ? `${bestDist.toFixed(2).replace('.', ',')} <em>km</em>` : '—';
    const bestCont = sorted.filter(s => s.source !== 'external').reduce((m, s) => Math.max(m, Number(s.maxRunBlockSec) || 0), 0);
    $('#bestContinuous').textContent = bestCont ? Coach().formatBlock(bestCont) : '—';

    const empty = $('#historyEmpty');
    if (empty) empty.hidden = sorted.length > 0;

    const trend = trendUserCopy(Coach().summarizeTrend(logs, plan));
    const readiness = Coach().assessRaceReadiness(logs, plan);
    $('#historyTrend').innerHTML = sorted.length === 0
      ? `<div class="trend-block">
          <span class="metric-label">Tu tendencia</span>
          <strong class="metric-status">Sin datos aún</strong>
          <p class="trend-detail">Completá tu primera sesión para ver confianza, precaución y ritmo del ciclo.</p>
        </div>`
      : `
      <div class="trend-block">
        <span class="metric-label">Tu tendencia</span>
        <strong class="metric-status ${trend.tone}">${escapeHtml(trend.title)}</strong>
        <p class="trend-detail">${escapeHtml(trend.detail)}</p>
        <p class="trend-split"><strong>Confianza</strong> (${escapeHtml(readiness.confidenceLabel || readiness.confidence || '—')}): ${escapeHtml(trend.confidenceLine || 'Indica cuánta evidencia confiable hay para decidir.')}</p>
        <p class="trend-split"><strong>Precaución</strong>: ${escapeHtml(trend.cautionLine || 'Indica si conviene moderar la próxima carga.')}</p>
        <p class="trend-hint">Confianza y precaución no son opuestos: pueden coexistir.</p>
      </div>`;

    $('#historyList').innerHTML = sorted.map(s => {
      const date = new Date(`${s.date}T12:00:00`);
      const day = String(date.getDate()).padStart(2, '0');
      const month = date.toLocaleDateString('es-PY', { month: 'short' }).replace('.', '').toUpperCase();
      const kind = historyKind(s);
      const bits = [];
      if (s.time) bits.push(s.time);
      if (typeof s.distanceKm === 'number') bits.push(`${s.distanceKm.toFixed(2).replace('.', ',')} km`);
      if (s.rpe != null) bits.push(`Esfuerzo ${s.rpe}/10`);
      const decision = decisionUserCopy(s);
      const chips = decision.chips.map(c => `<span class="history-chip">${escapeHtml(c)}</span>`).join('');
      return `
        <button type="button" class="history-item" data-log-id="${escapeHtml(s.id)}">
          <div class="history-kicker"><strong>${day} ${month} ${date.getFullYear()}</strong></div>
          <div class="history-kind">${escapeHtml(kind)}</div>
          ${bits.length ? `<p class="history-facts">${escapeHtml(bits.join(' · '))}</p>` : ''}
          ${decision.title ? `<p class="history-decision ${decision.cls}">${escapeHtml(decision.title)}</p>` : ''}
          ${decision.summary ? `<p class="history-why">${escapeHtml(decision.summary)}</p>` : ''}
          ${chips ? `<div class="history-chips">${chips}</div>` : ''}
        </button>
      `;
    }).join('');
  }

  function openHistoryDetail(logId) {
    const s = logs.find(l => l.id === logId);
    if (!s) return;
    const decision = decisionUserCopy(s);
    const env = s.environment || (s.type === 'Cinta' ? 'treadmill' : s.type === 'Exterior' ? 'outdoor' : null);
    const rows = [
      ['Fecha', s.date],
      ['Tipo', historyKind(s)],
      ['Duración', s.time || '—'],
      ['Distancia', typeof s.distanceKm === 'number' ? `${s.distanceKm.toFixed(2).replace('.', ',')} km` : '—'],
      ...paceRowsForLog(s),
      ['Lugar', environmentLabel(env)],
      ['Máx. continuo', s.maxRunBlockSec != null ? Coach().formatBlock(s.maxRunBlockSec) : '—'],
      ['Esfuerzo', s.rpe != null ? `${s.rpe}/10` : '—'],
      ['Completado', s.prescriptionCompleted === false || s.execution === 'aborted' ? 'Incompleto' : (s.execution === 'skipped' ? 'Omitido' : 'Sí')],
      ['Molestia', s.pain ? `${s.painLocation || 'Sí'}${s.painIntensity != null ? ` · ${s.painIntensity}/5` : ''}` : 'No'],
      ['Decisión', decision.title || '—'],
      ['Motivo', decision.summary || '—']
    ];
    $('#historyDetailTitle').textContent = historyKind(s);
    $('#historyDetailBody').innerHTML = `${rows.map(([k, v]) => `
      <div class="detail-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>
    `).join('')}
      <div class="modal-actions" style="margin-top:12px">
        <button type="button" class="quiet-button" id="editLogFromDetail" data-log-id="${escapeHtml(s.id)}">Corregir datos</button>
      </div>`;
    if (!$('#historyDetailDialog').open) $('#historyDetailDialog').showModal();
    $('#editLogFromDetail')?.addEventListener('click', () => {
      $('#historyDetailDialog')?.close();
      openEditLog(s.id);
    }, { once: true });
  }

  function renderSequence() {
    const sessions = Coach().sortedPlanSessions(plan);
    const stats = Coach().planStats(plan);
    $('#sequenceBar').innerHTML = sessions.map(s => {
      const cls = `seq-pill ${s.kind} ${s.status}`;
      const label = s.kind === 'rest' ? 'R' : String(s.weekGroup);
      return `<span class="${cls}" title="${escapeHtml(s.title)} · ${s.status}">${label}</span>`;
    }).join('');
    $('#sequenceHelp').textContent = `${stats.done} ítems cerrados · ${stats.pending} abiertos · ${stats.completedAttempts} intentos completados · ${stats.skipped} omitidos. Ejecución ≠ progresión.`;
  }

  function syncDistanceEstimateUi() {
    const estimated = $('#sessionDistanceEstimated').checked;
    $('#distanceEstPill').textContent = estimated ? 'Estimada · sin confirmar' : 'Confirmada (real)';
    $('#distanceEstPill').classList.toggle('is-confirmed', !estimated);
    $('#confirmDistanceBtn').hidden = !estimated;
    $('#distanceHint').textContent = estimated
      ? 'Estimada según velocidades de la app. Confirmá si la cinta/reloj muestra otro valor.'
      : 'Distancia confirmada por vos. Ya no se trata como estimada.';
  }

  function collectOnboardingDraft() {
    return {
      goalType: selectedValue('onboardGoal') || '5k_finish_runwalk',
      continuousAbility: selectedValue('onboardAbility') || '1min',
      sessionsPerWeek: Number(selectedValue('onboardDays') || 3),
      environment: selectedValue('onboardEnv') || 'both',
      hasPain: selectedValue('onboardPain') === 'yes',
      painNote: $('#onboardPainNote')?.value?.trim() || '',
      runSpeed: parseOptionalNumber($('#onboardRunSpeed')?.value),
      raceDate: $('#onboardRaceDate')?.value || null
    };
  }

  function updateOnboardingPreview() {
    if (!window.PaceAdaptive) return;
    const draft = collectOnboardingDraft();
    const intake = window.PaceAdaptive.normalizeIntake(draft);
    const st = window.PaceAdaptive.startingStructureForAbility(intake.continuousAbility, {
      conservative: intake.hasPain
    });
    const body = $('#onboardPreviewBody');
    const note = $('#onboardPreviewNote');
    if (body) body.textContent = window.PaceAdaptive.describeStructure(st);
    if (note) {
      const stageLabel = ({
        1: 'Caminar', 2: 'Caminar y trotar', 3: 'Desarrollo continuo',
        4: 'Completar 5K', 5: 'Mejorar rendimiento', 6: 'Objetivos posteriores'
      })[intake.intakeStage] || '';
      note.textContent = `${stageLabel} · ${intake.sessionsPerWeek} días/sem${intake.hasPain ? ' · arranque conservador por molestia' : ''}`;
    }
  }

  function showOnboardStep(step) {
    onboardStep = step;
    $$('[data-onboard-step]').forEach(el => {
      el.hidden = Number(el.dataset.onboardStep) !== step;
    });
    $$('[data-onboard-dot]').forEach(el => {
      const n = Number(el.dataset.onboardDot);
      el.classList.toggle('is-current', n === step);
      el.classList.toggle('is-done', n < step);
    });
    const titles = {
      1: 'Tu objetivo',
      2: 'Tu nivel hoy',
      3: 'Cómo entrenás',
      4: 'Último detalle'
    };
    if ($('#onboardTitle')) $('#onboardTitle').textContent = titles[step] || 'Tu punto de partida';
    $('#onboardBack').hidden = step === 1;
    $('#onboardNext').hidden = step === 4;
    $('#onboardFinish').hidden = step !== 4;
    if (step === 4) updateOnboardingPreview();
  }

  function openOnboarding() {
    onboardStep = 1;
    showOnboardStep(1);
    const painWrap = $('#onboardPainNoteWrap');
    if (painWrap) painWrap.hidden = selectedValue('onboardPain') !== 'yes';
    const dialog = $('#onboardingDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function finishOnboarding() {
    const draft = collectOnboardingDraft();
    if (draft.hasPain && !draft.painNote) {
      showToast('Indicá dónde está la molestia');
      return;
    }
    try {
      if (draft.runSpeed) {
        settings.runSpeed = draft.runSpeed;
        persistSettings();
      }
      if (draft.environment === 'outdoor' || draft.environment === 'treadmill') {
        settings.lastEnvironment = draft.environment;
        persistSettings();
      }
      plan = Coach().applyIntake(draft, settings);
      logs = Coach().loadLogs();
      $('#onboardingDialog')?.close();
      reloadWorkoutFromPlan();
      setupDates();
      renderSettings();
      renderHistory();
      renderHome();
      showToast('Plan creado a tu medida');
      navTo('home');
    } catch (err) {
      console.error('[pace01] onboarding', err);
      showToast('No se pudo crear el plan. Probá de nuevo.');
    }
  }

  async function applyRecalibration(direction) {
    const out = Coach().recalibrateFocus(plan, logs, settings, direction);
    plan = out.plan;
    Coach().savePlan(plan);
    reloadWorkoutFromPlan();
    renderHome();
    showToast(out.message || (out.changed ? 'Plan recalibrado' : 'Sin cambios'));
  }

  function renderHome() {
    const needsIntro = Coach().needsOnboarding(plan);
    const readiness = Coach().assessRaceReadiness(logs, plan);
    const focus = needsIntro ? null : Coach().getFocusSession(plan);
    const underlying = focus ? Coach().getUnderlyingPlanItem(plan, focus) : null;
    const isRest = focus?.kind === 'rest';
    const isRun = focus?.kind === 'run';

    if ($('#todayOnboarding')) $('#todayOnboarding').hidden = !needsIntro;
    const sessionMatch = String(focus?.title || '').match(/sesi[oó]n\s*(\d+)/i);
    if ($('#coachEyebrow')) {
      $('#coachEyebrow').textContent = sessionMatch ? `Hoy · Sesión ${sessionMatch[1]}` : 'Hoy';
    }
    $('#todayRun').hidden = !isRun || needsIntro;
    $('#todayRest').hidden = !isRest || needsIntro;
    $('#todayDone').hidden = needsIntro || Boolean(focus);
    const todayIso = localDateISO();
    const trainedToday = Coach().hasTrainingOnDate(logs, todayIso);
    const recoveredToday = Coach().hasRecoveryOnDate(logs, todayIso);
    // Recuperación voluntaria solo si hay intervalos pendientes y hoy no entrenaste ni marcaste recuperación.
    $('#recoveryOffer').hidden = needsIntro || !(isRun && !trainedToday && !recoveredToday);
    $('#quietActions').hidden = needsIntro || !focus;
    $('#rescheduleSession').hidden = needsIntro || !focus;
    $('#skipSession').hidden = needsIntro || !focus;
    if ($('#recalibrateRow')) $('#recalibrateRow').hidden = needsIntro || !isRun;

    const scheduleNote = $('#scheduleNote');
    if (isRun && underlying?.status === 'rescheduled' && underlying.scheduledDate) {
      scheduleNote.hidden = false;
      scheduleNote.textContent = `Reprogramada para ${formatFriendlyDate(underlying.scheduledDate) || underlying.scheduledDate}. Es la misma sesión.`;
    } else if (focus?.scheduledDate) {
      scheduleNote.hidden = false;
      scheduleNote.textContent = focus.kind === 'rest'
        ? `Recuperación programada: ${formatFriendlyDate(focus.scheduledDate) || focus.scheduledDate}.`
        : `Programada: ${formatFriendlyDate(focus.scheduledDate) || focus.scheduledDate}.`;
    } else {
      scheduleNote.hidden = true;
    }

    const confEl = $('#confidenceExplain');
    const cautEl = $('#cautionExplain');
    if (window.PaceAdaptive) {
      const profile = window.PaceAdaptive.deriveProfile(logs, plan, settings);
      if (confEl) {
        confEl.hidden = false;
        confEl.textContent = `Confianza ${profile.confidence}: ${profile.confidenceNote}`;
      }
      if (cautEl) {
        const c = profile.caution;
        cautEl.hidden = false;
        cautEl.textContent = c?.level && c.level !== 'none'
          ? `Precaución: ${(c.reasons || []).join(' ')}`
          : 'Precaución: sin factores activos.';
      }
    }

    if (isRest) {
      $('#restTitle').textContent = focus.gateForId ? 'Recuperación' : 'Recuperación';
      $('#restMeta').textContent = focus.gateForId
        ? 'Antes de volver a la misma sesión.'
        : 'Hoy el plan pide no correr.';
      $('#homeRestNote').textContent = focus.structure?.note || 'Registrar este día no reemplaza un entrenamiento ni lo da por hecho.';
    }

    if (isRun && focus) {
      const st = focus.structure;
      const minutes = structureDurationMin(st);
      const km = estimateStructureKm(st);
      const continuous = Number(st.walkSeconds) === 0;
      $('#coachTitle').textContent = continuous ? 'Carrera continua' : 'Intervalos';
      $('#homeMinutes').textContent = String(minutes);
      $('#homeKm').textContent = km.toFixed(2).replace('.', ',');
      const cue = (sec) => formatTime(sec).replace(/^0/, '');
      $('#homeWarmDur').textContent = formatMinutesLabel(st.warmSeconds);
      $('#homeWarmLine').textContent = 'Calentamiento';
      if (focus.isControlTest) $('#coachTitle').textContent = 'Test de control';
      $('#homeWarmSpeed').textContent = homeSpeedText('warm', settings.walkSpeed);
      $('#homeReps').textContent = Number(st.walkSeconds) > 0 ? `${st.reps}×` : '1×';
      $('#homeWorkLine').textContent = `Correr ${cue(st.runSeconds)}`;
      $('#homeWalkLine').textContent = Number(st.walkSeconds) > 0
        ? `Caminar ${cue(st.walkSeconds)}`
        : 'Carrera continua';
      $('#homeRunSpeed').textContent = homeSpeedText('run', settings.runSpeed);
      $('#homeWalkSpeed').textContent = Number(st.walkSeconds) > 0
        ? homeSpeedText('walk', settings.walkSpeed)
        : '—';
      $('#homeCoolDur').textContent = formatMinutesLabel(st.coolSeconds);
      $('#homeCoolLine').textContent = 'Enfriamiento';
      $('#homeCoolSpeed').textContent = homeSpeedText('cool', settings.coolSpeed);
    }

    const adaptNote = $('#homeAdaptNote');
    if (adaptNote) {
      const ctx = lastFocusDecision();
      if (isRun && ctx?.attempt) {
        const copy = decisionUserCopy({
          ...(ctx.log || {}),
          progression: ctx.attempt.progression,
          reasonCode: ctx.attempt.reasonCode,
          rpe: ctx.attempt.rpe,
          action: ctx.attempt.adaptiveAction || ctx.attempt.action,
          adaptiveAction: ctx.attempt.adaptiveAction || ctx.attempt.action
        });
        const act = ctx.attempt.adaptiveAction || ctx.attempt.action;
        if (ctx.attempt.progression === 'repeat' || act === 'repeat') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Repetir</strong><em>${escapeHtml(Number(ctx.attempt.rpe) >= 7 ? 'La anterior resultó muy exigente.' : copy.summary)}</em>`;
        } else if (ctx.attempt.progression === 'recovery' || act === 'recovery') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Recuperación</strong><em>Completá la recuperación para habilitar la misma sesión de carrera.</em>`;
        } else if (act === 'consolidate') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Consolidar</strong><em>${escapeHtml(copy.summary)}</em>`;
        } else if (act === 'reduce') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Reducir carga</strong><em>${escapeHtml(copy.summary)}</em>`;
        } else if (ctx.attempt.progression === 'advance' || String(act || '').startsWith('progress')) {
          const expl = lastSaveResult?.explanation;
          const change = expl?.interpretation || expl?.summary || copy.summary;
          const label = copy.title || (String(act).includes('continuous') ? 'Progresión de continuo' : 'Progresar');
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>${escapeHtml(label)}</strong><em>${escapeHtml(change)}</em>`;
        } else {
          adaptNote.hidden = true;
          adaptNote.innerHTML = '';
        }
      } else {
        adaptNote.hidden = true;
        adaptNote.innerHTML = '';
      }
    }

    const goalLabel = plan?.goal?.label || readiness.focusTarget || 'Entrenar';
    $('#readinessBadge').textContent = needsIntro ? 'Onboarding' : readiness.label;
    $('#readinessBadge').className = `sr-only distance-badge level-${readiness.level}`;
    $('#readinessTarget').textContent = `foco ${readiness.focusTarget}`;
    $('#readinessConfidence').textContent = needsIntro ? 'Sin perfil aún' : readiness.confidenceLabel;
    $('#readinessConfidence').className = `distance-badge conf conf-${readiness.confidence}`;
    $('#readinessHeadline').textContent = needsIntro ? 'Objetivo · por definir' : `Objetivo · ${goalLabel}`;
    $('#readinessSummary').textContent = 'Decidimos por evidencia, no por entusiasmo.';
    $('#evidenceNeed').textContent = needsIntro
      ? 'Completá el onboarding para armar un plan acorde a tu nivel.'
      : evidenceCopy(readiness);
    const fill = needsIntro ? 8 : readiness.level === 'listo' ? 100 : readiness.level === 'cerca' ? 58 : 22;
    $('#readinessBar')?.style.setProperty('--fill', `${fill}%`);
    $('#checkpointLabel').textContent = plan?.checkpointDate ? formatShortDate(plan.checkpointDate) : '—';
    const checkpointDays = readiness.daysToCheckpoint;
    $('#checkpointCountdown').textContent = !plan?.checkpointDate
      ? ''
      : checkpointDays == null
        ? ''
        : checkpointDays > 0
          ? `${checkpointDays} días`
          : checkpointDays === 0
            ? 'hoy'
            : 'checkpoint pasado · revisar evidencia';

    if ($('#homeSecondary')) $('#homeSecondary').hidden = needsIntro;
    renderWeekCalendar();
    renderMilestones();
    renderGuideCard();
    renderSequence();
  }

  function parseOptionalNumber(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function timeToSec(t) {
    const p = String(t || '').split(':').map(Number);
    if (p.some(n => !Number.isFinite(n))) return 0;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return Number(t) || 0;
  }

  /** Máscara de tiempo: solo dígitos → MM:SS o H:MM:SS (no hace falta tipear ':'). */
  function maskTimeDigits(raw) {
    const digits = String(raw || '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return '';
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) {
      return `${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}`;
    }
    return `${digits.slice(0, digits.length - 4)}:${digits.slice(-4, -2)}:${digits.slice(-2)}`;
  }

  function normalizeTimeField(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) return trimmed;
    return maskTimeDigits(trimmed);
  }

  function structureForSessionId(planSessionId) {
    if (planSessionId && plan?.sessions) {
      const hit = plan.sessions.find(s => s.id === planSessionId && s.kind === 'run');
      if (hit?.structure) return hit.structure;
    }
    return focusStructure();
  }

  function computePaceFromForm() {
    if (!window.PaceAdaptive?.computeSessionPaceMetrics) return null;
    const elapsedSec = timeToSec($('#sessionTime')?.value);
    const distanceKm = parseOptionalNumber($('#sessionDistance')?.value);
    const planId = $('#sessionPlanId')?.value || activePlanSessionId || null;
    const external = $('#sessionExternal')?.value === '1';
    const structure = external ? null : structureForSessionId(planId);
    return window.PaceAdaptive.computeSessionPaceMetrics({
      elapsedSec,
      distanceKm,
      structure,
      speeds: settings
    });
  }

  function formatSpeedKmh(kmh) {
    if (!Number.isFinite(kmh) || kmh <= 0) return '—';
    return `${String(kmh).replace('.', ',')} km/h`;
  }

  function renderSessionMetricsPreview() {
    const box = $('#sessionMetricsPreview');
    const body = $('#sessionMetricsPreviewBody');
    const note = $('#sessionMetricsPreviewNote');
    if (!box || !body) return;
    const metrics = computePaceFromForm();
    if (!metrics || (!metrics.cyclePaceLabel && !metrics.overallPaceLabel)) {
      box.hidden = true;
      body.innerHTML = '';
      if (note) note.textContent = '';
      return;
    }
    box.hidden = false;
    const cycleLabel = metrics.cyclePaceLabel || metrics.overallPaceLabel || '—';
    const runLabel = metrics.isContinuous
      ? (metrics.runPaceLabel || cycleLabel)
      : (metrics.runPaceLabel || '—');
    const cycleSpeed = formatSpeedKmh(metrics.cycleSpeedKmh || metrics.overallSpeedKmh);
    const runSpeed = formatSpeedKmh(metrics.runSpeedKmh);
    body.innerHTML = `
      <div><span>Ritmo del ciclo</span><strong>${escapeHtml(cycleLabel)}</strong></div>
      <div><span>${metrics.isContinuous ? 'Velocidad media' : 'Ritmo solo carrera'}</span><strong>${escapeHtml(metrics.isContinuous ? cycleSpeed : runLabel)}</strong></div>
      <div><span>Km del ciclo</span><strong>${escapeHtml(String(metrics.cycleKm).replace('.', ','))} km</strong></div>
      <div><span>${metrics.isContinuous ? 'Ritmo global' : 'Vel. carrera'}</span><strong>${escapeHtml(metrics.isContinuous ? cycleLabel : runSpeed)}</strong></div>
    `;
    if (note) {
      note.textContent = metrics.distanceSource === 'attributed'
        ? 'Distancia repartida por tiempo×velocidad de cada bloque. El ciclo excluye calentamiento y enfriamiento.'
        : metrics.distanceSource === 'estimated'
          ? 'Sin distancia confirmada: ritmos estimados con tus velocidades de ajustes.'
          : 'Ritmo sobre el tiempo/distancia totales (sin estructura de bloques).';
    }
  }

  function paceRowsForLog(log) {
    const m = log?.paceMetrics;
    if (!m) return [];
    const rows = [];
    if (m.cyclePaceLabel) {
      rows.push(['Ritmo ciclo (sin warm/cool)', `${m.cyclePaceLabel}${m.cycleSpeedKmh ? ` · ${formatSpeedKmh(m.cycleSpeedKmh)}` : ''}`]);
    }
    if (m.runPaceLabel && !m.isContinuous) {
      rows.push(['Ritmo solo carrera', `${m.runPaceLabel}${m.runSpeedKmh ? ` · ${formatSpeedKmh(m.runSpeedKmh)}` : ''}`]);
    }
    if (m.cycleKm != null) rows.push(['Distancia del ciclo', `${String(m.cycleKm).replace('.', ',')} km`]);
    return rows;
  }

  let saveInFlight = false;

  async function saveSessionFromForm(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (saveInFlight) return;

    const saveBtn = $('#saveSession');
    const setSavingUi = (busy) => {
      saveInFlight = busy;
      if (!saveBtn) return;
      saveBtn.disabled = busy;
      saveBtn.textContent = busy ? 'Guardando…' : 'Guardar entrenamiento';
    };

    try {
      const rpe = selectedValue('sessionRpe');
      const painVal = selectedValue('sessionPain');
      if (!rpe || !painVal) {
        showToast('Completá RPE y molestia/dolor');
        showCloseStep(1);
        return;
      }
      const pain = painVal === 'yes';
      if (pain && !$('#sessionPainLocation').value.trim()) {
        showToast('Indicá la ubicación de la molestia');
        showCloseStep(1);
        return;
      }
      const done = selectedValue('prescriptionDone');
      if (!done) {
        showToast('Indicá si terminaste la sesión');
        showCloseStep(1);
        return;
      }
      if (!$('#sessionDate').value || !$('#sessionTime').value.trim()) {
        showToast('Completá fecha y tiempo');
        showCloseStep(2);
        return;
      }

      setSavingUi(true);

      const external = $('#sessionExternal').value === '1';
      const fromTimer = $('#sessionFromTimer').value === '1';
      if (fromTimer) {
        const measured = closeMeasuredTime || formatTime(elapsedMs / 1000);
        const manual = $('#sessionTime').value.trim();
        if (manual && measured && manual !== measured) {
          const delta = Math.abs(timeToSec(manual) - timeToSec(measured));
          if (delta >= 60) {
            const ok = await askConfirm({
              title: '¿Confirmás el tiempo?',
              body: `El tiempo indicado (${manual}) difiere del cronómetro (${measured}) en unos ${Math.round(delta)} s.`,
              ok: 'Guardar con ese tiempo',
              cancel: 'Revisar'
            });
            if (!ok) {
              showCloseStep(2);
              return;
            }
          }
        }
      }

      const date = $('#sessionDate').value || localDateISO();
      const id = `${date}-${Date.now()}`;
      const prescriptionCompleted = done === 'yes';
      const typeValue = $('#sessionType').value;
      const environment = typeValue === 'Cinta' ? 'treadmill'
        : typeValue === 'Exterior' ? 'outdoor'
        : (sessionEnvironment || settings.lastEnvironment || null);
      const timeRaw = normalizeTimeField($('#sessionTime').value);
      $('#sessionTime').value = timeRaw;
      const elapsedSec = timeToSec(timeRaw);
      const distanceKm = parseOptionalNumber($('#sessionDistance').value);
      const planSessionId = external ? null : ($('#sessionPlanId').value || activePlanSessionId || null);
      const structure = external ? null : structureForSessionId(planSessionId);
      const paceMetrics = window.PaceAdaptive?.computeSessionPaceMetrics({
        elapsedSec,
        distanceKm,
        structure,
        speeds: settings
      }) || null;
      const log = {
        id,
        date,
        type: typeValue,
        environment,
        planSessionId,
        time: timeRaw || null,
        elapsedSec: elapsedSec || null,
        distanceKm,
        distanceEstimated: $('#sessionDistanceEstimated').checked,
        maxRunBlockSec: parseOptionalNumber($('#sessionMaxRunBlockSec').value),
        couldContinue: selectedValue('couldContinue'),
        rpe: Number(rpe),
        pain,
        painLocation: pain ? $('#sessionPainLocation').value.trim() : '',
        painIntensity: pain ? parseOptionalNumber($('#sessionPainIntensity').value) : null,
        worseningDuringRun: pain && $('#flagWorsening').checked,
        alteredGait: pain && $('#flagAlteredGait').checked,
        forcedStop: pain && $('#flagForcedStop').checked,
        severeWarning: pain && $('#flagSevere').checked,
        prescriptionCompleted,
        extraSeconds: parseOptionalNumber($('#sessionExtraSec').value) || 0,
        execution: prescriptionCompleted ? 'completed' : 'aborted',
        progression: null,
        notes: $('#sessionNotes').value.trim(),
        source: external ? 'external' : (fromTimer ? 'timer' : 'manual'),
        paceMetrics,
        isControlTest: Boolean((plan?.sessions || []).find(s => s.id === planSessionId)?.isControlTest)
      };
      window.PaceProduct?.track?.('session_saved', {
        source: log.source,
        rpe: log.rpe,
        hasPace: Boolean(paceMetrics)
      });

      logs.push(log);
      let result = null;

      if (log.planSessionId && !external) {
        result = Coach().confirmNextSession(plan, log, logs);
        plan = result.plan;
        lastSaveResult = result;
        Coach().savePlan(plan);
        Coach().saveLogs(logs);
        audit('session-saved', { id: log.id, planSessionId: log.planSessionId, source: log.source });
        if (result.medicalNotice || result.decision?.medicalNotice) {
          setTimeout(() => {
            showToast('Suspendé entrenamiento y considerá evaluación profesional. PACE/01 no diagnostica.');
          }, 3400);
        }
      } else {
        Coach().saveLogs(logs);
        lastSaveResult = null;
        audit('log-unlinked', { source: log.source, id: log.id });
      }

      if (environment) {
        settings.lastEnvironment = environment;
        persistSettings();
      }

      closeMeasuredTime = null;
      if ($('#sessionDialog')?.open) $('#sessionDialog').close();
      $('#sessionForm').reset();
      $('#sessionFromTimer').value = '0';
      $('#sessionPainLocation').required = false;
      togglePainDetails();
      reloadWorkoutFromPlan();
      renderHistory();
      renderHome();

      // UI post-guardado: si falla, el dato YA está en localStorage; no digas «no se pudo guardar».
      try {
        if (result && !external) showAdaptationResult(result, log);
        else {
          showToast(external ? 'Actividad externa guardada. El plan no se movió.' : 'Entrenamiento guardado');
          navTo('home');
        }
      } catch (uiErr) {
        console.error('[pace01] save-session-ui', uiErr);
        showToast('Entrenamiento guardado');
        navTo('home');
      }
    } catch (err) {
      console.error('[pace01] save-session', err);
      showToast('No se pudo guardar. Probá de nuevo; si persiste, exportá tu historial.');
      showCloseStep(2);
    } finally {
      setSavingUi(false);
    }
  }

  function showAdaptationResult(result, log) {
    const adapt = adaptationCopy(result, log);
    const dialog = $('#adaptDialog');
    if (!dialog) {
      navTo('home');
      return;
    }
    $('#adaptEyebrow').textContent = 'Entrenamiento completado';
    $('#adaptTime').textContent = log.time || '—';
    $('#adaptDistance').textContent = typeof log.distanceKm === 'number'
      ? `${log.distanceKm.toFixed(2).replace('.', ',')} km`
      : '—';
    $('#adaptEffort').textContent = log.rpe != null ? `${log.rpe}/10` : '—';
    $('#adaptEffortNote').textContent = Number(log.rpe) >= 7 ? 'Muy exigente' : Number(log.rpe) <= 5 ? 'Cómodo' : 'Moderado';
    const pace = log.paceMetrics;
    const pacePanel = $('#adaptPacePanel');
    if (pacePanel) {
      if (pace && (pace.cyclePaceLabel || pace.overallPaceLabel)) {
        pacePanel.hidden = false;
        $('#adaptCyclePace').textContent = pace.cyclePaceLabel || pace.overallPaceLabel || '—';
        $('#adaptCyclePaceNote').textContent = pace.cycleKm != null
          ? `${String(pace.cycleKm).replace('.', ',')} km de ciclo`
          : 'sin warm/cool';
        $('#adaptRunPace').textContent = pace.isContinuous
          ? (pace.runPaceLabel || pace.cyclePaceLabel || '—')
          : (pace.runPaceLabel || '—');
        $('#adaptRunPaceNote').textContent = pace.isContinuous
          ? 'carrera continua'
          : (pace.runKm != null ? `${String(pace.runKm).replace('.', ',')} km corriendo` : 'solo segmentos run');
        $('#adaptCycleSpeed').textContent = formatSpeedKmh(pace.cycleSpeedKmh || pace.overallSpeedKmh);
        $('#adaptPaceHint').textContent = pace.distanceSource === 'attributed'
          ? 'Ritmo del trabajo real (sin calentamiento ni enfriamiento), repartiendo la distancia por cada bloque.'
          : pace.distanceSource === 'estimated'
            ? 'Ritmos estimados con tus velocidades de ajustes (sin distancia confirmada).'
            : 'Ritmo global tiempo ÷ distancia.';
      } else {
        pacePanel.hidden = true;
      }
    }
    $('#adaptPlace').textContent = `Realizado en: ${environmentLabel(log.environment)}`;
    const action = $('#adaptAction');
    action.className = `adapt-action ${adapt.cls}`;
    const act = adapt.action || result.action;
    const human = window.PaceProduct?.humanDecisionCopy?.(act, { rpe: log.rpe, nextLine: adapt.nextLine });
    const headline = human?.headline || adapt.headline;
    const body = human?.body || adapt.body;
    const changeHtml = (adapt.changeLines || []).length
      ? `<ul class="adapt-changes">${adapt.changeLines.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '';
    const prevHtml = adapt.previousLine
      ? `<p class="adapt-prev"><span>Antes</span> ${escapeHtml(adapt.previousLine)}${adapt.previousRunAccum ? ` · carrera acumulada ${escapeHtml(adapt.previousRunAccum)}` : ''}</p>`
      : '';
    const nextAccum = adapt.nextRunAccum
      ? `<p class="adapt-prev"><span>Ahora</span> ${escapeHtml(adapt.nextLine)} · carrera acumulada ${escapeHtml(adapt.nextRunAccum)}</p>`
      : '';
    const interpHtml = adapt.interpretation
      ? `<p class="adapt-interp">${escapeHtml(adapt.interpretation)}</p>`
      : '';
    const speed = adapt.speedSuggestion;
    const speedHtml = speed
      ? `<div class="adapt-speed" id="adaptSpeedBox" data-speed-action="${escapeHtml(speed.action || 'keep')}">
          <p>${escapeHtml(speed.message || '')}</p>
          ${speed.action === 'suggest_up' && speed.suggestedKmh != null
            ? `<div class="adapt-speed-actions">
                <button type="button" class="quiet-button" id="rejectSpeedBtn">Mantener ${escapeHtml(String(speed.currentKmh).replace('.', ','))}</button>
                <button type="button" class="primary-button accent-button" id="acceptSpeedBtn">Probar ${escapeHtml(String(speed.suggestedKmh).replace('.', ','))} km/h</button>
              </div>`
            : ''}
        </div>`
      : '';
    action.innerHTML = `<strong>${escapeHtml(headline)}</strong><p>${escapeHtml(body)}</p>${prevHtml}${nextAccum}${changeHtml}${interpHtml}${speedHtml}`;
    $('#adaptNext').textContent = adapt.nextLine;
    $('#adaptHint').textContent = human?.nextHint
      || (String(act || '').startsWith('progress')
        ? 'Subimos de a poco. Escuchá cómo responde tu cuerpo la próxima vez.'
        : act === 'consolidate'
          ? 'Repetir bien también es progreso.'
          : act === 'reduce'
            ? 'Bajamos carga para volver más fuertes. Tu historial se conserva.'
            : result.progression === 'repeat'
              ? 'Misma sesión otra vez: primero consolidar, después avanzar.'
              : 'Cuando estés listo, volvés a la sesión del plan.');
    window.PaceProduct?.track?.('session_adapt_shown', { action: act });
    if (!dialog.open) dialog.showModal();
    $('#acceptSpeedBtn')?.addEventListener('click', () => {
      const out = Coach().acceptSpeedSuggestion(plan, settings);
      plan = out.plan;
      settings = out.settings;
      Coach().savePlan(plan);
      persistSettings();
      showToast(out.message);
      $('#adaptSpeedBox')?.remove();
    }, { once: true });
    $('#rejectSpeedBtn')?.addEventListener('click', () => {
      const out = Coach().rejectSpeedSuggestion(plan);
      plan = out.plan;
      Coach().savePlan(plan);
      showToast(out.message);
      $('#adaptSpeedBox')?.remove();
    }, { once: true });
  }

  function reloadWorkoutFromPlan() {
    if (hasStarted && !finishedAnnounced) return;
    resetTimer({ quiet: true });
  }

  function openManualLog() {
    prepareCloseForm({ external: true });
    $('#sessionDistanceEstimated').checked = false;
    syncDistanceEstimateUi();
    $('#sessionMaxRunBlockSec').value = '';
    $('#sessionMaxRunBlockLabel').textContent = 'Solo si mediste un tramo de carrera. No inventes minutos.';
    $('#sessionTime').value = '';
    $('#sessionDialog').showModal();
  }

  /** Registrar una sesión del plan ya hecha (sin cronómetro). Sirve para recuperar cierres fallidos. */
  function openPlanSessionLog() {
    const run = activeRunSession();
    if (!run) {
      showToast('No hay una sesión de plan pendiente para registrar.');
      return;
    }
    prepareCloseForm({ external: false, fromTimer: false });
    closeMeasuredTime = null;
    activePlanSessionId = run.id;
    $('#sessionPlanId').value = run.id;
    $('#sessionDate').value = localDateISO();
    const st = run.structure;
    const estimatedMin = st ? structureDurationMin(st) : 0;
    // Precarga tiempo estimado del plan; el usuario puede corregirlo en el paso Guardar.
    $('#sessionTime').value = estimatedMin ? formatTime(estimatedMin * 60) : '';
    const km = st ? estimateStructureKm(st) : null;
    $('#sessionDistance').value = km ? km.toFixed(2) : '';
    $('#sessionDistanceEstimated').checked = true;
    syncDistanceEstimateUi();
    const cont = st?.runSeconds || '';
    $('#sessionMaxRunBlockSec').value = cont ? String(cont) : '';
    $('#sessionMaxRunBlockLabel').textContent = cont
      ? `${Coach().formatBlock(cont)} (prescrito; corregí si corriste más/menos)`
      : 'Indicá el mayor tramo continuo que corriste.';
    if ($('#finishHero')) $('#finishHero').hidden = true;
    $('#closeContext').hidden = false;
    $('#closeContext').textContent = 'Registro manual de la sesión del plan. Completá RPE y confirmá el tiempo (ya viene estimado). El botón Guardar queda fijo abajo.';
    showCloseStep(1);
    if (!$('#sessionDialog').open) $('#sessionDialog').showModal();
  }

  function finishAndSaveNow() {
    if (!activeRunSession()) {
      showToast('No hay entrenamiento activo del plan.');
      return;
    }
    if (!hasStarted && !finishedAnnounced) {
      openPlanSessionLog();
      return;
    }
    noteRunProgressOnLeave();
    elapsedMs = getLiveElapsedMs();
    pauseTimer();
    finishedAnnounced = true;
    remainingMs = 0;
    openCloseDialogFromTimer();
  }

  function renderSettings() {
    if (!account && window.PaceProduct) account = window.PaceProduct.loadAccount();
    $('#walkSpeed').value = settings.walkSpeed;
    $('#runSpeed').value = settings.runSpeed;
    $('#coolSpeed').value = settings.coolSpeed;
    if ($('#goalTypeSelect')) {
      $('#goalTypeSelect').value = plan?.goal?.type || plan?.intake?.goalType || '5k_finish_runwalk';
    }
    if ($('#raceDateInput')) {
      $('#raceDateInput').value = plan?.raceDate || plan?.goal?.raceDate || '';
    }
    if ($('#sessionsPerWeekSelect')) {
      const spw = plan?.params?.sessionsPerWeek || plan?.intake?.sessionsPerWeek || 3;
      $('#sessionsPerWeekSelect').value = String(spw);
    }
    if ($('#accountDisplayName')) $('#accountDisplayName').value = account?.displayName || '';
    if ($('#preferredSurfaceSelect')) $('#preferredSurfaceSelect').value = account?.preferredSurface || 'both';
    if ($('#remindersToggle')) $('#remindersToggle').checked = Boolean(account?.remindersEnabled);
    if ($('#accountIdNote')) $('#accountIdNote').textContent = `ID local: ${account?.id || '—'}`;
    if ($('#lastBackupNote')) {
      $('#lastBackupNote').textContent = account?.lastBackupAt
        ? `Último respaldo: ${account.lastBackupAt.slice(0, 16).replace('T', ' ')}`
        : 'Último respaldo: nunca';
    }
    if ($('#iosHelpList') && window.PaceProduct) {
      $('#iosHelpList').innerHTML = window.PaceProduct.iosPwaHelp().map(t => `<li>${escapeHtml(t)}</li>`).join('');
    }
    if ($('#profileStageNote') && window.PaceAdaptive) {
      const profile = window.PaceAdaptive.deriveProfile(logs, plan, settings);
      $('#profileStageNote').textContent = plan?.onboardingCompleted
        ? `Nivel: ${profile.stageLabel} · confianza ${profile.confidence}`
        : 'Completá el onboarding para personalizar el plan.';
    }
    syncToggleButtons();
  }

  function saveSettings(e) {
    e.preventDefault();
    const walk = Number($('#walkSpeed').value);
    const run = Number($('#runSpeed').value);
    const cool = Number($('#coolSpeed').value);
    const speedError = validateSpeeds(walk, run, cool);
    if (speedError) {
      showToast(speedError);
      return;
    }
    settings = {
      walkSpeed: walk,
      runSpeed: run,
      coolSpeed: cool,
      countdown: $('#countdownToggle').checked,
      voice: $('#voiceToggle').checked,
      sound: $('#soundToggle').checked,
      lastEnvironment: settings.lastEnvironment || null
    };
    persistSettings();
    if (window.PaceProduct) {
      account = window.PaceProduct.loadAccount();
      account.displayName = ($('#accountDisplayName')?.value || '').trim();
      account.preferredSurface = $('#preferredSurfaceSelect')?.value || 'both';
      account.remindersEnabled = Boolean($('#remindersToggle')?.checked);
      window.PaceProduct.saveAccount(account);
    }
    if (!Coach().needsOnboarding(plan)) {
      plan = Coach().updatePlanPreferences(plan, {
        goalType: $('#goalTypeSelect')?.value,
        raceDate: $('#raceDateInput')?.value || null,
        sessionsPerWeek: Number($('#sessionsPerWeekSelect')?.value || 3)
      }, logs, settings);
      Coach().savePlan(plan);
    }
    refreshWorkoutSpeeds();
    setupDates();
    renderSettings();
    renderHome();
    window.PaceProduct?.track?.('settings_saved');
    showToast('Preferencias guardadas');
  }

  function openSpeedDialog() {
    $('#sessionWalkSpeed').value = settings.walkSpeed;
    $('#sessionRunSpeed').value = settings.runSpeed;
    $('#sessionCoolSpeed').value = settings.coolSpeed;
    $('#speedDialog').showModal();
  }

  function saveSessionSpeeds(e) {
    e.preventDefault();
    const walk = Number($('#sessionWalkSpeed').value);
    const run = Number($('#sessionRunSpeed').value);
    const cool = Number($('#sessionCoolSpeed').value);
    const speedError = validateSpeeds(walk, run, cool);
    if (speedError) {
      showToast(speedError);
      return;
    }
    settings.walkSpeed = walk;
    settings.runSpeed = run;
    settings.coolSpeed = cool;
    persistSettings();
    refreshWorkoutSpeeds();
    renderSettings();
    renderHome();
    $('#speedDialog').close();
    showToast('Velocidades actualizadas');
  }

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSessions() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      plan,
      logs,
      account: account || (window.PaceProduct && window.PaceProduct.loadAccount())
    };
    downloadJson(`pace01-export-${localDateISO()}.json`, payload);
    if (window.PaceProduct) {
      account = window.PaceProduct.loadAccount();
      account.lastBackupAt = new Date().toISOString();
      window.PaceProduct.saveAccount(account);
      window.PaceProduct.track('export_backup');
    }
    showToast('Copia exportada');
    audit('export', { logs: logs.length });
    renderSettings();
  }

  function exportSyncPack() {
    if (!window.PaceProduct) {
      exportSessions();
      return;
    }
    const pack = window.PaceProduct.buildSyncPack({ settings, plan, logs, account });
    downloadJson(`pace01-sync-${localDateISO()}.json`, pack);
    account = window.PaceProduct.loadAccount();
    account.lastBackupAt = new Date().toISOString();
    window.PaceProduct.saveAccount(account);
    window.PaceProduct.track('export_sync_pack');
    showToast('Paquete de sync listo');
    renderSettings();
  }

  async function restoreSessions(file) {
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (error) {
      console.error('[pace01] restore', error);
      showToast('No se pudo leer el archivo');
      return;
    }
    const isSync = data?.format === 'pace01.sync.v1';
    if (!data || (!Array.isArray(data.logs) && !isSync) || (!Array.isArray(data.plan?.sessions) && !isSync)) {
      showToast('Ese archivo no tiene plan e historial de PACE/01');
      return;
    }
    const ok = await askConfirm({
      title: isSync ? '¿Importar paquete de sync?' : '¿Restaurar estos datos?',
      body: 'Reemplazan el plan y el historial de este dispositivo.',
      ok: isSync ? 'Importar' : 'Restaurar',
      cancel: 'Volver',
      danger: true
    });
    if (!ok) return;
    try {
      if (isSync && window.PaceProduct) {
        window.PaceProduct.applySyncPack(data);
        settings = loadSettings();
        account = window.PaceProduct.loadAccount();
      } else {
        if (data.settings && typeof data.settings === 'object') {
          settings = { ...defaultSettings, ...data.settings };
          persistSettings();
        }
        if (data.account && window.PaceProduct) {
          account = window.PaceProduct.saveAccount({
            ...window.PaceProduct.loadAccount(),
            ...data.account
          });
        }
        Coach().savePlan(data.plan);
        Coach().saveLogs(data.logs);
      }
      plan = Coach().loadPlan();
      logs = Coach().loadLogs();
      if (running) pauseTimer();
      resetTimer({ quiet: true });
      renderSettings();
      renderHistory();
      renderHome();
      setupDates();
      showToast('Datos restaurados en este dispositivo');
      audit('restore', { sessions: plan.sessions.length, logs: logs.length });
      window.PaceProduct?.track?.('restore_backup', { sync: Boolean(isSync) });
    } catch (error) {
      console.error('[pace01] restore-apply', error);
      showToast('No se pudieron aplicar los datos');
    }
  }

  function openLegalDialog({ force = false } = {}) {
    if (!window.PaceProduct) return;
    account = window.PaceProduct.loadAccount();
    if (!force && !window.PaceProduct.needsLegalAcceptance(account)) return;
    if ($('#legalPrivacyCheck')) $('#legalPrivacyCheck').checked = false;
    if ($('#legalMedicalCheck')) $('#legalMedicalCheck').checked = false;
    const dialog = $('#legalDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openEditLog(logId) {
    const s = logs.find(l => l.id === logId);
    if (!s) return;
    $('#editLogId').value = s.id;
    $('#editLogTime').value = s.time || '';
    $('#editLogDistance').value = typeof s.distanceKm === 'number' ? s.distanceKm : '';
    $('#editLogRpe').value = s.rpe != null ? s.rpe : '';
    $('#editLogNotes').value = s.notes || '';
    if (!$('#editLogDialog').open) $('#editLogDialog').showModal();
  }

  function askConfirm({ title, body, ok = 'Confirmar', cancel = 'Volver', danger = false }) {
    const dialog = $('#confirmDialog');
    const session = $('#sessionDialog');
    // Safari/iOS no admite bien dos <dialog modal> a la vez: cerramos el de sesión y lo reabrimos después.
    const reopenSession = Boolean(session?.open);
    if (reopenSession) {
      try { session.close(); } catch (err) {
        console.error('[pace01] close-session-before-confirm', err);
      }
    }
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    const okBtn = $('#confirmOk');
    const cancelBtn = $('#confirmCancel');
    okBtn.textContent = ok;
    cancelBtn.hidden = cancel == null;
    if (cancel != null) cancelBtn.textContent = cancel;
    okBtn.classList.toggle('danger-button', danger);
    return new Promise(resolve => {
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        const accepted = dialog.returnValue === 'ok';
        if (reopenSession && session && !session.open) {
          try { session.showModal(); } catch (err) {
            console.error('[pace01] reopen-session-after-confirm', err);
          }
          if (!accepted) showCloseStep(2);
        }
        resolve(accepted);
      };
      dialog.addEventListener('close', onClose);
      try {
        if (!dialog.open) dialog.showModal();
      } catch (err) {
        console.error('[pace01] confirm-dialog', err);
        dialog.removeEventListener('close', onClose);
        if (reopenSession && session && !session.open) {
          try { session.showModal(); } catch { /* */ }
          showCloseStep(2);
        }
        resolve(false);
      }
    });
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function setupDates() {
    const now = new Date();
    $('#todayLabel').textContent = now.toLocaleDateString('es-PY', {
      weekday: 'short', day: 'numeric', month: 'short'
    }).replace('.', '');
    const raceDate = plan?.raceDate || plan?.goal?.raceDate || null;
    const days = raceDate ? Coach().calendarDaysUntil(raceDate, now) : null;
    const raceLabel = $('#raceDateLabel');
    const eyebrow = $('#raceCornerEyebrow');
    const sub = $('#raceCornerSub');
    if (!raceDate) {
      if (eyebrow) eyebrow.textContent = 'Plan';
      if (raceLabel) raceLabel.textContent = (plan?.goal?.label || 'Sin fecha').split(' ')[0] || 'PACE';
      if (sub) sub.innerHTML = plan?.onboardingCompleted ? 'activo' : 'nuevo';
      if ($('#daysToRace')) $('#daysToRace').textContent = '—';
      return;
    }
    if (eyebrow) eyebrow.textContent = 'Objetivo';
    if ($('#daysToRace')) $('#daysToRace').textContent = days == null ? '—' : String(Math.max(0, days));
    if (sub) sub.innerHTML = `<b id="daysToRace">${days == null ? '—' : Math.max(0, days)}</b> días`;
    if (raceLabel) raceLabel.textContent = formatShortDate(raceDate).toUpperCase();
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') {
      if (running) syncTimer();
      if ($('#keepAwake').getAttribute('aria-pressed') === 'true') requestWakeLock();
    }
  }

  function initEvents() {
    $$('[data-nav]').forEach(el => el.addEventListener('click', () => navTo(el.dataset.nav)));

    $('#startWorkoutHome').addEventListener('click', async () => {
      const focus = Coach().getFocusSession(plan);
      if (focus?.kind !== 'run') {
        showToast('Hoy no hay intervalos para iniciar.');
        return;
      }
      await ensureAudio();
      warmSpeech();
      if (!hasStarted) resetTimer({ quiet: true });
      if (settings.lastEnvironment) setSessionEnvironment(settings.lastEnvironment);
      navTo('train');
    });
    $('#previewWorkout').addEventListener('click', () => {
      if (!hasStarted) resetTimer({ quiet: true });
      $('#blockList').hidden = false;
      navTo('train');
    });
    $$('[data-env]').forEach(btn => {
      btn.addEventListener('click', () => setSessionEnvironment(btn.dataset.env));
    });
    $('#beginWorkout').addEventListener('click', async () => {
      if (!sessionEnvironment) {
        showToast('Elegí cinta o aire libre antes de comenzar');
        return;
      }
      await ensureAudio();
      warmSpeech();
      startTimer({ announceFirst: true });
    });
    $('#historyList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-log-id]');
      if (item) openHistoryDetail(item.dataset.logId);
    });
    $('#adaptDone')?.addEventListener('click', () => {
      $('#adaptDialog')?.close();
      navTo('home');
      renderHome();
    });
    $('#startOnboardingHome')?.addEventListener('click', () => openOnboarding());
    $('#onboardingDialog')?.addEventListener('cancel', (e) => {
      if (Coach().needsOnboarding(plan)) e.preventDefault();
    });
    $('#onboardNext')?.addEventListener('click', () => {
      if (onboardStep === 1 && !selectedValue('onboardGoal')) {
        showToast('Elegí un objetivo');
        return;
      }
      if (onboardStep === 2 && !selectedValue('onboardAbility')) {
        showToast('Indicá tu nivel actual');
        return;
      }
      if (onboardStep === 3 && !selectedValue('onboardDays')) {
        showToast('Elegí días por semana');
        return;
      }
      showOnboardStep(Math.min(4, onboardStep + 1));
    });
    $('#onboardBack')?.addEventListener('click', () => {
      showOnboardStep(Math.max(1, onboardStep - 1));
    });
    $('#onboardFinish')?.addEventListener('click', finishOnboarding);
    ['onboardGoal', 'onboardAbility', 'onboardDays', 'onboardEnv', 'onboardPain'].forEach(name => {
      $$(`input[name="${name}"]`).forEach(el => {
        el.addEventListener('change', () => {
          if (name === 'onboardPain') {
            const wrap = $('#onboardPainNoteWrap');
            if (wrap) wrap.hidden = selectedValue('onboardPain') !== 'yes';
          }
          if (onboardStep === 4) updateOnboardingPreview();
        });
      });
    });
    $('#onboardRunSpeed')?.addEventListener('input', () => {
      if (onboardStep === 4) updateOnboardingPreview();
    });
    $('#recalibrateEasier')?.addEventListener('click', () => applyRecalibration('easier'));
    $('#recalibrateHarder')?.addEventListener('click', () => applyRecalibration('harder'));
    $('#redoOnboarding')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: '¿Rehacer el onboarding?',
        body: 'Se borra el plan y el historial de este dispositivo. Exportá antes si querés conservarlos.',
        ok: 'Empezar de nuevo',
        cancel: 'Cancelar',
        danger: true
      });
      if (!ok) return;
      const out = Coach().resetToOnboarding();
      plan = out.plan;
      logs = out.logs;
      reloadWorkoutFromPlan();
      setupDates();
      renderSettings();
      renderHistory();
      renderHome();
      openOnboarding();
    });
    $('#loadDemoData')?.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: '¿Cargar datos de demo?',
        body: 'Reemplaza tu plan e historial actuales por un ejemplo de la semana 2.',
        ok: 'Cargar demo',
        cancel: 'Cancelar',
        danger: true
      });
      if (!ok) return;
      const out = Coach().loadDemoData(settings);
      plan = out.plan;
      logs = out.logs;
      reloadWorkoutFromPlan();
      setupDates();
      renderSettings();
      renderHistory();
      renderHome();
      showToast('Demo cargada');
      navTo('home');
    });
    $('#goalDetailToggle').addEventListener('click', () => {
      const detail = $('#evidenceNeed');
      detail.hidden = !detail.hidden;
    });
    $('#markRestPlan').addEventListener('click', () => {
      const focus = Coach().getFocusSession(plan);
      if (!focus || focus.kind !== 'rest') return;
      const result = Coach().markRestComplete(plan, logs, focus.id, localDateISO());
      plan = result.plan;
      logs = result.logs;
      Coach().savePlan(plan);
      Coach().saveLogs(logs);
      audit('rest-plan', { id: focus.id });
      showToast(result.message);
      reloadWorkoutFromPlan();
      renderHistory();
      renderHome();
    });
    $('#markRestVoluntary').addEventListener('click', async () => {
      const todayIso = localDateISO();
      if (Coach().hasTrainingOnDate(logs, todayIso)) {
        showToast('Hoy ya registraste un entrenamiento. No marca recuperación el mismo día.');
        renderHome();
        return;
      }
      const ok = await askConfirm({
        title: '¿Registrar día de recuperación?',
        body: 'Usalo solo si hoy no vas a entrenar.\nLa sesión de intervalos sigue pendiente: el plan no avanza.',
        ok: 'Registrar recuperación',
        cancel: 'Volver'
      });
      if (!ok) return;
      const result = Coach().registerVoluntaryRecovery(plan, logs, todayIso);
      plan = result.plan;
      logs = result.logs;
      if (!result.blocked && result.log) Coach().saveLogs(logs);
      showToast(result.message);
      renderHistory();
      renderHome();
    });
    $('#flagSevere').addEventListener('change', () => {
      $('#severeHint').hidden = !$('#flagSevere').checked;
    });
    $('#rescheduleSession').addEventListener('click', () => {
      const focus = Coach().getFocusSession(plan);
      const underlying = Coach().getUnderlyingPlanItem(plan, focus);
      $('#rescheduleDate').value = underlying?.scheduledDate || localDateISO();
      if (!$('#rescheduleDialog').open) $('#rescheduleDialog').showModal();
    });
    $('#rescheduleForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const date = $('#rescheduleDate').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        showToast('Fecha inválida');
        return;
      }
      const focus = Coach().getFocusSession(plan);
      const underlying = Coach().getUnderlyingPlanItem(plan, focus);
      const fromIso = underlying?.scheduledDate || localDateISO();
      const result = Coach().rescheduleFocus(plan, date);
      plan = result.plan;
      Coach().savePlan(plan);
      $('#rescheduleDialog').close();
      renderHome();
      const fromLabel = formatFriendlyDate(result.previousDate || fromIso);
      const toLabel = formatFriendlyDate(result.scheduledDate || date);
      await askConfirm({
        title: 'Entrenamiento reprogramado',
        body: `${fromLabel} → ${toLabel}\nEs la misma sesión: solo cambia la fecha, no la dificultad.`,
        ok: 'Entendido',
        cancel: null
      });
    });
    $('#skipSession').addEventListener('click', async () => {
      const ok = await askConfirm({
        title: '¿Omitir esta sesión?',
        body: 'No se registrará como completada.\nEl plan continuará con la siguiente sesión programada.',
        ok: 'Omitir sesión',
        cancel: 'Volver',
        danger: true
      });
      if (!ok) return;
      const result = Coach().skipFocus(plan);
      plan = result.plan;
      Coach().savePlan(plan);
      audit('skip', { message: result.message });
      showToast(result.message);
      reloadWorkoutFromPlan();
      renderHome();
    });
    $('#confirmDistanceBtn').addEventListener('click', () => {
      $('#sessionDistanceEstimated').checked = false;
      syncDistanceEstimateUi();
      if ($('#finishDistance') && $('#sessionDistance').value) {
        $('#finishDistance').textContent = formatKm(Number($('#sessionDistance').value));
      }
      renderSessionMetricsPreview();
      showToast('Distancia marcada como confirmada');
    });
    $('#sessionDistance').addEventListener('input', () => {
      // Editar no confirma sola: hay que pulsar confirmar (evita “confirmar” sin querer).
      renderSessionMetricsPreview();
    });
    const sessionTimeEl = $('#sessionTime');
    if (sessionTimeEl) {
      sessionTimeEl.addEventListener('input', () => {
        const el = sessionTimeEl;
        const start = el.selectionStart;
        const before = el.value;
        const masked = maskTimeDigits(before);
        if (masked !== before) {
          el.value = masked;
          // Cursor al final tras reformatear (móvil / teclado numérico).
          const pos = masked.length;
          try { el.setSelectionRange(pos, pos); } catch { /* */ }
        } else if (start != null) {
          try { el.setSelectionRange(start, start); } catch { /* */ }
        }
        renderSessionMetricsPreview();
      });
      sessionTimeEl.addEventListener('blur', () => {
        sessionTimeEl.value = normalizeTimeField(sessionTimeEl.value);
        renderSessionMetricsPreview();
      });
      sessionTimeEl.addEventListener('paste', (ev) => {
        ev.preventDefault();
        const text = (ev.clipboardData || window.clipboardData)?.getData('text') || '';
        sessionTimeEl.value = normalizeTimeField(text);
        renderSessionMetricsPreview();
      });
    }

    $('#mainTimerButton').addEventListener('click', () => startTimer());
    $('#nextBlockButton').addEventListener('click', nextBlock);
    $('#prevBlock').addEventListener('click', prevBlock);
    $('#plusThirty').addEventListener('click', addThirty);
    $('#minusThirty').addEventListener('click', subtractThirty);
    $('#moreToggle').addEventListener('click', () => {
      const panel = $('#morePanel');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      $('#moreToggle').setAttribute('aria-expanded', String(willOpen));
      if (willOpen) $('#blockList').hidden = false;
    });
    $('#resetTimer').addEventListener('click', async () => {
      if (hasStarted || getLiveElapsedMs() > 0) {
        const ok = await askConfirm({
          title: '¿Reiniciar entrenamiento?',
          body: 'Vas a perder el progreso del cronómetro.',
          ok: 'Reiniciar',
          cancel: 'Volver',
          danger: true
        });
        if (!ok) return;
      }
      resetTimer();
    });
    $('#prepSound').addEventListener('click', () => $('#toggleAudio').click());
    $('#prepVoice').addEventListener('click', () => $('#toggleVoice').click());
    $('#prepWake').addEventListener('click', () => $('#keepAwake').click());
    $('#testAlerts').addEventListener('click', testAlerts);
    $('#closeNext').addEventListener('click', () => {
      const step = Number($('#sessionDialog').dataset.step || '1');
      if (!validateCloseStep(step)) return;
      if (step === 1) {
        $('#sessionPrescriptionCompleted').checked = selectedValue('prescriptionDone') === 'yes';
        showCloseStep(2);
      }
    });
    $('#closeBack').addEventListener('click', () => {
      const step = Number($('#sessionDialog').dataset.step || '1');
      showCloseStep(Math.max(1, step - 1));
    });
    $('#restoreHistory').addEventListener('click', () => $('#restoreFile').click());
    $('#exportSyncPack')?.addEventListener('click', exportSyncPack);
    $('#enableRemindersBtn')?.addEventListener('click', async () => {
      if (!window.PaceProduct) return;
      const out = await window.PaceProduct.enableReminders(account || window.PaceProduct.loadAccount());
      account = window.PaceProduct.loadAccount();
      if ($('#remindersToggle')) $('#remindersToggle').checked = account.remindersEnabled;
      showToast(out.message);
    });
    $('#guideDismiss')?.addEventListener('click', () => {
      const id = $('#guideCard')?.dataset?.tipId;
      if (id && window.PaceProduct) window.PaceProduct.markTipSeen(id);
      renderGuideCard();
    });
    $('#showLegalBtn')?.addEventListener('click', () => openLegalDialog({ force: true }));
    $('#legalAcceptBtn')?.addEventListener('click', () => {
      if (!$('#legalPrivacyCheck')?.checked || !$('#legalMedicalCheck')?.checked) {
        showToast('Marcá ambas casillas para continuar');
        return;
      }
      account = window.PaceProduct.acceptLegal();
      $('#legalDialog')?.close();
      window.PaceProduct.track('legal_accepted');
      if (Coach().needsOnboarding(plan)) openOnboarding();
    });
    $('#editLogForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('#editLogId').value;
      const time = normalizeTimeField($('#editLogTime').value);
      const distanceKm = parseOptionalNumber($('#editLogDistance').value);
      const rpe = parseOptionalNumber($('#editLogRpe').value);
      const notes = $('#editLogNotes').value.trim();
      const elapsedSec = time ? timeToSec(time) : null;
      const existing = logs.find(l => l.id === id);
      let paceMetrics = existing?.paceMetrics || null;
      if (elapsedSec && distanceKm && window.PaceAdaptive) {
        const structure = existing?.planSessionId
          ? structureForSessionId(existing.planSessionId)
          : null;
        paceMetrics = window.PaceAdaptive.computeSessionPaceMetrics({
          elapsedSec,
          distanceKm,
          structure,
          speeds: settings
        });
      }
      const out = Coach().updateStoredLog(logs, id, {
        time: time || null,
        elapsedSec,
        distanceKm,
        rpe,
        notes,
        paceMetrics
      });
      if (!out.ok) {
        showToast('No se pudo editar');
        return;
      }
      logs = out.logs;
      $('#editLogDialog')?.close();
      renderHistory();
      window.PaceProduct?.track?.('log_edited');
      showToast('Sesión corregida');
    });
    $('#restoreFile').addEventListener('change', () => {
      const file = $('#restoreFile').files?.[0];
      $('#restoreFile').value = '';
      restoreSessions(file);
    });
    $('#keepAwake').addEventListener('click', toggleWakeLock);
    $('#toggleAudio').addEventListener('click', async () => {
      settings.sound = !settings.sound;
      persistSettings();
      syncToggleButtons();
      if (settings.sound) {
        const ok = await beep(700, 120);
        if (!ok) showToast('No se pudo activar el audio. Tocá de nuevo.');
      }
    });
    $('#toggleVoice').addEventListener('click', () => {
      settings.voice = !settings.voice;
      persistSettings();
      syncToggleButtons();
      if (settings.voice) speak('Voz activada');
    });
    $('#editSpeeds').addEventListener('click', openSpeedDialog);
    $('#speedForm').addEventListener('submit', saveSessionSpeeds);
    $('#addSession').addEventListener('click', openManualLog);
    $('#logPlanSession')?.addEventListener('click', openPlanSessionLog);
    $('#finishAndSave')?.addEventListener('click', finishAndSaveNow);
    $('#sessionForm').addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveSessionFromForm(e);
    });
    $('#saveSession').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveSessionFromForm(e);
    });
    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#exportHistory').addEventListener('click', exportSessions);
    $('#painYes').addEventListener('change', togglePainDetails);
    $('#painNo').addEventListener('change', togglePainDetails);
    $$('[data-close-dialog]').forEach(button => {
      button.addEventListener('click', () => button.closest('dialog')?.close());
    });
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstallPrompt = e;
      $('#installButton').hidden = false;
    });
    $('#installButton').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      $('#installButton').hidden = true;
    });
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register(
        new URL('sw.js', window.location.href),
        { scope: './', updateViaCache: 'none' }
      );
      reg.update().catch(() => {});
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    } catch { /* */ }
  }

  function init() {
    if (!window.PaceCoach) {
      console.error('PaceCoach no cargó');
      return;
    }
    if (window.PaceProduct) account = window.PaceProduct.loadAccount();
    plan = Coach().loadPlan();
    logs = Coach().loadLogs();
    const cleanup = Coach().purgeInvalidSameDayRecoveries(logs);
    if (cleanup.removed.length) {
      logs = cleanup.logs;
      Coach().saveLogs(logs);
      console.info('[pace01] purged-same-day-recovery', {
        removed: cleanup.removed.map(l => ({ id: l.id, date: l.date }))
      });
      setTimeout(() => {
        showToast(
          cleanup.removed.length === 1
            ? 'Quitamos una recuperación marcada el mismo día que entrenaste.'
            : `Quitamos ${cleanup.removed.length} recuperaciones duplicadas del mismo día del entrenamiento.`
        );
      }, 600);
    }
    workout = buildWorkout();
    remainingMs = (workout[0]?.seconds || 60) * 1000;
    originalBlockMs = remainingMs;
    setupDates();
    renderSettings();
    renderWorkout();
    renderHistory();
    renderHome();
    updateTimerUI();
    initEvents();
    registerServiceWorker();
    window.PaceProduct?.track?.('app_open');
    window.PaceProduct?.maybeNotifyTodaySession?.(plan, account);
    const initial = location.hash.replace('#', '');
    if (['home', 'train', 'history', 'settings'].includes(initial)) navTo(initial);
    setTimeout(() => {
      if (window.PaceProduct?.needsLegalAcceptance?.(account)) {
        openLegalDialog({ force: true });
        return;
      }
      if (Coach().needsOnboarding(plan)) openOnboarding();
    }, 200);
  }

  init();
})();

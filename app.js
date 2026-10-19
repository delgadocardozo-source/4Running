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

  function localDateISO(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

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
      blocks.push({ type: 'walk', label: 'Caminar', seconds: st.walkSeconds, rep: i, cue: 'Caminar' });
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
    const km = (settings.walkSpeed * st.warmSeconds
      + settings.coolSpeed * st.coolSeconds
      + (settings.runSpeed * st.runSeconds + settings.walkSpeed * st.walkSeconds) * st.reps) / 3600;
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
    $('#sessionTime').value = formatTime(elapsedMs / 1000);
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
    const titles = { 1: 'Resultado', 2: 'Molestia', 3: 'Guardar' };
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
    $('#closeNext').hidden = step === 3;
    $('#saveSession').hidden = step !== 3;
    $('#sessionDialog').dataset.step = String(step);
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
    if (step === 2 && $('#painYes').checked && !$('#sessionPainLocation').value.trim()) {
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
    showToast('Sesión completada. Tres preguntas y listo.');
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
    const codes = entry?.reasonCode || [];
    const rpe = entry?.rpe;
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
        title: 'El plan quedó en pausa',
        summary: 'Sesión de recuperación registrada. Esta sesión no avanzó ni completó el entrenamiento pendiente.',
        chips: ['Recuperación']
      };
    }
    if (progression === 'recovery' || codes.includes('SAFETY_OVERRIDE') || codes.includes('PAIN_MODERATE')) {
      return {
        cls: 'recovery',
        title: 'Recuperación',
        summary: 'Priorizamos recuperar antes de subir la carga. El plan principal no avanzó.',
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
    if (progression === 'advance') {
      return {
        cls: 'advance',
        title: 'Próximo paso: avanzar',
        summary: 'Completaste la sesión con una intensidad adecuada y sin señales que indiquen mantener la carga.',
        chips: rpe != null ? [`Esfuerzo ${rpe}/10`] : []
      };
    }
    if (progression === 'repeat') {
      const high = Number(rpe) >= 7 || codes.includes('RPE_GE_7');
      const incomplete = codes.includes('PRESCRIPTION_INCOMPLETE');
      const lowConf = codes.includes('LOW_CONFIDENCE');
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
        title: 'Próximo paso: repetir sesión',
        summary,
        chips
      };
    }
    return { cls: '', title: '', summary: '', chips: [] };
  }

  function trendUserCopy(trend) {
    const tone = trend?.tone || 'estable';
    if (tone === 'favorable') {
      return {
        tone,
        title: 'Buena progresión',
        detail: 'Tus sesiones recientes muestran buena tolerancia al entrenamiento.'
      };
    }
    if (tone === 'precaucion') {
      return {
        tone,
        title: 'Precaución',
        detail: 'Tus últimas sesiones muestran una carga mayor de la esperada.'
      };
    }
    const valid = Coach().validTrainingAttempts(logs, plan);
    if (valid.length < 2) {
      return {
        tone: 'estable',
        title: 'Construyendo tendencia',
        detail: 'Necesitamos más entrenamientos para evaluar tu evolución con mayor confianza.'
      };
    }
    return {
      tone: 'estable',
      title: 'Estable',
      detail: 'Tus sesiones recientes se mantienen en un rango similar.'
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
      reasonCode: log?.reasonCode || []
    };
    const copy = decisionUserCopy({ ...log, progression: decision.progression, reasonCode: decision.reasonCode || log?.reasonCode });
    const next = result?.next || Coach().getFocusSession(plan);
    let nextLine = '';
    if (next?.kind === 'run' && next.structure) {
      const st = next.structure;
      nextLine = `Intervalos · ${formatMinutesLabel(st.runSeconds)} correr / ${formatMinutesLabel(st.walkSeconds)} caminar · ${st.reps} repeticiones`;
    } else if (next?.kind === 'rest') {
      nextLine = 'Recuperación en el plan';
    } else {
      nextLine = 'Sin sesión pendiente';
    }
    let headline = copy.title;
    let body = copy.summary;
    if (decision.progression === 'advance') {
      headline = 'Vamos a avanzar';
      body = 'Completaste el entrenamiento con buena tolerancia. El próximo entrenamiento aumentará ligeramente la carga.';
    } else if (decision.progression === 'repeat') {
      headline = Number(log?.rpe) >= 7 ? 'Mantendremos este nivel' : copy.title.replace(/^Próximo paso:\s*/i, '') || 'Mantendremos este nivel';
      if (Number(log?.rpe) >= 7) {
        body = 'El esfuerzo fue mayor al esperado. Por ahora no aumentaremos la carga.';
      }
    } else if (decision.progression === 'recovery') {
      headline = 'Recuperación';
      body = 'El plan principal no avanzó. Priorizamos recuperar antes de volver a la misma sesión.';
    }
    return { headline, body, nextLine, cls: copy.cls, chips: copy.chips };
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
    const yes = $('#painYes').checked;
    $('#painDetails').hidden = !yes;
    $('#sessionPainLocation').required = yes;
  }

  function sortedLogs() {
    return [...logs].sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
  }

  function historyKind(entry) {
    if (entry.source === 'external') return 'Actividad externa';
    if (entry.type === 'Recuperación' || entry.source === 'rest') return 'Recuperación';
    return 'Intervalos';
  }

  function renderHistory() {
    const sorted = sortedLogs();
    $('#historyCount').textContent = sorted.length;
    const bestDist = sorted.filter(s => typeof s.distanceKm === 'number' && s.source !== 'external').reduce((m, s) => Math.max(m, s.distanceKm), 0);
    $('#bestDistance').innerHTML = bestDist ? `${bestDist.toFixed(2).replace('.', ',')} <em>km</em>` : '—';
    const bestCont = sorted.filter(s => s.source !== 'external').reduce((m, s) => Math.max(m, Number(s.maxRunBlockSec) || 0), 0);
    $('#bestContinuous').textContent = bestCont ? Coach().formatBlock(bestCont) : '—';

    const trend = trendUserCopy(Coach().summarizeTrend(logs, plan));
    $('#historyTrend').innerHTML = `
      <div class="trend-block">
        <span class="metric-label">Tu tendencia</span>
        <strong class="metric-status ${trend.tone}">${escapeHtml(trend.title)}</strong>
        <p class="trend-detail">${escapeHtml(trend.detail)}</p>
        <p class="trend-hint">La tendencia mira varias sesiones. Cada entrenamiento también tiene su propia decisión.</p>
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
      ['Lugar', environmentLabel(env)],
      ['Máx. continuo', s.maxRunBlockSec != null ? Coach().formatBlock(s.maxRunBlockSec) : '—'],
      ['Esfuerzo', s.rpe != null ? `${s.rpe}/10` : '—'],
      ['Completado', s.prescriptionCompleted === false || s.execution === 'aborted' ? 'Incompleto' : (s.execution === 'skipped' ? 'Omitido' : 'Sí')],
      ['Molestia', s.pain ? `${s.painLocation || 'Sí'}${s.painIntensity != null ? ` · ${s.painIntensity}/5` : ''}` : 'No'],
      ['Decisión', decision.title || '—'],
      ['Motivo', decision.summary || '—']
    ];
    $('#historyDetailTitle').textContent = historyKind(s);
    $('#historyDetailBody').innerHTML = rows.map(([k, v]) => `
      <div class="detail-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(String(v))}</strong></div>
    `).join('');
    if (!$('#historyDetailDialog').open) $('#historyDetailDialog').showModal();
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

  function renderHome() {
    const readiness = Coach().assessRaceReadiness(logs, plan);
    const focus = Coach().getFocusSession(plan);
    const underlying = Coach().getUnderlyingPlanItem(plan, focus);
    const isRest = focus?.kind === 'rest';
    const isRun = focus?.kind === 'run';

    const sessionMatch = String(focus?.title || '').match(/sesi[oó]n\s*(\d+)/i);
    $('#coachEyebrow').textContent = sessionMatch ? `Hoy · Sesión ${sessionMatch[1]}` : 'Hoy';
    $('#todayRun').hidden = !isRun;
    $('#todayRest').hidden = !isRest;
    $('#todayDone').hidden = Boolean(focus);
    const todayIso = localDateISO();
    const trainedToday = Coach().hasTrainingOnDate(logs, todayIso);
    const recoveredToday = Coach().hasRecoveryOnDate(logs, todayIso);
    // Recuperación voluntaria solo si hay intervalos pendientes y hoy no entrenaste ni marcaste recuperación.
    $('#recoveryOffer').hidden = !(isRun && !trainedToday && !recoveredToday);
    $('#quietActions').hidden = !focus;
    $('#rescheduleSession').hidden = !focus;
    $('#skipSession').hidden = !focus;

    const scheduleNote = $('#scheduleNote');
    if (isRun && underlying?.status === 'rescheduled' && underlying.scheduledDate) {
      scheduleNote.hidden = false;
      scheduleNote.textContent = `Reprogramada para ${formatFriendlyDate(underlying.scheduledDate) || underlying.scheduledDate}. Es la misma sesión.`;
    } else {
      scheduleNote.hidden = true;
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
      $('#coachTitle').textContent = 'Intervalos';
      $('#homeMinutes').textContent = String(minutes);
      $('#homeKm').textContent = km.toFixed(2).replace('.', ',');
      const cue = (sec) => formatTime(sec).replace(/^0/, '');
      $('#homeWarmDur').textContent = formatMinutesLabel(st.warmSeconds);
      $('#homeWarmLine').textContent = 'Calentamiento';
      $('#homeWarmSpeed').textContent = speedLabel(settings.walkSpeed);
      $('#homeReps').textContent = `${st.reps}×`;
      $('#homeWorkLine').textContent = `Correr ${cue(st.runSeconds)}`;
      $('#homeWalkLine').textContent = `Caminar ${cue(st.walkSeconds)}`;
      $('#homeRunSpeed').textContent = speedLabel(settings.runSpeed);
      $('#homeWalkSpeed').textContent = speedLabel(settings.walkSpeed);
      $('#homeCoolDur').textContent = formatMinutesLabel(st.coolSeconds);
      $('#homeCoolLine').textContent = 'Enfriamiento';
      $('#homeCoolSpeed').textContent = speedLabel(settings.coolSpeed);
    }

    const adaptNote = $('#homeAdaptNote');
    if (adaptNote) {
      const ctx = lastFocusDecision();
      if (isRun && ctx?.attempt) {
        const copy = decisionUserCopy({ ...(ctx.log || {}), progression: ctx.attempt.progression, reasonCode: ctx.attempt.reasonCode, rpe: ctx.attempt.rpe });
        if (ctx.attempt.progression === 'repeat') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Mantenemos esta sesión</strong><em>${escapeHtml(Number(ctx.attempt.rpe) >= 7 ? 'La anterior resultó muy exigente.' : copy.summary)}</em>`;
        } else if (ctx.attempt.progression === 'recovery') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Seguís en la misma sesión</strong><em>La recuperación no avanzó el plan.</em>`;
        } else if (ctx.attempt.progression === 'advance' && lastSaveResult?.progression === 'advance') {
          adaptNote.hidden = false;
          adaptNote.innerHTML = `<span>Próximo entrenamiento</span><strong>Avanzamos</strong><em>Completaste bien la sesión anterior.</em>`;
        } else {
          adaptNote.hidden = true;
          adaptNote.innerHTML = '';
        }
      } else {
        adaptNote.hidden = true;
        adaptNote.innerHTML = '';
      }
    }

    $('#readinessBadge').textContent = readiness.label;
    $('#readinessBadge').className = `sr-only distance-badge level-${readiness.level}`;
    $('#readinessTarget').textContent = `foco ${readiness.focusTarget}`;
    $('#readinessConfidence').textContent = readiness.confidenceLabel;
    $('#readinessConfidence').className = `distance-badge conf conf-${readiness.confidence}`;
    $('#readinessHeadline').textContent = `Objetivo · ${readiness.focusTarget}`;
    $('#readinessSummary').textContent = 'Decidimos por evidencia, no por entusiasmo.';
    $('#evidenceNeed').textContent = evidenceCopy(readiness);
    const fill = readiness.level === 'listo' ? 100 : readiness.level === 'cerca' ? 58 : 22;
    $('#readinessBar')?.style.setProperty('--fill', `${fill}%`);
    $('#checkpointLabel').textContent = formatShortDate(plan.checkpointDate);
    const checkpointDays = readiness.daysToCheckpoint;
    $('#checkpointCountdown').textContent = checkpointDays == null
      ? ''
      : checkpointDays > 0
        ? `${checkpointDays} días`
        : checkpointDays === 0
          ? 'hoy'
          : 'checkpoint pasado · revisar evidencia';

    renderSequence();
  }

  function parseOptionalNumber(value) {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function saveSessionFromForm(e) {
    e.preventDefault();
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
      showCloseStep(3);
      return;
    }

    const external = $('#sessionExternal').value === '1';
    const fromTimer = $('#sessionFromTimer').value === '1';
    const date = $('#sessionDate').value || localDateISO();
    const id = `${date}-${Date.now()}`;
    const prescriptionCompleted = done === 'yes';
    const typeValue = $('#sessionType').value;
    const environment = typeValue === 'Cinta' ? 'treadmill'
      : typeValue === 'Exterior' ? 'outdoor'
      : (sessionEnvironment || settings.lastEnvironment || null);
    const log = {
      id,
      date,
      type: typeValue,
      environment,
      planSessionId: external ? null : ($('#sessionPlanId').value || activePlanSessionId || null),
      time: $('#sessionTime').value.trim() || null,
      distanceKm: parseOptionalNumber($('#sessionDistance').value),
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
      source: external ? 'external' : (fromTimer ? 'timer' : 'manual')
    };

    logs.push(log);
    let result = null;

    if (log.planSessionId && !external) {
      result = Coach().confirmNextSession(plan, log, logs);
      plan = result.plan;
      lastSaveResult = result;
      Coach().savePlan(plan);
      Coach().saveLogs(logs);
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

    $('#sessionDialog').close();
    $('#sessionForm').reset();
    $('#sessionFromTimer').value = '0';
    togglePainDetails();
    reloadWorkoutFromPlan();
    renderHistory();
    renderHome();
    if (result && !external) showAdaptationResult(result, log);
    else {
      showToast(external ? 'Actividad externa guardada. El plan no se movió.' : 'Registro guardado');
      navTo('home');
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
    $('#adaptPlace').textContent = `Realizado en: ${environmentLabel(log.environment)}`;
    const action = $('#adaptAction');
    action.className = `adapt-action ${adapt.cls}`;
    action.innerHTML = `<strong>${escapeHtml(adapt.headline)}</strong><p>${escapeHtml(adapt.body)}</p>`;
    $('#adaptNext').textContent = adapt.nextLine;
    $('#adaptHint').textContent = result.progression === 'advance'
      ? 'Queremos ver cómo responde tu cuerpo con el siguiente estímulo.'
      : result.progression === 'repeat'
        ? 'Queremos ver cómo responde tu cuerpo antes de aumentar.'
        : 'Cuando estés listo, volvés a la misma sesión del plan.';
    if (!dialog.open) dialog.showModal();
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

  function renderSettings() {
    $('#walkSpeed').value = settings.walkSpeed;
    $('#runSpeed').value = settings.runSpeed;
    $('#coolSpeed').value = settings.coolSpeed;
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
      sound: $('#soundToggle').checked
    };
    persistSettings();
    refreshWorkoutSpeeds();
    renderSettings();
    renderHome();
    showToast('Ajustes guardados');
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

  function exportSessions() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      plan,
      logs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pace01-export-${localDateISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Copia exportada');
    audit('export', { logs: logs.length });
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
    if (!data || !Array.isArray(data.logs) || !Array.isArray(data.plan?.sessions)) {
      showToast('Ese archivo no tiene plan e historial de PACE/01');
      return;
    }
    const ok = await askConfirm({
      title: '¿Restaurar estos datos?',
      body: 'Reemplazan el plan y el historial de este dispositivo.',
      ok: 'Restaurar',
      cancel: 'Volver',
      danger: true
    });
    if (!ok) return;
    try {
      if (data.settings && typeof data.settings === 'object') {
        settings = { ...defaultSettings, ...data.settings };
        persistSettings();
      }
      Coach().savePlan(data.plan);
      Coach().saveLogs(data.logs);
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
    } catch (error) {
      console.error('[pace01] restore-apply', error);
      showToast('No se pudieron aplicar los datos');
    }
  }

  function askConfirm({ title, body, ok = 'Confirmar', cancel = 'Volver', danger = false }) {
    const dialog = $('#confirmDialog');
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
        resolve(dialog.returnValue === 'ok');
      };
      dialog.addEventListener('close', onClose);
      if (!dialog.open) dialog.showModal();
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
    const days = Coach().calendarDaysUntil(plan.raceDate, now);
    $('#daysToRace').textContent = days == null ? '—' : String(Math.max(0, days));
    const raceLabel = $('#raceDateLabel');
    if (raceLabel) raceLabel.textContent = formatShortDate(plan.raceDate).toUpperCase();
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
        body: `${fromLabel} → ${toLabel}\nEs la misma sesión. Tu progreso no avanzó.`,
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
      showToast('Distancia marcada como confirmada');
    });
    $('#sessionDistance').addEventListener('input', () => {
      // Editar no confirma sola: hay que pulsar confirmar (evita “confirmar” sin querer).
    });

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
        if ($('#painYes').checked) {
          $('#painDetails').hidden = false;
          showCloseStep(2);
        } else {
          showCloseStep(3);
        }
        return;
      }
      showCloseStep(3);
    });
    $('#closeBack').addEventListener('click', () => {
      const step = Number($('#sessionDialog').dataset.step || '1');
      if (step === 3 && !$('#painYes').checked) showCloseStep(1);
      else showCloseStep(Math.max(1, step - 1));
    });
    $('#restoreHistory').addEventListener('click', () => $('#restoreFile').click());
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
    $('#sessionForm').addEventListener('submit', saveSessionFromForm);
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
    remainingMs = workout[0].seconds * 1000;
    originalBlockMs = remainingMs;
    setupDates();
    renderSettings();
    renderWorkout();
    renderHistory();
    renderHome();
    updateTimerUI();
    initEvents();
    registerServiceWorker();
    const initial = location.hash.replace('#', '');
    if (['home', 'train', 'history', 'settings'].includes(initial)) navTo(initial);
  }

  init();
})();

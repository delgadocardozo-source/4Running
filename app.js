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
    sound: true
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
  let countdownBeepsFired = new Set();
  let finishedAnnounced = false;
  let hasStarted = false;
  let maxCompletedRunBlockSec = 0;
  let currentRunCompletedSec = 0;

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

  function applyBlock(index, announce = false) {
    armBlock(index);
    updateTimerUI();
    if (announce) cueBlock(workout[currentBlockIndex]);
  }

  function updateTimerUI() {
    const block = workout[currentBlockIndex];
    if (!block) return;

    const remainingSec = getLiveRemainingMs() / 1000;
    const elapsedSec = getLiveElapsedMs() / 1000;

    $('#timerPhase').textContent = block.label.toUpperCase();
    $('#timerValue').textContent = formatTime(remainingSec);
    $('#timerSpeed').textContent = speedLabel(block.speed);
    $('#phasePill').textContent = running ? block.label.toUpperCase() : (hasStarted ? 'Pausa' : 'Listo');
    $('#blockCounter').textContent = `${currentBlockIndex + 1} / ${workout.length}`;
    $('#mainTimerButton').textContent = running ? 'Pausa' : 'Continuar';
    $('#totalElapsed').textContent = formatTime(elapsedSec);
    $('#totalRemaining').textContent = formatTime(getRemainingPlanSeconds());
    $('#estimatedDistance').textContent = getEstimatedDistance();

    const within = originalBlockMs ? (1 - getLiveRemainingMs() / originalBlockMs) : 0;
    const sessionFrac = workout.length ? (currentBlockIndex + Math.max(0, Math.min(1, within))) / workout.length : 0;
    $('#timerRing').style.setProperty('--progress', String(sessionFrac));
    $('#view-train').dataset.phase = block.type;

    const next = workout[currentBlockIndex + 1];
    const cueTime = (sec) => formatTime(sec).replace(/^0/, '');
    $('#nextBlock').innerHTML = next
      ? `<span>Siguiente</span><strong>${escapeHtml(next.label.toUpperCase())} · ${cueTime(prescribedSeconds(next))}</strong><em>${escapeHtml(speedLabel(next.speed))}</em>`
      : `<span>Siguiente</span><strong>Sesión completa</strong>`;

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

    const live = $('#timerLive');
    if (live) {
      live.textContent = `${running ? 'En curso' : 'Pausado'}: ${block.label}, ${formatTime(remainingSec)} restantes`;
    }

    $$('.block-row').forEach((el, i) => el.classList.toggle('is-current', i === currentBlockIndex));
  }

  function startTimer({ announceFirst = false } = {}) {
    if (running) return pauseTimer();
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
    requestWakeLock();
    const now = performance.now();
    runStartedAt = now;
    blockDeadline = now + remainingMs;
    updateTimerUI();
    if (announceFirst || freshStart) cueBlock(workout[currentBlockIndex]);
    clearInterval(timerId);
    timerId = setInterval(syncTimer, 200);
    syncTimer();
  }

  function pauseTimer() {
    if (running) {
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

  function fireCountdownBeeps(remainingSecFloor) {
    if (!settings.countdown) return;
    for (let s = 5; s >= 1; s--) {
      if (remainingSecFloor <= s && remainingSecFloor > 0 && !countdownBeepsFired.has(s)) {
        countdownBeepsFired.add(s);
        beep(s === 1 ? 840 : 620, 70);
      }
    }
  }

  function syncTimer() {
    if (!running) return;
    const remMs = getLiveRemainingMs();
    fireCountdownBeeps(Math.ceil(remMs / 1000));
    if (remMs <= 0) advanceExpiredBlocks();
    updateTimerUI();
  }

  function advanceExpiredBlocks() {
    let guard = 0;
    while (getLiveRemainingMs() <= 0 && guard < workout.length + 2) {
      guard += 1;
      noteRunProgressOnLeave();
      if (currentBlockIndex >= workout.length - 1) {
        finishWorkout();
        return;
      }
      armBlock(currentBlockIndex + 1);
      if (running) blockDeadline = performance.now() + remainingMs;
      cueBlock(workout[currentBlockIndex]);
    }
  }

  async function nextBlock() {
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
    armBlock(currentBlockIndex + 1);
    if (wasRunning) blockDeadline = performance.now() + remainingMs;
    cueBlock(workout[currentBlockIndex]);
    updateTimerUI();
  }

  async function prevBlock() {
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
    if (wasRunning) blockDeadline = performance.now() + remainingMs;
    updateTimerUI();
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
    $('#sessionType').value = fromTimer ? 'Cinta' : 'Exterior';
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
    pauseTimer();
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

  function ensureAudio() {
    if (!audioContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioContext = new AC();
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  }

  function beep(freq = 700, duration = 90) {
    if (!settings.sound) return;
    ensureAudio();
    if (!audioContext) return;
    try {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration / 1000);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      osc.stop(audioContext.currentTime + duration / 1000 + 0.02);
    } catch { /* audio */ }
  }

  function speak(text) {
    if (!settings.voice || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      u.rate = 1.02;
      speechSynthesis.speak(u);
    } catch { /* speech */ }
  }

  function cueBlock(block) {
    const tones = { warm: 520, run: 900, walk: 620, cool: 470 };
    beep(tones[block.type] || 700, 150);
    speak(`${block.cue}. ${formatSpokenDuration(block.seconds)}. Velocidad ${String(block.speed).replace('.', ',')} kilómetros por hora.`);
  }

  function formatSpokenDuration(seconds) {
    const wholeMinutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    if (wholeMinutes === 0) return `${rem} segundos`;
    if (rem === 0) return wholeMinutes === 1 ? 'un minuto' : `${wholeMinutes} minutos`;
    return `${wholeMinutes === 1 ? 'un minuto' : `${wholeMinutes} minutos`} ${rem} segundos`;
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

  function testAlerts() {
    try {
      ensureAudio();
      if (!settings.sound && !settings.voice) {
        showToast('Activá sonido o voz para probar.');
        return;
      }
      if (settings.sound) beep(880, 140);
      if (settings.voice) speak('Alertas listas.');
      showToast('Si no escuchaste nada, revisá el silencio del teléfono.');
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

  function historyDecision(entry) {
    if (entry.source === 'external') return { text: 'Fuera del plan', cls: '' };
    if (entry.progression === 'advance' && entry.type !== 'Recuperación') return { text: 'Avanza', cls: 'advance' };
    if (entry.progression === 'repeat') return { text: 'Repetir', cls: 'repeat' };
    if (entry.progression === 'recovery') return { text: 'Recuperación', cls: 'recovery' };
    if (entry.execution === 'skipped') return { text: 'Omitido', cls: 'skip' };
    if (entry.voluntary || entry.type === 'Recuperación' || entry.source === 'rest') {
      return { text: 'Recuperación', cls: 'recovery' };
    }
    return { text: '', cls: '' };
  }

  function renderHistory() {
    const sorted = sortedLogs();
    $('#historyCount').textContent = sorted.length;
    const bestDist = sorted.filter(s => typeof s.distanceKm === 'number' && s.source !== 'external').reduce((m, s) => Math.max(m, s.distanceKm), 0);
    $('#bestDistance').innerHTML = bestDist ? `${bestDist.toFixed(2).replace('.', ',')} <em>km</em>` : '—';
    const bestCont = sorted.filter(s => s.source !== 'external').reduce((m, s) => Math.max(m, Number(s.maxRunBlockSec) || 0), 0);
    $('#bestContinuous').textContent = bestCont ? Coach().formatBlock(bestCont) : '—';

    const trend = Coach().summarizeTrend(logs, plan);
    $('#historyTrend').innerHTML = `<span class="metric-label">Tendencia</span><strong class="metric-status ${trend.tone}">${escapeHtml(trend.headline)}</strong>`;

    $('#historyList').innerHTML = sorted.map(s => {
      const date = new Date(`${s.date}T12:00:00`);
      const day = String(date.getDate()).padStart(2, '0');
      const month = date.toLocaleDateString('es-PY', { month: 'short' }).replace('.', '').toUpperCase();
      const kind = historyKind(s);
      const bits = [];
      if (s.time) bits.push(s.time);
      if (typeof s.distanceKm === 'number') bits.push(`${s.distanceKm.toFixed(2).replace('.', ',')} km`);
      if (s.rpe != null) bits.push(`RPE ${s.rpe}`);
      const cont = s.maxRunBlockSec != null && kind === 'Intervalos' ? `Continuo ${Coach().formatBlock(s.maxRunBlockSec).replace(/^0/, '')}` : '';
      const note = kind === 'Recuperación'
        ? (s.notes || (s.pain ? `${s.painLocation || 'Molestia'}${s.painIntensity ? ` ${s.painIntensity}/5` : ''}` : ''))
        : (s.pain ? `${s.painLocation || 'Molestia'}${s.painIntensity ? ` ${s.painIntensity}/5` : ''}` : '');
      const decision = historyDecision(s);
      return `
        <article class="history-item">
          <div class="history-kicker"><strong>${day} ${month} ${date.getFullYear()}</strong></div>
          <div class="history-kind">${escapeHtml(kind)}</div>
          ${bits.length ? `<p class="history-facts">${escapeHtml(bits.join(' · '))}</p>` : ''}
          ${cont ? `<p class="history-facts">${escapeHtml(cont)}</p>` : ''}
          ${note ? `<p class="history-facts">${escapeHtml(note)}</p>` : ''}
          ${decision.text ? `<p class="history-decision ${decision.cls}">${escapeHtml(decision.text)}</p>` : ''}
        </article>
      `;
    }).join('');
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
    $('#recoveryOffer').hidden = !isRun;
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

    $('#readinessBadge').textContent = readiness.label;
    $('#readinessBadge').className = `distance-badge level-${readiness.level}`;
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
    const log = {
      id,
      date,
      type: $('#sessionType').value,
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

    if (log.planSessionId && !external) {
      const result = Coach().confirmNextSession(plan, log, logs);
      plan = result.plan;
      Coach().savePlan(plan);
      Coach().saveLogs(logs);
      showToast(result.message || 'Intento guardado');
      if (result.medicalNotice || result.decision?.medicalNotice) {
        setTimeout(() => {
          showToast('Suspendé entrenamiento y considerá evaluación profesional. PACE/01 no diagnostica.');
        }, 3400);
      }
    } else {
      Coach().saveLogs(logs);
      showToast(external ? 'Actividad externa guardada. El plan no se movió.' : 'Registro guardado (sin mover el plan)');
      audit('log-unlinked', { source: log.source, id: log.id });
    }

    $('#sessionDialog').close();
    $('#sessionForm').reset();
    $('#sessionFromTimer').value = '0';
    togglePainDetails();
    reloadWorkoutFromPlan();
    renderHistory();
    renderHome();
    navTo('home');
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

    $('#startWorkoutHome').addEventListener('click', () => {
      const focus = Coach().getFocusSession(plan);
      if (focus?.kind !== 'run') {
        showToast('Hoy no hay intervalos para iniciar.');
        return;
      }
      if (!hasStarted) resetTimer({ quiet: true });
      navTo('train');
    });
    $('#previewWorkout').addEventListener('click', () => {
      if (!hasStarted) resetTimer({ quiet: true });
      $('#blockList').hidden = false;
      navTo('train');
    });
    $('#beginWorkout').addEventListener('click', () => startTimer({ announceFirst: true }));
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
      const ok = await askConfirm({
        title: '¿Registrar día de recuperación?',
        body: 'Conserva el historial de este intento. La sesión de intervalos sigue pendiente: el plan no avanza.',
        ok: 'Registrar recuperación',
        cancel: 'Volver'
      });
      if (!ok) return;
      const result = Coach().registerVoluntaryRecovery(plan, logs, localDateISO());
      plan = result.plan;
      logs = result.logs;
      Coach().saveLogs(logs);
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
    $('#toggleAudio').addEventListener('click', () => {
      settings.sound = !settings.sound;
      persistSettings();
      syncToggleButtons();
      if (settings.sound) beep(700, 80);
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
      await navigator.serviceWorker.register(new URL('sw.js', window.location.href), { scope: './' });
    } catch { /* */ }
  }

  function init() {
    if (!window.PaceCoach) {
      console.error('PaceCoach no cargó');
      return;
    }
    plan = Coach().loadPlan();
    logs = Coach().loadLogs();
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

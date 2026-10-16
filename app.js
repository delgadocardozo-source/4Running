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
    return blocks.map(block => ({ ...block, speed: speedForType(block.type) }));
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
    const km = workout.reduce((sum, b, i) => {
      const seconds = i === currentBlockIndex ? originalBlockMs / 1000 : b.seconds;
      return sum + (b.speed * seconds / 3600);
    }, 0);
    return `${km.toFixed(2).replace('.', ',')} km`;
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
    const focus = activeRunSession();
    const st = focusStructure();
    $('#trainEyebrow').textContent = focus ? focus.title.toUpperCase() : 'ENTRENAMIENTO';
    $('#trainTitle').textContent = Coach().describeStructure(st);
    const totalMin = Math.round((st.warmSeconds + st.coolSeconds + (st.runSeconds + st.walkSeconds) * st.reps) / 60);
    $('#trainMeta').textContent = `${totalMin} min · ${st.reps} intervalos · cinta o exterior`;
  }

  function applyBlock(index, announce = false) {
    currentBlockIndex = Math.min(Math.max(index, 0), workout.length - 1);
    const block = workout[currentBlockIndex];
    remainingMs = block.seconds * 1000;
    originalBlockMs = remainingMs;
    countdownBeepsFired.clear();
    finishedAnnounced = false;
    if (running) blockDeadline = performance.now() + remainingMs;
    else blockDeadline = null;
    updateTimerUI();
    if (announce) cueBlock(block);
  }

  function updateTimerUI() {
    const block = workout[currentBlockIndex];
    if (!block) return;

    const remainingSec = getLiveRemainingMs() / 1000;
    const elapsedSec = getLiveElapsedMs() / 1000;

    $('#timerPhase').textContent = block.label.toUpperCase();
    $('#timerValue').textContent = formatTime(remainingSec);
    $('#timerSpeed').textContent = speedLabel(block.speed);
    $('#phasePill').textContent = running ? block.label.toUpperCase() : (hasStarted ? 'PAUSADO' : 'PREPARADO');
    $('#phasePill').style.background = `var(--${block.type})`;
    $('#blockCounter').textContent = `Bloque ${currentBlockIndex + 1} de ${workout.length}`;
    $('#mainTimerButton').textContent = running ? 'PAUSAR' : (hasStarted ? 'CONTINUAR' : 'INICIAR');
    $('#totalElapsed').textContent = formatTime(elapsedSec);
    $('#totalRemaining').textContent = formatTime(getRemainingPlanSeconds());
    $('#estimatedDistance').textContent = getEstimatedDistance();

    const progress = originalBlockMs ? (1 - getLiveRemainingMs() / originalBlockMs) * 360 : 0;
    $('#timerRing').style.setProperty('--progress', `${Math.max(0, Math.min(360, progress))}deg`);

    const next = workout[currentBlockIndex + 1];
    $('#nextBlock').innerHTML = next
      ? `<span>Después</span><strong>${next.label.toUpperCase()} · ${formatTime(next.seconds)}</strong><span>${speedLabel(next.speed)}</span>`
      : `<span>Después</span><strong>SESIÓN COMPLETA</strong><span>✓</span>`;

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
      currentBlockIndex += 1;
      const next = workout[currentBlockIndex];
      remainingMs = next.seconds * 1000;
      originalBlockMs = remainingMs;
      countdownBeepsFired.clear();
      if (running) blockDeadline = performance.now() + remainingMs;
      cueBlock(next);
    }
  }

  function nextBlock() {
    if (currentBlockIndex >= workout.length - 1) return finishWorkout();
    noteRunProgressOnLeave();
    const wasRunning = running;
    if (wasRunning) {
      elapsedMs = getLiveElapsedMs();
      runStartedAt = performance.now();
    }
    currentBlockIndex += 1;
    remainingMs = workout[currentBlockIndex].seconds * 1000;
    originalBlockMs = remainingMs;
    countdownBeepsFired.clear();
    if (wasRunning) blockDeadline = performance.now() + remainingMs;
    cueBlock(workout[currentBlockIndex]);
    updateTimerUI();
  }

  function prevBlock() {
    noteRunProgressOnLeave();
    const wasRunning = running;
    if (wasRunning) {
      elapsedMs = getLiveElapsedMs();
      runStartedAt = performance.now();
    }
    currentBlockIndex = Math.max(0, currentBlockIndex - 1);
    remainingMs = workout[currentBlockIndex].seconds * 1000;
    originalBlockMs = remainingMs;
    countdownBeepsFired.clear();
    if (wasRunning) blockDeadline = performance.now() + remainingMs;
    updateTimerUI();
  }

  function addThirty() {
    remainingMs = getLiveRemainingMs() + 30000;
    originalBlockMs += 30000;
    if (running) blockDeadline = performance.now() + remainingMs;
    showToast('+30 segundos en este bloque');
    updateTimerUI();
  }

  function openCloseDialogFromTimer() {
    const distance = getCompletedDistanceKm();
    const maxSec = Math.max(maxCompletedRunBlockSec, currentRunCompletedSec);
    $('#sessionFromTimer').value = '1';
    const run = activeRunSession();
    $('#sessionPlanId').value = activePlanSessionId || run?.id || '';
    $('#sessionDate').value = localDateISO();
    $('#sessionType').value = 'Cinta';
    $('#sessionTime').value = formatTime(elapsedMs / 1000);
    $('#sessionDistance').value = distance ? distance.toFixed(2) : '';
    $('#sessionDistanceEstimated').checked = true;
    syncDistanceEstimateUi();
    $('#sessionMaxRunBlockSec').value = String(Math.round(maxSec));
    $('#sessionMaxRunBlockLabel').textContent = maxSec ? Coach().formatBlock(maxSec) : '—';
    $('#sessionNotes').value = '';
    clearChoice('sessionRpe');
    $('#painNo').checked = true;
    $('#painYes').checked = false;
    togglePainDetails();
    clearChoice('couldContinue');
    $('#sessionPainLocation').value = '';
    $('#sessionPainIntensity').value = '';
    $('#flagWorsening').checked = false;
    $('#flagAlteredGait').checked = false;
    $('#flagForcedStop').checked = false;
    $('#flagSevere').checked = false;
    $('#severeHint').hidden = true;
    $('#sessionPrescriptionCompleted').checked = true;
    // Subjetivo aparte: no altera maxRunBlockSec objetivo.
    if (!$('#sessionDialog').open) $('#sessionDialog').showModal();
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
    showToast('Sesión completada. Cierre corto: RPE y molestia.');
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
      showToast('Pantalla activa durante la sesión');
    } catch {
      button.setAttribute('aria-pressed', 'false');
      showToast('No se pudo activar el bloqueo de pantalla');
    }
  }

  function syncToggleButtons() {
    $('#toggleVoice').setAttribute('aria-pressed', String(settings.voice));
    $('#toggleAudio').setAttribute('aria-pressed', String(settings.sound));
    $('#countdownToggle').checked = settings.countdown;
    $('#voiceToggle').checked = settings.voice;
    $('#soundToggle').checked = settings.sound;
  }

  function navTo(view) {
    $$('.view').forEach(v => v.classList.toggle('is-active', v.dataset.view === view));
    $$('.nav-item').forEach(n => n.classList.toggle('is-active', n.dataset.nav === view));
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

  function renderHistory() {
    const sorted = sortedLogs();
    $('#historyCount').textContent = sorted.length;
    const bestDist = sorted.filter(s => typeof s.distanceKm === 'number').reduce((m, s) => Math.max(m, s.distanceKm), 0);
    $('#bestDistance').innerHTML = bestDist ? `${bestDist.toFixed(2).replace('.', ',')} <em>km</em>` : '—';
    const bestCont = sorted.reduce((m, s) => Math.max(m, Number(s.maxRunBlockSec) || 0), 0);
    $('#bestContinuous').textContent = bestCont ? Coach().formatBlock(bestCont) : '—';

    const recentPain = sorted.find(s => s.pain);
    const trendEl = $('#historyTrend');
    trendEl.innerHTML = recentPain
      ? `<span class="metric-label">Tendencia</span><strong class="metric-status warn">Con molestia</strong><small>${escapeHtml(recentPain.painLocation || 'registrada')}</small>`
      : `<span class="metric-label">Tendencia</span><strong class="metric-status">Estable</strong><small>sin dolor persistente</small>`;

    $('#historyList').innerHTML = sorted.map(s => {
      const date = new Date(`${s.date}T12:00:00`);
      const day = date.getDate();
      const month = date.toLocaleDateString('es-PY', { month: 'short' }).replace('.', '').toUpperCase();
      const distance = typeof s.distanceKm === 'number'
        ? `${s.distanceKm.toFixed(2).replace('.', ',')} km${s.distanceEstimated ? ' · estimada' : ''}`
        : (s.type === 'Recuperación' ? 'Recup.' : '—');
      const cont = s.maxRunBlockSec != null ? Coach().formatBlock(s.maxRunBlockSec) : null;
      const tags = [
        s.type,
        s.execution ? `ejec. ${s.execution}` : null,
        s.progression ? `prog. ${s.progression}` : null,
        cont ? `cont. ${cont}` : null,
        s.rpe != null ? `RPE ${s.rpe}/10` : null,
        s.pain ? 'Molestia' : (s.type === 'Recuperación' ? null : 'Sin dolor'),
        s.couldContinue === '2-5' ? 'Podía +2–5' : s.couldContinue === '5plus' ? 'Podía +5' : null
      ].filter(Boolean);
      return `
        <article class="history-item card">
          <div class="history-date"><strong>${day}</strong><span>${month}</span></div>
          <div class="history-main">
            <h3>${escapeHtml(s.type)} · ${escapeHtml(s.time || (s.type === 'Recuperación' ? 'descanso' : 'sin tiempo'))}</h3>
            <p>${escapeHtml(s.notes || 'Sin notas.')}</p>
            <div class="history-tags">${tags.map(t => `<span class="history-tag">${escapeHtml(t)}</span>`).join('')}</div>
          </div>
          <div class="history-stat"><strong>${distance}</strong><span>${s.pain ? escapeHtml(s.painLocation || 'molestia') : 'registro'}</span></div>
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
    const coaching = Coach().buildDayCoaching(focus, settings, readiness);

    $('#coachEyebrow').textContent = coaching.eyebrow;
    $('#coachTitle').textContent = coaching.title;
    $('#coachSubtitle').textContent = coaching.mode === 'rest'
      ? 'Sesión válida de recuperación'
      : (coaching.prescription || new Date().toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long' }));
    $('#coachBody').textContent = coaching.body;
    $('#coachChip').textContent = coaching.mode === 'rest' ? 'DESCANSAR' : coaching.mode === 'done' ? 'OK' : 'LISTO';

    const isRest = coaching.mode === 'rest';
    const isRun = coaching.mode === 'run';
    $('#homePrescription').hidden = !isRun;
    $('#homeRestPanel').hidden = !isRest;
    $('#startWorkoutHome').hidden = !isRun;
    $('#previewWorkout').hidden = !isRun;
    $('#markRestDone').hidden = !isRest;
    $('#skipSession').hidden = coaching.mode === 'done';
    $('#rescheduleSession').hidden = coaching.mode === 'done' || Boolean(focus?.gateForId);

    const scheduleNote = $('#scheduleNote');
    if (underlying?.status === 'rescheduled' && underlying.scheduledDate) {
      scheduleNote.hidden = false;
      scheduleNote.textContent = `Reprogramada para ${underlying.scheduledDate} (mismo ítem del plan).`;
    } else {
      scheduleNote.hidden = true;
    }

    if (isRest) {
      $('#homeRestNote').textContent = focus.structure.note || 'Recuperación del plan.';
    }

    if (isRun && focus) {
      const st = focus.structure;
      $('#homeWarmTime').textContent = Coach().formatBlock(st.warmSeconds);
      $('#homeRunTime').textContent = Coach().formatBlock(st.runSeconds);
      $('#homeWalkTime').textContent = Coach().formatBlock(st.walkSeconds);
      $('#homeCoolTime').textContent = Coach().formatBlock(st.coolSeconds);
      $('#homeReps').textContent = `× ${st.reps}`;
      const walk = speedLabel(settings.walkSpeed);
      $('#homeWalkSpeed').textContent = walk;
      $('#homeWalkSpeedRepeat').textContent = walk;
      $('#homeRunSpeed').textContent = speedLabel(settings.runSpeed);
      $('#homeCoolSpeed').textContent = speedLabel(settings.coolSpeed);
    }

    $('#readinessBadge').textContent = readiness.label;
    $('#readinessBadge').className = `distance-badge level-${readiness.level}`;
    $('#readinessTarget').textContent = `foco ${readiness.focusTarget}`;
    $('#readinessConfidence').textContent = readiness.confidenceLabel;
    $('#readinessConfidence').className = `distance-badge conf conf-${readiness.confidence}`;
    $('#readinessHeadline').textContent = readiness.focusTarget === '5K' ? 'Camino a 5K' : 'Camino a 2K';
    $('#readinessSummary').textContent = readiness.fiveKDefinition
      || readiness.reasons[0]
      || 'Decidimos por evidencia.';
    $('#readinessReasons').innerHTML = readiness.reasons.slice(0, 4).map(r => `<li>${escapeHtml(r)}</li>`).join('');
    const cp = new Date(`${plan.checkpointDate}T12:00:00`);
    $('#checkpointLabel').textContent = cp.toLocaleDateString('es-PY', { day: 'numeric', month: 'short' });
    $('#checkpointCountdown').textContent = readiness.daysToCheckpoint >= 0
      ? `${readiness.daysToCheckpoint} días`
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
      return;
    }
    const pain = painVal === 'yes';
    if (pain && !$('#sessionPainLocation').value.trim()) {
      showToast('Indicá la ubicación de la molestia');
      return;
    }

    const fromTimer = $('#sessionFromTimer').value === '1';
    const date = $('#sessionDate').value || localDateISO();
    const id = `${date}-${Date.now()}`;
    const log = {
      id,
      date,
      type: $('#sessionType').value,
      planSessionId: $('#sessionPlanId').value || activePlanSessionId || null,
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
      prescriptionCompleted: $('#sessionPrescriptionCompleted').checked,
      execution: $('#sessionPrescriptionCompleted').checked ? 'completed' : 'aborted',
      progression: null,
      notes: $('#sessionNotes').value.trim(),
      source: fromTimer ? 'timer' : 'manual'
    };

    logs.push(log);

    if (log.planSessionId) {
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
      showToast('Registro guardado (sin mover el plan)');
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
    $('#sessionForm').reset();
    $('#sessionFromTimer').value = '0';
    $('#sessionDate').value = localDateISO();
    $('#sessionType').value = 'Exterior';
    $('#sessionDistanceEstimated').checked = false;
    syncDistanceEstimateUi();
    $('#sessionMaxRunBlockSec').value = '';
    $('#sessionMaxRunBlockLabel').textContent = 'Manual: vacío o segundos del mayor bloque run (no inventar capacidad).';
    $('#sessionPlanId').value = activeRunSession()?.id || '';
    $('#sessionPrescriptionCompleted').checked = true;
    $('#painNo').checked = true;
    togglePainDetails();
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
    if (![walk, run, cool].every(Number.isFinite)) {
      showToast('Revisá las velocidades');
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
    if (![walk, run, cool].every(Number.isFinite)) {
      showToast('Revisá las velocidades');
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
    showToast('Exportado plan + historial');
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
    const race = new Date(`${plan.raceDate}T08:00:00-03:00`);
    $('#daysToRace').textContent = Math.max(0, Math.ceil((race - now) / 86400000));
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
      if (focus?.kind === 'rest') {
        showToast('Hoy toca recuperación. Registrate o omití/mové la sesión.');
        return;
      }
      if (!hasStarted) resetTimer({ quiet: true });
      navTo('train');
      if (!running) startTimer({ announceFirst: !hasStarted });
    });
    $('#previewWorkout').addEventListener('click', () => {
      if (!hasStarted) resetTimer({ quiet: true });
      navTo('train');
    });
    $('#markRestDone').addEventListener('click', () => {
      const focus = Coach().getFocusSession(plan);
      if (!focus || focus.kind !== 'rest') return;
      const result = Coach().markRestComplete(plan, logs, focus.id, localDateISO());
      plan = result.plan;
      logs = result.logs;
      Coach().savePlan(plan);
      Coach().saveLogs(logs);
      showToast(result.message);
      reloadWorkoutFromPlan();
      renderHistory();
      renderHome();
    });
    $('#flagSevere').addEventListener('change', () => {
      $('#severeHint').hidden = !$('#flagSevere').checked;
    });
    $('#rescheduleSession').addEventListener('click', () => {
      const date = prompt('Nueva fecha para la misma sesión (YYYY-MM-DD)', localDateISO());
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (date != null) showToast('Fecha inválida');
        return;
      }
      const result = Coach().rescheduleFocus(plan, date);
      plan = result.plan;
      Coach().savePlan(plan);
      showToast(result.message);
      renderHome();
    });
    $('#skipSession').addEventListener('click', () => {
      if (!confirm('¿Omitir esta sesión y pasar a la siguiente del plan?')) return;
      const result = Coach().skipFocus(plan);
      plan = result.plan;
      Coach().savePlan(plan);
      showToast(result.message);
      reloadWorkoutFromPlan();
      renderHome();
    });
    $('#confirmDistanceBtn').addEventListener('click', () => {
      $('#sessionDistanceEstimated').checked = false;
      syncDistanceEstimateUi();
      showToast('Distancia marcada como confirmada');
    });
    $('#sessionDistance').addEventListener('input', () => {
      // Editar no confirma sola: hay que pulsar confirmar (evita “confirmar” sin querer).
    });

    $('#mainTimerButton').addEventListener('click', () => startTimer());
    $('#nextBlockButton').addEventListener('click', nextBlock);
    $('#prevBlock').addEventListener('click', prevBlock);
    $('#plusThirty').addEventListener('click', addThirty);
    $('#resetTimer').addEventListener('click', () => {
      if (getLiveElapsedMs() > 0 && !confirm('¿Reiniciar el entrenamiento en curso?')) return;
      resetTimer();
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

/**
 * PACE/01 Product layer — cuenta local, analytics, recordatorios, hitos, copy humano.
 * Sin backend: sync = paquete JSON entre dispositivos.
 */
(() => {
  const ACCOUNT_KEY = 'pace01.account.v1';
  const ANALYTICS_KEY = 'pace01.analytics.v1';
  const TIPS_KEY = 'pace01.tips.v1';
  const SYNC_VERSION = 1;
  const MAX_EVENTS = 200;

  const defaultAccount = () => ({
    id: `local-${Date.now().toString(36)}`,
    displayName: '',
    createdAt: new Date().toISOString(),
    privacyAcceptedAt: null,
    medicalDisclaimerAcceptedAt: null,
    preferredSurface: 'both', // outdoor | treadmill | both
    remindersEnabled: false,
    reminderHour: 8,
    lastBackupAt: null,
    lastReminderPromptAt: null,
    guidedSessionIndex: 0, // 0..3 tips for first sessions
    cloudSyncNote: 'local-only'
  });

  function clone(v) {
    return structuredClone ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }

  function loadAccount() {
    try {
      const raw = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
      if (raw && typeof raw === 'object') return { ...defaultAccount(), ...raw };
    } catch { /* */ }
    const acc = defaultAccount();
    saveAccount(acc);
    return acc;
  }

  function saveAccount(account) {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    return account;
  }

  function acceptLegal({ privacy = true, medical = true } = {}) {
    const acc = loadAccount();
    const now = new Date().toISOString();
    if (privacy) acc.privacyAcceptedAt = now;
    if (medical) acc.medicalDisclaimerAcceptedAt = now;
    return saveAccount(acc);
  }

  function needsLegalAcceptance(account = loadAccount()) {
    return !account.privacyAcceptedAt || !account.medicalDisclaimerAcceptedAt;
  }

  function track(event, detail = {}) {
    let list = [];
    try {
      list = JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '[]');
      if (!Array.isArray(list)) list = [];
    } catch { list = []; }
    list.unshift({
      event,
      at: new Date().toISOString(),
      detail: detail && typeof detail === 'object' ? detail : {}
    });
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(list.slice(0, MAX_EVENTS)));
  }

  function loadAnalytics() {
    try {
      return JSON.parse(localStorage.getItem(ANALYTICS_KEY) || '[]') || [];
    } catch {
      return [];
    }
  }

  function buildSyncPack({ settings, plan, logs, account }) {
    return {
      format: 'pace01.sync.v1',
      version: SYNC_VERSION,
      exportedAt: new Date().toISOString(),
      account: account || loadAccount(),
      settings: settings || {},
      plan: plan || null,
      logs: Array.isArray(logs) ? logs : [],
      analytics: loadAnalytics().slice(0, 50)
    };
  }

  function parseSyncPack(raw) {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || (data.format !== 'pace01.sync.v1' && !data.plan && !data.logs)) {
      throw new Error('Formato de sincronización no reconocido');
    }
    return data;
  }

  function applySyncPack(data, { mergeLogs = false } = {}) {
    const pack = parseSyncPack(data);
    if (pack.account) saveAccount({ ...defaultAccount(), ...pack.account, cloudSyncNote: 'local-only' });
    if (pack.settings) {
      localStorage.setItem('pace01.settings.v1', JSON.stringify(pack.settings));
    }
    if (pack.plan) {
      localStorage.setItem('pace01.plan.v3', JSON.stringify(pack.plan));
    }
    if (Array.isArray(pack.logs)) {
      if (mergeLogs) {
        const cur = JSON.parse(localStorage.getItem('pace01.logs.v3') || '[]');
        const byId = new Map([...(cur || []), ...pack.logs].map(l => [l.id, l]));
        localStorage.setItem('pace01.logs.v3', JSON.stringify([...byId.values()]));
      } else {
        localStorage.setItem('pace01.logs.v3', JSON.stringify(pack.logs));
      }
    }
    track('sync_import', { mergeLogs: Boolean(mergeLogs) });
    return pack;
  }

  function loadTips() {
    try {
      return JSON.parse(localStorage.getItem(TIPS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function markTipSeen(id) {
    const tips = loadTips();
    tips[id] = new Date().toISOString();
    localStorage.setItem(TIPS_KEY, JSON.stringify(tips));
  }

  function tipSeen(id) {
    return Boolean(loadTips()[id]);
  }

  const GUIDED_TIPS = [
    {
      id: 'guide-1-start',
      title: 'Paso 1 · Empezar',
      body: 'Tocá «Iniciar entrenamiento», elegí cinta o calle, y comprobá sonido/voz antes de correr.'
    },
    {
      id: 'guide-2-timer',
      title: 'Paso 2 · Durante la sesión',
      body: 'En iPhone dejá la pantalla activa. Si bloqueás el celu, las alertas pueden fallar: es una limitación de PWA.'
    },
    {
      id: 'guide-3-close',
      title: 'Paso 3 · Cerrar y guardar',
      body: 'Al terminar, cargá esfuerzo y tiempo. El ritmo del ciclo (sin calentamiento) nos ayuda a adaptar el plan.'
    }
  ];

  function nextGuidedTip(completedSessions = 0) {
    const idx = Math.min(completedSessions, GUIDED_TIPS.length - 1);
    const tip = GUIDED_TIPS[idx];
    if (!tip || tipSeen(tip.id)) {
      const pending = GUIDED_TIPS.find(t => !tipSeen(t.id));
      return pending || null;
    }
    return tip;
  }

  function humanDecisionCopy(action, { rpe, nextLine } = {}) {
    const map = {
      progress_continuous: {
        headline: 'Vas bien: sumamos continuo',
        body: 'La sesión salió cómoda. La próxima vas a correr un poco más seguido, sin apurar el ritmo.'
      },
      progress_volume: {
        headline: 'Sumamos un poco de volumen',
        body: 'Toleraste bien la carga. Agregamos trabajo total con cuidado, sin saltos bruscos.'
      },
      progress_performance: {
        headline: 'Afinamos rendimiento',
        body: 'Hay base suficiente. El próximo estímulo apunta a calidad, no solo a aguantar más minutos.'
      },
      consolidate: {
        headline: 'Consolidamos este nivel',
        body: 'Todavía no hace falta subir. Repetir bien es progreso: el cuerpo se adapta.'
      },
      repeat: {
        headline: 'Repetimos la misma sesión',
        body: Number(rpe) >= 7
          ? 'Salió exigente. Volvemos a la misma carga antes de pedir más.'
          : 'Preferimos fijar este estímulo antes de avanzar.'
      },
      reduce: {
        headline: 'Bajamos un poco la carga',
        body: 'Es una decisión preventiva. No borramos tu historial: solo suavizamos lo que sigue.'
      },
      recovery: {
        headline: 'Priorizamos recuperación',
        body: 'Hoy el plan protege tu cuerpo. Cuando registres la recuperación, vuelve la sesión de carrera.'
      },
      reassess: {
        headline: 'Recalibramos el punto de partida',
        body: 'Hubo una pausa. Arrancamos un poco más suave para volver con seguridad.'
      }
    };
    const base = map[action] || {
      headline: 'Plan actualizado',
      body: 'Guardamos tu sesión y ajustamos lo que sigue.'
    };
    if (nextLine) {
      return { ...base, nextHint: `Próximo: ${nextLine}` };
    }
    return base;
  }

  function weekCalendar(plan, todayISO) {
    if (!window.PaceAdaptive) return [];
    const A = window.PaceAdaptive;
    const start = todayISO || A.localDateISO();
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const iso = A.addDaysISO(start, i);
      const sessions = (plan?.sessions || []).filter(s =>
        (s.status === 'pending' || s.status === 'rescheduled') && s.scheduledDate === iso
      );
      days.push({
        iso,
        label: iso.slice(8),
        isToday: i === 0,
        items: sessions.map(s => ({
          id: s.id,
          kind: s.kind,
          title: s.kind === 'rest' ? 'Recuperación' : (s.isControlTest ? 'Test de control' : 'Entrenar'),
          structure: s.structure
        }))
      });
    }
    return days;
  }

  function computeMilestones(logs = [], plan = null) {
    const A = window.PaceAdaptive;
    if (!A) return { current: null, next: null, lines: [] };
    const profile = A.deriveProfile(logs, plan, {});
    const cont = Number(profile.demonstratedContinuousSec) || 0;
    const ladder = [
      { sec: 60, label: '1 min continuo' },
      { sec: 5 * 60, label: '5 min continuos' },
      { sec: 10 * 60, label: '10 min continuos' },
      { sec: 15 * 60, label: '15 min continuos' },
      { sec: 20 * 60, label: '20 min continuos' },
      { sec: 30 * 60, label: '30 min continuos' },
      { sec: 45 * 60, label: '45 min continuos' }
    ];
    let current = null;
    let next = ladder[0];
    for (const step of ladder) {
      if (cont >= step.sec) current = step;
      else {
        next = step;
        break;
      }
      next = null;
    }
    const goal = plan?.goal?.label || 'Tu objetivo';
    const lines = [
      current ? `Logrado: ${current.label}` : 'Todavía sin bloque continuo registrado',
      next ? `Próximo hito: ${next.label}` : 'Hitos de continuo completados',
      `Meta del plan: ${goal}`
    ];
    return { current, next, lines, continuousSec: cont };
  }

  function outdoorCopyPreferred(account = loadAccount()) {
    return account.preferredSurface === 'outdoor';
  }

  function speedOrEffortLabel(kmh, { outdoor = false, kind = 'run' } = {}) {
    if (!outdoor) {
      const n = Number(kmh);
      if (!Number.isFinite(n)) return '—';
      return `${String(n).replace('.', ',')} km/h`;
    }
    if (kind === 'warm' || kind === 'cool' || kind === 'walk') return 'Paso fácil';
    return 'Ritmo conversacional';
  }

  async function enableReminders(account = loadAccount()) {
    if (!('Notification' in window)) {
      return { ok: false, message: 'Este navegador no soporta notificaciones.' };
    }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      return { ok: false, message: 'No diste permiso de notificaciones.' };
    }
    account.remindersEnabled = true;
    saveAccount(account);
    track('reminders_enabled');
    return { ok: true, message: 'Recordatorios activados. Te avisamos al abrir la app si hoy toca entrenar.' };
  }

  function maybeNotifyTodaySession(plan, account = loadAccount()) {
    if (!account.remindersEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
      return false;
    }
    if (!window.PaceAdaptive || !window.PaceCoach) return false;
    const today = window.PaceAdaptive.localDateISO();
    const focus = window.PaceCoach.getFocusSession(plan);
    if (!focus || focus.kind !== 'run') return false;
    if (focus.scheduledDate && focus.scheduledDate !== today) return false;
    const key = `reminded:${today}`;
    if (sessionStorage.getItem(key)) return false;
    try {
      // eslint-disable-next-line no-new
      new Notification('PACE/01', {
        body: 'Hoy tenés entrenamiento. Cuando puedas, abrí la app y arrancá.',
        tag: 'pace01-today'
      });
      sessionStorage.setItem(key, '1');
      track('reminder_shown', { date: today });
      return true;
    } catch {
      return false;
    }
  }

  function iosPwaHelp() {
    return [
      'En iPhone: Compartir → «Agregar a pantalla de inicio» para instalar PACE/01.',
      'Durante el entreno dejá la pantalla activa: iOS puede silenciar alertas con la app en segundo plano.',
      'Los datos viven en este dispositivo. Exportá un respaldo desde Ajustes con frecuencia.'
    ];
  }

  window.PaceProduct = {
    ACCOUNT_KEY,
    ANALYTICS_KEY,
    SYNC_VERSION,
    GUIDED_TIPS,
    loadAccount,
    saveAccount,
    acceptLegal,
    needsLegalAcceptance,
    track,
    loadAnalytics,
    buildSyncPack,
    parseSyncPack,
    applySyncPack,
    markTipSeen,
    tipSeen,
    nextGuidedTip,
    humanDecisionCopy,
    weekCalendar,
    computeMilestones,
    outdoorCopyPreferred,
    speedOrEffortLabel,
    enableReminders,
    maybeNotifyTodaySession,
    iosPwaHelp
  };
})();

/* Durable account-scoped operation journal. The shared localStorage cache is never the outbox. */
(() => {
  const keys = { settings: 'pace01.settings.v1', plan: 'pace01.plan.v3', logs: 'pace01.logs.v3', account: 'pace01.account.v1' };
  const rawSet = Storage.prototype.setItem;
  const clone = value => value == null ? value : structuredClone(value);
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const same = (a, b) => canonical(a) === canonical(b);
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const snapshot = () => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, read(key)]));
  const marker = owner => `4running.pending.${owner}`;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const keepsAttempts = (before, after) => (before?.sessions || []).every(session => !(session.attempts || []).length || (after?.sessions || []).some(candidate => candidate.id === session.id && session.attempts.every(attempt => (candidate.attempts || []).some(next => (next.logId || next.id) === (attempt.logId || attempt.id)))));
  let user = null, revision = 0, loading = true, ready = false, view = {}, batch = null, durable = Promise.resolve(), timer, draining = null, lastError = null;
  let sequence = 0, conflictCount = 0, stagedFailures = [], cacheEpoch = 0, offlineIdentity = false;
  const tabId = crypto.randomUUID();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('4running.sync.v2') : null;
  const status = message => {
    const node = document.querySelector('#syncStatus'); if (node) node.textContent = message;
    const resolveButton = document.querySelector('#resolveSync'); if (resolveButton) resolveButton.hidden = conflictCount === 0;
  };
  const announce = () => { if (ready) window.dispatchEvent(new CustomEvent('4running:state-updated')); };
  const broadcast = () => channel?.postMessage({ owner: user?.id, tabId });
  const database = new Promise((resolveDb, reject) => {
    const request = indexedDB.open('4running-account-sync', 1);
    request.onupgradeneeded = () => {
      for (const name of ['outbox', 'conflicts']) { const store = request.result.createObjectStore(name, { keyPath: 'id' }); store.createIndex('owner', 'owner'); }
      request.result.createObjectStore('meta'); request.result.createObjectStore('leases');
    };
    request.onsuccess = () => resolveDb(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir el almacenamiento durable.'));
  });
  // Attach a handler immediately; whenDurable still reports storage failures to the caller.
  database.catch(() => {});
  async function transaction(stores, mode, perform) {
    const db = await database;
    return await new Promise((resolveTransaction, reject) => {
      const tx = db.transaction(stores, mode); let result;
      tx.oncomplete = () => resolveTransaction(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('No se pudo guardar en este dispositivo.'));
      try { result = perform(tx); } catch (error) { tx.abort(); reject(error); }
    });
  }
  async function getRecord(store, key) {
    const db = await database;
    return await new Promise((resolveRecord, reject) => { const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolveRecord(request.result); request.onerror = () => reject(request.error); });
  }
  async function list(store, owner = user?.id) {
    const db = await database;
    return await new Promise((resolveList, reject) => { const request = db.transaction(store).objectStore(store).index('owner').getAll(owner); request.onsuccess = () => resolveList(request.result.sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id))); request.onerror = () => reject(request.error); });
  }
  async function storeRemote(remote, owner = user.id) {
    await transaction(['meta'], 'readwrite', tx => {
      const store = tx.objectStore('meta'); const key = `remote:${owner}`; const request = store.get(key);
      request.onsuccess = () => { if (!request.result || request.result.revision <= remote.revision) store.put(remote, key); };
    });
  }
  async function updateMarker() {
    if (!user) return;
    const count = (await list('outbox')).length;
    if (count) rawSet.call(localStorage, marker(user.id), JSON.stringify({ version: 2, count })); else localStorage.removeItem(marker(user.id));
    conflictCount = (await list('conflicts')).length;
  }
  async function api(path, data, method = 'POST') {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { method, credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(['/api/state', '/api/sync'].includes(path) && user ? { 'X-4Running-Owner': user.id } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.message || result.error || 'No se pudo completar la operación'); error.status = response.status; throw error; }
      return result;
    } finally { clearTimeout(timeout); }
  }
  function mergeLogs(...arrays) {
    const logs = new Map();
    for (const log of arrays.flat()) {
      if (!log || typeof log.id !== 'string') continue;
      const previous = logs.get(log.id);
      const oldStamp = previous?.updatedAt || previous?.editedAt || '';
      const newStamp = log.updatedAt || log.editedAt || '';
      if (!previous || !oldStamp || newStamp >= oldStamp) logs.set(log.id, log);
    }
    return [...logs.values()];
  }
  function apply(data) {
    for (const [name, key] of Object.entries(keys)) {
      if (data?.[name] != null) rawSet.call(localStorage, key, JSON.stringify(data[name])); else localStorage.removeItem(key);
    }
    view = clone(data || {});
  }
  async function refreshCache({ notify = false } = {}) {
    if (!user) return;
    await whenDurable();
    const epoch = cacheEpoch;
    const remote = await getRecord('meta', `remote:${user.id}`);
    const data = clone(remote?.data || { settings: {}, account: {}, plan: null, logs: [] });
    for (const operation of await list('outbox')) {
      if (operation.legacy) {
        data.logs = mergeLogs(data.logs || [], operation.data.logs || []);
        if (!data.plan) data.plan = operation.data.plan;
        continue;
      }
      const changes = operation.changes;
      data.logs = mergeLogs(data.logs || [], changes.logs || []);
      if (own(changes, 'plan') && keepsAttempts(data.plan, changes.plan) && (same(data.plan ?? null, operation.basePlan ?? null) || same(data.plan ?? null, changes.plan))) data.plan = clone(changes.plan);
      if (changes.settings) data.settings = { ...(data.settings || {}), ...changes.settings };
      if (changes.account) data.account = { ...(data.account || {}), ...changes.account };
    }
    // A conflicted plan stays separately durable; its attempts remain in the visible history.
    for (const operation of await list('conflicts')) data.logs = mergeLogs(data.logs || [], operation.legacy ? operation.data.logs || [] : operation.changes.logs || []);
    if (epoch !== cacheEpoch) return refreshCache({ notify });
    apply(data); await updateMarker(); if (notify) announce();
  }
  function fieldChanges(before, after) {
    const patch = {};
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) if (!same(before?.[key], after?.[key])) patch[key] = after?.[key] === undefined ? null : clone(after[key]);
    return patch;
  }
  async function persistOperation(operation) {
    await transaction(['outbox'], 'readwrite', tx => tx.objectStore('outbox').put(operation));
    await updateMarker(); broadcast();
  }
  function submitBatch() {
    if (!batch) return;
    const operation = batch; batch = null;
    durable = durable.then(async () => {
      try { await persistOperation(operation); lastError = null; }
      catch (error) { stagedFailures.push(operation); lastError = error; status('No pudimos confirmar el guardado durable. Conservá la página y reintentá antes de salir.'); }
    });
  }
  function stage(name, value) {
    if (loading || !user || same(view[name], value)) { view[name] = clone(value); return; }
    cacheEpoch += 1;
    if (!batch) {
      batch = { id: crypto.randomUUID(), owner: user.id, createdAt: Date.now(), sequence: ++sequence, basePlan: clone(view.plan ?? null), changes: {} };
      queueMicrotask(submitBatch);
    }
    if (name === 'plan') batch.changes.plan = clone(value);
    else if (name === 'logs') {
      const prior = new Map((view.logs || []).map(log => [log.id, log]));
      const changed = (Array.isArray(value) ? value : []).filter(log => log && !same(prior.get(log.id), log));
      batch.changes.logs = mergeLogs(batch.changes.logs || [], changed);
    } else {
      const patch = fieldChanges(view[name], value);
      batch.changes[name] = { ...(batch.changes[name] || {}), ...patch };
    }
    view[name] = clone(value);
    status('Guardando en este dispositivo…');
    clearTimeout(timer); timer = setTimeout(() => flush().catch(error => status(error.message)), 350);
  }
  Storage.prototype.setItem = function(key, value) {
    // A tab whose account changed must never stage another account's shared cache.
    if (this === localStorage && user && !loading && Object.values(keys).includes(key) && localStorage.getItem('4running.cacheOwner') !== user.id) { location.reload(); throw new Error('Cambió la cuenta activa. Volvé a ingresar antes de guardar.'); }
    rawSet.call(this, key, value);
    if (this === localStorage) {
      const name = Object.keys(keys).find(name => keys[name] === key);
      if (name) { let parsed; try { parsed = JSON.parse(value); } catch { return; } stage(name, parsed); }
    }
  };
  async function whenDurable() {
    submitBatch(); await durable;
    if (stagedFailures.length) {
      const retry = stagedFailures; stagedFailures = [];
      for (const operation of retry) { try { await persistOperation(operation); } catch (error) { stagedFailures.push(operation); lastError = error; } }
    }
    if (stagedFailures.length) throw lastError || new Error('No pudimos guardar de forma durable.');
  }
  async function withSyncLock(owner, perform) {
    if (navigator.locks?.request) return navigator.locks.request(`4running.sync.${owner}`, perform);
    // IndexedDB lease is a fallback for browsers without Web Locks. Requests time out
    // before the lease expires and the lease is renewed while draining.
    const leaseKey = `sync:${owner}`;
    let acquired = false;
    await transaction(['leases'], 'readwrite', tx => {
      const store = tx.objectStore('leases'); const request = store.get(leaseKey);
      request.onsuccess = () => { const lease = request.result; if (!lease || lease.expiresAt < Date.now() || lease.tabId === tabId) { store.put({ tabId, expiresAt: Date.now() + 60000 }, leaseKey); acquired = true; } };
    });
    if (!acquired) return;
    const heartbeat = setInterval(() => transaction(['leases'], 'readwrite', tx => { const store = tx.objectStore('leases'); const request = store.get(leaseKey); request.onsuccess = () => { if (request.result?.tabId === tabId) store.put({ tabId, expiresAt: Date.now() + 60000 }, leaseKey); }; }).catch(() => {}), 10000);
    try { return await perform(); }
    finally { clearInterval(heartbeat); await transaction(['leases'], 'readwrite', tx => { const store = tx.objectStore('leases'); const request = store.get(leaseKey); request.onsuccess = () => { if (request.result?.tabId === tabId) store.delete(leaseKey); }; }); }
  }
  async function deliverLegacyLogs(operation) {
    const logs = operation.data?.logs || [];
    if (!logs.length) return;
    // The derived key is stable across reloads and acknowledgement loss. A legacy
    // snapshot conflict must never discard attempts that the server has not seen.
    const bytes = new TextEncoder().encode(`${operation.owner}/${operation.id}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const result = await api('/api/sync', { mutationId: `legacy-logs-${hash}`, changes: { logs } });
    revision = Math.max(revision, result.revision || 0);
  }
  async function flush() {
    await whenDurable();
    if (!user) return;
    if (draining) return draining;
    const owner = user.id;
    draining = withSyncLock(owner, async () => {
      try {
        const verified = await api('/api/auth/get-session', null, 'GET');
        if (verified?.user?.id !== owner) { const error = new Error('La sesión cambió o venció. Volvé a ingresar; los pendientes siguen asociados a su cuenta.'); error.status = 401; throw error; }
        offlineIdentity = false;
        for (const operation of await list('outbox', owner)) {
          if (!user || user.id !== owner) break;
          let result;
          try {
            result = operation.legacy
              ? await api('/api/state', { revision: operation.revision, mutationId: operation.id, data: operation.data }, 'PUT')
              : await api('/api/sync', { mutationId: operation.id, basePlan: operation.basePlan, changes: operation.changes });
          } catch (error) {
            if (error.status === 409) {
              if (operation.legacy) await deliverLegacyLogs(operation);
              await transaction(['outbox', 'conflicts'], 'readwrite', tx => { tx.objectStore('conflicts').put({ ...operation, reason: error.message }); tx.objectStore('outbox').delete(operation.id); });
              continue;
            }
            throw error;
          }
          revision = Math.max(revision, result.revision || 0);
          await transaction(['outbox', 'conflicts'], 'readwrite', tx => { if (result.planConflict) tx.objectStore('conflicts').put({ ...operation, reason: 'El plan cambió en otro dispositivo; tus intentos sí se guardaron.' }); tx.objectStore('outbox').delete(operation.id); });
        }
        // Re-read after replay, rather than applying an old cached acknowledgement.
        const latest = await api('/api/state', null, 'GET'); revision = latest.revision;
        await storeRemote(latest, owner);
        await refreshCache({ notify: ready });
        status(conflictCount ? 'Tus intentos están guardados. Hay planes divergentes: descargá la copia antes de elegir la versión de tu cuenta.' : (await list('outbox')).length ? 'Cambios locales pendientes de sincronizar' : 'Sincronizado con tu cuenta');
        broadcast();
      } catch (error) {
        await updateMarker();
        status(error.status === 401 ? 'Sesión vencida. Reingresá o guardá los pendientes en este dispositivo y cerrá sesión.' : 'Sin conexión · los cambios están guardados en este dispositivo y se reintentarán.');
      }
    }).finally(() => { draining = null; });
    await draining;
    if (user && (await list('outbox')).length && navigator.onLine) { clearTimeout(timer); timer = setTimeout(() => flush().catch(error => status(error.message)), 5000); }
  }
  async function backupPack() {
    await whenDurable();
    const outbox = await list('outbox'), conflicts = await list('conflicts');
    const pack = { format: 'pace01.sync.v1', version: 1, ...snapshot(), syncOutbox: outbox, syncConflicts: conflicts };
    pack.logs = mergeLogs(pack.logs || [], ...outbox.concat(conflicts).map(operation => operation.legacy ? operation.data.logs || [] : operation.changes.logs || []));
    return pack;
  }
  async function signOut({ keepPending = false } = {}) {
    await whenDurable();
    if (!keepPending) {
      await flush();
      if ((await list('outbox')).length || (await list('conflicts')).length) { document.querySelector('#logoutPendingDialog')?.showModal(); return false; }
    }
    try { await api('/api/auth/sign-out', {}); }
    catch (error) {
      // Even offline, retire this browser's identity locally. A surviving cookie is
      // revoked on the next online boot before any account data becomes visible.
      rawSet.call(localStorage, '4running.logoutRequested', JSON.stringify({ owner: user.id, requestedAt: Date.now() }));
    }
    clearTimeout(timer); loading = true; ready = false;
    for (const key of Object.keys(localStorage)) if (key.startsWith('pace01.')) localStorage.removeItem(key);
    localStorage.removeItem('4running.cacheOwner'); localStorage.removeItem('4running.lastVerifiedUser'); user = null; broadcast(); location.reload(); return true;
  }
  async function boot() {
    const gate = document.querySelector('#authGate'); const authError = document.querySelector('#authError');
    const token = new URLSearchParams(location.search).get('token');
    document.querySelector('#resetFields').hidden = !token; document.querySelector('#authFields').hidden = Boolean(token);
    document.querySelector('#authForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = event.submitter; button.disabled = true; authError.textContent = '';
      try {
        const email = document.querySelector('#authEmail').value.trim(), password = document.querySelector('#authPassword').value;
        if (localStorage.getItem('4running.logoutRequested')) { await api('/api/auth/sign-out', {}); localStorage.removeItem('4running.logoutRequested'); }
        if (button.value === 'reset') { await api('/api/auth/reset-password', { token, newPassword: document.querySelector('#newPassword').value }); location.replace('/'); return; }
        if (button.value === 'recover') {
          const config = await api('/api/config', null, 'GET'); if (!config.passwordRecovery) throw new Error('El envío de correos todavía no está configurado en este entorno.');
          await api('/api/auth/request-password-reset', { email, redirectTo: location.origin + '/' });
          authError.textContent = config.testMail ? 'Solicitud registrada. En este entorno de prueba el enlace se guarda en el buzón local del servidor.' : 'Si existe una cuenta, recibirás un enlace para recuperar el acceso.'; return;
        }
        await api(`/api/auth/${button.value === 'register' ? 'sign-up' : 'sign-in'}/email`, { email, password, ...(button.value === 'register' ? { name: email.split('@')[0] } : {}) }); location.reload();
      } catch (error) { authError.textContent = error.message; } finally { button.disabled = false; }
    });
    try {
      if (localStorage.getItem('4running.logoutRequested')) {
        try { await api('/api/auth/sign-out', {}); localStorage.removeItem('4running.logoutRequested'); }
        catch { gate.hidden = false; authError.textContent = 'Cerraste la cuenta en este dispositivo. Volvé a conectar para iniciar otra sesión.'; return false; }
        gate.hidden = false; return false;
      }
      let session;
      try { session = await api('/api/auth/get-session', null, 'GET'); }
      catch (error) {
        const cachedIdentity = read('4running.lastVerifiedUser');
        const owner = localStorage.getItem('4running.cacheOwner');
        if (error.status || token || !cachedIdentity?.id || owner !== cachedIdentity.id || !await getRecord('meta', `remote:${owner}`)) throw error;
        session = { user: cachedIdentity }; offlineIdentity = true;
      }
      if (token || !session?.user) { gate.hidden = false; return false; }
      user = session.user;
      if (!offlineIdentity) rawSet.call(localStorage, '4running.lastVerifiedUser', JSON.stringify({id:user.id,email:user.email}));
      const oldOwner = localStorage.getItem('4running.cacheOwner');
      if (!oldOwner && (read(keys.logs)?.length || read(keys.plan)?.onboardingCompleted)) rawSet.call(localStorage, '4running.legacy', JSON.stringify(snapshot()));
      if (oldOwner !== user.id) for (const key of Object.keys(localStorage)) if (key.startsWith('pace01.')) localStorage.removeItem(key);
      rawSet.call(localStorage, '4running.cacheOwner', user.id);
      const oldPending = read(marker(user.id));
      if (oldPending?.data) {
        await persistOperation({ id: oldPending.mutationId || crypto.randomUUID(), owner: user.id, createdAt: Date.now(), sequence: 0, legacy: true, revision: oldPending.revision, data: oldPending.data });
      }
      // Replay durable operations FIRST: a lost acknowledgement is not a plan conflict.
      if (!offlineIdentity) {
        await flush();
        const remote = await api('/api/state', null, 'GET'); revision = remote.revision;
        await storeRemote(remote);
      } else revision = (await getRecord('meta', `remote:${user.id}`)).revision;
      await refreshCache();
      document.querySelector('#cloudEmail').textContent = user.email;
      const legacy = read('4running.legacy'); document.querySelector('#importLegacy').hidden = !legacy;
      document.querySelector('#importLegacy').onclick = () => { document.querySelector('#importAccount').textContent = user.email; document.querySelector('#importDialog').showModal(); };
      document.querySelector('#confirmImport').onclick = async () => {
        const old = read('4running.legacy'); if (!old) return;
        const data = snapshot(); loading = false;
        localStorage.setItem(keys.logs, JSON.stringify(mergeLogs(old.logs || [], data.logs || [])));
        if (!data.plan?.onboardingCompleted && old.plan) localStorage.setItem(keys.plan, JSON.stringify(old.plan));
        if (!data.account?.privacyAcceptedAt && old.account) localStorage.setItem(keys.account, JSON.stringify(old.account));
        await whenDurable(); await flush(); location.reload();
      };
      document.querySelector('#logout').onclick = () => signOut().catch(error => status(error.message));
      const keepPendingButton = document.querySelector('#logoutKeepPending'); if (keepPendingButton) keepPendingButton.onclick = () => signOut({ keepPending: true }).catch(error => status(error.message));
      document.querySelector('#retrySync').onclick = () => flush().catch(error => status(error.message));
      document.querySelector('#resolveSync').onclick = () => document.querySelector('#syncConflictDialog').showModal();
      document.querySelector('#downloadPending').onclick = async () => {
        try { const pack = await backupPack(); const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = '4running-cambios-locales.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); document.querySelector('#useRemote').disabled = false; }
        catch (error) { status(error.message); }
      };
      document.querySelector('#useRemote').onclick = async () => {
        try {
          await whenDurable();
          const conflicts = await list('conflicts');
          // Also repair legacy conflicts archived by an older client. Keep every
          // candidate until all attempts have a confirmed server acknowledgement.
          for (const operation of conflicts) if (operation.legacy) await deliverLegacyLogs(operation);
          await transaction(['conflicts'], 'readwrite', tx => { for (const operation of conflicts) tx.objectStore('conflicts').delete(operation.id); });
          await updateMarker(); location.reload();
        } catch (error) {
          status('No pudimos confirmar que todos los intentos estén en tu cuenta. Conservamos los conflictos y el respaldo; reintentá con conexión.');
        }
      };
      window.addEventListener('online', () => flush().catch(error => status(error.message)));
      window.addEventListener('storage', event => {
        if (event.key === '4running.cacheOwner' && event.newValue !== user?.id) { location.reload(); return; }
      });
      if (channel) channel.onmessage = async event => { if (event.data?.owner === user?.id && event.data.tabId !== tabId) { try { await whenDurable(); await refreshCache({ notify: true }); } catch (error) { status(error.message); } } };
      document.querySelector('.app-shell').hidden = false; loading = false; ready = true;
      status(offlineIdentity ? 'Sin conexión · usando la última cuenta verificada en este dispositivo. Los cambios quedan pendientes hasta validar la sesión en línea.' : conflictCount ? 'Tus intentos están guardados. Hay planes divergentes para conciliar.' : (await list('outbox')).length ? 'Cambios locales pendientes de sincronizar' : 'Sincronizado con tu cuenta');
      return true;
    } catch (error) { gate.hidden = false; authError.textContent = error.status === 429 ? 'Se alcanzó el límite temporal de consultas. Esperá un momento y volvé a ingresar; tus datos siguen conservados.' : 'No se pudo conectar al servidor de cuentas o al almacenamiento durable. Tus pendientes se conservan; reintentá cuando vuelva la conexión.'; return false; }
  }
  function markDirty() { if (user && !loading) for (const [name, value] of Object.entries(snapshot())) stage(name, value); }
  window.PaceCloud = { boot, flush, markDirty, whenDurable, signOut, userId: () => user?.id || null, backupPack };
})();

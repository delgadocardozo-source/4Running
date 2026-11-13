import { createServer } from 'node:http';
import { readFile, mkdir, appendFile, writeFile, chmod, access } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const validLogs = logs => Array.isArray(logs) && logs.every(log => log && typeof log === 'object' && typeof log.id === 'string' && log.id.length > 0 && log.id.length <= 200);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keepsAttempts = (before, after) => (before?.sessions || []).every(session => {
  const attempts = session.attempts || [];
  if (!attempts.length) return true;
  const candidate = (after?.sessions || []).find(item => item.id === session.id);
  return candidate && attempts.every(attempt => (candidate.attempts || []).some(next => (next.logId || next.id) === (attempt.logId || attempt.id)));
});

async function openRuntime({ port = Number(process.env.PORT || 4174), directory = process.env.DATA_DIR || 'work/data', testMail = process.env.TEST_MAIL === '1', migrate = false } = {}) {
  const production = process.env.NODE_ENV === 'production';
  if (production && (!process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL?.startsWith('https://') || !process.env.RESEND_API_KEY || !process.env.MAIL_FROM || !process.env.DATA_DIR || testMail)) throw new Error('Production requires auth secret, HTTPS URL, persistent DATA_DIR and mail configuration; TEST_MAIL must be disabled.');
  const databaseFile = resolve(directory, '4running.sqlite');
  if (!migrate) {
    try { await access(databaseFile); } catch { throw new Error('Database is not initialized. Run `node server.mjs migrate` explicitly before starting the server.'); }
  } else await mkdir(directory, { recursive: true, mode: 0o700 });
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    const secretFile = resolve(directory, 'auth-secret');
    try { secret = await readFile(secretFile, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      secret = randomBytes(32).toString('hex');
      await writeFile(secretFile, secret, { mode: 0o600, flag: 'wx' });
    }
  }
  const db = new Database(databaseFile, { fileMustExist: !migrate });
  try {
    if (migrate) {
      await chmod(databaseFile, 0o600);
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS athlete_state (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_records (user_id TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id, session_id));
        CREATE TABLE IF NOT EXISTS sync_mutations (user_id TEXT NOT NULL, mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(user_id, mutation_id));
        CREATE TABLE IF NOT EXISTS sync_operations (user_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id, operation_id));`);
    } else {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (!['athlete_state', 'session_records', 'sync_mutations', 'sync_operations', 'user', 'session', 'account', 'verification'].every(name => tables.has(name))) throw new Error('Database schema is outdated. Run `node server.mjs migrate` explicitly; normal startup never changes the schema.');
    }
    const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;
    const trustedOrigins = [baseURL, ...(!production ? [`http://127.0.0.1:${port}`] : [])];
    const auth = betterAuth({
      database: db, baseURL, secret, trustedOrigins,
      emailAndPassword: {
        enabled: true, minPasswordLength: 12, revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, url }) => {
          if (testMail && !production) { await appendFile(resolve(directory, 'mail-outbox.jsonl'), JSON.stringify({ email: user.email, url }) + '\n', { mode: 0o600 }); return; }
          if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) throw new Error('Email delivery is not configured');
          const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM, to: user.email, subject: 'Recuperá tu acceso a 4Running', text: `Abrí este enlace para elegir una contraseña nueva: ${url}` }) });
          if (!response.ok) throw new Error('Email delivery failed');
        }
      },
      // Session reads are frequent during multi-tab sync. Authentication mutations
      // retain Better Auth's stricter built-in limits.
      rateLimit: { enabled: true, window: 60, max: 50, customRules: { '/get-session': { window: 60, max: 300 } } },
      advanced: { useSecureCookies: production, ipAddress: { ipAddressHeaders: ['x-4running-client-ip'] } }
    });
    if (migrate) await (await getMigrations(auth.options)).runMigrations();
    await auth.$context; // Finish initialization before returning or closing a migration-only connection.
    return { db, auth, baseURL, trustedOrigins, port };
  } catch (error) { db.close(); throw error; }
}

export async function migrateDatabase(options = {}) {
  const runtime = await openRuntime({ ...options, migrate: true });
  runtime.db.close();
}

export async function startServer(options = {}) {
  const { db, auth, baseURL, trustedOrigins, port } = await openRuntime(options);
  const handleAuth = toNodeHandler(auth);
  const files = new Set(['index.html', 'app.js', 'adaptive-engine.js', 'coach-engine.js', 'product.js', 'cloud.js', 'workout-runtime.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'hero-runner.jpg', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png']);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const currentState = userId => {
    const row = db.prepare('SELECT revision, payload FROM athlete_state WHERE user_id = ?').get(userId);
    return { revision: row?.revision || 0, data: row ? JSON.parse(row.payload) : null };
  };
  const upsertLogs = (userId, incoming) => {
    const read = db.prepare('SELECT payload FROM session_records WHERE user_id = ? AND session_id = ?');
    const write = db.prepare('INSERT INTO session_records VALUES (?, ?, ?) ON CONFLICT(user_id, session_id) DO UPDATE SET payload=excluded.payload');
    const retained = [];
    for (const log of incoming) {
      const oldRow = read.get(userId, log.id);
      const old = oldRow && JSON.parse(oldRow.payload);
      // A stale full-history snapshot must not undo a later explicit correction.
      const oldStamp = old?.updatedAt || old?.editedAt || '';
      const newStamp = log.updatedAt || log.editedAt || '';
      if (old && oldStamp && (!newStamp || newStamp < oldStamp)) { retained.push(log.id); continue; }
      write.run(userId, log.id, JSON.stringify(log));
    }
    return retained;
  };
  const allLogs = userId => db.prepare('SELECT payload FROM session_records WHERE user_id = ?').all(userId).map(row => JSON.parse(row.payload));
  const saveState = (userId, revision, data) => db.prepare('INSERT INTO athlete_state VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(userId, revision, JSON.stringify(data));
  const readBody = async req => {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) { const error = new Error('Datos demasiado grandes'); error.status = 413; throw error; } }
    try { return JSON.parse(raw); } catch { const error = new Error('JSON inválido'); error.status = 400; throw error; }
  };
  const server = createServer(async (req, res) => {
    try {
      req.headers['x-4running-client-ip'] = req.socket.remoteAddress;
      const path = new URL(req.url, baseURL).pathname;
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
      if (path.startsWith('/api/auth/')) return await handleAuth(req, res);
      if (path === '/api/config') return json(res, 200, { passwordRecovery: Boolean(options.testMail || process.env.TEST_MAIL === '1' || process.env.RESEND_API_KEY && process.env.MAIL_FROM), testMail: options.testMail ?? process.env.TEST_MAIL === '1' });
      if (path === '/api/state' || path === '/api/sync') {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (!session) return json(res, 401, { error: 'Iniciá sesión para acceder a tus datos.' });
        const userId = session.user.id;
        if (req.headers['x-4running-owner'] && req.headers['x-4running-owner'] !== userId) return json(res, 403, { error: 'La cuenta de la sesión no coincide con el propietario de estos cambios.' });
        if (path === '/api/state' && req.method === 'GET') return json(res, 200, currentState(userId));
        if (req.method !== (path === '/api/sync' ? 'POST' : 'PUT')) return json(res, 405, { error: 'Método no permitido' });
        if (!trustedOrigins.includes(req.headers.origin)) return json(res, 403, { error: 'Origen inválido' });
        const body = await readBody(req);
        if (path === '/api/sync') {
          if (!plain(body) || typeof body.mutationId !== 'string' || !body.mutationId || body.mutationId.length > 100 || !plain(body.changes) || body.changes.logs != null && !validLogs(body.changes.logs) || own(body.changes, 'plan') && body.changes.plan !== null && !plain(body.changes.plan) || body.changes.settings != null && !plain(body.changes.settings) || body.changes.account != null && !plain(body.changes.account)) return json(res, 400, { error: 'Operación inválida' });
          const hash = digest({ basePlan: body.basePlan ?? null, changes: body.changes });
          const result = db.transaction(() => {
            const previous = db.prepare('SELECT payload_hash, result FROM sync_operations WHERE user_id = ? AND operation_id = ?').get(userId, body.mutationId);
            if (previous) return previous.payload_hash === hash ? { ...JSON.parse(previous.result), replayed: true } : { invalidReplay: true };
            const current = currentState(userId);
            const data = current.data || { settings: {}, account: {}, plan: null, logs: [] };
            const changes = body.changes;
            const retainedLogIds = upsertLogs(userId, changes.logs || []);
            const planConflict = own(changes, 'plan') && (!keepsAttempts(data.plan, changes.plan) || canonical(data.plan ?? null) !== canonical(body.basePlan ?? null) && canonical(data.plan ?? null) !== canonical(changes.plan));
            if (own(changes, 'plan') && !planConflict) data.plan = changes.plan;
            if (changes.settings) data.settings = { ...(data.settings || {}), ...changes.settings };
            if (changes.account) data.account = { ...(data.account || {}), ...changes.account };
            data.logs = allLogs(userId);
            const revision = current.revision + 1;
            saveState(userId, revision, data);
            const outcome = { revision, planConflict, retainedLogIds };
            db.prepare('INSERT INTO sync_operations VALUES (?, ?, ?, ?)').run(userId, body.mutationId, hash, JSON.stringify(outcome));
            return outcome;
          })();
          return json(res, result.invalidReplay ? 409 : 200, result.invalidReplay ? { error: 'La operación ya existe con otro contenido.' } : result);
        }
        // Legacy snapshot endpoint: kept for old queued clients and migration of their outbox.
        if (!plain(body) || !plain(body.data) || !validLogs(body.data.logs) || !Number.isInteger(body.revision)) return json(res, 400, { error: 'Datos inválidos' });
        const mutationId = typeof body.mutationId === 'string' && body.mutationId.length <= 100 ? body.mutationId : null;
        const hash = digest(body.data);
        const result = db.transaction(() => {
          const replay = mutationId && db.prepare('SELECT payload_hash, revision FROM sync_mutations WHERE user_id = ? AND mutation_id = ?').get(userId, mutationId);
          if (replay) return [hash, createHash('sha256').update(JSON.stringify(body.data)).digest('hex')].includes(replay.payload_hash) ? { revision: replay.revision, replayed: true } : { conflict: true };
          const current = currentState(userId);
          if (current.revision !== body.revision) return { conflict: true };
          upsertLogs(userId, body.data.logs);
          const data = { settings: body.data.settings || {}, account: body.data.account || {}, plan: body.data.plan || null, logs: allLogs(userId) };
          saveState(userId, current.revision + 1, data);
          if (mutationId) db.prepare('INSERT INTO sync_mutations VALUES (?, ?, ?, ?)').run(userId, mutationId, hash, current.revision + 1);
          return { revision: current.revision + 1 };
        })();
        return json(res, result.conflict ? 409 : 200, result.conflict ? { error: 'Hay cambios de otro dispositivo. Conservamos tu copia para conciliarlos.' } : result);
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'No encontrado' });
      const name = path === '/' ? 'index.html' : path.slice(1);
      if (!files.has(name)) { res.writeHead(404); return res.end('Not found'); }
      const contents = await readFile(new URL(name, import.meta.url));
      res.writeHead(200, { 'Content-Type': mime[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(contents);
    } catch (error) { console.error(error.message); if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'No pudimos completar la operación. Tus datos locales se conservan.' }); else res.end(); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolveListen); });
  return { server, db, auth, close: async () => { await new Promise(resolveClose => server.close(resolveClose)); db.close(); } };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (process.argv[2] === 'migrate') { await migrateDatabase(); console.log('4Running: migración explícita completada.'); }
  else { await startServer(); console.log(`4Running: http://localhost:${process.env.PORT || 4174}`); }
}

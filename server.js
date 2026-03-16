require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ? String(process.env.ADMIN_EMAIL).trim().toLowerCase() : '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : '';
const APP_NAME = process.env.APP_NAME || 'QM Monitor';
const APP_URL = process.env.APP_URL || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || '';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt. Bitte als Env-Variable setzen.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Nur Bild-Uploads sind erlaubt.'));
    cb(null, true);
  },
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const x = v.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(x)) return true;
    if (['false', '0', 'no', 'off'].includes(x)) return false;
  }
  return fallback;
}

function todayLocalISO() {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function initDb() {
  const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    short_code TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    notify_only_assigned BOOLEAN NOT NULL DEFAULT TRUE,
    notify_only_red BOOLEAN NOT NULL DEFAULT FALSE,
    notify_daily_digest BOOLEAN NOT NULL DEFAULT FALSE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_new_case BOOLEAN NOT NULL DEFAULT TRUE,
    email_escalation BOOLEAN NOT NULL DEFAULT TRUE,
    email_due_reminder BOOLEAN NOT NULL DEFAULT TRUE,
    weekly_summary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS cases (
    id SERIAL PRIMARY KEY,
    case_type TEXT NOT NULL CHECK (case_type IN ('customer_complaint', 'internal_process')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'neu',
    priority TEXT NOT NULL DEFAULT 'gelb',
    source_area TEXT,
    customer_name TEXT,
    vehicle TEXT,
    order_ref TEXT,
    mechanic_code TEXT,
    internal_action TEXT,
    customer_action TEXT,
    due_date DATE,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    closed BOOLEAN NOT NULL DEFAULT FALSE,
    closed_at TIMESTAMPTZ,
    closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS case_updates (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    update_type TEXT NOT NULL DEFAULT 'note',
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS case_attachments (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id SERIAL PRIMARY KEY,
    event_key TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
  CREATE INDEX IF NOT EXISTS idx_cases_assigned_user_id ON cases(assigned_user_id);
  CREATE INDEX IF NOT EXISTS idx_case_updates_case_id ON case_updates(case_id);
  CREATE INDEX IF NOT EXISTS idx_case_attachments_case_id ON case_attachments(case_id);
  `;

  await pool.query(schema);

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    console.log(`[init] Admin-Seeding gestartet für ${ADMIN_EMAIL}`);
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const result = await pool.query(
      `INSERT INTO users (name, short_code, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         short_code = COALESCE(users.short_code, EXCLUDED.short_code),
         password_hash = EXCLUDED.password_hash,
         role = 'admin'
       RETURNING id, email`,
      ['Admin', 'ADM', ADMIN_EMAIL, hash]
    );
    await pool.query(
      `INSERT INTO notification_settings (user_id, email_enabled, weekly_summary)
       VALUES ($1, FALSE, FALSE)
       ON CONFLICT (user_id) DO NOTHING`,
      [result.rows[0].id]
    );
    console.log(`[init] Admin-User aktiv: ${result.rows[0].email} (id=${result.rows[0].id})`);
  } else {
    console.warn('[init] ADMIN_EMAIL oder ADMIN_PASSWORD fehlt - kein Admin-Seeding ausgeführt.');
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const token = req.cookies.qm_token;
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session ungültig.' });
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Adminrechte erforderlich.' });
  next();
}

async function ensureNotificationRow(userId) {
  await pool.query('INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

async function getCaseById(id) {
  const result = await pool.query(
    `SELECT c.*, creator.name AS created_by_name, creator.short_code AS created_by_short_code,
            assignee.name AS assigned_user_name, assignee.email AS assigned_user_email, assignee.short_code AS assigned_user_short_code,
            closer.name AS closed_by_name
     FROM cases c
     JOIN users creator ON creator.id = c.created_by
     LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
     LEFT JOIN users closer ON closer.id = c.closed_by
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getCaseRecipients(caseRow, { eventType }) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, u.role,
            ns.notify_enabled, ns.notify_only_assigned, ns.notify_only_red, ns.email_enabled,
            ns.email_new_case, ns.email_escalation, ns.email_due_reminder, ns.weekly_summary
     FROM users u
     LEFT JOIN notification_settings ns ON ns.user_id = u.id
     ORDER BY u.id ASC`
  );

  return result.rows.filter((u) => {
    if (!u.email) return false;
    if (!u.notify_enabled) return false;
    if (!u.email_enabled) return false;
    if (u.notify_only_red && caseRow.priority !== 'rot') return false;
    if (u.notify_only_assigned && Number(u.id) !== Number(caseRow.assigned_user_id) && u.role !== 'admin') return false;
    if (eventType === 'new_case' && !u.email_new_case) return false;
    if (eventType === 'escalation' && !u.email_escalation) return false;
    if (eventType === 'due' && !u.email_due_reminder) return false;
    return true;
  });
}

async function sendMail({ to, subject, text, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[mail] SMTP nicht konfiguriert - Mailversand übersprungen.');
    return false;
  }
  await transporter.sendMail({ from: SMTP_FROM, to, subject, text, html });
  return true;
}

async function sendCaseNotification(caseId, eventType, extraText = '') {
  const caseRow = await getCaseById(caseId);
  if (!caseRow) return;
  const recipients = await getCaseRecipients(caseRow, { eventType });
  if (!recipients.length) return;

  const labels = {
    new_case: 'Neuer Fall',
    escalation: 'Neue Eskalation',
    due: 'Fall fällig',
  };
  const subject = `[${APP_NAME}] ${labels[eventType] || 'Update'} #${caseRow.id} – ${caseRow.title}`;
  const caseUrl = APP_URL ? `${APP_URL.replace(/\/$/, '')}/?case=${caseRow.id}` : '';

  for (const user of recipients) {
    const eventKey = `${eventType}:${caseRow.id}:${user.id}:${eventType === 'due' ? todayLocalISO() : Date.now()}`;
    if (eventType === 'due') {
      const dup = await pool.query('SELECT 1 FROM notification_log WHERE event_key = $1', [eventKey]);
      if (dup.rowCount) continue;
    }
    const text = `${labels[eventType] || 'Update'}

Fall #${caseRow.id}: ${caseRow.title}
Typ: ${caseRow.case_type === 'customer_complaint' ? 'Kundenreklamation' : 'Interner Prozessfehler'}
Priorität: ${caseRow.priority}
Status: ${caseRow.status}
Zuständig: ${caseRow.assigned_user_name || 'offen'}
Fällig: ${caseRow.due_date || '—'}
${extraText ? `
Info: ${extraText}
` : ''}${caseUrl ? `
Link: ${caseUrl}
` : ''}`;
    await sendMail({ to: user.email, subject, text, html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${text}</pre>` });
    if (eventType === 'due') {
      await pool.query(
        `INSERT INTO notification_log (event_key, event_type, user_id, case_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (event_key) DO NOTHING`,
        [eventKey, eventType, user.id, caseRow.id]
      );
    }
  }
}

async function sendWeeklySummaries() {
  const transporter = getTransporter();
  if (!transporter) return;
  const wk = weekKey();
  const users = await pool.query(
    `SELECT u.id, u.name, u.email
     FROM users u
     JOIN notification_settings ns ON ns.user_id = u.id
     WHERE ns.notify_enabled = TRUE AND ns.email_enabled = TRUE AND ns.weekly_summary = TRUE`
  );

  for (const user of users.rows) {
    const eventKey = `weekly:${wk}:${user.id}`;
    const dup = await pool.query('SELECT 1 FROM notification_log WHERE event_key = $1', [eventKey]);
    if (dup.rowCount) continue;

    const cases = await pool.query(
      `SELECT id, title, priority, status, due_date
       FROM cases
       WHERE (assigned_user_id = $1 OR created_by = $1) AND status <> 'abgeschlossen'
       ORDER BY updated_at DESC`,
      [user.id]
    );
    if (!cases.rowCount) continue;

    const lines = cases.rows.map((c) => `#${c.id} • ${c.title} • ${c.priority} • ${c.status} • fällig ${c.due_date || '—'}`).join('\n');
    await sendMail({
      to: user.email,
      subject: `[${APP_NAME}] Wöchentliche Übersicht ${wk}`,
      text: `Offene Fälle dieser Woche:\n\n${lines}`,
      html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">Offene Fälle dieser Woche:\n\n${lines}</pre>`,
    });
    await pool.query(
      `INSERT INTO notification_log (event_key, event_type, user_id)
       VALUES ($1, 'weekly', $2) ON CONFLICT (event_key) DO NOTHING`,
      [eventKey, user.id]
    );
  }
}

async function sendDueReminders() {
  const today = todayLocalISO();
  const dueCases = await pool.query(
    `SELECT id FROM cases WHERE due_date = $1 AND status <> 'abgeschlossen'`,
    [today]
  );
  for (const row of dueCases.rows) {
    await sendCaseNotification(row.id, 'due', 'Heute fällig');
  }
}

function maybeStartCrons() {
  if (!getTransporter()) {
    console.warn('[mail] SMTP nicht vollständig konfiguriert. Mail-/Wochenjobs bleiben inaktiv.');
    return;
  }
  cron.schedule('0 7 * * *', () => sendDueReminders().catch((e) => console.error('[cron] due', e)));
  cron.schedule('0 7 * * 1', () => sendWeeklySummaries().catch((e) => console.error('[cron] weekly', e)));
  console.log('[cron] Mail-Jobs aktiv (07:00 täglich / montags).');
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, app: APP_NAME, mailConfigured: Boolean(getTransporter()) });
  } catch {
    res.status(500).json({ ok: false, error: 'DB nicht erreichbar' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedPassword = String(password);
  const result = await pool.query('SELECT id, name, email, password_hash, role FROM users WHERE email = $1', [normalizedEmail]);
  if (result.rowCount === 0) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  const user = result.rows[0];
  const ok = await bcrypt.compare(normalizedPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  const token = signToken(user);
  res.cookie('qm_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.get('/api/debug/admin-status', async (_req, res) => {
  const users = await pool.query('SELECT id, name, short_code, email, role, created_at FROM users ORDER BY id ASC');
  res.json({
    adminEmailEnv: ADMIN_EMAIL || null,
    hasAdminPasswordEnv: Boolean(ADMIN_PASSWORD),
    users: users.rows,
  });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('qm_token');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, async (req, res) => {
  await ensureNotificationRow(req.user.id);
  const settings = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
  res.json({
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    settings: settings.rows[0] || null,
  });
});

app.get('/api/users', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT id, name, short_code, email, role FROM users ORDER BY name ASC');
  res.json(result.rows);
});

app.post('/api/users', authRequired, adminRequired, async (req, res) => {
  const { name, short_code, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, E-Mail und Passwort sind erforderlich.' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const created = await pool.query(
      `INSERT INTO users (name, short_code, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, short_code, email, role`,
      [name, short_code || null, String(email).toLowerCase(), hash, role || 'user']
    );
    await ensureNotificationRow(created.rows[0].id);
    res.status(201).json(created.rows[0]);
  } catch (error) {
    if (String(error.message).includes('duplicate')) return res.status(409).json({ error: 'E-Mail existiert bereits.' });
    throw error;
  }
});

app.get('/api/settings', authRequired, async (req, res) => {
  await ensureNotificationRow(req.user.id);
  const result = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

app.patch('/api/settings', authRequired, async (req, res) => {
  const payload = {
    notify_enabled: toBool(req.body?.notify_enabled, true),
    notify_only_assigned: toBool(req.body?.notify_only_assigned, true),
    notify_only_red: toBool(req.body?.notify_only_red, false),
    notify_daily_digest: toBool(req.body?.notify_daily_digest, false),
    email_enabled: toBool(req.body?.email_enabled, false),
    email_new_case: toBool(req.body?.email_new_case, true),
    email_escalation: toBool(req.body?.email_escalation, true),
    email_due_reminder: toBool(req.body?.email_due_reminder, true),
    weekly_summary: toBool(req.body?.weekly_summary, false),
  };
  const result = await pool.query(
    `INSERT INTO notification_settings
      (user_id, notify_enabled, notify_only_assigned, notify_only_red, notify_daily_digest, email_enabled, email_new_case, email_escalation, email_due_reminder, weekly_summary, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
      notify_enabled = EXCLUDED.notify_enabled,
      notify_only_assigned = EXCLUDED.notify_only_assigned,
      notify_only_red = EXCLUDED.notify_only_red,
      notify_daily_digest = EXCLUDED.notify_daily_digest,
      email_enabled = EXCLUDED.email_enabled,
      email_new_case = EXCLUDED.email_new_case,
      email_escalation = EXCLUDED.email_escalation,
      email_due_reminder = EXCLUDED.email_due_reminder,
      weekly_summary = EXCLUDED.weekly_summary,
      updated_at = NOW()
     RETURNING *`,
    [req.user.id, payload.notify_enabled, payload.notify_only_assigned, payload.notify_only_red, payload.notify_daily_digest, payload.email_enabled, payload.email_new_case, payload.email_escalation, payload.email_due_reminder, payload.weekly_summary]
  );
  res.json(result.rows[0]);
});

app.get('/api/cases', authRequired, async (req, res) => {
  const { status, priority, type, mine } = req.query;
  const params = [];
  const where = [];
  if (status && status !== 'all') { params.push(status); where.push(`c.status = $${params.length}`); }
  if (priority && priority !== 'all') { params.push(priority); where.push(`c.priority = $${params.length}`); }
  if (type && type !== 'all') { params.push(type); where.push(`c.case_type = $${params.length}`); }
  if (mine === '1') { params.push(req.user.id); where.push(`c.assigned_user_id = $${params.length}`); }
  const sql = `
    SELECT c.*, creator.name AS created_by_name, creator.short_code AS created_by_short_code,
      assignee.name AS assigned_user_name, assignee.short_code AS assigned_user_short_code,
      COUNT(u.id)::int AS update_count,
      COUNT(a.id)::int AS attachment_count
    FROM cases c
    JOIN users creator ON creator.id = c.created_by
    LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
    LEFT JOIN case_updates u ON u.case_id = c.id
    LEFT JOIN case_attachments a ON a.case_id = c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY c.id, creator.name, creator.short_code, assignee.name, assignee.short_code
    ORDER BY c.updated_at DESC, c.id DESC
  `;
  const result = await pool.query(sql, params);
  res.json(result.rows);
});

app.get('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const caseRow = await getCaseById(id);
  if (!caseRow) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  const updates = await pool.query(
    `SELECT cu.*, u.name AS user_name, u.short_code AS user_short_code
     FROM case_updates cu
     JOIN users u ON u.id = cu.user_id
     WHERE cu.case_id = $1
     ORDER BY cu.created_at ASC, cu.id ASC`,
    [id]
  );
  const attachments = await pool.query(
    `SELECT id, filename, mime_type, size_bytes, created_at FROM case_attachments WHERE case_id = $1 ORDER BY created_at ASC, id ASC`,
    [id]
  );
  res.json({ ...caseRow, updates: updates.rows, attachments: attachments.rows });
});

app.post('/api/cases', authRequired, async (req, res) => {
  const {
    case_type, title, description, priority, source_area, customer_name, vehicle,
    order_ref, due_date, assigned_user_id, mechanic_code, internal_action, customer_action,
  } = req.body || {};
  if (!case_type || !title || !description) return res.status(400).json({ error: 'Falltyp, Titel und Beschreibung sind Pflichtfelder.' });
  const created = await pool.query(
    `INSERT INTO cases (
      case_type, title, description, priority, source_area, customer_name,
      vehicle, order_ref, due_date, assigned_user_id, created_by, updated_at,
      mechanic_code, internal_action, customer_action, closed
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13,$14,FALSE)
    RETURNING *`,
    [case_type, title, description, priority || 'gelb', source_area || null, customer_name || null,
      vehicle || null, order_ref || null, due_date || null, assigned_user_id || null, req.user.id,
      mechanic_code || null, internal_action || null, customer_action || null]
  );
  await pool.query(`INSERT INTO case_updates (case_id, user_id, update_type, content) VALUES ($1, $2, 'system', $3)`, [created.rows[0].id, req.user.id, `Fall angelegt durch ${req.user.name}`]);
  await sendCaseNotification(created.rows[0].id, 'new_case').catch((e) => console.error('[mail] new_case', e));
  res.status(201).json(created.rows[0]);
});

app.patch('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  const allowed = ['status', 'priority', 'assigned_user_id', 'due_date', 'source_area', 'mechanic_code', 'internal_action', 'customer_action', 'customer_name', 'vehicle', 'order_ref', 'title', 'description'];
  const keys = Object.keys(payload).filter((k) => allowed.includes(k));
  const closed = Object.prototype.hasOwnProperty.call(payload, 'closed') ? toBool(payload.closed, false) : null;
  if (!keys.length && closed === null) return res.status(400).json({ error: 'Keine gültigen Felder zur Aktualisierung.' });
  const params = [];
  const sets = keys.map((key) => {
    params.push(payload[key] === '' ? null : payload[key]);
    return `${key} = $${params.length}`;
  });
  if (closed !== null) {
    params.push(closed);
    sets.push(`closed = $${params.length}`);
    if (closed) {
      sets.push(`status = 'abgeschlossen'`);
      sets.push(`closed_at = NOW()`);
      params.push(req.user.id);
      sets.push(`closed_by = $${params.length}`);
    } else {
      sets.push(`closed_at = NULL`);
      sets.push(`closed_by = NULL`);
    }
  }
  params.push(id);
  const result = await pool.query(`UPDATE cases SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  res.json(result.rows[0]);
});

app.post('/api/cases/:id/updates', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { content, update_type } = req.body || {};
  if (!content) return res.status(400).json({ error: 'Inhalt erforderlich.' });
  const exists = await pool.query('SELECT id FROM cases WHERE id = $1', [id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  const created = await pool.query(
    `INSERT INTO case_updates (case_id, user_id, update_type, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.user.id, update_type || 'note', content]
  );
  await pool.query('UPDATE cases SET updated_at = NOW() WHERE id = $1', [id]);
  if ((update_type || 'note') === 'escalation') {
    await sendCaseNotification(id, 'escalation', content).catch((e) => console.error('[mail] escalation', e));
  }
  res.status(201).json(created.rows[0]);
});

app.post('/api/cases/:id/attachments', authRequired, upload.array('images', 6), async (req, res) => {
  const id = Number(req.params.id);
  const exists = await pool.query('SELECT id FROM cases WHERE id = $1', [id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Keine Bilder ausgewählt.' });
  const saved = [];
  for (const file of files) {
    const base64 = file.buffer.toString('base64');
    const inserted = await pool.query(
      `INSERT INTO case_attachments (case_id, uploaded_by, filename, mime_type, size_bytes, data_base64)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mime_type, size_bytes, created_at`,
      [id, req.user.id, file.originalname, file.mimetype, file.size, base64]
    );
    saved.push(inserted.rows[0]);
  }
  await pool.query('UPDATE cases SET updated_at = NOW() WHERE id = $1', [id]);
  res.status(201).json(saved);
});

app.get('/api/attachments/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const result = await pool.query('SELECT filename, mime_type, data_base64 FROM case_attachments WHERE id = $1', [id]);
  if (!result.rowCount) return res.status(404).send('Nicht gefunden');
  const row = result.rows[0];
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
  res.send(Buffer.from(row.data_base64, 'base64'));
});

app.get('/api/admin/mail-status', authRequired, adminRequired, async (_req, res) => {
  res.json({ mailConfigured: Boolean(getTransporter()) });
});

app.post('/api/admin/send-weekly-summary-now', authRequired, adminRequired, async (_req, res) => {
  await sendWeeklySummaries();
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Interner Serverfehler.' });
});

initDb()
  .then(() => {
    maybeStartCrons();
    app.listen(PORT, () => console.log(`${APP_NAME} läuft auf Port ${PORT}`));
  })
  .catch((error) => {
    console.error('Fehler beim Initialisieren:', error);
    process.exit(1);
  });
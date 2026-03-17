
try { require('dotenv').config(); } catch (_err) {}
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');

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

app.use(express.json({ limit: '12mb' }));
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
function quarterFromDateString(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
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
  return nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
}

async function initDb() {
  await pool.query(`
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
      service_advisor TEXT,
      mechanic_code TEXT,
      internal_action TEXT,
      customer_action TEXT,
      due_date DATE,
      assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      closed BOOLEAN NOT NULL DEFAULT FALSE,
      closed_at TIMESTAMPTZ,
      closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category TEXT,
      repeat_case BOOLEAN NOT NULL DEFAULT FALSE,
      cause_guess TEXT,
      complaint_validity TEXT,
      escalation_level TEXT,
      linked_internal_process BOOLEAN NOT NULL DEFAULT FALSE,
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
  `);

  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS short_code TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS service_advisor TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS mechanic_code TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS internal_action TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS customer_action TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS category TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS repeat_case BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS cause_guess TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS complaint_validity TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS escalation_level TEXT`,
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS linked_internal_process BOOLEAN NOT NULL DEFAULT FALSE`,
  ];
  for (const sql of migrations) await pool.query(sql);

  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','teamleader','admin'))`)
    .catch(() => {});

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_type ON cases(case_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cases_category ON cases(category)`);

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
    await pool.query(`INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [result.rows[0].id]);
    console.log(`[init] Admin-User aktiv: ${result.rows[0].email} (id=${result.rows[0].id})`);
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}
function authRequired(req, res, next) {
  const token = req.cookies.qm_token;
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Session ungültig.' }); }
}
function roleRequired(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'Rechte fehlen.' });
    next();
  };
}

async function ensureNotificationRow(userId) {
  await pool.query('INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

async function getCaseById(id) {
  const result = await pool.query(
    `SELECT c.*, creator.name AS created_by_name, creator.short_code AS created_by_short_code,
            assignee.name AS assigned_user_name, assignee.email AS assigned_user_email, assignee.short_code AS assigned_user_short_code,
            closer.name AS closed_by_name, closer.short_code AS closed_by_short_code
     FROM cases c
     JOIN users creator ON creator.id = c.created_by
     LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
     LEFT JOIN users closer ON closer.id = c.closed_by
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function sendMail({ to, subject, text, html }) {
  const transporter = getTransporter();
  if (!transporter) return false;
  await transporter.sendMail({ from: SMTP_FROM, to, subject, text, html });
  return true;
}
async function sendWeeklySummaries() { /* intentionally unchanged / optional */ }
async function sendDueReminders() { /* intentionally unchanged / optional */ }
function maybeStartCrons() { if (!getTransporter()) return; cron.schedule('0 7 * * *', () => sendDueReminders().catch(console.error)); cron.schedule('0 7 * * 1', () => sendWeeklySummaries().catch(console.error)); }

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, app: APP_NAME }); }
  catch { res.status(500).json({ ok: false, error: 'DB nicht erreichbar' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const result = await pool.query('SELECT id, name, email, password_hash, role FROM users WHERE email = $1', [normalizedEmail]);
  if (!result.rowCount) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  const user = result.rows[0];
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  const token = signToken(user);
  res.cookie('qm_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*60*60*1000 });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});
app.post('/api/logout', (_req, res) => { res.clearCookie('qm_token'); res.json({ ok: true }); });
app.get('/api/me', authRequired, async (req, res) => {
  await ensureNotificationRow(req.user.id);
  const result = await pool.query('SELECT u.id, u.name, u.email, u.role, u.short_code, ns.* FROM users u LEFT JOIN notification_settings ns ON ns.user_id=u.id WHERE u.id=$1', [req.user.id]);
  const row = result.rows[0];
  res.json({ id: row.id, name: row.name, email: row.email, role: row.role, short_code: row.short_code, settings: row });
});
app.get('/api/debug/admin-status', async (_req, res) => {
  const users = await pool.query('SELECT id, name, short_code, email, role, created_at FROM users ORDER BY id ASC');
  res.json({ adminEmailEnv: ADMIN_EMAIL || null, hasAdminPasswordEnv: Boolean(ADMIN_PASSWORD), users: users.rows });
});

app.get('/api/users', authRequired, async (_req, res) => {
  const result = await pool.query('SELECT id, name, short_code, email, role FROM users ORDER BY name ASC');
  res.json(result.rows);
});
app.post('/api/users', authRequired, roleRequired('admin'), async (req, res) => {
  const { name, short_code, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, E-Mail und Passwort sind erforderlich.' });
  const hash = await bcrypt.hash(password, 12);
  const safeRole = ['user', 'teamleader', 'admin'].includes(role) ? role : 'user';
  try {
    const created = await pool.query(
      `INSERT INTO users (name, short_code, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, short_code, email, role`,
      [name, short_code || null, String(email).toLowerCase(), hash, safeRole]
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
  const result = await pool.query(`
    INSERT INTO notification_settings
      (user_id, notify_enabled, notify_only_assigned, notify_only_red, notify_daily_digest, email_enabled, email_new_case, email_escalation, email_due_reminder, weekly_summary, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      notify_enabled=EXCLUDED.notify_enabled,
      notify_only_assigned=EXCLUDED.notify_only_assigned,
      notify_only_red=EXCLUDED.notify_only_red,
      notify_daily_digest=EXCLUDED.notify_daily_digest,
      email_enabled=EXCLUDED.email_enabled,
      email_new_case=EXCLUDED.email_new_case,
      email_escalation=EXCLUDED.email_escalation,
      email_due_reminder=EXCLUDED.email_due_reminder,
      weekly_summary=EXCLUDED.weekly_summary,
      updated_at=NOW()
    RETURNING *`,
    [req.user.id, payload.notify_enabled, payload.notify_only_assigned, payload.notify_only_red, payload.notify_daily_digest, payload.email_enabled, payload.email_new_case, payload.email_escalation, payload.email_due_reminder, payload.weekly_summary]
  );
  res.json(result.rows[0]);
});

app.get('/api/categories', authRequired, (_req, res) => {
  res.json({
    customer: ['Ausführung Werkstatt', 'Geräusch / Fahrverhalten', 'Sauberkeit / Fahrzeugzustand', 'Kommunikation', 'Termin / Wartezeit', 'Rechnung / Leistung', 'Wiederholreparatur', 'Sonstiges'],
    internal: ['AIR / Dialogannahme', 'Auftragsdokumentation', 'Leistungsbeschreibung unklar', 'Servicevorbereitung', 'Werkstattrückmeldung', 'Teileprozess', 'Endkontrolle / ND-Kontrolle', 'Terminierung / Disposition', 'Kommunikation intern', 'Sonstiges'],
    escalation: ['niedrig', 'mittel', 'hoch', 'kritisch'],
    validity: ['offen', 'ja', 'nein', 'teilweise'],
  });
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
      COUNT(DISTINCT u.id)::int AS update_count,
      COUNT(DISTINCT a.id)::int AS attachment_count
    FROM cases c
    JOIN users creator ON creator.id = c.created_by
    LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
    LEFT JOIN case_updates u ON u.case_id = c.id
    LEFT JOIN case_attachments a ON a.case_id = c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY c.id, creator.name, creator.short_code, assignee.name, assignee.short_code
    ORDER BY c.updated_at DESC, c.id DESC`;
  const result = await pool.query(sql, params);
  res.json(result.rows);
});

app.get('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const caseRow = await getCaseById(id);
  if (!caseRow) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  const updates = await pool.query(`SELECT cu.*, u.name AS user_name, u.short_code AS user_short_code FROM case_updates cu JOIN users u ON u.id = cu.user_id WHERE cu.case_id = $1 ORDER BY cu.created_at ASC, cu.id ASC`, [id]);
  const attachments = await pool.query(`SELECT id, filename, mime_type, size_bytes, created_at FROM case_attachments WHERE case_id = $1 ORDER BY created_at ASC, id ASC`, [id]);
  res.json({ ...caseRow, updates: updates.rows, attachments: attachments.rows });
});

app.post('/api/cases', authRequired, async (req, res) => {
  const {
    case_type, title, description, priority, source_area, customer_name, vehicle, order_ref, due_date,
    assigned_user_id, mechanic_code, internal_action, customer_action, category, repeat_case,
    cause_guess, complaint_validity, escalation_level, linked_internal_process,
  } = req.body || {};
  if (!case_type || !title || !description) return res.status(400).json({ error: 'Falltyp, Titel und Beschreibung sind Pflichtfelder.' });
  const created = await pool.query(
    `INSERT INTO cases (
      case_type, title, description, priority, source_area, customer_name, vehicle, order_ref, due_date,
      assigned_user_id, created_by, updated_at, service_advisor, mechanic_code, internal_action, customer_action,
      closed, category, repeat_case, cause_guess, complaint_validity, escalation_level, linked_internal_process
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13,$14,FALSE,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [case_type, title, description, priority || 'gelb', source_area || null, customer_name || null, vehicle || null, order_ref || null,
      due_date || null, assigned_user_id || null, req.user.id, service_advisor || null, mechanic_code || null, internal_action || null, customer_action || null,
      category || null, toBool(repeat_case, false), cause_guess || null, complaint_validity || 'offen', escalation_level || 'mittel', toBool(linked_internal_process, false)]
  );
  await pool.query(`INSERT INTO case_updates (case_id, user_id, update_type, content) VALUES ($1, $2, 'system', $3)`, [created.rows[0].id, req.user.id, `Fall angelegt durch ${req.user.name}`]);
  res.status(201).json(created.rows[0]);
});

app.patch('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const payload = req.body || {};
  const allowed = ['status','priority','assigned_user_id','due_date','source_area','service_advisor','mechanic_code','internal_action','customer_action','customer_name','vehicle','order_ref','title','description','category','cause_guess','complaint_validity','escalation_level'];
  const keys = Object.keys(payload).filter((k) => allowed.includes(k));
  const sets = [];
  const params = [];
  for (const key of keys) { params.push(payload[key] === '' ? null : payload[key]); sets.push(`${key} = $${params.length}`); }
  if (Object.prototype.hasOwnProperty.call(payload, 'repeat_case')) { params.push(toBool(payload.repeat_case, false)); sets.push(`repeat_case = $${params.length}`); }
  if (Object.prototype.hasOwnProperty.call(payload, 'linked_internal_process')) { params.push(toBool(payload.linked_internal_process, false)); sets.push(`linked_internal_process = $${params.length}`); }
  if (Object.prototype.hasOwnProperty.call(payload, 'closed')) {
    const closed = toBool(payload.closed, false);
    params.push(closed); sets.push(`closed = $${params.length}`);
    if (closed) { sets.push(`status = 'abgeschlossen'`); sets.push(`closed_at = NOW()`); params.push(req.user.id); sets.push(`closed_by = $${params.length}`); }
    else { sets.push(`closed_at = NULL`); sets.push(`closed_by = NULL`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Keine gültigen Felder zur Aktualisierung.' });
  params.push(id);
  const result = await pool.query(`UPDATE cases SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params);
  if (!result.rowCount) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  res.json(result.rows[0]);
});

app.post('/api/cases/:id/updates', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { content, update_type } = req.body || {};
  if (!content) return res.status(400).json({ error: 'Inhalt erforderlich.' });
  const exists = await pool.query('SELECT id FROM cases WHERE id=$1', [id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  const created = await pool.query(`INSERT INTO case_updates (case_id, user_id, update_type, content) VALUES ($1,$2,$3,$4) RETURNING *`, [id, req.user.id, update_type || 'note', content]);
  await pool.query('UPDATE cases SET updated_at = NOW() WHERE id=$1', [id]);
  res.status(201).json(created.rows[0]);
});

app.post('/api/cases/:id/attachments', authRequired, upload.array('images', 6), async (req, res) => {
  const id = Number(req.params.id);
  const exists = await pool.query('SELECT id FROM cases WHERE id=$1', [id]);
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
  await pool.query('UPDATE cases SET updated_at = NOW() WHERE id=$1', [id]);
  res.status(201).json(saved);
});

app.get('/api/attachments/:id', authRequired, async (req, res) => {
  const result = await pool.query('SELECT filename, mime_type, data_base64 FROM case_attachments WHERE id=$1', [Number(req.params.id)]);
  if (!result.rowCount) return res.status(404).send('Nicht gefunden');
  const row = result.rows[0];
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);
  res.send(Buffer.from(row.data_base64, 'base64'));
});


async function fetchAnalyticsData(){
  const rows = (await pool.query(`
    SELECT c.id, c.case_type, c.priority, c.status, c.source_area, c.service_advisor, c.mechanic_code, c.category, c.repeat_case, c.complaint_validity,
           c.escalation_level, c.linked_internal_process, c.closed, c.created_at, c.closed_at, c.due_date
    FROM cases c
    ORDER BY c.created_at ASC`)).rows;
  const analytics = {
    totals: { all: rows.length, complaints: 0, internal: 0, open: 0, closed: 0, repeat: 0, overdue: 0 },
    byMonth: {}, byQuarter: {},
    byArea: { customer_complaint: {}, internal_process: {} },
    byCategory: { customer_complaint: {}, internal_process: {} },
    byMechanic: {}, byServiceAdvisor: {}, linked: {}, validity: {}, escalation: {},
  };
  const today = todayLocalISO();
  for (const r of rows) {
    analytics.totals[r.case_type === 'customer_complaint' ? 'complaints' : 'internal'] += 1;
    if (r.status !== 'abgeschlossen' && !r.closed) analytics.totals.open += 1; else analytics.totals.closed += 1;
    if (r.repeat_case) analytics.totals.repeat += 1;
    if (r.due_date && r.due_date < today && !r.closed) analytics.totals.overdue += 1;
    const month = String(r.created_at).slice(0,7);
    const quarter = quarterFromDateString(r.created_at);
    analytics.byMonth[month] ||= { complaints: 0, internal: 0 };
    analytics.byMonth[month][r.case_type === 'customer_complaint' ? 'complaints' : 'internal'] += 1;
    analytics.byQuarter[quarter] ||= { complaints: 0, internal: 0 };
    analytics.byQuarter[quarter][r.case_type === 'customer_complaint' ? 'complaints' : 'internal'] += 1;
    const areaBucket = analytics.byArea[r.case_type]; areaBucket[r.source_area || 'Unbekannt'] = (areaBucket[r.source_area || 'Unbekannt'] || 0) + 1;
    const catBucket = analytics.byCategory[r.case_type]; catBucket[r.category || 'Unkategorisiert'] = (catBucket[r.category || 'Unkategorisiert'] || 0) + 1;
    const mech = r.mechanic_code || '—'; analytics.byMechanic[mech] ||= { all: 0, complaints: 0, internal: 0, open: 0, closed: 0 }; analytics.byMechanic[mech].all += 1; analytics.byMechanic[mech][r.case_type === 'customer_complaint' ? 'complaints' : 'internal'] += 1; analytics.byMechanic[mech][r.closed ? 'closed' : 'open'] += 1;
    const sb = r.service_advisor || '—'; analytics.byServiceAdvisor[sb] ||= { all: 0, complaints: 0, internal: 0, open: 0, closed: 0 }; analytics.byServiceAdvisor[sb].all += 1; analytics.byServiceAdvisor[sb][r.case_type === 'customer_complaint' ? 'complaints' : 'internal'] += 1; analytics.byServiceAdvisor[sb][r.closed ? 'closed' : 'open'] += 1;
    analytics.linked[r.linked_internal_process ? 'mit Bezug' : 'ohne Bezug'] = (analytics.linked[r.linked_internal_process ? 'mit Bezug' : 'ohne Bezug'] || 0) + 1;
    analytics.validity[r.complaint_validity || 'offen'] = (analytics.validity[r.complaint_validity || 'offen'] || 0) + 1;
    analytics.escalation[r.escalation_level || 'mittel'] = (analytics.escalation[r.escalation_level || 'mittel'] || 0) + 1;
  }
  return analytics;
}

app.get('/api/analytics', authRequired, roleRequired('teamleader', 'admin'), async (_req, res) => {
  res.json(await fetchAnalyticsData());
});

app.get('/api/analytics/export', authRequired, roleRequired('teamleader', 'admin'), async (_req, res) => {
  const rows = (await pool.query(`SELECT id, case_type, title, source_area, service_advisor, mechanic_code, category, priority, status, repeat_case, complaint_validity, escalation_level, linked_internal_process, created_at, closed_at FROM cases ORDER BY created_at DESC`)).rows;
  const header = ['ID','Typ','Titel','Bereich','SB','Mechaniker','Kategorie','Priorität','Status','Wiederholfall','Berechtigt','Eskalation','Bezug interner Prozessfehler','Erstellt am','Abgeschlossen am'];
  const csv = [header.join(';')].concat(rows.map(r => [r.id, r.case_type, r.title, r.source_area || '', r.service_advisor || '', r.mechanic_code || '', r.category || '', r.priority, r.status, r.repeat_case ? 'ja' : 'nein', r.complaint_validity || '', r.escalation_level || '', r.linked_internal_process ? 'ja' : 'nein', new Date(r.created_at).toLocaleString('de-DE'), r.closed_at ? new Date(r.closed_at).toLocaleString('de-DE') : ''].map(v => '"'+String(v).replaceAll('"','""')+'"').join(';'))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="qm-monitor-auswertung.csv"');
  res.send('\ufeff' + csv);
});


app.get('/api/analytics/report.pdf', authRequired, roleRequired('teamleader', 'admin'), async (_req, res) => {
  const rows = (await pool.query(`SELECT id, case_type, title, source_area, service_advisor, mechanic_code, category, priority, status, repeat_case, complaint_validity, escalation_level, linked_internal_process, created_at, closed_at FROM cases ORDER BY created_at DESC`)).rows;
  const analytics = await fetchAnalyticsData();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="qm-monitor-auswertung.pdf"');
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);
  const line = (label, value='—') => { doc.font('Helvetica-Bold').text(label + ': ', { continued: true }); doc.font('Helvetica').text(String(value)); };
  const section = (title) => { doc.moveDown(); doc.fontSize(15).font('Helvetica-Bold').text(title); doc.moveDown(0.4); doc.fontSize(10).font('Helvetica'); };
  doc.fontSize(22).font('Helvetica-Bold').text('QM Monitor Auswertung');
  doc.fontSize(10).font('Helvetica').fillColor('#475569').text(`Erstellt am ${new Date().toLocaleString('de-DE')}`).fillColor('black');
  section('Übersicht');
  line('Reklamationen', analytics.totals.complaints); line('Interne Prozessfehler', analytics.totals.internal); line('Wiederholfälle', analytics.totals.repeat); line('Überfällige Fälle', analytics.totals.overdue);
  section('Monate');
  Object.entries(analytics.byMonth).forEach(([k,v])=> line(k, `Reklamationen ${v.complaints} | Prozessfehler ${v.internal}`));
  section('Quartale');
  Object.entries(analytics.byQuarter).forEach(([k,v])=> line(k, `Reklamationen ${v.complaints} | Prozessfehler ${v.internal}`));
  section('Bereiche Reklamationen'); Object.entries(analytics.byArea.customer_complaint).forEach(([k,v])=> line(k,v));
  section('Bereiche Prozessfehler'); Object.entries(analytics.byArea.internal_process).forEach(([k,v])=> line(k,v));
  section('Mechaniker'); Object.entries(analytics.byMechanic).forEach(([k,v])=> line(k, `R ${v.complaints} | P ${v.internal} | offen ${v.open} | abgeschlossen ${v.closed}`));
  section('Serviceberater'); Object.entries(analytics.byServiceAdvisor).forEach(([k,v])=> line(k, `R ${v.complaints} | P ${v.internal} | offen ${v.open} | abgeschlossen ${v.closed}`));
  section('Qualitätsindikatoren'); Object.entries(analytics.validity).forEach(([k,v])=> line(`Berechtigt ${k}`, v)); Object.entries(analytics.escalation).forEach(([k,v])=> line(`Eskalation ${k}`, v)); Object.entries(analytics.linked).forEach(([k,v])=> line(`Bezug ${k}`, v));
  section('Aktuelle Fälle');
  rows.slice(0, 25).forEach((r)=> { if (doc.y > 760) doc.addPage(); doc.font('Helvetica-Bold').text(`#${r.id} ${r.title}`); doc.font('Helvetica').text(`${r.case_type === 'customer_complaint' ? 'Kundenreklamation' : 'Interner Prozessfehler'} | Bereich ${r.source_area || '—'} | SB ${r.service_advisor || '—'} | Mechaniker ${r.mechanic_code || '—'} | Prio ${r.priority} | Status ${r.status}`); doc.moveDown(0.3); });
  doc.end();
});

app.post('/api/admin/send-weekly-summary-now', authRequired, roleRequired('admin'), async (_req, res) => {
  await sendWeeklySummaries();
  res.json({ ok: true });
});

app.get('*', (_req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

initDb().then(() => {
  maybeStartCrons();
  app.listen(PORT, () => console.log(`${APP_NAME} läuft auf Port ${PORT}`));
}).catch((error) => {
  console.error('Fehler beim Initialisieren:', error);
  process.exit(1);
});

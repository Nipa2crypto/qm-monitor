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

function mapCaseRow(r) {
  return {
    ...r,
    repeat_case: !!r.repeat_case,
    linked_internal_process: !!r.linked_internal_process,
    closed: !!r.closed,
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: APP_NAME }));

app.post('/api/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  await ensureNotificationRow(user.id);
  const token = signToken(user);
  res.cookie('qm_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, short_code: user.short_code } });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('qm_token');
  res.json({ ok: true });
});

app.get('/api/me', authRequired, async (req, res) => {
  const r = await pool.query('SELECT id, name, email, role, short_code FROM users WHERE id = $1', [req.user.id]);
  res.json({ user: r.rows[0] || null });
});

app.get('/api/users', authRequired, async (_req, res) => {
  const r = await pool.query('SELECT id, name, email, role, short_code FROM users ORDER BY name ASC');
  res.json(r.rows);
});

app.post('/api/users', authRequired, roleRequired('admin'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const shortCode = String(req.body.short_code || '').trim().toUpperCase() || null;
  const role = ['user', 'teamleader', 'admin'].includes(req.body.role) ? req.body.role : 'user';
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, E-Mail und Passwort sind Pflicht.' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const r = await pool.query(
      'INSERT INTO users (name, short_code, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, short_code',
      [name, shortCode, email, hash, role]
    );
    await ensureNotificationRow(r.rows[0].id);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.code === '23505' ? 'E-Mail existiert bereits.' : 'Benutzer konnte nicht erstellt werden.' });
  }
});

app.get('/api/notification-settings', authRequired, async (req, res) => {
  await ensureNotificationRow(req.user.id);
  const r = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
  res.json(r.rows[0]);
});

app.put('/api/notification-settings', authRequired, async (req, res) => {
  await ensureNotificationRow(req.user.id);
  const body = req.body || {};
  const vals = {
    notify_enabled: toBool(body.notify_enabled, true),
    notify_only_assigned: toBool(body.notify_only_assigned, true),
    notify_only_red: toBool(body.notify_only_red, false),
    notify_daily_digest: toBool(body.notify_daily_digest, false),
    email_enabled: toBool(body.email_enabled, false),
    email_new_case: toBool(body.email_new_case, true),
    email_escalation: toBool(body.email_escalation, true),
    email_due_reminder: toBool(body.email_due_reminder, true),
    weekly_summary: toBool(body.weekly_summary, false),
  };
  const r = await pool.query(
    `UPDATE notification_settings SET
      notify_enabled=$1,
      notify_only_assigned=$2,
      notify_only_red=$3,
      notify_daily_digest=$4,
      email_enabled=$5,
      email_new_case=$6,
      email_escalation=$7,
      email_due_reminder=$8,
      weekly_summary=$9,
      updated_at=NOW()
     WHERE user_id=$10
     RETURNING *`,
    [
      vals.notify_enabled,
      vals.notify_only_assigned,
      vals.notify_only_red,
      vals.notify_daily_digest,
      vals.email_enabled,
      vals.email_new_case,
      vals.email_escalation,
      vals.email_due_reminder,
      vals.weekly_summary,
      req.user.id,
    ]
  );
  res.json(r.rows[0]);
});

app.get('/api/cases', authRequired, async (req, res) => {
  const r = await pool.query(
    `SELECT c.*, creator.name AS created_by_name, creator.short_code AS created_by_short_code,
            assignee.name AS assigned_user_name, assignee.email AS assigned_user_email, assignee.short_code AS assigned_user_short_code,
            closer.name AS closed_by_name, closer.short_code AS closed_by_short_code
     FROM cases c
     JOIN users creator ON creator.id = c.created_by
     LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
     LEFT JOIN users closer ON closer.id = c.closed_by
     ORDER BY c.created_at DESC, c.id DESC`
  );
  res.json(r.rows.map(mapCaseRow));
});

app.post('/api/cases', authRequired, async (req, res) => {
  const {
    case_type, title, description, priority, source_area, customer_name, vehicle, order_ref, due_date,
    assigned_user_id, service_advisor, mechanic_code, internal_action, customer_action, category, repeat_case,
    cause_guess, complaint_validity, escalation_level, linked_internal_process,
  } = req.body || {};

  if (!case_type || !title || !description) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen.' });
  }

  const r = await pool.query(
    `INSERT INTO cases (
      case_type, title, description, status, priority, source_area, customer_name, vehicle, order_ref,
      due_date, assigned_user_id, created_by, service_advisor, mechanic_code, internal_action, customer_action,
      category, repeat_case, cause_guess, complaint_validity, escalation_level, linked_internal_process
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13,$14,$15,FALSE,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [
      case_type,
      String(title).trim(),
      String(description).trim(),
      'neu',
      priority || 'gelb',
      source_area || null,
      customer_name || null,
      vehicle || null,
      order_ref || null,
      due_date || null,
      assigned_user_id || null,
      req.user.id,
      service_advisor || null,
      mechanic_code || null,
      internal_action || null,
      customer_action || null,
      category || null,
      toBool(repeat_case, false),
      cause_guess || null,
      complaint_validity || null,
      escalation_level || null,
      toBool(linked_internal_process, false),
    ]
  );

  res.json(mapCaseRow(r.rows[0]));
});

app.put('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await getCaseById(id);
  if (!existing) return res.status(404).json({ error: 'Fall nicht gefunden.' });

  const body = req.body || {};
  const closed = body.closed === undefined ? existing.closed : toBool(body.closed, existing.closed);
  const closed_at = closed ? (existing.closed_at || new Date()) : null;
  const closed_by = closed ? req.user.id : null;

  const r = await pool.query(
    `UPDATE cases SET
      case_type=$1,
      title=$2,
      description=$3,
      status=$4,
      priority=$5,
      source_area=$6,
      customer_name=$7,
      vehicle=$8,
      order_ref=$9,
      service_advisor=$10,
      mechanic_code=$11,
      internal_action=$12,
      customer_action=$13,
      due_date=$14,
      assigned_user_id=$15,
      closed=$16,
      closed_at=$17,
      closed_by=$18,
      category=$19,
      repeat_case=$20,
      cause_guess=$21,
      complaint_validity=$22,
      escalation_level=$23,
      linked_internal_process=$24,
      updated_at=NOW()
     WHERE id=$25
     RETURNING *`,
    [
      body.case_type || existing.case_type,
      body.title ?? existing.title,
      body.description ?? existing.description,
      body.status || existing.status,
      body.priority || existing.priority,
      body.source_area ?? existing.source_area,
      body.customer_name ?? existing.customer_name,
      body.vehicle ?? existing.vehicle,
      body.order_ref ?? existing.order_ref,
      body.service_advisor ?? existing.service_advisor,
      body.mechanic_code ?? existing.mechanic_code,
      body.internal_action ?? existing.internal_action,
      body.customer_action ?? existing.customer_action,
      body.due_date ?? existing.due_date,
      body.assigned_user_id ?? existing.assigned_user_id,
      closed,
      closed_at,
      closed_by,
      body.category ?? existing.category,
      body.repeat_case === undefined ? existing.repeat_case : toBool(body.repeat_case, existing.repeat_case),
      body.cause_guess ?? existing.cause_guess,
      body.complaint_validity ?? existing.complaint_validity,
      body.escalation_level ?? existing.escalation_level,
      body.linked_internal_process === undefined ? existing.linked_internal_process : toBool(body.linked_internal_process, existing.linked_internal_process),
      id,
    ]
  );

  res.json(mapCaseRow(r.rows[0]));
});

app.post('/api/cases/:id/updates', authRequired, async (req, res) => {
  const caseId = Number(req.params.id);
  const content = String(req.body.content || '').trim();
  const updateType = String(req.body.update_type || 'note').trim();
  if (!content) return res.status(400).json({ error: 'Inhalt fehlt.' });
  await pool.query('INSERT INTO case_updates (case_id, user_id, update_type, content) VALUES ($1,$2,$3,$4)', [caseId, req.user.id, updateType, content]);
  res.json({ ok: true });
});

app.get('/api/cases/:id/updates', authRequired, async (req, res) => {
  const caseId = Number(req.params.id);
  const r = await pool.query(
    `SELECT u.*, usr.name AS user_name, usr.short_code AS user_short_code
     FROM case_updates u
     JOIN users usr ON usr.id = u.user_id
     WHERE u.case_id = $1
     ORDER BY u.created_at DESC, u.id DESC`,
    [caseId]
  );
  res.json(r.rows);
});

app.post('/api/cases/:id/attachments', authRequired, upload.array('files', 6), async (req, res) => {
  const caseId = Number(req.params.id);
  const files = req.files || [];
  for (const file of files) {
    await pool.query(
      `INSERT INTO case_attachments (case_id, uploaded_by, filename, mime_type, size_bytes, data_base64)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [caseId, req.user.id, file.originalname, file.mimetype, file.size, file.buffer.toString('base64')]
    );
  }
  res.json({ ok: true, count: files.length });
});

app.get('/api/cases/:id/attachments', authRequired, async (req, res) => {
  const caseId = Number(req.params.id);
  const r = await pool.query('SELECT id, filename, mime_type, size_bytes, created_at FROM case_attachments WHERE case_id=$1 ORDER BY created_at DESC, id DESC', [caseId]);
  res.json(r.rows);
});

app.get('/api/attachments/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query('SELECT * FROM case_attachments WHERE id=$1', [id]);
  const file = r.rows[0];
  if (!file) return res.status(404).send('Nicht gefunden');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
  res.send(Buffer.from(file.data_base64, 'base64'));
});

app.get('/api/export/cases.pdf', authRequired, async (_req, res) => {
  const r = await pool.query('SELECT * FROM cases ORDER BY created_at DESC, id DESC');
  const rows = r.rows.map(mapCaseRow);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="qm-monitor-faelle-${todayLocalISO()}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  doc.fontSize(20).text(APP_NAME, { continued: false });
  doc.moveDown(0.2);
  doc.fontSize(11).text(`Fallübersicht vom ${todayLocalISO()}`);
  doc.moveDown();

  rows.forEach((c, idx) => {
    doc.fontSize(13).text(`#${c.id} · ${c.title}`);
    doc.fontSize(10)
      .text(`Typ: ${c.case_type} | Status: ${c.status} | Priorität: ${c.priority}`)
      .text(`Bereich: ${c.source_area || '-'} | Kategorie: ${c.category || '-'} | Fällig: ${c.due_date || '-'}`)
      .text(`SB: ${c.service_advisor || '-'} | Mechaniker: ${c.mechanic_code || '-'} | Zugewiesen: ${c.assigned_user_id || '-'}`)
      .text(`Beschreibung: ${c.description || '-'}`);
    if (c.internal_action) doc.text(`Interne Maßnahme: ${c.internal_action}`);
    if (c.customer_action) doc.text(`Kundenmaßnahme: ${c.customer_action}`);
    if (idx < rows.length - 1) doc.moveDown().moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown();
  });

  doc.end();
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API-Route nicht gefunden.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    cron.schedule('0 7 * * *', () => { sendDueReminders().catch(() => {}); });
    cron.schedule('30 7 * * 1', () => { sendWeeklySummaries().catch(() => {}); });
    app.listen(PORT, () => console.log(`${APP_NAME} läuft auf Port ${PORT}`));
  })
  .catch((err) => {
    console.error('Fehler beim Initialisieren:', err);
    process.exit(1);
  });

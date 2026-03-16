require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ? String(process.env.ADMIN_EMAIL).trim().toLowerCase() : '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : '';
const APP_NAME = process.env.APP_NAME || 'QM Monitor';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL fehlt. Bitte als Env-Variable setzen.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

async function initDb() {
  const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
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
    due_date DATE,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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

  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  CREATE INDEX IF NOT EXISTS idx_cases_priority ON cases(priority);
  CREATE INDEX IF NOT EXISTS idx_cases_assigned_user_id ON cases(assigned_user_id);
  CREATE INDEX IF NOT EXISTS idx_case_updates_case_id ON case_updates(case_id);
  `;

  await pool.query(schema);

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    console.log(`[init] Admin-Seeding gestartet für ${ADMIN_EMAIL}`);
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         role = 'admin'
       RETURNING id, email`,
      ['Admin', ADMIN_EMAIL, hash]
    );

    await pool.query(
      `INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [result.rows[0].id]
    );
    console.log(`[init] Admin-User aktiv: ${result.rows[0].email} (id=${result.rows[0].id})`);
  } else {
    console.warn('[init] ADMIN_EMAIL oder ADMIN_PASSWORD fehlt - kein Admin-Seeding ausgeführt.');
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authRequired(req, res, next) {
  const token = req.cookies.qm_token;
  if (!token) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session ungültig.' });
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Adminrechte erforderlich.' });
  next();
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, app: APP_NAME });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'DB nicht erreichbar' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich.' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedPassword = String(password);

  const result = await pool.query(
    'SELECT id, name, email, password_hash, role FROM users WHERE email = $1',
    [normalizedEmail]
  );

  if (result.rowCount === 0) {
    console.warn(`[login] Benutzer nicht gefunden: ${normalizedEmail}`);
    return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  }
  const user = result.rows[0];
  const ok = await bcrypt.compare(normalizedPassword, user.password_hash);
  if (!ok) {
    console.warn(`[login] Passwort falsch für: ${normalizedEmail}`);
    return res.status(401).json({ error: 'Login fehlgeschlagen.' });
  }

  console.log(`[login] Erfolgreich: ${normalizedEmail}`);
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
  const users = await pool.query("SELECT id, email, role, created_at FROM users ORDER BY id ASC");
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
  const result = await pool.query('SELECT id, name, email, role FROM users ORDER BY name ASC');
  res.json(result.rows);
});

app.post('/api/users', authRequired, adminRequired, async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, E-Mail und Passwort sind erforderlich.' });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const created = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, role`,
      [name, String(email).toLowerCase(), hash, role || 'user']
    );
    await pool.query(
      'INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [created.rows[0].id]
    );
    res.status(201).json(created.rows[0]);
  } catch (error) {
    if (String(error.message).includes('duplicate')) {
      return res.status(409).json({ error: 'E-Mail existiert bereits.' });
    }
    throw error;
  }
});

app.get('/api/settings', authRequired, async (req, res) => {
  const result = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
  if (result.rowCount === 0) {
    await pool.query('INSERT INTO notification_settings (user_id) VALUES ($1)', [req.user.id]);
    const retry = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
    return res.json(retry.rows[0]);
  }
  res.json(result.rows[0]);
});

app.patch('/api/settings', authRequired, async (req, res) => {
  const { notify_enabled, notify_only_assigned, notify_only_red, notify_daily_digest } = req.body || {};
  await pool.query(
    `INSERT INTO notification_settings (user_id, notify_enabled, notify_only_assigned, notify_only_red, notify_daily_digest, updated_at)
     VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, FALSE), COALESCE($5, FALSE), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       notify_enabled = COALESCE($2, notification_settings.notify_enabled),
       notify_only_assigned = COALESCE($3, notification_settings.notify_only_assigned),
       notify_only_red = COALESCE($4, notification_settings.notify_only_red),
       notify_daily_digest = COALESCE($5, notification_settings.notify_daily_digest),
       updated_at = NOW()
     RETURNING *`,
    [req.user.id, notify_enabled, notify_only_assigned, notify_only_red, notify_daily_digest]
  );
  const result = await pool.query('SELECT * FROM notification_settings WHERE user_id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

app.get('/api/cases', authRequired, async (req, res) => {
  const { status, priority, type, mine } = req.query;
  const params = [];
  const where = [];

  if (status && status !== 'all') {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (priority && priority !== 'all') {
    params.push(priority);
    where.push(`c.priority = $${params.length}`);
  }
  if (type && type !== 'all') {
    params.push(type);
    where.push(`c.case_type = $${params.length}`);
  }
  if (mine === '1') {
    params.push(req.user.id);
    where.push(`c.assigned_user_id = $${params.length}`);
  }

  const sql = `
    SELECT c.*, 
      creator.name AS created_by_name,
      assignee.name AS assigned_user_name,
      COUNT(u.id)::int AS update_count
    FROM cases c
    JOIN users creator ON creator.id = c.created_by
    LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
    LEFT JOIN case_updates u ON u.case_id = c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY c.id, creator.name, assignee.name
    ORDER BY c.updated_at DESC, c.id DESC
  `;

  const result = await pool.query(sql, params);
  res.json(result.rows);
});

app.get('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const caseResult = await pool.query(
    `SELECT c.*, creator.name AS created_by_name, assignee.name AS assigned_user_name
     FROM cases c
     JOIN users creator ON creator.id = c.created_by
     LEFT JOIN users assignee ON assignee.id = c.assigned_user_id
     WHERE c.id = $1`,
    [id]
  );
  if (caseResult.rowCount === 0) return res.status(404).json({ error: 'Fall nicht gefunden.' });

  const updates = await pool.query(
    `SELECT cu.*, u.name AS user_name
     FROM case_updates cu
     JOIN users u ON u.id = cu.user_id
     WHERE cu.case_id = $1
     ORDER BY cu.created_at ASC, cu.id ASC`,
    [id]
  );

  res.json({ ...caseResult.rows[0], updates: updates.rows });
});

app.post('/api/cases', authRequired, async (req, res) => {
  const {
    case_type,
    title,
    description,
    priority,
    source_area,
    customer_name,
    vehicle,
    order_ref,
    due_date,
    assigned_user_id,
  } = req.body || {};

  if (!case_type || !title || !description) {
    return res.status(400).json({ error: 'Falltyp, Titel und Beschreibung sind Pflichtfelder.' });
  }

  const created = await pool.query(
    `INSERT INTO cases (
      case_type, title, description, priority, source_area, customer_name,
      vehicle, order_ref, due_date, assigned_user_id, created_by, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    RETURNING *`,
    [
      case_type,
      title,
      description,
      priority || 'gelb',
      source_area || null,
      customer_name || null,
      vehicle || null,
      order_ref || null,
      due_date || null,
      assigned_user_id || null,
      req.user.id,
    ]
  );

  await pool.query(
    `INSERT INTO case_updates (case_id, user_id, update_type, content)
     VALUES ($1, $2, 'system', $3)`,
    [created.rows[0].id, req.user.id, `Fall angelegt durch ${req.user.name}`]
  );

  res.status(201).json(created.rows[0]);
});

app.patch('/api/cases/:id', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['status', 'priority', 'assigned_user_id', 'due_date', 'source_area'];
  const payload = req.body || {};
  const keys = Object.keys(payload).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'Keine gültigen Felder zur Aktualisierung.' });

  const params = [];
  const sets = keys.map((key) => {
    params.push(payload[key] === '' ? null : payload[key]);
    return `${key} = $${params.length}`;
  });
  params.push(id);

  const result = await pool.query(
    `UPDATE cases SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );

  if (result.rowCount === 0) return res.status(404).json({ error: 'Fall nicht gefunden.' });
  res.json(result.rows[0]);
});

app.post('/api/cases/:id/updates', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  const { content, update_type } = req.body || {};
  if (!content) return res.status(400).json({ error: 'Inhalt erforderlich.' });

  const exists = await pool.query('SELECT id FROM cases WHERE id = $1', [id]);
  if (exists.rowCount === 0) return res.status(404).json({ error: 'Fall nicht gefunden.' });

  const created = await pool.query(
    `INSERT INTO case_updates (case_id, user_id, update_type, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.user.id, update_type || 'note', content]
  );
  await pool.query('UPDATE cases SET updated_at = NOW() WHERE id = $1', [id]);
  res.status(201).json(created.rows[0]);
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`${APP_NAME} läuft auf Port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Fehler beim Initialisieren:', error);
    process.exit(1);
  });

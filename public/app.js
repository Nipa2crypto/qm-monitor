const state = {
  me: null,
  users: [],
  cases: [],
  currentCase: null,
  mineOnly: false,
};

const views = ['dashboard', 'cases', 'newCase', 'settings', 'caseDetail'];

const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const escapeHtml = (str = '') => String(str)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('de-DE');
}
function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('de-DE');
}
function typeLabel(type) {
  return type === 'customer_complaint' ? 'Kundenreklamation' : 'Interner Prozessfehler';
}
function updateTypeLabel(type) {
  const map = {
    note: 'Notiz',
    internal_action: 'Maßnahme intern',
    customer_action: 'Kundenzufriedenheit',
    escalation: 'Eskalation',
    status: 'Status',
    system: 'System',
  };
  return map[type] || type || 'Notiz';
}
function badgeClass(value) {
  return String(value || '').toLowerCase().replaceAll(' ', '-').replaceAll('ü', 'ue');
}
function setNotice(id, msg, ok = false) {
  const el = qs(`#${id}`);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('ok', !!ok);
}

async function api(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    credentials: 'include',
    headers,
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler');
  return data;
}

function showView(name) {
  views.forEach((view) => {
    qs(`#${view}View`)?.classList.toggle('hidden', view !== name);
    qsa('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  });
}

function getUserLabel(user) {
  if (!user) return 'offen';
  return `${user.name}${user.short_code ? ` (${user.short_code})` : ''}`;
}

async function bootstrap() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }
  qsa('.nav-btn').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
  qsa('[data-jump]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.jump)));
  qs('#backToCasesBtn').addEventListener('click', () => showView('cases'));
  try {
    state.me = await api('/api/me');
    await loadUsers();
    await loadCases();
    applyAuthState(true);
    fillUserSelects();
    loadSettingsIntoForm();
    renderDashboard();
    renderCases();
    const caseParam = new URLSearchParams(window.location.search).get('case');
    if (caseParam) openCase(Number(caseParam));
  } catch {
    applyAuthState(false);
  }
}

function applyAuthState(isLoggedIn) {
  qs('#authView').classList.toggle('hidden', isLoggedIn);
  qs('#appView').classList.toggle('hidden', !isLoggedIn);
  if (isLoggedIn) {
    qs('#meName').textContent = state.me.name;
    qs('#meRole').textContent = `${state.me.role} • ${state.me.email}`;
    qs('#adminUserPanel').classList.toggle('hidden', state.me.role !== 'admin');
    showView('dashboard');
  }
}

async function loadUsers() {
  state.users = await api('/api/users');
}

function fillUserSelects() {
  const options = ['<option value="">Noch offen</option>']
    .concat(state.users.map((u) => `<option value="${u.id}">${escapeHtml(getUserLabel(u))}</option>`))
    .join('');
  qs('#assignedUserSelect').innerHTML = options;
  qs('#detailAssignedUser').innerHTML = options;
}

async function loadCases() {
  const params = new URLSearchParams();
  const status = qs('#filterStatus')?.value || 'all';
  const priority = qs('#filterPriority')?.value || 'all';
  const type = qs('#filterType')?.value || 'all';
  if (status !== 'all') params.set('status', status);
  if (priority !== 'all') params.set('priority', priority);
  if (type !== 'all') params.set('type', type);
  if (state.mineOnly) params.set('mine', '1');
  state.cases = await api(`/api/cases?${params.toString()}`);
}

function renderDashboard() {
  const openCases = state.cases.filter((c) => c.status !== 'abgeschlossen' && !c.closed);
  const redCases = state.cases.filter((c) => c.priority === 'rot' && !c.closed);
  const myCases = state.cases.filter((c) => Number(c.assigned_user_id) === Number(state.me.id) && !c.closed);
  const today = new Date().toISOString().slice(0, 10);
  const overdue = state.cases.filter((c) => c.due_date && c.due_date < today && c.status !== 'abgeschlossen');

  qs('#kpiOpen').textContent = openCases.length;
  qs('#kpiRed').textContent = redCases.length;
  qs('#kpiMine').textContent = myCases.length;
  qs('#kpiOverdue').textContent = overdue.length;

  const rows = state.cases.slice(0, 8).map((c) => `
    <button class="board-row" onclick="openCase(${c.id})" type="button">
      <span>${escapeHtml(typeLabel(c.case_type))}</span>
      <span class="board-title-cell"><strong>${escapeHtml(c.title)}</strong></span>
      <span>${escapeHtml(c.assigned_user_name ? `${c.assigned_user_name}${c.assigned_user_short_code ? ` (${c.assigned_user_short_code})` : ''}` : 'offen')}</span>
      <span>${escapeHtml(c.source_area || '—')}</span>
      <span>${escapeHtml(c.mechanic_code || '—')}</span>
      <span><span class="badge ${badgeClass(c.priority)}">${escapeHtml(c.priority)}</span></span>
    </button>`).join('');

  qs('#dashboardCases').innerHTML = `
    <div class="board-head">
      <span>Falltyp</span>
      <span>Titel</span>
      <span>Zuständigkeit</span>
      <span>Bereich</span>
      <span>Mechaniker</span>
      <span>Priorität</span>
    </div>
    ${rows || '<div class="empty">Noch keine Fälle vorhanden.</div>'}`;

  const hints = [];
  if (redCases.length) hints.push(`Es gibt ${redCases.length} Rot-Fälle.`);
  if (overdue.length) hints.push(`${overdue.length} Fälle sind überfällig.`);
  if (state.cases.some((c) => c.closed)) hints.push(`${state.cases.filter((c) => c.closed).length} Fälle sind bereits abgeschlossen.`);
  if (!hints.length) hints.push('Keine kritischen Hinweise.');
  qs('#dashboardHints').innerHTML = hints.map((h) => `<div class="timeline-item">${escapeHtml(h)}</div>`).join('');
}

function renderCases() {
  const tbody = qs('#casesTableBody');
  tbody.innerHTML = state.cases.length ? state.cases.map((c) => `
    <tr>
      <td>#${c.id}</td>
      <td><strong>${escapeHtml(c.title)}</strong><div class="meta">${escapeHtml(c.source_area || '—')}</div></td>
      <td>${escapeHtml(typeLabel(c.case_type))}</td>
      <td><span class="badge ${badgeClass(c.priority)}">${escapeHtml(c.priority)}</span></td>
      <td><span class="badge ${badgeClass(c.status)}">${escapeHtml(c.status)}</span></td>
      <td>${escapeHtml(c.mechanic_code || '—')}</td>
      <td>${escapeHtml(c.assigned_user_name ? `${c.assigned_user_name}${c.assigned_user_short_code ? ` (${c.assigned_user_short_code})` : ''}` : 'offen')}</td>
      <td>${formatDate(c.due_date)}</td>
      <td><button class="btn-secondary small-btn" onclick="openCase(${c.id})">Öffnen</button></td>
    </tr>`).join('') : '<tr><td colspan="9"><div class="empty">Keine Fälle gefunden.</div></td></tr>';
}

async function openCase(id) {
  const c = await api(`/api/cases/${id}`);
  state.currentCase = c;
  qs('#detailTitle').textContent = `#${c.id} ${c.title}`;
  qs('#detailMeta').textContent = `${typeLabel(c.case_type)} • erstellt von ${c.created_by_name}${c.created_by_short_code ? ` (${c.created_by_short_code})` : ''} • ${formatDateTime(c.created_at)}`;

  const form = qs('#detailEditForm');
  form.status.value = c.status || 'neu';
  form.priority.value = c.priority || 'gelb';
  form.assigned_user_id.value = c.assigned_user_id || '';
  form.due_date.value = c.due_date ? c.due_date.slice(0, 10) : '';
  form.source_area.value = c.source_area || '';
  form.mechanic_code.value = c.mechanic_code || '';
  form.customer_name.value = c.customer_name || '';
  form.vehicle.value = c.vehicle || '';
  form.order_ref.value = c.order_ref || '';
  form.internal_action.value = c.internal_action || '';
  form.customer_action.value = c.customer_action || '';
  form.closed.checked = !!c.closed || c.status === 'abgeschlossen';

  qs('#detailSummary').innerHTML = `
    <div class="summary-item"><span class="summary-label">Beschreibung</span><div>${escapeHtml(c.description || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Kunde</span><div>${escapeHtml(c.customer_name || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Fahrzeug</span><div>${escapeHtml(c.vehicle || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Auftrag</span><div>${escapeHtml(c.order_ref || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Mechaniker</span><div>${escapeHtml(c.mechanic_code || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Maßnahme intern</span><div>${escapeHtml(c.internal_action || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Kundenzufriedenheit</span><div>${escapeHtml(c.customer_action || '—')}</div></div>
    <div class="summary-item"><span class="summary-label">Abgeschlossen</span><div>${c.closed ? `Ja • ${formatDateTime(c.closed_at)}${c.closed_by_name ? ` • ${escapeHtml(c.closed_by_name)}` : ''}` : 'Nein'}</div></div>
  `;

  qs('#detailTimeline').innerHTML = c.updates.length ? c.updates.map((u) => `
    <div class="timeline-item">
      <div class="space-between"><strong>${escapeHtml(u.user_name)}${u.user_short_code ? ` (${escapeHtml(u.user_short_code)})` : ''}</strong><span class="meta">${formatDateTime(u.created_at)}</span></div>
      <div class="meta">${escapeHtml(updateTypeLabel(u.update_type))}</div>
      <div class="preline">${escapeHtml(u.content)}</div>
    </div>`).join('') : '<div class="empty">Noch keine Einträge in der Chronik.</div>';

  qs('#attachmentList').innerHTML = c.attachments.length ? c.attachments.map((a) => `
    <a class="attachment-card" href="/api/attachments/${a.id}" target="_blank" rel="noopener">
      <div class="attachment-thumb">📷</div>
      <div class="attachment-info">
        <strong>${escapeHtml(a.filename)}</strong>
        <div class="meta">${Math.round(a.size_bytes / 1024)} KB • ${formatDateTime(a.created_at)}</div>
      </div>
    </a>`).join('') : '<div class="empty">Noch keine Bilder hochgeladen.</div>';

  showView('caseDetail');
  history.replaceState({}, '', `/?case=${c.id}`);
}
window.openCase = openCase;

function loadSettingsIntoForm() {
  const s = state.me.settings || {};
  const form = qs('#settingsForm');
  ['notify_enabled', 'notify_only_assigned', 'notify_only_red', 'notify_daily_digest', 'email_enabled', 'email_new_case', 'email_escalation', 'email_due_reminder', 'weekly_summary']
    .forEach((key) => { form[key].checked = !!s[key]; });
}

qs('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setNotice('loginError', '');
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: qs('#loginEmail').value, password: qs('#loginPassword').value }),
    });
    state.me = await api('/api/me');
    await loadUsers();
    await loadCases();
    fillUserSelects();
    applyAuthState(true);
    loadSettingsIntoForm();
    renderDashboard();
    renderCases();
  } catch (err) {
    setNotice('loginError', err.message);
  }
});

qs('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});

qs('#newCaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setNotice('newCaseError', '');
  const form = e.currentTarget;
  const formData = new FormData(form);
  const imageFiles = formData.getAll('images').filter((file) => file && file.size);
  const data = Object.fromEntries(formData.entries());
  delete data.images;
  try {
    const created = await api('/api/cases', { method: 'POST', body: JSON.stringify(data) });
    if (imageFiles.length) {
      const uploadData = new FormData();
      imageFiles.forEach((file) => uploadData.append('images', file));
      await api(`/api/cases/${created.id}/attachments`, { method: 'POST', body: uploadData });
    }
    form.reset();
    await loadCases();
    renderDashboard();
    renderCases();
    await openCase(created.id);
    setNotice('newCaseError', 'Fall gespeichert.', true);
  } catch (err) {
    setNotice('newCaseError', err.message);
  }
});

['#filterStatus', '#filterPriority', '#filterType'].forEach((sel) => qs(sel).addEventListener('change', async () => {
  await loadCases();
  renderDashboard();
  renderCases();
}));

qs('#filterMineBtn').addEventListener('click', async () => {
  state.mineOnly = !state.mineOnly;
  qs('#filterMineBtn').textContent = state.mineOnly ? 'Alle Fälle anzeigen' : 'Nur meine Fälle';
  await loadCases();
  renderDashboard();
  renderCases();
});

qs('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const settings = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        notify_enabled: form.notify_enabled.checked,
        notify_only_assigned: form.notify_only_assigned.checked,
        notify_only_red: form.notify_only_red.checked,
        notify_daily_digest: form.notify_daily_digest.checked,
        email_enabled: form.email_enabled.checked,
        email_new_case: form.email_new_case.checked,
        email_escalation: form.email_escalation.checked,
        email_due_reminder: form.email_due_reminder.checked,
        weekly_summary: form.weekly_summary.checked,
      }),
    });
    state.me.settings = settings;
    setNotice('settingsNotice', 'Einstellungen gespeichert.', true);
  } catch (err) {
    setNotice('settingsNotice', err.message);
  }
});

qs('#createUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(data) });
    setNotice('userCreateNotice', 'Benutzer angelegt.', true);
    e.currentTarget.reset();
    await loadUsers();
    fillUserSelects();
  } catch (err) {
    setNotice('userCreateNotice', err.message);
  }
});

qs('#sendWeeklyNowBtn')?.addEventListener('click', async () => {
  try {
    await api('/api/admin/send-weekly-summary-now', { method: 'POST' });
    setNotice('userCreateNotice', 'Wochenübersicht ausgelöst.', true);
  } catch (err) {
    setNotice('userCreateNotice', err.message);
  }
});

qs('#detailEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentCase) return;
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.closed = form.closed.checked;
  try {
    await api(`/api/cases/${state.currentCase.id}`, { method: 'PATCH', body: JSON.stringify(data) });
    setNotice('detailEditNotice', 'Fall aktualisiert.', true);
    await loadCases();
    await openCase(state.currentCase.id);
    renderDashboard();
    renderCases();
  } catch (err) {
    setNotice('detailEditNotice', err.message);
  }
});

qs('#detailUpdateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentCase) return;
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
  try {
    await api(`/api/cases/${state.currentCase.id}/updates`, { method: 'POST', body: JSON.stringify(data) });
    e.currentTarget.reset();
    setNotice('detailUpdateNotice', 'Eintrag hinzugefügt.', true);
    await loadCases();
    await openCase(state.currentCase.id);
    renderDashboard();
    renderCases();
  } catch (err) {
    setNotice('detailUpdateNotice', err.message);
  }
});

qs('#attachmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentCase) return;
  const input = qs('#attachmentInput');
  if (!input.files.length) {
    setNotice('attachmentNotice', 'Bitte mindestens ein Bild auswählen.');
    return;
  }
  const formData = new FormData();
  [...input.files].forEach((file) => formData.append('images', file));
  try {
    await api(`/api/cases/${state.currentCase.id}/attachments`, { method: 'POST', body: formData });
    input.value = '';
    setNotice('attachmentNotice', 'Bilder hochgeladen.', true);
    await loadCases();
    await openCase(state.currentCase.id);
    renderDashboard();
    renderCases();
  } catch (err) {
    setNotice('attachmentNotice', err.message);
  }
});

bootstrap();

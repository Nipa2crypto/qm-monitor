const state = {
  me: null,
  users: [],
  cases: [],
  currentCase: null,
  mineOnly: false,
};

const views = ['dashboard', 'cases', 'newCase', 'settings', 'caseDetail'];

function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return [...document.querySelectorAll(sel)]; }
function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString('de-DE');
}
function formatDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleString('de-DE');
}
function typeLabel(type) {
  return type === 'customer_complaint' ? 'Kundenreklamation' : 'Interner Prozessfehler';
}
function badgeClass(val) {
  return String(val || '').toLowerCase().replaceAll(' ', '-').replaceAll('ü', 'ue');
}
function setNotice(id, msg, ok = false) {
  const el = qs(`#${id}`);
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? '#86efac' : '#fca5a5';
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler');
  return data;
}

function showView(name) {
  views.forEach((v) => {
    qs(`#${v}View`)?.classList.toggle('hidden', v !== name);
    qsa('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
  });
}

async function bootstrap() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }

  try {
    state.me = await api('/api/me');
    await loadUsers();
    await loadCases();
    applyAuthState(true);
    fillUserSelects();
    loadSettingsIntoForm();
    renderDashboard();
    renderCases();
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
    .concat(state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`))
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
  const openCases = state.cases.filter((c) => c.status !== 'abgeschlossen');
  const redCases = state.cases.filter((c) => c.priority === 'rot');
  const myCases = state.cases.filter((c) => Number(c.assigned_user_id) === Number(state.me.id));
  const today = new Date().toISOString().slice(0, 10);
  const overdue = state.cases.filter((c) => c.due_date && c.due_date < today && c.status !== 'abgeschlossen');

  qs('#kpiOpen').textContent = openCases.length;
  qs('#kpiRed').textContent = redCases.length;
  qs('#kpiMine').textContent = myCases.length;
  qs('#kpiOverdue').textContent = overdue.length;

  const latest = state.cases.slice(0, 6);
  qs('#dashboardCases').innerHTML = latest.length ? latest.map((c) => `
    <div class="timeline-item">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
        <strong>#${c.id} ${escapeHtml(c.title)}</strong>
        <span class="badge ${badgeClass(c.priority)}">${escapeHtml(c.priority)}</span>
      </div>
      <div class="meta">${escapeHtml(typeLabel(c.case_type))} • ${escapeHtml(c.status)} • ${escapeHtml(c.assigned_user_name || 'offen')}</div>
      <div style="margin-top:10px;"><button class="btn-secondary" onclick="openCase(${c.id})">Öffnen</button></div>
    </div>
  `).join('') : '<div class="empty">Noch keine Fälle vorhanden.</div>';

  const hints = [];
  if (redCases.length) hints.push(`Es gibt ${redCases.length} Rot-Fälle.`);
  if (overdue.length) hints.push(`${overdue.length} Fälle sind überfällig.`);
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
      <td>${escapeHtml(c.assigned_user_name || 'offen')}</td>
      <td>${formatDate(c.due_date)}</td>
      <td><button class="btn-secondary" onclick="openCase(${c.id})">Öffnen</button></td>
    </tr>
  `).join('') : '<tr><td colspan="8"><div class="empty">Keine Fälle gefunden.</div></td></tr>';
}

async function openCase(id) {
  const c = await api(`/api/cases/${id}`);
  state.currentCase = c;
  qs('#detailTitle').textContent = `#${c.id} ${c.title}`;
  qs('#detailMeta').textContent = `${typeLabel(c.case_type)} • erstellt von ${c.created_by_name} • ${formatDateTime(c.created_at)}`;

  const editForm = qs('#detailEditForm');
  editForm.status.value = c.status;
  editForm.priority.value = c.priority;
  editForm.assigned_user_id.value = c.assigned_user_id || '';
  editForm.due_date.value = c.due_date ? c.due_date.slice(0, 10) : '';
  editForm.source_area.value = c.source_area || '';

  qs('#detailTimeline').innerHTML = c.updates.length ? c.updates.map((u) => `
    <div class="timeline-item">
      <div style="display:flex; justify-content:space-between; gap:10px;">
        <strong>${escapeHtml(u.user_name)}</strong>
        <span class="meta">${formatDateTime(u.created_at)}</span>
      </div>
      <div class="meta">${escapeHtml(u.update_type)}</div>
      <div style="margin-top:8px; white-space:pre-wrap;">${escapeHtml(u.content)}</div>
    </div>
  `).join('') : '<div class="empty">Noch keine Einträge in der Chronik.</div>';

  showView('caseDetail');
}
window.openCase = openCase;

function loadSettingsIntoForm() {
  const s = state.me.settings || {};
  const form = qs('#settingsForm');
  form.notify_enabled.checked = !!s.notify_enabled;
  form.notify_only_assigned.checked = !!s.notify_only_assigned;
  form.notify_only_red.checked = !!s.notify_only_red;
  form.notify_daily_digest.checked = !!s.notify_daily_digest;
}

qs('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setNotice('loginError', '');
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: qs('#loginEmail').value,
        password: qs('#loginPassword').value,
      }),
    });
    state.me = await api('/api/me');
    await loadUsers();
    await loadCases();
    fillUserSelects();
    applyAuthState(true);
    renderDashboard();
    renderCases();
    loadSettingsIntoForm();
  } catch (err) {
    setNotice('loginError', err.message);
  }
});

qs('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

qsa('.nav-btn').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));
qsa('[data-nav]').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.nav)));

qs('#newCaseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setNotice('newCaseError', '');
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await api('/api/cases', { method: 'POST', body: JSON.stringify(data) });
    form.reset();
    await loadCases();
    renderDashboard();
    renderCases();
    showView('cases');
  } catch (err) {
    setNotice('newCaseError', err.message);
  }
});

['#filterStatus', '#filterPriority', '#filterType'].forEach((id) => {
  qs(id).addEventListener('change', async () => {
    await loadCases();
    renderDashboard();
    renderCases();
  });
});

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
  try {
    const settings = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        notify_enabled: form.notify_enabled.checked,
        notify_only_assigned: form.notify_only_assigned.checked,
        notify_only_red: form.notify_only_red.checked,
        notify_daily_digest: form.notify_daily_digest.checked,
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

qs('#detailEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentCase) return;
  const data = Object.fromEntries(new FormData(e.currentTarget).entries());
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

bootstrap();

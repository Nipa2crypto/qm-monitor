
const state = { me:null, users:[], cases:[], currentCase:null, mineOnly:false, categories:null, analytics:null };
const views = ['dashboard','cases','newCase','analytics','settings','caseDetail'];
const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const escapeHtml = (str = '') => String(str).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#039;');
function formatDate(value){ if(!value) return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?value:d.toLocaleDateString('de-DE'); }
function formatDateTime(value){ if(!value) return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?value:d.toLocaleString('de-DE'); }
function typeLabel(type){ return type==='customer_complaint'?'Kundenreklamation':'Interner Prozessfehler'; }
function updateTypeLabel(type){ return ({note:'Notiz',internal_action:'Maßnahme intern',customer_action:'Kundenzufriedenheit',escalation:'Eskalation',status:'Status',system:'System'})[type]||type; }
function badgeClass(value){ return String(value||'').toLowerCase().replaceAll(' ','-').replaceAll('ü','ue'); }
function setNotice(id,msg,ok=false){ const el=qs('#'+id); if(!el) return; el.textContent=msg||''; el.classList.toggle('ok',!!ok); }
async function api(url, options={}){ const isForm=options.body instanceof FormData; const headers={...(options.headers||{})}; if(!isForm) headers['Content-Type']='application/json'; const res=await fetch(url,{credentials:'include',headers,...options}); if(res.status===204) return null; const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error||'Fehler'); return data; }
function showView(name){ views.forEach(v=>{ qs('#'+v+'View')?.classList.toggle('hidden', v!==name); qsa('.nav-btn').forEach(btn=>btn.classList.toggle('active', btn.dataset.view===name)); }); if(name==='analytics' && !state.analytics) loadAnalytics(); }
function getUserLabel(user){ if(!user) return 'offen'; return `${user.name}${user.short_code?` (${user.short_code})`:''}`; }
function quarterLabel(monthKey){ const [y,m]=monthKey.split('-').map(Number); return `${y}-Q${Math.floor((m-1)/3)+1}`; }
async function bootstrap(){ if('serviceWorker' in navigator){ try{ await navigator.serviceWorker.register('/sw.js'); }catch{} }
  qsa('.nav-btn').forEach(btn=>btn.addEventListener('click', ()=>showView(btn.dataset.view)));
  qsa('[data-jump]').forEach(btn=>btn.addEventListener('click', ()=>showView(btn.dataset.jump)));
  qs('#backToCasesBtn').addEventListener('click', ()=>showView('cases'));
  try{ state.me=await api('/api/me'); await loadUsers(); state.categories=await api('/api/categories'); fillCategorySelects(); await loadCases(); applyAuthState(true); fillUserSelects(); loadSettingsIntoForm(); renderDashboard(); renderCases(); const caseParam=new URLSearchParams(window.location.search).get('case'); if(caseParam) openCase(Number(caseParam)); }catch{ applyAuthState(false); }
}
function applyAuthState(isLoggedIn){ qs('#authView').classList.toggle('hidden',isLoggedIn); qs('#appView').classList.toggle('hidden',!isLoggedIn); if(isLoggedIn){ qs('#meName').textContent=state.me.name; qs('#meRole').textContent=`${state.me.role} • ${state.me.email}`; const canStats=['teamleader','admin'].includes(state.me.role); qs('#analyticsNavBtn').classList.toggle('hidden', !canStats); qs('#adminUserPanel').classList.toggle('hidden', state.me.role!=='admin'); showView('dashboard'); } }
async function loadUsers(){ state.users=await api('/api/users'); }
function fillUserSelects(){ const options=['<option value="">Noch offen</option>'].concat(state.users.map(u=>`<option value="${u.id}">${escapeHtml(getUserLabel(u))}</option>`)).join(''); qs('#assignedUserSelect').innerHTML=options; qs('#detailAssignedUser').innerHTML=options; }
function fillCategorySelects(){ if(!state.categories) return; const type = qs('#newCaseType')?.value || 'customer_complaint'; const arr = type==='internal_process'?state.categories.internal:state.categories.customer; const opts = ['<option value="">Bitte wählen</option>'].concat(arr.map(x=>`<option>${escapeHtml(x)}</option>`)).join(''); qs('#newCategorySelect').innerHTML=opts; }
function fillDetailCategorySelect(caseType){ const arr = caseType==='internal_process'?state.categories.internal:state.categories.customer; qs('#detailCategorySelect').innerHTML=['<option value="">Bitte wählen</option>'].concat(arr.map(x=>`<option>${escapeHtml(x)}</option>`)).join(''); }
async function loadCases(){ const params=new URLSearchParams(); const status=qs('#filterStatus')?.value||'all'; const priority=qs('#filterPriority')?.value||'all'; const type=qs('#filterType')?.value||'all'; if(status!=='all') params.set('status',status); if(priority!=='all') params.set('priority',priority); if(type!=='all') params.set('type',type); if(state.mineOnly) params.set('mine','1'); state.cases=await api(`/api/cases?${params.toString()}`); }
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
      <span data-label="Falltyp">${escapeHtml(typeLabel(c.case_type))}</span>
      <span data-label="Titel" class="board-title-cell"><strong>${escapeHtml(c.title)}</strong></span>
      <span data-label="Zuständigkeit">${escapeHtml(c.assigned_user_name ? `${c.assigned_user_name}${c.assigned_user_short_code ? ` (${c.assigned_user_short_code})` : ''}` : 'offen')}</span>
      <span data-label="Bereich">${escapeHtml(c.source_area || '—')}</span>
      <span data-label="SB">${escapeHtml(serviceAdvisorLabel(c.service_advisor))}</span>
      <span data-label="Mechaniker">${escapeHtml(c.mechanic_code || '—')}</span>
      <span data-label="Priorität"><span class="badge ${badgeClass(c.priority)}">${escapeHtml(c.priority)}</span></span>
    </button>`).join('');

  qs('#dashboardCases').innerHTML = `<div class="board-head"><span>Falltyp</span><span>Titel</span><span>Zuständigkeit</span><span>Bereich</span><span>SB</span><span>Mechaniker</span><span>Priorität</span></div>${rows || '<div class="empty">Noch keine Fälle vorhanden.</div>'}`;
  const hints = [];
  if (redCases.length) hints.push(`Es gibt ${redCases.length} Rot-Fälle.`);
  if (overdue.length) hints.push(`${overdue.length} Fälle sind überfällig.`);
  if (state.cases.filter((c) => c.case_type === 'internal_process').length && state.cases.filter((c) => c.case_type === 'customer_complaint').length) hints.push('Interne Prozessfehler und Reklamationen können in den Auswertungen gemeinsam betrachtet werden.');
  if (!hints.length) hints.push('Keine kritischen Hinweise.');
  qs('#dashboardHints').innerHTML = hints.map((h) => `<div class="timeline-item">${escapeHtml(h)}</div>`).join('');
}

function renderCases() {
  const tbody = qs('#casesTableBody');
  tbody.innerHTML = state.cases.length ? state.cases.map((c) => `
    <tr>
      <td>${escapeHtml(typeLabel(c.case_type))}</td>
      <td><strong>${escapeHtml(c.title)}</strong></td>
      <td>${escapeHtml(c.assigned_user_name ? `${c.assigned_user_name}${c.assigned_user_short_code ? ` (${c.assigned_user_short_code})` : ''}` : 'offen')}</td>
      <td>${escapeHtml(c.source_area || '—')}</td>
      <td>${escapeHtml(serviceAdvisorLabel(c.service_advisor))}</td>
      <td>${escapeHtml(c.mechanic_code || '—')}</td>
      <td><span class="badge ${badgeClass(c.priority)}">${escapeHtml(c.priority)}</span></td>
      <td><button class="btn-secondary small-btn" onclick="openCase(${c.id})">Öffnen</button></td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty">Keine Fälle gefunden.</div></td></tr>';
}

async function openCase(id){ const c=await api(`/api/cases/${id}`); state.currentCase=c; qs('#detailTitle').textContent=`#${c.id} ${c.title}`; qs('#detailMeta').textContent=`${typeLabel(c.case_type)} • erstellt von ${c.created_by_name}${c.created_by_short_code?` (${c.created_by_short_code})`:''} • ${formatDateTime(c.created_at)}`; fillDetailCategorySelect(c.case_type); const form=qs('#detailEditForm'); form.status.value=c.status||'neu'; form.priority.value=c.priority||'gelb'; form.assigned_user_id.value=c.assigned_user_id||''; form.due_date.value=c.due_date?c.due_date.slice(0,10):''; form.source_area.value=c.source_area||''; form.mechanic_code.value=c.mechanic_code||''; form.customer_name.value=c.customer_name||''; form.vehicle.value=c.vehicle||''; form.order_ref.value=c.order_ref||''; form.internal_action.value=c.internal_action||''; form.customer_action.value=c.customer_action||''; form.category.value=c.category||''; form.complaint_validity.value=c.complaint_validity||'offen'; form.escalation_level.value=c.escalation_level||'mittel'; form.cause_guess.value=c.cause_guess||''; form.repeat_case.checked=!!c.repeat_case; form.linked_internal_process.checked=!!c.linked_internal_process; form.closed.checked=!!c.closed||c.status==='abgeschlossen'; qs('#detailSummary').innerHTML=`<div class="summary-item"><span class="summary-label">Beschreibung</span><div>${escapeHtml(c.description||'—')}</div></div><div class="summary-item"><span class="summary-label">Kategorie</span><div>${escapeHtml(c.category||'—')}</div></div><div class="summary-item"><span class="summary-label">Ursache / Vermutung</span><div>${escapeHtml(c.cause_guess||'—')}</div></div><div class="summary-item"><span class="summary-label">Wiederholfall</span><div>${c.repeat_case?'Ja':'Nein'}</div></div><div class="summary-item"><span class="summary-label">Reklamation berechtigt</span><div>${escapeHtml(c.complaint_validity||'offen')}</div></div><div class="summary-item"><span class="summary-label">Eskalationsstufe</span><div>${escapeHtml(c.escalation_level||'mittel')}</div></div><div class="summary-item"><span class="summary-label">Bezug interner Prozessfehler</span><div>${c.linked_internal_process?'Ja':'Nein'}</div></div><div class="summary-item"><span class="summary-label">Mechaniker</span><div>${escapeHtml(c.mechanic_code||'—')}</div></div><div class="summary-item"><span class="summary-label">Maßnahme intern</span><div>${escapeHtml(c.internal_action||'—')}</div></div><div class="summary-item"><span class="summary-label">Kundenzufriedenheit</span><div>${escapeHtml(c.customer_action||'—')}</div></div><div class="summary-item"><span class="summary-label">Abgeschlossen</span><div>${c.closed?`Ja • ${formatDateTime(c.closed_at)}${c.closed_by_name?` • ${escapeHtml(c.closed_by_name)}${c.closed_by_short_code?` (${escapeHtml(c.closed_by_short_code)})`:''}`:''}`:'Nein'}</div></div>`; qs('#detailTimeline').innerHTML=c.updates.length?c.updates.map(u=>`<div class="timeline-item"><div class="space-between"><strong>${escapeHtml(u.user_name)}${u.user_short_code?` (${escapeHtml(u.user_short_code)})`:''}</strong><span class="meta">${formatDateTime(u.created_at)}</span></div><div class="meta">${escapeHtml(updateTypeLabel(u.update_type))}</div><div class="preline">${escapeHtml(u.content)}</div></div>`).join(''):'<div class="empty">Noch keine Einträge in der Chronik.</div>'; qs('#attachmentList').innerHTML=c.attachments.length?c.attachments.map(a=>`<a class="attachment-card" href="/api/attachments/${a.id}" target="_blank" rel="noopener"><div class="attachment-thumb">📷</div><div class="attachment-info"><strong>${escapeHtml(a.filename)}</strong><div class="meta">${Math.round(a.size_bytes/1024)} KB • ${formatDateTime(a.created_at)}</div></div></a>`).join(''):'<div class="empty">Noch keine Bilder hochgeladen.</div>'; showView('caseDetail'); history.replaceState({},'',`/?case=${c.id}`); }
window.openCase=openCase;
function loadSettingsIntoForm(){ const s=state.me.settings||{}; const form=qs('#settingsForm'); ['notify_enabled','notify_only_assigned','notify_only_red','notify_daily_digest','email_enabled','email_new_case','email_escalation','email_due_reminder','weekly_summary'].forEach(k=>{ if(form[k]) form[k].checked=!!s[k]; }); }
async function loadAnalytics(){ if(!['teamleader','admin'].includes(state.me.role)) return; state.analytics = await api('/api/analytics'); renderAnalytics(); }
function drawTrend(canvas, byMonth){ const ctx=canvas.getContext('2d'); const entries=Object.entries(byMonth).sort(([a],[b])=>a.localeCompare(b)); const labels=entries.map(([k])=>k); const complaint=entries.map(([,v])=>v.complaints); const internal=entries.map(([,v])=>v.internal); const w=canvas.width=canvas.clientWidth*2; const h=canvas.height=canvas.height||360; ctx.scale(2,2); ctx.clearRect(0,0,w,h); const cw=canvas.clientWidth; const ch=canvas.height/2; const padding=30; const max=Math.max(1,...complaint,...internal); ctx.strokeStyle='#cbd5e1'; ctx.beginPath(); ctx.moveTo(padding,10); ctx.lineTo(padding,ch-padding); ctx.lineTo(cw-padding,ch-padding); ctx.stroke(); const drawLine=(data,color)=>{ ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); data.forEach((v,i)=>{ const x=padding + (i*(cw-padding*2))/Math.max(1,data.length-1); const y=(ch-padding) - ((ch-padding*1.5)*(v/max)); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,2.8,0,Math.PI*2); ctx.fill(); }); ctx.stroke();}; drawLine(complaint,'#2563eb'); drawLine(internal,'#f97316'); ctx.fillStyle='#0f172a'; ctx.font='12px sans-serif'; labels.forEach((label,i)=>{ const x=padding + (i*(cw-padding*2))/Math.max(1,labels.length-1); ctx.fillText(label.slice(2), x-10, ch-padding+16); }); ctx.fillStyle='#2563eb'; ctx.fillText('Reklamationen', padding, 12); ctx.fillStyle='#f97316'; ctx.fillText('Prozessfehler', padding+120, 12); }
function tableFromMap(title, map){ const rows=Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'; return `<section class="stat-card"><h3>${escapeHtml(title)}</h3><table class="mini-table"><tbody>${rows}</tbody></table></section>`; }
function renderAnalytics() {
  const a = state.analytics;
  if (!a) return;
  qs('#anComplaints').textContent = a.totals.complaints;
  qs('#anInternal').textContent = a.totals.internal;
  qs('#anRepeat').textContent = a.totals.repeat;
  qs('#anOverdue').textContent = a.totals.overdue;
  drawTrend(qs('#trendChart'), a.byMonth);
  qs('#trendSummary').innerHTML = renderStatList('Trend-Hinweise', {
    'Monate mit Reklamationen': Object.values(a.byMonth).filter((v) => v.complaints > 0).length,
    'Monate mit Prozessfehlern': Object.values(a.byMonth).filter((v) => v.internal > 0).length,
    'Gesamt Reklamationen': a.totals.complaints,
    'Gesamt Prozessfehler': a.totals.internal,
  }, { full: true });
  qs('#periodTables').innerHTML =
    renderStatList('Monate Reklamationen', Object.fromEntries(Object.entries(a.byMonth).map(([k, v]) => [k, v.complaints])), { full: true }) +
    renderStatList('Monate Prozessfehler', Object.fromEntries(Object.entries(a.byMonth).map(([k, v]) => [k, v.internal])), { full: true }) +
    renderStatList('Quartale Reklamationen', Object.fromEntries(Object.entries(a.byQuarter).map(([k, v]) => [k, v.complaints])), { full: true }) +
    renderStatList('Quartale Prozessfehler', Object.fromEntries(Object.entries(a.byQuarter).map(([k, v]) => [k, v.internal])), { full: true });
  qs('#categoryStats').innerHTML =
    renderStatList('Bereiche Reklamationen', a.byArea.customer_complaint) +
    renderStatList('Bereiche Prozessfehler', a.byArea.internal_process) +
    renderStatList('Kategorien Reklamationen', a.byCategory.customer_complaint) +
    renderStatList('Kategorien Prozessfehler', a.byCategory.internal_process);
  qs('#mechanicStats').innerHTML = renderMetricCards(a.byMechanic, 'Mechaniker') + renderMetricCards(a.byServiceAdvisor, 'Serviceberater');
  qs('#qualityStats').innerHTML =
    renderStatList('Bezug interner Prozessfehler', a.linked) +
    renderStatList('Reklamation berechtigt', a.validity) +
    renderStatList('Eskalationsstufe', a.escalation) +
    renderStatList('Abschlussstatus', { Offen: a.totals.open, Abgeschlossen: a.totals.closed, Überfällig: a.totals.overdue });
  setAnalyticsSection(state.analyticsSection || 'trend');
}

qs('#loginForm').addEventListener('submit', async (e)=>{ e.preventDefault(); setNotice('loginError',''); try{ await api('/api/login',{method:'POST',body:JSON.stringify({email:qs('#loginEmail').value,password:qs('#loginPassword').value})}); state.me=await api('/api/me'); await loadUsers(); state.categories=await api('/api/categories'); fillCategorySelects(); await loadCases(); fillUserSelects(); applyAuthState(true); loadSettingsIntoForm(); renderDashboard(); renderCases(); }catch(err){ setNotice('loginError',err.message); } });
qs('#logoutBtn').addEventListener('click', async()=>{ await api('/api/logout',{method:'POST'}); location.href='/'; });
qs('#newCaseType').addEventListener('change', fillCategorySelects);
qs('#newCaseForm').addEventListener('submit', async (e)=>{ e.preventDefault(); setNotice('newCaseError',''); const form=e.currentTarget; const formData=new FormData(form); const imageFiles=formData.getAll('images').filter(file=>file&&file.size); const data=Object.fromEntries(formData.entries()); delete data.images; try{ const created=await api('/api/cases',{method:'POST',body:JSON.stringify(data)}); if(imageFiles.length){ const uploadData=new FormData(); imageFiles.forEach(file=>uploadData.append('images',file)); await api(`/api/cases/${created.id}/attachments`,{method:'POST',body:uploadData}); } if(form && typeof form.reset==='function') form.reset(); fillCategorySelects(); await loadCases(); renderDashboard(); renderCases(); await openCase(created.id); setNotice('newCaseError','Fall gespeichert.',true); }catch(err){ setNotice('newCaseError',err.message); } });
['#filterStatus','#filterPriority','#filterType'].forEach(sel=>qs(sel).addEventListener('change', async()=>{ await loadCases(); renderDashboard(); renderCases(); }));
qs('#filterMineBtn').addEventListener('click', async()=>{ state.mineOnly=!state.mineOnly; qs('#filterMineBtn').textContent=state.mineOnly?'Alle Fälle anzeigen':'Nur meine Fälle'; await loadCases(); renderDashboard(); renderCases(); });
qs('#settingsForm').addEventListener('submit', async(e)=>{ e.preventDefault(); const form=e.currentTarget; try{ const settings=await api('/api/settings',{method:'PATCH',body:JSON.stringify({ notify_enabled:form.notify_enabled.checked, notify_only_assigned:form.notify_only_assigned.checked, notify_only_red:form.notify_only_red.checked, notify_daily_digest:form.notify_daily_digest.checked, email_enabled:form.email_enabled.checked, email_new_case:form.email_new_case.checked, email_escalation:form.email_escalation.checked, email_due_reminder:form.email_due_reminder.checked, weekly_summary:form.weekly_summary.checked })}); state.me.settings=settings; setNotice('settingsNotice','Einstellungen gespeichert.',true); }catch(err){ setNotice('settingsNotice',err.message); } });
const createUserForm=qs('#createUserForm'); if(createUserForm){ createUserForm.addEventListener('submit', async(e)=>{ e.preventDefault(); const form=e.currentTarget; const data=Object.fromEntries(new FormData(form).entries()); try{ await api('/api/users',{method:'POST',body:JSON.stringify(data)}); setNotice('userCreateNotice','Benutzer angelegt.',true); if(form && typeof form.reset==='function') form.reset(); await loadUsers(); fillUserSelects(); }catch(err){ setNotice('userCreateNotice',err.message); } }); }
qs('#detailEditForm').addEventListener('submit', async(e)=>{ e.preventDefault(); if(!state.currentCase) return; const form=e.currentTarget; const data=Object.fromEntries(new FormData(form).entries()); data.closed=form.closed.checked; data.repeat_case=form.repeat_case.checked; data.linked_internal_process=form.linked_internal_process.checked; try{ await api(`/api/cases/${state.currentCase.id}`,{method:'PATCH',body:JSON.stringify(data)}); setNotice('detailEditNotice','Fall aktualisiert.',true); await loadCases(); await openCase(state.currentCase.id); renderDashboard(); renderCases(); if(['teamleader','admin'].includes(state.me.role)) { state.analytics=null; } }catch(err){ setNotice('detailEditNotice',err.message); } });
const detailUpdateForm=qs('#detailUpdateForm'); if(detailUpdateForm){ detailUpdateForm.addEventListener('submit', async(e)=>{ e.preventDefault(); if(!state.currentCase) return; const form=e.currentTarget; const data=Object.fromEntries(new FormData(form).entries()); try{ await api(`/api/cases/${state.currentCase.id}/updates`,{method:'POST',body:JSON.stringify(data)}); if(form && typeof form.reset==='function') form.reset(); setNotice('detailUpdateNotice','Eintrag hinzugefügt.',true); await loadCases(); await openCase(state.currentCase.id); renderDashboard(); renderCases(); }catch(err){ setNotice('detailUpdateNotice',err.message); } }); }
qs('#attachmentForm').addEventListener('submit', async(e)=>{ e.preventDefault(); if(!state.currentCase) return; const input=qs('#attachmentInput'); if(!input.files.length){ setNotice('attachmentNotice','Bitte mindestens ein Bild auswählen.'); return; } const formData=new FormData(); [...input.files].forEach(file=>formData.append('images',file)); try{ await api(`/api/cases/${state.currentCase.id}/attachments`,{method:'POST',body:formData}); input.value=''; setNotice('attachmentNotice','Bilder hochgeladen.',true); await loadCases(); await openCase(state.currentCase.id); renderDashboard(); renderCases(); }catch(err){ setNotice('attachmentNotice',err.message); } });
qs('#exportAnalyticsBtn')?.addEventListener('click', () => { window.location.href='/api/analytics/export'; });
qs('#pdfAnalyticsBtn')?.addEventListener('click', () => { window.location.href='/api/analytics/report.pdf'; });
bootstrap();

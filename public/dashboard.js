function getToken() {
  return new URL(location.href).searchParams.get('token') || '';
}
const TOKEN = getToken();

const els = {
  pendingList: document.getElementById('pendingList'),
  historyList: document.getElementById('historyList'),
  emptyPending: document.getElementById('emptyPending'),
  emptyHistory: document.getElementById('emptyHistory'),
  statusDot: document.getElementById('statusDot'),
  liveBadge: document.getElementById('liveBadge'),
  clearBtn: document.getElementById('clearBtn'),
  notifyBtn: document.getElementById('notifyBtn'),
  clearAnnouncementBtn: document.getElementById('clearAnnouncementBtn'),
  notifyText: document.getElementById('notifyText'),
  notifyMsg: document.getElementById('notifyMsg'),
  pendingCount: document.getElementById('pendingCount'),
  historyCount: document.getElementById('historyCount'),
  enableAlertsBtn: document.getElementById('enableAlertsBtn'),
  toastWrap: document.getElementById('toastWrap'),
  statusCards: document.getElementById('statusCards'),
  metricPending: document.getElementById('metricPending'),
  metricWait: document.getElementById('metricWait'),
  metricClients: document.getElementById('metricClients'),
  metricApproved: document.getElementById('metricApproved'),
  announcementBar: document.getElementById('announcementBar'),
};

let lastPendingIds = new Set();
let ws;

function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (m <= 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('nl-NL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}

if (!TOKEN) {
  document.body.innerHTML = '<div style="padding:24px;color:white;background:#090d16;font-family:Inter,system-ui">Missing token. Open dashboard with ?token=YOUR_ADMIN_TOKEN</div>';
  throw new Error('missing_token');
}

async function api(path, opts = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set('token', TOKEN);
  const r = await fetch(u.toString(), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

function pushToast(text, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  els.toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 240);
  }, 3200);
}

function maybeNotifyUpload(item) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('Nieuwe upload', {
      body: `${item.by} stuurde ${item.kind === 'image' ? 'een afbeelding' : 'tekst'}`,
    });
  } catch {}
}

function renderAnnouncement(announcement) {
  if (!announcement?.text) {
    els.announcementBar.classList.add('hidden');
    els.announcementBar.textContent = '';
    return;
  }
  els.announcementBar.textContent = `Announcement • ${announcement.text}`;
  els.announcementBar.classList.remove('hidden');
}

function itemEl(it, isHistory = false) {
  const div = document.createElement('div');
  div.className = `item ${it.kind}`;

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const eta = formatDuration(it.estimatedWaitSec || 0);
  meta.innerHTML = `
    <span class="kind-pill ${it.kind}">${it.kind === 'image' ? 'Afbeelding' : 'Tekst'}</span>
    <span>@${it.by}</span>
    <span>${formatDate(it.createdAt || it.decidedAt)}</span>
    ${!isHistory ? `<span>ETA ${eta}</span>` : `<span>${it.status || 'done'}</span>`}
  `;
  div.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'item-body';
  if (it.kind === 'image') {
    const img = document.createElement('img');
    img.src = it.url;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    body.appendChild(img);
  } else {
    const t = document.createElement('div');
    t.className = 'text-preview';
    t.textContent = it.text || '';
    body.appendChild(t);
  }
  div.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'item-foot';
  foot.innerHTML = `
    <span>Positie ${it.queuePosition || '—'}</span>
    <span>${it.source || 'upload'}</span>
  `;
  div.appendChild(foot);

  if (!isHistory) {
    const actions = document.createElement('div');
    actions.className = 'actions';

    const approve = document.createElement('button');
    approve.className = 'approve';
    approve.textContent = 'Approve';
    approve.onclick = async () => {
      approve.disabled = true;
      try { await api('/api/approve?id=' + encodeURIComponent(it.id), { method: 'POST', body: '{}' }); }
      catch (e) { pushToast('Approve error: ' + e.message, 'error'); }
      finally { approve.disabled = false; }
    };

    const reject = document.createElement('button');
    reject.className = 'reject';
    reject.textContent = 'Reject';
    reject.onclick = async () => {
      reject.disabled = true;
      try { await api('/api/reject?id=' + encodeURIComponent(it.id), { method: 'POST', body: '{}' }); }
      catch (e) { pushToast('Reject error: ' + e.message, 'error'); }
      finally { reject.disabled = false; }
    };

    actions.appendChild(approve);
    actions.appendChild(reject);
    div.appendChild(actions);
  }

  return div;
}

function renderStatusCards(status) {
  const cards = [
    ['Max queue', String(status.maxPending || 0)],
    ['Upload limiet', `${Math.round((status.maxUploadBytes || 0) / (1024 * 1024))} MB`],
    ['Upload key', status.uploadKeyEnabled ? 'Aan' : 'Uit'],
    ['TTL uploads', `${status.uploadTtlHours || 0} uur`],
  ];
  els.statusCards.innerHTML = cards.map(([label, value]) => `<article class="status-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
}

function renderState(payload) {
  const status = payload.status || {};
  const pending = payload.pending || [];
  const history = payload.history || [];

  els.pendingList.innerHTML = '';
  els.historyList.innerHTML = '';
  els.pendingCount.textContent = String(pending.length);
  els.historyCount.textContent = String(history.length);
  els.metricPending.textContent = String(pending.length);
  els.metricWait.textContent = formatDuration(status.estimatedWaitSec || 0);
  els.metricClients.textContent = String(status.wsClients || 0);
  els.metricApproved.textContent = formatDate(status.lastApprovedAt);
  els.emptyPending.style.display = pending.length ? 'none' : 'block';
  els.emptyHistory.style.display = history.length ? 'none' : 'block';

  renderAnnouncement(payload.announcement || status.announcement);
  renderStatusCards(status);

  pending.forEach((it, index) => {
    const enriched = { ...it, queuePosition: index + 1, estimatedWaitSec: index * (status.fixedDurationSec || 10) + 15 };
    els.pendingList.appendChild(itemEl(enriched, false));
  });
  history.forEach((it) => els.historyList.appendChild(itemEl(it, true)));

  const nextIds = new Set(pending.map((x) => x.id));
  for (const it of pending) {
    if (!lastPendingIds.has(it.id)) maybeNotifyUpload(it);
  }
  lastPendingIds = nextIds;
}

async function loadInitial() {
  try {
    const [status, pending, history] = await Promise.all([
      api('/api/status'), api('/api/pending'), api('/api/history')
    ]);
    renderState({ status: status.status, pending: pending.pending, history: history.history, announcement: status.status?.announcement });
  } catch (e) {
    els.statusDot.className = 'dot bad';
    els.liveBadge.textContent = 'offline';
    pushToast('Load error: ' + e.message, 'error');
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    els.statusDot.className = 'dot ok';
    els.liveBadge.textContent = 'live';
    ws.send(JSON.stringify({ type: 'hello', role: 'dashboard' }));
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!data?.type) return;
    if (data.type === 'state') renderState(data);
    if (data.type === 'toast' && data.message) pushToast(data.message, data.level || 'info');
  });

  const onClose = () => {
    els.statusDot.className = 'dot bad';
    els.liveBadge.textContent = 'reconnecting';
    setTimeout(connectWs, 1500);
  };
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onClose);
}

els.clearBtn.onclick = async () => {
  if (!confirm('Wachtrij helemaal leegmaken?')) return;
  try {
    await api('/api/clear', { method: 'POST', body: '{}' });
  } catch (e) {
    pushToast('Clear error: ' + e.message, 'error');
  }
};

els.notifyBtn.onclick = async () => {
  els.notifyMsg.textContent = '';
  const text = (els.notifyText.value || '').trim();
  if (!text) {
    els.notifyMsg.textContent = 'Vul eerst een announcement in.';
    return;
  }
  els.notifyBtn.disabled = true;
  try {
    await api('/api/announcement', { method: 'POST', body: JSON.stringify({ text }) });
    els.notifyMsg.textContent = 'Announcement is live op de website.';
    els.notifyText.value = '';
  } catch (e) {
    els.notifyMsg.textContent = 'Error: ' + e.message;
  } finally {
    els.notifyBtn.disabled = false;
  }
};

els.clearAnnouncementBtn.onclick = async () => {
  els.notifyMsg.textContent = '';
  try {
    await api('/api/announcement', { method: 'DELETE' });
    els.notifyMsg.textContent = 'Announcement verwijderd.';
  } catch (e) {
    els.notifyMsg.textContent = 'Error: ' + e.message;
  }
};

els.enableAlertsBtn.onclick = async () => {
  if (!('Notification' in window)) {
    pushToast('Browsermeldingen worden hier niet ondersteund.', 'warning');
    return;
  }
  const result = await Notification.requestPermission();
  pushToast(result === 'granted' ? 'Browsermeldingen staan aan.' : 'Browsermeldingen niet toegestaan.', result === 'granted' ? 'success' : 'warning');
};

loadInitial();
connectWs();

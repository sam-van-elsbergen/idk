function getToken() {
  return new URL(location.href).searchParams.get('token') || '';
}
const TOKEN = getToken();

const els = {
  statusBox: document.getElementById('statusBox'),
  pendingList: document.getElementById('pendingList'),
  historyList: document.getElementById('historyList'),
  emptyPending: document.getElementById('emptyPending'),
  emptyHistory: document.getElementById('emptyHistory'),
  statusDot: document.getElementById('statusDot'),
  liveBadge: document.getElementById('liveBadge'),
  clearBtn: document.getElementById('clearBtn'),
  notifyBtn: document.getElementById('notifyBtn'),
  notifyText: document.getElementById('notifyText'),
  notifyMsg: document.getElementById('notifyMsg'),
  pendingCount: document.getElementById('pendingCount'),
  historyCount: document.getElementById('historyCount'),
  enableAlertsBtn: document.getElementById('enableAlertsBtn'),
  toastWrap: document.getElementById('toastWrap'),
};

let lastPendingIds = new Set();
let ws;

if (!TOKEN) {
  els.statusBox.textContent = 'Missing token. Open dashboard with ?token=YOUR_ADMIN_TOKEN';
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

function itemEl(it, isHistory = false) {
  const div = document.createElement('div');
  div.className = 'item';

  const top = document.createElement('div');
  top.className = 'topline';
  const created = it.createdAt ? new Date(it.createdAt).toLocaleString() : '';
  top.innerHTML = `
    <span><span class="kind">${String(it.kind || '').toUpperCase()}</span> • @${it.by} • ${it.source || '?'} • ${created}</span>
    <span>dur ${it.durationSec || 10}s ${isHistory ? `• ${it.status}` : ''}</span>
  `;
  div.appendChild(top);

  const preview = document.createElement('div');
  preview.className = 'preview';
  if (it.kind === 'image') {
    const img = document.createElement('img');
    img.src = it.url;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    preview.appendChild(img);
    const small = document.createElement('div');
    small.className = 'small';
    small.textContent = it.url;
    preview.appendChild(small);
  } else {
    const t = document.createElement('div');
    t.className = 'text';
    t.textContent = it.text || '';
    preview.appendChild(t);
  }
  div.appendChild(preview);

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

function renderState(payload) {
  const status = payload.status || {};
  const pending = payload.pending || [];
  const history = payload.history || [];

  els.statusBox.textContent = JSON.stringify(status, null, 2);
  els.pendingList.innerHTML = '';
  els.historyList.innerHTML = '';
  els.pendingCount.textContent = String(pending.length);
  els.historyCount.textContent = String(history.length);
  els.emptyPending.style.display = pending.length ? 'none' : 'block';
  els.emptyHistory.style.display = history.length ? 'none' : 'block';

  for (const it of pending) els.pendingList.appendChild(itemEl(it, false));
  for (const it of history) els.historyList.appendChild(itemEl(it, true));

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
    renderState({ status: status.status, pending: pending.pending, history: history.history });
  } catch (e) {
    els.statusDot.className = 'dot bad';
    els.liveBadge.textContent = 'offline';
    els.statusBox.textContent = 'Load error: ' + e.message;
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
  if (!confirm('Clear all pending items?')) return;
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
    els.notifyMsg.textContent = 'Vul eerst een melding in.';
    return;
  }
  els.notifyBtn.disabled = true;
  try {
    await api('/api/notify', { method: 'POST', body: JSON.stringify({ text }) });
    els.notifyMsg.textContent = 'Melding verzonden naar de overlay.';
    els.notifyText.value = '';
  } catch (e) {
    els.notifyMsg.textContent = 'Error: ' + e.message;
  } finally {
    els.notifyBtn.disabled = false;
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

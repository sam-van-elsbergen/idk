const nickname = document.getElementById('nickname');
const image = document.getElementById('image');
const text = document.getElementById('text');
const sendImage = document.getElementById('sendImage');
const sendText = document.getElementById('sendText');
const imgMsg = document.getElementById('imgMsg');
const txtMsg = document.getElementById('txtMsg');
const queueCount = document.getElementById('queueCount');
const queueEta = document.getElementById('queueEta');
const announcementBar = document.getElementById('announcementBar');

function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (m <= 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function uploadUrl() {
  const u = new URL('/upload', location.origin);
  const cur = new URL(location.href);
  const k = cur.searchParams.get('k');
  if (k) u.searchParams.set('k', k);
  return u.toString();
}
async function postForm(fd) {
  const r = await fetch(uploadUrl(), { method: 'POST', body: fd });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}
async function loadPublicStatus() {
  const r = await fetch('/api/public-status');
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.status) return;
  applyStatus(j.status);
}
function applyStatus(status) {
  queueCount.textContent = String(status.pendingCount || 0);
  queueEta.textContent = formatDuration(status.estimatedWaitSec || 0);
  if (status.announcement?.text) {
    announcementBar.textContent = `Announcement • ${status.announcement.text}`;
    announcementBar.classList.remove('hidden');
  } else {
    announcementBar.textContent = '';
    announcementBar.classList.add('hidden');
  }
}
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'upload' }));
  });
  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data?.type === 'state' && data.status) applyStatus(data.status);
  });
}

sendImage.onclick = async () => {
  imgMsg.textContent = '';
  const f = image.files?.[0];
  if (!f) { imgMsg.textContent = 'Kies eerst een bestand.'; return; }
  if (f.type === 'image/gif' || /\.gif$/i.test(f.name)) {
    imgMsg.textContent = 'GIF-bestanden zijn niet toegestaan.';
    return;
  }

  const fd = new FormData();
  fd.append('nickname', nickname.value || '');
  fd.append('image', f, f.name);

  sendImage.disabled = true;
  try {
    const res = await postForm(fd);
    imgMsg.textContent = `Upload ontvangen. Positie ${res.queuePosition}, geschatte wachttijd ${formatDuration(res.estimatedWaitSec)}.`;
    image.value = '';
  } catch (e) {
    imgMsg.textContent = 'Error: ' + e.message;
  } finally {
    sendImage.disabled = false;
  }
};

sendText.onclick = async () => {
  txtMsg.textContent = '';
  const t = (text.value || '').trim();
  if (!t) { txtMsg.textContent = 'Typ eerst tekst.'; return; }

  const fd = new FormData();
  fd.append('nickname', nickname.value || '');
  fd.append('text', t);

  sendText.disabled = true;
  try {
    const res = await postForm(fd);
    txtMsg.textContent = `Tekst ontvangen. Positie ${res.queuePosition}, geschatte wachttijd ${formatDuration(res.estimatedWaitSec)}.`;
    text.value = '';
  } catch (e) {
    txtMsg.textContent = 'Error: ' + e.message;
  } finally {
    sendText.disabled = false;
  }
};

loadPublicStatus();
connectWs();

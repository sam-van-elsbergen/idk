const nickname = document.getElementById('nickname');
const image = document.getElementById('image');
const text = document.getElementById('text');
const sendImage = document.getElementById('sendImage');
const sendText = document.getElementById('sendText');
const imgMsg = document.getElementById('imgMsg');
const txtMsg = document.getElementById('txtMsg');

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
    await postForm(fd);
    imgMsg.textContent = 'Upload is verzonden en wacht op goedkeuring.';
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
    await postForm(fd);
    txtMsg.textContent = 'Tekst is verzonden en wacht op goedkeuring.';
    text.value = '';
  } catch (e) {
    txtMsg.textContent = 'Error: ' + e.message;
  } finally {
    sendText.disabled = false;
  }
};

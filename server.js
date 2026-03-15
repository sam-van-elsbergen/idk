const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

function getArg(name, fallback = null) {
  const eq = `--${name}=`;
  const i = process.argv.findIndex((a) => a.startsWith(eq) || a === `--${name}`);
  if (i === -1) return fallback;
  const a = process.argv[i];
  if (a.startsWith(eq)) return a.slice(eq.length);
  const next = process.argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}
function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function boolArg(name, fallback = false) {
  const v = String(getArg(name, fallback ? 'on' : 'off') || '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

const FIXED_DURATION_SEC = 10;
const CFG = {
  port: clampInt(getArg('port', process.env.PORT || 3000), 3000, 1, 65535),
  bind: getArg('bind', '0.0.0.0'),
  adminToken: (getArg('admin', process.env.ADMIN_TOKEN || 'goodboy') || '').trim(),
  uploadKey: (getArg('uploadKey', process.env.UPLOAD_KEY || '') || '').trim(),
  maxTextLen: clampInt(getArg('maxText', 140), 140, 20, 500),
  maxPending: clampInt(getArg('maxPending', 200), 200, 20, 5000),
  maxUploadBytes: clampInt(getArg('maxUploadBytes', 5 * 1024 * 1024), 5 * 1024 * 1024, 50 * 1024, 50 * 1024 * 1024),
  uploadTtlHours: clampInt(getArg('uploadTtlHours', 24), 24, 1, 168),
  publicDir: path.join(__dirname, 'public'),
  uploadDir: path.join(__dirname, 'uploads'),
  trustProxy: boolArg('trustProxy', false),
};

fs.mkdirSync(CFG.uploadDir, { recursive: true });

const pending = [];
const history = [];
const HISTORY_MAX = 300;
const clients = new Set();
const shownQueue = [];
let currentAnnouncement = null;

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}
function pushHistory(item) {
  history.unshift(item);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
}
function enqueuePending(item) {
  if (pending.length >= CFG.maxPending) {
    const dropped = pending.shift();
    pushHistory({ ...dropped, status: 'dropped', decidedAt: new Date().toISOString() });
  }
  pending.push(item);
}
function requireAdmin(reqUrl) {
  const token = reqUrl.searchParams.get('token') || '';
  return token && token === CFG.adminToken;
}
function requireUploadKey(reqUrl) {
  if (!CFG.uploadKey) return true;
  const k = reqUrl.searchParams.get('k') || '';
  return k === CFG.uploadKey;
}
function getClientIp(req) {
  if (CFG.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function estimateWaitSeconds(pendingAhead = pending.length) {
  const safeAhead = Math.max(0, Number(pendingAhead) || 0);
  return Math.max(15, safeAhead * FIXED_DURATION_SEC + 15);
}
function summarizeAnnouncement() {
  if (!currentAnnouncement?.text) return null;
  return { ...currentAnnouncement };
}
function getStatus() {
  return {
    bind: CFG.bind,
    port: CFG.port,
    fixedDurationSec: FIXED_DURATION_SEC,
    uploadKeyEnabled: Boolean(CFG.uploadKey),
    maxUploadBytes: CFG.maxUploadBytes,
    uploadTtlHours: CFG.uploadTtlHours,
    maxPending: CFG.maxPending,
    pendingCount: pending.length,
    historyCount: history.length,
    wsClients: clients.size,
    lastApprovedAt: shownQueue[0]?.approvedAt || null,
    estimatedWaitSec: estimateWaitSeconds(pending.length),
    announcement: summarizeAnnouncement(),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function safeJoin(baseDir, p) {
  const clean = p.replace(/\0/g, '');
  const fp = path.join(baseDir, clean);
  const rel = path.relative(baseDir, fp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fp;
}
function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function wsAcceptKey(secKey) {
  const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  return crypto.createHash('sha1').update(secKey + magic).digest('base64');
}
function wsFrame(opcode, payloadBuf = Buffer.alloc(0)) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}
function wsFrameText(str) {
  return wsFrame(0x1, Buffer.from(str, 'utf8'));
}
function broadcast(obj) {
  const frame = wsFrameText(JSON.stringify(obj));
  for (const sock of clients) {
    try { sock.write(frame); } catch {}
  }
}
function sendWs(sock, obj) {
  try { sock.write(wsFrameText(JSON.stringify(obj))); } catch {}
}
function emitState(reason = 'state') {
  broadcast({ type: 'state', reason, status: getStatus(), pending, history, announcement: summarizeAnnouncement() });
}
function emitToast(message, level = 'info') {
  broadcast({ type: 'toast', message: String(message || '').slice(0, 240), level });
}
function emitOverlay(item) {
  broadcast({
    type: item.kind === 'image' ? 'showImage' : 'showText',
    id: item.id,
    by: item.by,
    channel: item.source,
    text: item.text || '',
    url: item.url || '',
    durationMs: FIXED_DURATION_SEC * 1000,
  });
}
function handleWsData(sock, chunk) {
  let buf = Buffer.concat([sock._wsBuf, chunk]);
  while (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) break;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) break;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) { sock.end(); return; }
      len = Number(big);
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) break;
    const payload = Buffer.from(buf.slice(offset, offset + len));
    buf = buf.slice(offset + len);

    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }

    if (opcode === 0x8) { sock.end(); return; }
    if (opcode === 0x9) { try { sock.write(wsFrame(0xA, payload)); } catch {} continue; }
    if (!fin || opcode !== 0x1) continue;

    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch {}
    if (!msg || typeof msg !== 'object') continue;

    if (msg.type === 'hello') {
      sendWs(sock, { type: 'hello', ok: true, role: msg.role || 'client' });
      sendWs(sock, { type: 'state', reason: 'hello', status: getStatus(), pending, history, announcement: summarizeAnnouncement() });
    }
  }
  sock._wsBuf = buf;
}

async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseMultipart(buffer, contentType) {
  const m = /boundary=([^;]+)/i.exec(contentType || '');
  if (!m) throw new Error('missing_boundary');
  const boundary = Buffer.from('--' + m[1]);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundary, bodyStart);
    if (nextBoundary === -1) break;
    let bodyEnd = nextBoundary - 2;
    if (bodyEnd < bodyStart) bodyEnd = bodyStart;
    const body = buffer.slice(bodyStart, bodyEnd);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx !== -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    parts.push({ headers, body });
    start = nextBoundary;
  }
  return parts;
}
function getDisposition(headers) {
  const cd = headers['content-disposition'] || '';
  const nameM = /name="([^"]+)"/i.exec(cd);
  const fileM = /filename="([^"]*)"/i.exec(cd);
  return { name: nameM ? nameM[1] : null, filename: fileM ? fileM[1] : null };
}
function sanitizeFilename(name) {
  const base = (name || '').split(/[\\/]/).pop() || 'upload';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
function guessExtFromMime(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  return '';
}
function isAllowedUploadMime(mime) {
  const m = (mime || '').toLowerCase();
  return m.startsWith('image/png') || m.startsWith('image/jpeg') || m.startsWith('image/webp');
}
function pruneExpiredUploads() {
  const cutoff = Date.now() - CFG.uploadTtlHours * 3600 * 1000;
  for (const item of [...pending, ...history]) {
    if (item.kind !== 'image' || !item.savedPath) continue;
    const t = Date.parse(item.createdAt || item.decidedAt || 0);
    if (!Number.isFinite(t) || t > cutoff) continue;
    try { fs.unlinkSync(item.savedPath); } catch {}
    delete item.savedPath;
  }
}
setInterval(pruneExpiredUploads, 60 * 60 * 1000).unref();

function notFound(res) { return send(res, 404, 'Not found'); }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      return sendJson(res, 200, { ok: true, status: getStatus() });
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, status: getStatus() });
    }

    if (req.method === 'GET' && u.pathname === '/api/public-status') {
      return sendJson(res, 200, { ok: true, status: getStatus() });
    }

    if (req.method === 'GET' && u.pathname === '/api/pending') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, pending });
    }

    if (req.method === 'GET' && u.pathname === '/api/history') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, history });
    }

    if (req.method === 'POST' && u.pathname === '/api/approve') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      const id = u.searchParams.get('id') || '';
      const idx = pending.findIndex((x) => x.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
      const item = pending.splice(idx, 1)[0];
      const approved = { ...item, status: 'approved', approvedAt: new Date().toISOString() };
      shownQueue.unshift(approved);
      if (shownQueue.length > 100) shownQueue.length = 100;
      pushHistory({ ...approved, decidedAt: approved.approvedAt });
      emitOverlay(approved);
      emitToast(`Goedgekeurd: ${approved.kind === 'image' ? 'afbeelding' : 'tekst'} van ${approved.by}`, 'success');
      emitState('approve');
      return sendJson(res, 200, { ok: true, item: approved });
    }

    if (req.method === 'POST' && u.pathname === '/api/reject') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      const id = u.searchParams.get('id') || '';
      const idx = pending.findIndex((x) => x.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
      const item = pending.splice(idx, 1)[0];
      const rejected = { ...item, status: 'rejected', decidedAt: new Date().toISOString() };
      pushHistory(rejected);
      emitToast(`Geweigerd: ${rejected.kind === 'image' ? 'afbeelding' : 'tekst'} van ${rejected.by}`, 'warning');
      emitState('reject');
      return sendJson(res, 200, { ok: true, item: rejected });
    }

    if (req.method === 'POST' && u.pathname === '/api/clear') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      while (pending.length) {
        const item = pending.shift();
        pushHistory({ ...item, status: 'cleared', decidedAt: new Date().toISOString() });
      }
      emitToast('Wachtrij geleegd.', 'info');
      emitState('clear');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/api/announcement') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req, 32 * 1024);
      let data = null;
      try { data = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'bad_json' }); }
      const text = String(data?.text || '').trim().slice(0, 180);
      if (!text) return sendJson(res, 400, { error: 'missing_text' });
      currentAnnouncement = {
        id: makeId(),
        text,
        updatedAt: new Date().toISOString(),
        by: 'Panel',
      };
      emitToast(`Announcement live op de site: ${text}`, 'success');
      emitState('announcement');
      return sendJson(res, 200, { ok: true, announcement: currentAnnouncement });
    }

    if (req.method === 'DELETE' && u.pathname === '/api/announcement') {
      if (!requireAdmin(u)) return sendJson(res, 401, { error: 'unauthorized' });
      currentAnnouncement = null;
      emitToast('Announcement verwijderd.', 'info');
      emitState('announcement-clear');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/upload') {
      if (!requireUploadKey(u)) return sendJson(res, 401, { error: 'bad_upload_key' });
      const body = await readBody(req, CFG.maxUploadBytes + 64 * 1024);
      const parts = parseMultipart(body, req.headers['content-type'] || '');
      const fields = {};
      let imageFile = null;

      for (const part of parts) {
        const disp = getDisposition(part.headers);
        if (!disp.name) continue;
        if (disp.filename != null && disp.filename !== '') {
          imageFile = {
            filename: sanitizeFilename(disp.filename),
            mime: part.headers['content-type'] || 'application/octet-stream',
            body: part.body,
          };
        } else {
          fields[disp.name] = part.body.toString('utf8').trim();
        }
      }

      const nickname = String(fields.nickname || '').trim().slice(0, 40) || 'Anoniem';
      const text = String(fields.text || '').trim().slice(0, CFG.maxTextLen);
      const ip = getClientIp(req);
      const pendingAhead = pending.length;
      const estimatedWaitSec = estimateWaitSeconds(pendingAhead);
      const queuePosition = pendingAhead + 1;

      if (imageFile) {
        if (!isAllowedUploadMime(imageFile.mime)) return sendJson(res, 400, { error: 'only_png_jpg_webp' });
        if (imageFile.body.length > CFG.maxUploadBytes) return sendJson(res, 400, { error: 'file_too_large' });

        const ext = path.extname(imageFile.filename).toLowerCase() || guessExtFromMime(imageFile.mime);
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return sendJson(res, 400, { error: 'gif_not_allowed' });

        const stored = `${Date.now()}-${makeId()}${ext === '.jpeg' ? '.jpg' : ext}`;
        const savedPath = path.join(CFG.uploadDir, stored);
        fs.writeFileSync(savedPath, imageFile.body);

        const item = {
          id: makeId(),
          kind: 'image',
          url: `/uploads/${stored}`,
          savedPath,
          by: nickname,
          source: 'upload',
          ip,
          status: 'pending',
          createdAt: new Date().toISOString(),
          durationSec: FIXED_DURATION_SEC,
          queuePosition,
          estimatedWaitSec,
        };
        enqueuePending(item);
        emitToast(`Nieuwe afbeelding van ${nickname}`, 'info');
        emitState('upload-image');
        return sendJson(res, 200, { ok: true, queued: true, id: item.id, queuePosition, estimatedWaitSec });
      }

      if (text) {
        const item = {
          id: makeId(),
          kind: 'text',
          text,
          by: nickname,
          source: 'upload',
          ip,
          status: 'pending',
          createdAt: new Date().toISOString(),
          durationSec: FIXED_DURATION_SEC,
          queuePosition,
          estimatedWaitSec,
        };
        enqueuePending(item);
        emitToast(`Nieuwe tekst van ${nickname}`, 'info');
        emitState('upload-text');
        return sendJson(res, 200, { ok: true, queued: true, id: item.id, queuePosition, estimatedWaitSec });
      }

      return sendJson(res, 400, { error: 'missing_text_or_image' });
    }

    if (req.method === 'GET' && u.pathname.startsWith('/uploads/')) {
      const fp = safeJoin(CFG.uploadDir, u.pathname.slice('/uploads/'.length));
      if (!fp) return notFound(res);
      return fs.readFile(fp, (err, data) => {
        if (err) return notFound(res);
        const ext = path.extname(fp).toLowerCase();
        send(res, 200, data, MIME[ext] || 'application/octet-stream');
      });
    }

    if (req.method === 'GET') {
      const p = u.pathname === '/' ? '/overlay.html' : u.pathname;
      const fp = safeJoin(CFG.publicDir, p);
      if (!fp) return notFound(res);
      return fs.readFile(fp, (err, data) => {
        if (err) return notFound(res);
        send(res, 200, data, MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
      });
    }

    return notFound(res);
  } catch (err) {
    if (String(err?.message) === 'body_too_large') return sendJson(res, 413, { error: 'body_too_large' });
    return sendJson(res, 400, { error: 'bad_request' });
  }
});

server.on('upgrade', (req, socket) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const upgrade = (req.headers.upgrade || '').toLowerCase();
  const secKey = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || !secKey || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const accept = wsAcceptKey(secKey);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  socket._wsBuf = Buffer.alloc(0);
  clients.add(socket);
  sendWs(socket, { type: 'state', reason: 'connected', status: getStatus(), pending, history, announcement: summarizeAnnouncement() });

  socket.on('data', (chunk) => handleWsData(socket, chunk));
  socket.on('close', () => clients.delete(socket));
  socket.on('end', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

server.listen(CFG.port, CFG.bind, () => {
  console.log(`✅ Server: http://${CFG.bind}:${CFG.port}`);
  console.log(`🖥️ Overlay: http://${CFG.bind}:${CFG.port}/overlay.html`);
  console.log(`🧭 Dashboard: http://${CFG.bind}:${CFG.port}/dashboard.html?token=${CFG.adminToken}`);
  console.log(`📤 Upload: http://${CFG.bind}:${CFG.port}/upload.html${CFG.uploadKey ? `?k=${CFG.uploadKey}` : ''}`);
  console.log('ℹ️ No API, no scraping, uploads only.');
});

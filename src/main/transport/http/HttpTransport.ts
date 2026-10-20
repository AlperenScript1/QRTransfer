import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import pino from 'pino';
import { Readable } from 'stream';
import { SessionManager } from '../../session/SessionManager';
import { FileSink } from '../../storage/FileSink';
import { FileMeta } from '../Transport';
import { OutgoingFile } from '../../../shared/types';
import fs from 'fs';

export interface HttpTransportOptions {
  sessionManager: SessionManager;
  fileSink: FileSink;
  host: string;
  port?: number;
  maxFileSizeBytes?: number;
  maxConcurrentUploads?: number;
  onFileReceived?: (file: { name: string; size: number; path: string }) => void;
  getOutgoingFiles?: () => OutgoingFile[];
}

const logger = pino({ level: 'info', redact: ['*.cookie', '*.token', 'req.headers.cookie'] });

export class HttpTransport {
  private app: FastifyInstance | null = null;
  private readonly sessionManager: SessionManager;
  private readonly fileSink: FileSink;
  private readonly host: string;
  private readonly onFileReceived?: (file: { name: string; size: number; path: string }) => void;
  private readonly getOutgoingFiles: () => OutgoingFile[];
  private port = 0;
  private activeUploads = 0;
  private readonly maxConcurrentUploads: number;
  private readonly maxFileSizeBytes: number;

  constructor(options: HttpTransportOptions) {
    this.sessionManager = options.sessionManager;
    this.fileSink = options.fileSink;
    this.host = options.host;
    this.onFileReceived = options.onFileReceived;
    this.getOutgoingFiles = options.getOutgoingFiles ?? (() => []);
    this.maxConcurrentUploads = options.maxConcurrentUploads ?? 2;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? 4 * 1024 * 1024 * 1024;
  }

  public async start(): Promise<{ port: number; url: string }> {
    this.app = Fastify({ logger: false });

    await this.app.register(cookie);
    await this.app.register(multipart, {
      limits: {
        fileSize: this.maxFileSizeBytes,
        files: 1,
        fields: 0
      }
    });

    this.registerRoutes();

    await this.app.listen({ host: this.host, port: 0 });
    const addr = this.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
    this.port = addr.port;

    logger.info({ host: this.host, port: this.port }, 'HTTP server started');
    return { port: this.port, url: `http://${this.host}:${this.port}` };
  }

  public async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      logger.info('HTTP server stopped');
    }
  }

  private registerRoutes(): void {
    if (!this.app) return;

    // Security: Host header validation (DNS rebinding protection)
    this.app.addHook('onRequest', async (req, reply) => {
      const expectedHost = `${this.host}:${this.port}`;
      const reqHost = req.headers.host ?? '';
      if (reqHost !== expectedHost) {
        logger.warn({ reqHost, expectedHost }, 'Host header mismatch');
        return reply.code(400).send({ error: 'bad_request', message: 'Geçersiz Host başlığı' });
      }
    });

    // Security headers on all responses
    this.app.addHook('onSend', async (_req, reply) => {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('Referrer-Policy', 'no-referrer');
      void reply.header('X-Content-Type-Options', 'nosniff');
      void reply.header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
      );
    });

    // GET /s/:token — serve mobile page, set device cookie on first visit
    this.app.get<{ Params: { token: string } }>('/s/:token', async (req, reply) => {
      const { token } = req.params;
      const ip = req.ip ?? 'unknown';
      const userAgent = req.headers['user-agent'];

      const result = this.sessionManager.handleInitialDeviceConnect(token, { ip, userAgent });

      if (!result.success) {
        if (result.error === 'device_mismatch') {
          return reply.code(403).send({ error: 'device_mismatch', message: 'Oturuma başka bir cihaz bağlı' });
        }
        return reply.code(404).send({ error: 'invalid_token', message: 'Geçersiz veya süresi dolmuş bağlantı' });
      }

      // Set HttpOnly device cookie
      void reply.setCookie('deviceId', result.deviceId!, {
        httpOnly: true,
        sameSite: 'strict',
        path: `/s/${token}`
      });

      // Serve mobile page HTML
      const html = getMobilePage(token);
      return reply.code(200).type('text/html; charset=utf-8').send(html);
    });

    // GET /s/:token/status — polling endpoint for mobile page
    this.app.get<{ Params: { token: string } }>('/s/:token/status', async (req, reply) => {
      const { token } = req.params;
      const deviceId = req.cookies['deviceId'];

      if (!this.sessionManager.verifyToken(token)) {
        return reply.code(404).send({ error: 'invalid_token', message: 'Geçersiz token' });
      }

      const session = this.sessionManager.getSession();
      if (!deviceId || !session?.connectedDeviceId) {
        return reply.code(403).send({ error: 'device_mismatch', message: 'Cookie yok' });
      }

      return reply.code(200).send({
        state: session.state,
        limits: {
          maxFileBytes: this.maxFileSizeBytes,
          maxConcurrent: this.maxConcurrentUploads
        }
      });
    });

    this.app.get<{ Params: { token: string } }>('/s/:token/files', async (req, reply) => {
      const check = this.sessionManager.verifyDeviceRequest(req.params.token, req.cookies['deviceId']);
      if (!check.ok) return reply.code(check.status).send({ error: check.error, message: 'Yetkilendirme hatası' });
      return reply.code(200).send({ files: this.getOutgoingFiles().map(({ id, name, size }) => ({ id, name, size })) });
    });

    this.app.get<{ Params: { token: string; id: string } }>('/s/:token/download/:id', async (req, reply) => {
      const check = this.sessionManager.verifyDeviceRequest(req.params.token, req.cookies['deviceId']);
      if (!check.ok) return reply.code(check.status).send({ error: check.error, message: 'Yetkilendirme hatası' });
      const file = this.getOutgoingFiles().find((candidate) => candidate.id === req.params.id);
      if (!file) return reply.code(404).send({ error: 'not_found', message: 'Dosya bulunamadı' });
      try {
        const stats = await fs.promises.stat(file.path);
        if (!stats.isFile()) return reply.code(404).send({ error: 'not_found', message: 'Dosya bulunamadı' });
      } catch {
        return reply.code(404).send({ error: 'not_found', message: 'Dosya bulunamadı' });
      }
      void reply.header('Content-Type', 'application/octet-stream');
      void reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      return reply.send(fs.createReadStream(file.path));
    });

    // WebRTC signalling stays on the authenticated HTTP channel; file bytes
    // travel on the DTLS-encrypted DataChannel when a direct route is available.
    this.app.get<{ Params: { token: string } }>('/s/:token/webrtc/offer', async (req, reply) => {
      const check = this.sessionManager.verifyDeviceRequest(req.params.token, req.cookies['deviceId']);
      if (!check.ok) return reply.code(check.status).send({ error: check.error, message: 'Yetkilendirme hatası' });
      return reply.code(200).send({ offer: this.sessionManager.getWebRtcOffer(), candidates: this.sessionManager.takeDesktopIceCandidates() });
    });

    this.app.post<{ Params: { token: string }; Body: { answer?: unknown; candidates?: unknown } }>('/s/:token/webrtc/answer', async (req, reply) => {
      const check = this.sessionManager.verifyDeviceRequest(req.params.token, req.cookies['deviceId']);
      if (!check.ok) return reply.code(check.status).send({ error: check.error, message: 'Yetkilendirme hatası' });
      const { answer, candidates } = req.body ?? {};
      if (typeof answer === 'string' && answer.length <= 16_384) this.sessionManager.setWebRtcAnswer(answer);
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length <= 16_384) this.sessionManager.addMobileIceCandidate(candidate);
      }
      return reply.code(204).send();
    });

    this.app.post<{ Params: { token: string }; Body: { candidates?: unknown } }>('/s/:token/webrtc/candidates', async (req, reply) => {
      const check = this.sessionManager.verifyDeviceRequest(req.params.token, req.cookies['deviceId']);
      if (!check.ok) return reply.code(check.status).send({ error: check.error, message: 'Yetkilendirme hatası' });
      const candidates = req.body?.candidates;
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length <= 16_384) this.sessionManager.addMobileIceCandidate(candidate);
      }
      return reply.code(204).send();
    });

    // POST /s/:token/upload — receive file
    this.app.post<{ Params: { token: string } }>('/s/:token/upload', async (req, reply) => {
      const { token } = req.params;
      const deviceId = req.cookies['deviceId'];

      const check = this.sessionManager.verifyDeviceRequest(token, deviceId);
      if (!check.ok) {
        const code = check.status;
        return reply.code(code).send({ error: check.error, message: 'Yetkilendirme hatası' });
      }

      if (this.activeUploads >= this.maxConcurrentUploads) {
        return reply.code(429).send({ error: 'too_many_uploads', message: 'Eşzamanlı yükleme limiti aşıldı' });
      }

      const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
      if (!contentLength || isNaN(contentLength)) {
        return reply.code(400).send({ error: 'bad_request', message: 'Content-Length zorunlu' });
      }

      if (contentLength > this.maxFileSizeBytes) {
        return reply.code(413).send({ error: 'file_too_large', message: 'Dosya boyut limiti aşıldı' });
      }

      let data;
      try {
        data = await req.file();
      } catch {
        return reply.code(400).send({ error: 'bad_request', message: 'Multipart ayrıştırma hatası' });
      }

      if (!data) {
        return reply.code(400).send({ error: 'bad_request', message: 'Dosya bulunamadı' });
      }

      this.activeUploads++;
      try {
        const meta: FileMeta = {
          originalName: data.filename
          // Not passing expectedSize: Content-Length is the full multipart envelope,
          // not the raw file size — comparing them causes false size_mismatch errors.
        };

        const result = await this.fileSink.saveFile(meta, data.file as Readable);
        this.sessionManager.touchActivity();

        if (this.onFileReceived) {
          this.onFileReceived({
            name: result.fileName,
            size: result.size,
            path: result.filePath
          });
        }

        return reply.code(201).send({ name: result.fileName, size: result.size });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'upload_error';
        if (msg === 'file_too_large') {
          return reply.code(413).send({ error: 'file_too_large', message: 'Dosya boyut limiti aşıldı' });
        }
        if (msg === 'insufficient_storage') {
          return reply.code(507).send({ error: 'insufficient_storage', message: 'Yetersiz disk alanı' });
        }
        logger.error({ err }, 'Upload error');
        return reply.code(500).send({ error: 'bad_request', message: 'Yükleme hatası' });
      } finally {
        this.activeUploads--;
      }
    });

    // POST /s/:token/close — mobile closes session
    this.app.post<{ Params: { token: string } }>('/s/:token/close', async (req, reply) => {
      const { token } = req.params;
      const deviceId = req.cookies['deviceId'];

      if (!this.sessionManager.verifyToken(token)) {
        return reply.code(404).send({ error: 'invalid_token', message: 'Geçersiz token' });
      }

      const check = this.sessionManager.verifyDeviceRequest(token, deviceId);
      if (!check.ok && check.error !== 'not_active') {
        return reply.code(403).send({ error: check.error, message: 'Yetkilendirme hatası' });
      }

      this.sessionManager.closeSession();
      return reply.code(204).send();
    });

    // 404 for everything else
    this.app.setNotFoundHandler(async (_req, reply) => {
      return reply.code(404).send({ error: 'invalid_token', message: 'Bulunamadı' });
    });
  }
}



function getMobilePage(token: string): string {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QRTransfer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .subtitle { color: #94a3b8; margin-bottom: 2rem; font-size: 0.9rem; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; width: 100%; max-width: 420px; }
  #status-msg { text-align: center; color: #94a3b8; margin-bottom: 1rem; }
  #file-input { display: none; }
  .btn { display: block; width: 100%; padding: 0.75rem; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 0.5rem; }
  .btn:hover { background: #2563eb; }
  .btn:disabled { background: #475569; cursor: not-allowed; }
  .file-item { background: #0f172a; border-radius: 8px; padding: 0.75rem; margin-top: 0.5rem; font-size: 0.85rem; }
  .file-item .name { color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-item .progress { height: 4px; background: #334155; border-radius: 2px; margin-top: 0.5rem; }
  .file-item .progress-bar { height: 100%; background: #3b82f6; border-radius: 2px; width: 0%; transition: width 0.2s; }
  .file-item .status-text { color: #94a3b8; margin-top: 0.25rem; font-size: 0.75rem; }
  .file-item.done .status-text { color: #22c55e; }
  .file-item.error .status-text { color: #ef4444; }
  .retry-btn { font-size: 0.75rem; padding: 0.25rem 0.5rem; background: #475569; border: none; color: #f8fafc; border-radius: 4px; cursor: pointer; margin-top: 0.25rem; }
  #wake-warning { color: #f59e0b; font-size: 0.8rem; text-align: center; margin-top: 1rem; display: none; }
</style>
</head>
<body>
<h1>QRTransfer</h1>
<p class="subtitle">Yerel ağ dosya aktarımı</p>
<div class="card">
  <div id="status-msg">Masaüstü onayı bekleniyor...</div>
  <input type="file" id="file-input" multiple>
  <button class="btn" id="select-btn" disabled>Dosya Seç</button>
  <div id="file-list"></div>
  <div id="desktop-files" style="margin-top:1rem"></div>
</div>
<p id="wake-warning">⚠️ iOS: Ekranınızı açık tutun, arka planda yükleme durabilir.</p>
<script>
const TOKEN = ${JSON.stringify(token)};
let state = 'pending_approval';
let limits = { maxFileBytes: 4 * 1024 * 1024 * 1024, maxConcurrent: 2 };
const selectBtn = document.getElementById('select-btn');
const fileInput = document.getElementById('file-input');
const statusMsg = document.getElementById('status-msg');
const fileList = document.getElementById('file-list');
const wakeWarning = document.getElementById('wake-warning');
const desktopFiles = document.getElementById('desktop-files');
let uploadQueue = [];
let activeUploads = 0;
let desktopFileSignature = '';
let directPeer = null;
let directChannel = null;
let directStarted = false;

function poll() {
  fetch('/s/' + TOKEN + '/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(data => {
      state = data.state;
      if (data.limits) limits = data.limits;
      updateUI();
      if (state === 'active') startDirectTransfer();
      if (state === 'active') refreshDesktopFiles();
      if (state !== 'closed' && state !== 'expired') setTimeout(poll, 1500);
    })
    .catch(() => { if (state !== 'closed') setTimeout(poll, 3000); });
}

async function refreshDesktopFiles() {
  try {
    const response = await fetch('/s/' + TOKEN + '/files', { credentials: 'same-origin' });
    const data = await response.json();
    const signature = JSON.stringify(data.files || []);
    if (signature === desktopFileSignature) return;
    desktopFileSignature = signature;
    desktopFiles.innerHTML = '';
    if (!data.files || data.files.length === 0) return;
    const heading = document.createElement('div');
    heading.textContent = '✓ Bilgisayardan gelen dosyalar';
    heading.style.cssText = 'font-size:.85rem;color:#86efac;margin:.5rem 0;font-weight:600';
    desktopFiles.appendChild(heading);
    data.files.forEach(file => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.5rem;background:#0f2f24;border:1px solid #166534;border-radius:8px;padding:.55rem;margin:.4rem 0';
      const name = document.createElement('div');
      name.textContent = file.name + ' (' + formatSize(file.size) + ')';
      name.style.cssText = 'flex:1;color:#dcfce7;word-break:break-word;font-size:.82rem';
      const link = document.createElement('a');
      link.href = '/s/' + TOKEN + '/download/' + encodeURIComponent(file.id);
      link.textContent = 'İndir ↓';
      link.style.cssText = 'background:#16a34a;color:white;border-radius:6px;padding:.45rem .65rem;text-decoration:none;font-size:.78rem;font-weight:600;white-space:nowrap';
      row.appendChild(name);
      row.appendChild(link);
      desktopFiles.appendChild(row);
    });
  } catch {}
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function updateUI() {
  if (state === 'active') {
    statusMsg.textContent = 'Bağlandı — dosyaları seçin';
    selectBtn.disabled = false;
    wakeWarning.style.display = 'block';
  } else if (state === 'pending_approval') {
    statusMsg.textContent = 'Masaüstü onayı bekleniyor...';
    selectBtn.disabled = true;
  } else if (state === 'denied') {
    statusMsg.textContent = 'Bağlantı reddedildi.';
    selectBtn.disabled = true;
  } else if (state === 'closed' || state === 'expired') {
    statusMsg.textContent = 'Oturum sonlandı.';
    selectBtn.disabled = true;
  }
}

selectBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  files.forEach(f => enqueueFile(f));
});

function enqueueFile(file) {
  const item = createFileItem(file.name);
  uploadQueue.push({ file, item });
  processQueue();
}

function processQueue() {
  const maxConcurrent = directChannel && directChannel.readyState === 'open' ? 1 : limits.maxConcurrent;
  while (activeUploads < maxConcurrent && uploadQueue.length > 0) {
    const { file, item } = uploadQueue.shift();
    uploadFile(file, item);
  }
}

function uploadFile(file, item) {
  if (directChannel && directChannel.readyState === 'open') {
    uploadDirect(file, item);
    return;
  }
  activeUploads++;
  item.statusEl.textContent = 'Yükleniyor...';
  const formData = new FormData();
  formData.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/s/' + TOKEN + '/upload');
  xhr.setRequestHeader('Content-Length', file.size);
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      item.barEl.style.width = pct + '%';
      item.statusEl.textContent = pct + '%';
    }
  };
  xhr.onload = () => {
    activeUploads--;
    if (xhr.status === 201) {
      item.el.classList.add('done');
      item.barEl.style.width = '100%';
      item.statusEl.textContent = 'Tamamlandı ✓';
    } else {
      let msg = 'Hata';
      try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
      showError(item, file, msg);
    }
    processQueue();
  };
  xhr.onerror = () => {
    activeUploads--;
    showError(item, file, 'Bağlantı hatası');
    processQueue();
  };
  xhr.send(formData);
}

async function startDirectTransfer() {
  if (directStarted || !window.RTCPeerConnection) return;
  directStarted = true;
  try {
    const offerResponse = await fetch('/s/' + TOKEN + '/webrtc/offer', { credentials: 'same-origin' });
    const signal = await offerResponse.json();
    if (!signal.offer) { directStarted = false; setTimeout(startDirectTransfer, 500); return; }
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
    directPeer = peer;
    const queuedCandidates = [];
    peer.onicecandidate = async ({ candidate }) => {
      if (!candidate) return;
      queuedCandidates.push(JSON.stringify(candidate.toJSON()));
      await fetch('/s/' + TOKEN + '/webrtc/candidates', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: queuedCandidates.splice(0) }) });
    };
    const channel = peer.createDataChannel('files', { ordered: true });
    channel.binaryType = 'arraybuffer';
    directChannel = channel;
    await peer.setRemoteDescription(JSON.parse(signal.offer));
    for (const candidate of signal.candidates || []) await peer.addIceCandidate(JSON.parse(candidate));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await fetch('/s/' + TOKEN + '/webrtc/answer', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: JSON.stringify(peer.localDescription) }) });
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onopen = () => { statusMsg.textContent = 'Doğrudan bağlantı hazır — hızlı aktarım'; processQueue(); };
    channel.onclose = () => { directChannel = null; };
    setInterval(async () => {
      if (peer.connectionState === 'closed') return;
      try {
        const update = await fetch('/s/' + TOKEN + '/webrtc/offer', { credentials: 'same-origin' });
        const next = await update.json();
        for (const candidate of next.candidates || []) await peer.addIceCandidate(JSON.parse(candidate));
      } catch {}
    }, 500);
  } catch {
    directStarted = false;
  }
}

async function uploadDirect(file, item) {
  activeUploads++;
  item.statusEl.textContent = 'Doğrudan gönderiliyor...';
  try {
    const channel = directChannel;
    channel.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size }));
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      while (channel.bufferedAmount > 1024 * 1024) await new Promise(resolve => {
        const done = () => { channel.removeEventListener('bufferedamountlow', done); resolve(); };
        channel.addEventListener('bufferedamountlow', done, { once: true });
      });
      channel.send(await file.slice(offset, offset + chunkSize).arrayBuffer());
      const pct = Math.round(Math.min(offset + chunkSize, file.size) / file.size * 100);
      item.barEl.style.width = pct + '%';
      item.statusEl.textContent = pct + '%';
    }
    channel.send(JSON.stringify({ type: 'done' }));
    item.el.classList.add('done');
    item.statusEl.textContent = 'Tamamlandı ✓';
  } catch {
    showError(item, file, 'Doğrudan bağlantı koptu; tekrar deneyin');
  } finally {
    activeUploads--;
    processQueue();
  }
}

function showError(item, file, msg) {
  item.el.classList.add('error');
  item.statusEl.textContent = 'Hata: ' + msg;
  const retryBtn = document.createElement('button');
  retryBtn.className = 'retry-btn';
  retryBtn.textContent = 'Tekrar Dene';
  retryBtn.onclick = () => {
    item.el.classList.remove('error');
    item.barEl.style.width = '0%';
    retryBtn.remove();
    uploadQueue.push({ file, item });
    processQueue();
  };
  item.el.appendChild(retryBtn);
}

function createFileItem(name) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.innerHTML = '<div class="name">' + escHtml(name) + '</div><div class="progress"><div class="progress-bar"></div></div><div class="status-text">Bekliyor...</div>';
  fileList.appendChild(el);
  return { el, barEl: el.querySelector('.progress-bar'), statusEl: el.querySelector('.status-text') };
}

function escHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

poll();
</script>
</body>
</html>`;
}

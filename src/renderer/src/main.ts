import type { IElectronAPI, ISessionCreateResult } from '../../preload/index';
import type { OutgoingFile, ReceivedFile, NetworkInterfaceCandidate } from '../../shared/types';

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}

const api = window.electronAPI;

// Elements
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const qrImg = document.getElementById('qr-img') as HTMLImageElement;
const qrPlaceholder = document.getElementById('qr-placeholder') as HTMLDivElement;
const connectUrlEl = document.getElementById('connect-url') as HTMLDivElement;
const wifiHint = document.getElementById('wifi-hint') as HTMLDivElement;
const sessionStatus = document.getElementById('session-status') as HTMLDivElement;
const pairingDialog = document.getElementById('pairing-dialog') as HTMLDivElement;
const pairingInfo = document.getElementById('pairing-info') as HTMLDivElement;
const approveBtn = document.getElementById('approve-btn') as HTMLButtonElement;
const denyBtn = document.getElementById('deny-btn') as HTMLButtonElement;
const ifaceSelect = document.getElementById('iface-select') as HTMLSelectElement;
const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
const filesSection = document.getElementById('files-section') as HTMLDivElement;
const fileList = document.getElementById('file-list') as HTMLDivElement;
const dlDirPath = document.getElementById('dl-dir-path') as HTMLSpanElement;
const chooseDirBtn = document.getElementById('choose-dir-btn') as HTMLButtonElement;
const remoteHint = document.getElementById('remote-hint') as HTMLDivElement;
const chooseOutgoingBtn = document.getElementById('choose-outgoing-btn') as HTMLButtonElement;
const outgoingList = document.getElementById('outgoing-list') as HTMLDivElement;
const languageSelect = document.getElementById('language-select') as HTMLSelectElement;

const receivedFiles: ReceivedFile[] = [];
let webRtcPeer: RTCPeerConnection | null = null;
let webRtcPoll: ReturnType<typeof setInterval> | null = null;
let webRtcWriteChain = Promise.resolve();

type Language = 'en' | 'tr';

const translations: Record<Language, Record<string, string>> = {
  en: {
    subtitle: 'Fast file transfer with a QR code', local: 'Same network (local Wi-Fi)', remote: 'Different network (temporary HTTPS tunnel)',
    qr: 'QR code will appear here', idle: 'Ready to start a session', allow: '✓ Allow', deny: '✕ Deny', start: 'Start new session', close: 'Close',
    folder: '📁 Download folder:', change: 'Change', received: 'Received files', send: 'Send to phone', choose: 'Choose files',
    device: '🔔 A device wants to connect', wifi: '📶 <strong>Same network required:</strong> Connect your phone to the same Wi-Fi network.',
    remoteHint: '🌐 A temporary HTTPS tunnel is used. Share the link only with people you trust.'
  },
  tr: {
    subtitle: 'QR kod ile hızlı dosya aktarımı', local: 'Aynı ağ (yerel Wi-Fi)', remote: 'Farklı ağ (geçici HTTPS tüneli)',
    qr: 'QR kod burada görünecek', idle: 'Oturum başlatmaya hazır', allow: '✓ İzin Ver', deny: '✕ Reddet', start: 'Yeni Oturum Başlat', close: 'Kapat',
    folder: '📁 İndirme klasörü:', change: 'Değiştir', received: 'Alınan Dosyalar', send: 'Telefona Gönder', choose: 'Dosya Seç',
    device: '🔔 Cihaz bağlanmak istiyor', wifi: '📶 <strong>Aynı Ağ Gereklidir:</strong> Telefonunuzu aynı Wi-Fi ağına bağlayın.',
    remoteHint: '🌐 Geçici HTTPS tüneli kullanılır. Bağlantıyı yalnızca güvendiğiniz kişilerle paylaşın.'
  }
};

function applyLanguage(language: Language): void {
  const text = translations[language];
  document.documentElement.lang = language;
  document.querySelector('header p')!.textContent = text.subtitle;
  modeSelect.options[0].textContent = text.local;
  modeSelect.options[1].textContent = text.remote;
  qrPlaceholder.textContent = text.qr;
  approveBtn.textContent = text.allow;
  denyBtn.textContent = text.deny;
  startBtn.textContent = text.start;
  stopBtn.textContent = text.close;
  chooseDirBtn.textContent = text.change;
  chooseOutgoingBtn.textContent = text.choose;
  wifiHint.innerHTML = text.wifi;
  remoteHint.textContent = text.remoteHint;
  pairingDialog.querySelector('h3')!.textContent = text.device;
  filesSection.querySelector('h3')!.textContent = text.received;
  const outgoingHeading = outgoingList.parentElement?.querySelector('h3');
  const folderLabel = dlDirPath.parentElement?.querySelector('span');
  if (outgoingHeading) outgoingHeading.textContent = text.send;
  if (folderLabel) folderLabel.textContent = text.folder;
  if (sessionStatus.classList.contains('idle')) setStatus(text.idle, 'idle');
  localStorage.setItem('qrtransfer-language', language);
}

function setStatus(text: string, cls: 'idle' | 'pending' | 'active' | 'error' = 'idle'): void {
  sessionStatus.textContent = text;
  sessionStatus.className = cls;
}

function showQR(result: ISessionCreateResult): void {
  if (!result.qrDataUrl || !result.connectUrl) return;
  qrImg.src = result.qrDataUrl;
  qrImg.style.display = 'block';
  qrPlaceholder.style.display = 'none';
  connectUrlEl.textContent = result.connectUrl;
  const isRemote = result.mode === 'remote';
  if (wifiHint) wifiHint.style.display = isRemote ? 'none' : 'block';
  remoteHint.style.display = isRemote ? 'block' : 'none';
}

function hideQR(): void {
  qrImg.style.display = 'none';
  qrImg.src = '';
  qrPlaceholder.style.display = 'flex';
  connectUrlEl.textContent = '';
  if (wifiHint) wifiHint.style.display = 'none';
  remoteHint.style.display = 'none';
}

async function loadNetworkCandidates(): Promise<void> {
  const candidates: NetworkInterfaceCandidate[] = await api.getNetworkCandidates();
  ifaceSelect.innerHTML = '';
  candidates.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.address;
    opt.textContent = `${c.name} — ${c.address}${c.isVirtual ? ' (sanal)' : ''}`;
    ifaceSelect.appendChild(opt);
  });
}

async function loadDownloadDir(): Promise<void> {
  const dir = await api.getDownloadDir();
  dlDirPath.textContent = dir;
}

function addFileToList(file: ReceivedFile): void {
  receivedFiles.push(file);
  filesSection.style.display = 'block';

  const entry = document.createElement('div');
  entry.className = 'file-entry';

  const info = document.createElement('div');
  const fname = document.createElement('div');
  fname.className = 'fname';
  fname.textContent = file.name;
  const fsize = document.createElement('div');
  fsize.className = 'fsize';
  fsize.textContent = formatBytes(file.size);
  info.appendChild(fname);
  info.appendChild(fsize);

  const showBtn = document.createElement('button');
  showBtn.className = 'btn btn-sm';
  showBtn.textContent = '📂 Göster';
  showBtn.onclick = () => api.showFileInFolder(file.id);

  entry.appendChild(info);
  entry.appendChild(showBtn);
  fileList.appendChild(entry);
}

function addOutgoingFile(file: OutgoingFile): void {
  const entry = document.createElement('div');
  entry.textContent = `${file.name} — ${formatBytes(file.size)}`;
  outgoingList.appendChild(entry);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function stopWebRtc(): void {
  if (webRtcPoll) clearInterval(webRtcPoll);
  webRtcPoll = null;
  webRtcPeer?.close();
  webRtcPeer = null;
}

async function startWebRtcReceiver(): Promise<void> {
  stopWebRtc();
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
  });
  webRtcPeer = peer;
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) void api.publishDesktopIceCandidate(JSON.stringify(candidate.toJSON()));
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') setStatus('Doğrudan bağlantı aktif — hızlı aktarım hazır', 'active');
  };
  peer.ondatachannel = ({ channel }) => {
    channel.binaryType = 'arraybuffer';
    let transferId: string | null = null;
    channel.onmessage = ({ data }) => {
      webRtcWriteChain = webRtcWriteChain.then(async () => {
        if (typeof data === 'string') {
          const message = JSON.parse(data) as { type: string; name?: string; size?: number };
          if (message.type === 'meta' && typeof message.name === 'string' && typeof message.size === 'number') {
            transferId = await api.startWebRtcFile(message.name, message.size);
          } else if (message.type === 'done' && transferId) {
            await api.finishWebRtcFile(transferId);
            transferId = null;
          }
        } else if (transferId && data instanceof ArrayBuffer) {
          await api.writeWebRtcChunk(transferId, new Uint8Array(data));
        }
      }).catch(() => channel.close());
    };
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await api.publishWebRtcOffer(JSON.stringify(peer.localDescription));
  webRtcPoll = setInterval(() => void pollWebRtc(peer), 400);
}

async function pollWebRtc(peer: RTCPeerConnection): Promise<void> {
  if (peer !== webRtcPeer || peer.connectionState === 'closed') return;
  const answer = await api.getWebRtcAnswer();
  if (answer && !peer.currentRemoteDescription) await peer.setRemoteDescription(JSON.parse(answer) as RTCSessionDescriptionInit);
  for (const candidate of await api.getMobileIceCandidates()) {
    await peer.addIceCandidate(JSON.parse(candidate) as RTCIceCandidateInit);
  }
}

// Event listeners

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('Oturum başlatılıyor...', 'pending');
  hideQR();

  const mode = modeSelect.value === 'remote' ? 'remote' : 'local';
  const result = await api.createSession(mode);
  if (!result.success || !result.qrDataUrl) {
    setStatus(`Hata: ${result.error ?? 'Bilinmeyen hata'}`, 'error');
    startBtn.disabled = false;
    modeSelect.disabled = false;
    return;
  }

  showQR(result);
  setStatus('QR kodu telefonunuzla okutun', 'pending');
  startBtn.disabled = true;
  modeSelect.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', async () => {
  stopWebRtc();
  await api.closeSession();
  hideQR();
  setStatus('Oturum kapatıldı', 'idle');
  startBtn.disabled = false;
  modeSelect.disabled = false;
  stopBtn.disabled = true;
  chooseOutgoingBtn.disabled = true;
  outgoingList.innerHTML = '';
  pairingDialog.style.display = 'none';
});

approveBtn.addEventListener('click', async () => {
  await api.respondPairing(true);
  void startWebRtcReceiver();
  pairingDialog.style.display = 'none';
  setStatus('Bağlantı onaylandı — dosya bekleniyor', 'active');
});

denyBtn.addEventListener('click', async () => {
  await api.respondPairing(false);
  pairingDialog.style.display = 'none';
  hideQR();
  setStatus('Bağlantı reddedildi', 'idle');
  startBtn.disabled = false;
  modeSelect.disabled = false;
  stopBtn.disabled = true;
});

chooseDirBtn.addEventListener('click', async () => {
  const { downloadDir } = await api.chooseDownloadDir();
  dlDirPath.textContent = downloadDir;
});

chooseOutgoingBtn.addEventListener('click', async () => {
  const files = await api.chooseOutgoingFiles();
  files.forEach(addOutgoingFile);
});

// IPC event subscriptions
api.onSessionState((state) => {
  if (state === 'active') {
    setStatus('Aktif — dosya yükleme hazır', 'active');
    chooseOutgoingBtn.disabled = false;
  } else if (state === 'pending_approval') {
    setStatus('Cihaz onay bekliyor...', 'pending');
  } else if (state === 'closed' || state === 'expired') {
    stopWebRtc();
    hideQR();
    setStatus('Oturum sonlandı', 'idle');
    startBtn.disabled = false;
    modeSelect.disabled = false;
    stopBtn.disabled = true;
    chooseOutgoingBtn.disabled = true;
    outgoingList.innerHTML = '';
    pairingDialog.style.display = 'none';
  }
});

api.onPairingRequest((deviceInfo) => {
  pairingInfo.textContent = `IP: ${deviceInfo.ip}${deviceInfo.userAgent ? ' — ' + deviceInfo.userAgent.slice(0, 60) : ''}`;
  pairingDialog.style.display = 'block';
  setStatus('Cihaz bağlanmak istiyor — onaylayın', 'pending');
});

api.onSecondDevice((deviceInfo) => {
  alert(`Uyarı: ${deviceInfo.ip} adresinden ikinci bir cihaz bağlanmaya çalıştı ve reddedildi.`);
});

api.onFileReceived((file) => {
  addFileToList(file);
  setStatus(`Son alınan: ${file.name}`, 'active');
});

// Init
(async () => {
  const savedLanguage = localStorage.getItem('qrtransfer-language');
  const language: Language = savedLanguage === 'tr' ? 'tr' : 'en';
  languageSelect.value = language;
  applyLanguage(language);
  await loadNetworkCandidates();
  await loadDownloadDir();
})();

languageSelect.addEventListener('change', () => {
  applyLanguage(languageSelect.value === 'tr' ? 'tr' : 'en');
});

modeSelect.addEventListener('change', () => {
  const isRemote = modeSelect.value === 'remote';
  ifaceSelect.disabled = isRemote;
});

import { app, BrowserWindow, ipcMain, session, dialog, shell } from 'electron';
import { join } from 'path';
import { basename } from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import qrcode from 'qrcode';
import { SessionManager } from './session/SessionManager';
import { HttpTransport } from './transport/http/HttpTransport';
import { CloudflareTunnel } from './transport/cloudflare/CloudflareTunnel';
import { WebRtcFileReceiver } from './transport/webrtc/WebRtcFileReceiver';
import { FileSink } from './storage/FileSink';
import { getNetworkCandidates, selectDefaultInterface } from './network/networkInfo';
import { NetworkInterfaceCandidate, OutgoingFile, ReceivedFile } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
const sessionManager = new SessionManager();
let httpTransport: HttpTransport | null = null;
let cloudflareTunnel: CloudflareTunnel | null = null;
let transportStopTask: Promise<void> | null = null;
let downloadDir = join(os.homedir(), 'Downloads');
const receivedFiles: ReceivedFile[] = [];
const outgoingFiles: OutgoingFile[] = [];
let webRtcFileReceiver: WebRtcFileReceiver | null = null;

function recordReceivedFile(file: { fileName: string; size: number; filePath: string }): void {
  const rec: ReceivedFile = { id: crypto.randomUUID(), name: file.fileName, size: file.size, path: file.filePath, receivedAt: Date.now() };
  receivedFiles.unshift(rec);
  mainWindow?.webContents.send('file:received', rec);
}

function getApplicationIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'icon.ico')
    : join(process.cwd(), 'resources', 'icon.ico');
}

async function stopActiveTransport(): Promise<void> {
  if (transportStopTask) {
    return transportStopTask;
  }

  const tunnel = cloudflareTunnel;
  const transport = httpTransport;
  cloudflareTunnel = null;
  httpTransport = null;
  webRtcFileReceiver?.abortAll();
  webRtcFileReceiver = null;
  outgoingFiles.length = 0;

  transportStopTask = (async () => {
    tunnel?.stop();
    if (transport) {
      await transport.stop();
    }
  })();

  try {
    await transportStopTask;
  } finally {
    transportStopTask = null;
  }
}

function createWindow(): void {
  console.log('[Main] Creating BrowserWindow...');
  mainWindow = new BrowserWindow({
    title: 'QRTransfer',
    icon: getApplicationIcon(),
    width: 900,
    height: 670,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();

  // Block external navigation & new windows
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  console.log('[Main] createWindow completed!');
}

function setupSecurity(): void {
  const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? "default-src 'self' 'unsafe-inline' data: ws:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: http:;"
      : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';";

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff']
      }
    });
  });
}

// Wire up session events to renderer
function setupSessionEvents(): void {
  sessionManager.on('stateChanged', (event: { state: string }) => {
    mainWindow?.webContents.send('session:state', event.state);
    if (event.state === 'closed' || event.state === 'expired') {
      void stopActiveTransport();
    }
  });

  sessionManager.on('devicePendingApproval', (event: { deviceInfo: { ip: string; userAgent?: string } }) => {
    mainWindow?.webContents.send('pairing:request', event.deviceInfo);
  });

  sessionManager.on('secondDeviceAttempt', (event: { deviceInfo: { ip: string } }) => {
    mainWindow?.webContents.send('session:secondDevice', event.deviceInfo);
  });
}

function registerIpcHandlers(): void {
  // Ping for dev verification
  ipcMain.handle('app:ping', async () => 'pong');

  // Start new session
  ipcMain.handle('session:create', async (_event, requestedMode: unknown) => {
    try {
      const mode = requestedMode === 'remote' ? 'remote' : 'local';
      // Close any existing transport
      await stopActiveTransport();

      // A remote session is intentionally loopback-only; only cloudflared can
      // reach the origin. Local sessions retain the selected LAN behavior.
      const candidates = getNetworkCandidates();
      const iface = selectDefaultInterface(candidates);

      if (mode === 'local' && !iface) {
        return { success: false, error: 'Ağ arayüzü bulunamadı. Lütfen Wi-Fi veya Ethernet bağlantısını kontrol edin.' };
      }

      // Create session + token
      const sessionObj = sessionManager.createSession();

      // Start HTTP server
      const fileSink = new FileSink({ downloadDir });
      webRtcFileReceiver = new WebRtcFileReceiver(fileSink, recordReceivedFile);
      httpTransport = new HttpTransport({
        sessionManager,
        fileSink,
        host: mode === 'remote' ? '127.0.0.1' : iface!.address,
        onFileReceived: (file) => {
          recordReceivedFile({ fileName: file.name, size: file.size, filePath: file.path });
        },
        getOutgoingFiles: () => outgoingFiles
      });

      const { port, url } = await httpTransport.start();
      let publicBaseUrl = url;
      if (mode === 'remote') {
        cloudflareTunnel = new CloudflareTunnel();
        publicBaseUrl = await cloudflareTunnel.start(url);
      }
      const connectUrl = `${publicBaseUrl}/s/${sessionObj.token}`;

      // Generate QR as data URL
      const qrDataUrl = await qrcode.toDataURL(connectUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 6
      });

      return {
        success: true,
        qrDataUrl,
        connectUrl,
        host: mode === 'remote' ? 'HTTPS tüneli' : iface!.address,
        port,
        interfaceName: mode === 'remote' ? 'Cloudflare Quick Tunnel' : iface!.name,
        candidates: candidates as NetworkInterfaceCandidate[],
        mode
      };
    } catch (err) {
      console.error('[IPC session:create]', err);
      await stopActiveTransport();
      sessionManager.closeSession();
      return { success: false, error: String(err) };
    }
  });

  // Close session
  ipcMain.handle('session:close', async () => {
    sessionManager.closeSession();
    await stopActiveTransport();
    return { success: true };
  });

  // Respond to pairing request
  ipcMain.handle('pairing:respond', async (_event, approved: boolean) => {
    sessionManager.respondPairing(approved);
    return { success: true };
  });

  ipcMain.handle('webrtc:offer', async (_event, offer: unknown) => {
    if (typeof offer === 'string' && offer.length <= 16_384) sessionManager.setWebRtcOffer(offer);
  });
  ipcMain.handle('webrtc:answer', async () => sessionManager.takeWebRtcAnswer());
  ipcMain.handle('webrtc:desktop-candidate', async (_event, candidate: unknown) => {
    if (typeof candidate === 'string' && candidate.length <= 16_384) sessionManager.addDesktopIceCandidate(candidate);
  });
  ipcMain.handle('webrtc:mobile-candidates', async () => sessionManager.takeMobileIceCandidates());
  ipcMain.handle('webrtc:file-start', async (_event, name: unknown, size: unknown) => {
    if (typeof name !== 'string' || typeof size !== 'number' || !webRtcFileReceiver) throw new Error('bad_request');
    return webRtcFileReceiver.start(name, size);
  });
  ipcMain.handle('webrtc:file-chunk', async (_event, id: unknown, chunk: unknown) => {
    if (typeof id !== 'string' || !(chunk instanceof Uint8Array) || !webRtcFileReceiver) throw new Error('bad_request');
    await webRtcFileReceiver.write(id, chunk);
  });
  ipcMain.handle('webrtc:file-finish', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !webRtcFileReceiver) throw new Error('bad_request');
    await webRtcFileReceiver.finish(id);
  });

  // Get session state
  ipcMain.handle('session:state', async () => {
    const s = sessionManager.getSession();
    return s?.state ?? 'idle';
  });

  // Get received files list
  ipcMain.handle('file:list', async () => {
    return receivedFiles;
  });

  ipcMain.handle('outgoing:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    const selected: OutgoingFile[] = [];
    for (const filePath of result.filePaths) {
      try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) continue;
        const file: OutgoingFile = { id: crypto.randomUUID(), name: basename(filePath), size: stats.size, path: filePath };
        outgoingFiles.push(file);
        selected.push(file);
      } catch {
        // Files that disappear before selection are ignored.
      }
    }
    return selected;
  });

  // Show file in folder
  ipcMain.handle('file:showInFolder', async (_event, id: string) => {
    const f = receivedFiles.find((r) => r.id === id);
    if (f) {
      shell.showItemInFolder(f.path);
    }
    return { success: true };
  });

  // Choose download directory
  ipcMain.handle('settings:chooseDownloadDir', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) {
      downloadDir = result.filePaths[0];
    }
    return { downloadDir };
  });

  // Get network candidates
  ipcMain.handle('network:candidates', async () => {
    return getNetworkCandidates();
  });

  // Get download dir
  ipcMain.handle('settings:getDownloadDir', async () => downloadDir);
}

app.whenReady().then(() => {
  console.log('[Main] app.whenReady reached!');
  setupSecurity();
  setupSessionEvents();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  sessionManager.closeSession();
  void stopActiveTransport().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

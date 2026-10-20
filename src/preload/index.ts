import { contextBridge, ipcRenderer } from 'electron';
import { NetworkInterfaceCandidate, OutgoingFile, ReceivedFile } from '../shared/types';

export interface ISessionCreateResult {
  success: boolean;
  error?: string;
  qrDataUrl?: string;
  connectUrl?: string;
  host?: string;
  port?: number;
  interfaceName?: string;
  candidates?: NetworkInterfaceCandidate[];
  mode?: 'local' | 'remote';
}

export interface IElectronAPI {
  ping: () => Promise<string>;
  createSession: (mode: 'local' | 'remote') => Promise<ISessionCreateResult>;
  closeSession: () => Promise<{ success: boolean }>;
  respondPairing: (approved: boolean) => Promise<{ success: boolean }>;
  getSessionState: () => Promise<string>;
  getFileList: () => Promise<ReceivedFile[]>;
  showFileInFolder: (id: string) => Promise<void>;
  chooseDownloadDir: () => Promise<{ downloadDir: string }>;
  getDownloadDir: () => Promise<string>;
  getNetworkCandidates: () => Promise<NetworkInterfaceCandidate[]>;
  chooseOutgoingFiles: () => Promise<OutgoingFile[]>;
  publishWebRtcOffer: (offer: string) => Promise<void>;
  getWebRtcAnswer: () => Promise<string | undefined>;
  publishDesktopIceCandidate: (candidate: string) => Promise<void>;
  getMobileIceCandidates: () => Promise<string[]>;
  startWebRtcFile: (name: string, size: number) => Promise<string>;
  writeWebRtcChunk: (id: string, chunk: Uint8Array) => Promise<void>;
  finishWebRtcFile: (id: string) => Promise<void>;

  onSessionState: (cb: (state: string) => void) => () => void;
  onPairingRequest: (cb: (deviceInfo: { ip: string; userAgent?: string }) => void) => () => void;
  onSecondDevice: (cb: (deviceInfo: { ip: string }) => void) => () => void;
  onFileReceived: (cb: (file: ReceivedFile) => void) => () => void;
}

const api: IElectronAPI = {
  ping: () => ipcRenderer.invoke('app:ping'),
  createSession: (mode) => ipcRenderer.invoke('session:create', mode),
  closeSession: () => ipcRenderer.invoke('session:close'),
  respondPairing: (approved) => ipcRenderer.invoke('pairing:respond', approved),
  getSessionState: () => ipcRenderer.invoke('session:state'),
  getFileList: () => ipcRenderer.invoke('file:list'),
  showFileInFolder: (id) => ipcRenderer.invoke('file:showInFolder', id),
  chooseDownloadDir: () => ipcRenderer.invoke('settings:chooseDownloadDir'),
  getDownloadDir: () => ipcRenderer.invoke('settings:getDownloadDir'),
  getNetworkCandidates: () => ipcRenderer.invoke('network:candidates'),
  chooseOutgoingFiles: () => ipcRenderer.invoke('outgoing:choose'),
  publishWebRtcOffer: (offer) => ipcRenderer.invoke('webrtc:offer', offer),
  getWebRtcAnswer: () => ipcRenderer.invoke('webrtc:answer'),
  publishDesktopIceCandidate: (candidate) => ipcRenderer.invoke('webrtc:desktop-candidate', candidate),
  getMobileIceCandidates: () => ipcRenderer.invoke('webrtc:mobile-candidates'),
  startWebRtcFile: (name, size) => ipcRenderer.invoke('webrtc:file-start', name, size),
  writeWebRtcChunk: (id, chunk) => ipcRenderer.invoke('webrtc:file-chunk', id, chunk),
  finishWebRtcFile: (id) => ipcRenderer.invoke('webrtc:file-finish', id),

  onSessionState: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, state: string) => cb(state);
    ipcRenderer.on('session:state', handler);
    return () => ipcRenderer.removeListener('session:state', handler);
  },

  onPairingRequest: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, deviceInfo: { ip: string; userAgent?: string }) =>
      cb(deviceInfo);
    ipcRenderer.on('pairing:request', handler);
    return () => ipcRenderer.removeListener('pairing:request', handler);
  },

  onSecondDevice: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, deviceInfo: { ip: string }) => cb(deviceInfo);
    ipcRenderer.on('session:secondDevice', handler);
    return () => ipcRenderer.removeListener('session:secondDevice', handler);
  },

  onFileReceived: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, file: ReceivedFile) => cb(file);
    ipcRenderer.on('file:received', handler);
    return () => ipcRenderer.removeListener('file:received', handler);
  }
};

contextBridge.exposeInMainWorld('electronAPI', api);

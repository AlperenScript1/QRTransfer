import { IElectronAPI } from '../../preload';

declare global {
  interface Window {
    electronAPI: IElectronAPI;
  }
}

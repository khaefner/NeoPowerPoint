import { contextBridge, ipcRenderer } from 'electron';

export interface PresenterAPI {
  onSyncState: (callback: (state: any) => void) => () => void;
  navigateSlide: (index: number) => void;
  nextSlide: () => void;
  prevSlide: () => void;
}

const api: PresenterAPI = {
  onSyncState: (callback) => {
    const handler = (_: any, state: any) => callback(state);
    ipcRenderer.on('presenter:state-update', handler);
    return () => ipcRenderer.removeListener('presenter:state-update', handler);
  },
  navigateSlide: (index) => ipcRenderer.send('presenter:navigate', index),
  nextSlide: () => ipcRenderer.send('presenter:next'),
  prevSlide: () => ipcRenderer.send('presenter:prev')
};

contextBridge.exposeInMainWorld('presenterAPI', api);

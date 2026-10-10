import { contextBridge, ipcRenderer } from 'electron';
import { InkSyncAction } from '../types/ink';

export interface PresenterAPI {
  onSyncState: (callback: (state: any) => void) => () => void;
  navigateSlide: (index: number) => void;
  nextSlide: () => void;
  prevSlide: () => void;
  // Inking
  onInkAction: (callback: (action: InkSyncAction) => void) => () => void;
  sendInkAction: (action: InkSyncAction) => void;
  // ADB Tablet controls
  getAdbStatus: () => Promise<any>;
  launchTabletBrowser: () => Promise<{ success: boolean; error?: string }>;
  onAdbDevicesChanged: (callback: (devices: any[]) => void) => () => void;
}

const api: PresenterAPI = {
  onSyncState: (callback) => {
    const handler = (_: any, state: any) => callback(state);
    ipcRenderer.on('presenter:state-update', handler);
    return () => ipcRenderer.removeListener('presenter:state-update', handler);
  },
  navigateSlide: (index) => ipcRenderer.send('presenter:navigate', index),
  nextSlide: () => ipcRenderer.send('presenter:next'),
  prevSlide: () => ipcRenderer.send('presenter:prev'),

  // Ink
  onInkAction: (callback) => {
    const handler = (_: any, action: InkSyncAction) => callback(action);
    ipcRenderer.on('ink:action', handler);
    return () => ipcRenderer.removeListener('ink:action', handler);
  },
  sendInkAction: (action) => ipcRenderer.send('ink:host-action', action),

  // ADB
  getAdbStatus: () => ipcRenderer.invoke('adb:get-status'),
  launchTabletBrowser: () => ipcRenderer.invoke('adb:launch-tablet'),
  onAdbDevicesChanged: (callback) => {
    const handler = (_: any, devices: any[]) => callback(devices);
    ipcRenderer.on('adb:devices-changed', handler);
    return () => ipcRenderer.removeListener('adb:devices-changed', handler);
  },
};

contextBridge.exposeInMainWorld('presenterAPI', api);

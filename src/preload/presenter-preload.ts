import { contextBridge, ipcRenderer } from 'electron';
import { InkSyncAction, SlideScrollAction, SlideDomSyncAction, SlideInteractionAction } from '../types/ink';

export interface PresenterAPI {
  onSyncState: (callback: (state: any) => void) => () => void;
  navigateSlide: (index: number) => void;
  nextSlide: () => void;
  prevSlide: () => void;
  // Inking
  onInkAction: (callback: (action: InkSyncAction) => void) => () => void;
  sendInkAction: (action: InkSyncAction) => void;
  // Two-way Interaction & Viewport Synchronization
  sendInteraction: (action: SlideInteractionAction) => void;
  onInteraction: (callback: (action: SlideInteractionAction) => void) => () => void;
  sendSlideScroll: (action: SlideScrollAction) => void;
  onSlideScroll: (callback: (action: SlideScrollAction) => void) => () => void;
  sendSlideDom: (action: SlideDomSyncAction) => void;
  onSlideDomSync: (callback: (action: SlideDomSyncAction) => void) => () => void;
  onSlideFrame: (callback: (frame: { slideIndex: number; data: string }) => void) => () => void;
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

  // Interactions & Synchronizations
  sendInteraction: (action) => ipcRenderer.send('slide:interaction', action),
  onInteraction: (callback) => {
    const handler = (_: any, action: SlideInteractionAction) => callback(action);
    ipcRenderer.on('slide:interaction', handler);
    return () => ipcRenderer.removeListener('slide:interaction', handler);
  },
  sendSlideScroll: (action) => ipcRenderer.send('slide:sync-scroll', action),
  onSlideScroll: (callback) => {
    const handler = (_: any, action: SlideScrollAction) => callback(action);
    ipcRenderer.on('slide:scroll', handler);
    return () => ipcRenderer.removeListener('slide:scroll', handler);
  },
  sendSlideDom: (action) => ipcRenderer.send('slide:sync-dom', action),
  onSlideDomSync: (callback) => {
    const handler = (_: any, action: SlideDomSyncAction) => callback(action);
    ipcRenderer.on('slide:dom-sync', handler);
    return () => ipcRenderer.removeListener('slide:dom-sync', handler);
  },
  onSlideFrame: (callback) => {
    const handler = (_: any, frame: any) => callback(frame);
    ipcRenderer.on('slide:frame', handler);
    return () => ipcRenderer.removeListener('slide:frame', handler);
  },

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


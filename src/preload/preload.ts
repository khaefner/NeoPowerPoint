import { contextBridge, ipcRenderer } from 'electron';
import { DeckManifest } from '../types/deck';

export interface ElectronAPI {
  openFolderDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  openPackageDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  exportPackageDialog: () => Promise<string | null>;
  createNewDeckDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  loadSampleDeck: () => Promise<{ deckPath: string; manifest: DeckManifest }>;
  saveManifest: (manifest: DeckManifest) => Promise<boolean>;
  addNewSlide: (title: string) => Promise<DeckManifest | null>;
  toggleFullscreen: () => Promise<boolean>;
  setWindowedPresentation: (enabled: boolean) => Promise<void>;
  openPresenterWindow: () => Promise<boolean>;
  closePresenterWindow: () => Promise<void>;
  syncStateToPresenter: (state: any) => void;
  onFileChanged: (callback: (data: { filePath: string; eventType: string }) => void) => () => void;
  onNavigateSlide: (callback: (index: number) => void) => () => void;
  onToggleFullscreenEvent: (callback: () => void) => () => void;
  onToggleWindowedEvent: (callback: () => void) => () => void;
  onOpenPresenterEvent: (callback: () => void) => () => void;
  onReloadSlideEvent: (callback: () => void) => () => void;
}

const api: ElectronAPI = {
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openPackageDialog: () => ipcRenderer.invoke('dialog:open-package'),
  exportPackageDialog: () => ipcRenderer.invoke('dialog:export-package'),
  createNewDeckDialog: () => ipcRenderer.invoke('dialog:create-deck'),
  loadSampleDeck: () => ipcRenderer.invoke('deck:load-sample'),
  saveManifest: (manifest) => ipcRenderer.invoke('deck:save-manifest', manifest),
  addNewSlide: (title) => ipcRenderer.invoke('deck:add-slide', title),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  setWindowedPresentation: (enabled) => ipcRenderer.invoke('window:set-windowed', enabled),
  openPresenterWindow: () => ipcRenderer.invoke('presenter:open'),
  closePresenterWindow: () => ipcRenderer.invoke('presenter:close'),
  syncStateToPresenter: (state) => ipcRenderer.send('presenter:sync-state', state),

  onFileChanged: (callback) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('deck:file-changed', handler);
    return () => ipcRenderer.removeListener('deck:file-changed', handler);
  },

  onNavigateSlide: (callback) => {
    const handler = (_: any, index: number) => callback(index);
    ipcRenderer.on('slide:navigate', handler);
    return () => ipcRenderer.removeListener('slide:navigate', handler);
  },

  onToggleFullscreenEvent: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:toggle-fullscreen', handler);
    return () => ipcRenderer.removeListener('menu:toggle-fullscreen', handler);
  },

  onToggleWindowedEvent: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:toggle-windowed', handler);
    return () => ipcRenderer.removeListener('menu:toggle-windowed', handler);
  },

  onOpenPresenterEvent: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:open-presenter', handler);
    return () => ipcRenderer.removeListener('menu:open-presenter', handler);
  },

  onReloadSlideEvent: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:reload-slide', handler);
    return () => ipcRenderer.removeListener('menu:reload-slide', handler);
  }
};

contextBridge.exposeInMainWorld('electronAPI', api);

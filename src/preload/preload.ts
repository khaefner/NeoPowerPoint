import { contextBridge, ipcRenderer } from 'electron';
import { DeckManifest } from '../types/deck';
import { AISettings, GenerateSlideRequest, GenerateSlideResponse } from '../types/ai';

export interface ElectronAPI {
  openFolderDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  openPackageDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  importPptxDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  exportPackageDialog: () => Promise<string | null>;
  createNewDeckDialog: () => Promise<{ deckPath: string; manifest: DeckManifest } | null>;
  loadSampleDeck: () => Promise<{ deckPath: string; manifest: DeckManifest }>;
  saveManifest: (manifest: DeckManifest) => Promise<boolean>;
  saveSlideHtml: (slideRelPath: string, htmlContent: string) => Promise<boolean>;
  getManifest: () => Promise<DeckManifest | null>;
  addNewSlide: (title: string, insertAfterIndex?: number) => Promise<DeckManifest | null>;
  addWebSlide: (title: string, url: string, insertAfterIndex?: number) => Promise<DeckManifest | null>;
  addCustomSlide: (title: string, htmlContent: string, insertAfterIndex?: number) => Promise<DeckManifest | null>;
  duplicateSlide: (slideIndex: number) => Promise<DeckManifest | null>;
  deleteSlide: (slideIndex: number) => Promise<DeckManifest | null>;
  aiGetSettings: () => Promise<AISettings>;
  aiSaveSettings: (settings: AISettings) => Promise<boolean>;
  aiGenerateSlide: (req: GenerateSlideRequest) => Promise<GenerateSlideResponse>;
  toggleFullscreen: () => Promise<boolean>;
  setWindowedPresentation: (enabled: boolean) => Promise<void>;
  openPresenterWindow: () => Promise<boolean>;
  closePresenterWindow: () => Promise<void>;
  syncStateToPresenter: (state: any) => void;
  onFileChanged: (callback: (data: { filePath: string; eventType: string }) => void) => () => void;
  onNavigateSlide: (callback: (index: number) => void) => () => void;
  onDeckLoadedEvent: (callback: (data: { deckPath: string; manifest: DeckManifest }) => void) => () => void;
  onToggleFullscreenEvent: (callback: () => void) => () => void;
  onToggleWindowedEvent: (callback: () => void) => () => void;
  onOpenPresenterEvent: (callback: () => void) => () => void;
  onReloadSlideEvent: (callback: () => void) => () => void;
  onSetPresentationModeEvent: (callback: (enabled: boolean) => void) => () => void;
  onInkAction: (callback: (action: any) => void) => () => void;
  sendInkAction: (action: any) => void;
  getAdbStatus: () => Promise<any>;
  launchTabletBrowser: () => Promise<{ success: boolean; error?: string }>;
}

const api: ElectronAPI = {
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openPackageDialog: () => ipcRenderer.invoke('dialog:open-package'),
  importPptxDialog: () => ipcRenderer.invoke('dialog:import-pptx'),
  exportPackageDialog: () => ipcRenderer.invoke('dialog:export-package'),
  createNewDeckDialog: () => ipcRenderer.invoke('dialog:create-deck'),
  loadSampleDeck: () => ipcRenderer.invoke('deck:load-sample'),
  saveManifest: (manifest) => ipcRenderer.invoke('deck:save-manifest', manifest),
  saveSlideHtml: (slideRelPath, htmlContent) => ipcRenderer.invoke('deck:save-slide-html', slideRelPath, htmlContent),
  getManifest: () => ipcRenderer.invoke('deck:get-manifest'),
  addNewSlide: (title, insertAfterIndex) => ipcRenderer.invoke('deck:add-slide', title, insertAfterIndex),
  addWebSlide: (title, url, insertAfterIndex) => ipcRenderer.invoke('deck:add-web-slide', title, url, insertAfterIndex),
  addCustomSlide: (title, htmlContent, insertAfterIndex) => ipcRenderer.invoke('deck:add-custom-slide', title, htmlContent, insertAfterIndex),
  duplicateSlide: (slideIndex) => ipcRenderer.invoke('deck:duplicate-slide', slideIndex),
  deleteSlide: (slideIndex) => ipcRenderer.invoke('deck:delete-slide', slideIndex),
  aiGetSettings: () => ipcRenderer.invoke('ai:get-settings'),
  aiSaveSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  aiGenerateSlide: (req) => ipcRenderer.invoke('ai:generate-slide', req),
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

  onDeckLoadedEvent: (callback) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('deck:loaded', handler);
    return () => ipcRenderer.removeListener('deck:loaded', handler);
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
  },

  onSetPresentationModeEvent: (callback) => {
    const handler = (_: any, enabled: boolean) => callback(enabled);
    ipcRenderer.on('deck:set-presentation-mode', handler);
    return () => ipcRenderer.removeListener('deck:set-presentation-mode', handler);
  },

  onInkAction: (callback) => {
    const handler = (_: any, action: any) => callback(action);
    ipcRenderer.on('ink:action', handler);
    return () => ipcRenderer.removeListener('ink:action', handler);
  },
  sendInkAction: (action) => ipcRenderer.send('ink:host-action', action),
  getAdbStatus: () => ipcRenderer.invoke('adb:get-status'),
  launchTabletBrowser: () => ipcRenderer.invoke('adb:launch-tablet'),
};

contextBridge.exposeInMainWorld('electronAPI', api);

import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DeckService } from './deck-service';
import { DeckWatcher } from './watcher';
import { registerCustomProtocolScheme, setupCustomProtocolHandler } from './protocol';
import { DeckManifest } from '../types/deck';
import { AIService } from './ai-service';
import { AISettings, GenerateSlideRequest } from '../types/ai';
import { ADBService } from './adb-service';
import { SyncServer } from './sync-server';
import { InkStore } from './ink-store';
import { InkSyncAction, SlideScrollAction, SlideDomSyncAction } from '../types/ink';
import { logger } from './logger';

process.on('uncaughtException', (err) => {
  logger.error('MainProcess', 'Uncaught Exception', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('MainProcess', 'Unhandled Promise Rejection', reason);
});

// Append no-sandbox if needed in Linux environments
app.commandLine.appendSwitch('no-sandbox');

registerCustomProtocolScheme();

let mainWindow: BrowserWindow | null = null;
let presenterWindow: BrowserWindow | null = null;
let latestPresenterState: any = null;

const deckService = new DeckService();
const aiService = new AIService();
const inkStore = new InkStore();
const syncServer = new SyncServer(deckService, inkStore, 8765);
const adbService = new ADBService(8765);

function broadcastToWindows(channel: string, data: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send(channel, data);
  }
}

// Wire SyncServer and ADBService events
adbService.on('devices-changed', (devices) => {
  broadcastToWindows('adb:devices-changed', devices);
});

syncServer.on('slide:navigate', (target) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:navigate', target);
  }
});

syncServer.on('ink:stroke-start', (stroke) => {
  broadcastToWindows('ink:action', { type: 'ink:stroke-start', stroke });
});

syncServer.on('ink:stroke-update', (id, points) => {
  broadcastToWindows('ink:action', { type: 'ink:stroke-update', id, points });
});

syncServer.on('ink:stroke-end', (id) => {
  broadcastToWindows('ink:action', { type: 'ink:stroke-end', id });
});

syncServer.on('ink:undo', (slideIndex) => {
  broadcastToWindows('ink:action', { type: 'ink:undo', slideIndex });
});

syncServer.on('ink:clear', (slideIndex) => {
  broadcastToWindows('ink:action', { type: 'ink:clear', slideIndex });
});

syncServer.on('ink:sync-slide', (slideIndex, strokes) => {
  broadcastToWindows('ink:action', { type: 'ink:sync-slide', slideIndex, strokes });
});

let latestSlideRect: Electron.Rectangle | null = null;
let lastCapturedBuffer: Buffer | null = null;
let isCapturing = false;
let captureThrottleTimer: NodeJS.Timeout | null = null;
let pendingCaptureRequest = false;
let captureStreamInterval: NodeJS.Timeout | null = null;
let isFrameSubscriptionActive = false;
let captureTimeoutTimer: NodeJS.Timeout | null = null;

async function captureAndBroadcastSlide(force: boolean = false): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  if (syncServer.getConnectedClientCount() === 0) return;
  if (isCapturing) {
    pendingCaptureRequest = true;
    return;
  }

  isCapturing = true;
  if (captureTimeoutTimer) clearTimeout(captureTimeoutTimer);
  captureTimeoutTimer = setTimeout(() => {
    isCapturing = false;
  }, 2000);

  try {
    const winSize = mainWindow.getContentSize();
    let rect: Electron.Rectangle | undefined;

    if (latestSlideRect && latestSlideRect.width > 20 && latestSlideRect.height > 20) {
      const x = Math.max(0, Math.min(Math.round(latestSlideRect.x), Math.max(1, winSize[0] - 20)));
      const y = Math.max(0, Math.min(Math.round(latestSlideRect.y), Math.max(1, winSize[1] - 20)));
      const w = Math.max(20, Math.min(Math.round(latestSlideRect.width), winSize[0] - x));
      const h = Math.max(20, Math.min(Math.round(latestSlideRect.height), winSize[1] - y));
      rect = { x, y, width: w, height: h };
    }

    const image = await mainWindow.webContents.capturePage(rect);
    if (!image.isEmpty()) {
      let finalImage = image;
      const imgSize = image.getSize();
      // On macOS Retina (or high-DPI displays), downscale to logical DIPs for fast transmission & e-ink decoding
      if (rect && imgSize.width > rect.width * 1.25) {
        finalImage = image.resize({ width: Math.round(rect.width), quality: 'good' });
      }
      const buffer = finalImage.toJPEG(65);
      if (buffer.length > 0) {
        if (force || !lastCapturedBuffer || !buffer.equals(lastCapturedBuffer)) {
          lastCapturedBuffer = buffer;
          const dataUri = 'data:image/jpeg;base64,' + buffer.toString('base64');
          const slideIndex = latestPresenterState?.currentIndex ?? 0;
          syncServer.broadcastSlideFrame(dataUri, slideIndex);
        }
      }
    }
  } catch (err: any) {
    logger.warn('MainProcess', `capturePage error: ${err.message}`);
  } finally {
    if (captureTimeoutTimer) {
      clearTimeout(captureTimeoutTimer);
      captureTimeoutTimer = null;
    }
    isCapturing = false;
    if (pendingCaptureRequest) {
      pendingCaptureRequest = false;
      scheduleSlideCapture(false, 30);
    }
  }
}

function scheduleSlideCapture(force: boolean = false, delayMs: number = 60): void {
  if (syncServer.getConnectedClientCount() === 0) return;
  if (captureThrottleTimer) {
    pendingCaptureRequest = true;
    return;
  }

  captureThrottleTimer = setTimeout(() => {
    captureThrottleTimer = null;
    captureAndBroadcastSlide(force);
  }, delayMs);
}

function updateCaptureStreamingState(clientCount: number): void {
  logger.info('MainProcess', `updateCaptureStreamingState called, clientCount=${clientCount}`);
  if (clientCount > 0) {
    if (!captureStreamInterval) {
      captureStreamInterval = setInterval(() => {
        if (syncServer.getConnectedClientCount() > 0 && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
          captureAndBroadcastSlide(false);
        }
      }, 120);
      logger.info('MainProcess', 'Started background slide capture interval (120ms)');
    }

    if (!isFrameSubscriptionActive && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.beginFrameSubscription(false, () => {
          scheduleSlideCapture(false, 50);
        });
        isFrameSubscriptionActive = true;
        logger.info('MainProcess', 'Started webContents.beginFrameSubscription');
      } catch (err: any) {
        logger.warn('MainProcess', `beginFrameSubscription unavailable: ${err.message}`);
      }
    }

    scheduleSlideCapture(true, 50);
  } else {
    if (captureStreamInterval) {
      clearInterval(captureStreamInterval);
      captureStreamInterval = null;
      logger.info('MainProcess', 'Stopped background slide capture interval');
    }
    if (isFrameSubscriptionActive && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.endFrameSubscription();
      } catch (_) {}
      isFrameSubscriptionActive = false;
      logger.info('MainProcess', 'Stopped webContents.beginFrameSubscription');
    }
    lastCapturedBuffer = null;
  }
}

syncServer.on('client-count-changed', (count) => {
  updateCaptureStreamingState(count);
});

const deckWatcher = new DeckWatcher((filePath, eventType) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deck:file-changed', { filePath, eventType });
  }
});

function createMainWindow(): void {
  logger.info('MainProcess', 'Creating main window');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'NeoPowerPoint',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const levelMap: Record<number, 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'> = {
      0: 'DEBUG',
      1: 'INFO',
      2: 'WARN',
      3: 'ERROR'
    };
    logger.log(levelMap[level] || 'INFO', 'RendererConsole', message);
  });

  mainWindow.loadURL('neopres://deck/renderer/index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    if (syncServer.getConnectedClientCount() > 0) {
      updateCaptureStreamingState(syncServer.getConnectedClientCount());
    }
  });

  mainWindow.on('closed', () => {
    updateCaptureStreamingState(0);
    mainWindow = null;
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.close();
    }
    deckWatcher.stop();
  });

  buildAppMenu();
}

function openPresenterWindow(): boolean {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.focus();
    return true;
  }

  // Find displays
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id);

  // Automatically put audience presentation window into Fullscreen
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (secondaryDisplay) {
      // If external projector/secondary monitor is attached, place audience window there
      mainWindow.setBounds(secondaryDisplay.bounds);
      mainWindow.setFullScreen(true);
    } else {
      // On single monitor, audience window goes fullscreen presentation
      mainWindow.setFullScreen(true);
    }
    mainWindow.webContents.send('deck:set-presentation-mode', true);
  }

  // Open Presenter View on the primary presenter monitor
  presenterWindow = new BrowserWindow({
    x: primaryDisplay.bounds.x + 40,
    y: primaryDisplay.bounds.y + 40,
    width: Math.min(1150, primaryDisplay.bounds.width - 80),
    height: Math.min(780, primaryDisplay.bounds.height - 80),
    minWidth: 700,
    minHeight: 500,
    title: 'NeoPowerPoint — Presenter View',
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '../preload/presenter-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
    }
  });

  presenterWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[PRESENTER CONSOLE]: ${message}`);
  });

  presenterWindow.loadURL('neopres://deck/presenter/index.html');

  presenterWindow.webContents.on('did-finish-load', () => {
    if (latestPresenterState && presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.webContents.send('presenter:state-update', latestPresenterState);
      const currentIndex = latestPresenterState.currentIndex || 0;
      const strokes = inkStore.getStrokes(currentIndex);
      presenterWindow.webContents.send('ink:action', {
        type: 'ink:sync-slide',
        slideIndex: currentIndex,
        strokes
      });
    }
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.webContents.send('adb:devices-changed', adbService.getStatus().devices);
    }
  });

  presenterWindow.on('closed', () => {
    presenterWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
      mainWindow.webContents.send('deck:set-presentation-mode', false);
    }
  });

  return true;
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: any[] = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Presentation Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (mainWindow) {
              const res = await handleOpenFolder();
              if (res) mainWindow.webContents.send('deck:loaded', res);
            }
          }
        },
        {
          label: 'Open .neopres Package...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            if (mainWindow) {
              const res = await handleOpenPackage();
              if (res) mainWindow.webContents.send('deck:loaded', res);
            }
          }
        },
        {
          label: 'Import PowerPoint (.pptx)...',
          accelerator: 'CmdOrCtrl+I',
          click: async () => {
            if (mainWindow) {
              const res = await handleImportPptx();
              if (res) mainWindow.webContents.send('deck:loaded', res);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Export as .neopres Package...',
          accelerator: 'CmdOrCtrl+E',
          click: async () => {
            await handleExportPackage();
          }
        },
        {
          label: 'New Presentation...',
          accelerator: 'CmdOrCtrl+N',
          click: async () => {
            if (mainWindow) {
              const res = await handleCreateDeck();
              if (res) mainWindow.webContents.send('deck:loaded', res);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Export Debug Logs...',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: async () => {
            await logger.exportLogs(mainWindow || undefined);
          }
        },
        {
          label: 'Open Logs Folder',
          click: async () => {
            await logger.openLogDir();
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Fullscreen Mode',
          accelerator: 'F11',
          click: () => {
            if (mainWindow) {
              mainWindow.setFullScreen(!mainWindow.isFullScreen());
              mainWindow.webContents.send('menu:toggle-fullscreen');
            }
          }
        },
        {
          label: 'Toggle Windowed Presentation Mode',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu:toggle-windowed');
            }
          }
        },
        {
          label: 'Open Presenter View',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            openPresenterWindow();
          }
        },
        {
          label: 'Reload Slide (Live Edit)',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu:reload-slide');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Slide',
      submenu: [
        {
          label: 'Next Slide',
          accelerator: 'Right',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('slide:navigate', 'next');
          }
        },
        {
          label: 'Previous Slide',
          accelerator: 'Left',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('slide:navigate', 'prev');
          }
        },
        {
          label: 'First Slide',
          accelerator: 'Home',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('slide:navigate', 0);
          }
        },
        {
          label: 'Last Slide',
          accelerator: 'End',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('slide:navigate', 'last');
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu:help-shortcuts');
          }
        },
        { type: 'separator' },
        {
          label: 'Export Debug Logs...',
          click: async () => {
            await logger.exportLogs(mainWindow || undefined);
          }
        },
        {
          label: 'Open Logs Folder',
          click: async () => {
            await logger.openLogDir();
          }
        },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Helpers for folder & package selection
async function handleOpenFolder() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Presentation Folder',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const folderPath = result.filePaths[0];
  const deckData = await deckService.openFolder(folderPath);
  inkStore.resetAll();
  deckWatcher.watch(folderPath);
  return deckData;
}

async function handleOpenPackage() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select .neopres Presentation Package',
    filters: [
      { name: 'NeoPowerPoint Package (*.neopres, *.zip)', extensions: ['neopres', 'zip'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const packagePath = result.filePaths[0];
  const deckData = await deckService.openPackage(packagePath);
  inkStore.resetAll();
  deckWatcher.watch(deckData.deckPath);
  return deckData;
}

async function handleExportPackage() {
  const activeDeckPath = deckService.getActiveDeckPath();
  if (!activeDeckPath || !mainWindow) {
    if (mainWindow) {
      dialog.showErrorBox('No Active Presentation', 'Please open a presentation folder before exporting.');
    }
    return null;
  }

  const manifest = deckService.getActiveManifest();
  const defaultFilename = `${(manifest?.title || 'presentation').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.neopres`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Presentation Package',
    defaultPath: defaultFilename,
    filters: [
      { name: 'NeoPowerPoint Package (*.neopres)', extensions: ['neopres'] },
      { name: 'Zip Archive (*.zip)', extensions: ['zip'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  await deckService.exportPackage(activeDeckPath, result.filePath);
  return result.filePath;
}

async function handleCreateDeck() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Empty Folder for New Presentation',
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const folderPath = result.filePaths[0];
  const deckData = await deckService.createNewDeck(folderPath, path.basename(folderPath));
  inkStore.resetAll();
  deckWatcher.watch(folderPath);
  return deckData;
}

async function handleImportPptx() {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select PowerPoint Presentation (.pptx)',
    filters: [
      { name: 'PowerPoint Presentation (*.pptx, *.ppt)', extensions: ['pptx', 'ppt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    logger.info('MainProcess', 'PPTX file selection canceled');
    return null;
  }

  const pptxPath = result.filePaths[0];
  logger.info('MainProcess', `Importing PowerPoint file: ${pptxPath}`);
  try {
    const deckData = await deckService.importPptx(pptxPath);
    inkStore.resetAll();
    deckWatcher.watch(deckData.deckPath);
    logger.info('MainProcess', `Successfully imported PPTX into: ${deckData.deckPath}`);
    return deckData;
  } catch (err: any) {
    logger.error('MainProcess', `Failed to import PowerPoint file: ${pptxPath}`, err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('deck:import-error', {
        error: err.message,
        details: err.stack || String(err)
      });
    }
    throw err;
  }
}

// IPC Handlers
ipcMain.handle('dialog:open-folder', async () => handleOpenFolder());
ipcMain.handle('dialog:open-package', async () => handleOpenPackage());
ipcMain.handle('dialog:import-pptx', async () => handleImportPptx());
ipcMain.handle('dialog:export-package', async () => handleExportPackage());
ipcMain.handle('dialog:create-deck', async () => handleCreateDeck());
ipcMain.handle('dialog:export-logs', async () => logger.exportLogs(mainWindow || undefined));
ipcMain.handle('dialog:open-logs-folder', async () => logger.openLogDir());
ipcMain.handle('logger:get-logs', async () => logger.generateDiagnosticReport());
ipcMain.handle('logger:log', async (_event, level: any, message: string, details?: any) => {
  logger.log(level || 'INFO', 'Renderer', message, details);
});

ipcMain.handle('deck:load-sample', async () => {
  const sampleDir = path.join(__dirname, '../../sample-deck');
  if (fs.existsSync(sampleDir)) {
    const deckData = await deckService.openFolder(sampleDir);
    inkStore.resetAll();
    deckWatcher.watch(sampleDir);
    return deckData;
  }
  // Otherwise create in temp directory
  const tempSample = path.join(app.getPath('userData'), 'Sample-Presentation');
  const deckData = await deckService.createNewDeck(tempSample, 'NeoPowerPoint Interactive Demo');
  deckWatcher.watch(tempSample);
  return deckData;
});

ipcMain.handle('deck:save-manifest', async (_, manifest: DeckManifest) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return false;
  await deckService.saveManifest(activePath, manifest);
  return true;
});

ipcMain.handle('deck:save-slide-html', async (_, slideRelPath: string, htmlContent: string) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return false;
  return deckService.saveSlideHtml(activePath, slideRelPath, htmlContent);
});

ipcMain.handle('deck:get-manifest', async () => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  const manifestPath = path.join(activePath, 'deck.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return deckService.getActiveManifest();
    }
  }
  return deckService.getActiveManifest();
});

ipcMain.handle('deck:add-slide', async (_, title: string, insertAfterIndex?: number) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.addNewSlide(activePath, title, insertAfterIndex);
});

ipcMain.handle('deck:add-web-slide', async (_, title: string, url: string, insertAfterIndex?: number) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.addWebSlide(activePath, title, url, insertAfterIndex);
});

ipcMain.handle('deck:add-custom-slide', async (_, title: string, htmlContent: string, insertAfterIndex?: number) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.addCustomSlide(activePath, title, htmlContent, insertAfterIndex);
});

ipcMain.handle('deck:duplicate-slide', async (_, slideIndex: number) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.duplicateSlide(activePath, slideIndex);
});

ipcMain.handle('deck:delete-slide', async (_, slideIndex: number) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.deleteSlide(activePath, slideIndex);
});

// AI Designer Endpoints
ipcMain.handle('ai:get-settings', async () => {
  return aiService.getSettings();
});

ipcMain.handle('ai:save-settings', async (_, settings: AISettings) => {
  return aiService.saveSettings(settings);
});

ipcMain.handle('ai:generate-slide', async (_, req: GenerateSlideRequest) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) {
    return { success: false, error: 'No presentation currently open' };
  }
  return aiService.generateSlide({
    ...req,
    deckPath: activePath
  });
});

ipcMain.handle('window:toggle-fullscreen', async () => {
  if (!mainWindow) return false;
  const isFs = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(isFs);
  return isFs;
});

ipcMain.handle('window:set-windowed', async (_, enabled: boolean) => {
  // If windowed presentation enabled, exit OS fullscreen if active
  if (enabled && mainWindow?.isFullScreen()) {
    mainWindow.setFullScreen(false);
  }
});

ipcMain.handle('presenter:open', async () => {
  return openPresenterWindow();
});

ipcMain.handle('presenter:close', async () => {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.close();
  }
});

ipcMain.on('presenter:sync-state', (_, state) => {
  const oldIndex = latestPresenterState?.currentIndex;
  latestPresenterState = state;
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('presenter:state-update', state);
  }
  syncServer.updateSlideState(state);
  if (oldIndex !== state?.currentIndex) {
    lastCapturedBuffer = null;
    scheduleSlideCapture(true, 150);
    setTimeout(() => scheduleSlideCapture(true, 400), 400);
  } else {
    scheduleSlideCapture(false, 50);
  }
});

ipcMain.on('slide:update-rect', (_, rect) => {
  latestSlideRect = rect;
});

ipcMain.on('slide:request-capture', (_, rect) => {
  if (rect) {
    latestSlideRect = rect;
  }
  scheduleSlideCapture(false, 30);
});

ipcMain.on('ink:host-action', (event, action: InkSyncAction) => {
  syncServer.broadcastHostInkAction(action);
  // Relay action to the opposite window
  if (mainWindow && event.sender === mainWindow.webContents) {
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.webContents.send('ink:action', action);
    }
  } else if (presenterWindow && event.sender === presenterWindow.webContents) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ink:action', action);
    }
  }
});

ipcMain.on('slide:sync-scroll', (_, action: SlideScrollAction) => {
  syncServer.broadcastSlideScroll(action);
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('slide:scroll', action);
  }
});

ipcMain.on('slide:sync-dom', (_, action: SlideDomSyncAction) => {
  syncServer.broadcastSlideDom(action);
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('slide:dom-sync', action);
  }
});

// ADB IPC Handlers
ipcMain.handle('adb:get-status', async () => {
  return adbService.getStatus();
});

ipcMain.handle('adb:setup-reverse', async (_, deviceId?: string) => {
  return adbService.setupReverse(deviceId);
});

ipcMain.handle('adb:launch-tablet', async (_, deviceId?: string) => {
  return adbService.launchTabletBrowser(deviceId);
});

ipcMain.on('presenter:navigate', (_, index: number) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:navigate', index);
  }
});

ipcMain.on('presenter:next', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:navigate', 'next');
  }
});

ipcMain.on('presenter:prev', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:navigate', 'prev');
  }
});

// App Lifecycle
app.whenReady().then(async () => {
  setupCustomProtocolHandler(deckService);
  try {
    const port = await syncServer.start();
    if (typeof port === 'number') {
      adbService.setPort(port);
    }
    adbService.startMonitoring(3000);
    logger.info('MainProcess', `SyncServer started on port ${port}, ADB monitoring active`);
  } catch (err: any) {
    logger.error('MainProcess', 'Error starting sync server or ADB service', err);
  }
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  adbService.stopMonitoring();
  syncServer.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

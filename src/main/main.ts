import { app, BrowserWindow, dialog, ipcMain, Menu, screen, clipboard, shell } from 'electron';
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
import { InkSyncAction, SlideScrollAction, SlideDomSyncAction, SlideInteractionAction } from '../types/ink';
import { logger } from './logger';
import { displayManager } from './display-manager';

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
let isCapturingPage = false;
let captureThrottleTimer: NodeJS.Timeout | null = null;
let pendingCaptureRequest = false;
let pendingForceCapture = false;
let captureStreamInterval: NodeJS.Timeout | null = null;
let isFrameSubscriptionActive = false;
let captureTimeoutTimer: NodeJS.Timeout | null = null;
const MIN_CAPTURE_INTERVAL_MS = 160; // Max ~6 FPS to protect system RAM and match e-ink refresh rates
let lastCaptureTime = 0;

function hasCaptureConsumer(): boolean {
  return syncServer.getConnectedClientCount() > 0;
}

async function captureAndBroadcastSlide(force: boolean = false): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  if (!hasCaptureConsumer()) return;
  if (isCapturing) {
    pendingCaptureRequest = true;
    if (force) pendingForceCapture = true;
    return;
  }

  isCapturing = true;
  isCapturingPage = true;
  if (captureTimeoutTimer) clearTimeout(captureTimeoutTimer);
  captureTimeoutTimer = setTimeout(() => {
    isCapturing = false;
    isCapturingPage = false;
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
    isCapturingPage = false;

    if (!image.isEmpty()) {
      let finalImage = image;
      const imgSize = image.getSize();
      // Cap max dimension to 1280 to prevent excessive buffer allocation on high-res displays
      const maxW = 1280;
      if (imgSize.width > maxW) {
        const ratio = maxW / imgSize.width;
        finalImage = image.resize({ width: maxW, height: Math.round(imgSize.height * ratio), quality: 'good' });
      } else if (rect && imgSize.width > rect.width * 1.25) {
        finalImage = image.resize({ width: Math.round(rect.width), quality: 'good' });
      }
      const buffer = finalImage.toJPEG(60);
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
    isCapturingPage = false;
    lastCaptureTime = Date.now();
    if (pendingCaptureRequest) {
      const nextForce = pendingForceCapture;
      pendingCaptureRequest = false;
      pendingForceCapture = false;
      scheduleSlideCapture(nextForce, MIN_CAPTURE_INTERVAL_MS);
    }
  }
}

function scheduleSlideCapture(force: boolean = false, delayMs: number = 60): void {
  if (!hasCaptureConsumer()) return;
  if (force) pendingForceCapture = true;
  if (captureThrottleTimer) {
    pendingCaptureRequest = true;
    return;
  }

  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  const waitMs = Math.max(delayMs, MIN_CAPTURE_INTERVAL_MS - elapsed);

  captureThrottleTimer = setTimeout(() => {
    captureThrottleTimer = null;
    const executeForce = pendingForceCapture || force;
    pendingForceCapture = false;
    captureAndBroadcastSlide(executeForce);
  }, Math.max(0, waitMs));
}

function updateCaptureStreamingState(): void {
  const active = hasCaptureConsumer();
  logger.info('MainProcess', `updateCaptureStreamingState: active=${active} (tablets: ${syncServer.getConnectedClientCount()}, presenter: ${!!presenterWindow})`);
  if (active) {
    if (!captureStreamInterval) {
      captureStreamInterval = setInterval(() => {
        if (hasCaptureConsumer() && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
          scheduleSlideCapture(false, 0);
        }
      }, 1000);
      logger.info('MainProcess', 'Started background slide capture heartbeat (1000ms)');
    }

    if (!isFrameSubscriptionActive && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.beginFrameSubscription(false, () => {
          if (isCapturingPage) return;
          scheduleSlideCapture(false, MIN_CAPTURE_INTERVAL_MS);
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

syncServer.on('client-count-changed', () => {
  updateCaptureStreamingState();
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:') || details.url.startsWith('mailto:')) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menuTemplate: any[] = [];
    if (params.isEditable) {
      menuTemplate.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      menuTemplate.push(
        { role: 'copy' },
        { role: 'selectAll' }
      );
    }
    if (menuTemplate.length > 0) {
      Menu.buildFromTemplate(menuTemplate).popup({ window: mainWindow || undefined });
    }
  });

  mainWindow.loadURL('neopres://deck/renderer/index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    updateCaptureStreamingState();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    updateCaptureStreamingState();
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.close();
    }
    deckWatcher.stop();
  });

  buildAppMenu();
}

async function openPresenterWindow(): Promise<boolean> {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.focus();
    return true;
  }

  // Auto-extend mirrored displays if present (matches Microsoft PowerPoint behavior)
  try {
    await displayManager.ensureExtendedDisplays();
  } catch (err) {
    logger.warn('MainProcess', `Display auto-extend attempt encountered error: ${err}`);
  }

  // Find displays
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id &&
    (d.bounds.x !== primaryDisplay.bounds.x || d.bounds.y !== primaryDisplay.bounds.y));

  const isSwapped = displayManager.getIsSwapped();
  const audienceDisplay = secondaryDisplay ? (isSwapped ? primaryDisplay : secondaryDisplay) : primaryDisplay;
  const presenterDisplay = secondaryDisplay ? (isSwapped ? secondaryDisplay : primaryDisplay) : primaryDisplay;

  // Automatically put audience presentation window into Fullscreen on audienceDisplay
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(false);
    mainWindow.setBounds(audienceDisplay.bounds);
    mainWindow.setFullScreen(true);
    mainWindow.webContents.send('deck:set-presentation-mode', true);
  }

  // Open Presenter View on presenterDisplay
  presenterWindow = new BrowserWindow({
    x: presenterDisplay.bounds.x + (secondaryDisplay ? 40 : 30),
    y: presenterDisplay.bounds.y + (secondaryDisplay ? 40 : 30),
    width: Math.min(1150, presenterDisplay.bounds.width - (secondaryDisplay ? 80 : 60)),
    height: Math.min(780, presenterDisplay.bounds.height - (secondaryDisplay ? 80 : 60)),
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

  presenterWindow.webContents.on('console-message', (_event, level, message) => {
    const levelMap: Record<number, 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'> = {
      0: 'DEBUG',
      1: 'INFO',
      2: 'WARN',
      3: 'ERROR'
    };
    logger.log(levelMap[level] || 'INFO', 'PresenterConsole', message);
  });

  presenterWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:') || details.url.startsWith('mailto:')) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  presenterWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  presenterWindow.webContents.on('context-menu', (_e, params) => {
    const menuTemplate: any[] = [];
    if (params.isEditable) {
      menuTemplate.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      menuTemplate.push(
        { role: 'copy' },
        { role: 'selectAll' }
      );
    }
    if (menuTemplate.length > 0) {
      Menu.buildFromTemplate(menuTemplate).popup({ window: presenterWindow || undefined });
    }
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
    updateCaptureStreamingState();
  });

  presenterWindow.on('closed', async () => {
    presenterWindow = null;
    updateCaptureStreamingState();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
      mainWindow.webContents.send('deck:set-presentation-mode', false);
    }
    // Restore display configuration if auto-extended (matches Microsoft PowerPoint)
    await displayManager.restoreDisplayMode();
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
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
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

ipcMain.handle('deck:save-notes', async (_, slideRelPath: string, notesContent: string, notesPath?: string) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.saveSlideNotes(activePath, slideRelPath, notesContent, notesPath);
});

ipcMain.handle('deck:load-notes', async (_, notesPathOrSlidePath: string) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return '';
  return deckService.loadSlideNotes(activePath, notesPathOrSlidePath);
});

ipcMain.handle('deck:open-notes-in-browser', async (_, slideRelPath: string) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return false;
  let notesRelPath = slideRelPath.replace(/\\/g, '/');
  if (notesRelPath.endsWith('/index.html')) {
    notesRelPath = notesRelPath.replace(/\/index\.html$/, '/notes.html');
  } else if (!notesRelPath.endsWith('.html')) {
    notesRelPath += '.html';
  } else if (!notesRelPath.endsWith('notes.html')) {
    notesRelPath = notesRelPath.replace(/\.html$/, '-notes.html');
  }
  const fullPath = path.resolve(activePath, notesRelPath);
  if (fs.existsSync(fullPath)) {
    await shell.openPath(fullPath);
    return true;
  }
  return false;
});

ipcMain.handle('clipboard:read-text', async () => {
  return clipboard.readText();
});

ipcMain.handle('clipboard:read-image', async () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toDataURL();
});

ipcMain.handle('clipboard:write-text', async (_, text: string) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('shell:open-external', async (_, url: string) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:'))) {
    await shell.openExternal(url);
    return true;
  }
  return false;
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

ipcMain.handle('presenter:swap-displays', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, isSwapped: false };
  const isSwapped = displayManager.swapDisplays(mainWindow, presenterWindow);
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('presenter:display-status-changed', {
      isSwapped,
      hasMultipleDisplays: screen.getAllDisplays().length > 1
    });
  }
  return { success: true, isSwapped };
});

ipcMain.handle('presenter:duplicate-slideshow', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await displayManager.duplicateSlideShow(mainWindow, presenterWindow);
});

ipcMain.handle('presenter:end-slideshow', async () => {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.close();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(false);
    mainWindow.webContents.send('deck:set-presentation-mode', false);
    await displayManager.restoreDisplayMode();
  }
});

ipcMain.handle('presenter:get-display-status', async () => {
  const state = await displayManager.detectDisplayState();
  return {
    hasMultipleDisplays: state.hasMultipleDisplays,
    isMirrored: state.isMirrored,
    isSwapped: displayManager.getIsSwapped(),
    autoExtendEnabled: displayManager.isAutoExtendEnabled()
  };
});

ipcMain.handle('presenter:set-auto-extend', async (_event, enabled: boolean) => {
  displayManager.setAutoExtendEnabled(enabled);
  return { success: true, autoExtendEnabled: displayManager.isAutoExtendEnabled() };
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

ipcMain.on('slide:interaction', (event, action: SlideInteractionAction) => {
  if (mainWindow && event.sender !== mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:interaction', action);
  }
  if (presenterWindow && event.sender !== presenterWindow.webContents && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('slide:interaction', action);
  }
});

ipcMain.on('slide:sync-scroll', (event, action: SlideScrollAction) => {
  syncServer.broadcastSlideScroll(action);
  if (mainWindow && event.sender !== mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:scroll', action);
  }
  if (presenterWindow && event.sender !== presenterWindow.webContents && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('slide:scroll', action);
  }
});

ipcMain.on('slide:sync-dom', (event, action: SlideDomSyncAction) => {
  syncServer.broadcastSlideDom(action);
  if (mainWindow && event.sender !== mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('slide:dom-sync', action);
  }
  if (presenterWindow && event.sender !== presenterWindow.webContents && !presenterWindow.isDestroyed()) {
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

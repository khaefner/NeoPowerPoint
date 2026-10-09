import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DeckService } from './deck-service';
import { DeckWatcher } from './watcher';
import { registerCustomProtocolScheme, setupCustomProtocolHandler } from './protocol';
import { DeckManifest } from '../types/deck';

// Append no-sandbox if needed in Linux environments
app.commandLine.appendSwitch('no-sandbox');

registerCustomProtocolScheme();

let mainWindow: BrowserWindow | null = null;
let presenterWindow: BrowserWindow | null = null;
let latestPresenterState: any = null;

const deckService = new DeckService();
const deckWatcher = new DeckWatcher((filePath, eventType) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deck:file-changed', { filePath, eventType });
  }
});

function createMainWindow(): void {
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

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[RENDERER CONSOLE]: ${message}`);
  });

  mainWindow.loadURL('neopres://deck/renderer/index.html');

  mainWindow.on('closed', () => {
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
  deckWatcher.watch(folderPath);
  return deckData;
}

// IPC Handlers
ipcMain.handle('dialog:open-folder', async () => handleOpenFolder());
ipcMain.handle('dialog:open-package', async () => handleOpenPackage());
ipcMain.handle('dialog:export-package', async () => handleExportPackage());
ipcMain.handle('dialog:create-deck', async () => handleCreateDeck());

ipcMain.handle('deck:load-sample', async () => {
  const sampleDir = path.join(__dirname, '../../sample-deck');
  if (fs.existsSync(sampleDir)) {
    const deckData = await deckService.openFolder(sampleDir);
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

ipcMain.handle('deck:add-slide', async (_, title: string) => {
  const activePath = deckService.getActiveDeckPath();
  if (!activePath) return null;
  return deckService.addNewSlide(activePath, title);
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
  latestPresenterState = state;
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.webContents.send('presenter:state-update', state);
  }
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
app.whenReady().then(() => {
  setupCustomProtocolHandler(deckService);
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

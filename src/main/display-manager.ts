import { screen, BrowserWindow, Display } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface LinuxOutputInfo {
  name: string;
  isPrimary: boolean;
  hasMode: boolean;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface DisplayStateInfo {
  hasMultipleDisplays: boolean;
  isMirrored: boolean;
  displays: Display[];
  primaryDisplay: Display;
  secondaryDisplay?: Display;
  linuxOutputs?: {
    connectedCount: number;
    primary?: string;
    secondary?: string;
    isMirrored: boolean;
  };
}

export class DisplayManager {
  private wasAutoExtended = false;
  private autoExtendEnabled = true;
  private originalLinuxConfig: {
    primaryOutput: string;
    secondaryOutput: string;
    wasMirrored: boolean;
  } | null = null;
  private originalWindowsMirrored = false;
  private originalMacOSMirrored = false;
  private isSwapped = false;

  constructor() {}

  public isAutoExtendEnabled(): boolean {
    return this.autoExtendEnabled;
  }

  public setAutoExtendEnabled(enabled: boolean): void {
    this.autoExtendEnabled = enabled;
    logger.info('DisplayManager', `Auto-extend mirrored displays set to: ${enabled}`);
  }

  /**
   * Parse xrandr --query stdout to identify connected outputs and their positions.
   * Exposed as a static method for deterministic unit testing.
   */
  public static parseXrandrQuery(stdout: string): {
    connectedOutputs: LinuxOutputInfo[];
    primary?: string;
    secondary?: string;
    isMirrored: boolean;
  } {
    const lines = stdout.split('\n');
    const connectedOutputs: LinuxOutputInfo[] = [];

    for (const line of lines) {
      // e.g.:
      // "Virtual-1 connected primary 1920x1080+0+0 (normal..."
      // "HDMI-1 connected 1512x911+0+0 (normal..."
      // "Virtual-2 connected (normal..." (connected but no crtc/mode yet)
      const match = line.match(/^([A-Za-z0-9_-]+)\s+connected\s+(primary\s+)?(?:(\d+)x(\d+)\+(\d+)\+(\d+))?/);
      if (match) {
        const name = match[1];
        const isPrimary = !!match[2];
        const width = match[3] !== undefined ? parseInt(match[3], 10) : undefined;
        const height = match[4] !== undefined ? parseInt(match[4], 10) : undefined;
        const x = match[5] !== undefined ? parseInt(match[5], 10) : undefined;
        const y = match[6] !== undefined ? parseInt(match[6], 10) : undefined;
        const hasMode = width !== undefined && height !== undefined && x !== undefined && y !== undefined;
        connectedOutputs.push({ name, isPrimary, hasMode, width, height, x, y });
      }
    }

    if (connectedOutputs.length < 2) {
      return {
        connectedOutputs,
        primary: connectedOutputs[0]?.name,
        isMirrored: false
      };
    }

    const primary = connectedOutputs.find(c => c.isPrimary) || connectedOutputs[0];
    const secondary = connectedOutputs.find(c => c.name !== primary.name) || connectedOutputs[1];

    // Mirrored check:
    // 1) Both outputs have modes and share the same offsets (e.g. +0+0)
    // 2) Secondary is connected without an active mode while primary is active (standard clone on some display managers)
    const isMirrored = (
      (primary.hasMode && secondary.hasMode && primary.x === secondary.x && primary.y === secondary.y) ||
      (!secondary.hasMode && primary.hasMode)
    );

    return {
      connectedOutputs,
      primary: primary.name,
      secondary: secondary.name,
      isMirrored
    };
  }

  /**
   * Queries xrandr on Linux to detect connected monitors and mirrored configurations.
   */
  public async queryXrandr(): Promise<{
    connectedCount: number;
    primary?: string;
    secondary?: string;
    isMirrored: boolean;
  }> {
    const { stdout } = await execAsync('xrandr --query');
    const parsed = DisplayManager.parseXrandrQuery(stdout);
    return {
      connectedCount: parsed.connectedOutputs.length,
      primary: parsed.primary,
      secondary: parsed.secondary,
      isMirrored: parsed.isMirrored
    };
  }

  /**
   * Detects if multiple displays are connected and whether they are mirrored.
   */
  public async detectDisplayState(): Promise<DisplayStateInfo> {
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    let secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id &&
      (d.bounds.x !== primaryDisplay.bounds.x || d.bounds.y !== primaryDisplay.bounds.y));

    // Check if Electron reports multiple displays that share coordinates (mirrored/cloned)
    let isMirrored = false;
    if (displays.length > 1) {
      isMirrored = displays.some((d, i) =>
        displays.some((o, j) => i !== j && Math.abs(d.bounds.x - o.bounds.x) < 5 && Math.abs(d.bounds.y - o.bounds.y) < 5)
      );
    }

    let linuxOutputs: { connectedCount: number; primary?: string; secondary?: string; isMirrored: boolean } | undefined;
    if (process.platform === 'linux') {
      try {
        const xrandrInfo = await this.queryXrandr();
        linuxOutputs = xrandrInfo;
        if (xrandrInfo.isMirrored) {
          isMirrored = true;
        }
      } catch (err) {
        logger.debug('DisplayManager', `xrandr query skipped or unavailable: ${err}`);
      }
    }

    const hasMultipleDisplays = displays.length > 1 || (linuxOutputs && linuxOutputs.connectedCount > 1);

    return {
      hasMultipleDisplays: !!hasMultipleDisplays,
      isMirrored,
      displays,
      primaryDisplay,
      secondaryDisplay,
      linuxOutputs
    };
  }

  /**
   * Automatically extends mirrored displays for presentation (matches Microsoft PowerPoint behavior).
   * When an external display is plugged in and mirrored, PowerPoint extends the desktop so Presenter View
   * can be shown on the presenter's screen and clean full-screen slides on the external screen.
   */
  public async ensureExtendedDisplays(): Promise<boolean> {
    if (!this.autoExtendEnabled) {
      logger.info('DisplayManager', 'Auto-extend mirrored displays is disabled by user setting.');
      return false;
    }

    const state = await this.detectDisplayState();
    logger.info('DisplayManager', `Display state check before presentation: ${JSON.stringify({
      hasMultiple: state.hasMultipleDisplays,
      isMirrored: state.isMirrored,
      electronDisplayCount: state.displays.length,
      linuxOutputs: state.linuxOutputs
    })}`);

    if (!state.isMirrored) {
      logger.info('DisplayManager', 'Displays are already extended or single display. No auto-extension required.');
      return false;
    }

    // Auto-extend mirrored displays on Linux (X11)
    if (process.platform === 'linux' && state.linuxOutputs?.secondary && state.linuxOutputs?.primary) {
      try {
        const { primary, secondary } = state.linuxOutputs;
        logger.info('DisplayManager', `Linux: Auto-extending external display ${secondary} to the right of ${primary}`);
        await execAsync(`xrandr --output "${secondary}" --right-of "${primary}" --auto`);
        this.wasAutoExtended = true;
        this.originalLinuxConfig = {
          primaryOutput: primary,
          secondaryOutput: secondary,
          wasMirrored: true
        };
        // Give X11 and Electron screen manager time to register the layout geometry
        await new Promise(r => setTimeout(r, 450));
        return true;
      } catch (err) {
        logger.warn('DisplayManager', `Failed to un-mirror display via xrandr: ${err}`);
      }
    } else if (process.platform === 'win32') {
      try {
        logger.info('DisplayManager', 'Windows: Auto-extending display via displayswitch.exe /extend');
        await execAsync('displayswitch.exe /extend');
        this.wasAutoExtended = true;
        this.originalWindowsMirrored = true;
        await new Promise(r => setTimeout(r, 500));
        return true;
      } catch (err) {
        logger.warn('DisplayManager', `Failed to un-mirror display via displayswitch: ${err}`);
      }
    } else if (process.platform === 'darwin') {
      try {
        const unmirrored = await this.unmirrorMacOS();
        if (unmirrored) {
          this.wasAutoExtended = true;
          this.originalMacOSMirrored = true;
          await new Promise(r => setTimeout(r, 500));
          return true;
        }
      } catch (err) {
        logger.warn('DisplayManager', `macOS auto-extend attempt encountered error: ${err}`);
      }
    }

    return false;
  }

  /**
   * Attempts to un-mirror external displays on macOS using CoreGraphics via Swift or installed CLI utilities.
   */
  private async unmirrorMacOS(): Promise<boolean> {
    // 1. Check if 'betterdisplaycli' is available
    try {
      await execAsync('betterdisplaycli set -mirroring=off');
      logger.info('DisplayManager', 'macOS: Un-mirrored displays via betterdisplaycli');
      return true;
    } catch (_) {}

    // 2. Check if 'mirror' CLI tool is available
    try {
      await execAsync('mirror -off');
      logger.info('DisplayManager', 'macOS: Un-mirrored displays via mirror CLI');
      return true;
    } catch (_) {}

    // 3. Execute CoreGraphics display configuration via Swift
    try {
      const swiftScript = `
import CoreGraphics
var config: CGDisplayConfigRef?
if CGBeginDisplayConfiguration(&config) == .success, let c = config {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    if count > 1 {
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetOnlineDisplayList(count, &displays, &count)
        let main = CGMainDisplayID()
        for d in displays where d != main {
            CGConfigureDisplayMirrorOfDisplay(c, d, kCGNullDirectDisplay)
        }
        CGCompleteDisplayConfiguration(c, .forSession)
        print("OK")
    }
}
`;
      const tempPath = path.join(os.tmpdir(), `neopres_unmirror_${Date.now()}.swift`);
      await fs.promises.writeFile(tempPath, swiftScript);
      const { stdout } = await execAsync(`/usr/bin/swift "${tempPath}"`);
      await fs.promises.unlink(tempPath).catch(() => {});
      if (stdout.includes('OK')) {
        logger.info('DisplayManager', 'macOS: Un-mirrored displays via CoreGraphics Swift script');
        return true;
      }
    } catch (err) {
      logger.warn('DisplayManager', `macOS CoreGraphics Swift execution failed: ${err}`);
    }

    return false;
  }

  /**
   * Restores display mirroring on macOS.
   */
  private async mirrorMacOS(): Promise<void> {
    try {
      await execAsync('betterdisplaycli set -mirroring=on');
      return;
    } catch (_) {}

    try {
      await execAsync('mirror -on');
      return;
    } catch (_) {}

    try {
      const swiftScript = `
import CoreGraphics
var config: CGDisplayConfigRef?
if CGBeginDisplayConfiguration(&config) == .success, let c = config {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    if count > 1 {
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetOnlineDisplayList(count, &displays, &count)
        let main = CGMainDisplayID()
        for d in displays where d != main {
            CGConfigureDisplayMirrorOfDisplay(c, d, main)
        }
        CGCompleteDisplayConfiguration(c, .forSession)
    }
}
`;
      const tempPath = path.join(os.tmpdir(), `neopres_mirror_${Date.now()}.swift`);
      await fs.promises.writeFile(tempPath, swiftScript);
      await execAsync(`/usr/bin/swift "${tempPath}"`);
      await fs.promises.unlink(tempPath).catch(() => {});
    } catch (err) {
      logger.warn('DisplayManager', `macOS CoreGraphics mirror restoration failed: ${err}`);
    }
  }

  /**
   * Restores display configuration back to original state on presentation exit (matches PowerPoint).
   */
  public async restoreDisplayMode(): Promise<void> {
    if (!this.wasAutoExtended) return;

    logger.info('DisplayManager', 'Restoring original mirrored display configuration...');
    this.wasAutoExtended = false;

    if (process.platform === 'linux' && this.originalLinuxConfig) {
      try {
        const { primaryOutput, secondaryOutput } = this.originalLinuxConfig;
        await execAsync(`xrandr --output "${secondaryOutput}" --same-as "${primaryOutput}"`);
        logger.info('DisplayManager', `Restored ${secondaryOutput} mirrored with ${primaryOutput}`);
      } catch (err) {
        logger.warn('DisplayManager', `Failed to restore xrandr mirroring: ${err}`);
      } finally {
        this.originalLinuxConfig = null;
      }
    } else if (process.platform === 'win32' && this.originalWindowsMirrored) {
      try {
        await execAsync('displayswitch.exe /clone');
        logger.info('DisplayManager', 'Restored Windows display mirroring (displayswitch.exe /clone)');
      } catch (err) {
        logger.warn('DisplayManager', `Failed to restore Windows display clone: ${err}`);
      } finally {
        this.originalWindowsMirrored = false;
      }
    } else if (process.platform === 'darwin' && this.originalMacOSMirrored) {
      try {
        await this.mirrorMacOS();
        logger.info('DisplayManager', 'Restored macOS display mirroring');
      } catch (err) {
        logger.warn('DisplayManager', `Failed to restore macOS display mirroring: ${err}`);
      } finally {
        this.originalMacOSMirrored = false;
      }
    }
  }

  /**
   * Arranges audience window and presenter window across displays.
   */
  public arrangeWindows(mainWindow: BrowserWindow, presenterWindow: BrowserWindow | null): void {
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    // Non-overlapping secondary display
    const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id &&
      (d.bounds.x !== primaryDisplay.bounds.x || d.bounds.y !== primaryDisplay.bounds.y));

    if (secondaryDisplay) {
      // Dual/Extended Display Setup
      const audienceDisplay = this.isSwapped ? primaryDisplay : secondaryDisplay;
      const presenterDisplay = this.isSwapped ? secondaryDisplay : primaryDisplay;

      logger.info('DisplayManager', `Dual display: Audience window -> display ${audienceDisplay.id} (${audienceDisplay.bounds.width}x${audienceDisplay.bounds.height} at +${audienceDisplay.bounds.x}+${audienceDisplay.bounds.y}), Presenter window -> display ${presenterDisplay.id}`);

      mainWindow.setFullScreen(false);
      mainWindow.setBounds(audienceDisplay.bounds);
      mainWindow.setFullScreen(true);
      mainWindow.webContents.send('deck:set-presentation-mode', true);

      if (presenterWindow && !presenterWindow.isDestroyed()) {
        presenterWindow.setBounds({
          x: presenterDisplay.bounds.x + 40,
          y: presenterDisplay.bounds.y + 40,
          width: Math.min(1150, presenterDisplay.bounds.width - 80),
          height: Math.min(780, presenterDisplay.bounds.height - 80)
        });
        presenterWindow.focus();
      }
    } else {
      // Single display or mirrored display that cannot be extended
      logger.info('DisplayManager', `Single/mirrored display: primary display ${primaryDisplay.id} (${primaryDisplay.bounds.width}x${primaryDisplay.bounds.height})`);

      if (this.isSwapped) {
        // Presentation in front full-screen
        mainWindow.setFullScreen(true);
        mainWindow.webContents.send('deck:set-presentation-mode', true);
        mainWindow.focus();
      } else {
        // Presenter view in front
        mainWindow.setFullScreen(true);
        mainWindow.webContents.send('deck:set-presentation-mode', true);

        if (presenterWindow && !presenterWindow.isDestroyed()) {
          presenterWindow.setBounds({
            x: primaryDisplay.bounds.x + 30,
            y: primaryDisplay.bounds.y + 30,
            width: Math.min(1150, primaryDisplay.bounds.width - 60),
            height: Math.min(780, primaryDisplay.bounds.height - 60)
          });
          presenterWindow.focus();
        }
      }
    }
  }

  /**
   * Swaps Presenter View and Slide Show (matches PowerPoint 'Swap Presenter View and Slide Show').
   */
  public swapDisplays(mainWindow: BrowserWindow, presenterWindow: BrowserWindow | null): boolean {
    this.isSwapped = !this.isSwapped;
    logger.info('DisplayManager', `Swapping display arrangement (isSwapped: ${this.isSwapped})`);
    this.arrangeWindows(mainWindow, presenterWindow);
    return this.isSwapped;
  }

  /**
   * Duplicate Slide Show (matches PowerPoint 'Duplicate Slide Show' option in Presenter View).
   * Closes presenter window and projects full-screen slides across all displays.
   */
  public async duplicateSlideShow(mainWindow: BrowserWindow, presenterWindow: BrowserWindow | null): Promise<void> {
    logger.info('DisplayManager', 'Duplicating slide show across all screens...');
    if (presenterWindow && !presenterWindow.isDestroyed()) {
      presenterWindow.close();
    }
    await this.restoreDisplayMode();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(true);
      mainWindow.webContents.send('deck:set-presentation-mode', true);
      mainWindow.focus();
    }
  }

  public getIsSwapped(): boolean {
    return this.isSwapped;
  }

  public resetSwap(): void {
    this.isSwapped = false;
  }

  public getWasAutoExtended(): boolean {
    return this.wasAutoExtended;
  }
}

export const displayManager = new DisplayManager();

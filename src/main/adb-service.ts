import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { resolveAdbCommand } from './adb-resolver';
import { getAugmentedEnv } from './python-resolver';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface ADBDevice {
  id: string;
  model: string;
  state: 'device' | 'unauthorized' | 'offline' | 'unknown';
  isBoox: boolean;
}

export interface ADBStatus {
  installed: boolean;
  adbPath: string | null;
  devices: ADBDevice[];
  activePort: number;
  reverseActive: boolean;
  lastError?: string;
  statusMessage: string;
}

export class ADBService extends EventEmitter {
  private port: number;
  private monitorInterval: NodeJS.Timeout | null = null;
  private lastDevices: ADBDevice[] = [];
  private isInstalled: boolean = false;
  private isChecking: boolean = false;
  private reverseConfigured: boolean = false;
  private adbCmd: string | null = null;

  constructor(port: number = 8765) {
    super();
    this.port = port;
  }

  public setPort(port: number): void {
    this.port = port;
  }

  public getPort(): number {
    return this.port;
  }

  public getAdbPath(): string | null {
    return this.adbCmd;
  }

  /**
   * Helper to execute adb commands using resolved adb binary and augmented PATH.
   */
  private async execAdb(subcommand: string): Promise<{ stdout: string; stderr: string }> {
    const cmdBinary = this.adbCmd || 'adb';
    const binary = cmdBinary.includes(' ') ? `"${cmdBinary}"` : cmdBinary;
    const fullCmd = `${binary} ${subcommand}`;
    return execAsync(fullCmd, { env: getAugmentedEnv() });
  }

  /**
   * Check if adb is executable in current system / PATH.
   */
  public async checkAdbInstalled(): Promise<boolean> {
    try {
      const resolved = resolveAdbCommand();
      if (resolved) {
        this.adbCmd = resolved.command;
        this.isInstalled = true;
        logger.info('ADBService', `Resolved ADB executable: ${resolved.command} (${resolved.version})`);
        return true;
      }

      // Try running bare 'adb version' with augmented env
      const { stdout } = await this.execAdb('version');
      this.isInstalled = stdout.toLowerCase().includes('android debug bridge');
      if (this.isInstalled && !this.adbCmd) {
        this.adbCmd = 'adb';
      }
      return this.isInstalled;
    } catch {
      this.isInstalled = false;
      return false;
    }
  }

  /**
   * List currently attached ADB devices.
   */
  public async getDevices(): Promise<ADBDevice[]> {
    try {
      if (!this.isInstalled) {
        await this.checkAdbInstalled();
      }
      if (!this.isInstalled) {
        return [];
      }

      const { stdout } = await this.execAdb('devices -l');
      const lines = stdout.split('\n');
      const devices: ADBDevice[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('List of devices')) {
          continue;
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const id = parts[0];
          const stateStr = parts[1];
          let state: ADBDevice['state'] = 'unknown';
          if (stateStr === 'device') state = 'device';
          else if (stateStr === 'unauthorized') state = 'unauthorized';
          else if (stateStr === 'offline') state = 'offline';

          let model = 'Android Device';
          let product = '';
          let devProp = '';

          for (const p of parts) {
            if (p.startsWith('model:')) {
              model = p.replace('model:', '').replace(/_/g, ' ');
            } else if (p.startsWith('product:')) {
              product = p.replace('product:', '').toLowerCase();
            } else if (p.startsWith('device:')) {
              devProp = p.replace('device:', '').toLowerCase();
            }
          }

          const combinedLower = `${model.toLowerCase()} ${product} ${devProp}`;
          const booxKeywords = [
            'boox', 'onyx', 'note', 'tab', 'leaf', 'palma', 'go',
            'nova', 'max', 'page', 'poke', 'mira', 'kant', 'galileo',
            'monte', 'darwin', 'edison', 'viking'
          ];

          let isBoox = booxKeywords.some((kw) => combinedLower.includes(kw));

          // If state is authorized and not matched yet, check manufacturer property
          if (!isBoox && state === 'device') {
            try {
              const { stdout: mfgOut } = await this.execAdb(`-s ${id} shell getprop ro.product.manufacturer`);
              const mfg = mfgOut.trim().toLowerCase();
              if (mfg.includes('onyx') || mfg.includes('boox')) {
                isBoox = true;
              }
            } catch (_) {}
          }

          devices.push({ id, model, state, isBoox });
        }
      }

      return devices;
    } catch (err: any) {
      logger.warn('ADBService', `Error listing devices: ${err.message}`);
      return [];
    }
  }

  /**
   * Set up reverse port forwarding (device localhost:PORT -> host localhost:PORT).
   */
  public async setupReverse(deviceId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.isInstalled) {
        await this.checkAdbInstalled();
      }
      const targetFlag = deviceId ? `-s ${deviceId} ` : '';
      await this.execAdb(`${targetFlag}reverse tcp:${this.port} tcp:${this.port}`);
      this.reverseConfigured = true;
      logger.info('ADBService', `Successfully configured reverse port forwarding on tcp:${this.port}`);
      return { success: true };
    } catch (err: any) {
      this.reverseConfigured = false;
      logger.warn('ADBService', `Failed to reverse port forward: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Open the tablet app in Android's browser over ADB.
   */
  public async launchTabletBrowser(deviceId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // First ensure port reverse is configured
      await this.setupReverse(deviceId);

      const targetFlag = deviceId ? `-s ${deviceId} ` : '';
      const url = `http://localhost:${this.port}/tablet/`;
      logger.info('ADBService', `Launching tablet browser with URL: ${url}`);
      await this.execAdb(`${targetFlag}shell am start -a android.intent.action.VIEW -d "${url}"`);
      return { success: true };
    } catch (err: any) {
      logger.error('ADBService', `Failed to launch browser on tablet: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Start periodic monitoring for connected devices.
   */
  public startMonitoring(intervalMs: number = 3000): void {
    if (this.monitorInterval) return;

    // Initial check
    this.pollDevices();

    this.monitorInterval = setInterval(() => {
      this.pollDevices();
    }, intervalMs);
  }

  public stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private async pollDevices(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      if (!this.isInstalled) {
        await this.checkAdbInstalled();
      }

      if (!this.isInstalled) {
        return;
      }

      const devices = await this.getDevices();
      const activeDevices = devices.filter((d) => d.state === 'device');

      // Check for newly connected devices
      const hadDevices = this.lastDevices.length > 0;
      const hasDevices = activeDevices.length > 0;

      if (hasDevices && (!hadDevices || !this.reverseConfigured)) {
        // Automatically setup reverse port forward
        for (const dev of activeDevices) {
          await this.setupReverse(dev.id);
        }
      }

      // Check if devices list changed
      const changed = JSON.stringify(devices) !== JSON.stringify(this.lastDevices);
      if (changed) {
        logger.info('ADBService', `Connected ADB devices changed: ${JSON.stringify(devices)}`);
        this.lastDevices = devices;
        this.emit('devices-changed', devices);
      }
    } catch (err: any) {
      logger.warn('ADBService', `Poll error: ${err.message}`);
    } finally {
      this.isChecking = false;
    }
  }

  public getStatus(): ADBStatus {
    let statusMessage = 'Boox: Disconnected';
    if (!this.isInstalled) {
      statusMessage = 'ADB: Not Installed (Install via Homebrew: brew install android-platform-tools)';
    } else {
      const activeDevice = this.lastDevices.find((d) => d.state === 'device');
      const unauthDevice = this.lastDevices.find((d) => d.state === 'unauthorized');
      const offlineDevice = this.lastDevices.find((d) => d.state === 'offline');

      if (activeDevice) {
        statusMessage = `${activeDevice.isBoox ? 'Boox' : 'Tablet'}: ${activeDevice.model} (Connected)`;
      } else if (unauthDevice) {
        statusMessage = `${unauthDevice.model}: Unauthorized (Unlock tablet screen and tap Allow)`;
      } else if (offlineDevice) {
        statusMessage = `${offlineDevice.model}: Offline`;
      }
    }

    return {
      installed: this.isInstalled,
      adbPath: this.adbCmd,
      devices: this.lastDevices,
      activePort: this.port,
      reverseActive: this.reverseConfigured,
      statusMessage
    };
  }
}

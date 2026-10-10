import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

export interface ADBDevice {
  id: string;
  model: string;
  state: 'device' | 'unauthorized' | 'offline' | 'unknown';
  isBoox: boolean;
}

export interface ADBStatus {
  installed: boolean;
  devices: ADBDevice[];
  activePort: number;
  reverseActive: boolean;
  lastError?: string;
}

export class ADBService extends EventEmitter {
  private port: number;
  private monitorInterval: NodeJS.Timeout | null = null;
  private lastDevices: ADBDevice[] = [];
  private isInstalled: boolean = false;
  private isChecking: boolean = false;
  private reverseConfigured: boolean = false;

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

  /**
   * Check if adb is executable in current PATH
   */
  public async checkAdbInstalled(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('adb version');
      this.isInstalled = stdout.toLowerCase().includes('android debug bridge');
      return this.isInstalled;
    } catch {
      this.isInstalled = false;
      return false;
    }
  }

  /**
   * List currently attached ADB devices
   */
  public async getDevices(): Promise<ADBDevice[]> {
    try {
      const { stdout } = await execAsync('adb devices -l');
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

          // Extract model if present (e.g. model:NoteAir3_C or model:TabUltra)
          let model = 'Android Device';
          for (const p of parts) {
            if (p.startsWith('model:')) {
              model = p.replace('model:', '').replace(/_/g, ' ');
            }
          }

          const isBoox = model.toLowerCase().includes('boox') ||
            model.toLowerCase().includes('note') ||
            model.toLowerCase().includes('tab') ||
            model.toLowerCase().includes('leaf') ||
            model.toLowerCase().includes('palma');

          devices.push({ id, model, state, isBoox });
        }
      }

      return devices;
    } catch (err: any) {
      console.warn('[ADBService] Error listing devices:', err.message);
      return [];
    }
  }

  /**
   * Set up reverse port forwarding (device localhost:PORT -> host localhost:PORT)
   */
  public async setupReverse(deviceId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const targetFlag = deviceId ? `-s ${deviceId} ` : '';
      const cmd = `adb ${targetFlag}reverse tcp:${this.port} tcp:${this.port}`;
      await execAsync(cmd);
      this.reverseConfigured = true;
      console.log(`[ADBService] Successfully configured ${cmd}`);
      return { success: true };
    } catch (err: any) {
      this.reverseConfigured = false;
      console.warn('[ADBService] Failed to reverse port forward:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Open the tablet app in Android's browser over ADB
   */
  public async launchTabletBrowser(deviceId?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // First ensure port reverse is configured
      await this.setupReverse(deviceId);

      const targetFlag = deviceId ? `-s ${deviceId} ` : '';
      const url = `http://localhost:${this.port}/tablet/`;
      const cmd = `adb ${targetFlag}shell am start -a android.intent.action.VIEW -d "${url}"`;
      await execAsync(cmd);
      console.log(`[ADBService] Launched tablet browser with URL: ${url}`);
      return { success: true };
    } catch (err: any) {
      console.warn('[ADBService] Failed to launch browser on tablet:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Start periodic monitoring for connected devices
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
      const activeDevices = devices.filter(d => d.state === 'device');

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
        this.lastDevices = devices;
        this.emit('devices-changed', devices);
      }
    } catch (err: any) {
      console.warn('[ADBService] Poll error:', err.message);
    } finally {
      this.isChecking = false;
    }
  }

  public getStatus(): ADBStatus {
    return {
      installed: this.isInstalled,
      devices: this.lastDevices,
      activePort: this.port,
      reverseActive: this.reverseConfigured,
    };
  }
}

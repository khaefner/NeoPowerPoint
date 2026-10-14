import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app, dialog, shell, BrowserWindow } from 'electron';
import { getPythonDiagnostics } from './python-resolver';
import { getAdbDiagnostics } from './adb-resolver';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  data?: any;
}

class LoggerService {
  private logDir: string;
  private logFilePath: string;
  private memoryLogs: LogEntry[] = [];
  private maxMemoryEntries: number = 5000;
  private isInitialized: boolean = false;
  private writeQueue: string[] = [];
  private isWriting: boolean = false;

  constructor() {
    this.logDir = this.resolveLogDir();
    this.logFilePath = path.join(this.logDir, 'neopowerpoint.log');
    this.init();
  }

  private resolveLogDir(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'logs');
      }
    } catch (_) {}
    return path.join(process.cwd(), 'logs');
  }

  private init(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this.isInitialized = true;
    } catch (err) {
      console.error('[LoggerService] Failed to initialize log directory:', err);
    }
  }

  getLogDir(): string {
    return this.logDir;
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  log(level: LogLevel, tag: string, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      tag,
      message,
      data
    };

    // Store in ring buffer
    this.memoryLogs.push(entry);
    if (this.memoryLogs.length > this.maxMemoryEntries) {
      this.memoryLogs.shift();
    }

    // Format string line
    const formatted = this.formatEntry(entry);

    // Console output
    switch (level) {
      case 'DEBUG':
        console.debug(formatted);
        break;
      case 'INFO':
        console.log(formatted);
        break;
      case 'WARN':
        console.warn(formatted);
        break;
      case 'ERROR':
        console.error(formatted);
        break;
    }

    // Queue disk append
    this.queueDiskWrite(formatted + '\n');
  }

  debug(tag: string, message: string, data?: any): void {
    this.log('DEBUG', tag, message, data);
  }

  info(tag: string, message: string, data?: any): void {
    this.log('INFO', tag, message, data);
  }

  warn(tag: string, message: string, data?: any): void {
    this.log('WARN', tag, message, data);
  }

  error(tag: string, message: string, error?: any): void {
    let details = error;
    if (error instanceof Error) {
      details = `${error.name}: ${error.message}\n${error.stack || ''}`;
    } else if (typeof error === 'object' && error !== null) {
      try {
        details = JSON.stringify(error, null, 2);
      } catch (_) {
        details = String(error);
      }
    }
    this.log('ERROR', tag, message, details);
  }

  private formatEntry(entry: LogEntry): string {
    let base = `[${entry.timestamp}] [${entry.level}] [${entry.tag}] ${entry.message}`;
    if (entry.data !== undefined) {
      if (typeof entry.data === 'string') {
        base += `\n  ${entry.data.replace(/\n/g, '\n  ')}`;
      } else {
        try {
          base += `\n  ${JSON.stringify(entry.data, null, 2).replace(/\n/g, '\n  ')}`;
        } catch (_) {
          base += `\n  ${String(entry.data)}`;
        }
      }
    }
    return base;
  }

  private queueDiskWrite(content: string): void {
    this.writeQueue.push(content);
    this.flushDiskWrites();
  }

  private async flushDiskWrites(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) return;
    this.isWriting = true;

    const chunk = this.writeQueue.join('');
    this.writeQueue = [];

    try {
      if (!this.isInitialized) {
        this.init();
      }
      await fs.promises.appendFile(this.logFilePath, chunk, 'utf-8');
    } catch (err) {
      // Don't crash logging if file write fails
      console.error('[LoggerService] Error appending to log file:', err);
    } finally {
      this.isWriting = false;
      if (this.writeQueue.length > 0) {
        setImmediate(() => this.flushDiskWrites());
      }
    }
  }

  getMemoryLogs(): LogEntry[] {
    return [...this.memoryLogs];
  }

  async getAllLogs(): Promise<string> {
    try {
      if (fs.existsSync(this.logFilePath)) {
        return await fs.promises.readFile(this.logFilePath, 'utf-8');
      }
    } catch (_) {}
    return this.memoryLogs.map((e) => this.formatEntry(e)).join('\n');
  }

  /**
   * Generates a comprehensive markdown and plain-text diagnostic report
   * containing OS details, Electron/Node versions, Python detection,
   * PATH analysis, converter script paths, and recent application logs.
   */
  async generateDiagnosticReport(customContext?: Record<string, any>): Promise<string> {
    const pyDiag = getPythonDiagnostics();
    const appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
    const isPackaged = app ? app.isPackaged : false;
    const userDataPath = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
    const tempPath = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir();

    // Check converter scripts candidate paths
    const converterCandidates = [
      path.join(__dirname, '../converter'),
      path.join(__dirname, '../../src/converter'),
      path.join(appPath, 'dist/converter'),
      path.join(appPath, 'src/converter'),
      path.join(appPath, '.agents/skills/pptx-to-neopowerpoint/scripts')
    ];

    const converterStatus = converterCandidates.map((cand) => {
      const extractExists = fs.existsSync(path.join(cand, 'extract_pptx.py'));
      const generateExists = fs.existsSync(path.join(cand, 'generate_deck.py'));
      const inAsar = cand.includes('.asar');
      const unpackedCand = cand.replace(/\.asar([/\\])/, '.asar.unpacked$1');
      const unpackedExists = fs.existsSync(unpackedCand);

      return {
        path: cand,
        hasExtract: extractExists,
        hasGenerate: generateExists,
        inAsar,
        unpackedExists: unpackedExists ? unpackedCand : false
      };
    });

    const lines: string[] = [];
    lines.push('================================================================');
    lines.push('             NEOPOWERPOINT DIAGNOSTIC & DEBUG REPORT            ');
    lines.push('================================================================');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Report OS: ${os.type()} ${os.release()} (${process.platform} ${process.arch})`);
    lines.push(`Hostname:  ${os.hostname()}`);
    lines.push(`CPUs:      ${os.cpus().length}x ${os.cpus()[0]?.model || 'Unknown'}`);
    lines.push(`Memory:    Total: ${(os.totalmem() / 1073741824).toFixed(2)} GB | Free: ${(os.freemem() / 1073741824).toFixed(2)} GB`);
    lines.push(`Uptime:    ${(os.uptime() / 3600).toFixed(2)} hours`);
    lines.push('');

    lines.push('--- RUNTIME & ELECTRON VERSIONS ---');
    lines.push(`Electron:  ${process.versions.electron || 'N/A'}`);
    lines.push(`Node.js:   ${process.versions.node}`);
    lines.push(`Chrome:    ${process.versions.chrome || 'N/A'}`);
    lines.push(`V8:        ${process.versions.v8}`);
    lines.push('');

    lines.push('--- APPLICATION PATHS ---');
    lines.push(`App Path:    ${appPath}`);
    lines.push(`Is Packaged: ${isPackaged}`);
    lines.push(`User Data:   ${userDataPath}`);
    lines.push(`Temp Dir:    ${tempPath}`);
    lines.push(`Log File:    ${this.logFilePath}`);
    lines.push('');

    lines.push('--- PYTHON 3 RESOLUTION DIAGNOSTICS ---');
    lines.push(`Resolved Python:  ${pyDiag.resolvedPython || 'NONE FOUND'}`);
    lines.push(`Resolved Version: ${pyDiag.resolvedVersion || 'N/A'}`);
    lines.push('Candidates Probed:');
    for (const c of pyDiag.candidatesChecked) {
      const status = c.executable ? `[OK] (${c.version})` : `[FAILED] (${c.error || 'Not executable'})`;
      lines.push(`  * ${c.path} -> ${status}`);
    }
    lines.push('');

    lines.push('--- CONVERTER SCRIPT RESOLUTION ---');
    for (const cs of converterStatus) {
      lines.push(`  * Candidate: ${cs.path}`);
      lines.push(`      extract_pptx.py:  ${cs.hasExtract ? 'FOUND' : 'MISSING'}`);
      lines.push(`      generate_deck.py: ${cs.hasGenerate ? 'FOUND' : 'MISSING'}`);
      lines.push(`      inside asar:      ${cs.inAsar}`);
      if (cs.unpackedExists) {
        lines.push(`      unpacked version: ${cs.unpackedExists}`);
      }
    }
    lines.push('');

    const adbDiag = getAdbDiagnostics();
    lines.push('--- ADB TABLET & ANDROID DEBUG BRIDGE DIAGNOSTICS ---');
    lines.push(`Resolved ADB:     ${adbDiag.resolvedAdb || 'NONE FOUND'}`);
    lines.push(`Resolved Version: ${adbDiag.resolvedVersion || 'N/A'}`);
    lines.push('Candidates Probed:');
    for (const c of adbDiag.candidatesChecked) {
      const status = c.executable ? `[OK] (${c.version})` : `[FAILED] (${c.error || 'Not executable'})`;
      lines.push(`  * ${c.path} -> ${status}`);
    }
    lines.push('');

    lines.push('--- ENVIRONMENT PATH ENTRIES ---');
    const pathDelimiter = path.delimiter;
    const pathEntries = (process.env.PATH || '').split(pathDelimiter);
    for (const pe of pathEntries) {
      lines.push(`  - ${pe} (exists: ${fs.existsSync(pe)})`);
    }
    lines.push('');

    if (customContext && Object.keys(customContext).length > 0) {
      lines.push('--- CUSTOM CONTEXT & ERROR STATE ---');
      try {
        lines.push(JSON.stringify(customContext, null, 2));
      } catch (_) {
        lines.push(String(customContext));
      }
      lines.push('');
    }

    lines.push('================================================================');
    lines.push('                        APPLICATION LOGS                        ');
    lines.push('================================================================');
    const fullLogs = await this.getAllLogs();
    lines.push(fullLogs);

    return lines.join('\n');
  }

  /**
   * Prompts the user to save the complete diagnostic and debug log file.
   */
  async exportLogs(parentWindow?: BrowserWindow): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const defaultFileName = `neopowerpoint-debug-logs-${timestamp}.log`;

      let targetPath: string | undefined;

      if (dialog && typeof dialog.showSaveDialog === 'function') {
        const result = await dialog.showSaveDialog(parentWindow || undefined as any, {
          title: 'Export NeoPowerPoint Debug Logs',
          defaultPath: defaultFileName,
          filters: [
            { name: 'Log Files (*.log)', extensions: ['log'] },
            { name: 'Text Files (*.txt)', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true };
        }
        targetPath = result.filePath;
      } else {
        // Fallback for headless / tests
        targetPath = path.join(this.logDir, defaultFileName);
      }

      this.info('Logger', `Exporting diagnostic logs to: ${targetPath}`);
      const report = await this.generateDiagnosticReport();
      await fs.promises.writeFile(targetPath, report, 'utf-8');
      this.info('Logger', `Successfully exported logs to: ${targetPath}`);

      return { success: true, filePath: targetPath };
    } catch (err: any) {
      this.error('Logger', 'Failed to export logs', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Opens the logs directory in the operating system file manager (Finder / Explorer).
   */
  async openLogDir(): Promise<boolean> {
    try {
      this.info('Logger', `Opening log folder: ${this.logDir}`);
      if (shell && typeof shell.openPath === 'function') {
        const res = await shell.openPath(this.logDir);
        if (res) {
          this.warn('Logger', `shell.openPath reported: ${res}`);
        }
        return true;
      }
      return false;
    } catch (err: any) {
      this.error('Logger', 'Failed to open log folder', err);
      return false;
    }
  }
}

export const logger = new LoggerService();

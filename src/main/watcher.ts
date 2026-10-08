import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';

export class DeckWatcher {
  private watcher: FSWatcher | null = null;
  private currentPath: string | null = null;
  private changeCallback: ((filePath: string, eventType: string) => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(onChange: (filePath: string, eventType: string) => void) {
    this.changeCallback = onChange;
  }

  watch(folderPath: string): void {
    this.stop();
    this.currentPath = folderPath;

    this.watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\..|node_modules/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    const notify = (eventType: string, fullPath: string) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        const relPath = path.relative(folderPath, fullPath).replace(/\\/g, '/');
        if (this.changeCallback) {
          this.changeCallback(relPath, eventType);
        }
      }, 150);
    };

    this.watcher.on('change', (p) => notify('change', p));
    this.watcher.on('add', (p) => notify('add', p));
    this.watcher.on('unlink', (p) => notify('unlink', p));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.currentPath = null;
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }
}

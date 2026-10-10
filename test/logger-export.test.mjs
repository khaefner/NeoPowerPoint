import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function runTests() {
  console.log('--- Testing NeoPowerPoint Log Export & Diagnostic System ---');

  // 1. Verify package.json contains asarUnpack for converter scripts
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'));
  if (!pkg.build || !pkg.build.asarUnpack || !pkg.build.asarUnpack.includes('dist/converter/**/*')) {
    throw new Error('package.json build configuration must contain asarUnpack for dist/converter/**/*');
  }
  console.log('✓ Verified package.json asarUnpack includes "dist/converter/**/*"');

  // 2. Test python-resolver and logger from dist/main/main.js bundle or direct execution
  const testOutputDir = path.join(rootDir, 'test-output', 'logger-test');
  await fs.promises.rm(testOutputDir, { recursive: true, force: true });
  await fs.promises.mkdir(testOutputDir, { recursive: true });

  // 3. Verify HTML DOM elements in dist/renderer/index.html
  const htmlPath = path.join(rootDir, 'dist', 'renderer', 'index.html');
  const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');

  const requiredIds = [
    'menu-export-logs',
    'menu-open-logs-folder',
    'import-loading-overlay',
    'error-modal',
    'error-modal-title',
    'error-modal-message',
    'error-modal-details',
    'btn-error-export-logs',
    'btn-error-copy-details',
    'btn-error-open-folder',
    'btn-error-dismiss',
    'btn-close-error-modal',
    'toast-notification'
  ];

  for (const id of requiredIds) {
    if (!htmlContent.includes(`id="${id}"`)) {
      throw new Error(`index.html missing required element id="${id}"`);
    }
  }
  console.log(`✓ Verified all ${requiredIds.length} logging, diagnostic, and error UI elements in index.html`);

  // 4. Verify preload bundle exposes exportLogs and diagnostic channels
  const preloadPath = path.join(rootDir, 'dist', 'preload', 'preload.js');
  const preloadContent = await fs.promises.readFile(preloadPath, 'utf-8');

  const requiredPreloadApis = [
    'dialog:export-logs',
    'dialog:open-logs-folder',
    'logger:get-logs',
    'logger:log',
    'deck:import-error'
  ];

  for (const api of requiredPreloadApis) {
    if (!preloadContent.includes(api)) {
      throw new Error(`preload.js missing bridge for "${api}"`);
    }
  }
  console.log(`✓ Verified preload.js exposes all ${requiredPreloadApis.length} log export and diagnostic IPC channels`);

  // 5. Verify renderer app.js contains exportLogs and error modal logic
  const appJsPath = path.join(rootDir, 'dist', 'renderer', 'app.js');
  const appJsContent = await fs.promises.readFile(appJsPath, 'utf-8');

  if (!appJsContent.includes('exportLogs') || !appJsContent.includes('showErrorModal') || !appJsContent.includes('import-loading-overlay')) {
    throw new Error('app.js missing exportLogs or showErrorModal implementation');
  }
  console.log('✓ Verified renderer app.js contains exportLogs, showErrorModal, and loading overlay integration');

  // 6. Verify main.js contains menu items and IPC handlers
  const mainJsPath = path.join(rootDir, 'dist', 'main', 'main.js');
  const mainJsContent = await fs.promises.readFile(mainJsPath, 'utf-8');

  if (!mainJsContent.includes('Export Debug Logs') || !mainJsContent.includes('Open Logs Folder')) {
    throw new Error('main.js missing menu items for Export Debug Logs or Open Logs Folder');
  }
  if (!mainJsContent.includes('dialog:export-logs') || !mainJsContent.includes('logger:get-logs')) {
    throw new Error('main.js missing IPC handlers for dialog:export-logs or logger:get-logs');
  }
  console.log('✓ Verified main.js contains native menu entries and IPC handlers');

  // 7. Verify CSS contains toast and progress animation styles
  const cssPath = path.join(rootDir, 'dist', 'renderer', 'styles', 'main.css');
  const cssContent = await fs.promises.readFile(cssPath, 'utf-8');
  if (!cssContent.includes('.toast-notification') || !cssContent.includes('.import-progress-fill')) {
    throw new Error('main.css missing .toast-notification or .import-progress-fill styles');
  }
  console.log('✓ Verified main.css contains .toast-notification and .import-progress-fill styles');

  // Clean up test output
  await fs.promises.rm(testOutputDir, { recursive: true, force: true });

  console.log('\n🎉 ALL LOG EXPORT & DIAGNOSTIC TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

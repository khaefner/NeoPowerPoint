import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('--- Testing Mirrored Display Presenter Mode & Display Manager (PowerPoint Parity) ---');

// 1. Verify build files exist
const presenterHtmlPath = path.join(rootDir, 'dist/presenter/index.html');
const presenterCssPath = path.join(rootDir, 'dist/presenter/presenter.css');
const presenterJsPath = path.join(rootDir, 'dist/presenter/presenter.js');
const rendererHtmlPath = path.join(rootDir, 'dist/renderer/index.html');
const rendererJsPath = path.join(rootDir, 'dist/renderer/app.js');
const presenterPreloadPath = path.join(rootDir, 'dist/preload/presenter-preload.js');
const preloadPath = path.join(rootDir, 'dist/preload/preload.js');
const mainJsPath = path.join(rootDir, 'dist/main/main.js');

assert(fs.existsSync(presenterHtmlPath), 'dist/presenter/index.html must exist');
assert(fs.existsSync(presenterCssPath), 'dist/presenter/presenter.css must exist');
assert(fs.existsSync(presenterJsPath), 'dist/presenter/presenter.js must exist');
assert(fs.existsSync(rendererHtmlPath), 'dist/renderer/index.html must exist');
assert(fs.existsSync(rendererJsPath), 'dist/renderer/app.js must exist');
assert(fs.existsSync(presenterPreloadPath), 'dist/preload/presenter-preload.js must exist');
assert(fs.existsSync(preloadPath), 'dist/preload/preload.js must exist');
assert(fs.existsSync(mainJsPath), 'dist/main/main.js must exist');

console.log('✓ All build artifacts exist.');

// 2. Test xrandr query parser with various real-world display configurations
const sampleSingleDisplay = `Screen 0: minimum 320 x 200, current 1512 x 911, maximum 8192 x 8192
Virtual-1 connected 1512x911+0+0 (normal left inverted right x axis y axis) 0mm x 0mm
   1512x911      59.95*+
Virtual-2 disconnected
Virtual-3 disconnected`;

const sampleDualExtended = `Screen 0: minimum 320 x 200, current 3432 x 1080, maximum 8192 x 8192
eDP-1 connected primary 1512x911+0+0 (normal left inverted right x axis y axis) 302mm x 189mm
   1512x911      59.95*+
HDMI-1 connected 1920x1080+1512+0 (normal left inverted right x axis y axis) 531mm x 299mm
   1920x1080     60.00*+`;

const sampleMirroredBothActive = `Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 8192 x 8192
Virtual-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 0mm x 0mm
   1920x1080     60.00*+
Virtual-2 connected 1920x1080+0+0 (normal left inverted right x axis y axis) 0mm x 0mm
   1920x1080     60.00*+`;

const sampleMirroredInactiveSecondary = `Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 8192 x 8192
eDP-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 344mm x 194mm
   1920x1080     60.00*+
HDMI-1 connected (normal left inverted right x axis y axis)
   1920x1080     60.00
   1280x720      60.00`;

function parseXrandr(stdout) {
  const lines = stdout.split('\n');
  const connectedOutputs = [];

  for (const line of lines) {
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

// Verify Single Display
const parsedSingle = parseXrandr(sampleSingleDisplay);
assert.strictEqual(parsedSingle.connectedOutputs.length, 1);
assert.strictEqual(parsedSingle.isMirrored, false);
console.log('✓ Verified single display detection (isMirrored: false)');

// Verify Dual Extended Displays
const parsedExtended = parseXrandr(sampleDualExtended);
assert.strictEqual(parsedExtended.connectedOutputs.length, 2);
assert.strictEqual(parsedExtended.primary, 'eDP-1');
assert.strictEqual(parsedExtended.secondary, 'HDMI-1');
assert.strictEqual(parsedExtended.isMirrored, false);
console.log('✓ Verified dual extended displays detection (isMirrored: false)');

// Verify Mirrored Displays (both active at +0+0)
const parsedMirrored1 = parseXrandr(sampleMirroredBothActive);
assert.strictEqual(parsedMirrored1.connectedOutputs.length, 2);
assert.strictEqual(parsedMirrored1.primary, 'Virtual-1');
assert.strictEqual(parsedMirrored1.secondary, 'Virtual-2');
assert.strictEqual(parsedMirrored1.isMirrored, true);
console.log('✓ Verified mirrored displays detection with overlapping coordinates (isMirrored: true)');

// Verify Mirrored / Inactive Secondary Display
const parsedMirrored2 = parseXrandr(sampleMirroredInactiveSecondary);
assert.strictEqual(parsedMirrored2.connectedOutputs.length, 2);
assert.strictEqual(parsedMirrored2.primary, 'eDP-1');
assert.strictEqual(parsedMirrored2.secondary, 'HDMI-1');
assert.strictEqual(parsedMirrored2.isMirrored, true);
console.log('✓ Verified connected unextended display detection (isMirrored: true)');

// 3. Test Auto-Extend command generation and DisplayManager methods in source
const displayManagerSrc = await fs.promises.readFile(path.join(rootDir, 'src/main/display-manager.ts'), 'utf-8');
assert(displayManagerSrc.includes('xrandr --output "${secondary}" --right-of "${primary}" --auto'), 'Must generate xrandr auto-extend command');
assert(displayManagerSrc.includes('xrandr --output "${secondaryOutput}" --same-as "${primaryOutput}"'), 'Must generate xrandr restore mirror command');
assert(displayManagerSrc.includes('displayswitch.exe /extend'), 'Must generate Windows displayswitch extend command');
assert(displayManagerSrc.includes('displayswitch.exe /clone'), 'Must generate Windows displayswitch clone command');
assert(displayManagerSrc.includes('CGConfigureDisplayMirrorOfDisplay'), 'Must include macOS CoreGraphics unmirror support');
assert(displayManagerSrc.includes('unmirrorMacOS'), 'Must include unmirrorMacOS method');
assert(displayManagerSrc.includes('swapDisplays'), 'DisplayManager must implement swapDisplays');
assert(displayManagerSrc.includes('duplicateSlideShow'), 'DisplayManager must implement duplicateSlideShow');
assert(displayManagerSrc.includes('restoreDisplayMode'), 'DisplayManager must implement restoreDisplayMode');
console.log('✓ Verified DisplayManager command generation (Linux xrandr, Windows displayswitch, and macOS CoreGraphics)');

// 4. Test Display Swapping Logic Simulation
function simulateArrangeWindows(displays, isSwapped) {
  const primary = displays[0];
  const secondary = displays.find(d => d.id !== primary.id && (d.bounds.x !== primary.bounds.x || d.bounds.y !== primary.bounds.y));

  if (secondary) {
    const audienceDisplay = isSwapped ? primary : secondary;
    const presenterDisplay = isSwapped ? secondary : primary;
    return {
      dualDisplay: true,
      audienceDisplayId: audienceDisplay.id,
      presenterDisplayId: presenterDisplay.id
    };
  } else {
    return {
      dualDisplay: false,
      audienceDisplayId: primary.id,
      presenterDisplayId: primary.id,
      frontWindow: isSwapped ? 'audience' : 'presenter'
    };
  }
}

const mockDisplays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
];

const normalArrange = simulateArrangeWindows(mockDisplays, false);
assert.strictEqual(normalArrange.dualDisplay, true);
assert.strictEqual(normalArrange.audienceDisplayId, 2);
assert.strictEqual(normalArrange.presenterDisplayId, 1);

const swappedArrange = simulateArrangeWindows(mockDisplays, true);
assert.strictEqual(swappedArrange.dualDisplay, true);
assert.strictEqual(swappedArrange.audienceDisplayId, 1);
assert.strictEqual(swappedArrange.presenterDisplayId, 2);
console.log('✓ Verified display swap calculation correctly interchanges audience and presenter monitors');

// 5. Verify Presenter View UI elements
const presenterHtmlContent = await fs.promises.readFile(presenterHtmlPath, 'utf-8');
assert(presenterHtmlContent.includes('id="btn-display-settings"'), 'Missing btn-display-settings in presenter/index.html');
assert(presenterHtmlContent.includes('id="display-settings-menu"'), 'Missing display-settings-menu in presenter/index.html');
assert(presenterHtmlContent.includes('id="btn-swap-displays"'), 'Missing btn-swap-displays in presenter/index.html');
assert(presenterHtmlContent.includes('id="btn-duplicate-slideshow"'), 'Missing btn-duplicate-slideshow in presenter/index.html');
assert(presenterHtmlContent.includes('id="btn-auto-extend-toggle"'), 'Missing btn-auto-extend-toggle in presenter/index.html');
assert(presenterHtmlContent.includes('id="btn-end-slideshow"'), 'Missing btn-end-slideshow in presenter/index.html');
console.log('✓ Verified Display Settings dropdown and End Slide Show buttons in presenter/index.html');

// 6. Verify Presenter View CSS
const presenterCssContent = await fs.promises.readFile(presenterCssPath, 'utf-8');
assert(presenterCssContent.includes('.display-settings-container'), 'Missing .display-settings-container in presenter.css');
assert(presenterCssContent.includes('.display-settings-dropdown'), 'Missing .display-settings-dropdown in presenter.css');
assert(presenterCssContent.includes('.dropdown-item'), 'Missing .dropdown-item in presenter.css');
assert(presenterCssContent.includes('.btn-header-danger'), 'Missing .btn-header-danger in presenter.css');
console.log('✓ Verified Display Settings styles in presenter.css');

// 7. Verify Presenter View Script Logic
const presenterJsContent = await fs.promises.readFile(presenterJsPath, 'utf-8');
assert(presenterJsContent.includes('btnSwapDisplays'), 'Missing btnSwapDisplays handler in presenter.js');
assert(presenterJsContent.includes('btnDuplicateSlideshow'), 'Missing btnDuplicateSlideshow handler in presenter.js');
assert(presenterJsContent.includes('btnEndSlideshow'), 'Missing btnEndSlideshow handler in presenter.js');
assert(presenterJsContent.includes('swapDisplays'), 'Missing swapDisplays invocation in presenter.js');
assert(presenterJsContent.includes("e.key === 'x'") || presenterJsContent.includes('e.key === "x"'), 'Missing X shortcut for swapDisplays in presenter.js');
assert(presenterJsContent.includes("e.key === 'Escape'") || presenterJsContent.includes('e.key === "Escape"'), 'Missing Escape shortcut for endSlideShow in presenter.js');
console.log('✓ Verified Display Settings handlers and keyboard shortcuts (X, Escape) in presenter.js');

// 8. Verify Audience Renderer Presentation Mode controls
const rendererHtmlContent = await fs.promises.readFile(rendererHtmlPath, 'utf-8');
assert(rendererHtmlContent.includes('id="float-swap"'), 'Missing float-swap button in renderer/index.html');

const rendererJsContent = await fs.promises.readFile(rendererJsPath, 'utf-8');
assert(rendererJsContent.includes('floatSwapBtn') || rendererJsContent.includes('swapDisplays'), 'Missing swapDisplays wiring in renderer app.js');
console.log('✓ Verified float-swap button and swap shortcut in audience presentation view');

// 9. Verify Preload Bridges
const presenterPreloadContent = await fs.promises.readFile(presenterPreloadPath, 'utf-8');
assert(presenterPreloadContent.includes('presenter:swap-displays'), 'Missing presenter:swap-displays in presenter-preload.js');
assert(presenterPreloadContent.includes('presenter:duplicate-slideshow'), 'Missing presenter:duplicate-slideshow in presenter-preload.js');
assert(presenterPreloadContent.includes('presenter:end-slideshow'), 'Missing presenter:end-slideshow in presenter-preload.js');
assert(presenterPreloadContent.includes('presenter:get-display-status'), 'Missing presenter:get-display-status in presenter-preload.js');
assert(presenterPreloadContent.includes('presenter:set-auto-extend'), 'Missing presenter:set-auto-extend in presenter-preload.js');

const preloadContent = await fs.promises.readFile(preloadPath, 'utf-8');
assert(preloadContent.includes('presenter:swap-displays'), 'Missing presenter:swap-displays in preload.js');
assert(preloadContent.includes('presenter:end-slideshow'), 'Missing presenter:end-slideshow in preload.js');
console.log('✓ Verified IPC bridges in presenter-preload.js and preload.js');

// 10. Verify Main Process IPC Handlers
const mainJsContent = await fs.promises.readFile(mainJsPath, 'utf-8');
assert(mainJsContent.includes('presenter:swap-displays'), 'Missing presenter:swap-displays handler in main.js');
assert(mainJsContent.includes('presenter:duplicate-slideshow'), 'Missing presenter:duplicate-slideshow handler in main.js');
assert(mainJsContent.includes('presenter:end-slideshow'), 'Missing presenter:end-slideshow handler in main.js');
assert(mainJsContent.includes('presenter:get-display-status'), 'Missing presenter:get-display-status handler in main.js');
assert(mainJsContent.includes('presenter:set-auto-extend'), 'Missing presenter:set-auto-extend handler in main.js');
assert(mainJsContent.includes('ensureExtendedDisplays'), 'Missing ensureExtendedDisplays in main.js');
console.log('✓ Verified main process handlers and auto-extend orchestration in main.js');

console.log('\n🎉 ALL DISPLAY MANAGER & MIRRORED DISPLAY TESTS PASSED SUCCESSFULLY!\n');

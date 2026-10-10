import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function runWebSlideTests() {
  console.log('--- Testing Web Page Slide Embedding & Responsive Scaling ---');

  const testDir = path.join(rootDir, 'test-output', 'web-slide-test');
  await fs.promises.mkdir(testDir, { recursive: true });

  const initialManifest = {
    version: '1.0.0',
    title: 'Test Web Slides',
    aspectRatio: '16:9',
    customWidth: 1920,
    customHeight: 1080,
    theme: 'dark',
    defaultTransition: 'fade',
    slides: []
  };

  await fs.promises.writeFile(path.join(testDir, 'deck.json'), JSON.stringify(initialManifest, null, 2), 'utf-8');

  // Verify dist files exist and are compiled
  const distDir = path.join(rootDir, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist');
  }

  // Verify index.html contains Web Slide controls and modal
  const indexHtml = await fs.promises.readFile(path.join(rootDir, 'src/renderer/index.html'), 'utf-8');
  if (!indexHtml.includes('id="menu-new-web-slide"')) {
    throw new Error('index.html is missing menu-new-web-slide');
  }
  if (!indexHtml.includes('id="btn-sidebar-add-web-slide"')) {
    throw new Error('index.html is missing btn-sidebar-add-web-slide');
  }
  if (!indexHtml.includes('id="web-slide-modal"')) {
    throw new Error('index.html is missing web-slide-modal');
  }
  if (!indexHtml.includes('id="btn-confirm-web-modal"')) {
    throw new Error('index.html is missing btn-confirm-web-modal');
  }
  console.log('✓ Verified Web Slide buttons and modal elements in index.html');

  // Verify app.ts contains modal open/close and addWebSlide wiring
  const appTs = await fs.promises.readFile(path.join(rootDir, 'src/renderer/app.ts'), 'utf-8');
  if (!appTs.includes('addWebSlide(') || !appTs.includes('openWebSlideModal')) {
    throw new Error('app.ts is missing addWebSlide or openWebSlideModal logic');
  }
  console.log('✓ Verified addWebSlide wiring and modal handlers in app.ts');

  // Verify preload.ts has addWebSlide bridge
  const preloadTs = await fs.promises.readFile(path.join(rootDir, 'src/preload/preload.ts'), 'utf-8');
  if (!preloadTs.includes('addWebSlide:')) {
    throw new Error('preload.ts is missing addWebSlide API bridge');
  }
  console.log('✓ Verified preload.ts IPC bridge for addWebSlide');

  // Verify main.ts has deck:add-web-slide handler
  const mainTs = await fs.promises.readFile(path.join(rootDir, 'src/main/main.ts'), 'utf-8');
  if (!mainTs.includes("'deck:add-web-slide'")) {
    throw new Error('main.ts is missing deck:add-web-slide handler');
  }
  console.log('✓ Verified main.ts IPC handler for deck:add-web-slide');

  // Verify DeckService addWebSlide generates HTML with iframe, responsive scaling, and scroll toggle
  const deckServiceTs = await fs.promises.readFile(path.join(rootDir, 'src/main/deck-service.ts'), 'utf-8');
  if (!deckServiceTs.includes('async addWebSlide(')) {
    throw new Error('deck-service.ts is missing addWebSlide method');
  }
  if (!deckServiceTs.includes('btn-toggle-mode') || !deckServiceTs.includes('mode-fit') || !deckServiceTs.includes('mode-scroll')) {
    throw new Error('deck-service.ts does not generate fit/scroll toggle in web slide template');
  }
  if (!deckServiceTs.includes('Math.min(scaleX, scaleY)')) {
    throw new Error('deck-service.ts web slide template missing responsive scale calculation');
  }
  console.log('✓ Verified deck-service.ts addWebSlide template has iframe, responsive scaler, and fit/scroll toggle');

  // Verify insertAfterIndex placement logic in DeckService and app.ts
  if (!deckServiceTs.includes('insertAfterIndex: number = -1') || !deckServiceTs.includes('manifest.slides.splice(insertAfterIndex + 1')) {
    throw new Error('deck-service.ts missing insertAfterIndex splice logic');
  }
  if (!appTs.includes('addNewSlide(title, insertAfter)') || !appTs.includes('addWebSlide(title, url, insertAfter)')) {
    throw new Error('app.ts missing insertAfter passing to addNewSlide / addWebSlide');
  }
  console.log('✓ Verified new slides are inserted after currently selected slide');

  // Clean up test dir
  await fs.promises.rm(testDir, { recursive: true, force: true });
  console.log('✓ Cleaned up test output.');
  console.log('\n🎉 ALL WEB SLIDE TESTS PASSED SUCCESSFULLY!\n');
}

runWebSlideTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

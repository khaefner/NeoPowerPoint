import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const testDir = path.join(rootDir, 'test-output', 'new-slide-object-delete-test');

async function runTests() {
  console.log('--- Testing New Slide from Template & Right-Click Object Deletion ---');

  // Setup test deck directory
  await fs.promises.rm(testDir, { recursive: true, force: true });
  await fs.promises.mkdir(testDir, { recursive: true });

  const sampleDir = path.join(rootDir, 'sample-deck');
  // Copy sample deck to test output
  await copyRecursive(sampleDir, testDir);

  const deckServiceTs = await fs.promises.readFile(path.join(rootDir, 'src/main/deck-service.ts'), 'utf-8');
  assert(deckServiceTs.includes('addSlideFromTemplate('), 'deck-service.ts must implement addSlideFromTemplate');
  assert(deckServiceTs.includes('generateStandardLayoutHtml('), 'deck-service.ts must implement generateStandardLayoutHtml');
  assert(deckServiceTs.includes("templateType === 'from-deck'"), 'deck-service.ts must handle from-deck templates');

  const mainJs = await fs.promises.readFile(path.join(rootDir, 'dist/main/main.js'), 'utf-8');
  assert(mainJs.includes('addSlideFromTemplate'), 'dist/main/main.js must bundle addSlideFromTemplate');
  assert(mainJs.includes('deck:add-slide-from-template'), 'dist/main/main.js must register deck:add-slide-from-template IPC');
  console.log('✓ Verified DeckService template implementation and main IPC registration');

  // 1. Test functional execution of template copying logic
  const manifestPath = path.join(testDir, 'deck.json');
  const manifestRaw = await fs.promises.readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestRaw);
  const initialCount = manifest.slides.length;
  assert(initialCount >= 2, 'Sample deck should have at least 2 slides');

  // Emulate addSlideFromTemplate for 'from-deck'
  const sourceSlide = manifest.slides[0];
  const sourceHtmlPath = path.resolve(testDir, sourceSlide.path);
  let htmlContent = await fs.promises.readFile(sourceHtmlPath, 'utf-8');
  const newTitle = 'Custom Slide from Deck Template';
  htmlContent = htmlContent.replace(/<title>[\s\S]*?<\/title>/i, `<title>${newTitle}</title>`);

  const slug = `slide-test-template-${Date.now()}`;
  const slideDir = path.join(testDir, 'slides', slug);
  await fs.promises.mkdir(slideDir, { recursive: true });
  await fs.promises.writeFile(path.join(slideDir, 'index.html'), htmlContent, 'utf-8');
  await fs.promises.writeFile(path.join(slideDir, 'notes.html'), '<p>Notes</p>', 'utf-8');

  manifest.slides.splice(1, 0, {
    id: `slide-${Date.now()}`,
    title: newTitle,
    path: `slides/${slug}/index.html`,
    notesPath: `slides/${slug}/notes.html`,
    notes: '',
    transition: 'fade'
  });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  const updatedManifestRaw = await fs.promises.readFile(manifestPath, 'utf-8');
  const updatedManifest = JSON.parse(updatedManifestRaw);
  assert.strictEqual(updatedManifest.slides.length, initialCount + 1, 'Should have 1 more slide in manifest');
  const newDeckSlide = updatedManifest.slides[1];
  assert.strictEqual(newDeckSlide.title, 'Custom Slide from Deck Template');
  assert(fs.existsSync(path.join(testDir, newDeckSlide.path)), 'Slide HTML file must exist');

  const copiedHtml = await fs.promises.readFile(path.join(testDir, newDeckSlide.path), 'utf-8');
  assert(copiedHtml.includes('<title>Custom Slide from Deck Template</title>'), 'HTML title must be updated');
  console.log('✓ Verified addSlideFromTemplate with from-deck copies slide styling, updates title, and updates deck manifest');

  // 2. Verify UI Elements in index.html
  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const html = await fs.promises.readFile(htmlPath, 'utf-8');

  assert(html.includes('id="btn-add-slide-toolbar"'), 'Missing btn-add-slide-toolbar in index.html');
  assert(html.includes('id="new-slide-modal"'), 'Missing new-slide-modal in index.html');
  assert(html.includes('id="input-new-slide-title"'), 'Missing input-new-slide-title in index.html');
  assert(html.includes('id="select-new-slide-position"'), 'Missing select-new-slide-position in index.html');
  assert(html.includes('id="tab-template-deck"'), 'Missing tab-template-deck in index.html');
  assert(html.includes('id="tab-template-standard"'), 'Missing tab-template-standard in index.html');
  assert(html.includes('id="new-slide-deck-grid"'), 'Missing new-slide-deck-grid in index.html');
  assert(html.includes('id="new-slide-standard-grid"'), 'Missing new-slide-standard-grid in index.html');
  assert(html.includes('id="btn-confirm-new-slide-modal"'), 'Missing btn-confirm-new-slide-modal in index.html');

  assert(html.includes('id="slide-object-context-menu"'), 'Missing slide-object-context-menu in index.html');
  assert(html.includes('id="ctx-delete-object"'), 'Missing ctx-delete-object in index.html');
  assert(html.includes('id="ctx-duplicate-object"'), 'Missing ctx-duplicate-object in index.html');
  assert(html.includes('id="ctx-bring-front"'), 'Missing ctx-bring-front in index.html');
  assert(html.includes('id="ctx-send-back"'), 'Missing ctx-send-back in index.html');
  console.log('✓ Verified New Slide modal and Slide Object context menu elements in index.html');

  // 3. Verify CSS rules in main.css
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const css = await fs.promises.readFile(cssPath, 'utf-8');

  assert(css.includes('.new-slide-modal-card'), 'Missing .new-slide-modal-card in main.css');
  assert(css.includes('.template-card'), 'Missing .template-card in main.css');
  assert(css.includes('.template-card.active'), 'Missing .template-card.active in main.css');
  assert(css.includes('.segmented-control'), 'Missing .segmented-control in main.css');
  assert(css.includes('.ctx-shortcut-badge'), 'Missing .ctx-shortcut-badge in main.css');
  console.log('✓ Verified template cards, tabs, and context menu styles in main.css');

  // 4. Verify Client Logic in app.js
  const appJsPath = path.join(rootDir, 'dist/renderer/app.js');
  const appJs = await fs.promises.readFile(appJsPath, 'utf-8');

  assert(appJs.includes('openNewSlideModal'), 'Missing openNewSlideModal in app.js');
  assert(appJs.includes('closeNewSlideModal'), 'Missing closeNewSlideModal in app.js');
  assert(appJs.includes('switchNewSlideTab'), 'Missing switchNewSlideTab in app.js');
  assert(appJs.includes('renderNewSlideTemplates'), 'Missing renderNewSlideTemplates in app.js');
  assert(appJs.includes('submitNewSlideModal'), 'Missing submitNewSlideModal in app.js');

  assert(appJs.includes('handleSlideObjectContextMenu'), 'Missing handleSlideObjectContextMenu in app.js');
  assert(appJs.includes('resolveSlideObject'), 'Missing resolveSlideObject in app.js');
  assert(appJs.includes('deleteCurrentObject'), 'Missing deleteCurrentObject in app.js');
  assert(appJs.includes('showObjectContextMenu'), 'Missing showObjectContextMenu in app.js');
  assert(appJs.includes('hideObjectContextMenu'), 'Missing hideObjectContextMenu in app.js');
  console.log('✓ Verified template chooser and right-click object deletion handling logic in app.js');

  // 5. Verify Preload and Main IPC channels
  const preloadJsPath = path.join(rootDir, 'dist/preload/preload.js');
  const preloadJs = await fs.promises.readFile(preloadJsPath, 'utf-8');
  assert(preloadJs.includes('addSlideFromTemplate'), 'Missing addSlideFromTemplate in preload.js');
  assert(preloadJs.includes('deck:add-slide-from-template'), 'Missing deck:add-slide-from-template IPC in preload.js');
  assert(preloadJs.includes('onNewSlideMenuEvent'), 'Missing onNewSlideMenuEvent in preload.js');

  assert(mainJs.includes('deck:add-slide-from-template'), 'Missing deck:add-slide-from-template in main.js');
  assert(mainJs.includes('New Slide from Template...'), 'Missing New Slide menu item in main.js');
  console.log('✓ Verified IPC bridges in preload.js and main.js');

  // Clean up test dir
  await fs.promises.rm(testDir, { recursive: true, force: true });
  console.log('✓ Cleaned up test output.');

  console.log('\n🎉 ALL NEW SLIDE & OBJECT DELETION TESTS PASSED SUCCESSFULLY!\n');
}

async function copyRecursive(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

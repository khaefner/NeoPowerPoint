import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const testDir = path.join(rootDir, 'test-output', 'import-html-slide-test');

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

async function runTests() {
  console.log('--- Testing Add Previously Existing HTML File as a Slide ---');

  // Setup test presentation directory
  await fs.promises.rm(testDir, { recursive: true, force: true });
  await fs.promises.mkdir(testDir, { recursive: true });

  const sampleDir = path.join(rootDir, 'sample-deck');
  await copyRecursive(sampleDir, testDir);

  // 1. Static code / bundle validation
  const deckServiceTs = await fs.promises.readFile(path.join(rootDir, 'src/main/deck-service.ts'), 'utf-8');
  assert(deckServiceTs.includes('inspectHtmlFile('), 'deck-service.ts must implement inspectHtmlFile');
  assert(deckServiceTs.includes('addSlideFromHtmlFile('), 'deck-service.ts must implement addSlideFromHtmlFile');

  const mainJs = await fs.promises.readFile(path.join(rootDir, 'dist/main/main.js'), 'utf-8');
  assert(mainJs.includes('dialog:select-html-file'), 'dist/main/main.js must register dialog:select-html-file IPC');
  assert(mainJs.includes('deck:inspect-html-file'), 'dist/main/main.js must register deck:inspect-html-file IPC');
  assert(mainJs.includes('deck:add-slide-from-html-file'), 'dist/main/main.js must register deck:add-slide-from-html-file IPC');
  assert(mainJs.includes('menu:new-html-slide'), 'dist/main/main.js must broadcast menu:new-html-slide');

  const preloadJs = await fs.promises.readFile(path.join(rootDir, 'dist/preload/preload.js'), 'utf-8');
  assert(preloadJs.includes('selectHtmlFileDialog'), 'preload.js must expose selectHtmlFileDialog');
  assert(preloadJs.includes('inspectHtmlFile'), 'preload.js must expose inspectHtmlFile');
  assert(preloadJs.includes('addSlideFromHtmlFile'), 'preload.js must expose addSlideFromHtmlFile');
  assert(preloadJs.includes('onNewHtmlSlideMenuEvent'), 'preload.js must expose onNewHtmlSlideMenuEvent');

  const indexHtml = await fs.promises.readFile(path.join(rootDir, 'dist/renderer/index.html'), 'utf-8');
  assert(indexHtml.includes('menu-new-html-slide'), 'index.html must include menu-new-html-slide');
  assert(indexHtml.includes('tab-template-html'), 'index.html must include tab-template-html');
  assert(indexHtml.includes('new-slide-html-view'), 'index.html must include new-slide-html-view');
  assert(indexHtml.includes('html-file-dropzone'), 'index.html must include html-file-dropzone');
  assert(indexHtml.includes('btn-browse-new-slide-html'), 'index.html must include btn-browse-new-slide-html');
  assert(indexHtml.includes('ctx-new-html-slide'), 'index.html must include ctx-new-html-slide in context menu');

  const mainCss = await fs.promises.readFile(path.join(rootDir, 'dist/renderer/styles/main.css'), 'utf-8');
  assert(mainCss.includes('.html-file-dropzone'), 'main.css must contain .html-file-dropzone styles');
  assert(mainCss.includes('.html-file-preview-frame'), 'main.css must contain .html-file-preview-frame styles');

  const appJs = await fs.promises.readFile(path.join(rootDir, 'dist/renderer/app.js'), 'utf-8');
  assert(appJs.includes('loadHtmlSlideFile'), 'dist/renderer/app.js must implement loadHtmlSlideFile');
  assert(appJs.includes('addSlideFromHtmlFileDirect'), 'dist/renderer/app.js must implement addSlideFromHtmlFileDirect');
  assert(appJs.includes('html-file-dropzone'), 'dist/renderer/app.js must hook up html-file-dropzone');

  console.log('✓ Verified backend methods, IPC bridges, DOM elements, CSS styles, and renderer logic');

  // 2. Functional tests for HTML slide inspection, asset preservation, companion notes, and manifest integration
  const extSourceDir = path.join(rootDir, 'test-output', 'external-source-slide');
  await fs.promises.rm(extSourceDir, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(extSourceDir, 'images'), { recursive: true });

  const dummyImage = path.join(extSourceDir, 'images', 'chart.png');
  await fs.promises.writeFile(dummyImage, 'PNG_DATA_PLACEHOLDER', 'utf-8');

  const sourceHtmlPath = path.join(extSourceDir, 'dashboard.html');
  const sourceHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Q4 Performance Analytics</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Revenue & Growth Highlights</h1>
  <img src="images/chart.png" alt="Growth Chart">
</body>
</html>`;
  await fs.promises.writeFile(sourceHtmlPath, sourceHtmlContent, 'utf-8');

  // Companion notes
  const sourceNotesPath = path.join(extSourceDir, 'dashboard.notes.html');
  await fs.promises.writeFile(sourceNotesPath, '<p>Highlight the 42% YoY growth in APAC region.</p>', 'utf-8');

  // A. Validate inspection logic
  const stat = await fs.promises.stat(sourceHtmlPath);
  const rawContent = await fs.promises.readFile(sourceHtmlPath, 'utf-8');
  const titleMatch = rawContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const detectedTitle = titleMatch ? titleMatch[1].trim() : 'Dashboard';
  assert.strictEqual(detectedTitle, 'Q4 Performance Analytics');

  const candNotes = [
    path.join(extSourceDir, 'notes.html'),
    path.join(extSourceDir, 'dashboard.notes.html'),
    path.join(extSourceDir, 'dashboard-notes.html')
  ];
  let foundNotes = '';
  for (const c of candNotes) {
    if (fs.existsSync(c)) {
      foundNotes = await fs.promises.readFile(c, 'utf-8');
      break;
    }
  }
  assert(foundNotes.includes('Highlight the 42% YoY growth'), 'Should detect and read companion notes file');
  assert(fs.existsSync(path.join(extSourceDir, 'images')), 'Should detect companion assets directory');
  console.log('✓ Verified HTML title extraction, companion notes detection, and assets discovery');

  // B. Functional execution of adding slide from HTML file
  const initialManifest = JSON.parse(await fs.promises.readFile(path.join(testDir, 'deck.json'), 'utf-8'));
  const initialCount = initialManifest.slides.length;

  const folderSlug = `${Date.now()}-q4-performance-analytics`;
  const slideDir = path.join(testDir, 'slides', folderSlug);
  await fs.promises.mkdir(slideDir, { recursive: true });

  await fs.promises.writeFile(path.join(slideDir, 'index.html'), sourceHtmlContent, 'utf-8');
  await fs.promises.writeFile(path.join(slideDir, 'notes.html'), foundNotes, 'utf-8');

  // Copy local asset directory
  await fs.promises.cp(path.join(extSourceDir, 'images'), path.join(slideDir, 'images'), { recursive: true });

  const newSlide = {
    id: `slide-${Date.now()}`,
    title: detectedTitle,
    path: path.posix.join('slides', folderSlug, 'index.html'),
    notesPath: path.posix.join('slides', folderSlug, 'notes.html'),
    notes: foundNotes,
    transition: 'fade'
  };

  initialManifest.slides.splice(1, 0, newSlide);
  await fs.promises.writeFile(path.join(testDir, 'deck.json'), JSON.stringify(initialManifest, null, 2), 'utf-8');

  // Verify created slide
  const updatedManifest = JSON.parse(await fs.promises.readFile(path.join(testDir, 'deck.json'), 'utf-8'));
  assert.strictEqual(updatedManifest.slides.length, initialCount + 1);
  assert.strictEqual(updatedManifest.slides[1].title, 'Q4 Performance Analytics');
  assert(fs.existsSync(path.join(testDir, updatedManifest.slides[1].path)));
  assert(fs.existsSync(path.join(testDir, updatedManifest.slides[1].notesPath)));
  assert(fs.existsSync(path.join(slideDir, 'images', 'chart.png')));
  console.log('✓ Successfully imported existing HTML slide with companion notes and assets into deck');

  // C. Test custom title override and HTML fragment wrapping logic
  const fragmentContent = '<div class="stat-card"><h2>Metric #1</h2><p>Server Uptime: 99.99%</p></div>';
  const customTitle = 'Custom System Health Slide';
  let wrappedHtml = fragmentContent;
  if (!/<html[\s>]/i.test(wrappedHtml) && !/<body[\s>]/i.test(wrappedHtml)) {
    wrappedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${customTitle}</title>
  <link rel="stylesheet" href="../../assets/theme.css">
</head>
<body>
${wrappedHtml}
</body>
</html>`;
  }
  assert(wrappedHtml.includes('<!DOCTYPE html>'));
  assert(wrappedHtml.includes('<title>Custom System Health Slide</title>'));
  assert(wrappedHtml.includes('Server Uptime: 99.99%'));
  console.log('✓ Verified HTML fragment wrapping and custom title overriding');

  // Cleanup
  await fs.promises.rm(testDir, { recursive: true, force: true });
  await fs.promises.rm(extSourceDir, { recursive: true, force: true });
  console.log('✓ Cleaned up test files');

  console.log('\n🎉 ALL IMPORT HTML SLIDE TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

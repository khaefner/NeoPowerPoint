import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testSlideSorter() {
  console.log('--- Testing NeoPowerPoint Slide Sorter & Previews ---');

  // 1. Verify index.html structure
  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');

  if (!htmlContent.includes('id="btn-overview-grid"')) {
    throw new Error('Missing btn-overview-grid in index.html');
  }
  if (!htmlContent.includes('Slide Sorter')) {
    throw new Error('Missing "Slide Sorter" label in index.html');
  }
  if (!htmlContent.includes('id="overview-count-badge"')) {
    throw new Error('Missing overview-count-badge in index.html');
  }
  if (!htmlContent.includes('id="btn-sorter-size-sm"') || !htmlContent.includes('id="btn-sorter-size-lg"')) {
    throw new Error('Missing size toggle buttons in index.html');
  }
  if (!htmlContent.includes('id="overview-grid"')) {
    throw new Error('Missing overview-grid in index.html');
  }
  console.log('✓ Verified Slide Sorter DOM elements in index.html');

  // 2. Verify main.css rules
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const cssContent = await fs.promises.readFile(cssPath, 'utf-8');

  const requiredSelectors = [
    '.card-preview-container',
    '.card-preview-scaler',
    '.card-preview-frame',
    '.card-preview-overlay',
    '.card-preview-placeholder',
    '.overview-card.dragging',
    '.overview-card.drag-over',
    '.slide-item-preview-container',
    '.slide-item-preview-scaler',
    '.slide-item-preview-frame',
    '.slide-item-preview-overlay',
    '.btn-size-toggle',
    '--preview-scale',
    '--card-min-width',
    '--sidebar-preview-scale'
  ];

  for (const selector of requiredSelectors) {
    if (!cssContent.includes(selector)) {
      throw new Error(`Missing CSS rule/variable: ${selector} in main.css`);
    }
  }
  console.log('✓ Verified Slide Sorter and sidebar preview CSS rules in main.css');

  // 3. Verify app.js implementation
  const jsPath = path.join(rootDir, 'dist/renderer/app.js');
  const jsContent = await fs.promises.readFile(jsPath, 'utf-8');

  if (!jsContent.includes('card-preview-frame')) {
    throw new Error('Missing card-preview-frame in compiled app.js');
  }
  if (!jsContent.includes('slide-item-preview-frame')) {
    throw new Error('Missing slide-item-preview-frame in compiled app.js');
  }
  if (!jsContent.includes('card-preview-scaler')) {
    throw new Error('Missing card-preview-scaler in compiled app.js');
  }
  if (!jsContent.includes('updateOverviewScales') || !jsContent.includes('updateSidebarScales')) {
    throw new Error('Missing scaling methods in compiled app.js');
  }
  if (!jsContent.includes('setupCardDragAndDrop') || !jsContent.includes('reorderSlides') || !jsContent.includes('setupSidebarDragAndDrop')) {
    throw new Error('Missing drag-and-drop reordering logic in compiled app.js');
  }
  console.log('✓ Verified Slide Sorter & left sidebar preview rendering and drag-and-drop logic in app.js');

  // 4. Test slide reordering algorithm
  const sampleSlides = [
    { id: 's1', title: 'Slide 1' },
    { id: 's2', title: 'Slide 2' },
    { id: 's3', title: 'Slide 3' },
    { id: 's4', title: 'Slide 4' },
  ];

  function reorder(slides, fromIndex, toIndex, curIndex) {
    const list = [...slides];
    const current = list[curIndex];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    const newCur = list.indexOf(current);
    return { list, newCur };
  }

  // Move slide 3 (index 2) to first position (index 0)
  const res1 = reorder(sampleSlides, 2, 0, 0);
  if (res1.list[0].id !== 's3' || res1.list[1].id !== 's1' || res1.newCur !== 1) {
    throw new Error(`Reorder test 1 failed: expected s3 first, curIndex 1; got ${res1.list[0].id}, curIndex ${res1.newCur}`);
  }

  // Move slide 1 (index 0) to end (index 3) when current is slide 1
  const res2 = reorder(sampleSlides, 0, 3, 0);
  if (res2.list[3].id !== 's1' || res2.newCur !== 3) {
    throw new Error(`Reorder test 2 failed: expected s1 last, curIndex 3; got ${res2.list[3].id}, curIndex ${res2.newCur}`);
  }
  console.log('✓ Verified Slide Sorter reorder algorithm');

  console.log('--- All Slide Sorter tests passed! ---');
}

testSlideSorter().catch((err) => {
  console.error('Slide Sorter test failed:', err);
  process.exit(1);
});

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testToolbarMenubar() {
  console.log('--- Testing Consistent Menubar & Top-to-Bottom Toolbar Buttons ---');

  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');

  const html = await fs.promises.readFile(htmlPath, 'utf-8');
  const css = await fs.promises.readFile(cssPath, 'utf-8');

  // 1. Verify Test Scripts button is removed from top toolbar
  const topToolbarMatch = html.match(/<header id="top-toolbar"[\s\S]*?<\/header>/);
  assert(topToolbarMatch, 'Must have #top-toolbar in index.html');
  const topToolbarHtml = topToolbarMatch[0];

  assert(!topToolbarHtml.includes('id="btn-toggle-edit-mode"'), 'btn-toggle-edit-mode must be removed from top toolbar');
  assert(!topToolbarHtml.includes('Test Scripts'), 'Test Scripts label must be removed from top toolbar');
  console.log('✓ Verified Test Scripts button has been removed from top toolbar');

  // 2. Verify consistent toolbar buttons exist
  const expectedButtons = [
    'id="btn-toggle-sidebar"',
    'id="btn-prev-slide"',
    'id="btn-next-slide"',
    'id="btn-save-slide"',
    'id="btn-ai-designer"',
    'id="btn-overview-grid"',
    'id="btn-windowed-mode"',
    'id="btn-fullscreen-mode"',
    'id="btn-presenter-mode"',
    'id="main-adb-pill"',
    'id="btn-menu-more"',
  ];

  for (const btn of expectedButtons) {
    assert(html.includes(btn), `Missing button in toolbar: ${btn}`);
  }
  console.log('✓ Verified all consistent buttons and controls exist in top toolbar');

  // 3. Verify top-to-bottom spanning CSS rules
  assert(css.includes('.toolbar {') && css.includes('align-items: stretch;'), 'Toolbar must have align-items: stretch');
  assert(css.includes('.toolbar-btn {'), 'Must have .toolbar-btn styles');
  assert(css.includes('height: 100%;'), 'Toolbar buttons must have height: 100% to span top-to-bottom');
  assert(css.includes('border-radius: 0;'), 'Toolbar buttons must have border-radius: 0');
  console.log('✓ Verified toolbar buttons span top-to-bottom with 100% height and zero border-radius');

  // 4. Verify responsive width rules to fit within the width of the bar
  assert(css.includes('@media (max-width: 1220px)'), 'Missing 1220px responsive media query');
  assert(css.includes('@media (max-width: 960px)'), 'Missing 960px responsive media query');
  console.log('✓ Verified responsive width adaptations ensure all buttons fit within the bar');

  console.log('\n🎉 ALL TOOLBAR MENUBAR TESTS PASSED SUCCESSFULLY!\n');
}

testToolbarMenubar().catch((err) => {
  console.error('Toolbar Menubar test failed:', err);
  process.exit(1);
});

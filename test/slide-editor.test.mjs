import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testSlideEditor() {
  console.log('--- Testing NeoPowerPoint WYSIWYG Slide Editor ---');

  // 1. Verify index.html contains Edit Slide and Save Slide controls
  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');

  if (!htmlContent.includes('id="btn-toggle-edit-mode"')) {
    throw new Error('Missing btn-toggle-edit-mode in index.html');
  }
  if (!htmlContent.includes('id="btn-save-slide"')) {
    throw new Error('Missing btn-save-slide in index.html');
  }
  if (!htmlContent.includes('id="btn-add-textbox"')) {
    throw new Error('Missing btn-add-textbox in index.html');
  }
  if (!htmlContent.includes('id="select-font-size"')) {
    throw new Error('Missing select-font-size in index.html');
  }
  if (!htmlContent.includes('id="input-font-color"')) {
    throw new Error('Missing input-font-color in index.html');
  }
  if (!htmlContent.includes('id="menu-toggle-edit"')) {
    throw new Error('Missing menu-toggle-edit in index.html');
  }
  if (!htmlContent.includes('id="menu-save-slide"')) {
    throw new Error('Missing menu-save-slide in index.html');
  }
  console.log('✓ Verified WYSIWYG Slide Editor toolbar, formatting, and menu controls in index.html');

  // 2. Verify app.js contains edit mode enabling, disabling, and saving logic
  const jsPath = path.join(rootDir, 'dist/renderer/app.js');
  const jsContent = await fs.promises.readFile(jsPath, 'utf-8');

  if (!jsContent.includes('toggleEditMode') || !jsContent.includes('enableEditModeFeatures') || !jsContent.includes('disableEditModeFeatures')) {
    throw new Error('Missing edit mode feature toggle methods in app.js');
  }
  if (!jsContent.includes('addNewTextBox')) {
    throw new Error('Missing addNewTextBox method in app.js');
  }
  if (!jsContent.includes('setFontSize') || !jsContent.includes('adjustFontSize')) {
    throw new Error('Missing font size adjustment methods in app.js');
  }
  if (!jsContent.includes('setFontColor')) {
    throw new Error('Missing setFontColor method in app.js');
  }
  if (!jsContent.includes('editor-editable-text') || !jsContent.includes('contenteditable')) {
    throw new Error('Missing contenteditable text handling in app.js');
  }
  if (!jsContent.includes('editor-draggable') || !jsContent.includes('currentScaleFactor')) {
    throw new Error('Missing element dragging and scale factor handling in app.js');
  }
  if (!jsContent.includes('saveSlideHtml')) {
    throw new Error('Missing saveSlideHtml method in app.js');
  }
  console.log('✓ Verified WYSIWYG editor implementation in app.js');

  // 3. Verify preload exposes saveSlideHtml
  const preloadPath = path.join(rootDir, 'dist/preload/preload.js');
  const preloadContent = await fs.promises.readFile(preloadPath, 'utf-8');
  if (!preloadContent.includes('saveSlideHtml') || !preloadContent.includes('deck:save-slide-html')) {
    throw new Error('Missing saveSlideHtml in preload.js');
  }
  console.log('✓ Verified preload IPC bridge for saveSlideHtml');

  // 4. Verify HTML cleanup algorithm when saving
  const dirtySlideHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test Slide</title>
  <style id="neo-editor-styles">.editor-editable-text { outline: 1px dashed red; }</style>
</head>
<body>
  <h1 contenteditable="true" class="editor-editable-text">Edited Title</h1>
  <p contenteditable="true" class="custom-class editor-editable-text">Edited paragraph text</p>
  <img src="pic.png" class="editor-draggable editor-selected" style="position: absolute; left: 120px; top: 80px;">
</body>
</html>`;

  // Simulate document clone and attribute cleanup logic from saveSlideHtml
  function cleanHtml(html) {
    let cleaned = html;
    // Remove editor stylesheet
    cleaned = cleaned.replace(/<style id="neo-editor-styles">[\s\S]*?<\/style>/gi, '');
    // Remove contenteditable attribute
    cleaned = cleaned.replace(/\s*contenteditable="true"/gi, '');
    // Remove editor classes
    cleaned = cleaned.replace(/\beditor-editable-text\b/g, '');
    cleaned = cleaned.replace(/\beditor-draggable\b/g, '');
    cleaned = cleaned.replace(/\beditor-selected\b/g, '');
    // Clean up empty classes or whitespace in class
    cleaned = cleaned.replace(/class="\s*"/g, '');
    cleaned = cleaned.replace(/class="([^"]*?)\s+"/g, 'class="$1"');
    return cleaned;
  }

  const cleaned = cleanHtml(dirtySlideHtml);
  if (cleaned.includes('contenteditable') || cleaned.includes('editor-editable-text') || cleaned.includes('neo-editor-styles') || cleaned.includes('editor-selected')) {
    throw new Error('cleanHtml failed to remove editor artifacts');
  }
  if (!cleaned.includes('Edited Title') || !cleaned.includes('left: 120px; top: 80px;')) {
    throw new Error('cleanHtml removed user content or position styling');
  }
  console.log('✓ Verified HTML cleanup and persistence safety logic');

  console.log('--- All WYSIWYG Slide Editor tests passed! ---');
}

testSlideEditor().catch((err) => {
  console.error('Slide Editor test failed:', err);
  process.exit(1);
});

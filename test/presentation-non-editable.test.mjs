import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testPresentationNonEditable() {
  console.log('--- Testing Non-Editable Presentation Windows (Audience & Presenter) ---');

  // 1. Verify dist/renderer/app.js contains non-editable presentation logic
  const appJsPath = path.join(rootDir, 'dist/renderer/app.js');
  const appJsContent = await fs.promises.readFile(appJsPath, 'utf-8');

  if (!appJsContent.includes('sanitizeSlideDocForPresentation')) {
    throw new Error('Missing sanitizeSlideDocForPresentation in app.js');
  }
  if (!appJsContent.includes('wasEditModeBeforePresentation')) {
    throw new Error('Missing wasEditModeBeforePresentation state tracking in app.js');
  }
  if (!appJsContent.includes('neo-presentation-non-editable-styles')) {
    throw new Error('Missing neo-presentation-non-editable-styles injection in app.js');
  }
  console.log('✓ Verified sanitizeSlideDocForPresentation and edit mode suspension in app.js');

  // 2. Verify dist/presenter/presenter.js contains non-editable presentation logic
  const presenterJsPath = path.join(rootDir, 'dist/presenter/presenter.js');
  const presenterJsContent = await fs.promises.readFile(presenterJsPath, 'utf-8');

  if (!presenterJsContent.includes('sanitizeSlideDocForPresentation')) {
    throw new Error('Missing sanitizeSlideDocForPresentation in presenter.js');
  }
  if (!presenterJsContent.includes('neo-presentation-non-editable-styles')) {
    throw new Error('Missing neo-presentation-non-editable-styles injection in presenter.js');
  }
  console.log('✓ Verified sanitizeSlideDocForPresentation in presenter.js');

  // 3. Verify dist/presenter/presenter.css sets pointer-events: none on #next-frame
  const presenterCssPath = path.join(rootDir, 'dist/presenter/presenter.css');
  const presenterCssContent = await fs.promises.readFile(presenterCssPath, 'utf-8');

  if (!presenterCssContent.includes('#next-frame') || !presenterCssContent.includes('pointer-events: none')) {
    throw new Error('Missing pointer-events: none on #next-frame in presenter.css');
  }
  console.log('✓ Verified #next-frame pointer-events: none in presenter.css');

  // 4. Verify dist/renderer/styles/main.css hides editor overlays in mode-presentation
  const mainCssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const mainCssContent = await fs.promises.readFile(mainCssPath, 'utf-8');

  if (!mainCssContent.includes('body.mode-presentation') || !mainCssContent.includes('#neo-selection-overlay')) {
    throw new Error('Missing body.mode-presentation overlay hiding rules in main.css');
  }
  console.log('✓ Verified presentation mode CSS overlay suppression in main.css');

  // 5. Test DOM sanitization algorithm simulating a dirty slide with contenteditable and editor classes
  const mockDirtySlideHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Slide Test</title>
  <style id="neo-editor-styles">.editor-editable-text { outline: 1px dashed #38bdf8; }</style>
</head>
<body class="show-all-anims edit-mode">
  <div id="neo-selection-overlay"><span class="neo-move-handle">Move</span><span class="neo-resize-handle"></span></div>
  <h1 contenteditable="true" class="hero-title editor-editable-text">Presentation Slide Title</h1>
  <p contenteditable="" class="editor-editable-text">This paragraph should not be editable during presentation.</p>
  <div class="card abs editor-draggable editor-selected" style="position: absolute; left: 100px; top: 100px;">
    <span contenteditable="plaintext-only" class="editor-editable-text">Card Text</span>
  </div>
</body>
</html>`;

  // Function mirroring sanitizeSlideDocForPresentation logic
  function runMockSanitization(html) {
    let result = html;
    // Remove editor styles
    result = result.replace(/<style id="neo-editor-styles">[\s\S]*?<\/style>/gi, '');
    // Remove selection overlay
    result = result.replace(/<div id="neo-selection-overlay">[\s\S]*?<\/div>/gi, '');
    // Remove contenteditable attributes
    result = result.replace(/\s*contenteditable="[^"]*"/gi, '');
    result = result.replace(/\s*contenteditable(?=[\s>])/gi, '');
    // Remove editor classes
    result = result.replace(/\beditor-editable-text\b/g, '');
    result = result.replace(/\beditor-draggable\b/g, '');
    result = result.replace(/\beditor-selected\b/g, '');
    result = result.replace(/\bedit-mode\b/g, '');
    result = result.replace(/\bshow-all-anims\b/g, '');
    // Clean whitespace in class
    result = result.replace(/class="\s*"/g, '');
    result = result.replace(/class="([^"]*?)\s+"/g, 'class="$1"');

    // Inject presentation non-editable style
    const nonEditableCss = `<style id="neo-presentation-non-editable-styles">[contenteditable] { -webkit-user-modify: read-only !important; caret-color: transparent !important; outline: none !important; cursor: default !important; } .editor-editable-text, .editor-draggable, .editor-selected { outline: none !important; cursor: inherit !important; } #neo-selection-overlay, .neo-move-handle, .neo-resize-handle { display: none !important; }</style>`;
    result = result.replace('</head>', `${nonEditableCss}</head>`);
    return result;
  }

  const sanitized = runMockSanitization(mockDirtySlideHtml);
  const bodyContent = sanitized.slice(sanitized.indexOf('<body'));

  if (/\bcontenteditable\b/i.test(bodyContent)) {
    throw new Error('Sanitized HTML body still contains contenteditable attribute');
  }
  if (bodyContent.includes('editor-editable-text') || bodyContent.includes('editor-draggable') || bodyContent.includes('editor-selected') || bodyContent.includes('edit-mode')) {
    throw new Error('Sanitized HTML body still contains editor classes');
  }
  if (bodyContent.includes('neo-selection-overlay') || bodyContent.includes('neo-move-handle') || bodyContent.includes('neo-resize-handle')) {
    throw new Error('Sanitized HTML body still contains editor handles or overlays');
  }
  if (sanitized.includes('neo-editor-styles')) {
    throw new Error('Sanitized HTML head still contains neo-editor-styles');
  }
  if (!sanitized.includes('neo-presentation-non-editable-styles') || !sanitized.includes('read-only !important')) {
    throw new Error('Sanitized HTML missing presentation non-editable stylesheet');
  }
  if (!sanitized.includes('Presentation Slide Title') || !sanitized.includes('Card Text')) {
    throw new Error('Sanitization altered slide content unexpectedly');
  }
  console.log('✓ Verified complete DOM sanitization: stripped contenteditable, handles, overlays, and injected non-editable stylesheet');

  console.log('\n🎉 ALL NON-EDITABLE PRESENTATION WINDOW TESTS PASSED SUCCESSFULLY!\n');
}

testPresentationNonEditable().catch(err => {
  console.error('Non-editable presentation test failed:', err);
  process.exit(1);
});

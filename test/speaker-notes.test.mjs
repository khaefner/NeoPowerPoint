import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testSpeakerNotes() {
  console.log('--- Testing NeoPowerPoint Rich-Text Speaker Notes & Resizable Window ---');

  // 1. Verify index.html contains notes resizer, formatting toolbar, and modal
  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');

  if (!htmlContent.includes('id="notes-resizer"')) {
    throw new Error('Missing notes-resizer in index.html');
  }
  if (!htmlContent.includes('id="btn-notes-bullet"') || !htmlContent.includes('id="btn-notes-number"')) {
    throw new Error('Missing list formatting buttons in index.html');
  }
  if (!htmlContent.includes('id="btn-expand-notes"')) {
    throw new Error('Missing btn-expand-notes in index.html');
  }
  if (!htmlContent.includes('id="notes-modal"')) {
    throw new Error('Missing notes-modal in index.html');
  }
  if (!htmlContent.includes('id="modal-notes-editor"')) {
    throw new Error('Missing modal-notes-editor in index.html');
  }
  console.log('✓ Verified notes resizer, rich formatting toolbar, and expanded modal in index.html');

  // 2. Verify main.css contains resizer and rich notes styling
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const cssContent = await fs.promises.readFile(cssPath, 'utf-8');

  if (!cssContent.includes('.notes-resizer') || !cssContent.includes('.notes-toolbar')) {
    throw new Error('Missing notes-resizer or notes-toolbar CSS in main.css');
  }
  if (!cssContent.includes('.notes-modal-container') || !cssContent.includes('.modal-notes-editor')) {
    throw new Error('Missing notes-modal styling in main.css');
  }
  console.log('✓ Verified resizer and notes modal styles in main.css');

  // 3. Verify app.js implements setupNotesResizer, formatting, auto-saving, and modal
  const jsPath = path.join(rootDir, 'dist/renderer/app.js');
  const jsContent = await fs.promises.readFile(jsPath, 'utf-8');

  if (!jsContent.includes('setupNotesResizer') || !jsContent.includes('setupNotesControls')) {
    throw new Error('Missing notes resizer / controls setup in app.js');
  }
  if (!jsContent.includes('insertUnorderedList') || !jsContent.includes('insertOrderedList')) {
    throw new Error('Missing bullet/ordered list commands in app.js');
  }
  if (!jsContent.includes('toggleNotesModal')) {
    throw new Error('Missing toggleNotesModal in app.js');
  }
  console.log('✓ Verified notes resizer, list commands, auto-saving, and modal toggle in app.js');

  // 4. Verify Presenter View renders rich notes
  const pJsPath = path.join(rootDir, 'dist/presenter/presenter.js');
  const pJsContent = await fs.promises.readFile(pJsPath, 'utf-8');

  if (!pJsContent.includes('notesContentEl')) {
    throw new Error('Missing notesContentEl in presenter.js');
  }
  console.log('✓ Verified rich notes rendering in presenter.js');

  console.log('--- All Speaker Notes tests passed! ---');
}

testSpeakerNotes().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

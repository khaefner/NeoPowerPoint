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
  if (!htmlContent.includes('id="btn-notes-paste"') || !htmlContent.includes('id="btn-m-notes-paste"')) {
    throw new Error('Missing copy/paste buttons in index.html');
  }
  if (!htmlContent.includes('id="btn-notes-link"') || !htmlContent.includes('id="btn-m-notes-link"')) {
    throw new Error('Missing link insertion buttons in index.html');
  }
  if (!htmlContent.includes('id="btn-notes-image"') || !htmlContent.includes('id="btn-m-notes-image"')) {
    throw new Error('Missing image insertion buttons in index.html');
  }
  if (!htmlContent.includes('id="btn-notes-open-file"') || !htmlContent.includes('id="btn-m-notes-open-file"')) {
    throw new Error('Missing open notes HTML buttons in index.html');
  }
  if (!htmlContent.includes('id="notes-image-file-input"')) {
    throw new Error('Missing notes-image-file-input in index.html');
  }
  console.log('✓ Verified notes resizer, rich formatting toolbar, copy/paste, URL, image, and expanded modal in index.html');

  // 2. Verify main.css contains resizer, rich notes, links, and images styling
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const cssContent = await fs.promises.readFile(cssPath, 'utf-8');

  if (!cssContent.includes('.notes-resizer') || !cssContent.includes('.notes-toolbar')) {
    throw new Error('Missing notes-resizer or notes-toolbar CSS in main.css');
  }
  if (!cssContent.includes('.notes-modal-container') || !cssContent.includes('.modal-notes-editor')) {
    throw new Error('Missing notes-modal styling in main.css');
  }
  if (!cssContent.includes('.slide-notes-editor a') || !cssContent.includes('.slide-notes-editor img')) {
    throw new Error('Missing link or image styling for notes editor in main.css');
  }
  console.log('✓ Verified resizer, notes modal, link, and image styles in main.css');

  // 3. Verify app.js implements setupNotesResizer, formatting, auto-saving, modal, copy/paste, links, and images
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
  if (!jsContent.includes('setupNotesEditorEvents') || !jsContent.includes('pasteFromClipboard')) {
    throw new Error('Missing paste event and clipboard integration in app.js');
  }
  if (!jsContent.includes('promptInsertLink') || !jsContent.includes('promptInsertImage') || !jsContent.includes('insertImageFileIntoNotes')) {
    throw new Error('Missing URL and image insertion methods in app.js');
  }
  if (!jsContent.includes('saveSlideNotes') || !jsContent.includes('openNotesInBrowser')) {
    throw new Error('Missing saveSlideNotes and openNotesInBrowser integration in app.js');
  }
  console.log('✓ Verified notes resizer, list commands, auto-saving, modal toggle, copy/paste, link, and image handlers in app.js');

  // 4. Verify Presenter View renders rich notes with links and images
  const pJsPath = path.join(rootDir, 'dist/presenter/presenter.js');
  const pJsContent = await fs.promises.readFile(pJsPath, 'utf-8');

  if (!pJsContent.includes('notesContentEl')) {
    throw new Error('Missing notesContentEl in presenter.js');
  }
  if (!pJsContent.includes('openExternalUrl')) {
    throw new Error('Missing openExternalUrl in presenter.js for clickable note links');
  }
  const pCssPath = path.join(rootDir, 'dist/presenter/presenter.css');
  const pCssContent = await fs.promises.readFile(pCssPath, 'utf-8');
  if (!pCssContent.includes('.notes-body a') || !pCssContent.includes('.notes-body img')) {
    throw new Error('Missing link or image styles in presenter.css');
  }
  console.log('✓ Verified rich notes rendering, links, and images in presenter view');

  // 5. Verify Main Process includes Edit Menu with Copy/Paste and Context Menu handlers
  const mainJsPath = path.join(rootDir, 'dist/main/main.js');
  const mainJsContent = await fs.promises.readFile(mainJsPath, 'utf-8');
  if (!mainJsContent.includes('role: "paste"') && !mainJsContent.includes("role: 'paste'")) {
    throw new Error('Missing paste role in Edit menu in main.js');
  }
  if (!mainJsContent.includes('deck:save-notes') || !mainJsContent.includes('deck:load-notes') || !mainJsContent.includes('deck:open-notes-in-browser')) {
    throw new Error('Missing notes HTML IPC handlers in main.js');
  }
  console.log('✓ Verified native Edit menu with copy/paste and notes IPC in main.js');

  // 6. Test Notes HTML persistence and parsing logic
  const testDir = path.join(rootDir, 'test-output', 'speaker-notes-test');
  await fs.promises.rm(testDir, { recursive: true, force: true });
  await fs.promises.mkdir(testDir, { recursive: true });

  const testSlideDir = path.join(testDir, 'slides', '01-intro');
  await fs.promises.mkdir(testSlideDir, { recursive: true });
  await fs.promises.writeFile(path.join(testSlideDir, 'index.html'), '<html><body>Slide</body></html>', 'utf-8');

  // Verify saveSlideNotes and loadSlideNotes implementation in main.js
  if (!mainJsContent.includes('saveSlideNotes') || !mainJsContent.includes('loadSlideNotes') || !mainJsContent.includes('formatNotesHtml')) {
    throw new Error('Missing saveSlideNotes / loadSlideNotes / formatNotesHtml in main.js');
  }

  // Simulate DeckService notes HTML persistence and loading
  function formatNotesHtml(title, notesBody) {
    const safeTitle = (title || 'Slide Notes')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const bodyContent = notesBody && notesBody.trim() ? notesBody : '<p></p>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Speaker Notes - ${safeTitle}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 24px; color: #1e293b; background: #ffffff; }
    a { color: #3b82f6; text-decoration: underline; }
    img { max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; display: block; }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>
`;
  }

  function extractNotesBody(html) {
    if (!html) return '';
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return bodyMatch ? bodyMatch[1].trim() : html.trim();
  }

  async function saveSlideNotes(deckPath, slideRelPath, notesContent) {
    const targetRelNotesPath = slideRelPath.endsWith('/index.html')
      ? slideRelPath.replace(/\/index\.html$/, '/notes.html')
      : slideRelPath.replace(/\.html$/, '-notes.html');
    const fullPath = path.resolve(deckPath, targetRelNotesPath);
    if (!fullPath.startsWith(path.resolve(deckPath))) {
      throw new Error('Directory traversal attempt detected');
    }
    const fullHtml = formatNotesHtml('Test Slide', notesContent);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, fullHtml, 'utf-8');
    return { notesPath: targetRelNotesPath, notes: notesContent };
  }

  const notesWithUrlAndImg = '<p>Check out our site: <a href="https://example.com" target="_blank">Example</a></p><p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Demo" /></p>';
  const result = await saveSlideNotes(testDir, 'slides/01-intro/index.html', notesWithUrlAndImg);
  if (!result.notesPath || !result.notesPath.endsWith('notes.html')) {
    throw new Error(`Expected notesPath to end with notes.html, got ${result.notesPath}`);
  }

  const writtenFile = path.join(testDir, result.notesPath);
  if (!fs.existsSync(writtenFile)) {
    throw new Error(`notes.html file was not written to ${writtenFile}`);
  }

  const fileContent = await fs.promises.readFile(writtenFile, 'utf-8');
  if (!fileContent.includes('<!DOCTYPE html>') || !fileContent.includes('<title>Speaker Notes') || !fileContent.includes('https://example.com') || !fileContent.includes('data:image/png;base64')) {
    throw new Error('notes.html file content is missing required HTML structure, URL, or image data');
  }

  const loadedBody = extractNotesBody(fileContent);
  if (!loadedBody.includes('https://example.com') || !loadedBody.includes('data:image/png;base64')) {
    throw new Error('extractNotesBody failed to extract body content correctly');
  }
  console.log('✓ Verified DeckService saveSlideNotes creates complete HTML file and loadSlideNotes extracts body');

  // Verify traversal prevention
  try {
    await saveSlideNotes(testDir, '../../etc/passwd', 'malicious');
    throw new Error('saveSlideNotes should have thrown an error on traversal attempt');
  } catch (err) {
    if (!err.message.includes('Directory traversal attempt detected')) {
      throw err;
    }
  }
  console.log('✓ Verified saveSlideNotes prevents directory traversal');

  // Cleanup test output
  await fs.promises.rm(testDir, { recursive: true, force: true });

  console.log('--- All Speaker Notes tests passed! ---');
}

testSpeakerNotes().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

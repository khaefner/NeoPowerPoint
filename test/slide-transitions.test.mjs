import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function testSlideTransitions() {
  console.log('--- Testing NeoPowerPoint Double-Buffered Slide Transitions ---');

  // 1. Verify index.html contains double-buffered iframes and transition menu
  const htmlPath = path.join(rootDir, 'dist/renderer/index.html');
  const htmlContent = await fs.promises.readFile(htmlPath, 'utf-8');

  if (!htmlContent.includes('id="slide-frame-a"') || !htmlContent.includes('id="slide-frame-b"')) {
    throw new Error('Missing double-buffered iframes slide-frame-a or slide-frame-b in index.html');
  }
  if (!htmlContent.includes('id="menu-trans-fade"') || !htmlContent.includes('id="menu-trans-slide"')) {
    throw new Error('Missing transition menu options in index.html');
  }
  console.log('✓ Verified double-buffered iframe elements and transition menu in index.html');

  // 2. Verify main.css contains transition styles
  const cssPath = path.join(rootDir, 'dist/renderer/styles/main.css');
  const cssContent = await fs.promises.readFile(cssPath, 'utf-8');

  if (!cssContent.includes('.slide-frame.slide-frame-active') || !cssContent.includes('.slide-frame.slide-frame-idle')) {
    throw new Error('Missing active / idle slide frame CSS classes in main.css');
  }
  console.log('✓ Verified active and idle frame CSS rules in main.css');

  // 3. Verify app.js contains double-buffer getters and goToSlide transition logic
  const jsPath = path.join(rootDir, 'dist/renderer/app.js');
  const jsContent = await fs.promises.readFile(jsPath, 'utf-8');

  if (!jsContent.includes('slideFrameA') || !jsContent.includes('slideFrameB')) {
    throw new Error('Missing slideFrameA / slideFrameB initialization in app.js');
  }
  if (!jsContent.includes('setDeckTransition')) {
    throw new Error('Missing setDeckTransition in app.js');
  }
  if (!jsContent.includes('cubic-bezier')) {
    throw new Error('Missing smooth cubic-bezier transition easing in app.js');
  }
  console.log('✓ Verified double-buffer buffer management and transition animations in app.js');

  console.log('--- All Slide Transition tests passed! ---');
}

testSlideTransitions().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Process ${cmd} exited with code ${code}: ${stderr || stdout}`));
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

async function runTests() {
  console.log('--- Testing PowerPoint (.pptx) Import & Deck Conversion ---');

  const pptxFile = path.join(rootDir, 'CS457_8_1_Midterm_Review.pptx');
  if (!fs.existsSync(pptxFile)) {
    throw new Error(`Sample PPTX file not found: ${pptxFile}`);
  }

  const testOutputDir = path.join(rootDir, 'test-output', 'pptx-import-test');
  const tempExtractDir = path.join(testOutputDir, 'extracted_raw');
  const convertedDeckDir = path.join(testOutputDir, 'converted_deck');

  // Clean test dirs
  await fs.promises.rm(testOutputDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempExtractDir, { recursive: true });
  await fs.promises.mkdir(convertedDeckDir, { recursive: true });

  const converterDir = path.join(rootDir, 'src', 'converter');
  const extractScript = path.join(converterDir, 'extract_pptx.py');
  const generateScript = path.join(converterDir, 'generate_deck.py');

  if (!fs.existsSync(extractScript) || !fs.existsSync(generateScript)) {
    throw new Error('Converter scripts missing in src/converter');
  }

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  // 1. Run extract_pptx.py
  console.log('Running extract_pptx.py...');
  const extractOut = await runProcess(pythonCmd, [extractScript, pptxFile, '--out', tempExtractDir]);
  console.log('✓ extract_pptx.py completed:', extractOut.trim().split('\n').pop());

  const extractJsonPath = path.join(tempExtractDir, 'extract.json');
  if (!fs.existsSync(extractJsonPath)) {
    throw new Error('extract.json was not created');
  }
  const extractData = JSON.parse(await fs.promises.readFile(extractJsonPath, 'utf-8'));
  const mediaDir = path.join(tempExtractDir, 'media');
  const mediaCount = fs.existsSync(mediaDir) ? (await fs.promises.readdir(mediaDir)).length : 0;
  console.log(`✓ Extracted metadata: ${extractData.slides.length} slides, ${mediaCount} media files, ${Object.keys(extractData.masters).length} masters.`);

  if (extractData.slides.length === 0) {
    throw new Error('No slides were extracted from PPTX');
  }

  // 2. Run generate_deck.py
  console.log('Running generate_deck.py...');
  const genOut = await runProcess(pythonCmd, [generateScript, '--extract', extractJsonPath, '--out', convertedDeckDir]);
  console.log('✓ generate_deck.py completed:', genOut.trim().split('\n').pop());

  // 3. Validate generated deck files
  const deckJsonPath = path.join(convertedDeckDir, 'deck.json');
  if (!fs.existsSync(deckJsonPath)) {
    throw new Error('Generated deck missing deck.json');
  }

  const manifest = JSON.parse(await fs.promises.readFile(deckJsonPath, 'utf-8'));
  console.log(`✓ Generated deck manifest title: "${manifest.title}"`);
  console.log(`✓ Slides count: ${manifest.slides.length}`);

  if (manifest.slides.length !== extractData.slides.length) {
    throw new Error(`Slide count mismatch in manifest: expected ${extractData.slides.length}, got ${manifest.slides.length}`);
  }

  // 4. Check theme CSS
  const themeCssPath = path.join(convertedDeckDir, 'assets', 'theme.css');
  if (!fs.existsSync(themeCssPath)) {
    throw new Error('Generated deck missing assets/theme.css');
  }
  const themeCssContent = await fs.promises.readFile(themeCssPath, 'utf-8');
  if (!themeCssContent.includes('--slide-width') || !themeCssContent.includes('--color-primary')) {
    throw new Error('theme.css missing expected CSS custom properties');
  }
  console.log('✓ Validated assets/theme.css geometry and variables');

  // 5. Check each slide HTML
  for (const slide of manifest.slides) {
    const slidePath = path.join(convertedDeckDir, slide.path);
    if (!fs.existsSync(slidePath)) {
      throw new Error(`Slide HTML file not found: ${slide.path}`);
    }
    const htmlContent = await fs.promises.readFile(slidePath, 'utf-8');
    if (!htmlContent.includes('<!DOCTYPE html>') || !htmlContent.includes('slide-container')) {
      throw new Error(`Slide HTML is invalid or missing container: ${slide.path}`);
    }
  }
  console.log(`✓ Verified all ${manifest.slides.length} slide HTML files exist and contain valid slide containers`);

  console.log('\n🎉 ALL PPTX IMPORT TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

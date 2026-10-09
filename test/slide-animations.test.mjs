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
  console.log('--- Testing PowerPoint Animation Preservation (CS457_7_3.pptx) ---');

  const pptxFile = path.join(rootDir, 'CS457_7_3.pptx');
  if (!fs.existsSync(pptxFile)) {
    throw new Error(`Sample animated PPTX file not found: ${pptxFile}`);
  }

  const testOutputDir = path.join(rootDir, 'test-output', 'pptx-animation-test');
  const tempExtractDir = path.join(testOutputDir, 'extracted_raw');
  const convertedDeckDir = path.join(testOutputDir, 'converted_deck');

  // Clean test dirs
  await fs.promises.rm(testOutputDir, { recursive: true, force: true });
  await fs.promises.mkdir(tempExtractDir, { recursive: true });
  await fs.promises.mkdir(convertedDeckDir, { recursive: true });

  const converterDir = path.join(rootDir, 'src', 'converter');
  const extractScript = path.join(converterDir, 'extract_pptx.py');
  const generateScript = path.join(converterDir, 'generate_deck.py');

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  // 1. Run extract_pptx.py
  console.log('Running extract_pptx.py on CS457_7_3.pptx...');
  const extractOut = await runProcess(pythonCmd, [extractScript, pptxFile, '--out', tempExtractDir]);
  console.log('✓ extract_pptx.py completed:', extractOut.trim().split('\n').pop());

  const extractJsonPath = path.join(tempExtractDir, 'extract.json');
  if (!fs.existsSync(extractJsonPath)) {
    throw new Error('extract.json was not created');
  }
  const extractData = JSON.parse(await fs.promises.readFile(extractJsonPath, 'utf-8'));
  console.log(`✓ Extracted ${extractData.slides.length} slides from CS457_7_3.pptx`);

  const animatedSlidesInExtract = extractData.slides.filter(s => s.animations && s.animations.steps && s.animations.steps.length > 0);
  console.log(`✓ Found ${animatedSlidesInExtract.length} animated slides in extracted data.`);
  if (animatedSlidesInExtract.length === 0) {
    throw new Error('Expected animated slides in CS457_7_3.pptx but found 0');
  }

  // 2. Run generate_deck.py
  console.log('Running generate_deck.py...');
  const genOut = await runProcess(pythonCmd, [generateScript, '--extract', extractJsonPath, '--out', convertedDeckDir]);
  console.log('✓ generate_deck.py completed:', genOut.trim().split('\n').pop());

  // 3. Validate deck manifest
  const deckJsonPath = path.join(convertedDeckDir, 'deck.json');
  const manifest = JSON.parse(await fs.promises.readFile(deckJsonPath, 'utf-8'));
  
  const animatedManifestSlides = manifest.slides.filter(s => s.hasAnimations === true);
  console.log(`✓ Manifest has ${animatedManifestSlides.length} slides flagged with hasAnimations: true`);
  if (animatedManifestSlides.length === 0) {
    throw new Error('Expected manifest slides to have hasAnimations: true');
  }

  // 4. Validate theme.css animations support
  const themeCssPath = path.join(convertedDeckDir, 'assets', 'theme.css');
  const themeCssContent = await fs.promises.readFile(themeCssPath, 'utf-8');
  if (!themeCssContent.includes('.neo-anim-target') || !themeCssContent.includes('.show-all-anims') || !themeCssContent.includes('.neo-anim-wipe-left')) {
    throw new Error('theme.css is missing animation styles, wipe clip-paths, or show-all-anims override');
  }
  console.log('✓ Validated assets/theme.css animation styles and directional wipe clip-paths');

  // 5. Inspect an animated slide HTML
  const sampleAnimSlide = animatedManifestSlides[0];
  const sampleSlidePath = path.join(convertedDeckDir, sampleAnimSlide.path);
  const sampleHtml = await fs.promises.readFile(sampleSlidePath, 'utf-8');

  if (!sampleHtml.includes('neo-anim-target') || !sampleHtml.includes('data-anim-step')) {
    throw new Error(`Sample animated slide (${sampleAnimSlide.path}) missing neo-anim-target or data-anim-step`);
  }
  if (!sampleHtml.includes('NEODECK_NEXT_STEP') || !sampleHtml.includes('goToAnimStep')) {
    throw new Error(`Sample animated slide (${sampleAnimSlide.path}) missing embedded animation step controller script`);
  }
  console.log(`✓ Validated slide HTML (${sampleAnimSlide.path}) contains animated elements and runtime step controller`);

  console.log('\n🎉 ALL PPTX ANIMATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Animation test failed:', err);
  process.exit(1);
});

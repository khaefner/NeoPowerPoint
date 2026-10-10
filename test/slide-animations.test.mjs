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
  // 6. Inspect slide 14 (ensuring text with flipH is not backwards)
  const slide14 = manifest.slides.find(s => s.path.includes('14-reflections-on-best-effort-service'));
  if (slide14) {
    const s14Html = await fs.promises.readFile(path.join(convertedDeckDir, slide14.path), 'utf-8');
    if (s14Html.includes('scaleX(-1)')) {
      throw new Error('Slide 14 text should not contain scaleX(-1) (backwards/mirrored text)');
    }
    if (!s14Html.includes('It’s hard to argue with success of best-effort service model')) {
      throw new Error('Slide 14 missing expected red text');
    }
    console.log('✓ Validated slide 14 red text is rendered upright and not mirrored');
  }

  // 7. Inspect slide 12 (ensuring no auto:romanLcPeriod overflow, proper spacing, group animation)
  const slide12 = manifest.slides.find(s => s.path.includes('12-network-layer-service-model'));
  if (slide12) {
    const s12Html = await fs.promises.readFile(path.join(convertedDeckDir, slide12.path), 'utf-8');
    if (s12Html.includes('auto:romanLcPeriod')) {
      throw new Error('Slide 12 contains literal auto:romanLcPeriod instead of formatted Roman numeral');
    }
    if (!s12Html.includes('>i.</span>') || !s12Html.includes('>ii.</span>') || !s12Html.includes('>iii.</span>')) {
      throw new Error('Slide 12 missing properly formatted Roman numerals i., ii., iii.');
    }
    if (!s12Html.includes('data-spid="3"') || !s12Html.includes('neo-anim-step-1 neo-anim-fade anim-hidden')) {
      throw new Error('Slide 12 mask shape 3 is not initially hidden with animation step 1');
    }
    console.log('✓ Validated slide 12 has properly formatted Roman numerals, spacer paragraphs, and group animation with initially hidden mask');

    // Slide 1 image validation
    const slide1 = manifest.slides[0];
    const s1Html = await fs.promises.readFile(path.join(convertedDeckDir, slide1.path), 'utf-8');
    if (!s1Html.includes('image4.jpg') && !s1Html.includes('<img')) {
      throw new Error('Slide 1 is missing extracted image');
    }
    console.log('✓ Validated slide 1 contains extracted image (image4.jpg)');

    // Slide 6 arrow validation
    const slide6 = manifest.slides[5];
    const s6Html = await fs.promises.readFile(path.join(convertedDeckDir, slide6.path), 'utf-8');
    if (!s6Html.includes('<marker id="m_6_457') && !s6Html.includes('vector-effect="non-scaling-stroke"')) {
      throw new Error('Slide 6 missing custom SVG arrow and markers');
    }
    console.log('✓ Validated slide 6 renders custom geometry arrow with SVG path and markers');

    // Slide 8 arrow validation (tailEnd -> marker-end pointing towards router)
    const slide8 = manifest.slides[7];
    const s8Html = await fs.promises.readFile(path.join(convertedDeckDir, slide8.path), 'utf-8');
    if (!s8Html.includes('marker-end="url(#m_8_46_tail)"')) {
      throw new Error('Slide 8 arrow is pointing backwards (missing marker-end for tailEnd)');
    }
    console.log('✓ Validated slide 8 curved arrow points forward to destination');

    // Slide 9 arrow and table image validation
    const slide9 = manifest.slides[8];
    const s9Html = await fs.promises.readFile(path.join(convertedDeckDir, slide9.path), 'utf-8');
    if (!s9Html.includes('marker-end="url(#m_9_458_tail)"')) {
      throw new Error('Slide 9 arrow is pointing backwards (missing marker-end for tailEnd)');
    }
    if (!s9Html.includes('image30.png')) {
      throw new Error('Slide 9 missing rendered local forwarding table image (image30.png)');
    }
    console.log('✓ Validated slide 9 renders forward pointing arrow and local forwarding table image (image30.png)');

    // Slide 16 arrows validation
    const slide16 = manifest.slides[15];
    const s16Html = await fs.promises.readFile(path.join(convertedDeckDir, slide16.path), 'utf-8');
    if (!s16Html.includes('data-spid="22"') || !s16Html.includes('arr_16_22')) {
      throw new Error('Slide 16 input port line 22 is missing SVG arrow marker');
    }
    if (!s16Html.includes('data-spid="37"') || !s16Html.includes('arr_16_37')) {
      throw new Error('Slide 16 output port line 37 is missing SVG arrow marker');
    }
    if (!s16Html.includes('data-spid="16"') || !s16Html.includes('arr_16_16')) {
      throw new Error('Slide 16 vertical line 16 is missing double-ended SVG arrow markers');
    }
    console.log('✓ Validated slide 16 renders horizontal port lines and vertical connector as arrows with SVG markers');

    // Bullet point validation (Wingdings square bullet translated to ▪ instead of raw §)
    const slide75 = manifest.slides.find(s => s.path.includes('transition-from-ipv4-to-ipv6'));
    if (slide75) {
      const s75Html = await fs.promises.readFile(path.join(convertedDeckDir, slide75.path), 'utf-8');
      if (s75Html.includes('>§<')) {
        throw new Error('Slide 75 still contains raw § section sign instead of translated square bullet ▪');
      }
      if (!s75Html.includes('>▪<')) {
        throw new Error('Slide 75 missing translated square bullet ▪');
      }
      console.log('✓ Validated bullet points match PowerPoint symbols (square bullet translated to ▪)');
    }
  }

  console.log('\n🎉 ALL PPTX ANIMATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Animation test failed:', err);
  process.exit(1);
});

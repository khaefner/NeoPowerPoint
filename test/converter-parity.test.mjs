import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const canonical = path.join(rootDir, 'src', 'converter');
const skill = path.join(rootDir, '.agents', 'skills', 'pptx-to-neopowerpoint', 'scripts');
const files = ['extract_pptx.py', 'generate_deck.py', 'validate_deck.py'];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function runTests() {
  console.log('--- Testing converter parity & fidelity guards ---');

  // 1. The skill scripts must stay byte-for-byte identical to the canonical
  //    implementation so agents and the app never drift apart.
  for (const f of files) {
    const a = await fs.promises.readFile(path.join(canonical, f), 'utf-8');
    const b = await fs.promises.readFile(path.join(skill, f), 'utf-8');
    assert(a === b, `${f} differs between src/converter and the pptx-to-neopowerpoint skill`);
  }
  console.log(`✓ All ${files.length} converter scripts are in sync`);

  // 2. No deck-specific hardcoded heuristics may return.
  const gen = await fs.promises.readFile(path.join(canonical, 'generate_deck.py'), 'utf-8');
  assert(!/slide_num\s*==\s*12/.test(gen), 'generate_deck.py contains a slide-number-specific hack');
  assert(!/spid\s*==\s*['"]9['"]/.test(gen), 'generate_deck.py contains a shape-id-specific hack');
  console.log('✓ No deck-specific hardcoded overrides in generate_deck.py');

  // 3. Core fidelity features must be present (guards against accidental reverts).
  const extract = await fs.promises.readFile(path.join(canonical, 'extract_pptx.py'), 'utf-8');
  for (const [pattern, label] of [
    [/def translate_symbol/, 'symbol/dingbat decoding'],
    [/arcTo/, 'custom geometry arcTo support'],
    [/style_line_of/, 'theme lnRef resolution'],
    [/style_fill_of/, 'theme fillRef resolution'],
    [/def parse_slide_timing\(root, ctx\)/, 'timing extraction with canvas context'],
    [/animMotion/, 'motion path extraction'],
    [/default_text_style/, 'p:defaultTextStyle inheritance'],
  ]) {
    assert(pattern.test(extract), `extract_pptx.py missing ${label}`);
  }
  for (const [pattern, label] of [
    [/def preset_shape_svg/, 'preset geometry SVG renderer'],
    [/def connector_render/, 'direction-aware connector renderer'],
    [/arrow_marker_def/, 'OOXML arrow marker renderer'],
    [/data-anim-timeline/, 'multi-step animation timeline'],
    [/bundled_font_css/, '@font-face metric font bundling'],
    [/__neoFitTextBoxes/, 'runtime text auto-fit guard'],
  ]) {
    assert(pattern.test(gen), `generate_deck.py missing ${label}`);
  }
  console.log('✓ Fidelity feature guards present (arrows, shapes, fonts, spacing, animations)');

  // 4. Bundled metric-compatible fonts must exist for offline decks.
  const fontsDir = path.join(canonical, 'fonts');
  for (const stem of ['Carlito', 'Caladea', 'LiberationSans', 'LiberationSerif', 'LiberationMono']) {
    for (const style of ['Regular', 'Bold', 'Italic', 'BoldItalic']) {
      const fp = path.join(fontsDir, `${stem}-${style}.woff2`);
      assert(fs.existsSync(fp), `missing bundled font ${stem}-${style}.woff2`);
    }
  }
  console.log('✓ Bundled metric-compatible WOFF2 fonts are present');

  // 5. The visual QA harness exists and is wired up.
  const harness = path.join(rootDir, 'scripts', 'visual_compare.py');
  assert(fs.existsSync(harness), 'scripts/visual_compare.py is missing');
  const harnessSrc = await fs.promises.readFile(harness, 'utf-8');
  for (const pattern of [/pdftoppm/, /neo-audit-data/, /image_metrics/, /report\.html/]) {
    assert(pattern.test(harnessSrc), `visual_compare.py missing ${pattern}`);
  }
  console.log('✓ Visual comparison harness (reference, DOM audit, SSIM report) is present');

  console.log('\n🎉 ALL CONVERTER PARITY TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Converter parity test failed:', err.message);
  process.exit(1);
});

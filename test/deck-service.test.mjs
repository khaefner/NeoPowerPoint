import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function runTests() {
  console.log('--- Testing NeoPowerPoint Core Packaging & Deck Logic ---');

  // 1. Verify sample-deck exists and has valid deck.json
  const sampleDeckDir = path.join(rootDir, 'sample-deck');
  const manifestPath = path.join(sampleDeckDir, 'deck.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('sample-deck/deck.json does not exist');
  }
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
  console.log(`✓ Read sample manifest: "${manifest.title}", ${manifest.slides.length} slides.`);

  // 2. Test Export to .neopres
  const testOutputDir = path.join(rootDir, 'test-output');
  await fs.promises.mkdir(testOutputDir, { recursive: true });
  const exportPath = path.join(testOutputDir, 'demo_presentation.neopres');
  if (fs.existsSync(exportPath)) await fs.promises.unlink(exportPath);

  const zip = new AdmZip();
  zip.addLocalFolder(sampleDeckDir);
  await zip.writeZipPromise(exportPath);

  if (!fs.existsSync(exportPath)) {
    throw new Error('Failed to create .neopres archive');
  }
  const stats = await fs.promises.stat(exportPath);
  console.log(`✓ Exported .neopres archive (${stats.size} bytes)`);

  // 3. Test Open .neopres
  const extractDir = path.join(testOutputDir, 'extracted_deck');
  await fs.promises.mkdir(extractDir, { recursive: true });
  const readZip = new AdmZip(exportPath);
  readZip.extractAllTo(extractDir, true);

  const extractedManifestPath = path.join(extractDir, 'deck.json');
  if (!fs.existsSync(extractedManifestPath)) {
    throw new Error('Extracted package missing deck.json');
  }
  const extractedManifest = JSON.parse(await fs.promises.readFile(extractedManifestPath, 'utf-8'));
  if (extractedManifest.title !== manifest.title) {
    throw new Error(`Manifest title mismatch: expected "${manifest.title}", got "${extractedManifest.title}"`);
  }
  if (extractedManifest.slides.length !== manifest.slides.length) {
    throw new Error(`Slide count mismatch`);
  }
  console.log(`✓ Successfully extracted and verified .neopres archive.`);

  // 4. Verify each slide file exists in extracted directory
  for (const slide of extractedManifest.slides) {
    const slideFilePath = path.join(extractDir, slide.path);
    if (!fs.existsSync(slideFilePath)) {
      throw new Error(`Slide file not found: ${slide.path}`);
    }
  }
  console.log(`✓ All ${extractedManifest.slides.length} slide HTML files verified.`);

  // Cleanup test output
  await fs.promises.rm(testOutputDir, { recursive: true, force: true });
  console.log('✓ Cleaned up test output.');
  console.log('--- All tests passed! ---');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

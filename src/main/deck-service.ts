import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import AdmZip from 'adm-zip';
import { app } from 'electron';
import { DeckManifest, SlideMetadata } from '../types/deck';
import { logger } from './logger';
import { resolvePythonCommand, getAugmentedEnv } from './python-resolver';

export class DeckService {
  private activeDeckPath: string | null = null;
  private activeManifest: DeckManifest | null = null;
  private sourcePackagePath: string | null = null;

  getActiveDeckPath(): string | null {
    return this.activeDeckPath;
  }

  getActiveManifest(): DeckManifest | null {
    return this.activeManifest;
  }

  getSourcePackagePath(): string | null {
    return this.sourcePackagePath;
  }

  /**
   * Opens a presentation folder. If no deck.json exists, scans for HTML files and creates one.
   */
  async openFolder(folderPath: string): Promise<{ deckPath: string; manifest: DeckManifest }> {
    logger.info('DeckService', `Opening presentation folder: ${folderPath}`);
    const manifestPath = path.join(folderPath, 'deck.json');
    let manifest: DeckManifest;

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(raw) as DeckManifest;
      } catch (err: any) {
        logger.error('DeckService', `Failed to parse deck.json in ${folderPath}`, err);
        throw new Error(`Failed to parse deck.json: ${err.message}`);
      }
    } else {
      // Auto-discover HTML slides
      logger.info('DeckService', `No deck.json found in ${folderPath}, auto-discovering HTML slides...`);
      manifest = await this.autoDiscoverDeck(folderPath);
      await this.saveManifest(folderPath, manifest);
    }

    this.validateAndNormalizeManifest(folderPath, manifest);
    this.activeDeckPath = folderPath;
    this.activeManifest = manifest;
    this.sourcePackagePath = null;

    logger.info('DeckService', `Loaded deck "${manifest.title}" with ${manifest.slides.length} slides.`);
    return { deckPath: folderPath, manifest };
  }

  /**
   * Opens a .neopres or .zip file by extracting it into a temporary session cache.
   */
  async openPackage(packageFilePath: string): Promise<{ deckPath: string; manifest: DeckManifest }> {
    logger.info('DeckService', `Opening presentation package: ${packageFilePath}`);
    if (!fs.existsSync(packageFilePath)) {
      const msg = `Package file does not exist: ${packageFilePath}`;
      logger.error('DeckService', msg);
      throw new Error(msg);
    }

    const zip = new AdmZip(packageFilePath);
    const sanitizedName = path.basename(packageFilePath, path.extname(packageFilePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempRoot = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir();
    const extractDir = path.join(tempRoot, 'neopowerpoint', `${sanitizedName}_${Date.now()}`);

    await fs.promises.mkdir(extractDir, { recursive: true });
    zip.extractAllTo(extractDir, true);

    const result = await this.openFolder(extractDir);
    this.sourcePackagePath = packageFilePath;
    return result;
  }

  /**
   * Exports the active or specified deck folder to a .neopres file.
   */
  async exportPackage(folderPath: string, outputFilePath: string): Promise<string> {
    logger.info('DeckService', `Exporting package from ${folderPath} to ${outputFilePath}`);
    const zip = new AdmZip();
    zip.addLocalFolder(folderPath);
    await zip.writeZipPromise(outputFilePath);
    return outputFilePath;
  }

  /**
   * Locates converter python scripts, handling unpacked ASAR or copying from ASAR to temp directory.
   */
  private async resolveConverterDir(): Promise<string> {
    const appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
    const candidates = [
      path.join(__dirname, '../converter'),
      path.join(__dirname, '../../src/converter'),
      path.join(appPath, 'dist/converter'),
      path.join(appPath, 'src/converter'),
      path.join(appPath, '.agents/skills/pptx-to-neopowerpoint/scripts')
    ];

    for (const cand of candidates) {
      if (fs.existsSync(path.join(cand, 'extract_pptx.py')) && fs.existsSync(path.join(cand, 'generate_deck.py'))) {
        // If path is inside an ASAR archive, external Python process cannot read from within the archive
        if (cand.includes('.asar')) {
          const unpackedCand = cand.replace(/\.asar([/\\])/, '.asar.unpacked$1');
          if (
            fs.existsSync(path.join(unpackedCand, 'extract_pptx.py')) &&
            fs.existsSync(path.join(unpackedCand, 'generate_deck.py'))
          ) {
            logger.info('DeckService', `Using unpacked converter scripts at: ${unpackedCand}`);
            return unpackedCand;
          }

          // If unpacked files not on disk, extract scripts from ASAR into a temporary directory
          const tempRoot = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir();
          const tempScriptsDir = path.join(tempRoot, 'neopowerpoint', 'converter_scripts');
          await fs.promises.mkdir(tempScriptsDir, { recursive: true });

          for (const scriptName of ['extract_pptx.py', 'generate_deck.py']) {
            const srcScript = path.join(cand, scriptName);
            const destScript = path.join(tempScriptsDir, scriptName);
            const content = await fs.promises.readFile(srcScript);
            await fs.promises.writeFile(destScript, content, { mode: 0o755 });
          }
          logger.info('DeckService', `Extracted converter scripts from ASAR to temporary dir: ${tempScriptsDir}`);
          return tempScriptsDir;
        }

        logger.info('DeckService', `Found converter scripts at: ${cand}`);
        return cand;
      }
    }

    const notFoundMsg = `PPTX converter scripts not found in application bundle.\nChecked locations:\n${candidates.map((c) => `  - ${c}`).join('\n')}`;
    logger.error('DeckService', notFoundMsg);
    throw new Error(notFoundMsg);
  }

  /**
   * Imports and converts a PowerPoint (.pptx) file into a live NeoPowerPoint presentation deck.
   */
  async importPptx(pptxFilePath: string, outputDir?: string): Promise<{ deckPath: string; manifest: DeckManifest }> {
    logger.info('DeckService', `Starting PowerPoint import for: ${pptxFilePath}`);
    if (!fs.existsSync(pptxFilePath)) {
      const msg = `PowerPoint file does not exist: ${pptxFilePath}`;
      logger.error('DeckService', msg);
      throw new Error(msg);
    }

    const sanitizedBase = path.basename(pptxFilePath, path.extname(pptxFilePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetDeckDir = outputDir || path.join(path.dirname(pptxFilePath), `${sanitizedBase}_NeoDeck`);
    const tempRoot = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir();
    const extractTempDir = path.join(tempRoot, 'neopowerpoint', `pptx_extract_${sanitizedBase}_${Date.now()}`);

    logger.info('DeckService', `Creating directories: extractTemp=${extractTempDir}, targetDeckDir=${targetDeckDir}`);
    await fs.promises.mkdir(extractTempDir, { recursive: true });
    await fs.promises.mkdir(targetDeckDir, { recursive: true });

    // 1. Resolve Python 3 executable
    let pythonCmd: string;
    try {
      const py = resolvePythonCommand();
      pythonCmd = py.command;
      logger.info('DeckService', `Resolved Python executable: ${pythonCmd} (${py.version})`);
    } catch (pyErr: any) {
      logger.error('DeckService', 'Python 3 resolution failed', pyErr);
      throw pyErr;
    }

    // 2. Locate converter scripts
    const converterDir = await this.resolveConverterDir();
    const extractScript = path.join(converterDir, 'extract_pptx.py');
    const generateScript = path.join(converterDir, 'generate_deck.py');

    // 3. Run extract_pptx.py
    logger.info('DeckService', `Step 1: Extracting raw PowerPoint presentation data...`);
    await this.runProcess(pythonCmd, [extractScript, pptxFilePath, '--out', extractTempDir]);

    const extractJsonPath = path.join(extractTempDir, 'extract.json');
    if (!fs.existsSync(extractJsonPath)) {
      const msg = `Failed to extract presentation data: ${extractJsonPath} was not generated`;
      logger.error('DeckService', msg);
      throw new Error(msg);
    }

    // 4. Run generate_deck.py
    logger.info('DeckService', `Step 2: Generating HTML slides and theme.css...`);
    await this.runProcess(pythonCmd, [generateScript, '--extract', extractJsonPath, '--out', targetDeckDir]);

    // Clean up temporary extract folder
    try {
      await fs.promises.rm(extractTempDir, { recursive: true, force: true });
      logger.debug('DeckService', `Cleaned up extract temporary directory: ${extractTempDir}`);
    } catch (_) {}

    // 5. Open the converted deck
    logger.info('DeckService', `Step 3: Opening newly generated deck at: ${targetDeckDir}`);
    return this.openFolder(targetDeckDir);
  }

  private runProcess(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    logger.info('DeckService', `Running: ${cmd} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env || getAugmentedEnv()
      });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        logger.debug('DeckService:stdout', text.trim());
      });

      proc.stderr?.on('data', (d) => {
        const text = d.toString();
        stderr += text;
        logger.warn('DeckService:stderr', text.trim());
      });

      proc.on('error', (err) => {
        logger.error('DeckService', `Failed to execute ${cmd}: ${err.message}`, err);
        reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          logger.info('DeckService', `Command completed successfully: ${cmd}`);
          resolve(stdout);
        } else {
          const errMsg = `Process ${cmd} exited with code ${code}:\n${stderr || stdout}`;
          logger.error('DeckService', errMsg);
          reject(new Error(errMsg));
        }
      });
    });
  }

  /**
   * Saves updated HTML content for a specific slide.
   */
  async saveSlideHtml(deckPath: string, slideRelPath: string, htmlContent: string): Promise<boolean> {
    const fullPath = path.resolve(deckPath, slideRelPath);
    if (!fullPath.startsWith(path.resolve(deckPath))) {
      throw new Error('Directory traversal attempt detected');
    }
    await fs.promises.writeFile(fullPath, htmlContent, 'utf-8');
    return true;
  }

  /**
   * Saves updated manifest (e.g. reordered slides, modified notes, settings).
   */
  async saveManifest(folderPath: string, manifest: DeckManifest): Promise<void> {
    const manifestPath = path.join(folderPath, 'deck.json');
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    if (this.activeDeckPath === folderPath) {
      this.activeManifest = manifest;
    }
  }

  /**
   * Creates a new presentation folder scaffolded with interactive sample slides.
   */
  async createNewDeck(targetFolder: string, title: string = 'New Presentation'): Promise<{ deckPath: string; manifest: DeckManifest }> {
    await fs.promises.mkdir(targetFolder, { recursive: true });
    const slidesDir = path.join(targetFolder, 'slides');
    const assetsDir = path.join(targetFolder, 'assets');
    await fs.promises.mkdir(slidesDir, { recursive: true });
    await fs.promises.mkdir(assetsDir, { recursive: true });

    // Slide 1: Welcome
    const slide1Dir = path.join(slidesDir, '01-welcome');
    await fs.promises.mkdir(slide1Dir, { recursive: true });
    const slide1Html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome to NeoPowerPoint</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      background: radial-gradient(circle at center, #1e293b 0%, #0f172a 100%);
      color: #f8fafc;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    h1 {
      font-size: 4rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      font-size: 1.5rem;
      color: #94a3b8;
      max-width: 800px;
      text-align: center;
      line-height: 1.6;
    }
    .badge {
      margin-top: 2rem;
      padding: 0.6rem 1.4rem;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 9999px;
      color: #38bdf8;
      font-weight: 500;
      font-size: 1.1rem;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>An interactive, cross-platform presentation powered by HTML, CSS, and full JavaScript execution.</p>
  <div class="badge" id="counter">Click anywhere or use arrow keys</div>

  <script>
    let clicks = 0;
    const badge = document.getElementById('counter');
    window.addEventListener('pointerdown', () => {
      clicks++;
      badge.textContent = 'Interactive clicks: ' + clicks;
    });
  </script>
</body>
</html>`;
    await fs.promises.writeFile(path.join(slide1Dir, 'index.html'), slide1Html, 'utf-8');

    // Slide 2: Interactive Particles / Canvas
    const slide2Dir = path.join(slidesDir, '02-interactive-canvas');
    await fs.promises.mkdir(slide2Dir, { recursive: true });
    const slide2Html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Live JavaScript Canvas</title>
  <style>
    body {
      margin: 0;
      background: #020617;
      color: #fff;
      font-family: system-ui, sans-serif;
      overflow: hidden;
    }
    canvas {
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
    }
    .overlay {
      position: absolute;
      top: 40px;
      left: 60px;
      pointer-events: none;
      z-index: 10;
    }
    h2 { font-size: 3rem; margin: 0 0 10px 0; color: #38bdf8; }
    p { font-size: 1.3rem; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="overlay">
    <h2>Interactive Particle Physics</h2>
    <p>Move your cursor around to interact with live particles.</p>
  </div>
  <canvas id="c"></canvas>
  <script>
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    });

    const particles = [];
    const count = 100;
    let mouse = { x: w / 2, y: h / 2, active: false };

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        radius: Math.random() * 3 + 2,
        color: ['#38bdf8', '#818cf8', '#c084fc', '#f472b6'][Math.floor(Math.random() * 4)]
      });
    }

    window.addEventListener('mousemove', (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    });

    function loop() {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.2)';
      ctx.fillRect(0, 0, w, h);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        if (mouse.active) {
          const dx = mouse.x - p.x;
          const dy = mouse.y - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            p.x += dx * 0.02;
            p.y += dy * 0.02;
          }
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      requestAnimationFrame(loop);
    }
    loop();
  </script>
</body>
</html>`;
    await fs.promises.writeFile(path.join(slide2Dir, 'index.html'), slide2Html, 'utf-8');

    const manifest: DeckManifest = {
      version: '1.0.0',
      title,
      aspectRatio: '16:9',
      customWidth: 1920,
      customHeight: 1080,
      theme: 'dark',
      defaultTransition: 'fade',
      slides: [
        {
          id: 'slide-1',
          title: 'Welcome',
          path: 'slides/01-welcome/index.html',
          notes: 'Welcome the audience and explain that slides execute real HTML & JavaScript.',
          durationSec: 60,
          transition: 'fade'
        },
        {
          id: 'slide-2',
          title: 'Interactive Canvas',
          path: 'slides/02-interactive-canvas/index.html',
          notes: 'Move your mouse to demonstrate live canvas animation and physics.',
          durationSec: 90,
          transition: 'fade'
        }
      ]
    };

    await this.saveManifest(targetFolder, manifest);
    return this.openFolder(targetFolder);
  }

  /**
   * Adds a new slide to an existing presentation.
   * If insertAfterIndex is provided and >= 0, inserts right after that slide; otherwise appends.
   */
  async addNewSlide(folderPath: string, title: string, insertAfterIndex: number = -1): Promise<DeckManifest> {
    const manifestPath = path.join(folderPath, 'deck.json');
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as DeckManifest;

    const folderSlug = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'slide'}`;
    const slideDir = path.join(folderPath, 'slides', folderSlug);
    await fs.promises.mkdir(slideDir, { recursive: true });

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      background: #0f172a;
      color: #f8fafc;
      font-family: system-ui, sans-serif;
    }
    h1 { font-size: 3.5rem; margin-bottom: 1rem; color: #38bdf8; }
    p { font-size: 1.5rem; color: #94a3b8; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>Edit this slide at <code>slides/${folderSlug}/index.html</code></p>
</body>
</html>`;

    await fs.promises.writeFile(path.join(slideDir, 'index.html'), htmlContent, 'utf-8');

    const newSlide: SlideMetadata = {
      id: `slide-${Date.now()}`,
      title,
      path: path.posix.join('slides', folderSlug, 'index.html'),
      notes: '',
      transition: 'fade'
    };

    if (insertAfterIndex >= 0 && insertAfterIndex < manifest.slides.length) {
      manifest.slides.splice(insertAfterIndex + 1, 0, newSlide);
    } else {
      manifest.slides.push(newSlide);
    }
    await this.saveManifest(folderPath, manifest);
    return manifest;
  }

  /**
   * Inserts a slide with custom HTML content (e.g. from AI generation)
   */
  async addCustomSlide(folderPath: string, title: string, htmlContent: string, insertAfterIndex: number = -1): Promise<DeckManifest> {
    const manifestPath = path.join(folderPath, 'deck.json');
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as DeckManifest;

    const folderSlug = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'slide'}`;
    const slideDir = path.join(folderPath, 'slides', folderSlug);
    await fs.promises.mkdir(slideDir, { recursive: true });

    await fs.promises.writeFile(path.join(slideDir, 'index.html'), htmlContent, 'utf-8');

    const newSlide: SlideMetadata = {
      id: `slide-${Date.now()}`,
      title,
      path: path.posix.join('slides', folderSlug, 'index.html'),
      notes: '',
      transition: 'fade'
    };

    if (insertAfterIndex >= 0 && insertAfterIndex < manifest.slides.length) {
      manifest.slides.splice(insertAfterIndex + 1, 0, newSlide);
    } else {
      manifest.slides.push(newSlide);
    }
    await this.saveManifest(folderPath, manifest);
    return manifest;
  }

  /**
   * Duplicates an existing slide by creating a physical copy of its slide files and adding it to the manifest.
   */
  async duplicateSlide(folderPath: string, slideIndex: number): Promise<DeckManifest> {
    const manifestPath = path.join(folderPath, 'deck.json');
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as DeckManifest;

    if (slideIndex < 0 || slideIndex >= manifest.slides.length) {
      throw new Error(`Slide index out of range: ${slideIndex}`);
    }

    const sourceSlide = manifest.slides[slideIndex];
    const sourceHtmlPath = path.resolve(folderPath, sourceSlide.path);

    let htmlContent = '';
    if (fs.existsSync(sourceHtmlPath)) {
      htmlContent = await fs.promises.readFile(sourceHtmlPath, 'utf-8');
    }

    const title = `${sourceSlide.title || 'Slide'} (Copy)`;
    const folderSlug = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'slide-copy'}`;
    const slideDir = path.join(folderPath, 'slides', folderSlug);
    await fs.promises.mkdir(slideDir, { recursive: true });

    await fs.promises.writeFile(path.join(slideDir, 'index.html'), htmlContent, 'utf-8');

    const newSlide: SlideMetadata = {
      ...sourceSlide,
      id: `slide-${Date.now()}`,
      title,
      path: path.posix.join('slides', folderSlug, 'index.html'),
    };

    manifest.slides.splice(slideIndex + 1, 0, newSlide);
    await this.saveManifest(folderPath, manifest);
    return manifest;
  }

  /**
   * Deletes a slide from the manifest.
   */
  async deleteSlide(folderPath: string, slideIndex: number): Promise<DeckManifest> {
    const manifestPath = path.join(folderPath, 'deck.json');
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as DeckManifest;

    if (slideIndex < 0 || slideIndex >= manifest.slides.length) {
      throw new Error(`Slide index out of range: ${slideIndex}`);
    }

    manifest.slides.splice(slideIndex, 1);
    await this.saveManifest(folderPath, manifest);
    return manifest;
  }

  /**
   * Adds an interactive embedded web page slide with scaling and scroll toggle.
   * If insertAfterIndex is provided and >= 0, inserts right after that slide; otherwise appends.
   */
  async addWebSlide(folderPath: string, title: string, url: string, insertAfterIndex: number = -1): Promise<DeckManifest> {
    const manifestPath = path.join(folderPath, 'deck.json');
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as DeckManifest;

    const folderSlug = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'web-slide'}`;
    const slideDir = path.join(folderPath, 'slides', folderSlug);
    await fs.promises.mkdir(slideDir, { recursive: true });

    const safeUrl = (url || '').trim() || 'https://gaia.cs.umass.edu/kurose_ross/interactive/end-end-throughput-simple.php';

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="../../assets/theme.css">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #090d16;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .web-slide-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      position: relative;
      background: #090d16;
    }
    .web-slide-header {
      height: 48px;
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: rgba(15, 23, 42, 0.95);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(8px);
      z-index: 10;
    }
    .web-slide-title-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      overflow: hidden;
    }
    .web-slide-title {
      font-size: 1.05rem;
      font-weight: 600;
      color: #38bdf8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .web-slide-link {
      font-size: 0.8rem;
      color: #94a3b8;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: all 0.2s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 400px;
    }
    .web-slide-link:hover {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.3);
    }
    .web-slide-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .web-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid rgba(56, 189, 248, 0.4);
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }
    .web-toggle-btn:hover {
      background: rgba(56, 189, 248, 0.28);
      border-color: #38bdf8;
      color: #fff;
    }
    .web-reload-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: #94a3b8;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .web-reload-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.12);
    }
    .web-viewport {
      flex: 1;
      width: 100%;
      position: relative;
      background: #ffffff;
      overflow: hidden;
    }
    /* Mode 1: Fit mode (scaled to fit viewport without cropping) */
    .mode-fit .web-viewport {
      overflow: hidden;
    }
    .mode-fit #web-frame-scaler {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      /* default virtual viewport for desktop sites */
      width: 1280px;
      height: 800px;
    }
    .mode-fit #web-frame {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      background: #ffffff;
    }
    /* Mode 2: Scroll mode (natural dimensions, scrollbars active) */
    .mode-scroll .web-viewport {
      overflow: auto;
      -webkit-overflow-scrolling: touch;
    }
    .mode-scroll #web-frame-scaler {
      position: relative;
      width: 100%;
      height: 100%;
      transform: none !important;
    }
    .mode-scroll #web-frame {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      background: #ffffff;
    }
  </style>
</head>
<body class="mode-fit">
  <div class="web-slide-container" id="web-container">
    <header class="web-slide-header">
      <div class="web-slide-title-wrap">
        <h2 class="web-slide-title">${title}</h2>
        <a class="web-slide-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="Open in external browser window">
          🔗 ${safeUrl}
        </a>
      </div>
      <div class="web-slide-actions">
        <button id="btn-toggle-mode" class="web-toggle-btn" title="Toggle between Fit to Slide and Scrollable Native View">
          <span id="mode-icon">🔍</span>
          <span id="mode-label">Mode: Fit to Slide</span>
        </button>
        <button id="btn-refresh-frame" class="web-reload-btn" title="Reload Web Page">🔄</button>
      </div>
    </header>

    <div class="web-viewport" id="web-viewport">
      <div id="web-frame-scaler">
        <iframe id="web-frame" src="${safeUrl}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
    </div>
  </div>

  <script>
    (function() {
      const body = document.body;
      const viewport = document.getElementById('web-viewport');
      const scaler = document.getElementById('web-frame-scaler');
      const frame = document.getElementById('web-frame');
      const toggleBtn = document.getElementById('btn-toggle-mode');
      const reloadBtn = document.getElementById('btn-refresh-frame');
      const modeLabel = document.getElementById('mode-label');
      const modeIcon = document.getElementById('mode-icon');

      let isFitMode = true;
      const virtualWidth = 1280;
      const virtualHeight = 800;

      function updateScaling() {
        if (!isFitMode) {
          scaler.style.transform = 'none';
          scaler.style.width = '100%';
          scaler.style.height = '100%';
          return;
        }

        const availW = viewport.clientWidth;
        const availH = viewport.clientHeight;
        if (availW <= 0 || availH <= 0) return;

        const scaleX = availW / virtualWidth;
        const scaleY = availH / virtualHeight;
        const scale = Math.min(scaleX, scaleY);

        scaler.style.width = virtualWidth + 'px';
        scaler.style.height = virtualHeight + 'px';
        scaler.style.transform = 'scale(' + scale + ')';

        // Center horizontally and vertically within the available slide viewport
        const offsetX = Math.max(0, (availW - virtualWidth * scale) / 2);
        const offsetY = Math.max(0, (availH - virtualHeight * scale) / 2);
        scaler.style.left = offsetX + 'px';
        scaler.style.top = offsetY + 'px';
      }

      function setFitMode(fit) {
        isFitMode = fit;
        if (isFitMode) {
          body.classList.remove('mode-scroll');
          body.classList.add('mode-fit');
          modeIcon.textContent = '🔍';
          modeLabel.textContent = 'Mode: Fit to Slide';
          toggleBtn.title = 'Current: Scaled to fit slide. Click to switch to Scrollable view.';
        } else {
          body.classList.remove('mode-fit');
          body.classList.add('mode-scroll');
          scaler.style.left = '0px';
          scaler.style.top = '0px';
          modeIcon.textContent = '📜';
          modeLabel.textContent = 'Mode: Scrollable';
          toggleBtn.title = 'Current: Full scrollable page. Click to switch to Fit to Slide.';
        }
        updateScaling();
      }

      toggleBtn.addEventListener('click', function() {
        setFitMode(!isFitMode);
      });

      reloadBtn.addEventListener('click', function() {
        if (frame) {
          frame.src = frame.src;
        }
      });

      window.setFitMode = setFitMode;
      window.isFitMode = function() { return isFitMode; };
      window.updateScaling = updateScaling;

      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('view') === 'tablet' && frame && (frame.src.startsWith('http://') || frame.src.startsWith('https://'))) {
        frame.src = '/api/proxy?url=' + encodeURIComponent(frame.src);
      }

      window.addEventListener('resize', updateScaling);
      window.addEventListener('DOMContentLoaded', updateScaling);
      // Run immediately
      updateScaling();
    })();
  </script>
</body>
</html>`;

    await fs.promises.writeFile(path.join(slideDir, 'index.html'), htmlContent, 'utf-8');

    const newSlide: SlideMetadata = {
      id: `slide-${Date.now()}`,
      title,
      path: path.posix.join('slides', folderSlug, 'index.html'),
      notes: `Embedded interactive webpage: ${safeUrl}`,
      transition: 'fade'
    };

    if (insertAfterIndex >= 0 && insertAfterIndex < manifest.slides.length) {
      manifest.slides.splice(insertAfterIndex + 1, 0, newSlide);
    } else {
      manifest.slides.push(newSlide);
    }
    await this.saveManifest(folderPath, manifest);
    return manifest;
  }

  private async autoDiscoverDeck(folderPath: string): Promise<DeckManifest> {
    const slides: SlideMetadata[] = [];
    const findHtmlFiles = async (dir: string, prefix = '') => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = path.join(prefix, entry.name);
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Check for index.html inside
          const indexHtml = path.join(full, 'index.html');
          if (fs.existsSync(indexHtml)) {
            const title = entry.name.replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' ') || entry.name;
            slides.push({
              id: `slide-${slides.length + 1}`,
              title: title.charAt(0).toUpperCase() + title.slice(1),
              path: path.posix.join(rel, 'index.html'),
              notes: ''
            });
          } else {
            await findHtmlFiles(full, rel);
          }
        } else if (entry.isFile() && entry.name.endsWith('.html') && entry.name !== 'index.html') {
          const title = entry.name.replace(/\.html$/, '').replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' ');
          slides.push({
            id: `slide-${slides.length + 1}`,
            title: title.charAt(0).toUpperCase() + title.slice(1),
            path: rel.split(path.sep).join('/'),
            notes: ''
          });
        }
      }
    };

    await findHtmlFiles(folderPath);

    return {
      version: '1.0.0',
      title: path.basename(folderPath),
      aspectRatio: '16:9',
      customWidth: 1920,
      customHeight: 1080,
      theme: 'dark',
      slides
    };
  }

  private validateAndNormalizeManifest(folderPath: string, manifest: DeckManifest): void {
    if (!manifest.title) {
      manifest.title = path.basename(folderPath);
    }
    if (!manifest.aspectRatio) {
      manifest.aspectRatio = '16:9';
    }
    if (!manifest.slides || !Array.isArray(manifest.slides)) {
      manifest.slides = [];
    }

    manifest.slides.forEach((slide, index) => {
      if (!slide.id) {
        slide.id = `slide-${index + 1}`;
      }
      if (!slide.title) {
        slide.title = `Slide ${index + 1}`;
      }
      // Normalize slashes to posix
      if (slide.path) {
        slide.path = slide.path.replace(/\\/g, '/');
      }
    });
  }
}

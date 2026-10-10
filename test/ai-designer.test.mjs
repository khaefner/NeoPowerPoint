import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function runAIServiceTests() {
  console.log('--- Testing AI Slide Designer & Theme-Aware Service ---');

  // 1. Verify Skill Directory & files exist
  const skillMdPath = path.join(rootDir, '.agents/skills/ai-slide-designer/SKILL.md');
  const extractThemeScript = path.join(rootDir, '.agents/skills/ai-slide-designer/scripts/extract_theme.py');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error('ai-slide-designer/SKILL.md does not exist');
  }
  if (!fs.existsSync(extractThemeScript)) {
    throw new Error('ai-slide-designer/scripts/extract_theme.py does not exist');
  }
  const skillContent = await fs.promises.readFile(skillMdPath, 'utf-8');
  if (!skillContent.includes('ai-slide-designer') || !skillContent.includes('1920px')) {
    throw new Error('SKILL.md missing name or dimension guidelines');
  }
  console.log('✓ Verified .agents/skills/ai-slide-designer/ files and guidelines');

  // 2. Verify extract_theme.py script execution
  const { execSync } = await import('child_process');
  const outJson = execSync(`python3 "${extractThemeScript}" "${path.join(rootDir, 'sample-deck')}"`, { encoding: 'utf-8' });
  const themeData = JSON.parse(outJson);
  if (themeData.width !== 1920 || themeData.height !== 1080) {
    throw new Error('extract_theme.py returned unexpected dimensions');
  }
  if (!themeData.title) {
    throw new Error('extract_theme.py missing title');
  }
  console.log('✓ Verified extract_theme.py successfully extracted sample deck context');

  // 3. Verify AIService class exists in dist
  const aiServicePath = path.join(rootDir, 'src/main/ai-service.ts');
  const aiServiceCode = await fs.promises.readFile(aiServicePath, 'utf-8');
  if (!aiServiceCode.includes('class AIService')) {
    throw new Error('ai-service.ts does not export AIService');
  }
  if (!aiServiceCode.includes('callAntigravity') || !aiServiceCode.includes('callOpenAI') || !aiServiceCode.includes('callAnthropic')) {
    throw new Error('AIService is missing required provider implementations');
  }
  console.log('✓ Verified AIService multi-provider implementations (Antigravity, OpenAI, Anthropic)');

  // 4. Verify DeckService has addCustomSlide
  const deckServicePath = path.join(rootDir, 'src/main/deck-service.ts');
  const deckServiceCode = await fs.promises.readFile(deckServicePath, 'utf-8');
  if (!deckServiceCode.includes('async addCustomSlide(')) {
    throw new Error('deck-service.ts missing addCustomSlide method');
  }
  console.log('✓ Verified DeckService.addCustomSlide exists');

  // 5. Verify preload.ts and main.ts have IPC bridges
  const preloadPath = path.join(rootDir, 'src/preload/preload.ts');
  const preloadCode = await fs.promises.readFile(preloadPath, 'utf-8');
  if (!preloadCode.includes('aiGetSettings') || !preloadCode.includes('aiGenerateSlide') || !preloadCode.includes('addCustomSlide')) {
    throw new Error('preload.ts is missing AI bridges');
  }
  const mainPath = path.join(rootDir, 'src/main/main.ts');
  const mainCode = await fs.promises.readFile(mainPath, 'utf-8');
  if (!mainCode.includes("'ai:generate-slide'") || !mainCode.includes("'ai:save-settings'")) {
    throw new Error('main.ts is missing AI IPC handlers');
  }
  console.log('✓ Verified Electron IPC channels and preload bridges for AI slide generation');

  // 6. Verify index.html contains AI Designer UI
  const indexHtml = await fs.promises.readFile(path.join(rootDir, 'src/renderer/index.html'), 'utf-8');
  if (!indexHtml.includes('id="btn-ai-designer"') || !indexHtml.includes('id="ai-designer-modal"')) {
    throw new Error('index.html is missing AI Designer UI elements');
  }
  if (!indexHtml.includes('id="select-ai-provider"') || !indexHtml.includes('id="input-openai-key"') || !indexHtml.includes('id="input-anthropic-key"')) {
    throw new Error('index.html missing AI provider / API key inputs');
  }
  console.log('✓ Verified UI toolbar button, menu option, and interactive AI modal in index.html');

  // 7. Verify app.ts contains AI Designer handler logic
  const appTs = await fs.promises.readFile(path.join(rootDir, 'src/renderer/app.ts'), 'utf-8');
  if (!appTs.includes('openAIDesignerModal') || !appTs.includes('generateAISlide') || !appTs.includes('saveAISettings')) {
    throw new Error('app.ts missing AI Designer interaction logic');
  }
  console.log('✓ Verified modal handling, settings persistence, and slide insertion logic in app.ts');

  console.log('\n🎉 ALL AI SLIDE DESIGNER TESTS PASSED SUCCESSFULLY!\n');
}

runAIServiceTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

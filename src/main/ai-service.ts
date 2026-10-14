import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { spawn } from 'child_process';
import { AISettings, GenerateSlideRequest, GenerateSlideResponse } from '../types/ai';
import { DeckManifest, SlideMetadata } from '../types/deck';

export class AIService {
  private configPath: string;

  constructor() {
    const userData = app.getPath('userData');
    this.configPath = path.join(userData, 'ai-settings.json');
  }

  async getSettings(): Promise<AISettings> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = await fs.promises.readFile(this.configPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('[AIService] Failed to load ai-settings.json:', e);
    }
    return {
      provider: 'antigravity',
      antigravityModel: 'Gemini 3.8 Flash (Medium)',
      openaiModel: 'gpt-4o',
      anthropicModel: 'claude-3-5-sonnet-20241022'
    };
  }

  async saveSettings(settings: AISettings): Promise<boolean> {
    try {
      await fs.promises.writeFile(this.configPath, JSON.stringify(settings, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[AIService] Failed to save ai-settings.json:', e);
      return false;
    }
  }

  /**
   * Reads theme context (dimensions, CSS variables, typography, sample slide HTML)
   */
  async extractThemeContext(deckPath: string, currentSlideRelPath?: string): Promise<{
    title: string;
    width: number;
    height: number;
    themeMode: string;
    cssVariables: Record<string, string>;
    sampleHtml: string;
  }> {
    let width = 1920;
    let height = 1080;
    let themeMode = 'dark';
    let title = 'Presentation';

    const manifestPath = path.join(deckPath, 'deck.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as DeckManifest;
        width = manifest.customWidth || 1920;
        height = manifest.customHeight || 1080;
        themeMode = manifest.theme || 'dark';
        title = manifest.title || title;
      } catch {}
    }

    const cssVars: Record<string, string> = {};
    const themeCssPath = path.join(deckPath, 'assets', 'theme.css');
    if (fs.existsSync(themeCssPath)) {
      try {
        const cssContent = await fs.promises.readFile(themeCssPath, 'utf-8');
        const varMatches = cssContent.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g);
        for (const m of varMatches) {
          cssVars[m[1]] = m[2].trim();
        }
      } catch {}
    }

    let sampleHtml = '';
    const sampleSlidePath = currentSlideRelPath ? path.join(deckPath, currentSlideRelPath) : '';
    if (sampleSlidePath && fs.existsSync(sampleSlidePath)) {
      try {
        sampleHtml = (await fs.promises.readFile(sampleSlidePath, 'utf-8')).slice(0, 3500);
      } catch {}
    }

    return {
      title,
      width,
      height,
      themeMode,
      cssVariables: cssVars,
      sampleHtml
    };
  }

  /**
   * Builds the prompt instructing the LLM to design an on-theme HTML slide.
   */
  buildSystemPrompt(theme: {
    title: string;
    width: number;
    height: number;
    themeMode: string;
    cssVariables: Record<string, string>;
    sampleHtml: string;
  }): string {
    return `You are an elite presentation designer and UI architect for NeoPowerPoint.
Your task is to design a high-impact, presentation-grade HTML slide matching the presentation theme.

DECK SPECIFICATIONS:
- Presentation Title: "${theme.title}"
- Canvas Dimensions: Exactly ${theme.width}px width by ${theme.height}px height.
- Theme Mode: ${theme.themeMode}
- CSS Variables in assets/theme.css: ${JSON.stringify(theme.cssVariables)}
${theme.sampleHtml ? `- Reference Sample Slide Structure:\n\`\`\`html\n${theme.sampleHtml}\n\`\`\`` : ''}

CRITICAL FORMATTING & DESIGN RULES:
1. Return ONLY the full HTML code inside standard \`\`\`html ... \`\`\` code fence. No explanations before or after.
2. Must start with <!DOCTYPE html> and reference <link rel="stylesheet" href="../../assets/theme.css">.
3. Every slide must be designed strictly for ${theme.width}px x ${theme.height}px:
   - Use body { width: ${theme.width}px; height: ${theme.height}px; margin: 0; overflow: hidden; position: relative; }
   - Do NOT use \`vw\` or \`vh\` units.
4. Typography & Visual Hierarchy:
   - Clear slide header: kicker/category tag (e.g. 14-16px uppercase), strong heading (e.g. 48-64px), and concise sub-headline (e.g. 24-28px).
   - Use high-contrast, modern layout components: 2/3 column feature cards, stat callouts, comparisons, or workflow blocks with subtle borders and glowing/accent touches.
   - Use clean, elegant gradients, pill badges, and SVG icons where appropriate.
5. All CSS styles must be self-contained in a <style> block in the <head>.
6. If appropriate for stepwise reveals, you may use animated elements with classes:
   class="neo-anim-target neo-anim-step-1 neo-anim-fade anim-hidden" data-anim-step="1"
`;
  }

  /**
   * Generates a slide using the configured AI provider.
   */
  async generateSlide(req: GenerateSlideRequest): Promise<GenerateSlideResponse> {
    const settings = await this.getSettings();
    const theme = await this.extractThemeContext(req.deckPath, req.currentSlideRelPath);
    const systemPrompt = this.buildSystemPrompt(theme);

    const userMessage = `Slide Request:
Topic & Content Instructions: "${req.userPrompt}"
${req.slideTitle ? `Desired Slide Title: "${req.slideTitle}"` : ''}
Mode: ${req.mode === 'restyle' ? 'Restyle/Redesign the existing slide content while keeping its core message' : 'Create a fresh, visually stunning new slide'}

Generate the complete, ready-to-run HTML slide now.`;

    try {
      let rawResponse = '';
      if (settings.provider === 'antigravity') {
        rawResponse = await this.callAntigravity(systemPrompt, userMessage);
      } else if (settings.provider === 'openai') {
        if (!settings.openaiApiKey) {
          return { success: false, error: 'OpenAI API key not configured. Please enter your API key in AI Settings.' };
        }
        rawResponse = await this.callOpenAI(settings.openaiApiKey, settings.openaiModel || 'gpt-4o', systemPrompt, userMessage);
      } else if (settings.provider === 'anthropic') {
        if (!settings.anthropicApiKey) {
          return { success: false, error: 'Anthropic API key not configured. Please enter your API key in AI Settings.' };
        }
        rawResponse = await this.callAnthropic(settings.anthropicApiKey, settings.anthropicModel || 'claude-3-5-sonnet-20241022', systemPrompt, userMessage);
      } else {
        return { success: false, error: `Unknown provider: ${settings.provider}` };
      }

      // Extract HTML from ```html ... ``` or raw string
      let html = rawResponse.trim();
      const codeFenceMatch = html.match(/```html\s*([\s\S]*?)\s*```/i);
      if (codeFenceMatch) {
        html = codeFenceMatch[1].trim();
      } else if (html.startsWith('```') && html.endsWith('```')) {
        html = html.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
      }

      if (!html.toLowerCase().includes('<!doctype html') && !html.toLowerCase().includes('<html')) {
        return { success: false, error: 'AI output did not contain valid HTML document markup.' };
      }

      // Extract title from <title> tag if available
      let title = req.slideTitle || '';
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && !title) {
        title = titleMatch[1].trim();
      }
      if (!title) {
        title = 'AI Designed Slide';
      }

      return {
        success: true,
        slideHtml: html,
        slideTitle: title
      };
    } catch (err: any) {
      console.error('[AIService] Generation error:', err);
      return {
        success: false,
        error: err.message || 'AI generation failed'
      };
    }
  }

  /**
   * Calls Antigravity CLI in print mode (-p) using the active user authentication.
   */
  private async callAntigravity(systemPrompt: string, userMessage: string): Promise<string> {
    const fullPrompt = `${systemPrompt}\n\n---\n${userMessage}`;
    return new Promise((resolve, reject) => {
      const child = spawn('/home/parallels/.local/bin/agy', ['-p', fullPrompt], {
        env: { ...process.env, PAGER: 'cat' },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        reject(new Error(`Failed to launch Antigravity CLI (agy): ${err.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Antigravity CLI exited with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  }

  /**
   * Direct OpenAI Chat Completion REST API call.
   */
  private async callOpenAI(apiKey: string, model: string, systemPrompt: string, userMessage: string): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Direct Anthropic Messages REST API call.
   */
  private async callAnthropic(apiKey: string, model: string, systemPrompt: string, userMessage: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }

    const data = await res.json() as any;
    const textBlock = data.content?.find((c: any) => c.type === 'text');
    return textBlock?.text || '';
  }
}

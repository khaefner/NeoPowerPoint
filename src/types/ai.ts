export type AIProvider = 'antigravity' | 'openai' | 'anthropic';

export interface AISettings {
  provider: AIProvider;
  openaiApiKey?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  antigravityModel?: string;
}

export interface GenerateSlideRequest {
  deckPath: string;
  currentSlideRelPath?: string;
  insertAfterIndex?: number;
  userPrompt: string;
  slideTitle?: string;
  mode: 'new' | 'restyle'; // 'new' slide or 'restyle' existing slide
}

export interface GenerateSlideResponse {
  success: boolean;
  slideHtml?: string;
  slideTitle?: string;
  error?: string;
}

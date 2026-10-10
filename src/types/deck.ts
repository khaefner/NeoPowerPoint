export interface SlideMetadata {
  id: string;
  title: string;
  path: string;           // Relative path from presentation root to html file
  notes?: string;         // Presenter notes (Markdown / plain text)
  durationSec?: number;   // Recommended duration (in seconds)
  autoAdvanceSec?: number;// Optional auto-advance timer (0 or undefined for manual)
  transition?: 'none' | 'fade' | 'slide-left' | 'zoom';
  hidden?: boolean;
  hasAnimations?: boolean;
  animationSteps?: number;
}

export interface DeckManifest {
  version: string;
  title: string;
  author?: string;
  description?: string;
  aspectRatio: '16:9' | '4:3' | '16:10' | 'custom';
  customWidth?: number;   // Default 1920
  customHeight?: number;  // Default 1080
  theme?: 'dark' | 'light';
  defaultTransition?: 'none' | 'fade' | 'slide-left' | 'zoom';
  slides: SlideMetadata[];
}

export interface PresentationState {
  deckPath: string | null;
  manifest: DeckManifest | null;
  currentSlideIndex: number;
  totalSlides: number;
  isFullscreen: boolean;
  isWindowedPresentation: boolean;
  isPresenterOpen: boolean;
  isWatcherActive: boolean;
}

export interface SlideNavEvent {
  index: number;
  direction?: 'next' | 'prev' | 'jump';
}

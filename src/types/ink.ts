export type InkPoint = [number, number, number]; // [x: 0..1, y: 0..1, pressure: 0..1]

export interface InkStroke {
  id: string;
  slideIndex: number;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // Normalized or base px at 1920x1080
  points: InkPoint[];
}

export interface SlideInkState {
  slideIndex: number;
  strokes: InkStroke[];
}

export interface SlideScrollAction {
  type: 'slide:scroll';
  slideIndex: number;
  selector?: string; // e.g. '#web-viewport', '#web-frame', 'window', or custom element selector
  scrollTop: number;
  scrollLeft: number;
  ratioX?: number; // 0..1 normalized scroll
  ratioY?: number; // 0..1 normalized scroll
}

export interface SlideDomSyncAction {
  type: 'slide:dom-sync';
  slideIndex: number;
  bodyClass?: string;
  animStep?: number;
  attributes?: Array<{
    selector: string;
    name: string;
    value: string | null;
  }>;
  inputs?: Array<{
    selector: string;
    value?: string;
    checked?: boolean;
  }>;
  media?: Array<{
    selector: string;
    currentTime: number;
    paused: boolean;
  }>;
}

export type InkSyncAction =
  | { type: 'ink:stroke-start'; stroke: InkStroke }
  | { type: 'ink:stroke-update'; id: string; points: InkPoint[] }
  | { type: 'ink:stroke-end'; id: string }
  | { type: 'ink:undo'; slideIndex: number }
  | { type: 'ink:clear'; slideIndex: number }
  | { type: 'ink:sync-slide'; slideIndex: number; strokes: InkStroke[] }
  | { type: 'slide:navigate'; target: number | 'next' | 'prev' }
  | { type: 'slide:state'; state: any }
  | SlideScrollAction
  | SlideDomSyncAction;


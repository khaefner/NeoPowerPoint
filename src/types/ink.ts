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

export type InkSyncAction =
  | { type: 'ink:stroke-start'; stroke: InkStroke }
  | { type: 'ink:stroke-update'; id: string; points: InkPoint[] }
  | { type: 'ink:stroke-end'; id: string }
  | { type: 'ink:undo'; slideIndex: number }
  | { type: 'ink:clear'; slideIndex: number }
  | { type: 'ink:sync-slide'; slideIndex: number; strokes: InkStroke[] }
  | { type: 'slide:navigate'; target: number | 'next' | 'prev' }
  | { type: 'slide:state'; state: any };

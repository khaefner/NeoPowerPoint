import { InkStroke, InkPoint } from '../types/ink';

export class InkStore {
  // Map of slideIndex -> array of strokes
  private slideStrokes: Map<number, InkStroke[]> = new Map();
  // Map of strokeId -> stroke for fast lookup during streaming
  private activeStrokes: Map<string, InkStroke> = new Map();

  public getStrokes(slideIndex: number): InkStroke[] {
    return this.slideStrokes.get(slideIndex) || [];
  }

  public startStroke(stroke: InkStroke): void {
    const list = this.slideStrokes.get(stroke.slideIndex) || [];
    list.push(stroke);
    this.slideStrokes.set(stroke.slideIndex, list);
    this.activeStrokes.set(stroke.id, stroke);
  }

  public appendPoints(id: string, points: InkPoint[]): void {
    const stroke = this.activeStrokes.get(id);
    if (stroke) {
      stroke.points.push(...points);
    }
  }

  public endStroke(id: string): void {
    this.activeStrokes.delete(id);
  }

  public undo(slideIndex: number): InkStroke | undefined {
    const list = this.slideStrokes.get(slideIndex);
    if (list && list.length > 0) {
      const removed = list.pop();
      if (removed) {
        this.activeStrokes.delete(removed.id);
      }
      return removed;
    }
    return undefined;
  }

  public clearSlide(slideIndex: number): void {
    const list = this.slideStrokes.get(slideIndex) || [];
    for (const stroke of list) {
      this.activeStrokes.delete(stroke.id);
    }
    this.slideStrokes.set(slideIndex, []);
  }

  public setSlideStrokes(slideIndex: number, strokes: InkStroke[]): void {
    this.slideStrokes.set(slideIndex, [...strokes]);
  }

  public resetAll(): void {
    this.slideStrokes.clear();
    this.activeStrokes.clear();
  }
}

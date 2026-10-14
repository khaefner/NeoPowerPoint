import { InkStroke, InkPoint } from '../types/ink';

export interface InkOverlayOptions {
  container: HTMLElement;
  isInteractive?: boolean; // If true, can also draw via mouse/pen on this view
  onStrokeStart?: (stroke: InkStroke) => void;
  onStrokeUpdate?: (id: string, points: InkPoint[]) => void;
  onStrokeEnd?: (id: string) => void;
}

export class InkOverlay {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentSlideIndex: number = 0;
  private strokes: InkStroke[] = [];
  private activeStrokes: Map<string, InkStroke> = new Map();

  private isInteractive: boolean;
  private isDrawing: boolean = false;
  private localStrokeId: string | null = null;
  private currentTool: 'pen' | 'highlighter' = 'pen';
  private currentColor: string = '#ef4444';
  private currentSize: number = 4;

  private onStrokeStart?: (stroke: InkStroke) => void;
  private onStrokeUpdate?: (id: string, points: InkPoint[]) => void;
  private onStrokeEnd?: (id: string) => void;

  constructor(options: InkOverlayOptions) {
    this.container = options.container;
    this.isInteractive = !!options.isInteractive;
    this.onStrokeStart = options.onStrokeStart;
    this.onStrokeUpdate = options.onStrokeUpdate;
    this.onStrokeEnd = options.onStrokeEnd;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ink-overlay-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = this.isInteractive ? 'auto' : 'none';
    this.canvas.style.zIndex = '50';

    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

    this.setupResize();
    if (this.isInteractive) {
      this.setupInteractiveDrawing();
    }
  }

  public setTool(tool: 'pen' | 'highlighter', color: string = '#ef4444', size: number = 4): void {
    this.currentTool = tool;
    this.currentColor = color;
    this.currentSize = size;
  }

  public setInteractive(enabled: boolean): void {
    this.isInteractive = enabled;
    this.canvas.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  private setupResize(): void {
    const resize = () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w <= 0 || h <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);

      this.redrawAll();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(this.container);
    window.addEventListener('resize', resize);
    resize();
  }

  public setSlideIndex(index: number, existingStrokes: InkStroke[] = []): void {
    this.currentSlideIndex = index;
    this.strokes = [...existingStrokes];
    this.activeStrokes.clear();
    this.redrawAll();
  }

  public startStroke(stroke: InkStroke): void {
    if (stroke.slideIndex !== this.currentSlideIndex) return;

    this.activeStrokes.set(stroke.id, stroke);
    this.strokes.push(stroke);

    if (stroke.points && stroke.points.length > 0) {
      this.drawPoint(stroke, stroke.points[0]);
    }
  }

  public updateStroke(id: string, points: InkPoint[]): void {
    const stroke = this.activeStrokes.get(id);
    if (!stroke) return;

    for (const pt of points) {
      stroke.points.push(pt);
      this.drawPoint(stroke, pt);
    }
  }

  public endStroke(id: string): void {
    this.activeStrokes.delete(id);
  }

  public undo(): void {
    this.strokes.pop();
    this.redrawAll();
  }

  public clear(): void {
    this.strokes = [];
    this.activeStrokes.clear();
    this.redrawAll();
  }

  private drawPoint(stroke: InkStroke, pt: InkPoint): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.ctx.save();
    if (stroke.tool === 'highlighter') {
      this.ctx.globalAlpha = 0.35;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.size * 5;
      this.ctx.lineCap = 'square';
      this.ctx.lineJoin = 'bevel';
    } else {
      this.ctx.globalAlpha = 1.0;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.size * (pt[2] ? 0.6 + pt[2] * 0.8 : 1);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
    }

    const points = stroke.points;
    if (points.length < 2) {
      this.ctx.fillStyle = stroke.color;
      this.ctx.beginPath();
      this.ctx.arc(pt[0] * w, pt[1] * h, (stroke.size * (pt[2] || 0.5)) / 2, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      const p1 = points[points.length - 2];
      const p2 = points[points.length - 1];
      this.ctx.beginPath();
      this.ctx.moveTo(p1[0] * w, p1[1] * h);
      this.ctx.lineTo(p2[0] * w, p2[1] * h);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  public redrawAll(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.ctx.clearRect(0, 0, w, h);

    for (const stroke of this.strokes) {
      this.renderCompleteStroke(stroke, w, h);
    }
  }

  private renderCompleteStroke(stroke: InkStroke, w: number, h: number): void {
    if (!stroke.points || stroke.points.length === 0) return;

    this.ctx.save();
    if (stroke.tool === 'highlighter') {
      this.ctx.globalAlpha = 0.35;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.size * 5;
      this.ctx.lineCap = 'square';
      this.ctx.lineJoin = 'bevel';
    } else {
      this.ctx.globalAlpha = 1.0;
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.size;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
    }

    const pts = stroke.points;
    if (pts.length === 1) {
      this.ctx.fillStyle = stroke.color;
      this.ctx.beginPath();
      this.ctx.arc(pts[0][0] * w, pts[0][1] * h, (stroke.size * (pts[0][2] || 0.5)) / 2, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.beginPath();
      this.ctx.moveTo(pts[0][0] * w, pts[0][1] * h);

      for (let i = 1; i < pts.length; i++) {
        const midX = (pts[i - 1][0] + pts[i][0]) / 2 * w;
        const midY = (pts[i - 1][1] + pts[i][1]) / 2 * h;
        this.ctx.quadraticCurveTo(pts[i - 1][0] * w, pts[i - 1][1] * h, midX, midY);
      }
      this.ctx.lineTo(pts[pts.length - 1][0] * w, pts[pts.length - 1][1] * h);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  private setupInteractiveDrawing(): void {
    const getNormalizedPoint = (e: PointerEvent): InkPoint => {
      const rect = this.canvas.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      return [normX, normY, pressure];
    };

    this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.isInteractive) return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);

      this.isDrawing = true;
      this.localStrokeId = `host-stroke-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      const pt = getNormalizedPoint(e);

      const stroke: InkStroke = {
        id: this.localStrokeId,
        slideIndex: this.currentSlideIndex,
        tool: this.currentTool,
        color: this.currentColor,
        size: this.currentSize,
        points: [pt],
      };

      this.strokes.push(stroke);
      this.activeStrokes.set(stroke.id, stroke);
      this.drawPoint(stroke, pt);

      this.onStrokeStart?.(stroke);
    });

    this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.isDrawing || !this.localStrokeId) return;
      e.preventDefault();

      const pt = getNormalizedPoint(e);
      const stroke = this.activeStrokes.get(this.localStrokeId);
      if (stroke) {
        stroke.points.push(pt);
        this.drawPoint(stroke, pt);
        this.onStrokeUpdate?.(this.localStrokeId, [pt]);
      }
    });

    const stopDrawing = (e: PointerEvent) => {
      if (!this.isDrawing || !this.localStrokeId) return;
      e.preventDefault();
      this.isDrawing = false;
      this.onStrokeEnd?.(this.localStrokeId);
      this.activeStrokes.delete(this.localStrokeId);
      this.localStrokeId = null;
    };

    this.canvas.addEventListener('pointerup', stopDrawing);
    this.canvas.addEventListener('pointercancel', stopDrawing);
  }
}

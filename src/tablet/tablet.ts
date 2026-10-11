import { InkStroke, InkPoint, InkSyncAction, SlideScrollAction, SlideDomSyncAction, SlideFrameAction } from '../types/ink';

class TabletInkingClient {
  private ws: WebSocket | null = null;
  private wsConnected: boolean = false;
  private reconnectTimer: any = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private slideScaler: HTMLElement;
  private slideFrame: HTMLIFrameElement;
  private slideMirror: HTMLImageElement;
  private viewportContainer: HTMLElement;
  private updateLayoutSize: () => void = () => {};

  private deckTitleEl: HTMLElement;
  private slideCounterEl: HTMLElement;
  private statusDotEl: HTMLElement;
  private statusTextEl: HTMLElement;

  // Active tools
  private currentTool: 'pen' | 'highlighter' | 'eraser' = 'pen';
  private currentColor: string = '#ef4444';
  private currentSize: number = 4;

  // Inking state
  private isDrawing: boolean = false;
  private activeStrokeId: string | null = null;
  private activeStrokePoints: InkPoint[] = [];
  private currentSlideIndex: number = 0;
  private slideStrokes: InkStroke[] = [];
  private lastState: any = null;

  // Remote active strokes map for multi-stroke rendering
  private remoteStrokes: Map<string, InkStroke> = new Map();

  // Throttling for network point streaming
  private pendingPoints: InkPoint[] = [];
  private streamInterval: any = null;
  private lastErasePoint: [number, number] | null = null;

  // Real-time slide presentation sync state
  private currentAnimStep: number = 0;
  private isFrameLoading: boolean = false;
  private pendingScroll: SlideScrollAction | null = null;
  private pendingDom: SlideDomSyncAction | null = null;
  private lastScrollBySlide: Map<number, SlideScrollAction> = new Map();
  private lastDomBySlide: Map<number, SlideDomSyncAction> = new Map();

  constructor() {
    this.canvas = document.getElementById('ink-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d', { desynchronized: true }) as CanvasRenderingContext2D;
    this.slideScaler = document.getElementById('slide-scaler')!;
    this.slideFrame = document.getElementById('slide-frame') as HTMLIFrameElement;
    this.slideMirror = document.getElementById('slide-mirror') as HTMLImageElement;
    this.viewportContainer = document.getElementById('viewport-container')!;

    this.deckTitleEl = document.getElementById('deck-title')!;
    this.slideCounterEl = document.getElementById('slide-counter')!;
    this.statusDotEl = document.getElementById('status-dot')!;
    this.statusTextEl = document.getElementById('status-text')!;

    this.slideFrame.addEventListener('load', () => this.handleFrameLoad());

    if (this.slideMirror) {
      this.slideMirror.onload = () => {
        if (this.slideMirror.style.display === 'block') {
          this.slideFrame.style.opacity = '0';
        }
      };
      this.slideMirror.onerror = (e) => {
        if (!this.slideMirror.src || this.slideMirror.src === window.location.href) return;
        console.warn('[TabletClient] slideMirror frame decode error:', e);
        this.slideFrame.style.opacity = '1';
        this.slideMirror.style.display = 'none';
      };
    }

    this.initLayout();
    this.initToolbar();
    this.initPointerEvents();
    this.connectWebSocket();
  }

  // 1. Viewport & Aspect Ratio Layout (Exact 1:1 Scale matching presentation)
  private initLayout(): void {
    this.updateLayoutSize = () => {
      const vw = this.viewportContainer.clientWidth;
      const vh = this.viewportContainer.clientHeight;
      if (vw <= 0 || vh <= 0) return;

      const baseW = this.lastState?.manifest?.customWidth || 1920;
      const baseH = this.lastState?.manifest?.customHeight || 1080;

      // Fit the base 1920x1080 slide inside the available viewport
      const scale = Math.min(vw / baseW, vh / baseH);
      const left = (vw - baseW * scale) / 2;
      const top = (vh - baseH * scale) / 2;

      this.slideScaler.style.width = `${baseW}px`;
      this.slideScaler.style.height = `${baseH}px`;
      this.slideScaler.style.transform = `scale(${scale})`;
      this.slideScaler.style.left = `${left}px`;
      this.slideScaler.style.top = `${top}px`;

      this.slideFrame.style.width = `${baseW}px`;
      this.slideFrame.style.height = `${baseH}px`;

      if (this.slideMirror) {
        this.slideMirror.style.width = `${baseW}px`;
        this.slideMirror.style.height = `${baseH}px`;
      }

      // Set canvas internal resolution to match base slide coordinate system exactly
      if (this.canvas.width !== baseW || this.canvas.height !== baseH) {
        this.canvas.width = baseW;
        this.canvas.height = baseH;
        this.canvas.style.width = `${baseW}px`;
        this.canvas.style.height = `${baseH}px`;
      }

      this.redrawAll();
    };

    const ro = new ResizeObserver(this.updateLayoutSize);
    ro.observe(this.viewportContainer);
    window.addEventListener('resize', this.updateLayoutSize);
    this.updateLayoutSize();
  }

  // 2. Toolbar Setup
  private initToolbar(): void {
    // Navigation
    document.getElementById('btn-prev')!.addEventListener('click', () => this.sendNavigate('prev'));
    document.getElementById('btn-next')!.addEventListener('click', () => this.sendNavigate('next'));

    // Fullscreen Toggle
    const btnFullscreen = document.getElementById('btn-fullscreen');
    btnFullscreen?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    document.addEventListener('fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      if (btnFullscreen) {
        btnFullscreen.textContent = isFs ? '⛶ Exit' : '⛶ Fullscreen';
      }
      setTimeout(() => this.updateLayoutSize(), 150);
    });

    // Max Slide (Zen) Mode Toggle
    const tabletApp = document.getElementById('tablet-app')!;
    const btnMaxSlide = document.getElementById('btn-max-slide');
    const btnRestoreHeader = document.getElementById('btn-restore-header');

    const toggleMaxSlide = (enable?: boolean) => {
      const isZen = typeof enable === 'boolean' ? enable : !tabletApp.classList.contains('zen-mode');
      tabletApp.classList.toggle('zen-mode', isZen);
      if (btnMaxSlide) {
        btnMaxSlide.textContent = isZen ? '🗗 Min' : '🗖 Max';
      }
      setTimeout(() => this.updateLayoutSize(), 100);
    };

    btnMaxSlide?.addEventListener('click', () => toggleMaxSlide());
    btnRestoreHeader?.addEventListener('click', () => toggleMaxSlide(false));

    // Tools
    const toolPen = document.getElementById('tool-pen')!;
    const toolHighlighter = document.getElementById('tool-highlighter')!;
    const toolEraser = document.getElementById('tool-eraser')!;

    const setTool = (tool: 'pen' | 'highlighter' | 'eraser') => {
      this.currentTool = tool;
      toolPen.classList.toggle('active', tool === 'pen');
      toolHighlighter.classList.toggle('active', tool === 'highlighter');
      toolEraser.classList.toggle('active', tool === 'eraser');
      this.canvas.classList.toggle('eraser-mode', tool === 'eraser');
    };

    toolPen.addEventListener('click', () => setTool('pen'));
    toolHighlighter.addEventListener('click', () => setTool('highlighter'));
    toolEraser.addEventListener('click', () => setTool('eraser'));

    // Colors
    const colorDots = document.querySelectorAll('.color-dot');
    colorDots.forEach((dot) => {
      dot.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const col = target.getAttribute('data-color');
        if (col) {
          this.currentColor = col;
          colorDots.forEach(d => d.classList.remove('active'));
          target.classList.add('active');
          if (this.currentTool === 'eraser') {
            setTool('pen');
          }
        }
      });
    });

    // Stroke Sizes
    const sizeBtns = document.querySelectorAll('.stroke-size-btn');
    sizeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const sz = parseInt(target.getAttribute('data-size') || '4', 10);
        this.currentSize = sz;
        sizeBtns.forEach(b => b.classList.remove('active'));
        target.classList.add('active');
      });
    });

    // Undo & Clear
    document.getElementById('btn-undo')!.addEventListener('click', () => this.sendUndo());
    document.getElementById('btn-clear')!.addEventListener('click', () => this.sendClear());
  }

  // 3. Pointer Events (Wacom EMR Stylus & Palm Rejection)
  private initPointerEvents(): void {
    const getNormalizedPoint = (e: PointerEvent): InkPoint => {
      const rect = this.canvas.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      return [normX, normY, pressure];
    };

    this.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);

      const pt = getNormalizedPoint(e);
      // Hardware eraser detection (stylus side-button or tail eraser)
      const isHardwareEraser = e.buttons === 32 || e.buttons === 2 || e.pointerType === 'eraser';
      const isErasing = this.currentTool === 'eraser' || isHardwareEraser;

      if (isErasing) {
        this.isDrawing = true;
        this.lastErasePoint = [pt[0], pt[1]];
        this.eraseAlongSegment(pt[0], pt[1], pt[0], pt[1]);
        return;
      }

      this.isDrawing = true;
      this.activeStrokeId = `stroke-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      this.activeStrokePoints = [pt];
      this.pendingPoints = [pt];

      const stroke: InkStroke = {
        id: this.activeStrokeId,
        slideIndex: this.currentSlideIndex,
        tool: this.currentTool,
        color: this.currentColor,
        size: this.currentSize,
        points: [pt],
      };

      this.slideStrokes.push(stroke);

      // Render locally immediately
      this.drawLocalPoint(stroke, pt);

      // Send to server
      this.send({
        type: 'ink:stroke-start',
        stroke,
      });

      // Start batch streaming interval for points
      this.startPointStreaming();
    });

    this.canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.isDrawing) return;
      e.preventDefault();

      const pt = getNormalizedPoint(e);
      const isHardwareEraser = e.buttons === 32 || e.buttons === 2 || e.pointerType === 'eraser';
      const isErasing = this.currentTool === 'eraser' || isHardwareEraser;

      if (isErasing) {
        // If barrel button was pressed mid-stroke, cancel active drawing stroke
        if (this.activeStrokeId) {
          this.stopPointStreaming();
          this.activeStrokeId = null;
          this.activeStrokePoints = [];
          this.pendingPoints = [];
        }
        const lastPt = this.lastErasePoint || [pt[0], pt[1]];
        this.eraseAlongSegment(lastPt[0], lastPt[1], pt[0], pt[1]);
        this.lastErasePoint = [pt[0], pt[1]];
        return;
      }

      if (!this.activeStrokeId) return;

      this.activeStrokePoints.push(pt);
      this.pendingPoints.push(pt);

      const stroke = this.slideStrokes[this.slideStrokes.length - 1];
      if (stroke) {
        stroke.points.push(pt);
        this.drawLocalPoint(stroke, pt);
      }
    });

    const finishStroke = (e: PointerEvent) => {
      if (!this.isDrawing) return;
      e.preventDefault();
      this.isDrawing = false;
      this.lastErasePoint = null;
      this.stopPointStreaming();

      if (this.currentTool !== 'eraser' && this.activeStrokeId) {
        // Flush remaining points
        if (this.pendingPoints.length > 0) {
          this.send({
            type: 'ink:stroke-update',
            id: this.activeStrokeId,
            points: this.pendingPoints,
          });
          this.pendingPoints = [];
        }

        this.send({
          type: 'ink:stroke-end',
          id: this.activeStrokeId,
        });
      }

      this.activeStrokeId = null;
      this.activeStrokePoints = [];
    };

    this.canvas.addEventListener('pointerup', finishStroke);
    this.canvas.addEventListener('pointercancel', finishStroke);
  }

  private startPointStreaming(): void {
    if (this.streamInterval) clearInterval(this.streamInterval);
    // Send points every 12ms (approx 80Hz) to keep latency low without flooding
    this.streamInterval = setInterval(() => {
      if (this.activeStrokeId && this.pendingPoints.length > 0) {
        this.send({
          type: 'ink:stroke-update',
          id: this.activeStrokeId,
          points: [...this.pendingPoints],
        });
        this.pendingPoints = [];
      }
    }, 12);
  }

  private stopPointStreaming(): void {
    if (this.streamInterval) {
      clearInterval(this.streamInterval);
      this.streamInterval = null;
    }
  }

  // 4. Inking Renderers
  private drawLocalPoint(stroke: InkStroke, pt: InkPoint): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

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
      // Draw initial circle dot
      this.ctx.fillStyle = stroke.color;
      this.ctx.beginPath();
      this.ctx.arc(pt[0] * w, pt[1] * h, (stroke.size * (pt[2] || 0.5)) / 2, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      // Connect last two points
      const p1 = points[points.length - 2];
      const p2 = points[points.length - 1];
      this.ctx.beginPath();
      this.ctx.moveTo(p1[0] * w, p1[1] * h);
      this.ctx.lineTo(p2[0] * w, p2[1] * h);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  private redrawAll(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.clearRect(0, 0, w, h);

    for (const stroke of this.slideStrokes) {
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

  private eraseAlongSegment(x1: number, y1: number, x2: number, y2: number): boolean {
    const aspect = 16 / 9;
    const dist = Math.hypot(x2 - x1, (y2 - y1) / aspect);
    const stepSize = 0.015; // ~28px on 1920x1080 for dense eraser coverage
    const steps = Math.max(1, Math.ceil(dist / stepSize));
    let anyErased = false;

    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = x1 + t * (x2 - x1);
      const py = y1 + t * (y2 - y1);
      if (this.eraseAtPoint(px, py, false)) {
        anyErased = true;
      }
    }

    if (anyErased) {
      this.redrawAll();
      this.send({
        type: 'ink:sync-slide',
        slideIndex: this.currentSlideIndex,
        strokes: this.slideStrokes,
      });
    }

    return anyErased;
  }

  private eraseAtPoint(x: number, y: number, syncImmediately: boolean = true): boolean {
    const thresholdSq = 0.035 * 0.035; // ~3.5% hit radius (~67px radius)
    const initialLen = this.slideStrokes.length;
    const aspect = 16 / 9;

    const distToSegmentSq = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
      const dy1 = (y1 - py) / aspect;
      const dy2 = (y2 - py) / aspect;
      const dx1 = x1 - px;
      const dx2 = x2 - px;

      const segDx = dx2 - dx1;
      const segDy = dy2 - dy1;
      const lenSq = segDx * segDx + segDy * segDy;
      if (lenSq === 0) return dx1 * dx1 + dy1 * dy1;

      const t = Math.max(0, Math.min(1, -(dx1 * segDx + dy1 * segDy) / lenSq));
      const projX = dx1 + t * segDx;
      const projY = dy1 + t * segDy;
      return projX * projX + projY * projY;
    };

    this.slideStrokes = this.slideStrokes.filter((stroke) => {
      const pts = stroke.points;
      if (!pts || pts.length === 0) return true;

      if (pts.length === 1) {
        const dx = pts[0][0] - x;
        const dy = (pts[0][1] - y) / aspect;
        return (dx * dx + dy * dy) >= thresholdSq;
      }

      for (let i = 1; i < pts.length; i++) {
        if (distToSegmentSq(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < thresholdSq) {
          return false; // Erase stroke
        }
      }
      return true;
    });

    const changed = this.slideStrokes.length !== initialLen;
    if (changed && syncImmediately) {
      this.redrawAll();
      this.send({
        type: 'ink:sync-slide',
        slideIndex: this.currentSlideIndex,
        strokes: this.slideStrokes,
      });
    }

    return changed;
  }

  // 5. WebSocket Communication
  private connectWebSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}`;

    this.statusTextEl.textContent = 'Connecting...';
    this.statusDotEl.className = 'status-dot disconnected';

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.wsConnected = true;
        this.statusTextEl.textContent = 'Online (ADB)';
        this.statusDotEl.className = 'status-dot connected';
        console.log('[TabletClient] Connected to sync server');
      };

      this.ws.onmessage = (event) => {
        try {
          const action = JSON.parse(event.data) as InkSyncAction;
          this.handleServerAction(action);
        } catch (err: any) {
          console.warn('[TabletClient] Bad message:', err.message);
        }
      };

      this.ws.onclose = () => {
        this.wsConnected = false;
        this.statusTextEl.textContent = 'Disconnected';
        this.statusDotEl.className = 'status-dot disconnected';
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, 2000);
  }

  private send(action: InkSyncAction): void {
    if (this.ws && this.wsConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(action));
    }
  }

  private sendNavigate(target: 'next' | 'prev'): void {
    this.send({ type: 'slide:navigate', target });
  }

  private sendUndo(): void {
    if (this.slideStrokes.length > 0) {
      this.slideStrokes.pop();
      this.redrawAll();
    }
    this.send({ type: 'ink:undo', slideIndex: this.currentSlideIndex });
  }

  private sendClear(): void {
    if (this.slideStrokes.length > 0) {
      this.slideStrokes = [];
      this.redrawAll();
    }
    this.send({ type: 'ink:clear', slideIndex: this.currentSlideIndex });
  }

  // 6. Incoming Server Action Dispatcher
  private handleServerAction(action: InkSyncAction): void {
    switch (action.type) {
      case 'slide:state':
        this.handleSlideState(action.state);
        break;

      case 'ink:sync-slide':
        if (action.slideIndex === this.currentSlideIndex) {
          this.slideStrokes = action.strokes || [];
          this.redrawAll();
        }
        break;

      case 'ink:stroke-start':
        if (action.stroke.slideIndex === this.currentSlideIndex) {
          this.remoteStrokes.set(action.stroke.id, action.stroke);
          this.slideStrokes.push(action.stroke);
          this.drawLocalPoint(action.stroke, action.stroke.points[0]);
        }
        break;

      case 'ink:stroke-update':
        {
          const rStroke = this.remoteStrokes.get(action.id);
          if (rStroke) {
            for (const pt of action.points) {
              rStroke.points.push(pt);
              this.drawLocalPoint(rStroke, pt);
            }
          }
        }
        break;

      case 'ink:stroke-end':
        this.remoteStrokes.delete(action.id);
        break;

      case 'ink:undo':
        if (action.slideIndex === this.currentSlideIndex) {
          this.slideStrokes.pop();
          this.redrawAll();
        }
        break;

      case 'ink:clear':
        if (action.slideIndex === this.currentSlideIndex) {
          this.slideStrokes = [];
          this.redrawAll();
        }
        break;

      case 'slide:scroll':
        this.lastScrollBySlide.set(action.slideIndex, action);
        if (action.slideIndex === this.currentSlideIndex) {
          if (this.isFrameLoading) {
            this.pendingScroll = action;
          } else {
            this.applyScroll(action);
          }
        }
        break;

      case 'slide:dom-sync':
        this.lastDomBySlide.set(action.slideIndex, action);
        if (action.slideIndex === this.currentSlideIndex) {
          if (this.isFrameLoading) {
            this.pendingDom = action;
          } else {
            this.applyDomSync(action);
          }
        }
        break;

      case 'slide:frame':
        if (this.slideMirror && action.data) {
          this.slideMirror.src = action.data;
          this.slideMirror.style.display = 'block';
          if (this.slideFrame) {
            this.slideFrame.style.opacity = '0';
          }
          if (this.statusTextEl && this.wsConnected) {
            this.statusTextEl.textContent = 'Mirror Active';
          }
        }
        break;

      default:
        break;
    }
  }

  private handleSlideState(state: any): void {
    if (!state || !state.manifest) return;
    this.lastState = state;
    this.updateLayoutSize();

    const { manifest, currentIndex, totalSlides, currentAnimStep } = state;
    this.currentSlideIndex = currentIndex;
    if (typeof currentAnimStep === 'number') {
      this.currentAnimStep = currentAnimStep;
    }

    this.deckTitleEl.textContent = manifest.title || 'NeoPowerPoint';
    this.slideCounterEl.textContent = `${currentIndex + 1} / ${totalSlides}`;

    const currentSlide = manifest.slides[currentIndex];
    if (currentSlide) {
      const slideUrl = `/deck/${currentSlide.path}?view=tablet`;
      const fullUrl = window.location.origin + slideUrl;
      if (this.slideFrame.src !== fullUrl) {
        this.isFrameLoading = true;
        this.slideFrame.src = slideUrl;
        this.slideFrame.style.opacity = '1';
        if (this.slideMirror) {
          this.slideMirror.style.display = 'none';
          this.slideMirror.src = '';
        }
      } else {
        // Slide is already loaded, update anim step directly if provided
        if (typeof currentAnimStep === 'number') {
          this.applyAnimStep(currentAnimStep);
        }
      }
    }
  }

  private handleFrameLoad(): void {
    this.isFrameLoading = false;

    // 1. Re-apply current animation step to newly loaded frame
    if (typeof this.currentAnimStep === 'number') {
      this.applyAnimStep(this.currentAnimStep);
    }

    // 2. Re-apply pending or cached DOM sync
    const lastDom = this.pendingDom || this.lastDomBySlide.get(this.currentSlideIndex);
    if (lastDom) {
      this.applyDomSync(lastDom);
      this.pendingDom = null;
    }

    // 3. Re-apply pending or cached scroll
    const lastScroll = this.pendingScroll || this.lastScrollBySlide.get(this.currentSlideIndex);
    if (lastScroll) {
      setTimeout(() => {
        this.applyScroll(lastScroll);
      }, 60);
      this.pendingScroll = null;
    }
  }

  private applyAnimStep(step: number): void {
    try {
      const win = this.slideFrame.contentWindow as any;
      if (win && typeof win.goToAnimStep === 'function') {
        win.goToAnimStep(step, false);
      }
      win?.postMessage({
        type: 'NEODECK_SET_STEP',
        step: step,
        animate: false
      }, '*');
    } catch (_) {}
  }

  private applyScroll(action: SlideScrollAction): void {
    try {
      const doc = this.slideFrame.contentDocument;
      const win = this.slideFrame.contentWindow as any;
      if (!doc) return;

      // Handle nested iframe scroll (e.g. #web-frame inside web slides)
      if (action.selector === '#web-frame' || action.selector === 'iframe') {
        const nestedFrame = doc.querySelector(action.selector) as HTMLIFrameElement;
        if (nestedFrame) {
          try {
            const nestedWin = nestedFrame.contentWindow;
            const nestedDoc = nestedFrame.contentDocument;
            if (nestedWin) {
              nestedWin.scrollTo({
                left: action.scrollLeft,
                top: action.scrollTop,
                behavior: 'instant' as any
              });
            }
            if (nestedDoc) {
              nestedDoc.documentElement.scrollTop = action.scrollTop;
              nestedDoc.documentElement.scrollLeft = action.scrollLeft;
              if (nestedDoc.body) {
                nestedDoc.body.scrollTop = action.scrollTop;
                nestedDoc.body.scrollLeft = action.scrollLeft;
              }
            }
            return;
          } catch (_) {
            // Fallback for cross-origin iframes
            const scaler = doc.getElementById('web-frame-scaler');
            if (scaler) {
              scaler.style.transform = `translateY(-${action.scrollTop}px)`;
            }
            return;
          }
        }
      }

      // Element selector in slide document
      if (action.selector && action.selector !== 'window' && action.selector !== ':root' && action.selector !== 'body') {
        let targetEl = doc.querySelector(action.selector) as HTMLElement;
        if (!targetEl && action.selector === '#web-viewport') {
          targetEl = doc.getElementById('web-viewport')!;
        }
        if (targetEl) {
          const maxScrollY = targetEl.scrollHeight - targetEl.clientHeight;
          const maxScrollX = targetEl.scrollWidth - targetEl.clientWidth;
          if (action.ratioY !== undefined && maxScrollY > 0) {
            targetEl.scrollTop = action.ratioY * maxScrollY;
          } else {
            targetEl.scrollTop = action.scrollTop;
          }
          if (action.ratioX !== undefined && maxScrollX > 0) {
            targetEl.scrollLeft = action.ratioX * maxScrollX;
          } else {
            targetEl.scrollLeft = action.scrollLeft;
          }
          return;
        }
      }

      // Window / document level scroll
      if (win) {
        win.scrollTo({
          left: action.scrollLeft,
          top: action.scrollTop,
          behavior: 'instant' as any
        });
      }
      if (doc.documentElement) {
        doc.documentElement.scrollTop = action.scrollTop;
        doc.documentElement.scrollLeft = action.scrollLeft;
      }
      if (doc.body) {
        doc.body.scrollTop = action.scrollTop;
        doc.body.scrollLeft = action.scrollLeft;
      }
    } catch (_) {}
  }

  private applyDomSync(action: SlideDomSyncAction): void {
    try {
      const doc = this.slideFrame.contentDocument;
      const win = this.slideFrame.contentWindow as any;
      if (!doc) return;

      // 1. Sync bodyClass (e.g. web slide mode-fit vs mode-scroll)
      if (typeof action.bodyClass === 'string' && doc.body) {
        if (doc.body.className !== action.bodyClass) {
          const wasScroll = doc.body.classList.contains('mode-scroll');
          const isNowScroll = action.bodyClass.includes('mode-scroll');

          doc.body.className = action.bodyClass;

          // Call setFitMode if exposed on web slide window
          if (typeof win?.setFitMode === 'function') {
            win.setFitMode(!isNowScroll);
          } else {
            // Or toggle button if state differs
            if (wasScroll !== isNowScroll) {
              const toggleBtn = doc.getElementById('btn-toggle-mode');
              toggleBtn?.click();
            }
          }

          const scaler = doc.getElementById('web-frame-scaler');
          if (scaler) {
            if (isNowScroll) {
              scaler.style.left = '0px';
              scaler.style.top = '0px';
              scaler.style.transform = 'none';
              scaler.style.width = '100%';
              scaler.style.height = '100%';
            }
          }

          win?.dispatchEvent?.(new Event('resize'));
        }
      }

      // 2. Sync Animation step
      if (typeof action.animStep === 'number') {
        this.currentAnimStep = action.animStep;
        this.applyAnimStep(action.animStep);
      }

      // 3. Sync Attributes
      if (action.attributes && action.attributes.length > 0) {
        for (const attr of action.attributes) {
          try {
            const el = doc.querySelector(attr.selector);
            if (el) {
              if (attr.value === null) {
                el.removeAttribute(attr.name);
              } else {
                el.setAttribute(attr.name, attr.value);
              }
            }
          } catch (_) {}
        }
      }

      // 4. Sync Inputs
      if (action.inputs && action.inputs.length > 0) {
        for (const inp of action.inputs) {
          try {
            const el = doc.querySelector(inp.selector) as HTMLInputElement;
            if (el) {
              if (inp.value !== undefined) el.value = inp.value;
              if (inp.checked !== undefined) el.checked = inp.checked;
            }
          } catch (_) {}
        }
      }

      // 5. Sync Media
      if (action.media && action.media.length > 0) {
        for (const m of action.media) {
          try {
            const el = doc.querySelector(m.selector) as HTMLMediaElement;
            if (el) {
              if (Math.abs(el.currentTime - m.currentTime) > 0.5) {
                el.currentTime = m.currentTime;
              }
              if (m.paused && !el.paused) el.pause();
              else if (!m.paused && el.paused) el.play().catch(() => {});
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
}

// Start client on load
document.addEventListener('DOMContentLoaded', () => {
  new TabletInkingClient();
});

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { DeckService } from './deck-service';
import { InkStore } from './ink-store';
import { InkStroke, InkPoint, InkSyncAction } from '../types/ink';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export class SyncServer extends EventEmitter {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port: number;
  private deckService: DeckService;
  private inkStore: InkStore;
  private latestState: any = null;
  private clients: Set<WebSocket> = new Set();

  constructor(deckService: DeckService, inkStore: InkStore, port: number = 8765) {
    super();
    this.deckService = deckService;
    this.inkStore = inkStore;
    this.port = port;
  }

  public getPort(): number {
    return this.port;
  }

  public getConnectedClientCount(): number {
    return this.clients.size;
  }

  public async start(): Promise<number> {
    if (this.server) return this.port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on('connection', (ws) => this.handleWsConnection(ws));

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[SyncServer] Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server?.listen(this.port);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
        console.log(`[SyncServer] HTTP and WebSocket listening on http://0.0.0.0:${this.port}`);
        resolve(this.port);
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.wss) {
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://localhost:${this.port}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    // Enable CORS for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check & status API
    if (pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        connectedClients: this.clients.size,
        hasDeck: !!this.deckService.getActiveDeckPath(),
        currentState: this.latestState,
      }));
      return;
    }

    // Route to tablet app
    if (pathname === '/tablet') {
      res.writeHead(302, { Location: '/tablet/' });
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/tablet/') {
      pathname = '/tablet/index.html';
    }

    if (pathname.startsWith('/tablet/')) {
      const relPath = pathname.replace('/tablet/', '');
      const filePath = path.normalize(path.join(__dirname, '../tablet', relPath));
      this.serveStaticFile(filePath, res);
      return;
    }

    // Fallback for relative requests resolved at root (e.g. /tablet.js, /tablet.css)
    if (pathname === '/tablet.js' || pathname === '/tablet.css') {
      const filePath = path.normalize(path.join(__dirname, '../tablet', pathname.replace('/', '')));
      if (fs.existsSync(filePath)) {
        this.serveStaticFile(filePath, res);
        return;
      }
    }

    // Route to slide static assets (proxying active deck files)
    if (pathname.startsWith('/deck/')) {
      const activePath = this.deckService.getActiveDeckPath();
      if (!activePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('No active deck loaded');
        return;
      }

      const relPath = pathname.replace('/deck/', '');
      const filePath = path.normalize(path.join(activePath, relPath));
      if (!filePath.startsWith(path.normalize(activePath))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      this.serveStaticFile(filePath, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private serveStaticFile(filePath: string, res: http.ServerResponse): void {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File Not Found');
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const indexPath = path.join(filePath, 'index.html');
        if (fs.existsSync(indexPath)) {
          return this.serveStaticFile(indexPath, res);
        }
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Directory listing forbidden');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const fileBuffer = fs.readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(fileBuffer);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal Server Error: ${err.message}`);
    }
  }

  private handleWsConnection(ws: WebSocket): void {
    this.clients.add(ws);
    console.log(`[SyncServer] New tablet client connected (total: ${this.clients.size})`);
    this.emit('client-count-changed', this.clients.size);

    // Send current slide state immediately on connection
    if (this.latestState) {
      ws.send(JSON.stringify({
        type: 'slide:state',
        state: this.latestState
      }));

      // Send existing strokes for the current slide
      const currentIndex = this.latestState.currentIndex || 0;
      const strokes = this.inkStore.getStrokes(currentIndex);
      ws.send(JSON.stringify({
        type: 'ink:sync-slide',
        slideIndex: currentIndex,
        strokes
      }));
    }

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as InkSyncAction;
        this.processClientMessage(msg, ws);
      } catch (err: any) {
        console.warn('[SyncServer] WS parse error:', err.message);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`[SyncServer] Client disconnected (total: ${this.clients.size})`);
      this.emit('client-count-changed', this.clients.size);
    });

    ws.on('error', (err) => {
      console.warn('[SyncServer] WS client error:', err.message);
      this.clients.delete(ws);
    });
  }

  private processClientMessage(msg: InkSyncAction, senderWs: WebSocket): void {
    switch (msg.type) {
      case 'ink:stroke-start':
        this.inkStore.startStroke(msg.stroke);
        this.emit('ink:stroke-start', msg.stroke);
        this.broadcast(msg, senderWs);
        break;

      case 'ink:stroke-update':
        this.inkStore.appendPoints(msg.id, msg.points);
        this.emit('ink:stroke-update', msg.id, msg.points);
        this.broadcast(msg, senderWs);
        break;

      case 'ink:stroke-end':
        this.inkStore.endStroke(msg.id);
        this.emit('ink:stroke-end', msg.id);
        this.broadcast(msg, senderWs);
        break;

      case 'ink:undo':
        this.inkStore.undo(msg.slideIndex);
        this.emit('ink:undo', msg.slideIndex);
        this.broadcast(msg, senderWs);
        break;

      case 'ink:clear':
        this.inkStore.clearSlide(msg.slideIndex);
        this.emit('ink:clear', msg.slideIndex);
        this.broadcast(msg, senderWs);
        break;

      case 'ink:sync-slide':
        this.inkStore.setSlideStrokes(msg.slideIndex, msg.strokes);
        this.emit('ink:sync-slide', msg.slideIndex, msg.strokes);
        this.broadcast(msg, senderWs);
        break;

      case 'slide:navigate':
        this.emit('slide:navigate', msg.target);
        break;

      default:
        break;
    }
  }

  /**
   * Broadcast message to all connected tablet WebSocket clients except sender
   */
  public broadcast(action: InkSyncAction, senderWs?: WebSocket): void {
    const raw = JSON.stringify(action);
    for (const client of this.clients) {
      if (client !== senderWs && client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  /**
   * Called by Electron main process when slide state changes
   */
  public updateSlideState(state: any): void {
    this.latestState = state;
    if (!state) return;

    const currentIndex = state.currentIndex ?? 0;
    const strokes = this.inkStore.getStrokes(currentIndex);

    // Broadcast state update to all tablets
    this.broadcast({
      type: 'slide:state',
      state
    });

    // Also sync the strokes for this slide to all tablets
    this.broadcast({
      type: 'ink:sync-slide',
      slideIndex: currentIndex,
      strokes
    });
  }

  /**
   * Called when ink is drawn or cleared on host (Presenter View or Presentation Window)
   */
  public broadcastHostInkAction(action: InkSyncAction): void {
    // Update local store if needed
    if (action.type === 'ink:stroke-start') {
      this.inkStore.startStroke(action.stroke);
    } else if (action.type === 'ink:stroke-update') {
      this.inkStore.appendPoints(action.id, action.points);
    } else if (action.type === 'ink:stroke-end') {
      this.inkStore.endStroke(action.id);
    } else if (action.type === 'ink:undo') {
      this.inkStore.undo(action.slideIndex);
    } else if (action.type === 'ink:clear') {
      this.inkStore.clearSlide(action.slideIndex);
    } else if (action.type === 'ink:sync-slide') {
      this.inkStore.setSlideStrokes(action.slideIndex, action.strokes);
    }

    // Broadcast to all tablet clients
    this.broadcast(action);
  }
}

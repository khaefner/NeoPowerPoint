import { protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { DeckService } from './deck-service';

export function registerCustomProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'neopres',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true
      }
    }
  ]);
}

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
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export function setupCustomProtocolHandler(deckService: DeckService): void {
  protocol.handle('neopres', async (request) => {
    try {
      const url = new URL(request.url);

      // Handle internal app UI files (e.g. neopres://app/renderer/index.html)
      if (
        url.pathname.startsWith('/renderer/') ||
        url.pathname.startsWith('/presenter/') ||
        url.pathname.startsWith('/preload/')
      ) {
        let relPath = decodeURIComponent(url.pathname);
        if (relPath.startsWith('/')) relPath = relPath.slice(1);
        const filePath = path.normalize(path.join(__dirname, '../', relPath));
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const fileBuffer = await fs.promises.readFile(filePath);
          return new Response(fileBuffer, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            }
          });
        }
        return new Response('App file not found', { status: 404 });
      }

      const activeDeckPath = deckService.getActiveDeckPath();
      if (!activeDeckPath) {
        return new Response('No active presentation loaded', { status: 404 });
      }

      // e.g. neopres://app/slides/01-welcome/index.html or neopres://deck/slides/01-welcome/index.html
      let relPath = decodeURIComponent(url.pathname);
      if (relPath.startsWith('/')) {
        relPath = relPath.slice(1);
      }
      if (relPath.startsWith('deck/')) {
        relPath = relPath.slice(5);
      }

      const filePath = path.normalize(path.join(activeDeckPath, relPath));

      // Security check: ensure filePath is within activeDeckPath
      if (!filePath.startsWith(path.normalize(activeDeckPath))) {
        return new Response('Access denied: path traversal', { status: 403 });
      }

      if (!fs.existsSync(filePath)) {
        return new Response(`File not found: ${relPath}`, { status: 404 });
      }

      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        const indexPath = path.join(filePath, 'index.html');
        if (fs.existsSync(indexPath)) {
          return net.fetch(pathToFileURL(indexPath).toString());
        }
        return new Response('Directory listing forbidden', { status: 403 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const fileBuffer = await fs.promises.readFile(filePath);

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        }
      });
    } catch (err: any) {
      console.error('Error handling neopres protocol:', err);
      return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
    }
  });
}

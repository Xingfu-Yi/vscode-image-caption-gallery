import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { isCameraRaw } from './imageFormats';
import { PreviewService } from './previewService';

export interface BrowserImage { id: string; name: string; relativePath: string }
interface Source { filePath: string; mtime: number; size: number }
interface Request { owner: string; index: number; controller: AbortController }
interface Session { images: BrowserImage[]; index: number; resolution: number; language: string; lastActivity: number; sequence: number; client: string; requests: Set<Request> }
const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };
const pixelBytes = 64 * 1024 * 1024;

/** Capability URLs served through the same private SSH forward as videos.
 * Browser blobs own their bytes after transfer; disk leases only need to protect
 * the preview while it is being generated and streamed. No captions are read. */
export class BrowserImages {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly assets = new Map<string, Promise<Buffer>>();
  constructor(private readonly previews: PreviewService, private readonly source: (id: string) => Promise<Source>) {
    this.timer = setInterval(() => this.expire(), 60_000); this.timer.unref();
  }
  create(images: BrowserImage[], selected: string, resolution: number, language: string): string {
    const index = images.findIndex(image => image.id === selected);
    if (index < 0) { throw new Error('The selected image is no longer in this gallery.'); }
    // Limit abandoned tabs without tying active playback to a Gallery panel.
    this.expire();
    if (this.sessions.size >= 32) { throw new Error('Too many browser image sessions. Inactive sessions expire after 30 minutes.'); }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { images: images.map(({ id, name, relativePath }) => ({ id, name, relativePath })), index,
      resolution: Number.isSafeInteger(resolution) && resolution >= 0 && resolution <= 65536 ? resolution : 2048,
      language: language.startsWith('zh') ? 'zh' : 'en', lastActivity: Date.now(), sequence: -1, client: '', requests: new Set() });
    return token;
  }
  release(token: string): void {
    const session = this.sessions.get(token); this.sessions.delete(token);
    for (const request of session?.requests ?? []) { request.controller.abort(); this.previews.release(request.owner); }
  }
  expire(): void { for (const [token, session] of this.sessions) { if (Date.now() - session.lastActivity > 30 * 60_000) { this.release(token); } } }
  dispose(): void { clearInterval(this.timer); for (const token of this.sessions.keys()) { this.release(token); } }
  private async version(session: Session, index: number): Promise<object> {
    const image = session.images[index];
    try {
      const stat = await this.source(image.id);
      return { index, name: image.name, relativePath: image.relativePath,
        version: createHash('sha256').update(JSON.stringify([image.id, stat.mtime, stat.size, session.resolution])).digest('hex') };
    } catch { return { index, name: image.name, relativePath: image.relativePath, version: 'missing' }; }
  }
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/images/')) { return false; }
    const match = /^\/images\/([a-f0-9]{64})\/(viewer|viewer\.js|viewer\.css|state|heartbeat|image\/(\d+))$/.exec(url.pathname);
    const session = match && this.sessions.get(match[1]);
    if (!session) { res.writeHead(404); res.end(); return true; }
    session.lastActivity = Date.now();
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const route = match![2];
    if (route === 'heartbeat' && req.method === 'POST') { res.writeHead(204); res.end(); return true; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return true; }
    try {
      if (route === 'viewer') {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('X-Frame-Options', 'DENY');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(browserImagesHtml(url.search)); return true;
      }
      if (route === 'viewer.js' || route === 'viewer.css') {
        let bytes = this.assets.get(route);
        if (!bytes) { bytes = fs.readFile(path.join(__dirname, '..', 'media', route === 'viewer.js' ? 'browserImages.js' : 'browserImages.css')); this.assets.set(route, bytes); void bytes.catch(() => this.assets.delete(route)); }
        res.writeHead(200, { 'Content-Type': route === 'viewer.js' ? 'text/javascript' : 'text/css' }); res.end(await bytes); return true;
      }
      const index = route === 'state' ? (url.searchParams.has('index') ? Number(url.searchParams.get('index')) : session.index) : Number(match![3]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= session.images.length) { res.writeHead(400); res.end('Invalid image index.'); return true; }
      if (route === 'state') {
        const client = url.searchParams.get('view') ?? '';
        // A reloaded page starts a fresh request sequence while keeping its last
        // cursor. Late requests from the previous page cannot steal it back.
        if (!url.searchParams.has('index') && client !== session.client) { session.client = client; session.sequence = -1; }
        if (client !== session.client) { res.writeHead(409); res.end('Viewer opened in another page.'); return true; }
        const sequence = Number(url.searchParams.get('sequence') ?? 0);
        if (Number.isSafeInteger(sequence) && sequence >= session.sequence) {
          session.sequence = sequence; session.index = index;
          for (const request of session.requests) { if (request.index === index) { this.previews.promote(request.owner); } }
        }
        const indices = [index - 1, index, index + 1].filter(i => i >= 0 && i < session.images.length);
        const images = await Promise.all(indices.map(i => this.version(session, i)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ index, total: session.images.length, language: session.language, resolution: session.resolution, images })); return true;
      }
      const controller = new AbortController(), owner = `browser-images/${match![1]}/${randomBytes(12).toString('hex')}`;
      const request: Request = { controller, owner, index }; session.requests.add(request);
      const finished = (): void => { controller.abort(); this.previews.release(owner); session.requests.delete(request); };
      res.once('close', finished);
      try {
        const image = session.images[index], prefetch = url.searchParams.get('prefetch') === '1';
        const source = await this.source(image.id);
        let file = source.filePath, contentType = mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        if (session.resolution > 0 || isCameraRaw(image.id) || prefetch) {
          const preview = await this.previews.get(image.id, session.resolution, owner, !prefetch, controller.signal);
          if (prefetch && preview.width * preview.height * 4 * (preview.frameCount ?? 1) > pixelBytes) { res.writeHead(204); res.end(); return true; }
          if (preview.filePath) { file = preview.filePath; contentType = 'image/webp'; }
          res.setHeader('X-Image-Frames', String(preview.frameCount ?? 1));
        }
        if (controller.signal.aborted) { return true; }
        const stat = await fs.stat(file);
        if (controller.signal.aborted) { return true; }
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(file);
          const stop = (): void => { stream.destroy(); resolve(); };
          controller.signal.addEventListener('abort', stop, { once: true });
          stream.on('error', reject); stream.on('end', resolve); stream.pipe(res);
          stream.on('close', () => controller.signal.removeEventListener('abort', stop));
        });
      } finally { finished(); res.removeListener('close', finished); }
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error instanceof Error ? error.message : String(error)); }
        else { res.destroy(); }
      }
    }
    return true;
  }
}
export function browserImagesHtml(search: string): string {
  const query = search.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery Images</title><link rel="stylesheet" href="viewer.css${query}"><script defer src="viewer.js${query}"></script></head><body><main id="viewer" tabindex="-1"><div id="stage"></div><header id="controls"><span id="title"></span><span id="position"></span><button id="fullscreen" type="button">View full screen · F</button></header><button id="previous" class="navigation previous" type="button" aria-label="Previous image (←)">‹</button><button id="next" class="navigation next" type="button" aria-label="Next image (→)">›</button><div id="feedback" role="status" aria-live="polite"><span id="status"></span><button id="retry" type="button" hidden>Retry</button></div></main></body></html>`;
}

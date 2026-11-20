import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import type { BrowserPlaybackState } from './browserPlayer';
import type { PreviewService } from './previewService';
import type { VideoService } from './videoService';

export interface GalleryRecord { id: string; name: string; relativePath: string; kind: 'image' | 'video' }
export interface GalleryLink { token: string; index: number }
export interface BrowserGallerySettings { resolution: number; videoMaxHeight: number; ffmpegPath: string; search?: string }
interface Source { filePath: string; mtime: number; size: number }
interface OpenResult { path: string; release?: () => void }
interface BrowserGalleryOptions {
  previews: PreviewService;
  videos: VideoService;
  source: (id: string) => Promise<Source>;
  filePath: (id: string) => string;
  open: (record: GalleryRecord, records: GalleryRecord[], gallery: GalleryLink, settings: BrowserGallerySettings, input?: Partial<BrowserPlaybackState>) => Promise<OpenResult>;
}
interface Request { owner: string; controller: AbortController; kind: 'image' | 'video' }
interface Session {
  records: GalleryRecord[];
  byId: Map<string, number>;
  selected: number;
  settings: BrowserGallerySettings;
  language: 'en' | 'zh';
  lastActivity: number;
  requests: Set<Request>;
  child?: () => void;
  openSequence: number;
  initialSearch: string;
}

const maxSessions = 32;
const sessionLifetime = 30 * 60_000;
const tokenPattern = '[a-f0-9]{64}';

/** Private, capability-scoped browser grid. Listing is metadata-only; previews
 * are generated only for individual visible-card requests from the client. */
export class BrowserGallery {
  private readonly sessions = new Map<string, Session>();
  private readonly assets = new Map<string, Promise<Buffer>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: BrowserGalleryOptions) {
    this.timer = setInterval(() => this.expire(), 60_000);
    this.timer.unref();
  }

  create(records: GalleryRecord[], selected: string, settings: BrowserGallerySettings, language: string): string {
    this.expire();
    if (this.sessions.size >= maxSessions) { throw new Error('Too many browser Gallery sessions. Inactive sessions expire after 30 minutes.'); }
    const clean = records.map(record => ({ id: record.id, name: record.name, relativePath: record.relativePath, kind: record.kind }));
    const byId = new Map(clean.map((record, index) => [record.id, index]));
    const index = byId.get(selected);
    if (index === undefined) { throw new Error('The selected file is no longer in this Gallery.'); }
    const resolution = Number.isSafeInteger(settings.resolution) && settings.resolution >= 0 && settings.resolution <= 65536 ? settings.resolution : 2048;
    const videoMaxHeight = [0, 720, 1080, 1440].includes(settings.videoMaxHeight) ? settings.videoMaxHeight : 1440;
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { records: clean, byId, selected: index, settings: { resolution, videoMaxHeight, ffmpegPath: settings.ffmpegPath, search: settings.search },
      language: language.startsWith('zh') ? 'zh' : 'en', lastActivity: Date.now(), requests: new Set(), openSequence: 0, initialSearch: (settings.search ?? '').slice(0, 4096) });
    return token;
  }

  link(token: string, id: string): GalleryLink | undefined {
    const session = this.sessions.get(token), index = session?.byId.get(id);
    if (!session || index === undefined) { return undefined; }
    session.lastActivity = Date.now();
    return { token, index };
  }

  touch(link: GalleryLink | undefined): void {
    if (!link) { return; }
    const session = this.sessions.get(link.token);
    if (session && Number.isSafeInteger(link.index) && link.index >= 0 && link.index < session.records.length) { session.lastActivity = Date.now(); }
  }

  release(token: string): void {
    const session = this.sessions.get(token);
    if (!session) { return; }
    this.sessions.delete(token); session.openSequence++;
    for (const request of session.requests) {
      request.controller.abort();
      if (request.kind === 'image') { this.options.previews.release(request.owner); }
      else { this.options.videos.release(request.owner); }
    }
    session.requests.clear(); session.child?.(); session.child = undefined;
  }

  expire(now = Date.now()): void {
    for (const [token, session] of this.sessions) { if (now - session.lastActivity > sessionLifetime) { this.release(token); } }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const token of [...this.sessions.keys()]) { this.release(token); }
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/gallery/')) { return false; }
    const match = new RegExp(`^/gallery/(${tokenPattern})/(viewer|gallery\\.js|gallery\\.css|grid\\.js|file-menu\\.js|file-menu\\.css|list|thumbnail/(\\d+)|open/(\\d+)|heartbeat)$`).exec(url.pathname);
    const token = match?.[1], session = token ? this.sessions.get(token) : undefined;
    if (!match || !session) { res.writeHead(404); res.end(); return true; }
    session.lastActivity = Date.now();
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const route = match[2];
    try {
      if (route === 'heartbeat') {
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true; }
        res.writeHead(204); res.end(); return true;
      }
      if (route === 'open/' + match[4]) {
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true; }
        await this.open(req, res, token!, session, Number(match[4])); return true;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
      if (route === 'viewer') {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('X-Frame-Options', 'DENY');
        const bytes = Buffer.from(browserGalleryHtml(url.search));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
      }
      const assetFiles: Record<string, string> = { 'gallery.js': 'browserGallery.js', 'gallery.css': 'browserGallery.css', 'grid.js': 'galleryGrid.js', 'file-menu.js': 'fileContextMenu.js', 'file-menu.css': 'fileContextMenu.css' };
      if (assetFiles[route]) {
        let bytes = this.assets.get(route);
        if (!bytes) { bytes = fs.readFile(path.join(__dirname, '..', 'media', assetFiles[route])); this.assets.set(route, bytes); void bytes.catch(() => this.assets.delete(route)); }
        const output = await bytes;
        res.writeHead(200, { 'Content-Type': route.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Content-Length': output.length });
        res.end(req.method === 'HEAD' ? undefined : output); return true;
      }
      if (route === 'list') { this.list(req, res, session, url); return true; }
      if (route === 'thumbnail/' + match[3]) { await this.thumbnail(req, res, session, Number(match[3])); return true; }
      res.writeHead(404); res.end();
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); }
        res.end(error instanceof Error ? error.message : String(error));
      }
    }
    return true;
  }

  private list(req: http.IncomingMessage, res: http.ServerResponse, session: Session, url: URL): void {
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    const limit = Math.max(1, Math.min(512, Number(url.searchParams.get('limit') ?? 256)));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) { res.writeHead(400); res.end('Invalid page.'); return; }
    const query = (url.searchParams.get('q') ?? '').slice(0, 4096).trim().toLocaleLowerCase();
    const matches: number[] = [];
    for (let index = 0; index < session.records.length; index++) {
      if (!query || session.records[index].relativePath.toLocaleLowerCase().includes(query)) { matches.push(index); }
    }
    const items = matches.slice(offset, offset + limit).map(index => {
      const record = session.records[index];
      let filePath = '';
      try { filePath = this.options.filePath(record.id); } catch { /* A stale record is reported when opened. */ }
      return { ...record, index, filePath };
    });
    const body = Buffer.from(JSON.stringify({ items, total: matches.length, selected: session.selected, language: session.language, query: session.initialSearch }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length }); res.end(req.method === 'HEAD' ? undefined : body);
  }

  private async thumbnail(req: http.IncomingMessage, res: http.ServerResponse, session: Session, index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.records.length) { res.writeHead(400); res.end('Invalid file index.'); return; }
    const record = session.records[index], controller = new AbortController(), owner = `browser-gallery/${randomBytes(16).toString('hex')}`;
    const request: Request = { owner, controller, kind: record.kind }; session.requests.add(request);
    const finish = (): void => {
      controller.abort(); session.requests.delete(request);
      if (record.kind === 'image') { this.options.previews.release(owner); }
      else { this.options.videos.release(owner); }
    };
    res.once('close', finish);
    try {
      let file: string, contentType: string;
      if (record.kind === 'video') {
        const poster = await this.options.videos.posterPreview(record.id, owner, controller.signal, session.settings.ffmpegPath);
        file = poster.file; contentType = 'image/jpeg';
      } else {
        const resolution = session.settings.resolution > 0 ? Math.min(512, session.settings.resolution) : 512;
        const preview = await this.options.previews.get(record.id, resolution, owner, false, controller.signal, true);
        if (!preview.filePath) { throw new Error('Could not create thumbnail.'); }
        file = preview.filePath; contentType = 'image/webp';
      }
      if (controller.signal.aborted) { return; }
      const stat = await fs.stat(file); if (controller.signal.aborted) { return; }
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
      if (req.method === 'HEAD') { res.end(); return; }
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(file); const stop = (): void => { stream.destroy(); resolve(); };
        controller.signal.addEventListener('abort', stop, { once: true });
        stream.on('error', reject); stream.on('end', resolve); stream.on('close', () => controller.signal.removeEventListener('abort', stop)); stream.pipe(res);
      });
    } finally { finish(); res.removeListener('close', finish); }
  }

  private async open(req: http.IncomingMessage, res: http.ServerResponse, token: string, session: Session, index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.records.length) { res.writeHead(400); res.end('Invalid file index.'); return; }
    let body = '';
    for await (const chunk of req) { body += Buffer.from(chunk).toString('utf8'); if (Buffer.byteLength(body) > 4096) { res.writeHead(413); res.end('Request is too large.'); return; } }
    let input: Partial<BrowserPlaybackState> | undefined;
    if (body.trim()) { try { input = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid playback state.'); return; } }
    const sequence = ++session.openSequence, record = session.records[index], link = { token, index };
    const result = await this.options.open(record, session.records, link, session.settings, input);
    if (this.sessions.get(token) !== session || session.openSequence !== sequence) { result.release?.(); res.writeHead(404); res.end(); return; }
    const previous = session.child; session.child = result.release; session.selected = index; session.lastActivity = Date.now(); previous?.();
    const payload = Buffer.from(JSON.stringify({ path: result.path }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length }); res.end(payload);
  }
}

export function browserGalleryHtml(search: string): string {
  const query = search.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery</title><link rel="stylesheet" href="gallery.css${query}"><link rel="stylesheet" href="file-menu.css${query}"><script defer src="grid.js${query}"></script><script defer src="file-menu.js${query}"></script><script defer src="gallery.js${query}"></script></head><body><main id="browser-gallery" tabindex="-1"><header><strong>Gallery</strong><input id="gallery-search" type="search" autocomplete="off" placeholder="Search media…"><span id="gallery-count"></span><button id="gallery-fullscreen" type="button">Full screen · F</button></header><div id="gallery-status" role="status" aria-live="polite"></div><div id="gallery-viewport"><div id="gallery-grid"></div></div></main></body></html>`;
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import type { BrowserImages } from './browserImages';
import type { BrowserGallery, GalleryLink } from './browserGallery';
import { browserPlayerAsset, browserPlayerHtml, normalizePlaybackState, type BrowserPlaybackState } from './browserPlayer';
import { readVideoOrientation, videoOrientationFilter, type AbsoluteVideoOrientation } from './videoOrientation';

export interface VideoSource { filePath: string; mtime: number; size: number }
export interface VideoSettings { mode: 'auto' | 'native'; ffmpegPath: string; maxHeight?: number; target?: 'webview' | 'browser' }
export interface PreparedVideo {
  converted: boolean; note?: string; token: string; duration?: number; width?: number; height?: number; previewWidth?: number; previewHeight?: number;
  stream?: { mime: string; segmentSeconds: number; duration: number; format?: 'webm' | 'hls' };
}
interface Probe { streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; sample_aspect_ratio?: string; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } }>; format?: { duration?: string } }
interface Tools { ffmpeg: string; ffprobe: string; encoders: Set<string> }
interface BrowserSession { owner: string; id: string; title: string; state: BrowserPlaybackState; lastActivity: number; request?: AbortController; gallery?: GalleryLink }
interface Session { browser?: BrowserSession; browserParent?: string; token: string; source: VideoSource; version: string; settings: VideoSettings; info: PreparedVideo; tools?: Tools; controller: AbortController; orientation?: AbsoluteVideoOrientation }
interface Artifact { file: string; bytes: Buffer; cacheHit: boolean; queueMs: number; processMs: number; cacheMs: number }
export interface VideoPosterPreview { file: string; source: string; timing: { totalMs: number; queueMs: number; processMs: number; cacheMs: number; bytes: number; cacheHit: boolean } }
interface Entry { file: string; size: number; refs: number }
interface Job { poster: boolean; key: string; priority: number; controller: AbortController; waiters: Set<symbol>; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void; run: (signal: AbortSignal) => Promise<unknown> }
interface Options { maxBytes?: number; timeoutMs?: number; maxJobs?: number; maxPosterJobs?: number }
const cancelled = (): Error => Object.assign(new Error('Video request cancelled.'), { name: 'AbortError' });
const nativeContainers = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segmentSeconds = 4;
// FFmpeg otherwise creates a decoder thread per logical CPU. Two simultaneous
// clips can oversubscribe large SSH hosts before the bounded encoder is reached.
const decoderThreads = Math.min(4, Math.max(1, availableParallelism()));
const playableH264 = (video: NonNullable<Probe['streams']>[number] | undefined): boolean => video?.codec_name === 'h264' && (!video.pix_fmt || ['yuv420p', 'yuvj420p'].includes(video.pix_fmt));
export function needsVideoConversion(filename: string, probe: Probe, browser = false): boolean {
  const video = probe.streams?.find((s) => s.codec_type === 'video'), audio = probe.streams?.find((s) => s.codec_type === 'audio');
  if (path.extname(filename).toLowerCase() === '.webm') {
    // Chromium does not consistently apply Matroska projection/display roll.
    // Compatibility segments bake this metadata into their pixels exactly once.
    const rotation = Number(video?.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
    return !Number.isFinite(rotation) || rotation % 360 !== 0 || !['vp8', 'vp9'].includes(video?.codec_name ?? '') || Boolean(audio && !['opus', 'vorbis'].includes(audio.codec_name ?? ''));
  }
  return !(browser ? ['.mp4', '.m4v', '.mov'] : ['.mp4', '.m4v']).includes(path.extname(filename).toLowerCase()) || !playableH264(video) || Boolean(audio && !(browser ? ['aac', 'mp3'] : ['mp3']).includes(audio.codec_name ?? '')); 
}

// "p" denotes the short edge: landscape and portrait use the same quality budget.
// Never enlarge the source; even dimensions are required by the VP8 encoder.
export function videoPreviewDimensions(width: number, height: number, maxHeight = 1440): { width: number; height: number } {
  const ratio = maxHeight > 0 ? Math.min(1, maxHeight / Math.min(width, height), (maxHeight * 16 / 9) / Math.max(width, height)) : 1;
  return { width: Math.max(2, Math.floor(width * ratio / 2) * 2), height: Math.max(2, Math.floor(height * ratio / 2) * 2) };
}
export function normalizeVideoQuality(value: unknown): number {
  if (value === 480) { return 720; } // Migrate the previous quality choices.
  if (value === 2160) { return 1440; }
  return typeof value === 'number' && [0, 720, 1080, 1440].includes(value) ? value : 1440;
}

/** Private loopback media endpoint. Original bytes use Range; incompatible files
 * produce only the requested four-second WebM segment, never a whole-file copy. */
export class VideoService {
  private readonly sessions = new Map<string, Session>();
  private readonly ownerTokens = new Map<string, string>();
  private readonly posterLeases = new Map<string, Entry>();
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly toolsController = new AbortController();
  private readonly toolCache = new Map<string, Promise<Tools>>();
  private readonly metadata = new Map<string, Probe>();
  private readonly ownerCleanups = new Map<string, () => void>();
  private readonly ownerControllers = new Map<string, AbortController>();
  private readonly initialized: Promise<void>;
  private server?: http.Server;
  private listening?: Promise<string>;
  private disposed = false;
  private browserTimer?: ReturnType<typeof setInterval>;
  private bytes = 0;
  private pruning = Promise.resolve();
  readonly stats = { segmentRequests: 0, segments: 0, posters: 0, posterCacheHits: 0, posterFailures: 0, rangeRequests: 0, rangeBytes: 0 };
  constructor(readonly directory: string, private readonly source: (id: string) => Promise<VideoSource>, private readonly options: Options = {}) {
    this.initialized = this.restore(); void this.initialized.catch(() => {});
  }

  private imageBrowser?: BrowserImages;
  attachImageBrowser(browser: BrowserImages): void { this.imageBrowser = browser; }
  private gallery?: BrowserGallery;
  attachGallery(gallery: BrowserGallery): void { this.gallery = gallery; }

  startServer(): Promise<string> {
    if (this.disposed) { return Promise.reject(cancelled()); }
    if (this.listening) { return this.listening; }
    this.listening = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { void this.handle(req, res); }); this.server = server;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        if (this.disposed) { server.close(); reject(cancelled()); return; }
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not start private video stream.')); return; }
        server.unref(); resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return this.listening;
  }

  async get(id: string, owner: string, signal: AbortSignal, settings: VideoSettings, force = false): Promise<PreparedVideo> {
    settings = { ...settings, maxHeight: normalizeVideoQuality(settings.maxHeight) };
    this.release(owner);
    const controller = new AbortController(); this.ownerControllers.set(owner, controller);
    const abort = (): void => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    this.ownerCleanups.set(owner, () => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); }
    try {
      const source = await this.source(id);
      const version = await this.sourceVersion(source);
      if (this.disposed || controller.signal.aborted) { throw cancelled(); }
      const info: PreparedVideo = { token: randomBytes(32).toString('hex'), converted: false };
      let tools: Tools | undefined;
      let orientation: AbsoluteVideoOrientation | undefined;
      if (settings.mode !== 'native' || force) {
        orientation = await readVideoOrientation(source);
        try {
          tools = await this.tools(settings.ffmpegPath, settings.target === 'browser');
          const key = hash([source.filePath, source.mtime, source.size, version, tools.ffprobe]);
          let probe = this.metadata.get(key);
          if (!probe) {
            probe = await this.job<Probe>(`probe-${key}`, 3, controller.signal, async (stop) => JSON.parse((await this.run(tools!.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,sample_aspect_ratio:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', source.filePath], stop, 1024 * 1024, 15_000)).toString()));
            this.metadata.set(key, probe);
            if (this.metadata.size > 1000) { this.metadata.delete(this.metadata.keys().next().value!); }
          }
          const video = probe.streams?.find((s) => s.codec_type === 'video');
          if (!video) { throw new Error('This file contains no video stream.'); }
          const sar = (video.sample_aspect_ratio || '1:1').split(':').map(Number);
          const displayWidth = Math.round((video.width || 0) * (sar[0] > 0 && sar[1] > 0 ? sar[0] / sar[1] : 1));
          const rotation = orientation ? { none: 0, cw90: 90, ccw90: -90, '180': 180 }[orientation.rotation] : Number(video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
          const rotated = Math.abs(rotation % 180) === 90;
          info.duration = Number(probe.format?.duration); info.width = rotated ? video.height : displayWidth; info.height = rotated ? displayWidth : video.height;
          if (!info.width || !info.height) { throw new Error('Could not determine video dimensions. Try original playback.'); }
          const dimensions = videoPreviewDimensions(info.width, info.height, settings.maxHeight);
          const cap = settings.maxHeight!;
          const downscale = cap > 0 && (Math.min(info.width, info.height) > cap || Math.max(info.width, info.height) > cap * 16 / 9);
          info.previewWidth = info.width; info.previewHeight = info.height;
          if (force || orientation || downscale || needsVideoConversion(source.filePath, probe, settings.target === 'browser')) {
            const browser = settings.target === 'browser';
            if (!tools.encoders.has(browser ? 'libx264' : 'libvpx')) { throw new Error(`On-demand playback needs FFmpeg with ${browser ? 'libx264 (H.264)' : 'libvpx (VP8)'}. Try original playback or select another FFmpeg in Settings.`); }
            const audio = probe.streams?.find((s) => s.codec_type === 'audio');
            // Native Vorbis can mux blocks out of order, which Chromium rejects
            // even when ffprobe decodes them. Use the stable libvorbis encoder.
            const audioCodec = !audio ? '' : browser ? tools.encoders.has('aac') ? 'aac' : '' : tools.encoders.has('libvorbis') ? 'vorbis' : '';
            if (audio && !audioCodec) { throw new Error(`On-demand audio needs ${browser ? 'AAC' : 'libvorbis (Vorbis)'} support in FFmpeg. Set a compatible FFmpeg path in Settings.`); }
            if (!Number.isFinite(info.duration) || !info.duration || info.duration <= 0) { throw new Error('Could not determine video duration for seekable compatibility playback. Try native playback.'); }
            info.converted = true; info.previewWidth = dimensions.width; info.previewHeight = dimensions.height;
            info.stream = { mime: browser ? `video/mp2t; codecs="avc1.42E01E${audioCodec ? ',mp4a.40.2' : ''}"` : `video/webm; codecs="vp8${audioCodec ? `,${audioCodec}` : ''}"`, segmentSeconds, duration: info.duration, ...(browser ? { format: 'hls' as const } : {}) };
          }
        } catch (error) {
          if (controller.signal.aborted) { throw cancelled(); }
          if (force || orientation || !nativeContainers.has(path.extname(source.filePath).toLowerCase()) || !((error as NodeJS.ErrnoException).code === 'ENOENT')) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw new Error('FFmpeg or ffprobe is unavailable on the extension host. Install both tools or set the FFmpeg path in Settings.'); }
            throw error;
          }
          info.note = 'FFmpeg/ffprobe unavailable; trying the original video. Audio may require a compatible FFmpeg build.';
        }
      }
      if (this.disposed || controller.signal.aborted) { throw cancelled(); }
      const session: Session = { token: info.token, source, version, settings, info, tools, controller, orientation };
      this.sessions.set(info.token, session); this.ownerTokens.set(owner, info.token);
      return info;
    } catch (error) { if (this.ownerControllers.get(owner) === controller) { this.release(owner); } throw error; }

  }

  /** Browser sessions have independent leases; closing Gallery must not stop them. */
  async createBrowserPlayer(id: string, title: string, settings: VideoSettings, input: Partial<BrowserPlaybackState>, gallery?: GalleryLink): Promise<string> {
    const owner = `browser-${randomUUID()}`, state = normalizePlaybackState(input);
    const info = await this.get(id, owner, new AbortController().signal, { ...settings, mode: 'auto', target: 'browser', maxHeight: state.quality });
    const session = this.sessions.get(info.token)!;
    session.browser = { owner, id, title, state, lastActivity: Date.now(), gallery };
    if (!this.browserTimer) {
      this.browserTimer = setInterval(() => this.expireBrowserSessions(), 30000); this.browserTimer.unref();
    }
    return info.token;
  }

  private expireBrowserSessions(now = Date.now()): void {
    for (const active of this.sessions.values()) { if (active.browser && now - active.browser.lastActivity > 30 * 60 * 1000) { this.release(active.browser.owner); } }
  }

  releaseBrowser(token: string): void { const session = this.sessions.get(token); if (session?.browser) { this.release(session.browser.owner); } }

  private async browserState(session: Session, url: URL): Promise<unknown> {
    const browser = session.browser!;
    browser.request?.abort(); const controller = new AbortController(); browser.request = controller;
    const stop = (): void => controller.abort(); session.controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const quality = normalizeVideoQuality(url.searchParams.has('quality') ? Number(url.searchParams.get('quality')) : browser.state.quality);
      const video = await this.get(browser.id, `${browser.owner}/stream`, controller.signal, { ...session.settings, mode: url.searchParams.get('native') === '1' ? 'native' : 'auto', target: 'browser', maxHeight: quality }, url.searchParams.get('compatible') === '1');
      if (controller.signal.aborted) { throw cancelled(); }
      this.sessions.get(video.token)!.browserParent = session.token;
      const gallery = browser.gallery && (this.gallery ? this.gallery.link(browser.gallery.token, browser.id) : browser.gallery);
      return { title: browser.title, filePath: session.source.filePath, state: { ...browser.state, quality }, video, gallery };
    } finally { session.controller.signal.removeEventListener('abort', stop); }
  }

  private manifest(session: Session, search: string): string {
    const duration = session.info.stream!.duration, lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (let index = 0; index * segmentSeconds < duration; index++) {
      // Independently encoded clips restart timestamps. HLS discontinuities make
      // the demuxer map each clip onto its declared position in the VOD timeline.
      if (index) { lines.push('#EXT-X-DISCONTINUITY'); }
      lines.push(`#EXTINF:${Math.min(segmentSeconds, duration - index * segmentSeconds).toFixed(6)},`, `segment/${index}.ts${search}`);
    }
    lines.push('#EXT-X-ENDLIST'); return lines.join('\n') + '\n';
  }

  async poster(id: string, owner: string, signal: AbortSignal, executable: string): Promise<string> {
    return (await this.posterPreview(id, owner, signal, executable)).file;
  }

  async posterPreview(id: string, owner: string, signal: AbortSignal, executable: string): Promise<VideoPosterPreview> {
    const started = performance.now(); this.release(owner);
    const controller = new AbortController(); this.ownerControllers.set(owner, controller);
    const stop = (): void => controller.abort(); signal.addEventListener('abort', stop, { once: true }); this.ownerCleanups.set(owner, () => signal.removeEventListener('abort', stop)); if (signal.aborted) { stop(); }
    try {
      const source = await this.source(id);
      const result = await this.posterBytes(source, executable, controller.signal, owner);
      if (controller.signal.aborted || this.disposed) { throw cancelled(); }
      if (result.cacheHit) { this.stats.posterCacheHits++; }
      return { file: result.file, source: `data:image/jpeg;base64,${result.bytes.toString('base64')}`,
        timing: { totalMs: performance.now() - started, queueMs: result.queueMs, processMs: result.processMs, cacheMs: result.cacheMs, bytes: result.bytes.length, cacheHit: result.cacheHit } };
    } catch (error) {
      if (!controller.signal.aborted) { this.stats.posterFailures++; }
      if (this.ownerControllers.get(owner) === controller) { this.release(owner); }
      throw error;
    }
  }

  private leasePoster(owner: string, entry: Entry): void {
    const previous = this.posterLeases.get(owner); if (previous === entry) { return; }
    if (previous) { previous.refs--; } entry.refs++; this.posterLeases.set(owner, entry);
  }

  release(owner: string): void {
    const poster = this.posterLeases.get(owner); if (poster) { poster.refs--; this.posterLeases.delete(owner); this.prune(); }
    this.ownerCleanups.get(owner)?.(); this.ownerCleanups.delete(owner);
    this.ownerControllers.get(owner)?.abort(); this.ownerControllers.delete(owner);
    const token = this.ownerTokens.get(owner); if (token) {
      const browser = this.sessions.get(token)?.browser;
      if (browser) { browser.request?.abort(); this.release(`${browser.owner}/stream`); }
      this.sessions.delete(token); this.ownerTokens.delete(owner);
    }
  }
  dispose(): void {
    this.disposed = true; clearInterval(this.browserTimer); this.toolsController.abort();
    for (const controller of this.ownerControllers.values()) { controller.abort(); }
    for (const cleanup of this.ownerCleanups.values()) { cleanup(); } this.ownerCleanups.clear();
    this.ownerControllers.clear(); this.sessions.clear(); this.ownerTokens.clear();
    for (const entry of this.posterLeases.values()) { entry.refs--; } this.posterLeases.clear(); this.prune();
    for (const job of this.running) { job.controller.abort(); }
    for (const job of this.queue.splice(0)) { job.controller.abort(); job.reject(cancelled()); }
    this.server?.closeAllConnections(); this.server?.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.gallery && await this.gallery.handle(req, res)) { return; }
    if (this.imageBrowser && await this.imageBrowser.handle(req, res)) { return; }
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/v1\/([a-f0-9]{64})\/(original|poster|player|player\.js|player\.css|hls\.js|file-menu\.js|file-menu\.css|state|heartbeat|manifest\.m3u8|segment\/(\d+)\.(webm|ts))$/.exec(url.pathname);
    const session = match ? this.sessions.get(match[1]) : undefined;
    if (!session || session.controller.signal.aborted) { res.writeHead(404); res.end(); return; }
    const parent = session.browser ? session : session.browserParent ? this.sessions.get(session.browserParent) : undefined;
    if (parent?.browser) { parent.browser.lastActivity = Date.now(); this.gallery?.touch(parent.browser.gallery); }
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Server-Timing');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (match![2] === 'heartbeat' && req.method === 'POST' && session.browser) { res.writeHead(204); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); if (!res.writableEnded) { res.destroy(); } };
    session.controller.signal.addEventListener('abort', abort, { once: true });
    res.once('close', () => { controller.abort(); session.controller.signal.removeEventListener('abort', abort); });
    try {
      const route = match![2];
      if (['player', 'player.js', 'player.css', 'hls.js', 'file-menu.js', 'file-menu.css', 'state'].includes(route)) {
        if (!session.browser) { res.writeHead(404); res.end(); return; }
        if (route === 'state') {
          const state = await this.browserState(session, url);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state)); return;
        }
        if (route === 'player') {
          res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
          res.setHeader('X-Frame-Options', 'DENY');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(browserPlayerHtml(url.search)); return;
        }
        const bytes = await browserPlayerAsset(route);
        res.writeHead(200, { 'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript', 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (route === 'manifest.m3u8') {
        if (session.info.stream?.format !== 'hls') { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(this.manifest(session, url.search)); return;
      }
      if (match![2] === 'original') { await this.original(req, res, session, controller.signal); return; }
      let artifact: Artifact;
      if (match![2] === 'poster') { artifact = await this.posterBytes(session.source, session.settings.ffmpegPath, controller.signal); }
      else {
        const index = Number(match![3]); const duration = session.info.stream?.duration ?? 0;
        if (!session.info.stream || !Number.isSafeInteger(index) || index < 0 || index * segmentSeconds >= duration) { res.writeHead(416); res.end(); return; }
        if (!session.tools) { session.tools = await this.tools(session.settings.ffmpegPath); }
        if ((match![4] === 'ts') !== (session.info.stream.format === 'hls')) { res.writeHead(404); res.end(); return; }
        this.stats.segmentRequests++;
        artifact = await this.segment(session, index, controller.signal);
      }
      if (controller.signal.aborted) { return; }
      // Keep host queue/encoding separate from the client's request duration.
      // Their difference includes the private tunnel, transfer and proxy delay.
      const duration = (milliseconds: number): string => Math.max(0, milliseconds).toFixed(2);
      res.setHeader('Server-Timing', `prepare;dur=${duration(performance.now() - started)}, queue;dur=${duration(artifact.queueMs)}, encode;dur=${duration(artifact.processMs)}, cache;dur=${duration(artifact.cacheMs)};desc="${artifact.cacheHit ? 'hit' : 'miss'}"`);
      res.writeHead(200, { 'Content-Type': match![2] === 'poster' ? 'image/jpeg' : session.info.stream?.format === 'hls' ? 'video/mp2t' : 'video/webm', 'Content-Length': artifact.bytes.length });
      res.end(req.method === 'HEAD' ? undefined : artifact.bytes);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) { return; }
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); }
      res.end(error instanceof Error ? error.message : 'Could not stream video.');
    }
  }

  private async original(req: http.IncomingMessage, res: http.ServerResponse, session: Session, signal: AbortSignal): Promise<void> {
    let version: string | undefined;
    try { version = await this.sourceVersion(session.source); } catch { /* Report a stale source below. */ }
    if (version !== session.version) { res.writeHead(409); res.end('The video changed. Reopen it to refresh.'); return; }
    const size = session.source.size;
    let start = 0, end = size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2]) || [range[1], range[2]].some((value) => value && !Number.isSafeInteger(Number(value))) || (!range[1] && Number(range[2]) === 0)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      if (!range[1]) { start = Math.max(0, size - Number(range[2])); }
      else { start = Number(range[1]); if (range[2]) { end = Math.min(end, Number(range[2])); } }
      end = Math.min(end, start + 4 * 1024 * 1024 - 1);
      if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    }
    const webm = path.extname(session.source.filePath).toLowerCase() === '.webm';
    res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': webm ? 'video/webm' : 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1), ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD' || !size) { res.end(); return; }
    if (signal.aborted) { return; }
    this.stats.rangeRequests++;
    const stream = createReadStream(session.source.filePath, { start, end });
    stream.on('data', (bytes) => { this.stats.rangeBytes += bytes.length; });
    const abort = (): void => { stream.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => signal.removeEventListener('abort', abort));
    stream.once('error', () => res.destroy()); stream.pipe(res);
  }

  private async sourceVersion(source: VideoSource): Promise<string> {
    const stat = await fs.stat(source.filePath, { bigint: true });
    if (!stat.isFile() || Number(stat.size) !== source.size || Math.floor(Number(stat.mtimeNs) / 1e6) !== Math.floor(source.mtime)) { throw new Error('The video changed. Reopen it to refresh.'); }
    // Orientation edits preserve original mtime and may preserve byte length.
    // Inode/ctime distinguish replacement or in-place edits without hashing media.
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }

  private async verifyVersion(source: VideoSource, version: string, orientation?: AbsoluteVideoOrientation): Promise<void> {
    if (await this.sourceVersion(source) !== version) { throw new Error('The video changed. Reopen it to refresh.'); }
    if ((await readVideoOrientation(source))?.key !== orientation?.key) { throw new Error('Video direction changed. Reopen it to refresh.'); }
  }

  private async posterBytes(source: VideoSource, executable: string, signal: AbortSignal, owner?: string): Promise<Artifact> {
    const version = await this.sourceVersion(source);
    const orientation = await readVideoOrientation(source);
    // Look in the disk cache before starting FFmpeg, even after a host restart.
    const key = hash([source.filePath, source.mtime, source.size, version, executable, orientation?.key, 'poster-first-frame-v3']);
    return this.artifact(key, '.jpg', signal, 0, async (stop) => {
      this.stats.posters++;
      const tools = await this.tools(executable);
      const output = ['-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', videoOrientationFilter(orientation) + 'scale=w=480:h=480:force_original_aspect_ratio=decrease', '-filter_threads', '1', '-threads', '1', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
      const extract = (fast: boolean): Promise<Buffer> => this.run(tools.ffmpeg,
        ['-nostdin', '-hide_banner', '-loglevel', 'error', ...(fast ? ['-probesize', '262144', '-analyzeduration', '100000', '-fpsprobesize', '0'] : []), '-threads', '1', ...(orientation ? ['-noautorotate'] : []), '-i', source.filePath, ...output], stop, 2 * 1024 * 1024, fast ? 5_000 : 15_000);
      let bytes: Buffer;
      try {
        bytes = await extract(true); if (!bytes.length) { throw new Error('No first frame was produced.'); }
      } catch (error) {
        if (stop.aborted || this.disposed) { throw cancelled(); }
        // Containers missing early codec headers get one normal-probing fallback.
        bytes = await extract(false); if (!bytes.length) { throw new Error('This file did not produce a first video frame.'); }
      }
      await this.verifyVersion(source, version, orientation);
      return bytes;
    }, owner, true);
  }

  private async segment(session: Session, index: number, signal: AbortSignal): Promise<Artifact> {
    await this.verifyVersion(session.source, session.version, session.orientation);
    const start = index * segmentSeconds, seconds = Math.min(segmentSeconds, session.info.stream!.duration - start);
    const height = session.settings.maxHeight ?? 1440;
    const dimensions = videoPreviewDimensions(session.info.width!, session.info.height!, height);
    const bitrate = Math.min(20000, Math.max(1500, Math.round(dimensions.width * dimensions.height * 0.0022)));
    // Output was already 30 fps. Discard surplus source frames before explicit rotation
    // and scaling instead of processing 60/120 fps and dropping them afterward.
    if (session.info.stream!.format === 'hls') {
      const key = hash([session.source.filePath, session.source.mtime, session.source.size, session.version, session.tools!.ffmpeg, index, height, session.info.stream!.mime, session.orientation?.key, 'browser-h264-aac-ts-v3']);
      return this.artifact(key, '.ts', signal, 2, async stop => {
        this.stats.segments++;
        const audio = session.info.stream!.mime.includes('mp4a');
        const bytes = await this.run(session.tools!.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-threads', String(decoderThreads), ...(session.orientation ? ['-noautorotate'] : []), '-i', session.source.filePath, '-t', String(seconds), '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : ['-an']), '-sn', '-dn',
          '-vf', `fps=30,${videoOrientationFilter(session.orientation)}scale=${dimensions.width}:${dimensions.height},setsar=1`, '-filter_threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0', '-threads', '2',
          ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : []), '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1'], stop, 32 * 1024 * 1024);
        await this.verifyVersion(session.source, session.version, session.orientation);
        return bytes;
      });
    }
    const key = hash([session.source.filePath, session.source.mtime, session.source.size, session.version, session.tools!.ffmpeg, index, height, session.info.stream!.mime, session.orientation?.key, 'vp8-safe-audio-v6']);
    return this.artifact(key, '.webm', signal, 2, async (stop) => {
      this.stats.segments++;
      const audio = session.info.stream!.mime.includes('vorbis') ? 'libvorbis' : '';
      const bytes = await this.run(session.tools!.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-threads', String(decoderThreads), ...(session.orientation ? ['-noautorotate'] : []), '-i', session.source.filePath, '-t', String(seconds), '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : ['-an']), '-sn', '-dn',
        '-vf', `fps=30,${videoOrientationFilter(session.orientation)}scale=${dimensions.width}:${dimensions.height},setsar=1`, '-filter_threads', '1',
        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', `${bitrate}k`, '-crf', '32', '-r', '30', '-g', '60', '-threads', '2', ...(audio ? ['-c:a', audio, '-b:a', '96k', '-ac', '2', '-ar', '48000'] : []), '-f', 'webm', '-cluster_time_limit', '1000', 'pipe:1'], stop, 16 * 1024 * 1024);
      await this.verifyVersion(session.source, session.version, session.orientation);
      return bytes;
    });
  }

  private async artifact(key: string, extension: string, signal: AbortSignal, priority: number, make: (stop: AbortSignal) => Promise<Buffer>, owner?: string, poster = false): Promise<Artifact> {
    const queued = performance.now();
    await this.initialized; if (this.disposed || signal.aborted) { throw cancelled(); }
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); this.entries.set(key, hit); hit.refs++;
      const now = new Date(); void fs.utimes(hit.file, now, now).catch(() => {});
      try { const bytes = await fs.readFile(hit.file); if (owner && !signal.aborted) { this.leasePoster(owner, hit); } return { file: hit.file, bytes, cacheHit: true, queueMs: 0, processMs: 0, cacheMs: performance.now() - queued }; }
      catch { this.entries.delete(key); this.bytes -= hit.size; }
      finally { hit.refs--; }
    }
    const result = await this.job<Artifact>(key, priority, signal, async (stop) => {
      const started = performance.now(); const bytes = await make(stop); const made = performance.now(); if (stop.aborted) { throw cancelled(); }
      const file = path.join(this.directory, 'stream-v1', `${key}${extension}`), temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
      this.bytes += bytes.length - (this.entries.get(key)?.size ?? 0); this.entries.delete(key); this.entries.set(key, { file, size: bytes.length, refs: 0 });
      this.prune(); return { file, bytes, cacheHit: false, queueMs: started - queued, processMs: made - started, cacheMs: performance.now() - made };
    }, poster);
    const entry = this.entries.get(key); if (owner && entry && !signal.aborted) { this.leasePoster(owner, entry); }
    return result;
  }

  private job<T>(key: string, priority: number, signal: AbortSignal, run: (stop: AbortSignal) => Promise<T>, poster = false): Promise<T> {
    if (this.disposed || signal.aborted) { return Promise.reject(cancelled()); }
    let job = this.pending.get(key);
    if (!job || job.controller.signal.aborted) {
      let resolve!: Job['resolve'], reject!: Job['reject']; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      const created: Job = { poster, key, priority, controller: new AbortController(), waiters: new Set(), promise, resolve, reject, run };
      job = created; this.pending.set(key, job); this.queue.push(job);
      const forget = (): void => { if (this.pending.get(key) === created) { this.pending.delete(key); } }; void promise.then(forget, forget);
    } else { job.priority = Math.max(job.priority, priority); }
    const active = job, waiter = Symbol(); active.waiters.add(waiter);
    const result = new Promise<T>((resolve, reject) => {
      const abort = (): void => { active.waiters.delete(waiter); if (!active.waiters.size) { active.controller.abort(); } reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      void active.promise.then((value) => { if (signal.aborted) { reject(cancelled()); } else { resolve(value as T); } }, reject).finally(() => { active.waiters.delete(waiter); signal.removeEventListener('abort', abort); });
      if (signal.aborted) { abort(); }
    });
    this.pump(); return result;
  }
  private pump(): void {
    if (this.disposed) { return; } this.queue.sort((a, b) => b.priority - a.priority);
    // Short first-frame jobs have a separate bounded lane, so another Gallery's
    // playback conversions cannot keep visible posters waiting indefinitely.
    const posterLimit = this.options.maxPosterJobs ?? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
    for (let i = 0; i < this.queue.length;) {
      const job = this.queue[i];
      if (job.controller.signal.aborted) { this.queue.splice(i, 1); job.reject(cancelled()); continue; }
      const count = [...this.running].filter((active) => active.poster === job.poster).length;
      if (count >= (job.poster ? posterLimit : this.options.maxJobs ?? 2)) { i++; continue; }
      this.queue.splice(i, 1); this.running.add(job);
      void job.run(job.controller.signal).then(job.resolve, job.reject).finally(() => { this.running.delete(job); this.pump(); });
    }
  }

  private tools(configured: string, browser = false): Promise<Tools> {
    const cacheKey = `${configured}/${browser ? 'browser' : 'webview'}`;
    const existing = this.toolCache.get(cacheKey); if (existing) { return existing; }
    const promise = (async () => {
      const choices = configured === 'ffmpeg' && process.platform !== 'win32' ? [configured, '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'] : [configured];
      let usable: Tools | undefined, failure: unknown;
      for (const executable of [...new Set(choices)]) {
        try {
          const output = (await this.run(executable, ['-hide_banner', '-encoders'], this.toolsController.signal, 1024 * 1024, 10_000)).toString();
          const encoders = new Set([...output.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)].map((m) => m[1]));
          const probe = path.extname(executable).toLowerCase() === '.exe' ? 'ffprobe.exe' : 'ffprobe';
          const tool = { ffmpeg: executable, ffprobe: path.dirname(executable) === '.' ? probe : path.join(path.dirname(executable), probe), encoders };
          usable ??= tool;
          if (browser ? encoders.has('libx264') && encoders.has('aac') : encoders.has('libvpx') && encoders.has('libvorbis')) { return tool; }
        } catch (error) { failure = error; }
      }
      if (usable) { return usable; } throw failure ?? new Error('FFmpeg is unavailable.');
    })();
    this.toolCache.set(cacheKey, promise); void promise.catch(() => this.toolCache.delete(cacheKey)); return promise;
  }

  private run(executable: string, args: string[], signal: AbortSignal, maxBytes: number, timeoutMs = this.options.timeoutMs ?? 60_000): Promise<Buffer> {
    if (signal.aborted || this.disposed) { return Promise.reject(cancelled()); }
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let count = 0, stderr = '', failure: Error | undefined;
      const abort = (): void => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => { failure = new Error('Video request timed out. Check server load or choose native playback.'); abort(); }, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.stdout.on('data', (data: Buffer) => { count += data.length; if (count > maxBytes) { failure = new Error('The requested video fragment exceeded its size limit.'); abort(); } else { chunks.push(data); } });
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
      child.once('error', (error) => { cleanup(); reject(error); });
      child.once('close', (code) => { cleanup(); if (signal.aborted || this.disposed) { reject(cancelled()); } else if (failure) { reject(failure); } else if (code) { reject(new Error(`Video request failed: ${stderr.trim().slice(-700) || `FFmpeg exited ${code}`}`)); } else { resolve(Buffer.concat(chunks)); } });
      if (signal.aborted) { abort(); }
    });
  }

  private async restore(): Promise<void> {
    const directory = path.join(this.directory, 'stream-v1'); await fs.mkdir(directory, { recursive: true });
    const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.(jpg|webm|ts)$/.test(name));
    const records: Array<{ key: string; file: string; size: number; used: number }> = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, names.length) }, async () => {
      while (next < names.length) {
        const name = names[next++], file = path.join(directory, name);
        try { const stat = await fs.stat(file); if (stat.isFile()) { records.push({ key: name.slice(0, 64), file, size: stat.size, used: stat.mtimeMs }); } } catch { /* Another host may evict a cached fragment. */ }
      }
    }));
    for (const entry of records.filter((entry) => !!entry).sort((a, b) => a.used - b.used)) { this.entries.set(entry.key, { file: entry.file, size: entry.size, refs: 0 }); this.bytes += entry.size; }
    this.prune();
  }
  private prune(): void {
    // Yield until request continuations can lease newly produced posters.
    this.pruning = this.pruning.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(async () => {
      for (const [key, entry] of this.entries) {
        if (this.bytes <= (this.options.maxBytes ?? 512 * 1024 * 1024) && this.entries.size <= 10000) { break; }
        if (entry.refs) { continue; }
        this.entries.delete(key); this.bytes -= entry.size; await fs.rm(entry.file, { force: true });
      }
    }).catch(() => {});
  }
}

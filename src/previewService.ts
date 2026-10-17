import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PreviewExecutor, previewConcurrency, type PreviewBackend } from './previewExecutor';
import type { ProcessedPreview } from './previewProcessor';
import { isCameraRaw } from './imageFormats';

export interface PreviewSource {
  mtime: number;
  size: number;
  read: () => Promise<Uint8Array>;
}
export interface Preview extends Omit<ProcessedPreview, 'bytes'> {
  filePath?: string;
  timings?: { cacheHit: boolean; queueMs: number; readMs: number; processMs: number; writeMs: number; totalMs: number; engine: string; pid?: number };

}
interface CacheEntry {
  result: Preview;
  size: number;
  used: number;
}
interface Job {
  key: string;
  priority: number;
  controller: AbortController;
  state: { writing: boolean };
  run: (slot: number) => Promise<Preview>;
  resolve: (value: Preview) => void;
  reject: (error: Error) => void;
}
interface PreviewServiceOptions {
  maxBytes?: number;
  timeoutMs?: number;
  concurrency?: number;
  backend?: PreviewBackend;
  process?: (bytes: Uint8Array, resolution: number, filename: string, thumbnail?: boolean) => Promise<ProcessedPreview>;
}
const abortError = (): Error => Object.assign(new Error('Preview request cancelled.'), { name: 'AbortError' });

/** One priority queue and bounded decoder pool shared by every Gallery panel. */
export class PreviewService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly owners = new Map<string, string>();
  private readonly promotedOwners = new Set<string>();
  private readonly pending = new Map<string, Promise<Preview>>();
  private readonly jobs: Job[] = [];
  private readonly initialized: Promise<void>;
  private readonly executor: PreviewExecutor;
  private readonly poolListeners = new Set<() => void>();
  private readonly active = new Map<number, Job>();
  private concurrency: number;
  private backend: PreviewBackend;
  private requestedConcurrency: number;
  private disposed = false;
  private clock = Date.now();
  private eviction: Promise<void> = Promise.resolve();
  private pruneScheduled = false;
  private pruneAgain = false;
  private totalBytes = 0;
  private readonly leases = new Map<string, number>();

  constructor(
    readonly directory: string,
    private readonly source: (id: string) => Promise<PreviewSource>,
    private readonly options: PreviewServiceOptions = {},
  ) {
    this.requestedConcurrency = options.concurrency ?? (options.process ? 1 : 0);
    this.concurrency = previewConcurrency(this.requestedConcurrency);
    this.backend = options.backend ?? 'process';
    this.executor = new PreviewExecutor(this.backend, options.timeoutMs);
    this.initialized = this.restore();
    void this.initialized.catch(() => {});
  }

  async get(id: string, resolution: number, owner: string, detail: boolean, signal: AbortSignal, thumbnail = false, onQueued?: () => void): Promise<Preview> {
    const requestedAt = performance.now();
    await this.initialized;
    if (this.disposed || signal.aborted) { throw abortError(); }
    const source = await this.source(id);
    if (this.disposed || signal.aborted) { throw abortError(); }
    await this.eviction;
    if (this.disposed || signal.aborted) { throw abortError(); }
    const format = isCameraRaw(id) ? (thumbnail ? 'static-webp75-raw-v2' : 'webp85-raw-embedded-v4') : (thumbnail ? 'static-webp75-jpeg-scaled-v2' : 'webp85-libraw-v3');
    const key = createHash('sha256').update(JSON.stringify([id, source.mtime, source.size, resolution, format])).digest('hex');
    if (this.owners.has(owner)) { this.release(owner); }
    this.owners.set(owner, key);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    const onAbort = (): void => this.release(owner);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let cached = this.entries.get(key);
      if (cached?.result.filePath) {
        try { await fs.access(cached.result.filePath); } catch { this.totalBytes -= cached.size; this.entries.delete(key); cached = undefined; }
      }
      if (cached) {
        cached.used = ++this.clock;
        this.entries.delete(key); this.entries.set(key, cached);
        if (cached.result.filePath) {
          const now = new Date();
          void fs.utimes(cached.result.filePath, now, now).catch(() => {});
        }
        if (signal.aborted) { throw abortError(); }
        return { ...cached.result, timings: { cacheHit: true, queueMs: 0, readMs: 0, processMs: 0, writeMs: 0, totalMs: performance.now() - requestedAt, engine: 'cache' } };
      }
      let promise = this.pending.get(key);
      if (!promise) {
        const queuedAt = performance.now();
        const controller = new AbortController();
        const state = { writing: false };
        promise = new Promise<Preview>((resolve, reject) => {
          this.jobs.push({ key, controller, state, priority: detail || this.promotedOwners.has(owner) ? 2 : thumbnail ? 0 : 1, resolve, reject, run: async (slot) => {
            const started = performance.now();
            const bytes = await source.read();
            const read = performance.now();
            if (controller.signal.aborted || this.disposed) { throw abortError(); }
            const processed = this.options.process
              ? { result: await this.options.process(bytes, resolution, id, thumbnail), engine: 'injected', pid: undefined }
              : await this.executor.run(slot, { bytes, resolution, filename: id, thumbnail }, controller.signal);
            const result = processed.result;
            const completed = performance.now();
            if (this.disposed || controller.signal.aborted) { throw abortError(); }
            state.writing = true;
            const { bytes: output, ...dimensions } = result;
            const preview: Preview = dimensions;
            if (output) {
              preview.filePath = path.join(this.directory, `${key}.webp`);
              const temporary = `${preview.filePath}.tmp`;
              await fs.writeFile(temporary, output);
              await fs.rename(temporary, preview.filePath);
              await fs.writeFile(path.join(this.directory, `${key}.json`), JSON.stringify(dimensions));
            }
            this.totalBytes += (output?.length ?? 0) - (this.entries.get(key)?.size ?? 0);
            this.entries.delete(key);
            this.entries.set(key, { result: preview, size: output?.length ?? 0, used: ++this.clock });
            this.prune();
            return { ...preview, timings: { cacheHit: false, queueMs: started - queuedAt, readMs: read - started,
              processMs: completed - read, writeMs: performance.now() - completed, totalMs: performance.now() - queuedAt, engine: processed.engine, pid: processed.pid } };
          } });
        });
        this.pending.set(key, promise);
        const task = promise;
        const finished = (): void => { if (this.pending.get(key) === task) { this.pending.delete(key); } };
        void promise.then(finished, finished);
      } else if (detail || this.promotedOwners.has(owner)) {
        const job = this.jobs.find((item) => item.key === key);
        if (job) { job.priority = 2; }
      }
      this.pump();
      onQueued?.();
      // Cancellation wakes the caller immediately even while a shared Worker task is running.
      const result = await new Promise<Preview>((resolve, reject) => {
        const cancelled = (): void => reject(abortError());
        signal.addEventListener('abort', cancelled, { once: true });
        void promise!.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
        if (signal.aborted) { cancelled(); }
      });
      if (signal.aborted || this.disposed) { throw abortError(); }
      return { ...result, timings: result.timings && { ...result.timings, totalMs: performance.now() - requestedAt } };
    } catch (error) {
      this.release(owner);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Small grid images travel in the existing message instead of a second SSH
   * resource request. Large outputs retain the normal leased-resource fallback. */
  async inlineThumbnail(preview: Preview, signal: AbortSignal): Promise<{ source: string; bytes: number } | undefined> {
    if (!preview.filePath || signal.aborted || this.disposed) { return undefined; }
    const stat = await fs.stat(preview.filePath);
    if (stat.size > 256 * 1024) { return undefined; }
    const bytes = await fs.readFile(preview.filePath);
    if (signal.aborted || this.disposed) { throw abortError(); }
    return { source: `data:image/webp;base64,${bytes.toString('base64')}`, bytes: bytes.length };
  }

  /** Adopt an in-flight neighbour without restarting its decode or resource lease. */
  promote(owner: string): void {
    if (this.disposed) { return; }
    this.promotedOwners.add(owner);
    const key = this.owners.get(owner);
    const job = this.jobs.find((item) => item.key === key);
    if (job) { job.priority = 2; }
    for (const active of this.active.values()) { if (active.key === key) { active.priority = 2; } }
  }

  get poolStatus(): { requested: number; workers: number; backend: PreviewBackend; mode: PreviewBackend } {
    return { requested: this.requestedConcurrency, workers: this.concurrency, backend: this.executor.effectiveBackend, mode: this.backend };
  }

  onConcurrencyChanged(listener: () => void): { dispose: () => void } {
    this.poolListeners.add(listener);
    return { dispose: () => { this.poolListeners.delete(listener); } };
  }

  setBackend(value: string): void {
    if ((value !== 'process' && value !== 'thread') || this.disposed || value === this.backend) { return; }
    this.backend = value; this.executor.setBackend(value);
    for (const listener of this.poolListeners) { listener(); }
  }

  setConcurrency(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 8 || this.disposed) { return; }
    this.requestedConcurrency = value;
    this.concurrency = previewConcurrency(value);
    this.executor.trim(this.concurrency);
    this.pump();
    for (const listener of this.poolListeners) { listener(); }
  }

  release(owner: string): void {
    this.promotedOwners.delete(owner);
    const key = this.owners.get(owner);
    if (!key) { return; }
    this.owners.delete(owner);
    const count = (this.leases.get(key) ?? 1) - 1;
    if (count) { this.leases.set(key, count); }
    else {
      this.leases.delete(key);
      for (const job of this.active.values()) { if (job.key === key && !job.state.writing) { this.pending.delete(key); job.controller.abort(); } }
    }
    this.prune();
  }

  dispose(): void {
    this.promotedOwners.clear();
    this.poolListeners.clear();
    this.disposed = true;
    this.owners.clear();
    this.leases.clear();
    for (const job of this.jobs.splice(0)) { job.reject(abortError()); }
    for (const job of this.active.values()) { job.controller.abort(); }
    this.executor.dispose();
  }

  private pump(): void {
    if (this.disposed) { return; }
    this.jobs.sort((a, b) => b.priority - a.priority);
    for (let slot = 0; slot < this.concurrency; slot++) {
      if (this.active.size >= this.concurrency) { break; }
      if (this.active.has(slot)) { continue; }
      let job = this.jobs.shift();
      while (job && !this.leases.has(job.key)) { job.reject(abortError()); job = this.jobs.shift(); }
      if (!job) { break; }
      const activeJob = job;
      this.active.set(slot, activeJob);
      void activeJob.run(slot).then(activeJob.resolve, activeJob.reject).finally(() => {
        this.active.delete(slot);
        this.executor.trim(this.concurrency);
        this.pump();
      });
    }
  }

  private async restore(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const names = (await fs.readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    // Bounded parallel I/O avoids serially waiting for every cache metadata file.
    for (let offset = 0; offset < names.length; offset += 16) {
      await Promise.all(names.slice(offset, offset + 16).map(async (name) => {
        const key = name.slice(0, -5);
        const filePath = path.join(this.directory, `${key}.webp`);
        try {
          const result = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')) as Preview;
          if (![result.width, result.height, result.originalWidth, result.originalHeight].every((n) => Number.isSafeInteger(n) && n > 0)) {
            throw new Error('Invalid cached dimensions');
          }
          const stat = await fs.stat(filePath);
          this.entries.set(key, { result: { ...result, filePath }, size: stat.size, used: stat.mtimeMs });
        } catch {
          await Promise.all([fs.rm(filePath, { force: true }), fs.rm(path.join(this.directory, name), { force: true })]);
        }
      }));
    }
    const sorted = [...this.entries].sort((a, b) => a[1].used - b[1].used);
    this.entries.clear();
    for (const [key, entry] of sorted) { this.entries.set(key, entry); this.totalBytes += entry.size; }
    // Interrupted writes and previews without metadata cannot be reused.
    for (const name of await fs.readdir(this.directory)) {
      const orphan = /^([a-f0-9]{64})\.webp$/.exec(name);
      if (/^[a-f0-9]{64}\.webp\.tmp$/.test(name) || (orphan && !this.entries.has(orphan[1]))) {
        await fs.rm(path.join(this.directory, name), { force: true });
      }
    }
    this.prune();
  }

  private prune(): void {
    const limit = this.options.maxBytes ?? 256 * 1024 * 1024;
    if (this.totalBytes <= limit && this.entries.size <= 10_000) { return; }
    if (this.pruneScheduled) { this.pruneAgain = true; return; }
    this.pruneScheduled = true;
    this.eviction = this.eviction.then(async () => {
      // Map order is LRU: hits move entries to the back. No full-cache sort on scrolling.
      for (const [key, entry] of this.entries) {
        if (this.totalBytes <= limit && this.entries.size <= 10_000) { break; }
        if (this.leases.has(key)) { continue; }
        if (entry.result.filePath) {
          await fs.rm(entry.result.filePath, { force: true });
          await fs.rm(path.join(this.directory, `${key}.json`), { force: true });
        }
        this.totalBytes -= entry.size;
        this.entries.delete(key);
      }
    }).catch(() => {}).finally(() => {
      this.pruneScheduled = false;
      if (this.pruneAgain) { this.pruneAgain = false; this.prune(); }
    });
  }
}

import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import type { ProcessedPreview } from './previewProcessor';

export type PreviewBackend = 'process' | 'thread';
export interface PreviewInput { bytes: Uint8Array; resolution: number; filename: string; thumbnail: boolean }
interface Reply { ready?: boolean; result?: ProcessedPreview; error?: string; pid?: number }
interface Lane { child?: ChildProcess; worker?: Worker; ready: Promise<void>; backend: PreviewBackend; idle?: NodeJS.Timeout }
const cancelled = (): Error => Object.assign(new Error('Preview request cancelled.'), { name: 'AbortError' });
class StartupError extends Error {}

export function previewConcurrency(requested = 0, hardware = { cpus: os.availableParallelism?.() ?? os.cpus().length, total: os.totalmem(), free: os.freemem() }): number {
  const cpus = Math.max(1, hardware.cpus);
  const memory = Math.max(1, Math.floor(hardware.total / (1024 ** 3)));
  if (Number.isInteger(requested) && requested >= 1 && requested <= 8) { return Math.min(requested, cpus, memory); }
  // Reserve CPU time for VS Code and budget ~768 MiB per independent decoder (pixel cache, WASM and input buffers).
  return Math.max(1, Math.min(4, cpus - 1, memory, Math.floor(hardware.free / (768 * 1024 ** 2))));
}

/** Reused independent decoders; no processes start until work reaches a lane. */
export class PreviewExecutor {
  private readonly lanes = new Map<number, Lane>();
  private processUnavailable = false;
  private disposed = false;
  constructor(private backend: PreviewBackend = 'process', private readonly timeoutMs = 30_000, private readonly idleMs = 30_000) {}

  async run(index: number, input: PreviewInput, signal: AbortSignal): Promise<{ result: ProcessedPreview; engine: PreviewBackend; pid?: number }> {
    if (this.disposed || signal.aborted) { throw cancelled(); }
    let lane = this.lanes.get(index);
    const desired = this.effectiveBackend;
    if (lane && lane.backend !== desired) { this.close(index, lane); lane = undefined; }
    if (!lane) { lane = this.create(index, this.processUnavailable ? 'thread' : this.backend); }
    clearTimeout(lane.idle); lane.idle = undefined;
    const waitReady = (current: Lane): Promise<void> => new Promise((resolve, reject) => {
      const abort = (): void => { this.close(index, current); reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      void current.ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) { abort(); }
    });
    try { await waitReady(lane); }
    catch (error) {
      this.close(index, lane);
      if (signal.aborted || this.disposed) { throw cancelled(); }
      if (lane.backend !== 'process' || !(error instanceof StartupError)) { throw error; }
      // Some Electron builds disable runAsNode. Keep browsing usable there.
      this.processUnavailable = true;
      lane = this.create(index, 'thread');
      await waitReady(lane);
    }
    if (this.disposed || signal.aborted) { this.close(index, lane); throw cancelled(); }
    const current = lane;
    return new Promise((resolve, reject) => {
      const endpoint = current.child ?? current.worker!;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        endpoint.off('error', fail); endpoint.off('exit', exit); endpoint.off('message', reply);
      };
      const fail = (error: Error): void => {
        if (settled) { return; } settled = true; cleanup(); this.close(index, current); reject(error);
      };
      const abort = (): void => fail(cancelled());
      const exit = (code: number | null): void => fail(new Error(`Image decoder exited (${code}).`));
      const reply = (message: Reply): void => {
        if (message.ready) { return; }
        if (!message.result) { fail(new Error(message.error || 'Preview generation failed.')); return; }
        if (settled) { return; } settled = true; cleanup();
        if (current.backend !== this.effectiveBackend) { this.close(index, current); }
        else {
          this.unref(current);
          current.idle = setTimeout(() => this.close(index, current), this.idleMs); current.idle.unref();
        }
        resolve({ result: message.result, engine: current.backend, pid: message.pid });
      };
      const timeout = setTimeout(() => fail(new Error('Preview generation timed out. Load the original image to continue.')), this.timeoutMs);
      endpoint.once('error', fail); endpoint.once('exit', exit); endpoint.on('message', reply);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      current.worker?.ref(); current.child?.ref(); current.child?.channel?.ref();
      try {
        if (current.child) { current.child.send(input, (error) => { if (error) { fail(error); } }); }
        else { current.worker!.postMessage(input); }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  get effectiveBackend(): PreviewBackend { return this.processUnavailable ? 'thread' : this.backend; }
  setBackend(backend: PreviewBackend): void {
    if (backend === this.backend) { return; }
    this.backend = backend; this.processUnavailable = false;
    for (const [index, lane] of this.lanes) { if (lane.idle) { this.close(index, lane); } }
  }

  trim(limit: number): void { for (const [index, lane] of this.lanes) { if (index >= limit && lane.idle) { this.close(index, lane); } } }
  dispose(): void { this.disposed = true; for (const [index, lane] of this.lanes) { this.close(index, lane); } }

  private create(index: number, backend: PreviewBackend): Lane {
    const child = backend === 'process' ? fork(path.join(__dirname, 'previewProcess.js'), [], {
      execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }) : undefined;
    const worker = backend === 'thread' ? new Worker(path.join(__dirname, 'previewWorker.js'), { execArgv: [] }) : undefined;
    const endpoint = child ?? worker!;
    const lane: Lane = { child, worker, backend, ready: Promise.resolve() };
    this.lanes.set(index, lane);
    endpoint.on('error', () => {});
    endpoint.once('exit', () => { if (this.lanes.get(index) === lane) { this.lanes.delete(index); } });
    lane.ready = new Promise((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); endpoint.off('message', reply); endpoint.off('error', fail); endpoint.off('exit', exit); };
      const fail = (error: Error): void => { cleanup(); reject(new StartupError(error.message)); };
      const exit = (): void => fail(new Error('Image decoder could not start.'));
      const reply = (message: Reply): void => { if (message.ready) { cleanup(); resolve(); } };
      const timer = setTimeout(() => fail(new Error('Image decoder startup timed out.')), Math.min(5000, this.timeoutMs));
      endpoint.on('message', reply); endpoint.once('error', fail); endpoint.once('exit', exit);
    });
    void lane.ready.catch(() => {});
    return lane;
  }

  private unref(lane: Lane): void { lane.worker?.unref(); lane.child?.unref(); lane.child?.channel?.unref(); }
  private close(index: number, lane: Lane): void {
    clearTimeout(lane.idle);
    if (this.lanes.get(index) === lane) { this.lanes.delete(index); }
    if (lane.child && !lane.child.killed) { lane.child.kill('SIGKILL'); }
    void lane.worker?.terminate();
  }
}

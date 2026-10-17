(() => {
  // Each finite WebM response is appended serially at its source timestamp.
  class GalleryVideoStream {
    constructor(video, descriptor, onError, onLoading = () => {}, onDiagnostic = () => {}) {
      Object.assign(this, { video, descriptor, onError, onLoading, onDiagnostic });
      this.loaded = new Set(); this.listeners = []; this.operations = new Set(); this.generation = 0;
      this.disposed = false; this.suspended = false; this.busy = false;
    }
    start() {
      if (!window.MediaSource || !MediaSource.isTypeSupported(this.descriptor.mime)) { throw new Error(`Unsupported stream codec: ${this.descriptor.mime}. Try original playback.`); }
      this.media = new MediaSource(); this.url = URL.createObjectURL(this.media); this.video.src = this.url;
      this.listen(this.media, 'sourceopen', () => {
        if (this.disposed || this.buffer) { return; }
        try {
          this.buffer = this.media.addSourceBuffer(this.descriptor.mime); this.video.dataset.streamState = 'source-open'; this.media.duration = this.descriptor.duration;
          if (this.descriptor.startTime > 0) { this.video.currentTime = Math.min(this.descriptor.startTime, Math.max(0, this.descriptor.duration - 0.05)); }
          this.pump();
        } catch (error) { this.fail(error); }
      });
      for (const event of ['play', 'timeupdate', 'waiting']) { this.listen(this.video, event, () => this.pump()); }
      this.listen(this.video, 'seeking', () => {
        this.generation++;
        if (this.loadingIndex !== this.currentIndex()) { this.controller?.abort(); }
        this.pump();
      });
      this.listen(this.video, 'pause', () => { if (this.loaded.has(this.currentIndex())) { this.controller?.abort(); } });
      this.video.load(); this.video.dataset.streamState = 'opening';
    }
    cancelled() { return new DOMException('Video operation cancelled.', 'AbortError'); }
    currentIndex() { return Math.min(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1, Math.max(0, Math.floor(this.video.currentTime / this.descriptor.segmentSeconds))); }
    listen(target, event, listener) { target.addEventListener(event, listener); this.listeners.push(() => target.removeEventListener(event, listener)); }
    suspend() { this.suspended = true; this.generation++; this.controller?.abort(); }
    resume() { this.suspended = false; this.pump(); }
    dispose() {
      if (this.disposed) { return; }
      this.disposed = true; this.generation++; this.controller?.abort(); this.listeners.forEach(remove => remove()); this.listeners = [];
      for (const cancel of [...this.operations]) { cancel(); }
      try { if (this.media?.readyState === 'open' && this.buffer) { this.buffer.abort(); this.media.removeSourceBuffer(this.buffer); } } catch { /* Detached media element. */ }
      if (this.url) { URL.revokeObjectURL(this.url); }
    }
    update(action) {
      if (this.disposed || this.media.readyState === 'closed') { return Promise.reject(this.cancelled()); }
      return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const cancel = () => { cleanup(); reject(this.cancelled()); };
        const failed = () => {
          const media = this.video.error;
          cleanup(); reject(new Error(`Fragment ${this.loadingIndex}: SourceBuffer decode failed${media ? ` (media ${media.code}: ${media.message || 'unknown decoder error'})` : ''}.`));
        };
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`Fragment ${this.loadingIndex}: SourceBuffer update timed out.`)); }, 15000);
        const cleanup = () => {
          clearTimeout(timeout); this.operations.delete(cancel);
          this.buffer.removeEventListener('updateend', done); this.buffer.removeEventListener('error', failed); this.buffer.removeEventListener('abort', cancel); this.media.removeEventListener('sourceclose', cancel);
        };
        this.operations.add(cancel);
        this.buffer.addEventListener('updateend', done, { once: true }); this.buffer.addEventListener('error', failed, { once: true }); this.buffer.addEventListener('abort', cancel, { once: true }); this.media.addEventListener('sourceclose', cancel, { once: true });
        try { action(); } catch (error) { cleanup(); reject(error); }
      });
    }
    async evict(index) {
      const seconds = this.descriptor.segmentSeconds, from = Math.max(0, index - 2) * seconds, to = (index + 3) * seconds;
      if (from > 0 && this.buffer.buffered.length && this.buffer.buffered.start(0) < from) { await this.update(() => this.buffer.remove(0, from)); }
      if (to < this.descriptor.duration && this.buffer.buffered.length && this.buffer.buffered.end(this.buffer.buffered.length - 1) > to) { await this.update(() => this.buffer.remove(to, this.descriptor.duration + 1)); }
      for (const loaded of this.loaded) { if (loaded < index - 2 || loaded > index + 2) { this.loaded.delete(loaded); } }
    }
    async pump() {
      if (this.busy) { this.pendingPump = true; return; }
      if (this.disposed || this.suspended || !this.buffer || this.media.readyState === 'closed') { return; }
      this.busy = true;
      try {
        while (!this.disposed && !this.suspended) {
          const current = this.currentIndex(), generation = this.generation;
          const end = Math.min(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1, current + (this.video.paused ? 0 : 2));
          let index = current; while (index <= end && this.loaded.has(index)) { index++; }
          if (index > end) {
            if (this.loaded.has(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1) && this.media.readyState === 'open' && !this.buffer.updating) { this.media.endOfStream(); }
            break;
          }
          this.loadingIndex = index; this.controller = new AbortController(); const signal = this.controller.signal;
          if (!this.loaded.has(current)) { this.onLoading(); }
          const url = new URL(this.descriptor.base); url.pathname += `${index}.webm`;
          const started = performance.now(); let bytes, timedOut = false;
          const timeout = setTimeout(() => { timedOut = true; this.controller?.abort(); }, 30000);
          try {
            const response = await fetch(url.toString(), { signal, credentials: 'omit' });
            if (!response.ok) { throw new Error(`Fragment ${index}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`); }
            bytes = await response.arrayBuffer();
          } catch (error) {
            if (timedOut) { throw new Error(`Fragment ${index}: reading timed out. Check the SSH connection or try a lower quality.`); }
            if (signal.aborted && !this.disposed && !this.suspended) { continue; } throw error;
          } finally { clearTimeout(timeout); }
          if (signal.aborted || this.disposed || this.suspended || generation !== this.generation) { continue; }
          await this.evict(current);
          if (this.disposed || this.suspended || signal.aborted || generation !== this.generation) { continue; }
          this.buffer.timestampOffset = index * this.descriptor.segmentSeconds;
          // A completed append already ends at a WebM segment boundary. Calling
          // abort() here needlessly resets parser/audio state between every clip.
          await this.update(() => this.buffer.appendBuffer(bytes));
          if (this.disposed || this.suspended || generation !== this.generation) { continue; }
          this.loaded.add(index); this.media.duration = this.descriptor.duration;
          this.video.dataset.streamState = `buffered ${[...this.loaded]} · ${this.buffer.buffered.length} ranges`;
          this.onDiagnostic({ stage: 'appended', index, bytes: bytes.byteLength, elapsedMs: performance.now() - started, mime: this.descriptor.mime });
        }
      } catch (error) { if (!this.disposed && !this.suspended && error.name !== 'AbortError') { this.fail(error); } }
      finally { this.busy = false; if (this.pendingPump) { this.pendingPump = false; queueMicrotask(() => this.pump()); } }
    }
    fail(error) {
      const message = String(error.message || error); this.video.dataset.streamError = message;
      this.onDiagnostic({ stage: 'failed', index: this.loadingIndex, message, mime: this.descriptor.mime, mediaCode: this.video.error?.code, mediaMessage: this.video.error?.message });
      if (!this.disposed) { this.onError(message); }
    }
  }
  window.GalleryVideoStream = GalleryVideoStream;
})();

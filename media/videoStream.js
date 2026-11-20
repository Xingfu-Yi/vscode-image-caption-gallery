(() => {
  // Each finite WebM response is appended serially at its source timestamp.
  class GalleryVideoStream {
    constructor(video, descriptor, onError, onLoading = () => {}, onDiagnostic = () => {}) {
      Object.assign(this, { video, descriptor, onError, onLoading, onDiagnostic });
      this.loaded = new Set(); this.listeners = []; this.operations = new Set(); this.generation = 0;
      this.requests = new Map(); this.loadedBytes = new Map(); this.maxBufferBytes = 32 * 1024 * 1024;
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
      for (const event of ['play', 'timeupdate', 'ratechange']) { this.listen(this.video, event, () => this.pump()); }
      this.listen(this.video, 'waiting', () => {
        this.onDiagnostic({ stage: 'waiting', time: this.video.currentTime, bufferedAhead: this.bufferedAhead(), pending: [...this.requests.keys()], rate: this.video.playbackRate });
        this.pump();
      });
      this.listen(this.video, 'seeking', () => {
        this.generation++;
        this.trimRequests();
        this.pump();
      });
      this.listen(this.video, 'pause', () => this.trimRequests());
      this.video.load(); this.video.dataset.streamState = 'opening';
    }
    cancelled() { return new DOMException('Video operation cancelled.', 'AbortError'); }
    currentIndex() { return Math.min(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1, Math.max(0, Math.floor(this.video.currentTime / this.descriptor.segmentSeconds))); }
    listen(target, event, listener) { target.addEventListener(event, listener); this.listeners.push(() => target.removeEventListener(event, listener)); }
    suspend() { this.suspended = true; this.generation++; this.cancelRequests(); }
    resume() { this.suspended = false; this.pump(); }
    dispose() {
      if (this.disposed) { return; }
      this.disposed = true; this.generation++; this.cancelRequests(); this.listeners.forEach(remove => remove()); this.listeners = [];
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
    windowEnd(index = this.currentIndex()) {
      // Keep a bounded wall-clock cushion, including at faster playback rates.
      const ahead = this.video.paused ? 0 : Math.ceil(Math.min(48, 20 * Math.max(1, this.video.playbackRate || 1)) / this.descriptor.segmentSeconds);
      return Math.min(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1, index + ahead);
    }
    bufferedAhead() {
      const time = this.video.currentTime, ranges = this.buffer?.buffered;
      for (let i = 0; ranges && i < ranges.length; i++) { if (ranges.start(i) <= time + .1 && ranges.end(i) > time) { return ranges.end(i) - time; } }
      return 0;
    }
    cancelRequests() { for (const request of this.requests.values()) { request.controller.abort(); } this.requests.clear(); }
    trimRequests() {
      const current = this.currentIndex(), end = this.windowEnd(current);
      const wanted = new Set();
      for (let index = current; index <= end && wanted.size < 2; index++) { if (!this.loaded.has(index)) { wanted.add(index); } }
      for (const [index, request] of this.requests) {
        if (!wanted.has(index)) { request.controller.abort(); this.requests.delete(index); }
      }
    }
    bufferBytes() { return [...this.loadedBytes.values()].reduce((sum, bytes) => sum + bytes, 0); }
    fillRequests(current, end) {
      // Two downloads let the host's two existing FFmpeg slots overlap encoding
      // and SSH transfer. Appends still run on exactly one serial MSE lane.
      for (let index = current; index <= end && this.requests.size < 2; index++) {
        if (!this.loaded.has(index) && !this.requests.has(index)) {
          if (index !== current && this.bufferBytes() >= this.maxBufferBytes) { break; }
          this.fetchFragment(index);
        }
      }
    }
    fetchFragment(index) {
      const controller = new AbortController(), signal = controller.signal;
      const request = { controller, bytes: null, error: null, started: performance.now() };
      this.requests.set(index, request);
      request.promise = (async () => {
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
        try {
          const url = new URL(this.descriptor.base); url.pathname += `${index}.webm`;
          const response = await fetch(url.toString(), { signal, credentials: 'omit' });
          const headersMs = performance.now() - request.started;
          if (!response.ok) { throw new Error(`Fragment ${index}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`); }
          request.bytes = await response.arrayBuffer();
          if (!request.bytes.byteLength) { throw new Error(`Fragment ${index}: the server returned an empty video fragment.`); }
          if (request.bytes.byteLength > 16 * 1024 * 1024) { request.bytes = null; throw new Error(`Fragment ${index}: exceeded its size limit.`); }
          request.elapsedMs = performance.now() - request.started;
          request.serverTiming = response.headers?.get('server-timing') || '';
          if (!signal.aborted && !this.disposed && !this.suspended) {
            this.onDiagnostic({ stage: 'fetched', index, bytes: request.bytes.byteLength, headersMs, elapsedMs: request.elapsedMs, serverTiming: request.serverTiming });
          }
        } catch (error) {
          request.error = timedOut ? new Error(`Fragment ${index}: reading timed out. Check the SSH connection or try a lower quality.`) : error;
        } finally { clearTimeout(timeout); }
        return request;
      })();
      return request;
    }
    async evict(index, incoming = 0) {
      const seconds = this.descriptor.segmentSeconds, from = Math.max(0, index - 2) * seconds, end = Math.max(index + 2, this.windowEnd(index)), to = (end + 1) * seconds;
      if (from > 0 && this.buffer.buffered.length && this.buffer.buffered.start(0) < from) { await this.update(() => this.buffer.remove(0, from)); }
      if (to < this.descriptor.duration && this.buffer.buffered.length && this.buffer.buffered.end(this.buffer.buffered.length - 1) > to) { await this.update(() => this.buffer.remove(to, this.descriptor.duration + 1)); }
      for (const loaded of this.loaded) { if (loaded < index - 2 || loaded > end) { this.loaded.delete(loaded); this.loadedBytes.delete(loaded); } }
      // Discard history first under byte pressure; never evict the playing clip.
      for (const loaded of [...this.loaded].sort((a, b) => a - b)) {
        if (loaded >= index || this.bufferBytes() + incoming <= this.maxBufferBytes) { break; }
        await this.update(() => this.buffer.remove(loaded * seconds, (loaded + 1) * seconds));
        this.loaded.delete(loaded); this.loadedBytes.delete(loaded);
      }
    }
    async pump() {
      if (this.busy) {
        this.pendingPump = true;
        if (!this.failed && !this.disposed && !this.suspended && this.buffer) { this.trimRequests(); this.fillRequests(this.currentIndex(), this.windowEnd()); }
        return;
      }
      if (this.failed || this.disposed || this.suspended || !this.buffer || this.media.readyState === 'closed') { return; }
      this.busy = true;
      try {
        while (!this.failed && !this.disposed && !this.suspended) {
          const current = this.currentIndex(), generation = this.generation;
          const end = this.windowEnd(current);
          this.trimRequests();
          await this.evict(current);
          if (this.disposed || this.suspended || generation !== this.generation) { continue; }
          this.fillRequests(current, end);
          let index = current; while (index <= end && this.loaded.has(index)) { index++; }
          if (index > end) {
            if (this.loaded.has(Math.ceil(this.descriptor.duration / this.descriptor.segmentSeconds) - 1) && this.media.readyState === 'open' && !this.buffer.updating) { this.media.endOfStream(); }
            break;
          }
          const request = this.requests.get(index);
          if (!request) { break; } // Encoded buffer reached its byte budget.
          this.loadingIndex = index; const signal = request.controller.signal;
          if (!this.loaded.has(current)) { this.onLoading(); }
          await request.promise;
          if (this.disposed || this.suspended || generation !== this.generation || this.requests.get(index) !== request) { continue; }
          if (request.error) { throw request.error; }
          if (signal.aborted) { this.requests.delete(index); continue; }
          const bytes = request.bytes;
          await this.evict(current, bytes.byteLength);
          if (this.disposed || this.suspended || signal.aborted || generation !== this.generation) { continue; }
          if (index !== current && this.bufferBytes() + bytes.byteLength > this.maxBufferBytes) { break; }
          this.buffer.timestampOffset = index * this.descriptor.segmentSeconds;
          // A completed append already ends at a WebM segment boundary. Calling
          // abort() here needlessly resets parser/audio state between every clip.
          await this.update(() => this.buffer.appendBuffer(bytes));
          if (this.requests.get(index) === request) { this.requests.delete(index); }
          if (this.disposed) { continue; }
          this.loaded.add(index); this.loadedBytes.set(index, bytes.byteLength); this.media.duration = this.descriptor.duration;
          this.video.dataset.streamState = `buffered ${[...this.loaded]} · ${this.buffer.buffered.length} ranges`;
          this.onDiagnostic({ stage: 'appended', index, bytes: bytes.byteLength, elapsedMs: performance.now() - request.started, bufferedAhead: this.bufferedAhead(), serverTiming: request.serverTiming, mime: this.descriptor.mime });
        }
      } catch (error) { if (!this.disposed && !this.suspended && error.name !== 'AbortError') { this.fail(error); } }
      finally { this.busy = false; if (this.pendingPump) { this.pendingPump = false; queueMicrotask(() => this.pump()); } }
    }
    fail(error) {
      if (this.failed || this.disposed) { return; }
      this.failed = true; this.cancelRequests();
      const message = String(error.message || error); this.video.dataset.streamError = message;
      this.onDiagnostic({ stage: 'failed', index: this.loadingIndex, message, mime: this.descriptor.mime, mediaCode: this.video.error?.code, mediaMessage: this.video.error?.message });
      if (!this.disposed) { this.onError(message); }
    }
  }
  window.GalleryVideoStream = GalleryVideoStream;
})();

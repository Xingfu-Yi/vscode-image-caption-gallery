(() => {
  'use strict';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
  class GalleryCompare {
    constructor(options) {
      this.options = options; this.records = options.images; this.language = options.language || 'en';
      this.slots = [{}, {}]; this.turns = [0, 0]; this.listeners = []; this.disposed = false;
      this.state = GalleryCompare.normalize(options.state); this.spaceHeld = false; this.visible = true;
      this.root = document.createElement('section'); this.root.className = `compare-view${options.browser ? ' compare-browser' : ''}`; this.root.tabIndex = -1;
      this.root.innerHTML = `<header class="compare-toolbar"><button type="button" data-action="back">←</button><button type="button" data-action="gallery" hidden></button><strong data-label="heading"></strong><span class="compare-spacer"></span><button class="compare-toggle" type="button" data-action="toggle" aria-pressed="false"></button><button type="button" data-action="link"></button><button type="button" data-action="fit"></button><button type="button" data-action="fullscreen"></button></header><div class="compare-panels">${[0, 1].map(i => `<section class="compare-pane" data-side="${i}"><header class="compare-title"><span class="compare-filename"></span><span class="compare-resolution"></span></header><div class="compare-stage"></div><div class="compare-feedback" role="status"><span></span><button type="button" data-retry="${i}"></button><button type="button" data-original="${i}"></button></div><span class="compare-zoom"></span></section>`).join('')}</div>`;
      (options.parent || document.body).append(this.root);
      this.panes = [...this.root.querySelectorAll('.compare-pane')];
      this.stages = [...this.root.querySelectorAll('.compare-stage')];
      this.toggle = this.root.querySelector('[data-action=toggle]');
      this.root.querySelector('[data-label=heading]').textContent = this.text('Compare', '双图对比');
      this.root.querySelector('[data-action=back]').textContent = this.text('← Gallery', '← Gallery');
      this.root.querySelector('[data-action=back]').hidden = !options.onClose;
      const gallery = this.root.querySelector('[data-action=gallery]'); gallery.hidden = !options.onGallery; gallery.textContent = this.text('Gallery', '图库');
      this.root.querySelector('[data-action=fit]').textContent = this.text('Fit', '适合窗口');
      this.root.querySelector('[data-action=fit]').title = this.text('Reset both views · Double-click a pane to fit', '重置两侧视角 · 双击图片适合窗口');
      this.listen(this.root.querySelector('[data-action=back]'), 'click', () => options.onClose?.());
      this.listen(gallery, 'click', () => options.onGallery?.(this.snapshot()));
      this.listen(this.toggle, 'click', () => { if (this.ready() && !this.spaceHeld) { this.state.showingReference = !this.state.showingReference; this.changed(); } this.focus(); });
      this.listen(this.root.querySelector('[data-action=link]'), 'click', () => {
        this.state.linked = !this.state.linked;
        if (this.state.linked) { this.state.views[1] = { ...this.state.views[0] }; }
        this.changed(); this.focus();
      });
      this.listen(this.root.querySelector('[data-action=fit]'), 'click', () => { this.state.views = [GalleryCompare.view(), GalleryCompare.view()]; this.changed(); this.focus(); });
      this.listen(this.root.querySelector('[data-action=fullscreen]'), 'click', () => { this.focus(); options.onFullscreen?.(this.snapshot()); });
      for (let side = 0; side < 2; side++) {
        const stage = this.stages[side];
        this.root.querySelector(`[data-retry="${side}"]`).textContent = this.text('Retry', '重试');
        this.root.querySelector(`[data-original="${side}"]`).textContent = this.text('Load original', '加载原图');
        this.listen(this.root.querySelector(`[data-retry="${side}"]`), 'click', () => this.load(side, true));
        this.listen(this.root.querySelector(`[data-original="${side}"]`), 'click', () => { this.state.originals[side] = true; this.load(side, true); });
        this.listen(stage, 'dblclick', event => { event.preventDefault(); this.changeView(side, GalleryCompare.view()); });
        this.listen(stage, 'wheel', event => this.wheel(side, event), { passive: false });
        this.listen(stage, 'pointerdown', event => { this.activeSide = side; this.startPan(side, event); });
        this.listen(stage, 'pointermove', event => this.movePan(side, event));
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(stage, name, () => { this.pan = null; stage.classList.remove('dragging'); });
      }
      if (options.onCopyFilePath && window.GalleryFileMenu) {
        this.fileMenu = new window.GalleryFileMenu({ root: this.root, language: this.language, copy: options.onCopyFilePath,
          resolveTarget: event => {
            const pane = event.target.closest?.('.compare-pane');
            const keyboard = event.type === 'keydown' && event.target === this.root;
            if (!keyboard && (!pane || !this.root.contains(pane))) return null;
            const side = keyboard ? this.activeSide || 0 : Number(pane.dataset.side), showing = this.ready() && (this.state.showingReference || this.spaceHeld);
            return this.records[side === 0 && showing ? 1 : side];
          } });
      }
      this.listen(document, 'keydown', event => this.key(event), true);
      this.listen(document, 'keyup', event => { if (event.code === 'Space' || event.key === ' ') { if (this.spaceHeld) { event.preventDefault(); event.stopPropagation(); } this.clearSpace(); } }, true);
      this.listen(window, 'blur', () => { this.clearSpace(); this.pan = null; });
      this.listen(document, 'visibilitychange', () => { if (document.hidden) { this.clearSpace(); this.pan = null; } });
      this.listen(document, 'fullscreenchange', () => { this.render(); this.wake(); });
      this.listen(window, 'resize', () => this.render());
      for (const event of ['pointermove', 'pointerdown', 'focusin']) this.listen(this.root, event, () => this.wake());
      if (window.ResizeObserver) { this.resize = new ResizeObserver(() => this.render()); this.stages.forEach(stage => this.resize.observe(stage)); }
      this.render(); this.load(0); this.load(1); this.wake(); this.focus();
    }
    static view(view) { return { zoom: Number.isFinite(view?.zoom) ? clamp(view.zoom, .25, 8) : 1, x: Number.isFinite(view?.x) ? clamp(view.x, 0, 1) : .5, y: Number.isFinite(view?.y) ? clamp(view.y, 0, 1) : .5 }; }
    static normalize(value) { const state = value && typeof value === 'object' ? value : {}; return { linked: state.linked !== false, showingReference: state.showingReference === true, views: [GalleryCompare.view(state.views?.[0]), GalleryCompare.view(state.views?.[1])], originals: [state.originals?.[0] === true, state.originals?.[1] === true] }; }
    text(en, zh) { return this.language.startsWith('zh') ? zh : en; }
    listen(target, event, action, options) { target.addEventListener(event, action, options); this.listeners.push(() => target.removeEventListener(event, action, options)); }
    focus() { this.root.focus({ preventScroll: true }); }
    ready() { return this.slots.every(slot => slot.ready) && Boolean(this.copyReady); }
    snapshot() { return GalleryCompare.normalize(this.state); }
    clearSpace() { if (this.spaceHeld) { this.spaceHeld = false; this.changed(); } }
    async decodeCopy(copy, signal) {
      let timer, abort;
      try {
        const decoded = copy.decode ? copy.decode() : new Promise((resolve, reject) => {
          if (copy.complete && copy.naturalWidth) resolve();
          else { copy.onload = resolve; copy.onerror = () => reject(new Error(this.text('Could not decode the reference copy.', '无法解码参考图副本。'))); }
        });
        await Promise.race([decoded, new Promise((resolve, reject) => {
          abort = () => reject(new Error('Image request cancelled.'));
          timer = setTimeout(() => reject(new Error(this.text('Reference copy loading timed out.', '参考图副本加载超时。'))), 45000);
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        })]);
      } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); copy.onload = null; copy.onerror = null; }
    }
    async load(side, force = false) {
      if (this.disposed || !this.visible) return;
      this.controllers ||= []; this.controllers[side]?.abort(); const controller = new AbortController(); this.controllers[side] = controller;
      const turn = ++this.turns[side]; this.slots[side].ready = false; this.slots[side].error = '';
      if (side === 1) { this.copyReady = false; this.copy?.remove(); this.copy?.removeAttribute('src'); this.copy = null; this.options.onMemory?.(0); }
      this.render();
      try {
        const result = await this.options.load(side, this.state.originals[side], controller.signal, force);
        if (this.disposed || controller.signal.aborted || turn !== this.turns[side]) return;
        this.slots[side] = { ...result, ready: true };
        const image = result.image; image.classList.add('compare-image'); image.draggable = false;
        this.stages[side].replaceChildren(image);
        if (side === 0 && this.copy) this.stages[0].append(this.copy);
        if (side === 1) {
          const copy = document.createElement('img'); copy.className = 'compare-image compare-reference-copy'; copy.alt = this.records[1].name; copy.draggable = false; copy.hidden = true;
          this.copy = copy; copy.src = image.currentSrc || image.src;
          await this.decodeCopy(copy, controller.signal);
          if (this.disposed || controller.signal.aborted || turn !== this.turns[side]) { copy.removeAttribute('src'); return; }
          this.stages[0].append(copy); this.copyReady = true;
          this.options.onMemory?.(image.naturalWidth * image.naturalHeight * 4 * Math.max(1, result.dimensions?.frameCount || 1));
        }
        this.render();
      } catch (error) {
        if (!this.disposed && !controller.signal.aborted && turn === this.turns[side]) { this.slots[side].error = String(error.message || error); this.slots[side].ready = false; this.render(); this.wake(); }
      }
    }
    reload(side) {
      this.clearSpace();
      for (const i of side === undefined ? [0, 1] : [side]) {
        this.controllers?.[i]?.abort(); this.slots[i].ready = false; if (i === 1) this.copyReady = false;
        this.load(i, true);
      }
      this.render();
    }
    setVisible(visible) {
      this.visible = visible; this.clearSpace();
      if (!visible) { this.controllers?.forEach((controller, i) => { if (!this.slots[i].ready || (i === 1 && !this.copyReady)) controller.abort(); }); }
      else this.slots.forEach((slot, i) => { if (!slot.ready || (i === 1 && !this.copyReady)) this.load(i, true); });
    }
    changed() { this.render(); this.options.onChange?.(this.snapshot()); this.wake(); }
    render() {
      if (this.disposed) return;
      const showing = this.ready() && (this.state.showingReference || this.spaceHeld);
      this.root.dataset.showingReference = String(showing); this.root.dataset.ready = String(this.ready());
      this.toggle.disabled = !this.ready(); this.toggle.textContent = showing ? this.text('Left: B', '左侧 B') : this.text('Left: A', '左侧 A'); this.toggle.setAttribute('aria-pressed', String(showing));
      this.toggle.title = showing ? this.text('Restore A · Hold Space for temporary comparison', '恢复 A · 按住空格临时对比') : this.text('Show B on the left · Hold Space for temporary comparison', '左侧显示 B · 按住空格临时对比'); this.toggle.setAttribute('aria-label', this.toggle.title);
      const link = this.root.querySelector('[data-action=link]'); link.textContent = this.state.linked ? this.text('Linked', '联动') : this.text('Independent', '独立'); link.setAttribute('aria-pressed', String(this.state.linked));
      this.root.querySelector('[data-action=fullscreen]').textContent = this.options.browser && document.fullscreenElement ? this.text('Exit full screen · F', '退出全屏 · F') : this.text('Full screen · F', '全屏 · F');
      for (let side = 0; side < 2; side++) {
        const slot = this.slots[side], source = side === 0 && showing ? this.slots[1] : slot, record = this.records[side === 0 && showing ? 1 : side];
        const label = this.panes[side].querySelector('.compare-title'); label.querySelector('.compare-filename').textContent = `${side === 0 && !showing ? 'A' : 'B'} · ${record.name}${side === 0 && showing ? this.text(' · reference copy', ' · 参考图副本') : ''}`;
        const dims = source.dimensions || {}, width = dims.originalWidth || source.image?.naturalWidth, height = dims.originalHeight || source.image?.naturalHeight;
        const resolution = label.querySelector('.compare-resolution'); resolution.textContent = source.ready && width && height ? `${width} × ${height}` : ''; resolution.hidden = !resolution.textContent;
        label.title = `${record.id || record.relativePath || record.name}\n${this.text('Original', '原图')} ${dims.originalWidth || source.image?.naturalWidth || '—'} × ${dims.originalHeight || source.image?.naturalHeight || '—'} · ${this.text('Preview', '预览')} ${dims.width || source.image?.naturalWidth || '—'} × ${dims.height || source.image?.naturalHeight || '—'}`;
        const feedback = this.panes[side].querySelector('.compare-feedback'); feedback.hidden = Boolean(slot.ready);
        feedback.querySelector('span').textContent = slot.error || this.text('Loading image…', '正在加载图片…');
        feedback.querySelector('[data-retry]').hidden = !slot.error;
        feedback.querySelector('[data-original]').hidden = !slot.error || this.state.originals[side];
        this.panes[side].querySelector('.compare-zoom').textContent = `${Math.round(this.state.views[side].zoom * 100)}%`;
        if (slot.image) slot.image.hidden = !slot.ready || (side === 0 && showing);
        if (side === 0 && this.copy) this.copy.hidden = !showing;
        if (source.image) this.transform(side === 0 && showing ? this.copy : source.image, side, source.image);
      }
    }
    geometry(side, image) {
      const bounds = this.stages[side].getBoundingClientRect();
      const width = bounds.width || this.stages[side].clientWidth || 1, height = bounds.height || this.stages[side].clientHeight || 1;
      const fit = Math.min(width / (image?.naturalWidth || 1), height / (image?.naturalHeight || 1));
      return { bounds, width, height, scaledWidth: (image?.naturalWidth || 1) * fit * this.state.views[side].zoom, scaledHeight: (image?.naturalHeight || 1) * fit * this.state.views[side].zoom };
    }
    shownImage(side) { return side === 0 && this.ready() && (this.state.showingReference || this.spaceHeld) ? this.slots[1].image : this.slots[side].image; }
    transform(element, side, image) {
      if (!element) return; const g = this.geometry(side, image), v = this.state.views[side];
      element.style.width = `${g.scaledWidth}px`; element.style.height = `${g.scaledHeight}px`; element.style.transform = `translate(${-v.x * 100}%, ${-v.y * 100}%)`;
    }
    changeView(side, next) { this.state.views[side] = GalleryCompare.view(next); if (this.state.linked) this.state.views[1 - side] = { ...this.state.views[side] }; this.changed(); }
    wheel(side, event) {
      if (!this.slots[side].ready) return; event.preventDefault(); this.wake();
      const image = this.shownImage(side), g = this.geometry(side, image), old = this.state.views[side];
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? g.height : 1;
      if (event.ctrlKey || event.metaKey) {
        const zoom = clamp(old.zoom * Math.exp(-event.deltaY * unit * .002 * (this.options.sensitivity?.() || 5)), .25, 8), factor = zoom / old.zoom;
        const px = event.clientX - g.bounds.left - g.width / 2, py = event.clientY - g.bounds.top - g.height / 2;
        this.changeView(side, { zoom, x: old.x + px / g.scaledWidth * (1 - 1 / factor), y: old.y + py / g.scaledHeight * (1 - 1 / factor) });
      } else this.changeView(side, { ...old, x: old.x + event.deltaX * unit / g.scaledWidth, y: old.y + event.deltaY * unit / g.scaledHeight });
    }
    startPan(side, event) {
      if (event.button !== 0 || !this.slots[side].ready) return; event.preventDefault();
      this.pan = { side, pointer: event.pointerId, x: event.clientX, y: event.clientY, view: { ...this.state.views[side] }, geometry: this.geometry(side, this.shownImage(side)) };
      this.stages[side].setPointerCapture?.(event.pointerId); this.stages[side].classList.add('dragging');
    }
    movePan(side, event) {
      const p = this.pan; if (!p || p.side !== side || p.pointer !== event.pointerId) return;
      this.changeView(side, { ...p.view, x: p.view.x - (event.clientX - p.x) / p.geometry.scaledWidth, y: p.view.y - (event.clientY - p.y) / p.geometry.scaledHeight });
    }
    key(event) {
      if (this.fileMenu?.menu) return;
      if (!this.visible || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.target.closest?.('input,textarea,select,[contenteditable=true]')) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); if (!event.repeat && this.ready()) { this.spaceHeld = true; this.changed(); } return;
      }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) this.options.onFullscreen?.(this.snapshot()); }
      else if (event.key === 'Escape' && this.options.onClose) { event.preventDefault(); event.stopPropagation(); this.options.onClose(); }
    }
    wake() {
      this.root.classList.remove('compare-idle'); clearTimeout(this.idle);
      if (!this.options.browser || this.disposed) return;
      this.idle = setTimeout(() => {
        const active = document.activeElement;
        if (this.fileMenu?.menu || this.spaceHeld || this.pan || this.slots.some(slot => slot.error || !slot.ready) || (active?.tagName === 'BUTTON' && active.matches(':focus-visible'))) { this.wake(); return; }
        this.root.classList.add('compare-idle');
      }, 2000);
    }
    dispose() {
      if (this.disposed) return; this.disposed = true; this.spaceHeld = false;
      this.fileMenu?.dispose();
      this.controllers?.forEach(controller => controller.abort()); this.turns = this.turns.map(turn => turn + 1);
      clearTimeout(this.idle); this.resize?.disconnect(); this.listeners.forEach(remove => remove());
      this.copy?.removeAttribute('src'); this.copy?.remove(); this.options.onMemory?.(0);
      for (const slot of this.slots) { slot.image?.classList.remove('compare-image'); if (slot.image) { slot.image.hidden = false; slot.image.style.width = ''; slot.image.style.height = ''; slot.image.style.transform = ''; slot.image.remove(); } }
      this.root.remove();
    }
  }
  window.GalleryCompare = GalleryCompare;
})();

(() => {
  'use strict';
  class GalleryFileMenu {
    constructor({ root, resolveTarget, copy, language = 'en' }) {
      Object.assign(this, { root, resolveTarget, copy, language });
      this.listeners = [];
      this.listen(root, 'contextmenu', event => this.open(event));
      this.listen(root, 'keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) this.open(event, true);
      });
      this.listen(document, 'keydown', event => {
        if (!this.menu) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(true); }
        else if (event.key === 'Tab') this.close();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.button?.focus(); }
      }, true);
      this.listen(document, 'pointerdown', event => { if (this.menu && !this.menu.contains(event.target)) this.close(); }, true);
      this.listen(document, 'scroll', event => { if (this.menu && !this.menu.contains(event.target)) this.close(); }, true);
      for (const event of ['resize', 'blur', 'pagehide']) this.listen(window, event, () => this.close());
      this.listen(document, 'visibilitychange', () => { if (document.hidden) this.close(); });
      this.listen(document, 'fullscreenchange', () => this.close());
    }
    text(en, zh) { return String(typeof this.language === 'function' ? this.language() : this.language).startsWith('zh') ? zh : en; }
    listen(target, event, handler, options) { target.addEventListener(event, handler, options); this.listeners.push(() => target.removeEventListener(event, handler, options)); }
    open(event, keyboard = false) {
      if (this.disposed) return;
      if (event.defaultPrevented || event.target.closest?.('input, textarea, select, [contenteditable]')) { this.close(); return; }
      const target = this.resolveTarget(event);
      if (!target) { this.close(); return; }
      event.preventDefault(); event.stopPropagation(); this.close();
      const chosen = { ...target }, previousFocus = document.activeElement;
      const menu = document.createElement('div'), button = document.createElement('button'), status = document.createElement('span');
      menu.className = 'gallery-file-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', this.text('File actions', '文件操作'));
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = this.text('Copy File Path', '复制文件路径');
      status.className = 'gallery-file-menu-status'; status.setAttribute('role', 'alert'); status.hidden = true;
      menu.append(button, status); this.root.append(menu); this.menu = menu; this.button = button; this.previousFocus = previousFocus;
      const anchor = event.target.getBoundingClientRect?.();
      const x = keyboard ? anchor?.left || 0 : event.clientX || 0, y = keyboard ? anchor?.bottom || 0 : event.clientY || 0;
      this.place(menu, x, y);
      button.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation(); if (button.disabled) return;
        button.disabled = true; status.hidden = true;
        try {
          // Invoke synchronously in the gesture: browser clipboard access may
          // require user activation. Keep the original menu target throughout.
          await this.copy(chosen);
          if (this.menu === menu) this.close(true);
        } catch (error) {
          if (this.menu !== menu) return;
          button.disabled = false; status.hidden = false;
          status.textContent = this.text('Could not copy. Try again.', '复制失败，请重试。'); status.title = String(error?.message || error); button.focus();
          this.place(menu, x, y);
        }
      });
      button.focus({ preventScroll: true });
    }
    place(menu, x, y) {
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`;
    }
    close(restoreFocus = false) {
      const focus = this.previousFocus;
      this.menu?.remove(); this.menu = null; this.button = null; this.previousFocus = null;
      if (restoreFocus && focus?.isConnected) focus.focus?.({ preventScroll: true });
    }
    dispose() { this.disposed = true; this.close(); this.listeners.forEach(remove => remove()); this.listeners = []; }
    static writeText(value) {
      if (typeof value !== 'string' || !value) return Promise.reject(new Error('Original file path is unavailable.'));
      const fallback = () => {
        const active = document.activeElement, selection = window.getSelection(), ranges = [];
        for (let i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
        const field = document.createElement('textarea'); field.value = value; field.readOnly = true;
        field.className = 'gallery-copy-field'; field.setAttribute('aria-label', 'File path');
        (document.fullscreenElement || document.body).append(field);
        let copied = false;
        try { field.focus({ preventScroll: true }); field.select(); copied = document.execCommand?.('copy') === true; }
        finally {
          field.remove(); if (active?.isConnected) active.focus?.({ preventScroll: true });
          if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
        }
        if (!copied) throw new Error('Clipboard access was denied. Allow clipboard access in the browser and retry.');
      };
      try {
        if (navigator.clipboard?.writeText) return Promise.resolve(navigator.clipboard.writeText(value)).catch(fallback);
      } catch { /* A synchronous browser permission failure can use the fallback. */ }
      try { fallback(); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
    }
  }
  window.GalleryFileMenu = GalleryFileMenu;
})();

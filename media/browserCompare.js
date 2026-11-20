(() => {
  'use strict';
  let comparison, records, language = 'en', disposed = false, checking = false, heartbeat, galleryLink;
  const resources = [null, null], stateController = new AbortController();
  const storageKey = `gallery-comparison:${location.pathname}`;
  const text = (en, zh) => language === 'zh' ? zh : en;
  const endpoint = (name, params = {}) => {
    const url = new URL(name, location.href); url.search = location.search;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url;
  };
  function galleryUrl() {
    if (!galleryLink || !/^[a-f0-9]{64}$/.test(galleryLink.token) || !Number.isSafeInteger(galleryLink.index) || galleryLink.index < 0) { return null; }
    const url = new URL(location.href), marker = /\/(?:v1|images|gallery)\/[a-f0-9]{64}\//.exec(url.pathname);
    if (!marker) { return null; }
    url.pathname = `${url.pathname.slice(0, marker.index)}/gallery/${galleryLink.token}/viewer`;
    url.searchParams.set('selected', String(galleryLink.index));
    return url;
  }
  function openGallery() {
    const url = galleryUrl(); if (!url) { return; }
    try { sessionStorage.setItem(storageKey, JSON.stringify(comparison.snapshot())); } catch { /* Browser storage is optional. */ }
    location.href = url.toString();
  }
  function discard(side) {
    const entry = resources[side]; resources[side] = null;
    if (entry) { entry.controller.abort(); entry.image.removeAttribute('src'); if (entry.url) URL.revokeObjectURL(entry.url); }
  }
  async function load(side, original, signal, force) {
    let entry = resources[side];
    if (entry && !force && entry.original === original && entry.version === records[side].version) return entry.promise;
    discard(side);
    const controller = new AbortController(), image = new Image(); image.alt = records[side].name;
    entry = { controller, image, original, version: records[side].version }; resources[side] = entry;
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 45000);
    entry.promise = (async () => {
      try {
        const response = await fetch(endpoint(`image/${side}`, { original: original ? 1 : 0, version: entry.version }), { signal: controller.signal });
        if (!response.ok) throw new Error((await response.text()).slice(0, 500) || `HTTP ${response.status}`);
        const blob = await response.blob(); if (controller.signal.aborted) throw new Error(text('Image loading interrupted.', '图片加载已中断。'));
        entry.url = URL.createObjectURL(blob); image.src = entry.url; await image.decode();
        if (controller.signal.aborted || disposed) throw new Error(text('Image loading interrupted.', '图片加载已中断。'));
        const header = name => Number(response.headers.get(`X-Image-${name}`)) || undefined;
        return { image, dimensions: { width: image.naturalWidth, height: image.naturalHeight, originalWidth: header('Original-Width'), originalHeight: header('Original-Height'), frameCount: header('Frames') } };
      } catch (error) {
        if (resources[side] === entry) discard(side);
        if (timedOut) throw new Error(text('Image loading timed out. Retry or load the original.', '图片加载超时，请重试或加载原图。'));
        throw error;
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
    })();
    return entry.promise;
  }
  function fullscreen() {
    comparison.focus(); comparison.wake();
    const action = document.fullscreenElement ? document.exitFullscreen() : comparison.root.requestFullscreen?.();
    if (action) void action.catch(error => { comparison.root.querySelector('[data-action=fullscreen]').title = error.message; });
  }
  async function checkVersions() {
    if (!comparison || disposed || checking || document.hidden) return;
    checking = true;
    try {
      const response = await fetch(endpoint('state'), { signal: stateController.signal });
      if (!response.ok) throw new Error(text('Session expired. Reopen comparison from Gallery.', '会话已过期，请从 Gallery 重新打开对比。'));
      const data = await response.json(); if (disposed) return;
      data.images.forEach((record, side) => {
        const changed = record.version !== records[side].version; records[side] = record;
        if (changed) comparison.reload(side);
      });
    } catch (error) {
      if (!disposed) { comparison.root.querySelector('[data-label=heading]').textContent = error.message; comparison.wake(); }
    } finally { checking = false; }
  }
  async function start() {
    try {
      const response = await fetch(endpoint('state'), { signal: stateController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (disposed) return;
      records = data.images; language = data.language; galleryLink = data.gallery;
      document.documentElement.lang = language; document.title = `${records[0].name} | ${records[1].name} — Gallery`;
      let state = data.comparison;
      try { state = JSON.parse(sessionStorage.getItem(storageKey)) || state; } catch { /* Browser storage is optional. */ }
      document.getElementById('startup').remove();
      comparison = new window.GalleryCompare({ images: records, language, state, browser: true, load, onFullscreen: fullscreen, onGallery: galleryUrl() ? openGallery : undefined,
        onCopyFilePath: record => window.GalleryFileMenu.writeText(record.filePath),
        onChange: next => { try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage unavailable. */ } } });
      heartbeat = setInterval(() => {
        void fetch(endpoint('heartbeat'), { method: 'POST', signal: stateController.signal }).catch(() => {}); void checkVersions();
      }, 15000);
    } catch (error) {
      if (!disposed) document.getElementById('startup').textContent = `${text('Could not open comparison', '无法打开对比')}: ${error.message}`;
    }
  }
  window.addEventListener('focus', () => { void checkVersions(); });
  document.addEventListener('visibilitychange', () => { comparison?.setVisible(!document.hidden); if (!document.hidden) void checkVersions(); });
  window.addEventListener('pagehide', () => { disposed = true; clearInterval(heartbeat); stateController.abort(); comparison?.dispose(); discard(0); discard(1); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  void start();
})();

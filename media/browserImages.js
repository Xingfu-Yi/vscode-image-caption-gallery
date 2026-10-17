(() => {
  'use strict';
  const viewer = document.getElementById('viewer'), stage = document.getElementById('stage');
  const title = document.getElementById('title'), position = document.getElementById('position');
  const status = document.getElementById('status'), retry = document.getElementById('retry');
  const previous = document.getElementById('previous'), next = document.getElementById('next'), fullscreen = document.getElementById('fullscreen');
  const entries = new Map(), records = new Map(), skipped = new Set();
  const maxBytes = 128 * 1024 * 1024;
  const client = crypto.getRandomValues(new Uint32Array(4)).join('-');
  let index = 0, total = 0, displayed = -1, sequence = 0, language = 'en', clock = 0, disposed = false;
  let idleTimer, loadingTimer, stateRequest, heartbeat, touchStart;
  const text = (en, zh) => language === 'zh' ? zh : en;
  const endpoint = (name, params = {}) => {
    const url = new URL(name, location.href); url.search = location.search;
    if (name === 'state') { url.searchParams.set('view', client); }
    for (const [key, value] of Object.entries(params)) { url.searchParams.set(key, String(value)); }
    return url;
  };
  function showStatus(message = '', failed = false) { status.textContent = message; retry.hidden = !failed; if (message) { wake(); } }
  function wake() {
    clearTimeout(idleTimer); viewer.classList.remove('idle');
    idleTimer = setTimeout(() => {
      const active = document.activeElement;
      if (status.textContent || document.querySelector('button:hover') || (active?.tagName === 'BUTTON' && active.matches(':focus-visible'))) { wake(); return; }
      viewer.classList.add('idle');
    }, 2000);
  }
  function updateControls() {
    previous.disabled = index <= 0; next.disabled = index >= total - 1;
    position.textContent = total ? `${index + 1} / ${total}` : '';
    const record = records.get(index);
    title.textContent = record?.relativePath ?? text('Image', '图片'); title.title = title.textContent;
    document.title = `${record?.name ?? text('Images', '图片')} — Gallery`;
    fullscreen.textContent = document.fullscreenElement ? text('Exit full screen · Esc', '退出全屏 · Esc') : text('View full screen · F', '进入全屏 · F');
    previous.setAttribute('aria-label', text('Previous image (←)', '上一张（←）')); next.setAttribute('aria-label', text('Next image (→)', '下一张（→）'));
    retry.textContent = text('Retry', '重试'); document.documentElement.lang = language;
  }
  function discard(entry) {
    if (entries.get(entry.index) === entry) { entries.delete(entry.index); }
    entry.controller.abort(); if (entry.url) { URL.revokeObjectURL(entry.url); }
    if (entry.index !== displayed) { entry.image.removeAttribute('src'); }
  }
  function prune() {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    const candidates = [...entries.values()].filter(entry => entry.index !== displayed && entry.index !== index).sort((a, b) => a.used - b.used);
    for (const entry of candidates) {
      if (entries.size <= 7 && bytes <= maxBytes) { break; }
      bytes -= entry.bytes || 0; discard(entry);
    }
  }
  function prepare(target, prefetch = false) {
    let entry = entries.get(target);
    if (entry) { entry.used = ++clock; return entry.promise; }
    const image = new Image(), controller = new AbortController(); image.alt = records.get(target)?.name ?? `${text('Image', '图片')} ${target + 1}`; image.draggable = false;
    entry = { index: target, image, controller, used: ++clock, bytes: 0, version: records.get(target)?.version };
    entries.set(target, entry);
    entry.promise = (async () => {
      const response = await fetch(endpoint(`image/${target}`, { prefetch: prefetch ? 1 : 0 }), { signal: controller.signal });
      if (response.status === 204) { skipped.add(target); return null; }
      if (!response.ok) { throw new Error((await response.text()).slice(0, 500) || `HTTP ${response.status}`); }
      const blob = await response.blob(); if (controller.signal.aborted) { return null; }
      entry.url = URL.createObjectURL(blob); image.src = entry.url;
      await image.decode();
      if (controller.signal.aborted || disposed) { return null; }
      entry.bytes = image.naturalWidth * image.naturalHeight * 4 * Math.max(1, Number(response.headers.get('X-Image-Frames')) || 1);
      entry.ready = true; prune(); return entry;
    })().then(result => { if (!result && entries.get(target) === entry) { discard(entry); } return result; }, error => { discard(entry); throw error; });
    return entry.promise;
  }
  function prefetchNeighbours() {
    if (disposed) { return; }
    for (const target of [index - 1, index + 1]) {
      if (target >= 0 && target < total && !skipped.has(target)) { void prepare(target, true).catch(() => {}); }
    }
    for (const entry of entries.values()) { if (!entry.ready && Math.abs(entry.index - index) > 1 && entry.index !== displayed) { discard(entry); } }
    prune();
  }
  async function refreshState(target, turn) {
    stateRequest?.abort(); const controller = new AbortController(); stateRequest = controller;
    try {
      const response = await fetch(endpoint('state', { index: target, sequence: turn }), { signal: controller.signal });
      if (!response.ok) { throw new Error(text('Viewer expired. Open full screen from Gallery again.', '浏览会话已过期，请从 Gallery 重新打开全屏。')); }
      const data = await response.json();
      if (turn !== sequence || disposed) { return; }
      total = data.total; language = data.language;
      let changed = false;
      for (const record of data.images) {
        const old = records.get(record.index), entry = entries.get(record.index);
        records.set(record.index, record);
        if (old && old.version !== record.version) {
          skipped.delete(record.index);
          if (entry) { discard(entry); if (record.index === index) { changed = true; } }
        } else if (entry && !entry.version) { entry.version = record.version; }
      }
      updateControls(); if (changed) { void navigate(index); } else { prefetchNeighbours(); }
    } catch (error) { if (turn === sequence && error.name !== 'AbortError') { showStatus(error.message, true); } }
  }
  async function navigate(target) {
    if (disposed || target < 0 || target >= total) { return; }
    const turn = ++sequence; index = target; updateControls(); wake();
    clearTimeout(loadingTimer); showStatus();
    // Keep the last decoded image until the selected one is actually ready.
    viewer.classList.toggle('switching', displayed >= 0 && displayed !== index && !entries.get(target)?.ready);
    loadingTimer = setTimeout(() => { if (turn === sequence) { showStatus(text('Switching image…', '正在切换图片…')); } }, 150);
    void refreshState(target, turn); // Stat/version checks never block a warm swap.
    // Start the foreground request before neighbouring work reaches the host.
    let prepared = prepare(target); prefetchNeighbours();
    try {
      let entry = await prepared;
      // A selected neighbour may have exceeded the background memory budget.
      if (!entry && turn === sequence) { entry = await prepare(target); }
      if (!entry || turn !== sequence || disposed) { return; }
      const old = stage.firstElementChild;
      stage.replaceChildren(entry.image); displayed = target; entry.used = ++clock;
      if (old && old !== entry.image && ![...entries.values()].some(item => item.image === old)) { old.removeAttribute('src'); }
      clearTimeout(loadingTimer); viewer.classList.remove('switching'); showStatus();
      prune(); prefetchNeighbours();
    } catch (error) {
      if (turn === sequence && error.name !== 'AbortError') { clearTimeout(loadingTimer); viewer.classList.remove('switching'); showStatus(`${text('Could not load image', '无法加载图片')}: ${error.message}`, true); }
    }
  }
  function toggleFullscreen() {
    viewer.focus({ preventScroll: true }); wake();
    // Must run directly inside the click/key gesture, before any async work.
    const action = document.fullscreenElement ? document.exitFullscreen() : viewer.requestFullscreen?.();
    if (!action) { showStatus(text('Use your browser’s full screen command.', '请使用浏览器的全屏命令。')); return; }
    void action.catch(error => showStatus(`${text('Full screen unavailable', '无法进入全屏')}: ${error.message}`));
  }
  fullscreen.addEventListener('click', toggleFullscreen);
  viewer.addEventListener('dblclick', event => { if (!event.target.closest('button')) { toggleFullscreen(); } });
  previous.addEventListener('click', () => { viewer.focus({ preventScroll: true }); void navigate(index - 1); });
  next.addEventListener('click', () => { viewer.focus({ preventScroll: true }); void navigate(index + 1); });
  retry.addEventListener('click', () => { const entry = entries.get(index); if (entry) { discard(entry); } void navigate(index); });
  document.addEventListener('fullscreenchange', () => { updateControls(); wake(); });
  for (const event of ['pointermove', 'pointerdown', 'focusin']) { viewer.addEventListener(event, wake); }
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) { return; }
    wake();
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { viewer.focus({ preventScroll: true }); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); void navigate(index - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); void navigate(index + 1); }
    else if (event.key === 'Home') { event.preventDefault(); void navigate(0); }
    else if (event.key === 'End') { event.preventDefault(); void navigate(total - 1); }
    else if (event.key.toLowerCase() === 'f') { event.preventDefault(); toggleFullscreen(); }
  });
  viewer.addEventListener('touchstart', event => { wake(); touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }, { passive: true });
  viewer.addEventListener('touchend', event => {
    if (!touchStart || !event.changedTouches.length || event.target.closest('button')) { return; }
    const x = event.changedTouches[0].clientX - touchStart.x, y = event.changedTouches[0].clientY - touchStart.y; touchStart = null;
    if (Math.abs(x) > 60 && Math.abs(x) > Math.abs(y) * 2) { void navigate(index + (x < 0 ? 1 : -1)); }
  }, { passive: true });
  window.addEventListener('pagehide', () => {
    disposed = true; clearInterval(heartbeat); clearTimeout(idleTimer); clearTimeout(loadingTimer); stateRequest?.abort();
    for (const entry of entries.values()) { discard(entry); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) { location.reload(); } });
  async function start() {
    showStatus(text('Loading image…', '正在加载图片…'));
    try {
      const response = await fetch(endpoint('state')); if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
      const data = await response.json(); if (disposed) { return; }
      total = data.total; index = data.index; language = data.language;
      for (const image of data.images) { records.set(image.index, image); }
      heartbeat = setInterval(() => { void fetch(endpoint('heartbeat'), { method: 'POST' }).catch(() => {}); }, 15000);
      await navigate(index);
    } catch (error) { showStatus(`${text('Could not open viewer', '无法打开图片浏览器')}: ${error.message}`, true); }
  }
  void start();
})();

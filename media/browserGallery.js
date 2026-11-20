(() => {
  'use strict';
  const root = document.getElementById('browser-gallery'), viewport = document.getElementById('gallery-viewport'), element = document.getElementById('gallery-grid');
  const search = document.getElementById('gallery-search'), count = document.getElementById('gallery-count'), status = document.getElementById('gallery-status'), fullscreen = document.getElementById('gallery-fullscreen');
  const token = /\/gallery\/([a-f0-9]{64})\//.exec(location.pathname)?.[1], pageSize = 256, maxPages = 12, maxThumbnails = 4;
  const storedKey = `gallery-grid:${token}`;
  const selectedParameter = new URL(location.href).searchParams.get('selected');
  let language = 'en', generation = 0, total = 0, selected = selectedParameter === null ? Number.NaN : Number(selectedParameter), restoredState = false;
  let items = null, disposed = false, searchTimer = null, heartbeat = null, clock = 0, activeThumbnails = 0, fileMenu;
  const pages = new Map(), pageRequests = new Map(), thumbnailQueue = [], thumbnailJobs = new Map(), records = new WeakMap();
  const text = (en, zh) => language === 'zh' ? zh : en;
  const endpoint = (name, params = {}) => {
    const url = new URL(name, location.href); url.search = location.search;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url;
  };
  const route = path => {
    if (!/^\/(?:images|v1)\/[a-f0-9]{64}\/(?:viewer|player)$/.test(path)) { throw new Error(text('The viewer returned an invalid address.', '浏览器返回了无效地址。')); }
    const url = new URL(location.href), marker = /\/(?:v1|images|gallery)\/[a-f0-9]{64}\//.exec(url.pathname);
    if (!marker) throw new Error(text('Could not resolve the private Gallery address.', '无法解析私有 Gallery 地址。'));
    url.pathname = url.pathname.slice(0, marker.index) + path; url.searchParams.delete('selected'); return url;
  };
  const save = () => {
    try { sessionStorage.setItem(storedKey, JSON.stringify({ search: search.value, scrollTop: viewport.scrollTop, selected })); } catch { /* Browser storage is optional. */ }
  };
  function restore() {
    try {
      const state = JSON.parse(sessionStorage.getItem(storedKey));
      if (state && typeof state.search === 'string') { search.value = state.search.slice(0, 4096); restoredState = true; }
      if (!Number.isSafeInteger(selected) && Number.isSafeInteger(state?.selected)) selected = state.selected;
      return Number.isFinite(state?.scrollTop) ? Math.max(0, state.scrollTop) : 0;
    } catch { return 0; }
  }
  let restoredScroll = restore();
  function message(value = '', failed = false) { status.textContent = value; status.classList.toggle('error', failed); }
  function updateLabels() {
    document.documentElement.lang = language; count.textContent = `${total} ${text(total === 1 ? 'file' : 'files', '个文件')}`;
    search.placeholder = text('Search media…', '搜索媒体…');
    fullscreen.textContent = document.fullscreenElement ? text('Exit full screen · Esc', '退出全屏 · Esc') : text('Full screen · F', '全屏 · F');
  }
  function placeholder(offset) { return { id: `pending:${generation}:${offset}`, index: offset, offset, placeholder: true, name: text('Loading…', '加载中…'), relativePath: '' }; }
  function itemSource(size) {
    const target = new Array(size);
    return new Proxy(target, { get(array, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) { const offset = Number(property); return Reflect.get(array, property, receiver) || placeholder(offset); }
      return Reflect.get(array, property, receiver);
    } });
  }
  function prunePages() {
    if (pages.size <= maxPages || !grid.columns || !grid.step) return;
    const centerOffset = Math.floor(((viewport.scrollTop + viewport.clientHeight / 2) / grid.step) * grid.columns);
    const candidates = [...pages.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [offset, page] of candidates) {
      if (pages.size <= maxPages) break;
      if (Math.abs(offset + pageSize / 2 - centerOffset) < pageSize * 2) continue;
      for (let index = offset; index < Math.min(total, offset + pageSize); index++) items[index] = undefined;
      pages.delete(offset);
    }
  }
  async function loadPage(offset) {
    offset = Math.max(0, Math.floor(offset / pageSize) * pageSize);
    const known = pages.get(offset); if (known) { known.used = ++clock; return; }
    if (pageRequests.has(offset)) return pageRequests.get(offset).promise;
    const turn = generation, controller = new AbortController();
    const request = (async () => {
      try {
        const response = await fetch(endpoint('list', { offset, limit: pageSize, q: search.value.trim() }), { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error((await response.text()).slice(0, 500) || `HTTP ${response.status}`);
        const data = await response.json(); if (disposed || turn !== generation) return;
        if (!restoredState && !search.value && typeof data.query === 'string') { search.value = data.query.slice(0, 4096); }
        const nextLanguage = data.language === 'zh' ? 'zh' : 'en';
        if (language !== nextLanguage || !fileMenu) { language = nextLanguage; installFileMenu(); }
        if (!items || total !== data.total) { total = data.total; items = itemSource(total); grid.setItems(items); }
        if (!Number.isSafeInteger(selected)) selected = data.selected;
        for (let index = offset; index < Math.min(total, offset + pageSize); index++) items[index] = undefined;
        data.items.forEach((record, index) => { items[offset + index] = record; });
        pages.set(offset, { used: ++clock }); updateLabels(); grid.render(); prunePages(); message();
      } catch (error) { if (!controller.signal.aborted && turn === generation) message(`${text('Could not load Gallery', '无法加载 Gallery')}: ${error.message}`, true); }
      finally { if (pageRequests.get(offset)?.promise === request) pageRequests.delete(offset); }
    })();
    pageRequests.set(offset, { promise: request, controller }); return request;
  }
  function clearData() {
    for (const request of pageRequests.values()) request.controller.abort();
    pageRequests.clear(); pages.clear(); items = null; total = 0; grid.clear();
  }
  async function startQuery() {
    generation++; clearData(); message(text('Loading Gallery…', '正在加载 Gallery…'));
    const initial = !search.value.trim() && Number.isSafeInteger(selected) ? Math.floor(selected / pageSize) * pageSize : 0;
    await loadPage(initial);
    if (!items || disposed) return;
    if (restoredScroll && !search.value.trim()) viewport.scrollTop = restoredScroll;
    else if (!search.value.trim() && Number.isSafeInteger(selected) && grid.columns && grid.step) viewport.scrollTop = Math.max(0, Math.floor(selected / grid.columns) * grid.step - 18);
    restoredScroll = 0;
    grid.render(); save();
  }
  function ensurePage(offset) { void loadPage(offset); }
  function pumpThumbnails() {
    while (!disposed && activeThumbnails < maxThumbnails && thumbnailQueue.length) {
      const job = thumbnailQueue.shift();
      if (job.cancelled || !job.card.isConnected || thumbnailJobs.get(job.card) !== job) continue;
      activeThumbnails++; job.active = true;
      void (async () => {
        try {
          const response = await fetch(endpoint(`thumbnail/${job.record.index}`), { signal: job.controller.signal, credentials: 'omit' });
          if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `HTTP ${response.status}`);
          const blob = await response.blob(); if (job.controller.signal.aborted || !job.card.isConnected) return;
          job.url = URL.createObjectURL(blob); const image = new Image(); image.alt = job.record.name; image.src = job.url; image.draggable = false;
          await image.decode(); if (job.controller.signal.aborted || !job.card.isConnected) return;
          job.card.querySelector('.browser-card-media').replaceChildren(image, ...(job.record.kind === 'video' ? [playBadge()] : []));
          job.card.classList.add('thumbnail-ready');
        } catch (error) {
          if (!job.controller.signal.aborted && job.card.isConnected) {
            const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'thumbnail-retry'; retry.textContent = text('Retry', '重试');
            retry.addEventListener('click', event => { event.stopPropagation(); cancelThumbnail(job.card); queueThumbnail(job.card, job.record); });
            job.card.querySelector('.browser-card-media').replaceChildren(retry);
          }
        } finally { activeThumbnails--; if (thumbnailJobs.get(job.card) === job && !job.url) thumbnailJobs.delete(job.card); pumpThumbnails(); }
      })();
    }
  }
  function playBadge() { const badge = document.createElement('span'); badge.className = 'video-badge'; badge.textContent = '▶'; badge.setAttribute('aria-hidden', 'true'); return badge; }
  function queueThumbnail(card, record) {
    if (record.placeholder || thumbnailJobs.has(card)) return;
    const job = { card, record, controller: new AbortController(), cancelled: false, active: false, url: null };
    thumbnailJobs.set(card, job); thumbnailQueue.push(job); pumpThumbnails();
  }
  function cancelThumbnail(card) {
    const job = thumbnailJobs.get(card); if (!job) return;
    thumbnailJobs.delete(card); job.cancelled = true; job.controller.abort(); if (job.url) URL.revokeObjectURL(job.url);
  }
  const visibility = window.IntersectionObserver ? new IntersectionObserver(entries => {
    for (const entry of entries) { const record = records.get(entry.target); if (entry.isIntersecting) queueThumbnail(entry.target, record); else cancelThumbnail(entry.target); }
  }, { root: viewport }) : null;
  function createCard(record) {
    const card = document.createElement('article'); card.className = 'image-card browser-card'; card.tabIndex = 0; records.set(card, record);
    if (record.placeholder) {
      card.classList.add('placeholder'); card.innerHTML = `<div class="browser-card-media"></div><span>${text('Loading…', '加载中…')}</span>`;
      ensurePage(record.offset); return card;
    }
    card.classList.toggle('selected', record.index === selected); card.title = `${record.filePath || record.relativePath}\n${record.kind === 'video' ? text('Video', '视频') : text('Image', '图片')}`;
    const media = document.createElement('div'); media.className = 'browser-card-media';
    const label = document.createElement('span'); label.textContent = record.name; card.append(media, label);
    const open = event => { if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return; event.preventDefault(); void openRecord(record); };
    card.addEventListener('click', open); card.addEventListener('keydown', open);
    if (visibility) visibility.observe(card); else queueThumbnail(card, record);
    return card;
  }
  function releaseCard(card) { visibility?.unobserve(card); cancelThumbnail(card); records.delete(card); }
  async function openRecord(record) {
    if (disposed) return; selected = record.index; save(); message(text('Opening…', '正在打开…'));
    let playback;
    if (record.kind === 'video') { try { playback = JSON.parse(sessionStorage.getItem(`gallery-playback:${token}:${record.index}`)); } catch { /* Ignore malformed local state. */ } }
    try {
      const response = await fetch(endpoint(`open/${record.index}`), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(playback || {}) });
      if (!response.ok) throw new Error((await response.text()).slice(0, 500) || `HTTP ${response.status}`);
      const data = await response.json(), url = route(data.path); location.href = url.toString();
    } catch (error) { message(`${text('Could not open file', '无法打开文件')}: ${error.message}`, true); }
  }
  const grid = new window.GalleryGrid(element, viewport, createCard, releaseCard, () => { save(); prunePages(); });
  function installFileMenu() {
    fileMenu?.dispose();
    fileMenu = window.GalleryFileMenu ? new window.GalleryFileMenu({ root, language,
      resolveTarget: event => { const card = event.target.closest?.('.browser-card'); const record = card && records.get(card); return record?.filePath ? record : null; },
      copy: record => window.GalleryFileMenu.writeText(record.filePath) }) : null;
  }
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { selected = -1; void startQuery(); }, 180); });
  viewport.addEventListener('scroll', save, { passive: true });
  fullscreen.addEventListener('click', () => { const action = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.(); if (action) void action.catch(error => message(error.message, true)); });
  document.addEventListener('fullscreenchange', updateLabels);
  document.addEventListener('keydown', event => { if (fileMenu?.menu || event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return; if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen.click(); } });
  window.addEventListener('pagehide', () => {
    disposed = true; save(); clearTimeout(searchTimer); clearInterval(heartbeat); fileMenu?.dispose(); visibility?.disconnect();
    for (const card of [...thumbnailJobs.keys()]) cancelThumbnail(card); grid.clear();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  heartbeat = setInterval(() => { if (!document.hidden) void fetch(endpoint('heartbeat'), { method: 'POST', credentials: 'omit' }).catch(() => {}); }, 15000);
  void startQuery();
})();

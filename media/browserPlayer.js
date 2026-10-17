(async () => {
  const root = document.querySelector('#player'), video = document.querySelector('#video'), controls = document.querySelector('#controls');
  const quality = document.querySelector('#quality'), rate = document.querySelector('#rate'), fullscreen = document.querySelector('#fullscreen');
  const status = document.querySelector('#status'), original = document.querySelector('#original');
  const zh = navigator.language.startsWith('zh'), text = (en, cn) => zh ? cn : en;
  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  for (const item of document.querySelectorAll('[data-en]')) { item.textContent = item.dataset[zh ? 'zh' : 'en']; }
  let hls = null, descriptor = null, generation = 0, request = null, desired = null, idle = null, retry = 0, compatible = false, boot = null, metadataListener = null, pointerOverNative = false;
  const endpoint = (name, token) => {
    const url = new URL(location.href);
    if (token) { url.pathname = url.pathname.replace(/\/v1\/[a-f0-9]{64}\/[^/]*$/, `/v1/${token}/${name}`); }
    else { url.pathname = url.pathname.replace(/[^/]*$/, name); }
    return url;
  };
  const capture = () => ({ time: video.currentTime || 0, rate: video.playbackRate || Number(rate.value) || 1, volume: video.volume, muted: video.muted, playing: !video.paused });
  const message = (value, error = false) => { const changed = status.textContent !== value || status.classList.contains('error') !== error; status.textContent = value; status.classList.toggle('error', error); if (changed) { wake(); } };
  function wake() {
    clearTimeout(idle); root.classList.remove('controls-hidden'); video.controls = true;
    if (document.fullscreenElement && !video.paused && !status.classList.contains('error') && !controls.contains(document.activeElement) && !controls.matches(':hover') && !pointerOverNative) {
      idle = setTimeout(() => { if (!video.paused && !controls.contains(document.activeElement)) { root.classList.add('controls-hidden'); video.controls = false; } }, 2000);
    }
  }
  function disposeStream() { request?.abort(); request = null; hls?.destroy(); hls = null; if (metadataListener) { video.removeEventListener('loadedmetadata', metadataListener); metadataListener = null; } }
  async function load(state, force = false) {
    const id = ++generation; disposeStream(); video.pause(); desired = state; compatible = force; descriptor = null;
    video.removeAttribute('src'); video.load();
    request = new AbortController(); const signal = request.signal;
    original.hidden = true; message(text('Preparing video…', '正在准备视频…'));
    try {
      const url = endpoint('state'); url.searchParams.set('quality', quality.value); if (force) { url.searchParams.set('compatible', '1'); } if (state?.native) { url.searchParams.set('native', '1'); }
      const response = await fetch(url, { signal, credentials: 'omit' });
      if (!response.ok) { throw new Error((await response.text()).slice(0, 500)); }
      const data = await response.json(); if (id !== generation) { return; }
      boot ||= data;
      document.querySelector('#title').textContent = data.title; document.title = data.title + ' · Gallery Video';
      if (!state) { state = { ...data.state, playing: false }; quality.value = String(data.state.quality); }
      desired = state; descriptor = data.video;
      if (![...rate.options].some(option => Number(option.value) === state.rate)) { rate.add(new Option(`${state.rate}×`, state.rate)); }
      rate.value = String(state.rate); video.playbackRate = state.rate; video.defaultPlaybackRate = state.rate; video.volume = state.volume; video.muted = state.muted;
      document.querySelector('#dimensions').textContent = descriptor.previewWidth ? `${descriptor.previewWidth} × ${descriptor.previewHeight}` : '';
      metadataListener = () => {
        if (id !== generation) { return; }
        const time = Math.min(state.time, Number.isFinite(video.duration) ? Math.max(0, video.duration - .05) : state.time);
        if (Math.abs(video.currentTime - time) > .05) { video.currentTime = time; }
        video.playbackRate = state.rate; video.volume = state.volume; video.muted = state.muted;
        if (state.playing) { void video.play().catch(() => message(text('Press Play to continue.', '请点击播放继续。'))); }
      };
      video.addEventListener('loadedmetadata', metadataListener, { once: true });
      if (!descriptor.stream) { video.src = endpoint('original', descriptor.token).toString(); video.load(); }
      else {
        const source = endpoint('manifest.m3u8', descriptor.token).toString();
        if (window.Hls?.isSupported()) {
          hls = new Hls({ enableWorker: true, autoStartLoad: false, startPosition: state.time, maxBufferLength: 8, maxMaxBufferLength: 12, backBufferLength: 8, maxBufferSize: 32 * 1024 * 1024 });
          const active = hls;
          active.on(Hls.Events.MANIFEST_PARSED, () => { if (id === generation) { active.startLoad(state.time); } });
          active.on(Hls.Events.FRAG_BUFFERED, () => { if (id === generation && video.paused && !video.seeking) { active.stopLoad(); } });
          active.on(Hls.Events.ERROR, (_, detail) => {
            if (id !== generation || !detail.fatal) { return; }
            if (retry++ === 0 && detail.type === Hls.ErrorTypes.MEDIA_ERROR) { active.recoverMediaError(); return; }
            fail(new Error(`${detail.details}${detail.error?.message ? ': ' + detail.error.message : ''}`), id);
          });
          active.attachMedia(video); active.loadSource(source);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = source; video.load(); }
        else { throw new Error(text('This browser does not support HLS playback. Try Chrome, Edge or Safari.', '浏览器不支持此播放格式，请使用 Chrome、Edge 或 Safari。')); }
      }
    } catch (error) { if (id === generation && error.name !== 'AbortError') { fail(error, id); } }
  }
  function fail(error, id = generation) {
    if (id !== generation) { return; }
    if (descriptor && !descriptor.stream && !compatible) { const state = desired || capture(); void load(state, true); return; }
    video.pause(); hls?.stopLoad(); message(text('Playback failed: ', '播放失败：') + error.message, true); original.hidden = false;
    console.error('Gallery browser playback', { error: error.message, code: video.error?.code, detail: video.error?.message, quality: quality.value });
  }
  async function enterFullscreen() {
    wake();
    try {
      // Call synchronously in the click handler, before awaiting playback.
      const leaving = Boolean(document.fullscreenElement);
      const entering = leaving ? document.exitFullscreen() : root.requestFullscreen();
      if (!leaving && video.paused) { void video.play().catch(() => message(text('Press Play to continue.', '请点击播放继续。'))); }
      await entering;
    } catch (error) { message(text('Use your browser full-screen command: ', '请使用浏览器全屏命令：') + error.message, true); }
    fullscreen.blur(); wake();
  }
  fullscreen.addEventListener('click', enterFullscreen);
  video.addEventListener('dblclick', enterFullscreen);
  quality.addEventListener('change', () => { retry = 0; void load(capture()); });
  rate.addEventListener('change', () => { video.playbackRate = Number(rate.value); });
  original.addEventListener('click', () => { retry = 0; quality.value = '0'; descriptor = null; void load({ ...capture(), native: true }); });
  video.addEventListener('play', () => { if (hls) { hls.startLoad(video.currentTime); } wake(); });
  video.addEventListener('pause', () => { if (video.readyState >= 2) { hls?.stopLoad(); } wake(); });
  video.addEventListener('seeking', () => { if (hls && !Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]).some(([start, end]) => video.currentTime >= start && video.currentTime < end)) { hls.startLoad(video.currentTime); } message(text('Buffering…', '缓冲中…')); });
  for (const event of ['loadeddata', 'canplay', 'seeked', 'playing']) { video.addEventListener(event, () => { if (!video.error) { message(''); } }); }
  video.addEventListener('error', () => { if (video.hasAttribute('src') && video.error) { fail(new Error(video.error.message || `Media error ${video.error.code}`)); } });
  root.addEventListener('pointermove', event => { pointerOverNative = event.pointerType === 'mouse' && event.clientY >= root.getBoundingClientRect().bottom - 64; wake(); });
  root.addEventListener('pointerleave', () => { pointerOverNative = false; wake(); });
  for (const event of ['pointerdown', 'keydown', 'touchstart', 'focusin', 'focusout']) { root.addEventListener(event, wake); }
  document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? text('Exit full screen (Esc)', '退出全屏（Esc）') : text('Full screen', '全屏'); wake(); });
  document.addEventListener('keydown', event => {
    if (/^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) { return; }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); void enterFullscreen(); }
    else if (event.code === 'Space') { event.preventDefault(); if (video.paused) { void video.play().catch(() => {}); } else { video.pause(); } }
  });
  const heartbeat = () => { if (!document.hidden || !video.paused) { void fetch(endpoint('heartbeat'), { method: 'POST', credentials: 'omit' }).catch(() => {}); } };
  const timer = setInterval(heartbeat, 15000);
  window.addEventListener('pagehide', () => { clearInterval(timer); ++generation; disposeStream(); video.pause(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { location.reload(); } });
  // The first request inherits quality; subsequent requests use the page control.
  quality.value = new URL(location.href).searchParams.get('quality') || '1440';
  await load(null);
})().catch(error => { document.querySelector('#status').textContent = error.message; });

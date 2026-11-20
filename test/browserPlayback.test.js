const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { browserPlayerHtml } = require('../dist/browserPlayer');
const tick = () => new Promise(setImmediate);

function setup(t, { delay = false, rate = 1 } = {}) {
  const token = 'a'.repeat(64), instances = [], requests = [], pending = [], warnings = [], copied = [];
  const dom = new JSDOM(browserPlayerHtml('?tunnel=private'), { url: `http://localhost:9000/prefix/v1/${token}/player?quality=1080&tunnel=private`, runScripts: 'outside-only' });
  const w = dom.window, video = w.document.querySelector('#video');
  let paused = true, ranges = [], mediaRate = rate;
  Object.defineProperties(video, {
    paused: { get: () => paused }, readyState: { get: () => 3 }, duration: { get: () => 120 },
    buffered: { get: () => ({ length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] }) },
    playbackRate: { get: () => mediaRate, set: value => { mediaRate = value; video.dispatchEvent(new w.Event('ratechange')); } }
  });
  video.load = () => {};
  video.pause = () => { paused = true; video.dispatchEvent(new w.Event('pause')); };
  video.play = async () => { paused = false; video.dispatchEvent(new w.Event('play')); };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
  w.console.warn = (...values) => warnings.push(values);
  class Hls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', FRAG_LOADED: 'loaded', FRAG_BUFFERED: 'buffered', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    constructor(config) { this.config = config; this.listeners = new Map(); this.starts = []; this.stops = 0; instances.push(this); }
    on(event, callback) { this.listeners.set(event, callback); }
    emit(event, detail = {}) { this.listeners.get(event)?.(event, detail); }
    attachMedia(media) { this.media = media; }
    loadSource(source) { this.source = source; }
    startLoad(time) { this.starts.push(time); }
    stopLoad() { this.stops++; }
    destroy() { this.destroyed = true; }
    recoverMediaError() { this.recovered = true; }
  }
  w.Hls = Hls;
  w.fetch = (url, options) => {
    requests.push({ url: String(url), signal: options.signal });
    const state = { title: 'clip', filePath: '/data/中文 空格/100% #? literal%20%2F.mp4', gallery: { token: 'c'.repeat(64), index: 7 }, state: { time: 0, rate, volume: .4, muted: true, quality: Number(new URL(url).searchParams.get('quality')) },
      video: { token: String(requests.length).padStart(64, 'b'), previewWidth: 1920, previewHeight: 1080, stream: { format: 'hls' } } };
    const response = { ok: true, json: async () => state };
    return delay ? new Promise(resolve => pending.push(() => resolve(response))) : Promise.resolve(response);
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../media/fileContextMenu.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/browserPlayer.js'), 'utf8'));
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); dom.window.close(); });
  return { w, video, instances, requests, pending, warnings, copied, ranges: value => { ranges = value; }, change: (selector, value) => { const select = w.document.querySelector(selector); select.value = String(value); select.dispatchEvent(new w.Event('change')); } };
}

test('browser HLS buffers ahead in viewing time, scales for speed and retains a bounded local window', async t => {
  const ui = setup(t); await tick(); const hls = ui.instances[0];
  assert.equal(hls.config.maxBufferLength, 20); assert.equal(hls.config.maxMaxBufferLength, 20);
  assert.equal(hls.config.backBufferLength, 8); assert.equal(hls.config.maxBufferSize, 32 * 1024 * 1024);
  assert.equal(hls.config.autoStartLoad, false); assert.deepEqual(hls.starts, []);
  hls.emit('manifest'); assert.deepEqual(hls.starts, [0]);
  hls.emit('buffered'); assert.equal(hls.stops, 1, 'paused startup stops after one fragment');
  await ui.video.play(); const starts = hls.starts.length;
  ui.change('#rate', 2); assert.equal(hls.config.maxBufferLength, 40);
  ui.change('#rate', 4); assert.equal(hls.config.maxMaxBufferLength, 48);
  assert.equal(hls.starts.length, starts, 'changing speed must not abort/restart a fragment request');
  ui.change('#rate', .25); assert.equal(hls.config.maxMaxBufferLength, 8);
  const stops = hls.stops; hls.emit('buffered'); assert.equal(hls.stops, stops, 'active playback continues preloading');
  ui.video.pause(); assert.equal(hls.stops, stops + 1);
});

test('observed HLS fragment sizes reduce the forward window to leave byte-budget headroom', async t => {
  const ui = setup(t, { rate: 4 }); await tick(); const hls = ui.instances[0];
  hls.emit('loaded', { frag: { sn: 0, duration: 4, stats: { loading: { start: 10, end: 2010 } } }, payload: { byteLength: 4 * 1024 * 1024 }, networkDetails: { getResponseHeader: () => 'prepare;dur=1700, queue;dur=100, encode;dur=1600, cache;desc="miss"' } });
  assert.equal(hls.config.maxBufferLength, 12); assert.equal(hls.config.maxMaxBufferLength, 12);
  const timing = JSON.parse(ui.video.dataset.streamTiming);
  assert.equal(timing.requestMs, 2000); assert.equal(timing.bytes, 4 * 1024 * 1024); assert.match(timing.serverTiming, /encode;dur=1600/);
  assert.equal(ui.video.dataset.bufferTargetSeconds, '12');
});

test('browser stall diagnostics include bounded recent timings and ignore repeated or paused stalls', async t => {
  const ui = setup(t); await tick(); const hls = ui.instances[0];
  ui.video.dispatchEvent(new ui.w.Event('waiting')); assert.equal(ui.warnings.length, 0);
  for (let sn = 0; sn < 20; sn++) { hls.emit('loaded', { frag: { sn, duration: 4 }, payload: { byteLength: 1000 } }); }
  ui.ranges([[0, 8]]); ui.video.currentTime = 7; await ui.video.play();
  ui.video.dispatchEvent(new ui.w.Event('waiting')); ui.video.dispatchEvent(new ui.w.Event('stalled'));
  assert.equal(ui.warnings.length, 1); const diagnostic = ui.warnings[0][1];
  assert.equal(diagnostic.bufferedSeconds, 1); assert.equal(diagnostic.fragments.length, 8); assert.equal(diagnostic.fragments[0].index, 12);
  assert.match(ui.w.document.querySelector('#status').textContent, /Buffering/);
  ui.video.dispatchEvent(new ui.w.Event('playing')); assert.equal(ui.w.document.querySelector('#status').textContent, '');
});

test('quality changes abort old state requests and stale HLS events cannot touch the current player', async t => {
  const ui = setup(t, { delay: true }); await tick();
  ui.change('#quality', 720); assert.equal(ui.requests[0].signal.aborted, true);
  ui.pending[1](); await tick(); assert.equal(ui.instances.length, 1); const old = ui.instances[0];
  ui.pending[0](); await tick(); assert.equal(ui.instances.length, 1, 'late metadata cannot replace the latest quality');
  assert.equal(ui.w.document.querySelector('#quality').value, '720');
  ui.video.currentTime = 76; await ui.video.play(); ui.change('#quality', 1080);
  assert.equal(old.destroyed, true); ui.pending[2](); await tick(); const current = ui.instances[1];
  assert.equal(current.config.startPosition, 76); assert.match(current.source, /tunnel=private/);
  old.emit('manifest'); old.emit('buffered'); old.emit('loaded', { frag: { sn: 99 }, payload: { byteLength: 9999999 } }); old.emit('error', { fatal: true, details: 'old failure' });
  assert.deepEqual(current.starts, []); assert.equal(current.stops, 0); assert.equal(ui.video.dataset.streamTiming, undefined);
  current.emit('manifest'); assert.deepEqual(current.starts, [76]);
  ui.video.dispatchEvent(new ui.w.Event('loadedmetadata')); assert.equal(ui.video.paused, false); assert.equal(ui.video.currentTime, 76);
});

test('browser seeking keeps buffered work and requests distant positions without preceding conversion', async t => {
  const ui = setup(t); await tick(); const hls = ui.instances[0];
  ui.ranges([[0, 20]]); ui.video.currentTime = 12; ui.video.dispatchEvent(new ui.w.Event('seeking')); assert.deepEqual(hls.starts, []);
  ui.video.currentTime = 97; ui.video.dispatchEvent(new ui.w.Event('seeking')); assert.deepEqual(hls.starts, [97]);
  assert.equal(ui.requests.length, 1, 'seek uses the existing private session');
});


test('browser video copy-path menu preserves playback and copies the original path without media requests', async t => {
  const ui = setup(t); await tick(); const hls = ui.instances[0]; await ui.video.play();
  const gallery = new URL(ui.w.document.querySelector('#gallery-link').href); assert.match(gallery.pathname, new RegExp(`/prefix/gallery/${'c'.repeat(64)}/viewer$`)); assert.equal(gallery.searchParams.get('selected'), '7'); assert.equal(gallery.searchParams.get('tunnel'), 'private');
  const context = target => { const event = new ui.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 }); target.dispatchEvent(event); return event; };
  const requests = ui.requests.length, starts = hls.starts.length, stops = hls.stops;
  assert.equal(context(ui.video).defaultPrevented, true); ui.w.document.querySelector('[role="menuitem"]').click(); await tick();
  assert.equal(ui.copied[0], '/data/中文 空格/100% #? literal%20%2F.mp4'); assert.equal(ui.video.paused, false);
  assert.equal(ui.requests.length, requests); assert.equal(hls.starts.length, starts); assert.equal(hls.stops, stops);
  assert.equal(context(ui.w.document.querySelector('#title')).defaultPrevented, true); ui.w.document.querySelector('[role="menuitem"]').click(); await tick(); assert.equal(ui.copied.length, 2);
  assert.equal(context(ui.w.document.querySelector('#quality')).defaultPrevented, false);
  context(ui.video); ui.w.dispatchEvent(new ui.w.Event('pagehide')); assert.equal(ui.w.document.querySelector('[role="menu"]'), null);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { browserGalleryHtml } = require('../dist/browserGallery');
const tick = async (turns = 12) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };

async function setup(t) {
  const token = 'a'.repeat(64), virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(browserGalleryHtml('?forward=secret'), { url: `http://localhost/private/gallery/${token}/viewer?forward=secret`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(() => dom.window.close());
  const w = dom.window, viewport = w.document.querySelector('#gallery-viewport'), grid = w.document.querySelector('#gallery-grid');
  Object.defineProperties(viewport, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } }); Object.defineProperty(grid, 'offsetTop', { value: 0 });
  w.requestAnimationFrame = callback => w.setTimeout(callback, 0); w.cancelAnimationFrame = id => w.clearTimeout(id);
  let observer;
  class ResizeObserver { constructor(callback) { this.callback = callback; } observe() { this.callback(); } disconnect() {} }
  class IntersectionObserver { constructor(callback) { this.callback = callback; this.targets = new Set(); observer = this; } observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); } trigger(visible = true) { this.callback([...this.targets].map(target => ({ target, isIntersecting: visible }))); } }
  w.ResizeObserver = ResizeObserver; w.IntersectionObserver = IntersectionObserver;
  const copied = [], requests = [], blobs = new Map(), thumbResolvers = [], active = { value: 0, max: 0 }; let serial = 0;
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => copied.push(value) } });
  w.URL.createObjectURL = blob => { const url = `blob:${++serial}`; blobs.set(url, blob); return url; }; w.URL.revokeObjectURL = url => blobs.delete(url);
  w.HTMLImageElement.prototype.decode = async function () { Object.defineProperties(this, { naturalWidth: { value: 320, configurable: true }, naturalHeight: { value: 180, configurable: true } }); };
  const record = index => ({ id: `file:///${index}.${index % 5 ? 'jpg' : 'mp4'}`, index, name: `${index}.${index % 5 ? 'jpg' : 'mp4'}`, relativePath: `folder/${String(index).padStart(6, '0')}.${index % 5 ? 'jpg' : 'mp4'}`, filePath: `/data/中文 空格/${index}%20#?.${index % 5 ? 'jpg' : 'mp4'}`, kind: index % 5 ? 'image' : 'video' });
  w.fetch = async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, options }); assert.equal(url.searchParams.get('forward'), 'secret');
    if (url.pathname.endsWith('/list')) {
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')), query = url.searchParams.get('q') || '';
      const total = query ? 3 : 100000;
      return { ok: true, json: async () => ({ total, selected: 2, language: 'zh', items: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => record(offset + i)) }) };
    }
    if (/\/thumbnail\/\d+$/.test(url.pathname)) {
      active.value++; active.max = Math.max(active.max, active.value);
      await new Promise(resolve => thumbResolvers.push(() => { active.value--; resolve(); }));
      return { ok: true, blob: async () => ({ index: Number(url.pathname.split('/').at(-1)) }) };
    }
    if (/\/open\/\d+$/.test(url.pathname)) return { ok: true, json: async () => ({ path: `/v1/${'b'.repeat(64)}/player` }) };
    if (url.pathname.endsWith('/heartbeat')) return { ok: true };
    throw new Error(`Unexpected request ${url}`);
  };
  w.HTMLElement.prototype.requestFullscreen = async function () { Object.defineProperty(w.document, 'fullscreenElement', { configurable: true, value: this }); w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.document.exitFullscreen = async () => { Object.defineProperty(w.document, 'fullscreenElement', { configurable: true, value: null }); w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.eval(fs.readFileSync(path.join(__dirname, '../media/galleryGrid.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/fileContextMenu.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/browserGallery.js'), 'utf8'));
  await tick();
  return { w, viewport, requests, copied, thumbResolvers, active, observer: () => observer };
}

test('browser Gallery virtualizes a 100k list and requests only visible thumbnails with concurrency four', async t => {
  const ui = await setup(t), doc = ui.w.document;
  assert.equal(doc.querySelector('#gallery-count').textContent, '100000 个文件');
  const cards = [...doc.querySelectorAll('.browser-card')]; assert.ok(cards.length > 0 && cards.length < 100, `bounded cards: ${cards.length}`);
  assert.equal(ui.requests.some(({ url }) => /thumbnail|caption|\.txt/.test(url.pathname)), false, 'metadata listing performs no media or caption work');
  ui.observer().trigger(true); await tick(); assert.equal(ui.active.max, 4); assert.equal(ui.requests.filter(({ url }) => url.pathname.includes('/thumbnail/')).length, 4);
  for (let turn = 0; turn < 20; turn++) { while (ui.thumbResolvers.length) ui.thumbResolvers.shift()(); await tick(); if (ui.active.value === 0) break; }
  assert.ok(ui.requests.filter(({ url }) => url.pathname.includes('/thumbnail/')).length <= cards.length);
  assert.equal(doc.querySelectorAll('.browser-card').length < 100, true);
  assert.equal(doc.querySelector('.browser-card.selected')?.dataset.mediaId, 'file:///2.jpg');
});

test('browser Gallery preserves search/scroll, copies original paths, opens cards and supports fullscreen', async t => {
  const ui = await setup(t), doc = ui.w.document, first = [...doc.querySelectorAll('.browser-card')].find(card => !card.classList.contains('placeholder'));
  first.dispatchEvent(new ui.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 15, clientY: 20 }));
  doc.querySelector('[role=menuitem]').click(); await tick(); assert.equal(ui.copied[0], '/data/中文 空格/0%20#?.mp4');
  first.click(); await tick(); const open = ui.requests.find(({ url }) => url.pathname.endsWith('/open/0')); assert.ok(open); assert.equal(open.options.method, 'POST');
  assert.match(ui.w.sessionStorage.getItem(`gallery-grid:${'a'.repeat(64)}`), /"selected":0/);
  doc.querySelector('#gallery-fullscreen').click(); await tick(); assert.equal(doc.fullscreenElement, doc.querySelector('#browser-gallery'));
  doc.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })); await tick(); assert.equal(doc.fullscreenElement, null);
  const search = doc.querySelector('#gallery-search'); search.value = 'needle'; search.dispatchEvent(new ui.w.Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 220)); await tick();
  assert.ok(ui.requests.some(({ url }) => url.pathname.endsWith('/list') && url.searchParams.get('q') === 'needle'));
  assert.equal(doc.querySelector('#gallery-count').textContent, '3 个文件'); assert.equal(ui.requests.some(({ url }) => /caption|\.txt/.test(url.pathname)), false);
});

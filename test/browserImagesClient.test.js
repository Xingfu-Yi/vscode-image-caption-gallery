const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { JSDOM } = require('jsdom');
const { browserImagesHtml } = require('../dist/browserImages');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function setup(t, { dimensions = [1600, 900], gates = new Map() } = {}) {
  const dom = new JSDOM(browserImagesHtml('?forward=secret'), { url: `http://127.0.0.1/images/${'a'.repeat(64)}/viewer?forward=secret`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); const w = dom.window, requests = [], images = [], revoked = [], timers = new Map(), blobs = new Map(), versions = new Map(); let timer = 0, serial = 0;
  w.setTimeout = (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }; w.clearTimeout = id => timers.delete(id);
  w.URL.createObjectURL = blob => { const url = `blob:${++serial}`; blobs.set(url, blob); return url; };
  w.URL.revokeObjectURL = url => { revoked.push(url); blobs.delete(url); };
  w.HTMLImageElement.prototype.decode = async function () {
    const blob = blobs.get(this.src); await gates.get(blob.index)?.promise;
    Object.defineProperties(this, { naturalWidth: { value: dimensions[0], configurable: true }, naturalHeight: { value: dimensions[1], configurable: true } });
    images.push({ index: blob.index, image: this });
  };
  w.fetch = async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, options });
    assert.equal(url.searchParams.get('forward'), 'secret', 'every relative request preserves the private-forward query');
    if (url.pathname.endsWith('/state')) {
      const index = Number(url.searchParams.get('index') || 0);
      return { ok: true, json: async () => ({ index, total: 12, language: 'zh', resolution: 2048, images: [index - 1, index, index + 1].filter(i => i >= 0 && i < 12).map(i => ({ index: i, name: `${i}.jpg`, relativePath: `${i}.jpg`, version: versions.get(i) || 'v1' })) }) };
    }
    const index = Number(url.pathname.split('/').at(-1));
    return { ok: true, status: 200, headers: new Map([['X-Image-Frames', '1']]), blob: async () => ({ index }) };
  };
  Object.defineProperty(w.document, 'fullscreenElement', { writable: true, value: null });
  const viewer = w.document.querySelector('#viewer');
  viewer.requestFullscreen = async () => { w.document.fullscreenElement = viewer; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.document.exitFullscreen = async () => { w.document.fullscreenElement = null; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.eval(fs.readFileSync(path.join(__dirname, '../media/browserImages.js'), 'utf8')); await tick();
  const key = value => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const runTimers = ms => { for (const [id, item] of [...timers]) if (item.ms === ms) { timers.delete(id); item.fn(); } };
  const count = index => requests.filter(({ url }) => url.pathname.endsWith(`/image/${index}`)).length;
  return { w, viewer, key, runTimers, requests, images, revoked, versions, count, stage: () => w.document.querySelector('#stage img') };
}

test('browser image fullscreen reuses decoded neighbours and hides arrows even after keyboard navigation', async t => {
  const ui = await setup(t), first = ui.stage();
  assert.equal(ui.count(0), 1); assert.equal(ui.count(1), 1);
  ui.w.document.querySelector('#fullscreen').click(); await tick();
  assert.equal(ui.w.document.fullscreenElement, ui.viewer);
  ui.key('ArrowRight'); await tick();
  assert.equal(ui.stage(), ui.images.find(image => image.index === 1).image); assert.equal(ui.count(1), 1);
  assert.equal(ui.w.document.querySelector('#position').textContent, '2 / 12');
  ui.runTimers(2000); assert.equal(ui.viewer.classList.contains('idle'), true);
  assert.equal(ui.w.document.activeElement, ui.viewer, 'keyboard navigation must not leave a focused toolbar button keeping controls visible');
  ui.key('ArrowLeft'); await tick(); assert.equal(ui.stage(), first); assert.equal(ui.count(0), 1);
  ui.key('f'); await tick(); assert.equal(ui.w.document.fullscreenElement, null);
  assert.equal(ui.requests.some(({ url }) => /caption|\.txt/.test(url.pathname)), false);
});

test('slow and out-of-order neighbour decodes retain the displayed image and commit only the latest target', async t => {
  const one = gate(), two = gate(), ui = await setup(t, { gates: new Map([[1, one], [2, two]]) }), first = ui.stage();
  ui.key('ArrowRight'); await tick(); assert.equal(ui.stage(), first);
  ui.runTimers(150); assert.match(ui.w.document.querySelector('#status').textContent, /正在切换/);
  ui.key('ArrowRight'); await tick(); assert.equal(ui.stage(), first);
  two.resolve(); await tick(); const target = ui.stage(); assert.notEqual(target, first);
  one.resolve(); await tick(); assert.equal(ui.stage(), target); assert.equal(ui.w.document.querySelector('#position').textContent, '3 / 12');
  assert.equal(ui.w.document.querySelector('#status').textContent, '');
  assert.equal(ui.count(1), 1, 'adopting a pending neighbour does not duplicate its request');
});

test('browser image history is bounded, validates file versions and revokes evicted blob URLs', async t => {
  const ui = await setup(t);
  for (let i = 0; i < 9; i++) { ui.key('ArrowRight'); await tick(); }
  assert.ok(ui.revoked.length > 0); assert.equal(ui.w.document.querySelector('#position').textContent, '10 / 12');
  ui.key('Home'); await tick(); assert.equal(ui.count(0), 2, 'oldest image was evicted after more than seven decoded entries');
  const current = ui.stage(); ui.versions.set(0, 'v2');
  ui.key('ArrowRight'); await tick(); ui.key('ArrowLeft'); await tick();
  assert.notEqual(ui.stage(), current, 'changed source is reloaded after background validation');
  assert.equal(ui.w.document.querySelector('#status').textContent, '');
});

test('decoded-memory budget can evict history before the seven-image limit', async t => {
  const ui = await setup(t, { dimensions: [4000, 4000] });
  for (let i = 0; i < 3; i++) { ui.key('ArrowRight'); await tick(); }
  ui.key('Home'); await tick(); assert.equal(ui.count(0), 2);
  assert.equal(ui.stage().naturalWidth, 4000, 'memory limits never silently reduce the chosen resolution');
});

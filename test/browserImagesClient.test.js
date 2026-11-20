const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { JSDOM } = require('jsdom');
const { browserImagesHtml } = require('../dist/browserImages');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function setup(t, { dimensions = [1600, 900], gates = new Map() } = {}) {
  const dom = new JSDOM(browserImagesHtml('?forward=secret'), { url: `http://127.0.0.1/images/${'a'.repeat(64)}/viewer?forward=secret`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); const w = dom.window, requests = [], images = [], revoked = [], timers = new Map(), blobs = new Map(), versions = new Map(), copied = []; let timer = 0, serial = 0;
  w.setTimeout = (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }; w.clearTimeout = id => timers.delete(id);
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
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
      return { ok: true, json: async () => ({ index, total: 12, language: 'zh', resolution: 2048, gallery: { token: 'b'.repeat(64), index }, images: [index - 1, index, index + 1].filter(i => i >= 0 && i < 12).map(i => ({ index: i, id: `vscode-remote://ssh+Home/encoded-${i}%2520.jpg`, filePath: `/data/中文 空格/${i} literal%20#?.jpg`, name: `${i}.jpg`, relativePath: `${i}.jpg`, version: versions.get(i) || 'v1' })) }) };
    }
    const index = Number(url.pathname.split('/').at(-1));
    return { ok: true, status: 200, headers: new Map([['X-Image-Frames', '1']]), blob: async () => ({ index }) };
  };
  Object.defineProperty(w.document, 'fullscreenElement', { writable: true, value: null });
  const viewer = w.document.querySelector('#viewer');
  viewer.requestFullscreen = async () => { w.document.fullscreenElement = viewer; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.document.exitFullscreen = async () => { w.document.fullscreenElement = null; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.eval(fs.readFileSync(path.join(__dirname, '../media/fileContextMenu.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/browserImages.js'), 'utf8')); await tick();
  const key = value => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const runTimers = ms => { for (const [id, item] of [...timers]) if (item.ms === ms) { timers.delete(id); item.fn(); } };
  const count = index => requests.filter(({ url }) => url.pathname.endsWith(`/image/${index}`)).length;
  return { w, viewer, key, runTimers, requests, images, revoked, versions, count, copied, stage: () => w.document.querySelector('#stage img') };
}

test('browser image fullscreen reuses decoded neighbours and hides arrows even after keyboard navigation', async t => {
  const ui = await setup(t), first = ui.stage();
  assert.equal(ui.count(0), 1); assert.equal(ui.count(1), 1);
  ui.w.document.querySelector('#fullscreen').click(); await tick();
  assert.equal(ui.w.document.fullscreenElement, ui.viewer);
  ui.key('ArrowRight'); await tick();
  assert.equal(ui.stage(), ui.images.find(image => image.index === 1).image); assert.equal(ui.count(1), 1);
  assert.equal(ui.w.document.querySelector('#position').textContent, '2 / 12');
  const gallery = new URL(ui.w.document.querySelector('#gallery-link').href); assert.match(gallery.pathname, new RegExp(`/gallery/${'b'.repeat(64)}/viewer$`)); assert.equal(gallery.searchParams.get('selected'), '1'); assert.equal(gallery.searchParams.get('forward'), 'secret');
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


test('browser image context menu copies the displayed source while a different image is decoding', async t => {
  const one = gate(), ui = await setup(t, { gates: new Map([[1, one]]) });
  const menu = target => {
    const event = new ui.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    target.dispatchEvent(event); return event;
  };
  const copy = async target => { assert.equal(menu(target).defaultPrevented, true); ui.w.document.querySelector('[role="menuitem"]').click(); await tick(); };
  const before = ui.requests.length, decodes = ui.images.length;
  await copy(ui.stage()); assert.deepEqual(ui.copied, ['/data/中文 空格/0 literal%20#?.jpg']);
  assert.equal(ui.requests.length, before); assert.equal(ui.images.length, decodes);
  ui.key('ArrowRight'); await tick(); assert.equal(ui.stage().alt, '0.jpg'); assert.equal(ui.w.document.querySelector('#title').textContent, '0.jpg');
  await copy(ui.stage()); assert.equal(ui.copied.at(-1), '/data/中文 空格/0 literal%20#?.jpg', 'copy follows the old visible frame, never the pending target');
  menu(ui.stage()); one.resolve(); await tick();
  assert.equal(ui.w.document.querySelector('[role="menu"]'), null, 'a committed navigation closes stale menus');
  const warmRequests = ui.requests.length, warmDecodes = ui.images.length;
  await copy(ui.w.document.querySelector('#title')); assert.equal(ui.copied.at(-1), '/data/中文 空格/1 literal%20#?.jpg');
  assert.equal(ui.requests.length, warmRequests); assert.equal(ui.images.length, warmDecodes);
  assert.equal(menu(ui.w.document.querySelector('#next')).defaultPrevented, false, 'toolbar controls retain their normal menu');
  assert.equal(ui.w.document.querySelector('[role="menu"]'), null);
  menu(ui.stage()); ui.w.dispatchEvent(new ui.w.Event('pagehide')); assert.equal(ui.w.document.querySelector('[role="menu"]'), null);
  assert.equal(ui.requests.some(({ url }) => /caption|\.txt/.test(url.pathname)), false);
});

test('focused browser viewer opens the keyboard file menu without navigating images',async t=>{
 const ui=await setup(t);ui.viewer.focus();ui.viewer.dispatchEvent(new ui.w.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
 assert.ok(ui.w.document.querySelector('[role=menu]'));const position=ui.w.document.querySelector('#position').textContent;
 ui.w.document.querySelector('[role=menuitem]').dispatchEvent(new ui.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));assert.equal(ui.w.document.querySelector('#position').textContent,position);
 ui.w.document.querySelector('[role=menuitem]').click();await tick();assert.equal(ui.copied[0],'/data/中文 空格/0 literal%20#?.jpg');
});

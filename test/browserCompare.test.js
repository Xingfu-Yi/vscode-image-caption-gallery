const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { JSDOM } = require('jsdom');
const { browserComparisonHtml } = require('../dist/browserImages');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t, state = {}) {
  const dom = new JSDOM(browserComparisonHtml('?auth=a%26b'), { url: `http://127.0.0.1/private-forward/images/${'a'.repeat(64)}/viewer?auth=a%26b`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close()); const w = dom.window, requests = [], decodes = [], blobs = new Map(), revoked = [], versions = ['v1', 'v1'], timers = new Map(), failures = new Set(), gates = new Map(), copied = []; let serial = 0;
  w.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; }; w.clearTimeout = id => timers.delete(id);
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
  w.URL.createObjectURL = blob => { const url = `blob:${++serial}`; blobs.set(url, blob); return url; }; w.URL.revokeObjectURL = url => { revoked.push(url); blobs.delete(url); };
  w.HTMLImageElement.prototype.decode = async function () {
    const src = this.src, blob = blobs.get(src); decodes.push({ src, image: this }); await gates.get(blob?.side)?.promise;
    Object.defineProperties(this, { naturalWidth: { value: blob?.side === 1 ? 90 : 160, configurable: true }, naturalHeight: { value: blob?.side === 1 ? 160 : 90, configurable: true } });
  };
  const intervals = []; w.setInterval = fn => { intervals.push(fn); return intervals.length; }; w.clearInterval = () => {};
  w.fetch = async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, options }); assert.equal(url.searchParams.get('auth'), 'a&b'); assert.match(url.pathname, /\/private-forward\/images\//);
    if (url.pathname.endsWith('/state')) return { ok: true, json: async () => ({ language: 'en', resolution: 2048, gallery: { token: 'd'.repeat(64), index: 3 }, comparison: state, images: [0, 1].map(side => ({ id: `file:///encoded%2520/${side}.png`, filePath: `/data/中文 空格/${side}%20#?.png`, index: side, name: `${side}.png`, relativePath: `${side}.png`, version: versions[side] })) }) };
    const side = Number(url.pathname.split('/').at(-1));
    if (failures.has(side)) return { ok: false, text: async () => 'broken image' };
    return { ok: true, headers: new Map([['X-Image-Original-Width', '4096'], ['X-Image-Original-Height', '2160']]), blob: async () => ({ side }) };
  };
  Object.defineProperty(w.document, 'fullscreenElement', { writable: true, value: null });
  w.HTMLElement.prototype.requestFullscreen = async function () { w.document.fullscreenElement = this; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.document.exitFullscreen = async () => { w.document.fullscreenElement = null; w.document.dispatchEvent(new w.Event('fullscreenchange')); };
  w.sessionStorage.setItem('gallery-comparison', JSON.stringify({ linked: true, showingReference: false }));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/fileContextMenu.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../media/compareView.js'), 'utf8')); w.eval(fs.readFileSync(path.join(__dirname, '../media/browserCompare.js'), 'utf8')); await tick();
  const key = (type, key = ' ', extra = {}) => w.document.dispatchEvent(new w.KeyboardEvent(type, { key, code: key === ' ' ? 'Space' : '', bubbles: true, cancelable: true, ...extra }));
  return { w, requests, decodes, versions, intervals, revoked, failures, gates, key, copied, root: w.document.querySelector('.compare-view'), click: selector => w.document.querySelector(selector).click(), runTimers: ms => { for (const [id, item] of [...timers]) if (item.ms === ms) { timers.delete(id); item.fn(); } } };
}
test('browser comparison inherits independent views and latch, opens real fullscreen and swaps without requests/decodes', async t => {
  const ui = await setup(t, { linked: false, showingReference: true, views: [{ zoom: 2, x: .4, y: .6 }, { zoom: 3, x: .7, y: .3 }] }), doc = ui.w.document;
  assert.equal(ui.root.dataset.ready, 'true'); assert.equal(ui.root.dataset.showingReference, 'true'); assert.equal(doc.querySelector('[data-action=link]').textContent, 'Independent');
  assert.equal(doc.querySelector('[data-action=gallery]').hidden, false);
  assert.equal(doc.querySelector('.compare-filename').textContent, 'B · 1.png · reference copy'); assert.match(doc.querySelector('.compare-title').title, /4096 × 2160/);
  assert.equal(doc.querySelector('.compare-resolution').textContent, '4096 × 2160');
  assert.equal(doc.querySelectorAll('img').length, 3); const right = doc.querySelector('[data-side="1"] img'), style = right.style.cssText;
  const count = ui.requests.length, decodes = ui.decodes.length;
  ui.click('.compare-toggle'); ui.key('keydown'); ui.key('keydown', ' ', { repeat: true }); assert.equal(ui.root.dataset.showingReference, 'true'); ui.key('keyup'); assert.equal(ui.root.dataset.showingReference, 'false');
  for (let i = 0; i < 20; i++) ui.click('.compare-toggle');
  assert.equal(ui.requests.length, count); assert.equal(ui.decodes.length, decodes); assert.equal(doc.querySelector('[data-side="1"] img'), right); assert.equal(right.style.cssText, style);
  ui.click('[data-action=fullscreen]'); await tick(); assert.equal(doc.fullscreenElement, ui.root);
  ui.runTimers(2000); assert.equal(ui.root.classList.contains('compare-idle'), true);
  ui.key('keydown', 'f'); await tick(); assert.equal(doc.fullscreenElement, null); assert.ok(ui.root.isConnected);
  assert.equal(ui.requests.some(({ url }) => /caption/.test(url.pathname)), false);
});
test('browser comparison revalidates one changed side, handles retry/original and cleans up stale decodes and blobs', async t => {
  const ui = await setup(t), doc = ui.w.document, right = doc.querySelector('[data-side="1"] img');
  ui.versions[0] = 'v2'; ui.failures.add(0); ui.intervals[0](); await tick();
  assert.match(doc.querySelector('[data-side="0"] .compare-feedback').textContent, /broken image/); assert.equal(doc.querySelector('[data-side="1"] img'), right);
  ui.failures.delete(0); ui.click('[data-original="0"]'); await tick(); assert.equal(ui.root.dataset.ready, 'true');
  assert.equal(ui.requests.filter(({ url }) => url.pathname.endsWith('/image/0')).at(-1).url.searchParams.get('original'), '1');
  let unblock; ui.gates.set(1, { promise: new Promise(resolve => { unblock = resolve; }) }); ui.versions[1] = 'v2'; ui.intervals[0](); await tick();
  ui.w.dispatchEvent(new ui.w.Event('pagehide')); unblock(); await tick(); assert.equal(doc.querySelector('.compare-view'), null); assert.ok(ui.revoked.length >= 4);
});


test('browser comparison copy-path menu follows the B reference copy and makes no media or caption requests', async t => {
  const ui = await setup(t), doc = ui.w.document;
  const copy = async target => { target.dispatchEvent(new ui.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 35 })); doc.querySelector('[role="menuitem"]').click(); await tick(); };
  const requests = ui.requests.length, decodes = ui.decodes.length;
  await copy(doc.querySelector('[data-side="0"] .compare-stage')); assert.equal(ui.copied.at(-1), '/data/中文 空格/0%20#?.png');
  ui.click('.compare-toggle'); await copy(doc.querySelector('[data-side="0"] .compare-stage')); assert.equal(ui.copied.at(-1), '/data/中文 空格/1%20#?.png');
  await copy(doc.querySelector('[data-side="1"] .compare-title')); assert.equal(ui.copied.at(-1), '/data/中文 空格/1%20#?.png');
  assert.equal(ui.requests.length, requests); assert.equal(ui.decodes.length, decodes); assert.equal(ui.requests.some(({ url }) => /caption/.test(url.pathname)), false);
});

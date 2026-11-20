const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createHost } = require('./helpers/host');
const records = ['a', 'b'].map((id) => ({ id, name: `${id}.jpg`, relativePath: `${id}.jpg` }));
const comparisonTick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function clickComparisonSelection(ui, id, modifiers = { metaKey: true }) {
  ui.window.document.querySelector(`[data-media-id="${id}"]`).dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
}
function selectComparison(ui, id, modifiers = { metaKey: true }) {
  clickComparisonSelection(ui, id, modifiers);
  // Component tests use the explicit entry button; scheduling is tested below
  // with a controlled clock instead of making every test wait in real time.
  if (!ui.window.document.querySelector('#compare-selected').disabled) ui.click('#compare-selected');
}
async function readyComparison(ui, width = 100, height = 60) {
  ui.window.HTMLImageElement.prototype.decode = async function () {
    if (!this.naturalWidth) Object.defineProperties(this, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
  };
  for (const pending of ui.requests.filter(m => m.type === 'loadPreview' && m.detail).slice(-2)) {
    ui.send({ ...pending, type: 'preview', source: `https://preview.test/${pending.id}`, width, height, originalWidth: width * 10, originalHeight: height * 10, frameCount: 1 });
    const target = ui.imageFor(pending.requestId);
    Object.defineProperties(target, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
    target.dispatchEvent(new ui.window.Event('load'));
  }
  await comparisonTick();
}

test('comparison selection orders A/B, excludes videos, preserves scroll and selection on exit and never requests captions', async t => {
  const ui = await setup(t, { showCaption: true }, {}, [...records, { id: 'clip', kind: 'video', name: 'clip.mp4', relativePath: 'clip.mp4' }]), doc = ui.window.document;
  const viewport = doc.querySelector('#gallery-view'); viewport.scrollTop = 125;
  selectComparison(ui, 'clip'); assert.equal(doc.querySelector('.compare-view'), null); assert.equal(ui.last('loadVideo'), undefined);
  selectComparison(ui, 'b'); assert.equal(doc.querySelector('[data-media-id=b] .comparison-marker').textContent, 'A');
  selectComparison(ui, 'b'); assert.equal(doc.querySelectorAll('.comparison-marker').length, 0);
  selectComparison(ui, 'b'); selectComparison(ui, 'a', { ctrlKey: true });
  assert.ok(doc.querySelector('.compare-view')); assert.deepEqual(ui.requests.filter(m => m.type === 'loadPreview' && m.detail).map(m => m.id), ['b', 'a']);
  await readyComparison(ui); assert.equal(doc.querySelector('.compare-view').dataset.ready, 'true');
  assert.equal(doc.querySelector('.compare-filename').textContent, 'A · b.jpg');
  assert.equal(ui.requests.some(m => m.type === 'loadCaption'), false); assert.equal(ui.state().textPaneHidden, false);
  doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.compare-view'), null); assert.equal(viewport.scrollTop, 125);
  assert.equal(doc.querySelectorAll('.comparison-marker').length, 2);
  assert.equal(doc.querySelector('[data-media-id=b] .comparison-marker').textContent, 'A');
  assert.equal(doc.querySelector('[data-media-id=a] .comparison-marker').textContent, 'B');
  assert.equal(doc.querySelector('#compare-selected').disabled, false);
  assert.equal(doc.querySelector('#comparison-selection').classList.contains('hidden'), false);
  ui.click('#compare-selected'); await comparisonTick(); assert.equal(doc.querySelector('.compare-view').dataset.ready, 'true');
  assert.equal(ui.requests.filter(m => m.type === 'loadPreview' && m.detail).length, 2, 'reopening retains pinned decoded entries');
  ui.click('[data-action=back]');
  doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  selectComparison(ui, 'a');
  assert.equal(doc.querySelector('[data-media-id=a] .comparison-marker').textContent, 'A');
  const search = doc.querySelector('#search'); search.value = 'a'; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(doc.querySelectorAll('.comparison-marker').length, 0);
});

test('comparison headers show original resolution and follow displayed A/B through Space and the toolbar toggle', async t => {
  const ui = await setup(t), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b');
  assert.equal(doc.querySelector('.compare-resolution').hidden, true);
  ui.window.HTMLImageElement.prototype.decode = async function () {};
  for (const pending of ui.requests.filter(m => m.type === 'loadPreview' && m.detail)) {
    const dims = pending.id === 'a' ? { width: 1365, height: 720, originalWidth: 4096, originalHeight: 2160 } : { width: 720, height: 1365, originalWidth: 2160, originalHeight: 4096 };
    ui.send({ ...pending, type: 'preview', source: `https://preview.test/${pending.id}`, ...dims, frameCount: 1 });
    const image = ui.imageFor(pending.requestId);
    Object.defineProperties(image, { naturalWidth: { value: dims.width, configurable: true }, naturalHeight: { value: dims.height, configurable: true } });
    image.dispatchEvent(new ui.window.Event('load'));
  }
  await comparisonTick();
  const dimensions = () => [...doc.querySelectorAll('.compare-resolution')].map(element => element.textContent);
  assert.deepEqual(dimensions(), ['4096 × 2160', '2160 × 4096']);
  const count = ui.requests.length;
  doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
  assert.deepEqual(dimensions(), ['2160 × 4096', '2160 × 4096']);
  assert.match(doc.querySelector('.compare-filename').textContent, /reference copy/);
  doc.dispatchEvent(new ui.window.KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
  assert.deepEqual(dimensions(), ['4096 × 2160', '2160 × 4096']);
  ui.click('.compare-toggle'); assert.deepEqual(dimensions(), ['2160 × 4096', '2160 × 4096']);
  ui.click('.compare-toggle'); assert.deepEqual(dimensions(), ['4096 × 2160', '2160 × 4096']);
  assert.equal(ui.requests.length, count);
  ui.send({ type: 'previewConfigurationChanged', resolution: 512 });
  assert.equal(doc.querySelector('.compare-resolution').hidden, true, 'invalidated dimensions stay hidden until the new source is ready');
});

test('comparison original-mode headers fall back to decoded dimensions when metadata is absent', async t => {
  const ui = await setup(t, { maxPreviewResolution: 0 }), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b');
  ui.window.HTMLImageElement.prototype.decode = async function () {};
  for (const pending of ui.requests.filter(m => m.type === 'loadPreview' && m.detail)) {
    ui.send({ ...pending, type: 'preview', source: `https://original.test/${pending.id}` });
    const image = ui.imageFor(pending.requestId);
    Object.defineProperties(image, { naturalWidth: { value: 2560, configurable: true }, naturalHeight: { value: 1440, configurable: true } });
    image.dispatchEvent(new ui.window.Event('load'));
  }
  await comparisonTick();
  assert.deepEqual([...doc.querySelectorAll('.compare-resolution')].map(element => element.textContent), ['2560 × 1440', '2560 × 1440']);
});

test('comparison hot swaps preserve the right image, cameras and mouse latch across Space, repeat, blur and visibility', async t => {
  const ui = await setup(t), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b'); await readyComparison(ui);
  const root = doc.querySelector('.compare-view'), right = doc.querySelector('[data-side="1"] img'), left = doc.querySelector('[data-side="0"] img'), copy = doc.querySelector('.compare-reference-copy');
  assert.notEqual(copy, right); assert.equal(copy.src, right.src);
  assert.ok(doc.querySelector('.compare-toolbar .compare-toggle'));
  assert.equal(doc.querySelector('.compare-panels + .compare-toggle'), null, 'no overlay toggle covers the image divider');
  assert.equal(doc.querySelector('.compare-toggle').textContent, 'Left: A');
  const count = ui.requests.length, rightStyle = right.style.cssText;
  const key = (type, repeat = false) => doc.dispatchEvent(new ui.window.KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true, repeat }));
  key('keydown'); key('keydown', true); ui.click('.compare-toggle'); assert.equal(root.dataset.showingReference, 'true'); key('keyup'); assert.equal(root.dataset.showingReference, 'false', 'mouse input while Space is held cannot overwrite the pre-keydown state');
  ui.click('.compare-toggle'); assert.equal(root.dataset.showingReference, 'true'); assert.equal(doc.querySelector('.compare-toggle').textContent, 'Left: B');
  key('keydown'); key('keyup'); assert.equal(root.dataset.showingReference, 'true', 'Space restores the existing latched state');
  ui.click('.compare-toggle'); key('keydown'); ui.window.dispatchEvent(new ui.window.Event('blur')); assert.equal(root.dataset.showingReference, 'false');
  key('keydown'); Object.defineProperty(doc, 'hidden', { value: true, configurable: true }); doc.dispatchEvent(new ui.window.Event('visibilitychange')); assert.equal(root.dataset.showingReference, 'false');
  assert.equal(doc.querySelector('[data-side="1"] img'), right); assert.equal(right.style.cssText, rightStyle); assert.equal(left.hidden, false);
  assert.equal(ui.requests.length, count, 'prepared switches require no messages, network requests or decoding');
});

test('comparison cameras link normalized zoom and pan, work independently, fit on double click and transfer to browser', async t => {
  const ui = await setup(t), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b'); await readyComparison(ui);
  const stages = [...doc.querySelectorAll('.compare-stage')]; stages.forEach(stage => { stage.getBoundingClientRect = () => ({ width: 400, height: 300, left: 0, top: 0 }); });
  const wheel = (side, extra) => stages[side].dispatchEvent(new ui.window.WheelEvent('wheel', { deltaY: -40, clientX: 200, clientY: 150, ctrlKey: true, cancelable: true, ...extra }));
  wheel(0);
  for (const [type, x] of [['pointerdown', 200], ['pointermove', 240], ['pointerup', 240]]) stages[0].dispatchEvent(new ui.window.MouseEvent(type, { button: 0, clientX: x, clientY: 150 }));
  ui.click('[data-action=fullscreen]'); let request = ui.last('openComparisonInBrowser');
  assert.deepEqual(Array.from(request.ids), ['a', 'b']); assert.deepEqual(request.comparison.views[0], request.comparison.views[1]); assert.ok(request.comparison.views[0].zoom > 1);
  assert.ok(request.comparison.views[0].x < .5, 'dragging right moves both normalized centers left');
  ui.send({ ...request, type: 'browserComparisonOpened', opened: true });
  ui.click('[data-action=link]'); wheel(1); wheel(0, { ctrlKey: false, deltaX: 20, deltaY: 20 }); ui.click('.compare-toggle');
  ui.click('[data-action=fullscreen]'); request = ui.last('openComparisonInBrowser'); assert.equal(request.comparison.linked, false); assert.equal(request.comparison.showingReference, true); assert.notDeepEqual(request.comparison.views[0], request.comparison.views[1]);
  ui.send({ ...request, type: 'browserComparisonOpened', opened: false, error: 'test failure' });
  assert.equal(doc.querySelector('[data-action=fullscreen]').disabled, false);
  stages[0].dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true })); ui.click('[data-action=fullscreen]');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.last('openComparisonInBrowser').comparison.views[0])), { zoom: 1, x: .5, y: .5 });
});

test('macOS Ctrl pointer/contextmenu/click chooses once; ordinary context menus and simple clicks remain available', async t => {
  const ui = await setup(t), doc = ui.window.document, card = doc.querySelector('.image-card');
  card.dispatchEvent(new ui.window.MouseEvent('pointerdown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true }));
  const context = new ui.window.MouseEvent('contextmenu', { button: 2, ctrlKey: true, cancelable: true }); card.dispatchEvent(context); assert.equal(context.defaultPrevented, true);
  card.dispatchEvent(new ui.window.MouseEvent('click', { button: 0, ctrlKey: true, cancelable: true }));
  assert.equal(card.querySelector('.comparison-marker').textContent, 'A');
  const normalContext = new ui.window.MouseEvent('contextmenu', { button: 2, cancelable: true }); card.dispatchEvent(normalContext); assert.equal(normalContext.defaultPrevented, false);
  card.click(); assert.equal(doc.querySelector('#detail-view').classList.contains('hidden'), false); assert.equal(ui.last('loadCaption').id, 'a');
});

test('Command selection consumes the entire pointer gesture even if click arrives later without modifier flags', async t => {
  const ui = await setup(t), doc = ui.window.document;
  const select = async id => {
    const card = doc.querySelector(`[data-media-id="${id}"]`);
    card.dispatchEvent(new ui.window.MouseEvent('pointerdown', { button: 0, metaKey: true, bubbles: true, cancelable: true }));
    card.dispatchEvent(new ui.window.MouseEvent('pointerup', { button: 0, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    card.dispatchEvent(new ui.window.MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true }));
  };
  await select('a');
  assert.equal(doc.querySelector('#detail-view').classList.contains('hidden'), true, 'the trailing click must not open image details');
  assert.equal(doc.querySelector('#gallery-view').classList.contains('hidden'), false);
  assert.equal(doc.querySelector('[data-media-id=a] .comparison-marker').textContent, 'A');
  assert.equal(ui.requests.some(m => m.type === 'loadCaption'), false);
  await select('b'); assert.equal(doc.querySelectorAll('.comparison-marker').length, 2); ui.click('#compare-selected'); assert.ok(doc.querySelector('.compare-view'));
  assert.deepEqual(ui.requests.filter(m => m.type === 'loadPreview' && m.detail).map(m => m.id), ['a', 'b']);
});

test('selection does not swallow a following ordinary pointer gesture or keyboard activation', async t => {
  for (const keyboard of [false, true]) {
    const ui = await setup(t), card = ui.window.document.querySelector('.image-card');
    card.dispatchEvent(new ui.window.MouseEvent('pointerdown', { button: 0, ctrlKey: true, cancelable: true }));
    const context = new ui.window.MouseEvent('contextmenu', { button: 2, cancelable: true }); card.dispatchEvent(context);
    assert.equal(context.defaultPrevented, true, 'the recognized Ctrl gesture suppresses its context menu even when the flag is missing');
    if (keyboard) card.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    else card.dispatchEvent(new ui.window.MouseEvent('pointerdown', { button: 0, bubbles: true }));
    card.click(); assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('hidden'), false);
  }
});

test('comparison loads fail per side, retry original, ignore late results and invalidate while hidden', async t => {
  const ui = await setup(t), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b');
  const old = ui.requests.filter(m => m.type === 'loadPreview'); ui.send({ ...old[0], type: 'previewError', message: 'corrupt image' }); await comparisonTick();
  assert.match(doc.querySelector('[data-side="0"] .compare-feedback').textContent, /corrupt image/);
  assert.equal(doc.querySelector('.compare-toggle').disabled, true);
  ui.click('[data-original="0"]'); assert.equal(ui.last('loadPreview').original, true);
  const retry = ui.last('loadPreview'); ui.send({ ...old[0], type: 'preview', source: 'https://stale.test/a' }); assert.equal(ui.imageFor(retry.requestId).hasAttribute('src'), false);
  ui.send({ type: 'panelVisibility', visible: false });
  ui.send({ type: 'previewConfigurationChanged', resolution: 512 }); ui.send({ type: 'panelVisibility', visible: true });
  assert.equal(ui.last('loadPreview').resolution, 512); assert.equal(ui.requests.some(m => m.type === 'loadCaption'), false);
  ui.send({ type: 'images', images: [records[0]] }); assert.equal(doc.querySelector('.compare-view'), null);
  assert.equal(doc.querySelectorAll('.comparison-marker').length, 1);
  assert.equal(doc.querySelector('[data-media-id=a] .comparison-marker').textContent, 'A');
});

test('comparison selection survives virtual grid recycling and refresh removes only missing files', async t => {
  const media = Array.from({ length: 1000 }, (_, i) => ({ id: `item${i}`, name: `image${i}.jpg`, relativePath: `image${i}.jpg` }));
  const ui = await setup(t, {}, {}, media), doc = ui.window.document, viewport = doc.querySelector('#gallery-view');
  selectComparison(ui, 'item0'); viewport.scrollTop = 10000; viewport.dispatchEvent(new ui.window.Event('scroll')); ui.flushFrames();
  assert.equal(doc.querySelector('[data-media-id=item0]'), null);
  viewport.scrollTop = 0; viewport.dispatchEvent(new ui.window.Event('scroll')); ui.flushFrames();
  assert.equal(doc.querySelector('[data-media-id=item0] .comparison-marker').textContent, 'A');
  ui.send({ type: 'images', images: media.slice(1) }); assert.equal(doc.querySelectorAll('.comparison-marker').length, 0);
});

test('comparison pins oversized originals and the independent reference copy until exit, then restores eviction', async t => {
  const ui = await setup(t, { maxPreviewResolution: 0 }), doc = ui.window.document;
  selectComparison(ui, 'a'); selectComparison(ui, 'b'); await readyComparison(ui, 6000, 3000);
  assert.equal(doc.querySelector('.compare-view').dataset.ready, 'true'); assert.equal(doc.querySelectorAll('.compare-view img').length, 3);
  const count = ui.requests.filter(m => m.type === 'loadPreview').length;
  for (let i = 0; i < 10; i++) ui.click('.compare-toggle');
  assert.equal(ui.requests.filter(m => m.type === 'loadPreview').length, count); assert.equal(doc.querySelector('[data-side="1"] img').hasAttribute('src'), true);
  ui.click('[data-action=back]'); assert.ok(ui.requests.filter(m => m.type === 'releasePreview').length >= 2);
  ui.click('#compare-selected'); assert.equal(ui.requests.filter(m => m.type === 'loadPreview').length, count + 2);
});

test('automatic comparison delays 350 ms, preserves the pair on exit and clears only on a fresh Gallery Escape', async t => {
  const ui = await setup(t, { showCaption: true }, {}, records, true), doc = ui.window.document;
  const viewport = doc.querySelector('#gallery-view'); viewport.scrollTop = 125;
  for (const exit of ['button', 'Escape']) {
    clickComparisonSelection(ui, 'a'); assert.equal(doc.querySelector('[data-media-id=a] .comparison-marker').textContent, 'A');
    ui.advance(1000); assert.equal(doc.querySelector('.compare-view'), null, 'one image cannot auto-open');
    clickComparisonSelection(ui, 'b');
    assert.equal(doc.querySelector('#gallery-view').classList.contains('hidden'), false);
    assert.equal(doc.querySelectorAll('.comparison-marker').length, 2);
    assert.equal(doc.querySelector('[data-media-id=b] .comparison-marker').textContent, 'B');
    assert.equal(ui.requests.some(m => m.type === 'loadCaption'), false);
    ui.advance(349); assert.equal(doc.querySelector('.compare-view'), null);
    ui.advance(1); assert.ok(doc.querySelector('.compare-view'));
    if (exit === 'button') ui.click('[data-action=back]');
    else doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.querySelector('.compare-view'), null); assert.equal(viewport.scrollTop, 125);
    assert.equal(doc.querySelectorAll('.comparison-marker').length, 2);
    assert.equal(doc.querySelector('#compare-selected').disabled, false);
    ui.advance(1000); assert.equal(doc.querySelector('.compare-view'), null, 'exit cannot schedule another comparison');
    doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true }));
    assert.equal(doc.querySelectorAll('.comparison-marker').length, 2, 'holding Escape cannot clear the returned pair');
    doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.querySelectorAll('.comparison-marker, .comparison-selected').length, 0);
    assert.equal(doc.querySelector('#compare-selected').disabled, true);
  }
});

test('pending comparison is cancelled by changed selection, clear, search, refresh, preview, settings, hiding or Escape', async t => {
  for (const action of ['deselect', 'clear', 'search', 'refresh', 'missing', 'preview', 'settings', 'hidden', 'blur', 'Escape']) {
    const ui = await setup(t, {}, {}, records, true), doc = ui.window.document;
    clickComparisonSelection(ui, 'a'); clickComparisonSelection(ui, 'b');
    if (action === 'deselect') clickComparisonSelection(ui, 'b');
    else if (action === 'clear') ui.click('#clear-comparison');
    else if (action === 'search') { const field = doc.querySelector('#search'); field.value = 'a'; field.dispatchEvent(new ui.window.Event('input')); }
    else if (action === 'refresh') ui.send({ type: 'loading', scanId: 2 });
    else if (action === 'missing') ui.send({ type: 'images', images: [records[0]] });
    else if (action === 'preview') ui.click('[data-media-id=a]');
    else if (action === 'settings') ui.click('#gallery-settings');
    else if (action === 'hidden') ui.send({ type: 'panelVisibility', visible: false });
    else ui.window.dispatchEvent(action === 'blur' ? new ui.window.Event('blur') : new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
    ui.advance(1000); assert.equal(doc.querySelector('.compare-view'), null, action);
    if (action !== 'preview') assert.equal(ui.requests.some(m => m.type === 'loadPreview' && m.detail), false, action);
  }
});

async function setup(t, settings, persisted = {}, media = records, controlledClock = false) {
  const host = await createHost(t, settings);
  const dom = new JSDOM(host.panel.webview.html, { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, requests = [];
  let now = 0, timerId = 0; const timers = new Map();
  if (controlledClock) {
    window.setTimeout = (fn, delay = 0, ...args) => { const id = --timerId; timers.set(id, { time: now + Number(delay), fn, args }); return id; };
    window.clearTimeout = id => timers.delete(id);
  }
  const advance = milliseconds => {
    const end = now + milliseconds;
    for (let limit = 0; limit < 1000; limit++) {
      const due = [...timers].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
      if (!due) { now = end; return; }
      timers.delete(due[0]); now = due[1].time; due[1].fn(...due[1].args);
    }
    throw new Error('Controlled clock did not settle.');
  };
  const mediaCalls = [], paused = new WeakMap();
  window.HTMLMediaElement.prototype.load = function () { mediaCalls.push({ type: 'load', element: this }); };
  window.HTMLMediaElement.prototype.pause = function () { paused.set(this, true); mediaCalls.push({ type: 'pause', element: this }); };
  window.HTMLMediaElement.prototype.play = function () { paused.set(this, false); mediaCalls.push({ type: 'play', element: this }); return Promise.resolve(); };
  Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return paused.get(this) ?? true; } });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector('[autofocus]')?.focus(); };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const createdImages = [], createElement = window.document.createElement.bind(window.document);
  window.document.createElement = (...args) => { const element = createElement(...args); if (args[0] === 'img') { createdImages.push(element); } return element; };
  let state = persisted;
  window.acquireVsCodeApi = () => ({ getState: () => state, setState: (next) => { state = next; }, postMessage: (m) => requests.push(m) });
  let observer;
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observer = this; }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
    unobserve(target) { this.targets.delete(target); }
  };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  const frames = new Map(); let frameId = 0;
  window.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrames = () => { const current = [...frames.values()]; frames.clear(); current.forEach((fn) => fn()); };
  window.eval(fs.readFileSync(path.join(__dirname, '../media/galleryGrid.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../media/videoStream.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../media/fileContextMenu.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../media/compareView.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8'));
  const send = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const click = (selector) => window.document.querySelector(selector).click();
  const last = (type) => requests.filter((m) => m.type === type).at(-1);
  const visible = (isIntersecting = true) => observer.callback([...observer.targets].map((target) => ({ target, isIntersecting })));
  send({ type: 'images', images: media });
  return { window, requests, mediaCalls, send, click, last, visible, flushFrames, advance, imageFor: (token) => createdImages.find((image) => image.dataset.previewRequest === token), state: () => state };
}

function caption(ui, request, text = 'hello') {
  ui.send({ type: 'caption', id: request.id, requestId: request.requestId, caption: text, renderedCaption: `<p>${text}</p>`, exists: true, revision: 'rev1' });
}

test('pure image mode makes no caption requests; restoring Text always fetches fresh data', async (t) => {
  const ui = await setup(t, { showCaption: false });
  ui.click('.image-card');
  assert.equal(ui.requests.some((m) => m.type === 'loadCaption'), false);
  assert.ok(ui.window.document.querySelector('#detail-view').classList.contains('text-hidden'));
  ui.click('#next');
  assert.equal(ui.requests.some((m) => m.type === 'loadCaption'), false);
  ui.click('#toggle-caption');
  const first = ui.last('loadCaption');
  assert.equal(first.id, 'b');
  caption(ui, first, 'first');
  ui.click('#toggle-caption');
  caption(ui, first, 'stale');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, '');
  ui.click('#toggle-caption');
  const second = ui.last('loadCaption');
  assert.notEqual(second.requestId, first.requestId);
  caption(ui, first, 'stale');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'Loading caption…');
  caption(ui, second, 'latest');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'latest');
});

test('toolbar toggles captions, session state wins, and new galleries use the configured default', async (t) => {
  const ui = await setup(t, { showCaption: true });
  ui.click('#toggle-caption');
  assert.equal(ui.state().textPaneHidden, true);
  ui.click('.image-card');
  assert.equal(ui.requests.some((m) => m.type === 'loadCaption'), false);
  const restored = await setup(t, { showCaption: true }, ui.state());
  assert.equal(restored.window.document.querySelector('#toggle-caption').getAttribute('aria-pressed'), 'false');
  const fresh = await setup(t, { showCaption: true });
  assert.equal(fresh.window.document.querySelector('#toggle-caption').getAttribute('aria-pressed'), 'true');
});

test('E opens caption editing, waits for hidden captions, and never steals typing or modified keys', async (t) => {
  const ui = await setup(t, { showCaption: true }), doc = ui.window.document;
  doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector('#detail-view').classList.contains('hidden'), true, 'Gallery does not consume E');
  ui.click('.image-card');
  caption(ui, ui.last('loadCaption'), 'existing caption');
  doc.querySelector('#detail-view').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
  const editor = doc.querySelector('#caption-editor');
  assert.equal(editor.classList.contains('hidden'), false);
  assert.equal(doc.activeElement, editor);
  editor.value = 'typed e';
  editor.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
  assert.equal(editor.value, 'typed e', 'typing in the editor remains independent');

  const hidden = await setup(t, { showCaption: false }), hiddenDoc = hidden.window.document;
  hidden.click('.image-card');
  const target = hiddenDoc.querySelector('#detail-view');
  target.dispatchEvent(new hidden.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true, metaKey: true }));
  assert.equal(hidden.requests.some(message => message.type === 'loadCaption'), false, 'modified E is left to the platform');
  target.dispatchEvent(new hidden.window.KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
  assert.equal(target.classList.contains('text-hidden'), false);
  const request = hidden.last('loadCaption');
  assert.ok(request, 'E reveals Caption and requests the current text');
  assert.equal(hiddenDoc.querySelector('#caption-editor').classList.contains('hidden'), true, 'editing waits for the caption response');
  caption(hidden, request, 'loaded later');
  assert.equal(hiddenDoc.querySelector('#caption-editor').classList.contains('hidden'), false);
  assert.equal(hiddenDoc.activeElement, hiddenDoc.querySelector('#caption-editor'));
});

test('unsaved captions are preserved on Continue; Save and Discard hide Text only after a decision', async (t) => {
  for (const decision of ['continue', 'save', 'discard']) {
    const ui = await setup(t, { showCaption: true });
    ui.click('.image-card'); caption(ui, ui.last('loadCaption'));
    ui.click('#edit-caption');
    const editor = ui.window.document.querySelector('#caption-editor');
    editor.value = 'draft'; editor.dispatchEvent(new ui.window.Event('input'));
    ui.click('#toggle-caption');
    const confirmation = ui.last('confirmUnsaved');
    assert.ok(confirmation);
    assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('text-hidden'), false);
    ui.send({ type: 'unsavedDecision', requestId: confirmation.requestId, decision });
    if (decision === 'save') {
      assert.equal(ui.last('saveCaption').caption, 'draft');
      assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('text-hidden'), false);
      ui.send({ type: 'captionSaved', id: 'a', caption: 'draft', renderedCaption: '<p>draft</p>', exists: true, revision: 'rev2' });
    }
    assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('text-hidden'), decision !== 'continue');
    if (decision === 'continue') { assert.equal(editor.value, 'draft'); }
  }
});

test('requests only visible thumbnails and releases them when they leave the viewport', async (t) => {
  const ui = await setup(t);
  assert.equal(ui.requests.some((m) => m.type === 'loadPreview'), false);
  ui.visible();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 2);
  ui.visible(false);
  assert.equal(ui.requests.filter((m) => m.type === 'releasePreview').length, 2);
});

test('rapid A→B→C→B→A ignores stale previews and captions; resolution changes preserve caption drafts', async (t) => {
  const ui = await setup(t, {}, {}, ['a', 'b', 'c'].map((id) => ({ id, name: `${id}.jpg`, relativePath: `${id}.jpg` })));
  ui.click('.image-card'); const oldPreview = ui.last('loadPreview'), oldCaption = ui.last('loadCaption');
  ui.click('#next'); ui.click('#next'); ui.click('#previous'); ui.click('#previous');
  const current = ui.last('loadPreview');
  ui.send({ type: 'preview', ...oldPreview, type: 'preview', source: 'https://stale.test/image' });
  assert.equal(ui.window.document.querySelector('#detail-image').hasAttribute('src'), false);
  ui.send({ ...current, type: 'preview', source: 'https://preview.test/image', originalWidth: 4096, originalHeight: 4096, width: 2048, height: 2048 });
  const image = ui.window.document.querySelector('#detail-image');
  Object.defineProperties(image, { naturalWidth: { value: 2048 }, naturalHeight: { value: 2048 } });
  image.dispatchEvent(new ui.window.Event('load'));
  assert.equal(ui.window.document.querySelector('#image-width').textContent, '4096');
  assert.match(ui.window.document.querySelector('.image-dimensions').title, /Preview: 2048 × 2048/);
  caption(ui, oldCaption, 'stale');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'Loading caption…');
  caption(ui, ui.last('loadCaption'));
  ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor'); editor.value = 'keep draft';
  ui.send({ type: 'previewConfigurationChanged' });
  assert.equal(editor.value, 'keep draft');
  assert.equal(editor.classList.contains('hidden'), false);
  assert.notEqual(ui.last('loadPreview').requestId, current.requestId);
});

test('preview failure offers an explicit original request, without automatic original transfer', async (t) => {
  const ui = await setup(t);
  ui.click('.image-card');
  const pending = ui.last('loadPreview');
  ui.send({ ...pending, type: 'previewError', message: 'bad file' });
  assert.equal(ui.window.document.querySelector('#load-original').classList.contains('hidden'), false);
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 1);
  ui.click('#load-original');
  assert.equal(ui.last('loadPreview').original, true);
});


async function zoomSetup(t, settings) {
  const ui = await setup(t, settings);
  ui.click('.image-card');
  const pending = ui.last('loadPreview');
  ui.send({ ...pending, type: 'preview', source: 'https://preview.test/image' });
  const stage = ui.window.document.querySelector('#image-stage');
  const image = ui.window.document.querySelector('#detail-image');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  image.dispatchEvent(new ui.window.Event('load'));
  const wheel = (deltaY, extra = {}) => {
    const event = new ui.window.WheelEvent('wheel', { deltaY, clientX: 200, clientY: 150, ctrlKey: true, cancelable: true, ...extra });
    stage.dispatchEvent(event); return event;
  };
  return { ...ui, stage, image, wheel, zoom: () => Number(ui.window.document.querySelector('#reset-image-zoom').textContent.replace('%', '')) };
}

test('pinch zoom responds five times faster by default, remains bounded, and resets with the percentage button', async (t) => {
  const ui = await zoomSetup(t);
  const event = ui.wheel(-40);
  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.zoom(), 149);
  const scale = Number(ui.image.style.transform.match(/scale\(([^)]+)\)/)[1]);
  assert.ok(parseFloat(ui.image.style.width) * scale > 590);
  for (let i = 0; i < 20; i++) { ui.wheel(-40); }
  assert.equal(ui.zoom(), 800);
  for (let i = 0; i < 20; i++) { ui.wheel(40); }
  assert.equal(ui.zoom(), 25);
  ui.click('#reset-image-zoom');
  assert.equal(ui.zoom(), 100);
  assert.equal(parseFloat(ui.image.style.width), 400);
  ui.wheel(-40); ui.stage.dispatchEvent(new ui.window.MouseEvent('dblclick'));
  assert.equal(ui.zoom(), 100);
});

test('zoom sensitivity can change live and wheel line/page units are normalized', async (t) => {
  const previous = await zoomSetup(t, { zoomSensitivity: 1 });
  previous.wheel(-40);
  assert.equal(previous.zoom(), 108);
  previous.click('#reset-image-zoom');
  previous.send({ type: 'zoomConfigurationChanged', sensitivity: 5 });
  previous.wheel(-40);
  assert.equal(previous.zoom(), 149);
  previous.click('#reset-image-zoom'); previous.wheel(-1, { deltaMode: 1 });
  const line = previous.zoom();
  previous.click('#reset-image-zoom'); previous.wheel(-16);
  assert.equal(previous.zoom(), line);
  previous.click('#reset-image-zoom'); previous.wheel(-0.1, { deltaMode: 2 });
  assert.equal(previous.zoom(), 135);
  const beforePan = previous.zoom();
  previous.wheel(10, { ctrlKey: false, deltaX: 5 });
  assert.equal(previous.zoom(), beforePan, 'Plain two-finger scrolling pans instead of zooming');
});


const mixedMedia = [
  records[0],
  { id: 'clip', name: 'clip.MP4', relativePath: 'clips/clip.MP4', kind: 'video' },
  records[1],
];
async function videoSetup(t, showCaption = false) {
  const ui = await setup(t, { showCaption }, {}, mixedMedia);
  ui.click('.image-card:nth-child(2)');
  const pending = ui.last('loadVideo');
  ui.send({ ...pending, type: 'video', source: 'https://video.test/clip.mp4' });
  return { ...ui, video: ui.window.document.querySelector('#detail-video') };
}

test('video tiles do not fetch video contents; detail uses native controls without autoplay or bitmap decoding', async (t) => {
  const ui = await setup(t, { showCaption: false }, {}, mixedMedia);
  assert.equal(ui.window.document.querySelectorAll('.video-thumbnail').length, 1);
  ui.visible();
  assert.equal(ui.requests.some((m) => m.type === 'loadVideo'), false);
  ui.click('.image-card:nth-child(2)');
  const pending = ui.last('loadVideo');
  assert.equal(pending.id, 'clip');
  assert.equal(ui.requests.some((m) => m.type === 'loadPreview' && m.id === 'clip'), false);
  assert.equal(ui.requests.some((m) => m.type === 'loadCaption'), false);
  const video = ui.window.document.querySelector('#detail-video');
  assert.equal(video.controls, true); assert.equal(video.autoplay, false);
  assert.equal(video.preload, 'metadata');
  assert.equal(video.classList.contains('hidden'), false);
  assert.equal(ui.window.document.querySelector('#detail-image').classList.contains('hidden'), true);
  assert.equal(ui.window.document.querySelector('#image-zoom-field').classList.contains('hidden'), true);
  ui.send({ ...pending, type: 'video', source: 'https://video.test/clip.mp4' });
  assert.equal(ui.mediaCalls.filter((m) => m.type === 'play').length, 0);
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
  video.dispatchEvent(new ui.window.Event('loadedmetadata'));
  video.dispatchEvent(new ui.window.Event('loadeddata'));
  assert.equal(ui.window.document.querySelector('#image-width').textContent, '1920');
  assert.equal(ui.window.document.querySelector('#image-height').textContent, '1080');
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
});

test('Space toggles playback, focused player keys stay native, and caption/layout changes preserve playback', async (t) => {
  const ui = await videoSetup(t);
  const space = () => ui.window.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', cancelable: true }));
  space(); assert.equal(ui.video.paused, false);
  space(); assert.equal(ui.video.paused, true);
  space();
  ui.video.currentTime = 3.5; ui.video.volume = 0.25; ui.video.playbackRate = 1.5;
  const right = new ui.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  ui.video.dispatchEvent(right);
  assert.equal(right.defaultPrevented, false);
  assert.equal(ui.video.hasAttribute('src'), true);
  ui.click('#toggle-caption'); caption(ui, ui.last('loadCaption'), 'video caption');
  ui.click('#toggle-caption'); ui.send({ type: 'previewConfigurationChanged' });
  assert.equal(ui.video.currentTime, 3.5); assert.equal(ui.video.volume, 0.25);
  assert.equal(ui.video.playbackRate, 1.5); assert.equal(ui.video.paused, false);
  ui.send({ type: 'panelVisibility', visible: false });
  assert.equal(ui.video.paused, true);
  assert.equal(ui.video.hasAttribute('src'), true);
});

test('switching away or returning to Gallery stops video requests and ignores stale video responses', async (t) => {
  const ui = await videoSetup(t);
  const stale = ui.last('loadVideo');
  ui.window.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: ' ', code: 'Space' }));
  ui.click('#next');
  assert.equal(ui.video.paused, true); assert.equal(ui.video.hasAttribute('src'), false);
  assert.equal(ui.last('loadPreview').id, 'b');
  ui.send({ ...stale, type: 'video', source: 'https://stale.test/video.mp4' });
  assert.equal(ui.video.hasAttribute('src'), false);
  ui.click('#previous');
  const current = ui.last('loadVideo');
  assert.notEqual(current.requestId, stale.requestId);
  ui.send({ ...stale, type: 'video', source: 'https://stale.test/video.mp4' });
  assert.equal(ui.video.hasAttribute('src'), false);
  ui.send({ ...current, type: 'video', source: 'https://video.test/latest.mp4' });
  ui.click('#back');
  assert.equal(ui.video.paused, true); assert.equal(ui.video.hasAttribute('src'), false);
});

test('video captions retain unsaved-edit protection when navigating to an image', async (t) => {
  const ui = await videoSetup(t, true);
  caption(ui, ui.last('loadCaption'), 'video caption');
  ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor');
  editor.value = 'video draft'; editor.dispatchEvent(new ui.window.Event('input'));
  ui.click('#next');
  const first = ui.last('confirmUnsaved');
  ui.send({ type: 'unsavedDecision', requestId: first.requestId, decision: 'continue' });
  assert.equal(editor.value, 'video draft'); assert.equal(ui.video.hasAttribute('src'), true);
  ui.click('#next');
  ui.send({ type: 'unsavedDecision', requestId: ui.last('confirmUnsaved').requestId, decision: 'discard' });
  assert.equal(ui.video.hasAttribute('src'), false);
  assert.equal(ui.last('loadPreview').id, 'b');
});

test('unsupported video codecs show an actionable error and do not request image fallback', async (t) => {
  const ui = await videoSetup(t);
  ui.video.dispatchEvent(new ui.window.Event('error'));
  assert.match(ui.window.document.querySelector('#video-feedback-message').textContent, /Playback failed/);
  assert.equal(ui.window.document.querySelector('#video-fallback').classList.contains('hidden'), false);
  ui.click('#video-fallback');
  const compatible = ui.last('loadVideo');
  assert.equal(compatible.compatible, true);
  assert.equal(ui.requests.some((m) => m.type === 'loadPreview'), false);
  ui.send({ ...compatible, type: 'videoProgress', progress: 45 });
  assert.match(ui.window.document.querySelector('#video-feedback-message').textContent, /45%/);
  ui.send({ ...compatible, type: 'video', converted: true, source: 'https://video.test/compatible.mp4' });
  ui.video.dispatchEvent(new ui.window.Event('error'));
  assert.equal(ui.window.document.querySelector('#video-fallback').classList.contains('hidden'), false);
  assert.equal(ui.video.paused, true);
});


test('video configuration reload keeps caption drafts and ignores old transcode progress', async (t) => {
  const ui = await videoSetup(t, true);
  caption(ui, ui.last('loadCaption'), 'video caption');
  ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor');
  editor.value = 'draft'; editor.dispatchEvent(new ui.window.Event('input'));
  const stale = ui.last('loadVideo');
  ui.send({ type: 'videoConfigurationChanged' });
  const latest = ui.last('loadVideo'); assert.notEqual(latest.requestId, stale.requestId);
  assert.equal(editor.value, 'draft');
  ui.send({ ...stale, type: 'videoProgress', progress: 99 });
  assert.equal(ui.window.document.querySelector('#video-feedback-message').textContent, 'Loading video…');
  ui.send({ ...latest, type: 'video', source: 'https://video.test/new.mp4', note: 'Install FFmpeg for audio compatibility.' });
  assert.match(ui.window.document.querySelector('#video-playback-info').textContent, /Install FFmpeg/);
  ui.send({ type: 'previewConfigurationChanged' });
  assert.equal(ui.last('loadVideo').requestId, latest.requestId);
  assert.equal(ui.video.hasAttribute('src'), true);
});

const manyRecords = (length) => Array.from({ length }, (_, index) => ({ id: `frame-${index}`, name: `frame-${index}.jpg`, relativePath: `dataset/frame-${index}.jpg` }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('100,000 records keep DOM bounded and thumbnail requests limited while scrolling, opening and returning', async (t) => {
  const ui = await setup(t, { showCaption: false }, {}, manyRecords(100000));
  const document = ui.window.document, viewport = document.querySelector('#gallery-view');
  assert.ok(document.querySelectorAll('.image-card').length < 40);
  assert.match(document.querySelector('#count').textContent, /100000 \/ 100000/);
  ui.visible();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 4);
  const first = ui.last('loadPreview');
  ui.send({ ...first, type: 'preview', source: 'https://preview.test/thumb' });
  document.querySelector(`img[data-image-id="${first.id}"]`).dispatchEvent(new ui.window.Event('load'));
  await tick();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 5);
  viewport.scrollTop = 3_000_000;
  viewport.dispatchEvent(new ui.window.Event('scroll')); ui.flushFrames();
  const firstVisible = document.querySelector('.image-card').dataset.mediaId;
  assert.ok(Number(firstVisible.split('-')[1]) > 10000);
  assert.ok(document.querySelectorAll('.image-card').length < 40);
  assert.ok(ui.requests.some((m) => m.type === 'releasePreview' && m.requestId === first.requestId));
  ui.visible();
  ui.click('.image-card');
  assert.equal(ui.last('loadPreview').id, firstVisible); assert.equal(ui.last('loadPreview').detail, true);
  assert.equal(document.querySelectorAll('.image-card').length, 0);
  assert.equal(ui.requests.some((m) => m.type === 'loadCaption'), false);
  ui.send({ type: 'panelVisibility', visible: false });
  ui.send({ type: 'panelVisibility', visible: true });
  ui.click('#back');
  assert.equal(viewport.scrollTop, 3_000_000);
  assert.equal(document.querySelector('.image-card').dataset.mediaId, firstVisible);
});

test('large gallery search is debounced, includes offscreen files, and keyboard navigation reaches the end', async (t) => {
  const ui = await setup(t, {}, {}, manyRecords(100000));
  const document = ui.window.document, search = document.querySelector('#search');
  search.value = 'frame-99999.jpg'; search.dispatchEvent(new ui.window.Event('input'));
  assert.match(document.querySelector('#count').textContent, /100000 \/ 100000/);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(document.querySelectorAll('.image-card').length, 1);
  assert.equal(document.querySelector('.filename').textContent, 'frame-99999.jpg');
  search.value = ''; search.dispatchEvent(new ui.window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 140));
  const card = document.querySelector('.image-card');
  card.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.dataset.mediaId, 'frame-99999');
  assert.ok(document.querySelectorAll('.image-card').length < 40);
  document.activeElement.click();
  assert.equal(ui.last('loadPreview').id, 'frame-99999');
  assert.equal(document.querySelector('#next').disabled, true);
});

test('incremental scans render batches, discard old scans, and apply final ordering without a full resend', async (t) => {
  const ui = await setup(t, {}, {}, []);
  ui.send({ type: 'loading', scanId: 1 });
  ui.send({ type: 'imageBatch', scanId: 1, images: manyRecords(512) });
  assert.match(ui.window.document.querySelector('#count').textContent, /512.*scanning/);
  assert.ok(ui.window.document.querySelectorAll('.image-card').length < 40);
  ui.send({ type: 'loading', scanId: 2 });
  ui.send({ type: 'imageBatch', scanId: 1, images: manyRecords(512) });
  ui.send({ type: 'imageBatch', scanId: 2, images: manyRecords(2) });
  ui.send({ type: 'images', scanId: 1, order: [0] });
  ui.send({ type: 'images', scanId: 2, order: [1, 0] });
  assert.equal(ui.window.document.querySelectorAll('.image-card').length, 2);
  assert.equal(ui.window.document.querySelector('.filename').textContent, 'frame-1.jpg');
  assert.doesNotMatch(ui.window.document.querySelector('#count').textContent, /scanning/);
});

test('panel hiding releases grid images and restores the viewport without restarting details', async (t) => {
  const ui = await setup(t, {}, {}, manyRecords(1000));
  ui.visible(); const old = ui.last('loadPreview');
  ui.send({ type: 'panelVisibility', visible: false });
  assert.equal(ui.window.document.querySelectorAll('.image-card').length, 0);
  assert.ok(ui.requests.some((m) => m.type === 'releasePreview' && m.requestId === old.requestId));
  ui.send({ type: 'panelVisibility', visible: true });
  assert.ok(ui.window.document.querySelectorAll('.image-card').length > 0);
  ui.click('.image-card'); const detail = ui.last('loadPreview');
  ui.send({ type: 'panelVisibility', visible: false });
  ui.send({ type: 'panelVisibility', visible: true });
  assert.equal(ui.last('loadPreview').requestId, detail.requestId);
  assert.equal(ui.window.document.querySelectorAll('.image-card').length, 0);
});

function changeSetting(ui, selector, value, type = 'change') {
  const input = ui.window.document.querySelector(selector);
  input.value = value; input.dispatchEvent(new ui.window.Event(type, { bubbles: true }));
}

test('compact toolbars expose one settings drawer; Escape closes it without leaving the current media', async (t) => {
  const ui = await setup(t);
  const document = ui.window.document;
  assert.equal(document.querySelector('.toolbar #thumbnail-size'), null);
  assert.equal(document.querySelector('.detail-header #caption-mode'), null);
  assert.ok(document.querySelector('#settings-dialog #caption-mode'));
  ui.click('#gallery-settings');
  assert.equal(document.querySelector('#settings-dialog').open, true);
  assert.equal(document.activeElement.id, 'close-settings');
  ui.click('#close-settings');
  assert.equal(document.activeElement.id, 'gallery-settings');
  ui.click('.image-card'); const request = ui.last('loadPreview');
  ui.click('#detail-settings');
  document.activeElement.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(ui.last('loadPreview').requestId, request.requestId);
  document.activeElement.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#settings-dialog').open, false);
  assert.equal(document.querySelector('#detail-view').classList.contains('hidden'), false);
  assert.equal(document.activeElement.id, 'detail-settings');
});

test('preview settings apply to current requests, validate custom values, retain drafts, and restore per gallery', async (t) => {
  const ui = await setup(t, { maxPreviewResolution: 2048 });
  ui.click('.image-card'); caption(ui, ui.last('loadCaption'));
  ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor'); editor.value = 'keep this draft'; editor.dispatchEvent(new ui.window.Event('input'));
  const captions = ui.requests.filter((m) => m.type === 'loadCaption').length;
  ui.click('#detail-settings');
  changeSetting(ui, '#preview-resolution', '1024');
  assert.equal(ui.last('loadPreview').resolution, 1024);
  assert.equal(editor.value, 'keep this draft'); assert.equal(editor.classList.contains('hidden'), false);
  changeSetting(ui, '#preview-resolution', 'custom');
  const before = ui.last('loadPreview');
  changeSetting(ui, '#custom-resolution', '-1');
  assert.equal(ui.last('loadPreview').requestId, before.requestId);
  assert.equal(ui.window.document.querySelector('#custom-resolution').getAttribute('aria-invalid'), 'true');
  changeSetting(ui, '#custom-resolution', '1536');
  assert.equal(ui.last('loadPreview').resolution, 1536);
  assert.equal(ui.window.document.querySelector('#custom-resolution').hasAttribute('aria-invalid'), false);
  changeSetting(ui, '#zoom-sensitivity', '8', 'input');
  assert.equal(ui.state().zoomSensitivity, 8);
  changeSetting(ui, '#pane-layout', 'side');
  changeSetting(ui, '#pane-split', '72', 'input');
  changeSetting(ui, '#pane-layout', 'stacked');
  assert.equal(ui.window.document.querySelector('#detail-view').dataset.layout, 'stacked');
  assert.equal(ui.window.document.querySelector('#pane-split').disabled, true);
  assert.equal(ui.state().splitRatio, 0.72);
  changeSetting(ui, '#text-zoom', '130');
  assert.equal(ui.state().textZoomPercent, 130);
  assert.equal(ui.requests.filter((m) => m.type === 'loadCaption').length, captions);
  const restored = await setup(t, { maxPreviewResolution: 2048 }, ui.state());
  restored.click('.image-card'); assert.equal(restored.last('loadPreview').resolution, 1536);
  assert.equal(restored.window.document.querySelector('#pane-layout').value, 'stacked');
  const fresh = await setup(t, { maxPreviewResolution: 2048 });
  fresh.click('.image-card'); assert.equal(fresh.last('loadPreview').resolution, 2048);
});

test('caption toggle inside settings protects unsaved edits and remains accessible in pure browsing', async (t) => {
  const ui = await setup(t);
  ui.click('.image-card'); caption(ui, ui.last('loadCaption'));
  ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor'); editor.value = 'draft'; editor.dispatchEvent(new ui.window.Event('input'));
  ui.click('#detail-settings'); ui.click('#toggle-caption');
  const decision = ui.last('confirmUnsaved'); assert.equal(decision.reason, 'hideText');
  ui.send({ type: 'unsavedDecision', requestId: decision.requestId, decision: 'continue' });
  assert.equal(editor.value, 'draft');
  assert.equal(ui.window.document.querySelector('#toggle-caption').getAttribute('aria-pressed'), 'true');
  ui.click('#toggle-caption');
  ui.send({ type: 'unsavedDecision', requestId: ui.last('confirmUnsaved').requestId, decision: 'discard' });
  assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('text-hidden'), true);
  assert.equal(ui.window.document.querySelector('#edit-caption').classList.contains('hidden'), true);
  ui.click('#close-settings'); ui.click('#detail-settings'); ui.click('#toggle-caption');
  assert.equal(ui.window.document.querySelector('#toggle-caption').getAttribute('aria-pressed'), 'true');
  assert.ok(ui.last('loadCaption'));
});

test('image zoom and gallery card size can be controlled from settings', async (t) => {
  const ui = await zoomSetup(t);
  ui.click('#detail-settings');
  changeSetting(ui, '#image-zoom-input', '200', 'input');
  assert.equal(ui.window.document.querySelector('#reset-image-zoom').textContent, '200%');
  ui.click('#reset-image-zoom');
  assert.equal(ui.window.document.querySelector('#image-zoom-input').value, '100');
  changeSetting(ui, '#thumbnail-size', '320', 'input');
  assert.equal(ui.state().thumbnailSize, 320);
  assert.equal(ui.window.document.documentElement.style.getPropertyValue('--thumbnail-size'), '320px');
});

test('opening settings preserves video playback; changing video compatibility sends current settings and keeps captions', async (t) => {
  const ui = await videoSetup(t, true);
  caption(ui, ui.last('loadCaption')); ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor'); editor.value = 'video draft';
  await ui.video.play(); ui.click('#detail-settings');
  assert.equal(ui.video.paused, false);
  ui.window.document.activeElement.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  assert.equal(ui.video.paused, false);
  changeSetting(ui, '#video-compatibility', 'auto');
  assert.equal(ui.last('loadVideo').videoCompatibility, 'auto');
  changeSetting(ui, '#ffmpeg-path', '/server/tools with spaces/ffmpeg');
  assert.equal(ui.last('loadVideo').ffmpegPath, '/server/tools with spaces/ffmpeg');
  const request = ui.last('loadVideo');
  changeSetting(ui, '#ffmpeg-path', '');
  assert.equal(ui.last('loadVideo').requestId, request.requestId);
  assert.equal(editor.value, 'video draft');
});

const preloadRecords = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: `${id}.jpg`, relativePath: `${id}.jpg` }));
function loadedImage(ui, request, extra = {}) {
  ui.send({ ...request, type: 'preview', source: `https://preview.test/${request.id}`, width: 800, height: 600, originalWidth: 1600, originalHeight: 1200, ...extra });
  const target = ui.imageFor(request.requestId);
  assert.ok(target, 'resource belongs to a live image element');
  Object.defineProperties(target, { naturalWidth: { configurable: true, value: 800 }, naturalHeight: { configurable: true, value: 600 } });
  target.dispatchEvent(new ui.window.Event('load'));
  return target;
}

test('preloads both neighbours while the current browser decode is pending; warm navigation swaps decoded images with no loading flash', async (t) => {
  const ui = await setup(t, {}, {}, preloadRecords);
  ui.click('.image-card:nth-child(2)');
  const current = ui.last('loadPreview');
  caption(ui, ui.last('loadCaption'), 'caption b');
  let decoded;
  ui.imageFor(current.requestId).decode = () => new Promise((resolve) => { decoded = resolve; });
  const b = loadedImage(ui, current);
  ui.flushFrames();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 3, 'host neighbours overlap current transfer/browser decode');
  decoded(); await new Promise(setImmediate); ui.flushFrames();
  const neighbours = ui.requests.filter((m) => m.type === 'loadPreview' && m.prefetch);
  assert.deepEqual(neighbours.map((m) => m.id), ['c', 'a']);
  assert.ok(neighbours.every((m) => m.detail && m.resolution === current.resolution), 'prefetch the detail resource, not a thumbnail');
  for (const request of ui.requests.filter((m) => m.type === 'loadCaption' && m.id !== 'b')) { caption(ui, request, `caption ${request.id}`); }
  const c = loadedImage(ui, neighbours[0]); loadedImage(ui, neighbours[1]);
  assert.equal(c.isConnected, false, 'neighbour images decode without adding hidden layout nodes');
  ui.click('#next');
  assert.equal(ui.window.document.querySelector('#detail-image'), c);
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
  assert.equal(c.classList.contains('loading'), false);
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'caption c');
  assert.equal(ui.window.document.querySelector('#image-width').textContent, '1600');
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview' && m.id === 'c').length, 1);
  ui.click('#previous');
  assert.equal(ui.window.document.querySelector('#detail-image'), b);
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'caption b');
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
  assert.equal(ui.window.document.querySelector('#reset-image-zoom').textContent, '100%');
  ui.flushFrames();
  const previews = ui.requests.filter((m) => m.type === 'loadPreview');
  const released = new Set(ui.requests.filter((m) => m.type === 'releasePreview').map((m) => m.requestId));
  assert.equal(previews.filter((m) => !released.has(m.requestId)).length, 3, 'window remains current plus two neighbours');
});

test('adopts in-flight preloads without duplicate requests, promotes priority, and rejects released results', async (t) => {
  const ui = await setup(t, {}, {}, preloadRecords);
  ui.click('.image-card:nth-child(2)'); loadedImage(ui, ui.last('loadPreview')); ui.flushFrames();
  const a = ui.requests.find((m) => m.type === 'loadPreview' && m.id === 'a');
  const c = ui.requests.find((m) => m.type === 'loadPreview' && m.id === 'c');
  const cCaption = ui.requests.find((m) => m.type === 'loadCaption' && m.id === 'c');
  ui.click('#next');
  assert.equal(ui.last('promotePreview').requestId, c.requestId);
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview' && m.id === 'c').length, 1);
  assert.equal(ui.requests.filter((m) => m.type === 'loadCaption' && m.id === 'c').length, 1);
  assert.ok(ui.requests.some((m) => m.type === 'releasePreview' && m.requestId === a.requestId));
  ui.send({ ...a, type: 'preview', source: 'https://stale.test/a' });
  assert.equal(ui.window.document.querySelector('#detail-image').hasAttribute('src'), false);
  caption(ui, cCaption, 'correct c');
  loadedImage(ui, c);
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'correct c');
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
  ui.flushFrames();
  const d = ui.last('loadPreview'); assert.equal(d.id, 'd');
  ui.click('#back');
  assert.ok(ui.requests.some((m) => m.type === 'releasePreview' && m.requestId === d.requestId));
  assert.ok(ui.requests.some((m) => m.type === 'releaseCaption'));
  ui.send({ ...d, type: 'preview', source: 'https://stale.test/d' });
  assert.equal(ui.window.document.querySelector('#detail-image'), null);
});

test('image-only preloading never reads captions; hiding clears prefetched text and showing reads fresh captions', async (t) => {
  const ui = await setup(t, { showCaption: false }, {}, preloadRecords);
  ui.click('.image-card:nth-child(2)'); loadedImage(ui, ui.last('loadPreview')); ui.flushFrames();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview').length, 3);
  assert.equal(ui.requests.filter((m) => m.type === 'loadCaption').length, 0);
  ui.click('#toggle-caption'); ui.flushFrames();
  assert.deepEqual(ui.requests.filter((m) => m.type === 'loadCaption').map((m) => m.id), ['b', 'c', 'a']);
  const old = ui.last('loadCaption'); caption(ui, old, 'old a');
  ui.click('#toggle-caption');
  const before = ui.requests.filter((m) => m.type === 'loadCaption').length;
  ui.click('#previous'); ui.flushFrames();
  assert.equal(ui.requests.filter((m) => m.type === 'loadCaption').length, before);
  caption(ui, old, 'stale a');
  ui.click('#toggle-caption');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'Loading caption…');
  assert.notEqual(ui.last('loadCaption').requestId, old.requestId);
  caption(ui, ui.last('loadCaption'), 'latest a');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'latest a');
});

test('cached captions revalidate quietly, protect drafts, and retain saved text on warm return', async (t) => {
  const ui = await setup(t);
  ui.click('.image-card'); caption(ui, ui.last('loadCaption'), 'a'); loadedImage(ui, ui.last('loadPreview')); ui.flushFrames();
  const b = ui.last('loadPreview'), oldCaption = ui.last('loadCaption');
  loadedImage(ui, b); caption(ui, oldCaption, 'cached b');
  ui.click('#next');
  const revalidation = ui.last('loadCaption'); assert.notEqual(revalidation.requestId, oldCaption.requestId);
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'cached b');
  caption(ui, revalidation, 'updated b');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'updated b');
  ui.click('#previous'); ui.click('#next');
  const late = ui.last('loadCaption'); ui.click('#edit-caption');
  const editor = ui.window.document.querySelector('#caption-editor'); editor.value = 'draft b'; editor.dispatchEvent(new ui.window.Event('input'));
  caption(ui, late, 'external b');
  assert.equal(editor.value, 'draft b');
  ui.click('#previous'); const confirm = ui.last('confirmUnsaved');
  assert.equal(ui.window.document.querySelector('#detail-path').textContent, 'b.jpg');
  ui.send({ type: 'unsavedDecision', requestId: confirm.requestId, decision: 'save' });
  assert.equal(ui.last('saveCaption').baseRevision, 'rev1');
  ui.send({ type: 'captionSaved', id: 'b', caption: 'draft b', renderedCaption: '<p>draft b</p>', exists: true, revision: 'saved' });
  ui.click('#next');
  assert.equal(ui.window.document.querySelector('#caption-preview').textContent, 'draft b');
});

test('prefetch errors stay in the background; skipped or failed neighbours retry on demand', async (t) => {
  const ui = await setup(t, {}, {}, preloadRecords);
  ui.click('.image-card:nth-child(2)'); loadedImage(ui, ui.last('loadPreview')); ui.flushFrames();
  const c = ui.requests.find((m) => m.type === 'loadPreview' && m.id === 'c');
  const a = ui.requests.find((m) => m.type === 'loadPreview' && m.id === 'a');
  ui.send({ ...c, type: 'previewError', message: 'bad neighbour' });
  ui.send({ ...a, type: 'previewSkipped' });
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
  ui.click('#previous');
  assert.equal(ui.last('loadPreview').id, 'a'); assert.equal(ui.last('loadPreview').prefetch, false);
  ui.click('#next'); ui.click('#next');
  assert.equal(ui.last('loadPreview').id, 'c'); assert.equal(ui.last('loadPreview').prefetch, false);
});

test('resolution changes and panel hiding release neighbours; scan completion preserves the initial decoded image', async (t) => {
  const ui = await setup(t, {}, {}, preloadRecords);
  ui.send({ type: 'loading', scanId: 1 }); ui.send({ type: 'initialImage', image: preloadRecords[1] });
  const initial = ui.last('loadPreview'); loadedImage(ui, initial);
  ui.send({ type: 'images', images: preloadRecords, scanId: 1, initialImageId: 'b' }); ui.flushFrames();
  assert.equal(ui.requests.filter((m) => m.type === 'loadPreview' && !m.prefetch).length, 1, 'finishing the directory scan must not reload the opened image');
  const old = ui.last('loadPreview');
  ui.send({ type: 'panelVisibility', visible: false });
  assert.ok(ui.requests.some((m) => m.type === 'releasePreview' && m.requestId === old.requestId));
  const count = ui.requests.length; ui.flushFrames(); assert.equal(ui.requests.length, count);
  ui.send({ type: 'panelVisibility', visible: true }); ui.flushFrames();
  ui.send({ type: 'previewConfigurationChanged', resolution: 1024 });
  const updated = ui.last('loadPreview'); assert.equal(updated.id, 'b'); assert.equal(updated.resolution, 1024);
  loadedImage(ui, updated); ui.flushFrames();
  assert.ok(ui.requests.filter((m) => m.type === 'loadPreview').slice(-2).every((m) => m.prefetch && m.resolution === 1024));
});

test('warm image validation reloads replaced files and ignores validation for released neighbours', async (t) => {
  const ui = await setup(t);
  ui.click('.image-card'); const a = ui.last('loadPreview'); loadedImage(ui, a); ui.flushFrames();
  const b = ui.last('loadPreview'); loadedImage(ui, b);
  ui.click('#next');
  assert.equal(ui.last('validatePreview').requestId, b.requestId);
  ui.send({ type: 'previewInvalidated', id: 'b', requestId: b.requestId });
  const updated = ui.last('loadPreview');
  assert.equal(updated.id, 'b'); assert.notEqual(updated.requestId, b.requestId); assert.equal(updated.prefetch, false);
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true, 'brief loads do not flash a loading overlay');
  loadedImage(ui, updated);
  assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'), true);
  ui.click('#back'); const count = ui.requests.length;
  ui.send({ type: 'previewInvalidated', id: 'a', requestId: a.requestId });
  assert.equal(ui.requests.length, count);
});

test('RAW dimensions remain visible outside Settings, distinguish the preview, and clear on rapid switches', async (t) => {
  const ui = await setup(t, {}, {}, ['a', 'b'].map((id) => ({ id, name: `${id}.CR2`, relativePath: `${id}.CR2` })));
  ui.click('.image-card');
  const request = ui.last('loadPreview');
  ui.send({ ...request, type: 'preview', source: 'https://preview.test/raw', originalWidth: 3456, originalHeight: 5184, width: 1672, height: 2508, previewSource: 'embedded-raw' });
  const badge = ui.window.document.querySelector('#detail-dimensions');
  assert.match(badge.textContent, /3456 × 5184/);
  assert.match(badge.textContent, /1672 × 2508/);
  assert.match(badge.title, /Camera embedded RAW preview/);
  assert.equal(badge.closest('dialog'), null);
  assert.equal(ui.window.document.querySelector('#settings-dialog').open, false);
  ui.click('#next');
  assert.equal(badge.textContent, '');
  ui.send({ ...request, type: 'preview', source: 'https://preview.test/stale', originalWidth: 99, originalHeight: 99, width: 99, height: 99 });
  assert.equal(badge.textContent, '', 'a stale RAW response must not relabel the next image');
});

test('decoder settings affect the host session without resetting previews or caption drafts; preparation timings are readable', async (t) => {
  const ui=await setup(t);ui.click('.image-card');const image=ui.last('loadPreview');caption(ui,ui.last('loadCaption'),'caption');
  loadedImage(ui,image,{timings:{cacheHit:false,queueMs:3000,readMs:40,processMs:3200,writeMs:30,totalMs:6270,engine:'process'}});
  ui.click('#edit-caption');const editor=ui.window.document.querySelector('#caption-editor');editor.value='keep draft';
  const previews=ui.requests.filter(x=>x.type==='loadPreview').length;
  ui.click('#detail-settings');assert.equal(ui.last('getPreviewPool').type,'getPreviewPool');
  const select=ui.window.document.querySelector('#preview-concurrency');select.value='4';select.dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.last('setPreviewConcurrency').concurrency,4);
  const mode=ui.window.document.querySelector('#preview-execution-mode');mode.value='thread';mode.dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.last('setPreviewExecutionMode').mode,'thread');
  ui.send({type:'previewPoolStatus',requested:4,workers:2,backend:'thread',mode:'thread'});
  assert.match(ui.window.document.querySelector('#preview-pool-status').textContent,/2 decoder threads/);
  assert.equal(editor.value,'keep draft');assert.equal(ui.requests.filter(x=>x.type==='loadPreview').length,previews);
  const performance=ui.window.document.querySelector('#preview-performance').textContent;
  assert.match(performance,/Queue 3.00 s/);assert.match(performance,/encode 3.20 s/);assert.match(performance,/total 6.27 s/);
  assert.equal(ui.state().gallerySettings.concurrency,undefined,'shared pool settings must not become conflicting per-gallery preferences');
});

test('visible video cards request only a first-frame poster and release it outside the viewport',async t=>{
 const ui=await setup(t,{showCaption:false},{},mixedMedia);ui.visible();
 const poster=ui.last('loadVideoPoster');assert.equal(poster.id,'clip');assert.equal(ui.requests.some(x=>x.type==='loadVideo'),false);assert.equal(ui.requests.some(x=>x.type==='loadCaption'),false);
 ui.send({...poster,type:'videoPoster',source:'https://poster.test/frame.jpg'});assert.equal(ui.window.document.querySelector('.video-poster').src,'https://poster.test/frame.jpg');
 ui.visible(false);assert.ok(ui.requests.some(x=>x.type==='releasePreview'&&x.requestId===poster.requestId));
 ui.send({...poster,type:'videoPoster',source:'https://stale.test/poster.jpg'});assert.equal(ui.window.document.querySelector('.video-poster').hasAttribute('src'),false);
});

test('detail Caption shortcut hides and restores video captions without changing playback', async t => {
 const ui=await videoSetup(t,true),doc=ui.window.document;caption(ui,ui.last('loadCaption'),'old caption');
 await ui.video.play();ui.video.currentTime=95;ui.video.volume=0.3;ui.video.playbackRate=1.5;
 const source=ui.video.src,calls=ui.mediaCalls.length,requests=ui.requests.filter(x=>x.type==='loadCaption').length;
 ui.click('#detail-toggle-caption');
 assert.equal(doc.querySelector('#detail-view').classList.contains('text-hidden'),true);
 assert.equal(doc.querySelector('#detail-toggle-caption').getAttribute('aria-label'),'Show Caption');
 assert.equal(doc.querySelector('#toggle-caption').getAttribute('aria-pressed'),'false');
 assert.equal(doc.querySelector('#caption-preview').textContent,'');
 assert.equal(ui.requests.filter(x=>x.type==='loadCaption').length,requests);
 ui.click('#detail-toggle-caption');const fresh=ui.last('loadCaption');caption(ui,fresh,'latest caption');
 assert.match(doc.querySelector('#caption-preview').textContent,/latest caption/);
 assert.equal(ui.video.src,source);assert.equal(ui.video.currentTime,95);assert.equal(ui.video.volume,0.3);assert.equal(ui.video.playbackRate,1.5);assert.equal(ui.video.paused,false);assert.equal(ui.mediaCalls.length,calls);
});

test('focus fills Gallery temporarily, suspends caption reads, restores layout and preserves playback', async t=>{
 const ui=await videoSetup(t,true),doc=ui.window.document;caption(ui,ui.last('loadCaption'),'caption');await ui.video.play();
 ui.video.currentTime=25;const calls=ui.mediaCalls.length,token=ui.last('loadVideo').requestId;
 ui.click('#video-focus-settings');assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),true);
 assert.equal(doc.querySelector('#video-focus-controls').classList.contains('hidden'),false);
 assert.equal(doc.querySelector('#detail-view').classList.contains('text-hidden'),true);
 assert.equal(ui.state().textPaneHidden,false,'temporary focus must not overwrite the Caption preference');
 const captionCount=ui.requests.filter(x=>x.type==='loadCaption').length;
 ui.click('#focus-settings');doc.querySelector('#video-playback-rate').value='2';doc.querySelector('#video-playback-rate').dispatchEvent(new ui.window.Event('change'));
 assert.equal(ui.state().textPaneHidden,false);
 ui.window.dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));assert.equal(doc.querySelector('#settings-dialog').open,false);assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),true);
 ui.window.dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true}));
 assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),false);assert.equal(doc.querySelector('#detail-view').classList.contains('text-hidden'),false);
 assert.equal(ui.requests.filter(x=>x.type==='loadCaption').length,captionCount+1);
 assert.equal(ui.last('loadVideo').requestId,token);assert.equal(ui.video.currentTime,25);assert.equal(ui.video.playbackRate,2);assert.equal(ui.video.paused,false);assert.equal(ui.mediaCalls.length,calls);
});

test('focus protects unsaved captions for Continue, Save and Discard',async t=>{
 for(const decision of ['continue','save','discard']){
  const ui=await videoSetup(t,true);caption(ui,ui.last('loadCaption'),'saved');ui.click('#edit-caption');
  const editor=ui.window.document.querySelector('#caption-editor');editor.value='draft';editor.dispatchEvent(new ui.window.Event('input'));
  ui.click('#video-focus-settings');const confirmation=ui.last('confirmUnsaved');assert.equal(confirmation.reason,'videoFocus');
  ui.send({type:'unsavedDecision',requestId:confirmation.requestId,decision});
  if(decision==='save'){assert.equal(ui.last('saveCaption').caption,'draft');ui.send({type:'captionSaved',id:'clip',caption:'draft',renderedCaption:'<p>draft</p>',exists:true,revision:'new'});}
  assert.equal(ui.window.document.querySelector('#detail-view').classList.contains('video-focused'),decision!=='continue');
  if(decision==='continue')assert.equal(editor.value,'draft');
 }
});

test('focus stays across videos, ends on images and never adds hidden-caption requests',async t=>{
 const media=[{id:'clip',name:'a.mp4',relativePath:'a.mp4',kind:'video'},{id:'next',name:'b.mp4',relativePath:'b.mp4',kind:'video'},records[0]];
 const ui=await setup(t,{showCaption:true},{},media),doc=ui.window.document;ui.click('.image-card');caption(ui,ui.last('loadCaption'),'a');ui.click('#video-focus-settings');
 const count=ui.requests.filter(x=>x.type==='loadCaption').length;
 ui.click('#next');assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),true);assert.equal(ui.requests.filter(x=>x.type==='loadCaption').length,count);
 ui.click('#next');assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),false);assert.equal(ui.last('loadCaption').id,'a');assert.equal(doc.querySelector('#video-focus').classList.contains('hidden'),false);
 const hidden=await videoSetup(t,false);hidden.click('#video-focus-settings');hidden.click('#exit-video-focus');assert.equal(hidden.window.document.querySelector('#detail-view').classList.contains('text-hidden'),true);assert.equal(hidden.requests.some(x=>x.type==='loadCaption'),false);
});

test('video F opens browser fullscreen while Caption shortcuts and typing remain independent',async t=>{
 const ui=await videoSetup(t),doc=ui.window.document;
 ui.video.dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}));assert.equal(ui.last('openVideoInBrowser').id,'clip');assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),false);
 const count=ui.requests.filter(x=>x.type==='openVideoInBrowser').length;
 ui.video.dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'c',bubbles:true,cancelable:true}));caption(ui,ui.last('loadCaption'),'caption');ui.click('#edit-caption');
 doc.querySelector('#caption-editor').dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}));assert.equal(ui.requests.filter(x=>x.type==='openVideoInBrowser').length,count);
});

test('speed settings and native speed changes survive seeking and source changes without resetting playback',async t=>{
 const ui=await videoSetup(t),doc=ui.window.document;await ui.video.play();ui.video.currentTime=7;const calls=ui.mediaCalls.length;
 doc.querySelector('#video-playback-rate').value='1.75';doc.querySelector('#video-playback-rate').dispatchEvent(new ui.window.Event('change'));
 assert.equal(ui.video.playbackRate,1.75);assert.equal(ui.video.defaultPlaybackRate,1.75);assert.equal(ui.video.currentTime,7);assert.equal(ui.video.paused,false);assert.equal(ui.mediaCalls.length,calls);
 ui.video.playbackRate=2.5;ui.video.dispatchEvent(new ui.window.Event('ratechange'));assert.equal(doc.querySelector('#video-playback-rate').value,'2.5');assert.equal(ui.state().videoPlaybackRate,2.5);
 ui.click('#next');ui.click('#previous');ui.send({...ui.last('loadVideo'),type:'video',source:'https://video.test/new.mp4'});ui.video.dispatchEvent(new ui.window.Event('loadedmetadata'));assert.equal(ui.video.playbackRate,2.5);
 const restored=await setup(t,{},ui.state(),mixedMedia);restored.click('.image-card:nth-child(2)');restored.send({...restored.last('loadVideo'),type:'video',source:'https://video.test/restored.mp4'});const video=restored.window.document.querySelector('#detail-video');video.dispatchEvent(new restored.window.Event('loadedmetadata'));assert.equal(video.playbackRate,2.5);
});

test('browser full screen transfers state, deduplicates opening and pauses only after success',async t=>{
 const ui=await videoSetup(t),doc=ui.window.document;await ui.video.play();ui.video.currentTime=17;ui.video.volume=.3;ui.video.muted=true;ui.video.playbackRate=1.75;ui.video.dispatchEvent(new ui.window.Event('ratechange'));
 ui.click('#video-focus');ui.click('#video-window-fullscreen');const request=ui.last('openVideoInBrowser');assert.equal(ui.requests.filter(x=>x.type==='openVideoInBrowser').length,1);assert.equal(doc.querySelector('#video-focus').disabled,true);assert.equal(ui.video.paused,false);
 assert.equal(request.playback.time,17);assert.equal(request.playback.rate,1.75);assert.equal(request.playback.volume,.3);assert.equal(request.playback.muted,true);
 ui.send({...request,type:'browserVideoOpened',requestId:'stale',opened:true});assert.equal(ui.video.paused,false);
 ui.send({...request,type:'browserVideoOpened',opened:false,error:'Cannot open browser'});assert.equal(ui.video.paused,false);assert.equal(doc.querySelector('#video-control-status').textContent,'Cannot open browser');assert.equal(doc.querySelector('#video-focus').disabled,false);
 ui.click('#video-window-fullscreen');const second=ui.last('openVideoInBrowser');ui.send({...second,type:'browserVideoOpened',opened:true});assert.equal(ui.video.paused,true);assert.equal(doc.querySelector('#detail-view').classList.contains('video-focused'),false);
});

test('eight visible posters use one lazy scheduler, embed images and continue through all cards',async t=>{
 const media=Array.from({length:8},(_,i)=>({id:`clip-${i}`,name:`clip-${i}.mp4`,relativePath:`clip-${i}.mp4`,kind:'video'})),ui=await setup(t,{showCaption:false},{},media),doc=ui.window.document;
 ui.visible();assert.equal(ui.requests.filter(m=>m.type==='loadVideoPoster').length,4);
 const source='data:image/jpeg;base64,/9j/2Q==';
 for(let i=0;i<8;i++){
  const pending=ui.requests.filter(m=>m.type==='loadVideoPoster')[i];assert.ok(pending);
  const image=doc.querySelector(`img[data-image-id="${pending.id}"]`);assert.equal(image.loading,'eager');assert.match(image.parentElement.querySelector('.video-poster-status').textContent,/first frame/);
  ui.send({...pending,type:'videoPoster',source,timing:{totalMs:30,queueMs:2,processMs:25,cacheMs:3,bytes:2048,cacheHit:i>3}});assert.equal(image.src,source);image.dispatchEvent(new ui.window.Event('load'));await tick();
  assert.equal(image.classList.contains('poster-ready'),true);assert.equal(image.parentElement.querySelector('.video-poster-status').textContent,'');assert.match(image.parentElement.title,/Host 30 ms/);
 }
 assert.equal(ui.requests.filter(m=>m.type==='loadVideoPoster').length,8);assert.equal(ui.requests.some(m=>m.type==='loadVideo'||m.type==='loadCaption'),false);
});

test('poster preparation and display failures are visible and release slots for remaining videos',async t=>{
 const media=Array.from({length:6},(_,i)=>({id:`clip-${i}`,name:`clip-${i}.mp4`,relativePath:`clip-${i}.mp4`,kind:'video'})),ui=await setup(t,{}, {},media),doc=ui.window.document;ui.visible();
 const first=ui.requests.filter(m=>m.type==='loadVideoPoster')[0];ui.send({...first,type:'videoPosterError',message:'FFmpeg unavailable'});await tick();
 const image=doc.querySelector(`img[data-image-id="${first.id}"]`);assert.equal(image.hasAttribute('src'),false);assert.match(image.parentElement.querySelector('.video-poster-status').textContent,/unavailable/);assert.equal(image.parentElement.title,'FFmpeg unavailable');assert.equal(ui.requests.filter(m=>m.type==='loadVideoPoster').length,5);
 const second=ui.requests.filter(m=>m.type==='loadVideoPoster')[1],target=doc.querySelector(`img[data-image-id="${second.id}"]`);ui.send({...second,type:'videoPoster',source:'data:image/jpeg;base64,broken'});target.dispatchEvent(new ui.window.Event('error'));await tick();assert.equal(ui.requests.filter(m=>m.type==='loadVideoPoster').length,6);assert.equal(target.hasAttribute('src'),false);
 ui.send({...first,type:'videoPoster',source:'https://stale.test/first.jpg'});assert.equal(image.hasAttribute('src'),false);
});

test('stalled poster deadlines cancel their host requests and cannot hold the grid queue indefinitely',async t=>{
 const media=Array.from({length:5},(_,i)=>({id:`clip-${i}`,name:`clip-${i}.mp4`,relativePath:`clip-${i}.mp4`,kind:'video'})),ui=await setup(t,{}, {},media),doc=ui.window.document;
 const set=ui.window.setTimeout.bind(ui.window),timeouts=[];ui.window.setTimeout=(callback,ms,...rest)=>{if(ms===30000)timeouts.push(callback);return set(callback,ms,...rest)};
 ui.visible();const first=ui.requests.find(m=>m.type==='loadVideoPoster');assert.equal(timeouts.length,4);timeouts[0]();await tick();
 assert.ok(ui.requests.some(m=>m.type==='releasePreview'&&m.requestId===first.requestId));assert.equal(ui.requests.filter(m=>m.type==='loadVideoPoster').length,5);assert.equal(doc.querySelector(`img[data-image-id="${first.id}"]`).parentElement.title,'First-frame preparation timed out.');
});

test('video quality has four choices, migrates old sessions, and keeps errors and fallback outside the picture',async t=>{
 const ui=await setup(t,{showCaption:false},{gallerySettings:{videoMaxHeight:720}},mixedMedia),doc=ui.window.document;
 ui.click('.image-card:nth-child(2)');const pending=ui.last('loadVideo');assert.equal(pending.videoMaxHeight,1440);
 assert.deepEqual([...doc.querySelector('#video-quality').options].map(x=>x.value),['0','1440','1080','720']);
 ui.send({...pending,type:'video',source:'https://video.test/clip.mp4',width:1280,height:720,previewWidth:1280,previewHeight:720,note:'diagnostic only'});
 assert.equal(doc.querySelector('#video-quality').value,'1440');assert.match(doc.querySelector('#video-quality-info').textContent,/Original · 1280 × 720/);
 assert.equal(doc.querySelector('#video-notice'),null);assert.equal(doc.querySelector('#video-playback-info').closest('dialog').id,'settings-dialog');
 ui.video=doc.querySelector('#detail-video');Object.defineProperty(ui.video,'error',{value:{code:3,message:'test decode error'}});ui.video.dispatchEvent(new ui.window.Event('error'));
 assert.equal(doc.querySelector('#image-status').classList.contains('hidden'),true);assert.match(doc.querySelector('#video-feedback-message').textContent,/test decode error/);
 assert.equal(doc.querySelector('#video-feedback').closest('#image-stage'),null);assert.equal(doc.querySelector('#video-fallback').closest('#image-stage'),null);
 Object.defineProperty(ui.video,'readyState',{value:4});ui.video.dispatchEvent(new ui.window.Event('canplay'));assert.match(doc.querySelector('#video-feedback-message').textContent,/test decode error/,'late canplay must not hide errors');
});

test('quality switches preserve position, volume, mute, speed, playback and drafts; rapid changes ignore stale responses',async t=>{
 const ui=await videoSetup(t,true),doc=ui.window.document;caption(ui,ui.last('loadCaption'),'caption');ui.click('#edit-caption');const editor=doc.querySelector('#caption-editor');editor.value='keep draft';editor.dispatchEvent(new ui.window.Event('input'));
 await ui.video.play();ui.video.currentTime=97;ui.video.volume=0.25;ui.video.muted=true;ui.video.playbackRate=1.75;ui.video.dispatchEvent(new ui.window.Event('ratechange'));
 const choose=value=>{doc.querySelector('#video-quality').value=value;doc.querySelector('#video-quality').dispatchEvent(new ui.window.Event('change'));};
 choose('1080');const stale=ui.last('loadVideo');choose('720');const current=ui.last('loadVideo');assert.equal(current.videoMaxHeight,720);assert.equal(current.videoCompatibility,'auto');
 ui.send({...stale,type:'video',source:'https://stale.test/1080'});assert.equal(ui.video.hasAttribute('src'),false);
 ui.video.currentTime=0;ui.send({...current,type:'video',source:'https://video.test/720',width:3840,height:2160,previewWidth:1280,previewHeight:720});ui.video.dispatchEvent(new ui.window.Event('loadedmetadata'));
 assert.equal(ui.video.currentTime,97);assert.equal(ui.video.volume,0.25);assert.equal(ui.video.muted,true);assert.equal(ui.video.playbackRate,1.75);assert.equal(ui.video.paused,true);
 Object.defineProperty(ui.video,'readyState',{value:4});ui.video.dispatchEvent(new ui.window.Event('canplay'));assert.equal(ui.video.paused,false);assert.equal(editor.value,'keep draft');
 assert.equal(doc.querySelector('#video-max-height').value,'720');assert.equal(ui.state().gallerySettings.videoQualityVersion,1);
 ui.video.pause();choose('0');const paused=ui.last('loadVideo');ui.send({...paused,type:'video',source:'https://video.test/original'});ui.video.dispatchEvent(new ui.window.Event('loadedmetadata'));ui.video.dispatchEvent(new ui.window.Event('canplay'));assert.equal(ui.video.paused,true);
 await ui.video.play();choose('1440');const hidden=ui.last('loadVideo');ui.send({type:'panelVisibility',visible:false});ui.send({...hidden,type:'video',source:'https://video.test/hidden'});ui.video.dispatchEvent(new ui.window.Event('loadedmetadata'));ui.video.dispatchEvent(new ui.window.Event('canplay'));assert.equal(ui.video.paused,true,'hidden panels must not resume playback');
});

test('quality for compatibility streams starts at the saved time and does not read hidden captions',async t=>{
 const ui=await videoSetup(t,false),doc=ui.window.document;ui.video.currentTime=49;let descriptor;
 ui.window.GalleryVideoStream=class{constructor(video,info){descriptor=info;}start(){}dispose(){}suspend(){}};
 doc.querySelector('#video-max-height').value='1080';doc.querySelector('#video-max-height').dispatchEvent(new ui.window.Event('change'));
 ui.send({...ui.last('loadVideo'),type:'video',converted:true,stream:{base:'https://video.test/segment/',duration:120,segmentSeconds:4,mime:'video/webm; codecs="vp8,vorbis"'}});
 assert.equal(descriptor.startTime,49);assert.equal(ui.requests.some(x=>x.type==='loadCaption'),false);
});

test('image thumbnails use one eager scheduler, adapt to decoder capacity and expose end-to-end timings',async t=>{
 const media=Array.from({length:14},(_,i)=>({id:`photo-${i}`,name:`photo-${i}.jpg`,relativePath:`photos/photo-${i}.jpg`})),ui=await setup(t,{showCaption:false},{},media),doc=ui.window.document;
 ui.send({type:'previewPoolStatus',requested:0,workers:4,backend:'process',mode:'process'});ui.visible();assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,8);
 for(let i=0;i<14;i++){
  const request=ui.requests.filter(m=>m.type==='loadPreview')[i];assert.ok(request);const image=doc.querySelector(`img[data-image-id="${request.id}"]`);assert.equal(image.loading,'eager');assert.equal(image.decoding,'async');assert.equal(image.classList.contains('thumbnail-ready'),false);
  ui.send({...request,type:'preview',source:'data:image/webp;base64,UklGRg==',inlineBytes:4096,timings:{cacheHit:i>7,totalMs:120,queueMs:20,processMs:90}});image.dispatchEvent(new ui.window.Event('load'));await tick();assert.equal(image.classList.contains('thumbnail-ready'),true);assert.equal(image.hasAttribute('aria-busy'),false);assert.match(image.parentElement.title,/^photos\/photo-/);assert.match(image.parentElement.title,/4.0 KiB/);assert.match(image.parentElement.title,/Message round trip and display/);
 }
 assert.equal(ui.requests.some(m=>m.type==='loadCaption'),false);
});

test('thumbnail generation/display failures and deadlines release slots and ignore late replies',async t=>{
 const media=Array.from({length:8},(_,i)=>({id:`photo-${i}`,name:`photo-${i}.jpg`,relativePath:`photo-${i}.jpg`})),ui=await setup(t,{}, {},media),doc=ui.window.document,set=ui.window.setTimeout.bind(ui.window),deadlines=[];
 ui.window.setTimeout=(callback,ms,...args)=>{if(ms===30000||ms===15000)deadlines.push({callback,ms});return set(callback,ms,...args)};
 ui.visible();const first=ui.requests.find(m=>m.type==='loadPreview');assert.equal(deadlines.filter(x=>x.ms===30000).length,4);deadlines[0].callback();await tick();assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,5);assert.ok(ui.requests.some(m=>m.type==='releasePreview'&&m.requestId===first.requestId));
 const target=doc.querySelector(`img[data-image-id="${first.id}"]`);assert.equal(target.hasAttribute('src'),false);assert.match(target.parentElement.title,/timed out/);assert.match(target.parentElement.querySelector('.preview-error').textContent,/unavailable/);
 ui.send({...first,type:'preview',source:'https://stale.test/late'});assert.equal(target.hasAttribute('src'),false);
 const second=ui.requests.filter(m=>m.type==='loadPreview')[1];ui.send({...second,type:'preview',source:'data:image/webp;base64,broken'});const image=doc.querySelector(`img[data-image-id="${second.id}"]`);image.dispatchEvent(new ui.window.Event('error'));await tick();assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,6);assert.equal(image.hasAttribute('src'),false);
 const third=ui.requests.filter(m=>m.type==='loadPreview')[2];ui.send({...third,type:'preview',source:'https://slow.test/image'});deadlines.filter(x=>x.ms===15000).at(-1).callback();await tick();assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,7);
});

test('the actual viewport is scheduled before offscreen thumbnail prefetch rows',async t=>{
 const media=Array.from({length:10},(_,i)=>({id:`frame-${i}`,name:`frame-${i}.jpg`,relativePath:`frame-${i}.jpg`})),ui=await setup(t,{}, {},media),doc=ui.window.document;
 const images=[...doc.querySelectorAll('.image-card img')];for(const [i,image] of images.entries()){image.getBoundingClientRect=()=>({top:i<4?-200:100,bottom:i<4?-50:200});}
 ui.visible();assert.deepEqual(ui.requests.filter(m=>m.type==='loadPreview').map(m=>m.id),['frame-4','frame-5','frame-6','frame-7']);
});


test('host queue acknowledgement starts neighbours before any current preview response',async t=>{
 const ui=await setup(t,{showCaption:false},{},preloadRecords);ui.click('.image-card:nth-child(3)');const current=ui.last('loadPreview');
 ui.send({...current,type:'previewProgress',requestId:'old',stage:'queued'});ui.flushFrames();assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,1);
 ui.send({...current,type:'previewProgress',stage:'queued'});ui.flushFrames();assert.deepEqual(ui.requests.filter(m=>m.type==='loadPreview'&&m.prefetch).map(m=>m.id),['d','b']);assert.equal(ui.requests.some(m=>m.type==='loadCaption'),false);
});

test('decoded history stays reusable beyond adjacent images and is capped at seven entries',async t=>{
 const media=Array.from({length:12},(_,i)=>({id:String(i),name:`${i}.jpg`,relativePath:`${i}.jpg`}));const ui=await setup(t,{showCaption:false},{},media);ui.click('.image-card');
 for(let i=0;i<10;i++){
  const current=ui.last('loadPreview');if(current.id===String(i))loadedImage(ui,current);ui.flushFrames();
  for(const request of ui.requests.filter(m=>m.type==='loadPreview'&&m.prefetch)){const image=ui.imageFor(request.requestId);if(image&&!image.naturalWidth)loadedImage(ui,request);}
  if(i<9)ui.click('#next');
 }
 const released=new Set(ui.requests.filter(m=>m.type==='releasePreview').map(m=>m.requestId));assert.ok(ui.requests.filter(m=>m.type==='loadPreview'&&!released.has(m.requestId)).length<=7);
 const before=ui.requests.filter(m=>m.type==='loadPreview').length;ui.click('#previous');ui.click('#previous');ui.click('#next');assert.equal(ui.requests.filter(m=>m.type==='loadPreview').length,before,'recent history must not request another resource');assert.equal(ui.window.document.querySelector('#image-status').classList.contains('hidden'),true);
});

test('slow switches retain a labelled frame and only show loading after 150 ms',async t=>{
 const ui=await setup(t,{showCaption:false},{},preloadRecords);ui.click('.image-card');const first=loadedImage(ui,ui.last('loadPreview'));ui.flushFrames();
 const timers=[],set=ui.window.setTimeout.bind(ui.window);ui.window.setTimeout=(callback,ms,...args)=>{if(ms===150)timers.push(callback);return set(callback,ms,...args)};
 ui.click('#next');const doc=ui.window.document;assert.equal(first.isConnected,true);assert.ok(first.classList.contains('switch-placeholder'));assert.match(doc.querySelector('.switch-label').textContent,/b.jpg/);assert.equal(doc.querySelector('#image-status').classList.contains('hidden'),true);
 timers.at(-1)();assert.equal(doc.querySelector('#image-status').classList.contains('hidden'),false);const next=ui.requests.find(m=>m.type==='loadPreview'&&m.id==='b');loadedImage(ui,next);ui.flushFrames();assert.equal(first.isConnected,false);assert.equal(doc.querySelector('#image-status').classList.contains('hidden'),true);assert.ok(Number(doc.querySelector('#image-stage').dataset.switchMs)>=0);
});

test('adopting a neighbour prepares the next neighbour immediately and rapid switches retain the last visible frame',async t=>{
 const ui=await setup(t,{showCaption:false},{},preloadRecords);ui.click('.image-card');const a=loadedImage(ui,ui.last('loadPreview'));ui.flushFrames();
 ui.click('#next');ui.flushFrames();assert.ok(ui.requests.some(m=>m.type==='loadPreview'&&m.id==='c'&&m.prefetch),'prepare C while B is still decoding');ui.click('#next');ui.flushFrames();assert.equal(a.isConnected,true);assert.ok(a.classList.contains('switch-placeholder'));assert.match(ui.window.document.querySelector('.switch-label').textContent,/c.jpg/);
 const c=ui.requests.find(m=>m.type==='loadPreview'&&m.id==='c');loadedImage(ui,c);ui.flushFrames();assert.equal(a.isConnected,false);assert.equal(ui.window.document.querySelector('#detail-image').alt,'c.jpg');
});

test('compatible playback rebuilds once at the saved position and reports persistent concrete errors',async t=>{
 const ui=await videoSetup(t),doc=ui.window.document,streams=[];
 ui.window.GalleryVideoStream=class {constructor(video,descriptor,onError){this.onError=onError;this.descriptor=descriptor;this.video=video;streams.push(this)}start(){this.video.src='blob:compatible'}dispose(){}suspend(){}};
 const sendVideo=()=>ui.send({...ui.last('loadVideo'),type:'video',converted:true,source:'https://video.test/source',stream:{mime:'video/webm; codecs="vp8,vorbis"',duration:120,segmentSeconds:4,base:'https://video.test/segment/'}});
 sendVideo();await ui.video.play();ui.video.currentTime=17;ui.video.volume=.3;
 const before=ui.requests.filter(m=>m.type==='loadVideo').length;streams[0].onError('Fragment 4: concrete decoder error');await new Promise(setImmediate);assert.equal(ui.requests.filter(m=>m.type==='loadVideo').length,before+1);sendVideo();assert.equal(streams[1].descriptor.startTime,17);
 streams[1].onError('Fragment 4: repeated decode error');await new Promise(setImmediate);assert.equal(ui.requests.filter(m=>m.type==='loadVideo').length,before+1);assert.match(doc.querySelector('#video-feedback-message').textContent,/Fragment 4: repeated/);assert.equal(doc.querySelector('#video-fallback').classList.contains('hidden'),false);assert.ok(ui.requests.some(m=>m.type==='videoDiagnostic'&&m.diagnostics.message.includes('concrete decoder')));
});


test('image Full screen button and F open browser without touching caption drafts; filtered gallery entry works', async t => {
  const ui = await setup(t, { showCaption: true }); const doc = ui.window.document;
  ui.click('.image-card'); caption(ui, ui.last('loadCaption'), 'saved'); ui.click('#edit-caption');
  const editor = doc.querySelector('#caption-editor'); editor.value = 'draft'; editor.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  const count = ui.requests.filter(m => m.type === 'loadCaption').length;
  assert.equal(doc.querySelector('#video-focus').classList.contains('hidden'), false);
  ui.click('#video-focus'); const first = ui.last('openImagesInBrowser');
  assert.equal(first.id, 'a'); assert.equal(first.resolution, 32);
  assert.equal(editor.value, 'draft'); assert.equal(ui.last('confirmUnsaved'), undefined);
  ui.send({ ...first, type: 'browserImagesOpened', requestId: 'stale', opened: true });
  assert.equal(doc.querySelector('#video-focus').disabled, true);
  ui.send({ ...first, type: 'browserImagesOpened', opened: false, error: 'Browser unavailable' });
  assert.equal(doc.querySelector('#browser-status').textContent, 'Browser unavailable');
  assert.equal(doc.querySelector('#video-focus').disabled, false);
  ui.click('#video-focus'); const second = ui.last('openImagesInBrowser');
  ui.send({ ...second, type: 'browserImagesOpened', opened: true });
  assert.equal(editor.value, 'draft'); assert.equal(ui.requests.filter(m => m.type === 'loadCaption').length, count);
  const pure = await setup(t, { showCaption: false }); pure.click('.image-card');
  pure.window.document.querySelector('#detail-view').focus(); pure.window.dispatchEvent(new pure.window.KeyboardEvent('keydown', { key: 'f', cancelable: true }));
  assert.equal(pure.last('openImagesInBrowser').id, 'a'); assert.equal(pure.requests.some(m => m.type === 'loadCaption'), false);
  const grid = await setup(t, { showCaption: false }); const search = grid.window.document.querySelector('#search');
  search.value = 'b'; search.dispatchEvent(new grid.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 200)); grid.click('#image-browser-fullscreen');
  assert.equal(grid.last('openImagesInBrowser').id, 'b'); assert.equal(grid.last('openImagesInBrowser').search, 'b');
});

test('right-click offers original file path for virtual cards, image/video details and preserves ordinary caption menus', async t => {
  const ui = await setup(t, { showCaption: false }, {}, [...records, { id: 'clip', kind: 'video', name: 'clip.mp4', relativePath: 'clip.mp4' }]), doc = ui.window.document;
  const context = selector => { const event = new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 60 }); doc.querySelector(selector).dispatchEvent(event); return event; };
  const before = ui.requests.length;
  assert.equal(context('[data-media-id="b"]').defaultPrevented, true); assert.equal(doc.querySelector('[role=menuitem]').textContent, 'Copy File Path');
  assert.equal(doc.querySelector('#detail-view').classList.contains('hidden'), true); assert.equal(ui.requests.length, before);
  ui.click('[role=menuitem]'); const copy = ui.last('copyFilePath'); assert.equal(copy.id, 'b');
  ui.send({ type: 'filePathCopied', requestId: copy.requestId, id: 'a', copied: true }); await comparisonTick(); assert.ok(doc.querySelector('[role=menu]'), 'wrong response ID does not settle copy');
  ui.send({ type: 'filePathCopied', requestId: copy.requestId, id: 'b', copied: true }); await comparisonTick(); assert.equal(doc.querySelector('[role=menu]'), null);
  ui.click('[data-media-id="a"]'); context('#image-stage'); ui.click('[role=menuitem]'); assert.equal(ui.last('copyFilePath').id, 'a');
  let request = ui.last('copyFilePath');
  ui.send({ ...request, type: 'filePathCopied', copied: false, error: 'clipboard blocked' }); await comparisonTick(); assert.match(doc.querySelector('[role=alert]').textContent, /Could not copy/);
  doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert.equal(doc.querySelector('#detail-view').classList.contains('hidden'), false);
  ui.click('#back'); ui.click('[data-media-id="clip"]'); const calls = ui.mediaCalls.length;
  context('#detail-video'); ui.click('[role=menuitem]'); assert.equal(ui.last('copyFilePath').id, 'clip'); assert.equal(ui.mediaCalls.length, calls);
  request = ui.last('copyFilePath'); ui.send({ ...request, type: 'filePathCopied', copied: true }); await comparisonTick();
  assert.equal(context('#caption-preview').defaultPrevented, false); assert.equal(doc.querySelector('[role=menu]'), null);
});

test('comparison menu copies the visible A/B source and consumes Escape without leaving comparison', async t => {
  const ui = await setup(t), doc = ui.window.document; selectComparison(ui, 'a'); selectComparison(ui, 'b'); await readyComparison(ui);
  const context = side => doc.querySelector(`[data-side="${side}"] .compare-stage`).dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  context(0); ui.click('[role=menuitem]'); assert.equal(ui.last('copyFilePath').id, 'a'); let request = ui.last('copyFilePath'); ui.send({ ...request, type: 'filePathCopied', copied: true }); await comparisonTick();
  ui.click('.compare-toggle'); context(0); ui.click('[role=menuitem]'); assert.equal(ui.last('copyFilePath').id, 'b'); request = ui.last('copyFilePath'); ui.send({ ...request, type: 'filePathCopied', copied: true }); await comparisonTick();
  context(1); doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert.equal(doc.querySelector('[role=menu]'), null); assert.ok(doc.querySelector('.compare-view'));
});

test('macOS control context gesture retains comparison selection rather than opening the file menu', async t => {
  const ui = await setup(t), doc = ui.window.document, card = doc.querySelector('[data-media-id="a"]');
  card.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.equal(doc.querySelector('[role=menu]'), null); assert.equal(doc.querySelector('.comparison-marker').textContent, 'A');
});

test('keyboard context menu works from focused detail and comparison roots',async t=>{
 const ui=await setup(t),doc=ui.window.document;
 const key=target=>target.dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
 ui.click('[data-media-id="a"]');key(doc.querySelector('#detail-view'));assert.ok(doc.querySelector('[role=menu]'));ui.click('[role=menuitem]');let request=ui.last('copyFilePath');assert.equal(request.id,'a');ui.send({...request,type:'filePathCopied',copied:true});await comparisonTick();
 ui.click('#back');selectComparison(ui,'a');selectComparison(ui,'b');await readyComparison(ui);key(doc.querySelector('.compare-view'));ui.click('[role=menuitem]');request=ui.last('copyFilePath');assert.equal(request.id,'a');ui.send({...request,type:'filePathCopied',copied:true});await comparisonTick();
});

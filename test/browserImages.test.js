const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { BrowserImages } = require('../dist/browserImages'), { PreviewService } = require('../dist/previewService');
const { VideoService } = require('../dist/videoService'), { initializeProcessor } = require('../dist/previewProcessor');
const { createHost } = require('./helpers/host');
const { normalizeComparisonState } = require('../dist/browserImages');

test('comparison state clamps untrusted inputs and preserves independent views', () => {
  assert.deepEqual(normalizeComparisonState(null), { linked: true, showingReference: false, views: [{ zoom: 1, x: .5, y: .5 }, { zoom: 1, x: .5, y: .5 }], originals: [false, false] });
  assert.deepEqual(normalizeComparisonState({ linked: false, showingReference: true, views: [{ zoom: 999, x: -5, y: Infinity }, null], originals: [true, 'true'] }), { linked: false, showingReference: true, views: [{ zoom: 8, x: 0, y: .5 }, { zoom: 1, x: .5, y: .5 }], originals: [true, false] });
});

test('comparison sessions pin two known images, serve shared assets, reuse previews and allow per-side originals', async t => {
  const s = await setup(t), state = { linked: false, showingReference: true, views: [{ zoom: 2, x: .4, y: .6 }, { zoom: 3, x: .5, y: .7 }], originals: [false, false] };
  assert.throws(() => s.browser.createComparison([s.records[0], s.records[0]], 32, 'en', state), /different/);
  const token = s.browser.createComparison(s.records.slice(0, 2), 32, 'en', state), url = name => `${s.base}/images/${token}/${name}`;
  const page = await (await fetch(url('viewer?forward=a&b=c'))).text(); assert.match(page, /compare.js\?forward=a&amp;b=c/); assert.match(page, /comparison.js/);
  for (const asset of ['compare.js', 'compare.css', 'comparison.js', 'file-menu.js', 'file-menu.css']) assert.equal((await fetch(url(asset))).status, 200);
  let data = await (await fetch(url('state'))).json(); assert.deepEqual(data.comparison, state); assert.deepEqual(data.images.map(i => i.id), s.records.slice(0, 2).map(i => i.id)); assert.equal(s.reads(), 0);
  const scaled = await fetch(url('image/0')); assert.equal(scaled.headers.get('X-Image-Original-Width'), '160'); assert.equal(scaled.headers.get('X-Image-Original-Height'), '90');
  const bytes = Buffer.from(await scaled.arrayBuffer()); assert.deepEqual(Buffer.from(await (await fetch(url('image/0'))).arrayBuffer()), bytes); assert.equal(s.reads(), 1);
  assert.deepEqual(Buffer.from(await (await fetch(url('image/0?original=1'))).arrayBuffer()), await fs.readFile(s.records[0].id)); assert.equal(s.reads(), 1);
  const version = data.images[0].version; await fs.writeFile(s.records[0].id, s.image(s.magick.MagickColors.Blue)); data = await (await fetch(url('state'))).json(); assert.notEqual(data.images[0].version, version);
  s.browser.release(token); assert.equal((await fetch(url('viewer'))).status, 404);
});

test('host comparison handoff validates two distinct still-image IDs, forwards state and outlives Gallery', async t => {
  const host = await createHost(t, { maxPreviewResolution: 0, showCaption: true });
  await Promise.all(['a.png', 'b.png', 'clip.mp4'].map(name => fs.writeFile(path.join(host.dataset, name), name))); await host.panel.receive({ type: 'ready' });
  const records = host.sent.find(m => m.type === 'images').images, ids = records.filter(r => r.kind !== 'video').map(r => r.id);
  for (const pair of [[ids[0], ids[0]], [ids[0], 'file:///outside.jpg'], [ids[0], records.find(r => r.kind === 'video').id], [ids[0]], null]) {
    await host.panel.receive({ type: 'openComparisonInBrowser', ids: pair, requestId: 'invalid' }); assert.equal(host.sent.at(-1).opened, false);
  }
  assert.equal(host.openedUrls.length, 0);
  const comparison = normalizeComparisonState({ linked: false, showingReference: true, views: [{ zoom: 2, x: .3, y: .7 }] });
  await host.panel.receive({ type: 'openComparisonInBrowser', ids: ids.slice().reverse(), requestId: 'compare', resolution: 0, comparison });
  assert.equal(host.sent.at(-1).type, 'browserComparisonOpened'); assert.equal(host.sent.at(-1).opened, true);
  const url = host.openedUrls[0]; host.panel.close(); const data = await (await fetch(url.replace(/viewer$/, 'state'))).json();
  assert.deepEqual(data.images.map(i => i.id), ids.slice().reverse()); assert.deepEqual(data.comparison, comparison); assert.equal(host.reads.length, 0); assert.equal(host.sent.some(m => m.type === 'caption'), false);
  assert.match(data.gallery.token, /^[a-f0-9]{64}$/); const galleryUrl = new URL(url); galleryUrl.pathname = `/gallery/${data.gallery.token}/list`;
  const list = await (await fetch(galleryUrl)).json(); assert.equal(list.total, 3); assert.equal(list.items[data.gallery.index].id, ids[1]); assert.equal(host.reads.length, 0);
});

test('comparison handoff retains SSH proxy query and revokes sessions when browser opening fails', async t => {
  const host = await createHost(t, { externalVideoBase: 'http://127.0.0.1:12345/private-forward?auth=a%26b', failBrowserOpen: true }, true);
  await Promise.all(['a.png', 'b.png'].map(name => fs.writeFile(path.join(host.dataset, name), 'fake'))); await host.panel.receive({ type: 'ready' });
  const ids = host.sent.find(m => m.type === 'images').images.map(i => i.id);
  await host.panel.receive({ type: 'openComparisonInBrowser', ids, requestId: 'compare', comparison: {} });
  const url = new URL(host.openedUrls[0]); assert.match(url.pathname, /^\/private-forward\/images\/[a-f0-9]{64}\/viewer$/); assert.equal(url.searchParams.get('auth'), 'a&b'); assert.equal(host.sent.at(-1).opened, false);
});

async function setup(t, resolution = 32) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-images-test-'));
  const magick = await initializeProcessor();
  const image = (color, width = 160, height = 90) => magick.ImageMagick.read(color, width, height, frame => frame.write(magick.MagickFormat.Png, bytes => Buffer.from(bytes)));
  const filenames = ['landscape.png', 'portrait.png', 'broken.jpg'];
  await Promise.all([fs.writeFile(path.join(directory, filenames[0]), image(magick.MagickColors.Red)), fs.writeFile(path.join(directory, filenames[1]), image(magick.MagickColors.Transparent, 90, 160)), fs.writeFile(path.join(directory, filenames[2]), 'broken')]);
  const records = filenames.map(name => ({ id: path.join(directory, name), name, relativePath: name }));
  const source = async id => { const stat = await fs.stat(id); return { filePath: id, mtime: stat.mtimeMs, size: stat.size }; };
  let reads = 0;
  const previews = new PreviewService(path.join(directory, 'previews'), async id => ({ ...await source(id), read: async () => { reads++; return fs.readFile(id); } }));
  const browser = new BrowserImages(previews, source), videos = new VideoService(path.join(directory, 'videos'), source);
  videos.attachImageBrowser(browser); const base = await videos.startServer();
  const token = browser.create(records, records[0].id, resolution, 'zh-CN');
  t.after(async () => { browser.dispose(); previews.dispose(); videos.dispose(); await Promise.allSettled([previews.initialized, previews.eviction, videos.initialized, videos.pruning]); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  return { browser, previews, base, token, records, directory, magick, image, reads: () => reads, url: name => `${base}/images/${token}/${name}` };
}

test('private image viewer is metadata-only until requested, reuses previews and invalidates updated files', async t => {
  const s = await setup(t);
  const page = await fetch(s.url('viewer?forward=a&b=c'));
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /viewer.js\?forward=a&amp;b=c/);
  for (const asset of ['viewer.js', 'viewer.css', 'file-menu.js', 'file-menu.css']) { assert.equal((await fetch(s.url(asset))).status, 200); }
  let data = await (await fetch(s.url('state'))).json();
  assert.equal(data.index, 0); assert.equal(data.total, 3); assert.equal(data.language, 'zh');
  assert.equal(data.images.length, 2); assert.equal(s.reads(), 0, 'opening a viewer must not read image contents or captions');
  assert.equal(data.images[0].filePath, s.records[0].id, 'metadata carries the validated extension-host path');
  const before = data.images[0].version;
  const response = await fetch(s.url('image/0')); assert.equal(response.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await response.arrayBuffer());
  s.magick.ImageMagick.read(bytes, decoded => { assert.ok(decoded.width * decoded.height <= 32 ** 2); assert.ok(decoded.width > decoded.height); });
  assert.deepEqual(Buffer.from(await (await fetch(s.url('image/0'))).arrayBuffer()), bytes); assert.equal(s.reads(), 1);
  const portrait = await fetch(s.url('image/1?prefetch=1'));
  s.magick.ImageMagick.read(Buffer.from(await portrait.arrayBuffer()), decoded => { assert.equal(decoded.isOpaque, false); assert.ok(decoded.height > decoded.width); });
  await fs.writeFile(s.records[0].id, s.image(s.magick.MagickColors.Blue, 200, 90));
  data = await (await fetch(s.url('state?index=0&sequence=5'))).json(); assert.notEqual(data.images[0].version, before);
  assert.notDeepEqual(Buffer.from(await (await fetch(s.url('image/0'))).arrayBuffer()), bytes);
  assert.equal((await fetch(s.url('image/2'))).status, 500, 'corrupt files fail explicitly');
  assert.equal((await fetch(s.url('image/99'))).status, 400);
  assert.equal((await fetch(s.url('state?index=NaN'))).status, 400);
  assert.equal((await fetch(s.url('image/0'), { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${s.base}/images/${'0'.repeat(64)}/viewer`)).status, 404);
  await fetch(s.url('state?index=1&sequence=10')); await fetch(s.url('state?index=0&sequence=9'));
  assert.equal((await (await fetch(s.url('state'))).json()).index, 1, 'late state requests cannot move the cursor backwards');
  await fetch(s.url('state?view=reloaded'));
  await fetch(s.url('state?index=0&sequence=1&view=reloaded'));
  assert.equal((await fetch(s.url('state?index=1&sequence=99'))).status, 409, 'old page requests cannot move a new page cursor');
  assert.equal((await (await fetch(s.url('state?view=reloaded'))).json()).index, 0, 'reloaded page sequences restart and keep navigation working');
  s.browser.sessions.get(s.token).lastActivity = Date.now() - 31 * 60_000; s.browser.expire();
  assert.equal((await fetch(s.url('viewer'))).status, 404); assert.equal(s.previews.owners.size, 0);
});

test('unlimited originals keep their bytes; oversized speculative downloads are skipped', async t => {
  const s = await setup(t, 0);
  const original = await fs.readFile(s.records[0].id);
  assert.deepEqual(Buffer.from(await (await fetch(s.url('image/0?prefetch=1'))).arrayBuffer()), original);
  assert.equal(s.reads(), 1);
  const response = await fetch(s.url('image/0')); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original); assert.equal(s.reads(), 1);
  s.previews.get = async () => ({ width: 9000, height: 9000, originalWidth: 9000, originalHeight: 9000, frameCount: 1 });
  assert.equal((await fetch(s.url('image/1?prefetch=1'))).status, 204);
});

test('fullscreen handoff preserves search order, forwards privately, skips videos and survives Gallery closing', async t => {
  const host = await createHost(t, { maxPreviewResolution: 0, showCaption: false });
  await Promise.all(['a.png', 'b.png', 'clip.mp4'].map(name => fs.writeFile(path.join(host.dataset, name), name)));
  await host.panel.receive({ type: 'ready' });
  const images = host.sent.find(m => m.type === 'images').images;
  const b = images.find(image => image.name === 'b.png');
  await host.panel.receive({ type: 'openImagesInBrowser', id: b.id, requestId: 'browser-1', search: '.png', resolution: 0 });
  const result = host.sent.at(-1); assert.equal(result.type, 'browserImagesOpened'); assert.equal(result.opened, true);
  const url = host.openedUrls.at(-1); assert.match(url, /^http:\/\/127.0.0.1:\d+\/images\/[a-f0-9]{64}\/viewer$/);
  host.panel.close();
  const data = await (await fetch(url.replace(/viewer$/, 'state'))).json();
  assert.equal(data.index, 1); assert.equal(data.total, 2); assert.deepEqual(data.images.map(image => image.name), ['a.png', 'b.png']);
  assert.match(data.gallery.token, /^[a-f0-9]{64}$/); assert.equal(data.gallery.index, 1);
  const browserGallery = new URL(url); browserGallery.pathname = `/gallery/${data.gallery.token}/list`;
  const listing = await (await fetch(browserGallery)).json(); assert.deepEqual(listing.items.map(item => item.name), ['a.png', 'b.png']); assert.equal(listing.selected, 1);
  assert.equal(host.reads.length, 0); assert.equal(host.sent.some(m => m.type === 'caption'), false);
  assert.equal(await (await fetch(url.replace(/viewer$/, 'image/1'))).text(), 'b.png');
});

test('fullscreen URLs retain SSH forwarding prefix/query and reject unknown image identifiers', async t => {
  const host = await createHost(t, { externalVideoBase: 'http://127.0.0.1:12345/private-forward?auth=a%26b' }, true);
  await fs.writeFile(path.join(host.dataset, 'a.jpg'), 'fake'); await host.panel.receive({ type: 'ready' });
  const image = host.sent.find(m => m.type === 'images').images[0];
  await host.panel.receive({ type: 'openImagesInBrowser', id: 'file:///outside.jpg', requestId: 'bad' });
  assert.equal(host.openedUrls.length, 0);
  await host.panel.receive({ type: 'openImagesInBrowser', id: image.id, requestId: 'ok', resolution: 1024 });
  const url = new URL(host.openedUrls[0]); assert.match(url.pathname, /^\/private-forward\/images\/[a-f0-9]{64}\/viewer$/); assert.equal(url.searchParams.get('auth'), 'a&b');
});

test('failed browser opening revokes image session and leaves Gallery available', async t => {
  const host = await createHost(t, { failBrowserOpen: true });
  await fs.writeFile(path.join(host.dataset, 'a.jpg'), 'fake'); await host.panel.receive({ type: 'ready' });
  const image = host.sent.find(m => m.type === 'images').images[0];
  await host.panel.receive({ type: 'openImagesInBrowser', id: image.id, requestId: 'fail' });
  assert.equal(host.sent.at(-1).opened, false); assert.match(host.sent.at(-1).error, /Could not open/);
  assert.equal((await fetch(host.openedUrls[0])).status, 404);
});

test('browser image routes retain RAW decoding, EXIF orientation and animation playback', async t => {
  const s = await setup(t), { cameraRawFixture } = require('./helpers/cameraRawFixture');
  const raw = path.join(s.directory, 'camera.DNG'); await fs.writeFile(raw, cameraRawFixture(6));
  const frames = s.magick.MagickImageCollection.create(); let animated;
  try {
    for (const color of [s.magick.MagickColors.Red, s.magick.MagickColors.Blue]) {
      const frame = s.magick.MagickImage.create(color, 96, 64); frame.animationDelay = 12; frame.animationIterations = 0; frames.push(frame);
    }
    animated = frames.write(s.magick.MagickFormat.Gif, b => Buffer.from(b));
  } finally { frames.dispose(); }
  const gif = path.join(s.directory, 'animation.gif'); await fs.writeFile(gif, animated);
  const view = (file, resolution) => `${s.base}/images/${s.browser.create([{ id: file, name: path.basename(file), relativePath: path.basename(file) }], file, resolution, 'en')}/image/0`;
  const rawResponse = await fetch(view(raw, 0)); assert.equal(rawResponse.headers.get('content-type'), 'image/webp');
  s.magick.ImageMagick.read(Buffer.from(await rawResponse.arrayBuffer()), image => { assert.equal(image.width, 64); assert.equal(image.height, 96); });
  assert.deepEqual(Buffer.from(await (await fetch(view(gif, 0))).arrayBuffer()), animated);
  const response = await fetch(view(gif, 32)); assert.equal(response.headers.get('X-Image-Frames'), '2');
  s.magick.ImageMagick.readCollection(Buffer.from(await response.arrayBuffer()), images => {
    assert.equal(images.length, 2); assert.ok(images[0].width * images[0].height <= 32 ** 2); assert.equal(images[0].animationDelay / images[0].animationTicksPerSecond, .12);
  });
  const jpeg = s.magick.ImageMagick.read(s.magick.MagickColors.Red, 80, 40, image => image.write(s.magick.MagickFormat.Jpeg, b => Buffer.from(b)));
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(exif.length + 2, 2);
  const rotated = path.join(s.directory, 'oriented.jpg'); await fs.writeFile(rotated, Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]));
  s.magick.ImageMagick.read(Buffer.from(await (await fetch(view(rotated, 32))).arrayBuffer()), image => assert.ok(image.height > image.width));
  const pair = [raw, gif].map(file => ({ id: file, name: path.basename(file), relativePath: path.basename(file) }));
  const token = s.browser.createComparison(pair, 32, 'en', {}), compare = name => `${s.base}/images/${token}/${name}`;
  const rawPreview = await fetch(compare('image/0?original=1'));
  s.magick.ImageMagick.read(Buffer.from(await rawPreview.arrayBuffer()), image => { assert.equal(image.width, 64); assert.equal(image.height, 96); });
  const animation = await fetch(compare('image/1')); assert.equal(animation.headers.get('X-Image-Frames'), '2');
  s.magick.ImageMagick.readCollection(Buffer.from(await animation.arrayBuffer()), frames => assert.equal(frames.length, 2));
});

test('browser copy-path metadata preserves literal special names, ignores supplied paths and requires an active capability', async t => {
  const http = require('node:http');
  const id = 'vscode-remote://ssh-remote+Home/data/encoded%2520.png';
  const filePath = '/data/中文 空格/100% #? literal%20%2F.png';
  let calls = 0, block, entered;
  const previews = { promote() {}, release() {}, get() { throw new Error('Copy-path metadata must not read a preview or caption'); } };
  const browser = new BrowserImages(previews, async known => {
    calls++; assert.equal(known, id); entered?.(); if (block) await block;
    return { filePath, mtime: 123, size: 456 };
  });
  const server = http.createServer((req, res) => { void browser.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { browser.dispose(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = browser.create([{ id, name: 'encoded%20.png', relativePath: 'encoded%20.png', filePath: '/untrusted/path' }], id, 2048, 'en');
  const url = route => `${base}/images/${token}/${route}`;
  const data = await (await fetch(url('state'))).json();
  assert.equal(data.images[0].filePath, filePath); assert.notEqual(data.images[0].filePath, id); assert.equal(calls, 1);
  const html = await (await fetch(url('viewer?forward=a%26b'))).text();
  assert.match(html, /file-menu\.css\?forward=a%26b/); assert.ok(html.indexOf('file-menu.js') < html.indexOf('viewer.js'));
  assert.doesNotMatch(html, /encoded%2520|untrusted\/path|literal%20/);
  assert.equal((await fetch(url('state?index=2'))).status, 400);
  assert.equal((await fetch(url('../other/file-menu.js'))).status, 404);
  assert.equal((await fetch(`${base}/images/${'0'.repeat(64)}/state`)).status, 404);
  const started = new Promise(resolve => { entered = resolve; });
  let release; block = new Promise(resolve => { release = resolve; });
  const pending = fetch(url('state')); await started; browser.release(token); release();
  assert.equal((await pending).status, 404, 'revoking a session during metadata lookup must not disclose a path');
  assert.equal((await fetch(url('state'))).status, 404); assert.equal((await fetch(url('file-menu.js'))).status, 404);
});

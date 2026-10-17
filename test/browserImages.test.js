const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { BrowserImages } = require('../dist/browserImages'), { PreviewService } = require('../dist/previewService');
const { VideoService } = require('../dist/videoService'), { initializeProcessor } = require('../dist/previewProcessor');
const { createHost } = require('./helpers/host');

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
  for (const asset of ['viewer.js', 'viewer.css']) { assert.equal((await fetch(s.url(asset))).status, 200); }
  let data = await (await fetch(s.url('state'))).json();
  assert.equal(data.index, 0); assert.equal(data.total, 3); assert.equal(data.language, 'zh');
  assert.equal(data.images.length, 2); assert.equal(s.reads(), 0, 'opening a viewer must not read image contents or captions');
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
});

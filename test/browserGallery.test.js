const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { BrowserGallery } = require('../dist/browserGallery');

async function setup(t, open) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-gallery-'));
  const image = path.join(directory, 'thumb.webp'), video = path.join(directory, 'poster.jpg');
  await fs.writeFile(image, Buffer.from('RIFF-test-webp')); await fs.writeFile(video, Buffer.from('jpeg-poster'));
  const calls = { preview: [], poster: [], releases: [], opened: [], source: 0 };
  const previews = { get: async (...args) => { calls.preview.push(args); return { filePath: image, width: 320, height: 180, originalWidth: 1000, originalHeight: 800 }; }, release: owner => calls.releases.push(['image', owner]) };
  const videos = { posterPreview: async (...args) => { calls.poster.push(args); return { file: video, source: '', timing: {} }; }, release: owner => calls.releases.push(['video', owner]) };
  const gallery = new BrowserGallery({ previews, videos,
    source: async id => { calls.source++; return { filePath: `/data/${id}`, mtime: 1, size: 2 }; },
    filePath: id => `/data/中文 空格/${id.replace('file:///', '')}`,
    open: open || (async (...args) => { calls.opened.push(args); return { path: args[0].kind === 'video' ? `/v1/${'b'.repeat(64)}/player` : `/images/${'c'.repeat(64)}/viewer` }; }),
  });
  const server = http.createServer((req, res) => { void gallery.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { gallery.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { gallery, calls, base };
}
const records = count => Array.from({ length: count }, (_, index) => ({ id: `file:///${index}.${index % 5 ? 'jpg' : 'mp4'}`, name: `${index}.${index % 5 ? 'jpg' : 'mp4'}`, relativePath: `folder/${String(index).padStart(5, '0')}.${index % 5 ? 'jpg' : 'mp4'}`, kind: index % 5 ? 'image' : 'video' }));

test('browser Gallery list is metadata-only, paged and capability scoped', async t => {
  const { gallery, calls, base } = await setup(t), media = records(100000), token = gallery.create(media, media[54321].id, { resolution: 2048, videoMaxHeight: 1080, ffmpegPath: 'ffmpeg' }, 'zh-CN');
  let response = await fetch(`${base}/gallery/${token}/viewer?forward=private`); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await response.text(); assert.match(html, /gallery\.js\?forward=private/); assert.match(html, /grid\.js\?forward=private/); assert.doesNotMatch(html, /folder\/00000/);
  response = await fetch(`${base}/gallery/${token}/list?offset=0&limit=32&q=folder%2F543`); const data = await response.json();
  assert.equal(data.total, 100); assert.equal(data.items.length, 32); assert.equal(data.items[0].index, 54300); assert.equal(data.items[0].filePath, '/data/中文 空格/54300.mp4'); assert.equal(data.selected, 54321); assert.equal(data.language, 'zh');
  assert.equal(calls.source, 0); assert.equal(calls.preview.length, 0); assert.equal(calls.poster.length, 0, 'listing must not stat, decode, or extract posters');
  assert.equal((await fetch(`${base}/gallery/${'0'.repeat(64)}/list`)).status, 404);
  assert.equal((await fetch(`${base}/gallery/${token}/list?offset=0&limit=9999`)).status, 200, 'page size is safely capped');
});

test('browser Gallery generates only requested thumbnails and opens validated records in the same private session', async t => {
  let childReleases = 0;
  const { gallery, calls, base } = await setup(t, async (...args) => { calls.opened.push(args); return { path: args[0].kind === 'video' ? `/v1/${'d'.repeat(64)}/player` : `/images/${'e'.repeat(64)}/viewer`, release: () => childReleases++ }; });
  const media = records(12), token = gallery.create(media, media[1].id, { resolution: 4096, videoMaxHeight: 1440, ffmpegPath: '/opt/ffmpeg' }, 'en');
  let response = await fetch(`${base}/gallery/${token}/thumbnail/1`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp'); assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'RIFF-test-webp');
  assert.equal(calls.preview.length, 1); assert.equal(calls.preview[0][1], 512); assert.equal(calls.preview[0][5], true, 'browser grid uses the static thumbnail path');
  response = await fetch(`${base}/gallery/${token}/thumbnail/0`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg'); assert.equal(calls.poster.length, 1); assert.equal(calls.poster[0][3], '/opt/ffmpeg');
  response = await fetch(`${base}/gallery/${token}/open/0`, { method: 'POST', body: JSON.stringify({ time: 71, rate: 1.5, quality: 1080 }) }); assert.deepEqual(await response.json(), { path: `/v1/${'d'.repeat(64)}/player` });
  assert.equal(calls.opened[0][0].id, media[0].id); assert.equal(calls.opened[0][2].token, token); assert.equal(calls.opened[0][2].index, 0); assert.equal(calls.opened[0][4].time, 71);
  response = await fetch(`${base}/gallery/${token}/open/1`, { method: 'POST', body: '{}' }); assert.equal(response.status, 200); assert.equal(childReleases, 1, 'opening another card releases the abandoned child viewer');
  assert.deepEqual(gallery.link(token, media[1].id), { token, index: 1 });
  gallery.release(token); assert.equal(childReleases, 2); assert.equal((await fetch(`${base}/gallery/${token}/list`)).status, 404);
  assert.equal(calls.source, 0); assert.ok(calls.releases.some(([kind]) => kind === 'image')); assert.ok(calls.releases.some(([kind]) => kind === 'video'));
});

test('releasing a Gallery while its child opens revokes the late child result', async t => {
  let resolve, started, released = 0;
  const pending = new Promise(done => { resolve = done; });
  const entered = new Promise(done => { started = done; });
  const { gallery, base } = await setup(t, async () => { started(); await pending; return { path: `/images/${'f'.repeat(64)}/viewer`, release: () => released++ }; });
  const media = records(2), token = gallery.create(media, media[1].id, { resolution: 0, videoMaxHeight: 0, ffmpegPath: 'ffmpeg' }, 'en');
  const request = fetch(`${base}/gallery/${token}/open/1`, { method: 'POST', body: '{}' }); await entered; gallery.release(token); resolve();
  const response = await request; assert.equal(response.status, 404); assert.equal(released, 1);
});

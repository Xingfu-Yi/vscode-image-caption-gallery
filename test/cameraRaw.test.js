const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const manifest = require('../package.json');
const { IMAGE_EXTENSIONS, CAMERA_RAW_EXTENSIONS, isCameraRaw } = require('../dist/imageFormats');
const { initializeProcessor, processPreview } = require('../dist/previewProcessor');
const { cameraRawFixture } = require('./helpers/cameraRawFixture');
const { createHost } = require('./helpers/host');

test('RAW discovery and context menus cover every supported suffix, including uppercase URI paths', () => {
  for (const extension of CAMERA_RAW_EXTENSIONS) {
    assert.equal(IMAGE_EXTENSIONS.has(extension), true);
    assert.equal(isCameraRaw(`vscode-remote://ssh-remote+test/photos/SAMPLE${extension.toUpperCase()}?v=1`), true);
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items.filter((item) => item.when.includes('resourceExtname'))) {
        const regex = new RegExp(item.when.match(/=~ \/(.+)\/i$/)[1], 'i');
        assert.ok(regex.test(extension));
      }
    }
  }
  assert.equal(isCameraRaw('photo.jpg'), false);
});

test('decodes actual Bayer DNG data into browser-readable images at every size limit', async () => {
  const m = await initializeProcessor();
  const original = cameraRawFixture();
  const copy = Buffer.from(original);
  for (const resolution of [32, 2048, 0]) {
    const preview = await processPreview(original, resolution, 'camera.DNG');
    assert.equal(preview.originalWidth, 96); assert.equal(preview.originalHeight, 64);
    assert.ok(preview.bytes.length > 0, 'RAW must be encoded even below the threshold or with resizing disabled');
    if (resolution) { assert.ok(preview.width * preview.height <= resolution ** 2); }
    m.ImageMagick.read(preview.bytes, (decoded) => {
      assert.equal(decoded.format, m.MagickFormat.WebP);
      assert.equal(decoded.width, preview.width); assert.equal(decoded.height, preview.height);
    });
  }
  assert.deepEqual(original, copy, 'The original sensor pixels must stay untouched');
  const rotated = await processPreview(cameraRawFixture(6), 32, 'rotated.dng');
  assert.equal(rotated.originalWidth, 64); assert.equal(rotated.originalHeight, 96);
  await assert.rejects(processPreview(Buffer.from('headerless samples'), 32, 'unsupported.raw'));
});

test('remote RAW always passes through the Worker, including disabled resizing and Load original', async (t) => {
  const host = await createHost(t, { maxPreviewResolution: 0 }, true);
  await fs.writeFile(path.join(host.dataset, 'camera.DNG'), cameraRawFixture());
  await host.panel.receive({ type: 'ready' });
  const images = host.sent.find((message) => message.type === 'images').images;
  assert.equal(images.length, 1);
  assert.equal(host.reads.length, 0);
  for (const original of [false, true]) {
    const requestId = `raw-${original}`;
    await host.panel.receive({ type: 'loadPreview', id: images[0].id, requestId, detail: true, original });
    const result = host.sent.at(-1);
    assert.equal(result.type, 'preview');
    assert.equal(result.width, 96); assert.equal(result.height, 64);
    assert.match(new URL(result.source).searchParams.get('uri'), /\.webp$/);
    assert.notEqual(new URL(result.source).searchParams.get('uri'), images[0].id);
    await host.panel.receive({ type: 'releasePreview', requestId });
  }
  assert.equal(host.reads.filter((uri) => uri.endsWith('camera.DNG')).length, 1, 'Full-resolution RAW previews share the disk cache');
});

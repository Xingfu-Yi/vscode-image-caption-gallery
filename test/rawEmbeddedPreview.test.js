const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeProcessor, processPreview } = require('../dist/previewProcessor');
const { rawEmbeddedPreviews } = require('../dist/rawEmbeddedPreview');
const { rawWithEmbeddedPreview } = require('./helpers/rawEmbeddedFixture');
const { PreviewService } = require('../dist/previewService');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('adequate camera JPEG skips sensor development, retains original dimensions and rotation, and stays within the pixel budget', async () => {
  const m = await initializeProcessor();
  const jpeg = m.ImageMagick.read(m.MagickColors.Blue, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  const raw = rawWithEmbeddedPreview(jpeg, 96, 64, 8);
  const copy = Buffer.from(raw);
  raw.fill(0, raw.length - jpeg.length - 54 - 96 * 64 * 2, raw.length - jpeg.length - 54);
  for (const thumbnail of [false, true]) {
    const preview = await processPreview(raw, 32, 'sample.CR2', thumbnail);
    assert.equal(preview.previewSource, 'embedded-raw');
    assert.equal(preview.originalWidth, 64); assert.equal(preview.originalHeight, 96);
    assert.ok(preview.width < preview.height);
    assert.ok(preview.width * preview.height <= 32 ** 2);
    m.ImageMagick.read(preview.bytes, (decoded) => {
      assert.equal(decoded.width, preview.width); assert.equal(decoded.height, preview.height);
    });
  }
  const untouched = Buffer.from(copy);
  await processPreview(copy, 32, 'sample.DNG');
  assert.deepEqual(copy, untouched);
});

test('a small embedded preview is never enlarged or used for original-resolution RAW', async () => {
  const m = await initializeProcessor();
  const jpeg = m.ImageMagick.read(m.MagickColors.Red, 24, 16, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  const raw = rawWithEmbeddedPreview(jpeg, 24, 16);
  const small = await processPreview(raw, 16, 'small.DNG');
  assert.equal(small.previewSource, 'embedded-raw');
  assert.equal(small.originalWidth, 96); assert.equal(small.originalHeight, 64);
  for (const resolution of [64, 0]) {
    const result = await processPreview(raw, resolution, 'small.DNG');
    assert.equal(result.previewSource, undefined);
    assert.equal(result.originalWidth, 96); assert.equal(result.originalHeight, 64);
  }
});

test('damaged JPEG data falls back to real RAW decoding; malformed TIFF graphs are bounded', async () => {
  const m = await initializeProcessor();
  const jpeg = Buffer.from(m.ImageMagick.read(m.MagickColors.Red, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b))));
  const damaged = rawWithEmbeddedPreview(jpeg);
  damaged.fill(0, damaged.length - jpeg.length, damaged.length - jpeg.length + 2);
  assert.deepEqual(rawEmbeddedPreviews(damaged), []);
  assert.equal((await processPreview(damaged, 32, 'damaged.DNG')).previewSource, undefined);
  for (const value of [Buffer.alloc(0), Buffer.from('MM\0*\xff\xff\xff\xff', 'binary'), Buffer.from('II*\0\x08\0\0\0\xff\xff', 'binary')]) {
    assert.deepEqual(rawEmbeddedPreviews(value), []);
  }
  const cyclic = rawWithEmbeddedPreview(jpeg);
  cyclic.writeUInt32LE(8, 8 + 2 + cyclic.readUInt16LE(8) * 12);
  assert.deepEqual(rawEmbeddedPreviews(cyclic), []);
});

test('aspect-mismatched embedded images and lossless JPEG sensor strips never replace the photo', async () => {
  const m = await initializeProcessor();
  const jpeg = Buffer.from(m.ImageMagick.read(m.MagickColors.Red, 48, 48, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b))));
  assert.equal((await processPreview(rawWithEmbeddedPreview(jpeg, 48, 48), 32, 'aspect.DNG')).previewSource, undefined);
  const sensor = Buffer.from(jpeg);
  const sof = sensor.findIndex((value, index) => value === 0xff && sensor[index + 1] === 0xc0);
  assert.ok(sof > 0); sensor[sof + 1] = 0xc3;
  assert.deepEqual(rawEmbeddedPreviews(rawWithEmbeddedPreview(sensor, 48, 48)), []);
});

test('big-endian TIFF metadata is supported without guessing absent orientation', async () => {
  const m = await initializeProcessor();
  const jpeg = m.ImageMagick.read(m.MagickColors.Red, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  const header = Buffer.alloc(8 + 2 + 5 * 12 + 4);
  header.write('MM'); header.writeUInt16BE(42, 2); header.writeUInt32BE(8, 4); header.writeUInt16BE(5, 8);
  const fields = [[256, 96], [257, 64], [274, 8], [513, header.length], [514, jpeg.length]];
  fields.forEach(([tag, value], index) => {
    const offset = 10 + index * 12;
    header.writeUInt16BE(tag, offset); header.writeUInt16BE(4, offset + 2); header.writeUInt32BE(1, offset + 4); header.writeUInt32BE(value, offset + 8);
  });
  const previews = rawEmbeddedPreviews(Buffer.concat([header, jpeg]));
  assert.equal(previews.length, 1); assert.equal(previews[0].orientation, 8);
  assert.equal(previews[0].originalWidth, 96); assert.equal(previews[0].originalHeight, 64);
  header.writeUInt32BE(0, 10 + 2 * 12 + 8);
  assert.deepEqual(rawEmbeddedPreviews(Buffer.concat([header, jpeg])), []);
});

test('real Worker caches embedded RAW previews with original dimensions across service restarts', async (t) => {
  const m = await initializeProcessor();
  const jpeg = m.ImageMagick.read(m.MagickColors.Blue, 96, 64, (image) => image.write(m.MagickFormat.Jpeg, (b) => Uint8Array.from(b)));
  const raw = rawWithEmbeddedPreview(jpeg, 96, 64, 8);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-embedded-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const source = async () => ({ size: raw.length, mtime: 1, read: async () => { reads++; return raw; } });
  const service = new PreviewService(directory, source); t.after(() => service.dispose());
  const first = await service.get('file:///photos/one.CR2', 32, 'current', true, new AbortController().signal);
  assert.equal(first.previewSource, 'embedded-raw'); assert.equal(first.originalWidth, 64); assert.equal(first.originalHeight, 96);
  service.dispose();
  const restored = new PreviewService(directory, source); t.after(() => restored.dispose());
  const warm = await restored.get('file:///photos/one.CR2', 32, 'restored', true, new AbortController().signal);
  assert.equal(warm.previewSource, 'embedded-raw'); assert.equal(warm.filePath, first.filePath); assert.equal(reads, 1);
});

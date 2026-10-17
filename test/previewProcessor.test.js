const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { previewDimensions } = require('../dist/previewGeometry');
const { initializeProcessor, processPreview } = require('../dist/previewProcessor');
let magick;
before(async () => { magick = await initializeProcessor(); });

function image(format, width = 96, height = 64, color) {
  return magick.ImageMagick.read(color || magick.MagickColors.Red, width, height,
    (frame) => frame.write(format, (bytes) => Uint8Array.from(bytes)));
}

test('pixel budget handles landscape, portrait, square, threshold, disabled and extreme aspect ratios', () => {
  assert.deepEqual(previewDimensions(4096, 4096, 2048), { width: 2048, height: 2048 });
  assert.deepEqual(previewDimensions(4000, 1000, 2048), { width: 4000, height: 1000 });
  assert.deepEqual(previewDimensions(2048, 2048, 2048), { width: 2048, height: 2048 });
  assert.deepEqual(previewDimensions(8192, 8192, 0), { width: 8192, height: 8192 });
  for (const [w, h] of [[8000, 6000], [6000, 8000], [1, 1000000000], [1000000000, 1], [2050, 2048]]) {
    const actual = previewDimensions(w, h, 2048);
    assert.ok(actual.width * actual.height <= 2048 ** 2);
    assert.ok(actual.width >= 1 && actual.height >= 1);
    assert.ok(actual.width <= w && actual.height <= h);
    if (w > 1 && h > 1) { assert.ok(Math.abs(actual.width / actual.height - w / h) < 0.002); }
  }
  assert.throws(() => previewDimensions(0, 100, 32));
  assert.throws(() => previewDimensions(100, 100, -1));
});

for (const format of ['Jpeg', 'Png', 'WebP', 'Bmp', 'Gif', 'Avif']) {
  test(`resizes ${format} input to a real, decodable preview`, async () => {
    const original = image(magick.MagickFormat[format]);
    const result = await processPreview(original, 32);
    assert.equal(result.originalWidth, 96);
    assert.equal(result.originalHeight, 64);
    assert.ok(result.width * result.height <= 32 ** 2);
    assert.ok(result.bytes.length > 0);
    magick.ImageMagick.read(result.bytes, (decoded) => {
      assert.equal(decoded.width, result.width);
      assert.equal(decoded.height, result.height);
      assert.equal(decoded.format, magick.MagickFormat.WebP);
    });
    const unchanged = await processPreview(original, 128);
    assert.equal(unchanged.bytes, undefined);
    assert.equal(unchanged.width, 96);
  });
}

test('retains alpha in a transparent preview', async () => {
  const result = await processPreview(image(magick.MagickFormat.Png, 96, 64, magick.MagickColors.Transparent), 32);
  magick.ImageMagick.read(result.bytes, (decoded) => assert.equal(decoded.isOpaque, false));
});

test('honours EXIF orientation and reports oriented original dimensions', async () => {
  const jpeg = image(magick.MagickFormat.Jpeg, 80, 40);
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xe1; marker.writeUInt16BE(exif.length + 2, 2);
  const oriented = Buffer.concat([jpeg.slice(0, 2), marker, exif, jpeg.slice(2)]);
  const result = await processPreview(oriented, 32);
  assert.equal(result.originalWidth, 40);
  assert.equal(result.originalHeight, 80);
  assert.ok(result.height > result.width);
  magick.ImageMagick.read(result.bytes, (decoded) => {
    assert.equal(decoded.width, result.width);
    assert.equal(decoded.height, result.height);
    assert.ok(decoded.orientation < 5 || decoded.orientation > 8);
  });
});

for (const format of ['Gif', 'WebP']) {
  test(`keeps ${format} animation frames, timing and looping`, async () => {
    const frames = magick.MagickImageCollection.create();
    let original;
    try {
      for (const color of [magick.MagickColors.Red, magick.MagickColors.Blue]) {
        const frame = magick.MagickImage.create(color, 96, 64);
        frame.animationDelay = 12;
        frame.animationIterations = 3;
        frames.push(frame);
      }
      original = frames.write(magick.MagickFormat[format], (bytes) => Uint8Array.from(bytes));
    } finally { frames.dispose(); }
    const result = await processPreview(original, 32);
    magick.ImageMagick.readCollection(result.bytes, (decoded) => {
      assert.equal(decoded.length, 2);
      assert.equal(decoded[0].width, result.width);
      assert.equal(decoded[0].height, result.height);
      assert.equal(decoded[0].animationDelay / decoded[0].animationTicksPerSecond, 0.12);
      assert.equal(decoded[0].animationIterations, 3);
    });
  });
}

test('invalid input fails without producing a misleading original fallback', async () => {
  await assert.rejects(processPreview(new Uint8Array([1, 2, 3]), 32));
});

test('thumbnail decoding returns a static WebP even for small animations while details retain playback', async () => {
  const frames = magick.MagickImageCollection.create();
  let bytes;
  try {
    for (const color of [magick.MagickColors.Transparent, magick.MagickColors.Blue]) {
      const frame = magick.MagickImage.create(color, 32, 24);
      frame.animationDelay = 10; frames.push(frame);
    }
    bytes = frames.write(magick.MagickFormat.Gif, (output) => Uint8Array.from(output));
  } finally { frames.dispose(); }
  const thumb = await processPreview(bytes, 512, 'animation.gif', true);
  assert.ok(thumb.bytes); assert.equal(thumb.width, 32);
  magick.ImageMagick.readCollection(thumb.bytes, (frames) => { assert.equal(frames.length, 1); assert.equal(frames[0].hasAlpha, true); });
  const full = await processPreview(bytes, 512, 'animation.gif');
  assert.equal(full.bytes, undefined);
  magick.ImageMagick.readCollection(bytes, (frames) => assert.equal(frames.length, 2));
});

test('JPEG thumbnails use scaled decoding within a memory limit that rejects full-resolution pixels',async()=>{
 const bytes=image(magick.MagickFormat.Jpeg,3200,2400),previous=magick.ResourceLimits.memory;
 try{
  magick.ResourceLimits.memory=16n*1024n*1024n;
  assert.throws(()=>magick.ImageMagick.read(bytes,()=>{}),/cache|memory|resource/i);
  const thumbnail=await processPreview(bytes,512,'large.JPG',true);assert.equal(thumbnail.originalWidth,3200);assert.equal(thumbnail.originalHeight,2400);assert.ok(thumbnail.width*thumbnail.height<=512**2);
  magick.ImageMagick.read(thumbnail.bytes,decoded=>{assert.equal(decoded.width,thumbnail.width);assert.equal(decoded.height,thumbnail.height);assert.equal(decoded.format,magick.MagickFormat.WebP);});
 }finally{magick.ResourceLimits.memory=previous;}
});

test('scaled JPEG thumbnails keep EXIF orientation, exact original dimensions and the pixel budget',async()=>{
 const bytes=image(magick.MagickFormat.Jpeg,2400,1600),exif=Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000','hex');const marker=Buffer.alloc(4);marker[0]=0xff;marker[1]=0xe1;marker.writeUInt16BE(exif.length+2,2);
 const original=Buffer.concat([bytes.slice(0,2),marker,exif,bytes.slice(2)]),snapshot=Buffer.from(original),thumbnail=await processPreview(original,512,'portrait.jpg',true);
 assert.equal(thumbnail.originalWidth,1600);assert.equal(thumbnail.originalHeight,2400);assert.ok(thumbnail.height>thumbnail.width);assert.ok(thumbnail.width*thumbnail.height<=512**2);assert.deepEqual(original,snapshot);
 magick.ImageMagick.read(thumbnail.bytes,decoded=>{assert.equal(decoded.width,thumbnail.width);assert.equal(decoded.height,thumbnail.height);assert.ok(decoded.orientation<5||decoded.orientation>8);});
});

test('large PNG thumbnails fit the bounded pixel cache and preserve their tall aspect ratio',async()=>{
 let bytes;const previous=magick.ResourceLimits.memory;
 try{magick.ResourceLimits.memory=768n*1024n*1024n;bytes=image(magick.MagickFormat.Png,3200,12000);}finally{magick.ResourceLimits.memory=previous;}
 const thumbnail=await processPreview(bytes,512,'large.png',true);
 assert.equal(thumbnail.originalWidth,3200);assert.equal(thumbnail.originalHeight,12000);assert.ok(thumbnail.width*thumbnail.height<=512**2);assert.ok(Math.abs(thumbnail.width/thumbnail.height-3200/12000)<0.002);
 magick.ImageMagick.read(thumbnail.bytes,decoded=>{assert.equal(decoded.width,thumbnail.width);assert.equal(decoded.height,thumbnail.height);assert.equal(decoded.format,magick.MagickFormat.WebP);});
});

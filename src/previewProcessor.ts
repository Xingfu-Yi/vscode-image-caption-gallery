import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type * as Magick from '@imagemagick/magick-wasm' with { 'resolution-mode': 'import' };
import { previewDimensions } from './previewGeometry';
import { isCameraRaw } from './imageFormats';
import { rawEmbeddedPreviews } from './rawEmbeddedPreview';

export interface ProcessedPreview {
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  frameCount?: number;
  previewSource?: 'embedded-raw';
  bytes?: Uint8Array;
}

async function loadMagick() {
  const magick = require('./vendor/magick.cjs') as typeof Magick;
  await magick.initializeImageMagick(await readFile(path.join(__dirname, 'vendor', 'magick.wasm')));
  magick.ResourceLimits.memory = 384n * 1024n * 1024n;
  magick.ResourceLimits.disk = 0n;
  magick.ResourceLimits.listLength = 512n;
  return magick;
}

let initialized: ReturnType<typeof loadMagick> | undefined;

export function initializeProcessor(): ReturnType<typeof loadMagick> {
  initialized ??= loadMagick();
  return initialized;
}

export async function processPreview(bytes: Uint8Array, resolution: number, filename = '', thumbnail = false): Promise<ProcessedPreview> {
  const { ImageMagick, MagickFormat, MagickGeometry, MagickImageCollection, MagickReadSettings, DngReadDefines, DngOutputColor } = await initializeProcessor();
  if (isCameraRaw(filename) && resolution > 0) {
    for (const embedded of rawEmbeddedPreviews(bytes)) {
      const rotated = embedded.orientation >= 5 && embedded.orientation <= 8;
      const originalWidth = rotated ? embedded.originalHeight : embedded.originalWidth;
      const originalHeight = rotated ? embedded.originalWidth : embedded.originalHeight;
      const width = rotated ? embedded.height : embedded.width;
      const height = rotated ? embedded.width : embedded.height;
      const target = previewDimensions(originalWidth, originalHeight, resolution);
      // No upscaling or lower-quality substitutes: small/aspect-mismatched previews
      // fall back to full sensor development, as does explicit original resolution.
      if (width < target.width || height < target.height || Math.abs(width / height / (originalWidth / originalHeight) - 1) > 0.01) { continue; }
      try {
        const settings = new MagickReadSettings({ frameCount: 1, format: MagickFormat.Jpeg });
        // Ask libjpeg to decode close to the requested size instead of allocating
        // the entire camera JPEG before reducing it again.
        settings.setDefine(MagickFormat.Jpeg, 'size', `${rotated ? target.height : target.width}x${rotated ? target.width : target.height}`);
        return ImageMagick.read(embedded.bytes, settings, (image) => {
          image.orientation = embedded.orientation as Magick.Orientation;
          image.autoOrient();
          const geometry = new MagickGeometry(target.width, target.height);
          geometry.ignoreAspectRatio = true;
          image.resize(geometry);
          image.page = new MagickGeometry(0, 0, target.width, target.height);
          image.quality = thumbnail ? 75 : 85;
          image.settings.setDefine(MagickFormat.WebP, 'method', 1);
          return image.write(MagickFormat.WebP, (output) => ({
            originalWidth, originalHeight, ...target, frameCount: 1,
            previewSource: 'embedded-raw' as const, bytes: Uint8Array.from(output),
          }));
        });
      } catch { /* Damaged or unsupported embedded JPEG: try the next, then LibRaw. */ }
    }
  }
  if (thumbnail && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG shrink-on-load belongs on the grid path too: a 36 MP original should
    // never allocate its full pixel cache just to display a 512² thumbnail.
    const metadata = MagickImageCollection.create();
    let originalWidth: number, originalHeight: number, rotated: boolean;
    try {
      metadata.ping(bytes, new MagickReadSettings({ frameCount: 1 }));
      const image = metadata[0];
      if (!image) { throw new Error('The file contains no image frames.'); }
      rotated = image.orientation >= 5 && image.orientation <= 8;
      originalWidth = rotated ? image.height : image.width;
      originalHeight = rotated ? image.width : image.height;
    } finally { metadata.dispose(); }
    const target = previewDimensions(originalWidth, originalHeight, resolution);
    const settings = new MagickReadSettings({ frameCount: 1, format: MagickFormat.Jpeg });
    settings.setDefine(MagickFormat.Jpeg, 'size', `${rotated ? target.height : target.width}x${rotated ? target.width : target.height}`);
    return ImageMagick.read(bytes, settings, (image) => {
      image.autoOrient();
      const geometry = new MagickGeometry(target.width, target.height); geometry.ignoreAspectRatio = true;
      image.resize(geometry); image.page = new MagickGeometry(0, 0, target.width, target.height);
      image.quality = 75; image.settings.setDefine(MagickFormat.WebP, 'method', 1);
      // Remove bulky camera metadata, retaining ICC color profiles.
      for (const name of ['exif', 'xmp', 'iptc', '8bim']) { image.removeProfile(name); }
      return image.write(MagickFormat.WebP, (output) => ({ originalWidth, originalHeight, ...target, frameCount: 1, bytes: Uint8Array.from(output) }));
    });
  }
  if (isCameraRaw(filename) || thumbnail) {
    // Thumbnails decode only the first frame and always produce a small WebP.
    // Camera containers must use LibRaw instead of TIFF's embedded CFA/thumbnail decoder.
    const settings = new MagickReadSettings({ frameCount: 1 });
    if (isCameraRaw(filename)) { settings.format = MagickFormat.Dng; }
    const defines = new DngReadDefines();
    defines.useCameraWhitebalance = true;
    defines.outputColor = DngOutputColor.SRGB;
    if (isCameraRaw(filename)) { settings.setDefines(defines); }
    return ImageMagick.read(bytes, settings, (image) => {
      image.autoOrient();
      const originalWidth = image.width;
      const originalHeight = image.height;
      const target = previewDimensions(originalWidth, originalHeight, resolution);
      if (target.width !== originalWidth || target.height !== originalHeight) {
        const geometry = new MagickGeometry(target.width, target.height);
        geometry.ignoreAspectRatio = true;
        image.resize(geometry);
      }
      image.page = new MagickGeometry(0, 0, target.width, target.height);
      image.quality = thumbnail ? 75 : 85;
      image.settings.setDefine(MagickFormat.WebP, 'method', 1);
      return image.write(MagickFormat.WebP, (output) => ({
        originalWidth, originalHeight, ...target, frameCount: 1, bytes: Uint8Array.from(output),
      }));
    });
  }
  const metadata = MagickImageCollection.create();
  let originalWidth: number;
  let originalHeight: number;
  let frameCount: number;
  let jpeg: boolean;
  let rotated: boolean;
  try {
    metadata.ping(bytes);
    if (!metadata.length) {
      throw new Error('The file contains no image frames.');
    }
    frameCount = metadata.length;
    jpeg = metadata[0].format === MagickFormat.Jpeg;
    originalWidth = Math.max(...metadata.map((frame) => Math.max(frame.width, frame.page.width)));
    originalHeight = Math.max(...metadata.map((frame) => Math.max(frame.height, frame.page.height)));
    rotated = metadata[0].orientation >= 5 && metadata[0].orientation <= 8;
    if (rotated) {
      [originalWidth, originalHeight] = [originalHeight, originalWidth];
    }
  } finally {
    metadata.dispose();
  }
  const target = previewDimensions(originalWidth, originalHeight, resolution);
  const result = { originalWidth, originalHeight, ...target, frameCount };
  if (target.width === originalWidth && target.height === originalHeight) {
    return result;
  }
  const settings = new MagickReadSettings();
  if (jpeg) {
    // Scaled JPEG decoding avoids materializing full-size pixels before resizing.
    // Decode dimensions use file orientation; resize dimensions use auto-oriented pixels.
    settings.setDefine(MagickFormat.Jpeg, 'size', `${rotated ? target.height : target.width}x${rotated ? target.width : target.height}`);
  }
  return ImageMagick.readCollection(bytes, settings, (frames) => {
    if (frames.length > 1) {
      frames.coalesce();
    }
    const geometry = new MagickGeometry(target.width, target.height);
    geometry.ignoreAspectRatio = true; // Dimensions were already computed with the original aspect ratio.
    for (const frame of frames) {
      frame.autoOrient();
      frame.resize(geometry);
      frame.page = new MagickGeometry(0, 0, target.width, target.height);
      frame.quality = 85;
      frame.settings.setDefine(MagickFormat.WebP, 'method', 1);
    }
    return frames.write(MagickFormat.WebP, (output) => ({ ...result, bytes: Uint8Array.from(output) }));
  });
}

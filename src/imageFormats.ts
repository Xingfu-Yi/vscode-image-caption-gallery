import * as path from 'node:path';

// Camera containers supported by the bundled LibRaw decoder. Headerless sensor dumps
// need dimensions/layout metadata and are deliberately outside this format list's scope.
export const CAMERA_RAW_EXTENSIONS = new Set([
  '.3fr', '.arw', '.cr2', '.cr3', '.crw', '.dcr', '.dng', '.erf', '.iiq',
  '.k25', '.kdc', '.mef', '.mos', '.mrw', '.nef', '.nrw', '.orf', '.pef',
  '.raf', '.raw', '.rw2', '.rwl', '.sr2', '.srf', '.srw', '.x3f',
]);
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', ...CAMERA_RAW_EXTENSIONS,
]);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv', '.mpg', '.mpeg', '.wmv',
  '.3gp', '.mts', '.m2ts', '.ogv', '.vob', '.flv',
]);
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

function extensionOf(filename: string): string {
  let pathname = filename;
  try { pathname = new URL(filename).pathname; } catch { /* A filesystem path is also accepted. */ }
  return path.extname(pathname).toLowerCase();
}

export function isCameraRaw(filename: string): boolean {
  return CAMERA_RAW_EXTENSIONS.has(extensionOf(filename));
}

export function isVideo(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(filename));
}

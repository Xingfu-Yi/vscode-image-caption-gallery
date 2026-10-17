/** Read bounded classic-TIFF metadata/JPEG previews without developing sensor pixels.
 * CR3 and unsupported/malformed containers return undefined and use LibRaw.
 */
export interface RawEmbeddedPreview {
  bytes: Uint8Array;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  orientation: number;
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) { return; }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) { return; }
    while (bytes[offset] === 0xff) { offset++; }
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) { return; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { continue; }
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) { return; }
    // Lossless JPEG sensor strips are not developed display images.
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) { return; }
      if (bytes[offset + 2] !== 8) { return; }
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length;
  }
}

export function rawEmbeddedPreviews(bytes: Uint8Array): RawEmbeddedPreview[] {
  if (bytes.length < 8) { return []; }
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) { return []; }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, little);
  const u32 = (offset: number): number => view.getUint32(offset, little);
  if (u16(2) !== 42) { return []; } // BigTIFF needs a different layout.
  const visited = new Set<number>();
  const pending = [u32(4)];
  const candidates: { bytes: Uint8Array; width: number; height: number }[] = [];
  let orientation: number | undefined;
  let original: { width: number; height: number } | undefined;
  let exifOriginal: { width: number; height: number } | undefined;
  while (pending.length && visited.size < 32) {
    const ifd = pending.shift()!;
    if (!ifd || visited.has(ifd) || ifd + 2 > bytes.length) { continue; }
    visited.add(ifd);
    const count = u16(ifd);
    if (count > 1024 || ifd + 2 + count * 12 + 4 > bytes.length) { continue; }
    const fields = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      const type = u16(entry + 2), values = u32(entry + 4);
      const size = type === 1 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 0;
      if (!size || !values || values > 16) { continue; }
      const offset = size * values <= 4 ? entry + 8 : u32(entry + 8);
      if (offset + size * values > bytes.length) { continue; }
      fields.set(u16(entry), Array.from({ length: values }, (_, n) => size === 1 ? bytes[offset + n] : size === 2 ? u16(offset + n * 2) : u32(offset + n * 4)));
    }
    const scalar = (tag: number): number | undefined => fields.get(tag)?.length === 1 ? fields.get(tag)![0] : undefined;
    const width = scalar(256), height = scalar(257);
    if (width && height && (!original || width * height > original.width * original.height)) { original = { width, height }; }
    const exifWidth = scalar(40962), exifHeight = scalar(40963);
    if (exifWidth && exifHeight && (!exifOriginal || exifWidth * exifHeight > exifOriginal.width * exifOriginal.height)) { exifOriginal = { width: exifWidth, height: exifHeight }; }
    const direction = scalar(274);
    if (!orientation && direction && direction <= 8) { orientation = direction; }
    for (const [offsetTag, lengthTag] of [[513, 514], [273, 279]]) {
      const offset = scalar(offsetTag), length = scalar(lengthTag);
      if (offset === undefined || !length || offset + length > bytes.length || candidates.length >= 8) { continue; }
      const jpeg = bytes.subarray(offset, offset + length);
      const dimensions = jpegSize(jpeg);
      if (dimensions && !candidates.some((c) => c.bytes.byteOffset === jpeg.byteOffset)) { candidates.push({ bytes: jpeg, ...dimensions }); }
    }
    for (const tag of [330, 34665]) {
      for (const next of fields.get(tag) ?? []) { if (pending.length < 64) { pending.push(next); } }
    }
    pending.push(u32(ifd + 2 + count * 12));
  }
  original = exifOriginal ?? original;
  if (!original || !orientation) { return []; } // Never guess rotation or label a tiny thumbnail as the original.
  return candidates.sort((a, b) => b.width * b.height - a.width * a.height).map((candidate) => ({
    ...candidate, originalWidth: original!.width, originalHeight: original!.height, orientation: orientation!,
  }));
}

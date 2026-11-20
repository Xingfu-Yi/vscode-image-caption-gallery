import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type Rotation = 'none' | 'cw90' | 'ccw90' | '180';
export interface AbsoluteVideoOrientation { rotation: Rotation; key: string }
interface Source { filePath: string; size: number; mtime: number }
const maximumBytes = 16 * 1024;
const filters: Record<Rotation, string> = { none: '', cw90: 'transpose=clock,', ccw90: 'transpose=cclock,', '180': 'hflip,vflip,' };
export const videoOrientationFilter = (orientation?: AbsoluteVideoOrientation): string => orientation ? filters[orientation.rotation] : '';

/** Only our identity-bound absolute sidecar can override container autorotation.
 * Other JSONL, stale receipts and native-applied records leave playback unchanged. */
export async function readVideoOrientation(source: Source): Promise<AbsoluteVideoOrientation | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const filename = source.filePath + '.jsonl', named = await fs.lstat(filename, { bigint: true });
    if (!named.isFile() || named.size > BigInt(maximumBytes)) { return; }
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || before.size > BigInt(maximumBytes)) { return; }
    const buffer = Buffer.alloc(maximumBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (bytesRead > maximumBytes || BigInt(bytesRead) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs) { return; }
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!text || text.includes('\n')) { return; }
    // Python writes nanosecond integers above Number.MAX_SAFE_INTEGER. Preserve
    // identity tokens before JSON.parse rather than silently rounding nanoseconds.
    const record = JSON.parse(text.replace(/("(?:dev|ino|size|mtime_ns)"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"'));
    const id = /^(v\d{9,})__/.exec(path.basename(source.filePath))?.[1];
    if (!id || record?.asset_id !== id || record.status !== 'reported' || record.reference !== 'encoded_pixels' || record.native_rotation_applied !== false || !Object.hasOwn(filters, record.rotation)) { return; }
    const identity = record.source_identity, current = await fs.stat(source.filePath, { bigint: true });
    if (!current.isFile() || Number(current.size) !== source.size || Math.floor(Number(current.mtimeNs) / 1e6) !== Math.floor(source.mtime)) { return; }
    const observed = { dev: current.dev, ino: current.ino, size: current.size, mtime_ns: current.mtimeNs };
    for (const [key, value] of Object.entries(observed)) {
      if (typeof identity?.[key] !== 'string' || !/^-?\d+$/.test(identity[key]) || BigInt(identity[key]) !== value) { return; }
    }
    const rotation = record.rotation as Rotation;
    if (record.rotation_degrees !== undefined && record.rotation_degrees !== { none: 0, cw90: 90, ccw90: -90, '180': 180 }[rotation]) { return; }
    return { rotation, key: createHash('sha256').update(text).digest('hex') };
  } catch {
    return; // Foreign/unreadable JSONL never supplies a guessed transform.
  } finally {
    await handle?.close();
  }
}

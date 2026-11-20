// Read the actual WebM block order: ffprobe reorders some malformed inputs and
// can hide the timestamp regression that Chromium's SourceBuffer rejects.
function webmTimeline(bytes) {
 const blocks = [];
 function vint(offset, identifier = false) {
  const first = bytes[offset];
  const width = Array.from({ length: 8 }, (_, i) => i + 1).find(n => first & (1 << (8 - n)));
  if (!width || offset + width > bytes.length) throw new Error('Invalid EBML integer');
  let value = identifier ? first : first & ((1 << (8 - width)) - 1);
  for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i];
  return { value, width };
 }
 let clusterIndex = 0;
 function walk(start, end, cluster) {
  for (let offset = start; offset < end;) {
   const id = vint(offset, true), size = vint(offset + id.width);
   const payload = offset + id.width + size.width, stop = Math.min(end, payload + size.value);
   if (id.value === 0x18538067) walk(payload, stop);
   else if (id.value === 0x1f43b675) walk(payload, stop, ++clusterIndex);
   else if (id.value === 0xa0) walk(payload, stop, cluster);
   else if (cluster && (id.value === 0xa3 || id.value === 0xa1)) {
    const track = vint(payload);
    blocks.push({ cluster, track: track.value, timecode: bytes.readInt16BE(payload + track.width) });
   }
   offset = stop;
  }
 }
 walk(0, bytes.length);
 return blocks;
}
module.exports = { webmTimeline };

// A tiny, generated, uncompressed Bayer DNG. No third-party photos or fixtures.
// TIFF/DNG tag IDs follow Adobe's public Digital Negative specification.
function cameraRawFixture(orientation = 1) {
  const width = 96, height = 64;
  const fields = [];
  function field(tag, type, values) {
    const array = typeof values === 'string' ? Buffer.from(`${values}\0`) : values;
    const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 }[type];
    const data = Buffer.alloc(array.length * size);
    array.forEach((value, index) => {
      if (size === 1) { data[index] = value; }
      else if (type === 3) { data.writeUInt16LE(value, index * size); }
      else if (type === 4) { data.writeUInt32LE(value, index * size); }
      else { data.writeInt32LE(value, index * size); data.writeInt32LE(1, index * size + 4); }
    });
    fields.push({ tag, type, count: array.length, data });
  }
  field(254, 4, [0]); field(256, 4, [width]); field(257, 4, [height]);
  field(258, 3, [16]); field(259, 3, [1]); field(262, 3, [32803]);
  field(271, 2, 'Gallery'); field(272, 2, 'Generated Bayer test');
  field(273, 4, [0]); field(274, 3, [orientation]); field(277, 3, [1]);
  field(278, 4, [height]); field(279, 4, [width * height * 2]); field(284, 3, [1]);
  field(33421, 3, [2, 2]); field(33422, 1, [0, 1, 1, 2]);
  field(50706, 1, [1, 4, 0, 0]); field(50707, 1, [1, 1, 0, 0]);
  field(50708, 2, 'Gallery generated DNG'); field(50710, 1, [0, 1, 2]);
  field(50711, 3, [1]); field(50714, 5, [0]); field(50717, 3, [4095]);
  field(50721, 10, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  field(50728, 5, [1, 1, 1]); field(50778, 3, [21]);
  fields.sort((a, b) => a.tag - b.tag);
  let offset = 8 + 2 + fields.length * 12 + 4;
  for (const item of fields) {
    if (item.data.length > 4) { item.offset = offset; offset += item.data.length + item.data.length % 2; }
  }
  const bytes = Buffer.alloc(offset + width * height * 2);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(fields.length, 8);
  fields.find((item) => item.tag === 273).data.writeUInt32LE(offset);
  fields.forEach((item, index) => {
    const entry = 10 + index * 12;
    bytes.writeUInt16LE(item.tag, entry); bytes.writeUInt16LE(item.type, entry + 2);
    bytes.writeUInt32LE(item.count, entry + 4);
    if (item.offset) { bytes.writeUInt32LE(item.offset, entry + 8); item.data.copy(bytes, item.offset); }
    else { item.data.copy(bytes, entry + 8); }
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = (x % 2 === 0 && y % 2 === 0 ? 1800 : y % 2 === 1 && x % 2 === 1 ? 600 : 1100) + x * 4 + y * 2;
      bytes.writeUInt16LE(value, offset + (y * width + x) * 2);
    }
  }
  return bytes;
}
module.exports = { cameraRawFixture };

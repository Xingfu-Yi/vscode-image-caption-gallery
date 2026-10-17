const { cameraRawFixture } = require('./cameraRawFixture');

function rawWithEmbeddedPreview(jpeg, width = 96, height = 64, orientation = 1) {
  const raw = cameraRawFixture(orientation);
  const entryCount = raw.readUInt16LE(8);
  const fields = [[256, width], [257, height], [513, raw.length + 2 + 4 * 12 + 4], [514, jpeg.length]];
  const ifd = Buffer.alloc(2 + fields.length * 12 + 4);
  ifd.writeUInt16LE(fields.length);
  for (let i = 0; i < fields.length; i++) {
    const offset = 2 + i * 12;
    ifd.writeUInt16LE(fields[i][0], offset);
    ifd.writeUInt16LE(4, offset + 2);
    ifd.writeUInt32LE(1, offset + 4);
    ifd.writeUInt32LE(fields[i][1], offset + 8);
  }
  raw.writeUInt32LE(raw.length, 8 + 2 + entryCount * 12);
  return Buffer.concat([raw, ifd, jpeg]);
}

module.exports = { rawWithEmbeddedPreview };

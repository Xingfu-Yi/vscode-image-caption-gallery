const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeCaption, encodeCaption } = require('../dist/captionCodec.js');

test('decodes UTF-8 LF captions without a BOM', () => {
  const bytes = new TextEncoder().encode('alpha\nbeta\n');
  const decoded = decodeCaption(bytes);

  assert.equal(decoded.text, 'alpha\nbeta\n');
  assert.equal(decoded.hasBom, false);
  assert.equal(decoded.eol, 'lf');
  assert.match(decoded.revision, /^[a-f0-9]{64}$/);
});

test('detects a UTF-8 BOM and CRLF line endings', () => {
  const body = new TextEncoder().encode('alpha\r\nbeta\r\n');
  const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
  const decoded = decodeCaption(bytes);

  assert.equal(decoded.text, 'alpha\r\nbeta\r\n');
  assert.equal(decoded.hasBom, true);
  assert.equal(decoded.eol, 'crlf');
});

test('preserves BOM and CRLF when encoding an existing caption', () => {
  const bytes = encodeCaption('alpha\nbeta\n', { hasBom: true, eol: 'crlf' });

  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.equal(new TextDecoder().decode(bytes.slice(3)), 'alpha\r\nbeta\r\n');
});

test('creates new captions as UTF-8 LF, including empty files', () => {
  const body = encodeCaption('alpha\r\nbeta\r', { hasBom: false, eol: 'lf' });
  const empty = encodeCaption('', { hasBom: false, eol: 'lf' });

  assert.equal(new TextDecoder().decode(body), 'alpha\nbeta\n');
  assert.equal(empty.length, 0);
});

test('content revisions change when the bytes change', () => {
  const before = decodeCaption(new TextEncoder().encode('before'));
  const after = decodeCaption(new TextEncoder().encode('after'));

  assert.notEqual(before.revision, after.revision);
});

import * as crypto from 'node:crypto';

export type CaptionEol = 'lf' | 'crlf';

export interface CaptionEncoding {
  hasBom: boolean;
  eol: CaptionEol;
}

export interface DecodedCaption extends CaptionEncoding {
  text: string;
  revision: string;
}

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);

export function decodeCaption(bytes: Uint8Array): DecodedCaption {
  const hasBom = bytes.length >= UTF8_BOM.length
    && bytes[0] === UTF8_BOM[0]
    && bytes[1] === UTF8_BOM[1]
    && bytes[2] === UTF8_BOM[2];
  const textBytes = hasBom ? bytes.slice(UTF8_BOM.length) : bytes;
  const text = new TextDecoder().decode(textBytes);

  return {
    text,
    revision: hashBytes(bytes),
    hasBom,
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
  };
}

export function encodeCaption(text: string, encoding: CaptionEncoding): Uint8Array {
  const normalized = text.replace(/\r\n?/g, '\n');
  const withPreferredEol = encoding.eol === 'crlf'
    ? normalized.replace(/\n/g, '\r\n')
    : normalized;
  const encoded = new TextEncoder().encode(withPreferredEol);

  if (!encoding.hasBom) {
    return encoded;
  }

  const bytes = new Uint8Array(UTF8_BOM.length + encoded.length);
  bytes.set(UTF8_BOM, 0);
  bytes.set(encoded, UTF8_BOM.length);
  return bytes;
}

function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  decodeBase64Bytes,
  decodeTextBase64Preview,
  encodeBytesBase64,
  encodeTextBase64,
} from '../../../services/projects/projectSource.ts';

test('decodeTextBase64Preview returns only the leading portion of a text payload', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const encoded = encodeTextBase64(text);

  const preview = decodeTextBase64Preview(encoded, 6);

  assert.equal(preview, 'abcdef');
});

test('decodeTextBase64Preview returns empty string for zero-byte budget', () => {
  const encoded = encodeTextBase64('contenuto');

  assert.equal(decodeTextBase64Preview(encoded, 0), '');
});

test('encodeBytesBase64 bounds each browser allocation for large binary sources', () => {
  const nativeBtoa = globalThis.btoa;
  let largestInputLength = 0;
  vi.stubGlobal('btoa', (value: string) => {
    largestInputLength = Math.max(largestInputLength, value.length);
    if (value.length > 64 * 1024) {
      throw new RangeError('allocation size overflow');
    }
    return nativeBtoa(value);
  });

  try {
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
    const encoded = encodeBytesBase64(bytes);

    assert.ok(largestInputLength <= 64 * 1024);
    assert.deepEqual(decodeBase64Bytes(encoded), bytes);
  } finally {
    vi.unstubAllGlobals();
  }
});

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeTextBase64Preview, encodeTextBase64 } from './projectSource.ts';

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

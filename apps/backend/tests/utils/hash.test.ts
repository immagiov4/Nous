import { describe, expect, test } from 'vitest';

import { buildSha256HexDigest } from '../../src/utils/hash.js';

describe('buildSha256HexDigest', () => {
  test('returns a stable SHA-256 hex digest', () => {
    expect(buildSha256HexDigest(Buffer.from('nous-reader'))).toBe(
      'd64fea50b620a356b214e7d6b67cc86699eae7d43ccc5746f5bddd7cb969cc43'
    );
  });
});

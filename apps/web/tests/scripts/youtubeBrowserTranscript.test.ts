import { describe, expect, test } from 'vitest';
import { parseTimestamp } from '../../../../scripts/fetch-youtube-browser-transcript.mjs';

describe('browser transcript script', () => {
  test('parses YouTube timestamps without depending on the rendered locale', () => {
    expect(parseTimestamp(' 1:02 ')).toBe(62);
    expect(parseTimestamp('1:02:03')).toBe(3_723);
    expect(parseTimestamp('not-a-time')).toBeNull();
  });
});

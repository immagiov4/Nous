import { expect, test } from 'vitest';
import { normalizePathname } from '../../utils/pathname.ts';

test.each([
  ['', '/'],
  ['/', '/'],
  ['///', '/'],
  ['/preferences/setup', '/preferences/setup'],
  ['/preferences/setup///', '/preferences/setup'],
  ['/dev//first-run/', '/dev//first-run'],
])('normalizes route %s to %s', (pathname, expected) => {
  expect(normalizePathname(pathname)).toBe(expected);
});

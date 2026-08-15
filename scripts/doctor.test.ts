import { describe, expect, test } from 'vitest';
import { parseFallowBaseline, parsePinnedBunVersion } from './doctor';

describe('parsePinnedBunVersion', () => {
  test('returns the exact Bun version from packageManager', () => {
    expect(parsePinnedBunVersion(JSON.stringify({ packageManager: 'bun@1.3.14' }))).toBe('1.3.14');
  });

  test.each([
    '{}',
    JSON.stringify({ packageManager: 'npm@11.0.0' }),
  ])('rejects a manifest without a pinned Bun runtime: %s', manifest => {
    expect(() => parsePinnedBunVersion(manifest)).toThrow();
  });
});

describe('parseFallowBaseline', () => {
  test('returns non-zero categories in stable debt-first order', () => {
    expect(
      parseFallowBaseline(
        JSON.stringify({
          check: {
            total_issues: 7,
            unused_dependencies: 2,
            unused_exports: 2,
            unused_files: 3,
            unused_types: 0,
          },
        })
      )
    ).toEqual({
      categories: [
        { count: 3, name: 'unused files' },
        { count: 2, name: 'unused dependencies' },
        { count: 2, name: 'unused exports' },
      ],
      totalIssues: 7,
    });
  });

  test.each([
    '{}',
    JSON.stringify({ check: {} }),
    JSON.stringify({ check: { total_issues: -1 } }),
    JSON.stringify({ check: { total_issues: 1.5 } }),
    JSON.stringify({ check: { total_issues: 1, unused_files: -1 } }),
  ])('rejects an invalid regression baseline: %s', baseline => {
    expect(() => parseFallowBaseline(baseline)).toThrow();
  });
});

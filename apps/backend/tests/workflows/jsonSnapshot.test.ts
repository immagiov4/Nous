import { describe, expect, test } from 'vitest';

import { snapshotDurableJson } from '../../src/workflows/jsonSnapshot.js';

describe('durable JSON snapshots', () => {
  test('rejects embedded data URLs at any depth', () => {
    expect(() =>
      snapshotDurableJson({
        artifact: {
          code: 'data:image/png;base64,c2VjcmV0LWJ5dGVz',
        },
      })
    ).toThrow('Durable values must reference binary objects instead of embedding data URLs.');

    expect(() =>
      snapshotDurableJson({
        code: '<img src="data:image/webp;base64,c2VjcmV0LWJ5dGVz" alt="">',
      })
    ).toThrow('Durable values must reference binary objects instead of embedding data URLs.');
  });

  test('rejects binary values before JSON can disguise them as objects', () => {
    for (const bytes of [new Uint8Array([1, 2, 3]), new ArrayBuffer(3), new Blob(['bytes'])]) {
      expect(() => snapshotDurableJson({ bytes })).toThrow(
        'Durable values must reference binary objects instead of embedding bytes.'
      );
    }
  });

  test('accepts an object-storage reference and inline textual artifact source', () => {
    expect(
      snapshotDurableJson({
        raster: {
          byteSize: 12,
          hash: 'abc123',
          mediaType: 'image/png',
          objectPath: 'users/user/projects/project/visual/hash.png',
        },
        svg: '<svg viewBox="0 0 10 10"></svg>',
      })
    ).toEqual({
      raster: {
        byteSize: 12,
        hash: 'abc123',
        mediaType: 'image/png',
        objectPath: 'users/user/projects/project/visual/hash.png',
      },
      svg: '<svg viewBox="0 0 10 10"></svg>',
    });
  });
});

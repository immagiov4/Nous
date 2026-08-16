import {
  loadZipSafely,
  readZipEntryBytesWithinLimit,
  ZipEntryTooLargeError,
} from '@shared/zipSafety';
import JSZip from 'jszip';
import { describe, expect, test, vi } from 'vitest';

describe('ZIP safety', () => {
  test('rejects traversal paths using the original archive entry name', async () => {
    const source = new JSZip();
    source.file('../outside.txt', 'not allowed');
    const bytes = await source.generateAsync({ type: 'uint8array' });

    await expect(loadZipSafely(bytes)).rejects.toThrow('Invalid ZIP archive.');
  });

  test('rejects a declared expanded-size overflow before reading any entry', async () => {
    const source = new JSZip();
    source.file('large.txt', 'a'.repeat(4_096));
    const bytes = await source.generateAsync({ compression: 'DEFLATE', type: 'uint8array' });
    const loaded = await JSZip.loadAsync(bytes);
    const entry = loaded.file('large.txt');
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('Expected large.txt in the test archive.');
    const asyncSpy = vi.spyOn(entry, 'async');
    vi.spyOn(JSZip, 'loadAsync').mockResolvedValueOnce(loaded);

    await expect(
      loadZipSafely(bytes, {
        maxEntries: 1,
        maxTotalUncompressedBytes: 1_024,
      })
    ).rejects.toThrow('Invalid ZIP archive.');
    expect(asyncSpy).not.toHaveBeenCalled();
  });

  test('rejects an oversized entry from ZIP metadata before decompression', async () => {
    const source = new JSZip();
    source.file('large.txt', 'b'.repeat(4_096));
    const bytes = await source.generateAsync({ compression: 'DEFLATE', type: 'uint8array' });
    const loaded = await loadZipSafely(bytes);
    const entry = loaded.file('large.txt');
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('Expected large.txt in the test archive.');
    const asyncSpy = vi.spyOn(entry, 'async');

    await expect(readZipEntryBytesWithinLimit(entry, 1_024)).rejects.toBeInstanceOf(
      ZipEntryTooLargeError
    );
    expect(asyncSpy).not.toHaveBeenCalled();
  });

  test('treats streamed overflow from understated ZIP metadata as invalid', async () => {
    const source = new JSZip();
    source.file('large.txt', 'c'.repeat(4_096));
    const bytes = await source.generateAsync({ compression: 'DEFLATE', type: 'uint8array' });
    const loaded = await loadZipSafely(bytes);
    const entry = loaded.file('large.txt');
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('Expected large.txt in the test archive.');
    const entryWithMetadata = entry as typeof entry & {
      _data?: { uncompressedSize?: number };
    };
    expect(entryWithMetadata._data).toBeDefined();
    if (!entryWithMetadata._data) throw new Error('Expected ZIP entry metadata.');
    entryWithMetadata._data.uncompressedSize = 1;

    const error = await readZipEntryBytesWithinLimit(entry, 1_024).catch(cause => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ZipEntryTooLargeError);
    expect((error as Error).message).toBe('Invalid ZIP archive.');
  });
});

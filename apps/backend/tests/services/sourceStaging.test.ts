import { statfs } from 'node:fs/promises';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  assertSourceStagingAvailable,
  SourceStagingUnavailableError,
} from '../../src/projects/sourceStaging.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  statfs: vi.fn(),
}));
beforeEach(() => vi.mocked(statfs).mockReset());

test('rejects memory-backed staging before any originals can accumulate', async () => {
  vi.mocked(statfs).mockResolvedValue({ type: 0x01021994 } as Awaited<ReturnType<typeof statfs>>);
  await expect(assertSourceStagingAvailable()).rejects.toBeInstanceOf(
    SourceStagingUnavailableError
  );
});

test('admits disk-backed staging', async () => {
  vi.mocked(statfs).mockResolvedValue({ type: 0xef53 } as Awaited<ReturnType<typeof statfs>>);
  await expect(assertSourceStagingAvailable()).resolves.toBeUndefined();
});

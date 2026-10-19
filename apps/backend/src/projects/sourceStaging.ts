import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  SOURCE_STAGING_UNAVAILABLE_CODE,
  SOURCE_STAGING_UNAVAILABLE_MESSAGE,
} from '@shared/sourcePreparation';

const MEMORY_FILESYSTEM_TYPES = new Set([0x01021994, 0x858458f6]); // Linux tmpfs and ramfs.

export class SourceStagingUnavailableError extends Error {
  readonly code = SOURCE_STAGING_UNAVAILABLE_CODE;
  constructor() {
    super(SOURCE_STAGING_UNAVAILABLE_MESSAGE);
  }
}

/** Fail before accepting originals when TMPDIR still points at a RAM filesystem. */
export const assertSourceStagingAvailable = async (): Promise<void> => {
  const filesystem = await statfs(tmpdir());
  if (MEMORY_FILESYSTEM_TYPES.has(Number(filesystem.type)))
    throw new SourceStagingUnavailableError();
};

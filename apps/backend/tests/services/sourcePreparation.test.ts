import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  cancelProjectImportUpload,
  getProjectImportUploadStatus,
  startSourcePreparation,
  storeProjectImportChunk,
} from '../../src/projects/projectImportChunks.js';

const upload = async () => {
  const uploadId = randomUUID();
  const userId = `source-preparation-${randomUUID()}`;
  await storeProjectImportChunk({
    uploadId,
    userId,
    sourceUpload: true,
    chunkCount: 1,
    chunkIndex: 0,
    chunk: Buffer.from('synthetic source'),
  });
  return { uploadId, userId };
};

describe('asynchronous source preparation', () => {
  test('returns before processing finishes and publishes per-step progress', async () => {
    const identity = await upload();
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const completion = {
      projectId: 'prepared-course',
      meta: { id: 'prepared-course' } as import('../../src/projects/types.js').SavedProjectMeta,
    };
    const accepted = startSourcePreparation({
      ...identity,
      importFile: async (_path, _revision, context) => {
        context.reportProgress({
          step: 'pdf-transcription',
          completed: 2,
          total: 5,
          documentName: 'lesson.pdf',
          failedPages: [1],
          failures: [{ documentName: 'lesson.pdf', pageNumber: 1 }],
        });
        entered();
        await blocked;
        return completion;
      },
    });
    expect(accepted).toBeUndefined();
    await started;
    expect(getProjectImportUploadStatus(identity.userId, identity.uploadId)).toMatchObject({
      status: 'finalizing',
      progress: { step: 'pdf-transcription', completed: 2, total: 5, failedPages: [1] },
    });
    expect(getProjectImportUploadStatus('another-user', identity.uploadId)).toBeUndefined();
    finish();
    await expect
      .poll(() => getProjectImportUploadStatus(identity.userId, identity.uploadId))
      .toMatchObject({ status: 'completed', completed: completion });
  });

  test('retains a failed outcome instead of leaving polling clients waiting', async () => {
    const identity = await upload();
    const failure = new Error('synthetic processing failure');
    startSourcePreparation({
      ...identity,
      importFile: async () => {
        throw failure;
      },
    });
    await expect
      .poll(() => getProjectImportUploadStatus(identity.userId, identity.uploadId))
      .toMatchObject({ status: 'failed', failure });
  });

  test('signals cancellation to active preparation and cleans up after it stops', async () => {
    const identity = await upload();
    let signal!: AbortSignal;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    startSourcePreparation({
      ...identity,
      importFile: async (_path, _revision, context) => {
        signal = context.signal;
        entered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
    });
    await started;
    await cancelProjectImportUpload(identity.userId, identity.uploadId);
    expect(signal.aborted).toBe(true);
    await expect
      .poll(() => getProjectImportUploadStatus(identity.userId, identity.uploadId))
      .toMatchObject({ status: 'failed' });
  });
});

vi.mock('../../src/projects/sourceStaging.js', () => ({
  assertSourceStagingAvailable: vi.fn(async () => {}),
}));

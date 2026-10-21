import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  cancelProjectImportUpload,
  cancelProjectSourcePreparation,
  getProjectImportUploadStatus,
  getProjectSourcePreparation,
  startSourcePreparation,
  storeProjectImportChunk,
} from '../../src/projects/projectImportChunks.js';

const upload = async () => {
  const uploadId = randomUUID();
  const userId = `source-preparation-${randomUUID()}`;
  const projectId = randomUUID();
  await storeProjectImportChunk({
    uploadId,
    userId,
    sourceUpload: true,
    projectId,
    chunkCount: 1,
    chunkIndex: 0,
    chunk: Buffer.from('synthetic source'),
  });
  return { uploadId, userId, projectId };
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

test('retry joins the project preparation before capacity admission and does not process twice', async () => {
  const userId = `retry-${randomUUID()}`;
  const projectId = randomUUID();
  const uploadId = randomUUID();
  const chunk = Buffer.from('synthetic source');
  const input = {
    userId,
    projectId,
    contentKey: 'identical-content',
    sourceUpload: true,
    chunkCount: 1,
    chunkIndex: 0,
    chunk,
  };
  await storeProjectImportChunk({ ...input, uploadId });
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => {
    finish = resolve;
  });
  const importFile = vi.fn(async () => {
    await blocked;
    return {
      projectId,
      meta: { id: projectId } as import('../../src/projects/types.js').SavedProjectMeta,
    };
  });
  try {
    startSourcePreparation({ userId, uploadId, importFile });
    await expect(
      storeProjectImportChunk({ ...input, contentKey: 'different-content', uploadId: randomUUID() })
    ).rejects.toThrow('altre fonti');
    const retry = await storeProjectImportChunk({ ...input, uploadId: randomUUID() });
    expect(retry).toMatchObject({ uploadId, uploadStatus: 'finalizing' });
    startSourcePreparation({ userId, uploadId, importFile });
  } finally {
    finish();
    await expect
      .poll(() => getProjectImportUploadStatus(userId, uploadId)?.status)
      .toBe('completed');
  }
  expect(importFile).toHaveBeenCalledOnce();
});

test('project deletion aborts the preparation and frees the user capacity for the next upload', async () => {
  const identity = await upload();
  const entered = Promise.withResolvers<void>();
  let signal!: AbortSignal;
  startSourcePreparation({
    ...identity,
    importFile: async (_path, _revision, context) => {
      signal = context.signal;
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
      throw new Error('unreachable');
    },
  });
  await entered.promise;
  expect(getProjectSourcePreparation(identity.userId, identity.projectId)?.uploadId).toBe(
    identity.uploadId
  );
  expect(getProjectSourcePreparation('another-user', identity.projectId)).toBeUndefined();
  await cancelProjectSourcePreparation(identity.userId, identity.projectId);
  expect(signal.aborted).toBe(true);
  expect(getProjectImportUploadStatus(identity.userId, identity.uploadId)?.status).toBe('failed');
  const nextUploadId = randomUUID();
  await expect(
    storeProjectImportChunk({
      userId: identity.userId,
      uploadId: nextUploadId,
      chunk: 'next',
      chunkCount: 1,
      chunkIndex: 0,
    })
  ).resolves.toMatchObject({ ready: true });
  await cancelProjectImportUpload(identity.userId, nextUploadId);
});

test('deleting a queued project releases its capacity before another project finishes', async () => {
  const first = await upload();
  const second = await upload();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const firstCompletion = {
    projectId: first.projectId,
    meta: { id: first.projectId } as import('../../src/projects/types.js').SavedProjectMeta,
  };
  const queuedWork = vi.fn(async () => ({
    projectId: second.projectId,
    meta: { id: second.projectId } as import('../../src/projects/types.js').SavedProjectMeta,
  }));
  try {
    startSourcePreparation({
      ...first,
      importFile: async () => {
        entered.resolve();
        await finish.promise;
        return firstCompletion;
      },
    });
    await entered.promise;
    startSourcePreparation({ ...second, importFile: queuedWork });
    await cancelProjectSourcePreparation(second.userId, second.projectId);
    expect(getProjectImportUploadStatus(second.userId, second.uploadId)?.status).toBe('failed');
    expect(queuedWork).not.toHaveBeenCalled();
    expect(getProjectImportUploadStatus(first.userId, first.uploadId)?.status).toBe('finalizing');
  } finally {
    finish.resolve();
    await expect
      .poll(() => getProjectImportUploadStatus(first.userId, first.uploadId)?.status)
      .toBe('completed');
  }
});

test.each([
  'text',
  'binary',
] as const)('cancels an active %s import through the shared operation context', async format => {
  const userId = `import-${randomUUID()}`;
  const uploadId = randomUUID();
  const projectId = randomUUID();
  await storeProjectImportChunk({
    userId,
    uploadId,
    projectId,
    chunkIndex: 0,
    chunkCount: 1,
    chunk: format === 'text' ? JSON.stringify({ id: projectId }) : Buffer.from('synthetic backup'),
  });
  const entered = Promise.withResolvers<void>();
  const waitForCancellation = async (
    context: import('../../src/projects/sourcePreparationContext.js').SourcePreparationJobContext
  ) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) =>
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    );
    throw new Error('unreachable');
  };
  startSourcePreparation({
    userId,
    uploadId,
    importData: (_data, context) => waitForCancellation(context),
    importBinary: (_bytes, _revision, context) => waitForCancellation(context),
  });
  await entered.promise;
  await cancelProjectSourcePreparation(userId, projectId);
  expect(getProjectImportUploadStatus(userId, uploadId)?.status).toBe('failed');
});

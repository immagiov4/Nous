import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SOURCE_PREPARATION_CONFLICT_CODE } from '@shared/sourcePreparation';

import type { Request, Response } from 'express';
import { expect, test, vi } from 'vitest';
import { admitProjectImportRequest } from '../../src/projects/projectImportAdmission.js';
import {
  cancelProjectSourcePreparation,
  startSourcePreparation,
  storeProjectImportChunk,
} from '../../src/projects/projectImportChunks.js';

const createRequest = (userId: string): Request =>
  ({
    currentUser: { id: userId },
    params: {},
    query: {},
    resume: vi.fn(),
  }) as unknown as Request;

const createResponse = (): Response => {
  const response = new EventEmitter() as EventEmitter & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  response.status = vi.fn(() => response);
  response.json = vi.fn(() => response);
  response.set = vi.fn(() => response);
  return response as unknown as Response;
};

test('project import admission rejects a concurrent body before parsing it', () => {
  const firstRequest = createRequest('same-user');
  const firstResponse = createResponse();
  const firstNext = vi.fn();
  admitProjectImportRequest(firstRequest, firstResponse, firstNext);
  expect(firstNext).toHaveBeenCalledOnce();

  const duplicateRequest = createRequest('same-user');
  const duplicateResponse = createResponse();
  const duplicateNext = vi.fn();
  admitProjectImportRequest(duplicateRequest, duplicateResponse, duplicateNext);

  expect(duplicateNext).not.toHaveBeenCalled();
  expect(duplicateRequest.resume).toHaveBeenCalledOnce();
  expect(duplicateResponse.status).toHaveBeenCalledWith(429);
  expect(duplicateResponse.set).toHaveBeenCalledWith('Retry-After', '1');

  firstResponse.emit('finish');
  const retryResponse = createResponse();
  const retryNext = vi.fn();
  admitProjectImportRequest(createRequest('same-user'), retryResponse, retryNext);
  expect(retryNext).toHaveBeenCalledOnce();
  retryResponse.emit('finish');
});

test('a retry joins running preparation even while its previous HTTP request still occupies admission', async () => {
  const userId = `admission-${randomUUID()}`;
  const projectId = randomUUID();
  const uploadId = randomUUID();
  await storeProjectImportChunk({
    userId,
    projectId,
    uploadId,
    chunkCount: 1,
    chunkIndex: 0,
    chunk: '{}',
    contentKey: 'same-content',
  });
  const entered = Promise.withResolvers<void>();
  startSourcePreparation({
    userId,
    uploadId,
    importData: async (_data, context) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener('abort', () => reject(context.signal.reason), {
          once: true,
        })
      );
      throw new Error('unreachable');
    },
  });
  await entered.promise;
  const firstResponse = createResponse();
  const firstNext = vi.fn();
  admitProjectImportRequest(createRequest(userId), firstResponse, firstNext);
  try {
    expect(firstNext).toHaveBeenCalledOnce();
    const retry = createRequest(userId);
    retry.query.projectId = projectId;
    retry.query.contentKey = 'same-content';
    const retryResponse = createResponse();
    const retryNext = vi.fn();
    admitProjectImportRequest(retry, retryResponse, retryNext);
    const other = createRequest(userId);
    other.query.projectId = projectId;
    other.query.contentKey = 'different-content';
    const otherResponse = createResponse();
    const otherNext = vi.fn();
    admitProjectImportRequest(other, otherResponse, otherNext);
    expect(otherResponse.status).toHaveBeenCalledWith(409);
    expect(otherResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: SOURCE_PREPARATION_CONFLICT_CODE })
    );
    expect(otherNext).not.toHaveBeenCalled();
    expect(retryNext).not.toHaveBeenCalled();
    expect(retry.resume).toHaveBeenCalledOnce();
    expect(retryResponse.status).toHaveBeenCalledWith(202);
    expect(retryResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId, uploadStatus: 'finalizing' })
    );
  } finally {
    firstResponse.emit('finish');
    await cancelProjectSourcePreparation(userId, projectId);
  }
});

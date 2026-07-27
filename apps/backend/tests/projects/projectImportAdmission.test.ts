import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';
import { expect, test, vi } from 'vitest';

import { admitProjectImportRequest } from '../../src/projects/projectImportAdmission.js';

const createRequest = (userId: string): Request =>
  ({
    currentUser: { id: userId },
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

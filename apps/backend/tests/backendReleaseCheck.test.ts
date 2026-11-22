import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runBackendReleaseCheck } from '../src/server.js';
import {
  WorkflowDefinitionDeploymentConflictError,
  WorkflowDefinitionRegistryDeploymentConflictError,
  WorkflowReplicaOutdatedError,
} from '../src/workflows/workflowErrors.js';

const { checkRelease, closeHttp, closeRuntime, listen, recover, start, startFeedback } = vi.hoisted(
  () => ({
    checkRelease: vi.fn<() => Promise<void>>(),
    closeHttp: vi.fn<(done: (error?: Error) => void) => void>(),
    closeRuntime: vi.fn<() => Promise<void>>(),
    listen: vi.fn<(port: number, host: string, ready: () => void) => EventEmitter>(),
    recover: vi.fn(),
    start: vi.fn(),
    startFeedback: vi.fn(),
  })
);

vi.mock('../src/workflows/runtime/workflowRuntimeComposition.js', () => ({
  createWorkflowRuntimeComposition: () => ({ checkRelease, close: closeRuntime, start }),
}));
vi.mock('../src/index.js', () => ({ createApp: () => ({ listen }) }));
vi.mock('../src/projects/projectStore.js', () => ({ getProjectStore: () => ({}) }));
vi.mock('../src/projects/libraryExport.js', () => ({
  createLibraryExportApi: () => ({ recoverPendingRuns: recover }),
}));
vi.mock('../src/services/feedbackService.js', () => ({
  startFeedbackOutboxWorker: startFeedback,
  stopFeedbackOutboxWorker: vi.fn(),
}));

const fetchHealth = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BACKEND_PORT', '3301');
  vi.stubEnv('DATABASE_URL', 'postgresql://unused@127.0.0.1:1/nous-test');
  checkRelease.mockResolvedValue(undefined);
  closeRuntime.mockResolvedValue(undefined);
  closeHttp.mockImplementation(done => done());
  listen.mockImplementation((_port, _host, ready) => {
    queueMicrotask(ready);
    return Object.assign(new EventEmitter(), { close: closeHttp });
  });
  fetchHealth.mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', fetchHealth);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('a compatible candidate serves health on loopback and shuts down without starting workers', async () => {
  await expect(runBackendReleaseCheck()).resolves.toBe(0);
  expect(listen).toHaveBeenCalledWith(3301, '127.0.0.1', expect.any(Function));
  expect(fetchHealth).toHaveBeenCalledWith('http://127.0.0.1:3301/health');
  expect(closeHttp).toHaveBeenCalledOnce();
  expect(closeRuntime).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(startFeedback).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});

test.each([
  new WorkflowDefinitionDeploymentConflictError('lesson-artifact-draft'),
  new WorkflowDefinitionRegistryDeploymentConflictError('nous-reader'),
])('an incompatible registry (%j) rejects before opening a listener', async error => {
  checkRelease.mockRejectedValue(error);
  await expect(runBackendReleaseCheck()).resolves.toBe(65);
  expect(listen).not.toHaveBeenCalled();
  expect(closeRuntime).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('[Backend] Candidate release rejected.', {
    errorType: error.name,
  });
});

test('a database outage produces a retryable status without logging the connection message', async () => {
  checkRelease.mockRejectedValue(new Error('postgres://private-details'));
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(listen).not.toHaveBeenCalled();
  expect(closeRuntime).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('[Backend] Candidate check failed.', {
    errorType: 'Error',
  });
});

test('an outdated replica fails the check with a retryable status', async () => {
  checkRelease.mockRejectedValue(new WorkflowReplicaOutdatedError());
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(listen).not.toHaveBeenCalled();
});

test('an unhealthy candidate closes the listener and produces a retryable status', async () => {
  fetchHealth.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(closeHttp).toHaveBeenCalledOnce();
  expect(closeRuntime).toHaveBeenCalledOnce();
});

test('a candidate unable to bind returns a retryable status and closes its workflow runtime', async () => {
  listen.mockImplementation(() => {
    const listener = new EventEmitter();
    queueMicrotask(() => listener.emit('error', new Error('Cannot bind')));
    return listener;
  });
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(fetchHealth).not.toHaveBeenCalled();
  expect(closeRuntime).toHaveBeenCalledOnce();
});

test('a loopback fetch failure closes both resources and produces a retryable status', async () => {
  fetchHealth.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(closeHttp).toHaveBeenCalledOnce();
  expect(closeRuntime).toHaveBeenCalledOnce();
});

test('an HTTP shutdown failure produces a retryable status', async () => {
  closeHttp.mockImplementation(done => done(new Error('HTTP shutdown failed')));
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(closeRuntime).toHaveBeenCalledOnce();
});

test('failure to close the database connection produces a retryable status', async () => {
  closeRuntime.mockRejectedValue(new Error('Connection lost'));
  await expect(runBackendReleaseCheck()).resolves.toBe(1);
  expect(closeHttp).toHaveBeenCalledOnce();
});

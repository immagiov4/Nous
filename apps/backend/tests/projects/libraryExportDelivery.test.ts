import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_ARCHIVE_FORMAT,
  LIBRARY_EXPORT_RETENTION_ERROR_CODE,
} from '@shared/libraryExportContract';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LibraryExportCoordinator } from '../../src/projects/libraryExportCoordinator.js';
import { createLibraryExportDelivery } from '../../src/projects/libraryExportDelivery.js';
import { LibraryExportWorkspace } from '../../src/projects/libraryExportWorkspace.js';
import { MemoryLibraryExportRunStore } from '../helpers/memoryLibraryExportRunStore.js';

const TEST_TIME = Date.parse('2026-09-07T12:00:00Z');
const TEST_RETENTION_MS = 1_000;
const TEST_CLEANUP_INTERVAL_MS = 200;
const owner = 'export-owner';
let root: string;
let runId: string;
let store: MemoryLibraryExportRunStore;
let workspace: LibraryExportWorkspace;
let coordinator: LibraryExportCoordinator;
let delivery: ReturnType<typeof createLibraryExportDelivery>;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(TEST_TIME);
  root = await mkdtemp(join(tmpdir(), 'nous-export-delivery-'));
  runId = randomUUID();
  store = new MemoryLibraryExportRunStore();
  workspace = new LibraryExportWorkspace(root);
  coordinator = new LibraryExportCoordinator(1);
  await store.createRun({
    id: runId,
    userId: owner,
    correlationId: randomUUID(),
    status: 'running',
    phase: 'preparing',
    bytesWritten: 0,
    expectedProjects: [],
    folders: [],
    placements: [],
  });
  const archive = await workspace.createLibraryArchive(
    runId,
    {
      archiveVersion: 2,
      format: LIBRARY_ARCHIVE_FORMAT,
      projects: [],
      folders: [],
      placements: [],
    },
    []
  );
  await store.markCompleted(runId, archive);
  delivery = createLibraryExportDelivery({
    coordinator,
    workspace,
    runStore: store,
    config: {
      executionsGlobal: 1,
      retentionMs: TEST_RETENTION_MS,
      cleanupIntervalMs: TEST_CLEANUP_INTERVAL_MS,
    },
  });
});

afterEach(async () => {
  await delivery.close();
  await coordinator.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(root, { force: true, recursive: true });
});

const advancePastRetention = () =>
  vi.mocked(Date.now).mockReturnValue(TEST_TIME + TEST_RETENTION_MS);
const admitDownload = async () => {
  const token = await delivery.createDownloadAccess(owner, runId);
  if (!token) throw new Error('Expected a valid download token.');
  const download = await delivery.getDownload(runId, token);
  if (!download) throw new Error('Expected an admitted download.');
  return download;
};

test('retains overlapping readers until the last response and releases each response once', async () => {
  const first = await admitDownload();
  const second = await admitDownload();
  const markDownloaded = vi.spyOn(store, 'markDownloaded');
  advancePastRetention();
  await delivery.cleanupPendingRuns();
  expect(store.run?.status).toBe('completed');
  await first.finish(true);
  await first.finish(false);
  expect(markDownloaded).toHaveBeenCalledTimes(1);
  expect(store.run?.status).toBe('downloaded');
  expect(await readFile(second.archivePath)).not.toHaveLength(0);
  await delivery.cleanupPendingRuns();
  expect(store.cleanupCompleted).toBe(false);
  await second.finish(false);
  await expect(readFile(second.archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(store.cleanupCompleted).toBe(true);
});

test('preserves both issued tickets across the first completion and a process restart', async () => {
  const firstToken = await delivery.createDownloadAccess(owner, runId);
  const secondToken = await delivery.createDownloadAccess(owner, runId);
  expect(firstToken).not.toBe(secondToken);
  const first = await delivery.getDownload(runId, firstToken ?? '');
  expect(first).not.toBeNull();
  await first?.finish(true);
  expect(store.run?.status).toBe('downloaded');
  expect(store.cleanupCompleted).toBe(false);
  await expect(readFile(workspace.getLibraryArchivePath(runId))).resolves.not.toHaveLength(0);
  await delivery.close();
  await coordinator.close();
  coordinator = new LibraryExportCoordinator(1);
  delivery = createLibraryExportDelivery({
    coordinator,
    workspace,
    runStore: store,
    config: {
      executionsGlobal: 1,
      retentionMs: TEST_RETENTION_MS,
      cleanupIntervalMs: TEST_CLEANUP_INTERVAL_MS,
    },
  });
  await delivery.start();
  expect(store.cleanupCompleted).toBe(false);
  expect(await delivery.createDownloadAccess(owner, runId)).toBeNull();
  expect(await delivery.getDownload(runId, firstToken ?? '')).toBeNull();
  const second = await delivery.getDownload(runId, secondToken ?? '');
  expect(second).not.toBeNull();
  expect(await delivery.getDownload(runId, secondToken ?? '')).toBeNull();
  await second?.finish(true);
  expect(store.cleanupCompleted).toBe(true);
});

test('reclaims a delivered archive when its remaining issued ticket reaches the original deadline', async () => {
  const first = await admitDownload();
  const token = await delivery.createDownloadAccess(owner, runId);
  await first.finish(true);
  expect(store.cleanupCompleted).toBe(false);
  advancePastRetention();
  await delivery.cleanupPendingRuns();
  expect(store.cleanupCompleted).toBe(true);
  expect(await delivery.getDownload(runId, token ?? '')).toBeNull();
});

test('protects a reader during asynchronous token claim and integrity verification', async () => {
  const token = await delivery.createDownloadAccess(owner, runId);
  const claimEntered = Promise.withResolvers<void>();
  const claimReleased = Promise.withResolvers<void>();
  const verificationEntered = Promise.withResolvers<void>();
  const verificationReleased = Promise.withResolvers<void>();
  const claim = store.claimDownload.bind(store);
  vi.spyOn(store, 'claimDownload').mockImplementation(async (...args) => {
    const run = await claim(...args);
    claimEntered.resolve();
    await claimReleased.promise;
    return run;
  });
  const verify = workspace.verifyLibraryArchive.bind(workspace);
  vi.spyOn(workspace, 'verifyLibraryArchive').mockImplementation(async (...args) => {
    verificationEntered.resolve();
    await verificationReleased.promise;
    return verify(...args);
  });
  const downloading = delivery.getDownload(runId, token ?? '');
  await claimEntered.promise;
  advancePastRetention();
  const cleaning = delivery.cleanupPendingRuns();
  claimReleased.resolve();
  await verificationEntered.promise;
  await cleaning;
  expect(store.run?.status).toBe('completed');
  expect(store.cleanupCompleted).toBe(false);
  verificationReleased.resolve();
  const download = await downloading;
  expect(download).not.toBeNull();
  await download?.finish(false);
  expect(store.run?.errorCode).toBe(LIBRARY_EXPORT_RETENTION_ERROR_CODE);
  expect(store.cleanupCompleted).toBe(true);
});

test('rejects a new reader when expiry already owns the state transition', async () => {
  const token = await delivery.createDownloadAccess(owner, runId);
  advancePastRetention();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const cancel = store.cancelExpiredRun.bind(store);
  vi.spyOn(store, 'cancelExpiredRun').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await released.promise;
    return cancel(...args);
  });
  const cleaning = delivery.cleanupPendingRuns();
  await entered.promise;
  const claim = vi.spyOn(store, 'claimDownload');
  const downloading = delivery.getDownload(runId, token ?? '');
  expect(claim).not.toHaveBeenCalled();
  released.resolve();
  await cleaning;
  expect(await downloading).toBeNull();
  expect(coordinator.hasReaders(runId)).toBe(false);
  expect(store.run?.status).toBe('cancelled');
});

test('an interrupted response remains retryable until retention expires', async () => {
  const first = await admitDownload();
  await first.finish(false);
  expect(store.run?.status).toBe('completed');
  expect(coordinator.hasReaders(runId)).toBe(false);
  const second = await admitDownload();
  await second.finish(true);
  expect(store.cleanupCompleted).toBe(true);
});

test('a token cannot extend retention or admit new downloads while another reader is active', async () => {
  const first = await admitDownload();
  const token = await delivery.createDownloadAccess(owner, runId);
  advancePastRetention();
  expect(await delivery.createDownloadAccess(owner, runId)).toBeNull();
  expect(await delivery.getDownload(runId, token ?? '')).toBeNull();
  expect(store.run?.status).toBe('completed');
  await first.finish(false);
  expect(store.run?.status).toBe('cancelled');
});

test('failed file removal remains durably pending and succeeds on the next cleanup', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(workspace, 'removeRun').mockRejectedValueOnce(
    new Error('Temporary file access failure.')
  );
  advancePastRetention();
  await delivery.expireRun(runId);
  expect(store.run?.status).toBe('cancelled');
  expect(store.cleanupCompleted).toBe(false);
  expect(error).toHaveBeenCalled();
  await delivery.cleanupPendingRuns();
  expect(store.cleanupCompleted).toBe(true);
});

test('integrity exceptions release the reader so expired files can be reclaimed', async () => {
  const token = await delivery.createDownloadAccess(owner, runId);
  vi.spyOn(workspace, 'verifyLibraryArchive').mockRejectedValueOnce(new Error('Read failed.'));
  await expect(delivery.getDownload(runId, token ?? '')).rejects.toThrow('Read failed.');
  expect(coordinator.hasReaders(runId)).toBe(false);
  advancePastRetention();
  await delivery.cleanupPendingRuns();
  expect(store.cleanupCompleted).toBe(true);
});

test('periodic cleanup does not overlap and stops when closed', async () => {
  vi.useFakeTimers();
  await delivery.start();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const list = vi.spyOn(store, 'listExpiredRunIds').mockImplementation(async () => {
    entered.resolve();
    await released.promise;
    return [];
  });
  await vi.advanceTimersByTimeAsync(TEST_CLEANUP_INTERVAL_MS);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(TEST_CLEANUP_INTERVAL_MS * 2);
  expect(list).toHaveBeenCalledTimes(1);
  released.resolve();
  await delivery.close();
  await vi.advanceTimersByTimeAsync(TEST_CLEANUP_INTERVAL_MS);
  expect(list).toHaveBeenCalledTimes(1);
});

test('shutdown releases an admission reader while archive verification is pending', async () => {
  const token = await delivery.createDownloadAccess(owner, runId);
  const entered = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<boolean>();
  vi.spyOn(workspace, 'verifyLibraryArchive').mockImplementation(() => {
    entered.resolve();
    return verified.promise;
  });
  const failed = vi.spyOn(store, 'markFailed');
  const downloading = delivery.getDownload(runId, token ?? '');
  const rejected = expect(downloading).rejects.toThrow();
  await entered.promise;
  expect(coordinator.hasReaders(runId)).toBe(true);
  delivery.close();
  await rejected;
  expect(coordinator.hasReaders(runId)).toBe(false);
  verified.resolve(false);
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
});

test('shutdown lets an already admitted response finish without deleting its files', async () => {
  const download = await admitDownload();
  const remove = vi.spyOn(workspace, 'removeRun');
  delivery.close();
  expect(coordinator.hasReaders(runId)).toBe(true);
  await download.finish(true);
  expect(coordinator.hasReaders(runId)).toBe(false);
  expect(store.run?.status).toBe('downloaded');
  expect(remove).not.toHaveBeenCalled();
});

test.each([
  'access',
  'download',
] as const)('stops pending %s admission before ticket mutation during shutdown', async admission => {
  const token = await delivery.createDownloadAccess(owner, runId);
  advancePastRetention();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const cancelExpired = store.cancelExpiredRun.bind(store);
  vi.spyOn(store, 'cancelExpiredRun').mockImplementation(async (...args) => {
    entered.resolve();
    await released.promise;
    return cancelExpired(...args);
  });
  const authorize = vi.spyOn(store, 'authorizeDownload');
  const claim = vi.spyOn(store, 'claimDownload');
  const pending =
    admission === 'access'
      ? delivery.createDownloadAccess(owner, runId)
      : delivery.getDownload(runId, token ?? '');
  let rejected = false;
  const settled = pending.catch(() => {
    rejected = true;
  });
  await entered.promise;
  delivery.close();
  try {
    await vi.waitFor(() => expect(rejected).toBe(true));
  } finally {
    released.resolve();
    await settled;
  }
  expect(authorize).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
  expect(coordinator.hasReaders(runId)).toBe(false);
});

test('closes without waiting for a pending cleanup query or starting later cleanup mutations', async () => {
  const entered = Promise.withResolvers<void>();
  const listed = Promise.withResolvers<string[]>();
  vi.spyOn(store, 'listExpiredRunIds').mockImplementation(() => {
    entered.resolve();
    return listed.promise;
  });
  const cancel = vi.spyOn(store, 'cancelExpiredRun');
  const remove = vi.spyOn(workspace, 'removeRun');
  const cleaning = delivery.cleanupPendingRuns();
  await entered.promise;
  let closed = false;
  const closing = Promise.resolve(delivery.close()).then(() => {
    closed = true;
  });
  try {
    await vi.waitFor(() => expect(closed).toBe(true));
  } finally {
    listed.resolve([runId]);
    await Promise.all([closing, cleaning]);
  }
  expect(cancel).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

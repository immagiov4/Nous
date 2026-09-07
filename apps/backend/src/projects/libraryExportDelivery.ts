import { createHash, randomUUID } from 'node:crypto';
import { LIBRARY_ARCHIVE_EXTENSION } from '@shared/libraryExportContract';

import type { LibraryExportConfig } from './libraryExportConfig.js';
import type { LibraryExportCoordinator } from './libraryExportCoordinator.js';
import type { LibraryExportRunStore } from './libraryExportRunStore.js';
import type { LibraryExportWorkspace } from './libraryExportWorkspace.js';

export interface LibraryExportDownload {
  archiveBytes: number;
  archivePath: string;
  filename: string;
  userId: string;
  finish(delivered: boolean): Promise<void>;
}

interface DeliveryDependencies {
  config: LibraryExportConfig;
  coordinator: LibraryExportCoordinator;
  runStore: LibraryExportRunStore;
  workspace: LibraryExportWorkspace;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const DOWNLOAD_FILENAME = `nous-library-backup${LIBRARY_ARCHIVE_EXTENSION}`;

/** Owns retention and file lifetime through every admitted HTTP response. */
export const createLibraryExportDelivery = ({
  config,
  coordinator,
  runStore,
  workspace,
}: DeliveryDependencies) => {
  const cutoff = () => new Date(Date.now() - config.retentionMs);
  let timer: ReturnType<typeof setInterval> | undefined;
  let cleanup: Promise<void> | undefined;

  const removeRun = async (runId: string): Promise<void> => {
    await workspace.removeRun(runId);
    await runStore.markCleanupCompleted(runId);
  };

  const expireLocked = async (runId: string): Promise<boolean> => {
    if (coordinator.owns(runId) || coordinator.hasReaders(runId)) return false;
    if (!(await runStore.cancelExpiredRun(runId, cutoff()))) return false;
    await removeRun(runId).catch(error => logCleanupFailure(error, runId));
    return true;
  };

  const expireRun = (runId: string): Promise<boolean> =>
    coordinator.exclusively(runId, () => expireLocked(runId));

  const cleanupRun = (runId: string): Promise<void> =>
    coordinator.exclusively(runId, async () => {
      if (coordinator.owns(runId) || coordinator.hasReaders(runId)) return;
      await removeRun(runId);
    });

  const logCleanupFailure = (error: unknown, runId?: string): void => {
    console.error('[LibraryExport] Archive cleanup failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      exportRunId: runId,
    });
  };

  const sweep = async (): Promise<void> => {
    for (const runId of await runStore.listExpiredRunIds(cutoff())) {
      await expireRun(runId).catch(error => logCleanupFailure(error, runId));
    }
    for (const runId of await runStore.listPendingCleanupRunIds()) {
      await cleanupRun(runId).catch(error => logCleanupFailure(error, runId));
    }
  };

  const cleanupPendingRuns = (): Promise<void> => {
    if (!cleanup)
      cleanup = sweep().finally(() => {
        cleanup = undefined;
      });
    return cleanup;
  };

  const createDownloadAccess = (userId: string, runId: string): Promise<string | null> =>
    coordinator.exclusively(runId, async () => {
      const run = await runStore.getRun(userId, runId);
      if (!run || run.status !== 'completed') return null;
      await expireLocked(runId);
      const token = randomUUID();
      return (await runStore.authorizeDownload(userId, runId, hashToken(token), cutoff()))
        ? token
        : null;
    });

  const getDownload = async (
    runId: string,
    token: string
  ): Promise<LibraryExportDownload | null> => {
    const admitted = await coordinator.exclusively(runId, async () => {
      await expireLocked(runId);
      const release = coordinator.acquireReader(runId);
      try {
        const run = await runStore.claimDownload(runId, hashToken(token), cutoff());
        if (run?.archiveBytes && run.archiveSha256)
          return { run, release, archiveBytes: run.archiveBytes, archiveSha256: run.archiveSha256 };
        release();
        return null;
      } catch (error) {
        release();
        throw error;
      }
    });
    if (!admitted) return null;
    const { run, release, archiveBytes, archiveSha256 } = admitted;
    let finished: Promise<void> | undefined;
    const finish = (delivered: boolean): Promise<void> => {
      finished ??= coordinator.exclusively(runId, async () => {
        try {
          if (delivered) await runStore.markDownloaded(runId);
        } finally {
          release();
        }
        if (coordinator.hasReaders(runId) || coordinator.owns(runId)) return;
        const current = await runStore.getRun(run.userId, runId);
        if (current?.status === 'downloaded' || current?.status === 'cancelled')
          await removeRun(runId);
        else await expireLocked(runId);
      });
      return finished;
    };
    try {
      if (
        !(await workspace.verifyLibraryArchive(runId, {
          bytes: archiveBytes,
          sha256: archiveSha256,
        }))
      ) {
        await coordinator.exclusively(runId, () =>
          runStore.markFailed(runId, {
            code: 'LIBRARY_EXPORT_INTEGRITY_FAILED',
            detail: 'The completed library archive no longer matches its persisted checksum.',
            phase: 'integrity-check',
          })
        );
        await finish(false);
        return null;
      }
      return {
        archiveBytes,
        archivePath: workspace.getLibraryArchivePath(runId),
        filename: DOWNLOAD_FILENAME,
        userId: run.userId,
        finish,
      };
    } catch (error) {
      await finish(false);
      throw error;
    }
  };

  return {
    cleanupPendingRuns,
    cleanupRun,
    createDownloadAccess,
    expireRun,
    getDownload,
    async start() {
      await cleanupPendingRuns();
      timer ??= setInterval(() => {
        void cleanupPendingRuns().catch(error => logCleanupFailure(error));
      }, config.cleanupIntervalMs);
      timer.unref();
    },
    async close() {
      clearInterval(timer);
      timer = undefined;
      await cleanup;
    },
  };
};

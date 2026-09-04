import { createHash, randomUUID } from 'node:crypto';
import {
  findLibraryOrganizationIssue,
  getLibraryArchiveProjectPath,
  LIBRARY_ARCHIVE_EXTENSION,
  LIBRARY_ARCHIVE_FORMAT,
  LIBRARY_ARCHIVE_VERSION,
  type LibraryArchiveManifest,
  type LibraryExportPhase,
  type LibraryExportProgress,
} from '@shared/libraryExportContract';
import {
  createProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import { collectProjectAssetReferences } from '@shared/projectBackupAssets';

import type {
  LibraryExportProjectCheckpoint,
  LibraryExportRunRecord,
  LibraryExportRunStore,
} from './libraryExportRunStore.js';
import { LibraryExportWorkspace } from './libraryExportWorkspace.js';
import type { ProjectAssetReader } from './projectAssetReader.js';
import type { ProjectStore } from './types.js';

export interface LibraryExportDownload {
  archiveBytes: number;
  archivePath: string;
  filename: string;
  userId: string;
}

export interface LibraryExportApi {
  completeDownload(userId: string, runId: string): Promise<void>;
  createDownloadAccess(userId: string, runId: string): Promise<string | null>;
  getDownload(runId: string, accessToken: string): Promise<LibraryExportDownload | null>;
  getStatus(userId: string, runId: string): Promise<LibraryExportProgress | null>;
  recoverPendingRuns(): Promise<void>;
  startOrResume(userId: string, correlationId: string): Promise<LibraryExportProgress>;
}

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Library export is unavailable.'));

export const unavailableLibraryExportApi: LibraryExportApi = {
  completeDownload: unavailable,
  createDownloadAccess: unavailable,
  getDownload: unavailable,
  getStatus: unavailable,
  recoverPendingRuns: unavailable,
  startOrResume: unavailable,
};

interface CreateLibraryExportApiDependencies {
  archiveWorkspace?: LibraryExportWorkspace;
  assetReader: ProjectAssetReader;
  projectStore: ProjectStore;
  runStore: LibraryExportRunStore;
}

const PROJECT_ARCHIVE_LIMITS = {
  invalidArchiveMessage: 'Archivio del corso non valido.',
  maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
  maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
};
const LIBRARY_EXPORT_FILENAME = `nous-library-backup${LIBRARY_ARCHIVE_EXTENSION}`;

const toProgress = (run: LibraryExportRunRecord): LibraryExportProgress => ({
  ...(run.archiveBytes === undefined ? {} : { archiveBytes: run.archiveBytes }),
  bytesWritten: run.bytesWritten,
  completedProjectCount: run.checkpoints.length,
  correlationId: run.correlationId,
  ...(run.currentProjectId ? { currentProjectId: run.currentProjectId } : {}),
  ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  ...(run.errorPhase ? { errorPhase: run.errorPhase } : {}),
  phase: run.phase,
  projectCount: run.expectedProjects.length,
  runId: run.id,
  status: run.status,
});

const assertCompleteOrganization = (
  projectIds: readonly string[],
  folders: LibraryExportRunRecord['folders'],
  placements: LibraryExportRunRecord['placements']
): void => {
  if (projectIds.length === 0 || findLibraryOrganizationIssue(projectIds, folders, placements)) {
    throw new Error('La struttura della libreria non contiene un posizionamento per ogni corso.');
  }
};

const getErrorCode = (phase: LibraryExportPhase): string => {
  if (phase === 'project-archive') return 'LIBRARY_EXPORT_PROJECT_FAILED';
  if (phase === 'integrity-check') return 'LIBRARY_EXPORT_INTEGRITY_FAILED';
  return 'LIBRARY_EXPORT_ARCHIVE_FAILED';
};

const getErrorType = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

const hashDownloadAccessToken = (accessToken: string): string =>
  createHash('sha256').update(accessToken).digest('hex');

export const createLibraryExportApi = ({
  archiveWorkspace = new LibraryExportWorkspace(),
  assetReader,
  projectStore,
  runStore,
}: CreateLibraryExportApiDependencies): LibraryExportApi => {
  const activeRuns = new Map<string, Promise<void>>();

  const createProjectArchive = async (userId: string, projectId: string): Promise<Uint8Array> => {
    const project = await projectStore.exportProject(userId, projectId);
    if (!project) throw new Error('Project selected for library export was not found.');
    const assets = [];
    for (const ref of collectProjectAssetReferences(project)) {
      const asset = await assetReader.readActive({ assetId: ref.id, projectId, userId });
      if (!asset) throw new Error('A project asset selected for library export was not found.');
      assets.push({ bytes: asset.bytes, ref });
    }
    const cover = await projectStore.loadProjectCover(userId, projectId);
    return createProjectBackupArchive({ assets, cover, project }, PROJECT_ARCHIVE_LIMITS);
  };

  const execute = async (runId: string, userId: string): Promise<void> => {
    const startedAt = Date.now();
    let phase: LibraryExportPhase = 'preparing';
    let currentProjectId: string | undefined;
    try {
      let run = await runStore.getRun(userId, runId);
      if (!run) throw new Error('Library export run was not found.');
      const checkpointByProjectId = new Map(
        run.checkpoints.map(checkpoint => [checkpoint.projectId, checkpoint])
      );

      for (const [projectIndex, project] of run.expectedProjects.entries()) {
        currentProjectId = project.id;
        phase = 'project-archive';
        await runStore.markRunning(runId, phase, currentProjectId);
        const checkpoint = checkpointByProjectId.get(project.id);
        if (checkpoint && (await archiveWorkspace.matchesProjectCheckpoint(runId, checkpoint))) {
          continue;
        }
        const projectArchive = await createProjectArchive(userId, project.id);
        const archive = await archiveWorkspace.writeProjectArchive(
          runId,
          project.path,
          projectArchive
        );
        const nextCheckpoint: LibraryExportProjectCheckpoint = {
          archiveBytes: archive.bytes,
          archivePath: project.path,
          archiveSha256: archive.sha256,
          projectId: project.id,
          projectIndex,
        };
        await runStore.checkpointProject(runId, nextCheckpoint);
        checkpointByProjectId.set(project.id, nextCheckpoint);
        console.info('[LibraryExport] Project checkpoint completed.', {
          archiveBytes: archive.bytes,
          correlationId: run.correlationId,
          elapsedMs: Date.now() - startedAt,
          exportRunId: runId,
          outcome: 'completed',
          phase,
          projectId: project.id,
          userId,
        });
      }

      run = await runStore.getRun(userId, runId);
      if (!run || run.checkpoints.length !== run.expectedProjects.length) {
        throw new Error('Library export checkpoints are incomplete.');
      }
      const checkpoints = run.checkpoints.slice().sort((a, b) => a.projectIndex - b.projectIndex);
      const manifest: LibraryArchiveManifest = {
        archiveVersion: LIBRARY_ARCHIVE_VERSION,
        folders: run.folders,
        format: LIBRARY_ARCHIVE_FORMAT,
        placements: run.placements,
        projects: run.expectedProjects,
      };
      currentProjectId = undefined;
      phase = 'library-archive';
      await runStore.markRunning(runId, phase);
      const archive = await archiveWorkspace.createLibraryArchive(runId, manifest, checkpoints);
      phase = 'integrity-check';
      await runStore.markRunning(runId, phase);
      if (!(await archiveWorkspace.verifyLibraryArchive(runId, archive))) {
        throw new Error('Library export archive checksum verification failed.');
      }
      await runStore.markCompleted(runId, archive);
      console.info('[LibraryExport] Archive completed.', {
        archiveBytes: archive.bytes,
        correlationId: run.correlationId,
        elapsedMs: Date.now() - startedAt,
        exportRunId: runId,
        outcome: 'completed',
        phase: 'ready',
        userId,
      });
    } catch {
      const code = getErrorCode(phase);
      const detail = 'Library export failed.';
      await runStore.markFailed(runId, { code, detail, phase });
      const run = await runStore.getRun(userId, runId);
      console.error('[LibraryExport] Archive failed.', {
        bytesWritten: run?.bytesWritten ?? 0,
        code,
        correlationId: run?.correlationId,
        elapsedMs: Date.now() - startedAt,
        exportRunId: runId,
        outcome: 'failed',
        phase,
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
        userId,
      });
    }
  };

  const runInBackground = (run: LibraryExportRunRecord, outcome: 'resumed' | 'started'): void => {
    if (activeRuns.has(run.id)) return;
    console.info('[LibraryExport] Run scheduled.', {
      correlationId: run.correlationId,
      exportRunId: run.id,
      outcome,
      phase: run.phase,
      userId: run.userId,
    });
    const promise = execute(run.id, run.userId)
      .catch(error => {
        console.error('[LibraryExport] Background persistence failed.', {
          errorType: getErrorType(error),
          exportRunId: run.id,
          outcome: 'failed',
          userId: run.userId,
        });
      })
      .finally(() => activeRuns.delete(run.id));
    activeRuns.set(run.id, promise);
  };

  const cleanupRun = async (runId: string): Promise<void> => {
    await archiveWorkspace.removeRun(runId);
    await runStore.markCleanupCompleted(runId);
  };

  const cleanupPendingRuns = async (): Promise<void> => {
    for (const runId of await runStore.listPendingCleanupRunIds()) {
      try {
        await cleanupRun(runId);
      } catch (error) {
        console.error('[LibraryExport] Delivered run cleanup failed.', {
          errorType: getErrorType(error),
          exportRunId: runId,
          outcome: 'cleanup-failed',
        });
      }
    }
  };

  return {
    async startOrResume(userId, correlationId) {
      await cleanupPendingRuns();
      let run = await runStore.findUndeliveredRun(userId);
      let runOutcome: 'resumed' | 'started' = 'resumed';
      let snapshotAfterFailure: Awaited<
        ReturnType<ProjectStore['readLibraryExportSnapshot']>
      > | null = null;
      if (run?.status === 'failed') {
        snapshotAfterFailure = await projectStore.readLibraryExportSnapshot(userId);
        const currentProjectIds = new Set(snapshotAfterFailure.projects.map(project => project.id));
        if (run.expectedProjects.some(project => !currentProjectIds.has(project.id))) {
          await runStore.markCancelled(run.id, {
            code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_UNAVAILABLE',
            detail: 'An expected project was unavailable when the export resumed.',
            phase: run.errorPhase ?? run.phase,
          });
          try {
            await cleanupRun(run.id);
          } catch (error) {
            console.error('[LibraryExport] Cancelled run cleanup failed.', {
              errorType: getErrorType(error),
              exportRunId: run.id,
              outcome: 'cleanup-failed',
              userId,
            });
          }
          run = null;
        }
      }
      if (!run) {
        const { folders, placements, projects } =
          snapshotAfterFailure ?? (await projectStore.readLibraryExportSnapshot(userId));
        assertCompleteOrganization(
          projects.map(project => project.id),
          folders,
          placements
        );
        const requestedRunId = randomUUID();
        run = await runStore.createRun({
          bytesWritten: 0,
          correlationId,
          expectedProjects: projects.map((project, index) => ({
            id: project.id,
            path: getLibraryArchiveProjectPath(project.id, index),
            title: project.title,
          })),
          folders,
          id: requestedRunId,
          phase: 'preparing',
          placements,
          status: 'running',
          userId,
        });
        runOutcome = run.id === requestedRunId ? 'started' : 'resumed';
      } else if (run.status === 'running' && !activeRuns.has(run.id)) {
        await runStore.markFailed(run.id, {
          code: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
          detail: 'The backend process stopped before the library export completed.',
          phase: run.phase,
        });
        run = (await runStore.getRun(userId, run.id)) ?? run;
      }

      if (run.status === 'completed') return toProgress(run);
      if (run.status === 'failed') {
        await runStore.markRunning(run.id, 'preparing');
        run = (await runStore.getRun(userId, run.id)) ?? run;
      }
      runInBackground(run, runOutcome);
      const current = (await runStore.getRun(userId, run.id)) ?? run;
      return toProgress(current);
    },

    async getStatus(userId, runId) {
      let run = await runStore.getRun(userId, runId);
      if (!run) return null;
      if (run.status === 'running' && !activeRuns.has(run.id)) {
        await runStore.markFailed(run.id, {
          code: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
          detail: 'The backend process stopped before the library export completed.',
          phase: run.phase,
        });
        await runStore.markRunning(run.id, 'preparing');
        run = (await runStore.getRun(userId, run.id)) ?? run;
        runInBackground(run, 'resumed');
        run = (await runStore.getRun(userId, run.id)) ?? run;
      }
      return toProgress(run);
    },

    async createDownloadAccess(userId, runId) {
      const run = await runStore.getRun(userId, runId);
      if (!run || run.status !== 'completed') return null;
      const accessToken = randomUUID();
      return (await runStore.authorizeDownload(userId, runId, hashDownloadAccessToken(accessToken)))
        ? accessToken
        : null;
    },

    async getDownload(runId, accessToken) {
      const run = await runStore.claimDownload(runId, hashDownloadAccessToken(accessToken));
      if (!run || !run.archiveBytes || !run.archiveSha256) return null;
      if (
        !(await archiveWorkspace.verifyLibraryArchive(runId, {
          bytes: run.archiveBytes,
          sha256: run.archiveSha256,
        }))
      ) {
        await runStore.markFailed(runId, {
          code: 'LIBRARY_EXPORT_INTEGRITY_FAILED',
          detail: 'The completed library archive no longer matches its persisted checksum.',
          phase: 'integrity-check',
        });
        return null;
      }
      return {
        archiveBytes: run.archiveBytes,
        archivePath: archiveWorkspace.getLibraryArchivePath(runId),
        filename: LIBRARY_EXPORT_FILENAME,
        userId: run.userId,
      };
    },

    async recoverPendingRuns() {
      await cleanupPendingRuns();
      for (const run of await runStore.listRunningRuns()) {
        try {
          await runStore.markFailed(run.id, {
            code: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
            detail: 'The backend process stopped before the library export completed.',
            phase: run.phase,
          });
          await runStore.markRunning(run.id, 'preparing');
          runInBackground(run, 'resumed');
        } catch (error) {
          console.error('[LibraryExport] Pending run recovery failed.', {
            errorType: getErrorType(error),
            exportRunId: run.id,
            outcome: 'recovery-failed',
            userId: run.userId,
          });
        }
      }
    },

    async completeDownload(userId, runId) {
      const run = await runStore.getRun(userId, runId);
      if (!run || run.status !== 'completed') return;
      await runStore.markDownloaded(runId);
      await cleanupRun(runId);
    },
  };
};

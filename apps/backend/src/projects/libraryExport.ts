import { randomUUID } from 'node:crypto';
import {
  findLibraryOrganizationIssue,
  getLibraryArchiveProjectPath,
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
  type ProjectBackupAssetInput,
} from '@shared/projectBackupArchive';
import { collectProjectAssetReferences } from '@shared/projectBackupAssets';
import { type LibraryExportConfig, readLibraryExportConfig } from './libraryExportConfig.js';
import { LibraryExportCoordinator } from './libraryExportCoordinator.js';
import {
  createLibraryExportDelivery,
  type LibraryExportDownload,
} from './libraryExportDelivery.js';
import { createLibraryExportOperations } from './libraryExportOperations.js';
import type {
  LibraryExportExpectedProject,
  LibraryExportProjectCheckpoint,
  LibraryExportRunProgressRecord,
  LibraryExportRunRecord,
  LibraryExportRunStore,
} from './libraryExportRunStore.js';
import { LibraryExportWorkspace } from './libraryExportWorkspace.js';
import type { ProjectAssetReader } from './projectAssetReader.js';
import type { ProjectStore } from './types.js';

export interface LibraryExportApi {
  close(): Promise<void>;
  createDownloadAccess(userId: string, runId: string): Promise<string | null>;
  getDownload(runId: string, accessToken: string): Promise<LibraryExportDownload | null>;
  getStatus(userId: string, runId: string): Promise<LibraryExportProgress | null>;
  recoverPendingRuns(): Promise<void>;
  startOrResume(userId: string, correlationId: string): Promise<LibraryExportProgress>;
}

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Library export is unavailable.'));

export const unavailableLibraryExportApi: LibraryExportApi = {
  close: unavailable,
  createDownloadAccess: unavailable,
  getDownload: unavailable,
  getStatus: unavailable,
  recoverPendingRuns: unavailable,
  startOrResume: unavailable,
};

interface CreateLibraryExportApiDependencies {
  config?: LibraryExportConfig;
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

const toProgress = (
  run: LibraryExportRunRecord | LibraryExportRunProgressRecord
): LibraryExportProgress => ({
  ...(run.archiveBytes === undefined ? {} : { archiveBytes: run.archiveBytes }),
  bytesWritten: run.bytesWritten,
  completedProjectCount: 'checkpoints' in run ? run.checkpoints.length : run.completedProjectCount,
  correlationId: run.correlationId,
  ...(run.currentProjectId ? { currentProjectId: run.currentProjectId } : {}),
  ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  ...(run.errorPhase ? { errorPhase: run.errorPhase } : {}),
  phase: run.phase,
  projectCount: 'expectedProjects' in run ? run.expectedProjects.length : run.projectCount,
  runId: run.id,
  status: run.status,
});

interface LibraryExportProjectIdentity {
  incarnationId?: string;
  revision?: number;
}

interface RequiredLibraryExportProjectIdentity {
  incarnationId: string;
  revision: number;
}

type ExpectedProjectIssue = 'changed' | 'legacy' | 'unavailable';

const getProjectIdentity = (
  project: LibraryExportProjectIdentity
): RequiredLibraryExportProjectIdentity => {
  const { incarnationId, revision } = project;
  if (typeof incarnationId !== 'string' || incarnationId.length === 0) {
    throw new Error('Library export project incarnation is unavailable.');
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Library export project revision is unavailable.');
  }
  return { incarnationId, revision };
};

const getExpectedProjectIssue = (
  expectedProjects: readonly LibraryExportExpectedProject[],
  currentProjects: Awaited<ReturnType<ProjectStore['listLibraryExportProjects']>>
): ExpectedProjectIssue | null => {
  const currentProjectById = new Map(currentProjects.map(project => [project.id, project]));
  for (const expectedProject of expectedProjects) {
    if (expectedProject.incarnationId === undefined || expectedProject.revision === undefined) {
      return 'legacy';
    }
    const currentProject = currentProjectById.get(expectedProject.id);
    if (!currentProject) return 'unavailable';
    if (
      currentProject.incarnationId !== expectedProject.incarnationId ||
      currentProject.revision !== expectedProject.revision
    ) {
      return 'changed';
    }
  }
  return null;
};

const getResumeError = (issue: ExpectedProjectIssue): { code: string; detail: string } => {
  if (issue === 'legacy') {
    return {
      code: 'LIBRARY_EXPORT_LEGACY_RUN_UNRESUMABLE',
      detail: 'The export run predates resumable project identities.',
    };
  }
  if (issue === 'changed') {
    return {
      code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_CHANGED',
      detail: 'An expected project changed before the export resumed.',
    };
  }
  return {
    code: 'LIBRARY_EXPORT_EXPECTED_PROJECT_UNAVAILABLE',
    detail: 'An expected project was unavailable when the export resumed.',
  };
};

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

export const createLibraryExportApi = ({
  config = readLibraryExportConfig(process.env),
  archiveWorkspace = new LibraryExportWorkspace(),
  assetReader,
  projectStore,
  runStore,
}: CreateLibraryExportApiDependencies): LibraryExportApi => {
  const coordinator = new LibraryExportCoordinator(config.executionsGlobal);
  const shutdown = createLibraryExportOperations(coordinator);
  const { runExclusively, runStep } = shutdown;
  const delivery = createLibraryExportDelivery({
    config,
    coordinator,
    runStore,
    workspace: archiveWorkspace,
  });

  const createProjectArchive = async (
    userId: string,
    expectedProject: LibraryExportExpectedProject
  ): Promise<Uint8Array> => {
    const expectedIdentity = getProjectIdentity(expectedProject);
    const loadedProject = await runStep(() =>
      projectStore.loadProjectWithRevision(userId, expectedProject.id)
    );
    if (!loadedProject) throw new Error('Project selected for library export was not found.');
    if (
      loadedProject.incarnationId !== expectedIdentity.incarnationId ||
      loadedProject.revision !== expectedIdentity.revision
    ) {
      throw new Error('Project selected for library export changed after the run started.');
    }
    const project = await runStep(() => projectStore.exportProject(userId, expectedProject.id));
    if (!project) throw new Error('Project selected for library export was not found.');
    const assets: ProjectBackupAssetInput[] = [];
    for (const ref of collectProjectAssetReferences(project)) {
      const asset = await runStep(() =>
        assetReader.readActive({
          assetId: ref.id,
          projectId: expectedProject.id,
          userId,
        })
      );
      if (!asset) throw new Error('A project asset selected for library export was not found.');
      assets.push({ bytes: asset.bytes, ref });
    }
    const cover = await runStep(() => projectStore.loadProjectCover(userId, expectedProject.id));
    return runStep(() =>
      createProjectBackupArchive({ assets, cover, project }, PROJECT_ARCHIVE_LIMITS)
    );
  };

  const assertExpectedProjectsAreCurrent = async (
    userId: string,
    expectedProjects: readonly LibraryExportExpectedProject[]
  ): Promise<void> => {
    const issue = getExpectedProjectIssue(
      expectedProjects,
      await runStep(() => projectStore.listLibraryExportProjects(userId))
    );
    if (issue === 'unavailable') {
      throw new Error('A project selected for library export is unavailable.');
    }
    if (issue === 'changed') {
      throw new Error('A project selected for library export changed after the run started.');
    }
    if (issue === 'legacy') {
      throw new Error('The library export run cannot be resumed safely.');
    }
  };

  const execute = async (runId: string, userId: string): Promise<void> => {
    const startedAt = Date.now();
    let phase: LibraryExportPhase = 'preparing';
    let currentProjectId: string | undefined;
    try {
      let run = await runStep(() => runStore.getRun(userId, runId));
      if (!run) throw new Error('Library export run was not found.');
      await assertExpectedProjectsAreCurrent(userId, run.expectedProjects);
      const checkpointByProjectId = new Map(
        run.checkpoints.map(checkpoint => [checkpoint.projectId, checkpoint])
      );

      for (const [projectIndex, project] of run.expectedProjects.entries()) {
        currentProjectId = project.id;
        phase = 'project-archive';
        await runStep(() => runStore.markRunning(runId, phase, currentProjectId));
        const checkpoint = checkpointByProjectId.get(project.id);
        const expectedIdentity = getProjectIdentity(project);
        if (
          checkpoint?.projectIncarnationId === expectedIdentity.incarnationId &&
          checkpoint?.projectRevision === expectedIdentity.revision &&
          (await runStep(() =>
            archiveWorkspace.matchesProjectCheckpoint(runId, checkpoint, shutdown.signal)
          ))
        ) {
          continue;
        }
        const projectArchive = await createProjectArchive(userId, project);
        const archive = await runStep(() =>
          archiveWorkspace.writeProjectArchive(runId, project.path, projectArchive, shutdown.signal)
        );
        const nextCheckpoint: LibraryExportProjectCheckpoint = {
          archiveBytes: archive.bytes,
          archivePath: project.path,
          archiveSha256: archive.sha256,
          projectIncarnationId: expectedIdentity.incarnationId,
          projectId: project.id,
          projectIndex,
          projectRevision: expectedIdentity.revision,
        };
        await runStep(() => runStore.checkpointProject(runId, nextCheckpoint));
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

      run = await runStep(() => runStore.getRun(userId, runId));
      if (!run || run.checkpoints.length !== run.expectedProjects.length) {
        throw new Error('Library export checkpoints are incomplete.');
      }
      await assertExpectedProjectsAreCurrent(userId, run.expectedProjects);
      const checkpoints = run.checkpoints.slice().sort((a, b) => a.projectIndex - b.projectIndex);
      const manifest: LibraryArchiveManifest = {
        archiveVersion: LIBRARY_ARCHIVE_VERSION,
        folders: run.folders,
        format: LIBRARY_ARCHIVE_FORMAT,
        placements: run.placements,
        projects: run.expectedProjects.map(({ id, path, title }) => ({ id, path, title })),
      };
      currentProjectId = undefined;
      phase = 'library-archive';
      await runStep(() => runStore.markRunning(runId, phase));
      const archive = await runStep(() =>
        archiveWorkspace.createLibraryArchive(runId, manifest, checkpoints, shutdown.signal)
      );
      phase = 'integrity-check';
      await runStep(() => runStore.markRunning(runId, phase));
      if (
        !(await runStep(() =>
          archiveWorkspace.verifyLibraryArchive(runId, archive, shutdown.signal)
        ))
      ) {
        throw new Error('Library export archive checksum verification failed.');
      }
      await assertExpectedProjectsAreCurrent(userId, run.expectedProjects);
      if (!(await runStep(() => runStore.markCompleted(runId, archive)))) {
        throw new Error('A project selected for library export changed before completion.');
      }
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
      if (shutdown.signal.aborted) return;
      const code = getErrorCode(phase);
      const detail = 'Library export failed.';
      await runStep(() => runStore.markFailed(runId, { code, detail, phase }));
      const run = await runStep(() => runStore.getRun(userId, runId));
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
    shutdown.signal.throwIfAborted();
    if (coordinator.owns(run.id)) return;
    const { id, userId, correlationId, phase } = run;
    console.info('[LibraryExport] Run scheduled.', {
      correlationId,
      exportRunId: id,
      outcome,
      phase,
      userId,
    });
    coordinator.schedule(id, () =>
      execute(id, userId).catch(error => {
        if (shutdown.signal.aborted) return;
        console.error('[LibraryExport] Background persistence failed.', {
          errorType: getErrorType(error),
          exportRunId: id,
          outcome: 'failed',
          userId,
        });
      })
    );
  };

  const resumeRun = async (
    userId: string,
    runId: string,
    outcome: 'resumed' | 'started' = 'resumed'
  ): Promise<LibraryExportRunRecord | null> => {
    const current = await runExclusively(runId, async () => {
      const run = await runStep(() => runStore.getRun(userId, runId));
      if (!run || coordinator.owns(runId) || (run.status !== 'running' && run.status !== 'failed'))
        return run;
      if (outcome === 'resumed') {
        const issue = getExpectedProjectIssue(
          run.expectedProjects,
          await runStep(() => projectStore.listLibraryExportProjects(userId))
        );
        if (issue) {
          await runStep(() =>
            runStore.markCancelled(runId, {
              ...getResumeError(issue),
              phase: run.errorPhase ?? run.phase,
            })
          );
          return runStep(() => runStore.getRun(userId, runId));
        }
        if (run.status === 'running' && run.phase !== 'preparing') {
          await runStep(() =>
            runStore.markFailed(runId, {
              code: 'LIBRARY_EXPORT_PROCESS_INTERRUPTED',
              detail: 'The backend process stopped before the library export completed.',
              phase: run.phase,
            })
          );
        }
        await runStep(() => runStore.markRunning(runId, 'preparing'));
      }
      runInBackground(run, outcome);
      return runStep(() => runStore.getRun(userId, runId));
    });
    if (current?.status === 'cancelled') {
      await runStep(() => delivery.cleanupRun(runId)).catch(error => {
        if (shutdown.signal.aborted) throw error;
        console.error('[LibraryExport] Cancelled run cleanup failed.', {
          errorType: getErrorType(error),
          exportRunId: runId,
        });
      });
    }
    return current;
  };

  return {
    createDownloadAccess: delivery.createDownloadAccess,
    getDownload: delivery.getDownload,

    async startOrResume(userId, correlationId) {
      return runExclusively(`user:${userId}`, async () => {
        const existing = await runStep(() => runStore.findUndeliveredRun(userId));
        if (existing) {
          await runStep(() => delivery.expireRun(existing.id));
          const resumed = await resumeRun(userId, existing.id);
          if (resumed && resumed.status !== 'cancelled' && resumed.status !== 'downloaded')
            return toProgress(resumed);
        }
        const { folders, placements, projects } = await runStep(() =>
          projectStore.readLibraryExportSnapshot(userId)
        );
        assertCompleteOrganization(
          projects.map(project => project.id),
          folders,
          placements
        );
        const requestedRunId = randomUUID();
        const expectedProjects = projects.map((project, index) => {
          const identity = getProjectIdentity(project);
          return {
            id: project.id,
            incarnationId: identity.incarnationId,
            path: getLibraryArchiveProjectPath(project.id, index),
            revision: identity.revision,
            title: project.title,
          };
        });
        const run = await runStep(() =>
          runStore.createRun({
            bytesWritten: 0,
            correlationId,
            expectedProjects,
            folders,
            id: requestedRunId,
            phase: 'preparing',
            placements,
            status: 'running',
            userId,
          })
        );
        const scheduled = await resumeRun(
          userId,
          run.id,
          run.id === requestedRunId ? 'started' : 'resumed'
        );
        if (!scheduled) throw new Error('Persisted library export run is missing.');
        return toProgress(scheduled);
      });
    },

    async getStatus(userId, runId) {
      let progress = await runStep(() => runStore.getRunProgress(userId, runId));
      if (!progress) return null;
      if (progress.status === 'running' && !coordinator.owns(runId)) {
        await resumeRun(userId, runId);
        progress = await runStep(() => runStore.getRunProgress(userId, runId));
      }
      return progress ? toProgress(progress) : null;
    },

    async recoverPendingRuns() {
      await runStep(() => delivery.start());
      for (const run of await runStep(() => runStore.listRunningRuns())) {
        try {
          await resumeRun(run.userId, run.id);
        } catch (error) {
          if (shutdown.signal.aborted) throw error;
          console.error('[LibraryExport] Pending run recovery failed.', {
            errorType: getErrorType(error),
            exportRunId: run.id,
            outcome: 'recovery-failed',
            userId: run.userId,
          });
        }
      }
    },

    async close() {
      shutdown.abort();
      const executions = coordinator.close();
      delivery.close();
      await executions;
    },
  };
};

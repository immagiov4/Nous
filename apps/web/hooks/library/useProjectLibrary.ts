import { PROJECT_PATCH_REBASE_MODE } from '@shared/projectContract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { readSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import { ensureProjectCover } from '../../services/projects/courseCover.ts';
import { HttpProjectRepository } from '../../services/projects/httpProjectRepository.ts';
import { recoverLegacyAnnotations } from '../../services/projects/legacyAnnotationRecovery.ts';
import {
  createLibraryArchiveBlob,
  getLibraryArchiveExtension,
  LibraryArchiveError,
  LibraryArchiveRollbackError,
  readLibraryArchive,
  restoreLibraryArchiveOrganization,
} from '../../services/projects/libraryArchive.ts';
import { buildAutosaveSignature } from '../../services/projects/persistenceSignature';
import {
  createProjectArchiveBlob,
  getProjectArchiveExtension,
} from '../../services/projects/projectArchive.ts';
import { downloadProjectAssetBytes } from '../../services/projects/projectAssetClient.ts';
import {
  type ProjectSaveResult,
  type ProjectSnapshotWithRevision,
  ProjectStorageError,
  REMOTE_PROJECT_DELETED_MESSAGE,
} from '../../services/projects/projectRepository';
import {
  createProjectId,
  createProjectSnapshot,
  normalizeStoredProject,
} from '../../services/projects/projectSnapshot';
import { markSyncError, markSyncSaved, markSyncSaving } from '../../services/projects/syncState.ts';
import { prepareSnapshotForHydration } from '../../services/workspace/controller/snapshotHydration.ts';
import { resolvePersistedAppState } from '../../services/workspace/persistence';
import type {
  FileData,
  LearningSection,
  LibraryFolder,
  LibraryPlacement,
  LibraryTree,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSnapshot,
  ProjectSource,
  SavedProjectMeta,
  SectionAnnotationArtifactRef,
  StoredLessonVisual,
  WorkspaceDomainState,
} from '../../types';
import { replaceGeneratedVisualPreservingId } from '../../utils/learning/artifacts.ts';
import { findPathNodeById } from '../../utils/learning/pathNodes.ts';
import { createLessonSectionAnnotation } from '../../utils/learning/sectionAnnotations.ts';
import { buildLibraryTree } from '../../utils/library/tree.ts';
import { timestampIso } from '../../utils/time.ts';

interface UseProjectLibraryArgs {
  domainState: WorkspaceDomainState;
  hydrateSnapshot: (snapshot: ProjectSnapshot) => void;
  setSource: (source: ProjectSource | null) => void;
}

const isNavigationOnlyProjectOverride = (overrides: Partial<ProjectSnapshot>): boolean =>
  overrides.activeSectionId !== undefined &&
  Object.keys(overrides).every(key => key === 'activeSectionId' || key === 'state');

const didRebaseOverRemoteRevision = (
  expectedRevision: number | undefined,
  savedRevision: number | undefined
): savedRevision is number =>
  expectedRevision !== undefined &&
  savedRevision !== undefined &&
  savedRevision > expectedRevision + 1;

interface PersistSnapshotOptions {
  archiveFile?: File;
  throwOnError?: boolean;
}

interface ProjectWriteState {
  batchFailed: boolean;
  batchNeedsAutosave: boolean;
  pendingCount: number;
  queue: Promise<void>;
}

export type ProjectSyncState =
  | { kind: 'idle' }
  | { kind: 'load' | 'write' | 'import'; phase: 'failed' | 'pending'; message?: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'remoteDeleted'; message: string; projectId: string; wasActive: boolean }
  | { kind: 'realtimeDegraded' };

const sortProjects = (projects: SavedProjectMeta[]) =>
  projects
    .slice()
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

const haveSameProjectMetadata = (left: SavedProjectMeta, right: SavedProjectMeta): boolean => {
  const leftKeys = Object.keys(left) as Array<keyof SavedProjectMeta>;
  const rightKeys = Object.keys(right) as Array<keyof SavedProjectMeta>;
  return leftKeys.length === rightKeys.length && leftKeys.every(key => left[key] === right[key]);
};

const haveSameProjectList = (
  left: readonly SavedProjectMeta[],
  right: readonly SavedProjectMeta[]
): boolean =>
  left.length === right.length &&
  left.every((project, index) => haveSameProjectMetadata(project, right[index]));

export const useProjectLibrary = ({
  domainState,
  hydrateSnapshot,
  setSource,
}: UseProjectLibraryArgs) => {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [libraryPlacements, setLibraryPlacements] = useState<LibraryPlacement[]>([]);
  const [savedProjects, setSavedProjects] = useState<SavedProjectMeta[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [projectSyncState, setProjectSyncState] = useState<ProjectSyncState>({
    kind: 'load',
    phase: 'pending',
  });
  const [writeFailureVersion, setWriteFailureVersion] = useState(0);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const attemptedAutosaveSignatureRef = useRef<string | null>(null);
  const handledWriteFailureVersionRef = useRef(0);
  const isProjectHydratedRef = useRef(false);
  const persistentStorageRequestedRef = useRef(false);
  const didLoadInitialStateRef = useRef(false);
  const lastPersistedSignatureRef = useRef<string>('');
  const projectWritesRef = useRef(new Map<string, ProjectWriteState>());
  const deletedProjectIdsRef = useRef(new Set<string>());
  const pendingRemoteRevisionRef = useRef<ProjectRevisionEvent | null>(null);
  const isApplyingRemoteRevisionRef = useRef(false);
  const isRevisionCatchUpActiveRef = useRef(false);
  const revisionCatchUpRequestedRef = useRef(false);
  const processPendingRemoteRevisionRef = useRef<() => Promise<void>>(async () => {});
  const domainStateRef = useRef<WorkspaceDomainState>(domainState);
  const hydrateSnapshotRef = useRef(hydrateSnapshot);
  const setSourceRef = useRef(setSource);
  const savedProjectsRef = useRef<SavedProjectMeta[]>([]);
  const explicitProjectTitlesRef = useRef(new Map<string, string>());
  const loadedProjectRevisionRef = useRef<{ projectId: string | null; revision?: number }>({
    projectId: null,
  });
  const currentProjectIdRef = useRef<string | null>(null);

  const rememberExplicitProjectTitle = useCallback(
    (project: Pick<ProjectSnapshot, 'id' | 'title'>) => {
      if (project.title) {
        explicitProjectTitlesRef.current.set(project.id, project.title);
      } else {
        explicitProjectTitlesRef.current.delete(project.id);
      }
    },
    []
  );

  const projectRepository = useMemo(() => new HttpProjectRepository(), []);
  const projectRepositoryRef = useRef(projectRepository);

  useEffect(() => {
    domainStateRef.current = domainState;
  }, [domainState]);

  useEffect(() => {
    hydrateSnapshotRef.current = hydrateSnapshot;
  }, [hydrateSnapshot]);

  useEffect(() => {
    setSourceRef.current = setSource;
  }, [setSource]);

  useEffect(() => {
    projectRepositoryRef.current = projectRepository;
  }, [projectRepository]);

  const currentProjectMeta = useMemo(
    () => savedProjects.find(project => project.id === currentProjectId) || null,
    [currentProjectId, savedProjects]
  );

  const storeSavedProjects = useCallback((projects: SavedProjectMeta[]) => {
    const sortedProjects = sortProjects(projects);
    if (haveSameProjectList(savedProjectsRef.current, sortedProjects)) {
      return;
    }
    savedProjectsRef.current = sortedProjects;
    setSavedProjects(sortedProjects);
  }, []);

  const libraryTree = useMemo<LibraryTree>(
    () =>
      buildLibraryTree({
        folders: libraryFolders,
        placements: libraryPlacements,
        projects: savedProjects,
      }),
    [libraryFolders, libraryPlacements, savedProjects]
  );

  const refreshSavedProjects = useCallback(async () => {
    const projects = await projectRepositoryRef.current.listProjects();
    storeSavedProjects(projects);
    setStorageError(null);
  }, [storeSavedProjects]);

  const refreshLibraryOrganization = useCallback(async () => {
    const [folders, placements] = await Promise.all([
      projectRepositoryRef.current.listFolders(),
      projectRepositoryRef.current.listPlacements(),
    ]);
    setLibraryFolders(folders);
    setLibraryPlacements(placements);
  }, []);

  const refreshLibraryState = useCallback(async () => {
    await Promise.all([refreshSavedProjects(), refreshLibraryOrganization()]);
  }, [refreshLibraryOrganization, refreshSavedProjects]);

  const syncProjectMeta = useCallback(
    (meta: SavedProjectMeta) => {
      const nextProjects = savedProjectsRef.current.filter(project => project.id !== meta.id);
      nextProjects.push(meta);
      storeSavedProjects(nextProjects);
      if (loadedProjectRevisionRef.current.projectId === meta.id) {
        loadedProjectRevisionRef.current = { projectId: meta.id, revision: meta.revision };
      }
    },
    [storeSavedProjects]
  );

  const selectCurrentProject = useCallback((projectId: string | null) => {
    currentProjectIdRef.current = projectId;
    const meta = savedProjectsRef.current.find(project => project.id === projectId);
    loadedProjectRevisionRef.current = { projectId, revision: meta?.revision };
    pendingRemoteRevisionRef.current = null;
    setCurrentProjectId(projectId);
  }, []);

  const completeProjectHydration = useCallback(
    ({ revision, snapshot }: ProjectSnapshotWithRevision) => {
      if (currentProjectIdRef.current !== snapshot.id) return;

      const currentMeta = savedProjectsRef.current.find(project => project.id === snapshot.id);
      loadedProjectRevisionRef.current = { projectId: snapshot.id, revision };
      if (
        pendingRemoteRevisionRef.current?.projectId === snapshot.id &&
        pendingRemoteRevisionRef.current.revision <= revision
      ) {
        pendingRemoteRevisionRef.current = null;
      }
      if (currentMeta && (currentMeta.revision === undefined || revision > currentMeta.revision)) {
        syncProjectMeta({ ...currentMeta, revision });
      }
      lastPersistedSignatureRef.current = buildAutosaveSignature(snapshot);
      isProjectHydratedRef.current = true;
      setStorageError(null);
      void processPendingRemoteRevisionRef.current();
    },
    [syncProjectMeta]
  );

  const getExpectedRevision = useCallback((projectId: string): number | undefined => {
    if (loadedProjectRevisionRef.current.projectId === projectId) {
      return loadedProjectRevisionRef.current.revision;
    }
    return savedProjectsRef.current.find(project => project.id === projectId)?.revision;
  }, []);

  const getProjectWriteState = useCallback((projectId: string): ProjectWriteState => {
    const existing = projectWritesRef.current.get(projectId);
    if (existing) return existing;

    const created: ProjectWriteState = {
      batchFailed: false,
      batchNeedsAutosave: false,
      pendingCount: 0,
      queue: Promise.resolve(),
    };
    projectWritesRef.current.set(projectId, created);
    return created;
  }, []);

  const invalidateRemoteDeletedProject = useCallback(
    (projectId: string) => {
      if (deletedProjectIdsRef.current.has(projectId)) return;

      deletedProjectIdsRef.current.add(projectId);
      const wasActive = currentProjectIdRef.current === projectId;
      if (wasActive) {
        if (autosaveTimeoutRef.current !== null) {
          globalThis.clearTimeout(autosaveTimeoutRef.current);
          autosaveTimeoutRef.current = null;
        }
        attemptedAutosaveSignatureRef.current = null;
        isProjectHydratedRef.current = false;
        pendingRemoteRevisionRef.current = null;
      }
      explicitProjectTitlesRef.current.delete(projectId);
      storeSavedProjects(savedProjectsRef.current.filter(project => project.id !== projectId));
      setLibraryPlacements(placements =>
        placements.filter(placement => placement.projectId !== projectId)
      );
      if (wasActive) {
        selectCurrentProject(null);
      }

      const message = t(REMOTE_PROJECT_DELETED_MESSAGE);
      setStorageError(message);
      setProjectSyncState({ kind: 'remoteDeleted', message, projectId, wasActive });
      markSyncError();
    },
    [selectCurrentProject, storeSavedProjects]
  );

  const runDeletionAwareProjectAction = useCallback(
    async <T>(projectId: string, operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ProjectStorageError && error.code === 'project-deleted') {
          invalidateRemoteDeletedProject(projectId);
          throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
        }
        throw error;
      }
    },
    [invalidateRemoteDeletedProject]
  );

  const applyPersistedProjectRevision = useCallback(
    async ({ projectId, revision }: { projectId: string; revision: number }): Promise<boolean> => {
      await getProjectWriteState(projectId).queue;
      if (currentProjectIdRef.current !== projectId) return false;

      const localSignature = buildAutosaveSignature(domainStateRef.current);
      if (localSignature !== lastPersistedSignatureRef.current) {
        throw new ProjectStorageError(
          'Il corso contiene modifiche locali non ancora sincronizzate. Attendi il salvataggio e riprova.',
          'revision-conflict'
        );
      }

      const persisted = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
      if (!persisted) {
        invalidateRemoteDeletedProject(projectId);
        return false;
      }
      if (persisted.revision < revision) {
        throw new ProjectStorageError(
          'La lezione è stata salvata, ma non è stato possibile ricaricare la revisione aggiornata.',
          'persistence-failed'
        );
      }
      if (currentProjectIdRef.current !== projectId) return false;
      if (buildAutosaveSignature(domainStateRef.current) !== localSignature) {
        throw new ProjectStorageError(
          'Il corso è cambiato durante la sincronizzazione. Attendi il salvataggio e riprova.',
          'revision-conflict'
        );
      }

      const currentMeta = savedProjectsRef.current.find(project => project.id === projectId);
      const latestKnownRevision = Math.max(
        loadedProjectRevisionRef.current.projectId === projectId
          ? loadedProjectRevisionRef.current.revision || 0
          : 0,
        currentMeta?.revision || 0,
        pendingRemoteRevisionRef.current?.projectId === projectId
          ? pendingRemoteRevisionRef.current.revision
          : 0
      );
      if (persisted.revision < latestKnownRevision) return false;

      const hydratedSnapshot = prepareSnapshotForHydration(persisted.snapshot);
      rememberExplicitProjectTitle(hydratedSnapshot);
      if (
        currentMeta &&
        (currentMeta.revision === undefined || persisted.revision > currentMeta.revision)
      ) {
        syncProjectMeta({ ...currentMeta, revision: persisted.revision });
      } else {
        loadedProjectRevisionRef.current = { projectId, revision: persisted.revision };
      }
      if (
        pendingRemoteRevisionRef.current?.projectId === projectId &&
        pendingRemoteRevisionRef.current.revision <= persisted.revision
      ) {
        pendingRemoteRevisionRef.current = null;
      }
      lastPersistedSignatureRef.current = buildAutosaveSignature(hydratedSnapshot);
      hydrateSnapshotRef.current(hydratedSnapshot);
      setStorageError(null);
      return persisted.revision === revision;
    },
    [
      getProjectWriteState,
      invalidateRemoteDeletedProject,
      rememberExplicitProjectTitle,
      syncProjectMeta,
    ]
  );

  const runTrackedProjectWrite = useCallback(
    (
      projectId: string,
      operation: () => Promise<SavedProjectMeta>,
      retryFullSnapshotOnFailure = true
    ) => {
      if (deletedProjectIdsRef.current.has(projectId)) {
        return Promise.reject(
          new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted')
        );
      }

      const writeState = getProjectWriteState(projectId);
      if (writeState.pendingCount === 0) {
        writeState.batchFailed = false;
        writeState.batchNeedsAutosave = false;
      }
      writeState.pendingCount += 1;
      setProjectSyncState({ kind: 'write', phase: 'pending' });
      const queuedWrite = writeState.queue.then(async () => {
        try {
          if (deletedProjectIdsRef.current.has(projectId)) {
            throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
          }
          const meta = await operation();
          if (deletedProjectIdsRef.current.has(projectId)) {
            throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
          }
          syncProjectMeta(meta);
          return meta;
        } catch (error) {
          writeState.batchFailed = true;
          if (error instanceof ProjectStorageError && error.code === 'project-deleted') {
            writeState.batchNeedsAutosave = false;
            invalidateRemoteDeletedProject(projectId);
            throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
          }
          if (retryFullSnapshotOnFailure) {
            writeState.batchNeedsAutosave = true;
          }
          const message =
            error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
          setProjectSyncState(
            error instanceof ProjectStorageError && error.code === 'revision-conflict'
              ? { kind: 'conflict', message }
              : { kind: 'write', message, phase: 'failed' }
          );
          throw error;
        } finally {
          writeState.pendingCount -= 1;
          if (
            writeState.pendingCount === 0 &&
            writeState.batchFailed &&
            writeState.batchNeedsAutosave
          ) {
            setWriteFailureVersion(version => version + 1);
          }
          if (writeState.pendingCount === 0 && !writeState.batchFailed) {
            setProjectSyncState(current =>
              current.kind === 'remoteDeleted' ? current : { kind: 'idle' }
            );
          }
          globalThis.setTimeout(() => {
            void processPendingRemoteRevisionRef.current();
          }, 0);
        }
      });
      writeState.queue = queuedWrite.then(
        () => undefined,
        () => undefined
      );
      return queuedWrite;
    },
    [getProjectWriteState, invalidateRemoteDeletedProject, syncProjectMeta]
  );

  const requestPersistentStorage = useCallback(async () => {
    if (persistentStorageRequestedRef.current) {
      return;
    }

    persistentStorageRequestedRef.current = true;

    if (
      globalThis.window === undefined ||
      !globalThis.isSecureContext ||
      !navigator.storage?.persist
    ) {
      return;
    }

    try {
      await navigator.storage.persist();
    } catch {
      // Best effort only.
    }
  }, []);

  const buildSnapshotFromDomain = useCallback(
    (overrides?: Partial<ProjectSnapshot>): ProjectSnapshot | null => {
      const projectId = overrides?.id || currentProjectId;
      if (!projectId) {
        return null;
      }

      return createProjectSnapshot({
        id: projectId,
        title: overrides?.title ?? explicitProjectTitlesRef.current.get(projectId),
        version: overrides?.version,
        sourceKind: overrides?.sourceKind || currentProjectMeta?.sourceKind || undefined,
        state: overrides?.state || resolvePersistedAppState(domainState),
        source: overrides?.source !== undefined ? overrides.source : domainState.source,
        learningPlan:
          overrides?.learningPlan !== undefined ? overrides.learningPlan : domainState.learningPlan,
        documentAssets:
          overrides?.documentAssets !== undefined
            ? overrides.documentAssets
            : domainState.documentAssets,
        documentIndex:
          overrides?.documentIndex !== undefined
            ? overrides.documentIndex
            : domainState.documentIndex,
        isLearnMode: overrides?.isLearnMode ?? domainState.isLearnMode,
        userProfile:
          overrides?.userProfile !== undefined ? overrides.userProfile : domainState.userProfile,
        syllabus: overrides?.syllabus ?? domainState.syllabus,
        researchCoursePlan:
          overrides?.researchCoursePlan !== undefined
            ? overrides.researchCoursePlan
            : domainState.researchCoursePlan,
        researchDossiersBySectionId:
          overrides?.researchDossiersBySectionId ?? domainState.researchDossiersBySectionId,
        activeSectionId:
          overrides?.activeSectionId !== undefined
            ? overrides.activeSectionId
            : domainState.activeSectionId,
        createdAt: overrides?.createdAt || currentProjectMeta?.createdAt,
        updatedAt: overrides?.updatedAt || timestampIso(),
        lastOpenedAt: overrides?.lastOpenedAt || currentProjectMeta?.lastOpenedAt,
      });
    },
    [currentProjectId, currentProjectMeta, domainState]
  );

  const persistSnapshot = useCallback(
    async (snapshot: ProjectSnapshot, options: PersistSnapshotOptions = {}) => {
      // Anti-data-loss guard: se è uno scrivimento di un progetto già esistente con
      // sourceFile registrata in meta ma lo snapshot ha source nullo, evitiamo di
      // sovrascrivere il PDF persistito. (Non blocca il primo salvataggio: se non c'è
      // ancora una meta, non c'è nulla da proteggere.)
      const matchingMeta = savedProjectsRef.current.find(project => project.id === snapshot.id);
      if (matchingMeta?.hasSourceFile && snapshot.source == null) {
        console.warn(
          '[Nous][persistSnapshot] Aborted: snapshot.source is null but stored meta reports a source. Refusing to overwrite stored source.',
          { projectId: snapshot.id, sourceKind: matchingMeta.sourceKind }
        );
        return null;
      }

      try {
        let detachedSnapshot: ProjectSnapshot | undefined;
        const meta = await runTrackedProjectWrite(
          snapshot.id,
          async () => {
            const saved = await projectRepositoryRef.current.saveProject(snapshot, {
              archiveFile: options.archiveFile,
              expectedRevision: getExpectedRevision(snapshot.id),
            });
            detachedSnapshot = saved.snapshot;
            return saved.meta;
          },
          false
        );
        if (detachedSnapshot && domainStateRef.current.source === snapshot.source) {
          lastPersistedSignatureRef.current = buildAutosaveSignature(detachedSnapshot);
          setSourceRef.current(detachedSnapshot.source);
        }
        const writeState = getProjectWriteState(snapshot.id);
        if (writeState.pendingCount === 0 && !writeState.batchFailed) {
          setStorageError(null);
          lastPersistedSignatureRef.current = buildAutosaveSignature(detachedSnapshot || snapshot);
        }
        if (!matchingMeta) {
          void ensureProjectCover({
            loadCover: projectId => projectRepositoryRef.current.loadProjectCover(projectId),
            projectId: meta.id,
            saveCover: (projectId, cover) =>
              projectRepositoryRef.current.saveProjectCover(projectId, cover),
            title: meta.title,
          }).catch(error => {
            console.warn('[Nous] Course cover generation deferred.', error);
          });
        }
        void requestPersistentStorage();
        return {
          meta,
          snapshot: detachedSnapshot || snapshot,
        } satisfies ProjectSaveResult;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        markSyncError();
        if (options.throwOnError) {
          throw error;
        }
        return null;
      }
    },
    [getExpectedRevision, getProjectWriteState, requestPersistentStorage, runTrackedProjectWrite]
  );

  const saveCurrentProject = useCallback(
    async (overrides?: Partial<ProjectSnapshot>, options?: PersistSnapshotOptions) => {
      const snapshot = buildSnapshotFromDomain(overrides);
      if (!snapshot) {
        return null;
      }

      // Anti-data-loss guard: se la meta dice che il progetto HA un source ma lo
      // snapshot in memoria è null (e l'override non sta ricollegando esplicitamente),
      // abortiamo. Meglio uno scrivimento mancato che un PUT che azzera il PDF in DB.
      if (
        currentProjectMeta?.hasSourceFile &&
        snapshot.source == null &&
        overrides?.source === undefined
      ) {
        console.warn(
          '[Nous][saveCurrentProject] Aborted: snapshot.source is null but project meta reports a source. Refusing to overwrite stored source.',
          { projectId: snapshot.id, sourceKind: currentProjectMeta.sourceKind }
        );
        return null;
      }

      const saved = await persistSnapshot(snapshot, options);
      return saved?.meta || null;
    },
    [buildSnapshotFromDomain, currentProjectMeta, persistSnapshot]
  );

  /**
   * patchCurrentProject — sends a granular PATCH instead of a full snapshot PUT.
   * Use this for small targeted saves from controllers (section completion, active
   * section change). Requires overrides — calling without overrides is an error.
   * No sync indicator (background).
   */
  const patchCurrentProject = useCallback(
    async (overrides?: Partial<ProjectSnapshot>): Promise<SavedProjectMeta | null> => {
      if (!currentProjectId || !overrides) {
        return null;
      }

      const patch: Record<string, unknown> = {};

      if (overrides.activeSectionId !== undefined)
        patch.activeSectionId = overrides.activeSectionId;
      if (overrides.state !== undefined) patch.state = overrides.state;
      if (overrides.isLearnMode !== undefined) patch.isLearnMode = overrides.isLearnMode;
      if (overrides.source !== undefined) patch.source = overrides.source;
      if (overrides.learningPlan !== undefined) patch.learningPlan = overrides.learningPlan;
      if (overrides.userProfile !== undefined) patch.userProfile = overrides.userProfile;
      if (overrides.syllabus !== undefined) patch.syllabus = overrides.syllabus;
      if (overrides.researchCoursePlan !== undefined)
        patch.researchCoursePlan = overrides.researchCoursePlan;
      if (overrides.researchDossiersBySectionId !== undefined)
        patch.researchDossiersBySectionId = overrides.researchDossiersBySectionId;
      if (overrides.documentAssets !== undefined) patch.documentAssets = overrides.documentAssets;
      if (overrides.documentIndex !== undefined) {
        // A failed background refresh must not erase an index that is still usable in memory.
        if (overrides.documentIndex === null && domainStateRef.current.documentIndex != null) {
          console.warn(
            '[Nous][patchCurrentProject] Skipping documentIndex:null patch because in-memory documentIndex is non-null.',
            { projectId: currentProjectId }
          );
        } else {
          patch.documentIndex = overrides.documentIndex;
        }
      }

      patch.updatedAt = timestampIso();

      const persistedSignature = buildAutosaveSignature({
        ...domainStateRef.current,
        ...overrides,
      });
      let expectedRevision: number | undefined;
      const rebaseMode = isNavigationOnlyProjectOverride(overrides)
        ? PROJECT_PATCH_REBASE_MODE.navigation
        : undefined;
      try {
        const meta = await runTrackedProjectWrite(currentProjectId, () => {
          expectedRevision = getExpectedRevision(currentProjectId);
          return projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision,
            ...(rebaseMode === undefined ? {} : { rebaseMode }),
          });
        });
        const writeState = getProjectWriteState(currentProjectId);
        if (writeState.pendingCount === 0 && !writeState.batchFailed) {
          setStorageError(null);
          lastPersistedSignatureRef.current = persistedSignature;
        }
        const savedRevision = meta.revision;
        if (rebaseMode && didRebaseOverRemoteRevision(expectedRevision, savedRevision)) {
          await applyPersistedProjectRevision({
            projectId: currentProjectId,
            revision: savedRevision,
          });
        }
        void requestPersistentStorage();
        return meta;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        return null;
      }
    },
    [
      currentProjectId,
      applyPersistedProjectRevision,
      getExpectedRevision,
      getProjectWriteState,
      requestPersistentStorage,
      runTrackedProjectWrite,
    ]
  );

  /**
   * patchSectionAnnotations — sends ONLY the annotations (and optionally content) for one section.
   * This is the most common hot path (highlight, note, delete annotation).
   * Payload: ~1KB instead of ~100KB for the full learning plan.
   *
   * After a successful patch, updates the persistence signature so the debounced autosave
   * is suppressed for this change.
   */
  const patchSectionAnnotations = useCallback(
    async (
      sectionId: string,
      annotations: unknown,
      content?: string,
      generatedVisuals?: LearningSection['generatedVisuals']
    ): Promise<boolean> => {
      if (!currentProjectId) return false;

      const patch: Record<string, unknown> = {
        section: { sectionId, annotations, content, generatedVisuals },
        updatedAt: timestampIso(),
      };

      const persistedSignature = buildAutosaveSignature(domainStateRef.current);
      try {
        markSyncSaving();
        await runTrackedProjectWrite(currentProjectId, () =>
          projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision: getExpectedRevision(currentProjectId),
          })
        );
        const writeState = getProjectWriteState(currentProjectId);
        if (writeState.pendingCount === 0 && !writeState.batchFailed) {
          setStorageError(null);
          lastPersistedSignatureRef.current = persistedSignature;
          markSyncSaved();
        } else {
          markSyncError();
        }
        return true;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        markSyncError();
        return false;
      }
    },
    [currentProjectId, getExpectedRevision, getProjectWriteState, runTrackedProjectWrite]
  );

  const patchSectionLessonContent = useCallback(
    async (
      sectionId: string,
      patchValue: Partial<
        Pick<
          LearningSection,
          | 'content'
          | 'contentBlocks'
          | 'generationWarnings'
          | 'generatedVisuals'
          | 'imageRefs'
          | 'instructionPacks'
          | 'learningAids'
          | 'quiz'
          | 'visualPlanningDecision'
        >
      >,
      projectPatch: Partial<ProjectSnapshot> = {}
    ): Promise<boolean> => {
      if (!currentProjectId) return true;

      const patch: ProjectPatch = {
        ...(projectPatch as ProjectPatch),
        section: { sectionId, ...patchValue },
        updatedAt: timestampIso(),
      };

      const persistedSignature = buildAutosaveSignature(domainStateRef.current);
      try {
        await runTrackedProjectWrite(currentProjectId, () =>
          projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision: getExpectedRevision(currentProjectId),
          })
        );
        const writeState = getProjectWriteState(currentProjectId);
        if (writeState.pendingCount === 0 && !writeState.batchFailed) {
          setStorageError(null);
          lastPersistedSignatureRef.current = persistedSignature;
        }
        void requestPersistentStorage();
        return true;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        return false;
      }
    },
    [
      currentProjectId,
      getExpectedRevision,
      getProjectWriteState,
      requestPersistentStorage,
      runTrackedProjectWrite,
    ]
  );

  const saveLessonArtifactNote = useCallback(
    async ({
      generatedVisuals,
      lessonId,
      note,
      projectId,
      artifactRefs,
    }: {
      artifactRefs?: SectionAnnotationArtifactRef[];
      generatedVisuals?: LearningSection['generatedVisuals'];
      lessonId: string;
      note: string;
      projectId: string;
    }): Promise<{ annotationId?: string; error?: string; saved: boolean }> => {
      let annotationId: string | undefined;
      try {
        await runTrackedProjectWrite(projectId, async () => {
          const persisted = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
          if (!persisted) {
            invalidateRemoteDeletedProject(projectId);
            throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
          }
          const learningPlan = persisted.snapshot.learningPlan;
          const sectionNode = learningPlan
            ? findPathNodeById(learningPlan.modules, lessonId)
            : null;
          const section = sectionNode?.kind === 'lesson' ? sectionNode : null;
          if (!learningPlan || !section) {
            throw new Error(t('Non ho trovato la lezione target in questo corso.'));
          }

          const annotationResult = createLessonSectionAnnotation({
            annotations: section.annotations,
            artifactRefs,
            note,
          });
          annotationId = annotationResult.annotationId;
          const visualById = new Map(
            (section.generatedVisuals || []).map(visual => [visual.id, visual])
          );
          (generatedVisuals || []).forEach(visual => {
            if (!visualById.has(visual.id)) {
              visualById.set(visual.id, visual);
            }
          });

          return projectRepositoryRef.current.patchProject(
            projectId,
            {
              section: {
                sectionId: lessonId,
                annotations: annotationResult.annotations,
                generatedVisuals: Array.from(visualById.values()),
              },
              updatedAt: timestampIso(),
            },
            { expectedRevision: persisted.revision }
          );
        });
        return { annotationId, saved: true };
      } catch (error) {
        return { saved: false, error: getErrorMessage(error) };
      }
    },
    [invalidateRemoteDeletedProject, runTrackedProjectWrite]
  );

  const replaceLessonGeneratedVisual = useCallback(
    async ({
      artifactId,
      lessonId,
      projectId,
      visual,
    }: {
      artifactId: string;
      lessonId: string;
      projectId: string;
      visual: StoredLessonVisual;
    }): Promise<{ error?: string; replaced: boolean }> => {
      try {
        await runTrackedProjectWrite(projectId, async () => {
          const persisted = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
          if (!persisted) {
            invalidateRemoteDeletedProject(projectId);
            throw new ProjectStorageError(t(REMOTE_PROJECT_DELETED_MESSAGE), 'project-deleted');
          }
          const learningPlan = persisted.snapshot.learningPlan;
          const sectionNode = learningPlan
            ? findPathNodeById(learningPlan.modules, lessonId)
            : null;
          const section = sectionNode?.kind === 'lesson' ? sectionNode : null;
          if (!learningPlan || !section) {
            throw new Error(t('Non ho trovato la lezione target in questo corso.'));
          }

          const nextGeneratedVisuals = replaceGeneratedVisualPreservingId({
            artifactId,
            replacementVisual: visual,
            visuals: section.generatedVisuals,
          });
          if (!nextGeneratedVisuals) {
            throw new Error(t('Non ho trovato l artefatto da sostituire.'));
          }

          return projectRepositoryRef.current.patchProject(
            projectId,
            {
              section: {
                sectionId: lessonId,
                generatedVisuals: nextGeneratedVisuals,
              },
              updatedAt: timestampIso(),
            },
            { expectedRevision: persisted.revision }
          );
        });
        return { replaced: true };
      } catch (error) {
        return { replaced: false, error: getErrorMessage(error) };
      }
    },
    [invalidateRemoteDeletedProject, runTrackedProjectWrite]
  );

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', objectUrl);
    downloadAnchorNode.setAttribute('download', filename);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    globalThis.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }, []);

  const downloadProject = useCallback(
    async (projectId?: string) => {
      const targetProjectId = projectId || currentProjectId;
      if (!targetProjectId) {
        throw new Error('No project is available for export.');
      }

      const exportData = await projectRepositoryRef.current.exportProject(targetProjectId);

      if (!exportData) {
        throw new Error('The selected project could not be exported.');
      }

      const [cover, snapshot] = await Promise.all([
        projectRepositoryRef.current.loadProjectCover(targetProjectId),
        Promise.resolve(normalizeStoredProject(exportData)),
      ]);
      const archive = await createProjectArchiveBlob(snapshot, {
        cover,
        loadAsset: ref => downloadProjectAssetBytes(targetProjectId, ref),
      });
      downloadBlob(
        archive,
        `nous-backup-${timestampIso().slice(0, 10)}${getProjectArchiveExtension()}`
      );
    },
    [currentProjectId, downloadBlob]
  );

  const downloadLibraryBackup = useCallback(async (): Promise<number> => {
    const [projectMetas, folders, placements] = await Promise.all([
      projectRepositoryRef.current.listProjects(),
      projectRepositoryRef.current.listFolders(),
      projectRepositoryRef.current.listPlacements(),
    ]);
    const projects: ProjectSnapshot[] = [];

    for (const projectMeta of projectMetas) {
      const exportData = await projectRepositoryRef.current.exportProject(projectMeta.id);
      if (!exportData) {
        throw new Error(`Il corso ${projectMeta.title} non può essere esportato.`);
      }
      projects.push(normalizeStoredProject(exportData));
    }

    const archive = await createLibraryArchiveBlob(
      projects,
      { folders, placements },
      {
        createProjectArchive: async project =>
          createProjectArchiveBlob(project, {
            cover: await projectRepositoryRef.current.loadProjectCover(project.id),
            loadAsset: ref => downloadProjectAssetBytes(project.id, ref),
          }),
      }
    );
    downloadBlob(
      archive,
      `nous-library-backup-${timestampIso().slice(0, 10)}${getLibraryArchiveExtension()}`
    );
    return projects.length;
  }, [downloadBlob]);

  const importLibraryBackup = useCallback(
    async (file: File): Promise<number> => {
      setProjectSyncState({ kind: 'import', phase: 'pending' });
      let archive: Awaited<ReturnType<typeof readLibraryArchive>>;
      try {
        archive = await readLibraryArchive(file);
      } catch (error) {
        setProjectSyncState({ kind: 'import', message: getErrorMessage(error), phase: 'failed' });
        throw error;
      }
      const projectArchivesById = new Map(
        archive.projectArchives.map(project => [project.id, project.archive])
      );
      const projectIdMap = new Map<string, string>();
      const importedProjectIds: string[] = [];
      try {
        for (const [projectOffset, project] of archive.projects.entries()) {
          const projectIndex = projectOffset + 1;
          const projectCount = archive.projects.length;
          try {
            const originalProjectId = project.id;
            if (!originalProjectId) {
              throw new Error('Il backup contiene un corso senza identificatore.');
            }
            const importedProjectId = createProjectId();
            const projectArchive = projectArchivesById.get(originalProjectId);
            if (!projectArchive) {
              throw new Error('Il backup contiene un corso senza archivio.');
            }
            importedProjectIds.push(importedProjectId);
            const imported = await projectRepositoryRef.current.importProjectArchive(
              projectArchive,
              importedProjectId
            );
            if (imported.snapshot.id !== importedProjectId) {
              throw new Error('Il server ha restituito un identificatore corso inatteso.');
            }
            projectIdMap.set(originalProjectId, importedProjectId);
          } catch (error) {
            if (error instanceof LibraryArchiveError) throw error;
            throw new LibraryArchiveError(
              `Importazione del corso ${projectIndex} di ${projectCount} non riuscita.`,
              'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
              'project-import',
              projectIndex,
              projectCount
            );
          }
        }
        await restoreLibraryArchiveOrganization(
          projectRepositoryRef.current,
          archive,
          projectIdMap
        );
      } catch (error) {
        let rollbackFailed = error instanceof LibraryArchiveRollbackError;
        const rollbackProjectIds = [...importedProjectIds].reverse();
        for (const projectId of rollbackProjectIds) {
          try {
            await projectRepositoryRef.current.deleteProject(projectId);
          } catch (cleanupError) {
            rollbackFailed = true;
            console.warn('[Nous] Failed to roll back an imported library project.', cleanupError);
          }
        }
        if (rollbackFailed) {
          try {
            await refreshLibraryState();
          } catch (refreshError) {
            console.warn(
              '[Nous] Failed to refresh the library after an incomplete rollback.',
              refreshError
            );
          }
          const rollbackError = new LibraryArchiveRollbackError(
            error instanceof LibraryArchiveError ? error.projectIndex : undefined,
            error instanceof LibraryArchiveError
              ? (error.projectCount ?? archive.projects.length)
              : archive.projects.length
          );
          setProjectSyncState({
            kind: 'import',
            message: rollbackError.message,
            phase: 'failed',
          });
          throw rollbackError;
        }
        setProjectSyncState({ kind: 'import', message: getErrorMessage(error), phase: 'failed' });
        throw error;
      }
      await refreshLibraryState();
      setProjectSyncState({ kind: 'idle' });
      return archive.projects.length;
    },
    [refreshLibraryState]
  );

  const processPendingRemoteRevision = useCallback(async (): Promise<void> => {
    const pendingEvent = pendingRemoteRevisionRef.current;
    const loadedProject = loadedProjectRevisionRef.current;
    if (pendingEvent?.projectId !== currentProjectIdRef.current) {
      return;
    }
    if (pendingEvent.deleted) {
      invalidateRemoteDeletedProject(pendingEvent.projectId);
      return;
    }
    if (
      loadedProject.projectId === pendingEvent.projectId &&
      loadedProject.revision !== undefined &&
      pendingEvent.revision <= loadedProject.revision
    ) {
      pendingRemoteRevisionRef.current = null;
      return;
    }

    const writeState = getProjectWriteState(pendingEvent.projectId);
    const hasLocalChanges =
      writeState.pendingCount > 0 ||
      autosaveTimeoutRef.current !== null ||
      (isProjectHydratedRef.current &&
        buildAutosaveSignature(domainStateRef.current) !== lastPersistedSignatureRef.current);
    if (!isProjectHydratedRef.current || hasLocalChanges) {
      return;
    }
    if (isApplyingRemoteRevisionRef.current) {
      return;
    }

    isApplyingRemoteRevisionRef.current = true;
    try {
      const persisted = await projectRepositoryRef.current.loadProjectWithRevision(
        pendingEvent.projectId
      );
      if (!persisted) {
        invalidateRemoteDeletedProject(pendingEvent.projectId);
        return;
      }
      if (writeState.pendingCount > 0) {
        return;
      }
      if (buildAutosaveSignature(domainStateRef.current) !== lastPersistedSignatureRef.current) {
        return;
      }

      const latestPendingEvent = pendingRemoteRevisionRef.current;
      if (latestPendingEvent?.projectId !== pendingEvent.projectId) {
        return;
      }
      if (persisted.revision < latestPendingEvent.revision) {
        return;
      }
      rememberExplicitProjectTitle(persisted.snapshot);
      const hydratedSnapshot = prepareSnapshotForHydration(persisted.snapshot);
      pendingRemoteRevisionRef.current = null;
      loadedProjectRevisionRef.current = {
        projectId: pendingEvent.projectId,
        revision: persisted.revision,
      };
      lastPersistedSignatureRef.current = buildAutosaveSignature(hydratedSnapshot);
      hydrateSnapshotRef.current(hydratedSnapshot);
      setStorageError(null);
      setProjectSyncState({ kind: 'idle' });
    } catch (error) {
      console.warn('[Nous] Remote project revision could not be applied', error);
      setProjectSyncState({ kind: 'realtimeDegraded' });
    } finally {
      isApplyingRemoteRevisionRef.current = false;
    }
  }, [getProjectWriteState, invalidateRemoteDeletedProject, rememberExplicitProjectTitle]);

  useEffect(() => {
    processPendingRemoteRevisionRef.current = processPendingRemoteRevision;
  }, [processPendingRemoteRevision]);

  const reconcileProjectRevisions = useCallback(async (): Promise<void> => {
    const projects = await projectRepositoryRef.current.listProjects();
    storeSavedProjects(projects);
    const projectId = currentProjectIdRef.current;
    if (!projectId) {
      setStorageError(null);
      return;
    }

    const remoteMeta = projects.find(project => project.id === projectId);
    const loadedRevision = loadedProjectRevisionRef.current.revision;
    if (!remoteMeta) {
      if (loadedRevision !== undefined) {
        invalidateRemoteDeletedProject(projectId);
        return;
      }
    } else if (
      remoteMeta.revision !== undefined &&
      (loadedRevision === undefined || remoteMeta.revision > loadedRevision)
    ) {
      const pendingRevision = pendingRemoteRevisionRef.current?.revision || 0;
      if (remoteMeta.revision > pendingRevision) {
        pendingRemoteRevisionRef.current = {
          projectId,
          revision: remoteMeta.revision,
        };
      }
    }
    setStorageError(null);
    setProjectSyncState(current => (current.kind === 'remoteDeleted' ? current : { kind: 'idle' }));
    await processPendingRemoteRevisionRef.current();
  }, [invalidateRemoteDeletedProject, storeSavedProjects]);

  const requestRevisionCatchUp = useCallback(() => {
    revisionCatchUpRequestedRef.current = true;
    if (isRevisionCatchUpActiveRef.current) return;
    isRevisionCatchUpActiveRef.current = true;
    void (async () => {
      while (revisionCatchUpRequestedRef.current) {
        revisionCatchUpRequestedRef.current = false;
        try {
          await reconcileProjectRevisions();
        } catch (error) {
          console.warn('[Nous] Project revision catch-up failed', error);
          setProjectSyncState({ kind: 'realtimeDegraded' });
        }
      }
      isRevisionCatchUpActiveRef.current = false;
    })();
  }, [reconcileProjectRevisions]);

  useEffect(() => {
    const unsubscribe = projectRepository.subscribeToProjectRevisions(event => {
      if (event.projectId === currentProjectIdRef.current) {
        const pendingRevision = pendingRemoteRevisionRef.current?.revision || 0;
        if (event.revision > pendingRevision) {
          pendingRemoteRevisionRef.current = event;
        }
      }
      requestRevisionCatchUp();
    }, requestRevisionCatchUp);
    return unsubscribe;
  }, [projectRepository, requestRevisionCatchUp]);

  useEffect(() => {
    if (globalThis.window === undefined) {
      return;
    }
    const catchUp = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) {
        requestRevisionCatchUp();
      }
    };
    document.addEventListener('visibilitychange', catchUp);
    globalThis.addEventListener('online', catchUp);
    return () => {
      document.removeEventListener('visibilitychange', catchUp);
      globalThis.removeEventListener('online', catchUp);
    };
  }, [requestRevisionCatchUp]);

  useEffect(() => {
    if (didLoadInitialStateRef.current) {
      return;
    }

    didLoadInitialStateRef.current = true;

    const loadInitialState = async () => {
      try {
        await refreshLibraryState();
        setStorageError(null);
        setProjectSyncState({ kind: 'idle' });
      } catch (error) {
        const message = getErrorMessage(error);
        setStorageError(message);
        setProjectSyncState({ kind: 'load', message, phase: 'failed' });
      } finally {
        setIsLibraryLoading(false);
      }

      const userId = readSupabaseSession()?.user?.id;
      if (!userId) {
        return;
      }

      try {
        const recoveredCount = await recoverLegacyAnnotations({
          isUserActive: () => readSupabaseSession()?.user?.id === userId,
          projectMetas: savedProjectsRef.current,
          repository: projectRepositoryRef.current,
          userId,
        });
        if (recoveredCount > 0) {
          await refreshSavedProjects();
        }
      } catch (error) {
        console.warn('[Nous] Legacy annotations could not be recovered.', error);
      }
    };

    void loadInitialState();
  }, [refreshLibraryState, refreshSavedProjects]);

  const currentPersistenceSignature = useMemo(
    () => buildAutosaveSignature(domainState),
    [domainState]
  );

  const loadProjectsById = useCallback(
    async (ids: string[]) => {
      const projects = await projectRepositoryRef.current.loadProjectsById(ids);
      for (const project of projects) {
        rememberExplicitProjectTitle(project);
      }
      return projects;
    },
    [rememberExplicitProjectTitle]
  );
  const loadStoredProject = useCallback(
    async (projectId: string) => {
      const project = await projectRepositoryRef.current.loadProject(projectId);
      if (project) {
        rememberExplicitProjectTitle(project);
      }
      return project;
    },
    [rememberExplicitProjectTitle]
  );
  const loadStoredProjectWithRevision = useCallback(
    async (projectId: string) => {
      const project = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
      if (project) {
        rememberExplicitProjectTitle(project.snapshot);
      }
      return project;
    },
    [rememberExplicitProjectTitle]
  );
  const validateStoredProjectForOpen = useCallback(
    async (projectId: string) => {
      if (deletedProjectIdsRef.current.has(projectId)) return null;
      const project = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
      if (!project) {
        invalidateRemoteDeletedProject(projectId);
        return null;
      }
      rememberExplicitProjectTitle(project.snapshot);
      return project;
    },
    [invalidateRemoteDeletedProject, rememberExplicitProjectTitle]
  );
  const loadStoredProjectCover = useCallback(
    (projectId: string) => projectRepositoryRef.current.loadProjectCover(projectId),
    []
  );
  const loadStoredProjectSource = useCallback(
    (projectId: string) => projectRepositoryRef.current.loadProjectSource(projectId),
    []
  );
  const loadStoredProjectSources = useCallback(
    (projectId: string) => projectRepositoryRef.current.loadProjectSources(projectId),
    []
  );
  const saveStoredProjectCover = useCallback(
    (projectId: string, cover: FileData) =>
      runDeletionAwareProjectAction(projectId, () =>
        projectRepositoryRef.current.saveProjectCover(projectId, cover)
      ),
    [runDeletionAwareProjectAction]
  );

  const renameProject = useCallback(
    async (projectId: string, title: string) => {
      const meta = await runTrackedProjectWrite(
        projectId,
        () =>
          projectRepositoryRef.current.patchProject(
            projectId,
            { title, updatedAt: timestampIso() },
            { expectedRevision: getExpectedRevision(projectId) }
          ),
        false
      );
      explicitProjectTitlesRef.current.set(projectId, title);
      return meta;
    },
    [getExpectedRevision, runTrackedProjectWrite]
  );

  const setProjectFavorite = useCallback(
    (projectId: string, isFavorite: boolean) =>
      runTrackedProjectWrite(
        projectId,
        () => projectRepositoryRef.current.setProjectFavorite(projectId, isFavorite),
        false
      ),
    [runTrackedProjectWrite]
  );

  // Autosave: full snapshot PUT — safety net for any domain change that wasn't
  // already handled by an explicit patch. No sync indicator (background work).
  // Hot paths (highlight, note) call patchSectionAnnotations first, which updates
  // lastPersistedSignature — suppressing this fallback.
  useEffect(() => {
    if (!currentProjectId || !isProjectHydratedRef.current) {
      return;
    }

    const hasNewFailedWriteBatch = writeFailureVersion > handledWriteFailureVersionRef.current;
    if (hasNewFailedWriteBatch) {
      handledWriteFailureVersionRef.current = writeFailureVersion;
    }

    if (currentPersistenceSignature === lastPersistedSignatureRef.current) {
      attemptedAutosaveSignatureRef.current = null;
      return;
    }

    if (getProjectWriteState(currentProjectId).pendingCount > 0) {
      return;
    }

    if (
      attemptedAutosaveSignatureRef.current === currentPersistenceSignature &&
      !hasNewFailedWriteBatch
    ) {
      return;
    }

    if (autosaveTimeoutRef.current) {
      globalThis.clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = globalThis.window.setTimeout(() => {
      autosaveTimeoutRef.current = null;
      attemptedAutosaveSignatureRef.current = currentPersistenceSignature;
      void saveCurrentProject().then(meta => {
        if (meta) {
          attemptedAutosaveSignatureRef.current = null;
        }
      });
    }, 400);

    return () => {
      if (autosaveTimeoutRef.current) {
        globalThis.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [
    currentPersistenceSignature,
    currentProjectId,
    getProjectWriteState,
    saveCurrentProject,
    writeFailureVersion,
  ]);

  return {
    acknowledgeRemoteDeletion: (projectId: string) => {
      setProjectSyncState(current =>
        current.kind === 'remoteDeleted' && current.projectId === projectId
          ? { kind: 'idle' }
          : current
      );
      setStorageError(current => (current === t(REMOTE_PROJECT_DELETED_MESSAGE) ? null : current));
    },
    applyPersistedProjectRevision,
    completeProjectHydration,
    createFolder: async (args: { name: string; parentFolderId?: string | null }) => {
      const folder = await projectRepositoryRef.current.createFolder(args);
      await refreshLibraryOrganization();
      return folder;
    },
    currentProjectId,
    getCurrentProjectId: () => currentProjectIdRef.current,
    deleteStoredProject: async (projectId: string) => {
      await projectRepositoryRef.current.deleteProject(projectId);
      await refreshLibraryState();
    },
    deleteFolder: async (folderId: string) => {
      await projectRepositoryRef.current.deleteFolder(folderId);
      await refreshLibraryOrganization();
    },
    downloadProject,
    downloadLibraryBackup,
    importLibraryBackup,
    importProjectArchive: async (archive: Blob, targetProjectId: string) => {
      setProjectSyncState({ kind: 'import', phase: 'pending' });
      try {
        const imported = await projectRepositoryRef.current.importProjectArchive(
          archive,
          targetProjectId
        );
        setProjectSyncState({ kind: 'idle' });
        return imported;
      } catch (error) {
        setProjectSyncState({ kind: 'import', message: getErrorMessage(error), phase: 'failed' });
        throw error;
      }
    },
    importProjectData: async (data: unknown) => {
      setProjectSyncState({ kind: 'import', phase: 'pending' });
      try {
        const imported = await projectRepositoryRef.current.importProject(data);
        await refreshLibraryState();
        setProjectSyncState({ kind: 'idle' });
        return imported;
      } catch (error) {
        setProjectSyncState({ kind: 'import', message: getErrorMessage(error), phase: 'failed' });
        throw error;
      }
    },
    isLibraryLoading,
    isProjectHydratedRef,
    libraryFolders,
    libraryPlacements,
    libraryTree,
    loadProjectsById,
    loadStoredProject,
    loadStoredProjectWithRevision,
    loadStoredProjectCover,
    loadStoredProjectSource,
    loadStoredProjectSources,
    moveFolder: async (folderId: string, parentFolderId: string | null, targetIndex?: number) => {
      const nextFolder = await projectRepositoryRef.current.moveFolder(
        folderId,
        parentFolderId,
        targetIndex
      );
      await refreshLibraryOrganization();
      return nextFolder;
    },
    moveProjects: async (projectIds: string[], folderId: string | null, targetIndex?: number) => {
      const nextPlacements = await projectRepositoryRef.current.moveProjects(
        projectIds,
        folderId,
        targetIndex
      );
      await refreshLibraryOrganization();
      return nextPlacements;
    },
    persistSnapshot,
    refreshLibraryOrganization,
    refreshLibraryState,
    refreshSavedProjects,
    renameFolder: async (folderId: string, name: string) => {
      const nextFolder = await projectRepositoryRef.current.renameFolder(folderId, name);
      await refreshLibraryOrganization();
      return nextFolder;
    },
    renameProject,
    saveStoredProjectCover,
    saveCurrentProject,
    saveLessonArtifactNote,
    replaceLessonGeneratedVisual,
    patchCurrentProject,
    patchSectionLessonContent,
    patchSectionAnnotations,
    projectSyncState,
    savedProjects,
    setProjectFavorite,
    setCurrentProjectId: selectCurrentProject,
    setProjectHydrated: (value: boolean) => {
      isProjectHydratedRef.current = value;
      if (value) {
        lastPersistedSignatureRef.current = currentPersistenceSignature;
        void processPendingRemoteRevisionRef.current();
      }
    },
    storageError,
    touchStoredProject: (projectId: string) =>
      runDeletionAwareProjectAction(projectId, () =>
        projectRepositoryRef.current.touchProject(projectId)
      ),
    validateStoredProjectForOpen,
  };
};

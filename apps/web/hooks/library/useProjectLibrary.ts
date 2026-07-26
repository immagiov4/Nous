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
  LibraryArchiveRollbackError,
  readLibraryArchive,
  restoreLibraryArchiveOrganization,
} from '../../services/projects/libraryArchive.ts';
import { buildAutosaveSignature } from '../../services/projects/persistenceSignature';
import {
  createProjectArchiveBlob,
  getProjectArchiveExtension,
} from '../../services/projects/projectArchive.ts';
import {
  type ProjectSaveResult,
  ProjectStorageError,
} from '../../services/projects/projectRepository';
import {
  createProjectId,
  createProjectSnapshot,
  normalizeImportedProject,
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

interface PersistSnapshotOptions {
  archiveFile?: File;
  throwOnError?: boolean;
}

type LessonGeneratedVisualInput = NonNullable<LearningSection['generatedVisuals']>[number];

const sortProjects = (projects: SavedProjectMeta[]) =>
  projects
    .slice()
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

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
  const [writeFailureVersion, setWriteFailureVersion] = useState(0);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const attemptedAutosaveSignatureRef = useRef<string | null>(null);
  const handledWriteFailureVersionRef = useRef(0);
  const isProjectHydratedRef = useRef(false);
  const persistentStorageRequestedRef = useRef(false);
  const didLoadInitialStateRef = useRef(false);
  const lastPersistedSignatureRef = useRef<string>('');
  const pendingWriteCountRef = useRef<number>(0);
  const trackedWriteBatchFailedRef = useRef(false);
  const trackedWriteBatchNeedsAutosaveRef = useRef(false);
  const projectWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRemoteRevisionRef = useRef<ProjectRevisionEvent | null>(null);
  const isApplyingRemoteRevisionRef = useRef(false);
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

  const getExpectedRevision = useCallback((projectId: string): number | undefined => {
    if (loadedProjectRevisionRef.current.projectId === projectId) {
      return loadedProjectRevisionRef.current.revision;
    }
    return savedProjectsRef.current.find(project => project.id === projectId)?.revision;
  }, []);

  const applyPersistedProjectRevision = useCallback(
    async ({ projectId, revision }: { projectId: string; revision: number }): Promise<boolean> => {
      await projectWriteQueueRef.current;
      if (currentProjectIdRef.current !== projectId) return false;

      const localSignature = buildAutosaveSignature(domainStateRef.current);
      if (localSignature !== lastPersistedSignatureRef.current) {
        throw new ProjectStorageError(
          'Il corso contiene modifiche locali non ancora sincronizzate. Attendi il salvataggio e riprova.',
          'revision-conflict'
        );
      }

      const persisted = await projectRepositoryRef.current.loadProjectWithRevision(projectId);
      if (!persisted || persisted.revision < revision) {
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
    [rememberExplicitProjectTitle, syncProjectMeta]
  );

  const runTrackedProjectWrite = useCallback(
    (operation: () => Promise<SavedProjectMeta>, retryFullSnapshotOnFailure = true) => {
      if (pendingWriteCountRef.current === 0) {
        trackedWriteBatchFailedRef.current = false;
        trackedWriteBatchNeedsAutosaveRef.current = false;
      }
      pendingWriteCountRef.current += 1;
      const queuedWrite = projectWriteQueueRef.current.then(async () => {
        try {
          const meta = await operation();
          syncProjectMeta(meta);
          return meta;
        } catch (error) {
          trackedWriteBatchFailedRef.current = true;
          if (retryFullSnapshotOnFailure) {
            trackedWriteBatchNeedsAutosaveRef.current = true;
          }
          throw error;
        } finally {
          pendingWriteCountRef.current -= 1;
          if (
            pendingWriteCountRef.current === 0 &&
            trackedWriteBatchFailedRef.current &&
            trackedWriteBatchNeedsAutosaveRef.current
          ) {
            setWriteFailureVersion(version => version + 1);
          }
          globalThis.setTimeout(() => {
            void processPendingRemoteRevisionRef.current();
          }, 0);
        }
      });
      projectWriteQueueRef.current = queuedWrite.then(
        () => undefined,
        () => undefined
      );
      return queuedWrite;
    },
    [syncProjectMeta]
  );

  const requestPersistentStorage = useCallback(async () => {
    if (persistentStorageRequestedRef.current) {
      return;
    }

    persistentStorageRequestedRef.current = true;

    if (
      typeof globalThis.window === 'undefined' ||
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
          overrides?.researchDossiersBySectionId !== undefined
            ? overrides.researchDossiersBySectionId
            : domainState.researchDossiersBySectionId,
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
        const meta = await runTrackedProjectWrite(async () => {
          const saved = await projectRepositoryRef.current.saveProject(snapshot, {
            archiveFile: options.archiveFile,
            expectedRevision: getExpectedRevision(snapshot.id),
          });
          detachedSnapshot = saved.snapshot;
          return saved.meta;
        }, false);
        if (detachedSnapshot && domainStateRef.current.source === snapshot.source) {
          lastPersistedSignatureRef.current = buildAutosaveSignature(detachedSnapshot);
          setSourceRef.current(detachedSnapshot.source);
        }
        if (pendingWriteCountRef.current === 0 && !trackedWriteBatchFailedRef.current) {
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
    [getExpectedRevision, requestPersistentStorage, runTrackedProjectWrite]
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
        // Anti-data-loss guard: se chi chiama passa documentIndex:null ma in memoria
        // ce n'è uno valido, è quasi sempre un mapping PDF fallito (vedi
        // preparePdfLessonMappings) — non vogliamo sovrascrivere l'indice buono.
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

      try {
        const meta = await runTrackedProjectWrite(() =>
          projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision: getExpectedRevision(currentProjectId),
          })
        );
        if (pendingWriteCountRef.current === 0 && !trackedWriteBatchFailedRef.current) {
          setStorageError(null);
          lastPersistedSignatureRef.current = buildAutosaveSignature({
            ...domainStateRef.current,
            ...overrides,
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
    [currentProjectId, getExpectedRevision, requestPersistentStorage, runTrackedProjectWrite]
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
    ): Promise<void> => {
      if (!currentProjectId) return;

      const patch: Record<string, unknown> = {
        section: { sectionId, annotations, content, generatedVisuals },
        updatedAt: timestampIso(),
      };

      try {
        markSyncSaving();
        await runTrackedProjectWrite(() =>
          projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision: getExpectedRevision(currentProjectId),
          })
        );
        if (pendingWriteCountRef.current === 0 && !trackedWriteBatchFailedRef.current) {
          setStorageError(null);
          lastPersistedSignatureRef.current = buildAutosaveSignature(domainStateRef.current);
          markSyncSaved();
        } else {
          markSyncError();
        }
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        markSyncError();
      }
    },
    [currentProjectId, getExpectedRevision, runTrackedProjectWrite]
  );

  const patchSectionLessonContent = useCallback(
    async (
      sectionId: string,
      patchValue: Partial<
        Pick<
          LearningSection,
          | 'content'
          | 'contentBlocks'
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

      try {
        await runTrackedProjectWrite(() =>
          projectRepositoryRef.current.patchProject(currentProjectId, patch, {
            expectedRevision: getExpectedRevision(currentProjectId),
          })
        );
        if (pendingWriteCountRef.current === 0 && !trackedWriteBatchFailedRef.current) {
          setStorageError(null);
          lastPersistedSignatureRef.current = buildAutosaveSignature(domainStateRef.current);
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
    [currentProjectId, getExpectedRevision, requestPersistentStorage, runTrackedProjectWrite]
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
      const snapshot = await projectRepositoryRef.current.loadProject(projectId);
      const learningPlan = snapshot?.learningPlan;
      const sectionNode = learningPlan ? findPathNodeById(learningPlan.modules, lessonId) : null;
      const section = sectionNode?.kind === 'lesson' ? sectionNode : null;
      if (!snapshot || !learningPlan || !section) {
        return { saved: false, error: t('Non ho trovato la lezione target in questo corso.') };
      }

      const annotationResult = createLessonSectionAnnotation({
        annotations: section.annotations,
        artifactRefs,
        note,
      });
      const visualById = new Map(
        (section.generatedVisuals || []).map(visual => [visual.id, visual])
      );
      (generatedVisuals || []).forEach(visual => {
        if (!visualById.has(visual.id)) {
          visualById.set(visual.id, visual);
        }
      });

      await runTrackedProjectWrite(() =>
        projectRepositoryRef.current.patchProject(
          projectId,
          {
            section: {
              sectionId: lessonId,
              annotations: annotationResult.annotations,
              generatedVisuals: Array.from(visualById.values()),
            },
            updatedAt: timestampIso(),
          },
          { expectedRevision: getExpectedRevision(projectId) }
        )
      );
      return { annotationId: annotationResult.annotationId, saved: true };
    },
    [getExpectedRevision, runTrackedProjectWrite]
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
      visual: LessonGeneratedVisualInput;
    }): Promise<{ error?: string; replaced: boolean }> => {
      const snapshot = await projectRepositoryRef.current.loadProject(projectId);
      const learningPlan = snapshot?.learningPlan;
      const sectionNode = learningPlan ? findPathNodeById(learningPlan.modules, lessonId) : null;
      const section = sectionNode?.kind === 'lesson' ? sectionNode : null;
      if (!snapshot || !learningPlan || !section) {
        return { replaced: false, error: t('Non ho trovato la lezione target in questo corso.') };
      }

      const nextGeneratedVisuals = replaceGeneratedVisualPreservingId({
        artifactId,
        replacementVisual: visual,
        visuals: section.generatedVisuals,
      });
      if (!nextGeneratedVisuals) {
        return { replaced: false, error: t('Non ho trovato l artefatto da sostituire.') };
      }

      await runTrackedProjectWrite(() =>
        projectRepositoryRef.current.patchProject(
          projectId,
          {
            section: {
              sectionId: lessonId,
              generatedVisuals: nextGeneratedVisuals,
            },
            updatedAt: timestampIso(),
          },
          { expectedRevision: getExpectedRevision(projectId) }
        )
      );
      return { replaced: true };
    },
    [getExpectedRevision, runTrackedProjectWrite]
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

      const archive = await createProjectArchiveBlob(normalizeImportedProject(exportData));
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
      projects.push(normalizeImportedProject(exportData));
    }

    const archive = await createLibraryArchiveBlob(projects, { folders, placements });
    downloadBlob(
      archive,
      `nous-library-backup-${timestampIso().slice(0, 10)}${getLibraryArchiveExtension()}`
    );
    return projects.length;
  }, [downloadBlob]);

  const importLibraryBackup = useCallback(
    async (file: File): Promise<number> => {
      const archive = await readLibraryArchive(file);
      const projectIdMap = new Map<string, string>();
      const importedProjectIds: string[] = [];
      try {
        for (const project of archive.projects) {
          const originalProjectId = project.id;
          if (!originalProjectId) {
            throw new Error('Il backup contiene un corso senza identificatore.');
          }
          const importedProjectId = createProjectId();
          importedProjectIds.push(importedProjectId);
          const imported = await projectRepositoryRef.current.importProject({
            ...project,
            id: importedProjectId,
          });
          if (imported.snapshot.id !== importedProjectId) {
            throw new Error('Il server ha restituito un identificatore corso inatteso.');
          }
          projectIdMap.set(originalProjectId, importedProjectId);
        }
        await restoreLibraryArchiveOrganization(
          projectRepositoryRef.current,
          archive,
          projectIdMap
        );
      } catch (error) {
        let rollbackFailed = error instanceof LibraryArchiveRollbackError;
        for (const projectId of importedProjectIds.reverse()) {
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
          throw new ProjectStorageError(
            'L’importazione è stata interrotta, ma alcuni elementi potrebbero essere rimasti nella libreria.',
            'persistence-failed'
          );
        }
        throw error;
      }
      await refreshLibraryState();
      return archive.projects.length;
    },
    [refreshLibraryState]
  );

  const processPendingRemoteRevision = useCallback(async (): Promise<void> => {
    const pendingEvent = pendingRemoteRevisionRef.current;
    const loadedProject = loadedProjectRevisionRef.current;
    if (!pendingEvent || pendingEvent.projectId !== currentProjectIdRef.current) {
      return;
    }
    if (pendingEvent.deleted) {
      pendingRemoteRevisionRef.current = null;
      setStorageError(t("Il corso aperto è stato eliminato in un'altra sessione."));
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

    const hasLocalChanges =
      pendingWriteCountRef.current > 0 ||
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
      const snapshot = await projectRepositoryRef.current.loadProject(pendingEvent.projectId);
      if (!snapshot || pendingWriteCountRef.current > 0) {
        return;
      }
      rememberExplicitProjectTitle(snapshot);
      if (buildAutosaveSignature(domainStateRef.current) !== lastPersistedSignatureRef.current) {
        return;
      }

      const latestPendingEvent = pendingRemoteRevisionRef.current;
      if (!latestPendingEvent || latestPendingEvent.projectId !== pendingEvent.projectId) {
        return;
      }
      const hydratedSnapshot = prepareSnapshotForHydration(snapshot);
      pendingRemoteRevisionRef.current = null;
      loadedProjectRevisionRef.current = {
        projectId: pendingEvent.projectId,
        revision: latestPendingEvent.revision,
      };
      lastPersistedSignatureRef.current = buildAutosaveSignature(hydratedSnapshot);
      hydrateSnapshotRef.current(hydratedSnapshot);
      setStorageError(null);
    } catch (error) {
      console.warn('[Nous] Remote project revision could not be applied', error);
    } finally {
      isApplyingRemoteRevisionRef.current = false;
    }
  }, [rememberExplicitProjectTitle]);

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
        pendingRemoteRevisionRef.current = {
          deleted: true,
          projectId,
          revision: loadedRevision + 1,
        };
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
    await processPendingRemoteRevisionRef.current();
  }, [storeSavedProjects]);

  const requestRevisionCatchUp = useCallback(() => {
    void reconcileProjectRevisions().catch(error => {
      console.warn('[Nous] Project revision catch-up failed', error);
    });
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
    if (typeof globalThis.window === 'undefined') {
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
      } catch (error) {
        setStorageError(getErrorMessage(error));
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
      projectRepositoryRef.current.saveProjectCover(projectId, cover),
    []
  );

  const renameProject = useCallback(
    async (projectId: string, title: string) => {
      const meta = await runTrackedProjectWrite(
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

    if (pendingWriteCountRef.current > 0) {
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
  }, [currentPersistenceSignature, currentProjectId, saveCurrentProject, writeFailureVersion]);

  return {
    applyPersistedProjectRevision,
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
    importProjectData: async (data: unknown) => {
      const imported = await projectRepositoryRef.current.importProject(data);
      await refreshLibraryState();
      return imported;
    },
    isLibraryLoading,
    isProjectHydratedRef,
    libraryFolders,
    libraryPlacements,
    libraryTree,
    loadProjectsById,
    loadStoredProject,
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
    touchStoredProject: (projectId: string) => projectRepositoryRef.current.touchProject(projectId),
  };
};

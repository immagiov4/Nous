import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import { buildAutosaveSignature } from '../../services/projects/persistenceSignature';
import {
  createProjectArchiveBlob,
  getProjectArchiveExtension,
} from '../../services/projects/projectArchive.ts';
import { ProjectStorageError } from '../../services/projects/projectRepository';
import {
  createProjectRepository,
  type ProjectRepositoryMode,
} from '../../services/projects/projectRepositoryFactory';
import {
  createProjectSnapshot,
  normalizeImportedProject,
} from '../../services/projects/projectSnapshot';
import { markSyncError, markSyncSaved, markSyncSaving } from '../../services/projects/syncState.ts';
import { resolvePersistedAppState } from '../../services/workspace/persistence';
import type {
  LearningSection,
  LibraryFolder,
  LibraryPlacement,
  LibraryTree,
  ProjectSnapshot,
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
}

type LessonGeneratedVisualInput = NonNullable<LearningSection['generatedVisuals']>[number];

const sortProjects = (projects: SavedProjectMeta[]) =>
  projects
    .slice()
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

export const useProjectLibrary = ({ domainState }: UseProjectLibraryArgs) => {
  const projectRepositoryMode: ProjectRepositoryMode = 'server';
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([]);
  const [libraryPlacements, setLibraryPlacements] = useState<LibraryPlacement[]>([]);
  const [savedProjects, setSavedProjects] = useState<SavedProjectMeta[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const isProjectHydratedRef = useRef(false);
  const persistentStorageRequestedRef = useRef(false);
  const didLoadInitialStateRef = useRef(false);
  const lastPersistedSignatureRef = useRef<string>('');
  const pendingPatchCountRef = useRef<number>(0);
  const domainStateRef = useRef<WorkspaceDomainState>(domainState);

  const projectRepository = useMemo(() => createProjectRepository(), []);
  const projectRepositoryRef = useRef(projectRepository);

  useEffect(() => {
    domainStateRef.current = domainState;
  }, [domainState]);

  useEffect(() => {
    projectRepositoryRef.current = projectRepository;
  }, [projectRepository]);

  const currentProjectMeta = useMemo(
    () => savedProjects.find(project => project.id === currentProjectId) || null,
    [currentProjectId, savedProjects]
  );

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
    setSavedProjects(sortProjects(projects));
    setStorageError(null);
  }, []);

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

  const syncProjectMeta = useCallback((meta: SavedProjectMeta) => {
    setSavedProjects(previousProjects => {
      const nextProjects = previousProjects.filter(project => project.id !== meta.id);
      nextProjects.push(meta);
      return sortProjects(nextProjects);
    });
  }, []);

  const requestPersistentStorage = useCallback(async () => {
    if (persistentStorageRequestedRef.current) {
      return;
    }

    persistentStorageRequestedRef.current = true;

    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.storage?.persist) {
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
    async (snapshot: ProjectSnapshot) => {
      // Anti-data-loss guard: se è uno scrivimento di un progetto già esistente con
      // sourceFile registrata in meta ma lo snapshot ha source nullo, evitiamo di
      // sovrascrivere il PDF persistito. (Non blocca il primo salvataggio: se non c'è
      // ancora una meta, non c'è nulla da proteggere.)
      const matchingMeta = savedProjects.find(project => project.id === snapshot.id);
      if (matchingMeta?.hasSourceFile && snapshot.source == null) {
        console.warn(
          '[Nous][persistSnapshot] Aborted: snapshot.source is null but stored meta reports a source. Refusing to overwrite stored source.',
          { projectId: snapshot.id, sourceKind: matchingMeta.sourceKind }
        );
        return null;
      }

      try {
        const meta = await projectRepositoryRef.current.saveProject(snapshot);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildAutosaveSignature(snapshot);
        void requestPersistentStorage();
        return meta;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        markSyncError();
        return null;
      }
    },
    [requestPersistentStorage, savedProjects, syncProjectMeta]
  );

  const saveCurrentProject = useCallback(
    async (overrides?: Partial<ProjectSnapshot>) => {
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

      return persistSnapshot(snapshot);
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
        const meta = await projectRepositoryRef.current.patchProject(currentProjectId, patch);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildAutosaveSignature({
          ...domainStateRef.current,
          ...overrides,
        });
        void requestPersistentStorage();
        return meta;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        return null;
      }
    },
    [currentProjectId, requestPersistentStorage, syncProjectMeta]
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

      // Increment before the await so the autosave effect skips while the patch
      // is in-flight. Decremented in finally regardless of success/failure.
      pendingPatchCountRef.current++;
      try {
        markSyncSaving();
        const meta = await projectRepositoryRef.current.patchProject(currentProjectId, patch);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildAutosaveSignature(domainStateRef.current);
        markSyncSaved();
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        markSyncError();
      } finally {
        pendingPatchCountRef.current--;
      }
    },
    [currentProjectId, syncProjectMeta]
  );

  const patchSectionLessonContent = useCallback(
    async (
      sectionId: string,
      patchValue: Pick<LearningSection, 'content' | 'generatedVisuals' | 'imageRefs' | 'quiz'>
    ): Promise<void> => {
      if (!currentProjectId) return;

      const patch: Record<string, unknown> = {
        section: { sectionId, ...patchValue },
        updatedAt: timestampIso(),
      };

      try {
        const meta = await projectRepositoryRef.current.patchProject(currentProjectId, patch);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildAutosaveSignature(domainStateRef.current);
        void requestPersistentStorage();
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
      }
    },
    [currentProjectId, requestPersistentStorage, syncProjectMeta]
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
        return { saved: false, error: 'Non ho trovato la lezione target in questo corso.' };
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

      const meta = await projectRepositoryRef.current.patchProject(projectId, {
        section: {
          sectionId: lessonId,
          annotations: annotationResult.annotations,
          generatedVisuals: Array.from(visualById.values()),
        },
        updatedAt: timestampIso(),
      });
      syncProjectMeta(meta);
      return { annotationId: annotationResult.annotationId, saved: true };
    },
    [syncProjectMeta]
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
        return { replaced: false, error: 'Non ho trovato la lezione target in questo corso.' };
      }

      const nextGeneratedVisuals = replaceGeneratedVisualPreservingId({
        artifactId,
        replacementVisual: visual,
        visuals: section.generatedVisuals,
      });
      if (!nextGeneratedVisuals) {
        return { replaced: false, error: 'Non ho trovato l artefatto da sostituire.' };
      }

      const meta = await projectRepositoryRef.current.patchProject(projectId, {
        section: {
          sectionId: lessonId,
          generatedVisuals: nextGeneratedVisuals,
        },
        updatedAt: timestampIso(),
      });
      syncProjectMeta(meta);
      return { replaced: true };
    },
    [syncProjectMeta]
  );

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', objectUrl);
    downloadAnchorNode.setAttribute('download', filename);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }, []);

  const downloadProject = useCallback(
    async (projectId?: string) => {
      const targetProjectId = projectId || currentProjectId;
      if (!targetProjectId) {
        return;
      }

      const exportData = await projectRepositoryRef.current.exportProject(targetProjectId);

      if (!exportData) {
        return;
      }

      const archive = await createProjectArchiveBlob(normalizeImportedProject(exportData));
      downloadBlob(
        archive,
        `nous-backup-${timestampIso().slice(0, 10)}${getProjectArchiveExtension()}`
      );
    },
    [currentProjectId, downloadBlob]
  );

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
    };

    void loadInitialState();
  }, [refreshLibraryState]);

  const currentPersistenceSignature = useMemo(
    () => buildAutosaveSignature(domainState),
    [domainState]
  );

  // Autosave: full snapshot PUT — safety net for any domain change that wasn't
  // already handled by an explicit patch. No sync indicator (background work).
  // Hot paths (highlight, note) call patchSectionAnnotations first, which updates
  // lastPersistedSignature — suppressing this fallback.
  useEffect(() => {
    if (!currentProjectId || !isProjectHydratedRef.current) {
      return;
    }

    if (currentPersistenceSignature === lastPersistedSignatureRef.current) {
      return;
    }

    if (pendingPatchCountRef.current > 0) {
      return;
    }

    if (autosaveTimeoutRef.current) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      void saveCurrentProject();
    }, 400);

    return () => {
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [currentPersistenceSignature, currentProjectId, saveCurrentProject]);

  return {
    createFolder: async (args: { name: string; parentFolderId?: string | null }) => {
      const folder = await projectRepositoryRef.current.createFolder(args);
      await refreshLibraryOrganization();
      return folder;
    },
    currentProjectId,
    deleteStoredProject: async (projectId: string) => {
      await projectRepositoryRef.current.deleteProject(projectId);
      await refreshLibraryState();
    },
    deleteFolder: async (folderId: string) => {
      await projectRepositoryRef.current.deleteFolder(folderId);
      await refreshLibraryOrganization();
    },
    downloadProject,
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
    loadProjectsById: (ids: string[]) => projectRepositoryRef.current.loadProjectsById(ids),
    loadStoredProject: (projectId: string) => projectRepositoryRef.current.loadProject(projectId),
    loadStoredProjectSource: (projectId: string) =>
      projectRepositoryRef.current.loadProjectSource(projectId),
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
    saveCurrentProject,
    saveLessonArtifactNote,
    replaceLessonGeneratedVisual,
    patchCurrentProject,
    patchSectionLessonContent,
    patchSectionAnnotations,
    savedProjects,
    setCurrentProjectId,
    setProjectHydrated: (value: boolean) => {
      isProjectHydratedRef.current = value;
      if (value) {
        lastPersistedSignatureRef.current = currentPersistenceSignature;
      }
    },
    projectRepositoryMode,
    storageError,
    touchStoredProject: (projectId: string) => projectRepositoryRef.current.touchProject(projectId),
  };
};

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import { buildPersistenceSignature } from '../../services/projects/persistenceSignature';
import {
  createProjectArchiveBlob,
  getProjectArchiveExtension,
} from '../../services/projects/projectArchive.ts';
import { ProjectStorageError } from '../../services/projects/projectRepository';
import {
  createProjectRepository,
  getProjectRepositoryMode,
  type ProjectRepositoryMode,
  setProjectRepositoryMode as persistProjectRepositoryMode,
} from '../../services/projects/projectRepositoryFactory';
import { createProjectSnapshot } from '../../services/projects/projectSnapshot';
import {
  transferFolderToLanRepository,
  transferProjectToLanRepository,
} from '../../services/projects/projectTransfer';
import { resolvePersistedAppState } from '../../services/workspace/persistence';
import type {
  LibraryFolder,
  LibraryPlacement,
  LibraryTree,
  ProjectSnapshot,
  SavedProjectMeta,
  WorkspaceDomainState,
} from '../../types';
import { buildLibraryTree } from '../../utils/library/tree.ts';

interface UseProjectLibraryArgs {
  domainState: WorkspaceDomainState;
}

const sortProjects = (projects: SavedProjectMeta[]) =>
  projects
    .slice()
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

export const useProjectLibrary = ({ domainState }: UseProjectLibraryArgs) => {
  const [projectRepositoryMode, setProjectRepositoryModeState] = useState<ProjectRepositoryMode>(
    () => getProjectRepositoryMode()
  );
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
  const lastLoadedRepositoryModeRef = useRef<ProjectRepositoryMode | null>(null);

  const projectRepository = useMemo(
    () => createProjectRepository(projectRepositoryMode),
    [projectRepositoryMode]
  );
  const lanProjectRepository = useMemo(() => createProjectRepository('lan'), []);
  const projectRepositoryRef = useRef(projectRepository);
  projectRepositoryRef.current = projectRepository;

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
        laboratory:
          overrides?.laboratory !== undefined ? overrides.laboratory : domainState.laboratory,
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
        activeSectionId:
          overrides?.activeSectionId !== undefined
            ? overrides.activeSectionId
            : domainState.activeSectionId,
        activeLaboratoryExerciseId:
          overrides?.activeLaboratoryExerciseId !== undefined
            ? overrides.activeLaboratoryExerciseId
            : domainState.activeLaboratoryExerciseId,
        createdAt: overrides?.createdAt || currentProjectMeta?.createdAt,
        updatedAt: overrides?.updatedAt || new Date().toISOString(),
        lastOpenedAt: overrides?.lastOpenedAt || currentProjectMeta?.lastOpenedAt,
      });
    },
    [currentProjectId, currentProjectMeta, domainState]
  );

  const persistSnapshot = useCallback(
    async (snapshot: ProjectSnapshot) => {
      try {
        const meta = await projectRepositoryRef.current.saveProject(snapshot);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildPersistenceSignature(snapshot);
        void requestPersistentStorage();
        return meta;
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
        return null;
      }
    },
    [requestPersistentStorage, syncProjectMeta]
  );

  const saveCurrentProject = useCallback(
    async (overrides?: Partial<ProjectSnapshot>) => {
      const snapshot = buildSnapshotFromDomain(overrides);
      if (!snapshot) {
        return null;
      }

      return persistSnapshot(snapshot);
    },
    [buildSnapshotFromDomain, persistSnapshot]
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

      const exportData =
        targetProjectId === currentProjectId
          ? buildSnapshotFromDomain()
          : await projectRepositoryRef.current.loadProject(targetProjectId);

      if (!exportData) {
        return;
      }

      const archive = await createProjectArchiveBlob(exportData);
      downloadBlob(
        archive,
        `nous-backup-${new Date().toISOString().slice(0, 10)}${getProjectArchiveExtension()}`
      );
    },
    [buildSnapshotFromDomain, currentProjectId, downloadBlob]
  );

  const shouldSwitchToLanForProject = useCallback(
    (projectId: string) => currentProjectId === projectId,
    [currentProjectId]
  );

  const shouldSwitchToLanForFolder = useCallback(
    (folderId: string) => {
      if (!currentProjectId) {
        return false;
      }

      return Boolean(
        libraryTree.descendantProjectIdsByFolderId[folderId]?.includes(currentProjectId)
      );
    },
    [currentProjectId, libraryTree]
  );

  const transferProjectToLan = useCallback(
    async (projectId: string) => {
      if (projectRepositoryMode === 'lan') {
        return;
      }

      try {
        await transferProjectToLanRepository({
          projectId,
          sourceRepository: projectRepositoryRef.current,
          targetRepository: lanProjectRepository,
          tree: libraryTree,
        });

        if (shouldSwitchToLanForProject(projectId)) {
          persistProjectRepositoryMode('lan');
          setProjectRepositoryModeState('lan');
          return;
        }

        await refreshLibraryState();
        setStorageError(null);
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
      }
    },
    [
      lanProjectRepository,
      libraryTree,
      projectRepositoryMode,
      refreshLibraryState,
      shouldSwitchToLanForProject,
    ]
  );

  const transferFolderToLan = useCallback(
    async (folderId: string) => {
      if (projectRepositoryMode === 'lan') {
        return;
      }

      try {
        await transferFolderToLanRepository({
          folderId,
          sourceRepository: projectRepositoryRef.current,
          targetRepository: lanProjectRepository,
          tree: libraryTree,
        });

        if (shouldSwitchToLanForFolder(folderId)) {
          persistProjectRepositoryMode('lan');
          setProjectRepositoryModeState('lan');
          return;
        }

        await refreshLibraryState();
        setStorageError(null);
      } catch (error) {
        const message =
          error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
        setStorageError(message);
      }
    },
    [
      lanProjectRepository,
      libraryTree,
      projectRepositoryMode,
      refreshLibraryState,
      shouldSwitchToLanForFolder,
    ]
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
        lastLoadedRepositoryModeRef.current = projectRepositoryMode;
        setIsLibraryLoading(false);
      }
    };

    void loadInitialState();
  }, [projectRepositoryMode, refreshLibraryState]);

  useEffect(() => {
    if (lastLoadedRepositoryModeRef.current === null) {
      return;
    }

    if (lastLoadedRepositoryModeRef.current === projectRepositoryMode) {
      return;
    }

    let isActive = true;
    setIsLibraryLoading(true);

    const reloadLibraryState = async () => {
      try {
        await refreshLibraryState();
        if (isActive) {
          setStorageError(null);
        }
      } catch (error) {
        if (isActive) {
          setStorageError(getErrorMessage(error));
        }
      } finally {
        if (isActive) {
          setIsLibraryLoading(false);
        }
      }
    };

    void reloadLibraryState();
    lastLoadedRepositoryModeRef.current = projectRepositoryMode;

    return () => {
      isActive = false;
    };
  }, [projectRepositoryMode, refreshLibraryState]);

  const currentPersistenceSignature = useMemo(
    () => buildPersistenceSignature(domainState),
    [domainState]
  );

  useEffect(() => {
    if (!currentProjectId || !isProjectHydratedRef.current) {
      return;
    }

    if (currentPersistenceSignature === lastPersistedSignatureRef.current) {
      return;
    }

    if (autosaveTimeoutRef.current) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = window.setTimeout(() => {
      void saveCurrentProject();
    }, 800);

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
    savedProjects,
    setCurrentProjectId,
    setProjectHydrated: (value: boolean) => {
      isProjectHydratedRef.current = value;
      if (value) {
        lastPersistedSignatureRef.current = currentPersistenceSignature;
      }
    },
    projectRepositoryMode,
    setProjectRepositoryMode: (mode: ProjectRepositoryMode) => {
      if (mode === projectRepositoryMode) {
        return;
      }

      persistProjectRepositoryMode(mode);
      setProjectRepositoryModeState(mode);
    },
    storageError,
    transferFolderToLan,
    transferProjectToLan,
    touchStoredProject: (projectId: string) => projectRepositoryRef.current.touchProject(projectId),
  };
};

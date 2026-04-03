import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getErrorMessage } from '../../services/core/errorMessage.ts';
import {
  createProjectArchiveBlob,
  getProjectArchiveExtension,
} from '../../services/projects/projectArchive.ts';
import { IndexedDbProjectRepository } from '../../services/projects/indexedDbProjectRepository';
import { createProjectSnapshot } from '../../services/projects/projectSnapshot';
import { buildPersistenceSignature } from '../../services/projects/persistenceSignature';
import { ProjectStorageError } from '../../services/projects/projectRepository';
import { resolvePersistedAppState } from '../../services/workspace/persistence';
import type {
  ProjectSnapshot,
  SavedProjectMeta,
  WorkspaceDomainState,
} from '../../types';

const projectRepository = new IndexedDbProjectRepository();

interface UseProjectLibraryArgs {
  domainState: WorkspaceDomainState;
}

const sortProjects = (projects: SavedProjectMeta[]) =>
  projects
    .slice()
    .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());

export const useProjectLibrary = ({ domainState }: UseProjectLibraryArgs) => {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProjectMeta[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const isProjectHydratedRef = useRef(false);
  const persistentStorageRequestedRef = useRef(false);
  const didLoadInitialStateRef = useRef(false);
  const lastPersistedSignatureRef = useRef<string>('');

  const currentProjectMeta = useMemo(
    () => savedProjects.find(project => project.id === currentProjectId) || null,
    [currentProjectId, savedProjects]
  );

  const refreshSavedProjects = useCallback(async () => {
    const projects = await projectRepository.listProjects();
    setSavedProjects(sortProjects(projects));
  }, []);

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
        activeSectionId:
          overrides?.activeSectionId !== undefined
            ? overrides.activeSectionId
            : domainState.activeSectionId,
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
        const meta = await projectRepository.saveProject(snapshot);
        syncProjectMeta(meta);
        setStorageError(null);
        lastPersistedSignatureRef.current = buildPersistenceSignature(snapshot);
        void requestPersistentStorage();
        return meta;
      } catch (error) {
        const message = error instanceof ProjectStorageError ? error.message : getErrorMessage(error);
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
          : await projectRepository.loadProject(targetProjectId);

      if (!exportData) {
        return;
      }

      const archive = await createProjectArchiveBlob(exportData);
      downloadBlob(
        archive,
        `lumina-backup-${new Date().toISOString().slice(0, 10)}${getProjectArchiveExtension()}`
      );
    },
    [buildSnapshotFromDomain, currentProjectId, downloadBlob]
  );

  useEffect(() => {
    if (didLoadInitialStateRef.current) {
      return;
    }

    didLoadInitialStateRef.current = true;

    const loadInitialState = async () => {
      try {
        await refreshSavedProjects();
      } finally {
        setIsLibraryLoading(false);
      }
    };

    void loadInitialState();
  }, [refreshSavedProjects]);

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
    currentProjectId,
    deleteStoredProject: projectRepository.deleteProject.bind(projectRepository),
    downloadProject,
    importProjectData: projectRepository.importProject.bind(projectRepository),
    isLibraryLoading,
    isProjectHydratedRef,
    loadStoredProject: projectRepository.loadProject.bind(projectRepository),
    persistSnapshot,
    refreshSavedProjects,
    saveCurrentProject,
    savedProjects,
    setCurrentProjectId,
    setProjectHydrated: (value: boolean) => {
      isProjectHydratedRef.current = value;
      if (value) {
        lastPersistedSignatureRef.current = currentPersistenceSignature;
      }
    },
    storageError,
    touchStoredProject: projectRepository.touchProject.bind(projectRepository),
  };
};

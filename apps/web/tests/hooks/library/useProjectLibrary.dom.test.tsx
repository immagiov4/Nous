// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createLibraryArchiveBlob } from '../../../services/projects/libraryArchive.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';
import {
  AppState,
  type ProjectRevisionEvent,
  type ProjectSnapshot,
  type ProjectSource,
  type SavedProjectMeta,
  type WorkspaceDomainState,
} from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const repositoryMocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteProject: vi.fn(),
  deleteFolder: vi.fn(),
  exportProject: vi.fn(),
  importProjectArchive: vi.fn(),
  importProject: vi.fn(),
  listFolders: vi.fn(),
  listPlacements: vi.fn(),
  listProjects: vi.fn(),
  loadProject: vi.fn(),
  loadProjectWithRevision: vi.fn(),
  loadProjectCover: vi.fn(),
  loadProjectSource: vi.fn(),
  loadProjectsById: vi.fn(),
  moveFolder: vi.fn(),
  moveProjects: vi.fn(),
  patchProject: vi.fn(),
  renameFolder: vi.fn(),
  saveProject: vi.fn(),
  saveProjectCover: vi.fn(),
  setProjectFavorite: vi.fn(),
  subscribeToProjectRevisions: vi.fn(),
  touchProject: vi.fn(),
}));

let revisionListener: ((event: ProjectRevisionEvent) => void) | null = null;
let revisionReconnect: (() => void) | null = null;

vi.mock('../../../services/projects/httpProjectRepository.ts', () => ({
  HttpProjectRepository: vi.fn(function HttpProjectRepositoryMock() {
    return repositoryMocks;
  }),
}));

const { useProjectLibrary: useProjectLibraryHook } = await import(
  '../../../hooks/library/useProjectLibrary.ts'
);
type ProjectLibraryArgs = Parameters<typeof useProjectLibraryHook>[0];
const useProjectLibrary = (
  args: Omit<ProjectLibraryArgs, 'setSource'> & Partial<Pick<ProjectLibraryArgs, 'setSource'>>
) => useProjectLibraryHook({ ...args, setSource: args.setSource || vi.fn() });

const buildMeta = (id: string, lastOpenedAt: string, revision = 1): SavedProjectMeta => ({
  id,
  title: `Project ${id}`,
  sourceKind: 'document',
  createdAt: lastOpenedAt,
  updatedAt: lastOpenedAt,
  lastOpenedAt,
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  revision,
});

const buildSnapshot = (id: string, overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id,
  version: '1',
  sourceKind: 'document',
  state: AppState.READING,
  source: null,
  learningPlan: null,
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: null,
  createdAt: '2026-04-02T10:00:00.000Z',
  updatedAt: '2026-04-02T10:00:00.000Z',
  lastOpenedAt: '2026-04-02T10:00:00.000Z',
  ...overrides,
});

describe('useProjectLibrary', () => {
  beforeEach(() => {
    if (typeof globalThis.window !== 'undefined') {
      const store = new Map<string, string>();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
          clear: () => store.clear(),
          key: () => null,
          length: 0,
        },
      });
    }

    repositoryMocks.createFolder.mockReset();
    repositoryMocks.deleteProject.mockReset();
    repositoryMocks.deleteFolder.mockReset();
    repositoryMocks.exportProject.mockReset();
    repositoryMocks.importProjectArchive.mockReset();
    repositoryMocks.importProject.mockReset();
    repositoryMocks.listFolders.mockReset();
    repositoryMocks.listPlacements.mockReset();
    repositoryMocks.listProjects.mockReset();
    repositoryMocks.loadProject.mockReset();
    repositoryMocks.loadProjectWithRevision.mockReset();
    repositoryMocks.loadProjectCover.mockReset();
    repositoryMocks.loadProjectSource.mockReset();
    repositoryMocks.loadProjectsById.mockReset();
    repositoryMocks.moveFolder.mockReset();
    repositoryMocks.moveProjects.mockReset();
    repositoryMocks.renameFolder.mockReset();
    repositoryMocks.saveProject.mockReset();
    repositoryMocks.saveProjectCover.mockReset();
    repositoryMocks.setProjectFavorite.mockReset();
    repositoryMocks.patchProject.mockReset();
    repositoryMocks.subscribeToProjectRevisions.mockReset();
    repositoryMocks.touchProject.mockReset();

    repositoryMocks.createFolder.mockImplementation(
      async ({ name, parentFolderId }: { name: string; parentFolderId?: string | null }) => ({
        id: 'folder-1',
        name,
        parentFolderId: parentFolderId ?? null,
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        order: 1,
      })
    );
    repositoryMocks.listProjects.mockResolvedValue([]);
    repositoryMocks.listFolders.mockResolvedValue([]);
    repositoryMocks.listPlacements.mockResolvedValue([]);
    repositoryMocks.loadProjectsById.mockResolvedValue([]);
    repositoryMocks.moveFolder.mockResolvedValue(null);
    repositoryMocks.moveProjects.mockResolvedValue([]);
    repositoryMocks.renameFolder.mockResolvedValue(null);
    repositoryMocks.saveProject.mockImplementation(async (snapshot: ProjectSnapshot) => ({
      meta: buildMeta(snapshot.id, snapshot.updatedAt),
      snapshot,
    }));
    repositoryMocks.loadProject.mockResolvedValue(null);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue(null);
    repositoryMocks.importProject.mockImplementation(async (project: ProjectSnapshot) => ({
      meta: buildMeta(project.id, '2026-04-02T10:00:00.000Z'),
      snapshot: buildSnapshot(project.id),
    }));
    repositoryMocks.importProjectArchive.mockImplementation(
      async (_archive: Blob, targetProjectId: string) => ({
        meta: buildMeta(targetProjectId, '2026-04-02T10:00:00.000Z'),
        snapshot: buildSnapshot(targetProjectId),
      })
    );
    revisionListener = null;
    revisionReconnect = null;
    repositoryMocks.subscribeToProjectRevisions.mockImplementation(
      (listener: typeof revisionListener, onReconnect: () => void) => {
        revisionListener = listener;
        revisionReconnect = onReconnect;
        return () => {};
      }
    );
  });

  test('loads and sorts saved projects by last opened time', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('older', '2026-04-01T10:00:00.000Z'),
      buildMeta('newer', '2026-04-02T10:00:00.000Z'),
    ]);

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    expect(result.current.savedProjects.map(project => project.id)).toEqual(['newer', 'older']);
  });

  test('renames a project with a granular title patch and syncs the visible metadata', async () => {
    const originalMeta = buildMeta('course', '2026-04-02T10:00:00.000Z', 4);
    repositoryMocks.listProjects.mockResolvedValue([originalMeta]);
    repositoryMocks.patchProject.mockResolvedValue({
      ...originalMeta,
      title: 'Titolo nuovo',
      revision: 5,
    });

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    act(() => result.current.setCurrentProjectId('course'));
    expect(result.current.getCurrentProjectId()).toBe('course');

    await act(async () => {
      await result.current.renameProject('course', 'Titolo nuovo');
    });

    expect(repositoryMocks.patchProject).toHaveBeenCalledWith(
      'course',
      { title: 'Titolo nuovo', updatedAt: expect.any(String) },
      { expectedRevision: 4 }
    );
    expect(result.current.savedProjects[0]).toMatchObject({
      title: 'Titolo nuovo',
      revision: 5,
    });
  });

  test('serializes favorite writes and immediately syncs returned server metadata', async () => {
    const originalMeta = buildMeta('course', '2026-04-02T10:00:00.000Z', 4);
    repositoryMocks.listProjects.mockResolvedValue([originalMeta]);
    repositoryMocks.setProjectFavorite.mockResolvedValue({
      ...originalMeta,
      isFavorite: true,
      revision: 5,
    });

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.setProjectFavorite('course', true);
    });

    expect(repositoryMocks.setProjectFavorite).toHaveBeenCalledWith('course', true);
    expect(result.current.savedProjects[0]).toMatchObject({ isFavorite: true, revision: 5 });
  });

  test('keeps snapshot and source loaders stable across workspace rerenders', async () => {
    const { rerender, result } = renderHook(
      ({ domainState }: { domainState: WorkspaceDomainState }) =>
        useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      { initialProps: { domainState: createEmptyWorkspaceDomainState() } }
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    const initialLoaders = {
      loadProjectsById: result.current.loadProjectsById,
      loadStoredProject: result.current.loadStoredProject,
      loadStoredProjectCover: result.current.loadStoredProjectCover,
      loadStoredProjectSource: result.current.loadStoredProjectSource,
      saveStoredProjectCover: result.current.saveStoredProjectCover,
    };

    rerender({ domainState: createEmptyWorkspaceDomainState() });

    expect({
      loadProjectsById: result.current.loadProjectsById,
      loadStoredProject: result.current.loadStoredProject,
      loadStoredProjectCover: result.current.loadStoredProjectCover,
      loadStoredProjectSource: result.current.loadStoredProjectSource,
      saveStoredProjectCover: result.current.saveStoredProjectCover,
    }).toEqual(initialLoaders);
  });

  test('imports folders and placements from a complete library backup', async () => {
    const timestamp = '2026-04-02T10:00:00.000Z';
    const archive = await createLibraryArchiveBlob([buildSnapshot('course-one')], {
      folders: [
        {
          id: 'old-folder',
          name: 'Matematica',
          parentFolderId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          order: 0,
        },
      ],
      placements: [
        { projectId: 'course-one', folderId: 'old-folder', order: 0, updatedAt: timestamp },
      ],
    });
    const file = new File([archive], 'library.nous-library.zip');
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.importLibraryBackup(file);
    });

    expect(repositoryMocks.importProjectArchive).toHaveBeenCalledTimes(1);
    const importedProjectId = repositoryMocks.importProjectArchive.mock.calls[0]?.[1];
    expect(importedProjectId).not.toBe('course-one');
    expect(repositoryMocks.createFolder).toHaveBeenCalledWith({
      name: 'Matematica',
      parentFolderId: null,
    });
    expect(repositoryMocks.moveProjects).toHaveBeenCalledWith([importedProjectId], 'folder-1', 0);
  });

  test('rolls back imported projects when restoring a library backup fails', async () => {
    const timestamp = '2026-04-02T10:00:00.000Z';
    const archive = await createLibraryArchiveBlob([buildSnapshot('course-one')], {
      folders: [],
      placements: [{ projectId: 'course-one', folderId: null, order: 0, updatedAt: timestamp }],
    });
    repositoryMocks.moveProjects.mockRejectedValueOnce(new Error('placement failed'));
    const file = new File([archive], 'library.nous-library.zip');
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await expect(result.current.importLibraryBackup(file)).rejects.toThrow('placement failed');

    expect(repositoryMocks.deleteProject).toHaveBeenCalledWith(
      repositoryMocks.importProjectArchive.mock.calls[0]?.[1]
    );
  });

  test('reports an incomplete rollback and refreshes visible library state', async () => {
    const timestamp = '2026-04-02T10:00:00.000Z';
    const archive = await createLibraryArchiveBlob([buildSnapshot('course-one')], {
      folders: [],
      placements: [{ projectId: 'course-one', folderId: null, order: 0, updatedAt: timestamp }],
    });
    repositoryMocks.moveProjects.mockRejectedValueOnce(new Error('placement failed'));
    repositoryMocks.deleteProject.mockRejectedValueOnce(new Error('cleanup failed'));
    const file = new File([archive], 'library.nous-library.zip');
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await expect(result.current.importLibraryBackup(file)).rejects.toThrow(
      /alcuni elementi potrebbero essere rimasti/iu
    );

    expect(repositoryMocks.listProjects).toHaveBeenCalledTimes(2);
  });

  test('clears a stale synchronization error after metadata refresh succeeds', async () => {
    repositoryMocks.listProjects.mockRejectedValueOnce(new Error('Sincronizzazione fallita'));
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.storageError).toBe('Sincronizzazione fallita'));
    repositoryMocks.listProjects.mockResolvedValue([]);

    await act(async () => {
      await result.current.refreshSavedProjects();
    });

    expect(result.current.storageError).toBeNull();
  });

  test('persistSnapshot syncs metadata and keeps the newest project first', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('older', '2026-04-01T10:00:00.000Z'),
    ]);

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.persistSnapshot(
        buildSnapshot('newer', {
          updatedAt: '2026-04-03T10:00:00.000Z',
          lastOpenedAt: '2026-04-03T10:00:00.000Z',
        })
      );
    });

    expect(result.current.savedProjects.map(project => project.id)).toEqual(['newer', 'older']);
  });

  test('persistSnapshot can propagate the original storage error for blocking workflows', async () => {
    repositoryMocks.listProjects.mockResolvedValue([]);
    repositoryMocks.saveProject.mockRejectedValue(
      new ProjectStorageError(
        'Il caricamento della sorgente ha superato il tempo disponibile.',
        'persistence-failed'
      )
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await expect(
      act(() =>
        result.current.persistSnapshot(buildSnapshot('archive-project'), {
          throwOnError: true,
        })
      )
    ).rejects.toThrow('Il caricamento della sorgente ha superato il tempo disponibile.');
  });

  test('applies the detached source without scheduling another full snapshot save', async () => {
    const embeddedSource: ProjectSource = {
      file: {
        data: 'UEsDBAo=',
        mimeType: 'application/zip',
        name: 'engine.zip',
      },
      index: { entries: [] },
      kind: 'archive',
      name: 'engine.zip',
    };
    const detachedSource: ProjectSource = {
      ...embeddedSource,
      file: { ...embeddedSource.file, data: '' },
      ref: {
        byteSize: 5,
        hash: 'archive-hash',
        id: 'source-archive',
        mimeType: 'application/zip',
        name: 'engine.zip',
        objectPath: 'users/user/projects/archive/source-archive/archive-hash/original',
      },
    };
    const initialState = {
      ...createEmptyWorkspaceDomainState(),
      source: embeddedSource,
    };
    const setSource = vi.fn();
    repositoryMocks.saveProject.mockImplementation(async (snapshot: ProjectSnapshot) => ({
      meta: buildMeta(snapshot.id, snapshot.updatedAt),
      snapshot: { ...snapshot, source: detachedSource },
    }));
    const { rerender, result } = renderHook(
      ({ domainState }) =>
        useProjectLibrary({
          domainState,
          hydrateSnapshot: vi.fn(),
          setSource,
        }),
      { initialProps: { domainState: initialState } }
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('archive-project');
      result.current.setProjectHydrated(true);
    });

    let savedSnapshot: ProjectSnapshot | undefined;
    await act(async () => {
      savedSnapshot = (
        await result.current.persistSnapshot(
          buildSnapshot('archive-project', {
            source: embeddedSource,
            sourceKind: 'codebase',
          })
        )
      )?.snapshot;
    });

    expect(savedSnapshot?.source).toEqual(detachedSource);
    expect(setSource).toHaveBeenCalledWith(detachedSource);
    vi.useFakeTimers();
    rerender({
      domainState: {
        ...initialState,
        source: detachedSource,
      },
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(repositoryMocks.saveProject).toHaveBeenCalledOnce();
  });

  test('autosaves only after the debounced persisted signature changes', async () => {
    const baseState = createEmptyWorkspaceDomainState();
    const nextState: WorkspaceDomainState = {
      ...baseState,
      learningPlan: {
        ...buildTestLearningPlan([], {
          title: 'Nuovo percorso',
          summary: 'Sintesi',
        }),
      },
    };

    const { result, rerender } = renderHook(
      ({ domainState }) => useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      {
        initialProps: { domainState: baseState },
      }
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    vi.useFakeTimers();

    rerender({ domainState: baseState });
    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();

    rerender({ domainState: nextState });
    act(() => {
      vi.advanceTimersByTime(399);
    });

    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(repositoryMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.saveProject.mock.calls[0][0]).toMatchObject({
      id: 'project-1',
      learningPlan: {
        title: 'Nuovo percorso',
      },
    });
  });

  test('hydrates the authoritative snapshot returned for a persisted lesson revision', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    const baseState = createEmptyWorkspaceDomainState();
    const generatedState: WorkspaceDomainState = {
      ...baseState,
      activeSectionId: 'lesson-1',
      learningPlan: buildTestLearningPlan(
        [buildTestLesson({ content: '# Lezione persistita', id: 'lesson-1' })],
        { title: 'Percorso', summary: 'Sintesi' }
      ),
    };
    const generatedSnapshot = buildSnapshot('project-1', generatedState);
    const hydrateSnapshot = vi.fn();
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 5,
      snapshot: generatedSnapshot,
    });
    const { result, rerender } = renderHook(
      ({ domainState }) => useProjectLibrary({ domainState, hydrateSnapshot }),
      { initialProps: { domainState: baseState } }
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });
    let shouldApplyResult = false;
    await act(async () => {
      shouldApplyResult = await result.current.applyPersistedProjectRevision({
        projectId: 'project-1',
        revision: 5,
      });
    });

    vi.useFakeTimers();
    rerender({ domainState: generatedState });
    await act(async () => {
      vi.advanceTimersByTime(900);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(shouldApplyResult).toBe(true);
    expect(hydrateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSectionId: 'lesson-1',
        id: 'project-1',
        learningPlan: generatedState.learningPlan,
      })
    );
    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();
    expect(result.current.savedProjects[0]).toMatchObject({ revision: 5 });
  });

  test('treats a missing persisted revision as authoritative remote deletion', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue(null);
    const hydrateSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot,
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let applied = true;
    await act(async () => {
      applied = await result.current.applyPersistedProjectRevision({
        projectId: 'project-1',
        revision: 5,
      });
    });

    expect(applied).toBe(false);
    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
      wasActive: true,
    });
    expect(result.current.storageError).toBe('Questo corso è stato cancellato');
    expect(hydrateSnapshot).not.toHaveBeenCalled();
  });

  test('records a tombstone when opening validation finds the course deleted', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    let validatedProject: unknown;
    await act(async () => {
      validatedProject = await result.current.validateStoredProjectForOpen('project-1');
    });

    expect(validatedProject).toBeNull();
    expect(result.current.savedProjects).toEqual([]);
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
      wasActive: false,
    });
    expect(result.current.storageError).toBe('Questo corso è stato cancellato');
  });

  test('completes hydration from the authoritative snapshot without treating it as a local edit', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    const baseState = createEmptyWorkspaceDomainState();
    const repairedState: WorkspaceDomainState = {
      ...baseState,
      activeSectionId: 'lesson-1',
      learningPlan: buildTestLearningPlan(
        [buildTestLesson({ content: '# Lezione riparata', id: 'lesson-1' })],
        { summary: 'Sintesi', title: 'Percorso' }
      ),
    };
    const repairedSnapshot = buildSnapshot('project-1', repairedState);
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.patchProject.mockResolvedValue({ ...initialMeta, revision: 6 });
    const { rerender, result } = renderHook(
      ({ domainState }) => useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      { initialProps: { domainState: baseState } }
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    vi.useFakeTimers();
    try {
      act(() => {
        result.current.setCurrentProjectId('project-1');
        result.current.setProjectHydrated(false);
        result.current.completeProjectHydration({ revision: 5, snapshot: repairedSnapshot });
      });
      rerender({ domainState: repairedState });
      await act(async () => {
        vi.advanceTimersByTime(900);
        await vi.runOnlyPendingTimersAsync();
      });

      expect(repositoryMocks.saveProject).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.patchCurrentProject({ activeSectionId: 'lesson-1' });
      });
      expect(repositoryMocks.patchProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ activeSectionId: 'lesson-1' }),
        { expectedRevision: 5 }
      );
      expect(result.current.savedProjects[0]).toMatchObject({ revision: 6 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('hydrates a newer authoritative snapshot without applying a stale job result', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    const newerSnapshot = buildSnapshot('project-1', {
      activeSectionId: 'lesson-1',
      learningPlan: buildTestLearningPlan(
        [buildTestLesson({ content: '# Revisione più nuova', id: 'lesson-1' })],
        { title: 'Percorso', summary: 'Sintesi' }
      ),
    });
    const hydrateSnapshot = vi.fn();
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 6,
      snapshot: newerSnapshot,
    });
    repositoryMocks.patchProject.mockResolvedValue({ ...initialMeta, revision: 7 });
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot,
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });
    let shouldApplyResult = true;
    await act(async () => {
      shouldApplyResult = await result.current.applyPersistedProjectRevision({
        projectId: 'project-1',
        revision: 5,
      });
    });

    expect(shouldApplyResult).toBe(false);
    expect(hydrateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSectionId: 'lesson-1',
        id: 'project-1',
        learningPlan: newerSnapshot.learningPlan,
      })
    );
    await act(async () => {
      await result.current.patchCurrentProject({ activeSectionId: 'lesson-1' });
    });
    expect(repositoryMocks.patchProject).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ activeSectionId: 'lesson-1' }),
      { expectedRevision: 6 }
    );
  });

  test('does not hydrate a delayed snapshot older than a completed local write', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4);
    let resolveRevisionLoad!: (value: { revision: number; snapshot: ProjectSnapshot }) => void;
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.loadProjectWithRevision.mockReturnValue(
      new Promise(resolve => {
        resolveRevisionLoad = resolve;
      })
    );
    repositoryMocks.patchProject
      .mockResolvedValueOnce({ ...initialMeta, revision: 6 })
      .mockResolvedValueOnce({ ...initialMeta, revision: 7 });
    const hydrateSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot,
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let applyResult!: Promise<boolean>;
    act(() => {
      applyResult = result.current.applyPersistedProjectRevision({
        projectId: 'project-1',
        revision: 5,
      });
    });
    await act(async () => {
      await result.current.patchCurrentProject({ state: AppState.READING });
    });
    resolveRevisionLoad({ revision: 5, snapshot: buildSnapshot('project-1') });

    await expect(applyResult).resolves.toBe(false);
    expect(hydrateSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.patchCurrentProject({ activeSectionId: 'lesson-1' });
    });
    expect(repositoryMocks.patchProject).toHaveBeenLastCalledWith(
      'project-1',
      expect.objectContaining({ activeSectionId: 'lesson-1' }),
      { expectedRevision: 6 }
    );
  });

  test('downloadProject uses a zip-based backup filename', async () => {
    const objectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nous-backup');
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    repositoryMocks.exportProject.mockResolvedValue(buildSnapshot('project-export'));

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.downloadProject('project-export');
    });

    const anchor = appendChildSpy.mock.calls.find(
      ([node]) => node instanceof HTMLAnchorElement
    )?.[0] as HTMLAnchorElement | undefined;

    expect(anchor?.download.endsWith('.nous.zip')).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(objectUrlSpy).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.exportProject).toHaveBeenCalledWith('project-export');
  });

  test('downloadLibraryBackup preserves project ids used by library placements', async () => {
    const timestamp = '2026-04-02T10:00:00.000Z';
    const objectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nous-library');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    repositoryMocks.listProjects.mockResolvedValue([buildMeta('project-export', timestamp)]);
    repositoryMocks.listFolders.mockResolvedValue([]);
    repositoryMocks.listPlacements.mockResolvedValue([
      { folderId: null, order: 0, projectId: 'project-export', updatedAt: timestamp },
    ]);
    repositoryMocks.exportProject.mockResolvedValue(buildSnapshot('project-export'));
    repositoryMocks.loadProjectCover.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await expect(result.current.downloadLibraryBackup()).resolves.toBe(1);

    expect(repositoryMocks.exportProject).toHaveBeenCalledWith('project-export');
    expect(objectUrlSpy).toHaveBeenCalledWith(expect.any(Blob));
  });

  test('createFolder refreshes library organization and rebuilds the tree', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('course-1', '2026-04-02T10:00:00.000Z'),
    ]);
    repositoryMocks.listFolders.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'folder-1',
        name: 'Frontend',
        parentFolderId: null,
        createdAt: '2026-04-02T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
        order: 1,
      },
    ]);
    repositoryMocks.listPlacements.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        projectId: 'course-1',
        folderId: 'folder-1',
        order: 1,
        updatedAt: '2026-04-02T10:00:00.000Z',
      },
    ]);

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.createFolder({ name: 'Frontend' });
    });

    expect(repositoryMocks.createFolder).toHaveBeenCalledWith({ name: 'Frontend' });
    expect(result.current.libraryFolders[0]?.name).toBe('Frontend');
    expect(result.current.libraryTree.rootNodes[0]?.kind).toBe('folder');
  });

  test('patchSectionAnnotations suppresses autosave even when called with a stale closure', async () => {
    // Regression: previously patchSectionAnnotations captured `domainState` from
    // closure, so the persisted signature was set against the OLD state. After
    // the React commit applied the dispatch (with a NEW state), the autosave
    // effect saw a signature mismatch and triggered a full saveProject — which
    // is exactly what we wanted to avoid.
    vi.useFakeTimers();
    repositoryMocks.patchProject.mockImplementation(async (projectId: string) =>
      buildMeta(projectId, '2026-04-02T11:00:00.000Z')
    );

    const initialDomain = createEmptyWorkspaceDomainState();
    const { result, rerender } = renderHook(
      ({ domainState }: { domainState: WorkspaceDomainState }) =>
        useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      { initialProps: { domainState: initialDomain } }
    );

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.setCurrentProjectId('proj-1');
      result.current.setProjectHydrated(true);
    });

    // Capture the callback after projectId is set but before the rerender —
    // this is the closure that would persist a stale signature without the fix.
    const stalePatch = result.current.patchSectionAnnotations;

    // Simulate React applying the updateSection dispatch: rerender with a new
    // domainState whose signature differs from the initial one. The stale
    // callback (captured above) would otherwise persist the OLD signature.
    const updatedDomain: WorkspaceDomainState = {
      ...initialDomain,
      learningPlan: {
        ...buildTestLearningPlan([], { title: 'Plan' }),
      },
    };
    rerender({ domainState: updatedDomain });

    await act(async () => {
      await stalePatch('sec-1', [], 'updated content');
    });

    // PATCH was sent — that's expected.
    expect(repositoryMocks.patchProject).toHaveBeenCalledTimes(1);

    // Now advance past the autosave debounce (400ms). With the fix, the ref
    // captured the NEW signature via domainStateRef so the autosave stays idle.
    await act(async () => {
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();
  });

  test('does not synthesize a timeout error while library init is still pending', async () => {
    vi.useFakeTimers();
    repositoryMocks.listProjects.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );

    expect(result.current.isLibraryLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.isLibraryLoading).toBe(true);
    expect(result.current.storageError).toBeNull();
  });

  test('hydrates a newer active project revision without reloading the page', async () => {
    const firstMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1);
    const nextMeta = buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2);
    const remoteSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([], { title: 'Aggiornato altrove' }),
      updatedAt: nextMeta.updatedAt,
    });
    const hydrateSnapshot = vi.fn();
    repositoryMocks.listProjects.mockResolvedValue([firstMeta]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 2,
      snapshot: remoteSnapshot,
    });

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState(), hydrateSnapshot })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });
    repositoryMocks.listProjects.mockResolvedValue([nextMeta]);

    await act(async () => {
      revisionListener?.({ projectId: 'project-1', revision: 2 });
    });
    await waitFor(() => expect(hydrateSnapshot).toHaveBeenCalledWith(remoteSnapshot));

    expect(repositoryMocks.loadProjectWithRevision).toHaveBeenCalledTimes(1);
  });

  test('does not fetch the active snapshot when reconnect finds the same revision', async () => {
    const meta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 3);
    repositoryMocks.listProjects.mockResolvedValue([meta]);
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    await act(async () => {
      revisionReconnect?.();
    });
    await waitFor(() => expect(repositoryMocks.listProjects).toHaveBeenCalledTimes(2));

    expect(repositoryMocks.loadProjectWithRevision).not.toHaveBeenCalled();
  });

  test('invalidates pending writes and leaves an active course after a remote deletion event', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1);
    let resolveFirstWrite!: (meta: SavedProjectMeta) => void;
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.patchProject.mockReturnValue(
      new Promise<SavedProjectMeta>(resolve => {
        resolveFirstWrite = resolve;
      })
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let activeWrite!: Promise<boolean>;
    let queuedWrite!: Promise<boolean>;
    act(() => {
      activeWrite = result.current.patchSectionLessonContent('lesson-1', { content: 'prima' });
      queuedWrite = result.current.patchSectionLessonContent('lesson-2', { content: 'seconda' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(repositoryMocks.patchProject).toHaveBeenCalledTimes(1);

    act(() => {
      revisionListener?.({ deleted: true, projectId: 'project-1', revision: 2 });
    });
    await waitFor(() => expect(result.current.projectSyncState.kind).toBe('remoteDeleted'));

    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.savedProjects).toEqual([]);
    expect(result.current.storageError).toBe('Questo corso è stato cancellato');

    await act(async () => {
      resolveFirstWrite({ ...initialMeta, revision: 2 });
      await Promise.all([activeWrite, queuedWrite]);
    });
    await new Promise(resolve => globalThis.setTimeout(resolve, 500));

    expect(await activeWrite).toBe(false);
    expect(await queuedWrite).toBe(false);
    expect(repositoryMocks.patchProject).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();
    expect(result.current.savedProjects).toEqual([]);
  });

  test('treats a missing active course during reconnect catch-up as a remote deletion', async () => {
    repositoryMocks.listProjects
      .mockResolvedValueOnce([buildMeta('project-1', '2026-04-02T10:00:00.000Z', 4)])
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    act(() => {
      revisionReconnect?.();
    });

    await waitFor(() => expect(result.current.projectSyncState.kind).toBe('remoteDeleted'));
    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.storageError).toBe('Questo corso è stato cancellato');
  });

  test('uses the same remote deletion outcome when a local write receives project-deleted', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 2),
    ]);
    repositoryMocks.patchProject.mockRejectedValue(
      new ProjectStorageError('internal detail that must not reach the user', 'project-deleted')
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let writeResult!: boolean;
    await act(async () => {
      writeResult = await result.current.patchSectionLessonContent('lesson-1', {
        content: 'modifica tardiva',
      });
    });

    expect(writeResult).toBe(false);
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
    });
    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.storageError).toBe('Questo corso è stato cancellato');
  });

  test('removes a remotely deleted background course without leaving the active course', async () => {
    const activeMeta = buildMeta('project-active', '2026-04-02T10:00:00.000Z', 2);
    const deletedMeta = buildMeta('project-deleted', '2026-04-02T10:00:00.000Z', 3);
    repositoryMocks.listProjects.mockResolvedValue([activeMeta, deletedMeta]);
    repositoryMocks.setProjectFavorite.mockRejectedValue(
      new ProjectStorageError('technical database detail', 'project-deleted')
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-active');
      result.current.setProjectHydrated(true);
    });

    await act(async () => {
      await expect(
        result.current.setProjectFavorite('project-deleted', true)
      ).rejects.toMatchObject({
        code: 'project-deleted',
        message: 'Questo corso è stato cancellato',
      });
    });

    expect(result.current.currentProjectId).toBe('project-active');
    expect(result.current.savedProjects).toEqual([activeMeta]);
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-deleted',
      wasActive: false,
    });
  });

  test('uses the remote deletion outcome when saving a cover receives 404', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 2);
    repositoryMocks.listProjects.mockResolvedValue([initialMeta]);
    repositoryMocks.saveProjectCover.mockRejectedValue(
      new ProjectStorageError('technical storage detail', 'project-deleted')
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => result.current.setCurrentProjectId('project-1'));

    await act(async () => {
      await expect(
        result.current.saveStoredProjectCover('project-1', {
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
          name: 'cover.png',
        })
      ).rejects.toMatchObject({
        code: 'project-deleted',
        message: 'Questo corso è stato cancellato',
      });
    });

    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
      wasActive: true,
    });
  });

  test('serializes revision catch-up requests so an older response cannot overwrite a newer one', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1);
    let resolveFirstCatchUp!: (projects: SavedProjectMeta[]) => void;
    let resolveSecondCatchUp!: (projects: SavedProjectMeta[]) => void;
    repositoryMocks.listProjects
      .mockResolvedValueOnce([initialMeta])
      .mockImplementationOnce(() => new Promise(resolve => (resolveFirstCatchUp = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (resolveSecondCatchUp = resolve)));
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    act(() => {
      revisionReconnect?.();
      revisionReconnect?.();
    });
    expect(repositoryMocks.listProjects).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirstCatchUp([buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2)]);
    });
    await waitFor(() => expect(repositoryMocks.listProjects).toHaveBeenCalledTimes(3));
    await act(async () => {
      resolveSecondCatchUp([buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3)]);
    });

    await waitFor(() => expect(result.current.savedProjects[0]?.revision).toBe(3));
  });

  test('does not pair an older snapshot with a newer revision event', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1);
    const revisionTwoSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([], { title: 'Revisione due' }),
    });
    const revisionThreeSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([], { title: 'Revisione tre' }),
    });
    let resolveFirstLoad!: (value: { revision: number; snapshot: ProjectSnapshot }) => void;
    repositoryMocks.listProjects
      .mockResolvedValueOnce([initialMeta])
      .mockResolvedValueOnce([buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2)])
      .mockResolvedValueOnce([buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3)]);
    repositoryMocks.loadProject.mockResolvedValue(revisionTwoSnapshot);
    repositoryMocks.loadProjectWithRevision
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveFirstLoad = resolve;
        })
      )
      .mockResolvedValueOnce({ revision: 3, snapshot: revisionThreeSnapshot });
    const hydrateSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState(), hydrateSnapshot })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    act(() => {
      revisionListener?.({ projectId: 'project-1', revision: 2 });
    });
    await waitFor(() => expect(repositoryMocks.loadProjectWithRevision).toHaveBeenCalledTimes(1));
    act(() => {
      revisionListener?.({ projectId: 'project-1', revision: 3 });
    });
    await act(async () => {
      resolveFirstLoad({ revision: 2, snapshot: revisionTwoSnapshot });
    });

    await waitFor(() => expect(hydrateSnapshot).toHaveBeenCalledWith(revisionThreeSnapshot));
    expect(hydrateSnapshot).not.toHaveBeenCalledWith(revisionTwoSnapshot);
    expect(repositoryMocks.loadProjectWithRevision).toHaveBeenCalledTimes(2);
  });

  test('waits for an in-flight local write before applying a remote revision', async () => {
    let rejectPatch: ((error: Error) => void) | null = null;
    const patchPromise = new Promise<never>((_resolve, reject) => {
      rejectPatch = reject;
    });
    const hydrateSnapshot = vi.fn();
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.patchProject.mockReturnValue(patchPromise);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 2,
      snapshot: buildSnapshot('project-1', { updatedAt: '2026-04-02T11:00:00.000Z' }),
    });
    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState(), hydrateSnapshot })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let localWrite!: Promise<boolean>;
    act(() => {
      localWrite = result.current.patchSectionLessonContent('lesson-1', { content: 'locale' });
    });
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2),
    ]);
    await act(async () => {
      revisionListener?.({ projectId: 'project-1', revision: 2 });
      await Promise.resolve();
    });

    expect(repositoryMocks.loadProjectWithRevision).not.toHaveBeenCalled();
    expect(hydrateSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      rejectPatch?.(new Error('revision conflict'));
      await localWrite;
    });
    await waitFor(() => expect(hydrateSnapshot).toHaveBeenCalledTimes(1));
  });

  test('applies a newer remote revision after a successful local write settles', async () => {
    vi.useFakeTimers();
    let resolvePatch!: (meta: SavedProjectMeta) => void;
    const patchPromise = new Promise<SavedProjectMeta>(resolve => {
      resolvePatch = resolve;
    });
    const hydrateSnapshot = vi.fn();
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.patchProject.mockReturnValue(patchPromise);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 3,
      snapshot: buildSnapshot('project-1', { updatedAt: '2026-04-02T12:00:00.000Z' }),
    });

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState(), hydrateSnapshot })
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let localWrite!: Promise<boolean>;
    act(() => {
      localWrite = result.current.patchSectionLessonContent('lesson-1', { content: 'locale' });
    });
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3),
    ]);
    await act(async () => {
      revisionListener?.({ projectId: 'project-1', revision: 3 });
      await Promise.resolve();
    });
    expect(repositoryMocks.loadProjectWithRevision).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatch(buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2));
      await localWrite;
      await vi.runOnlyPendingTimersAsync();
    });

    expect(hydrateSnapshot).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.loadProjectWithRevision).toHaveBeenCalledWith('project-1');
  });

  test('serializes concurrent local writes against successive server revisions', async () => {
    vi.useFakeTimers();
    const patchResolvers: Array<(meta: SavedProjectMeta) => void> = [];
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.patchProject.mockImplementation(
      () =>
        new Promise<SavedProjectMeta>(resolve => {
          patchResolvers.push(resolve);
        })
    );
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let firstWrite!: Promise<boolean>;
    let secondWrite!: Promise<boolean>;
    act(() => {
      firstWrite = result.current.patchSectionLessonContent('lesson-1', { content: 'prima' });
      secondWrite = result.current.patchSectionLessonContent('lesson-2', { content: 'seconda' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(repositoryMocks.patchProject).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.patchProject.mock.calls[0]?.[2]).toEqual({ expectedRevision: 1 });

    await act(async () => {
      patchResolvers[0]?.(buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(repositoryMocks.patchProject).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.patchProject.mock.calls[1]?.[2]).toEqual({ expectedRevision: 2 });

    await act(async () => {
      patchResolvers[1]?.(buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3));
      await Promise.all([firstWrite, secondWrite]);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(await firstWrite).toBe(true);
    expect(await secondWrite).toBe(true);
  });

  test('does not let a write for another project block an active project refresh', async () => {
    const initialMeta = buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1);
    const otherMeta = buildMeta('project-2', '2026-04-02T10:00:00.000Z', 1);
    const remoteSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([], { title: 'Aggiornato altrove' }),
    });
    let resolveOtherWrite!: (meta: SavedProjectMeta) => void;
    repositoryMocks.listProjects.mockResolvedValue([initialMeta, otherMeta]);
    repositoryMocks.patchProject.mockImplementation((projectId: string) =>
      projectId === 'project-2'
        ? new Promise<SavedProjectMeta>(resolve => {
            resolveOtherWrite = resolve;
          })
        : Promise.resolve(buildMeta(projectId, '2026-04-02T11:00:00.000Z', 2))
    );
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 2,
      snapshot: remoteSnapshot,
    });
    const hydrateSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState(), hydrateSnapshot })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let otherWrite!: Promise<SavedProjectMeta>;
    act(() => {
      otherWrite = result.current.renameProject('project-2', 'Altro corso');
    });
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2),
      otherMeta,
    ]);
    await act(async () => {
      revisionListener?.({ projectId: 'project-1', revision: 2 });
    });

    await waitFor(() => expect(hydrateSnapshot).toHaveBeenCalledWith(remoteSnapshot));
    resolveOtherWrite({ ...otherMeta, title: 'Altro corso', revision: 2 });
    await otherWrite;
  });

  test('reloads when local state changes while a patch is in flight', async () => {
    vi.useFakeTimers();
    const initialState = createEmptyWorkspaceDomainState();
    const changedState: WorkspaceDomainState = {
      ...initialState,
      learningPlan: buildTestLearningPlan([], { title: 'Modifica non inclusa nella patch' }),
    };
    let resolvePatch!: (meta: SavedProjectMeta) => void;
    repositoryMocks.listProjects.mockResolvedValue([
      {
        ...buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
        hasSourceFile: false,
      },
    ]);
    repositoryMocks.patchProject.mockReturnValue(
      new Promise<SavedProjectMeta>(resolve => {
        resolvePatch = resolve;
      })
    );
    const { result, rerender } = renderHook(
      ({ domainState }) => useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      { initialProps: { domainState: initialState } }
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let patch!: Promise<void>;
    act(() => {
      patch = result.current.patchSectionAnnotations('lesson-1', []);
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ domainState: changedState });
    await act(async () => {
      resolvePatch({
        ...buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2),
        hasSourceFile: false,
      });
      await patch;
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(repositoryMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.saveProject.mock.calls[0]?.[0]).toMatchObject({
      learningPlan: { title: 'Modifica non inclusa nella patch' },
    });
  });

  test('builds lesson notes from the snapshot read inside the project write queue', async () => {
    const existingAnnotation = {
      anchor: { kind: 'lesson' as const },
      createdAt: '2026-04-02T10:00:00.000Z',
      id: 'existing-note',
      note: 'Nota concorrente',
      updatedAt: '2026-04-02T10:00:00.000Z',
    };
    const staleSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([buildTestLesson({ id: 'lesson-1', annotations: [] })]),
    });
    const currentSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([
        buildTestLesson({ id: 'lesson-1', annotations: [existingAnnotation] }),
      ]),
    });
    let resolveFirstWrite!: (meta: SavedProjectMeta) => void;
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.loadProject.mockResolvedValue(staleSnapshot);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 2,
      snapshot: currentSnapshot,
    });
    repositoryMocks.patchProject
      .mockReturnValueOnce(
        new Promise<SavedProjectMeta>(resolve => {
          resolveFirstWrite = resolve;
        })
      )
      .mockResolvedValueOnce(buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3));
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let firstWrite!: Promise<boolean>;
    let noteWrite!: Promise<{ annotationId?: string; error?: string; saved: boolean }>;
    act(() => {
      firstWrite = result.current.patchSectionLessonContent('lesson-2', { content: 'Prima' });
      noteWrite = result.current.saveLessonArtifactNote({
        lessonId: 'lesson-1',
        note: 'Nuova nota',
        projectId: 'project-1',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(repositoryMocks.loadProjectWithRevision).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstWrite(buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2));
      await Promise.all([firstWrite, noteWrite]);
    });

    expect(await noteWrite).toMatchObject({ saved: true });
    expect(repositoryMocks.patchProject.mock.calls[1]?.[1]).toMatchObject({
      section: {
        sectionId: 'lesson-1',
        annotations: [existingAnnotation, expect.objectContaining({ note: 'Nuova nota' })],
      },
    });
    expect(repositoryMocks.patchProject.mock.calls[1]?.[2]).toEqual({ expectedRevision: 2 });
  });

  test('treats a project deleted before a queued lesson note read as remotely deleted', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let noteResult!: Awaited<ReturnType<typeof result.current.saveLessonArtifactNote>>;
    await act(async () => {
      noteResult = await result.current.saveLessonArtifactNote({
        lessonId: 'lesson-1',
        note: 'Nota tardiva',
        projectId: 'project-1',
      });
    });

    expect(noteResult).toEqual({ saved: false, error: 'Questo corso è stato cancellato' });
    expect(repositoryMocks.patchProject).not.toHaveBeenCalled();
    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
      wasActive: true,
    });
  });

  test('retries the full dirty snapshot when one queued local patch fails', async () => {
    vi.useFakeTimers();
    const baseState = createEmptyWorkspaceDomainState();
    const dirtyState: WorkspaceDomainState = {
      ...baseState,
      learningPlan: buildTestLearningPlan([], { title: 'Stato locale completo' }),
    };
    repositoryMocks.listProjects.mockResolvedValue([
      {
        ...buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
        hasSourceFile: false,
      },
    ]);
    repositoryMocks.patchProject
      .mockRejectedValueOnce(new Error('prima patch non salvata'))
      .mockResolvedValueOnce({
        ...buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2),
        hasSourceFile: false,
      });
    repositoryMocks.saveProject.mockResolvedValue({
      meta: buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3),
      snapshot: buildSnapshot('project-1', {
        learningPlan: dirtyState.learningPlan,
        updatedAt: '2026-04-02T12:00:00.000Z',
      }),
    });
    const { result, rerender } = renderHook(
      ({ domainState }: { domainState: WorkspaceDomainState }) =>
        useProjectLibrary({ domainState, hydrateSnapshot: vi.fn() }),
      { initialProps: { domainState: baseState } }
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let failedWrite!: Promise<boolean>;
    let successfulWrite!: Promise<boolean>;
    act(() => {
      failedWrite = result.current.patchSectionLessonContent('lesson-1', { content: 'prima' });
      successfulWrite = result.current.patchSectionLessonContent('lesson-2', {
        content: 'seconda',
      });
      rerender({ domainState: dirtyState });
    });
    await act(async () => {
      await Promise.all([failedWrite, successfulWrite]);
    });

    expect(await failedWrite).toBe(false);
    expect(await successfulWrite).toBe(true);
    expect(result.current.storageError).toBe('prima patch non salvata');
    expect(repositoryMocks.saveProject).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(repositoryMocks.saveProject).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.saveProject.mock.calls[0]?.[0]).toMatchObject({
      learningPlan: { title: 'Stato locale completo' },
    });
    expect(result.current.storageError).toBeNull();
  });

  test('replaces a saved generated visual while preserving its original id', async () => {
    const visualOne = {
      id: 'visual-1',
      title: 'mappa_vecchia',
      kind: 'svg' as const,
      code: '<svg data-old="true"></svg>',
      createdAt: '2026-05-01T10:00:00.000Z',
    };
    const visualTwo = {
      id: 'visual-2',
      title: 'mappa_intoccata',
      kind: 'html' as const,
      code: '<div>Intatta</div>',
      createdAt: '2026-05-01T11:00:00.000Z',
    };
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 1,
      snapshot: buildSnapshot('project-1', {
        learningPlan: buildTestLearningPlan([
          buildTestLesson({
            id: 'lesson-1',
            generatedVisuals: [visualOne, visualTwo],
          }),
          buildTestLesson({
            id: 'lesson-2',
            generatedVisuals: [
              {
                id: 'visual-other',
                title: 'altra_lezione',
                kind: 'svg',
                code: '<svg data-other="true"></svg>',
                createdAt: '2026-05-01T12:00:00.000Z',
              },
            ],
          }),
        ]),
      }),
    });
    repositoryMocks.patchProject.mockResolvedValue(
      buildMeta('project-1', '2026-05-02T10:00:00.000Z')
    );

    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.replaceLessonGeneratedVisual({
        artifactId: 'project-1:lesson-1:generated-visual:visual-1',
        lessonId: 'lesson-1',
        projectId: 'project-1',
        visual: {
          id: 'visual-draft-9',
          title: 'mappa_nuova',
          kind: 'svg',
          code: '<svg data-new="true"></svg>',
          createdAt: '2026-05-02T10:00:00.000Z',
        },
      });
    });

    expect(repositoryMocks.patchProject).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        section: {
          sectionId: 'lesson-1',
          generatedVisuals: [
            expect.objectContaining({
              id: 'visual-1',
              title: 'mappa_nuova',
              code: '<svg data-new="true"></svg>',
            }),
            visualTwo,
          ],
        },
      }),
      { expectedRevision: 1 }
    );
  });

  test('builds visual replacement arrays from the snapshot read inside the write queue', async () => {
    const visualOne = {
      id: 'visual-1',
      title: 'mappa_vecchia',
      kind: 'svg' as const,
      code: '<svg data-old="true"></svg>',
      createdAt: '2026-05-01T10:00:00.000Z',
    };
    const concurrentVisual = {
      id: 'visual-2',
      title: 'aggiunta_concorrente',
      kind: 'html' as const,
      code: '<div>Nuovo</div>',
      createdAt: '2026-05-01T11:00:00.000Z',
    };
    const staleSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([
        buildTestLesson({ id: 'lesson-1', generatedVisuals: [visualOne] }),
      ]),
    });
    const currentSnapshot = buildSnapshot('project-1', {
      learningPlan: buildTestLearningPlan([
        buildTestLesson({
          id: 'lesson-1',
          generatedVisuals: [visualOne, concurrentVisual],
        }),
      ]),
    });
    let resolveFirstWrite!: (meta: SavedProjectMeta) => void;
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.loadProject.mockResolvedValue(staleSnapshot);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue({
      revision: 2,
      snapshot: currentSnapshot,
    });
    repositoryMocks.patchProject
      .mockReturnValueOnce(
        new Promise<SavedProjectMeta>(resolve => {
          resolveFirstWrite = resolve;
        })
      )
      .mockResolvedValueOnce(buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3));
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let firstWrite!: Promise<boolean>;
    let replacement!: Promise<{ error?: string; replaced: boolean }>;
    act(() => {
      firstWrite = result.current.patchSectionLessonContent('lesson-2', { content: 'Prima' });
      replacement = result.current.replaceLessonGeneratedVisual({
        artifactId: 'project-1:lesson-1:generated-visual:visual-1',
        lessonId: 'lesson-1',
        projectId: 'project-1',
        visual: {
          ...visualOne,
          id: 'draft-id',
          title: 'mappa_nuova',
          code: '<svg data-new="true"></svg>',
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(repositoryMocks.loadProjectWithRevision).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstWrite(buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2));
      await Promise.all([firstWrite, replacement]);
    });

    expect(await replacement).toEqual({ replaced: true });
    expect(repositoryMocks.patchProject.mock.calls[1]?.[1]).toMatchObject({
      section: {
        sectionId: 'lesson-1',
        generatedVisuals: [
          expect.objectContaining({ id: 'visual-1', title: 'mappa_nuova' }),
          concurrentVisual,
        ],
      },
    });
    expect(repositoryMocks.patchProject.mock.calls[1]?.[2]).toEqual({ expectedRevision: 2 });
  });

  test('treats a project deleted before a queued visual replacement read as remotely deleted', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('project-1', '2026-04-02T10:00:00.000Z', 1),
    ]);
    repositoryMocks.loadProjectWithRevision.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useProjectLibrary({
        domainState: createEmptyWorkspaceDomainState(),
        hydrateSnapshot: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));
    act(() => {
      result.current.setCurrentProjectId('project-1');
      result.current.setProjectHydrated(true);
    });

    let replacementResult!: Awaited<ReturnType<typeof result.current.replaceLessonGeneratedVisual>>;
    await act(async () => {
      replacementResult = await result.current.replaceLessonGeneratedVisual({
        artifactId: 'project-1:lesson-1:generated-visual:visual-1',
        lessonId: 'lesson-1',
        projectId: 'project-1',
        visual: {
          id: 'visual-draft',
          title: 'mappa_nuova',
          kind: 'svg',
          code: '<svg></svg>',
          createdAt: '2026-05-02T10:00:00.000Z',
        },
      });
    });

    expect(replacementResult).toEqual({
      replaced: false,
      error: 'Questo corso è stato cancellato',
    });
    expect(repositoryMocks.patchProject).not.toHaveBeenCalled();
    expect(result.current.currentProjectId).toBeNull();
    expect(result.current.projectSyncState).toMatchObject({
      kind: 'remoteDeleted',
      projectId: 'project-1',
      wasActive: true,
    });
  });
});

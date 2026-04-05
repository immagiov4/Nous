// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppState, type ProjectSnapshot, type SavedProjectMeta, type WorkspaceDomainState } from '../../../types.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';

const repositoryMocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteProject: vi.fn(),
  deleteFolder: vi.fn(),
  exportProject: vi.fn(),
  importProject: vi.fn(),
  listFolders: vi.fn(),
  listPlacements: vi.fn(),
  listProjects: vi.fn(),
  loadProject: vi.fn(),
  loadProjectsById: vi.fn(),
  moveFolder: vi.fn(),
  moveProjects: vi.fn(),
  renameFolder: vi.fn(),
  saveProject: vi.fn(),
  touchProject: vi.fn(),
}));

vi.mock('../../../services/projects/indexedDbProjectRepository', () => ({
  IndexedDbProjectRepository: class MockIndexedDbProjectRepository {
    createFolder = repositoryMocks.createFolder;
    deleteProject = repositoryMocks.deleteProject;
    deleteFolder = repositoryMocks.deleteFolder;
    exportProject = repositoryMocks.exportProject;
    importProject = repositoryMocks.importProject;
    listFolders = repositoryMocks.listFolders;
    listPlacements = repositoryMocks.listPlacements;
    listProjects = repositoryMocks.listProjects;
    loadProject = repositoryMocks.loadProject;
    loadProjectsById = repositoryMocks.loadProjectsById;
    moveFolder = repositoryMocks.moveFolder;
    moveProjects = repositoryMocks.moveProjects;
    renameFolder = repositoryMocks.renameFolder;
    saveProject = repositoryMocks.saveProject;
    touchProject = repositoryMocks.touchProject;
  },
}));

const { useProjectLibrary } = await import('../../../hooks/library/useProjectLibrary.ts');

const buildMeta = (id: string, lastOpenedAt: string): SavedProjectMeta => ({
  id,
  title: `Project ${id}`,
  sourceKind: 'document',
  createdAt: lastOpenedAt,
  updatedAt: lastOpenedAt,
  lastOpenedAt,
  lessonCount: 1,
  completedCount: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
});

const buildSnapshot = (
  id: string,
  overrides: Partial<ProjectSnapshot> = {}
): ProjectSnapshot => ({
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
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    repositoryMocks.createFolder.mockReset();
    repositoryMocks.deleteProject.mockReset();
    repositoryMocks.deleteFolder.mockReset();
    repositoryMocks.exportProject.mockReset();
    repositoryMocks.importProject.mockReset();
    repositoryMocks.listFolders.mockReset();
    repositoryMocks.listPlacements.mockReset();
    repositoryMocks.listProjects.mockReset();
    repositoryMocks.loadProject.mockReset();
    repositoryMocks.loadProjectsById.mockReset();
    repositoryMocks.moveFolder.mockReset();
    repositoryMocks.moveProjects.mockReset();
    repositoryMocks.renameFolder.mockReset();
    repositoryMocks.saveProject.mockReset();
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
    repositoryMocks.saveProject.mockImplementation(async (snapshot: ProjectSnapshot) =>
      buildMeta(snapshot.id, snapshot.updatedAt)
    );
    repositoryMocks.loadProject.mockResolvedValue(null);
    repositoryMocks.importProject.mockResolvedValue({
      meta: buildMeta('imported', '2026-04-02T10:00:00.000Z'),
      snapshot: buildSnapshot('imported'),
    });
  });

  test('loads and sorts saved projects by last opened time', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('older', '2026-04-01T10:00:00.000Z'),
      buildMeta('newer', '2026-04-02T10:00:00.000Z'),
    ]);

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState() })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    expect(result.current.savedProjects.map(project => project.id)).toEqual(['newer', 'older']);
  });

  test('persistSnapshot syncs metadata and keeps the newest project first', async () => {
    repositoryMocks.listProjects.mockResolvedValue([
      buildMeta('older', '2026-04-01T10:00:00.000Z'),
    ]);

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState() })
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

  test('autosaves only after the debounced persisted signature changes', async () => {
    const baseState = createEmptyWorkspaceDomainState();
    const nextState: WorkspaceDomainState = {
      ...baseState,
      learningPlan: {
        title: 'Nuovo percorso',
        summary: 'Sintesi',
        sections: [],
      },
    };

    const { result, rerender } = renderHook(
      ({ domainState }) => useProjectLibrary({ domainState }),
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
      vi.advanceTimersByTime(799);
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
      state: AppState.READING,
    });
  });

  test('downloadProject uses a zip-based backup filename', async () => {
    const objectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:lumina-backup');
    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    repositoryMocks.loadProject.mockResolvedValue(buildSnapshot('project-export'));

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState() })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.downloadProject('project-export');
    });

    const anchor = appendChildSpy.mock.calls.find(
      ([node]) => node instanceof HTMLAnchorElement
    )?.[0] as HTMLAnchorElement | undefined;

    expect(anchor?.download.endsWith('.lumina.zip')).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(objectUrlSpy).toHaveBeenCalledTimes(1);
  });

  test('createFolder refreshes library organization and rebuilds the tree', async () => {
    repositoryMocks.listProjects.mockResolvedValue([buildMeta('course-1', '2026-04-02T10:00:00.000Z')]);
    repositoryMocks.listFolders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'folder-1',
          name: 'Frontend',
          parentFolderId: null,
          createdAt: '2026-04-02T10:00:00.000Z',
          updatedAt: '2026-04-02T10:00:00.000Z',
          order: 1,
        },
      ]);
    repositoryMocks.listPlacements
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          projectId: 'course-1',
          folderId: 'folder-1',
          order: 1,
          updatedAt: '2026-04-02T10:00:00.000Z',
        },
      ]);

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState() })
    );

    await waitFor(() => expect(result.current.isLibraryLoading).toBe(false));

    await act(async () => {
      await result.current.createFolder({ name: 'Frontend' });
    });

    expect(repositoryMocks.createFolder).toHaveBeenCalledWith({ name: 'Frontend' });
    expect(result.current.libraryFolders[0]?.name).toBe('Frontend');
    expect(result.current.libraryTree.rootNodes[0]?.kind).toBe('folder');
  });

  test('does not synthesize a timeout error while library init is still pending', async () => {
    vi.useFakeTimers();
    repositoryMocks.listProjects.mockImplementation(
      () => new Promise(() => {})
    );

    const { result } = renderHook(() =>
      useProjectLibrary({ domainState: createEmptyWorkspaceDomainState() })
    );

    expect(result.current.isLibraryLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.isLibraryLoading).toBe(true);
    expect(result.current.storageError).toBeNull();
  });
});

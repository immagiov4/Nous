// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AppState, type ProjectSnapshot, type SavedProjectMeta, type WorkspaceDomainState } from '../../../types.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';

const repositoryMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  exportProject: vi.fn(),
  importProject: vi.fn(),
  listProjects: vi.fn(),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
  touchProject: vi.fn(),
}));

vi.mock('../../../services/projects/indexedDbProjectRepository', () => ({
  IndexedDbProjectRepository: class MockIndexedDbProjectRepository {
    deleteProject = repositoryMocks.deleteProject;
    exportProject = repositoryMocks.exportProject;
    importProject = repositoryMocks.importProject;
    listProjects = repositoryMocks.listProjects;
    loadProject = repositoryMocks.loadProject;
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
  beforeEach(() => {
    repositoryMocks.deleteProject.mockReset();
    repositoryMocks.exportProject.mockReset();
    repositoryMocks.importProject.mockReset();
    repositoryMocks.listProjects.mockReset();
    repositoryMocks.loadProject.mockReset();
    repositoryMocks.saveProject.mockReset();
    repositoryMocks.touchProject.mockReset();

    repositoryMocks.listProjects.mockResolvedValue([]);
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
});

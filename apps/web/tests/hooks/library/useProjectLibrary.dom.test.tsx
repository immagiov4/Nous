// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createLibraryArchiveBlob } from '../../../services/projects/libraryArchive.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';
import {
  AppState,
  type ProjectSnapshot,
  type SavedProjectMeta,
  type WorkspaceDomainState,
} from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

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
  loadProjectCover: vi.fn(),
  loadProjectSource: vi.fn(),
  loadProjectsById: vi.fn(),
  moveFolder: vi.fn(),
  moveProjects: vi.fn(),
  patchProject: vi.fn(),
  renameFolder: vi.fn(),
  saveProject: vi.fn(),
  saveProjectCover: vi.fn(),
  subscribeToProjectRevisions: vi.fn(),
  touchProject: vi.fn(),
}));

let revisionListener: ((event: { projectId: string; revision: number }) => void) | null = null;
let revisionReconnect: (() => void) | null = null;

vi.mock('../../../services/projects/httpProjectRepository.ts', () => ({
  HttpProjectRepository: vi.fn(function HttpProjectRepositoryMock() {
    return repositoryMocks;
  }),
}));

const { useProjectLibrary } = await import('../../../hooks/library/useProjectLibrary.ts');

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
    if (typeof window !== 'undefined') {
      const store = new Map<string, string>();
      Object.defineProperty(window, 'localStorage', {
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
    repositoryMocks.importProject.mockReset();
    repositoryMocks.listFolders.mockReset();
    repositoryMocks.listPlacements.mockReset();
    repositoryMocks.listProjects.mockReset();
    repositoryMocks.loadProject.mockReset();
    repositoryMocks.loadProjectCover.mockReset();
    repositoryMocks.loadProjectSource.mockReset();
    repositoryMocks.loadProjectsById.mockReset();
    repositoryMocks.moveFolder.mockReset();
    repositoryMocks.moveProjects.mockReset();
    repositoryMocks.renameFolder.mockReset();
    repositoryMocks.saveProject.mockReset();
    repositoryMocks.saveProjectCover.mockReset();
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
    repositoryMocks.saveProject.mockImplementation(async (snapshot: ProjectSnapshot) =>
      buildMeta(snapshot.id, snapshot.updatedAt)
    );
    repositoryMocks.loadProject.mockResolvedValue(null);
    repositoryMocks.importProject.mockImplementation(async (project: ProjectSnapshot) => ({
      meta: buildMeta(project.id, '2026-04-02T10:00:00.000Z'),
      snapshot: buildSnapshot(project.id),
    }));
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

    expect(repositoryMocks.importProject).toHaveBeenCalledTimes(1);
    const importedProjectId = repositoryMocks.importProject.mock.calls[0]?.[0].id;
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
      repositoryMocks.importProject.mock.calls[0]?.[0].id
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
    repositoryMocks.loadProject.mockResolvedValue(remoteSnapshot);

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

    expect(repositoryMocks.loadProject).toHaveBeenCalledTimes(1);
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

    expect(repositoryMocks.loadProject).not.toHaveBeenCalled();
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
    repositoryMocks.loadProject.mockResolvedValue(
      buildSnapshot('project-1', { updatedAt: '2026-04-02T11:00:00.000Z' })
    );
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

    expect(repositoryMocks.loadProject).not.toHaveBeenCalled();
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
    repositoryMocks.loadProject.mockResolvedValue(
      buildSnapshot('project-1', { updatedAt: '2026-04-02T12:00:00.000Z' })
    );

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
    expect(repositoryMocks.loadProject).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatch(buildMeta('project-1', '2026-04-02T11:00:00.000Z', 2));
      await localWrite;
      await vi.runOnlyPendingTimersAsync();
    });

    expect(hydrateSnapshot).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.loadProject).toHaveBeenCalledWith('project-1');
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
    repositoryMocks.saveProject.mockResolvedValue(
      buildMeta('project-1', '2026-04-02T12:00:00.000Z', 3)
    );
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
    repositoryMocks.loadProject.mockResolvedValue(
      buildSnapshot('project-1', {
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
      })
    );
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
      { expectedRevision: undefined }
    );
  });
});

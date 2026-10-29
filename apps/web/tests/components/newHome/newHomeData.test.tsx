// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import type { SavedProjectMeta } from '../../../types.ts';

const ensureProjectCoverMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/projects/courseCover.ts', () => ({
  ensureProjectCover: ensureProjectCoverMock,
}));

const { useCourseCoverImages, useFavoriteProjectIds, useSourceLibrary } = await import(
  '../../../components/newHome/newHomeData.ts'
);

const buildProject = (index: number): SavedProjectMeta => ({
  id: `project-${index}`,
  title: `Project ${index}`,
  sourceKind: 'document',
  createdAt: '2026-07-15T10:00:00.000Z',
  updatedAt: '2026-07-15T10:00:00.000Z',
  lastOpenedAt: '2026-07-15T10:00:00.000Z',
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'Source.pdf',
});

describe('new home course covers', () => {
  beforeEach(() => {
    ensureProjectCoverMock.mockReset();
  });

  test('queues a cover for every course, including courses beyond the first twelve', async () => {
    const projects = Array.from({ length: 14 }, (_, index) => buildProject(index));
    const loadProjectCover = vi.fn();
    const saveProjectCover = vi.fn();
    ensureProjectCoverMock.mockImplementation(
      async ({ projectId }: { projectId: string }) => `data:image/webp;base64,${projectId}`
    );

    const { result } = renderHook(() =>
      useCourseCoverImages({
        loadProjectCover,
        projects,
        saveProjectCover,
      })
    );

    await waitFor(() => expect(ensureProjectCoverMock).toHaveBeenCalledTimes(projects.length));
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(projects.length));
  });

  test('runs at most three cover jobs concurrently', async () => {
    const projects = Array.from({ length: 8 }, (_, index) => buildProject(index));
    const loadProjectCover = vi.fn();
    const saveProjectCover = vi.fn();
    const pendingResolutions: Array<() => void> = [];
    let activeJobs = 0;
    let maxActiveJobs = 0;
    ensureProjectCoverMock.mockImplementation(
      ({ projectId }: { projectId: string }) =>
        new Promise<string>(resolve => {
          activeJobs += 1;
          maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
          pendingResolutions.push(() => {
            activeJobs -= 1;
            resolve(`data:image/webp;base64,${projectId}`);
          });
        })
    );

    renderHook(() =>
      useCourseCoverImages({
        loadProjectCover,
        projects,
        saveProjectCover,
      })
    );
    await waitFor(() => expect(ensureProjectCoverMock).toHaveBeenCalledTimes(3));

    while (ensureProjectCoverMock.mock.calls.length < projects.length) {
      pendingResolutions.shift()?.();
      await waitFor(() => expect(pendingResolutions.length).toBeGreaterThan(0));
    }
    pendingResolutions.splice(0).forEach(resolve => {
      resolve();
    });

    expect(maxActiveJobs).toBe(3);
  });
});

describe('new home favorites', () => {
  test.each([
    false,
    true,
  ])('reports failed favorite writes and keeps persisted state (%s)', async isFavorite => {
    const projects = [{ ...buildProject(1), isFavorite }];
    const notify = vi.fn();
    const setProjectFavorite = vi.fn().mockRejectedValue(new Error('private storage detail'));
    const { result } = renderHook(() =>
      useFavoriteProjectIds(projects, setProjectFavorite, notify)
    );
    await act(async () => result.current.toggleFavoriteProject('project-1'));
    expect(setProjectFavorite).toHaveBeenCalledWith('project-1', !isFavorite);
    expect(result.current.favoriteIds).toEqual(isFavorite ? ['project-1'] : []);
    expect(notify).toHaveBeenCalledExactlyOnceWith('Modifica dei preferiti non riuscita. Riprova.');
  });

  test('leaves remote-deletion feedback to the existing app notification', async () => {
    const projects = [buildProject(1)];
    const notify = vi.fn();
    const setProjectFavorite = vi
      .fn()
      .mockRejectedValue(new ProjectStorageError('deleted', 'project-deleted'));
    const { result } = renderHook(() =>
      useFavoriteProjectIds(projects, setProjectFavorite, notify)
    );
    await act(async () => result.current.toggleFavoriteProject('project-1'));
    expect(notify).not.toHaveBeenCalled();
    expect(result.current.favoriteIds).toEqual([]);
  });

  test('uses backend metadata as the source of truth and persists toggles', async () => {
    const setProjectFavorite = vi.fn().mockResolvedValue({});
    const project = { ...buildProject(1), isFavorite: true };
    const { result, rerender } = renderHook(
      ({ projects }) => useFavoriteProjectIds(projects, setProjectFavorite),
      { initialProps: { projects: [project] } }
    );
    await waitFor(() => expect(result.current.favoriteIds).toEqual(['project-1']));

    act(() => result.current.toggleFavoriteProject('project-1'));
    expect(result.current.favoriteIds).toEqual(['project-1']);
    expect(setProjectFavorite).toHaveBeenCalledWith('project-1', false);

    rerender({ projects: [{ ...project, isFavorite: false }] });
    await waitFor(() => expect(result.current.favoriteIds).toEqual([]));
  });
});

describe('new home source library', () => {
  test.each([
    false,
    true,
  ])('clears failed source loads while inactive (empty library: %s)', async emptyLibrary => {
    const projects = [buildProject(1)];
    const loadProjectsById = vi
      .fn()
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
      .mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      ({ enabled, projects }) => useSourceLibrary({ enabled, loadProjectsById, projects }),
      { initialProps: { enabled: true, projects } }
    );
    await waitFor(() => expect(result.current.hasLoadError).toBe(true));
    rerender({ enabled: false, projects: emptyLibrary ? [] : projects });
    await act(async () => {});
    expect(result.current.hasLoadError).toBe(false);
    const newProjects = [buildProject(2)];
    rerender({ enabled: false, projects: newProjects });
    expect(result.current.hasLoadError).toBe(false);
    expect(loadProjectsById).toHaveBeenCalledTimes(1);
    rerender({ enabled: true, projects: newProjects });
    await waitFor(() => expect(loadProjectsById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasLoadError).toBe(false);
  });

  test('removes deleted courses from retained sources when a reload fails', async () => {
    const projects = [buildProject(1), buildProject(2)];
    const snapshots = projects.map(project => ({
      id: project.id,
      source: {
        kind: 'archive',
        name: `${project.id}.zip`,
        file: { data: 'emlw', name: `${project.id}.zip`, mimeType: 'application/zip' },
      },
    }));
    let failReload!: (error: Error) => void;
    const loadProjectsById = vi
      .fn()
      .mockResolvedValueOnce(snapshots)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          failReload = reject;
        })
      );
    const { result, rerender } = renderHook(
      ({ enabled, projects }) => useSourceLibrary({ enabled, loadProjectsById, projects }),
      { initialProps: { enabled: true, projects } }
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    rerender({ enabled: false, projects: [projects[1]] });
    expect(result.current.items.map(item => item.projectId)).toEqual(['project-2']);
    rerender({ enabled: true, projects: [projects[1]] });
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    await act(async () => failReload(new Error('snapshot unavailable')));
    await waitFor(() => expect(result.current.hasLoadError).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items.map(item => item.projectId)).toEqual(['project-2']);
  });

  test('retains a successful batch and exposes failure when the next batch rejects', async () => {
    const projects = Array.from({ length: 5 }, (_, index) => buildProject(index));
    let failBatch!: (error: Error) => void;
    const loadProjectsById = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: projects[0].id,
          source: {
            kind: 'archive',
            name: 'src.zip',
            file: { data: 'emlw', name: 'src.zip', mimeType: 'application/zip' },
          },
        },
      ])
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          failBatch = reject;
        })
      );
    const { result } = renderHook(() =>
      useSourceLibrary({ enabled: true, loadProjectsById, projects })
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.isLoading).toBe(true);
    await act(async () => failBatch(new Error('private snapshot detail')));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items[0]?.file.name).toBe('src.zip');
    expect(result.current.hasLoadError).toBe(true);
  });

  test('includes the original ZIP for existing codebase courses', async () => {
    const project = { ...buildProject(1), sourceKind: 'codebase' as const };
    const loadProjectsById = vi.fn().mockResolvedValue([
      {
        id: project.id,
        source: {
          file: { data: '', mimeType: 'application/zip', name: 'src.zip' },
          index: { entries: [] },
          kind: 'archive',
          name: 'src.zip',
          ref: {
            byteSize: 1024,
            hash: 'archive-hash',
            id: 'source-archive',
            mimeType: 'application/zip',
            name: 'src.zip',
            objectPath: 'sources/src.zip',
          },
        },
      },
    ]);

    const { result } = renderHook(() =>
      useSourceLibrary({ enabled: true, loadProjectsById, projects: [project] })
    );

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items).toEqual([
      expect.objectContaining({
        kind: 'archive',
        projectId: project.id,
        projectTitle: project.title,
        requiresPrimarySourceLoad: true,
      }),
    ]);
    expect(result.current.items[0]?.file.name).toBe('src.zip');
  });

  test('omits source descriptors whose original file is unavailable', async () => {
    const project = buildProject(1);
    const loadProjectsById = vi.fn().mockResolvedValue([
      {
        id: project.id,
        source: {
          file: { data: '', mimeType: 'application/pdf', name: 'missing.pdf' },
          kind: 'pdf',
        },
      },
    ]);

    const { result } = renderHook(() =>
      useSourceLibrary({ enabled: true, loadProjectsById, projects: [project] })
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([]);
  });

  test('keeps collected sources visible while refreshed project metadata reloads', async () => {
    const project = buildProject(1);
    const snapshot = {
      id: project.id,
      source: {
        file: {
          data: 'c291cmNl',
          mimeType: 'application/pdf',
          name: 'source.pdf',
          sourceId: 'source-1',
        },
        kind: 'pdf' as const,
      },
    };
    let finishRefresh!: (snapshots: (typeof snapshot)[]) => void;
    const loadProjectsById = vi
      .fn()
      .mockResolvedValueOnce([snapshot])
      .mockReturnValueOnce(
        new Promise<(typeof snapshot)[]>(resolve => {
          finishRefresh = resolve;
        })
      );
    const { result, rerender } = renderHook(
      ({ projects }) => useSourceLibrary({ enabled: true, loadProjectsById, projects }),
      { initialProps: { projects: [project] } }
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    rerender({ projects: [{ ...project, revision: 2 }] });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.file.name).toBe('source.pdf');

    await act(async () => {
      finishRefresh([snapshot]);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});

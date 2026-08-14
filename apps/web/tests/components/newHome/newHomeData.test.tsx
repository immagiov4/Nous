// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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

// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavedProjectMeta } from '../../../types.ts';

const ensureProjectCoverMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/projects/courseCover.ts', () => ({
  ensureProjectCover: ensureProjectCoverMock,
}));

const { useCourseCoverImages } = await import('../../../components/newHome/newHomeData.ts');

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

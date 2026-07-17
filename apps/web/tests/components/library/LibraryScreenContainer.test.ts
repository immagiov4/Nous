import { describe, expect, test, vi } from 'vitest';

import { renameProjectAndSyncLoadedPlan } from '../../../components/library/LibraryScreenContainer.tsx';
import type { SavedProjectMeta } from '../../../types.ts';
import { buildTestLearningPlan } from '../../helpers/learningPlan.ts';

const renamedMeta: SavedProjectMeta = {
  id: 'project-a',
  title: 'Titolo nuovo',
  sourceKind: 'document',
  createdAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:01:00.000Z',
  lastOpenedAt: '2026-07-16T10:00:00.000Z',
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  revision: 2,
};

describe('renameProjectAndSyncLoadedPlan', () => {
  test('does not apply a completed rename to a different project opened while the write was pending', async () => {
    let currentProjectId: string | null = 'project-a';
    let finishRename: (() => void) | undefined;
    const renameProject = vi.fn(
      (_projectId: string, _title: string) =>
        new Promise<SavedProjectMeta>(resolve => {
          finishRename = () => resolve(renamedMeta);
        })
    );
    const setLearningPlan = vi.fn();

    const pendingRename = renameProjectAndSyncLoadedPlan({
      getCurrentLearningPlan: () => buildTestLearningPlan([], { title: 'Titolo vecchio' }),
      getCurrentProjectId: () => currentProjectId,
      projectId: 'project-a',
      renameProject,
      setLearningPlan,
      title: 'Titolo nuovo',
    });

    currentProjectId = 'project-b';
    finishRename?.();
    await pendingRename;

    expect(setLearningPlan).not.toHaveBeenCalled();
  });

  test('updates the loaded plan when the renamed project is still current', async () => {
    let currentLearningPlan = buildTestLearningPlan([], {
      summary: 'Prima della richiesta',
      title: 'Titolo vecchio',
    });
    let finishRename: (() => void) | undefined;
    const setLearningPlan = vi.fn();

    const pendingRename = renameProjectAndSyncLoadedPlan({
      getCurrentLearningPlan: () => currentLearningPlan,
      getCurrentProjectId: () => 'project-a',
      projectId: 'project-a',
      renameProject: vi.fn(
        () =>
          new Promise<SavedProjectMeta>(resolve => {
            finishRename = () => resolve(renamedMeta);
          })
      ),
      setLearningPlan,
      title: 'Titolo nuovo',
    });
    currentLearningPlan = { ...currentLearningPlan, summary: 'Modificato durante la richiesta' };
    finishRename?.();
    await pendingRename;

    expect(setLearningPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Modificato durante la richiesta',
        title: 'Titolo nuovo',
      })
    );
  });
});

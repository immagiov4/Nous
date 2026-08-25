// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useWorkspaceControllerState } from '../../../hooks/workspace/controller/state.ts';

describe('useWorkspaceControllerState generation ownership', () => {
  test('persists across rerenders and ignores stale exercise updates after lesson ownership changes', () => {
    const { result } = renderHook(() => useWorkspaceControllerState());
    const firstAdapter = result.current.stateAdapter;
    let firstToken: number | null = null;

    act(() => {
      firstToken = firstAdapter.tryBeginGeneration('project-1', 'exercise');
    });

    expect(firstToken).not.toBeNull();
    const acquiredFirstToken = firstToken;
    if (acquiredFirstToken === null) {
      throw new Error('Expected the first generation token');
    }
    expect(result.current.stateAdapter).not.toBe(firstAdapter);
    expect(result.current.stateAdapter.isGenerationActive('project-1')).toBe(true);
    expect(result.current.stateAdapter.isGenerationCurrent('project-1', acquiredFirstToken)).toBe(
      true
    );
    expect(result.current.stateAdapter.isLessonGenerationActive('project-1')).toBe(false);
    expect(result.current.stateAdapter.tryBeginGeneration('project-1', 'lesson')).toBeNull();

    act(() => {
      firstAdapter.finishGeneration('project-1', acquiredFirstToken);
    });

    let secondToken: number | null = null;
    act(() => {
      secondToken = result.current.stateAdapter.tryBeginGeneration('project-1', 'lesson');
    });
    expect(secondToken).not.toBeNull();
    const acquiredSecondToken = secondToken;
    if (acquiredSecondToken === null) {
      throw new Error('Expected the second generation token');
    }

    act(() => {
      result.current.stateAdapter.setGeneratingSectionId(
        'project-1',
        acquiredSecondToken,
        'lesson-current'
      );
      firstAdapter.setGeneratingSectionId('project-1', acquiredFirstToken, 'exercise-stale');
      firstAdapter.finishGeneration('project-1', acquiredFirstToken);
    });

    expect(result.current.stateAdapter.isLessonGenerationActive('project-1')).toBe(true);
    expect(result.current.stateAdapter.isGenerationCurrent('project-1', acquiredFirstToken)).toBe(
      false
    );
    expect(result.current.stateAdapter.isGenerationCurrent('project-1', acquiredSecondToken)).toBe(
      true
    );
    expect(result.current.stateAdapter.getGeneratingSectionId('project-1')).toBe('lesson-current');

    act(() => {
      result.current.stateAdapter.finishGeneration('project-1', acquiredSecondToken);
    });
    expect(result.current.stateAdapter.isLessonGenerationActive('project-1')).toBe(false);
  });
});

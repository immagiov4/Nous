// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useWorkspaceControllerState } from '../../../hooks/workspace/controller/state.ts';

describe('useWorkspaceControllerState generation ownership', () => {
  test('keeps open-section request ownership across adapter recreation', () => {
    const { result, rerender } = renderHook(() => useWorkspaceControllerState());
    const firstAdapter = result.current.stateAdapter;
    const firstRequestId = firstAdapter.beginOpenSectionRequest();

    rerender();
    const currentAdapter = result.current.stateAdapter;
    const currentRequestId = currentAdapter.beginOpenSectionRequest();

    expect(currentAdapter).not.toBe(firstAdapter);
    expect(firstAdapter.isOpenSectionRequestCurrent(firstRequestId)).toBe(false);
    expect(currentAdapter.isOpenSectionRequestCurrent(currentRequestId)).toBe(true);
  });

  test('keeps missing-source state independent for each project', () => {
    const { result } = renderHook(() => useWorkspaceControllerState());

    act(() => {
      result.current.stateAdapter.setProjectMissingSource('project-a', true);
      result.current.stateAdapter.setProjectMissingSource('project-b', true);
      result.current.stateAdapter.setProjectMissingSource('project-b', false);
    });

    expect(result.current.stateAdapter.hasMissingSource('project-a')).toBe(true);
    expect(result.current.stateAdapter.hasMissingSource('project-b')).toBe(false);
  });

  test('preserves project missing-source state when resetting the current view', () => {
    const { result } = renderHook(() => useWorkspaceControllerState());

    act(() => {
      result.current.stateAdapter.setProjectMissingSource('project-a', true);
      result.current.stateAdapter.resetSessionState();
    });

    expect(result.current.stateAdapter.hasMissingSource('project-a')).toBe(true);
  });

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

  test('reattaches only the matching active lesson generation', () => {
    const { result } = renderHook(() => useWorkspaceControllerState());
    const onReattach = vi.fn(() => true);

    let exerciseToken: number | null = null;
    act(() => {
      exerciseToken = result.current.stateAdapter.tryBeginGeneration('project-1', 'exercise');
    });
    expect(exerciseToken).not.toBeNull();
    const acquiredExerciseToken = exerciseToken;
    if (acquiredExerciseToken === null) throw new Error('Expected the exercise generation token');

    act(() => {
      result.current.stateAdapter.setGeneratingSectionId(
        'project-1',
        acquiredExerciseToken,
        'lesson-1'
      );
      result.current.stateAdapter.setLessonGenerationReattachHandler(
        'project-1',
        acquiredExerciseToken,
        onReattach
      );
    });
    expect(result.current.stateAdapter.reattachLessonGeneration('project-1', 'lesson-1')).toBe(
      false
    );
    expect(onReattach).not.toHaveBeenCalled();

    act(() => {
      result.current.stateAdapter.finishGeneration('project-1', acquiredExerciseToken);
    });
    let lessonToken: number | null = null;
    act(() => {
      lessonToken = result.current.stateAdapter.tryBeginGeneration('project-1', 'lesson');
    });
    expect(lessonToken).not.toBeNull();
    const acquiredLessonToken = lessonToken;
    if (acquiredLessonToken === null) throw new Error('Expected the lesson generation token');

    expect(
      result.current.stateAdapter.isGenerationCurrent('project-1', acquiredExerciseToken)
    ).toBe(false);
    expect(result.current.stateAdapter.isGenerationCurrent('project-1', acquiredLessonToken)).toBe(
      true
    );
    expect(result.current.stateAdapter.reattachLessonGeneration('project-1', 'lesson-1')).toBe(
      false
    );

    act(() => {
      result.current.stateAdapter.setGeneratingSectionId(
        'project-1',
        acquiredLessonToken,
        'lesson-1'
      );
      result.current.stateAdapter.setLessonGenerationReattachHandler(
        'project-1',
        acquiredExerciseToken,
        onReattach
      );
    });
    expect(result.current.stateAdapter.reattachLessonGeneration('project-1', 'lesson-1')).toBe(
      false
    );

    act(() => {
      result.current.stateAdapter.setLessonGenerationReattachHandler(
        'project-1',
        acquiredLessonToken,
        onReattach
      );
    });
    expect(result.current.stateAdapter.reattachLessonGeneration('project-2', 'lesson-1')).toBe(
      false
    );
    expect(result.current.stateAdapter.reattachLessonGeneration('project-1', 'lesson-2')).toBe(
      false
    );
    expect(result.current.stateAdapter.reattachLessonGeneration('project-1', 'lesson-1')).toBe(
      true
    );
    expect(onReattach).toHaveBeenCalledTimes(1);
  });
});

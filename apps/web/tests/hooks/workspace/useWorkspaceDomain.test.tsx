// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useWorkspaceDomain } from '../../../hooks/workspace/useWorkspaceDomain.ts';
import { createProjectSnapshot } from '../../../services/projects/projectSnapshot.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

test('exposes reducer updates synchronously to controller commands', () => {
  const plan = buildTestLearningPlan([buildTestLesson({ id: 'lesson-1' })]);
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-1',
    learningPlan: plan,
  });
  const { result } = renderHook(() => useWorkspaceDomain());
  const domainBeforeRender = result.current;

  act(() => {
    domainBeforeRender.hydrateSnapshot(snapshot);
    expect(domainBeforeRender.learningPlan).toBeNull();
    expect(domainBeforeRender.getDomainState().learningPlan).toBe(plan);

    domainBeforeRender.setActiveSectionId(null);
    expect(domainBeforeRender.getDomainState().activeSectionId).toBeNull();
  });

  expect(result.current.learningPlan).toBe(plan);
  expect(result.current.activeSectionId).toBeNull();
});

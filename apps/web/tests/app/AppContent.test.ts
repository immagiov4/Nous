import { expect, test } from 'vitest';
import { getFeedbackProductSurface } from '../../app/AppContent.tsx';
import { AppState } from '../../types.ts';

test('classifies the active course interview as assessment while rendered in the library', () => {
  expect(
    getFeedbackProductSurface({
      hasContextAnswer: false,
      isAssessmentActive: true,
      screenState: AppState.LIBRARY,
    })
  ).toBe('assessment');
});

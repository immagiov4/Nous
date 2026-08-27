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

test.each([
  AppState.PLANNING,
  AppState.READING,
])('classifies completed interview history from %s by the current screen', screenState => {
  expect(
    getFeedbackProductSurface({
      hasContextAnswer: false,
      isAssessmentActive: true,
      screenState,
    })
  ).toBe(screenState === AppState.PLANNING ? 'planning' : 'reader');
});

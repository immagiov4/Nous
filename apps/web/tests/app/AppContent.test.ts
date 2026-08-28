import { expect, test } from 'vitest';
import { getFeedbackProductReferences, getFeedbackProductSurface } from '../../app/AppContent.tsx';
import { AppState } from '../../types.ts';

test('classifies the active course interview as assessment while rendered in the library', () => {
  expect(
    getFeedbackProductSurface({
      hasContextAnswer: false,
      isAssessmentActive: true,
      pathname: '/',
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
      pathname: '/',
      screenState,
    })
  ).toBe(screenState === AppState.PLANNING ? 'planning' : 'reader');
});

test.each([
  ['/newhome', 'home'],
  ['/newhome/course', 'home'],
  ['/newhome/library', 'library'],
  ['/newhome/library/favorites', 'library'],
] as const)('classifies %s with the New Home route contract', (pathname, surface) => {
  expect(
    getFeedbackProductSurface({
      hasContextAnswer: false,
      isAssessmentActive: false,
      pathname,
      screenState: AppState.LIBRARY,
    })
  ).toBe(surface);
});

test('uses the pending project and drops the prior section while a different course opens', () => {
  expect(
    getFeedbackProductReferences({
      activeSectionId: 'old-section',
      currentProjectId: 'old-project',
      openingProjectId: 'opening-project',
      savedProjects: [
        { id: 'old-project', revision: 2 },
        { id: 'opening-project', revision: 7 },
      ],
    })
  ).toEqual({ project: { id: 'opening-project', revision: 7 } });
});

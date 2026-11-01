import { describe, expect, test } from 'vitest';
import { deriveCourseSetupPhase } from '../../../components/library/courseSetupPhase';

describe('setup phases from existing interview state', () => {
  const interview = {
    assessmentComplete: false,
    hasMessages: true,
    isLoading: false,
    sourceCount: 2,
    hasPreferences: false,
  };
  test('prepares sources only before the first interview message', () => {
    expect(deriveCourseSetupPhase({ ...interview, hasMessages: false, isLoading: true })).toBe(
      'sources'
    );
    expect(deriveCourseSetupPhase({ ...interview, isLoading: true })).toBe('goal');
    expect(
      deriveCourseSetupPhase({ ...interview, hasMessages: false, isLoading: true, sourceCount: 0 })
    ).toBe('goal');
    expect(deriveCourseSetupPhase({ ...interview, hasMessages: false })).toBeNull();
  });
  test('uses proposal and diagnostic state rather than question count or text', () => {
    expect(deriveCourseSetupPhase(interview)).toBe('goal');
    expect(
      deriveCourseSetupPhase({ ...interview, assessmentComplete: true, hasPreferences: true })
    ).toBe('preferences');
    expect(deriveCourseSetupPhase({ ...interview, assessmentComplete: true })).toBe('plan');
    for (const diagnosticKind of ['self-assessment', 'round'] as const) {
      expect(
        deriveCourseSetupPhase({
          ...interview,
          assessmentComplete: true,
          hasPreferences: true,
          diagnosticKind,
        })
      ).toBe('knowledge');
    }
    expect(deriveCourseSetupPhase({ ...interview, diagnosticKind: 'complete' })).toBe('plan');
  });
});

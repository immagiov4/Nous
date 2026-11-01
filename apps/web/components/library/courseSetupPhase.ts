import type { DiagnosticStage } from './diagnostic/diagnosticFlow.ts';

export const COURSE_SETUP_PHASES = ['sources', 'goal', 'preferences', 'knowledge', 'plan'] as const;
export type CourseSetupPhase = (typeof COURSE_SETUP_PHASES)[number];

/** Project existing interview boundaries, never the wording or number of questions. */
export function deriveCourseSetupPhase({
  assessmentComplete,
  diagnosticKind,
  hasMessages,
  hasPreferences,
  isLoading,
  sourceCount,
}: {
  assessmentComplete: boolean;
  diagnosticKind?: DiagnosticStage['kind'];
  hasMessages: boolean;
  hasPreferences: boolean;
  isLoading: boolean;
  sourceCount: number;
}): CourseSetupPhase | null {
  if (diagnosticKind) return diagnosticKind === 'complete' ? 'plan' : 'knowledge';
  if (assessmentComplete) return hasPreferences ? 'preferences' : 'plan';
  if (hasMessages) return 'goal';
  if (isLoading) return sourceCount > 0 ? 'sources' : 'goal';
  return null;
}

/** Only expose optional steps supported by this interview's proposal or diagnostic. */
export function getCourseSetupPhases({
  sourceCount,
  hasPreferences,
  hasDiagnostic,
}: {
  sourceCount: number;
  hasPreferences: boolean;
  hasDiagnostic: boolean;
}): readonly CourseSetupPhase[] {
  return COURSE_SETUP_PHASES.filter(phase => {
    if (phase === 'sources') return sourceCount > 0;
    if (phase === 'preferences') return hasPreferences;
    if (phase === 'knowledge') return hasPreferences || hasDiagnostic;
    return true;
  });
}

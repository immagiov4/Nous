import { groupSectionsIntoModules } from '../../services/learning/groupSectionsIntoModules.ts';
import type { LearningPlan, LearningSection, LessonNode, SavedProjectMeta } from '../../types.ts';

type TestLesson = LessonNode & { moduleTitle?: string };

export const buildTestLesson = (overrides: Partial<TestLesson> = {}): TestLesson => ({
  kind: 'lesson',
  id: 'lesson-1',
  title: 'Lezione 1',
  description: 'Intro',
  isCompleted: false,
  type: 'core',
  ...overrides,
});

export const buildTestLearningPlan = (
  sections: LearningSection[] = [buildTestLesson()],
  overrides: Partial<Omit<LearningPlan, 'modules'>> = {}
): LearningPlan => ({
  title: 'Percorso',
  summary: '',
  modules: groupSectionsIntoModules(sections),
  applicationExercisePlanningStatus: 'not-run',
  ...overrides,
});

export const buildTestProjectMeta = (
  overrides: Partial<SavedProjectMeta> = {}
): SavedProjectMeta => ({
  id: 'project-1',
  title: 'Progetto',
  sourceKind: 'document',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  lessonCount: 1,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
  ...overrides,
});

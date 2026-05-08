import {
  AppState,
  type LearningPlan,
  type LearningSection,
  type LessonNode,
  type ProjectSnapshot,
} from '../../../types.ts';
import { migrateSectionAnnotations } from '../../../utils/learning/sectionAnnotations.ts';
import { flattenLessons, findPathNodeById } from '../../../utils/learning/pathNodes.ts';
import { normalizeMarkdownForRendering } from '../../../utils/markdown/render.ts';
import { restoreLegacyPdfImagePlaceholders } from '../../../utils/pdf/imagePlaceholders.ts';
import { pushNousDebugTrace } from '../../core/debugTrace.ts';
import { groupSectionsIntoModules } from '../../learning/groupSectionsIntoModules.ts';

const HYDRATION_TRACE_PREVIEW_CHARS = 1600;

const summarizeHydratedContent = (content: string) => ({
  hasCodeFence: /(^|\n)```/.test(content),
  length: content.length,
  preview: content.slice(0, HYDRATION_TRACE_PREVIEW_CHARS),
});

const migrateLegacyPlanShape = (raw: unknown): LearningPlan | null => {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw as Record<string, unknown>;
  if (Array.isArray(plan.modules)) {
    return {
      title: typeof plan.title === 'string' ? plan.title : '',
      summary: typeof plan.summary === 'string' ? plan.summary : '',
      modules: plan.modules as LearningPlan['modules'],
      applicationExercisePlanningStatus:
        (plan.applicationExercisePlanningStatus as LearningPlan['applicationExercisePlanningStatus']) ??
        'not-run',
      applicationExercisePlanningNotes: plan.applicationExercisePlanningNotes as string | undefined,
      applicationExercisePlanningError:
        plan.applicationExercisePlanningError as LearningPlan['applicationExercisePlanningError'],
      backgroundMusicUrl: plan.backgroundMusicUrl as string | undefined,
      generationNotes: plan.generationNotes as string | undefined,
    };
  }
  if (Array.isArray(plan.sections)) {
    const sections = plan.sections as LearningSection[];
    return {
      title: typeof plan.title === 'string' ? plan.title : '',
      summary: typeof plan.summary === 'string' ? plan.summary : '',
      modules: groupSectionsIntoModules(sections),
      applicationExercisePlanningStatus: 'not-run',
      backgroundMusicUrl: plan.backgroundMusicUrl as string | undefined,
      generationNotes: plan.generationNotes as string | undefined,
    };
  }
  return null;
};

const normalizeLessonContent = (lesson: LessonNode): LessonNode => {
  if (!lesson.content) {
    return lesson;
  }
  const normalizedContent = normalizeMarkdownForRendering(
    restoreLegacyPdfImagePlaceholders(lesson.content)
  );
  const migrated = migrateSectionAnnotations({
    annotations: lesson.annotations,
    content: normalizedContent,
  });
  if (!migrated.didChange && normalizedContent === lesson.content) {
    return lesson;
  }
  return { ...lesson, content: migrated.content, annotations: migrated.annotations };
};

const normalizeLearningPlanContent = (plan: LearningPlan | null): LearningPlan | null => {
  if (!plan) return null;
  let didChange = false;
  const modules = plan.modules.map(module => {
    let moduleChanged = false;
    const children = module.children.map(child => {
      if (child.kind !== 'lesson') return child;
      const next = normalizeLessonContent(child);
      if (next !== child) moduleChanged = true;
      return next;
    });
    if (!moduleChanged) return module;
    didChange = true;
    return { ...module, children };
  });
  return didChange ? { ...plan, modules } : plan;
};

export const resolvePlanLesson = (
  learningPlan: LearningPlan | null,
  activeSectionId?: string | null
): LessonNode | null => {
  if (!learningPlan) return null;
  if (activeSectionId) {
    const explicit = findPathNodeById(learningPlan.modules, activeSectionId);
    if (explicit?.kind === 'lesson') return explicit;
  }
  const lessons = flattenLessons(learningPlan.modules);
  return lessons.find(l => !l.isCompleted) ?? lessons[0] ?? null;
};

export const resolveScreenStateForSnapshot = (
  snapshot: Pick<ProjectSnapshot, 'learningPlan' | 'source'>
): AppState => {
  if (snapshot.learningPlan) return AppState.READING;
  if (snapshot.source) return AppState.ASSESSMENT;
  return AppState.LIBRARY;
};

export const prepareSnapshotForHydration = (snapshot: ProjectSnapshot): ProjectSnapshot => {
  const migratedPlan = migrateLegacyPlanShape(snapshot.learningPlan as unknown);
  const normalizedPlan = normalizeLearningPlanContent(migratedPlan);

  const legacy = snapshot as unknown as Record<string, unknown>;
  if (legacy.laboratory) {
    pushNousDebugTrace('snapshot-hydration:dropped-legacy-laboratory', {});
  }

  const activeLesson = resolvePlanLesson(normalizedPlan, snapshot.activeSectionId);
  if (activeLesson?.content) {
    pushNousDebugTrace('snapshot-hydration:active-section', {
      sectionId: activeLesson.id,
      sectionTitle: activeLesson.title,
      ...summarizeHydratedContent(activeLesson.content),
    });
  }

  const { laboratory: _laboratory, activeLaboratoryExerciseId: _activeLab, ...rest } = legacy;
  void _laboratory;
  void _activeLab;

  return {
    ...(rest as unknown as ProjectSnapshot),
    learningPlan: normalizedPlan,
    activeSectionId: activeLesson?.id ?? null,
  };
};

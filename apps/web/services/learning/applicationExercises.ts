import type {
  ApplicationExerciseNode,
  ExerciseAttachment,
  LearningPlan,
  ResearchSourceReference,
} from '../../types.ts';
import { timestampIso } from '../../utils/time.ts';

export interface ApplicationExercisePlacement {
  assessedObjective: string;
  description: string;
  moduleId: string;
  title: string;
}

interface ApplyApplicationExercisePlacementsResult {
  plan: LearningPlan;
  placedCount: number;
}

const APPLICATION_EXERCISE_ID_SUFFIX = 'exercise';
const MAX_ASSESSED_OBJECTIVE_CHARS = 280;

const normalizeRequiredText = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Exercise placement missing ${fieldName}.`);
  }
  return normalized;
};

const getModulesWithLessons = (plan: LearningPlan) =>
  plan.modules.filter(module => module.children.some(child => child.kind === 'lesson'));

const hasAnyApplicationExercises = (plan: LearningPlan): boolean =>
  plan.modules.some(module => module.children.some(child => child.kind === 'exercise'));

export const planNeedsApplicationExerciseRepair = (plan: LearningPlan | null): boolean => {
  if (!plan) {
    return false;
  }

  if (hasAnyApplicationExercises(plan)) {
    return false;
  }

  if (plan.applicationExercisePlanningStatus === 'failed') {
    return true;
  }

  return getModulesWithLessons(plan).length > 0;
};

export const getApplicationExerciseRepairLabel = (_plan: LearningPlan | null): string => {
  return 'Pianifica esercizi';
};

export const removeApplicationExercisesFromPlan = (plan: LearningPlan): LearningPlan => ({
  ...plan,
  modules: plan.modules.map(module => ({
    ...module,
    children: module.children.filter(child => child.kind !== 'exercise'),
  })),
});

export const applyApplicationExercisePlacements = (
  plan: LearningPlan,
  placements: ApplicationExercisePlacement[],
  rationale: string
): ApplyApplicationExercisePlacementsResult => {
  const cleanPlan = removeApplicationExercisesFromPlan(plan);
  const modulesWithLessons = getModulesWithLessons(cleanPlan);
  const moduleIds = new Set(modulesWithLessons.map(module => module.id));
  const seenModuleIds = new Set<string>();
  const normalizedPlacements = placements.map((placement): ApplicationExercisePlacement => {
    const moduleId = normalizeRequiredText(placement.moduleId, 'moduleId');
    if (!moduleIds.has(moduleId)) {
      throw new Error(`Exercise placement references unknown moduleId "${moduleId}".`);
    }
    if (seenModuleIds.has(moduleId)) {
      throw new Error(`Exercise placement duplicated moduleId "${moduleId}".`);
    }
    seenModuleIds.add(moduleId);

    const assessedObjective = normalizeRequiredText(
      placement.assessedObjective,
      'assessedObjective'
    );
    if (assessedObjective.length > MAX_ASSESSED_OBJECTIVE_CHARS) {
      throw new Error('Exercise placement assessedObjective is too long.');
    }

    return {
      moduleId,
      title: normalizeRequiredText(placement.title, 'title'),
      description: normalizeRequiredText(placement.description, 'description'),
      assessedObjective,
    };
  });

  const placementByModuleId = new Map(
    normalizedPlacements.map(placement => [placement.moduleId, placement])
  );
  const now = timestampIso();
  const modules = cleanPlan.modules.map(module => {
    const placement = placementByModuleId.get(module.id);
    if (!placement) {
      return module;
    }

    const exercise: ApplicationExerciseNode = {
      kind: 'exercise',
      id: `${module.id}-${APPLICATION_EXERCISE_ID_SUFFIX}`,
      title: placement.title,
      description: placement.description,
      assessedObjective: placement.assessedObjective,
      attachments: [],
      currentFeedback: null,
      isCompleted: false,
      feedbackStale: false,
      updatedAt: now,
    };

    return {
      ...module,
      children: [...module.children, exercise],
    };
  });

  return {
    placedCount: normalizedPlacements.length,
    plan: {
      ...cleanPlan,
      modules,
      applicationExercisePlanningStatus: 'completed',
      applicationExercisePlanningNotes: rationale.trim() || 'Pianificazione esercizi completata.',
      applicationExercisePlanningError: undefined,
    },
  };
};

export const markApplicationExercisePlanningFailed = (
  plan: LearningPlan,
  error: Error,
  attempts: number
): LearningPlan => ({
  ...removeApplicationExercisesFromPlan(plan),
  applicationExercisePlanningStatus: 'failed',
  applicationExercisePlanningError: {
    message: error.message,
    attempts,
    lastAttemptAt: timestampIso(),
  },
});

export const updateApplicationExerciseInPlan = (
  plan: LearningPlan,
  exerciseId: string,
  updater: (exercise: ApplicationExerciseNode) => ApplicationExerciseNode
): LearningPlan => ({
  ...plan,
  modules: plan.modules.map(module => ({
    ...module,
    children: module.children.map(child =>
      child.kind === 'exercise' && child.id === exerciseId ? updater(child) : child
    ),
  })),
});

export const withUpdatedExerciseDeliverable = (
  exercise: ApplicationExerciseNode,
  updates: Partial<Pick<ApplicationExerciseNode, 'attachments' | 'internalText'>>
): ApplicationExerciseNode => ({
  ...exercise,
  ...updates,
  feedbackStale: exercise.currentFeedback ? true : exercise.feedbackStale,
  updatedAt: timestampIso(),
});

export const withGeneratedExerciseBrief = (
  exercise: ApplicationExerciseNode,
  args: {
    brief: string;
    groundingSources?: ResearchSourceReference[];
  }
): ApplicationExerciseNode => ({
  ...exercise,
  brief: args.brief,
  groundingSources: args.groundingSources,
  generatedAt: timestampIso(),
  updatedAt: timestampIso(),
});

export const addExerciseAttachments = (
  exercise: ApplicationExerciseNode,
  attachments: ExerciseAttachment[]
): ApplicationExerciseNode =>
  withUpdatedExerciseDeliverable(exercise, {
    attachments: [...exercise.attachments, ...attachments],
  });

import type { LaboratoryExercise, LaboratoryState, LaboratoryStateStatus } from '../../types.ts';

export const CURRENT_LABORATORY_SCHEMA_VERSION = 2;

const getNow = () => new Date().toISOString();

const hasNonEmptyText = (value: string): boolean => value.trim().length > 0;

const hasRequirements = (requirements: string[]): boolean =>
  requirements.some(requirement => requirement.trim().length > 0);

const isCompatibleLaboratoryExercise = (exercise: LaboratoryExercise): boolean =>
  hasNonEmptyText(exercise.instructionsMarkdown) &&
  hasNonEmptyText(exercise.approachMarkdown) &&
  hasNonEmptyText(exercise.exampleMarkdown) &&
  hasRequirements(exercise.requirements);

export const isCompatibleLaboratoryState = (
  laboratory: LaboratoryState | null
): laboratory is LaboratoryState => {
  if (!laboratory || laboratory.schemaVersion !== CURRENT_LABORATORY_SCHEMA_VERSION) {
    return false;
  }

  const allExercisesCompatible = laboratory.exercises.every(isCompatibleLaboratoryExercise);

  if (laboratory.status === 'ready') {
    return laboratory.exercises.length > 0 && allExercisesCompatible;
  }

  return laboratory.exercises.length === 0 || allExercisesCompatible;
};

export const normalizeLaboratoryStateForHydration = (
  laboratory: LaboratoryState | null
): LaboratoryState | null => (isCompatibleLaboratoryState(laboratory) ? laboratory : null);

export const resolveActiveLaboratoryExerciseId = (
  laboratory: LaboratoryState | null,
  activeExerciseId?: string | null
): string | null => {
  if (!laboratory?.exercises.length) {
    return null;
  }

  if (activeExerciseId && laboratory.exercises.some(exercise => exercise.id === activeExerciseId)) {
    return activeExerciseId;
  }

  return laboratory.exercises[0]?.id || null;
};

export const selectActiveLaboratoryExercise = (
  laboratory: LaboratoryState | null,
  activeExerciseId?: string | null
): LaboratoryExercise | null => {
  const resolvedExerciseId = resolveActiveLaboratoryExerciseId(laboratory, activeExerciseId);
  if (!laboratory || !resolvedExerciseId) {
    return null;
  }

  return laboratory.exercises.find(exercise => exercise.id === resolvedExerciseId) || null;
};

export const updateLaboratoryExercise = (
  laboratory: LaboratoryState,
  exerciseId: string,
  updater: (exercise: LaboratoryExercise) => LaboratoryExercise
): LaboratoryState => {
  const now = getNow();

  return {
    ...laboratory,
    exercises: laboratory.exercises.map(exercise =>
      exercise.id === exerciseId
        ? {
            ...updater(exercise),
            updatedAt: now,
          }
        : exercise
    ),
    updatedAt: now,
  };
};

export const replaceLaboratoryExercise = (
  laboratory: LaboratoryState,
  nextExercise: LaboratoryExercise
): LaboratoryState => {
  const now = getNow();

  return {
    ...laboratory,
    exercises: laboratory.exercises.map(exercise =>
      exercise.id === nextExercise.id
        ? {
            ...nextExercise,
            updatedAt: now,
          }
        : exercise
    ),
    updatedAt: now,
  };
};

export const withLaboratoryStatus = (
  laboratory: LaboratoryState | null,
  status: LaboratoryStateStatus,
  options: {
    errorMessage?: string;
    summary?: string;
    title?: string;
  } = {}
): LaboratoryState => {
  const now = getNow();

  return {
    errorMessage: options.errorMessage,
    exercises: laboratory?.exercises || [],
    generatedAt:
      status === 'ready' ? laboratory?.generatedAt || now : laboratory?.generatedAt || undefined,
    schemaVersion: laboratory?.schemaVersion ?? CURRENT_LABORATORY_SCHEMA_VERSION,
    status,
    summary: options.summary ?? laboratory?.summary ?? '',
    title: options.title ?? laboratory?.title ?? 'Laboratorio',
    updatedAt: now,
  };
};

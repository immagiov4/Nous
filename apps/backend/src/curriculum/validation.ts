import type * as z from 'zod';
import {
  type ConceptDefinition,
  type CourseCurriculum,
  CourseCurriculumSchema,
  type CurriculumArtifactRef,
  type CurriculumRef,
  type CurriculumSupportRef,
} from '../../../../packages/shared-types/curriculum';
import { checkUnique, report, sameArtifact, sameCurriculum, sameProject } from './references';

export interface CurriculumValidationContext {
  ref: CurriculumRef;
  planningInputRef: CurriculumArtifactRef;
  /** Canonical definitions resolved for this account, not inferred from course labels. */
  concepts: readonly ConceptDefinition[];
  /** Authoritative lesson order from the same candidate plan. */
  lessonIds: readonly string[];
  /** Retained mapping references resolved for this curriculum by their owning adapters. */
  supportRefs: readonly CurriculumSupportRef[];
}

interface CurriculumReviewRequirement {
  requirementId: string;
  lessonId: string;
  kind: 'same-lesson-order' | 'unresolved-prerequisite';
}

function checkIdentity(
  curriculum: CourseCurriculum,
  resolved: CurriculumValidationContext,
  context: z.RefinementCtx
): void {
  if (!sameCurriculum(curriculum.ref, resolved.ref))
    report(context, ['ref'], 'Unexpected curriculum identity');
  if (
    !sameArtifact(curriculum.planningInputRef, resolved.planningInputRef) ||
    !sameProject(curriculum.planningInputRef, curriculum.ref)
  ) {
    report(
      context,
      ['planningInputRef'],
      'Planning input does not resolve to this course and approved artifact'
    );
  }
  checkUnique(context, curriculum.conceptIds, ['conceptIds']);
  checkUnique(
    context,
    curriculum.objectives.map(objective => objective.objectiveId),
    ['objectives']
  );
  checkUnique(
    context,
    curriculum.lessonConceptUses.map(use => use.useId),
    ['lessonConceptUses']
  );
  checkUnique(
    context,
    curriculum.prerequisites.map(requirement => requirement.requirementId),
    ['prerequisites']
  );
  const catalog = new Map(resolved.concepts.map(concept => [concept.conceptId, concept]));
  curriculum.conceptIds.forEach((conceptId, index) => {
    const concept = catalog.get(conceptId);
    if (
      !concept ||
      concept.userId !== curriculum.ref.userId ||
      concept.origin.userId !== curriculum.ref.userId
    ) {
      report(context, ['conceptIds', index], 'Concept does not resolve within the account catalog');
    }
  });
}

function checkRelations(
  curriculum: CourseCurriculum,
  resolved: CurriculumValidationContext,
  context: z.RefinementCtx
): void {
  const lessonIds = new Set(resolved.lessonIds);
  const conceptIds = new Set(curriculum.conceptIds);
  const objectives = new Map(
    curriculum.objectives.map(objective => [objective.objectiveId, objective])
  );
  const checkLesson = (lessonId: string, path: (string | number)[]) => {
    if (!lessonIds.has(lessonId)) report(context, path, 'Lesson is absent from the reference plan');
  };
  const checkConcept = (conceptId: string, path: (string | number)[]) => {
    if (!conceptIds.has(conceptId)) report(context, path, 'Concept is absent from this curriculum');
  };
  curriculum.objectives.forEach((objective, index) => {
    if (objective.owner.kind === 'lesson')
      checkLesson(objective.owner.lessonId, ['objectives', index, 'owner']);
  });
  curriculum.objectiveConceptLinks.forEach((link, index) => {
    if (!objectives.has(link.objectiveId))
      report(context, ['objectiveConceptLinks', index, 'objectiveId'], 'Unresolved objective');
    checkConcept(link.conceptId, ['objectiveConceptLinks', index, 'conceptId']);
  });
  curriculum.lessonConceptUses.forEach((use, index) => {
    checkLesson(use.lessonId, ['lessonConceptUses', index, 'lessonId']);
    checkConcept(use.conceptId, ['lessonConceptUses', index, 'conceptId']);
  });
  for (const field of ['lessonObjectiveLinks', 'activityTargets'] as const) {
    curriculum[field].forEach((link, index) => {
      checkLesson(link.lessonId, [field, index, 'lessonId']);
      const objective = objectives.get(link.objectiveId);
      if (!objective) report(context, [field, index, 'objectiveId'], 'Unresolved objective');
      else if (objective.owner.kind === 'lesson' && objective.owner.lessonId !== link.lessonId) {
        report(
          context,
          [field, index, 'objectiveId'],
          'Lesson objective belongs to another lesson'
        );
      }
    });
  }
  curriculum.prerequisites.forEach((requirement, index) => {
    if (!objectives.has(requirement.forObjectiveId))
      report(context, ['prerequisites', index, 'forObjectiveId'], 'Unresolved objective');
    checkConcept(requirement.conceptId, ['prerequisites', index, 'conceptId']);
  });
}

function checkPreparations(
  curriculum: CourseCurriculum,
  resolved: CurriculumValidationContext,
  context: z.RefinementCtx
): void {
  const requirements = new Map(
    curriculum.prerequisites.map(requirement => [requirement.requirementId, requirement])
  );
  const uses = new Map(curriculum.lessonConceptUses.map(use => [use.useId, use]));
  const lessonOrder = new Map(resolved.lessonIds.map((lessonId, index) => [lessonId, index]));
  const contributes = (lessonId: string, objectiveId: string) =>
    curriculum.lessonObjectiveLinks.some(
      link => link.lessonId === lessonId && link.objectiveId === objectiveId
    );
  curriculum.prerequisitePreparations.forEach((preparation, index) => {
    const path = ['prerequisitePreparations', index];
    const requirement = requirements.get(preparation.requirementId);
    if (!requirement) {
      report(context, path, 'Unresolved prerequisite requirement');
      return;
    }
    if (!contributes(preparation.dependentLessonId, requirement.forObjectiveId)) {
      report(
        context,
        [...path, 'dependentLessonId'],
        'Dependent lesson does not contribute to the required objective'
      );
    }
    if (preparation.kind === 'entry-assumption') {
      preparation.supportRefs.forEach((support, supportIndex) => {
        if (
          !resolved.supportRefs.some(
            reference =>
              reference.kind === support.kind && reference.mappingId === support.mappingId
          )
        ) {
          report(context, [...path, 'supportRefs', supportIndex], 'Unresolved curriculum support');
        }
      });
    }
    if (preparation.kind !== 'planned-in-course') return;
    const providerOrder = lessonOrder.get(preparation.providerLessonId);
    const dependentOrder = lessonOrder.get(preparation.dependentLessonId);
    if (
      providerOrder === undefined ||
      dependentOrder === undefined ||
      providerOrder > dependentOrder
    ) {
      report(
        context,
        [...path, 'providerLessonId'],
        'Preparation must precede its use in the reference plan'
      );
    }
    preparation.useIds.forEach((useId, useIndex) => {
      const use = uses.get(useId);
      if (
        !use ||
        use.lessonId !== preparation.providerLessonId ||
        use.conceptId !== requirement.conceptId
      ) {
        report(
          context,
          [...path, 'useIds', useIndex],
          'Preparation use does not resolve to the provider lesson and required concept'
        );
      }
    });
    preparation.objectiveIds.forEach((objectiveId, objectiveIndex) => {
      if (!contributes(preparation.providerLessonId, objectiveId)) {
        report(
          context,
          [...path, 'objectiveIds', objectiveIndex],
          'Preparation objective is not linked to the provider lesson'
        );
      }
    });
  });
}

function checkOrigins(curriculum: CourseCurriculum, context: z.RefinementCtx): void {
  for (const field of [
    'objectives',
    'objectiveConceptLinks',
    'lessonConceptUses',
    'prerequisites',
    'prerequisitePreparations',
    'activityTargets',
  ] as const) {
    curriculum[field].forEach((entry, index) => {
      if (entry.origin.userId !== curriculum.ref.userId)
        report(context, [field, index, 'origin'], 'Origin belongs to a different account');
    });
  }
}

/** Pure structural check. A successful result does not certify learning or pedagogical adequacy. */
export function validateCurriculum(candidate: unknown, resolved: CurriculumValidationContext) {
  const result = CourseCurriculumSchema.superRefine((curriculum, context) => {
    checkIdentity(curriculum, resolved, context);
    checkRelations(curriculum, resolved, context);
    checkPreparations(curriculum, resolved, context);
    checkOrigins(curriculum, context);
  }).safeParse(candidate);
  if (!result.success) return result;
  const reviewRequired: CurriculumReviewRequirement[] = [];
  for (const preparation of result.data.prerequisitePreparations) {
    if (preparation.kind === 'unresolved')
      reviewRequired.push({
        requirementId: preparation.requirementId,
        lessonId: preparation.dependentLessonId,
        kind: 'unresolved-prerequisite',
      });
    if (
      preparation.kind === 'planned-in-course' &&
      preparation.providerLessonId === preparation.dependentLessonId
    ) {
      reviewRequired.push({
        requirementId: preparation.requirementId,
        lessonId: preparation.dependentLessonId,
        kind: 'same-lesson-order',
      });
    }
  }
  return { success: true as const, data: result.data, reviewRequired };
}

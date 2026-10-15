import * as z from 'zod';
import type { CoursePlanVerification } from './courseGenerationWorkflowContract.js';
import { retryCorrective } from './retryPolicy.js';

export const COURSE_PLAN_QUALITY_DIMENSIONS = [
  'coverage',
  'duplication',
  'granularity',
  'moduleCohesion',
  'prerequisites',
  'progression',
  'proportionality',
] as const;

const DimensionSchema = z.enum(COURSE_PLAN_QUALITY_DIMENSIONS);
export const CoursePlanRefinementConditionSchema = z.object({
  dimension: DimensionSchema,
  passCondition: z.string().regex(/\S/),
});
export const CoursePlanConditionAssessmentSchema = z.object({
  dimension: DimensionSchema,
  met: z.boolean(),
  evidence: z.string().regex(/\S/),
});

export const COURSE_PLAN_REFINEMENT_RULE = `For every dimension marked needs-refinement, return one refinementConditions entry with that dimension and a concrete, checkable passCondition describing exactly what must change. Use observable plan content such as named concepts, objectives, prerequisite statements and activity scope. Do not invent duration or distribution targets absent from the supplied context. For an initial review, conditionAssessments is empty. When previous verification conditions are supplied, evaluate those exact conditions on this candidate and return one conditionAssessments entry per condition with met and concrete evidence. The application retains the previous pass conditions; refinementConditions may be empty in this follow-up response. Do not raise the bar or introduce replacement objections for a settled dimension. If all stated conditions are met, pass the plan. Describe prerequisites needed before a lesson separately from concepts that the lesson itself introduces. Keep internal dimension names and review labels out of learner-visible course text.`;

export const COURSE_PLAN_REFINEMENT_INSTRUCTIONS = `Revise the supplied course plan to satisfy the previously stated pass conditions. Preserve dimensions already accepted and keep internal review labels out of learner-visible course text. Return only the course-plan fields required by the supplied output schema. Condition assessments belong to the subsequent verification response.`;

/** Enforce the stated exit criteria, rather than repeatedly restarting structural review. */
export const applyCoursePlanConditions = (
  verification: CoursePlanVerification,
  previous?: CoursePlanVerification
): CoursePlanVerification => {
  const previousConditions = previous?.refinementConditions ?? [];
  const conditions = verification.refinementConditions ?? [];
  const assessments = verification.conditionAssessments ?? [];
  if (previous?.refinementConditions === undefined) {
    const requiredDimensions = COURSE_PLAN_QUALITY_DIMENSIONS.filter(
      dimension => verification[dimension].status === 'needs-refinement'
    );
    const validConditions =
      conditions.length === requiredDimensions.length &&
      new Set(conditions.map(condition => condition.dimension)).size === conditions.length &&
      conditions.every(
        condition =>
          requiredDimensions.includes(condition.dimension) && condition.passCondition.trim()
      );
    if (!validConditions) {
      throw invalidCoursePlanConditions();
    }
    return { ...verification, conditionAssessments: [] };
  }
  const relevantAssessments = assessments.filter(assessment =>
    previousConditions.some(condition => condition.dimension === assessment.dimension)
  );
  const validAssessments =
    relevantAssessments.length === previousConditions.length &&
    new Set(relevantAssessments.map(assessment => assessment.dimension)).size ===
      relevantAssessments.length &&
    relevantAssessments.every(assessment => assessment.evidence.trim());
  if (!validAssessments) throw invalidCoursePlanConditions();

  const dimensions = Object.fromEntries(
    COURSE_PLAN_QUALITY_DIMENSIONS.map(dimension => {
      const assessment = relevantAssessments.find(entry => entry.dimension === dimension);
      return [
        dimension,
        {
          feedback:
            assessment?.evidence ??
            previous?.[dimension].feedback ??
            verification[dimension].feedback,
          status: assessment && !assessment.met ? 'needs-refinement' : 'pass',
        },
      ];
    })
  ) as Pick<CoursePlanVerification, (typeof COURSE_PLAN_QUALITY_DIMENSIONS)[number]>;
  const verdict = relevantAssessments.every(assessment => assessment.met) ? 'pass' : 'refine';
  return {
    ...verification,
    ...dimensions,
    refinementConditions: previousConditions.filter(condition =>
      relevantAssessments.some(
        assessment => assessment.dimension === condition.dimension && !assessment.met
      )
    ),
    conditionAssessments: relevantAssessments,
    summary: relevantAssessments.length
      ? relevantAssessments.map(assessment => assessment.evidence).join('\n')
      : previous.summary,
    verdict,
    fragmentation:
      dimensions.granularity.status === 'pass'
        ? { ...verification.fragmentation, canGroupCoherently: false, moduleIds: [] }
        : verification.fragmentation,
  };
};

const invalidCoursePlanConditions = () =>
  retryCorrective({
    code: 'course_plan_verification_invalid',
    feedback: COURSE_PLAN_REFINEMENT_RULE,
    message: 'The course plan review has no checkable refinement conditions.',
  });

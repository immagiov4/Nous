import type * as z from 'zod';
import type {
  CourseCurriculum,
  CurriculumEntityRef,
} from '../../../../packages/shared-types/curriculum';
import {
  CrossCourseAlignmentSchema,
  DiagnosticCurriculumMappingSchema,
  type DiagnosticMappingSource,
} from '../../../../packages/shared-types/curriculumMapping';
import {
  checkEntity,
  checkUnique,
  entityKey,
  report,
  sameArtifact,
  sameCurriculum,
  sameProject,
} from './references';

/** A projection of complete, authoritatively resolved #112 source chains, not independent ID lists. */
export interface DiagnosticMappingContext {
  curriculum: CourseCurriculum;
  assessmentRef: DiagnosticMappingSource['assessmentRef'];
  sources: readonly DiagnosticMappingSource[];
}

function sameDiagnosticSource(
  left: DiagnosticMappingSource,
  right: DiagnosticMappingSource
): boolean {
  if (
    !sameProject(left.assessmentRef, right.assessmentRef) ||
    left.assessmentRef.diagnosticId !== right.assessmentRef.diagnosticId ||
    left.assessmentRef.revisionId !== right.assessmentRef.revisionId ||
    left.nodeId !== right.nodeId
  )
    return false;
  if (left.kind === 'node' && right.kind === 'node') return true;
  if (left.kind === 'self-report' && right.kind === 'self-report') {
    return (
      left.selfReportId === right.selfReportId &&
      sameArtifact(left.selfReportRef, right.selfReportRef)
    );
  }
  if (left.kind === 'observation' && right.kind === 'observation') {
    return (
      left.taskId === right.taskId &&
      left.attemptId === right.attemptId &&
      left.interpretationId === right.interpretationId &&
      left.claimId === right.claimId &&
      left.criterionId === right.criterionId &&
      sameArtifact(left.evidenceRef, right.evidenceRef)
    );
  }
  return false;
}

function checkTargets(
  context: z.RefinementCtx,
  targets: CurriculumEntityRef[],
  curriculum: CourseCurriculum,
  path: (string | number)[]
): void {
  checkUnique(context, targets.map(entityKey), path);
  targets.forEach((target, index) => {
    checkEntity(context, target, curriculum, [...path, index]);
  });
}

/** Preserves source coordinates and mapping uncertainty; #112 retains claim scope and evidence content. */
export function validateDiagnosticMapping(candidate: unknown, resolved: DiagnosticMappingContext) {
  return DiagnosticCurriculumMappingSchema.superRefine((mapping, context) => {
    if (!sameCurriculum(mapping.curriculum, resolved.curriculum.ref))
      report(context, ['curriculum'], 'Unexpected destination curriculum');
    if (mapping.origin.userId !== resolved.curriculum.ref.userId)
      report(context, ['origin'], 'Origin belongs to another account');
    const assessment = mapping.source.assessmentRef;
    if (
      !sameProject(assessment, resolved.curriculum.ref) ||
      !sameProject(assessment, resolved.assessmentRef) ||
      assessment.diagnosticId !== resolved.assessmentRef.diagnosticId ||
      assessment.revisionId !== resolved.assessmentRef.revisionId
    ) {
      report(context, ['source', 'assessmentRef'], 'Unexpected diagnostic course or revision');
    }
    if (!resolved.sources.some(source => sameDiagnosticSource(mapping.source, source))) {
      report(context, ['source'], 'Diagnostic source chain does not resolve as a complete tuple');
    }
    const source = mapping.source;
    const artifact =
      source.kind === 'observation'
        ? source.evidenceRef
        : source.kind === 'self-report'
          ? source.selfReportRef
          : undefined;
    if (artifact && !sameProject(artifact, assessment))
      report(context, ['source'], 'Diagnostic artifact belongs to another course');
    const outcome = mapping.outcome;
    if (outcome.status === 'matched')
      checkTargets(
        context,
        outcome.targets.map(relation => relation.target),
        resolved.curriculum,
        ['outcome', 'targets']
      );
    if (outcome.status === 'ambiguous') {
      outcome.alternatives.forEach((targets, index) => {
        checkTargets(
          context,
          targets.map(relation => relation.target),
          resolved.curriculum,
          ['outcome', 'alternatives', index]
        );
      });
    }
  }).safeParse(candidate);
}

/** Checks explicit alignments between two resolved curricula of the same account. */
export function validateCrossCourseAlignment(
  candidate: unknown,
  resolved: { source: CourseCurriculum; destination: CourseCurriculum }
) {
  return CrossCourseAlignmentSchema.superRefine((mapping, context) => {
    if (!sameCurriculum(mapping.curriculum, resolved.destination.ref))
      report(context, ['curriculum'], 'Unexpected destination curriculum');
    if (
      resolved.source.ref.userId !== resolved.destination.ref.userId ||
      mapping.origin.userId !== resolved.destination.ref.userId
    ) {
      report(context, ['source'], 'Cross-course alignment must remain within one account');
    }
    if (sameProject(resolved.source.ref, resolved.destination.ref))
      report(context, ['source'], 'Cross-course alignment requires another source course');
    checkEntity(context, mapping.source, resolved.source, ['source']);
    const checkAlignmentTargets = (
      targets: { target: CurriculumEntityRef; relationship: string }[],
      path: (string | number)[]
    ) => {
      checkTargets(
        context,
        targets.map(target => target.target),
        resolved.destination,
        path
      );
      targets.forEach((alignment, index) => {
        if (
          alignment.relationship === 'same-concept' &&
          (mapping.source.kind !== 'concept' ||
            alignment.target.kind !== 'concept' ||
            mapping.source.conceptId !== alignment.target.conceptId)
        ) {
          report(
            context,
            [...path, index, 'relationship'],
            'Same-concept alignment requires the same account concept identity'
          );
        }
      });
    };
    const outcome = mapping.outcome;
    if (outcome.status === 'matched')
      checkAlignmentTargets(outcome.targets, ['outcome', 'targets']);
    if (outcome.status === 'ambiguous') {
      outcome.alternatives.forEach((targets, index) => {
        checkAlignmentTargets(targets, ['outcome', 'alternatives', index]);
      });
    }
  }).safeParse(candidate);
}

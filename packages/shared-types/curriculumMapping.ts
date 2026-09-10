import * as z from 'zod';
import {
  CurriculumArtifactRefSchema,
  CurriculumEntityRefSchema,
  CurriculumRefSchema,
} from './curriculum';

const identifier = z.string().min(1);
const description = z.string().min(1);
const assessmentRef = CurriculumRefSchema.omit({ curriculumId: true }).extend({
  diagnosticId: identifier,
  revisionId: identifier,
});

/** Coordinates only: #112 owns the retained diagnosis and resolves complete source tuples. */
const DiagnosticMappingSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('node'), assessmentRef, nodeId: identifier }),
  z.strictObject({
    kind: z.literal('self-report'),
    assessmentRef,
    nodeId: identifier,
    selfReportId: identifier,
    selfReportRef: CurriculumArtifactRefSchema,
  }),
  z.strictObject({
    kind: z.literal('observation'),
    assessmentRef,
    nodeId: identifier,
    taskId: identifier,
    attemptId: identifier,
    interpretationId: identifier,
    claimId: identifier,
    criterionId: identifier,
    evidenceRef: CurriculumArtifactRefSchema,
  }),
]);
export type DiagnosticMappingSource = z.infer<typeof DiagnosticMappingSourceSchema>;

const mappingMetadata = {
  mappingId: identifier,
  curriculum: CurriculumRefSchema,
  reason: description,
  limitations: description,
  origin: CurriculumArtifactRefSchema,
};

const diagnosticTargets = z
  .array(
    z.strictObject({
      target: CurriculumEntityRefSchema,
      scope: description,
      reason: description,
    })
  )
  .min(1);
export const DiagnosticCurriculumMappingSchema = z.strictObject({
  ...mappingMetadata,
  source: DiagnosticMappingSourceSchema,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('not-reviewed') }),
    z.strictObject({ status: z.literal('unmatched') }),
    z.strictObject({ status: z.literal('matched'), targets: diagnosticTargets }),
    z.strictObject({
      status: z.literal('ambiguous'),
      alternatives: z.array(diagnosticTargets).min(2),
    }),
  ]),
});
export type DiagnosticCurriculumMapping = z.infer<typeof DiagnosticCurriculumMappingSchema>;

const alignmentTargets = z
  .array(
    z.strictObject({
      target: CurriculumEntityRefSchema,
      relationship: z.enum(['same-concept', 'partial-overlap']),
      commonScope: description,
      differences: description,
    })
  )
  .min(1);

/** An alignment references original course entities; it neither reassigns observations nor merges IDs. */
export const CrossCourseAlignmentSchema = z.strictObject({
  ...mappingMetadata,
  source: CurriculumEntityRefSchema,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('not-reviewed') }),
    z.strictObject({ status: z.literal('unmatched') }),
    z.strictObject({ status: z.literal('matched'), targets: alignmentTargets }),
    z.strictObject({
      status: z.literal('ambiguous'),
      alternatives: z.array(alignmentTargets).min(2),
    }),
  ]),
});
export type CrossCourseAlignment = z.infer<typeof CrossCourseAlignmentSchema>;
